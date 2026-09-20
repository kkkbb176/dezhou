/**
 * ============================================================================
 * TEST 18 · 只读生产审计：**转牌面对加注**（BB 过牌后对我 20 的下注加注到 80）
 * ============================================================================
 *
 * 牌局（6 人桌，盲注 1/2，双方起始 200 筹码 = 100BB）：
 *   Hero BTN A♣J♣ ｜ 公共牌 J♦ 8♣ 4♣ 6♠（转牌）
 *   翻前：UTG/HJ/CO 弃 → BTN 加注至 6 → SB 弃 → BB 跟注 6 ⇒ 底池 13
 *   翻牌：BB 过牌 → BTN 下注 8 → BB 跟注 ⇒ 底池 29
 *   转牌：BB 过牌 → BTN 下注 20 → **BB 加注至 80**（Hero 面对加注）
 *   ⇒ 底池 129（含对手加注）｜Hero 需补 60 ｜Hero 剩 166 ｜对手剩 106
 *   ⇒ 跟注后底池 189，跟注所需权益 = 60/189 = 31.746%
 *
 * ⚠️ 本文件**只读**：只调用生产入口 `analyzeManualHand`，不修改任何代码、不写决策日志。
 * 统计口径：只给 VPIP/PFR/3Bet/WTSD 四项，**其余一律 null**（不编造河牌下注率、
 * 转牌过牌加注率等未观测数据）。
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
  persistentPlayerId: 'player_001',
  displayName: '阿豪',
  quickProfile: 'MANIAC',
  dynamicHint: 'UNKNOWN',
  stackBB: 100,
  observedStats: {
    handsObserved: 800,
    vpip: 0.48, pfr: 0.35, threeBet: 0.16, wtsd: 0.36,
    /* 以下全部 null：**没有观测**，不得编造 */
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
    A_('BB', 'CHECK', undefined, 'TURN'), A_('BTN', 'BET', 10, 'TURN'), A_('BB', 'RAISE', 40, 'TURN'),
  ],
  environment: 'MID_LOW_STAKES',
  villain,
} as unknown as ManualHandInput;

const n = (v: unknown, d = 4): string => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : String(v));
const pct = (v: unknown, d = 2): string => (typeof v === 'number' && Number.isFinite(v) ? `${(v * 100).toFixed(d)}%` : String(v));
const line = (s = ''): void => console.log(s);
const kv = (k: string, v: unknown, w = 44): void => line(`  ${k.padEnd(w)}${String(v)}`);
const rule = (w = 100): string => '─'.repeat(w);

/* ---- 先核对输入解析与算术 ---- */
const parsed = parseManualInput(input);
line(rule());
line(' 0 · 输入与算术核对');
line(rule());
kv('解析结果', parsed.ok ? 'OK' : `失败：${JSON.stringify((parsed as { issues?: unknown }).issues)}`);
if (!parsed.ok) process.exit(1);
const state = buildAnalyzableState(parsed.value);
kv('状态构建', state.ok ? 'OK' : `失败：${JSON.stringify((state as { issues?: unknown }).issues)}`);
if (!state.ok) process.exit(1);

const r = analyzeManualHand(input, OPTIONS);
if (!r.ok) { line(`❌ 分析失败：阶段 ${r.stage}`); line(JSON.stringify(r.issues, null, 2)); process.exit(1); }
const d = r.decision as unknown as Record<string, any>;
const dg = d['diagnostics'] as Record<string, any>;
const math = dg['math'] as Record<string, any>;
const pf = dg['postflop'] as Record<string, any>;
const rr = (pf['raiseResponse'] ?? null) as Record<string, any> | null;
const br = (pf['bettingRangeFacts'] ?? null) as Record<string, any> | null;
const legal = dg['legalActions'] as Record<string, any>;
const player = dg['player'] as Record<string, any>;
const vmRows = ((r.viewModel as unknown as Record<string, any>)['debug']?.['math'] ?? []) as readonly { label: string; value: string }[];

/*
 * 🔴 本块必须在**任何打印之前**执行：`diagnostics.legalActions` 只是投影快照（只带
 * `actions`），数值口径要取 `buildDecisionContext(...).legal` —— 那正是
 * `finalMathSanityCheck` 收到的对象（`contextBuilt.legal`）。
 */
const builtForDetails = buildDecisionContext({
  state: state.state, rules: OPTIONS.rules, environment: 'MID_LOW_STAKES', asOf: OPTIONS.asOf,
  quickProfile: 'MANIAC', dynamicHint: 'UNKNOWN',
  villainSeatId: 'seat_BB', villainPersistentPlayerId: 'player_001',
  observedStats: villain.observedStats,
  equitySeed: OPTIONS.equitySeed, budget: OPTIONS.budget,
} as never);
const legalFull = builtForDetails.legal as unknown as Record<string, any>;
const builtCtx = builtForDetails.context as unknown as Record<string, any>;
const v3 = (builtCtx['profileV3'] ?? null) as Record<string, any> | null;
const sizingFull = (builtCtx['postflopFacts']?.['betRangeSizing'] ?? null) as Record<string, any> | null;

kv('街 / 当前底池（含对方加注）', `${String(math['street'])} ｜ ${n(math['pot'], 2)} 筹码（题面 129）`);
kv('需补 / 所需权益', `${n(math['callCost'], 2)} 筹码（题面 60）｜ ${pct(math['requiredEquity'], 4)}（题面 31.75%）`);
kv('可争夺量 winnable', `${n(math['winnable'], 2)} 筹码`);
kv('Hero 剩余 / 有效筹码 / SPR', `${n(math['myRemainingStack'], 2)} ｜ ${n(math['effectiveStack'], 2)} ｜ ${n(math['spr'], 3)}`);
kv('我在本街已投入', n(math['myCommittedThisStreet'], 2));
kv('牌力', `${String(math['handRankZh'])} ｜ 成手 ${String(pf['madeHandZh'])} ｜ 角色 ${String(pf['handRoleZh'])}（${n(pf['roleStrength'], 3)}）`);

line('');
line(rule());
line(' 0b · 引擎自检告警的量纲核对（TEST 18 重点）');
line(rule());
kv('warnings', (r.warnings as readonly string[]).length === 0 ? '无' : JSON.stringify(r.warnings));
kv('决策 sizeChips（口径 = raise-to）', `${String(d['sizeChips'])} 筹码 = 全下 raise-to`);
kv('legals.allInToAmount（同一口径）', `${n(legalFull['allInToAmount'], 2)} 筹码`);
kv('legals.myRemainingStack（增量口径）', `${n(legalFull['myRemainingStack'], 2)} 筹码`);
kv('自检判据 sizeChips > myRemainingStack', `${String(d['sizeChips'])} > ${n(legalFull['myRemainingStack'], 2)} ⇒ ${String((d['sizeChips'] as number) > (legalFull['myRemainingStack'] as number))}`);
kv('正确判据 sizeChips > allInToAmount', `${String(d['sizeChips'])} > ${n(legalFull['allInToAmount'], 2)} ⇒ ${String((d['sizeChips'] as number) > (legalFull['allInToAmount'] as number))}`);
kv('告警是否改变动作', `actionable=${String(d['actionable'])} ｜ classification=${String(d['classification'])}（告警只进 warnings，**未**拦下动作）`);

line('');
line(rule());
line(' 1 · 合法动作与候选（面对加注）');
line(rule());
kv('合法动作集', JSON.stringify(legal?.['actions'] ?? legal));
kv('我在本街已投入（engine 口径）', n(math['myCommittedThisStreet'], 2));
kv('剩余筹码 myRemainingStack', n(legalFull['myRemainingStack'], 2));
kv('跟注成本 callCost', n(legalFull['callCost'], 2));
kv('最小加注到 minRaiseToAmount', n(legalFull['minRaiseToAmount'], 2));
kv('全下到 allInToAmount', n(legalFull['allInToAmount'], 2));
kv('  ⇒ 恒等式核对', `allInToAmount(${n(legalFull['allInToAmount'], 2)}) = 本街已投入(${n(math['myCommittedThisStreet'], 2)}) + 剩余(${n(legalFull['myRemainingStack'], 2)})`);
/*
 * 🔴 TEST 18 发现：`finalMathSanityCheck` 用 `sizeChips`（**raise-to** 口径 = 本街累计）
 * 与 `myRemainingStack`（**增量**口径）比大小 ⇒ 只要英雄本街已有投入就会误报。
 * 这里把两个口径都打出来，供报告引用。
 */
kv('尺寸口径对照', `决策 sizeChips=${String(d['sizeChips'])}（raise-to）｜我的增量 = sizeChips − 本街已投入 = ${n((d['sizeChips'] as number) - (math['myCommittedThisStreet'] as number), 2)}｜剩余 ${n(legalFull['myRemainingStack'], 2)}`);
for (const c of (dg['candidates'] as readonly Record<string, any>[]) ?? []) {
  const size = c['sizeChips'] === undefined ? '' : ` ${String(c['sizeChips'])}（${String(c['sizeBB'])}BB）`;
  kv(`候选 ${String(c['action'])}${size}`, `EV ${c['ev'] === null ? '未评估（见加注响应）' : n(c['ev'], 6)} ｜ ${String(c['noteZh'])}`, 30);
}
line('  --- 决策层可用性判定 ---');
for (const a of (dg['alternativeActions'] as readonly Record<string, any>[]) ?? []) {
  const size = a['sizeChips'] === undefined ? '' : ` ${String(a['sizeChips'])}`;
  kv(`  ${String(a['action'])}${size}`, `${String(a['estimateType'])} ｜ EV ${n(a['ev'], 6)} ｜ ${String(a['statusZh'])}`, 30);
}
line('  --- 未评估的合法动作（不得读成 EV=0）---');
for (const u of (dg['unevaluatedActions'] as readonly Record<string, any>[]) ?? []) {
  kv(`  ${String(u['action'])} ${String(u['sizeChips'])}`, `${String(u['reasonCode'])} ｜ ${String(u['reasonZh']).slice(0, 110)}`, 30);
}

line('');
line(rule());
line(' 2 · 统一零点口径的 EV');
line(rule());
kv('FOLD EV', '0（零点：不再投入筹码）');
kv('CALL EV', n(math['callEV'], 12));
kv('CALL EV 复算（权益 × winnable − 跟注额）', math['heroEquityVsBetRange'] === null
  ? `—（无下注范围权益，回落到 ${n(math['heroEquity'], 12)}）`
  : `${n(math['heroEquityVsBetRange'], 12)} × ${n(math['winnable'], 2)} − ${n(math['callCost'], 2)} = ${n((math['heroEquityVsBetRange'] as number) * (math['winnable'] as number) - (math['callCost'] as number), 12)}`);
kv('RAISE EV（被选中的再加注尺寸）', rr === null ? '本节点不可用' : `${n(rr['raiseEV'], 12)} ｜ 尺寸 ${String(rr['sizeChips'])} 筹码（${String(rr['sizeBB'])}BB）｜ ${String(rr['evKind'])}`);
kv('RAISE − CALL', rr === null ? '—' : n((rr['raiseEV'] as number) - (math['callEV'] as number), 6));
kv('最终动作', `**${String(d['action'])}${d['sizeChips'] === undefined ? '' : ` ${String(d['sizeChips'])} 筹码（${String(d['sizeBB'])}BB）`}**`);
kv('置信度 / 分档 / 分类 / 可执行', `${n(d['confidence'], 4)} ｜ ${String(d['band'])} ｜ ${String(d['classification'])} ｜ ${String(d['actionable'])}`);
for (const [i, reason] of ((d['reasons'] as readonly Record<string, any>[]) ?? []).entries()) {
  kv(`理由 ${i + 1}（${String(reason['code'])}）`, String(reason['textZh']), 26);
}

line('');
line(rule());
line(' 3 · 条件权益（模型输出，非实测）');
line(rule());
kv('heroEquity（整体/到达范围）', `${pct(math['heroEquity'], 4)} ｜ ${JSON.stringify(math['equitySource'])}`);
kv('EqVsBetRange（他**加注**范围）', pct(math['heroEquityVsBetRange'], 4));
kv('EqVsRaiseCallRange（他跟我的再加注）', rr === null ? '—' : pct(rr['heroEquityVsRaiseCallRange'], 4));
kv('EqVsReraiseRange（他再次加注）', rr === null ? '—' : pct(rr['heroEquityVsReraiseRange'], 4));
const ce = dg['conditionalEquities'] as Record<string, any> | undefined;
if (ce) for (const [k, v] of Object.entries(ce)) if (typeof v !== 'object') kv(`  conditionalEquities.${k}`, typeof v === 'number' ? n(v, 6) : v);

line('');
line(rule());
line(' 4 · 加注响应（他面对**我的再加注**）');
line(rule());
if (rr === null) {
  kv('raiseResponse', '本节点不可用');
} else {
  kv('再加注尺寸 / 增量', `${n(rr['sizeChips'], 2)} ｜ ${n(rr['raiseIncrement'], 2)}`);
  kv('资金口径', String(rr['cashflowContract']));
  kv('currentPot / heroAdd / villainAdd', `${n(rr['currentPot'], 2)} ｜ ${n(rr['heroAdd'], 2)} ｜ ${n(rr['villainAdd'], 2)}（raw ${n(rr['villainAddRaw'], 2)}）`);
  kv('heroContestedAdd / finalPot / 退回', `${n(rr['heroContestedAdd'], 2)} ｜ ${n(rr['finalPot'], 2)} ｜ ${n(rr['uncalledReturn'], 2)}`);
  kv('他跟注即全下 / Hero 全下', `${String(rr['villainIsAllInByCall'])} ｜ ${String(rr['model']?.['heroIsAllIn'])}`);
  kv('价格 / 门槛', `${n(rr['model']?.['priceRequiredEquity'], 6)} ｜ ${n((rr['model']?.['priceRequiredEquity'] ?? 0) + (rr['model']?.['margin'] ?? 0), 6)}（margin ${n(rr['model']?.['margin'], 3)}）`);
  kv('P(弃) / P(跟) / P(再加注)', `${pct(rr['foldLikelihood'], 4)} ｜ ${pct(rr['callLikelihood'], 4)} ｜ ${pct(rr['reRaiseLikelihood'], 4)}`);
  kv('组合数（可达/跟注桶/再加注桶）', `${String(rr['reachableCombos'])} ｜ ${String(rr['callCombos'])} ｜ ${String(rr['reRaiseCombos'])}`);
  kv('Hero 4-bet 支持', String(rr['heroFourBetSupported']));
  kv('响应模型注记', String(rr['model']?.['noteZh'] ?? '').slice(0, 200));
  line('  --- 假设（assumptionsZh）---');
  for (const [i, a] of ((rr['assumptionsZh'] as readonly string[]) ?? []).entries()) kv(`  [${i + 1}]`, a, 6);
}

line('');
line(rule());
line(' 5 · P1-2b：我加注后他再加注 ⇒ Hero 的 FOLD / CALL 两选一');
line(rule());
if (rr === null) {
  kv('P1-2b', '本节点不可用');
} else {
  kv('分支类型 / 分支 EV', `${String(rr['reraiseBranchKind'])} ｜ ${n(rr['reraiseBranchEV'], 12)}`);
  kv('  ├ 弃牌分支 EV', n(rr['reraiseFoldBranchEV'], 12));
  kv('  └ 跟注分支 EV', n(rr['reraiseCallBranchEV'], 12));
  kv('他再加注到 / 最小合法 / 全下', `${n(rr['reRaiseTo'], 2)} ｜ ${n(rr['reRaiseMinLegalTo'], 2)} ｜ ${String(rr['villainReRaiseIsAllIn'])}`);
  kv('Hero 需再补 / 终池', `${n(rr['heroAdditionalCallVsReRaise'], 2)} ｜ ${n(rr['finalPotAfterCallVsReRaise'], 2)}`);
  kv('EqVsReraiseRange', pct(rr['heroEquityVsReraiseRange'], 4));
  kv('不支持原因', String(rr['reraiseBranchUnsupportedZh'] ?? '（无）'));
}

line('');
line(rule());
line(' 6 · 他这份「加注范围」的构成（band 模型）');
line(rule());
if (br === null) {
  kv('bettingRangeFacts', '本节点不可用');
} else {
  kv('到达质量 / 下注(加注)质量 / 占比', `${n(br['arrivalMass'], 6)} ｜ ${n(br['betMass'], 6)} ｜ ${pct(br['betShareOfArrival'], 2)}`);
  kv('尺寸比 / 牌面纹理', `${n(br['model']?.['ratioToPot'], 4)}（模型口径）｜ ${String(br['model']?.['boardTexture'])}`);
  kv('尺寸近似报告（§七）', sizingFull === null ? '（快照缺失）'
    : `actualBetChips ${n(sizingFull['actualBetChips'], 2)} ｜ potChips ${n(sizingFull['potChips'], 2)} ｜ ` +
      `actualRatio ${n(sizingFull['actualRatio'], 4)} ｜ modeledRatio ${n(sizingFull['modeledRatio'], 4)} ｜ ` +
      `**sizeApproximation ${String(sizingFull['sizeApproximation'])}**`);
  kv('等效组合数 / 90% 质量组合数', `${n(br['effectiveComboCount'], 1)} ｜ ${n(br['posteriorMassCombos90'], 1)}`);
  const rates = br['bandRates'] as Record<string, number>;
  const arr = br['bandMasses']['arrival'] as Record<string, number>;
  const bet = br['bandMasses']['bet'] as Record<string, number>;
  line('  公共强度带      到达质量    加权质量   P(加注|带)');
  for (const band of Object.keys(rates)) {
    line(`  ${band.padEnd(14)}${n(arr[band], 5).padStart(9)}${n(bet[band], 10).padStart(12)}${n(rates[band], 9).padStart(12)}`);
  }
}

line('');
line(rule());
line(' 7 · 画像（VPIP/PFR/3Bet/WTSD = 800 手；其余统计 null ⇒ 不得有分街因子）');
line(rule());
/* v3 / legalFull / sizingFull 已在上方提前计算 */
if (v3 === null) kv('profileV3', '（缺失）');
else {
  kv('baseArchetype / 统计项数 / 置信档', `${String(v3['baseArchetype'])} ｜ ${String(v3['observedStatCount'])} ｜ ${String(v3['confidenceTierZh'])}`);
  for (const axis of ['tightness', 'aggression', 'bluffTendency', 'passivity']) {
    kv(`  ${axis}`, `base ${n(v3['baseDimensions'][axis], 3)} ⊕ obs ${n(v3['observedDimensions'][axis], 3)} ⇒ w=${n(v3['blendWeight'][axis], 4)} ⇒ resolved ${n(v3['resolvedDimensions'][axis], 4)}`, 22);
  }
  kv('分街因子（TURN）', JSON.stringify(v3['street']['TURN']));
}
kv('对手快照', JSON.stringify({ id: player?.['id'], position: player?.['position'], archetype: player?.['archetype'] }).slice(0, 200));

line('');
line(rule());
line(' 8 · 警告 / 降级 / 一致性 / 版本');
line(rule());
kv('warnings', (r.warnings as readonly string[]).length === 0 ? '无' : JSON.stringify(r.warnings));
kv('degradations', JSON.stringify(dg['degradations'] ?? []).slice(0, 300));
kv('consistency', JSON.stringify(dg['consistency'] ?? null).slice(0, 200));
kv('版本', JSON.stringify(dg['versions'] ?? {}));
kv('allInGuard', JSON.stringify(dg['allInGuard'] ?? null).slice(0, 420));
kv('actionShape', JSON.stringify(dg['actionShape'] ?? null).slice(0, 220));
line('  --- 界面行（用户实际看到的口径）---');
for (const row of vmRows) {
  if (/权益|跟注 EV|所需/.test(row.label)) kv(`  「${row.label}」`, row.value.slice(0, 170), 26);
}
line(rule());

console.log('JSON_SNAPSHOT ' + JSON.stringify({
  action: d['action'], sizeChips: d['sizeChips'], sizeBB: d['sizeBB'],
  confidence: d['confidence'], band: d['band'], classification: d['classification'],
  pot: math['pot'], callCost: math['callCost'], requiredEquity: math['requiredEquity'], winnable: math['winnable'],
  heroEquity: math['heroEquity'], heroEquityVsBetRange: math['heroEquityVsBetRange'],
  callEV: math['callEV'], raiseEV: rr?.['raiseEV'] ?? null, raiseSize: rr?.['sizeChips'] ?? null,
  eqVsRaiseCall: rr?.['heroEquityVsRaiseCallRange'] ?? null, eqVsReraise: rr?.['heroEquityVsReraiseRange'] ?? null,
  pFold: rr?.['foldLikelihood'] ?? null, pCall: rr?.['callLikelihood'] ?? null, pReRaise: rr?.['reRaiseLikelihood'] ?? null,
  reraiseBranchEV: rr?.['reraiseBranchEV'] ?? null, reraiseBranchKind: rr?.['reraiseBranchKind'] ?? null,
  reraiseFoldEV: rr?.['reraiseFoldBranchEV'] ?? null, reraiseCallEV: rr?.['reraiseCallBranchEV'] ?? null,
  betMass: br?.['betMass'] ?? null, betShare: br?.['betShareOfArrival'] ?? null,
  legalActions: legal?.['actions'] ?? null, minRaiseTo: legal?.['minRaiseTo'] ?? null, allInToAmount: legalFull['allInToAmount'] ?? null,
  resolvedDims: v3?.['resolvedDimensions'] ?? null, streetTurn: v3?.['street']?.['TURN'] ?? null,
  warnings: r.warnings,
}, null, 1));
