/**
 * 🔴 **多人联合响应树**（MULTIWAY POSTFLOP RESPONSE TREE PHASE 1 · T1–T8）
 *
 * 固定节点：6-max 1/2，Hero BTN K♠Q♠，翻前 3 家 limp → Hero 加注 8BB →
 * UTG/CO 跟 ⇒ 翻牌 J♦ 8♣ 4♥，底池 53，UTG/CO 都过牌，轮到 Hero。
 *
 * 本文件锁定：
 * 1. `ALL_FOLD` 是**连乘**（不是平均 / 不是 primary / 不是「任一人弃」）；
 * 2. 每个对手有**自己的**响应对象（画像不串座）；
 * 3. 「两家都跟」的权益是**真三人权益**（不是两次单挑的平均）；
 * 4. 下注成本全树只扣一次；联合状态概率和为 1；
 * 5. 单挑节点逐位回到旧口径（不回归）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';
import { parseManualInput, type ManualHandInput } from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import { advisePostflop } from '../src/app/decision/postflopAdvisor.ts';
import { composeBetEV, jointStatesOf, type MultiwayBetFacts } from '../src/domain/postflop/betResponse.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const OPTIONS = { rules: RULES, asOf: 1_757_000_000_000, writeLog: false } as const;
const STACKS = { UTG: 90, HJ: 120, CO: 130, BTN: 150, SB: 95, BB: 110 } as const;

type Node = ManualHandInput & { seatProfiles?: Readonly<Record<string, string>> };

/** 固定三人池节点（翻牌 J♦8♣4♥，UTG/CO 过牌 ⇒ Hero BTN） */
function threeWay(seatProfiles: Readonly<Record<string, string>> = { UTG: 'LOOSE', CO: 'CALLING_STATION' }): Node {
  return {
    tableSize: 6,
    heroPosition: 'BTN',
    heroCards: ['Ks', 'Qs'],
    board: ['Jd', '8c', '4h'],
    street: 'FLOP',
    effectiveStackBB: 82,
    bigBlindBB: 2,
    seatStacksBB: { ...STACKS },
    seatProfiles,
    actionHistory: [
      { position: 'UTG', type: 'CALL', amountBB: 1 },
      { position: 'HJ', type: 'CALL', amountBB: 1 },
      { position: 'CO', type: 'CALL', amountBB: 1 },
      { position: 'BTN', type: 'RAISE', amountBB: 8 },
      { position: 'SB', type: 'FOLD' },
      { position: 'BB', type: 'FOLD' },
      { position: 'UTG', type: 'CALL', amountBB: 7 },
      { position: 'HJ', type: 'FOLD' },
      { position: 'CO', type: 'CALL', amountBB: 7 },
      { position: 'UTG', type: 'CHECK', street: 'FLOP' },
      { position: 'CO', type: 'CHECK', street: 'FLOP' },
    ],
    environment: 'MID_LOW_STAKES',
    villain: { quickProfile: 'UNKNOWN', dynamicHint: 'UNKNOWN', stackBB: 82 },
  } as unknown as Node;
}

/** 单挑翻牌节点（HJ 开池、Hero BTN 跟注 ⇒ 翻牌对手过牌） */
function headsUp(): Node {
  return {
    tableSize: 6,
    heroPosition: 'BTN',
    heroCards: ['As', 'Js'],
    board: ['Kh', '7c', '2d'],
    street: 'FLOP',
    effectiveStackBB: 100,
    bigBlindBB: 2,
    seatStacksBB: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 },
    actionHistory: [
      { position: 'UTG', type: 'FOLD' },
      { position: 'HJ', type: 'RAISE', amountBB: 3 },
      { position: 'CO', type: 'FOLD' },
      { position: 'BTN', type: 'CALL', amountBB: 3 },
      { position: 'SB', type: 'FOLD' },
      { position: 'BB', type: 'FOLD' },
      { position: 'HJ', type: 'CHECK', street: 'FLOP' },
    ],
    environment: 'MID_LOW_STAKES',
    villain: { quickProfile: 'NORMAL', dynamicHint: 'UNKNOWN', stackBB: 100 },
  } as unknown as Node;
}

function contextOf(node: Node) {
  const parsed = parseManualInput(node);
  assert.equal(parsed.ok, true, `解析必须成功：${parsed.ok ? '' : JSON.stringify(parsed.issues)}`);
  if (!parsed.ok) throw new Error('unreachable');
  const g = buildAnalyzableState(parsed.value);
  assert.equal(g.ok, true, `状态必须可分析：${g.ok ? '' : JSON.stringify(g.issues)}`);
  if (!g.ok) throw new Error('unreachable');
  return buildDecisionContext({
    state: g.state,
    rules: RULES,
    environment: 'MID_LOW_STAKES',
    asOf: 1_757_000_000_000,
    ...(node.seatProfiles === undefined ? {} : { seatProfiles: node.seatProfiles as never }),
  }).context;
}

function factsOf(node: Node): MultiwayBetFacts {
  const facts = contextOf(node).postflopFacts?.betDecision?.multiway ?? null;
  assert.notEqual(facts, null, '三人池必须产出多人联合树事实包');
  return facts!;
}

const sizeState = (facts: MultiwayBetFacts, kind: string) =>
  facts.jointStates.find((s) => s.kind === kind)!.states;
const responseOf = (facts: MultiwayBetFacts, positionZh: string, kind: string) =>
  facts.perOpponentResponse.find((r) => r.positionZh === positionZh && r.kind === kind)!;

/* ============================================================
 * T1：联合弃牌率必须是连乘（并锁住三种错误写法）
 * ============================================================ */

test('T1：P(all fold) = Π P(弃)；禁止平均/最大/最小/「任一弃」', () => {
  const pure = jointStatesOf([
    { opponentId: 'A', positionZh: 'UTG', tendencyNoteZh: '测试', foldProbability: 0.5, callProbability: 0.4, raiseProbability: 0.1 },
    { opponentId: 'B', positionZh: 'CO', tendencyNoteZh: '测试', foldProbability: 0.4, callProbability: 0.5, raiseProbability: 0.1 },
  ]);
  assert.notEqual(pure, null);
  assert.equal(Number(pure!.allFold.toFixed(10)), 0.2, '两家各弃 50%/40% ⇒ 全弃必须是 20%');
  // 三种错误写法都必须与模型值不同（否则「错误也能过」）
  assert.notEqual(Number(pure!.allFold.toFixed(10)), Number(((0.5 + 0.4) / 2).toFixed(10)), '不得用平均弃牌率');
  assert.notEqual(Number(pure!.allFold.toFixed(10)), 0.5, '不得用 max');
  assert.notEqual(Number(pure!.allFold.toFixed(10)), 0.4, '不得用 min');
  assert.notEqual(Number(pure!.allFold.toFixed(10)), Number((1 - (1 - 0.5) * (1 - 0.4)).toFixed(10)), '不得用「任一弃」');
  // 概率守恒 + 无负值 + 逐对手三概率和为 1
  assert.ok(Math.abs(pure!.total - 1) < 1e-9, `状态概率和必须为 1，实际 ${pure!.total}`);
  for (const s of pure!.states) assert.ok(s.probability >= 0 && s.probability <= 1, '概率必须在 [0,1]');

  // 固定节点：联合表必须自洽（墨菲 §21.3 / §21.16 / §21.17）
  const facts = factsOf(threeWay());
  for (const entry of facts.jointStates) {
    assert.ok(Math.abs(entry.states.total - 1) < 1e-9, `${String(entry.kind)} 的 Σp 必须为 1`);
    assert.equal(entry.states.model, 'CONDITIONAL_INDEPENDENCE');
    assert.ok(entry.states.independenceNoteZh.includes('HEURISTIC_INDEPENDENCE_ASSUMPTION'));
  }
  for (const r of facts.perOpponentResponse) {
    const sum = r.foldProbability + r.callProbability + r.raiseProbability;
    assert.ok(Math.abs(sum - 1) < 1e-9, `${r.positionZh} 的 fold+call+raise 必须 = 1（实际 ${sum}）`);
    assert.ok(Number.isFinite(r.heroEquityVsCallRange ?? 0), '权益不得为 NaN/Infinity');
  }
  for (const e of facts.conditionalEquities) {
    assert.ok(Number.isFinite(e.allCall ?? 0) && Number.isFinite(e.anyRaise ?? 0));
  }

  /*
   * 🔴 **逐分支可复算**（§18-G + §8「Hero 下注成本只扣一次」）：
   * 每个分支的 EV 必须能由报告出来的字段重算，且 Hero 成本在每个分支里只出现一次。
   * 这条挡住「每个分支重复扣下注成本」与「分支 EV 与总 EV 不相关」两类改法。
   */
  for (const entry of facts.branchEVs) {
    const total = facts.totalBetEV.find(
      (t) => t.kind === entry.kind && Math.abs(t.betAmount - entry.betAmount) < 1e-9,
    )!;
    let weighted = 0;
    for (const br of entry.branches) {
      assert.equal(br.heroCostChips === 0 || br.heroCostChips === entry.betAmount, true, '成本只能是要么 0（全弃）要么正好一次下注额');
      const recomputed =
        br.kind === 'ALL_FOLD'
          ? br.resultingPot // 全部弃牌 ⇒ 直接拿下当前底池（下注额收回）
          : br.kind === 'ANY_RAISE'
            ? -br.heroCostChips // 加注分支 = 下界（Hero 直接放弃）
            : (br.realizedEquity ?? 0) * br.resultingPot - br.heroCostChips;
      assert.ok(
        Math.abs(recomputed - (br.ev ?? Number.NaN)) < 1e-9,
        `${String(entry.kind)}/${br.kind} 的 EV 必须可由 (实现后权益×底池 − 我的投入) 复算：` +
          `${recomputed} vs ${String(br.ev)}`,
      );
      weighted += br.probability * (br.ev ?? 0);
    }
    assert.ok(
      Math.abs(weighted - (total.totalEV ?? Number.NaN)) < 1e-9,
      `${String(entry.kind)} 的总 EV 必须等于 Σ 概率×分支EV：${weighted} vs ${String(total.totalEV)}`,
    );
  }
});

/* ============================================================
 * T2：跟注站降低 all-fold（画像进入自己的响应）
 * ============================================================ */

test('T2：CO 改成跟注站 ⇒ all-fold 不升、他自己的跟注概率上升', () => {
  const normal = factsOf(threeWay({ UTG: 'NORMAL', CO: 'NORMAL' }));
  const station = factsOf(threeWay({ UTG: 'NORMAL', CO: 'CALLING_STATION' }));

  const foldNormal = responseOf(normal, '关煞位', 'BET_MEDIUM').foldProbability;
  const foldStation = responseOf(station, '关煞位', 'BET_MEDIUM').foldProbability;
  const callNormal = responseOf(normal, '关煞位', 'BET_MEDIUM').callProbability;
  const callStation = responseOf(station, '关煞位', 'BET_MEDIUM').callProbability;

  assert.ok(callStation > callNormal, `跟注站的跟注概率必须上升（${callStation} vs ${callNormal}）`);
  assert.ok(foldStation < foldNormal, `跟注站的弃牌概率必须下降（${foldStation} vs ${foldNormal}）`);

  const allFoldNormal = sizeState(normal, 'BET_MEDIUM').allFold;
  const allFoldStation = sizeState(station, 'BET_MEDIUM').allFold;
  assert.ok(
    allFoldStation <= allFoldNormal,
    `all-fold 不得因为「更爱跟」而上升（${allFoldStation} vs ${allFoldNormal}）`,
  );
  // 量化分辨率的天花板：如实报告差距量级（不得假装很大）
  assert.ok(
    foldNormal - foldStation < 0.5,
    '差距量级异常（>50 个百分点）—— 可能需要检查画像是否被重复施加',
  );
});

/* ============================================================
 * T3：加第二名对手不得提高纯诈唬的直接成功率
 * ============================================================ */

test('T3：同类对手从 1 家变 2 家 ⇒ all-fold 必须下降（≤ 单挑值）', () => {
  const one = jointStatesOf([
    { opponentId: 'A', positionZh: 'UTG', tendencyNoteZh: 't', foldProbability: 0.5, callProbability: 0.45, raiseProbability: 0.05 },
  ])!;
  const two = jointStatesOf([
    { opponentId: 'A', positionZh: 'UTG', tendencyNoteZh: 't', foldProbability: 0.5, callProbability: 0.45, raiseProbability: 0.05 },
    { opponentId: 'B', positionZh: 'CO', tendencyNoteZh: 't', foldProbability: 0.5, callProbability: 0.45, raiseProbability: 0.05 },
  ])!;
  assert.ok(two.allFold <= one.allFold + 1e-12, `多人 all-fold 不得高于单挑（${two.allFold} vs ${one.allFold}）`);
  assert.equal(Number(two.allFold.toFixed(10)), 0.25);

  // 固定节点：真实模型的 all-fold 必须显著低于 primary 自己的弃牌率
  const facts = factsOf(threeWay());
  const primaryFold = responseOf(facts, '关煞位', 'BET_MEDIUM').foldProbability;
  assert.ok(
    sizeState(facts, 'BET_MEDIUM').allFold < primaryFold,
    '三家池的 all-fold 必须低于单个对手的弃牌率（否则又把它当成「直接拿下底池」）',
  );
});

/* ============================================================
 * T4：两人都跟的权益必须是真三人权益
 * ============================================================ */

test('T4：EqBothCall 必须 ≤ 两个单挑权益（真三人权益，不是平均）', () => {
  const facts = factsOf(threeWay());
  const eq = facts.conditionalEquities.find((e) => e.kind === 'BET_MEDIUM')!;
  const utg = eq.byCallerId['seat_UTG']!;
  const co = eq.byCallerId['seat_CO']!;
  assert.notEqual(eq.allCall, null);
  assert.ok(
    (eq.allCall as number) <= Math.max(utg, co) + 1e-9,
    `两人跟注的权益必须不高于单挑（both ${eq.allCall} vs UTG ${utg} / CO ${co}）—— ` +
      '若真的更高，必须有具体的范围证据',
  );
  // 而且不是「两次单挑的平均」
  const average = (utg + co) / 2;
  assert.ok(
    Math.abs((eq.allCall as number) - average) > 1e-6 || Math.abs(utg - co) < 1e-9,
    '两人跟注权益不得等于两次单挑权益的平均',
  );
});

/* ============================================================
 * T5：primary opponent 只能用于展示
 * ============================================================ */

test('T5：只改 primary opponent（两家画像都由逐座位给出）⇒ 多人 EV 不得变化', () => {
  const base = threeWay({ UTG: 'LOOSE', CO: 'CALLING_STATION' });
  const a = factsOf({ ...base, villainPlayerId: 'seat_UTG' } as Node);
  const b = factsOf({ ...base, villainPlayerId: 'seat_CO' } as Node);
  assert.deepEqual(
    a.totalBetEV.map((t) => t.totalEV),
    b.totalBetEV.map((t) => t.totalEV),
    'primary opponent 换了，多人 EV 必须逐位不变（它只用于 UI 摘要）',
  );
  assert.equal(a.primaryOpponentUsedForEV, false);
});

/* ============================================================
 * T6：同一尺寸只有一份响应 —— 但不同尺寸必须各自计算
 * ============================================================ */

test('T6：每个尺寸各自计算；若两档相同必须如实标记（不得静默复用同一个桶）', () => {
  const facts = factsOf(threeWay());
  const amounts = new Set(facts.perOpponentResponse.map((r) => r.betAmount));
  assert.equal(amounts.size, 3, '三个尺寸必须各有一组响应');

  const medium = responseOf(facts, '关煞位', 'BET_MEDIUM');
  const large = responseOf(facts, '关煞位', 'BET_LARGE');
  const identical =
    Math.abs(medium.foldProbability - large.foldProbability) < 1e-12 &&
    Math.abs(medium.callProbability - large.callProbability) < 1e-12;

  if (identical) {
    assert.notEqual(
      facts.sizeSaturation.status,
      'DISTINCT_RESPONSES',
      '两档响应逐位相同 ⇒ 饱和审计必须如实标记（不得静默）',
    );
    assert.ok(facts.sizeSaturation.identicalPairs.length > 0, '必须列出是哪两档、哪些对手');
    assert.ok(
      facts.sizeSaturation.reasonZh.includes('死区') || facts.sizeSaturation.reasonZh.includes('量化'),
      '必须给出原因（牌力代理分辨率 / 价格阶梯死区）',
    );
    /*
     * 🔴 **「相同」必须是可解释的**（§15）。
     *
     * 分类改为**连续混频**之后，两个尺寸只有在**价格相同**时才可能给出
     * 逐位相同的响应（continueFraction 是价格的连续函数）。
     * 因此：价格不同却给出相同响应 ⇒ 一定是**复用了同一个桶**
     * （分类用的价格与它自己申报的注额不符）—— 必须变红。
     */
    const potForPrice = contextOf(threeWay()).postflopFacts!.betDecision!.pot;
    const priceOf = (amount: number): number => amount / (potForPrice + 2 * amount);
    assert.ok(
      Math.abs(priceOf(medium.betAmount) - priceOf(large.betAmount)) < 1e-9,
      '两档响应逐位相同但价格不同 ⇒ 分类用的价格与申报注额不符（复用了同一个响应桶）：' +
        `${priceOf(medium.betAmount).toFixed(4)} vs ${priceOf(large.betAmount).toFixed(4)}`,
    );
  } else {
    assert.equal(facts.sizeSaturation.status, 'DISTINCT_RESPONSES');
    // 尺寸弹性必须真的有非零项（否则「不同」是假的）
    assert.ok(
      facts.sizeElasticity.some((e) => e.foldDeltaPerSize.some((v) => Math.abs(v) > 1e-9)),
      '尺寸弹性不得全为 0',
    );
  }
  // 封顶前 / 封顶后都要有值（§14）
  for (const r of facts.perOpponentResponse) {
    assert.ok(r.rawRaiseProbability >= r.raiseProbability - 1e-12, '封顶前加注概率不得低于封顶后');
  }

  /*
   * 🔴 **响应必须与它自己的尺寸相符**（本轮新增，用来挡住「第二个尺寸复用第一个的桶」）：
   * 尺寸越大 ⇒ 价格越高 ⇒ 每个对手的 P(弃) 必须**单调不降**、P(加) 必须**单调不增**。
   * 只检查「不同尺寸的值不同」挡不住「用了别的尺寸的 ratio 去分类」这类改法。
   */
  for (const positionZh of ['枪口位', '关煞位']) {
    const ordered = ['BET_SMALL', 'BET_MEDIUM', 'BET_LARGE'].map((k) => responseOf(facts, positionZh, k));
    for (let i = 1; i < ordered.length; i += 1) {
      assert.ok(
        ordered[i]!.foldProbability >= ordered[i - 1]!.foldProbability - 1e-9,
        `${positionZh}：注额 ${ordered[i]!.betAmount} > ${ordered[i - 1]!.betAmount} ⇒ P(弃) 不得下降` +
          `（${ordered[i]!.foldProbability} vs ${ordered[i - 1]!.foldProbability}）`,
      );
      assert.ok(
        ordered[i]!.betAmount > ordered[i - 1]!.betAmount,
        '尺寸必须严格递增（否则本检查无意义）',
      );
    }
  }
});

/* ============================================================
 * T7：每个对手的响应用自己的画像（不串座）
 * ============================================================ */

test('T7：紧手 vs 跟注站 —— 两人的响应必须来自各自的画像', () => {
  const facts = factsOf(threeWay({ UTG: 'VERY_TIGHT', CO: 'CALLING_STATION' }));
  const utg = responseOf(facts, '枪口位', 'BET_MEDIUM');
  const co = responseOf(facts, '关煞位', 'BET_MEDIUM');
  assert.ok(
    utg.foldProbability > co.foldProbability,
    `极紧的弃牌率必须高于跟注站（${utg.foldProbability} vs ${co.foldProbability}）`,
  );
  assert.ok(utg.callProbability < co.callProbability, '极紧的跟注率必须低于跟注站');
  assert.ok(utg.tendencyNoteZh.includes('VERY_TIGHT'), '响应必须记录**他自己**的画像来源');
  assert.ok(co.tendencyNoteZh.includes('CALLING_STATION'));
  assert.notEqual(utg.tendencyNoteZh, co.tendencyNoteZh, '两个对手不得共用同一份倾向说明');

  /*
   * 🔴 两个对手的**条件范围与权益也必须各自算**（不得共用同一个响应对象）：
   * 极紧的继续范围更紧 ⇒ 面对他时我的权益更低；跟注站的跟注范围更弱 ⇒ 面对他时更高。
   * 这条挡住「第二个对手直接抄第一个对手的桶」。
   */
  assert.notEqual(
    utg.heroEquityVsCallRange,
    co.heroEquityVsCallRange,
    '两个对手的跟注范围权益必须各自计算（不得共用同一份响应）',
  );
  assert.ok(
    (utg.heroEquityVsCallRange ?? 0) < (co.heroEquityVsCallRange ?? 1),
    `面对极紧的权益必须低于面对跟注站：${utg.heroEquityVsCallRange} vs ${co.heroEquityVsCallRange}`,
  );
});

/* ============================================================
 * T8：单挑节点逐位回到旧口径（不回归）
 * ============================================================ */

test('T8：单挑节点不得使用联合树，BetEV 必须等于旧单挑公式', () => {
  const context = contextOf(headsUp());
  const bd = context.postflopFacts?.betDecision ?? null;
  assert.notEqual(bd, null);
  assert.equal(bd!.multiway, null, '单挑不得产出联合树（两条路径不同时存在）');
  for (const size of bd!.sizes) {
    assert.equal(size.multiway, null);
    assert.equal(size.evKind, 'SINGLE_OPPONENT_MODEL_EV');
  }
  /*
   * 逐位复算旧公式 —— 必须核对**生产建议路径**真正拿去比较的那个 EV。
   *
   * ⚠️ 原断言是 `assert.equal(legacy.betEV, legacy.betEV)`：变量与自身比较，
   * 恒真且什么都不证明（本轮信息边界审计抓到的空测试）。`betDecision.sizes`
   * 上根本没有 `betEV` 字段（它是 `SizeResponseWithEquity`）；单挑 EV 是在
   * `advisePostflop` 里由 `composeBetEV` 算出来的，因此必须走
   * `advisePostflop(...).betDecision.sizes[i].betEV` 才能真交叉核对。
   */
  const advice = advisePostflop(context, {
    facingBet: false,
    requiredEquity: context.math.requiredEquity,
    potAfterCall: context.math.pot,
  });
  assert.notEqual(advice, null, '单挑无人下注节点必须产出下注建议');
  const recommended = advice!.betDecision;
  assert.equal(recommended!.sizes.length, bd!.sizes.length, '生产建议与事实包必须逐尺寸一一对应');
  const checkEV = bd!.checkTree.checkEV;
  for (const size of recommended!.sizes) {
    const legacy = composeBetEV({
      kind: size.kind as never,
      ratioToPot: size.ratioToPot,
      pot: bd!.pot,
      foldLikelihood: size.foldLikelihood,
      callLikelihood: size.callLikelihood,
      raiseLikelihood: size.raiseLikelihood,
      heroEquityVsCallRange: size.heroEquityVsCallRange,
      heroEquityVsRaiseRange: size.heroEquityVsRaiseRange,
      realizationFactor: bd!.realization.factor,
      checkEV,
    });
    assert.equal(
      size.betEV,
      legacy.betEV,
      `${size.kind}: 生产单挑 EV 必须逐位等于旧公式（单挑不得走联合树）`,
    );
  }
  // 决策照常给出（旧契约不回归）
  const r = analyzeManualHand(headsUp(), OPTIONS);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.ok(['CHECK', 'BET', 'CALL', 'FOLD'].includes(String(r.decision.action)));
  // 多人节点的 EV 必须与单挑旧值不同（证明真的换了口径）
  /*
   * 多人节点的证据等级必须**逐尺寸如实标注**：只有真正存在非零 `ANY_RAISE`
   * 分支时才允许标 HEURISTIC（加注分支只有下界）；加注概率为 0 的尺寸就是
   * 纯粹的独立联合 EV，不得无差别贴启发式标签。
   *
   * ⚠️ 原断言要求**所有**尺寸都标 HEURISTIC，是过宽断言：实测中/大注的
   * `raiseProbability` 精确为 0，标 `MODEL_EV_MULTIWAY` 才是如实标注。
   */
  const multi = factsOf(threeWay());
  assert.ok(multi.totalBetEV.length > 0, '多人树必须逐尺寸给出 EV');
  for (const total of multi.totalBetEV) {
    const detail = multi.branchEVs.find((b) => b.kind === total.kind);
    assert.notEqual(detail, undefined, `${String(total.kind)}: 必须有分支明细`);
    const hasRaiseBranch = (detail?.branches ?? []).some(
      (b) => b.kind === 'ANY_RAISE' && b.probability > 1e-9,
    );
    assert.equal(
      total.evKind,
      hasRaiseBranch ? 'MODEL_EV_WITH_HEURISTIC_RAISE_BRANCH' : 'MODEL_EV_MULTIWAY',
      `${String(total.kind)}: 证据等级必须与是否真的存在加注分支一致`,
    );
  }
});
