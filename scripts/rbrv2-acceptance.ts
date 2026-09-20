/**
 * RIVER BET RANGE V2 —— 第七阶段：功能验收（原样重跑 AK 河牌领打节点）
 *
 * 输出：真正的下注前到达范围、当前 40 筹码的下注范围、逐牌型到达/下注权重、
 *       EqVsArrivalRange / EqVsBetRange / CALL EV / FOLD EV / 最终动作与依据。
 * 只读，不改产品代码。
 */
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';
import { parseManualInput, type ManualHandInput } from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import { ALL_CARDS, type Card } from '../src/domain/types.ts';
import { computeEquity, EquityComputeMode } from '../src/domain/poker/equity.ts';
import { compareHands, evaluateCards } from '../src/domain/poker/handEval.ts';
import { describeHand } from '../src/domain/poker/handDescription.ts';
import { handDescriptionText } from '../src/i18n/index.ts';
import { publicStrengthBandOf, PUBLIC_STRENGTH_BAND_ZH, PUBLIC_STRENGTH_BAND_ORDER } from '../src/app/manualInput/bettingRange.ts';

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
const heroEval = evaluateCards([...HERO_CARDS, ...BOARD_CARDS]);

const line = (s = ''): void => console.log(s);
const p4 = (v: unknown): string => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(4) : '—');
const p6 = (v: unknown): string => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(6) : '—');
const pct = (v: unknown, d = 2): string => (typeof v === 'number' && Number.isFinite(v) ? `${(v * 100).toFixed(d)}%` : '—');
const pad = (s: string, n: number): string => {
  const w = [...s].reduce((a, c) => a + (c.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
  return s + ' '.repeat(Math.max(0, n - w));
};

const H = (p: string, t: string, a?: number, s?: string) => ({ position: p, type: t, ...(a === undefined ? {} : { amountBB: a }), ...(s === undefined ? {} : { street: s }) });
const hist = (riverBetBB: number) => [
  H('UTG', 'FOLD'), H('HJ', 'FOLD'), H('CO', 'FOLD'), H('BTN', 'RAISE', 3), H('SB', 'FOLD'), H('BB', 'CALL', 2),
  H('BB', 'CHECK', undefined, 'FLOP'), H('BTN', 'BET', 2.5, 'FLOP'), H('BB', 'CALL', 2.5, 'FLOP'),
  H('BB', 'CHECK', undefined, 'TURN'), H('BTN', 'BET', 7.5, 'TURN'), H('BB', 'CALL', 7.5, 'TURN'),
  H('BB', 'BET', riverBetBB, 'RIVER'),
];
function inputFor(riverBetBB: number, profile: string): ManualHandInput {
  return {
    tableSize: 6, heroPosition: 'BTN', heroCards: [...HERO], board: [...BOARD], street: 'RIVER',
    effectiveStackBB: 100, bigBlindBB: 2,
    seatStacksBB: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 },
    actionHistory: hist(riverBetBB).map((x) => ({ ...x })), environment: 'MID_LOW_STAKES',
    villain: { quickProfile: profile, dynamicHint: 'UNKNOWN', stackBB: 100 },
  } as unknown as ManualHandInput;
}

function run(profile: string, riverBetBB: number) {
  const input = inputFor(riverBetBB, profile);
  const parsed = parseManualInput(input);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues[0]));
  const gate = buildAnalyzableState(parsed.value);
  if (!gate.ok) throw new Error(JSON.stringify(gate.issues[0]));
  const ctx = buildDecisionContext({
    state: gate.state, rules: RULES, environment: 'MID_LOW_STAKES', asOf: 1_757_000_000_000,
    quickProfile: profile as never, equitySeed: SEED,
  }).context as unknown as Record<string, any>;
  const ana = analyzeManualHand(input, { rules: RULES, asOf: 1_757_000_000_000, writeLog: false, equitySeed: SEED, budget: { softMs: 120_000, hardMs: 240_000 } });
  const decision = ana.ok ? (ana.decision as unknown as Record<string, any>) : null;
  return { ctx, decision, facts: ctx['postflopFacts'] as Record<string, any>, math: ctx['math'] as Record<string, any> };
}

/* ============================================================
 * 主验收：AK 河牌面对 40 筹码领打
 * ============================================================ */
line('='.repeat(118));
line(' 第七阶段验收：Hero BTN A♠K♠ ／ Board K♦9♣4♥6♠2♦ ／ BB 河牌领打 40（底池 53，下注后 93）');
line('='.repeat(118));
line('');

const r = run('CALLING_STATION', 20);
const m = r.math;
const bf = r.facts['bettingRangeFacts'];
const arr = r.facts['betRangeArrival'];
const sizing = r.facts['betRangeSizing'];

line('【1】真 正 的 河 牌 下 注 前 到 达 范 围（RIVER BET RANGE V2 新增，可证伪：不随下注尺寸变化）');
line(`  支撑组合数 supportCount = ${arr['supportCount']}｜到达质量 arrivalMass = ${p6(arr['arrivalMass'])}`);
line(`  EqVsArrivalRange = ${p6(arr['heroEquityVsArrivalRange'])}`);
line(`  被排除出到达范围的动作：${arr['excludedActionZh']}`);
line(`  说明：${arr['noteZh']}`);
line('');
line('  到达范围的**公共强度带**质量（权重真正依据的那把尺子）：');
for (const b of PUBLIC_STRENGTH_BAND_ORDER) {
  line(`    ${pad(PUBLIC_STRENGTH_BAND_ZH[b], 24)} ${pct(arr['bandMasses']?.[b], 3)}`);
}
line('');

line('【2】当 前 40 筹 码 对 应 的 下 注 范 围');
line(`  尺寸：实际 ${p4(sizing['actualRatio'])} 池 / 建模 ${p4(sizing['modeledRatio'])} 池｜SIZE_APPROXIMATION = ${sizing['sizeApproximation']}`);
line(`  组合数 ${bf['entryCount']}｜下注质量 ${p6(bf['betMass'])}｜他会下注的比例 ${pct(bf['betShareOfArrival'], 3)}`);
line(`  EqVsBetRange = ${p6(r.facts['heroEquityVsBetRange'])}`);
line(`  权重模型：${bf['model']['kind']}｜证据等级 ${bf['model']['evidence']}｜非退化 ${bf['model']['nonDegenerate']}｜读 Hero 隐藏底牌 = ${bf['model']['usesHeroHiddenCards']}`);
line(`  ${bf['model']['noteZh']}`);
line('');

line('【3】逐 牌 型：到 达 权 重 vs 下 注 后 权 重 + P(BET|带)');
line(pad('公共强度带', 26) + pad('到达权重', 12) + pad('P(BET | 带)', 14) + pad('下注权重', 12) + pad('质量比(下注/到达)', 18) + '下注质量');
for (const b of PUBLIC_STRENGTH_BAND_ORDER) {
  const a = arr['bandMasses']?.[b] ?? 0;
  const rate = bf['bandRates'][b];
  const bet = bf['bandMasses']['bet'][b];
  line(pad(PUBLIC_STRENGTH_BAND_ZH[b], 26) + pad(pct(a, 3), 12) + pad(p6(rate), 14) + pad(pct(bet, 3), 12) +
    pad(a > 0 ? (bet / a).toFixed(4) : '—', 18) + pct(a * rate, 4));
}
line('');

line('【4】与 Hero 的关系（仅用于解释，不参与任何权重）');
line(`  价值质量 ${pct(bf['classMasses']['valueMass'], 3)}｜摊牌质量 ${pct(bf['classMasses']['showdownMass'], 3)}｜诈唬质量 ${pct(bf['classMasses']['bluffMass'], 3)}｜未分类 ${pct(bf['classMasses']['unclassifiedMass'], 3)}`);
line('');

line('【5】EV 与 最 终 动 作');
const foldEV = 0;
line(`  pot = ${m['pot']}｜callCost = ${m['callCost']}｜winnable = ${m['winnable']}｜requiredEquity = ${p4(m['requiredEquity'])}`);
line(`  math.heroEquity（链条整体范围口径，决策层既有用法）= ${p6(m['heroEquity'])}`);
line(`  EqVsArrivalRange = ${p6(arr['heroEquityVsArrivalRange'])}`);
line(`  EqVsBetRange     = ${p6(m['heroEquityVsBetRange'])}`);
line(`  CALL EV = EqVsBetRange × winnable − callCost = ${p6(m['callEV'])}`);
line(`  FOLD EV = ${foldEV}`);
line(`  最终动作 = ${String(r.decision?.['action'])}${r.decision?.['sizeChips'] ? `（${r.decision['sizeChips']}）` : ''}`);
const reasons = (r.decision?.['reasons'] ?? []) as any[];
line('  决策依据（前 6 条）：');
for (const reason of reasons.slice(0, 6)) {
  line(`    · [${reason.code}] ${String(reason.textZh).slice(0, 150)}`);
}
line('');

/* ---------- 逐组合证据（用产品同一条链的到达范围复算，链已在敏感性脚本中逐位校验） ---------- */
line('【6】下注范围逐组合（到达权重 × P(BET|带) = 下注权重；HeroEq = Hero 对该组合的胜率）');
{
  const { buildRangeSnapshot, buildPlayerSnapshot, boardAtStreetOf } = await import('./__shadow-contextBuilder.ts');
  const { behaviorProfileOf } = await import('../src/domain/player/behaviorProfile.ts');
  const { quickProfileToLimperArchetype } = await import('../src/app/manualInput/limpIsolation.ts');
  const parsed = parseManualInput(inputFor(20, 'CALLING_STATION'));
  const state = buildAnalyzableState(parsed.ok ? parsed.value : (null as never));
  if (parsed.ok && state.ok) {
    const s = state.state;
    const opp = s.players.find((p) => p.id === 'seat_BB')!;
    const pbu = buildPlayerSnapshot('seat_BB' as never, undefined as never, 'CALLING_STATION' as never, 'UNKNOWN' as never, (st: never) => boardAtStreetOf(s, st));
    let bi = -1;
    for (let i = s.actions.length - 1; i >= 0; i -= 1) {
      const a = s.actions[i]!;
      if (a.street === s.street && (a.type === 'BET' || a.type === 'RAISE' || a.type === 'RERAISE' || a.type === 'ALL_IN')) { bi = i; break; }
    }
    const b = buildRangeSnapshot(s, opp as never, [...HERO_CARDS, ...BOARD_CARDS] as never, undefined,
      pbu.tendency as never, { archetype: quickProfileToLimperArchetype('CALLING_STATION'), confidence: pbu.confidence } as never,
      (behaviorProfileOf({ playerId: 'seat_BB', archetype: 'CALLING_STATION' as never }) ?? null) as never, bi);
    const arrivalEntries = (b.rangeBeforeAction ?? b.range)!.entries;
    const rows = arrivalEntries
      .filter((e: any) => e.probability > 0)
      .map((e: any) => {
        const hole = [ALL_CARDS[e.combo.cardIndices[0]]!, ALL_CARDS[e.combo.cardIndices[1]]!] as const;
        const band = publicStrengthBandOf([hole[0], hole[1]], BOARD_CARDS)!;
        const rate = bf['bandRates'][band] as number;
        const cmp = compareHands(evaluateCards([...hole, ...BOARD_CARDS]), heroEval);
        return {
          hand: `${cardZh(hole[0])}${cardZh(hole[1])}`,
          strength: handDescriptionText(describeHand([hole[0], hole[1]], BOARD_CARDS)),
          band, arrival: e.probability as number, rate, betW: (e.probability as number) * rate,
          heroEq: cmp > 0 ? 0 : cmp < 0 ? 1 : 0.5,
        };
      })
      .sort((x: any, y: any) => y.betW - x.betW);
    line(pad('Hand', 10) + pad('Strength', 20) + pad('公共强度带', 22) + pad('到达W', 12) + pad('P(BET)', 10) + pad('下注W', 12) + pad('归一化', 10) + 'HeroEq');
    for (const r of rows.slice(0, 24)) {
      line(pad(r.hand, 10) + pad(r.strength.slice(0, 18), 20) + pad(PUBLIC_STRENGTH_BAND_ZH[r.band], 22) +
        pad(r.arrival.toExponential(3), 12) + pad(r.rate.toFixed(6), 10) + pad(r.betW.toExponential(3), 12) +
        pad((r.betW / bf['betMass']).toFixed(6), 10) + r.heroEq.toFixed(2));
    }
    line(`  （共 ${rows.length} 个正权组合；上表按下注权重降序取前 24。完整表见单元测试 D-3 / M2 的逐组合接口）`);
  }
}
line('');

/* ---------- 可证伪性：到达范围不随尺寸变化 ---------- */
line('【7】可证伪性检验（M1/M6）：只改当前下注尺寸');
line(pad('下注额', 10) + pad('到达范围权益', 18) + pad('到达带质量(顶对好踢)', 22) + pad('EqVsBetRange', 16) + pad('CALL EV', 12) + '动作');
for (const bb of [20, 8, 4]) {
  const x = run('CALLING_STATION', bb);
  const a = x.facts['betRangeArrival'];
  line(pad(`${bb * 2}`, 10) + pad(p6(a['heroEquityVsArrivalRange']), 18) +
    pad(pct(a['bandMasses']?.['TOP_PAIR_GOOD'], 4), 22) +
    pad(p6(x.math['heroEquityVsBetRange']), 16) + pad(p4(x.math['callEV']), 12) + String(x.decision?.['action']));
}
line('  ⇒ 到达范围两组必须逐位相同（它不知道下注额）；下注范围必须随尺寸变化。');
line('');

/* ---------- 画像对照 ---------- */
line('【8】画像对照（P(BET | 公共强度带) 的画像敏感性）');
line(pad('画像', 18) + pad('强价值', 10) + pad('两对', 10) + pad('顶对好', 10) + pad('顶对弱', 10) + pad('中对', 10) + pad('弱对', 10) + pad('空气', 10) + pad('EqVsBetRange', 14) + '动作');
for (const profile of ['NORMAL', 'CALLING_STATION', 'MANIAC', 'VERY_TIGHT']) {
  const x = run(profile, 20);
  const rates = x.facts['bettingRangeFacts']['bandRates'];
  line(pad(profile, 18) + pad(p6(rates['STRONG_MADE']), 10) + pad(p6(rates['TWO_PAIR']), 10) +
    pad(p6(rates['TOP_PAIR_GOOD']), 10) + pad(p6(rates['TOP_PAIR_WEAK']), 10) + pad(p6(rates['MIDDLE_PAIR']), 10) +
    pad(p6(rates['WEAK_PAIR']), 10) + pad(p6(rates['AIR']), 10) +
    pad(p6(x.math['heroEquityVsBetRange']), 14) + String(x.decision?.['action']));
}
line('');
line('【9】独立复算（同一次范围计算的一致性，M9）');
{
  const betEntries = (r.facts as any)['__entries'] as unknown;
  void betEntries;
  const eqBet = r.math['heroEquityVsBetRange'] as number;
  const winnable = m['winnable'] as number;
  const call = m['callCost'] as number;
  line(`  CALL EV 恒等式：EqVsBetRange × winnable − callCost = ${p6(eqBet * winnable - call)} vs math.callEV = ${p6(m['callEV'])} ⇒ ${Math.abs(eqBet * winnable - call - (m['callEV'] as number)) < 1e-9 ? '一致' : '不一致'}`);
  line(`  门槛恒等式：requiredEquity × winnable = ${p6((m['requiredEquity'] as number) * winnable)} vs callCost = ${call}`);
  void computeEquity; void EquityComputeMode;
}
