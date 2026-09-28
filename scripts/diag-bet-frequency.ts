/*
 * 诊断：进攻面为什么**永远 BET**？
 *
 * 矩阵实测（`scripts/player-type-exploit-matrix-after.txt`）：13 种画像全部 BET，
 * 一次 CHECK 都没有。而引擎报的 EV 是 `BetEV 420 vs CHECK EV 125.6`。
 *
 * 我用底池赔率手算对不上（420 筹码需要约 830% 的弃牌率），
 * 所以**先不猜**，把下注决策的完整结构打出来。
 */
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { loadKnowledgeBase } from '../src/domain/knowledge/knowledgeLoader.ts';
import type { ManualHandInput } from '../src/app/manualInput/manualInput.ts';

const knowledge = loadKnowledgeBase();
if (!knowledge.ok) throw new Error('知识库加载失败');
const rules = knowledge.index.allRules();

/** 与矩阵夹具一致：9 人桌 / 100BB / 中低级别；Hero BTN 用 A♠5♠（纯空气） */
const spot: ManualHandInput = {
  tableSize: 9,
  heroPosition: 'BTN',
  heroCards: ['As', '5s'],
  board: ['Ks', '7h', '2c'],
  street: 'FLOP',
  effectiveStackBB: 100,
  actionHistory: [
    { position: 'UTG', type: 'FOLD' },
    { position: 'UTG1', type: 'FOLD' },
    { position: 'UTG2', type: 'FOLD' },
    { position: 'LJ', type: 'FOLD' },
    { position: 'HJ', type: 'FOLD' },
    { position: 'CO', type: 'FOLD' },
    { position: 'BTN', type: 'RAISE', amountBB: 2.5 },
    { position: 'SB', type: 'FOLD' },
    { position: 'BB', type: 'CALL', amountBB: 1.5 },
    { position: 'BB', type: 'CHECK', street: 'FLOP' },
  ],
  environment: 'MID_LOW_STAKES',
  bigBlindBB: 100,
  villain: { quickProfile: 'NORMAL', dynamicHint: 'UNKNOWN' },
} as unknown as ManualHandInput;

const r = analyzeManualHand(spot, { rules, writeLog: false, equitySeed: 1 });
if (!r.ok) {
  console.log(`引擎失败：${r.stage} ${r.issues.map((i) => `${i.code}: ${i.message}`).join('；')}`);
  process.exit(0);
}

console.log(`动作 = ${r.decision.action}  尺寸 = ${(r.decision.sizeBB ?? 0).toFixed(2)}BB`);
console.log(`底池（引擎重算）= ${r.computedPot} 筹码 = ${(r.computedPot / 100).toFixed(2)}BB`);
console.log(`所需权益 = ${(r.decision.diagnostics.math?.requiredEquity ?? Number.NaN) * 100}%`);
console.log('');

const bd = r.decision.diagnostics.betDecision;
if (bd === null) {
  console.log('没有下注决策模型');
  process.exit(0);
}

console.log(`下注模型：pot=${bd.pot}  checkEV=${bd.checkEV}  checkRealizationFactor=${bd.checkRealizationFactor.toFixed(4)}`);
console.log(`preferredAction=${bd.preferredAction}  bestSize=${bd.bestSize}`);
console.log('');
console.log('逐尺寸：');
console.log('尺寸        金额       P(弃)   P(跟)   P(加)   betEV      与checkEV之差   偏好分');
for (const s of bd.sizes) {
  const delta = s.betEV === null || bd.checkEV === null ? null : s.betEV - bd.checkEV;
  console.log(
    `${s.kind.padEnd(11)} ${String(s.betAmount).padStart(6)}   ` +
      `${(s.foldLikelihood * 100).toFixed(1).padStart(5)}%  ${(s.callLikelihood * 100).toFixed(1).padStart(5)}%  ` +
      `${(s.raiseLikelihood * 100).toFixed(1).padStart(5)}%  ` +
      `${s.betEV === null ? 'null' : s.betEV.toFixed(2).padStart(9)}   ` +
      `${delta === null ? 'null' : delta.toFixed(2).padStart(12)}   ` +
      `${s.score === undefined ? '—' : s.score.toFixed(4)}`,
  );
}

console.log('');
console.log('手算对照（用引擎自己的数字）：');
const best = bd.sizes.reduce((a, b) => ((b.betEV ?? -1e9) > (a.betEV ?? -1e9) ? b : a));
const pot = bd.pot;
console.log(`  选中尺寸 ${best.kind} 金额 ${best.betAmount}`);
console.log(`  P(弃)=${(best.foldLikelihood * 100).toFixed(1)}% ⇒ 弃牌收益上限 = ${(best.foldLikelihood * pot).toFixed(2)} 筹码`);
console.log(`  若 betEV 只由「弃牌收益 + 被跟时的权益」构成，它应当 ≈ ${(best.foldLikelihood * pot + best.callLikelihood * r.viewModel.math.heroEquity * (pot + 2 * best.betAmount)).toFixed(2)}`);
console.log(`  引擎实际报的 betEV = ${best.betEV?.toFixed(2)}`);
console.log(`  checkEV = ${bd.checkEV?.toFixed(2)}（= 权益 × 实现因子 × 底池 = ${(r.viewModel.math.heroEquity * bd.checkRealizationFactor * pot).toFixed(2)}）`);
