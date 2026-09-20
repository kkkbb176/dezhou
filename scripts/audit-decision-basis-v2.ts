/**
 * DECISION BASIS CONSISTENCY V1 · 二次探针（只读）
 *
 * 专攻三件事：
 *  ① 场景 E：两个候选**金额相同、标签不同**（尺寸网格封顶 == 全下）⇒ 是否去重、决策用哪一份；
 *  ② 场景 B：最高 EV 动作 ≠ 最高偏好分动作（分析上只可能由 `clamp01` 饱和造成）⇒ 扫栈深找出实例；
 *  ③ 披露：`betDecision.bestSize`（下注族最高分尺寸）与 `preferredAction`（含过牌后的最终建议）
 *     在同一局面下是否可能不同 —— 界面文案「最佳 = …」是否会被误读成最终建议。
 */
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';

const OPTIONS = {
  rules: loadKnowledgeBaseOrThrow().allRules(),
  asOf: 1_757_000_000_000,
  writeLog: false,
  equitySeed: 20_260_913,
  budget: { softMs: 120_000, hardMs: 240_000 },
} as const;

const BB = 50;
const INVESTED = 48;
const HISTORY = [
  { position: 'UTG', type: 'FOLD' }, { position: 'UTG1', type: 'FOLD' }, { position: 'UTG2', type: 'FOLD' },
  { position: 'LJ', type: 'FOLD' }, { position: 'HJ', type: 'FOLD' },
  { position: 'CO', type: 'CALL', amountBB: 1 }, { position: 'BTN', type: 'RAISE', amountBB: 3 },
  { position: 'SB', type: 'FOLD' }, { position: 'BB', type: 'FOLD' }, { position: 'CO', type: 'CALL', amountBB: 2 },
  { position: 'CO', type: 'CHECK', street: 'FLOP' }, { position: 'BTN', type: 'BET', amountBB: 10, street: 'FLOP' },
  { position: 'CO', type: 'CALL', amountBB: 10, street: 'FLOP' },
  { position: 'CO', type: 'CHECK', street: 'TURN' }, { position: 'BTN', type: 'BET', amountBB: 35, street: 'TURN' },
  { position: 'CO', type: 'CALL', amountBB: 35, street: 'TURN' },
  { position: 'CO', type: 'CHECK', street: 'RIVER' },
];

type Diag = Record<string, any>;

function run(hole: readonly string[], startStackBB: number, profile: string) {
  const input = {
    tableSize: 9,
    heroPosition: 'BTN',
    heroCards: [...hole],
    board: ['Jh', '8s', 'Qs', 'Kh', 'Kd'],
    street: 'RIVER',
    effectiveStackBB: startStackBB - INVESTED,
    bigBlindBB: BB,
    seatStacksBB: {
      UTG: startStackBB, UTG1: 100, UTG2: 100, LJ: 100, HJ: 100,
      CO: startStackBB, BTN: startStackBB, SB: 100, BB: 100,
    },
    actionHistory: HISTORY,
    environment: 'MID_LOW_STAKES',
    villain: { quickProfile: profile, dynamicHint: 'UNKNOWN', stackBB: startStackBB - INVESTED },
  };
  const result = analyzeManualHand(input as never, OPTIONS);
  if (!result.ok) return { ok: false as const, why: `${result.stage}: ${result.issues.map((i) => i.message).join(' / ')}` };
  const decision = result.decision as unknown as Diag;
  const dg = decision['diagnostics'] as Diag;
  const bd = (dg['betDecision'] ?? null) as Diag | null;
  const shape = (dg['actionShape'] ?? {}) as Diag;
  return { ok: true as const, decision, dg, bd, shape };
}

/* ============================================================
 * ① 栈深扫描：找「同金额、不同标签」与「bestSize ≠ preferredAction」
 * ============================================================ */

console.log('=== ① 栈深扫描（A♠K♠ / NORMAL）：金额重复、封顶、最终动作 ===');
let dupFound = 0; let cappedFound = 0; let bestNeCheck = 0;
for (let startStack = 53; startStack <= 168; startStack += 5) {
  const r = run(['As', 'Ks'], startStack, 'NORMAL');
  if (!r.ok) { console.log(`  stack=${startStack}BB ⇒ ${r.why}`); continue; }
  const sizes = (r.bd?.['sizes'] ?? []) as readonly Diag[];
  const dropped = (r.bd?.['droppedSizes'] ?? []) as readonly Diag[];
  const amounts = sizes.map((s) => Number(s['betAmount']));
  const dups = amounts.filter((a, i) => amounts.indexOf(a) !== i);
  const basis = (r.dg['decisionBasis'] ?? {}) as Diag;
  const preferred = r.bd?.['preferredAction'];
  const best = r.bd?.['bestSize'];
  const isAllInBet = r.shape['consumesStack'] === true;
  const mismatch = best !== null && preferred !== best;
  if (dups.length > 0) dupFound += 1;
  if (dropped.length > 0) cappedFound += 1;
  if (mismatch) bestNeCheck += 1;
  if (dups.length > 0 || dropped.length > 0 || mismatch || startStack % 20 === 3) {
    console.log(
      `  stack=${startStack}BB 剩余=${String(r.shape['allInToAmount'])} ⇒ ` +
      `sizes=[${sizes.map((s) => `${String(s['kind'])}@${Number(s['betAmount']).toFixed(0)}S${Number(s['score']).toFixed(3)}cap=${String(s['wasCapped'])}allin=${String(s['heroIsAllIn'])}`).join(' | ')}] ` +
      `dup=${JSON.stringify(dups)} dropped=${JSON.stringify(dropped.map((d) => `${String(d['requestedKind'])}@${String(d['requestedAmount'])}→${String(d['legalAmount'])}：${String(d['reasonZh'])}`))}\n` +
      `      bestSize=${String(best)} preferredAction=${String(preferred)} ⇒ action=${String(r.decision['action'])} size=${String(r.shape['sizeChips'])} consumesStack=${String(isAllInBet)} basis=${String(basis['kind'])}`,
    );
  }
}
console.log(`  小计：金额重复局面=${dupFound}｜发生过封顶去重=${cappedFound}｜bestSize≠preferredAction=${bestNeCheck}`);

/* ============================================================
 * ② 单调性 / 钳位饱和的实例搜索（最高 EV 与最高分不同）
 * ============================================================ */

console.log('=== ② 最高 EV ≠ 最高分 的实例搜索（ΔEV/pot 比越大越可能饱和）===');
let maxRatio = -Infinity; let maxLabel = ''; let disagreeFound = 0;
for (const hole of [['As', 'Ks'], ['As', 'Ts'], ['Ts', '9s'], ['Ks', 'Qs'], ['Qd', 'Jc'], ['7c', '6c']] as const) {
  for (const profile of ['CALLING_STATION', 'VERY_LOOSE', 'MANIAC', 'NORMAL', 'VERY_TIGHT']) {
    for (const startStack of [53, 103, 203, 403]) {
      const r = run(hole, startStack, profile);
      if (!r.ok) continue;
      const sizes = (r.bd?.['sizes'] ?? []) as readonly Diag[];
      if (sizes.length === 0) continue;
      const pot = Number(r.bd!['pot']);
      const checkEV = Number(r.bd!['checkEV']);
      const argmaxEV = sizes.reduce((a, b) => (Number(b['betEV']) > Number(a['betEV']) ? b : a));
      const argmaxScore = sizes.reduce((a, b) => (Number(b['score']) > Number(a['score']) ? b : a));
      const ratio = (Number(argmaxEV['betEV']) - checkEV) / pot;
      if (ratio > maxRatio) { maxRatio = ratio; maxLabel = `${hole.join('')}/${profile}/${startStack}BB：argmaxEV=${String(argmaxEV['kind'])}@${Number(argmaxEV['betAmount']).toFixed(0)} score=${Number(argmaxEV['score']).toFixed(3)}`; }
      if (argmaxEV['kind'] !== argmaxScore['kind']) {
        disagreeFound += 1;
        console.log(
          `  ✖ 不一致：${hole.join('')}/${profile}/${startStack}BB ⇒ argmaxEV=${String(argmaxEV['kind'])}@${Number(argmaxEV['betAmount']).toFixed(0)}（${Number(argmaxEV['betEV']).toFixed(1)}）` +
          ` vs argmaxScore=${String(argmaxScore['kind'])}@${Number(argmaxScore['betAmount']).toFixed(0)}（${Number(argmaxScore['score']).toFixed(3)}）；` +
          `checkEV=${checkEV.toFixed(1)} pot=${pot} Δ/pot=${ratio.toFixed(3)}`,
        );
      }
    }
  }
}
console.log(`  小计：不一致实例=${disagreeFound}；观测到的最大 ΔEV/pot = ${maxRatio.toFixed(3)}（${maxLabel}）`);
console.log('  说明：`normalizeEVScore = clamp01(0.5 + 0.5×ΔEV/pot)` 在 ΔEV ∈ (−pot, +pot) 内**严格单调**，');
console.log('        因此「最高 EV ≠ 最高分」只可能出现在钳位饱和（ΔEV ≥ pot ⇒ score=1；ΔEV ≤ −pot ⇒ score=0）时。');

/* ============================================================
 * ③ 披露检查：bestSize（下注族最高分）vs preferredAction（含过牌）
 * ============================================================ */

console.log('=== ③ 披露检查：下注族最高分尺寸 ≠ 最终建议（CHECK）的局面 ===');
for (const [hole, profile] of [[['Qd', 'Jc'], 'NORMAL'], [['7c', '6c'], 'NORMAL'], [['5h', '5d'], 'NORMAL'], [['As', 'Ks'], 'NORMAL']] as const) {
  const r = run(hole as readonly string[], 103, profile as string);
  if (!r.ok) continue;
  const bd = r.bd!;
  const sizes = (bd['sizes'] ?? []) as readonly Diag[];
  console.log(
    `  ${(hole as readonly string[]).join('')}：bestSize=${String(bd['bestSize'])}（下注族最高分 ${Number(bd['bestScore']).toFixed(3)}）` +
    ` preferredAction=${String(bd['preferredAction'])}（过牌基准分 ${Number(bd['checkScore']).toFixed(3)}）` +
    ` ⇒ 引擎 action=${String(r.decision['action'])}；下注族 EV=[${sizes.map((s) => `${String(s['kind'])}:${Number(s['betEV']).toFixed(1)}`).join(', ')}] checkEV=${Number(bd['checkEV']).toFixed(1)}`,
  );
}
console.log('（二次探针结束）');
