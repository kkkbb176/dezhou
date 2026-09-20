/**
 * ============================================================================
 * 第二阶段 · 任务一（BET 13 vs 14 尺寸一致性）+ 任务二（短筹码未匹配金额）
 * ============================================================================
 * 只读探针。节点：Hero BTN 100BB A♠K♠｜BB 20BB（任务一）/ BB 30BB（任务二，P0-7）
 */
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { deriveLegalActions, buildSizeGrid } from '../src/app/manualInput/legalActions.ts';
import { parseManualInput, type ManualHandInput } from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import { committedThisStreet, computePot, minRaiseTo } from '../src/domain/poker/gameState.ts';
import { BET_SIZE_SPECS } from '../src/domain/postflop/betResponse.ts';
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

function node(bb: number, riverBet: number | 'CHECK'): ManualHandInput {
  const river = riverBet === 'CHECK'
    ? [A('BB', 'CHECK', undefined, 'RIVER')]
    : [A('BB', 'BET', riverBet, 'RIVER')];
  return {
    tableSize: 6, heroPosition: 'BTN', heroCards: ['As', 'Ks'],
    board: ['Kd', '9c', '4h', '6s', '2d'], street: 'RIVER',
    effectiveStackBB: 100, bigBlindBB: 2,
    seatStacksBB: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: bb },
    actionHistory: [
      A('UTG', 'FOLD'), A('HJ', 'FOLD'), A('CO', 'FOLD'), A('BTN', 'RAISE', 3), A('SB', 'FOLD'), A('BB', 'CALL', 2),
      A('BB', 'CHECK', undefined, 'FLOP'), A('BTN', 'BET', 2.5, 'FLOP'), A('BB', 'CALL', 2.5, 'FLOP'),
      A('BB', 'CHECK', undefined, 'TURN'), A('BTN', 'BET', 7.5, 'TURN'), A('BB', 'CALL', 7.5, 'TURN'),
      ...river,
    ],
    environment: 'MID_LOW_STAKES',
    villain: { quickProfile: 'CALLING_STATION', dynamicHint: 'UNKNOWN', stackBB: bb },
  } as unknown as ManualHandInput;
}

const line = (s = ''): void => console.log(s);
const n = (v: unknown, d = 2): string => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : '—');

/* ============================================================
 * 任务一：BET 13 vs 14
 * ============================================================ */
line('='.repeat(118));
line(' 任务一：BET 尺寸一致性（Hero BTN 100BB / BB 20BB / 河牌 BB 过牌 ⇒ Hero 下注）');
line('='.repeat(118));

const input1 = node(20, 'CHECK');
const gate1 = buildAnalyzableState(parseManualInput(input1).value!);
if (!gate1.ok) { line(`重建失败 ${JSON.stringify(gate1.issues)}`); process.exit(1); }
const st1 = gate1.state;
const hero1 = st1.players.find((p) => p.id === st1.userPlayerId)!;
const vil1 = st1.players.find((p) => p.id !== st1.userPlayerId && !p.folded)!;
const legal1 = deriveLegalActions(st1, hero1);
const pot1 = computePot(st1);
line(`  ① 决策点：底池 ${n(pot1, 0)}｜Hero 剩余 ${n(hero1.remainingStack, 0)}｜对手剩余 ${n(vil1.remainingStack, 0)}` +
  `｜minBet ${n(legal1.minBet, 2)}｜allInTo ${n(legal1.allInToAmount, 0)}`);
line(`  ② 理论下注尺寸（BET_SIZE_SPECS × 底池）：` +
  BET_SIZE_SPECS.map((s) => `${s.kind}=${n(pot1 * s.ratioToPot, 2)}`).join('｜'));
line(`     有效筹码上限 maxBet = min(Hero ${n(hero1.remainingStack, 0)}, 对手 ${n(vil1.remainingStack, 0)}) = ${n(Math.min(hero1.remainingStack, vil1.remainingStack), 0)}`);
line(`  ③ 决策层候选网格 buildSizeGrid(legal, pot, 'BET') = [${buildSizeGrid(legal1, pot1, 'BET').map((o) => o.toAmount).join(', ')}]`);

const r1 = analyzeManualHand(input1, OPTIONS);
if (!r1.ok) { line('分析失败'); process.exit(1); }
const D1 = r1.decision as unknown as Record<string, any>;
const DG1 = D1['diagnostics'] as Record<string, any>;
const BD1 = ((DG1['postflop'] ?? {})['betDecision'] ?? null) as Record<string, any> | null;
line(`  ④ 响应模型实际评估的尺寸（betDecision.sizes）：`);
for (const s of ((BD1?.['sizes'] ?? []) as Record<string, any>[])) {
  line(`     ${String(s['size'])}：betAmount ${n(s['betAmount'], 0)}（请求 ${n(s['requestedAmount'], 2)}，被封顶 ${String(s['wasCapped'])}）` +
    `｜P(弃/跟/加) ${n(s['foldLikelihood'], 4)}/${n(s['callLikelihood'], 4)}/${n(s['raiseLikelihood'], 4)}` +
    `｜他全下byCall ${String(s['villainIsAllInByCall'])}`);
}
line(`     bestSize = ${String(BD1?.['bestSize'])}｜preferredAction = ${String(BD1?.['preferredAction'])}`);
line(`  ⑤ 最终推荐：动作 ${String(D1['action'])}｜金额 ${String(D1['sizeChips'])} 筹码（sizeBB ${n(D1['sizeBB'], 2)}）`);
line(`     ⇒ 被评估 ${n((BD1?.['sizes'] ?? [])[0]?.['betAmount'], 0)} vs 被推荐 ${String(D1['sizeChips'])}：` +
  `${Number(D1['sizeChips']) === Number((BD1?.['sizes'] ?? [])[0]?.['betAmount']) ? '一致 ✔' : '🔴 **不一致**'}`);
const cands1 = (DG1['candidates'] ?? []) as Record<string, any>[];
line(`     决策层 BET 候选：${cands1.filter((c) => c['action'] === 'BET').map((c) => String(c['sizeChips'])).join(', ')}` +
  `（目标尺寸 = 响应模型最佳尺寸 ${n((BD1?.['sizes'] ?? [])[0]?.['betAmount'], 0)} ⇒ 取最近候选）`);
line('');

/* ============================================================
 * 任务二：短筹码未匹配金额（P0-7：BB 30BB）
 * ============================================================ */
line('='.repeat(118));
line(' 任务二：短筹码未匹配金额（P0-7：Hero BTN 100BB / BB 30BB / 河牌 BB 下注 10BB）');
line('='.repeat(118));

const input2 = node(30, 10);
const gate2 = buildAnalyzableState(parseManualInput(input2).value!);
if (!gate2.ok) { line(`重建失败`); process.exit(1); }
const st2 = gate2.state;
const vil2 = st2.players.find((p) => p.id !== st2.userPlayerId && !p.folded)!;
line(`  对手剩余 ${n(vil2.remainingStack, 0)}（他跟平最多只能补这么多）｜最小加注到 ${n(minRaiseTo(st2), 0)}`);

const r2 = analyzeManualHand(input2, OPTIONS);
if (!r2.ok) { line('分析失败'); process.exit(1); }
const DG2 = ((r2.decision as unknown as Record<string, any>)['diagnostics']) as Record<string, any>;
const F2 = ((DG2['postflop'] ?? {})['raiseResponse'] ?? null) as Record<string, any> | null;
const callEV2 = (DG2['math'] as Record<string, any>)['callEV'] as number;
if (F2 === null) { line('  无加注事实'); }
else {
  line(`  模型选中尺寸 = ${n(F2['sizeChips'], 0)}（名义）｜heroAdd ${n(F2['heroAdd'], 0)}｜villainAdd ${n(F2['villainAdd'], 0)}` +
    `（他要补 ${n(F2['villainAddRaw'], 0)}）｜留在池中 ${n(F2['heroContestedAdd'], 0)}｜退回 ${n(F2['uncalledReturn'], 0)}｜终池 ${n(F2['finalPot'], 0)}`);
  line(`  P(弃)/P(跟)/P(再加) = ${n(F2['foldLikelihood'], 6)}/${n(F2['callLikelihood'], 6)}/${n(F2['reRaiseLikelihood'], 6)}` +
    `｜EqVsRaiseCall ${n(F2['heroEquityVsRaiseCallRange'], 6)}｜RAISE EV ${n(F2['raiseEV'], 6)}｜CALL EV ${n(callEV2, 6)}`);
  line('');
  line('  【等价名义金额检验】实际可争夺额相同的不同名义加注额，必须给出相同概率/权益/EV：');
  // 用同一节点把 Hero 的加注额直接换掉：改 seatStacksBB.BTN 会改变 Hero 的封顶，
  // 因此这里改用「Hero 剩余固定、名义加注额不同」的等价手段：只比较模型在同一个
  // 名义尺寸上的输出（见下方脚本 u1-river-multisize-audit 的全量扫描）。
  line('     （见 `scripts/u1-river-multisize-audit.ts`：该节点 120/130/150/174 四个名义金额下');
  line('       heroContestedAdd=34、finalPot=121、villainAdd=14 完全相同 ⇒ 概率/权益/EV 也必须相同）');
}

line('');
line('='.repeat(118));
