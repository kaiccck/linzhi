/**
 * The 体检报告 (技术设计文档 §8.3): a structured model and its Chinese Markdown rendering. Both are
 * pure functions of the AnalysisResult: the same result always renders the same report, and every
 * number in it can be traced back to a field of the result.
 */
import type { AnalysisResult, HardCategory, LngLat } from '@zoudedao/core';
import { viaName } from '@zoudedao/core';
import { HARD_CATEGORIES, checkRows, describePlace, isPending, toBd09 } from './analysis.js';
import { beijingDate, fmtNumber } from './format.js';
import { communitiesWithGaps, gapRows, pendingRows, type GapRow, type PendingRow } from './rows.js';
import { siteSuggestionsOf } from './siting.js';
import { overview, provenance, type FacilityOverview, type Overview } from './summary.js';
import type { ZddMeta } from './types.js';

export interface ReportSuggestion {
  rank: number;
  place: string;
  center_bd09: LngLat;
  covers: { community: string; est_m: number; route_m?: number }[];
  verified: boolean;
}

export interface ReportModel {
  title: string;
  analysis_id: string;
  overview: Overview;
  /** One sentence, conclusion first. */
  verdict: string;
  communities_with_gaps: { community: string; missing: HardCategory[] }[];
  gaps: GapRow[];
  pending: PendingRow[];
  /** The clearest verified 伪覆盖 (largest walk / straight ratio), to explain the term. */
  pseudo_example: {
    community: string;
    category: HardCategory;
    facility: string;
    straight_m: number;
    route_m: number;
  } | null;
  siting: {
    category: HardCategory;
    source: 'analysis' | 'estimated' | 'none';
    demands: string[];
    suggestions: ReportSuggestion[];
  }[];
  method: string[];
  sources: string[];
  limitations: string[];
  /** Communities have outlines (sample data); live results only know gates. */
  outlines: boolean;
  /** How far the gray areas reach, in words (samples with outlines state their halo in meta.notes). */
  gray_scope: string;
}

const m = (v: number, digits = 0) => `${fmtNumber(v, digits, true)} m`;
const pct = (v: number) => `${fmtNumber(v, 1, true)}%`;
const dateOf = (iso: string) => beijingDate(iso) ?? iso;
const hasCjk = (s: string) => /[一-鿿]/.test(s);

function verdictOf(o: Overview, withGaps: number): string {
  const h = o.headline;
  if (!h.checks) return `${o.name}：本次分析没有小区设施检查结果，只能评估步行等时圈。`;
  const lead = withGaps
    ? `${o.name}的 ${h.communities} 个小区中，有 ${withGaps} 个步行 ${o.rule_text} 内缺少至少一类必需设施（小学、菜市场或药店）`
    : `${o.name}的 ${h.communities} 个小区，在已核实的检查中步行 ${o.rule_text} 内都能走到小学、菜市场和药店`;
  let circle = '';
  if (h.walking_gaps && h.missed_by_circle) {
    circle = `；画圆法只找到 ${h.straight_gaps} 个缺口，按实测步行距离已核实 ${h.walking_gaps} 个，画圆漏掉了其中 ${h.missed_by_circle} 个（${pct(h.missed_share_pct ?? 0)}）`;
  } else if (h.walking_gaps) {
    circle = `；按实测步行距离已核实 ${h.walking_gaps} 个缺口`;
  }
  const pending = h.pending ? `；另有 ${h.pending} 项待核实` : '';
  return `${lead}${circle}${pending}。`;
}

function methodLines(result: AnalysisResult, o: Overview): string[] {
  const s = o.sampling;
  const rm = s.by_src.routematrix;
  const dl = s.by_src.directionlite_path;
  const parts: string[] = [];
  const from = [
    rm ? `百度批量算路 ${fmtNumber(rm)} 条` : '',
    dl ? `轻量步行路线的路径点 ${fmtNumber(dl)} 个` : '',
  ]
    .filter(Boolean)
    .join('、');
  parts.push(
    `等时圈：以分析中心为起点的 ${fmtNumber(s.samples)} 个步行耗时样本${from ? `（${from}）` : ''}，插值绕行系数 ρ（步行距离 ÷ 直线距离）而不是时间（去趋势插值），在 ${fmtNumber(result.field.cell_m)} m 栅格上提取 5、10、15 分钟等值线。` +
      (s.loo_mae_s !== null
        ? `留一法检验：耗时平均绝对误差 ${fmtNumber(s.loo_mae_s, 1, true)} 秒${s.loo_p90_abs_err_s !== null ? `，90 分位 ${fmtNumber(s.loo_p90_abs_err_s, 1, true)} 秒` : ''}。`
        : ''),
  );
  parts.push(
    `画圆法对照：以分析中心为圆心、半径 ${m(o.isochrone.circle_r15_m)}（900 秒 × ${fmtNumber(o.speed_mps, 2, true)} m/s）的直线 15 分钟圆。`,
  );
  parts.push(
    `设施可达：从每个小区出发，对直线距离在判定距离内的候选设施做批量算路（步行距离不会短于直线距离，更远的候选不必算）。判定距离按赛题口径 1 km：步行最短距离不超过判定距离为覆盖；直线在判定距离内、步行超出为伪覆盖；直线就已超出为盲区；步行距离与判定距离相差不超过 50 m 另标临界。菜市场、药店、小学任一类缺失，即记为该小区的服务缺口。`,
  );
  parts.push(
    '待核实：还有更近的候选设施没有从该小区算路，实际最短步行可能更短。这些检查单独列出，不计入缺口，也不画结论颜色。',
  );
  if (o.facilities) {
    parts.push(
      '圈内设施：对清单里的每处设施，在耗时场上读出从分析中心走到它入口的时间，不超过 15 分钟即为步行可达；与直线 15 分钟圆内的数量对照。菜场摊位并入菜市场，同一地铁站或公交站的各出入口算一处。',
    );
  }
  if (o.gray_areas.length) {
    parts.push(
      '灰色区域：把每个位置交给离它最近的小区，按该小区已核实的判定数缺了几类必需设施，栅格化后提取“缺至少 1 类、2 类……”和“有伪覆盖”的范围；未核实的判定不计入。',
    );
  }
  parts.push(
    '规划建议：候选点取实测步行路径上每隔 50 m 的点和各小区位置，用 L̂ = max(max(ρ̂(s), ρ̂(d))·|s − d|, |t̂(s) − t̂(d)|·v) 估算新设施到小区的步行距离，贪心最大覆盖选址。标注“估算”的建议没有用实测路线核验。',
  );
  if (o.profile === 'elder') {
    parts.push(
      `老年人画像：路线距离不变，按 ${fmtNumber(o.speed_mps, 2, true)} m/s 步速重算耗时场、等时圈和面积（百度路线本身按 1.17 m/s 计时）。`,
    );
  }
  return parts;
}

function limitationLines(result: AnalysisResult, o: Overview): string[] {
  const meta = result.meta as ZddMeta;
  const lines: string[] = [
    '等时圈是由有限样本插值得到的：边界附近有误差，河道、高架等阻隔只能从样本间的耗时矛盾推断。',
    `步行时间按百度批量算路计：耗时 = 距离 ÷ ${fmtNumber(result.meta.walk_speed_mps, 2, true)} m/s，不含红绿灯等待，实际步行可能更久。`,
    '设施清单来自百度地点检索，可能缺失、过时或分类不准（例如菜场内的摊位、已关停的门店），结论需要实地核实。',
  ];
  const outlines = result.communities.some((c) => c.pts.length >= 3);
  const fromOsm = result.communities.some((c) => c.osm_id);
  if (fromOsm)
    lines.push(
      '小区位置取 OpenStreetMap 小区地块的几何中心，不是小区出入口；大型小区不同楼栋的步行距离会有差别。',
    );
  else if (!outlines)
    lines.push('实时模式没有小区轮廓（百度小区边界 AOI 为付费服务）：每个小区以出入口一个点代表。');
  if (o.headline.pending) {
    lines.push(`${o.headline.pending} 项检查待核实（见上表），结论出来之前不计入缺口。`);
  }
  const upper = checkRows(result).filter((r) => r.check.route_upper_bound && !isPending(r.check)).length;
  if (upper) {
    lines.push(`${upper} 项检查的步行距离是上界（有更近的设施没有算路），但已足以得出结论。`);
  }
  lines.push('规划建议中标注“估算”的部分只用分析时的耗时场推算，需要实测核验后才能作为决策依据。');
  // live runs explain their own degradations in Chinese; sample files carry English build notes instead
  if (meta.mode === 'live') for (const w of meta.warnings ?? []) if (hasCjk(w)) lines.push(w);
  return lines;
}

function sourceLines(result: AnalysisResult): string[] {
  const meta = result.meta as ZddMeta;
  const lines = [...(result.meta.attribution ?? [])];
  lines.push(
    `分析生成于 ${dateOf(result.meta.generated)}${result.meta.generator ? `（${result.meta.generator}）` : ''}。`,
  );
  if (meta.mode === 'live') for (const n of meta.notes ?? []) if (hasCjk(n)) lines.push(n);
  return lines;
}

export function buildReportModel(result: AnalysisResult, id: string): ReportModel {
  const o = overview(result, id);
  const gaps = gapRows(result);
  const withGaps = communitiesWithGaps(gaps);
  let example: ReportModel['pseudo_example'] = null;
  let best = 0;
  for (const { community, category, check } of checkRows(result)) {
    if (isPending(check) || check.status_main !== '伪覆盖') continue;
    const straight = check.via_straight_m ?? check.straight_m;
    const ratio = straight > 0 ? check.route_m / straight : 0;
    if (ratio > best) {
      best = ratio;
      example = {
        community: community.name,
        category,
        facility: viaName(check) ?? check.nearest_straight ?? category,
        straight_m: straight,
        route_m: check.route_m,
      };
    }
  }
  const suggestions = siteSuggestionsOf(result);
  return {
    title: `${o.name} · 15 分钟生活圈体检报告${o.profile === 'elder' ? '（老年人画像）' : ''}`,
    analysis_id: id,
    overview: o,
    verdict: verdictOf(o, withGaps.length),
    communities_with_gaps: withGaps,
    gaps,
    pending: pendingRows(result),
    pseudo_example: example,
    siting: HARD_CATEGORIES.map((category) => {
      const entry = suggestions[category];
      return {
        category,
        source: entry.source,
        demands: entry.demands,
        suggestions: entry.list.map((s) => ({
          rank: s.rank,
          place: describePlace(result, s.xy),
          center_bd09: toBd09(result, s.xy),
          covers: s.routes.map((r) => ({
            community: r.demand_id,
            est_m: r.est_m,
            ...(r.route_m !== undefined ? { route_m: r.route_m } : {}),
          })),
          verified: s.verified,
        })),
      };
    }),
    method: methodLines(result, o),
    sources: sourceLines(result),
    limitations: limitationLines(result, o),
    outlines: result.communities.some((c) => c.pts.length >= 3),
    gray_scope: grayScope(result),
  };
}

// ------------------------------------------------------------------------------ markdown

const cell = (v: string) => v.replace(/\|/g, '\\|').replace(/\n/g, ' ');

function table(head: readonly string[], rows: readonly (readonly string[])[]): string {
  const line = (cells: readonly string[]) => `| ${cells.map(cell).join(' | ')} |`;
  return [line(head), `| ${head.map(() => '---').join(' | ')} |`, ...rows.map(line)].join('\n');
}

function keyNumbers(o: Overview): string {
  const i = o.isochrone;
  const rows: string[][] = [
    ['15 分钟步行可达面积', `${fmtNumber(i.area_iso15_km2, 3)} km²`, '由实测步行耗时插值得到的等时圈'],
    [
      '直线 15 分钟圆面积',
      `${fmtNumber(i.area_circle15_km2, 3)} km²`,
      `半径 ${m(i.circle_r15_m)}（900 秒 × ${fmtNumber(o.speed_mps, 2, true)} m/s）`,
    ],
    ['画圆高估倍数', `${fmtNumber(i.overstate_x, 2)} 倍`, '直线圆面积 ÷ 实际可达面积'],
    ['可达面积占直线圆的比例', pct(i.reach_share_pct), ''],
  ];
  if (i.reach15) {
    rows.push([
      '15 分钟有效步行半径（中位数）',
      m(i.reach15.median_m, 1),
      `${i.reach15.bearings} 个方位上 15 分钟走到的直线距离；最短 ${m(i.reach15.min_m)}，最长 ${m(i.reach15.max_m)}`,
    ]);
  }
  if (o.detour) {
    rows.push([
      '绕行系数 ρ（中位数 / 90 分位）',
      `${fmtNumber(o.detour.rho_median, 3, true)} / ${fmtNumber(o.detour.rho_p90, 3, true)}`,
      `${fmtNumber(o.detour.routes)} 条从中心出发的实测路线：步行距离 ÷ 直线距离`,
    ]);
    rows.push([
      '直线圆内 15 分钟走不到的实测点',
      pct(o.detour.late_inside_circle_share_pct),
      '直线 15 分钟圆内、实测步行超过 15 分钟的样本占比（按百度 1.17 m/s 计时）',
    ]);
  }
  const lv = i.levels.filter((l) => Number.isFinite(l.iso_km2));
  if (lv.length) {
    rows.push([
      `${lv.map((l) => l.minutes).join(' / ')} 分钟可达面积`,
      `${lv.map((l) => fmtNumber(l.iso_km2, 3)).join(' / ')} km²`,
      `对应直线圆 ${lv.map((l) => fmtNumber(l.circle_km2, 3)).join(' / ')} km²`,
    ]);
  }
  return table(['指标', '数值', '说明'], rows);
}

function facilitiesSection(o: Overview, f: FacilityOverview): string {
  const count = (n: number, unit: string) => `${n} ${unit}`;
  const rows = f.rows.map((r) => {
    const cut = r.complete === false;
    const found = cut
      ? `至少 ${count(r.found, r.unit)}（清单只到离中心 ${m(r.known_radius_m ?? 0)}）`
      : count(r.found, r.unit);
    const at = (n: number) => (cut ? `至少 ${count(n, r.unit)}` : count(n, r.unit));
    const near =
      r.nearest === null || r.nearest_min === null
        ? '—'
        : `${r.nearest}，${fmtNumber(r.nearest_min, 1)} 分钟`;
    return [r.category, found, at(r.circle), at(r.walk), near];
  });
  const lines = [
    '### 圈内设施：15 分钟走得到几处',
    '',
    table(
      [
        '类别',
        '清单',
        `直线 15 分钟圆内（半径 ${m(f.circle_r_m)}）`,
        '15 分钟步行可达',
        '最近一处（步行时间）',
      ],
      rows,
    ),
    '',
    `步行时间按 ${fmtNumber(o.speed_mps, 2, true)} m/s 从分析中心走到设施入口计算；菜场摊位并入菜市场，同一地铁站或公交站的各出入口算一处。`,
  ];
  if (f.none_within_walk.length) {
    lines.push('', `15 分钟内一处也走不到：${f.none_within_walk.join('、')}。`);
  }
  if (f.rows.some((r) => r.complete === false)) {
    lines.push('', '标“至少”的类别检索页数用完，更远的没有统计，实际数量可能更多。');
  }
  return lines.join('\n');
}

/** Where the gray reaches: live results stand each gate for ~250 m; outline samples state their halo. */
function grayScope(result: AnalysisResult): string {
  if (!result.communities.some((c) => c.pts.length >= 3)) {
    return '实时模式没有小区轮廓，每个小区出入口代表周围约 250 m。';
  }
  const notes = (result.meta as { notes?: unknown }).notes;
  const halo = /轮廓外\s*(\d+)\s*米/.exec(Array.isArray(notes) ? notes.join('\n') : '')?.[1];
  return halo
    ? `范围为小区轮廓及其外 ${halo} m（轮廓外的位置取最近小区的判定，水面不计）。`
    : '范围限于小区轮廓内。';
}

function graySection(o: Overview, scope: string): string {
  const lines = [
    '### 灰色区域（设施匮乏的范围）',
    '',
    `每个位置交给离它最近的小区，按该小区已核实的判定数缺了几类必需设施（小学、菜市场、药店），缺得越多颜色越深；伪覆盖层标出“直线看着近、实际走不到”的范围。${
      scope
    }`,
    '',
    table(
      ['图层', '面积', '块数', '涉及小区'],
      o.gray_areas.map((g) => [
        g.kind === 'pseudo' ? '有伪覆盖' : `缺至少 ${g.min_missing} 类`,
        `${fmtNumber(g.area_km2, 3)} km²`,
        `${g.polygons}`,
        g.communities.join('、') || '—',
      ]),
    ),
  ];
  return lines.join('\n');
}

function checksSection(model: ReportModel): string {
  const o = model.overview;
  const h = o.headline;
  const out: string[] = [];
  out.push(
    `## 二、${h.communities} 个小区 × ${h.categories} 类必需设施`,
    '',
    `判定规则：步行最短距离不超过判定距离（${o.rule_text}）为**覆盖**；直线在判定距离内、步行超出为**伪覆盖**；直线就已超出为**盲区**；步行距离与判定距离相差不超过 50 m 另标**临界**。未核实的检查记为**待核实**，不计入缺口。`,
    '',
    '### 各类别统计（按小区计）',
    '',
    table(
      ['类别', '判定距离', '覆盖', '伪覆盖', '盲区', '其中临界', '待核实'],
      HARD_CATEGORIES.map((c) => {
        const n = o.by_category[c];
        return [c, m(h.rule_m[c]), `${n.覆盖}`, `${n.伪覆盖}`, `${n.盲区}`, `${n.临界}`, `${n.待核实}`];
      }),
    ),
    '',
  );
  if (model.gaps.length) {
    out.push(
      '### 服务缺口明细（已核实，按步行距离从远到近）',
      '',
      table(
        [
          '小区',
          '类别',
          '状态',
          '直线距离',
          '步行距离',
          `步行时间（${fmtNumber(o.speed_mps, 2, true)} m/s）`,
          '最近可达设施',
        ],
        model.gaps.map((g) => [
          g.community,
          g.category,
          g.borderline ? `${g.status}（临界）` : g.status,
          m(g.straight_m, 1),
          g.route_basis === 'lower_bound' ? '判定距离内没有，未算路' : m(g.route_m),
          g.walk_min === null ? '—' : `${fmtNumber(g.walk_min, 1)} 分钟`,
          g.via ?? '—',
        ]),
      ),
      '',
      `有缺口的小区：${model.communities_with_gaps.map((c) => `${c.community}（${c.missing.join('、')}）`).join('；')}。`,
      '',
    );
  } else {
    out.push('没有已核实的服务缺口。', '');
  }
  if (o.gray_areas.length) out.push(graySection(o, model.gray_scope), '');
  if (model.pending.length) {
    out.push(
      '### 待核实（不计入缺口）',
      '',
      table(
        ['小区', '类别', '目前最短步行', '为什么待核实', '尚未算路的更近设施'],
        model.pending.map((p) => [
          p.community,
          p.category,
          p.route_basis === 'estimated' ? `约 ${m(p.route_m)}（估算）` : `${m(p.route_m)}（上界）`,
          p.reason,
          p.unrouted_nearer.length
            ? p.unrouted_nearer.map((u) => `${u.name}（直线 ${m(u.straight_m, 1)}）`).join('、')
            : '—',
        ]),
      ),
      '',
    );
  }
  return out.join('\n');
}

function pseudoSection(model: ReportModel): string {
  const o = model.overview;
  const lines = [
    '## 三、什么是“伪覆盖”',
    '',
    `以小区为圆心画一个 ${o.rule_text} 的圆，圆里有这类设施，画圆法就认为“有”；可是沿着真实道路走过去超出了判定距离——河道、高架、封闭大院让路绕远了。这就是伪覆盖：地图上看着近，脚下走着远。`,
  ];
  const ex = model.pseudo_example;
  if (ex) {
    lines.push(
      '',
      `例如：${ex.community}到${ex.facility}（${ex.category}），直线只有 ${m(ex.straight_m, 1)}，实际步行 ${m(ex.route_m)}。`,
    );
  }
  const h = o.headline;
  if (h.pseudo) {
    lines.push(
      '',
      `本次共有 ${h.pseudo} 个已核实的伪覆盖，占已核实缺口的 ${pct(h.missed_share_pct ?? 0)}：这些缺口画圆法看不到。`,
    );
  }
  return lines.join('\n');
}

function sitingSection(model: ReportModel): string {
  const o = model.overview;
  const lines = ['## 四、规划建议', ''];
  for (const s of model.siting) {
    const n = o.by_category[s.category];
    if (s.source === 'none') {
      lines.push(
        `- **${s.category}**：没有已核实的缺口${n.待核实 ? `；${n.待核实} 项待核实，建议先补测这些小区到更近${s.category}的步行路线，再决定是否需要新增` : '，暂不需要新增'}。`,
      );
      continue;
    }
    if (!s.suggestions.length) {
      lines.push(
        `- **${s.category}**（缺口小区：${s.demands.join('、')}）：候选点中没有能估算覆盖这些小区的位置，需要结合用地条件另行选点。`,
      );
      continue;
    }
    for (const g of s.suggestions) {
      const covers = g.covers
        .map((c) => {
          if (c.route_m !== undefined) return `${c.community}（实测 ${m(c.route_m)}）`;
          return c.est_m < 30 ? `${c.community}（就在小区旁）` : `${c.community}（L̂ ≈ ${m(c.est_m)}）`;
        })
        .join('、');
      const tag = g.verified ? '已用实测路线核验' : '估算，未经实测核验';
      lines.push(
        `- **${s.category}**${g.rank === 1 ? `（已核实缺口小区：${s.demands.join('、')}）` : ''}：在${g.place}（BD-09 ${fmtNumber(g.center_bd09[0], 6, true)}, ${fmtNumber(g.center_bd09[1], 6, true)}）新增 1 处，可使 ${g.covers.length} 个小区进入 ${m(o.headline.rule_m[s.category])} 步行范围：${covers}。_${tag}_`,
      );
    }
  }
  lines.push(
    '',
    'L̂ 是按本次分析的绕行系数场估算的步行距离，不调用地图接口；落地前应对候选点做一次实测算路核验。',
  );
  return lines.join('\n');
}

export function renderMarkdown(model: ReportModel): string {
  const o = model.overview;
  const [lng, lat] = o.center_bd09;
  const dataLine = provenance(o);
  const info = table(
    ['项目', '内容'],
    [
      [
        '分析中心',
        `${o.center_label ?? o.name}（BD-09 ${fmtNumber(lng, 6, true)}, ${fmtNumber(lat, 6, true)}）`,
      ],
      ['人群画像', `${o.profile_zh}（步速 ${fmtNumber(o.speed_mps, 2, true)} m/s）`],
      ['数据', dataLine],
      ['分析编号', `\`${model.analysis_id}\``],
    ],
  );
  const sections = [
    `# ${model.title}`,
    '',
    `> **结论：** ${model.verdict}`,
    '',
    info,
    '',
    '## 一、关键数字',
    '',
    keyNumbers(o),
    '',
    ...(o.facilities ? [facilitiesSection(o, o.facilities), ''] : []),
    checksSection(model),
    pseudoSection(model),
    '',
    sitingSection(model),
    '',
    '## 五、方法、数据来源与局限',
    '',
    '### 方法',
    '',
    ...model.method.map((l) => `- ${l}`),
    '',
    '### 数据来源',
    '',
    ...model.sources.map((l) => `- ${l}`),
    '',
    '### 局限',
    '',
    ...model.limitations.map((l) => `- ${l}`),
    '',
    '---',
    '',
    `本报告由邻至（zoudedao）根据分析结果 \`${model.analysis_id}\` 确定性生成：同一份分析结果总是生成同一份报告，报告中的每个数字都能在分析结果中找到来源。`,
    '',
  ];
  return sections.join('\n');
}

export function reportMarkdown(result: AnalysisResult, id: string): string {
  return renderMarkdown(buildReportModel(result, id));
}
