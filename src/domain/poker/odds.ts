/**
 * 赔率与底池数学（确定性计算，禁止任何猜测）
 *
 * 规范第 10 / 16 / 17 / 26 / 27 条；Bug 预判 B12 / B16 / B20 / M14。
 *
 * 口径说明（界面必须一致，否则会误导用户）：
 * - 底池（pot）：当前台面上已经投入的所有筹码（含盲注与前注）
 * - 跟注需要（callCost）：我本次还要投入多少（已扣除我本街已投入的部分）
 * - 底池赔率（potOdds）= 跟注需要 / (底池 + 对手加注部分 + 跟注需要)
 * - 最低所需权益（requiredEquity）与底池赔率数值相等，但**语义不同**：
 *   底池赔率是「我需要付多少钱去赢多少钱」，最低所需权益是「我必须达到多少胜率才不亏」。
 * - 风险收益比（riskReward）= 风险 / 可赢得的总量，是同一个量的另一种表达。
 */

import { allBoardCards, computePot, playerById, type GameState, type PlayerState } from './gameState.ts';

/* ============================================================
 * 结构
 * ============================================================ */

export type EffectiveStack = {
  /** 有效筹码 = min(我的剩余, 对手的剩余) */
  amount: number;
  /** 由哪位对手决定（有效筹码的封顶者） */
  opponentId: string;
  opponentName: string;
  opponentStack: number;
  myStack: number;
};

export type PotOddsResult = {
  /** 当前底池（系统重算值） */
  pot: number;
  /** 跟注需要的筹码 */
  callCost: number;
  /** 跟注后底池 */
  finalPot: number;
  /** 底池赔率 = callCost / (pot + callCost)，0..1 */
  potOdds: number;
  /** 最低所需权益 = 与底池赔率同值；若对手还有筹码未投入，则为净盈亏平衡点 */
  requiredEquity: number;
  /** 风险收益比 = 风险 / 可赢得总量 */
  riskReward: number;
  /** 净盈亏平衡点（考虑对手剩余筹码时更严格的口径），可选 */
  breakEvenVsRemainingStack?: number;
  /** 我本街已投入 */
  myCommittedThisStreet: number;
  /** 我剩余筹码 */
  myRemainingStack: number;
};

export type SprResult = {
  /** 有效筹码 */
  effectiveStack: number;
  /** 当前底池 */
  pot: number;
  /** 底池筹码比 */
  spr: number;
};

export type MathFailure = {
  ok: false;
  code: string;
  params: Readonly<Record<string, string | number>>;
};

export type MathSuccess<T> = { ok: true; value: T };

export type MathOutcome<T> = MathSuccess<T> | MathFailure;

function failure(code: string, params: Record<string, string | number> = {}): MathFailure {
  return { ok: false, code, params };
}

/* ============================================================
 * 有效筹码
 * ============================================================ */

/**
 * 计算有效筹码。
 *
 * 口径（明确写死，避免 Bug 预判 B16）：按**当前剩余筹码**计算，
 * 不使用起始筹码，因为决策发生时盲注与前面的下注已经离开筹码堆。
 *
 * @param opponentId 指定主要对手；不指定时取「剩余筹码最多的未弃牌对手」作为默认主要对手
 */
export function effectiveStackBetween(
  state: GameState,
  playerId: string,
  opponentId?: string,
): MathOutcome<EffectiveStack> {
  const me = playerById(state, playerId);
  if (!me) return failure('ISSUE.UNKNOWN_PLAYER', { playerId });

  const candidates = state.players.filter(
    (p) => p.id !== playerId && !p.folded && (!opponentId || p.id === opponentId),
  );
  if (candidates.length === 0) {
    return failure('ISSUE.OPPONENT_STACK_MISSING', { player: '（无对手）' });
  }

  let opponent: PlayerState = candidates[0]!;
  for (const candidate of candidates) {
    if (candidate.remainingStack > opponent.remainingStack) opponent = candidate;
  }

  return {
    ok: true,
    value: {
      amount: Math.min(me.remainingStack, opponent.remainingStack),
      opponentId: opponent.id,
      opponentName: opponent.name,
      opponentStack: opponent.remainingStack,
      myStack: me.remainingStack,
    },
  };
}

/* ============================================================
 * 底池赔率 / 最低所需权益 / 底池筹码比
 * ============================================================ */

/**
 * 计算底池赔率与最低所需权益。
 *
 * @param pot 当前底池
 * @param callCost 跟注需要投入的筹码
 * @param opponentRemainingStack 主要对手剩余筹码（可选，用于给出更严格的盈亏平衡点）
 */
export function potOdds(
  pot: number,
  callCost: number,
  opponentRemainingStack?: number,
): MathOutcome<PotOddsResult> {
  if (!Number.isFinite(pot) || !Number.isFinite(callCost)) {
    return failure('ISSUE.MATH_INVALID_INPUT', { detail: '底池或跟注金额不是有效数字' });
  }
  if (pot < 0) return failure('ISSUE.POT_NEGATIVE', { pot });
  if (callCost < 0) return failure('ISSUE.MATH_INVALID_INPUT', { detail: `跟注金额不能为负（${callCost}）` });

  const finalPot = pot + callCost;
  if (finalPot <= 0) {
    return failure('ISSUE.MATH_DIVIDE_BY_ZERO', { expr: '底池 + 跟注金额 = 0' });
  }

  const ratio = callCost / finalPot;

  let breakEvenVsRemainingStack: number | undefined;
  if (
    opponentRemainingStack !== undefined &&
    Number.isFinite(opponentRemainingStack) &&
    opponentRemainingStack > 0
  ) {
    // 若我最终可能再输掉与对手剩余筹码相当的量，则需要更高的权益
    const denom = finalPot + opponentRemainingStack;
    breakEvenVsRemainingStack = denom > 0 ? (callCost + opponentRemainingStack) / denom : undefined;
  }

  return {
    ok: true,
    value: {
      pot,
      callCost,
      finalPot,
      potOdds: ratio,
      requiredEquity: ratio,
      riskReward: callCost / Math.max(1e-9, pot + callCost),
      ...(breakEvenVsRemainingStack !== undefined ? { breakEvenVsRemainingStack } : {}),
      myCommittedThisStreet: 0,
      myRemainingStack: 0,
    },
  };
}

/**
 * 下注/加注场景下的最低所需权益。
 *
 * 与跟注场景的区别：这里的「奖励」是当前底池（对手尚未投入新的筹码），
 * 「风险」是我的下注额。即：requiredEquity = 风险 / (底池 + 风险)。
 */
export function requiredEquityForBet(pot: number, betAmount: number): MathOutcome<number> {
  if (!Number.isFinite(pot) || !Number.isFinite(betAmount)) {
    return failure('ISSUE.MATH_INVALID_INPUT', { detail: '底池或下注额不是有效数字' });
  }
  if (pot < 0) return failure('ISSUE.POT_NEGATIVE', { pot });
  if (betAmount < 0) {
    return failure('ISSUE.MATH_INVALID_INPUT', { detail: `下注额不能为负（${betAmount}）` });
  }
  const denom = pot + betAmount;
  if (denom <= 0) return failure('ISSUE.MATH_DIVIDE_BY_ZERO', { expr: '底池 + 下注额 = 0' });
  return { ok: true, value: betAmount / denom };
}

/** 底池筹码比 = 有效筹码 / 当前底池 */
export function spr(effectiveStack: number, pot: number): MathOutcome<SprResult> {
  if (!Number.isFinite(effectiveStack) || !Number.isFinite(pot)) {
    return failure('ISSUE.MATH_INVALID_INPUT', { detail: '有效筹码或底池不是有效数字' });
  }
  if (effectiveStack < 0) {
    return failure('ISSUE.MATH_INVALID_INPUT', { detail: `有效筹码不能为负（${effectiveStack}）` });
  }
  if (pot <= 0) {
    return failure('ISSUE.MATH_DIVIDE_BY_ZERO', { expr: '底池为 0，无法计算底池筹码比' });
  }
  return { ok: true, value: { effectiveStack, pot, spr: effectiveStack / pot } };
}

/* ============================================================
 * 把「牌局状态」换算成「数学量」
 * ============================================================ */

export type PotMathSnapshot = {
  pot: number;
  callCost: number;
  myRemainingStack: number;
  effectiveStack: number;
  opponentId: string;
  opponentName: string;
  odds: PotOddsResult;
  spr: number;
  /** 当前底池由系统按行动记录重算得到 */
  potSource: 'RECOMPUTED';
};

/**
 * 从牌局状态一次性算出界面需要的全部底池数学量。
 * 这是「当前底池 / 跟注需要 / 底池赔率 / 最低所需权益 / 底池筹码比」的唯一来源。
 */
export function potMathSnapshot(
  state: GameState,
  playerId: string,
  requiredCall: number,
  opponentId?: string,
): MathOutcome<PotMathSnapshot> {
  const me = playerById(state, playerId);
  if (!me) return failure('ISSUE.UNKNOWN_PLAYER', { playerId });
  if (requiredCall < 0) {
    return failure('ISSUE.MATH_INVALID_INPUT', { detail: `跟注需要不能为负（${requiredCall}）` });
  }

  const eff = effectiveStackBetween(state, playerId, opponentId);
  if (!eff.ok) return eff;

  const pot = computePot(state);
  const odds = potOdds(pot, requiredCall, eff.value.opponentStack);
  if (!odds.ok) return odds;

  const sprResult = pot > 0 ? spr(eff.value.amount, pot) : null;

  return {
    ok: true,
    value: {
      pot,
      callCost: requiredCall,
      myRemainingStack: me.remainingStack,
      effectiveStack: eff.value.amount,
      opponentId: eff.value.opponentId,
      opponentName: eff.value.opponentName,
      odds: {
        ...odds.value,
        myCommittedThisStreet: me.committedByStreet[state.street],
        myRemainingStack: me.remainingStack,
      },
      spr: sprResult && sprResult.ok ? sprResult.value.spr : Number.NaN,
      potSource: 'RECOMPUTED',
    },
  };
}

/* ============================================================
 * 权益门槛与 EV
 * ============================================================ */

export type EquityGateVerdict = 'CALL_ALLOWED' | 'CALL_NOT_ALLOWED' | 'MARGINAL' | 'NOT_COMPUTABLE';

export type EquityGate = {
  equity: number | null;
  requiredEquity: number;
  /** 权益 − 最低所需权益 */
  edge: number;
  verdict: EquityGateVerdict;
  /** 是否处于边缘区间（差距绝对值小于阈值） */
  marginal: boolean;
  /** 边缘阈值 */
  marginalBand: number;
};

/**
 * 权益门槛判断（只做数学判断，不掺入任何对手倾向）。
 *
 * @param equity 当前权益（0..1）；null 表示无法计算
 * @param marginalBand 边缘区间半宽，默认 0.02（即 ±2%）
 */
export function equityGate(
  equity: number | null,
  requiredEquity: number,
  marginalBand = 0.02,
): MathOutcome<EquityGate> {
  if (!Number.isFinite(requiredEquity) || requiredEquity < 0 || requiredEquity > 1) {
    return failure('ISSUE.MATH_INVALID_INPUT', { detail: `最低所需权益必须在 0..1（收到 ${requiredEquity}）` });
  }
  if (equity === null || !Number.isFinite(equity)) {
    return {
      ok: true,
      value: {
        equity: null,
        requiredEquity,
        edge: Number.NaN,
        verdict: 'NOT_COMPUTABLE',
        marginal: false,
        marginalBand,
      },
    };
  }
  const edge = equity - requiredEquity;
  const marginal = Math.abs(edge) < marginalBand;
  const verdict: EquityGateVerdict = marginal ? 'MARGINAL' : edge > 0 ? 'CALL_ALLOWED' : 'CALL_NOT_ALLOWED';
  return { ok: true, value: { equity, requiredEquity, edge, verdict, marginal, marginalBand } };
}

/**
 * 跟注的期望收益（以筹码为单位）。
 *
 * EV = 权益 × 可赢得总量 − (1 − 权益) × 风险
 * 可赢得总量（reward）= 当前底池 + 对手本次投入（含其加注部分）
 * 风险（risk）= 我的跟注成本
 *
 * 当 equity = risk / (reward + risk) 时 EV 恰为 0 —— 这就是最低所需权益的定义，
 * 测试中对此有专门的交叉验证。
 */
export function callEV(equity: number, reward: number, risk: number): MathOutcome<number> {
  if (!Number.isFinite(equity) || equity < 0 || equity > 1) {
    return failure('ISSUE.MATH_INVALID_INPUT', { detail: `权益必须在 0..1（收到 ${equity}）` });
  }
  if (!Number.isFinite(reward) || !Number.isFinite(risk) || reward < 0 || risk < 0) {
    return failure('ISSUE.MATH_INVALID_INPUT', { detail: '可赢得总量与风险不能为负' });
  }
  return { ok: true, value: equity * reward - (1 - equity) * risk };
}

/** 跟注场景的便捷包装：reward = 底池，risk = 跟注成本 */
export function callEVFromPot(equity: number, pot: number, callCost: number): MathOutcome<number> {
  return callEV(equity, pot, callCost);
}

/**
 * 下注/加注的期望收益（对手要么弃牌、要么跟注）。
 *
 * EV = 弃牌率 × 直接赢下的底池
 *    + 跟注率 × [ 权益 × (底池 + 我的下注 × 2) − 我的下注 ]
 */
export function betEV(
  equityWhenCalled: number,
  pot: number,
  betAmount: number,
  foldProbability: number,
): MathOutcome<number> {
  if (!Number.isFinite(equityWhenCalled) || equityWhenCalled < 0 || equityWhenCalled > 1) {
    return failure('ISSUE.MATH_INVALID_INPUT', { detail: `权益必须在 0..1（收到 ${equityWhenCalled}）` });
  }
  if (!Number.isFinite(foldProbability) || foldProbability < 0 || foldProbability > 1) {
    return failure('ISSUE.MATH_INVALID_INPUT', { detail: `弃牌率必须在 0..1（收到 ${foldProbability}）` });
  }
  if (pot < 0 || betAmount < 0) {
    return failure('ISSUE.MATH_INVALID_INPUT', { detail: '底池与下注额不能为负' });
  }
  const callProbability = 1 - foldProbability;
  const winWhenCalled = equityWhenCalled * (pot + betAmount * 2) - betAmount;
  return { ok: true, value: foldProbability * pot + callProbability * winWhenCalled };
}

/* ============================================================
 * 下注尺寸
 * ============================================================ */

export type BetSizePreset = {
  key: 'QUARTER' | 'THIRD' | 'HALF' | 'TWO_THIRDS' | 'THREE_QUARTERS' | 'POT';
  labelKey: string;
  /** 相对底池的比例 */
  ratio: number;
  amount: number;
};

export const BET_SIZE_PRESETS: ReadonlyArray<{ key: BetSizePreset['key']; labelKey: string; ratio: number }> = [
  { key: 'QUARTER', labelKey: 'MATH.SIZE_QUARTER', ratio: 0.25 },
  { key: 'THIRD', labelKey: 'MATH.SIZE_THIRD', ratio: 1 / 3 },
  { key: 'HALF', labelKey: 'MATH.SIZE_HALF', ratio: 0.5 },
  { key: 'TWO_THIRDS', labelKey: 'MATH.SIZE_TWO_THIRDS', ratio: 2 / 3 },
  { key: 'THREE_QUARTERS', labelKey: 'MATH.SIZE_THREE_QUARTERS', ratio: 0.75 },
  { key: 'POT', labelKey: 'MATH.SIZE_POT', ratio: 1 },
];

/**
 * 生成标准下注尺寸网格。
 * 超过剩余筹码的尺寸取剩余筹码（即全下），保证所有尺寸都可执行。
 */
export function betSizeGrid(pot: number, remainingStack: number): MathOutcome<BetSizePreset[]> {
  if (pot < 0) return failure('ISSUE.POT_NEGATIVE', { pot });
  if (remainingStack < 0) {
    return failure('ISSUE.MATH_INVALID_INPUT', { detail: `剩余筹码不能为负（${remainingStack}）` });
  }
  const grid = BET_SIZE_PRESETS.map((preset) => ({
    key: preset.key,
    labelKey: preset.labelKey,
    ratio: preset.ratio,
    amount: Math.min(Math.round(pot * preset.ratio), remainingStack),
  }));
  // 超池下注（1.25 倍）单列，便于界面显示「超池 1.25倍」
  return { ok: true, value: grid };
}

/** 下注额占底池比例 */
export function betRatioToPot(betAmount: number, pot: number): MathOutcome<number> {
  if (!Number.isFinite(betAmount) || betAmount < 0) {
    return failure('ISSUE.MATH_INVALID_INPUT', { detail: `下注额不合法（${betAmount}）` });
  }
  if (pot <= 0) return failure('ISSUE.MATH_DIVIDE_BY_ZERO', { expr: '底池为 0' });
  return { ok: true, value: betAmount / pot };
}

/** 底池总额（含未跟注的对手筹码） */
export function currentPot(state: GameState): number {
  return computePot(state);
}

/** 公共牌张数（用于确认当前街） */
export function boardCount(state: GameState): number {
  return allBoardCards(state).length;
}

export { computePot };
