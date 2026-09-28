/*
 * 弃牌率的**构成**：引擎报的 foldLikelihood 是「范围质量占比」，
 * 那么到底是「一大堆组合都判弃」还是「少数组合拿了很大的概率权重」？
 *
 * 同时对照：对手**真实那两张牌**在这个尺寸下被判成什么（用引擎自己报的逐组合口径）。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { loadKnowledgeBase } from '../src/domain/knowledge/knowledgeLoader.ts';
import { parsePhh } from '../src/domain/realHands/phh.ts';
import { toValidatorSnapshotsDetailed } from '../src/domain/realHands/phhToEngineInput.ts';

const knowledge = loadKnowledgeBase();
if (!knowledge.ok) throw new Error('知识库加载失败');
const rules = knowledge.index.allRules();

const ROOT = join(process.cwd(), 'third_party', 'phh-dataset');

type Row = {
  foldMass: number;
  callMass: number;
  raiseMass: number;
  foldCombo: number;
  callCombo: number;
  raiseCombo: number;
  pot: number;
  bet: number;
  realFolded: boolean;
  street: string;
};

const rows: Row[] = [];

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
      const later = snaps.slice(i + 1).find((s) => s.heroName !== snap.heroName);
      if (later === undefined) continue;

      type SizeLike = {
        betAmount?: number;
        sizeChips?: number;
        foldLikelihood?: number;
        callLikelihood?: number;
        raiseLikelihood?: number;
        foldRangeMass?: number;
        callRangeMass?: number;
        raiseRangeMass?: number;
        foldComboCount?: number;
        callComboCount?: number;
        raiseComboCount?: number;
      };
      const diag = r.decision.diagnostics as unknown as {
        betDecision?: { sizes?: readonly SizeLike[] };
        preflopRaise?: { sizes?: readonly SizeLike[] };
      };
      const sizes: readonly SizeLike[] = diag.betDecision?.sizes ?? diag.preflopRaise?.sizes ?? [];
      if (sizes.length === 0) continue;
      const amountOf = (s: SizeLike): number => s.betAmount ?? s.sizeChips ?? 0;
      const want = r.decision.sizeChips;
      const hit =
        want === undefined
          ? sizes[0]!
          : (sizes.find((s) => amountOf(s) === want) ??
            sizes.reduce((a, b) => (Math.abs(amountOf(b) - want) < Math.abs(amountOf(a) - want) ? b : a)));

      if (hit.foldLikelihood === undefined) continue;
      rows.push({
        foldMass: hit.foldRangeMass ?? hit.foldLikelihood,
        callMass: hit.callRangeMass ?? hit.callLikelihood ?? 0,
        raiseMass: hit.raiseRangeMass ?? hit.raiseLikelihood ?? 0,
        foldCombo: hit.foldComboCount ?? 0,
        callCombo: hit.callComboCount ?? 0,
        raiseCombo: hit.raiseComboCount ?? 0,
        pot: r.computedPot,
        bet: amountOf(hit),
        realFolded: later.realAction === 'FOLD',
        street: snap.street,
      });
    }
  }
}

const mean = (xs: number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);
const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);

console.log(`样本 ${rows.length}`);
console.log('');
console.log('引擎报的三桶（质量 / 组合数）均值：');
console.log(`  fold  质量 ${mean(rows.map((r) => r.foldMass)).toFixed(3)}   组合 ${mean(rows.map((r) => r.foldCombo)).toFixed(1)}`);
console.log(`  call  质量 ${mean(rows.map((r) => r.callMass)).toFixed(3)}   组合 ${mean(rows.map((r) => r.callCombo)).toFixed(1)}`);
console.log(`  raise 质量 ${mean(rows.map((r) => r.raiseMass)).toFixed(3)}   组合 ${mean(rows.map((r) => r.raiseCombo)).toFixed(1)}`);
console.log('');
const totalCombos = mean(rows.map((r) => r.foldCombo + r.callCombo + r.raiseCombo));
const foldShareByCount = mean(rows.map((r) => r.foldCombo / Math.max(1, r.foldCombo + r.callCombo + r.raiseCombo)));
console.log(`范围总组合数均值 = ${totalCombos.toFixed(1)}`);
console.log(`  按**组合数**：判弃占比 ${(foldShareByCount * 100).toFixed(1)}%`);
console.log(`  按**质量**  ：判弃占比 ${(mean(rows.map((r) => r.foldMass)) * 100).toFixed(1)}%`);
console.log(`  ⇒ 若质量远高于组合数占比，说明**少数组合拿了很大概率权重**（不是"一大片都判弃"）`);
console.log('');
console.log('按真实结果分组：');
for (const [name, g] of [['真实弃牌', rows.filter((r) => r.realFolded)], ['真实继续', rows.filter((r) => !r.realFolded)]] as const) {
  if (g.length === 0) continue;
  console.log(
    `  ${name} n=${String(g.length).padStart(4)}  预测弃牌率 ${(mean(g.map((r) => r.foldMass)) * 100).toFixed(1)}%  ` +
      `注额/底池 ${(sum(g.map((r) => r.bet)) / Math.max(1, sum(g.map((r) => r.pot)))).toFixed(3)}`,
  );
}
console.log('');
console.log('按街：');
for (const st of ['FLOP', 'TURN', 'RIVER']) {
  const g = rows.filter((r) => r.street === st);
  if (g.length === 0) continue;
  console.log(
    `  ${st.padEnd(6)} n=${String(g.length).padStart(4)}  预测 ${(mean(g.map((r) => r.foldMass)) * 100).toFixed(1)}%  ` +
      `实际 ${(g.filter((r) => r.realFolded).length / g.length * 100).toFixed(1)}%`,
  );
}
