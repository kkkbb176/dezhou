/**
 * 牌桌实时预览（后端权威）
 *
 * ## 这个模块在端到端链中解决什么
 *
 * 牌桌上要显示：现在轮到谁、底池多少、他能做什么、跟注要多少。
 * 这些**全部**由后端算出来 —— 前端一行状态机代码都没有。
 *
 * 这么做不是洁癖，是为了消灭一整类 Bug：
 * 前端自己算「轮到谁」，就一定会在「短全下是否重开加注」「小盲在翻牌后先行动」
 * 「谁已经弃牌」这些规则上与引擎分歧，而分歧的表现形式是
 * **牌桌看起来对、后端收到的却是另一个牌局**（本轮最危险的缺陷形态）。
 *
 * ## 复用链（规范第 28 / 29 条）
 *
 * ```
 * 牌桌状态
 *   → tableStateToManualHandInput()   纯转换
 *   → parseManualInput()              同一个结构校验
 *   → reconstructGameState(PREVIEW)   同一个重放器（只是不要求轮到 Hero）
 *   → deriveLegalActions()            与 Decision Engine 同一份合法动作推导
 *   → validateGameState()             Poker Core 校验器
 * ```
 *
 * ⚠️ 与 Analyze 路径**共用**同一个 `tableStateToManualHandInput`。
 * 只要这两条路共用转换点，「屏幕显示 = 实际提交」就是结构性成立的，
 * 而不是靠人工比对维持的。
 */

import { Position, Street } from '../../domain/types.ts';
import { validateGameState } from '../../domain/poker/validator.ts';
import {
  computePot,
  playerById,
  realizedOpponentIds,
  yetToActIds,
  type GameState,
} from '../../domain/poker/gameState.ts';
import { handTopologySeats } from '../../domain/poker/positions.ts';
import { actorOnTurn } from '../../domain/poker/engine.ts';
import { minRaiseTo } from '../../domain/poker/gameState.ts';
import { effectiveStackBetween } from '../../domain/poker/odds.ts';
import { parseManualInput, POSITION_ZH, STREET_ZH, ACTION_ZH, type ManualActionType } from '../manualInput/manualInput.ts';
import {
  ReconstructMode,
  buildAnalyzableState,
  reconstructGameState,
} from '../manualInput/reconstruct.ts';
import { buildSizeGrid, deriveLegalActions, type LegalActions } from '../manualInput/legalActions.ts';
import { tableStateToManualHandInput } from './tableAdapter.ts';
import {
  angleOfVisualIndex,
  effectiveButtonSeatId,
  logicalSeatOrder,
  participantSeatsOf,
  seatById,
  seatIdOfPosition,
  seatOfPosition,
  staffingProblems,
} from './tableState.ts';
import { positionFolded } from './seatLifecycle.ts';
import {
  SeatStatus,
  SEAT_STATUS_ZH,
  AutoAnalyzeState,
  DecisionReasonCode,
  type DecisionReadiness,
  type HandTopologySnapshot,
  type PokerTableState,
  type SeatView,
  type TableActionButton,
  type TableIssue,
  type TablePreview,
} from './table.types.ts';

/* ============================================================
 * 中文标签（画像 / 动态）
 * ============================================================ */

/**
 * 快速画像中文。
 *
 * ⚠️ 这里**必须**是穷举映射：`Record<QuickProfile, string>`。
 * 将来往枚举里加成员而忘了加文案，**编译就会失败** ——
 * 而不是在界面上显示一个英文枚举名。
 */
const QUICK_PROFILE_ZH: Readonly<Record<string, string>> = Object.freeze({
  UNKNOWN: '未知',
  VERY_TIGHT: '很紧',
  TIGHT: '偏紧',
  NORMAL: '正常',
  LOOSE: '偏松',
  VERY_LOOSE: '很松',
  CALLING_STATION: '跟注站',
  AGGRESSIVE: '主动型',
  BLUFF_HEAVY: '爱诈唬',
  UNDERBLUFFER: '很少诈唬',
  MANIAC: '疯狂型',
});

const DYNAMIC_HINT_ZH: Readonly<Record<string, string>> = Object.freeze({
  UNKNOWN: '未知',
  NORMAL: '正常',
  LOOSER_RECENTLY: '最近变松',
  TIGHTER_RECENTLY: '最近变紧',
  AGGRESSION_UP: '最近很激进',
  TILT_SIGNAL: '疑似上头',
  CHASE_LOSS_SIGNAL: '疑似追损',
});

/* ============================================================
 * 座位视图
 * ============================================================ */

function seatsView(
  state: PokerTableState,
  engineState: GameState | null,
  currentActorPosition: Position | null,
  bigBlindChips: number,
  topology: HandTopologySnapshot | null,
): readonly SeatView[] {
  return Object.freeze(
    state.seats.map((seat) => {
      const player = seat.playerId !== null ? state.playersById[seat.playerId] : undefined;
      const enginePlayer =
        engineState !== null ? playerById(engineState, `seat_${seat.logicalPosition}`) : undefined;
      const seatCount = state.seats.length;

      return Object.freeze({
        seatId: seat.seatId,
        logicalPosition: seat.logicalPosition,
        positionZh: POSITION_ZH[seat.logicalPosition],
        visualIndex: seat.visualIndex,
        angleDeg: angleOfVisualIndex(seat.visualIndex, seatCount),
        playerId: seat.playerId,
        displayName: player?.displayName ?? null,
        isHero: seat.logicalPosition === state.heroPosition,
        status: seat.status,
        statusZh:
          SEAT_STATUS_ZH[seat.status] +
          (seat.sitOutNextHand && seat.status !== SeatStatus.SITTING_OUT ? '（下一手暂离）' : ''),
        sitOutNextHand: seat.sitOutNextHand,
        stackBB: seat.stackBB,
        remainingStackBB:
          enginePlayer !== undefined && bigBlindChips > 0
            ? Number((enginePlayer.remainingStack / bigBlindChips).toFixed(2))
            : seat.stackBB,
        committedBB:
          enginePlayer !== undefined && bigBlindChips > 0
            ? Number(
                (Object.values(enginePlayer.committedByStreet).reduce((a, b) => a + b, 0) /
                  bigBlindChips
                ).toFixed(2),
              )
            : 0,
        quickProfileZh: player !== undefined ? (QUICK_PROFILE_ZH[player.quickProfile] ?? '未知') : null,
        dynamicHintZh: player !== undefined ? (DYNAMIC_HINT_ZH[player.dynamicHint] ?? '未知') : null,
        isCurrentActor: currentActorPosition === seat.logicalPosition,
        folded: enginePlayer?.folded ?? seat.status === SeatStatus.FOLDED_THIS_HAND,
        allIn: enginePlayer?.allIn ?? seat.status === SeatStatus.ALL_IN,
        /*
         * 🔴 Button 标记必须来自**拓扑**，不能写 `logicalPosition === Position.BTN`。
         *
         * 修复前这里就是后者：`Position.BTN` 被当成「庄家座位」，而它其实只是
         * 座位环上的一个**固定物理座位**。Button 每手轮转，因此修复前
         * 界面上亮着「D」的可能是任何一个人 —— 显示与事实相反。
         */
        isDealer: topology !== null && topology.buttonSeatId === seat.seatId,
        handRole:
          topology !== null ? (topology.rolesBySeatId[seat.seatId] ?? null) : null,
        handRoleZh:
          topology !== null
            ? (() => {
                const role = topology.rolesBySeatId[seat.seatId];
                return role === undefined ? null : POSITION_ZH[role];
              })()
            : null,
        isParticipant:
          topology !== null
            ? topology.participantSeatIds.includes(seat.seatId)
            : false,
      });
    }),
  );
}

/* ============================================================
 * 动作按钮（**只包含后端判定的合法动作**）
 * ============================================================ */

function actionButtonsFrom(legal: LegalActions, pot: number, bigBlindChips: number): readonly TableActionButton[] {
  const toBB = (chips: number): number => Number((chips / bigBlindChips).toFixed(3));
  const buttons: TableActionButton[] = [];
  /**
   * 全下是否**已经由尺寸项承担**（即那一项是该动作唯一的尺寸选择）。
   *
   * 🔴 去重纪律：「加注全下至 X BB」与「全下（X BB）」是**同一个动作**
   * （投进同样多的筹码），不得同时摆两个按钮 —— 与 `CALL` 的全下跟注同族。
   * 全下**必须**有一个入口，但**只能有一个**：尺寸项只剩全下时由它承担
   * （`isAllIn` + 文案写明「全下」），否则由独立 `ALL_IN` 承担。
   */
  let sizedAllInCovered = false;

  for (const action of legal.actions) {
    switch (action) {
      case 'FOLD':
        buttons.push({ type: 'FOLD', labelZh: ACTION_ZH.FOLD, isAllIn: false, group: 'PRIMARY' });
        break;
      case 'CHECK':
        buttons.push({ type: 'CHECK', labelZh: ACTION_ZH.CHECK, isAllIn: false, group: 'PRIMARY' });
        break;
      case 'CALL':
        /*
         * 🔴 **全下跟注必须如实标注。**
         *
         * `callCost` 已经被夹到剩余筹码（`min(需要投入, 剩余筹码)`），
         * 所以当 `callIsAllIn` 为真时，「跟注」等于把**全部筹码**押进去 ——
         * 不是「少跟一点」。旧实现固定写 `isAllIn: false` 且标签只写
         * 「跟注 X BB」，使用者会以为自己只做了一次部分跟注。
         * 规范第 10–15 条要求界面不得误导，也不得同时摆一个重复的全下按钮。
         */
        buttons.push({
          type: 'CALL',
          labelZh: legal.callIsAllIn
            ? `${ACTION_ZH.CALL}全下 ${toBB(legal.callCost)}BB`
            : `${ACTION_ZH.CALL} ${toBB(legal.callCost)}BB`,
          amountBB: toBB(legal.callCost),
          amountChips: legal.callCost,
          isAllIn: legal.callIsAllIn,
          group: 'PRIMARY',
        });
        break;
      case 'BET': {
        // ⚠️ 这是**展开按钮**，不是动作（见 `TableActionButton` 的契约）
        buttons.push({
          type: 'BET',
          labelZh: `${ACTION_ZH.BET}（选尺寸）`,
          isAllIn: false,
          group: 'EXPAND',
        });
        /*
         * 🔴 **全下只呈现一次。**
         *
         * 尺寸网格**总是**包含全下额那一项（`buildSizeGrid` 会把 `maxTo`
         * 放进候选）。于是有两种必须分开处理的情形：
         *
         * | 情形 | 尺寸项数 | 处理 |
         * |---|---|---|
         * | 全下**就是**唯一的尺寸选择（最小下注 == 全下） | 1 | 由尺寸项承担：`isAllIn` + 「下注全下至 X BB」，**不再**另生成 ALL_IN |
         * | 还有更小的正常尺寸 | ≥ 2 | 尺寸项里**去掉**全下那一项，全下交给独立 `ALL_IN` |
         *
         * 两种都只让使用者看到一个全下入口。第二种刻意保留独立 `ALL_IN`
         * ——「正常下注」与「全下」是两条**不同**的动作，必须都能点到。
         */
        const betOptions = buildSizeGrid(legal, pot, 'BET');
        const allInViaSize = betOptions.length === 1;
        if (allInViaSize) sizedAllInCovered = true;
        for (const option of betOptions) {
          if (option.isAllIn && !allInViaSize) continue;
          buttons.push({
            type: 'BET',
            // 全下尺寸必须写明「全下」，否则使用者以为那只是一次普通下注
            labelZh: option.isAllIn
              ? `${ACTION_ZH.BET}全下至 ${toBB(option.toAmount)}BB`
              : `${ACTION_ZH.BET}到 ${toBB(option.toAmount)}BB`,
            amountBB: toBB(option.toAmount),
            amountChips: option.toAmount,
            isAllIn: option.isAllIn,
            group: 'SIZE',
          });
        }
        break;
      }
      case 'RAISE': {
        // ⚠️ 这是**展开按钮**，不是动作
        buttons.push({
          type: 'RAISE',
          labelZh: `${ACTION_ZH.RAISE}（选尺寸）`,
          isAllIn: false,
          group: 'EXPAND',
        });
        // 与 BET 同一条纪律：全下只呈现一次（最小加注 == 全下 ⇒ 由尺寸项承担）
        const raiseOptions = buildSizeGrid(legal, pot, 'RAISE');
        const raiseAllInViaSize = raiseOptions.length === 1;
        if (raiseAllInViaSize) sizedAllInCovered = true;
        for (const option of raiseOptions) {
          if (option.isAllIn && !raiseAllInViaSize) continue;
          buttons.push({
            type: 'RAISE',
            // 🔴 统一写「加注到 X BB」，绝不写「加注 X BB」（规范第 33 条）；
            //    全下尺寸写「加注全下至 X BB」—— 同样必须让使用者看出是全下
            labelZh: option.isAllIn
              ? `${ACTION_ZH.RAISE}全下至 ${toBB(option.toAmount)}BB`
              : `${ACTION_ZH.RAISE}到 ${toBB(option.toAmount)}BB`,
            amountBB: toBB(option.toAmount),
            amountChips: option.toAmount,
            isAllIn: option.isAllIn,
            group: 'SIZE',
          });
        }
        break;
      }
      case 'ALL_IN':
        /*
         * 🔴 **全下只呈现一次。**
         *
         * 走到这里说明全下**没有**由尺寸项承担，因此必须由本按钮承担 ——
         * 这覆盖两种情形：
         * 1. 还有更小的正常尺寸（尺寸项里的全下那一项已被剔除，避免重复）；
         * 2. 短码全下低于最小加注：尺寸网格被 `costChips > myRemainingStack`
         *    过滤成空，此时**只有**全下这一条合法路径，绝不能误删。
         */
        if (sizedAllInCovered) break;
        // 🔴 **不带金额**：引擎要求 `amount` = 本次投入的剩余筹码，
        //    而不是本街总额。不传金额由引擎自己算，任何情况下都正确。
        buttons.push({
          type: 'ALL_IN',
          labelZh: `${ACTION_ZH.ALL_IN}（${toBB(legal.allInToAmount)}BB）`,
          amountBB: toBB(legal.allInToAmount),
          isAllIn: true,
          group: 'PRIMARY',
        });
        break;
      default:
        break;
    }
  }
  return Object.freeze(buttons);
}

/* ============================================================
 * 状态指纹（测试与红队用）
 * ============================================================ */

/**
 * 引擎重建结果的**逐位指纹**。
 *
 * 红队要求「屏幕显示值 vs 实际提交 ManualHandInput vs 后端 Validated State
 * 三者一致」。这个指纹把第三条压成一个字符串，前两条压成 `manualHandInput`，
 * 于是「三者一致」可以被一条 `assert.equal` 检查。
 */
export function stateFingerprintOf(state: GameState): string {
  const players = [...state.players]
    .map((p) => ({
      position: p.position,
      startingStack: p.startingStack,
      remainingStack: p.remainingStack,
      committed: Object.values(p.committedByStreet).reduce((a, b) => a + b, 0),
      folded: p.folded,
      allIn: p.allIn,
    }))
    .sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0));

  return JSON.stringify({
    tableSize: state.config.tableSize,
    smallBlind: state.config.smallBlind,
    bigBlind: state.config.bigBlind,
    dealer: state.config.dealerPosition,
    street: state.street,
    phase: state.phase,
    currentBet: state.currentBet,
    minRaiseTo: minRaiseTo(state),
    pot: computePot(state),
    bettingRoundComplete: state.bettingRoundComplete,
    board: [state.board.flop.length, state.board.turn.length, state.board.river.length],
    actions: state.actions.map((a) => [a.index, a.street, a.position, a.type, a.amount]),
    players,
  });
}

/* ============================================================
 * 自动分析闸门（Hero Decision Ready）
 * ============================================================ */

/** 自动分析闸门的输入 —— **只用已经算好的结论**，不在这里重新推导规则 */
type ReadinessInput = {
  /** 人员问题（`staffingProblems` 的结果） */
  staffing: readonly string[];
  /** 公共牌是否还在选（1~2 张） */
  boardSelectionInProgress: boolean;
  boardCount: number;
  heroCardCount: number;
  handComplete: boolean;
  /** 引擎说现在轮到谁（`null` = 本街下注轮已结束） */
  currentActorPosition: Position | null;
  heroPosition: Position;
  /** 校验器是否拦下了这个状态 */
  validationBlocked: boolean;
};

/**
 * 算出「现在是不是一个可分析的 Hero 决策点」。
 *
 * ## 拆成两组的理由
 *
 * | 组 | 什么时候看它 |
 * |---|---|
 * | **决策就绪** | 决定「要不要自动分析」。它答的是「**轮到 Hero 了吗、他手上的信息齐了吗**」 |
 * | **分析可用性** | 已经决定要分析了，但**算不出来**。它答的是「状态本身有没有毛病」 |
 *
 * 混在一组里会导致一个具体的坏体验：Hero 还没轮到时，
 * 界面上同时堆着「现在轮到枪口位」和「牌局校验未通过」——
 * 后者其实是当前**中间态**的正常现象（行动记录还没录完），
 * 把它显示成「问题」会让人以为自己做错了什么。
 *
 * ## 为什么「轮到别人」不是错误
 *
 * 这一条直接对应规范里的要求：**不要猜前位会弃牌**。
 * 轮到别人就是「等待前位行动」，界面如实显示，不做任何假设。
 */
function decisionReadinessOf(input: ReadinessInput): DecisionReadiness {
  const conditions: Record<string, boolean> = {
    /** 条件 1：现在轮到 Hero */
    currentActorIsHero: input.currentActorPosition === input.heroPosition,
    /** 条件 2：Hero 两张手牌完整 */
    heroCardsComplete: input.heroCardCount === 2,
    /** 条件 3：牌局结构合法（校验器放行） */
    stateValid: !input.validationBlocked,
    /** 条件 4：当前街所需公共牌完整 */
    boardCompleteForStreet: !input.boardSelectionInProgress,
    /** 条件 5：人员足够（本手可参与者 ≥ 2 且 Hero 座位有人） */
    staffingOk: input.staffing.length === 0,
    /** 条件 6：本手还没结束 */
    handNotComplete: !input.handComplete,
    /** 条件 7：真的有一个待行动的 Hero 决策点（不是「本街已结束」） */
    hasDecisionPoint: input.currentActorPosition !== null,
  };

  const ready =
    conditions['currentActorIsHero'] === true &&
    conditions['heroCardsComplete'] === true &&
    conditions['stateValid'] === true &&
    conditions['boardCompleteForStreet'] === true &&
    conditions['staffingOk'] === true &&
    conditions['handNotComplete'] === true &&
    conditions['hasDecisionPoint'] === true;

  if (ready) {
    return Object.freeze({
      ready: true,
      reasonCode: DecisionReasonCode.READY,
      state: AutoAnalyzeState.ANALYZING,
      conditions: Object.freeze(conditions),
      groups: Object.freeze([]),
    });
  }

  // ---- 未就绪：按**优先级**给出唯一原因码 ----
  //
  // 顺序刻意如此。两条原则，按重要性排：
  //
  // 1. **「录入还没录完」优先于「校验没过」。**
  //    手牌没选满、公共牌还在选的时候，校验**必然**不通过 ——
  //    那是输入未完成的**正常中间态**，不是「牌局结构有问题」。
  //    若把 `stateValid` 排在它们前面，这两个码就永远发不出来：
  //    使用者每开一局都会先看到红色「状态错误」，而界面为它们
  //    准备好的「等待手牌 / 等待公共牌」是死的。
  //    （实测：`WAITING_HERO_CARDS` 与 `WAITING_BOARD` 曾**恒不可达**，
  //    8 个原因码里只有 4 个能被产出。）
  //    ⚠️ 本次只调整**原因码的优先级**，**不隐藏**校验结论：
  //    `groupB`（分析可用性）在这些中间态下仍会照实报告
  //    「牌局校验未通过」—— 那是 `validateGameState` 的真实结论。
  //    `ready` 依旧要求 `stateValid === true`，非法状态永远不可能就绪。
  // 2. 其余仍按「先结构性问题，再看等谁/等什么」：
  //    让使用者先修真正的问题，而不是先看到一个会自己消失的中间态。
  const groupA: string[] = [...input.staffing]; // 决策就绪
  const groupB: string[] = []; // 分析可用性

  let reasonCode: DecisionReasonCode;
  let uiState: AutoAnalyzeState;

  if (!conditions['staffingOk']) {
    reasonCode = DecisionReasonCode.STAFFING;
    uiState = AutoAnalyzeState.ERROR;
  } else if (input.heroCardCount !== 2) {
    reasonCode = DecisionReasonCode.WAITING_HERO_CARDS;
    uiState = AutoAnalyzeState.WAITING_CARDS;
    groupA.push(`Hero 手牌还没选满（已选 ${input.heroCardCount} / 2 张）。`);
  } else if (input.boardSelectionInProgress) {
    reasonCode = DecisionReasonCode.WAITING_BOARD;
    uiState = AutoAnalyzeState.WAITING_BOARD;
    groupA.push(
      `公共牌只选了 ${input.boardCount} 张（选择中）。翻牌要 3 张、转牌 4 张、河牌 5 张。`,
    );
  } else if (!conditions['stateValid']) {
    reasonCode = DecisionReasonCode.STATE_INVALID;
    uiState = AutoAnalyzeState.ERROR;
  } else if (!conditions['handNotComplete']) {
    reasonCode = DecisionReasonCode.HAND_COMPLETE;
    uiState = AutoAnalyzeState.ERROR;
    groupA.push('本手已经结束（只剩一位玩家或已摊牌），没有可分析的决策点。');
  } else if (!conditions['hasDecisionPoint']) {
    reasonCode = DecisionReasonCode.ROUND_COMPLETE;
    uiState = AutoAnalyzeState.WAITING_BOARD;
    groupA.push('本街下注轮已经结束，但公共牌还没选完 —— 请继续选择公共牌。');
  } else {
    /*
     * 轮到别人 —— **等**，不是错。
     *
     * 🔴 这里刻意**不猜**「他们会弃牌」。规范原文：
     * 「不要猜他们 Fold。显示『等待前位玩家行动』。」
     */
    reasonCode = DecisionReasonCode.WAITING_OTHERS;
    uiState = AutoAnalyzeState.WAITING_OTHERS;
    groupA.push(
      `现在轮到「${POSITION_ZH[input.currentActorPosition!]}」行动。` +
        '请先录入他的行动，轮到 Hero 时即可分析。',
    );
  }

  if (input.validationBlocked) {
    groupB.push('牌局校验未通过，请先修正上面的问题。');
  }

  const groups: { zh: string; items: readonly string[] }[] = [];
  if (groupA.length > 0) groups.push({ zh: '决策就绪', items: Object.freeze([...groupA]) });
  if (groupB.length > 0) groups.push({ zh: '分析可用性', items: Object.freeze([...groupB]) });

  return Object.freeze({
    ready: false,
    reasonCode,
    state: uiState,
    conditions: Object.freeze(conditions),
    groups: Object.freeze(groups),
  });
}

/* ============================================================
 * 主入口
 * ============================================================ */

/**
 * 构建牌桌预览。
 *
 * **永远返回一个结构完整的对象**（不抛异常、不返回 null）——
 * 牌桌 UI 每一帧都要渲染，任何一步失败都必须变成可显示的中文原因。
 */
export function buildTablePreview(state: PokerTableState): TablePreview {
  const issues: TableIssue[] = [];
  const warnings: string[] = [...state.notices];

  const adapted = tableStateToManualHandInput(state);
  const bigBlindChips = state.bigBlindBB;

  // ---- 人员：即使不能分析，也要能看到谁在座 ----
  const staffing = staffingProblems(state);

  /*
   * 本手拓扑（§61）。**只算一次**，两处消费者共用：
   * 座位视图（Button 标记 / 角色名 / 是否参与）与预览字段。
   *
   * ⚠️ 本手进行中用的是**冻结快照**（§10）—— 它在 `seatLifecycle` 里
   * 由「容量 + 参与者 + Button」生成一次，此后不再被座位生命周期改变。
   * 本手未开始时才算一个**预告**（`previewTopologyOf`），且绝不写回状态。
   */
  const topology = state.handTopology ?? previewTopologyOf(state);

  const emptyPreview = (extra: readonly TableIssue[]): TablePreview => {
    // ⚠️ 去重：`adapted.issues` 里也含有 `staffingProblems` 的条目
    //（适配器同样要做人员检查）。不去重的话同一条原因会显示两遍，
    // 使用者会以为有两个独立问题。
    const blockers: string[] = [];
    const seen = new Set<string>();
    for (const text of [...staffing, ...extra.map((i) => i.message)]) {
      if (seen.has(text)) continue;
      seen.add(text);
      blockers.push(text);
    }

    return Object.freeze({
      ok: false,
      tableId: state.tableId,
      revision: state.revision,
      street: null,
      streetZh: '—',
      boardSelectionInProgress: state.board.length === 1 || state.board.length === 2,
      currentActorSeatId: null,
      currentActorPosition: null,
      currentActorNameZh: null,
      isHeroTurn: false,
      activeOpponentCount: state.seats.filter((s) => s.playerId !== null).length - 1,
      realizedOpponentCount: 0,
      playersYetToAct: 0,
      bettingRoundComplete: false,
      handComplete: false,
      potBB: 0,
      currentBetBB: 0,
      callAmountBB: 0,
      minBetBB: null,
      minRaiseToBB: null,
      allInToBB: null,
      actionButtons: Object.freeze([]),
      legalActionTypes: Object.freeze([]),
      seats: seatsView(state, null, null, bigBlindChips, topology),
      handTopology: topology,
      remainingStacksBB: Object.freeze(
        Object.fromEntries(state.seats.filter((s) => s.playerId !== null).map((s) => [s.logicalPosition, s.stackBB])),
      ),
      effectiveStackBB: null,
      canAnalyze: false,
      decision: decisionReadinessOf({
        staffing,
        boardSelectionInProgress: state.board.length === 1 || state.board.length === 2,
        boardCount: state.board.length,
        heroCardCount: state.heroCards.length,
        handComplete: false,
        currentActorPosition: null,
        heroPosition: state.heroPosition,
        validationBlocked: true,
      }),
      analyzeBlockers: Object.freeze(blockers),
      issues: Object.freeze(extra),
      warnings: Object.freeze(warnings),
      manualHandInput: null,
      stateFingerprint: null,
    });
  };

  if (!adapted.ok) {
    return emptyPreview(adapted.issues);
  }
  // ---- 解析（与 Analyze 路径同一个校验器）----
  const parsed = parseManualInput(adapted.input);
  if (!parsed.ok) {
    return emptyPreview(
      parsed.issues.map((i) => ({ code: 'INTERNAL_ERROR' as const, message: i.message })),
    );
  }

  // ---- 重放（PREVIEW 模式：不要求轮到 Hero）----
  const reconstructed = reconstructGameState(parsed.value, { mode: ReconstructMode.PREVIEW });
  if (!reconstructed.ok) {
    return emptyPreview(
      reconstructed.issues.map((i) => ({ code: 'ILLEGAL_ACTION' as const, message: i.message })),
    );
  }

  const engineState = reconstructed.state;
  const bigBlind = engineState.config.bigBlind;

  // ---- 校验器（与 Analyze 路径同一个）----
  const validation = validateGameState(engineState, { checkActions: true, potMismatchBlocks: true });
  if (validation.blocked) {
    for (const blocker of validation.blockers) {
      issues.push({
        code: 'ILLEGAL_ACTION',
        message: `校验未通过（${String(blocker.code)}）`,
      });
    }
  }

  // ---- 当前行动者 ----
  const actorId = actorOnTurn(engineState);
  const actorPlayer = actorId !== null ? playerById(engineState, actorId) : undefined;
  const currentActorPosition: Position | null = actorPlayer?.position ?? null;
  const handComplete = engineState.phase === 'COMPLETE';

  // ---- 合法动作（**只对当前行动者求**）----
  let legal: LegalActions | null = null;
  if (actorPlayer !== undefined && !handComplete) {
    legal = deriveLegalActions(engineState, actorPlayer);
  }

  // ---- 座位视图（含引擎口径的剩余筹码）----
  const seats = seatsView(state, engineState, currentActorPosition, bigBlind, topology);

  const remainingStacksBB: Partial<Record<Position, number>> = {};
  for (const player of engineState.players) {
    remainingStacksBB[player.position] = Number((player.remainingStack / bigBlind).toFixed(2));
  }

  const pot = computePot(engineState);
  const toBB = (chips: number): number => Number((chips / bigBlind).toFixed(2));

  /**
   * 有效筹码 —— **必须与决策引擎用同一个函数、同一个对手**。
   *
   * 🔴 红队 V-EFF 命中：修复前这里自己算「所有还能下注的玩家里最小的剩余筹码」，
   * 而 `contextBuilder` 用的是 `effectiveStackBetween(state, hero, 首要对手)`
   *（= `min(我的剩余, 首要对手的剩余)`）。两者会给出**不同的数字**，
   * 而界面上二者的标签都叫「有效筹码」——
   * 于是屏幕上写着 19BB、引擎实际用 99BB，属于最典型的「界面在撒谎」。
   *
   * 现在直接调用同一个领域函数，并显式传同一个对手 id。
   */
  const effectiveResult =
    adapted.primaryOpponentPosition !== null
      ? effectiveStackBetween(
          engineState,
          `seat_${state.heroPosition}`,
          `seat_${adapted.primaryOpponentPosition}`,
        )
      : null;
  const effectiveStackChips =
    effectiveResult !== null && effectiveResult.ok
      ? effectiveResult.value.amount
      : (engineState.players.find((p) => p.position === state.heroPosition)?.remainingStack ?? 0);

  /**
   * 本手**仍未弃牌**的对手数（含尚未行动的人）。
   */
  const activeOpponentCount = engineState.players.filter(
    (p) => !p.folded && p.position !== state.heroPosition,
  ).length;

  /**
   * **已经真正进池**的对手数。
   *
   * 🔴 红队形态命中（Table Topology Correction）：修复前这里用
   * `activeOpponentCount` 提前告知「点分析会返回信息不足」，
   * 而决策引擎同时改用**已实现**对手数判定 —— 两边口径不同，
   * 于是**界面说有 3 个对手会拒绝、引擎其实会给建议**（以及反向的
   * 「界面说没问题、点了却信息不足」）。
   *
   * 现在两边调用**同一个领域函数** `realizedOpponentIds`，
   * 判据在结构上不可能分歧。这正是 `effectiveStackBetween` 那一课的重演：
   * 「同一个数字在两处的含义必须由同一个函数保证」。
   */
  const realizedIds = realizedOpponentIds(engineState);
  const realizedOpponentCount = engineState.players.filter(
    (p) => p.position !== state.heroPosition && realizedIds.has(p.id),
  ).length;
  /** 还没轮到说话的对手数（用于如实提示，不用于拒绝） */
  const yetToActIdsSet = yetToActIds(engineState);
  const playersYetToAct = engineState.players.filter(
    (p) => p.position !== state.heroPosition && yetToActIdsSet.has(p.id),
  ).length;

  /*
   * ---- 决策就绪闸门（唯一的「该不该分析」判据）----
   *
   * 🔴 **`analyzeBlockers` 不再自己拼**，而是从闸门的分组里摊平出来。
   * 从前这里是手写的一串 `if`，与 `decisionReadinessOf` 各写一遍
   * 「谁没轮到 / 牌够不够」—— 两份实现迟早分歧，而分歧的表现形式是
   * 「顶部状态条说可以分析、右侧阻塞项说不行」。同一条纪律已经在本文件
   * 里踩过一次（`effectiveStackBetween` 与 `realizedOpponentIds`）。
   */
  const readiness = decisionReadinessOf({
    staffing,
    boardSelectionInProgress: state.board.length === 1 || state.board.length === 2,
    boardCount: state.board.length,
    heroCardCount: state.heroCards.length,
    handComplete,
    currentActorPosition,
    heroPosition: state.heroPosition,
    validationBlocked: validation.blocked,
  });
  const analyzeBlockers: string[] = readiness.groups.flatMap((g) => [...g.items]);

  /**
   * 🔴 **多人池不再劝退**（本轮修复）。
   *
   * ## 修复前这里写的是「点分析会返回信息不足」
   *
   * 那句话当时是**真的** —— 决策引擎在 `realizedOpponentCount >= 3` 时
   * 会拒绝给建议。但界面主动劝退一个**引擎其实能分析**的决策点，
   * 等于把工具在真实牌桌上废掉：9 人桌现金局里
   * 「一家开池、几家跟注」是常态。
   *
   * ## 现在
   *
   * 权益已按全部已实现对手计算（多人口径），因此这里**不再拦截**，
   * 也不再重复引擎的门槛 —— 引擎的门槛已经不存在了。
   *
   * 界面此时仍然要如实说话，但那属于**提示**（`MULTIWAY_APPROXIMATION`
   * 由决策引擎给出），不是**阻断**。预览层不重复实现一份策略判断，
   * 因此这里连提示都不加：真正的提示在分析结果里，一句话只有一个出处。
   *
   * ⚠️ 判据仍用 `realizedOpponentIds`（由领域层给出）——
   * 见上面 `realizedOpponentCount` 的说明。
   */

  const legalTypes: readonly ManualActionType[] =
    legal === null ? [] : (legal.actions as readonly ManualActionType[]);

  return Object.freeze({
    ok: !validation.blocked,
    tableId: state.tableId,
    revision: state.revision,
    street: engineState.street,
    streetZh: STREET_ZH[engineState.street],
    boardSelectionInProgress: state.board.length === 1 || state.board.length === 2,
    currentActorSeatId:
      currentActorPosition !== null ? `seat_${currentActorPosition}` : null,
    currentActorPosition,
    currentActorNameZh:
      currentActorPosition !== null
        ? (seatOfPosition(state, currentActorPosition)?.playerId != null
            ? (state.playersById[seatOfPosition(state, currentActorPosition)!.playerId!]?.displayName ??
              POSITION_ZH[currentActorPosition])
            : POSITION_ZH[currentActorPosition])
        : null,
    isHeroTurn: currentActorPosition === state.heroPosition,
    activeOpponentCount,
    realizedOpponentCount,
    playersYetToAct,
    bettingRoundComplete: engineState.bettingRoundComplete,
    handComplete,
    potBB: toBB(pot),
    currentBetBB: toBB(engineState.currentBet),
    callAmountBB: legal !== null ? toBB(legal.callCost) : 0,
    minBetBB: legal !== null ? toBB(legal.minBet) : null,
    minRaiseToBB: legal !== null ? toBB(legal.minRaiseToAmount) : null,
    allInToBB: legal !== null ? toBB(legal.allInToAmount) : null,
    actionButtons: legal === null ? Object.freeze([]) : actionButtonsFrom(legal, pot, bigBlind),
    legalActionTypes: Object.freeze(legalTypes),
    seats,
    /*
     * 本手拓扑（§61）：本手进行中是冻结快照，未开始时是预告。
     * 前端拿到的永远是**结论**，不是原料 —— 于是前端不可能自己
     * 由容量反推出与引擎不同的盲注或角色。
     */
    handTopology: topology,
    decision: readiness,
    remainingStacksBB: Object.freeze(remainingStacksBB),
    effectiveStackBB: toBB(effectiveStackChips),
    canAnalyze: analyzeBlockers.length === 0 && analyzedOk(state),
    analyzeBlockers: Object.freeze(analyzeBlockers),
    issues: Object.freeze(issues),
    warnings: Object.freeze([
      ...warnings,
      ...reconstructed.warnings.map((w) => w.message),
      ...validation.warnings.map((w) => String(w.code)),
    ]),
    manualHandInput: adapted.input,
    stateFingerprint: stateFingerprintOf(engineState),
  });
}

/**
 * **本手开始之前**的拓扑预告（§61）。
 *
 * 使用者还没录任何东西时，界面也应该显示「9 座桌 · 本手 8 人 · Button 在 …」——
 * 否则「本手几个人」这件事在按下第一个动作之前是**不可见**的，
 * 而那正是最需要提前知道的信息（人数直接决定范围先验选哪一档）。
 *
 * 🔴 它是**预告**，不是事实：本手一旦开始，`state.handTopology`（冻结快照）
 * 就取代它。因此这里**绝不写回状态**，只是算给界面看。
 *
 * 算不出来（可参与者 < 2，或 Button 不在参与者里）时返回 `null` ——
 * 界面显示「—」，而不是显示一个错的拓扑。
 */
function previewTopologyOf(state: PokerTableState): HandTopologySnapshot | null {
  const participants = participantSeatsOf(state);
  if (participants.length < 2) return null;
  const positions = participants.map((s) => s.logicalPosition);
  /*
   * 🔴 与 `freezeTopology` **同一个口径**：Button 座位不能坐时（空了 / 被裁掉），
   * 用「从它顺时针找到的下一个合格座位」，而不是回落到 `positions[0]`。
   *
   * 修复前这里是 `positions[0]`，实测后果是使用者直接看到角色错乱
   * （两个座位同时显示「庄家位」、Hero 明明在 CO 却显示「大盲位」）。
   * 两处必须同源，否则「预览显示的角色」与「下一手真正冻结的拓扑」会分歧。
   */
  const buttonSeat = seatById(state, effectiveButtonSeatId(state));
  const buttonPosition =
    buttonSeat !== undefined && positions.includes(buttonSeat.logicalPosition)
      ? buttonSeat.logicalPosition
      : positions[0]!;

  try {
    const topology = handTopologySeats(state.tableSize, positions, buttonPosition);
    const ring = logicalSeatOrder(state.tableSize);
    const seatIdAt = (index: number): string => seatIdOfPosition(ring[index]!);
    const rolesBySeatId: Record<string, Position> = {};
    for (const [indexText, role] of Object.entries(topology.roleBySeatIndex)) {
      rolesBySeatId[seatIdAt(Number(indexText))] = role as Position;
    }
    return Object.freeze({
      handNumber: state.handsCompleted + 1,
      tableCapacity: state.tableSize,
      participantSeatIds: Object.freeze([...topology.participantSeatIndices].map(seatIdAt)),
      handedness: topology.handedness,
      buttonSeatId: seatIdAt(topology.buttonSeatIndex),
      smallBlindSeatId: seatIdAt(topology.smallBlindSeatIndex),
      bigBlindSeatId: seatIdAt(topology.bigBlindSeatIndex),
      rolesBySeatId: Object.freeze(rolesBySeatId),
      buttonAlsoPostsSmallBlind: topology.buttonAlsoPostsSmallBlind,
    });
  } catch {
    // 拓扑算不出来是「如实拒绝」，不是崩溃：界面会显示阻塞原因
    return null;
  }
}

/**
 * 「能否分析」的最终判据：**真的跑一次 Analyze 路径**（不重新实现规则）。
 *
 * 这是刻意的：预览说「可以分析」而实际分析被阻断，是最会让使用者失去信任的
 * 一类不一致。因此这里直接复用 `buildAnalyzableState`（ANALYZE 模式），
 * 它会执行完整的「必须轮到 Hero」检查。
 */
function analyzedOk(tableState: PokerTableState): boolean {
  const adapted = tableStateToManualHandInput(tableState);
  if (!adapted.ok) return false;
  const parsed = parseManualInput(adapted.input);
  if (!parsed.ok) return false;
  const gate = buildAnalyzableState(parsed.value);
  return gate.ok;
}

export { QUICK_PROFILE_ZH, DYNAMIC_HINT_ZH, SEAT_STATUS_ZH };
