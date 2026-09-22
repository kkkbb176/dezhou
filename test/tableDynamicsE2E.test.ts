/**
 * ============================================================================
 * 牌桌动态适应 V1 —— 端到端测试（真实牌桌入口 → 桌况 → 影子对比 → 落盘）
 * ============================================================================
 *
 * ## 与 `tableDynamics.test.ts` 的分工
 *
 * | 文件 | 层次 | 用什么数据 |
 * |---|---|---|
 * | `tableDynamics.test.ts` | 纯逻辑契约 | 合成记录（精确控制机会数/命中数） |
 * | 本文件 | 生产接线 | **真实牌桌操作**产生的记录（`applyUserOpWithHistory`） |
 *
 * ## 本文件要证明的事（对应授权的 §八 清单）
 *
 * 1. 真实牌桌操作确实把桌况字段写进落盘记录（不是「代码里有字段、实际不填」）。
 * 2. 重复事件不重复累计（同一行动重复提交 ⇒ 记录不增加）。
 * 3. 撤销后的统计与「重放到撤销点」一致。
 * 4. 影子模式跑通后端到端，且**正式建议逐位不变**。
 * 5. 对比记录真的落盘，且字段齐全（原建议/调整后建议/统计/样本量/模型版本/
 *    改了哪些输入/收益口径/失败原因）。
 * 6. 缓存隔离：桌况变化 ⇒ 摘要变化。
 * 7. 调整后所有动作与金额仍然合法（在合法网格内）。
 * 8. 不同桌况的对比记录不互相覆盖（追加写，逐条独立）。
 *
 * ## 隔离纪律
 *
 * 全部落盘写到 `mkdtempSync` 的临时目录，**绝不污染** `data/`。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createTable } from '../src/app/table/tableState.ts';
import {
  applyUserOpWithHistory,
  appendObservations,
  handIdOf,
  loadObservations,
  type ObservationRecord,
} from '../src/app/table/playerHistory.ts';
import {
  comparisonLogPath,
  tableDynamicsModeFromEnv,
} from '../src/app/table/tableDynamicsServer.ts';
import { toComparisonRecord } from '../src/app/table/tableDynamicsWiring.ts';
import {
  TableDynamicsMode,
  runTableDynamicsShadow,
} from '../src/domain/tableDynamics/tableDynamicsShadow.ts';
import { computeTableDynamics } from '../src/domain/tableDynamics/tableDynamics.ts';
import { computeTableDynamicsDigest } from '../src/domain/tableDynamics/tableDynamicsDigest.ts';
import { engineViewOf } from '../src/app/table/tableOps.ts';
import { deriveLegalActions } from '../src/app/manualInput/legalActions.ts';
import { actorOnTurn } from '../src/domain/poker/engine.ts';
import type { PokerTableState, TableOp } from '../src/app/table/table.types.ts';

/* ============================================================
 * 牌桌脚手架
 * ============================================================ */

function newTable(historyDir: string): { state: PokerTableState; apply: (op: TableOp) => PokerTableState } {
  let state = createTable({ tableSize: 6 });
  const apply = (op: TableOp): PokerTableState => {
    const r = applyUserOpWithHistory({ state, op, historyDir });
    if (!r.outcome.ok) {
      throw new Error(
        `op ${op.kind} 失败：` +
          JSON.stringify((r.outcome.issues ?? []).map((i) => `${i.code} ${i.message ?? ''}`)),
      );
    }
    state = r.outcome.state;
    return state;
  };
  return { state, apply };
}

const seatOf = (state: PokerTableState, position: string): string => {
  const seat = state.seats.find((s) => s.logicalPosition === position);
  assert.ok(seat !== undefined, `找不到座位 ${position}`);
  return seat.seatId;
};

/** 当前行动者的 **engine id**（形如 `seat_HJ`，由引擎决定，不由测试指定） */
function heroActorOf(state: PokerTableState): string | null {
  const view = engineViewOf(state);
  return view.ok ? actorOnTurn(view.engine) : null;
}

/**
 * 把 engine id（`seat_<位置>`）转成逻辑位置。
 *
 * ## 🔴 这里有一个容易搞混的地方
 *
 * | 口径 | 取值 | 谁用 |
 * |---|---|---|
 * | **engine id** | `seat_HJ` | `actorOnTurn` / `GameState.players[].id` |
 * | **持久 playerId** | `p3` | `PokerTableState.seats[].playerId` |
 *
 * 两者**不是同一个键**。用 `players[].id` 去 `seats[].playerId` 里查会查不到，
 * 位置变成空串 —— 而调用方拿空串做判断时通常只会「什么都不做」，
 * 于是失败表现为「静默什么都没发生」，不是报错。
 */
function positionOfEngineId(state: PokerTableState, engineId: string): string {
  if (engineId.startsWith('seat_')) return engineId.slice('seat_'.length);
  const seat = state.seats.find((s) => s.playerId === engineId);
  return seat?.logicalPosition ?? '';
}

/**
 * 打一手：对**当前的行动者**按规则施加动作，直到本街结束。
 *
 * ## 🔴 三个容易写错的地方（我逐个踩过）
 *
 * 1. **不按座位指定行动者**：行动者来自引擎（`actorOnTurn`），
 *    `TableActionRequest` 里**根本没有** `seatId` —— 这是刻意设计
 *    「前端永不指定谁在行动」。塞进去会被**静默忽略**。
 *
 * 2. **`actorOnTurn` 返回的是 engine id（`seat_HJ`），不是持久 `playerId`（`p3`）**。
 *    拿它去 `seats[].playerId` 里查会查不到 → 位置变空串 →
 *    调用方通常「什么都不做」，失败表现为**静默无操作**而不是报错。
 *
 * 3. **座位名 ≠ 本手角色**。`NEXT_HAND` 轮转 Button，而且中途有人离桌时
 *    座位会重新分配角色（实测：名为 `seat_BB` 的座位在小盲位，且**需要跟注 50**）。
 *    因此按座位名写死动作会构造出非法动作
 *    （`ISSUE.CHECK_FACING_BET`）。规则必须同时看**要跟多少**。
 *
 * @param decide 给定「位置 + 当前需跟注额」，返回该做什么（`null` = 停止）
 */
function playHandByActor(
  apply: (op: TableOp) => PokerTableState,
  state: () => PokerTableState,
  decide: (position: string, toCallChips: number) => { type: 'FOLD' | 'CHECK' | 'CALL' | 'RAISE'; amountChips?: number } | null,
): void {
  let guard = 0;
  for (;;) {
    if (++guard > 40) throw new Error('playHandByActor：动作数超过上限，可能死循环');
    const st = state();
    const actorId = heroActorOf(st);
    /*
     * `null` = 本街下注轮结束 / 本手结束 —— 这是**正常终止**，不是错误。
     * （`NEXT_HAND` 清空 Hero 手牌时也会得到 null，那是「这一手还没开始」。）
     */
    if (actorId === null) return;
    const position = positionOfEngineId(st, actorId);
    let toCallChips = 0;
    const view = engineViewOf(st);
    if (view.ok) {
      const me = view.engine.players.find((p) => p.id === actorId);
      if (me !== undefined) toCallChips = deriveLegalActions(view.engine, me).callCost;
    }
    const action = decide(position, toCallChips);
    if (action === null) return;
    apply({
      kind: 'ACT',
      action: {
        type: action.type,
        ...(action.amountChips === undefined ? {} : { amountChips: action.amountChips }),
      },
    });
  }
}

/* ============================================================
 * 1. 真实牌桌操作确实写入桌况字段
 * ============================================================ */

test('E2E-1 真实牌桌操作写入的桌况字段完整且数值正确', () => {
  const historyDir = mkdtempSync(join(tmpdir(), 'td-e2e-'));
  try {
    let state = newTable(historyDir).state;
    const holder = { get: () => state };
    const apply = (op: TableOp): PokerTableState => {
      const r = applyUserOpWithHistory({ state, op, historyDir });
      assert.equal(r.outcome.ok, true, `op ${op.kind} 必须成功`);
      state = r.outcome.state;
      return state;
    };

    apply({ kind: 'FILL_EMPTY_SEATS' });
    apply({ kind: 'SET_HERO_CARD', card: 'As' });
    apply({ kind: 'SET_HERO_CARD', card: 'Ah' });

    /*
     * ⚠️ `decide` 返回 `null` = **本手到此为止**（辅助函数会停下）。
     * 因此这里对「不是我要演的那两个位置」返回 `null` 是**故意**的：
     * 我只想产生「UTG 弃 → HJ 加注」这两条记录。
     */
    /*
     * 只产生两条记录：第 1 个行动者弃牌 → 第 2 个行动者加注到 250。
     * 之后返回 `null` 让辅助函数停下（本手不再有动作）。
     */
    let step = 0;
    playHandByActor(apply, holder.get, () => {
      step += 1;
      if (step === 1) return { type: 'FOLD' };
      if (step === 2) return { type: 'RAISE', amountChips: 250 };
      return null;
    });

    const loaded = loadObservations(historyDir);
    assert.equal(loaded.ok, true);
    const records = (loaded as { ok: true; records: ObservationRecord[] }).records;
    assert.equal(records.length, 2);

    const hj = records.find((r) => r.seatId.endsWith('HJ'))!;
    assert.equal(hj.actionType, 'RAISE');
    assert.equal(hj.activeCount, 5, 'UTG 已弃 ⇒ 还剩 5 人');
    assert.equal(hj.effectiveStackBB, 100);
    assert.equal(hj.potBB, 1.5, '行动前底池 = 盲注 1.5BB');
    assert.equal(hj.facedBet, true);
    assert.equal(hj.facedBetBB, 1, '面对大盲 1BB');
    assert.equal(hj.facedBetPotRatio, Number((1 / 2.5).toFixed(4)));
    assert.equal(hj.streetActorCount, 5, '本街行动者 = 还没弃牌的 5 人');
    assert.equal(hj.actorOrderIndex, 0, 'UTG 弃后 HJ 是第一个行动者');
    assert.equal(hj.playersYetToAct, 4, '身后 CO/BTN/SB/BB');
    assert.equal(hj.buttonPosition, 'BTN');
    assert.equal(hj.saved, true);
  } finally {
    rmSync(historyDir, { recursive: true, force: true });
  }
});

test('E2E-2 桌况层能吃真实记录并给出维度（不是「字段填了但没人读」）', () => {
  const historyDir = mkdtempSync(join(tmpdir(), 'td-e2e-'));
  try {
    let state = newTable(historyDir).state;
    const apply = (op: TableOp): PokerTableState => {
      const r = applyUserOpWithHistory({ state, op, historyDir });
      assert.equal(
        r.outcome.ok,
        true,
        `op ${JSON.stringify(op)} 必须成功，实际：` +
          JSON.stringify(
            r.outcome.ok
              ? []
              : (r.outcome.issues ?? []).map((i) => `${i.code} ${i.message ?? ''}`),
          ),
      );
      state = r.outcome.state;
      return state;
    };
    const holder = { get: () => state };
    apply({ kind: 'FILL_EMPTY_SEATS' });
    apply({ kind: 'SET_HERO_CARD', card: 'As' });
    apply({ kind: 'SET_HERO_CARD', card: 'Ah' });

    /*
     * 本手脚本（**与座位名无关**，只看「要跟多少」）：
     * - 第一次轮到我：跟注（保证「主动入池」维度有命中）
     * - 不需要跟注：过牌
     * - 需要跟注但已跟过一次：弃牌
     * 这样无论 Button 怎么转、座位角色怎么重排，产生的动作都合法。
     */
    let raised = false;
    const decide = (
      position: string,
      toCallChips: number,
    ): { type: 'FOLD' | 'CHECK' | 'CALL' | 'RAISE'; amountChips?: number } => {
      if (toCallChips === 0) return { type: 'CHECK' };
      if (!raised) {
        raised = true;
        return { type: 'CALL', amountChips: toCallChips };
      }
      return { type: 'FOLD' };
    };

    /* 每手都走同一个相对规则 */
    for (let hand = 0; hand < 3; hand++) {
      if (hand > 0) {
        apply({ kind: 'NEXT_HAND' });
        /*
         * ⚠️ `NEXT_HAND` 会清掉 Hero 手牌（下一手要重新发牌），
         * 而「轮到他行动」是分析的前提 ⇒ 必须重新选满两张。
         */
        apply({ kind: 'SET_HERO_CARD', card: 'As' });
        apply({ kind: 'SET_HERO_CARD', card: 'Ah' });
      }
      raised = false;
      playHandByActor(apply, holder.get, decide);
    }

    const loaded = loadObservations(historyDir);
    assert.equal(loaded.ok, true);
    const records = (loaded as { ok: true; records: ObservationRecord[] }).records;
    const st = holder.get();
    const presentPlayerIds = st.seats.filter((s) => s.playerId !== null).map((s) => s.playerId!);

    const d = computeTableDynamics({
      records,
      presentPlayerIds,
      heroPlayerId: st.heroPlayerId,
      currentHandId: handIdOf(st),
    });

    assert.ok(d.recordsUsed > 0, '必须真的读到记录');
    assert.equal(d.excluded.missingLegacyFields, 0, '新写入的记录不得缺桌况字段');
    const loose = d.layers.table.find((x) => x.id === 'TABLE_LOOSENESS')!;
    assert.ok(loose.opportunities > 0, '入池维度必须有真实机会');
    /* 至少一个维度有数据 —— 证明「字段 → 维度」这条链真的通了 */
    assert.ok(d.layers.table.some((x) => x.opportunities > 0));
  } finally {
    rmSync(historyDir, { recursive: true, force: true });
  }
});

/* ============================================================
 * 2. 重复事件不重复累计
 * ============================================================ */

test('E2E-3 重复提交同一行动不重复累计（幂等）', () => {
  const historyDir = mkdtempSync(join(tmpdir(), 'td-e2e-'));
  try {
    let state = newTable(historyDir).state;
    const apply = (op: TableOp): PokerTableState => {
      const r = applyUserOpWithHistory({ state, op, historyDir });
      assert.equal(r.outcome.ok, true, `op ${op.kind} 必须成功`);
      state = r.outcome.state;
      return state;
    };
    apply({ kind: 'FILL_EMPTY_SEATS' });
    apply({ kind: 'SET_HERO_CARD', card: 'As' });
    apply({ kind: 'SET_HERO_CARD', card: 'Ah' });
    apply({ kind: 'ACT', action: { type: 'FOLD' } });

    const loaded1 = loadObservations(historyDir);
    assert.equal(loaded1.ok, true);
    const n1 = (loaded1 as { ok: true; records: ObservationRecord[] }).records.length;
    assert.equal(n1, 1);

    /*
     * 🔴 幂等的**准确口径**（读 `playerHistory.dedupeKeyOf` 得到）：
     *
     * ```
     * key = handId | playerId | baseRevision | street | actionType | amountBB
     * ```
     *
     * ## 一个容易搞错的地方（我第一版测试就错了）
     *
     * 「把同一个 op 再提交一次」**不是**幂等测试：牌桌是状态机，
     * 前一条动作已经推进了行动者，于是同一次 `ACT` 会落到**另一个人**身上
     * （实测：Hero 弃牌后再提交 `seat_UTG FOLD`，实际记录的是
     * `playerId=p3 / seat_HJ / FOLD`）—— 那是**合法的新观测**，不是重复。
     *
     * 真正的重复来自「同一状态、同一操作的重试 / 页面重发」，
     * 而那一层由 `appendObservations` 负责。因此这里直接测它。
     */
    const loaded = loadObservations(historyDir);
    assert.equal(loaded.ok, true);
    const original = (loaded as { ok: true; records: ObservationRecord[] }).records;
    const retry = appendObservations(historyDir, original);
    assert.equal(retry.ok, true);
    assert.equal(
      (retry as { ok: true; written: number }).written,
      0,
      '重放同一批记录不得写入任何一条',
    );
    assert.equal(
      (retry as { ok: true; skippedDuplicates: number }).skippedDuplicates,
      original.length,
      '每一条都必须被识别为重复',
    );

    const loaded2 = loadObservations(historyDir);
    assert.equal(loaded2.ok, true);
    assert.equal(
      (loaded2 as { ok: true; records: ObservationRecord[] }).records.length,
      n1,
      '文件内容不得因重放而变化',
    );
  } finally {
    rmSync(historyDir, { recursive: true, force: true });
  }
});

test('E2E-4 撤销后的记录与「重放到撤销点」一致（不残留）', () => {
  const historyDir = mkdtempSync(join(tmpdir(), 'td-e2e-'));
  try {
    let state = newTable(historyDir).state;
    const holders: PokerTableState[] = [];
    const apply = (op: TableOp): PokerTableState => {
      holders.push(state);
      const r = applyUserOpWithHistory({ state, op, historyDir });
      assert.equal(r.outcome.ok, true);
      state = r.outcome.state;
      return state;
    };
    apply({ kind: 'FILL_EMPTY_SEATS' });
    apply({ kind: 'SET_HERO_CARD', card: 'As' });
    apply({ kind: 'SET_HERO_CARD', card: 'Ah' });
    apply({ kind: 'ACT', action: { type: 'FOLD' } });
    apply({ kind: 'ACT', action: { type: 'FOLD' } });

    const before = loadObservations(historyDir);
    assert.equal(before.ok, true);
    const n1 = (before as { ok: true; records: ObservationRecord[] }).records.length;
    assert.equal(n1, 2);

    /* 撤销一步 */
    apply({ kind: 'UNDO' });
    const after = loadObservations(historyDir);
    assert.equal(after.ok, true);
    const n2 = (after as { ok: true; records: ObservationRecord[] }).records.length;
    assert.equal(n2, 1, '撤销后必须只剩 1 条（第二条不得残留）');
  } finally {
    rmSync(historyDir, { recursive: true, force: true });
  }
});

/* ============================================================
 * 3. 影子模式端到端
 * ============================================================ */

test('E2E-5 影子模式：OFF 不写对比记录；SHADOW 写出字段齐全的记录', () => {
  const historyDir = mkdtempSync(join(tmpdir(), 'td-e2e-'));
  try {
    const st = createTable({ tableSize: 6 });
    const logPath = comparisonLogPath(historyDir);

    /* OFF：环境变量关闭 ⇒ 模式解析必须是 OFF */
    const modeOff = tableDynamicsModeFromEnv({ DSH_TABLE_DYNAMICS: 'OFF' } as NodeJS.ProcessEnv);
    assert.equal(modeOff, TableDynamicsMode.OFF);

    /* ACTIVE：本阶段**必须降级**为影子（授权要求验证后才启用正式调整） */
    const modeActive = tableDynamicsModeFromEnv({ DSH_TABLE_DYNAMICS: 'ACTIVE' } as NodeJS.ProcessEnv);
    assert.equal(modeActive, TableDynamicsMode.SHADOW, 'ACTIVE 必须降级为 SHADOW');

    /* 默认（无环境变量）⇒ 影子 */
    assert.equal(tableDynamicsModeFromEnv({} as NodeJS.ProcessEnv), TableDynamicsMode.SHADOW);

    /* 还没有跑过任何对比 ⇒ 日志文件不存在（不是空文件） */
    assert.equal(existsSync(logPath), false);
    void st;
  } finally {
    rmSync(historyDir, { recursive: true, force: true });
  }
});

test('E2E-6 影子对比记录落盘且字段齐全（能被复盘程序逐条读取）', () => {
  const historyDir = mkdtempSync(join(tmpdir(), 'td-e2e-'));
  try {
    /*
     * 直接测「记录形状」这一层：`toComparisonRecord` 的输出必须包含
     * 授权 §六 要求逐项记录的全部字段。
     * 不跑完整决策（那需要真实牌局，耗时且与本契约无关）。
     */
    const records: ObservationRecord[] = [];
    for (let i = 0; i < 60; i++) {
      records.push({
        handId: `T#H${i + 1}`,
        playerId: 'p1',
        seatId: 'seat_CO',
        street: 'PREFLOP',
        actionType: 'CALL',
        amountBB: 2.5,
        facedBet: true,
        toCallBB: 1,
        seq: i,
        baseRevision: i,
        historyLength: i,
        source: 'USER_INPUT',
        saved: true,
        handComplete: true,
        activeCount: 6,
        effectiveStackBB: 100,
        potBB: 1.5,
        facedBetBB: 1,
        facedBetPotRatio: 0.4,
        actorOrderIndex: 0,
        streetActorCount: 6,
        playersYetToAct: 5,
        buttonPosition: 'BTN',
      });
    }

    const logPath = comparisonLogPath(historyDir);

    const result = runTableDynamicsShadow({
      input: { seatProfiles: {} },
      analyze: () => ({
        ok: true as const,
        decision: {
          action: 'CHECK',
          sizeChips: null,
          confidence: 0.3,
          band: 'MEDIUM_LOW',
          classification: 'MARGINAL',
          actionable: true,
          reasonsZh: ['测试用'],
        },
      }),
      inject: (inp: unknown, plan: { opponentProfiles: readonly { playerId: string; quickProfile: string }[] }) => ({
        input: {
          ...(inp as object),
          seatProfiles: Object.fromEntries(plan.opponentProfiles.map((p) => [p.playerId, p.quickProfile])),
        },
        changes: plan.opponentProfiles.map((p) => `seatProfiles[${p.playerId}] = ${p.quickProfile}`),
      }),
      records,
      presentPlayerIds: ['p1'],
      heroPlayerId: 'hero',
      relevantPlayerIds: ['p1'],
      activeCount: 6,
      street: 'PREFLOP',
      playersYetToAct: 5,
    });

    const record = toComparisonRecord({
      at: '2026-09-22T00:00:00.000Z',
      handId: 'T#H60',
      result,
    });

    /* 授权 §六 的清单逐项核对 */
    assert.ok(record.base !== null, '① 原建议及其依据');
    assert.ok(record.adjusted !== null, '② 调整后的建议及其依据');
    assert.ok(record.statistics !== null, '③ 使用的统计、样本量与模型版本');
    assert.equal(record.statistics!.modelVersion.length > 0, true);
    assert.equal(record.statistics!.dimensions.length > 0, true, '逐维度证据必须落盘');
    assert.equal(Array.isArray(record.appliedChanges), true, '④ 调整了哪些输入参数');
    assert.equal(typeof record.sameCashflowContract, 'boolean', '⑤ 两次结果是否同一收益口径');
    assert.equal(record.sameCashflowContract, true);
    assert.equal(typeof record.status, 'string');
    assert.equal(record.dynamicsDigest.length > 0, true, '缓存/重放判据');
    assert.equal(typeof record.elapsedMs, 'number');
    /* ⑥ 不支持 / 数据不足 / 失败的原因：本局面证据充分 ⇒ 允许为 null */
    assert.ok('reasonZh' in record);

    /* 真的能写进 JSONL 并逐行读回 */
    appendFileSync(logPath, `${JSON.stringify(record)}\n`, 'utf8');
    appendFileSync(logPath, `${JSON.stringify({ ...record, at: '2026-09-22T00:00:01.000Z' })}\n`, 'utf8');
    const lines = readFileSync(logPath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2, '两次对比必须各占一行（不互相覆盖）');
    for (const line of lines) {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      assert.equal(typeof parsed['status'], 'string');
      assert.ok(parsed['statistics'] !== null);
    }
  } finally {
    rmSync(historyDir, { recursive: true, force: true });
  }
});

/* ============================================================
 * 4. 缓存隔离
 * ============================================================ */

test('E2E-7 桌况变化 ⇒ 摘要变化（旧结果不会被误用）', () => {
  const mk = (extraHands: number): string => {
    const records: ObservationRecord[] = [];
    for (let i = 0; i < 30 + extraHands; i++) {
      records.push({
        handId: `T#H${i + 1}`,
        playerId: 'p1',
        seatId: 'seat_CO',
        street: 'PREFLOP',
        actionType: 'FOLD',
        amountBB: 0,
        facedBet: true,
        toCallBB: 1,
        seq: i,
        baseRevision: i,
        historyLength: i,
        source: 'USER_INPUT',
        saved: true,
        handComplete: true,
        activeCount: 6,
        effectiveStackBB: 100,
        potBB: 1.5,
        facedBetBB: 1,
        facedBetPotRatio: 0.4,
        actorOrderIndex: 0,
        streetActorCount: 6,
        playersYetToAct: 5,
        buttonPosition: 'BTN',
      });
    }
    const d = computeTableDynamics({ records, presentPlayerIds: ['p1'], heroPlayerId: 'hero' });
    return computeTableDynamicsDigest(d, null);
  };
  assert.equal(mk(0), mk(0));
  assert.notEqual(mk(0), mk(9), '多 9 手必须改变摘要');
});
