/*
 * 设计依据测量：**逐组合权益的估计噪声有多大**？
 *
 * 重构后的判据是「权益 ≥ 价格 + margin」，而 `margin` 的第一个组成项就是
 * **权益估计的 95% 置信半宽**（`equityPolicy.ts` 的 `confidenceHalfWidth`，已有）。
 *
 * 本探针回答：在固定的 `iterations` 下，这个半宽实际是多少？
 * 若它已经很小（例如 < 2pp），那么 margin 主要由「范围假设误差」决定，而不是采样噪声。
 *
 * 顺带回答：**权益随迭代数的稳定性** —— 用它决定 `PER_COMBO_EQUITY_ITERATIONS`。
 *
 * ⚠️ 只读。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { computeEquity } from '../src/domain/poker/equity.ts';
import { confidenceHalfWidth } from '../src/domain/poker/equityPolicy.ts';
import { parseCardCode } from '../src/app/manualInput/manualInput.ts';
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { loadKnowledgeBase } from '../src/domain/knowledge/knowledgeLoader.ts';
import { parsePhh } from '../src/domain/realHands/phh.ts';
import { toValidatorSnapshotsDetailed } from '../src/domain/realHands/phhToEngineInput.ts';
import type { Card } from '../src/domain/types.ts';

const knowledge = loadKnowledgeBase();
if (!knowledge.ok) throw new Error('知识库加载失败');
const rules = knowledge.index.allRules();

const ROOT = join(process.cwd(), 'third_party', 'phh-dataset');

/** 采样：真实决策点上的（Hero 底牌, 牌面, 对手那一手） */
type Sample = { hero: Card[]; board: Card[]; opp: Card[] };
const samples: Sample[] = [];

const toCards = (s: string): Card[] | null => {
  const a = parseCardCode(s.slice(0, 2));
  const b = parseCardCode(s.slice(2, 4));
  return a === null || b === null ? null : [a as Card, b as Card];
};

let seen = 0;
for (const d of readdirSync(ROOT)) {
  const dir = join(ROOT, d);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    continue;
  }
  for (const f of entries.filter((x) => x.endsWith('.phh'))) {
    if (samples.length >= 400) break;
    const parsed = parsePhh(readFileSync(join(dir, f), 'utf8'));
    if (!parsed.ok) continue;
    for (const snap of toValidatorSnapshotsDetailed(parsed.hand).snapshots) {
      if (samples.length >= 400) break;
      const r = analyzeManualHand(snap.input, { rules, writeLog: false, equitySeed: 1 });
      if (!r.ok) continue;
      if (r.decision.action !== 'BET' && r.decision.action !== 'RAISE') continue;
      const oppStr = Object.values(snap.opponentCards)[0];
      if (oppStr === undefined) continue;
      const opp = toCards(oppStr);
      const hero = toCards(snap.input.heroCards.join(''));
      const board = snap.input.board.map((c) => parseCardCode(c)).filter((c): c is Card => c !== null);
      if (opp === null || hero === null || board.length < 3) continue;
      samples.push({ hero, board, opp });
      seen += 1;
    }
  }
  if (samples.length >= 400) break;
}
void seen;

console.log(`样本 ${samples.length} 个真实决策点`);
console.log('');
console.log('='.repeat(78));
console.log('A. 权益估计的 95% 置信半宽（引擎自己的 confidenceHalfWidth）');
console.log('='.repeat(78));
console.log('迭代数     平均权益    平均半宽    最大半宽    中位单次耗时');

for (const iters of [100, 200, 400, 800, 1600]) {
  const equities: number[] = [];
  const widths: number[] = [];
  const t0 = Date.now();
  for (const s of samples.slice(0, 200)) {
    const out = computeEquity(s.hero, s.board, [{ label: 'X', combos: [[s.opp[0], s.opp[1]]] }], {
      seed: 20260926,
      forceMethod: 'MONTE_CARLO',
      iterations: iters,
      maxIterations: iters,
    });
    if (!out.ok) continue;
    equities.push(out.result.equity);
    widths.push(confidenceHalfWidth(out.result.equity, out.result.total));
  }
  const mean = (xs: number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);
  console.log(
    `${String(iters).padStart(6)}   ${(mean(equities) * 100).toFixed(1).padStart(8)}%   ` +
      `${(mean(widths) * 100).toFixed(2).padStart(7)}pp   ${(Math.max(...widths) * 100).toFixed(2).padStart(7)}pp   ` +
      `${((Date.now() - t0) / Math.max(1, widths.length)).toFixed(2).padStart(9)}ms`,
  );
}

console.log('');
console.log('='.repeat(78));
console.log('B. 同一组合在**不同迭代数**下的权益差（稳定性）');
console.log('='.repeat(78));
console.log('对比                平均差异    最大差异');
const gold: number[] = [];
for (const s of samples.slice(0, 200)) {
  const out = computeEquity(s.hero, s.board, [{ label: 'X', combos: [[s.opp[0], s.opp[1]]] }], {
    seed: 20260926,
    forceMethod: 'EXACT',
  });
  gold.push(out.ok ? out.result.equity : Number.NaN);
}
for (const iters of [100, 200, 400, 800]) {
  let sum = 0;
  let max = 0;
  let n = 0;
  for (let i = 0; i < Math.min(200, samples.length); i += 1) {
    const s = samples[i]!;
    if (!Number.isFinite(gold[i]!)) continue;
    const out = computeEquity(s.hero, s.board, [{ label: 'X', combos: [[s.opp[0], s.opp[1]]] }], {
      seed: 20260926,
      forceMethod: 'MONTE_CARLO',
      iterations: iters,
      maxIterations: iters,
    });
    if (!out.ok) continue;
    const diff = Math.abs(out.result.equity - gold[i]!);
    sum += diff;
    max = Math.max(max, diff);
    n += 1;
  }
  console.log(`${String(iters).padStart(6)} vs EXACT   ${((sum / Math.max(1, n)) * 100).toFixed(2).padStart(7)}pp   ${(max * 100).toFixed(2).padStart(7)}pp`);
}

console.log('');
console.log('判据（写死）：');
console.log('  · 若半宽 ≪ margin 的量级（0.1 上下）⇒ margin 主要由**范围假设误差**决定，');
console.log('    而不是采样噪声 ⇒ 不能靠"多跑几次"把 margin 压小；');
console.log('  · 若 400 次与 EXACT 的平均差 < 1pp ⇒ 400 次够用，可以固定下来。');
