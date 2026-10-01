/**
 * The HTML atoms of a streaming check: the new 你在这里 (the centre being checked) and, once the
 * facility search is back, the schools, markets and metro stations it found. No codes, tags or cards:
 * the verdict waits for the result.
 */
import { Pg } from '../components/Icons.js';
import type { View } from '../geo/view.js';
import { CAT_ICON, catColor } from '../model/derive.js';
import type { StreamModel } from '../data/stream.js';

/** The scarce kinds marked while a check streams in (pharmacies are too many to read). */
const STREAM_MARKS: ReadonlySet<string> = new Set(['幼儿园', '小学', '菜市场', '社区卫生', '地铁']);

export function StreamLayer({ view, model, label }: { view: View; model: StreamModel; label: string }) {
  const W = view.width;
  const H = view.height;
  const marks = model.pois.flatMap((p) => {
    const icon = CAT_ICON[p.cat];
    if (!icon || p.stall_of || !STREAM_MARKS.has(p.cat) || /出入口/.test(p.name)) return [];
    const [px, py] = p.navi_xy ?? p.xy;
    const x = view.x(px);
    const y = view.y(py);
    if (x < 14 || y < 72 || x > W - 14 || y > H - 110) return [];
    return [{ key: p.uid, x, y, icon, name: p.name, color: catColor(p.cat) }];
  });
  const hx = view.x(0);
  const hy = view.y(0);
  return (
    <div className="layer overlay">
      {marks.map((t) => (
        <div
          key={t.key}
          className="poi passive"
          style={{ left: t.x, top: t.y, ['--c' as string]: t.color }}
          role="img"
          aria-label={t.name}
        >
          <Pg id={t.icon} />
        </div>
      ))}
      <div className="here passive tag-above" style={{ left: hx, top: hy }}>
        <span className="tag">{label.length > 16 ? `${label.slice(0, 15)}…` : label}</span>
        <span className="dot">
          <Pg id="pg-walk" />
        </span>
      </div>
    </div>
  );
}
