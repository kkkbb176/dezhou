/**
 * ============================================================================
 * PREFLOP P0 · F2 —— 「一对牌全下」保护的**街道适用范围**（永久回归）
 * ============================================================================
 *
 * ## 被锁的缺陷（`reports/PREFLOP_DECISION_PATH_AUDIT_V1.md` §四 F2）
 *
 * `shouldRaise`（`decisionEngine.ts:1027-1039`）与 `allInGuardVerdictOf`（`:952-982`）
 * 都以**成手牌类别** `handCategory` 为判据（`< MIN_CATEGORY_FOR_LARGE_RAISE = 3`）。
 * 但**翻前没有成手牌**：`contextBuilder.ts:648` 是 `described?.category ?? 0`，
 * 翻前 `described === null` ⇒ **`handCategory ≡ 0` 恒成立**
 *（这一点 `decisionEngine.ts:218-223` 自己就写着，只是它是为「牌力分档」写的）。
 *
 * 后果（审计实测，BB 5BB 持 A♠A♥ 面对 BTN 开池 3BB）：
 *
 * ```text
 * legal  = [FOLD, CALL, RAISE, ALL_IN]   minRaiseTo = allInTo = 10
 * 候选   = [FOLD 0, CALL 4 (+6.945675), RAISE 10 (EV = null)]   ← 唯一加注 = 全下
 * guard  = { handCategory: 0, consumesStack: true, hasOwnEV: false,
 *            onePairAllInBlocked: true }
 * ⇒ shouldRaise 在 :1035 返回 false ⇒ 该加注**不是**候选 ⇒ 动作 = CALL 4（身后剩 2BB）
 * ```
 *
 * 即：**翻后**「一对牌打光」的保护，被**无条件**套用到翻前 ⇒ 翻前的全下加注
 * （短码推注、4bet 全下）结构性不可达。修法是给它**明确的街道适用条件**
 *（不是删除保护规则，也不是把翻后类别硬映射成翻前的 AA/KK 强度档位）。
 *
 * ## 本文件断言什么（**不硬编码**任何手牌的最终动作）
 *
 * | 组 | 断言 |
 * |---|---|
 * | A–D | 翻前合法全下**不再被翻后牌型保护拦下**，且全下候选仍在候选表里 |
 * | A–D | 无 EV 的加注**仍然**如实标 `ev = null`（不得因为「允许全下」就伪造 EV） |
 * | M1 | 弱牌/中等牌（72o、55、JTs、A5s）在同样节点上**仍然不能**推全下 |
 * | M5 | 翻后「一对牌 + 打光 + 无自有 EV」的保护**仍然生效**（多人池 turn 生产节点） |
 * | M6 | 短到「最小加注 > 全下额」的边界：跟注即全下，不得被拒 |
 * | M9 | 有效筹码扫描 3–25BB：全下候选始终在候选表里、保护不再误触发 |
 * | M10 | 底池比例保护（`MAX_RAISE_TO_POT_RATIO`）与翻前的既有判据**未被改动** |
 * | 街道矩阵 | `allInGuardVerdictOf` 对 PREFLOP / FLOP / TURN / RIVER 的适用性逐一穷举 |
 *
 * ⚠️ 所有节点都走**生产入口** `analyzeManualHand`，不是纯函数模拟；
 * 纯函数只用于「街道矩阵」一节（它是保护规则的**定义**所在）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { allInGuardVerdictOf } from '../src/app/decision/decisionEngine.ts';
import { Street } from '../src/domain/types.ts';
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
const V = (bb: number, profile = 'NORMAL'): ManualVillain =>
  ({ quickProfile: profile, dynamicHint: 'UNKNOWN', stackBB: bb }) as ManualVillain;
const stacks = (bb: number): Record<string, number> => ({ UTG: bb, HJ: bb, CO: bb, BTN: bb, SB: bb, BB: bb });

/** 审计报告 F2 的原始生产节点：6 人桌 · 盲注 1/2 · UTG/HJ/CO 弃 → BTN 加注至 3BB → SB 弃 ⇒ Hero BB 行动 */
const OPEN_TO_3BB: readonly Row[] = [
  A_('UTG', 'FOLD'), A_('HJ', 'FOLD'), A_('CO', 'FOLD'), A_('BTN', 'RAISE', 3), A_('SB', 'FOLD'),
];
function bbVsOpen(heroCards: readonly [string, string], bb: number): ManualHandInput {
  return {
    tableSize: 6, heroPosition: 'BB', heroCards, board: [], street: 'PREFLOP',
    effectiveStackBB: bb, bigBlindBB: 2, seatStacksBB: stacks(bb),
    actionHistory: [...OPEN_TO_3BB], environment: 'MID_LOW_STAKES', villain: V(bb),
  } as unknown as ManualHandInput;
}

/**
 * 翻后对照节点（**多人池** ⇒ 「面对加注的响应模型」按单挑口径建模 ⇒ 不可用
 * ⇒ `hasOwnEV = false`，因此这是生产路径上**真的**会触发「一对牌全下」保护的节点）：
 *
 * 6 人桌 · 盲注 1/2 · 双方 25BB · Hero BTN A♠K♠ · 牌面 K♦9♣4♥6♠（转牌，顶对 = 类别 2）
 * 翻前 UTG/CO 溜入 → BTN 加注至 5BB → 全跟；翻牌 BB 过牌/弃牌 → UTG/CO 过牌 → BTN 下注 6BB → 跟；
 * 转牌 UTG 下注 7BB → CO 跟 ⇒ Hero 面对下注（底池 105、跟注 14、Hero 剩余 28 = 唯一加注即全下 28）。
 */
const MULTIWAY_TURN_ONE_PAIR = {
  tableSize: 6, heroPosition: 'BTN', heroCards: ['As', 'Ks'], board: ['Kd', '9c', '4h', '6s'],
  street: 'TURN', effectiveStackBB: 25, bigBlindBB: 2, seatStacksBB: stacks(25),
  actionHistory: [
    A_('UTG', 'CALL', 1), A_('HJ', 'FOLD'), A_('CO', 'CALL', 1), A_('BTN', 'RAISE', 5), A_('SB', 'FOLD'),
    A_('BB', 'CALL', 4), A_('UTG', 'CALL', 4), A_('CO', 'CALL', 4),
    A_('BB', 'CHECK', undefined, 'FLOP'), A_('UTG', 'CHECK', undefined, 'FLOP'), A_('CO', 'CHECK', undefined, 'FLOP'),
    A_('BTN', 'BET', 6, 'FLOP'), A_('BB', 'FOLD'), A_('UTG', 'CALL', 6, 'FLOP'), A_('CO', 'CALL', 6, 'FLOP'),
    A_('UTG', 'BET', 7, 'TURN'), A_('CO', 'CALL', 7, 'TURN'),
  ],
  environment: 'MID_LOW_STAKES', villain: V(25, 'CALLING_STATION'),
} as unknown as ManualHandInput;

/** 翻后**强牌**对照：河牌暗三条（99 在 K♦9♣4♥6♠2♦ = 类别 4）面对 20BB 领打 */
const RIVER_SET = {
  tableSize: 6, heroPosition: 'BTN', heroCards: ['9s', '9h'], board: ['Kd', '9c', '4h', '6s', '2d'],
  street: 'RIVER', effectiveStackBB: 100, bigBlindBB: 2, seatStacksBB: stacks(100),
  actionHistory: [
    A_('UTG', 'FOLD'), A_('HJ', 'FOLD'), A_('CO', 'FOLD'), A_('BTN', 'RAISE', 3), A_('SB', 'FOLD'),
    A_('BB', 'CALL', 2),
    A_('BB', 'CHECK', undefined, 'FLOP'), A_('BTN', 'BET', 2.5, 'FLOP'), A_('BB', 'CALL', 2.5, 'FLOP'),
    A_('BB', 'CHECK', undefined, 'TURN'), A_('BTN', 'BET', 7.5, 'TURN'), A_('BB', 'CALL', 7.5, 'TURN'),
    A_('BB', 'BET', 20, 'RIVER'),
  ],
  environment: 'MID_LOW_STAKES', villain: V(100, 'CALLING_STATION'),
} as unknown as ManualHandInput;

type Diag = Record<string, any>;
type Run = {
  readonly action: string;
  readonly sizeChips: number | null;
  readonly diag: Diag;
  readonly reasons: readonly Diag[];
  readonly warnings: readonly string[];
  readonly classification: string;
  readonly confidence: number;
};

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
    warnings: (r.warnings ?? []) as readonly string[],
    classification: String(d['classification']),
    confidence: Number(d['confidence']),
  };
}

const mathOf = (run: Run): Diag => (run.diag['math'] ?? {}) as Diag;
const guardOf = (run: Run): Diag => (run.diag['allInGuard'] ?? {}) as Diag;
const candidatesOf = (run: Run): readonly Diag[] => (run.diag['candidates'] ?? []) as readonly Diag[];
const evidenceOf = (run: Run): readonly Diag[] => (run.diag['actionEvidence'] ?? []) as readonly Diag[];
const raiseEvidenceOf = (run: Run): Diag | undefined => evidenceOf(run).find((e) => e['action'] === 'RAISE');
const reasonCodes = (run: Run): readonly string[] => run.reasons.map((x) => String(x['code']));

/** 「加注到全下」= 本街累计总额（`allInToAmount = 本街已投入 + 剩余筹码`） */
const allInToOf = (run: Run): number => {
  const m = mathOf(run);
  return (m['myCommittedThisStreet'] as number) + (m['myRemainingStack'] as number);
};
/** 候选表里是否存在「加注到全下额」这一档（M3：不得在候选选择阶段被删掉） */
const hasAllInRaiseCandidate = (run: Run): boolean =>
  candidatesOf(run).some(
    (c) => String(c['action']) === 'RAISE' && typeof c['sizeChips'] === 'number' && Math.abs((c['sizeChips'] as number) - allInToOf(run)) < 1e-9,
  );

/* ============================================================
 * A–D：翻前合法全下不再被「翻后牌型保护」拦下
 * ============================================================ */

const PREFLOP_CASES: ReadonlyArray<readonly [string, ManualHandInput]> = [
  ['A · 5BB AA', bbVsOpen(['As', 'Ah'], 5)],
  ['B · 5BB KK', bbVsOpen(['Ks', 'Kh'], 5)],
  ['C · 5BB AKs', bbVsOpen(['As', 'Ks'], 5)],
  ['D · 10BB AA（另有非全下尺寸）', bbVsOpen(['As', 'Ah'], 10)],
];

test('F2-1（A–D）：翻前「加注到全下」不得被**翻后**的一对牌保护拦下', () => {
  for (const [tag, input] of PREFLOP_CASES) {
    const run = decide(input);
    const m = mathOf(run);
    const g = guardOf(run);

    /* 前置：本节点确实是翻前、确实是合法全下候选 */
    assert.equal(String(m['street']), 'PREFLOP', `${tag}：前置必须是翻前节点`);
    assert.equal(Number(m['handCategory']), 0, `${tag}：前置——翻前没有成手牌类别（handCategory ≡ 0）`);
    assert.ok(
      hasAllInRaiseCandidate(run),
      `${tag}：前置——候选表里必须有「加注到 ${allInToOf(run)}（全下）」这一档，实际 ${JSON.stringify(candidatesOf(run).map((c) => `${String(c['action'])}@${String(c['sizeChips'])}`))}`,
    );

    /* 🔴 被锁的断言：保护不得在翻前触发 */
    assert.equal(
      g['onePairAllInBlocked'],
      false,
      `${tag}：翻前的合法全下被**翻后**的「一对牌全下」保护拦下了（handCategory=0 是翻前的正常值，不是「一对牌」）` +
        `｜consumesStack=${String(g['consumesStack'])}、hasOwnEV=${String(g['hasOwnEV'])}、noteZh=${String(g['noteZh'])}`,
    );
    /* 披露：当「打光」成立（即保护本来会拦）时，必须写明街道不适用，而不是沉默；
       不成立时该函数本就有更早、更贴切的「不是全下加注」返回分支，不要求出现「翻前」字样 */
    if (g['consumesStack'] === true) {
      assert.match(
        String(g['noteZh']),
        /翻前/,
        `${tag}：全下保护的判定说明必须写明街道适用范围，实际「${String(g['noteZh'])}」`,
      );
    } else {
      assert.match(
        String(g['noteZh']),
        /不适用/,
        `${tag}：非全下加注也必须如实说明保护不适用，实际「${String(g['noteZh'])}」`,
      );
    }
    /*
     * 🔴 **阶段 B 起的口径变更（有据可依，不是放宽断言）**
     *
     * 修复前这里断言 `hasOwnEV === false`，理由写在当时：**「翻前没有
     * 3bet/4bet 响应模型」**。阶段 B 把这个模型建出来了
     *（`preflopRaiseFacts.ts` / `preflopRaiseResponse.ts`），
     * 因此「翻前的加注没有自有 EV」**不再是事实**——
     * 断言必须跟着事实走，而不是把旧行为锁死。
     *
     * 现在锁的是**更强**的性质：有 EV 就必须是**真的**自有 EV
     *（金额在事实包里、契约匹配、EV 非 null），而不是随口说 true。
     */
    assert.equal(g['hasOwnEV'], true, `${tag}：阶段 B 起翻前加注**有**自有 EV ⇒ hasOwnEV 必须为 true`);
    const raise = raiseEvidenceOf(run);
    assert.notEqual(raise, undefined, `${tag}：RAISE 必须有证据条目`);
    assert.notEqual(raise!['ev'], null, `${tag}：有自有 EV ⇒ 证据条目里必须真的给出 EV`);
    assert.equal(String(raise!['estimateType']), 'MODEL_EV', `${tag}：估计类型必须如实写 MODEL_EV`);
    const sizes = (guardOf(run)['raiseSizesWithOwnEV'] ?? []) as number[];
    assert.ok(sizes.length > 0, `${tag}：必须至少有一个尺寸带自有 EV`);
    const pr = (run.diag['preflopRaise'] ?? null) as Diag | null;
    assert.notEqual(pr, null, `${tag}：翻前加注事实包必须存在`);
    for (const size of sizes) {
      assert.ok(
        (pr!['sizes'] as readonly Diag[]).some((s) => Number(s['sizeChips']) === size),
        `${tag}：声称有自有 EV 的尺寸 ${size} 必须真的在事实包里（不得凭空声明）`,
      );
    }
  }
});

test('F2-3（M7/M8）：允许全下 ≠ 伪造 EV —— 每个加注金额的 EV 必须来自它**自己**的尺寸', () => {
  for (const [tag, input] of PREFLOP_CASES) {
    const run = decide(input);
    const raise = raiseEvidenceOf(run);
    assert.notEqual(raise, undefined, `${tag}：RAISE 必须有证据条目`);

    /*
     * 🔴 **阶段 B 起的口径变更**：修复前这里断言「翻前加注 EV 必须是 null」，
     * 理由是当时确实没有翻前响应模型。现在有了（阶段 B），
     * 因此断言改成锁**更强**的性质 —— 不得借用别的尺寸的 EV：
     *
     * ```text
     * 证据里那个 EV 必须能在事实包里找到**同一个金额**的 raiseEV，
     * 且两者逐位相等（尺寸对不上就是「拿别的动作的数字冒充本动作」）。
     * ```
     */
    const pr = (run.diag['preflopRaise'] ?? null) as Diag | null;
    const chosenSize = run.sizeChips;
    if (raise!['ev'] === null) {
      /* 没有自有 EV 的加注仍然必须如实标 null，且不得声称有模型 */
      assert.deepEqual([...((guardOf(run)['raiseSizesWithOwnEV'] ?? []) as number[])], [], `${tag}：标了 null 就不得声称任何尺寸有自有 EV`);
      return;
    }
    assert.notEqual(pr, null, `${tag}：有 EV 就必须有事实包`);
    assert.notEqual(chosenSize, null, `${tag}：有 EV 就必须有金额（raise-to 口径）`);
    const sizeFacts = (pr!['sizes'] as readonly Diag[]).find((s) => Number(s['sizeChips']) === chosenSize);
    assert.notEqual(sizeFacts, undefined, `${tag}：被比较的金额 ${String(chosenSize)} 必须在事实包里`);
    assert.ok(
      Math.abs(Number(sizeFacts!['raiseEV']) - Number(raise!['ev'])) < 1e-6,
      `${tag}：证据 EV 必须等于**该金额自己**的 raiseEV（不得借用别的尺寸）`,
    );
  }
});

test('F2-4：不得为了「让全下可达」而伪造 EV 或绕过既有证据纪律', () => {
  for (const [tag, input] of PREFLOP_CASES) {
    const run = decide(input);
    const m = mathOf(run);
    const callEV = m['callEV'] as number | null;
    const callEvidence = evidenceOf(run).find((e) => e['action'] === 'CALL');
    const raise = raiseEvidenceOf(run);
    const commitsStack = guardOf(run)['consumesStack'] === true;
    if (callEV === null || callEvidence === undefined || raise === undefined) continue;
    const callIsClear = String(callEvidence['decisionMargin']) === 'CLEAR_CALL_OVER_FOLD';
    const raiseHasNoEV = raise['ev'] === null;
    /* 既有纪律（`evidencePriority.ts:392-399`）：**打光筹码**且**没有 EV** 的启发式加注
       不得覆盖边际清晰的 CALL 证据 ⇒ 若两者同时成立，动作不得是那个全下 */
    if (callIsClear && raiseHasNoEV && commitsStack) {
      const isStackCommittingRaise =
        (run.action === 'RAISE' || run.action === 'ALL_IN') &&
        run.sizeChips !== null &&
        Math.abs(run.sizeChips - allInToOf(run)) < 1e-9;
      assert.equal(
        isStackCommittingRaise,
        false,
        `${tag}：边际清晰的 CALL（EV ${String(callEV)}）被一个没有 EV 的全下覆盖了`,
      );
      /* 但同时必须**如实披露**它被考虑过、以及被哪条规则拦下 */
      const src = (run.diag['decisionSource'] ?? {}) as Diag;
      assert.equal(
        String(src['overrideAttempt'] ?? '') !== '' || Number(raise['heuristicScore']) === 0,
        true,
        `${tag}：全下被考虑过就必须留下痕迹（overrideAttempt / heuristicScore）`,
      );
    }
    /*
     * 🔴 **阶段 B 新增：有 EV 的全下也必须赢在容差带之外**（或如实披露偏离）。
     *
     * 这是「全下保护」在翻前的对应物：全下是不可逆的，因此
     * ① 它必须自带模型 EV；② 若它与最佳非全下候选的差落在模型容差带内，
     * 则改选非全下候选并**显式说明偏离了最高模型 EV**。
     */
    if (commitsStack && run.sizeChips !== null && Math.abs(run.sizeChips - allInToOf(run)) < 1e-9) {
      assert.notEqual(raise['ev'], null, `${tag}：被选中的全下必须自带模型 EV`);
      const codes = reasonCodes(run);
      const protection = codes.includes('PREFLOP_ALL_IN_UNCERTAINTY_PROTECTION');
      assert.equal(protection, false, `${tag}：若触发保护就不该选中全下 —— 两者不可能同时为真`);
    }
    if (reasonCodes(run).includes('PREFLOP_ALL_IN_UNCERTAINTY_PROTECTION')) {
      /* 触发保护 ⇒ 选中的必须**不是**全下，且必须给出「最高 EV 是哪个金额」 */
      assert.ok(
        run.sizeChips === null || Math.abs(run.sizeChips - allInToOf(run)) >= 1e-9,
        `${tag}：触发全下保护时不得选中全下`,
      );
      const reason = run.reasons.find((r) => String(r['code']) === 'PREFLOP_ALL_IN_UNCERTAINTY_PROTECTION');
      const data = (reason?.['data'] ?? {}) as Diag;
      assert.notEqual(data['bestEvSizeChips'], 'NONE', `${tag}：必须报出最高 EV 是哪一个金额`);
      assert.ok(String(reason?.['textZh']).includes('偏离'), `${tag}：必须显式写明「偏离最高模型 EV」`);
    }
  }
});

/* ============================================================
 * M1：弱牌 / 中等牌**仍然**不能凭牌力档位拿到全下
 * ============================================================ */

test('M1：弱牌与中等牌不得**凭牌力档位**拿到全下；全下必须由它**自己的模型 EV** 赢出来', () => {
  /*
   * ## 🔴 阶段 B 起的口径变更（有据可依，不是放宽断言）
   *
   * 修复前本测试断言「弱/中等起手牌在 5BB 节点上拿不到全下」，
   * 而那在当时**是**正确的 —— 因为翻前没有任何加注 EV 模型，
   * 全下只能由「牌力档位 + 权益优势」的启发式放行，弱牌的档位不够。
   *
   * 阶段 B 把翻前加注 EV 建出来了（`preflopRaiseResponse.ts`），
   * 于是「弱牌能不能推」不再由**牌名**决定，而由**EV**决定 ——
   * 这正是使用者第五节的硬要求：
   *
   * > 「不得因为牌名是 AA、AK 就强制覆盖 EV 排名。」
   * > 反面同样成立：不得因为牌名是 55、JTs 就否决一个 EV 更高的动作。
   *
   * ## 本测试现在锁什么（比旧断言更强）
   *
   * 1. **弱/中等牌不得凭档位拿到启发式准入**（`heuristicScore === 0`）——
   *    旧缺陷（用牌力当代理）没有被悄悄放回来；
   * 2. 若它们确实被选为全下，那必须是 **`MODEL_EV` 路径**：
   *    证据表里的 EV 非 null、估计类型是 `MODEL_EV`，
   *    且该 EV **逐位等于**它自己尺寸的 `raiseEV`（不借用别的尺寸）；
   * 3. 全下被选中时，还必须已经赢过最佳非全下候选（或如实披露偏离）。
   */
  const cases: ReadonlyArray<readonly [string, readonly [string, string], string]> = [
    ['72o（WEAK）', ['7s', '2d'], '起手牌：弱起手牌'],
    ['55（小对子 ⇒ MEDIUM）', ['5s', '5h'], '起手牌：小对子'],
    ['JTs（同花连张 ⇒ MEDIUM）', ['Js', 'Ts'], '起手牌：同花连张'],
    ['A5s（A 带小脚同花 ⇒ WEAK）', ['As', '5s'], '起手牌：A 带小脚同花'],
  ];
  for (const [tag, cards, expectedLabel] of cases) {
    const run = decide(bbVsOpen(cards, 5));
    const raise = raiseEvidenceOf(run);
    const m = mathOf(run);
    assert.ok(
      String(m['handRankZh']).startsWith(expectedLabel),
      `${tag}：前置——起手牌档位标签必须是「${expectedLabel}…」，实际「${String(m['handRankZh'])}」`,
    );
    /* ① 档位不能单独放行加注（旧缺陷的永久锁） */
    assert.equal(
      Number(raise?.['heuristicScore'] ?? 0),
      0,
      `${tag}：起手牌档位不足以支撑全下 ⇒ 启发式准入必须仍然不通过（实际 heuristicScore=${String(raise?.['heuristicScore'])}）`,
    );

    const isStackOff =
      (run.action === 'RAISE' || run.action === 'ALL_IN') &&
      run.sizeChips !== null &&
      Math.abs(run.sizeChips - allInToOf(run)) < 1e-9;

    if (!isStackOff) {
      /* 没推 ⇒ 与旧行为一致，无需更多断言 */
      continue;
    }
    /* ② 推了就必须是模型 EV 赢出来的，且 EV 属于它自己的尺寸 */
    assert.notEqual(
      raise?.['ev'],
      null,
      `${tag}：被选中的全下必须自带模型 EV（不得靠档位或启发式）`,
    );
    assert.equal(String(raise?.['estimateType']), 'MODEL_EV', `${tag}：估计类型必须是 MODEL_EV`);
    const pr = (run.diag['preflopRaise'] ?? null) as Diag | null;
    assert.notEqual(pr, null, `${tag}：有 EV 就必须有事实包`);
    const sizeFacts = (pr!['sizes'] as readonly Diag[]).find(
      (s) => Number(s['sizeChips']) === run.sizeChips,
    );
    assert.notEqual(sizeFacts, undefined, `${tag}：被选中的金额必须在事实包里`);
    assert.ok(
      Math.abs(Number(sizeFacts!['raiseEV']) - Number(raise!['ev'])) < 1e-6,
      `${tag}：证据 EV 必须等于该金额自己的 raiseEV`,
    );
    /* ③ 它必须真的胜出，或如实披露偏离 */
    const codes = reasonCodes(run);
    const protection = codes.includes('PREFLOP_ALL_IN_UNCERTAINTY_PROTECTION');
    assert.equal(protection, false, `${tag}：触发保护时不应选中全下`);
    assert.ok(
      codes.includes('RAISE_MODEL_EV'),
      `${tag}：由模型 EV 选出的加注必须留下 RAISE_MODEL_EV 理由（实际 ${JSON.stringify(codes)}）`,
    );
  }
});

/* ============================================================
 * M5：翻后的「一对牌全下」保护**仍然生效**
 * ============================================================ */

test('M5-1（翻后生产节点）：一对牌 + 打光 + 无自有 EV ⇒ 保护仍然触发', () => {
  const run = decide(MULTIWAY_TURN_ONE_PAIR);
  const m = mathOf(run);
  const g = guardOf(run);
  /*
   * ⚠️ 先把判定所需的三个布尔量取成局部常量：`assert.equal` 在 Node 的类型里
   * 带 `asserts actual is T` 的收窄，先断言再比较会让后面的 `!== true`
   * 被 TS 判成「'false' 与 'true' 永不重叠」的无效比较。
   */
  const consumesStack = g['consumesStack'] === true;
  const hasOwnEV = g['hasOwnEV'] === true;
  const category = Number(m['handCategory']);
  const minCategory = Number(g['minCategoryForLargeRaise']);
  /** 既有规则恒等式（与 `riverRaiseDecisionV2.test.ts` V2-2 同一口径） */
  const ruleIdentity = consumesStack && category < minCategory && !hasOwnEV;

  /* 前置：确实是「一对牌 + 唯一加注即全下 + 没有自有 EV」 */
  assert.equal(String(m['street']), 'TURN', '前置必须是转牌节点');
  assert.equal(category, 2, `前置必须是一对牌（实际类别 ${String(m['handCategory'])}）`);
  assert.equal(consumesStack, true, '前置：候选加注确实是全下');
  assert.equal(hasOwnEV, false, '前置：多人池 ⇒ 「面对加注的响应模型」不可用 ⇒ 没有自有 EV');
  assert.deepEqual([...(g['raiseSizesWithOwnEV'] as number[])], [], '前置：没有带自有 EV 的加注尺寸');

  /* 🔴 被锁的断言：翻后保护不得被本次修复关掉 */
  assert.equal(g['onePairAllInBlocked'], true, '翻后「一对牌打光」的保护必须仍然触发');
  assert.match(String(g['noteZh']), /一对牌全下/, `说明必须点名保护规则，实际「${String(g['noteZh'])}」`);
  assert.equal(
    run.action === 'RAISE' || run.action === 'ALL_IN',
    false,
    `被保护拦下的全下不得成为最终动作（实际 ${run.action}）`,
  );
  assert.equal(g['onePairAllInBlocked'], ruleIdentity, '翻后必须与规则恒等式一致');
});

test('M5-2（翻后强牌）：暗三条打光不受「一对牌」保护限制，加注仍然可达', () => {
  const run = decide(RIVER_SET);
  const m = mathOf(run);
  const g = guardOf(run);
  assert.ok(Number(m['handCategory']) >= 4, `前置：暗三条的类别必须 ≥ 4（实际 ${String(m['handCategory'])}）`);
  assert.equal(g['onePairAllInBlocked'], false, '类别 ≥ 3 ⇒ 「一对牌全下」保护不适用');
  assert.equal(hasAllInRaiseCandidate(run), true, '强牌的全下候选必须在候选表里');
});

/* ============================================================
 * M6 / M9：短码边界与有效筹码扫描
 * ============================================================ */

test('M6：小到「最小加注 > 全下额」的边界——跟注即全下，不得被拒', () => {
  for (const bb of [3, 4]) {
    const run = decide(bbVsOpen(['As', 'Ah'], bb));
    const m = mathOf(run);
    const g = guardOf(run);
    assert.equal(g['onePairAllInBlocked'], false, `${bb}BB：不得触发「一对牌全下」保护`);
    /* 3BB：连加注都不合法（minRaiseTo > allInTo）⇒ 只能跟，而跟注会投入全部剩余 */
    if (bb === 3) {
      const callCandidate = candidatesOf(run).find((c) => String(c['action']) === 'CALL');
      assert.notEqual(callCandidate, undefined, '3BB：必须有 CALL 候选');
      assert.equal(
        Number(callCandidate!['sizeChips']),
        Number(m['myRemainingStack']),
        '3BB：本档跟注即投入全部剩余筹码（等价全下）',
      );
      assert.equal(
        candidatesOf(run).some((c) => String(c['action']) === 'RAISE'),
        false,
        '3BB：minRaiseTo > allInTo ⇒ 不存在合法加注（不是被保护拦下）',
      );
    }
    /* 4BB：加注不合法但 ALL_IN 合法 ⇒ 直接全下候选必须保留，且不得被保护拦下 */
    if (bb === 4) {
      assert.equal(
        candidatesOf(run).some((c) => String(c['action']) === 'ALL_IN'),
        true,
        `4BB：minRaiseTo > allInTo 但 ALL_IN 合法 ⇒ 直接全下候选必须在候选表里，实际 ${JSON.stringify(candidatesOf(run).map((c) => String(c['action'])))}`,
      );
    }
  }
});

test('M9：有效筹码 3–25BB 扫描——全下候选始终在候选表里，保护不再误触发', () => {
  const depths = [3, 4, 5, 6, 7, 8, 9, 10, 12, 15, 20, 25];
  for (const bb of depths) {
    const run = decide(bbVsOpen(['As', 'Ah'], bb));
    const g = guardOf(run);
    assert.equal(
      g['onePairAllInBlocked'],
      false,
      `${bb}BB：翻前合法全下被翻后牌型保护拦下（noteZh=${String(g['noteZh'])}）`,
    );
    assert.equal(g['handCategory'], 0, `${bb}BB：翻前类别恒为 0 —— 不得被改写成「一对牌」`);
    /*
     * 全下额必须可达，三条合法表达方式之一：
     * ① 有「加注到全下额」候选（`minRaiseTo ≤ allInTo`）；
     * ② 有独立的 `ALL_IN` 候选（`minRaiseTo > allInTo` 但直接全下合法）；
     * ③ 连加注都不合法（`minRaiseTo > allInTo` 且 ALL_IN 不在合法动作里），
     *    此时**跟注本身就是全下**（跟注额 = 全部剩余筹码）—— 这是规则，不是拦截。
     */
    const allInTo = allInToOf(run);
    const callCandidate = candidatesOf(run).find((c) => String(c['action']) === 'CALL');
    const callIsAllIn =
      callCandidate !== undefined &&
      typeof callCandidate['sizeChips'] === 'number' &&
      Math.abs((callCandidate['sizeChips'] as number) - Number(mathOf(run)['myRemainingStack'])) < 1e-9;
    const reachable =
      hasAllInRaiseCandidate(run) ||
      candidatesOf(run).some((c) => String(c['action']) === 'ALL_IN') ||
      (callIsAllIn && !candidatesOf(run).some((c) => String(c['action']) === 'RAISE'));
    assert.equal(
      reachable,
      true,
      `${bb}BB：全下额 ${allInTo} 必须可达（候选表 ${JSON.stringify(candidatesOf(run).map((c) => `${String(c['action'])}@${String(c['sizeChips'])}`))}）`,
    );
  }
});

/* ============================================================
 * M10：未被改动的既有判据（防止「靠调阈值让 AA 全下」）
 * ============================================================ */

test('M10：底池比例保护与既有证据纪律保持原样（未被调参掩盖）', () => {
  const run = decide(bbVsOpen(['As', 'Ah'], 100));
  const g = guardOf(run);
  const m = mathOf(run);
  assert.equal(String(m['street']), 'PREFLOP', '前置：翻前节点');
  /*
   * 🔴 **阶段 B 起的口径变更**：修复前这里断言「100BB 时选中的加注不是全下」，
   * 依据是当时的实际输出（尺寸启发式选 pot+2c）。
   *
   * 阶段 B 起，被比较的加注候选 = **模型 EV 最高**的那个合法尺寸，
   * 而 100BB 深时 AA 的全下 EV（+21.45）显著高于最佳非全下尺寸（+12.39，
   * 差 9.06 筹码，远超模型容差带 ±0.65）⇒ 全下**被合法地选中**。
   *
   * 因此本测试改为锁**规则本身**（阈值与判据未被调参），
   * 而不再锁某一个结果尺寸：
   *
   * 1. `minCategoryForLargeRaise` 仍为 3（阈值未动）；
   * 2. 翻后语义下恒等式仍然成立（类别 < 3 ∧ 打光 ∧ 无自有 EV ⇒ 被拦）；
   * 3. 翻前若选中的是**全下**，它必须自带模型 EV 且赢了容差带之外 ——
   *    这正是「没有被调参掩盖」的可执行形式。
   */
  assert.equal(g['minCategoryForLargeRaise'], 3, '阈值不得被改动');
  assert.equal(g['onePairAllInBlocked'], false, '翻前没有成手牌类别 ⇒ 该保护按街道不适用');

  const isStackOff =
    (run.action === 'RAISE' || run.action === 'ALL_IN') &&
    run.sizeChips !== null &&
    Math.abs(run.sizeChips - allInToOf(run)) < 1e-9;
  if (isStackOff) {
    const raise = raiseEvidenceOf(run);
    assert.notEqual(raise?.['ev'], null, '被选中的全下必须自带模型 EV');
    assert.equal(String(raise?.['estimateType']), 'MODEL_EV', '估计类型必须是 MODEL_EV');
    const pr = (run.diag['preflopRaise'] ?? null) as Diag | null;
    assert.notEqual(pr, null, '必须有翻前加注事实包');
    const allEVs = (pr!['sizes'] as readonly Diag[])
      .map((s) => Number(s['raiseEV']))
      .filter((v) => Number.isFinite(v));
    const bestEV = Math.max(...allEVs);
    const band = 0.05 * Number(m['winnable']);
    const alternativeBest = Math.max(
      ...(pr!['sizes'] as readonly Diag[])
        .filter((s) => s['isAllIn'] !== true)
        .map((s) => Number(s['raiseEV']))
        .filter((v) => Number.isFinite(v)),
    );
    assert.ok(
      Math.abs(Number(raise?.['ev']) - bestEV) < 1e-6,
      '被选中的全下必须是网格里 EV 最高的那个尺寸',
    );
    assert.ok(
      bestEV - alternativeBest > band,
      `容差带内不得授权全下：优势 ${(bestEV - alternativeBest).toFixed(2)} 必须 > 带 ${band.toFixed(2)}`,
    );
  }

  /* 恒等式在翻后语义下仍然成立：类别 < 3 ∧ 打光 ∧ 无自有 EV ⇒ 被拦（由 M5-1 实测） */
  assert.equal(
    allInGuardVerdictOf({ handCategory: 2, consumesStack: true, hasOwnEV: false, street: Street.RIVER })
      .onePairAllInBlocked,
    true,
    'RIVER：类别 2 + 打光 + 无自有 EV ⇒ 必须被拦（阈值/规则未被放松）',
  );
  assert.equal(
    allInGuardVerdictOf({ handCategory: 2, consumesStack: true, hasOwnEV: false }).onePairAllInBlocked,
    true,
    '缺省（不传街道）必须保持既有语义：规则生效（向后兼容既有调用方与单测）',
  );
});

/* ============================================================
 * 街道适用矩阵（保护规则的**定义**所在：纯函数穷举）
 * ============================================================ */

test('街道矩阵：PREFLOP 不适用；FLOP/TURN/RIVER 与缺省都必须生效', () => {
  const rows: ReadonlyArray<readonly [string, number, boolean, boolean]> = [
    ['一对牌 + 打光 + 无 EV', 2, true, false],
    ['一对牌 + 打光 + 有 EV', 2, true, true],
    ['一对牌 + 不打光 + 无 EV', 2, false, false],
    ['两对及以上 + 打光 + 无 EV', 3, true, false],
    ['高牌 + 打光 + 无 EV', 1, true, false],
  ];
  for (const [tag, category, consumesStack, hasOwnEV] of rows) {
    const preflop = allInGuardVerdictOf({ handCategory: category, consumesStack, hasOwnEV, street: Street.PREFLOP });
    assert.equal(
      preflop.onePairAllInBlocked,
      false,
      `${tag}｜PREFLOP：翻前没有成手牌类别 ⇒ 该保护必须按街道不适用（实际 ${String(preflop.onePairAllInBlocked)}）`,
    );
    assert.match(preflop.reasonZh, /不适用/, `${tag}｜PREFLOP：说明必须写明不适用`);
    if (consumesStack) {
      /* 「打光」成立时，本街道不适用**正是**该规则不触发的原因 ⇒ 说明必须点明街道 */
      assert.match(preflop.reasonZh, /翻前/, `${tag}｜PREFLOP：说明必须写明街道不适用`);
    }

    for (const street of [Street.FLOP, Street.TURN, Street.RIVER] as const) {
      const verdict = allInGuardVerdictOf({ handCategory: category, consumesStack, hasOwnEV, street });
      const expected = consumesStack && category < 3 && !hasOwnEV;
      assert.equal(
        verdict.onePairAllInBlocked,
        expected,
        `${tag}｜${street}：既有规则必须原样生效（期望 ${String(expected)}）`,
      );
    }
    const legacy = allInGuardVerdictOf({ handCategory: category, consumesStack, hasOwnEV });
    assert.equal(
      legacy.onePairAllInBlocked,
      consumesStack && category < 3 && !hasOwnEV,
      `${tag}｜缺省：向后兼容语义必须不变`,
    );
  }
});
