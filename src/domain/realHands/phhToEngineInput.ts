/*
 * 🔴 **真实牌局 → 引擎输入**：把 PHH 的逐条动作重放成「决策点快照」。
 *
 * ## 这个模块的职责边界
 *
 * | 做 | 不做 |
 * |---|---|
 * | 从 PHH 动作**重放**出每个决策点的牌面 / 底池 / 筹码 / 行动历史 | **不做决策**（那是引擎的事） |
 * | 给出「引擎建议是否合法」所需的合法动作集 | **不评价**「真实玩家打得对不对」 |
 * | 把对手底牌**如实带出**（仅供对照） | **绝不**把对手底牌送进引擎（见下） |
 *
 * ## 🔴 引擎只拿到「行动者自己的底牌」
 *
 * 真实使用者手动录入时**只知道自己的两张牌**。若把对手底牌也喂给引擎，
 * 验的就是一个「开了上帝视角的引擎」—— 与实战无关。
 * 因此 `input.heroCards` = 行动者的两张；对手底牌只出现在 `opponentCards`，
 * **只供报告对照**。
 *
 * ## 底池口径：**不给 `potBB`**
 *
 * 让它由引擎从行动历史自己重算 —— 那样检验的才是
 * 「引擎算得对不对」，而不是「我喂给它的数字对不对」。
 *
 * ## 合法动作集：**用引擎自己的规则层**
 *
 * `parseManualInput` → `reconstructGameState(PREVIEW)` → `deriveLegalActions`，
 * 与生产路径（`engineViewOf`）**是同一对函数**。
 * 不自己实现一份「什么动作合法」—— 两份实现迟早分歧，
 * 而那次分歧会伪装成「引擎给了非法建议」。
 */
import { actorOnTurn } from '../poker/engine.ts';
import { deriveLegalActions } from '../../app/manualInput/legalActions.ts';
import { parseManualInput } from '../../app/manualInput/manualInput.ts';
import type { ManualAction, ManualActionType, ManualHandInput } from '../../app/manualInput/manualInput.ts';
import { ReconstructMode, reconstructGameState } from '../../app/manualInput/reconstruct.ts';
import { GameEnvironment } from '../range/gameEnvironment.ts';
import { Position, Street, TableSize } from '../types.ts';
import type { GameState } from '../poker/gameState.ts';
import { bigBlindChipsOf, seatPositionsOf, type PhhHand, type PhhPlayerAction } from './phh.ts';

/** 引擎只支持这三种公共牌张数（1～2 张 = 「选牌中」，禁止分析） */
const ANALYZABLE_BOARD_SIZES: ReadonlySet<number> = new Set([3, 4, 5]);

/**
 * 最近一次「引擎无法重建该局面」的原因（**诊断用，不是状态**）。
 *
 * 为什么要有它：`legalActionsOf` 返回 `null` 时，调用方只能知道
 * 「这个快照没产出」。而「没产出」有两种完全不同的原因 ——
 * 牌面不合法（正常）与**我的手牌重放与引擎规则分歧**（缺陷）。
 * 不把原因暴露出来，后者会伪装成前者，静默丢掉一整批样本。
 */
export let lastLegalFailure: { where: string; ui: readonly string[] } | null = null;
/** 本次 `legalActionsOf` 期望的行动者位置（用于校验重建没有错位） */
let expectedActorPosition: Position | null = null;

/**
 * 读最近一次失败原因。
 *
 * ⚠️ 必须**通过函数读**，不能直接引用模块变量：`let x = null` 会被 TS
 * 收窄成 `null` 字面量类型，调用点再读就报 `Property 'where' does not exist on type 'never'`。
 */
export function lastLegalFailureOf(): { where: string; ui: readonly string[] } | null {
  return lastLegalFailure;
}

export type ValidatorSnapshot = {
  /** 决策发生在哪条街 */
  street: 'FLOP' | 'TURN' | 'RIVER';
  /** 行动者（= 本次决策的「我方」）的逻辑位置 */
  heroPosition: Position;
  /** 行动者的玩家名（报告里用于追溯） */
  heroName: string;
  /** 送进引擎的输入（**只有行动者的底牌**） */
  input: ManualHandInput;
  /** 真实玩家在这个节点实际做了什么 */
  realAction: ManualActionType;
  /** 真实的下注/加注到（BB），仅当 `realAction` 是 RAISE 时有值 */
  realRaiseToBB?: number;
  /** 该节点我方**需要跟注**的金额（BB）；0 = 可以过牌 */
  toCallBB: number;
  /** 该节点引擎必须满足的合法动作集（由**引擎自己的规则层**给出） */
  legal: {
    actions: readonly ManualActionType[];
    minToBB: number;
    allInToBB: number;
  };
  /** 摊牌时我方是否赢（`null` = 没到摊牌 / 无从判定；本轮只作参考） */
  showdownWon: boolean | null;
  /** 对手在这个节点的底牌（**仅供对照，绝不送进引擎**；未知则不填） */
  opponentCards: Readonly<Record<string, string>>;
  /** 本手牌面（到该决策点为止）—— 报告用 */
  boardAll: readonly string[];
};

type PlayerState = {
  readonly index: number;
  readonly name: string;
  readonly position: Position;
  readonly startChips: number;
  remaining: number;
  folded: boolean;
  allIn: boolean;
  holeCards: string[] | null;
  /** 本手累计投入（前注 + 盲注 + 各街） */
  committedTotal: number;
  /** 本街已投入 */
  committedByStreet: number;
};

const streetRank = (s: Street): number =>
  s === Street.PREFLOP ? 0 : s === Street.FLOP ? 1 : s === Street.TURN ? 2 : 3;

function streetOfBoardSize(n: number): Street {
  if (n >= 5) return Street.RIVER;
  if (n === 4) return Street.TURN;
  if (n === 3) return Street.FLOP;
  return Street.PREFLOP;
}

/**
 * 用引擎自己的规则层算合法动作。
 *
 * `PREVIEW` 模式：不要求「当前轮到 Hero」，谁行动就报谁
 *（`reconstruct.ts:110`）—— 正是本场景需要的。
 *
 * 返回 `null` = 引擎无法重建这个局面（那说明**我的手牌重放**与引擎的规则分歧了，
 * 属于必须暴露的问题，不是可以跳过的噪声）⇒ 原因写进 `lastLegalFailure`。
 */
function legalActionsOf(
  input: ManualHandInput,
): { actions: readonly ManualActionType[]; minToBB: number; allInToBB: number } | null {
  const parsed = parseManualInput(input);
  if (!parsed.ok) {
    lastLegalFailure = { where: 'PARSE', ui: parsed.issues.slice(0, 3).map((i) => `${i.code}: ${i.message}`) };
    return null;
  }
  const rebuilt = reconstructGameState(parsed.value, { mode: ReconstructMode.PREVIEW });
  if (!rebuilt.ok) {
    lastLegalFailure = {
      where: 'RECONSTRUCT',
      ui: rebuilt.issues.slice(0, 3).map((i) => `${i.code}: ${i.message}`),
    };
    return null;
  }

  const state: GameState = rebuilt.state;
  const actorId = actorOnTurn(state);
  if (actorId === null) {
    lastLegalFailure = { where: 'NO_ACTOR', ui: [`street=${String(state.street)} phase=${String(state.phase)}`] };
    return null;
  }
  const actor = state.players.find((p) => p.id === actorId);
  if (actor === undefined) {
    lastLegalFailure = { where: 'NO_ACTOR_OBJ', ui: [String(actorId)] };
    return null;
  }
  /**
   * 🔴 **必须校验「重建出来的行动者就是真实行动者」**。
   *
   * 若不校验，行动历史里**少一条或位置错位**时，重建会停在一个
   * 「合法但错误」的局面：引擎会对着另一个人、另一个局面给建议，
   * 而表面上一切正常 —— 这正是最难查的缺陷形态。
   */
  if (actor.position !== expectedActorPosition) {
    lastLegalFailure = {
      where: 'ACTOR_MISMATCH',
      ui: [`重建出的行动者=${actor.position}，真实行动者=${String(expectedActorPosition)}`],
    };
    return null;
  }

  const legal = deriveLegalActions(state, actor);
  const bb = parsed.value.bigBlindBB > 0 ? parsed.value.bigBlindBB : 1;

  /*
   * 🔴 **合法动作集直接取引擎自己的结果**（`legal.actions`）。
   *
   * `deriveLegalActions` 本来就返回 `actions: DecisionAction[]`，而且
   * **已正确区分 BET 与 RAISE**（`legalActions.ts:129-135`：
   * `canBet` 用 `isUnopenedPot`，`canRaiseByAmount` 用 `!canBet && …`）。
   *
   * 第一版我**自己推**了一遍合法集（只放 `RAISE`、漏掉 `BET`），于是引擎
   * 每一条 `BET` 建议都被判成「建议了非法动作」—— **30 条全是假阳性**，
   * 而报告会把它当成确诊缺陷。
   *
   * 教训（本项目既有纪律）：**判据不能自己造**。检验者重新实现一遍被检验
   * 对象的规则，得到的不是检验，而是两份迟早分歧的实现。
   */
  const actions = legal.actions as readonly ManualActionType[];

  return {
    actions,
    minToBB: legal.minRaiseToAmount / bb,
    allInToBB: legal.allInToAmount / bb,
  };
}

/**
 * 重放一手 PHH，产出**全部**可验证的决策点。
 *
 * 只对「公共牌 ≥ 3 张」且「行动者底牌已知」的真实动作产出快照 ——
 * 那正是引擎有能力回答的节点。
 */
export function toValidatorSnapshots(hand: PhhHand): readonly ValidatorSnapshot[] {
  return toValidatorSnapshotsDetailed(hand).snapshots;
}

/**
 * 与 `toValidatorSnapshots` 相同，但**把「没产出」的原因一并返回**。
 *
 * 为什么必须有这个变体：`makeSnapshot` 会因为「引擎无法重建这个局面」而返回
 * `null`。若只返回数组，调用方无法区分
 * ①「这个节点本来就不该问」（牌面 1～2 张）与
 * ②「我重放出的局面引擎不认」（**我的手牌重放有缺陷**）。
 * 后者会伪装成前者，静默丢掉一整批样本 —— 实测就丢过 12/49。
 */
export function toValidatorSnapshotsDetailed(hand: PhhHand): {
  snapshots: readonly ValidatorSnapshot[];
  /** 被跳过的节点：真实动作 + 原因（`ENGINE_CANNOT_REBUILD` 等） */
  skipped: readonly { heroName: string; street: string; realAction: ManualActionType; reason: string; detail: string }[];
} {
  const n = hand.players.length;
  if (n !== 6 && n !== 9) return { snapshots: Object.freeze([]), skipped: Object.freeze([]) };
  const positions = seatPositionsOf(hand);
  if (positions === null) return { snapshots: Object.freeze([]), skipped: Object.freeze([]) };

  const skipped: { heroName: string; street: string; realAction: ManualActionType; reason: string; detail: string }[] = [];

  const bbChips = bigBlindChipsOf(hand);
  if (!(bbChips > 0)) return { snapshots: Object.freeze([]), skipped: Object.freeze([]) };

  /** 按钮位置：六人/九人桌的按钮都是固定角色，由位置映射决定 */
  const buttonPosition: Position = Position.BTN;

  const players: PlayerState[] = hand.players.map((name, i) => ({
    index: i,
    name,
    position: positions[i]!,
    startChips: hand.startingStacks[i] ?? 0,
    remaining: hand.startingStacks[i] ?? 0,
    folded: false,
    allIn: false,
    holeCards: null,
    committedTotal: 0,
    committedByStreet: 0,
  }));

  const board: string[] = [];
  let street: Street = Street.PREFLOP;
  /** 本街最高投入（下注/加注到的总额） */
  let currentBet = 0;
  const manualActions: ManualAction[] = [];
  const out: ValidatorSnapshot[] = [];

  const commit = (p: PlayerState, chips: number): void => {
    const amount = Math.max(0, Math.min(chips, p.remaining));
    p.remaining -= amount;
    p.committedByStreet += amount;
    p.committedTotal += amount;
    if (p.remaining === 0) p.allIn = true;
  };

  const finishStreet = (): void => {
    for (const p of players) p.committedByStreet = 0;
    currentBet = 0;
  };

  /* ---- 前注 + 盲注（建局时就已投入） ---- */
  players.forEach((p, i) => {
    const ante = hand.antes[i] ?? 0;
    if (ante > 0) commit(p, ante);
  });
  const sbSeat = positions.indexOf(Position.SB);
  const bbSeat = positions.indexOf(Position.BB);
  if (sbSeat >= 0) commit(players[sbSeat]!, hand.blindsOrStraddles[sbSeat] ?? 0);
  if (bbSeat >= 0) commit(players[bbSeat]!, hand.blindsOrStraddles[bbSeat] ?? 0);
  currentBet = Math.max(...players.map((p) => p.committedByStreet));

  /** 在**当前**状态与**本条**动作下产出一个决策点 */
  const makeSnapshot = (
    actor: PlayerState,
    realType: ManualActionType,
    realRaiseToChips?: number,
  ): ValidatorSnapshot | null => {
    if (!ANALYZABLE_BOARD_SIZES.has(board.length)) return null;
    if (actor.holeCards === null || actor.holeCards.length !== 2) return null;

    const toCallChips = Math.max(0, currentBet - actor.committedByStreet);
    const toCallActual = Math.min(toCallChips, actor.remaining);

    const livePlayers = players.filter((p) => !p.folded);
    const stacksBehind = livePlayers.map((p) => p.remaining + p.committedByStreet);
    const effectiveStackChips = stacksBehind.length === 0 ? 0 : Math.min(...stacksBehind);

    const seatStacksBB: Partial<Record<Position, number>> = {};
    for (const p of players) {
      if (p.folded) continue;
      seatStacksBB[p.position] = (p.remaining + p.committedByStreet) / bbChips;
    }

    const input: ManualHandInput = {
      tableSize: n as TableSize,
      heroPosition: actor.position,
      heroCards: Object.freeze([actor.holeCards[0]!, actor.holeCards[1]!]) as readonly [string, string],
      board: Object.freeze([...board]),
      street,
      effectiveStackBB: effectiveStackChips / bbChips,
      actionHistory: Object.freeze([...manualActions]),
      /*
       * 环境：Pluribus 这一份是 $50/$100 线上 6-max（对职业牌手），
       * 既不是「低级别线上」，也不是「理论参考」⇒ 取中低级别（也是项目默认值）。
       * **本验证不改环境**：改环境等于换一个题目，不是验同一个引擎。
       */
      environment: GameEnvironment.MID_LOW_STAKES,
      bigBlindBB: bbChips,
      seatStacksBB: Object.freeze(seatStacksBB),
      buttonPosition,
    };

    lastLegalFailure = null;
    expectedActorPosition = actor.position;
    const legal = legalActionsOf(input);
    expectedActorPosition = null;
    /*
     * 重建失败 ⇒ 不产出这个快照，**但把原因记下来**。
     * 若只丢一个 `null`，调用方会把「我的手牌重放有缺陷」误当成
     * 「这个节点本来就不该问」—— 实测就丢过 12/49 个节点。
     */
    if (legal === null) {
      skipped.push({
        heroName: actor.name,
        street: street === Street.FLOP ? 'FLOP' : street === Street.TURN ? 'TURN' : 'RIVER',
        realAction: realType,
        reason: 'ENGINE_CANNOT_REBUILD',
        detail: `${lastLegalFailureOf()?.where ?? 'UNKNOWN'} :: ${(lastLegalFailureOf()?.ui ?? []).join(' ｜ ')}`,
      });
      return null;
    }

    const opponents: Record<string, string> = {};
    for (const p of players) {
      if (p.index === actor.index || p.folded) continue;
      if (p.holeCards !== null) opponents[p.name] = p.holeCards.join('');
    }

    return {
      street: street === Street.FLOP ? 'FLOP' : street === Street.TURN ? 'TURN' : 'RIVER',
      heroPosition: actor.position,
      heroName: actor.name,
      input,
      realAction: realType,
      ...(realRaiseToChips === undefined ? {} : { realRaiseToBB: realRaiseToChips / bbChips }),
      toCallBB: toCallActual / bbChips,
      legal,
      showdownWon: null,
      opponentCards: Object.freeze(opponents),
      boardAll: Object.freeze([...board]),
    };
  };

  for (const action of hand.actions) {
    switch (action.kind) {
      case 'DEAL_HOLE': {
        const p = players[action.playerIndex];
        if (p === undefined) return { snapshots: Object.freeze(out), skipped: Object.freeze(skipped) };
        p.holeCards = [...action.cards];
        break;
      }
      case 'DEAL_BOARD': {
        for (const c of action.cards) board.push(c);
        const next = streetOfBoardSize(board.length);
        if (streetRank(next) > streetRank(street)) {
          finishStreet();
          street = next;
        }
        break;
      }
      case 'FOLD': {
        const p = players[action.playerIndex];
        if (p === undefined) return { snapshots: Object.freeze(out), skipped: Object.freeze(skipped) };
        const snap = makeSnapshot(p, 'FOLD');
        if (snap !== null) out.push(snap);
        p.folded = true;
        manualActions.push({ position: p.position, type: 'FOLD', street });
        break;
      }
      case 'CHECK_OR_CALL': {
        const p = players[action.playerIndex];
        if (p === undefined) return { snapshots: Object.freeze(out), skipped: Object.freeze(skipped) };
        const need = Math.max(0, currentBet - p.committedByStreet);
        const actual = Math.min(need, p.remaining);
        const snap = makeSnapshot(p, actual > 0 ? 'CALL' : 'CHECK');
        if (snap !== null) out.push(snap);
        if (actual > 0) {
          commit(p, actual);
          manualActions.push({
            position: p.position,
            type: 'CALL',
            amountBB: actual / bbChips,
            street,
          });
        } else {
          manualActions.push({ position: p.position, type: 'CHECK', street });
        }
        break;
      }
      case 'BET_OR_RAISE_TO': {
        const p = players[action.playerIndex];
        if (p === undefined) return { snapshots: Object.freeze(out), skipped: Object.freeze(skipped) };
        const need = Math.max(0, action.amount - p.committedByStreet);
        const snap = makeSnapshot(p, 'RAISE', action.amount);
        if (snap !== null) out.push(snap);
        commit(p, need);
        if (p.committedByStreet > currentBet) currentBet = p.committedByStreet;
        manualActions.push({
          position: p.position,
          type: 'RAISE',
          amountBB: p.committedByStreet / bbChips,
          street,
        });
        break;
      }
      case 'SHOW':
        /* 摊牌不改局面；结果对照单独做（本轮只检验决策点） */
        break;
      default:
        break;
    }
  }

  return { snapshots: Object.freeze(out), skipped: Object.freeze(skipped) };
}
