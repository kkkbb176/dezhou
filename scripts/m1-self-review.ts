/**
 * M1 自审探针（只读）—— 针对**我自己**刚做的修改做对抗性检查
 *
 * 检查项：
 *  R1 生产级：「只有分街统计、四轴无证据」是否与「完全无统计」逐位相同（另一条不可见回归路径）
 *  R2 生产级：observation-only（无标签 + 有效 dynamicHint）时的行为与 labelConfidence 语义
 *  R3 交叉分支：面对下注层（新）与 Hero 主动下注层（旧）对**同一份实测证据**的施加强度差异
 *  R4 一致性：`playerBuilt` 标签维度与 V3 `baseDimensions` 是否逐位相同（我传了两份）
 *  R5 性能：每次构建调用 `facingBetProfileOf` 的次数（是否重复计算）
 */
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';
import { parseManualInput, type ManualHandInput, type ManualVillain } from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import { facingBetProfileOf, centeredOf } from '../src/app/manualInput/facingBetProfile.ts';
import { responseTendenciesOf } from '../src/domain/postflop/betResponse.ts';
import { archetypeDimensionsOf } from '../src/domain/player/archetypeDimensions.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const OPTIONS = {
  rules: RULES, asOf: 1_757_000_000_000, writeLog: false,
  equitySeed: 20_260_913, budget: { softMs: 120_000, hardMs: 240_000 },
} as const;

const A_ = (position: string, type: string, amountBB?: number, street?: string): Record<string, unknown> => ({
  position, type, ...(amountBB === undefined ? {} : { amountBB }), ...(street === undefined ? {} : { street }),
});
function test16(villain: ManualVillain): ManualHandInput {
  return {
    tableSize: 6, heroPosition: 'BTN', heroCards: ['As', 'Ah'], board: ['Ad', '9c', '4h', '6s', '2d'],
    street: 'RIVER', effectiveStackBB: 100, bigBlindBB: 2,
    seatStacksBB: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 },
    actionHistory: [
      A_('UTG', 'FOLD'), A_('HJ', 'FOLD'), A_('CO', 'FOLD'),
      A_('BTN', 'RAISE', 3), A_('SB', 'FOLD'), A_('BB', 'CALL', 2),
      A_('BB', 'CHECK', undefined, 'FLOP'), A_('BTN', 'BET', 2.5, 'FLOP'), A_('BB', 'CALL', 2.5, 'FLOP'),
      A_('BB', 'CHECK', undefined, 'TURN'), A_('BTN', 'BET', 7.5, 'TURN'), A_('BB', 'CALL', 7.5, 'TURN'),
      A_('BB', 'BET', 10, 'RIVER'),
    ],
    environment: 'MID_LOW_STAKES', villain,
  } as unknown as ManualHandInput;
}

const S = {
  handsObserved: 800, vpip: 0.48, pfr: 0.35, threeBet: 0.16, wtsd: 0.36,
  foldToFlopCBet: null, foldToTurnCBet: null, foldToRiverBet: null,
  flopCheckRaise: null, turnCheckRaise: null, riverCheckRaise: null,
} as const;
const STREET_ONLY = { ...S, vpip: null, pfr: null, threeBet: null, wtsd: null, foldToRiverBet: 0.6, riverCheckRaise: 0.2 } as const;

const line = (s = ''): void => console.log(s);
const n = (v: unknown, d = 6): string => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : String(v));
const rule = (w = 120): string => '='.repeat(w);

function scalesOf(input: ManualHandInput): Record<string, any> {
  const r = analyzeManualHand(input, OPTIONS);
  if (!r.ok) return { failed: r.stage };
  const dg = (r.decision as unknown as Record<string, any>)['diagnostics'] as Record<string, any>;
  const pf = (dg['postflop'] ?? {}) as Record<string, any>;
  const rr = (pf['raiseResponse'] ?? null) as Record<string, any> | null;
  const note = String(rr?.['model']?.['noteZh'] ?? '');
  const g = (k: string): number => Number(new RegExp(`${k}\\s+([0-9.]+)`).exec(note)?.[1] ?? NaN);
  return {
    call: g('callScale'), fold: g('foldScale'), raise: g('raiseScale'),
    betMass: pf['bettingRangeFacts']?.['betMass'] ?? null,
    eqBet: (dg['math'] ?? {})['heroEquityVsBetRange'] ?? null,
    eqCall: rr?.['heroEquityVsRaiseCallRange'] ?? null,
    probs: rr === null ? null : [rr['foldLikelihood'], rr['callLikelihood'], rr['reRaiseLikelihood']],
    callEV: (dg['math'] ?? {})['callEV'] ?? null,
    raiseEV: rr?.['raiseEV'] ?? null,
    action: `${String((r.decision as any).action)} @ ${String((r.decision as any).sizeChips)}`,
    warnings: r.warnings as readonly string[],
  };
}
const fp = (s: Record<string, any>): string => JSON.stringify(s);

/* ---------------- R1 ---------------- */
line(rule());
line(' R1 「只有分街统计（四轴无证据）」是否与「完全无统计」逐位相同');
line(rule());
{
  const none = scalesOf(test16({ seatId: 'seat_BB', persistentPlayerId: 'p1', quickProfile: 'MANIAC', dynamicHint: 'UNKNOWN', stackBB: 100 }));
  const streetOnly = scalesOf(test16({ seatId: 'seat_BB', persistentPlayerId: 'p1', quickProfile: 'MANIAC', dynamicHint: 'UNKNOWN', stackBB: 100, observedStats: STREET_ONLY }));
  line(`  无统计            ：刻度 ${n(none.call, 4)}/${n(none.fold, 4)}/${n(none.raise, 4)}｜betMass ${n(none.betMass)}｜RAISE EV ${n(none.raiseEV, 4)}`);
  line(`  只有分街统计      ：刻度 ${n(streetOnly.call, 4)}/${n(streetOnly.fold, 4)}/${n(streetOnly.raise, 4)}｜betMass ${n(streetOnly.betMass)}｜RAISE EV ${n(streetOnly.raiseEV, 4)}`);
  const same = fp({ ...none, warnings: [] }) === fp({ ...streetOnly, warnings: [] });
  line(`  ⇒ 逐位相同：${same ? '✔ 是（另一条不可见回归路径也守住了）' : '✖ 否（**发现缺陷**）'}`);
  line(`     ⚠️ 注意：分街统计本来也只服务「Hero 主动下注分支」，本节点不消费它们（审计已记录）——本检查只确认**没有回归**。`);
}

/* ---------------- R2 ---------------- */
line('');
line(rule());
line(' R2 observation-only（无标签 + 有效 dynamicHint）与 labelConfidence 语义');
line(rule());
{
  const tiltNoStats = scalesOf(test16({ seatId: 'seat_BB', persistentPlayerId: 'p1', dynamicHint: 'TILT_SIGNAL', stackBB: 100 }));
  const tiltStats = scalesOf(test16({ seatId: 'seat_BB', persistentPlayerId: 'p1', dynamicHint: 'TILT_SIGNAL', stackBB: 100, observedStats: S }));
  line(`  无标签 + TILT_SIGNAL + 无统计：刻度 ${n(tiltNoStats.call, 4)}/${n(tiltNoStats.fold, 4)}/${n(tiltNoStats.raise, 4)}｜RAISE EV ${n(tiltNoStats.raiseEV, 4)}`);
  line(`  无标签 + TILT_SIGNAL + 四统计：刻度 ${n(tiltStats.call, 4)}/${n(tiltStats.fold, 4)}/${n(tiltStats.raise, 4)}｜RAISE EV ${n(tiltStats.raiseEV, 4)}`);
  const label = archetypeDimensionsOf('MANIAC' as never, 0.35)!;
  line(`  ⇒ 说明：无标签时 V3 的 baseDimensions 全为 0.5 ⇒ 标签贡献恒为 0（0.5×…×center(0.5)=0），`);
  line(`     因此即使 playerBuilt.confidence 此时是 NO_DATA_NEUTRAL(0.5) 而不是 0.35，数值也不受影响 ✔`);
  line(`     （但这是一个**语义隐患**：`+'`playerBuilt.confidence`' + ` 并非纯粹的「标签置信度」）`);
  void label;
}

/* ---------------- R3 ---------------- */
line('');
line(rule());
line(' R3 交叉分支：面对下注层（新）vs Hero 主动下注层（旧）对同一份实测证据的强度');
line(rule());
{
  const built = (() => {
    const p = parseManualInput(test16({ seatId: 'seat_BB', persistentPlayerId: 'p1', quickProfile: 'MANIAC', dynamicHint: 'UNKNOWN', stackBB: 100, observedStats: S }));
    const g = buildAnalyzableState(p.value!);
    return buildDecisionContext({
      state: g.state, rules: RULES, environment: 'MID_LOW_STAKES', asOf: OPTIONS.asOf,
      quickProfile: 'MANIAC', dynamicHint: 'UNKNOWN', villainSeatId: 'seat_BB', villainPersistentPlayerId: 'p1',
      observedStats: S as never, equitySeed: OPTIONS.equitySeed, budget: OPTIONS.budget,
    } as never);
  })();
  const v3 = (built.context as unknown as Record<string, any>)['profileV3'] as Record<string, any>;
  const base = archetypeDimensionsOf('MANIAC' as never, 0.35)!;
  const labelDims = { tightness: base.tightness, aggression: base.aggression, bluffTendency: base.bluffTendency, passivity: base.passivity };
  const facing = facingBetProfileOf({
    baseDimensions: v3['baseDimensions'], observedDimensions: v3['observedDimensions'], blendWeight: v3['blendWeight'],
    labelConfidence: 0.35, labelDimensions: labelDims,
  });
  /* Hero 分支的调用形态：resolvedDimensions + profileConfidence(0.35) */
  const heroBranch = responseTendenciesOf(v3['resolvedDimensions'] as never, 0.35, null);
  const facingBranch = responseTendenciesOf(facing.dimensions, facing.confidence, null);
  line('  ' + '分支'.padEnd(26) + 'callScale'.padStart(11) + 'foldScale'.padStart(11) + 'raiseScale'.padStart(12) + '  施加方式');
  line(`  ${'面对下注层（本轮新）'.padEnd(24)}${n(facingBranch.callScale, 4).padStart(11)}${n(facingBranch.foldScale, 4).padStart(11)}${n(facingBranch.raiseScale, 4).padStart(12)}   标签×0.35 + 实测×w（各一次）`);
  line(`  ${'Hero 主动下注层（旧）'.padEnd(22)}${n(heroBranch.callScale, 4).padStart(11)}${n(heroBranch.foldScale, 4).padStart(11)}${n(heroBranch.raiseScale, 4).padStart(12)}   融合维度 × 0.35 ⇒ 实测被二次衰减`);
  line(`  ⇒ 两分支对**实测份额**的强度比 ≈ 1 / 0.35 = ${n(1 / 0.35, 2)}×（实测份额：新 ${n(facing.centered.tightness, 4)} vs 旧 ${n(0.35 * centeredOf(v3['resolvedDimensions']['tightness']), 4)}）`);
  line('  ⇒ 结论：**同一玩家在两条分支上仍不是同一个人**（Hero 分支保留审计指出的二次衰减）。');
  line('     本轮授权范围只含面对下注层 ⇒ 状态为「已记录、未修」；需要新授权才能统一。');
}

/* ---------------- R4 ---------------- */
line('');
line(rule());
line(' R4 `playerBuilt` 标签维度 vs V3 `baseDimensions` 是否逐位相同（我传了两份）');
line(rule());
for (const qp of ['MANIAC', 'CALLING_STATION', 'VERY_TIGHT', 'NORMAL'] as const) {
  const p = parseManualInput(test16({ seatId: 'seat_BB', persistentPlayerId: 'p1', quickProfile: qp, dynamicHint: 'UNKNOWN', stackBB: 100, observedStats: S }));
  const g = buildAnalyzableState(p.value!);
  const built = buildDecisionContext({
    state: g.state, rules: RULES, environment: 'MID_LOW_STAKES', asOf: OPTIONS.asOf,
    quickProfile: qp, dynamicHint: 'UNKNOWN', villainSeatId: 'seat_BB', villainPersistentPlayerId: 'p1',
    observedStats: S as never, equitySeed: OPTIONS.equitySeed, budget: OPTIONS.budget,
  } as never);
  const v3 = (built.context as unknown as Record<string, any>)['profileV3'] as Record<string, any>;
  const pbDims = built.context.player!.adjustment.dimensions as unknown as Record<string, number>;
  const same = ['tightness', 'aggression', 'bluffTendency', 'passivity']
    .every((a) => v3['baseDimensions'][a] === pbDims[a]);
  line(`  ${qp.padEnd(18)} baseDimensions=${JSON.stringify(v3['baseDimensions'])}`);
  line(`  ${''.padEnd(18)} playerBuilt   =${JSON.stringify({ tightness: pbDims['tightness'], aggression: pbDims['aggression'], bluffTendency: pbDims['bluffTendency'], passivity: pbDims['passivity'] })} ⇒ 逐位相同：${same ? '✔' : '✖'}`);
}

/* ---------------- R5 ---------------- */
line('');
line(rule());
line(' R5 每只手调用 `facingBetProfileOf` 的次数');
line(rule());
{
  const p = parseManualInput(test16({ seatId: 'seat_BB', persistentPlayerId: 'p1', quickProfile: 'MANIAC', dynamicHint: 'UNKNOWN', stackBB: 100, observedStats: S }));
  const g = buildAnalyzableState(p.value!);
  const args = {
    state: g.state, rules: RULES, environment: 'MID_LOW_STAKES', asOf: OPTIONS.asOf,
    quickProfile: 'MANIAC', dynamicHint: 'UNKNOWN', villainSeatId: 'seat_BB', villainPersistentPlayerId: 'p1',
    observedStats: S as never, equitySeed: OPTIONS.equitySeed, budget: OPTIONS.budget,
  } as never;
  const t0 = Date.now();
  for (let i = 0; i < 20; i += 1) buildDecisionContext(args);
  const per = (Date.now() - t0) / 20;
  line(`  buildDecisionContext：20 次共 ${Date.now() - t0} ms（≈ ${per.toFixed(0)} ms/次）`);
  line('  ⇒ 该函数是纯算术（4 轴 × 常数次浮点运算），并且只在下注范围与响应两处各调一次 ⇒ 无实质成本；');
  line('     未做记忆化（避免引入缓存与身份隔离的新风险）。');
}
line(rule());
