/** results.md: the tables of the test report (真实对比测试报告), generated from results.json. */
import type { MethodResult, Results } from './score.js';

const fx = (v: number | null | undefined, digits: number) =>
  v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toFixed(digits);
const pct = (v: number | null | undefined) =>
  v === null || v === undefined || !Number.isFinite(v) ? '—' : `${(v * 100).toFixed(1)}%`;
const int = (v: number) => Math.round(v).toLocaleString('en-US');

function table(head: string[], rows: string[][]): string {
  const line = (cells: string[]) => `| ${cells.join(' | ')} |`;
  return [line(head), line(head.map(() => '---')), ...rows.map(line)].join('\n');
}

function summary(r: Results): string[] {
  const by = new Map(r.methods.map((m) => [m.id, m]));
  const out: string[] = [];
  const circle = by.get('circle');
  const star = by.get('star16');
  const seed = by.get('seed48');
  const curve = r.methods
    .filter((m) => /^engine@\d+$/.test(m.id))
    .sort((a, b) => a.cost.routes - b.cost.routes);
  if (circle) {
    out.push(
      `直线圆（不调用接口）：面积是参考 15 分钟区域的 ${fx(circle.region.area_ratio, 2)} 倍，IoU ${fx(circle.region.iou, 3)}；` +
        `它判为 15 分钟可达的参考点中有 ${pct(circle.points.false_inside_rate)} 实际走不到。`,
    );
  }
  if (star) {
    out.push(
      `16 方位射线法（${int(star.cost.routes)} 条路线）：IoU ${fx(star.region.iou, 3)}，面积比 ${fx(star.region.area_ratio, 2)}；` +
        `判为可达的点中 ${pct(star.points.false_inside_rate)} 实际走不到，真正可达的点中 ${pct(star.points.false_outside_rate)} 被漏掉。`,
    );
  }
  if (star && seed) {
    out.push(
      `同样这 48 条路线，换成本方法的去趋势插值（仅 48 点）：IoU ${fx(seed.region.iou, 3)}（射线法 ${fx(star.region.iou, 3)}），` +
        `逐点分类准确率 ${pct(seed.points.accuracy)}（射线法 ${pct(star.points.accuracy)}）。`,
    );
  }
  if (curve.length) {
    out.push(
      `本方法（用满预算）：批量算路 ${curve.map((m) => int(m.cost.routes)).join(' / ')} 条时，IoU 为 ${curve
        .map((m) => fx(m.region.iou, 3))
        .join(' / ')}，耗时平均绝对误差为 ${curve.map((m) => fx(m.points.time?.mae_s, 0)).join(' / ')} 秒。`,
    );
  }
  const def = by.get('engine-default');
  if (def?.engine) {
    out.push(
      `默认配置（个人档，收敛即停）：实际用了 ${int(def.cost.routes)} 条批量算路（加密 ${def.engine.refine_rounds} 轮${def.engine.refine_converged ? '后收敛' : '，未收敛'}），IoU ${fx(def.region.iou, 3)}。`,
    );
  }
  for (const nb of r.methods.filter((m) => /-nobarrier$/.test(m.id))) {
    const withB = by.get(nb.id.replace(/-nobarrier$/, ''));
    if (withB) {
      out.push(
        `断裂检测的作用（${int(nb.cost.routes)} 条）：关闭后 IoU ${fx(nb.region.iou, 3)}、MAE ${fx(nb.points.time?.mae_s, 0)} 秒；开启时 ${fx(withB.region.iou, 3)}、${fx(withB.points.time?.mae_s, 0)} 秒。`,
      );
    }
  }
  return out;
}

const walksOf = (m: MethodResult) => (m.cost.walks ? String(m.cost.walks) : '0');

export function markdownReport(r: Results): string {
  const ref = r.reference;
  const [lng, lat] = r.area.center_bd09;
  const L: string[] = [];
  L.push(`# 精度–配额评测：${r.area.name}（${r.area.id}）`, '');
  L.push(
    `> 由 \`@zoudedao/eval\` 的 \`score\` 根据本目录下的产物文件生成（${r.generated}），不调用任何接口。` +
      `参考真值：以 ${r.area.label}（BD-09 ${lng}, ${lat}）为中心，${ref.spacing_m} 米格点 × ${int(ref.radius_m)} 米圆内共 ${int(ref.counts.points)} 点的百度批量算路实测，` +
      `耗时 = 路线距离 ÷ ${r.settings.speed_mps} 米/秒（百度批量算路的步速）。指标定义见文末。`,
    '',
  );

  L.push('## 结论速览', '');
  for (const s of summary(r)) L.push(`- ${s}`);
  L.push('');

  L.push('## 15 分钟区域：与参考区域比较', '');
  L.push(
    `区域在 ${r.settings.grid.cell} 米网格（±${-r.settings.grid.x0} 米）的节点上比较；参考区域是参考场中耗时 < 900 秒的节点，面积 ${fx(ref.area_km2, 3)} 平方公里。`,
    '',
  );
  L.push(
    table(
      [
        '方法',
        '批量算路（条）',
        '步行路线（次）',
        '面积（km²）',
        '面积比',
        'IoU',
        '对称差（km²）',
        '多算（km²）',
        '漏算（km²）',
      ],
      r.methods.map((m) => [
        m.label,
        int(m.cost.routes),
        walksOf(m),
        fx(m.region.area_km2, 3),
        fx(m.region.area_ratio, 2),
        fx(m.region.iou, 3),
        fx(m.region.sym_diff_km2, 3),
        fx(m.region.false_inside_km2, 3),
        fx(m.region.false_outside_km2, 3),
      ]),
    ),
    '',
  );

  L.push('## 参考点逐点检验', '');
  L.push(
    `直接用实测的参考点检验，不经过参考场的插值：只取直线距离 ≤ ${int(r.settings.domain_m)} 米（超出这个距离 15 分钟一定走不到）且有实测结果的参考点，` +
      `去掉方法自己测过的点（${r.settings.used_radius_m} 米以内）。共 ${int(ref.domain_points)} 点，其中 15 分钟可达 ${int(ref.reachable_points)} 点。`,
    '',
  );
  L.push(
    table(
      [
        '方法',
        '检验点数',
        '分类准确率',
        `边界带准确率（±${r.settings.band_s} 秒）`,
        '误判为可达',
        '误判为不可达',
        'MAE（秒）',
        'P90（秒）',
        '平均偏差（秒）',
      ],
      r.methods.map((m) => {
        const p = m.points;
        return [
          m.label,
          `${int(p.n)}${p.n_used ? `（去掉 ${p.n_used}）` : ''}`,
          pct(p.accuracy),
          `${pct(p.band.accuracy)}（${int(p.band.n)} 点）`,
          pct(p.false_inside_rate),
          pct(p.false_outside_rate),
          fx(p.time?.mae_s, 1),
          fx(p.time?.p90_s, 1),
          fx(p.time?.bias_s, 1),
        ];
      }),
    ),
    '',
  );

  L.push('## 调用成本', '');
  L.push(
    table(
      [
        '方法',
        '批量算路（条，含缓存）',
        '生成时计费（条）',
        'HTTP 请求',
        '步行路线（次）',
        '生成时计费（次）',
        '用时（秒）',
        '引擎',
      ],
      r.methods.map((m) => [
        m.label,
        int(m.cost.routes),
        int(m.cost.routes_billed),
        int(m.cost.requests),
        walksOf(m),
        int(m.cost.walks_billed),
        fx(m.cost.wall_ms / 1000, 1),
        m.engine
          ? `加密 ${m.engine.refine_rounds} 轮${m.engine.refine_converged ? '（收敛）' : ''}，样本 ${int(m.engine.n_samples)}，断裂段 ${int(m.engine.barrier_segments)}`
          : '—',
      ]),
    ),
    '',
  );
  L.push(
    '“批量算路（条，含缓存）”是方法本身的代价（命中缓存也计数）；“生成时计费”是生成这份产物的那次运行实际被百度计费的条数，其余由缓存提供（同一批点已被前面的步骤测过）。用时包含等待限流与缓存命中，只作参考。',
    '',
  );

  L.push('## 参考真值', '');
  const c = ref.counts;
  L.push(
    `- 格点：${ref.spacing_m} 米间距，${int(ref.radius_m)} 米圆内（不含中心）共 ${int(c.points)} 点：有路线 ${int(c.ok)}，无路线 ${int(c.no_route)}，失败 ${int(c.failed)}，未测 ${int(c.pending)}。`,
    `- 调用：${ref.sessions} 次运行，批量算路 ${int(ref.totals.calls)} 次（HTTP 请求 ${int(ref.totals.requests)} 次），计费 ${int(ref.totals.routes_billed)} 条；首次 ${ref.created}，最近 ${ref.updated}。`,
    `- 参考 15 分钟区域：网格面积 ${fx(ref.area_km2, 3)} 平方公里，平滑等值线面积 ${fx(ref.contour_area_km2, 3)} 平方公里；直线圆 ${fx(ref.circle_area_km2, 3)} 平方公里。`,
    ref.loo
      ? `- 参考场自身的留一法误差：MAE ${fx(ref.loo.mae_s, 1)} 秒，P90 ${fx(ref.loo.p90_s, 1)} 秒（${int(ref.loo.n)} 点）。区域指标会受它影响，逐点检验不受。`
      : '- 参考场没有留一法结果。',
    `- 由参考点耗时矛盾检出的断裂段：${int(ref.barrier_segments)} 段（参考场插值时用于可见性过滤）。`,
    '',
  );

  L.push('## 图', '');
  L.push('![精度–配额曲线](accuracy-quota.svg)', '', '![15 分钟可达范围叠加图](overlay.svg)', '');

  L.push('## 方法说明', '');
  for (const m of r.methods) L.push(`- **${m.label}**（\`${m.id}\`）：${m.description}`);
  L.push('');

  L.push('## 指标定义', '');
  L.push(
    '- **IoU**：方法的 15 分钟区域与参考区域的交集面积 ÷ 并集面积，1 为完全一致。',
    '- **面积比**：方法区域面积 ÷ 参考区域面积；大于 1 表示把走不到的地方算成了可达。',
    '- **对称差 / 多算 / 漏算**：两区域不重合部分的面积；多算 = 方法有而参考没有，漏算 = 参考有而方法没有。',
    '- **分类准确率**：参考点上“15 分钟能否走到”（参考耗时 < 900 秒）判对的比例；百度无路线的点按走不到计。',
    '- **误判为可达**：方法判为可达的点中实际走不到的比例（FP ÷ (TP + FP)）。**误判为不可达**：实际可达的点中方法判为走不到的比例（FN ÷ (TP + FN)）。',
    `- **边界带准确率**：只看参考耗时在 900 ± ${r.settings.band_s} 秒之间的点，判断最难的地方。`,
    '- **MAE / P90 / 平均偏差**：方法耗时场在参考点上的误差 |t̂ − t| 的平均值、90 分位数，以及 t̂ − t 的平均值（负数表示方法偏乐观）；只对给出耗时场的方法计算。直线圆的耗时按直线距离 ÷ 1.17 米/秒。',
    '- 引擎的耗时场用双线性插值在参考点取值；区域比较用网格节点。',
    '',
  );
  return L.join('\n');
}
