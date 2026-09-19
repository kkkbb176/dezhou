/**
 * TEST 17 · 只读探针 C：`boardTexture` 的定义、计算路径与杠杆（不改任何代码）
 *
 * 牌局 = TEST 17 原始牌局（BTN A♣J♣，公共牌 J♦8♣4♣6♠，转牌面对 BB 20 领打）。
 *
 * 输出：
 *  1. `boardTextureOf` 的结构事实（为什么 J♦8♣4♣6♠ 被判 DRY）
 *  2. 生产下注范围模型实际使用的纹理与系数
 *  3. 反事实：同一维度下换纹理 ⇒ 带速率与 `betMass` 会变多少
 *     （权重用生产自报的**到达带质量**，因此是同一到达范围内的可比量）
 */
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';
import { parseManualInput, type ManualHandInput, type ManualVillain } from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import { boardTextureOf } from '../src/domain/postflop/boardDelta.ts';
import { boardTextureLabelOf } from '../src/domain/postflop/riverProfileClassify.ts';
import { boardWetnessOf } from '../src/domain/postflop/rangeCompression.ts';
import { betProbabilityByBand } from '../src/app/manualInput/bettingRange.ts';
import { responseTendenciesOf } from '../src/domain/postflop/betResponse.ts';
import { parseCardStrict } from '../src/domain/poker/cards.ts';

const OPTIONS = {
  rules: loadKnowledgeBaseOrThrow().allRules(), asOf: 1_757_000_000_000, writeLog: false,
  equitySeed: 20_260_913, budget: { softMs: 120_000, hardMs: 240_000 },
} as const;
const A_ = (position: string, type: string, amountBB?: number, street?: string): Record<string, unknown> => ({
  position, type, ...(amountBB === undefined ? {} : { amountBB }), ...(street === undefined ? {} : { street }),
});
const villain: ManualVillain = {
  seatId: 'seat_BB', persistentPlayerId: 'player_ahaohao', displayName: '阿豪', quickProfile: 'MANIAC', dynamicHint: 'UNKNOWN', stackBB: 100,
  observedStats: { handsObserved: 800, vpip: 0.48, pfr: 0.35, threeBet: 0.16, wtsd: 0.36, foldToFlopCBet: null, foldToTurnCBet: null, foldToRiverBet: null, flopCheckRaise: null, turnCheckRaise: null, riverCheckRaise: null },
};
const input = {
  tableSize: 6, heroPosition: 'BTN', heroCards: ['Ac', 'Jc'], board: ['Jd', '8c', '4c', '6s'], street: 'TURN',
  effectiveStackBB: 100, bigBlindBB: 2,
  seatStacksBB: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 },
  actionHistory: [
    A_('UTG', 'FOLD'), A_('HJ', 'FOLD'), A_('CO', 'FOLD'),
    A_('BTN', 'RAISE', 3), A_('SB', 'FOLD'), A_('BB', 'CALL', 2),
    A_('BB', 'CHECK', undefined, 'FLOP'), A_('BTN', 'BET', 4, 'FLOP'), A_('BB', 'CALL', 4, 'FLOP'),
    A_('BB', 'BET', 10, 'TURN'),
  ],
  environment: 'MID_LOW_STAKES', villain,
} as unknown as ManualHandInput;

const n = (v: unknown, d = 6): string => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : String(v));
const line = (s = ''): void => console.log(s);

const board = ['Jd', '8c', '4c', '6s'].map((s) => parseCardStrict(s));
line('=== 1 · 结构事实（boardTextureOf）===');
const facts = boardTextureOf(board)!;
line(JSON.stringify(facts, null, 1));
line(`  ⇒ suitCounts=${JSON.stringify(facts.suitCounts)}（maxSuitCount=${facts.maxSuitCount} ⇒ 四张同花 ${facts.fourToFlush}、同花可能 ${facts.flushPossible}）`);
line(`  ⇒ maxRunLength=${facts.maxRunLength}（≥4 四连张 ${facts.fourToStraight}；≥3 顺子可能 ${facts.straightPossible}）`);
line(`  ⇒ 成对 ${facts.pairedBoard}、三条 ${facts.tripsOnBoard}`);
line(`  ⇒ boardTextureLabelOf = **${String(boardTextureLabelOf(board))}** ｜ boardWetnessOf(facts) = ${n(boardWetnessOf(facts), 4)}`);
line('  判定顺序（riverProfileClassify.ts:72-82）：MONOTONE(单花≥3) → PAIRED(成对) → WET(四连/四花/两项同时) → SEMI_WET(单项) → DRY');
line('  本牌面：单花 2 张、无对子、最长连张 1 ⇒ 四档全部不成立 ⇒ **DRY（结构上「无三连张、无三张同花、无对子」）**');

line('');
line('=== 2 · 生产实际使用的纹理与系数 ===');
const r = analyzeManualHand(input, OPTIONS);
if (!r.ok) { line(`分析失败 ${r.stage}`); process.exit(1); }
const dg = (r.decision as unknown as Record<string, any>)['diagnostics'] as Record<string, any>;
const pf = dg['postflop'] as Record<string, any>;
const br = pf['bettingRangeFacts'] as Record<string, any>;
const model = br['model'] as Record<string, any>;
line(`  model.boardTexture = ${String(model['boardTexture'])} ｜ ratioToPot = ${n(model['ratioToPot'], 6)}`);
line(`  factors: thin=${n(model['factors']['textureThin'], 4)} mid=${n(model['factors']['textureMid'], 4)}（DRY ⇒ 两者都是 1.1，即**薄价值与摊牌牌更爱下注**）`);
line(`  anchors: ${JSON.stringify(Object.fromEntries(Object.entries(model['anchors'] ?? {}).map(([k, v]) => [k, Number(v).toFixed(4)])))}`);
line(`  betMass（生产）= ${n(br['betMass'], 12)} ｜ 到达带质量 = ${JSON.stringify(Object.fromEntries(Object.entries(br['bandMasses']['arrival']).map(([k, v]) => [k, Number(v).toFixed(4)])))}`);

const p = parseManualInput(input);
const gate = buildAnalyzableState(p.value!);
const built = buildDecisionContext({
  state: gate.state, rules: OPTIONS.rules, environment: 'MID_LOW_STAKES', asOf: OPTIONS.asOf,
  quickProfile: 'MANIAC', dynamicHint: 'UNKNOWN', villainSeatId: 'seat_BB', villainPersistentPlayerId: 'player_ahaohao',
  observedStats: villain.observedStats, equitySeed: OPTIONS.equitySeed, budget: OPTIONS.budget,
} as never);
const v3 = (built.context as unknown as Record<string, any>)['profileV3'] as Record<string, any>;
/** 下注范围层实际吃到的维度（修复后 = V3 融合维度；该层不读 confidence） */
const bandDims = { ...v3['resolvedDimensions'] };
const tendencies = responseTendenciesOf(bandDims as never, 1, null);

line('');
line('=== 3 · 反事实：同一维度、同一到达范围，只换纹理档 ===');
const arrival = br['bandMasses']['arrival'] as Record<string, number>;
const productionRates = br['bandRates'] as Record<string, number>;
const productionMass = br['betMass'] as number;
line('  纹理档        价值锚    薄价值锚   摊牌锚     带速率(AIR/TOP_PAIR_GOOD/STRONG)              反算 betMass   相对生产');
for (const texture of [null, 'DRY', 'PAIRED', 'WET', 'MONOTONE', 'SEMI_WET'] as const) {
  const probe = betProbabilityByBand({ tendencies, ratioToPot: model['ratioToPot'] as number, boardTexture: texture });
  const rates = probe.rates as unknown as Record<string, number>;
  const cfMass = Object.keys(arrival).reduce((s, b) => s + (arrival[b] ?? 0) * (rates[b] ?? 0), 0);
  line(
    `  ${String(texture ?? 'null(不调整)').padEnd(12)}${n(probe.anchors.value, 4).padStart(8)}${n(probe.anchors.thin, 4).padStart(10)}${n(probe.anchors.showdown, 4).padStart(10)}` +
    `   ${n(rates['AIR'], 4)} / ${n(rates['TOP_PAIR_GOOD'], 4)} / ${n(rates['STRONG_MADE'], 4)}`.padEnd(34) +
    `${n(cfMass, 12).padStart(14)}${`${((cfMass / productionMass - 1) * 100).toFixed(2)}%`.padStart(12)}`,
  );
}
line('  ⚠️ 上表权重用的是**生产自报的到达带质量**（同一到达范围）⇒ 差异只来自纹理系数；');
line('     `betMass` 反算值与生产值一致即说明该反算口径可用（生产 betMass 见上）。');
line(`  一致性自检：DRY 行反算 = ${n(Object.keys(arrival).reduce((s, b) => s + (arrival[b] ?? 0) * (productionRates[b] ?? 0), 0), 12)} vs 生产 ${n(productionMass, 12)}`);
line('');
line('  纹理档 → 参与位置（代码级，见报告）：');
line('   · 到达范围更新：**不参与**（本轮节点为 TURN；`behaviorNodeOf` 只在 `record.street === RIVER` 被调用）');
line('   · 主动下注范围加权：**参与**（`bettingRange.ts:699` → `textureThin/textureMid`）');
line('   · 加注响应概率：**不参与**（`buildRaiseResponse` 入参无纹理；`RAISE_RESPONSE_BAND_STRENGTH` 为固定表）');
line('   · 条件权益/EV：**间接参与**（纹理 → 带速率 → 下注范围权重 → EqVsBetRange → CALL EV / RAISE EV 的加注桶）');
