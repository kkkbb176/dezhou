/**
 * ============================================================================
 * PLAYER PROFILE V3 · FACING BET CHANNEL（M1）—— 定向测试
 * ============================================================================
 *
 * ## 本文件锁的是什么
 *
 * 「已明确绑定的玩家，其**融合画像**（标签 prior ⊕ 实测统计）必须在**面对下注**的
 * 生产模型里生效；而今天该节点只消费标签。」（审计见 `reports/evidence/profile-downstream-audit.txt`）
 *
 * ## 状态（M1 方案 D 实施后）
 *
 * - 全部测试通过：面对下注层消费的是**有效画像维度**
 *   （`facingBetProfileOf`：标签按 0.35 × (1−w)、实测按 w，各进一次）；
 * - 无统计 / 全 null / 0 手 / 无轴证据 ⇒ **逐位走旧标签实现**（`hasObservedEvidence === false`）。
 *
 * ## 断言纪律
 *
 * - 只走生产入口（`analyzeManualHand` / `buildDecisionContext`）；
 * - 不写「VPIP 大 ⇒ 河牌弃牌率必然大」这类未经验证的策略断言；方向性断言只用于
 *   **Resolver 已定义**的极性表（`STAT_DIMENSION_POLARITY`）；
 * - 「是否进入模型」用**生产事实包自报的响应刻度**（`raiseResponse.model.noteZh`）判定，
 *   不复制产品内部公式（防 M12 同源假通过）；
 * - 数学等价性断言只使用 §三 契约里**已给定**的量（`center` 是仿射变换，不是模型系数）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { facingBetProfileOf, centeredOf } from '../src/app/manualInput/facingBetProfile.ts';
import { archetypeDimensionsOf } from '../src/domain/player/archetypeDimensions.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';
import { betProbabilityByBand } from '../src/app/manualInput/bettingRange.ts';
import { responseTendenciesOf } from '../src/domain/postflop/betResponse.ts';
import {
  parseManualInput,
  type ManualHandInput,
  type ManualVillain,
} from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const OPTIONS = {
  rules: RULES, asOf: 1_757_000_000_000, writeLog: false,
  equitySeed: 20_260_913, budget: { softMs: 120_000, hardMs: 240_000 },
} as const;

const A = (position: string, type: string, amountBB?: number, street?: string): Record<string, unknown> => ({
  position, type,
  ...(amountBB === undefined ? {} : { amountBB }),
  ...(street === undefined ? {} : { street }),
});

/** TEST 16 原牌局（6 人桌 1/2，Hero BTN A♠A♥，河牌面对 BB 10BB 领打） */
function test16(villain: ManualVillain): ManualHandInput {
  return {
    tableSize: 6, heroPosition: 'BTN', heroCards: ['As', 'Ah'], board: ['Ad', '9c', '4h', '6s', '2d'],
    street: 'RIVER', effectiveStackBB: 100, bigBlindBB: 2,
    seatStacksBB: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 },
    actionHistory: [
      A('UTG', 'FOLD'), A('HJ', 'FOLD'), A('CO', 'FOLD'),
      A('BTN', 'RAISE', 3), A('SB', 'FOLD'), A('BB', 'CALL', 2),
      A('BB', 'CHECK', undefined, 'FLOP'), A('BTN', 'BET', 2.5, 'FLOP'), A('BB', 'CALL', 2.5, 'FLOP'),
      A('BB', 'CHECK', undefined, 'TURN'), A('BTN', 'BET', 7.5, 'TURN'), A('BB', 'CALL', 7.5, 'TURN'),
      A('BB', 'BET', 10, 'RIVER'),
    ],
    environment: 'MID_LOW_STAKES',
    villain,
  } as unknown as ManualHandInput;
}

const BASE_STATS = {
  handsObserved: 800, vpip: 0.48, pfr: 0.35, threeBet: 0.16, wtsd: 0.36,
  foldToFlopCBet: null, foldToTurnCBet: null, foldToRiverBet: null,
  flopCheckRaise: null, turnCheckRaise: null, riverCheckRaise: null,
} as const;

/** 统计形状（可逐项覆盖；除 `handsObserved` 外都用 `null` 表示未观测，**不是 0**） */
type Stats = { [K in keyof typeof BASE_STATS]: K extends 'handsObserved' ? number : number | null };

/** 已明确绑定的同一名玩家（默认座位 seat_BB，持久身份 player_001，MANIAC 标签） */
const boundVillain = (stats: Stats | null, seatId = 'seat_BB'): ManualVillain => ({
  seatId,
  persistentPlayerId: 'player_001',
  displayName: '阿豪',
  quickProfile: 'MANIAC',
  dynamicHint: 'UNKNOWN',
  stackBB: 100,
  ...(stats === null ? {} : { observedStats: stats }),
});

/** 生产链上的画像解析结果（只读诊断） */
function profileOf(input: ManualHandInput): Record<string, any> {
  const parsed = parseManualInput(input);
  assert.equal(parsed.ok, true, `解析必须成功：${parsed.ok ? '' : JSON.stringify(parsed.issues)}`);
  if (!parsed.ok) throw new Error('unreachable');
  const gate = buildAnalyzableState(parsed.value);
  assert.equal(gate.ok, true);
  if (!gate.ok) throw new Error('unreachable');
  const built = buildDecisionContext({
    state: gate.state, rules: RULES, environment: 'MID_LOW_STAKES', asOf: OPTIONS.asOf,
    ...(parsed.value.villain.quickProfile !== undefined ? { quickProfile: parsed.value.villain.quickProfile } : {}),
    ...(parsed.value.villain.dynamicHint !== undefined ? { dynamicHint: parsed.value.villain.dynamicHint } : {}),
    ...(parsed.value.villain.persistentPlayerId !== undefined && parsed.value.villain.persistentPlayerId !== null
      ? { villainPersistentPlayerId: parsed.value.villain.persistentPlayerId } : {}),
    ...(parsed.value.villain.seatId !== undefined && parsed.value.villain.seatId !== null
      ? { villainSeatId: parsed.value.villain.seatId } : {}),
    ...(parsed.value.villain.displayName !== undefined && parsed.value.villain.displayName !== null
      ? { villainDisplayName: parsed.value.villain.displayName } : {}),
    ...(parsed.value.villain.observedStats !== undefined && parsed.value.villain.observedStats !== null
      ? { observedStats: parsed.value.villain.observedStats } : {}),
    equitySeed: OPTIONS.equitySeed, budget: OPTIONS.budget,
  } as never);
  return { v3: (built.context as unknown as Record<string, any>)['profileV3'], identity: built.playerIdentity };
}

/** 生产输出：画像 + 面对下注的响应事实包 */
function runOf(input: ManualHandInput): Record<string, any> {
  const r = analyzeManualHand(input, OPTIONS);
  assert.equal(r.ok, true, `分析必须成功：${r.ok ? '' : JSON.stringify(r.issues)}`);
  if (!r.ok) throw new Error('unreachable');
  const d = r.decision as unknown as Record<string, any>;
  const dg = d['diagnostics'] as Record<string, any>;
  const pf = (dg['postflop'] ?? {}) as Record<string, any>;
  return {
    action: `${String(d['action'])}${d['sizeChips'] === undefined ? '' : ` @ ${String(d['sizeChips'])}`}`,
    math: dg['math'] as Record<string, any>,
    raise: (pf['raiseResponse'] ?? null) as Record<string, any> | null,
    betRange: (pf['bettingRangeFacts'] ?? null) as Record<string, any> | null,
    /* 下注范围的模型自报输入（`model.ratioToPot` / `model.boardTexture` 是复算带速率的依据） */
    betModel: ((pf['bettingRangeFacts'] ?? null) as Record<string, any> | null)?.['model'] ?? null,
    v3: profileOf(input)['v3'] as Record<string, any>,
    warnings: r.warnings as readonly string[],
  };
}

/**
 * 🔴 **独立复算「下注范围层实际拿到的维度」**：用生产快照**自报**的模型输入
 * （`bettingRangeFacts.model.ratioToPot` 与 `model.boardTexture`）把候选维度喂给
 * **同一个** `betProbabilityByBand`，与生产自报的 `bandRates` 逐位比对。
 *
 * 这样断言的是**语义**（该层吃的是哪份维度），而不是具体数值 ⇒ 不会因调参而假通过。
 */
function bandRatesUnderDims(run: Record<string, any>, dims: unknown, confidence: number): Record<string, number> {
  const model = run['betRange']!['model'] as Record<string, any>;
  const rates = betProbabilityByBand({
    tendencies: responseTendenciesOf(dims as never, confidence, null),
    ratioToPot: model['ratioToPot'] as number,
    boardTexture: model['boardTexture'] as string,
  }).rates as unknown as Record<string, number>;
  return rates;
}

function assertSameRates(
  actual: Record<string, number>,
  expected: Record<string, number>,
  what: string,
): void {
  for (const band of Object.keys(expected)) {
    assert.equal(actual[band], expected[band], `${what}：带 ${band} 必须逐位相同（${String(actual[band])} vs ${String(expected[band])}）`);
  }
}

/**
 * 🔴 **从生产事实包里读「实际传给响应模型的刻度」**。
 *
 * `raiseResponse.model.noteZh` 是生产自己写出来的字符串，包含
 * `callScale … / foldScale … / raiseScale …`；解析失败即测试失败（
 * 不允许因为格式变化而静默通过）。
 */
function responseScalesOf(run: Record<string, any>): { callScale: number; foldScale: number; raiseScale: number } {
  const raise = run['raise'];
  assert.ok(raise !== null && raise !== undefined, '本节点必须有加注响应事实包');
  const note = String((raise!['model'] as Record<string, unknown>)['noteZh'] ?? '');
  const grab = (key: string): number => {
    const m = new RegExp(`${key}\\s+([0-9.]+)`).exec(note);
    assert.ok(m !== null, `必须能从生产 noteZh 里读到 ${key}（实际：${note}）`);
    return Number(m![1]);
  };
  return { callScale: grab('callScale'), foldScale: grab('foldScale'), raiseScale: grab('raiseScale') };
}

/** 决策指纹（只含数值，不含文案） */
function fingerprint(run: Record<string, any>): string {
  const raise = run['raise'];
  const bet = run['betRange'];
  return JSON.stringify({
    action: run['action'],
    eqVsBetRange: run['math']['heroEquityVsBetRange'],
    callEV: run['math']['callEV'],
    arrivalCount: ((run['math'] as Record<string, any>)['arrivalCount'] ?? null),
    betCount: bet === null ? null : bet['entryCount'],
    betMass: bet === null ? null : bet['betMass'],
    raise: raise === null ? null : {
      f: raise['foldLikelihood'], c: raise['callLikelihood'], r: raise['reRaiseLikelihood'],
      eqCall: raise['heroEquityVsRaiseCallRange'], eqReraise: raise['heroEquityVsReraiseRange'],
      ev: raise['raiseEV'], callCombos: raise['callCombos'], reRaiseCombos: raise['reRaiseCombos'],
    },
  });
}

/* ============================================================
 * 测试一 ~ 四：Resolver 极性（现有规则，不含策略断言）
 * ============================================================ */

test('测试一：仅改变 VPIP ⇒ tightness 按现有 Resolver 规则变化（极性 −1）', () => {
  const tight = profileOf(test16(boundVillain({ ...BASE_STATS, vpip: 0.2 })));
  const loose = profileOf(test16(boundVillain({ ...BASE_STATS, vpip: 0.62 })));
  const dt = (tight['v3']['resolvedDimensions'] as Record<string, number>)['tightness'];
  const dl = (loose['v3']['resolvedDimensions'] as Record<string, number>)['tightness'];
  assert.ok(dt > dl, `VPIP 0.20 的 tightness(${dt}) 必须大于 VPIP 0.62 的(${dl})`);
  /* 其余三轴不得因 VPIP 而变（极性表：vpip 只推 tightness） */
  const other = (p: Record<string, any>, axis: string): number => (p['v3']['resolvedDimensions'] as Record<string, number>)[axis];
  for (const axis of ['aggression', 'bluffTendency', 'passivity']) {
    assert.equal(other(tight, axis), other(loose, axis), `VPIP 不得影响 ${axis}`);
  }
});

test('测试二：仅改变 PFR ⇒ aggression 按现有 Resolver 规则变化（极性 +1）', () => {
  const low = profileOf(test16(boundVillain({ ...BASE_STATS, pfr: 0.05 })));
  const high = profileOf(test16(boundVillain({ ...BASE_STATS, pfr: 0.48 })));
  const a1 = (low['v3']['resolvedDimensions'] as Record<string, number>)['aggression'];
  const a2 = (high['v3']['resolvedDimensions'] as Record<string, number>)['aggression'];
  assert.ok(a2 > a1, `PFR 0.48 的 aggression(${a2}) 必须大于 PFR 0.05 的(${a1})`);
  assert.equal(
    (low['v3']['resolvedDimensions'] as Record<string, number>)['tightness'],
    (high['v3']['resolvedDimensions'] as Record<string, number>)['tightness'],
    'PFR 不得影响 tightness（极性 0）',
  );
});

test('测试三：仅改变 3Bet ⇒ 按极性表同时推 tightness(−0.3) 与 aggression(+1.0)', () => {
  const low = profileOf(test16(boundVillain({ ...BASE_STATS, threeBet: 0.02 })));
  const high = profileOf(test16(boundVillain({ ...BASE_STATS, threeBet: 0.3 })));
  const l = low['v3']['resolvedDimensions'] as Record<string, number>;
  const h = high['v3']['resolvedDimensions'] as Record<string, number>;
  assert.ok(h['aggression'] > l['aggression'], `3Bet↑ ⇒ aggression↑（${l['aggression']} → ${h['aggression']}）`);
  /*
   * tightness 的极性是 **−0.3**（3Bet 越高越松），因此要把方向算对：
   * `polarity × observedDeviation`，而 `observedDeviation` 对 3Bet 是单调递增的
   * （`statDeviationOf('threeBet', rate)`）⇒ 3Bet 越高 ⇒ tightness 越低。
   */
  assert.ok(h['tightness'] < l['tightness'], `3Bet↑ ⇒ tightness↓（极性 −0.3；${l['tightness']} → ${h['tightness']}）`);
  assert.equal(l['bluffTendency'], h['bluffTendency'], '3Bet 不得影响 bluffTendency');
});

test('测试四：仅改变 WTSD ⇒ passivity 按现有 Resolver 规则变化（极性 +1）', () => {
  const low = profileOf(test16(boundVillain({ ...BASE_STATS, wtsd: 0.15 })));
  const high = profileOf(test16(boundVillain({ ...BASE_STATS, wtsd: 0.6 })));
  const p1 = (low['v3']['resolvedDimensions'] as Record<string, number>)['passivity'];
  const p2 = (high['v3']['resolvedDimensions'] as Record<string, number>)['passivity'];
  assert.ok(p2 > p1, `WTSD 0.60 的 passivity(${p2}) 必须大于 WTSD 0.15 的(${p1})`);
  assert.equal(
    (low['v3']['resolvedDimensions'] as Record<string, number>)['aggression'],
    (high['v3']['resolvedDimensions'] as Record<string, number>)['aggression'],
    'WTSD 不得影响 aggression',
  );
});

/* ============================================================
 * 测试五 + 危害护栏：融合画像必须进入**面对下注**的生产模型
 * ============================================================ */

test('测试五：仅改变 VPIP（无其他通道）⇒ 生产响应模型的刻度必须随之变化（M1 已接入）', () => {
  /* VPIP 只推 tightness（极性 −1），而 tightness 直接进入 callScale/foldScale ⇒
     若融合画像真的接入了面对下注层，这两个刻度**必然**变化。 */
  const loose = responseScalesOf(runOf(test16(boundVillain({ ...BASE_STATS, vpip: 0.62 }))));
  const tight = responseScalesOf(runOf(test16(boundVillain({ ...BASE_STATS, vpip: 0.2 }))));
  assert.notEqual(
    loose.callScale,
    tight.callScale,
    'VPIP 必须改变面对加注时的 callScale（实际相同 ⇒ 实测画像没有进入面对下注层）',
  );
});

test('护栏 M1：实测贡献必须随样本量单调增长（不得被二次衰减抹平）', () => {
  const at = (hands: number, vpip: number): number =>
    responseScalesOf(runOf(test16(boundVillain({ ...BASE_STATS, handsObserved: hands, vpip })))).foldScale;
  const s20 = at(20, 0.9);
  const s800 = at(800, 0.9);
  const s5000 = at(5000, 0.9);
  assert.ok(
    Math.abs(s5000 - 1) > Math.abs(s20 - 1) && Math.abs(s800 - 1) >= Math.abs(s20 - 1),
    `同一 VPIP 0.90 下，样本越多、实测对 foldScale 的影响必须越强（实测 20 手 ${s20} / 800 手 ${s800} / 5000 手 ${s5000}）`,
  );
});

test('护栏 M2（长期护栏，今天即通过）：融合画像不得放大标签原有的响应倾向', () => {
  const stats = responseScalesOf(runOf(test16(boundVillain({ ...BASE_STATS, vpip: 0.9 }))));
  const labelOnly = responseScalesOf(runOf(test16(boundVillain(null))));
  /*
   * 数学上界（不依赖任何新系数）：融合维度是「标签值」与「实测值」的凸组合，
   * 而 conf ≤ 1 ⇒ 施加到响应刻度上的偏离不得超过「两个来源各自以全强度单独施加」的较大者。
   * 这里用生产可观测的两个端点近似该上界：标签全量（labelOnly 的刻度已含 0.35 上限，
   * 因此取更宽松的 1/0.35 倍）与实测极端值。
   */
  const upperBound = Math.abs(labelOnly['foldScale'] - 1) / 0.35;
  assert.ok(
    Math.abs(stats['foldScale'] - 1) <= upperBound + 1e-9,
    `实测参与后 foldScale 偏离(${Math.abs(stats['foldScale'] - 1).toFixed(4)}) 不得超过标签全量上界(${upperBound.toFixed(4)})`,
  );
});

/* ============================================================
 * 测试六 ~ 十：兼容性 / 收缩 / 单通道 / 身份隔离 / 复现
 * ============================================================ */

test('测试六：无统计、全部 null、0 手 ⇒ 与旧标签路径逐位一致', () => {
  const labelOnly = fingerprint(runOf(test16(boundVillain(null))));
  const allNull = {
    handsObserved: 800,
    vpip: null, pfr: null, threeBet: null, wtsd: null,
    foldToFlopCBet: null, foldToTurnCBet: null, foldToRiverBet: null,
    flopCheckRaise: null, turnCheckRaise: null, riverCheckRaise: null,
  } as const;
  const zeroHands = { ...allNull, handsObserved: 0 } as const;
  assert.equal(fingerprint(runOf(test16(boundVillain(allNull)))), labelOnly, '全部 null ⇒ 必须与无统计逐位一致');
  assert.equal(fingerprint(runOf(test16(boundVillain(zeroHands)))), labelOnly, '0 手 ⇒ 必须与无统计逐位一致');
  assert.equal(
    (profileOf(test16(boundVillain(zeroHands)))['v3'] as Record<string, any>)['observedStatCount'],
    0,
    '0 手 ⇒ 0 项统计',
  );
});

test('测试七：机会数很少时标签仍起作用；机会数充分时实测贡献按融合公式增长', () => {
  const at = (hands: number): Record<string, number> => {
    const p = profileOf(test16(boundVillain({ ...BASE_STATS, handsObserved: hands, vpip: 0.62 })));
    const v3 = p['v3'] as Record<string, any>;
    return {
      fused: (v3['resolvedDimensions'] as Record<string, number>)['tightness'],
      w: (v3['blendWeight'] as Record<string, number>)['tightness'],
      label: (v3['baseDimensions'] as Record<string, number>)['tightness'],
    };
  };
  const small = at(20);
  const big = at(5000);
  assert.ok(small['w'] > 0 && small['w'] < 0.2, `20 手 ⇒ 实测权重必须很小（实际 ${small['w']}）`);
  assert.ok(big['w'] > 0.85, `5000 手 ⇒ 实测权重必须接近 1（实际 ${big['w']}）`);
  assert.ok(big['w'] > small['w'], '实测权重必须随样本单调增长');
  /* 小样本时结果必须**明显**被标签拉住（不得被 20 手劫持） */
  assert.ok(
    Math.abs(small['fused'] - small['label']) < Math.abs(big['fused'] - small['label']),
    `20 手的融合值(${small['fused']}) 必须比 5000 手的(${big['fused']}) 更靠近标签(${small['label']})`,
  );
});

test('测试八：同一统计不得同时通过「轴通道」与「分街通道」重复计票', () => {
  const base = profileOf(test16(boundVillain(BASE_STATS)))['v3'] as Record<string, any>;
  const withFoldStat = profileOf(test16(boundVillain({ ...BASE_STATS, foldToRiverBet: 0.6 })))['v3'] as Record<string, any>;
  const withVpip = profileOf(test16(boundVillain({ ...BASE_STATS, vpip: 0.2 })))['v3'] as Record<string, any>;
  /* ① 分街统计不得推任何轴（极性表全 0） */
  assert.deepEqual(withFoldStat['evidenceMass'], base['evidenceMass'], 'foldToRiverBet 不得改变任何轴的证据质量');
  /* ② 轴统计不得改变任何分街因子 */
  assert.deepEqual(withVpip['street'], base['street'], 'VPIP 不得改变任何分街因子（含 betScale）');
});

test('测试九：身份隔离 —— 改其他座位的画像不得改动当前下注者的响应输入', () => {
  const onBettor = responseScalesOf(runOf(test16(boundVillain(BASE_STATS))));
  const onOtherSeat = responseScalesOf(runOf(test16(boundVillain(BASE_STATS, 'seat_CO'))));
  const noProfile = responseScalesOf(runOf(test16({ quickProfile: 'UNKNOWN', dynamicHint: 'UNKNOWN', stackBB: 100 })));
  assert.notEqual(onBettor.callScale, onOtherSeat.callScale, '绑在下注者身上必须与绑在别处不同（否则画像根本没生效）');
  assert.equal(onOtherSeat.callScale, noProfile.callScale, '绑到非对手座位 ⇒ 不得把画像套到当前下注者身上');
  assert.equal(onOtherSeat.foldScale, noProfile.foldScale);
  assert.equal(onOtherSeat.raiseScale, noProfile.raiseScale);
});

test('测试十：TEST 16 真实生产入口可复现（结构断言，不锁定将被修复改变的数字）', () => {
  const run = runOf(test16(boundVillain(BASE_STATS)));
  assert.match(String(run['action']), /^RAISE @ \d+$/, `桥牌点必须可分析并给出加注建议（实际 ${String(run['action'])}）`);
  assert.ok(run['raise'] !== null, '必须有加注响应事实包（单挑、面对下注）');
  assert.equal(run['raise']!['callCombos'] > 0, true, '跟注桶不得为空');
  assert.equal(run['raise']!['equityMethod'], 'EXACT', '本节点权益为精确枚举');
  assert.equal(run['betRange']!['entryCount'] > 0, true, '下注范围必须非空');
  assert.equal(run['warnings'].length, 0, `身份明确绑定 ⇒ 不应有降级披露（实际 ${JSON.stringify(run['warnings'])}）`);
});

/* ============================================================
 * §四 数学等价性（**先于生产代码修改编写**；只使用契约给定的量）
 * ============================================================ */

type Axes = 'tightness' | 'aggression' | 'bluffTendency' | 'passivity';
const AXES: readonly Axes[] = ['tightness', 'aggression', 'bluffTendency', 'passivity'];

/** 从生产上下文里取出构造有效画像所需的**全部**输入（逐轴权重来自 Resolver 自报） */
function facingInputsOf(input: ManualHandInput): {
  baseDimensions: Record<Axes, number>;
  observedDimensions: Record<Axes, number>;
  blendWeight: Record<Axes, number>;
  labelConfidence: number;
} {
  const parsed = parseManualInput(input);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error('unreachable');
  const gate = buildAnalyzableState(parsed.value);
  assert.equal(gate.ok, true);
  if (!gate.ok) throw new Error('unreachable');
  const built = buildDecisionContext({
    state: gate.state, rules: RULES, environment: 'MID_LOW_STAKES', asOf: OPTIONS.asOf,
    ...(parsed.value.villain.quickProfile !== undefined ? { quickProfile: parsed.value.villain.quickProfile } : {}),
    ...(parsed.value.villain.dynamicHint !== undefined ? { dynamicHint: parsed.value.villain.dynamicHint } : {}),
    villainSeatId: 'seat_BB', villainPersistentPlayerId: 'player_001',
    ...(parsed.value.villain.observedStats !== undefined && parsed.value.villain.observedStats !== null
      ? { observedStats: parsed.value.villain.observedStats } : {}),
    equitySeed: OPTIONS.equitySeed, budget: OPTIONS.budget,
  } as never);
  const v3 = (built.context as unknown as Record<string, any>)['profileV3'] as Record<string, any>;
  return {
    baseDimensions: v3['baseDimensions'],
    /*
     * ⚠️ 快照里的字段名是 `observedDimensions`（`decision.types.ts` 的别名），
     * 与内存对象 `ResolvedPlayerProfile.resolved.observedOnlyDimensions` 是**同一个量**。
     */
    observedDimensions: v3['observedDimensions'],
    blendWeight: v3['blendWeight'],
    /* 生产里面对下注层沿用的“标签结构性置信系数”就是手选标签的可信度上限 */
    labelConfidence: 0.35,
  };
}

test('§四-A：无统计 / 全 null / 0 手 ⇒ 有效画像**逐位退回旧标签实现**', () => {
  const allNull = {
    handsObserved: 800,
    vpip: null, pfr: null, threeBet: null, wtsd: null,
    foldToFlopCBet: null, foldToTurnCBet: null, foldToRiverBet: null,
    flopCheckRaise: null, turnCheckRaise: null, riverCheckRaise: null,
  } as const;
  /* 形态一、二：`observedStats` 给了但全为 null / 0 手（`profileV3` 会挂上，可读自报值） */
  for (const stats of [allNull, { ...allNull, handsObserved: 0 } as const]) {
    const inputs = facingInputsOf(test16(boundVillain(stats)));
    const p = facingBetProfileOf({ ...inputs, labelDimensions: inputs.baseDimensions });
    assert.equal(p.hasObservedEvidence, false, '无轴证据 ⇒ 必须标记为「走旧标签实现」');
    assert.equal(p.confidence, inputs.labelConfidence, '必须沿用原标签置信系数（0.35），不得换成 1');
    for (const axis of AXES) {
      assert.equal(p.dimensions[axis], inputs.baseDimensions[axis], `${axis} 必须等于标签基线维度（逐位）`);
    }
  }
  /*
   * 形态三：**完全不给** `observedStats`（生产上 `resolvedV3` 仍在，但 `profileV3` 不挂到上下文，
   * 因此这里用「无证据」的构造值验证退化行为）。标签维度取自**生产函数**，不硬编码表格。
   */
  const label = archetypeDimensionsOf('MANIAC' as never, 0.35)!;
  const labelDims = {
    tightness: label.tightness, aggression: label.aggression,
    bluffTendency: label.bluffTendency, passivity: label.passivity,
  };
  const noEvidence = facingBetProfileOf({
    baseDimensions: labelDims,
    observedDimensions: { tightness: 0.5, aggression: 0.5, bluffTendency: 0.5, passivity: 0.5 },
    blendWeight: { tightness: 0, aggression: 0, bluffTendency: 0, passivity: 0 },
    labelConfidence: 0.35,
    labelDimensions: labelDims,
  });
  assert.equal(noEvidence.hasObservedEvidence, false);
  assert.equal(noEvidence.confidence, 0.35);
  for (const axis of AXES) {
    assert.equal(noEvidence.dimensions[axis], labelDims[axis], `${axis} 必须逐位等于标签维度`);
    assert.equal(noEvidence.centered[axis], 0.35 * centeredOf(labelDims[axis]), '无证据 ⇒ 只有标签贡献');
  }
});

test('§四-B/C/D/E：只有单一统计时，**只有对应轴**产生实测贡献', () => {
  /* ⚠️ 「只有单一统计」必须真的只给一项（其余全 null），否则别的统计也会给轴加权 */
  const ONLY_ONE = {
    handsObserved: 800,
    vpip: null, pfr: null, threeBet: null, wtsd: null,
    foldToFlopCBet: null, foldToTurnCBet: null, foldToRiverBet: null,
    flopCheckRaise: null, turnCheckRaise: null, riverCheckRaise: null,
  } as const;
  const CASES: [string, Record<string, number>, Axes[]][] = [
    ['仅 VPIP', { vpip: 0.2 }, ['tightness']],
    ['仅 PFR', { pfr: 0.05 }, ['aggression']],
    ['仅 3Bet', { threeBet: 0.3 }, ['tightness', 'aggression']],
    ['仅 WTSD', { wtsd: 0.6 }, ['passivity']],
  ];
  for (const [tag, over, expectedAxes] of CASES) {
    const inputs = facingInputsOf(test16(boundVillain({ ...ONLY_ONE, ...over })));
    const p = facingBetProfileOf({ ...inputs, labelDimensions: inputs.baseDimensions } as never);
    assert.equal(p.hasObservedEvidence, true, `${tag}：必须进入融合路径`);
    for (const axis of AXES) {
      const observedPart = inputs.blendWeight[axis] * centeredOf(inputs.observedDimensions[axis]);
      const labelPart = inputs.labelConfidence * (1 - inputs.blendWeight[axis]) * centeredOf(inputs.baseDimensions[axis]);
      assert.ok(
        Math.abs(p.centered[axis] - (labelPart + observedPart)) < 1e-12,
        `${tag}：${axis} 的有效中心必须等于 标签贡献 + 实测贡献（实际 ${p.centered[axis]}）`,
      );
    }
    /* 预期轴必须有实测成分（w > 0），其余轴的实测贡献必须恰好为 0 */
    for (const axis of AXES) {
      if (expectedAxes.includes(axis)) {
        assert.ok(inputs.blendWeight[axis] > 0, `${tag}：${axis} 必须有实测权重`);
        assert.ok(Math.abs(centeredOf(inputs.observedDimensions[axis])) > 1e-12, `${tag}：${axis} 的实测偏离不得为 0`);
      } else {
        assert.equal(inputs.blendWeight[axis], 0, `${tag}：${axis} 不得有实测权重（该统计不作用于这一轴）`);
      }
    }
  }
});

test('§四-F：bluffTendency 无观测通道 ⇒ 保持标签贡献，不得被推成中性', () => {
  const inputs = facingInputsOf(test16(boundVillain(BASE_STATS)));
  const p = facingBetProfileOf({ ...inputs, labelDimensions: inputs.baseDimensions } as never);
  assert.equal(inputs.blendWeight['bluffTendency'], 0, '前提：bluffTendency 无任何统计通道（极性表全 0）');
  assert.equal(
    p.centered['bluffTendency'],
    0.35 * centeredOf(inputs.baseDimensions['bluffTendency']),
    'bluffTendency 必须保留「标签 × 0.35」的贡献（不是 0 = 中性）',
  );
});

test('§四-G：样本量 20 / 800 / 5000 ⇒ 逐轴权重与贡献按 Resolver 自报值成立', () => {
  for (const hands of [20, 800, 5000]) {
    const inputs = facingInputsOf(test16(boundVillain({ ...BASE_STATS, handsObserved: hands, vpip: 0.62 })));
    const p = facingBetProfileOf({ ...inputs, labelDimensions: inputs.baseDimensions } as never);
    for (const axis of AXES) {
      const expected = inputs.labelConfidence * (1 - inputs.blendWeight[axis]) * centeredOf(inputs.baseDimensions[axis]) +
        inputs.blendWeight[axis] * centeredOf(inputs.observedDimensions[axis]);
      assert.ok(Math.abs(p.centered[axis] - expected) < 1e-12, `${hands} 手：${axis} 贡献必须与合同一致`);
    }
    /* 样本越大 ⇒ 实测占比越高（单调），且标签贡献不得随之放大 */
    if (hands > 20) {
      assert.ok(inputs.blendWeight['tightness'] > 0.03, `${hands} 手：实测权重必须增长（实际 ${inputs.blendWeight['tightness']}）`);
    }
  }
});

test('§三 五条保证：标签不被放大 / 实测不被二次衰减 / 逐轴权重 / 无通道保标签', () => {
  const inputs = facingInputsOf(test16(boundVillain({ ...BASE_STATS, vpip: 0.9 })));
  const p = facingBetProfileOf({ ...inputs, labelDimensions: inputs.baseDimensions } as never);
  for (const axis of AXES) {
    /* ① 标签贡献 ≤ 旧模型幅度（0.35 × |center(base)|） */
    const labelPart = inputs.labelConfidence * (1 - inputs.blendWeight[axis]) * centeredOf(inputs.baseDimensions[axis]);
    assert.ok(
      Math.abs(labelPart) <= Math.abs(inputs.labelConfidence * centeredOf(inputs.baseDimensions[axis])) + 1e-12,
      `${axis}：标签贡献不得超过旧模型幅度`,
    );
    /* ② 实测部分**不**再乘 0.35（即 contribution 精确等于 w × center(observed) 的那一项） */
    const observedPart = p.centered[axis] - labelPart;
    assert.ok(
      Math.abs(observedPart - inputs.blendWeight[axis] * centeredOf(inputs.observedDimensions[axis])) < 1e-12,
      `${axis}：实测贡献必须精确等于 w × center(observed)（不得再按样本置信度缩放一次）`,
    );
  }
  /* ④ 逐轴权重不同（不得用一个平均权重） */
  const ws = AXES.map((a) => inputs.blendWeight[a]);
  assert.ok(new Set(ws).size >= 3, `逐轴融合权重必须各自独立（实际 ${JSON.stringify(ws)}）`);
});

/* ============================================================
 * §五 修复：下注范围层与响应层**分开取证**（自审 F1 ⇒ 选项 A）
 * ============================================================
 *
 * 🔴 **缺陷（自审发现，已量化）**：`betProbabilityByBand` 只读 `effectiveDimensions`、
 * **不读 `confidence`**（`bettingRange.ts:390`；`betResponse.ts:432-437` 维度原样透传）。
 * 于是「把 0.35 折进维度」对两个消费者的含义**不同**：
 *
 * | 消费者 | 读什么 | 折 0.35 的含义 |
 * |---|---|---|
 * | 响应层 `buildRaiseResponse` | 刻度（并按 `confidence` 缩放） | 正确：标签 ×0.35 只进一次 |
 * | 下注范围层 `betProbabilityByBand` | 维度（不看 confidence） | **错误**：标签被从 ×1.0 打到 ×0.35 |
 *
 * 后果（实测）：标签玩家的下注范围在**第一个观测**处跳变 `betMass` −38.1%
 * （0.472404449170 → 0.292598907815），此后 5000 手不再变化；连**无观测通道**的
 * `bluffTendency` 一起被削弱；且该层经 `contextBuilder.ts:4021 → buildRaiseResponse`
 * 回流进「弃/跟/再加注」桶划分（因此上一轮验收块的 `RAISE EV` 有 69.9% 来自这条路）。
 *
 * **修复**：该层改喂 V3 **融合维度**（`resolvedDimensions = (1−w)·标签 + w·实测`），
 * 保持 `confidence = 1`（该层不读它）⇒ 标签份额由 `(1−w)` 承担、实测按 `w` 进入，
 * 且在**零证据**处与修复前逐位一致（`w = 0 ⇒ 融合维度 ≡ 标签维度`）。
 *
 * 以下四条是**语义**断言：用生产自报的 `modeledRatio` + 牌面纹理复算**同一个**模型，
 * 与生产 `bandRates` 逐位比对 —— 不锁具体数值，因此不会因调参而假通过。
 */

test('§五-A1（语义·主）：有轴证据时，下注范围层吃的是 **V3 融合维度**', () => {
  const run = runOf(test16(boundVillain(BASE_STATS)));
  const resolved = run['v3']['resolvedDimensions'] as Record<string, number>;
  assert.ok(resolved !== undefined && resolved !== null, 'V3 快照必须给出 resolvedDimensions');
  assertSameRates(
    run['betRange']!['bandRates'] as Record<string, number>,
    bandRatesUnderDims(run, resolved, 1),
    '有轴证据 ⇒ 该层必须吃融合维度（conf=1，标签份额由 (1−w) 承担）',
  );
});

test('§五-A2（连续性）：第一个观测不得让下注范围跳变（修复前 Δ = 0.179805541）', () => {
  const label = runOf(test16(boundVillain(null)));
  const oneHand = runOf(test16(boundVillain({ ...NO_AXIS_STATS, handsObserved: 1, vpip: 0.48 })));
  const mass0 = label['betRange']!['betMass'] as number;
  const mass1 = oneHand['betRange']!['betMass'] as number;
  /*
   * 1 手 ⇒ w = 1/(1+500) ≈ 0.002 ⇒ 标签份额只应衰减 0.2%
   * ⇒ 下注范围的变化必须与**证据量同阶**，而不是跳到「标签 ×0.35」。
   * 阈值 0.01 = 修复前跳变量的 1/18（修复前实测 0.179805541）。
   */
  assert.ok(
    Math.abs(mass1 - mass0) < 0.01,
    `1 手观测的 betMass 偏差必须与证据量同阶：实际 ${Math.abs(mass1 - mass0)}（修复前 0.179805541）`,
  );
  /* 对照：样本量足够时该层**必须**动起来（证明上一条不是「统计没进来」） */
  const many = runOf(test16(boundVillain(BASE_STATS)));
  assert.ok(
    Math.abs((many['betRange']!['betMass'] as number) - mass0) > Math.abs(mass1 - mass0),
    '800 手对该层的影响必须大于 1 手（否则说明该层仍与证据量脱钩）',
  );
});

test('§五-A3（保真）：无轴证据时该层逐位走标签维度（修复前后一致）', () => {
  const label = archetypeDimensionsOf('MANIAC', 0.35);
  assert.ok(label !== null);
  for (const [tag, villain] of [
    ['无统计', boundVillain(null)],
    ['全 null', boundVillain(NO_AXIS_STATS)],
    ['0 手', boundVillain({ ...NO_AXIS_STATS, handsObserved: 0 })],
  ] as const) {
    const run = runOf(test16(villain));
    assertSameRates(
      run['betRange']!['bandRates'] as Record<string, number>,
      bandRatesUnderDims(run, label, 0.35),
      `${tag} ⇒ 该层必须吃标签维度（= 修复前）`,
    );
  }
});

test('§五-A4（反证）：修复后该层**不再**吃「折了 0.35」的维度', () => {
  const input = test16(boundVillain(BASE_STATS));
  const run = runOf(input);
  const facing = facingBetProfileOf({ ...facingInputsOf(input), labelDimensions: facingInputsOf(input).baseDimensions });
  const folded = bandRatesUnderDims(run, facing.dimensions, facing.confidence);
  const actual = run['betRange']!['bandRates'] as Record<string, number>;
  const differing = Object.keys(folded).filter((b) => folded[b] !== actual[b]).length;
  assert.ok(
    differing > 0,
    `若这里为 0 ⇒ 修复未生效（该层仍在吃折过 0.35 的维度，标签被从 ×1.0 打到 ×0.35）`,
  );
});

/* ============================================================
 * §六 墨菲定律对抗测试（M-1 ~ M-10）—— 专挑「能不成立就不成立」的地方
 * ============================================================
 *
 * 修复「下注范围层吃错维度」之后，最可能出事的形态是：
 *   ① 为了连续而把证据放大（小样本跳变、方向反了、无证据不再保真）；
 *   ② 为了隔离而把证据丢掉（该动的层不动、该动的轴不动）；
 *   ③ 身份/座位错位时把甲的画像套到乙身上；
 *   ④ 极端或非法输入把 NaN / 越界速率灌进模型；
 *   ⑤ 顺手改坏了另一条通道（响应层的 P1 不许被这次修复动到）。
 * 每条测试都写明「若不成立意味着什么」。
 */

/** 中性维度（无画像）—— 用于「该层必须中立」的对照 */
const NEUTRAL_DIMS = { tightness: 0.5, aggression: 0.5, bluffTendency: 0.5, passivity: 0.5 };

test('墨菲 M-1（样本量）：证据增加必须**连续且单调**，第一步不得跳变', () => {
  const measure = (hands: number): { mass: number; air: number } => {
    const r = runOf(test16(boundVillain({ ...BASE_STATS, handsObserved: hands })));
    return {
      mass: r['betRange']!['betMass'] as number,
      air: (r['betRange']!['bandRates'] as Record<string, number>)['AIR'] as number,
    };
  };
  const seq = [0, 1, 20, 800, 5000].map(measure);
  for (let i = 1; i < seq.length; i += 1) {
    assert.ok(
      seq[i]!.mass <= seq[i - 1]!.mass,
      `证据越多，下注范围必须单调地向实测方向移动：第 ${i - 1} 步 ${seq[i - 1]!.mass} → 第 ${i} 步 ${seq[i]!.mass}`,
    );
    assert.ok(seq[i]!.air <= seq[i - 1]!.air, `AIR 速率同样必须单调：${seq[i - 1]!.air} → ${seq[i]!.air}`);
  }
  const firstStep = Math.abs(seq[1]!.mass - seq[0]!.mass);
  const total = Math.abs(seq[4]!.mass - seq[0]!.mass);
  assert.ok(
    firstStep < total * 0.1,
    `第一步（0 → 1 手）不得吃掉大部分位移：第一步 ${firstStep}，总位移 ${total}（修复前第一步 0.179805541 是总位移的 5776%）`,
  );
});

test('墨菲 M-2（保真）：四种「无轴证据」形态必须与纯标签**逐位一致**', () => {
  const reference = fingerprint(runOf(test16(boundVillain(null))));
  const forms: ReadonlyArray<readonly [string, Stats]> = [
    ['handsObserved = 0（频率非 null）', { ...BASE_STATS, handsObserved: 0 }],
    ['全部频率 null', NO_AXIS_STATS],
    ['1 手 + 全 null', { ...NO_AXIS_STATS, handsObserved: 1 }],
    ['只有分街统计', { ...NO_AXIS_STATS, foldToRiverBet: 0.6, riverCheckRaise: 0.2 }],
  ];
  for (const [tag, stats] of forms) {
    assert.equal(
      fingerprint(runOf(test16(boundVillain(stats)))),
      reference,
      `${tag} ⇒ 面对下注路径必须与纯标签逐位一致（含响应层与响应概率）`,
    );
  }
});

test('墨菲 M-3（逐轴隔离）：PFR 证据不得改动其它三个轴（防「一轴有证据、四轴一起缩」）', () => {
  const inputs = facingInputsOf(test16(boundVillain({ ...NO_AXIS_STATS, pfr: 0.35 })));
  const labelDim = archetypeDimensionsOf('MANIAC', 0.35)!;
  for (const axis of ['tightness', 'bluffTendency', 'passivity'] as const) {
    assert.equal(inputs.blendWeight[axis], 0, `${axis} 不得因为 PFR 有证据而获得权重`);
    assert.equal(
      inputs.observedDimensions[axis], 0.5,
      `${axis} 无观测 ⇒ observed-only 维度必须精确 0.5（否则标签会被无证据的轴稀释）`,
    );
    assert.equal(inputs.baseDimensions[axis], labelDim[axis], `${axis} 标签基线不得被别的轴的证据改动`);
  }
  assert.ok(inputs.blendWeight['aggression'] > 0, 'aggression 必须有实测权重');
});

test('墨菲 M-4（方向）：与标签方向相反的实测必须把该层推向实测，且结果夹在两个来源之间', () => {
  const villain = boundVillain({ ...NO_AXIS_STATS, pfr: 0.05 });
  const run = runOf(test16(villain));
  const labelDim = archetypeDimensionsOf('MANIAC', 0.35)!;
  const observed = facingInputsOf(test16(villain)).observedDimensions;
  /* ① 逐轴夹逼：融合维度必须落在「标签」与「实测」之间（凸组合的性质） */
  for (const axis of AXES) {
    const lo = Math.min(labelDim[axis], observed[axis]);
    const hi = Math.max(labelDim[axis], observed[axis]);
    const fused = run['v3']['resolvedDimensions'][axis] as number;
    assert.ok(lo - 1e-12 <= fused && fused <= hi + 1e-12, `${axis}：融合值 ${fused} 必须夹在 [${lo}, ${hi}]`);
  }
  /* ② 逐带夹逼：该层拿到的带速率同样必须在两个来源之间 */
  const labelRates = bandRatesUnderDims(run, labelDim, 0.35);
  const observedRates = bandRatesUnderDims(run, { ...NEUTRAL_DIMS, ...observed }, 1);
  const actual = run['betRange']!['bandRates'] as Record<string, number>;
  for (const band of Object.keys(labelRates)) {
    const lo = Math.min(labelRates[band]!, observedRates[band]!);
    const hi = Math.max(labelRates[band]!, observedRates[band]!);
    assert.ok(
      actual[band]! >= lo - 1e-12 && actual[band]! <= hi + 1e-12,
      `${band}：实际 ${actual[band]} 必须夹在标签 ${labelRates[band]} 与实测 ${observedRates[band]} 之间`,
    );
  }
  /* ③ 方向：极低 PFR（与疯型标签相反）必须让诈唬端下注率下降 */
  assert.ok(
    actual['AIR']! < labelRates['AIR']!,
    `与标签方向相反的实测必须降低 AIR 下注率：${actual['AIR']} vs 标签 ${labelRates['AIR']}`,
  );
});

test('墨菲 M-5（身份）：画像指向别的座位 ⇒ 该层必须中立，且必须**可见地**披露', () => {
  const wrongSeat = runOf(test16(boundVillain(BASE_STATS, 'seat_CO')));
  const neutral = bandRatesUnderDims(wrongSeat, NEUTRAL_DIMS, 1);
  assertSameRates(
    wrongSeat['betRange']!['bandRates'] as Record<string, number>,
    neutral,
    '画像绑 seat_CO 而下注者是 BB ⇒ 该层必须吃中立维度（绝不把甲的画像套到乙身上）',
  );
  assert.ok(wrongSeat['warnings'].length > 0, '身份不匹配必须留下可见披露（不允许静默）');
  /* 对照：绑对座位时必须不中立（证明上一条不是「画像整体失效」） */
  const rightSeat = runOf(test16(boundVillain(BASE_STATS, 'seat_BB')));
  const differing = Object.keys(neutral).filter(
    (b) => (rightSeat['betRange']!['bandRates'] as Record<string, number>)[b] !== neutral[b],
  );
  assert.ok(differing.length > 0, '绑对座位时该层必须变动（否则画像整条链没生效）');
});

test('墨菲 M-6（极端与非法输入）：不得产生 NaN / 越界速率，动作必须仍然合法', () => {
  const cases: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ['全 1.0 / 混合极值', { vpip: 1, pfr: 0, threeBet: 1, wtsd: 1 }],
    ['全 0.0', { vpip: 0, pfr: 0, threeBet: 0, wtsd: 0 }],
    ['NaN / 越界 / 负值', { vpip: Number.NaN, pfr: -1, threeBet: 5, wtsd: Number.NaN }],
  ];
  for (const [tag, over] of cases) {
    const run = runOf(test16(boundVillain({ ...BASE_STATS, ...over })));
    const rates = run['betRange']!['bandRates'] as Record<string, number>;
    for (const [band, rate] of Object.entries(rates)) {
      assert.ok(Number.isFinite(rate), `${tag}：${band} 速率必须有限（实际 ${String(rate)}）`);
      assert.ok(rate >= 0 && rate <= 1, `${tag}：${band} 速率必须在 [0,1]（实际 ${String(rate)}）`);
    }
    assert.ok(Number.isFinite(run['betRange']!['betMass'] as number), `${tag}：betMass 必须有限`);
    assert.ok(Number.isFinite(run['math']['callEV'] as number), `${tag}：callEV 必须有限`);
    assert.ok(Number.isFinite(run['raise']!['raiseEV'] as number), `${tag}：raiseEV 必须有限`);
    assert.match(String(run['action']), /^RAISE @ \d+$/, `${tag}：动作必须仍然合法可执行（实际 ${String(run['action'])}）`);
  }
});

test('墨菲 M-7（已知饱和，U1）：未饱和区必须单调，饱和区必须平坦（把这一限制钉住）', () => {
  const massOf = (pfr: number): number =>
    runOf(test16(boundVillain({ ...NO_AXIS_STATS, pfr })))['betRange']!['betMass'] as number;
  const lo = massOf(0.05);
  const mid = massOf(0.2);
  assert.ok(mid > lo, `未饱和区必须单调：PFR 0.05 → ${lo}，PFR 0.20 → ${mid}`);
  assert.equal(massOf(0.35), massOf(0.75), 'PFR ≥ 0.35 已饱和（偏差 clamp 到 +1）⇒ 逐位相同（U1 已知限制，未修）');
  assert.equal(massOf(0.02), massOf(0.05), 'PFR ≤ 0.05 已饱和 ⇒ 逐位相同（U1 已知限制，未修）');
});

test('墨菲 M-8（确定性）：同输入重复、键序不同 ⇒ 输出逐位相同', () => {
  const a = runOf(test16(boundVillain(BASE_STATS)));
  const b = runOf(test16(boundVillain(BASE_STATS)));
  assert.equal(fingerprint(a), fingerprint(b), '同输入两次必须逐位相同');
  const shuffled = {
    riverCheckRaise: null, wtsd: 0.36, foldToRiverBet: null, pfr: 0.35,
    handsObserved: 800, turnCheckRaise: null, vpip: 0.48, flopCheckRaise: null,
    threeBet: 0.16, foldToFlopCBet: null, foldToTurnCBet: null,
  } as unknown as Stats;
  assert.equal(fingerprint(a), fingerprint(runOf(test16(boundVillain(shuffled)))), '键序不得改变结果');
});

test('墨菲 M-9（不许改坏另一条通道）：本次修复不得改动响应层（P1）', () => {
  /*
   * 修复只应改「下注范围层吃哪份维度」。响应层的刻度在修复前后必须一致：
   * MANIAC + 800 手 ⇒ call/fold/raise = 1.076 / 0.865 / 1.149（M1 实施时实测值）。
   */
  const scales = responseScalesOf(runOf(test16(boundVillain(BASE_STATS))));
  const near = (x: number, target: number): boolean => Math.abs(x - target) < 5e-4;
  assert.ok(near(scales.callScale, 1.076), `callScale 必须仍是 1.076（实际 ${scales.callScale}）`);
  assert.ok(near(scales.foldScale, 0.865), `foldScale 必须仍是 0.865（实际 ${scales.foldScale}）`);
  assert.ok(near(scales.raiseScale, 1.149), `raiseScale 必须仍是 1.149（实际 ${scales.raiseScale}）`);
  const labelOnly = responseScalesOf(runOf(test16(boundVillain(null))));
  assert.ok(near(labelOnly.callScale, 1.013), `无统计时 callScale 必须仍是 1.013（实际 ${labelOnly.callScale}）`);
  assert.ok(near(labelOnly.foldScale, 0.948), `无统计时 foldScale 必须仍是 0.948（实际 ${labelOnly.foldScale}）`);
});

test('墨菲 M-10（金融口径不被触碰）：概率归一、桶非空、动作与权益关系不变', () => {
  const run = runOf(test16(boundVillain(BASE_STATS)));
  const raise = run['raise']!;
  assert.equal(raise['equityMethod'], 'EXACT', '本节点权益必须仍是精确枚举');
  assert.ok(raise['callCombos'] > 0 && raise['reRaiseCombos'] >= 0, '桶组合数必须非负且跟注桶非空');
  const p = (raise['foldLikelihood'] as number) + (raise['callLikelihood'] as number) + (raise['reRaiseLikelihood'] as number);
  assert.ok(Math.abs(p - 1) < 1e-12, `弃/跟/再加注概率必须归一（实际和 ${p}）`);
  assert.ok((raise['raiseEV'] as number) > (run['math']['callEV'] as number), 'RAISE EV 仍应高于 CALL EV（本节点）');
  assert.equal(String(run['action']), 'RAISE @ 120', '最终动作不得因本次修复改变');
});

/*
 * ============================================================
 * 附录：接口语义固定（自审 F1 —— 两个消费者对 confidence 的处理**不同**）
 * ============================================================
 *
 * 🔴 **自审发现（必须先读）**：
 *
 * | 消费者 | 读什么 | 是否用 `confidence` 缩放 |
 * |---|---|---|
 * | `buildRaiseResponse`（面对加注的响应） | `callScale/foldScale/raiseScale/bluffRaiseScale` | **是** |
 * | `betProbabilityByBand`（当前主动下注范围） | `effectiveDimensions` | **否**（直接读维度） |
 *
 * ⇒ 同一个「已折 0.35」的维度对两者的含义不同：响应层折一次是对的，
 * 下注范围层则等于把标签从 ×1.0 打到 ×0.35。**已按选项 A 修复**（见 §五）：
 * 该层现在吃 `resolvedDimensions`（标签份额 (1−w)、实测 w、不折 0.35）。
 *
 * 附录-1 固定**接口语义**（该层不读 confidence）——它是「必须分开取证」的根据；
 * 附录-2 固定**修复后的归因**（该层不吃 VPIP 的取值，变化来自标签份额 (1−w) 衰减）。
 */

const NO_AXIS_STATS = {
  handsObserved: 800,
  vpip: null, pfr: null, threeBet: null, wtsd: null,
  foldToFlopCBet: null, foldToTurnCBet: null, foldToRiverBet: null,
  flopCheckRaise: null, turnCheckRaise: null, riverCheckRaise: null,
} as const;

test('附录-1（接口语义固定）：`betProbabilityByBand` **忽略** confidence —— 它直接读 `effectiveDimensions`', async () => {
  const { betProbabilityByBand } = await import('../src/app/manualInput/bettingRange.ts');
  const { responseTendenciesOf } = await import('../src/domain/postflop/betResponse.ts');
  const dims = archetypeDimensionsOf('MANIAC', 0.35);
  assert.ok(dims !== null);
  const rates = (conf: number): Record<string, number> => betProbabilityByBand({
    tendencies: responseTendenciesOf(dims, conf, null),
    ratioToPot: 0.37735849056603776,
    boardTexture: 'DRY',
  }).rates as unknown as Record<string, number>;
  const low = rates(0.35);
  const high = rates(1);
  const bands = Object.keys(low);
  assert.equal(bands.length > 0, true, '必须有强度带');
  let differing = 0;
  for (const band of bands) {
    if (low[band] !== high[band]) differing += 1;
  }
  assert.equal(
    differing, 0,
    `同一维度、confidence 0.35 vs 1.00 必须给出相同速率（实际 ${differing}/${bands.length} 带不同）⇒ 这是「该模型不读 confidence」的**机器可验证证据**`,
  );
});

test('附录-2（归因固定·修复后）：该层**逐轴隔离** —— 只给 VPIP 时下注范围与纯标签逐位相同', () => {
  const run = (stats: Record<string, unknown> | null): Record<string, any> =>
    runOf(test16(boundVillain(stats as never)));
  const labelOnly = run(null);
  const tight = run({ ...NO_AXIS_STATS, vpip: 0.9 });
  const loose = run({ ...NO_AXIS_STATS, vpip: 0.2 });
  const oneHand = run({ ...NO_AXIS_STATS, handsObserved: 1, vpip: 0.48 });
  const full = run(BASE_STATS);
  const scales = (r: Record<string, any>): { foldScale: number } => responseScalesOf(r);
  /*
   * ① **逐轴隔离**：`betProbabilityByBand` 只消费 aggression / bluffTendency / passivity，
   * 不消费 tightness；而 V3 融合是**逐轴**的（无证据的轴保留标签基线）。
   * ⇒ 只有 VPIP 有证据时，该层必须与「纯标签」**逐位相同**（修复前它会跳 −38.1%）。
   */
  for (const [tag, r] of [['VPIP 0.90', tight], ['VPIP 0.20', loose], ['VPIP 0.48·1 手', oneHand]] as const) {
    assertSameRates(
      r['betRange']['bandRates'] as Record<string, number>,
      bandRatesUnderDims(labelOnly, (labelOnly['v3']['baseDimensions'] as Record<string, number>), 0.35),
      `${tag} ⇒ 该层不消费 tightness，必须与纯标签逐位相同`,
    );
    assert.equal(
      r['betRange']['betMass'], labelOnly['betRange']['betMass'],
      `${tag} ⇒ betMass 必须与纯标签逐位相同`,
    );
  }
  /* ② 该层消费的轴有证据时**必须**变化（否则等于实测没进这一层） */
  assert.notEqual(
    full['betRange']['betMass'], labelOnly['betRange']['betMass'],
    'PFR/3Bet/WTSD 有证据（⇒ aggression/passivity）时，下注范围必须变化',
  );
  /* ③ 变化幅度必须与证据量同阶：1 手几乎不动，800 手才明显（修复前 1 手即跳 −38.1%） */
  const d1 = Math.abs((oneHand['betRange']['betMass'] as number) - (labelOnly['betRange']['betMass'] as number));
  const d800 = Math.abs((full['betRange']['betMass'] as number) - (labelOnly['betRange']['betMass'] as number));
  assert.equal(d1, 0, '1 手（VPIP 单轴）不得移动该层');
  assert.ok(d800 > 0.01, `800 手四轴证据必须明显移动该层（实际 ${d800}）`);
  /* ④ 对照：响应层确实随 VPIP 的**取值**变化（证明①②不是「统计整体没进模型」） */
  assert.notEqual(
    scales(tight).foldScale, scales(loose).foldScale,
    '响应刻度必须随 VPIP 变化（实测确实进入了响应模型）',
  );
});

test('附录-3（覆盖补强）：只有**分街**统计（FoldTo*/CheckRaise）时，面对下注路径不得改变任何输出', () => {
  const streetOnly = {
    ...NO_AXIS_STATS,
    foldToFlopCBet: 0.62, foldToTurnCBet: 0.55, foldToRiverBet: 0.48,
    flopCheckRaise: 0.14, turnCheckRaise: 0.11, riverCheckRaise: 0.09,
  } as const;
  const a = runOf(test16(boundVillain(NO_AXIS_STATS)));
  const b = runOf(test16(boundVillain(streetOnly)));
  /*
   * 分街统计只走 `STAT_DIMENSION_POLARITY` 全零的街头通道（`streetFactors`），
   * 不产生任何「四轴证据」⇒ 面对下注层必须逐位退回旧标签实现。
   */
  assert.equal(fingerprint(a), fingerprint(b), '分街统计不得改变面对下注路径的任何数值');
  const pa = facingInputsOf(test16(boundVillain(NO_AXIS_STATS)));
  const pb = facingInputsOf(test16(boundVillain(streetOnly)));
  for (const axis of AXES) {
    assert.equal(pb.observedDimensions[axis], pa.observedDimensions[axis], `${axis} 不得被分街统计改动`);
    assert.equal(pb.blendWeight[axis], pa.blendWeight[axis], `${axis} 权重不得被分街统计改动`);
  }
});

test('附录-4（潜在风险固定）：`baseDimensions` 目前逐位等于手选标签维度（跨 4 类画像）', () => {
  for (const archetype of ['MANIAC', 'CALLING_STATION', 'VERY_TIGHT', 'NORMAL'] as const) {
    const villain: ManualVillain = { ...boundVillain(BASE_STATS), quickProfile: archetype };
    const inputs = facingInputsOf(test16(villain));
    const label = archetypeDimensionsOf(archetype, inputs.labelConfidence);
    assert.ok(label !== null, `${archetype} 必须有维度表`);
    for (const axis of AXES) {
      assert.equal(
        inputs.baseDimensions[axis], label[axis],
        `${archetype}.${axis}：V3 基线维度与手选标签维度必须逐位一致（当前实现依赖这一等价：标签份额取 labelDimensions、权重取 baseDimensions）`,
      );
    }
  }
});
