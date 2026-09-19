/**
 * V21 画像审计 —— 诊断字段形状探针（辅助脚本）
 *
 * 目的：确认「决策层去重」的证据落在 `decision.diagnostics` 的哪个字段上，
 * 以便主线探针能读到真实数值（而不是从测试名字推断）。
 *
 * 用法：node --experimental-strip-types scripts/v21-fmaudit-diag-shape.ts
 */

import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import type { ManualHandInput } from '../src/app/manualInput/manualInput.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();

const input = {
  tableSize: 9,
  heroPosition: 'CO',
  heroCards: ['Ac', 'Jh'],
  board: ['Ad', '8s', '4s', '2c', 'Kd'],
  street: 'RIVER',
  effectiveStackBB: 100,
  bigBlindBB: 2,
  seatStacksBB: { UTG: 100, UTG1: 100, UTG2: 100, LJ: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 },
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
  villain: { dynamicHint: 'UNKNOWN', stackBB: 100, quickProfile: 'MANIAC' },
} as unknown as ManualHandInput;

const r = analyzeManualHand(input, {
  rules: RULES,
  asOf: 1_757_000_000_000,
  writeLog: false,
  budget: { softMs: 120_000, hardMs: 240_000 },
});
if (!r.ok) {
  console.log('FAILED', JSON.stringify(r.issues));
  process.exit(1);
}
const d = r.decision.diagnostics as unknown as Record<string, unknown>;
console.log('diagnostics keys =', Object.keys(d).join(', '));
const post = d['postflop'] as Record<string, unknown> | undefined;
console.log('diagnostics.postflop keys =', post === undefined ? '（无）' : Object.keys(post).join(', '));
if (post) {
  for (const [k, v] of Object.entries(post)) {
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      console.log(`  ${k}: {${Object.keys(v as Record<string, unknown>).join(', ')}}`);
    }
  }
  const ex = post['exploitAdjustment'] ?? post['exploit'] ?? post['scaledExploit'];
  console.log('exploit-ish =', JSON.stringify(ex));
}
const dec = r.decision as unknown as Record<string, unknown>;
console.log('decision keys =', Object.keys(dec).join(', '));
