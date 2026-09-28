/*
 * 🔴 **判定性实验 2**：逐组合权益（对 Hero 真实底牌）到底有没有区分能力？
 *
 * ## 为什么先做这个
 *
 * 实验 1 证明现有代理的判弃率与事实**零相关**（r = −0.119）⇒ 同类信息加多少都没用。
 * 第 1 条主张：「换成**对 Hero 的权益**就能有区分能力」。
 * **这是它成立的前提，必须单独验证** —— 若权益也零相关，第 1 条同样是死的。
 *
 * ## 判据（写死）
 *
 * 对每个「引擎建议 BET/RAISE」的决策点，算**对手那一手对 Hero 真实底牌的权益**
 * （用引擎自己的权益引擎，不是我自己推的公式），然后看：
 *
 * | 指标 | 含义 |
 * |---|---|
 * | `r(权益, 实际是否弃牌)` | 权益能不能区分「他会弃」与「他会继续」 |
 * | 分组均值 | 实际弃牌组的权益 vs 实际继续组的权益，差多少 |
 *
 * 对照基准：现有 `foldLikelihood` 的 `r = −0.119`、分层均值差约 5pp。
 *
 * ⚠️ 只读，不改任何生产文件。
 * ⚠️ 这里用 Hero **真实底牌**是正确的：Hero 知道自己的牌（不存在信息泄露）；
 *    这与「模拟对手想法」是两件事（见报告 §6.6）。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { computeEquity } from '../src/domain/poker/equity.ts';
import { parseCardCode } from '../src/app/manualInput/manualInput.ts';
import { loadKnowledgeBase } from '../src/domain/knowledge/knowledgeLoader.ts';
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { parsePhh } from '../src/domain/realHands/phh.ts';
import { toValidatorSnapshotsDetailed } from '../src/domain/realHands/phhToEngineInput.ts';
import type { Card } from '../src/domain/types.ts';

const knowledge = loadKnowledgeBase();
if (!knowledge.ok) throw new Error('知识库加载失败');
const rules = knowledge.index.allRules();

const ROOT = join(process.cwd(), 'third_party', 'phh-dataset');

type Row = {
  /** 对手那一手对 Hero 的权益（0..1） */
  villainEquity: number;
  /** 引擎报的判弃率（对照） */
  foldLikelihood: number;
  /** 他面对的价格（需要多少权益才值得跟） */
  price: number;
  /** 权益 − 价格：正 = 按数学该跟，负 = 按数学该弃 */
  edge: number;
  folded: boolean;
  street: string;
};

const rows: Row[] = [];
let noCards = 0;
let eqFailed = 0;

const toCards = (s: string): Card[] | null => {
  const a = parseCardCode(s.slice(0, 2));
  const b = parseCardCode(s.slice(2, 4));
  return a === null || b === null ? null : [a as Card, b as Card];
};

for (const d of readdirSync(ROOT)) {
  const dir = join(ROOT, d);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    continue;
  }
  for (const f of entries.filter((x) => x.endsWith('.phh'))) {
    const parsed = parsePhh(readFileSync(join(dir, f), 'utf8'));
    if (!parsed.ok) continue;
    const snaps = toValidatorSnapshotsDetailed(parsed.hand).snapshots;
    for (let i = 0; i < snaps.length; i += 1) {
      const snap = snaps[i]!;
      const r = analyzeManualHand(snap.input, { rules, writeLog: false, equitySeed: 1 });
      if (!r.ok) continue;
      if (r.decision.action !== 'BET' && r.decision.action !== 'RAISE') continue;
      const later = snaps.slice(i + 1).find((x) => x.heroName !== snap.heroName);
      if (later === undefined) continue;

      const oppStr = Object.values(snap.opponentCards)[0];
      if (oppStr === undefined) {
        noCards += 1;
        continue;
      }
      const opp = toCards(oppStr);
      if (opp === null) {
        noCards += 1;
        continue;
      }
      const hero = toCards(snap.input.heroCards.join(''));
      const board = snap.input.board.map((c) => parseCardCode(c)).filter((c): c is Card => c !== null);
      if (hero === null || board.length < 3) {
        noCards += 1;
        continue;
      }

      /* 引擎自己的权益引擎：Hero vs 对手【那一手牌】（范围只有一个组合） */
      const out = computeEquity(hero, board, [
        { combos: [[opp[0], opp[1]]], weights: [1] },
      ] as never, { mode: 'EXACT' } as never);
      if (!out.ok) {
        eqFailed += 1;
        continue;
      }
      /*
       * ⚠️ 返回结构是 `{ ok: true, result: { equity, ... } }` ——
       * 第一版我读的是 `out.equity`（不存在）⇒ 全程 `undefined` ⇒ 所有统计变成 NaN。
       * 这类错误最危险的地方是：**它不报错**，只让结论变成 NaN 或 0。
       */
      const heroEq = out.result.equity;
      const villainEquity = 1 - heroEq;

      /* 价格：他面对我的注需要多少权益 */
      const sizeChips = r.decision.sizeChips ?? 0;
      const pot = r.computedPot;
      const price = pot + 2 * sizeChips > 0 ? sizeChips / (pot + 2 * sizeChips) : 0;

      /* 引擎报的判弃率（取被选尺寸） */
      type SizeLike = { betAmount?: number; foldLikelihood?: number };
      const diag = r.decision.diagnostics as unknown as { betDecision?: { sizes?: readonly SizeLike[] } };
      const sizes = diag.betDecision?.sizes ?? [];
      const hit =
        sizes.find((s) => s.betAmount === sizeChips) ??
        sizes.reduce((a, b) => (Math.abs((b.betAmount ?? 0) - sizeChips) < Math.abs((a.betAmount ?? 0) - sizeChips) ? b : a), sizes[0]);

      rows.push({
        villainEquity,
        foldLikelihood: hit?.foldLikelihood ?? 0,
        price,
        edge: villainEquity - price,
        folded: later.realAction === 'FOLD',
        street: snap.street,
      });
    }
  }
}

const mean = (xs: number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);
const corr = (xs: number[], ys: number[]): number => {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return 0;
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i += 1) {
    num += (xs[i]! - mx) * (ys[i]! - my);
    dx += (xs[i]! - mx) ** 2;
    dy += (ys[i]! - my) ** 2;
  }
  return dx === 0 || dy === 0 ? 0 : num / Math.sqrt(dx * dy);
};

console.log(`样本 ${rows.length}（无底牌 ${noCards}，权益失败 ${eqFailed}）`);
console.log('');
console.log('='.repeat(76));
console.log('判据 A：相关性（越高越有区分能力）');
console.log('='.repeat(76));
const foldedF = rows.map((r) => (r.folded ? 1 : 0));
console.log(`  r(对手权益, 实际弃牌)      = ${corr(rows.map((r) => r.villainEquity), foldedF).toFixed(3)}   ← 第 1 条的判据`);
console.log(`  r(权益 − 价格, 实际弃牌)   = ${corr(rows.map((r) => r.edge), foldedF).toFixed(3)}   ← 更贴"该不该弃"`);
console.log(`  r(现有判弃率, 实际弃牌)    = ${corr(rows.map((r) => r.foldLikelihood), foldedF).toFixed(3)}   ← 对照（实验 1：−0.119）`);
console.log('');
console.log('='.repeat(76));
console.log('判据 B：分组均值（实际弃牌 vs 实际继续）差多少');
console.log('='.repeat(76));
const foldG = rows.filter((r) => r.folded);
const contG = rows.filter((r) => !r.folded);
for (const [name, pick] of [
  ['对手权益', (r: Row) => r.villainEquity],
  ['权益 − 价格', (r: Row) => r.edge],
  ['现有判弃率', (r: Row) => r.foldLikelihood],
] as const) {
  const a = mean(foldG.map(pick));
  const b = mean(contG.map(pick));
  console.log(
    `  ${name.padEnd(14)} 弃牌组 ${(a * 100).toFixed(1).padStart(6)}%  vs  继续组 ${(b * 100).toFixed(1).padStart(6)}%  ` +
      `⇒ 差 ${((b - a) * 100).toFixed(1).padStart(6)}pp`,
  );
}
console.log('');
console.log('='.repeat(76));
console.log('判据 C：按「权益 − 价格」分桶，看实际弃牌率是否单调');
console.log('='.repeat(76));
for (const [lo, hi] of [[-1, -0.15], [-0.15, -0.05], [-0.05, 0.05], [0.05, 0.15], [0.15, 1]] as const) {
  const g = rows.filter((r) => r.edge >= lo && r.edge < hi);
  if (g.length === 0) continue;
  const fr = g.filter((r) => r.folded).length / g.length;
  console.log(`  edge ∈ [${lo.toFixed(2)}, ${hi.toFixed(2)})  n=${String(g.length).padStart(4)}  实际弃牌率 ${(fr * 100).toFixed(1)}%`);
}
console.log('');
console.log('判据（写死）：');
console.log('  · r(对手权益, 弃牌) 明显为负（权益越低越会弃）⇒ 第 1 条成立；');
console.log('  · 「权益−价格」分桶后实际弃牌率**单调下降** ⇒ 第 1 条不仅成立，而且能给出方向正确的判据；');
console.log('  · 若全部接近 0 ⇒ 连权益也无区分能力 ⇒ 第 1 条也是死的，必须重新想。');
