/**
 * ============================================================================
 * U1 —— 面对加注的响应模型（RAISE RESPONSE）测试
 * ============================================================================
 *
 * `reports/UNCERTAINTY_REGISTER.md` 的 U1 要求：
 * 「实现加注 EV（方案②公共信息口径 + 方案①独立对照）」。
 *
 * 本文件锁四件事：
 *
 * | 编号 | 断言 |
 * |---|---|
 * | U1-1 | **公共信息**：逐组合响应权重不随 Hero 隐藏底牌变化 |
 * | U1-2 | **价格敏感**：加注越大 ⇒ P(弃) 越高、P(跟) 越低（单调） |
 * | U1-3 | **非退化**：极端画像下三个权重仍有限、非负、和为 1 |
 * | U1-4 | **Hero 全下 ⇒ 他不能再加注**（权重迁移到跟注，不是消失） |
 * | U1-5 | **生产路径**：RAISE EV 作为 MODEL_EV 参与比较；EV 更高时**真的选 RAISE** |
 * | U1-6 | **全下保护规则**（纯函数）四种组合穷举 |
 * | U1-7 | **独立对照（方案①）**：同一批节点上两模型的 RAISE EV 必须同号 |
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { buildRaiseResponse, RAISE_RESPONSE_BAND_STRENGTH } from '../src/app/manualInput/raiseResponse.ts';
import { buildBettingRangeFacts, publicStrengthBandOf, PUBLIC_STRENGTH_BAND_ORDER } from '../src/app/manualInput/bettingRange.ts';
import { allInGuardVerdictOf } from '../src/app/decision/decisionEngine.ts';
import { responseTendenciesOf, classifyResponse, cardsToComeOf } from '../src/domain/postflop/betResponse.ts';
import { archetypeDimensionsOf } from '../src/domain/player/archetypeDimensions.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import { ALL_CARDS, parseCardStrict } from '../src/domain/poker/cards.ts';
import { compareHands, evaluateCards } from '../src/domain/poker/handEval.ts';
import { boardRelativeTierOf } from '../src/domain/poker/boardRelativeStrength.ts';
import { computeEquity, EquityComputeMode } from '../src/domain/poker/equity.ts';
import type { ManualHandInput } from '../src/app/manualInput/manualInput.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const SEED = 20_261_014;
const OPTIONS = { rules: RULES, asOf: 1_757_000_000_000, writeLog: false, equitySeed: SEED, budget: { softMs: 120_000, hardMs: 240_000 } } as const;
const BOARD = ['Kd', '9c', '4h', '6s', '2d'] as const;
const BOARD_CARDS = BOARD.map(parseCardStrict);

type Row = { position: string; type: string; amountBB?: number; street?: string };
const A = (position: string, type: string, amountBB?: number, street?: string): Row => ({
  position, type,
  ...(amountBB === undefined ? {} : { amountBB }),
  ...(street === undefined ? {} : { street }),
});

/** Hero BTN，河牌面对 BB 领打；手牌可换 */
function akInput(profile = 'CALLING_STATION', heroCards: [string, string] = ['As', 'Ks']): ManualHandInput {
  return {
    tableSize: 6, heroPosition: 'BTN', heroCards, board: [...BOARD], street: 'RIVER',
    effectiveStackBB: 100, bigBlindBB: 2,
    seatStacksBB: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 },
    actionHistory: [
      A('UTG', 'FOLD'), A('HJ', 'FOLD'), A('CO', 'FOLD'), A('BTN', 'RAISE', 3), A('SB', 'FOLD'), A('BB', 'CALL', 2),
      A('BB', 'CHECK', undefined, 'FLOP'), A('BTN', 'BET', 2.5, 'FLOP'), A('BB', 'CALL', 2.5, 'FLOP'),
      A('BB', 'CHECK', undefined, 'TURN'), A('BTN', 'BET', 7.5, 'TURN'), A('BB', 'CALL', 7.5, 'TURN'),
      A('BB', 'BET', 20, 'RIVER'),
    ],
    environment: 'MID_LOW_STAKES',
    villain: { quickProfile: profile, dynamicHint: 'UNKNOWN', stackBB: 100 },
  } as unknown as ManualHandInput;
}

/** 合成下注范围（等权），用于模型单测 */
function syntheticBetRange(pairs: readonly (readonly [string, string])[]) {
  const idx = (s: string): number => {
    const c = parseCardStrict(s);
    return ALL_CARDS.findIndex((x) => x.rank === c.rank && x.suit === c.suit);
  };
  return pairs.map(([a, b]) => ({ cardIndices: [idx(a), idx(b)] as const, probability: 1 }));
}

const TENDENCIES = responseTendenciesOf(archetypeDimensionsOf('CALLING_STATION', 0.35), 0.35, null);

/**
 * ============================================================================
 * 🔴 **U1 P0 修复后本文件的输入构造**（不是期望值）
 * ============================================================================
 *
 * 响应模型的输入现在是**资金事实**（`currentPot / heroAdd / villainAdd / finalPot`），
 * 由引擎在 `contextBuilder` 第 4d 步算好。本文件是**模型单元测试**，
 * 因此这里显式构造一套固定的资金事实：
 *
 * ```text
 * 决策时底池 currentPot = 93（= 下注前 53 + 对手这一注 40）
 * 对手本街已投 = 40｜Hero 本街已投 = 0（河牌尚未行动）
 * 加注至 raiseTo ⇒ heroAdd = raiseTo（Hero 新增）
 *               ⇒ villainAdd = raiseTo − 40（对手还要补的，按他剩余 134 封顶）
 *               ⇒ 终池 = currentPot + heroAdd + villainAdd
 * ```
 *
 * ## ⚠️ 与修复前的差别（旧断言为什么无效）
 *
 * 修复前这里写的是 `potChips: 53, raiseIncrement: inc` ——
 * 即「**扣掉对手这一注**的底池」配上「**对手**要投的增量」，
 * 模型据此算出 `price = inc / (53 + 2×inc)`。
 * 那个价格的分母漏掉了对手已经投入的 40（HAND A 实测 0.4174 vs 正确 0.3342），
 * 因此**旧的价格断言（0.1370/0.3008/0.3756/0.4174 那张表）锁的是错误口径**，
 * 已按资金事实重写；权利金/门槛的**方向性**结论（单调、非退化、全下迁移）不受影响。
 */
const CASH_FIXTURE = { currentPot: 93, villainStreetCommitted: 40, heroStreetCommitted: 0, villainStack: 134 } as const;

function respInputOf(
  raiseTo: number,
  opts: { street?: 'FLOP' | 'TURN' | 'RIVER'; heroIsAllIn?: boolean; tendencies?: typeof TENDENCIES } = {},
): Parameters<typeof buildRaiseResponse>[0] {
  const heroAdd = raiseTo - CASH_FIXTURE.heroStreetCommitted;
  const villainAdd = Math.min(raiseTo - CASH_FIXTURE.villainStreetCommitted, CASH_FIXTURE.villainStack);
  const villainStreetTotalAfter = CASH_FIXTURE.villainStreetCommitted + villainAdd;
  const heroContestedAdd = Math.max(
    0,
    Math.min(heroAdd, villainStreetTotalAfter - CASH_FIXTURE.heroStreetCommitted),
  );
  return {
    betRangeEntries: [],
    board: BOARD_CARDS,
    currentPot: CASH_FIXTURE.currentPot,
    heroAdd,
    villainAdd,
    heroContestedAdd,
    finalPot: CASH_FIXTURE.currentPot + heroContestedAdd + villainAdd,
    street: opts.street ?? 'RIVER',
    tendencies: opts.tendencies ?? TENDENCIES,
    heroIsAllIn: opts.heroIsAllIn ?? false,
    /* P1-2a：本夹具里对手剩余 134，足够跟平 ⇒ 不会「跟注即全下」 */
    villainIsAllInByCall: false,
  };
}

/* ============================================================
 * U1-1 公共信息（不读 Hero 底牌）
 * ============================================================ */

test('U1-1：面对加注的响应权重**不读 Hero 隐藏底牌**', () => {
  const range = syntheticBetRange([
    ['Kc', 'Jd'], ['Kc', 'Td'], ['Kh', '8c'], ['9d', '9h'], ['4d', '4c'], ['Jc', 'Tc'], ['8d', '7d'], ['3c', '2c'],
  ]);
  const build = () => buildRaiseResponse({ ...respInputOf(80), betRangeEntries: range })!;
  const a = build();
  const b = build(); // 同一输入（模型没有 Hero 参数 —— 类型上就无法传入）
  assert.deepEqual(
    [a.foldLikelihood, a.callLikelihood, a.reRaiseLikelihood],
    [b.foldLikelihood, b.callLikelihood, b.reRaiseLikelihood],
    '同一输入必须给出同一结果（模型不接受 Hero 底牌作为输入）',
  );
  assert.equal(a.model.usesHeroHiddenCards, false, '模型必须自述「不读 Hero 隐藏底牌」');
  // 逐组合可复现：同一组合的归属只由公共信息决定
  const band = publicStrengthBandOf([parseCardStrict('Kc'), parseCardStrict('Jd')], BOARD_CARDS);
  assert.equal(band, 'TOP_PAIR_GOOD');
  assert.ok(
    RAISE_RESPONSE_BAND_STRENGTH[band] > RAISE_RESPONSE_BAND_STRENGTH.MIDDLE_PAIR,
    '强度阶梯必须单调（顶对 > 中对）',
  );
});

/* ============================================================
 * U1-2 价格敏感（单调）
 * ============================================================ */

test('U1-2：加注越大 ⇒ P(弃) 单调不减、P(继续) 与 P(再加注) 单调不增', () => {
  /*
   * 这里**只**断言模型真正声称、且**数学上必然成立**的性质：
   *
   * - 继续门槛 `required = 价格 + 余量` 随增量严格上升，每个组合的继续判定是
   *   「强度 ≥ 门槛」的阈值判定 ⇒ P(弃) 单调不减、P(继续) 单调不增；
   * - 再加注门槛 `required + 0.2` 同样上移，且价值再加注份额随
   *   `strength − (required + 0.2)` 递减 ⇒ P(再加注) 单调不增。
   *
   * ❌ **不**断言 P(跟) 单调下降：`P(跟) = 1 − P(弃) − P(再加注)`，两项都下降时
   * 差值可以**上升**。实测确实如此（见 U1-2b），根因是「再加注门槛随价格一起上移」
   * 把中强牌从再加注桶搬进了跟注桶。这是**已登记的模型局限**
   * （`reports/UNCERTAINTY_REGISTER.md` U9），不是本测试要掩盖的失败 ——
   * 因此这里既不硬编一个「跟注率下降」的假断言，也不偷偷调参把锯齿抹平。
   */
  const range = syntheticBetRange([
    ['Kc', 'Jd'], ['Kc', 'Td'], ['Kh', '8c'], ['9d', '9h'], ['4d', '4c'], ['Jc', 'Tc'], ['8d', '7d'], ['3c', '2c'],
  ]);
  /** 加注至 `raiseTo`（资金事实由 `respInputOf` 给出） */
  const of = (raiseTo: number) => buildRaiseResponse({ ...respInputOf(raiseTo), betRangeEntries: range })!;
  const steps = [60, 80, 120, 174].map(of);
  for (let i = 1; i < steps.length; i += 1) {
    const prev = steps[i - 1]!;
    const cur = steps[i]!;
    assert.ok(
      cur.foldLikelihood >= prev.foldLikelihood - 1e-12,
      `加注越大 ⇒ 弃牌率不得下降（${prev.foldLikelihood} → ${cur.foldLikelihood}）`,
    );
    assert.ok(
      1 - cur.foldLikelihood <= 1 - prev.foldLikelihood + 1e-12,
      `加注越大 ⇒ 继续率不得上升（${1 - prev.foldLikelihood} → ${1 - cur.foldLikelihood}）`,
    );
    assert.ok(
      cur.reRaiseLikelihood <= prev.reRaiseLikelihood + 1e-12,
      `加注越大 ⇒ 再加注率不得上升（${prev.reRaiseLikelihood} → ${cur.reRaiseLikelihood}）`,
    );
  }
  assert.ok(steps[3]!.foldLikelihood > steps[0]!.foldLikelihood, '最大加注的弃牌率必须严格更高');
  assert.ok(steps[3]!.reRaiseLikelihood <= steps[0]!.reRaiseLikelihood, '最大加注的再加注率必须不更高');
});

test('U1-2b【已知模型局限·变更探测器】：跟注桶随尺寸**非单调**（锯齿）', () => {
  /*
   * 这是 U1-2 里被显式排除的那条性质，单独锁在这里，目的**不是**声称它正确，
   * 而是：① 把局限写成代码里的事实；② 将来若有人改了再加注门槛、锯齿消失，
   * 这条断言会**故意失败**，强制同时更新 `UNCERTAINTY_REGISTER.md` U9。
   *
   * 下面三个尺寸点的实测值（**U1 P0 修复后重新测得**；来源：
   * `scripts/u1-response-monotonicity.ts`，证据：`reports/evidence/u1-response-monotonicity.txt`）：
   *
   * | 加注至 | 他要补 | 终池 | 价格 | 弃 | 跟 | 再加注 |
   * |---|---|---|---|---|---|---|
   * | 80 | 40 | 213 | 0.1878 | 0.3750 | 0.3699 | 0.2551 |
   * | 120 | 80 | 293 | 0.2730 | 0.3750 | **0.4900** | 0.1350 |
   * | 174 | 134 | 401 | 0.3342 | 0.5000 | 0.3704 | 0.1296 |
   *
   * 形态是**锯齿**而不是单调：弃牌率是阶梯函数（强度只有 9 档），
   * 每段平台里再加注门槛继续上移 ⇒ 跟注率上升；门槛越过一整档强度时 ⇒ 骤降。
   * 生产节点上实测最大锯齿 **+17.5pp**（AK·CS，加注至 80 → 100）～ **+21.7pp**（AK·MANIAC）。
   */
  const range = syntheticBetRange([
    ['Kc', 'Jd'], ['Kc', 'Td'], ['Kh', '8c'], ['9d', '9h'], ['4d', '4c'], ['Jc', 'Tc'], ['8d', '7d'], ['3c', '2c'],
  ]);
  const at = (raiseTo: number) => buildRaiseResponse({ ...respInputOf(raiseTo), betRangeEntries: range })!;
  const small = at(80);
  const mid = at(120);
  const big = at(174);
  assert.ok(mid.callLikelihood > small.callLikelihood, '锯齿仍在：中等尺寸的跟注率高于小尺寸');
  assert.ok(big.callLikelihood < mid.callLikelihood, '锯齿仍在：更大尺寸的跟注率**回落**');
  assert.ok(
    small.foldLikelihood <= mid.foldLikelihood && mid.foldLikelihood < big.foldLikelihood,
    '前提未变：弃牌率始终单调不减',
  );
  assert.ok(
    small.reRaiseLikelihood > mid.reRaiseLikelihood && mid.reRaiseLikelihood > big.reRaiseLikelihood,
    '前提未变：再加注率始终单调下降',
  );
});

/* ============================================================
 * U1-3 非退化（极端画像）
 * ============================================================ */

test('U1-3：极端画像/尺寸下三个权重必须有限、非负、和为 1', () => {
  const range = syntheticBetRange([
    ['Kc', 'Jd'], ['9d', '9h'], ['4d', '4c'], ['Jc', 'Tc'], ['3c', '2c'],
  ]);
  for (const tightness of [0, 0.5, 1]) {
    for (const aggression of [0, 0.5, 1]) {
      for (const bluffTendency of [0, 0.5, 1]) {
        for (const passivity of [0, 0.5, 1]) {
          const tendencies = responseTendenciesOf({ tightness, aggression, bluffTendency, passivity } as never, 1, null);
          for (const raiseTo of [45, 80, 400]) {
            const r = buildRaiseResponse({ ...respInputOf(raiseTo, { tendencies }), betRangeEntries: range });
            assert.notEqual(r, null);
            const { foldLikelihood: f, callLikelihood: c, reRaiseLikelihood: rr } = r!;
            for (const [k, v] of [['弃', f], ['跟', c], ['再加注', rr]] as const) {
              assert.ok(Number.isFinite(v) && v >= 0 && v <= 1, `${k} 必须在 [0,1]（实际 ${v}）`);
            }
            assert.ok(Math.abs(f + c + rr - 1) < 1e-12, `三者之和必须为 1（实际 ${f + c + rr}）`);
          }
        }
      }
    }
  }
});

/* ============================================================
 * U1-4 Hero 全下 ⇒ 他不能再加注
 * ============================================================ */

test('U1-4：Hero 全下时再加注权重必须为 0，且迁移到跟注（不是消失）', () => {
  const range = syntheticBetRange([['9d', '9h'], ['4d', '4c'], ['Kc', 'Jd'], ['3c', '2c']]);
  const notAllIn = buildRaiseResponse({ ...respInputOf(120, { heroIsAllIn: false }), betRangeEntries: range })!;
  const allIn = buildRaiseResponse({ ...respInputOf(120, { heroIsAllIn: true }), betRangeEntries: range })!;
  assert.equal(allIn.reRaiseLikelihood, 0, 'Hero 全下 ⇒ 他不能再加注');
  assert.ok(notAllIn.reRaiseLikelihood > 0, '前置：不设限时确实存在再加注权重');
  assert.ok(
    Math.abs(allIn.foldLikelihood - notAllIn.foldLikelihood) < 1e-12,
    '弃牌率不得因此改变',
  );
  assert.ok(allIn.callLikelihood > notAllIn.callLikelihood, '再加注权重必须**迁移到跟注**');
  assert.ok(
    Math.abs(allIn.foldLikelihood + allIn.callLikelihood - 1) < 1e-12,
    '全下时 弃 + 跟 = 1',
  );
});

/* ============================================================
 * U1-5 生产路径：EV 支持时加注可达
 * ============================================================ */

test('U1-5（M3 生产路径）：RAISE EV 高于 CALL EV 时，最终动作必须是 RAISE', () => {
  // 99 = 暗三条（category 4）；实测该节点 RAISE EV 140.01 > CALL EV 79.22
  const r = analyzeManualHand(akInput('CALLING_STATION', ['9s', '9h']), OPTIONS);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const d = r.decision as unknown as Record<string, any>;
  const dg = d['diagnostics'] as Record<string, any>;
  const evidence = (dg['actionEvidence'] ?? []) as { action: string; estimateType: string; ev: number | null }[];
  const raise = evidence.find((e) => e.action === 'RAISE');
  const call = evidence.find((e) => e.action === 'CALL');
  assert.equal(raise?.estimateType, 'MODEL_EV', '加注必须有模型 EV（U1）');
  assert.ok((raise?.ev ?? -Infinity) > (call?.ev ?? Infinity), '前置：本节点 RAISE EV 更高');
  assert.equal(d['action'], 'RAISE', `EV 更高时必须选 RAISE（实际 ${String(d['action'])}）`);
  // 且全下保护不得拦它（它有自己的 EV）
  assert.equal(dg['allInGuard']['hasOwnEV'], true, '有模型 EV ⇒ hasOwnEV 必须为真');
  assert.equal(dg['allInGuard']['onePairAllInBlocked'], false, '有 EV 时保护必须让位');
});

/* ============================================================
 * U1-6 全下保护规则（纯函数穷举）
 * ============================================================ */

test('U1-6：全下保护规则的四种组合（纯函数，不依赖可达的生产状态）', () => {
  assert.equal(
    allInGuardVerdictOf({ handCategory: 2, consumesStack: true, hasOwnEV: false }).onePairAllInBlocked,
    true,
    '一对牌 + 全下 + 无自有 EV ⇒ 必须拦',
  );
  assert.equal(
    allInGuardVerdictOf({ handCategory: 2, consumesStack: true, hasOwnEV: true }).onePairAllInBlocked,
    false,
    '一对牌 + 全下 + **有**自有 EV ⇒ 不得拦（保留模型做出全下选择的能力）',
  );
  assert.equal(
    allInGuardVerdictOf({ handCategory: 4, consumesStack: true, hasOwnEV: false }).onePairAllInBlocked,
    false,
    '类别 ≥ 3（两对及以上）⇒ 不得因牌型被拦',
  );
  assert.equal(
    allInGuardVerdictOf({ handCategory: 2, consumesStack: false, hasOwnEV: false }).onePairAllInBlocked,
    false,
    '不是全下 ⇒ 保护不适用',
  );
});

/* ============================================================
 * U1-7 独立对照（方案① vs 方案②）
 * ============================================================ */

test('U1-7：方案①（versusHero+tier）与方案②（公共强度带）的 RAISE EV 必须同号', () => {
  /*
   * 方案② 是生产模型；方案① 是产品既有的响应分类器（价格换成加注赔率）。
   * 两者强度基准**不同**（① 读 Hero 视角，② 只用公共信息）⇒ 独立。
   * 一致性只用于证明「生产模型没有给出与既有模型方向相反的结论」，
   * 它**不**证明任何一方已校准（U1 的其余部分仍列为未校准）。
   */
  const range = syntheticBetRange([
    ['Kc', 'Jd'], ['Kc', 'Td'], ['Kh', '8c'], ['9d', '9h'], ['4d', '4c'], ['Jc', 'Tc'], ['8d', '7d'], ['3c', '2c'],
  ]);
  const heroHole = ['As', 'Ks'].map(parseCardStrict);
  const heroEval = evaluateCards([...heroHole, ...BOARD_CARDS]);
  /*
   * 🔴 **U1 P0 修复**：旧版本这里写的是
   * `price = increment / (potPre + 2×increment)`、`finalPot = potPre + 2×increment`、
   * 成本 `−increment` —— 与产品当时**同一个错误口径**（漏掉对手已下注的 40），
   * 因此这条测试**结构上不可能发现该缺陷**。
   * 现在两个模型都用**修正后的口径**（底池含对手那一注、成本只算我方新增）：
   *   加注至 80 ⇒ 我新增 80、他补 40、终池 93+80+40 = 213
   */
  const raiseTo = 80;
  const currentPot = 93;            // 手算：下注前 53 + 对手这一注 40
  const villainAdd = raiseTo - 40;  // = 40
  const heroAdd = raiseTo;          // Hero 本街原为 0
  const finalPot = currentPot + heroAdd + villainAdd; // = 213
  const price = villainAdd / finalPot;                // = 0.1878

  /** 条件范围权益（归一化权重口径） */
  const equityOf = (entries: readonly { cardIndices: readonly [number, number]; probability: number }[], label: string): number => {
    if (entries.length === 0) return 0;
    const out = computeEquity(heroHole, BOARD_CARDS,
      [{ label, combos: entries.map((e) => [ALL_CARDS[e.cardIndices[0]]!, ALL_CARDS[e.cardIndices[1]]!] as const) }],
      { mode: EquityComputeMode.FAST, seed: SEED + 1601, iterations: 8000, opponentWeights: [entries.map((e) => e.probability)] });
    return out.ok ? out.result.equity : 0;
  };

  /* 方案②：生产模型 */
  const prod = buildRaiseResponse({ ...respInputOf(raiseTo), betRangeEntries: range })!;
  const eqProd = equityOf(prod.callContinueEntries, 'prod-call');
  const evProd = prod.foldLikelihood * currentPot
    + prod.callLikelihood * (eqProd * finalPot - heroAdd)
    + prod.reRaiseLikelihood * -heroAdd;

  /* 方案①：既有分类器（独立尺子） */
  let f1 = 0;
  let c1 = 0;
  let r1 = 0;
  let t1 = 0;
  const call1: { cardIndices: readonly [number, number]; probability: number }[] = [];
  for (const e of range) {
    const hole = [ALL_CARDS[e.cardIndices[0]]!, ALL_CARDS[e.cardIndices[1]]!] as const;
    const cmp = compareHands(evaluateCards([...hole, ...BOARD_CARDS]), heroEval);
    const cls = classifyResponse({
      hole: [hole[0], hole[1]],
      versusHero: cmp > 0 ? 'STRONGER' : cmp < 0 ? 'WEAKER' : 'EQUAL',
      tier: boardRelativeTierOf([hole[0], hole[1]], BOARD_CARDS) ?? 5,
      street: 'RIVER', cardsToCome: cardsToComeOf(5, 'RIVER'),
      ratioToPot: heroAdd / currentPot, priceRequiredEquity: price, spr: null, opponentCount: 1,
      wetness: 0, tendencies: TENDENCIES, heroIsAllIn: false, villainDraw: 'NO_DRAW',
      /* U1 P0-7 夹具里对手仍有筹码 ⇒ 不会因跟注全下（P1-4 的判据与 Hero 全下分开） */
      villainIsAllInByCall: false,
    });
    t1 += e.probability;
    f1 += e.probability * cls.weights.fold;
    c1 += e.probability * cls.weights.call;
    r1 += e.probability * cls.weights.raise;
    if (cls.weights.call > 0) call1.push({ cardIndices: e.cardIndices, probability: e.probability * cls.weights.call });
  }
  const m1 = call1.reduce((a, x) => a + x.probability, 0);
  const norm1 = m1 > 0 ? call1.map((x) => ({ ...x, probability: x.probability / m1 })) : [];
  const eq1 = equityOf(norm1, 'alt-call');
  const ev1 = (f1 / t1) * currentPot + (c1 / t1) * (eq1 * finalPot - heroAdd) + (r1 / t1) * -heroAdd;

  assert.ok(t1 > 0 && m1 > 0, '前置：两个模型都必须有可继续的组合');
  assert.equal(
    Math.sign(evProd) === Math.sign(ev1) || Math.abs(evProd - ev1) < 1e-9,
    true,
    `两个独立模型的 RAISE EV 必须同号：方案② ${evProd.toFixed(2)} vs 方案① ${ev1.toFixed(2)}`,
  );
});


/* ============================================================
 * U1-8 边界
 * ============================================================ */

test('U1-8：非法输入必须返回 null（不猜）', () => {
  const range = syntheticBetRange([['Kc', 'Jd'], ['9d', '9h']]);
  const base = { ...respInputOf(80), betRangeEntries: range };
  assert.equal(buildRaiseResponse({ ...base, currentPot: 0 }), null, '底池为 0 ⇒ null');
  assert.equal(buildRaiseResponse({ ...base, heroAdd: 0 }), null, '我方新增为 0 ⇒ null（不是「加注」）');
  assert.equal(buildRaiseResponse({ ...base, heroAdd: -5 }), null, '负投入 ⇒ null');
  assert.equal(buildRaiseResponse({ ...base, heroAdd: Number.NaN }), null, 'NaN ⇒ null');
  assert.equal(buildRaiseResponse({ ...base, villainAdd: 0 }), null, '对手无需补钱 ⇒ null');
  assert.equal(buildRaiseResponse({ ...base, finalPot: 0 }), null, '终池为 0 ⇒ null（价格无定义）');
  assert.equal(buildRaiseResponse({ ...base, betRangeEntries: [] }), null, '空范围 ⇒ null');
  assert.equal(
    buildRaiseResponse({ ...base, board: [parseCardStrict('Kd')] }),
    null,
    '牌面不足 3 张 ⇒ null',
  );
  assert.ok(
    PUBLIC_STRENGTH_BAND_ORDER.includes('AIR'),
    '强度带枚举必须可用（模型与下注范围共用同一把尺子）',
  );
  // 下注范围模型与新模型必须共用同一把「公共强度带」尺子
  const f = buildBettingRangeFacts({
    arrivalEntries: syntheticBetRange([['Kc', 'Jd'], ['9d', '9h']]),
    board: BOARD_CARDS, heroHole: ['As', 'Ks'].map(parseCardStrict),
    potChips: 53, betChips: 40, street: 'RIVER', tendencies: TENDENCIES,
  });
  assert.notEqual(f, null);
});
