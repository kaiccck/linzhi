/**
 * The live analyzer: @zoudedao/engine over the shared Baidu client. Engine errors keep their codes
 * (quota_exhausted, auth, upstream, invalid_input) and Chinese messages; anything else propagates and
 * the SSE route reports it as `internal`.
 */
import type { BaiduClient } from '@zoudedao/baidu';
import { createEngineAnalyzer, EngineError, type OfficialList } from '@zoudedao/engine';
import { AnalyzeError, type Analyzer } from './analyzer.js';
import type { OfficialData } from './official.js';

const isLists = (x: readonly OfficialList[] | Partial<OfficialData>): x is readonly OfficialList[] =>
  Array.isArray(x);

/**
 * `official`: data/official (see official.ts) — facility lists fused with Baidu POIs, catchment tables
 * for 对口小学, curated exclusions. A plain array is taken as facility lists only.
 */
export function createLiveAnalyzer(
  client: BaiduClient,
  official: readonly OfficialList[] | Partial<OfficialData> = {},
): Analyzer {
  const data: Partial<OfficialData> = isLists(official) ? { lists: [...official] } : official;
  const engine = createEngineAnalyzer({
    client,
    official: data.lists ?? [],
    catchment: data.catchments ?? [],
    exclusions: data.exclusions ?? [],
    communityReviews: data.communityReviews ?? [],
  });
  return {
    name: engine.name,
    async analyze(input, emit, signal) {
      try {
        return await engine.analyze(input, emit, signal);
      } catch (err) {
        if (err instanceof EngineError) throw new AnalyzeError(err.code, err.message, { cause: err });
        throw err;
      }
    },
  };
}
