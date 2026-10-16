# @zoudedao/baidu

邻至的百度地图 Web 服务客户端。它把 2026-09-26 在张江实测到的百度接口行为（见 `docs/技术设计文档.md` §2、§4）固化成代码：按接口选择鉴权方式、限流与自适应并发、状态码策略与退避、两级缓存、配额账本、地理编码校验、距离降级链，以及不联网的回放模式。

所有坐标的输入输出一律是 **BD-09 `[lng, lat]`**。百度多数接口的参数顺序是 `lat,lng`，由客户端负责转换。

每次调用都走同一条链路，重复请求不会重复消耗配额：

```
缓存（内存 LRU → SQLite） → 合并在途请求（singleflight） → 配额账本 → 调度器（令牌桶 + AIMD + 退避） → 传输层（fetch / 回放）
```

## 配置

| 环境变量            | 说明                                                                           |
| ------------------- | ------------------------------------------------------------------------------ |
| `BAIDU_SERVER_AK`   | 服务端 AK。用于地理编码、逆地理编码、坐标转换、地点检索、轻量步行路线          |
| `BAIDU_SERVER_SK`   | SN 模式的 SK，只在服务端使用，不会下发到浏览器                                 |
| `BAIDU_SERVER_AUTH` | `sn` 或 `ip`。不填时：有 SK 视为 `sn`，没有 SK 视为未配置                      |
| `BAIDU_MATRIX_AK`   | 批量算路专用 AK（IP 白名单，不签名）。不填时批量算路沿用服务端 AK              |
| `BAIDU_TIER`        | `personal`（默认）或 `enterprise`，决定配额与限速                              |
| `BAIDU_CACHE_PATH`  | 缓存与账本共用的 SQLite 文件，默认是当前工作目录下的 `data/cache/baidu.sqlite` |

`loadBaiduConfig()` 读取以上变量，得到每个接口的鉴权方式 `config.auth[service]`（`null` 表示该接口不可用），并把发现的问题放进 `config.issues`（附中文说明）。`.env.example` 里的 `your_server_ak` 这类占位符按未配置处理。`config.live` 为 `true` 表示服务端 AK 可用，可以分析任意地点。

推荐配置（实测可用）：服务端 AK 用 SN 模式，另配一个 IP 白名单模式的 `BAIDU_MATRIX_AK` 专门给批量算路用。评委的 Key 如果是 IP 白名单模式，设置 `BAIDU_SERVER_AUTH=ip` 即可，不需要 SK。

## 用法

```ts
import { createBaiduClient, locate, walkDistances } from '@zoudedao/baidu';

const baidu = createBaiduClient(); // 读取 process.env；缓存与账本默认写入 data/cache/baidu.sqlite

// 定位：地理编码 + 逆地理核对 + 地点检索兜底，返回带置信度与理由的候选点
const where = await locate(baidu, '上海市浦东新区海科路1650号');
if (where.needsConfirmation) {
  // 在地图上列出 where.candidates，请用户确认
}

// 单次冷启动分析先预留配额；预算内的调用可以用到 100%，结束时归还剩余部分
const budget = baidu.ledger.reserve({ routematrix_walking: 740, place: 6, directionlite_walking: 6 });
try {
  const pois = await baidu.placeAround(['药店', '药房', '大药房'], [121.644195, 31.19007], {
    radius: 2000,
    budget,
  });
  const matrix = await baidu.routeMatrixWalking(
    [[121.644195, 31.19007]],
    pois.pois.map((p) => p.naviLocation ?? p.location),
    { budget, partial: true },
  );
  // matrix.cells[起点][终点]：{ status: 'ok' | 'no_route' | 'failed', distanceM, durationS, via }
} finally {
  budget.release();
}

baidu.health(); // 给 /api/health：鉴权方式、当日配额、缓存命中、各接口并发，不含任何 Key
```

主要接口：

| 方法                                              | 百度接口                 | 说明                                                                                         |
| ------------------------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------- |
| `geocode(address, { city })`                      | geocoding/v3             | 保留 `precise`、`confidence`、`comprehension`、`level`                                       |
| `reverseGeocode(lngLat, { pois, radius })`        | reverse_geocoding/v3     | 区县、街道（镇）、所在小区（`regions`）                                                      |
| `geoconv(points, { model })`                      | geoconv/v2               | `GEOCONV_MODEL.WGS84_TO_BD09` 等；每 100 个点一批                                            |
| `placeAround(keywords, center, opts)`             | place/v3/around          | 关键词用 `$` 合并（每次最多 10 个，超出自动拆分）；自动翻页；`capped` 表示命中 150 条上限    |
| `placeRegion(query, region)`                      | place/v3/region          | 可以按地址检索，返回 `address_type`                                                          |
| `placeDetail(uids)`                               | place/v3/detail          | 按 uid 取完整记录（标签、入口、parent_id），每次最多 10 个 uid，按请求缓存，计入地点检索配额 |
| `routeMatrixWalking(origins, destinations, opts)` | routematrix/v2/walking   | 去重、分批（每次 ≤ 50 条）、按起点优先顺序还原；`destUids` 绑定 POI                          |
| `routePairsWalking(pairs, opts)`                  | 同上                     | 稀疏 OD 对（每个小区各自的候选设施），按精确的起点 × 终点块打包，不算多余路线                |
| `walkingRoute(origin, destination)`               | directionlite/v1/walking | 分段距离、耗时、路径点                                                                       |
| `locate(client, text)`                            | 以上组合                 | 见 §4.6 地理编码校验                                                                         |
| `walkDistances(client, pairs, opts)`              | 以上组合                 | 降级链：批量算路 → 轻量步行路线 → ρ̂ × 直线（估算）→ 1.35 × 直线（粗估）                      |

错误都是带中文 `hint` 的类型化错误：`BaiduConfigError`（Key、权限、签名）、`BaiduQuotaError`（`scope`：`daily` 百度返回 302，`soft` 本地 90% 拦截，`hard` 本地 100% 拦截）、`BaiduUpstreamError`（`kind`：网络、限流、参数、回放未命中等）、`BaiduInputError`。`toApiError(err)` 直接得到 `docs/api.md` 约定的 `{ error, message, hint }`。

## 实测怪癖与对策

| 现象（2026-09-26 实测）                                                                             | 客户端的处理                                                                                         |
| --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 批量算路在约 20 种编码下始终返回 211（SN 校验失败），其余接口 SN 正常                               | 批量算路单独使用 IP 白名单的 `BAIDU_MATRIX_AK`，不签名                                               |
| SN = md5(quote_plus("/path?" + 实际发送的 query + SK))，参数顺序必须与发送顺序一致                  | 被签名的字符串就是发送的字符串，`sn` 放在最后；已用官方测试向量 `7de5a222…f9a0` 和 Python 参考值校验 |
| 轻量步行路线的 SN 请求需要 `timestamp`                                                              | SN 模式下自动加在 `ak` 之前                                                                          |
| 终点写成 `lat,lng;uid` 时返回 status 2；分号编码为 `%3B` 后成功                                     | 批量算路参数里的 `;` 一律编码为 `%3B`                                                                |
| 每次最多 50 条路线（起点数 × 终点数），配额和并发都按路线计                                         | 自动分批；另设路线令牌桶（个人档 45 条/秒）；账本按路线记账                                          |
| 结果按起点优先排列                                                                                  | 按 `i × 终点数 + j` 还原成 `cells[i][j]`                                                             |
| 耗时恒等于距离 ÷ 1.17 m/s，看不到红绿灯                                                             | 常量 `BAIDU_WALK_SPEED_MPS`；估算与粗估也用这个速度                                                  |
| 无结果时 distance/duration 为 0                                                                     | 记为 `no_route`，数值为 `null`，绝不当作 0 米                                                        |
| 返回文档未记载的 `restrictions_status`、`retrograde_dist`                                           | 保留在 `restrictionsStatus`、`retrogradeDist`，其他未知字段放进 `extra`                              |
| 401 并发超限不稳定（1 秒间隔也会出现），缩小批量无效，等待有效                                      | 原批次按 1、2、4、8、16 秒（加抖动）退避，最多 5 次；退避期间整个接口暂停；并发减半                  |
| 所有错误都是 HTTP 200 + JSON `status`                                                               | 按 `status` 分支，见下表                                                                             |
| 地理编码把海科路 1650 号放到 3.5 km 外的北蔡镇（`precise=0`），而逆地理得到的区县和道路仍与输入一致 | `precise=0` 一律用地点检索（region）按地址复核；二者相距超过 300 m 时弃用地理编码                    |
| 地点检索 `total` 最多 150                                                                           | 返回 `capped: true`，由调用方拆分关键词或区域                                                        |
| 轻量步行路线的分段耗时比 距离 ÷ 1.17 慢 3.5–6.6%                                                    | 原样返回并标记来源（`directionlite`）                                                                |

## 状态码策略

| status                                                                | 含义             | 策略                                                                                                                  |
| --------------------------------------------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------- |
| 0                                                                     | 成功             | 写缓存                                                                                                                |
| 1                                                                     | 服务器内部错误   | 退避重试 2 次（消息为“无相关结果”时视为空结果，不重试）                                                               |
| 2                                                                     | 参数非法         | 不重试，`BaiduUpstreamError(kind: 'bad_request')`                                                                     |
| 3 / 4 / 5 / 9 / 101 / 102 / 200 / 210 / 211 / 220 / 240（及其他 2xx） | 鉴权、权限、配置 | 不重试，`BaiduConfigError`，附修复提示，例如 211：“SN 校验失败：检查 BAIDU_SERVER_SK，或批量算路改用 BAIDU_MATRIX_AK” |
| 7                                                                     | 无返回结果       | 空结果（轻量步行路线返回 `null`），缓存 1 天                                                                          |
| 301 / 302（及其他 3xx）                                               | 配额超限         | `BaiduQuotaError(scope: 'daily')`，该接口当天熔断                                                                     |
| 401 / 402                                                             | 并发超限         | 原批次指数退避重试，最多 5 次                                                                                         |
| 网络 / TLS / 超时 / HTTP 5xx                                          | 请求未到达百度   | 重试 3 次，不计入配额                                                                                                 |

## 限流与并发

每个接口一条独立通道：

- 令牌桶：档位 QPS 留出余量，个人档 2 次/秒，企业档 20 次/秒，突发为 1（请求均匀间隔）。
- 批量算路另有路线桶：个人档 45 条/秒（容量 50），企业档 450 条/秒（容量 500）。这是经验值：张江实测按 1.15 秒间隔发出 8 批（每批不超过 50 条），7 批一次成功，另 1 批遇到 401，重试后成功。
- AIMD 并发：从 1 开始，连续 4 次成功加 1，个人档上限 3、企业档上限 10；遇到 401/402 减半。
- 所有参数都可以通过 `new Scheduler({ limits })` 覆盖。

## 配额账本

| 接口                 | 个人认证（次/日） | 企业认证·试用（次/日） |
| -------------------- | ----------------- | ---------------------- |
| 地点检索             | 100               | 2,000                  |
| 批量算路（按路线计） | 5,000             | 100,000                |
| 轻量步行路线         | 5,000             | 100,000                |
| 地理编码             | 5,000             | 100,000                |
| 逆地理编码           | 300               | 100,000                |
| 坐标转换             | 5,000             | 100,000                |

- 按北京时间自然日计数（服务器在 UTC 时区也一样），与缓存共用同一个 SQLite 文件，重启不丢；多个进程共享时按增量合并写入。
- 没有预算的调用：用量 + 在途 + 已预留超过 90% 即拒绝（`scope: 'soft'`），也就是“达到 90% 时拒绝新的冷启动调用”。
- `ledger.reserve(plan)` 为一次分析预留配额（超过 90% 时直接拒绝开始）；带 `budget` 的调用可以用到 100%，用完预算后回到 90% 规则。`ledger.blockedBy(plan)` 可在开始前检查。
- 百度返回 302 后，该接口当天熔断，次日自动恢复。
- 计费假设：只记百度实际处理的调用（status 0 或无结果）。鉴权错误、401/402、网络错误不计（研究脚本也是这样计数的）。这一点百度没有明确说明；即使百度实际多扣，302 熔断仍会兜底。
- `ledger.snapshot()` 的字段是 snake_case（`used`、`limit`、`remaining`、`soft_limit`、`reserved`、`in_flight`、`calls`、`failed`、`exhausted`），可直接作为 `/api/health` 的 `quota`；`ledger.onChange()` 或客户端的 `onEvent`（`type: 'quota'`）可用于 SSE 推送。

## 缓存

- 两级：内存 LRU（默认 5,000 条）在前，SQLite 文件在后。当前 Node 不支持 `node:sqlite`（需 ≥ 22.13，或 22.12 加 `--experimental-sqlite`）时自动退回纯内存，并发出一条 warning。
- 缓存键：接口 + 规范化参数。坐标四舍五入到 1e-5 度（约 1 m），参数按名排序，去掉 `ak`、`sn`、`timestamp`、`output`。
- 有效期：路线 30 天（实测步行耗时与路况无关），地点检索 7 天，地理编码、逆地理编码、坐标转换 30 天；“无路线 / 无结果”只缓存 1 天。
- 批量算路按 OD 对逐条缓存，所以不同批次的请求也能互相命中。
- 相同的在途请求合并为一次（批量算路按 OD 对合并）。失败结果从不缓存。
- 命中缓存不需要 Key：预先跑过的社区在样例模式下也能直接回放。

## 回放模式（离线演示与测试）

`ReplayTransport` 用录制好的真实响应代替网络。录制格式与 `research/api-probe/probe.py` 保存的一致：

```json
{
  "_meta": { "request": "https://api.map.baidu.com/…?…&ak=***&sn=***", "http_status": 200 },
  "response": { "status": 0 }
}
```

匹配规则：路径相同，且下列关键参数相同（`ak`、`sn`、`timestamp` 以及 `output`、`scope` 等可选参数忽略；坐标逐个数值比较，容差 1e-6 度，所以 6 位小数的请求能匹配 15 位小数的录制）：

| 路径                        | 关键参数                                         |
| --------------------------- | ------------------------------------------------ |
| `/geocoding/v3/`            | address, city                                    |
| `/reverse_geocoding/v3/`    | location                                         |
| `/geoconv/v2/`              | coords, model                                    |
| `/place/v3/around`          | query, location, radius, page_num                |
| `/place/v3/region`          | query, region, page_num                          |
| `/place/v3/detail`          | uids, scope                                      |
| `/routematrix/v2/walking`   | origins, destinations, road_prefer               |
| `/directionlite/v1/walking` | origin, destination, origin_uid, destination_uid |

同一个请求匹配到多条录制时：`sequence`（构造函数默认）按顺序逐条返回、最后一条重复，可以重现“先 401 再成功”；`first-ok`（`fromDirs` 默认）总是返回第一条 status 0 的录制。没有录制的请求抛出 `BaiduUpstreamError(kind: 'replay_miss')`，不会重试，脱敏后的 URL 记在 `replay.misses`。

```ts
import { createReplayClient } from '@zoudedao/baidu';

// 不联网、不消耗真实配额、不等待；账本与缓存都在内存中
const offline = await createReplayClient({ dirs: ['research/api-probe/raw', 'research/zhangjiang/raw'] });
const m = await offline.routeMatrixWalking(origins, destinations); // 只能回放录制过的请求
```

## 测试

`pnpm --filter @zoudedao/baidu test` 完全离线：测试只用假 Key，响应来自 `research/api-probe/raw` 与 `research/zhangjiang/raw` 的真实录制，外加少量合成响应（例如百度文档中的 302 回复，研究阶段没有录到）。覆盖签名测试向量、参数编码（`%3B`、`$`）、按真实张江批次验证分批与起点优先还原、211/240/302/401 状态分支、用假时钟验证退避时间表与限速、账本限额、缓存键规范化与请求合并、地理编码错位时改用地点检索、降级链。

## 安全

- 日志、事件和错误信息里的 URL 一律经过 `maskUrl()`，`ak`、`sn` 打码。
- 缓存键不含 `ak`、`sn`、`timestamp`，缓存里只有百度的响应内容。
- `health()` 只报告鉴权方式，不含任何 Key。
- SK 只在服务端参与签名，不会出现在任何返回值中。
