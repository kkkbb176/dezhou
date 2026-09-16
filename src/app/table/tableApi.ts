/**
 * 牌桌 API（**不依赖 HTTP**，便于直接用单元测试驱动）
 *
 * ## 为什么把「请求处理」从 `webServer.ts` 里拆出来
 *
 * 规范第 93 条：新测试不能只测 DOM，必须包含 domain-state correctness。
 * 把「请求 → 校验 → 操作 → 预览」做成纯函数之后，占绝大多数的逻辑
 *（形状校验、Fail-Closed、竞态水位线、留座决策）都可以在 Node 里直接测，
 * 不需要起服务器、更不需要浏览器。
 *
 * ## 🔴 客户端状态是**不可信输入**
 *
 * 牌桌状态由客户端持有并回传（这样服务端保持无状态）。因此每个请求都必须
 * 被当作**敌意输入**校验一遍：
 *
 * - 形状不合法 → 拒绝（不抛异常、不半接受）
 * - 座位集合与桌型不符 → 拒绝
 * - 座位引用了不存在的 playerId → 拒绝
 * - 撤销栈里的条目同样要过校验（否则可以借撤销注入任意状态）
 *
 * 一条被拒绝的请求**绝不能**留下任何副作用。
 */

import { Position } from '../../domain/types.ts';
import { GameEnvironmentId } from '../../domain/knowledge/knowledge.types.ts';
import {
  ALL_DYNAMIC_HINTS,
  ALL_QUICK_PROFILES,
  POSITION_ZH,
  STREET_ZH,
  ACTION_ZH,
  type ManualAction,
  type ManualActionType,
} from '../manualInput/manualInput.ts';
import { applyTableOp } from './tableOps.ts';
import { buildTablePreview, DYNAMIC_HINT_ZH, QUICK_PROFILE_ZH } from './tablePreview.ts';
import { createTable, logicalSeatOrder, seatOfPosition, visualIndexOf } from './tableState.ts';
import {
  MAX_UNDO_DEPTH,
  OCCUPIED_STATUSES,
  SeatStatus,
  SEAT_STATUS_ZH,
  type ActiveHandLeaveChoice,
  type LeaveDecision,
  type PokerTableState,
  type TableCore,
  type TableIssue,
  type TableOp,
  type TablePreview,
} from './table.types.ts';

/* ============================================================
 * 竞态水位线（§76）
 * ============================================================ */

/**
 * 版本水位线：**拒绝比已发出过的版本更旧的写入**。
 *
 * ## 为什么需要它（而不是只靠前端的 disable）
 *
 * 场景：用户连点两次「跟注」，或网络乱序让 #41 在 #42 之后到达服务端。
 * 前端 disable 按钮只能挡住「用户手快」，挡不住**已经在路上的请求**。
 *
 * 服务端持有「这张牌桌已经发出过的最大版本号」，
 * 于是 `revision < watermark` 的请求会被拒绝 ——
 * 迟到的旧状态**不可能**覆盖新状态。
 *
 * ⚠️ 水位线**不是游戏状态**：它只是传输层的护栏，丢了也无所谓
 *（重建牌桌会重置它）。
 */
export class RevisionGuard {
  private readonly seen = new Map<string, number>();

  check(tableId: string, revision: number): { ok: true } | { ok: false; message: string } {
    const highest = this.seen.get(tableId);
    if (highest !== undefined && revision < highest) {
      return {
        ok: false,
        message:
          `请求基于旧版本（${revision}），而服务器已经发出到版本 ${highest}。` +
          '这一请求已被丢弃 —— 界面不会被回退。请刷新页面重新开始。',
      };
    }
    return { ok: true };
  }

  record(tableId: string, revision: number): void {
    const highest = this.seen.get(tableId);
    if (highest === undefined || revision > highest) this.seen.set(tableId, revision);
    // 防止表无限增长（单用户工具，正常只会有个位数条目）
    if (this.seen.size > 64) {
      const oldest = this.seen.keys().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
  }

  reset(tableId: string, revision: number): void {
    this.seen.set(tableId, revision);
  }

  peek(tableId: string): number | undefined {
    return this.seen.get(tableId);
  }
}

/* ============================================================
 * 形状校验（Fail-Closed）
 * ============================================================ */

const VALID_STATUSES: readonly string[] = Object.values(SeatStatus);
const VALID_POSITIONS: readonly string[] = Object.values(Position);
const VALID_ENVIRONMENTS: readonly string[] = Object.values(GameEnvironmentId);
const VALID_ACTION_TYPES: readonly string[] = ['FOLD', 'CHECK', 'CALL', 'BET', 'RAISE', 'ALL_IN'];
/**
 * 合法街道值。
 *
 * ⚠️ 必须是**枚举值**（`PREFLOP`），不是中文标签。
 * 实测踩到的错误：这里曾经写成 `Object.values(STREET_ZH).includes(...)`，
 * 而 `STREET_ZH` 的值是「翻牌前」这类中文 —— 于是**每一条带街道的行动记录
 * 都被判非法**，牌桌在 HTTP 层完全不可用（而纯函数层的测试全绿）。
 */
const VALID_STREETS: readonly string[] = ['PREFLOP', 'FLOP', 'TURN', 'RIVER'];

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isPositiveNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

function validateAction(raw: unknown, index: number, issues: TableIssue[]): void {
  if (!isPlainObject(raw)) {
    issues.push({ code: 'INTERNAL_ERROR', message: `actionHistory[${index}] 必须是对象` });
    return;
  }
  if (!VALID_POSITIONS.includes(String(raw['position']))) {
    issues.push({
      code: 'INTERNAL_ERROR',
      message: `actionHistory[${index}].position 非法：${String(raw['position'])}`,
    });
  }
  if (!VALID_ACTION_TYPES.includes(String(raw['type']))) {
    issues.push({
      code: 'INTERNAL_ERROR',
      message: `actionHistory[${index}].type 非法：${String(raw['type'])}`,
    });
  }
  if (raw['amountBB'] !== undefined && !isPositiveNumber(raw['amountBB']) && raw['amountBB'] !== 0) {
    issues.push({
      code: 'INTERNAL_ERROR',
      message: `actionHistory[${index}].amountBB 非法：${String(raw['amountBB'])}`,
    });
  }
  if (raw['street'] !== undefined && !VALID_STREETS.includes(String(raw['street']))) {
    issues.push({
      code: 'INTERNAL_ERROR',
      message: `actionHistory[${index}].street 非法：${String(raw['street'])}`,
    });
  }
}

/**
 * 校验一个「核心状态」（不含撤销栈）。
 *
 * 撤销栈里的每个快照也用同一个函数校验 —— 否则可以借撤销注入任意状态。
 */
function validateCore(raw: unknown, issues: TableIssue[]): TableCore | null {
  if (!isPlainObject(raw)) {
    issues.push({ code: 'INTERNAL_ERROR', message: '牌桌状态必须是一个对象' });
    return null;
  }

  if (typeof raw['tableId'] !== 'string' || raw['tableId'].length === 0) {
    issues.push({ code: 'INTERNAL_ERROR', message: 'tableId 必须是非空字符串' });
  }
  const revision = raw['revision'];
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 0) {
    issues.push({ code: 'INTERNAL_ERROR', message: `revision 必须是非负整数（收到 ${String(revision)}）` });
  }

  const tableSize = raw['tableSize'];
  if (tableSize !== 6 && tableSize !== 9) {
    issues.push({ code: 'INTERNAL_ERROR', message: `tableSize 必须是 6 或 9（收到 ${String(tableSize)}）` });
    return null;
  }

  const heroPosition = raw['heroPosition'];
  if (!VALID_POSITIONS.includes(String(heroPosition))) {
    issues.push({ code: 'INTERNAL_ERROR', message: `heroPosition 非法：${String(heroPosition)}` });
    return null;
  }

  const heroPlayerId = raw['heroPlayerId'];
  if (typeof heroPlayerId !== 'string' || heroPlayerId.length === 0) {
    issues.push({ code: 'INTERNAL_ERROR', message: 'heroPlayerId 必须是非空字符串' });
  }

  // ---- 玩家表 ----
  const playersRaw = raw['playersById'];
  if (!isPlainObject(playersRaw)) {
    issues.push({ code: 'INTERNAL_ERROR', message: 'playersById 必须是对象' });
    return null;
  }
  for (const [id, player] of Object.entries(playersRaw)) {
    if (!isPlainObject(player)) {
      issues.push({ code: 'INTERNAL_ERROR', message: `playersById['${id}'] 必须是对象` });
      continue;
    }
    if (player['playerId'] !== id) {
      issues.push({
        code: 'INTERNAL_ERROR',
        message: `playersById['${id}'].playerId 与键不一致（${String(player['playerId'])}）`,
      });
    }
    if (!ALL_QUICK_PROFILES.includes(player['quickProfile'] as never)) {
      issues.push({
        code: 'INTERNAL_ERROR',
        message: `playersById['${id}'].quickProfile 非法：${String(player['quickProfile'])}`,
      });
    }
    if (!ALL_DYNAMIC_HINTS.includes(player['dynamicHint'] as never)) {
      issues.push({
        code: 'INTERNAL_ERROR',
        message: `playersById['${id}'].dynamicHint 非法：${String(player['dynamicHint'])}`,
      });
    }
  }

  // ---- 座位 ----
  const seatsRaw = raw['seats'];
  if (!Array.isArray(seatsRaw)) {
    issues.push({ code: 'INTERNAL_ERROR', message: 'seats 必须是数组' });
    return null;
  }
  const expectedPositions = logicalSeatOrder(tableSize);
  if (seatsRaw.length !== expectedPositions.length) {
    issues.push({
      code: 'INTERNAL_ERROR',
      message: `座位数（${seatsRaw.length}）与桌型（${tableSize} 人桌）不符`,
    });
    return null;
  }

  const seenPositions = new Set<string>();
  const seenSeatIds = new Set<string>();
  const visualIndices = new Set<number>();

  for (const [index, seat] of seatsRaw.entries()) {
    if (!isPlainObject(seat)) {
      issues.push({ code: 'INTERNAL_ERROR', message: `seats[${index}] 必须是对象` });
      continue;
    }
    const position = String(seat['logicalPosition']);
    if (!VALID_POSITIONS.includes(position)) {
      issues.push({ code: 'INTERNAL_ERROR', message: `seats[${index}].logicalPosition 非法：${position}` });
      continue;
    }
    if (seenPositions.has(position)) {
      issues.push({ code: 'INTERNAL_ERROR', message: `座位位置重复：${position}` });
    }
    seenPositions.add(position);

    const seatId = String(seat['seatId']);
    if (seenSeatIds.has(seatId)) {
      issues.push({ code: 'INTERNAL_ERROR', message: `seatId 重复：${seatId}` });
    }
    seenSeatIds.add(seatId);

    if (!VALID_STATUSES.includes(String(seat['status']))) {
      issues.push({ code: 'INTERNAL_ERROR', message: `seats[${index}].status 非法：${String(seat['status'])}` });
    }
    if (!isPositiveNumber(seat['stackBB'])) {
      issues.push({ code: 'INTERNAL_ERROR', message: `seats[${index}].stackBB 必须是正数` });
    }
    const visual = seat['visualIndex'];
    if (typeof visual !== 'number' || !Number.isInteger(visual) || visual < 0 || visual >= tableSize) {
      issues.push({ code: 'INTERNAL_ERROR', message: `seats[${index}].visualIndex 非法：${String(visual)}` });
    } else {
      if (visualIndices.has(visual)) {
        issues.push({ code: 'INTERNAL_ERROR', message: `visualIndex 重复：${visual}` });
      }
      visualIndices.add(visual);
    }

    const playerId = seat['playerId'];
    if (playerId !== null) {
      if (typeof playerId !== 'string' || playerId.length === 0) {
        issues.push({ code: 'INTERNAL_ERROR', message: `seats[${index}].playerId 非法` });
      } else if (!(playerId in playersRaw)) {
        issues.push({
          code: 'INTERNAL_ERROR',
          message: `座位 ${seatId} 引用了不存在的 playerId「${playerId}」`,
        });
      }
    }
    // `sitOutNextHand` 必须是布尔，且**空座位不得携带它**
    //（红队 RT-L5：座位级属性会被下一个坐进来的人继承）
    if (typeof seat['sitOutNextHand'] !== 'boolean') {
      issues.push({
        code: 'INTERNAL_ERROR',
        message: `seats[${index}].sitOutNextHand 必须是布尔值（收到 ${String(seat['sitOutNextHand'])}）`,
      });
    } else if (seat['status'] === SeatStatus.EMPTY && seat['sitOutNextHand'] === true) {
      issues.push({
        code: 'INTERNAL_ERROR',
        message:
          `座位 ${seatId} 是空座位却带着「下一手暂离」标记 —— ` +
          '那是玩家的意图，不能留在座位上被下一个坐进来的人继承',
      });
    }
    // 状态与绑定必须自洽
    if (seat['status'] === SeatStatus.EMPTY && playerId !== null) {
      issues.push({ code: 'INTERNAL_ERROR', message: `座位 ${seatId} 状态为 EMPTY 却仍绑定玩家` });
    }
    if (seat['status'] !== SeatStatus.EMPTY && playerId === null) {
      issues.push({ code: 'INTERNAL_ERROR', message: `座位 ${seatId} 有状态却未绑定玩家` });
    }
  }
  for (const position of expectedPositions) {
    if (!seenPositions.has(position)) {
      issues.push({ code: 'INTERNAL_ERROR', message: `缺少位置 ${position} 的座位` });
    }
  }

  // Hero 座位必须存在且绑定 Hero
  const heroSeat = seatsRaw.find(
    (s) => isPlainObject(s) && s['logicalPosition'] === heroPosition,
  );
  if (heroSeat === undefined || !isPlainObject(heroSeat) || heroSeat['playerId'] !== heroPlayerId) {
    issues.push({ code: 'HERO_SEAT_REQUIRED', message: 'Hero 的座位必须存在且绑定 heroPlayerId' });
  }
  if (!(heroPlayerId as string in playersRaw)) {
    issues.push({ code: 'INTERNAL_ERROR', message: `heroPlayerId「${String(heroPlayerId)}」不在 playersById 里` });
  }

  // ---- 手牌 / 公共牌 ----
  const heroCards = raw['heroCards'];
  if (!Array.isArray(heroCards) || heroCards.length > 2 || !heroCards.every((c) => typeof c === 'string')) {
    issues.push({ code: 'INTERNAL_ERROR', message: 'heroCards 必须是 0~2 个字符串' });
  } else {
    // 🔴 牌面代码必须是**合法牌**，且不能重复（红队：垃圾字符串与重复牌都被放过）
    for (const code of heroCards) {
      if (!isCardCode(code)) {
        issues.push({ code: 'INTERNAL_ERROR', message: `heroCards 里有非法牌面「${code}」` });
      }
    }
    if (new Set(heroCards).size !== heroCards.length) {
      issues.push({ code: 'INTERNAL_ERROR', message: 'heroCards 里有重复的牌' });
    }
  }
  const board = raw['board'];
  if (!Array.isArray(board) || board.length > 5 || !board.every((c) => typeof c === 'string')) {
    issues.push({ code: 'INTERNAL_ERROR', message: 'board 必须是 0~5 个字符串' });
  } else {
    for (const code of board) {
      if (!isCardCode(code)) {
        issues.push({ code: 'INTERNAL_ERROR', message: `board 里有非法牌面「${code}」` });
      }
    }
    if (new Set(board).size !== board.length) {
      issues.push({ code: 'INTERNAL_ERROR', message: 'board 里有重复的牌' });
    }
    // Hero 手牌与公共牌不得重复（同一张牌不能出现两次）
    if (Array.isArray(heroCards)) {
      for (const code of heroCards) {
        if (board.includes(code)) {
          issues.push({ code: 'INTERNAL_ERROR', message: `${code} 同时出现在手牌与公共牌里` });
        }
      }
    }
  }

  // ---- 行动历史 ----
  const history = raw['actionHistory'];
  if (!Array.isArray(history)) {
    issues.push({ code: 'INTERNAL_ERROR', message: 'actionHistory 必须是数组' });
  } else {
    history.forEach((a, i) => validateAction(a, i, issues));
  }

  // ---- 其它标量 ----
  if (!VALID_ENVIRONMENTS.includes(String(raw['environment']))) {
    issues.push({ code: 'INTERNAL_ERROR', message: `environment 非法：${String(raw['environment'])}` });
  }
  for (const key of ['bigBlindBB', 'defaultStackBB'] as const) {
    const value = raw[key];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 2) {
      issues.push({
        code: 'INTERNAL_ERROR',
        message: `${key} 必须是不小于 2 的整数（收到 ${String(value)}）`,
      });
    }
  }
  if (typeof raw['handActive'] !== 'boolean') {
    issues.push({ code: 'INTERNAL_ERROR', message: 'handActive 必须是布尔值' });
  }
  if (typeof raw['lastHandComplete'] !== 'boolean') {
    issues.push({ code: 'INTERNAL_ERROR', message: 'lastHandComplete 必须是布尔值' });
  }
  const notices = raw['notices'];
  if (!Array.isArray(notices) || !notices.every((n) => typeof n === 'string')) {
    issues.push({ code: 'INTERNAL_ERROR', message: 'notices 必须是字符串数组' });
  }
  const lastStacks = raw['lastHandRemainingStacksBB'];
  if (lastStacks !== null && lastStacks !== undefined) {
    if (!isPlainObject(lastStacks)) {
      issues.push({ code: 'INTERNAL_ERROR', message: 'lastHandRemainingStacksBB 必须是对象或 null' });
    } else {
      for (const [key, value] of Object.entries(lastStacks)) {
        if (!VALID_POSITIONS.includes(key) || typeof value !== 'number' || !Number.isFinite(value)) {
          issues.push({
            code: 'INTERNAL_ERROR',
            message: `lastHandRemainingStacksBB['${key}'] 非法：${String(value)}`,
          });
        }
      }
    }
  }
  if (
    typeof raw['nextPlayerNumber'] !== 'number' ||
    !Number.isInteger(raw['nextPlayerNumber']) ||
    raw['nextPlayerNumber'] < 1
  ) {
    issues.push({ code: 'INTERNAL_ERROR', message: 'nextPlayerNumber 必须是正整数' });
  }

  /* ---- 跨字段自洽性（红队：这些矛盾此前被放过）---- */
  if (issues.length === 0) {
    const historyList: unknown[] = Array.isArray(raw['actionHistory']) ? (raw['actionHistory'] as unknown[]) : [];
    const cards: string[] = Array.isArray(heroCards) ? (heroCards as string[]) : [];
    const boardCards: string[] = Array.isArray(board) ? (board as string[]) : [];
    const handActive = raw['handActive'] === true;

    // 「本手未开始」与「已经有手牌/公共牌/行动记录」不能同时成立
    if (!handActive && (historyList.length > 0 || cards.length > 0 || boardCards.length > 0)) {
      issues.push({
        code: 'INTERNAL_ERROR',
        message:
          'handActive=false 但已经有手牌/公共牌/行动记录 —— 状态自相矛盾' +
          `（手牌 ${cards.length} 张 / 公共牌 ${boardCards.length} 张 / 行动 ${historyList.length} 条）`,
      });
    }
    if (handActive && historyList.length === 0 && cards.length === 0 && boardCards.length === 0) {
      issues.push({
        code: 'INTERNAL_ERROR',
        message: 'handActive=true 但手牌/公共牌/行动记录全空 —— 状态自相矛盾',
      });
    }

    // 同一玩家不能同时占两个座位（否则画像/身份会串号）
    const ownerOf = new Map<string, string>();
    for (const seat of seatsRaw as readonly Record<string, unknown>[]) {
      const playerId = seat['playerId'];
      if (typeof playerId !== 'string') continue;
      const previous = ownerOf.get(playerId);
      if (previous !== undefined) {
        issues.push({
          code: 'INTERNAL_ERROR',
          message: `playerId「${playerId}」同时绑定在 ${previous} 与 ${String(seat['seatId'])} 两个座位上`,
        });
      }
      ownerOf.set(playerId, String(seat['seatId']));
    }

    // 🔴 视觉序号必须**整体**与旋转一致，不能只查 Hero 那一格。
    //
    // 红队 RT-L5 附带命中：只校验 Hero 座位时，把 UTG 与 HJ 的 visualIndex
    // 对调仍会被接受 —— 屏幕上两人互换了位置，而位置标签仍是各自逻辑位置。
    // 视觉位置虽然只影响渲染，但「屏幕上的座位顺序与逻辑不符」正是本轮
    // 要防的那类静默错误。
    const expectedVisual = new Map(
      logicalSeatOrder(tableSize).map((position) => [
        position,
        visualIndexOf(tableSize, heroPosition as Position, position),
      ]),
    );
    for (const seat of seatsRaw as readonly Record<string, unknown>[]) {
      const position = seat['logicalPosition'];
      if (typeof position !== 'string') continue;
      const expected = expectedVisual.get(position as Position);
      if (expected === undefined) continue;
      if (seat['visualIndex'] !== expected) {
        issues.push({
          code: 'INTERNAL_ERROR',
          message:
            `座位 ${String(position)} 的视觉序号应为 ${expected}（收到 ${String(seat['visualIndex'])}）—— ` +
            '视觉顺序必须与「Hero 固定在底部」的旋转一致',
        });
      }
    }
  }

  if (issues.length > 0) return null;
  return raw as unknown as TableCore;
}

/** 牌面代码是否合法（`As` / `Td` / `2c` 这类） */
function isCardCode(value: string): boolean {
  if (value.length < 2 || value.length > 3) return false;
  const suit = value.slice(-1);
  const rank = value.slice(0, -1);
  return 'shdc'.includes(suit) && 'AKQJT98765432'.includes(rank) && rank.length === 1;
}

export type ParseStateResult =
  | { ok: true; state: PokerTableState }
  | { ok: false; issues: readonly TableIssue[] };

/**
 * 解析客户端回传的牌桌状态（**Fail-Closed**）。
 *
 * 撤销栈同样逐条校验：一个伪造的撤销条目等于「把任意状态注入进来」。
 */
export function parseTableState(raw: unknown): ParseStateResult {
  const issues: TableIssue[] = [];
  const core = validateCore(raw, issues);
  if (core === null) {
    return {
      ok: false,
      issues: issues.length > 0 ? issues : [{ code: 'INTERNAL_ERROR', message: '牌桌状态不合法' }],
    };
  }

  const rawUndo = (raw as Record<string, unknown>)['undo'];
  const undo: TableCore[] = [];
  if (rawUndo !== undefined) {
    if (!Array.isArray(rawUndo)) {
      return { ok: false, issues: [{ code: 'INTERNAL_ERROR', message: 'undo 必须是数组' }] };
    }
    if (rawUndo.length > MAX_UNDO_DEPTH) {
      return {
        ok: false,
        issues: [
          {
            code: 'INTERNAL_ERROR',
            message: `undo 长度 ${rawUndo.length} 超过上限 ${MAX_UNDO_DEPTH}`,
          },
        ],
      };
    }
    for (const [index, entry] of rawUndo.entries()) {
      const entryIssues: TableIssue[] = [];
      const entryCore = validateCore(entry, entryIssues);
      if (entryCore === null) {
        return {
          ok: false,
          issues: [
            {
              code: 'INTERNAL_ERROR',
              message: `undo[${index}] 不合法：${entryIssues.map((i) => i.message).join('；')}`,
            },
          ],
        };
      }
      undo.push(entryCore);
    }
  }

  return { ok: true, state: Object.freeze({ ...core, undo: Object.freeze(undo) }) };
}

/* ============================================================
 * 请求 → 响应
 * ============================================================ */

export type TableApiOk = {
  ok: true;
  created: boolean;
  state: PokerTableState;
  preview: TablePreview;
};

export type TableApiFail = {
  ok: false;
  issues: readonly TableIssue[];
  leaveDecision?: LeaveDecision;
  /** 失败时也尽量回传状态，便于界面继续渲染 */
  state?: PokerTableState;
  preview?: TablePreview;
};

export type TableApiResponse = TableApiOk | TableApiFail;

export type TableRequestBody = {
  state?: unknown;
  op?: unknown;
  tableSize?: unknown;
  heroPosition?: unknown;
};

export type TableApiDeps = {
  /** 新牌桌 id 生成器（测试里可注入确定值） */
  newTableId: () => string;
  guard: RevisionGuard;
};

const VALID_OP_KINDS: readonly string[] = [
  'NEW_TABLE',
  'NEXT_HAND',
  'RESET_HAND',
  'ADD_PLAYER',
  'FILL_EMPTY_SEATS',
  'CLEAR_SEAT',
  'REPLACE_PLAYER',
  'SIT_OUT',
  'SIT_IN',
  'SET_STACK',
  'SET_PROFILE',
  'SET_DYNAMIC_HINT',
  'CLEAR_ALL_VILLAINS',
  'SET_ENVIRONMENT',
  'SET_TABLE_SIZE',
  'SET_HERO_POSITION',
  'SET_BUTTON',
  'SET_HERO_CARD',
  'CLEAR_HERO_CARDS',
  'SET_BOARD_CARD',
  'CLEAR_BOARD',
  'ACT',
  'UNDO',
];

function parseOp(raw: unknown): { ok: true; op: TableOp } | { ok: false; message: string } {
  if (!isPlainObject(raw)) return { ok: false, message: 'op 必须是对象' };
  const kind = String(raw['kind']);
  if (!VALID_OP_KINDS.includes(kind)) {
    return { ok: false, message: `未知操作「${kind}」` };
  }
  // 🔴 `ACT` 必须带一个合法的 action（红队命中：缺 action 会在
  //    `applyTableAction` 里读 `request.type` 抛 TypeError → HTTP 500，
  //    违反「本模块不抛异常」的契约）。
  if (kind === 'ACT') {
    const action = raw['action'];
    if (!isPlainObject(action)) {
      return { ok: false, message: 'ACT 操作必须带 action 对象（{ type, amountChips? }）' };
    }
    if (!VALID_ACTION_TYPES.includes(String(action['type']))) {
      return {
        ok: false,
        message: `action.type 非法：${String(action['type'])}。可选：${VALID_ACTION_TYPES.join(' / ')}`,
      };
    }
    if (
      action['amountChips'] !== undefined &&
      (typeof action['amountChips'] !== 'number' || !Number.isFinite(action['amountChips']))
    ) {
      return { ok: false, message: `action.amountChips 必须是有限数字（收到 ${String(action['amountChips'])}）` };
    }
    return { ok: true, op: { kind: 'ACT', action: raw['action'] as TableOp extends { action: infer A } ? A : never } };
  }
  return { ok: true, op: raw as unknown as TableOp };
}

/**
 * 处理一次牌桌请求。
 *
 * | 输入 | 行为 |
 * |---|---|
 * | `{ tableSize?, heroPosition? }`（**无 state**） | 新建牌桌 |
 * | `{ state, op }` | 应用操作 |
 *
 * 无论成功失败都返回结构化结果 —— 不抛异常（HTTP 层不需要 try/catch 兜底）。
 */
export function handleTableRequest(body: unknown, deps: TableApiDeps): TableApiResponse {
  if (!isPlainObject(body)) {
    return { ok: false, issues: [{ code: 'INTERNAL_ERROR', message: '请求体必须是对象' }] };
  }

  // ---- 新建牌桌 ----
  if (body['state'] === undefined) {
    const tableSizeRaw = body['tableSize'];
    const tableSize: 6 | 9 = tableSizeRaw === 9 ? 9 : tableSizeRaw === 6 ? 6 : 6;
    const heroPositionRaw = body['heroPosition'];
    const heroPosition =
      typeof heroPositionRaw === 'string' && VALID_POSITIONS.includes(heroPositionRaw)
        ? (heroPositionRaw as Position)
        : Position.BTN;
    if (typeof heroPositionRaw === 'string' && !VALID_POSITIONS.includes(heroPositionRaw)) {
      return {
        ok: false,
        issues: [{ code: 'INTERNAL_ERROR', message: `heroPosition 非法：${heroPositionRaw}` }],
      };
    }

    /*
     * 🔴 红队 RT-L7 命中：必须校验 heroPosition **在该桌型里存在**。
     *
     * `POST /api/table {tableSize:6, heroPosition:"UTG1"}` 以前返回 `ok:true`，
     * 却造出一张「Hero 不在任何座位上」的牌桌 —— 而这张牌桌
     * **连服务器自己的 `parseTableState` 都不接受**，此后每个操作都被拒绝。
     * （界面走不到这条路径是因为前端只送合法位置，但 API 是公开的。）
     */
    if (!logicalSeatOrder(tableSize).includes(heroPosition)) {
      return {
        ok: false,
        issues: [
          {
            code: 'SEAT_NOT_FOUND',
            message:
              `${tableSize} 人桌上没有「${heroPosition}」这个位置。` +
              `可选：${logicalSeatOrder(tableSize).join(' / ')}`,
          },
        ],
      };
    }

    const tableId = deps.newTableId();
    const state = createTable({ tableSize, heroPosition, tableId });

    // 新建也必须走**结果自校验**（与 `applyTableOp` 后的那条同一纪律）
    const createdCheck = parseTableState({ ...state });
    if (!createdCheck.ok) {
      return {
        ok: false,
        issues: [
          {
            code: 'INTERNAL_ERROR',
            message:
              '内部错误：新建的牌桌未通过自校验，已拒绝返回。原因：' +
              createdCheck.issues.map((i) => i.message).join('；'),
          },
        ],
      };
    }

    deps.guard.reset(tableId, state.revision);
    return Object.freeze({
      ok: true,
      created: true,
      state,
      preview: buildTablePreview(state),
    });
  }

  // ---- 已有状态 + 操作 ----
  const parsed = parseTableState(body['state']);
  if (!parsed.ok) {
    return { ok: false, issues: parsed.issues };
  }
  const state = parsed.state;

  // ---- 竞态水位线 ----
  const watermark = deps.guard.check(state.tableId, state.revision);
  if (!watermark.ok) {
    return {
      ok: false,
      issues: [{ code: 'STALE_REVISION', message: watermark.message }],
      state,
      preview: buildTablePreview(state),
    };
  }

  const opParsed = parseOp(body['op']);
  if (!opParsed.ok) {
    return {
      ok: false,
      issues: [{ code: 'INTERNAL_ERROR', message: opParsed.message }],
      state,
      preview: buildTablePreview(state),
    };
  }

  const outcome = applyTableOp(state, opParsed.op);
  if (!outcome.ok) {
    return {
      ok: false,
      issues: outcome.issues,
      ...(outcome.leaveDecision !== undefined ? { leaveDecision: outcome.leaveDecision } : {}),
      state,
      preview: buildTablePreview(state),
    };
  }

  /**
   * 🔴 **结果自校验**（红队命中：服务器曾经产出过自己的校验器不接受的状态）。
   *
   * 操作成功之后，把结果再过一遍**同一个** `parseTableState`。
   * 通不过就**拒绝返回它** —— 因为一个自相矛盾的状态一旦发出去，
   * 之后每一个请求都会失败，而使用者只看到「点了没反应」。
   *
   * 宁可在这里响亮地失败（明确说「这是内部错误，请反馈」），
   * 也不要把一副坏掉的牌桌交到使用者手里。
   */
  const selfCheck = parseTableState({ ...outcome.state });
  if (!selfCheck.ok) {
    return {
      ok: false,
      issues: [
        {
          code: 'INTERNAL_ERROR',
          message:
            `内部错误：操作「${opParsed.op.kind}」产生了一个自相矛盾的状态，已被拒绝。` +
            '牌桌状态未改变。请把这一步的操作反馈给开发者。\n原因：' +
            selfCheck.issues.map((i) => i.message).join('；'),
        },
      ],
      state,
      preview: buildTablePreview(state),
    };
  }

  deps.guard.record(outcome.state.tableId, outcome.state.revision);
  return Object.freeze({
    ok: true,
    created: false,
    state: outcome.state,
    preview: buildTablePreview(outcome.state),
  });
}

/* ============================================================
 * 元数据（前端**零硬编码枚举**）
 * ============================================================ */

/**
 * 渲染所需的全部枚举与中文标签。
 *
 * 🔴 前端**不允许**自己维护这些列表：那必然在某个时刻与后端枚举脱节，
 * 而脱节的表现形式是「下拉框里有一个后端不认识的取值」——
 * 正是本轮要消灭的那类静默错误。
 */
export function tableMetadata(): unknown {
  return Object.freeze({
    positions: VALID_POSITIONS.map((p) => ({ value: p, labelZh: POSITION_ZH[p as Position] })),
    tableSizes: [
      { value: 6, labelZh: '6 人桌', positions: logicalSeatOrder(6) },
      { value: 9, labelZh: '9 人桌', positions: logicalSeatOrder(9) },
    ],
    seatStatuses: VALID_STATUSES.map((s) => ({ value: s, labelZh: SEAT_STATUS_ZH[s as SeatStatus] })),
    occupiedStatuses: OCCUPIED_STATUSES,
    quickProfiles: ALL_QUICK_PROFILES.map((p) => ({ value: p, labelZh: QUICK_PROFILE_ZH[p] ?? p })),
    dynamicHints: ALL_DYNAMIC_HINTS.map((h) => ({ value: h, labelZh: DYNAMIC_HINT_ZH[h] ?? h })),
    environments: VALID_ENVIRONMENTS.map((e) => ({ value: e, labelZh: environmentZh(e) })),
    actionTypes: VALID_ACTION_TYPES.map((a) => ({ value: a, labelZh: ACTION_ZH[a as ManualActionType] })),
    streets: Object.entries(STREET_ZH).map(([value, labelZh]) => ({ value, labelZh })),
    leaveChoices: [
      { value: 'FOLD_AND_LEAVE', labelZh: '本手视为弃牌并离桌' },
      { value: 'LEAVE_AFTER_HAND', labelZh: '仅标记手后离桌' },
      { value: 'CANCEL', labelZh: '取消' },
    ] satisfies { value: ActiveHandLeaveChoice; labelZh: string }[],
  });
}

function environmentZh(id: string): string {
  switch (id) {
    case 'LOW_STAKES_ONLINE':
      return '低级别线上';
    case 'MID_LOW_STAKES':
      return '中低级别';
    case 'THEORY_REFERENCE':
      return '理论参考';
    default:
      return id;
  }
}

export { validateCore as __validateTableCore };
