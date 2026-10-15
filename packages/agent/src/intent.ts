/**
 * Keyword intent router of the template advisor: works without any LLM, so judges without keys still
 * get a useful answer. It only decides which tools to call; the words of the answer come from the
 * tool results.
 */
import type { AnalysisResult, FacilityCategory, HardCategory, LngLat } from '@zoudedao/core';
import { HARD_CATEGORIES, TASK_CATEGORIES, findCommunity, normName, toBd09 } from './analysis.js';
import type { Profile } from './types.js';

export type IntentKind =
  'simulate' | 'compare' | 'report' | 'isochrone' | 'score' | 'reach' | 'facilities' | 'gaps' | 'overview';

export interface Intent {
  /** Main thing asked for. */
  kind: IntentKind;
  /**
   * The per-community categories (HARD_CATEGORIES) the question names, in display order — whether or
   * not the analysis checked them; the advisor tells the unchecked ones apart.
   */
  categories: HardCategory[];
  /** Every facility category the question names (the per-community ones and the other 民生设施). */
  facilityCategories: FacilityCategory[];
  profile: Profile;
  /** Adult vs elder comparison ("老人和成人比"). */
  profileCompare: boolean;
  format: 'markdown' | 'geojson' | 'json';
  /** Where a new facility would go, as written ("孙环路口"). */
  siteText?: string;
  /** A place the user names that may not be a known sample ("玉兰香苑"). */
  placeText?: string;
}

/** Words of the categories checked per community (any of HARD_CATEGORIES). */
const CATEGORY_WORDS: [RegExp, HardCategory][] = [
  [/幼儿园|托儿所|托班|幼托/, '幼儿园'],
  [/小学|上学|读书|学校|学区|入学/, '小学'],
  [/买菜|菜场|菜市场|菜市|农贸|生鲜|买肉|买鱼|买水果/, '菜市场'],
  [/药店|药房|买药|配药|拿药|药/, '药店'],
  [/社区卫生|卫生服务|卫生站|卫生院|社区医院|看医生|看病|就医|诊所|医院|门诊/, '社区卫生'],
];
/** 孩子、小孩 ask about school — unless the question names a kindergarten ("孩子上幼儿园方便吗"). */
const KID = /孩子|小孩/;

/** The categories checked per community that `q` names, in display order. */
function categoriesIn(q: string): HardCategory[] {
  const named = new Set(CATEGORY_WORDS.filter(([re]) => re.test(q)).map(([, c]) => c));
  if (KID.test(q) && !named.has('幼儿园')) named.add('小学');
  return HARD_CATEGORIES.filter((c) => named.has(c));
}

/** The other 民生设施, counted by the 圈内设施统计 (never checked per community). */
const FACILITY_WORDS: [RegExp, FacilityCategory][] = [
  [/生鲜超市/, '生鲜超市'],
  [/(?<!生鲜)超市|便利店|商超/, '超市'],
  [/养老|敬老|日间照料|长者照护|长者食堂|助餐/, '养老'],
  [/公交|巴士/, '公交'],
  [/地铁|轨交|轨道交通/, '地铁'],
  [/公园|绿地|遛弯/, '公园'],
];
/** "圈里有几家药店", "附近有什么设施": a count of facilities, not a community's gaps. */
const FACILITY_COUNT =
  /(?:几|多少)\s*[家个所处座间条站]|(?:有|是)(?:什么|哪些)设施|什么设施|哪些设施|设施(?:有哪些|情况|统计|清单|数量|多不多|全不全|怎么样)|(?:附近|周边|圈[里内]|15\s*分钟内?|十五分钟内?)都?有(?:什么|哪些|几)/;
/** Questions about communities stay with the gap tools. */
const ABOUT_COMMUNITIES = /小区|缺口|盲区|伪覆盖/;
const ELDER = /老人|老年|长者|爷爷|奶奶|外公|外婆|银发|老龄|腿脚不便/;
const ADULT = /成人|成年|年轻人|上班族/;
const SIMULATE =
  /如果|假如|假设|要是|倘若|新增|新建|新开|增设|开一?[家个所间]|建一?[家个所座]|加一?[家个所]|补一?[家个所]|设一?[家个所]|放一?[家个所]/;
const COMPARE = /对比|比较|相比|比一比|哪个.{0,6}(?:好|差|方便|强)|区别|差别|差距/;
const REPORT = /报告|导出|下载|生成.{0,4}(?:文档|文件)|体检单|markdown|geojson|\bjson\b/i;
const ISOCHRONE = /等时圈|geojson|多边形|边界/i;
/** "评分是怎么来的", "得了几分", "覆盖率多少": the 体检评分. */
const SCORE = /评分|得分|几分|多少分|分数|打分|等级|覆盖率/;
const REACH =
  /可达范围|走多远|能走到哪|多远的?范围|多大范围|可达面积|有效半径|15\s*分钟.{0,4}范围|十五分钟.{0,4}范围|高估/;

/**
 * `names`: places the question may name (the analysis, its centre label, its communities). They are
 * blanked before the topic words are read, so 万科翡翠公园 is not a question about parks; the place
 * and the site are still read from the question as written.
 *
 * `checked`: the categories the analysis checked per community (core checkedCategories) — all five on
 * new analyses, the task's three on older ones and by default (what core assumes of an analysis
 * without communities). A category the analysis did not check is answered like the other 民生设施,
 * from the 圈内设施统计, unless the question is about communities or gaps.
 */
export function parseIntent(
  question: string,
  names: readonly string[] = [],
  checked: readonly HardCategory[] = TASK_CATEGORIES,
): Intent {
  const raw = question.normalize('NFKC');
  let q = raw;
  for (const name of [...names].map((n) => n.normalize('NFKC')).sort((a, b) => b.length - a.length)) {
    if (name.length >= 2) q = q.split(name).join('　');
  }
  const categories = categoriesIn(q);
  const others = FACILITY_WORDS.filter(([re]) => re.test(q)).map(([, c]) => c);
  // named but never checked per community by this analysis: only the 圈内设施统计 knows about them
  const counted = [...categories.filter((c) => !checked.includes(c)), ...others];
  // an elder's 长者食堂 is 养老, not the elderly profile's reason alone; 老人 still switches the profile
  const elder = ELDER.test(q.replace(/长者(?:照护|食堂)/g, ''));
  const intent: Intent = {
    kind: 'overview',
    categories,
    facilityCategories: [...categories, ...others],
    profile: elder ? 'elder' : 'adult',
    profileCompare: elder && (ADULT.test(q) || COMPARE.test(q)),
    format: /geojson|地图(?:文件|数据)/i.test(q)
      ? 'geojson'
      : /\bjson\b|结构化/i.test(q)
        ? 'json'
        : 'markdown',
  };
  if (REPORT.test(q)) intent.kind = 'report';
  else if (SIMULATE.test(q) && categories.length) intent.kind = 'simulate';
  else if (COMPARE.test(q)) intent.kind = 'compare';
  else if (ISOCHRONE.test(q)) intent.kind = 'isochrone';
  else if (SCORE.test(q)) intent.kind = 'score';
  else if (REACH.test(q)) intent.kind = 'reach';
  else if (!ABOUT_COMMUNITIES.test(q) && (FACILITY_COUNT.test(q) || counted.length > 0)) {
    intent.kind = 'facilities';
  } else if (
    categories.length ||
    /盲区|缺口|走不到|伪覆盖|缺什么|缺少|方便|够不够|能不能|有没有|远不远|近不近|走得到/.test(q)
  ) {
    intent.kind = 'gaps';
  }
  if (intent.kind === 'simulate') {
    const site = siteTextOf(raw);
    if (site) intent.siteText = site;
  }
  const place = placeTextOf(raw);
  if (place) intent.placeText = place;
  return intent;
}

/** "在孙环路口开一家药店" → "孙环路口"; "药店开在孙环路口" → "孙环路口". */
export function siteTextOf(q: string): string | undefined {
  const a =
    /在(.{1,20}?)(?:附近|旁边|边上|这里|那里|那边|这边)?(?:再|也|新)?(?:开|建|新增|新建|增设|加|设|放|补)/.exec(
      q,
    );
  const b = /(?:开|建|设|放)在(.{1,20}?)(?:的话|呢|吧|，|,|。|？|\?|$)/.exec(q);
  const text = (a?.[1] ?? b?.[1])?.replace(/^(?:这个|那个)/, '').trim();
  return text && text.length >= 2 ? text : undefined;
}

const PLACE_STOP =
  /^(?:这|那|这里|那里|这个|那个|我们|我家|本|该|这个社区|这个小区|社区|小区|片区|附近|周边|这边|那边|如果|假如|请问|帮我)$/;

/** The area the question is about, when it names one before the topic words. */
export function placeTextOf(q: string): string | undefined {
  const m =
    /^(?:(?:请问|帮我|帮忙|麻烦你?|看看|看一下|查查|查一下|分析一下|分析|评估一下|评估|体检一下|给我?)\s*)*(.{2,20}?)(?:这边|那边|附近|周边|一带|这里|那里)?(?:的话|的)?(?:老人|老年人|孩子|小孩|居民|买菜|上学|看病|买药|生活圈|体检|怎么样|方便|能不能|能|有没有|缺|步行|15\s*分钟|十五分钟|等时圈|盲区|是否|吗|[？?，,])/.exec(
      q,
    );
  const text = m?.[1]?.trim();
  if (!text || PLACE_STOP.test(text) || SIMULATE.test(text) || REPORT.test(text) || COMPARE.test(text))
    return undefined;
  // topic words and questions are not places ("15分钟", "老人", "哪里")
  if (/\d|分钟|多远|多久|多少|怎么|哪|什么|为什么|能不能/.test(text) || ELDER.test(text)) return undefined;
  if (CATEGORY_WORDS.some(([re]) => re.test(text)) || KID.test(text)) return undefined;
  return text;
}

export interface ResolvedSite {
  center_bd09?: LngLat;
  near_community?: string;
  /** How the words were understood, shown in the answer. */
  how: string;
}

/** Places a facility the user describes in words inside an analysis, without any geocoding. */
export function resolveSite(result: AnalysisResult, text: string): ResolvedSite | undefined {
  const key = text
    .replace(/(?:十字路口|交叉口|路口|口子|口|附近|旁边|边上|这边|那边)$/, '')
    .replace(/的$/, '');
  const k = normName(key);
  if (k.length < 2) return undefined;
  const community = findCommunity(result, key);
  if (community) return { near_community: community.name, how: `放在${community.name}旁` };
  const label = result.meta.center_label ?? '';
  if (label && normName(label).includes(k)) {
    return { center_bd09: result.meta.center_bd09, how: `按分析中心（${label}）的路口计算` };
  }
  const poi = result.pois.find((p) => normName(p.name).includes(k));
  if (poi) return { center_bd09: toBd09(result, poi.xy), how: `放在${poi.name}旁` };
  let best: { xy: [number, number]; d: number; name: string } | null = null;
  for (const way of result.base?.roads ?? []) {
    if (!way.name || !normName(way.name).includes(k)) continue;
    for (const p of way.pts) {
      const d = Math.hypot(p[0], p[1]);
      if (!best || d < best.d) best = { xy: [p[0], p[1]], d, name: way.name };
    }
  }
  if (best) return { center_bd09: toBd09(result, best.xy), how: `放在${best.name}上离分析中心最近的位置` };
  return undefined;
}
