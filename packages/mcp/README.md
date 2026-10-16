# @zoudedao/mcp · 邻至 MCP Server

把“15 分钟生活圈体检”开放给任何支持 MCP 的 AI 助手：Claude Desktop、Cursor、Cherry Studio 等。助手可以直接问“申城佳苑的老人买菜方便吗”，由本服务按百度地图的**实测步行路线**给出等时圈、服务缺口、新增设施估算和体检报告。

- 基于官方 MCP TypeScript SDK v2（`@modelcontextprotocol/server` 2.1，实现 2026-07-28 协议，同时兼容 2025 年各版本的客户端）。
- 传输：**stdio**（默认，客户端启动子进程）和 **Streamable HTTP**（`--http`，端点 `/mcp`，默认只监听 `127.0.0.1`）。
- 工具与 AI 体检顾问（`@zoudedao/agent`）是**同一套注册表**：两边的结果、数字和措辞完全一致。
- 所有工具都是只读的；每个工具结果都能由分析数据（`AnalysisResult`）复现，不经过任何大模型。

## 快速开始

需要 Node.js ≥ 22.12 和 pnpm 10。不配置任何 Key 也能用：默认读取仓库自带的样例 `data/samples/zj-a.json`（上海张江申城佳苑片区，2026-09-26 百度地图实测）。

```bash
pnpm install
pnpm --filter "@zoudedao/mcp..." build        # 依次构建 core、agent、mcp
node packages/mcp/dist/cli.js --help
```

| 启动方式              | 命令                                                                                    |
| --------------------- | --------------------------------------------------------------------------------------- |
| stdio（由客户端启动） | `node <仓库>/packages/mcp/dist/cli.js`                                                  |
| Streamable HTTP       | `node <仓库>/packages/mcp/dist/cli.js --http --port 8788` → `http://127.0.0.1:8788/mcp` |
| 连接运行中的邻至服务  | 加 `--api http://localhost:8787` 或设置环境变量 `ZDD_API_URL`                           |

| 选项 / 环境变量                              | 说明                                                                                                                           |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `--api`、`ZDD_API_URL`                       | 邻至服务地址（`apps/server`）。服务端配置了百度 Key 时可以体检任意地点（约 1 分钟，逐阶段发送 MCP 进度通知）；否则只能查看样例 |
| `--samples`、`ZDD_SAMPLES_DIR`               | 样例目录；默认依次尝试仓库的 `data/samples` 和当前目录下的 `data/samples`                                                      |
| `--http`、`--port`、`ZDD_MCP_PORT`、`--host` | HTTP 模式、端口（默认 8788）和监听地址（默认 `127.0.0.1`）                                                                     |

日志只写到 stderr（stdio 模式下 stdout 是协议通道）。MCP Server 本身不持有任何百度 Key：实时分析由邻至服务完成，Key 只在服务端。

## 工具

| 工具                  | 作用                                                                                                                                                        | 主要参数                                                                                     |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `locate_place`        | 地名 → 候选中心点（BD-09）；候选不唯一时返回 `needs_confirmation`                                                                                           | `query`、`city`                                                                              |
| `analyze_life_circle` | 体检（或读取已有结果），返回 `analysis_id` 和核心数字：可达面积与直线圆、高估倍数、有效半径、各类设施的覆盖/伪覆盖/盲区、待核实数、“画圆法 vs 步行”缺口对比 | `sample_id` / `analysis_id` / `center_bd09` / `place` 四选一，`profile`（`adult` / `elder`） |
| `get_isochrone`       | 5/10/15 分钟等时圈 GeoJSON（含孔洞）+ 直线 15 分钟圆                                                                                                        | `analysis_id`、`levels`、`crs`（`wgs84` / `gcj02` / `bd09`）、`simplify`                     |
| `list_service_gaps`   | 小区 × 设施类别的服务缺口，按步行距离排序；未核实的检查单独列为“待核实”；`by_community` 每个小区一行（各类设施的判定与步行分钟）                            | `analysis_id`、`category`、`status`、`community`、`include_pending`                          |
| `simulate_facility`   | 如果在某处新增一家设施：按绕行系数场估算 L̂，哪些小区会进入判定距离。**结果一律标注“估算”**                                                                  | `analysis_id`、`category`、`center_bd09` 或 `near_community`                                 |
| `compare_sites`       | 2–4 个分析并排对比（不同社区，或同一社区的成人/老年人画像）                                                                                                 | `analysis_ids`                                                                               |
| `export_report`       | 体检报告：Markdown / GeoJSON / JSON，确定性生成                                                                                                             | `analysis_id`、`format`                                                                      |

返回格式：

- `content[0]`：中文摘要，结论先行；摘要里的每个数字都列在 `_meta["zoudedao/facts"]` 中（`{ label, value, unit }`）。
- `structuredContent`：结构化数据，每个工具都声明了 `outputSchema`。
- `export_report` 另附**内嵌资源**（`zoudedao://analysis/{id}/report.md` 等），客户端可以直接保存；`get_isochrone` 另附指向 `isochrone.geojson` 资源的 `resource_link`。
- 出错时返回 `isError: true` 和中文说明（例如“这个位置在本次分析的耗时场范围之外”）。

## 资源与提示词

| URI                                          | 内容                                                                |
| -------------------------------------------- | ------------------------------------------------------------------- |
| `zoudedao://samples`                         | 可体检的样例和本次会话里的实时 / 换算结果                           |
| `zoudedao://analysis/{id}`                   | 完整的 `AnalysisResult`（JSON，约 400 KB）                          |
| `zoudedao://analysis/{id}/report.md`         | Markdown 体检报告                                                   |
| `zoudedao://analysis/{id}/report.geojson`    | 地图数据：等时圈、小区检查结果、设施点、灰色区域、规划建议（WGS84） |
| `zoudedao://analysis/{id}/isochrone.geojson` | 步行等时圈与直线圆（WGS84）                                         |

`{id}` 可以是样例（`zj-a`）、老年人画像（`zj-a~elder`，由同一批路线按 0.9 m/s 换算）或实时结果（`live-xxxxxxxx`）。

提示词 `life_circle_check`（参数 `place`）：引导客户端模型按“定位 → 体检 → 服务缺口 → 报告”的顺序调用工具，并约束数字只能引用工具结果、待核实不是缺口、估算必须标注。

## 客户端配置

下面的 `/path/to/zoudedao` 换成本仓库的绝对路径。Windows 上写成 `C:/path/to/zoudedao/...` 或把反斜杠写成 `\\`。

### Claude Desktop

配置文件：macOS `~/Library/Application Support/Claude/claude_desktop_config.json`，Windows `%APPDATA%\Claude\claude_desktop_config.json`。修改后重启 Claude Desktop。

stdio（推荐）：

```json
{
  "mcpServers": {
    "zoudedao": {
      "command": "node",
      "args": ["/path/to/zoudedao/packages/mcp/dist/cli.js"]
    }
  }
}
```

连接运行中的邻至服务（实时体检任意地点）：在上面的配置里加 `"env": { "ZDD_API_URL": "http://localhost:8787" }`。

HTTP：Claude Desktop 的配置文件只接受 stdio 服务；可以先用 `--http` 启动本服务，再用社区工具 [`mcp-remote`](https://www.npmjs.com/package/mcp-remote) 桥接（远程连接器的添加方式请以 Claude 官方文档为准）：

```json
{
  "mcpServers": {
    "zoudedao-http": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://127.0.0.1:8788/mcp"]
    }
  }
}
```

### Cursor

全局配置 `~/.cursor/mcp.json`，或项目内 `.cursor/mcp.json`：

```json
{
  "mcpServers": {
    "zoudedao": {
      "command": "node",
      "args": ["/path/to/zoudedao/packages/mcp/dist/cli.js"]
    },
    "zoudedao-http": {
      "url": "http://127.0.0.1:8788/mcp"
    }
  }
}
```

第二项需要先运行 `node packages/mcp/dist/cli.js --http`。两项任选其一即可。

### Cherry Studio

设置 → MCP 服务器 → 添加服务器：

| 字段             | stdio                                        | Streamable HTTP                     |
| ---------------- | -------------------------------------------- | ----------------------------------- |
| 类型             | 标准输入/输出（stdio）                       | 可流式传输的 HTTP（streamableHttp） |
| 命令 / URL       | `node`                                       | `http://127.0.0.1:8788/mcp`         |
| 参数             | `/path/to/zoudedao/packages/mcp/dist/cli.js` | —                                   |
| 环境变量（可选） | `ZDD_API_URL=http://localhost:8787`          | —                                   |

也可以用“从 JSON 导入”（字段名以 Cherry Studio 当前版本为准）：

```json
{
  "mcpServers": {
    "zoudedao": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/zoudedao/packages/mcp/dist/cli.js"]
    },
    "zoudedao-http": {
      "type": "streamableHttp",
      "baseUrl": "http://127.0.0.1:8788/mcp"
    }
  }
}
```

### 试一试

配置好后，可以直接问助手：

- “申城佳苑的老人买菜方便吗？”
- “画圆法漏掉了哪些缺口？列出伪覆盖的小区。”
- “如果在申城佳苑三期B块旁边建一所小学，能补上几个缺口？”
- “导出申城佳苑的体检报告和 GeoJSON。”

## 与百度地图官方 MCP Server 的关系

百度地图官方 MCP Server 提供的是**原子能力**：地理编码与逆地理编码、地点检索、路线规划、天气与交通等，回答“这个地址在哪”“从 A 走到 B 要多久”。走得到提供的是更高一层的**生活圈体检**：用一批实测步行路线推出 5/10/15 分钟等时圈，逐个小区核对小学、菜市场、药店能否步行走到，区分覆盖、伪覆盖（画圆以为有、走路走不到）、盲区和临界，并估算新增设施的效果、生成报告。二者可以组合使用：先用官方 Server 查到地址的坐标，再交给 `analyze_life_circle` 体检；或者用官方 Server 的步行路线规划，逐条核验 `simulate_facility` 给出的 L̂ 估算，把“估算”变成“实测”。

### 组合演示：一个模型同时用两个 MCP Server（`demo/combo.ts`）

`demo/combo.ts` 是一个最小的智能体循环：大模型（DeepSeek 等 OpenAI 兼容接口，经 `@zoudedao/agent` 的客户端）同时连接两个 MCP Server——**百度地图官方 MCP**（SSE）负责地理编码、地点检索和路线规划，**邻至 MCP**（stdio，`dist/cli.js --api http://localhost:8787`）负责逐个小区核对“步行能不能走到”。两边的工具一起交给模型，调用轨迹逐步打印；最终回答经过与体检顾问相同的数字溯源校验（引用补全，再修正一次）。

```bash
pnpm --filter "@zoudedao/mcp..." build
cd packages/mcp
node --env-file=../../.env.local demo/combo.ts                    # 默认问题：学林路地铁站附近给父母找房子
node --env-file=../../.env.local demo/combo.ts "玉兰香苑附近哪些小区老人买菜方便？"
node --env-file=../../.env.local demo/combo.ts --list             # 只连接并列出两边的工具，不调用工具和模型
```

| 选项                          | 说明                                                                                                         |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `--api <地址>`                | 邻至服务，默认 `http://localhost:8787`；写 `none` 直接读仓库样例                                             |
| `--baidu-transport sse\|http` | 默认 SSE（控制台的“MCP(SSE)”服务）；`http` 为 Streamable HTTP                                                |
| `--max-baidu-calls <n>`       | 每次最多调用几次百度地图 MCP 工具，默认 5：官方工具消耗这个 AK 自己的日配额（个人认证的地点检索每天 100 次） |
| `--allow-live`                | 允许走得到对新地点实时体检（约 1 分钟、100 多次路线规划配额）；默认只用已体检的片区                          |
| `--no-baidu`                  | 不连接百度地图 MCP，只演示走得到                                                                             |

环境变量：`LLM_BASE_URL`、`LLM_API_KEY`、`LLM_MODEL`（可选 `LLM_EXTRA_BODY`）；可选的 `BAIDU_MCP_AK`（未设置、为空或仍是 `.env.example` 的占位值时用 `BAIDU_SERVER_AK`；`demo/baidu.ts` 的 `mcpAk()`）。演示开头说明用的是哪个变量，从不打印 Key 的值。

**百度地图官方 MCP 的接入方式**（2026-09-28 按官方文档核对：[MCP Server 概述](https://lbsyun.baidu.com/faq/api?title=mcpserver/base)、[快速开始](https://lbsyun.baidu.com/docs/ai?title=mcpserver%2Fquickstart)、[GitHub baidu-maps/mcp](https://github.com/baidu-maps/mcp)）：

| 传输                        | 地址                                    |
| --------------------------- | --------------------------------------- |
| SSE                         | `https://mcp.map.baidu.com/sse?ak=<AK>` |
| Streamable HTTP（官方推荐） | `https://mcp.map.baidu.com/mcp?ak=<AK>` |

- AK 须为控制台创建的**服务端** AK，并勾选 **MCP(SSE)** 服务。实测服务端为 `mcp-server-baidu-maps` 1.28.0，有 14 个工具（`map_geocode`、`map_search_places`、`map_directions`、`map_directions_matrix` 等，坐标写作“纬度,经度”）；演示只开放其中 3 个。
- 官方 Server 用裸 AK 调用各 Web 服务接口，**不带 SN 签名**：SN 校验方式的 AK 能连上、能列出工具，但第一次调用工具就会被拒（`Authentication failed: APP SN校验失败`，即 Web 服务状态码 211）；IP 白名单方式的 AK 需要允许百度自己的服务器调用。建议为 MCP 单独建一个 IP 白名单方式的服务端 AK（开通 MCP(SSE)），填到 `BAIDU_MCP_AK`，不影响邻至服务端使用的 SN 校验 AK。
- 安全：AK 只出现在连接地址里，从不打印；所有输出都先去掉 AK、`ak=…` 参数和 Bearer 令牌（`demo/baidu.ts`，有离线测试）。百度 MCP 拒绝 AK 时，演示识别错误类别（SN 校验、IP 白名单、服务未开通、Key 无效、配额），撤下百度工具，并告诉模型改用走得到、如实说明。
- 走得到这一侧只读取已有的分析：不开放 `locate_place`（经服务端会调用百度地理编码），`analyze_life_circle` 对新坐标的实时体检默认拦截。

#### 一次运行的完整轨迹（2026-09-28，deepseek-flash）

本仓库配置的 `BAIDU_SERVER_AK` 是 SN 校验方式，所以百度地图这一步被拒，演示按设计退回只用邻至 MCP：

```text
## 连接

- 百度地图官方 MCP（SSE，mcp-server-baidu-maps）：14 个工具——map_geocode、map_reverse_geocode、map_search_places、map_place_details、map_directions_matrix、map_directions、map_weather、map_ip_location、map_road_traffic、map_search_pro、map_district_search、map_uri、map_mark、map_geoconv
- 邻至 MCP（stdio，--api http://localhost:8787）：7 个工具——locate_place、analyze_life_circle、get_isochrone、list_service_gaps、simulate_facility、compare_sites、export_report
- 开放给模型的工具：map_geocode（百度地图）、map_search_places（百度地图）、map_directions（百度地图）、analyze_life_circle（走得到）、list_service_gaps（走得到）、compare_sites（走得到）
- 大模型：deepseek-flash @ api.deepseek.com

## 问：我在张江学林路地铁站附近给父母找房子，哪些小区老人步行买菜、看病都方便？

1. 模型 → [百度地图] map_geocode {"address":"学林路地铁站","city":"上海市"}
   ✗ [百度地图] map_geocode：AK 为 SN 校验方式，调用未带签名（status 211：Authentication failed: APP SN校验失败）
   ⚠ 百度地图 MCP 拒绝了这个 AK，本次改为只用邻至 MCP
1. 模型 → [走得到] analyze_life_circle {"sample_id":"zj-a","profile":"elder"}
   ← T1 申城佳苑片区（analysis_id: zj-a~elder，老年人画像；样例数据，2026-09-26 百度地图实测，按老年人步速换算）：画圆法（直线 1 km）只找到 1 个服务缺口，按实测步行距离已核实 8 个，画圆漏掉了其中 7 个（87.5%）。另有 2 项待核实，不计入缺口。15 分钟步行实际可达 1.113 km²，只有直线 15 分钟圆（2.061 km²）的 54%，画圆把可达面积高估了 1.85 倍。15 分钟有效步…
2. 模型 → [走得到] analyze_life_circle {"sample_id":"zj-b","profile":"elder"}
   ← T2 玉兰香苑片区（analysis_id: zj-b~elder，老年人画像；实时分析，2026-09-28 调用百度地图开放平台，按老年人步速换算）：画圆法（直线 1 km）只找到 4 个服务缺口，按实测步行距离已核实 21 个，画圆漏掉了其中 17 个（81%）。15 分钟步行实际可达 1.059 km²，只有直线 15 分钟圆（2.061 km²）的 51.4%，画圆把可达面积高估了 1.95 倍。15 分钟有效步行半径中位数 582…
2. 模型 → [走得到] analyze_life_circle {"sample_id":"zj-c","profile":"elder"}
   ← T3 万科翡翠公园片区（analysis_id: zj-c~elder，老年人画像；实时分析，2026-09-28 调用百度地图开放平台，按老年人步速换算）：画圆法找到 15 个缺口，按实测步行距离已核实 15 个，没有被画圆漏掉的。15 分钟步行实际可达 1.294 km²，只有直线 15 分钟圆（2.061 km²）的 62.8%，画圆把可达面积高估了 1.59 倍。15 分钟有效步行半径中位数 625.5 m，而直线圆半径是 810 m…
2. 模型 → [走得到] analyze_life_circle {"sample_id":"zj-v","profile":"elder"}
   ← T4 AI小镇服务中心周边（analysis_id: zj-v~elder，老年人画像；实时分析，2026-09-28 调用百度地图开放平台，按老年人步速换算）：画圆法（直线 1 km）只找到 6 个服务缺口，按实测步行距离已核实 13 个，画圆漏掉了其中 7 个（53.8%）。15 分钟步行实际可达 0.686 km²，只有直线 15 分钟圆（2.061 km²）的 33.3%，画圆把可达面积高估了 3.00 倍。15 分钟有效步行半径中位…
3. 模型 → [走得到] list_service_gaps {"analysis_id":"zj-a~elder","category":"菜市场"}
   ← T5 申城佳苑片区（analysis_id: zj-a~elder）菜市场，判定距离 步行 ≤ 1,000 m：12 个小区中，已核实缺口 2 个（伪覆盖 2、盲区 0）。步行最远的：川杨新苑四期的菜市场（伪覆盖）直线 733.7 m、步行 1,281 m（约 23.7 分钟）；川杨新苑三期的菜市场（伪覆盖）直线 876.3 m、步行 1,143 m（约 21.2 分钟）。按老年人步速 0.9 m/s，15 分钟最多走 810 m：整个片区能…
3. 模型 → [走得到] list_service_gaps {"analysis_id":"zj-b~elder","category":"菜市场"}
   ← T6 玉兰香苑片区（analysis_id: zj-b~elder）菜市场，判定距离 步行 ≤ 1,000 m：30 个小区中，已核实缺口 10 个（伪覆盖 6、盲区 4），其中临界 1 个（步行距离与判定距离相差不超过 50 m，建议实地核实）。步行最远的：华陇小区的菜市场（盲区）直线 1,413.8 m（判定距离内没有这类设施，无需算路）；东窑新村的菜市场（盲区）直线 1,388 m（判定距离内没有这类设施，无需算路）；益丰工业小区的菜市…
3. 模型 → [走得到] compare_sites {"analysis_ids":["zj-a~elder","zj-b~elder","zj-c~elder","zj-v~elder"]}
   ← T7 对比 4 个分析——申城佳苑片区（老年人）：15 分钟可达 1.113 km²、画圆高估 1.85 倍、有效半径中位数 598.5 m；步行已核实缺口 8 个（画圆法只找到 1 个），待核实 2 项；玉兰香苑片区（老年人）：15 分钟可达 1.059 km²、画圆高估 1.95 倍、有效半径中位数 582.5 m；步行已核实缺口 21 个（画圆法只找到 4 个）；万科翡翠公园片区（老年人）：15 分钟可达 1.294 km²、画圆高估 …
   ✓ 系统补全引用编号：4 个 → T1

## 答

结论：本次百度地图工具被拒绝调用，我无法定位“学林路地铁站”，所以不能确认它是否在已体检片区内；仅从走得到已体检的 4 个片区看，**申城佳苑片区**是老人买菜、看病最均衡的选择，万科翡翠公园片区看病方便但买菜是硬伤，AI小镇服务中心周边最差 [T1]。

要点：
1. 申城佳苑片区（老年人画像）：菜市场已核实覆盖 10 个小区、伪覆盖 2、盲区 0，药店覆盖 10、伪覆盖 0、盲区 0，社区卫生 1 处步行 8.6 分钟可达；12 个小区里 15 分钟内能走到菜市场的有 7 个、药店 8 个 [T1]。菜市场步行最远的两处是川杨新苑四期（步行 1,281 m，约 23.7 分钟）和川杨新苑三期（步行 1,143 m，约 21.2 分钟）[T5]。
2. 玉兰香苑片区：菜市场覆盖 20、伪覆盖 6、盲区 4，药店覆盖 25、伪覆盖 5、盲区 0，社区卫生 1 处步行 11.7 分钟；30 个小区里 15 分钟内能走到菜市场的 16 个、药店 22 个 [T2]。买菜缺口集中在华陇小区（直线 1,413.8 m）、东窑新村（直线 1,388 m）、张江公馆（直线 1,073.8 m）等 [T6]。
3. 万科翡翠公园片区：小学覆盖 15、药店覆盖 15，但菜市场覆盖 0、盲区 15，15 分钟内一处菜市场也走不到，最近菜市场清单里没有可步行到达的 [T3]——老人买菜不方便。
4. AI小镇服务中心周边：菜市场覆盖 0（伪覆盖 6、盲区 6），15 分钟内小学、幼儿园、菜市场、超市、药店、公交、公园一处都走不到，只有地铁 1 处步行 12.3 分钟 [T4]；画圆高估最严重（3.00 倍），有效步行半径中位数仅 487.5 m [T7]。
5. 四个片区横向对比：15 分钟可达面积最大的是万科翡翠公园片区 1.294 km²，其次申城佳苑 1.113 km²、玉兰香苑 1.059 km²、AI小镇 0.686 km²；已核实步行缺口最少的是申城佳苑（8 个），玉兰香苑最多（21 个）[T7]。注意“待核实”不等于缺口，申城佳苑还有 2 项药店检查待核实 [T1]。

信息来源：邻至 MCP 的已体检片区数据（申城佳苑、玉兰香苑、万科翡翠公园、AI小镇服务中心周边，老年人画像）；本次没有用到百度地图的数据。

数字核验：通过，共 53 个数字
调用：大模型 4 次；百度地图 MCP 1 次；邻至 MCP 7 次；用时 8.4 秒
百度地图 MCP：AK 为 SN 校验方式，调用未带签名（status 211：Authentication failed: APP SN校验失败）
```

几处值得注意：百度 MCP 的连接和工具列表都成功（AK 有效、开通了 MCP(SSE)），拒绝发生在第一次工具调用，错误类别被准确识别；模型没有猜学林路站属于哪个片区，而是先说明无法定位，再逐个片区体检、并排对比；回答里的 53 个数字全部在本轮工具结果中找到，一处漏标的来源由系统补全（`4 个 → T1`）；最后一行如实写明“本次没有用到百度地图的数据”。

换成开通了 MCP(SSE) 的 IP 白名单 AK 后，同一个问题的预期流程是：`map_search_places` 找到学林路地铁站（BD-09 坐标）→ 再用它检索站点周边的小区 → 走得到按小区名对上已体检的片区（学林路站位于万科翡翠公园片区与 AI小镇服务中心周边之间，两个样例的地铁设施清单里都有它），用 `list_service_gaps` 的 `by_community` 逐个小区给出菜市场、药店的判定和老人的步行分钟 → 需要时用 `map_directions`（walking）实测一条路线，把估算变成实测。

## 安全

- HTTP 模式默认只监听 `127.0.0.1`，并校验 `Host` 与 `Origin` 头（防 DNS 重绑定）；改用 `--host 0.0.0.0` 会对局域网开放，请自行评估。
- 工具都是只读的，不会修改任何数据；实时体检会消耗邻至服务端的百度配额，服务端有按 IP 的限流与配额账本。
- 日志不包含任何 Key。

## 开发

```bash
pnpm --filter @zoudedao/mcp typecheck
pnpm --filter @zoudedao/mcp test      # 内存传输、Streamable HTTP（两代协议）、stdio（含构建后的可执行文件）、组合演示的离线部分
pnpm --filter @zoudedao/mcp build
```

`src/server.ts` 注册工具、资源和提示词；`src/http.ts` 是 Streamable HTTP（`createMcpHandler` + `@modelcontextprotocol/node` 的 `toNodeHandler`）；`src/cli.ts` 是命令行入口（stdio 用 SDK 的 `serveStdio`）。`demo/` 是组合演示（不随包发布）：`combo.ts` 是智能体循环，`baidu.ts` 是去 Key、识别百度错误类别、补单位这些可离线测试的部分（`test/combo.test.ts`）。
