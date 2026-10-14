/**
 * The compounds of a check, as an official source shows them. Baidu's place search for 住宅区 also
 * returns what is not a home: the office of a 居民委员会 ("江夏社区"), the gate of an industrial park,
 * an office building, a hotel, a demolished village, and one compound filed twice under a building's
 * number. Counted as communities they add gaps that are not anyone's, and drag every category down.
 *
 * A curated review (data/official/community-review.json, kind 'community_review') settles them by Baidu
 * uid, each with its reason, source and date:
 *   exclude       not a home of its own (committee office, non-residential, duplicate, demolished,
 *                 mislocated, or no official record of a compound there)
 *   no_catchment  a home with no 对口小学 by law (商办产权: commercial land, no 户籍): the 小学 check says
 *                 so instead of waiting
 *   address       the address an official table uses where Baidu's differs (银冬路568号 / 银东路568号),
 *                 so the catchment table can match it
 *   name          the name the official table gives the compound at that lane, where Baidu's is a lane
 *                 or a spelling of its own (益江路511弄 → 玉兰香苑二期A块)
 * and one name rule needs no review: two characters and 社区 / 居委会 / 居民区 is how Shanghai names a
 * residents' committee, never a compound.
 */

export type CommunityReviewAction = 'exclude' | 'no_catchment' | 'address' | 'name';

export type CommunityReviewKind =
  | 'committee'
  | 'not_residential'
  | 'duplicate'
  | 'demolished'
  | 'mislocated'
  | 'unverified'
  | 'commercial'
  | 'address'
  | 'name';

export interface CommunityReview {
  /** Baidu uid of the compound POI. */
  uid: string;
  /** Baidu's name, for people reading the file. */
  name: string;
  action: CommunityReviewAction;
  kind: CommunityReviewKind;
  reason: string;
  /** URL(s) of the official or public sources. */
  source: string | string[];
  /** Date verified, YYYY-MM-DD. */
  date: string;
  /** action 'address': the address as the official table writes it. */
  address?: string;
  /** action 'name': the compound's name as the official table (or the town's list) writes it. */
  official_name?: string;
  /** kind 'duplicate': the compound it duplicates. */
  duplicate_of?: string;
}

/** 江夏社区, 华顺社区, 江春居委会: a residents' committee, not a compound. */
export const COMMITTEE_NAME = /^\p{Script=Han}{2}(?:社区|居委会?|居民区)$/u;

const ACTIONS: readonly CommunityReviewAction[] = ['exclude', 'no_catchment', 'address', 'name'];

/** Why an entry of the review cannot be used, in Chinese, or null when it can. */
export function communityReviewProblem(e: unknown): string | null {
  const x = (typeof e === 'object' && e !== null ? e : {}) as Record<string, unknown>;
  const has = (k: string) => typeof x[k] === 'string' && (x[k] as string).length > 0;
  if (!has('uid') || !has('name')) return '缺少 uid 或 name';
  if (!ACTIONS.includes(x.action as CommunityReviewAction)) return `action 只能是 ${ACTIONS.join('、')}`;
  if (!has('kind')) return '缺少 kind';
  const sourceOk =
    has('source') ||
    (Array.isArray(x.source) && x.source.length > 0 && x.source.every((s) => typeof s === 'string' && s));
  if (!has('reason') || !sourceOk) return '缺少 reason 或 source（每条都要写明理由与来源）';
  if (!has('date')) return '缺少核实日期 date（YYYY-MM-DD）';
  if (x.action === 'address' && !has('address')) return 'action 为 address 时要给出官方表的地址 address';
  if (x.action === 'name' && !has('official_name')) return 'action 为 name 时要给出官方名称 official_name';
  return null;
}

/** The review's verdict on a compound POI (its own uid or one merged into it), else undefined. */
export function reviewOf(
  reviews: readonly CommunityReview[],
  uids: readonly (string | null | undefined)[],
): CommunityReview | undefined {
  const set = new Set(uids.filter((u): u is string => !!u));
  return reviews.find((r) => set.has(r.uid));
}
