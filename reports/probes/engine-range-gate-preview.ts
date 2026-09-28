/**
 * **修复效果预演**（不改引擎，只做离线模拟）
 *
 * ## 方案
 *
 * 「范围闸门」：翻前面对开池时，只有当该手牌在引擎**自己的**
 * `threeBetWeights(hero, opener)` 里（权重 > 0）才允许把「加注」纳入动作比较；
 * 否则加注不入选，决策退回 CALL / FOLD 之间比较。
 *
 * ## 本脚本算什么
 *
 * 对每个手牌类别跑**当前**引擎，读出候选 EV，然后**离线**按闸门规则重算建议，
 * 得到「修完之后的建议分布」，用于判断修复是否会产生合理打法、以及影响面多大。
 *
 * ⚠️ 只读（不写任何数据文件、不改引擎）。
 *
 * ```powershell
 * node --experimental-strip-types reports/probes/engine-range-gate-preview.ts
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
const i9 = (p: Position): number => O9.indexOf(p);
const ALL = allRankClassKeys();
const T = TableSize.NINE_MAX;

const cardsOf = (k: string): [string, string] =>
  k.length === 2 ? [`${k[0]}s`, `${k[1]}h`] : [k[0] + 's', k[1] + (k.endsWith('s') ? 's' : 'h')];

const spot = (hero: Position, opener: Position, cards: [string, string]): ManualHandInput => {
  const h: Action[] = O9.slice(0, i9(opener)).map((p) => F(p));
  h.push(R(opener, 2.5));
  for (let i = i9(opener) + 1; i < i9(hero); i++) h.push(F(O9[i]!));
  return {
    tableSize: 9, heroPosition: hero, heroCards: cards, board: [], street: Street.PREFLOP,
    effectiveStackBB: 100, bigBlindBB: 100, environment: GameEnvironment.LOW_STAKES_ONLINE,
    occupiedPositions: [...O9], buttonPosition: Position.BTN, actionHistory: h,
  } as ManualHandInput;
};

const combos: [string, Position, Position][] = [
  ['BB  vs BTN 开池', Position.BB, Position.BTN],
  ['BB  vs CO  开池', Position.BB, Position.CO],
  ['BB  vs UTG 开池', Position.BB, Position.UTG],
  ['BTN vs CO  开池', Position.BTN, Position.CO],
  ['CO  vs HJ  开池', Position.CO, Position.HJ],
  ['SB  vs BTN 开池', Position.SB, Position.BTN],
];

console.log('════════ 修复效果预演：加一道「以引擎自身 3Bet 先验为准」的范围闸门 ════════\n');
console.log('节点               现在: 加/跟/弃      闸门后: 加/跟/弃     闸门后加注的手牌（前 30）');
console.log('─'.repeat(104));

for (const [label, hero, opener] of combos) {
  const prior = threeBetWeights(T, hero, opener) as unknown as Record<string, number>;
  const defend = defendWeights(T, opener, hero) as unknown as Record<string, number>;
  const allowed = (k: string): boolean => (prior[k] ?? 0) > 0;

  let nowR = 0; let nowC = 0; let nowF = 0;
  let gateR = 0; let gateC = 0; let gateF = 0;
  const gateRaiseHands: string[] = [];
  const gateCallHands: string[] = [];
  let overridden = 0; // 闸门挡下、但加注 EV 明显更高的手牌（"被压制"的手牌）

  for (const k of ALL) {
    const r = analyzeManualHand(spot(hero, opener, cardsOf(k)), { rules: RULES });
    if (!r.ok || r.decision.action === null) continue;
    const a = String(r.decision.action);
    if (a === 'RAISE' || a === 'ALL_IN') nowR++; else if (a === 'CALL') nowC++; else nowF++;

    const cands = r.decision.diagnostics.candidates;
    const callEV = cands.find((c) => c.action === 'CALL')?.ev ?? null;
    const bestRaise = cands
      .filter((c) => (c.action === 'RAISE' || c.action === 'ALL_IN') && c.ev !== null)
      .sort((x, y) => (y.ev ?? 0) - (x.ev ?? 0))[0];
    const raiseEV = bestRaise?.ev ?? null;

    if (allowed(k)) {
      /* 闸门放行 ⇒ 沿用引擎当前的选择 */
      if (a === 'RAISE' || a === 'ALL_IN') { gateR++; gateRaiseHands.push(k); }
      else if (a === 'CALL') { gateC++; gateCallHands.push(k); }
      else gateF++;
    } else {
      /* 闸门拦下加注 ⇒ 只在 CALL / FOLD 之间按 EV 取高者（弃牌 EV ≡ 0） */
      if (raiseEV !== null && callEV !== null && raiseEV > (callEV ?? 0) + 1e-9) overridden++;
      if (callEV !== null && callEV > 1e-9) { gateC++; gateCallHands.push(k); } else gateF++;
    }
  }

  console.log(
    `${label.padEnd(16)} ${String(nowR).padStart(3)}/${String(nowC).padStart(3)}/${String(nowF).padStart(3)}` +
      `      ${String(gateR).padStart(3)}/${String(gateC).padStart(3)}/${String(gateF).padStart(3)}` +
      `     ${gateRaiseHands.slice(0, 30).join(' ')}${gateRaiseHands.length > 30 ? ' …' : ''}`,
  );
  console.log(
    `                 闸门后仍会跟注 ${gateCallHands.length} 类：` +
      `${gateCallHands.slice(0, 26).join(' ')}${gateCallHands.length > 26 ? ' …' : ''}` +
      `  ｜被闸门挡下但加注 EV 更高的：${overridden} 类`,
  );
  console.log(
    `                 防守表覆盖：闸门后加注里不在防守表的 ${gateRaiseHands.filter((k) => (defend[k] ?? 0) === 0).length} 类`,
  );
}
