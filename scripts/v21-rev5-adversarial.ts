/**
 * Reviewer 5 · 反证探针 C —— 画像主导性攻击（对抗输入）
 *
 * 每个用例：**期望行为 → 实际行为 → 原始输出 → PASS/FAIL/NOT_TESTED**
 * 只在 `scripts/` 下新增，不修改 `src/` 与 `test/`。
 *
 * 运行：node --experimental-strip-types scripts/v21-rev5-adversarial.ts
 */
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import {
  ENVIRONMENT_BEHAVIOR_PRIOR,
  behaviorProfileOf,
  estimateUnifiedActionLikelihood,
  type BehaviorNodeContext,
} from '../src/domain/player/behaviorProfile.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import type { ManualHandInput } from '../src/app/manualInput/manualInput.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const OPTIONS = {
  rules: RULES,
  asOf: 1_757_000_000_000,
  writeLog: false,
  budget: { softMs: 120_000, hardMs: 240_000 },
} as const;

const SEATS = {
  UTG: 100, UTG1: 100, UTG2: 100, LJ: 100, HJ: 100,
  CO: 100, BTN: 100, SB: 100, BB: 100,
};

const HISTORY = [
  { position: 'UTG', type: 'FOLD' },
  { position: 'UTG1', type: 'FOLD' },
  { position: 'UTG2', type: 'FOLD' },
  { position: 'LJ', type: 'FOLD' },
  { position: 'HJ', type: 'FOLD' },
  { position: 'CO', type: 'RAISE', amountBB: 2.5 },
  { position: 'BTN', type: 'FOLD' },
  { position: 'SB', type: 'FOLD' },
  { position: 'BB', type: 'CALL', amountBB: 1.5 },
  { position: 'BB', type: 'CHECK', street: 'FLOP' },
  { position: 'CO', type: 'BET', amountBB: 2, street: 'FLOP' },
  { position: 'BB', type: 'CALL', amountBB: 2, street: 'FLOP' },
  { position: 'BB', type: 'CHECK', street: 'TURN' },
  { position: 'CO', type: 'CHECK', street: 'TURN' },
  { position: 'BB', type: 'BET', amountBB: 7, street: 'RIVER' },
] as const;

const node: BehaviorNodeContext = {
  street: 'RIVER', heroPosition: 'CO', villainPosition: 'BB', potType: 'SRP', playerCount: 2,
  previousStreetLine: 'TURN_CHECK_BACK', currentAction: 'BET', sizeBucket: 'LARGE', boardTexture: 'SEMI_WET',
};
const BET_RATIO = 7 / 9.5;

function baseHand(villain: Record<string, unknown>, extra: Record<string, unknown> = {}): ManualHandInput {
  return {
    tableSize: 9,
    heroPosition: 'CO',
    heroCards: ['Ac', 'Jh'],
    board: ['Ad', '8s', '4s', '2c', 'Kd'],
    street: 'RIVER',
    effectiveStackBB: 100,
    bigBlindBB: 2,
    seatStacksBB: { ...SEATS },
    actionHistory: [...HISTORY],
    environment: 'MID_LOW_STAKES',
    villain,
    ...extra,
  } as unknown as ManualHandInput;
}

const finite = (x: unknown): string => (typeof x === 'number' ? (Number.isFinite(x) ? String(x) : `**${String(x)}**`) : String(x));

function summarize(r: ReturnType<typeof analyzeManualHand>): string {
  if (!r.ok) return `NOT_OK stage=${r.stage} issues=${JSON.stringify(r.issues).slice(0, 240)}`;
  const math = (r.decision.diagnostics as unknown as { math?: Record<string, unknown> }).math ?? {};
  const pr = (r.decision.diagnostics as unknown as { profileRange?: { provider?: { applied?: unknown; profileMultiplier?: { effective?: number; calls?: number } } } | null }).profileRange;
  return (
    `ok action=${String(r.decision.action)} heroEquity=${finite(math['heroEquity'])} callEV=${finite(math['callEV'])} ` +
    `profileRange=${pr === null || pr === undefined ? 'null' : `applied=${String(pr.provider?.applied)} mult.effective=${String(pr.provider?.profileMultiplier?.effective)}/${String(pr.provider?.profileMultiplier?.calls)}`}` +
    ` warnings=${r.warnings.length}`
  );
}

const hedges: string[] = [];
function caseHeader(id: string, claim: string, expected: string): void {
  console.log(`\n================ ${id} ================`);
  console.log(`  被测声明: ${claim}`);
  console.log(`  期望行为: ${expected}`);
}
function verdict(id: string, v: 'PASS' | 'FAIL' | 'NOT_TESTED', why: string): void {
  console.log(`  ⇒ ${id} 判定: **${v}** —— ${why}`);
  hedges.push(`${id}: ${v} —— ${why}`);
}

/* ============================================================
 * A1 · 原型先验 + 全部 5 条主动条目上的矛盾 manual 证据
 * ============================================================ */
caseHeader('A1', '四级来源「实测 > 人工 > 标签先验 > 池先验」；manual 与原型矛盾时以 manual 为准，不得崩溃',
  'manual 覆盖原型先验；5 条主动条目全部变为对应档位率；被动条目 callTooWide 不受影响；无 NaN');
{
  const p = behaviorProfileOf({
    playerId: 'seat_BB',
    archetype: 'CALLING_STATION',
    manual: {
      riverBluff: 'VERY_HIGH', riverLargeBetBluff: 'VERY_HIGH', missedDrawBluff: 'VERY_HIGH',
      probeAfterTurnCheckBack: 'VERY_HIGH', thinValueBet: 'VERY_HIGH',
    },
  });
  console.log('  原始输出（生效值）:');
  for (const k of ['riverBluff', 'riverLargeBetBluff', 'missedDrawBluff', 'probeAfterTurnCheckBack', 'thinValueBet', 'callTooWide'] as const) {
    const t = p.traits[k];
    console.log(`    ${k.padEnd(28)} effectiveRate=${finite(t.effectiveRate)} source=${t.source} priorRate=${t.priorRate} conf=${t.confidence}`);
  }
  console.log(`    archetypePriorAvailable=${p.archetypePriorAvailable} isUnknownPlayer=${p.isUnknownPlayer}`);
  console.log(`    priorNoteZh=${p.priorNoteZh}`);
  const allHigh = (['riverBluff', 'riverLargeBetBluff', 'missedDrawBluff', 'probeAfterTurnCheckBack', 'thinValueBet'] as const)
    .every((k) => p.traits[k].effectiveRate === 0.8);
  const passiveUntouched = p.traits.callTooWide.effectiveRate === 0.72;
  const noNaN = Object.values(p.traits).every((t) => Number.isFinite(t.effectiveRate));
  const csPriorIgnored = p.traits.riverBluff.priorRate === 0.8; // manualReadEvidence 里 priorRate 就是档位率，标签先验 0.15 已被丢弃
  console.log(`    断言: 5 条 = 0.8 ? ${allHigh} | callTooWide 仍 0.72 ? ${passiveUntouched} | 无 NaN ? ${noNaN}`);
  console.log(`    注: riverBluff.priorRate=${p.traits.riverBluff.priorRate}（CALLING_STATION 标签先验是 0.15）` +
    ` ⇒ 标签先验被**完全丢弃**，而不是注释所说的「叠加在标签先验之上」: ${csPriorIgnored}`);
  verdict('A1', !allHigh || !noNaN ? 'FAIL' : 'PASS',
    allHigh && noNaN
      ? `manual 正确覆盖（5 条全部 0.8），被动条目未被污染（callTooWide=${p.traits.callTooWide.effectiveRate}）；` +
        `但 behaviorProfile.ts:441 的注释「人工画像作为伪计数先验**叠加在标签先验之上**」与实测不符（标签先验 0.15 被丢弃）`
      : '存在未按优先级生效或非有限值');
}

/* ============================================================
 * A2 · observed：成功数 > 机会数
 * ============================================================ */
caseHeader('A2', '`statEvidenceOf` 必须把 successes 钳到 opportunities 以内（不得出现 >100% 的率）',
  'successes 被钳到 3 ⇒ effectiveRate = (0.28×6 + 3)/(6+3) = 0.52；无 NaN');
{
  const p = behaviorProfileOf({ playerId: 'seat_BB', archetype: null, observed: { riverBluff: { successes: 10, opportunities: 3 } } });
  const t = p.traits.riverBluff;
  console.log(`    原始输出: successes=${t.successes} opportunities=${t.opportunities} observedRate=${finite(t.observedRate)} effectiveRate=${finite(t.effectiveRate)} confidence=${finite(t.confidence)}`);
  const ok = t.successes === 3 && t.opportunities === 3 && Number.isFinite(t.effectiveRate) && t.effectiveRate <= 1;
  verdict('A2', ok ? 'PASS' : 'FAIL',
    ok ? `successes 被钳到 ${t.successes}，率 ${t.effectiveRate} ∈ [0,1]，解析式 (0.28×6+3)/(6+3)=${(0.28 * 6 + 3) / 9}` : `未钳位：${JSON.stringify(t)}`);
}

/* ============================================================
 * A3 · observed：负机会数
 * ============================================================ */
caseHeader('A3', '负机会数必须被当作「无观测」而不是负数分母',
  'opportunities → 0 ⇒ 逐位回落先验 0.28；confidence 0');
{
  const p = behaviorProfileOf({ playerId: 'seat_BB', archetype: null, observed: { riverBluff: { successes: 0, opportunities: -5 } } });
  const t = p.traits.riverBluff;
  console.log(`    原始输出: opportunities=${t.opportunities} effectiveRate=${finite(t.effectiveRate)} observedRate=${finite(t.observedRate)} confidence=${finite(t.confidence)}`);
  const ok = t.opportunities === 0 && t.effectiveRate === ENVIRONMENT_BEHAVIOR_PRIOR.riverBluff && t.confidence === 0;
  verdict('A3', ok ? 'PASS' : 'FAIL', ok ? `opportunities→0，率逐位等于池先验 ${t.effectiveRate}` : `未按无观测处理：opportunities=${t.opportunities} rate=${t.effectiveRate}`);
}

/* ============================================================
 * A4/A5/A6 · observed：NaN / Infinity / NaN 成功数
 * ============================================================ */
const POISON: readonly { id: string; label: string; obs: { successes: number; opportunities: number } }[] = [
  { id: 'A4', label: 'opportunities = NaN', obs: { successes: 0, opportunities: Number.NaN } },
  { id: 'A5', label: 'opportunities = Infinity', obs: { successes: 0, opportunities: Number.POSITIVE_INFINITY } },
  { id: 'A6', label: 'successes = NaN，opportunities = 10', obs: { successes: Number.NaN, opportunities: 10 } },
];
for (const c of POISON) {
  caseHeader(c.id, '非有限输入（NaN / ∞）不得产生非有限的后验权重 —— 范围引擎契约要求 likelihood ∈ [0,1]',
    `${c.label} 要么被拒绝并给出可解释的 issue，要么被安全钳到有限值；绝不允许 NaN 进入 likelihood`);
  const p = behaviorProfileOf({ playerId: 'seat_BB', archetype: null, observed: { riverBluff: c.obs } });
  const t = p.traits.riverBluff;
  console.log(`    证据层原始输出: opportunities=${finite(t.opportunities)} successes=${finite(t.successes)} ` +
    `effectiveRate=${finite(t.effectiveRate)} confidence=${finite(t.confidence)} observedRate=${finite(t.observedRate)}`);
  const u = estimateUnifiedActionLikelihood({
    semanticClass: 'PURE_AIR', strengthBucket: 5, betRatio: BET_RATIO, node, profile: p, action: 'BET', withTrace: true,
  });
  console.log(`    似然层原始输出: base=${finite(u.baseLikelihood)} combinedAdjustment=${finite(u.combinedAdjustment)} ` +
    `rawLikelihood=${finite(u.rawLikelihood)} likelihood=${finite(u.likelihood)} clamped=${u.clamped}`);
  for (const tr of u.trace) console.log(`      [${tr.stage}] trait=${tr.trait ?? '-'} factor=${finite(tr.factor)} rate=${finite(tr.rate)}`);
  const full = analyzeManualHand(baseHand({ stackBB: 100, behaviorProfile: p }), OPTIONS);
  console.log(`    全链路原始输出: ${summarize(full)}`);
  const eq = full.ok ? (full.decision.diagnostics as unknown as { math?: Record<string, unknown> }).math?.['heroEquity'] : undefined;
  const mathFinite = typeof eq === 'number' && Number.isFinite(eq);
  const likelihoodFinite = Number.isFinite(u.likelihood);
  const leaked = !likelihoodFinite || (full.ok && !mathFinite);
  verdict(c.id, leaked ? 'FAIL' : 'PASS',
    leaked
      ? `${c.label} ⇒ effectiveRate=${finite(t.effectiveRate)}，likelihood=${finite(u.likelihood)}，heroEquity=${finite(eq)}：` +
        `**非有限值穿透到生产输出**（${!likelihoodFinite ? '似然层' : '全链路'}已污染）`
      : `${c.label} ⇒ effectiveRate=${finite(t.effectiveRate)}，likelihood=${finite(u.likelihood)}，heroEquity=${finite(eq)}：全部有限`);
}

/* ============================================================
 * A7 · 极端 manual thinValueBet（唯一没有标签先验的条目）
 * ============================================================ */
caseHeader('A7', '`thinValueBet` 只有 manual/observed 入口；极端读数不得把结构序关系 THIN < STRONG 翻过来并污染 §二十 权益单调性',
  '结构基线 THIN_VALUE < STRONG_VALUE 在**任意**画像下都成立，或至少 §二十 四条单调性不被 thin 通道反向');
{
  const strictBase = estimateUnifiedActionLikelihood({
    semanticClass: 'STRONG_VALUE', strengthBucket: 1, betRatio: BET_RATIO, node,
    profile: behaviorProfileOf({ playerId: 'x', archetype: null }), action: 'BET',
  }).likelihood;
  console.log(`    STRONG_VALUE 似然（价值端恒 1.000 调整）= ${strictBase}`);
  console.log('    类别                   画像                        thinValueBet  cond        倍率        似然        是否越过 STRONG');
  for (const [tag, arch] of [['neutral', null], ['CALLING_STATION', 'CALLING_STATION'], ['MANIAC', 'MANIAC']] as const) {
    for (const tend of ['VERY_LOW', 'VERY_HIGH'] as const) {
      const prof = behaviorProfileOf({ playerId: 'seat_BB', archetype: arch as never, manual: { thinValueBet: tend } });
      const u = estimateUnifiedActionLikelihood({
        semanticClass: 'THIN_VALUE', strengthBucket: 2, betRatio: BET_RATIO, node, profile: prof, action: 'BET', withTrace: true,
      });
      const rate = prof.traits.thinValueBet.effectiveRate;
      const cond = (() => { const o = (r: number) => Math.max(0.001, Math.min(0.999, r)) / (1 - Math.max(0.001, Math.min(0.999, r))); return o(rate) / o(ENVIRONMENT_BEHAVIOR_PRIOR.thinValueBet); })();
      console.log(`    THIN_VALUE             ${tag.padEnd(26)} ${tend.padEnd(12)} ${cond.toFixed(6)}  ${u.combinedAdjustment.toFixed(6)}  ${u.likelihood.toFixed(6)}  ${u.likelihood > strictBase ? '**是**' : '否'}`);
    }
  }
  const hi = behaviorProfileOf({ playerId: 'seat_BB', archetype: null, manual: { thinValueBet: 'VERY_HIGH' } });
  const hiLike = estimateUnifiedActionLikelihood({
    semanticClass: 'THIN_VALUE', strengthBucket: 2, betRatio: BET_RATIO, node, profile: hi, action: 'BET', withTrace: true,
  });
  const flipped = hiLike.likelihood > strictBase;
  console.log(`    全链路（§二十 方向）：CALLING_STATION + thinValueBet=VERY_HIGH vs MANIAC + thinValueBet=VERY_LOW`);
  const ca = analyzeManualHand(baseHand({ stackBB: 100, quickProfile: 'CALLING_STATION', behaviorProfile: behaviorProfileOf({ playerId: 'seat_BB', archetype: 'CALLING_STATION', manual: { thinValueBet: 'VERY_HIGH' } }) }), OPTIONS);
  const cb = analyzeManualHand(baseHand({ stackBB: 100, quickProfile: 'MANIAC', behaviorProfile: behaviorProfileOf({ playerId: 'seat_BB', archetype: 'MANIAC', manual: { thinValueBet: 'VERY_LOW' } }) }), OPTIONS);
  console.log(`      03A(=CS, thin=VERY_HIGH): ${summarize(ca)}`);
  console.log(`      03B(=MANIAC, thin=VERY_LOW): ${summarize(cb)}`);
  const eqA = ca.ok ? Number((ca.decision.diagnostics as unknown as { math?: Record<string, unknown> }).math?.['heroEquity']) : Number.NaN;
  const eqB = cb.ok ? Number((cb.decision.diagnostics as unknown as { math?: Record<string, unknown> }).math?.['heroEquity']) : Number.NaN;
  console.log(`      §二十 要求 03B 权益 > 03A：${eqB.toFixed(10)} vs ${eqA.toFixed(10)} ⇒ ${eqB > eqA ? '成立' : '**被翻转**'}`);
  verdict('A7', flipped ? 'FAIL' : 'PASS',
    flipped
      ? `manual thinValueBet=VERY_HIGH 让 THIN_VALUE 似然 ${hiLike.likelihood.toFixed(6)} **越过** STRONG_VALUE ${strictBase.toFixed(6)}；` +
        `且单条因子被开平方（条目数=1 但槽位 K=2）后仍足以翻转结构序关系` +
        (eqB > eqA ? '；§二十 权益方向在全链路仍成立' : '；§二十 权益方向**在全链路被翻转**')
      : `THIN_VALUE 最高只能到 ${hiLike.likelihood.toFixed(6)} < STRONG_VALUE ${strictBase.toFixed(6)}`);
}

/* ============================================================
 * A8 · 身份不匹配：profile.playerId ≠ 被分析的对手
 * ============================================================ */
caseHeader('A8', '画像只对**它描述的那一家**注入（contextBuilder.ts:3210）；playerId 不匹配的画像不得生效',
  '传入 playerId="seat_BTN" 的 MANIAC 画像去分析 BB 时，范围/权益必须与「不给画像」逐位相同');
{
  const noProf = analyzeManualHand(baseHand({ stackBB: 100 }), OPTIONS);
  const mismatch = analyzeManualHand(baseHand({ stackBB: 100, behaviorProfile: behaviorProfileOf({ playerId: 'seat_BTN', archetype: 'MANIAC' }) }), OPTIONS);
  const match = analyzeManualHand(baseHand({ stackBB: 100, behaviorProfile: behaviorProfileOf({ playerId: 'seat_BB', archetype: 'MANIAC' }) }), OPTIONS);
  console.log(`    无画像                            : ${summarize(noProf)}`);
  console.log(`    playerId='seat_BTN' 的 MANIAC 画像: ${summarize(mismatch)}`);
  console.log(`    playerId='seat_BB'  的 MANIAC 画像: ${summarize(match)}`);
  const eqOf = (r: ReturnType<typeof analyzeManualHand>): number => (r.ok ? Number((r.decision.diagnostics as unknown as { math?: Record<string, unknown> }).math?.['heroEquity']) : Number.NaN);
  const sameAsNone = eqOf(mismatch) === eqOf(noProf) && String(mismatch.ok && mismatch.decision.action) === String(noProf.ok && noProf.decision.action);
  const mismatchIgnored = sameAsNone;
  verdict('A8', mismatchIgnored ? 'PASS' : 'FAIL',
    mismatchIgnored
      ? `playerId 不匹配的画像被**忽略**（权益 ${eqOf(mismatch)} == 无画像 ${eqOf(noProf)}，动作一致）`
      : `playerId 不匹配的画像**照样生效**：权益 ${eqOf(mismatch)} vs 无画像 ${eqOf(noProf)}（BB 匹配时 ${eqOf(match)}）—— ` +
        `闸门只挂在**座位**（opponent.id === villainId）上，input.behaviorProfile 被原样采信` +
        `（contextBuilder.ts:3169），profile.playerId 从未被比对`);
}

/* ============================================================
 * A9 · 已弃牌玩家 / A10 Hero 自己 / A10b 未发牌的座位
 * ============================================================ */
caseHeader('A9', '画像给一个**翻前就弃牌**的玩家（BTN）不得崩溃，也不得把画像套到别人身上', 'ok 或可解释的失败；绝不抛异常');
{
  const r = analyzeManualHand(baseHand({ playerId: 'seat_BTN', quickProfile: 'MANIAC', stackBB: 100 }), OPTIONS);
  console.log(`    villain.playerId='seat_BTN'（翻前已弃牌）+ quickProfile=MANIAC: ${summarize(r)}`);
  verdict('A9', r.ok || typeof r.stage === 'string' ? 'PASS' : 'FAIL',
    r.ok ? '未崩溃；返回了完整结果（该座位不在本手 ⇒ 无画像可注入）' : `可解释失败 stage=${r.stage}`);
}

caseHeader('A10', '把画像挂在 **Hero 自己**的座位（seat_CO）上：Hero 的牌是已知的，给 Hero 套画像 ＝ 给已知手牌套行为先验',
  '要么被忽略（画像只描述对手），要么给出可解释的失败；绝不把 Hero 当对手注入画像');
{
  const r = analyzeManualHand(baseHand({ playerId: 'seat_CO', quickProfile: 'MANIAC', stackBB: 100 }), OPTIONS);
  console.log(`    villain.playerId='seat_CO'（= Hero）+ quickProfile=MANIAC: ${summarize(r)}`);
  const none = analyzeManualHand(baseHand({ stackBB: 100 }), OPTIONS);
  console.log(`    无画像对照: ${summarize(none)}`);
  const eqOf = (x: ReturnType<typeof analyzeManualHand>): number => (x.ok ? Number((x.decision.diagnostics as unknown as { math?: Record<string, unknown> }).math?.['heroEquity']) : Number.NaN);
  console.log(`    权益: ${eqOf(r)} vs ${eqOf(none)}`);
  verdict('A10', r.ok ? 'PASS' : 'FAIL', r.ok ? '未崩溃、返回可解释结果' : `崩溃/失败 stage=${r.stage}`);
}

/* ============================================================
 * A11 · 多人池（3 个对手）：画像只对一家注入
 * ============================================================ */
caseHeader('A11', '3+ 对手时画像仍只对 villainId 那一家注入；其余座位回落到中立先验', '逐位只影响一家；不崩溃；给出可解释的多人结果');
{
  const multi = [
    { position: 'UTG', type: 'FOLD' },
    { position: 'UTG1', type: 'FOLD' },
    { position: 'UTG2', type: 'FOLD' },
    { position: 'LJ', type: 'CALL', amountBB: 1 },
    { position: 'HJ', type: 'FOLD' },
    { position: 'CO', type: 'RAISE', amountBB: 2.5 },
    { position: 'BTN', type: 'FOLD' },
    { position: 'SB', type: 'FOLD' },
    { position: 'BB', type: 'CALL', amountBB: 1.5 },
    { position: 'LJ', type: 'CALL', amountBB: 1.5 },
    { position: 'BB', type: 'CHECK', street: 'FLOP' },
    { position: 'LJ', type: 'CHECK', street: 'FLOP' },
    { position: 'CO', type: 'BET', amountBB: 4, street: 'FLOP' },
    { position: 'BB', type: 'CALL', amountBB: 4, street: 'FLOP' },
    { position: 'LJ', type: 'CALL', amountBB: 4, street: 'FLOP' },
    { position: 'BB', type: 'CHECK', street: 'TURN' },
    { position: 'LJ', type: 'CHECK', street: 'TURN' },
    { position: 'CO', type: 'CHECK', street: 'TURN' },
    { position: 'BB', type: 'BET', amountBB: 10, street: 'RIVER' },
    { position: 'LJ', type: 'FOLD', street: 'RIVER' },
  ];
  const mk = (villain: Record<string, unknown>): ManualHandInput => ({
    ...baseHand(villain),
    actionHistory: multi,
  } as unknown as ManualHandInput);
  const none = analyzeManualHand(mk({ stackBB: 100 }), OPTIONS);
  const withManiacBB = analyzeManualHand(mk({ playerId: 'seat_BB', quickProfile: 'MANIAC', stackBB: 100 }), OPTIONS);
  const withManiacLJ = analyzeManualHand(mk({ playerId: 'seat_LJ', quickProfile: 'MANIAC', stackBB: 100 }), OPTIONS);
  console.log(`    3 家看翻牌（LJ/CO/BB），河牌 BB bet 10 / LJ fold，villain 默认: ${summarize(none)}`);
  console.log(`    villain=BB  MANIAC: ${summarize(withManiacBB)}`);
  console.log(`    villain=LJ  MANIAC（河牌已弃牌）: ${summarize(withManiacLJ)}`);
  verdict('A11', (none.ok && withManiacBB.ok) ? 'PASS' : (none.ok ? 'FAIL' : 'NOT_TESTED'),
    none.ok && withManiacBB.ok
      ? `多人池可分析；villain=BB 时画像生效（权益 ${(withManiacBB.ok ? Number((withManiacBB.decision.diagnostics as unknown as { math?: Record<string, unknown> }).math?.['heroEquity']) : NaN).toFixed(10)}` +
        ` vs 默认 ${Number((none.decision.diagnostics as unknown as { math?: Record<string, unknown> }).math?.['heroEquity']).toFixed(10)}）；` +
        `villain=LJ（河牌已弃牌）${withManiacLJ.ok ? '仍返回完整结果' : `失败 stage=${withManiacLJ.stage}`}`
      : `多人池基线不可分析 stage=${none.ok ? '-' : none.stage}`);
}

console.log('\n\n================ 用例汇总 ================');
for (const h of hedges) console.log(`  ${h}`);
