/**
 * U1 交叉验证：**方案②（生产·公共信息口径）vs 方案①（既有响应模型）**
 *
 * `reports/UNCERTAINTY_REGISTER.md` 的 U1 要求：
 * 「两者在多个节点上的 RAISE EV 若同号且量级接近，才允许进入生产比较。」
 *
 * 本脚本只读：把方案②（产品现在的 `raiseResponse`）与方案①
 * （产品自己的 `classifyResponse`，价格换成加注赔率）在**同一批节点**上逐条对比。
 */
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';
import { parseManualInput, type ManualHandInput } from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import { buildBettingRangeFacts } from '../src/app/manualInput/bettingRange.ts';
import { classifyResponse, responseTendenciesOf, cardsToComeOf } from '../src/domain/postflop/betResponse.ts';
import { boardRelativeTierOf } from '../src/domain/poker/boardRelativeStrength.ts';
import { compareHands, evaluateCards } from '../src/domain/poker/handEval.ts';
import { computeEquity, EquityComputeMode } from '../src/domain/poker/equity.ts';
import { computePot } from '../src/domain/poker/gameState.ts';
import { behaviorProfileOf } from '../src/domain/player/behaviorProfile.ts';
import { quickProfileToLimperArchetype } from '../src/app/manualInput/limpIsolation.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import { ALL_CARDS, type Card } from '../src/domain/types.ts';
import { buildRangeSnapshot, buildPlayerSnapshot, boardAtStreetOf } from './__shadow-contextBuilder.ts';
import { akInput } from './rrda-lib.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const SEED = 20_261_014;
const OPTIONS = { rules: RULES, asOf: 1_757_000_000_000, writeLog: false, equitySeed: SEED, budget: { softMs: 120_000, hardMs: 240_000 } } as const;
const line = (s = ''): void => console.log(s);
const num = (v: unknown, d = 4): string => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : '—');
const pad = (s: string, n: number): string => {
  const w = [...s].reduce((a, c) => a + (c.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
  return s + ' '.repeat(Math.max(0, n - w));
};
const A = (position: string, type: string, amountBB?: number, street?: string) => ({
  position, type, ...(amountBB === undefined ? {} : { amountBB }), ...(street === undefined ? {} : { street }),
});
const F = (p: string) => A(p, 'FOLD');

/** 节点语料：覆盖河牌 / 转牌 / 不同手牌 / 不同画像 */
type Node = { tag: string; input: ManualHandInput };
const corpus: Node[] = [
  { tag: 'AK 河牌 vs bet40（CS）', input: akInput(20, 'CALLING_STATION') },
  { tag: 'AK 河牌 vs bet40（NORMAL）', input: akInput(20, 'NORMAL') },
  { tag: 'AK 河牌 vs bet40（MANIAC）', input: akInput(20, 'MANIAC') },
  { tag: 'AK 河牌 vs bet8（CS）', input: akInput(4, 'CALLING_STATION') },
  { tag: '99 河牌（暗三条，CS）', input: akInput(20, 'CALLING_STATION', ['9s', '9h']) },
  { tag: 'AJ 河牌（空气，MANIAC）', input: akInput(20, 'MANIAC', ['As', 'Js']) },
  {
    tag: 'TEST 09 节点（Hero BB AJ vs BTN 超池 120%）',
    input: {
      tableSize: 6, heroPosition: 'BB', heroCards: ['As', 'Js'], board: ['Jd', '8c', '4c', '6s', 'Kh'], street: 'RIVER',
      effectiveStackBB: 100, bigBlindBB: 2,
      seatStacksBB: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 },
      actionHistory: [
        F('UTG'), F('HJ'), F('CO'), A('BTN', 'RAISE', 3), F('SB'), A('BB', 'CALL', 2),
        A('BB', 'CHECK', undefined, 'FLOP'), A('BTN', 'BET', 4, 'FLOP'), A('BB', 'CALL', 4, 'FLOP'),
        A('BB', 'CHECK', undefined, 'TURN'), A('BTN', 'BET', 10.5, 'TURN'), A('BB', 'CALL', 10.5, 'TURN'),
        A('BB', 'CHECK', undefined, 'RIVER'), A('BTN', 'BET', 42.5, 'RIVER'),
      ],
      environment: 'MID_LOW_STAKES', villain: { quickProfile: 'MANIAC', dynamicHint: 'UNKNOWN' },
    } as unknown as ManualHandInput,
  },
  {
    tag: 'TEST 4 节点（AA 转牌 vs 冷四注）',
    input: {
      tableSize: 9, heroPosition: 'HJ', heroCards: ['Ac', 'Ad'], board: ['Ks', '8d', '4c', 'Jc'], street: 'TURN',
      effectiveStackBB: 200, seatStacksBB: { UTG: 200, HJ: 200, CO: 200 },
      actionHistory: [
        A('UTG', 'RAISE', 3), F('UTG1'), F('UTG2'), F('LJ'),
        A('HJ', 'RAISE', 10), A('CO', 'RAISE', 26), F('BTN'), F('SB'), F('BB'),
        A('UTG', 'FOLD'), A('HJ', 'CALL', 16),
        A('HJ', 'CHECK', undefined, 'FLOP'), A('CO', 'BET', 40, 'FLOP'), A('HJ', 'CALL', 40, 'FLOP'),
        A('HJ', 'CHECK', undefined, 'TURN'), A('CO', 'BET', 60, 'TURN'),
      ],
      environment: 'MID_LOW_STAKES', villain: { quickProfile: 'NORMAL', dynamicHint: 'UNKNOWN' },
    } as unknown as ManualHandInput,
  },
];

const rankChar = (c: Card): string => `${'23456789TJQKA'[c.rank - 2]}${c.suit}`;
const cardsOfBoard = (input: ManualHandInput): Card[] =>
  (input.board as string[]).map((s) => ALL_CARDS.find((c) => rankChar(c) === s)!);

line('='.repeat(126));
line(' U1 交叉验证：方案②（生产·公共信息：公共强度带）vs 方案①（既有：versusHero + tier）');
line('='.repeat(126));
line(pad('节点', 34) + pad('加注尺寸', 10) + pad('价格', 8) + pad('② 弃/跟/加', 18) + pad('① 弃/跟/加', 18) +
  pad('② RAISE EV', 12) + pad('① RAISE EV', 12) + pad('CALL EV', 10) + '同号?');

let agree = 0;
let total = 0;
let signMismatch: string[] = [];
for (const { tag, input } of corpus) {
  const parsed = parseManualInput(input);
  if (!parsed.ok) { line(`${tag}: PARSE FAIL`); continue; }
  const gate = buildAnalyzableState(parsed.value);
  if (!gate.ok) { line(`${tag}: GATE FAIL ${JSON.stringify(gate.issues[0])}`); continue; }
  const state = gate.state;
  const board = cardsOfBoard(input);
  const hero = state.players.find((p) => p.id === state.userPlayerId)!;
  const heroHole = hero.holeCards!;
  const heroEval = evaluateCards([...heroHole, ...board]);
  const villain = state.players.find((p) => p.id !== state.userPlayerId && !p.folded)!;
  const potPre = computePot(state) - state.currentBet;
  const callCost = state.currentBet;
  const profile = String((input.villain as Record<string, unknown>)?.quickProfile ?? 'NORMAL');

  const pb = buildPlayerSnapshot(villain.id as never, undefined as never, profile as never, 'UNKNOWN' as never,
    (s: never) => boardAtStreetOf(state, s));
  let betIndex = -1;
  for (let i = state.actions.length - 1; i >= 0; i -= 1) {
    const a = state.actions[i]!;
    if (a.street === state.street && (a.type === 'BET' || a.type === 'RAISE' || a.type === 'RERAISE' || a.type === 'ALL_IN')) { betIndex = i; break; }
  }
  const build = buildRangeSnapshot(state, villain as never, [...heroHole, ...board] as never, undefined,
    pb.tendency as never, { archetype: quickProfileToLimperArchetype(profile), confidence: pb.confidence } as never,
    (behaviorProfileOf({ playerId: villain.id, archetype: profile as never }) ?? null) as never, betIndex);
  const arrival = (build.rangeBeforeAction ?? build.range)!;
  const tendencies = responseTendenciesOf(
    pb.tendency === null ? null : (pb.tendency.dimension.dimensions as never), pb.confidence, null);
  const betFacts = buildBettingRangeFacts({
    arrivalEntries: arrival.entries.map((e: any) => ({ cardIndices: e.combo.cardIndices, probability: e.probability })),
    board, heroHole, potChips: potPre, betChips: callCost, street: 'RIVER', tendencies,
  });
  if (betFacts === null) { line(`${tag}: 无下注范围`); continue; }
  const betRange = betFacts.entries;

  /* 产品口径：方案② 的 RAISE EV（从诊断里取，保证是**产品输出**） */
  const r = analyzeManualHand(input, OPTIONS);
  if (!r.ok) { line(`${tag}: ANALYZE FAIL`); continue; }
  const dg = (r.decision as unknown as Record<string, any>)['diagnostics'] as Record<string, any>;
  const facts = ((dg['postflop'] as Record<string, any> | undefined)?.['raiseResponse'] ?? dg['raiseResponse']) as Record<string, any> | null | undefined;
  if (facts === null || facts === undefined) { line(`${pad(tag, 34)} 无加注响应事实（无加注候选）`); continue; }
  const sizeChips = facts['sizeChips'] as number;
  const ev2 = facts['raiseEV'] as number | null;
  const callEV = (dg['math']['callEV'] ?? null) as number | null;

  /* 方案①：既有 classifyResponse，价格换成加注赔率 */
  const increment = sizeChips - callCost;
  const price = increment / (potPre + 2 * increment);
  const streetNow = String(state.street) as 'FLOP' | 'TURN' | 'RIVER';
  const cardsToCome = cardsToComeOf(board.length, streetNow as never);
  let f1 = 0, c1 = 0, r1 = 0, t1 = 0;
  const callEntries1: { cardIndices: readonly [number, number]; probability: number }[] = [];
  for (const e of betRange) {
    const hole = [ALL_CARDS[e.cardIndices[0]]!, ALL_CARDS[e.cardIndices[1]]!] as const;
    const cmp = compareHands(evaluateCards([...hole, ...board]), heroEval);
    const cls = classifyResponse({
      hole: [hole[0], hole[1]],
      versusHero: cmp > 0 ? 'STRONGER' : cmp < 0 ? 'WEAKER' : 'EQUAL',
      tier: boardRelativeTierOf([hole[0], hole[1]], board) ?? 5,
      street: streetNow as never, cardsToCome,
      ratioToPot: increment / potPre, priceRequiredEquity: price, spr: null, opponentCount: 1,
      wetness: 0, tendencies,
      heroIsAllIn: (facts['reRaiseLikelihood'] as number) === 0,
      villainDraw: 'NO_DRAW',
    });
    t1 += e.probability;
    f1 += e.probability * cls.weights.fold;
    c1 += e.probability * cls.weights.call;
    r1 += e.probability * cls.weights.raise;
    if (cls.weights.call > 0) callEntries1.push({ cardIndices: e.cardIndices, probability: e.probability * cls.weights.call });
  }
  const norm1 = (() => {
    const m = callEntries1.reduce((a, x) => a + x.probability, 0);
    return m > 0 ? callEntries1.map((x) => ({ ...x, probability: x.probability / m })) : [];
  })();
  let ev1: number | null = null;
  if (norm1.length > 0) {
    const out = computeEquity(heroHole, board,
      [{ label: 'raise-call-1', combos: norm1.map((x) => [ALL_CARDS[x.cardIndices[0]]!, ALL_CARDS[x.cardIndices[1]]!] as const) }],
      { mode: EquityComputeMode.FAST, seed: SEED + 1601, iterations: 6000, opponentWeights: [norm1.map((x) => x.probability)] });
    if (out.ok) {
      ev1 = (f1 / t1) * potPre + (c1 / t1) * (out.result.equity * (potPre + 2 * increment) - increment) + (r1 / t1) * -increment;
    }
  }
  const sameSign = ev1 === null || ev2 === null ? null : Math.sign(ev1) === Math.sign(ev2);
  if (sameSign !== null) { total += 1; if (sameSign) agree += 1; else signMismatch.push(tag); }
  line(pad(tag, 34) + pad(num(sizeChips, 0), 10) + pad(num(price, 4), 8) +
    pad(`${num(facts['foldLikelihood'], 3)}/${num(facts['callLikelihood'], 3)}/${num(facts['reRaiseLikelihood'], 3)}`, 18) +
    pad(`${num(f1 / t1, 3)}/${num(c1 / t1, 3)}/${num(r1 / t1, 3)}`, 18) +
    pad(num(ev2, 2), 12) + pad(num(ev1, 2), 12) + pad(num(callEV, 2), 10) +
    (sameSign === null ? '—' : sameSign ? '✔' : '✖'));
}
line('');
line(`  符号一致：${agree}/${total}${signMismatch.length > 0 ? `｜不一致：${signMismatch.join('、')}` : ''}`);
line('  ⚠️ 方案① 使用 `versusHero + tier`（含 Hero 视角），方案② 只用公共强度带 —— 两者**独立**。');
line('     一致性只用于判断「生产模型是否给出与既有模型方向相反的结论」，不代表任何一方已校准。');
