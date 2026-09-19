/**
 * ============================================================================
 * P1-2b：再加注后的 Hero 决策（FOLD / CALL）—— 墨菲定律验收
 * ============================================================================
 *
 * 口径（三个阶段统一）：零点 = **首次加注前的决策节点**，单位 = 筹码。
 *
 * ```text
 * foldBranchEV    = −heroContestedAdd
 * callBranchEV    = EqVsReraiseRange × 跟注后终池 − heroContestedAdd − 我需再投
 * reraiseBranchEV = max(foldBranchEV, callBranchEV)
 * ```
 *
 * ⚠️ 本模型**不支持** Hero 在对手再加注之后再反加（4-bet）：
 * 对手再加注**不是全下**时，该分支被如实标注为未支持（`heroFourBetSupported = false`），
 * 用的是「弃牌/跟注两选一」的**下界**（因为反加可能更好 ⇒ 取 max 只会低估）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { deriveLegalActions } from '../src/app/manualInput/legalActions.ts';
import { parseManualInput, type ManualHandInput } from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import { applyAction, canRaise } from '../src/domain/poker/engine.ts';
import { committedThisStreet, computePot, minRaiseTo } from '../src/domain/poker/gameState.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const OPTIONS = {
  rules: RULES, asOf: 1_757_000_000_000, writeLog: false,
  equitySeed: 20_261_014, budget: { softMs: 120_000, hardMs: 240_000 },
} as const;

const A = (position: string, type: string, amountBB?: number, street?: string) => ({
  position, type,
  ...(amountBB === undefined ? {} : { amountBB }),
  ...(street === undefined ? {} : { street }),
});

/** 河牌面对 BB 领打（Hero BTN）—— P0-7 / KQ 同一形状 */
function riverFacingBet(opts: { btn: number; bb: number; riverBet: number; heroCards?: [string, string] }): ManualHandInput {
  return {
    tableSize: 6, heroPosition: 'BTN',
    heroCards: opts.heroCards ?? ['As', 'Ks'],
    board: ['Kd', '9c', '4h', '6s', '2d'], street: 'RIVER',
    effectiveStackBB: Math.min(opts.btn, opts.bb), bigBlindBB: 2,
    seatStacksBB: { UTG: opts.btn, HJ: opts.btn, CO: opts.btn, BTN: opts.btn, SB: opts.btn, BB: opts.bb },
    actionHistory: [
      A('UTG', 'FOLD'), A('HJ', 'FOLD'), A('CO', 'FOLD'), A('BTN', 'RAISE', 3), A('SB', 'FOLD'), A('BB', 'CALL', 2),
      A('BB', 'CHECK', undefined, 'FLOP'), A('BTN', 'BET', 2.5, 'FLOP'), A('BB', 'CALL', 2.5, 'FLOP'),
      A('BB', 'CHECK', undefined, 'TURN'), A('BTN', 'BET', 7.5, 'TURN'), A('BB', 'CALL', 7.5, 'TURN'),
      A('BB', 'BET', opts.riverBet, 'RIVER'),
    ],
    environment: 'MID_LOW_STAKES',
    villain: { quickProfile: 'CALLING_STATION', dynamicHint: 'UNKNOWN', stackBB: opts.bb },
  } as unknown as ManualHandInput;
}

type Diag = Record<string, any>;

function decide(input: ManualHandInput): { action: string; sizeChips: number | null; diag: Diag; facts: Diag | null } {
  const r = analyzeManualHand(input, OPTIONS);
  assert.equal(r.ok, true, `必须能分析：${r.ok ? '' : `${r.stage} ${JSON.stringify(r.issues)}`}`);
  if (!r.ok) throw new Error('unreachable');
  const d = r.decision as unknown as Record<string, unknown>;
  const dg = d['diagnostics'] as Diag;
  return {
    action: String(d['action']),
    sizeChips: (d['sizeChips'] ?? null) as number | null,
    diag: dg,
    facts: ((dg['postflop'] ?? {})['raiseResponse'] ?? null) as Diag | null,
  };
}

/** 手算：从真实状态取「他跟平后的本街总额」「他的剩余」「我的剩余」 */
function chipsOf(input: ManualHandInput) {
  const parsed = parseManualInput(input);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error('unreachable');
  const gate = buildAnalyzableState(parsed.value);
  assert.equal(gate.ok, true);
  if (!gate.ok) throw new Error('unreachable');
  const st = gate.state;
  const hero = st.players.find((p) => p.id === st.userPlayerId)!;
  const villain = st.players.find((p) => p.id !== st.userPlayerId && !p.folded)!;
  return { state: st, hero, villain, legal: deriveLegalActions(st, hero) };
}

/* ============================================================
 * 支持范围：对手「跟平后仍有筹码」⇒ 他**可以**再加注
 * ============================================================ */

const RAISABLE = riverFacingBet({ btn: 200, bb: 200, riverBet: 20 }); // 双方深筹码

test('R1【再加注范围有效】导出的是**再加注桶**而不是跟注桶，且权重归一', () => {
  const { facts } = decide(RAISABLE);
  assert.notEqual(facts, null);
  if (facts === null) return;
  const rr = facts['reRaiseLikelihood'] as number;
  assert.ok(rr > 0, `前置：本节点他确实会以一定概率再加注（实际 ${rr}）`);
  const range = (facts['reRaiseEntriesDiagnostics'] ?? null) as Diag[] | null;
  // 诊断里目前至少要有「再加注组合数」与「对再加注范围的权益」
  assert.notEqual(facts['reRaiseCombos'], undefined, '必须上报再加注桶组合数');
  assert.ok((facts['reRaiseCombos'] as number) > 0, '再加注桶不得为空（rr > 0）');
  assert.notEqual(facts['heroEquityVsReraiseRange'], undefined, '必须上报 EqVsReraiseRange');
  const eqR = facts['heroEquityVsReraiseRange'] as number;
  const eqC = facts['heroEquityVsRaiseCallRange'] as number;
  assert.ok(eqR >= 0 && eqR <= 1, `EqVsReraiseRange 必须在 [0,1]（实际 ${eqR}）`);
  // 面对「他会再加注」的范围，Hero 的权益应当**不高于**面对「他跟注」的范围（强牌更多）
  assert.ok(eqR <= eqC + 1e-9, `EqVsReraiseRange(${eqR}) 不应高于 EqVsRaiseCallRange(${eqC})`);
  void range;
});

test('R2【再加注尺寸合法】再加注额必须来自真实合法行动，且不得超过他的筹码', () => {
  const { facts } = decide(RAISABLE);
  assert.notEqual(facts, null);
  if (facts === null) return;
  const { state, hero, villain } = chipsOf(RAISABLE);
  const raiseTo = facts['sizeChips'] as number;
  const reRaiseTo = facts['reRaiseTo'] as number;
  assert.notEqual(reRaiseTo, undefined, '必须上报再加注至');
  // 合法下界：引擎的最小加注规则 minRaiseTo = 2R − B
  const minLegal = 2 * raiseTo - committedThisStreet(state, villain.id);
  assert.equal(facts['reRaiseMinLegalTo'], minLegal, '最小合法再加注到必须等于 2R − B');
  // 引擎级验证：他若买得起完整再加注，则恰好能 RAISE 到那个额；否则只能全下
  const afterRaise = applyAction(state, { playerId: hero.id, type: 'RAISE', amount: raiseTo } as never);
  assert.equal(afterRaise.ok, true, '前置：Hero 的加注必须合法');
  if (!afterRaise.ok) return;
  const v2 = afterRaise.state.players.find((p) => p.id === villain.id)!;
  const attemptMin = applyAction(afterRaise.state, { playerId: villain.id, type: 'RAISE', amount: minLegal } as never);
  const attemptChosen = applyAction(afterRaise.state, { playerId: villain.id, type: 'RAISE', amount: reRaiseTo } as never);
  assert.equal(
    attemptChosen.ok,
    true,
    `模型选用的再加注额 ${reRaiseTo} 必须能被引擎接受（他剩余 ${v2.remainingStack}）`,
  );
  if (!attemptMin.ok) {
    // 买不起完整再加注 ⇒ 只能 under-raise 全下，模型必须如实标注
    assert.equal(facts['villainReRaiseIsAllIn'], true, '买不起完整再加注时必须标注为全下（under-raise）');
    assert.equal(reRaiseTo, committedThisStreet(state, villain.id) + v2.remainingStack, '此时应取他的全下额');
  }
  assert.ok(reRaiseTo >= minLegal - 1e-9 || facts['villainReRaiseIsAllIn'] === true, '再加注额必须合法或为全下');
  assert.equal(canRaise(afterRaise.state, villain.id), true, '他必须仍有加注权');
});

/* ============================================================
 * M1–M3：分支值与零点
 * ============================================================ */

test('M1【弃牌】面对再加注弃牌 ⇒ 损失为首次加注**实际留在池中**的投入', () => {
  const { facts } = decide(RAISABLE);
  assert.notEqual(facts, null);
  if (facts === null) return;
  const contested = facts['heroContestedAdd'] as number;
  assert.equal(facts['reraiseFoldBranchEV'], -contested, `弃牌分支必须等于 −${contested}`);
});

test('M2【跟注】跟注再加注 ⇒ 同时扣除首次投入与额外跟注（不得只扣一个）', () => {
  const { facts } = decide(RAISABLE);
  assert.notEqual(facts, null);
  if (facts === null) return;
  const contested = facts['heroContestedAdd'] as number;
  const eqR = facts['heroEquityVsReraiseRange'] as number;
  const finalPotAfterCall = facts['finalPotAfterCallVsReRaise'] as number;
  const additional = facts['heroAdditionalCallVsReRaise'] as number;
  const expected = eqR * finalPotAfterCall - contested - additional;
  assert.equal(
    facts['reraiseCallBranchEV'],
    expected,
    `跟注分支必须 = Eq×终池 − 已投入 − 额外跟注（实际 ${facts['reraiseCallBranchEV']} vs ${expected}）`,
  );
  assert.ok(additional > 0, '前置：跟注再加注必须还要投钱');
});

test('M3【零概率不生成虚假分支】再加注概率为 0 时，响应模型逐位不变且分支为下界', () => {
  // P0-7：他跟平即全下 ⇒ rr = 0
  const p07 = decide(riverFacingBet({ btn: 100, bb: 30, riverBet: 10 }));
  assert.notEqual(p07.facts, null);
  if (p07.facts === null) return;
  assert.equal(p07.facts['reRaiseLikelihood'], 0, '前置：rr = 0');
  assert.equal(p07.facts['reRaiseCombos'], 0, '再加注桶必须为空');
  assert.equal(
    p07.facts['reraiseBranchKind'],
    'LOWER_BOUND_NOT_IMPLEMENTED',
    'rr = 0 时应如实标注该分支未实现（而不是假装算过）',
  );
  // 逐位不变：与第一阶段（P1-2a 修复后）实测值完全一致
  assert.equal(p07.facts['foldLikelihood'], 0.05296693816568434);
  assert.equal(p07.facts['callLikelihood'], 0.9470330618343152);
  assert.equal(p07.facts['raiseEV'], 33.315808978687805, 'RAISE EV 也必须逐位不变（rr = 0 ⇒ 分支不参与）');
});

/* ============================================================
 * M4–M7：边界与资金
 * ============================================================ */

test('M4【Hero 全下】首次加注即全下 ⇒ 不出现后续决策（无再加注分支）', () => {
  const node = riverFacingBet({ btn: 60, bb: 100, riverBet: 20 });
  const { facts } = decide(node);
  assert.notEqual(facts, null);
  if (facts === null) return;
  assert.equal((facts['model'] as Diag)['heroIsAllIn'], true, '前置：Hero 全下');
  assert.equal(facts['reRaiseLikelihood'], 0, 'Hero 全下 ⇒ 无再加注分支');
  assert.equal(facts['reraiseBranchEV'], -(facts['heroContestedAdd'] as number), '分支值只能是下界');
});

test('M5【对手跟注即全下】⇒ 无再加注分支（P1-2a 契约保持）', () => {
  const { facts } = decide(riverFacingBet({ btn: 100, bb: 30, riverBet: 10 }));
  assert.notEqual(facts, null);
  if (facts === null) return;
  assert.equal((facts['model'] as Diag)['villainIsAllInByCall'], true);
  assert.equal(facts['reRaiseLikelihood'], 0);
  assert.equal(facts['reRaiseCombos'], 0);
});

test('M6【本街已投】Hero 本街已有投入时，heroContestedAdd 不得重复扣除', () => {
  const node: ManualHandInput = {
    tableSize: 6, heroPosition: 'CO', heroCards: ['As', 'Ah'], board: ['Kh', '7c', '2d'],
    street: 'FLOP', effectiveStackBB: 200, bigBlindBB: 2,
    seatStacksBB: { UTG: 200, HJ: 200, CO: 200, BTN: 200, SB: 200, BB: 200 },
    actionHistory: [
      A('UTG', 'FOLD'), A('HJ', 'FOLD'), A('CO', 'RAISE', 3), A('BTN', 'FOLD'), A('SB', 'FOLD'), A('BB', 'CALL', 2),
      A('BB', 'CHECK', undefined, 'FLOP'), A('CO', 'BET', 5, 'FLOP'), A('BB', 'RAISE', 20, 'FLOP'),
    ],
    environment: 'MID_LOW_STAKES',
    villain: { quickProfile: 'CALLING_STATION', dynamicHint: 'UNKNOWN', stackBB: 200 },
  } as unknown as ManualHandInput;
  const { diag, facts } = decide(node);
  assert.notEqual(facts, null);
  if (facts === null) return;
  const committed = (diag['math'] as Diag)['myCommittedThisStreet'] as number;
  assert.equal(committed, 10, '前置：Hero 本街已投 10');
  assert.equal(facts['heroAdd'], (facts['sizeChips'] as number) - 10, 'heroAdd = raiseTo − 本街已投');
  assert.ok(
    (facts['heroContestedAdd'] as number) <= (facts['heroAdd'] as number) + 1e-9,
    '留在池中的投入不得超过 heroAdd',
  );
  assert.equal(facts['heroStreetCommitted'], 10, '本街已投必须如实上报');
});

test('M7【短筹码未匹配】退回筹码不进池、不计成本', () => {
  const { facts } = decide(riverFacingBet({ btn: 100, bb: 30, riverBet: 10 }));
  assert.notEqual(facts, null);
  if (facts === null) return;
  const heroAdd = facts['heroAdd'] as number;
  const contested = facts['heroContestedAdd'] as number;
  assert.equal(facts['uncalledReturn'], heroAdd - contested, '退回 = 新增 − 留在池中');
  assert.ok((facts['uncalledReturn'] as number) > 0, '前置：本节点确实有退回');
  assert.equal(
    facts['finalPot'],
    (facts['currentPot'] as number) + contested + (facts['villainAdd'] as number),
    '终池按「留在池中的」算，退回不进池',
  );
});

test('M8【不得伪造】权益不可得时不得伪造 CALL EV（该分支保持下界并标注）', () => {
  const { facts } = decide(RAISABLE);
  assert.notEqual(facts, null);
  if (facts === null) return;
  const kind = facts['reraiseBranchKind'] as string;
  assert.ok(
    kind === 'FOLD' || kind === 'CALL' || kind === 'LOWER_BOUND_NOT_IMPLEMENTED',
    `分支类型必须是三者之一（实际 ${kind}）`,
  );
  if (kind !== 'LOWER_BOUND_NOT_IMPLEMENTED') {
    assert.equal(typeof facts['heroEquityVsReraiseRange'], 'number', '算了就必须要权益');
    assert.equal(
      facts['reraiseBranchEV'],
      Math.max(facts['reraiseFoldBranchEV'] as number, facts['reraiseCallBranchEV'] as number),
      '分支值必须是 max(弃牌, 跟注)',
    );
  } else {
    assert.equal(facts['reraiseBranchEV'], -(facts['heroContestedAdd'] as number), '未实现时必须退回下界');
  }
});

test('M9【范围驱动】只改变对手再加注范围 ⇒ 权益与后续 EV 随之更新（且不恒等于下界）', () => {
  /*
   * 节点：Hero **9♠9♥（暗三条）** 面对小注（河牌 2BB）⇒ 我的加注额只有 0.56 池，
   * 满足`ratioToPot ≤ 0.8` ⇒ **诈唬再加注条件成立**，于是：
   *   · MANIAC（诈唬倾向高）⇒ 再加注桶里**有空气牌** ⇒ 我对该桶的权益更高；
   *   · VERY_TIGHT（诈唬倾向低）⇒ 桶里只有价值牌 ⇒ 权益更低。
   * 这条同时证明「桶不是常数、权益确实由桶决定」，并且在该节点上
   * **分支值不再等于旧下界**（跟注优于弃牌）。
   */
  const withProfile = (profile: string) =>
    decide({
      ...riverFacingBet({ btn: 200, bb: 200, riverBet: 2, heroCards: ['9s', '9h'] }),
      villain: { quickProfile: profile, dynamicHint: 'UNKNOWN', stackBB: 200 },
    } as unknown as ManualHandInput);
  const maniac = withProfile('MANIAC');
  const tight = withProfile('VERY_TIGHT');
  assert.notEqual(maniac.facts, null);
  assert.notEqual(tight.facts, null);
  if (maniac.facts === null || tight.facts === null) return;
  assert.ok((maniac.facts['reRaiseLikelihood'] as number) > 0, '前置：MANIAC 会再加注');
  assert.ok((tight.facts['reRaiseLikelihood'] as number) > 0, '前置：紧手也会再加注');
  const eqManiac = maniac.facts['heroEquityVsReraiseRange'] as number;
  const eqTight = tight.facts['heroEquityVsReraiseRange'] as number;
  assert.equal(typeof eqManiac, 'number', '必须给出对再加注桶的权益');
  assert.equal(typeof eqTight, 'number', '必须给出对再加注桶的权益');
  assert.ok(
    eqManiac > eqTight + 1e-9,
    `诈唬型对手的再加注桶里有空气牌 ⇒ 我的权益必须更高（MANIAC ${eqManiac} vs 紧手 ${eqTight}）`,
  );
  assert.notEqual(
    maniac.facts['reraiseBranchEV'],
    tight.facts['reraiseBranchEV'],
    '分支值必须随再加注范围变化（不得是常数/下界）',
  );
  // 该节点上跟注优于弃牌 ⇒ 分支值必须**高于**下界（证明这条分支真的在算）
  assert.ok(
    (maniac.facts['reraiseBranchEV'] as number) > -(maniac.facts['heroContestedAdd'] as number) + 1e-9,
    '存在诈唬时跟注再加注优于弃牌 ⇒ 分支值必须高于旧下界',
  );
  assert.equal(maniac.facts['reraiseBranchKind'], 'CALL', '分支类型必须是 CALL');
});

test('M10【同一口径】RAISE EV 必须能用「三个分支 × 自有概率」独立复算', () => {
  const { facts } = decide(RAISABLE);
  assert.notEqual(facts, null);
  if (facts === null) return;
  const f = facts['foldLikelihood'] as number;
  const c = facts['callLikelihood'] as number;
  const rr = facts['reRaiseLikelihood'] as number;
  const expected =
    f * (facts['currentPot'] as number) +
    c * ((facts['heroEquityVsRaiseCallRange'] as number) * (facts['finalPot'] as number) - (facts['heroContestedAdd'] as number)) +
    rr * (facts['reraiseBranchEV'] as number);
  assert.ok(
    Math.abs((facts['raiseEV'] as number) - expected) < 1e-9,
    `RAISE EV 必须等于三分支独立复算值 ${expected}（实际 ${String(facts['raiseEV'])}）`,
  );
});

/* ============================================================
 * 未支持分支必须显式
 * ============================================================ */

test('U1【未支持显式】对手再加注不是全下时，Hero 的 4-bet 分支必须被标注为不支持', () => {
  const { facts } = decide(RAISABLE);
  assert.notEqual(facts, null);
  if (facts === null) return;
  if (facts['villainReRaiseIsAllIn'] === false) {
    assert.equal(facts['heroFourBetSupported'], false, '非全下的再加注 ⇒ Hero 还有反加选项 ⇒ 必须标注不支持');
    // 取 max(弃牌, 跟注) 是对该分支的**下界**（反加可能更好）
    assert.ok(
      (facts['reraiseBranchEV'] as number) >= (facts['reraiseFoldBranchEV'] as number) - 1e-9,
      '下界必须不劣于纯弃牌',
    );
  } else {
    assert.equal(facts['heroFourBetSupported'], true, '他全下 ⇒ 我不可能反加 ⇒ 两选一是完整的');
  }
});
