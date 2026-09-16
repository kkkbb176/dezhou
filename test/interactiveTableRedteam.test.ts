/**
 * 交互式牌桌 —— 独立红队发现的永久回归测试
 *
 * ## 命名约定
 *
 * 每个 `test()` 标题以 `RT-Lx` 开头，与
 * `reports/TABLE_INTERACTIVE_REDTEAM_LIFECYCLE.md` /
 * `reports/TABLE_INTERACTIVE_REDTEAM_ADAPTER.md` 的编号**一一对应**，
 * 于是「报告里的每一条是否都被锁住」可以机械核对。
 *
 * ## 为什么每条都要落成测试
 *
 * 本项目的纪律：**每一个被发现的缺陷都必须变成一条永久断言。**
 * RT-L1 的根因（`villains[0]` 的语义依赖数组顺序）在注释里完全看不出来 ——
 * 只有一条会失败的测试能让它不再回来。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { Position } from '../src/domain/types.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { parseManualInput } from '../src/app/manualInput/manualInput.ts';
import {
  createTable,
  participantSeatsOf,
  seatOfPosition,
  staffingNotices,
  staffingProblems,
} from '../src/app/table/tableState.ts';
import { applyTableOp, engineViewOf } from '../src/app/table/tableOps.ts';
import { buildTablePreview, stateFingerprintOf } from '../src/app/table/tablePreview.ts';
import {
  primaryOpponentPosition,
  tableStateToManualHandInput,
} from '../src/app/table/tableAdapter.ts';
import {
  RevisionGuard,
  handleTableRequest,
  parseTableState,
} from '../src/app/table/tableApi.ts';
import { SeatStatus, type PokerTableState, type TableOp } from '../src/app/table/table.types.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const OPTIONS = { rules: RULES, asOf: 1_757_000_000_000, writeLog: false } as const;

const ORDER_6: readonly Position[] = [
  Position.UTG,
  Position.HJ,
  Position.CO,
  Position.BTN,
  Position.SB,
  Position.BB,
];

function must(result: ReturnType<typeof applyTableOp>): PokerTableState {
  if (!result.ok) throw new Error(`操作被拒绝：${result.issues.map((i) => i.message).join(' / ')}`);
  return result.state;
}

function fullTable(hero: Position, stackBB = 100): PokerTableState {
  let state = createTable({ tableSize: 6, heroPosition: hero, defaultStackBB: stackBB });
  for (const position of ORDER_6) {
    if (position === hero) continue;
    state = must(
      applyTableOp(state, { kind: 'ADD_PLAYER', seatId: seatOfPosition(state, position)!.seatId }),
    );
  }
  return state;
}

function click(state: PokerTableState, type: string, sizeIndex = 0): PokerTableState {
  const p = buildTablePreview(state);
  const sizes = p.actionButtons.filter((b) => b.type === type && b.group === 'SIZE');
  const pool = sizes.length > 0 ? sizes : p.actionButtons.filter((b) => b.type === type);
  const button = pool[sizeIndex] ?? pool[0];
  assert.ok(button !== undefined, `没有可点的「${type}」按钮`);
  return must(
    applyTableOp(state, {
      kind: 'ACT',
      action: {
        type: button.type,
        ...(button.amountChips !== undefined ? { amountChips: button.amountChips } : {}),
      },
    }),
  );
}

/* ============================================================
 * RT-L1（CRITICAL）：画像/动态必须绑到**真正的首要对手**
 * ============================================================ */

/**
 * 构造：Hero 大盲；UTG 弃牌、HJ 开池、CO/BTN/SB 弃牌 → Hero 面对加注。
 *
 * 此时**首要对手是 HJ**（座位序里第一个未弃牌的非 Hero 玩家），
 * 而座位序里第一个对手是**已经弃牌的 UTG**。
 */
function heroFacingHjOpen(profileOn: Position | null, profile: 'MANIAC' | 'CALLING_STATION'): PokerTableState {
  let state = fullTable(Position.BB);
  if (profileOn !== null) {
    state = must(
      applyTableOp(state, {
        kind: 'SET_PROFILE',
        seatId: seatOfPosition(state, profileOn)!.seatId,
        quickProfile: profile,
      }),
    );
  }
  state = must(applyTableOp(state, { kind: 'SET_HERO_CARD', card: 'As' }));
  state = must(applyTableOp(state, { kind: 'SET_HERO_CARD', card: 'Kd' }));
  state = click(state, 'FOLD'); // UTG 弃牌
  state = click(state, 'RAISE'); // HJ 开池
  state = click(state, 'FOLD'); // CO
  state = click(state, 'FOLD'); // BTN
  state = click(state, 'FOLD'); // SB
  return state;
}

test('RT-L1（CRITICAL）：传给管线的 villain 必须是**真正的首要对手**，不是座位序第一个对手', () => {
  const state = heroFacingHjOpen(null, 'MANIAC');

  assert.equal(
    primaryOpponentPosition(state),
    Position.HJ,
    'UTG 已弃牌 → 首要对手必须是 HJ（引擎按他建范围）',
  );

  const adapted = tableStateToManualHandInput(state);
  assert.equal(adapted.ok, true, `适配必须成功：${adapted.ok ? '' : JSON.stringify(adapted.issues)}`);
  if (!adapted.ok) return;

  assert.equal(
    adapted.input.villain!.playerId,
    `seat_${Position.HJ}`,
    'villain.playerId 必须是首要对手（引擎口径 id）',
  );

  // ⚠️ 这一条是 RT-L1 的**根因**：`parseManualInput` 取 `villains[0]`，
  //    只要给了 `villains`，`input.villain` 就被完全忽略。
  assert.equal(
    adapted.input.villains,
    undefined,
    '适配器**不得**传 `villains` 数组 —— 它的 [0] 会覆盖 input.villain',
  );

  // 经过解析之后仍然是同一个人（这是真正送进 contextBuilder 的值）
  const parsed = parseManualInput(adapted.input);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(
    parsed.value.villain.playerId,
    `seat_${Position.HJ}`,
    '解析后的 villain 必须仍是首要对手',
  );
});

test('RT-L1（CRITICAL）：把画像设在**真正推动范围的对手**上必须改变结论', () => {
  const pristine = heroFacingHjOpen(null, 'MANIAC');
  const onPrimary = heroFacingHjOpen(Position.HJ, 'MANIAC');

  const adapt = (s: PokerTableState) => {
    const a = tableStateToManualHandInput(s);
    assert.equal(a.ok, true);
    if (!a.ok) throw new Error('unreachable');
    return a.input;
  };

  const a = analyzeManualHand(adapt(pristine), OPTIONS);
  const b = analyzeManualHand(adapt(onPrimary), OPTIONS);
  assert.equal(a.ok && b.ok, true);
  if (!a.ok || !b.ok) return;

  assert.notEqual(
    b.log.inputHash,
    a.log.inputHash,
    '把首要对手标为 MANIAC → 输入必须改变（否则画像根本没进管线）',
  );
  assert.equal(
    b.decision.diagnostics.player?.playerId,
    `seat_${Position.HJ}`,
    '诊断里的玩家 id 必须指向首要对手 —— RT-L1 的表现就是这里变成了 seat_UTG',
  );
});

test('RT-L1（CRITICAL）：把画像设在**已弃牌的对手**上不得改变结论（提示不得被静默丢弃）', () => {
  const pristine = heroFacingHjOpen(null, 'MANIAC');
  const onFolded = heroFacingHjOpen(Position.UTG, 'MANIAC');

  const adapt = (s: PokerTableState) => {
    const a = tableStateToManualHandInput(s);
    assert.equal(a.ok, true);
    if (!a.ok) throw new Error('unreachable');
    return a.input;
  };

  const a = analyzeManualHand(adapt(pristine), OPTIONS);
  const b = analyzeManualHand(adapt(onFolded), OPTIONS);
  assert.equal(a.ok && b.ok, true);
  if (!a.ok || !b.ok) return;

  /**
   * ⚠️ 这里刻意断言**相等**。
   *
   * 给一个**已经弃牌**的玩家标画像，不应当影响本手的决策 ——
   * 他的范围已经不参与计算了。修复前这条会失败：UTG 的画像被当成
   * 「对手画像」送进决策，于是「给弃牌的人设标签」反而改变了建议。
   */
  assert.equal(
    stateFingerprintOf(
      (() => {
        const v = engineViewOf(pristine);
        if (!v.ok) throw new Error('unreachable');
        return v.engine;
      })(),
    ) !== '',
    true,
  );
  assert.equal(
    b.decision.confidence,
    a.decision.confidence,
    '给已弃牌者设画像不得改变置信度',
  );
  assert.equal(b.decision.action, a.decision.action, '给已弃牌者设画像不得改变动作');
  assert.deepEqual(
    b.decision.diagnostics.player?.playerId,
    `seat_${Position.HJ}`,
    '诊断里的玩家始终是首要对手，与谁被标了画像无关',
  );
});

/* ============================================================
 * RT-L2（MAJOR）：离桌决策必须能被客户端看到
 * ============================================================ */

test('RT-L2（MAJOR）：本手进行中清空座位 —— 响应的 revision 与请求**相同**', () => {
  let state = fullTable(Position.CO);
  state = must(applyTableOp(state, { kind: 'SET_HERO_CARD', card: 'As' }));
  state = must(applyTableOp(state, { kind: 'SET_HERO_CARD', card: 'Kd' }));
  state = click(state, 'RAISE');

  const seatId = seatOfPosition(state, Position.UTG)!.seatId;
  const payload = handleTableRequest(
    { state, op: { kind: 'CLEAR_SEAT', seatId } },
    { newTableId: () => 't-test', guard: new RevisionGuard() },
  );

  assert.equal(payload.ok, false, '本手进行中直接清空座位必须被拒绝');
  assert.equal(payload.leaveDecision !== undefined, true, '必须回传离桌选择');

  /*
   * 🔴 RT-L2 的两个成因之一：这是**失败**响应，服务端回传的状态与请求
   *    同版本。客户端的版本保护若写在 `leaveDecision` 处理之前，
   *    整个响应（含离桌选择）会被当成「迟到的旧响应」丢掉。
   *
   * 因此这里把「同版本」固化成断言：客户端**必须**按正确顺序处理它。
   */
  assert.equal(
    payload.state!.revision,
    state.revision,
    '失败响应回传的是**未被改动**的状态，revision 与请求相同 —— ' +
      '客户端必须先把 leaveDecision 取出来，再做版本判断',
  );

  // 成因之二：座位菜单不得在拿到 leaveDecision 之后立刻关掉弹层。
  // 这里用源码级断言守住（前端逻辑没有 DOM 无法在 Node 里执行）。
  const js = readTableJs();
  assert.ok(
    js.includes('closeUnlessPending'),
    '客户端必须存在「有待处理离桌决策时不关闭弹层」的辅助函数',
  );
  assert.ok(
    !/\.then\(closeModal\)/.test(js),
    '座位菜单不得直接 .then(closeModal) —— 那会把刚打开的离桌选择立刻关掉',
  );
  const leaveIndex = js.indexOf('payload.leaveDecision');
  const guardIndex = js.indexOf('payload.state.revision > app.revision');
  assert.ok(leaveIndex >= 0 && guardIndex >= 0);
  assert.ok(
    leaveIndex < guardIndex,
    'leaveDecision 的处理必须写在版本保护**之前**（否则同版本的失败响应会被整包丢弃）',
  );
});

function readTableJs(): string {
  const root = fileURLToPath(new URL('..', import.meta.url));
  return readFileSync(join(root, 'src', 'app', 'web', 'table.js'), 'utf8');
}

/* ============================================================
 * RT-L3（MAJOR）：Hero 移动座位 / 换桌型不得吞掉别人的筹码
 * ============================================================ */

test('RT-L3（MAJOR）：Hero 移动座位时，筹码必须**跟着 Hero 走**', () => {
  let state = fullTable(Position.CO, 100);
  // 把 Hero 改到 250BB，目标座位（BB）改到 33BB
  state = must(
    applyTableOp(state, {
      kind: 'SET_STACK',
      seatId: seatOfPosition(state, Position.CO)!.seatId,
      stackBB: 250,
    }),
  );
  state = must(
    applyTableOp(state, {
      kind: 'SET_STACK',
      seatId: seatOfPosition(state, Position.BB)!.seatId,
      stackBB: 33,
    }),
  );

  const moved = must(applyTableOp(state, { kind: 'SET_HERO_POSITION', position: Position.BB }));
  const heroSeat = seatOfPosition(moved, Position.BB)!;

  assert.equal(heroSeat.playerId, moved.heroPlayerId, 'Hero 必须在 BB 座位');
  assert.equal(heroSeat.stackBB, 250, 'Hero 的筹码必须跟着他走（不能继承 33BB）');
  assert.equal(
    seatOfPosition(moved, Position.CO)!.playerId,
    null,
    'Hero 原来的座位必须腾空',
  );
  assert.ok(
    moved.notices.some((n) => n.includes('交给 Hero') || n.includes('不再绑定')),
    `必须提示目标座位上原本的人被解绑，实际提示：${moved.notices.join(' | ')}`,
  );
  // 被顶掉的那位玩家对象仍在历史里
  assert.equal(
    Object.keys(moved.playersById).length,
    Object.keys(state.playersById).length,
    '玩家对象不得被删除（只是不再绑定座位）',
  );

  // 关键：结果状态必须自洽（否则之后每个请求都会失败）
  const parsed = parseTableState({ ...moved });
  assert.equal(parsed.ok, true, `结果状态必须自洽：${parsed.ok ? '' : JSON.stringify(parsed.issues)}`);
});

test('RT-L3（MAJOR）：9→6 换桌型时 Hero 的筹码也必须跟着走，且结果自洽', () => {
  let state = createTable({ tableSize: 9, heroPosition: Position.UTG1, defaultStackBB: 100 });
  for (const seat of state.seats) {
    if (seat.playerId !== null) continue;
    state = must(applyTableOp(state, { kind: 'ADD_PLAYER', seatId: seat.seatId }));
  }
  state = must(
    applyTableOp(state, {
      kind: 'SET_STACK',
      seatId: seatOfPosition(state, Position.UTG1)!.seatId,
      stackBB: 210,
    }),
  );
  state = must(
    applyTableOp(state, {
      kind: 'SET_STACK',
      seatId: seatOfPosition(state, Position.BTN)!.seatId,
      stackBB: 77,
    }),
  );

  const switched = must(applyTableOp(state, { kind: 'SET_TABLE_SIZE', tableSize: 6 }));
  assert.equal(switched.tableSize, 6);
  assert.equal(switched.heroPosition, Position.BTN, 'UTG1 在 6 人桌不存在 → 自动改到庄家位');
  assert.equal(
    seatOfPosition(switched, Position.BTN)!.stackBB,
    210,
    'Hero 的 210BB 必须跟着他走（修复前会变成 BTN 那个人的 77BB）',
  );
  assert.ok(
    switched.notices.some((n) => n.includes('UTG1') || n.includes('不存在')),
    `必须提示被移除的位置，实际：${switched.notices.join(' | ')}`,
  );

  const parsed = parseTableState({ ...switched });
  assert.equal(parsed.ok, true, `结果状态必须自洽：${parsed.ok ? '' : JSON.stringify(parsed.issues)}`);
});

/* ============================================================
 * RT-L4（MAJOR）：本手进行中暂离不得毁掉当前手
 * ============================================================ */

test('RT-L4（MAJOR）：本手进行中「暂时离座」只影响下一手，当前手必须能继续录', () => {
  let state = fullTable(Position.CO);
  state = must(applyTableOp(state, { kind: 'SET_HERO_CARD', card: 'As' }));
  state = must(applyTableOp(state, { kind: 'SET_HERO_CARD', card: 'Kd' }));
  state = click(state, 'RAISE'); // UTG 加注（本手已经开始）

  const before = engineViewOf(state);
  assert.equal(before.ok, true);
  if (!before.ok) return;
  const fingerprintBefore = stateFingerprintOf(before.engine);

  const sbSeatId = seatOfPosition(state, Position.SB)!.seatId;
  const satOut = must(applyTableOp(state, { kind: 'SIT_OUT', seatId: sbSeatId }));

  // 1) 引擎仍然能重建（否则界面上行动按钮会全部消失）
  const after = engineViewOf(satOut);
  assert.equal(after.ok, true, '暂离之后牌局必须仍然可以重建');
  if (!after.ok) return;
  assert.equal(
    stateFingerprintOf(after.engine),
    fingerprintBefore,
    '暂离不得改变本手的引擎状态（底池 / 投入 / 行动顺序）',
  );

  // 2) 当前行动者与合法动作仍然在
  const preview = buildTablePreview(satOut);
  assert.notEqual(preview.currentActorPosition, null, '当前行动者不得变成 null');
  assert.ok(preview.actionButtons.length > 0, '行动按钮不得消失');

  // 3) 座位仍是「在座」，但带着「下一手暂离」标记
  const sb = seatOfPosition(satOut, Position.SB)!;
  assert.equal(sb.status, SeatStatus.SEATED_ACTIVE, '本手期间必须保持「在座」');
  assert.equal(sb.sitOutNextHand, true, '必须记在「下一手」标记上');

  // 4) 仍然可以继续录这一手
  const continued = click(satOut, 'FOLD'); // HJ 弃牌
  assert.ok(continued.actionHistory.length > satOut.actionHistory.length);

  // 5) 下一手才真正暂离
  const next = must(applyTableOp(continued, { kind: 'NEXT_HAND' }));
  assert.equal(
    seatOfPosition(next, Position.SB)!.status,
    SeatStatus.SITTING_OUT,
    '下一手开始时暂离才真正生效',
  );
  /*
   * 🔴 **Table Topology Correction**：暂离生效后不再「无法分析」，而是
   * **被排除在本手之外**（引擎现在支持 2 ≤ 本手人数 ≤ 容量）。
   * 旧断言要求它阻断分析，那正是本轮要消灭的形态。
   * 新断言钉住实质：暂离座位不在参与者里，且这件事被如实告知。
   */
  assert.ok(
    !participantSeatsOf(next).some((s) => s.logicalPosition === Position.SB),
    '暂离生效后该座位必须被排除在本手参与者之外',
  );
  assert.equal(
    staffingProblems(next).length,
    0,
    '暂离只是本手少一个人，不得阻断分析',
  );
  assert.ok(
    staffingNotices(next).some((n) => n.includes('暂离中的座位')),
    `暂离必须被如实告知：${staffingNotices(next).join(' / ')}`,
  );
});

/* ============================================================
 * RT：服务器不得产出「自己校验不过」的状态
 * ============================================================ */

test('RT：任何操作产出的状态都必须能通过服务器自己的校验器', () => {
  /**
   * 红队命中过：某次操作之后服务器返回了一个**它自己随后会拒绝**的状态，
   * 于是那一张牌桌此后每一个请求都失败，而使用者只看到「点了没反应」。
   *
   * `handleTableRequest` 现在对结果做自校验。本测试从外部把常见操作序列
   * 全部跑一遍，逐次断言结果自洽。
   */
  const guard = new RevisionGuard();
  let idSeq = 0;
  const deps = {
    newTableId: () => {
      idSeq += 1;
      return `t${idSeq}`;
    },
    guard,
  };

  const created = handleTableRequest({ tableSize: 6, heroPosition: 'CO' }, deps);
  assert.equal(created.ok, true);
  if (!created.ok) return;
  let state = created.state;

  const ops: TableOp[] = [];
  for (const position of ORDER_6) {
    if (position === Position.CO) continue;
    ops.push({ kind: 'ADD_PLAYER', seatId: `seat_${position}` });
  }
  ops.push(
    { kind: 'SET_PROFILE', seatId: 'seat_UTG', quickProfile: 'MANIAC' },
    { kind: 'SET_DYNAMIC_HINT', seatId: 'seat_UTG', dynamicHint: 'TILT_SIGNAL' },
    { kind: 'SET_STACK', seatId: 'seat_HJ', stackBB: 47 },
    { kind: 'SET_HERO_POSITION', position: Position.BB },
    { kind: 'SET_HERO_CARD', card: 'As' },
    { kind: 'SET_HERO_CARD', card: 'Kd' },
    { kind: 'ACT', action: { type: 'FOLD' } },
    { kind: 'ACT', action: { type: 'FOLD' } },
    { kind: 'ACT', action: { type: 'CALL', amountChips: 100 } },
    { kind: 'ACT', action: { type: 'CHECK' } },
    { kind: 'SET_BOARD_CARD', card: 'Kh', slot: 0 },
    { kind: 'SET_BOARD_CARD', card: '7c', slot: 1 },
    { kind: 'SET_BOARD_CARD', card: '2d', slot: 2 },
    { kind: 'RESET_HAND' },
    { kind: 'SET_TABLE_SIZE', tableSize: 9 },
    { kind: 'SET_TABLE_SIZE', tableSize: 6 },
    { kind: 'CLEAR_ALL_VILLAINS' },
    { kind: 'NEW_TABLE' },
    { kind: 'UNDO' },
    { kind: 'UNDO' },
    { kind: 'UNDO' },
  );

  for (const op of ops) {
    const payload = handleTableRequest({ state, op }, deps);
    if (payload.state) {
      const selfCheck = parseTableState({ ...payload.state });
      assert.equal(
        selfCheck.ok,
        true,
        `操作「${op.kind}」之后的状态必须自洽：` +
          `${selfCheck.ok ? '' : JSON.stringify(selfCheck.issues)}`,
      );
      state = payload.state;
    }
    if (!payload.ok && payload.issues.some((i) => i.code === 'INTERNAL_ERROR')) {
      assert.fail(`操作「${op.kind}」触发了内部错误：${payload.issues.map((i) => i.message).join('；')}`);
    }
  }
});

/* ============================================================
 * RT：伪造状态必须被拒（客户端状态不可信）
 * ============================================================ */

test('RT：伪造 / 自相矛盾的状态必须被服务器拒绝', () => {
  const base = fullTable(Position.CO);
  const withCards = must(
    applyTableOp(
      must(applyTableOp(base, { kind: 'SET_HERO_CARD', card: 'As' })),
      { kind: 'SET_HERO_CARD', card: 'Kd' },
    ),
  );

  const cases: readonly (readonly [string, unknown])[] = [
    ['handActive=false 但已有手牌与行动', { ...withCards, handActive: false }],
    ['handActive=true 但一切皆空', { ...createTable({ tableSize: 6 }), handActive: true }],
    [
      '两个座位绑同一个 playerId',
      {
        ...base,
        seats: base.seats.map((s, i) => (i === 1 ? { ...s, playerId: base.seats[0]!.playerId } : s)),
      },
    ],
    [
      'Hero 座位的视觉序号不是 0',
      {
        ...base,
        seats: base.seats.map((s) =>
          s.logicalPosition === Position.CO ? { ...s, visualIndex: 3 } : s,
        ),
      },
    ],
    ['手牌里有非法牌面', { ...withCards, heroCards: ['Zz', 'Kd'] }],
    ['手牌里有重复的牌', { ...base, heroCards: ['As', 'As'] }],
    ['公共牌与手牌重复', { ...withCards, board: ['As', '7c', '2d'] }],
    ['公共牌里有重复的牌', { ...withCards, board: ['7c', '7c', '2d'] }],
    ['notices 里有非字符串', { ...base, notices: [123] }],
    ['lastHandComplete 不是布尔', { ...base, lastHandComplete: 'yes' }],
    ['lastHandRemainingStacksBB 非法', { ...base, lastHandRemainingStacksBB: { UTG: 'many' } }],
  ];

  for (const [name, payload] of cases) {
    const parsed = parseTableState(payload);
    assert.equal(parsed.ok, false, `「${name}」必须被拒绝`);
    if (parsed.ok) continue;
    assert.ok(parsed.issues.length > 0, `「${name}」必须给出可读原因`);
  }
});

test('RT：空操作（值未变）不得推进 revision、不得占用撤销栈', () => {
  const state = fullTable(Position.CO);
  const sameEnvironment = applyTableOp(state, {
    kind: 'SET_ENVIRONMENT',
    environment: state.environment,
  });
  assert.equal(sameEnvironment.ok, true);
  if (!sameEnvironment.ok) return;
  assert.equal(sameEnvironment.state.revision, state.revision, '环境未变 → revision 不得变化');
  assert.equal(sameEnvironment.state.undo.length, state.undo.length, '不得占用撤销栈');

  const seat = seatOfPosition(state, Position.UTG)!;
  const sameProfile = applyTableOp(state, {
    kind: 'SET_PROFILE',
    seatId: seat.seatId,
    quickProfile: 'UNKNOWN',
  });
  assert.equal(sameProfile.ok, true);
  if (!sameProfile.ok) return;
  assert.equal(sameProfile.state.revision, state.revision, '画像未变 → revision 不得变化');
});

test('RT：筹码跟随 Hero 之后，结果状态仍然自洽（端到端再验一次）', () => {
  let state = fullTable(Position.CO, 100);
  const seat = seatOfPosition(state, Position.UTG)!;
  state = must(applyTableOp(state, { kind: 'SET_STACK', seatId: seat.seatId, stackBB: 42 }));
  const moved = must(applyTableOp(state, { kind: 'SET_HERO_POSITION', position: Position.UTG }));
  assert.equal(seatOfPosition(moved, Position.UTG)!.stackBB, 100, 'Hero 的 100BB 跟到 UTG');

  /*
   * Hero 换位后原座位空了。
   *
   * 🔴 **Table Topology Correction**：空座位**不再**阻断分析 —— 5 人参与
   * 照常成局。旧断言「必须如实报告无法分析」已被本轮语义取代，
   * 新断言钉住实质：原座位确实被排除在本手之外，且被如实告知。
   */
  assert.ok(
    !participantSeatsOf(moved).some((s) => s.logicalPosition === Position.CO),
    'Hero 换位后原座位必须被排除在本手参与者之外',
  );
  assert.equal(
    staffingProblems(moved).length,
    0,
    'Hero 换位留下的空座不得阻断分析（容量 ≠ 本手人数）',
  );
  assert.ok(
    staffingNotices(moved).some((n) => n.includes('关煞位')),
    `空座必须被如实告知：${staffingNotices(moved).join(' / ')}`,
  );
  const refilled = must(
    applyTableOp(moved, { kind: 'ADD_PLAYER', seatId: seatOfPosition(moved, Position.CO)!.seatId }),
  );

  const adapted = tableStateToManualHandInput({
    ...refilled,
    heroCards: ['As', 'Kd'] as const,
  });
  assert.equal(adapted.ok, true, `适配必须成功：${adapted.ok ? '' : JSON.stringify(adapted.issues)}`);
  if (!adapted.ok) return;
  assert.equal(adapted.input.heroPosition, Position.UTG);
  assert.equal(adapted.input.effectiveStackBB, 100, '有效筹码必须取 Hero 自己的筹码');
  assert.equal(adapted.input.seatStacksBB![Position.UTG], 100);
  // 被新加入的玩家拿到默认筹码，而不是被顶掉那位的 42BB
  assert.equal(adapted.input.seatStacksBB![Position.CO], 100);
});
