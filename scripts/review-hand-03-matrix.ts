/**
 * 测试局 3 河牌节点 · 对手类型矩阵
 *
 * 同一局面（BTN A♥Q♣，河牌 Q♠8♦3♣6♠K♠ 面对 CO 82% 池下注，需 31.0% 权益）
 * 只改对手类型，看引擎给出什么。
 *
 * 用法：`E:\node.exe --experimental-strip-types scripts/review-hand-03-matrix.ts`
 */
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { advisePostflop } from '../src/app/decision/postflopAdvisor.ts';
import { deriveLegalActions } from '../src/app/manualInput/legalActions.ts';
import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';
import { parseManualInput } from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import type { ManualHandInput } from '../src/app/manualInput/manualInput.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const OPTIONS = { rules: RULES, asOf: 1_757_000_000_000, writeLog: false } as const;
const SEATS = { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 } as const;
const HISTORY = [
  { position: 'UTG', type: 'FOLD' },
  { position: 'HJ', type: 'FOLD' },
  { position: 'CO', type: 'RAISE', amountBB: 2.5 },
  { position: 'BTN', type: 'CALL', amountBB: 2.5 },
  { position: 'SB', type: 'FOLD' },
  { position: 'BB', type: 'FOLD' },
  { position: 'CO', type: 'BET', amountBB: 2, street: 'FLOP' },
  { position: 'BTN', type: 'CALL', amountBB: 2, street: 'FLOP' },
  { position: 'CO', type: 'BET', amountBB: 7, street: 'TURN' },
  { position: 'BTN', type: 'CALL', amountBB: 7, street: 'TURN' },
  { position: 'CO', type: 'BET', amountBB: 20, street: 'RIVER' },
] as const;

const CASES: readonly { case: string; profile: string; hint: string; note: string }[] = [
  { case: 'A', profile: 'VERY_TIGHT', hint: 'UNKNOWN', note: '河牌非常紧（极紧）' },
  { case: 'A', profile: 'UNDERBLUFFER', hint: 'UNKNOWN', note: '河牌严重少诈唬（不诈唬型）' },
  { case: 'B', profile: 'NORMAL', hint: 'UNKNOWN', note: '普通常规玩家' },
  { case: 'C', profile: 'BLUFF_HEAVY', hint: 'UNKNOWN', note: '明显过度诈唬' },
  { case: 'C', profile: 'BLUFF_HEAVY', hint: 'AGGRESSION_UP', note: '过度诈唬 + 已观察到进攻上升' },
  { case: 'C', profile: 'MANIAC', hint: 'AGGRESSION_UP', note: '极端：疯子 + 进攻上升' },
];

console.log('局面：BTN A♥Q♣｜河牌 Q♠8♦3♣6♠K♠｜CO 下注 20BB（82% 池）｜需 31.0% 权益｜身后 68.5BB\n');
console.log(
  '  案例  对手类型/提示                     权益    跟注EV   动作   判定         CALL分  FOLD分  抓诈唬δ  更强占比  档1质量',
);
for (const c of CASES) {
  const input = {
    tableSize: 6,
    heroPosition: 'BTN',
    heroCards: ['Ah', 'Qc'],
    board: ['Qs', '8d', '3c', '6s', 'Ks'],
    street: 'RIVER',
    effectiveStackBB: 100,
    bigBlindBB: 2,
    seatStacksBB: { ...SEATS },
    actionHistory: [...HISTORY],
    environment: 'MID_LOW_STAKES',
    villain: { quickProfile: c.profile, dynamicHint: c.hint, stackBB: 100 },
  } as unknown as ManualHandInput;

  const r = analyzeManualHand(input, OPTIONS);
  if (!r.ok) {
    console.log(`  ${c.case}  ${c.note}：❌ ${JSON.stringify(r.issues)}`);
    continue;
  }
  const m = r.decision.diagnostics.math;
  const post = r.decision.diagnostics.postflop!;
  const pref = new Map(post.evRanking.map((x) => [x.action, x.score]));

  // 门内部：剥削偏移与范围质量
  let delta = 0;
  let stronger = Number(post.valueAssessment['strongerShare']);
  let tier1 = 0;
  const parsed = parseManualInput(input);
  if (parsed.ok) {
    const gate = buildAnalyzableState(parsed.value);
    if (gate.ok) {
      const built = buildDecisionContext({
        state: gate.state,
        rules: RULES,
        environment: 'MID_LOW_STAKES',
        asOf: 1_757_000_000_000,
        quickProfile: c.profile,
      });
      const heroP = gate.state.players.find((p) => p.holeCards !== null)!;
      const legal = deriveLegalActions(gate.state, heroP);
      const advice = advisePostflop(built.context, {
        facingBet: legal.callCost > 0,
        requiredEquity: built.context.math.requiredEquity,
        potAfterCall: built.context.math.pot + legal.callCost,
      });
      if (advice !== null) delta = advice.exploit.bluffCatchDelta;
      const f = built.context.postflopFacts?.opponentRangeFacts ?? null;
      if (f !== null) {
        stronger = f.strongerShare;
        tier1 = f.tierHistogram[1] ?? 0;
      }
    }
  }
  console.log(
    `  ${c.case}  ${(c.note + `（${c.profile}${c.hint === 'UNKNOWN' ? '' : '+' + c.hint}）`).padEnd(46)}` +
      `${((m.heroEquity ?? 0) * 100).toFixed(1).padStart(5)}%  ` +
      `${(m.callEV ?? 0).toFixed(2).padStart(7)}  ` +
      `${String(r.decision.action).padEnd(5)}  ${r.decision.classification.padEnd(10)}  ` +
      `${(pref.get('CALL') ?? 0).toFixed(3)}  ${(pref.get('FOLD') ?? 0).toFixed(3)}  ` +
      `${delta.toFixed(4).padStart(7)}  ` +
      `${(stronger * 100).toFixed(1).padStart(6)}%  ${(tier1 * 100).toFixed(1).padStart(6)}%`,
  );
}
