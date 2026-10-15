/**
 * 问 AI: questions about the area on screen (POST /api/ask), answered as an event stream — which
 * analysis tools ran, then one answer whose every number cites a tool result [T1]. A cited
 * community's code opens it on the map; a citation opens what the tool returned.
 */
import { Input, ScrollView, Text, View } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  historyOf,
  makeInliner,
  parseAnswer,
  stripFooter,
  suggestionsFor,
  tokenizeBlocks,
  type Inline,
  type TBlock,
} from '@web/advisor/answer';
import { ask, QUESTION_MAX, type AskAnswer, type AskCitation, type AskStep } from '@web/data/ask';
import type { Model } from '@web/model/derive';
import { unitNo } from '../../model/unitNo';
import { Icon } from '../../platform/Icons';
import * as store from '../../state/store';
import './index.css';

interface Turn {
  question: string;
  steps: AskStep[];
  answer: AskAnswer | null;
  error: string | null;
}

/** The answer as tokenized blocks; on an engine without regex lookbehind, as plain paragraphs. */
function blocksOf(model: Model, a: AskAnswer): TBlock[] {
  const text = stripFooter(a.answer);
  try {
    const units = model.units.map((u) => ({ code: u.code, name: u.name }));
    const nameOf = new Map(units.map((u) => [u.code, u.name]));
    // a code the answer gives alone still shows as the community's name
    const named = (xs: Inline[]): Inline[] =>
      xs.map((x) =>
        x.t === 'unit' && !x.name
          ? { ...x, name: nameOf.get(x.code) ?? null }
          : x.t === 'strong'
            ? { ...x, parts: named(x.parts) }
            : x,
      );
    const raw = makeInliner(
      units,
      a.citations.map((c) => c.id),
    );
    const inline = (text: string) => named(raw(text));
    return tokenizeBlocks(parseAnswer(text), inline);
  } catch {
    return text.split(/\n{2,}/).map((p) => ({ t: 'p', lines: p.split('\n').map((s) => [{ t: 'text', s }]) }));
  }
}

function InlineText({
  parts,
  onUnit,
  onCite,
}: {
  parts: Inline[];
  onUnit(code: string): void;
  onCite(id: string): void;
}) {
  return (
    <>
      {parts.map((p, i): ReactNode => {
        switch (p.t) {
          case 'text':
            return <Text key={i}>{p.s}</Text>;
          case 'num':
            return (
              <Text key={i} className="a-num num">
                {p.s}
              </Text>
            );
          case 'cite':
            return (
              <Text key={i}>
                {p.ids.map((id) => (
                  <Text key={id} className="a-cite num" onClick={() => onCite(id)}>
                    {id}
                  </Text>
                ))}
              </Text>
            );
          case 'unit':
            return (
              <Text key={i} className="a-unit" onClick={() => onUnit(p.code)}>
                {p.name || `${unitNo(p.code)} 号小区`}
              </Text>
            );
          case 'lhat':
            return <Text key={i}>L̂</Text>;
          case 'strong':
            return (
              <Text key={i} className="a-strong">
                <InlineText parts={p.parts} onUnit={onUnit} onCite={onCite} />
              </Text>
            );
        }
      })}
    </>
  );
}

function Answer({
  model,
  a,
  onUnit,
  onCite,
}: {
  model: Model;
  a: AskAnswer;
  onUnit(c: string): void;
  onCite(id: string): void;
}) {
  const blocks = useMemo(() => blocksOf(model, a), [model, a]);
  const line = (parts: Inline[], k: number) => (
    <View key={k} className="a-line">
      <InlineText parts={parts} onUnit={onUnit} onCite={onCite} />
    </View>
  );
  return (
    <View className="answer">
      {blocks.map((b, i) => {
        if (b.t === 'p')
          return (
            <View key={i} className={'a-p' + (b.tag ? ` tag-${b.tag}` : '')}>
              {b.tag ? (
                <Text className="a-tag">{b.tag === 'conclusion' ? '结论' : '估算，未经实测核验'}</Text>
              ) : null}
              {b.lines.map(line)}
            </View>
          );
        if (b.t === 'h')
          return (
            <View key={i} className="a-h">
              {b.lines.map(line)}
            </View>
          );
        if (b.t === 'list')
          return (
            <View key={i} className="a-list">
              {b.items.map((item, k) => (
                <View key={k} className="a-li">
                  <Text className="a-bullet">{b.ordered ? `${k + 1}.` : '•'}</Text>
                  <View className="a-li-body">{item.map(line)}</View>
                </View>
              ))}
            </View>
          );
        return (
          <ScrollView key={i} scrollX className="a-table-wrap">
            <View className="a-table">
              {b.rows.map((r, k) => (
                <View key={k} className={'a-tr' + (k === 0 ? ' head' : '')}>
                  {r.map((cell, j) => (
                    <View key={j} className="a-td">
                      {cell.map(line)}
                    </View>
                  ))}
                </View>
              ))}
            </View>
          </ScrollView>
        );
      })}
      <View className="a-foot">
        <Icon
          id={a.grounding.ok ? 'pg-check' : 'pg-info'}
          color={a.grounding.ok ? '#1F9A8C' : '#B98010'}
          size={13}
        />
        <Text>
          {a.grounding.ok
            ? `${a.grounding.checked} 个数字都能在分析结果里找到出处`
            : `有 ${a.grounding.unsupported.length} 个数字没有找到出处，请对照原数据`}
          {a.mode === 'llm' ? ` · ${a.model ?? '大模型'}` : ' · 模板回答'}
        </Text>
      </View>
    </View>
  );
}

export default function AskPage() {
  const s = store.useStore();
  const shown = store.shown(s);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [q, setQ] = useState('');
  const [cite, setCite] = useState<AskCitation | null>(null);
  const [bottom, setBottom] = useState('');
  const ctl = useRef<AbortController | null>(null);
  useEffect(() => () => ctl.current?.abort(), []);
  // dev builds only: the capture script asks through getApp().__zdd.ask(question) (set after mount:
  // the map screen's cleanup clears the hooks when a relaunch replaces it)
  const sendRef = useRef<(q: string) => void>(() => {});
  useEffect(() => {
    if (process.env.NODE_ENV === 'production') return;
    const app = Taro.getApp<{ __zdd?: Record<string, unknown> }>();
    app.__zdd = { ...(app.__zdd ?? {}), ask: (q: string) => sendRef.current(q) };
  });

  if (!shown) return <View className="ask-empty">先回到地图选一个片区</View>;
  const { model } = shown;
  const busy = turns.some((t) => !t.answer && !t.error);
  // the score on screen first: what a newcomer asks before anything else
  const suggestions = [
    { question: `${model.data.meta.name}的体检评分为什么是这个分数？`, short: '评分是怎么来的？' },
    ...suggestionsFor(model),
  ];

  const send = (text: string) => {
    const question = text.trim().slice(0, QUESTION_MAX);
    if (!question || busy) return;
    if (shown.askBlocked) {
      Taro.showToast({ title: shown.askBlocked, icon: 'none' });
      return;
    }
    const history = historyOf(
      turns.flatMap((t) => (t.answer ? [{ question: t.question, answer: t.answer }] : [])),
    );
    const at = turns.length;
    setTurns((ts) => [...ts, { question, steps: [], answer: null, error: null }]);
    setQ('');
    setBottom(`turn-${at}`);
    const c = new AbortController();
    ctl.current = c;
    const patch = (f: (t: Turn) => Turn) => setTurns((ts) => ts.map((t, i) => (i === at ? f(t) : t)));
    ask(
      { question, ...(shown.analysisId ? { analysis_id: shown.analysisId } : {}), history },
      (step) =>
        patch((t) => {
          // a tool's result replaces its call
          const steps =
            step.kind === 'tool' && step.done
              ? t.steps.map((x) => (x.kind === 'tool' && x.tool === step.tool && !x.done ? step : x))
              : [...t.steps, step];
          return { ...t, steps };
        }),
      c.signal,
    )
      .then((answer) => {
        patch((t) => ({ ...t, answer }));
        setBottom(`turn-${at}-end`);
      })
      .catch((err: unknown) => {
        if (c.signal.aborted) return;
        patch((t) => ({ ...t, error: err instanceof Error ? err.message : String(err) }));
      });
  };

  sendRef.current = send;

  const onUnit = (code: string) => {
    store.openUnitOnMap(code);
    Taro.navigateBack().catch(() => {});
  };
  const onCite = (id: string, a: AskAnswer) => setCite(a.citations.find((c) => c.id === id) ?? null);

  return (
    <View className="ask">
      <View className="ask-ctx">
        <Text className="ask-area">{model.data.meta.name}</Text>
        <Text className="ask-brief">
          {model.tally.units} 个小区步行 1 公里内缺设施 · 按直线距离
          {model.tally.circleUnits < model.tally.units ? '只看出' : '也是'} {model.tally.circleUnits} 个
        </Text>
      </View>
      <ScrollView scrollY className="ask-log" scrollIntoView={bottom} scrollWithAnimation>
        {turns.length === 0 ? (
          <View className="ask-intro">
            <Text className="ask-intro-t">问问这个片区</Text>
            <Text className="ask-intro-n">回答里的每个数字都来自这次体检的分析结果，并标出处。</Text>
            <View className="ask-sugs">
              {suggestions.map((sg) => (
                <View
                  key={sg.question}
                  className="ask-sug"
                  onClick={() => send(sg.question)}
                  hoverClass="row-pressed"
                >
                  <Text>{sg.short}</Text>
                </View>
              ))}
              <View
                className="ask-sug"
                onClick={() => send('15 分钟能走到的餐馆有哪些？')}
                hoverClass="row-pressed"
              >
                <Text>15 分钟能走到哪些餐馆？</Text>
              </View>
            </View>
          </View>
        ) : null}
        {turns.map((t, i) => (
          <View key={i} id={`turn-${i}`} className="turn">
            <View className="q">
              <Text>{t.question}</Text>
            </View>
            {t.answer ? (
              <Answer model={model} a={t.answer} onUnit={onUnit} onCite={(id) => onCite(id, t.answer!)} />
            ) : t.error ? (
              <Text className="a-err">{t.error}</Text>
            ) : (
              <View className="steps">
                {(t.steps.length
                  ? t.steps
                  : [{ kind: 'note', text: '正在读取这次体检的分析结果…' } as AskStep]
                ).map((st, k) => (
                  <View key={k} className={'step' + (st.kind === 'tool' && st.done ? ' done' : '')}>
                    <View className="step-dot" />
                    <Text>
                      {st.kind === 'tool' ? `${st.done ? '已查' : '正在查'}：${st.title}` : st.text}
                    </Text>
                  </View>
                ))}
              </View>
            )}
            <View id={`turn-${i}-end`} />
          </View>
        ))}
        <View className="ask-pad" />
      </ScrollView>
      <View className="ask-bar">
        <Input
          className="ask-input"
          value={q}
          placeholder={busy ? '正在回答…' : '比如：老人买菜方便吗？'}
          placeholderClass="ask-ph"
          confirmType="send"
          maxlength={QUESTION_MAX}
          disabled={busy}
          onInput={(e) => setQ(e.detail.value)}
          onConfirm={() => send(q)}
        />
        <View className={'ask-send' + (q.trim() && !busy ? '' : ' off')} onClick={() => send(q)}>
          <Icon id="ui-send" color="#FFFFFF" size={18} />
        </View>
      </View>
      {cite ? (
        <View className="cite-root" catchMove>
          <View className="cite-dim" onClick={() => setCite(null)} />
          <View className="cite">
            <Text className="cite-id num">{cite.id}</Text>
            <Text className="cite-title">{cite.title}</Text>
            <ScrollView scrollY className="cite-body">
              <Text className="cite-sum">{cite.summary}</Text>
            </ScrollView>
            {cite.anchors.some((a) => a.type === 'community') ? (
              <View
                className="cite-go"
                onClick={() => {
                  const a = cite.anchors.find((x) => x.type === 'community');
                  const code =
                    a && a.type === 'community'
                      ? (a.code ?? model.units.find((u) => u.name === a.name)?.code)
                      : null;
                  setCite(null);
                  if (code) onUnit(code);
                }}
                hoverClass="act-press"
              >
                <Text>在地图上看</Text>
              </View>
            ) : null}
          </View>
        </View>
      ) : null}
    </View>
  );
}
