/**
 * V21 画像失败模式审计 —— 随机采样噪声探针（item 15）
 *
 * 问题：在**真实的估计量**下，「画像造成的差异」与「采样噪声」哪个大？
 *
 * 做法（全部走生产入口 `analyzeManualHand`）：
 * 1. 固定画像（MANIAC / CALLING_STATION / 无），扫 `equitySeed` ⇒ 估计量对种子的敏感度；
 * 2. 同一夹具改 `budget`（宽裕 120s vs 交互默认）⇒ 估计量是否被预算切换（EXACT ↔ MONTE_CARLO）；
 * 3. 报告每个配置的 `equitySource` / 迭代数 / 输出。**结论只在同一估计量内比较**。
 *
 * 用法：node --experimental-strip-types scripts/v21-fmaudit-noise.ts
 */

import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import { parseManualInput, type ManualHandInput } from '../src/app/manualInput/manualInput.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const SEATS9 = {
  UTG: 100, UTG1: 100, UTG2: 100, LJ: 100, HJ: 100,
  CO: 100, BTN: 100, SB: 100, BB: 100,
} as const;

function golden(quickProfile?: string): ManualHandInput {
  return {
    tableSize: 9,
    heroPosition: 'CO',
    heroCards: ['Ac', 'Jh'],
    board: ['Ad', '8s', '4s', '2c', 'Kd'],
    street: 'RIVER',
    effectiveStackBB: 100,
    bigBlindBB: 2,
    seatStacksBB: { ...SEATS9 },
    actionHistory: [
      { position: 'UTG', type: 'FOLD' }, { position: 'UTG1', type: 'FOLD' },
      { position: 'UTG2', type: 'FOLD' }, { position: 'LJ', type: 'FOLD' },
      { position: 'HJ', type: 'FOLD' }, { position: 'CO', type: 'RAISE', amountBB: 2.5 },
      { position: 'BTN', type: 'FOLD' }, { position: 'SB', type: 'FOLD' },
      { position: 'BB', type: 'CALL', amountBB: 1.5 },
      { position: 'BB', type: 'CHECK', street: 'FLOP' },
      { position: 'CO', type: 'BET', amountBB: 2, street: 'FLOP' },
      { position: 'BB', type: 'CALL', amountBB: 2, street: 'FLOP' },
      { position: 'BB', type: 'CHECK', street: 'TURN' },
      { position: 'CO', type: 'CHECK', street: 'TURN' },
      { position: 'BB', type: 'BET', amountBB: 7, street: 'RIVER' },
    ],
    environment: 'MID_LOW_STAKES',
    villain: {
      dynamicHint: 'UNKNOWN',
      stackBB: 100,
      ...(quickProfile === undefined ? {} : { quickProfile }),
    },
  } as unknown as ManualHandInput;
}

type Res = {
  seed: number;
  ok: boolean;
  action: string;
  equity: number | null;
  callEV: number | null;
  equitySource: string;
  iterations: number | null;
  masses: number | null;
};

function run(label: string, input: ManualHandInput, seed: number, budget?: { softMs: number; hardMs: number }): Res {
  const r = analyzeManualHand(input, {
    rules: RULES,
    asOf: 1_757_000_000_000,
    writeLog: false,
    equitySeed: seed,
    ...(budget === undefined ? {} : { budget }),
  });
  if (!r.ok) return { seed, ok: false, action: '-', equity: null, callEV: null, equitySource: '-', iterations: null, masses: null };
  const post = r.decision.diagnostics.postflop as unknown as { rangeCounts?: { reachableRangeCount?: number } } | undefined;
  const m = r.decision.diagnostics.math as unknown as {
    heroEquity?: number | null;
    callEV?: number | null;
    heroEquitySource?: string;
    equitySource?: string;
    heroEquityIterations?: number | null;
  };
  const parsed = parseManualInput(input);
  let masses: number | null = null;
  if (parsed.ok) {
    const gate = buildAnalyzableState(parsed.value);
    if (gate.ok) {
      const built = buildDecisionContext({
        state: gate.state,
        rules: RULES,
        environment: 'MID_LOW_STAKES',
        asOf: 1_757_000_000_000,
        budget: budget ?? { softMs: 120_000, hardMs: 240_000 },
        equitySeed: seed,
        ...(parsed.value.villain.quickProfile === undefined ? {} : { quickProfile: parsed.value.villain.quickProfile }),
      });
      const pc = (built.context.postflopFacts?.opponentRangeFacts as unknown as
        | { profileClassMasses?: { bluffMass?: number } }
        | undefined)?.profileClassMasses;
      masses = pc?.bluffMass ?? null;
    }
  }
  void label;
  void post;
  return {
    seed,
    ok: true,
    action: String(r.decision.action),
    equity: m.heroEquity ?? null,
    callEV: m.callEV ?? null,
    equitySource: m.heroEquitySource ?? m.equitySource ?? '(未导出)',
    iterations: m.heroEquityIterations ?? null,
    masses,
  };
}

const SEEDS = [1, 2, 3, 42, 1234, 20260913, 999_999_999];
const WIDE = { softMs: 120_000, hardMs: 240_000 };

function sweep(title: string, input: ManualHandInput, budget?: { softMs: number; hardMs: number }): void {
  console.log(`\n===== ${title}${budget === undefined ? '（交互默认预算）' : '（宽裕预算 120s）'} =====`);
  const rows = SEEDS.map((s) => run(title, input, s, budget));
  const eqs = rows.map((r) => r.equity).filter((x): x is number => x !== null);
  const min = Math.min(...eqs);
  const max = Math.max(...eqs);
  for (const r of rows) {
    console.log(
      `  seed=${String(r.seed).padStart(10)} ok=${r.ok} 动作=${r.action.padEnd(5)} 权益=${r.equity === null ? '—' : r.equity.toFixed(6)} ` +
        `callEV=${r.callEV === null ? '—' : r.callEV.toFixed(4)} 来源=${r.equitySource} 迭代=${String(r.iterations)} 诈唬质量=${r.masses === null ? '—' : r.masses.toFixed(6)}`,
    );
  }
  console.log(`  ⇒ 极差 = ${((max - min) * 100).toFixed(4)}pp（min ${(min * 100).toFixed(4)}% / max ${(max * 100).toFixed(4)}%）`);
  const acts = new Set(rows.map((r) => r.action));
  console.log(`  ⇒ 动作集合 = {${[...acts].join(',')}}`);
  const mass = rows.map((r) => r.masses).filter((x): x is number => x !== null);
  if (mass.length > 0) console.log(`  ⇒ 诈唬质量极差 = ${((Math.max(...mass) - Math.min(...mass)) * 100).toFixed(6)}pp`);
}

console.log('\n\n########## 我方主动下注节点（翻牌）的响应模型噪声 ##########');
{
  // Hero CO A♣J♥，翻牌 A♦8♠4♠，BB 过牌 → 我可能下注 ⇒ 走 betDecision（3 尺寸 × 2 桶 = 6 次权益）
  const flop = (quickProfile?: string): ManualHandInput =>
    ({
      tableSize: 9,
      heroPosition: 'CO',
      heroCards: ['Ac', 'Jh'],
      board: ['Ad', '8s', '4s'],
      street: 'FLOP',
      effectiveStackBB: 100,
      bigBlindBB: 2,
      seatStacksBB: { ...SEATS9 },
      actionHistory: [
        { position: 'UTG', type: 'FOLD' }, { position: 'UTG1', type: 'FOLD' },
        { position: 'UTG2', type: 'FOLD' }, { position: 'LJ', type: 'FOLD' },
        { position: 'HJ', type: 'FOLD' }, { position: 'CO', type: 'RAISE', amountBB: 2.5 },
        { position: 'BTN', type: 'FOLD' }, { position: 'SB', type: 'FOLD' },
        { position: 'BB', type: 'CALL', amountBB: 1.5 },
        { position: 'BB', type: 'CHECK', street: 'FLOP' },
      ],
      environment: 'MID_LOW_STAKES',
      villain: { dynamicHint: 'UNKNOWN', stackBB: 100, ...(quickProfile === undefined ? {} : { quickProfile }) },
    }) as unknown as ManualHandInput;

  for (const quick of [undefined, 'MANIAC'] as const) {
    console.log(`\n[${quick ?? '无画像'}] 各尺寸的响应模型输出（逐 seed）：`);
    for (const seed of [1, 2, 20260913, 777, 999_999_999]) {
      const r = analyzeManualHand(flop(quick), {
        rules: RULES,
        asOf: 1_757_000_000_000,
        writeLog: false,
        equitySeed: seed,
        budget: WIDE,
      });
      if (!r.ok) {
        console.log(`  seed=${seed} FAILED ${JSON.stringify(r.issues)}`);
        continue;
      }
      const post = r.decision.diagnostics.postflop as unknown as {
        betDecision?: {
          bestSize?: string | null;
          checkEV?: number | null;
          sizes?: readonly Record<string, unknown>[];
        };
      };
      const bd = post.betDecision;
      const es = r.decision.diagnostics.math as unknown as { equitySource?: unknown; heroEquity?: number };
      console.log(
        `  seed=${String(seed).padStart(9)} 权益=${String(es.heroEquity)} 估计=${JSON.stringify(es.equitySource)} 最优=${String(bd?.bestSize)} checkEV=${String(bd?.checkEV)}`,
      );
      for (const s of bd?.sizes ?? []) {
        console.log(
          `      ${String(s['labelZh']).padEnd(12)} ratio=${String(s['ratioToPot'])} ` +
            `折=${String(s['foldLikelihood'])} 跟=${String(s['callLikelihood'])} 加=${String(s['raiseLikelihood'])} ` +
            `权益=${String(s['equity'])} 迭代=${String(s['equityIterations'])} EV=${String(s['ev'])}`,
        );
      }
    }
  }
}

console.log('\n\n########## 估计量来源字段与响应模型（betDecision）的种子敏感度 ##########');
{
  // 直接打印与权益估计量有关的诊断字段（含迭代数/方法），确认是不是蒙特卡洛
  for (const quick of [undefined, 'MANIAC'] as const) {
    const r = analyzeManualHand(golden(quick), {
      rules: RULES,
      asOf: 1_757_000_000_000,
      writeLog: false,
      equitySeed: 20260913,
      budget: WIDE,
    });
    if (!r.ok) {
      console.log('FAILED', JSON.stringify(r.issues));
      continue;
    }
    const m = r.decision.diagnostics.math as unknown as Record<string, unknown>;
    const keys = Object.keys(m).filter((k) => /equity|iter|method|source|sample|confidence/i.test(k));
    console.log(`\n[${quick ?? '无画像'}] math 中与权益相关的字段：`);
    for (const k of keys) console.log(`  ${k} = ${JSON.stringify(m[k])}`);
    const post = r.decision.diagnostics.postflop as unknown as Record<string, unknown> | undefined;
    if (post) {
      console.log(`  postflop.uncertaintyBandChips = ${JSON.stringify(post['uncertaintyBandChips'])}`);
      const bd = post['betDecision'] as { sizes?: readonly Record<string, unknown>[]; checkEV?: number } | undefined;
      if (bd?.sizes) {
        for (const s of bd.sizes) {
          console.log(
            `  betDecision.size ${String(s['labelZh'])}: ratio=${String(s['ratioToPot'])} equity=${JSON.stringify(s['equity'])} ` +
              `iterations=${JSON.stringify(s['equityIterations'])} ev=${JSON.stringify(s['ev'])}`,
          );
        }
      }
    }
  }
  console.log('\n响应模型 6 次权益的种子敏感度（河牌抓诈唬节点，betDecision 供参考）：');
  for (const seed of [1, 20260913, 777]) {
    const r = analyzeManualHand(golden('MANIAC'), {
      rules: RULES,
      asOf: 1_757_000_000_000,
      writeLog: false,
      equitySeed: seed,
      budget: WIDE,
    });
    if (!r.ok) continue;
    const post = r.decision.diagnostics.postflop as unknown as {
      betDecision?: { sizes?: readonly Record<string, unknown>[] };
      uncertaintyBandChips?: number;
    };
    const sizes = post.betDecision?.sizes ?? [];
    console.log(
      `  seed=${String(seed).padStart(9)} band=${JSON.stringify(post.uncertaintyBandChips)} ` +
        sizes
          .map((s) => `${String(s['labelZh'])}:eq=${String(s['equity'])}/ev=${String(s['ev'])}`)
          .join('  '),
    );
  }
}

sweep('无画像', golden(), WIDE);
sweep('MANIAC', golden('MANIAC'), WIDE);
sweep('CALLING_STATION', golden('CALLING_STATION'), WIDE);
sweep('无画像', golden());
sweep('MANIAC', golden('MANIAC'));
sweep('CALLING_STATION', golden('CALLING_STATION'));
