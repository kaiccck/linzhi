/**
 * Name and address keys for matching official lists (data/official/*.json) against Baidu POIs and
 * residential names (技术设计文档 §6.4). Official names carry the region ("上海市浦东新区孙桥小学"),
 * Baidu names usually drop it and put the campus in brackets ("孙桥小学(张江校区)"); both reduce to the
 * same key here.
 */

/** Full-width folded, brackets unified to ( ), spaces and middle dots removed. */
export function foldName(name: string): string {
  return name
    .normalize('NFKC')
    .replace(/[【[{]/g, '(')
    .replace(/[】\]}]/g, ')')
    .replace(/[\s·•・]/g, '');
}

/** 上海市浦东新区孙桥小学 → 孙桥小学: the region prefix official names carry and Baidu names often drop. */
export function stripRegion(name: string): string {
  return name.replace(/^(?:上海市|上海)?(?:浦东新区|浦东)?/, '');
}

export interface SchoolKey {
  /** School without region, 民办 and campus, e.g. 孙桥小学, 进才实验小学西校. */
  base: string;
  /** Campus token without 校区/分校/…, e.g. 张江, 大华, 东; null when the name names no campus. */
  campus: string | null;
  /** base, or base#campus. */
  key: string;
}

const CAMPUS_SUFFIX = /(?:校区|分校|分部|办学点|教学点|部)$/;
// a campus spelled out after the school name: 孙桥小学张江校区, 明珠小学A区
const TRAILING_CAMPUS =
  /^(.*?(?:小学|学校)(?:[东西南北]校)?)((?:[^()]{1,8}?(?:校区|分校|分部|办学点|教学点))|[A-Z]区)$/;

function campusToken(campus: string): string | null {
  const c = campus.replace(/\(.*$/, '').replace(CAMPUS_SUFFIX, '');
  return c || null;
}

/**
 * School key: 上海市浦东新区孙桥小学 + 张江校区, "孙桥小学(张江校区)", "浦东新区孙桥小学张江校区" all give
 * { base: 孙桥小学, campus: 张江 }; "上海浦东新区民办筑桥实验小学" and "筑桥实验小学" give 筑桥实验小学.
 * A school's name part stays (进才实验小学西校 is not 进才实验小学).
 */
export function schoolKey(name: string, campus?: string | null): SchoolKey {
  let s = foldName(name);
  let c: string | null = campus ? campusToken(foldName(campus)) : null;
  const bracket = /^(.*?)\((.+)\)$/.exec(s);
  if (bracket) {
    s = bracket[1]!;
    c ??= campusToken(bracket[2]!);
  }
  s = stripRegion(s).replace(/^民办/, '');
  const trailing = TRAILING_CAMPUS.exec(s);
  if (trailing) {
    s = trailing[1]!;
    c ??= campusToken(trailing[2]!);
  }
  return { base: s, campus: c, key: c ? `${s}#${c}` : s };
}

/** 上海市浦东新区张江社区卫生服务中心 / 张江社区卫生服务中心(益江路) → 张江社区卫生服务中心. */
export function healthKey(name: string): string {
  return stripRegion(foldName(name).replace(/\([^)]*\)/g, ''));
}

// a road name: no digits and none of the characters that end an administrative prefix
const ROAD = String.raw`([^\d路街道市区县镇村号弄()]{1,10}(?:路|街|大道|公路))`;

/**
 * Road and first house or lane number: 紫薇路686号, 紫薇路686弄 and 上海市浦东新区紫薇路686弄3号 all give
 * 紫薇路686 (a school's gate number and its lane number are the same site). null without a number.
 */
export function roadNumber(address: string | null | undefined): string | null {
  if (!address) return null;
  const s = foldName(address).replace(/\([^)]*\)/g, '');
  const m = new RegExp(`${ROAD}(\\d+)(?:号|弄)`).exec(s);
  return m ? `${m[1]}${m[2]}` : null;
}

const CN_DIGITS = '一二三四五六七八九';
const ROMAN: Readonly<Record<string, number>> = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6 };

/** 一 … 九十九 → 1 … 99; null for anything else. */
function chineseNumber(s: string): number | null {
  const m = /^([一二三四五六七八九])?(十)?([一二三四五六七八九])?$/.exec(s);
  if (!m || (!m[1] && !m[2] && !m[3]) || (m[1] && m[3] && !m[2])) return null;
  const digit = (c: string | undefined) => (c ? CN_DIGITS.indexOf(c) + 1 : 0);
  return m[2] ? (m[1] ? digit(m[1]) : 1) * 10 + digit(m[3]) : digit(m[1]);
}

// a separator, an optional 第, then the number (not the tail of a longer one) and what it counts.
// Built on first use: an engine without lookbehind (the mini program on iOS before 16.4) must not
// fail the whole bundle at load; it gets the same pattern without the "not the tail" guards.
let phaseNumeral: RegExp | null = null;
function phaseRe(): RegExp {
  if (phaseNumeral) return phaseNumeral;
  const guarded = String.raw`[-－—_\s]*第?(?:(?<![0-9])([0-9]{1,3})|(?<![${CN_DIGITS}十])([${CN_DIGITS}十]{1,3})|(?<![A-Za-z])(I{1,3}|IV|VI|V))(期|区|组|块)`;
  try {
    phaseNumeral = new RegExp(guarded, 'giu');
  } catch {
    phaseNumeral = new RegExp(guarded.replace(/\(\?<!\[[^\]]*\]\)/g, ''), 'giu');
  }
  return phaseNumeral;
}

/**
 * Phase numbers spelled one way: a Roman (I–VI, full-width Ⅰ–Ⅵ too), Arabic or Chinese number before
 * 期 / 区 / 组 / 块 becomes Arabic digits, and a separator or 第 in front of it goes, so 万科翡翠公园-I期,
 * 万科翡翠公园-1期, 万科翡翠公园第一期 and 万科翡翠公园一期 all read 万科翡翠公园1期. Everything else stays
 * (after NFKC): 玉兰香苑一期A组 → 玉兰香苑1期A组, 川杨新苑-南区 unchanged.
 */
export function phaseNumerals(name: string): string {
  return name
    .normalize('NFKC')
    .replace(
      phaseRe(),
      (all, arabic: string | undefined, cn: string | undefined, roman: string | undefined, unit: string) => {
        const n = arabic ? Number(arabic) : cn ? chineseNumber(cn) : (ROMAN[roman!.toUpperCase()] ?? null);
        return n === null ? all : `${n}${unit}`;
      },
    );
}

/** Lane key of an address or name: 顺和路60弄, 川和路322弄15号 → 顺和路60弄 / 川和路322弄; 张江路689号 → 张江路689号. */
export function laneKey(text: string | null | undefined): string | null {
  if (!text) return null;
  const s = foldName(text).replace(/\([^)]*\)/g, '');
  const lane = new RegExp(`${ROAD}(\\d+)弄`).exec(s);
  if (lane) return `${lane[1]}${lane[2]}弄`;
  const door = new RegExp(`${ROAD}(\\d+)号`).exec(s);
  return door ? `${door[1]}${door[2]}号` : null;
}
