/**
 * Siting suggestions for the report and the GeoJSON export (技术设计文档 §7.5). Suggestions the
 * analysis already carries are used as they are (verified or not); otherwise they are estimated here
 * with core's greedy MCLP over L̂, and every such suggestion stays verified: false (估算).
 */
import {
  HARD_CATEGORIES,
  siteCandidatesFromPaths,
  suggestSites,
  type AnalysisResult,
  type HardCategory,
  type SiteCandidate,
  type SiteSuggestion,
} from '@zoudedao/core';
import { isWalkGap, routeEstimator, ruleOf } from './analysis.js';

export interface CategorySuggestions {
  /** analysis = from AnalysisResult.site_suggestions; estimated = computed here; none = no verified gap. */
  source: 'analysis' | 'estimated' | 'none';
  /** Communities with a verified gap of the category (the demand the suggestions serve). */
  demands: string[];
  list: SiteSuggestion[];
}

const cache = new WeakMap<AnalysisResult, Record<HardCategory, CategorySuggestions>>();

/** Candidate sites: every 50 m along the walked paths (on a street by construction) and each community. */
export function siteCandidates(result: AnalysisResult): SiteCandidate[] {
  return [
    ...siteCandidatesFromPaths(result.paths ?? [], 50),
    ...result.communities.map((c) => ({ id: `小区:${c.name}`, xy: c.centroid, label: c.name })),
  ];
}

export function siteSuggestionsOf(
  result: AnalysisResult,
  maxSites = 2,
): Record<HardCategory, CategorySuggestions> {
  const hit = cache.get(result);
  if (hit) return hit;
  const estimator = routeEstimator(result);
  const candidates = siteCandidates(result);
  const out = {} as Record<HardCategory, CategorySuggestions>;
  for (const category of HARD_CATEGORIES) {
    const demands = result.communities
      .filter((c) => {
        const check = c.checks?.[category];
        return check !== undefined && isWalkGap(check);
      })
      .map((c) => ({ id: c.name, xy: c.centroid }));
    const given = result.site_suggestions?.[category];
    if (given?.length) {
      out[category] = { source: 'analysis', demands: demands.map((d) => d.id), list: given };
    } else if (!demands.length) {
      out[category] = { source: 'none', demands: [], list: [] };
    } else {
      const list = suggestSites(candidates, demands, {
        category,
        rule_m: ruleOf(result, category),
        estimator,
        maxSites,
      });
      out[category] = { source: 'estimated', demands: demands.map((d) => d.id), list };
    }
  }
  cache.set(result, out);
  return out;
}
