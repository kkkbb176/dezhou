/**
 * ============================================================================
 * P1-4 最小确定性复现（**只读**）：Hero 下注额 = 对手全部剩余时，他还能加注吗？
 * ============================================================================
 *
 * 节点：Hero BTN 100BB A♠K♠｜BB **20BB**｜EXP 历史；**河牌 BB 过牌** ⇒ 轮到 Hero 下注。
 *   对手本街前已投：翻前 3BB(6) + 翻牌 2.5BB(5) + 转牌 7.5BB(15) = 26 筹码
 *   ⇒ 他只剩 **14** ⇒ `legalizeBetSizes` 把可下注额封顶为 `min(174, 14) = 14`
 *   ⇒ 他**跟这一注就全下** ⇒ 引擎拒绝他的任何加注。
 *
 * 与 P1-2a 同根因、不同通路（`betResponse` = 「Hero 下注 → 他响应」）。
 */
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { parseManualInput, type ManualHandInput } from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import { applyAction } from '../src/domain/poker/engine.ts';
import { committedThisStreet, computePot, requiredCallAmount } from '../src/domain/poker/gameState.ts';
import { computeLayeredPot } from '../src/domain/poker/pots.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';

const OPTIONS = {
  rules: loadKnowledgeBaseOrThrow().allRules(), asOf: 1_757_000_000_000, writeLog: false,
  equitySeed: 20_261_014, budget: { softMs: 120_000, hardMs: 240_000 },
} as const;

const A = (position: string, type: string, amountBB?: number, street?: string) => ({
  position, type,
  ...(amountBB === undefined ? {} : { amountBB }),
  ...(street === undefined ? {} : { street }),
});

/** 河牌 **BB 过牌** ⇒ Hero 是下注方（P1-4 所在这条通路） */
function riverCheckedToHero(bbStackBB = 20): ManualHandInput {
  return {
    tableSize: 6, heroPosition: 'BTN', heroCards: ['As', 'Ks'],
    board: ['Kd', '9c', '4h', '6s', '2d'], street: 'RIVER',
    effectiveStackBB: 100, bigBlindBB: 2,
    seatStacksBB: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: bbStackBB },
    actionHistory: [
      A('UTG', 'FOLD'), A('HJ', 'FOLD'), A('CO', 'FOLD'), A('BTN', 'RAISE', 3), A('SB', 'FOLD'), A('BB', 'CALL', 2),
      A('BB', 'CHECK', undefined, 'FLOP'), A('BTN', 'BET', 2.5, 'FLOP'), A('BB', 'CALL', 2.5, 'FLOP'),
      A('BB', 'CHECK', undefined, 'TURN'), A('BTN', 'BET', 7.5, 'TURN'), A('BB', 'CALL', 7.5, 'TURN'),
      A('BB', 'CHECK', undefined, 'RIVER'),
    ],
    environment: 'MID_LOW_STAKES',
    villain: { quickProfile: 'CALLING_STATION', dynamicHint: 'UNKNOWN', stackBB: bbStackBB },
  } as unknown as ManualHandInput;
}

const line = (s = ''): void => console.log(s);
const n = (v: unknown, d = 2): string => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : '—');
const pct = (v: unknown, d = 3): string => (typeof v === 'number' && Number.isFinite(v) ? `${(v * 100).toFixed(d)}%` : '—');

line('='.repeat(112));
line(' P1-4 复现：Hero 下注额 = 对手全部剩余时，响应模型是否仍生成加注分支？');
line('='.repeat(112));

const decided = analyzeManualHand(riverCheckedToHero(), OPTIONS);
if (!decided.ok) { line(`分析失败：${decided.stage} ${JSON.stringify(decided.issues)}`); process.exit(1); }
const D = decided.decision as unknown as Record<string, any>;
const DG = D['diagnostics'] as Record<string, any>;
const PF = (DG['postflop'] ?? {}) as Record<string, any>;
const BD = (PF['betDecision'] ?? null) as Record<string, any> | null;
line(`  最终动作 = ${String(D['action'])}${D['sizeChips'] == null ? '' : ` @ ${String(D['sizeChips'])}`}`);
if (BD === null) { line('  本节点没有下注决策 ⇒ 复现前提不成立'); process.exit(1); }

/* ---------- 引擎状态 ---------- */
const gate = buildAnalyzableState(parseManualInput(riverCheckedToHero()).value!);
if (!gate.ok) { line(`重建失败：${JSON.stringify(gate.issues)}`); process.exit(1); }
let state = gate.state;
const hero = state.players.find((p) => p.id === state.userPlayerId)!;
const villain = state.players.find((p) => p.id !== state.userPlayerId && !p.folded)!;
line(`  底池 ${n(computePot(state), 0)}｜Hero 剩余 ${n(hero.remainingStack, 0)}｜对手剩余 ${n(villain.remainingStack, 0)}` +
  `（他本街已投 ${n(committedThisStreet(state, villain.id), 0)}）`);

/* ---------- 逐个尺寸打印响应 ---------- */
const sizes = (BD['sizes'] ?? []) as Record<string, any>[];
line('');
line(`  【尺寸清单】共 ${sizes.length} 个｜preferredAction = ${String(BD['preferredAction'])}` +
  `｜决策层 sizeChips = ${String(D['sizeChips'])}（sizeBB ${String(D['sizeBB'])}）`);
line('  ' + '尺寸'.padEnd(8) + '被封顶'.padEnd(8) + 'P(弃)'.padEnd(10) + 'P(跟)'.padEnd(10) + 'P(加注)'.padEnd(10) +
  'heroIsAllIn'.padEnd(13) + '他全下byCall'.padEnd(14) + '说明');
line('  ' + '-'.repeat(100));
let anyImpossible = false;
for (const s of sizes) {
  const betAmount = s['betAmount'] as number;
  const villainAllInByCall = villain.remainingStack > 0 && betAmount >= villain.remainingStack - 1e-9;
  const raise = s['raiseLikelihood'] as number;
  const flag = villainAllInByCall && raise > 1e-12;
  if (flag) anyImpossible = true;
  line('  ' + String(betAmount).padEnd(8) + String(s['wasCapped']).padEnd(8) +
    pct(s['foldLikelihood']).padEnd(10) + pct(s['callLikelihood']).padEnd(10) + pct(raise).padEnd(10) +
    String(s['heroIsAllIn']).padEnd(13) + String(s['villainIsAllInByCall'] ?? '（未上报）').padEnd(14) +
    (flag ? '🔴 **不可能存在的加注分支**' : (villainAllInByCall ? '（他跟注即全下 ⇒ 加注必须为 0）' : '')));
}

/* ---------- 引擎级证明 ---------- */
line('');
line('  【引擎级重放】');
const betTo = sizes.length > 0 ? (sizes[sizes.length - 1]!['betAmount'] as number) : 0;
const r1 = applyAction(state, { playerId: hero.id, type: 'BET', amount: betTo } as never);
line(`    Hero BET ${n(betTo, 0)} ⇒ ${r1.ok ? '接受' : `拒绝 ${String(r1.issues?.[0]?.code)}`}`);
if (r1.ok) {
  state = r1.state;
  const need = requiredCallAmount(state, villain.id);
  const r2 = applyAction(state, { playerId: villain.id, type: 'CALL', amount: need } as never);
  line(`    他 CALL ${n(need, 0)} ⇒ ${r2.ok ? '接受' : `拒绝 ${String(r2.issues?.[0]?.code)}`}`);
  if (r2.ok) {
    state = r2.state;
    const va = state.players.find((p) => p.id === villain.id)!;
    const pot = computeLayeredPot(state);
    line(`    他：allIn = ${String(va.allIn)}｜剩余 = ${n(va.remainingStack, 0)}｜computePot = ${n(computePot(state), 0)}｜contested = ${n(pot.contested, 0)}｜退回 ${JSON.stringify(pot.returned)}`);
    const r3 = applyAction(state, { playerId: villain.id, type: 'RAISE', amount: betTo * 2 } as never);
    line(`    他再 RAISE ⇒ ${r3.ok ? '🔴 竟然被接受' : `**被引擎拒绝**：${String(r3.issues?.[0]?.code)}`}`);
  }
}

line('');
line('='.repeat(112));
line(anyImpossible
  ? '  🔴 **复现成功（缺陷确凿）**：下注额 ≥ 他的全部剩余（他跟注即全下），引擎拒绝他的加注，' +
    '而响应模型仍给出 > 0 的加注概率。'
  : '  ✔ 未复现：下注额吃光他的筹码时，响应模型的加注概率为 0。');
line('='.repeat(112));
