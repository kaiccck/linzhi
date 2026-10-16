# @zoudedao/core

邻至的核心算法库：纯函数，无 I/O，浏览器与 Node 通用。

所有计算都在以分析中心为原点的局部米制坐标系中进行（x 向东，y 向北）。百度接口返回的 BD-09 坐标由调用方用 `localFrame(lng0, lat0).toXY` 投影。设计依据见 `docs/技术设计文档.md` §5–§7。

## 模块

| 模块             | 内容                                                                                                                                                                                                                                                                                                                                     |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `types`          | 服务端、前端和样例数据共用的数据结构（`AnalysisResult` 等）                                                                                                                                                                                                                                                                              |
| `coords`         | WGS84 / GCJ-02 / BD-09 互转，haversine，局部坐标系；`parseCoordinateText` 识别输入的坐标（“经度,纬度”或“纬度,经度”、全角标点），中国范围 `CHINA_BOX`                                                                                                                                                                                     |
| `geom`           | 环的面积、方向、质心，点在多边形内，裁剪，线段相交，按距离重采样                                                                                                                                                                                                                                                                         |
| `simplify`       | Douglas–Peucker 简化（折线与闭合环）                                                                                                                                                                                                                                                                                                     |
| `field`          | 去趋势插值：对绕行系数 ρ 做 IDW，留一法验证，可选的"可见性"过滤                                                                                                                                                                                                                                                                          |
| `contour`        | marching squares 等值环（外环逆时针、孔洞顺时针），Chaikin 平滑，环嵌套                                                                                                                                                                                                                                                                  |
| `barrier`        | Lipschitz 断裂检测：Delaunay 边强度 κ，断裂段，可见性判断                                                                                                                                                                                                                                                                                |
| `sampling`       | 三阶段主动采样的规划函数：极坐标粗采样、路径前缀采集、边界带加密；收敛判定；配额账本                                                                                                                                                                                                                                                     |
| `isochrone`      | 由样本组装耗时场、5/10/15 分钟等时圈、面积与直线圆对照、分方位可达距离、绕行统计                                                                                                                                                                                                                                                         |
| `standards`      | 赛题口径的距离阈值：小学、菜市场、药店步行 1 km（出处写在源码注释里）                                                                                                                                                                                                                                                                    |
| `poi`            | 百度地点检索结果清洗：分类（含社区卫生、养老、公交、地铁、公园、超市）、黑名单、摊位归并、去重、出入口                                                                                                                                                                                                                                   |
| `coverage`       | 四态判定，候选剪枝，批量算路 OD 打包，结果合并（早停、`verified` 标记），灰色区域；what-if：`withNewFacility(check, { straight_m, route_m }, rule_m)` 在实测到新设施的路线后重判一项检查（实测在判定距离内即覆盖，否则保留原判定已证明的部分），`shownStatus` 给出展示状态（未核实为“待核实”）                                           |
| `names`          | 官方名录与百度名称的匹配键：`schoolKey`（去区划前缀与“民办”，校区统一：孙桥小学(张江校区) = 上海市浦东新区孙桥小学（张江校区）），`healthKey`，`roadNumber`（路名 + 号码，号与弄视为同一地点），`laneKey`（顺和路60弄）                                                                                                                  |
| `exclusions`     | 排除清单（data/official/exclusions.json）：`applyExclusions(pois, exclusions)` 按 uid（含合并的重复条目）、同类同名，或按类别（可为数组）的名称正则 `name_pattern`（NFKC 规范化后匹配，如前置仓 `^叮咚买菜`）剔除，返回剔除理由（名称规则另带 `pattern`）；`excludedByPattern()` 供融合前过滤原始检索结果，`exclusionProblem()` 校验条目 |
| `catchment`      | 对口小学：`matchCatchment(list, 小区名, 地址?)` 按弄号、小区名、名称缺期或块、名称去掉期或块匹配官方招生地段表（所有命中条目须对口同一所学校），`catchmentCovers(list, region)`，`schoolCampuses(school, pois, extra)` 找对口学校的各校区（表中不写校区时返回全部）                                                                      |
| `siting`         | 贪心最大覆盖选址（MCLP），步行距离估计 L̂，核验钩子，what-if                                                                                                                                                                                                                                                                              |
| `facility-stats` | 圈内设施统计 `facilityStats(result, { scale? })`：每类设施的清单数、15 分钟步行可达数（耗时场在入口处 ≤ 900 秒）、直线 15 分钟圆内数、最近一处的步行时间；摊位并入菜市场，同一车站的出入口算一处（`stationKey`）。`scale` = 1.17 / 0.9 得到老年人视图；实时结果把成人结果存在 `stats.facility_stats`                                     |

## 关键公式

- **绕行系数**：ρ = t · v / r ≥ 1。v = 1.17 m/s，百度批量算路的耗时恒等于 距离 / 1.17。
- **去趋势插值**：w_i = 1 / (max(d_i, 15 m)² · (1 + α·Δθ_i))，α = 1，k = 10；t̂ = max(ρ̂, 1) · r / v，自动满足 t̂ ≥ r / v。中心 40 m 内取 ρ = 1.25。
- **断裂强度**：κ = |t₁ − t₂| · v / |x₁ − x₂|。Delaunay 边满足 κ > κ*（默认 2.5）且隐含绕行 |Δt|·v − |Δx| ≥ 20 m 时记为断裂。断裂段取该边中垂线上的一段，即它的对偶 Voronoi 边，所以相邻断裂段首尾相连，桥梁处自然留出缺口。
- **加密评分**：s(x) = exp(−(t̂ − T)² / 2σ²) · (1 − e^(−d_min/60)) · (1 + β·e^(−d_bar/60))，其中 σ = max(15 s, √((r·σ_ρ / v)² + (d_min / v)²))。每轮按泊松盘间距 60 m 选 48 点。
- **收敛**：相邻两轮 15 分钟面积变化 ≤ 3%（`converged`），或对称差 ≤ 3%（`symmetricDifferenceShare`，更严格）。
- **四态判定**（D 为阈值，赛题口径 1000 m）：覆盖 L ≤ D；伪覆盖 r ≤ D < L；盲区 r > D；临界为附加标记，|L − D| ≤ 50 m。
- **选址估计**：L̂(s, d) = max( max(ρ̂(s), ρ̂(d)) · |s − d|, |t̂(s) − t̂(d)| · v )。

## 在张江样例上的结果

数据：`data/samples/zj-a.json`（申城佳苑片区）与 `research/` 下的原始响应。

- **留一法**（432 个批量算路样本）：插值 ρ 的 MAE 54.4 s、90 分位 125.3 s；直接插值时间为 57.3 s、145.4 s。
- **加断裂可见性过滤**：用公平留一法（每次去掉目标样本后重新检测断裂），MAE 50.0 s、90 分位 121.3 s。
- **重建等时圈**：15 分钟面积 1.857 km²，直线圆 3.483 km²，高估 1.88 倍，与样例一致。
- **重建判定**：由原始算路结果重建 12 个小区 × 3 类共 36 项判定，状态、路线、`verified` 和 `route_upper_bound` 全部与样例一致。
- **选址估计**：在 132 条实测的小区 → 设施路线上，1 km 判定准确率 92.4%，误判为可达 5 条。只用选址点处的 ρ̂ 时为 85.6%、15 条。
- **主动采样**（合成河道测试）：15 分钟区域错判比例从粗采样的 6.0% 降到 240 条路线后的 0.8%；不用断裂信息时为 1.7%。

## 用法

```ts
import { buildIsochrone, detectBarriers, visibilityFilter } from '@zoudedao/core';

const iso = buildIsochrone(samples); // field、contours、contours_meta、baseline、stats
const barriers = detectBarriers(samples); // 可选：断裂感知的耗时场
const iso2 = buildIsochrone(samples, { field: { visible: visibilityFilter(barriers) } });
```

盲区判定的一次完整流程见 `src/coverage.ts` 顶部注释；采样三阶段见 `src/sampling.ts` 顶部注释。

## 开发

```sh
pnpm --filter @zoudedao/core test
pnpm --filter @zoudedao/core typecheck
pnpm --filter @zoudedao/core build
```
