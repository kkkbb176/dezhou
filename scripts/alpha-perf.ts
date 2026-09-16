/**
 * Alpha 端到端**性能实测**（用于最终报告）
 *
 * 用法：`node --experimental-strip-types scripts/alpha-perf.ts`
 *
 * 只做测量，不做任何判断 —— 数字直接进报告。
 */

import { Position, Street } from '../src/domain/types.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import type { ManualHandInput } from '../src/app/manualInput/manualInput.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const OPTIONS = { rules: RULES, asOf: 1_757_000_000_000, writeLog: false } as const;
const ROUNDS = 60;

function base(overrides: Partial<ManualHandInput>): ManualHandInput {
  return {
    tableSize: 6,
    heroPosition: Position.CO,
    heroCards: ['As', 'Kd'],
    board: [],
    street: Street.PREFLOP,
    effectiveStackBB: 100,
    actionHistory: [],
    environment: 'MID_LOW_STAKES',
    villain: { quickProfile: 'NORMAL' },
    ...overrides,
  };
}

const PREFLOP: ManualHandInput = base({
  actionHistory: [
    { position: Position.UTG, type: 'FOLD' },
    { position: Position.HJ, type: 'FOLD' },
    { position: Position.CO, type: 'RAISE', amountBB: 3 },
    { position: Position.BTN, type: 'FOLD' },
    { position: Position.SB, type: 'FOLD' },
    { position: Position.BB, type: 'RAISE', amountBB: 10 },
  ],
});

const FLOP: ManualHandInput = base({
  board: ['Kh', '7c', '2d'],
  street: Street.FLOP,
  actionHistory: [
    { position: Position.UTG, type: 'FOLD' },
    { position: Position.HJ, type: 'FOLD' },
    { position: Position.CO, type: 'RAISE', amountBB: 3 },
    { position: Position.BTN, type: 'FOLD' },
    { position: Position.SB, type: 'FOLD' },
    { position: Position.BB, type: 'CALL', amountBB: 2 },
    { position: Position.BB, type: 'CHECK', street: Street.FLOP },
  ],
});

const TURN: ManualHandInput = base({
  board: ['Kh', '7c', '2d', '3s'],
  street: Street.TURN,
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
  ],
});

const RIVER: ManualHandInput = base({
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
});

const CASES: readonly (readonly [string, ManualHandInput])[] = [
  ['翻牌前', PREFLOP],
  ['翻牌', FLOP],
  ['转牌', TURN],
  ['河牌', RIVER],
];

function pct(sorted: readonly number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

console.log('Alpha 端到端性能实测（每档 %d 次，冷缓存后计时）', ROUNDS);
console.log('');
console.log('| 街道 | P50 | P95 | Max | 动作 |');
console.log('|---|---:|---:|---:|---|');

for (const [name, input] of CASES) {
  // 预热一次（范围缓存 / JIT）
  const warm = analyzeManualHand(input, OPTIONS);
  if (!warm.ok) {
    console.log(`| ${name} | 失败：${warm.stage} | | | |`);
    continue;
  }

  const samples: number[] = [];
  let action = '';
  for (let i = 0; i < ROUNDS; i++) {
    const t0 = performance.now();
    const r = analyzeManualHand(input, OPTIONS);
    const dt = performance.now() - t0;
    if (!r.ok) throw new Error(`${name} 第 ${i} 次失败：${r.stage}`);
    action = `${r.decision.action ?? 'null'}`;
    samples.push(dt);
  }
  samples.sort((a, b) => a - b);
  console.log(
    `| ${name} | ${pct(samples, 50).toFixed(1)} ms | ${pct(samples, 95).toFixed(1)} ms | ` +
      `${samples[samples.length - 1]!.toFixed(1)} ms | ${action} |`,
  );
}

console.log('');
console.log('预算：软 3,000 ms / 硬 8,000 ms（锁定指标：最佳 1–2s，常规 ≤3s，复杂 ≤5s，硬上限 8s）');
