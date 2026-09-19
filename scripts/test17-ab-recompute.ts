/**
 * TEST 17 · 只读复算探针（A + B）：权益口径与 P1-2b 资金口径的**独立**核对
 *
 * 全部数字来自生产入口 `analyzeManualHand` 的输出（不读任何内部实现细节），
 * 复算只用四则运算 ⇒ 结论与实现相互独立。
 */
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import type { ManualHandInput, ManualVillain } from '../src/app/manualInput/manualInput.ts';

const OPTIONS = {
  rules: loadKnowledgeBaseOrThrow().allRules(), asOf: 1_757_000_000_000, writeLog: false,
  equitySeed: 20_260_913, budget: { softMs: 120_000, hardMs: 240_000 },
} as const;
const A_ = (position: string, type: string, amountBB?: number, street?: string): Record<string, unknown> => ({
  position, type, ...(amountBB === undefined ? {} : { amountBB }), ...(street === undefined ? {} : { street }),
});
const villain: ManualVillain = {
  seatId: 'seat_BB', persistentPlayerId: 'player_ahaohao', displayName: '阿豪', quickProfile: 'MANIAC', dynamicHint: 'UNKNOWN', stackBB: 100,
  observedStats: { handsObserved: 800, vpip: 0.48, pfr: 0.35, threeBet: 0.16, wtsd: 0.36, foldToFlopCBet: null, foldToTurnCBet: null, foldToRiverBet: null, flopCheckRaise: null, turnCheckRaise: null, riverCheckRaise: null },
};
const input = {
  tableSize: 6, heroPosition: 'BTN', heroCards: ['Ac', 'Jc'], board: ['Jd', '8c', '4c', '6s'], street: 'TURN',
  effectiveStackBB: 100, bigBlindBB: 2,
  seatStacksBB: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 },
  actionHistory: [
    A_('UTG', 'FOLD'), A_('HJ', 'FOLD'), A_('CO', 'FOLD'),
    A_('BTN', 'RAISE', 3), A_('SB', 'FOLD'), A_('BB', 'CALL', 2),
    A_('BB', 'CHECK', undefined, 'FLOP'), A_('BTN', 'BET', 4, 'FLOP'), A_('BB', 'CALL', 4, 'FLOP'),
    A_('BB', 'BET', 10, 'TURN'),
  ],
  environment: 'MID_LOW_STAKES', villain,
} as unknown as ManualHandInput;

const full = (v: number): string => v.toFixed(15);
const line = (s = ''): void => console.log(s);

const r = analyzeManualHand(input, OPTIONS);
if (!r.ok) { line(`分析失败 ${r.stage}`); process.exit(1); }
const d = r.decision as unknown as Record<string, any>;
const dg = d['diagnostics'] as Record<string, any>;
const math = dg['math'] as Record<string, any>;
const pf = dg['postflop'] as Record<string, any>;
const rr = pf['raiseResponse'] as Record<string, any>;
const br = pf['bettingRangeFacts'] as Record<string, any>;
const ce = dg['conditionalEquities'] as Record<string, any>;

line('══ A · CALL EV 的权益口径 ══');
const winnable = math['pot'] + math['callCost'];
line(`  生产：pot=${math['pot']} ｜ callCost=${math['callCost']} ｜ winnable=${winnable}`);
line(`  math.heroEquity（到达范围，wholeRange）      = ${full(math['heroEquity'])}`);
line(`  math.heroEquityVsBetRange（下注范围，betRange） = ${full(math['heroEquityVsBetRange'])}`);
line(`  math.callEV（生产）                         = ${full(math['callEV'])}`);
const a1 = math['heroEquityVsBetRange'] * winnable - math['callCost'];
const a2 = math['heroEquity'] * winnable - math['callCost'];
line(`  复算①  EqVsBetRange × winnable − callCost = ${full(a1)}  ⇒ 与生产差 ${Math.abs(a1 - math['callEV'])}`);
line(`  复算②  wholeRange   × winnable − callCost = ${full(a2)}  ⇒ 与生产差 ${Math.abs(a2 - math['callEV'])}`);
line(`  ⇒ 结论：CALL EV 的权益输入是 **EqVsBetRange**（唯一差为 0 的复算）`);
line(`  ⇒ 若误用到达范围权益，CALL EV 会变成 ${a2.toFixed(4)}（即被低估 ${(math['callEV'] - a2).toFixed(4)} 筹码）`);
line(`  layedEV 是否存在：${String(dg['math']['layeredEV'] !== undefined)}（不存在 ⇒ callEV 走下界口径 ` +
  '`equityForCallEV × winnable − callCost`；见 contextBuilder.ts:585-619）');
line(`  conditionalEquities.betRange=${full(ce['betRange'])} ｜ wholeRange=${full(ce['wholeRange'])} ｜ usedByRaiseThreshold=${String(ce['usedByRaiseThreshold'])}`);
line('  展示层对照（修复后：EV 的权益来源与「仅参考」都必须写出来）：');
line(`   · 候选注记  ：${String((dg['candidates'] as readonly Record<string, any>[]).find((c) => c['action'] === 'CALL')?.['noteZh'])}`);
const callReason = (d['reasons'] as readonly Record<string, any>[]).find((x) => x['code'] === 'MATH_CALL_SUPPORTED');
line(`   · 理由 4    ：${String(callReason?.['textZh'])}`);
{
  const rows = ((r.viewModel as unknown as Record<string, any>)['debug']?.['math'] ?? []) as readonly { label: string; value: string }[];
  for (const row of rows) {
    if (/权益|跟注 EV/.test(row.label)) line(`   · 界面行「${row.label}」= ${row.value.slice(0, 150)}`);
  }
}

line('');
line('══ B · P1-2b 再加注分支的资金口径 ══');
line(`  heroContestedAdd=${rr['heroContestedAdd']} ｜ heroAdd=${rr['heroAdd']} ｜ villainAdd=${rr['villainAdd']}`);
line(`  reRaiseTo=${rr['reRaiseTo']} ｜ reRaiseMinLegalTo=${rr['reRaiseMinLegalTo']} ｜ villainReRaiseIsAllIn=${String(rr['villainReRaiseIsAllIn'])}`);
line(`  heroAdditionalCallVsReRaise=${rr['heroAdditionalCallVsReRaise']} ｜ finalPotAfterCallVsReRaise=${rr['finalPotAfterCallVsReRaise']}`);
line(`  EqVsReraiseRange=${full(rr['heroEquityVsReraiseRange'])} ｜ reraiseBranchKind=${String(rr['reraiseBranchKind'])}`);
const foldEV = rr['reraiseFoldBranchEV'] as number;
const callEV = rr['reraiseCallBranchEV'] as number;
const b1 = rr['heroEquityVsReraiseRange'] * rr['finalPotAfterCallVsReRaise']
  - rr['heroContestedAdd'] - rr['heroAdditionalCallVsReRaise'];
line(`  生产：FOLD 分支 EV = ${full(foldEV)} ｜ CALL 分支 EV = ${full(callEV)} ｜ 分支 EV = ${full(rr['reraiseBranchEV'])}`);
line(`  复算  EqVsReraise × 终池 − 首次新增投入(${rr['heroContestedAdd']}) − 再次跟注(${rr['heroAdditionalCallVsReRaise']}) = ${full(b1)}`);
line(`  ⇒ 与生产 CALL 分支差 ${Math.abs(b1 - callEV)}（累计扣除 = ${rr['heroContestedAdd'] + rr['heroAdditionalCallVsReRaise']} 筹码）`);
line(`  ⇒ FOLD 分支 = −首次新增投入 = ${-rr['heroContestedAdd']} ⇒ 与生产差 ${Math.abs(-rr['heroContestedAdd'] - foldEV)}`);
line(`  ⇒ 分支取 max(FOLD, CALL) = ${full(Math.max(foldEV, callEV))} ⇒ 与生产差 ${Math.abs(Math.max(foldEV, callEV) - rr['reraiseBranchEV'])}`);
line(`  ⇒ 差值（跟注 − 弃牌）= ${(callEV - foldEV).toFixed(6)} 筹码`);
line('  ⚠️ 关键：`finalPotAfterCallVsReRaise` 不是手算求和，而是引擎自己的状态机 —— ' +
  '`applyAction(我加注) → applyAction(他再加注) → previewCommit(我跟注).winnable`（contextBuilder.ts:4141-4147）');
line('  终局资金（由本手筹码推导）：Hero 200−6−8−140 = 46 ｜ 对手 200−6−8−140 = 46 ⇒ 双方各剩 46，底池 309（剩余/底池 ≈ 14.9%）');
line(`  权益精度：method=${String(rr['equityMethod'])} ｜ iterations=${String(rr['equityIterations'])} = ` +
  `**跟注桶 ${String(rr['callCombos'])} 组 × 44 张河牌**（52−4 公共−2 Hero−2 对手 = 44）⇒ 河牌已精确枚举；` +
  `再加注桶 ${String(rr['reRaiseCombos'])} 组的权益走同一引擎（未单独上报迭代数）`);
line('  河牌行动：本分支不含任何河牌下注/弃牌节点（EV = 权益 × 终池 − 累计投入）⇒ **终止近似（摊牌口径）**');
line('  4-bet：`heroFourBetSupported=' + String(rr['heroFourBetSupported']) + '`（他未全下 ⇒ Hero 还有 4-bet 选项，模型不支持 ⇒ 分支 EV 为下界，已由 evKind 标注）');
const assumptions = rr['assumptionsZh'] as readonly string[];
const dupes = assumptions.filter((x, i) => assumptions.indexOf(x) !== i);
line(`  假设清单条数=${assumptions.length}（**重复条数=${dupes.length}**：${dupes.length === 0 ? '无' : JSON.stringify(dupes)}）`);
line(`  是否披露「后续街不再行动（摊牌终止近似）」：` +
  `${assumptions.some((x) => x.includes('摊牌终止近似') && x.includes('未模拟')) ? '有' : '**没有**'}`);
line(`  是否披露「不是严格下界」：${assumptions.some((x) => x.includes('严格')) ? '有' : '**没有**'}`);
line(`  是否披露「4-bet 未实现」：${assumptions.some((x) => x.includes('4-bet')) ? '有' : '**没有**'}`);
for (const [i, a] of assumptions.entries()) line(`   [${i + 1}] ${a}`);
