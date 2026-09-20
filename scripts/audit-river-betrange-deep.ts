/* eslint-disable */
/*
 * ⚠️⚠️ **历史脚本警告（RIVER BET RANGE V2 起）** ⚠️⚠️
 *
 * 本脚本写于 **RIVER BET RANGE V1** 时期，用于审计当时的缺陷。
 * 产品已升级到 V2（公共强度带模型 + 单一计费路径），因此：
 *   · 它调用的权重来自**冻结的 V1 快照**（./_legacyBetProbabilityByClass.ts）；
 *   · 它对 `buildBettingRangeFacts` 的调用走的是**当前的 V2 实现**；
 *   · 输出是**两个模型的混合**，**不代表当前产品行为**。
 *
 * 当前行为请以 `scripts/rbrv2-acceptance.ts` / `scripts/rbrv2-sensitivity.ts`
 * 与 `test/riverBetRangeV2*.test.ts` 为准。
 */
console.log('⚠️ 历史脚本（RIVER BET RANGE V1 时期）：输出混用了冻结的 V1 权重快照与当前 V2 实现，不代表当前产品行为。');
console.log('   当前行为请跑 scripts/rbrv2-acceptance.ts。\n');
/**
 * 只读探针 2：归因实验 + 全组合清单
 *
 * §2b 隔离实验：只改一个假设，看 EqVsBetRange 怎么变
 *   S0 复刻引擎（校验复刻精度）
 *   S1 只把 SHOWDOWN_VALUE 从 0 放开到 NORMAL 的值
 *   S2 只把「比 Hero 弱的顶对（KQ/KJ/KT）」当成价值下注
 *   S3 只把到达范围换成真正「下注前」的那一层（去掉 RIVER/BET 似然的重复计费）
 *   S4 S1+S2+S3 同时
 * §附录 到达范围 469 个组合 / 990 个合法组合的完整清单
 */
import { ALL_CARDS, type Card } from '../src/domain/types.ts';
import { computeEquity, EquityComputeMode } from '../src/domain/poker/equity.ts';
import { compareHands, evaluateCards } from '../src/domain/poker/handEval.ts';
import { describeHand } from '../src/domain/poker/handDescription.ts';
import { handDescriptionText } from '../src/i18n/index.ts';
import { boardRelativeTierOf } from '../src/domain/poker/boardRelativeStrength.ts';
import { riverComboClassOf } from '../src/domain/postflop/riverProfileClassify.ts';
import { responseTendenciesOf } from '../src/domain/postflop/betResponse.ts';
import { legacyBetProbabilityByClass as betProbabilityByClass } from './_legacyBetProbabilityByClass.ts';
import { behaviorProfileOf } from '../src/domain/player/behaviorProfile.ts';
import { quickProfileToLimperArchetype } from '../src/app/manualInput/limpIsolation.ts';
import { computePot } from '../src/domain/poker/gameState.ts';
import { parseManualInput, type ManualHandInput } from '../src/app/manualInput/manualInput.ts';
import { reconstructGameState } from '../src/app/manualInput/reconstruct.ts';
import { buildRangeSnapshot, buildPlayerSnapshot, boardAtStreetOf } from './__shadow-contextBuilder.ts';

const BOARD = ['Kd', '9c', '4h', '6s', '2d'] as const;
const HERO = ['As', 'Ks'] as const;
const SEED = 20_261_014;
const RANK_CHARS: Record<number, string> = { 2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9', 10: 'T', 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
const CHAR_RANKS: Record<string, number> = { '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, T: 10, J: 11, Q: 12, K: 13, A: 14 };
const cardZh = (c: Card): string => `${RANK_CHARS[c.rank] ?? '?'}${c.suit}`;
const parseCard = (s: string): Card => ALL_CARDS.find((c) => c.rank === CHAR_RANKS[s.slice(0, -1)]! && c.suit === s.slice(-1))!;

const HERO_CARDS = HERO.map(parseCard);
const BOARD_CARDS = BOARD.map(parseCard);
const DEAD_KEY = new Set([...HERO_CARDS, ...BOARD_CARDS].map(cardZh));
const heroEval = evaluateCards([...HERO_CARDS, ...BOARD_CARDS]);

const line = (s = ''): void => console.log(s);
const p4 = (v: unknown): string => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(4) : '—');
const p6 = (v: unknown): string => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(6) : '—');
const pct = (v: unknown): string => (typeof v === 'number' && Number.isFinite(v) ? `${(v * 100).toFixed(2)}%` : '—');
const pad = (s: string, n: number): string => {
  const w = [...s].reduce((a, c) => a + (c.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
  return s + ' '.repeat(Math.max(0, n - w));
};

type Entry = { cardIndices: readonly [number, number]; probability: number };
const holeOf = (e: Entry): [Card, Card] => [ALL_CARDS[e.cardIndices[0]]!, ALL_CARDS[e.cardIndices[1]]!];
const comboZh = (e: Entry): string => { const [a, b] = holeOf(e); return `${cardZh(a)}${cardZh(b)}`; };
const heroEqOf = (hole: readonly Card[]): number => {
  const cmp = compareHands(evaluateCards([...hole, ...BOARD_CARDS]), heroEval);
  return cmp > 0 ? 0 : cmp < 0 ? 1 : 0.5;
};

function equityOf(entries: readonly Entry[], iterations = 20000, seed = SEED) {
  const out = computeEquity([HERO_CARDS[0]!, HERO_CARDS[1]!], BOARD_CARDS,
    [{ label: 'R', combos: entries.map(holeOf) }],
    { mode: EquityComputeMode.FAST, seed, iterations, opponentWeights: [entries.map((e) => e.probability)] });
  return out.ok ? { value: out.result.equity, method: out.result.method, iterations: out.result.iterations } : { value: null, method: 'N/A', iterations: 0 };
}

/* ---------------- 取三层范围 ---------------- */
const H = (p: string, t: string, a?: number, s?: string) => ({ position: p, type: t, ...(a === undefined ? {} : { amountBB: a }), ...(s === undefined ? {} : { street: s }) });
const PREFLOP = [H('UTG', 'FOLD'), H('HJ', 'FOLD'), H('CO', 'FOLD'), H('BTN', 'RAISE', 3), H('SB', 'FOLD'), H('BB', 'CALL', 2)];
const FLOP = [H('BB', 'CHECK', undefined, 'FLOP'), H('BTN', 'BET', 2.5, 'FLOP'), H('BB', 'CALL', 2.5, 'FLOP')];
const TURN = [H('BB', 'CHECK', undefined, 'TURN'), H('BTN', 'BET', 7.5, 'TURN'), H('BB', 'CALL', 7.5, 'TURN')];
const RIVER = [H('BB', 'BET', 20, 'RIVER')];

function layer(actions: readonly Record<string, unknown>[], profile = 'CALLING_STATION') {
  const input = {
    tableSize: 6, heroPosition: 'BTN', heroCards: [...HERO], board: [...BOARD], street: 'RIVER',
    effectiveStackBB: 100, bigBlindBB: 2,
    seatStacksBB: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 },
    actionHistory: actions.map((x) => ({ ...x })), environment: 'MID_LOW_STAKES',
    villain: { quickProfile: profile, dynamicHint: 'UNKNOWN', stackBB: 100 },
  } as unknown as ManualHandInput;
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
  const entries: Entry[] = build.range === null ? [] : build.range.entries.map((e: any) => ({ cardIndices: e.combo.cardIndices, probability: e.probability }));
  return { state, playerBuilt: pb, entries };
}

const before = layer([...PREFLOP, ...FLOP, ...TURN]);      // ③ 真正下注前的到达范围
const after = layer([...PREFLOP, ...FLOP, ...TURN, ...RIVER]); // ④ 引擎口径（含 RIVER/BET 似然）

const eq3 = equityOf(before.entries);
const eq4 = equityOf(after.entries);
line('### 到达范围两层（精确度确认）');
line(`③ 下注前（含 TURN/CALL 为止的更新）：equity=${p6(eq3.value)} method=${eq3.method} n=${eq3.iterations}`);
line(`④ 引擎口径（多乘一次 RIVER/BET 似然）：equity=${p6(eq4.value)} method=${eq4.method} n=${eq4.iterations}`);
line(`引擎 math.heroEquity = 0.659153024494907  ⇒ ④ 与引擎${Math.abs((eq4.value ?? 0) - 0.659153024494907) < 1e-12 ? '**逐位一致**' : '不一致'}（证明④就是引擎的「Arrival Range」）`);
line('');

const tendencies = responseTendenciesOf(
  after.playerBuilt.tendency === null ? null : (after.playerBuilt.tendency.dimension.dimensions as never),
  after.playerBuilt.confidence, null);
const pot = computePot(after.state);
const call = after.state.currentBet;
const potBefore = pot - call;
const winnable = pot + call;
const classP = betProbabilityByClass(tendencies, call / potBefore) as unknown as Record<string, number>;
const CLS = ['NUT_VALUE', 'STRONG_VALUE', 'THIN_VALUE', 'SHOWDOWN_VALUE', 'MISSED_FLUSH_DRAW', 'MISSED_STRAIGHT_DRAW', 'MISSED_COMBO_DRAW', 'PURE_AIR'];

/** 复刻 `buildBettingRangeFacts`（同一算法；用于隔离实验） */
function buildRangeFrom(arrival: readonly Entry[], pOf: (hole: readonly Card[], cls: string | null, tier: number) => number) {
  const raw: Entry[] = [];
  const byClass: Record<string, number> = {};
  let arrivalMass = 0, betMass = 0, value = 0, bluff = 0, showdown = 0;
  let blocked = 0, unclassified = 0;
  for (const e of arrival) {
    if (!(e.probability > 0)) continue;
    const hole = holeOf(e);
    if (hole.some((c) => DEAD_KEY.has(cardZh(c)))) { blocked += 1; continue; }
    const c = riverComboClassOf({ hole: [hole[0]!, hole[1]!], board: BOARD_CARDS, heroHole: HERO_CARDS });
    arrivalMass += e.probability;
    if (c === null) { unclassified += e.probability; continue; }
    const w = Math.max(0, Math.min(1, pOf(hole, c.category, c.strengthBucket)));
    byClass[c.category] = (byClass[c.category] ?? 0) + e.probability * w;
    if (!(w > 0)) continue;
    const bw = e.probability * w;
    betMass += bw;
    raw.push({ cardIndices: e.cardIndices, probability: bw });
  }
  const entries = betMass > 0 ? raw.map((e) => ({ cardIndices: e.cardIndices, probability: e.probability / betMass })) : [];
  value = (byClass['NUT_VALUE'] ?? 0) + (byClass['STRONG_VALUE'] ?? 0) + (byClass['THIN_VALUE'] ?? 0);
  showdown = byClass['SHOWDOWN_VALUE'] ?? 0;
  bluff = betMass - value - showdown;
  let eqSum = 0;
  for (const e of entries) eqSum += e.probability * heroEqOf(holeOf(e));
  return { entries, arrivalMass, betMass, valueShare: value / (betMass || 1), bluffShare: bluff / (betMass || 1), showdownShare: showdown / (betMass || 1), blocked, unclassified, exactEquity: eqSum };
}

/* ---------------- S0：复刻校验 ---------------- */
line('### S0 复刻校验（用真实 classP 重建下注范围）');
const s0 = buildRangeFrom(after.entries, (_h, cls) => (cls === null ? 0 : (classP[cls] ?? 0)));
const s0eq = equityOf(s0.entries, 6000, SEED + 1301);
line(`  到达质量=${p6(s0.arrivalMass)} 下注质量=${p6(s0.betMass)} 组合数=${s0.entries.length}`);
line(`  价值质量=${s0.valueShare.toFixed(12)} 摊牌质量=${s0.showdownShare.toFixed(12)} 诈唬质量=${s0.bluffShare.toFixed(12)}`);
line(`  ⇒ 下注范围里「比 Hero 强」的质量 = ${(s0.valueShare + s0.showdownShare).toFixed(12)}（其中摊牌 ${s0.showdownShare.toFixed(12)}）；`);
line(`     Hero 的权益 = 诈唬质量(${s0.bluffShare.toFixed(12)}) + 0.5×平局质量(0) = ${(s0.bluffShare).toFixed(12)} —— **权益就是模型自己的诈唬占比**`);
line(`  EqVsBetRange(逐组合精确) = ${p6(s0.exactEquity)}｜权益引擎 = ${p6(s0eq.value)}（${s0eq.method}）｜引擎实测 = 0.005433446930540442`);
line(`  ⇒ 复刻${Math.abs((s0eq.value ?? 0) - 0.005433446930540442) < 1e-12 ? '**逐位一致**（归因实验可信）' : '不一致'}`);
line('');

/* ---------------- 隔离实验 ---------------- */
const scenarios: Array<{ tag: string; arrival: readonly Entry[]; pOf: (h: readonly Card[], c: string | null, t: number) => number }> = [
  { tag: 'S0 基准（引擎现状）', arrival: after.entries, pOf: (_h, c) => (c === null ? 0 : classP[c] ?? 0) },
  { tag: 'S1 只放开 SHOWDOWN_VALUE（0 → 0.0824，NORMAL 的值）', arrival: after.entries, pOf: (_h, c) => (c === null ? 0 : c === 'SHOWDOWN_VALUE' ? 0.0824 : classP[c] ?? 0) },
  { tag: 'S2 只把「比 Hero 弱的顶对 KQ/KJ/KT」按强价值下注（tier2 且 Hero 领先 → 0.2442）', arrival: after.entries, pOf: (h, c, t) => { if (c === 'SHOWDOWN_VALUE' && t === 2 && heroEqOf(h) === 1) return 0.2442; return c === null ? 0 : classP[c] ?? 0; } },
  { tag: 'S3 只换成真正「下注前」的到达范围 ③（去掉 RIVER/BET 似然的重复计费）', arrival: before.entries, pOf: (_h, c) => (c === null ? 0 : classP[c] ?? 0) },
  { tag: 'S4 S1+S2+S3 同时', arrival: before.entries, pOf: (h, c, t) => { if (c === 'SHOWDOWN_VALUE') return t === 2 && heroEqOf(h) === 1 ? 0.2442 : 0.0824; return c === null ? 0 : classP[c] ?? 0; } },
  {
    tag: 'S5 只把「他领先的顶对/中对」（比 Hero 弱但有摊牌价值）按薄价值 0.30 下注（其余不动，仍在 ④ 层）',
    arrival: after.entries,
    pOf: (h, c) => { if (c === 'SHOWDOWN_VALUE') return heroEqOf(h) === 1 ? 0.30 : 0.0824; return c === null ? 0 : classP[c] ?? 0; },
  },
];
line('### §2b 归因实验（每次只改一个假设）');
line(pad('场景', 74) + pad('下注占比', 12) + pad('价值质量', 12) + pad('诈唬质量', 12) + pad('EqVsBetRange', 14) + pad('CALL EV', 12) + '动作');
for (const s of scenarios) {
  const r = buildRangeFrom(s.arrival, s.pOf);
  const eq = equityOf(r.entries, 6000, SEED + 1301);
  const callEV = (eq.value ?? 0) * winnable - call;
  line(pad(s.tag, 74) + pad(pct(r.betMass), 12) + pad(pct(r.valueShare), 12) + pad(pct(r.bluffShare), 12) +
    pad(p6(eq.value), 14) + pad(p4(callEV), 12) + (callEV > 0 ? 'CALL' : 'FOLD'));
}
line('');
line(`基准参数：pot=${pot} call=${call} requiredEquity=${p6(call / winnable)} winnable=${winnable}`);
line('');

/* ---------------- 附录：全组合清单 ---------------- */
/* ---------------- §2c：③→④ 的隐含似然（重复计费的证据） ---------------- */
line('### §2c ③（真正下注前）与 ④（引擎口径）的逐类质量 —— ④/③ 就是已被施加过的「下注似然」');
{
  const masses = (entries: readonly Entry[]) => {
    const by: Record<string, number> = {};
    let total = 0;
    for (const e of entries) {
      if (!(e.probability > 0)) continue;
      const hole = holeOf(e);
      if (hole.some((c) => DEAD_KEY.has(cardZh(c)))) continue;
      const c = riverComboClassOf({ hole: [hole[0]!, hole[1]!], board: BOARD_CARDS, heroHole: HERO_CARDS });
      if (c === null) continue;
      by[c.category] = (by[c.category] ?? 0) + e.probability;
      total += e.probability;
    }
    return { by, total };
  };
  const m3 = masses(before.entries), m4 = masses(after.entries);
  line(pad('类别', 24) + pad('③ 质量', 12) + pad('④ 质量', 12) + pad('④/③（隐含似然比）', 20) + pad('③ 中占比', 12) + '④ 中占比');
  for (const k of CLS) {
    const a = m3.by[k] ?? 0, b = m4.by[k] ?? 0;
    line(pad(k, 24) + pad(a.toFixed(6), 12) + pad(b.toFixed(6), 12) + pad(a > 0 ? (b / a).toFixed(4) : '—', 20) +
      pad(pct(a / m3.total), 12) + pct(b / m4.total));
  }
  const v3 = (m3.by['NUT_VALUE'] ?? 0) + (m3.by['STRONG_VALUE'] ?? 0) + (m3.by['THIN_VALUE'] ?? 0);
  const v4 = (m4.by['NUT_VALUE'] ?? 0) + (m4.by['STRONG_VALUE'] ?? 0) + (m4.by['THIN_VALUE'] ?? 0);
  const b3 = (m3.by['MISSED_FLUSH_DRAW'] ?? 0) + (m3.by['MISSED_STRAIGHT_DRAW'] ?? 0) + (m3.by['MISSED_COMBO_DRAW'] ?? 0) + (m3.by['PURE_AIR'] ?? 0);
  const b4 = (m4.by['MISSED_FLUSH_DRAW'] ?? 0) + (m4.by['MISSED_STRAIGHT_DRAW'] ?? 0) + (m4.by['MISSED_COMBO_DRAW'] ?? 0) + (m4.by['PURE_AIR'] ?? 0);
  line(pad('价值合计', 24) + pad(v3.toFixed(6), 12) + pad(v4.toFixed(6), 12) + pad((v4 / v3).toFixed(4), 20) + pad(pct(v3 / m3.total), 12) + pct(v4 / m4.total));
  line(pad('诈唬合计（空气）', 24) + pad(b3.toFixed(6), 12) + pad(b4.toFixed(6), 12) + pad((b4 / b3).toFixed(4), 20) + pad(pct(b3 / m3.total), 12) + pct(b4 / m4.total));
  line('  ⇒ 河牌下注这一次动作，已经在「到达范围」里把空气压掉 ≈' + (b3 / b4).toFixed(1) + ' 倍、把价值抬 ≈' + (v4 / v3).toFixed(2) + ' 倍；');
  line('    而 `buildBettingRangeFacts` 随后又乘了一次 P(BET|类别)（空气 0.0639、摊牌 0）⇒ **同一条动作被计两次费**。');
}
line('');

line('### 附录 A：到达范围（引擎口径 ④）全部组合');line(pad('Hand', 10) + pad('Strength', 20) + pad('tier', 5) + pad('类别', 22) + pad('Arrival W', 12) + pad('P(BET)', 10) + pad('Bet W', 12) + pad('Norm W', 10) + 'HeroEq');
const byHand: Array<{ e: Entry; row: string }> = [];
for (const e of after.entries) {
  if (!(e.probability > 0)) continue;
  const hole = holeOf(e);
  const c = riverComboClassOf({ hole: [hole[0]!, hole[1]!], board: BOARD_CARDS, heroHole: HERO_CARDS });
  const t = boardRelativeTierOf(hole, BOARD_CARDS) ?? -1;
  const p = c === null ? 0 : classP[c.category] ?? 0;
  const bw = e.probability * p;
  const row = pad(comboZh(e), 10) + pad(handDescriptionText(describeHand([hole[0]!, hole[1]!], BOARD_CARDS)).slice(0, 18), 20) + pad(String(t), 5) +
    pad(c?.category ?? '—', 22) + pad(e.probability.toExponential(3), 12) + pad(p4(p), 10) + pad(bw.toExponential(3), 12) +
    pad(p4(bw / s0.betMass), 10) + p4(heroEqOf(hole));
  byHand.push({ e, row });
}
for (const r of byHand.sort((a, b) => b.e.probability - a.e.probability)) line(r.row);
line(`（共 ${byHand.length} 个正权组合；其余 ${990 - byHand.length} 个合法组合在到达范围中权重为 0）`);
line('');

line('### 附录 B：被 Hero 底牌／公共牌阻断的组合（336 个，全部死牌，两侧都不计）');
{
  let blockedCount = 0;
  const sample: string[] = [];
  for (let i = 0; i < ALL_CARDS.length; i += 1) {
    for (let j = i + 1; j < ALL_CARDS.length; j += 1) {
      const a = ALL_CARDS[i]!, b = ALL_CARDS[j]!;
      if (DEAD_KEY.has(cardZh(a)) || DEAD_KEY.has(cardZh(b))) { blockedCount += 1; if (sample.length < 12) sample.push(`${cardZh(a)}${cardZh(b)}`); }
    }
  }
  line(`  1326 − ${blockedCount} = ${1326 - blockedCount}（示例：${sample.join(' ')} …）`);
}
