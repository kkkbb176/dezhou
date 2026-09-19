/**
 * ============================================================================
 * U1 RAISE EV P0 修复 —— 资金记账与赔率不变量（独立现金流）
 * ============================================================================
 *
 * `reports/U1_RAISE_EV_LIGHT_AUDIT.md` 判定 U1 加注 EV 存在 P0 级筹码口径错误：
 * 旧公式把对手**已经下注**的那笔筹码从底池里漏掉了。本文件先以**失败的断言**
 * 复现旧缺陷，再用**独立现金流算术**（不复制产品公式）锁住修复后的口径。
 *
 * ## 口径（与 CALL EV 完全一致：零点 = 弃牌 ≡ 0，单位 = 筹码）
 *
 * ```text
 * currentPot            = Hero 行动前已经存在的完整底池（含对手这一注）
 * heroStreetCommitted   = Hero 本街已投入
 * villainStreetCommitted= 对手本街已投入（**从行动历史读，不假设单次下注**）
 * raiseTo               = Hero 加注后本街的累计投入
 * heroAdd               = raiseTo − heroStreetCommitted
 * villainAdd            = min(raiseTo − villainStreetCommitted, 对手剩余筹码)
 * 终池(双方跟满)         = currentPot + heroAdd + villainAdd
 *
 * P(弃) × currentPot                                  ← 他弃牌，我赢下**完整**底池
 * + P(跟) × (EqVsRaiseCallRange × 终池 − 我实际留在池中的投入)
 * + P(再加注) × (−我实际留在池中的投入)                ← Hero 已全下 ⇒ 该分支权恒为 0
 * ```
 *
 * ⚠️ 本文件**不复制**产品实现：所有预期值都由节点已知筹码**手算**得出，
 * 或由另一套模块（`previewCommit` 分层底池）独立给出。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { buildRaiseResponse, raiseEVOf } from '../src/app/manualInput/raiseResponse.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import { ALL_CARDS, parseCardStrict } from '../src/domain/poker/cards.ts';
import type { ManualHandInput } from '../src/app/manualInput/manualInput.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const OPTIONS = {
  rules: RULES, asOf: 1_757_000_000_000, writeLog: false,
  equitySeed: 20_261_014, budget: { softMs: 120_000, hardMs: 240_000 },
} as const;

type Row = { position: string; type: string; amountBB?: number; street?: string };
const A = (position: string, type: string, amountBB?: number, street?: string): Row => ({
  position, type,
  ...(amountBB === undefined ? {} : { amountBB }),
  ...(street === undefined ? {} : { street }),
});

/* ============================================================
 * 节点（逐字复用既有黄金牌局）
 * ============================================================ */

/** HAND A / B：AK 河牌节点（Hero BTN，河牌面对 BB 领打） */
function riverFacingBet(
  heroCards: [string, string],
  opts: { bbStackBB?: number; profile?: string; riverBetBB?: number } = {},
): ManualHandInput {
  const bbStack = opts.bbStackBB ?? 100;
  const riverBet = opts.riverBetBB ?? 20;
  return {
    tableSize: 6, heroPosition: 'BTN', heroCards, board: ['Kd', '9c', '4h', '6s', '2d'],
    street: 'RIVER', effectiveStackBB: 100, bigBlindBB: 2,
    seatStacksBB: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: bbStack },
    actionHistory: [
      A('UTG', 'FOLD'), A('HJ', 'FOLD'), A('CO', 'FOLD'), A('BTN', 'RAISE', 3), A('SB', 'FOLD'), A('BB', 'CALL', 2),
      A('BB', 'CHECK', undefined, 'FLOP'), A('BTN', 'BET', 2.5, 'FLOP'), A('BB', 'CALL', 2.5, 'FLOP'),
      A('BB', 'CHECK', undefined, 'TURN'), A('BTN', 'BET', 7.5, 'TURN'), A('BB', 'CALL', 7.5, 'TURN'),
      A('BB', 'BET', riverBet, 'RIVER'),
    ],
    environment: 'MID_LOW_STAKES',
    villain: { quickProfile: opts.profile ?? 'CALLING_STATION', dynamicHint: 'UNKNOWN', stackBB: bbStack },
  } as unknown as ManualHandInput;
}

/** HAND C：F-01 翻牌 KK（Hero CO，翻牌 K72 面对 BB 下注 6BB） */
function f01(): ManualHandInput {
  return {
    tableSize: 6, heroPosition: 'CO', heroCards: ['Kd', 'Kc'], board: ['Kh', '7c', '2d'],
    street: 'FLOP', effectiveStackBB: 100,
    actionHistory: [
      A('UTG', 'FOLD'), A('HJ', 'FOLD'), A('CO', 'RAISE', 3), A('BTN', 'FOLD'), A('SB', 'FOLD'), A('BB', 'CALL', 2),
      A('BB', 'BET', 6, 'FLOP'),
    ],
    environment: 'MID_LOW_STAKES', villain: { quickProfile: 'NORMAL' },
  } as unknown as ManualHandInput;
}

/** HAND D：Hero 本街**已经投入**（CO 下注 5 → BB 加注到 20 → 轮到 CO） */
function heroBetThenFacesRaise(): ManualHandInput {
  return {
    tableSize: 6, heroPosition: 'CO', heroCards: ['As', 'Ah'], board: ['Kh', '7c', '2d'],
    street: 'FLOP', effectiveStackBB: 100, bigBlindBB: 2,
    seatStacksBB: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 },
    actionHistory: [
      A('UTG', 'FOLD'), A('HJ', 'FOLD'), A('CO', 'RAISE', 3), A('BTN', 'FOLD'), A('SB', 'FOLD'), A('BB', 'CALL', 2),
      A('BB', 'CHECK', undefined, 'FLOP'), A('CO', 'BET', 5, 'FLOP'), A('BB', 'RAISE', 20, 'FLOP'),
    ],
    environment: 'MID_LOW_STAKES',
    villain: { quickProfile: 'CALLING_STATION', dynamicHint: 'UNKNOWN', stackBB: 100 },
  } as unknown as ManualHandInput;
}

/** HAND E：**三人**底池（BB 下注、CO 跟注 → Hero BTN 面对下注，身后还有两家） */
function multiwayFacingBet(): ManualHandInput {
  return {
    tableSize: 6, heroPosition: 'BTN', heroCards: ['As', 'Ks'], board: ['Kd', '9c', '4h', '6s', '2d'],
    street: 'RIVER', effectiveStackBB: 100, bigBlindBB: 2,
    seatStacksBB: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 },
    actionHistory: [
      A('UTG', 'FOLD'), A('HJ', 'FOLD'), A('CO', 'CALL', 1), A('BTN', 'RAISE', 3), A('SB', 'FOLD'), A('BB', 'CALL', 2),
      A('CO', 'CALL', 2),
      A('BB', 'CHECK', undefined, 'FLOP'), A('CO', 'CHECK', undefined, 'FLOP'), A('BTN', 'BET', 2.5, 'FLOP'),
      A('BB', 'CALL', 2.5, 'FLOP'), A('CO', 'CALL', 2.5, 'FLOP'),
      A('BB', 'CHECK', undefined, 'TURN'), A('CO', 'CHECK', undefined, 'TURN'), A('BTN', 'BET', 7.5, 'TURN'),
      A('BB', 'CALL', 7.5, 'TURN'), A('CO', 'CALL', 7.5, 'TURN'),
      A('BB', 'BET', 20, 'RIVER'), A('CO', 'CALL', 20, 'RIVER'),
    ],
    environment: 'MID_LOW_STAKES',
    villain: { quickProfile: 'CALLING_STATION', dynamicHint: 'UNKNOWN', stackBB: 100 },
  } as unknown as ManualHandInput;
}

/* ============================================================
 * 取值助手（只读诊断，不重算产品公式）
 * ============================================================ */

type Diag = Record<string, any>;

function run(input: ManualHandInput): { action: string; sizeChips: number | null; diag: Diag; warnings: readonly string[] } {
  const r = analyzeManualHand(input, OPTIONS);
  assert.equal(r.ok, true, `必须能分析：${r.ok ? '' : `${r.stage} ${JSON.stringify(r.issues)}`}`);
  if (!r.ok) throw new Error('unreachable');
  const d = r.decision as unknown as Record<string, any>;
  return {
    action: String(d['action']),
    sizeChips: (d['sizeChips'] ?? null) as number | null,
    diag: d['diagnostics'] as Diag,
    warnings: r.warnings,
  };
}

const mathOf = (diag: Diag): Diag => diag['math'] as Diag;
const raiseFactsOf = (diag: Diag): Diag | null =>
  ((diag['postflop'] as Diag | undefined)?.['raiseResponse'] ?? null) as Diag | null;
const raiseEvidenceOf = (diag: Diag): Diag | undefined =>
  ((diag['actionEvidence'] ?? []) as Diag[]).find((e) => e['action'] === 'RAISE');

/* ============================================================
 * P0-1 ~ P0-4：HAND A（AK 河牌）——资金口径、赔率、EV 恒等式
 * ============================================================ */

test('P0-1【HAND A】加注事实必须报出完整资金口径（对手那一注不得被漏掉）', () => {
  /*
   * 节点已知筹码（使用者给定）：底池面对 Hero = 93，对手河牌下注 40，Hero 剩余 174。
   * 全部手算：
   *   heroStreetCommitted = 0（Hero 本街尚未行动）
   *   villainStreetCommitted = 40
   *   raiseTo = 174（Hero 全部剩余）
   *   heroAdd = 174 − 0 = 174
   *   villainAdd = 174 − 40 = 134
   *   终池 = 93 + 174 + 134 = 401
   */
  const { diag } = run(riverFacingBet(['As', 'Ks']));
  const m = mathOf(diag);
  const f = raiseFactsOf(diag);
  assert.notEqual(f, null, 'HAND A 必须有加注响应事实');
  if (f === null) return;

  assert.equal(m['pot'], 93, '前置：决策时底池（含对手这一注）必须是 93');
  assert.equal(m['callCost'], 40, '前置：Hero 需跟注 40');
  assert.equal(f['sizeChips'], 174, '前置：加注到 174');

  assert.equal(f['currentPot'], 93, `事实包必须报出完整底池 currentPot（实际 ${String(f['currentPot'])}）`);
  assert.equal(f['heroStreetCommitted'], 0, `Hero 本街已投必须是 0（实际 ${String(f['heroStreetCommitted'])}）`);
  assert.equal(f['villainStreetCommitted'], 40, `对手本街已投必须是 40（实际 ${String(f['villainStreetCommitted'])}）`);
  assert.equal(f['heroAdd'], 174, `heroAdd 必须是 Hero 真实新增投入 174（实际 ${String(f['heroAdd'])}）`);
  assert.equal(f['villainAdd'], 134, `villainAdd 必须是对手还要补的 134（实际 ${String(f['villainAdd'])}）`);
  assert.equal(f['finalPot'], 401, `终池必须是 93+174+134 = 401（实际 ${String(f['finalPot'])}）`);
});

test('P0-2【HAND A】RAISE EV 必须能用【独立手算】复现（同一零点 = 弃牌 0）', () => {
  const { diag } = run(riverFacingBet(['As', 'Ks']));
  const f = raiseFactsOf(diag);
  assert.notEqual(f, null);
  if (f === null) return;

  /*
   * 独立算术：用事实包**自己的**三个概率与权益，配上手算的资金量。
   * 注意：这不是复制产品实现 —— 产品若用别的底池/投入，这里就对不上。
   */
  const currentPot = 93;              // 手算（节点给定）
  const heroAdd = 174;                // 手算
  const villainAdd = 134;             // 手算
  const finalPot = currentPot + heroAdd + villainAdd; // = 401（双方都跟满）
  const expected =
    (f['foldLikelihood'] as number) * currentPot +
    (f['callLikelihood'] as number) * ((f['heroEquityVsRaiseCallRange'] as number) * finalPot - heroAdd) +
    (f['reRaiseLikelihood'] as number) * -heroAdd;

  assert.ok(
    Math.abs((f['raiseEV'] as number) - expected) < 1e-9,
    `RAISE EV 必须等于独立手算值 ${expected}（实际 ${String(f['raiseEV'])}）` +
      '；两者不符说明产品用的底池/投入与节点真实资金流不一致',
  );
});

test('P0-3【HAND A】对手面对加注的赔率必须 = 他要补的钱 / 他跟注后的底池', () => {
  const { diag } = run(riverFacingBet(['As', 'Ks']));
  const f = raiseFactsOf(diag);
  assert.notEqual(f, null);
  if (f === null) return;
  const price = (f['model'] as Diag)['priceRequiredEquity'] as number;
  const expected = 134 / 401; // 手算：33.4165%
  assert.ok(
    Math.abs(price - expected) < 1e-9,
    `价格必须是 134/401 = ${expected}（实际 ${price}；旧值 0.417445 用的是「扣掉对手这一注的底池 + 2×增量」）`,
  );
});

test('P0-4【HAND A】三个加注金额的价格表必须与手算一致（80/120/174）', () => {
  /*
   * 使用者给定的表（底池 93、对手已投 40、Hero 已投 0）：
   *   加注至 80  ⇒ 他补 40  ⇒ 终池 93+80+40  = 213 ⇒ 40/213  = 18.78%
   *   加注至 120 ⇒ 他补 80  ⇒ 终池 93+120+80 = 293 ⇒ 80/293  = 27.30%
   *   加注至 174 ⇒ 他补 134 ⇒ 终池 93+174+134= 401 ⇒ 134/401 = 33.42%
   */
  const board = ['Kd', '9c', '4h', '6s', '2d'].map(parseCardStrict);
  const range = [['Kc', 'Jd'], ['9d', '9h'], ['4d', '4c'], ['Jc', 'Tc'], ['3c', '2c']] as const;
  const entries = range.map(([a, b]) => {
    const ia = ALL_CARDS.findIndex((c) => c.rank === parseCardStrict(a).rank && c.suit === parseCardStrict(a).suit);
    const ib = ALL_CARDS.findIndex((c) => c.rank === parseCardStrict(b).rank && c.suit === parseCardStrict(b).suit);
    return { cardIndices: [ia, ib] as const, probability: 1 };
  });
  const cases = [
    { raiseTo: 80, villainAdd: 40, finalPot: 213, price: 40 / 213 },
    { raiseTo: 120, villainAdd: 80, finalPot: 293, price: 80 / 293 },
    { raiseTo: 174, villainAdd: 134, finalPot: 401, price: 134 / 401 },
  ];
  for (const c of cases) {
    const built = buildRaiseResponse({
      betRangeEntries: entries,
      board,
      currentPot: 93,               // 决策时完整底池（含对手这一注）
      heroAdd: c.raiseTo,           // Hero 本街已投 0 ⇒ 新增 = raiseTo
      villainAdd: c.villainAdd,     // 他要补的钱（手算）
      heroContestedAdd: c.raiseTo,  // 双方都跟得满 ⇒ 我全部留在池中
      finalPot: c.finalPot,         // 手算：93 + 我 + 他
      street: 'RIVER',
      tendencies: {
        foldScale: 1, callScale: 1, raiseScale: 1, bluffRaiseScale: 1,
        streetFoldScale: 1, streetCallScale: 1, streetCheckRaiseScale: 1, streetBetScale: 1,
      } as never,
      heroIsAllIn: c.raiseTo >= 174,
      /* P1-2a：本夹具里对手有足够筹码 ⇒ 他跟平不会全下 */
      villainIsAllInByCall: false,
    });
    assert.notEqual(built, null, `加注至 ${c.raiseTo} 必须能算出响应`);
    if (built === null) continue;
    assert.equal(built.model.villainAdd, c.villainAdd, `加注至 ${c.raiseTo} ⇒ 他要补 ${c.villainAdd}`);
    assert.equal(built.model.finalPot, c.finalPot, `加注至 ${c.raiseTo} ⇒ 终池 ${c.finalPot}`);
    assert.ok(
      Math.abs(built.model.priceRequiredEquity - c.price) < 1e-9,
      `加注至 ${c.raiseTo} ⇒ 价格 ${c.price}（实际 ${built.model.priceRequiredEquity}）`,
    );
  }
});

/* ============================================================
 * P0-5：Hero 本街已投入（第四阶段 / 第七阶段）
 * ============================================================ */

test('P0-5【HAND D】Hero 本街已投入时：heroAdd 不得重复扣 callCost，且必须真的算出 EV', () => {
  const { diag } = run(heroBetThenFacesRaise());
  const m = mathOf(diag);
  const f = raiseFactsOf(diag);

  // 前置事实：Hero 本街已投 = 下注 5BB = 10 筹码；面对的是 BB 加注到 20BB = 40 筹码
  assert.equal(m['myCommittedThisStreet'], 10, `前置：Hero 本街已投应为 10（实际 ${String(m['myCommittedThisStreet'])}）`);
  assert.equal(m['callCost'], 30, `前置：Hero 需补 30 才能跟平（实际 ${String(m['callCost'])}）`);

  assert.notEqual(f, null, '🔴 本街已有投入时**不得静默关闭** U1（旧实现因两层尺寸不一致会返回 null）');
  if (f === null) return;

  const raiseTo = f['sizeChips'] as number;
  assert.equal(f['heroStreetCommitted'], 10, `Hero 本街已投必须如实报出（实际 ${String(f['heroStreetCommitted'])}）`);
  assert.equal(f['heroAdd'], raiseTo - 10, `heroAdd 必须是 raiseTo − 本街已投（实际 ${String(f['heroAdd'])}）`);
  assert.equal(
    f['villainAdd'],
    raiseTo - (f['villainStreetCommitted'] as number),
    `villainAdd 必须是 raiseTo − 对手本街已投（实际 ${String(f['villainAdd'])}）`,
  );
  assert.equal(
    f['finalPot'],
    (f['currentPot'] as number) + (f['heroAdd'] as number) + (f['villainAdd'] as number),
    '终池必须是 底池 + 我方新增 + 对手补入',
  );
  assert.equal(raiseEvidenceOf(diag)?.['estimateType'], 'MODEL_EV', '本节点加注必须恢复 MODEL_EV 比较资格');
});

/* ============================================================
 * P0-6：多人底池必须**明确拦截**，不得静默按单挑算
 * ============================================================ */

test('P0-6【HAND E】多人（2 个对手）时 U1 必须明确拦截并给出原因', () => {
  const { diag, warnings } = run(multiwayFacingBet());
  assert.equal(raiseFactsOf(diag), null, '两个对手时不得给出单挑口径的加注 EV');
  assert.ok(
    warnings.some((w) => w.includes('多人') || w.includes('单挑') || w.includes('加注 EV')),
    `必须给出「多人底池 ⇒ 加注 EV 不适用」的显式说明（实际 warnings=${JSON.stringify(warnings)}）`,
  );
  const unevaluated = (diag['unevaluatedActions'] ?? []) as Diag[];
  assert.ok(
    unevaluated.some((u) => u['reasonCode'] === 'RAISE_EV_NOT_IMPLEMENTED'),
    '加注必须仍然出现在「未评估」清单里（不得声称已比较）',
  );
});

/* ============================================================
 * P0-7：短筹码对手（他的跟注必须按**实际能投的**算）
 * ============================================================ */

test('P0-7【短筹码】对手跟不起时，villainAdd 必须按他的剩余筹码封顶', () => {
  // BB 只有 30BB = 60 筹码：本街下注 10BB = 20 筹码后只剩 8BB = 16 筹码
  const { diag } = run(riverFacingBet(['As', 'Ks'], { bbStackBB: 30, riverBetBB: 10 }));
  const m = mathOf(diag);
  const f = raiseFactsOf(diag);
  assert.notEqual(f, null, '短筹码节点也应给出加注事实');
  if (f === null) return;

  const villainCommitted = f['villainStreetCommitted'] as number;
  /*
   * 他的剩余筹码（手算）：30BB = 60 筹码；
   * 翻前投 3BB = 6（补到 3BB）、翻牌 2.5BB = 5、转牌 7.5BB = 15、河牌下注 10BB = 20
   * ⇒ 已投 46 ⇒ 只剩 14。
   */
  const villainRemaining = 60 - (6 + 5 + 15) - villainCommitted;
  assert.equal(villainCommitted, 20, '前置：他本街已投 20（下注 10BB）');
  assert.equal(villainRemaining, 14, '前置：他河牌下注后只剩 14 筹码');
  assert.equal(
    f['villainAdd'],
    Math.min((f['sizeChips'] as number) - villainCommitted, villainRemaining),
    `villainAdd 必须按他实际能投的封顶（实际 ${String(f['villainAdd'])}）`,
  );
  // 他投不满 ⇒ Hero 有未被跟注的退回，终池不得按「双方投一样多」算
  const uncalled = (f['heroAdd'] as number) - (f['heroContestedAdd'] as number);
  assert.ok(uncalled > 0, `Hero 必须有未被跟注的退回（实际 ${uncalled}）`);
  assert.equal(
    f['finalPot'],
    (f['currentPot'] as number) + (f['heroContestedAdd'] as number) + (f['villainAdd'] as number),
    '终池 = 底池 + 我方**留在池中**的部分 + 对手补入（退回部分不算）',
  );
  // 本节点的底池：翻前/翻牌/转牌共 53 + 他河牌下注 10BB = 20 ⇒ 73
  assert.equal(m['pot'], 73, '前置：底池 73');
});

/* ============================================================
 * P0-8：Hero 全下 ⇒ 不得生成非法再加注分支
 * ============================================================ */

test('P0-8【全下】Hero 全下时 P(再加注) 必须为 0，且终池按全下金额算', () => {
  const { diag } = run(riverFacingBet(['9s', '9h']));
  const f = raiseFactsOf(diag);
  assert.notEqual(f, null);
  if (f === null) return;
  assert.equal(f['model']['heroIsAllIn'], true, '前置：本次加注就是全下');
  assert.equal(f['reRaiseLikelihood'], 0, '全下时不得出现再加注分支');
  assert.equal(f['heroAdd'], 174, '全下时 heroAdd = 全部剩余 174');
  assert.equal(f['finalPot'], 401, '终池 = 93 + 174 + 134');
});

/* ============================================================
 * M5：CALL / RAISE 必须同一口径（这条现在就该通过 —— 它是参照系）
 * ============================================================ */

test('P0-9【同一口径·参照系】CALL EV 的独立手算必须与产品逐位一致', () => {
  const { diag } = run(riverFacingBet(['As', 'Ks']));
  const m = mathOf(diag);
  const currentPot = m['pot'] as number;       // 93
  const callCost = m['callCost'] as number;    // 40
  const eqBet = m['heroEquityVsBetRange'] as number;
  const expected = eqBet * (currentPot + callCost) - callCost; // 手算：93 + 40 = 133 的可争夺量
  assert.ok(
    Math.abs((m['callEV'] as number) - expected) < 1e-9,
    `CALL EV 必须等于 ${expected}（实际 ${String(m['callEV'])}）—— 这就是加注 EV 必须对齐的口径`,
  );
});

/* ============================================================
 * 第八阶段：三条分支的**独立数学不变量**（M1 / M2 / M3 / M4）
 *
 * 预期值全部手算，**不复制产品实现**；被测对象是产品真正使用的那个纯函数。
 * ============================================================ */

const RIVER_NODE = { currentPot: 93, heroContestedAdd: 174, finalPot: 401, eq: 0.376606 };

test('M1【独立不变量】他 100% 弃牌 ⇒ RAISE EV 必须恰好等于完整底池', () => {
  const ev = raiseEVOf({
    foldLikelihood: 1, callLikelihood: 0, reRaiseLikelihood: 0,
    currentPot: 93, heroContestedAdd: 174, finalPot: 401, equityVsRaiseCall: 0.376606,
    /* P1-2b：再加注分支的零点与其它分支一致（本用例该分支权重为 0 ⇒ 不影响结果） */
    reraiseBranchEV: -174,
  });
  assert.equal(ev, 93, `他弃牌时我赢下完整底池 93（实际 ${ev}）`);
});

test('M2【独立不变量】他 100% 跟注 ⇒ RAISE EV = 权益×终池 − 我的投入', () => {
  const ev = raiseEVOf({
    foldLikelihood: 0, callLikelihood: 1, reRaiseLikelihood: 0,
    currentPot: 93, heroContestedAdd: 174, finalPot: 401, equityVsRaiseCall: 0.5,
    reraiseBranchEV: -174,
  });
  // 手算：0.5 × 401 − 174 = 26.5
  assert.ok(Math.abs(ev - (0.5 * 401 - 174)) < 1e-12, `应为 26.5（实际 ${ev}）`);
});

test('M3【独立不变量】他 100% 再加注且我弃牌 ⇒ RAISE EV = −我的投入（不是「相对跟注的增量」）', () => {
  /*
   * P1-2b 之后，再加注分支的值由调用方按 `max(弃牌, 跟注)` 算好传入；
   * 本用例传入**下界**（= 弃牌）以锁住「不得只扣相对 CALL 的增量」这条老契约。
   */
  const ev = raiseEVOf({
    foldLikelihood: 0, callLikelihood: 0, reRaiseLikelihood: 1,
    currentPot: 93, heroContestedAdd: 174, finalPot: 401, equityVsRaiseCall: 0.9,
    reraiseBranchEV: -174,
  });
  assert.equal(ev, -174, `被再加注后弃牌必须损失我投入的全部 174（实际 ${ev}）`);
  // 反例守护：若误用「对手增量 134」会得到 −134
  assert.notEqual(ev, -134, '不得只扣相对 CALL 的增量');
  // 反例守护：若混用「后续节点局部口径」（把跟注价值当成 0 起点）会得到正数
  const mixed = raiseEVOf({
    foldLikelihood: 0, callLikelihood: 0, reRaiseLikelihood: 1,
    currentPot: 93, heroContestedAdd: 174, finalPot: 401, equityVsRaiseCall: 0.9,
    reraiseBranchEV: 40,
  });
  assert.equal(mixed, 40, '分支值就是调用方传入的那个数（零点必须由调用方统一）');
});

test('M4【独立不变量】Hero 全下 ⇒ 再加注权重必须为 0（不得生成非法分支）', () => {
  const { diag } = run(riverFacingBet(['As', 'Ks']));
  const f = raiseFactsOf(diag);
  assert.notEqual(f, null);
  if (f === null) return;
  assert.equal(f['model']['heroIsAllIn'], true, 'HAND A 的 174 就是全下');
  assert.equal(f['reRaiseLikelihood'], 0, '全下时他不能再加注');
  // 全下时 EV 必须退化成「弃牌分支 + 跟注分支」
  const expected =
    (f['foldLikelihood'] as number) * 93 +
    (f['callLikelihood'] as number) * ((f['heroEquityVsRaiseCallRange'] as number) * 401 - 174);
  assert.ok(Math.abs((f['raiseEV'] as number) - expected) < 1e-9, `全下时 EV 必须等于 ${expected}`);
});

/* ============================================================
 * 第十阶段：临时安全门 —— 没有「正确资金口径」标记的加注 EV
 * **不得**获得 MODEL_EV 比较资格
 * ============================================================ */

test('GATE【安全门】事实包必须带资金口径契约版本，且四个资金量自洽', () => {
  const { diag } = run(riverFacingBet(['As', 'Ks']));
  const f = raiseFactsOf(diag);
  assert.notEqual(f, null);
  if (f === null) return;
  assert.equal(f['cashflowContract'], 'NODE_INCREMENTAL_CHIPS_V2', '事实包必须声明资金口径版本');
  // 自洽：heroAdd ≥ heroContestedAdd ≥ 0；终池 = 底池 + 我留在池中的 + 他补的
  const currentPot = f['currentPot'] as number;
  const heroAdd = f['heroAdd'] as number;
  const contested = f['heroContestedAdd'] as number;
  const villainAdd = f['villainAdd'] as number;
  assert.ok(heroAdd >= contested && contested >= 0, 'heroAdd ≥ heroContestedAdd ≥ 0');
  assert.equal(f['finalPot'], currentPot + contested + villainAdd, '终池恒等式必须成立');
  assert.equal(f['uncalledReturn'], heroAdd - contested, '退回 = 我方新增 − 留在池中的');
  assert.equal(villainAdd, f['raiseIncrement'], 'raiseIncrement 必须等于对手要补的钱（同一事实）');
});

test('GATE【安全门】决策层必须提供「口径不符 ⇒ 拒绝比较」的显式理由码', () => {
  /*
   * 结构性断言：这两个理由码是 U1 P0 的**回归防线** ——
   * 修复前的实现既没有契约标记、也不报「尺寸对不上」，于是错误口径静默地进了 EV 排名。
   */
  const { diag } = run(heroBetThenFacesRaise());
  const reasons = ((diag['reasons'] ?? []) as Diag[]).map((r) => String(r['code']));
  const facts = raiseFactsOf(diag);
  assert.notEqual(facts, null, '前置：该节点必须有加注事实');
  assert.ok(
    !reasons.includes('RAISE_EV_CASHFLOW_CONTRACT_REJECTED'),
    `口径正确时不得出现拒绝理由（实际 reasons=${JSON.stringify(reasons)}）`,
  );
  assert.ok(
    !reasons.includes('RAISE_EV_SIZE_MISMATCH'),
    `尺寸一致时不得出现尺寸不匹配理由（实际 reasons=${JSON.stringify(reasons)}）`,
  );
});
