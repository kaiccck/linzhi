/**
 * The live analyzer: @zoudedao/engine over the shared Baidu client. Engine errors keep their codes
 * (quota_exhausted, auth, upstream, invalid_input) and Chinese messages; anything else propagates and
 * the SSE route reports it as `internal`.
 */
import type { BaiduClient } from '@zoudedao/baidu';
import { createEngineAnalyzer, EngineError, type OfficialList } from '@zoudedao/engine';
import { AnalyzeError, type Analyzer } from './analyzer.js';

/** `official`: lists fused with Baidu POIs (data/official/*.json, see official.ts). */
export function createLiveAnalyzer(client: BaiduClient, official: readonly OfficialList[] = []): Analyzer {
  const engine = createEngineAnalyzer({ client, official });
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
