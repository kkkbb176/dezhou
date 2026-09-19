/**
 * Reviewer 5 · 反证探针 D —— NEUTRAL_PARITY 在**溜入底池**上是否仍然成立
 *
 * 线索来自本轮自己的证据文件 `reports/evidence/v21-profile-sensitivity.json`：
 *   `NEUTRAL_NORMAL` 与 `NO_PROFILE_UNKNOWN` 在 **S7_LIMPED_POT_RIVER_BLUFFCATCH**
 *   上权益差 **2.7e-4 ≠ 0**（其余 7 个场景为 0）。
 *
 * 机制假设：河牌统一似然确实逐位中性，但 `NORMAL` 会经
 *   `quickProfileToLimperArchetype('NORMAL') = LimperArchetype.NORMAL`
 *   + `confidence = 0.35`（`quickProfile` 的可信度上限）
 * 进入 `effectiveTraits`（limpIsolation.ts:113），而 `UNKNOWN` 的 confidence = 0
 * ⇒ 溜入范围不同 ⇒ 权益不同。NEUTRAL_PARITY 因此**只覆盖河牌似然层**。
 *
 * 运行：node --experimental-strip-types scripts/v21-rev5-limp-parity.ts
 */
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { behaviorProfileOf } from '../src/domain/player/behaviorProfile.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import type { ManualHandInput } from '../src/app/manualInput/manualInput.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const OPTIONS = {
  rules: RULES,
  asOf: 1_757_000_000_000,
  writeLog: false,
  budget: { softMs: 120_000, hardMs: 240_000 },
} as const;

/** 逐字取自 `scripts/v21-profile-sensitivity-audit.ts` 的 S7 */
const SEATS6 = { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 };
const S7_HISTORY = [
  { position: 'UTG', type: 'CALL', amountBB: 1 },
  { position: 'HJ', type: 'FOLD' },
  { position: 'CO', type: 'CALL', amountBB: 1 },
  { position: 'BTN', type: 'FOLD' },
  { position: 'SB', type: 'FOLD' },
  { position: 'BB', type: 'CHECK' },
  { position: 'BB', type: 'CHECK', street: 'FLOP' },
  { position: 'UTG', type: 'CHECK', street: 'FLOP' },
  { position: 'CO', type: 'BET', amountBB: 2, street: 'FLOP' },
  { position: 'BB', type: 'CALL', amountBB: 2, street: 'FLOP' },
  { position: 'UTG', type: 'CALL', amountBB: 2, street: 'FLOP' },
  { position: 'BB', type: 'CHECK', street: 'TURN' },
  { position: 'UTG', type: 'CHECK', street: 'TURN' },
  { position: 'CO', type: 'BET', amountBB: 4, street: 'TURN' },
  { position: 'BB', type: 'CALL', amountBB: 4, street: 'TURN' },
  { position: 'UTG', type: 'FOLD' },
  { position: 'BB', type: 'CHECK', street: 'RIVER' },
  { position: 'CO', type: 'BET', amountBB: 6, street: 'RIVER' },
] as const;

/** 同一手牌结构的 SRP 对照（无 limp ⇒ 不该走 limpIsolation 通道）*/
const SRP_HISTORY = [
  { position: 'UTG', type: 'FOLD' },
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
  { position: 'BB', type: 'CHECK', street: 'RIVER' },
  { position: 'CO', type: 'BET', amountBB: 6, street: 'RIVER' },
] as const;

type Variant = 'UNKNOWN' | 'NORMAL' | 'none' | 'explicitNeutral';

function hand(history: readonly unknown[], variant: Variant): ManualHandInput {
  const villain: Record<string, unknown> = { stackBB: 100, dynamicHint: 'UNKNOWN' };
  if (variant === 'UNKNOWN') villain['quickProfile'] = 'UNKNOWN';
  if (variant === 'NORMAL') villain['quickProfile'] = 'NORMAL';
  if (variant === 'explicitNeutral') {
    villain['behaviorProfile'] = behaviorProfileOf({ playerId: 'seat_CO', archetype: null });
  }
  return {
    tableSize: 6,
    heroPosition: 'BB',
    heroCards: ['9h', '9c'],
    board: ['Qs', '8d', '3c', '6s', 'Ks'],
    street: 'RIVER',
    effectiveStackBB: 100,
    bigBlindBB: 2,
    seatStacksBB: { ...SEATS6 },
    actionHistory: [...history],
    environment: 'MID_LOW_STAKES',
    villain,
  } as unknown as ManualHandInput;
}

const eqOf = (r: ReturnType<typeof analyzeManualHand>): number =>
  r.ok ? Number((r.decision.diagnostics as unknown as { math?: Record<string, unknown> }).math?.['heroEquity']) : Number.NaN;

for (const [label, history] of [['LIMPED（S7 逐字）', S7_HISTORY], ['SRP 对照', SRP_HISTORY]] as const) {
  console.log(`\n================ ${label} ================`);
  const got: Partial<Record<Variant, { eq: number; action: string; combos: string }>> = {};
  for (const v of ['UNKNOWN', 'NORMAL', 'none', 'explicitNeutral'] as Variant[]) {
    const r = analyzeManualHand(hand(history, v), OPTIONS);
    const eq = eqOf(r);
    const pr = r.ok
      ? (r.decision.diagnostics as unknown as { profileRange?: unknown }).profileRange
      : null;
    got[v] = {
      eq,
      action: r.ok ? String(r.decision.action) : `FAIL:${r.ok ? '' : r.stage}`,
      combos: pr === null || pr === undefined ? 'null' : '有',
    };
    console.log(
      `  ${v.padEnd(16)} ok=${r.ok} 权益=${Number.isFinite(eq) ? eq.toFixed(17) : String(eq)} ` +
        `动作=${got[v]!.action} profileRange=${got[v]!.combos}` +
        (r.ok ? '' : ` issues=${JSON.stringify(r.issues)}`),
    );
  }
  const u = got['UNKNOWN']!;
  const n = got['NORMAL']!;
  const nn = got['none']!;
  const p = got['explicitNeutral']!;
  console.log(`  ---- 判定 ----`);
  console.log(`  UNKNOWN vs NORMAL          : Δ权益 = ${(n.eq - u.eq).toExponential(6)}  ⇒ ${n.eq === u.eq ? '逐位相同' : '**不同**'}`);
  console.log(`  UNKNOWN vs 完全不给画像     : Δ权益 = ${(nn.eq - u.eq).toExponential(6)}  ⇒ ${nn.eq === u.eq ? '逐位相同' : '**不同**'}`);
  console.log(`  UNKNOWN vs 显式中性画像     : Δ权益 = ${(p.eq - u.eq).toExponential(6)}  ⇒ ${p.eq === u.eq ? '逐位相同' : '**不同**'}`);
  console.log(`  ⇒ NEUTRAL_PARITY（UNKNOWN == NORMAL，本结构）= ${n.eq === u.eq ? 'PASS' : '**FAIL**'}`);
}
