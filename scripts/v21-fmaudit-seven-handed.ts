/**
 * V21 画像审计 —— 7 人局（9 座容量 − 2 座）是否能被表达（item 18 补充）
 *
 * `tableSize` 是**座位容量**（只能 6 或 9），本手人数由 `occupiedPositions` 决定
 * （`manualInput.ts:311-327`）。因此「7 人桌」这条失败模式有两种含义：
 * ① `tableSize=7`（物理容量）—— 已知被拒；
 * ② 9 座桌上的 **7 人局** —— 本脚本实测它是否被接受、画像是否照常生效。
 *
 * 用法：node --experimental-strip-types scripts/v21-fmaudit-seven-handed.ts
 */

import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import type { ManualHandInput } from '../src/app/manualInput/manualInput.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const SEATS9 = {
  UTG: 100, UTG1: 100, UTG2: 100, LJ: 100, HJ: 100,
  CO: 100, BTN: 100, SB: 100, BB: 100,
} as const;

/** 9 座桌去掉 UTG / UTG1 ⇒ 本手 7 人 */
const SEVEN = (villain: Record<string, unknown>): ManualHandInput =>
  ({
    tableSize: 9,
    heroPosition: 'CO',
    heroCards: ['Ac', 'Jh'],
    board: ['Ad', '8s', '4s', '2c', 'Kd'],
    street: 'RIVER',
    effectiveStackBB: 100,
    bigBlindBB: 2,
    occupiedPositions: ['UTG2', 'LJ', 'HJ', 'CO', 'BTN', 'SB', 'BB'],
    seatStacksBB: { ...SEATS9 },
    actionHistory: [
      { position: 'UTG2', type: 'FOLD' },
      { position: 'LJ', type: 'FOLD' },
      { position: 'HJ', type: 'FOLD' },
      { position: 'CO', type: 'RAISE', amountBB: 2.5 },
      { position: 'BTN', type: 'FOLD' },
      { position: 'SB', type: 'FOLD' },
      { position: 'BB', type: 'CALL', amountBB: 1.5 },
      { position: 'BB', type: 'CHECK', street: 'FLOP' },
      { position: 'CO', type: 'BET', amountBB: 2, street: 'FLOP' },
      { position: 'BB', type: 'CALL', amountBB: 2, street: 'FLOP' },
      { position: 'BB', type: 'CHECK', street: 'TURN' },
      { position: 'CO', type: 'CHECK', street: 'TURN' },
      { position: 'BB', type: 'BET', amountBB: 7, street: 'RIVER' },
    ],
    environment: 'MID_LOW_STAKES',
    villain: { dynamicHint: 'UNKNOWN', stackBB: 100, ...villain },
  }) as unknown as ManualHandInput;

const OPTIONS = {
  rules: RULES,
  asOf: 1_757_000_000_000,
  writeLog: false,
  budget: { softMs: 120_000, hardMs: 240_000 },
  equitySeed: 20260913,
} as const;

const rows: readonly { label: string; input: ManualHandInput }[] = [
  { label: '9 座 / 7 人局：无画像', input: SEVEN({}) },
  { label: '9 座 / 7 人局：quickProfile=MANIAC', input: SEVEN({ quickProfile: 'MANIAC' }) },
  { label: '9 座 / 7 人局：quickProfile=CALLING_STATION', input: SEVEN({ quickProfile: 'CALLING_STATION' }) },
  {
    label: '9 座 / 7 人局：tableSize=7（物理容量非法）',
    input: { ...SEVEN({ quickProfile: 'MANIAC' }), tableSize: 7 } as unknown as ManualHandInput,
  },
];

for (const r of rows) {
  const out = analyzeManualHand(r.input, OPTIONS);
  if (!out.ok) {
    console.log(`${r.label.padEnd(44)} ok=false stage=${out.stage} issues=${JSON.stringify(out.issues).slice(0, 260)}`);
    continue;
  }
  const m = out.decision.diagnostics.math;
  console.log(
    `${r.label.padEnd(44)} ok=true 动作=${String(out.decision.action).padEnd(5)} ` +
      `权益=${m.heroEquity?.toFixed(6)} callEV=${m.callEV?.toFixed(4)}`,
  );
}
