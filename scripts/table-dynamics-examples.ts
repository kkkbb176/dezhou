/**
 * ============================================================================
 * 牌桌动态适应 V1 —— 三组可重放示例（授权 §九 要求的交付物）
 * ============================================================================
 *
 * 三组场景（每组：先说明「我的位置」，再列其他条件、观察证据、调整前后结果）：
 *
 * | 组 | 场景 | 应触发的调整 |
 * |---|---|---|
 * | 1 | 盲位弃给开池偏多 | 开池方向（身后弃牌多） |
 * | 2 | 跟注偏多 | 冷跟 / 价值下注方向 |
 * | 3 | 再加注压力较高 | 再加注方向 |
 *
 * ## 输出纪律
 *
 * - 每组都打印**机会数**（分母）而不只是频率 —— 否则无法判断证据强度；
 * - 每组的「调整前 / 调整后」是**结构化字段**（`direction` / `factor` /
 *   `status`），不是解析中文；
 * - 证据不足时如实输出 `观察中`，**不编造**方向与幅度。
 *
 * 运行：`node --experimental-strip-types scripts/table-dynamics-examples.ts`
 * （只读：不写任何文件、不修改任何状态）
 */

import {
  buildTableAdjustmentPlan,
  computeTableDynamics,
  TABLE_DYNAMICS_CONFIG,
  TableDimensionId,
  type TableAdjustmentContext,
} from '../src/domain/tableDynamics/tableDynamics.ts';
import { computeTableDynamicsDigest } from '../src/domain/tableDynamics/tableDynamicsDigest.ts';
import type { ObservationRecord } from '../src/app/table/playerHistory.ts';

/* ============================================================
 * 合成记录工厂（形状与生产 `deriveObservations` 一致）
 * ============================================================ */

type Spec = {
  hand: number;
  player: string;
  position: string;
  street?: 'PREFLOP' | 'FLOP' | 'TURN' | 'RIVER';
  action: 'FOLD' | 'CHECK' | 'CALL' | 'BET' | 'RAISE' | 'ALL_IN';
  amountBB?: number;
  toCallBB?: number;
  potBB?: number;
  activeCount?: number;
  playersYetToAct?: number;
};

function rec(s: Spec): ObservationRecord {
  const pot = s.potBB ?? 1.5;
  const toCall = s.toCallBB ?? 0;
  return {
    handId: `T#H${s.hand}`,
    playerId: s.player,
    seatId: `seat_${s.position}`,
    street: s.street ?? 'PREFLOP',
    actionType: s.action,
    amountBB: s.amountBB ?? 0,
    facedBet: toCall > 0,
    toCallBB: toCall,
    seq: s.hand,
    baseRevision: s.hand,
    historyLength: s.hand,
    source: 'USER_INPUT',
    saved: true,
    handComplete: true,
    activeCount: s.activeCount ?? 6,
    effectiveStackBB: 100,
    potBB: pot,
    facedBetBB: toCall,
    facedBetPotRatio: toCall > 0 ? Number((toCall / (pot + toCall)).toFixed(4)) : 0,
    actorOrderIndex: 0,
    streetActorCount: 6,
    playersYetToAct: s.playersYetToAct ?? 4,
    buttonPosition: 'BTN',
  };
}

const line = (s = ''): void => console.log(s);
const rule = (t: string): void => {
  line();
  line('='.repeat(78));
  line(t);
  line('='.repeat(78));
};

function showDimensions(
  dims: readonly {
    id: string;
    labelZh: string;
    opportunities: number;
    successes: number;
    adjustedRate: number;
    baseline: number;
    confidence: number;
    direction: string;
    factor: number;
  }[],
  only?: readonly string[],
): void {
  for (const d of dims) {
    if (only !== undefined && !only.includes(d.id)) continue;
    line(
      `  ${d.labelZh.padEnd(14)} ${String(d.successes).padStart(3)}/${String(d.opportunities).padEnd(4)} 次机会 = ` +
        `${(d.adjustedRate * 100).toFixed(1).padStart(5)}%（基线 ${(d.baseline * 100).toFixed(1)}%）｜` +
        `可信度 ${(d.confidence * 100).toFixed(0).padStart(3)}%｜方向 ${d.direction.padEnd(7)}｜系数 ${d.factor.toFixed(4)}`,
    );
  }
}

function showPlan(plan: ReturnType<typeof buildTableAdjustmentPlan>): void {
  line('  五类调整（分别判断，无统一松紧乘数）：');
  for (const a of plan.adjustments) {
    const dirZh =
      a.direction === 'HIGHER' ? '偏高 ↑' : a.direction === 'LOWER' ? '偏低 ↓' : '不变 / 不适用';
    line(
      `    ${a.labelZh.padEnd(6)} [${a.status.padEnd(13)}] ${dirZh.padEnd(10)} 系数 ${a.factor.toFixed(4)}` +
        `｜作用对象：${a.appliesTo}`,
    );
    line(`      └ ${a.unsupportedReasonZh ?? a.reasonZh}`);
  }
  line(`  对手标签（注入 seatProfiles）：`);
  if (plan.opponentProfiles.length === 0) line('    （本次决策没有相关对手）');
  for (const p of plan.opponentProfiles) {
    line(
      `    ${p.playerId}（${p.playerId.replace(/^seat_/, '')}）→ ${p.quickProfile}` +
        `｜依据 ${p.source}｜可信度 ${(p.confidence * 100).toFixed(0)}%`,
    );
    if (p.fallbackReasonZh !== null) line(`      └ ${p.fallbackReasonZh}`);
  }
}

const CTX: TableAdjustmentContext = {
  activeCount: 6,
  street: 'PREFLOP',
  playersYetToAct: 3,
  relevantPlayerIds: ['seat_BB', 'seat_SB'],
};

const PRESENT = ['seat_UTG', 'seat_HJ', 'seat_CO', 'seat_BTN', 'seat_SB', 'seat_BB'];

/* ============================================================
 * 例 1：盲位弃给开池偏多
 * ============================================================ */

rule('例 1 —— 盲位弃给开池偏多');
line('我的位置：BTN（庄家位，身后只剩 SB / BB）');
line('其他条件：9 人桌现金局 100BB；观察窗口为该桌最近 60 手；Hero 不在统计内。');
line();

const ex1: ObservationRecord[] = [];
for (let h = 1; h <= 60; h++) {
  /* 每手：UTG 开池到 2.5BB，其余弃牌到 BTN，盲注面对开池都弃 */
  ex1.push(rec({ hand: h, player: 'seat_UTG', position: 'UTG', action: 'RAISE', amountBB: 2.5, toCallBB: 1, potBB: 1.5 }));
  ex1.push(rec({ hand: h, player: 'seat_HJ', position: 'HJ', action: 'FOLD', toCallBB: 2.5, potBB: 4 }));
  ex1.push(rec({ hand: h, player: 'seat_CO', position: 'CO', action: 'FOLD', toCallBB: 2.5, potBB: 4 }));
  ex1.push(rec({ hand: h, player: 'seat_SB', position: 'SB', action: 'FOLD', toCallBB: 2, potBB: 4, playersYetToAct: 1 }));
  ex1.push(rec({ hand: h, player: 'seat_BB', position: 'BB', action: 'FOLD', toCallBB: 1.5, potBB: 4, playersYetToAct: 0 }));
}
const d1 = computeTableDynamics({ records: ex1, presentPlayerIds: PRESENT, heroPlayerId: 'hero', relevantPlayerIds: CTX.relevantPlayerIds });
line(`观察证据（${d1.handsObserved} 手 / ${d1.recordsUsed} 条记录）：`);
showDimensions(d1.layers.table, [
  TableDimensionId.BLIND_FOLD_TO_OPEN,
  TableDimensionId.TABLE_LOOSENESS,
  TableDimensionId.TABLE_RERAISE_PRESSURE,
]);
const p1 = buildTableAdjustmentPlan(d1, CTX);
line();
line(`桌况摘要：${d1.summaryZh}`);
line(`可信度：${d1.headline.confidenceZh}（${(d1.tableConfidence * 100).toFixed(0)}%）｜处于观察中 = ${d1.observing}`);
line();
showPlan(p1);
line();
line('调整前后结果：');
line(`  调整前（无桌况信息）：Hero 的开池决策使用默认对手标签（NORMAL）`);
line(
  `  调整后（本模块注入）：${p1.opponentProfiles.map((p) => `${p.playerId}→${p.quickProfile}`).join('、') || '（无）'}；` +
    `开池方向 = ${p1.adjustments.find((a) => a.category === 'OPEN')!.direction}`,
);
line(`  桌况摘要指纹 = ${computeTableDynamicsDigest(d1, p1)}`);

/* ============================================================
 * 例 2：跟注偏多
 * ============================================================ */

rule('例 2 —— 跟注偏多（跟注站型牌桌）');
line('我的位置：CO（关煞位，身后有 BTN / SB / BB）');
line('其他条件：同一桌最近 60 手；Hero 不在统计内。');
line();

const ex2: ObservationRecord[] = [];
for (let h = 1; h <= 60; h++) {
  /* 每手：UTG 开池，HJ/CO 冷跟，BTN 也跟，盲注跟；翻前多人池 */
  ex2.push(rec({ hand: h, player: 'seat_UTG', position: 'UTG', action: 'RAISE', amountBB: 2.5, toCallBB: 1, potBB: 1.5, playersYetToAct: 8 }));
  ex2.push(rec({ hand: h, player: 'seat_HJ', position: 'HJ', action: 'CALL', amountBB: 2.5, toCallBB: 2.5, potBB: 4, playersYetToAct: 5 }));
  ex2.push(rec({ hand: h, player: 'seat_CO', position: 'CO', action: 'CALL', amountBB: 2.5, toCallBB: 2.5, potBB: 6.5, playersYetToAct: 4 }));
  ex2.push(rec({ hand: h, player: 'seat_BTN', position: 'BTN', action: 'CALL', amountBB: 2.5, toCallBB: 2.5, potBB: 9, playersYetToAct: 2 }));
  ex2.push(rec({ hand: h, player: 'seat_SB', position: 'SB', action: 'CALL', amountBB: 2, toCallBB: 2, potBB: 11.5, playersYetToAct: 1 }));
  ex2.push(rec({ hand: h, player: 'seat_BB', position: 'BB', action: 'CHECK', potBB: 12.5, playersYetToAct: 0 }));
  /* 翻牌：四人看翻牌，面对小注多数跟注 */
  ex2.push(
    rec({
      hand: h,
      player: 'seat_BB',
      position: 'BB',
      street: 'FLOP',
      action: 'CALL',
      amountBB: 4,
      toCallBB: 4,
      potBB: 12,
      activeCount: 5,
    }),
  );
}
const d2 = computeTableDynamics({ records: ex2, presentPlayerIds: PRESENT, heroPlayerId: 'hero', relevantPlayerIds: ['seat_UTG', 'seat_HJ'] });
line(`观察证据（${d2.handsObserved} 手 / ${d2.recordsUsed} 条记录）：`);
showDimensions(d2.layers.table, [
  TableDimensionId.TABLE_LOOSENESS,
  TableDimensionId.TABLE_COLD_CALL,
  TableDimensionId.TABLE_RERAISE_PRESSURE,
  TableDimensionId.TABLE_FOLD_VS_SMALL,
  TableDimensionId.TABLE_MULTIWAY,
]);
const p2 = buildTableAdjustmentPlan(d2, {
  ...CTX,
  relevantPlayerIds: ['seat_UTG', 'seat_HJ'],
});
line();
line(`桌况摘要：${d2.summaryZh}`);
line(`可信度：${d2.headline.confidenceZh}（${(d2.tableConfidence * 100).toFixed(0)}%）｜处于观察中 = ${d2.observing}`);
line();
showPlan(p2);
line();
line('调整前后结果：');
line('  调整前：Hero 面对开池时，对手按默认标签（NORMAL）估计弃牌/跟注倾向');
line(
  `  调整后：${p2.opponentProfiles.map((p) => `${p.playerId}→${p.quickProfile}`).join('、') || '（无）'}；` +
    `冷跟方向 = ${p2.adjustments.find((a) => a.category === 'COLD_CALL')!.direction}；` +
    `价值下注方向 = ${p2.adjustments.find((a) => a.category === 'VALUE_BET')!.direction}`,
);
line(`  桌况摘要指纹 = ${computeTableDynamicsDigest(d2, p2)}`);

/* ============================================================
 * 例 3：再加注压力较高
 * ============================================================ */

rule('例 3 —— 再加注压力较高（3Bet 频繁）');
line('我的位置：HJ（劫持位，身后有 CO / BTN / SB / BB）');
line('其他条件：同一桌最近 60 手；Hero 不在统计内。');
line();

const ex3: ObservationRecord[] = [];
for (let h = 1; h <= 60; h++) {
  /* 每手：UTG 开池，HJ 弃，CO 3Bet，BTN 4Bet，回到 UTG 面对再加注 */
  ex3.push(rec({ hand: h, player: 'seat_UTG', position: 'UTG', action: 'RAISE', amountBB: 2.5, toCallBB: 1, potBB: 1.5, playersYetToAct: 8 }));
  ex3.push(rec({ hand: h, player: 'seat_HJ', position: 'HJ', action: 'FOLD', toCallBB: 2.5, potBB: 4, playersYetToAct: 5 }));
  ex3.push(rec({ hand: h, player: 'seat_CO', position: 'CO', action: 'RAISE', amountBB: 9, toCallBB: 2.5, potBB: 4, playersYetToAct: 3 }));
  ex3.push(rec({ hand: h, player: 'seat_BTN', position: 'BTN', action: 'RAISE', amountBB: 22, toCallBB: 9, potBB: 13.5, playersYetToAct: 2 }));
  ex3.push(rec({ hand: h, player: 'seat_SB', position: 'SB', action: 'FOLD', toCallBB: 22, potBB: 35.5, playersYetToAct: 1 }));
  ex3.push(rec({ hand: h, player: 'seat_BB', position: 'BB', action: 'FOLD', toCallBB: 21, potBB: 35.5, playersYetToAct: 0 }));
}
const d3 = computeTableDynamics({ records: ex3, presentPlayerIds: PRESENT, heroPlayerId: 'hero', relevantPlayerIds: ['seat_CO', 'seat_BTN'] });
line(`观察证据（${d3.handsObserved} 手 / ${d3.recordsUsed} 条记录）：`);
showDimensions(d3.layers.table, [
  TableDimensionId.TABLE_RERAISE_PRESSURE,
  TableDimensionId.TABLE_COLD_CALL,
  TableDimensionId.TABLE_LOOSENESS,
]);
const p3 = buildTableAdjustmentPlan(d3, {
  ...CTX,
  relevantPlayerIds: ['seat_CO', 'seat_BTN'],
});
line();
line(`桌况摘要：${d3.summaryZh}`);
line(`可信度：${d3.headline.confidenceZh}（${(d3.tableConfidence * 100).toFixed(0)}%）｜处于观察中 = ${d3.observing}`);
line();
showPlan(p3);
line();
line('调整前后结果：');
line('  调整前：Hero 的边缘开池/冷跟按默认对手标签（NORMAL）估计被 3Bet 的概率');
line(
  `  调整后：${p3.opponentProfiles.map((p) => `${p.playerId}→${p.quickProfile}`).join('、') || '（无）'}；` +
    `再加注方向 = ${p3.adjustments.find((a) => a.category === 'THREEBET')!.direction}`,
);
line(`  桌况摘要指纹 = ${computeTableDynamicsDigest(d3, p3)}`);

/* ============================================================
 * 汇总与参数性质声明
 * ============================================================ */

rule('汇总');
line(`  模型版本：${d1.version}｜参数来源：${d1.configProvenance}`);
line(
  `  窗口：本场近期 ${TABLE_DYNAMICS_CONFIG.recentHands} 手 · 整桌 ${TABLE_DYNAMICS_CONFIG.tableHands} 手 · ` +
    `半衰期 ${TABLE_DYNAMICS_CONFIG.halfLifeHands} 手`,
);
line(
  `  门槛：方向需可信度 ≥ ${(TABLE_DYNAMICS_CONFIG.minDirectionalConfidence * 100).toFixed(0)}%；` +
    `调整需可信度 ≥ ${(TABLE_DYNAMICS_CONFIG.minConfidenceForAdjustment * 100).toFixed(0)}%；` +
    `幅度上限 ±${(TABLE_DYNAMICS_CONFIG.maxFactorDelta * 100).toFixed(0)}%`,
);
line();
line('  ⚠️ 参数性质：上列全部为**工程初始值**（ENGINEERING_DEFAULT）——');
line('     它们只保证「无证据 ⇒ 不调整」与「证据越多越接近实测」两条单调性，');
line('     **不是**经过统计校准的最优参数，也不代表人群统计。');
line();
line('  ⚠️ 关于「调整前后结果」的边界（必须如实说明）：');
line('     本节给出的是**结构化调整方向与注入的对手标签**，以及桌况摘要指纹。');
line('     它**不等于**「最终建议一定改变」—— 该通道受对手响应模型的门槛限制，');
line('     实测结论见审计报告：翻前节点的 RAISE EV 在 5 种极端标签下极差为 0.0000 筹码。');
