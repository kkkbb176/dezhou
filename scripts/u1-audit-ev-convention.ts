/**
 * ============================================================================
 * U1 加注 EV · **P0 修复后复核**（只读）
 * ============================================================================
 *
 * ## 这个脚本的来历（必须读，它是审计证据链的一部分）
 *
 * 它最初是**最小复现**：当时产品的 RAISE EV 用「扣掉对手这一注的底池 + 2×增量」当终池、
 * 并拿**对手**的增量当**我方**投入，于是与 CALL EV 不同口径。那一版脚本靠
 * 「用产品公式复算 ⇒ 与产品逐位一致」证明**不是复算者读错代码**，缺陷据此被修。
 *
 * ## 现在它验证什么（修复后的不变量 + 修复前的对照）
 *
 * ```text
 * ① 用产品公式复算   == 产品输出        （读代码没读错）
 * ② 同口径复算       == 产品输出        ★ 修复的核心断言（修复前两者相差 4~1170 筹码）
 * ③ 旧口径复算       与产品相差多少      （修复前后对照，量化「修掉了多少」）
 * ④ 价格             == villainAdd/finalPot（修复前是 increment/(扣掉他这一注的底池+2×增量)）
 * ⑤ raiseIncrement    == villainAdd      （对手要补的钱，不许混入我方投入）
 * ⑥ 终池恒等式        == currentPot + heroContestedAdd + villainAdd
 * ```
 */
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import type { ManualHandInput } from '../src/app/manualInput/manualInput.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const SEEDED = {
  rules: RULES, asOf: 1_757_000_000_000, writeLog: false,
  equitySeed: 20_261_014, budget: { softMs: 120_000, hardMs: 240_000 },
} as const;
const PLAIN = { rules: RULES, asOf: 1_757_000_000_000, writeLog: false } as const;

const line = (s = ''): void => console.log(s);
const n = (v: unknown, d = 4): string => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : '—');
const pad = (s: string, w: number): string => {
  const len = [...s].reduce((a, c) => a + (c.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
  return s + ' '.repeat(Math.max(0, w - len));
};

type Row = { position: string; type: string; amountBB?: number; street?: string };
const A = (position: string, type: string, amountBB?: number, street?: string): Row => ({
  position, type,
  ...(amountBB === undefined ? {} : { amountBB }),
  ...(street === undefined ? {} : { street }),
});

/* ---------- 节点（逐字复用既有黄金牌局） ---------- */

function riverFacingBet(heroCards: [string, string], riverBetBB = 20, profile = 'CALLING_STATION'): ManualHandInput {
  return {
    tableSize: 6, heroPosition: 'BTN', heroCards, board: ['Kd', '9c', '4h', '6s', '2d'],
    street: 'RIVER', effectiveStackBB: 100, bigBlindBB: 2,
    seatStacksBB: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 },
    actionHistory: [
      A('UTG', 'FOLD'), A('HJ', 'FOLD'), A('CO', 'FOLD'), A('BTN', 'RAISE', 3), A('SB', 'FOLD'), A('BB', 'CALL', 2),
      A('BB', 'CHECK', undefined, 'FLOP'), A('BTN', 'BET', 2.5, 'FLOP'), A('BB', 'CALL', 2.5, 'FLOP'),
      A('BB', 'CHECK', undefined, 'TURN'), A('BTN', 'BET', 7.5, 'TURN'), A('BB', 'CALL', 7.5, 'TURN'),
      A('BB', 'BET', riverBetBB, 'RIVER'),
    ],
    environment: 'MID_LOW_STAKES',
    villain: { quickProfile: profile, dynamicHint: 'UNKNOWN', stackBB: 100 },
  } as unknown as ManualHandInput;
}

function f01(): ManualHandInput {
  return {
    tableSize: 6, heroPosition: 'CO', heroCards: ['Kd', 'Kc'], board: ['Kh', '7c', '2d'],
    street: 'FLOP', effectiveStackBB: 100,
    actionHistory: [
      A('UTG', 'FOLD'), A('HJ', 'FOLD'), A('CO', 'RAISE', 3), A('BTN', 'FOLD'), A('SB', 'FOLD'), A('BB', 'CALL', 2),
      A('BB', 'BET', 6, 'FLOP'),
    ],
    environment: 'MID_LOW_STAKES', villain: { quickProfile: 'NORMAL' },
  } as unknown as ManualHandInput;
}

/** TEST 4：`scripts/rbrv2-regression-probe.ts` 的 9 人桌 HJ AA 转牌节点（低 SPR） */
function test4(): ManualHandInput {
  return {
    tableSize: 9, heroPosition: 'HJ', heroCards: ['Ac', 'Ad'],
    board: ['Ks', '8d', '4c', 'Jc'], street: 'TURN',
    effectiveStackBB: 200, seatStacksBB: { UTG: 200, HJ: 200, CO: 200 },
    actionHistory: [
      A('UTG', 'RAISE', 3), A('UTG1', 'FOLD'), A('UTG2', 'FOLD'), A('LJ', 'FOLD'),
      A('HJ', 'RAISE', 10), A('CO', 'RAISE', 26), A('BTN', 'FOLD'), A('SB', 'FOLD'), A('BB', 'FOLD'),
      A('UTG', 'FOLD'), A('HJ', 'CALL', 16),
      A('HJ', 'CHECK', undefined, 'FLOP'), A('CO', 'BET', 40, 'FLOP'), A('HJ', 'CALL', 40, 'FLOP'),
      A('HJ', 'CHECK', undefined, 'TURN'), A('CO', 'BET', 60, 'TURN'),
    ],
    environment: 'MID_LOW_STAKES', villain: { quickProfile: 'NORMAL', dynamicHint: 'UNKNOWN' },
  } as unknown as ManualHandInput;
}

function heroBetThenFacesRaise(): ManualHandInput {
  return {
    tableSize: 6, heroPosition: 'CO', heroCards: ['As', 'Ah'], board: ['Kh', '7c', '2d'],
    street: 'FLOP', effectiveStackBB: 100, bigBlindBB: 2,
    seatStacksBB: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 },
    actionHistory: [
      A('UTG', 'FOLD'), A('HJ', 'FOLD'), A('CO', 'RAISE', 3), A('BTN', 'FOLD'), A('SB', 'FOLD'), A('BB', 'CALL', 2),
      A('BB', 'CHECK', undefined, 'FLOP'), A('CO', 'BET', 5, 'FLOP'), A('BB', 'RAISE', 20, 'FLOP'),
    ],
    environment: 'MID_LOW_STAKES',
    villain: { quickProfile: 'CALLING_STATION', dynamicHint: 'UNKNOWN', stackBB: 100 },
  } as unknown as ManualHandInput;
}

/* ---------- 复核 ---------- */

type Result = {
  tag: string;
  action: string;
  productEV: number;
  oldConvEV: number;      // 修复前的口径（用于对照）
  newConvEV: number;      // 修复后的口径（= 与 CALL EV 同一套）
  reconOk: boolean;
  newConvOk: boolean;
  priceOk: boolean;
  incrementOk: boolean;
  finalPotOk: boolean;
  callEV: number;
  foldEV: number;
  band: number;
};

function audit(tag: string, input: ManualHandInput, options: typeof SEEDED | typeof PLAIN): Result | null {
  const r = analyzeManualHand(input, options);
  if (!r.ok) { line(`【${tag}】ANALYZE FAIL：${JSON.stringify(r.issues)}`); return null; }
  const d = r.decision as unknown as Record<string, any>;
  const dg = d['diagnostics'] as Record<string, any>;
  const math = dg['math'] as Record<string, any>;
  const facts = ((dg['postflop'] as Record<string, any> | undefined)?.['raiseResponse'] ?? null) as Record<string, any> | null;

  line('='.repeat(116));
  line(`【${tag}】最终动作 = ${String(d['action'])}${d['sizeChips'] == null ? '' : ` @ ${String(d['sizeChips'])}`}`);
  line('='.repeat(116));
  if (facts === null) { line('  本节点没有加注响应事实（没有加注候选 / 多人底池已拦截）⇒ 本条不适用'); return null; }

  /* ---- 产品输出的资金事实 ---- */
  const currentPot = facts['currentPot'] as number;          // 含对手这一注
  const heroAdd = facts['heroAdd'] as number;
  const heroContestedAdd = facts['heroContestedAdd'] as number;
  const villainAdd = facts['villainAdd'] as number;
  const finalPot = facts['finalPot'] as number;
  const raiseTo = facts['sizeChips'] as number;
  const f = facts['foldLikelihood'] as number;
  const c = facts['callLikelihood'] as number;
  const rr = facts['reRaiseLikelihood'] as number;
  const eq = facts['heroEquityVsRaiseCallRange'] as number;
  const productEV = facts['raiseEV'] as number;
  const price = facts['model']['priceRequiredEquity'] as number;
  const callCost = math['callCost'] as number;
  const pot = math['pot'] as number;
  const winnable = math['winnable'] as number;

  /* ---- ① 用产品公式复算（信息性：确认字段口径被读对） ---- */
  const reconOfProduct = f * currentPot + c * (eq * finalPot - heroContestedAdd) + rr * -heroContestedAdd;

  /* ---- ② 与 CALL EV **同一套口径**的独立复算（含 P1-2b 的再加注分支） ---- */
  const reraiseBranchEV = (facts['reraiseBranchEV'] ?? -heroContestedAdd) as number;
  const newConvEV = f * currentPot + c * (eq * finalPot - heroContestedAdd) + rr * reraiseBranchEV;
  /* ---- ③ 修复前的口径（用于对照：彼时终池 = 扣掉他这一注 + 2×对手增量，投入 = 对手增量） ---- */
  const betChips = callCost;                                  // 他还未跟注前的本街总额（= Hero 需跟注额，单挑下有下注时成立）
  const potBeforeBetOld = currentPot - betChips;
  const oldFinalPot = potBeforeBetOld + 2 * villainAdd;
  const oldConvEV = f * potBeforeBetOld + c * (eq * oldFinalPot - villainAdd) + rr * -villainAdd;

  /* ---- ④⑤⑥ 契约检查 ---- */
  const priceOk = Math.abs(price - villainAdd / finalPot) < 1e-12;
  const incrementOk = Math.abs((facts['raiseIncrement'] as number) - villainAdd) < 1e-12;
  const finalPotOk = Math.abs(finalPot - (currentPot + heroContestedAdd + villainAdd)) < 1e-12;
  const reconOk = Math.abs(reconOfProduct - productEV) < 1e-9;
  const newConvOk = Math.abs(newConvEV - productEV) < 1e-9;

  const eqBet = math['heroEquityVsBetRange'] as number;
  const callEVSameConv = eqBet * (pot + callCost) - callCost;   // 参照系：CALL EV 的独立复算
  const callEV = math['callEV'] as number;

  line('');
  line('  【资金事实（产品输出）】');
  line(`    底池（含对手这一注）currentPot = ${n(currentPot, 2)}｜Hero 本街已投 = ${n(facts['heroStreetCommitted'], 2)}｜对手本街已投 = ${n(facts['villainStreetCommitted'], 2)}`);
  line(`    加注至 = ${n(raiseTo, 2)}｜我方新增 heroAdd = ${n(heroAdd, 2)}（其中留在池中 ${n(heroContestedAdd, 2)}、退回 ${n(facts['uncalledReturn'], 2)}）`);
  line(`    对手还要补 villainAdd = ${n(villainAdd, 2)}｜终池 finalPot = ${n(finalPot, 2)}`);
  line(`    P(弃)=${n(f, 4)}｜P(跟)=${n(c, 4)}｜P(再加注)=${n(rr, 4)}｜EqVsRaiseCallRange=${n(eq, 6)}`);
  /* 🔴 P1-2b：被再加注分支的完整事实（零点 = 首次加注前） */
  line(`    再加注分支：类型 ${String(facts['reraiseBranchKind'])}｜组合 ${String(facts['reRaiseCombos'])}｜` +
    `他加到 ${n(facts['reRaiseTo'], 0)}（最小合法 ${n(facts['reRaiseMinLegalTo'], 0)}，全下 ${String(facts['villainReRaiseIsAllIn'])}）｜` +
    `我需再投 ${n(facts['heroAdditionalCallVsReRaise'], 0)}｜后续终池 ${n(facts['finalPotAfterCallVsReRaise'], 0)}｜` +
    `EqVsReraise ${n(facts['heroEquityVsReraiseRange'], 6)}｜弃牌 ${n(facts['reraiseFoldBranchEV'], 2)} vs 跟注 ${n(facts['reraiseCallBranchEV'], 2)} ⇒ 取 ${n(reraiseBranchEV, 2)}` +
    `${facts['heroFourBetSupported'] === false ? '｜⚠️ 他的再加注非全下 ⇒ Hero 的反加（4-bet）**未支持**（本值为下界）' : ''}`);

  line('');
  line('  【修复前后对照】');
  line(`    修复前口径的 RAISE EV = ${n(oldConvEV, 6)}（终池 ${n(oldFinalPot, 2)} = 扣掉他这一注 ${n(potBeforeBetOld, 2)} + 2×${n(villainAdd, 2)}；投入按对手增量 ${n(villainAdd, 2)}）`);
  line(`    修复后（= 产品输出）    = ${n(productEV, 6)}｜差额 = ${n(productEV - oldConvEV, 4)} 筹码`);
  line(`    独立同口径复算          = ${n(newConvEV, 6)}｜与产品差 ${n(Math.abs(newConvEV - productEV), 12)} ${newConvOk ? '✔ 逐位一致' : '✖ 不一致'}`);
  line(`    （信息性）用产品公式复算 = ${n(reconOfProduct, 6)}｜差 ${n(Math.abs(reconOfProduct - productEV), 12)} ${reconOk ? '✔' : '✖'}`);

  line('');
  line('  【契约检查】');
  line(`    ④ 价格 = villainAdd/finalPot：${n(price, 6)} vs ${n(villainAdd / finalPot, 6)} ${priceOk ? '✔' : '✖'}` +
    `（修复前的错值会是 ${n(villainAdd / (potBeforeBetOld + 2 * villainAdd), 6)}）`);
  line(`    ⑤ raiseIncrement == villainAdd：${n(facts['raiseIncrement'], 2)} vs ${n(villainAdd, 2)} ${incrementOk ? '✔' : '✖'}`);
  line(`    ⑥ 终池 = currentPot + 我留在池中的 + 他补的：${n(finalPot, 2)} vs ${n(currentPot + heroContestedAdd + villainAdd, 2)} ${finalPotOk ? '✔' : '✖'}`);
  line(`    （参照系）CALL EV 独立复算 = ${n(callEVSameConv, 6)} vs 产品 ${n(callEV, 6)}｜差 ${n(Math.abs(callEVSameConv - callEV), 12)} ${Math.abs(callEVSameConv - callEV) < 1e-9 ? '✔ 同一口径' : '✖'}`);

  const evOf = (act: string): number => {
    const e = ((dg['actionEvidence'] ?? []) as Record<string, any>[]).find((x) => x['action'] === act);
    return e === undefined || e['ev'] === null ? Number.NaN : (e['ev'] as number);
  };
  const foldEV = evOf('FOLD');
  const evCall = evOf('CALL');
  const evRaise = evOf('RAISE');
  const band = 0.05 * winnable;
  line('');
  line(`    证据表：FOLD=${n(foldEV, 2)}｜CALL=${n(evCall, 2)}｜RAISE=${n(evRaise, 2)}｜跨动作容差带 = ±${n(band, 2)}`);
  const gap = Math.abs(evRaise - evCall);
  line(`    RAISE 与 CALL 的差距 = ${n(gap, 2)} ⇒ ${gap <= band ? '**落在容差带内（边缘决策）**' : '超出容差带（清晰结论）'}`);
  line('');

  return {
    tag, action: String(d['action']), productEV, oldConvEV, newConvEV, reconOk, newConvOk,
    priceOk, incrementOk, finalPotOk, callEV, foldEV: Number.isNaN(foldEV) ? 0 : foldEV, band,
  };
}

const results: Result[] = [];
for (const [tag, input, opt] of [
  ['HAND A · AK 河牌 vs 40（CS）', riverFacingBet(['As', 'Ks']), SEEDED],
  ['HAND B · 99 暗三条河牌 vs 40（CS）', riverFacingBet(['9s', '9h']), SEEDED],
  ['HAND C · F-01 翻牌 KK vs 6BB（NORMAL）', f01(), PLAIN],
  ['TEST 4 · AA 转牌 vs 60（低 SPR）', test4(), SEEDED],
  ['第二形态 · CO AA 翻牌先下注后被 BB 加注', heroBetThenFacesRaise(), SEEDED],
] as const) {
  const v = audit(tag, input as ManualHandInput, opt as typeof SEEDED);
  if (v !== null) results.push(v);
}

line('='.repeat(116));
line(' 汇总（修复后）');
line('='.repeat(116));
line('  ' + pad('节点', 38) + pad('产品 RAISE EV', 15) + pad('修复前口径', 15) + pad('差额', 13) +
  pad('CALL EV', 13) + '契约 ④⑤⑥ / 逐位一致 ②');
for (const v of results) {
  line('  ' + pad(v.tag, 38) + pad(n(v.productEV, 4), 15) + pad(n(v.oldConvEV, 4), 15) +
    pad(n(v.productEV - v.oldConvEV, 4), 13) + pad(n(v.callEV, 4), 13) +
    `${v.priceOk ? '✔' : '✖'}${v.incrementOk ? '✔' : '✖'}${v.finalPotOk ? '✔' : '✖'} / ${v.newConvOk ? '✔' : '✖'}`);
}
line('');
const allOk = results.every((v) => v.priceOk && v.incrementOk && v.finalPotOk && v.newConvOk);
line(`  ⇒ 全部契约检查：${allOk ? '✔ 通过（价格 / 增量 / 终池 / 同口径复算）' : '✖ 有失败项，见上表'}`);
line('  ⇒ 修复前的口径差额（产品 − 修复前口径）说明这次改动**不是零影响**：见上表「差额」列。');
line('');
line('  ⚠️ 本脚本**不修改**任何产品代码或系数：只做复算与契约检查。');
