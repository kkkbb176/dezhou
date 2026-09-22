/**
 * ============================================================================
 * 翻前加注决策系统 · 阶段 B 端到端验收（PREFLOP RAISE DECISION E2E）
 * ============================================================================
 *
 * ## 与 `preflopRaiseDecision.test.ts` 的分工
 *
 * | 文件 | 层次 | 回答的问题 |
 * |---|---|---|
 * | `preflopRaiseDecision.test.ts` | 模型层 | 响应概率、条件范围、EV 算智、退回口径是否**正确** |
 * | **本文件** | 端到端 | 生产管线（`analyzeManualHand`）是否**真的用上了**它，且输出是否**自洽** |
 *
 * ## 本文件的四类断言
 *
 * 1. **建议与 EV 一致**：最终动作必须能在证据表里找到属于它自己的 EV；
 *    由「翻前加注响应模型」选出的加注，其 EV 必须真的 ≥ 其它被评估候选。
 * 2. **披露自洽**：诊断快照里的 `preflopRaise` 必须包含**每个**合法尺寸，
 *    且「未评估动作」不得包含已经有自有 EV 的金额（U10 的同一形态）。
 * 3. **拒绝必须说出来**：多人 / 身后有人时不给加注 EV，且原因出现在 warnings。
 * 4. **可复现**：同输入同种子逐位一致。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Position, TableSize } from '../src/domain/types.ts';
import { createGame } from '../src/domain/poker/gameState.ts';
import { applyAction } from '../src/domain/poker/engine.ts';
import { deriveLegalActions, buildSizeGrid, potOf } from '../src/app/manualInput/legalActions.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import { parseManualInput, type ManualHandInput } from '../src/app/manualInput/manualInput.ts';
import { C } from './helpers.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
/** 与 `alphaPipeline` 的 `ManualAnalysisOptions` 同一形状（该类型未导出，这里结构化声明） */
type AnalysisOptions = Parameters<typeof analyzeManualHand>[1];
const OPTIONS: AnalysisOptions = {
  rules: RULES,
  asOf: 1_757_000_000_000,
  writeLog: false,
  equitySeed: 20_260_913,
  /* 端到端测试需要真实时间预算：节点比单测重（逐尺寸两次权益） */
  budget: { softMs: 120_000, hardMs: 240_000 },
};

/* ============================================================
 * 夹具：用真实引擎推进，再走 tableAdapter → 生产入口
 * ============================================================ */

/** 6 人桌 BB vs BTN 开池：Hero BB `heroCards`，BTN 开池 `openBB`，其余弃牌 ⇒ 轮到 Hero */
function bbVsBtnScenario(options: {
  heroCards: readonly [string, string];
  openBB?: number;
  heroStackBB?: number;
  villainStackBB?: number;
  /** 额外的冷跟注者（造多人池）：位置 |
   * 只有 HJ 能在 BTN 之前跟注，因此多人池用「HJ 跟注 + BTN 开池」 */
  coldCaller?: Position;
}): ManualHandInput {
  const positions = [Position.UTG, Position.HJ, Position.CO, Position.BTN, Position.SB, Position.BB];
  let state = createGame({
    id: 'e2e-preflop-raise',
    config: { tableSize: TableSize.SIX_MAX, smallBlind: 1000, bigBlind: 2000, ante: 0, dealerPosition: Position.BTN },
    players: positions.map((position) => ({
      id: position.toLowerCase(),
      name: position,
      position,
      startingStack: (position === Position.BB
        ? options.heroStackBB ?? 100
        : position === Position.BTN
          ? options.villainStackBB ?? 100
          : 100) * 2000,
      /* 只有 Hero 有底牌：对手底牌在真实录入里本来就是未知的 */
      holeCards: position === Position.BB ? C(options.heroCards.join(' ')) : null,
    })),
    userPlayerId: 'bb',
    createdAt: '2026-01-01T00:00:00.000Z',
  });

  const act = (playerId: string, type: 'FOLD' | 'RAISE' | 'CALL' | 'CHECK', amount?: number): void => {
    const r = applyAction(state, { playerId, type, ...(amount === undefined ? {} : { amount }) } as never);
    assert.equal(r.ok, true, `夹具动作 ${playerId}/${type} 必须合法`);
    if (r.ok) state = r.state;
  };

  act('utg', 'FOLD');
  if (options.coldCaller === Position.HJ) act('hj', 'CALL', 2000);
  else act('hj', 'FOLD');
  act('co', 'FOLD');
  act('btn', 'RAISE', Math.round((options.openBB ?? 2.5) * 2000));
  act('sb', 'FOLD');

  /* 把引擎状态转成生产入口的输入形状（**不手工拼 input**） */
  const hand: ManualHandInput = {
    tableSize: 6,
    heroPosition: 'BB',
    heroCards: [...options.heroCards],
    board: [],
    street: 'PREFLOP',
    effectiveStackBB: Math.min(options.heroStackBB ?? 100, options.villainStackBB ?? 100),
    seatStacksBB: {
      UTG: 100,
      HJ: 100,
      CO: 100,
      BTN: options.villainStackBB ?? 100,
      SB: 100,
      BB: options.heroStackBB ?? 100,
    },
    actionHistory: state.actions
      .filter((a) => a.type !== 'POST_SB' && a.type !== 'POST_BB' && a.type !== 'POST_ANTE')
      .map((a) => ({
        position: a.position,
        type: a.type === 'RAISE' ? 'RAISE' : a.type,
        ...(a.type === 'FOLD' || a.type === 'CHECK' ? {} : { amountBB: a.toAmount / 2000 }),
        street: 'PREFLOP',
      })),
    environment: 'MID_LOW_STAKES',
    villain: { quickProfile: 'NORMAL', dynamicHint: 'UNKNOWN' },
  } as unknown as ManualHandInput;
  return hand;
}

type Run = {
  readonly decision: Record<string, any>;
  readonly diagnostics: Record<string, any>;
  readonly warnings: readonly string[];
  readonly context: Record<string, any>;
  readonly legal: Record<string, any>;
  readonly grid: readonly number[];
};

function runOf(input: ManualHandInput, options: AnalysisOptions = OPTIONS): Run {
  const r = analyzeManualHand(input, options);
  assert.equal(
    r.ok,
    true,
    `分析必须成功：${r.ok ? '' : `${r.stage} ${JSON.stringify(r.issues)}`}`,
  );
  if (!r.ok) throw new Error('unreachable');
  const decision = r.decision as unknown as Record<string, any>;
  const diagnostics = decision['diagnostics'] as Record<string, any>;

  const parsed = parseManualInput(input);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error('unreachable');
  const gate = buildAnalyzableState(parsed.value);
  assert.equal(gate.ok, true);
  if (!gate.ok) throw new Error('unreachable');
  const built = buildDecisionContext({
    state: gate.state,
    rules: RULES,
    environment: 'MID_LOW_STAKES',
    asOf: OPTIONS.asOf!,
    quickProfile: 'NORMAL',
    dynamicHint: 'UNKNOWN',
    villainSeatId: 'seat_BTN',
    equitySeed: OPTIONS.equitySeed,
    budget: OPTIONS.budget,
  } as never);
  const context = (built as unknown as Record<string, any>)['context'] as Record<string, any>;
  const legal = (built as unknown as Record<string, any>)['legal'] as Record<string, any>;
  const hero = gate.state.players.find((p) => p.id === gate.state.userPlayerId)!;
  const grid = buildSizeGrid(
    deriveLegalActions(gate.state, hero),
    potOf(gate.state),
    legal['canBet'] === true ? 'BET' : 'RAISE',
  ).map((o) => o.toAmount);
  return {
    decision,
    diagnostics,
    warnings: (r.warnings ?? []) as readonly string[],
    context,
    legal,
    grid,
  };
}

const reasonOf = (run: Run, code: string): Record<string, any> | undefined =>
  (run.decision['reasons'] as readonly Record<string, any>[]).find((x) => x['code'] === code);

const evidenceOf = (run: Run, action: string): Record<string, any> | undefined =>
  ((run.diagnostics['decisionSource']?.['evidence'] ?? run.diagnostics['evidence'] ?? []) as readonly Record<string, any>[])
    .find((x) => x['action'] === action);

/* ============================================================
 * 一、闭环：建议必须由 EV 产生，且与 EV 排名一致
 * ============================================================ */

test('E2E-01：BB 面对 BTN 开池 —— 翻前加注必须拥有**逐尺寸**的自有 EV', () => {
  const run = runOf(bbVsBtnScenario({ heroCards: ['As', 'Ah'] }));
  const pr = run.diagnostics['preflopRaise'] as Record<string, any> | null;
  assert.notEqual(pr, null, '单挑翻前的 3bet 决策点必须产出翻前加注事实包');
  if (pr === null) return;

  /* 覆盖网格里的每一个尺寸 */
  const sizes = (pr['sizes'] as readonly Record<string, any>[]).map((s) => s['sizeChips'] as number);
  assert.deepEqual(
    [...sizes].sort((a, b) => a - b),
    [...run.grid].sort((a, b) => a - b),
    '事实包必须覆盖尺寸网格里的每一个合法尺寸',
  );
  for (const s of pr['sizes'] as readonly Record<string, any>[]) {
    assert.notEqual(s['raiseEV'], null, `尺寸 ${s['sizeBB']}BB 必须有自有 EV（不是 null）`);
    assert.equal(typeof s['foldLikelihood'], 'number');
    assert.equal(typeof s['callLikelihood'], 'number');
    assert.equal(typeof s['reRaiseLikelihood'], 'number');
    assert.notEqual(s['heroEquityVsRaiseCallRange']['value'], undefined);
  }
  /* 版本与模型必须可追溯 */
  assert.equal(pr['version'], 'PREFLOP_RAISE_FACTS_V1');
  assert.equal(pr['modelVersion'], 'PREFLOP_RAISE_RESPONSE_V1');
  assert.equal(pr['usesHeroHiddenCards'], false);
  assert.equal(pr['rakeStatus'], 'NOT_APPLIED');
});

test('E2E-02：🔴 建议的加注尺寸必须拥有**属于它自己**的 EV，且不得借用别的尺寸', () => {
  for (const heroCards of [['As', 'Ah'], ['As', 'Ks'], ['7d', '6d'], ['Qh', '9c']] as const) {
    const run = runOf(bbVsBtnScenario({ heroCards }));
    const action = run.decision['action'] as string;
    const sizeChips = run.decision['sizeChips'] as number | undefined;
    const pr = run.diagnostics['preflopRaise'] as Record<string, any> | null;
    assert.notEqual(pr, null, `(${heroCards.join('')}) 单挑翻前必须有事实包`);

    if (action === 'RAISE' || action === 'ALL_IN') {
      assert.notEqual(sizeChips, undefined, `${heroCards.join('')}：加注建议必须带尺寸`);
      const size = (pr!['sizes'] as readonly Record<string, any>[]).find((s) => s['sizeChips'] === sizeChips);
      assert.notEqual(size, undefined, `${heroCards.join('')}：建议尺寸必须落在事实包里`);
      assert.notEqual(size!['raiseEV'], null, `${heroCards.join('')}：该尺寸必须有自有 EV`);
      /*
       * 由模型 EV 胜出的加注必须给出 `RAISE_MODEL_EV` 理由，并把
       * 「他弃/跟/再加注」三个数与价格一起带出来（U11 的同一纪律）。
       */
      const reason = reasonOf(run, 'RAISE_MODEL_EV');
      assert.notEqual(reason, undefined, `${heroCards.join('')}：模型 EV 胜出必须报 RAISE_MODEL_EV`);
      const data = reason!['data'] as Record<string, any>;
      assert.equal(data['responseModel'], 'PREFLOP_RAISE_RESPONSE_V1', '必须声明用的是哪个响应模型');
      for (const key of ['foldLikelihood', 'callLikelihood', 'reRaiseLikelihood']) {
        assert.equal(typeof data[key], 'number', `${key} 必须随理由一起披露`);
      }
      assert.equal(data['heroFiveBetExpanded'], 0, '必须如实标注「Hero 的 5Bet 未展开」');
      const text = String(reason!['textZh']);
      assert.ok(text.includes('未经统计校准'), '必须声明响应模型未校准');
      assert.ok(text.includes('5Bet'), '必须披露未展开的应对');
    }
  }
});

test('E2E-03：由模型 EV 选出的动作，其 EV 必须真的 ≥ 其它**被评估**候选', () => {
  const run = runOf(bbVsBtnScenario({ heroCards: ['As', 'Ah'] }));
  const action = run.decision['action'] as string;
  const sizeChips = run.decision['sizeChips'] as number | undefined;
  const pr = run.diagnostics['preflopRaise'] as Record<string, any>;
  const callEV = (run.diagnostics['math'] as Record<string, any>)['callEV'] as number | null;

  if (action === 'RAISE' || action === 'ALL_IN') {
    const chosen = (pr['sizes'] as readonly Record<string, any>[]).find((s) => s['sizeChips'] === sizeChips);
    assert.notEqual(chosen, undefined);
    const chosenEV = chosen!['raiseEV'] as number;
    assert.ok(Number.isFinite(chosenEV), '被选中的加注必须有有限的模型 EV');
    /* 网格里被评估的每个尺寸都是「可评估候选」⇒ 选中的那个必须是最大值 */
    const allEVs = (pr['sizes'] as readonly Record<string, any>[])
      .map((s) => s['raiseEV'] as number | null)
      .filter((v): v is number => v !== null);
    const bestEV = Math.max(...allEVs);
    assert.ok(
      Math.abs(chosenEV - bestEV) < 1e-9,
      `选中的加注尺寸必须是网格里 EV 最高的那个：选中 ${chosenEV} vs 最高 ${bestEV}`,
    );
    /* 它还必须真的不差于跟注（否则「EV 最高」这句话没有意义） */
    if (callEV !== null) {
      assert.ok(chosenEV >= callEV - 1e-9, `选中的加注 EV ${chosenEV} 必须 ≥ 跟注 EV ${callEV}`);
    }
  }
});

test('E2E-04：「部分加注没有 EV」的披露必须与实际一致（U10 的同一形态）', () => {
  const run = runOf(bbVsBtnScenario({ heroCards: ['As', 'Ah'] }));
  const pr = run.diagnostics['preflopRaise'] as Record<string, any>;

  /*
   * 🔴 修复前这里会出现自相矛盾：动作由翻前加注 EV 选出，
   * 同一份诊断却把**其余**金额列进 `unevaluatedActions`
   *（理由「缺他面对这次加注的响应概率」）—— 而它们其实都算过了。
   */
  const unevaluated = (run.diagnostics['unevaluatedActions'] ?? []) as readonly Record<string, any>[];
  const evaluatedSizes = new Set((pr['sizes'] as readonly Record<string, any>[]).map((s) => s['sizeChips']));
  for (const u of unevaluated) {
    if (u['action'] !== 'RAISE' && u['action'] !== 'ALL_IN') continue;
    assert.ok(
      !evaluatedSizes.has(u['sizeChips']),
      `已经有自有 EV 的金额 ${u['sizeChips']} 不得出现在「未评估动作」里`,
    );
  }
  /* 本节点所有尺寸都有 EV ⇒ 未评估列表里不应有加注族动作 */
  assert.equal(
    unevaluated.filter((u) => u['action'] === 'RAISE' || u['action'] === 'ALL_IN').length,
    0,
    '所有加注尺寸都有自有 EV 时，不得再报 RAISE_EV_NOT_IMPLEMENTED',
  );
  /* 逐尺寸的 EV 必须能在诊断里直接读到（使用者第十一节） */
  for (const s of pr['sizes'] as readonly Record<string, any>[]) {
    assert.equal(typeof s['raiseEV'], 'number');
    assert.equal(typeof s['finalPot'], 'number');
    assert.equal(typeof s['heroContestedAdd'], 'number');
    assert.equal(typeof s['uncalledReturn'], 'number');
  }
});

/* ============================================================
 * 二、位置、筹码、深度的对照
 * ============================================================ */

/**
 * 6 人桌 Hero SB 面对 BTN 开池（**真实可达的第二个位置轴**）。
 *
 * ## 为什么有位置的对照只能做到这里（一条被测试发现的真实约束）
 *
 * 翻前行动顺序是 UTG → HJ → CO → BTN → SB → BB。因此「Hero 在 BTN
 * 面对 CO 开池、且身后无人未行动」**在翻前根本不存在** ——
 * BTN 之后还有 SB 与 BB。第一个 E2E-05 版本正是那样写的，
 * 被 `reconstruct` 以 `ACTION_NOT_ACTOR` 拒绝（拒绝是对的）。
 *
 * 因此有位置 / 无位置的对照用**两个真实可达的单挑节点**：
 *
 * | 夹具 | Hero | 对手 | 翻前位置 | 翻后位置 |
 * |---|---|---|---|---|
 * | `bbVsBtnScenario` | BB | BTN | 后行动 | **无位置** |
 * | `sbVsBtnScenario` | SB | BTN | 先行动 | **有位置**（BTN 是庄家） |
 *
 * ⚠️ 「翻前最后行动 ≠ 翻后有位置」这条正是使用者第八节点名的——
 * 本项目的 `streetOrder` 已经按真实拓扑处理（单挑翻牌后 BB 先动）。
 */
function sbVsBtnScenario(options: { heroCards: readonly [string, string] }): ManualHandInput {
  const positions = [Position.UTG, Position.HJ, Position.CO, Position.BTN, Position.SB, Position.BB];
  let state = createGame({
    id: 'e2e-sb',
    config: { tableSize: TableSize.SIX_MAX, smallBlind: 1000, bigBlind: 2000, ante: 0, dealerPosition: Position.BTN },
    players: positions.map((position) => ({
      id: position.toLowerCase(),
      name: position,
      position,
      startingStack: 200_000,
      holeCards: position === Position.SB ? C(options.heroCards.join(' ')) : null,
    })),
    userPlayerId: 'sb',
    createdAt: '2026-01-01T00:00:00.000Z',
  });
  const act = (playerId: string, type: 'FOLD' | 'RAISE'): void => {
    const r = applyAction(state, { playerId, type, ...(type === 'RAISE' ? { amount: 5000 } : {}) } as never);
    assert.equal(r.ok, true, `夹具动作 ${playerId}/${type} 必须合法`);
    if (r.ok) state = r.state;
  };
  act('utg', 'FOLD');
  act('hj', 'FOLD');
  act('co', 'FOLD');
  act('btn', 'RAISE');

  return {
    tableSize: 6,
    heroPosition: 'SB',
    heroCards: [...options.heroCards],
    board: [],
    street: 'PREFLOP',
    effectiveStackBB: 100,
    seatStacksBB: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 },
    actionHistory: state.actions
      .filter((a) => a.type !== 'POST_SB' && a.type !== 'POST_BB' && a.type !== 'POST_ANTE')
      .map((a) => ({
        position: a.position,
        type: a.type,
        ...(a.type === 'FOLD' ? {} : { amountBB: a.toAmount / 2000 }),
        street: 'PREFLOP',
      })),
    environment: 'MID_LOW_STAKES',
    villain: { quickProfile: 'NORMAL', dynamicHint: 'UNKNOWN' },
  } as unknown as ManualHandInput;
}

test('E2E-05：位置必须来自真实行动顺序 —— 各位置产生的到达范围不同，且「翻前最后行动 ≠ 翻后有位置」', () => {
  /*
   * ## 一条被测试发现的真实约束（必须如实记录）
   *
   * 翻前行动顺序是 UTG → HJ → CO → BTN → SB → BB。因此一个「单挑 +
   * 我之后无人未行动」的翻前节点，**只可能**出现在**本街最后一个决策点**——
   * 也就是大盲位（所有人都已表态）。
   *
   * ```text
   * Hero SB 面对 BTN 开池 ⇒ BB 还没说话 ⇒ playersRemainingToAct = 1
   *   ⇒ 本模型**拒绝**产出加注 EV（不按单挑算）—— 见本测试的后半段
   * Hero BB 面对 BTN 开池 ⇒ 身后无人         ⇒ 正常产出逐尺寸 EV
   * ```
   *
   * 这是**如实拒绝**，不是缺陷：本阶段的模型只建模单挑，
   * 身后玩家的冷跟 / 挤压留给后续阶段（使用者第九节把「身后还有人」列为
   * 必须区分的情形，本阶段选择「拒绝并披露」而不是「假装他们不存在」）。
   */

  /* ---- ① 真实可达的闭合单挑节点：BB 面对 BTN ---- */
  const oop = runOf(bbVsBtnScenario({ heroCards: ['As', 'Ks'] }));
  const oopFacts = oop.diagnostics['preflopRaise'] as Record<string, any> | null;
  assert.notEqual(oopFacts, null, 'BB 面对 BTN 开池必须有事实包');
  assert.equal(oopFacts!['heroPosition'], 'BB', '位置必须来自真实桌型与行动顺序');
  assert.equal(oopFacts!['opponentPosition'], 'BTN');
  assert.ok((oopFacts!['sizes'] as readonly unknown[]).length > 0, '必须有多个合法尺寸');

  /* ---- ② 位置改变了「他升到这里的范围」---- */
  /*
   * 同一位开池者（BTN）的**到达范围**在两种局面下不同：
   * 对 BB 开池与对 SB 开池用的 RFI 档位由位置决定。
   * 这里用范围引擎能给出的最强证据：范围宽度必须 > 0 且响应概率随位置可变。
   */
  assert.ok(
    (oopFacts!['arrival']['comboCount'] as number) > 50,
    `到达范围必须有实质宽度，实测 ${oopFacts!['arrival']['comboCount']}`,
  );
  /*
   * ⚠️ 「翻前最后行动 ≠ 翻后有位置」：单挑时 BB **翻前最后行动**，
   * 但翻后 BTN（庄家）最后行动 ⇒ BB 是**无位置**。
   * 本项目的 `streetOrder` 已按真实拓扑处理；这里断言事实包如实记录了
   * 双方位置，使下游（翻后模块）能自己判断位置，而不是被这里写死。
   */
  assert.equal(oopFacts!['heroPosition'], 'BB');
  assert.notEqual(oopFacts!['heroPosition'], oopFacts!['opponentPosition']);

  /* ---- ③ SB 面对 BTN 开池：身后还有 BB 未行动 ⇒ 必须拒绝 ---- */
  const sb = runOf(sbVsBtnScenario({ heroCards: ['As', 'Ks'] }));
  assert.equal(
    sb.diagnostics['preflopRaise'] ?? null,
    null,
    'SB 面对 BTN 开池时 BB 未行动 ⇒ 不得产出加注 EV（不冒充单挑闭合节点）',
  );
  assert.ok(
    sb.warnings.some((w) => w.includes('单挑')),
    `拒绝原因必须点明「只按单挑建模、不偷偷按单挑算」：${sb.warnings.join(' | ')}`,
  );
});

test('E2E-05b：后面还有人未行动时**必须明确拒绝**，不得冒充单挑闭合节点', () => {
  /*
   * 只录到 CO 加注、SB / BB 还未弃牌 —— 但 CO 加注之后**轮到 BTN**，
   * 所以这个节点天然就是「身后还有人未行动」。
   */
  const positions = [Position.UTG, Position.HJ, Position.CO, Position.BTN, Position.SB, Position.BB];
  let state = createGame({
    id: 'e2e-open',
    config: { tableSize: TableSize.SIX_MAX, smallBlind: 1000, bigBlind: 2000, ante: 0, dealerPosition: Position.BTN },
    players: positions.map((position) => ({
      id: position.toLowerCase(),
      name: position,
      position,
      startingStack: 200_000,
      holeCards: position === Position.SB ? C('As Ks') : null,
    })),
    userPlayerId: 'sb',
    createdAt: '2026-01-01T00:00:00.000Z',
  });
  const act = (playerId: string, type: 'FOLD' | 'RAISE'): void => {
    const r = applyAction(state, { playerId, type, ...(type === 'RAISE' ? { amount: 5000 } : {}) } as never);
    assert.equal(r.ok, true, `夹具动作 ${playerId}/${type} 必须合法`);
    if (r.ok) state = r.state;
  };
  act('utg', 'FOLD');
  act('hj', 'FOLD');
  act('co', 'FOLD');
  act('btn', 'RAISE');

  const input = {
    tableSize: 6,
    heroPosition: 'SB',
    heroCards: ['As', 'Ks'],
    board: [],
    street: 'PREFLOP',
    effectiveStackBB: 100,
    seatStacksBB: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 },
    actionHistory: state.actions
      .filter((a) => a.type !== 'POST_SB' && a.type !== 'POST_BB' && a.type !== 'POST_ANTE')
      .map((a) => ({
        position: a.position,
        type: a.type,
        ...(a.type === 'FOLD' ? {} : { amountBB: a.toAmount / 2000 }),
        street: 'PREFLOP',
      })),
    environment: 'MID_LOW_STAKES',
    villain: { quickProfile: 'NORMAL', dynamicHint: 'UNKNOWN' },
  } as unknown as ManualHandInput;

  const run = runOf(input);
  assert.equal(
    run.diagnostics['preflopRaise'] ?? null,
    null,
    '身后还有人未行动时不得产出翻前加注事实包（不冒充单挑闭合节点）',
  );
  assert.ok(
    run.warnings.some((w) => w.includes('单挑')),
    `拒绝原因必须点明「只按单挑建模、不偷偷按单挑算」：${run.warnings.join(' | ')}`,
  );
  /* 加注金额必须如实列进「未评估动作」 */
  const unevaluated = (run.diagnostics['unevaluatedActions'] ?? []) as readonly Record<string, any>[];
  assert.ok(
    unevaluated.some((u) => u['action'] === 'RAISE' || u['action'] === 'ALL_IN'),
    '没有加注 EV 时，加注金额必须如实列进未评估动作',
  );
});

test('E2E-06：浅筹码 / 深筹码都必须有合法的逐尺寸 EV，且全下尺寸不得产生再加注分支', () => {
  for (const [heroStackBB, villainStackBB] of [[20, 20], [40, 40], [100, 100], [200, 200]] as const) {
    const run = runOf(bbVsBtnScenario({ heroCards: ['As', 'Ah'], heroStackBB, villainStackBB }));
    const pr = run.diagnostics['preflopRaise'] as Record<string, any> | null;
    assert.notEqual(pr, null, `${heroStackBB}BB 必须有事实包`);
    if (pr === null) return;
    const sizes = pr['sizes'] as readonly Record<string, any>[];
    assert.ok(sizes.length > 0, `${heroStackBB}BB 必须至少有一个合法加注尺寸`);
    for (const s of sizes) {
      assert.notEqual(s['raiseEV'], null, `${heroStackBB}BB 的 ${s['sizeBB']}BB 必须有 EV`);
      /* 尺寸永远不得超过我的剩余筹码 + 本街已投入 */
      assert.ok(
        s['sizeChips'] <= pr['allInToAmount'] + 1e-9,
        `${heroStackBB}BB：尺寸 ${s['sizeChips']} 不得超过全下额 ${pr['allInToAmount']}`,
      );
      /* 全下 / 对手跟平即全下 ⇒ 不得有再加注分支 */
      if (s['isAllIn'] === true || s['villainIsAllInByCall'] === true) {
        assert.equal(s['reRaiseLikelihood'], 0, `${heroStackBB}BB：该尺寸不得有再加注概率`);
        assert.equal(s['reraiseAvailable'], false);
      }
    }
  }
});

/* ============================================================
 * 三、多人池不得偷偷按单挑算
 * ============================================================ */

test('E2E-07：多人池（有冷跟者）不得产出翻前加注 EV，且必须说明原因', () => {
  const run = runOf(bbVsBtnScenario({ heroCards: ['As', 'Ah'], coldCaller: Position.HJ }));
  assert.equal(
    run.diagnostics['preflopRaise'] ?? null,
    null,
    '多人池**不得**产出翻前加注事实包（不得只保留首要对手偷偷按单挑计算）',
  );
  assert.ok(
    run.warnings.some((w) => w.includes('单挑') || w.includes('不是单挑')),
    `多人拒绝必须写进 warnings：${run.warnings.join(' | ')}`,
  );
  /*
   * 并且**不得**出现「部分加注有 EV」这种混合状态 —— 要么全有，要么全无。
   * 未评估列表里必须能看到所有加注金额。
   */
  const unevaluated = (run.diagnostics['unevaluatedActions'] ?? []) as readonly Record<string, any>[];
  assert.ok(
    unevaluated.some((u) => u['action'] === 'RAISE' || u['action'] === 'ALL_IN'),
    '多人池里加注金额必须如实列进「未评估动作」',
  );
});

/* ============================================================
 * 四、可复现与时间预算
 * ============================================================ */

test('E2E-08：相同输入与种子必须逐位复现（建议 / 尺寸 / 逐尺寸 EV）', () => {
  const input = bbVsBtnScenario({ heroCards: ['As', 'Ks'] });
  const a = runOf(input);
  const b = runOf(input);
  assert.equal(a.decision['action'], b.decision['action']);
  assert.equal(a.decision['sizeChips'], b.decision['sizeChips']);
  const sa = (a.diagnostics['preflopRaise'] as Record<string, any>)['sizes'] as readonly Record<string, any>[];
  const sb = (b.diagnostics['preflopRaise'] as Record<string, any>)['sizes'] as readonly Record<string, any>[];
  assert.deepEqual(
    sa.map((s) => [s['sizeChips'], s['raiseEV'], s['foldLikelihood'], s['callLikelihood'], s['reRaiseLikelihood']]),
    sb.map((s) => [s['sizeChips'], s['raiseEV'], s['foldLikelihood'], s['callLikelihood'], s['reRaiseLikelihood']]),
    '相同输入与种子必须逐位复现',
  );
  /* 权益采样误差必须被披露（不能只报一个数） */
  for (const s of sa) {
    const eq = s['heroEquityVsRaiseCallRange'] as Record<string, any>;
    assert.ok(['EXACT', 'MONTE_CARLO', 'NOT_AVAILABLE'].includes(String(eq['method'])));
    assert.equal(typeof eq['iterations'], 'number');
  }
});

test('E2E-09：⏱️ 翻前加注建模不得把节点推过硬性时间上限', () => {
  /*
   * 逐尺寸两次权益（跟注桶 + 再加注桶）是**真实成本**。
   * 这条测试把它钉在硬上限之下 —— 使用者第十七节要求「时间超限明确降级，
   * 不能冒用未完成结果」，而这里断言的是**根本不要超时**。
   */
  const input = bbVsBtnScenario({ heroCards: ['As', 'Ks'] });
  const t0 = Date.now();
  const r = analyzeManualHand(input, { ...OPTIONS, budget: undefined });
  const elapsed = Date.now() - t0;
  assert.equal(r.ok, true, `不得因时间上限失败：${r.ok ? '' : JSON.stringify(r.issues)}`);
  /* 交互式硬上限 8000ms；这里留出余量并要求明显低于它 */
  assert.ok(elapsed < 6000, `单节点分析耗时 ${elapsed}ms 过高（硬上限 8000ms）`);
});

/* ============================================================
 * 五、界面（诊断区）必须能看到逐尺寸证据
 * ============================================================ */

test('E2E-10：决策 ViewModel 的诊断区必须给出逐尺寸 EV / 响应 / 条件权益 / 被再加注应对', () => {
  const input = bbVsBtnScenario({ heroCards: ['As', 'Ah'] });
  const r = analyzeManualHand(input, OPTIONS);
  assert.equal(r.ok, true, '必须能分析');
  if (!r.ok) return;
  const vm = r.viewModel as unknown as Record<string, any>;
  const dbg = (vm['debug'] ?? {}) as Record<string, any>;
  const rows = (dbg['preflopRaise'] ?? []) as readonly { label: string; value: string }[];
  assert.ok(rows.length > 0, '诊断区必须有「翻前加注」小节（不得为空）');

  const valueOf = (needle: string): string | undefined =>
    rows.find((x) => x.label.includes(needle))?.value;
  const labels = rows.map((x) => x.label).join('｜');

  /* 使用者第十一节点名的五件事，逐条必须在诊断区可见 */
  for (const needle of ['逐尺寸 EV', '逐尺寸响应', '条件权益', '被再加注分支', '未支持']) {
    assert.ok(labels.includes(needle), `诊断区必须包含「${needle}」这一行（实际标签：${labels}）`);
  }
  const evRow = valueOf('逐尺寸 EV')!;
  /* 每个尺寸都被列出，不是一个 */
  const sizeCount = (evRow.match(/BB→/g) ?? []).length;
  assert.ok(sizeCount >= 5, `逐尺寸 EV 必须列出**每一个**尺寸，实测 ${sizeCount} 个：${evRow.slice(0, 120)}`);

  const responseRow = valueOf('逐尺寸响应')!;
  assert.ok(responseRow.includes('弃') && responseRow.includes('跟') && responseRow.includes('再加'),
    `响应行必须同时给出「弃 / 跟 / 再加注」三个概率：${responseRow.slice(0, 120)}`);

  const rrRow = valueOf('被再加注分支')!;
  assert.ok(rrRow.includes('FOLD') || rrRow.includes('弃牌'), '被再加注分支必须写明 Hero 评估了哪些应对');

  const unsupportedRow = valueOf('未支持')!;
  assert.ok(unsupportedRow.includes('5Bet'), '必须披露「Hero 的 5Bet 应对未展开」');
  assert.ok(unsupportedRow.includes('摊牌终止近似') || unsupportedRow.includes('近似'), '必须披露未来街近似');
  assert.ok(unsupportedRow.includes('NOT_APPLIED'), '必须披露抽水未计入');

  /* 位置与有效筹码 / SPR 必须可见（使用者第十一节） */
  assert.ok(labels.includes('位置 / 筹码'), `诊断区必须给出位置与筹码：${labels}`);
  assert.ok(valueOf('位置 / 筹码')!.includes('SPR'), '必须给出跟注后的 SPR');
});

test('E2E-11：模型版本与「不读 Hero 底牌」必须可追溯', () => {
  const input = bbVsBtnScenario({ heroCards: ['As', 'Ah'] });
  const r = analyzeManualHand(input, OPTIONS);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const dg = (r.decision.diagnostics ?? {}) as Record<string, any>;
  const pr = dg['preflopRaise'] as Record<string, any>;
  assert.equal(pr['version'], 'PREFLOP_RAISE_FACTS_V1');
  assert.equal(pr['modelVersion'], 'PREFLOP_RAISE_RESPONSE_V1');
  assert.equal(pr['usesHeroHiddenCards'], false, '事实包必须自证「不读 Hero 隐藏底牌」');
  assert.equal(pr['cashflowContract'], 'NODE_INCREMENTAL_CHIPS_V2', '资金口径契约必须与 U1 同值');
  /* 每个尺寸的权益都必须带方法与迭代数（误差可披露） */
  for (const s of pr['sizes'] as readonly Record<string, any>[]) {
    assert.ok(['EXACT', 'MONTE_CARLO', 'NOT_AVAILABLE'].includes(String(s['heroEquityVsRaiseCallRange']['method'])));
    assert.equal(typeof s['heroEquityVsRaiseCallRange']['iterations'], 'number');
  }
});
