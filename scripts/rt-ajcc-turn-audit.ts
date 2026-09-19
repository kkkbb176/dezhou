/**
 * ============================================================================
 * 只读牌局审计：转牌 A♣J♣（顶对 + 坚果同花听）面对 BB 领打 20 筹码
 * ============================================================================
 *
 * **本文件只读**：只调用生产入口 `analyzeManualHand`，不改任何代码、不写决策日志。
 *
 * 牌局（6 人现金桌，盲注 1/2，有效 100BB = 200 筹码）：
 *   BTN A♣J♣ ｜ 公共牌 J♦ 8♣ 4♣ 6♠（转牌）
 *   翻前：UTG/HJ/CO 弃 → BTN 加注 6（3BB）→ SB 弃 → BB 跟注 6 ⇒ 底池 13
 *   翻牌：BB 过牌 → BTN 下注 8（4BB）→ BB 跟注 8 ⇒ 底池 29
 *   转牌：BB 主动下注 20（10BB，约 69% 底池）⇒ 底池 49，Hero 需跟 20，Hero 剩 186，对手剩 166
 *
 * 对手：阿豪（持久 ID `player_ahaohao` 绑定 BB 座位），MANIAC 标签，800 手实测
 *      VPIP 48% / PFR 35% / 3Bet 16% / WTSD 36%，**其余实测统计一律 null**。
 */
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';
import { parseManualInput, type ManualHandInput, type ManualVillain } from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';

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

const villain: ManualVillain = {
  seatId: 'seat_BB',
  persistentPlayerId: 'player_ahaohao',
  displayName: '阿豪',
  quickProfile: 'MANIAC',
  dynamicHint: 'UNKNOWN',
  stackBB: 100,
  observedStats: {
    handsObserved: 800,
    vpip: 0.48, pfr: 0.35, threeBet: 0.16, wtsd: 0.36,
    foldToFlopCBet: null, foldToTurnCBet: null, foldToRiverBet: null,
    flopCheckRaise: null, turnCheckRaise: null, riverCheckRaise: null,
  },
};

const input = {
  tableSize: 6, heroPosition: 'BTN', heroCards: ['Ac', 'Jc'],
  board: ['Jd', '8c', '4c', '6s'], street: 'TURN',
  effectiveStackBB: 100, bigBlindBB: 2,
  seatStacksBB: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 },
  actionHistory: [
    A_('UTG', 'FOLD'), A_('HJ', 'FOLD'), A_('CO', 'FOLD'),
    A_('BTN', 'RAISE', 3), A_('SB', 'FOLD'), A_('BB', 'CALL', 2),
    A_('BB', 'CHECK', undefined, 'FLOP'), A_('BTN', 'BET', 4, 'FLOP'), A_('BB', 'CALL', 4, 'FLOP'),
    A_('BB', 'BET', 10, 'TURN'),
  ],
  environment: 'MID_LOW_STAKES',
  villain,
} as unknown as ManualHandInput;

const n = (v: unknown, d = 4): string => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : String(v));
const pct = (v: unknown, d = 2): string => (typeof v === 'number' && Number.isFinite(v) ? `${(v * 100).toFixed(d)}%` : String(v));
const rule = (w = 100): string => '─'.repeat(w);
const line = (s = ''): void => console.log(s);
const kv = (k: string, v: unknown, w = 46): void => line(`  ${k.padEnd(w)}${String(v)}`);

const r = analyzeManualHand(input, OPTIONS);
if (!r.ok) {
  line(`❌ 分析失败：阶段 ${r.stage}`);
  line(JSON.stringify(r.issues, null, 2));
  process.exit(1);
}
const d = r.decision as unknown as Record<string, any>;
const dg = d['diagnostics'] as Record<string, any>;
const math = dg['math'] as Record<string, any>;
const pf = dg['postflop'] as Record<string, any>;
const rr = (pf['raiseResponse'] ?? null) as Record<string, any> | null;
const br = (pf['bettingRangeFacts'] ?? null) as Record<string, any> | null;
const v3 = ((): Record<string, any> | null => {
  /*
   * `profileV3` 是 **DecisionContext** 的字段（决策诊断快照并未搬运它）。
   * 因此这里走**第二个生产入口**（`parseManualInput → buildAnalyzableState → buildDecisionContext`，
   * 与 `analyzeManualHand` 内部同一条链）单独取一次画像快照 —— 仍然只读。
   */
  const p = parseManualInput(input);
  if (!p.ok) return null;
  const gate = buildAnalyzableState(p.value);
  if (!gate.ok) return null;
  const built = buildDecisionContext({
    state: gate.state, rules: OPTIONS.rules, environment: 'MID_LOW_STAKES', asOf: OPTIONS.asOf,
    quickProfile: 'MANIAC', dynamicHint: 'UNKNOWN',
    villainSeatId: 'seat_BB', villainPersistentPlayerId: 'player_ahaohao',
    observedStats: villain.observedStats,
    equitySeed: OPTIONS.equitySeed, budget: OPTIONS.budget,
  } as never);
  return ((built.context as unknown as Record<string, any>)['profileV3'] ?? null) as Record<string, any> | null;
})();
const player = dg['player'] as Record<string, any>;

line(rule());
line(' 0 · 输入核对（底池与筹码算术）');
line(rule());
kv('Hero / 位置 / 街', `A♣J♣ ｜ BTN ｜ ${String(math['street'])}`);
kv('当前底池（含对手下注）', `${n(math['pot'], 2)} 筹码`);
kv('需要跟注', `${n(math['callCost'], 2)} 筹码`);
kv('Hero 剩余 / 有效筹码 / SPR', `${n(math['myRemainingStack'], 2)} ｜ ${n(math['effectiveStack'], 2)} ｜ ${n(math['spr'], 3)}`);
kv('底池赔率 / 所需权益', `${pct(math['potOdds'])} ｜ ${pct(math['requiredEquity'])}（requiredEquityApplies=${String(math['requiredEquityApplies'])}）`);
kv('可争夺筹码（winnable）', n(math['winnable'], 2));
kv('牌力（引擎判定）', `${String(math['handRankZh'])} ｜ ${String(math['handCategory'])}`);
kv('成手 / 牌面角色', `${String(pf['madeHandZh'])} ｜ ${String(pf['handRoleZh'])}（强度 ${n(pf['roleStrength'], 3)}）`);
kv('角色变化原因', String(pf['roleChangeReasonZh'] ?? '—'));
kv('摊牌价值 / 保护价值 / 诈唬潜力', `${n(pf['showdownValue'], 4)} ｜ ${n(pf['protectionValue'], 4)} ｜ ${n(pf['bluffPotential'], 4)}`);
kv('EV 排序 / 真 EV 排序', `${JSON.stringify(pf['evRanking'])} ｜ ${JSON.stringify(pf['trueEvRanking'])}`);

line('');
line(rule());
line(' 1 · 画像：标签 ⊕ 实测（PLAYER PROFILE V3）');
line(rule());
if (v3 === null) {
  kv('profileV3', '（快照缺失）');
} else {
  kv('observedStatCount / 置信档', `${String(v3['observedStatCount'])} ｜ ${String(v3['confidenceTierZh'])}`);
  for (const axis of ['tightness', 'aggression', 'bluffTendency', 'passivity']) {
    kv(`  ${axis}`,
      `base ${n(v3['baseDimensions'][axis], 3)} ⊕ obs ${n(v3['observedDimensions'][axis], 3)}` +
      ` ⇒ w=${n(v3['blendWeight'][axis], 4)} ⇒ **resolved ${n(v3['resolvedDimensions'][axis], 4)}**`);
  }
  kv('分街因子（TURN）', JSON.stringify(v3['street']['TURN']));
}
kv('身份路由', `画像座位 ${String(v3?.['baseArchetype'] ?? '?')} ｜ 警告 ${String((r.warnings as readonly string[]).length)} 条`);
kv('对手快照（decision.player）', JSON.stringify({
  id: player?.['id'], position: player?.['position'], archetype: player?.['archetype'] ?? player?.['quickProfile'],
}).slice(0, 240));
kv('响应模型注记', String(rr?.['model']?.['noteZh'] ?? '（无）').slice(0, 240));
kv('下注范围模型注记', String(br?.['model']?.['noteZh'] ?? '（无）').slice(0, 240));

line('');
line(rule());
line(' 2 · 最终动作');
line(rule());
kv('建议动作', `**${String(d['action'])}${d['sizeChips'] === undefined ? '' : ` ${String(d['sizeChips'])} 筹码（${String(d['sizeBB'])}BB）`}**`);
kv('置信度 / 分档 / 分类', `${n(d['confidence'], 4)} ｜ ${String(d['band'])} ｜ ${String(d['classification'])}`);
kv('可执行（actionable）', String(d['actionable']));
for (const [i, reason] of ((d['reasons'] as readonly unknown[]) ?? []).entries()) {
  kv(`理由 ${i + 1}`, typeof reason === 'string' ? reason : JSON.stringify(reason));
}
kv('决策来源', JSON.stringify(dg['decisionSource'] ?? '—'));

line('');
line(rule());
line(' 3 · 各候选 EV');
line(rule());
for (const c of (dg['candidates'] as readonly Record<string, any>[]) ?? []) {
  const size = c['sizeChips'] === undefined ? '' : ` ${String(c['sizeChips'])}（${String(c['sizeBB'])}BB）`;
  kv(`${String(c['action'])}${size}`, `EV ${c['ev'] === null ? '未评估（见加注 EV 一节）' : n(c['ev'], 6)} ｜ ${String(c['noteZh'])}`);
}
line('  --- 决策层对候选的可用性判定（alternativeActions）---');
for (const a of (dg['alternativeActions'] as readonly Record<string, any>[]) ?? []) {
  const size = a['sizeChips'] === undefined ? '' : ` ${String(a['sizeChips'])}`;
  kv(`  ${String(a['action'])}${size}`, `${String(a['estimateType'])} ｜ EV ${n(a['ev'], 6)} ｜ ${String(a['statusZh'])}`);
}
line('  --- 统一比较口径（math / U1）---');
kv('  FOLD EV', '0（零点：不再投入筹码）');
kv('  CALL EV', n(math['callEV'], 9));
kv('  RAISE EV（U1，选中尺寸）', rr === null ? '本节点不可用' : `${n(rr['raiseEV'], 9)} ｜ evKind=${String(rr['evKind'])} ｜ 尺寸 ${String(rr['sizeChips'])} 筹码`);
kv('  RAISE − CALL', rr === null ? '—' : n((rr['raiseEV'] as number) - (math['callEV'] as number), 6));

line('');
line(rule());
line(' 4 · 条件权益（全部为【模型输出】，非实测）');
line(rule());
kv('heroEquity（对到达范围）', `${pct(math['heroEquity'], 4)} ｜ 来源 ${JSON.stringify(math['equitySource'])}`);
kv('EqVsBetRange（对他**下注**范围）', pct(math['heroEquityVsBetRange'], 4));
kv('EqVsRaiseCallRange（加注后他跟注范围）', rr === null ? '—' : pct(rr['heroEquityVsRaiseCallRange'], 4));
kv('EqVsReraiseRange（被他再加注的范围）', rr === null ? '—' : pct(rr['heroEquityVsReraiseRange'], 4));
kv('权益方法 / 迭代（加注响应）', rr === null ? '—' : `${String(rr['equityMethod'])} ｜ ${String(rr['equityIterations'])}`);
const ce = dg['conditionalEquities'] as Record<string, any> | undefined;
if (ce !== undefined && ce !== null) {
  for (const [k, v] of Object.entries(ce)) {
    if (typeof v === 'number' || typeof v === 'string' || v === null) kv(`  conditionalEquities.${k}`, v);
  }
}

line('');
line(rule());
line(' 5 · 加注响应（他面对我的加注：弃 / 跟 / 再加注）');
line(rule());
if (rr === null) {
  kv('raiseResponse', '本节点没有可用的加注响应');
} else {
  kv('加注尺寸', `${String(rr['sizeChips'])} 筹码（${String(rr['sizeBB'])}BB）｜ 增量 ${n(rr['raiseIncrement'], 2)}`);
  kv('资金口径', `${String(rr['cashflowContract'])}`);
  kv('currentPot / heroAdd / villainAdd', `${n(rr['currentPot'], 2)} ｜ ${n(rr['heroAdd'], 2)} ｜ ${n(rr['villainAdd'], 2)}（raw ${n(rr['villainAddRaw'], 2)}）`);
  kv('heroContestedAdd / finalPot / 退回', `${n(rr['heroContestedAdd'], 2)} ｜ ${n(rr['finalPot'], 2)} ｜ ${n(rr['uncalledReturn'], 2)}`);
  kv('他跟注即全下 / Hero 全下', `${String(rr['villainIsAllInByCall'])} ｜ ${String(rr['model']['heroIsAllIn'])}`);
  kv('价格 / 门槛 / 尺寸比', `price ${n(rr['model']['priceRequiredEquity'], 6)} ｜ 门槛 ${n((rr['model']['priceRequiredEquity'] as number) + (rr['model']['margin'] as number), 6)}（margin ${n(rr['model']['margin'], 3)}）｜ heroAdd/pot ${n(rr['model']['ratioToPot'], 4)}`);
  kv('P(弃) / P(跟) / P(再加注)', `${pct(rr['foldLikelihood'], 4)} ｜ ${pct(rr['callLikelihood'], 4)} ｜ ${pct(rr['reRaiseLikelihood'], 4)}`);
  kv('组合数（可达 / 跟注桶 / 再加注桶）', `${String(rr['reachableCombos'])} ｜ ${String(rr['callCombos'])} ｜ ${String(rr['reRaiseCombos'])}`);
  kv('Hero 4-bet 是否被支持', String(rr['heroFourBetSupported']));
  kv('公共强度带权重表', JSON.stringify(rr['model']['strengthOfBand']));
  kv('假设（assumptions）', String(rr['assumptionsZh'] ?? '—').slice(0, 260));
}

line('');
line(rule());
line(' 6 · P1-2b：被他再加注之后的 Hero 决策（FOLD / CALL 两选一）');
line(rule());
if (rr === null) {
  kv('P1-2b', '本节点不可用');
} else {
  kv('分支类型 reraiseBranchKind', String(rr['reraiseBranchKind']));
  kv('分支 EV reraiseBranchEV', n(rr['reraiseBranchEV'], 9));
  kv('  ├ 弃牌分支 EV', n(rr['reraiseFoldBranchEV'], 9));
  kv('  └ 跟注分支 EV', n(rr['reraiseCallBranchEV'], 9));
  kv('他再加注到 / 最小合法', `${n(rr['reRaiseTo'], 2)} ｜ ${n(rr['reRaiseMinLegalTo'], 2)}`);
  kv('他再加注是否全下', String(rr['villainReRaiseIsAllIn']));
  kv('Hero 需再补 / 终池', `${n(rr['heroAdditionalCallVsReRaise'], 2)} ｜ ${n(rr['finalPotAfterCallVsReRaise'], 2)}`);
  kv('EqVsReraiseRange', pct(rr['heroEquityVsReraiseRange'], 4));
  const fold = rr['reraiseFoldBranchEV'] as number | null;
  const call = rr['reraiseCallBranchEV'] as number | null;
  kv('⇒ 两分支比较', fold === null || call === null ? '—' : (call > fold ? '跟注优于弃牌' : '弃牌优于跟注') + `（差 ${n(Math.abs(call - fold), 6)}）`);
  kv('不支持时的原因', String(rr['reraiseBranchUnsupportedZh'] ?? '（无）'));
}

line('');
line(rule());
line(' 7 · 他的下注范围（我面对的这份范围）');
line(rule());
if (br === null) {
  kv('bettingRangeFacts', '本节点不可用');
} else {
  kv('到达质量 / 下注质量 / 占比', `${n(br['arrivalMass'], 6)} ｜ ${n(br['betMass'], 6)} ｜ ${pct(br['betShareOfArrival'], 2)}`);
  kv('等效组合数 / 承载 90% 质量所需', `${n(br['effectiveComboCount'], 1)} ｜ ${n(br['posteriorMassCombos90'], 1)}（支持集 ${String(br['entryCount'])}）`);
  kv('尺寸口径', `实际 ${n(br['model']['ratioToPot'], 4)}（模型比值 ${n(br['model']['ratioToPot'], 4)}）｜ 牌面 ${String(br['model']['boardTexture'])}`);
  const rates = br['bandRates'] as Record<string, number>;
  const arr = br['bandMasses']['arrival'] as Record<string, number>;
  const bet = br['bandMasses']['bet'] as Record<string, number>;
  line('  公共强度带  到达质量   下注质量   P(下注|带)');
  for (const band of Object.keys(rates)) {
    line(`  ${band.padEnd(14)}${n(arr[band], 5).padStart(8)}${n(bet[band], 11).padStart(11)}${n(rates[band], 9).padStart(13)}`);
  }
}

line('');
line(rule());
line(' 8 · 警告、降级与一致性');
line(rule());
kv('warnings', (r.warnings as readonly string[]).length === 0 ? '无' : JSON.stringify(r.warnings));
kv('degradations', JSON.stringify(dg['degradations'] ?? []).slice(0, 400));
kv('consistency', JSON.stringify(dg['consistency'] ?? null).slice(0, 400));
kv('unevaluatedActions', JSON.stringify(dg['unevaluatedActions'] ?? []).slice(0, 400));
kv('allInGuard', JSON.stringify(dg['allInGuard'] ?? null).slice(0, 300));
kv('uncertaintyBandChips / override', `${n(pf['uncertaintyBandChips'], 3)} ｜ ${String(pf['allowUncertaintyOverride'])}`);
kv('版本', JSON.stringify(dg['versions'] ?? {}));
line(rule());

/* 机器可读快照（供证据存档） */
console.log('JSON_SNAPSHOT ' + JSON.stringify({
  action: d['action'], sizeChips: d['sizeChips'], sizeBB: d['sizeBB'],
  confidence: d['confidence'], band: d['band'], classification: d['classification'],
  pot: math['pot'], callCost: math['callCost'], requiredEquity: math['requiredEquity'],
  heroEquity: math['heroEquity'], heroEquityVsBetRange: math['heroEquityVsBetRange'],
  callEV: math['callEV'], raiseEV: rr?.['raiseEV'] ?? null,
  raiseSize: rr?.['sizeChips'] ?? null,
  eqVsRaiseCall: rr?.['heroEquityVsRaiseCallRange'] ?? null,
  eqVsReraise: rr?.['heroEquityVsReraiseRange'] ?? null,
  pFold: rr?.['foldLikelihood'] ?? null, pCall: rr?.['callLikelihood'] ?? null, pReRaise: rr?.['reRaiseLikelihood'] ?? null,
  reraiseBranchEV: rr?.['reraiseBranchEV'] ?? null, reraiseBranchKind: rr?.['reraiseBranchKind'] ?? null,
  reraiseFoldEV: rr?.['reraiseFoldBranchEV'] ?? null, reraiseCallEV: rr?.['reraiseCallBranchEV'] ?? null,
  betMass: br?.['betMass'] ?? null, betShare: br?.['betShareOfArrival'] ?? null,
  resolvedDims: v3?.['resolvedDimensions'] ?? null, blendWeight: v3?.['blendWeight'] ?? null,
  warnings: r.warnings,
}, null, 1));
