/**
 * rt-alpha-probe9 —— 攻击 10G（HTTP vs 引擎：排除耗时字段后逐字段一致）
 *                    + 攻击 4F（启发式范围的可信度上限是否让分类失真）
 */

import { Position, Street } from '../src/domain/types.ts';
import { startAlphaServer } from '../src/app/webServer.ts';
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import type { ManualHandInput } from '../src/app/manualInput/manualInput.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();

function hr(title: string): void {
  console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
}

/** 深度比较，忽略 timing 行（耗时不可能逐位一致） */
function stripTiming(v: unknown): unknown {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(stripTiming);
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v as Record<string, unknown>)) {
    if (k === 'timing') continue;
    out[k] = stripTiming((v as Record<string, unknown>)[k]);
  }
  return out;
}

function canonical(v: unknown): string {
  const walk = (x: unknown): unknown => {
    if (x === null || typeof x !== 'object') {
      if (typeof x === 'number' && !Number.isFinite(x)) return `__n:${String(x)}`;
      return x;
    }
    if (Array.isArray(x)) return x.map(walk);
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(x as Record<string, unknown>).sort()) o[k] = walk((x as Record<string, unknown>)[k]);
    return o;
  };
  return JSON.stringify(walk(v));
}

const FLOP: ManualHandInput = {
  tableSize: 6,
  heroPosition: Position.CO,
  heroCards: ['As', 'Kd'],
  board: ['Kh', '7c', '2d'],
  street: Street.FLOP,
  effectiveStackBB: 100,
  actionHistory: [
    { position: Position.UTG, type: 'FOLD' },
    { position: Position.HJ, type: 'FOLD' },
    { position: Position.CO, type: 'RAISE', amountBB: 3 },
    { position: Position.BTN, type: 'FOLD' },
    { position: Position.SB, type: 'FOLD' },
    { position: Position.BB, type: 'CALL', amountBB: 2 },
    { position: Position.BB, type: 'CHECK', street: Street.FLOP },
  ],
  environment: 'MID_LOW_STAKES',
  villain: { quickProfile: 'NORMAL', dynamicHint: 'UNKNOWN' },
};

const RIVER: ManualHandInput = {
  ...FLOP,
  board: ['Kh', '7c', '2d', '3s', '9h'],
  street: Street.RIVER,
  actionHistory: [
    { position: Position.UTG, type: 'FOLD' },
    { position: Position.HJ, type: 'FOLD' },
    { position: Position.CO, type: 'RAISE', amountBB: 3 },
    { position: Position.BTN, type: 'FOLD' },
    { position: Position.SB, type: 'FOLD' },
    { position: Position.BB, type: 'CALL', amountBB: 2 },
    { position: Position.BB, type: 'CHECK', street: Street.FLOP },
    { position: Position.CO, type: 'CHECK', street: Street.FLOP },
    { position: Position.BB, type: 'CHECK', street: Street.TURN },
    { position: Position.CO, type: 'CHECK', street: Street.TURN },
    { position: Position.BB, type: 'BET', amountBB: 10, street: Street.RIVER },
  ],
};

async function runStrictHttpComparison(): Promise<void> {
  hr('攻击 10G：HTTP vs 引擎 —— 排除耗时字段后的严格逐字段比较');

  const server = await startAlphaServer({ port: 0, logPath: null, rules: RULES });
  console.log(`  服务器地址 = ${server.url}`);

  try {
    for (const [label, input] of [['翻牌', FLOP], ['河牌', RIVER]] as const) {
      const res = await fetch(`${server.url}/api/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input }),
      });
      const payload = (await res.json()) as Record<string, unknown>;
      const direct = analyzeManualHand(input, { rules: RULES, asOf: Date.now(), writeLog: false });

      if (!direct.ok || payload['ok'] !== true) {
        console.log(`  ${label}：一方失败`);
        continue;
      }

      const a = canonical(stripTiming(payload['viewModel']));
      const b = canonical(stripTiming(direct.viewModel));
      console.log(`  ${label}：viewModel（去耗时）逐字段一致 = ${a === b ? '✔' : '✘'}`);
      if (a !== b) {
        let i = 0;
        while (i < a.length && i < b.length && a[i] === b[i]) i++;
        console.log(`     首个不同位置 ${i}`);
        console.log(`       HTTP …${a.slice(Math.max(0, i - 100), i + 150)}`);
        console.log(`       引擎 …${b.slice(Math.max(0, i - 100), i + 150)}`);
      }

      const dec = payload['decision'] as Record<string, unknown>;
      const engineDec = {
        action: direct.decision.action,
        sizeChips: direct.decision.sizeChips ?? null,
        sizeBB: direct.decision.sizeBB ?? null,
        confidence: direct.decision.confidence,
        band: direct.decision.band,
        classification: direct.decision.classification,
        actionable: direct.decision.actionable,
      };
      console.log(`     HTTP decision  == 引擎精简 decision：${canonical(dec) === canonical(engineDec) ? '✔' : '✘'}`);
      if (canonical(dec) !== canonical(engineDec)) {
        console.log(`       HTTP = ${JSON.stringify(dec)}`);
        console.log(`       引擎 = ${JSON.stringify(engineDec)}`);
      }
    }
  } finally {
    await server.close();
  }
}

/* ============================================================
 * 攻击 4F：置信度天花板是否让「明确决策」与「中低置信度」绑定
 * ============================================================ */

function runConfidenceCeiling(): void {
  hr('攻击 4F：置信度天花板 —— 逐分量拆解（为什么永远停在 0.30）');

  const r = analyzeManualHand(FLOP, { rules: RULES, asOf: 1_757_000_000_000, writeLog: false });
  if (!r.ok) {
    console.log(`  失败 ${r.stage}`);
    return;
  }
  const m = r.decision.diagnostics.math;
  const range = r.decision.diagnostics.range!;
  const player = r.decision.diagnostics.player!;
  const env = r.decision.diagnostics.environment;
  console.log(`  最终置信度 = ${r.decision.confidence}  档位 = ${r.decision.band}  分类 = ${r.decision.classification}`);
  console.log(`  --- confidenceOf 的各分量（取最小值）---`);
  console.log(`     输入完整度 completeness：heroCards=${r.decision.diagnostics.math.street ? 2 : '?'} board=${5 - (5 - 3)} 张 → 1`);
  console.log(`     范围可信度 rangeConfidence = ${range.confidence}  ← **天花板**（启发式先验固定 0.3）`);
  console.log(`     玩家可信度 playerConfidence = ${player.confidence}  中性化=${player.neutralized}`);
  console.log(`     环境可信度 environmentConfidence = ${env.advice.length > 0 ? 0.4 : 0.3}（advice ${env.advice.length} 条）`);
  console.log(`     动态可信度 dynamicConfidence = ${r.decision.diagnostics.dynamic.computed ? r.decision.diagnostics.dynamic.confidence : '中性 0.5'}`);
  console.log(`     数学精度 precision：来源=${m.equitySource?.method} 样本=${m.equitySource?.iterations} 半宽=${m.equitySource?.confidenceHalfWidth}`);
  console.log(`     降级惩罚 degradationPenalty：degradations=${r.decision.diagnostics.degradations.length} 条`);
  console.log(
    `  → 范围可信度 ${range.confidence} 是上界，因此**任何**启发式范围下的置信度都不可能超过 ` +
      `${range.confidence}（档位最多「中低」）`,
  );

  hr('攻击 4G：即便数学极其清晰（AA 面对 100BB 全下），置信度仍为 0.30');
  const shove: ManualHandInput = {
    tableSize: 6,
    heroPosition: Position.BB,
    heroCards: ['As', 'Ad'],
    board: [],
    street: Street.PREFLOP,
    effectiveStackBB: 100,
    actionHistory: [
      { position: Position.UTG, type: 'ALL_IN', amountBB: 100 },
      { position: Position.HJ, type: 'FOLD' },
      { position: Position.CO, type: 'FOLD' },
      { position: Position.BTN, type: 'FOLD' },
      { position: Position.SB, type: 'FOLD' },
    ],
    environment: 'MID_LOW_STAKES',
    villain: { stackBB: 100 },
  };
  const s = analyzeManualHand(shove, { rules: RULES, asOf: 1_757_000_000_000, writeLog: false });
  if (s.ok) {
    const dom = s.decision.diagnostics.mathDominance;
    console.log(`  动作=${s.decision.action} 权益=${s.decision.diagnostics.math.heroEquity?.toFixed(4)} ` +
      `所需=${s.decision.diagnostics.math.requiredEquity.toFixed(4)} 跟注EV=${s.decision.diagnostics.math.callEV?.toFixed(2)}`);
    console.log(`  数学占优=${dom.dominant} EV差占底池=${dom.evGapToPotRatio?.toFixed(4)}`);
    console.log(`  **置信度=${s.decision.confidence}（档位「${s.decision.band}」）分类=${s.decision.classification}**`);
    console.log(`  首屏会显示：${JSON.stringify(s.viewModel.actionZh)} / 置信度「${s.viewModel.confidenceZh}」/ 类型「${s.viewModel.classificationZh}」`);
    console.log(`  环境规则数=${s.decision.diagnostics.environment.advice.length}（advice 越多环境分量越高，上限 0.4）`);
  }
}

/* ============================================================
 * main
 * ============================================================ */

await runStrictHttpComparison();
runConfidenceCeiling();
