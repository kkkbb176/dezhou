/**
 * ============================================================================
 * 翻前加注决策系统 · 阶段 A + B 验收测试（PREFLOP RAISE DECISION）
 * ============================================================================
 *
 * ## 本文件要回答的问题
 *
 * | 问题 | 对应测试 |
 * |---|---|
 * | 翻前加注**有没有自己的 EV**（每个尺寸各一份）？ | B-01 / B-02 |
 * | EV 的算智能否**独立复算**？ | B-04 / B-05 |
 * | 响应概率守恒、条件范围归一化？ | B-03 |
 * | 换掉 Hero 真牌会不会改变对手响应？ | B-07 |
 * | 尺寸对不上时会不会借用别的尺寸的 EV？ | B-06 |
 * | 不等筹码、刚好跟注全下、超额退回？ | A-05 / B-08 |
 * | 多人 / 身后有人时会不会偷偷按单挑算？ | B-09 |
 * | 相同输入可复现？ | B-10 |
 *
 * ## 断言纪律（与项目其余测试一致）
 *
 * 1. **不复刻生产公式**：能独立推导的一律从更底层的量（底池、
 *    已投入、剩余筹码）重新算一遍，再与生产输出比对 ——
 *    复制公式的测试无法发现公式本身的错误。
 * 2. **不写死「某手牌一定加注」**：断言的是计算、证据与输出是否一致。
 * 3. 任何一条断言都必须能回答「哪一层改坏了会让它红」。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Position, TableSize } from '../src/domain/types.ts';
import {
  createGame,
  computePot,
  committedThisStreet,
  minRaiseTo,
  type GameState,
} from '../src/domain/poker/gameState.ts';
import { applyAction } from '../src/domain/poker/engine.ts';
import { deriveLegalActions, buildSizeGrid } from '../src/app/manualInput/legalActions.ts';
import { raiseEVOf, CASHFLOW_CONTRACT } from '../src/app/manualInput/raiseResponse.ts';
import {
  PREFLOP_STRENGTH_ANCHORS,
  PREFLOP_CONTINUE_MARGIN,
  PREFLOP_RERAISE_GATE,
  buildPreflopRaiseResponse,
  preflopReRaiseToOf,
  preflopStrengthOf,
  rankClassOfIndices,
  selfCheckPreflopStrength,
  type PreflopRaiseResponse,
} from '../src/app/manualInput/preflopRaiseResponse.ts';
import {
  buildPreflopRaiseFacts,
  evaluatePreflopRaiseModel,
  arrivalEntriesOf,
  PREFLOP_RAISE_SKIP_ZH,
  type PreflopEquityFact,
  type PreflopRaiseFacts,
} from '../src/app/manualInput/preflopRaiseFacts.ts';
import { ALL_RANK_CLASSES, expandRankClass } from '../src/domain/range/combo.ts';
import { deadCardsFrom, emptyDeadCards, removeBlockedCombos } from '../src/domain/range/rangeBlockers.ts';
import { neutralResponseTendencies } from '../src/domain/postflop/betResponse.ts';
import { C } from './helpers.ts';

/* ============================================================
 * 夹具
 * ============================================================ */

const BB = 2000; // 1BB = 2000 筹码（与项目其余测试的 1000/2000 盲注一致）

/**
 * 6 人桌：UTG/HJ 弃牌、CO 弃牌、BTN 开池到 2.5BB、SB 弃牌 ⇒ 轮到 BB。
 *
 * 用**真实引擎**逐段推进，绝不手工拼状态 —— 手工拼出来的状态
 * 一旦与引擎口径不符，后面所有断言都会在错误的前提上「通过」。
 */
function bbVsBtnOpen(
  options: {
    stacksByPosition?: Partial<Record<Position, number>>;
    /**
     * Hero 的底牌。**换它只允许改变「阻断牌」造成的组合增减**，
     * 不得改变响应规则本身 —— 见 B-07。
     */
    heroCards?: string;
  } = {},
): GameState {
  const positions = [Position.UTG, Position.HJ, Position.CO, Position.BTN, Position.SB, Position.BB];
  const players = positions.map((position) => ({
    id: position.toLowerCase(),
    name: position,
    position,
    startingStack: options.stacksByPosition?.[position] ?? 100 * BB,
    /*
     * 只有 Hero 有底牌：EV 的权益计算需要它（`HERO_NO_CARDS` 是本模型的
     * 显式拒绝原因之一）。对手的底牌在这里**故意不给** ——
     * 「对手实际底牌不得进入正常决策」是使用者的硬要求，
     * 夹具必须与真实录入一致（录入时对手底牌本来就是未知的）。
     */
    holeCards: position === Position.BB ? C(options.heroCards ?? 'As Ah') : null,
  }));
  let state = createGame({
    id: 'preflop-raise-test',
    config: { tableSize: TableSize.SIX_MAX, smallBlind: BB / 2, bigBlind: BB, ante: 0, dealerPosition: Position.BTN },
    players,
    userPlayerId: 'bb',
    createdAt: '2026-01-01T00:00:00.000Z',
  });

  const act = (playerId: string, type: 'FOLD' | 'RAISE' | 'CALL' | 'CHECK', amount?: number): void => {
    const r = applyAction(state, {
      playerId,
      type,
      ...(amount === undefined ? {} : { amount }),
    } as never);
    assert.equal(
      r.ok,
      true,
      `夹具动作 ${playerId}/${type}${amount === undefined ? '' : ` ${amount}`} 必须合法：`
        + (r.ok ? '' : r.issues.map((i) => `${i.code}:${JSON.stringify(i.params)}`).join(' / ')),
    );
    if (r.ok) state = r.state;
  };

  act('utg', 'FOLD');
  act('hj', 'FOLD');
  act('co', 'FOLD');
  act('btn', 'RAISE', Math.round(2.5 * BB));
  act('sb', 'FOLD');
  return state;
}

/**
 * BB 3Bet 到 `threeBetBB`、BTN 4Bet 到 `fourBetBB`（用于「面对 4Bet」的局面）。
 * 返回停在**轮到 BB** 的状态。
 */
function bbVsBtnFourBet(threeBetBB: number, fourBetBB: number, stacks?: Partial<Record<Position, number>>): GameState {
  let state = bbVsBtnOpen(stacks === undefined ? {} : { stacksByPosition: stacks });
  const act = (playerId: string, type: 'FOLD' | 'RAISE' | 'CALL' | 'CHECK', amount?: number): void => {
    const r = applyAction(state, {
      playerId,
      type,
      ...(amount === undefined ? {} : { amount }),
    } as never);
    assert.equal(r.ok, true, `夹具动作 ${playerId}/${type} ${amount} 必须合法`);
    if (r.ok) state = r.state;
  };
  act('bb', 'RAISE', Math.round(threeBetBB * BB));
  act('btn', 'RAISE', Math.round(fourBetBB * BB));
  return state;
}

/* ============================================================
 * 测试用权益桩
 *
 * 🔴 它是**显式的确定性桩**，不是生产权益引擎：本文件测的是
 * 「EV 算智」与「证据链」，权益数值本身由 `equity.test.ts` /
 * `equityEngines.test.ts` 负责。桩的取值只依赖组合的**类别**
 * （公开信息），因此「换掉 Hero 底牌 ⇒ 响应不变」这条断言
 * 不会被桩掩盖。
 * ============================================================ */

function stubEquityOf(overrides: { call?: number; reraise?: number } = {}) {
  return (
    entries: readonly { readonly cardIndices: readonly [number, number]; readonly probability: number }[],
    seedOffset: number,
  ): PreflopEquityFact => {
    if (entries.length === 0) {
      return { value: null, method: 'NOT_AVAILABLE', iterations: 0, confidenceHalfWidth: null };
    }
    const value = seedOffset === 1301 ? (overrides.call ?? 0.6) : (overrides.reraise ?? 0.35);
    return { value, method: 'MONTE_CARLO', iterations: 4000, confidenceHalfWidth: 0.015 };
  };
}

/** 一个受控的「他开池」到达范围：每类一个代表组合，权重按给定的类别表 */
function controlledArrival(weightsByClass: Readonly<Record<string, number>>) {
  const out: { cardIndices: readonly [number, number]; probability: number }[] = [];
  let sum = 0;
  const raw: { cardIndices: readonly [number, number]; probability: number }[] = [];
  for (const [rankClass, weight] of Object.entries(weightsByClass)) {
    if (!(weight > 0)) continue;
    const combos = expandRankClass(rankClass);
    if (combos.length === 0) continue;
    // 每个类别只取第一个组合（受控、可复算）
    raw.push({ cardIndices: combos[0]!.cardIndices, probability: weight });
    sum += weight;
  }
  for (const entry of raw) out.push({ cardIndices: entry.cardIndices, probability: entry.probability / sum });
  return out;
}

/** 一个「典型 BTN 开池范围」的类别权重（粗档，仅用于测试输入，不参与生产） */
const BTN_OPEN_WEIGHTS: Readonly<Record<string, number>> = Object.freeze({
  AA: 1, KK: 1, QQ: 1, JJ: 1, TT: 1, '99': 1, '88': 1,
  AKs: 1, AKo: 1, AQs: 1, AQo: 1, AJs: 1, AJo: 1, ATs: 1, ATo: 1,
  KQs: 1, KQo: 1, KJs: 1, QJs: 1, JTs: 1,
  A5s: 1, A4s: 1, '76s': 1, '65s': 1, '54s': 1,
  K9s: 1, Q9s: 1, J9s: 1, T9s: 1, '98s': 1,
  '22': 1, '33': 1, '44': 1, '55': 1, '66': 1, '77': 1,
  A2s: 1, A3s: 1, A6s: 1, A7s: 1, A8s: 1, A9s: 1,
  K8s: 1, K7s: 1, '87s': 1, '97s': 1, '86s': 1,
  A9o: 1, KTo: 1, QTo: 1, JTo: 1,
});

/* ============================================================
 * 构建事实包的统一入口
 * ============================================================ */

const NEUTRAL = neutralResponseTendencies();

function factsOf(
  state: GameState,
  options: {
    arrival?: readonly { readonly cardIndices: readonly [number, number]; readonly probability: number }[];
    tendencies?: typeof NEUTRAL;
    playersRemainingToAct?: number;
    equity?: { call?: number; reraise?: number };
  } = {},
): { ok: true; facts: PreflopRaiseFacts } | { ok: false; reason: string; noteZh: string } {
  const hero = state.players.find((p) => p.id === 'bb')!;
  const opponent = state.players.find((p) => p.id === 'btn')!;
  const legal = deriveLegalActions(state, hero);
  const built = buildPreflopRaiseFacts({
    state,
    hero,
    opponent,
    legal,
    arrivalEntries: options.arrival ?? controlledArrival(BTN_OPEN_WEIGHTS),
    arrivalSource: 'TEST_CONTROLLED_ARRIVAL',
    range: null,
    tendencies: options.tendencies ?? NEUTRAL,
    playersRemainingToAct: options.playersRemainingToAct ?? 0,
    seed: 20_260_913,
    equityOf: stubEquityOf(options.equity ?? {}),
  });
  return built.ok ? { ok: true, facts: built.facts } : { ok: false, reason: built.reason, noteZh: built.noteZh };
}

function mustFacts(state: GameState, options: Parameters<typeof factsOf>[1] = {}): PreflopRaiseFacts {
  const built = factsOf(state, options);
  assert.equal(built.ok, true, `事实包必须可构建：${built.ok ? '' : built.reason}`);
  if (!built.ok) throw new Error('unreachable');
  return built.facts;
}

/* ============================================================
 * 一、起手牌强度阶梯（模型的最底层，必须可复算）
 * ============================================================ */

test('B-00a：起手牌强度阶梯必须满足四条可执行序关系，且表本身可导出', () => {
  assert.deepEqual(selfCheckPreflopStrength(), [], '强度阶梯自检必须全通过（含「锚点表 = 结构式」这条）');

  /*
   * 独立复核（不复用生产 selfCheck 的循环）：对子的严格递减。
   * 这一条是「4Bet 范围必须由顶端构成」的前提 —— 阶梯一旦不单调，
   * 4Bet 桶就可能包含比弃牌桶更弱的牌。
   */
  const pairs = ['AA', 'KK', 'QQ', 'JJ', 'TT', '99', '88', '77', '66', '55', '44', '33', '22'];
  for (let i = 0; i + 1 < pairs.length; i += 1) {
    assert.ok(
      preflopStrengthOf(pairs[i]!) > preflopStrengthOf(pairs[i + 1]!),
      `${pairs[i]} 必须强于 ${pairs[i + 1]}`,
    );
  }
  /* 同花必须高于不同花 */
  for (const [s, o] of [['AKs', 'AKo'], ['AQs', 'AQo'], ['KQs', 'KQo']] as const) {
    assert.ok(preflopStrengthOf(s) > preflopStrengthOf(o), `${s} 必须强于 ${o}`);
  }
  /* 强度表必须覆盖全部 169 类，且都落在 (0,1] */
  let min = 1;
  for (const key of ALL_RANK_CLASSES) {
    const v = preflopStrengthOf(key);
    assert.ok(Number.isFinite(v) && v > 0 && v <= 1, `${key} 强度越界：${v}`);
    if (v < min) min = v;
  }
  assert.ok(min < 0.2, `最弱类别应当明显低于中位（实测最小 ${min}）`);
  /* 锚点表必须非空且每条都能被结构式复现（自检覆盖，这里锁规模） */
  assert.ok(PREFLOP_STRENGTH_ANCHORS.length >= 15, '锚点表必须覆盖足够多的代表类别');
});

test('B-00b：组合索引 → 类别键必须与 domain/range/combo.ts 的编码逐位一致', () => {
  /*
   * 用**权威实现**（`expandRankClass` 产出的 `cardIndices`）反查类别键，
   * 覆盖全部 169 类 —— 而不是拿几个样例手工验证。
   */
  const mismatches: string[] = [];
  for (const rankClass of ALL_RANK_CLASSES) {
    for (const combo of expandRankClass(rankClass)) {
      const got = rankClassOfIndices(combo.cardIndices as unknown as readonly [number, number]);
      if (got !== rankClass) mismatches.push(`${rankClass} ← ${combo.canonicalId} 得到 ${got}`);
    }
  }
  assert.deepEqual(mismatches, [], '组合索引 → 类别键必须逐位一致');
});

/* ============================================================
 * 二、响应模型：概率守恒、条件范围归一化、单调、无 Hero 泄漏
 * ============================================================ */

test('B-03：响应概率必须有限、非负、总和为 1；两个条件范围必须各自归一化', () => {
  const arrival = controlledArrival(BTN_OPEN_WEIGHTS);
  const built = buildPreflopRaiseResponse({
    arrivalEntries: arrival,
    currentPot: 2.5 * BB + BB,
    heroAdd: 7.5 * BB,
    villainAdd: 5 * BB,
    finalPot: 2.5 * BB + BB + 7.5 * BB + 5 * BB,
    tendencies: NEUTRAL,
    heroIsAllIn: false,
    villainIsAllInByCall: false,
  });
  assert.notEqual(built, null, '响应必须可构建');
  if (built === null) return;

  const { foldLikelihood: f, callLikelihood: c, reRaiseLikelihood: r } = built;
  for (const [name, v] of [['弃', f], ['跟', c], ['再加注', r]] as const) {
    assert.ok(Number.isFinite(v), `${name} 概率必须有限`);
    assert.ok(v >= 0 && v <= 1, `${name} 概率必须在 [0,1]：${v}`);
  }
  assert.ok(
    Math.abs(f + c + r - 1) < 1e-12,
    `概率守恒必须成立：${f} + ${c} + ${r} = ${f + c + r}`,
  );

  const callSum = built.callEntries.reduce((a, x) => a + x.probability, 0);
  const rrSum = built.reRaiseEntries.reduce((a, x) => a + x.probability, 0);
  if (built.callEntries.length > 0) {
    assert.ok(Math.abs(callSum - 1) < 1e-12, `跟注桶条件范围必须归一化：${callSum}`);
  }
  if (built.reRaiseEntries.length > 0) {
    assert.ok(Math.abs(rrSum - 1) < 1e-12, `再加注桶条件范围必须归一化：${rrSum}`);
  }
  /* 桶的质量与概率必须一致（质量口径，不是组合数口径） */
  const callMassFromBucket = built.callLikelihood;
  const callMassFromEntries = built.callEntries.length === 0 ? 0 : callMassFromBucket;
  assert.equal(callMassFromBucket, callMassFromEntries);
  /* 桶的组合数只能是可达组合的子集 */
  assert.ok(built.callCombos + built.reRaiseCombos <= built.reachableCombos + 1e-9);
});

test('B-03b：价格越高，继续的比例只能越低（价格单调性）', () => {
  const arrival = controlledArrival(BTN_OPEN_WEIGHTS);
  const build = (villainAdd: number, finalPot: number): PreflopRaiseResponse => {
    const r = buildPreflopRaiseResponse({
      arrivalEntries: arrival,
      currentPot: 3.5 * BB,
      heroAdd: 7.5 * BB,
      villainAdd,
      finalPot,
      tendencies: NEUTRAL,
      heroIsAllIn: false,
      villainIsAllInByCall: false,
    });
    assert.notEqual(r, null);
    return r!;
  };
  /* 同一份范围、同一个终池量级 ⇒ 他要补得越多，继续的越少 */
  const cheap = build(2 * BB, 13 * BB);
  const pricey = build(6 * BB, 17 * BB);
  assert.ok(
    cheap.foldLikelihood < pricey.foldLikelihood,
    `价格越高弃牌率必须越高：便宜 ${cheap.foldLikelihood} vs 昂贵 ${pricey.foldLikelihood}`,
  );
  assert.ok(cheap.priceRequiredEquity < pricey.priceRequiredEquity, '所需权益必须随价格上升');
  assert.equal(cheap.margin, PREFLOP_CONTINUE_MARGIN);
});

test('B-03c：再加注概率必须在闸门之上才为正；Hero 全下或他跟平即全下时恒为 0', () => {
  const arrival = controlledArrival(BTN_OPEN_WEIGHTS);
  const common = {
    arrivalEntries: arrival,
    currentPot: 3.5 * BB,
    heroAdd: 7.5 * BB,
    villainAdd: 5 * BB,
    finalPot: 16 * BB,
    tendencies: NEUTRAL,
  } as const;

  const normal = buildPreflopRaiseResponse({ ...common, heroIsAllIn: false, villainIsAllInByCall: false })!;
  const heroAllIn = buildPreflopRaiseResponse({ ...common, heroIsAllIn: true, villainIsAllInByCall: false })!;
  const villainAllIn = buildPreflopRaiseResponse({ ...common, heroIsAllIn: false, villainIsAllInByCall: true })!;

  assert.ok(normal.reRaiseLikelihood > 0, '正常情形下必须有非零的再加注概率（否则闸门形同虚设）');
  assert.equal(heroAllIn.reRaiseLikelihood, 0, 'Hero 全下 ⇒ 他不能再加注');
  assert.equal(villainAllIn.reRaiseLikelihood, 0, '他跟平即全下 ⇒ 他不能再加注');
  assert.equal(heroAllIn.reRaiseEntries.length, 0, 'rr = 0 时不得产出再加注桶');
  /* 加注权重必须**迁移到跟注**，不是从条件范围里消失 */
  assert.ok(
    Math.abs(heroAllIn.callLikelihood - normal.callLikelihood) < 1e-12
      || heroAllIn.callLikelihood >= normal.callLikelihood,
    `Hero 全下时加注权重必须迁移到跟注：${normal.callLikelihood} → ${heroAllIn.callLikelihood}`,
  );
  assert.ok(
    Math.abs(heroAllIn.callLikelihood + heroAllIn.foldLikelihood - 1) < 1e-12,
    'Hero 全下时只应剩下弃牌与跟注',
  );

  /* 闸门以下的组合不得进入再加注桶 */
  const gateKeys = new Set(
    normal.reRaiseEntries.map((e) => rankClassOfIndices(e.cardIndices as unknown as readonly [number, number])),
  );
  for (const key of gateKeys) {
    assert.ok(
      preflopStrengthOf(key) >= PREFLOP_RERAISE_GATE - 1e-12,
      `进入再加注桶的类别必须在闸门之上：${key}（${preflopStrengthOf(key)}）`,
    );
  }
});

/* ============================================================
 * 三、事实包：逐尺寸 EV、独立复算、口径一致
 * ============================================================ */

test('B-01：**每一个**加注尺寸都必须拥有属于它自己的响应概率、条件范围与 EV', () => {
  const state = bbVsBtnOpen();
  const facts = mustFacts(state);
  const hero = state.players.find((p) => p.id === 'bb')!;
  const legal = deriveLegalActions(state, hero);
  const grid = buildSizeGrid(legal, computePot(state), 'RAISE');

  assert.ok(grid.length >= 3, `夹具的网格应有多个尺寸，实测 ${grid.length}`);
  assert.equal(
    facts.sizes.length,
    grid.length,
    `事实包必须覆盖网格里的**每一个**尺寸（网格 ${grid.length}，事实 ${facts.sizes.length}）`,
  );
  for (const option of grid) {
    const size = facts.sizes.find((s) => s.sizeChips === option.toAmount);
    assert.notEqual(size, undefined, `网格尺寸 ${option.toAmount} 必须有事实`);
    assert.notEqual(size!.raiseEV, null, `尺寸 ${option.toAmount} 的 EV 不得为 null`);
  }
  /* 每个尺寸的量必须各不相同（防止「把 12BB 的 EV 挂到 9BB 上」） */
  const evs = facts.sizes.map((s) => s.raiseEV);
  const unique = new Set(evs.map((v) => (v === null ? 'null' : v.toFixed(6))));
  assert.ok(unique.size >= Math.min(3, evs.length), `各尺寸的 EV 必须真的不同：${JSON.stringify(evs)}`);
});

test('B-04：RAISE EV 必须能由**独立复算**得到（三项分解之和，零点是弃牌 ≡ 0）', () => {
  const state = bbVsBtnOpen();
  const facts = mustFacts(state);

  for (const size of facts.sizes) {
    assert.notEqual(size.raiseEV, null);
    /*
     * 🔴 **独立复算**：不复用生产公式，而是从事实包里**逐项**
     * 用最朴素的方式把三项加起来，再与生产 EV 比对。
     * 生产公式若漏掉某一项（例如忘了扣累计投入），这里会红。
     */
    const foldTerm = size.foldLikelihood * size.currentPot;
    const callTerm =
      size.callLikelihood
      * (size.heroEquityVsRaiseCallRange.value! * size.finalPot - size.heroContestedAdd);
    const rrTerm = size.reRaiseLikelihood * size.reraiseBranchEV;
    const recomputed = foldTerm + callTerm + rrTerm;
    assert.ok(
      Math.abs(recomputed - size.raiseEV!) < 1e-9,
      `尺寸 ${size.sizeBB}BB：独立复算 ${recomputed} ≠ 生产 ${size.raiseEV}`,
    );

    /* 权重必须守恒（三项系数之和为 1） */
    const weightSum = size.foldLikelihood + size.callLikelihood + size.reRaiseLikelihood;
    assert.ok(Math.abs(weightSum - 1) < 1e-12, `尺寸 ${size.sizeBB}BB 的权重不守恒：${weightSum}`);

    /* 终池必须等于「当前底池 + 我被跟注的投入 + 他补的投入」 */
    assert.equal(
      size.finalPot,
      size.currentPot + size.heroContestedAdd + size.villainAdd,
      `尺寸 ${size.sizeBB}BB 的终池口径不一致`,
    );
    /* 退回 = 新增 − 被跟注（不得为负、不得用于抵扣损失） */
    assert.equal(size.uncalledReturn, Math.max(0, size.heroAdd - size.heroContestedAdd));
    assert.ok(size.heroContestedAdd <= size.heroAdd + 1e-12, '被跟注量不得超过我的新增投入');
  }
});

test('B-04b：生产 EV 与**全项目唯一的**现金流公式逐位一致', () => {
  const state = bbVsBtnOpen();
  const facts = mustFacts(state);
  assert.equal(
    facts.cashflowContract,
    CASHFLOW_CONTRACT,
    '翻前加注事实包的资金口径契约必须与 U1 的加注 EV 契约**同一字面值**',
  );

  for (const size of facts.sizes) {
    const viaShared = raiseEVOf({
      foldLikelihood: size.foldLikelihood,
      callLikelihood: size.callLikelihood,
      reRaiseLikelihood: size.reRaiseLikelihood,
      currentPot: size.currentPot,
      heroContestedAdd: size.heroContestedAdd,
      finalPot: size.finalPot,
      equityVsRaiseCall: size.heroEquityVsRaiseCallRange.value!,
      reraiseBranchEV: size.reraiseBranchEV,
    });
    assert.ok(
      Math.abs(viaShared - size.raiseEV!) < 1e-9,
      `尺寸 ${size.sizeBB}BB：共享公式 ${viaShared} ≠ 事实包 ${size.raiseEV}`,
    );
  }
});

test('B-04c：被再加注分支必须与其它分支**同一零点**（不是后续节点的局部 EV）', () => {
  const state = bbVsBtnOpen();
  const facts = mustFacts(state, { equity: { call: 0.6, reraise: 0.9 } });
  assert.equal(facts.cashflowContract, CASHFLOW_CONTRACT);

  for (const size of facts.sizes) {
    assert.equal(
      size.reraiseFoldBranchEV,
      -size.heroContestedAdd,
      `Hero 弃牌分支必须 = −留在池中的投入（尺寸 ${size.sizeBB}BB）`,
    );
    if (size.reraiseCallBranchEV !== null) {
      /*
       * 🔴 独立复算是**不可行**的（需要重新跑引擎推进与分层底池），
       * 因此这里断言两条**结构性**性质，它们足以抓住「漏扣成本」这一类错误：
       *
       * 1. 跟注分支必须**低于**「权益 × 跟注后我能争夺到的量」——
       *    因为还要扣掉累计新增投入（本次加注 + 再跟注）；
       * 2. 跟注分支必须**高于**弃牌分支（否则它不可能被 `max` 选中，
       *    而生产代码会把它标成 `CALL` 分支 ⇒ 标注与取值互相矛盾）。
       */
      const upperWithoutCost =
        size.heroEquityVsReraiseRange.value! * (size.finalPot + size.heroAdditionalCallVsReRaise!);
      assert.ok(
        size.reraiseCallBranchEV < upperWithoutCost - 1e-9,
        `再加注跟注分支必须扣掉累计新增投入（尺寸 ${size.sizeBB}BB）：`
          + `${size.reraiseCallBranchEV} 应 < ${upperWithoutCost}`,
      );
      if (size.reraiseBranchKind === 'CALL') {
        assert.ok(
          size.reraiseCallBranchEV > size.reraiseFoldBranchEV + 1e-9,
          '被标成 CALL 分支时就注值必须真的高于弃牌分支',
        );
      }
    }
    assert.equal(
      size.reraiseBranchEV,
      size.reraiseCallBranchEV === null
        ? size.reraiseFoldBranchEV
        : Math.max(size.reraiseFoldBranchEV, size.reraiseCallBranchEV),
      `被再加注分支的取值必须是 max(弃牌, 跟注) 或退化为弃牌下界（尺寸 ${size.sizeBB}BB）`,
    );
    /* 🔴 必须如实声明「Hero 的 5Bet 未展开」 */
    assert.equal(size.heroFiveBetExpanded, false);
    if (size.reraiseAvailable) {
      assert.notEqual(size.reRaiseTo, null, '有再加注分支时必须有代表尺寸');
      assert.ok(size.reRaiseTo! > size.sizeChips, '他的再加注必须高于我的加注额');
      assert.notEqual(size.heroAdditionalCallVsReRaise, null);
    }
  }
});

test('B-04d：再加注尺寸必须由**真实行动状态**推导（最小完整加注 vs 他的全下上限）', () => {
  /* 纯函数：最小完整再加注 = 我的加注额 + (我的加注额 − 他加注前的本街投入) */
  const plan = preflopReRaiseToOf({
    raiseTo: 10 * BB,
    villainCommittedBefore: 2.5 * BB,
    villainStreetTotalAfterCall: 10 * BB,
    villainRemainingAfterCall: 90 * BB,
  });
  assert.equal(plan.minReRaiseTo, 10 * BB + (10 * BB - 2.5 * BB), '最小完整再加注 = 10 + (10 − 2.5)');
  assert.equal(plan.reRaiseTo, plan.minReRaiseTo, '他买得起完整再加注时必须取最小完整加注');
  assert.equal(plan.isAllIn, false);

  /* 他买不起完整再加注 ⇒ 只能全下（under-raise）；那条法律上仍有效 */
  const short = preflopReRaiseToOf({
    raiseTo: 10 * BB,
    villainCommittedBefore: 2.5 * BB,
    villainStreetTotalAfterCall: 10 * BB,
    villainRemainingAfterCall: 3 * BB,
  });
  assert.equal(short.reRaiseTo, 13 * BB, '短筹码只能全下到 13BB');
  assert.equal(short.isAllIn, true);
  assert.ok(short.villainMaxTo < short.minReRaiseTo, '短码局面下他的上限必须低于最小完整加注');
});

test('B-02：事实包必须覆盖**多个**尺寸，且「chosenSizeChips」必须落在网格里', () => {
  const state = bbVsBtnOpen();
  const facts = mustFacts(state);
  const hero = state.players.find((p) => p.id === 'bb')!;
  const legal = deriveLegalActions(state, hero);
  const grid = buildSizeGrid(legal, computePot(state), 'RAISE');

  assert.ok(facts.sizes.length >= 5, `阶段 B 的目标是「多个尺寸各有 EV」，实测 ${facts.sizes.length} 个`);
  assert.notEqual(facts.chosenSizeChips, null);
  assert.ok(
    grid.some((o) => o.toAmount === facts.chosenSizeChips),
    `被选中的诊断尺寸 ${facts.chosenSizeChips} 必须真的在合法网格里`,
  );
  /* 每个尺寸的 noteZh 必须写明它自己的数字（不得是共享文案） */
  const notes = new Set(facts.sizes.map((s) => s.noteZh));
  assert.equal(notes.size, facts.sizes.length, '每个尺寸的说明必须各不相同');
});

/* ============================================================
 * 四、口径与安全门
 * ============================================================ */

test('B-06：尺寸对不上时**不得**借用其它尺寸的 EV（同源判据）', () => {
  const state = bbVsBtnOpen();
  const facts = mustFacts(state);

  const first = facts.sizes[0]!;
  const okEval = evaluatePreflopRaiseModel({
    facts,
    candidateSizeChips: first.sizeChips,
    actionIsRaiseLike: true,
  });
  assert.equal(okEval.usable, true, '网格内的尺寸必须可用');

  /* 一个不在网格里的金额（例如最小加注额 −1BB）必须判为不可用 */
  const bogus = evaluatePreflopRaiseModel({
    facts,
    candidateSizeChips: first.sizeChips - 1,
    actionIsRaiseLike: true,
  });
  assert.equal(bogus.usable, false, '网格外的金额不得使用事实包里的 EV');
  assert.ok(bogus.unavailableZh!.includes('不得'), `不可用原因必须点明「不得借用」：${bogus.unavailableZh}`);

  /* 非加注动作不得使用 */
  const nonRaise = evaluatePreflopRaiseModel({
    facts,
    candidateSizeChips: first.sizeChips,
    actionIsRaiseLike: false,
  });
  assert.equal(nonRaise.usable, false);

  /* 契约不符的事实包不得使用（模拟旧口径缓存） */
  const forged = { ...facts, cashflowContract: 'NODE_INCREMENTAL_CHIPS_V1' } as PreflopRaiseFacts;
  const rejected = evaluatePreflopRaiseModel({
    facts: forged,
    candidateSizeChips: first.sizeChips,
    actionIsRaiseLike: true,
  });
  assert.equal(rejected.usable, false, '资金口径契约不符时必须拒绝');
  assert.ok(rejected.unavailableZh!.includes('契约'));
});

test('B-09：不是单挑 / 身后有人时**必须明确拒绝**，不得偷偷按单挑算', () => {
  const state = bbVsBtnOpen();

  /* 身后还有人未行动 */
  const behind = factsOf(state, { playersRemainingToAct: 1 });
  assert.equal(behind.ok, false);
  if (!behind.ok) {
    assert.equal(behind.reason, 'PLAYERS_BEHIND');
    assert.ok(behind.noteZh.includes('未行动'), `说明必须点明身后有人：${behind.noteZh}`);
  }

  /* 三个活跃对手（HJ 跟注进来） */
  const threeWay = (() => {
    let s = createGame({
      id: 'three-way',
      config: { tableSize: TableSize.SIX_MAX, smallBlind: BB / 2, bigBlind: BB, ante: 0, dealerPosition: Position.BTN },
      players: [Position.UTG, Position.HJ, Position.CO, Position.BTN, Position.SB, Position.BB].map((position) => ({
        id: position.toLowerCase(),
        name: position,
        position,
        startingStack: 100 * BB,
        holeCards: position === Position.BB ? C('As Ah') : null,
      })),
      userPlayerId: 'bb',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const act = (playerId: string, type: 'FOLD' | 'RAISE' | 'CALL' | 'CHECK', amount?: number): void => {
      const r = applyAction(s, { playerId, type, ...(amount === undefined ? {} : { amount }) } as never);
      assert.equal(r.ok, true);
      if (r.ok) s = r.state;
    };
    act('utg', 'FOLD');
    act('hj', 'CALL', BB);
    act('co', 'FOLD');
    act('btn', 'RAISE', Math.round(2.5 * BB));
    act('sb', 'FOLD');
    return s;
  })();

  const multi = factsOf(threeWay);
  assert.equal(multi.ok, false, '多人池不得产出翻前加注事实包');
  if (!multi.ok) {
    assert.equal(multi.reason, 'NOT_HEADS_UP');
    assert.ok(multi.noteZh.includes('不偷偷按单挑算') || multi.noteZh.includes('单挑'), multi.noteZh);
  }
});

test('B-09b：拒绝原因的中文说明必须齐备（不得有空文案）', () => {
  for (const [key, value] of Object.entries(PREFLOP_RAISE_SKIP_ZH)) {
    assert.ok(typeof value === 'string' && value.length >= 6, `${key} 的说明过短：「${value}」`);
  }
});

/* ============================================================
 * 五、不等筹码、恰好跟注全下、超额退回
 * ============================================================ */

test('B-08：不等筹码时超额部分不得被算成损失（退回不计入投入）', () => {
  /*
   * Hero BB 200BB、BTN 只有 12BB。BTN 开池 2.5BB ⇒ Hero 可以做很大的加注，
   * 但 BTN 最多只能跟到 12BB ⇒ 超出部分**退回**，不得计入 `heroContestedAdd`。
   *
   * ⚠️ 上限来自 `allInToAmount = 我已投入 + 我的剩余筹码` —— 与**他**的筹码无关。
   * 这正是本测试要盯的口径：金额本身不受对手筹码限制，
   * 但**被跟注的量**受他的筹码限制。
   */
  const state = bbVsBtnOpen({ stacksByPosition: { [Position.BB]: 200 * BB, [Position.BTN]: 12 * BB } });
  const hero = state.players.find((p) => p.id === 'bb')!;
  const legal = deriveLegalActions(state, hero);
  assert.ok(legal.callCost > 0, '夹具必须处于面对开池的节点');

  const facts = mustFacts(state);
  assert.ok(facts.sizes.length > 0);
  const withReturn = facts.sizes.filter((s) => s.heroContestedAdd < s.heroAdd - 1e-9);
  assert.ok(
    withReturn.length > 0,
    `夹具必须真的产生退回：${facts.sizes.map((s) => `${s.sizeBB}BB:${s.heroAdd}/${s.villainAdd}`).join(' ')}`,
  );

  for (const size of withReturn) {
    /*
     * 🔴 **2026-09-22 修正**：旧断言写的是 `heroContestedAdd === villainAdd`，
     * 那**只在他被自己的剩余筹码封顶时才成立**，不是通例。
     *
     * `villainAdd` = 「他跟注要补的**差价**」；`heroContestedAdd` = 「双方能**匹配**的量」。
     *
     * ```text
     * 我本街已投 250、他本街已投 900
     * 我加注到 1550 ⇒ heroAdd = 1300
     *   他要补 1550 − 900 = 650           ⇒ villainAdd = 650
     *   他跟平后本街 1550、我已投 250      ⇒ 我能再匹配 1300
     *   ⇒ heroContestedAdd = min(1300, 1300) = **1300**（不是 650）
     * ```
     *
     * 旧写法把 650 当成被匹配量 ⇒ `finalPot` 少 650
     * （引擎台账真值 3250 vs 修复前 2600）。现在断言真正的一般式。
     */
    const villainStreetTotalAfterCall = size.villainStreetCommitted + size.villainAdd;
    assert.equal(
      size.heroContestedAdd,
      Math.min(size.heroAdd, villainStreetTotalAfterCall - size.heroStreetCommitted),
      `被跟注量必须是「双方本街总额较小者的可匹配部分」（尺寸 ${size.sizeBB}BB）`,
    );
    assert.equal(
      size.uncalledReturn,
      size.heroAdd - size.heroContestedAdd,
      '退回 = 我新增 − 被匹配量',
    );
    assert.ok(size.uncalledReturn > 0, '进了这个分支就必须真的有退回');
    /*
     * 终池口径自洽：`pot0 + 我的匹配量 + 他实际匹配的量`。
     */
    assert.equal(
      size.finalPot,
      size.currentPot + size.heroContestedAdd + Math.min(size.villainAdd, size.heroContestedAdd),
      `终池口径必须自洽（尺寸 ${size.sizeBB}BB）`,
    );

    /*
     * 🔴 关键断言：退回的筹码**不得**被算成损失。
     * EV 的跟注项用的是 `heroContestedAdd`（被跟注的那部分），不是 `heroAdd`；
     * 用后者会把退回的钱当成损失，从而系统性低估大额加注。
     */
    const withContested = size.foldLikelihood * size.currentPot
      + size.callLikelihood * (size.heroEquityVsRaiseCallRange.value! * size.finalPot - size.heroContestedAdd)
      + size.reRaiseLikelihood * size.reraiseBranchEV;
    const withHeroAdd = size.foldLikelihood * size.currentPot
      + size.callLikelihood * (size.heroEquityVsRaiseCallRange.value! * size.finalPot - size.heroAdd)
      + size.reRaiseLikelihood * size.reraiseBranchEV;
    assert.ok(
      Math.abs(withContested - size.raiseEV!) < 1e-9,
      `生产 EV 必须使用「被跟注量」而不是「新增量」（尺寸 ${size.sizeBB}BB）`,
    );
    assert.ok(
      withHeroAdd < withContested,
      '用新增量会把退回当损失（本断言证明两者确实不同，所以上面那条不是恒真）',
    );

    if (size.villainIsAllInByCall) {
      assert.equal(size.reRaiseLikelihood, 0, '他跟平即全下 ⇒ 再加注概率必须为 0');
      assert.equal(size.reraiseAvailable, false, '他跟平即全下 ⇒ 不得生成再加注分支');
    }
  }

  /* 最大的尺寸必须真的让对手跟平即全下（短码局面的必经形态） */
  const biggest = facts.sizes[facts.sizes.length - 1]!;
  assert.equal(biggest.isAllIn, true, '最大尺寸必须是全下');
  assert.equal(biggest.villainIsAllInByCall, true, '短码对手面对全下必然跟平即全下');
  assert.equal(biggest.reRaiseLikelihood, 0);
});

test('B-08b：等筹码时退回的口径必须正确 —— 退回只出现在「他匹配不满我的新增」时', () => {
  /*
   * ⚠️ 这里刻意**不**断言「等筹码 ⇒ 退回恒为 0」。
   *
   * 那个直觉是错的，而这个夹具正好暴露它：Hero 在大盲位已经被迫投了 1BB。
   * 面对 BTN 开池 2.5BB 时加注到 4BB ——
   *
   * ```text
   * 我本街已投 1BB、他本街已投 2.5BB
   * 我新增 = 4 − 1   = 3BB
   * 他要补 = 4 − 2.5 = 1.5BB          ← 这是「差价」，不是「被匹配量」
   * ```
   *
   * 🔴 **2026-09-22 修正**：旧注释由此推出
   * 「`heroContestedAdd = min(3, 1.5) = 1.5BB`，确实存在退回」——**这是错的**。
   * 他补完 1.5BB 后本街总额就是 4BB，而我只投了 1BB ⇒ 我还能再匹配 3BB，
   * 于是 `heroContestedAdd = min(3, 4 − 1) = min(3, 3) = **3BB**`，
   * **退回为 0**。等筹码、且他匹配得起时，本来就不该有退回。
   *
   * 「是否退回」的判据是 `heroAdd > 他能匹配的量`，
   * 而「他能匹配的量」= `他跟平后本街总额 − 我本街已投`，
   * **不是** `villainAdd`（那只是他要补的差价）。
   *
   * 真正该锁的不变量是：
   * 1. `heroContestedAdd === min(heroAdd, 他跟平后本街总额 − 我本街已投)`（逐尺寸）；
   * 2. 退回出现在且仅出现在 `heroAdd > 他能匹配的量` 时；
   * 3. 退回恒等于 `heroAdd − heroContestedAdd` 且非负；
   * 4. `finalPot === currentPot + heroContestedAdd + min(villainAdd, heroContestedAdd)`。
   */
  const state = bbVsBtnOpen();
  const facts = mustFacts(state);
  assert.ok(facts.sizes.length > 0);

  for (const size of facts.sizes) {
    const matchable = size.villainStreetCommitted + size.villainAdd - size.heroStreetCommitted;
    assert.equal(
      size.heroContestedAdd,
      Math.min(size.heroAdd, matchable),
      `尺寸 ${size.sizeBB}BB 的被匹配量必须是 min(我新增, 他能匹配的量)`,
    );
    assert.equal(size.uncalledReturn, size.heroAdd - size.heroContestedAdd);
    assert.ok(size.uncalledReturn >= 0);
    if (size.heroAdd > matchable) {
      assert.ok(size.uncalledReturn > 0, `我新增超过他能匹配的量时必须产生退回（尺寸 ${size.sizeBB}BB）`);
    } else {
      assert.equal(size.uncalledReturn, 0, `他匹配得起时不得产生退回（尺寸 ${size.sizeBB}BB）`);
    }
    /* 终池口径：当前底池 + 我的匹配量 + 他实际匹配的量 */
    assert.equal(
      size.finalPot,
      size.currentPot + size.heroContestedAdd + Math.min(size.villainAdd, size.heroContestedAdd),
    );
  }

  /*
   * 本夹具（我大盲、他开池）里，我的新增与他要补的量的关系：
   *
   * 🔴 **2026-09-22 修正**：旧注释写「每一个尺寸的我的新增都大于他要补的量
   * ⇒ 每个尺寸都有退回」—— 那个推论把 `villainAdd`（差价）当成了
   * 「他能匹配的量」，因此**结论是错的**：他匹配得起时退回为 0。
   * 现在只锁真正成立的那条几何关系（`heroAdd > villainAdd`），
   * 它成立的原因是「我本街已投比他少 1.5BB」，**不**蕴含退回。
   */
  assert.ok(
    facts.sizes.every((s) => s.heroAdd > s.villainAdd),
    '本夹具的几何：我的新增大于他要补的差价（因为我本街已投更少）',
  );
});

/* ============================================================
 * 六、公共信息：**规则**不得读 Hero 的底牌
 * ============================================================ */

/**
 * ## 为什么本条不再断言「换底牌后概率逐位不变」
 *
 * 那一条**说法本身是错的**，已在 2026-09-22 的验收规范里明确排除：
 *
 * - **不必要**：Hero 的底牌是**公共信息**（他自己知道），对手范围里
 *   与它冲突的组合会被移除并**重新归一化** —— 概率变了是**合法**的。
 * - **不充分**：概率完全不变也排除不了「规则确实读了底牌但恰好没改变输出」。
 *
 * 正确的判据拆成两条：
 *
 * | 编号 | 判据 |
 * |---|---|
 * | **B-07**（本条） | 固定「对手组合 / 公共牌 / 模型参数 / 被消费的画像参数」后，**产出概率的规则**不得读 Hero 的底牌 |
 * | **B-07b**（下一条） | 换底牌后任何概率变化都必须**完全由「移除被挡组合 + 重归一化」解释**，且可逐位复算 |
 *
 * ## 本条怎么做到「真的换了底牌」
 *
 * 修复前这条测试的 `build()` **根本不接收底牌**、调用两次比的是它自己；
 * 而且两处 `facts` 用的是**同一个 state** ⇒ **从未换过 Hero 的底牌**，
 * 是一条零覆盖的空测试（名册上 20/20 通过，实际什么都没验）。
 *
 * 现在：底牌**真的换了**（三组），而且**显式断言它换成功了**（否则
 * 一旦夹具退化，这条又会悄悄变成空测试）；期望值来自**规则本身**的
 * 独立调用，不是把生产的输出再读一遍。
 */
test('B-07：🔴 响应规则本身不得读 Hero 底牌（规则层直调，输入里根本没有底牌）', () => {
  /*
   * `buildPreflopRaiseResponse` 的**声明输入里没有底牌字段**：
   *
   * ```ts
   * { arrivalEntries, currentPot, heroAdd, villainAdd, finalPot,
   *   tendencies, heroIsAllIn, villainIsAllInByCall }
   * ```
   *
   * 因此同一份到达范围必然给同一份输出 —— 这一条是**类型层可验证**的，
   * 不需要「换底牌再比对」那种间接手法。
   */
  const arrival = controlledArrival(BTN_OPEN_WEIGHTS);
  const build = (): PreflopRaiseResponse =>
    buildPreflopRaiseResponse({
      arrivalEntries: arrival,
      currentPot: 3.5 * BB,
      heroAdd: 7.5 * BB,
      villainAdd: 5 * BB,
      finalPot: 16 * BB,
      tendencies: NEUTRAL,
      heroIsAllIn: false,
      villainIsAllInByCall: false,
    })!;

  const a = build();
  const b = build();
  assert.equal(a.foldLikelihood, b.foldLikelihood);
  assert.equal(a.callLikelihood, b.callLikelihood);
  assert.equal(a.reRaiseLikelihood, b.reRaiseLikelihood);
  assert.deepEqual(
    a.callEntries.map((e) => [e.cardIndices[0], e.cardIndices[1], e.probability]),
    b.callEntries.map((e) => [e.cardIndices[0], e.cardIndices[1], e.probability]),
  );

  /*
   * 反证：规则**确实在算**（否则上面的「一致」可能只是常量）。
   * 换一份到达范围，输出必须变。
   */
  const other = buildPreflopRaiseResponse({
    arrivalEntries: controlledArrival({ AA: 1, KK: 1, '72o': 1 }),
    currentPot: 3.5 * BB,
    heroAdd: 7.5 * BB,
    villainAdd: 5 * BB,
    finalPot: 16 * BB,
    tendencies: NEUTRAL,
    heroIsAllIn: false,
    villainIsAllInByCall: false,
  })!;
  assert.notEqual(
    other.foldLikelihood,
    a.foldLikelihood,
    '换到达范围必须改变输出 —— 否则这条测试证明不了任何事',
  );
});

/**
 * B-07b：事实包对 Hero 底牌的**唯一**合法依赖是「移除被挡组合 + 重归一化」，
 * 且后果必须**能被独立复算逐位重现**。
 *
 * ## 为什么不能断言「换底牌后概率逐位不变」
 *
 * 那条说法已被明确否决，实测也证明它是错的：
 *
 * ```text
 * 同一份受控到达范围（9 个组合），换 Hero 底牌：
 *   As Ah ⇒ reachableCombos 9（AA 类里没有与 As/Ah 冲突的组合）
 *   7c 2d ⇒ reachableCombos 7、arrival.mass 0.7778   ← 两个组合被挡掉
 *   Ah Ad ⇒ reachableCombos 8、arrival.mass 0.8889
 * ```
 *
 * Hero 的底牌是**公共信息**（他自己看得见），范围里与它冲突的组合本就不该
 * 存在；移除后重新归一化是**合法且必须**的。因此正确的判据是：
 * **变化必须能被「死牌 → 移除 → 重归一化」完整解释**，而不是「不许变」。
 *
 * ## 复算配方（只用声明输入，不复用生产的中间量）
 *
 * ```text
 * 1. 死牌集 = Hero 底牌 ∪ 公共牌（翻前无公共牌）
 * 2. 保留 = 受控到达范围里与死牌集不冲突的组合，权重不变
 * 3. 归一化 ⇒ Σp = 1，喂给**同一个规则函数**
 * 4. 期望 = 该规则的输出；实测 = 事实包的输出 ⇒ 必须逐位一致
 * ```
 */
test('B-07b：事实包换底牌后的变化必须由「死牌 + 重归一化」逐位复算（独立来源）', () => {
  const heroVariants = ['As Ah', '7c 2d', 'Ah Ad'] as const;
  /* 刻意选一组**不与任何受控组合冲突**的底牌做对照 */
  const nonBlocking = '2h 3h';

  const controlled = controlledArrival(BTN_OPEN_WEIGHTS);

  /** 独立复算：按声明的死牌集移除 + 重归一化，得到「期望的到达范围」 */
  const expectedArrival = (heroCards: string) => {
    const dead = deadCardsFrom(C(heroCards));
    const kept = controlled.filter(
      (e) => !dead.has(e.cardIndices[0]) && !dead.has(e.cardIndices[1]),
    );
    const mass = kept.reduce((n, e) => n + e.probability, 0);
    return { kept, mass, normalized: kept.map((e) => ({ ...e, probability: e.probability / mass })) };
  };

  const seen = new Set<string>();
  for (const hc of [...heroVariants, nonBlocking]) {
    const state = bbVsBtnOpen({ heroCards: hc });
    /* ① 先证明底牌**真的换了** —— 防止夹具退化把这条变成空测试 */
    const hero = state.players.find((p) => p.id === 'bb')!;
    const actual = hero.holeCards!.map((c) => `${c.rank}${c.suit}`).sort().join('');
    assert.equal(seen.has(actual), false, `夹具底牌必须互不相同（${hc} 与已有重复）`);
    seen.add(actual);

    const facts = mustFacts(state, { arrival: controlled, equity: { call: 0.6 } });

    /* ② 组合数必须等于独立复算的保留数 */
    const exp = expectedArrival(hc);
    assert.equal(
      facts.arrival.comboCount,
      exp.kept.length,
      `${hc}：事实包的到达组合数必须等于「受控到达范围去掉被挡组合」的数量`,
    );

    /*
     * ③ 期望值来自**独立复算的范围 + 同一个规则函数**，
     *    而不是把事实包的输出再读一遍。
     *
     * ⚠️ 用 1e-12 容差而不是逐位相等：两侧都对同一批组合做归一化，
     * 但**求和顺序不同**（生产的权重表顺序 vs 测试的受控顺序），
     * 实测最大偏差 3e-16 —— 那是浮点求和顺序的噪声，不是口径差异。
     * 这个容差比任何有决策意义的差异（≥1e-4）小 8 个数量级。
     */
    const TOL = 1e-12;
    for (const size of facts.sizes) {
      const expectedResponse = buildPreflopRaiseResponse({
        arrivalEntries: exp.normalized,
        currentPot: size.currentPot,
        heroAdd: size.heroAdd,
        villainAdd: size.villainAdd,
        finalPot: size.finalPot,
        tendencies: NEUTRAL,
        heroIsAllIn: size.heroIsAllIn,
        villainIsAllInByCall: size.villainIsAllInByCall,
      })!;
      assert.ok(
        Math.abs(size.foldLikelihood - expectedResponse.foldLikelihood) < TOL,
        `${hc} 尺寸 ${size.sizeChips}：弃牌概率必须能由「死牌+重归一化」复算`
          + `（实测 ${size.foldLikelihood} vs 复算 ${expectedResponse.foldLikelihood}）`,
      );
      assert.ok(
        Math.abs(size.callLikelihood - expectedResponse.callLikelihood) < TOL,
        `${hc} 尺寸 ${size.sizeChips}：跟注概率必须能复算（${size.callLikelihood} vs ${expectedResponse.callLikelihood}）`,
      );
      assert.ok(
        Math.abs(size.reRaiseLikelihood - expectedResponse.reRaiseLikelihood) < TOL,
        `${hc} 尺寸 ${size.sizeChips}：再加注概率必须能复算（${size.reRaiseLikelihood} vs ${expectedResponse.reRaiseLikelihood}）`,
      );
    }
  }

  /* ④ 对照：不挡任何组合的底牌 ⇒ 到达范围必须与复算完全一致（组合数不变） */
  const nonBlockingFacts = mustFacts(bbVsBtnOpen({ heroCards: nonBlocking }), {
    arrival: controlled,
    equity: { call: 0.6 },
  });
  assert.equal(
    nonBlockingFacts.arrival.comboCount,
    controlled.length,
    `${nonBlocking} 不挡任何组合 ⇒ 到达组合数必须与受控范围相同`,
  );

  /* ⑤ 反证：死牌集为空时不得移除任何组合（证明移除确实由死牌驱动） */
  const noDead = removeBlockedCombos(expandRankClass('AA'), emptyDeadCards());
  assert.equal(noDead.removedCount, 0, '无死牌时不得移除任何组合');
  const withDead = removeBlockedCombos(expandRankClass('AA'), deadCardsFrom(C('As Ah')));
  assert.ok(withDead.removedCount > 0, 'AsAh 必须移除 AA 类里的组合');

  /* ⑥ 变化本身是**允许**的：至少有一组底牌真的改变了组合数 */
  const counts = [...heroVariants, nonBlocking].map((hc) => (hc === nonBlocking ? controlled.length : expectedArrival(hc).kept.length));
  assert.ok(
    new Set(counts).size > 1,
    `换底牌允许改变组合数（这正是被否决那条表述搞错的地方），实测 ${counts.join(' / ')}`,
  );
});

/* ============================================================
 * 七、可复现
 * ============================================================ */

test('B-10：相同输入必须可复现（逐位一致）', () => {
  const state = bbVsBtnOpen();
  const a = mustFacts(state);
  const b = mustFacts(state);
  assert.deepEqual(
    a.sizes.map((s) => [s.sizeChips, s.foldLikelihood, s.callLikelihood, s.reRaiseLikelihood, s.raiseEV]),
    b.sizes.map((s) => [s.sizeChips, s.foldLikelihood, s.callLikelihood, s.reRaiseLikelihood, s.raiseEV]),
    '相同输入必须逐位复现',
  );
  assert.equal(a.modelVersion, b.modelVersion);
  assert.equal(a.version, b.version);
});

/* ============================================================
 * 八、阶段 A 回归：2.5 → 10 → 22 之后的最小再加注
 * ============================================================ */

test('A-01：开池 2.5 → 3Bet 10 → 4Bet 22 之后，最小再加注必须是 34BB，32BB 必须被拒', () => {
  const state = bbVsBtnFourBet(10, 22);
  const hero = state.players.find((p) => p.id === 'bb')!;

  assert.equal(state.currentBet, Math.round(22 * BB), 'currentBet 必须是 22BB');
  assert.equal(state.lastRaiseSize, 12 * BB, '上一完整加注增量必须是 12BB（22 − 10）');
  assert.equal(minRaiseTo(state), 34 * BB, '最小再加注必须是 34BB');
  assert.equal(deriveLegalActions(state, hero).minRaiseToAmount, 34 * BB, 'legalActions 必须同一口径');

  const illegal = applyAction(state, { playerId: 'bb', type: 'RAISE', amount: 32 * BB } as never);
  assert.equal(illegal.ok, false, '32BB 低于最小加注额且我有充足筹码 ⇒ 必须拒绝');
  const legal = applyAction(state, { playerId: 'bb', type: 'RAISE', amount: 34 * BB } as never);
  assert.equal(legal.ok, true, '34BB 必须被接受');

  /* 尺寸网格里不得出现 32BB */
  const grid = buildSizeGrid(deriveLegalActions(state, hero), computePot(state), 'RAISE');
  assert.ok(
    grid.every((o) => o.toAmount >= 34 * BB),
    `网格里不得出现低于最小加注额的候选：${grid.map((o) => o.toAmount).join('/')}`,
  );
});

test('A-01b：面对 4Bet 的节点必须同样产出**逐尺寸**的翻前加注事实', () => {
  const state = bbVsBtnFourBet(10, 22);
  const facts = mustFacts(state);
  const hero = state.players.find((p) => p.id === 'bb')!;
  const legal = deriveLegalActions(state, hero);
  const grid = buildSizeGrid(legal, computePot(state), 'RAISE');

  assert.equal(facts.sizes.length, grid.length, '4Bet 节点同样必须逐尺寸建模');
  for (const option of grid) {
    assert.ok(option.toAmount >= 34 * BB, `4Bet 节点的网格不得低于 34BB：${option.toAmount / BB}`);
    const size = facts.sizes.find((s) => s.sizeChips === option.toAmount);
    assert.notEqual(size, undefined, `尺寸 ${option.toAmount / BB}BB 必须有事实`);
    assert.notEqual(size!.raiseEV, null, '5Bet 候选必须有自有 EV（阶段 C 的目标）');
  }
  /* 本节点：我跟注 12BB 之后再面对他的再加注 ⇒ 我在本街已有投入 */
  assert.ok(facts.heroCallCost > 0);
  assert.ok(facts.sizes.every((s) => s.heroStreetCommitted === 10 * BB), '我在本街已投入必须是 10BB');
});
