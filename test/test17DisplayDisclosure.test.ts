/**
 * ============================================================================
 * TEST 17 · 决策展示与模型假设（展示层最小修复的永久回归）
 * ============================================================================
 *
 * 本文件锁的是 **TEST 17 审计确认的三个「用户可见」问题**，以及修复后
 * 「使用者能自己复算」这一性质 —— 它**不**重算任何决策：
 *
 * | 编号 | 锁什么 |
 * |---|---|
 * | D-1 | CALL EV 的权益来源必须被标注成 **EqVsBetRange**，并与数值自洽 |
 * | D-2 | 展示层同时出现「权益」与「跟注 EV」时，两者必须同源；另一份必须标成「仅参考」 |
 * | D-3 | 界面行：下注范围权益 / 整体范围权益分开，且写明哪一份是 EV 的输入 |
 * | D-4 | 已确认的中文决策说明损坏必须不再出现（对**全部用户可见字符串**扫描） |
 * | D-5 | 再加注分支必须披露「摊牌终止近似」与「不是严格下界」，并披露 4-bet 未实现 |
 * | D-6 | 假设清单不得有重复条目 |
 * | D-7 | 打印出来的 RAISE EV 公式必须能复算出打印出来的 EV |
 * | D-8 | 验收数值不因展示修复而改变（CALL EV / RAISE EV / P1-2b 两分支） |
 *
 * ⚠️ 本文件**只读**生产输出，不修改任何参数；数值断言全部来自 TEST 17 原始牌局。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import type { ManualHandInput, ManualVillain } from '../src/app/manualInput/manualInput.ts';

const OPTIONS = {
  rules: loadKnowledgeBaseOrThrow().allRules(),
  asOf: 1_757_000_000_000, writeLog: false,
  equitySeed: 20_260_913, budget: { softMs: 120_000, hardMs: 240_000 },
} as const;

const A_ = (position: string, type: string, amountBB?: number, street?: string): Record<string, unknown> => ({
  position, type,
  ...(amountBB === undefined ? {} : { amountBB }),
  ...(street === undefined ? {} : { street }),
});

/** TEST 17 原始牌局：BTN A♣J♣，公共牌 J♦8♣4♣6♠，转牌面对 BB（阿豪）20 筹码领打 */
function test17Input(): ManualHandInput {
  const villain: ManualVillain = {
    seatId: 'seat_BB', persistentPlayerId: 'player_ahaohao', displayName: '阿豪',
    quickProfile: 'MANIAC', dynamicHint: 'UNKNOWN', stackBB: 100,
    observedStats: {
      handsObserved: 800,
      vpip: 0.48, pfr: 0.35, threeBet: 0.16, wtsd: 0.36,
      foldToFlopCBet: null, foldToTurnCBet: null, foldToRiverBet: null,
      flopCheckRaise: null, turnCheckRaise: null, riverCheckRaise: null,
    },
  };
  return {
    tableSize: 6, heroPosition: 'BTN', heroCards: ['Ac', 'Jc'], board: ['Jd', '8c', '4c', '6s'],
    street: 'TURN', effectiveStackBB: 100, bigBlindBB: 2,
    seatStacksBB: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 },
    actionHistory: [
      A_('UTG', 'FOLD'), A_('HJ', 'FOLD'), A_('CO', 'FOLD'),
      A_('BTN', 'RAISE', 3), A_('SB', 'FOLD'), A_('BB', 'CALL', 2),
      A_('BB', 'CHECK', undefined, 'FLOP'), A_('BTN', 'BET', 4, 'FLOP'), A_('BB', 'CALL', 4, 'FLOP'),
      A_('BB', 'BET', 10, 'TURN'),
    ],
    environment: 'MID_LOW_STAKES', villain,
  } as unknown as ManualHandInput;
}

/** 翻前面对 3bet：**没有**可用的下注范围 ⇒ 走「整体范围权益」回落口径（用于锁回落标注） */
function preflopFacingThreeBetInput(): ManualHandInput {
  return {
    tableSize: 6, heroPosition: 'CO', heroCards: ['As', 'Ah'], street: 'PREFLOP',
    effectiveStackBB: 100, bigBlindBB: 2,
    seatStacksBB: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 },
    actionHistory: [
      A_('UTG', 'FOLD'), A_('HJ', 'FOLD'), A_('CO', 'RAISE', 3),
      A_('BTN', 'FOLD'), A_('SB', 'FOLD'), A_('BB', 'RAISE', 10),
    ],
    environment: 'MID_LOW_STAKES',
    villain: { quickProfile: 'NORMAL', dynamicHint: 'UNKNOWN', stackBB: 100 } as ManualVillain,
  } as unknown as ManualHandInput;
}

type Run = {
  readonly decision: Record<string, any>;
  readonly math: Record<string, any>;
  readonly postflop: Record<string, any>;
  readonly raiseResponse: Record<string, any> | null;
  readonly rows: readonly { label: string; value: string }[];
};

function runOf(input: ManualHandInput): Run {
  const r = analyzeManualHand(input, OPTIONS);
  assert.equal(r.ok, true, `分析必须成功：${r.ok ? '' : JSON.stringify(r.issues)}`);
  if (!r.ok) throw new Error('unreachable');
  const decision = r.decision as unknown as Record<string, any>;
  const dg = decision['diagnostics'] as Record<string, any>;
  const postflop = (dg['postflop'] ?? {}) as Record<string, any>;
  const vm = r.viewModel as unknown as Record<string, any>;
  return {
    decision,
    math: dg['math'] as Record<string, any>,
    postflop,
    raiseResponse: (postflop['raiseResponse'] ?? null) as Record<string, any> | null,
    rows: ((vm['debug']?.['math'] ?? []) as readonly { label: string; value: string }[]),
  };
}

const rowOf = (run: Run, label: string): { label: string; value: string } | undefined =>
  run.rows.find((x) => x.label === label);

/** 决策快照里**全部用户可见字符串**（用于 D-4 的损坏扫描） */
function userVisibleStrings(run: Run): readonly string[] {
  const out: string[] = [];
  const d = run.decision;
  for (const reason of (d['reasons'] ?? []) as readonly Record<string, any>[]) {
    if (typeof reason['textZh'] === 'string') out.push(reason['textZh']);
  }
  for (const c of (d['diagnostics']?.['candidates'] ?? []) as readonly Record<string, any>[]) {
    if (typeof c['noteZh'] === 'string') out.push(c['noteZh']);
    if (typeof c['feasibleNoteZh'] === 'string') out.push(c['feasibleNoteZh']);
  }
  for (const u of (d['diagnostics']?.['unevaluatedActions'] ?? []) as readonly Record<string, any>[]) {
    if (typeof u['reasonZh'] === 'string') out.push(u['reasonZh']);
  }
  const dg = d['diagnostics'] as Record<string, any>;
  if (typeof dg['decisionSource']?.['noteZh'] === 'string') out.push(dg['decisionSource']['noteZh']);
  if (typeof dg['actionShape']?.['noteZh'] === 'string') out.push(dg['actionShape']['noteZh']);
  if (typeof dg['betDecision']?.['noteZh'] === 'string') out.push(dg['betDecision']['noteZh']);
  const rr = run.raiseResponse;
  if (rr !== null) {
    if (typeof rr['noteZh'] === 'string') out.push(rr['noteZh']);
    if (typeof rr['model']?.['noteZh'] === 'string') out.push(rr['model']['noteZh']);
    if (typeof rr['assumptionsZh'] === 'string') out.push(rr['assumptionsZh']);
    for (const a of (rr['assumptionsZh'] ?? []) as readonly string[]) out.push(a);
  }
  for (const row of run.rows) out.push(`${row.label}=${row.value}`);
  return out;
}

/**
 * 已确认的损坏标记（TEST 17 审计在 `decisionEngine.ts` 里逐条定位过）。
 * 它们在**任何**用户可见字符串里都不允许再出现。
 */
const DAMAGE_MARKERS: readonly string[] = [
  '。 *', '*。', '—  0', '被评。', '未参。', '代码 EV',
  '的是 再加', '不 再加', '取下注', '全。 *', '可评。', '本动。',
];

/* ============================================================
 * D-1 / D-2 —— CALL EV 的权益来源与「同源」纪律
 * ============================================================ */

test('D-1（数值口径）：CALL EV 必须由 EqVsBetRange 复算得到（残差 0）', () => {
  const run = runOf(test17Input());
  const equityForCall = run.math['heroEquityVsBetRange'] as number;
  const winnable = (run.math['pot'] as number) + (run.math['callCost'] as number);
  assert.equal(
    run.math['callEV'],
    equityForCall * winnable - (run.math['callCost'] as number),
    'CALL EV 必须精确等于「对手下注范围权益 × 可争夺量 − 跟注额」',
  );
  /* 反证：用整体范围权益复算会得到**不同**的数（这正是修复前无法复算的原因） */
  const withArrival = (run.math['heroEquity'] as number) * winnable - (run.math['callCost'] as number);
  assert.notEqual(
    withArrival,
    run.math['callEV'],
    '整体范围权益必须给出不同的结果（否则本文件的前提不成立）',
  );
});

test('D-2a（候选注记）：必须写明「对手下注范围权益」是 EV 的输入，并把整体范围权益标成「仅参考」', () => {
  const run = runOf(test17Input());
  const call = ((run.decision['diagnostics']?.['candidates'] ?? []) as readonly Record<string, any>[])
    .find((c) => c['action'] === 'CALL');
  assert.notEqual(call, undefined, '必须有 CALL 候选');
  const note = String(call!['noteZh']);
  assert.ok(note.includes('对手下注范围权益'), `候选注记必须写明 EV 的权益来源，实际：${note}`);
  assert.ok(note.includes('EqVsBetRange'), `候选注记必须写明口径标识，实际：${note}`);
  assert.ok(note.includes('仅参考'), `整体范围权益必须被标成「仅参考」，实际：${note}`);
  assert.ok(
    !note.includes('当前估计权益'),
    `不得再使用会与 EV 混读的旧措辞「当前估计权益」，实际：${note}`,
  );
  /* 注记里出现的权益百分比必须能复算出 EV（73.5% × 69 − 20 = 30.72） */
  const pct = /对手下注范围权益\s*\**\s*([0-9.]+)%/.exec(note);
  const shown = pct === null ? Number.NaN : Number(pct[1]) / 100;
  assert.ok(pct !== null, `候选注记必须给出下注范围权益的百分比，实际：${note}`);
  assert.ok(
    Math.abs(shown * ((run.math['pot'] as number) + (run.math['callCost'] as number)) - (run.math['callCost'] as number) - (run.math['callEV'] as number)) < 0.05,
    `候选注记里显示的权益必须能复算出 CALL EV（显示 ${String(pct?.[1])}%）`,
  );
});

test('D-2b（理由）：MATH_CALL_SUPPORTED 的文本、`edge`、`equitySource` 必须三者自洽', () => {
  const run = runOf(test17Input());
  const reason = ((run.decision['reasons'] ?? []) as readonly Record<string, any>[])
    .find((x) => x['code'] === 'MATH_CALL_SUPPORTED');
  assert.notEqual(reason, undefined, 'TEST 17 节点必须给出 MATH_CALL_SUPPORTED');
  const data = reason!['data'] as Record<string, any>;
  assert.equal(data['equitySource'], 'EqVsBetRange', '必须声明 EV 用的是下注范围权益');
  assert.ok(
    Math.abs((data['edge'] as number) - ((data['callEvEquity'] as number) - (run.math['requiredEquity'] as number)) * 100) < 0.05,
    `edge 必须与所声明的权益自洽（edge=${String(data['edge'])}，callEvEquity=${String(data['callEvEquity'])}）`,
  );
  /* 数据字段按 6 位小数落盘 ⇒ 用 1e-6 容差比对（数值本身来自同一份权益） */
  assert.ok(
    Math.abs((data['callEvEquity'] as number) - (run.math['heroEquityVsBetRange'] as number)) < 1e-6,
    '声明的 EV 权益必须就是 heroEquityVsBetRange',
  );
  assert.ok(
    Math.abs((data['arrivalRangeEquity'] as number) - (run.math['heroEquity'] as number)) < 1e-6,
    '整体范围权益必须作为**另一项**一并带出（可审计）',
  );
  assert.ok(String(reason!['textZh']).includes('对手下注范围权益'), '理由正文必须写出 EV 的权益来源');
  assert.ok(String(reason!['textZh']).includes('仅参考'), '理由正文必须把整体范围权益标成「仅参考」');
});

/* ============================================================
 * D-3 —— 界面行
 * ============================================================ */

test('D-3（界面）：两份权益分行、且跟注 EV 行必须写出权益输入', () => {
  const run = runOf(test17Input());
  const betRow = rowOf(run, '对手下注范围权益');
  assert.notEqual(betRow, undefined, '界面必须有「对手下注范围权益」行');
  assert.ok(betRow!.value.includes('73.51%'), `该行必须显示 73.51%（实际 ${betRow!.value}）`);
  assert.ok(betRow!.value.includes('权益输入'), '该行必须写明它是跟注 EV（与加注门槛）的输入');

  const wholeRow = rowOf(run, '整体范围权益（仅参考）');
  assert.notEqual(wholeRow, undefined, '界面必须有明确标注「仅参考」的整体范围权益行');
  assert.ok(wholeRow!.value.includes('68.22%'), `该行必须显示 68.22%（实际 ${wholeRow!.value}）`);
  assert.ok(wholeRow!.value.includes('不是'), '该行必须写明它不是跟注 EV 的输入');

  const evRow = rowOf(run, '跟注 EV（节点增量口径）');
  assert.notEqual(evRow, undefined, '界面必须有跟注 EV 行');
  assert.ok(
    evRow!.value.includes('权益输入') && evRow!.value.includes('对手下注范围权益'),
    `跟注 EV 行必须写明权益输入（实际 ${evRow!.value}）`,
  );
  assert.ok(
    !/^\s*估计权益\s*$/.test(String(rowOf(run, '估计权益')?.label ?? '')),
    '不得再存在只写「估计权益」的歧义行',
  );
});

test('D-3b（回落口径）：没有可用下注范围时，必须显式标注「回落」而不是静默复用', () => {
  const run = runOf(preflopFacingThreeBetInput());
  assert.equal(run.math['heroEquityVsBetRange'], null, '前提：该节点没有下注范围权益');
  const betRow = rowOf(run, '对手下注范围权益');
  assert.ok(betRow!.value.includes('回落'), `必须写明回落（实际 ${betRow!.value}）`);
  const evRow = rowOf(run, '跟注 EV（节点增量口径）');
  assert.ok(
    evRow!.value.includes('整体范围权益') && evRow!.value.includes('回落'),
    `跟注 EV 行必须写明用的是整体范围权益（回落口径），实际 ${evRow!.value}`,
  );
  const call = ((run.decision['diagnostics']?.['candidates'] ?? []) as readonly Record<string, any>[])
    .find((c) => c['action'] === 'CALL');
  assert.ok(
    String(call?.['noteZh']).includes('FALLBACK_WHOLE_RANGE'),
    `回落时候选注记必须写明口径标识（实际 ${String(call?.['noteZh'])}）`,
  );
});

/* ============================================================
 * D-4 —— 损坏文案
 * ============================================================ */

test('D-4（文案完整性）：全部用户可见字符串里不得再出现已确认的损坏标记', () => {
  for (const [tag, input] of [['TEST 17', test17Input()], ['翻前面对 3bet', preflopFacingThreeBetInput()]] as const) {
    const strings = userVisibleStrings(runOf(input));
    assert.ok(strings.length > 10, `${tag}：必须真的取到了用户可见字符串（实际 ${strings.length} 条）`);
    for (const s of strings) {
      for (const marker of DAMAGE_MARKERS) {
        assert.ok(
          !s.includes(marker),
          `${tag}：用户可见文案里仍有损坏标记「${marker}」⇒ ${s.slice(0, 200)}`,
        );
      }
    }
  }
});

test('D-4b（未评估动作）：RAISE/BET 的未评估说明必须是完整可读的中文，且保留原因码', () => {
  const run = runOf(test17Input());
  const unevaluated = (run.decision['diagnostics']?.['unevaluatedActions'] ?? []) as readonly Record<string, any>[];
  assert.ok(unevaluated.length > 0, 'TEST 17 节点必须有未评估的加注尺寸');
  const raise = unevaluated.find((u) => u['reasonCode'] === 'RAISE_EV_NOT_IMPLEMENTED');
  assert.notEqual(raise, undefined, '必须保留 RAISE_EV_NOT_IMPLEMENTED 原因码');
  const zh = String(raise!['reasonZh']);
  assert.ok(zh.startsWith('RAISE_EV_NOT_IMPLEMENTED：'), `原因码必须仍在文案开头，实际：${zh}`);
  assert.ok(zh.includes('未参与 EV 比较'), `必须说明该动作未参与 EV 比较，实际：${zh}`);
  assert.ok(zh.includes('不是「EV = 0」'), `必须同时说明它不是 EV = 0，实际：${zh}`);
  assert.ok(!/[\uFFFD]/.test(zh), '不得包含替换字符');
});

/* ============================================================
 * D-5 / D-6 / D-7 —— 未来街假设披露、去重、公式可复算
 * ============================================================ */

test('D-5（披露）：再加注分支必须披露摊牌终止近似、不是严格下界、4-bet 未实现', () => {
  const run = runOf(test17Input());
  const rr = run.raiseResponse!;
  const assumptions = rr['assumptionsZh'] as readonly string[];
  const all = assumptions.join('\n');
  assert.ok(all.includes('摊牌终止近似'), '必须披露该分支按摊牌终止近似计算');
  assert.ok(
    assumptions.some((x) => x.includes('未模拟') && x.includes('后续街')),
    '必须披露「未模拟后续街的下注/过牌/弃牌行动」',
  );
  assert.ok(
    assumptions.some((x) => x.includes('已枚举未来公共牌')),
    '必须说明权益本身已枚举未来公共牌（避免被读成「连牌都没发」）',
  );
  assert.ok(
    assumptions.some((x) => x.includes('不是') && x.includes('严格')),
    '必须限定：所谓下界不是对真实牌局 EV 的严格下界',
  );
  assert.ok(all.includes('4-bet'), '必须单独说明 4-bet 未实现');
  assert.ok(
    String(rr['noteZh']).includes('摊牌终止近似'),
    '事实包自身的 noteZh 也必须带该限定（不只 assumptionsZh）',
  );
});

test('D-6（去重）：assumptionsZh 不得有重复条目', () => {
  const run = runOf(test17Input());
  const assumptions = run.raiseResponse!['assumptionsZh'] as readonly string[];
  assert.equal(
    new Set(assumptions).size,
    assumptions.length,
    `假设清单不得重复（实际 ${assumptions.length} 条 / 去重后 ${new Set(assumptions).size} 条）`,
  );
  for (const a of assumptions) {
    assert.ok(a.trim().length > 8, `条目不得为空壳：${JSON.stringify(a)}`);
    assert.ok(!/[ \t]{2,}$/.test(a), `条目不得以多余空白结尾：${JSON.stringify(a)}`);
  }
});

test('D-7（公式可复算）：打印出来的 RAISE EV 公式必须用打印出来的操作数复算出打印出来的 EV', () => {
  const run = runOf(test17Input());
  const rr = run.raiseResponse!;
  const note = String(rr['noteZh']);
  const f = rr['foldLikelihood'] as number;
  const c = rr['callLikelihood'] as number;
  const rrl = rr['reRaiseLikelihood'] as number;
  const eqCall = rr['heroEquityVsRaiseCallRange'] as number;
  const branchEV = rr['reraiseBranchEV'] as number;
  const recomputed =
    f * (rr['currentPot'] as number) +
    c * (eqCall * (rr['finalPot'] as number) - (rr['heroContestedAdd'] as number)) +
    rrl * branchEV;
  assert.equal(
    recomputed,
    rr['raiseEV'] as number,
    '用「弃/跟/再加注」三支与**实际分支值**必须复算出 raiseEV（残差 0）',
  );
  /* 公式字符串必须使用实际分支值，而不是写死的下界 */
  assert.ok(
    note.includes(`×(${branchEV.toFixed(4)}`),
    `noteZh 的公式必须打印实际参与计算的分支值 ${branchEV.toFixed(4)}，实际：${note}`,
  );
  assert.ok(note.includes('摊牌终止近似'), 'noteZh 必须限定该分支是摊牌终止近似');
});

/* ============================================================
 * D-8 —— 验收数值（不因展示修复而变化）
 * ============================================================ */

test('D-8（数值回归）：TEST 17 的 CALL EV / RAISE EV / P1-2b 两分支必须逐位不变', () => {
  const run = runOf(test17Input());
  assert.equal(run.math['callEV'], 30.719693642502683, 'CALL EV 必须逐位不变');
  const rr = run.raiseResponse!;
  assert.equal(rr['sizeChips'], 80, '被评估的加注尺寸必须是 80');
  assert.equal(rr['raiseEV'], 36.75849453937832, 'RAISE EV 必须逐位不变');
  assert.equal(rr['reraiseFoldBranchEV'], -80, 'P1-2b 弃牌分支必须仍是 −80');
  assert.equal(rr['reraiseCallBranchEV'], -67.732181090706945, 'P1-2b 跟注分支必须逐位不变');
  assert.equal(rr['reraiseBranchKind'], 'CALL', '分支必须仍取 CALL');
  assert.equal(String(run.decision['action']), 'RAISE', '最终动作不得因展示修复改变');
  assert.equal(run.decision['sizeChips'], 80, '最终尺寸不得因展示修复改变');
});
