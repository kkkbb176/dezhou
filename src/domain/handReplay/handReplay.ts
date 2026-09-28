/*
 * 🔴 **P4：把「逐手行为记录」还原成一局可以重演、复核的牌局。**
 *
 * ## 这个模块解决什么问题
 *
 * 引擎的每一份「这个决策对不对」的答案，都依赖**当时的牌面**。
 * 而在本次修复之前，落盘的记录里**一张牌都没有**：
 *
 * | 文件 | 条数（实测） | 有牌面吗 |
 * |---|---|---|
 * | `data/player-history.jsonl` | 1,036 | ❌ 没有任何牌 |
 * | `data/decision-log.jsonl` | 10,917 | ❌ 只存 `inputHash` |
 *
 * ⇒ 「真实牌局复盘 + 实战验证」这条线**根本不成立**：
 * 不知道牌面，就无法判断任何一条决策在当时是否正确，
 * 只能拿**合成语料**代替真实牌局（本项目此前正是这么做的）。
 *
 * 现在 `ObservationRecord` 带上 `board`（行动**之前**已发出的公共牌，按街切片）
 * 与 `holeCards`（行动者自己的底牌；只有 Hero 有 ⇒ 对手一律缺省，**绝不虚构**），
 * 本模块把同一手的记录**拼回**成一个 `HandReplay`。
 *
 * ## 为什么放在 domain 而不是 `playerHistory.ts`
 *
 * `playerHistory.ts` 属于 `app/table`（写记录的那一侧，带文件系统）。
 * 回放是**纯函数**：只吃记录、只吐牌局，不碰文件、不碰牌桌
 * ⇒ 放 `domain`，任何一侧（界面 / 审计脚本 / 测试）都能用，
 * 也不会为了回放去依赖历史文件的读写与损坏处理。
 *
 * ## 边界（说清楚「不做什么」）
 *
 * - **不重新决策**：本模块只还原「当时是什么局面」，不调用引擎，
 *   因此**不会**因为引擎版本变化而给出与当时不同的答案。
 * - **不猜**：缺字段 ⇒ 缺省；**冲突** ⇒ 显式失败（`HAND_REPLAY_*`），
 *   绝不「取第一条」或「取最长的一条」把矛盾盖掉。
 * - **不合并玩家**：身份只认 `playerId`，座位只用于回放行动顺序。
 */
import { Position } from '../types.ts';
import type { ObservationRecord } from '../../app/table/playerHistory.ts';

/* ============================================================
 * ① 输出形状
 * ============================================================ */

/** 回放出来的一条行动（字段口径与录入口径逐字一致） */
export type ReplayedAction = {
  /** 记录里的 `playerId`（**身份**判据） */
  playerId: string;
  /** 记录里的座位（回放位置用；**不是**身份） */
  seatId: string;
  /** 行动者位置（由 `seatId` 还原；无法还原 ⇒ 本函数已失败返回） */
  position: Position;
  street: ObservationRecord['street'];
  actionType: ObservationRecord['actionType'];
  /** 行动金额（BB；CALL 为本次补入，BET/RAISE 为本街累计 —— 与录入口径一致） */
  amountBB: number;
  facedBet: boolean;
  toCallBB: number;
  /** 行动前底池（BB）；旧记录可能缺 ⇒ `undefined` */
  potBB?: number;
  /** 该行动在这手牌里的顺序（0 起） */
  index: number;
  /** 原始记录（审计用：任何字段都能追溯到落盘的那一行） */
  record: ObservationRecord;
};

export type HandReplay = {
  handId: string;
  /**
   * 本手**最终**公共牌（按牌面顺序；`board[0..2]` = 翻牌、`[3]` = 转牌、`[4]` = 河牌）。
   *
   * 由同手记录里**最长**的那份 `board` 得到（同手记录是同一副牌的**前缀**关系）。
   */
  board: readonly string[];
  /** Hero 的底牌；本次修复前的记录、或从未录入手牌 ⇒ 缺省 */
  heroCards?: readonly string[];
  /** 按发生顺序排列的行动 */
  actions: readonly ReplayedAction[];
  /**
   * 本手记录里**有多少条真的带了公共牌**。
   *
   * 用途：这是一个**如实计数**，不是布尔。`recordsWithBoard < actions.length`
   * 说明这手牌一部分记录写于本字段存在之前 ⇒ 回放出的 `board` 只对
   * 「带牌的那些记录」成立，消费方必须知道这件事，而不是当成全手都有牌。
   */
  recordsWithBoard: number;
  /** 带底牌的记录条数（同理，如实计数） */
  recordsWithCards: number;
};

export type ReplayIssue = { code: string; message: string };

export type HandReplayResult = ({ ok: true } & HandReplay) | { ok: false; issues: readonly ReplayIssue[] };

/* ============================================================
 * ② 位置还原
 * ============================================================ */

const CANONICAL_POSITIONS: ReadonlySet<string> = new Set<string>(Object.values(Position));

/**
 * `seatId` → `Position`。
 *
 * 记录里的座位形如 `seat_BTN`（`deriveObservations` 用
 * `` `seat_${action.position}` `` 或座位自己的 `seatId`）。
 * **还原不出来就返回 `null`**，由调用方决定失败 —— 绝不猜一个位置。
 */
function positionOfSeatId(seatId: string): Position | null {
  const raw = seatId.startsWith('seat_') ? seatId.slice('seat_'.length) : seatId;
  const upper = raw.trim().toUpperCase();
  return CANONICAL_POSITIONS.has(upper) ? (upper as Position) : null;
}

/* ============================================================
 * ③ 排序键
 * ============================================================ */

/**
 * 一手牌内部的顺序。
 *
 * `historyLength` = 该行动写入后行动历史的长度，是**唯一确定的**顺序键
 * （撤销/修正的回退判据也是它）。同一次表操作追加的多条行动
 * 共享同一个 `historyLength`，此时用 `seq`（该操作前的修订号）再排。
 */
function orderKey(r: ObservationRecord): [number, number] {
  return [typeof r.historyLength === 'number' ? r.historyLength : r.seq, r.seq];
}

/* ============================================================
 * ④ 主函数
 * ============================================================ */

/** 把一批记录按 `handId` 分组；组内顺序**确定**（同输入 ⇒ 同输出） */
export function groupByHand(records: readonly ObservationRecord[]): Map<string, ObservationRecord[]> {
  const byHand = new Map<string, ObservationRecord[]>();
  records.forEach((r) => {
    const list = byHand.get(r.handId);
    if (list === undefined) byHand.set(r.handId, [r]);
    else list.push(r);
  });
  return byHand;
}

/**
 * 还原**一手**牌。`records` 可以包含别的手的记录（本函数只取 `handId` 匹配的）。
 */
export function replayHand(handId: string, records: readonly ObservationRecord[]): HandReplayResult {
  const mine = records
    .map((r, i) => ({ r, i }))
    .filter((x) => x.r.handId === handId)
    .sort((a, b) => {
      const [a1, a2] = orderKey(a.r);
      const [b1, b2] = orderKey(b.r);
      if (a1 !== b1) return a1 - b1;
      if (a2 !== b2) return a2 - b2;
      return a.i - b.i;
    })
    .map((x) => x.r);

  if (mine.length === 0) {
    return { ok: false, issues: [{ code: 'HAND_REPLAY_NO_RECORDS', message: `没有手 ${handId} 的任何记录` }] };
  }

  const issues: ReplayIssue[] = [];
  const actions: ReplayedAction[] = [];

  /** 公共牌：收集**互不矛盾**的前缀（矛盾 ⇒ 显式失败，不取最长） */
  const boards = new Set<string>();
  /** 底牌：同理 */
  const holes = new Set<string>();
  let recordsWithBoard = 0;
  let recordsWithCards = 0;

  mine.forEach((r, index) => {
    const position = positionOfSeatId(r.seatId);
    if (position === null) {
      issues.push({
        code: 'HAND_REPLAY_BAD_SEAT',
        message: `手 ${handId} 的记录座位「${r.seatId}」还原不出位置 ⇒ 拒绝回放该手（不猜位置）`,
      });
      return;
    }

    if (r.board !== undefined) {
      recordsWithBoard += 1;
      boards.add(r.board.join(' '));
    }
    if (r.holeCards !== undefined) {
      recordsWithCards += 1;
      holes.add(r.holeCards.join(' '));
    }

    actions.push({
      playerId: r.playerId,
      seatId: r.seatId,
      position,
      street: r.street,
      actionType: r.actionType,
      amountBB: r.amountBB,
      facedBet: r.facedBet,
      toCallBB: r.toCallBB,
      ...(r.potBB === undefined ? {} : { potBB: r.potBB }),
      index,
      record: r,
    });
  });

  /*
   * 🔴 **公共牌必须是同一条链上的前缀，否则显式失败。**
   *
   * 同手记录是**前缀**关系：翻牌记录写 3 张、转牌记录写 4 张、河牌记录写 5 张。
   * 因此「取最长的那份」是合法的 —— 但**只有在所有份互为前缀时才合法**。
   *
   * 若两份牌面互不为前缀（`Kh 7c 2d` vs `Ah Qs 2c`），说明要么记录被人工改过，
   * 要么两手牌共用了同一个 `handId`。此时拼一个「最长前缀」会造出一个
   * **从未存在过的牌局** —— 那比不回放更危险（看起来能回放，其实牌面是编的）。
   *
   * ⚠️ 第一版把「份数 > 1」直接判成冲突，于是**正常的多街牌局**也会被拒
   *（`P4-10` 抓到了）。判据必须是「互不为前缀」，不是「不止一份」。
   */
  const boardLists = [...boards].map((s) => (s === '' ? [] : s.split(' ')));
  const longestBoard = boardLists.reduce<readonly string[]>((a, b) => (b.length > a.length ? b : a), []);
  const notPrefix = boardLists.filter(
    (b) => !b.every((card, i) => longestBoard[i] === card),
  );
  if (notPrefix.length > 0) {
    return {
      ok: false,
      issues: [
        ...issues,
        {
          code: 'HAND_REPLAY_BOARD_CONFLICT',
          message:
            `手 ${handId} 的记录里有**互不为前缀**的公共牌（${notPrefix.map((b) => b.join(' ')).join(' ｜ ')}）` +
            '⇒ 拒绝回放（拼一个「最长前缀」会造出一个从未存在过的牌局）',
        },
      ],
    };
  }

  /*
   * 底牌则**必须完全一致**：同一手牌里 Hero 的底牌不可能变
   *（变了就说明记录被改过，或两手共用了一个 `handId`）。底牌没有「前缀」概念。
   */
  if (holes.size > 1) {
    return {
      ok: false,
      issues: [
        ...issues,
        {
          code: 'HAND_REPLAY_CARDS_CONFLICT',
          message: `手 ${handId} 的记录里有 ${holes.size} 份**互不相同**的底牌（${[...holes].join(' ｜ ')}）⇒ 拒绝回放`,
        },
      ],
    };
  }
  if (issues.length > 0) return { ok: false, issues };

  const board = longestBoard;
  const holeCards = holes.size === 0 ? null : [...holes][0]!.split(' ');

  return {
    ok: true,
    handId,
    board: Object.freeze(board),
    ...(holeCards === null ? {} : { heroCards: Object.freeze(holeCards) }),
    actions: Object.freeze(actions),
    recordsWithBoard,
    recordsWithCards,
  };
}

/** 还原**全部**手（按 `handId` 首次出现的顺序 ⇒ 确定） */
export function replayAllHands(records: readonly ObservationRecord[]): readonly HandReplayResult[] {
  return Object.freeze([...groupByHand(records).entries()].map(([handId, list]) => replayHand(handId, list)));
}
