/**
 * ============================================================================
 * 翻前加注资金流 —— 与**引擎分层台账**逐位一致的回归锁
 * ============================================================================
 *
 * ## 为什么需要这个文件
 *
 * `preflopRaiseFacts.ts` 曾经用
 * `heroContestedAdd = min(heroAdd, villainAdd); finalPot = pot0 + 该值 + villainAdd;`
 * —— 把「对手跟注要补的**差价**」当成「对手**投入的量**」。而旧测试
 * B-08/B-08b 断言的**正是这条错误公式**，于是「测试全绿」与「公式错误」
 * 同时成立：**同源错误一起通过**。
 *
 * 本文件反过来：期望值一律由**引擎**算出，事实包只提供 `sizeChips`
 * （要测哪个尺寸），其余全部独立重算并与引擎对账。
 *
 * ## 真值是哪个量？（三轮才定下来，务必分清）
 *
 * ```text
 * computePot(st)          = 所有真实投入之和（**未退回**口径）
 * computeLayeredPot().main = 双方匹配后的可争夺底池（= 事实包的 finalPot）
 * computeLayeredPot().contested = main
 * computeLayeredPot().returned[hero] = Hero 未被跟注、会退回的部分
 *
 * 关系：computePot = main + returned          ← 60BB/10000 实测 16150 = 12150 + 4000
 * ```
 *
 * ⚠️ **`finalPot` 不等于 `computePot`** —— 只在退回为 0 时相等。
 * 拿 `computePot` 当判据会误判（本项目第三轮「修复」正是这样被误导，
 * 把 `2 × min(双方本街总额)` 当成正确式，结果每个尺寸都漏掉死钱 150）。
 *
 * ## 覆盖
 *
 * 6 组筹码配置 × 9 个尺寸 = 54 个对照点，含「对手被封顶」「Hero 被封顶」
 * 「恰好用光」「双方全下」四种分支。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createGame, computePot } from '../src/domain/poker/gameState.ts';
import { applyAction } from '../src/domain/poker/engine.ts';
import { computeLayeredPot } from '../src/domain/poker/pots.ts';
import { deriveLegalActions } from '../src/app/manualInput/legalActions.ts';
import { buildPreflopRaiseFacts } from '../src/app/manualInput/preflopRaiseFacts.ts';
import { neutralResponseTendencies } from '../src/domain/postflop/betResponse.ts';
import { parseManualInput } from '../src/app/manualInput/manualInput.ts';
import { ReconstructMode, reconstructGameState } from '../src/app/manualInput/reconstruct.ts';

const BB = 100;
const POSITIONS = ['UTG', 'UTG1', 'UTG2', 'LJ', 'HJ', 'CO', 'BTN', 'SB', 'BB'] as const;

/** `[对手 BB, Hero BB]`：覆盖「对手短码」「Hero 短码」「双方满码」 */
const CONFIGS: readonly (readonly [number, number])[] = [
  [100, 100],
  [60, 100],
  [40, 100],
  [20, 100],
  [100, 20],
  [100, 60],
];

/**
 * Hero CO 开池 2.5 → BTN 3Bet 9 → 盲注弃牌 → 轮到 Hero；双方筹码可调。
 *
 * ⚠️ **盲注座位的筹码口径**：`createGame` 会立刻 `postBlind`（从 `startingStack`
 * 扣掉并记入 `committedByStreet.PREFLOP`）。夹具断言的终局底池
 * `pot0 = 1300` 已经含盲注那 150，所以盲注座位的 `startingStack` 必须**含**盲注，
 * 否则这 150 就是凭空多出来的（本项目第一版夹具正是如此，它让 `finalPot`
 * 与引擎台账相差 100，误导了一次「修复」）。
 */
function facingThreeBet(villainStackBB: number, heroStackBB: number): any {
  const stacks: Record<string, number> = {
    UTG: 100, UTG1: 100, UTG2: 100, LJ: 100, HJ: 100,
    CO: heroStackBB, BTN: villainStackBB,
    /* 含盲注：SB 投 0.5BB、BB 投 1BB */
    SB: 100.5, BB: 101,
  };
  let st: any = createGame({
    id: `cashflow-${villainStackBB}-${heroStackBB}`,
    config: { tableSize: 9, smallBlind: BB / 2, bigBlind: BB, ante: 0, dealerPosition: 'BTN' as never },
    players: POSITIONS.map((pos) => ({
      id: `seat_${pos}`,
      name: pos,
      position: pos as never,
      startingStack: stacks[pos]! * BB,
      holeCards: null,
    })),
    userPlayerId: 'seat_CO',
    board: {},
    createdAt: '2026-01-01T00:00:00.000Z',
  });
  const act = (pid: string, type: string, amount?: number): void => {
    const r = applyAction(st, { playerId: pid, type: type as never, ...(amount === undefined ? {} : { amount }) });
    assert.equal(r.ok, true, `${pid} ${type} 必须成功`);
    st = (r as { ok: true; state: unknown }).state;
  };
  for (const p of ['seat_UTG', 'seat_UTG1', 'seat_UTG2', 'seat_LJ', 'seat_HJ']) act(p, 'FOLD');
  act('seat_CO', 'RAISE', 250);
  act('seat_BTN', 'RAISE', 900);
  act('seat_SB', 'FOLD');
  act('seat_BB', 'FOLD');
  return st;
}

/**
 * 用**生产事实包构建器**取逐尺寸事实。
 *
 * 到达范围刻意用极小的确定性输入（两个代表组合）—— 本测试只验资金流，
 * 范围形状与权益数值都不影响 `heroAdd` / `villainAdd` / `heroContestedAdd` / `finalPot`。
 */
function sizesOf(villainStackBB: number, heroStackBB: number): any[] {
  const raw = parseManualInput({
    tableSize: 9,
    heroPosition: 'CO',
    heroCards: ['Qs', 'Qd'],
    board: [],
    street: 'PREFLOP',
    effectiveStackBB: heroStackBB,
    seatStacksBB: Object.fromEntries(
      POSITIONS.map((p) => [p, p === 'CO' ? heroStackBB : p === 'BTN' ? villainStackBB : 100]),
    ),
    actionHistory: [
      { position: 'UTG', type: 'FOLD' }, { position: 'UTG1', type: 'FOLD' },
      { position: 'UTG2', type: 'FOLD' }, { position: 'LJ', type: 'FOLD' },
      { position: 'HJ', type: 'FOLD' }, { position: 'CO', type: 'RAISE', amountBB: 2.5 },
      { position: 'BTN', type: 'RAISE', amountBB: 9 }, { position: 'SB', type: 'FOLD' },
      { position: 'BB', type: 'FOLD' },
    ],
    environment: 'MID_LOW_STAKES',
    villain: { quickProfile: 'NORMAL', dynamicHint: 'UNKNOWN' },
  } as never);
  assert.equal(raw.ok, true, `夹具输入必须可解析：${JSON.stringify((raw as any).issues)}`);
  const gate = reconstructGameState((raw as any).value, { mode: ReconstructMode.PREVIEW });
  assert.equal(gate.ok, true, '夹具状态必须可重建');
  const st: any = (gate as any).state;
  const hero = st.players.find((p: any) => p.id === 'seat_CO');
  const opponent = st.players.find((p: any) => p.id === 'seat_BTN');

  const built = buildPreflopRaiseFacts({
    state: st,
    hero,
    opponent,
    legal: deriveLegalActions(st, hero),
    arrivalEntries: [
      { cardIndices: [0, 1] as const, probability: 0.5 },
      { cardIndices: [2, 3] as const, probability: 0.5 },
    ],
    arrivalSource: 'TEST',
    range: null,
    tendencies: neutralResponseTendencies(),
    playersRemainingToAct: 0,
    seed: 20_260_913,
    equityOf: () => ({ value: 0.5, method: 'MONTE_CARLO', iterations: 100, confidenceHalfWidth: 0.05 }),
  });
  assert.equal(built.ok, true, `事实包必须能构建：${JSON.stringify(built)}`);
  return (built as any).facts.sizes;
}

/**
 * 在引擎上把「Hero 加注到 `toAmount` → 对手 CALL（补到跟平，按剩余封顶）」走完，
 * 返回**只有引擎知道**的真值。
 */
function engineTruth(base: any, toAmount: number): {
  readonly main: number;
  readonly contested: number;
  readonly returned: number;
  readonly computePot: number;
  readonly deadMoney: number;
  readonly heroStreetAfter: number;
  readonly villainStreetAfter: number;
} {
  const r1 = applyAction(base, { playerId: 'seat_CO', type: 'RAISE' as never, amount: toAmount });
  assert.equal(r1.ok, true, `加注到 ${toAmount} 必须合法：${JSON.stringify((r1 as any).issues)}`);
  const st2: any = (r1 as { ok: true; state: unknown }).state;
  const b2: any = st2.players.find((p: any) => p.id === 'seat_BTN');
  const need = Math.max(0, Math.min(toAmount - b2.committedByStreet.PREFLOP, b2.remainingStack));
  const r2 =
    need > 0
      ? applyAction(st2, { playerId: 'seat_BTN', type: 'CALL' as never, amount: need })
      : ({ ok: true, state: st2 } as const);
  assert.equal(r2.ok, true, `对手跟注 ${need} 必须合法：${JSON.stringify((r2 as any).issues)}`);
  const st3: any = (r2 as { ok: true; state: unknown }).state;
  const c3: any = st3.players.find((p: any) => p.id === 'seat_CO');
  const b3: any = st3.players.find((p: any) => p.id === 'seat_BTN');
  const ledger: any = computeLayeredPot(st3);
  return {
    main: ledger.main,
    contested: ledger.contested,
    returned: ledger.returned?.['seat_CO'] ?? 0,
    computePot: computePot(st3),
    deadMoney: ledger.deadMoney,
    heroStreetAfter: c3.committedByStreet.PREFLOP,
    villainStreetAfter: b3.committedByStreet.PREFLOP,
  };
}

const TABLE = CONFIGS.flatMap(([v, h]) =>
  sizesOf(v, h).map((size) => ({ villainBB: v, heroBB: h, size, truth: engineTruth(facingThreeBet(v, h), size.sizeChips) })),
);

/* ============================================================
 * CASH-1：与引擎分层台账逐位一致（**独立来源**）
 * ============================================================ */

test('CASH-1 每个尺寸的 finalPot 必须等于引擎台账 main、被跟注量必须等于它的差额', () => {
  assert.ok(TABLE.length >= 30, `应覆盖至少 30 个尺寸，实测 ${TABLE.length}`);
  for (const { villainBB, heroBB, size, truth } of TABLE) {
    const where = `对手 ${villainBB}BB / Hero ${heroBB}BB 尺寸 ${size.sizeChips}`;
    assert.equal(size.finalPot, truth.main, `${where}：finalPot=${size.finalPot} 必须等于引擎台账 main=${truth.main}`);
    assert.equal(truth.contested, truth.main, `${where}：台账 contested 应与 main 相同`);
    /*
     * 被跟注量 = 我新增投入中被匹配的部分。
     *
     * ⚠️ 引擎终局的 `committedByStreet.PREFLOP` 是**毛额**（含会被退回的超额），
     * 所以要减掉 `returned` 才是「真正留在池中」的量：
     * `heroStreetAfter − returned − 我本街已投`。
     * 60BB/10000 实测 `10000 − 4000 − 250 = 5750`。
     */
    assert.equal(
      size.heroContestedAdd,
      truth.heroStreetAfter - truth.returned - size.heroStreetCommitted,
      `${where}：被跟注量应等于 (引擎终局我本街总额 − 退回) − 我本街已投`,
    );
    /* 退回 = 引擎 `returned` */
    assert.equal(size.uncalledReturn, truth.returned, `${where}：退回=${size.uncalledReturn} 必须等于引擎 returned=${truth.returned}`);
    /* 引擎的无条件总投入必须 = 可争夺底池 + 退回 */
    assert.equal(
      truth.computePot,
      truth.main + truth.returned,
      `${where}：引擎 computePot 必须 = main + returned（${truth.computePot} = ${truth.main} + ${truth.returned}）`,
    );
    /*
     * 终池必须含死钱。`deadMoney` = **弃牌者**的投入（盲注弃牌 ⇒ 150）；
     * 而 `currentPot` 里还有双方**本街已投**（Hero 250、他 900）⇒
     * 恒等式是 `currentPot = deadMoney + 我本街已投 + 他本街已投`。
     */
    assert.equal(
      size.currentPot,
      truth.deadMoney + size.heroStreetCommitted + size.villainStreetCommitted,
      `${where}：currentPot 必须 = 死钱 + 双方本街已投`,
    );
  }
});

/* ============================================================
 * CASH-2：独立手算恒等式（不与生产共享公式）
 * ============================================================ */

test('CASH-2 独立手算：被跟注量 / 退回 / 终池 三者必须逐尺寸自洽', () => {
  for (const { villainBB, heroBB, size: s } of TABLE) {
    const where = `对手 ${villainBB}BB / Hero ${heroBB}BB 尺寸 ${s.sizeChips}`;
    /* 只从事实包自带的**原始输入**重算 */
    const villainTotal = s.villainStreetCommitted + s.villainAdd;
    const expectedContested = Math.max(0, Math.min(s.heroAdd, villainTotal - s.heroStreetCommitted));
    assert.equal(s.heroContestedAdd, expectedContested, `${where}：被跟注量 = min(heroAdd, 他本街总额 − 我本街已投)`);
    assert.equal(s.finalPot, s.currentPot + s.heroContestedAdd + s.villainAdd, `${where}：终池 = pot0 + 被跟注量 + 他补的差价`);
    assert.equal(s.heroContestedAdd + s.uncalledReturn, s.heroAdd, `${where}：现金守恒（新增 = 被跟注 + 退回）`);
    assert.ok(s.heroContestedAdd > 0 && s.heroContestedAdd <= s.heroAdd, `${where}：被跟注量必须在 (0, heroAdd] 内`);
  }
});

/* ============================================================
 * CASH-3：历史错误公式必须**不再**成立（防回退）
 * ============================================================ */

test('CASH-3 第一轮错误公式在每一个尺寸上都必须与正确终池不同且更小', () => {
  for (const { size: s } of TABLE) {
    const firstRound = s.currentPot + Math.min(s.heroAdd, s.villainAdd) + s.villainAdd;
    assert.notEqual(firstRound, s.finalPot, `尺寸 ${s.sizeChips}：第一轮公式不该再给出相同结果`);
    assert.ok(firstRound < s.finalPot, `尺寸 ${s.sizeChips}：第一轮公式系统性低估（${firstRound} < ${s.finalPot}）`);
  }
});

test('CASH-3b 第三轮「2×我本街总额」写法必须与正确终池差一块可解释的量', () => {
  let exposed = 0;
  for (const { size: s } of TABLE) {
    const thirdRound = 2 * (s.heroStreetCommitted + s.heroAdd);
    assert.notEqual(thirdRound, s.finalPot, `尺寸 ${s.sizeChips}：第三轮写法不该给出相同结果`);
    /*
     * 把正确式 `finalPot = currentPot + 被跟注量 + 他补的差价` 与
     * `currentPot = 死钱 + 我本街已投 + 他本街已投` 联立，再减去
     * 第三轮写法 `2 × 我本街总额`，得差额
     * `死钱 + 2×他本街已投 − 我本街已投 − 被跟注量`。
     *
     * 「第三轮写法」之所以看起来像对的，是因为在**双方本街已投都为 0** 的局面
     * （或本夹具这种固定 250/900）下这个差额是个常数，容易被误当成零。
     */
    const explained =
      s.currentPot + s.heroContestedAdd + s.villainAdd - thirdRound;
    assert.equal(
      s.finalPot - thirdRound,
      explained,
      `尺寸 ${s.sizeChips}：差额必须可由「死钱 + 双方本街已投」解释`,
    );
    /* 差额非零 ⇒ 该写法确实错 */
    assert.ok(
      Math.abs(s.finalPot - thirdRound) > 0,
      `尺寸 ${s.sizeChips}：第三轮写法必须与正确值不同`,
    );
    exposed += 1;
  }
  assert.ok(exposed > 0, '必须至少有一个尺寸能暴露第三轮写法');
  /*
   * 本夹具（死钱 150、他本街已投 900、我本街已投 250）下，差额恰为
   * `150 + 2×900 − 250 − 650 = 1050` —— 但**尺寸 1550** 时他被跟注量是 1300
   * 而非 650，所以差额是 `150 + 1800 − 250 − 1300 = 400`。
   * 差额随尺寸变化 ⇒ 它不是常数 ⇒ 第三轮写法不可能正确。
   */
  const diffs = TABLE.map(({ size: s }) => s.finalPot - 2 * (s.heroStreetCommitted + s.heroAdd));
  assert.equal(new Set(diffs).size > 1, true, `差额必须随尺寸变化，实测取值 ${[...new Set(diffs)].join('/')}`);
  assert.ok(diffs.every((d) => d !== 0), '第三轮写法在任何尺寸上都不等于正确终池');
});

/* ============================================================
 * CASH-4：对手短码演进 —— 尺寸网格必须切到「他全下即封顶」的分支
 * ============================================================ */

test('CASH-4 对手 20BB：超过他全下额的尺寸必须统一按他的全下额封顶', () => {
  const sizes = sizesOf(20, 100);
  const capped = sizes.filter((s: any) => s.villainIsAllInByCall === true);
  assert.ok(capped.length > 0, '对手 20BB 时必须存在「他跟注即全下」的尺寸');
  for (const s of capped) {
    assert.equal(s.villainAdd, 1100, `尺寸 ${s.sizeChips}：他只能补到他的全下额`);
    assert.equal(s.villainStreetCommitted + s.villainAdd, 2000, '他跟平后本街总额 = 他的全部筹码');
    assert.equal(s.heroContestedAdd, 1750, `尺寸 ${s.sizeChips}：被跟注量 = 2000 − 我本街已投 250`);
    assert.ok(s.uncalledReturn > 0, '超出他全下额的部分必须退回');
  }
});

/* ============================================================
 * CASH-5：60BB 加注到 10000 —— 三轮写法在这一行上给出三个不同答案
 * ============================================================ */

test('CASH-5 对手 60BB 加注到 10000：终池必须是 12150（含死钱、含退回修正）', () => {
  const base = facingThreeBet(60, 100);
  const sizes = sizesOf(60, 100);
  const allIn = sizes.find((s: any) => s.sizeChips === 10000);
  assert.ok(allIn !== undefined, '对手 60BB 的尺寸网格必须含 10000');
  const truth = engineTruth(base, 10000);

  /* 引擎台账真值 */
  assert.equal(truth.villainStreetAfter, 6000, '引擎：他本街总额 6000（全下）');
  assert.equal(truth.main, 12150, '引擎台账 main = 12150');
  assert.equal(truth.deadMoney, 150, '引擎台账 deadMoney = 150（盲注已弃）');
  assert.equal(truth.returned, 4000, '引擎台账 returned = 4000');
  assert.equal(truth.computePot, 16150, '引擎 computePot = 12150 + 4000');

  /* 事实包 */
  assert.equal(allIn.heroContestedAdd, 5750, '被跟注量 = 5750（我本街总额 6000 − 我本街已投 250）');
  assert.equal(allIn.finalPot, 12150, '终池必须是 12150');
  assert.equal(allIn.uncalledReturn, 4000, '退回 = 9750 − 5750');
  assert.equal(allIn.villainIsAllInByCall, true, '他跟平即全下');

  /* 三个历史答案必须都被排除 */
  const firstRound = allIn.currentPot + Math.min(allIn.heroAdd, allIn.villainAdd) + allIn.villainAdd;
  const thirdRound = 2 * (allIn.heroStreetCommitted + allIn.heroAdd);
  assert.notEqual(allIn.finalPot, firstRound, `第一轮写法给 ${firstRound}`);
  assert.notEqual(allIn.finalPot, thirdRound, `第三轮写法给 ${thirdRound}`);
});
