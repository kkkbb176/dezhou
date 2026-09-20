/**
 * RIVER BET RANGE V2 —— 第一阶段：冻结旧结果（BEFORE）
 *
 * 只读。输出一份可对比的 JSON + 人读摘要：
 *   1. 河牌下注前到达范围（③，链上排除当前 BET）与引擎当前「所谓到达范围」（④，含 BET 似然）
 *   2. 逐组合权重（引擎当前下注范围）
 *   3. EqVsBetRange / CALL EV / 最终动作
 *   4. **重复计费的直接证据**：只改当前下注尺寸，④ 会变而 ③ 不变
 */
import { writeFileSync } from 'node:fs';
import { ALL_CARDS, type Card } from '../src/domain/types.ts';
import { computeEquity, EquityComputeMode } from '../src/domain/poker/equity.ts';
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';
import { parseManualInput, type ManualHandInput } from '../src/app/manualInput/manualInput.ts';
import { reconstructGameState } from '../src/app/manualInput/reconstruct.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import { buildBettingRangeFacts } from '../src/app/manualInput/bettingRange.ts';
import { responseTendenciesOf } from '../src/domain/postflop/betResponse.ts';
import { behaviorProfileOf } from '../src/domain/player/behaviorProfile.ts';
import { quickProfileToLimperArchetype } from '../src/app/manualInput/limpIsolation.ts';
import { computePot } from '../src/domain/poker/gameState.ts';
import { buildRangeSnapshot, buildPlayerSnapshot, boardAtStreetOf } from './__shadow-contextBuilder.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const SEED = 20_261_014;
const BOARD = ['Kd', '9c', '4h', '6s', '2d'] as const;
const HERO = ['As', 'Ks'] as const;
const RANK_CHARS: Record<number, string> = { 2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9', 10: 'T', 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
const CHAR_RANKS: Record<string, number> = { '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, T: 10, J: 11, Q: 12, K: 13, A: 14 };
const cardZh = (c: Card): string => `${RANK_CHARS[c.rank]}${c.suit}`;
const parseCard = (s: string): Card => ALL_CARDS.find((c) => c.rank === CHAR_RANKS[s.slice(0, -1)]! && c.suit === s.slice(-1))!;
const HERO_CARDS = HERO.map(parseCard);
const BOARD_CARDS = BOARD.map(parseCard);

const H = (p: string, t: string, a?: number, s?: string) => ({ position: p, type: t, ...(a === undefined ? {} : { amountBB: a }), ...(s === undefined ? {} : { street: s }) });
const hist = (riverBetBB: number) => [
  H('UTG', 'FOLD'), H('HJ', 'FOLD'), H('CO', 'FOLD'), H('BTN', 'RAISE', 3), H('SB', 'FOLD'), H('BB', 'CALL', 2),
  H('BB', 'CHECK', undefined, 'FLOP'), H('BTN', 'BET', 2.5, 'FLOP'), H('BB', 'CALL', 2.5, 'FLOP'),
  H('BB', 'CHECK', undefined, 'TURN'), H('BTN', 'BET', 7.5, 'TURN'), H('BB', 'CALL', 7.5, 'TURN'),
  H('BB', 'BET', riverBetBB, 'RIVER'),
];

function inputFor(riverBetBB: number, profile = 'CALLING_STATION'): ManualHandInput {
  return {
    tableSize: 6, heroPosition: 'BTN', heroCards: [...HERO], board: [...BOARD], street: 'RIVER',
    effectiveStackBB: 100, bigBlindBB: 2,
    seatStacksBB: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 },
    actionHistory: hist(riverBetBB).map((x) => ({ ...x })), environment: 'MID_LOW_STAKES',
    villain: { quickProfile: profile, dynamicHint: 'UNKNOWN', stackBB: 100 },
  } as unknown as ManualHandInput;
}

/** 用 PREVIEW 重建到「不含当前 BET」的位置上，得到**真正的到达范围** */
function arrivalRangeOf(riverBetBB: number, profile = 'CALLING_STATION') {
  const full = hist(riverBetBB);
  const input = { ...inputFor(riverBetBB, profile), actionHistory: full.slice(0, -1).map((x) => ({ ...x })) } as unknown as ManualHandInput;
  const parsed = parseManualInput(input);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues[0]));
  const rc = reconstructGameState(parsed.value, { mode: 'PREVIEW' as never });
  if (!rc.ok) throw new Error(JSON.stringify(rc.issues[0]));
  const state = rc.state;
  const opponent = state.players.find((p) => p.id === 'seat_BB')!;
  const pb = buildPlayerSnapshot('seat_BB' as never, undefined as never, profile as never, 'UNKNOWN' as never, (s: never) => boardAtStreetOf(state, s));
  const build = buildRangeSnapshot(state, opponent as never, [...HERO_CARDS, ...BOARD_CARDS] as never, undefined,
    pb.tendency as never, { archetype: quickProfileToLimperArchetype(profile), confidence: pb.confidence } as never,
    (behaviorProfileOf({ playerId: 'seat_BB', archetype: profile as never }) ?? null) as never);
  return { state, playerBuilt: pb, range: build.range };
}

function entriesOf(range: any) {
  return (range?.entries ?? []).map((e: any) => ({ cardIndices: e.combo.cardIndices as [number, number], probability: e.probability as number }));
}
function equity(entries: readonly { cardIndices: readonly [number, number]; probability: number }[]) {
  const out = computeEquity([HERO_CARDS[0]!, HERO_CARDS[1]!], BOARD_CARDS,
    [{ label: 'R', combos: entries.map((e) => [ALL_CARDS[e.cardIndices[0]]!, ALL_CARDS[e.cardIndices[1]]!] as const) }],
    { mode: EquityComputeMode.FAST, seed: SEED, iterations: 20000, opponentWeights: [entries.map((e) => e.probability)] });
  return out.ok ? out.result.equity : null;
}

const summary: Record<string, unknown> = {};
for (const betBB of [20, 4]) {
  const full = inputFor(betBB);
  const parsed = parseManualInput(full);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues[0]));
  const rc = reconstructGameState(parsed.value, { mode: 'PREVIEW' as never });
  if (!rc.ok) throw new Error(JSON.stringify(rc.issues[0]));
  const state = rc.state;
  const opponent = state.players.find((p) => p.id === 'seat_BB')!;
  const pb = buildPlayerSnapshot('seat_BB' as never, undefined as never, 'CALLING_STATION' as never, 'UNKNOWN' as never, (s: never) => boardAtStreetOf(state, s));

  // ④ 引擎当前口径（链上**含**当前 BET）
  const post = buildRangeSnapshot(state, opponent as never, [...HERO_CARDS, ...BOARD_CARDS] as never, undefined,
    pb.tendency as never, { archetype: quickProfileToLimperArchetype('CALLING_STATION'), confidence: pb.confidence } as never,
    (behaviorProfileOf({ playerId: 'seat_BB', archetype: 'CALLING_STATION' as never }) ?? null) as never);
  const postEntries = entriesOf(post.range);

  // ③ 真正的到达范围（链上排除当前 BET）
  const arr = arrivalRangeOf(betBB);
  const arrEntries = entriesOf(arr.range);

  const tend = responseTendenciesOf(pb.tendency === null ? null : (pb.tendency.dimension.dimensions as never), pb.confidence, null);
  const potBefore = computePot(state) - state.currentBet;
  const facts = buildBettingRangeFacts({
    arrivalEntries: postEntries,   // ← 引擎现在的做法：拿 ④ 当到达范围
    board: BOARD_CARDS, heroHole: HERO_CARDS,
    potChips: potBefore, betChips: state.currentBet, street: 'RIVER', tendencies: tend,
  });

  const ana = analyzeManualHand(full, { rules: RULES, asOf: 1_757_000_000_000, writeLog: false, equitySeed: SEED, budget: { softMs: 120_000, hardMs: 240_000 } });
  const decision = ana.ok ? (ana.decision as unknown as Record<string, any>) : null;
  const math = decision === null ? null : ((decision['diagnostics'] as any)['math'] as Record<string, any>);

  summary[`bet${betBB}BB`] = {
    betChips: state.currentBet, potBeforeBet: potBefore,
    arrival_preBet: {
      support: arrEntries.filter((e) => e.probability > 0).length,
      equity: equity(arrEntries),
      entries: arrEntries.filter((e) => e.probability > 0).map((e) => `${cardZh(ALL_CARDS[e.cardIndices[0]]!)}${cardZh(ALL_CARDS[e.cardIndices[1]]!)}:${e.probability.toExponential(6)}`),
    },
    posterior_engineArrival: {
      support: postEntries.filter((e) => e.probability > 0).length,
      equity: equity(postEntries),
    },
    betRange: facts === null ? null : {
      entryCount: facts.entries.length,
      betMass: facts.betMass,
      betShareOfArrival: facts.betShareOfArrival,
      classMasses: facts.classMasses,
      equity: equity(facts.entries),
      perCombo: facts.entries.map((e) => ({
        hand: `${cardZh(ALL_CARDS[e.cardIndices[0]]!)}${cardZh(ALL_CARDS[e.cardIndices[1]]!)}`,
        normW: e.probability,
      })),
    },
    engine: math === null ? null : {
      heroEquity: math['heroEquity'], heroEquityVsBetRange: math['heroEquityVsBetRange'],
      pot: math['pot'], callCost: math['callCost'], requiredEquity: math['requiredEquity'], callEV: math['callEV'],
      action: decision?.['action'] ?? null,
    },
  };
}

writeFileSync('reports/evidence/rbrv2-before.json', JSON.stringify(summary, null, 2), 'utf8');

const line = (s = '') => console.log(s);
line('=== BEFORE（旧结果冻结） ===');
for (const key of Object.keys(summary)) {
  const s = summary[key] as any;
  line(`\n[${key}] betChips=${s.betChips} potBefore=${s.potBeforeBet}`);
  line(`  ③ 真正到达范围：support=${s.arrival_preBet.support} equity=${s.arrival_preBet.equity}`);
  line(`  ④ 引擎「到达范围」：support=${s.posterior_engineArrival.support} equity=${s.posterior_engineArrival.equity}`);
  line(`  ④ 下注范围：${s.betRange.entryCount} 组合｜betShareOfArrival=${s.betRange.betShareOfArrival.toFixed(6)}｜equity=${s.betRange.equity}`);
  line(`     价值=${s.betRange.classMasses.valueMass.toFixed(6)} 摊牌=${s.betRange.classMasses.showdownMass.toFixed(6)} 诈唬=${s.betRange.classMasses.bluffMass.toFixed(6)}`);
  line(`  引擎：heroEquity=${s.engine.heroEquity} eqVsBetRange=${s.engine.heroEquityVsBetRange} callEV=${s.engine.callEV.toFixed(4)} action=${s.engine.action}`);
  const na = summary['bet20BB'] as any, nb = summary['bet4BB'] as any;
  void na; void nb;
}
const a = summary['bet20BB'] as any, b = summary['bet4BB'] as any;
line('\n=== 重复计费证据：只改当前下注尺寸（20BB=40 → 4BB=8） ===');
line(`  ③ 真正到达范围权益： ${a.arrival_preBet.equity} → ${b.arrival_preBet.equity}   （必须相同）`);
line(`  ④ 引擎到达范围权益： ${a.posterior_engineArrival.equity} → ${b.posterior_engineArrival.equity}   （旧口径下会变 ⇒ 说明 BET 似然已在链上计过一次）`);
line(`  下注范围权益：       ${a.betRange.equity} → ${b.betRange.equity}`);
line(`  ⇒ 到达范围是否随尺寸漂移 = ${a.arrival_preBet.equity === b.arrival_preBet.equity ? '否（正确）' : '**是（旧缺陷）**'}；引擎口径是否漂移 = ${a.posterior_engineArrival.equity === b.posterior_engineArrival.equity ? '否' : '**是**'}`);
