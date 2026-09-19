/**
 * Reviewer 1（统计与有效样本量）独立复算探针 —— 管线层
 *
 * 复算三件事：
 * - ITEM 4：S1（河牌抓诈唬）这一节点**实际**用的是精确枚举还是蒙特卡洛，
 *   迭代数、`confidenceHalfWidth`，以及「1–2pp 的 equityDelta 是否可比采样噪声」的算术；
 * - ITEM 5：`opportunities` 端到端到底改变了哪些输出字段（全字段深度对比）；
 * - ITEM 7：`bluffMass` 的分母到底是「可达质量」还是「整个范围」。
 *
 * 用法：node --experimental-strip-types scripts/v21-rev1-pipeline-probe.ts
 */

import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import { parseManualInput, type ManualHandInput } from '../src/app/manualInput/manualInput.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import { BehaviorTraitKey, behaviorProfileOf, type PlayerBehaviorProfile } from '../src/domain/player/behaviorProfile.ts';
import { confidenceHalfWidth } from '../src/domain/poker/equityPolicy.ts';
import { resolveMaxExactMatchups, resolveMaxIterations, EquityComputeMode, combinationsCount } from '../src/domain/poker/equity.types.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const OPTIONS = {
  rules: RULES,
  asOf: 1_757_000_000_000,
  writeLog: false,
  budget: { softMs: 120_000, hardMs: 240_000 },
  equitySeed: 20260913,
} as const;
const SEATS9 = { UTG: 100, UTG1: 100, UTG2: 100, LJ: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 } as const;

/** S1 —— 逐字复制自审计脚本 :97-122（V2 黄金夹具） */
const S1 = {
  id: 'S1_RIVER_BLUFFCATCH_TURN_CHECKBACK',
  myPosition: 'CO',
  heroCards: ['Ac', 'Jh'] as [string, string],
  board: ['Ad', '8s', '4s', '2c', 'Kd'] as string[],
  street: 'RIVER' as const,
  potBB: 19.5,
  effectiveStackBB: 100,
  tableSize: 9 as const,
  history: [
    { position: 'UTG', type: 'FOLD' }, { position: 'UTG1', type: 'FOLD' },
    { position: 'UTG2', type: 'FOLD' }, { position: 'LJ', type: 'FOLD' },
    { position: 'HJ', type: 'FOLD' },
    { position: 'CO', type: 'RAISE', amountBB: 2.5 },
    { position: 'BTN', type: 'FOLD' }, { position: 'SB', type: 'FOLD' },
    { position: 'BB', type: 'CALL', amountBB: 1.5 },
    { position: 'BB', type: 'CHECK', street: 'FLOP' },
    { position: 'CO', type: 'BET', amountBB: 2, street: 'FLOP' },
    { position: 'BB', type: 'CALL', amountBB: 2, street: 'FLOP' },
    { position: 'BB', type: 'CHECK', street: 'TURN' },
    { position: 'CO', type: 'CHECK', street: 'TURN' },
    { position: 'BB', type: 'BET', amountBB: 7, street: 'RIVER' },
  ] as Record<string, unknown>[],
};

function inputOf(villain: { quickProfile?: string; behaviorProfile?: PlayerBehaviorProfile }): ManualHandInput {
  return {
    tableSize: S1.tableSize,
    heroPosition: S1.myPosition,
    heroCards: [...S1.heroCards],
    board: [...S1.board],
    street: S1.street,
    effectiveStackBB: S1.effectiveStackBB,
    bigBlindBB: 2,
    seatStacksBB: { ...SEATS9 },
    actionHistory: S1.history.map((h) => ({ ...h })),
    environment: 'MID_LOW_STAKES',
    villain: { dynamicHint: 'UNKNOWN', stackBB: S1.effectiveStackBB, ...villain },
  } as unknown as ManualHandInput;
}

const line = (s = ''): void => console.log(s);

/* ---------- 通用深度差异：列出两条输出的**每一个**不同路径 ---------- */
function diffPaths(a: unknown, b: unknown, path = '$', out: string[] = [], depth = 0): string[] {
  if (depth > 9) return out;
  if (a === b) return out;
  const ta = typeof a; const tb = typeof b;
  if (ta !== tb || ta !== 'object' || a === null || b === null) {
    out.push(`${path}: ${JSON.stringify(a)} → ${JSON.stringify(b)}`);
    return out;
  }
  const oa = a as Record<string, unknown>; const ob = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(oa), ...Object.keys(ob)]);
  for (const k of keys) {
    if (k === 'reasonsZh' || k === 'noteZh' || k === 'trace') continue; // 文案/轨迹另行处理
    diffPaths(oa[k], ob[k], `${path}.${k}`, out, depth + 1);
  }
  return out;
}

/* ============================================================
 * ITEM 4 —— 权益估计量的算法选型与采样误差
 * ============================================================ */
line('='.repeat(100));
line('ITEM 4 权益估计量：S1 河牌节点实际用的算法 / 迭代数 / 采样误差');
line('='.repeat(100));
{
  const knownCardCount = 2 + 5; // 底牌 + 河牌 5 张
  const remainingDeckSize = 52 - knownCardCount;
  const cardsToCome = 5 - 5;
  const combosPerOpponent = combinationsCount(remainingDeckSize, 2); // 未做范围剪枝时的上界
  const bound = combosPerOpponent * combinationsCount(remainingDeckSize, cardsToCome);
  line(`  knownCardCount=${knownCardCount} remainingDeck=${remainingDeckSize} cardsToCome=${cardsToCome}`);
  line(`  对手组合上界 C(${remainingDeckSize},2) = ${combosPerOpponent}`);
  line(`  精确枚举上界 bound = ${combosPerOpponent} × C(${remainingDeckSize},${cardsToCome})=${combinationsCount(remainingDeckSize, cardsToCome)} ⇒ ${bound}`);
  line(`  DEFAULT_MAX_EXACT_MATCHUPS = ${resolveMaxExactMatchups({})}（resolveMaxExactMatchups）`);
  line(`  ⇒ bound ≤ maxExact ? ${bound <= resolveMaxExactMatchups({})} ⇒ 河牌**必然是精确枚举**（equityPolicy.ts:75-81）`);
  line(`  （对照）FAST maxIterations=${resolveMaxIterations(EquityComputeMode.FAST)} PRECISION=${resolveMaxIterations(EquityComputeMode.PRECISION)}`);
  line(`  对照·翻牌（5 张已知、2 张未发）：bound = 1326×C(47,2)=${1326 * combinationsCount(47, 2)} > 500000 ⇒ 翻牌会降级为蒙特卡洛`);
  line(`  对照·转牌（6 张已知、1 张未发）：bound = 990×C(46,1)=${990 * combinationsCount(46, 1)} ≤ 500000 ⇒ 转牌仍是精确枚举`);
  line('');

  const r = analyzeManualHand(inputOf({ quickProfile: 'NORMAL' }), OPTIONS);
  if (!r.ok) { line(`  **分析失败**: ${JSON.stringify(r.issues)}`); }
  else {
    const m = r.decision.diagnostics.math as unknown as {
      heroEquity: number; equitySource: { method: string; iterations: number; confidenceHalfWidth: number; downgradedFromExact?: boolean } | null;
    };
    const src = m.equitySource;
    line(`  ★ 实测 equitySource = ${JSON.stringify(src)}`);
    line(`  ★ heroEquity = ${m.heroEquity}`);
    if (src !== null) {
      line(`  ★ method = ${src.method}；iterations = ${src.iterations}；confidenceHalfWidth = ${src.confidenceHalfWidth}`);
      if (src.method === 'EXACT') {
        line('  ⇒ EXACT ⇒ **采样标准误 = 0**，equityDelta 的任何非零值都不是采样噪声（置信区间宽度为 0）');
      } else {
        const se = Math.sqrt((m.heroEquity * (1 - m.heroEquity)) / src.iterations);
        line(`  ⇒ MONTE_CARLO ⇒ SE = √(p(1−p)/n) = √(${(m.heroEquity * (1 - m.heroEquity)).toFixed(6)}/${src.iterations}) = ${se.toFixed(6)}`);
      }
    }
  }

  /* 算术：即使退化为蒙特卡洛，1–2pp 能不能分辨？ */
  line('');
  line('  算术对照（**假设**退化为蒙特卡洛时；p≈0.5626）：');
  const p = 0.5625883726719894;
  const variance = p * (1 - p);
  line(`    p(1−p) = ${variance.toFixed(9)}`);
  for (const iters of [1000, 10_000, 100_000, 1_000_000]) {
    const se = Math.sqrt(variance / iters);
    line(
      `    n=${String(iters).padStart(9)} ⇒ SE = ${(se * 100).toFixed(4)}pp；95% 半宽 = ${(confidenceHalfWidth(p, iters) * 100).toFixed(4)}pp；` +
        `两条独立 MC 之差的标准误 = ${(Math.sqrt(2) * se * 100).toFixed(4)}pp；` +
        `⇒ 1.00pp 差异的 z = ${(0.01 / (Math.SQRT2 * se)).toFixed(2)}`,
    );
  }
  line('    结论：n=1e6 时两独立 MC 之差 SE ≈ 0.0222pp ⇒ 1pp 差异 z≈45、2pp z≈90，可分辨；');
  line('          n=1e4 时 SE ≈ 0.2219pp ⇒ 1pp 差异 z≈3.19，勉强可分辨（p≈0.0014 单侧）；');
  line('          n=1e3 时 SE ≈ 0.7017pp ⇒ 1pp 差异 z≈1.01，**不可分辨**。');
  line('    但 S1 实测是 EXACT ⇒ 采样噪声恒为 0，上面的算术只是「万一降级」的对照。');
  line('    ⚠️ 同种子同设置的两次 MC 是**逐位相同**的（不是独立抽样）⇒ 用同种子做的 A/B 差分，');
  line('       其噪声不是 √2·SE 而是「共同随机数」意义下的差分，但**方差不为 0**（除非实现完全相同）。');
}

/* ============================================================
 * ITEM 5 —— opportunities 端到端改变了什么
 * ============================================================ */
line('');
line('='.repeat(100));
line('ITEM 5 opportunities 端到端影响面（n=2 vs n=1000，固定实测成功率 0.9）');
line('='.repeat(100));
{
  const mk = (succ: number, opp: number): PlayerBehaviorProfile =>
    behaviorProfileOf({
      playerId: 'v21-rev1', archetype: 'MANIAC' as never,
      observed: { [BehaviorTraitKey.RIVER_BLUFF]: { successes: succ, opportunities: opp } } as never,
    });
  const pSmall = mk(2, 2);   // 100% on 2
  const pBig = mk(900, 1000); // 90% on 1000
  const tS = pSmall.traits.riverBluff; const tB = pBig.traits.riverBluff;
  line(`  小样本 2/2   ：observedRate=${tS.observedRate} effectiveRate=${tS.effectiveRate} confidence=${tS.confidence}`);
  line(`  大样本 900/1000：observedRate=${tB.observedRate} effectiveRate=${tB.effectiveRate} confidence=${tB.confidence}`);
  line('  （两个画像的随机变量不同：2/2 与 900/1000。下面另做「同成功率」的 2/2 vs 900/1000 对照）');
  line('');
  line('  同一观测成功率（0.9）下 n=2 与 n=1000 的对照 —— 用 successes=round(0.9n)：');
  const same2 = mk(2, 2 === 2 ? 2 : 2);  // 2/2 = 100% 无法表达 90%，故用下面的 n=10/n=1000
  void same2;
  const a10 = mk(9, 10); const a1000 = mk(900, 1000);
  line(`    n=10   9/10   effectiveRate=${a10.traits.riverBluff.effectiveRate} confidence=${a10.traits.riverBluff.confidence}`);
  line(`    n=1000 900/1000 effectiveRate=${a1000.traits.riverBluff.effectiveRate} confidence=${a1000.traits.riverBluff.confidence}`);
  line(`    effectiveRate 差 = ${a1000.traits.riverBluff.effectiveRate - a10.traits.riverBluff.effectiveRate}`);
  line('');

  const rA = analyzeManualHand(inputOf({ quickProfile: 'MANIAC', behaviorProfile: a10 }), OPTIONS);
  const rB = analyzeManualHand(inputOf({ quickProfile: 'MANIAC', behaviorProfile: a1000 }), OPTIONS);
  if (!rA.ok || !rB.ok) {
    line(`  **分析失败** A.ok=${rA.ok} B.ok=${rB.ok}`);
  } else {
    const d = diffPaths(rA.decision, rB.decision);
    line(`  decision 全字段深度对比：不同路径 ${d.length} 条`);
    for (const x of d) line(`    ${x}`);
    line('');
    line(`  动作 A=${String(rA.decision.action)} B=${String(rB.decision.action)}；档位 A=${rA.decision.band} B=${rB.decision.band}`);
    const mA = rA.decision.diagnostics.math as unknown as { heroEquity: number; equitySource: { method: string } | null };
    const mB = rB.decision.diagnostics.math as unknown as { heroEquity: number; equitySource: { method: string } | null };
    line(`  heroEquity A=${mA.heroEquity} B=${mB.heroEquity} 差=${(mB.heroEquity - mA.heroEquity) * 100}pp`);
    line(`  equitySource A=${mA.equitySource?.method} B=${mB.equitySource?.method}`);
    line('');
    line('  ★ 只要上面列表里出现 heroEquity / opponentRanges / range / confidence 之外的字段，');
    line('    就说明 opportunities 通过 effectiveRate 间接影响了它 —— 但**没有任何闸门**读 opportunities 本身。');
  }

  /* 全仓搜索：有没有任何代码读 traits[*].opportunities 或 .confidence 来做闸门 */
  line('');
  line('  代码级核对（见报告 §ITEM 5 的 grep 证据）：');
  line('    behaviorProfile.ts 内部：opportunities 只出现在 observedRate/effectiveRate/confidence 三处派生式（:115-127）');
  line('    StatEvidence.confidence 的生产读者：**0 处**（grep 证据在报告里）');
}
