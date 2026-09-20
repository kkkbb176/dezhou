/**
 * AK 节点 —— **候选动作逐个核查**（只读）
 *
 * 6 人桌｜盲注 1/2｜有效起始筹码 200｜Hero BTN A♠K♠｜K♦9♣4♥6♠2♦
 * 翻前 6／翻牌 5／转牌 15／河牌 BB 领打 40｜底池 93｜Hero 剩余 174
 * 对手画像：Calling Station（纯标签、无实测统计）
 *
 * 逐个候选输出：节点增量 EV / 条件权益 / 是否存在该金额的真实 EV / 全下保护是否生效。
 *
 * ⚠️ 凡标注「审计重建」的数字**不是产品输出** —— 产品对加注没有任何 EV 模型。
 */
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';
import { parseManualInput } from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import { buildBettingRangeFacts } from '../src/app/manualInput/bettingRange.ts';
import { classifyResponse, responseTendenciesOf } from '../src/domain/postflop/betResponse.ts';
import { archetypeDimensionsOf } from '../src/domain/player/archetypeDimensions.ts';
import { behaviorProfileOf } from '../src/domain/player/behaviorProfile.ts';
import { quickProfileToLimperArchetype } from '../src/app/manualInput/limpIsolation.ts';
import { boardRelativeTierOf } from '../src/domain/poker/boardRelativeStrength.ts';
import { boardWetnessOf } from '../src/domain/postflop/rangeCompression.ts';
import { compareHands, evaluateCards } from '../src/domain/poker/handEval.ts';
import { computeEquity, EquityComputeMode } from '../src/domain/poker/equity.ts';
import { computePot } from '../src/domain/poker/gameState.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import { ALL_CARDS, type Card } from '../src/domain/types.ts';
import { buildRangeSnapshot, buildPlayerSnapshot, boardAtStreetOf } from './__shadow-contextBuilder.ts';
import { akInput } from './rrda-lib.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const SEED = 20_261_014;
const OPTIONS = { rules: RULES, asOf: 1_757_000_000_000, writeLog: false, equitySeed: SEED, budget: { softMs: 120_000, hardMs: 240_000 } } as const;
const line = (s = ''): void => console.log(s);
const num = (v: unknown, d = 6): string => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : String(v));
const pct = (v: unknown, d = 2): string => (typeof v === 'number' && Number.isFinite(v) ? `${(v * 100).toFixed(d)}%` : '—');
const pad = (s: string, n: number): string => {
  const w = [...s].reduce((a, c) => a + (c.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
  return s + ' '.repeat(Math.max(0, n - w));
};

const PROFILE = 'CALLING_STATION';
const input = akInput(20, PROFILE);   // = 盲注 1/2、200 筹码、BTN A♠K♠、河牌 40

const r = analyzeManualHand(input, OPTIONS);
if (!r.ok) throw new Error(`${r.stage}`);
const d = r.decision as unknown as Record<string, any>;
const diag = d['diagnostics'] as Record<string, any>;
const m = diag['math'] as Record<string, any>;
const shape = diag['actionShape'] as Record<string, any>;
const guard = diag['allInGuard'] as Record<string, any>;
const evidence = (diag['actionEvidence'] ?? []) as any[];
const candidates = (diag['candidates'] ?? []) as any[];

line('='.repeat(118));
line(' 节点冻结：6 人桌 1/2｜有效筹码 200｜Hero BTN A♠K♠｜K♦9♣4♥6♠2♦｜BB 河牌领打 40｜画像 Calling Station（纯标签）');
line('='.repeat(118));
line(`  底池 ${num(m['pot'], 2)}｜需跟 ${num(m['callCost'], 2)}｜可争夺量 winnable ${num(m['winnable'], 2)}｜所需权益 ${num(m['requiredEquity'], 6)}`);
line(`  Hero 剩余 ${num(m['myRemainingStack'], 2)}｜加注上限 allInToAmount ${num(shape['allInToAmount'], 2)}｜最大加注增量 ${num((shape['allInToAmount'] as number) - (m['callCost'] as number), 2)}`);
line(`  手牌类别 handCategory = ${String(guard['handCategory'])}（一对）｜SPR = ${num(guard['spr'], 3)}｜stackOffAllowed = ${String(guard['stackOffAllowed'])}`);
line('');

/* ============================================================
 * 一、逐个候选动作核查
 * ============================================================ */
line('='.repeat(118));
line(' 一、候选动作逐个核查（数字全部来自生产决策链）');
line('='.repeat(118));
line(pad('候选动作', 20) + pad('raise-to', 10) + pad('增量', 10) + pad('引擎 EV', 16) + pad('证据类型', 30) + pad('打光筹码?', 12) + '全下保护');
for (const c of candidates) {
  const size = typeof c['sizeChips'] === 'number' ? c['sizeChips'] : null;
  const inc = size === null ? null : size - (m['callCost'] as number);
  const isRaiseLike = String(c['action']) === 'RAISE' || String(c['action']) === 'ALL_IN';
  const isAllIn = size !== null && Math.abs(size - (shape['allInToAmount'] as number)) < 1e-9;
  const evText = c['ev'] === null ? 'null（NOT_IMPLEMENTED）' : num(c['ev'], 4);
  const evKind = isRaiseLike
    ? (c['ev'] === null ? 'HEURISTIC（无 EV 模型）' : '有 EV')
    : (String(c['action']) === 'FOLD' ? 'EXACT（定义）' : 'PROXY_EV');
  const guardText = !isRaiseLike
    ? '—'
    : isAllIn
      ? `**生效**（一对牌 + 打光 + 无自有 EV）`
      : '不适用（不是全下）';
  line(pad(String(c['action']), 20) + pad(size === null ? '—' : num(size, 2), 10) + pad(inc === null ? '—' : num(inc, 2), 10) +
    pad(evText, 16) + pad(evKind, 30) + pad(isRaiseLike ? String(isAllIn) : '—', 12) + guardText);
}
line('');
line('  引擎实际选中：' + String(d['action']) + (d['sizeChips'] === undefined ? '' : ` ${num(d['sizeChips'], 2)}`) +
  `｜动作形态 ${String(shape['kind'])}｜consumesStack=${String(shape['consumesStack'])}`);
line(`  ⇒ ${String(shape['noteZh'])}`);
line('');

/* ============================================================
 * 二、FOLD
 * ============================================================ */
line('-' .repeat(118));
line(' FOLD —— 节点增量 EV = 0');
line('-' .repeat(118));
const foldEv = evidence.find((e) => e['action'] === 'FOLD');
line(`  EV = ${num(foldEv?.['ev'], 6)}（estimateType = ${String(foldEv?.['estimateType'])}）`);
line(`  口径：节点增量。已投入的 ${num(m['myCommittedThisStreet'], 2)}（本街）+ 前面街的筹码都是**沉没成本**，`);
line(`        因此弃牌的未来收益恒为 0 —— 它是 CALL / RAISE 的比较零点。`);
line('');

/* ============================================================
 * 三、CALL 40
 * ============================================================ */
line('-'.repeat(118));
line(' CALL 40 —— 对 Villain Bet Range 的权益与 CALL EV');
line('-'.repeat(118));
const call = evidence.find((e) => e['action'] === 'CALL');
const cond = diag['conditionalEquities'] as Record<string, any>;
line(`  条件权益 EqVsBetRange（P(手牌 | 他选择下注 40)）     = ${num(cond['betRange'], 6)}`);
line(`  参考口径 EqVsArrivalRange（下注**前**的到达范围）     = ${num(cond['arrivalRange'], 6)}`);
line(`  参考口径 math.heroEquity（本手全部动作的后验）        = ${num(cond['wholeRange'], 6)}`);
line(`  加注继续范围 EqVsRaiseContinueRange                  = ${String(cond['raiseContinueRange'])}`);
line('');
line(`  CALL EV = EqVsBetRange × winnable − callCost`);
line(`          = ${num(cond['betRange'], 6)} × ${num(m['winnable'], 2)} − ${num(m['callCost'], 2)}`);
line(`          = ${num((cond['betRange'] as number) * (m['winnable'] as number), 6)} − ${num(m['callCost'], 2)}`);
line(`          = **${num(call?.['ev'], 6)}**（与 math.callEV 逐位一致：${num(m['callEV'], 6)}）`);
line(`  决策边际 = ${String(call?.['decisionMargin'])}｜容差带 ±${num(diag['decisionMargin']?.['bandChips'], 4)}（= 0.05 × ${num(m['winnable'], 2)}）`);
line(`  所需权益 ${num(m['requiredEquity'], 6)} vs 实际 ${num(cond['betRange'], 6)} ⇒ 领先 ${((cond['betRange'] as number) - (m['requiredEquity'] as number)).toFixed(4)}`);
line('');

/* ============================================================
 * 四、三个加注金额：是否存在真实 EV
 * ============================================================ */
line('-'.repeat(118));
line(' RAISE 至 80 / 120 / ALL-IN 174 —— 是否存在该金额对应的**真实 EV**');
line('-'.repeat(118));
line('  产品答案：**三个金额都没有 EV**。产品里只有一条 `RAISE` 证据行，');
line('  它的 `estimateType = HEURISTIC`、`ev = null`，且假设里写明「缺 fold-to-3bet / call-3bet / 4bet 响应数据 ⇒ EV 不可得」。');
line('  ⇒ 加注的 EV **不随金额变化**，因为对任何金额它都**不存在**（不是「金额不同所以 EV 不同」）。');
line('');
line(`  未评估动作清单（§三披露）：`);
for (const u of (diag['unevaluatedActions'] ?? []) as any[]) {
  line(`    · ${String(u['action'])} size=${num(u['sizeChips'], 2)}｜${String(u['reasonCode'])}`);
}
line('');
line('  各金额的全下保护判定（规则：一对牌 + 真正打光筹码 + 无自有 EV ⇒ 拦截）：');
line(pad('    raise-to', 14) + pad('增量', 10) + pad('打光筹码?', 12) + pad('保护是否生效', 20) + '说明');
for (const size of [80, 120, 174]) {
  const inc = size - (m['callCost'] as number);
  const isAllIn = Math.abs(size - (shape['allInToAmount'] as number)) < 1e-9;
  const blocked = isAllIn && (guard['handCategory'] as number) < (guard['minCategoryForLargeRaise'] as number) && guard['hasOwnEV'] !== true;
  line(pad(`    ${size}`, 14) + pad(num(inc, 2), 10) + pad(String(isAllIn), 12) + pad(blocked ? '**生效（拦截）**' : '不适用', 20) +
    (isAllIn
      ? `raise-to = allInToAmount ⇒ 打光判定为真；类别 ${String(guard['handCategory'])} < ${String(guard['minCategoryForLargeRaise'])}；无自有 EV`
      : `raise-to < allInToAmount ⇒ **不是全下**；保护不拦（但它同样没有 EV，因此也不能覆盖清晰的 CALL）`));
}
line('');
line(`  选中金额的来源：价值加注目标 = pot + 2×callCost = ${num(m['pot'], 2)} + 2×${num(m['callCost'], 2)} = ${num((m['pot'] as number) + 2 * (m['callCost'] as number), 2)}`);
line(`  ⇒ 落到最近的合法候选 = 174（= allInToAmount）⇒ 引擎想加注时默认就是全下；保护正是为此命中。`);
line('');

/* ============================================================
 * 五、审计重建（非产品输出）
 * ============================================================ */
line('='.repeat(118));
line(' 五、审计重建：如果补上「面对加注的响应」，三个金额的 RAISE EV 会是多少（**不是产品输出**）');
line('='.repeat(118));
{
  const parsed = parseManualInput(input);
  if (!parsed.ok) throw new Error('parse');
  const gate = buildAnalyzableState(parsed.value);
  if (!gate.ok) throw new Error('gate');
  const state = gate.state;
  const board: Card[] = ALL_CARDS.filter((c) =>
    ['Kd', '9c', '4h', '6s', '2d'].includes(`${'23456789TJQKA'[c.rank - 2]}${c.suit}`));
  const hero = state.players.find((p) => p.id === state.userPlayerId)!;
  const heroHole = hero.holeCards!;
  const heroEval = evaluateCards([...heroHole, ...board]);
  const villain = state.players.find((p) => p.id === 'seat_BB')!;
  const pot = computePot(state);
  const callCost = state.currentBet;
  const pb = buildPlayerSnapshot('seat_BB' as never, undefined as never, PROFILE as never, 'UNKNOWN' as never,
    (s: never) => boardAtStreetOf(state, s));
  let betIndex = -1;
  for (let i = state.actions.length - 1; i >= 0; i -= 1) {
    const a = state.actions[i]!;
    if (a.street === state.street && (a.type === 'BET' || a.type === 'RAISE' || a.type === 'RERAISE' || a.type === 'ALL_IN')) { betIndex = i; break; }
  }
  const build = buildRangeSnapshot(state, villain as never, [...heroHole, ...board] as never, undefined,
    pb.tendency as never, { archetype: quickProfileToLimperArchetype(PROFILE), confidence: pb.confidence } as never,
    (behaviorProfileOf({ playerId: 'seat_BB', archetype: PROFILE as never }) ?? null) as never, betIndex);
  const arrival = (build.rangeBeforeAction ?? build.range)!;
  const tendencies = responseTendenciesOf(pb.tendency === null ? null : (pb.tendency.dimension.dimensions as never), pb.confidence, null);
  const betFacts = buildBettingRangeFacts({
    arrivalEntries: arrival.entries.map((e: any) => ({ cardIndices: e.combo.cardIndices, probability: e.probability })),
    board, heroHole, potChips: pot - callCost, betChips: callCost, street: 'RIVER', tendencies,
  })!;
  const villainBetRange = betFacts.entries;
  const callEV = (cond['betRange'] as number) * (m['winnable'] as number) - (m['callCost'] as number);

  line('  固定：Villain Bet Range（引擎 V2 口径）、Hero 手牌、牌面、底池。只加「他面对该加注金额的响应」。');
  line('  响应模型 = 产品自己的 `classifyResponse`（价格换成各金额的真实赔率）。');
  line('');
  line(pad('  加注至', 12) + pad('他需再投', 12) + pad('面对价格', 12) + pad('P(弃)', 10) + pad('P(跟)', 10) + pad('P(再加)', 10) +
    pad('EqVsRaiseCall', 16) + pad('RAISE EV', 14) + pad('CALL EV', 12) + '结论');
  for (const size of [80, 120, 174]) {
    const inc = size - callCost;
    const price = inc / (pot + 2 * inc);
    const heroIsAllIn = Math.abs(size - (state.players.find((p) => p.id === state.userPlayerId)!.committedByStreet[state.street] + hero.remainingStack)) < 1e-9;
    let foldMass = 0, callMass = 0, raiseMass = 0, total = 0;
    const callEntries: { cardIndices: readonly [number, number]; probability: number }[] = [];
    for (const e of villainBetRange) {
      const hole = [ALL_CARDS[e.cardIndices[0]]!, ALL_CARDS[e.cardIndices[1]]!] as const;
      const cmp = compareHands(evaluateCards([...hole, ...board]), heroEval);
      const versusHero = cmp > 0 ? 'STRONGER' : cmp < 0 ? 'WEAKER' : 'EQUAL';
      const tier = boardRelativeTierOf([hole[0], hole[1]], board) ?? 5;
      const cls = classifyResponse({
        hole: [hole[0], hole[1]], versusHero, tier, street: 'RIVER' as never, cardsToCome: 0,
        ratioToPot: inc / pot, priceRequiredEquity: price, spr: null, opponentCount: 1,
        wetness: boardWetnessOf(board), tendencies, heroIsAllIn, villainDraw: 'NO_DRAW',
      });
      total += e.probability;
      foldMass += e.probability * cls.weights.fold;
      callMass += e.probability * cls.weights.call;
      raiseMass += e.probability * cls.weights.raise;
      if (cls.weights.call > 0) callEntries.push({ cardIndices: e.cardIndices, probability: e.probability * cls.weights.call });
    }
    const pFold = foldMass / total, pCall = callMass / total, pRaise = raiseMass / total;
    const callMassTotal = callEntries.reduce((a, x) => a + x.probability, 0);
    let eqVsCall: number | null = null;
    if (callMassTotal > 0) {
      const norm = callEntries.map((x) => ({ ...x, probability: x.probability / callMassTotal }));
      const out = computeEquity(heroHole, board,
        [{ label: 'raise-call', combos: norm.map((x) => [ALL_CARDS[x.cardIndices[0]]!, ALL_CARDS[x.cardIndices[1]]!] as const) }],
        { mode: EquityComputeMode.FAST, seed: SEED + 977, iterations: 20000, opponentWeights: [norm.map((x) => x.probability)] });
      eqVsCall = out.ok ? out.result.equity : null;
    }
    const finalPot = pot + 2 * inc;
    /* 下界口径：被再加注时按「Hero 损失本次增量」计（产品无再加注树） */
    const ev = pCall === 0 || eqVsCall === null
      ? pFold * pot
      : pFold * pot + pCall * (eqVsCall * finalPot - inc) + pRaise * -inc;
    line(pad(`  ${size}`, 12) + pad(num(inc, 2), 12) + pad(num(price, 4), 12) + pad(num(pFold, 3), 10) + pad(num(pCall, 3), 10) +
      pad(num(pRaise, 3), 10) + pad(eqVsCall === null ? '—' : num(eqVsCall, 4), 16) + pad(num(ev, 2), 14) +
      pad(num(callEV, 2), 12) + (ev > callEV ? '加注更优' : '跟注更优'));
  }
  line('');
  line('  ⚠️ 上表**不是产品输出**：产品没有这个模型（`EqVsRaiseContinueRange = NOT_IMPLEMENTED`）。');
  line('     它只说明「补上这一维之后 EV 会随金额变化」，以及为什么当前必须拒绝把加注说成更优。');
}
line('');

/* ============================================================
 * 六、结论
 * ============================================================ */
line('='.repeat(118));
line(' 六、逐个候选的结论');
line('='.repeat(118));
line(`  FOLD          ：EV = 0（定义）—— 比较零点`);
line(`  CALL 40       ：EV = ${num(call?.['ev'], 6)}（PROXY_EV；EqVsBetRange ${num(cond['betRange'], 6)} × 133 − 40）⇒ **最优的可评估动作**`);
line(`  RAISE 至 80   ：EV = NOT_IMPLEMENTED；不是全下 ⇒ 全下保护不适用；因无 EV 不得覆盖清晰的 CALL`);
line(`  RAISE 至 120  ：EV = NOT_IMPLEMENTED；同上`);
line(`  RAISE ALL-IN 174：EV = NOT_IMPLEMENTED；**全下保护生效并拦截**` +
  `（类别 ${String(guard['handCategory'])} < ${String(guard['minCategoryForLargeRaise'])}、consumesStack=${String(guard['consumesStack'])}、hasOwnEV=${String(guard['hasOwnEV'])}）`);
line('');
line(`  最终动作 = ${String(d['action'])} ${num(d['sizeChips'], 2)}｜来源 = ${String(diag['decisionSource']?.['kind'])}`);
line(`  披露：${((diag['reasons'] ?? []) as any[]).filter((x) => x['code'] === 'RAISE_EV_NOT_IMPLEMENTED').length > 0 ? '已含 RAISE_EV_NOT_IMPLEMENTED 事实理由 ✔' : '（理由在 decision.reasons 中，诊断已含未评估清单）'}｜未评估动作 ${((diag['unevaluatedActions'] ?? []) as any[]).length} 项`);
