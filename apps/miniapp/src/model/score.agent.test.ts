import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import type { AnalysisResult } from '@zoudedao/core';
import { deriveModel } from '@web/model/derive';
import { lifeCircleScore as agentScore } from '../../../../packages/agent/src/analysis';
import { lifeCircleScore } from './score';

it('scores as the advisor does (the AI quotes the same number as the screen)', () => {
  for (const id of ['zj-a', 'zj-b', 'zj-c', 'zj-v']) {
    const r = JSON.parse(
      readFileSync(fileURLToPath(new URL(`../../../../data/samples/${id}.json`, import.meta.url)), 'utf8'),
    ) as AnalysisResult;
    const app = lifeCircleScore(deriveModel(r, id));
    const ai = agentScore(r);
    expect([ai.walk, ai.circle, ai.grade], id).toEqual([app.walk, app.circle, app.grade.word]);
    for (const c of app.categories) {
      const a = ai.coverage.find((x) => x.category === c.cat)!;
      expect(a.walk_pct, `${id} ${c.cat}`).toBe(c.walk === null ? null : Math.round(c.walk * 100));
      expect(a.pending, `${id} ${c.cat}`).toBe(c.pending);
    }
  }
});
