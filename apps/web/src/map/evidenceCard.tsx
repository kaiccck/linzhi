/**
 * The card of the route evidence: which unit walks to which facility, then the numbers — "直线 819 m ·
 * 实际步行 1,676 m · 约 24′（百度步行路线）" — and, in a quieter voice, the assigned school and where
 * the route came from. While the route loads the card says so; when there is no route to draw it says
 * why (never a blank). Placed on the map like a finding card (docked at the foot on a phone).
 */
import { NumText } from '../components/NumText.js';
import { fmtInt, poiName, spotOf } from '../model/derive.js';
import { catchmentText, type EvidenceBase, type EvidenceFacts } from '../model/evidence.js';
import { freshText } from '../model/fresh.js';
import type { FindingItem } from './findings.js';
import { N, U } from './findings.js';

export interface EvidenceView {
  status: 'loading' | 'done' | 'failed';
  base: EvidenceBase;
  facts: EvidenceFacts | null;
  message: string | null;
}

const TAG: Partial<Record<string, [string, string]>> = {
  pseudo: ['s-pseudo', '伪覆盖'],
  blind: ['s-blind', '盲区'],
  none: ['s-blind', '盲区'],
  ok: ['s-ok', '走得到'],
  edge: ['s-edge', '临界'],
  'edge-over': ['s-edge', '临界'],
  pending: ['s-pending', '待核'],
};

export function evidenceItem(
  ev: EvidenceView,
  opts: {
    scale: number;
    crossing: boolean;
    onClose(): void;
    /** the rule's distance: a walk past it says by how much */
    rule?: number;
  },
): FindingItem {
  const { base, facts } = ev;
  const { unit, cat, look, check } = base;
  const tag = TAG[look];
  const elder = opts.scale !== 1;
  const straight = <U n={fmtInt(facts?.straightM ?? base.straightM)} unit="m" />;
  // two deliberate lines: the two distances, then the time and where it comes from
  const body =
    ev.status === 'done' && facts ? (
      <>
        直线 {straight} · 实际步行 <U n={fmtInt(facts.routeM)} unit="m" />
        <br />
        {opts.rule && facts.routeM > opts.rule ? (
          <span className="nw ev-over">
            超出 {opts.rule % 1000 === 0 ? <N>{opts.rule / 1000}</N> : <N>{fmtInt(opts.rule)}</N>}
            {opts.rule % 1000 === 0 ? ' 公里 ' : ' m '}
            <U n={fmtInt(facts.routeM - opts.rule)} unit="m" />
            {' · '}
          </span>
        ) : null}
        <span className="nw">
          {elder ? '老人' : ''}约 <N>{facts.minutes}′</N>（
          {opts.crossing ? '含过街等待，估算' : '百度步行路线'}）
        </span>
      </>
    ) : ev.status === 'loading' ? (
      <>
        直线 {straight} · <span className="ev-wait">正在取百度步行路线…</span>
      </>
    ) : (
      <>{ev.message}</>
    );
  // the quiet foot: the assigned school, and the distance the verdict used when the drawn route differs
  const foot: string[] = [];
  // the assigned school, unless the route already goes to it (said once, not twice)
  const bare = (s: string) => s.replace(/[（(]/g, '(').replace(/[）)]/g, ')').replace(/\s/g, '');
  if (cat === '小学' && unit.catchment) {
    const same = !!base.facility && bare(base.facility).includes(bare(poiName(unit.catchment.school)));
    foot.push(same ? '这所就是对口小学' : catchmentText(unit.catchment));
  }
  if (facts?.checkRouteM) foot.push(`判定距离 ${fmtInt(facts.checkRouteM)} m`);
  // a 菜市场 gap: where vegetables can still be bought on foot (the verdict stays)
  if (cat === '菜市场' && check.alt) foot.push(freshText(check.alt));
  if (ev.status === 'failed' && check.verified !== false && check.route_m > 0)
    foot.push(`判定距离 ${fmtInt(check.route_m)} m，约 ${Math.round((check.dur_s * opts.scale) / 60)}′`);
  return {
    spec: {
      key: 'evidence',
      // at the unit, like its finding card: the route then leads the eye to the facility
      anchor: spotOf(unit),
      tone: look === 'pseudo' ? 'pseudo' : look === 'blind' || look === 'none' ? 'blind' : 'ink',
      code: unit.code,
      prefer: ['down-right', 'right', 'up-right', 'down', 'left', 'down-left', 'up-left', 'up'],
      routeCost: 150,
    },
    cls: 'ev',
    live: true,
    title: (
      <>
        {tag ? <span className={`tag ${tag[0]}`}>{tag[1]}</span> : null}
        {unit.code} {unit.nameSub || unit.nameMain} <span className="nw">→ {base.facility || cat}</span>
      </>
    ),
    body,
    ...(foot.length
      ? {
          foot: foot.map((f) => (
            <span key={f} className="ev-foot">
              {f.split(' · ').map((part, k) => (
                <span key={k} className="nw">
                  {k ? ' · ' : ''}
                  <NumText text={part} />
                </span>
              ))}
            </span>
          )),
        }
      : {}),
    onClose: opts.onClose,
  };
}
