# @zoudedao/web · 走得到 Web

社区 15 分钟生活圈体检的主工作界面，视觉方向为「安静工作台」（见仓库根目录 `DESIGN.md`，参考样稿 `design/mockups/c-light/`）：白色面板、发丝线、一支钴蓝，整屏只让“画圈”和“走一遍”的差说话。顶栏是四个功能——**体检 / 规划 / 报告 / 问询**——和片区切换、地址或坐标搜索；左侧 400px 面板先给结论句，再给三张类别卡和体检单；右侧是百度地图底图上的步行可达图。

赛题的五步在界面上各有落点：

| 赛题要求                     | 界面                                                                                                |
| ---------------------------- | --------------------------------------------------------------------------------------------------- |
| 输入中心点坐标               | 顶栏搜索框输入地址或经纬度（选择 百度 BD-09 / 高德·腾讯 GCJ-02 / GPS WGS-84），或在地图上点选中心   |
| 基于真实路网的 15 分钟等时圈 | 暖沙色的步行可达范围（越近越浓），5′ / 10′ 细等时线与 15′ 边线，与直线画的 15′ 圈（灰色细虚线）对照 |
| 统计圈内各类民生设施覆盖情况 | 「体检」里的「圈内设施」：每类设施直线圈里有几处、15′ 真正走得到几处、最近一处要走几分钟            |
| 可视化体检报告               | 「报告」：A4 版式，含报告自己绘制的地图、结论、各张表与方法说明，可打印 / 存为 PDF                  |
| 标注设施匮乏的灰色区域       | 地图右上角图层开关里的「灰色区域」，图例写明判定规则；报告里按缺失类别数分级列出面积和涉及的小区    |

技术栈：React 19、Vite 8、TypeScript（strict），不使用 UI 组件库；底图为百度地图 JSAPI 4.0（WebGL）。

![桌面端 1440×900 · 申城佳苑片区](screenshots/desktop.png)

## 运行

需要 Node ≥ 22.12 和 pnpm 10。在仓库根目录执行：

```bash
pnpm install
pnpm --filter @zoudedao/web dev      # 只启动 Web：http://localhost:5173
pnpm dev                             # 同时启动服务端（8787）和 Web
```

其他命令：

```bash
pnpm --filter @zoudedao/web typecheck
pnpm --filter @zoudedao/web test     # 数字推导、版面规则（代号不被遮挡、注记不压代号与锚点）、按所选类别着色、老人 810 m 直线圈、顶栏与面板、地图印刷顺序、圈内设施、问询排版与出处锚点、流式体检、实测核验与分支、步行路线证据、体检历史、路演六步、GeoJSON（接口一律用模拟的 fetch）
pnpm --filter @zoudedao/web build    # 产物在 apps/web/dist，服务端会直接托管它
pnpm exec eslint apps/web
```

测试在 Node 里运行，`@zoudedao/core` 按 `source` 条件直接读源码（与页面一致，`vite.config.ts` 的 `ssr` 设置），不依赖 `packages/core/dist`。

`/api` 默认代理到 `http://localhost:8787`；同一台机器上并行跑第二份检出时，可以用 `ZDD_API_PROXY=http://127.0.0.1:8788 pnpm --filter @zoudedao/web dev --port 5174` 指向它自己的服务端。

## 环境变量

只需要一个：浏览器端 AK。写在**仓库根目录**的 `.env.local`（`vite.config.ts` 的 `envDir` 指向根目录）：

```bash
VITE_BAIDU_BROWSER_AK=你的浏览器端AK
```

- 只有 `VITE_` 开头的变量会进入浏览器代码，服务端 Key（`BAIDU_SERVER_AK`、`BAIDU_SERVER_SK` 等）不会被打包。
- 这个 AK 只用于加载 JSAPI 脚本和瓦片，Web 端不调用任何百度 Web 服务接口（地理编码、坐标转换、算路都在服务端）。
- 请在百度控制台为这个 AK 设置 Referer 白名单，例如 `localhost*,127.0.0.1*,你的域名*`。

没有配置 AK 时页面照常可用，会自动使用离线底图（见下文）。

## 数据：API 模式与内置样例

页面启动时按顺序取数据：

1. `GET /api/samples`，再 `GET /api/analysis/<id>`（开发时由 Vite 代理到 `http://localhost:8787`）。默认样例为 `zj-a`，可用 `?sample=<id>` 指定。
2. 服务端不可达、返回错误或数据结构不完整时，改为读取随应用打包的 `data/samples/zj-a.json`（构建后为 `dist/assets/zj-a-*.json`）。因此只部署静态文件也能完整演示；面板页脚会写明“未连接服务端，数据来自内置样例文件”。

顶栏的片区按钮显示当前片区的字母和名称（A 申城佳苑片区）。下拉菜单来自 `GET /api/history`：上面是服务端保存的最近实时体检（「实时」、名称、时间与中心、老人步速时注明），下面是四个样例；每一行右侧是它的标题数字“画圈 1 → 走一遍 8”（画圈 = 直线也超出规则的盲区，走一遍 = 全部已核实缺口，随所选口径切换赛题 / 国标）。选中实时体检时按编号读回 `GET /api/analysis/live-…`（不重新体检、不耗配额），网址变为 `?analysis=live-…`，刷新后仍是它。旧版服务端没有历史接口时，菜单只列样例。界面上的每个数字都由数据现场计算，没有写死的文案数字。

![片区菜单：最近的实时体检与样例](screenshots/history-desktop.png)

## 体检

![圈内设施](screenshots/facilities-desktop.png)

- **结论句**：“画圈只找到 1 个缺口，/ 走一遍找到 8 个，画圈漏掉 7 个。”数字放大、只有“漏掉”的数字是红色；下面一行状态签（伪覆盖、盲区、待核不计入）。读屏软件读到的是完整的一句（含口径）。
- **口径**：地名右侧「赛题 1 公里 / 国标 GB 50180」。四个样例都带 `checks_gb`；缺少国标数据的结果会如实说明并仍按赛题口径显示。
- **三张类别卡**（小学、菜市场、药店）：走得到的小区数 / 小区总数、一句话、每个小区一格的色条。卡片是单选：**选中的类别同时决定体检单和地图**——地图上的小区按这一类的判定着色（伪覆盖红、盲区石板灰、覆盖青绿、临界琥珀点线、待核灰虚线），只画这一类设施并标出名称。
- **体检单**：每个小区一根“哑铃”，空心圆是直线距离、实心点是百度实测步行距离，跨过规则线的一段就是缺口；右侧为步行分钟（临界显示米数，≤ 为路线上限，≥ 为下限）。右上角可切换为表格（小区 × 三类的分钟）。行与地图上的小区代号互相高亮。
- **圈内设施**：每类设施一行，方格表示直线圈里的每一处（实心 = 15′ 走得到，虚线 = 画圈有、走不到），右边是走得到 / 圈里的数和最近一处的分钟。地图上画出直线圈里或 15′ 内的全部设施，走不到的画成虚线圈。
- **老人步速**：地图下方「走一遍」卡片右侧切换成人 4.2 / 老人 3.2 km/h。选老人时，地图上的直线圈、它的标签、读数（直线圈 2.06 km²，圈里 X% 走不到）、圈内设施的计数都按 900 秒 × 0.9 m/s = **810 m** 计算。
- **含过街等待 +5%**（步速下方的小开关）：敏感性估算。百度轻量步行路线计入了过街等待，比按距离算的时间长约 3–7%，打开后步行时间加 5%，只改变耗时色阶、等时线、分钟标签和「走一遍」的读数（读数加 ≈），**不改变任何判定**（判定按距离），直线圈也不变。
- **对口小学**：小区带官方对口地段（`communities[].catchment`，目前为张江镇）时，悬停代号（小学类别下）、体检单行的读屏标签和步行路线卡片都会写出“对口：孙桥小学（申江校区）· 步行 1,676 m”——对口学校不一定是最近的学校。

### 步行路线证据

![步行路线证据：A-11 到孙桥小学（申江校区）](screenshots/evidence-desktop.png)

点地图上的小区代号、体检单（或表）的一行，或那张伪覆盖注记卡片，地图就画出**这个小区在所选类别上的判定所依据的真实步行路线**（`GET /api/route`）：从小区走到判定经由的设施，墨色实线加白色衬边，600 ms 画出；旁边是小区到设施的直线（细虚线），两端都有标记。卡片写明“直线 819 m · 实际步行 1,676 m / 约 24′（百度步行路线）”，分钟按实测步速换算（老人、含过街等待时随之变化）；路线与判定用的批量算路相差超过 20 m 时另写一行。Esc 或卡片上的 × 关闭，切换类别、口径或片区时自动关闭；地图会平移到能看全这条路线的位置。

- 路线还在取时卡片写“正在取百度步行路线…”，直线先画出来；取不到时如实说明原因：样例模式下没有保存过的路线（“查询新的路线需要服务端配置百度 Key”）、这一项没有单独算路（待核）、直线就已超出规则而不需要算路（盲区的下限）、设施清单里没有这一类。四个样例赛题口径全部已核实的伪覆盖路线都随样例保存，演示时不调用百度；live 模式下查询新路线会消耗轻量步行路线配额（每条只查一次，之后永久保存）。
- 没有服务端的静态部署读取随应用打包的 `data/samples/routes/zj-a.json`，样例 A 的伪覆盖路线照样能画。
- 手机上卡片停靠在地图底部（取代「走一遍」卡片的位置）。

![国标口径](screenshots/gb-desktop.png)

### 地图

- 左上角图例（当前类别与规则、出现的状态；圈内设施时为设施图例；打开灰色区域或采样点时加项），右上角图层开关（直线圈 / 耗时色阶 / 灰色区域 / 采样点与阻隔），左下「走一遍」卡片（主操作、时间滑杆、读数、步速、含过街等待），右下比例尺与出处（底图 © 百度地图、审图号、步行路线实测日期、小区轮廓 © OpenStreetMap）。
- **注记**：最多两张白色卡片，边框用状态色，各带一个实测数字：一条百度实测步行路线（数据标明障碍时取它，否则取绕行最大的一条：“正东 996 m，要走 2,102 m……15′ 向东只走得到 470 m”），以及所选类别里最能说明问题的小区（最长的伪覆盖，否则最长的盲区）。圈内设施视图下改为一处“画圈有、15′ 走不到”的设施。卡片按样稿的代价搜索摆在锚点附近，**不压任何小区代号、你在这里、控件和自己的锚点**，引线避开代号和标记。
- **名称**：小区代号旁写小区名（同名的几期只写期号，组名在它们上方写一次）；百度底图的路名、地名、小区名、楼宇名以更轻的灰色显示。代号永远优先：标记、名称、分钟标签、注记都给代号让位。**百度的名字给我们的让位**：个性化样式的规则没有空间范围（不能只在研究圈里隐藏百度的小区名），所以每个代号、名称、标签和卡片的位置都以一个透明的百度底图标注（`map.addMapLabels`，最高优先级）占住，百度按自己的避让规则去掉与它们相撞的名字——同一小区的重复名称（“玉兰香苑3期”两遍）、被代号压住一半的名字都不再出现，其余路名地名照常显示。地图停稳 250 ms 后更新。

![密集片区的注记：百度的名字给代号和小区名让位](screenshots/labels-closeup.png)

- **灰色区域**：浅灰平涂（缺得越多越深）加灰色虚线边，没有网点；图层默认关闭，`#gray` 可在载入时打开。
- **采样点与阻隔**（方法图层，给评委看测量方法）：百度批量算路的采样点与轻量步行路线的折点（两种低饱和的小点）、步行路线本身（细暖色线）、从样本之间矛盾的耗时推断出的阻隔段（细深色线）；图例写出各自的数量（如“批量算路 240 · 步行路线 146 · 阻隔 170 段”，没有检出时写“未检出阻隔”）。默认关闭，`#method` 可在载入时打开。
- 「走一遍」进行中，小区、代号和体检单都不显示判定（判定在 15′ 时落下），读数与滑杆随动画走。`#play` 载入后自动开始。已在无头 Chrome 里实测过动画本身（不只是截图）：3.4 秒内 0′→15′，帧间隔稳定在 16.7 ms（没有超过 50 ms 的帧），进行中 12 个代号全部不显示判定、没有注记卡片，15′ 时判定、图例与卡片一起落下。
- 动效克制：卡片、菜单与面板内容 150–200 ms 淡入上移，路线 600 ms 画出，你在这里一圈缓慢的柔和脉冲；系统开启“减少动态效果”时全部关闭（走一遍直接到 15′）。

![采样点与阻隔（玉兰香苑片区）](screenshots/method-desktop.png)

![老人步速：直线圈 810 m](screenshots/elder-desktop.png)

## 选中心：地址、坐标、地图点选

### 搜索框

- **样例模式**（服务端 `mode: "sample"` 或未连接服务端）：`GET /api/locate` 只在样例社区的名称和中心点标注中查找，不检索任意地址、不重新算路，并在搜索框下方的提示里说明。
- **live 模式**：`GET /api/locate` 定位地址；有歧义时列出候选；确定中心后通过 `POST /api/analyze`（SSE 流）进行实时体检。
- **经纬度**：输入框读得出一对经纬度时（逗号或空格分隔、全角标点、带括号、纬度在前都可以），下拉层里出现坐标系选择：**百度 BD-09**（默认）/ **高德·腾讯 GCJ-02** / **GPS WGS-84**，回车后换算（live 模式为百度坐标转换，样例模式或服务端不支持时为公开公式，并如实写明）。样例模式下切换坐标系会立即重算落点。
- `?center=<lng>,<lat>&label=<名称>`：在 live 模式下打开页面即开始对该中心点体检（BD-09 坐标）。

![输入坐标 · 选择坐标系](screenshots/coords-desktop.png)

### 地图点选

live 模式下点击地图放下钴蓝圆标，旁边弹出确认卡「以此为中心体检」+「取消」（实时体检消耗配额，所以先确认）。确认卡不压任何小区代号；窄地图（手机）上停靠在「走一遍」卡片上方的位置，百度 Logo 随之上移。Esc 取消并把焦点还给原处。样例模式同样放下圆标，并说明不重新计算。

![地图点选](screenshots/confirm-desktop.png)

### 实时体检的流式显示

实时体检进行中，左侧面板改为“测量中”：阶段阶梯、各阶段已实测的样本数与路径数、每轮采样后 15′ 可达面积对直线圈的柱状图、当日配额；地图逐轮画出已测的样本点（刚测到的一批为钴蓝）、路径和收紧中的可达范围；「走一遍」卡片的位置换成阶段卡。判定等体检完成后一起落下。开发时可用 `?fakeStream=<样例>`（可加 `&hold=refine2` 停在某一阶段）把一个样例按引擎的节奏回放成事件流，**不会请求 `/api/analyze`**；截图脚本通过 `window.__zddRun()` 启动它。

![流式体检](screenshots/stream-desktop.png)

## 规划

![规划：假如在这里开一家菜市场](screenshots/plan-desktop.png)

- 类别卡同体检；下面是「假如在这里开一家…」：点「在地图上选位置」后点击地图，立即用 `@zoudedao/core` 的 `siteCoverage` 和这次体检自己的绕行系数场（`fieldEstimator`）估算哪些小区能因此进入规则距离——结果标「估算」，地图上从新位置连线到这些小区，它们的代号带一个青绿色对勾。
- **实测核验**只在 `/api/health` 为 `mode: "live"` 且 `analyzer: "engine"` 时可用，调用 `POST /api/whatif` 实测这些步行路线，结果改标「已核验」；其他情况下按钮停用并写明原因。服务端把每次实测保存为这次体检的一个**分支**（`branch_id`），卡片下方写明“已保存为这次体检的分支 wi-…”。
- **已保存的实测模拟**：`GET /api/analysis/:id/branches` 列出这次体检上做过的实测（类别、因此走得到的小区数、时间、实测路线数、已核验）；点一条，它的位置、类别（和口径）与实测结果回到地图和卡片上，不再调用百度。
- 下面是体检结果自带的建议选址（`site_suggestions`，贪心最大覆盖），与地图上的编号图钉一一对应。结果本身没有建议时（样例 A 由较早版本的程序生成），用同样的方法——`@zoudedao/core` 的 `suggestSites`，候选点取步行路线上每 50 米一处，按这次体检的绕行系数场判定——在浏览器里估算，标题旁写明，全部标「估算」。

## 报告（A4，打印 / 存为 PDF）

![体检报告 · 屏幕上](screenshots/report-desktop.png)

顶栏的「报告」，或在网址上加 `?report`（如 `?sample=zj-b&report`），把整次体检排成一份 A4 竖版报告；点其他功能或浏览器后退回到工作台。报告上方的「下载 GeoJSON」把这次体检导出为一个 FeatureCollection：5′ / 10′ / 15′ 等时圈、直线 15′ 圈、小区（有轮廓时为面，否则为点，带所选口径下三类设施的判定、直线与步行距离、经由设施和对口小学）、设施点和灰色区域；坐标为 WGS-84（RFC 7946），由 BD-09 经 `@zoudedao/core` 的公开公式换算（误差约数米），`metadata` 写明口径、实测日期和数据来源。报告只用这次体检的数据，每个数字都现场计算：

1. **封面**：标志、地名与片区字母、实测与报告日期、步速、规则；结论两句；关键数字一行（15′ 真正走得到、直线圈、高估倍数、等效步行半径）；报告自己绘制的地图（每个小区取三类里最重的一项着色）与图例。
2. **圈内设施**、3. **小区 × 小学、菜市场、药店**（每格步行分钟与米数、直线距离、状态字，状态用平涂浅色与边线）、4. **灰色区域**（按缺失类别数分级）、5. **规划建议**、6. **方法与局限**。

报告里的地图不是百度瓦片（瓦片画布无法可靠导出），而是按体检数据重新绘制，与屏幕上同一套 `ScenePainter` 和版面规则，画布按 3 倍分辨率绘制；有 OSM 预览图层的样例会画出街道、水系、高架和地名。打印样式：A4 竖版，封面单独一页，其后各页上下留白，页眉为报告标题，页脚为页码；表格跨页时重复表头。用无头 Chrome 直接生成 PDF（需先 `build`，再用 `vite preview` 或服务端托管 `dist`）：

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --no-pdf-header-footer \
  --virtual-time-budget=15000 --print-to-pdf=report.pdf "http://localhost:4173/?sample=zj-b&report"
```

样张：[`screenshots/report-zj-b.pdf`](screenshots/report-zj-b.pdf)（玉兰香苑片区）。

## 问询（AI 体检顾问）

![问询 · 点开出处，地图标出它提到的小区与设施](screenshots/advisor-desktop.png)

「问询」把面板换成问询台：地名和一行结论始终在上方，下面是服务端 `/api/health` 报告的模型名（如“大模型 deepseek-flash 组织语言”）、建议问题和问答记录，输入框在底部。问询调用 `POST /api/ask`（见 `docs/api.md`），回答的是屏幕上正在看的这次体检：

- 回答里的数字（连同单位）用数字字体，`[T1]` 这样的出处显示为小码牌，悬停或点按可以核对工具结果；提到的小区带代号，悬停时地图上对应小区高亮；每个回答下方写明依据、由模板还是哪个大模型组织、数字溯源校验结果。
- **出处落到地图上**：每个工具结果带 `anchors`（它提到的小区、设施、灰色区域、模拟的新设施位置）。悬停出处码牌，地图上这些地方随之标出——小区代号和轮廓点亮，设施画出它自己的图标、钴蓝圈和名称，灰色区域描出虚线边，模拟位置放一个虚线图钉；点开码牌则固定下来，并把它们平移进视野；地图上方出现一个小标签，写明是哪条出处、标出了什么，× 或 Esc 取消（手机上地图在回答上方，点开时页面滚回地图）。来源卡片第一行写明“地图上标出 2 个小区、1 处设施”，过长的工具结果在卡片里滚动。回答的是另一个片区时不标（坐标属于另一个坐标系）。
- 大模型的数字都能溯源、只是漏标了出处时，服务端补上的编号（`citations_added`）在校验行末尾轻声写“已补标出处”，悬停可见补了哪些。
- 回答期间“提问”变成“停止”，Esc 同样可以中止；静态部署或未连接服务端时说明原因并停用输入框。问询不发起新的体检，不消耗地图配额。

## 路演模式

![路演模式 · 第 3 步：伪覆盖一例](screenshots/tour-desktop.png)

顶栏的「演示」（或网址加 `?tour`，`?tour=3` 从第 3 步开始）把这次体检讲成六步，给投影仪用：全屏（浏览器允许时）、大字号，左侧一张步骤卡，地图在右侧取景：

1. **画圈**：只有直线圈（半径、面积），小区不着色——按直线距离能找到几个缺口；
2. **走一遍**：从 0′ 走到 15′ 的动画，真正走得到的面积和它占圈的比例，找到几个缺口、画圈漏掉几个；
3. **伪覆盖一例**：绕行最长的伪覆盖，地图画出它的真实步行路线（样例路线都已保存，不调用百度）；没有伪覆盖的片区改讲一个盲区；
4. **圈内设施**：直线圈里有几处民生设施、15′ 走得到几处，以及差得最多的一类；
5. **灰色区域**：缺至少一类必需设施的面积、涉及的小区，缺两类以上的部分；
6. **规划建议**：能让最多小区走得到的建议选址（估算的写明估算）。

每一步的数字都由当前体检现场计算，四个样例和任意实时体检都能讲。← / → 翻页（也可 PageUp / PageDown、空格），Home / End 到首尾，Esc 退出（退出后恢复原来的功能、类别和图层）；系统开启“减少动态效果”时第 2 步直接到 15′。手机上步骤卡停靠在屏幕下方。

## 说明（顶栏 ?）

顶栏的「?」打开一张简短的说明：四种判定（伪覆盖、盲区、临界、待核）各是什么意思，赛题口径与国标口径的区别，数据来源与日期（实测日期、官方名录及其发布日期、OpenStreetMap 快照日期都从这次体检的 `meta.attribution` 读出），以及怎么输入地址或坐标、在地图上点选中心、画出步行路线、进入路演。Esc 或点别处关闭。

![说明](screenshots/help-desktop.png)

## 底图：百度 JSAPI 4.0

- 脚本地址为 `https://api.map.baidu.com/api?v=4.0&ak=…&callback=…`，加载器见 `src/map/loadBaidu.ts`。
- 地图正北朝上，禁用倾斜和旋转。**缩放取整数级**：百度 GL 只在整数级别上清晰地绘制注记字形，所以 `fit()` 取能容下构图跨度（桌面短边 2,500 m，窄地图 2,150 m）的最大整数级，构图用中心偏移（分析中心位于视图中心以西 300 m）而不是小数缩放来完成。
- **百度图层不做任何混合**：路名和地名字形保持清晰。暖沙色的步行时间场与灰色区域画在它上面自己的画布上，以 `mix-blend-mode: multiply` 叠加；颜色按“样稿颜色 ÷ 地面颜色”换算，在空地上印出与样稿一致的色调（`map/paint.ts` 的 `multiplied`）。
- **个性化样式**（`src/map/signMapStyle.ts`）为普通颜色：地面 #EEF0F1、水体 #C9DCEC、绿地 #D9E9D4、白色街道、高架与 S20 为灰色带；路名、地名、小区名、楼宇名为较轻的灰色（#5B6675 左右）加白色描边，POI 图标全部关闭，地图上的设施只用本应用自己的标记。
- 百度 Logo 保持可见，位于「走一遍」卡片（或停靠在那里的确认卡、路线卡片）上方；路演模式在步骤卡右侧的地图底边。使用个性化样式时 JSAPI 会隐藏版权文字控件，所以界面从这个控件读出审图号，写进右下角的出处。
- 百度的路名地名给本应用的代号、名称和标签让位（透明的底图标注，`addMapLabels`），见上文「地图 · 名称」。
- 叠加层与底图同步：每一帧用 `pointToPixel` 读出当前投影，拖动、缩放和容器尺寸变化时都会重绘；叠加画布按 `devicePixelRatio` 绘制。

### 离线底图（降级）

以下任一情况会自动改用自绘底图（样例数据里的 `base` 图层：OpenStreetMap 道路、水系、用地、地名），画法与样稿相同，路名、水系名、地名按碰撞检测排布，给代号和注记让位：未配置 `VITE_BAIDU_BROWSER_AK`；浏览器不支持 WebGL；JSAPI 脚本加载失败或 12 秒内未就绪；地图已创建但 15 秒内没有瓦片。也可以用 `?basemap=offline` 手动打开。离线时出处写明原因。

![离线底图](screenshots/offline.png)

## 手机（390 宽）

地图在前、面板在后：顶栏两行（标志、片区、搜索、说明、演示；四个功能），地图约占 2/3 屏高，「走一遍」卡片分两行；图层开关和出处放在地图下方；随后是结论、类别卡与体检单。窄地图上不放注记卡片、小区名和次要设施，只保留 15′ 分钟标签；步行路线卡片停靠在地图底部，片区菜单与说明铺满屏宽。

![手机](screenshots/mobile.png)

手机上的新视图：[步行路线证据](screenshots/evidence-mobile.png) · [片区菜单](screenshots/history-mobile.png) · [采样点与阻隔](screenshots/method-mobile.png) · [路演第 3 步](screenshots/tour-mobile.png) · [说明](screenshots/help-mobile.png) · [问询出处](screenshots/advisor-mobile.png)

## 截图

`scripts/shot.mjs` 用无头 Chrome 把页面放进一个精确尺寸的 iframe，等待 `<html data-zdd-ready="baidu|offline|report">`（瓦片、叠加层和网页字体都已就绪）后截图：

```bash
node apps/web/scripts/shot.mjs http://localhost:5173/ apps/web/screenshots/desktop.png 1440 900 2
node apps/web/scripts/shot.mjs http://localhost:5173/ apps/web/screenshots/mobile.png 390 auto 2
```

脚本参数最后可以附一段在截图前执行的 JavaScript。几个状态：

```bash
# 圈内设施 / 灰色区域：网址加 #facilities 或 #gray
node apps/web/scripts/shot.mjs "http://localhost:5173/?sample=zj-a#facilities" apps/web/screenshots/facilities-desktop.png 1440 900 2
# 国标口径 / 老人步速
GB="(async()=>{document.querySelectorAll('.rules button')[1].click();await new Promise(r=>setTimeout(r,800))})()"
ELDER="(async()=>{document.querySelectorAll('.profile button')[1].click();await new Promise(r=>setTimeout(r,900))})()"
# 规划：放下一个“假如在这里开一家…”（只估算，不实测）
WHATIF="(async()=>{[...document.querySelectorAll('.mode')].find(b=>b.textContent==='规划').click();await new Promise(r=>setTimeout(r,500));document.querySelector('.whatif .btn').click();await new Promise(r=>setTimeout(r,300));window.__zddPick(121.63610,31.20930);await new Promise(r=>setTimeout(r,900))})()"
# 输入 WGS-84 坐标（不回车，只看坐标系选择）
CRS="(async()=>{const i=document.querySelector('.search input');i.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,'121.632080, 31.204548');i.dispatchEvent(new Event('input',{bubbles:true}));await new Promise(r=>setTimeout(r,200));document.querySelectorAll('.seg.crs button')[2].click();i.focus()})()"
# 地图点选的确认卡：开发标记 ?fakeLive 让页面按 live 模式显示界面，确认也不会发起体检
CONF="(async()=>{window.__zddPick(121.643807,31.203506);await new Promise(r=>setTimeout(r,700))})()"
# 流式体检（假事件流，不请求 /api/analyze）：?fakeStream=zj-b&hold=refine2
STREAM="(async()=>{window.__zddRun('玉兰香苑 · 实时体检（演示）');await new Promise(r=>setTimeout(r,6000))})()"
# 问询：打开问询，点第 2 个建议问题，等回答出现（需要运行中的服务端）
ASK="(async()=>{[...document.querySelectorAll('.mode')].find(b=>b.textContent==='问询').click();await new Promise(r=>setTimeout(r,300));document.querySelectorAll('.ask-suggest button')[1].click();for(let i=0;i<600&&!document.querySelector('.ask-body');i++)await new Promise(r=>setTimeout(r,100))})()"
node apps/web/scripts/shot.mjs "http://localhost:5173/?sample=zj-b" apps/web/screenshots/plan-desktop.png 1440 900 2 "$WHATIF"
node apps/web/scripts/shot.mjs "http://localhost:5173/?sample=zj-b&fakeLive" apps/web/screenshots/confirm-desktop.png 1440 900 2 "$CONF"
SHOT_SETTLE_MS=1500 node apps/web/scripts/shot.mjs "http://localhost:5173/?sample=zj-b&fakeStream=zj-b&hold=refine2" apps/web/screenshots/stream-desktop.png 1440 900 2 "$STREAM"
# 步行路线证据：点 A-11（样例已保存的路线，不调用百度）
EV="(async()=>{document.querySelector('.m-code[aria-label^=\"A-11\"]').click();await new Promise(r=>setTimeout(r,1800))})()"
# 片区菜单（体检历史）、说明
HIST="(async()=>{document.querySelector('.area-btn').click();await new Promise(r=>setTimeout(r,700))})()"
HELP="(async()=>{document.querySelector('.help-btn').click();await new Promise(r=>setTimeout(r,500))})()"
# 问询：提问后点开出处 T2，地图标出它提到的地方（需要运行中的服务端）
ASKPIN="(async()=>{[...document.querySelectorAll('.mode')].find(b=>b.textContent==='问询').click();await new Promise(r=>setTimeout(r,300));document.querySelectorAll('.ask-suggest button')[0].click();for(let i=0;i<900&&!document.querySelector('.ask-body');i++)await new Promise(r=>setTimeout(r,100));const w=[...document.querySelectorAll('.ask-src .src')].find(s=>s.textContent.includes('服务缺口清单'))?.querySelector('.cite')?.textContent;const c=[...document.querySelectorAll('.ask-body .cite')];(c.find(x=>x.textContent===w)||c[0]).click();await new Promise(r=>setTimeout(r,1500));scrollTo(0,0)})()"
node apps/web/scripts/shot.mjs "http://localhost:5173/?sample=zj-a" apps/web/screenshots/evidence-desktop.png 1440 900 2 "$EV"
SHOT_SETTLE_MS=1800 node apps/web/scripts/shot.mjs "http://localhost:5173/?sample=zj-b#method" apps/web/screenshots/method-desktop.png 1440 900 2
SHOT_SETTLE_MS=1500 node apps/web/scripts/shot.mjs "http://localhost:5173/?sample=zj-a&tour=3" apps/web/screenshots/tour-desktop.png 1440 900 2
```

`?fakeLive`、`?fakeStream`、`window.__zddPick(lng, lat)`（按 BD-09 坐标模拟一次地图点击）与 `window.__zddRun()` 只在开发构建中存在。`?tour[=步]`、`?analysis=live-…`、`#method`、`#gray`、`#facilities`、`#play` 在正式构建中同样可用。

## 字体

全部自托管，均为 OFL 授权：文字为 Noto Sans SC 400 / 500 / 700（`@fontsource`，按 unicode-range 分片，只下载页面实际用到的字形——小区名、设施名和问询回答无法事先穷举，所以不做固定子集）；数字为 “Barlow Num”：Barlow 500 / 600 加 Noto Sans SC 自己的分钟符号 ′（Barlow 的 ′ 过宽），见 `src/fonts.ts`。离线底图的画布文字等字体载入后重绘。

## 目录

```
src/
  App.tsx            取数据（API → 内置样例；?analysis= 读回实时体检）、体检历史、live 体检流程、?report 视图
  Screen.tsx         界面状态、「走一遍」动画、步行路线证据、规划（估算、实测核验与分支）、问询出处的地图标注、路演模式、体检屏与报告的切换
  centre.tsx         选中心：地址与坐标搜索、地图点选、确认，以及搜索框下的提示
  state.ts           状态与动作
  model/             推导（编号、判定、结论数字、注记用的路线与小区）、口径、圈内设施、灰色区域、选址（含浏览器端估算）、小区外观、
                     步行路线证据的数字（evidence.ts）、出处锚点（spots.ts）、路演六步（tour.ts）、GeoJSON 导出（geojson.ts）
  geo/               局部坐标系反算、视图（米 → 像素）、耗时场栅格与等值线
  map/               百度底图与样式（含给本应用让位的透明标注）、画布印刷（paint.ts，含方法图层）、离线底图注记（baseLabels.ts）、
                     版面规则（layout.ts）、注记（findings.tsx）、路线卡片（evidenceCard.tsx）、路线与出处图层（EvidenceLayer.tsx）、地图面板与叠加层
  components/        顶栏（片区菜单、说明、演示）、面板、结论句、类别卡、体检单（图与表）、圈内设施、规划（含已保存的实测）、流式体检、问询台、
                     路演卡片（Tour.tsx）、说明（Help.tsx）、地图控件、图形符号
  report/            体检报告（Report.tsx）、报告地图（ReportMap.tsx）、屏幕与打印样式（report.css，按需加载）
  advisor/answer.ts  问询回答的排版模型
  data/              /api 客户端（样例、分析流、问询流与锚点、实测核验、步行路线 route.ts、体检历史与分支 history.ts、定位与坐标）、功能开关（gates.ts）
scripts/shot.mjs     截图工具
screenshots/         1440×900 与 390 宽手机截图（@2x）；报告 PDF 样张。新增：evidence-*、history-*、method-*、tour-*、help-*（*-desktop / *-mobile）
```
