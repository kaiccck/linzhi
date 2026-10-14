/**
 * The panel while a live check streams in. The verdict waits (as it does during 走一遍): no gap count
 * until the result lands. What the panel shows instead is the measuring itself — the engine's stages
 * as a ladder, the walking routes measured so far by stage (the same marks the map draws), the 15′
 * reach as it tightens against the circle's claim, and the quota spent.
 */
import { STAGES, stageIndex, type AreaStep, type StreamModel, type StreamState } from '../data/stream.js';

export function StageLadder({ stage, compact = false }: { stage: string | undefined; compact?: boolean }) {
  const now = stageIndex(stage);
  return (
    <ol className={'ladder' + (compact ? ' compact' : '')} aria-label="体检阶段">
      {STAGES.map((s, i) => {
        const state = i < now ? 'done' : i === now ? 'now' : 'todo';
        return (
          <li key={s.id} className={state} aria-current={state === 'now' ? 'step' : undefined}>
            <i aria-hidden="true" />
            <span>{s.word}</span>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * The reach after every round, as bars against the straight circle's area (the claim): the walk's
 * 15′ ground tightens as the measuring goes on — the one number that moves while the verdict waits.
 */
function ReachSteps({ areas, circleKm2 }: { areas: AreaStep[]; circleKm2: number }) {
  const top = Math.max(circleKm2, ...areas.map((a) => a.km2)) * 1.12;
  return (
    <figure className="steps">
      <figcaption>
        <span className="num">15′</span> 可达范围，每轮采样后（km²）
      </figcaption>
      <div
        className="steps-plot"
        role="img"
        aria-label={`15 分钟可达范围：${areas.map((a) => `${a.label} ${a.km2.toFixed(2)} 平方公里`).join('，')}；直线圈 ${circleKm2.toFixed(2)} 平方公里`}
      >
        <span className="steps-claim" style={{ bottom: `${(circleKm2 / top) * 100}%` }} aria-hidden="true">
          <span>
            直线圈 <span className="num">{circleKm2.toFixed(2)}</span>
          </span>
        </span>
        {areas.map((a, i) => (
          <span key={i} className={'step' + (i === areas.length - 1 ? ' now' : '')} aria-hidden="true">
            <b className="num">{a.km2.toFixed(2)}</b>
            <i style={{ height: `${(a.km2 / top) * 100}%` }} />
            <small>{a.label}</small>
          </span>
        ))}
      </div>
    </figure>
  );
}

export function RunBoard({
  label,
  stream,
  model,
  note,
}: {
  label: string;
  stream: StreamState;
  model: StreamModel;
  /** replay / coordinate conversion notes */
  note: string | null;
}) {
  const { stage } = stream;
  const matrix = stream.quota['routematrix_walking'];
  return (
    <section className="run" aria-labelledby="run-h">
      <header className="run-head">
        <h1 id="run-h">{label}</h1>
        {/* the stage itself is said on the map's card (with its 取消), not twice */}
        <p>
          正在体检
          {note ? ` · ${note}` : ''}
        </p>
        <span className="progress" aria-hidden="true">
          <span style={{ transform: `scaleX(${Math.max(0.02, Math.min(1, stage?.progress ?? 0.02))})` }} />
        </span>
      </header>
      <StageLadder stage={stage?.stage} />
      <ul className="run-keys" aria-label="已实测">
        <li>
          <i className="sd sd-seed" aria-hidden="true" />
          <span>
            粗采样 <span className="num">{model.counts.seed}</span>
          </span>
        </li>
        <li>
          <i className="sd sd-path" aria-hidden="true" />
          <span>
            路径 <span className="num">{model.pathCount}</span> 条（
            <span className="num">{model.counts.path}</span> 点）
          </span>
        </li>
        <li>
          <i className="sd sd-refine" aria-hidden="true" />
          <span>
            边界加密 <span className="num">{model.counts.refine}</span>
          </span>
        </li>
      </ul>
      {/* the reach so far is the chart's own last bar, against the circle's line */}
      {stream.areas.length ? (
        <ReachSteps areas={stream.areas} circleKm2={(Math.PI * model.r15 ** 2) / 1e6} />
      ) : null}
      <p className="run-note">
        每个点是一条百度实测的步行路线。
        {matrix ? (
          <>
            {' '}
            今日批量算路配额已用 <span className="num">{matrix.used.toLocaleString('en-US')}</span>
            {matrix.limit ? (
              <>
                {' '}
                / <span className="num">{matrix.limit.toLocaleString('en-US')}</span>
              </>
            ) : null}
            。
          </>
        ) : null}
      </p>
    </section>
  );
}
