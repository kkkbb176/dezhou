/**
 * 🔴 **多人 limp 隔离加注**（MULTI_LIMP ISOLATION RAISE PHASE 1 · T1–T8）
 *
 * 固定节点：6-max 1/2，Hero BTN K♠Q♠，UTG/HJ/CO 各 limp 2（底池 9 筹码），
 * 身后 SB/BB 未行动。本文件锁定四件事：
 *
 * 1. `CLEAR_CALL_OVER_FOLD` **只是**「跟注 > 弃牌」—— 它不得再拦掉加注的评估；
 * 2. 隔离加注必须有自己的证据（`INDEPENDENT_STRATEGIC_EVIDENCE` + 代理 EV），
 *    而不是「EV 不可得的启发式」；
 * 3. 画像 / 人数 / 身后玩家**必须**改变范围、响应、尺寸与 EV（不是只改文案）；
 * 4. 拿不到事实包时（面对真实开池）**逐位保持**旧行为。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';
import { parseManualInput, type ManualHandInput } from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import { DecisionMargin } from '../src/domain/decision/decision.types.ts';
import type { PreflopIsoFacts } from '../src/app/manualInput/limpIsolation.ts';
import { isoRaiseEVOf, playersBehindRiskOf } from '../src/app/manualInput/limpIsolation.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const OPTIONS = { rules: RULES, asOf: 1_757_000_000_000, writeLog: false } as const;
const STACKS = { UTG: 90, HJ: 120, CO: 130, BTN: 150, SB: 95, BB: 110 } as const;

/** 固定节点：Hero BTN K♠Q♠，UTG/HJ/CO 全 limp 1BB */
function limpedNode(options: {
  profile?: string;
  villainPlayerId?: string;
  limpers?: readonly { position: string; type: string; amountBB?: number }[];
  heroCards?: readonly string[];
  heroPosition?: string;
} = {}): ManualHandInput {
  return {
    tableSize: 6,
    heroPosition: options.heroPosition ?? 'BTN',
    heroCards: options.heroCards ?? ['Ks', 'Qs'],
    board: [],
    street: 'PREFLOP',
    effectiveStackBB: 150,
    bigBlindBB: 2,
    seatStacksBB: { ...STACKS },
    actionHistory: [
      ...(options.limpers ?? [
        { position: 'UTG', type: 'CALL', amountBB: 1 },
        { position: 'HJ', type: 'CALL', amountBB: 1 },
        { position: 'CO', type: 'CALL', amountBB: 1 },
      ]),
    ],
    environment: 'MID_LOW_STAKES',
    ...(options.villainPlayerId === undefined ? {} : { villainPlayerId: options.villainPlayerId }),
    villain: { quickProfile: options.profile ?? 'UNKNOWN', dynamicHint: 'UNKNOWN', stackBB: 150 },
  } as unknown as ManualHandInput;
}

/** 固定节点输入（`villainPlayerId` 是手动录入里「哪一家带画像」的开关，不在 ManualHandInput 上） */
type LimpedInput = ManualHandInput & { villainPlayerId?: string };

/** 直接拿事实包（不经过决策层）—— 用于核对模型本身的数字 */
function factsOf(input: LimpedInput): PreflopIsoFacts {
  const parsed = parseManualInput(input);
  assert.equal(parsed.ok, true, `解析必须成功：${parsed.ok ? '' : JSON.stringify(parsed.issues)}`);
  if (!parsed.ok) throw new Error('unreachable');
  const g = buildAnalyzableState(parsed.value);
  assert.equal(g.ok, true);
  if (!g.ok) throw new Error('unreachable');
  const built = buildDecisionContext({
    state: g.state,
    rules: RULES,
    environment: 'MID_LOW_STAKES',
    asOf: 1_757_000_000_000,
    quickProfile: input.villain?.quickProfile,
    ...(input.villainPlayerId === undefined ? {} : { villainPlayerId: input.villainPlayerId }),
  });
  const facts = built.context.preflopIso ?? null;
  assert.notEqual(facts, null, '固定节点必须产出隔离加注事实包');
  return facts!;
}

/** 直接拿上下文（用于核对「画像/模型是否真的改变了引擎看到的范围与权益」） */
function contextOf(input: LimpedInput) {
  const parsed = parseManualInput(input);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error('unreachable');
  const g = buildAnalyzableState(parsed.value);
  assert.equal(g.ok, true, `状态必须可分析：${g.ok ? '' : JSON.stringify(g.issues)}`);
  if (!g.ok) throw new Error('unreachable');
  return buildDecisionContext({
    state: g.state,
    rules: RULES,
    environment: 'MID_LOW_STAKES',
    asOf: 1_757_000_000_000,
    quickProfile: input.villain?.quickProfile,
    ...(input.villainPlayerId === undefined ? {} : { villainPlayerId: input.villainPlayerId }),
  }).context;
}

const raiseEvidenceOf = (input: LimpedInput) => {
  const r = analyzeManualHand(input, OPTIONS);
  assert.equal(r.ok, true, `必须能分析：${r.ok ? '' : JSON.stringify(r.issues)}`);
  if (!r.ok) throw new Error('unreachable');
  const list = (r.decision.diagnostics.actionEvidence ?? []) as readonly Readonly<
    Record<string, unknown>
  >[];
  return { decision: r.decision, list, raise: list.find((e) => e['action'] === 'RAISE') ?? null };
};

/* ============================================================
 * T1：CLEAR_CALL_OVER_FOLD 不得拦掉加注的评估
 * ============================================================ */

test('T1：边际作用域是 VS_FOLD_ONLY，加注必须带自己的 EV 参与比较（不再被 CLEAR 拦掉）', () => {
  const { decision, list, raise } = raiseEvidenceOf(limpedNode({ profile: 'CALLING_STATION', villainPlayerId: 'seat_CO' }));

  // ① 边际被如实改名：只证明了 CALL > FOLD
  assert.equal(
    decision.diagnostics.decisionMargin?.kind,
    DecisionMargin.CLEAR_CALL_OVER_FOLD,
    '清晰边际必须写明「只对弃牌成立」',
  );
  // ② 加注是**自己算过 EV** 的证据，不是 EV 不可得的启发式
  assert.notEqual(raise, null, '证据表里必须有 RAISE');
  assert.equal(raise?.['estimateType'], 'INDEPENDENT_STRATEGIC_EVIDENCE');
  assert.equal(typeof raise?.['ev'], 'number', '加注必须带 EV（而不是 null）');
  // ③ 因此**不允许**再出现「被清晰跟注证据阻断」这条理由
  assert.notEqual(
    decision.diagnostics.decisionSource?.['overrideBlockedReason'],
    'CANNOT_OVERRIDE_CLEAR_SUPPORTED_CALL',
    '加注有自己的 EV 时不得再被 CLEAR_CALL 拦截',
  );
  // ④ 胜负由 EV 决定：赢的那一方 EV 必须更高
  const call = list.find((e) => e['action'] === 'CALL');
  assert.notEqual(call, null);
  const isoEV = raise?.['ev'] as number;
  const callEV = call?.['ev'] as number;
  assert.equal(
    decision.action,
    isoEV > callEV ? 'RAISE' : 'CALL',
    `动作必须与 EV 比较一致（RAISE ${isoEV.toFixed(2)} vs CALL ${callEV.toFixed(2)}）`,
  );
  assert.equal(
    decision.diagnostics.decisionMargin?.scope,
    'CROSS_ACTION',
    '跨动作比较已做 ⇒ 作用域必须是 CROSS_ACTION（不再是 VS_FOLD_ONLY）',
  );

  /*
   * ⑤ **独立复算**：决策层给出的 EV 必须能由事实包里**声明的输入**重算出来。
   *
   * 这一条专门挡住「拿别的数字冒充本动作 EV」的改法（例如用**到达范围**权益
   * 去算加注 EV —— 那是被 §8 明令禁止的口径）。
   */
  const facts = factsOf(limpedNode({ profile: 'CALLING_STATION', villainPlayerId: 'seat_CO' }));
  const recomputed = isoRaiseEVOf({
    potChips: 9,
    isoRaiseChips: (facts.isoSize.legalIsoSize ?? 0) * 2,
    callerAddsChips: (facts.isoSize.legalIsoSize ?? 0) * 2 - 2,
    joint: facts.joint,
    equityVsOneCaller: facts.heroEquity.vsOneCaller,
    equityVsThreeCallers: facts.heroEquity.vsThreeCallers,
    equityVsReraise: null,
    playersBehind: facts.playersBehind,
  });
  assert.ok(
    Math.abs((recomputed.proxyEV ?? 0) - (facts.isoEV.proxyEV ?? 0)) < 1e-9,
    '决策用的隔离 EV 必须等于用「对跟注条件范围」的权益复算出来的值',
  );
  assert.notEqual(facts.heroEquity.vsOneCaller, facts.heroEquity.vsArrival, '到达范围权益 ≠ 跟注范围权益');
});

/* ============================================================
 * T2：跟注站 ⇒ limp-call 概率更高（画像进入响应模型）
 * ============================================================ */

test('T2：画像进入响应模型 —— 跟注站弃牌更少 / 跟注更多，紧手相反', () => {
  const station = factsOf(limpedNode({ profile: 'CALLING_STATION', villainPlayerId: 'seat_CO' }));
  const loose = factsOf(limpedNode({ profile: 'LOOSE', villainPlayerId: 'seat_CO' }));
  const tight = factsOf(limpedNode({ profile: 'VERY_TIGHT', villainPlayerId: 'seat_CO' }));

  const co = (f: PreflopIsoFacts) => f.perLimper.find((l) => l.positionZh === '关煞位')!;
  assert.ok(co(station).foldProbability < co(loose).foldProbability, '跟注站弃牌率必须低于松弱');
  assert.ok(co(loose).foldProbability < co(tight).foldProbability, '松弱弃牌率必须低于紧手');
  assert.ok(co(station).callProbability > co(tight).callProbability, '跟注站跟注率必须高于紧手');
  // 而且是**真人不同**：画像确实改变了范围宽度（不是只改文案）
  assert.ok(
    co(station).arrivalWidth > co(tight).arrivalWidth,
    '跟注站的 limp 到达范围宽度必须大于紧手',
  );

  /*
   * 🔴 还要证明它进了**引擎主链**：跛入者的范围（不是只进事实包）必须随画像变化，
   * 因此 Hero 权益也会变。否则「画像只改文案」的改法能骗过上面所有断言。
   */
  const equityStation = contextOf(limpedNode({ profile: 'CALLING_STATION', villainPlayerId: 'seat_CO' })).math.heroEquity;
  const equityTight = contextOf(limpedNode({ profile: 'VERY_TIGHT', villainPlayerId: 'seat_CO' })).math.heroEquity;
  assert.notEqual(equityStation, null);
  assert.notEqual(equityTight, null);
  assert.notEqual(
    equityStation,
    equityTight,
    `画像必须改变 Hero 权益（跟注站 ${String(equityStation)} vs 紧手 ${String(equityTight)}）`,
  );
});

/* ============================================================
 * T3：人数影响尺寸（3 家 > 1 家）—— 不硬编码任何具体值
 * ============================================================ */

test('T3：limp 家数增加 ⇒ 隔离尺寸单调变大（且 EV 随之变化）', () => {
  /*
   * ⚠️ 行动记录必须**连续**（不能跳过前面没说话的座位），因此「1 家 / 2 家 limp」
   * 要把其余前位写成弃牌，让记录走到 Hero 的决策点。
   */
  const one = factsOf(
    limpedNode({
      limpers: [
        { position: 'UTG', type: 'CALL', amountBB: 1 },
        { position: 'HJ', type: 'FOLD' },
        { position: 'CO', type: 'FOLD' },
      ],
    }),
  );
  const two = factsOf(
    limpedNode({
      limpers: [
        { position: 'UTG', type: 'CALL', amountBB: 1 },
        { position: 'HJ', type: 'CALL', amountBB: 1 },
        { position: 'CO', type: 'FOLD' },
      ],
    }),
  );
  const three = factsOf(limpedNode());

  const size = (f: PreflopIsoFacts) => f.isoSize.legalIsoSize ?? 0;
  assert.ok(size(three) > size(two), `3 家尺寸必须大于 2 家（${size(three)} vs ${size(two)}）`);
  assert.ok(size(two) > size(one), `2 家尺寸必须大于 1 家（${size(two)} vs ${size(one)}）`);
  // 联合响应也要跟着人数走（全弃概率必然下降）
  assert.ok(one.joint.allFold > two.joint.allFold, '人少时全弃概率更高');
  assert.ok(two.joint.allFold > three.joint.allFold, '人多时全弃概率更低');
});

/* ============================================================
 * T4：AA 不被跟注的代理 EV 锁死（强牌允许加注）
 * ============================================================ */

test('T4：拿 AA 时不得给出「只能跟注」—— 加注必须仍在候选并可被 EV 选中', () => {
  const { decision, list, raise } = raiseEvidenceOf(limpedNode({ heroCards: ['As', 'Ah'] }));
  assert.notEqual(raise, null, 'AA 必须仍有加注候选');
  assert.equal(typeof raise?.['ev'], 'number');
  const call = list.find((e) => e['action'] === 'CALL');
  const isoEV = raise?.['ev'] as number;
  const callEV = call?.['ev'] as number;
  assert.equal(decision.action, isoEV > callEV ? 'RAISE' : 'CALL');
  assert.notEqual(
    decision.diagnostics.decisionSource?.['overrideBlockedReason'],
    'CANNOT_OVERRIDE_CLEAR_SUPPORTED_CALL',
  );
});

/* ============================================================
 * T5：72o 不会因为「死钱多」自动加注
 * ============================================================ */

test('T5：72o 的隔离加注 EV 必须为负 ⇒ 不得因为「有死钱」就加注', () => {
  const facts = factsOf(limpedNode({ heroCards: ['7c', '2d'] }));
  const isoEV = facts.isoEV.proxyEV;
  assert.notEqual(isoEV, null);
  assert.ok((isoEV as number) < 0, `72o 的隔离加注 EV 应为负，实际 ${String(isoEV)}`);

  const r = analyzeManualHand(limpedNode({ heroCards: ['7c', '2d'] }), OPTIONS);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.notEqual(r.decision.action, 'RAISE', '72o 不得因为「有死钱」就加注');
});

/* ============================================================
 * T6：再加注倾向高的原型 ⇒ 再加注风险/概率上升
 * ============================================================ */

test('T6：LIMP_RERAISE_HEAVY 的再加注概率高于普通原型（且只有强档混频）', () => {
  const heavy = factsOf(limpedNode({ profile: 'MANIAC', villainPlayerId: 'seat_CO' }));
  const normal = factsOf(limpedNode({ profile: 'NORMAL', villainPlayerId: 'seat_CO' }));
  const co = (f: PreflopIsoFacts) => f.perLimper.find((l) => l.positionZh === '关煞位')!;
  assert.ok(
    co(heavy).reraiseProbability > co(normal).reraiseProbability,
    `再加注倾向高的原型必须更容易再加注（${co(heavy).reraiseProbability} vs ${co(normal).reraiseProbability}）`,
  );
  // 但**不是所有牌都再加注**：概率必须远低于 1
  assert.ok(co(heavy).reraiseProbability < 0.5, '再加注不得变成「全有全无」');
});

/* ============================================================
 * T7：身后玩家（SB/BB）改变加注路径的风险，不只是文案
 * ============================================================ */

test('T7：身后玩家未行动 ⇒ cold-3bet 风险进入 EV；无身后玩家时该修正归零', () => {
  const withBehind = factsOf(limpedNode());
  assert.ok(withBehind.playersBehind.cold3betRisk > 0, 'SB/BB 未行动 ⇒ 冷 3bet 风险必须 > 0');
  assert.ok(
    (withBehind.isoEV.playersBehindAdjustment ?? 0) < 0,
    '身后风险必须真的进入 EV（负向修正），而不是只写在文案里',
  );

  /*
   * ⚠️ Hero 在 BB 时**没有**隔离加注决策点（跟注代价 = 0，`preflopIso` 为 null）——
   * 那是「过牌 / 加注」节点，不属于本轮修的场景。因此「身后无人」这一支
   * 直接对**共用的 EV 公式**做检查：把身后风险清零，EV 必须正好回升那么多。
   */
  const zeroRisk = Object.freeze({
    squeezeRisk: 0,
    overlimpRisk: 0,
    multiwayExpansionRisk: 0,
    coldCallRisk: 0,
    cold3betRisk: 0,
    cold4betRisk: 0,
    noteZh: '测试：身后无人',
  });
  const withoutRisk = isoRaiseEVOf({
    potChips: 9,
    isoRaiseChips: (withBehind.isoSize.legalIsoSize ?? 0) * 2,
    callerAddsChips: 14,
    joint: withBehind.joint,
    equityVsOneCaller: withBehind.heroEquity.vsOneCaller,
    equityVsThreeCallers: withBehind.heroEquity.vsThreeCallers,
    equityVsReraise: null,
    playersBehind: zeroRisk,
  });
  assert.ok(
    (withoutRisk.proxyEV ?? 0) > (withBehind.isoEV.proxyEV ?? 0),
    '身后风险清零后 EV 必须更高（说明它真的在 EV 公式里）',
  );
  assert.equal(Math.abs(withoutRisk.playersBehindAdjustment), 0, '风险为 0 ⇒ 修正项为 0（−0 也算 0）');
  assert.ok(
    Math.abs(
      (withoutRisk.proxyEV ?? 0) -
        ((withBehind.isoEV.proxyEV ?? 0) - (withBehind.isoEV.playersBehindAdjustment ?? 0)),
    ) < 1e-9,
    'EV 的差必须**正好**等于身后修正项',
  );
  assert.equal(playersBehindRiskOf({ behind: [] }).cold3betRisk, 0, '身后无人 ⇒ 冷 3bet 风险为 0');
});

/* ============================================================
 * T8：拿不到事实包 ⇒ 旧行为逐位不变（面对真实开池）
 * ============================================================ */

test('T8：面对真实开池的节点不得产出隔离加注事实包（旧契约保持）', () => {
  const opened = {
    tableSize: 6,
    heroPosition: 'CO',
    heroCards: ['As', 'Js'],
    board: [],
    street: 'PREFLOP',
    effectiveStackBB: 100,
    bigBlindBB: 2,
    seatStacksBB: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 },
    actionHistory: [
      { position: 'UTG', type: 'FOLD' },
      { position: 'HJ', type: 'RAISE', amountBB: 3 },
    ],
    environment: 'MID_LOW_STAKES',
    villain: { quickProfile: 'NORMAL', dynamicHint: 'UNKNOWN', stackBB: 100 },
  } as unknown as ManualHandInput;

  const parsed = parseManualInput(opened);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const g = buildAnalyzableState(parsed.value);
  assert.equal(g.ok, true);
  if (!g.ok) return;
  const built = buildDecisionContext({
    state: g.state,
    rules: RULES,
    environment: 'MID_LOW_STAKES',
    asOf: 1_757_000_000_000,
    quickProfile: 'NORMAL',
  });
  assert.equal(built.context.preflopIso ?? null, null, '面对开池的节点不得有隔离加注事实包');

  const r = analyzeManualHand(opened, OPTIONS);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.decision.action, 'CALL', 'AJs 面对开池仍然是跟注（旧契约）');
  assert.equal(
    r.decision.diagnostics.decisionMargin?.scope,
    'VS_FOLD_ONLY',
    '没有别的动作带量化 EV ⇒ 作用域必须如实写成 VS_FOLD_ONLY',
  );
});
