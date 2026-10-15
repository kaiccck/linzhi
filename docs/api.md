# 走得到 API 约定（v0）

服务端（`apps/server`，默认端口 8787）与 Web（`apps/web`，开发端口 5173，`/api` 代理到服务端）之间的接口。数据结构以 `packages/core/src/types.ts` 的 `AnalysisResult` 为准。字段沿用 snake_case，与 `data/samples/*.json` 保持一致。

## 运行模式

| 模式     | 触发条件                                                                       | 行为                                                |
| -------- | ------------------------------------------------------------------------------ | --------------------------------------------------- |
| `sample` | 未配置服务端 Key，或 `ZDD_MODE=sample`                                         | 只提供 `data/samples/` 里的样例社区，不调用百度接口 |
| `live`   | 配置了 `BAIDU_SERVER_AK`，并配置了 `BAIDU_SERVER_SK` 或 `BAIDU_SERVER_AUTH=ip` | 可以分析任意中心点；结果写入缓存                    |

## 接口

### `GET /api/health`

```json
{
  "ok": true,
  "mode": "sample",
  "version": "0.1.0",
  "advisor": { "mode": "template" },
  "quota": { "place": { "used": 3, "limit": 100 } }
}
```

`quota` 是当日各服务的用量账本。`sample` 模式下可以为空对象。

`advisor` 说明 `POST /api/ask` 由谁组织回答：`{ "mode": "template" }`（未配置大模型，模板回答），或 `{ "mode": "llm", "model": "ernie-5.1" }`（只给模型名，不含 Key 和接口地址）。

`live` 模式下另有 `analyzer` 字段：为 `"replay"` 时，`POST /api/analyze` 回放的是样例 `zj-a`（实时分析器接入前），界面应标注"样例回放"。接入百度客户端后，`quota` 的每一项还包含 `remaining`、`soft_limit`（90%，超过后拒绝新的冷启动调用）、`reserved`、`in_flight`、`calls`、`failed`、`exhausted` 和可选的 `exhausted_reason`。

### `GET /api/samples`

返回可回放的样例列表：

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

返回一次分析的完整 `AnalysisResult`：样例 id（`zj-a`），或实时体检的 `meta.analysis_id`（`live-<8 位十六进制>`）。实时结果写入服务端的体检历史（SQLite，保存 30 天，见下节），服务重启后仍能按编号取回。支持 `Accept-Encoding: gzip` 与 `ETag` / `If-None-Match`（304；实时结果的 ETag 为 `W/"live-…"`，同一编号的内容不会变）。不存在时返回 404 `not_found`：样例为“样例不存在”，实时编号为“实时体检结果不存在或已过期，请重新体检”。老年人画像（`~elder`）不在这里生成，由客户端按步速换算。

### `GET /api/history`

地区下拉框的数据：最近 20 次实时体检（新的在前），加上内置样例（`sample: true`，按样例目录顺序）。每次完成的实时体检（`POST /api/analyze` 的 `result`，回放分析器的结果除外）都写入体检历史，保存 30 天；`ZDD_HISTORY_PATH=off` 时只保存在内存中，重启后清空（`persistent: false`）。历史对所有访客可见（体检的都是公共地点，不含个人信息）。

```json
{
  "items": [
    {
      "id": "live-1a2b3c4d",
      "sample": false,
      "created_at": "2026-09-28T12:31:05.120Z",
      "center_bd09": [121.61, 31.2],
      "label": "海科路 × 学林路",
      "profile": "adult",
      "rules": "task",
      "name": "学林路片区",
      "headline": { "communities": 20, "area_iso15_km2": 1.9, "overstate_x": 1.83, "…": "…" }
    },
    {
      "id": "zj-a",
      "sample": true,
      "created_at": "2026-09-26T10:24:38.790Z",
      "center_bd09": [121.644195, 31.19007],
      "label": "孙环路 × 高木桥路",
      "profile": "adult",
      "rules": "task",
      "name": "申城佳苑片区",
      "headline": {
        "communities": 12,
        "area_iso15_km2": 1.857,
        "area_circle15_km2": 3.483,
        "overstate_x": 1.88,
        "walking_gaps": 8,
        "pseudo": 7,
        "blind": 1,
        "pending": 2
      }
    }
  ],
  "persistent": true,
  "retention_days": 30
}
```

| 字段                            | 说明                                                                                                                                  |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `items[].id`                    | 可直接用于 `GET /api/analysis/:id`、`POST /api/ask`、`POST /api/whatif`、`GET /api/route` 的分析编号                                  |
| `items[].sample`                | `true`：内置样例；`false`：实时体检                                                                                                   |
| `items[].created_at`            | 实时体检写入历史的时间；样例为 `meta.generated`（ISO 8601）                                                                           |
| `items[].label`                 | 体检时输入的中心点标注（样例为 `meta.center_label`），可能为 `null`                                                                   |
| `items[].profile` / `rules`     | 体检时的画像（`adult`、`elder`）与口径（始终为 `task`，赛题 1 km，为兼容旧客户端保留）                                                |
| `items[].headline`              | `communities` 小区数；`area_iso15_km2`、`area_circle15_km2`、`overstate_x` 同 `stats`（可为 `null`）                                  |
| `headline.walking_gaps` 等      | `checks` 中已核实的缺口：`walking_gaps` = `pseudo`（伪覆盖）+ `blind`（盲区）；`pending` 待核实（不计入缺口）。计数方式与问询工具相同 |
| `persistent` / `retention_days` | 历史是否写入文件（重启后仍在）与保存天数                                                                                              |

### `GET /api/analysis/:id/branches`

一次分析上做过的新增设施实测模拟（`POST /api/whatif`）：每次成功的模拟都保存为这次分析的一个“分支”，新的在前，最多 50 条，保存 30 天。同一分析、类别、口径和位置（精确到 1e-6°）的模拟只保留最新一次；旧版按国标口径（`rules: "gb50180"`）保存的分支不再列出。`:id` 可带 `~elder`（与原分析相同）。

```json
{
  "analysis_id": "zj-a",
  "branches": [
    {
      "id": "wi-5c1d2e3f",
      "created_at": "2026-09-28T12:40:00.000Z",
      "analysis_id": "zj-a",
      "category": "药店",
      "rules": "task",
      "rule_m": 1000,
      "site_bd09": [121.645361, 31.19485],
      "measured": [
        {
          "community": "川杨新苑四期",
          "straight_m": 120,
          "route_m": 132,
          "dur_s": 111,
          "before": "待核实",
          "after": "覆盖"
        }
      ],
      "newly_covered": ["川杨新苑四期"],
      "skipped": [],
      "quota": { "routes": 12, "cached": 0 }
    }
  ]
}
```

分支就是 `POST /api/whatif` 的响应，加上 `id`（`wi-<8 位十六进制>`，与那次响应的 `branch_id` 相同）和 `created_at`。分析不存在或已过期时返回 404 `not_found`；样例模式下（没有做过实测模拟）为空数组。

### `GET /api/locate?q=<地址、地名或坐标>&city=<城市>&crs=<坐标系>`

把地址、地名或坐标解析成候选中心点，供搜索框、MCP Server 和 AI 顾问使用。`city` 可省略，默认 `上海市`。`q` 是坐标时见下文「坐标输入」。

- `live` 模式且百度 Key 可用：调用 `@zoudedao/baidu` 的 `locate()`，依次做地理编码、逆地理编码核对区县、地点检索兜底，最多 3 次调用（技术设计文档 §4.6）。相同的 `(q, city)` 在内存中缓存 10 分钟。
- `sample` 模式（以及 `ZDD_MODE=live` 但没有可用 Key 时）：不调用百度接口，只在样例社区的名称和中心点标注中查找（忽略大小写和空格）。候选的 `source` 为 `sample` 并带 `sample_id`，没有命中时 `candidates` 为空数组。

```json
{
  "query": "AI小镇服务中心",
  "city": "上海市",
  "best": {
    "name": "AI小镇服务中心",
    "address": "海科路1650号",
    "center_bd09": [121.624269, 31.19307],
    "source": "place_region",
    "confidence": 0.75,
    "reason": "地点检索命中同名地点“AI小镇服务中心”",
    "uid": "…"
  },
  "candidates": [{ "…": "best 在前，其余候选另带 distance_to_best_m" }],
  "needs_confirmation": false,
  "warnings": []
}
```

| 字段                              | 说明                                                                                                     |
| --------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `candidates[].source`             | `geocoding`、`place_region`、`sample` 或 `coordinate`（坐标输入）                                        |
| `candidates[].confidence`         | 0–1。≥ 0.6 可以直接使用；样例命中为 1                                                                    |
| `candidates[].reason`             | 中文判定依据，可以显示在候选旁边                                                                         |
| `candidates[].distance_to_best_m` | 与 `best` 的直线距离（米）。`best` 自身没有这个字段                                                      |
| `candidates[].uid` / `sample_id`  | 百度 POI uid（地点检索命中时）/ 样例 id（`sample` 模式）                                                 |
| `needs_confirmation`              | 为 `true` 时应在地图上列出候选，让用户确认（没有结果、最高置信度低于 0.6，或前两名置信度接近但相距较远） |
| `warnings`                        | 次要查询失败等中文提示，结果仍然可用                                                                     |

错误（含义见下文「错误码」）：`q` 为空或超过 60 个字符、`city` 超过 20 个字符、`crs` 不是 `bd09`/`gcj02`/`wgs84`、坐标不在中国范围内时返回 400 `invalid_input`；百度侧错误返回 `quota_exhausted`（429）、`auth`（503）或 `upstream`（502）；单次查询超过 20 秒返回 504 `timeout`；每个 IP 每分钟最多 30 次，超出返回 429 `rate_limited`。响应里不会出现 Key 或上游请求 URL。

#### 坐标输入

`q` 恰好是两个数时按坐标处理，**不做地理编码**：

- 写法：`121.644195,31.19007`、`121.644195 31.19007`、全角逗号与全角数字、`、` `;` 分隔、外加方括号或圆括号都可以；每个数最多 3 位整数（`1650 20` 仍按地址检索）。中国的经度 72.004–137.8347 与纬度 0.8293–55.8271 不重叠，所以 `31.19007,121.644195` 按“纬度, 经度”识别。两个数、但两种顺序都不在中国范围内：400 `invalid_input`（“坐标不在中国范围内…”）。
- `crs`：`bd09`（默认，百度地图坐标）、`gcj02`（高德、腾讯地图）、`wgs84`（GPS、OpenStreetMap）；只对坐标生效，地址检索忽略它。
- `live` 模式：`bd09` 直接使用（`converted_via: "none"`，不调用接口）；`gcj02`/`wgs84` 调用百度坐标转换（geoconv/v2，结果缓存 30 天，计入坐标转换配额 5,000 次/日），并与公开的本地转换公式交叉核对，相差超过 10 米时在 `warnings` 里提示并采用百度结果（`converted_via: "baidu_geoconv"`）；百度坐标转换失败（配额、Key、网络、超时）时改用本地公式（`converted_via: "local"`）并在 `warnings` 里说明。
- `sample` 模式：只用本地公式（`none` 或 `local`），`warnings` 注明样例模式。
- 总是一个候选、`needs_confirmation: false`：

```json
{
  "query": "31.187，121.62",
  "city": "上海市",
  "best": {
    "name": "坐标 121.620000, 31.187000",
    "center_bd09": [121.630788, 31.190432],
    "source": "coordinate",
    "crs": "wgs84",
    "converted_via": "baidu_geoconv",
    "confidence": 1,
    "reason": "输入的是 WGS84（GPS、OpenStreetMap）坐标，经百度坐标转换服务转为 BD-09，与本地公式相差 0.7 米；按“纬度, 经度”的顺序识别"
  },
  "candidates": [{ "…": "与 best 相同" }],
  "needs_confirmation": false,
  "warnings": []
}
```

| 字段                 | 说明                                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------------ |
| `best.name`          | `坐标 <经度>, <纬度>`：输入的坐标（按经度、纬度，6 位小数），不是转换后的                              |
| `best.center_bd09`   | 转换后的 BD-09 `[lng, lat]`（6 位小数），直接用作 `POST /api/analyze` 的 `center_bd09`                 |
| `best.crs`           | 输入坐标的坐标系                                                                                       |
| `best.converted_via` | `none`（BD-09，未转换）、`baidu_geoconv`（百度坐标转换）或 `local`（本地公式：样例模式或百度转换失败） |
| `best.sample_id`     | 可选：中心点 100 米内有样例时给出，可以直接打开样例而不消耗配额                                        |
| `warnings`           | 百度与本地公式相差超过 10 米、百度转换失败改用本地公式、样例模式等中文提示                             |

### `POST /api/analyze`（仅 `live` 模式）

请求体：

```json
{ "center_bd09": [121.644195, 31.19007], "label": "孙环路 × 高木桥路", "profile": "adult" }
```

可选字段 `browser_pois`：地图前端用 JSAPI `LocalSearch.searchNearby` 在中心 2.1 公里内按小学、菜市场、菜场、农贸市场、生鲜市场、生鲜超市、药店、药房、蔬菜、果蔬、生鲜、超市检索到的设施，`[{ "uid": "24 位十六进制", "name": "不超过 60 字", "keyword": "不超过 10 字", "bd09": [lng, lat] }]`，最多 400 项（请求体上限 192 KB）；不合法的项直接丢弃，不影响请求，字段本身不是数组时返回 400 `invalid_input`。百度服务端地点检索会漏掉一些设施（如万科翡翠公园附近的盒马鲜生），服务端只对检索没有返回、在设施检索半径内的 uid 调用 place/v3/detail（每次 10 个，计入地点检索配额，个人版每次体检最多 5 次，当天配额紧张时最先放弃），按百度标签与检索结果一起清洗，餐饮、只卖水果的店和线上买菜的前置仓照常剔除；补充进来的设施带 `found_by: "jsapi"`，统计在 `stats.browser_pois`（`offered`、`new`、`detailed`、`kept`、`budget_limited`）。每次请求都重新分析，没有按中心点复用的结果，带与不带 `browser_pois` 的结果不会互相顶替。

响应为 `text/event-stream`，按阶段推送事件：

| 事件      | 数据                                                                                                                                            | 说明                   |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| `stage`   | `{ "stage": "locate" \| "facilities" \| "seed" \| "paths" \| "refine" \| "reach" \| "coverage" \| "report", "message": "…", "progress": 0.35 }` | 阶段进度               |
| `partial` | `AnalysisResult` 的部分字段（如 `field`、`contours`、`samples`）                                                                                | 可以提前渲染的中间结果 |
| `quota`   | `{ "service": "routematrix_walking", "used": 312, "limit": 5000 }`                                                                              | 配额账本更新           |
| `result`  | 完整 `AnalysisResult`                                                                                                                           | 结束                   |
| `error`   | `{ "code": "quota_exhausted" \| "auth" \| "upstream" \| "invalid_input" \| "timeout" \| "internal", "message": "…" }`                           | 结束                   |

`sample` 模式下调用这个接口，返回 409：`{ "error": "live_mode_disabled" }`。

- `result` 的 `meta.analysis_id`（可选，如 `live-1a2b3c4d`）是这次结果在服务端的编号：结果写入体检历史（SQLite `data/cache/analyses.sqlite`，保存 30 天，服务重启后仍在），`GET /api/analysis/:id`、`GET /api/history`、`POST /api/ask`、`POST /api/whatif`、`GET /api/route` 都用这个编号。同一中心点、画像和生成时间得到同一编号；超过 30 天后编号失效（`ZDD_HISTORY_PATH=off` 时只在内存中保留最近 20 个，重启后失效）。旧版服务端没有这个字段，客户端不能依赖它。
- `partial` 中出现的每个字段都是该字段当前的完整值，客户端按 `{ ...prev, ...partial }` 浅合并即可。
- **圈内设施统计**：`stats.facility_stats` 是 `@zoudedao/core` 的 `facilityStats(result)`（成人 1.17 m/s）：每类设施（小学、幼儿园、菜市场、生鲜超市、超市、药店、社区卫生、养老、公交、地铁、公园）一项 `{ category, found, walk, circle, nearest_s, nearest? }`——清单数、15 分钟步行可达数（入口处耗时 ≤ 900 秒）、直线 15 分钟圆内数、最近一处的步行秒数。菜场摊位并入菜市场，同一地铁站或公交站的各出入口算一处。它在 `reach` 阶段随等时圈的 `stats` 一起推送；老年人视图由客户端用 `facilityStats(result, { scale: 1.17 / 0.9 })` 换算。检索页数用完时 `stats.facility_inventory[category].complete` 为 `false`，`radius_m` 是清单完整的半径，数量是下限。社区卫生、养老、地铁、公园、超市、公交来自一次“民生设施”地点检索（半径 1.1 公里，最多 2 页）。
- **灰色区域**：`gray_areas` 是按最近小区的已核实判定栅格化的“缺至少 n 类必需设施”（`kind: "gap"`，`min_missing` = n）与“有伪覆盖”（`kind: "pseudo"`）范围，外环逆时针、孔洞顺时针，`meta` 说明孔洞归属，`area_m2` 为面积。实时模式没有小区轮廓，每个出入口代表周围 250 m；样例 `zj-a` 按 OSM 小区轮廓生成。
- **对口小学**：分析中心所在区县、街镇被官方对口地段表覆盖时（目前为浦东新区张江镇，`data/official/pudong-catchment-2025.json`），匹配上的小区带 `catchment`：`{ school, school_uid?, route_m, dur_s, straight_m, source, matched_by, note? }`——对口学校（官方名称）、从小区出入口到学校校门的百度步行距离（未测到时为 `null`）、直线距离（学校没有坐标时为 -1）、名录 id、匹配方式 `方法:依据`（`lane:顺和路60弄` 弄号、`name:申城佳苑一期A块` 小区名、`phase:…` 名称缺期或块、`base:…` 名称去掉期或块后所有条目对口同一所学校）和中文说明（如对口表未写校区时取步行较近的校区）。对口学校不一定是最近的学校。匹配统计在 `stats.catchment`（`communities`、`matched`、`by_method`、`unmatched`、`ambiguous`、`routed`、`new_routes`、`school_not_found`），`meta.notes` 有一句中文小结；未匹配的小区没有 `catchment` 字段。
- **官方名录与排除清单**：设施名录（浦东标准化菜市场、2026 年浦东小学招生名单、市卫健委社区卫生服务中心）与百度 POI 融合：确认的 POI 带 `official`，百度没返回的按官方地址补充（`source: "gov"`），逐份计数在 `stats.official`。`stats.excluded` 列出按 `data/official/exclusions.json` 剔除的百度 POI（`{ uid, name, category, reason, source, date, pattern? }`）：按 uid 剔除的，如育华学校(雪英校区)（2026 年不在招生名单中）；按名称规则（`pattern`，正则表达式）剔除的，如线上买菜的前置仓 叮咚买菜(孙桥站)、每日优鲜(唐镇店)——百度标为“生鲜超市”，会被误当作买菜替代，但它们只接线上订单、配送到家。名称规则只写前置仓、配送站（叮咚买菜、美团买菜、小象超市的“××站”、每日优鲜），盒马鲜生、叮咚奥莱、小象超市线下门店等真实门店不受影响；`category` 是被剔除 POI 原来的类别。
- 每个事件是一行 `event`、一行单行 JSON 的 `data`，再加一个空行；每 15 秒还有一行 `: ping` 注释用于保活。`EventSource` 不支持 POST，请用 `fetch` 读取流。
- 流开始之前的错误以普通 JSON 返回：请求体不合法 400 `invalid_input`，超出频率（每个 IP 每小时 6 次）429 `rate_limited`，同时进行的分析过多 503 `busy`。
- 客户端断开会中止分析。单次分析超过 180 秒以 `error` 事件 `timeout` 结束，服务重启时以 `internal` 结束。

### `POST /api/whatif`（仅 `live` 模式）

模拟“在某处新增一家小学/菜市场/药店”，用**实测路线**重判周围小区：从新设施位置出发做一次批量算路（1 × N，最多 30 条路线），终点是直线距离不超过判定距离 × 1.5 的每个小区（`communities[].centroid`：实时结果是小区出入口，`zj-a` 是 OSM 轮廓几何中心），再按赛题口径（步行 1 km）给出每个小区该类设施的前后状态。Web 的即时估算（绕行系数场 L̂）仍由前端算；这个接口给的是实测答案。

请求体（JSON，不超过 4 KB）：

| 字段          | 要求                                                                                                |
| ------------- | --------------------------------------------------------------------------------------------------- |
| `analysis_id` | 必填，样例 id（`zj-a`）或实时结果的 `meta.analysis_id`（`live-…`，服务端保存 30 天）；可加 `~elder` |
| `category`    | 必填，`小学`、`菜市场` 或 `药店`                                                                    |
| `site_bd09`   | 必填，新设施位置，BD-09 `[经度, 纬度]`，须在中国范围内                                              |
| `rules`       | 可选，只能是 `task`（赛题 1 km，依据 `checks`），为兼容旧客户端保留；其他值 400 `invalid_input`     |

```json
{ "analysis_id": "zj-a", "category": "药店", "site_bd09": [121.645361, 31.19485], "rules": "task" }
```

响应 200（2026-09-28 在样例 `zj-a` 实测：川杨新苑四期东侧 120 米新增一家药店；共 12 个小区在 1.5 公里内，这里只列前两个）：

```json
{
  "analysis_id": "zj-a",
  "category": "药店",
  "rules": "task",
  "rule_m": 1000,
  "site_bd09": [121.645361, 31.19485],
  "measured": [
    {
      "community": "川杨新苑四期",
      "straight_m": 120,
      "route_m": 132,
      "dur_s": 111,
      "before": "待核实",
      "after": "覆盖"
    },
    {
      "community": "川杨新苑三期",
      "straight_m": 465.8,
      "route_m": 706,
      "dur_s": 601,
      "before": "覆盖",
      "after": "覆盖"
    }
  ],
  "newly_covered": ["川杨新苑四期"],
  "skipped": [],
  "quota": { "routes": 12, "cached": 0 },
  "branch_id": "wi-5c1d2e3f"
}
```

| 字段               | 说明                                                                                                                                                                                                                                         |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `measured[]`       | 每个算了路的小区：到新设施的直线距离、实测步行距离与耗时（百度没有路线时为 `null`），按步行距离排序                                                                                                                                          |
| `before` / `after` | 该类设施在赛题口径下的状态：`覆盖`、`伪覆盖`、`盲区`、`临界`，未核实时为 `待核实`。`after` 由 core `withNewFacility()` 判定：实测步行在判定距离内即覆盖；否则保留原判定已证明的部分（待核实仍待核实），只有直线距离可能缩短（盲区 → 伪覆盖） |
| `newly_covered`    | 之前不是“已核实覆盖”、之后是的小区                                                                                                                                                                                                           |
| `skipped`          | 在判定距离 × 1.5 内、但超出 30 条路线上限而没有算路的小区（先算有缺口的小区，再按距离由近到远）                                                                                                                                              |
| `quota`            | 本次百度计费的路线数（命中缓存不计）与命中缓存的路线数                                                                                                                                                                                       |
| `branch_id`        | 这次模拟保存为分析分支的编号（`GET /api/analysis/:id/branches`）；同一分析、类别、口径和位置的模拟得到同一编号。保存失败时没有这个字段                                                                                                       |

错误：`sample` 模式（以及 `ZDD_MODE=live` 但没有可用 Key 的回放模式）返回 409 `live_mode_disabled`（不检查请求体）；请求体不合法 400 `invalid_input`（`message` 指出字段，坐标不在中国范围内同样是 400）；分析不存在或实时结果已过期 404 `not_found`；结果没有小区判定时 400 `invalid_input`；百度侧错误 `quota_exhausted`（429）、`auth`（503）、`upstream`（502）；超过 20 秒 504 `timeout`；每个 IP 每 10 分钟最多 10 次，超出 429 `rate_limited`。客户端断开会中止未完成的百度调用。

### `GET /api/route?analysis_id=&community=&category=&rules=`（或 `from=&to=`）

步行路线证据：一个小区某类设施的判定所依据的真实步行路线——从小区（实时结果是小区出入口，`zj-a` 是 OSM 轮廓几何中心，即判定算路的起点）走到判定经由的设施（`via`，终点是设施入口，与判定算路相同），由百度地图轻量步行路线（directionlite，`steps_info=1`）经缓存与配额账本获取。每对起终点（精确到 1e-5°）只调用一次百度，之后**永久保存**在体检历史中；四个样例已核实伪覆盖判定的路线已预先取好（全部 31 项），随样例保存在 `data/samples/routes/<样例 id>.json`，演示和样例模式都不用等待。

| 参数          | 要求                                                                                                                                               |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `analysis_id` | 样例 id 或实时结果的 `meta.analysis_id`，可加 `~elder`（地点相同）                                                                                 |
| `community`   | 小区名（完全一致，其次忽略空格与括号），或地图编号（`A-01`，见 `POST /api/ask` 的 `anchors`）                                                      |
| `category`    | `小学`、`菜市场` 或 `药店`                                                                                                                         |
| `rules`       | 可选，只能是 `task`（依据 `checks`），为兼容旧客户端保留；其他值 400 `invalid_input`                                                               |
| `from`、`to`  | 代替 `community`、`category`：两个 BD-09 坐标“经度,纬度”（如 `121.644195,31.19007`），直线距离不超过 3 km；可同时给 `analysis_id` 以得到 `path_xy` |

```text
GET /api/route?analysis_id=zj-a&community=川杨新苑四期&category=菜市场
```

响应 200（样例 `zj-a`，菜市场的伪覆盖：直线 733.7 米，步行 1,281 米；`path_bd09` 与 `path_xy` 各 43 个点，这里只列前三个）：

```json
{
  "analysis_id": "zj-a",
  "community": {
    "name": "川杨新苑四期",
    "code": "A-01",
    "xy": [-9, 528.5],
    "bd09": [121.6441, 31.19485]
  },
  "facility": {
    "name": "浦商生鲜(申城佳苑店)",
    "uid": "123b8352ba8ce94c9ee321b9",
    "category": "菜市场",
    "xy": [269.5, -150.3],
    "bd09": [121.647025, 31.188711],
    "entrance_xy": [245.3, -154]
  },
  "category": "菜市场",
  "rules": "task",
  "check": {
    "status": "伪覆盖",
    "status_main": "伪覆盖",
    "verified": true,
    "route_m": 1281,
    "straight_m": 733.7,
    "rule_m": 1000,
    "via": "浦商生鲜(申城佳苑店)"
  },
  "from_bd09": [121.6441, 31.19485],
  "to_bd09": [121.646771, 31.188677],
  "path_bd09": [
    [121.643927, 31.194963],
    [121.643917, 31.194993],
    [121.643848, 31.195292]
  ],
  "path_xy": [
    [-25.5, 541],
    [-26.5, 544.4],
    [-33, 577.4]
  ],
  "distance_m": 1281,
  "duration_s": 1185,
  "straight_m": 731.9,
  "source": "stored",
  "fetched_at": "2026-09-28T11:56:20.925Z"
}
```

| 字段                        | 说明                                                                                                                                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `community`                 | 小区：名称、地图编号 `code`（与 Web 相同的编号规则）、局部坐标 `xy`（`communities[].centroid`）与 BD-09。`from`/`to` 方式时为 `null`                                                  |
| `facility`                  | 判定经由的设施：名称、uid、类别、POI 位置（`xy`、`bd09`）与路线终点 `entrance_xy`（百度给出的入口，没有时同 `xy`）。`from`/`to` 方式时为 `null`                                       |
| `check`                     | 这项判定本身：四态、三态、是否核实、判定用的批量算路距离 `route_m`、到最近同类设施的直线距离 `straight_m`、判定距离 `rule_m`、经由设施。`from`/`to` 方式时为 `null`                   |
| `from_bd09` / `to_bd09`     | 起点、终点（BD-09，6 位小数）                                                                                                                                                         |
| `path_bd09`                 | 百度步行路线的折线（BD-09 `[lng, lat]`）；首末点是百度吸附到路网上的点，与起终点相差几米到几十米                                                                                      |
| `path_xy`                   | 同一折线在分析局部坐标系中的米制坐标（与 `communities[].centroid`、`pois[].xy` 相同，0.1 m）；没有 `analysis_id` 时为 `null`                                                          |
| `distance_m` / `duration_s` | 这条步行路线自己的距离与耗时（轻量步行路线的耗时计入了过街等待，比 距离 / 1.17 m/s 长：31 条样例路线中位数 6.1%，最多 14.9%）；与判定的 `check.route_m`（批量算路）通常相差不到 50 米 |
| `straight_m`                | 起终点之间的直线距离（米）                                                                                                                                                            |
| `source`                    | `stored`：已保存的路线（样例预取或以前查过），没有调用百度；`baidu`：这次调用百度得到，已永久保存                                                                                     |
| `fetched_at`                | 百度返回这条路线的时间（ISO 8601）                                                                                                                                                    |

- **样例模式**（没有服务端 Key，含 `ZDD_MODE=live` 的回放模式）：已保存的路线照常返回（`source: "stored"`，四个样例已核实伪覆盖的路线全部在内）；其他路线返回 409 `live_mode_disabled`。
- 错误：参数缺失或不合法 400 `invalid_input`（`message` 指出字段；`from`/`to` 与 `community`/`category` 不能同时给；两点直线超过 3 km；`rules` 不是 `task`）；分析不存在或已过期、小区不存在（`message` 列出可选小区）、这项判定没有算路（判定距离内没有这类设施，`route_basis` 不是 `routed`）、百度没有找到步行路线 404 `not_found`；百度侧错误 `quota_exhausted`（429）、`auth`（503）、`upstream`（502）；超过 20 秒 504 `timeout`（`ZDD_ROUTE_TIMEOUT_S`）；需要调用百度的查询每个 IP 每 10 分钟最多 30 次（`ZDD_ROUTE_PER_10MIN`；已保存的路线不计，现场评委共用一个 IP 也能随意查看），超出 429 `rate_limited`（带 `retry-after`）。客户端断开会中止未完成的百度调用。

### `POST /api/ask`

体检顾问（问询）：回答关于一次分析的问题。回答里的每个数字都来自工具结果并标注来源 `[T1]`，并经过数字溯源校验（见 `packages/agent/README.md`）。`sample` 和 `live` 模式都可用。

请求体（JSON，不超过 64 KB）：

| 字段          | 要求                                                                                                  |
| ------------- | ----------------------------------------------------------------------------------------------------- |
| `question`    | 必填，去掉首尾空白后 1–300 个字符                                                                     |
| `analysis_id` | 可选，屏幕上正在看的分析：样例 id（`zj-a`）、实时结果的 `meta.analysis_id`（`live-…`），可加 `~elder` |
| `history`     | 可选，此前的对话，最多 8 条 `{ "role": "user" \| "assistant", "content": "…" }`，每条不超过 2000 字符 |

```json
{ "question": "老人买菜方便吗？", "analysis_id": "zj-a", "history": [] }
```

- `analysis_id` 不存在（或实时结果已超过 30 天）时返回 400 `invalid_input`，流不会开始。实时结果从体检历史中读取，服务重启后仍可问询。没有给出时，问题里点名的样例或第一个样例作答。
- **问询不发起新的实时体检，也不调用百度接口**（每次体检都要消耗配额）：地点定位只在内置样例中查找；问到样例以外的新地点时，工具结果会请用户使用地图上的搜索框。
- 未配置大模型时由模板作答，配置后由大模型规划工具调用、组织语言（`LLM_BASE_URL` 等环境变量，见 `apps/server/README.md`）。大模型 45 秒内（总时限的 3/4）没有完成时改用模板回答，并推送 `fallback`。

响应为 `text/event-stream`，格式同 `POST /api/analyze`（开头立即有一行 `: ping`，之后每 15 秒一行）。事件：

| 事件          | 数据                                                                                       | 说明                                           |
| ------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| `tool_call`   | `{ "tool": "list_service_gaps", "title": "服务缺口清单", "args": { … } }`                  | 开始调用一个工具；`args` 超过 2 KB 时省略      |
| `tool_result` | `{ "tool", "title", "id": "T2", "summary": "…" }`，失败时为 `{ "tool", "title", "error" }` | 只有中文摘要（最长 20,000 字符），不含原始数据 |
| `progress`    | `{ "message": "…", "progress": 0.35 }`                                                     | 进度说明                                       |
| `repair`      | `{ "unsupported": ["1.9 倍"], "uncited": [] }`                                             | 大模型的初稿有找不到出处的数字，已要求改写     |
| `fallback`    | `{ "reason": "…" }`                                                                        | 改用模板回答及原因                             |
| `answer`      | 见下                                                                                       | 结束                                           |
| `error`       | `{ "code": "timeout" \| "internal", "message": "…" }`                                      | 结束                                           |

`answer`：

```json
{
  "answer": "结论：不太方便：申城佳苑片区 12 个小区中，有 4 个步行 1,000 m 内走不到菜市场（伪覆盖 3、盲区 1）[T2]。\n\n- …",
  "mode": "template",
  "citations": [
    {
      "id": "T1",
      "tool": "analyze_life_circle",
      "title": "生活圈体检",
      "summary": "…",
      "anchors": [{ "…": "…" }]
    },
    {
      "id": "T2",
      "tool": "list_service_gaps",
      "title": "服务缺口清单",
      "summary": "…",
      "anchors": [
        {
          "type": "community",
          "analysis_id": "zj-a~elder",
          "name": "川杨新苑四期",
          "code": "A-01",
          "xy": [-9, 528.5],
          "bd09": [121.6441, 31.19485]
        },
        {
          "type": "poi",
          "analysis_id": "zj-a~elder",
          "name": "浦商生鲜(申城佳苑店)",
          "uid": "123b8352ba8ce94c9ee321b9",
          "category": "菜市场",
          "xy": [269.5, -150.3],
          "bd09": [121.647025, 31.188711]
        },
        {
          "type": "community",
          "analysis_id": "zj-a~elder",
          "name": "川杨新苑三期",
          "code": "A-02",
          "xy": [-350.9, 468.6],
          "bd09": [121.64051, 31.194308]
        }
      ]
    }
  ],
  "grounding": { "ok": true, "checked": 26, "unsupported": [], "uncited": [] },
  "analysis_id": "zj-a~elder"
}
```

| 字段              | 说明                                                                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `answer`          | 中文回答，数字带 `[T#]` 来源；模板回答末尾有一行说明它是怎么生成的                                                              |
| `mode`            | `template` 或 `llm`                                                                                                             |
| `model`           | 配置了大模型时的模型名（模板代答时也有，说明是哪个模型没被采用）                                                                |
| `citations`       | 本轮每个工具结果：编号、工具、中文名、摘要，以及 `anchors`（见下）                                                              |
| `grounding`       | 数字溯源校验：`ok` 所有数字都有出处；`checked` 核对的数字个数；`unsupported` 找不到出处的数字；`uncited` 未标来源的数字         |
| `analysis_id`     | 回答所依据的分析（如老年人画像 `zj-a~elder`），可用于追问                                                                       |
| `attachments`     | 可选，`export_report` 生成的文件 `[{ "filename", "mime_type", "content" }]`，如 Markdown 体检报告                               |
| `repaired`        | 可选，大模型初稿未通过校验、改写后通过                                                                                          |
| `citations_added` | 可选，大模型回答里的数字都有出处、只是漏标或标错了来源编号时，系统在句末补上的编号，如 `["1.88 倍 → T1"]`（没有为此让模型重写） |
| `fallback`        | 可选，`{ "reason", "unsupported" }`：配置了大模型但改用了模板回答                                                               |

**证据锚点 `citations[].anchors`**：每个工具结果提到的地点，供 Web 在用户点击来源编号时在地图上高亮。只用于显示，不交给大模型，也不参与数字校验；没有提到具体地点的工具（等时圈、社区对比、定位、导出报告）为空数组 `[]`，每条最多 40 个。四种锚点：

| `type`      | 字段                                                           | 说明                                                                                                                                                                                       |
| ----------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `community` | `analysis_id`、`name`、`code`、`xy`、`bd09`                    | 小区。`code` 是 Web 的地图编号：按 `communities[].centroid` 由北向南、同一纬度由西向东编为 `<字母>-01`…，字母取样例 id 的末位（`zj-b` → `B`），实时结果为 `A`；`xy` 即 `centroid`（0.1 m） |
| `poi`       | `analysis_id`、`name`、`uid`、`category`、`xy`、`bd09`         | 设施（`pois[]` 中的一项，`xy` 是 POI 位置）                                                                                                                                                |
| `gray_area` | `analysis_id`、`id`、`kind`、`min_missing`、`index`、`area_m2` | 灰色区域的一层：`id` 为 `gap-1`、`gap-2`、`pseudo-1` 这样的 `<kind>-<min_missing>`，`index` 是它在 `gray_areas` 中的位置                                                                   |
| `site`      | `analysis_id`、`label`、`xy`、`bd09`                           | `simulate_facility` 模拟的新设施位置                                                                                                                                                       |

`analysis_id` 是工具读取的分析（老年人画像为 `zj-a~elder`，地点与 `zj-a` 相同，比较时去掉 `~elder`）；`xy` 是这次分析的局部米制坐标。各工具给出的锚点：`analyze_life_circle`——灰色区域各层、有已核实缺口的小区、圈内设施统计里各类最近的设施；`list_service_gaps`——每个缺口的小区及其步行能到的设施、待核实的小区（指定小区时，该小区在最前）；`simulate_facility`——新设施位置（最前）与估算能补上或满足的小区。

流开始之前的错误以普通 JSON 返回：请求体不合法 400 `invalid_input`；超出频率 429 `rate_limited`（每个 IP 每 10 分钟 30 次，配置大模型时相同——现场评委共用一个 IP；`ZDD_ASK_PER_10MIN` 可调）；同时进行的问询过多 503 `busy`。客户端断开会中止回答（包括大模型请求）；超过 60 秒以 `error` 事件 `timeout` 结束，服务重启时以 `internal` 结束。

## 约定

- **坐标：** 一律为 BD-09 经纬度 `[lng, lat]`；局部米制坐标 `XY` 的原点见 `meta.center_bd09`。
- **数据来源：** 每个数字都要能追溯到来源。实测、路径采样、估算和样例要可以区分：`TimeSample.src`、`FacilityCheck.verified`、`route_upper_bound` 已经承担了这个作用，新增字段也要遵守。
- **错误格式：** 统一为 `{ "error": "<code>", "message": "<中文说明>" }`。SSE 的 `error` 事件为 `{ "code": "<code>", "message": "…" }`。`message` 可以直接展示给用户，不含 Key 或上游 URL。

## 错误码

| 代码                     | HTTP 状态               | 出现位置                                                                                            | 含义                                                           | 客户端建议                                           |
| ------------------------ | ----------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------- |
| `invalid_input`          | 400                     | 所有接口、SSE                                                                                       | 请求参数不合法，`message` 指出字段                             | 提示用户修改输入；原样重试无效                       |
| `bad_request`            | 400                     | 所有接口                                                                                            | 其他格式错误的请求                                             | 检查客户端实现                                       |
| `forbidden`              | 403                     | 静态文件                                                                                            | 路径越出 Web 目录                                              | 无需处理                                             |
| `not_found`              | 404                     | 所有接口                                                                                            | 样例、接口或文件不存在                                         | 刷新样例列表或检查路径                               |
| `live_mode_disabled`     | 409                     | `POST /api/analyze`、`POST /api/whatif`、`GET /api/route`                                           | 服务处于 `sample` 模式（`GET /api/route` 只对未保存的路线）    | 隐藏实时分析入口，引导用户查看样例                   |
| `payload_too_large`      | 413                     | `POST /api/analyze`、`POST /api/ask`                                                                | 请求体过大                                                     | 缩短输入                                             |
| `unsupported_media_type` | 415                     | `POST /api/analyze`、`POST /api/ask`                                                                | 请求体不是 JSON                                                | 使用 `Content-Type: application/json`                |
| `rate_limited`           | 429                     | 所有接口                                                                                            | 超出按 IP 的频率限制                                           | 按响应头 `retry-after`（秒）等待后重试               |
| `quota_exhausted`        | 429                     | `GET /api/locate`、`POST /api/whatif`、`GET /api/route`、SSE                                        | 百度当日配额已用到 90% 或已用尽                                | 改用样例或已缓存的社区，北京时间次日 0 点恢复        |
| `internal`               | 500；服务重启期间为 503 | 所有接口、SSE                                                                                       | 服务端意外错误，或服务正在重启                                 | 稍后重试；持续出现请反馈                             |
| `upstream`               | 502                     | `GET /api/locate`、`POST /api/whatif`、`GET /api/route`、SSE                                        | 百度接口出错（服务异常、网络、限流重试耗尽），只用于百度侧故障 | 稍后重试                                             |
| `auth`                   | 503                     | `GET /api/locate`、`POST /api/whatif`、`GET /api/route`、SSE                                        | 百度 Key、权限或签名配置有误                                   | 提示实时功能暂不可用并引导查看样例；需要运维修正配置 |
| `busy`                   | 503                     | `POST /api/analyze`、`POST /api/ask`                                                                | 同时进行的分析或问询数已满                                     | 几秒后重试                                           |
| `timeout`                | 504                     | `GET /api/locate`、`POST /api/whatif`、`GET /api/route`（各 20 秒）、SSE（分析 180 秒、问询 60 秒） | 超过时间上限                                                   | 稍后重试；分析可以换一个中心点或先查看样例           |
