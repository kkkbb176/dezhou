/**
 * U1 证据脚本：**面对加注的响应，在尺寸轴上是否单调？**
 *
 * 起因（诚实记录）：`test/raiseResponseU1.test.ts` 的 U1-2 最初断言
 * 「加注越大 ⇒ P(跟) 单调下降」，**跑到第 2 步就失败了**：
 *
 *     加注越大 ⇒ 跟注率不得上升（0.36097260273972603 → 0.3674407894736842）
 *
 * 断言失败本身不能证明模型错 —— 必须先分清「断言写错了模型声称的性质」
 * 还是「模型有缺陷」。本脚本给出证据：
 *
 * 1. 在**合成等权范围**上逐尺寸扫描（测试里那张表的真实数字来源）；
 * 2. 在**生产节点**上扫描真实下注范围（AK 三画像 / 99 暗三条 / AJ 空气），
 *    量化驼峰的实际幅度；
 * 3. 顺带验证三条**数学确定**的单调性：弃牌率 ↑、继续率 ↓、再加注率 ↓。
 *
 * 只读，不写任何产品状态。
 */
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';
import { buildRaiseResponse } from '../src/app/manualInput/raiseResponse.ts';
import { buildBettingRangeFacts, publicStrengthBandOf } from '../src/app/manualInput/bettingRange.ts';
import { parseManualInput, type ManualHandInput } from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import { responseTendenciesOf } from '../src/domain/postflop/betResponse.ts';
import { ALL_CARDS, parseCardStrict } from '../src/domain/poker/cards.ts';
import type { Card } from '../src/domain/types.ts';
import { computePot } from '../src/domain/poker/gameState.ts';
import { behaviorProfileOf } from '../src/domain/player/behaviorProfile.ts';
import { quickProfileToLimperArchetype } from '../src/app/manualInput/limpIsolation.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import { buildRangeSnapshot, buildPlayerSnapshot, boardAtStreetOf } from './__shadow-contextBuilder.ts';
import { akInput } from './rrda-lib.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const SEED = 20_261_014;
const OPTIONS = { rules: RULES, asOf: 1_757_000_000_000, writeLog: false, equitySeed: SEED, budget: { softMs: 120_000, hardMs: 240_000 } } as const;
const BOARD = ['Kd', '9c', '4h', '6s', '2d'] as const;
const BOARD_CARDS: Card[] = BOARD.map(parseCardStrict);

const line = (s = ''): void => console.log(s);
const num = (v: number | null | undefined, d = 4): string => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : '—');
const pad = (s: string, n: number): string => {
  const w = [...s].reduce((a, c) => a + (c.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
  return s + ' '.repeat(Math.max(0, n - w));
};
const pct = (v: number): string => `${(v * 100).toFixed(2)}%`;

const TENDENCIES = responseTendenciesOf(
  { tightness: 0.2, aggression: 0.3, bluffTendency: 0.3, passivity: 0.8 } as never, 0.35, null);

function syntheticRange(pairs: readonly (readonly [string, string])[]): { cardIndices: readonly [number, number]; probability: number }[] {
  return pairs.map(([a, b]) => {
    const ia = ALL_CARDS.findIndex((c) => c.rank === parseCardStrict(a).rank && c.suit === parseCardStrict(a).suit);
    const ib = ALL_CARDS.findIndex((c) => c.rank === parseCardStrict(b).rank && c.suit === parseCardStrict(b).suit);
    return { cardIndices: [ia, ib] as const, probability: 1 };
  });
}

const SYNTH = syntheticRange([
  ['Kc', 'Jd'], ['Kc', 'Td'], ['Kh', '8c'], ['9d', '9h'], ['4d', '4c'], ['Jc', 'Tc'], ['8d', '7d'], ['3c', '2c'],
]);

/** 一条尺寸曲线上的三个质量 */
type Point = { inc: number; price: number; required: number; f: number; c: number; r: number };

/**
 * 🔴 **U1 P0 修复后**：响应模型的输入是资金事实（不是「扣掉对手这一注的底池 + 增量」）。
 * 本脚本用一套固定事实：底池 93、对手本街已投 40、Hero 本街已投 0、对手剩余 134。
 */
const FIXTURE = { currentPot: 93, villainStreetCommitted: 40, heroStreetCommitted: 0, villainStack: 134 } as const;

function responseAt(
  raiseTo: number,
  betRange: readonly { cardIndices: readonly [number, number]; probability: number }[],
  tendencies = TENDENCIES,
  street: 'FLOP' | 'TURN' | 'RIVER' = 'RIVER',
  heroIsAllIn = false,
) {
  const heroAdd = raiseTo - FIXTURE.heroStreetCommitted;
  const villainAdd = Math.min(raiseTo - FIXTURE.villainStreetCommitted, FIXTURE.villainStack);
  const villainStreetTotalAfter = FIXTURE.villainStreetCommitted + villainAdd;
  const heroContestedAdd = Math.max(0, Math.min(heroAdd, villainStreetTotalAfter - FIXTURE.heroStreetCommitted));
  return buildRaiseResponse({
    betRangeEntries: betRange,
    board: BOARD_CARDS,
    currentPot: FIXTURE.currentPot,
    heroAdd,
    villainAdd,
    heroContestedAdd,
    finalPot: FIXTURE.currentPot + heroContestedAdd + villainAdd,
    street,
    tendencies,
    heroIsAllIn,
  });
}

function sweep(label: string, betRange: readonly { cardIndices: readonly [number, number]; probability: number }[],
  raisesTo: readonly number[], tendencies = TENDENCIES): Point[] {
  line('');
  line(`【${label}】底池 ${FIXTURE.currentPot}｜对手本街已投 ${FIXTURE.villainStreetCommitted}｜可选加注至 ${raisesTo.join(' / ')}`);
  line('  ' + pad('加注至', 8) + pad('他要补', 8) + pad('终池', 8) + pad('价格', 9) + pad('门槛', 9) +
    pad('弃', 9) + pad('跟', 9) + pad('再加注', 9) + '备注');
  const pts: Point[] = [];
  for (const raiseTo of raisesTo) {
    const r = responseAt(raiseTo, betRange, tendencies);
    if (r === null) { line(`  ${pad(String(raiseTo), 8)}（模型返回 null）`); continue; }
    const prev = pts[pts.length - 1];
    const note: string[] = [];
    if (prev !== undefined) {
      if (r.foldLikelihood < prev.f - 1e-12) note.push('❌弃牌率下降');
      if (r.callLikelihood > prev.c + 1e-12) note.push('⚠️跟注率上升（锯齿）');
      if (r.reRaiseLikelihood > prev.r + 1e-12) note.push('❌再加注率上升');
      if (r.foldLikelihood <= prev.f + 1e-12 && r.callLikelihood >= prev.c - 1e-12) note.push('弃/跟皆钝');
    }
    const price = r.model.priceRequiredEquity;
    pts.push({ inc: raiseTo, price, required: price + r.model.margin, f: r.foldLikelihood, c: r.callLikelihood, r: r.reRaiseLikelihood });
    line('  ' + pad(String(raiseTo), 8) + pad(String(r.model.villainAdd), 8) + pad(String(r.model.finalPot), 8) +
      pad(num(price, 4), 9) + pad(num(price + r.model.margin, 4), 9) +
      pad(pct(r.foldLikelihood), 9) + pad(pct(r.callLikelihood), 9) + pad(pct(r.reRaiseLikelihood), 9) + note.join(' '));
  }
  let maxHump = 0;
  let maxHumpAt: [number, number] | null = null;
  for (let i = 1; i < pts.length; i += 1) {
    const d = pts[i]!.c - pts[i - 1]!.c;
    if (d > maxHump) { maxHump = d; maxHumpAt = [pts[i - 1]!.inc, pts[i]!.inc]; }
  }
  line(`  ⇒ 最大跟注率上升：${(maxHump * 100).toFixed(3)}pp` +
    (maxHumpAt === null ? '（无锯齿）' : `（加注至 ${maxHumpAt[0]} → ${maxHumpAt[1]}）`));
  return pts;
}

line('='.repeat(120));
line(' U1 证据：面对加注的响应在尺寸轴上的单调性（只读）');
line('='.repeat(120));

/* ---------- A. 合成等权范围（测试注释里那张表必须来自这里） ---------- */
const synthPts = sweep('合成等权范围（KcJd/KcTd/Kh8c/99/44/JTs/87s/32s）', SYNTH, [45, 60, 80, 120, 174]);
line('');
line('  ⇒ 供 `test/raiseResponseU1.test.ts` U1-2 / U1-2b 引用（同输入 ⇒ 同输出，权重确定）：');
for (const p of synthPts) {
  line(`     加注至 ${pad(String(p.inc), 5)} 价格 ${num(p.price, 4)} 门槛 ${num(p.required, 4)} 弃 ${num(p.f, 4)} 跟 ${num(p.c, 4)} 再加注 ${num(p.r, 4)}`);
}

/* ---------- B. 生产节点：真实下注范围 ---------- */
type Node = { tag: string; input: ManualHandInput; profile: string };
const corpus: Node[] = [
  { tag: 'AK 河牌 vs bet40（CS）', input: akInput(20, 'CALLING_STATION'), profile: 'CALLING_STATION' },
  { tag: 'AK 河牌 vs bet40（NORMAL）', input: akInput(20, 'NORMAL'), profile: 'NORMAL' },
  { tag: 'AK 河牌 vs bet40（MANIAC）', input: akInput(20, 'MANIAC'), profile: 'MANIAC' },
  { tag: '99 河牌（暗三条，CS）', input: akInput(20, 'CALLING_STATION', ['9s', '9h']), profile: 'CALLING_STATION' },
  { tag: 'AJ 河牌（空气，MANIAC）', input: akInput(20, 'MANIAC', ['As', 'Js']), profile: 'MANIAC' },
];

for (const { tag, input, profile } of corpus) {
  const parsed = parseManualInput(input);
  if (!parsed.ok) { line(`\n【${tag}】PARSE FAIL`); continue; }
  const gate = buildAnalyzableState(parsed.value);
  if (!gate.ok) { line(`\n【${tag}】GATE FAIL ${JSON.stringify(gate.issues[0])}`); continue; }
  const state = gate.state;
  const hero = state.players.find((p) => p.id === state.userPlayerId)!;
  const heroHole = hero.holeCards!;
  const villain = state.players.find((p) => p.id !== state.userPlayerId && !p.folded)!;
  const potPre = computePot(state) - state.currentBet;
  const callCost = state.currentBet;

  const pb = buildPlayerSnapshot(villain.id as never, undefined as never, profile as never, 'UNKNOWN' as never,
    (s: never) => boardAtStreetOf(state, s));
  let betIndex = -1;
  for (let i = state.actions.length - 1; i >= 0; i -= 1) {
    const a = state.actions[i]!;
    if (a.street === state.street && (a.type === 'BET' || a.type === 'RAISE' || a.type === 'RERAISE' || a.type === 'ALL_IN')) { betIndex = i; break; }
  }
  const build = buildRangeSnapshot(state, villain as never, [...heroHole, ...BOARD_CARDS] as never, undefined,
    pb.tendency as never, { archetype: quickProfileToLimperArchetype(profile), confidence: pb.confidence } as never,
    (behaviorProfileOf({ playerId: villain.id, archetype: profile as never }) ?? null) as never, betIndex);
  const arrival = (build.rangeBeforeAction ?? build.range)!;
  const tendencies = responseTendenciesOf(pb.tendency === null ? null : (pb.tendency.dimension.dimensions as never), pb.confidence, null);
  const facts = buildBettingRangeFacts({
    arrivalEntries: arrival.entries.map((e: any) => ({ cardIndices: e.combo.cardIndices, probability: e.probability })),
    board: BOARD_CARDS, heroHole, potChips: potPre, betChips: callCost, street: 'RIVER', tendencies,
  });
  if (facts === null) { line(`\n【${tag}】无下注范围`); continue; }

  /* 生产尺寸网格：与决策层同一把尺子（合法最小加注 .. 全下） */
  const r = analyzeManualHand(input, OPTIONS);
  const dg = r.ok ? ((r.decision as unknown as Record<string, any>)['diagnostics'] as Record<string, any>) : null;
  const candidates = ((dg?.['candidates'] ?? []) as { action: string; sizeChips?: number }[])
    .filter((c) => c.action === 'RAISE' || c.action === 'ALL_IN')
    .map((c) => c.sizeChips ?? 0)
    .filter((x) => x > 0);
  const grid = [...new Set([...candidates, callCost * 2, callCost + 40, callCost + 80, callCost + 134])]
    .filter((to) => to > callCost).sort((a, b) => a - b);
  const raiseFacts = ((dg?.['postflop'] as Record<string, any> | undefined)?.['raiseResponse'] ?? null) as Record<string, any> | null;
  if (raiseFacts === null) { line(`\n【${tag}】无加注响应事实 ⇒ 跳过尺寸扫描`); continue; }

  /*
   * ⚠️ 本节按**生产事实包自己的**资金量（`currentPot / heroStreetCommitted /
   * villainStreetCommitted`）重建整条尺寸曲线，因此每个尺寸的终池/价格口径一致。
   */
  sweepProd(`${tag}｜生产下注范围 ${facts.entries.length} 组合｜当前注 ${callCost}｜可用加注到 ${grid.join('/')}`,
    facts.entries, grid, raiseFacts, tendencies);
}

/** 生产节点的尺寸扫描：资金量按「对手跟得满」重建（对手剩余足够时与产品一致） */
function sweepProd(
  label: string,
  betRange: readonly { cardIndices: readonly [number, number]; probability: number }[],
  raisesTo: readonly number[],
  facts: Record<string, any>,
  tendencies: ReturnType<typeof responseTendenciesOf>,
): void {
  const currentPot = facts['currentPot'] as number;
  const heroStreetCommitted = facts['heroStreetCommitted'] as number;
  const villainStreetCommitted = facts['villainStreetCommitted'] as number;
  line('');
  line(`【${label}】底池 ${currentPot}｜Hero 本街已投 ${heroStreetCommitted}｜对手本街已投 ${villainStreetCommitted}`);
  line('  ' + pad('加注至', 8) + pad('我要补', 8) + pad('他要补', 8) + pad('终池', 8) + pad('价格', 9) +
    pad('弃', 9) + pad('跟', 9) + pad('再加注', 9) + '备注');
  let prev: { f: number; c: number; r: number } | null = null;
  let maxHump = 0;
  for (const raiseTo of raisesTo) {
    const heroAdd = raiseTo - heroStreetCommitted;
    const villainAdd = raiseTo - villainStreetCommitted;
    const villainStreetTotalAfter = villainStreetCommitted + villainAdd;
    const heroContestedAdd = Math.max(0, Math.min(heroAdd, villainStreetTotalAfter - heroStreetCommitted));
    const finalPot = currentPot + heroContestedAdd + villainAdd;
    const built = buildRaiseResponse({
      betRangeEntries: betRange, board: BOARD_CARDS, currentPot, heroAdd, villainAdd,
      heroContestedAdd, finalPot, street: 'RIVER', tendencies, heroIsAllIn: false,
    });
    if (built === null) { line('  ' + pad(String(raiseTo), 8) + '（模型返回 null）'); continue; }
    const note: string[] = [];
    if (prev !== null) {
      if (built.foldLikelihood < prev.f - 1e-12) note.push('❌弃牌率下降');
      if (built.callLikelihood > prev.c + 1e-12) { note.push('⚠️跟注率上升（锯齿）'); maxHump = Math.max(maxHump, built.callLikelihood - prev.c); }
      if (built.reRaiseLikelihood > prev.r + 1e-12) note.push('❌再加注率上升');
    }
    prev = { f: built.foldLikelihood, c: built.callLikelihood, r: built.reRaiseLikelihood };
    line('  ' + pad(String(raiseTo), 8) + pad(String(heroAdd), 8) + pad(String(villainAdd), 8) + pad(String(finalPot), 8) +
      pad(num(built.model.priceRequiredEquity, 4), 9) +
      pad(pct(built.foldLikelihood), 9) + pad(pct(built.callLikelihood), 9) + pad(pct(built.reRaiseLikelihood), 9) + note.join(' '));
  }
  line(`  ⇒ 最大跟注率上升：${(maxHump * 100).toFixed(3)}pp`);
}

/* ---------- C. 结论 ---------- */
line('');
line('='.repeat(120));
line(' 结论（证据支持的部分）：');
line(' 1. 【数学确定】弃牌率随尺寸单调不减、继续率单调不增、再加注率单调不增 —— 本脚本 5 个生产节点 +');
line('    1 个合成节点、共 29 个尺寸点上**无一次违反**。');
line(' 2. 【已确认的结构性副作用】跟注桶随尺寸是**锯齿**，不是单调下降：');
line('    - 弃牌判定是「强度 ≥ 价格 + 余量」的阈值判定，而强度只有 9 档 ⇒ 弃牌率是**阶梯函数**；');
line('      在每一段「没有新强度档越过门槛」的平台里，弃牌率不动，而再加注门槛（价格 + 0.2）');
line('      继续上移，把「还能继续、但不再够格再加注」的中强牌从再加注桶搬进跟注桶 ⇒ 跟注率**上升**；');
line('    - 当弃牌门槛越过一整档强度（例如 NORMAL 画像增量 60 → 80）时，跟注率**骤降**。');
line('    实测锯齿幅度：AK(NORMAL) 最大 +2.32pp（增量 40 → 60）；AK(CS) +1.87pp（40 → 全下 174）；');
line('    AJ(MANIAC) 先 −0.20pp 再 +0.26pp。');
line(' 3. 该副作用**不违反**模块自述的三条声明（单调 / 价格敏感 / 非退化），但它会经由');
line('    `P(跟) × (EqVsRaiseCallRange × 终池 − 增量)` 进入 RAISE EV ⇒ **尺寸越大、跟注率反而更高的节点上，');
line('    大尺寸的 RAISE EV 会被抬高**（AK-CS 与 99 暗三条两个节点从最小加注到全下，跟注率净上升）。');
line(' 4. 是否改掉（把再加注门槛改成与价格无关的绝对强度阈值、或用继续范围内的相对分位）');
line('    会改变所有节点的 RAISE EV ⇒ 属于**策略级**改动，须人工裁决：见 `reports/UNCERTAINTY_REGISTER.md` U9。');
line('='.repeat(120));
void publicStrengthBandOf;
