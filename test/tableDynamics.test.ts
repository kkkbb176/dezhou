/**
 * ============================================================================
 * 牌桌动态适应 V1 —— 行为契约测试
 * ============================================================================
 *
 * ## 这份文件防的是什么（每条都对应一个具体失败形态）
 *
 * | 组 | 防的失败形态 |
 * |---|---|
 * | A | 无数据 / 少量数据时编造数字（把「未观测」当「观测到 0」） |
 * | B | 用动作次数冒充机会数（分母被玩家行为偷走） |
 * | C | 少量连续加注被当成「疯子」⇒ 极端调整 |
 * | D | 整桌偏松时，把一个其实很紧的对手也调松（用整桌覆盖个体） |
 * | E | 离桌玩家继续主导桌况 |
 * | F | 同一批证据在多层/多维度里重复计权 |
 * | G | 决策读了未来信息（后续行动、摊牌结果） |
 * | H | 单挑/多人边界错用（单挑套用整桌平均） |
 * | I | 不同桌况误用同一缓存结果 |
 * | J | 影子模式改变正式建议 / 污染原始输入 |
 * | K | 调整后金额不再合法（越界 / 低于最小加注） |
 * | L | 领域层产出「界面/模型无法表达」的标签 |
 *
 * ## 数据来源说明
 *
 * 本文件**只用合成的 `ObservationRecord`**（形状与 `playerHistory.ts` 的
 * 生产形状逐字段一致），不依赖真实牌局 —— 因为要精确控制
 * 「机会数 / 命中数 / 是否缺字段」这些变量。
 * 生产链路的端到端验证在 `test/tableDynamicsE2E.test.ts`。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { ObservationRecord } from '../src/app/table/playerHistory.ts';
import { QuickProfile } from '../src/app/manualInput/manualInput.ts';
import { archetypeDimensionsOf } from '../src/domain/player/archetypeDimensions.ts';
import {
  ARCHETYPE_DIMENSION_REFERENCE,
  BET_SIZE_BUCKETS,
  TABLE_BASELINES,
  TABLE_DYNAMICS_CONFIG,
  TABLE_PROFILE_NAMES,
  TableDirection,
  TableDimensionId,
  betSizeBucketOf,
  buildTableAdjustmentPlan,
  computeTableDynamics,
  justifiedLabelOrNull,
  type OpponentQuickProfile,
  type TableAdjustmentContext,
  type TableDynamics,
} from '../src/domain/tableDynamics/tableDynamics.ts';
import {
  TableDynamicsMode,
  runTableDynamicsShadow,
  shadowChangedAction,
  type ShadowAnalyzeResult,
  type ShadowDecisionView,
} from '../src/domain/tableDynamics/tableDynamicsShadow.ts';
import {
  computeTableDynamicsDigest,
  stableHash32,
} from '../src/domain/tableDynamics/tableDynamicsDigest.ts';

/* ============================================================
 * 合成记录工厂（与生产 `deriveObservations` 的字段形状一致）
 * ============================================================ */

type RecSpec = {
  hand: number;
  player: string;
  seat: string;
  street?: 'PREFLOP' | 'FLOP' | 'TURN' | 'RIVER';
  action: 'FOLD' | 'CHECK' | 'CALL' | 'BET' | 'RAISE' | 'ALL_IN';
  amountBB?: number;
  /** 行动前需跟注额（BB） */
  toCallBB?: number;
  potBB?: number;
  activeCount?: number;
  playersYetToAct?: number;
  effectiveStackBB?: number;
  /** 显式省略需要新字段的桌况字段（模拟旧格式记录） */
  legacy?: boolean;
  tableId?: string;
};

function rec(spec: RecSpec): ObservationRecord {
  const tableId = spec.tableId ?? 'T';
  const street = spec.street ?? 'PREFLOP';
  const toCallBB = spec.toCallBB ?? 0;
  const potBB = spec.potBB ?? 1.5;
  const facedBet = toCallBB > 0;
  const base: ObservationRecord = {
    handId: `${tableId}#H${spec.hand}`,
    playerId: spec.player,
    seatId: spec.seat,
    street,
    actionType: spec.action,
    amountBB: spec.amountBB ?? 0,
    facedBet,
    toCallBB,
    seq: spec.hand,
    baseRevision: spec.hand,
    historyLength: spec.hand,
    source: 'USER_INPUT',
    saved: true,
    handComplete: true,
  };
  if (spec.legacy === true) return base;
  return {
    ...base,
    activeCount: spec.activeCount ?? 6,
    effectiveStackBB: spec.effectiveStackBB ?? 100,
    potBB,
    facedBetBB: toCallBB,
    facedBetPotRatio: facedBet && potBB + toCallBB > 0 ? Number((toCallBB / (potBB + toCallBB)).toFixed(4)) : 0,
    actorOrderIndex: 0,
    streetActorCount: 5,
    playersYetToAct: spec.playersYetToAct ?? 3,
    buttonPosition: 'BTN',
  };
}

const dimsOf = (d: TableDynamics, id: TableDimensionId) => {
  const found = d.layers.table.find((x) => x.id === id);
  assert.ok(found !== undefined, `维度 ${id} 必须存在`);
  return found;
};

const baseCtx = (over: Partial<TableAdjustmentContext> = {}): TableAdjustmentContext => ({
  activeCount: 6,
  street: 'PREFLOP',
  playersYetToAct: 3,
  relevantPlayerIds: [],
  ...over,
});

/* ============================================================
 * A. 无数据 / 少量数据：不得编造数字
 * ============================================================ */

test('A1 完全无记录 ⇒ 全部维度机会数为 0、比率为基线、可信度 0、处于观察中', () => {
  const d = computeTableDynamics({
    records: [],
    presentPlayerIds: ['p1', 'p2'],
    heroPlayerId: 'hero',
    relevantPlayerIds: ['p1'],
  });
  assert.equal(d.recordsUsed, 0);
  assert.equal(d.handsObserved, 0);
  assert.equal(d.tableConfidence, 0);
  assert.equal(d.observing, true);
  for (const dim of d.layers.table) {
    assert.equal(dim.opportunities, 0, `${dim.id} 机会数必须为 0`);
    assert.equal(dim.successes, 0);
    // 平滑后比率必须等于基线（不是 0、不是 NaN）
    assert.equal(dim.smoothedRate, dim.baseline);
    assert.equal(dim.adjustedRate, dim.baseline);
    assert.equal(dim.delta, 0);
    assert.equal(dim.factor, 1, '无证据时调整系数必须恰为 1');
    assert.equal(dim.direction, TableDirection.NEUTRAL);
  }
  assert.match(d.summaryZh, /观察中/);
});

test('A2 旧格式记录（缺桌况字段）被排除，并被如实计数披露', () => {
  const records = [
    rec({ hand: 1, player: 'p1', seat: 'seat_UTG', action: 'FOLD', legacy: true }),
    rec({ hand: 2, player: 'p1', seat: 'seat_UTG', action: 'FOLD', legacy: true }),
    rec({ hand: 3, player: 'p1', seat: 'seat_UTG', action: 'FOLD' }),
  ];
  const d = computeTableDynamics({
    records,
    presentPlayerIds: ['p1'],
    heroPlayerId: null,
  });
  assert.equal(d.recordsUsed, 1, '只有 1 条可用');
  assert.equal(d.excluded.missingLegacyFields, 2, '2 条旧格式必须被计数');
  assert.match(d.noteZh, /旧格式缺桌况字段 2 条/);
});

test('A3 1 手样本 ⇒ 可信度极低，方向被压在 NEUTRAL 附近（不得给出强调整）', () => {
  const records = [rec({ hand: 1, player: 'p1', seat: 'seat_UTG', action: 'FOLD', activeCount: 6 })];
  const d = computeTableDynamics({ records, presentPlayerIds: ['p1'], heroPlayerId: null });
  const loose = dimsOf(d, TableDimensionId.TABLE_LOOSENESS);
  assert.equal(loose.opportunities, 1);
  assert.ok(loose.confidence < 0.1, `1 手机会的可信度必须 < 0.1，实测 ${loose.confidence}`);
  assert.ok(
    Math.abs(loose.delta) < 0.12,
    `收缩后偏离必须很小，实测 delta=${loose.delta}`,
  );
  assert.equal(d.tableConfidence < TABLE_DYNAMICS_CONFIG.minConfidenceForAdjustment, true);
  assert.equal(d.observing, true);
});

/* ============================================================
 * B. 机会数 ≠ 动作次数（分母由牌局状态决定）
 * ============================================================ */

test('B1 同样「弃牌 2 次」，机会数不同 ⇒ 收缩后比率不同（分母不是动作次数）', () => {
  /*
   * 场景甲：他 10 次面对下注全弃（大样本）。
   * 场景乙：他只有 2 次面对下注、都弃（小样本）。
   * 两者的「弃牌次数」都是 2（乙）vs 10（甲），但关键是：
   * 场景丙：他 10 次面对下注里弃 2 次（= 动作次数 2，机会 10）。
   * 我们要证明的是：**机会数进分母**，所以丙的比率远低于乙。
   */
  const make = (foldCount: number, oppCount: number) => {
    const records: ObservationRecord[] = [];
    for (let i = 0; i < oppCount; i++) {
      records.push(
        rec({
          hand: i + 1,
          player: 'p1',
          seat: 'seat_BTN',
          street: 'RIVER',
          action: i < foldCount ? 'FOLD' : 'CALL',
          /* 满池下注 ⇒ 需跟 50% ⇒ 落 LARGE 桶（桶边界见 BET_SIZE_BUCKETS） */
          toCallBB: 20,
          potBB: 20,
          activeCount: 2,
        }),
      );
    }
    return computeTableDynamics({ records, presentPlayerIds: ['p1'], heroPlayerId: null });
  };

  const small = dimsOf(make(2, 2), TableDimensionId.TABLE_FOLD_VS_LARGE);
  const large = dimsOf(make(2, 10), TableDimensionId.TABLE_FOLD_VS_LARGE);

  assert.equal(small.opportunities, 2);
  assert.equal(small.successes, 2);
  assert.equal(large.opportunities, 10);
  assert.equal(large.successes, 2);
  assert.ok(
    small.adjustedRate > large.adjustedRate,
    `同样弃 2 次，小样本(2/2=${small.adjustedRate}) 必须高于大样本(2/10=${large.adjustedRate})`,
  );
  assert.ok(large.adjustedRate < TABLE_BASELINES.TABLE_FOLD_VS_LARGE + 0.05);
});

test('B2 从未主动入池的玩家仍在入池分母里（机会由状态定义）', () => {
  /* 6 手都弃牌 ⇒ 机会 6、命中 0，而不是「没有机会」 */
  const records: ObservationRecord[] = [];
  for (let i = 0; i < 6; i++) {
    records.push(rec({ hand: i + 1, player: 'p1', seat: 'seat_UTG', action: 'FOLD', activeCount: 6 }));
  }
  const d = computeTableDynamics({ records, presentPlayerIds: ['p1'], heroPlayerId: null });
  const loose = dimsOf(d, TableDimensionId.TABLE_LOOSENESS);
  assert.equal(loose.opportunities, 6, '弃牌也是「面对入池机会」');
  assert.equal(loose.successes, 0);
  /* 6 次机会：符号正确，但可信度不到方向门槛 ⇒ 不下方向结论 */
  assert.ok(loose.adjustedRate < TABLE_BASELINES.TABLE_LOOSENESS);
  assert.ok(loose.delta < 0);
  assert.equal(loose.direction, TableDirection.NEUTRAL);
  assert.ok(loose.confidence < TABLE_DYNAMICS_CONFIG.minDirectionalConfidence);

  /* 同样「从不入池」但样本足够（40 手）⇒ 方向必须出现 */
  const many: ObservationRecord[] = [];
  for (let i = 0; i < 40; i++) {
    many.push(rec({ hand: i + 1, player: 'p1', seat: 'seat_UTG', action: 'FOLD', activeCount: 6 }));
  }
  const d2 = computeTableDynamics({ records: many, presentPlayerIds: ['p1'], heroPlayerId: null });
  const loose2 = dimsOf(d2, TableDimensionId.TABLE_LOOSENESS);
  assert.equal(loose2.opportunities, 40);
  assert.equal(loose2.successes, 0);
  assert.equal(loose2.direction, TableDirection.LOWER);
  assert.ok(loose2.confidence >= TABLE_DYNAMICS_CONFIG.minDirectionalConfidence);
});

test('B3 面对下注按尺寸分桶：小注/大注分开统计，不合并成一个数', () => {
  /*
   * 小注（⅓ 池 ⇒ 需跟 25%）全跟；大注（满池 ⇒ 需跟 50%）全弃。
   * 桶边界与「不合并」是本组的主断言；方向门槛另用大样本组验证（B4）。
   */
  const build = (n: number) => {
    const records: ObservationRecord[] = [];
    for (let i = 0; i < n; i++) {
      records.push(
        rec({
          hand: i + 1,
          player: 'p1',
          seat: 'seat_BTN',
          street: 'RIVER',
          action: 'CALL',
          toCallBB: 10,
          potBB: 30, // ratio = 10/40 = 0.25 ⇒ SMALL
        }),
      );
    }
    for (let i = 0; i < n; i++) {
      records.push(
        rec({
          hand: i + 1000,
          player: 'p1',
          seat: 'seat_BTN',
          street: 'RIVER',
          action: 'FOLD',
          toCallBB: 20,
          potBB: 20, // ratio = 20/40 = 0.5 ⇒ LARGE
        }),
      );
    }
    return computeTableDynamics({ records, presentPlayerIds: ['p1'], heroPlayerId: null });
  };

  const d = build(5);
  const small = dimsOf(d, TableDimensionId.TABLE_FOLD_VS_SMALL);
  const large = dimsOf(d, TableDimensionId.TABLE_FOLD_VS_LARGE);
  assert.equal(small.opportunities, 5);
  assert.equal(small.successes, 0);
  assert.equal(large.opportunities, 5);
  assert.equal(large.successes, 5);
  /* 两个桶各自独立统计 —— 没有「合并成一个数」 */
  assert.notEqual(small.adjustedRate, large.adjustedRate);
  /* 中注桶确实没有机会（本例没有中注） */
  assert.equal(dimsOf(d, TableDimensionId.TABLE_FOLD_VS_MEDIUM).opportunities, 0);

  /*
   * ⚠️ 方向是**双重门槛**的：`|delta| > 0.02` **且** 可信度 ≥ 0.25。
   * 5 次机会的可信度只有约 0.16 ⇒ 必须如实报 NEUTRAL，
   * 不允许在 5 次观察上说「对手面对小注不弃牌」。
   */
  assert.equal(small.direction, TableDirection.NEUTRAL, '5 次机会不得给出方向结论');
  assert.ok(small.delta < 0, '但偏离的**符号**必须是正确的（确实低于基线）');
  assert.ok(
    small.confidence < TABLE_DYNAMICS_CONFIG.minDirectionalConfidence,
    `5 次机会的可信度必须低于方向门槛，实测 ${small.confidence}`,
  );
  assert.match(small.noteZh, /证据不足，不下方向结论/);
  assert.ok(small.confidence < TABLE_DYNAMICS_CONFIG.minConfidenceForAdjustment);

  /* 桶边界本身 */
  assert.equal(betSizeBucketOf(0.25), 'SMALL');
  assert.equal(betSizeBucketOf(BET_SIZE_BUCKETS.small), 'SMALL');
  assert.equal(betSizeBucketOf(0.35), 'MEDIUM');
  assert.equal(betSizeBucketOf(BET_SIZE_BUCKETS.medium), 'MEDIUM');
  assert.equal(betSizeBucketOf(0.5), 'LARGE');
  assert.equal(betSizeBucketOf(0), null, '没面对下注 ⇒ 不属于任何桶（不是 SMALL）');
  assert.equal(betSizeBucketOf(null), null);
});

test('B4 证据足够时方向确实出现（B3 的对照：同样观测、40 次机会）', () => {
  /*
   * ⚠️ 两个桶的**年龄分布必须一致**，否则「方向」会被「谁更新」混淆。
   * 因此 hand 号交错：小注用偶数手、大注用奇数手 ⇒ 两者跨度相同。
   */
  const records: ObservationRecord[] = [];
  for (let i = 0; i < 40; i++) {
    records.push(
      rec({ hand: 2 * i + 1, player: 'p1', seat: 'seat_BTN', street: 'RIVER', action: 'CALL', toCallBB: 10, potBB: 30 }),
    );
    records.push(
      rec({ hand: 2 * i + 2, player: 'p1', seat: 'seat_BTN', street: 'RIVER', action: 'FOLD', toCallBB: 20, potBB: 20 }),
    );
  }
  const d = computeTableDynamics({ records, presentPlayerIds: ['p1'], heroPlayerId: null });
  const small = dimsOf(d, TableDimensionId.TABLE_FOLD_VS_SMALL);
  const large = dimsOf(d, TableDimensionId.TABLE_FOLD_VS_LARGE);
  assert.equal(small.opportunities, 40);
  assert.equal(large.opportunities, 40);
  /* 年龄分布一致 ⇒ 有效样本量应当接近（交错后仍有 1 手左右的相位差） */
  assert.ok(
    Math.abs(small.effectiveSample - large.effectiveSample) < 0.5,
    `两桶年龄交错后有效样本应接近：${small.effectiveSample} vs ${large.effectiveSample}`,
  );
  assert.equal(small.direction, TableDirection.LOWER);
  assert.equal(large.direction, TableDirection.HIGHER);
  assert.ok(
    small.confidence >= TABLE_DYNAMICS_CONFIG.minConfidenceForAdjustment,
    `40 次机会必须达到可调整门槛，实测 ${small.confidence}`,
  );
  assert.ok(large.confidence >= TABLE_DYNAMICS_CONFIG.minConfidenceForAdjustment);
  assert.ok(Math.abs(small.delta) > 0.02);
});

/* ============================================================
 * C. 少量连续加注不得产生极端调整
 * ============================================================ */

test('C1 连续 3 次 3Bet 不足以认定「疯子」，系数远小于上限', () => {
  /*
   * 每手都要有**开池者**的记录，否则「面对加注」这个状态不成立，
   * 3Bet 会被算成「无人加注时的主动入池」—— 机会数会变成 0。
   * 这也顺带验证「机会由牌局状态定义」：p1 的记录只有在同手存在开池时才进分母。
   */
  const records: ObservationRecord[] = [];
  for (let i = 0; i < 3; i++) {
    records.push(
      rec({
        hand: i + 1,
        player: 'pOpener',
        seat: 'seat_CO',
        action: 'RAISE',
        amountBB: 2.5,
        toCallBB: 1,
        potBB: 1.5,
      }),
    );
    records.push(
      rec({
        hand: i + 1,
        player: 'p1',
        seat: 'seat_BTN',
        action: 'RAISE',
        amountBB: 9,
        toCallBB: 2.5,
        potBB: 4,
      }),
    );
  }
  const d = computeTableDynamics({
    records,
    presentPlayerIds: ['pOpener', 'p1'],
    heroPlayerId: null,
  });
  const reraise = dimsOf(d, TableDimensionId.TABLE_RERAISE_PRESSURE);
  assert.equal(reraise.opportunities, 3);
  assert.equal(reraise.successes, 3);
  /* 3 次全 3Bet：符号是 HIGHER 的（delta > 0），但**不下方向结论** */
  assert.ok(reraise.delta > 0, '观测方向必须如实反映（确实高于基线）');
  assert.equal(reraise.direction, TableDirection.NEUTRAL, '3 次机会不得宣称「再加注压力高」');
  assert.match(reraise.noteZh, /证据不足，不下方向结论/);
  const maxDelta = TABLE_DYNAMICS_CONFIG.maxFactorDelta;
  assert.ok(
    Math.abs(reraise.factor - 1) < maxDelta,
    `3 次样本的系数必须严格小于上限 ±${maxDelta}，实测 ${reraise.factor}`,
  );
  /* 且可信度未达到「可调整」门槛 */
  assert.ok(reraise.confidence < TABLE_DYNAMICS_CONFIG.minConfidenceForAdjustment);

  /* 计划层：THREEBET 必须是 OBSERVING，且系数为 1 */
  const plan = buildTableAdjustmentPlan(d, baseCtx({ relevantPlayerIds: ['p1'] }));
  const threebet = plan.adjustments.find((a) => a.category === 'THREEBET')!;
  assert.equal(threebet.status, 'OBSERVING');
  assert.equal(threebet.factor, 1, '证据不足时不得调整');
  assert.equal(reraise.factor !== 1, true, '维度层仍如实记录方向（只是不用于调整）');
});

test('C2 调整系数永远落在 ±maxFactorDelta 之内（极端观测也不越界）', () => {
  /* 200 次机会、100% 命中 —— 最强的观测 */
  const records: ObservationRecord[] = [];
  for (let i = 0; i < 200; i++) {
    records.push(
      rec({
        hand: i + 1,
        player: 'p1',
        seat: 'seat_BTN',
        action: 'RAISE',
        amountBB: 9,
        toCallBB: 2.5,
        potBB: 4,
      }),
    );
  }
  const d = computeTableDynamics({ records, presentPlayerIds: ['p1'], heroPlayerId: null });
  for (const dim of d.layers.table) {
    assert.ok(
      dim.factor >= 1 - TABLE_DYNAMICS_CONFIG.maxFactorDelta - 1e-9 &&
        dim.factor <= 1 + TABLE_DYNAMICS_CONFIG.maxFactorDelta + 1e-9,
      `${dim.id} 系数越界：${dim.factor}`,
    );
  }
});

/* ============================================================
 * D. 个体优先：整桌偏松不得覆盖一个其实很紧的对手
 * ============================================================ */

test('D1 整桌极松，但当前对手个体很紧（证据充分）⇒ 用个体判断，不用整桌', () => {
  const records: ObservationRecord[] = [];
  /* 4 个「松」对手：各 30 手都入池 */
  for (const pid of ['pL1', 'pL2', 'pL3', 'pL4']) {
    for (let i = 0; i < 30; i++) {
      records.push(
        rec({ hand: i + 1, player: pid, seat: `seat_${pid}`, action: 'CALL', amountBB: 1, activeCount: 6 }),
      );
    }
  }
  /* 1 个「紧」对手：30 手全弃 */
  for (let i = 0; i < 30; i++) {
    records.push(rec({ hand: i + 1, player: 'pTight', seat: 'seat_UTG', action: 'FOLD', activeCount: 6 }));
  }

  const d = computeTableDynamics({
    records,
    presentPlayerIds: ['pL1', 'pL2', 'pL3', 'pL4', 'pTight'],
    heroPlayerId: null,
    relevantPlayerIds: ['pTight'],
  });

  /* 整桌确实偏松 */
  const tableLoose = dimsOf(d, TableDimensionId.TABLE_LOOSENESS);
  assert.equal(tableLoose.direction, TableDirection.HIGHER);

  /* 个体维度确实偏紧 */
  const ind = d.layers.relevantByPlayer['pTight']!.find((x) => x.id === TableDimensionId.TABLE_LOOSENESS)!;
  assert.equal(ind.direction, TableDirection.LOWER);
  assert.ok(ind.confidence >= TABLE_DYNAMICS_CONFIG.minConfidenceForAdjustment);

  const plan = buildTableAdjustmentPlan(d, baseCtx({ relevantPlayerIds: ['pTight'] }));
  const profile = plan.opponentProfiles.find((p) => p.playerId === 'pTight')!;
  assert.equal(profile.source, 'INDIVIDUAL', '个体证据充分时必须用个体');
  /*
   * 🔴 **第二轮修正后的契约**：紧的对手不能因为整桌偏松而被带松。
   *
   * 由于所有非中立标签都会改动 `bluffTendency`（无证据支持的维度），
   * 标签一律被拒 ⇒ `quickProfile` 回落 `NORMAL`。
   * 真正表达「他偏紧」的是 **`scopedDimensions.tightness`**：
   * 紧 ⇒ `tightness > 0.5`（必须由**个体**证据决定，不被整桌带松）。
   */
  assert.equal(profile.quickProfile, 'NORMAL', '标签被拒后回落中立');
  assert.equal(profile.injectable, false);
  assert.equal(profile.axes.looseness.direction, TableDirection.LOWER, '松紧轴必须偏紧');
  assert.ok(
    profile.scopedDimensions.tightness !== null,
    '紧的个体证据必须产出 tightness 调整',
  );
  assert.ok(
    profile.scopedDimensions.tightness! > 0.5,
    `紧的对手 tightness 必须高于中立，实测 ${profile.scopedDimensions.tightness}`,
  );
  /* 诈唬倾向必须保持中立（不注入） */
  assert.equal(profile.scopedDimensions.bluffTendency, null);
  assert.equal(profile.fallbackReasonZh, null);
});

test('D2 个体证据不足 ⇒ 有限参考整桌，并如实标注不确定性与回退原因', () => {
  const records: ObservationRecord[] = [];
  /* 个体只有 2 手（可信度 2/(2+25) ≈ 0.074 < 门槛 0.35），整桌有 120 手 */
  for (const pid of ['pBig1', 'pBig2', 'pBig3']) {
    for (let i = 0; i < 40; i++) {
      records.push(rec({ hand: i + 1, player: pid, seat: `seat_${pid}`, action: 'FOLD', activeCount: 6 }));
    }
  }
  for (let i = 0; i < 2; i++) {
    records.push(rec({ hand: i + 1, player: 'pThin', seat: 'seat_CO', action: 'CALL', amountBB: 2, activeCount: 6 }));
  }

  const d = computeTableDynamics({
    records,
    presentPlayerIds: ['pBig1', 'pBig2', 'pBig3', 'pThin'],
    heroPlayerId: null,
    relevantPlayerIds: ['pThin'],
  });

  /* 整桌证据充分（120 手），个体证据不足（2 手） */
  assert.ok(d.tableConfidence >= TABLE_DYNAMICS_CONFIG.minConfidenceForAdjustment);
  const individual = d.layers.relevantByPlayer['pThin']!.find(
    (x) => x.id === TableDimensionId.TABLE_LOOSENESS,
  )!;
  assert.ok(
    individual.confidence < TABLE_DYNAMICS_CONFIG.minConfidenceForAdjustment,
    `个体可信度必须低于门槛，实测 ${individual.confidence}`,
  );

  const plan = buildTableAdjustmentPlan(d, baseCtx({ relevantPlayerIds: ['pThin'] }));
  const p = plan.opponentProfiles.find((x) => x.playerId === 'pThin')!;
  assert.equal(p.source, 'TABLE_FALLBACK');
  assert.ok(p.fallbackReasonZh !== null, '回退到整桌时必须给出原因');
  assert.match(p.fallbackReasonZh!, /个体证据不足/);
  assert.match(p.fallbackReasonZh!, /有限参考整桌/);
  assert.match(p.fallbackReasonZh!, /不确定性较高/);
});

/* ============================================================
 * E. 离桌玩家不得继续主导桌况
 * ============================================================ */

test('E1 离桌玩家的历史被排除，并如实计数；其在桌时确实参与统计', () => {
  const records: ObservationRecord[] = [];
  for (let i = 0; i < 40; i++) {
    records.push(rec({ hand: i + 1, player: 'pGone', seat: 'seat_UTG', action: 'RAISE', amountBB: 3 }));
  }
  records.push(rec({ hand: 41, player: 'pStay', seat: 'seat_CO', action: 'FOLD', activeCount: 6 }));

  const withGone = computeTableDynamics({
    records,
    presentPlayerIds: ['pGone', 'pStay'],
    heroPlayerId: null,
  });
  const withoutGone = computeTableDynamics({
    records,
    presentPlayerIds: ['pStay'],
    heroPlayerId: null,
  });

  assert.ok(dimsOf(withGone, TableDimensionId.TABLE_LOOSENESS).opportunities > 1);
  assert.equal(withoutGone.excluded.notPresent, 40, '离桌玩家的 40 条必须被排除并计数');
  assert.equal(withoutGone.recordsUsed, 1);
  assert.ok(
    dimsOf(withoutGone, TableDimensionId.TABLE_LOOSENESS).effectiveSample <
      dimsOf(withGone, TableDimensionId.TABLE_LOOSENESS).effectiveSample,
  );
});

/* ============================================================
 * F. 不重复计权
 * ============================================================ */

test('F1 Hero 自己的行为不进桌况（避免自我剥削）', () => {
  const records: ObservationRecord[] = [];
  for (let i = 0; i < 20; i++) {
    records.push(rec({ hand: i + 1, player: 'hero', seat: 'seat_BTN', action: 'RAISE', amountBB: 3 }));
  }
  const d = computeTableDynamics({
    records,
    presentPlayerIds: ['hero'],
    heroPlayerId: 'hero',
  });
  assert.equal(d.recordsUsed, 0);
  assert.equal(d.excluded.heroSelf, 20);
  assert.equal(d.tableConfidence, 0);
});

test('F2 分层是「同一次观察的不同窗口」，不得跨层求和（层内机会数各有上限）', () => {
  const records: ObservationRecord[] = [];
  for (let i = 0; i < 100; i++) {
    records.push(rec({ hand: i + 1, player: 'p1', seat: 'seat_UTG', action: 'FOLD', activeCount: 6 }));
  }
  const d = computeTableDynamics({
    records,
    presentPlayerIds: ['p1'],
    heroPlayerId: null,
    relevantPlayerIds: ['p1'],
  });
  const longTerm = d.layers.longTermByPlayer['p1']!.find((x) => x.id === TableDimensionId.TABLE_LOOSENESS)!;
  const recent = d.layers.recentByPlayer['p1']!.find((x) => x.id === TableDimensionId.TABLE_LOOSENESS)!;

  assert.equal(longTerm.opportunities, 100, '长期层用全部历史');
  assert.ok(
    recent.opportunities <= TABLE_DYNAMICS_CONFIG.recentHands,
    `本场近期层不得超过窗口 ${TABLE_DYNAMICS_CONFIG.recentHands}，实测 ${recent.opportunities}`,
  );
  /* 两层各自是完整证据，不是一半 */
  assert.equal(recent.opportunities, TABLE_DYNAMICS_CONFIG.recentHands);
});

test('F3 每个维度各自带机会数与可信度（不允许只有一个笼统置信度）', () => {
  const records = [
    rec({ hand: 1, player: 'p1', seat: 'seat_BTN', street: 'RIVER', action: 'FOLD', toCallBB: 20, potBB: 20 }),
  ];
  const d = computeTableDynamics({ records, presentPlayerIds: ['p1'], heroPlayerId: null });
  for (const dim of d.layers.table) {
    assert.equal(typeof dim.opportunities, 'number');
    assert.equal(typeof dim.successes, 'number');
    assert.equal(typeof dim.confidence, 'number');
    assert.equal(typeof dim.baseline, 'number');
    assert.equal(typeof dim.noteZh, 'string');
    assert.ok(dim.baselineProvenance.length > 0, '每个维度都必须声明基线来源');
  }
  /* 有证据的维度与没证据的维度必须能区分开 */
  assert.equal(dimsOf(d, TableDimensionId.TABLE_FOLD_VS_LARGE).opportunities, 1);
  assert.equal(dimsOf(d, TableDimensionId.TABLE_CBET).opportunities, 0);
});

/* ============================================================
 * G. 不读未来信息
 * ============================================================ */

test('G1 维度只由「行动前的状态字段」决定：篡改同手后续行动不改变该条记录的机会判定', () => {
  const base = rec({
    hand: 1,
    player: 'p1',
    seat: 'seat_BTN',
    street: 'RIVER',
    action: 'CALL',
    toCallBB: 20,
    potBB: 20,
    activeCount: 2,
  });
  const d1 = computeTableDynamics({ records: [base], presentPlayerIds: ['p1'], heroPlayerId: null });

  /* 追加「同一手后续发生的事情」—— 维度不应因此改变 */
  const later = rec({
    hand: 1,
    player: 'p2',
    seat: 'seat_CO',
    street: 'RIVER',
    action: 'RAISE',
    amountBB: 60,
    toCallBB: 0,
    potBB: 60,
    activeCount: 2,
  });
  const d2 = computeTableDynamics({
    records: [base, later],
    presentPlayerIds: ['p1', 'p2'],
    heroPlayerId: null,
  });

  const f1 = dimsOf(d1, TableDimensionId.TABLE_FOLD_VS_LARGE);
  const f2 = dimsOf(d2, TableDimensionId.TABLE_FOLD_VS_LARGE);
  assert.equal(f1.opportunities, f2.opportunities);
  assert.equal(f1.successes, f2.successes);
  assert.equal(f1.adjustedRate, f2.adjustedRate);
});

test('G2 记录形状里不存在「摊牌结果」类字段（未亮牌不得被当成诈唬证据）', () => {
  const r = rec({ hand: 1, player: 'p1', seat: 'seat_BTN', action: 'RAISE' });
  const keys = Object.keys(r);
  for (const banned of ['winner', 'won', 'profit', 'result', 'showdown', 'revealed', 'holeCards']) {
    assert.equal(keys.includes(banned), false, `记录里不得有 ${banned} 字段`);
  }
});

/* ============================================================
 * H. 单挑 / 多人边界
 * ============================================================ */

test('H1 单挑：开池与冷跟两类调整显式 NOT_APPLICABLE，不套用整桌平均', () => {
  const records: ObservationRecord[] = [];
  for (let i = 0; i < 60; i++) {
    records.push(rec({ hand: i + 1, player: 'p1', seat: 'seat_BB', action: 'FOLD', activeCount: 2 }));
  }
  const d = computeTableDynamics({ records, presentPlayerIds: ['p1'], heroPlayerId: null });
  const plan = buildTableAdjustmentPlan(d, baseCtx({ activeCount: 2, playersYetToAct: 1, relevantPlayerIds: ['p1'] }));
  const open = plan.adjustments.find((a) => a.category === 'OPEN')!;
  const cold = plan.adjustments.find((a) => a.category === 'COLD_CALL')!;
  assert.equal(open.status, 'NOT_APPLICABLE');
  assert.equal(cold.status, 'NOT_APPLICABLE');
  assert.match(open.reasonZh, /单挑/);
  assert.ok(open.unsupportedReasonZh !== null);
  assert.equal(open.factor, 1, '不适用时系数必须是 1（不是「随便调一点」）');
});

test('H2 身后无人 ⇒ 开池调整不适用（没有人可以被弃牌剥削）', () => {
  const records: ObservationRecord[] = [];
  for (let i = 0; i < 60; i++) {
    records.push(rec({ hand: i + 1, player: 'p1', seat: 'seat_BB', action: 'FOLD', activeCount: 6 }));
  }
  const d = computeTableDynamics({ records, presentPlayerIds: ['p1'], heroPlayerId: null });
  const plan = buildTableAdjustmentPlan(d, baseCtx({ playersYetToAct: 0 }));
  const open = plan.adjustments.find((a) => a.category === 'OPEN')!;
  assert.equal(open.status, 'NOT_APPLICABLE');
  assert.match(open.reasonZh, /身后没有未行动/);
});

test('H3 五类调整各自独立生成，不存在「统一松紧乘数」', () => {
  const records: ObservationRecord[] = [];
  for (let i = 0; i < 80; i++) {
    records.push(rec({ hand: i + 1, player: 'p1', seat: 'seat_BB', action: 'FOLD', toCallBB: 2.5, potBB: 4 }));
  }
  const d = computeTableDynamics({ records, presentPlayerIds: ['p1'], heroPlayerId: null });
  const plan = buildTableAdjustmentPlan(d, baseCtx({ relevantPlayerIds: ['p1'] }));
  assert.equal(plan.adjustments.length, 5);
  assert.deepEqual(
    plan.adjustments.map((a) => a.category),
    ['OPEN', 'COLD_CALL', 'THREEBET', 'VALUE_BET', 'BLUFF'],
  );
  /* 每个类别有自己的证据与作用对象，不是同一个乘数复制五份 */
  for (const a of plan.adjustments) {
    assert.ok(a.appliesTo.length > 0);
    assert.ok(a.labelZh.length > 0);
  }
});

/* ============================================================
 * I. 缓存隔离（摘要随桌况变化）
 * ============================================================ */

test('I1 桌况变化 ⇒ 摘要变化；桌况相同 ⇒ 摘要相同', () => {
  const mk = (extra: number): string => {
    const records: ObservationRecord[] = [];
    for (let i = 0; i < 20 + extra; i++) {
      records.push(rec({ hand: i + 1, player: 'p1', seat: 'seat_BB', action: 'FOLD', toCallBB: 2.5, potBB: 4 }));
    }
    const d = computeTableDynamics({ records, presentPlayerIds: ['p1'], heroPlayerId: null });
    const plan = buildTableAdjustmentPlan(d, baseCtx({ relevantPlayerIds: ['p1'] }));
    return computeTableDynamicsDigest(d, plan);
  };
  assert.equal(mk(0), mk(0), '同一输入必须得到同一摘要');
  assert.notEqual(mk(0), mk(5), '桌况变化必须改变摘要（否则旧缓存会被误用）');
});

test('I2 摘要不含耗时/时间戳（否则「同一输入」会产生不同键）', () => {
  const records = [
    rec({ hand: 1, player: 'p1', seat: 'seat_BB', action: 'FOLD', toCallBB: 2.5, potBB: 4 }),
  ];
  const d = computeTableDynamics({ records, presentPlayerIds: ['p1'], heroPlayerId: null });
  const plan = buildTableAdjustmentPlan(d, baseCtx({ relevantPlayerIds: ['p1'] }));
  const a = computeTableDynamicsDigest(d, plan);
  const b = computeTableDynamicsDigest({ ...d }, plan);
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{8}$/);
});

test('I3 哈希函数是确定性的（同输入同输出，不同输入不同输出）', () => {
  assert.equal(stableHash32('abc'), stableHash32('abc'));
  assert.notEqual(stableHash32('abc'), stableHash32('abd'));
});

/* ============================================================
 * J. 影子模式契约
 * ============================================================ */

const fakeAnalyze =
  (calls: string[]): ((input: unknown) => ShadowAnalyzeResult<ShadowDecisionView>) =>
  (input) => {
    const seatProfiles = (input as { seatProfiles?: Record<string, string> }).seatProfiles ?? {};
    calls.push(JSON.stringify(seatProfiles));
    const adjusted = Object.keys(seatProfiles).length > 0;
    return {
      ok: true,
      decision: {
        action: adjusted ? 'BET' : 'CHECK',
        sizeChips: adjusted ? 650 : null,
        confidence: 0.3,
        band: 'MEDIUM_LOW',
        classification: 'MARGINAL',
        actionable: true,
      },
    };
  };

const looseRecords = (): ObservationRecord[] => {
  const records: ObservationRecord[] = [];
  for (let i = 0; i < 120; i++) {
    records.push(
      rec({
        hand: i + 1,
        player: 'p1',
        seat: 'seat_CO',
        action: 'CALL',
        amountBB: 2.5,
        toCallBB: 2.5,
        potBB: 4,
        activeCount: 6,
      }),
    );
  }
  return records;
};

test('J1 影子模式：正式建议先算、且不被调整覆盖', () => {
  const calls: string[] = [];
  const input = { seatProfiles: {} as Record<string, string>, marker: 'hero-hand' };
  const result = runTableDynamicsShadow({
    input,
    analyze: fakeAnalyze(calls),
    inject: (inp, plan) => {
      const next = { ...(inp as Record<string, unknown>) };
      const sp: Record<string, string> = {};
      for (const p of plan.opponentProfiles) {
        sp[p.playerId] = p.quickProfile;
        next['seatProfiles'] = sp;
      }
      return { input: next as typeof input, changes: ['seatProfiles[p1]'] };
    },
    records: looseRecords(),
    presentPlayerIds: ['p1'],
    heroPlayerId: 'hero',
    relevantPlayerIds: ['p1'],
    activeCount: 6,
    street: 'PREFLOP',
    playersYetToAct: 3,
  });

  assert.equal(result.status, 'COMPUTED');
  assert.equal(result.base.ok, true);
  assert.equal(result.adjusted?.ok, true);
  /* 正式建议必须是**未调整**的那一份 */
  assert.deepEqual(result.base, {
    ok: true,
    decision: {
      action: 'CHECK',
      sizeChips: null,
      confidence: 0.3,
      band: 'MEDIUM_LOW',
      classification: 'MARGINAL',
      actionable: true,
    },
  });
  /* 原始输入对象不得被修改 */
  assert.deepEqual(input.seatProfiles, {});
  assert.equal(input.marker, 'hero-hand');
});

test('J2 影子模式 OFF ⇒ 不计算桌况、不调用注入、不第二次分析', () => {
  const calls: string[] = [];
  const result = runTableDynamicsShadow({
    input: { seatProfiles: {} },
    analyze: fakeAnalyze(calls),
    inject: () => {
      throw new Error('OFF 模式下**不得**调用 inject');
    },
    records: looseRecords(),
    presentPlayerIds: ['p1'],
    heroPlayerId: 'hero',
    relevantPlayerIds: ['p1'],
    activeCount: 6,
    street: 'PREFLOP',
    playersYetToAct: 3,
    mode: TableDynamicsMode.OFF,
  });
  assert.equal(result.status, 'SKIPPED');
  assert.equal(result.dynamics, null);
  assert.equal(result.adjusted, null);
  assert.equal(calls.length, 1, 'OFF 模式只允许调用一次（正式建议）');
});

test('J3 桌况层抛异常 ⇒ 收敛为 FAILED，正式建议照常返回（不向上传播）', () => {
  /*
   * 构造一条**能通过玩家过滤、但读取 handId 就抛**的记录：
   * `computeTableDynamics` 里第一次触碰 handId 是在算「本桌 id」时。
   * 这模拟的是「历史记录损坏」这一真实形态。
   */
  const badRecord = { playerId: 'p1', potBB: 1.5 } as Record<string, unknown>;
  Object.defineProperty(badRecord, 'handId', {
    enumerable: true,
    get(): string {
      throw new Error('模拟损坏记录');
    },
  });

  const result = runTableDynamicsShadow({
    input: { seatProfiles: {} },
    analyze: () => ({
      ok: true,
      decision: {
        action: 'FOLD',
        sizeChips: null,
        confidence: 0.3,
        band: 'MEDIUM_LOW',
        classification: 'MARGINAL',
        actionable: true,
      },
    }),
    inject: () => {
      throw new Error('不应到达');
    },
    records: [badRecord as unknown as ObservationRecord],
    presentPlayerIds: ['p1'],
    heroPlayerId: 'hero',
    relevantPlayerIds: ['p1'],
    activeCount: 6,
    street: 'PREFLOP',
    playersYetToAct: 3,
  });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.base.ok, true, '正式建议必须仍然可用');
  assert.match(result.reasonZh!, /正式建议不受影响/);
  assert.equal(result.adjusted, null);
});

test('J4 调整后重算抛异常 ⇒ 收敛为 FAILED，正式建议不受影响', () => {
  let n = 0;
  const result = runTableDynamicsShadow({
    input: { seatProfiles: {} },
    analyze: () => {
      n += 1;
      if (n === 1) {
        return {
          ok: true,
          decision: {
            action: 'CHECK',
            sizeChips: null,
            confidence: 0.3,
            band: 'MEDIUM_LOW',
            classification: 'MARGINAL',
            actionable: true,
          },
        };
      }
      throw new Error('第二次分析崩了');
    },
    inject: (inp, plan) => ({
      input: { ...(inp as object), seatProfiles: { [plan.opponentProfiles[0]!.playerId]: 'LOOSE' } } as never,
      changes: ['seatProfiles[p1]'],
    }),
    records: looseRecords(),
    presentPlayerIds: ['p1'],
    heroPlayerId: 'hero',
    relevantPlayerIds: ['p1'],
    activeCount: 6,
    street: 'PREFLOP',
    playersYetToAct: 3,
  });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.base.ok, true);
  assert.match(result.reasonZh!, /正式建议不受影响/);
});

test('J5 预算超时 ⇒ TIMEOUT，不重算建议，但桌况仍然给出（且**如实标记未做真实隔离**）', () => {
  const result = runTableDynamicsShadow({
    input: { seatProfiles: {} },
    analyze: fakeAnalyze([]),
    inject: (inp) => ({ input: inp, changes: ['x'] }),
    records: looseRecords(),
    presentPlayerIds: ['p1'],
    heroPlayerId: 'hero',
    relevantPlayerIds: ['p1'],
    activeCount: 6,
    street: 'PREFLOP',
    playersYetToAct: 3,
    budgetMs: -1, // 必然超时
  });
  assert.equal(result.status, 'TIMEOUT');
  assert.equal(result.adjusted, null);
  assert.ok(result.dynamics !== null, '超时也要给出桌况');
  assert.match(result.reasonZh!, /预算/);
  /*
   * 🔴 未提供 `withBudget` ⇒ **必须如实承认没有真实隔离**。
   * 「只计时」不算隔离（授权 §五）—— 同步分析已经跑完并占用了线程。
   */
  assert.equal(result.budgetInjected, false, '未注入预算时必须标记 false');
  assert.match(result.reasonZh!, /未做真实隔离/);
});

test('J5b 提供 withBudget ⇒ 预算**注入到分析里**，且标记 budgetInjected=true', () => {
  const seen: number[] = [];
  const result = runTableDynamicsShadow({
    input: { seatProfiles: {} },
    analyze: fakeAnalyze([]),
    withBudget: (analyze, ms) => {
      seen.push(ms);
      return analyze;
    },
    inject: (inp, plan) => ({
      input: { ...(inp as object), seatProfiles: { [plan.opponentProfiles[0]!.playerId]: 'LOOSE' } } as never,
      changes: ['seatProfiles[p1]'],
    }),
    records: looseRecords(),
    presentPlayerIds: ['p1'],
    heroPlayerId: 'hero',
    relevantPlayerIds: ['p1'],
    activeCount: 6,
    street: 'PREFLOP',
    playersYetToAct: 3,
    budgetMs: 1234,
  });
  assert.equal(result.status, 'COMPUTED');
  assert.equal(result.budgetInjected, true, '提供了 withBudget 必须标记 true');
  assert.deepEqual(seen, [1234], '预算必须原样传给分析（这样分析才能自我中止）');
});

test('J5c 提供了 withBudget 时**不**走「事后计时」分支（避免重复判定超时）', () => {
  /*
   * 关键区别：注入预算后，超时应由**分析自己的 DecisionDeadline** 产生
   *（返回 stage='DEADLINE' 的结构化失败），而不是由外层计时宣布。
   * 因此即便外层已经超过 budgetMs，也不应再返回 TIMEOUT 状态 ——
   * 否则「假超时」会掩盖「分析其实跑完了」这个事实。
   */
  const result = runTableDynamicsShadow({
    input: { seatProfiles: {} },
    analyze: fakeAnalyze([]),
    withBudget: (analyze) => analyze,
    inject: (inp, plan) => ({
      input: { ...(inp as object), seatProfiles: { [plan.opponentProfiles[0]!.playerId]: 'LOOSE' } } as never,
      changes: ['seatProfiles[p1]'],
    }),
    records: looseRecords(),
    presentPlayerIds: ['p1'],
    heroPlayerId: 'hero',
    relevantPlayerIds: ['p1'],
    activeCount: 6,
    street: 'PREFLOP',
    playersYetToAct: 3,
    budgetMs: -1,
  });
  assert.notEqual(result.status, 'TIMEOUT', '注入预算后不应由外层宣布超时');
  assert.equal(result.status, 'COMPUTED');
  assert.equal(result.adjusted?.ok, true);
});

test('J6 证据不足（无记录）⇒ 不做调整、不调用第二次分析，理由如实说明', () => {
  const calls: string[] = [];
  const result = runTableDynamicsShadow({
    input: { seatProfiles: {} },
    analyze: fakeAnalyze(calls),
    inject: () => {
      throw new Error('不应注入');
    },
    records: [],
    presentPlayerIds: ['p1'],
    heroPlayerId: 'hero',
    relevantPlayerIds: ['p1'],
    activeCount: 6,
    street: 'PREFLOP',
    playersYetToAct: 3,
  });
  assert.equal(result.status, 'COMPUTED');
  assert.equal(result.adjusted, null);
  assert.equal(calls.length, 1);
  assert.equal(result.plan?.anySuggested, false);
  assert.match(result.reasonZh!, /观察中|门槛/);
});

test('J7 两次建议的对比是结构化的（不解析中文）', () => {
  const calls: string[] = [];
  const result = runTableDynamicsShadow({
    input: { seatProfiles: {} },
    analyze: fakeAnalyze(calls),
    inject: (inp, plan) => ({
      input: { ...(inp as object), seatProfiles: { [plan.opponentProfiles[0]!.playerId]: 'MANIAC' } } as never,
      changes: ['seatProfiles[p1]'],
    }),
    records: looseRecords(),
    presentPlayerIds: ['p1'],
    heroPlayerId: 'hero',
    relevantPlayerIds: ['p1'],
    activeCount: 6,
    street: 'PREFLOP',
    playersYetToAct: 3,
  });
  const diff = shadowChangedAction(result);
  assert.equal(diff.changed, true);
  assert.equal(diff.baseZh, 'CHECK');
  assert.equal(diff.adjustedZh, 'BET 650');
  assert.equal(result.sameCashflowContract, true);
});

test('J8 影子模式可重放：同一输入两次运行得到相同的摘要与结果', () => {
  const run = () =>
    runTableDynamicsShadow({
      input: { seatProfiles: {} },
      analyze: fakeAnalyze([]),
      inject: (inp, plan) => ({
        input: { ...(inp as object), seatProfiles: { [plan.opponentProfiles[0]!.playerId]: 'LOOSE' } } as never,
        changes: ['seatProfiles[p1]'],
      }),
      records: looseRecords(),
      presentPlayerIds: ['p1'],
      heroPlayerId: 'hero',
      relevantPlayerIds: ['p1'],
      activeCount: 6,
      street: 'PREFLOP',
      playersYetToAct: 3,
    });
  const a = run();
  const b = run();
  assert.equal(a.dynamicsDigest, b.dynamicsDigest);
  assert.deepEqual(
    { base: a.base, adjusted: a.adjusted },
    { base: b.base, adjusted: b.adjusted },
  );
});

/* ============================================================
 * K. 调整后的动作/金额仍合法（由调用方的合法网格保证）
 * ============================================================ */

test('K1 影子层不产出任何动作或金额（结果是输入，不是动作）', () => {
  const records = looseRecords();
  const d = computeTableDynamics({ records, presentPlayerIds: ['p1'], heroPlayerId: null });
  const plan = buildTableAdjustmentPlan(d, baseCtx({ relevantPlayerIds: ['p1'] }));
  const json = JSON.stringify(plan);
  assert.equal(/"action"\s*:/.test(json), false, '调整方案里不得出现 action');
  assert.equal(/"sizeChips"\s*:/.test(json), false, '调整方案里不得出现 sizeChips');
  assert.equal(/"ev"\s*:/.test(json), false, '调整方案里不得出现 ev');
});

test('K2 系数与标签足以复算：每个 SUGGESTED 调整都能追溯到维度证据', () => {
  const records: ObservationRecord[] = [];
  for (let i = 0; i < 120; i++) {
    records.push(
      rec({ hand: i + 1, player: 'p1', seat: 'seat_CO', action: 'CALL', toCallBB: 2.5, potBB: 4, activeCount: 6 }),
    );
  }
  const d = computeTableDynamics({ records, presentPlayerIds: ['p1'], heroPlayerId: null });
  const plan = buildTableAdjustmentPlan(d, baseCtx({ relevantPlayerIds: ['p1'] }));
  for (const a of plan.adjustments) {
    if (a.status !== 'SUGGESTED') continue;
    assert.ok(a.evidence.length > 0, `${a.category} 必须给出证据维度`);
    for (const id of a.evidence) {
      const dim = d.layers.table.find((x) => x.id === id)!;
      assert.ok(dim.opportunities > 0, `证据维度 ${id} 必须真的有数据`);
    }
    assert.ok(
      a.factor >= 1 - TABLE_DYNAMICS_CONFIG.maxFactorDelta - 1e-9 &&
        a.factor <= 1 + TABLE_DYNAMICS_CONFIG.maxFactorDelta + 1e-9,
    );
  }
});

/* ============================================================
 * L. 领域层标签必须能被 app 层表达
 * ============================================================ */

test('L1 本模块产出的每一个标签名都在 QuickProfile 枚举里（否则界面/模型无法表达）', () => {
  const appProfiles = new Set<string>(Object.values(QuickProfile));
  for (const name of TABLE_PROFILE_NAMES) {
    assert.equal(appProfiles.has(name), true, `领域层标签 ${name} 在 QuickProfile 里不存在`);
  }
});

test('L2 极端桌况下产出的标签仍然在合法集合内', () => {
  const appProfiles = new Set<string>(Object.values(QuickProfile));
  const build = (action: 'FOLD' | 'CALL' | 'RAISE', toCallBB: number) => {
    const records: ObservationRecord[] = [];
    for (let i = 0; i < 150; i++) {
      records.push(
        rec({ hand: i + 1, player: 'p1', seat: 'seat_CO', action, amountBB: 9, toCallBB, potBB: 4, activeCount: 6 }),
      );
    }
    const d = computeTableDynamics({ records, presentPlayerIds: ['p1'], heroPlayerId: null });
    return buildTableAdjustmentPlan(d, baseCtx({ relevantPlayerIds: ['p1'] }));
  };
  for (const plan of [build('FOLD', 2.5), build('CALL', 2.5), build('RAISE', 2.5)]) {
    for (const p of plan.opponentProfiles) {
      assert.equal(appProfiles.has(p.quickProfile), true, `非法标签 ${p.quickProfile}`);
    }
  }
});

/* ============================================================
 * M. 三个真实缺陷的回归锁（本轮修复，均有实测证据）
 * ============================================================ */

/**
 * 🔴 缺陷 1：逐玩家分析时**丢了街道上下文**。
 *
 * 第一版先按 `playerId` 过滤记录、再扫描「本街前面有没有人加注」——
 * 于是逐 BTN 分析时 `CO 开池` 被滤掉，`TABLE_RERAISE_PRESSURE` 的
 * 机会数**恒为 0**，两种相反的行为（从不再加注 / 每次都再加注）
 * 得到同一个标签，桌况调整在模型侧完全无法区分。
 *
 * 实测（修复前）：两者都是 `再加注压力 = 0/0、aggression = NEUTRAL、标签 = LOOSE`。
 */
test('M1 逐玩家维度必须能看见「别人先加注」——否则再加注压力恒为 0', () => {
  /** 构造：CO 开池，BTN 或跟注或再加注 */
  const make = (btnAction: 'CALL' | 'RAISE'): ObservationRecord[] => {
    const records: ObservationRecord[] = [];
    for (let h = 1; h <= 60; h++) {
      records.push(
        rec({ hand: h, player: 'seat_CO', seat: 'seat_CO', action: 'RAISE', amountBB: 2.5, toCallBB: 1, potBB: 1.5, playersYetToAct: 5 }),
      );
      records.push(
        rec({
          hand: h,
          player: 'seat_BTN',
          seat: 'seat_BTN',
          action: btnAction,
          amountBB: btnAction === 'RAISE' ? 9 : 2.5,
          toCallBB: 2.5,
          potBB: 4,
          playersYetToAct: 2,
        }),
      );
    }
    return records;
  };

  const passive = computeTableDynamics({
    records: make('CALL'),
    presentPlayerIds: ['seat_CO', 'seat_BTN'],
    heroPlayerId: 'hero',
    relevantPlayerIds: ['seat_BTN'],
  });
  const aggressive = computeTableDynamics({
    records: make('RAISE'),
    presentPlayerIds: ['seat_CO', 'seat_BTN'],
    heroPlayerId: 'hero',
    relevantPlayerIds: ['seat_BTN'],
  });

  const dim = (d: TableDynamics) =>
    d.layers.relevantByPlayer['seat_BTN']!.find((x) => x.id === TableDimensionId.TABLE_RERAISE_PRESSURE)!;

  const p = dim(passive);
  const a = dim(aggressive);

  /* 核心断言：机会数**不能**是 0（这正是第一版的缺陷） */
  assert.ok(p.opportunities > 0, `被动场景的机会数必须 > 0，实测 ${p.opportunities}`);
  assert.ok(a.opportunities > 0, `激进场景的机会数必须 > 0，实测 ${a.opportunities}`);
  assert.equal(p.opportunities, a.opportunities, '两种场景面对同样的机会数');
  assert.equal(p.successes, 0, '被动：一次都没再加注');
  assert.equal(a.successes, a.opportunities, '激进：每次都再加注');
  assert.equal(p.direction, TableDirection.LOWER);
  assert.equal(a.direction, TableDirection.HIGHER);
});

/**
 * 🔴 缺陷 2：合成方向时**把已经收缩过的 delta 又乘了一次可信度**。
 *
 * `delta = (smoothed − baseline) × confidence` 里可信度已经进去过一次；
 * 第一版在 `combineDirection` 里又用 `effectiveSample` 加权平均
 *（等价于再乘一次量级相同的可信度），后果是**强证据也过不了 ±0.02 方向门槛**，
 * 标签映射永远拿到 NEUTRAL，「松凶 / 松被动」无法区分。
 *
 * 实测（修复前）：60/60 次再加注 ⇒ `aggression = NEUTRAL`；
 * 修复后：`aggression = HIGHER, delta = 0.381`。
 */
test('M2 强证据必须能定出方向（不得把 delta 二次收缩到门槛以下）', () => {
  const records: ObservationRecord[] = [];
  for (let h = 1; h <= 60; h++) {
    records.push(
      rec({ hand: h, player: 'seat_CO', seat: 'seat_CO', action: 'RAISE', amountBB: 2.5, toCallBB: 1, potBB: 1.5, playersYetToAct: 5 }),
    );
    records.push(
      rec({ hand: h, player: 'seat_BTN', seat: 'seat_BTN', action: 'RAISE', amountBB: 9, toCallBB: 2.5, potBB: 4, playersYetToAct: 2 }),
    );
  }
  const d = computeTableDynamics({
    records,
    presentPlayerIds: ['seat_CO', 'seat_BTN'],
    heroPlayerId: 'hero',
    relevantPlayerIds: ['seat_BTN'],
  });
  const dim = d.layers.relevantByPlayer['seat_BTN']!.find(
    (x) => x.id === TableDimensionId.TABLE_RERAISE_PRESSURE,
  )!;
  /* 维度级：60/60 是极强的证据，delta 必须明显大于方向门槛 */
  assert.ok(
    dim.delta > 0.1,
    `60/60 的 delta 必须远大于方向门槛 0.02，实测 ${dim.delta}`,
  );
  /* 计划级：标签映射拿到的 aggression 必须是 HIGHER（不是被压成 NEUTRAL） */
  const plan = buildTableAdjustmentPlan(d, baseCtx({ playersYetToAct: 0, relevantPlayerIds: ['seat_BTN'] }));
  const profile = plan.opponentProfiles[0]!;
  assert.equal(
    profile.axes.aggression.direction,
    TableDirection.HIGHER,
    `强证据必须定出方向，实测 ${profile.axes.aggression.direction}（delta=${profile.axes.aggression.delta}）`,
  );
});

/**
 * 🔴 缺陷 3：**被动与凶落到同一个标签**（单标签表达能力不足 + 缺陷 1/2 的后果）。
 *
 * 实测（修复前）：两者都是 `LOOSE`，逐尺寸 raiseEV 极差都是 24.0001（逐位相同）。
 * 修复后：被动 ⇒ `UNDERBLUFFER`（不加注且面对压力就弃）、凶 ⇒ `AGGRESSIVE`。
 */
test('M3 「从不再加注」与「每次都再加注」必须得到**不同**的标签', () => {
  const make = (btnAction: 'CALL' | 'RAISE'): ObservationRecord[] => {
    const records: ObservationRecord[] = [];
    for (let h = 1; h <= 60; h++) {
      records.push(
        rec({ hand: h, player: 'seat_CO', seat: 'seat_CO', action: 'RAISE', amountBB: 2.5, toCallBB: 1, potBB: 1.5, playersYetToAct: 5 }),
      );
      records.push(
        rec({
          hand: h,
          player: 'seat_BTN',
          seat: 'seat_BTN',
          action: btnAction,
          amountBB: btnAction === 'RAISE' ? 9 : 2.5,
          toCallBB: 2.5,
          potBB: 4,
          playersYetToAct: 2,
        }),
      );
    }
    return records;
  };
  const labelOf = (btnAction: 'CALL' | 'RAISE'): OpponentQuickProfile => {
    const d = computeTableDynamics({
      records: make(btnAction),
      presentPlayerIds: ['seat_CO', 'seat_BTN'],
      heroPlayerId: 'hero',
      relevantPlayerIds: ['seat_BTN'],
    });
    const plan = buildTableAdjustmentPlan(d, baseCtx({ playersYetToAct: 0, relevantPlayerIds: ['seat_BTN'] }));
    return plan.opponentProfiles[0]!;
  };
  const passive = labelOf('CALL');
  const aggressive = labelOf('RAISE');

  /*
   * 🔴 **第二轮修正后的契约**：标签**不再**用来注入（它会改动 `bluffTendency`，
   * 而翻前再加注频率证明不了翻后诈唬倾向）⇒ 标签回落 `NORMAL`、`injectable=false`。
   * 真正区分两种行为的是 **`scopedDimensions`**（只含有证据的轴）。
   */
  assert.equal(passive.injectable, false, '标签会改 bluffTendency ⇒ 必须不可注入');
  assert.equal(aggressive.injectable, false);
  assert.ok(passive.notInjectableReasonZh !== null);
  assert.match(passive.notInjectableReasonZh!, /bluffTendency/);

  /* 两种相反的行为必须在**轴**上区分开 */
  assert.equal(passive.axes.aggression.direction, TableDirection.LOWER);
  assert.equal(aggressive.axes.aggression.direction, TableDirection.HIGHER);

  /* 并且必须在**作用范围明确的维度**上区分开（这才是注入模型的东西） */
  assert.ok(passive.scopedDimensions.aggression !== null);
  assert.ok(aggressive.scopedDimensions.aggression !== null);
  assert.ok(
    aggressive.scopedDimensions.aggression! > passive.scopedDimensions.aggression!,
    `凶的 aggression 必须更高：${aggressive.scopedDimensions.aggression} vs ${passive.scopedDimensions.aggression}`,
  );
  assert.ok(passive.scopedDimensions.aggression! < 0.5, '被动 ⇒ aggression 低于中立');
  assert.ok(aggressive.scopedDimensions.aggression! > 0.5, '凶 ⇒ aggression 高于中立');

  /* 诈唬倾向**必须恒为 null**（本模块无证据 ⇒ 不注入，保持调用方原值） */
  assert.equal(passive.scopedDimensions.bluffTendency, null);
  assert.equal(aggressive.scopedDimensions.bluffTendency, null);
});

/**
 * 🔴 **第二轮核心契约：标签不得引入无依据的连带调整**。
 *
 * 一个 `QuickProfile` 是**四个维度的固定组合**。桌况层的证据只有三轴
 *（主动入池 / 面对加注再加注 / 面对下注是否放弃），**没有**任何
 * 「翻后诈唬倾向」的证据。而**每一个**非中立标签都会改动 `bluffTendency`
 *（`UNDERBLUFFER` 0.12、`AGGRESSIVE` 0.60、`TIGHT` 0.15…），
 * 它流向范围层（`profileProvider`）与翻后响应（`bluffRaiseScale` / `riverBetScale`）。
 *
 * ⇒ 用标签表达「再加注偏少」等于顺手断言「他翻后诈唬少」。
 * 本测试锁住：这种标签**一律被判定为不可注入**，且必须给出原因。
 */
test('M5 任何会改动 bluffTendency 的标签都必须被判定为不可注入（不得无依据连带调整）', () => {
  /* 三轴都给方向，让标签映射有机会选出非中立标签 */
  const allDirections = [
    TableDirection.HIGHER,
    TableDirection.LOWER,
    TableDirection.NEUTRAL,
  ] as const;
  let rejected = 0;
  let accepted = 0;
  for (const looseness of allDirections) {
    for (const aggression of allDirections) {
      for (const giveUp of allDirections) {
        for (const label of TABLE_PROFILE_NAMES) {
          const verdict = justifiedLabelOrNull(label, { looseness, aggression, giveUp });
          const ref = ARCHETYPE_DIMENSION_REFERENCE[label];
          if (Math.abs(ref.bluffTendency - 0.5) > 0.02) {
            /* 会改诈唬倾向 ⇒ 必须被拒 */
            assert.equal(
              verdict.ok,
              false,
              `标签 ${label} 把 bluffTendency 改成 ${ref.bluffTendency}，必须被拒（looseness=${looseness}）`,
            );
            rejected += 1;
          } else if (verdict.ok) {
            accepted += 1;
          }
        }
      }
    }
  }
  assert.ok(rejected > 0, '本次遍历必须真的命中「会改诈唬倾向」的标签');
  /* 只有 NORMAL（四轴全中立）能通过 —— 这正说明标签通道在本模块基本不可用 */
  assert.ok(accepted > 0, '中立标签（NORMAL）应当仍可注入');
});

test('M6 桌况层登记的标签维度必须与生产原型表逐项一致（防漂移）', () => {
  /*
   * `ARCHETYPE_DIMENSION_REFERENCE` 是桌况层为了做「无依据连带调整」校验
   * 而**复制**的一份原型维度表。复制就会漂移 —— 本测试逐项核对，
   * 生产侧一改就红，而不是让校验悄悄失效。
   *
   * 该测试在第三轮**当场抓出 3 项手抄错误**（`VERY_LOOSE` / `TIGHT` /
   * `BLUFF_HEAVY` 的 aggression 与 bluffTendency），即它确实有效。
   */
  for (const label of TABLE_PROFILE_NAMES) {
    const ref = ARCHETYPE_DIMENSION_REFERENCE[label];
    const spec = archetypeDimensionsOf(label, 0.35);
    assert.ok(spec !== null, `生产原型表里必须有 ${label}`);
    assert.equal(spec!.tightness, ref.tightness, `${label}.tightness 与生产不一致`);
    assert.equal(spec!.aggression, ref.aggression, `${label}.aggression 与生产不一致`);
    assert.equal(spec!.bluffTendency, ref.bluffTendency, `${label}.bluffTendency 与生产不一致`);
    assert.equal(spec!.passivity, ref.passivity, `${label}.passivity 与生产不一致`);
  }
});

/**
 * 🔴 **第三轮：`passivity` 轴被移除**（方向性错误）。
 *
 * 响应层的定义（`betResponse.ts`）：`passivity` 的语义是「**更爱跟**」——
 *
 * ```text
 * // 跟注站：passivity 0.8、tightness 0.3 ⇒ 更爱跟、更少弃
 * callScale = 1 + 0.30 × passive − 0.18 × tight
 * foldScale = 1 + 0.32 × tight  − 0.25 × passive
 * ```
 *
 * 而本模块只有「面对下注是否**弃牌**」的证据。把它映射成
 * `passivity = 0.5 + giveUp.delta/2` 会让「**更爱弃**」的玩家变成
 * 「更爱跟」—— 与证据**完全相反**。而且「面对下注弃牌」与「被动跟注」
 * 本就是两个行为（跟注站的特征是跟得多、弃得少；弃得多的是弱紧）。
 *
 * ⇒ `passivity` **一律不提供**（恒为 `null`），宁可不动也不给反向值。
 */
test('M7 `passivity` 一律不得注入（它的语义是「更爱跟」，而本模块只有弃牌证据）', () => {
  const make = (btnAction: 'FOLD' | 'CALL' | 'RAISE'): ObservationRecord[] => {
    const records: ObservationRecord[] = [];
    for (let h = 1; h <= 60; h++) {
      records.push(
        rec({ hand: h, player: 'seat_CO', seat: 'seat_CO', action: 'RAISE', amountBB: 2.5, toCallBB: 1, potBB: 1.5, playersYetToAct: 5 }),
      );
      records.push(
        rec({
          hand: h,
          player: 'seat_BTN',
          seat: 'seat_BTN',
          action: btnAction,
          amountBB: btnAction === 'RAISE' ? 9 : 2.5,
          toCallBB: 2.5,
          potBB: 4,
          playersYetToAct: 2,
        }),
      );
      /* 再加一条「面对下注」的证据，让 giveUp 轴真的有方向 */
      records.push(
        rec({
          hand: h,
          player: 'seat_BTN',
          seat: 'seat_BTN',
          street: 'FLOP',
          action: btnAction === 'FOLD' ? 'FOLD' : 'CALL',
          toCallBB: 10,
          potBB: 20,
          activeCount: 2,
        }),
      );
    }
    return records;
  };
  for (const action of ['FOLD', 'CALL', 'RAISE'] as const) {
    const d = computeTableDynamics({
      records: make(action),
      presentPlayerIds: ['seat_CO', 'seat_BTN'],
      heroPlayerId: 'hero',
      relevantPlayerIds: ['seat_BTN'],
    });
    const plan = buildTableAdjustmentPlan(d, baseCtx({ playersYetToAct: 0, relevantPlayerIds: ['seat_BTN'] }));
    const p = plan.opponentProfiles[0]!;
    assert.equal(
      p.scopedDimensions.passivity,
      null,
      `passivity 必须恒为 null（action=${action}）—— 弃牌证据不能推「更爱跟」`,
    );
    assert.equal(p.scopedDimensions.bluffTendency, null, 'bluffTendency 同样不得注入');
  }
});

/**
 * 🔴 **第三轮：街道范围检查**。
 *
 * `scopedDimensions` 被三个消费点共用（下注范围层 / 面对下注响应层 / 翻前事实包），
 * 而 `responseTendenciesOf` 的 `callScale` / `foldScale` / `raiseScale` /
 * `bluffRaiseScale` **都不分街** ⇒ 翻前证据会改写翻牌/转牌/河牌。
 * 授权明确禁止，因此计划必须显式声明证据覆盖的街道。
 */
test('M8 计划必须声明证据覆盖的街道，且当前只覆盖翻前', () => {
  const records: ObservationRecord[] = [];
  for (let h = 1; h <= 60; h++) {
    records.push(
      rec({ hand: h, player: 'seat_CO', seat: 'seat_CO', action: 'RAISE', amountBB: 2.5, toCallBB: 1, potBB: 1.5, playersYetToAct: 5 }),
    );
    records.push(
      rec({ hand: h, player: 'seat_BTN', seat: 'seat_BTN', action: 'RAISE', amountBB: 9, toCallBB: 2.5, potBB: 4, playersYetToAct: 2 }),
    );
  }
  const d = computeTableDynamics({
    records,
    presentPlayerIds: ['seat_CO', 'seat_BTN'],
    heroPlayerId: 'hero',
    relevantPlayerIds: ['seat_BTN'],
  });
  const plan = buildTableAdjustmentPlan(d, baseCtx({ playersYetToAct: 0, relevantPlayerIds: ['seat_BTN'] }));
  assert.deepEqual(
    [...plan.evidenceStreets],
    ['PREFLOP'],
    '十项维度全部来自翻前记录 ⇒ 证据只覆盖翻前（下游据此禁止在翻后节点注入）',
  );
});

/**
 * 🔴 口径澄清：**只有「相关对手个体证据充分」时，无关座位的数据才不得影响结果**。
 *
 * 若相关对手个体证据不足，设计上会 `TABLE_FALLBACK` —— **有限参考整桌**
 * 并且**显式披露**。那不是泄漏，而是「个体不足时明确降低确定性」这条纪律的体现。
 * 本测试把这个边界钉住，避免将来有人把它误读成缺陷而错误地「修掉」。
 */
test('M4 个体证据充分时无关座位数据不影响标签；不足时才回退整桌且必须披露', () => {
  const btnRecords = (n: number): ObservationRecord[] => {
    const records: ObservationRecord[] = [];
    for (let h = 1; h <= n; h++) {
      records.push(
        rec({ hand: h, player: 'seat_CO', seat: 'seat_CO', action: 'RAISE', amountBB: 2.5, toCallBB: 1, potBB: 1.5, playersYetToAct: 5 }),
      );
      records.push(
        rec({ hand: h, player: 'seat_BTN', seat: 'seat_BTN', action: 'CALL', amountBB: 2.5, toCallBB: 2.5, potBB: 4, playersYetToAct: 2 }),
      );
    }
    return records;
  };
  const utgRecords = (n: number): ObservationRecord[] => {
    const records: ObservationRecord[] = [];
    for (let h = 1; h <= n; h++) {
      records.push(
        rec({ hand: h, player: 'seat_UTG', seat: 'seat_UTG', action: 'RAISE', amountBB: 2.5, toCallBB: 1, potBB: 1.5, playersYetToAct: 8 }),
      );
    }
    return records;
  };
  const planOf = (records: ObservationRecord[]) => {
    const d = computeTableDynamics({
      records,
      presentPlayerIds: ['seat_CO', 'seat_BTN', 'seat_UTG'],
      heroPlayerId: 'hero',
      relevantPlayerIds: ['seat_BTN'],
    });
    return buildTableAdjustmentPlan(d, baseCtx({ playersYetToAct: 0, relevantPlayerIds: ['seat_BTN'] }));
  };

  /* 个体证据充分（60 手）+ 无关座位 60 手 */
  const withIrrelevant = planOf([...btnRecords(60), ...utgRecords(60)]);
  const p = withIrrelevant.opponentProfiles[0]!;
  assert.equal(p.source, 'INDIVIDUAL', '个体证据充分时必须用个体，不能被整桌覆盖');
  assert.equal(p.fallbackReasonZh, null, '用了个体证据就不应有回退说明');
  /* 作用范围明确的维度只由**该玩家自己**的证据决定 → 与只给他自己时相同 */
  const only = planOf(btnRecords(60)).opponentProfiles[0]!;
  assert.deepEqual(
    p.scopedDimensions,
    only.scopedDimensions,
    '无关座位的数据不得改变相关对手的注入维度',
  );

  /* 个体证据不足（只给无关座位）⇒ 允许回退整桌，但**必须披露** */
  const fallback = planOf(utgRecords(60));
  const f = fallback.opponentProfiles[0]!;
  assert.equal(f.source, 'TABLE_FALLBACK');
  assert.ok(f.fallbackReasonZh !== null, '回退整桌必须给出原因');
  assert.match(f.fallbackReasonZh!, /个体证据不足/);
  assert.match(f.fallbackReasonZh!, /有限参考整桌/);
});
