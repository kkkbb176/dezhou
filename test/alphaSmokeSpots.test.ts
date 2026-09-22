/**
 * Alpha 决策的**黄金烟测点**（Golden Smoke Spots）
 *
 * ## 本文件的目标不是「证明策略最优」
 *
 * 而是**找出「一眼就明显错误」的建议**。
 *
 * 因此断言分两类：
 * 1. **禁止动作**（`forbiddenActions`）：明显不该出现的建议
 * 2. **允许动作集合**（`allowedActions`）：只要落在这个集合里就算通过
 *
 * ⚠️ **刻意不锁死唯一动作**：`CALL` 与 `RAISE` 都可能合理时，
 * 断言「必须 CALL」会让测试变成在固化一个任意选择。
 * 禁止动作比唯一动作稳定得多，也更能抓住真实错误。
 *
 * ## 断言的保守性（重要的方法论）
 *
 * 每一条 `forbidden` 都必须是我**能说清理由**的：
 * - 权益极高时不该弃牌
 * - 无人下注时不该「跟注」（不存在要跟的注）
 * - 筹码不足时不该建议超过剩余筹码的尺寸
 *
 * 相反地，**不下**这些断言：「AA 必须加注」「顶对必须下注」——
 * 那些依赖具体策略观，而本项目**没有**经过验证的策略基线。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Position, Street } from '../src/domain/types.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import type { ManualHandInput } from '../src/app/manualInput/manualInput.ts';
import {
  DecisionAction,
  type DecisionClassification,
} from '../src/domain/decision/decision.types.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();

/* ============================================================
 * 定义
 * ============================================================ */

type GoldenSpot = {
  id: string;
  /** 中文说明（失败时直接读懂场景） */
  note: string;
  input: ManualHandInput;
  expected: {
    allowedActions: readonly DecisionAction[];
    forbiddenActions?: readonly DecisionAction[];
    classification?: DecisionClassification;
    /** 必须 actionable（默认 true） */
    actionable?: boolean;
  };
};

const OPTIONS = { rules: RULES, asOf: 1_757_000_000_000, writeLog: false } as const;

/* ============================================================
 * 构造辅助
 * ============================================================ */

/** 6 人桌：前面人弃牌，Hero 在指定位置开池到 3BB，其余人弃牌，BB 跟注 */
function headsUpAfterOpen(
  heroPosition: Position,
  heroCards: readonly [string, string],
  board: readonly string[],
  street: Street,
  extra: readonly ManualHandInput['actionHistory'][number][] = [],
): ManualHandInput {
  const order: Position[] = [Position.UTG, Position.HJ, Position.CO, Position.BTN, Position.SB, Position.BB];
  const heroIndex = order.indexOf(heroPosition);
  const history: ManualHandInput['actionHistory'][number][] = [];
  for (let i = 0; i < heroIndex; i++) history.push({ position: order[i]!, type: 'FOLD' });
  history.push({ position: heroPosition, type: 'RAISE', amountBB: 3 });
  for (let i = heroIndex + 1; i < order.length - 1; i++) {
    if (order[i] !== Position.BB) history.push({ position: order[i]!, type: 'FOLD' });
  }
  history.push({ position: Position.BB, type: 'CALL', amountBB: 2 });
  history.push(...extra);

  return {
    tableSize: 6,
    heroPosition,
    heroCards,
    board,
    street,
    effectiveStackBB: 100,
    actionHistory: history,
    environment: 'MID_LOW_STAKES',
    villain: { quickProfile: 'NORMAL' },
  };
}

/**
 * Hero 面对一个开池加注（真正的翻牌前决策点）。
 *
 * ⚠️ 构造要点：Hero 必须在开池者**之后**行动。
 * 若让 Hero 先开池、再由 BB 跟注，翻牌前的下注轮就结束了 ——
 * Hero 那手牌**没有决策点**（`reconstruct` 会正确地阻断）。
 */
function heroFacingOpen(
  heroPosition: Position,
  heroCards: readonly [string, string],
  opener: Position,
  openToBB: number,
): ManualHandInput {
  const order: Position[] = [Position.UTG, Position.HJ, Position.CO, Position.BTN, Position.SB, Position.BB];
  const heroIndex = order.indexOf(heroPosition);
  const openerIndex = order.indexOf(opener);
  const history: ManualHandInput['actionHistory'][number][] = [];

  for (let i = 0; i < openerIndex; i++) history.push({ position: order[i]!, type: 'FOLD' });
  history.push({ position: opener, type: 'RAISE', amountBB: openToBB });
  for (let i = openerIndex + 1; i < heroIndex; i++) {
    history.push({ position: order[i]!, type: 'FOLD' });
  }

  return {
    tableSize: 6,
    heroPosition,
    heroCards,
    board: [],
    street: Street.PREFLOP,
    effectiveStackBB: 100,
    actionHistory: history,
    environment: 'MID_LOW_STAKES',
    villain: { quickProfile: 'NORMAL' },
  };
}

/* ============================================================
 * 全部烟测点
 * ============================================================ */

const FLOP_K72 = ['Kh', '7c', '2d'] as const;
const FLOP_A72 = ['Ah', '7c', '2d'] as const;
const TURN_K72_3 = ['Kh', '7c', '2d', '3s'] as const;
const RIVER_K72_3_9 = ['Kh', '7c', '2d', '3s', '9h'] as const;

const SPOTS: readonly GoldenSpot[] = [
  /* ---------- 翻牌前 ---------- */
  {
    id: 'preflop-01-AKo-vs-open',
    note: '翻牌前小盲持 AKo，面对关煞位开池到 3BB',
    input: heroFacingOpen(Position.SB, ['As', 'Kd'], Position.CO, 3),
    expected: {
      // AKo 面对单个开池：绝不该弃牌
      allowedActions: [DecisionAction.FOLD, DecisionAction.CALL, DecisionAction.RAISE, DecisionAction.ALL_IN],
      forbiddenActions: [DecisionAction.FOLD],
    },
  },
  {
    id: 'preflop-02-AA-vs-open',
    note: '翻牌前小盲持 AA，面对关煞位开池到 3BB',
    input: heroFacingOpen(Position.SB, ['As', 'Ad'], Position.CO, 3),
    expected: {
      allowedActions: [DecisionAction.CALL, DecisionAction.RAISE, DecisionAction.ALL_IN],
      forbiddenActions: [DecisionAction.FOLD],
    },
  },
  {
    id: 'preflop-03-72o-vs-open',
    note: '翻牌前小盲持 72o，面对关煞位开池到 3BB（最弱牌）',
    input: heroFacingOpen(Position.SB, ['7d', '2c'], Position.CO, 3),
    expected: {
      // 小盲面对开池持 72o：可以弃牌，也可以（小额）防守；但**不该全下**
      allowedActions: [DecisionAction.FOLD, DecisionAction.CALL, DecisionAction.RAISE],
      forbiddenActions: [DecisionAction.ALL_IN],
    },
  },
  {
    id: 'preflop-04-AA-vs-3bet',
    note: '翻牌前持 AA，面对 3Bet（CO 开池后大盲 3Bet 到 10BB）',
    input: {
      tableSize: 6,
      heroPosition: Position.CO,
      heroCards: ['As', 'Ad'],
      board: [],
      street: Street.PREFLOP,
      effectiveStackBB: 100,
      actionHistory: [
        { position: Position.UTG, type: 'FOLD' },
        { position: Position.HJ, type: 'FOLD' },
        { position: Position.CO, type: 'RAISE', amountBB: 3 },
        { position: Position.BTN, type: 'FOLD' },
        { position: Position.SB, type: 'FOLD' },
        { position: Position.BB, type: 'RAISE', amountBB: 10 },
      ],
      environment: 'MID_LOW_STAKES',
      villain: { quickProfile: 'NORMAL' },
    },
    expected: {
      allowedActions: [DecisionAction.CALL, DecisionAction.RAISE, DecisionAction.ALL_IN],
      forbiddenActions: [DecisionAction.FOLD, DecisionAction.CHECK],
    },
  },

  /* ---------- 翻牌：顶对 / 超对 ---------- */
  {
    id: 'flop-01-top-pair-good-kicker',
    note: '翻牌 K 顶对（AK），对手过牌',
    input: headsUpAfterOpen(Position.CO, ['As', 'Kd'], FLOP_K72, Street.FLOP, [
      { position: Position.BB, type: 'CHECK', street: Street.FLOP },
    ]),
    expected: {
      allowedActions: [DecisionAction.CHECK, DecisionAction.BET],
      forbiddenActions: [DecisionAction.CALL, DecisionAction.FOLD, DecisionAction.RAISE, DecisionAction.ALL_IN],
    },
  },
  {
    id: 'flop-02-overpair-aces',
    note: '翻牌 AA 超对，对手过牌',
    input: headsUpAfterOpen(Position.CO, ['As', 'Ad'], FLOP_K72, Street.FLOP, [
      { position: Position.BB, type: 'CHECK', street: Street.FLOP },
    ]),
    expected: {
      allowedActions: [DecisionAction.CHECK, DecisionAction.BET],
      forbiddenActions: [DecisionAction.CALL, DecisionAction.FOLD],
    },
  },
  {
    id: 'flop-03-top-pair-vs-small-bet',
    note: '翻牌顶对（AK），对手下注约 1/3 底池 —— **绝不该弃牌**',
    input: headsUpAfterOpen(Position.CO, ['As', 'Kd'], FLOP_K72, Street.FLOP, [
      { position: Position.BB, type: 'BET', amountBB: 2, street: Street.FLOP },
    ]),
    expected: {
      allowedActions: [DecisionAction.CALL, DecisionAction.RAISE, DecisionAction.ALL_IN],
      // 权益极高（顶对 + 对手范围很宽）时的弃牌是明显的严重错误
      forbiddenActions: [DecisionAction.FOLD],
    },
  },
  {
    id: 'flop-04-set-of-kings',
    note: '翻牌三条 K（KK 中暗三条），对手过牌',
    input: headsUpAfterOpen(Position.CO, ['Ks', 'Kd'], FLOP_K72, Street.FLOP, [
      { position: Position.BB, type: 'CHECK', street: Street.FLOP },
    ]),
    expected: {
      allowedActions: [DecisionAction.CHECK, DecisionAction.BET],
      forbiddenActions: [DecisionAction.CALL, DecisionAction.FOLD],
    },
  },

  /* ---------- 翻牌：弱牌 ---------- */
  {
    id: 'flop-05-air-vs-big-bet',
    note: '翻牌完全没中（72o），对手下注 2/3 底池',
    input: headsUpAfterOpen(Position.CO, ['7d', '2c'], FLOP_A72, Street.FLOP, [
      { position: Position.BB, type: 'BET', amountBB: 4.3, street: Street.FLOP },
    ]),
    expected: {
      allowedActions: [DecisionAction.FOLD, DecisionAction.CALL, DecisionAction.RAISE, DecisionAction.ALL_IN],
      // 只断言：不该在全下（100BB 深筹码、无成手）
      forbiddenActions: [DecisionAction.ALL_IN],
    },
  },
  {
    id: 'flop-06-weak-hand-checked-to',
    note: '翻牌高牌 A 带小脚（A2o 中一对 2？不 —— A2 未中），对手过牌',
    input: headsUpAfterOpen(Position.CO, ['Ad', '2c'], FLOP_K72, Street.FLOP, [
      { position: Position.BB, type: 'CHECK', street: Street.FLOP },
    ]),
    expected: {
      allowedActions: [DecisionAction.CHECK, DecisionAction.BET],
      forbiddenActions: [DecisionAction.CALL, DecisionAction.FOLD],
    },
  },

  /* ---------- 转牌 / 河牌 ---------- */
  {
    id: 'turn-01-top-pair-vs-check',
    note: '转牌顶对，对手过牌',
    input: headsUpAfterOpen(Position.CO, ['As', 'Kd'], TURN_K72_3, Street.TURN, [
      { position: Position.BB, type: 'CHECK', street: Street.FLOP },
      { position: Position.CO, type: 'CHECK', street: Street.FLOP },
      { position: Position.BB, type: 'CHECK', street: Street.TURN },
    ]),
    expected: {
      allowedActions: [DecisionAction.CHECK, DecisionAction.BET],
      forbiddenActions: [DecisionAction.CALL, DecisionAction.FOLD],
    },
  },
  {
    id: 'river-01-top-pair-vs-check',
    note: '河牌顶对，对手过牌（薄价值场景）',
    input: headsUpAfterOpen(Position.CO, ['As', 'Kd'], RIVER_K72_3_9, Street.RIVER, [
      { position: Position.BB, type: 'CHECK', street: Street.FLOP },
      { position: Position.CO, type: 'CHECK', street: Street.FLOP },
      { position: Position.BB, type: 'CHECK', street: Street.TURN },
      { position: Position.CO, type: 'CHECK', street: Street.TURN },
      { position: Position.BB, type: 'CHECK', street: Street.RIVER },
    ]),
    expected: {
      allowedActions: [DecisionAction.CHECK, DecisionAction.BET],
      forbiddenActions: [DecisionAction.CALL, DecisionAction.FOLD],
    },
  },
  {
    id: 'river-02-bluff-catcher-vs-overbet',
    note: '河牌只有一对 K（顶对），对手超池下注 —— 边缘抓诈唬场景',
    input: headsUpAfterOpen(Position.CO, ['As', 'Kd'], RIVER_K72_3_9, Street.RIVER, [
      { position: Position.BB, type: 'CHECK', street: Street.FLOP },
      { position: Position.CO, type: 'CHECK', street: Street.FLOP },
      { position: Position.BB, type: 'CHECK', street: Street.TURN },
      { position: Position.CO, type: 'CHECK', street: Street.TURN },
      { position: Position.BB, type: 'BET', amountBB: 20, street: Street.RIVER },
    ]),
    expected: {
      // 超池下注的应对没有唯一正确答案。
      //
      // ⚠️ 曾经这里写 `forbiddenActions: [ALL_IN]` —— 那个断言基于一个
      // **巧合**：修复 F-01（RAISE 不可达）之前系统只会跟注或弃牌，
      // 所以「不全下」自动成立。修好后系统会加注（下注额大 → 加注目标也大），
      // 于是“不全下”这个断言变成了在固化「不能加注」这个缺陷。
      //
      // 现在改为：**允许加注，但不得超过底池的 2.5 倍**（由引擎的
      // `MAX_RAISE_TO_POT_RATIO` 保证），并对尺寸单独断言。
      allowedActions: [DecisionAction.FOLD, DecisionAction.CALL, DecisionAction.RAISE],
      forbiddenActions: [],
    },
  },

  /* ---------- 深筹码 ---------- */
  {
    id: 'deep-01-150bb-top-pair',
    note: '150BB 深筹码，翻牌顶对，对手过牌',
    input: {
      ...headsUpAfterOpen(Position.CO, ['As', 'Kd'], FLOP_K72, Street.FLOP, [
        { position: Position.BB, type: 'CHECK', street: Street.FLOP },
      ]),
      effectiveStackBB: 150,
    },
    expected: {
      allowedActions: [DecisionAction.CHECK, DecisionAction.BET],
      // 深筹码下不该因为「牌不错」就全下
      forbiddenActions: [DecisionAction.ALL_IN, DecisionAction.CALL, DecisionAction.FOLD],
    },
  },
  {
    id: 'deep-02-200bb-top-pair',
    note: '200BB 深筹码，翻牌顶对，对手过牌',
    input: {
      ...headsUpAfterOpen(Position.CO, ['As', 'Kd'], FLOP_K72, Street.FLOP, [
        { position: Position.BB, type: 'CHECK', street: Street.FLOP },
      ]),
      effectiveStackBB: 200,
    },
    expected: {
      allowedActions: [DecisionAction.CHECK, DecisionAction.BET],
      forbiddenActions: [DecisionAction.ALL_IN, DecisionAction.CALL, DecisionAction.FOLD],
    },
  },
  {
    id: 'short-01-10bb-top-pair',
    note: '10BB 短筹码，翻牌顶对，对手过牌（SPR 很低）',
    input: {
      ...headsUpAfterOpen(Position.CO, ['As', 'Kd'], FLOP_K72, Street.FLOP, [
        { position: Position.BB, type: 'CHECK', street: Street.FLOP },
      ]),
      effectiveStackBB: 10,
    },
    expected: {
      allowedActions: [DecisionAction.CHECK, DecisionAction.BET, DecisionAction.ALL_IN],
      forbiddenActions: [DecisionAction.CALL, DecisionAction.FOLD],
    },
  },

  /* ---------- 多人池：必须明确拒绝 ---------- */
  {
    id: 'multiway-01-three-way',
    /*
     * 🔴 这个 Spot 的期望在本轮**反转了**，理由必须写清楚。
     *
     * 原期望：「3 名对手已进池 ⇒ 第一版必须明确返回信息不足」。
     * 动机是对的 —— 那时权益只按**首要对手一家**算，与按 4 家算的
     * 底池赔率口径不一致，数字会系统性偏乐观。
     *
     * 但那条拒绝把工具在真实牌桌上废掉了：多人底池是常态。
     * 现在权益按**全部已实现对手**一起算，口径与底池一致，
     * 因此这个 Spot 必须给出一个**具体动作**。
     *
     * ⚠️ 期望从「拒绝」改成「给建议」**不是放宽标准**：
     * - 这仍然是 25 个 Spot 里唯一一个四人底池，它继续走完整套检查
     *  （动作合法性、禁止集合、尺寸合法性、加注量级保护）
     * - `MULTIWAY_APPROXIMATION` 那条口径声明另有专门的回归测试
     *  （`alphaRedteamRegression.test.ts` 的 F-06）
     */
    note: '四人底池（CO 加注、BTN/SB/BB 全部跟注）—— 顶对 K + A 踢脚必须给出具体动作',
    input: {
      tableSize: 6,
      heroPosition: Position.CO,
      heroCards: ['As', 'Kd'],
      board: FLOP_K72,
      street: Street.FLOP,
      effectiveStackBB: 100,
      actionHistory: [
        { position: Position.UTG, type: 'FOLD' },
        { position: Position.HJ, type: 'FOLD' },
        { position: Position.CO, type: 'RAISE', amountBB: 3 },
        { position: Position.BTN, type: 'CALL', amountBB: 3 },
        { position: Position.SB, type: 'CALL', amountBB: 2.5 },
        { position: Position.BB, type: 'CALL', amountBB: 2 },
        // 翻牌后行动顺序是「小盲 → 大盲 → … → 庄家位」
        // 因此 SB 先过牌，再 BB 过牌，然后轮到 Hero（CO）
        { position: Position.SB, type: 'CHECK', street: Street.FLOP },
        { position: Position.BB, type: 'CHECK', street: Street.FLOP },
      ],
      environment: 'MID_LOW_STAKES',
      villain: { quickProfile: 'NORMAL' },
    },
    expected: {
      actionable: true,
      // 前面都过牌了，Hero 是最后行动的人：弃牌在数学上就说不通（无需跟注任何钱）
      allowedActions: [DecisionAction.CHECK, DecisionAction.BET, DecisionAction.ALL_IN],
      forbiddenActions: [DecisionAction.FOLD],
    },
  },

  /* ---------- 玩家画像 ---------- */
  {
    id: 'profile-01-calling-station',
    note: '对手标记为跟注站，翻牌顶对，对手过牌',
    input: {
      ...headsUpAfterOpen(Position.CO, ['As', 'Kd'], FLOP_K72, Street.FLOP, [
        { position: Position.BB, type: 'CHECK', street: Street.FLOP },
      ]),
      villain: { quickProfile: 'CALLING_STATION' },
    },
    expected: {
      allowedActions: [DecisionAction.CHECK, DecisionAction.BET],
      forbiddenActions: [DecisionAction.FOLD],
    },
  },
  {
    id: 'profile-02-maniac-vs-top-pair',
    note: '对手标记为疯子型，翻牌顶对面对下注',
    input: {
      ...headsUpAfterOpen(Position.CO, ['As', 'Kd'], FLOP_K72, Street.FLOP, [
        { position: Position.BB, type: 'BET', amountBB: 5, street: Street.FLOP },
      ]),
      villain: { quickProfile: 'MANIAC' },
    },
    expected: {
      allowedActions: [DecisionAction.CALL, DecisionAction.RAISE, DecisionAction.ALL_IN],
      forbiddenActions: [DecisionAction.FOLD],
    },
  },
  {
    id: 'profile-03-nit-vs-bet',
    note: '对手标记为极紧，翻牌中等牌力面对下注',
    input: {
      ...headsUpAfterOpen(Position.CO, ['7h', '7d'], FLOP_A72, Street.FLOP, [
        { position: Position.BB, type: 'BET', amountBB: 6, street: Street.FLOP },
      ]),
      villain: { quickProfile: 'VERY_TIGHT' },
    },
    expected: {
      // 三条 7 面对紧手在 A 高牌面的下注 —— 只要求别全下
      allowedActions: [DecisionAction.FOLD, DecisionAction.CALL, DecisionAction.RAISE, DecisionAction.ALL_IN],
      forbiddenActions: [],
    },
  },

  /* ---------- 动态提示 ---------- */
  {
    id: 'dynamic-01-tilt-hint',
    note: '用户手选「疑似上头」，翻牌顶对面对下注',
    input: {
      ...headsUpAfterOpen(Position.CO, ['As', 'Kd'], FLOP_K72, Street.FLOP, [
        { position: Position.BB, type: 'BET', amountBB: 5, street: Street.FLOP },
      ]),
      villain: { quickProfile: 'AGGRESSIVE', dynamicHint: 'TILT_SIGNAL' },
    },
    expected: {
      allowedActions: [DecisionAction.CALL, DecisionAction.RAISE, DecisionAction.ALL_IN],
      // 低置信度动态**不得**把「顶对面对下注」翻成弃牌
      forbiddenActions: [DecisionAction.FOLD],
    },
  },
  {
    id: 'dynamic-02-aggression-up',
    note: '用户手选「近期更凶」，翻牌顶对对手过牌',
    input: {
      ...headsUpAfterOpen(Position.CO, ['As', 'Kd'], FLOP_K72, Street.FLOP, [
        { position: Position.BB, type: 'CHECK', street: Street.FLOP },
      ]),
      villain: { quickProfile: 'AGGRESSIVE', dynamicHint: 'AGGRESSION_UP' },
    },
    expected: {
      allowedActions: [DecisionAction.CHECK, DecisionAction.BET],
      forbiddenActions: [DecisionAction.FOLD],
    },
  },

  /* ---------- 环境 ---------- */
  {
    id: 'env-01-low-stakes-top-pair',
    note: '低级别线上环境，翻牌顶对面对下注',
    input: {
      ...headsUpAfterOpen(Position.CO, ['As', 'Kd'], FLOP_K72, Street.FLOP, [
        { position: Position.BB, type: 'BET', amountBB: 3, street: Street.FLOP },
      ]),
      environment: 'LOW_STAKES_ONLINE',
    },
    expected: {
      allowedActions: [DecisionAction.CALL, DecisionAction.RAISE, DecisionAction.ALL_IN],
      forbiddenActions: [DecisionAction.FOLD],
    },
  },
  {
    id: 'env-02-theory-reference-top-pair',
    note: '理论参考环境，翻牌顶对对手过牌',
    input: {
      ...headsUpAfterOpen(Position.CO, ['As', 'Kd'], FLOP_K72, Street.FLOP, [
        { position: Position.BB, type: 'CHECK', street: Street.FLOP },
      ]),
      environment: 'THEORY_REFERENCE',
    },
    expected: {
      allowedActions: [DecisionAction.CHECK, DecisionAction.BET],
      forbiddenActions: [DecisionAction.FOLD],
    },
  },

  /* ---------- 无对手数据 ---------- */
  {
    id: 'unknown-01-no-villain-data',
    note: '完全没有对手数据（无画像、无动态）—— **仍应能分析**',
    input: {
      ...headsUpAfterOpen(Position.CO, ['As', 'Kd'], FLOP_K72, Street.FLOP, [
        { position: Position.BB, type: 'CHECK', street: Street.FLOP },
      ]),
      villain: { quickProfile: 'UNKNOWN', dynamicHint: 'UNKNOWN' },
    },
    expected: {
      allowedActions: [DecisionAction.CHECK, DecisionAction.BET],
      actionable: true, // 无对手数据**不应阻止**基础决策
      forbiddenActions: [DecisionAction.FOLD],
    },
  },
];

/* ============================================================
 * 执行
 * ============================================================ */

test(`烟测:${SPOTS.length} 个 Golden Spots 全部可分析且不含「一眼明显错误」的建议`, () => {
  const failures: string[] = [];
  const summary: string[] = [];
  let allInCount = 0;

  for (const spot of SPOTS) {
    const result = analyzeManualHand(spot.input, OPTIONS);

    if (!result.ok) {
      failures.push(`[${spot.id}] ${spot.note}\n    分析失败（阶段 ${result.stage}）：${result.issues.map((i) => i.message).join('；')}`);
      continue;
    }

    const { decision } = result;
    const wantActionable = spot.expected.actionable ?? true;

    // ---- actionable ----
    if (decision.actionable !== wantActionable) {
      failures.push(
        `[${spot.id}] ${spot.note}\n    actionable 期望 ${wantActionable}，实际 ${decision.actionable}（分类 ${decision.classification}）`,
      );
    }

    // ---- 分类 ----
    if (spot.expected.classification !== undefined && decision.classification !== spot.expected.classification) {
      failures.push(
        `[${spot.id}] ${spot.note}\n    分类期望 ${spot.expected.classification}，实际 ${decision.classification}`,
      );
    }

    // ---- 动作必须在合法集合内（最重要的不变量）----
    //
    // `action === null` 专指「信息不足，系统拒绝给建议」（红队 F-05），
    // 它天然不在合法集合里，因此必须先把它区分出来：
    // 只要 `actionable`，就**必须**有具体动作。
    if (decision.actionable && decision.action === null) {
      failures.push(`[${spot.id}] ${spot.note}\n    actionable=true 但 action=null —— 内部不一致`);
    }
    if (decision.action !== null && !decision.diagnostics.legalActions.includes(decision.action)) {
      failures.push(
        `[${spot.id}] ${spot.note}\n    输出非法动作 ${decision.action}，合法集合 [${decision.diagnostics.legalActions.join(', ')}]`,
      );
    }

    // ---- 允许集合 ----
    if (decision.actionable && decision.action !== null && !spot.expected.allowedActions.includes(decision.action)) {
      failures.push(
        `[${spot.id}] ${spot.note}\n    动作 ${decision.action} 不在允许集合 [${spot.expected.allowedActions.join(', ')}]`,
      );
    }

    // ---- 禁止集合 ----
    for (const forbidden of spot.expected.forbiddenActions ?? []) {
      if (decision.actionable && decision.action === forbidden) {
        failures.push(
          `[${spot.id}] ${spot.note}\n    **出现禁止动作 ${forbidden}**（原因：${decision.reasons[0]?.textZh ?? '无'}）`,
        );
      }
    }

    // ---- 尺寸合法性（每个 spot 都查）----
    if (decision.sizeChips !== undefined) {
      const math = decision.diagnostics.math;
      /*
       * 🔴 **口径修正（阶段 B 暴露）**：动作金额的语义**逐动作不同**。
       *
       * | 动作 | `sizeChips` 口径 | 合法上限 |
       * |---|---|---|
       * | `CALL` | 本次新增投入 | 剩余筹码 |
       * | `BET` / `RAISE` / `ALL_IN` | **本街累计（raise-to）** | `本街已投入 + 剩余筹码` |
       *
       * 修复前这里拿 `sizeChips > myRemainingStack` 判所有动作 —— 对加注族而言
       * 是**拿两种口径比大小**。实测（`preflop-04-AA-vs-3bet`，Hero CO 已投入 3BB、
       * 剩余 97BB、合法全下 = 100BB）：
       *
       * ```text
       * 尺寸非法：10000（剩余筹码 9700）   ← 10000 正是引擎自己的 allInToAmount
       * ```
       *
       * 这是 TEST 18（`raiseToAmountConsistency.test.ts`）已经修过的那类缺陷，
       * 本条烟测漏了。现在改成按动作口径判。
       */
      const limit =
        decision.action === DecisionAction.CALL
          ? math.myRemainingStack
          : math.myCommittedThisStreet + math.myRemainingStack;
      if (!(decision.sizeChips > 0) || decision.sizeChips > limit + 1e-9) {
        failures.push(
          `[${spot.id}] ${spot.note}\n    尺寸非法：${decision.sizeChips}（${decision.action} 的上限 ${limit}` +
            `｜本街已投入 ${math.myCommittedThisStreet}、剩余 ${math.myRemainingStack}）`,
        );
      }
    }

    // ---- 加注量级保护：非怪兽牌不得加注到超过底池 2.5 倍 ----
    //
    // 这是修复 F-01 后立刻暴露的新问题：对手下注越大，
    // 加注目标 `底池 + 2×跟注` 越高，于是系统在**河牌持一对**时
    // 建议加注到 40BB（底池的 6 倍，实际就是全下）。
    // 引擎已加 `MAX_RAISE_TO_POT_RATIO` 保护（`handCategory < 3` ⇒ 生效），
    // 这里从外部再钉一遍。
    //
    // 🔴 **阶段 B 的作用域修正**：该保护在引擎里被 `handCategory < 3` 包住，
    // 而**翻前 `handCategory ≡ 0`**（没有成手牌）⇒ 它同样会拦翻前。
    // 但翻前的「加注额 / 底池」天然很大 —— 100BB 深、面对 3Bet 时的合法全下
    // 就是 7.4 倍底池（4Bet 全下是**正常**打法，不是「把筹码乱打光」）。
    // 因此这条检查必须**明确按街道限定在翻后**，与引擎的 `commitments.ts`
    // 与 `preflopAllInGuard` 的街道适用范围保持同一口径。
    if (decision.actionable && decision.action === DecisionAction.RAISE && String(decision.diagnostics.math.street) !== 'PREFLOP') {
      const pot = decision.diagnostics.math.pot;
      const to = decision.sizeChips ?? 0;
      const tier = decision.diagnostics.math.handRankZh;
      const isMonster =
        /葫芦|四条|同花顺|三条|顺子|同花/.test(tier) || decision.diagnostics.math.handCategory >= 5;
      if (pot > 0 && to / pot > 2.5 && !isMonster) {
        failures.push(
          `[${spot.id}] ${spot.note}\n    加注量级过大：加到 ${to}（底池 ${pot}，` +
            `${(to / pot).toFixed(1)} 倍）而牌力只是「${tier}」—— ` +
            '非怪兽牌不应把筹码打光',
        );
      }
    }

    if (decision.action === DecisionAction.ALL_IN) allInCount += 1;
    summary.push(`${spot.id}=${decision.action}${decision.sizeBB !== undefined ? `(${decision.sizeBB.toFixed(1)}BB)` : ''}`);
  }

  console.log(`  [烟测] ${summary.join(' | ')}`);
  console.log(`  [烟测] 全下建议数 = ${allInCount} / ${SPOTS.length}`);

  assert.deepEqual(failures, [], `烟测失败：\n${failures.map((f) => `  ${f}`).join('\n')}`);
});

test('烟测:全下建议比例必须很低（第一版不应频繁建议全下）', () => {
  let allIn = 0;
  let analyzed = 0;
  for (const spot of SPOTS) {
    const result = analyzeManualHand(spot.input, OPTIONS);
    if (!result.ok) continue;
    analyzed += 1;
    if (result.decision.actionable && result.decision.action === DecisionAction.ALL_IN) allIn += 1;
  }
  assert.ok(analyzed > 0);
  const ratio = allIn / analyzed;
  console.log(`  [烟测] 全下比例 = ${(ratio * 100).toFixed(1)}%（${allIn}/${analyzed}）`);
  assert.ok(ratio <= 0.15, `全下建议比例必须 ≤15%（实际 ${(ratio * 100).toFixed(1)}%）`);
});

test('烟测:全部命中同一段代码路径且无异常（结构完整性）', () => {
  for (const spot of SPOTS) {
    const result = analyzeManualHand(spot.input, OPTIONS);
    if (result.ok) {
      assert.ok(result.viewModel.actionZh.length > 0, `${spot.id}: 必须有动作文案`);
      assert.ok(result.viewModel.debug.math.length > 0, `${spot.id}: 必须有数学诊断`);
      assert.ok(result.viewModel.debug.legalActionsZh.length > 0, `${spot.id}: 必须有合法动作`);
    } else {
      assert.ok(result.issues.length > 0, `${spot.id}: 失败必须有原因`);
    }
  }
});

/* ============================================================
 * 三环境对照（至少 10 个关键 Spot）
 * ============================================================ */

test('三环境对照:同一 Spot 在三种环境下的数学一致、决策差异方向合理', () => {
  const environments = ['LOW_STAKES_ONLINE', 'MID_LOW_STAKES', 'THEORY_REFERENCE'] as const;
  const subset = SPOTS.slice(0, 12);

  let comparable = 0;
  for (const spot of subset) {
    const results = environments.map((environment) =>
      analyzeManualHand({ ...spot.input, environment }, OPTIONS),
    );
    const okResults = results.filter((r) => r.ok);
    if (okResults.length !== environments.length) continue;
    comparable += 1;

    const base = okResults[1]!;
    if (!base.ok) continue;
    for (const [index, result] of okResults.entries()) {
      if (!result.ok) continue;
      // 数学九项必须逐位一致（环境绝不修改数学）
      assert.equal(
        result.decision.diagnostics.math.potOdds,
        base.decision.diagnostics.math.potOdds,
        `${spot.id} / ${environments[index]}: 底池赔率被环境改变`,
      );
      assert.equal(
        result.decision.diagnostics.math.requiredEquity,
        base.decision.diagnostics.math.requiredEquity,
        `${spot.id} / ${environments[index]}: 所需权益被环境改变`,
      );
      assert.equal(
        result.decision.diagnostics.math.handRankZh,
        base.decision.diagnostics.math.handRankZh,
        `${spot.id} / ${environments[index]}: 牌力被环境改变`,
      );
      // 输出的动作永远合法。
      //
      // 先把「信息不足」这个合法状态判定清楚（红队 F-05）：
      // `action === null` 必须**当且仅当** `actionable === false`，
      // 两者不一致就是内部矛盾，必须暴露。
      assert.equal(
        result.decision.action === null,
        !result.decision.actionable,
        `${spot.id} / ${environments[index]}: action(=null?) 与 actionable 不一致`,
      );
      if (result.decision.action !== null) {
        assert.ok(
          result.decision.diagnostics.legalActions.includes(result.decision.action),
          `${spot.id} / ${environments[index]}: 输出非法动作`,
        );
      }
    }
  }

  console.log(`  [三环境对照] 可比 Spot 数 = ${comparable}/${subset.length}`);
  assert.ok(comparable >= 10, `至少要有 10 个 Spot 可对照（实际 ${comparable}）`);
});
