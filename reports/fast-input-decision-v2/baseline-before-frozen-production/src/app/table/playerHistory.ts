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

import { applyAction, actorOnTurn } from '../../domain/poker/engine.ts';
import { computePot, playerById } from '../../domain/poker/gameState.ts';
import { streetOrderOf as sharedStreetOrderOf } from './tableDynamicsSeatOrder.ts';
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

  /* ============================================================
   * 🔴 TABLE DYNAMICS V1：行动前状态快照（桌况统计的唯一事实来源）
   *
   * ## 为什么这些字段必须**在行动发生时**记录
   *
   * 桌况维度（入池松紧 / 跟注倾向 / 再加注压力 / 多人底池倾向 /
   * 面对不同下注大小的弃牌倾向）里的每一条，都是
   * **「机会」的分母**。而「机会由牌局状态定义，绝不由玩家动作定义」
   * （README 不变量 14）：一个从不在盲位防守的玩家，不能因为「他没有防守动作」
   * 就永远不进分母。
   *
   * 分母所需要的状态（当时有几个人还没弃牌、有效筹码多少、
   * 底池多大、他面对的下注占底池多少、他身后还有几个人没行动）
   * **只在这一刻存在** —— 事后再从行动记录里反推，就要重新实现一遍引擎。
   *
   * ## 向后兼容
   *
   * 全部可选。旧记录（本版本之前写入的）没有这些字段，
   * 桌况层必须把它们当作**「该条记录不参与桌况统计」**，
   * 而**不是**当作 0（那会把「未记录」变成「观测到 0」，是本项目明令禁止的形态）。
   * ============================================================ */

  /** 行动**之前**还没弃牌的玩家数（= 本手当前人数，不是座位容量） */
  activeCount?: number;
  /** 行动**之前**的有效筹码（BB）= 未弃牌玩家中最小「剩余 + 本街已投入」 */
  effectiveStackBB?: number;
  /** 行动**之前**的底池（BB，含本街已投入） */
  potBB?: number;
  /**
   * 行动**之前**该玩家面对的下注额（BB）。
   *
   * `0` = 他没面对下注（可以过牌或率先下注）。与 `facedBet` 的区别：
   * `facedBet` 只说「有没有」，本字段给出**多少** ——
   * 「面对不同下注大小的弃牌倾向」这条维度要的正是这个数。
   */
  facedBetBB?: number;
  /**
   * 面对的下注额 ÷ 当时的底池（含对手本次下注）。
   *
   * 分桶口径见 `tableDynamics.ts` 的 `BET_SIZE_BUCKETS`。
   * 未面对下注 ⇒ 0；底池为 0（理论上不会发生）⇒ `null`。
   */
  facedBetPotRatio?: number | null;
  /**
   * 该玩家在**本街行动顺序**里的序号（0 = 本街第一个行动的人）。
   *
   * 用途：翻前 `0 = 盲注位 / 1 = UTG` 之类的位置语义，
   * 以及「身后还有几个人没行动」（= 本街行动者总数 − 本序号 − 1）。
   * 无法确定时为 `null`（**不猜**）。
   */
  actorOrderIndex?: number | null;
  /** 本街会行动的玩家总数（用于算「身后还有几个」） */
  streetActorCount?: number | null;
  /**
   * 该玩家**身后**还有几个玩家尚未行动（含他之后的所有本街行动者）。
   *
   * 用途：「身后及盲位弃牌偏多 ⇒ 评估扩大后位开池」这条调整方向
   * 需要知道当时他身后到底有几个人 —— 人数为 0 时这条调整**不适用**。
   */
  playersYetToAct?: number | null;
  /** 该行动时 Button 的逻辑位置（位置语义的唯一权威来源） */
  buttonPosition?: string;
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

/* ============================================================
 * 🔴 TABLE DYNAMICS V1：行动前状态快照
 *
 * 这一节只做**一件事**：把桌况统计需要的分母，在行动发生的那一刻取出来。
 * 它不解释、不推断、不补默认值 —— 取不到就是 `null`，
 * 由桌况层把「缺字段」当成「该条记录不参与统计」。
 * ============================================================ */

/**
 * 一次行动发生**之前**的可观测状态。
 *
 * 全部字段都直接读引擎，唯一被计算的是 `playersYetToAct`
 *（= 本街行动者总数 − 本序号 − 1，纯计数）。
 */
type PreActionSnapshot = {
  actorPosition: string | null;
  toCallChips: number;
  activeCount: number | null;
  effectiveStackChips: number | null;
  potChips: number | null;
  actorOrderIndex: number | null;
  streetActorCount: number | null;
  buttonPosition: string | null;
};

const EMPTY_SNAPSHOT: PreActionSnapshot = {
  actorPosition: null,
  toCallChips: 0,
  activeCount: null,
  effectiveStackChips: null,
  potChips: null,
  actorOrderIndex: null,
  streetActorCount: null,
  buttonPosition: null,
};

/**
 * 本街的行动顺序（只保留还没弃牌的玩家），以及按钮的逻辑位置。
 *
 * 为什么需要它：`playersYetToAct` 与「翻前第几个行动」都必须来自
 * **牌局状态的行动顺序**，不能从行动记录反推 ——
 * 否则「从不盲位防守的玩家」永远不会进入分母（README 不变量 14）。
 *
 * 实现已移到 `tableDynamicsSeatOrder.ts`：`tableDynamicsServer` 需要**同一份**
 * 推导，两份实现迟早分歧（那正是「同一条事实两处各算一次」的缺陷形态）。
 */
function streetOrderOf(engine: {
  players: readonly { position: string; folded: boolean }[];
  street: string;
  config?: { tableSize?: number; dealerPosition?: string };
}): { order: string[]; buttonPosition: string | null } {
  return sharedStreetOrderOf(engine);
}

/**
 * 取「某个行动发生之前」的快照。
 *
 * ⚠️ 一次表操作可能追加**多条**行动（批量重放时），
 * 因此不能对全部行动复用同一个 `before` 快照 ——
 * 那样第 1 条之后的每条记录都会带上错误的底池与人数。
 * 调用方负责把状态逐步推进到该行动之前。
 */
function preActionSnapshot(engine: Parameters<typeof actorOnTurn>[0]): PreActionSnapshot {
  const id = actorOnTurn(engine);
  const actor = id === null ? undefined : playerById(engine, id);
  const live = engine.players.filter((p) => !p.folded);
  const committed = (p: (typeof engine.players)[number]): number =>
    p.committedByStreet[engine.street] ?? 0;

  const stacksBehind = live.map((p) => p.remainingStack + committed(p));
  const effectiveStackChips = stacksBehind.length === 0 ? null : Math.min(...stacksBehind);
  const potChips = computePot(engine);
  const { order, buttonPosition } = streetOrderOf(engine);

  const actorOrderIndex = actor === undefined ? null : order.indexOf(actor.position);
  const toCallChips = actor === undefined ? 0 : deriveLegalActions(engine, actor).callCost;

  return {
    actorPosition: actor?.position ?? null,
    toCallChips,
    activeCount: live.length,
    effectiveStackChips,
    potChips,
    actorOrderIndex: actorOrderIndex === null || actorOrderIndex < 0 ? null : actorOrderIndex,
    streetActorCount: order.length === 0 ? null : order.length,
    buttonPosition,
  };
}

/** 把快照按 BB 口径写成记录字段（金额一律保留 4 位，与既有 `toCallBB` 同口径） */
function snapshotFields(
  snapshot: PreActionSnapshot,
  chipsPerBB: number,
): Pick<
  ObservationRecord,
  | 'activeCount'
  | 'effectiveStackBB'
  | 'potBB'
  | 'facedBetBB'
  | 'facedBetPotRatio'
  | 'actorOrderIndex'
  | 'streetActorCount'
  | 'playersYetToAct'
  | 'buttonPosition'
> {
  const toBB = (chips: number): number => Number((chips / chipsPerBB).toFixed(4));
  const facedBetChips = snapshot.toCallChips;
  const potAfterBetChips =
    snapshot.potChips === null ? null : snapshot.potChips + Math.max(0, facedBetChips);
  return {
    activeCount: snapshot.activeCount ?? undefined,
    effectiveStackBB:
      snapshot.effectiveStackChips === null ? undefined : toBB(snapshot.effectiveStackChips),
    potBB: snapshot.potChips === null ? undefined : toBB(snapshot.potChips),
    facedBetBB: toBB(facedBetChips),
    /*
     * 池比口径 = 需跟注额 ÷ **面对下注后的底池**（= 行动前底池 + 他这次要跟的额）。
     * 这样「半池下注」得到 0.5/1.5 = 0.3333… 而不是 0.5 ——
     * 与扑克习惯里「⅓ 池 / 半池 / ¾ 池 / 满池」的分桶基准一致。
     */
    facedBetPotRatio:
      potAfterBetChips === null || potAfterBetChips <= 0 ? null : Number((facedBetChips / potAfterBetChips).toFixed(4)),
    actorOrderIndex: snapshot.actorOrderIndex,
    streetActorCount: snapshot.streetActorCount,
    playersYetToAct:
      snapshot.actorOrderIndex === null || snapshot.streetActorCount === null
        ? null
        : snapshot.streetActorCount - snapshot.actorOrderIndex - 1,
    buttonPosition: snapshot.buttonPosition ?? undefined,
  };
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

  const chipsPerBB = before.bigBlindBB > 0 ? before.bigBlindBB : 1;
  const handId = handIdOf(before);
  /** 街道取引擎**当时**的真实街（录牌/行动都以引擎为准） */
  const streetNow = viewBefore.ok ? viewBefore.engine.street : 'PREFLOP';

  /**
   * 逐步推进的引擎状态。
   *
   * 每次迭代结束时把本条行动应用到 `cursor` 上，使下一条行动拿到
   * **它自己的**行动前状态。应用失败（理论上不会发生 —— 历史本身就是
   * 这么重放出来的）⇒ 后续记录的快照字段置 `null`，绝不猜。
   */
  let cursor = viewBefore.ok ? viewBefore.engine : null;
  const out: ObservationRecord[] = [];

  for (const action of appended) {
    const seat = before.seats.find((s) => s.logicalPosition === action.position);
    const playerId = seat?.playerId ?? null;
    /** 座位没绑玩家（引擎自动补齐的盲注等）⇒ 不记录，绝不虚构主人 */
    if (playerId === null) continue;

    const snapshot: PreActionSnapshot =
      cursor === null
        ? EMPTY_SNAPSHOT
        : preActionSnapshot(cursor as Parameters<typeof actorOnTurn>[0]);

    out.push(
      Object.freeze({
        handId,
        playerId,
        displayName: before.playersById[playerId]?.displayName,
        seatId: seat?.seatId ?? `seat_${action.position}`,
        street: (action.street ?? streetNow) as ObservationRecord['street'],
        actionType: action.type,
        amountBB: action.amountBB ?? 0,
        facedBet: snapshot.toCallChips > 0,
        toCallBB: Number((snapshot.toCallChips / chipsPerBB).toFixed(4)),
        ...snapshotFields(snapshot, chipsPerBB),
        seq: before.revision,
        baseRevision: before.revision,
        historyLength: after.actionHistory.length,
        source: 'USER_INPUT' as const,
        saved: false,
        /*
         * 🔴 **两个终态都算「本手已完成」**（2026-09-22 修复）。
         *
         * `HandPhase` 有两个终态（`gameState.ts:79-85`）：
         * - `SHOWDOWN`：河牌下注轮结束，等待摊牌 —— **绝大多数手停在这里**
         * - `COMPLETE`：仅剩一人，或摊牌结果已记录
         *
         * 修复前只判 `=== 'COMPLETE'`，于是摊牌手**全部**拿到
         * `handComplete = false`。实测 24 条记录里 0 条为 true、界面
         * 「已完成 N 手」恒为 0 —— 而统计本身照常计入（两处口径不一致）。
         */
        handComplete: phase === 'COMPLETE' || phase === 'SHOWDOWN',
      }),
    );

    /* 推进到本条行动**之后**，供下一条使用 */
    if (cursor !== null) {
      const actorId = actorOnTurn(cursor as Parameters<typeof actorOnTurn>[0]);
      if (actorId !== null) {
        const applied = applyAction(cursor as never, {
          playerId: actorId,
          type: action.type as never,
          ...(action.amountBB === undefined ? {} : { amount: Math.round(action.amountBB * chipsPerBB) }),
        } as never);
        cursor = applied.ok ? (applied.state as typeof cursor) : null;
      } else {
        cursor = null;
      }
    }
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
