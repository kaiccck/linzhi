/**
 * 问询 — the board's information desk (DESIGN.md world, no chat furniture): questions go to the desk,
 * answers come back as sign text. Every number sits in the numeral face with its source plate
 * (T1 …), community names carry their unit code and light the unit on the map, and each answer
 * closes with how it was made (template or model) and whether its numbers were checked.
 */
import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  fmtBytes,
  formatName,
  historyOf,
  makeInliner,
  parseAnswer,
  suggestionsFor,
  tokenizeBlocks,
  type Inline,
  type Suggestion,
  type TBlock,
} from '../advisor/answer.js';
import type { Health } from '../data/api.js';
import {
  ask,
  QUESTION_MAX,
  type AskAnswer,
  type AskAttachment,
  type AskCitation,
  type AskStep,
} from '../data/ask.js';
import type { SampleInfo } from '../data/loadAnalysis.js';
import type { Model } from '../model/derive.js';
import { spotOf, spotWords, type MapSpot } from '../model/spots.js';
import { Pg } from './Icons.js';
import { NumText } from './NumText.js';

type Exchange = { key: number; question: string } & (
  | { status: 'pending'; steps: AskStep[] }
  | { status: 'done'; answer: AskAnswer }
  | { status: 'failed'; message: string }
  | { status: 'stopped' }
);

/** A model id as people know it: deepseek-flash → DeepSeek; an unknown id as it is. */
function modelName(id: string | null | undefined): string {
  if (!id) return '大模型';
  const known: [RegExp, string][] = [
    [/deepseek/i, 'DeepSeek'],
    [/qwen|tongyi/i, '通义千问'],
    [/glm|zhipu/i, '智谱 GLM'],
    [/kimi|moonshot/i, 'Kimi'],
    [/doubao/i, '豆包'],
    [/claude/i, 'Claude'],
    [/gpt|openai/i, 'OpenAI'],
  ];
  return known.find(([re]) => re.test(id))?.[1] ?? id;
}

export interface AdvisorProps {
  model: Model;
  /** what POST /api/ask answers about (the analysis on screen) */
  analysisId: string | null;
  /** why asking is impossible here (no server …); null = it works */
  blocked: string | null;
  advisor: Health['advisor'];
  samples: SampleInfo[];
  hidden: boolean;
  onHot(code: string | null): void;
  /** the places lit on the map now (the screen owns them: the map's chip can clear a pinned one) */
  spot?: { spot: MapSpot; pinned: boolean } | null;
  /** a citation pointed at (hover) or opened (click): its places on the map */
  onSpot?(s: { spot: MapSpot; pinned: boolean } | null): void;
}

/** A tool that has started replaces nothing; its result replaces the started line of the same tool. */
function mergeStep(steps: AskStep[], step: AskStep): AskStep[] {
  if (step.kind === 'tool' && step.done) {
    const i = steps.findLastIndex((s) => s.kind === 'tool' && !s.done && s.tool === step.tool);
    if (i >= 0) return steps.map((s, k) => (k === i ? step : s));
  }
  return [...steps, step];
}

const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * L̂ (the siting estimator's symbol in the tools' text) read out in words: planners read “估算步行”,
 * not a statistics hat; the sentence keeps its meaning (估算步行 ≈ 354 m).
 */
const LHat = () => <span className="lhat">估算步行</span>;

// ------------------------------------------------------------------------------ citations

interface Pop {
  cite: AskCitation;
  rect: DOMRect;
  pinned: boolean;
  /** the exchange the citation belongs to (T1 of one answer is not T1 of the next) */
  x: number;
}

export interface RenderCtx {
  /** id prefix of this answer's citation descriptions */
  prefix: string;
  cites: Map<string, AskCitation>;
  units: Map<string, string>;
  show(cite: AskCitation, el: HTMLElement, pin?: boolean): void;
  hide(): void;
  onHot(code: string | null): void;
}

function CitePlate({ id, ctx }: { id: string; ctx: RenderCtx }) {
  const cite = ctx.cites.get(id);
  if (!cite) {
    return (
      <span className="cite num orphan" title={`${id}：本轮没有这个工具结果`}>
        {id}
      </span>
    );
  }
  return (
    <button
      type="button"
      className="cite num"
      aria-describedby={`${ctx.prefix}-${id}`}
      onMouseEnter={(e) => ctx.show(cite, e.currentTarget)}
      onMouseLeave={ctx.hide}
      onFocus={(e) => ctx.show(cite, e.currentTarget)}
      onBlur={ctx.hide}
      onClick={(e) => ctx.show(cite, e.currentTarget, true)}
    >
      {id}
    </button>
  );
}

/** A community in the answer: its code plate on first mention, and the unit lit on the map while pointed at. */
function UnitRef({
  code,
  name,
  repeat,
  ctx,
}: {
  code: string;
  name: string | null;
  repeat: boolean;
  ctx: RenderCtx;
}) {
  const full = ctx.units.get(code) ?? name ?? code;
  return (
    <button
      type="button"
      className={'uref' + (repeat ? ' again' : '')}
      aria-label={`${code} ${full}（在地图上标出）`}
      onMouseEnter={() => ctx.onHot(code)}
      onMouseLeave={() => ctx.onHot(null)}
      onFocus={() => ctx.onHot(code)}
      onBlur={() => ctx.onHot(null)}
    >
      {repeat ? null : <span className="code num">{code}</span>}
      {name ? <span className="nm">{name}</span> : null}
    </button>
  );
}

/** closing punctuation that must not start a line after a citation plate */
const CLOSING = /^[。，、；：！？）」』”’,.;:!?)]+/;

function inline(p: Inline, k: number | string, ctx: RenderCtx): ReactNode {
  switch (p.t) {
    case 'text':
      return <Fragment key={k}>{p.s}</Fragment>;
    case 'num':
      return (
        <span key={k} className="num n">
          {p.s}
        </span>
      );
    case 'cite':
      return (
        <span key={k} className="cites">
          {p.ids.map((id) => (
            <CitePlate key={id} id={id} ctx={ctx} />
          ))}
        </span>
      );
    case 'unit':
      return <UnitRef key={k} code={p.code} name={p.name} repeat={!!p.repeat} ctx={ctx} />;
    case 'lhat':
      return <LHat key={k} />;
    case 'strong':
      return (
        <strong key={k}>
          <Inlines parts={p.parts} ctx={ctx} />
        </strong>
      );
  }
}

export function Inlines({ parts, ctx }: { parts: Inline[]; ctx: RenderCtx }): ReactNode {
  const out: ReactNode[] = [];
  for (let k = 0; k < parts.length; k++) {
    const p = parts[k]!;
    const next = parts[k + 1];
    const stop = p.t === 'cite' && next?.t === 'text' ? CLOSING.exec(next.s) : null;
    if (stop && next?.t === 'text') {
      // the full stop after a citation stays on the citation's line
      out.push(
        <span key={k} className="nw">
          {inline(p, 'c', ctx)}
          {stop[0]}
        </span>,
      );
      const rest = next.s.slice(stop[0].length);
      if (rest) out.push(<Fragment key={`${k}r`}>{rest}</Fragment>);
      k++;
      continue;
    }
    out.push(inline(p, k, ctx));
  }
  return out;
}

function Lines({ lines, ctx }: { lines: Inline[][]; ctx: RenderCtx }) {
  return lines.map((line, k) => (
    <Fragment key={k}>
      {k ? <br /> : null}
      <Inlines parts={line} ctx={ctx} />
    </Fragment>
  ));
}

function BlockView({ b, lead, ctx }: { b: TBlock; lead: boolean; ctx: RenderCtx }) {
  switch (b.t) {
    case 'p':
      return (
        <p className={lead ? 'lead' : undefined}>
          {b.tag === 'conclusion' ? <span className="ans-tag">结论</span> : null}
          {b.tag === 'estimate' ? (
            <span className="ans-tag est" title="估算：未经实测核验">
              估算
            </span>
          ) : null}
          <Lines lines={b.lines} ctx={ctx} />
        </p>
      );
    case 'h':
      return (
        <p className="ans-h">
          <Lines lines={b.lines} ctx={ctx} />
        </p>
      );
    case 'list': {
      const Tag = b.ordered ? 'ol' : 'ul';
      return (
        <Tag className="ans-list">
          {b.items.map((item, k) => (
            <li key={k}>
              <Lines lines={item} ctx={ctx} />
            </li>
          ))}
        </Tag>
      );
    }
    case 'table': {
      const [head, ...rows] = b.rows;
      return (
        <div className="ans-table">
          <table>
            {head ? (
              <thead>
                <tr>
                  {head.map((c, k) => (
                    <th key={k}>
                      <Lines lines={c} ctx={ctx} />
                    </th>
                  ))}
                </tr>
              </thead>
            ) : null}
            <tbody>
              {rows.map((r, k) => (
                <tr key={k}>
                  {r.map((c, j) => (
                    <td key={j}>
                      <Lines lines={c} ctx={ctx} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
  }
}

// --------------------------------------------------------------------------------- answer

/** User-initiated only: the report is handed to the browser as a Blob, never fetched again. */
function download(att: AskAttachment) {
  const blob = new Blob([att.content], { type: `${att.mime_type || 'text/plain'};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = att.filename.replace(/[\\/:*?"<>|]+/g, '-') || 'zoudedao-report.md';
  document.body.append(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function FilePlate({ att }: { att: AskAttachment }) {
  const kind = formatName(att.mime_type, att.filename);
  const size = fmtBytes(new TextEncoder().encode(att.content).length);
  return (
    <button type="button" className="ask-file" onClick={() => download(att)}>
      <span className="tile" aria-hidden="true">
        <Pg id="pg-download" />
      </span>
      <span className="txt">
        <b>下载体检报告（{kind}）</b>
        <small className="num">
          {att.filename} · {size}
        </small>
      </span>
    </button>
  );
}

/** The source card's controller: `x` is the exchange the citation belongs to. */
interface PopCtl {
  show(cite: AskCitation, el: HTMLElement, pin: boolean | undefined, x: number): void;
  hide(): void;
}

/** How the answer was made and whether its numbers were checked, in plain words. */
function AnswerMeta({ a, ctx, aboutOther }: { a: AskAnswer; ctx: RenderCtx; aboutOther: string | null }) {
  const g = a.grounding;
  const made =
    a.mode === 'llm'
      ? `大模型回答 · ${a.model ?? '已配置的模型'}${a.repaired ? '（初稿有数字找不到出处，已按工具结果改写）' : ''}`
      : a.fallback
        ? `模板回答（已配置大模型${a.model ? ` ${a.model}` : ''}，这次没有采用它的回答）`
        : '模板回答（未配置大模型）';
  let ground: ReactNode;
  let ok = g.ok;
  if (a.fallback?.unsupported.length) {
    ok = false;
    ground = (
      <>
        大模型的初稿里有找不到出处的数字（
        <NumText text={a.fallback.unsupported.join('、')} />
        ），所以这里显示模板回答
        {g.ok ? (
          <>
            {' '}
            · 模板回答核对 <span className="num n">{g.checked}</span> 个数字，均可溯源
          </>
        ) : null}
      </>
    );
  } else if (a.fallback) {
    ok = false;
    const why = a.fallback.reason.length > 60 ? `${a.fallback.reason.slice(0, 60)}…` : a.fallback.reason;
    ground = (
      <>
        <NumText text={why} />
        {g.ok ? (
          <>
            {' '}
            · 模板回答核对 <span className="num n">{g.checked}</span> 个数字，均可溯源
          </>
        ) : null}
      </>
    );
  } else if (!g.ok) {
    ground = (
      <>
        有 <span className="num n">{g.unsupported.length}</span> 个数字没能溯源：
        <NumText text={g.unsupported.join('、')} />
      </>
    );
  } else if (g.checked === 0) {
    ground = '回答里没有需要核对的数字';
  } else {
    ground = (
      <>
        数字均可溯源 · 核对 <span className="num n">{g.checked}</span> 个数字
        {g.uncited.length ? (
          <>
            （<span className="num n">{g.uncited.length}</span> 个没有标出处）
          </>
        ) : null}
      </>
    );
  }
  return (
    <div className="ask-meta">
      {a.citations.length ? (
        <p className="ask-src">
          <span className="lbl">依据</span>
          {a.citations.map((c) => (
            <span className="src" key={c.id}>
              <CitePlate id={c.id} ctx={ctx} />
              {c.title}
            </span>
          ))}
        </p>
      ) : null}
      <p className="ask-made">
        {made}
        {aboutOther ? ` · 按${aboutOther}回答` : ''}
      </p>
      <p className={'ask-ground' + (ok ? ' ok' : ' warn')}>
        <span className="tick" aria-hidden="true">
          {ok ? <Pg id="pg-check" /> : null}
        </span>
        <span>
          {ground}
          {a.citations_added?.length ? (
            // the model's numbers were all traceable; the server only added a missing source mark
            <span className="added" title={`系统补标的出处：${a.citations_added.join('；')}`}>
              {' '}
              · 已补标出处
              <span className="sr-only">：{a.citations_added.join('；')}</span>
            </span>
          ) : null}
        </span>
      </p>
      {a.citations.map((c) => (
        <span key={c.id} id={`${ctx.prefix}-${c.id}`} className="sr-only">
          {c.id} {c.title}：{c.summary}
        </span>
      ))}
    </div>
  );
}

function AnswerView({
  a,
  x,
  units,
  unitNames,
  aboutOther,
  pop,
  onHot,
}: {
  a: AskAnswer;
  x: number;
  units: { code: string; name: string }[];
  unitNames: Map<string, string>;
  aboutOther: string | null;
  pop: PopCtl;
  onHot(code: string | null): void;
}) {
  const prefix = useId().replace(/:/g, '');
  const blocks = useMemo(
    () =>
      tokenizeBlocks(
        parseAnswer(a.answer),
        makeInliner(
          units,
          a.citations.map((c) => c.id),
        ),
      ),
    [a.answer, a.citations, units],
  );
  const ctx: RenderCtx = {
    prefix,
    cites: new Map(a.citations.map((c) => [c.id, c])),
    units: unitNames,
    onHot,
    show: (cite, el, pin) => pop.show(cite, el, pin, x),
    hide: pop.hide,
  };
  return (
    <div className="ask-body">
      {blocks.map((b, k) => (
        <BlockView key={k} b={b} lead={k === 0} ctx={ctx} />
      ))}
      {a.attachments?.map((att) => (
        <FilePlate key={att.filename} att={att} />
      ))}
      <AnswerMeta a={a} ctx={ctx} aboutOther={aboutOther} />
    </div>
  );
}

function Steps({ steps }: { steps: AskStep[] }) {
  if (!steps.length) return <p className="ask-step now">正在查询…</p>;
  return (
    <ul className="ask-steps">
      {steps.map((s, k) =>
        s.kind === 'note' ? (
          <li key={k} className="ask-step">
            <NumText text={s.text} />
          </li>
        ) : (
          <li key={k} className={'ask-step' + (s.done ? '' : ' now')}>
            {s.done
              ? s.error
                ? `没查到：${s.title}（${s.error}）`
                : `已查：${s.title}`
              : `正在查：${s.title}…`}
            {s.id ? <span className="cite num static">{s.id}</span> : null}
          </li>
        ),
      )}
    </ul>
  );
}

/** A suggested question, with the unit code in it set as a plate. */
function SuggestionText({ s, model }: { s: string; model: Model }) {
  const m = /([A-Z]-\d{2}) /.exec(s);
  if (!m || !model.units.some((u) => u.code === m[1])) return <>{s}</>;
  return (
    <>
      {s.slice(0, m.index)}
      <span className="code num">{m[1]}</span>
      {s.slice(m.index + m[0].length - 1)}
    </>
  );
}

// ---------------------------------------------------------------------------------- panel

/**
 * The server's tools know communities by name, not by the codes the map prints: a bare code in the
 * question goes out with its name ("A-11" → "A-11（申城佳苑三期B块）"); the log keeps what was typed.
 */
export function withNames(question: string, model: Model): string {
  const byCode = new Map(model.units.map((u) => [u.code, u.name]));
  return question.replace(/[A-Z]-\d{2}/g, (code, at: number) => {
    const name = byCode.get(code);
    if (!name) return code;
    const rest = question.slice(at + code.length).replace(/^[\s（(]+/, '');
    return rest.startsWith(name) ? code : `${code}（${name}）`;
  });
}

export const AdvisorPanel = memo(function AdvisorPanel({
  model,
  analysisId,
  blocked,
  advisor,
  samples,
  hidden,
  onHot,
  spot = null,
  onSpot,
}: AdvisorProps) {
  const [exchanges, setExchanges] = useState<Exchange[]>([]);
  const [draft, setDraft] = useState('');
  const [pop, setPop] = useState<Pop | null>(null);
  const seq = useRef(0);
  const ctl = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const hideTimer = useRef(0);
  const busy = exchanges.some((x) => x.status === 'pending');
  const suggestions = useMemo(() => suggestionsFor(model), [model]);
  const units = useMemo(() => model.units.map((u) => ({ code: u.code, name: u.name })), [model]);
  const unitNames = useMemo(() => new Map(model.units.map((u) => [u.code, u.name])), [model]);
  const disabled = blocked !== null || analysisId === null;

  const update = useCallback((key: number, next: Partial<Exchange> & Pick<Exchange, 'status'>) => {
    setExchanges((xs) => xs.map((x) => (x.key === key ? ({ ...x, ...next } as Exchange) : x)));
  }, []);

  const send = useCallback(
    (text: string, replace?: number) => {
      const question = text.trim().slice(0, QUESTION_MAX);
      if (!question || busy || disabled || !analysisId) return;
      const key = ++seq.current;
      const done = exchanges.flatMap((x) =>
        x.status === 'done' ? [{ question: x.question, answer: x.answer }] : [],
      );
      setExchanges((xs) => [
        ...xs.filter((x) => x.key !== replace),
        { key, question, status: 'pending', steps: [] },
      ]);
      setDraft('');
      const c = new AbortController();
      ctl.current = c;
      ask(
        { question: withNames(question, model), analysis_id: analysisId, history: historyOf(done) },
        (step) =>
          setExchanges((xs) =>
            xs.map((x) =>
              x.key === key && x.status === 'pending' ? { ...x, steps: mergeStep(x.steps, step) } : x,
            ),
          ),
        c.signal,
      )
        .then((answer) => update(key, { status: 'done', answer }))
        .catch((err: unknown) => {
          if (c.signal.aborted) update(key, { status: 'stopped' });
          else update(key, { status: 'failed', message: err instanceof Error ? err.message : String(err) });
        })
        .finally(() => {
          if (ctl.current === c) ctl.current = null;
        });
    },
    [analysisId, busy, disabled, exchanges, update, model],
  );
  const stop = useCallback(() => ctl.current?.abort(), []);
  useEffect(() => () => ctl.current?.abort(), []);

  // Esc stops a running answer (and closes a pinned source card, and the places it lit)
  const spotPinned = !!spot?.pinned;
  useEffect(() => {
    if (hidden || (!busy && !pop && !spotPinned)) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (pop || spotPinned) {
        setPop(null);
        onSpot?.(null);
      } else stop();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [hidden, busy, pop, spotPinned, stop, onSpot]);

  // a pinned card (touch) closes on the next tap elsewhere; any card closes when the log scrolls
  useEffect(() => {
    if (!pop) return;
    const close = (e: Event) => {
      if (e.type === 'pointerdown' && (e.target as Element | null)?.closest?.('.cite, .cite-pop')) return;
      setPop(null);
    };
    const box = scrollRef.current;
    document.addEventListener('pointerdown', close);
    box?.addEventListener('scroll', close, { passive: true });
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('pointerdown', close);
      box?.removeEventListener('scroll', close);
      window.removeEventListener('resize', close);
    };
  }, [pop]);

  // A citation's places on the map (anchors of another analysis have none here): lit while it is
  // pointed at, kept once it is clicked — until it is clicked again, Esc, or the map's chip clears
  // it. On a phone the map sits above the answer: a click brings the map into view.
  const live = useRef({ model, analysisId, onSpot, spot });
  live.current = { model, analysisId, onSpot, spot };
  const popCtl = useMemo<PopCtl>(() => {
    const spotFor = (cite: AskCitation, x: number) =>
      spotOf(live.current.model, live.current.analysisId, cite, `${x}:${cite.id}`);
    return {
      show(cite, el, pin = false, x) {
        window.clearTimeout(hideTimer.current);
        setPop((p) =>
          pin && p?.pinned && p.cite === cite
            ? null
            : { cite, rect: el.getBoundingClientRect(), pinned: pin || !!p?.pinned, x },
        );
        const s = spotFor(cite, x);
        const { spot: now, onSpot: tell } = live.current;
        if (pin) {
          if (now?.pinned && s && now.spot.key === s.key) {
            tell?.(null);
            return;
          }
          if (!s) return;
          tell?.({ spot: s, pinned: true });
          const map = document.querySelector<HTMLElement>('.map');
          const r = map?.getBoundingClientRect();
          if (map && r && window.matchMedia('(max-width: 760px)').matches && r.bottom < 120) {
            map.scrollIntoView({ block: 'start', behavior: reduceMotion() ? 'auto' : 'smooth' });
            setPop(null);
          }
        } else if (!now?.pinned) tell?.(s ? { spot: s, pinned: false } : null);
      },
      hide() {
        window.clearTimeout(hideTimer.current);
        hideTimer.current = window.setTimeout(() => {
          setPop((p) => (p?.pinned ? p : null));
          if (!live.current.spot?.pinned) live.current.onSpot?.(null);
        }, 140);
      },
    };
  }, []);
  useEffect(() => () => live.current.onSpot?.(null), []);

  // a new question scrolls into view; the answer then grows below it without moving the page
  const lastKey = exchanges.at(-1)?.key;
  useLayoutEffect(() => {
    const box = scrollRef.current;
    const el = lastKey === undefined ? null : box?.querySelector<HTMLElement>(`[data-x="${lastKey}"]`);
    if (!box || !el) return;
    const behavior = reduceMotion() ? 'auto' : 'smooth';
    if (box.scrollHeight > box.clientHeight + 1 && getComputedStyle(box).overflowY !== 'visible') {
      box.scrollTo({ top: Math.max(0, el.offsetTop - 2), behavior });
    } else {
      el.scrollIntoView({ block: 'nearest', behavior });
    }
  }, [lastKey]);

  const baseOf = (id: string | null | undefined) => id?.replace(/~elder$/, '') ?? null;
  const aboutOther = (a: AskAnswer): string | null => {
    const base = baseOf(a.analysis_id);
    if (!base || base === baseOf(analysisId)) return null;
    return samples.find((s) => s.id === base)?.name ?? base;
  };

  // who words the answers, and where the numbers come from (they never come from the model)
  const modeLine =
    advisor?.mode === 'llm'
      ? `措辞：${modelName(advisor.model)} · 数字来自体检结果`
      : advisor?.mode === 'template'
        ? '模板回答 · 未配置大模型'
        : null;

  return (
    <section className="advisor" id="panel-ask" role="tabpanel" aria-labelledby="tab-ask" hidden={hidden}>
      {modeLine && !disabled ? (
        <div className="ask-head">
          <span className="ask-mode" title={advisor?.model ? `模型 ${advisor.model}` : undefined}>
            {modeLine}
          </span>
        </div>
      ) : null}
      <div className="ask-scroll" ref={scrollRef}>
        {exchanges.length === 0 ? (
          <div className="ask-intro">
            {disabled ? (
              <p className="ask-lead">
                <strong>问询需要连接邻至服务端。</strong>
                {blocked}
              </p>
            ) : (
              <p className="ask-lead">
                每个数字都标出处
                <span className="cite num static" aria-hidden="true">
                  T1
                </span>
                ，悬停可以核对。
              </p>
            )}
            <ul className="ask-suggest" aria-label="可以这样问">
              {suggestions.map((s: Suggestion) => (
                <li key={s.question}>
                  <button type="button" disabled={disabled} onClick={() => send(s.question)}>
                    <span>
                      <SuggestionText s={s.question} model={model} />
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <ol className="ask-log" role="log" aria-label="问询记录" aria-live="polite">
          {exchanges.map((x) => (
            <li className="ask-x" key={x.key} data-x={x.key} aria-busy={x.status === 'pending'}>
              <div className="ask-q">
                <span className="ask-mark" aria-hidden="true">
                  问
                </span>
                <p>
                  <span className="sr-only">问：</span>
                  <SuggestionText s={x.question} model={model} />
                </p>
              </div>
              <div className={`ask-a ${x.status}`}>
                <span className="ask-mark a" aria-hidden="true">
                  答
                </span>
                <span className="sr-only">答：</span>
                {x.status === 'pending' ? <Steps steps={x.steps} /> : null}
                {x.status === 'done' ? (
                  <AnswerView
                    a={x.answer}
                    x={x.key}
                    units={units}
                    unitNames={unitNames}
                    aboutOther={aboutOther(x.answer)}
                    pop={popCtl}
                    onHot={onHot}
                  />
                ) : null}
                {x.status === 'failed' || x.status === 'stopped' ? (
                  <p className="ask-fail">
                    {x.status === 'stopped' ? '已停止。' : `没能回答：${x.message}`}
                    <button
                      type="button"
                      className="link"
                      disabled={busy || disabled}
                      onClick={() => send(x.question, x.key)}
                    >
                      再问一次
                    </button>
                  </p>
                ) : null}
              </div>
            </li>
          ))}
        </ol>
      </div>

      <form
        className="ask-dock"
        onSubmit={(e) => {
          e.preventDefault();
          if (busy) stop();
          else send(draft);
        }}
      >
        {exchanges.length > 0 ? (
          <div className="ask-quick" role="group" aria-label="常见问题">
            {suggestions.map((s) => (
              <button
                key={s.question}
                type="button"
                disabled={busy || disabled}
                title={s.question}
                aria-label={s.question}
                onClick={() => send(s.question)}
              >
                {s.short}
              </button>
            ))}
          </div>
        ) : null}
        <div className={'ask-plate' + (busy ? ' busy' : '')}>
          <Pg id="pg-info" />
          <input
            ref={inputRef}
            type="text"
            value={draft}
            maxLength={QUESTION_MAX}
            readOnly={busy}
            disabled={disabled}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={disabled ? '问询需要连接服务端' : '例如：哪个小区上学最远？'}
            aria-label="向问询处提问"
            enterKeyHint="send"
            autoComplete="off"
          />
          <button
            type="submit"
            className="ask-go"
            data-busy={busy}
            disabled={disabled || (!busy && !draft.trim())}
            aria-label={busy ? '停止回答（Esc）' : '提问'}
          >
            {busy ? '停止' : '提问'}
          </button>
        </div>
        <span className="sr-only" role="status">
          {busy ? '正在回答' : ''}
        </span>
      </form>
      {pop && !hidden ? (
        <CitePop
          pop={pop}
          spot={spotOf(model, analysisId, pop.cite, `${pop.x}:${pop.cite.id}`)}
          onEnter={() => window.clearTimeout(hideTimer.current)}
          onLeave={popCtl.hide}
        />
      ) : null}
    </section>
  );
});

/** The source card of a citation plate: fixed, so no scrolling box clips it; clamped to the window. */
function CitePop({
  pop,
  spot,
  onEnter,
  onLeave,
}: {
  pop: Pop;
  spot: MapSpot | null;
  onEnter(): void;
  onLeave(): void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const { innerWidth: vw, innerHeight: vh } = window;
    const left = Math.min(Math.max(8, pop.rect.left + pop.rect.width / 2 - w / 2), vw - w - 8);
    let top = pop.rect.bottom + 8;
    if (top + h > vh - 8) top = Math.max(8, pop.rect.top - 8 - h);
    setPos({ left, top });
  }, [pop]);
  return (
    <div
      ref={ref}
      className="cite-pop"
      aria-hidden="true"
      style={pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: 'hidden' }}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      <b>
        <span className="cite num static">{pop.cite.id}</span>
        {pop.cite.title}
      </b>
      {spot ? (
        <p className="pop-map">
          地图上标出 <NumText text={spotWords(spot)} />
          {pop.pinned ? '' : '（点开可固定）'}
        </p>
      ) : null}
      <p className="pop-sum">
        <NumText text={pop.cite.summary} />
      </p>
    </div>
  );
}
