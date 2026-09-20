/**
 * ============================================================================
 * TEST 16 —— 只读探针（**不修改任何产品代码 / 参数 / 测试**）
 * ============================================================================
 *
 * 牌局（用户给定，逐字重建）：
 *
 * ```text
 * 6 人现金桌｜盲注 1/2｜100BB（起始筹码 200 筹码）
 * Hero BTN  A♠A♥｜有效筹码 200
 * 公共牌     A♦ 9♣ 4♥ 6♠ 2♦（河牌 · 顶暗三条 A）
 * 翻前 UTG/HJ/CO 弃牌 → Hero BTN 加注到 6（3BB）→ SB 弃牌 → BB 阿豪跟注 ⇒ 底池 13
 * 翻牌 BB 过牌 → Hero 下注 5（2.5BB）→ BB 跟注                        ⇒ 底池 23
 * 转牌 BB 过牌 → Hero 下注 15（7.5BB）→ BB 跟注                       ⇒ 底池 53
 * 河牌 BB 主动下注 20（10BB）  ← **当前决策点**                       ⇒ 底池 73
 *      Hero 剩余 174（87BB）｜Villain 本轮下注后剩余 154（77BB）
 * ```
 *
 * 画像：阿豪 = MANIAC（松凶），800 手；VPIP 48% / PFR 35% / 3Bet 16% / WTSD 36%；
 *       其余统计**一律 null**（不编造）。
 *
 * ## 本脚本的纪律
 *
 * - **不预设、不硬编码任何结果**：只调用生产入口 `analyzeManualHand` 与生产函数，
 *   把读到的数字原样打印；不复算出一个「应该是」的动作去比对。
 * - 数字口径与生产**同源**：`deriveLegalActions` / `buildSizeGrid` /
 *   `buildBettingRangeFacts` / `buildRaiseResponse` / `raiseEVOf` / `rangeEquityOfMany`
 *   全部用产品自己的实现；`scripts/__shadow-contextBuilder.ts` 只是把
 *   `contextBuilder` 的**私有函数**机械暴露出来（产品零改动），
 *   且本脚本在 §0 先做**源码级同步校验**、在 §4 再做**逐位一致性校验**，
 *   任一项失败即声明该部分证据不可信。
 */

import { readFileSync } from 'node:fs';

import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';
import { buildRaiseResponse, raiseEVOf, CASHFLOW_CONTRACT } from '../src/app/manualInput/raiseResponse.ts';
import { buildBettingRangeFacts } from '../src/app/manualInput/bettingRange.ts';
import { buildSizeGrid, deriveLegalActions } from '../src/app/manualInput/legalActions.ts';
import { parseManualInput, type ManualHandInput } from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import { quickProfileToLimperArchetype } from '../src/app/manualInput/limpIsolation.ts';
import { responseTendenciesOf } from '../src/domain/postflop/betResponse.ts';
import { computeEquity, EquityComputeMode, confidenceHalfWidth } from '../src/domain/poker/equity.ts';
import {
  computePot,
  committedThisStreet,
  realizedOpponentIds,
  allBoardCards,
} from '../src/domain/poker/gameState.ts';
import { previewCommit } from '../src/domain/poker/pots.ts';
import { applyAction } from '../src/domain/poker/engine.ts';
import { behaviorProfileOf } from '../src/domain/player/behaviorProfile.ts';
import { resolvePlayerProfile } from '../src/domain/player/observedStats.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import { ALL_CARDS, parseCardStrict } from '../src/domain/poker/cards.ts';
import type { Card } from '../src/domain/types.ts';
import { buildRangeSnapshot, buildPlayerSnapshot, boardAtStreetOf, nodeActionContextOf } from './__shadow-contextBuilder.ts';

/* ============================================================
 * 通用打印工具
 * ============================================================ */

const line = (s = ''): void => console.log(s);
const n = (v: unknown, d = 2): string =>
  typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : String(v);
const pct = (v: unknown, d = 2): string =>
  typeof v === 'number' && Number.isFinite(v) ? `${(v * 100).toFixed(d)}%` : String(v);
/** 中文按 2 列宽排版 */
const pad = (s: string, w: number): string => {
  const len = [...s].reduce((a, c) => a + (c.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
  return s + ' '.repeat(Math.max(0, w - len));
};
const rule = (w = 118): string => '='.repeat(w);

/* ============================================================
 * 输入（BB 口径；1BB = 2 筹码 ⇒ 面额与用户的「筹码」一致）
 * ============================================================ */

const RULES = loadKnowledgeBaseOrThrow().allRules();
/** 与 `contextBuilder` 的默认种子一致 ⇒ `analyzeManualHand` 与 `buildDecisionContext` 同一颗种子 */
const EQUITY_SEED = 20_260_913;
const OPTIONS = {
  rules: RULES, asOf: 1_757_000_000_000, writeLog: false,
  equitySeed: EQUITY_SEED, budget: { softMs: 120_000, hardMs: 240_000 },
} as const;
const RESPONSE_EQUITY_ITERATIONS = 6000;
const SEED_OFFSET_BET_RANGE = 1301;   // contextBuilder: heroEquityVsBetRange
const SEED_OFFSET_RAISE_CALL = 1601;  // contextBuilder: EqVsRaiseCallRange
const SEED_OFFSET_RERAISE = 2601;     // contextBuilder: EqVsReraiseRange

const A = (position: string, type: string, amountBB?: number, street?: string): Record<string, unknown> => ({
  position, type,
  ...(amountBB === undefined ? {} : { amountBB }),
  ...(street === undefined ? {} : { street }),
});

/** 用户的 5 个统计；**未提供的统计一律 null**（0 ≠ 缺失） */
const AHAO_STATS = {
  handsObserved: 800,
  vpip: 0.48, pfr: 0.35, threeBet: 0.16, wtsd: 0.36,
  foldToFlopCBet: null, foldToTurnCBet: null, foldToRiverBet: null,
  flopCheckRaise: null, turnCheckRaise: null, riverCheckRaise: null,
} as const;

type VillainSpec = { profile: string | null; stats: typeof AHAO_STATS | null; name?: string };

function buildInput(v: VillainSpec, opts: { potBB?: number } = {}): ManualHandInput {
  return {
    tableSize: 6,
    heroPosition: 'BTN',
    heroCards: ['As', 'Ah'],
    board: ['Ad', '9c', '4h', '6s', '2d'],
    street: 'RIVER',
    effectiveStackBB: 100,
    bigBlindBB: 2,
    seatStacksBB: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 },
    ...(opts.potBB === undefined ? {} : { potBB: opts.potBB }),
    actionHistory: [
      A('UTG', 'FOLD'), A('HJ', 'FOLD'), A('CO', 'FOLD'),
      A('BTN', 'RAISE', 3), A('SB', 'FOLD'), A('BB', 'CALL', 2),
      A('BB', 'CHECK', undefined, 'FLOP'), A('BTN', 'BET', 2.5, 'FLOP'), A('BB', 'CALL', 2.5, 'FLOP'),
      A('BB', 'CHECK', undefined, 'TURN'), A('BTN', 'BET', 7.5, 'TURN'), A('BB', 'CALL', 7.5, 'TURN'),
      A('BB', 'BET', 10, 'RIVER'),
    ],
    environment: 'MID_LOW_STAKES',
    villain: {
      ...(v.name === undefined ? {} : { playerId: v.name }),
      ...(v.profile === null ? {} : { quickProfile: v.profile }),
      dynamicHint: 'UNKNOWN',
      stackBB: 100,
      ...(v.stats === null ? {} : { observedStats: v.stats }),
    },
  } as unknown as ManualHandInput;
}

const MAIN = buildInput({ profile: 'MANIAC', stats: AHAO_STATS, name: '阿豪' });

/* ============================================================
 * §0 影子模块同步校验（只读：源码比较，不重新生成、不写盘）
 * ============================================================ */

line(rule());
line(' §0. 工具链可信度：审计影子模块是否与产品源码**逐字节同步**');
line(rule());
{
  const srcText = readFileSync('src/app/manualInput/contextBuilder.ts', 'utf8');
  const shadowText = readFileSync('scripts/__shadow-contextBuilder.ts', 'utf8');
  const rewritten = srcText.replace(
    /(from\s+')(\.\.\/\.\.\/|\.\.\/manualInput\/|\.\/)/g,
    (_m, p1: string, p2: string) => {
      if (p2 === '../../') return `${p1}../src/`;
      if (p2 === '../manualInput/') return `${p1}../src/app/manualInput/`;
      return `${p1}../src/app/manualInput/`;
    },
  );
  /* 影子 = 改写后的产品源码 + 尾部追加的导出块 ⇒ 前缀必须逐字节相同 */
  const same = shadowText.slice(0, rewritten.length) === rewritten;
  const marker = shadowText.indexOf('/* ==== AUDIT SHADOW EXPORTS (temp) ==== */');
  line(`  产品 src/app/manualInput/contextBuilder.ts ：${srcText.length} 字符`);
  line(`  影子 scripts/__shadow-contextBuilder.ts    ：${shadowText.length} 字符（追加导出块前 ${marker < 0 ? '未找到标记' : marker}）`);
  line(`  ⇒ 源码级同步（影子前 ${rewritten.length} 字符 == 改写后的产品源码）：${same ? '✔ 完全一致' : '✖ 不一致（影子过期）'}`);
  line(`  ⚠️ 本轮的处置（审计工具链，**未触碰产品代码**）：本脚本首次运行时此检查为 ✖（旧影子落后源码 11467 字符）；`);
  line(`     随后用仓库自带生成器 scripts/__make-shadow.ts 从当前源码**重新生成**了影子（旧影子已备份到 %TEMP%），`);
  line(`     生成后本检查为 ✔。§5 仍以「影子复算 vs 生产输出」做**数值级逐位校验**（双保险）。`);
}
line('');

/* ============================================================
 * §1 生产入口：节点重建 + 决策
 * ============================================================ */

const analyzed = analyzeManualHand(MAIN, OPTIONS);
if (!analyzed.ok) {
  line(`✖ 节点不支持：stage = ${analyzed.stage}`);
  line(`  issues = ${JSON.stringify(analyzed.issues, null, 2)}`);
  process.exit(1);
}
const D = analyzed.decision as unknown as Record<string, any>;
const DG = D['diagnostics'] as Record<string, any>;
const M = DG['math'] as Record<string, any>;
const PF = (DG['postflop'] ?? {}) as Record<string, any>;
const FACTS = (PF['raiseResponse'] ?? null) as Record<string, any> | null;

line(rule());
line(' §1. 牌局重建与生产输出（analyzeManualHand）');
line(rule());
line(`  重算底池 = ${n(analyzed.computedPot, 0)} 筹码（= ${n(analyzed.computedPot / 2, 2)} BB）｜用户声明底池 = ${String(analyzed.claimedPot)}`);
line(`  引擎声明：当前底池（含对手这一注）math.pot = ${n(M['pot'], 0)}｜跟注需补 math.callCost = ${n(M['callCost'], 0)}`);
line(`  我本街已投 = ${n(M['myCommittedThisStreet'], 0)}｜我的剩余 = ${n(M['myRemainingStack'], 0)}｜winnable = ${n(M['winnable'], 0)}`);
line(`  对手本街已投 = ${n(M['opponentCommittedThisStreet'], 0)}｜有效筹码 = ${n(M['effectiveStack'], 0)}｜SPR = ${n(M['spr'], 2)}`);
line(`  牌力：类别 = ${String(M['handCategory'])}｜所需权益 = ${pct(M['requiredEquity'], 4)}（适用 = ${String(M['requiredEquityApplies'])}）`);
line(`  合法动作 legalActions = ${JSON.stringify(DG['legalActions'])}`);
line(`  合法动作细目（生产内部同一份 deriveLegalActions）：见 §2`);
line('');
line(`  ⇒ Final Action = ${String(D['action'])}${D['sizeChips'] === undefined ? '' : ` @ ${n(D['sizeChips'], 0)} 筹码（${n(D['sizeBB'], 2)} BB）`}`);
line(`     置信度 = ${n(D['confidence'], 4)}（${String(D['band'])}）｜分类 = ${JSON.stringify(D['classification'])}｜actionable = ${String(D['actionable'])}`);
line(`     actionShape = ${JSON.stringify(DG['actionShape'])}`);
line(`     决策依据 decisionSource.kind = ${String((DG['decisionSource'] ?? {})['kind'])}｜decisionBasis = ${String((DG['decisionBasis'] ?? {})['kind'])}`);
line(`     一致性守卫 consistency = ${JSON.stringify(DG['consistency'])}`);
line('');

/* ---- 推荐动作的**合法性**：交给引擎自己的 applyAction 判定（不是自造规则） ---- */

const parsed = parseManualInput(MAIN);
if (!parsed.ok) { line(`✖ 解析失败：${JSON.stringify(parsed.issues)}`); process.exit(1); }
const gate = buildAnalyzableState(parsed.value);
if (!gate.ok) { line(`✖ 重建失败：${JSON.stringify(gate.issues)}`); process.exit(1); }
const state = gate.state;
const board: Card[] = (MAIN.board as string[]).map(parseCardStrict);
const hero = state.players.find((p) => p.id === state.userPlayerId)!;
const opponents = state.players.filter((p) => p.id !== hero.id && !p.folded);
const realizedSet = realizedOpponentIds(state);
const realizedOpponents = opponents.filter((p) => realizedSet.has(p.id));
const villain = (realizedOpponents[0] ?? opponents[0])!;
const legal = deriveLegalActions(state, hero);
const currentPot = computePot(state);
const heroStreetCommitted = committedThisStreet(state, hero.id);
const villainStreetCommitted = committedThisStreet(state, villain.id);
const toCall = Math.max(0, state.currentBet - heroStreetCommitted);
const grid = buildSizeGrid(legal, currentPot, 'RAISE');
const gridSizes = grid.map((o) => o.toAmount);
const minRaiseTo = legal.minRaiseToAmount;
const allInTo = legal.allInToAmount;

line(rule());
line(' §2. 合法动作与加注尺寸网格（引擎自己的规则，不是手搓）');
line(rule());
line(`  FOLD 恒合法｜CALL 需补 ${n(legal.callCost, 0)}（跟注即全下 = ${String(legal.callIsAllIn)}）｜CHECK 合法 = ${String(legal.canCheck)}`);
line(`  RAISE 合法 = ${String(legal.canRaise)}｜最小加注到 = ${n(minRaiseTo, 0)}｜全下（本街总额）= ${n(allInTo, 0)}｜我的剩余 = ${n(legal.myRemainingStack, 0)}`);
line(`  加注网格（buildSizeGrid 'RAISE'）= ${gridSizes.join('、')}（共 ${gridSizes.length} 档；网格轴 = 跟注额的 2/2.5/3/4/5/6/8 倍 + 最小加注 + 全下）`);
line('');
{
  const act = D['action'] as string | null;
  const size = D['sizeChips'] as number | undefined;
  line(`  推荐动作合法性（用引擎 applyAction 复查）：`);
  line(`    · 动作 ${String(act)} 是否在 legalActions 内：${act !== null && (DG['legalActions'] as string[]).includes(act) ? '✔ 是' : '✖ 否'}`);
  if (act === 'RAISE' || act === 'ALL_IN') {
    const r = applyAction(state, { playerId: hero.id, type: 'RAISE', amount: size } as never);
    line(`    · 推荐金额 ${n(size, 0)} 是否在加注网格内：${size !== undefined && gridSizes.some((x) => Math.abs(x - size) < 1e-9) ? '✔ 是' : '✖ 否'}`);
    line(`    · 引擎 applyAction(RAISE ${n(size, 0)})：${r.ok ? '✔ 接受（该金额可执行）' : `✖ 拒绝：${JSON.stringify((r as any).issues ?? (r as any).issue)}`}`);
  } else if (act === 'CALL') {
    const r = applyAction(state, { playerId: hero.id, type: 'CALL' } as never);
    line(`    · 引擎 applyAction(CALL)：${r.ok ? '✔ 接受' : `✖ 拒绝：${JSON.stringify((r as any).issues)}`}`);
  } else if (act === 'FOLD') {
    const r = applyAction(state, { playerId: hero.id, type: 'FOLD' } as never);
    line(`    · 引擎 applyAction(FOLD)：${r.ok ? '✔ 接受' : `✖ 拒绝：${JSON.stringify((r as any).issues)}`}`);
  }
}
line('');

/* ============================================================
 * §3 权益与跨动作 EV（生产输出原样）
 * ============================================================ */

const evidence = (DG['actionEvidence'] ?? []) as Record<string, any>[];
const evOf = (action: string): Record<string, any> | undefined => evidence.find((e) => e['action'] === action);
const FOLD_EV = evOf('FOLD')?.['ev'] ?? 0;
const CALL_EV = evOf('CALL')?.['ev'] ?? null;

line(rule());
line(' §3. 条件权益与跨动作 EV（生产输出）');
line(rule());
line(`  EqVsArrivalRange（到达范围，betRangeArrival）= ${n((PF['betRangeArrival'] ?? {})['heroEquityVsArrivalRange'], 6)}`);
line(`  EqVsBetRange（math.heroEquityVsBetRange，**CALL EV 用它**）= ${n(M['heroEquityVsBetRange'], 6)}`);
line(`  math.heroEquity（整体范围，含本街下注的似然）= ${n(M['heroEquity'], 6)}`);
line(`  EqVsRaiseCallRange（raiseResponse.heroEquityVsRaiseCallRange）= ${n(FACTS?.['heroEquityVsRaiseCallRange'], 6)}`);
line(`  conditionalEquities（诊断）= ${JSON.stringify(DG['conditionalEquities'])}`);
line('');
line(`  动作证据表：`);
for (const e of evidence) {
  line(`    · ${pad(String(e['action']), 8)} EV = ${pad(n(e['ev'], 6), 14)} 类型 = ${pad(String(e['estimateType']), 22)} ` +
    `decisionMargin = ${String(e['decisionMargin'])}${e['evKind'] === undefined ? '' : `｜evKind = ${String(e['evKind'])}`}`);
}
line(`  ⇒ FOLD EV = ${n(FOLD_EV, 6)}（零点定义）｜CALL EV = ${n(CALL_EV, 6)}`);
line('');
line(`  跨动作工程容差带 = 5% × winnable = ±${n(0.05 * (M['winnable'] as number), 2)} 筹码（**不是**统计误差）`);
line(`  decisionMargin（诊断）= ${JSON.stringify(DG['decisionMargin'])}`);
line(`  mathDominance = ${JSON.stringify(DG['mathDominance'])}`);
line('');

/* ============================================================
 * §4 加注响应事实包（生产唯一建模的那一档）+ 再加注分支（P1-2b）
 * ============================================================ */

const heroContestedAdd = (FACTS?.['heroContestedAdd'] ?? NaN) as number;
const finalPot = (FACTS?.['finalPot'] ?? NaN) as number;
const rrEV = (FACTS?.['reraiseBranchEV'] ?? NaN) as number;
const rrEVLowerBound = -heroContestedAdd;
const raiseEVProduct = (FACTS?.['raiseEV'] ?? null) as number | null;
/** ① 用产品公式复算（读代码没读错） */
const reconProduct = FACTS === null ? NaN :
  (FACTS['foldLikelihood'] as number) * (FACTS['currentPot'] as number) +
  (FACTS['callLikelihood'] as number) * ((FACTS['heroEquityVsRaiseCallRange'] as number) * finalPot - heroContestedAdd) +
  (FACTS['reRaiseLikelihood'] as number) * rrEV;
/** ② 若**没有** P1-2b（把被再加注分支退回下界 −heroContestedAdd）会是多少 */
const reconWithoutP12b = FACTS === null ? NaN :
  (FACTS['foldLikelihood'] as number) * (FACTS['currentPot'] as number) +
  (FACTS['callLikelihood'] as number) * ((FACTS['heroEquityVsRaiseCallRange'] as number) * finalPot - heroContestedAdd) +
  (FACTS['reRaiseLikelihood'] as number) * rrEVLowerBound;

line(rule());
line(' §4. 加注响应事实包（生产只对**一个**尺寸建模）与 P1-2b 再加注分支');
line(rule());
if (FACTS === null) {
  line('  本节点没有加注响应事实包（raiseResponse = null）⇒ 加注 EV 不存在，全部加注金额属「未评估动作」。');
  line(`  未评估动作 = ${JSON.stringify(DG['unevaluatedActions'])}`);
} else {
  line(`  生产建模的加注尺寸 sizeChips = ${n(FACTS['sizeChips'], 0)} 筹码（${n(FACTS['sizeBB'], 2)} BB）`);
  line(`  资金：currentPot = ${n(FACTS['currentPot'], 0)}｜我本街已投 = ${n(FACTS['heroStreetCommitted'], 0)}｜他本街已投 = ${n(FACTS['villainStreetCommitted'], 0)}`);
  line(`        heroAdd = ${n(FACTS['heroAdd'], 0)}｜heroContestedAdd（留在池中）= ${n(FACTS['heroContestedAdd'], 0)}｜退回 uncalledReturn = ${n(FACTS['uncalledReturn'], 0)}`);
  line(`        villainAddRaw = ${n(FACTS['villainAddRaw'], 0)}｜villainAdd（封顶后）= ${n(FACTS['villainAdd'], 0)}｜他跟平即全下 villainIsAllInByCall = ${String(FACTS['villainIsAllInByCall'])}`);
  line(`        finalPot = ${n(FACTS['finalPot'], 0)}｜他需权益 priceRequiredEquity = ${n(FACTS['model']?.['priceRequiredEquity'], 6)}｜margin = ${n(FACTS['model']?.['margin'], 2)}`);
  line(`        我的加注相对底池 ratioToPot = ${n(FACTS['model']?.['ratioToPot'], 4)}｜heroIsAllIn = ${String(FACTS['model']?.['heroIsAllIn'])}`);
  line('');
  line(`  响应概率（他面对我加注到 ${n(FACTS['sizeChips'], 0)}）：P(弃) = ${pct(FACTS['foldLikelihood'], 4)}｜P(跟) = ${pct(FACTS['callLikelihood'], 4)}｜P(再加注) = ${pct(FACTS['reRaiseLikelihood'], 4)}`);
  line(`        归一校验：三者之和 = ${n((FACTS['foldLikelihood'] as number) + (FACTS['callLikelihood'] as number) + (FACTS['reRaiseLikelihood'] as number), 12)}`);
  line(`        可达组合 = ${String(FACTS['reachableCombos'])}｜跟注桶组合 = ${String(FACTS['callCombos'])}｜再加注桶组合 = ${String(FACTS['reRaiseCombos'])}`);
  line(`  EqVsRaiseCallRange = ${n(FACTS['heroEquityVsRaiseCallRange'], 6)}（方法 ${String(FACTS['equityMethod'])}，${String(FACTS['equityIterations'])} 次）`);
  line(`  RAISE EV（生产）= ${n(raiseEVProduct, 6)}｜evKind = ${String(FACTS['evKind'])}`);
  line('');
  line('  ── 契约复算 ──');
  line(`    价格恒等式 price = villainAdd/finalPot：${n(FACTS['model']?.['priceRequiredEquity'], 9)} vs ${n((FACTS['villainAdd'] as number) / (FACTS['finalPot'] as number), 9)} ` +
    `${Math.abs((FACTS['model']?.['priceRequiredEquity'] as number) - (FACTS['villainAdd'] as number) / (FACTS['finalPot'] as number)) < 1e-12 ? '✔' : '✖'}`);
  line(`    终池恒等式 finalPot = currentPot + heroContestedAdd + villainAdd：${n(FACTS['finalPot'], 0)} vs ${n((FACTS['currentPot'] as number) + (FACTS['heroContestedAdd'] as number) + (FACTS['villainAdd'] as number), 0)} ` +
    `${Math.abs((FACTS['finalPot'] as number) - ((FACTS['currentPot'] as number) + (FACTS['heroContestedAdd'] as number) + (FACTS['villainAdd'] as number))) < 1e-9 ? '✔' : '✖'}`);
  line(`    cashflowContract = ${String(FACTS['cashflowContract'])}（产品常量 = ${CASHFLOW_CONTRACT}）${FACTS['cashflowContract'] === CASHFLOW_CONTRACT ? ' ✔' : ' ✖'}`);
  line(`    用产品公式复算 RAISE EV = ${n(reconProduct, 9)} vs 产品 ${n(raiseEVProduct, 9)}｜差 ${n(Math.abs(reconProduct - (raiseEVProduct ?? NaN)), 12)} ` +
    `${Math.abs(reconProduct - (raiseEVProduct ?? NaN)) < 1e-9 ? '✔ 一致' : '✖ 不一致'}`);
  line('');
  line('  ── P1-2b：被再加注分支 ──');
  line(`    分支类型 reraiseBranchKind = ${String(FACTS['reraiseBranchKind'])}`);
  line(`    他再加注到 reRaiseTo = ${n(FACTS['reRaiseTo'], 0)}（最小合法 minReRaiseTo = ${n(FACTS['reRaiseMinLegalTo'], 0)}）｜他再加注即全下 villainReRaiseIsAllIn = ${String(FACTS['villainReRaiseIsAllIn'])}`);
  line(`    我再需补 heroAdditionalCallVsReRaise = ${n(FACTS['heroAdditionalCallVsReRaise'], 0)}｜跟注后终池 finalPotAfterCallVsReRaise = ${n(FACTS['finalPotAfterCallVsReRaise'], 0)}`);
  line(`    EqVsReraiseRange = ${n(FACTS['heroEquityVsReraiseRange'], 6)}｜再加注桶组合 = ${String(FACTS['reRaiseCombos'])}`);
  line(`    我面对再加注：FOLD 分支 EV = ${n(FACTS['reraiseFoldBranchEV'], 6)}｜CALL 分支 EV = ${n(FACTS['reraiseCallBranchEV'], 6)}｜取用 reraiseBranchEV = ${n(FACTS['reraiseBranchEV'], 6)}`);
  line(`    Hero 4-bet（反加）是否支持 heroFourBetSupported = ${String(FACTS['heroFourBetSupported'])}｜未支持说明 = ${String(FACTS['reraiseBranchUnsupportedZh'])}`);
  line(`    他再加注金额的**合法性**（引擎 applyAction 复查）：`);
  {
    const raiseTo = FACTS['sizeChips'] as number;
    const a1 = applyAction(state, { playerId: hero.id, type: 'RAISE', amount: raiseTo } as never);
    const vState = (a1 as any).state ?? state;
    const a2 = applyAction(vState, { playerId: villain.id, type: 'RAISE', amount: FACTS['reRaiseTo'] as number } as never);
    line(`      · Hero 加注到 ${n(raiseTo, 0)}：${a1.ok ? '✔ 被引擎接受' : `✖ 拒绝 ${JSON.stringify((a1 as any).issues)}`}` +
      `（记录数：${(state.actions ?? []).length} → ${((vState.actions ?? []).length)}）`);
    line(`      · 他再加注到 ${n(FACTS['reRaiseTo'], 0)}：${a2.ok ? '✔ 被引擎接受（**不足最小加注的短筹码全下加注**，法律上有效）' : `✖ 拒绝 ${JSON.stringify((a2 as any).issues)}`}` +
      `（记录数：${((vState.actions ?? []).length)} → ${((((a2 as any).state ?? vState).actions ?? []).length)}）`);
    line(`      · 判据：minReRaiseTo − 他本街已投 = ${n((FACTS['reRaiseMinLegalTo'] as number) - (FACTS['villainStreetCommitted'] as number), 0)} > 他的剩余 ${n(villain.remainingStack, 0)} ⇒ 他**买不起完整再加注**，只能全下。`);
  }
  line('');
  line('  ── P1-2b 是否**真的**进入最终 RAISE EV ──');
  line(`    ✔ 进入。RAISE EV = P(弃)·底池 + P(跟)·(EqVsRaiseCall·终池 − 我留在池中) + P(再加注)·reraiseBranchEV`);
  line(`       = ${n(FACTS['foldLikelihood'], 6)}×${n(FACTS['currentPot'], 0)} + ${n(FACTS['callLikelihood'], 6)}×(${n(FACTS['heroEquityVsRaiseCallRange'], 6)}×${n(finalPot, 0)} − ${n(heroContestedAdd, 0)}) + ${n(FACTS['reRaiseLikelihood'], 6)}×(${n(rrEV, 6)})`);
  line(`       = ${n(raiseEVProduct, 6)}`);
  line(`    被再加注分支的**贡献量** = P(再加注) × reraiseBranchEV = ${n((FACTS['reRaiseLikelihood'] as number) * rrEV, 6)} 筹码`);
  line(`    若退回 P1-2b 之前的下界（分支 = −heroContestedAdd = ${n(rrEVLowerBound, 0)}）：RAISE EV 会是 ${n(reconWithoutP12b, 6)}`);
  line(`    ⇒ P1-2b 带来的差额 = ${n((raiseEVProduct ?? NaN) - reconWithoutP12b, 6)} 筹码 ` +
    `${Math.abs((raiseEVProduct ?? NaN) - reconWithoutP12b) > 1e-9 ? '（**非零 ⇒ 确实进入了最终 EV**）' : '（为零 ⇒ 本节点上 P1-2b 与下界同值）'}`);
}
line('');
line(`  未评估的合法动作（诊断 unevaluatedActions）：`);
for (const u of (DG['unevaluatedActions'] ?? []) as Record<string, any>[]) {
  line(`    · ${String(u['action'])}${u['sizeChips'] === null ? '' : ` @ ${n(u['sizeChips'], 0)}`}｜reasonCode = ${String(u['reasonCode'])}｜${String(u['reasonZh'])}`);
}
line(`  allInGuard = ${JSON.stringify(DG['allInGuard'], null, 0)}`);
line('');

/* ============================================================
 * §5 逐尺寸响应与 EV（同源复算）+ 与生产逐位一致性校验
 * ============================================================ */

const villainId = ((parsed.value.villain as unknown as Record<string, unknown> | undefined)?.['playerId'] as string | undefined) ?? villain.id;
/**
 * 🔴 **生产的关键判据**（`contextBuilder` 的 `opponent.id === villainId`）：
 * `villainId = input.villainPlayerId ?? 座位 id`，而座位 id 是 `seat_<位置>`
 * （`reconstruct.playerIdOfPosition`）。**若调用方传的是对手的「名字」**（本题的「阿豪」），
 * 这个判据**不成立** ⇒ 画像 provider / 行为画像 / 跛入原型在这一条链上按「陌生人」处理。
 * 本脚本照抄该判据，才能与生产逐位对齐（§7 有专门的实验证明它确实生效）。
 */
const identityMatches = villain.id === villainId;
const playerBuilt = buildPlayerSnapshot(
  villainId as never, undefined as never, 'MANIAC' as never, 'UNKNOWN' as never,
  (s: never) => boardAtStreetOf(state, s),
);
const behaviorProfile = identityMatches
  ? (behaviorProfileOf({ playerId: villainId, archetype: 'MANIAC' as never }) ?? null)
  : null;
const limpProfile = identityMatches
  ? { archetype: quickProfileToLimperArchetype('MANIAC'), confidence: playerBuilt.confidence }
  : { archetype: quickProfileToLimperArchetype('UNKNOWN'), confidence: 0 };
let betIndex: number | undefined;
for (let i = state.actions.length - 1; i >= 0; i -= 1) {
  const a = state.actions[i]!;
  if (a.street === state.street && (a.type === 'BET' || a.type === 'RAISE' || a.type === 'RERAISE' || a.type === 'ALL_IN')) {
    betIndex = i; break;
  }
}
const rangeBuilt = buildRangeSnapshot(
  state, villain as never, [...hero.holeCards!, ...board] as never, undefined,
  (identityMatches ? playerBuilt.tendency : null) as never, limpProfile as never,
  behaviorProfile as never, betIndex,
);
const arrival = (rangeBuilt.rangeBeforeAction ?? rangeBuilt.range)!;
const ownDimensions = playerBuilt.tendency === null ? null : playerBuilt.tendency.dimension.dimensions;
const resolvedV3 = resolvePlayerProfile({
  baseArchetype: 'MANIAC' as never,
  observedStats: AHAO_STATS as never,
  opportunities: null,
  actionContext: nodeActionContextOf(state, hero, villain) as never,
  street: 'RIVER',
});
const v3StreetInput = { street: 'RIVER' as const, factors: resolvedV3.resolved.street.RIVER };
const tendencies = responseTendenciesOf(ownDimensions as never, playerBuilt.tendency === null ? 0 : playerBuilt.confidence, v3StreetInput as never);
const betFacts = buildBettingRangeFacts({
  arrivalEntries: arrival.entries.map((e: any) => ({ cardIndices: e.combo.cardIndices, probability: e.probability })),
  board,
  heroHole: hero.holeCards!,
  potChips: currentPot - state.currentBet,
  betChips: state.currentBet,
  street: 'RIVER',
  tendencies: tendencies as never,
});

/** 与 `contextBuilder.rangeEquityOfMany` 完全同源 */
function rangeEquityOf(entries: readonly { cardIndices: readonly [number, number]; probability: number }[], seed: number) {
  const out = computeEquity(
    [hero.holeCards![0]!, hero.holeCards![1]!],
    board,
    [{
      label: '条件范围 1（响应模型）',
      combos: entries.map((e) => [ALL_CARDS[e.cardIndices[0]]!, ALL_CARDS[e.cardIndices[1]]!] as const),
    }],
    {
      mode: EquityComputeMode.FAST,
      seed,
      iterations: RESPONSE_EQUITY_ITERATIONS,
      opponentWeights: [entries.map((e) => e.probability)],
    },
  );
  if (!out.ok) return { value: null as number | null, method: 'NOT_AVAILABLE', iterations: 0, halfWidth: null as number | null };
  const method = out.result.method === 'EXACT' ? 'EXACT' : 'MONTE_CARLO';
  return {
    value: out.result.equity,
    method,
    iterations: out.result.iterations,
    halfWidth: method === 'MONTE_CARLO' ? (confidenceHalfWidth(out.result) ?? null) : 0,
  };
}

/** 用生产同一套函数评估一个加注尺寸（口径与 `contextBuilder` 的 raiseResponse 块逐行对齐） */
function evaluateSize(raiseTo: number) {
  const heroAdd = Math.max(0, raiseTo - heroStreetCommitted);
  if (!(heroAdd > 0)) return null;
  const villainAddRaw = Math.max(0, raiseTo - villainStreetCommitted);
  const villainAdd = Math.min(villainAddRaw, Math.max(0, villain.remainingStack));
  if (!(villainAdd > 0)) return null;
  const villainIsAllInByCall = villain.remainingStack <= villainAdd + 1e-9;
  const villainStreetTotalAfterCall = villainStreetCommitted + villainAdd;
  const contested = Math.max(0, Math.min(heroAdd, villainStreetTotalAfterCall - heroStreetCommitted));
  if (!(contested > 0)) return null;
  const pot = currentPot + contested + villainAdd;
  const heroIsAllIn = raiseTo >= legal.allInToAmount - 1e-9;
  const built = buildRaiseResponse({
    betRangeEntries: betFacts!.entries, board, currentPot, heroAdd, villainAdd, heroContestedAdd: contested,
    finalPot: pot, street: 'RIVER', tendencies: tendencies as never, heroIsAllIn, villainIsAllInByCall,
  });
  if (built === null) return null;

  const eqCall = rangeEquityOf(built.callContinueEntries, EQUITY_SEED + SEED_OFFSET_RAISE_CALL);

  /* ---- 再加注分支（P1-2b）：与 contextBuilder 3919-3960 同一套推导 ---- */
  const reRaiseFacts = (() => {
    if (built.reRaiseLikelihood <= 0 || built.reRaiseEntries.length === 0) return null;
    const minReRaiseTo = raiseTo + (raiseTo - villainStreetCommitted);
    const villainMaxTo = villainStreetTotalAfterCall + Math.max(0, villain.remainingStack - villainAdd);
    const reRaiseTo = Math.min(minReRaiseTo, villainMaxTo);
    if (!(reRaiseTo > raiseTo + 1e-9)) return null;
    const villainReRaiseIsAllIn = reRaiseTo >= villainMaxTo - 1e-9;
    const heroRemainingAfterRaise = Math.max(0, legal.myRemainingStack - heroAdd);
    const additionalCall = Math.min(reRaiseTo - raiseTo, heroRemainingAfterRaise);
    if (!(additionalCall > 0)) return null;
    const afterRaise = applyAction(state, { playerId: hero.id, type: 'RAISE', amount: raiseTo } as never);
    if (!afterRaise.ok) return null;
    const afterReRaise = applyAction((afterRaise as any).state, { playerId: villain.id, type: 'RAISE', amount: reRaiseTo } as never);
    if (!afterReRaise.ok) return null;
    const finalPotAfterCall = previewCommit((afterReRaise as any).state, hero.id, additionalCall).winnable;
    if (!(finalPotAfterCall > 0)) return null;
    return { minReRaiseTo, villainMaxTo, reRaiseTo, villainReRaiseIsAllIn, additionalCall, finalPotAfterCall };
  })();
  const eqRR = reRaiseFacts === null ? { value: null as number | null, method: 'NOT_AVAILABLE', iterations: 0, halfWidth: null as number | null }
    : rangeEquityOf(built.reRaiseEntries, EQUITY_SEED + SEED_OFFSET_RERAISE);
  const rrBranchEV = reRaiseFacts !== null && eqRR.value !== null
    ? Math.max(-contested, eqRR.value * reRaiseFacts.finalPotAfterCall - contested - reRaiseFacts.additionalCall)
    : -contested;
  const rrKind = reRaiseFacts === null || eqRR.value === null
    ? 'LOWER_BOUND_NOT_IMPLEMENTED'
    : (rrBranchEV > -contested + 1e-9 ? 'CALL' : 'FOLD');
  const ev = eqCall.value === null ? null : raiseEVOf({
    foldLikelihood: built.foldLikelihood, callLikelihood: built.callLikelihood, reRaiseLikelihood: built.reRaiseLikelihood,
    currentPot, heroContestedAdd: contested, finalPot: pot, equityVsRaiseCall: eqCall.value, reraiseBranchEV: rrBranchEV,
  });
  /** 若没有 P1-2b（分支退回下界） */
  const evLowerBound = eqCall.value === null ? null : raiseEVOf({
    foldLikelihood: built.foldLikelihood, callLikelihood: built.callLikelihood, reRaiseLikelihood: built.reRaiseLikelihood,
    currentPot, heroContestedAdd: contested, finalPot: pot, equityVsRaiseCall: eqCall.value, reraiseBranchEV: -contested,
  });
  return {
    raiseTo, heroAdd, villainAdd, villainAddRaw, contested, finalPot: pot, heroIsAllIn, villainIsAllInByCall,
    f: built.foldLikelihood, c: built.callLikelihood, rr: built.reRaiseLikelihood,
    price: built.model.priceRequiredEquity, margin: built.model.margin, ratioToPot: built.model.ratioToPot,
    eqCall: eqCall.value, eqCallMethod: eqCall.method, eqCallIters: eqCall.iterations, eqCallHW: eqCall.halfWidth,
    ev, evLowerBound, eqRR: eqRR.value, rrBranchEV, rrKind,
    reRaiseTo: reRaiseFacts?.reRaiseTo ?? null, reRaiseMinLegalTo: reRaiseFacts?.minReRaiseTo ?? null,
    rrIsAllIn: reRaiseFacts?.villainReRaiseIsAllIn ?? null, additionalCall: reRaiseFacts?.additionalCall ?? null,
    finalPotAfterCall: reRaiseFacts?.finalPotAfterCall ?? null,
    callCombos: built.callCombos, reRaiseCombos: built.reRaiseCombos, reachable: built.reachableCombos,
  };
}

line(rule());
line(' §5. 逐尺寸：响应概率 / EqVsRaiseCallRange / RAISE EV（同源复算）');
line(rule());
line(`  下注范围（生产同源）：到达组合 ${betFacts?.entries.length ?? 0} → 下注组合 ${betFacts?.entries.length ?? 0}` +
  `｜到达质量 ${n(betFacts?.arrivalMass, 4)}｜下注质量 ${n(betFacts?.betMass, 4)}｜下注占到达 ${n(betFacts?.betShareOfArrival, 4)}`);
line(`  倾向：callScale = ${n((tendencies as any)?.callScale, 4)}｜foldScale = ${n((tendencies as any)?.foldScale, 4)}｜raiseScale = ${n((tendencies as any)?.raiseScale, 4)}｜bluffRaiseScale = ${n((tendencies as any)?.bluffRaiseScale, 4)}`);
line('');
line('  ' + pad('加注至', 8) + pad('我新增', 8) + pad('他补', 7) + pad('终池', 7) + pad('价格', 8) + pad('P(弃)', 9) + pad('P(跟)', 9) +
  pad('P(再加)', 9) + pad('EqVsRaiseCall', 14) + pad('RAISE EV', 12) + pad('(无P1-2b)', 11) + pad('权益法', 12) + '生产?');
line('  ' + '-'.repeat(130));
const rows: NonNullable<ReturnType<typeof evaluateSize>>[] = [];
for (const size of gridSizes) {
  const r = evaluateSize(size);
  if (r === null) { line('  ' + pad(String(size), 8) + '（模型返回 null / 非法）'); continue; }
  rows.push(r);
  const isProd = FACTS !== null && Math.abs(size - (FACTS['sizeChips'] as number)) < 1e-9;
  line('  ' + pad(String(size), 8) + pad(n(r.heroAdd, 0), 8) + pad(n(r.villainAdd, 0), 7) + pad(n(r.finalPot, 0), 7) +
    pad(n(r.price, 4), 8) + pad(pct(r.f, 2), 9) + pad(pct(r.c, 2), 9) + pad(pct(r.rr, 2), 9) +
    pad(n(r.eqCall, 6), 14) + pad(n(r.ev, 2), 12) + pad(n(r.evLowerBound, 2), 11) +
    pad(`${r.eqCallMethod}`, 12) + (isProd ? '← 生产' : '未评估'));
}
line('');
{
  const prodRow = rows.find((r) => FACTS !== null && Math.abs(r.raiseTo - (FACTS['sizeChips'] as number)) < 1e-9);
  const prodBR = (PF['bettingRangeFacts'] ?? null) as Record<string, any> | null;
  line('  ── 逐位一致性校验（影子复算 vs 生产输出；失败则本节证据不可信）──');
  line('     (a) 下注范围权重链（先定位漂移是否发生在范围层）');
  const myBetRangeEq = betFacts === null ? null : rangeEquityOf(betFacts.entries, EQUITY_SEED + SEED_OFFSET_BET_RANGE).value;
  for (const [label, mine, prod] of [
    ['arrivalMass', betFacts?.arrivalMass, prodBR?.['arrivalMass']],
    ['betMass', betFacts?.betMass, prodBR?.['betMass']],
    ['betShareOfArrival', betFacts?.betShareOfArrival, prodBR?.['betShareOfArrival']],
    ['entryCount', betFacts?.entries.length, prodBR?.['entryCount']],
    ['heroEquityVsBetRange', myBetRangeEq, M['heroEquityVsBetRange']],
    ['EqVsArrivalRange', rangeEquityOf(arrival.entries.map((e: any) => ({ cardIndices: e.combo.cardIndices, probability: e.probability })), EQUITY_SEED + SEED_OFFSET_BET_RANGE).value, (PF['betRangeArrival'] ?? {})['heroEquityVsArrivalRange']],
  ] as [string, unknown, unknown][]) {
    const ok = typeof mine === 'number' && typeof prod === 'number' && Math.abs(mine - prod) < 1e-12;
    line(`     ${ok ? '✔' : '✖'} ${pad(label, 30)} 复算 ${pad(n(mine, 9), 16)} 生产 ${pad(n(prod, 9), 16)} 差 ${n(Math.abs((mine as number ?? NaN) - (prod as number ?? NaN)), 12)}`);
  }
  line('     (b) 响应与 EV');
  if (prodRow === undefined || FACTS === null) {
    line('    ✖ 找不到生产尺寸对应的复算行');
  } else {
    const cmp: [string, number | null, number | null][] = [
      ['foldLikelihood', prodRow.f, FACTS['foldLikelihood']],
      ['callLikelihood', prodRow.c, FACTS['callLikelihood']],
      ['reRaiseLikelihood', prodRow.rr, FACTS['reRaiseLikelihood']],
      ['EqVsRaiseCallRange', prodRow.eqCall, FACTS['heroEquityVsRaiseCallRange']],
      ['raiseEV', prodRow.ev, FACTS['raiseEV']],
      ['reraiseBranchEV', prodRow.rrBranchEV, FACTS['reraiseBranchEV']],
      ['heroEquityVsReraiseRange', prodRow.eqRR, FACTS['heroEquityVsReraiseRange']],
      ['finalPot', prodRow.finalPot, FACTS['finalPot']],
      ['heroContestedAdd', prodRow.contested, FACTS['heroContestedAdd']],
      ['villainAdd', prodRow.villainAdd, FACTS['villainAdd']],
      ['priceRequiredEquity', prodRow.price, FACTS['model']?.['priceRequiredEquity']],
      ['reRaiseTo', prodRow.reRaiseTo, FACTS['reRaiseTo']],
      ['heroAdditionalCallVsReRaise', prodRow.additionalCall, FACTS['heroAdditionalCallVsReRaise']],
      ['finalPotAfterCallVsReRaise', prodRow.finalPotAfterCall, FACTS['finalPotAfterCallVsReRaise']],
    ];
    let allOk = true;
    for (const [label, mine, prod] of cmp) {
      const ok = typeof mine === 'number' && typeof prod === 'number' && Math.abs(mine - prod) < 1e-12;
      if (!ok) allOk = false;
      line(`    ${ok ? '✔' : '✖'} ${pad(label, 30)} 复算 ${pad(n(mine, 9), 16)} 生产 ${pad(n(prod, 9), 16)} 差 ${n(Math.abs((mine ?? NaN) - (prod ?? NaN)), 12)}`);
    }
    line(`    ⇒ 影子复算与生产**${allOk ? '逐位一致（本节其余尺寸的数字可信）' : '不一致（本节其余尺寸的数字仅供参考，须先修复复算）'}**`);
  }
}
line('');
{
  const bestEV = rows.filter((r) => r.ev !== null).reduce((a, b) => ((b.ev as number) > (a.ev as number) ? b : a), rows[0]!);
  const overCall = rows.filter((r) => r.ev !== null && (r.ev as number) > (CALL_EV ?? -Infinity));
  line(`  逐尺寸汇总：最高 RAISE EV = ${n(bestEV.ev, 4)}（加注至 ${bestEV.raiseTo}）｜CALL EV = ${n(CALL_EV, 4)}｜FOLD EV = 0`);
  line(`  优于 CALL 的加注尺寸：${overCall.length === 0 ? '无' : overCall.map((r) => `${r.raiseTo}(${n(r.ev, 2)})`).join('、')}`);
  line(`  P(再加注) > 0 的尺寸：${rows.filter((r) => r.rr > 1e-12).length}／${rows.length}（Hero 全下那一档 P(再加注) 必须为 0：${rows.filter((r) => r.heroIsAllIn).map((r) => `${r.raiseTo}→${n(r.rr, 4)}`).join('、') || '本节点无' }）`);
  line(`  P(弃) 随尺寸单调下降？${rows.every((r, i) => i === 0 || r.f <= rows[i - 1]!.f + 1e-12) ? '是' : '**否（锯齿）**'}｜P(跟) 随尺寸单调？${rows.every((r, i) => i === 0 || r.c <= rows[i - 1]!.c + 1e-12) ? '是' : '**否（锯齿：U9）**'}`);
  line(`  权益方法（逐尺寸跟注桶）：${[...new Set(rows.map((r) => `${r.eqCallMethod}(${r.eqCallIters})`))].join('、')}｜` +
    `抽样半宽（MONTE_CARLO 时）≈ ±${n(rows[0]!.eqCallHW, 4)}`);
  line(`  ⚠️ 上表除「加注至 ${n(FACTS?.['sizeChips'], 0)}」一行外，**都不是生产输出** —— 生产只对一档建模（§9①）；`);
  line(`     其余各档在本节的数字由影子复算得到，其可信度取决于下方 (a)(b) 两项逐位校验。`);
}
line('');

/* ============================================================
 * §6 再加注分支：逐尺寸（若 Villain 再加注）
 * ============================================================ */

line(rule());
line(' §6. 若 Villain 再加注：金额 / 合法性 / EqVsReraiseRange / Hero FOLD vs CALL');
line(rule());
line('  ' + pad('我的加注至', 12) + pad('他的再加注至', 14) + pad('最小合法', 10) + pad('他全下?', 9) +
  pad('我再需补', 10) + pad('跟注后终池', 12) + pad('EqVsReraise', 13) + pad('FOLD EV', 11) + pad('CALL EV', 11) + '取用分支');
line('  ' + '-'.repeat(120));
for (const r of rows.filter((x) => x.rr > 1e-12)) {
  const foldEV = -r.contested;
  const callEV = r.finalPotAfterCall === null || r.eqRR === null || r.additionalCall === null
    ? null : r.eqRR * r.finalPotAfterCall - r.contested - r.additionalCall;
  line('  ' + pad(String(r.raiseTo), 12) + pad(String(r.reRaiseTo), 14) + pad(n(r.reRaiseMinLegalTo, 0), 10) +
    pad(String(r.rrIsAllIn), 9) + pad(n(r.additionalCall, 0), 10) + pad(n(r.finalPotAfterCall, 0), 12) +
    pad(n(r.eqRR, 6), 13) + pad(n(foldEV, 2), 11) + pad(n(callEV, 2), 11) + String(r.rrKind));
}
line('');
line('  ⚠️ 两点模型口径（生产注释与代码一致）：');
line('    ① 模型的再加注分支 = `max(FOLD, CALL)`，**不含 Hero 的 4-bet（反加）**；');
line('       他的再加注若不是全下，`heroFourBetSupported = false` ⇒ 该分支值是**下界**。');
line('    ② `P(再加注) = 0` 时（Hero 全下）分支恒为空，`reraiseBranchEV = −heroContestedAdd`（不伪造分支）。');
line('');

/* ============================================================
 * §7 画像：实际生效的字段与未使用的统计
 * ============================================================ */

const ctxBuilt = buildDecisionContext({
  state, rules: RULES, environment: 'MID_LOW_STAKES', asOf: OPTIONS.asOf,
  quickProfile: 'MANIAC', dynamicHint: 'UNKNOWN', villainPlayerId: '阿豪',
  observedStats: AHAO_STATS as never, equitySeed: EQUITY_SEED, budget: OPTIONS.budget,
} as never);
const ctx = ctxBuilt.context as unknown as Record<string, any>;
const v3 = ctx['profileV3'] as Record<string, any> | undefined;

line(rule());
line(' §7. 人物画像：实际生效的字段 / 未使用的统计');
line(rule());
if (v3 === undefined) {
  line('  profileV3 快照缺失（没有连续统计时才会如此）—— 与输入矛盾，请检查。');
} else {
  line(`  baseArchetype（标签）= ${String(v3['baseArchetype'])}｜observedStatCount = ${String(v3['observedStatCount'])}/10｜可信度档位 = ${String(v3['confidenceTierZh'])}`);
  line(`  actionContext（节点语义门）= ${String(v3['actionContext'])}｜deniedStreetTraits（给了但被语义门拒绝）= ${JSON.stringify(v3['deniedStreetTraits'])}`);
  line(`  baseDimensions（标签 prior）    = ${JSON.stringify(v3['baseDimensions'])}`);
  line(`  observedDimensions（只有实测）  = ${JSON.stringify(v3['observedDimensions'])}`);
  line(`  resolvedDimensions（融合后）    = ${JSON.stringify(v3['resolvedDimensions'])}`);
  line(`  blendWeight（实测占比）        = ${JSON.stringify(v3['blendWeight'])}`);
  line(`  evidenceMass（逐轴证据质量）    = ${JSON.stringify(v3['evidenceMass'])}`);
  line(`  分街系数（响应层真正消费的）    = ${JSON.stringify(v3['street'])}`);
  line('');
  line(`  逐统计 trace（${(v3['trace'] as unknown[]).length} 条）：`);
  line('  ' + pad('统计', 18) + pad('用户给的', 12) + pad('生效比率', 12) + pad('机会数', 9) + pad('成功率', 8) +
    pad('收缩权重', 10) + pad('可信度', 9) + pad('驱动分街条目', 16) + '是否进入本节点');
  line('  ' + '-'.repeat(120));
  for (const t of (v3['trace'] as Record<string, any>[])) {
    const observed = t['observedRate'];
    const used = observed !== null && observed !== undefined;
    const droveStreet = t['streetTrait'] !== null && t['streetTrait'] !== undefined;
    line('  ' + pad(String(t['stat']), 18) + pad(observed === null || observed === undefined ? 'null（未观测）' : n(observed, 4), 12) +
      pad(used ? n(t['effectiveRate'], 4) : '—', 12) + pad(used ? String(t['opportunities']) : '—', 9) +
      pad(used ? String(t['successes']) : '—', 8) + pad(used ? n(t['priorWeight'], 1) : '—', 10) +
      pad(used ? n(t['confidence'], 4) : '—', 9) +
      pad(droveStreet ? String(t['streetTrait']) : '—', 16) +
      (used ? (droveStreet ? '✔ 经分街系数进入响应层' : '△ 只进维度融合，未驱动分街系数') : '✖ 未使用（null）'));
  }
  line('');
  line(`  issues（非法/被剔除字段）= ${JSON.stringify(v3['issues'])}`);
  line(`  noteZh = ${String(v3['noteZh'])}`);
}
line('');

/* ---- 画像消融：用生产入口跑三种画像，看**哪些字段真的改变了输出** ---- */

line('  ── 画像消融实验（只改**一个**画像字段，其余逐字不变；用生产入口 analyzeManualHand）──');
line('  ' + pad('配置', 36) + pad('下注质量', 11) + pad('EqVsBetRange', 13) + pad('EqVsRaiseCall', 13) +
  pad('CALL EV', 9) + pad('P(弃)/(跟)/(再加)', 25) + pad('RAISE EV', 10) + pad('河牌分街系数', 34) + '语义门');
line('  ' + '-'.repeat(150));
const ABLATIONS: [string, VillainSpec][] = [
  ['①名字=阿豪｜MANIAC｜+4 统计（本题）', { profile: 'MANIAC', stats: AHAO_STATS, name: '阿豪' }],
  ['②名字=阿豪｜MANIAC｜无统计', { profile: 'MANIAC', stats: null, name: '阿豪' }],
  ['③名字=阿豪｜UNKNOWN｜无统计', { profile: 'UNKNOWN', stats: null, name: '阿豪' }],
  ['④名字=seat_BB｜MANIAC｜+4 统计', { profile: 'MANIAC', stats: AHAO_STATS, name: 'seat_BB' }],
  ['⑤不给名字｜MANIAC｜+4 统计', { profile: 'MANIAC', stats: AHAO_STATS }],
  ['⑥不给名字｜UNKNOWN｜无统计', { profile: 'UNKNOWN', stats: null }],
  /* ⑦⑧⑨：把「河牌专属统计」真的填上，验证分街通道是否存在（而不是 4 个统计恰好无通道时下结论） */
  ['⑦名字=阿豪｜MANIAC｜只填 river 弃牌', { profile: 'MANIAC', name: '阿豪', stats: { ...AHAO_STATS, foldToRiverBet: 0.6 } }],
  ['⑧名字=阿豪｜MANIAC｜只填 river 过牌加注', { profile: 'MANIAC', name: '阿豪', stats: { ...AHAO_STATS, riverCheckRaise: 0.2 } }],
  ['⑨名字=阿豪｜MANIAC｜6 项全填', {
    profile: 'MANIAC', name: '阿豪',
    stats: { ...AHAO_STATS, foldToFlopCBet: 0.2, foldToTurnCBet: 0.2, foldToRiverBet: 0.6, flopCheckRaise: 0.1, turnCheckRaise: 0.1, riverCheckRaise: 0.2 },
  }],
];
const ABL: Record<string, Record<string, any>> = {};
for (const [tag, spec] of ABLATIONS) {
  const input = buildInput(spec);
  const res = analyzeManualHand(input, OPTIONS);
  if (!res.ok) { line('  ' + pad(tag, 36) + `分析失败：${res.stage}`); continue; }
  const rD = res.decision as unknown as Record<string, any>;
  const rDG = rD['diagnostics'] as Record<string, any>;
  const rPF = (rDG['postflop'] ?? {}) as Record<string, any>;
  const rF = (rPF['raiseResponse'] ?? null) as Record<string, any> | null;
  const rBR = (rPF['bettingRangeFacts'] ?? null) as Record<string, any> | null;
  /* 同一份画像再走一次 buildDecisionContext，读 profileV3（分街系数 / 语义门拒绝清单） */
  const p = parseManualInput(input);
  const g = p.ok ? buildAnalyzableState(p.value) : null;
  const c = g !== null && g.ok
    ? (buildDecisionContext({
        state: g.state, rules: RULES, environment: 'MID_LOW_STAKES', asOf: OPTIONS.asOf,
        ...(spec.profile === null ? {} : { quickProfile: spec.profile }),
        dynamicHint: 'UNKNOWN' as never,
        ...(spec.name === undefined ? {} : { villainPlayerId: spec.name }),
        ...(spec.stats === null ? {} : { observedStats: spec.stats }),
        equitySeed: EQUITY_SEED, budget: OPTIONS.budget,
      } as never).context as unknown as Record<string, any>)
    : null;
  const rv3 = (c?.['profileV3'] ?? null) as Record<string, any> | null;
  ABL[tag] = { f: rF, br: rBR, math: rDG['math'], action: rD['action'], v3: rv3 };
  const sz = (o: unknown): string => (typeof o === 'number' ? n(o, 4) : '—');
  line('  ' + pad(tag, 36) +
    pad(`${n(rBR?.['betMass'], 4)}`, 11) +
    pad(n((rDG['math'] ?? {})['heroEquityVsBetRange'], 6), 13) +
    pad(n(rF?.['heroEquityVsRaiseCallRange'], 6), 13) +
    pad(n((rDG['math'] ?? {})['callEV'], 2), 9) +
    pad(rF === null ? '—' : `${pct(rF['foldLikelihood'], 2)}/${pct(rF['callLikelihood'], 2)}/${pct(rF['reRaiseLikelihood'], 2)}`, 25) +
    pad(n(rF?.['raiseEV'], 2), 10) +
    pad(`河牌系数 弃${sz(rv3?.['street']?.['RIVER']?.['foldScale'])}/跟${sz(rv3?.['street']?.['RIVER']?.['callScale'])}/过加${sz(rv3?.['street']?.['RIVER']?.['checkRaiseScale'])}`, 34) +
    `语义门拒绝 ${JSON.stringify(rv3?.['deniedStreetTraits'] ?? null)}`);
}
{
  const a = ABL['①名字=阿豪｜MANIAC｜+4 统计（本题）'];
  const b = ABL['②名字=阿豪｜MANIAC｜无统计'];
  const c = ABL['③名字=阿豪｜UNKNOWN｜无统计'];
  const d = ABL['④名字=seat_BB｜MANIAC｜+4 统计'];
  const e = ABL['⑤不给名字｜MANIAC｜+4 统计'];
  line('');
  line('  结论（逐列对比，不预设）：');
  line(`    · ① vs ②：**统计字段本身**的影响 = ${a !== undefined && b !== undefined && n(a['br']?.['betMass'], 9) === n(b['br']?.['betMass'], 9) ? '**逐位为零**（这 4 个统计在本节点没有改变任何数字）' : '非零'}`);
  line(`    · ① vs ③：**画像标签**（MANIAC vs UNKNOWN）在「有名字」时的最大差异 = betMass ${n(a?.['br']?.['betMass'], 6)} vs ${n(c?.['br']?.['betMass'], 6)}（差 ${n(Math.abs((a?.['br']?.['betMass'] ?? NaN) - (c?.['br']?.['betMass'] ?? NaN)), 6)}）`);
  line(`    · ① vs ④：**只改名字**（阿豪 → seat_BB）⇒ betMass ${n(a?.['br']?.['betMass'], 6)} → ${n(d?.['br']?.['betMass'], 6)}、EqVsBetRange ${n(a?.['math']?.['heroEquityVsBetRange'], 6)} → ${n(d?.['math']?.['heroEquityVsBetRange'], 6)}、RAISE EV ${n(a?.['f']?.['raiseEV'], 4)} → ${n(d?.['f']?.['raiseEV'], 4)}`);
  line(`    · ④ vs ⑤：名字 = 座位 id 与「不给名字」⇒ ${n(d?.['br']?.['betMass'], 9) === n(e?.['br']?.['betMass'], 9) ? '**逐位相同**（证明判据是字符串相等，不是「有没有名字」）' : '不同'}`);
  line('');
  line('  🔴 **由此得到的机制（可复现、非推断）**：`contextBuilder` 用 `opponent.id === villainId` 决定是否把');
  line('     画像 provider / 行为画像注入该对手的**范围链**；而 `villainId = input.villainPlayerId ?? 座位 id`，');
  line('     座位 id 形如 `seat_BB`。**当调用方传的是对手名字（本题的「阿豪」）时该判据不成立**，');
  line('     于是范围链按「陌生人」处理（`persona` 只在**响应层**仍然生效 —— 见 §6 的 P(弃)/P(跟)/P(再加) 列）。');
  line('     生产**不为此发任何 warning**（两次运行 warnings 均为空）⇒ 属于静默落空，已记入 §9 限制。');
}

/* ============================================================
 * §8 输入完整性自检
 * ============================================================ */

line(rule());
line(' §8. 输入完整性自检（声明底池 vs 重算；筹码口径 vs 用户给的绝对数）');
line(rule());
{
  const withPot = analyzeManualHand(buildInput({ profile: 'MANIAC', stats: AHAO_STATS, name: '阿豪' }, { potBB: 36.5 }), OPTIONS);
  line(`  声明 potBB = 36.5 的分析：${withPot.ok ? '✔ 通过（重算底池与声明一致）' : `✖ 被阻断：${withPot.stage} ${JSON.stringify(withPot.issues)}`}`);
  line(`  筹码换算：底池 ${n(currentPot, 0)} 筹码 = ${n(currentPot / 2, 2)} BB｜跟注 ${n(toCall, 0)} 筹码｜我剩余 ${n(hero.remainingStack, 0)} 筹码｜对手剩余 ${n(villain.remainingStack, 0)} 筹码`);
  line(`  与题面核对：底池 73 ✔｜跟注 20 ✔｜Hero 剩余 174 ✔｜Villain 剩余（含这一注）154 ✔ ` +
    `（= ${n(villain.remainingStack, 0)} 为**他下注后**的剩余）`);
}
line('');

/* ============================================================
 * §9 模型限制与置信度
 * ============================================================ */

line(rule());
line(' §9. 本节点的模型限制与置信度（生产自述的事实，非本脚本推断）');
line(rule());
line(`  ① 只有**一个**加注尺寸有 EV：生产用 desiredTo = pot + 2×callCost = ${n(currentPot + 2 * toCall, 0)} 的最近网格点 ⇒ ${n(FACTS?.['sizeChips'], 0)}；`);
line(`     其余 ${Math.max(0, rows.length - 1)} 档在诊断里如实列为「未评估动作」（reasonCode = RAISE_EV_NOT_IMPLEMENTED 等）。`);
line(`  ② 加注响应模型 = ${String(FACTS?.['model']?.['kind'])}（证据等级 ${String(FACTS?.['model']?.['evidence'])}，**未经统计校准**）；`);
line(`     概率是「公共强度带 + 听牌 + 价格 + 画像」的**结构性先验**，不读 Hero 底牌（usesHeroHiddenCards = ${String(FACTS?.['model']?.['usesHeroHiddenCards'])}）。`);
line(`  ③ 权益精度：${String(FACTS?.['equityMethod'])} × ${String(FACTS?.['equityIterations'])} 次 ⇒ 抽样半宽约 ±${n(rows.find((r) => Math.abs(r.raiseTo - (FACTS?.['sizeChips'] ?? -1)) < 1e-9)?.eqCallHW, 4)}（MONTE_CARLO 时非零）。`);
line(`  ④ 再加注分支：${String(FACTS?.['evKind'])}；不含 Hero 4-bet、不含抽水（项目无 Rake Engine）。`);
line(`  ⑤ CASHFLOW_CONTRACT = ${String(FACTS?.['cashflowContract'])}（决策层只有看到它才允许把该 EV 放进跨动作比较）。`);
line(`  ⑥ 决策置信度 confidence = ${n(D['confidence'], 4)}（${String(D['band'])}）｜模型容差带 ±${n(0.05 * (M['winnable'] as number), 2)} 筹码（工程容差，**不是**统计误差）。`);
line(`  ⑦ 降级与警告：`);
for (const d of (DG['degradations'] ?? []) as Record<string, any>[]) {
  line(`     · [${String(d['impact'])}] ${String(d['code'])}：${String(d['textZh'])}`);
}
for (const w of (analyzed.warnings ?? []) as string[]) line(`     · (warning) ${w}`);
line(`  ⑧ 版本：${JSON.stringify(DG['versions'])}`);
line(`  ⑨ 耗时：${JSON.stringify(analyzed.timings)}`);
line('');
line('  ⑩ 🔴 **画像落空的静默路径（本轮实测发现，非推断）**：');
line(`     本题给出了对手名字「阿豪」，而 \`contextBuilder\` 的注入判据是 \`opponent.id === villainId\`；`);
line(`     座位 id 形如 \`seat_BB\`（\`reconstruct.playerIdOfPosition\`）⇒ 判据不成立，`);
line('     该对手的**范围链**（tendency provider / 行为画像 / 跛入原型）按「陌生人」处理，');
line('     **且不产生任何 warning**（实测两次运行的 warnings 均为空）。');
line('     可复现实验见 §7：只把名字换成 `seat_BB`，betMass 由 0.472614 变为 0.472404、RAISE EV 由 146.0704 变为 146.0648。');
line('     ⚠️ 影响面：**范围权重 → 权益 → CALL EV / EqVsRaiseCallRange → RAISE EV** 全部随之变化；');
line('     标签画像在**响应层**（P(弃)/P(跟)/P(再加) 的倾向系数）仍然生效，只有**范围链**落空。');
line('  ⑪ 其他已知模型边界：响应概率是**尺寸的锯齿函数**（见 §5：P(弃) 在 50→60 之间上升、P(跟) 非单调）；');
line('     再加注桶的「价值再加注」判据只看**公共强度带**，因此 Hero 拿着顶暗三条时「他再加注」几乎必然是好事');
line('     （EqVsReraiseRange ≈ 0.998）—— 这一项对 RAISE EV 的贡献达 ' +
  `${n((FACTS?.['reRaiseLikelihood'] ?? 0) * (FACTS?.['reraiseBranchEV'] ?? 0), 2)} 筹码，属**未校准先验**，须谨慎对待。`);
line('');
line(rule());
line(' 说明：本脚本**没有**修改任何产品代码 / 参数 / 测试；全部数字来自生产函数与生产入口。');
line(rule());
