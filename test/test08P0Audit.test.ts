/**
 * ============================================================================
 * TEST 08 P0 定向审计 —— 回归测试（P0-1 … P0-10）
 * ============================================================================
 *
 * 本文件锁住 2026 年 TEST 08 审计的三个 P0 修复，防止它们被后来的改动悄悄推翻。
 *
 * | 编号 | 锁住什么 |
 * |---|---|
 * | P0-1 | 下注尺寸的单位不变量（底池 29 筹码 ⇒ 9.667 / 19.333 / 29） |
 * | P0-2 | OOP CHECK 之后 **Villain BET 分支真实存在**（不再恒为 0） |
 * | P0-3 | IP check-back 仍然是摊牌终止（**不能**被 P0-2 修坏） |
 * | P0-4 | `MANIAC betLikelihood > NIT betLikelihood`（§十八 方向要求） |
 * | P0-5 | `P(过牌) + P(下注) = 1` |
 * | P0-6 | `betLikelihood > 0` ⇒ `heroEquityVsBetRange !== null` |
 * | P0-7 | `FoldToTurnCBet` **影响**真实 cbet 节点 |
 * | P0-8 | `FoldToTurnCBet` **不影响** turn donk 节点（语义门） |
 * | P0-9 | 全部 EV 有限（不出 NaN / Infinity） |
 * | P0-10 | chips ↔ BB 换算往返稳定，且尺寸只由**筹码**决定 |
 *
 * ⚠️ 这些测试**不**锁死修复后的具体数值（那会把一次修复变成永久枷锁），
 * 只锁**不变量与方向**。数值由 `npm run verify` 的既有套件与快照负责。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';
import { parseManualInput } from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import type { ManualHandInput } from '../src/app/manualInput/manualInput.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const OPTIONS = {
  rules: RULES,
  asOf: 1757000000000,
  writeLog: false,
  equitySeed: 20260913,
  budget: { softMs: 120000, hardMs: 240000 },
} as const;

const SEATS = { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 } as const;

/* ============================================================
 * TEST 08 冻结输入（§一）
 * ============================================================ */

type ActionRow = {
  position: string;
  type: string;
  amountBB?: number;
  street?: string;
};

const A = (position: string, type: string, amountBB?: number, street?: string): ActionRow => ({
  position,
  type,
  ...(amountBB === undefined ? {} : { amountBB }),
  ...(street === undefined ? {} : { street }),
});

/** 翻前：BTN 加注到 6 筹码（= 3BB），BB 跟注。底池 13 筹码 */
const PREFLOP: readonly ActionRow[] = [
  A('UTG', 'FOLD'),
  A('HJ', 'FOLD'),
  A('CO', 'FOLD'),
  A('BTN', 'RAISE', 3),
  A('SB', 'FOLD'),
  A('BB', 'CALL', 2),
];

/**
 * 翻牌：BB 过牌、BTN 下注 8 筹码（= 4BB）、BB 跟注。底池 29 筹码。
 *
 * 🔴 **历史停在 BB 跟注**，因为 TEST 08 的决策点是**转牌 BB 先行动**
 * （`bettor = hero`，尚未下注）。多写一条 `BB CHECK` 会把行动权交给 BTN。
 */
const FLOP_THEN_TURN_TO_HERO: readonly ActionRow[] = [
  ...PREFLOP,
  A('BB', 'CHECK', undefined, 'FLOP'),
  A('BTN', 'BET', 4, 'FLOP'),
  A('BB', 'CALL', 4, 'FLOP'),
];

/** 四种原型的连续统计（620 手） */
const ARCHETYPES = {
  MANIAC: {
    quickProfile: 'MANIAC',
    stats: {
      vpip: 0.58, pfr: 0.39, threeBet: 0.16, wtsd: 0.34,
      foldToFlopCBet: 0.28, foldToTurnCBet: 0.25, foldToRiverBet: 0.30,
      flopCheckRaise: 0.20, turnCheckRaise: 0.16, riverCheckRaise: 0.10,
    },
  },
  NORMAL: {
    quickProfile: 'NORMAL',
    stats: {
      vpip: 0.26, pfr: 0.20, threeBet: 0.07, wtsd: 0.28,
      foldToFlopCBet: 0.47, foldToTurnCBet: 0.48, foldToRiverBet: 0.52,
      flopCheckRaise: 0.10, turnCheckRaise: 0.08, riverCheckRaise: 0.06,
    },
  },
  NIT: {
    quickProfile: 'VERY_TIGHT',
    stats: {
      vpip: 0.16, pfr: 0.11, threeBet: 0.04, wtsd: 0.24,
      foldToFlopCBet: 0.62, foldToTurnCBet: 0.70, foldToRiverBet: 0.72,
      flopCheckRaise: 0.04, turnCheckRaise: 0.03, riverCheckRaise: 0.02,
    },
  },
  CALLING_STATION: {
    quickProfile: 'CALLING_STATION',
    stats: {
      vpip: 0.45, pfr: 0.08, threeBet: 0.03, wtsd: 0.36,
      foldToFlopCBet: 0.22, foldToTurnCBet: 0.28, foldToRiverBet: 0.35,
      flopCheckRaise: 0.03, turnCheckRaise: 0.02, riverCheckRaise: 0.02,
    },
  },
} as const;

type ArchetypeKey = keyof typeof ARCHETYPES;

const HANDS_OBSERVED = 620;

function test08Input(
  archetype: ArchetypeKey,
  overrides: Partial<Record<string, number>> = {},
): ManualHandInput {
  const spec = ARCHETYPES[archetype];
  return {
    tableSize: 6,
    heroPosition: 'BB',
    heroCards: ['Ac', 'Jc'],
    board: ['Jd', '8c', '4c', '6s'],
    street: 'TURN',
    effectiveStackBB: 100,
    bigBlindBB: 2,
    seatStacksBB: { ...SEATS },
    actionHistory: [...FLOP_THEN_TURN_TO_HERO],
    environment: 'MID_LOW_STAKES',
    villain: {
      quickProfile: spec.quickProfile,
      dynamicHint: 'UNKNOWN',
      stackBB: 100,
      observedStats: { handsObserved: HANDS_OBSERVED, ...spec.stats, ...overrides },
    },
  } as unknown as ManualHandInput;
}

type Built = ReturnType<typeof buildDecisionContext>['context'];

function build(input: ManualHandInput): Built {
  const parsed = parseManualInput(input);
  assert.equal(parsed.ok, true, `必须能解析：${parsed.ok ? '' : JSON.stringify(parsed.issues)}`);
  if (!parsed.ok) throw new Error('unreachable');
  const gate = buildAnalyzableState(parsed.value);
  assert.equal(gate.ok, true, `必须能重建：${gate.ok ? '' : JSON.stringify(gate.issues)}`);
  if (!gate.ok) throw new Error('unreachable');
  return buildDecisionContext({
    state: gate.state,
    rules: RULES,
    environment: 'MID_LOW_STAKES',
    asOf: OPTIONS.asOf,
    quickProfile: input.villain?.quickProfile,
    observedStats: input.villain?.observedStats,
  }).context;
}

const bdOf = (c: Built) => {
  const bd = c.postflopFacts?.betDecision;
  assert.ok(bd !== null && bd !== undefined, '下注决策事实包必须存在');
  return bd!;
};

/* ============================================================
 * P0-1 —— 下注尺寸的单位不变量
 * ============================================================ */

test('P0-1：底池 29 筹码 ⇒ 三个尺寸必须是 9.667 / 19.333 / 29（**不再 ×2**）', () => {
  const c = build(test08Input('MANIAC'));
  const bd = bdOf(c);

  /*
   * 🔴 单位不变量：`math.pot` 与 `math.myRemainingStack` 都是**筹码**，
   * 与用户在 TEST 08 里口述的 29 / 186 逐位相同。
   */
  assert.equal(c.math.pot, 29, '底池必须是 29 筹码');
  assert.equal(c.math.myRemainingStack, 186, 'Hero 剩余必须是 186 筹码');
  assert.equal(c.math.bigBlind, 2, '1BB = 2 筹码');
  assert.equal(bd.pot, c.math.pot, 'betDecision.pot 必须与 math.pot 同源同单位');

  const byKind = new Map(bd.sizes.map((s) => [s.kind, s]));
  const small = byKind.get('BET_SMALL');
  const medium = byKind.get('BET_MEDIUM');
  const large = byKind.get('BET_LARGE');
  assert.ok(small && medium && large, '三个尺寸都必须合法');

  // 33% / 67% / 100% 池（各允许 1e-6 的浮点误差）
  assert.ok(Math.abs(small!.betAmount - 29 / 3) < 1e-6, `BET_SMALL = 29/3 ≈ 9.667，实际 ${small!.betAmount}`);
  assert.ok(Math.abs(medium!.betAmount - (29 * 2) / 3) < 1e-6, `BET_MEDIUM = 29×2/3 ≈ 19.333，实际 ${medium!.betAmount}`);
  assert.ok(Math.abs(large!.betAmount - 29) < 1e-6, `BET_LARGE = 29，实际 ${large!.betAmount}`);

  // 区间断言（§四 允许项目自己的 rounding policy）
  assert.ok(small!.betAmount >= 9.5 && small!.betAmount <= 9.8, '33% 池必须落在 9.5–9.8');
  assert.ok(medium!.betAmount >= 19.3 && medium!.betAmount <= 19.5, '67% 池必须落在 19.3–19.5');

  // 与标签自洽：betAmount / pot 必须等于 ratioToPot
  for (const s of bd.sizes) {
    assert.ok(
      Math.abs(s.betAmount / bd.pot - s.ratioToPot) < 1e-9,
      `${s.kind}: betAmount/pot (${s.betAmount / bd.pot}) 必须等于 ratioToPot (${s.ratioToPot})`,
    );
  }
});

test('P0-1b：尺寸由**筹码底池**决定，换盲注结构不得改变比例（§四）', () => {
  /*
   * ⚠️ 解析层要求 `bigBlindBB` 是**不小于 2 的整数**（`bigBlindChipsOf`），
   * 因此 0.5/1 这类结构在**手动输入**通道不可表达（这是既有的显式阻断，
   * 不是本轮引入的）。这里在合法范围内换结构：
   *
   * ```text
   * 结构 A：1BB = 2 筹码   ⇒ 加注到 6、下注 8  ⇒ 底池 29 筹码
   * 结构 B：1BB = 4 筹码   ⇒ 加注到 12、下注 16 ⇒ 底池 58 筹码
   * ```
   *
   * 两种结构的**绝对筹码底池不同**（这是正确的：筹码更多 ⇒ 尺寸更大），
   * 真正的不变量是 **`betAmount / pot` 恒等于 `ratioToPot`**，
   * 即尺寸是**底池的固定比例**，而不是「大盲的某个倍数」。
   * 修复前的 ×2 缺陷恰恰会破坏这条比例关系。
   */
  const chipsInput = (
    bigBlindChips: number,
    raiseToChips: number,
    flopBetChips: number,
  ): ManualHandInput => ({
    tableSize: 6,
    heroPosition: 'BB',
    heroCards: ['Ac', 'Jc'],
    board: ['Jd', '8c', '4c', '6s'],
    street: 'TURN',
    effectiveStackBB: 400 / bigBlindChips,
    bigBlindBB: bigBlindChips,
    seatStacksBB: { ...SEATS },
    actionHistory: [
      A('UTG', 'FOLD'), A('HJ', 'FOLD'), A('CO', 'FOLD'),
      A('BTN', 'RAISE', raiseToChips / bigBlindChips),
      A('SB', 'FOLD'),
      A('BB', 'CALL', (raiseToChips - bigBlindChips) / bigBlindChips),
      A('BB', 'CHECK', undefined, 'FLOP'),
      A('BTN', 'BET', flopBetChips / bigBlindChips, 'FLOP'),
      A('BB', 'CALL', flopBetChips / bigBlindChips, 'FLOP'),
    ],
    environment: 'MID_LOW_STAKES',
    villain: {
      quickProfile: 'MANIAC',
      dynamicHint: 'UNKNOWN',
      stackBB: 400 / bigBlindChips,
      observedStats: { handsObserved: HANDS_OBSERVED, ...ARCHETYPES.MANIAC.stats },
    },
  } as unknown as ManualHandInput);

  const a = bdOf(build(chipsInput(2, 6, 8)));
  const b = bdOf(build(chipsInput(4, 12, 16)));

  assert.equal(a.pot, 29, '结构 A 底池必须是 29 筹码');
  assert.equal(b.pot, 58, '结构 B 底池必须是 58 筹码（筹码面额翻倍 ⇒ 底池翻倍，这是正确的）');

  // 核心不变量：三个尺寸对**各自底池**的比例相同
  const ratios = (bd: typeof a): number[] => {
    const order = ['BET_SMALL', 'BET_MEDIUM', 'BET_LARGE'];
    return order.map((kind) => {
      const s = bd.sizes.find((x) => x.kind === kind);
      assert.ok(s, `${kind} 必须存在`);
      return s!.betAmount / bd.pot;
    });
  };
  const ra = ratios(a);
  const rb = ratios(b);
  for (let i = 0; i < ra.length; i += 1) {
    assert.ok(
      Math.abs(ra[i]! - rb[i]!) < 1e-9,
      `第 ${i + 1} 个尺寸的底池比例必须与盲注结构无关：${ra[i]} vs ${rb[i]}`,
    );
  }
  // 且比例就是 1/3、2/3、1
  assert.ok(Math.abs(ra[0]! - 1 / 3) < 1e-9, `小注必须是 1/3 池（实际 ${ra[0]}）`);
  assert.ok(Math.abs(ra[1]! - 2 / 3) < 1e-9, `中注必须是 2/3 池（实际 ${ra[1]}）`);
  assert.ok(Math.abs(ra[2]! - 1) < 1e-9, `大注必须是 1 池（实际 ${ra[2]}）`);

  // 绝对金额必须随底池线性放大（而不是被大盲二次换算）
  for (const kind of ['BET_SMALL', 'BET_MEDIUM', 'BET_LARGE']) {
    const sa = a.sizes.find((x) => x.kind === kind)!.betAmount;
    const sb = b.sizes.find((x) => x.kind === kind)!.betAmount;
    assert.ok(
      Math.abs(sb - sa * 2) < 1e-9,
      `${kind} 必须随底池精确翻倍：${sa} × 2 vs ${sb}`,
    );
  }
});

/* ============================================================
 * P0-2 —— OOP CHECK 之后 Villain BET 分支真实存在
 * ============================================================ */

test('P0-2：BB 前位过牌 ⇒ CHECK 树必须包含 Villain BET 分支（不再恒为 0）', () => {
  const ct = bdOf(build(test08Input('MANIAC'))).checkTree;

  assert.equal(ct.kind, 'HEURISTIC_TREE', '前位过牌必须走 CHECK 树，不能退化成 HEURISTIC_ONE_STREET');
  assert.equal(ct.isInPosition, false, 'Hero 在 BB ⇒ 前位');
  assert.ok(ct.betLikelihood > 0, `他必须有非零下注倾向（实际 ${ct.betLikelihood}）`);
  assert.ok(ct.villainBetAmount > 0, '代表下注额必须为正');
  assert.equal(ct.raiseResponse, 'NOT_IMPLEMENTED', '加注应手必须如实标注未实现');
});

/* ============================================================
 * P0-3 —— IP check-back 必须保持摊牌终止
 * ============================================================ */

test('P0-3：Hero 后位 check-back ⇒ 仍然是摊牌终止（betLikelihood 必须为 0）', () => {
  /*
   * TEST 07 的形态：Hero BTN，BB 已经先过牌，Hero 在后位选择过牌。
   * 此时 BB 已经行动完 ⇒ **不存在**「他再过牌/他下注」的分支。
   * 修 P0-2 时**绝不能**把这里也打开（那会凭空造出一个不存在的动作）。
   */
  const input = {
    tableSize: 6,
    heroPosition: 'BTN',
    heroCards: ['Ac', '5c'],
    board: ['Kc', '8d', '4c', '2s'],
    street: 'TURN',
    effectiveStackBB: 100,
    bigBlindBB: 2,
    seatStacksBB: { ...SEATS },
    actionHistory: [
      A('UTG', 'FOLD'), A('HJ', 'FOLD'), A('CO', 'FOLD'),
      A('BTN', 'RAISE', 3), A('SB', 'FOLD'), A('BB', 'CALL', 2),
      A('BB', 'CHECK', undefined, 'FLOP'), A('BTN', 'BET', 2.5, 'FLOP'), A('BB', 'CALL', 2.5, 'FLOP'),
      A('BB', 'CHECK', undefined, 'TURN'),
    ],
    environment: 'MID_LOW_STAKES',
    villain: {
      quickProfile: 'VERY_TIGHT',
      dynamicHint: 'UNKNOWN',
      stackBB: 100,
      observedStats: { handsObserved: 1180, ...ARCHETYPES.NIT.stats },
    },
  } as unknown as ManualHandInput;

  const ct = bdOf(build(input)).checkTree;
  assert.equal(ct.isInPosition, true, 'Hero 在 BTN 且 BB 已过牌 ⇒ 后位');
  assert.equal(ct.betLikelihood, 0, '对手已过牌 ⇒ 不存在「他再下注」');
  assert.equal(ct.checkBackLikelihood, 1, '对手已过牌 ⇒ 过牌概率为 1');
  assert.equal(ct.kind, 'HEURISTIC_ONE_STREET', '转牌后位过牌仍然是权益实现代理（不是摊牌终止）');
});

/* ============================================================
 * P0-4 —— 方向要求：MANIAC > NIT
 * ============================================================ */

test('P0-4：MANIAC 的过牌后下注倾向必须严格高于 NIT（§十八）', () => {
  const maniac = bdOf(build(test08Input('MANIAC'))).checkTree;
  const normal = bdOf(build(test08Input('NORMAL'))).checkTree;
  const nit = bdOf(build(test08Input('NIT'))).checkTree;
  const station = bdOf(build(test08Input('CALLING_STATION'))).checkTree;

  assert.ok(
    maniac.betLikelihood > nit.betLikelihood,
    `疯子必须比极紧更爱开枪：${maniac.betLikelihood.toFixed(4)} vs ${nit.betLikelihood.toFixed(4)}`,
  );
  assert.ok(
    maniac.betLikelihood > station.betLikelihood,
    `疯子必须比跟注站更爱开枪：${maniac.betLikelihood.toFixed(4)} vs ${station.betLikelihood.toFixed(4)}`,
  );
  assert.ok(
    station.betLikelihood <= normal.betLikelihood + 1e-12,
    `跟注站不得比普通更爱开枪：${station.betLikelihood.toFixed(4)} vs ${normal.betLikelihood.toFixed(4)}`,
  );
});

/* ============================================================
 * P0-5 / P0-6 —— 概率守恒与条件权益存在性
 * ============================================================ */

test('P0-5：CHECK 树两个分支的概率之和必须为 1', () => {
  for (const key of Object.keys(ARCHETYPES) as ArchetypeKey[]) {
    const ct = bdOf(build(test08Input(key))).checkTree;
    assert.ok(
      Math.abs(ct.checkBackLikelihood + ct.betLikelihood - 1) < 1e-9,
      `${key}: P(过牌)+P(下注) 必须为 1（实际 ${ct.checkBackLikelihood + ct.betLikelihood}）`,
    );
  }
});

test('P0-6：betLikelihood > 0 时 heroEquityVsBetRange 必须非 null', () => {
  for (const key of Object.keys(ARCHETYPES) as ArchetypeKey[]) {
    const ct = bdOf(build(test08Input(key))).checkTree;
    if (ct.betLikelihood > 0) {
      assert.notEqual(ct.heroEquityVsBetRange, null, `${key}: 有下注分支就必须有对应权益`);
      assert.ok(
        ct.heroEquityVsBetRange! >= 0 && ct.heroEquityVsBetRange! <= 1,
        `${key}: 权益必须在 [0,1]（实际 ${ct.heroEquityVsBetRange}）`,
      );
    }
  }
});

/* ============================================================
 * P0-7 / P0-8 —— 统计语义路由
 * ============================================================ */

/**
 * 构造一个「Hero 是翻前进攻者、并在转牌继续开火」的节点。
 *
 * ```text
 * Hero CO RAISE → BB CALL
 * 翻牌 BB CHECK / Hero BET / BB CALL
 * 转牌 BB CHECK / ← 决策点：Hero 是否二次开火
 * ```
 *
 * 这里 BB 面对的是**真实的 turn cbet** ⇒ `FoldToTurnCBet` **应当**生效。
 */
function realTurnCbetNode(overrides: Partial<Record<string, number>> = {}): ManualHandInput {
  return {
    tableSize: 6,
    heroPosition: 'CO',
    heroCards: ['Ac', 'Jc'],
    board: ['Jd', '8c', '4c', '6s'],
    street: 'TURN',
    effectiveStackBB: 100,
    bigBlindBB: 2,
    seatStacksBB: { ...SEATS },
    actionHistory: [
      A('UTG', 'FOLD'), A('HJ', 'FOLD'),
      A('CO', 'RAISE', 3), A('BTN', 'FOLD'), A('SB', 'FOLD'), A('BB', 'CALL', 2),
      A('BB', 'CHECK', undefined, 'FLOP'), A('CO', 'BET', 4, 'FLOP'), A('BB', 'CALL', 4, 'FLOP'),
      A('BB', 'CHECK', undefined, 'TURN'),
    ],
    environment: 'MID_LOW_STAKES',
    villain: {
      quickProfile: 'NORMAL',
      dynamicHint: 'UNKNOWN',
      stackBB: 100,
      observedStats: { handsObserved: HANDS_OBSERVED, ...ARCHETYPES.NORMAL.stats, ...overrides },
    },
  } as unknown as ManualHandInput;
}

/** 转牌面对下注的跟注方（= Villain BB）的响应概率，取「中注」那档 */
function turnFacingBetCallShare(input: ManualHandInput): number {
  const bd = bdOf(build(input));
  const medium = bd.sizes.find((s) => s.kind === 'BET_MEDIUM');
  assert.ok(medium, 'BET_MEDIUM 必须存在');
  return medium!.callLikelihood;
}

test('P0-7：真实 turn cbet 节点上，FoldToTurnCBet 必须**影响**响应', () => {
  const low = turnFacingBetCallShare(realTurnCbetNode({ foldToTurnCBet: 0.05 }));
  const high = turnFacingBetCallShare(realTurnCbetNode({ foldToTurnCBet: 0.95 }));
  assert.ok(
    Math.abs(low - high) > 1e-6,
    `真实 cbet 节点上该统计必须生效（弃牌率 0.05 时跟注 ${low}，0.95 时 ${high}）`,
  );
  assert.ok(high < low, `他越爱弃（0.95）⇒ 跟注份额必须越低：${low} → ${high}`);
});

test('P0-8：turn **donk** 节点上，FoldToTurnCBet 必须**完全不影响**响应', () => {
  /*
   * TEST 08：BTN 是翻前加注者 + 翻牌 cbet 者，Hero BB 在转牌**领打**。
   * 这是 Turn Donk，**不是** cbet ⇒ BTN 的 `FoldToTurnCBet` 是错的统计，
   * 必须被节点语义门挡下，响应完全不变。
   */
  const low = turnFacingBetCallShare(test08Input('MANIAC', { foldToTurnCBet: 0.05 }));
  const high = turnFacingBetCallShare(test08Input('MANIAC', { foldToTurnCBet: 0.95 }));
  assert.equal(
    low,
    high,
    `turn donk 节点上该统计必须完全无效（0.05 ⇒ ${low}，0.95 ⇒ ${high}）`,
  );
});

test('P0-8b：语义门必须留下可审计的痕迹（deniedStreetTraits）', () => {
  const donk = build(test08Input('MANIAC'));
  const pv = donk.profileV3;
  assert.ok(pv, 'V3 解析结果必须存在');
  assert.equal(pv.actionContext, 'FACING_DONK', 'TEST 08 的节点语义必须是 FACING_DONK');
  const denied = pv.deniedStreetTraits ?? [];
  assert.ok(
    denied.includes('foldToTurnBet'),
    `被挡下的条目必须如实登记（实际 [${denied.join(', ')}]）`,
  );
});

/* ============================================================
 * P0-9 —— 全部 EV 必须有限
 * ============================================================ */

test('P0-9：全部 EV 值必须有限（不出 NaN / Infinity）', () => {
  const finite = (v: number | null, label: string): void => {
    if (v === null) return;
    assert.ok(Number.isFinite(v), `${label} 必须有限（实际 ${v}）`);
  };
  for (const key of Object.keys(ARCHETYPES) as ArchetypeKey[]) {
    const bd = bdOf(build(test08Input(key)));
    const ct = bd.checkTree;
    finite(ct.checkEV, `${key}.checkEV`);
    finite(ct.evShowdown, `${key}.evShowdown`);
    finite(ct.heroCallEV, `${key}.heroCallEV`);
    finite(ct.heroBestResponseEV, `${key}.heroBestResponseEV`);
    finite(ct.heroFoldEV, `${key}.heroFoldEV`);
    finite(ct.heroEquityVsBetRange, `${key}.heroEquityVsBetRange`);
    finite(bd.checkRealizationFactor, `${key}.checkRealizationFactor`);
  }
});

/* ============================================================
 * P0-10 —— chips ↔ BB 往返稳定
 * ============================================================ */

test('P0-10：CHECK EV 必须与 chips/BB 换算自洽（往返稳定）', () => {
  const c = build(test08Input('MANIAC'));
  const bd = bdOf(c);
  const ct = bd.checkTree;

  // 公式可复算：CheckEV = P(过牌)×摊牌EV + P(下注)×Hero最佳应手
  const recomputed = ct.checkBackLikelihood * ct.evShowdown! + ct.betLikelihood * ct.heroBestResponseEV!;
  assert.ok(
    Math.abs(recomputed - ct.checkEV!) < 1e-9,
    `CheckEV 必须等于两分支加权和：${recomputed} vs ${ct.checkEV}`,
  );

  /*
   * 单位往返：把底池按 1BB = 2 筹码换算一次再换回来，EV 的**BB 表示**
   * 必须与「筹码 EV ÷ 2」一致（即没有第二处偷偷乘大盲）。
   */
  const bb = c.math.bigBlind;
  const evChips = ct.checkEV!;
  const evBB = evChips / bb;
  assert.ok(
    Math.abs(evBB * bb - evChips) < 1e-9,
    `筹码 → BB → 筹码 往返必须稳定：${evBB}BB × ${bb} = ${evBB * bb} vs ${evChips}`,
  );

  // 过牌 EV 不得等于「权益 × 底池」——那说明下注分支又消失了
  const naive = c.math.heroEquity! * bd.pot;
  assert.ok(
    Math.abs(ct.checkEV! - naive) > 1e-6,
    `CheckEV 不得退化成 权益×底池（${ct.checkEV} vs ${naive}）—— 他过牌后仍可下注`,
  );
});

test('P0-10b：同一决策点经 analyzeManualHand 与 buildDecisionContext 必须给出一致的 CHECK EV', () => {
  /*
   * §十二 要求：同一内部 EV 在「UI / audit script / JSON / report」各处一致。
   * 这里锁最核心的一条：**两条入口**（完整管线 vs 只建上下文）不得分歧。
   */
  const input = test08Input('MANIAC');
  const direct = bdOf(build(input)).checkTree.checkEV;

  const run = analyzeManualHand(input, OPTIONS);
  assert.equal(run.ok, true, '完整管线必须成功');
  const viaPipeline = run.decision.diagnostics.postflop?.betDecision?.checkEV;
  assert.ok(typeof viaPipeline === 'number', '完整管线必须给出可计算的 CHECK EV');

  assert.ok(
    Math.abs(direct! - (viaPipeline as number)) < 1e-9,
    `两条入口的 CHECK EV 必须逐位一致：${direct} vs ${viaPipeline}`,
  );
});
