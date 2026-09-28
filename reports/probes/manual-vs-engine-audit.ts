/**
 * 《德州牌桌手册 V1.4》↔ 决策引擎 一致性审计
 *
 * ## 用途
 *
 * 手册第 1-4 页给了**八人桌九人局**每个位置的开池范围（蓝=加注 / 灰=弃牌，
 * 共 169 个手牌类别）。本脚本把手册的加注集合与引擎的开池先验
 * （`preflopPriors.rfiWeights` → 169 类权重表，`weight > 0` 即"在范围里"）
 * 逐格对比，列出**双向**不一致。
 *
 * ## 为什么手册范围不带"颜色"就得不出结论
 *
 * 手册是**颜色编码**的网格，纯文本抽取会丢掉蓝/灰。因此上游用 PyMuPDF 读
 * 每个格子**包含文字中心的填充矩形**，按填充色判定：
 * 蓝 `rgb(32,94,165)` = raise，灰 `rgb(237,241,245)` = fold。
 * 输入的 JSON 由 `split_ranges.py` 生成（每页两个网格按 x 间隙拆分）。
 *
 * ## 用法
 *
 * ```powershell
 * node --experimental-strip-types reports/probes/manual-vs-engine-audit.ts <manual_by_position.json>
 * ```
 *
 * 只读：不写任何数据文件。
 */

import { readFileSync } from 'node:fs';
import { Position, TableSize } from '../../src/domain/types.ts';
import { allRankClassKeys, rfiWeights } from '../../src/app/manualInput/preflopPriors.ts';

const jsonPath = process.argv[2];
if (jsonPath === undefined) {
  console.error('用法：node --experimental-strip-types reports/probes/manual-vs-engine-audit.ts <JSON>');
  process.exit(2);
}
const manual = JSON.parse(readFileSync(jsonPath, 'utf8')) as Record<string, string[]>;

/** 手册里的位置名 → 引擎位置枚举 */
const POS_MAP: readonly [string, Position][] = [
  ['UTG', Position.UTG],
  ['UTG1', Position.UTG1],
  ['UTG2', Position.UTG2],
  ['LJ', Position.LJ],
  ['HJ', Position.HJ],
  ['CO', Position.CO],
  ['BTN', Position.BTN],
  ['SB', Position.SB],
];

const ALL = allRankClassKeys();
const pct = (n: number): string => `${((n / ALL.length) * 100).toFixed(1)}%`;

console.log('位置    手册加注   引擎范围   一致率   手册有/引擎无   引擎有/手册无');
console.log('─'.repeat(78));

const engineSets = new Map<Position, Set<string>>();
let totalManual = 0;
let totalEngine = 0;
let totalBoth = 0;
const details: string[] = [];

for (const [label, pos] of POS_MAP) {
  const manualSet = new Set(manual[label] ?? []);
  const weights = rfiWeights(TableSize.NINE_MAX, pos) as unknown as Record<string, number>;
  const engineSet = new Set(ALL.filter((k) => (weights[k] ?? 0) > 0));
  engineSets.set(pos, engineSet);

  const onlyManual = [...manualSet].filter((h) => !engineSet.has(h));
  const onlyEngine = [...engineSet].filter((h) => !manualSet.has(h));
  const both = [...manualSet].filter((h) => engineSet.has(h));
  const union = new Set([...manualSet, ...engineSet]);
  const agree = union.size === 0 ? 1 : both.length / union.size;

  totalManual += manualSet.size;
  totalEngine += engineSet.size;
  totalBoth += both.length;

  console.log(
    `${label.padEnd(6)}  ${String(manualSet.size).padStart(3)}(${pct(manualSet.size).padStart(5)})  ` +
      `${String(engineSet.size).padStart(3)}(${pct(engineSet.size).padStart(5)})  ` +
      `${(agree * 100).toFixed(1).padStart(6)}%  ` +
      `${String(onlyManual.length).padStart(6)}          ${String(onlyEngine.length).padStart(6)}`,
  );
  if (onlyManual.length > 0) details.push(`  ${label} 手册加注但引擎不在范围：${onlyManual.join(' ')}`);
  if (onlyEngine.length > 0) details.push(`  ${label} 引擎在范围但手册弃牌：${onlyEngine.join(' ')}`);
}

console.log('─'.repeat(78));
console.log(
  `合计：手册 ${totalManual} 格 / 引擎 ${totalEngine} 格 / 交集 ${totalBoth} 格` +
    ` ⇒ Jaccard ${((totalBoth / (totalManual + totalEngine - totalBoth)) * 100).toFixed(1)}%`,
);

console.log('\n===== 引擎档位是否把相邻位置合并 =====');
const tierGroups: [string, Position[]][] = [
  ['UTG/UTG1/UTG2', [Position.UTG, Position.UTG1, Position.UTG2]],
  ['LJ', [Position.LJ]],
  ['HJ', [Position.HJ]],
  ['CO', [Position.CO]],
  ['BTN', [Position.BTN]],
  ['SB', [Position.SB]],
];
for (const [name, group] of tierGroups) {
  const sigs = group.map((p) => [...(engineSets.get(p) ?? [])].sort().join(','));
  const same = new Set(sigs).size === 1;
  console.log(
    `  ${name.padEnd(16)} 引擎范围相同=${same ? '是' : '否'}` +
      `  手册格数=${group.map((p) => (manual[Object.keys(manual).find((k) => POS_MAP.find(([l, e]) => l === k && e === p)) ?? ''] ?? []).length).join('/')}`,
  );
}

console.log('\n===== 逐格差异明细 =====');
details.forEach((d) => console.log(d));

console.log('\n===== 单调性检查（手册 vs 引擎，按位置从早到晚）=====');
const order: Position[] = [Position.UTG, Position.UTG1, Position.UTG2, Position.LJ, Position.HJ, Position.CO, Position.BTN];
const mLabels = ['UTG', 'UTG1', 'UTG2', 'LJ', 'HJ', 'CO', 'BTN'];
const mSeq = mLabels.map((l) => (manual[l] ?? []).length);
const eSeq = order.map((p) => (engineSets.get(p) ?? new Set()).size);
const mono = (a: number[]): boolean => a.every((v, i) => i === 0 || v >= a[i - 1]!);
console.log(`  手册：${mSeq.join(' ≤ ')}  ${mono(mSeq) ? '✔ 单调' : '★ 非单调'}`);
console.log(`  引擎：${eSeq.join(' ≤ ')}  ${mono(eSeq) ? '✔ 单调' : '★ 非单调'}`);

/*
 * ============================================================
 * 🔴 **嵌套性检查：靠后位置的开池范围必须 ⊇ 靠前位置的**
 * ============================================================
 *
 * 这一条**不需要手册**就能判定，而且引擎自己的注释就声明了它是设计意图：
 *
 * > `rfiTierOf`：这个映射是**结构性**的（人越多、越靠前越紧），不是逐位手调。
 *
 * 「越靠前越紧」的严格含义是**集合包含**：如果 UTG 用某手牌开池，那么位置更靠后、
 * 身后人更少的 LJ 不可能反而弃掉它（同样的牌、同样的深度、同样的对手）。
 * 仅靠"格数单调不减"**不足以**证明这一点 —— 格数变大完全可能是
 * 「加了几手、同时删了几手」。所以必须逐手牌比集合。
 */
console.log('\n===== 嵌套性：engine(靠前) ⊆ engine(靠后) ？ =====');
let nestingViolations = 0;
for (let i = 1; i < order.length; i++) {
  const prev = engineSets.get(order[i - 1]!)!;
  const cur = engineSets.get(order[i]!)!;
  /* UTG/UTG1/UTG2 同档 ⇒ 必须完全相同；其余必须包含 */
  const missing = [...prev].filter((h) => !cur.has(h));
  const sameTier = i <= 2;
  if (sameTier) {
    const extra = [...cur].filter((h) => !prev.has(h));
    const ok = missing.length === 0 && extra.length === 0;
    if (!ok) nestingViolations++;
    console.log(
      `  ${mLabels[i - 1]} → ${mLabels[i]}（同档，应完全相同）：` +
        `${ok ? '✔' : `★ 差异 ${missing.length + extra.length} 手`}`,
    );
  } else {
    if (missing.length > 0) nestingViolations++;
    console.log(
      `  ${mLabels[i - 1]} → ${mLabels[i]}：${mLabels[i - 1]} 有而 ${mLabels[i]} **没有** ` +
        `${missing.length} 手${missing.length === 0 ? ' ✔' : ` ★ ${missing.join(' ')}`}`,
    );
  }
}
console.log(
  `  ⇒ 嵌套性${nestingViolations === 0 ? '全部成立 ✔' : `**被违反 ${nestingViolations} 处** ★`}`,
);

/* 引擎与手册在"哪边更松"上的一致性：逐手牌统计双向差异的**方向** */
console.log('\n===== 松紧方向（引擎相对手册）=====');
let engineWider = 0;
let engineTighter = 0;
for (const [label] of POS_MAP) {
  const manualSet = new Set(manual[label] ?? []);
  const engineSet = engineSets.get(POS_MAP.find(([l]) => l === label)![1])!;
  engineWider += [...engineSet].filter((h) => !manualSet.has(h)).length;
  engineTighter += [...manualSet].filter((h) => !engineSet.has(h)).length;
}
console.log(`  引擎比手册松的格数（引擎有/手册无）：${engineWider}`);
console.log(`  引擎比手册紧的格数（手册有/引擎无）：${engineTighter}`);
