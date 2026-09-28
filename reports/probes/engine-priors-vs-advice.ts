/**
 * 实战核查：**翻前建议 vs 引擎自己的先验表**是否一致
 *
 * ## 为什么查这个
 *
 * 走查里 BB 拿 ♠7♦2（扑克最差手牌）面对 BTN 开池，引擎建议 **RAISE 9BB**（EV 262.13
 * 筹码 = +2.62BB），而跟注只有 15.11。但引擎**自己的** `threeBetWeights(9max, BB, BTN)`
 * 表里**没有 72o**，连 `defendWeights`（继续范围）里也没有。
 *
 * 两者必有一个是错的：
 * · 若先验表对 ⇒ 建议层不该推荐加注；
 * · 若建议对 ⇒ 先验表漏了牌（且对手范围建模会系统偏差）。
 *
 * 本脚本遍历全部 **169 个手牌类别**，把「引擎的建议动作」与「引擎自己的范围表」
 * 逐手牌对照，统计双向不一致。
 *
 * ⚠️ 只读。
 *
 * ```powershell
 * node --experimental-strip-types reports/probes/engine-priors-vs-advice.ts
 * ```
 */

import { Position, Street, TableSize } from '../../src/domain/types.ts';
import { GameEnvironment } from '../../src/domain/range/gameEnvironment.ts';
import { loadKnowledgeBaseOrThrow } from '../../src/domain/knowledge/knowledgeLoader.ts';
import { allRankClassKeys, defendWeights, threeBetWeights } from '../../src/app/manualInput/preflopPriors.ts';
import type { ManualHandInput } from '../../src/app/manualInput/manualInput.ts';
import { analyzeManualHand } from '../../src/app/alphaPipeline.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const O9: readonly Position[] = [
  Position.UTG, Position.UTG1, Position.UTG2, Position.LJ, Position.HJ,
  Position.CO, Position.BTN, Position.SB, Position.BB,
];
type Action = ManualHandInput['actionHistory'][number];
const F = (p: Position): Action => ({ position: p, type: 'FOLD', street: Street.PREFLOP }) as Action;
const R = (p: Position, a: number): Action => ({ position: p, type: 'RAISE', amountBB: a, street: Street.PREFLOP }) as Action;

/** 类别键（AA / AKs / AKo）→ 两张具体牌（保证不重复） */
function cardsOf(key: string): [string, string] {
  const r1 = key[0]!;
  const r2 = key[1]!;
  if (key.length === 2) return [`${r1}s`, `${r2}h`];
  const suited = key.endsWith('s');
  return suited ? [`${r1}s`, `${r2}s`] : [`${r1}s`, `${r2}h`];
}

const BB_VS_BTN = (): ManualHandInput => ({
  tableSize: 9, heroPosition: Position.BB, heroCards: ['As', 'Kd'], board: [],
  street: Street.PREFLOP, effectiveStackBB: 100, bigBlindBB: 100,
  environment: GameEnvironment.LOW_STAKES_ONLINE, occupiedPositions: [...O9], buttonPosition: Position.BTN,
  actionHistory: [...O9.slice(0, 6).map((p) => F(p)), R(Position.BTN, 2.5), F(Position.SB)],
} as ManualHandInput);

const T = TableSize.NINE_MAX;
const threeBet = threeBetWeights(T, Position.BB, Position.BTN) as unknown as Record<string, number>;
const defend = defendWeights(T, Position.BTN, Position.BB) as unknown as Record<string, number>;

const ALL = allRankClassKeys();
const advisedRaise: string[] = [];
const advisedCall: string[] = [];
const advisedFold: string[] = [];
const reasons = new Map<string, number>();

for (const key of ALL) {
  const input = BB_VS_BTN();
  (input as { heroCards: [string, string] }).heroCards = cardsOf(key);
  const r = analyzeManualHand(input, { rules: RULES });
  if (!r.ok || r.decision.action === null) { advisedFold.push(`${key}(不可分析)`); continue; }
  const a = String(r.decision.action);
  if (a === 'RAISE' || a === 'ALL_IN') advisedRaise.push(key);
  else if (a === 'CALL') advisedCall.push(key);
  else advisedFold.push(key);
  for (const reason of r.decision.reasons.slice(0, 3)) {
    reasons.set(reason.code, (reasons.get(reason.code) ?? 0) + 1);
  }
}

const inThreeBet = (k: string): boolean => (threeBet[k] ?? 0) > 0;
const inDefend = (k: string): boolean => (defend[k] ?? 0) > 0;

console.log('════════ BB 面对 BTN 开池 2.5BB：169 手牌逐个问引擎 ════════\n');
console.log(`  建议加注 ${advisedRaise.length} 类 ｜ 建议跟注 ${advisedCall.length} 类 ｜ 建议弃牌 ${advisedFold.length} 类`);
console.log(`  引擎自己的 3Bet 表 ${ALL.filter(inThreeBet).length} 类 ｜ 继续(防守)表 ${ALL.filter(inDefend).length} 类\n`);

const raiseNotIn3bet = advisedRaise.filter((k) => !inThreeBet(k));
const raiseNotEvenDefend = advisedRaise.filter((k) => !inDefend(k));
const threeBetNotRaised = ALL.filter((k) => inThreeBet(k) && !advisedRaise.includes(k));

console.log('★ 建议加注、但**不在引擎自己的 3Bet 表**里：' + `${raiseNotIn3bet.length} 类`);
console.log(`   ${raiseNotIn3bet.join(' ')}`);
console.log('\n★ 建议加注、且**连继续(防守)表都不在**里：' + `${raiseNotEvenDefend.length} 类`);
console.log(`   ${raiseNotEvenDefend.join(' ')}`);
console.log('\n★ 引擎自己的 3Bet 表里有、但建议**没有加注**：' + `${threeBetNotRaised.length} 类`);
console.log(`   ${threeBetNotRaised.slice(0, 40).join(' ')}${threeBetNotRaised.length > 40 ? ' …' : ''}`);

/* 最差手牌专项 */
console.log('\n════════ 最差手牌专项 ════════');
for (const k of ['72o', '82o', '83o', '92o', '32o', '42o', '52o', '62o', '73o', 'T2o']) {
  const input = BB_VS_BTN();
  (input as { heroCards: [string, string] }).heroCards = cardsOf(k);
  const r = analyzeManualHand(input, { rules: RULES });
  if (!r.ok || r.decision.action === null) { console.log(`  ${k}: 不可分析`); continue; }
  const raise = r.decision.diagnostics.candidates
    .filter((c) => (c.action === 'RAISE' || c.action === 'ALL_IN') && c.ev !== null)
    .sort((a, b) => (b.ev ?? 0) - (a.ev ?? 0))[0];
  const call = r.decision.diagnostics.candidates.find((c) => c.action === 'CALL');
  console.log(
    `  ${k.padEnd(4)} 建议 ${String(r.decision.action).padEnd(5)}` +
      ` ｜加注EV ${raise === undefined ? '—' : `${(raise.sizeChips! / 100).toFixed(1)}BB=${raise.ev!.toFixed(2)}`}` +
      ` ｜跟注EV ${call?.ev === undefined || call?.ev === null ? '—' : call.ev.toFixed(2)}` +
      ` ｜3Bet表=${inThreeBet(k) ? '有' : '无'} 继续表=${inDefend(k) ? '有' : '无'}`,
  );
}

console.log('\n════════ 建议理由码分布（前 3 条）════════');
for (const [code, n] of [...reasons].sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log(`  ${code}  ${n}`);
