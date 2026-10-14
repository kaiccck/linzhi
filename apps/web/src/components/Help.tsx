/**
 * The top bar's “?”: a short panel on how to read the screen — the four verdicts, the two rule sets,
 * where the data comes from and when it was measured, and how to choose a centre. The dates and
 * lists are read from the analysis on screen (its attribution), never typed in.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { TASK_CATEGORIES } from '@zoudedao/core';
import { readApprovalNumber } from '../map/BaiduBasemap.js';
import { distWords, type Model } from '../model/derive.js';
import { Ui } from './Icons.js';
import { NumText } from './NumText.js';

/** The official lists an analysis cites, with their dates: 《…》（2025-04-07）. */
export function officialLists(attribution: readonly string[]): string[] {
  const out: string[] = [];
  for (const line of attribution) {
    for (const m of line.matchAll(/《([^》]+)》（(\d{4}-\d{2}-\d{2})）/g)) {
      const item = `《${m[1]}》（${m[2]}）`;
      if (!out.includes(item)) out.push(item);
    }
  }
  return out;
}

export function helpFacts(model: Model) {
  const attribution = model.data.meta.attribution ?? [];
  const osm = attribution.map((a) => /Overpass snapshot (\d{4}-\d{2}-\d{2})/.exec(a)?.[1]).find(Boolean);
  return {
    measuredOn: model.measuredOn,
    lists: officialLists(attribution),
    outlines: model.units.some((u) => u.outlined),
    osm: osm ?? null,
    task: `步行 ${distWords(model.ruleM)}内应有${model.cats.join('、')}`,
    // which of them the task itself names, and which are checked beside them on the same walk
    asked: model.cats.filter((c) => TASK_CATEGORIES.includes(c)),
    added: model.cats.filter((c) => !TASK_CATEGORIES.includes(c)),
  };
}

function Panel({ model, live, onClose }: { model: Model; live: boolean; onClose(): void }) {
  const id = useId();
  const f = helpFacts(model);
  // the map carries no provenance line: its approval number is said here, read from Baidu's own control
  const [approval] = useState(() => readApprovalNumber());
  const head = useRef<HTMLHeadingElement>(null);
  useEffect(() => head.current?.focus({ preventScroll: true }), []);
  return (
    <div
      className="help-pop"
      role="dialog"
      aria-labelledby={`${id}-t`}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return;
        e.stopPropagation();
        onClose();
      }}
    >
      <div className="help-head">
        <h2 id={`${id}-t`} ref={head} tabIndex={-1}>
          怎么读这张图
        </h2>
        <button type="button" className="x" aria-label="关闭说明（Esc）" onClick={onClose}>
          <Ui id="ui-close" />
        </button>
      </div>
      <section>
        <h3>怎么用</h3>
        <ul>
          <li>点小区代号或列表里的一行，画出它的步行路线；Esc 关闭。</li>
          <li>「规划」中选点，估算新增设施能补齐哪些小区的缺口。</li>
          <li>
            「新体检」：点地图选中心，或搜索地址、经纬度。
            {live ? '确认后开始，消耗百度配额。' : '样例模式不能体检新地点。'}
          </li>
          <li>「演示」：← → 翻页，Esc 退出。</li>
        </ul>
      </section>
      <section>
        <h3>两种范围</h3>
        <p>
          沙色是片区中心步行 <NumText text="15′" /> 的等时圈，虚线圈是同一中心直线画的 <NumText text="15′" />{' '}
          圈。小区的颜色另算：小学只计算到官方对口学校，其余类别计算到最近一处设施，以{' '}
          <NumText text={distWords(model.ruleM)} />
          为界。点一个小区，会画出它的直线 <NumText text={distWords(model.ruleM)} /> 圈和实际步行路线。
        </p>
      </section>
      <section>
        <h3>四种判定（按所选类别）</h3>
        <dl className="help-keys">
          <dt>
            <i className="sw s-pseudo" />
            伪覆盖
          </dt>
          <dd>直线在规则距离内，实际步行超出：圈里有、走不到。</dd>
          <dt>
            <i className="sw s-blind" />
            盲区
          </dt>
          <dd>直线也超出规则距离，或设施清单里没有这一类。</dd>
          <dt>
            <i className="sw s-edge" />
            临界
          </dt>
          <dd>
            <NumText text="步行距离与规则相差不到 50 m，需要实地核实。" />
          </dd>
          <dt>
            <i className="sw s-pending" />
            待核
          </dt>
          <dd>对口学校、校区或步行路线尚待核实，不计入缺口。小学不会用最近学校替代对口学校。</dd>
        </dl>
      </section>
      <section>
        <h3>判定规则</h3>
        <p>
          {f.task}，按百度实测的步行距离，不按直线。
          {f.added.length
            ? `${f.asked.join('、')}是赛题要求，${f.added.join('、')}按同一距离一并检查。`
            : '（赛题要求）'}
        </p>
      </section>
      <details className="help-sources">
        <summary>数据来源与日期</summary>
        <ul>
          <li>
            步行路线：百度地图批量算路与步行路线，实测 <span className="num">{f.measuredOn}</span>。
          </li>
          <li>
            设施：百度地点检索
            {f.lists.length ? (
              <>
                ，并与官方名录核对：
                <NumText text={f.lists.join('、')} />
              </>
            ) : null}
            。
          </li>
          <li>
            {f.outlines ? (
              <>
                小区轮廓：© OpenStreetMap 贡献者（ODbL
                {f.osm ? (
                  <>
                    ，<span className="num">{f.osm}</span> 快照
                  </>
                ) : null}
                ）。
              </>
            ) : (
              '小区位置：百度地点检索的小区出入口（实时体检没有小区轮廓）。'
            )}
          </li>
          <li>
            底图：© 百度地图
            {approval ? (
              <>
                （审图号 <NumText text={approval} />）
              </>
            ) : null}
            ，路名、地名由百度绘制；地图上的代号、名称与设施标记是本应用自己的。
          </li>
        </ul>
      </details>
    </div>
  );
}

export function HelpButton({ model, live }: { model: Model; live: boolean }) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  const close = () => {
    setOpen(false);
    btn.current?.focus();
  };
  return (
    <div className="help" ref={box}>
      <button
        ref={btn}
        type="button"
        className="tool-btn help-btn"
        aria-label="说明：判定、规则、数据来源与用法"
        aria-haspopup="dialog"
        aria-expanded={open}
        title="说明"
        onClick={() => setOpen((o) => !o)}
      >
        ?
      </button>
      {open ? <Panel model={model} live={live} onClose={close} /> : null}
    </div>
  );
}
