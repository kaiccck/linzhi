/**
 * 路演模式's card: the step's name, one statement in large type with its numbers in the numeral
 * face, a sentence under it, and the six steps as a quiet progress row. ← / → (or PageUp / PageDown,
 * Space) turn the steps, Home / End jump, Esc leaves. The map beside it does the showing.
 */
import { useEffect } from 'react';
import type { EvidenceView } from '../map/evidenceCard.js';
import type { Part, TourStep } from '../model/tour.js';
import { BrandMark } from './Brand.js';
import { Ui } from './Icons.js';

export function Parts({ parts }: { parts: readonly Part[] }) {
  return (
    <>
      {parts.map((p, i) =>
        typeof p === 'string' ? (
          p
        ) : 'n' in p ? (
          <span key={i} className="num">
            {p.n}
          </span>
        ) : (
          <span key={i} className="code num">
            {p.code}
          </span>
        ),
      )}
    </>
  );
}

/** Keys that turn the steps (a text field keeps its own keys). */
export function tourKey(key: string): 'next' | 'prev' | 'first' | 'last' | 'exit' | null {
  if (key === 'ArrowRight' || key === 'PageDown' || key === ' ') return 'next';
  if (key === 'ArrowLeft' || key === 'PageUp') return 'prev';
  if (key === 'Home') return 'first';
  if (key === 'End') return 'last';
  if (key === 'Escape') return 'exit';
  return null;
}

export function TourCard({
  steps,
  at,
  onGo,
  onExit,
  place,
  code,
  evidence,
}: {
  steps: TourStep[];
  at: number;
  onGo(i: number): void;
  onExit(): void;
  place: string;
  code: string;
  /** the route the step draws (its loading or failure is said here) */
  evidence: EvidenceView | null;
}) {
  const i = Math.min(at, steps.length - 1);
  const step = steps[i]!;
  const last = i === steps.length - 1;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest?.('input, textarea, select, [contenteditable="true"]')) return;
      const k = tourKey(e.key);
      if (!k) return;
      // a focused button turns the step with Space itself
      if (k === 'next' && e.key === ' ' && t?.closest?.('button')) return;
      e.preventDefault();
      if (k === 'exit') onExit();
      else if (k === 'next') (last ? onExit : () => onGo(i + 1))();
      else if (k === 'prev') onGo(Math.max(0, i - 1));
      else onGo(k === 'first' ? 0 : steps.length - 1);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [i, last, steps.length, onGo, onExit]);
  const routeNote =
    step.map.evidence && evidence
      ? evidence.status === 'loading'
        ? '正在取百度步行路线…'
        : evidence.status === 'failed'
          ? evidence.message
          : null
      : null;
  return (
    <section className="tour" aria-label={`路演模式：${place}`} aria-roledescription="演示">
      <header className="tour-top">
        <BrandMark size={26} />
        <span className="tour-place">
          <span className="area-code num">{code}</span>
          {place}
        </span>
        <button type="button" className="x" onClick={onExit} aria-label="退出演示（Esc）">
          <Ui id="ui-close" />
        </button>
      </header>
      <ol className="tour-steps" aria-label="步骤">
        {steps.map((s, k) => (
          <li key={s.id} className={k < i ? 'done' : undefined}>
            <button type="button" aria-current={k === i ? 'step' : undefined} onClick={() => onGo(k)}>
              <span className="st-bar" aria-hidden="true" />
              <span className="lbl">{s.kicker}</span>
            </button>
          </li>
        ))}
      </ol>
      <div className="tour-main" key={step.id} aria-live="polite">
        <p className="tour-kicker">
          <span className="num">{i + 1}</span> / <span className="num">{steps.length}</span>
          {/* the step's name: the step bar above names it on a wide map, only a narrow one needs it here */}
          <span className="tk-name"> · {step.kicker}</span>
        </p>
        <h2 className="tour-head">
          <Parts parts={step.head} />
        </h2>
        <p className="tour-body">
          <Parts parts={step.body} />
        </p>
        {routeNote ? <p className="tour-note">{routeNote}</p> : null}
      </div>
      <footer className="tour-nav">
        <button type="button" className="btn" disabled={i === 0} onClick={() => onGo(i - 1)}>
          <Ui id="ui-back" />
          上一步
        </button>
        <button type="button" className="btn next" onClick={last ? onExit : () => onGo(i + 1)}>
          {last ? '结束演示' : '下一步'}
          {last ? null : <Ui id="ui-next" />}
        </button>
        <span className="tour-keys" aria-hidden="true">
          <kbd>←</kbd>
          <kbd>→</kbd> 翻页 · <kbd>Esc</kbd> 退出
        </span>
      </footer>
    </section>
  );
}
