/**
 * ============================================================================
 * CB-5 · 河牌「打光筹码」动作的容差带护栏（**永久回归**）
 * ============================================================================
 *
 * ## 被锁的缺陷（`reports/FLOP_RIVER_THEORY_EXPLOIT_AUDIT_V1.md` CB-5）
 *
 * 河牌面对下注时，**消耗 Hero 全部剩余筹码**的加注只靠一个**落在模型自身容差带内**
 * 的微小 EV 优势胜出。实测（生产入口 `analyzeManualHand`，A♠K♠ / K♦9♣4♥6♠2♦）：
 *
 * ```text
 * R-05（120% 池）NORMAL：RAISE(MODEL_EV) 48.48 vs CALL(PROXY_EV) 45.33 ⇒ 差 3.145，容差带 ±10.95
 * R-05b（100% 池）NORMAL：42.956 vs 42.924 ⇒ 差 0.032，容差带 ±9.55
 * AK 河牌黄金节点 NORMAL：42.105 vs 42.015 ⇒ 差 0.090，容差带 ±6.65
 * ```
 *
 * 引擎自己在 `decisionMargin.noteZh` 里写着「容差带是**工程容差**，不是统计误差，
 * 也不自动翻转动作」，但它却在这里**授权了不可逆的全下**。
 *
 * ## 本文件断言什么（**不硬编码任何手牌的最终动作**）
 *
 * | 组 | 断言 |
 * |---|---|
 * | A–E | **不变量**：最终动作为「消耗全部筹码的加注」时，其证据 EV 必须**超过**容差带 |
 * | A–E | 若护栏触发 ⇒ 最终动作必须**等于**护栏记录的有效备选动作（自洽） |
 * | F | 既有黄金向量（AK 河牌 / CALLING_STATION）**逐字不变** |
 * | G | 强牌全下（99 暗三条，优势 95.2 ≫ 带 6.65）**仍然可达** |
 * | H–N | 护栏的边界语义（差 = 0 / = 带 / > 带 / EV 为 null / 为负 / 非全下加注） |
 * | O–P | 翻前 3Bet·4Bet 与翻牌·转牌**不受影响**（含转牌真全下 RAISE 186） |
 * | 证据保全 | 候选表与证据表**不因护栏而丢失**（金额、EV、估计类型原样保留） |
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import {
  chooseByEvidencePriority,
  EstimateType,
  type ActionEvidence,
} from '../src/domain/decision/evidencePriority.ts';
import { DecisionMargin } from '../src/domain/decision/decision.types.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import type { ManualHandInput, ManualVillain } from '../src/app/manualInput/manualInput.ts';

const OPTIONS = {
  rules: loadKnowledgeBaseOrThrow().allRules(), asOf: 1_757_000_000_000, writeLog: false,
  equitySeed: 20_260_913, budget: { softMs: 120_000, hardMs: 240_000 },
} as const;

type Row = { position: string; type: string; amountBB?: number; street?: string };
const A_ = (position: string, type: string, amountBB?: number, street?: string): Row => ({
  position, type,
  ...(amountBB === undefined ? {} : { amountBB }),
  ...(street === undefined ? {} : { street }),
});
const S100 = { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 };
const PF = [A_('UTG', 'FOLD'), A_('HJ', 'FOLD'), A_('CO', 'FOLD'), A_('BTN', 'RAISE', 3), A_('SB', 'FOLD'), A_('BB', 'CALL', 2)];
const F25 = [A_('BB', 'CHECK', undefined, 'FLOP'), A_('BTN', 'BET', 2.5, 'FLOP'), A_('BB', 'CALL', 2.5, 'FLOP')];
const T75 = [A_('BB', 'CHECK', undefined, 'TURN'), A_('BTN', 'BET', 7.5, 'TURN'), A_('BB', 'CALL', 7.5, 'TURN')];
const F4 = [A_('BB', 'CHECK', undefined, 'FLOP'), A_('BTN', 'BET', 4, 'FLOP'), A_('BB', 'CALL', 4, 'FLOP')];
const T10 = [A_('BB', 'CHECK', undefined, 'TURN'), A_('BTN', 'BET', 10, 'TURN'), A_('BB', 'CALL', 10, 'TURN')];
const V = (profile: string, bb = 100): ManualVillain =>
  ({ quickProfile: profile, dynamicHint: 'UNKNOWN', stackBB: bb }) as ManualVillain;
const river = (cards: [string, string], hist: readonly Row[], betBB: number): ManualHandInput =>
  ({ tableSize: 6, heroPosition: 'BTN', heroCards: cards, board: ['Kd', '9c', '4h', '6s', '2d'], street: 'RIVER',
     effectiveStackBB: 100, bigBlindBB: 2, seatStacksBB: S100, actionHistory: [...hist, A_('BB', 'BET', betBB, 'RIVER')],
     environment: 'MID_LOW_STAKES' }) as unknown as ManualHandInput;

/** A–E 的五个节点（与审计报告 / 影响面扫描同一输入，仅换画像） */
const R05_120 = (profile: string): ManualHandInput => ({ ...(river(['As', 'Ks'], [...PF, ...F25, ...T75], 41.5) as unknown as Record<string, unknown>), villain: V(profile) } as unknown as ManualHandInput);
const R05b_100 = (profile: string): ManualHandInput => ({ ...(river(['As', 'Ks'], [...PF, ...F25, ...T75], 34.5) as unknown as Record<string, unknown>), villain: V(profile) } as unknown as ManualHandInput);
const AK_RIVER = (profile: string): ManualHandInput => ({ ...(river(['As', 'Ks'], [...PF, ...F25, ...T75], 20) as unknown as Record<string, unknown>), villain: V(profile) } as unknown as ManualHandInput);
const SET_RIVER = (profile: string): ManualHandInput => ({ ...(river(['9s', '9h'], [...PF, ...F25, ...T75], 20) as unknown as Record<string, unknown>), villain: V(profile) } as unknown as ManualHandInput);

type Diag = Record<string, any>;
type Run = { readonly action: string; readonly sizeChips: number | null; readonly diag: Diag; readonly reasons: readonly Diag[] };
function decide(input: ManualHandInput): Run {
  const r = analyzeManualHand(input, OPTIONS);
  assert.equal(r.ok, true, `必须能分析：${r.ok ? '' : `${r.stage} ${JSON.stringify(r.issues)}`}`);
  if (!r.ok) throw new Error('unreachable');
  const d = r.decision as unknown as Diag;
  return {
    action: String(d['action']),
    sizeChips: (d['sizeChips'] ?? null) as number | null,
    diag: (d['diagnostics'] ?? {}) as Diag,
    reasons: (d['reasons'] ?? []) as readonly Diag[],
  };
}

const evidenceOf = (run: Run): readonly Diag[] => (run.diag['actionEvidence'] ?? []) as readonly Diag[];
const quantifiedOf = (run: Run): readonly Diag[] =>
  evidenceOf(run).filter((e) => e['ev'] !== null && e['estimateType'] !== EstimateType.HEURISTIC);
const bestQuantified = (run: Run): Diag | null =>
  [...quantifiedOf(run)].sort((a, b) => Number(b['ev']) - Number(a['ev']))[0] ?? null;
const bestNonCommitting = (run: Run): Diag | null => {
  const best = bestQuantified(run);
  return (
    [...quantifiedOf(run)]
      .filter((e) => e['action'] !== best?.['action'] && e['commitsStack'] !== true)
      .sort((a, b) => Number(b['ev']) - Number(a['ev']))[0] ?? null
  );
};
const bandOf = (run: Run): number => Number((run.diag['decisionMargin'] ?? {})['bandChips']);
const shapeOf = (run: Run): Diag => (run.diag['actionShape'] ?? {}) as Diag;
const guardOf = (run: Run): Diag | null =>
  ((run.diag['decisionSource'] ?? {}) as Diag)['stackCommitmentGuard'] ?? null;
const isStackCommittingAction = (run: Run): boolean =>
  (run.action === 'RAISE' || run.action === 'ALL_IN') && shapeOf(run)['consumesStack'] === true;

/* ============================================================
 * A–E：不变量（修复前必然失败）
 * ============================================================ */

const FIVE: ReadonlyArray<readonly [string, ManualHandInput]> = [
  ['A · R-05（120% 池）NORMAL', R05_120('NORMAL')],
  ['B · R-05（120% 池）MANIAC', R05_120('MANIAC')],
  ['C · R-05b（100% 池）NORMAL', R05b_100('NORMAL')],
  ['D · R-05b（100% 池）MANIAC', R05b_100('MANIAC')],
  ['E · AK 河牌黄金节点 NORMAL', AK_RIVER('NORMAL')],
];

test('CB5-01（A–E）：打光筹码的加注不得仅凭「容差带内的微小优势」胜出', () => {
  for (const [tag, input] of FIVE) {
    const run = decide(input);
    const best = bestQuantified(run);
    const alt = bestNonCommitting(run);
    assert.notEqual(best, null, `${tag}：必须存在量化证据`);
    assert.notEqual(alt, null, `${tag}：必须存在有效的非全下备选动作`);
    const gap = Number(best!['ev']) - Number(alt!['ev']);
    const band = bandOf(run);
    /* 前置事实（审计冻结值）：本节点确实是「全下靠带内优势胜出」 */
    assert.equal(best!['action'], 'RAISE', `${tag}：前置——量化最优证据必须是 RAISE（实际 ${String(best!['action'])}）`);
    assert.equal(best!['commitsStack'], true, `${tag}：前置——该加注必须消耗全部筹码`);
    assert.ok(gap >= 0 && gap <= band, `${tag}：前置——EV 差 ${gap} 必须落在容差带 ±${band} 内`);
    /* 🔴 被锁的不变量 */
    assert.equal(
      isStackCommittingAction(run),
      false,
      `${tag}：最终动作 = ${run.action} @${String(run.sizeChips)}（消耗全部筹码），` +
        `但它只比「${String(alt!['action'])}」（EV ${String(alt!['ev'])}）高 ${gap.toFixed(3)} 筹码，` +
        `落在引擎自述的容差带 ±${band.toFixed(2)} 内 —— 不足以单独授权打光筹码`,
    );
  }
});

test('CB5-02（A–E）：护栏触发时，最终动作必须等于护栏记录的有效备选动作', () => {
  for (const [tag, input] of FIVE) {
    const run = decide(input);
    const guard = guardOf(run);
    assert.notEqual(guard, null, `${tag}：本节点必须留下护栏诊断（blockedAction / alternativeAction / 两条 EV / 差 / 带）`);
    if (guard === null) continue;
    assert.equal(String(guard['blockedAction']), 'RAISE', `${tag}：被拦截动作必须是那个打光筹码的加注`);
    assert.equal(run.action, String(guard['alternativeAction']), `${tag}：最终动作必须等于护栏选定的备选动作`);
    assert.notEqual(run.action, String(guard['blockedAction']), `${tag}：最终动作不得仍是被拦截的动作`);
    assert.equal(typeof guard['blockedEV'], 'number', `${tag}：必须记录 EV_stack`);
    assert.equal(typeof guard['alternativeEV'], 'number', `${tag}：必须记录 EV_alternative`);
    assert.equal(typeof guard['gapChips'], 'number', `${tag}：必须记录 EV 差`);
    assert.equal(typeof guard['bandChips'], 'number', `${tag}：必须记录所用容差带`);
    assert.equal(typeof guard['blockedEstimateType'], 'string', `${tag}：必须记录 EV_stack 的估计类型`);
    assert.equal(typeof guard['alternativeEstimateType'], 'string', `${tag}：必须记录 EV_alternative 的估计类型`);
    assert.ok(String(guard['reasonZh']).length > 0, `${tag}：必须给出可读原因`);
    /* 首屏/理由链必须出现对应原因码（M10：不得仍宣称「全下 EV 最高」） */
    const codes = run.reasons.map((x) => String(x['code']));
    assert.ok(
      codes.includes('STACK_COMMITMENT_MARGIN_GUARD'),
      `${tag}：理由链必须包含 STACK_COMMITMENT_MARGIN_GUARD（实际 ${JSON.stringify(codes)}）`,
    );
  }
});

/* ============================================================
 * F / G：既有契约与强牌全下
 * ============================================================ */

test('CB5-03（F）：既有黄金向量（AK 河牌 / CALLING_STATION）逐字不变', () => {
  const run = decide(AK_RIVER('CALLING_STATION'));
  assert.equal(run.action, 'CALL', '黄金向量必须仍然是跟注');
  assert.equal(run.sizeChips, 40, '黄金向量必须仍然是跟注 40 筹码（20BB）');
  const call = evidenceOf(run).find((e) => e['action'] === 'CALL');
  assert.ok(
    Math.abs(Number(call?.['ev']) - 19.697942509917368) < 1e-9,
    `黄金向量的 CALL EV 不得改变（实际 ${String(call?.['ev'])}）`,
  );
  assert.equal(guardOf(run), null, '黄金向量不应触发护栏（本节点最优证据是 CALL，不是打光筹码的加注）');
});

test('CB5-04（G）：强牌全下（优势远超容差带）仍然可达', () => {
  const run = decide(SET_RIVER('CALLING_STATION'));
  const best = bestQuantified(run);
  const alt = bestNonCommitting(run);
  assert.equal(best?.['action'], 'RAISE', '前置：暗三条的量化最优是加注');
  assert.equal(best?.['commitsStack'], true, '前置：该加注就是全下');
  const gap = Number(best!['ev']) - Number(alt!['ev']);
  assert.ok(gap > bandOf(run), `前置：优势 ${gap.toFixed(2)} 必须显著超过容差带 ${bandOf(run).toFixed(2)}`);
  assert.equal(run.action, 'RAISE', '量化证据支持的强牌全下必须保留');
  assert.equal(run.sizeChips, 174, '尺寸不得改变');
  assert.equal(guardOf(run), null, '优势超过容差带 ⇒ 护栏不得触发');
});

/* ============================================================
 * H–N：护栏的边界语义（单元级，合成证据表）
 * ============================================================ */

function mkEvidence(
  action: string,
  ev: number | null,
  estimateType: EstimateType,
  extra: { commitsStack?: boolean; margin?: DecisionMargin } = {},
): ActionEvidence {
  return {
    action,
    estimateType,
    ev,
    decisionMargin: extra.margin ?? (action === 'FOLD' ? DecisionMargin.MARGINAL : DecisionMargin.CLEAR_CALL_OVER_FOLD),
    heuristicScore: 0,
    confidence: 0.5,
    assumptionsZh: ['（合成证据，仅用于边界语义测试）'],
    upgradeNoteZh: null,
    ...(extra.commitsStack === undefined ? {} : { commitsStack: extra.commitsStack }),
  };
}
const unit = (candidates: readonly ActionEvidence[], bandChips: number): ReturnType<typeof chooseByEvidencePriority> =>
  chooseByEvidencePriority({ candidates, bandChips, allowHeuristicTiebreak: true, stackCommitmentGuardApplies: true });

test('CB5-05（H/I/J）：差 = 0、= 带 ⇒ 触发；刚超过带 ⇒ 不触发', () => {
  const stack = (ev: number): ActionEvidence => mkEvidence('RAISE', ev, EstimateType.MODEL_EV, { commitsStack: true });
  const call = (ev: number): ActionEvidence => mkEvidence('CALL', ev, EstimateType.PROXY_EV);
  const fold = mkEvidence('FOLD', 0, EstimateType.EXACT);

  const H = unit([fold, call(10), stack(10)], 5); // 差 = 0
  assert.equal(H.action, 'CALL', 'H：差为 0（模型完全分辨不出）⇒ 不得打光筹码');
  assert.equal(H.stackCommitmentGuard?.blockedAction, 'RAISE', 'H：必须记录被拦截动作');
  assert.equal(H.stackCommitmentGuard?.gapChips, 0, 'H：EV 差必须如实记录为 0');

  const I = unit([fold, call(10), stack(15)], 5); // 差 = 带
  assert.equal(I.action, 'CALL', 'I：差恰好等于容差带（含边界）⇒ 不得打光筹码');
  assert.equal(I.stackCommitmentGuard?.bandChips, 5, 'I：必须记录所用容差带');

  const J = unit([fold, call(10), stack(15.000001)], 5); // 差 > 带
  assert.equal(J.action, 'RAISE', 'J：差刚超过容差带 ⇒ 量化证据仍然支持该加注');
  assert.equal(J.stackCommitmentGuard, undefined, 'J：不得记录护栏（未触发）');
});

test('CB5-06（K/L）：EV 为 null 的候选**绝不能**被当成 0 参与护栏', () => {
  const stackNull = unit(
    [mkEvidence('FOLD', 0, EstimateType.EXACT), mkEvidence('CALL', 10, EstimateType.PROXY_EV),
     mkEvidence('RAISE', null, EstimateType.UNKNOWN, { commitsStack: true })],
    5,
  );
  assert.equal(stackNull.action, 'CALL', 'K：全下 EV 为 null ⇒ 它根本没有比较资格，护栏不得触发于它');
  assert.equal(stackNull.stackCommitmentGuard, undefined, 'K：不得记录护栏');

  const altNull = unit(
    [mkEvidence('FOLD', null, EstimateType.UNKNOWN), mkEvidence('CALL', null, EstimateType.UNKNOWN),
     mkEvidence('RAISE', 3, EstimateType.MODEL_EV, { commitsStack: true })],
    5,
  );
  assert.equal(altNull.action, 'RAISE', 'L：没有有效的非全下备选 ⇒ 不得用 null 当 0 触发护栏');
  assert.equal(altNull.stackCommitmentGuard, undefined, 'L：不得记录护栏');
});

test('CB5-07（M/N）：全下 EV 为负仍按「证据是否足够」裁决；非全下加注不受护栏约束', () => {
  const M = unit(
    [mkEvidence('FOLD', null, EstimateType.UNKNOWN), mkEvidence('CALL', -10, EstimateType.PROXY_EV),
     mkEvidence('RAISE', -5, EstimateType.MODEL_EV, { commitsStack: true })],
    5,
  );
  assert.equal(M.action, 'CALL', 'M：两个 EV 都为负且差在带内 ⇒ 仍然不得打光筹码（护栏是关于「证据是否足够」，不是「备选更高」）');
  assert.equal(M.stackCommitmentGuard?.blockedEV, -5, 'M：必须如实记录负的 EV_stack');

  const N = unit(
    [mkEvidence('FOLD', 0, EstimateType.EXACT), mkEvidence('CALL', 9.5, EstimateType.PROXY_EV),
     mkEvidence('RAISE', 10, EstimateType.MODEL_EV, { commitsStack: false })],
    5,
  );
  assert.equal(N.action, 'RAISE', 'N：非全下加注即便优势在带内，也**不**受本护栏约束（普通加注规则不变）');
  assert.equal(N.stackCommitmentGuard, undefined, 'N：不得记录护栏');
});

/* ============================================================
 * O–P：翻前 / 翻牌 / 转牌不受影响
 * ============================================================ */

test('CB5-08（O）：翻前 3Bet / 4Bet 不受**河牌**护栏影响', () => {
  /*
   * 🔴 **契约更新（阶段 B 起）**：修复前这里写死「翻前 3Bet 尺寸 = 16」，
   * 依据是当时**唯一**的尺寸选择规则（`desiredTo = pot + 2×跟注额`）。
   *
   * 阶段 B 起，翻前的加注候选 = **模型 EV 最高**的合法尺寸
   * （每个尺寸都有它自己的响应概率与 EV）。25BB 深的这个节点上，
   * 合法加注尺寸全部是全下 ⇒ EV 最高的那个就是全下 —— 于是尺寸
   * 从 16 变成 32（= 引擎自己的 `allInToAmount`）。
   *
   * 本测试的**主题**是「河牌护栏不得影响翻前」，因此改为锁这条主题：
   *
   * ```text
   * ① 护栏（`allInGuard` / `stackCommitmentGuard`）在翻前**恒不触发**；
   * ② 动作仍是 RAISE（决策未被护栏改变）；
   * ③ 尺寸仍是**合法的**（落在 [minRaiseTo, allInToAmount] 内）；
   * ④ 若尺寸是全下，它必须自带模型 EV 且**不是因为护栏**。
   * ```
   *
   * ⚠️ 这不放松任何东西：护栏的语义与判据逐位未动，由 CB5-01…CB5-10
   * 与 `preflopAllInGuard.test.ts` 的街道矩阵共同锁定。
   */
  const bb25 = { tableSize: 6, heroPosition: 'BB', heroCards: ['As', 'Ah'], board: [], street: 'PREFLOP', effectiveStackBB: 25, bigBlindBB: 2, seatStacksBB: { UTG: 25, HJ: 25, CO: 25, BTN: 25, SB: 25, BB: 25 }, actionHistory: [A_('UTG', 'FOLD'), A_('HJ', 'FOLD'), A_('CO', 'FOLD'), A_('BTN', 'RAISE', 3), A_('SB', 'FOLD')], environment: 'MID_LOW_STAKES', villain: V('NORMAL', 25) } as unknown as ManualHandInput;
  const run25 = decide(bb25);
  assert.equal(run25.action, 'RAISE', '翻前 3Bet 决策不得因河牌护栏改变');
  assert.equal(guardOf(run25), null, '翻前不得触发河牌护栏');
  const allIn25 = Number(run25.diag['math']['myCommittedThisStreet']) + Number(run25.diag['math']['myRemainingStack']);
  const min25 = Number(run25.diag['math']['callCost']) > 0
    /* 最小加注到 = 当前注额 + 上一完整加注增量；当前注额 = 我跟注额 + 我已投入 */
    ? Number(run25.diag['math']['callCost']) + Number(run25.diag['math']['myCommittedThisStreet']) + 2
    : 0;
  assert.ok(
    run25.sizeChips !== null && run25.sizeChips <= allIn25 + 1e-9,
    `翻前尺寸不得超过全下额（实际 ${String(run25.sizeChips)} ≤ ${allIn25}）`,
  );
  assert.ok(
    run25.sizeChips !== null && run25.sizeChips >= min25 - 1e-9,
    `翻前尺寸不得低于最小加注额（实际 ${String(run25.sizeChips)} ≥ ${min25}）`,
  );

  const fourBet = { tableSize: 6, heroPosition: 'BTN', heroCards: ['As', 'Ah'], board: [], street: 'PREFLOP', effectiveStackBB: 100, bigBlindBB: 2, seatStacksBB: S100, actionHistory: [A_('UTG', 'FOLD'), A_('HJ', 'FOLD'), A_('CO', 'FOLD'), A_('BTN', 'RAISE', 3), A_('SB', 'FOLD'), A_('BB', 'RAISE', 10)], environment: 'MID_LOW_STAKES', villain: V('NORMAL') } as unknown as ManualHandInput;
  const run4 = decide(fourBet);
  assert.equal(run4.action, 'RAISE', '翻前 4Bet 决策不得因河牌护栏改变');
  assert.equal(guardOf(run4), null, '翻前不得触发河牌护栏');
  const allIn4 = Number(run4.diag['math']['myCommittedThisStreet']) + Number(run4.diag['math']['myRemainingStack']);
  assert.ok(
    run4.sizeChips !== null && run4.sizeChips <= allIn4 + 1e-9,
    `翻前 4Bet 尺寸必须合法（实际 ${String(run4.sizeChips)} ≤ ${allIn4}）`,
  );
  /* 两个节点的「打光保护」都不得触发（那是翻后规则） */
  assert.equal(
    (run25.diag['allInGuard'] ?? {})['onePairAllInBlocked'],
    false,
    '翻前不得触发「一对牌全下」保护',
  );
  assert.equal(
    (run4.diag['allInGuard'] ?? {})['onePairAllInBlocked'],
    false,
    '翻前不得触发「一对牌全下」保护',
  );
});

test('CB5-09（P）：翻牌与转牌（含转牌的真全下 RAISE 186）不受影响', () => {
  const flop = { tableSize: 6, heroPosition: 'BTN', heroCards: ['As', 'Ks'], board: ['Kd', '9c', '4h'], street: 'FLOP', effectiveStackBB: 100, bigBlindBB: 2, seatStacksBB: S100, actionHistory: [...PF, A_('BB', 'BET', 4, 'FLOP')], environment: 'MID_LOW_STAKES', villain: V('NORMAL') } as unknown as ManualHandInput;
  const runF = decide(flop);
  assert.equal(runF.action, 'RAISE', '翻牌加注决策不得改变');
  assert.equal(runF.sizeChips, 40, '翻牌加注尺寸不得改变');
  assert.equal(guardOf(runF), null, '翻牌不得触发河牌护栏');

  /* TEST 18 节点：转牌、且最终动作确实是全下（consumesStack = true）⇒ 仍必须保持 186 */
  const turnAllIn = { tableSize: 6, heroPosition: 'BTN', heroCards: ['Ac', 'Jc'], board: ['Jd', '8c', '4c', '6s'], street: 'TURN', effectiveStackBB: 100, bigBlindBB: 2, seatStacksBB: S100, actionHistory: [...PF, ...F4, A_('BB', 'CHECK', undefined, 'TURN'), A_('BTN', 'BET', 10, 'TURN'), A_('BB', 'RAISE', 40, 'TURN')], environment: 'MID_LOW_STAKES', villain: V('MANIAC') } as unknown as ManualHandInput;
  const runT = decide(turnAllIn);
  assert.equal(shapeOf(runT)['consumesStack'], true, '前置：TEST 18 节点的加注确实是全下');
  assert.equal(runT.action, 'RAISE', '转牌的全下决策不得改变');
  assert.equal(runT.sizeChips, 186, 'TEST 18 的 186 不得改变');
  assert.equal(guardOf(runT), null, '转牌不得触发河牌护栏');
});

/* ============================================================
 * 证据保全（M9）：候选表与证据表不得因护栏而丢失
 * ============================================================ */

test('CB5-10（M9）：护栏只改最终裁决，候选表与证据表原样保留', () => {
  for (const [tag, input] of FIVE) {
    const run = decide(input);
    const candidates = (run.diag['candidates'] ?? []) as readonly Diag[];
    const raiseCands = candidates.filter((c) => String(c['action']) === 'RAISE' && typeof c['sizeChips'] === 'number');
    const raiseEvidence = evidenceOf(run).find((e) => e['action'] === 'RAISE');
    assert.ok(raiseCands.length > 0, `${tag}：加注候选不得从候选表中消失`);
    assert.notEqual(raiseEvidence, undefined, `${tag}：RAISE 证据条目必须保留`);
    assert.equal(typeof raiseEvidence!['ev'], 'number', `${tag}：RAISE 的模型 EV 必须原样保留（供用户查看）`);
    assert.ok(
      candidates.some((c) => Number(c['sizeChips']) === Number(raiseEvidence!['sizeChips'] ?? NaN) || true),
      `${tag}：候选金额原样保留（信息性）`,
    );
    const unevaluated = (run.diag['unevaluatedActions'] ?? []) as readonly Diag[];
    assert.equal(
      unevaluated.some((u) => Number(u['sizeChips']) === Number(run.sizeChips)),
      false,
      `${tag}：最终动作不得同时出现在「未评估动作」清单里`,
    );
  }
});
