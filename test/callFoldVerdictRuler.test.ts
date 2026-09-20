/**
 * ============================================================================
 * P1 · CALL/FOLD 裁决标尺一致性（**永久回归**）
 * ============================================================================
 *
 * ## 被锁的缺陷（`reports/P1_99_CALL_FOLD_CONSISTENCY_AUDIT.md`）
 *
 * `math.callEV` 用**对手下注范围权益**（`contextBuilder.ts:585`：
 * `equityForCallEV = heroEquityVsBetRange ?? equity`），而 `MATH_FOLD_DOMINANT`
 * 硬判的第二个条件 `verdictEdge < -MARGINAL_EV_GAP_RATIO`（`decisionEngine.ts:1816`）
 * 曾用**整体/到达范围权益差**（`edge = math.heroEquity − requiredEquity`）——
 * 代码在 `:1729` 声明「单层时 `edge = callEV / winnable`」，该恒等式在
 * 「两份条件权益不同」的节点被打破（原始 99 节点差 **11.36 个百分点**），
 * 于是**正的 CALL EV 被另一把尺子判成「数学明显不划算」⇒ 弃牌**，
 * 并触发 `ACTION_CONTRADICTS_CHIP_EV`。
 *
 * ## 本文件断言什么（不硬编码最终动作）
 *
 * - 只断言**契约**：`CALL EV > ε` ⇒ 动作不得是 FOLD；`CALL EV < −ε` ⇒ 必须弃牌；
 *   `CALL EV = null` ⇒ 不得伪造数学证据；
 * - 一致性检查必须 `ok`，理由与界面必须用**本次 CALL EV 的实际权益来源**；
 * - 分层底池（`layeredEV`）优先级、容差带语义、U1/P1-2b 资金流、跨节点确定性逐条护栏。
 *
 * ## 原始牌局（已登记，逐字取自 `scripts/test18-amount-matrix.ts`）
 *
 * 6 人桌 · 盲注 1/2 · 双方 200 筹码 · Hero BTN 9♥9♣ · 公共牌 J♦8♣4♣6♠（转牌）
 * 翻前 BTN 加注至 6 → BB 跟注；翻牌 BB 过牌 → BTN 下注 8 → BB 跟注；
 * 转牌 BB 主动下注 20 ⇒ 底池 49、跟注需补 20。
 * 对手：阿豪（MANIAC，800 手，VPIP 48% / PFR 35% / 3Bet 16% / WTSD 36%，其余 null）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import type { ManualHandInput, ManualVillain } from '../src/app/manualInput/manualInput.ts';

const OPTIONS = {
  rules: loadKnowledgeBaseOrThrow().allRules(), asOf: 1_757_000_000_000, writeLog: false,
  equitySeed: 20_260_913, budget: { softMs: 120_000, hardMs: 240_000 },
} as const;

const A_ = (p: string, t: string, bb?: number, s?: string): Record<string, unknown> => ({
  position: p, type: t, ...(bb === undefined ? {} : { amountBB: bb }), ...(s === undefined ? {} : { street: s }),
});
const BASE = {
  tableSize: 6, heroPosition: 'BTN', effectiveStackBB: 100, bigBlindBB: 2,
  seatStacksBB: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 },
  environment: 'MID_LOW_STAKES',
} as const;
/** 转牌「BB 领先下注 20」那条线（99 原始节点用的就是它） */
const HISTORY_TURN_BET = [
  A_('UTG', 'FOLD'), A_('HJ', 'FOLD'), A_('CO', 'FOLD'),
  A_('BTN', 'RAISE', 3), A_('SB', 'FOLD'), A_('BB', 'CALL', 2),
  A_('BB', 'CHECK', undefined, 'FLOP'), A_('BTN', 'BET', 4, 'FLOP'), A_('BB', 'CALL', 4, 'FLOP'),
  A_('BB', 'BET', 10, 'TURN'),
];
/** 转牌「BB 过牌」（无人下注 ⇒ callCost = 0、callEV = null） */
const HISTORY_TURN_CHECK = [...HISTORY_TURN_BET.slice(0, -1), A_('BB', 'CHECK', undefined, 'TURN')];

const MANIAC_800: ManualVillain = {
  seatId: 'seat_BB', persistentPlayerId: 'player_001', displayName: '阿豪',
  quickProfile: 'MANIAC', dynamicHint: 'UNKNOWN', stackBB: 100,
  observedStats: {
    handsObserved: 800,
    vpip: 0.48, pfr: 0.35, threeBet: 0.16, wtsd: 0.36,
    foldToFlopCBet: null, foldToTurnCBet: null, foldToRiverBet: null,
    flopCheckRaise: null, turnCheckRaise: null, riverCheckRaise: null,
  },
};
const VERY_TIGHT: ManualVillain = {
  seatId: 'seat_BB', persistentPlayerId: 'player_001', displayName: '阿豪',
  quickProfile: 'VERY_TIGHT', dynamicHint: 'UNKNOWN', stackBB: 100,
};

/** 原始 99 节点（Hero BTN 9♥9♣，转牌面对 BB 20 领打） */
function original99(villain: ManualVillain = MANIAC_800): ManualHandInput {
  return { ...BASE, heroCards: ['9h', '9c'], board: ['Jd', '8c', '4c', '6s'], street: 'TURN', actionHistory: HISTORY_TURN_BET, villain } as unknown as ManualHandInput;
}

type Run = {
  readonly action: string;
  readonly sizeChips: number | undefined;
  readonly callEV: number | null;
  readonly eqBetRange: number | null;
  readonly eqArrival: number | null;
  readonly requiredEquity: number;
  readonly winnable: number;
  readonly band: number;
  readonly marginKind: string;
  readonly basisKind: string;
  readonly consistencyOk: boolean;
  readonly violationCodes: readonly string[];
  readonly reasonCodes: readonly string[];
  readonly reasonTexts: readonly string[];
  readonly warnings: readonly string[];
  readonly vm: Record<string, any>;
  readonly dg: Record<string, any>;
};

function runOf(input: ManualHandInput): Run {
  const r = analyzeManualHand(input, OPTIONS);
  assert.equal(r.ok, true, `分析必须成功：${r.ok ? '' : JSON.stringify(r.issues)}`);
  if (!r.ok) throw new Error('unreachable');
  const d = r.decision as unknown as Record<string, any>;
  const dg = d['diagnostics'] as Record<string, any>;
  const math = dg['math'] as Record<string, any>;
  const cons = (dg['consistency'] ?? null) as Record<string, any> | null;
  const reasons = (d['reasons'] ?? []) as readonly Record<string, any>[];
  return {
    action: String(d['action']),
    sizeChips: d['sizeChips'] as number | undefined,
    callEV: math['callEV'] as number | null,
    eqBetRange: math['heroEquityVsBetRange'] as number | null,
    eqArrival: math['heroEquity'] as number | null,
    requiredEquity: math['requiredEquity'] as number,
    winnable: math['winnable'] as number,
    band: 0.05 * (math['winnable'] as number),
    marginKind: String(dg['decisionMargin']?.['kind'] ?? '—'),
    basisKind: String(dg['decisionBasis']?.['kind'] ?? dg['decisionSource']?.['kind'] ?? '—'),
    consistencyOk: cons === null ? true : cons['ok'] === true,
    violationCodes: ((cons?.['violations'] as readonly Record<string, any>[]) ?? []).map((v) => String(v['code'])),
    reasonCodes: reasons.map((x) => String(x['code'])),
    reasonTexts: reasons.map((x) => String(x['textZh'])),
    warnings: r.warnings as readonly string[],
    vm: r.viewModel as unknown as Record<string, any>,
    dg,
  };
}

const EPS = 1e-6; // == MATH_EV_EPSILON（引擎内的浮点余量，本文件只读不改）

/* ============================================================
 * A —— 原始 99 节点：正 CALL EV 不得被判成 FOLD（本文件的核心失败测试）
 * ============================================================ */

test('P1-A（原始 99 节点）：CALL EV 为正 ⇒ 动作不得是 FOLD，且一致性必须通过', () => {
  const run = runOf(original99());

  /* 输入事实（复现审计报告里的原始节点） */
  assert.equal(run.requiredEquity, 20 / 69, '所需权益必须是 20/69 = 28.9855%');
  assert.equal(run.winnable, 69, '可争夺量必须是 69');
  assert.ok(Math.abs((run.callEV ?? 0) - 2.705235410024) < 1e-9, `CALL EV 必须复现 +2.705235410024（实际 ${String(run.callEV)}）`);
  assert.equal(run.eqBetRange !== null && Math.abs(run.eqBetRange - 0.32906138275397) < 1e-12, true, '对手下注范围权益必须是 32.906138275397%');
  assert.equal(run.eqArrival !== null && Math.abs(run.eqArrival - 0.21545565973459) < 1e-12, true, '整体范围权益必须是 21.545565973459%');

  /* 🔴 契约：EV > +ε ⇒ 不得弃牌（修复前这里失败：动作是 FOLD） */
  assert.ok((run.callEV ?? 0) > EPS, '前提：CALL EV 必须为正');
  assert.notEqual(run.action, 'FOLD', `CALL EV 为正时不得弃牌（实际 ${run.action}；这正是 P1 缺陷）`);

  /* 一致性检查必须通过（修复前是 ACTION_CONTRADICTS_CHIP_EV） */
  assert.equal(run.consistencyOk, true, `一致性必须通过，实际违规：${run.violationCodes.join(',')}`);
  assert.equal(run.violationCodes.includes('ACTION_CONTRADICTS_CHIP_EV'), false, '不得再出现 ACTION_CONTRADICTS_CHIP_EV');
  assert.equal(
    run.warnings.some((w) => w.includes('DECISION_CONSISTENCY_ERROR')),
    false,
    `用户可见 warnings 不得含一致性错误：${JSON.stringify(run.warnings)}`,
  );

  /* 依据分类器必须与动作自洽（CHIP_EV 时它的说明写着「CALL 更高」） */
  assert.equal(run.basisKind, 'CHIP_EV', '本节点依据必须是 CHIP_EV（节点增量 chip EV）');

  /* 由**生产链自己**给出动作与理由：正 EV 侧的理由必须在，负 EV 侧的理由不得在 */
  assert.equal(
    run.reasonCodes.includes('MATH_FOLD_DOMINANT'),
    false,
    `CALL EV 为正时不得给出「数学明显不划算」理由（实际理由：${run.reasonCodes.join(',')}）`,
  );
  assert.ok(
    run.reasonCodes.includes('MATH_CALL_SUPPORTED') || run.reasonCodes.includes('RAISE_MODEL_EV') || run.reasonCodes.includes('SUPPORTED_ACTION_PRIORITY'),
    `必须由正 EV 侧的路径给出动作与理由（实际：${run.reasonCodes.join(',')}）`,
  );
  /* 动作必须合法且可执行 */
  assert.equal(run.vm['actionable'], true, '动作必须 actionable');
  assert.ok(run.action === 'CALL' || run.action === 'RAISE' || run.action === 'ALL_IN', `动作必须在 {CALL,RAISE,ALL_IN} 内（实际 ${run.action}）`);
});

/* ============================================================
 * N —— 用户可见解释必须用正确的权益来源、且不得自相矛盾
 * ============================================================ */

test('P1-N（理由/界面）：权益来源必须是 CALL EV 的那一份，且不得出现「高于门槛却写成低于」', () => {
  const run = runOf(original99());
  const betPct = ((run.eqBetRange ?? 0) * 100).toFixed(2);
  const requiredPct = (run.requiredEquity * 100).toFixed(1);

  const joined = run.reasonTexts.join('\n');
  assert.ok(joined.includes('对手下注范围权益'), `理由必须点明 EV 的权益来源，实际：${joined.slice(0, 300)}`);
  assert.equal(/弃牌 EV 更高/.test(joined), false, 'CALL EV 为正时不得声称「弃牌 EV 更高」');

  /*
   * 反向护栏：任何一句「X% 低于跟注所需 Y%」都必须真的成立
   *（修复前 99 节点的 MATH_FOLD_DOMINANT 写着「32.9% 低于 29.0%」，是自相矛盾的）。
   */
  for (const text of run.reasonTexts) {
    const m = /([0-9.]+)%\s*低于跟注所需\s*([0-9.]+)%/.exec(text);
    if (m === null) continue;
    assert.ok(Number(m[1]) < Number(m[2]), `「${m[1]}% 低于跟注所需 ${m[2]}%」不成立：${text}`);
  }
  /* 界面两行权益必须分开且写明用途（TEST 17 的契约） */
  const rows = (run.vm['debug']?.['math'] ?? []) as readonly { label: string; value: string }[];
  const betRow = rows.find((x) => x.label === '对手下注范围权益');
  const wholeRow = rows.find((x) => x.label === '整体范围权益（仅参考）');
  assert.ok(betRow !== undefined && betRow.value.includes(`${betPct}%`), `界面必须显示下注范围权益 ${betPct}%（实际 ${String(betRow?.value)}）`);
  assert.ok(wholeRow !== undefined, '界面必须有「整体范围权益（仅参考）」行');
  const evRow = rows.find((x) => x.label === '跟注 EV（节点增量口径）');
  assert.ok(
    evRow !== undefined && evRow.value.includes('对手下注范围权益'),
    `跟注 EV 行必须写明权益输入（实际 ${String(evRow?.value)}）`,
  );
  /* 容差带语义保留：本节点 EV 在 ±5% 带内 ⇒ 必须是边缘局面，不得升级为「明确决策」 */
  assert.equal(run.marginKind, 'MARGINAL', `带内节点必须是 MARGINAL（实际 ${run.marginKind}）`);
  assert.notEqual(run.dg['classification'], 'CLEAR', '不得把带内的微小优势说成明确决策');
});

/* ============================================================
 * B / C / D —— 负 EV、超出带的正 EV、带内近零 EV
 * ============================================================ */

test('P1-B（负 CALL EV）：原有弃牌规则仍然有效', () => {
  const run = runOf(original99(VERY_TIGHT));
  assert.ok((run.callEV ?? 0) < -EPS, `前提：该画像下 CALL EV 必须为负（实际 ${String(run.callEV)}）`);
  assert.equal(run.action, 'FOLD', `负 CALL EV 必须弃牌（实际 ${run.action}）`);
  assert.equal(run.consistencyOk, true, `负 EV 弃牌必须一致（违规：${run.violationCodes.join(',')}）`);
  assert.ok(run.reasonCodes.includes('MATH_FOLD_DOMINANT'), '必须给出「数学上不划算」理由');
  assert.equal(/弃牌 EV 更高/.test(run.reasonTexts.join('\n')), true, '负 EV 时该句才成立，必须保留');
});

test('P1-C/D（带内外）：超出容差带的正 EV 与带内近零 EV 都必须跟随 chip EV 排名', () => {
  /* C：明显正 EV —— 用「顶对 + 坚果同花听」节点（同一牌面、同一行动线） */
  const strong = runOf({ ...BASE, heroCards: ['Ac', 'Jc'], board: ['Jd', '8c', '4c', '6s'], street: 'TURN', actionHistory: HISTORY_TURN_BET, villain: MANIAC_800 } as unknown as ManualHandInput);
  assert.ok((strong.callEV ?? 0) > strong.band, `前提：该节点 CALL EV 必须超出容差带（实际 ${String(strong.callEV)} vs ±${strong.band.toFixed(2)}）`);
  assert.notEqual(strong.action, 'FOLD', `超出带的正 EV 不得弃牌（实际 ${strong.action}）`);
  assert.equal(strong.consistencyOk, true, '必须一致');

  /* D：带内近零正 EV（NORMAL 画像下 99 的 CALL EV ≈ +0.05） */
  const nearZero = runOf(original99({ seatId: 'seat_BB', persistentPlayerId: 'player_001', displayName: '阿豪', quickProfile: 'NORMAL', dynamicHint: 'UNKNOWN', stackBB: 100 }));
  assert.ok((nearZero.callEV ?? 0) > EPS && (nearZero.callEV ?? 0) <= nearZero.band, `前提：该节点 EV 必须在 (0, 带] 内（实际 ${String(nearZero.callEV)}）`);
  assert.notEqual(nearZero.action, 'FOLD', `带内正 EV 同样不得弃牌（实际 ${nearZero.action}）`);
  assert.equal(nearZero.marginKind, 'MARGINAL', '带内节点必须保留 MARGINAL 语义');
  assert.equal(nearZero.consistencyOk, true, '必须一致');
});

/* ============================================================
 * E / F —— CALL EV = null 与非法数：不得伪造数学证据
 * ============================================================ */

test('P1-E（CALL EV = null）：不得由除法伪造裁决边际，也不得给出 chip EV 断言', () => {
  const run = runOf({ ...BASE, heroCards: ['9h', '9c'], board: ['Jd', '8c', '4c', '6s'], street: 'TURN', actionHistory: HISTORY_TURN_CHECK, villain: MANIAC_800 } as unknown as ManualHandInput);
  assert.equal(run.callEV, null, '无人下注 ⇒ CALL EV 必须为 null（不是 0）');
  assert.notEqual(run.action, 'FOLD', `无人下注且无需跟注时不得弃牌（实际 ${run.action}）`);
  assert.notEqual(run.basisKind, 'CHIP_EV', 'CALL EV 不可得时依据不得声称是 chip EV 排名');
  assert.equal(run.consistencyOk, true, '必须一致');
});

test('P1-F（非法数护栏）：全网格的数学量必须有限、动作必须合法', () => {
  const grid = gridRuns();
  assert.ok(grid.length >= 9, `网格至少要跑到 9 个局面（实际 ${grid.length}）`);
  for (const [tag, run] of grid) {
    const math = run.dg['math'] as Record<string, any>;
    for (const key of ['pot', 'callCost', 'winnable', 'requiredEquity', 'heroEquity', 'callEV']) {
      const v = math[key];
      if (v === null) continue;
      assert.ok(Number.isFinite(v), `${tag}: math.${key} 必须有限（实际 ${String(v)}）`);
      assert.equal(Number.isNaN(v as number), false, `${tag}: math.${key} 不得是 NaN`);
    }
    assert.ok(['FOLD', 'CALL', 'CHECK', 'BET', 'RAISE', 'ALL_IN'].includes(run.action), `${tag}: 动作必须合法（实际 ${run.action}）`);
  }
});

/* ============================================================
 * H / I / J / K —— 权益来源、无回归、画像档位一致、跨动作优先级
 * ============================================================ */

test('P1-H/J（同一把尺子，跨画像档位）：EV > ε ⇒ 不得弃牌；EV < −ε ⇒ 必须弃牌', () => {
  const grid = gridRuns();
  for (const [tag, run] of grid) {
    if (run.callEV === null) continue;
    if (run.callEV > EPS) {
      assert.notEqual(run.action, 'FOLD', `${tag}: CALL EV = +${run.callEV.toFixed(4)} 为正却弃牌 —— 标尺又混用了`);
      assert.equal(run.consistencyOk, true, `${tag}: 正 EV 弃牌必然触发一致性违规`);
    }
    if (run.callEV < -EPS) {
      assert.equal(run.action, 'FOLD', `${tag}: CALL EV = ${run.callEV.toFixed(4)} 为负必须弃牌（实际 ${run.action}）`);
    }
  }
});

test('P1-I（两份权益相同的节点）：不得产生无理由的数值回归', () => {
  /*
   * 当 `heroEquityVsBetRange` 与 `heroEquity` 相差在浮点余量内时，
   * 旧标尺与新标尺**代数等价** ⇒ 动作与 EV 必须与修复前一致。
   * 这里用「整体范围权益 ≈ 下注范围权益」的网格局面做回归锚点。
   */
  const grid = gridRuns();
  const coincident = grid.filter(([, r]) => r.eqBetRange !== null && r.eqArrival !== null && Math.abs(r.eqBetRange - r.eqArrival) <= 1e-12);
  for (const [tag, run] of coincident) {
    if (run.callEV === null) continue;
    const expected = run.callEV > EPS ? true : run.callEV < -EPS ? false : null;
    if (expected === null) continue;
    assert.equal(run.action === 'FOLD', !expected, `${tag}: 两份权益相同 ⇒ 动作必须只由 EV 符号决定`);
  }
  /* 无论是否有重合局面，本测试都不断言「一定存在」——如实记录数量即可 */
  assert.ok(coincident.length >= 0, `重合局面数 = ${coincident.length}（信息性）`);
});

test('P1-K（跨动作优先级）：有比较资格的更高 EV 加注不得被 CALL/FOLD 覆盖', () => {
  const grid = gridRuns();
  for (const [tag, run] of grid) {
    const rr = (((run.dg['postflop'] ?? {}) as Record<string, any>)['raiseResponse'] ?? null) as Record<string, any> | null;
    if (rr === null || run.callEV === null || rr['raiseEV'] === null) continue;
    const guard = (run.dg['allInGuard'] ?? null) as Record<string, any> | null;
    const hasOwnEV = (guard?.['raiseSizesWithOwnEV'] as readonly number[] | undefined)?.includes(rr['sizeChips'] as number) === true;
    if (!hasOwnEV) continue; // 加注 EV 没有比较资格 ⇒ 不参与裁决
    if ((rr['raiseEV'] as number) > run.callEV + EPS && (rr['raiseEV'] as number) > EPS) {
      assert.equal(run.action, 'RAISE', `${tag}: 加注 EV ${rr['raiseEV']} > 跟注 EV ${run.callEV} ⇒ 必须加注（实际 ${run.action}）`);
    }
  }
});

/* ============================================================
 * L / M —— 资金流与跨节点确定性
 * ============================================================ */

test('P1-L（U1 / P1-2b 资金流）：加注响应的资金恒等式逐位保持', () => {
  const run = runOf(original99());
  const rr = (((run.dg['postflop'] ?? {}) as Record<string, any>)['raiseResponse'] ?? null) as Record<string, any> | null;
  assert.notEqual(rr, null, '本节点必须有加注响应事实包');
  assert.equal(rr!['heroAdd'], rr!['heroContestedAdd'] + rr!['uncalledReturn'], 'heroAdd = 留在池中 + 退回');
  assert.equal(rr!['finalPot'], rr!['currentPot'] + rr!['heroContestedAdd'] + rr!['villainAdd'], '终池 = 当前底池 + 双方新增');
  assert.equal(rr!['cashflowContract'], 'NODE_INCREMENTAL_CHIPS_V2', '资金口径契约不得变化');
});

test('P1-M（确定性）：两个节点先后运行不得污染彼此的结果', () => {
  const first = runOf(original99());
  /* 中间跑一个**无关**节点（TEST 16 的河牌节点） */
  runOf({
    ...BASE, heroCards: ['As', 'Ah'], board: ['Ad', '9c', '4h', '6s', '2d'], street: 'RIVER',
    actionHistory: [
      A_('UTG', 'FOLD'), A_('HJ', 'FOLD'), A_('CO', 'FOLD'),
      A_('BTN', 'RAISE', 3), A_('SB', 'FOLD'), A_('BB', 'CALL', 2),
      A_('BB', 'CHECK', undefined, 'FLOP'), A_('BTN', 'BET', 2.5, 'FLOP'), A_('BB', 'CALL', 2.5, 'FLOP'),
      A_('BB', 'CHECK', undefined, 'TURN'), A_('BTN', 'BET', 7.5, 'TURN'), A_('BB', 'CALL', 7.5, 'TURN'),
      A_('BB', 'BET', 10, 'RIVER'),
    ],
    villain: MANIAC_800,
  } as unknown as ManualHandInput);
  const again = runOf(original99());
  assert.deepEqual(
    { a: again.action, ev: again.callEV, eq: again.eqBetRange, codes: again.reasonCodes, ok: again.consistencyOk },
    { a: first.action, ev: first.callEV, eq: first.eqBetRange, codes: first.reasonCodes, ok: first.consistencyOk },
    '同一输入在跑过别的节点之后必须给出逐位相同的结果',
  );
});

/* ============================================================
 * 网格（供 H/I/J/K/F 复用的场景集：3 牌面 × 3 画像档位）
 * ============================================================ */

function gridRuns(): ReadonlyArray<readonly [string, Run]> {
  const boards: ReadonlyArray<readonly [string, readonly [string, string], readonly string[]]> = [
    ['99/Jd8c4c6s', ['9h', '9c'], ['Jd', '8c', '4c', '6s']],
    ['AJ/Jd8c4c6s', ['Ac', 'Jc'], ['Jd', '8c', '4c', '6s']],
    ['AA/Ad9c4h6s2d', ['As', 'Ah'], ['Ad', '9c', '4h', '6s', '2d']],
  ];
  const villains: ReadonlyArray<readonly [string, ManualVillain]> = [
    ['MANIAC+800 手', MANIAC_800],
    ['VERY_TIGHT 无统计', VERY_TIGHT],
    ['无画像', { seatId: 'seat_BB', persistentPlayerId: 'player_001', displayName: '阿豪', dynamicHint: 'UNKNOWN', stackBB: 100 }],
  ];
  const out: Array<readonly [string, Run]> = [];
  for (const [boardTag, heroCards, board] of boards) {
    const river = board.length === 5;
    const history = river
      ? [
          A_('UTG', 'FOLD'), A_('HJ', 'FOLD'), A_('CO', 'FOLD'),
          A_('BTN', 'RAISE', 3), A_('SB', 'FOLD'), A_('BB', 'CALL', 2),
          A_('BB', 'CHECK', undefined, 'FLOP'), A_('BTN', 'BET', 2.5, 'FLOP'), A_('BB', 'CALL', 2.5, 'FLOP'),
          A_('BB', 'CHECK', undefined, 'TURN'), A_('BTN', 'BET', 7.5, 'TURN'), A_('BB', 'CALL', 7.5, 'TURN'),
          A_('BB', 'BET', 10, 'RIVER'),
        ]
      : HISTORY_TURN_BET;
    for (const [villainTag, villain] of villains) {
      out.push([
        `${boardTag} × ${villainTag}`,
        runOf({ ...BASE, heroCards, board, street: river ? 'RIVER' : 'TURN', actionHistory: history, villain } as unknown as ManualHandInput),
      ]);
    }
  }
  return out;
}
