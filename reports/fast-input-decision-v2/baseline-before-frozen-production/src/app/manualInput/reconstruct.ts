/**
 * 手动输入 → GameState 重建
 *
 * ## 这个模块在端到端链中解决什么
 *
 * 用户填的是「谁在什么位置做了什么」；引擎需要的是一个**可校验的牌局状态**
 * （底池、各人投入、剩余筹码、当前注额、跟注需要、合法动作）。
 *
 * 本模块负责这次转换，并且**用引擎重算一切**，而不是相信用户填的数字。
 *
 * ## 五条关键纪律
 *
 * ### 1. 座位按位置**顺时针**排列
 *
 * `createGame` 按位置顺时针排座，`applyAction` 用这个顺序推导行动权。
 * 6 人桌：[UTG, HJ, CO, BTN, SB, BB]；9 人桌在此基础上多 UTG1/UTG2/LJ。
 * 位置与桌型不匹配时给出可读中文错误，而不是让异常冒到界面上。
 *
 * ### 2. 行动按**输入顺序**重放，逐条校验
 *
 * 每条行动都经过 `applyAction`。它返回 `ok: false` 时说明这一条
 * **在规则上不可能发生**（例如在无人下注时「跟注」、已经弃牌的人又行动）。
 * 此时**阻断**并指出是第几条 —— 绝不「跳过这条继续算」。
 *
 * ### 3. 街道按需**自动推进**
 *
 * 行动记录只到「本街下注轮结束」为止。要分析翻牌就必须推进到翻牌。
 * 推进需要公共牌，而公共牌来自用户填写的 `board`。
 *
 * ⚠️ **公共牌不能在建局时预填**：`advanceStreet` 会发牌，
 * 预填会导致「发两次」并触发 `ISSUE.DUPLICATE_CARD`（实测踩到）。
 *
 * ### 4. 底池以**引擎重算**为准，用户填的只用于对照
 *
 * 用户**可选**地声明底池；未声明时不做对照（没有声明可对照）。
 * 两种情况下进入决策的都是重算值。
 *
 * ### 5. 必须有**真实决策点**
 *
 * 若重放后没有轮到 Hero 行动，说明记录不完整 —— 此时**阻断**。
 * 否则会出现最危险的一类输出：**对一个不存在的决策点给出自信建议**
 *（实测：翻牌前所有人都已跟平，系统却输出「建议：过牌」）。
 */

import {
  Position,
  Street,
  TableSize,
  ActionType,
  positionsForTableOf,
  type Card,
} from '../../domain/types.ts';
import {
  createGame,
  computePot,
  playerById,
  type ActionCommand,
  type GameState,
  type PlayerSeed,
  type PlayerState,
} from '../../domain/poker/gameState.ts';
import { applyAction, actorOnTurn, type Issue } from '../../domain/poker/engine.ts';
import { advanceStreet } from '../../domain/poker/streetAdvance.ts';
import { validateGameState, type ValidationResult } from '../../domain/poker/validator.ts';
import type { ManualAction, ManualActionType, ParsedManualInput } from './manualInput.ts';
import { DEFAULT_BIG_BLIND_CHIPS, POSITION_ZH, STREET_ZH } from './manualInput.ts';

/* ============================================================
 * 结果类型
 * ============================================================ */

export type ReconstructIssue = {
  code:
    | 'TABLE_SETUP_FAILED'
    | 'ACTION_REJECTED'
    | 'ACTION_NOT_ACTOR'
    | 'HISTORY_DOES_NOT_REACH_STREET'
    | 'HISTORY_OVERSHOOTS_STREET'
    /** 当前没有轮到 Hero 行动 → 没有可分析的决策点 */
    | 'DECISION_POINT_NOT_AVAILABLE'
    | 'INTERNAL_ERROR';
  /** 中文说明 */
  message: string;
  /** 出问题的行动序号（1-based）；非行动相关时为 undefined */
  actionIndex?: number;
};

export type ReconstructResult =
  | {
      ok: true;
      state: GameState;
      /** 引擎重算的底池（筹码单位） */
      computedPot: number;
      /** 用户声明的底池换算成筹码单位；`null` = 未声明 */
      claimedPot: number | null;
      warnings: readonly ReconstructIssue[];
    }
  | { ok: false; issues: readonly ReconstructIssue[] };

/**
 * 重建模式。
 *
 * ## 为什么必须有第二种模式
 *
 * | | `ANALYZE`（默认） | `PREVIEW` |
 * |---|---|---|
 * | 用途 | 出决策 | 牌桌实时显示「轮到谁 / 底池 / 合法动作」 |
 * | `input.street` | **必须**与实际推进结果一致 | **忽略**（以行动记录为准自动定位） |
 * | 街道推进 | 推进到声明的街；推不动就报错 | 能推多远推多远；推不动就**如实报告停在哪** |
 * | 决策点 | **必须**轮到 Hero，否则阻断 | 不要求；谁行动就报谁 |
 * | 本手已结束 | 报错 | 如实报告 `phase = COMPLETE` |
 *
 * 🔴 **为什么 PREVIEW 不是「放宽校验」**：它不放过任何一条非法动作 ——
 * 行动顺序、金额、最小加注、短全下重开规则全部照旧由 Poker Core 判定。
 * 它只是**不再要求「当前必须轮到 Hero」**，因为牌桌 UI 需要显示
 * 其他玩家的合法动作（规范：前端不得自行推断合法动作）。
 *
 * ⚠️ ANALYZE 的行为**逐位不变**（既有 1119 项测试的前提）。
 */
export const ReconstructMode = {
  ANALYZE: 'ANALYZE',
  PREVIEW: 'PREVIEW',
} as const;
export type ReconstructMode = (typeof ReconstructMode)[keyof typeof ReconstructMode];

export type ReconstructOptions = {
  mode?: ReconstructMode;
};

/* ============================================================
 * 动作映射
 * ============================================================ */

/** 手动动作 → 领域动作类型 */
const ACTION_TYPE_MAP: Readonly<Record<ManualActionType, ActionType>> = Object.freeze({
  FOLD: ActionType.FOLD,
  CHECK: ActionType.CHECK,
  CALL: ActionType.CALL,
  BET: ActionType.BET,
  RAISE: ActionType.RAISE,
  ALL_IN: ActionType.ALL_IN,
});

/** 街道顺序（用于判定「该动作属于当前街还是下一街」） */
const STREET_SEQUENCE: readonly Street[] = [
  Street.PREFLOP,
  Street.FLOP,
  Street.TURN,
  Street.RIVER,
];

function streetRank(street: Street): number {
  return STREET_SEQUENCE.indexOf(street);
}

/**
 * 公共牌张数允许推进到的最远街道。
 *
 * | 张数 | 最远街道 | 说明 |
 * |---|---|---|
 * | 0 | 翻牌前 | |
 * | 1~2 | 翻牌前 | **选择中**：翻牌还没选够，不能推进 |
 * | 3 | 翻牌 | |
 * | 4 | 转牌 | |
 * | 5 | 河牌 | |
 *
 * ⚠️ 1~2 张刻意按「翻牌前」处理，而不是抛错：
 * 牌桌 UI 允许用户先点第 1、2 张翻牌牌面（那是正常的中间态），
 * 此时**不能**推进街道，只能停在翻牌前 —— 这正是「选择中」的定义。
 */
function streetRankFromBoard(cardCount: number): number {
  if (cardCount >= 5) return 3;
  if (cardCount === 4) return 2;
  if (cardCount === 3) return 1;
  return 0;
}

/**
 * 把「加注到 X」换成本街口径的筹码数。
 *
 * 手动输入的 `amountBB` 对 BET/RAISE/ALL_IN 是「**加注到**的本街总额」，
 * 而 `ActionCommand.amount` 在引擎里也是「加注到的总额（本街口径）」——
 * 两者语义一致，只需按大盲换算。
 *
 * CALL 的 `amountBB` 是「本次投入」，引擎同样按「本次需要投入」处理，一致。
 */
function toChips(amountBB: number | undefined, bigBlindChips: number): number | undefined {
  if (amountBB === undefined) return undefined;
  return Math.round(amountBB * bigBlindChips);
}

/* ============================================================
 * 重建
 * ============================================================ */

/**
 * 由输入解析出「1BB 等于多少筹码」。
 *
 * 非法值（0 / 负数 / NaN / Infinity / 小数 / <2）在 `parseManualInput` 阶段
 * 已被 `INVALID_NUMBER` 拦下，这里再做一次防御：
 * **任何非法值都退回默认值**，绝不产生「1BB = 0 筹码」这种会让后续
 * 所有换算归零、或让常见下注额被静默取整的比例尺。
 */
export function bigBlindChipsOf(input: { bigBlindBB?: number }): number {
  const value = input.bigBlindBB;
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_BIG_BLIND_CHIPS;
  }
  // 只在非整数 / 小于 2 时退回默认值 —— 与解析层的判据保持一致
  if (!Number.isInteger(value) || value < 2) return DEFAULT_BIG_BLIND_CHIPS;
  return value;
}

/** 每个位置一个稳定的玩家 id（同一位置在多手之间保持同一 id） */
export function playerIdOfPosition(position: Position): string {
  return `seat_${position}`;
}

/**
 * 由手动输入重建牌局状态。
 *
 * ## 盲注会由 `createGame` 自动下
 *
 * 因此 `actionHistory` **不应**包含 `POST_SB` / `POST_BB`；
 * 用户只需从第一个主动动作开始填。
 */
export function reconstructGameState(
  input: ParsedManualInput,
  options: ReconstructOptions = {},
): ReconstructResult {
  const mode: ReconstructMode = options.mode ?? ReconstructMode.ANALYZE;
  const preview = mode === ReconstructMode.PREVIEW;
  const issues: ReconstructIssue[] = [];
  const warnings: ReconstructIssue[] = [];

  // ---- 大盲换算比例尺 ----
  //
  // 🔴 **红队 F-07：这里以前硬编码 `100`，`input.bigBlindBB` 从未被读取。**
  //
  // 后果：`manualInput.ts` 的文档说这个字段「用于把 BB 单位换算成筹码单位」，
  // 而它实际上是一个**死字段** —— 界面/调用方以为自己在指定盲注级别，
  // 实际没有任何效果，且校验器还会老老实实地拦下非法值，
  // 让「它一定有用」这个错觉更牢固。
  //
  // 现在按文档行事：`bigBlindBB` 就是「1BB 等于多少筹码」。
  // - 未填 → `DEFAULT_BIG_BLIND_CHIPS`（= 100，与历史行为逐位一致）
  // - 填了 → 用它，于是界面上的筹码数字与真实盲注级别对应
  //
  // ⚠️ 这只影响**筹码口径的显示与记录**，不影响任何 BB 口径的判断
  // （底池赔率、SPR、所需权益都是无量纲比值）。这一点写进注释是为了
  // 防止后来者误以为「改这个字段能改建议」。
  const bigBlindChips = bigBlindChipsOf(input);
  const smallBlindChips = Math.round(bigBlindChips / 2);
  const stackChips = Math.round(input.effectiveStackBB * bigBlindChips);

  const positions = positionsForTableOf(input.tableSize as TableSize);

  // ---- 1. 座位 ----
  //
  // 🔴 **只给本手参与者发牌**（Table Topology Correction）：
  //    修复前这里对容量的**每一个**座位都建玩家，于是 9 座桌必然是 9 人，
  //    少一个人就无法分析。现在参与者由 `input.occupiedPositions` 决定，
  //    空座位根本不存在于牌局里 —— 但物理座位环不变（盲注与行动顺序
  //    仍按座位环绕，跳过空座）。
  //
  // 筹码优先级（逐座位，从具体到笼统）：
  //   1. `seatStacksBB[position]` —— 牌桌 UI 的逐座位筹码（最具体）
  //   2. `villain.stackBB` —— 单人表单时代的「所有对手共用一个筹码」
  //   3. `effectiveStackBB` —— 缺省：所有人与 Hero 相同
  //
  // ⚠️ Hero 座位由 `effectiveStackBB` 决定（历史行为，逐位一致）；
  // 若 `seatStacksBB` 里**显式**给了 Hero 的筹码，以它为准 ——
  // 牌桌 UI 会把 Hero 的座位筹码写在里面。
  const stackChipsOf = (position: Position): number => {
    const explicit = input.seatStacksBB[position];
    if (explicit !== undefined && Number.isFinite(explicit) && explicit > 0) {
      return Math.round(explicit * bigBlindChips);
    }
    if (position === input.heroPosition) return stackChips;
    return input.villain.stackBB !== undefined && Number.isFinite(input.villain.stackBB)
      ? Math.round(input.villain.stackBB * bigBlindChips)
      : stackChips;
  };

  // 参与者的座位顺序必须是**物理座位序**（不是调用方给的顺序）——
  // 顺序会影响 `createGame` 内部的座位排序，进而影响行动顺序。
  const participating = positions.filter((p) => input.occupiedPositions.includes(p));

  const seeds: PlayerSeed[] = participating.map((position) => ({
    id: playerIdOfPosition(position),
    name: POSITION_ZH[position],
    position,
    startingStack: stackChipsOf(position),
    ...(position === input.heroPosition ? { holeCards: input.heroCards as readonly Card[] } : {}),
  }));

  // ---- 2. 建局（含盲注）----
  //
  // ⚠️ **刻意不把公共牌传给 `createGame`**：
  // `advanceStreet` 在推进街道时会发牌，若建局时已预填，
  // 就会「发两次」并触发 `ISSUE.DUPLICATE_CARD`（实测踩到）。
  // 公共牌统一由 `advanceToStreet` 在推进时按街切片发出。
  let state: GameState;
  try {
    state = createGame({
      config: {
        tableSize: input.tableSize as TableSize,
        smallBlind: smallBlindChips,
        bigBlind: bigBlindChips,
        ante: 0,
        // 🔴 Button 是**物理座位**，不是从 Hero 位置反推的（规范第 15 条）。
        //    有空座位时「Button 的下一位是小盲」不再成立，因此必须显式给出。
        dealerPosition: input.buttonPosition,
      },
      players: seeds,
      userPlayerId: playerIdOfPosition(input.heroPosition),
      createdAt: '2026-09-13T00:00:00.000Z', // 固定时刻 → 确定性
    });
  } catch (error) {
    return {
      ok: false,
      issues: [
        {
          code: 'TABLE_SETUP_FAILED',
          message:
            `无法建立牌局：${(error as Error).message}。` +
            '请检查桌型、位置与筹码设置是否匹配',
        },
      ],
    };
  }

  // 用户声明的底池（**仅用于对照，不参与计算**）。
  //
  // 未声明（`claimedPotBB === null`）时**不设置** `state.claimedPot`：
  // 于是 `comparePot` 不会报「不一致」—— 没有声明就没有可对照的对象。
  if (input.claimedPotBB !== null) {
    state.claimedPot = Math.round(input.claimedPotBB * bigBlindChips);
  }

  // ---- 3. 逐条重放 ----
  //
  // ⚠️ 每条动作都可能属于不同的街。若该动作的街晚于当前状态，
  // 必须**先推进街道**再执行 —— 否则会得到 `NOT_PLAYERS_TURN`
  //（实测：翻牌前的 `CHECK` 与翻牌后的 `CHECK` 金额都是 0，无法靠金额区分）。
  let currentActionStreet: Street = Street.PREFLOP;
  for (const [index, action] of input.actionHistory.entries()) {
    const ordinal = index + 1;

    const actionStreet: Street = action.street ?? currentActionStreet;
    if (streetRank(actionStreet) < 0) {
      return {
        ok: false,
        issues: [
          ...issues,
          {
            code: 'ACTION_REJECTED',
            message: `第 ${ordinal} 条行动记录的街道「${String(actionStreet)}」不合法`,
            actionIndex: ordinal,
          },
        ],
      };
    }
    currentActionStreet = actionStreet;

    if (streetRank(state.street) < streetRank(actionStreet)) {
      const advanced = advanceToStreet(state, actionStreet, input.board);
      if (!advanced.ok) {
        return { ok: false, issues: [...issues, { ...advanced.issue, actionIndex: ordinal }] };
      }
      state = advanced.state;
    } else if (streetRank(state.street) > streetRank(actionStreet)) {
      return {
        ok: false,
        issues: [
          ...issues,
          {
            code: 'ACTION_REJECTED',
            message:
              `第 ${ordinal} 条行动记录属于「${STREET_ZH[actionStreet]}」，` +
              `但此时牌局已经进行到「${STREET_ZH[state.street]}」—— 记录顺序有误`,
            actionIndex: ordinal,
          },
        ],
      };
    }

    const actorId = playerIdOfPosition(action.position);
    const actor = playerById(state, actorId);

    if (!actor) {
      return {
        ok: false,
        issues: [
          ...issues,
          {
            code: 'ACTION_REJECTED',
            message: `第 ${ordinal} 条行动记录的位置「${POSITION_ZH[action.position]}」不在本局中`,
            actionIndex: ordinal,
          },
        ],
      };
    }

    // 行动顺序校验：给出比引擎更可读的中文提示
    const expected = actorOnTurn(state);
    if (expected !== null && expected !== actorId) {
      const expectedPlayer = playerById(state, expected);
      return {
        ok: false,
        issues: [
          ...issues,
          {
            code: 'ACTION_NOT_ACTOR',
            message:
              `第 ${ordinal} 条行动记录是「${POSITION_ZH[action.position]}」，` +
              `但按行动顺序现在应该轮到「${expectedPlayer?.name ?? expected}」。` +
              '请检查行动记录的顺序与完整性',
            actionIndex: ordinal,
          },
        ],
      };
    }

    const chips = toChips(action.amountBB, bigBlindChips);
    const command: ActionCommand = {
      playerId: actorId,
      type: ACTION_TYPE_MAP[action.type],
      ...(chips !== undefined ? { amount: chips } : {}),
      manuallyEntered: true,
    };

    const result = applyAction(state, command);
    if (!result.ok) {
      // 🔴 红队 F-08：把引擎的机器码翻译成「用户下一步该怎么做」。
      //
      // 修复前「全下 8BB」被拒绝时，用户看到的是
      // 「全下金额不一致：全下必须投入全部剩余筹码 10000，实际提交 800」
      // —— 它没说**哪来的 10000**，也没说**怎么才能填对**。
      // 短筹码对手全下是现金局最常见的局面之一，卡在这里等于功能缺失。
      const hint = actionableHintForAction(result.issues, actor, input, bigBlindChips);
      return {
        ok: false,
        issues: [
          ...issues,
          {
            code: 'ACTION_REJECTED',
            message:
              `第 ${ordinal} 条行动记录被规则拒绝：${describeIssues(result.issues)}。` +
              `（记录内容：${POSITION_ZH[action.position]} ${action.type}` +
              `${action.amountBB !== undefined ? ` ${action.amountBB}BB` : ''}）` +
              (hint !== null ? `\n👉 ${hint}` : ''),
            actionIndex: ordinal,
          },
        ],
      };
    }
    state = result.state;
  }

  // ---- 4. 推进街道 ----
  //
  // 行动记录只到「本街下注轮结束」为止。用户说当前在翻牌时，
  // 若记录里只有翻牌前的行动，必须推进才能得到翻牌决策点。
  if (preview) {
    /*
     * PREVIEW：**能推多远推多远** —— 与增量侧（`tableOps.applyTableAction`）
     * 共用同一个规范步骤 `settleCanonicalStreet`，不再各写一遍循环。
     *
     * 判据只有两条，缺一不可：
     *   1. 本街下注轮确实已经结束（`bettingRoundComplete`）
     *   2. 公共牌够下一街用（翻牌 3 张 / 转牌 4 张 / 河牌 5 张）
     *
     * 两条都不满足时**不报错**，而是如实停在当前街 —— 牌桌 UI 需要
     * 显示「翻牌前还没打完」这种正常中间态，把它当成错误会让
     * 每一次点击都弹一次红字。
     */
    const settled = settleCanonicalStreet(state, input.board);
    if (settled.overrun) {
      return {
        ok: false,
        issues: [...issues, { code: 'INTERNAL_ERROR', message: '街道推进次数异常（内部错误）' }],
      };
    }
    // PREVIEW 下推进失败 = 公共牌不足 → 停在当前街（不是错误）
    if (settled.stoppedByBoard !== null) warnings.push(settled.stoppedByBoard);
    state = settled.state;
  } else {
    const advanced = advanceToStreet(state, input.street, input.board);
    if (!advanced.ok) {
      return { ok: false, issues: [...issues, advanced.issue] };
    }
    state = advanced.state;

    // ---- 5. 街道一致性（推进后仍不一致 → 记录不完整）----
    if (state.street !== input.street) {
      const diff =
        streetRank(state.street) < streetRank(input.street)
          ? 'HISTORY_DOES_NOT_REACH_STREET'
          : 'HISTORY_OVERSHOOTS_STREET';
      const message =
        diff === 'HISTORY_DOES_NOT_REACH_STREET'
          ? `你选择当前是「${STREET_ZH[input.street]}」，但行动记录只推进到「${STREET_ZH[state.street]}」。` +
            '请补齐从翻牌前到当前街道的全部行动'
          : `行动记录推进到了「${STREET_ZH[state.street]}」，已经超过你选择的「${STREET_ZH[input.street]}」`;
      return { ok: false, issues: [...issues, { code: diff, message }] };
    }
  }

  // ---- 6. 必须有真实决策点（**仅 ANALYZE 模式**）----
  //
  // ⚠️ 不检查就会出现最危险的一类输出：**对不存在的决策点给出自信建议**。
  // 实测：翻牌前所有人都已跟平（无待行动者），系统却对 Hero 输出
  // 「建议：过牌」—— 那个「过牌」既不是他的轮次，也不属于任何街。
  //
  // PREVIEW 模式不查这一条：牌桌 UI 要显示的正是「现在轮到谁」，
  // 包括「轮到别人」和「本手已结束」。决策点检查在 Analyze 路径上照旧。
  if (!preview) {
    if (state.phase === 'COMPLETE') {
      return {
        ok: false,
        issues: [
          ...issues,
          {
            code: 'HISTORY_OVERSHOOTS_STREET',
            message: '行动记录已导致本手牌结束（只剩一人或已摊牌），没有可分析的决策点',
          },
        ],
      };
    }
    if (state.bettingRoundComplete || actorOnTurn(state) !== playerIdOfPosition(input.heroPosition)) {
      const waiting = actorOnTurn(state);
      const waitingPlayer = waiting !== null ? playerById(state, waiting) : undefined;
      return {
        ok: false,
        issues: [
          ...issues,
          {
            code: 'DECISION_POINT_NOT_AVAILABLE',
            message:
              `当前没有轮到「${POSITION_ZH[input.heroPosition]}」行动，因此没有可分析的决策点。` +
              (waitingPlayer !== undefined
                ? `按行动记录，现在应该轮到「${waitingPlayer.name}」。`
                : '按行动记录，本街下注轮已经结束。') +
              '请补齐到「轮到你行动」为止的行动记录',
          },
        ],
      };
    }
  }

  return {
    ok: true,
    state,
    computedPot: computePot(state),
    // `null` 表示「用户未声明底池」——**不能**退化成 0，
    // 否则「没填」会被当成「声明底池为 0」并触发一次假的 POT_MISMATCH。
    claimedPot: state.claimedPot ?? null,
    warnings: Object.freeze(warnings),
  };
}

/* ============================================================
 * 街道推进
 * ============================================================ */

/**
 * 反复推进街道直到目标街道。
 *
 * ## 需要公共牌
 *
 * `advanceStreet` 需要本街要发的牌（翻牌 3 张、转牌/河牌各 1 张）。
 * 这里从用户填写的 `board` 里**按街切片**：
 * 翻牌 = 前 3 张，转牌 = 第 4 张，河牌 = 第 5 张。
 *
 * 若公共牌不足，推进会被拒绝 —— 此时**如实报错**并指出缺几张，
 * 而不是停在上一街给出一个街道错误的建议。
 */
function advanceToStreet(
  start: GameState,
  target: Street,
  boardCards: readonly Card[],
): { ok: true; state: GameState } | { ok: false; issue: ReconstructIssue } {
  let state = start;
  const boardCardsProvided = boardCards.length;
  let guard = 0;

  while (streetRank(state.street) < streetRank(target)) {
    guard += 1;
    if (guard > 4) {
      return {
        ok: false,
        issue: { code: 'INTERNAL_ERROR', message: '街道推进次数异常（内部错误）' },
      };
    }
    if (!state.bettingRoundComplete) {
      const waiting = actorOnTurn(state);
      const waitingPlayer = waiting !== null ? playerById(state, waiting) : undefined;
      return {
        ok: false,
        issue: {
          code: 'HISTORY_DOES_NOT_REACH_STREET',
          message:
            `要分析「${STREET_ZH[target]}」，但行动记录在「${STREET_ZH[state.street]}」还没结束。` +
            (waitingPlayer !== undefined
              ? `还需要录入「${waitingPlayer.name}」的行动（或他的弃牌/跟注/过牌）。`
              : '请补齐该街剩余的行动。'),
        },
      };
    }

    const nextStreet: Street = STREET_SEQUENCE[streetRank(state.street) + 1]!;
    const result = advanceStreet(state, { cards: boardSliceFor(nextStreet, boardCards) });
    if (!result.ok) {
      const need = nextStreet === Street.FLOP ? 3 : 1;
      return {
        ok: false,
        issue: {
          code: 'HISTORY_DOES_NOT_REACH_STREET',
          message:
            `无法推进到「${STREET_ZH[nextStreet]}」：${result.issues.map((i) => String(i.code)).join('；')}。` +
            `该街需要 ${need} 张公共牌，当前一共只填了 ${boardCardsProvided} 张。`,
        },
      };
    }
    state = result.state;
  }

  return { ok: true, state };
}

/** 按街从用户填写的公共牌里切片 */
function boardSliceFor(street: Street, boardCards: readonly Card[]): readonly Card[] {
  if (street === Street.FLOP) return boardCards.slice(0, 3);
  if (street === Street.TURN) return boardCards.slice(3, 4);
  if (street === Street.RIVER) return boardCards.slice(4, 5);
  return [];
}

/**
 * 规范状态里的那一步 —— **结算下注轮，然后只在公共牌真的够时继续推进街道**。
 *
 * 这是「一条动作之后的规范状态」的**唯一实现**：
 *
 * ```
 * 应用动作 → 结算下注轮 → 只有在公共牌真的够时才推进街道
 *          （发出的必须是**真实存在的牌**，绝不凭空生成）
 * ```
 *
 * 🔴 **为什么必须只有一份实现**：HOTFIX 001 的分叉根因正是两条路径各写一遍。
 * 增量侧（`applyAction` 之后）从不推进街道，重放侧（本文件 PREVIEW）
 * 只要牌够就推 —— 同一个动作在两边结算出两个不同阶段的状态，于是
 * `applyTableAction` 的重放等价自检把**合法动作**判成「内部一致性检查失败」
 * 并拒绝（实测：9 座桌 SB 的 `CALL 1.75`，即关掉翻牌前下注轮的那一步）。
 *
 * ⚠️ **停住不是错误**：公共牌不足时返回 `stoppedByBoard`，由调用方决定
 * 如何处理（PREVIEW 是「如实警告并停在当前街」）。
 */
export function settleCanonicalStreet(
  state: GameState,
  boardCards: readonly Card[],
): { state: GameState; stoppedByBoard: ReconstructIssue | null; overrun: boolean } {
  const boardAllowed = streetRankFromBoard(boardCards.length);
  let next = state;
  let guard = 0;

  while (
    next.bettingRoundComplete &&
    next.phase === 'BETTING' &&
    streetRank(next.street) < boardAllowed
  ) {
    guard += 1;
    // 4 条街最多推进 3 次；再多一定是内部错误，绝不静默继续
    if (guard > 4) return { state: next, stoppedByBoard: null, overrun: true };

    const target = STREET_SEQUENCE[streetRank(next.street) + 1]!;
    const advanced = advanceToStreet(next, target, boardCards);
    if (!advanced.ok) return { state: next, stoppedByBoard: advanced.issue, overrun: false };

    next = advanced.state;
  }

  return { state: next, stoppedByBoard: null, overrun: false };
}

/** 把引擎的 issue 列表变成可读中文（保留原始 code，便于追溯） */
function describeIssues(list: readonly Issue[]): string {
  return list.map((i) => String(i.code)).join('；') || '未给出具体原因';
}

/**
 * 把引擎拒绝某条行动的原因，翻译成「用户下一步该怎么填」。
 *
 * 🔴 红队 F-08 的核心教训：**错误信息要能指导修复，而不只是宣布失败。**
 *
 * 修复前「对手全下 8BB」被拒绝时只回了机器码与一个孤立的期望值，
 * 用户既不知道那个期望值从哪来，也不知道该怎么改。
 * 短筹码对手全下是现金局最常见的局面之一，卡在这里等于功能缺失。
 *
 * @returns 中文建议；无对应建议时返回 `null`（宁可不说，也不乱猜）
 */
function actionableHintForAction(
  issues: readonly Issue[],
  actor: PlayerState,
  input: ParsedManualInput,
  bigBlindChips: number,
): string | null {
  const codes = issues.map((i) => String(i.code));
  const actorName = POSITION_ZH[actor.position as Position];

  if (codes.includes('ISSUE.ALLIN_AMOUNT_MISMATCH')) {
    const stackBB = (actor.startingStack / bigBlindChips).toFixed(2).replace(/\.00$/, '');
    const hasVillainStack = input.villain.stackBB !== undefined;
    return (
      `「${actorName}」的全下金额必须等于其**全部剩余筹码**（本局该座位的起始筹码 = ${stackBB}BB）。` +
      '两种改法任选其一：' +
      `① **不填金额**（留空）表示「投入全部剩余筹码」；` +
      `② 把金额填成 ${stackBB}。` +
      (hasVillainStack
        ? ''
        : `另外，你**没有**填「对手筹码(BB)」，所以该座位按 ${stackBB}BB 处理；` +
          '若真实筹码不同，请填上「对手筹码(BB)」再试。')
    );
  }

  if (codes.includes('ISSUE.RAISE_BELOW_MIN') || codes.includes('ISSUE.RAISE_TOO_SMALL')) {
    return `「${actorName}」的加注额度低于最小加注。请填写「加注到的本街总额」（而不是本次增量），或改用跟注。`;
  }

  if (codes.includes('ISSUE.NOT_ENOUGH_CHIPS')) {
    return `「${actorName}」的筹码不足。「对手筹码(BB)」留空时所有对手按 100BB 处理；短筹码局面请填上该字段。`;
  }

  return null;
}

/* ============================================================
 * 一步到位：解析 + 重建 + 校验
 * ============================================================ */

export type ManualAnalysisGate =
  | {
      ok: true;
      state: GameState;
      computedPot: number;
      /** 用户声明的底池；`null` = 未声明（此时不做一致性对照） */
      claimedPot: number | null;
      validation: ValidationResult;
      warnings: readonly { code: string; message: string }[];
    }
  | {
      ok: false;
      /** 阶段：是解析失败、重建失败，还是校验阻断 */
      stage: 'PARSE' | 'RECONSTRUCT' | 'VALIDATE';
      issues: readonly { code: string; message: string }[];
    };

/**
 * 手动输入 → 可分析状态（含全部阻断检查）。
 *
 * ## 校验参数（与规范一致）
 *
 * - `potMismatchBlocks: true` —— 底池对不上就**阻断**，
 *   绝不「先按用户填的算」（规范第 16 节）
 * - `claimedPot` 取用户声明的值；未声明时**不传**（避免把「没填」当成「填 0」）
 * - `checkActions: true` —— 检查「弃牌后还行动」这类历史矛盾
 */
export function buildAnalyzableState(
  parsed: ParsedManualInput,
  validationOptions: { potTolerance?: number } = {},
): ManualAnalysisGate {
  const reconstructed = reconstructGameState(parsed);
  if (!reconstructed.ok) {
    return {
      ok: false,
      stage: 'RECONSTRUCT',
      issues: reconstructed.issues.map((i) => ({ code: i.code, message: i.message })),
    };
  }

  const validation = validateGameState(reconstructed.state, {
    // 未声明时传 `undefined`（而不是 0）——`comparePot` 会回退到
    // `state.claimedPot`，而它同样未被设置，因此**不报**不一致。
    ...(reconstructed.claimedPot !== null ? { claimedPot: reconstructed.claimedPot } : {}),
    potMismatchBlocks: true,
    checkActions: true,
    ...(validationOptions.potTolerance !== undefined
      ? { potTolerance: validationOptions.potTolerance }
      : {}),
  });

  if (validation.blocked) {
    return {
      ok: false,
      stage: 'VALIDATE',
      issues: validation.blockers.map((b) => ({
        code: String(b.code),
        message: describeBlocker(b.code, b.params),
      })),
    };
  }

  return {
    ok: true,
    state: reconstructed.state,
    computedPot: reconstructed.computedPot,
    claimedPot: reconstructed.claimedPot,
    validation,
    warnings: [
      ...reconstructed.warnings.map((w) => ({ code: w.code, message: w.message })),
      ...validation.warnings.map((w) => ({
        code: String(w.code),
        message: describeBlocker(w.code, w.params),
      })),
    ],
  };
}

/**
 * 把校验器的 issue 变成中文。
 *
 * ⚠️ 为什么不用 `i18n` 层：`i18n` 的词条以界面文案为主，
 * 而这里的 issue 需要一个**带参数**的说明（例如「与公共牌重复的牌是 7♦」）。
 * 本函数集中处理这类参数化文案，界面只需显示 `message`。
 *
 * 未知 code 会**如实显示 code 本身**，而不是编一句含糊的中文 ——
 * 编出来的文案会让「校验器新增了一类阻断但界面没跟上」永远不被发现。
 */
export function describeBlocker(
  code: unknown,
  params: Readonly<Record<string, string | number>> = {},
): string {
  const key = String(code);
  const p = (name: string): string => String(params[name] ?? '?');

  switch (key) {
    case 'ISSUE.DUPLICATE_CARD':
      return `数据冲突：出现了重复的牌 ${p('card')}（例如 Hero 手牌与公共牌是同一张）。请检查录入内容后重新分析。`;
    case 'ISSUE.USER_CARD_ON_BOARD':
      // 校验器实际使用的 code（Hero 手牌与公共牌冲突）
      return `数据冲突：Hero 手牌与公共牌出现重复牌 ${p('card')}。请检查录入内容后重新分析。`;
    case 'ISSUE.DUPLICATE_BOARD_CARD':
      return `数据冲突：公共牌内部出现重复牌 ${p('card')}。请检查公共牌。`;
    case 'ISSUE.BOARD_CONFLICT':
      return `数据冲突：公共牌与已知牌冲突（${p('card')}）。请检查录入内容。`;
    case 'ISSUE.BOARD_COUNT':
      return `公共牌张数与当前街道不匹配（${p('detail') || p('count')}）。`;
    case 'ISSUE.POT_MISMATCH':
      return (
        `底池对不上：你填写的是 ${p('claimed')}，但按行动记录重算得到 ${p('computed')}。` +
        '请检查行动记录或底池填写（系统不会按填写的底池继续计算）。'
      );
    case 'ISSUE.CHIP_NOT_CONSERVED':
      return `筹码不守恒：${p('detail')}。请检查各玩家的起始筹码与投入。`;
    case 'ISSUE.FOLDED_PLAYER_ACTED':
      return `行动记录矛盾：${p('player')} 在弃牌之后又行动了。`;
    case 'ISSUE.NEGATIVE_STACK':
    case 'ISSUE.NEGATIVE_POT':
      return `出现负数的筹码或底池（${p('detail')}）。`;
    case 'ISSUE.UNKNOWN_PLAYER':
      return `行动记录引用了不存在的玩家（${p('playerId')}）。`;
    case 'ISSUE.HOLE_CARDS_REQUIRED':
      return '缺少 Hero 手牌。';
    case 'ISSUE.HOLE_CARDS_DUPLICATE':
      return 'Hero 的两张手牌相同。';
    case 'ISSUE.INVALID_POSITION_FOR_TABLE':
      return `位置与桌型不匹配（${p('position')}）。`;
    case 'ISSUE.USER_NOT_IN_HAND':
      return 'Hero 已经弃牌，本手牌没有属于你的决策点。';
    default:
      return `校验未通过：${key}${Object.keys(params).length > 0 ? `（${JSON.stringify(params)}）` : ''}`;
  }
}

export { playerIdOfPosition as __playerIdOfPosition };
export type { ManualAction };
