/**
 * 🔴 **决策一致性守卫**（2026-09 RIVER CONSISTENCY V2 · 使用者第十九节）
 *
 * ## 为什么需要它
 *
 * 真人牌局测试抓到的同类缺陷有一个共同形状：**输出内部自相矛盾**。
 * 实测（Hero BTN A♣Q♠，河牌 Q♦8♣5♣2♥K♣ 面对 22BB 下注）：
 *
 * ```text
 * 界面：⚠️ 建议跟注但跟注 EV 为负（-317.61 筹码）—— 数学上不成立的建议不应出现
 * 实际：建议：跟注
 * 偏好顺序：FOLD 0.58 > CALL 0.42     ← 连启发式偏好也认为该弃牌
 * 角色：听牌（DRAW）                  ← 河牌不可能存在听牌
 * ```
 *
 * 三句话互相打架，用户无法判断该信哪一句。**这类缺陷测试很难抓到**
 * （每一条单独看都「有解释」），因此必须把「三者属于同一体系」变成
 * **可执行断言**：产出前跑一遍 `validateDecisionConsistency`。
 *
 * ## 检查项（使用者 §19 A–K）
 *
 * | 编号 | 检查 | 证据等级 |
 * |---|---|---|
 * | A | 河牌角色 ≠ DRAW | 【数学确定】（河牌没有未来公共牌） |
 * | B | 河牌角色 ≠ SEMI_BLUFF | 【数学确定】 |
 * | C | 最终动作在合法集合内 | 【工程约束】 |
 * | D | 底池 / 跟注额非负且有限 | 【数学确定】 |
 * | E | `requiredEquity ∈ [0,1]` | 【数学确定】 |
 * | F | 有真实 chip EV 时，动作必须是**最高 EV**（带内近似相等除外） | 【数学确定】+【工程约束】 |
 * | G | 用偏好分决策时，动作必须是**最高偏好分** | 【工程约束】 |
 * | H | 不得出现「EV 负数警告 + 未解释的另一体系动作」 | 【工程约束】 |
 * | I | 河牌未来补牌保护分 = 0 | 【数学确定】 |
 * | J | 河牌未来街承诺加分 = 0 | 【数学确定】 |
 * | K | 未完成行动节点不得出现**最终**未跟注退回 | 【工程约束】 |
 *
 * ## 处理方式（使用者 §19 末）
 *
 * - 开发环境：`assert` / 测试失败
 * - 生产环境：显式显示 `DECISION_CONSISTENCY_ERROR`
 *
 * 本模块只**产出**违规列表，不做 IO：调用方决定怎么暴露。
 * 但**任何情况下都不允许静默** —— 违规必须出现在输出里。
 */

import type { RelativeHandRole } from '../postflop/types.ts';
import { MATH_EV_EPSILON } from './decision.types.ts';

export type ConsistencyCode =
  | 'RIVER_ROLE_DRAW'
  | 'RIVER_ROLE_SEMI_BLUFF'
  | 'ACTION_NOT_LEGAL'
  | 'POT_OR_CALL_INVALID'
  | 'REQUIRED_EQUITY_OUT_OF_RANGE'
  | 'ACTION_CONTRADICTS_CHIP_EV'
  | 'ACTION_CONTRADICTS_PREFERENCE'
  | 'EV_WARNING_CONTRADICTS_ACTION'
  | 'RIVER_FUTURE_CARD_PROTECTION_NONZERO'
  | 'RIVER_FUTURE_STREET_COMMITMENT_NONZERO'
  | 'SETTLEMENT_PREMATURE'
  | 'SETTLEMENT_DUPLICATE';

export type ConsistencyViolation = {
  code: ConsistencyCode;
  /** 人话说明（中文，含具体数字） */
  textZh: string;
};

/**
 * **本次动作是由哪一套指标选出来的**（使用者 §8）。
 *
 * ⚠️ 这不是「哪个指标看起来更合理」，而是**这次实际用了哪一条规则** ——
 * 它必须能被守卫验证：`CHIP_EV` 的动作必须是最高 EV；
 * `PREFERENCE_SCORE` 的动作必须是最高偏好分；
 * `MATH_INDIFFERENCE` 只允许在浮点级相等（`|EV| ≤ MATH_EV_EPSILON`）时出现；
 * `MODEL_UNCERTAINTY_OVERRIDE` 只允许在**显式开启**覆盖时出现。
 *
 * ## 🔴 V2.1 的改名（P0-2）
 *
 * V2 把「5% × 可争夺量」的**工程容差**叫 `INDIFFERENCE_BAND`（无差异带），
 * 于是在 `FOLD EV = 0 > CALL EV = −317.61` 的局面上写出了
 * 「数学上没有明显优劣」—— 那句话不成立。现在：
 *
 * | 名字 | 含义 |
 * |---|---|
 * | `MATH_INDIFFERENCE` | **数学**上无差异：`|ΔEV| ≤ 1e-6` 筹码（只有浮点余量） |
 * | `MODEL_UNCERTAINTY_OVERRIDE` | **工程**上偏离 EV 第一名（必须显式开启，且标注为非数学结论） |
 */
export type DecisionBasisKind =
  | 'CHIP_EV'
  | 'ACTION_EV_COMPARISON'
  | 'SUPPORTED_ACTION_PRIORITY'
  | 'HEURISTIC_TIEBREAK'
  | 'STRATEGIC_HEURISTIC'
  | 'FALLBACK'
  | 'HARD_CONSTRAINT'
  | 'PREFERENCE_SCORE'
  | 'MATH_INDIFFERENCE'
  | 'MODEL_UNCERTAINTY_OVERRIDE'
  | 'SAFETY_RULE'
  | 'NO_ACTION';

export type DecisionBasis = {
  kind: DecisionBasisKind;
  noteZh: string;
};

/**
 * 从输出**反推**决策依据（确定性，不含启发式猜测）。
 *
 * 之所以「反推」而不是让 `pickCandidate` 的每个返回点都上报：那条路径有
 * 十几个出口，逐个改容易漏；而反推的判据只依赖**输出本身**
 *（动作 + chip EV + 是否在带内），因此**守卫能独立复算**，
 * 不会被「模块自称用了什么」欺骗。
 */
export function decisionBasisOf(input: {
  action: string | null;
  actionable: boolean;
  facingBet: boolean;
  /** 节点增量 chip EV（跟注）；不可算时为 null */
  callEV: number | null;
  /**
   * 模型容差带（筹码）。**只用于描述工程不确定性**，
   * 不用于判断数学上谁更优（P0-2）。
   */
  uncertaintyBand: number;
  /** 是否显式开启了「不确定性覆盖」 */
  allowUncertaintyOverride?: boolean;
  /** 本次动作是否由覆盖规则产生（由决策层告知） */
  overrodeByUncertainty?: boolean;
  /**
   * 🔴 **无人下注时是否由「下注决策模型」的 EV 比较选出**（BET DECISION ENGINE）。
   *
   * 真 ⇒ 依据写 `ACTION_EV_COMPARISON`（并附合法动作表），
   * **不再**说是「价值守门器的偏好分」—— 解释层与行为层必须同一事实来源（§9）。
   */
  byBetDecisionModel?: boolean;
  /** 合法动作与 EV（供 `ACTION_EV_COMPARISON` 的依据说明） */
  betDecisionTableZh?: string;
  /**
   * 🔴 **证据裁决来源**（PREFLOP EVIDENCE PRIORITY FIX）。
   *
   * 只要下注/加注分支经过了 `chooseByEvidencePriority`，就必须把真实来源传进来：
   * `SUPPORTED_ACTION_PRIORITY` / `HEURISTIC_TIEBREAK` / `STRATEGIC_HEURISTIC` /
   * `FALLBACK` / `HARD_CONSTRAINT`。
   *
   * ⚠️ 修复前「加注/全下」一律写 `SAFETY_RULE` —— 而它实际表达的是
   * **战略偏好**（「这种牌通常加注」），不是安全约束。使用者 §17 要求把
   * 「安全」这个名字只留给真正的合法性/输入保护。
   */
  evidenceSource?: string | null;
  evidenceNoteZh?: string | null;
}): DecisionBasis {
  if (!input.actionable || input.action === null) {
    return { kind: 'NO_ACTION', noteZh: '信息不足 ⇒ 不给方向（这不是「弃牌」）' };
  }
  if (!input.facingBet) {
    if (input.byBetDecisionModel === true) {
      return {
        kind: 'ACTION_EV_COMPARISON',
        noteZh:
          '无人下注：动作由**下注决策模型**的合法动作 EV 比较选出' +
          (input.betDecisionTableZh === undefined || input.betDecisionTableZh === ''
            ? ''
            : ` —— ${input.betDecisionTableZh}`) +
          '（⚠️ 启发式代理 EV，不是 Solver EV；零点 = 当前决策点，已投入筹码为沉没成本）',
      };
    }
    return {
      kind: 'PREFERENCE_SCORE',
      noteZh: '无人下注：动作由**价值守门器的偏好分**（下注分 vs 过牌分）选出 —— 内部评分，不是 chip EV',
    };
  }
  const ev = input.callEV;
  if (input.action === 'FOLD' || input.action === 'CALL') {
    if (ev === null) {
      return {
        kind: 'SAFETY_RULE',
        noteZh: '算不出权益 ⇒ 跟注 EV 不可得，动作由**安全规则**（信息不足时取代价最小的方向）选出',
      };
    }
    if (input.overrodeByUncertainty === true) {
      return {
        kind: 'MODEL_UNCERTAINTY_OVERRIDE',
        noteZh:
          `真实 EV 排名是弃牌更高（CALL ${ev.toFixed(2)} vs FOLD 0），` +
          `但本次动作落在**模型容差带** ±${input.uncertaintyBand.toFixed(2)} 筹码内，` +
          '且调用方**显式开启**了不确定性覆盖 ⇒ 取代价最小的方向。' +
          '⚠️ 这是**工程启发式，不是数学结论**（数学上弃牌 EV 更高）',
      };
    }
    if (Math.abs(ev) <= 1e-6) {
      return {
        kind: 'MATH_INDIFFERENCE',
        noteZh: `跟注 EV = ${ev.toFixed(6)} 筹码，与弃牌（EV ≡ 0）之差在**浮点误差**以内 ⇒ 数学上确实无差异（|ΔEV| ≤ 1e-6 筹码）`,
      };
    }
    return {
      kind: 'CHIP_EV',
      noteZh:
        `跟注 EV = ${ev.toFixed(2)} 筹码（节点增量口径，弃牌 EV ≡ 0）` +
        `⇒ 由**真实 chip EV 排名**判定：${ev > 0 ? 'CALL' : 'FOLD'} 更高` +
        (Math.abs(ev) <= input.uncertaintyBand
          ? `（差距在模型容差带 ±${input.uncertaintyBand.toFixed(2)} 内 ⇒ 置信度更低，但**不改变 EV 排名**）`
          : ''),
    };
  }
  const evidenceKinds: readonly string[] = [
    'SUPPORTED_ACTION_PRIORITY',
    'HEURISTIC_TIEBREAK',
    'STRATEGIC_HEURISTIC',
    'FALLBACK',
    'HARD_CONSTRAINT',
  ];
  if (input.evidenceSource !== undefined && input.evidenceSource !== null && evidenceKinds.includes(input.evidenceSource)) {
    return {
      kind: input.evidenceSource as DecisionBasisKind,
      noteZh:
        `来源 = ${input.evidenceSource}` +
        (input.evidenceNoteZh === undefined || input.evidenceNoteZh === null ? '' : ` —— ${input.evidenceNoteZh}`) +
        (input.evidenceSource === 'STRATEGIC_HEURISTIC' || input.evidenceSource === 'HEURISTIC_TIEBREAK'
          ? '。⚠️ 加注 EV 不可得（缺 fold-to-3bet / call-3bet / 4bet 响应数据）⇒ 这是**战略启发式**，不是 EV 结论'
          : ''),
    };
  }
  return {
    kind: 'SAFETY_RULE',
    noteZh:
      '加注/全下：只有**合法性/输入安全**才配叫安全约束；本条是真正的安全规则（`shouldRaise` 量级保护 + 权益优势），' +
      '且当前没有更高质量的证据可选',
  };
}

/** 违规 → 一行用户可见的文本（生产环境直接显示这个） */
export function consistencyErrorZh(violations: readonly ConsistencyViolation[]): string {
  return (
    'DECISION_CONSISTENCY_ERROR：本次输出内部不一致，**不要据此行动**，请把这条反馈给开发者 —— ' +
    violations.map((v) => `[${v.code}] ${v.textZh}`).join('；')
  );
}

export type ConsistencyInput = {
  street: string;
  action: string | null;
  actionable: boolean;
  legalActions: readonly string[];
  sizeChips: number | null;
  pot: number;
  callCost: number;
  requiredEquity: number;
  /** 节点增量 chip EV（跟注）；没有为 null */
  callEV: number | null;
  /**
   * **模型容差带**（筹码），通常 = `MODEL_UNCERTAINTY_RATIO × winnable`。
   *
   * ⚠️ 它是**工程容差**，不是数学无差异（P0-2）：守卫只用它来核对
   * 「覆盖是否发生在带内」，**不**用它判断谁更优。
   */
  uncertaintyBand: number;
  /** 是否显式开启了不确定性覆盖（默认关闭） */
  allowUncertaintyOverride?: boolean;
  /** 本次动作是否由覆盖规则产生 */
  overrodeByUncertainty?: boolean;
  /** 当前街角色（翻前为 null） */
  role: RelativeHandRole | null;
  /** 未来补牌保护分（河牌必须为 0） */
  futureCardProtectionScore: number | null;
  /** 未来街承诺加分（河牌必须为 0） */
  futureStreetCommitmentBonus: number | null;
  /** 偏好分（面对下注时是 CALL/RAISE/FOLD；无人下注时是 CHECK/BET_*） */
  preferenceScores: readonly { action: string; score: number }[];
  /** 已经产出的警告文本（用于检查「EV 为负 + 另一体系动作」的自相矛盾） */
  warningsZh: readonly string[];
  /**
   * 结算事件的一致性事实（由结算层提供；没有结算层信息时传 null）。
   *
   * ```text
   * prematureFinalReturns —— 行动尚未结束却已产生的「最终退回」
   * duplicateEventIds     —— 同一结算事件出现多次
   * ```
   */
  settlement?: {
    pendingReturnTotal: number;
    finalReturnTotal: number;
    duplicateEventIds: readonly string[];
    roundClosed: boolean;
  } | null;
};

/**
 * 逐项检查一致性。返回**全部**违规（不短路），便于一次修完。
 */
export function validateDecisionConsistency(input: ConsistencyInput): ConsistencyViolation[] {
  const out: ConsistencyViolation[] = [];
  const push = (code: ConsistencyCode, textZh: string): void => {
    out.push({ code, textZh });
  };

  /* ---- A / B：河牌不存在听牌与半诈唬（【数学确定】）---- */
  if (input.street === 'RIVER' && input.role !== null) {
    if (input.role === 'DRAW') {
      push('RIVER_ROLE_DRAW', '河牌被标记为「听牌」—— 河牌之后没有公共牌，「听牌」在语义上不可能存在');
    }
    if (input.role === 'SEMI_BLUFF') {
      push('RIVER_ROLE_SEMI_BLUFF', '河牌被标记为「半诈唬」—— 半诈唬与听牌同源，河牌同样不可能存在');
    }
  }

  /* ---- C：最终动作必须合法（【工程约束】）---- */
  if (input.action !== null && !input.legalActions.includes(input.action)) {
    push('ACTION_NOT_LEGAL', `最终动作 ${input.action} 不在合法集合 [${input.legalActions.join(', ')}] 内`);
  }

  /* ---- D：底池与跟注额必须非负且有限（【数学确定】）---- */
  if (!Number.isFinite(input.pot) || input.pot < 0) {
    push('POT_OR_CALL_INVALID', `底池不是有限的非负数（${input.pot}）`);
  }
  if (!Number.isFinite(input.callCost) || input.callCost < 0) {
    push('POT_OR_CALL_INVALID', `跟注额不是有限的非负数（${input.callCost}）`);
  }
  if (input.sizeChips !== null && (!Number.isFinite(input.sizeChips) || input.sizeChips < 0)) {
    push('POT_OR_CALL_INVALID', `建议尺寸不是有限的非负数（${input.sizeChips}）`);
  }

  /* ---- E：所需权益必须落在 0..1（【数学确定】）---- */
  if (!Number.isFinite(input.requiredEquity) || input.requiredEquity < 0 || input.requiredEquity > 1) {
    push('REQUIRED_EQUITY_OUT_OF_RANGE', `所需权益不在 [0,1] 内（${input.requiredEquity}）`);
  }

  /* ---- F / G / H：动作必须与所选指标同体系 ----
   *
   * 判据严格按 `decisionBasisOf` 反推出的**依据种类**：
   *
   * | 依据 | 要求 |
   * |---|---|
   * | `CHIP_EV` | 动作 = 最高 EV 动作（CALL 要求 EV > +ε；FOLD 要求 EV < −ε） |
   * | `MATH_INDIFFERENCE` | 只允许在 `|EV| ≤ 1e-6` 时出现，且只允许 CALL / FOLD |
   * | `MODEL_UNCERTAINTY_OVERRIDE` | 只在**开启**覆盖且 `|EV| ≤ 容差带` 时允许偏离 EV 排名 |
   * | `PREFERENCE_SCORE` | 动作 = 对应节点里的最高偏好分动作 |
   * | `SAFETY_RULE` | 不做偏好/EV 一致性断言（但其余检查照旧） |
   */
  const basis = decisionBasisOf({
    action: input.action,
    actionable: input.actionable,
    facingBet: input.callCost > 0,
    callEV: input.callEV,
    uncertaintyBand: input.uncertaintyBand,
    ...(input.allowUncertaintyOverride === undefined
      ? {}
      : { allowUncertaintyOverride: input.allowUncertaintyOverride }),
    ...(input.overrodeByUncertainty === undefined
      ? {}
      : { overrodeByUncertainty: input.overrodeByUncertainty }),
  });

  if (basis.kind === 'CHIP_EV' && input.callEV !== null) {
    /*
     * 真实 EV 排名必须被遵守（P0-2）：`0 > −317.61` 时不得建议跟注。
     * 阈值是**浮点余量**（1e-6 筹码），不是 5% 容差带。
     */
    if (input.action === 'CALL' && input.callEV < -MATH_EV_EPSILON) {
      push(
        'ACTION_CONTRADICTS_CHIP_EV',
        `依据是 chip EV 排名，但跟注 EV = ${input.callEV.toFixed(2)} 筹码为负（弃牌 EV ≡ 0 更高）却建议跟注 —— ` +
          '容差带（工程不确定性）**不构成**偏离 EV 排名的理由，除非显式开启覆盖并标注',
      );
    }
    if (input.action === 'FOLD' && input.callEV > MATH_EV_EPSILON) {
      push(
        'ACTION_CONTRADICTS_CHIP_EV',
        `依据是 chip EV 排名，但跟注 EV = ${input.callEV.toFixed(2)} 筹码为正却建议弃牌`,
      );
    }
  }
  if (basis.kind === 'MATH_INDIFFERENCE' && input.callEV !== null) {
    if (Math.abs(input.callEV) > MATH_EV_EPSILON + 1e-12) {
      push(
        'ACTION_CONTRADICTS_CHIP_EV',
        `动作被标为「数学上无差异」，但 |跟注 EV| = ${Math.abs(input.callEV).toFixed(4)} 已超出浮点余量 ${MATH_EV_EPSILON}`,
      );
    }
  }
  if (basis.kind === 'MODEL_UNCERTAINTY_OVERRIDE') {
    if (input.allowUncertaintyOverride !== true) {
      push(
        'ACTION_CONTRADICTS_CHIP_EV',
        '动作被标为「不确定性覆盖」，但**没有**显式开启 `allowUncertaintyOverride` —— 工程容差不得自动翻转动作',
      );
    }
    if (input.callEV !== null && Math.abs(input.callEV) > input.uncertaintyBand + 1e-9) {
      push(
        'ACTION_CONTRADICTS_CHIP_EV',
        `动作被标为「容差带内覆盖」，但 |跟注 EV| = ${Math.abs(input.callEV).toFixed(2)} 已超出容差带 ±${input.uncertaintyBand.toFixed(2)}`,
      );
    }
    if (input.action !== 'CALL' && input.action !== 'FOLD') {
      push('ACTION_CONTRADICTS_CHIP_EV', `不确定性覆盖只适用于跟注/弃牌，实际动作是 ${String(input.action)}`);
    }
  }
  if (basis.kind === 'PREFERENCE_SCORE' && input.action !== null && input.preferenceScores.length > 0) {
    const familyOf = (a: string): string => (a.startsWith('BET') ? 'BET' : a);
    const best = new Map<string, number>();
    for (const s of input.preferenceScores) {
      best.set(familyOf(s.action), Math.max(best.get(familyOf(s.action)) ?? 0, s.score));
    }
    const family = familyOf(input.action);
    const topEntry = [...best.entries()].sort((a, b) => b[1] - a[1])[0]!;
    if (topEntry[0] !== family) {
      push(
        'ACTION_CONTRADICTS_PREFERENCE',
        `依据是偏好分，但最高偏好分是 ${topEntry[0]}（${topEntry[1].toFixed(2)}），最终动作却是 ${input.action}（${(best.get(family) ?? 0).toFixed(2)}）`,
      );
    }
  }

  /* ---- H：不得「EV 为负警告 + 未解释的另一体系动作」---- */
  const negativeEvWarning = input.warningsZh.some(
    (w) => w.includes('EV 为负') || w.includes('EV为负') || w.includes('数学上不成立'),
  );
  if (negativeEvWarning) {
    if (input.action === 'CALL' && (input.callEV === null || input.callEV < 0)) {
      push(
        'EV_WARNING_CONTRADICTS_ACTION',
        '输出里同时出现「跟注 EV 为负」警告与「建议跟注」—— 两句话必须口径一致（要么改警告措辞，要么改动作）',
      );
    }
  }

  /* ---- I / J：河牌的未来补牌保护分与未来街承诺加分必须为 0（【数学确定】）---- */
  if (input.street === 'RIVER') {
    if (input.futureCardProtectionScore !== null && input.futureCardProtectionScore !== 0) {
      push(
        'RIVER_FUTURE_CARD_PROTECTION_NONZERO',
        `河牌的未来补牌保护分必须为 0，实际 ${input.futureCardProtectionScore}`,
      );
    }
    if (input.futureStreetCommitmentBonus !== null && input.futureStreetCommitmentBonus !== 0) {
      push(
        'RIVER_FUTURE_STREET_COMMITMENT_NONZERO',
        `河牌的未来街承诺加分必须为 0，实际 ${input.futureStreetCommitmentBonus}`,
      );
    }
  }

  /* ---- K：未完成行动节点不得出现最终未跟注退回（【工程约束】）---- */
  if (input.settlement != null) {
    const s = input.settlement;
    if (!s.roundClosed && s.finalReturnTotal > 0) {
      push(
        'SETTLEMENT_PREMATURE',
        `下注轮尚未结束（还有人可以跟注）却已产生最终退回 ${s.finalReturnTotal} —— ` +
          `那笔钱只是**尚未匹配**（${s.pendingReturnTotal}），不是退回`,
      );
    }
    if (s.duplicateEventIds.length > 0) {
      push('SETTLEMENT_DUPLICATE', `同一结算事件出现多次：${s.duplicateEventIds.join(', ')}`);
    }
  }

  return out;
}
