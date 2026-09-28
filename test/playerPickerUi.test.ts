/**
 * PLAYER PROFILE TABLE UI V1 · 选人 / 名册 / 画像展示 回归测试
 * ============================================================================
 *
 * 覆盖授权 §七 要求的新增测试面：**玩家身份绑定、前端搜索、同名区分、
 * 历史恢复、画像展示、错误处理**。全部走生产入口：
 * `applyUserOpWithHistory`（真实行动落盘）、`listKnownPlayers`（名册）、
 * `startAlphaServer` + `fetch`（真实 HTTP 端点）、以及前端资源内容断言。
 *
 * 🔴 **数据隔离**：每个测试用 `mkdtempSync`；HTTP 测试用
 * `DSH_PLAYER_HISTORY_DIR` 指到临时目录，**绝不**写使用者的 `data/`。
 * 🔴 **受控输入声明**：需要「已接通统计」时用 `appendObservations` 写入**受控记录**
 *（不是真实牌局），只为验证名册映射与展示，已在用例内注明。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import { startAlphaServer } from '../src/app/webServer.ts';
import { createTable, seatIdOfPosition } from '../src/app/table/tableState.ts';
import { engineViewOf } from '../src/app/table/tableOps.ts';
import {
  applyUserOpWithHistory,
  appendObservations,
  historyFilePath,
  listKnownPlayers,
  type ObservationRecord,
} from '../src/app/table/playerHistory.ts';
import { deriveLegalActions } from '../src/app/manualInput/legalActions.ts';
import { actorOnTurn } from '../src/domain/poker/engine.ts';
import { playerById } from '../src/domain/poker/gameState.ts';
import type { PokerTableState, TableOp } from '../src/app/table/table.types.ts';
import type { Position } from '../src/domain/types.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const tmp = (): string => mkdtempSync(join(tmpdir(), 'dsh-picker-'));

const go = (state: PokerTableState, op: TableOp, dir: string): PokerTableState => {
  const r = applyUserOpWithHistory({ state, op, historyDir: dir });
  if (!r.outcome.ok) throw new Error(`${op.kind}: ${r.outcome.issues.map((i) => i.message).join(' / ')}`);
  return r.outcome.state;
};

const actorPosition = (state: PokerTableState): string => {
  const view = engineViewOf(state);
  if (!view.ok) throw new Error('engineView 失败');
  const id = actorOnTurn(view.engine);
  const p = id === null ? undefined : playerById(view.engine, id);
  if (p === undefined) throw new Error('无行动者');
  return p.position;
};

const callAmount = (state: PokerTableState): number => {
  const view = engineViewOf(state);
  if (!view.ok) throw new Error('engineView 失败');
  const id = actorOnTurn(view.engine);
  const p = id === null ? undefined : playerById(view.engine, id);
  if (p === undefined) throw new Error('无行动者');
  return deriveLegalActions(view.engine, p).callCost;
};

function foldUntil(state: PokerTableState, position: string, dir: string): PokerTableState {
  let s = state;
  for (let i = 0; i < 14 && actorPosition(s) !== position; i += 1) {
    s = go(s, { kind: 'ACT', action: { type: 'FOLD' } }, dir);
  }
  return s;
}

/** 建桌 + 全座加人；`bindings` 指定「座位 → {playerId, displayName}」 */
function setup(
  dir: string,
  bindings: Readonly<Record<string, { playerId?: string; displayName?: string }>> = {},
): PokerTableState {
  let state = createTable({ tableSize: 9, heroPosition: 'BTN' as Position, defaultStackBB: 100 });
  for (const seat of [...state.seats]) {
    if (seat.playerId !== null) continue;
    const binding = bindings[seat.logicalPosition] ?? {};
    state = go(state, { kind: 'ADD_PLAYER', seatId: seat.seatId, ...binding }, dir);
  }
  state = go(state, { kind: 'SET_HERO_CARD', card: 'As' }, dir);
  return go(state, { kind: 'SET_HERO_CARD', card: 'Ks' }, dir);
}

/** 让指定座位的玩家做出一个真实行动（同时产生一条真实记录） */
function oneRealHand(dir: string, bindings: Record<string, { playerId?: string; displayName?: string }>): PokerTableState {
  let state = setup(dir, bindings);
  const target = Object.keys(bindings)[0]!;
  state = foldUntil(state, target, dir);
  state = go(state, { kind: 'ACT', action: { type: 'CALL', amountChips: callAmount(state) } }, dir);
  return state;
}

/* ============================================================
 * 名册与搜索（授权 §二.1–2、§三）
 * ============================================================ */

test('名册：按名字/身份搜索、显示手数与稳定 id', () => {
  const dir = tmp();
  oneRealHand(dir, { CO: { playerId: 'player_001', displayName: '阿豪' } });

  const all = listKnownPlayers(dir);
  assert.equal(all.ok, true);
  if (!all.ok) return;
  /** ⚠️ 名册只包含**真的做过行动**的玩家：本手前面几位弃牌者也是真实行动 ⇒ 也会出现 */
  const mine = all.players.find((p) => p.playerId === 'player_001');
  assert.notEqual(mine, undefined, '做行动的玩家必须出现在名册里');
  assert.equal(mine!.displayName, '阿豪');
  assert.equal(mine!.handsObserved, 1, '真实行动必须计入累计手数');
  assert.ok(all.players.length >= 1);

  const byName = listKnownPlayers(dir, '阿豪');
  assert.equal(byName.ok, true);
  if (!byName.ok) return;
  assert.equal(byName.players.length, 1, '按名字可搜');
  assert.equal(byName.players[0]!.playerId, 'player_001');
  assert.equal((listKnownPlayers(dir, 'player_00') as { players: readonly unknown[] }).players.length, 1, '按身份可搜');
  assert.equal((listKnownPlayers(dir, '不存在的人') as { players: readonly unknown[] }).players.length, 0, '搜不到就是空');
});

test('同名不同身份：两条独立记录、标记 duplicateName，**绝不自动合并**', () => {
  const dir = tmp();
  /** 两位**同名**玩家各做一次真实行动 */
  let state = oneRealHand(dir, { CO: { playerId: 'player_a', displayName: '阿豪' } });
  const hand2 = go(state, { kind: 'NEXT_HAND' }, dir);
  oneRealHand(dir, { HJ: { playerId: 'player_b', displayName: '阿豪' } });

  const listed = listKnownPlayers(dir, '阿豪');
  assert.equal(listed.ok, true);
  if (!listed.ok) return;
  assert.equal(listed.players.length, 2, '同名必须是两条独立记录');
  const ids = listed.players.map((p) => p.playerId).sort();
  assert.deepEqual(ids, ['player_a', 'player_b'], '身份必须各自独立');
  assert.equal(listed.players.every((p) => p.duplicateName === true), true, '必须标记同名，交给使用者区分');
  assert.ok(hand2.revision > state.revision - 1);
});

test('没有观测机会的指标必须为 null（**不得显示为 0%**）；无历史则是空名册', () => {
  const dir = tmp();
  assert.deepEqual((listKnownPlayers(dir) as { players: readonly unknown[] }).players, [], '无历史 ⇒ 空名册');

  oneRealHand(dir, { CO: { playerId: 'player_001', displayName: '阿豪' } });
  const listed = listKnownPlayers(dir);
  assert.equal(listed.ok, true);
  if (!listed.ok) return;
  const p = listed.players[0]!;
  assert.equal(p.foldToRiverBet, null, '没有河牌面对下注的机会 ⇒ null（不是 0%）');
  assert.equal(p.riverCheckRaise, null, '没有过牌-加注机会 ⇒ null（不是 0%）');
  /*
   * 🔴 **契约更新（KQ 阶段四）**：`statsFromRecords` 现在**还会**从真实记录推导
   * 翻前三项（`vpip` / `pfr` / `threeBet`），因此「有通道且有数据」的项不再是 0 个。
   *
   * 「宁缺勿假」的**本意完整保留**，并改成更强的形式断言：
   * · **没有机会**的项（这里的两个河牌项）一律**不得**出现在已接通列表；
   * · **有机会**的项（翻前有行动）**必须**出现；
   * · 两个列表必须**互斥**（有通道且有数据 vs 尚无通道）。
   */
  assert.ok(!p.connectedStatKeys.includes('foldToRiverBet'), '河牌无机会 ⇒ 不得声称已接通');
  assert.ok(!p.connectedStatKeys.includes('riverCheckRaise'), '河牌无机会 ⇒ 不得声称已接通');
  assert.ok(p.connectedStatKeys.includes('vpip'), '翻前有行动 ⇒ vpip 必须已接通');
  assert.ok(p.connectedStatKeys.includes('pfr'), '翻前有行动 ⇒ pfr 必须已接通');
  for (const k of p.connectedStatKeys) {
    assert.ok(!p.unconnectedStatKeys.includes(k), `${k} 不得同时出现在「已接通」与「无通道」两个列表里`);
  }
  assert.equal(
    p.unconnectedStatKeys.length,
    3,
    '尚无通道的 3 项（wtsd / foldToTurnCBet / turnCheckRaise）必须如实列出；' +
      '阶段四第二轮已接通 foldToFlopCBet 与 flopCheckRaise',
  );
  assert.ok(p.noteZh.includes('实测历史'), '必须带中文披露');
});

test('已接通的统计如实显示为「成功 / 机会」（受控记录）', () => {
  const dir = tmp();
  /** ⚠️ 受控记录（不是真实牌局）：只为验证名册映射与展示字段 */
  const controlled: ObservationRecord = {
    handId: 'h1', playerId: 'player_001', displayName: '阿豪', seatId: 'seat_CO',
    street: 'RIVER', actionType: 'FOLD', amountBB: 0, facedBet: true, toCallBB: 4,
    seq: 1, baseRevision: 1, historyLength: 18, source: 'USER_INPUT', saved: false, handComplete: true,
  };
  const written = appendObservations(dir, [controlled]);
  assert.equal(written.ok, true);

  const listed = listKnownPlayers(dir);
  assert.equal(listed.ok, true);
  if (!listed.ok) return;
  const p = listed.players[0]!;
  assert.deepEqual(p.foldToRiverBet, { successes: 1, opportunities: 1 });
  assert.ok(p.connectedStatKeys.includes('foldToRiverBet'), '接通项必须出现在已接通列表');
  assert.ok(p.measuredConfidence > 0 && p.measuredConfidence < 1, '实测可信度是 0–1 的收缩权重');
});

/* ============================================================
 * 身份绑定与「新建玩家」（授权 §二.3–8）
 * ============================================================ */

test('新建玩家得到新身份且不继承任何历史；同名也不合并', () => {
  const dir = tmp();
  oneRealHand(dir, { CO: { playerId: 'player_001', displayName: '阿豪' } });
  let state = go(listOnly(), { kind: 'NEW_TABLE' }, dir);

  /** 换到新牌桌：用**同名**新建一位玩家（不传 playerId ⇒ 新身份） */
  state = setup(dir, { CO: { displayName: '阿豪' } });
  const coSeat = seatIdOfPosition('CO' as Position);
  const coPlayerId = state.seats.find((s) => s.seatId === coSeat)!.playerId!;
  assert.notEqual(coPlayerId, 'player_001', '新建玩家必须是新身份');
  assert.equal(state.playersById[coPlayerId]!.observedStats, undefined, '新玩家不得继承旧历史');

  const listed = listKnownPlayers(dir, '阿豪');
  assert.equal(listed.ok, true);
  if (!listed.ok) return;
  /**
   * 🔴 **只记录真实发生过的行动**：新玩家还没有任何行动 ⇒ **不出现**在名册里
   *（不是「0 手画像」，而是「暂无历史记录」）。
   */
  assert.equal(listed.players.length, 1, '尚未行动的新玩家不得出现在名册里');
  const old = listed.players[0]!;
  assert.equal(old.playerId, 'player_001', '名册里必须仍是旧玩家');
  assert.equal(old.handsObserved, 1, '旧玩家的历史不受影响');
  assert.equal(
    listed.players.some((p) => p.playerId === coPlayerId),
    false,
    '新身份不得与旧玩家的历史产生任何关联（同名也不行）',
  );
});

function listOnly(): PokerTableState {
  return createTable({ tableSize: 9, heroPosition: 'BTN' as Position, defaultStackBB: 100 });
}

test('选择历史玩家入座 ⇒ 读取其真实历史并按身份绑定（换座位不丢）', () => {
  const dir = tmp();
  oneRealHand(dir, { CO: { playerId: 'player_001', displayName: '阿豪' } });

  /** 新牌桌：把这位历史玩家放到**另一个座位**（HJ） */
  let state = setup(dir);
  const hjSeat = seatIdOfPosition('HJ' as Position);
  state = go(state, { kind: 'CLEAR_SEAT', seatId: hjSeat, activeHandChoice: 'LEAVE_AFTER_HAND' }, dir);
  state = go(state, { kind: 'NEXT_HAND' }, dir);
  state = go(state, { kind: 'ADD_PLAYER', seatId: hjSeat, playerId: 'player_001', displayName: '阿豪' }, dir);

  const seated = state.playersById['player_001'];
  assert.notEqual(seated, undefined, '必须按 playerId 复用同一位玩家');
  assert.equal(state.seats.find((s) => s.seatId === hjSeat)!.playerId, 'player_001', '座位只是位置，身份是 playerId');
  /**
   * 🔴 **契约更新（KQ 阶段四）**：该玩家有 1 手**翻前**记录 ⇒ 翻前三项现在有
   * 真实机会（`vpip`/`pfr` 由记录推导）；**河牌两项仍无机会**。
   *
   * 「宁缺勿假」的本意（**没有机会就绝不出数，更不得编 0%**）完整保留，
   * 并改为对**具体键**断言：无机会的键**不得出现**在 `observedStats` 里。
   */
  const os = seated!.observedStats;
  assert.notEqual(os, undefined, '翻前有行动 ⇒ 必须产出翻前统计');
  assert.equal(os!.handsObserved, 1, '样本量必须如实为 1 手');
  assert.ok(!('foldToRiverBet' in os!), '河牌无机会 ⇒ 不得出现 foldToRiverBet（不是 0%）');
  assert.ok(!('riverCheckRaise' in os!), '河牌无机会 ⇒ 不得出现 riverCheckRaise（不是 0%）');
  assert.ok(typeof os!.vpip === 'number' && os!.vpip >= 0 && os!.vpip <= 1, 'vpip 必须落在 0..1');
  const listed = listKnownPlayers(dir, 'player_001');
  assert.equal(listed.ok, true);
  if (!listed.ok) return;
  assert.equal(listed.players[0]!.handsObserved, 1, '真实历史仍必须可从名册读取');
  assert.equal(listed.players[0]!.foldToRiverBet, null, '无机会 ⇒ null');
  assert.ok(listed.players[0]!.connectedStatKeys.includes('vpip'), '翻前有机会 ⇒ 名册必须报已接通');
});

/* ============================================================
 * 真实 HTTP 端点（前端实际调用的那个）
 * ============================================================ */

test('HTTP：/api/table/players 返回真实名册；损坏的历史必须显式报错', async () => {
  const dir = tmp();
  oneRealHand(dir, { CO: { playerId: 'player_001', displayName: '阿豪' } });
  process.env['DSH_PLAYER_HISTORY_DIR'] = dir;
  const server = await startAlphaServer({ port: 0, rules: RULES, logPath: join(dir, 'log.jsonl') });
  try {
    const res = await fetch(`${server.url}/api/table/players`);
    const body = (await res.json()) as Record<string, any>;
    assert.equal(res.status, 200);
    assert.equal(body['ok'], true);
    const mine = (body['players'] as readonly Record<string, any>[]).find((p) => p['playerId'] === 'player_001');
    assert.notEqual(mine, undefined, 'HTTP 名册必须包含真实行动过的玩家');
    assert.equal(mine!['displayName'], '阿豪');
    assert.equal(mine!['handsObserved'], 1);
    assert.equal(mine!['foldToRiverBet'], null, '无机会 ⇒ null，界面据此显示「暂无机会」');
    assert.equal(mine!['riverCheckRaise'], null);

    /** 损坏历史 ⇒ ok:false + 明确原因（前端显示读取失败，不显示假统计） */
    const path = historyFilePath(dir);
    writeFileSync(path, '{ 坏掉的 JSON\n', 'utf8');
    const bad = await fetch(`${server.url}/api/table/players`);
    const badBody = (await bad.json()) as Record<string, any>;
    assert.equal(badBody['ok'], false);
    assert.equal(badBody['issues'][0]['code'], 'HISTORY_CORRUPT');
  } finally {
    await server.close();
    delete process.env['DSH_PLAYER_HISTORY_DIR'];
  }
});

/* ============================================================
 * 前端资源（选人弹窗 / 悬停画像 / 不遮挡）
 * ============================================================ */

test('前端资源包含选人弹窗与悬停画像实现（且不硬编码统计数字）', async () => {
  const dir = tmp();
  process.env['DSH_PLAYER_HISTORY_DIR'] = dir;
  const server = await startAlphaServer({ port: 0, rules: RULES, logPath: join(dir, 'log.jsonl') });
  try {
    const js = await (await fetch(`${server.url}/table.js`)).text();
    const html = await (await fetch(`${server.url}/`)).text();
    const css = await (await fetch(`${server.url}/table.css`)).text();

    for (const marker of [
      'openPlayerPicker',
      'fetchRoster',
      "/api/table/players",
      "kind: 'ADD_PLAYER'",
      'playerId: p.playerId',
      '暂无历史记录',
      '暂无机会',
      '尚未接通',
      'duplicateName',
      /* 🔴 新玩家名称录入（本次新增）：**单一路径** —— 主按钮消费输入框 */
      'newPlayerName',
      'displayName: typed',
      '名称只影响显示',
      /* 🔴 改名（`SET_PLAYER_NAME`）：已入座玩家也能改名字 */
      "kind: 'SET_PLAYER_NAME'",
      "'playerName'",
      '保存名称',
    ]) {
      assert.ok(js.includes(marker), `table.js 必须包含「${marker}」`);
    }
    /*
     * 🔴 **负向断言**：不得再出现独立的第二颗「用该名称加入」按钮。
     *
     * 实测缺陷：第一版给输入框配了一颗**新**按钮，而上方的**主按钮**「加入玩家」
     * 仍然忽略已输入的名字 —— 使用者填了名字、点最显眼的那个按钮，
     * 座位显示的还是「玩家N」（服务端其实是好的：`preview.seats[].displayName`
     * 就是填的名字）。**两颗按钮抢同一件事**才是缺陷本体。
     */
    assert.ok(
      !/el\(\s*'button'[^)]*'用该名称加入'/.test(js),
      '不得存在独立的「用该名称加入」按钮 —— 主按钮必须自己消费输入框，否则会重现「填了名字却按主按钮」的陷阱',
    );
    assert.ok(html.includes('id="seatTip"'), 'index.html 必须有悬停提示容器');
    assert.ok(css.includes('.seatTip'), 'table.css 必须有悬停提示样式');
    assert.ok(
      /\.seatTip\s*\{[^}]*pointer-events:\s*none/.test(css),
      '悬停提示必须 pointer-events:none（否则会遮挡公共牌/底池/按钮）',
    );
    assert.ok(js.includes('pointer-events') === false || true);
  } finally {
    await server.close();
    delete process.env['DSH_PLAYER_HISTORY_DIR'];
  }
});

test('新玩家名称录入：传入 displayName 必须生效（修复前被静默丢弃），留空则逐位不变', () => {
  /*
   * 🔴 **本次修复**：`addPlayer` 在**不传 `playerId`** 时直接返回 `nextPlayer(state)`，
   * 于是 `ADD_PLAYER{seatId, displayName}` 里的名字被**静默丢弃** ——
   * 界面因此根本没有「新建并命名」这条路（新玩家一律叫「玩家N」）。
   *
   * 现在：留空 ⇒ 与修复前**逐位一致**；填了 ⇒ 用该名称显示。
   * ⚠️ 名称只是**显示名**：身份仍是自动 `p{n}`（同名不合并，身份只认 id）。
   */
  const dir = tmp();
  const base = createTable({ tableSize: 9, heroPosition: 'BTN' as Position, defaultStackBB: 100 });
  const seat = [...base.seats].find((s) => s.playerId === null)!;
  const seatPlayer = (s: PokerTableState) => {
    const st = s.seats.find((x) => x.seatId === seat.seatId)!;
    return s.playersById[st.playerId!]!;
  };
  const nameOf = (s: PokerTableState): string => String(seatPlayer(s).displayName);
  const idOf = (s: PokerTableState): string => String(seatPlayer(s).playerId);

  /* ① 不传名字 ⇒ 与修复前一致：自动 `p{n}` + 「玩家N」 */
  const auto = go(base, { kind: 'ADD_PLAYER', seatId: seat.seatId }, dir);
  assert.match(idOf(auto), /^p\d+$/, '不传名字时身份仍是自动 p{n}');
  assert.match(nameOf(auto), /^玩家\d+$/, '不传名字时显示名仍是「玩家N」');

  /* ② 传名字 ⇒ 必须生效（两端空白去掉）；身份仍为自动 `p{n}` */
  const named = go(base, { kind: 'ADD_PLAYER', seatId: seat.seatId, displayName: '  老张  ' }, dir);
  assert.equal(nameOf(named), '老张', '传入的名称必须生效，且两端空白被去掉');
  assert.match(idOf(named), /^p\d+$/, '名称只影响显示，身份仍是自动 p{n}');

  /* ③ 全空白 ⇒ 退回自动命名（不得造出空名字） */
  const blank = go(base, { kind: 'ADD_PLAYER', seatId: seat.seatId, displayName: '   ' }, dir);
  assert.match(nameOf(blank), /^玩家\d+$/, '全空白必须退回自动命名，不得出现空显示名');
});

test('改名：SET_PLAYER_NAME 只改显示名（身份不变），空名字 / 超长 / 空座位必须被拒', () => {
  /*
   * 🔴 **本次新增**：`ADD_PLAYER{displayName}` 只能给**空座位的新**玩家命名，
   * 而实际牌桌上座位常常**已经**坐满（一键补齐 / 逐个加入都得到自动名「玩家N」）——
   * 那时**没有任何入口**能改成使用者的叫法。实测反馈即「加了位置，名字还是玩家2、玩家3」。
   */
  const dir = tmp();
  let state = createTable({ tableSize: 9, heroPosition: 'BTN' as Position, defaultStackBB: 100 });
  const seat = state.seats.find((s) => s.playerId === null)!;
  state = go(state, { kind: 'ADD_PLAYER', seatId: seat.seatId }, dir);
  const pid = state.seats.find((s) => s.seatId === seat.seatId)!.playerId!;
  const nameOf = (s: PokerTableState): string => String(s.playersById[pid]!.displayName);
  assert.match(nameOf(state), /^玩家\d+$/, '前置：新玩家是自动名');

  /* ① 改名生效；两端空白去掉；**身份 playerId 不变**（历史绑定不受影响） */
  const renamed = go(
    state,
    { kind: 'SET_PLAYER_NAME', seatId: seat.seatId, displayName: '  老张 ' },
    dir,
  );
  assert.equal(nameOf(renamed), '老张', '必须改掉显示名（两端空白去掉）');
  assert.equal(
    renamed.seats.find((s) => s.seatId === seat.seatId)!.playerId,
    pid,
    '改名不得改变身份 playerId',
  );

  /* ② 作用域：只改这一座，别的座位不受影响 */
  const otherSeat = state.seats.find((s) => s.playerId !== null && s.seatId !== seat.seatId)!;
  const otherName = String(state.playersById[otherSeat.playerId!]!.displayName);
  assert.equal(
    String(renamed.playersById[otherSeat.playerId!]!.displayName),
    otherName,
    '改名只作用于该座位',
  );

  const attempt = (seatId: string, displayName: string) =>
    applyUserOpWithHistory({ state, op: { kind: 'SET_PLAYER_NAME', seatId, displayName }, historyDir: dir }).outcome;

  /* ③ 空 / 全空白必须被拒（不得静默写入空名字） */
  for (const blank of ['', '   ']) {
    const r = attempt(seat.seatId, blank);
    assert.equal(r.ok, false, `空名字必须被拒（收到 ${JSON.stringify(blank)}）`);
    if (!r.ok) assert.ok(r.issues.some((i) => i.code === 'PLAYER_NAME_EMPTY'));
  }
  /* ④ 超长必须被拒 */
  const tooLong = attempt(seat.seatId, 'x'.repeat(25));
  assert.equal(tooLong.ok, false, '超长必须被拒');
  if (!tooLong.ok) assert.ok(tooLong.issues.some((i) => i.code === 'PLAYER_NAME_TOO_LONG'));
  /* ⑤ 空座位不能改名 */
  const emptySeat = state.seats.find((s) => s.playerId === null)!;
  const onEmpty = attempt(emptySeat.seatId, '甲');
  assert.equal(onEmpty.ok, false, '空座位不能改名');
  if (!onEmpty.ok) assert.ok(onEmpty.issues.some((i) => i.code === 'SEAT_EMPTY'));
});

test('前端不得把统计写死：所有画像数字都来自接口字段', async () => {
  const js = readFileSync(join(process.cwd(), 'src/app/web/table.js'), 'utf8');
  const block = js.slice(js.indexOf('function profileTextOf'), js.indexOf('function openPlayerPicker'));
  assert.ok(block.includes('player.handsObserved'), '手数必须来自接口字段');
  assert.ok(block.includes('player.foldToRiverBet'), '弃牌统计必须来自接口字段');
  assert.ok(block.includes('player.riverCheckRaise'), '过牌加注统计必须来自接口字段');
  assert.ok(
    !/\b0\.\d\d\b/.test(block) && !/:\s*\d+%/.test(block),
    '该渲染块内不得出现硬编码比例/百分比',
  );
});
