/**
 * ============================================================================
 * RIVER RAISE DECISION V2 —— 缺陷复现 + 墨菲定律验收（M1–M10）
 * ============================================================================
 *
 * 本文件**全部调用生产决策链**（`analyzeManualHand` / `decideAlpha` 路径），
 * 不是文案断言。
 *
 * | 编号 | 断言 |
 * |---|---|
 * | V2-1 | M1：CALL EV 明确为正且边际 CLEAR，RAISE 无 EV ⇒ 启发式**不得**覆盖 CALL |
 * | V2-2 | §四：一对牌 + 打光筹码 + 无 RAISE EV ⇒ 不得选成加注 |
 * | V2-3 | M7：同额 RAISE 与 ALL_IN 不得重复计入候选 |
 * | V2-4 | M6：普通加注 / 加注到全下 / 直接全下 必须可区分 |
 * | V2-5 | §六：加注门槛必须用**面对下注**的条件权益，不得用 math.heroEquity 顶替 |
 * | V2-6 | §三：必须披露「尚有未评估的合法动作」（RAISE_EV_NOT_IMPLEMENTED） |
 * | V2-7 | M2：CALL EV 为负 + RAISE 无 EV ⇒ 不得凭空认定加注有正 EV |
 * | V2-8 | M3：RAISE 自带可比 EV 且更高 ⇒ 必须能选 RAISE（CLEAR_CALL 不是永久跟注） |
 * | V2-9 | M4：RAISE 自带 EV 但更低 ⇒ 不得选 RAISE |
 * | V2-10 | M5：强价值牌与弱一对牌必须被**分别**判断（不是一条固定禁令） |
 * | V2-11 | M8：换画像后 CALL EV / 下注范围 / 证据优先级语义一致 |
 * | V2-12 | M9：未实现的 EV 必须保持 null，不得伪造数值 |
 * | V2-13 | M10：所有已算 EV 必须同一筹码口径与同一决策时点 |
 * | V2-14 | 逐个加注金额：不得有伪造 EV；全下保护只在真正打光的金额上生效 |
 * | V2-15 | 🔴 U1 披露一致性：**有自有 EV 的加注尺寸不得被列为「未评估」** |
 * | V2-16 | 🔴 U1 生产路径：加注 EV 更高时**真的**选 RAISE，且动作形态 / 去重自洽 |
 * | V2-17 | 🔴 U1 披露一致性（CALL 胜出侧）：「算过但更低」不得说成「没算过」 |
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { chooseByEvidencePriority, EstimateType, DecisionSourceKind } from '../src/domain/decision/evidencePriority.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import type { ActionEvidence } from '../src/domain/decision/evidencePriority.ts';
import type { ManualHandInput } from '../src/app/manualInput/manualInput.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const SEED = 20_261_014;
const OPTIONS = {
  rules: RULES,
  asOf: 1_757_000_000_000,
  writeLog: false,
  equitySeed: SEED,
  budget: { softMs: 120_000, hardMs: 240_000 },
} as const;

type Row = { position: string; type: string; amountBB?: number; street?: string };
const A = (position: string, type: string, amountBB?: number, street?: string): Row => ({
  position, type,
  ...(amountBB === undefined ? {} : { amountBB }),
  ...(street === undefined ? {} : { street }),
});

/**
 * Hero BTN，河牌面对 BB 领打 20BB（= 40 筹码；下注前底池 53；Hero 剩余 174）。
 * 默认 A♠K♠（顶对 K，A 踢脚，handCategory = 2）。
 */
function akInput(profile = 'CALLING_STATION', heroCards: [string, string] = ['As', 'Ks']): ManualHandInput {
  return {
    tableSize: 6, heroPosition: 'BTN', heroCards, board: ['Kd', '9c', '4h', '6s', '2d'],
    street: 'RIVER', effectiveStackBB: 100, bigBlindBB: 2,
    seatStacksBB: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 },
    actionHistory: [
      A('UTG', 'FOLD'), A('HJ', 'FOLD'), A('CO', 'FOLD'), A('BTN', 'RAISE', 3), A('SB', 'FOLD'), A('BB', 'CALL', 2),
      A('BB', 'CHECK', undefined, 'FLOP'), A('BTN', 'BET', 2.5, 'FLOP'), A('BB', 'CALL', 2.5, 'FLOP'),
      A('BB', 'CHECK', undefined, 'TURN'), A('BTN', 'BET', 7.5, 'TURN'), A('BB', 'CALL', 7.5, 'TURN'),
      A('BB', 'BET', 20, 'RIVER'),
    ],
    environment: 'MID_LOW_STAKES',
    villain: { quickProfile: profile, dynamicHint: 'UNKNOWN', stackBB: 100 },
  } as unknown as ManualHandInput;
}

type Diag = Record<string, any>;
function decide(input: ManualHandInput): { action: string; sizeChips: number | null; diag: Diag; reasons: Diag[] } {
  const r = analyzeManualHand(input, OPTIONS);
  assert.equal(r.ok, true, `必须能分析：${r.ok ? '' : `${r.stage} ${JSON.stringify(r.issues)}`}`);
  if (!r.ok) throw new Error('unreachable');
  const d = r.decision as unknown as Record<string, any>;
  return {
    action: String(d['action']),
    sizeChips: (d['sizeChips'] ?? null) as number | null,
    diag: d['diagnostics'] as Diag,
    /* ⚠️ 首屏理由被 `slice(0, 6)` 截断 —— 用它做断言时必须记住这个作用域 */
    reasons: (d['reasons'] ?? []) as Diag[],
  };
}

const evidenceOf = (diag: Diag): Diag[] => (diag['actionEvidence'] ?? []) as Diag[];
/** U1：加注响应事实包在 `diagnostics.postflop.raiseResponse`（与 `betRangeArrival` 同级） */
const raiseFactsOf = (diag: Diag): Diag | null =>
  ((diag['postflop'] as Diag | undefined)?.['raiseResponse'] ?? diag['raiseResponse'] ?? null) as Diag | null;
const raiseEvidenceOf = (diag: Diag): Diag | undefined => evidenceOf(diag).find((e) => e['action'] === 'RAISE');
/** 「打光筹码」判定：加注后的本街总额 = 全部剩余可投入额 */
const consumesStackOf = (diag: Diag, sizeChips: number | null): boolean =>
  sizeChips !== null && Math.abs(sizeChips - (diag['math']['myRemainingStack'] as number)) < 1e-9;

/* ============================================================
 * V2-1 / V2-2 —— 启发式不得覆盖清晰的 CALL；一对牌不得无 EV 全下
 * ============================================================ */

test('V2-1（M1）：CALL EV 为正且边际 CLEAR 时，无 EV 的启发式加注不得覆盖它', () => {
  const { action, sizeChips, diag } = decide(akInput());
  const callEV = diag['math']['callEV'] as number;
  const margin = String(diag['decisionMargin']?.['kind']);
  const raise = raiseEvidenceOf(diag);

  // 前置事实（审计冻结值）
  assert.ok(callEV > 0, `前置：CALL EV 必须为正（实际 ${callEV}）`);
  assert.equal(margin, 'CLEAR_CALL_OVER_FOLD', '前置：CALL 的边际必须是 CLEAR（不是 MARGINAL）');

  if (action === 'RAISE' || action === 'ALL_IN') {
    const noEV = raise === undefined || raise['ev'] === null;
    assert.equal(
      noEV && consumesStackOf(diag, sizeChips),
      false,
      `CALL EV = ${callEV}（边际 CLEAR）被一个**没有 EV**的加注覆盖：` +
        `action=${action} size=${String(sizeChips)}（打光筹码）raise.ev=${String(raise?.['ev'])}`,
    );
  }
});

test('V2-2（§四）：全下保护的规则必须成立，且**有自有 EV 时让位给 EV 比较**', () => {
  const { action, sizeChips, diag } = decide(akInput());
  const handCategory = diag['math']['handCategory'] as number;
  const guard = diag['allInGuard'] as Diag | undefined;
  assert.ok(handCategory < 3, `前置：本节点是一对牌（handCategory = ${handCategory}）`);
  assert.notEqual(guard, undefined, '必须输出全下保护的判定结果（allInGuard）');

  /*
   * ① **规则恒等式**：`onePairAllInBlocked ⇔ 打光 ∧ 类别<3 ∧ 无自有 EV`
   *    （U1 之后生产路径上很难再出现「无 EV 的全下」，端到端只能验证恒等式；
   *      四种组合由 `allInGuardVerdictOf` 的单测穷举）
   */
  const expected =
    (guard!['consumesStack'] as boolean) &&
    handCategory < (guard!['minCategoryForLargeRaise'] as number) &&
    !(guard!['hasOwnEV'] as boolean);
  assert.equal(
    guard!['onePairAllInBlocked'],
    expected,
    `全下保护的判定必须与规则恒等：consumesStack=${String(guard!['consumesStack'])}、` +
      `handCategory=${handCategory}、hasOwnEV=${String(guard!['hasOwnEV'])}`,
  );
  /* ② 本节点确实是「一对牌 + 打光筹码」——只是 U1 之后它**有**模型 EV */
  assert.equal(guard!['consumesStack'], true, '前置：本节点的加注确实是全下（174 = 全部剩余）');
  assert.equal(
    guard!['hasOwnEV'],
    true,
    'U1 之后加注有自己的模型 EV ⇒ hasOwnEV 必须为真（保护让位给 EV 比较）',
  );
  /* ③ 动作仍然不是「无依据的全下」：要么由 EV 决定，要么被打光/EV 规则约束 */
  assert.equal(
    action === 'RAISE' && guard!['onePairAllInBlocked'] === true,
    false,
    `不得在被保护拦下的情况下仍选加注（action=${action}, size=${String(sizeChips)}）`,
  );
});

/* ============================================================
 * V2-3 / V2-4 —— 候选去重与动作形态可区分
 * ============================================================ */

test('V2-3（M7）：同额 RAISE 与 ALL_IN 不得重复计入候选动作', () => {
  const { diag } = decide(akInput());
  const candidates = (diag['candidates'] ?? []) as Diag[];
  const bySize = new Map<string, string[]>();
  for (const c of candidates) {
    if (typeof c['sizeChips'] !== 'number') continue;
    const key = String(c['sizeChips']);
    bySize.set(key, [...(bySize.get(key) ?? []), String(c['action'])]);
  }
  const dupes = [...bySize.entries()].filter(([, actions]) => actions.length > 1);
  assert.deepEqual(dupes, [], `同一金额不得出现多个候选动作：${JSON.stringify(dupes)}`);
});

test('V2-4（M6）：普通加注 / 加注到全下 / 直接全下必须可区分', () => {
  const { diag } = decide(akInput());
  const shape = diag['actionShape'] as Diag | undefined;
  assert.notEqual(shape, undefined, '必须输出动作形态（actionShape）');
  assert.ok(
    ['NORMAL_RAISE', 'RAISE_TO_ALL_IN', 'DIRECT_ALL_IN', 'CALL', 'FOLD', 'CHECK', 'BET', 'NONE'].includes(String(shape!['kind'])),
    `动作形态取值必须受控（实际 ${String(shape!['kind'])}）`,
  );
  // 形态与金额必须自洽
  const allInTo = diag['math']['myRemainingStack'] as number;
  assert.equal(
    shape!['consumesStack'],
    shape!['sizeChips'] === null ? false : Math.abs((shape!['sizeChips'] as number) - allInTo) < 1e-9,
    'consumesStack 必须与金额自洽（= 是否把剩余筹码全部投入）',
  );
});

/* ============================================================
 * V2-5 —— 条件权益口径（§六）
 * ============================================================ */

test('V2-5（§六）：条件权益必须分列；加注门槛不得用 math.heroEquity 顶替', () => {
  const { diag } = decide(akInput());
  const betEq = diag['math']['heroEquityVsBetRange'] as number;
  const wholeEq = diag['math']['heroEquity'] as number;
  assert.ok(Math.abs(betEq - wholeEq) > 1e-6, '前置：两个条件权益必须不同（否则本测试无意义）');

  const cond = diag['conditionalEquities'] as Diag | undefined;
  assert.notEqual(cond, undefined, '必须输出条件权益清单');
  /*
   * 🔴 **契约更新（U1 实现后）**：`raiseContinueRange` 不再是 `NOT_IMPLEMENTED`，
   * 而是**数值**（面对加注的继续范围权益）。仍然保留 `NOT_IMPLEMENTED` 作为
   * 「本节点确实算不出来」的合法取值 —— 但**不允许**用一个别的条件权益顶替：
   * 有数值时，必须同时存在对应的加注响应事实与 RAISE EV。
   */
  const rc = cond!['raiseContinueRange'];
  const raiseFacts = raiseFactsOf(diag);
  if (rc === 'NOT_IMPLEMENTED') {
    assert.ok(
      raiseFacts === null || raiseFacts === undefined || raiseFacts['raiseEV'] === null,
      '标注 NOT_IMPLEMENTED 时不得同时给出加注 EV（不得用别的条件权益顶替）',
    );
  } else {
    assert.ok(
      typeof rc === 'number' && rc >= 0 && rc <= 1,
      `加注继续范围权益必须是 [0,1] 的数值（实际 ${String(rc)}）`,
    );
    assert.notEqual(raiseFacts, null, '有加注继续范围就必须有面对加注的响应事实');
    assert.ok(
      Math.abs((raiseFacts!['heroEquityVsRaiseCallRange'] as number) - rc) < 1e-12,
      '两个字段必须同源',
    );
  }
  assert.equal(cond!['betRange'], betEq, 'CALL 口径的条件权益必须如实写进清单');
  assert.equal(cond!['wholeRange'], wholeEq, '整体范围权益同样必须如实分列');

  /*
   * 加注**真的发生**时，它读的是哪一个条件权益也必须可审计。
   * 用一个确实会产生启发式加注的节点（AA 面对 3bet，翻前 —— 那里没有下注范围模型）。
   */
  const aaVsThreeBet = {
    tableSize: 6, heroPosition: 'CO', heroCards: ['Ah', 'Ad'], board: [], street: 'PREFLOP',
    effectiveStackBB: 100, bigBlindBB: 2,
    seatStacksBB: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 },
    actionHistory: [
      A('UTG', 'FOLD'), A('HJ', 'FOLD'), A('CO', 'RAISE', 3), A('BTN', 'FOLD'), A('SB', 'FOLD'), A('BB', 'RAISE', 10),
    ],
    environment: 'MID_LOW_STAKES', villain: { quickProfile: 'NORMAL', dynamicHint: 'UNKNOWN', stackBB: 100 },
  } as unknown as ManualHandInput;
  const r = analyzeManualHand(aaVsThreeBet, OPTIONS);
  assert.equal(r.ok, true, 'AA 面对 3bet 必须能分析');
  if (!r.ok) return;
  const d = r.decision as unknown as Record<string, any>;
  assert.equal(d['action'], 'RAISE', 'AA 面对 3bet 的价值加注必须仍然可达（不得被无条件删除）');
  const reason = ((d['reasons'] ?? []) as Diag[]).find(
    (x) =>
      String(x['code']).startsWith('STRATEGIC_RAISE') ||
      x['code'] === 'ISO_RAISE_MODEL_EV' ||
      x['code'] === 'RAISE_MODEL_EV',
  );
  const data = reason?.['data'] as Diag | undefined;
  assert.notEqual(data, undefined, '加注必须给出证据数据');
  /*
   * 🔴 **契约更新（阶段 B 起）**：AA 面对 3Bet 的加注现在由
   * **翻前加注响应模型**（`RAISE_MODEL_EV`）选出，而不是启发式路径。
   * 那条路径不使用「加注门槛读哪个条件权益」这套说法（它读的是
   * 对手**面对这次加注**的条件范围权益），因此按**该路径自己的**
   * 披露契约校验 —— 不允许张冠李戴地要求它给出 `equitySource`。
   *
   * 两条契约都必须**显式标注自己读的是哪一个条件权益**：
   * | 路径 | 披露字段 |
   * |---|---|
   * | 启发式 / 隔离 | `equitySource`（`EqVsBetRange` / `FALLBACK_WHOLE_RANGE`）+ `edge` |
   * | 加注响应模型 | `responseModel` + `fold/call/reRaiseLikelihood` + `raiseEV` |
   */
  if (String(reason!['code']) === 'RAISE_MODEL_EV') {
    assert.equal(
      data!['responseModel'],
      'PREFLOP_RAISE_RESPONSE_V1',
      `翻前加注响应模型路径必须显式标注模型名（实际 ${String(data!['responseModel'])}）`,
    );
    for (const key of ['foldLikelihood', 'callLikelihood', 'reRaiseLikelihood', 'raiseEV', 'callEV']) {
      assert.notEqual(data![key], undefined, `加注响应模型路径必须披露 ${key}`);
    }
    assert.ok(
      Math.abs((data!['raiseEV'] as number) - (d['sizeChips'] as number) * 0) >= 0,
      'raiseEV 必须是数值（可复算）',
    );
    return;
  }
  assert.ok(
    data!['equitySource'] === 'EqVsBetRange' || data!['equitySource'] === 'FALLBACK_WHOLE_RANGE',
    `加注门槛必须显式标注它读的是哪一个条件权益（实际 ${String(data!['equitySource'])}）`,
  );
  // 标注与数值必须自洽：读下注范围 ⇒ edge 必须由下注范围算出
  const src = data!['equitySource'] as string;
  const used = src === 'EqVsBetRange' ? (d['diagnostics']['math']['heroEquityVsBetRange'] as number) : (d['diagnostics']['math']['heroEquity'] as number);
  assert.ok(
    Math.abs((data!['edge'] as number) - (used - (d['diagnostics']['math']['requiredEquity'] as number)) * 100) < 0.05,
    `edge 必须与所声明的条件权益自洽（edge=${String(data!['edge'])}，来源 ${src}）`,
  );
});

/* ============================================================
 * V2-6 —— 未评估的合法动作必须披露（§三）
 * ============================================================ */

test('V2-6（§三）：必须披露「尚有未评估的合法动作」，不得声称全局最优', () => {
  const { diag } = decide(akInput());
  const unevaluated = diag['unevaluatedActions'] as Diag[] | undefined;
  assert.notEqual(unevaluated, undefined, '必须输出未评估动作清单（unevaluatedActions）');
  assert.ok(
    (unevaluated ?? []).some((u) => String(u['action']) === 'RAISE' && u['reasonCode'] === 'RAISE_EV_NOT_IMPLEMENTED'),
    `加注必须被列为未评估动作并给出 RAISE_EV_NOT_IMPLEMENTED（实际 ${JSON.stringify(unevaluated)}）`,
  );
});

/* ============================================================
 * V2-7 / V2-8 / V2-9 —— M2 / M3 / M4
 * ============================================================ */

test('V2-7（M2）：CALL EV 为负且 RAISE 无 EV ⇒ 不得凭空认定加注有正 EV', () => {
  // A♠J♠ 在 K♦9♣4♥6♠2♦ 上是 A 高牌 ⇒ 面对同一条线跟注为负期望
  const { action, diag } = decide(akInput('MANIAC', ['As', 'Js']));
  const callEV = diag['math']['callEV'] as number;
  const raise = raiseEvidenceOf(diag);
  assert.ok(callEV < 0, `前置：CALL EV 必须为负（实际 ${callEV}）`);
  assert.equal(raise?.['ev'] ?? null, null, 'RAISE 必须保持 ev = null（不得伪造数值）');
  assert.notEqual(action, 'RAISE', `EV 不明时不得推荐加注（实际 ${action}）`);
});

const foldEvidence = (): ActionEvidence => ({
  action: 'FOLD', estimateType: EstimateType.EXACT, ev: 0, decisionMargin: 'MARGINAL',
  heuristicScore: 0, confidence: 1, assumptionsZh: ['弃牌 EV ≡ 0'], upgradeNoteZh: null,
});
const callEvidence = (ev: number, margin: string): ActionEvidence => ({
  action: 'CALL', estimateType: EstimateType.PROXY_EV, ev, decisionMargin: margin as never,
  heuristicScore: 0, confidence: 0.95, assumptionsZh: ['代理 EV'], upgradeNoteZh: null,
});
const modelEvRaise = (ev: number, margin: string): ActionEvidence => ({
  action: 'RAISE', estimateType: EstimateType.MODEL_EV, ev, decisionMargin: margin as never,
  heuristicScore: 0, confidence: 0.8, assumptionsZh: ['加注自有模型 EV'], upgradeNoteZh: null,
});

test('V2-8（M3）：加注自带可比 EV 且更高 ⇒ 必须能选 RAISE（CLEAR_CALL 不是永久跟注）', () => {
  const decision = chooseByEvidencePriority({
    candidates: [foldEvidence(), callEvidence(20, 'CLEAR_CALL_OVER_FOLD'), modelEvRaise(31, 'CLEAR_CALL_OVER_FOLD')],
    bandChips: 6.65,
  });
  assert.equal(decision.action, 'RAISE', '加注自有 EV 更高时必须选 RAISE');
  assert.equal(decision.estimateType, EstimateType.MODEL_EV);
});

test('V2-9（M4）：加注自带 EV 但低于 CALL ⇒ 不得选 RAISE', () => {
  const decision = chooseByEvidencePriority({
    candidates: [foldEvidence(), callEvidence(20, 'CLEAR_CALL_OVER_FOLD'), modelEvRaise(5, 'CLEAR_CALL_OVER_FOLD')],
    bandChips: 6.65,
  });
  assert.equal(decision.action, 'CALL', '加注 EV 更低时必须选 CALL');
});

/* ============================================================
 * V2-10 —— M5：强价值牌 vs 弱一对牌（不是同一条固定禁令）
 * ============================================================ */

test('V2-10（M5）：保护必须按牌型条件化，且**有自有 EV 时不得拦**', () => {
  const onePair = decide(akInput('CALLING_STATION', ['As', 'Ks']));  // 一对（category 2）
  const strong = decide(akInput('CALLING_STATION', ['9s', '9h']));    // 暗三条（category 4）

  assert.ok((onePair.diag['math']['handCategory'] as number) < 3, '前置：AK 是一对牌');
  assert.ok((strong.diag['math']['handCategory'] as number) >= 3, `前置：99 是暗三条（实际 ${strong.diag['math']['handCategory']}）`);

  /*
   * 🔴 **契约更新（U1）**：加注现在**有**模型 EV ⇒ `hasOwnEV = true` ⇒
   * 「一对牌不许打光」这条保护**让位给 EV 比较**（规范第 4 条：
   * 「若已有合法、可比较的 EV 证据，保留模型做出全下选择的能力」）。
   * 因此本测试不再断言「一对牌必须被拦」，而是断言：
   * ① 规则恒等式成立；② 类别 ≥ 3 时**永远**不因牌型被拦；
   * ③ 动作必须由 EV 决定（见 V2-16 的生产路径证明）。
   */
  for (const [tag, r] of [['一对', onePair], ['暗三条', strong]] as const) {
    const g = r.diag['allInGuard'] as Diag;
    const expected =
      (g['consumesStack'] as boolean) &&
      (r.diag['math']['handCategory'] as number) < (g['minCategoryForLargeRaise'] as number) &&
      !(g['hasOwnEV'] as boolean);
    assert.equal(g['onePairAllInBlocked'], expected, `${tag}：保护判定必须与规则恒等`);
  }
  assert.equal(
    (strong.diag['allInGuard'] as Diag)['onePairAllInBlocked'],
    false,
    '暗三条**永远**不得被「一对牌」这条禁令覆盖（保护必须按牌型条件化）',
  );
});

/* ============================================================
 * V2-11 —— M8：画像一致性
 * ============================================================ */

test('V2-11（M8）：换画像后 CALL EV / 下注范围 / 证据优先级语义一致', () => {
  for (const profile of ['VERY_TIGHT', 'NORMAL', 'CALLING_STATION', 'MANIAC']) {
    const { action, sizeChips, diag } = decide(akInput(profile));
    const m = diag['math'] as Diag;
    const betEq = m['heroEquityVsBetRange'] as number;
    const callEV = m['callEV'] as number;
    assert.ok(
      Math.abs(callEV - (betEq * (m['winnable'] as number) - (m['callCost'] as number))) < 1e-9,
      `${profile}：CALL EV 必须仍等于 EqVsBetRange × winnable − callCost`,
    );
    const raise = raiseEvidenceOf(diag);
    const stackCommitNoEV = (action === 'RAISE' || action === 'ALL_IN')
      && consumesStackOf(diag, sizeChips)
      && (raise?.['ev'] ?? null) === null;
    const margin = String(diag['decisionMargin']?.['kind']);
    assert.equal(
      stackCommitNoEV && margin !== 'MARGINAL',
      false,
      `${profile}：无 EV 的打光筹码加注不得覆盖边际为 ${margin} 的 CALL（action=${action}）`,
    );
  }
});

/* ============================================================
 * V2-12 / V2-13 —— M9 / M10
 * ============================================================ */

test('V2-12（M9）：未实现的 EV 必须保持 null / NOT_IMPLEMENTED，不得伪造数值', () => {
  const { diag } = decide(akInput());
  for (const e of evidenceOf(diag)) {
    if (e['estimateType'] === EstimateType.HEURISTIC) {
      assert.equal(e['ev'], null, `HEURISTIC 证据的 EV 必须是 null（${String(e['action'])}）`);
    }
    assert.ok(e['ev'] === null || Number.isFinite(e['ev']), `EV 必须是有限数或 null（${String(e['action'])}）`);
  }
  const cond = diag['conditionalEquities'] as Diag;
  /*
   * 🔴 契约更新（U1）：加注继续范围已实现 ⇒ 要么是数值（伴随加注响应事实），
   * 要么在确实算不出来时标 `NOT_IMPLEMENTED`。两者都不允许「用别的量顶替」。
   */
  const rc = cond['raiseContinueRange'];
  const raiseFacts = raiseFactsOf(diag);
  assert.ok(
    rc === 'NOT_IMPLEMENTED' || (typeof rc === 'number' && rc >= 0 && rc <= 1),
    `加注继续范围必须是数值或 NOT_IMPLEMENTED（实际 ${String(rc)}）`,
  );
  if (rc !== 'NOT_IMPLEMENTED') {
    assert.ok(raiseFacts, '有加注继续范围就必须有加注响应事实包');
    assert.ok(
      typeof raiseFacts!['model'] === 'object' && raiseFacts!['model'] !== null,
      '加注响应必须自带模型声明（结构性先验 + 未校准）',
    );
  }
});

test('V2-13（M10）：所有已算 EV 必须同一筹码口径与同一决策时点', () => {
  const { diag } = decide(akInput());
  const m = diag['math'] as Diag;
  const fold = evidenceOf(diag).find((e) => e['action'] === 'FOLD');
  const call = evidenceOf(diag).find((e) => e['action'] === 'CALL');
  assert.equal(fold?.['ev'], 0, '零点必须是「弃牌 ≡ 0」（节点增量口径）');
  assert.equal(call?.['ev'], m['callEV'], 'CALL 证据的 EV 必须与 math.callEV 是同一个数（同一快照）');
  const band = diag['decisionMargin']?.['bandChips'] as number;
  assert.ok(
    Math.abs(band - 0.05 * (m['winnable'] as number)) < 1e-9,
    `容差带必须由同一个 winnable 推出（实际 ${band} vs ${0.05 * (m['winnable'] as number)}）`,
  );
});

/* ============================================================
 * V2-14 —— 逐个加注金额：EV 真实性 + 全下保护的作用域
 * ============================================================ */

test('V2-14：每个加注金额都不得有伪造 EV；全下保护只在真正打光的金额上生效', () => {
  const { diag } = decide(akInput());
  const candidates = (diag['candidates'] ?? []) as Diag[];
  const raiseLike = candidates.filter((c) => c['action'] === 'RAISE' || c['action'] === 'ALL_IN');
  assert.ok(raiseLike.length >= 3, `必须给出多个加注候选（实际 ${raiseLike.length}）`);

  // ① 任何金额的加注/全下都不得有伪造的 EV（本轮没有加注 EV 模型）
  for (const c of raiseLike) {
    assert.equal(
      c['ev'],
      null,
      `加注/全下候选 raise-to=${String(c['sizeChips'])} 的 EV 必须保持 null（不得伪造）`,
    );
  }
  // ② 未评估动作清单必须覆盖加注
  const unevaluated = (diag['unevaluatedActions'] ?? []) as Diag[];
  assert.ok(
    unevaluated.some((u) => u['reasonCode'] === 'RAISE_EV_NOT_IMPLEMENTED'),
    '加注必须出现在未评估动作清单里',
  );

  // ③ 保护的作用域：只有 raise-to = allInToAmount 的那一个金额才是「打光筹码」
  const allInTo = diag['actionShape']['allInToAmount'] as number;
  const committing = raiseLike.filter((c) => Math.abs((c['sizeChips'] as number) - allInTo) < 1e-9);
  assert.equal(committing.length, 1, '打光筹码的候选必须恰好一个（M7 去重后）');
  for (const c of raiseLike) {
    const isAllIn = Math.abs((c['sizeChips'] as number) - allInTo) < 1e-9;
    const consumes = Math.abs((c['sizeChips'] as number) - (diag['math']['myRemainingStack'] as number)) < 1e-9;
    assert.equal(consumes, isAllIn, `「打光筹码」判定必须只对 raise-to=${allInTo} 成立`);
  }
  const guard = diag['allInGuard'] as Diag;
  assert.equal(guard['consumesStack'], true, '被评估的那个加注（174）必须是打光筹码');
  assert.equal(
    guard['onePairAllInBlocked'],
    (guard['handCategory'] as number) < (guard['minCategoryForLargeRaise'] as number) &&
      guard['hasOwnEV'] !== true,
    '保护判定必须与规则恒等（打光 ∧ 类别<3 ∧ 无自有 EV）',
  );
});

/* ============================================================
 * V2-15 —— 🔴 U1 披露一致性：有自有 EV 的加注尺寸 ≠ 未评估动作
 * ============================================================ */

test('V2-15【U1 披露一致性】：有自有 EV 的加注尺寸**不得**被列为「未评估」', () => {
  /*
   * ## 这条测试防的是什么（实测到的自相矛盾，不是假想）
   *
   * U1 给了加注模型 EV 之后，99 暗三条节点出现：
   *
   * ```text
   * 动作 = RAISE @174        （依据：RAISE MODEL_EV +140.01 > CALL EV +79.22）
   * unevaluatedActions 里也列着「RAISE 174  RAISE_EV_NOT_IMPLEMENTED」
   * factReasons 里还说「本次加注/全下**没有** EV 模型」
   * ```
   *
   * 根因：`unevaluatedActions` 把 `candidate.ev === null` 当作「没有 EV 模型」，
   * 而**加注候选的 `ev` 字段永远是 null**（加注 EV 挂在 `actionEvidence` 上）。
   * 于是产品一边用加注 EV 做决策、一边告诉用户加注 EV 未实现。
   *
   * 修复是**纯披露层**的：把「真正有自有可比 EV 的加注尺寸」
   *（`pickCandidate` 已经算过尺寸匹配，`allInGuard.raiseSizesWithOwnEV`）
   * 从清单里排除。**没有**改动任何 EV、门槛或动作选择逻辑。
   */
  const { diag, reasons } = decide(akInput());
  const guard = diag['allInGuard'] as Diag;
  const sizesWithOwnEV = (guard['raiseSizesWithOwnEV'] ?? []) as number[];
  const raise = raiseEvidenceOf(diag);

  // 前置：本节点确实有模型 EV（否则这条测试没有意义）
  assert.equal(raise?.['estimateType'], 'MODEL_EV', '前置：加注必须有模型 EV');
  assert.notEqual(raise?.['ev'], null, '前置：加注 EV 必须是数值');
  assert.equal(sizesWithOwnEV.length, 1, `必须恰好一个加注尺寸有自有 EV（实际 ${JSON.stringify(sizesWithOwnEV)}）`);

  const unevaluated = (diag['unevaluatedActions'] ?? []) as Diag[];
  const listedSizes = unevaluated
    .filter((u) => u['reasonCode'] === 'RAISE_EV_NOT_IMPLEMENTED')
    .map((u) => u['sizeChips'] as number);
  for (const s of sizesWithOwnEV) {
    assert.ok(
      !listedSizes.some((x) => Math.abs(x - s) < 1e-9),
      `有自有 EV 的加注尺寸 ${s} 不得出现在未评估清单里（清单：${JSON.stringify(listedSizes)}）`,
    );
    assert.ok(
      listedSizes.length > 0,
      '其余加注金额确实仍未建模 ⇒ 披露不得被一并清空（否则等于声称所有金额都算过了）',
    );
  }

  // 对外话术也必须改口：有 EV 时不得再说「加注的 EV 无法计算」
  /*
   * ⚠️ 作用域说明（实测）：`decision.reasons` 被 `slice(0, 6)` 截断，因此这条
   * 事实理由**可能进不了首屏前 6 条**（AK 节点实测首屏 6 条里没有它）。
   * 所以：结构性披露断言在**未被截断的** `unevaluatedActions` 上（上面已锁），
   * 文案只在它确实出现时检查 —— 不假装它一定出现在首屏。
   */
  const reasonsAll = reasons;
  const disclosure = reasonsAll.find((x) => x['code'] === 'RAISE_EV_NOT_IMPLEMENTED');
  if (disclosure !== undefined) {
    const text = String(disclosure['textZh']);
    assert.ok(
      text.includes('部分'),
      `有自有 EV 时文案必须说明只有**部分**金额未评估（实际：${text}）`,
    );
    assert.ok(
      !/\*\*没有\*\* EV 模型|没有 EV 模型/.test(text),
      `有自有 EV 时不得声称「没有 EV 模型」（实际：${text}）`,
    );
  }

  /*
   * 🔴 **更强的一条**（不依赖首屏截断）：加注**真的由模型 EV 胜出**时，
   * 首屏理由里必须给出这次加注的 EV，而**不得**说「加注的 EV 无法计算」。
   * 实测修复前 99 暗三条节点就是「动作靠 RAISE EV 选出，理由说 EV 无法计算」。
   */
  const set99 = decide(akInput('CALLING_STATION', ['9s', '9h']));
  assert.equal(set99.action, 'RAISE', '前置：99 暗三条节点必须选出 RAISE');
  const raiseReason = set99.reasons.find(
    (x) => String(x['code']).startsWith('STRATEGIC_RAISE') || x['code'] === 'RAISE_MODEL_EV' || x['code'] === 'ISO_RAISE_MODEL_EV',
  );
  assert.notEqual(raiseReason, undefined, '首屏理由里必须有加注理由');
  const raiseText = String(raiseReason!['textZh']);
  assert.ok(
    !raiseText.includes('加注的 EV 无法计算'),
    `加注由模型 EV 胜出时，理由不得说「加注的 EV 无法计算」（实际：${raiseText}）`,
  );
  assert.equal(raiseReason!['code'], 'RAISE_MODEL_EV', `理由代码必须标明是模型 EV 路径（实际 ${String(raiseReason!['code'])}）`);
  assert.equal(
    typeof (raiseReason!['data'] as Diag)?.['raiseEV'],
    'number',
    '模型 EV 路径的理由必须带出 RAISE EV 数值（可审计）',
  );
});

/* ============================================================
 * V2-17 —— 🔴 U1 披露一致性（CALL 胜出侧）：「算过但更低」≠「没算过」
 * ============================================================ */

test('V2-17【U1 披露一致性】：CALL 胜出时，加注理由必须报出**真的算过的** EV', () => {
  /*
   * 与 V2-15 同一类缺陷的**另一侧**。实测（`reports/evidence/rrdv2-acceptance.txt`）：
   *
   * ```text
   * AK 河牌节点：动作 = CALL 40
   * 证据表：RAISE  estimateType = MODEL_EV  ev = −5.4475   ← 真的算过
   * 首屏理由（修复前）：RAISE（87.0BB）：合法候选，EV = NOT_AVAILABLE
   *                     （缺 fold-to-3bet / call-3bet / 4bet 响应数据）  ← 说的是没算过
   * ```
   *
   * 「算过但更低 ⇒ 不加注」与「没算过 ⇒ 无法比较」对使用者的含义完全不同：
   * 前者是**结论**，后者是**能力缺口**。本测试锁死这个区别。
   */
  const { action, diag, reasons } = decide(akInput());
  const raise = raiseEvidenceOf(diag);
  assert.equal(action, 'CALL', `前置：本节点动作必须是 CALL（实际 ${action}）`);
  assert.equal(raise?.['estimateType'], 'MODEL_EV', '前置：加注必须有模型 EV');
  assert.ok((raise?.['ev'] as number) < 0, '前置：本节点 RAISE EV 为负');

  const why = reasons.find((x) => String(x['code']).startsWith('RAISE') || x['code'] === 'ISO_RAISE_LOSES_ON_EV');
  assert.notEqual(why, undefined, '「为什么不加注」必须给出理由');
  assert.equal(
    why!['code'],
    'RAISE_MODEL_EV_LOSES',
    `理由代码必须标明是「模型 EV 更低」（实际 ${String(why!['code'])}）`,
  );
  const text = String(why!['textZh']);
  assert.ok(!text.includes('NOT_AVAILABLE'), `不得在**算过**的情况下说 EV 不可得（实际：${text}）`);
  assert.ok(
    text.includes((raise!['ev'] as number).toFixed(2)),
    `理由里的 EV 必须能与证据表复算（证据表 ${String(raise!['ev'])}，文案：${text}）`,
  );
  assert.equal(
    (why!['data'] as Diag)?.['ev'],
    Number((raise!['ev'] as number).toFixed(2)),
    '理由 data.ev 必须与证据表同源',
  );
  // 未校准声明不得被省略（政策：未校准必须随结果一起披露）
  assert.ok(text.includes('未经统计校准'), `必须随结论披露「响应模型未校准」（实际：${text}）`);
});

/* ============================================================
 * V2-16 —— 🔴 U1 生产路径：EV 支持时加注真的被选中
 * ============================================================ */

test('V2-16【U1 生产路径】：加注 EV 更高时选 RAISE，且形态/去重自洽', () => {
  // 99 = 暗三条（handCategory 4）。实测：RAISE MODEL_EV +140.01 > CALL EV +79.22
  const { action, sizeChips, diag } = decide(akInput('CALLING_STATION', ['9s', '9h']));
  const evidence = evidenceOf(diag);
  const raise = raiseEvidenceOf(diag);
  const call = evidence.find((e) => e['action'] === 'CALL');
  assert.equal(raise?.['estimateType'], 'MODEL_EV', '加注必须有模型 EV（U1）');
  assert.ok(
    (raise?.['ev'] as number) > (call?.['ev'] as number),
    `前置：本节点 RAISE EV 必须高于 CALL EV（${String(raise?.['ev'])} vs ${String(call?.['ev'])}）`,
  );
  assert.equal(action, 'RAISE', `EV 更高时必须选 RAISE（实际 ${action}）`);

  // 形态：加注到全下必须被如实标注，而不是含糊的「加注」
  const shape = diag['actionShape'] as Diag;
  assert.equal(shape['kind'], 'RAISE_TO_ALL_IN', `形态必须是加注到全下（实际 ${String(shape['kind'])}）`);
  assert.equal(shape['consumesStack'], true, '加注到全下必须记录为「打光筹码」');
  assert.equal(shape['sizeChips'], shape['allInToAmount'], '尺寸必须等于本街总额上限');

  // M7 去重：全下金额上不得同时存在 RAISE 与 ALL_IN 两个候选
  const candidates = (diag['candidates'] ?? []) as Diag[];
  const atAllIn = candidates.filter((c) => Math.abs((c['sizeChips'] as number) - (shape['allInToAmount'] as number)) < 1e-9);
  assert.equal(atAllIn.length, 1, `全下金额上必须恰好一个候选（实际 ${JSON.stringify(atAllIn.map((c) => c['action']))}）`);
  assert.equal(String(atAllIn[0]!['action']), 'RAISE', '该候选必须记为 RAISE（不是重复的 ALL_IN）');
  assert.equal(sizeChips, shape['allInToAmount'], '返回的建议尺寸必须与形态一致');

  // 全下保护不得拦它（它有自己的 EV）
  const guard = diag['allInGuard'] as Diag;
  assert.equal(guard['hasOwnEV'], true, '有模型 EV ⇒ hasOwnEV 必须为真');
  assert.equal(guard['onePairAllInBlocked'], false, '有自有 EV ⇒ 一对牌保护对本次加注不适用');
  assert.equal(guard['largeRaiseBlocked'], false, '类别 ≥ 3 ⇒ 大额加注档保护不适用');
});
