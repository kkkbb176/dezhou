/**
 * ============================================================================
 * 玩家真实历史 · 每手行为记录持久化与决策注入（PLAYER PROFILE EXPLOIT V1）
 * ============================================================================
 *
 * ## 这个模块解决什么
 *
 * `PLAYER PROFILE EXPLOIT VALIDATION V1` 只读审计的结论是：**模型侧已具备**
 * （`villain.observedStats` 通道可直达响应模型），但**产品侧断链** ——
 * 没有任何「每手记录 → 持久化 → 重新上桌读取 → 注入决策」的实现。
 * 本模块补上这三步，且**不新建数据库、不引入依赖、不改 EV / GTO / 范围构造**。
 *
 * ## 只保存真实发生过的行动
 *
 * 每条记录都来自**用户显式录入**的行动（表操作 `ACT`），来源标记为 `USER_INPUT`；
 * **绝不为了补齐统计而虚构行动**，也**绝不**把「未观察到」当成「没做过」：
 * 机会数为 0 的统计**不写入** `observedStats`（宁缺勿假），而不是写 0。
 *
 * ## 只接入模型明确支持的统计
 *
 * 审计实测：11 项统计里只有 **2 项**在本项目现有响应模型中真正生效 ——
 * `foldToRiverBet`（河牌面对下注的弃牌率）与 `riverCheckRaise`（河牌过牌-加注率）。
 * 本模块**只**产出这两项（其余项没有输入通道，绝不允许被标成「已生效」）。
 *
 * ## 存储位置与备份
 *
 * ```text
 * <historyDir>/player-history.jsonl     ← 唯一真实来源（一行一条 JSON，只追加）
 * ```
 *
 * 默认 `historyDir` = `<repo>/data`（与既有 `data/decision-log.jsonl` 同一纪律）。
 * 备份 = 复制该文件；恢复 = 放回原位。**写入失败一律显式报错**，绝不宣称已保存。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { actorOnTurn } from '../../domain/poker/engine.ts';
import { playerById } from '../../domain/poker/gameState.ts';
import type { PlayerObservedStats } from '../../domain/player/observedStats.ts';
import { deriveLegalActions } from '../manualInput/legalActions.ts';
import type { ManualActionType } from '../manualInput/manualInput.ts';
import { applyTableOp, engineViewOf } from './tableOps.ts';
import type { PokerTableState, TableIssue, TableOp, TableOpOutcome } from './table.types.ts';

/* ============================================================
 * ① 记录形状（授权 §三 的字段清单）
 * ============================================================ */

export type ObservationSource = 'USER_INPUT';

export type ObservationRecord = {
  /** 牌局唯一标识：`<tableId>#H<handNumber>` */
  handId: string;
  /** 稳定玩家标识（**不是**座位号、**不是**显示名） */
  playerId: string;
  /**
   * 🔴 **PLAYER PROFILE TABLE UI V1**：当时的显示名。
   *
   * 只用于**查找与展示**：同名**绝不**自动合并（身份只认 `playerId`）。
   * 记录它是因为「选人弹窗」必须能按名字搜索，而显示名不是身份的判据。
   */
  displayName?: string;
  /** 当时的座位（用于追溯，不作为身份） */
  seatId: string;
  /** 行动发生的街道 */
  street: 'PREFLOP' | 'FLOP' | 'TURN' | 'RIVER';
  /** 行动类型（用户实际录入的） */
  actionType: ManualActionType;
  /** 行动金额（BB；CALL 为本次补入，BET/RAISE 为本街累计 —— 与录入口径一致） */
  amountBB: number;
  /** 当时可观测的状态：是否面对下注 */
  facedBet: boolean;
  /** 当时可观测的状态：需跟注额（BB） */
  toCallBB: number;
  /** 行动顺序（= 该操作前的牌桌修订号，严格单调） */
  seq: number;
  /** 该操作前的修订号（诊断用；回退判据请用 `historyLength`） */
  baseRevision: number;
  /**
   * 🔴 该行动写入后**行动历史的长度** —— 撤销/修正的**唯一回退判据**。
   *
   * 为什么不用 `revision`：撤销把牌桌恢复到上一状态时会**重新推进 revision**，
   * 因此「被撤销的那条记录」的 `baseRevision` 与恢复后的 revision 不一定可比。
   * 而「恢复后的行动历史长度」是确定的 ⇒ 保留 `historyLength <= 该长度` 的记录，
   * 恰好等于「重放到恢复点为止的真实行动」。
   */
  historyLength: number;
  /** 记录来源 */
  source: ObservationSource;
  /** **该行动是否已经成功写入历史**（写入失败必须为 false） */
  saved: boolean;
  /** 该手当时是否已完成（未完成不得计为已完成牌局） */
  handComplete: boolean;
};

export type HistoryIssue = { code: string; message: string };

export type HistoryResult<T> =
  | ({ ok: true } & T)
  | { ok: false; issues: readonly HistoryIssue[] };

const HISTORY_FILE = 'player-history.jsonl';

/**
 * 默认存储目录 = 仓库根的 `data/`（与既有 `data/decision-log.jsonl` 同一纪律）。
 *
 * **备份方式**：复制 `data/player-history.jsonl`；**恢复方式**：放回原位。
 * 测试**必须**传自己的临时目录（`test/playerProfileExploitV1.test.ts` 全部用 `mkdtempSync`），
 * 以免污染使用者现有的玩家资料。
 */
export function defaultHistoryDir(): string {
  /*
   * 🔴 **PLAYER PROFILE TABLE UI V1**：允许用环境变量隔离目录。
   *
   * 浏览器端到端验收必须使用**临时目录**，绝不污染使用者的真实玩家历史
   *（授权 §五）。生产默认仍是仓库根的 `data/`。
   */
  const override = process.env['DSH_PLAYER_HISTORY_DIR'];
  if (typeof override === 'string' && override.trim().length > 0) return override.trim();
  return join(process.cwd(), 'data');
}

export function historyFilePath(historyDir: string): string {
  return join(historyDir, HISTORY_FILE);
}

const writeIssue = (error: unknown): HistoryIssue => ({
  code: 'HISTORY_WRITE_FAILED',
  message:
    `历史写入失败，**本次行动未保存**（不要当作已保存）：${error instanceof Error ? error.message : String(error)}`,
});

const corruptIssue = (line: number, detail: string): HistoryIssue => ({
  code: 'HISTORY_CORRUPT',
  message:
    `历史文件第 ${line} 行无法解析（${detail}）⇒ **拒绝使用该文件**，` +
    '以免把损坏数据当成真实统计。请备份并修复/移走该文件后重试。',
});

const isRecord = (value: unknown): value is ObservationRecord => {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r['handId'] === 'string' &&
    typeof r['playerId'] === 'string' &&
    typeof r['street'] === 'string' &&
    typeof r['actionType'] === 'string' &&
    typeof r['seq'] === 'number'
  );
};

/* ============================================================
 * ② 读取（显式失败，绝不静默）
 * ============================================================ */

export function loadObservations(historyDir: string): HistoryResult<{ records: ObservationRecord[] }> {
  const path = historyFilePath(historyDir);
  if (!existsSync(path)) {
    /** 文件不存在 = 「还没有任何历史」，**不是**损坏 */
    return { ok: true, records: [] };
  }
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    return {
      ok: false,
      issues: [
        {
          code: 'HISTORY_READ_FAILED',
          message: `历史读取失败（${error instanceof Error ? error.message : String(error)}）⇒ 本次**不注入任何实测统计**`,
        },
      ],
    };
  }
  const records: ObservationRecord[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!.trim();
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      return { ok: false, issues: [corruptIssue(i + 1, error instanceof Error ? error.message : 'JSON 解析失败')] };
    }
    if (!isRecord(parsed)) return { ok: false, issues: [corruptIssue(i + 1, '字段形状不符合记录契约')] };
    records.push(parsed);
  }
  return { ok: true, records };
}

const dedupeKeyOf = (r: ObservationRecord): string =>
  `${r.handId}|${r.playerId}|${r.baseRevision}|${r.street}|${r.actionType}|${r.amountBB}`;

/* ============================================================
 * ③ 追加写入（去重 + 显式失败）
 * ============================================================ */

export function appendObservations(
  historyDir: string,
  incoming: readonly ObservationRecord[],
): HistoryResult<{ written: number; skippedDuplicates: number; records: readonly ObservationRecord[] }> {
  const existing = loadObservations(historyDir);
  if (!existing.ok) return { ok: false, issues: existing.issues };

  const seen = new Set(existing.records.map(dedupeKeyOf));
  const fresh: ObservationRecord[] = [];
  let skippedDuplicates = 0;
  for (const r of incoming) {
    const key = dedupeKeyOf(r);
    /** 🔴 重复提交同一行动**不得重复计数**（授权 §四.2） */
    if (seen.has(key)) {
      skippedDuplicates += 1;
      continue;
    }
    seen.add(key);
    fresh.push(Object.freeze({ ...r, saved: true }));
  }
  if (fresh.length === 0) {
    return { ok: true, written: 0, skippedDuplicates, records: Object.freeze([]) };
  }
  try {
    mkdirSync(historyDir, { recursive: true });
    appendFileSync(historyFilePath(historyDir), fresh.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  } catch (error) {
    /** 🔴 写入失败 ⇒ 返回 `saved: false` 的记录 + 显式错误，**绝不宣称已保存**（授权 §四.7） */
    return {
      ok: false,
      issues: [
        writeIssue(error),
        ...fresh.map(() => ({ code: 'HISTORY_NOT_SAVED', message: '该条行动未落盘（saved=false）' })),
      ],
    };
  }
  return { ok: true, written: fresh.length, skippedDuplicates, records: Object.freeze(fresh) };
}

/* ============================================================
 * ④ 撤销 / 修正（授权 §四.3、§四.4）
 * ============================================================ */

/**
 * 回退到「行动历史长度为 `keepHistoryLength`」的那个状态：
 * 删除**该手**中 `historyLength > keepHistoryLength` 的记录。
 *
 * 「撤销」把牌桌恢复到被撤销操作**之前**的状态，而那个状态的
 * `actionHistory.length` 就是恢复点 ⇒ 这条规则恰好删掉被撤销的那条（及更晚的），
 * 与撤销栈深度、以及 revision 是否被重新推进**无关**；
 * 也**不会**碰到更早的真实历史，更不会同时留下错误版本与修正版本。
 */
export function revertObservations(
  historyDir: string,
  input: { handId: string; keepHistoryLength: number },
): HistoryResult<{ removed: number; kept: number }> {
  const loaded = loadObservations(historyDir);
  if (!loaded.ok) return { ok: false, issues: loaded.issues };
  const kept = loaded.records.filter(
    (r) => !(r.handId === input.handId && r.historyLength > input.keepHistoryLength),
  );
  const removed = loaded.records.length - kept.length;
  if (removed === 0) return { ok: true, removed: 0, kept: kept.length };
  try {
    mkdirSync(historyDir, { recursive: true });
    const path = historyFilePath(historyDir);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, kept.length === 0 ? '' : kept.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    renameSync(tmp, path);
  } catch (error) {
    return { ok: false, issues: [writeIssue(error)] };
  }
  return { ok: true, removed, kept: kept.length };
}

/* ============================================================
 * ⑤ 统计推导（只产出模型真正支持的 2 项；未观察 != 0）
 * ============================================================ */

export type PlayerHistoryStats = {
  /** 该玩家累计被记录的手数（去重后的 handId 数） */
  handsObserved: number;
  /** 其中**已完成**的手数（未完成的手不计入） */
  handsComplete: number;
  /** 每项统计的**有效观测机会数**（0 = 没有观察到机会，不是「0%」） */
  opportunities: { foldToRiverBet: number; riverCheckRaise: number };
  /** 成功次数（分母见上） */
  successes: { foldToRiverBet: number; riverCheckRaise: number };
  /**
   * 交给决策模型的实测统计。**机会数为 0 的项不出现**（宁缺勿假）。
   */
  observedStats: PlayerObservedStats | null;
};

export function statsFromRecords(
  records: readonly ObservationRecord[],
  playerId: string,
): PlayerHistoryStats {
  const mine = records.filter((r) => r.playerId === playerId && r.saved === true);
  const hands = [...new Set(mine.map((r) => r.handId))];
  const completeHands = [
    ...new Set(
      records
        .filter((r) => r.playerId === playerId)
        .filter((r) => r.handComplete)
        .map((r) => r.handId),
    ),
  ];

  /** 河牌面对下注：机会 = 在河牌**面对下注**并做出决定（弃/跟/加/全下） */
  const riverFacing = mine.filter((r) => r.street === 'RIVER' && r.facedBet);
  const foldToRiverBetOpp = riverFacing.length;
  const foldToRiverBetSucc = riverFacing.filter((r) => r.actionType === 'FOLD').length;

  /**
   * 河牌过牌-加注：机会 = 该手该街**自己过牌后又被下注**（真的有机会加注）；
   * 成功 = 自己随后加注。逐手逐街配对，**不跨手、不跨街**。
   */
  let crOpp = 0;
  let crSucc = 0;
  const byHand = new Map<string, ObservationRecord[]>();
  for (const r of records) {
    if (r.playerId !== playerId && r.saved !== true) continue;
    const list = byHand.get(r.handId) ?? [];
    list.push(r);
    byHand.set(r.handId, list);
  }
  for (const [, list] of byHand) {
    const ordered = [...list].sort((a, b) => a.seq - b.seq || a.baseRevision - b.baseRevision);
    const river = ordered.filter((r) => r.street === 'RIVER');
    const myCheckIndex = river.findIndex((r) => r.playerId === playerId && r.actionType === 'CHECK');
    if (myCheckIndex < 0) continue;
    const after = river.slice(myCheckIndex + 1);
    const betAfter = after.some((r) => r.playerId !== playerId && (r.actionType === 'BET' || r.actionType === 'RAISE' || r.actionType === 'ALL_IN'));
    if (!betAfter) continue;
    crOpp += 1;
    if (after.some((r) => r.playerId === playerId && (r.actionType === 'RAISE' || r.actionType === 'ALL_IN'))) crSucc += 1;
  }

  const stats: Record<string, number | null> = {};
  if (foldToRiverBetOpp > 0) {
    stats['foldToRiverBet'] = foldToRiverBetSucc / foldToRiverBetOpp;
  }
  if (crOpp > 0) {
    stats['riverCheckRaise'] = crSucc / crOpp;
  }
  const hasAny = Object.keys(stats).length > 0;
  return Object.freeze({
    handsObserved: hands.length,
    handsComplete: completeHands.length,
    opportunities: Object.freeze({ foldToRiverBet: foldToRiverBetOpp, riverCheckRaise: crOpp }),
    successes: Object.freeze({ foldToRiverBet: foldToRiverBetSucc, riverCheckRaise: crSucc }),
    observedStats: hasAny
      ? Object.freeze({ handsObserved: hands.length, ...stats } as PlayerObservedStats)
      : null,
  });
}

/** 给界面/诊断用的一句话披露（**只列真正接通的项**） */
export function statsNoteZh(stats: PlayerHistoryStats): string {
  const parts: string[] = [`实测历史 ${stats.handsObserved} 手（其中已完成 ${stats.handsComplete} 手）`];
  if (stats.opportunities.foldToRiverBet > 0) {
    parts.push(
      `河牌面对下注 ${stats.opportunities.foldToRiverBet} 次 → 弃牌率 ` +
        `${((stats.successes.foldToRiverBet / stats.opportunities.foldToRiverBet) * 100).toFixed(1)}%（已接入响应模型）`,
    );
  }
  if (stats.opportunities.riverCheckRaise > 0) {
    parts.push(
      `河牌过牌-加注机会 ${stats.opportunities.riverCheckRaise} 次 → 加注率 ` +
        `${((stats.successes.riverCheckRaise / stats.opportunities.riverCheckRaise) * 100).toFixed(1)}%（已接入响应模型）`,
    );
  }
  parts.push('未列出的统计项**没有**输入通道，不作为本次决策依据');
  return parts.join('；');
}

/** 按显示名查找（**同名不自动合并**，返回全部候选交给使用者选择） */
export function findPlayersByName(
  historyDir: string,
  displayName: string,
): HistoryResult<{ matches: readonly { playerId: string; handsObserved: number }[] }> {
  const loaded = loadObservations(historyDir);
  if (!loaded.ok) return { ok: false, issues: loaded.issues };
  const ids = new Set(
    loaded.records
      .filter((r) => r.displayName === displayName)
      .map((r) => r.playerId),
  );
  return {
    ok: true,
    matches: Object.freeze(
      [...ids].map((playerId) => ({ playerId, handsObserved: statsFromRecords(loaded.records, playerId).handsObserved })),
    ),
  };
}

/* ============================================================
 * ⑤b 选人弹窗用的已知玩家名册（PLAYER PROFILE TABLE UI V1）
 * ============================================================ */

/** 名义 K（与 `observedStats.ts` 的收缩常数同量级）⇒ 「实测可信度」= n/(n+K) */
export const MEASURED_CONFIDENCE_K = 500;

export type KnownPlayer = {
  playerId: string;
  displayName: string;
  handsObserved: number;
  handsComplete: number;
  /** 实测可信度 = n/(n+K)（**收缩权重**，不是准确率） */
  measuredConfidence: number;
  /** 河牌面对下注：成功次数 / 有效机会数（0 次机会 ⇒ `null`，**绝不显示为 0%**） */
  foldToRiverBet: { successes: number; opportunities: number } | null;
  /** 河牌过牌-加注：成功次数 / 有效机会数（同上） */
  riverCheckRaise: { successes: number; opportunities: number } | null;
  /** 已进入决策模型的统计项（只有模型真有通道的才会出现） */
  connectedStatKeys: readonly string[];
  /** 尚未接通的统计项（**如实列出**，不得标成已生效） */
  unconnectedStatKeys: readonly string[];
  noteZh: string;
};

const CONNECTED_KEYS: readonly string[] = ['foldToRiverBet', 'riverCheckRaise'];
const UNCONNECTED_KEYS: readonly string[] = [
  'vpip', 'pfr', 'threeBet', 'wtsd',
  'foldToFlopCbet', 'foldToTurnCbet', 'flopCheckRaise', 'turnCheckRaise',
];

function knownPlayerOf(records: readonly ObservationRecord[], playerId: string): KnownPlayer {
  const stats = statsFromRecords(records, playerId);
  const displayName =
    [...records].reverse().find((r) => r.playerId === playerId && typeof r.displayName === 'string')?.displayName ??
    playerId;
  const counts = (o: number, s: number) => (o > 0 ? Object.freeze({ successes: s, opportunities: o }) : null);
  return Object.freeze({
    playerId,
    displayName,
    handsObserved: stats.handsObserved,
    handsComplete: stats.handsComplete,
    measuredConfidence: Number(
      (stats.handsObserved / (stats.handsObserved + MEASURED_CONFIDENCE_K)).toFixed(4),
    ),
    foldToRiverBet: counts(stats.opportunities.foldToRiverBet, stats.successes.foldToRiverBet),
    riverCheckRaise: counts(stats.opportunities.riverCheckRaise, stats.successes.riverCheckRaise),
    connectedStatKeys: Object.freeze(
      CONNECTED_KEYS.filter((k) => stats.observedStats !== null && (stats.observedStats as Record<string, unknown>)[k] !== undefined),
    ),
    unconnectedStatKeys: Object.freeze([...UNCONNECTED_KEYS]),
    noteZh: statsNoteZh(stats),
  });
}

/**
 * 已知玩家名册（选人弹窗的数据源）。
 *
 * - `query` 为空 ⇒ 返回全部；否则按**显示名或 playerId 的子串**过滤（大小写不敏感）；
 * - **同名不同 `playerId` 会是两条独立记录**（`duplicateName: true`）——
 *   使用者必须自己选，前端**不得**自动合并。
 */
export function listKnownPlayers(
  historyDir: string,
  query = '',
): HistoryResult<{ players: readonly (KnownPlayer & { duplicateName: boolean })[] }> {
  const loaded = loadObservations(historyDir);
  if (!loaded.ok) return { ok: false, issues: loaded.issues };
  const ids = [...new Set(loaded.records.map((r) => r.playerId))];
  const all = ids.map((id) => knownPlayerOf(loaded.records, id));
  const nameCounts = new Map<string, number>();
  for (const p of all) nameCounts.set(p.displayName, (nameCounts.get(p.displayName) ?? 0) + 1);

  const q = query.trim().toLowerCase();
  const filtered =
    q.length === 0
      ? all
      : all.filter(
          (p) => p.displayName.toLowerCase().includes(q) || p.playerId.toLowerCase().includes(q),
        );
  filtered.sort((a, b) => b.handsObserved - a.handsObserved || a.playerId.localeCompare(b.playerId));
  return {
    ok: true,
    players: Object.freeze(
      filtered.map((p) => Object.freeze({ ...p, duplicateName: (nameCounts.get(p.displayName) ?? 0) > 1 })),
    ),
  };
}

/* ============================================================
 * ⑥ 从一次真实操作推导记录（只记录用户真正录入的行动）
 * ============================================================ */

export function handIdOf(state: PokerTableState): string {
  const handNumber = state.handTopology?.handNumber ?? 0;
  return `${state.tableId}#H${handNumber}`;
}

export function deriveObservations(
  before: PokerTableState,
  after: PokerTableState,
): readonly ObservationRecord[] {
  if (after.actionHistory.length <= before.actionHistory.length) return Object.freeze([]);
  const appended = after.actionHistory.slice(before.actionHistory.length);
  const viewBefore = engineViewOf(before);
  const viewAfter = engineViewOf(after);
  const phase = viewAfter.ok ? viewAfter.engine.phase : 'BETTING';

  /** 操作前谁是行动者、要跟多少（**当时可观测的必要状态**） */
  let actorPosition: string | null = null;
  let toCallChips = 0;
  if (viewBefore.ok) {
    const id = actorOnTurn(viewBefore.engine);
    const actor = id === null ? undefined : playerById(viewBefore.engine, id);
    if (actor !== undefined) {
      actorPosition = actor.position;
      toCallChips = deriveLegalActions(viewBefore.engine, actor).callCost;
    }
  }

  const chipsPerBB = before.bigBlindBB > 0 ? before.bigBlindBB : 1;
  const handId = handIdOf(before);
  /** 街道取引擎**当时**的真实街（录牌/行动都以引擎为准） */
  const streetNow = viewBefore.ok ? viewBefore.engine.street : 'PREFLOP';
  const out: ObservationRecord[] = [];
  for (const action of appended) {
    const seat = before.seats.find((s) => s.logicalPosition === action.position);
    const playerId = seat?.playerId ?? null;
    /** 座位没绑玩家（引擎自动补齐的盲注等）⇒ 不记录，绝不虚构主人 */
    if (playerId === null) continue;
    out.push(
      Object.freeze({
        handId,
        playerId,
        displayName: before.playersById[playerId]?.displayName,
        seatId: seat?.seatId ?? `seat_${action.position}`,
        street: (action.street ?? streetNow) as ObservationRecord['street'],
        actionType: action.type,
        amountBB: action.amountBB ?? 0,
        facedBet: actorPosition === action.position && toCallChips > 0,
        toCallBB: Number((toCallChips / chipsPerBB).toFixed(4)),
        seq: before.revision,
        baseRevision: before.revision,
        historyLength: after.actionHistory.length,
        source: 'USER_INPUT' as const,
        saved: false,
        handComplete: phase === 'COMPLETE',
      }),
    );
  }
  return Object.freeze(out);
}

/* ============================================================
 * ⑦ 生产接线：一次用户操作 = 应用 + 记录 + 注入
 * ============================================================ */

export type HistorySeatStats = { observedStats: PlayerObservedStats; noteZh: string };

export type UserOpResult = {
  outcome: TableOpOutcome;
  /** 历史层额外产生的问题（写入失败 / 文件损坏 ⇒ 必须显示给用户） */
  historyIssues: readonly HistoryIssue[];
  /** 本次真正写入的记录条数 */
  recorded: number;
  /** 因重复而被跳过的条数 */
  skippedDuplicates: number;
};

const issue = (code: string, message: string): HistoryIssue => ({ code, message });

/**
 * 生产入口包装：`applyTableOp` + 真实历史读写。
 *
 * | 步骤 | 行为 |
 * |---|---|
 * | 1 | 应用操作（纯函数，行为与直接调用 `applyTableOp` **逐位一致**） |
 * | 2 | 读历史：损坏/读取失败 ⇒ **不注入任何统计**，并如实报告 |
 * | 3 | 玩家（重新）落座 ⇒ 把该 `playerId` 的实测统计挂到 `playersById[...]` |
 * | 4 | `ACT` ⇒ 把用户录入的真实行动追加进历史（去重；失败显式报错） |
 * | 5 | `UNDO` ⇒ 回退被撤销操作写入的记录（不残留错误版本） |
 */
export function applyUserOpWithHistory(input: {
  state: PokerTableState;
  op: TableOp;
  historyDir: string;
}): UserOpResult {
  const outcome = applyTableOp(input.state, input.op);
  if (!outcome.ok) {
    return { outcome, historyIssues: [], recorded: 0, skippedDuplicates: 0 };
  }

  const historyIssues: HistoryIssue[] = [];
  const loaded = loadObservations(input.historyDir);
  if (!loaded.ok) {
    /** 🔴 历史损坏/不可读 ⇒ **不得静默使用错误统计**（授权 §四.8、§四.10） */
    for (const i of loaded.issues) historyIssues.push(issue(i.code, i.message));
  }
  const records = loaded.ok ? loaded.records : [];

  let state = outcome.state;
  let recorded = 0;
  let skippedDuplicates = 0;

  /* ---- 3. 落座即注入实测统计（不覆盖已有画像，也不清空任何历史） ---- */
  if (loaded.ok && records.length > 0) {
    const players: Record<string, (typeof state.playersById)[string]> = { ...state.playersById };
    let changed = false;
    for (const [id, player] of Object.entries(players)) {
      const stats = statsFromRecords(records, id);
      if (stats.observedStats === null) continue;
      /*
       * 🔴 **必须保鲜**：统计随新行动累积而变化，若只在首次注入后就不再更新，
       * 决策读到的会是**过期样本**（实测踩到过：输入里 handsObserved=1，
       * 而真实记录已是 2 手）。这里每次都重算，只在**内容真的变化**时替换状态。
       */
      if (
        player.observedStats !== undefined &&
        JSON.stringify(player.observedStats) === JSON.stringify(stats.observedStats)
      ) {
        continue;
      }
      players[id] = Object.freeze({
        ...player,
        observedStats: stats.observedStats,
        observedStatsNoteZh: statsNoteZh(stats),
      });
      changed = true;
    }
    if (changed) state = Object.freeze({ ...state, playersById: Object.freeze(players) });
  }

  /* ---- 4. 记录真实行动 ---- */
  if (input.op.kind === 'ACT') {
    /*
     * 🔴 **`before` 必须是这一次操作之前的真实状态**（= 调用方传入的 `input.state`）。
     *
     * 曾经的写法是「若第 3 步注入了统计就用注入后的 `state` 当 before」——
     * 那会让**触发首次注入的那一次操作**（`state !== outcome.state`）自己
     * 推导不出记录（`after.actionHistory.length <= before.actionHistory.length`）：
     * 实测表现为「河牌面对下注的那一注没被记录」，进而 `foldToRiverBet` 永远为 0 机会。
     * 注入只改 `playersById` 的实测字段，**不影响 `actionHistory`** ⇒ 一律用 `input.state`。
     */
    const derived = deriveObservations(input.state, state);
    if (derived.length > 0) {
      const written = appendObservations(input.historyDir, derived);
      if (!written.ok) {
        for (const i of written.issues) historyIssues.push(issue(i.code, i.message));
      } else {
        recorded = written.written;
        skippedDuplicates = written.skippedDuplicates;
      }
    }
  }

  /* ---- 5. 撤销 ⇒ 回退该手被撤销操作写入的记录 ---- */
  if (input.op.kind === 'UNDO') {
    /*
     * 恢复后的状态里 `actionHistory.length` 就是「重放到恢复点为止」的真实行动数
     * ⇒ 保留 `historyLength <= 它` 的记录，恰好删掉被撤销的那条（及更晚的）。
     */
    const reverted = revertObservations(input.historyDir, {
      handId: handIdOf(state),
      keepHistoryLength: state.actionHistory.length,
    });
    if (!reverted.ok) for (const i of reverted.issues) historyIssues.push(issue(i.code, i.message));
  }

  return {
    outcome: state === outcome.state ? outcome : Object.freeze({ ...outcome, state }),
    historyIssues: Object.freeze(historyIssues),
    recorded,
    skippedDuplicates,
  };
}
