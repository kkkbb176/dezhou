/**
 * ============================================================================
 * 河牌多尺寸 EV 与再加注分支 —— **只读**对抗性审计
 * ============================================================================
 *
 * 节点：Hero BTN K♠Q♠｜K♦9♣4♥6♠2♦｜底池 73（含 BB 老周下注 20）｜Hero 剩余 174
 *
 * 本脚本**不修改任何产品代码**，只用生产引擎自己的函数复算：
 *
 * | 用途 | 用的就是产品的哪一个东西 |
 * |---|---|
 * | 合法动作与尺寸网格 | `deriveLegalActions` / `buildSizeGrid`（生产入口内部同一份） |
 * | 权益 | 与 `contextBuilder.rangeEquityOf` **完全相同**的调用：`computeEquity(..., { mode: FAST, seed: equitySeed+1601, iterations: 6000, opponentWeights })` |
 * | 响应概率 | `buildRaiseResponse`（生产模型本体） |
 * | 加注 EV | `raiseEVOf`（生产唯一公式） |
 * | 资金事实 | `committedThisStreet` / `computePot` / `previewCommit` |
 *
 * 因此下表的数字与生产**同源**；唯一差别是生产只对它选中的那一个尺寸算，
 * 而这里把**每一个**合法尺寸都算一遍。
 */
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { buildRaiseResponse, raiseEVOf } from '../src/app/manualInput/raiseResponse.ts';
import { buildBettingRangeFacts } from '../src/app/manualInput/bettingRange.ts';
import { buildSizeGrid, deriveLegalActions } from '../src/app/manualInput/legalActions.ts';
import { parseManualInput, type ManualHandInput } from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import { responseTendenciesOf } from '../src/domain/postflop/betResponse.ts';
import { computeEquity, EquityComputeMode, confidenceHalfWidth } from '../src/domain/poker/equity.ts';
import { computePot, committedThisStreet } from '../src/domain/poker/gameState.ts';
import { previewCommit } from '../src/domain/poker/pots.ts';
import { behaviorProfileOf } from '../src/domain/player/behaviorProfile.ts';
import { quickProfileToLimperArchetype } from '../src/app/manualInput/limpIsolation.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import { ALL_CARDS, parseCardStrict } from '../src/domain/poker/cards.ts';
import type { Card } from '../src/domain/types.ts';
import { buildRangeSnapshot, buildPlayerSnapshot, boardAtStreetOf } from './__shadow-contextBuilder.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const SEED = 20_261_014;
const OPTIONS = {
  rules: RULES, asOf: 1_757_000_000_000, writeLog: false,
  equitySeed: SEED, budget: { softMs: 120_000, hardMs: 240_000 },
} as const;
/** 与 `contextBuilder` 的 `RESPONSE_EQUITY_ITERATIONS` **同一个值** */
const RESPONSE_EQUITY_ITERATIONS = 6000;
/** 与 `contextBuilder` 的 `raiseResponse` 块**同一个种子偏移** */
const EQUITY_SEED_OFFSET = 1601;

const line = (s = ''): void => console.log(s);
const n = (v: unknown, d = 2): string => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : '—');
const pct = (v: unknown, d = 1): string => (typeof v === 'number' && Number.isFinite(v) ? `${(v * 100).toFixed(d)}%` : '—');
const pad = (s: string, w: number): string => {
  const len = [...s].reduce((a, c) => a + (c.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
  return s + ' '.repeat(Math.max(0, w - len));
};

const A = (position: string, type: string, amountBB?: number, street?: string) => ({
  position, type,
  ...(amountBB === undefined ? {} : { amountBB }),
  ...(street === undefined ? {} : { street }),
});

/** 老周的 1200 手统计（未提供的统计一律 null，不编造） */
const LAOZHOU_STATS = {
  handsObserved: 1200, vpip: 0.49, pfr: 0.09, threeBet: 0.03, wtsd: 0.42,
  foldToFlopCBet: 0.23, foldToTurnCBet: 0.19, foldToRiverBet: 0.16,
  flopCheckRaise: null, turnCheckRaise: null, riverCheckRaise: 0.02,
} as const;

/** KQ 节点；`bbStackBB` 用于构造不同筹码深度的场景 */
function kqNode(opts: { bbStackBB?: number; btnStackBB?: number } = {}): ManualHandInput {
  const bbStack = opts.bbStackBB ?? 100;
  const btnStack = opts.btnStackBB ?? 100;
  return {
    tableSize: 6, heroPosition: 'BTN', heroCards: ['Ks', 'Qs'],
    board: ['Kd', '9c', '4h', '6s', '2d'], street: 'RIVER',
    effectiveStackBB: Math.min(bbStack, btnStack), bigBlindBB: 2,
    seatStacksBB: { UTG: btnStack, HJ: btnStack, CO: btnStack, BTN: btnStack, SB: btnStack, BB: bbStack },
    actionHistory: [
      A('UTG', 'FOLD'), A('HJ', 'FOLD'), A('CO', 'FOLD'), A('BTN', 'RAISE', 3), A('SB', 'FOLD'), A('BB', 'CALL', 2),
      A('BB', 'CHECK', undefined, 'FLOP'), A('BTN', 'BET', 2.5, 'FLOP'), A('BB', 'CALL', 2.5, 'FLOP'),
      A('BB', 'CHECK', undefined, 'TURN'), A('BTN', 'BET', 7.5, 'TURN'), A('BB', 'CALL', 7.5, 'TURN'),
      A('BB', 'BET', 10, 'RIVER'),
    ],
    environment: 'MID_LOW_STAKES',
    villain: {
      playerId: '老周', quickProfile: 'CALLING_STATION', dynamicHint: 'UNKNOWN', stackBB: bbStack,
      observedStats: LAOZHOU_STATS,
    },
  } as unknown as ManualHandInput;
}

/* ============================================================
 * A. 生产调用链（从生产输出反读，不靠推断）
 * ============================================================ */

const decided = analyzeManualHand(kqNode(), OPTIONS);
if (!decided.ok) { line(`分析失败：${decided.stage} ${JSON.stringify(decided.issues)}`); process.exit(1); }
const D = decided.decision as unknown as Record<string, any>;
const DG = D['diagnostics'] as Record<string, any>;
const M = DG['math'] as Record<string, any>;
const PF = (DG['postflop'] ?? {}) as Record<string, any>;
const PROD_FACTS = (PF['raiseResponse'] ?? null) as Record<string, any> | null;

line('='.repeat(126));
line(' A. 生产调用链（本节点实测）');
line('='.repeat(126));
line(`  legalActions = ${JSON.stringify(DG['legalActions'])}｜allInToAmount = ${n((DG['actionShape'] ?? {})['allInToAmount'], 0)}`);
line(`  math: pot = ${n(M['pot'], 0)}｜callCost = ${n(M['callCost'], 0)}｜myRemainingStack = ${n(M['myRemainingStack'], 0)}｜myCommittedThisStreet = ${n(M['myCommittedThisStreet'], 0)}`);
line(`  math: winnable = ${n(M['winnable'], 0)}（= previewCommit(hero, callCost).winnable）｜requiredEquity = ${n(M['requiredEquity'], 6)}｜callEV = ${n(M['callEV'], 6)}`);
line(`  math: heroEquityVsBetRange = ${n(M['heroEquityVsBetRange'], 6)}｜heroEquity（整体）= ${n(M['heroEquity'], 6)}`);
line(`  最终动作 = ${String(D['action'])}${D['sizeChips'] == null ? '' : ` @ ${n(D['sizeChips'], 0)}`}｜来源 = ${String((DG['decisionSource'] ?? {})['kind'])}`);
line(`  生产评估的加注尺寸 = ${PROD_FACTS === null ? '—' : n(PROD_FACTS['sizeChips'], 0)}｜RAISE EV = ${PROD_FACTS === null ? '—' : n(PROD_FACTS['raiseEV'], 6)}`);
line(`  未评估的加注金额 = ${((DG['unevaluatedActions'] ?? []) as Record<string, any>[]).map((u) => `${String(u['action'])}@${String(u['sizeChips'])}`).join('、')}`);
line('');

/* ============================================================
 * B/C. 候选尺寸完整性 + 逐尺寸资金流 / 权益 / 响应 / EV
 * ============================================================ */

const parsed = parseManualInput(kqNode());
if (!parsed.ok) { line(`解析失败：${JSON.stringify(parsed.issues)}`); process.exit(1); }
const gate = buildAnalyzableState(parsed.value);
if (!gate.ok) { line(`重建失败：${JSON.stringify(gate.issues)}`); process.exit(1); }
const state = gate.state;
const board: Card[] = (kqNode().board as string[]).map(parseCardStrict);
const hero = state.players.find((p) => p.id === state.userPlayerId)!;
const villain = state.players.find((p) => p.id !== state.userPlayerId && !p.folded)!;
const currentPot = computePot(state);
const heroStreetCommitted = committedThisStreet(state, hero.id);
const villainStreetCommitted = committedThisStreet(state, villain.id);
const toCall = Math.max(0, state.currentBet - heroStreetCommitted);
/** 最小加注到 = 当前注 + 上一次加注额；本节点此前只有一次下注 ⇒ 最小加注到 = 2×当前注 */
const minRaiseTo = state.currentBet + state.currentBet;
/** 引擎自己的网格（生产就是用它 + `closestSizeTo`）—— 用**引擎自己的**合法动作推导，不手搓 */
const legal = deriveLegalActions(state, hero);
const grid = buildSizeGrid(legal, currentPot, 'RAISE');
const trend = responseTendenciesOf(
  (buildPlayerSnapshot(villain.id as never, undefined as never, 'CALLING_STATION' as never, 'UNKNOWN' as never,
    (s: never) => boardAtStreetOf(state, s)).tendency?.dimension.dimensions ?? null) as never,
  buildPlayerSnapshot(villain.id as never, undefined as never, 'CALLING_STATION' as never, 'UNKNOWN' as never,
    (s: never) => boardAtStreetOf(state, s)).confidence,
  null,
);
const pb = buildPlayerSnapshot(villain.id as never, undefined as never, 'CALLING_STATION' as never, 'UNKNOWN' as never,
  (s: never) => boardAtStreetOf(state, s));
let betIndex = -1;
for (let i = state.actions.length - 1; i >= 0; i -= 1) {
  const a = state.actions[i]!;
  if (a.street === state.street && (a.type === 'BET' || a.type === 'RAISE' || a.type === 'RERAISE' || a.type === 'ALL_IN')) { betIndex = i; break; }
}
const rangeBuilt = buildRangeSnapshot(state, villain as never, [...hero.holeCards!, ...board] as never, undefined,
  pb.tendency as never, { archetype: quickProfileToLimperArchetype('CALLING_STATION'), confidence: pb.confidence } as never,
  (behaviorProfileOf({ playerId: villain.id, archetype: 'CALLING_STATION' as never }) ?? null) as never, betIndex);
const arrival = (rangeBuilt.rangeBeforeAction ?? rangeBuilt.range)!;
const betFacts = buildBettingRangeFacts({
  arrivalEntries: arrival.entries.map((e: any) => ({ cardIndices: e.combo.cardIndices, probability: e.probability })),
  board, heroHole: hero.holeCards!, potChips: currentPot - state.currentBet, betChips: state.currentBet,
  street: 'RIVER', tendencies: trend,
});
if (betFacts === null) { line('拿不到下注范围 ⇒ 无法继续'); process.exit(1); }

const allInTo = hero.remainingStack + heroStreetCommitted;

/**
 * 用**生产同一套**方法算一个尺寸的全部量。
 * 返回 `null` 表示该尺寸非法或模型返回 null。
 */
function evaluateSize(raiseTo: number, withEquity: boolean) {
  if (raiseTo < minRaiseTo - 1e-9 || raiseTo > allInTo + 1e-9) return null;
  const heroAdd = raiseTo - heroStreetCommitted;
  const villainRemaining = villain.remainingStack;
  const villainAdd = Math.min(raiseTo - villainStreetCommitted, villainRemaining);
  const villainStreetTotalAfter = villainStreetCommitted + villainAdd;
  const heroContestedAdd = Math.max(0, Math.min(heroAdd, villainStreetTotalAfter - heroStreetCommitted));
  const finalPot = currentPot + heroContestedAdd + villainAdd;
  const heroIsAllIn = raiseTo >= allInTo - 1e-9;
  const res = buildRaiseResponse({
    betRangeEntries: betFacts.entries, board, currentPot, heroAdd, villainAdd, heroContestedAdd, finalPot,
    street: 'RIVER', tendencies: trend, heroIsAllIn,
  });
  if (res === null) return null;
  let eq: number | null = null;
  let method = 'SKIPPED';
  let iterations = 0;
  let halfWidth: number | null = null;
  if (withEquity) {
    const out = computeEquity(hero.holeCards!, board,
      [{ label: 'RAISE 跟注桶（生产同源）', combos: res.callContinueEntries.map((e) => [ALL_CARDS[e.cardIndices[0]]!, ALL_CARDS[e.cardIndices[1]]!] as const) }],
      {
        mode: EquityComputeMode.FAST,
        seed: (OPTIONS.equitySeed ?? 20260913) + EQUITY_SEED_OFFSET,
        iterations: RESPONSE_EQUITY_ITERATIONS,
        opponentWeights: [res.callContinueEntries.map((e) => e.probability)],
      });
    if (out.ok) {
      eq = out.result.equity;
      method = String(out.result.method ?? '—');
      iterations = Number(out.result.iterations ?? 0);
      if (method === 'MONTE_CARLO') {
        const hw = confidenceHalfWidth(out.result);
        halfWidth = typeof hw === 'number' ? hw : null;
      }
    }
  }
  const ev = eq === null ? null : raiseEVOf({
    foldLikelihood: res.foldLikelihood, callLikelihood: res.callLikelihood, reRaiseLikelihood: res.reRaiseLikelihood,
    currentPot, heroContestedAdd, finalPot, equityVsRaiseCall: eq,
  });
  /* 对手能否合法再加注：最小再加注到 = R + (R − 当前注)，他需要 (最小再加注到 − 他已投) 筹码 */
  const minReRaiseTo = raiseTo + (raiseTo - state.currentBet);
  const villainChipsForMinReRaise = minReRaiseTo - villainStreetCommitted;
  const villainCanRaise = villainRemaining >= villainChipsForMinReRaise - 1e-9;
  const villainAllInByCalling = villainAdd >= villainRemaining - 1e-9;
  return {
    raiseTo, heroAdd, villainAdd, heroContestedAdd, finalPot, heroIsAllIn,
    f: res.foldLikelihood, c: res.callLikelihood, rr: res.reRaiseLikelihood,
    price: res.model.priceRequiredEquity, eq, method, iterations, halfWidth, ev,
    minReRaiseTo, villainChipsForMinReRaise, villainCanRaise, villainAllInByCalling,
    callCombos: res.callCombos, reachableCombos: res.reachableCombos,
  };
}

const gridSizes = grid.map((o) => o.toAmount).filter((x) => x >= minRaiseTo - 1e-9).sort((a, b) => a - b);

line('='.repeat(126));
line(' B/C. 逐尺寸资金流与 EV（**与生产同源**：同一模型、同一范围、同一权益调用、同一种子）');
line('='.repeat(126));
line(`  底池 currentPot = ${n(currentPot, 0)}｜Hero 本街已投 ${n(heroStreetCommitted, 0)}｜Hero 剩余 ${n(hero.remainingStack, 0)}｜allInTo = ${n(allInTo, 0)}`);
line(`  对手本街已投 ${n(villainStreetCommitted, 0)}｜对手剩余 ${n(villain.remainingStack, 0)}｜跟注需补 ${n(toCall, 0)}｜最小加注到 ${n(minRaiseTo, 0)}`);
line(`  下注范围组合数 ${betFacts.entries.length}｜倾向 callScale=${n((trend as any).callScale, 3)} foldScale=${n((trend as any).foldScale, 3)} raiseScale=${n((trend as any).raiseScale, 3)}`);
line(`  生产网格（buildSizeGrid）= ${gridSizes.join('、')}｜全量合法区间 = [${n(minRaiseTo, 0)}, ${n(allInTo, 0)}] 共 ${Math.floor(allInTo - minRaiseTo) + 1} 个整数金额`);
line('');
line('  ' + pad('加注至', 8) + pad('我方新增', 9) + pad('他补', 7) + pad('终池', 8) + pad('价格', 8) +
  pad('P(弃)', 8) + pad('P(跟)', 8) + pad('P(再加)', 9) + pad('EqVsRaiseCall', 14) + pad('RAISE EV', 11) +
  pad('他能否再加注', 15) + '权益方法');
line('  ' + '-'.repeat(122));
const t0 = Date.now();
let gridRows: ReturnType<typeof evaluateSize>[] = [];
for (const size of gridSizes) {
  const r = evaluateSize(size, true);
  if (r === null) { line('  ' + pad(String(size), 8) + '（模型返回 null / 非法）'); continue; }
  gridRows.push(r);
  const isProd = PROD_FACTS !== null && Math.abs(size - (PROD_FACTS['sizeChips'] as number)) < 1e-9;
  line('  ' + pad(String(size), 8) + pad(n(r.heroAdd, 0), 9) + pad(n(r.villainAdd, 0), 7) + pad(n(r.finalPot, 0), 8) +
    pad(n(r.price, 4), 8) + pad(pct(r.f, 1), 8) + pad(pct(r.c, 1), 8) + pad(pct(r.rr, 1), 9) +
    pad(n(r.eq, 4), 14) + pad(n(r.ev, 2), 11) +
    pad(r.villainCanRaise ? '能' : (r.villainAllInByCalling ? '**不能（他全下）**' : '不能'), 15) +
    `${r.method}(${r.iterations})` + (isProd ? ' ← 生产选中' : ''));
}
const tGrid = Date.now() - t0;

/* ---- 全量扫描（每个整数金额），用于回答「候选集合是否完整决策空间」 ---- */
const t1 = Date.now();
const full: NonNullable<ReturnType<typeof evaluateSize>>[] = [];
for (let to = Math.ceil(minRaiseTo); to <= Math.floor(allInTo); to += 1) {
  const r = evaluateSize(to, true);
  if (r !== null && r.ev !== null) full.push(r);
}
const tFull = Date.now() - t1;
const best = full.reduce((a, b) => (b.ev! > a.ev! ? b : a), full[0]!);
const bestGrid = gridRows.filter((r) => r.ev !== null).reduce((a, b) => (b.ev! > a.ev! ? b : a));
const callEV = M['callEV'] as number;
const band = 0.05 * (M['winnable'] as number);
line('  ' + '-'.repeat(122));
line(`  全量扫描：${full.length} 个合法整数金额｜最高 RAISE EV = ${n(best.ev, 2)}（加注至 ${best.raiseTo}）｜耗时 ${tFull} ms（网格表 ${tGrid} ms）`);
line(`  网格内最高：${n(bestGrid.ev, 2)}（加注至 ${bestGrid.raiseTo}）｜生产选中：${n(PROD_FACTS?.['raiseEV'], 2)}（加注至 ${n(PROD_FACTS?.['sizeChips'], 0)}）`);
line(`  CALL EV = ${n(callEV, 2)}｜跨动作容差带 ±${n(band, 2)}`);
line(`  ⇒ 超过 CALL EV 的尺寸个数：${full.filter((r) => r.ev! > callEV).length}／${full.length}；` +
  `超过 CALL EV 且**超出容差带**（> CALL+band）的尺寸个数：${full.filter((r) => r.ev! > callEV + band).length}`);
const monteCarlo = full.filter((r) => r.method === 'MONTE_CARLO');
line(`  ⇒ 权益方法：EXACT ${full.filter((r) => r.method === 'EXACT').length} 个｜MONTE_CARLO ${monteCarlo.length} 个｜` +
  (monteCarlo.length === 0
    ? '**本节点全部为确定性枚举 ⇒ 无抽样误差**'
    : `抽样半宽约 ±${n(monteCarlo[0]!.halfWidth, 4)}（${monteCarlo[0]!.iterations} 次）`));
line('');

/* ============================================================
 * D. 再加注分支：合法性 vs 模型假设
 * ============================================================ */

line('='.repeat(126));
line(' D. 再加注分支（模型假设 vs 引擎合法规则）');
line('='.repeat(126));
const rrRows = full.filter((r) => r.rr > 1e-12);
/**
 * ⚠️ **先纠正我自己上一版的误判**：`villainCanRaise`（按最小加注规则）
 * 为 false **不等于**「他不能加注」——**不足最小加注的全下仍然合法**
 *（`canRaise` 的判据是「加注权未被关闭」，见 `engine.ts`；
 * `buildSizeGrid` 也**无条件**保留 `maxTo`）。
 * 因此本节点上「他筹码不够做完整再加注」只意味着他只能**全下（under-raise）**，
 * 而不是「这个分支不可能存在」。
 */
const fullRaiseOk = full.filter((r) => r.villainCanRaise);
const shortShoveOnly = full.filter((r) => !r.villainCanRaise && !r.villainAllInByCalling);
const villainAllInByCallingRows = full.filter((r) => r.villainAllInByCalling);
line(`  生成 P(再加注) > 0 的尺寸：${rrRows.length}／${full.length}（只有 Hero 全下那个尺寸为 0）`);
line(`  · 能做**完整**再加注（≥ 最小加注额）的尺寸：${fullRaiseOk.length} 个（加注至 ≤ ${n(fullRaiseOk[fullRaiseOk.length - 1]?.raiseTo, 0)}）`);
line(`  · 只能**全下（under-raise，低于最小加注）**的尺寸：${shortShoveOnly.length} 个` +
  (shortShoveOnly.length > 0 ? `（加注至 ${n(shortShoveOnly[0]!.raiseTo, 0)} … ${n(shortShoveOnly[shortShoveOnly.length - 1]!.raiseTo, 0)}）` : ''));
line(`  · 跟注即全下（连跟注都投光）的尺寸：${villainAllInByCallingRows.length} 个` +
  (villainAllInByCallingRows.length > 0
    ? `（加注至 ${villainAllInByCallingRows.map((r) => n(r.raiseTo, 0)).join('、')}）—— 这些尺寸 Hero 也恰好是全下 ⇒ P(再加注) = 0`
    : ''));
line('  ⇒ **结论（已纠正）**：本节点**没有**「分支非法」的情形；真正的缺陷是**分支语义太粗**：');
line('     模型把「他全下 under-raise」与「他做完整的再加注」合并成一个桶，并且在两种情形下都假定 **Hero 必然弃牌**。');
line('');

/*
 * D-2：**Hero 面对「他全下 under-raise」时其实只需要补很少的筹码** —— 量化这个简化值多少。
 *
 * 例：加注至 120 时他的全下 = 174（他本街总额），Hero 只需再补 174 − 120 = 54，
 * 而终池会是 73 + 174 + 174 = 421 ⇒ 跟注只需要 54/421 = 12.8% 权益。
 * 模型却按「弃牌、损失全部 120」计入。
 */
line('  D-2. 被再加注分支的真实选择权（Hero 其实可以跟注这个 under-raise）');
line('  ' + pad('加注至', 8) + pad('他的全下', 9) + pad('Hero 还要补', 12) + pad('终池', 8) + pad('跟注只需权益', 13) +
  pad('模型记的损失', 13) + '说明');
line('  ' + '-'.repeat(104));
for (const r of [40, 60, 80, 100, 120, 160].map((x) => full.find((f) => f.raiseTo === x)).filter(Boolean) as NonNullable<ReturnType<typeof evaluateSize>>[]) {
  const villainShove = villainStreetCommitted + villain.remainingStack; // 他全下的本街总额
  const callMore = Math.max(0, villainShove - r.heroContestedAdd);
  const potAfter = currentPot + villainShove + Math.min(villainShove, r.heroContestedAdd + callMore);
  const needEq = potAfter > 0 ? callMore / potAfter : 0;
  line('  ' + pad(String(r.raiseTo), 8) + pad(n(villainShove, 0), 9) + pad(n(callMore, 0), 12) + pad(n(potAfter, 0), 8) +
    pad(pct(needEq, 1), 13) + pad(`−${n(r.heroContestedAdd, 0)}`, 13) +
    `P(再加注) ${pct(r.rr, 1)} × ${n(r.heroContestedAdd, 0)} = ${n(-r.rr * r.heroContestedAdd, 1)} 筹码`);
}
line('');
line('  ⇒ 该分支在**每个可加注尺寸**上都是 −我方投入（假定弃牌），而真实的后续是「补一小笔跟注」；');
line('     因此 RAISE EV 是**宽松下界**（方向偏保守，但量级可达数十筹码，见上表）。');
line('');

/* ============================================================
 * E. 同一口径核验（Task D）
 * ============================================================ */

line('='.repeat(126));
line(' E. 统一 EV 口径核验（Task D）');
line('='.repeat(126));
const heroPreview = previewCommit(state, hero.id, toCall).winnable;
line(`  ① 同一节点：全部量取自同一次决策（底池 ${n(currentPot, 0)} = math.pot ${n(M['pot'], 0)} ⇒ ${currentPot === M['pot'] ? '✔ 一致' : '✖ 不一致'}）`);
line(`  ② CALL 口径独立复算：EqVsBetRange × (pot + callCost) − callCost = ${n((M['heroEquityVsBetRange'] as number) * (currentPot + toCall) - toCall, 6)} vs 产品 ${n(callEV, 6)}`);
line(`  ③ CALL 的 winnable 独立复算：previewCommit(hero, callCost).winnable = ${n(heroPreview, 0)} vs math.winnable ${n(M['winnable'], 0)}`);
const prodRow = gridRows.find((r) => PROD_FACTS !== null && Math.abs(r.raiseTo - (PROD_FACTS['sizeChips'] as number)) < 1e-9);
line(`  ④ RAISE 口径独立复算（同源）：加注至 ${prodRow === undefined ? '—' : n(prodRow.raiseTo, 0)} ⇒ ${n(prodRow?.ev, 6)} vs 产品 ${n(PROD_FACTS?.['raiseEV'], 6)}｜差 ${n(Math.abs((prodRow?.ev ?? NaN) - (PROD_FACTS?.['raiseEV'] as number)), 12)}`);
line(`  ⑤ 终池恒等式：${n(PROD_FACTS?.['finalPot'], 0)} = ${n(PROD_FACTS?.['currentPot'], 0)} + ${n(PROD_FACTS?.['heroContestedAdd'], 0)} + ${n(PROD_FACTS?.['villainAdd'], 0)}`);
line(`  ⑥ 退回：uncalledReturn = ${n(PROD_FACTS?.['uncalledReturn'], 0)} = heroAdd ${n(PROD_FACTS?.['heroAdd'], 0)} − 留在池中 ${n(PROD_FACTS?.['heroContestedAdd'], 0)}`);
line(`  ⑦ 概率归一：P(弃)+P(跟)+P(再加注) = ${n((PROD_FACTS?.['foldLikelihood'] as number) + (PROD_FACTS?.['callLikelihood'] as number) + (PROD_FACTS?.['reRaiseLikelihood'] as number), 12)}`);
line(`  ⑧ 精度差异：CALL = ${String((DG['actionEvidence'] as Record<string, any>[]).find((e) => e['action'] === 'CALL')?.['estimateType'])}（代理，未建模对手弃牌率）；` +
  `RAISE = ${String((DG['actionEvidence'] as Record<string, any>[]).find((e) => e['action'] === 'RAISE')?.['estimateType'])}（模型）；两者**不是同一精度**，容差带 ±${n(band, 2)} 只覆盖模型不确定性的一部分`);
line(`  ⑨ 生产选中的尺寸 ${n(PROD_FACTS?.['sizeChips'], 0)} 是**启发式**（desiredTo = pot + 2×call = ${n(currentPot + 2 * toCall, 0)} 的最近网格点），不是 EV 最优：全量最优 ${n(best.ev, 2)}@${best.raiseTo}`);
line('');
line(`  耗时：网格 ${tGrid} ms｜全量 ${tFull} ms（${full.length} 个尺寸，每个都要枚举一次跟注桶权益）`);
line('='.repeat(126));
