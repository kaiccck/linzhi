# @zoudedao/engine

走得到的实时分析引擎：输入一个中心点，按阶段调用百度地图 Web 服务，用 `@zoudedao/core` 的纯算法算出完整的 `AnalysisResult`（字段与 `data/samples/zj-a.json` 相同，Web 直接渲染）。服务端（SSE）、MCP Server 和 CLI 共用它。

引擎只做编排：百度客户端由调用方注入，所有数字都来自 core 算法对百度应答的计算。设计依据见 `docs/技术设计文档.md` §3.3（数据流与预算）、§4（接口策略）、§5（等时圈）、§7（盲区与选址），事件格式以 `docs/api.md` 为准。

## 用法

```ts
import { createBaiduClient } from '@zoudedao/baidu';
import { analyze, createEngineAnalyzer, planQuota, EngineError } from '@zoudedao/engine';

const client = createBaiduClient(); // 真实客户端：缓存、限流、配额账本
const input = { center_bd09: [121.644195, 31.19007], label: '孙环路 × 高木桥路', profile: 'adult' } as const;

planQuota(input).expected; // 开始前的估算：{ reverse_geocoding: 1, place: 7, directionlite_walking: 4, routematrix_walking: 422 }

const result = await analyze(input, { client }, (event, data) => console.log(event, data), {
  signal: AbortSignal.timeout(180_000),
});

// 服务端：直接接到 apps/server 的 Analyzer 接口上
const analyzer = createEngineAnalyzer({ client }); // { name: 'engine', analyze(input, emit, signal) }

// 官方数据（由调用方读取 data/official/*.json 后传入，引擎不读文件；服务端见 apps/server/src/official.ts）
const withLists = createEngineAnalyzer({
  client,
  official: [pudongMarkets2023q4, pudongSchools2026, shanghaiCommunityHealth], // 设施名录：确认、改类、补充
  catchment: [pudongCatchment2025], // 对口地段表：communities[].catchment
  exclusions: exclusionsJson.entries, // 排除清单：剔除核实有误的百度 POI
});
```

导出的签名：

```ts
analyze(input: EngineInput, deps: EngineDeps, emit: Emit, opts?: EngineOptions): Promise<AnalysisResult>
createEngineAnalyzer(deps: EngineDeps, opts?: Omit<EngineOptions, 'signal'>):
  { name: 'engine'; analyze(input: EngineInput, emit: Emit, signal: AbortSignal): Promise<AnalysisResult> }
planQuota(input: EngineInput, opts?: { budget?: Partial<EngineBudget>; tier?: BaiduTier; scope?: EngineScope; catchment?: boolean }): QuotaPlanEstimate

EngineInput   = { center_bd09: [lng, lat]; label?: string; profile?: 'adult' | 'elder' }
EngineDeps    = { client: EngineClient; now?: () => Date; official?: readonly OfficialList[];
                  catchment?: readonly CatchmentList[]; exclusions?: readonly FacilityExclusion[] }
OfficialList  = { id; category: FacilityCategory; title; publisher; published; url; region; entries: OfficialEntry[] }
OfficialEntry = { name; address?; status: 'active' | 其他（装修改造、业态调整、特殊教育…）; bd09?: [lng, lat]; geocode?: { precise; level } }
CatchmentList, FacilityExclusion: 见 @zoudedao/core（catchment.ts、exclusions.ts）
fuseOfficial(args): FusionResult  // 纯函数，引擎在设施阶段调用；也可单独用于离线数据
EngineOptions = { signal?: AbortSignal; budget?: Partial<EngineBudget>; tier?: 'personal' | 'enterprise';
                  scope?: 'full' | 'isochrone'; budgetBasis?: 'billed' | 'requested';
                  barriers?: boolean; convergeShare?: number }
Emit          = <E extends 'stage' | 'partial' | 'quota'>(event: E, data: EngineEvents[E]) => void
EngineClient  = Pick<BaiduClient, 'reverseGeocode' | 'placeAround' | 'routeMatrixWalking' | 'walkingRoute'>
                & Partial<Pick<BaiduClient, 'placeDetail'>>  // 只有带 browser_pois 时才用
                & { ledger?: Pick<QuotaLedger, 'reserve' | 'usage' | 'blockedBy'> & { tier?: BaiduTier } }
```

`EngineInput`、事件类型和 `Emit` 与 `apps/server/src/analyzer.ts` 结构一致，服务端的 `emit` 和 `AbortSignal` 可以原样传入。

## 流水线

| 阶段（SSE `stage`） | 做什么                                                                                                                                                                                                                                                                                                                                                     | 百度调用（个人档上限）                     | 推送的 `partial`                                                                           |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `locate`            | 以中心点建立局部米制坐标系（core `localFrame`）；逆地理编码取街道、所在小区，得到 `meta.name`、`meta.region`                                                                                                                                                                                                                                               | 逆地理编码 1                               | `meta`                                                                                     |
| `facilities`        | 小学 / 菜市场（含菜场、农贸市场、生鲜市场）/ 药店（含药房）用一个 `$` 并集检索，半径 = 需求点范围 1.1 km + 1 km 缓冲 = 2.1 km；有余页时加查生鲜超市、幼儿园；`cleanPois` 清洗；排除清单剔除；必需设施类的官方名录融合（见下节）；再用一次 `$` 并集检索其他民生设施（见「民生设施与圈内设施统计」），社区卫生等名录与这批结果融合；最后再按排除清单剔除一次 | 地点检索 ≤ 4 + 2 页                        | `pois`                                                                                     |
| `seed`              | `polarSeed`：16 方位 × 3 半径，1 × 48 批量算路；拿到后立即推送粗等时圈                                                                                                                                                                                                                                                                                     | 批量算路 48 条                             | `samples`、`field`、`contours`、`contours_meta`、`baseline`                                |
| `paths`             | `planPathProbes` 选绕行最明显的方向，`walkingRoute` 走到 1.25R，`pathPrefixSamples` / `pathSamples` 把路径点变成带时间的样本                                                                                                                                                                                                                               | 轻量步行路线 4 次（无路线时顺延，≤ 6）     | `paths`、`samples`、耗时场、`barriers`                                                     |
| `refine`            | `planRefinement` 每轮 48 点，样本够多时用 `detectBarriers` + `visibilityFilter` 做断裂感知；15 分钟区域前后两轮对称差 < 3% 即停                                                                                                                                                                                                                            | 批量算路 ≤ 4 × 48 条                       | 每轮：`samples`、耗时场、`barriers`                                                        |
| `reach`             | `buildIsochrone` 出最终耗时场（20 m 格网，覆盖 ±1.6 km）与 5/10/15 分钟等时圈，一律按百度实测 1.17 m/s（成人）秒数；core `facilityStats` 算出圈内设施统计；不再算路                                                                                                                                                                                        | 无                                         | 耗时场、`stats`（含 `facility_stats`）、`barriers`                                         |
| `coverage`          | 需求点：一次“住宅区$小区”检索；逐轮 `planCoverageRound` → `planMatrixBatches` → 批量算路，再用 `planNearestTopUp` 补算直线更近的候选，`mergeMatrixResults` 合并；灰色区域 `statusRaster` / `grayAreaPolygons`；对口地段表覆盖中心所在街镇时给小区配对口小学并算到校门（`catchment`）；再为有缺口的类别选址（见下）                                         | 地点检索 2 页；批量算路 ≤ 400 + 40 + 60 条 | `communities`、`gray_areas`（有对口小学时再推一次 `communities`），然后 `site_suggestions` |
| `report`            | 组装 `meta`（名称、坐标公式、署名、说明）、`stats`（等时圈统计 + 判定计数 + 配额用量），返回结果                                                                                                                                                                                                                                                           | 无                                         | —（结果由 Promise 返回）                                                                   |

要点：

- **设施检索与 `capped`**：实测百度的 `$` 并集按关键词分组返回、组内由近到远，所以稀缺的小学、菜市场排在前面，页数限制只会截掉最后一组（药店）的远端。并集没取全（分页用完或命中 150 条上限）时，被前面分组挤掉、不足一页的类别单独再查一次（拆分关键词）。每一类记录“在离中心多远以内是完整的”：清单不全的地方，不覆盖的判定一律标 `verified: false`，只有覆盖的判定仍然成立（找到一条 ≤ 1 km 的路线就是证明）。
- **需求点**：“住宅区$小区”的结果去掉非住宅（居委会、停车场等），同名子点（`××-1号门`、`××东门`、`××-3号楼`、重复条目）按去掉门、楼后缀的名称合并；同名但相距 400 m 以上视为两个小区（`锦绣苑`、`锦绣苑（2）`）。再去重（`stats.residential_dedupe` 记录每一次合并与去掉）：期号写法统一（`I期` = `1期` = `一期`，同一母点下的同名分期不论相距多远都合并）；母点（`parent_id`）的两个以上分期都在清单里时去掉母点、由各期分别判定，只有一个子点时子点并入母点；地址写明另一小区（≥ 4 字）且点位相距 ≤ 30 m 的别名并入该小区。只凭地址相同不合并，相邻而名称不同的小区各自判定。出入口优先取主 POI 的 `navi_location`，其次最近的门 POI，最后用 POI 坐标（`communities[].gate` 记录来源）。只取出入口离中心 1.1 km（15 分钟直线圈外加 50 m，`DEMAND_RADIUS_M`）以内、离中心最近的 30 个：检查的是圈里的人。
- **盲区判定**：每轮每个小区每类只算直线距离在规则内、离得最近的 2 个候选，已覆盖或候选用尽的小区不再算路；预算用尽时剩余判定保持 `verified: false`（估算）。
- **最近设施补算**：找到覆盖即停只证明了结论，这条路线经由的设施不一定是最近的。各轮之后再补算一次（core `planNearestTopUp`）：入口直线距离比已测最短步行更近、却还没从该小区算过路的候选都算一遍，所以 `via` / `route_m` 是已知设施中实际步行最近的一处。补算用同一条 coverage 预算，放不下的批次跳过，那些判定保留 `route_upper_bound` 与 `unrouted_nearer`；`stats.coverage_nearest_routes` 是补算的路线数。
- **选址**：候选点取步行路线上每 50 m 一点，`suggestSites` + `fieldEstimator` 估算覆盖。core 的核验钩子是同步的，而实测要异步调用百度，所以引擎把贪心当纯函数反复运行：排名前 2 的建议若仍是估算，就用一次 1 × |D| 批量算路实测该点，再重算贪心；每类最多核验 2 个点，其余保持 `verified: false`。
- **地图前端补充的设施**：请求带 `browser_pois`（浏览器 JSAPI 检索到、百度服务端检索可能漏掉的设施）时，设施检索之后把不在检索结果里、在 2.1 km 内的 uid 按稀缺类别优先、由近到远用 place/v3/detail 查详情（`detail` 预算：个人档 5 次 = 50 个 uid，企业档 10 次，另计在 `place` 之外；当天地点检索配额紧张时最先放弃），与检索结果一起 `cleanPois`，名录融合、排除清单和买菜替代候选都照常处理；只由它们得到的设施带 `found_by: 'jsapi'`，超市等民生设施只在 1.1 km 内计入，统计在 `stats.browser_pois`。
- **失败即停**：采样只接受 `ok` 的格子，失败的格子不当作 0 米；没有路线的方向由下一个探测方向顶上。

## 民生设施与圈内设施统计

赛题要“统计圈内各类民生设施覆盖情况”。三类必需设施（小学、菜市场、药店）按小区逐一判定；其他民生设施只计数，不做小区判定：

- **一次检索**：`社区卫生服务中心$社区卫生服务站$养老院$日间照料中心$长者照护之家$长者食堂$地铁站$公园$超市$公交车站`（10 个关键词，百度一次检索的上限；`LIVELIHOOD_KEYWORDS`），半径 1.1 km（15 分钟直线圈 1,053 m 外加约 50 m，`LIVELIHOOD_RADIUS_M`），最多 2 页（`LIVELIHOOD_PAGES`）。并集按关键词分组、组内由近到远返回，所以稀少的类别在前，页数只截掉最多的一组（公交站）的远端；每组完整到哪里记在 `stats.facility_inventory`（键为类别名，与必需设施的清单记录同一格式）。
- **分类**：core `categorize()`：社区卫生服务中心/站、卫生院按名称归入 `社区卫生`（百度常标为“医疗;综合医院/诊所”）；养老院、敬老院、日间照料、长者照护之家、长者食堂、社区食堂、助餐点归入 `养老`（不含“自助餐”）；`交通设施;地铁站` → `地铁`，`交通设施;公交车站` → `公交`，`旅游景点;公园` → `公园`，`购物;超市` → `超市`。地铁站出入口（`出入口;其他`）、无障碍电梯和名为“××地铁站店”的酒店商铺都不算设施。
- **合并**（`livelihoodPois()`）：只保留这六类（检索顺带返回的药店、小学、生鲜超市属于有完整性记录的必需设施清单，不从这里补）；与已有设施 uid 相同、或同类同名（或同一车站）且相距 150 m（车站 300 m）以内的不重复加入。结果追加在 `pois` 末尾，不参与小区判定和选址。
- **统计**：`stats.facility_stats = facilityStats(result)`（core），在 `reach` 阶段随等时圈推送，最终结果里也有：每类 `{ category, found, walk, circle, nearest_s, nearest? }`——清单数、15 分钟步行可达数（耗时场在设施入口处 ≤ 900 秒）、直线 15 分钟圆（1,053 m）内数、最近一处的步行秒数与名称。菜场摊位并入菜市场，同一地铁站或公交站的各出入口算一处（core `stationKey()`）。按成人 1.17 m/s 保存；老年人视图由客户端 `facilityStats(result, { scale: 1.17 / 0.9 })` 换算。
- **降级**：`budget.livelihoodPages`（个人档、企业档都是 2 页）为 0、账本只够必需设施的检索（预留时先放弃这 2 页，写入 `meta.warnings`），或检索遇到网络等上游错误时跳过这一步，`meta.notes` 说明圈内设施统计只含已检索的类别；小区判定不受影响。

2026-09-28 在张江的实测（`data/samples/zj-b|zj-c|zj-v.json`，各 2 页、38 / 33 / 30 条结果都取全）：玉兰香苑片区 15 分钟步行可达超市 10 家（直线圆内 13 家）、公交站 11 个（16 个）、公园 2 个（3 个），唯一的地铁站高科中路要走 15.1 分钟；AI小镇服务中心周边的药店、菜市场、超市在 15 分钟内一处也走不到。

## 多源融合：官方名录与排除清单

百度会把一部分标准化菜市场标错类别：申城佳苑中心 309 m 外的浦商生鲜(申城佳苑店)（孙建路858号）在百度里只标为“购物”，用 菜市场$菜场$农贸市场$生鲜市场 永远检索不到；浦商生鲜(环西店)、浦商农产品(紫薇店) 标为“生鲜超市”，赛题口径不认。加上官方名录后，申城佳苑的菜市场缺口从 4 个降到 2 个。

权威来源（`data/official/`，坐标由 `apps/server/scripts/geocode-official.ts` 用百度地理编码补充，保留精度标记；服务端读文件后通过 `EngineDeps` 传入，引擎只做融合）：

| 文件                             | 来源                                                                                                             | 用途                                                                                          |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `pudong-markets-2023q4.json`     | 浦东新区商务委《2023年四季度浦东新区菜市场实效测评得分及排名》（2023-11-21），196 家，171 家参评                 | 菜市场：确认、改类、补充                                                                      |
| `pudong-schools-2026.json`       | 浦东新区教育局《2026年浦东新区义务教育阶段学校招生入学信息公示（小学）》（2026-04-07），267 个校区（公办、民办） | 小学：同上；3 所特殊教育学校标为“特殊教育”不计；目前 100 个校区有坐标（张江镇及相邻街镇优先） |
| `shanghai-community-health.json` | 上海市卫健委《上海市社区卫生服务中心信息》（2026-03-31），浦东 46 家                                             | 社区卫生：同上（与民生设施检索结果融合）                                                      |
| `pudong-catchment-2025.json`     | 浦东新区教育局《2025年浦东新区公办小学招生地段公示》（2025-04-07），张江镇的 232 行（全表 6,790 行）             | 对口小学（`kind: 'catchment'`，见下节）                                                       |
| `exclusions.json`                | 人工核实的排除清单，每条带理由、来源链接与日期                                                                   | 剔除百度 POI，如育华学校(雪英校区)：2026 年不在小学招生名单中（`kind: 'exclusions'`）         |

规则（`src/official.ts`，在 `cleanPois` 之后、推送 `pois` 之前执行，不消耗任何配额）：

1. 只用类别可识别的名录；只取 `status: 'active'` 且地理编码点在设施检索半径（2.1 km）内的条目。
2. 与本次所有地点检索的**原始结果**匹配（清洗前，所以被标签过滤掉的“购物”条目也在内），满足其一：
   - 名称键相同（`officialNameKey`）：菜市场按分店名，去掉品牌与业态词（浦商生鲜、浦商邻里荟、浦商菜市场、浦商农产品、清美鲜家、生鲜、邻里荟、菜市场、菜场、农贸市场、集贸市场、市场、集市、店）和括号后比较，如 浦商生鲜(申城佳苑店) 与 浦商生鲜申城佳苑店 都是“申城佳苑”；小学按 core `schoolKey`：去掉“上海市浦东新区”等区划前缀与“民办”，校区统一成一个词（孙桥小学(张江校区)、浦东新区孙桥小学张江校区、上海市浦东新区孙桥小学（张江校区）都是 孙桥小学#张江；分校、分部、办学点同样处理；进才实验小学西校 的“西校”属于校名）；社区卫生按 core `healthKey`（去掉区划前缀与括号）；
   - 门牌相同：去掉省市区镇和括号内的补充说明后比较“路名 + 门牌号”（孙建路858号），或路名与号码相同而一边写“号”一边写“弄”（紫薇路686号 与 紫薇路686弄，core `roadNumber`）。

   且在各类别的距离内：菜市场等名称或门牌一致 250 m、两者都一致 400 m；小学名称一致 800 m、门牌一致 250 m、两者都一致 1,000 m；社区卫生名称一致 600 m、两者都一致 800 m（学校、社区卫生服务中心的名称在区内唯一，校园大、门牌地理编码偏差大，所以名称一致可以放宽）。菜场摊位永远不当作菜市场本身；与名录类别无关的类别（例如同一门牌的药店）也不匹配。

3. 匹配上：类别改为名录类别，写入 `official`（百度类别不同时带 `reclassified_from`，如“生鲜超市”“购物”），百度的 uid 与出入口（navi_location）保留，算路仍走百度的门。
4. 没匹配上：按官方地址补一个 POI，`uid` 为 `gov:<名录 id>:<序号>`，`source: 'gov'`，`navi_xy: null`（算路到地理编码点）。地理编码不精确（precise = false，或级别不是“门址”“楼号”）时照样补充，但写入 `meta.warnings`。
5. 装修改造、业态调整、特殊教育等非营业条目从不补充；即使与百度 POI 匹配，也保持百度原来的分类。
6. 菜场摊位的归并照旧：确认后的菜市场，其摊位仍并入它，不单独计数。
7. 分两段融合：小学、菜市场等必需设施类的名录在设施检索之后、民生设施检索之前与设施检索的结果融合（半径 2.1 km）；社区卫生等计数类的名录在民生设施检索之后与两次检索的全部结果融合（半径 1.1 km，与民生设施检索相同），所以百度的社区卫生服务中心能被确认而不是被官方点位重复补充。
8. 名录里还没有坐标的条目不参与融合；分析中心在名录所属区县时，`meta.notes` 写明还有多少条没有坐标（`stats.official[].ungeocoded`）。
9. **排除清单**（`EngineDeps.exclusions`，core `applyExclusions`）：按 uid（含被合并的重复条目），没有 uid 时对 `category` 所列类别（单个或数组）按同名或名称正则 `name_pattern` 剔除核实有误的百度 POI；在融合之前从检索结果和融合候选中去掉（名称规则命中的原始检索结果也移出融合池，官方名录不能把一个前置仓“确认”成菜市场），融合之后再剔除一次（名录里同名的条目也不能把它补回来）。被剔除的 POI 记入 `stats.excluded`（`{ uid, name, category, reason, source, date, pattern? }`）与 `stats.pois_dropped`，`meta.notes` 写一句理由（同一理由的多处合成一项）。名称规则目前用于线上买菜的前置仓：叮咚买菜、美团买菜、小象超市的“××站”、每日优鲜（`data/official/exclusions.json`），百度把它们标为“生鲜超市”，会被误当作买菜替代；真实门店（盒马鲜生、叮咚奥莱、小象超市线下门店）不受影响。

每份在范围内有条目的名录在 `meta.notes` 里写一句中文小结（例如“菜市场名录（上海市浦东新区商务委员会《…》）：范围内 3 家，与百度 POI 一致 1 家，百度标为生鲜超市或购物而改类 1 家，百度检索未返回、按官方地址补充 1 家。”），在 `meta.attribution` 里写明发布单位、标题、日期与链接，逐项计数见 `stats.official`。

没有把“生鲜”加进菜市场检索词：它会召回大量生鲜店，挤占每次只有 4 页的设施检索；官方名录已经按坐标补上了标准化菜市场。

## 对口小学（对口地段表）

`EngineDeps.catchment` 是官方招生地段表（core `CatchmentList`：学校 → 对口地段、小区名称、情况说明）。逆地理编码得到的区县与街镇在表的覆盖范围内（`catchmentCovers`，例如 `pudong-catchment-2025.json` 只转录了张江镇）时：

1. 每个小区用 core `matchCatchment(list, 名称, 百度地址)` 匹配，依次按弄号（名称或地址里的“××路××弄”）、小区名（去掉区划与“张江”“孙桥”等地名前缀、期号数字统一为汉字、组/区统一为块、去掉“社区”“小区”后缀）、名称缺期或块（玉兰香苑-二期 对 玉兰香苑二期A块/B块/C块）、名称去掉期或块（川杨新苑-南区 对 川杨新苑一期…六期）；只有所有命中的条目都对口同一所学校才算匹配，否则记为“对口不同学校，未判定”。情况说明为“已动迁”的条目跳过。
2. 学校的校门：设施清单里的小学 POI（按官方名称或百度名称的 `schoolKey` 比对），没有时用小学名录中已地理编码的条目。表中不写校区的学校（如孙桥小学）找到的每个校区都算路，取步行较近的一个，并在 `note` 里写出另一个校区的距离。
3. 路线先复用盲区判定已算过的（小区出入口 → 同一校门），其余用 `catchment` 预算线的一次批量算路；预算用尽或没有路线时 `route_m` 为 `null` 并在 `note` 说明。
4. 结果写入 `communities[].catchment`（`{ school, school_uid?, route_m, dur_s, straight_m, source, matched_by, note? }`，`matched_by` 为 `lane:…` / `name:…` / `phase:…` / `base:…`），`stats.catchment` 记匹配数、各方法计数、未匹配与未判定的小区名、算到路线的小区数与新请求的路线数，`meta.notes` 写一句中文小结。中心不在覆盖范围内时只写一句说明，不匹配。

2026-09-28 在张江三个实时样例上：玉兰香苑片区 30 个小区匹配 16 个（弄号 13、小区名 3），万科翡翠公园片区 15 个匹配 7 个（全部按弄号：百度把万科翡翠公园各期登记在 川和路322/333/388/399弄，地段表里是兴科苑），AI 小镇服务中心周边 12 个匹配 7 个；未匹配的多为“江夏社区”一类居委会名称、商业楼盘名或地段表未列的新小区。

## 配额与预算

每次运行先按 `max` 向账本预留（`client.ledger.reserve(plan)`），每次调用都带上 `{ budget, signal }`，结束时（包括失败和中止）在 `finally` 里归还剩余部分。账本在 90% 软上限拒绝时，分析直接以 `quota_exhausted` 结束，不发出任何调用；只有逆地理编码接近上限时跳过它（名称改用输入标签），其余照常。

| 预算项             | 个人档（默认） | 企业档      | 说明                                         |
| ------------------ | -------------- | ----------- | -------------------------------------------- |
| 地点检索（页）     | 8              | 12          | 其中小区检索保留 2 / 3 页，民生设施 2 / 2 页 |
| 逆地理编码         | 1              | 1           |                                              |
| 轻量步行路线       | 6              | 8           | 目标走 4 / 6 条，余量用于顶替没有路线的方向  |
| 批量算路：粗采样   | 48             | 48          |                                              |
| 批量算路：边界加密 | 192（4 轮）    | 288（6 轮） |                                              |
| 批量算路：盲区判定 | 400            | 900         | 需求点 30 / 60 个                            |
| 批量算路：选址核验 | 60             | 120         |                                              |
| 批量算路：对口小学 | 40             | 80          | 盲区判定已算过的路线直接复用                 |
| **批量算路合计**   | **740**        | **1,436**   |                                              |

- 计数口径与客户端账本一致：只记百度实际处理的请求，**命中缓存不计**（同一中心点第二次分析不消耗配额）。
- `planQuota(input)` 给出开始前的估算：`expected` 是典型冷启动的用量，`max` 是上限（也是预留量），`steps` 按阶段列出，附中文说明。
- `opts.budget` 可覆盖任一项；`budget.seed` 小于 16 时直接拒绝（`invalid_input`）。
- 合成城市实测（个人档，冷启动）：逆地理编码 1、地点检索 8 页（必需设施 3 + 民生设施 2 + 小区 2 + 买菜替代 1）、步行路线 4 次、批量算路 487 条（粗采样 48 + 加密 192 + 盲区判定与买菜替代 232 + 选址核验 15），共 55 次批量算路请求；`planQuota` 估算 1 / 9 / 4 / 452。对口小学只在有覆盖中心的地段表时花费（`planQuota(input, { catchment: true })` 估算 15 条）。
- `opts.budget.place` 按“必需设施 + 民生设施 + 小区”分配：`residentialPages`、`livelihoodPages` 先留出，必需设施用剩下的；只想省掉民生设施检索时设 `livelihoodPages: 0`。

### 只生成等时圈与评测用的选项

这四个选项默认都不改变行为，服务端不使用；`packages/eval` 的精度–配额评测用它们：

| 选项                       | 作用                                                                                                                                                                                                                                                                                                          |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scope: 'isochrone'`       | 等时圈生成后直接结束：不检索设施、不做盲区判定与选址，不调用地点检索；预留的配额里地点检索、盲区、选址为 0（`scopedBudget`），所以地点检索用尽的日子也能画等时圈。阶段为 locate → seed → paths → refine → reach → report，`pois`、`communities` 为空，`stats.scope = 'isochrone'`；等时圈与完整体检的逐位相同 |
| `budgetBasis: 'requested'` | 预算按“请求的单位”计数，命中缓存也算（默认 `billed` 只算百度计费的单位）。默认口径下热缓存会给加密留出更多预算，同一预算的第二次运行可能比第一次测得更多；按请求计数时冷热结果完全相同。此时 `stats` 另有 `budget_basis`、`quota_requested`、`quota_requested_by_step`                                        |
| `barriers: false`          | 关闭 Lipschitz 断裂检测：加密不向阻隔靠拢，耗时场不做可见性过滤（消融实验）；`barriers` 为空                                                                                                                                                                                                                  |
| `convergeShare`            | 加密的停止阈值：两轮之间 15 分钟区域的对称差小于它即停，默认 `CONVERGED_SHARE`（0.03）；0 表示不提前停，用满加密预算（负数按 0，非数字按默认）                                                                                                                                                                |

## 事件

`emit(event, data)` 只发三种事件，`result` 与 `error` 由调用方（服务端）根据 Promise 自己发：

| 事件      | 数据                           | 说明                                                                                                                                                             |
| --------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stage`   | `{ stage, message, progress }` | 阶段依次为 locate → facilities → seed → paths → refine → reach → coverage → report；同一阶段可以多次推送（加密每轮、盲区每轮、选址）；`progress` ∈ [0, 1] 且不减 |
| `partial` | `AnalysisResult` 的部分字段    | 出现的每个字段都是该字段当前的**完整值**，客户端按 `{ ...prev, ...partial }` 浅合并                                                                              |
| `quota`   | `{ service, used, limit }`     | 每次调用后推送；有账本时是当日用量与档位上限，无账本时是本次运行的用量与本次上限                                                                                 |

- **中止**：`opts.signal` 触发后不再发起任何百度调用、不再推送事件，Promise 以 `signal.reason` 拒绝；正在进行的调用立即放弃等待。
- **错误**：可预期的失败抛出 `EngineError`，`code` 为 `quota_exhausted`、`auth`、`upstream`、`invalid_input` 之一，`message` 是可直接展示的中文（百度错误经 `toApiError` 转换并附修复提示，不含任何 Key）。其他异常是缺陷，原样抛出，由服务端记为 `internal`。
- **降级**：密钥、权限、配额错误一律终止分析；网络、限流等上游错误出现在可省略的步骤时降级并写入 `meta.warnings`（逆地理编码、生鲜超市/幼儿园检索、民生设施检索、某条步行路线、某轮加密、小区检索、盲区或选址中的一批路线）。账本在 90% 软上限前只够必需设施时，预留阶段先放弃民生设施检索（和接近上限的逆地理编码一样），分析照常进行。

## 结果中的实时模式字段

- `meta`：除 `AnalysisMeta` 外还有 `mode: 'live'`、`profile`、`profile_speed_mps`、`rule_m`、`facility_radius_m`、`address`、`notes`（中文说明）、`warnings`；`region` 取自逆地理编码（市、区、街道/镇）；`attribution` 注明百度地图与调用日期，并声明实时模式不使用 OpenStreetMap。
- `communities[]`：`pts: []`，`centroid` 是小区出入口，另有 `gate`（出入口来源）与 `uid`；`worst_status` 只看已核实的判定。
- `paths[]`：除 `bearing_deg`、`pts` 外有 `label`、`dest_xy`、`route_m`、`dur_s`（步行路线自身耗时）、`dur_route_s`（route_m / 1.17）、`instructions`。
- `communities[]` 另有匹配上对口地段表时的 `catchment`。
- `stats`：core 的等时圈统计，加上 `facility_stats`（圈内设施统计，见上节）、`community_status_counts`、`catchment`、`excluded`、`coverage_nearest_routes`（最近设施补算的路线数）、`facility_counts`（各类 POI 数，摊位并入菜市场，被剔除的 POI 不计）、`facility_inventory`（每组检索完整到离中心多远，含民生设施各类）、`place_queries`（最后一条是民生设施并集）、`refine_rounds`、`refine_converged`、`barrier_segments`、`coverage_rounds`、`unverified_by_inventory`、`siting_verified_sites`、`official`（每份名录的范围内、一致、改类、补充、非营业条目数）、`quota_used`、`quota_by_step`（含 `livelihood`）等。
- 结果里的 `samples` 就是生成 `field` 的全部输入：用 core 的 `buildIsochrone` 和 `detectBarriers` 可以原样重建耗时场。

## 已知局限

- **小区没有轮廓**：百度的小区边界（AOI）是付费服务，实时模式下 `communities[].pts` 为空，`centroid` 是出入口；灰色区域按出入口 250 m 内的最近需求点栅格生成，不限定在居住用地内。
- **需求点来自地点检索**：没有户数权重（选址按小区个数计）；只取最近的 30 个（企业档 60 个）；小区名称合并依赖后缀规则，罕见写法可能拆成两个或漏掉门 POI。
- **不使用 OpenStreetMap**：没有底图路网和水系，河道、高架只从耗时矛盾推断（`barriers`），不给出名称；`meta.barrier_names` 在实时模式下不设置（步行路线说明只写所走道路，从不写挡路的河道或高架；客户端的逆地理编码也不返回 `roads`），Web 显示通用说法“路网绕行”。
- **设施清单受检索配额限制**：个人档每次最多 4 页设施检索；清单不全的类别在远端只能给出“未核实”。民生设施只有一次 2 页的检索：商铺密集处（百度把不少酒店、商铺命名为“××地铁站店”，会占用地铁一组的结果）公交站等最后几组可能不全，`facility_inventory[类别].complete = false` 时圈内设施的数量是下限；没有“医院”类别（社区卫生只含社区卫生服务中心/站和卫生院）。
- **官方名录**：浦东新区的菜市场（2023 年第四季度）、小学（2026 年招生名单，267 个校区中 100 个已有坐标）、社区卫生服务中心（46 家，没有服务站）；名录外的非标准化菜市场、社区卫生服务站仍只靠百度；百度有而名录无的小学不会自动剔除（只按排除清单剔除已核实的）。按官方地址补充的点位来自地理编码，算路终点是门牌坐标而不是出入口，精度不足的已在 `meta.warnings` 标出。
- **对口小学**：只转录了张江镇的地段（232 行）；匹配按名称与弄号，百度用物业名、表里用登记名的小区（例如万科翡翠公园与兴科苑）只有地址里有弄号时才能匹配上；表中不写校区时取步行较近的校区，实际分校区办法以学校为准。
- **画像**：结果一律是成人口径（百度路线的 1.17 m/s 秒数），同一中心点只有一份结果；老年人画像只把边界加密的目标移到 692 s（0.9 m/s 的 15 分钟），并写入 `meta.profile` 与 `meta.profile_speed_mps`，显示时由前端换算（耗时 × 1.17/0.9）。
- 批量算路的耗时就是 距离 / 1.17 m/s，看不到红绿灯等待（§5.8 的过街修正尚未接入）。

## 测试

```sh
pnpm --filter @zoudedao/engine test       # 60 个用例，约 20 秒，不联网、不读 .env.local
pnpm --filter @zoudedao/engine typecheck
pnpm --filter @zoudedao/engine build
```

测试用一座合成城市（`test/city.ts`）：100 m 街道网格，x = 450 m 处一条直河，只有 y = −300 m 一座桥；路线是网格上的最短路（Dijkstra），步速 1.17 m/s。设施与小区里放了菜场摊位、重复条目、带“小学”字样的培训机构、宠物药店、小区的门和楼、同名小区、居委会与停车场等噪声；民生设施有社区卫生服务中心/站、养老院、长者食堂、两个地铁站（一个只能绕桥走到）及其出入口和电梯、公园、超市，以及多于两页的公交站。`test/fakeClient.ts` 按客户端的返回结构应答，并用真实的 `QuotaLedger` 记账；`test/transport.ts` 把同一座城市包装成百度的 HTTP 应答，用于真实 `BaiduClient` 的集成测试。

覆盖的断言：阶段顺序与进度；粗等时圈在第一次批量算路后立即推送；配额不超过个人档预算、每次调用都带预算和中止信号、预留全部归还；15 分钟等时圈离河 50 m 以外只在桥头附近越河、面积远小于直线圆、阻隔沿河检出；最近的小学或菜市场在河对岸的小区判为伪覆盖，且全部 90 项判定与街道网格的真值一致；设施清洗与小区合并；选址每类最多核验 2 个点；结果可被 Web 解析、可 JSON 往返、可由样本重建耗时场；`planQuota` 与实际用量相差在 ±15% 内；中途中止、配额错误、密钥错误、非法输入、账本接近上限、可选检索失败；老年人画像；无账本的客户端；`createEngineAnalyzer` 满足服务端接口；官方名录融合（确认、由生鲜超市改类、百度未返回而补充、装修改造不计、范围外忽略，补充的菜市场使一个小区由伪覆盖变为覆盖，且判定仍与街道网格真值一致；分店名与门牌的归一化、250 m / 400 m 阈值、摊位与同门牌药店不误配；小学的校区写法与“号/弄”门牌、九年一贯制学校改类、特殊教育不计、名称一致但超过 800 m 不配；社区卫生与民生设施检索结果两段融合）；对口小学（按名称匹配、两个校区取近者并说明、表中学校不在清单时不算路、对口不同学校时不判定、复用盲区判定路线、区县不在覆盖范围或预算为 0 时的说明）；排除清单（剔除后判定仍与真值一致并写入说明；按名称规则剔除前置仓后，判定不再经由它、也不再作为买菜替代，仍与真值一致）；民生设施（一次并集、两页、公交站被截断且标为不完整、出入口与电梯不计、已由生鲜超市组找到的超市不重复、同名公交站两个方向算一个、`facility_stats` 等于 core `facilityStats(result)` 并随等时圈推送、检索失败与账本只够必需设施时跳过且小区判定不变）；真实 `BaiduClient` 下的账本、缓存（第二次分析零请求、零配额）；评测选项（`test/options.test.ts`）：只生成等时圈时不调用地点检索、结果与完整体检的等时圈逐位相同、地点检索用尽时仍能运行，按请求计数时同一预算冷热结果相同（按计费计数时热缓存会多加密），关闭断裂检测后耗时场就是普通去趋势插值，`convergeShare` 为 0 时用满加密预算。
