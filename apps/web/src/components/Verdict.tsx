/**
 * The verdict. On the panel (Verdict): how many communities lack a facility on foot, numeral large, and
 * one quieter line on how few of the gaps the circle finds (a gap is one community × one category). The
 * report prints the two-line claim/walk form (verdictLines); verdictSentence is the spoken whole.
 */
import { distWords, type Model } from '../model/derive.js';
import { checkLook } from '../model/looks.js';

/** What the verdict says, for screen readers and the page's live region: communities, then the gaps. */
export function verdictSentence(model: Model): string {
  const { circleGaps, walkGaps, tally } = model;
  const pending = tally.pending ? `另有 ${tally.pending} 项待核，不计入。` : '';
  if (walkGaps === 0) return `画圈没有找到缺口，走一遍也没有。${pending}`;
  const units = `${tally.units} 个小区步行 ${distWords(model.ruleM)}内至少缺一类设施，画圈只能发现其中 ${tally.circleUnits} 个。`;
  const parts = [
    tally.pseudo ? `${tally.pseudo} 项是画圈漏掉的伪覆盖` : '',
    tally.blind ? `${tally.blind} 项是直线也够不到的盲区` : '',
  ].filter(Boolean);
  return `${units}共 ${walkGaps} 项缺口，画圈只找到 ${circleGaps} 项，其中 ${parts.join('，')}。${pending}`;
}

/** The two lines as parts: the words around each large numeral. */
export function verdictLines(model: Model): {
  claim: (string | { n: number })[];
  walk: (string | { n: number; pseudo?: boolean })[];
} {
  const { circleGaps, walkGaps, tally } = model;
  const claim =
    circleGaps === 0
      ? ['画圈没有找到缺口，']
      : [tally.pseudo ? '画圈只找到 ' : '画圈找到 ', { n: circleGaps }, ' 项缺口，'];
  const where = [' 项，在 ', { n: tally.units }, ' 个小区。'];
  const walk =
    walkGaps === 0
      ? ['走一遍也没有。']
      : walkGaps === circleGaps && !tally.pseudo
        ? ['走一遍也是 ', { n: walkGaps }, ...where]
        : ['走一遍找到 ', { n: walkGaps }, ...where];
  return { claim, walk };
}

/** 伪覆盖, the one term the verdict names: its meaning on hover and to screen readers. */
export const PSEUDO_MEANING =
  '伪覆盖：圈里有、走不到——直线距离在规则内，实际步行超出规则，画圈会把它算作已覆盖';

const pct = (part: number, whole: number) => `${whole ? (100 * part) / whole : 0}%`;

/**
 * The panel's answer, in one unit — communities: how many lack a facility on foot, then the same
 * count as the circle and as the walk, two bars on one scale (the whole area). The few the circle finds
 * are slate on both bars; the walk's extra ones are red (伪覆盖). Under the bars, one line keys each
 * colour once with how many it holds and what it means: the key for the bars and the list below alike.
 */
export function Verdict({ model }: { model: Model }) {
  const { tally } = model;
  const n = model.units.length;
  const rule = `步行 ${distWords(model.ruleM)}内`;
  const missed = tally.units - tally.circleUnits;
  // a borderline walk past the rule shows in the lists' open rows: then it joins the key (one within
  // the rule folds away, its words on its row)
  const edge = model.units.some((u) => model.cats.some((k) => checkLook(u.checks[k]) === 'edge-over'));
  return (
    <section className="verdict" aria-labelledby="verdict-say">
      <p className="sr-only" id="verdict-say" aria-live="polite">
        {verdictSentence(model)}
      </p>
      <div className="v-top" aria-hidden="true">
        <b className="v-n">{tally.units}</b>
        <p className="v-lines">
          <span className="v-t1">个小区缺设施</span>
          <span className="v-t2">
            <span className="num">{n}</span> 个小区中，
            {tally.units ? `${rule}至少缺一类` : `${rule}${model.cats.length} 类设施都走得到`}
          </span>
        </p>
      </div>
      {tally.units ? (
        <>
          <div className="v-compare" aria-hidden="true">
            <span className="vc-k">画圈</span>
            <span className="vc-track">
              <i className="vc-blind" style={{ width: pct(tally.circleUnits, n) }} />
            </span>
            <span className="vc-n num">{tally.circleUnits}</span>
            <span className="vc-k">走一遍</span>
            <span className="vc-track">
              <i className="vc-blind" style={{ width: pct(tally.circleUnits, n) }} />
              <i className="vc-pseudo" style={{ width: pct(missed, n) }} />
            </span>
            <span className="vc-n num">{tally.units}</span>
          </div>
          <ul className="v-key" aria-hidden="true">
            {missed ? (
              <li>
                <i className="sw s-pseudo" />
                <span className="term" title={PSEUDO_MEANING}>
                  伪覆盖
                </span>
                <span>
                  <span className="num">{missed}</span> 个：圈里有、走不到
                </span>
              </li>
            ) : null}
            {tally.circleUnits ? (
              <li>
                <i className="sw s-blind" />
                <b>盲区</b>
                <span>
                  <span className="num">{tally.circleUnits}</span> 个：直线就超出
                </span>
              </li>
            ) : null}
            {edge ? (
              <li>
                <i className="sw s-edge" />
                <b>临界</b>
                <span>
                  差不到 <span className="num">50</span> m
                </span>
              </li>
            ) : null}
            {tally.pending ? (
              <li>
                <i className="sw s-pending" />
                <b>待核</b>
                <span>
                  <span className="num">{tally.pending}</span> 项，不计入
                </span>
              </li>
            ) : null}
          </ul>
        </>
      ) : null}
    </section>
  );
}

/** The verdict in one quiet line (the 问询 panel keeps the conclusion above the desk). */
export function VerdictBrief({ model }: { model: Model }) {
  const { circleGaps, walkGaps, tally } = model;
  return (
    <p className="v-brief">
      <span className="sr-only">{verdictSentence(model)}</span>
      <span aria-hidden="true">
        画圈 <span className="num">{circleGaps}</span> 项缺口 · 走一遍 <span className="num">{walkGaps}</span>{' '}
        项
        {tally.units ? (
          <>
            {' '}
            · <span className="num">{tally.units}</span> 个小区
          </>
        ) : null}
      </span>
    </p>
  );
}
