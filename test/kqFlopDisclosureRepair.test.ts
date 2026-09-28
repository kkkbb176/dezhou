/**
 * KQ_FLOP_DECISION_REPAIR · 阶段一：D1–D5 披露缺陷的定向回归测试
 *
 * ============================================================
 * 本文件锁的是什么
 * ============================================================
 *
 * 审计发现五处**确定性披露缺陷**（报告 `reports/KQ_FLOP_RAISE_42BB_CHECK.md`
 * §J.1 D1–D5）。本文件把它们逐条钉住，**并同时钉住「修复不得改变决策」**：
 *
 * | 编号 | 缺陷 | 本文件的锁 |
 * |---|---|---|
 * | D1 | 候选表自称「无可信估计」，而决策层正是用该尺寸的 MODEL_EV 选的加注 | 有一个尺寸带 EV 且**只有**那一个；其余为「未评估」且**不得**为 0 |
 * | D2 | `decisionMargin` 称「未比较加注」而 `decisionSource` 称「已比较」 | 覆盖面四态由真实数组得出；标签常量不得再断言「未比较加注」 |
 * | D3 | 分类器 `UNKNOWN` 与「实际采用 AGGRESSIVE」并排显示成矛盾 | 两件事分行显示，且**不得**篡改分类结果 |
 * | D4 | 「本次进入模型 = 无」不实（vpip/pfr 明明改了数值） | 三态披露；`vpip`/`pfr` 必须为 `USED`；语义门挡下的项必须为 `NOT_APPLICABLE` |
 * | D5 | RAISE 决策的边际只讲 CALL | 最终动作自己的 EV 必须出现在边际说明里，并披露 EV 来源混合 |
 *
 * ============================================================
 * 黄金局面（**不得改动**）
 * ============================================================
 * Hero CO K♠Q♠｜翻牌 Q♥9♠5♠｜BB CHECK-RAISE TO 14BB｜本街已投 3.5BB｜底池 23BB｜双方开手 100BB
 * 生产基线：`RAISE TO 42BB`、`inputHash hbb5baa22`
 *
 * ⚠️ 本轮是**披露修复**：下面「决策不变」的断言与披露断言同等重要 ——
 * 任何一次重构若改了动作、金额、EV 或响应概率，本文件必须失败。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Position, Street } from '../src/domain/types.ts';
import { GameEnvironment } from '../src/domain/range/gameEnvironment.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import type { ManualHandInput } from '../src/app/manualInput/manualInput.ts';
import { analyzeManualHand, hashManualInput } from '../src/app/alphaPipeline.ts';
import { DecisionAction, DECISION_MARGIN_ZH } from '../src/domain/decision/decision.types.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();

/** 黄金局面：9 人桌，CO 开池 2.5BB，BB 跟注；翻牌 BB 过牌加注到 14BB。 */
function golden(overrides: Partial<ManualHandInput> = {}): ManualHandInput {
  return {
    tableSize: 9,
    heroPosition: Position.CO,
    heroCards: ['Ks', 'Qs'],
    board: ['Qh', '9s', '5s'],
    street: Street.FLOP,
    effectiveStackBB: 100,
    bigBlindBB: 100,
    potBB: 23,
    environment: GameEnvironment.LOW_STAKES_ONLINE,
    occupiedPositions: [
      Position.UTG, Position.UTG1, Position.UTG2, Position.LJ, Position.HJ,
      Position.CO, Position.BTN, Position.SB, Position.BB,
    ],
    buttonPosition: Position.BTN,
    actionHistory: [
      { position: Position.UTG, type: 'FOLD', street: Street.PREFLOP },
      { position: Position.UTG1, type: 'FOLD', street: Street.PREFLOP },
      { position: Position.UTG2, type: 'FOLD', street: Street.PREFLOP },
      { position: Position.LJ, type: 'FOLD', street: Street.PREFLOP },
      { position: Position.HJ, type: 'FOLD', street: Street.PREFLOP },
      { position: Position.CO, type: 'RAISE', amountBB: 2.5, street: Street.PREFLOP },
      { position: Position.BTN, type: 'FOLD', street: Street.PREFLOP },
      { position: Position.SB, type: 'FOLD', street: Street.PREFLOP },
      // ⚠️ CALL 是**增量**（BB 已投 1BB），不是本街累计
      { position: Position.BB, type: 'CALL', amountBB: 1.5, street: Street.PREFLOP },
      { position: Position.BB, type: 'CHECK', street: Street.FLOP },
      { position: Position.CO, type: 'BET', amountBB: 3.5, street: Street.FLOP },
      { position: Position.BB, type: 'RAISE', amountBB: 14, street: Street.FLOP },
    ],
    ...overrides,
  };
}

/**
 * 跑黄金局面（可局部覆盖）。
 *
 * ⚠️ 本函数必须接收 `Partial` 并**合并**到黄金夹具上 ——
 * 直接让调用方传完整 `ManualHandInput` 会让 `run({ heroCards })` 这种写法
 * 把其余字段全部丢掉（本文件第一版正是这个错，导致校验报「tableSize undefined」）。
 */
function run(overrides: Partial<ManualHandInput> = {}) {
  const result = analyzeManualHand(golden(overrides), { rules: RULES });
  assert.equal(result.ok, true, `必须可分析：${result.ok ? '' : JSON.stringify(result.issues)}`);
  if (!result.ok) throw new Error('unreachable');
  return result;
}

/** 调试区块按 label 取值 */
function rowValue(rows: readonly { label: string; value: string }[] | undefined, label: string): string | null {
  return rows?.find((r) => r.label === label)?.value ?? null;
}

const raiseCandidates = (r: ReturnType<typeof run>) =>
  r.decision.diagnostics.candidates.filter(
    (c) => c.action === DecisionAction.RAISE || c.action === DecisionAction.ALL_IN,
  );

/* ============================================================
 * 0. 黄金不变式：披露修复**不得**改变任何决策数值
 * ============================================================ */

test('D0-a 黄金局面：输入哈希与动作/金额与生产基线一致', () => {
  const input = golden();
  assert.equal(hashManualInput(input), 'hbb5baa22', '输入哈希必须与审计基线一致（黄金输入未被改动）');
  const r = run(input);
  assert.equal(r.decision.action, DecisionAction.RAISE, '动作必须仍是 RAISE');
  assert.equal(r.decision.sizeChips, 4200, '金额必须仍是 4200 筹码（42BB）');
});

test('D0-b 黄金局面：资金流与权益逐位不变', () => {
  const math = run().decision.diagnostics.math;
  assert.equal(math.pot, 2300, '底池 23BB');
  assert.equal(math.callCost, 1050, '需跟 10.5BB');
  assert.equal(math.myRemainingStack, 9400, 'Hero 剩余 94BB（开手 100 − 2.5 − 3.5）');
  assert.equal(math.effectiveStack, 8350, '有效筹码 83.5BB');
  assert.equal(math.requiredEquity !== null && Math.abs(math.requiredEquity - 0.3134) < 0.001, true, '所需权益 ≈ 31.3%');
  assert.equal(math.callEV !== null && Math.abs(math.callEV - 1644.52) < 0.05, true, 'CALL EV 必须仍是 1644.52（未变）');
});

/* ============================================================
 * D1：候选动作 EV 回填
 * ============================================================ */

test('D1-1 每个加注尺寸要么带**自己的** EV（含来源），要么显式「未评估」且绝不为 0', () => {
  /*
   * 🔴 **契约更新（阶段二）**：阶段一时本断言是「**恰好一个**尺寸带 EV」——
   * 那时引擎确实只为被选中的那一档算过 EV。阶段二起 `contextBuilder` 用
   * **同一个闭包**为网格内每一档各自算出事实包 ⇒ 本局 8 档**全部**有 EV。
   *
   * 新断言**不比旧的弱**：它要求「有 EV」的档位必须带来源，且**不得**把
   * 未评估显示成 0（旧断言的核心意图完整保留）。
   */
  const raises = raiseCandidates(run());
  assert.ok(raises.length >= 5, `正式候选尺寸应有多档，实际 ${raises.length}`);
  let evaluated = 0;
  for (const c of raises) {
    if (c.ev === null) {
      assert.notEqual(c.ev, 0, '**禁止**把未计算 EV 显示成 0');
      assert.equal(c.evEstimateType, undefined, '未评估尺寸不得带 EV 来源');
      continue;
    }
    evaluated += 1;
    assert.equal(c.evEstimateType, 'MODEL_EV', '已评估尺寸必须如实标出 EV 来源');
    assert.ok(Number.isFinite(c.ev), 'EV 必须是有限数');
  }
  assert.ok(evaluated >= 1, `至少必须有一个尺寸被评估，实际 ${evaluated}`);
});

test('D1-2 被选中尺寸的 EV 必须与证据层**同一个数**；各尺寸 EV 必须互不相同（无串档/复制）', () => {
  const r = run();
  const raises = raiseCandidates(r).filter((c) => c.ev !== null);
  // ① 被选中的那一档必须与证据层的量化 RAISE 条目**同一口径**
  const chosen = raises.find((c) => c.sizeChips === r.decision.sizeChips);
  assert.ok(chosen, '被选中的尺寸必须在候选表里且有 EV');
  const evidence = r.decision.diagnostics.actionEvidence?.find(
    (e) => e.action === 'RAISE' && e.ev !== null,
  );
  assert.ok(evidence, '证据表必须有量化的 RAISE 条目');
  assert.equal(chosen!.ev, evidence!.ev, '候选层与证据层对被选中尺寸必须是**同一个数**');
  // ② 各尺寸的 EV 必须**互不相同** —— 若被复制到别的档，会出现重复值
  const values = raises.map((c) => c.ev!);
  assert.equal(
    new Set(values.map((v) => v.toFixed(6))).size,
    values.length,
    `每个尺寸必须有自己的 EV（不得把同一档的数字复制到别的金额）：${JSON.stringify(values)}`,
  );
  // ③ 每个已评估尺寸都必须带**它自己的**响应分支
  for (const c of raises) {
    assert.ok(c.evBranches, `尺寸 ${c.sizeChips} 必须带自己的响应分支概率`);
    const { fold, call, reRaise } = c.evBranches!;
    assert.ok(
      Math.abs(fold + call + reRaise - 1) < 1e-9,
      `尺寸 ${c.sizeChips} 的三分支概率必须和为 1（实际 ${fold + call + reRaise}）`,
    );
  }
});

test('D1-2b 每个尺寸必须标出「已完整计算 / 近似计算」状态', () => {
  const raises = raiseCandidates(run()).filter((c) => c.ev !== null);
  assert.ok(raises.length >= 1);
  for (const c of raises) {
    assert.equal(
      typeof c.evApproximatedReraise,
      'boolean',
      `尺寸 ${c.sizeChips} 必须显式标注其再加注分支是否为摊牌终止近似`,
    );
    /*
     * 🔴 **结构不变量（阶段二）**：近似标记只允许出现在**真的存在再加注分支**
     * 的尺寸上。`reRaise === 0` ⇒ 该分支对 EV 的贡献恒为 0 ⇒ 这一维是**精确**的，
     * 标成「近似」会**无端削弱**该档（最典型的误标对象就是**全下**：
     * Hero 全下时对手结构上不可能再加注）。
     */
    if (c.evBranches!.reRaise === 0) {
      assert.equal(
        c.evApproximatedReraise,
        false,
        `尺寸 ${c.sizeChips} 的再加注概率为 0（该分支不参与 EV）⇒ 不得标成「近似计算」`,
      );
    }
  }
});

test('P2-1 阶段二：网格内每个合法尺寸都必须有**自己的**分支概率与条件权益', () => {
  const raises = raiseCandidates(run());
  assert.ok(raises.length >= 5, `正式候选尺寸应有多档，实际 ${raises.length}`);
  const evaluated = raises.filter((c) => c.ev !== null);
  assert.equal(
    evaluated.length,
    raises.length,
    `阶段二要求**所有**正式候选尺寸都被独立评估，实际 ${evaluated.length}/${raises.length}`,
  );
  for (const c of evaluated) {
    const b = c.evBranches!;
    assert.ok(b, `尺寸 ${c.sizeChips} 必须有分支概率`);
    assert.ok(
      b.equity === null || (b.equity > 0 && b.equity < 1),
      `尺寸 ${c.sizeChips} 的条件权益必须落在 (0,1)，实际 ${String(b.equity)}`,
    );
    assert.ok(
      Math.abs(b.fold + b.call + b.reRaise - 1) < 1e-9,
      `尺寸 ${c.sizeChips} 三分支概率必须和为 1`,
    );
  }
  // 不同尺寸的分支概率**不应全部相同**（否则说明没有按尺寸条件化）
  const signatures = new Set(
    evaluated.map((c) => `${c.evBranches!.fold}/${c.evBranches!.call}/${c.evBranches!.reRaise}`),
  );
  assert.ok(signatures.size >= 2, `各尺寸的响应概率必须按尺寸条件化（不得全部相同）：${[...signatures].join(' | ')}`);
});

test('P2-2 阶段二：尺寸间差值在工程容差带内时不得声称某尺寸更优', () => {
  const r = run();
  const margin = r.decision.diagnostics.decisionMargin!;
  const band = 0.05 * r.decision.diagnostics.math.winnable;
  const values = raiseCandidates(r)
    .filter((c) => c.ev !== null)
    .map((c) => c.ev!);
  const spread = Math.max(...values) - Math.min(...values);
  assert.ok(Number.isFinite(spread) && spread >= 0);
  // 无论 spread 是否超带，披露都必须**给出**容差带并声明「不得据此声称全局最高」
  assert.match(margin.noteZh, /不得据此声称任何尺寸是「全局最高 EV」/);
  assert.match(margin.noteZh, /工程容差带/);
  // 若极差落在带内 ⇒ 不得出现任何「某尺寸更好 / 最优尺寸」的断言
  if (spread <= band) {
    assert.doesNotMatch(margin.noteZh, /最优尺寸|更好的尺寸|应该用.*BB/, '带内差值不得被表述为尺寸优劣');
  }
});

test('D1-3 视图层：被评估尺寸显示数字与来源，未评估尺寸不得自称「无可信估计」', () => {
  // ⚠️ 候选**展示行**在 `viewModel.debug.candidates`（`viewModel` 顶层没有 candidates 字段）
  const debug = run().viewModel.debug as unknown as {
    candidates?: { actionZh: string; sizeZh: string; evZh: string; feasibleZh: string }[];
  };
  const rows = debug.candidates;
  assert.ok(rows !== undefined && rows.length > 0, '调试区必须有候选表');
  const evaluated = rows!.find((c) => c.sizeZh === '42.0BB');
  assert.ok(evaluated, '候选表必须含 42.0BB 行');
  assert.match(evaluated!.evZh, /MODEL_EV/, '被评估尺寸必须披露 EV 来源');
  assert.doesNotMatch(evaluated!.evZh, /无可信估计/, '被评估尺寸**不得**再自称无可信估计（D1 原缺陷）');
  for (const c of rows!) {
    if (c.evZh.includes('未评估')) {
      assert.match(c.evZh, /未评估 ≠ 低 EV/, '「未评估」必须显式声明不等于低 EV');
      assert.doesNotMatch(c.evZh, /0\.00/, '未评估不得显示成 0');
    }
  }
});

/* ============================================================
 * D2：决策比较范围披露
 * ============================================================ */

test('D2-1 边际标签不得再断言「未比较加注」', () => {
  assert.doesNotMatch(
    DECISION_MARGIN_ZH.CLEAR_CALL_OVER_FOLD,
    /未比较加注/,
    'D2 原缺陷：静态标签断言「未比较加注」，而决策层可能确实比较过',
  );
});

test('D2-2 覆盖面必须如实报出**实际**评估的尺寸数（阶段二：8/8），且措辞与候选表一致', () => {
  /*
   * 🔴 **契约更新（阶段二）**：阶段一时本断言是「必须如实报『只计算了 1 个』」。
   * 阶段二起网格内每一档都有 EV ⇒ 覆盖面状态由 `SINGLE` 变为 `ALL`。
   *
   * 新断言**更强**：不再写死某个数字，而是要求披露里的数字**与候选表实际一致**
   *（把「文案与实际脱节」这类缺陷从根上堵住 —— 旧断言只锁一个固定字符串）。
   */
  const r = run();
  const margin = r.decision.diagnostics.decisionMargin;
  assert.ok(margin, '本节点必须有决策边际');
  assert.match(margin!.noteZh, /加注 EV 覆盖面/, '边际说明必须报出加注 EV 的覆盖面');
  const actualEvaluated = r.decision.diagnostics.candidates.filter(
    (c) => (c.action === 'RAISE' || c.action === 'ALL_IN') && c.ev !== null,
  ).length;
  assert.ok(actualEvaluated >= 2, `本局应有多个尺寸被评估，实际 ${actualEvaluated}`);
  assert.match(
    margin!.noteZh,
    new RegExp(`全部 ${actualEvaluated} 个正式候选尺寸都已计算`),
    `覆盖面必须与候选表实际一致（实际 ${actualEvaluated} 个已评估）`,
  );
  // 逐尺寸回填说明里的尺寸清单数量也必须与实际一致
  const listed = margin!.noteZh.match(/逐尺寸回填（阶段二）：(\d+) 个尺寸/);
  assert.ok(listed, '必须给逐尺寸回填说明');
  assert.equal(Number(listed![1]), actualEvaluated, '回填说明里的尺寸数必须与实际一致');
});

test('D2-2b 不得声称任何加注尺寸是「全局最高 EV」', () => {
  const margin = run().decision.diagnostics.decisionMargin!;
  assert.match(margin.noteZh, /不得据此声称任何尺寸是「全局最高 EV」/, '必须显式禁止全局最优声明');
  assert.match(margin.noteZh, /未实现 4-bet 分支/, '必须给出具体理由（4-bet 未实现）');
  assert.match(margin.noteZh, /摊牌终止近似/, '必须给出具体理由（摊牌终止近似）');
  assert.match(margin.noteZh, /未经统计校准的结构性先验/, '必须给出具体理由（响应先验未校准）');
  assert.match(margin.noteZh, /工程容差带/, '必须说明差值小于工程容差带时不足以支撑「更好」');
});

test('D2-3 Math Dominance 的结论句不得声称「加注不在此比较之内」', () => {
  const md = run().decision.diagnostics.mathDominance;
  assert.doesNotMatch(md.noteZh, /不在此比较之内/, '加注确有 EV 时不得再声称它不在比较之内（D2 原缺陷）');
  /*
   * 阶段二起，网格内**每一档**都有 EV ⇒ 最大 EV 差不再来自「加注 vs 跟注」，
   * 而是来自**两个加注尺寸之间**（实测 31.5BB 1968.58 vs 26.25BB 1962.60 = 5.98）。
   * 正确结论仍是「没有明显占优动作」（5.98 远小于阈值 15% × 底池）。
   */
  assert.equal(md.dominant, false, '尺寸之间差值远小于阈值 ⇒ 不得判出「明显占优」');
  assert.match(md.noteZh, /没有明显占优动作/);
});

test('D2-4 未评估的尺寸不得被读成低 EV', () => {
  const md = run().decision.diagnostics.mathDominance;
  assert.match(md.noteZh, /未参与比较 ≠ EV 更低|未评估的尺寸不做低 EV 假设/,
    '必须显式切断「未参与比较」与「EV 更低」的误读');
});

test('P2-3 阶段二「局部尺寸搜索」判定：必须给出可证伪的测量，且离网尺寸绝不进候选', () => {
  const r = run();
  const margin = r.decision.diagnostics.decisionMargin!;
  // ① 必须披露这次探测（评估了几个离网尺寸、离网最优 vs 网格最优、上风与容差带的比较）
  assert.match(margin.noteZh, /局部尺寸搜索探测/, '必须披露局部尺寸搜索的判定');
  assert.match(margin.noteZh, /仅诊断，不参与决策/, '必须显式声明该探测不参与决策');
  assert.match(margin.noteZh, /工程容差带/, '必须给出与工程容差带的比较');
  assert.match(
    margin.noteZh,
    /未超出容差带|超出容差带/,
    '必须给出明确结论（需要 / 不需要局部搜索），不得含糊',
  );
  // ② 候选层的金额必须都是**整数筹码**（离网探测用的是 desiredTo 的百分比，可能非整）
  const raiseSizes = r.decision.diagnostics.candidates
    .filter((c) => c.action === 'RAISE' || c.action === 'ALL_IN')
    .map((c) => c.sizeChips!);
  assert.ok(raiseSizes.length >= 5, `正式候选应有多档，实际 ${raiseSizes.length}`);
  for (const s of raiseSizes) {
    assert.ok(Number.isInteger(s), `候选金额必须是整数筹码，实际 ${s}`);
  }
  // ③ 探测不改变动作与金额
  assert.equal(r.decision.action, DecisionAction.RAISE);
  assert.equal(r.decision.sizeChips, 4200);
});

/* ============================================================
 * D3：画像标签语义
 * ============================================================ */

test('D3-1 分类器结果与实际采用来源必须分行显示、不得混为一谈', () => {
  const r = run({
    seatProfiles: { [Position.BB]: 'AGGRESSIVE' },
    villain: { quickProfile: 'AGGRESSIVE' },
  });
  const debug = r.viewModel.debug as unknown as { player?: { label: string; value: string }[] };
  const classifierRow = rowValue(debug.player, '推断标签（分类器）');
  assert.ok(classifierRow !== null, '必须有「推断标签（分类器）」行');
  assert.match(classifierRow!, /未判出（UNKNOWN）/, '分类器没判出时必须如实说 UNKNOWN');
  // 同一行内说明「实际采用」的来源 —— 而不是把 UNKNOWN 改写成 AGGRESSIVE
  assert.match(classifierRow!, /实际采用/, '推断失败但画像生效时，必须就地说明实际来源');
  // 「说明」行仍然独立存在（它才是「模型用了什么」）
  assert.ok(rowValue(debug.player, '说明') !== null, '「说明」行必须保留');
});

test('D3-2 不得篡改分类结果使两个字段看起来一致', () => {
  const withProfile = run({
    seatProfiles: { [Position.BB]: 'AGGRESSIVE' },
    villain: { quickProfile: 'AGGRESSIVE' },
  });
  const debug = withProfile.viewModel.debug as unknown as { player?: { label: string; value: string }[] };
  const classifierRow = rowValue(debug.player, '推断标签（分类器）')!;
  // 分类器行**必须**以 UNKNOWN 开头 —— 若被改写成 AGGRESSIVE 就是篡改
  assert.match(classifierRow, /^未判出（UNKNOWN）/, '分类器结果不得被画像取值覆盖');
});

/* ============================================================
 * D4：统计项三态披露
 * ============================================================ */

test('D4-1 vpip / pfr 必须报 USED（旧实现谎称「无模型支持的统计项」）', () => {
  const r = run({
    seatProfiles: { [Position.BB]: 'AGGRESSIVE' },
    villain: {
      quickProfile: 'AGGRESSIVE',
      observedStats: { handsObserved: 150, vpip: 0.42, pfr: 0.28 },
    },
  });
  const debug = r.viewModel.debug as unknown as { player?: { label: string; value: string }[] };
  const used = rowValue(debug.player, '本次进入模型')!;
  assert.match(used, /vpip/, 'vpip 必须出现在「本次进入模型」');
  assert.match(used, /pfr/, 'pfr 必须出现在「本次进入模型」');
  assert.doesNotMatch(used, /尚无模型支持的统计项/, 'D4 原缺陷：这句断言不实，不得再出现');
  const vpipRow = rowValue(debug.player, '统计项 vpip')!;
  assert.match(vpipRow, /^USED/, 'vpip 状态必须是 USED');
  // 注意：文案用的是**全角括号**（`维度（tightness）`），不是 ASCII 括号
  assert.match(vpipRow, /维度（tightness）/, 'vpip 的生效通道是维度 tightness');
  const pfrRow = rowValue(debug.player, '统计项 pfr')!;
  assert.match(pfrRow, /^USED/, 'pfr 状态必须是 USED');
  assert.match(pfrRow, /维度（aggression）/, 'pfr 的生效通道是维度 aggression');
});

test('D4-2 flopCheckRaise 在本节点经**分街条目**通道生效 ⇒ USED（附机会数/可信度）', () => {
  /*
   * 🔴 **本轮对审计结论的一处更正**（必须留档，见修复报告 §更正）：
   *
   * 前置审计 `KQ_FLOP_RAISE_42BB_CHECK.md` §I.6 写「`flopCheckRaise` 没有输入通道 /
   * 本节点不适用」，并据此把 D4 描述成「缺通道」。**该诊断两处都错**：
   *
   * 1. **通道存在且在本节点生效**：`actionContext.ts:182` 明确写着
   *    「过牌-加注类不走这条通道」⇒ `traitStreet === null ⇒ return true`，
   *    即 check-raise 类条目**永不被语义门挡下**。实测状态为 `USED`
   *    （生效通道 = 分街条目 `flopCheckRaise`）。
   * 2. **审计里「4% 与 25% 数值逐位相同」的成因是收缩，不是无通道**：
   *    机会数 = `round(150 × 0.15) = 23`，而 `priorWeight = 200`
   *    ⇒ 后验可信度仅 `23/223 ≈ 0.103`，实测值被先验压得几乎不可见。
   *
   * 本测试锁**真实行为**（USED + 收缩证据），而不是审计里那句错话。
   */
  const r = run({
    seatProfiles: { [Position.BB]: 'AGGRESSIVE' },
    villain: {
      quickProfile: 'AGGRESSIVE',
      observedStats: { handsObserved: 150, flopCheckRaise: 0.08 },
    },
  });
  const debug = r.viewModel.debug as unknown as { player?: { label: string; value: string }[] };
  const row = rowValue(debug.player, '统计项 flopCheckRaise');
  assert.ok(row !== null, 'flopCheckRaise 必须被逐项披露');
  assert.match(row!, /^USED/, `flopCheckRaise 在本节点经分街条目通道生效，实际：${row}`);
  assert.match(row!, /分街条目 `flopCheckRaise`/, '必须报出生效通道是分街条目');
  assert.match(row!, /机会数 23/, '必须报出有效机会数（150 手 × 0.15 近似）');
  assert.match(row!, /已被先验收缩/, '必须披露该证据被先验收缩（这正是「看不见效果」的原因）');
});

test('D4-2b 通道存在但**本节点街不匹配** ⇒ NOT_APPLICABLE（foldToTurnCBet 在翻牌节点）', () => {
  /*
   * 真正的 NOT_APPLICABLE 判据来自 `actionContext.ts:187`：
   * 该统计所属的街 ≠ 当前街 ⇒ 不适用。
   *
   * `foldToTurnCBet` 映射到分街条目 `foldToTurnBet`（属**转牌**），
   * 而本节点是**翻牌** ⇒ 被挡下；且它的维度极性**全为 0**
   *（`observedStats.ts:885`，设计上「每条统计恰好影响一个通道」）
   * ⇒ 没有任何通道生效 ⇒ 正确状态是 `NOT_APPLICABLE`。
   */
  const r = run({
    seatProfiles: { [Position.BB]: 'AGGRESSIVE' },
    villain: {
      quickProfile: 'AGGRESSIVE',
      observedStats: { handsObserved: 150, foldToTurnCBet: 0.55 },
    },
  });
  const debug = r.viewModel.debug as unknown as { player?: { label: string; value: string }[] };
  const row = rowValue(debug.player, '统计项 foldToTurnCBet');
  assert.ok(row !== null, 'foldToTurnCBet 必须被逐项披露');
  assert.match(row!, /^NOT_APPLICABLE/, `转牌统计在翻牌节点必须为 NOT_APPLICABLE，实际：${row}`);
  assert.match(row!, /语义门不适用/, '必须说明原因是节点语义门');
  assert.doesNotMatch(row!, /^USED/, '被语义门挡下的条目绝不得报 USED');
});

test('D4-3 统计项实际进入模型但最终动作不变（两者不是一回事）', () => {
  const base = run();
  const withStats = run({
    seatProfiles: { [Position.BB]: 'AGGRESSIVE' },
    villain: {
      quickProfile: 'AGGRESSIVE',
      observedStats: { handsObserved: 150, vpip: 0.42, pfr: 0.28 },
    },
  });
  // 动作不变
  assert.equal(withStats.decision.action, base.decision.action);
  assert.equal(withStats.decision.sizeChips, base.decision.sizeChips);
  // 但「统计已进入模型」必须为真 —— 不能用「动作没变」反推「统计没用上」
  const debug = withStats.viewModel.debug as unknown as { player?: { label: string; value: string }[] };
  const row = rowValue(debug.player, '统计项 vpip')!;
  assert.match(row, /^USED/, '动作未变 ≠ 统计项未进入模型');
});

test('D4-4 没有有效玩家数据 ⇒ NO_DATA，且不得默认 USED', () => {
  const r = run({
    villain: {
      quickProfile: 'AGGRESSIVE',
      observedStats: { handsObserved: 150, vpip: null, pfr: null },
    },
  });
  const debug = r.viewModel.debug as unknown as { player?: { label: string; value: string }[] };
  for (const stat of ['vpip', 'pfr']) {
    const row = rowValue(debug.player, `统计项 ${stat}`);
    assert.ok(row !== null, `${stat} 必须被披露`);
    assert.match(row!, /^NO_DATA/, `${stat} 没有数值时必须报 NO_DATA，实际：${row}`);
    assert.doesNotMatch(row!, /^USED/, '无数据不得默认 USED');
  }
});

test('D4-5 未绑定玩家 / 未提供统计 ⇒ 不做三态推断（保持原有中性披露）', () => {
  const r = run();
  const debug = r.viewModel.debug as unknown as { player?: { label: string; value: string }[] };
  assert.equal(rowValue(debug.player, '统计项 vpip'), null, '没有提供统计时不得凭空生成状态行');
  assert.equal(rowValue(debug.player, '本次进入模型'), null, '没有 measuredStats 时不生成该行');
});

/* ============================================================
 * D5：决策边际说明
 * ============================================================ */

test('D5-1 最终动作是 RAISE 时，边际说明必须引用**被选中的 RAISE EV**', () => {
  const r = run();
  assert.equal(r.decision.action, DecisionAction.RAISE);
  const margin = r.decision.diagnostics.decisionMargin!;
  assert.match(margin.noteZh, /本行不是本次动作的判据/, '必须声明该标签不描述本次动作');
  assert.match(margin.noteZh, /最终动作是 加注/, '必须报出最终动作');
  /* 🔴 P0（上一轮）钉值更新：1948.14 → 1944.75（分桶权益改为按声明的 6000 次抽样） */
  /*
   * 🔴 **再钉值更新：1944.75 → 1987.90**（环境基线接入，本轮）。
   *
   * 原因：`neutralResponseTendenciesFor(environment)` 让知识库的
   * `env.low.calling-tendency-up`（低级别线上 ⇒ 对手更爱跟）在**无画像对手**上
   * 真正生效 —— 修复前它对这条路径完全无效（实测：三个环境的响应概率逐位相同，
   * 见 `reports/REAL_HAND_VALIDATION.md` §6.11）。
   *
   * ⇒ 对手弃牌率下降 ⇒ 本节点的 RAISE EV **上升**是模型的正确后果。
   * **契约本身未变**（仍必须引用被选中的 RAISE EV、仍必须声明标签不描述本次动作）。
   */
  assert.match(margin.noteZh, /MODEL_EV EV = 1987\.90/, '必须引用被选中的 RAISE EV 实际数值');
});

test('D5-2 混合 EV 来源（PROXY_EV / MODEL_EV）必须披露可比性限制', () => {
  const margin = run().decision.diagnostics.decisionMargin!;
  assert.match(margin.noteZh, /EV 来源不同/, '混合来源必须显式披露');
  assert.match(margin.noteZh, /MODEL_EV/, '必须列出 MODEL_EV');
  assert.match(margin.noteZh, /PROXY_EV/, '必须列出 PROXY_EV');
  assert.match(margin.noteZh, /不声称它们严格同质/, '必须声明不声称严格同质');
});

test('D5-3 最终动作是 CALL 的节点不得被硬套上「不是判据」的声明', () => {
  // 一个 Hero 无人下注、可过牌/下注的节点（非面对下注）—— 该节点不是 CALL 决策
  const r = run({
    heroCards: ['As', 'Ah'],
    board: ['Kh', '7c', '2d'],
    actionHistory: [
      { position: Position.UTG, type: 'FOLD', street: Street.PREFLOP },
      { position: Position.UTG1, type: 'FOLD', street: Street.PREFLOP },
      { position: Position.UTG2, type: 'FOLD', street: Street.PREFLOP },
      { position: Position.LJ, type: 'FOLD', street: Street.PREFLOP },
      { position: Position.HJ, type: 'FOLD', street: Street.PREFLOP },
      { position: Position.CO, type: 'RAISE', amountBB: 2.5, street: Street.PREFLOP },
      { position: Position.BTN, type: 'FOLD', street: Street.PREFLOP },
      { position: Position.SB, type: 'FOLD', street: Street.PREFLOP },
      { position: Position.BB, type: 'CALL', amountBB: 1.5, street: Street.PREFLOP },
      { position: Position.BB, type: 'CHECK', street: Street.FLOP },
    ],
    potBB: 5.5,
  });
  const margin = r.decision.diagnostics.decisionMargin;
  // 无人下注 ⇒ 边际为 null/undefined 且如实说明；若存在，也不得误报 RAISE 判据
  if (margin !== null && margin !== undefined) {
    assert.doesNotMatch(margin.noteZh, /最终动作是 加注/, '不是 RAISE 决策时不得套用 RAISE 判据声明');
  }
  assert.ok(r.decision.action !== null, '该节点仍必须给出动作');
});

/* ============================================================
 * D6（阶段二补完）：两处披露必须**同源**，且「已算出」与「已入选比较」必须切开
 * ============================================================
 *
 * ## 实测缺陷（`RAISE_EV_DISCLOSURE_SINGLE_SOURCE`）
 *
 * 阶段二让 `postflopFacts.raiseResponseAll` 为网格内**每一档**都算出自有 EV，
 * D1 回填又把它们写进候选表。但 `unevaluatedActions` 遍历的是**回填之前**的候选表
 * （那里每个加注候选的 `ev` 恒为 `null`），只能靠 `raiseShape.raiseSizesWithOwnEV`
 * 反推「已评估」——而那一支在**翻后只登记被启发式选中的一档**
 * （翻前早已修正为「所有有自有 EV 的尺寸」，翻后漏改）。
 *
 * 结果同一份响应里两处**互相否认**：
 *
 * ```text
 * diagnostics.candidates        → RAISE 16.0BB  ev = 844.28  「已完整计算」
 * diagnostics.unevaluatedActions → RAISE 16.0BB  ev = null
 *                                  「RAISE_EV_NOT_IMPLEMENTED：该金额缺响应概率」
 * ```
 *
 * 同时 `decisionMargin` 的覆盖面还宣称「全部 8 个正式候选尺寸都已计算 EV」——
 * 三处说法互斥。实测 T9s / AK / 88 三手牌全部命中（8 档里 7~8 档重叠）。
 */

test('D6-1 同一加注金额不得既「已完整计算」又出现在 `unevaluatedActions` 里', () => {
  const spots: readonly [string, Partial<ManualHandInput>][] = [
    ['黄金局面', {}],
    ['空气（T9s，建议 FOLD）', { heroCards: ['Th', '9h'], board: ['Kh', '8c', '3d'] }],
    ['顶对（AK）', { heroCards: ['As', 'Kc'], board: ['Kh', '8c', '3d'] }],
    ['暗三条（88）', { heroCards: ['8h', '8d'], board: ['Kh', '8c', '3d'] }],
    ['Hero 被过牌到（BTN）', {
      heroPosition: Position.BTN,
      heroCards: ['As', 'Kc'],
      board: ['Kh', '8c', '3d'],
      actionHistory: [
        { position: Position.UTG, type: 'FOLD', street: Street.PREFLOP },
        { position: Position.UTG1, type: 'FOLD', street: Street.PREFLOP },
        { position: Position.UTG2, type: 'FOLD', street: Street.PREFLOP },
        { position: Position.LJ, type: 'FOLD', street: Street.PREFLOP },
        { position: Position.HJ, type: 'FOLD', street: Street.PREFLOP },
        { position: Position.CO, type: 'RAISE', amountBB: 2.5, street: Street.PREFLOP },
        { position: Position.BTN, type: 'CALL', amountBB: 2.5, street: Street.PREFLOP },
        { position: Position.SB, type: 'FOLD', street: Street.PREFLOP },
        { position: Position.BB, type: 'FOLD', street: Street.PREFLOP },
        { position: Position.CO, type: 'CHECK', street: Street.FLOP },
      ],
      potBB: 6.5,
    }],
  ];
  for (const [tag, override] of spots) {
    const r = run(override);
    const d = r.decision.diagnostics;
    const evaluated = new Set(
      d.candidates
        .filter(
          (c) =>
            (c.action === DecisionAction.RAISE || c.action === DecisionAction.ALL_IN) &&
            c.ev !== null &&
            c.sizeChips !== undefined,
        )
        .map((c) => c.sizeChips as number),
    );
    const listedUnevaluated = (d.unevaluatedActions ?? [])
      .filter((u) => u.action === 'RAISE' || u.action === 'ALL_IN')
      .map((u) => u.sizeChips)
      .filter((s): s is number => s !== null);
    const overlap = listedUnevaluated.filter((s) => evaluated.has(s));
    assert.deepEqual(
      overlap,
      [],
      `${tag}：同一金额既在候选表里「已完整计算」、又被列进 unevaluatedActions ` +
        `（两处披露不同源）：${JSON.stringify(overlap)}`,
    );
    /*
     * 反向也要锁：候选表里 `ev === null` 的加注尺寸**必须**被登记为未评估 ——
     * 否则就是「算了不报」的反向缺陷（把没算的当算过）。
     */
    const missingFromList = [...evaluated].length === 0 && listedUnevaluated.length === 0
      ? []
      : d.candidates
        .filter(
          (c) =>
            (c.action === DecisionAction.RAISE || c.action === DecisionAction.ALL_IN) &&
            c.ev === null &&
            c.sizeChips !== undefined,
        )
        .map((c) => c.sizeChips as number)
        .filter((s) => !listedUnevaluated.includes(s));
    assert.deepEqual(
      missingFromList,
      [],
      `${tag}：候选表标为「未评估」的加注金额必须出现在 unevaluatedActions 里：` +
        `${JSON.stringify(missingFromList)}`,
    );
  }
});

test('D6-2 「已算出」与「已入选比较」必须在覆盖面文案里切开', () => {
  const r = run({ heroCards: ['As', 'Kc'], board: ['Kh', '8c', '3d'] });
  const note = r.decision.diagnostics.decisionMargin?.noteZh ?? '';
  assert.match(note, /加注 EV 覆盖面/, '必须报出加注 EV 覆盖面');
  const evaluated = r.decision.diagnostics.candidates.filter(
    (c) =>
      (c.action === DecisionAction.RAISE || c.action === DecisionAction.ALL_IN) && c.ev !== null,
  ).length;
  assert.ok(evaluated > 0, `前置：本节点应有多档已评估的加注尺寸（实际 ${evaluated}）`);
  /*
   * 只要「已评估档数 > 进入比较的档数」，文案就必须点明这一点 ——
   * 否则用户会把候选表里更高的 EV 读成「引擎认为该尺寸更好」，
   * 而实际建议可能是**另一个**动作（实测：AK 建议 CALL 而 12.0BB 加注 EV 更高）。
   */
  assert.match(
    note,
    /进入本次动作比较/,
    `多档已算出但只有少数入选比较时，必须显式披露（不得让「已算出」被读成「已择优」）：${note}`,
  );
  assert.match(note, /已算出 ≠ 已入选/, '必须切断「已算出 ⇒ 已入选/更好」的误读');
});

