# @zoudedao/server

走得到的服务端（Fastify 5）：样例查询、SSE 流式体检、体检顾问问询（SSE）、托管构建好的 Web。接口约定以 [`docs/api.md`](../../docs/api.md) 为准，数据结构以 `packages/core/src/types.ts` 的 `AnalysisResult` 为准。

## 运行模式

| 模式     | 触发条件                                                                                             | `POST /api/analyze`                                            |
| -------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `sample` | 默认。未配置服务端 Key，或 `ZDD_MODE=sample`                                                         | 返回 409 `live_mode_disabled`，只提供 `data/samples/` 里的样例 |
| `live`   | 配置了 `BAIDU_SERVER_AK`，并且配置了 `BAIDU_SERVER_SK` 或 `BAIDU_SERVER_AUTH=ip`；或 `ZDD_MODE=live` | 以 SSE 逐阶段推送体检进度和结果                                |

- 是否具备 live 条件由 `@zoudedao/baidu` 的 `loadBaiduConfig().live` 判断。从 `.env.example` 复制后没有改过的占位值（如 `your_server_ak`）按"未配置"处理。
- 启动时把 `loadBaiduConfig().issues`（中文说明，例如"SN 模式需要 BAIDU_SERVER_SK"）按 warn/error 级别写入日志，sample 模式也会写，方便排查 Key 为什么没有生效。说明里只出现变量名，不出现 Key 的值。
- live 模式且 Key 可用时，入口会创建一个百度客户端（`createBaiduClient()`）：缓存与配额账本存放在 SQLite 文件 `BAIDU_CACHE_PATH` 中，`/api/health` 的 `quota` 取自它的账本，服务关闭时调用 `client.close()`。持久化需要 Node ≥ 22.13（`node:sqlite`），更低版本退回内存并在日志中警告。
- live 模式且 Key 可用时，`POST /api/analyze` 使用 `@zoudedao/engine` 的实时分析器（`/api/health` 的 `"analyzer": "engine"`）。**`ZDD_MODE=live` 但没有可用 Key 时（例如前端联调）使用样例回放分析器 `SampleReplayAnalyzer`**：按真实节奏（约 10 秒）逐阶段回放张江样例 `zj-a`，不使用输入坐标，也不调用任何百度接口；回放中的配额事件按设计文档 §4.4 的单次体检预算模拟，只计入回放自己的进程内账本，`/api/health` 返回 `"analyzer": "replay"` 并显示这份模拟账本，前端可据此标注"样例回放"。实时分析器的接入方式见文末。

## 启动

```bash
pnpm install
pnpm --filter @zoudedao/server dev        # tsx watch，http://localhost:8787
curl http://localhost:8787/api/health
```

- 开发时 Web 跑在 http://localhost:5173，Vite 把 `/api` 代理到 8787。根目录 `pnpm dev` 会同时启动两者。
- 服务启动时读取仓库根目录的 `.env.local` 和 `.env`，已存在的环境变量优先。日志只记录读取了哪些文件，不会输出 Key 的值。
- 生产方式：先 `pnpm --filter "@zoudedao/server..." --filter "@zoudedao/web..." build`，再 `pnpm --filter @zoudedao/server start`。`apps/web/dist` 存在时，Web 和 API 由同一个端口提供。

### Docker

```bash
docker compose up --build                            # 没有 .env.local：样例回放模式
docker compose --env-file .env.local up --build      # 实时模式，同时把浏览器端 AK 写入前端
```

- 镜像基于 `node:24-slim`，多阶段构建（按 lockfile 安装，构建 core、baidu、server、web），运行时只包含服务端产物、生产依赖、Web 构建产物和 `data/samples`。
- 以非 root 用户 `node` 运行，代码只读；只有缓存目录 `/app/data/cache` 可写（百度缓存与配额账本 `baidu.sqlite`、体检历史 `analyses.sqlite`），compose 中挂载为卷 `zdd-cache`，重建容器后当日配额计数、实时体检历史和查过的步行路线都不会丢失。样例预取的步行路线（`data/samples/routes/`）随 `data/samples` 进入镜像。
- 内置 `HEALTHCHECK`（访问 `/api/health`）。`docker stop` 会触发优雅退出。
- 浏览器端 AK 由 Vite 在**构建时**写入前端（构建参数 `VITE_BAIDU_BROWSER_AK`）。它本来就会下发到浏览器，靠百度控制台的 Referer 白名单保护。服务端 Key 只在**运行时**通过 `env_file` 注入，不进入镜像。
- 访问 Docker Hub 或 npm 较慢时，可以换成镜像源：`NODE_IMAGE=docker.m.daocloud.io/library/node:24-slim NPM_REGISTRY=https://registry.npmmirror.com/ docker compose up --build`。

## 环境变量

| 变量                                                                               | 默认值                            | 说明                                                                                                                                                                                                                                                                                        |
| ---------------------------------------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                                                                             | `8787`                            | 监听端口                                                                                                                                                                                                                                                                                    |
| `HOST`                                                                             | `localhost`（镜像内为 `0.0.0.0`） | 监听地址                                                                                                                                                                                                                                                                                    |
| `ZDD_MODE`                                                                         | 自动                              | `sample` 或 `live`。留空时按服务端 Key 自动判断                                                                                                                                                                                                                                             |
| `BAIDU_SERVER_AK` / `BAIDU_SERVER_SK` / `BAIDU_SERVER_AUTH` / `BAIDU_MATRIX_AK`    | —                                 | 百度服务端 Key，含义见 `.env.example`。只交给 `@zoudedao/baidu` 使用；服务端配置对象只保存"是否可用"和配置说明，不保存值                                                                                                                                                                    |
| `BAIDU_TIER`                                                                       | `personal`                        | 配额档位：`personal` 或 `enterprise`，决定账本中的每日上限                                                                                                                                                                                                                                  |
| `BAIDU_CACHE_PATH`                                                                 | `data/cache/baidu.sqlite`         | 百度缓存与配额账本的 SQLite 文件。相对路径按**仓库根目录**解析（不受启动目录影响），镜像内为 `/app/data/cache/baidu.sqlite`                                                                                                                                                                 |
| `ZDD_SAMPLES_DIR`                                                                  | `<仓库>/data/samples`             | 样例目录。每个 `*.json` 是一个样例，文件名即样例 id                                                                                                                                                                                                                                         |
| `ZDD_OFFICIAL_DIR`                                                                 | `<仓库>/data/official`            | 官方数据目录：设施名录（浦东标准化菜市场、2026 年浦东小学招生名单、市卫健委社区卫生服务中心）由引擎与百度 POI 融合（确认、改类或按官方地址补充）；对口地段表（`kind: "catchment"`）给小区配对口小学；排除清单（`kind: "exclusions"`）剔除核实有误的百度 POI。目录缺失或文件损坏时跳过并告警 |
| `ZDD_WEB_DIST`                                                                     | `<仓库>/apps/web/dist`            | Web 构建产物。缺少 `index.html` 时跳过静态托管                                                                                                                                                                                                                                              |
| `ZDD_TRUST_PROXY`                                                                  | `false`                           | 部署在反向代理之后时必须设置：`true`、代理层数（如 `1`）或代理地址/网段（逗号分隔）。否则所有访客共用代理的 IP，限流会失真                                                                                                                                                                  |
| `ZDD_CORS_ORIGINS`                                                                 | 空                                | 允许跨域调用 `/api` 的来源，逗号分隔、完整匹配。默认不发送任何 CORS 头，只允许同源                                                                                                                                                                                                          |
| `ZDD_RATE_LIMIT_PER_MINUTE`                                                        | `300`                             | 每个 IP 每分钟的请求上限（所有路由，包括静态文件和 404）                                                                                                                                                                                                                                    |
| `ZDD_ANALYZE_PER_HOUR`                                                             | `6`                               | 每个 IP 每小时可以发起的 `POST /api/analyze` 次数                                                                                                                                                                                                                                           |
| `ZDD_LOCATE_PER_MINUTE`                                                            | `30`                              | 每个 IP 每分钟可以调用 `GET /api/locate` 的次数                                                                                                                                                                                                                                             |
| `ZDD_MAX_CONCURRENT_ANALYSES`                                                      | `2`                               | 同时进行的分析数，超出时返回 503 `busy`                                                                                                                                                                                                                                                     |
| `ZDD_ANALYZE_TIMEOUT_S`                                                            | `180`                             | 单次分析的时间上限（秒），超时以 `error` 事件 `timeout` 结束                                                                                                                                                                                                                                |
| `ZDD_LOCATE_TIMEOUT_S`                                                             | `20`                              | 单次地址搜索的时间上限（秒），超时返回 504 `timeout`                                                                                                                                                                                                                                        |
| `ZDD_REPLAY_PACE`                                                                  | `1`                               | 样例回放的节奏倍数：`1` 约 10 秒，`0` 立即完成（适合端到端测试）                                                                                                                                                                                                                            |
| `ZDD_ASK_PER_10MIN`                                                                | `30`（配置大模型时相同）          | 每个 IP 每 10 分钟可以调用 `POST /api/ask` 的次数。现场评委共用一个 IP，所以大模型模式也是 30 次                                                                                                                                                                                            |
| `ZDD_ASK_TIMEOUT_S`                                                                | `60`                              | 单次问询的时间上限（秒）；大模型只有其中 3/4 的时间，超出后改用模板回答                                                                                                                                                                                                                     |
| `ZDD_WHATIF_PER_10MIN`                                                             | `10`                              | 每个 IP 每 10 分钟可以调用 `POST /api/whatif` 的次数（每次最多 30 条批量算路）                                                                                                                                                                                                              |
| `ZDD_WHATIF_TIMEOUT_S`                                                             | `20`                              | 单次新增设施模拟的时间上限（秒），超时返回 504 `timeout` 并中止百度调用                                                                                                                                                                                                                     |
| `ZDD_MAX_CONCURRENT_ASKS`                                                          | `8`                               | 同时进行的问询数，超出时返回 503 `busy`                                                                                                                                                                                                                                                     |
| `ZDD_HISTORY_PATH`                                                                 | `data/cache/analyses.sqlite`      | 体检历史的 SQLite 文件（WAL）：实时体检结果保存 30 天、新增设施模拟的分支、步行路线（永久）。相对路径按**仓库根目录**解析；`off` 只保存在内存中（重启后清空）。打不开时退回内存并在日志中警告                                                                                               |
| `ZDD_ROUTE_PER_10MIN`                                                              | `30`                              | 每个 IP 每 10 分钟可以发起的、需要调用百度的 `GET /api/route` 次数（已保存的路线不计）                                                                                                                                                                                                      |
| `ZDD_ROUTE_TIMEOUT_S`                                                              | `20`                              | 单次步行路线查询的时间上限（秒），超时返回 504 `timeout` 并中止百度调用                                                                                                                                                                                                                     |
| `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` / `LLM_EXTRA_BODY` / `LLM_TIMEOUT_MS` | —                                 | 体检顾问的大模型（OpenAI 兼容接口），由 `@zoudedao/agent` 的 `llmConfigFromEnv()` 读取，含义与常用服务的配置见 `packages/agent/README.md`。不配置时问询用模板回答；Key 只放在请求头里，不写日志、不出现在 `/api/health` 和错误信息里                                                        |
| `LOG_LEVEL`                                                                        | `info`                            | 日志级别：`silent`、`error`、`warn`、`info`、`debug`                                                                                                                                                                                                                                        |

## 接口

### `GET /api/health`

```json
{
  "ok": true,
  "mode": "live",
  "version": "0.1.0",
  "analyzer": "replay",
  "advisor": { "mode": "template" },
  "quota": { "place": { "used": 3, "limit": 100 }, "routematrix_walking": { "used": 234, "limit": 5000 } }
}
```

- live 模式且 Key 可用时，`quota` 是百度配额账本 `client.ledger.snapshot()`：六个服务各一项，字段为 `used`、`limit`、`remaining`、`soft_limit`（90%，超过后拒绝新的冷启动调用）、`reserved`、`in_flight`、`calls`、`failed`、`exhausted`，以及可选的 `exhausted_reason`。
- `sample` 模式下 `quota` 为 `{}`，且没有 `analyzer` 字段。
- `advisor`：`{ "mode": "template" }`，或配置了大模型时 `{ "mode": "llm", "model": "<模型名>" }`（不含 Key 和接口地址）。
- `quota` 来自可注入的 `QuotaProvider`（只要求 `snapshot()`，每项至少有 `used` 与 `limit`）。

### `GET /api/samples`

扫描样例目录，从每个文件的 `meta` 读取名称和中心点。新增样例不需要重启服务，读取失败或不含 `meta` 的文件会被跳过并记录警告。

```json
[
  {
    "id": "zj-a",
    "name": "申城佳苑片区",
    "center_bd09": [121.644195, 31.19007],
    "center_label": "孙环路 × 高木桥路"
  }
]
```

### `GET /api/analysis/:id`

返回样例文件中完整的 `AnalysisResult`（约 400 KB，gzip 后约 100 KB），或实时体检的结果（`live-<8 位十六进制>`：先查内存 LRU，再查体检历史，重启后仍可取回）。`id` 只在扫描得到的样例列表中查找、或作为历史表的键，不参与路径拼接，所以 `../` 之类的输入一律返回 404 `{ "error": "not_found", "message": "样例不存在" }`。支持 `Accept-Encoding: gzip`，以及 `ETag` / `If-None-Match`（304；实时结果的 ETag 为 `W/"<编号>"`，历史里存的就是 gzip，直接发送）。

### `GET /api/history`

地区下拉框：`{ items, persistent, retention_days }`。`items` 先是最近 20 次实时体检（`HistoryStore.recent()`，新的在前），再是内置样例（`sample: true`）；每项 `{ id, sample, created_at, center_bd09, label, profile, rules, name, headline }`，`headline` 为小区数、15 分钟可达面积与直线圆面积、画圆高估倍数、赛题口径的已核实缺口（伪覆盖、盲区）和待核实数（`src/history.ts` 的 `historyHeadline()`，计数方式与问询工具的 `headline()` 相同）。样例的 `headline` 按文件 etag 缓存。完整字段见 `docs/api.md`。

### `GET /api/analysis/:id/branches`

`POST /api/whatif` 每次成功的实测模拟都保存为所属分析的一个分支（`HistoryStore.saveBranch()`，编号 `wi-<8 位十六进制>` 由分析、类别、口径和位置决定，同一模拟重做只保留最新一次，保存 30 天）。返回 `{ analysis_id, branches }`，新的在前，最多 50 条（旧版按国标口径保存的分支不再列出）；`:id` 可带 `~elder`；分析不存在或已过期返回 404。

### `GET /api/locate?q=<地址、地名或坐标>&city=<城市>&crs=<坐标系>`

把地址、地名或坐标解析成候选中心点，供搜索框、MCP Server 和 AI 顾问使用。`city` 可省略，默认 `上海市`。完整字段见 `docs/api.md`。

- 有可用的百度客户端时（live 模式且 Key 可用）：调用 `@zoudedao/baidu` 的 `locate()`，最多 3 次调用（地理编码、逆地理编码核对区县、地点检索兜底）。相同的 `(q, city)` 在内存中缓存 10 分钟（最多 500 条），并发的相同查询共用一次调用，失败结果不缓存。
- 否则（`sample` 模式，或 `ZDD_MODE=live` 但没有可用 Key）：不调用百度接口，只在样例社区的名称和中心点标注中查找（忽略大小写和空格），候选带 `source: "sample"` 和 `sample_id`。
- 返回 `{ query, city, best, candidates, needs_confirmation, warnings }`。候选为 `{ name, address?, center_bd09, source, confidence, reason, distance_to_best_m?, uid?, sample_id?, crs?, converted_via? }`，`best` 排在最前。
- `q` 去掉首尾空白后须为 1–60 个字符，`city` 不超过 20 个字符，`crs` 只能是 `bd09`、`gcj02`、`wgs84`，否则返回 400 `invalid_input`。百度侧错误经 `toApiError()` 映射：`quota_exhausted` → 429、`auth` → 503、`upstream` → 502；超过 20 秒（`ZDD_LOCATE_TIMEOUT_S`）→ 504 `timeout`，并中止未完成的百度调用；其他异常 → 500 `internal`。返回的文字会去掉 URL，并对 Key 参数打码。
- 每个 IP 每分钟最多 30 次（`ZDD_LOCATE_PER_MINUTE`），坐标查询也计入。

**坐标输入**（`src/coordinates.ts`）：`q` 恰好是两个数时按坐标处理，不做地理编码。

- 写法：`121.644195,31.19007`、`121.644195 31.19007`、全角逗号与全角数字、`、` `;` 分隔、外加方括号或圆括号都可以；每个数最多 3 位整数。中国的经度（72.004–137.8347）与纬度（0.8293–55.8271）不重叠，所以 `31.19007,121.644195` 也能按“纬度, 经度”识别。两个数但两种顺序都不在中国范围内 → 400 `invalid_input`（“坐标不在中国范围内…”）。解析在 `@zoudedao/core` 的 `parseCoordinateText()`，与 Web 搜索框的规则相同。
- `crs`（默认 `bd09`，只对坐标生效）：`bd09` 直接使用，不调用任何接口（`converted_via: "none"`）；`gcj02` / `wgs84` 调用百度坐标转换 `client.geoconv()`（geoconv/v2，model 1 / 2，走缓存与配额账本，坐标转换 5,000 次/日），并与 core 的本地公式（`gcj02ToBd09` / `wgs84ToBd09`）交叉核对：相差超过 10 米时在 `warnings` 里提示并采用百度结果（`converted_via: "baidu_geoconv"`）；百度坐标转换失败（配额、Key、网络、超时）时改用本地公式，`converted_via: "local"` 并在 `warnings` 里说明原因；非百度的意外异常 → 500 `internal`。
- `sample` 模式只用本地公式（`converted_via` 为 `none` 或 `local`），`warnings` 注明样例模式。
- 返回一个候选、`needs_confirmation: false`：`{ name: "坐标 121.644195, 31.190070", center_bd09, source: "coordinate", crs, converted_via, confidence: 1, reason, sample_id? }`。`name` 是输入的坐标（按经度、纬度，6 位小数），`center_bd09` 是转换后的 BD-09（6 位小数）；中心点 100 米内有样例时带 `sample_id`，可以直接打开样例而不消耗配额。

### `POST /api/analyze`

请求体（JSON，不超过 4 KB）：

| 字段          | 要求                                                                                    |
| ------------- | --------------------------------------------------------------------------------------- |
| `center_bd09` | 必填，BD-09 `[经度, 纬度]`，须在中国范围内（经度 72.004–137.8347，纬度 0.8293–55.8271） |
| `label`       | 可选，不超过 80 个字符                                                                  |
| `profile`     | `adult`（默认）或 `elder`                                                               |

未知字段会被忽略。数值必须是 JSON 数字，不做字符串转换。

响应为 `text/event-stream`，每个事件是一行 `event`、一行单行 JSON 的 `data`，再加一个空行：

```text
event: stage
data: {"stage":"seed","progress":0.2,"message":"粗采样：16 个方位 × 3 个半径，共 48 条步行路线"}

event: quota
data: {"service":"routematrix_walking","used":48,"limit":5000}

event: partial
data: {"samples":[...]}

```

- 事件名和数据结构见 `docs/api.md`：`stage`、`partial`、`quota`，最后以 `result` 或 `error` 之一结束，随后关闭连接。
- `result` 带 `meta.analysis_id`（`live-<8 位十六进制>`，即 `@zoudedao/agent` 的 `AnalysisStore.liveId()`：同一中心点、画像和生成时间得到同一编号）。服务端在内存 LRU 中保留最近 20 个结果（`src/advisor.ts` 的 `LiveResults`），同时写入体检历史（`src/history.ts` 的 `HistoryStore`：SQLite `ZDD_HISTORY_PATH`，WAL，结果 gzip 后存 BLOB，另存编号、写入时间、中心点、标注、画像、口径、名称与 `headline`，保存 30 天）。`GET /api/analysis/:id`、`POST /api/ask`、`POST /api/whatif`、`GET /api/route` 先查 LRU 再查历史，所以重启后编号仍然有效。写历史失败只记一条警告，不影响这次分析；回放分析器（`"analyzer": "replay"`）的结果只进 LRU，不写历史。字段不完整、不能被问询使用的结果原样发送，不带编号。
- `partial` 中出现的每个字段都是该字段**当前的完整值**，客户端按 `{ ...prev, ...partial }` 浅合并即可。
- 每 15 秒发送一行注释 `: ping` 保活，并带有 `X-Accel-Buffering: no`，nginx 不会缓冲事件。
- `EventSource` 不支持 POST，前端请用 `fetch` 加 `ReadableStream` 读取。
- 客户端断开连接会中止分析。分析超过 180 秒时以 `error` 事件 `timeout` 结束，服务重启时以 `internal` 结束。
- `error.code`：`quota_exhausted`、`auth`、`upstream`、`invalid_input`、`timeout`、`internal`，含义与客户端建议见 `docs/api.md`「错误码」。分析器抛出的 `AnalyzeError` 原样透传；未经包装的百度错误（`BaiduError`）经 `toApiError()` 保留自己的代码，`upstream` 只用于百度侧故障；其他异常返回 `internal`「分析出错，请稍后重试」，细节只写日志（已打码）。

回放分析器的事件顺序：`locate` → `facilities` → `seed` → `paths` → `refine`（2 轮）→ `reach` → `coverage` → `report` → `result`。

### `POST /api/whatif`

新增设施模拟（实测），完整约定见 `docs/api.md`。请求体 `{ analysis_id, category: "小学" | "菜市场" | "药店", site_bd09: [经度, 纬度], rules?: "task" }`（`rules` 只为兼容旧客户端保留，其他值 400），返回 `{ analysis_id, category, rules, rule_m, site_bd09, measured: [{ community, straight_m, route_m, dur_s, before, after }], newly_covered, skipped, quota: { routes, cached } }`。

- 只在 live 模式且有百度客户端时可用；`sample` 模式和没有 Key 的回放模式在解析请求体之前返回 409 `live_mode_disabled`。
- `analysis_id` 在样例目录或实时结果（`meta.analysis_id`：内存 LRU，再查体检历史）中查找（与 `POST /api/ask` 共用 `ServerBackend`），找不到返回 404 `not_found`。
- 从新设施位置出发做一次 1 × N 批量算路（`src/whatif.ts` 的 `runWhatIf()`，N ≤ 30：先取当前该类有缺口或待核实的小区，再按距离由近到远），终点是直线距离不超过判定距离 × 1.5 的小区；前后状态由 core `withNewFacility()` 按赛题口径（1 km）判定。路线经缓存与配额账本，`quota.routes` 是本次计费的路线数。
- `site_bd09` 须在中国范围内（与 `POST /api/analyze` 相同的 JSON Schema 边界），错误信息为中文；每个 IP 每 10 分钟 10 次（`ZDD_WHATIF_PER_10MIN`），单次 20 秒（`ZDD_WHATIF_TIMEOUT_S`）超时返回 504。客户端断开（响应写出前连接关闭）会中止百度调用，服务关闭时进行中的模拟以 503 结束。百度错误经 `toApiError()` 映射（配额 429、Key 503、上游 502）。
- 成功的模拟另外保存为所属分析的分支（`GET /api/analysis/:id/branches`），响应多一个 `branch_id`；保存失败只记警告。
- 测试（`test/whatif.test.ts`、`test/history.test.ts`）用注入的假路由（`buildApp({ router })`），不调用百度接口。

### `GET /api/route?analysis_id=&community=&category=&rules=`（或 `from=&to=`）

步行路线证据：小区（实时结果为出入口，`zj-a` 为 OSM 轮廓几何中心）到这项判定经由的设施入口的真实步行路线，百度轻量步行路线（`client.walkingRoute(from, to, { stepsInfo: true })`，经缓存与配额账本）。完整约定见 `docs/api.md`。

- 查找顺序（`src/route.ts` 的 `RouteBook`）：样例预取的路线（`<ZDD_SAMPLES_DIR>/routes/*.json`，启动时读入）→ 体检历史的路线表（按起终点 1e-5° 为键，永久保存）→ 百度（仅 live 模式且有客户端；拿到后写入路线表）。所以同一对起终点只调用一次百度，演示时已核实伪覆盖的路线都不用等待。
- `sample` 模式（和没有 Key 的回放模式）照样返回已保存的路线；未保存的返回 409 `live_mode_disabled`。
- 起终点由 `checkPair()` 从分析结果算出（小区 `centroid` → BD-09；设施按 `via_uid`（含合并的重复条目）其次按名称找到，终点取入口 `navi_xy`，与判定算路一致）；`community` 也接受地图编号 `A-01`（与 Web、`POST /api/ask` 的 `anchors` 相同的编号规则）。判定没有算路（`route_basis` 不是 `routed`）时 404。
- 需要调用百度的查询每个 IP 每 10 分钟 30 次（`ZDD_ROUTE_PER_10MIN`，`src/routes/route.ts` 的滑动窗口 `WindowLimiter`；已保存的路线不计，只受全局每分钟 300 次限制），单次 20 秒（`ZDD_ROUTE_TIMEOUT_S`）；客户端断开会中止百度调用，服务关闭时进行中的查询以 503 结束；百度错误经 `toApiError()` 映射（配额 429、Key 503、上游 502），没有路线 404。
- 测试（`test/route.test.ts`）用注入的假步行路线（`buildApp({ walker })`）与临时样例目录、临时历史文件，不调用百度接口；另有一项检查四个样例赛题口径的每一项已核实伪覆盖都能从已保存的路线返回。

### `POST /api/ask`

体检顾问（问询），完整约定见 `docs/api.md`。请求体 `{ question, analysis_id?, history? }`：问题 1–300 个字符，`history` 最多 8 条、每条不超过 2000 个字符；`analysis_id` 必须是样例 id 或体检历史中的实时结果编号（30 天内，重启后仍有效；可加 `~elder`），否则 400 `invalid_input`。

```text
: ping

event: tool_call
data: {"tool":"analyze_life_circle","title":"生活圈体检","args":{"analysis_id":"zj-a","profile":"elder"}}

event: tool_result
data: {"tool":"analyze_life_circle","title":"生活圈体检","id":"T1","summary":"申城佳苑片区（analysis_id: zj-a~elder，老年人画像；…）：…"}

event: answer
data: {"answer":"结论：不太方便：…[T2]。…","mode":"template","citations":[…],"grounding":{"ok":true,"checked":26,"unsupported":[],"uncited":[]},"analysis_id":"zj-a~elder"}

```

- 顾问是 `@zoudedao/agent` 的 `createAdvisor()`，数据源是进程内的 `ServerBackend`（`src/advisor.ts`）：样例来自 `SampleStore`，实时结果来自上面的 LRU 与体检历史。**它不调用百度接口，也不发起新的实时体检**：`locate` 只在样例中查找，`analyze` 直接回答“请使用地图左上角的搜索框”——问询只回答屏幕上已有的体检。
- 每次问询用自己的 `AnalysisStore`，只放入这次请求点名的实时结果：一个访客的实时体检不会出现在另一个访客的回答里。解析过的样例在请求之间共享（工具只读不写）。
- 配置了大模型（`LLM_BASE_URL`、`LLM_MODEL` 等）时由模型规划工具调用；每个回答都经过数字溯源校验，初稿有找不到出处的数字时推送 `repair` 并让模型改写一次，仍不通过则推送 `fallback` 并改用模板回答。模型超过总时限的 3/4（默认 45 秒）没有完成，也改用模板回答。
- 流一开始就发一行 `: ping`（让响应头立即送达，大模型思考期间客户端也能确认连接），之后每 15 秒一行。客户端断开会中止回答（包括进行中的大模型请求）；超过 60 秒以 `error` 事件 `timeout` 结束；服务关闭时以 `internal` 结束。
- 事件只带中文摘要和工具名，不带工具的原始数据（摘要最长 20,000 字符，参数超过 2 KB 时省略）；`export_report` 生成的文件放在 `answer.attachments` 里，供 Web 端下载。
- `answer.citations[]` 带 `anchors`：工具结果提到的小区（名称、地图编号、局部坐标与 BD-09）、设施、灰色区域层和模拟位置，供 Web 点击来源编号时在地图上高亮（`@zoudedao/agent` 的 `anchors.ts`，不交给大模型）；大模型只是漏标、标错来源编号而由系统补上时，`answer.citations_added` 列出补上的编号（如 `["1.88 倍 → T1"]`）。
- 日志每次问询一行：分析编号、回答方式、调用的工具、是否通过校验、耗时；不记录问题原文，也不记录任何 Key。错误信息先经 `scrubSecrets()` 去掉 Key，再经 `forClient()` 去掉 URL。

### HTTP 错误

所有错误都是 `{ "error": "<code>", "message": "<中文说明>" }`。完整的错误码、含义和客户端建议见 `docs/api.md`「错误码」：

| 状态 | `error`                  | 场景                                                                                                              |
| ---- | ------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| 400  | `invalid_input`          | 请求体或查询参数不合法，`message` 指出是哪个字段                                                                  |
| 404  | `not_found`              | 样例、接口或文件不存在                                                                                            |
| 409  | `live_mode_disabled`     | `sample` 模式下调用 `POST /api/analyze` 或 `POST /api/whatif`（不检查请求体），或 `GET /api/route` 查未保存的路线 |
| 413  | `payload_too_large`      | 请求体过大                                                                                                        |
| 415  | `unsupported_media_type` | 请求体不是 JSON                                                                                                   |
| 429  | `rate_limited`           | 超出限流，响应头 `retry-after` 给出秒数                                                                           |
| 429  | `quota_exhausted`        | `GET /api/locate`：当日配额已用到 90% 或已用尽                                                                    |
| 502  | `upstream`               | `GET /api/locate`：百度接口出错                                                                                   |
| 503  | `busy` / `auth`          | 同时进行的分析或问询数已满 / 百度 Key 配置有误（地址搜索）                                                        |
| 504  | `timeout`                | `GET /api/locate`：超过 20 秒                                                                                     |
| 500  | `internal`               | 服务器内部错误；服务重启期间到达的请求为 503                                                                      |

## curl 示例

```bash
curl -s http://localhost:8787/api/health
curl -s http://localhost:8787/api/samples
curl -s --compressed http://localhost:8787/api/analysis/zj-a -o zj-a.json

# 地址搜索（-G 把 --data-urlencode 的参数拼到 URL 上）
curl -s -G http://localhost:8787/api/locate --data-urlencode 'q=海科路1650号'
curl -s -G http://localhost:8787/api/locate --data-urlencode 'q=申城佳苑' --data-urlencode 'city=上海市'

# 坐标输入：BD-09 直接使用；GCJ-02 / WGS84 经百度坐标转换（样例模式用本地公式）
curl -s -G http://localhost:8787/api/locate --data-urlencode 'q=121.644195,31.19007'
curl -s -G http://localhost:8787/api/locate --data-urlencode 'q=31.187，121.62' --data-urlencode 'crs=wgs84'

# 流式体检（-N 关闭缓冲，逐条看到事件）
curl -N -X POST http://localhost:8787/api/analyze \
  -H 'content-type: application/json' \
  -d '{"center_bd09": [121.644195, 31.19007], "label": "孙环路 × 高木桥路", "profile": "adult"}'

# 新增设施模拟（仅 live 模式；实测路线，最多 30 条）
curl -s -X POST http://localhost:8787/api/whatif \
  -H 'content-type: application/json' \
  -d '{"analysis_id": "zj-a", "category": "药店", "site_bd09": [121.645361, 31.19485]}'

# 问询（模板模式不需要任何 Key，也不调用百度接口）
curl -N -X POST http://localhost:8787/api/ask \
  -H 'content-type: application/json' \
  -d '{"question": "老人买菜方便吗？", "analysis_id": "zj-a"}'

# 参数校验：坐标不在中国范围内 → 400 invalid_input
curl -s -X POST http://localhost:8787/api/analyze \
  -H 'content-type: application/json' -d '{"center_bd09": [2.35, 48.85]}'
```

## 安全与稳定性

- **同源**：默认不发送 CORS 头，浏览器只允许同源页面读取 `/api`。确需跨域时，用 `ZDD_CORS_ORIGINS` 列出来源。
- **安全响应头**：`X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`、`Cross-Origin-Resource-Policy: same-origin`、`Referrer-Policy: strict-origin-when-cross-origin`（浏览器端 AK 的 Referer 白名单需要来源信息）。CSP 在 `/api` 下为 `default-src 'none'`；页面只限制 `object-src`、`base-uri`、`frame-ancestors`，以免影响百度 JSAPI 加载脚本和瓦片。HSTS 由 TLS 终端（反向代理）设置。
- **限流**（`@fastify/rate-limit`，按 IP）：`POST /api/analyze` 默认每小时 6 次，`GET /api/locate` 每分钟 30 次，`POST /api/ask` 每 10 分钟 30 次（配置大模型时相同：现场评委共用一个 IP），`POST /api/whatif` 每 10 分钟 10 次，`GET /api/route` 需要调用百度的每 10 分钟 30 次（已保存的路线不计），其他路由每分钟 300 次。另有并发上限和单次分析、问询、模拟、步行路线超时。
- **大模型 Key**：只交给 `@zoudedao/agent` 的客户端放进 `Authorization` 请求头；启动日志只记录“模型 @ 主机”，`/api/health` 只给模型名。
- **输入**：请求体和查询参数按 JSON Schema 校验；样例 id 只在目录清单中查找。
- **日志**：每个请求记录一行，URL 和错误信息里 `ak`、`sk`、`sn`、`token` 等参数的值打码为 `***`。
- **优雅退出**：收到 SIGINT 或 SIGTERM 后不再接收新连接，已建立连接上的新请求返回 503 `internal`（统一错误格式），正在进行的 SSE 以 `error` 事件 `internal` 结束，等待其他请求完成；10 秒后仍未退出则强制退出。再按一次 Ctrl-C 立即退出。

## 接入实时分析器

HTTP 层只依赖 `src/analyzer.ts` 中的接口：

```ts
export interface Analyzer {
  readonly name?: string; // 在 /api/health 中显示，如 "replay"
  analyze(input: AnalyzeInput, emit: Emit, signal: AbortSignal): Promise<AnalysisResult>;
}
```

- `emit('stage' | 'partial' | 'quota', data)` 推送进度；Promise 兑现时推送 `result`，拒绝时推送 `error`。
- 可预期的失败请抛出 `new AnalyzeError(code, '中文说明')`，`code` 为 `quota_exhausted`、`auth`、`upstream`（仅百度侧故障）、`invalid_input`、`timeout` 或 `internal`。直接抛出的 `BaiduError` 也会按 `toApiError()` 映射。
- `signal` 在客户端断开、服务关闭或超时时触发。即使分析器没有响应它，流也会立即结束，之后的 `emit` 会被丢弃。
- 已在 `src/index.ts` 中注入：live 模式且 Key 可用时，`buildApp({ config, baidu, analyzer: baidu && createLiveAnalyzer(baidu, loadOfficialData(officialDir)) })` 使用 `@zoudedao/engine` 的实时分析器，并把 `data/official` 的设施名录、对口地段表与排除清单交给引擎（`src/live.ts` 把 `EngineError` 转成 `AnalyzeError`，保留错误码和中文说明）；没有可用 Key 时继续使用回放。

实时分析器与 `@zoudedao/baidu` 的对接约定（`@zoudedao/engine` 已按此实现，自己写分析器时参照）：

1. 开始前先预留配额：`const budget = client.ledger.reserve(plan)`。抛出 `BaiduQuotaError` 时转成 `new AnalyzeError('quota_exhausted', err.message)`，由路由推送 `error` 事件。
2. 每次调用都传 `{ budget, signal }`（`signal` 即 `analyze()` 的第三个参数，请求关闭时触发），并在 `finally` 里调用 `budget.release()`。
3. 配额更新转成 SSE `quota` 事件 `{ service, used, limit }`：可以在分析期间订阅 `client.ledger.onChange((service, q) => emit('quota', { service, used: q.used, limit: q.limit }))` 并在结束时退订，也可以处理客户端 `onEvent` 中 `type: 'quota'` 的事件。
4. 其他百度错误可以直接抛出（路由用 `toApiError()` 映射并去掉 URL），也可以自己转成 `AnalyzeError`。非百度的意外异常一律推送 `internal`。
5. 常用接口：`locate(client, text, { city })`（地址校验定位）、`routeMatrixWalking(..., { partial: true })`、`routePairsWalking(pairs)`（小区 → 候选设施的稀疏 OD）、`walkDistances(client, pairs, { rhoLocal })`（降级链）、`placeAround(keywords, center, { radius, maxPages })`（返回 `{ pois, capped, … }`）；`createReplayClient({ dirs })` 读取 `research/*/raw` 的录制响应，完全离线。

## 目录

```text
src/
  index.ts          入口：读取 .env、加载配置、创建百度客户端、启动服务、优雅退出
  app.ts            buildApp()：插件、路由、默认的回放分析器
  config.ts         环境变量解析与运行模式判断
  analyzer.ts       Analyzer 接口、事件类型、AnalyzeError
  replay.ts         SampleReplayAnalyzer（样例回放）
  quota.ts          QuotaProvider 与进程内账本
  samples.ts        样例目录扫描与缓存
  official.ts       官方数据（data/official/*.json）的读取：设施名录、对口地段表、排除清单
  whatif.ts         新增设施模拟：从新位置实测算路到周围小区，按口径重判（runWhatIf）
  history.ts        体检历史（SQLite / 内存）：实时结果 30 天、模拟分支、步行路线（HistoryStore）
  route.ts          步行路线证据：判定的起终点（checkPair）、已保存路线与百度（RouteBook）
  coordinates.ts    坐标输入：BD-09 直接用，GCJ-02 / WGS84 经百度 geoconv 转换并与本地公式核对
  routes/api.ts     /api/health、/api/samples、/api/analysis/:id（样例与实时结果）、/api/history、/api/analysis/:id/branches
  routes/locate.ts  /api/locate（坐标、百度 locate() 或样例检索）
  routes/analyze.ts POST /api/analyze（SSE），结果写入实时结果 LRU 与体检历史
  routes/ask.ts     POST /api/ask（SSE）：体检顾问问询
  routes/whatif.ts  POST /api/whatif：新增设施模拟（仅 live 模式），结果存为分析分支
  routes/route.ts   GET /api/route：步行路线证据
  advisor.ts        问询的数据源 ServerBackend、实时结果（LiveResults：LRU + 体检历史）、大模型超时改用模板
  web.ts            静态托管与 SPA 回退
  security.ts       安全响应头、CORS
  rate-limit.ts     全局限流
  errors.ts         统一错误格式
  redact.ts         日志打码
test/               vitest + fastify.inject，不访问网络
scripts/            数据脚本（不随服务打包，经缓存与配额账本调用百度，见下）
```

### 数据脚本

在 `apps/server` 下运行，Key 只由 node 从 `.env.local` 读入；所有百度调用都走 `BAIDU_CACHE_PATH` 的缓存与配额账本，开始和结束时打印与 `/api/health` 相同口径的当日用量及增量。`--dry-run` 只读缓存的一份拷贝，列出实时运行需要新请求什么，不发任何请求、不记账。

```bash
cd apps/server
# 用当前引擎重跑保存的实时样例（默认 zj-b、zj-c、zj-v；同一中心点、标签与画像，融合 data/official 的名录、对口地段表与排除清单）
node --env-file=../../.env.local --conditions=source --import tsx scripts/refresh-live-samples.ts --dry-run
node --env-file=../../.env.local --conditions=source --import tsx scripts/refresh-live-samples.ts [zj-b …] [--max-place 12] [--max-routes 300]
# 精选样例 zj-a：中文说明、排除清单、对口小学、灰色区域、民生设施与 facility_stats；重复运行结果不变
node --env-file=../../.env.local --conditions=source --import tsx scripts/augment-zj-a.ts [--dry-run | --offline]
# 为官方设施名录补充地理编码坐标（只处理还没有 bd09 的条目，按 --towns 的街镇优先，最多 --max 次）
node --env-file=../../.env.local --conditions=source --import tsx scripts/geocode-official.ts [--only <名录 id>] [--towns 张江镇,北蔡镇] [--max 150] [--dry-run]
# 预取样例已核实伪覆盖判定的步行路线（GET /api/route 的证据），写入 data/samples/routes/<样例 id>.json
node --env-file=../../.env.local --conditions=source --import tsx scripts/prefetch-routes.ts [--max 40 | --dry-run | --cached-only]
```

- `refresh-live-samples.ts` 在可能超出 `--max-place` 页地点检索或 `--max-routes` 条批量算路（默认 12 / 300）之前停下，不写入文件（`--max-place 0` 表示地点检索只用缓存：从缓存的拷贝作答，遇到没有缓存的检索即停）；打印每个样例的判定计数、对口小学匹配数，以及与原文件相比有变化的每一项赛题口径判定。2026-09-28 第二次重跑（加入对口小学、小学与社区卫生名录、排除清单）只多用了 3 条批量算路（zj-v 的对口小学），地点检索 0 页；三个样例的赛题口径判定与原文件逐项相同。
- `augment-zj-a.ts` 的步骤（`--offline` 只做不需要调用百度的 1、2、4、6、8，第 2 步的补算读 `bv_nearest_A.json`）：1 把构建脚本留下的英文说明改为中文（同样的事实）；2 按 `data/official/exclusions.json` 去掉育华学校(雪英校区)，并用 core `mergeMatrixResults` 从研究路线（`research/zhangjiang/raw/bv_blind_A_*.json`、`bv_official_markets_A.json`）重算赛题口径判定，打印每一处变化（本次只有申城佳苑三期A块小学的最近直线距离 1,043.8 → 1,112.2 米，仍为盲区）；研究阶段只算到离片区中心最近的 3–4 家候选，所以再补算入口直线比已测最短步行更近、却从未算过路的设施（core `planNearestTopUp`，答案存入 `research/zhangjiang/raw/bv_nearest_A.json`，有变化才重写）；3 用实时引擎在同一中心的“生鲜超市$幼儿园”检索（缓存）补充生鲜超市；4 删除旧版写入的国标口径字段（`checks_gb`、`stats.community_status_counts_gb`、`stats.fresh_alternatives_gb` 及其说明）；5 对口小学（引擎的 `runCatchment`，复用研究路线中到孙桥小学两个校区的路线，0 条新路线）；6 灰色区域；7 民生设施并集（缓存）；8 `facility_stats` 与判定计数。
- 2026-09-28 第三次重跑（排除清单增加按名称规则剔除前置仓）：四个样例都只用缓存，配额 0；变化只有 zj-a 去掉 叮咚买菜(孙桥站)、zj-b 去掉 每日优鲜(唐镇店)（`stats.excluded`、`meta.notes` 的排除清单一句、`facility_stats` 与 `facility_counts` 中生鲜超市各少一家）；判定计数不变。
- 2026-09-29 最近设施补算（找到覆盖即停之后，再补算入口直线比已测最短步行更近的设施）：`refresh-live-samples.ts --max-place 0 --max-routes 150` 用了 49 条批量算路（zj-b 31、zj-c 2、zj-v 16），地点检索 0 页；`augment-zj-a.ts` 用了 17 条。赛题口径：zj-a 5 项药店判定改经实际最近的药店，原来 2 项待核实（川杨新苑四期 1,031 m、虹御公寓 1,124 m，均为上界）核实为覆盖（192 m、797 m），计数变为覆盖 28 / 伪覆盖 7 / 盲区 1、待核实 0；zj-c 张江M TOWN、绿地MTOWN 的药店步行缩短（925 → 807 m、913 → 818 m），仍为覆盖；zj-b、zj-v 只去掉了上界标记。四个样例都不再有 `unrouted_nearer`；已核实伪覆盖的经由设施没有变化，`data/samples/routes` 不用重取。
- `prefetch-routes.ts` 取四个样例的全部已核实伪覆盖，用 `src/route.ts` 的 `checkPair()` 得到与服务端相同的起终点，经缓存与配额账本调用轻量步行路线，在可能超出 `--max` 次（默认 40）之前停下；文件里已有的路线原样保留（旧版只为国标口径取的路线除外，重写时去掉），重跑结果不变。`--cached-only` 只写缓存里已有的，不发任何请求。2026-09-28 用了 40 次轻量步行路线，赛题口径的 31 项全部取到。
- `geocode-official.ts` 只处理设施名录（`kind` 为空或 `facilities`），跳过对口地段表与排除清单；地理编码落在区县范围外的结果拒收，其余保留精度标记。2026-09-28 为社区卫生名录 46 家、小学名录 100 个校区（张江镇及北蔡、花木、唐镇、川沙、康桥、金桥的学校和民办学校优先）补了坐标，小学名录另有 163 个校区待补。

## 测试

```bash
pnpm --filter @zoudedao/server test
```

测试只使用样例模式、临时目录和注入的假分析器、假路由（`POST /api/whatif`）与假步行路线（`GET /api/route`），不调用百度接口，也不读取任何 Key。体检历史默认只在内存中（`test/helpers.ts` 的 `historyPath: null`），`test/history.test.ts` 与 `test/route.test.ts` 用临时目录里的 SQLite 文件验证 WAL、重启后按编号取回、30 天过期、分支与路线永久保存。问询的大模型模式用脚本化的假 OpenAI 接口（桩 `fetch`）测试：工具调用、编造数字触发修正、修正失败改用模板、模型超时、客户端断开与服务关闭。
