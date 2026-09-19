/**
 * 画像 → Range → 权益 / EV 主链 · 验收探针（P0 架构修复）
 *
 * 用法：`E:\node.exe --experimental-strip-types scripts/profile-range-probe.ts`
 *
 * 输出每一行的完整证据（使用者第 7 / 12 节要求的验收表）：
 *   画像 / 诈唬质量% / Hero 权益 / 所需权益 / Call EV / 决策边际 / 模型置信度 / 最终动作
 * 外加 provider 的乘数证据（PROFILE / OBSERVATION / FINAL / CLAMP）。
 */
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import { parseManualInput, type ManualHandInput } from '../src/app/manualInput/manualInput.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const OPTIONS = { rules: RULES, asOf: 1_757_000_000_000, writeLog: false } as const;
const SEATS = { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 } as const;
const HISTORY = [
  { position: 'UTG', type: 'FOLD' },
  { position: 'HJ', type: 'FOLD' },
  { position: 'CO', type: 'RAISE', amountBB: 2.5 },
  { position: 'BTN', type: 'CALL', amountBB: 2.5 },
  { position: 'SB', type: 'FOLD' },
  { position: 'BB', type: 'FOLD' },
  { position: 'CO', type: 'BET', amountBB: 2, street: 'FLOP' },
  { position: 'BTN', type: 'CALL', amountBB: 2, street: 'FLOP' },
  { position: 'CO', type: 'BET', amountBB: 7, street: 'TURN' },
  { position: 'BTN', type: 'CALL', amountBB: 7, street: 'TURN' },
  { position: 'CO', type: 'BET', amountBB: 20, street: 'RIVER' },
] as const;

const CASES: readonly { profile: string; hint: string }[] = [
  { profile: 'UNKNOWN', hint: 'UNKNOWN' },
  { profile: 'VERY_TIGHT', hint: 'UNKNOWN' },
  { profile: 'TIGHT', hint: 'UNKNOWN' },
  { profile: 'UNDERBLUFFER', hint: 'UNKNOWN' },
  { profile: 'NORMAL', hint: 'UNKNOWN' },
  { profile: 'CALLING_STATION', hint: 'UNKNOWN' },
  { profile: 'AGGRESSIVE', hint: 'UNKNOWN' },
  { profile: 'BLUFF_HEAVY', hint: 'UNKNOWN' },
  { profile: 'MANIAC', hint: 'UNKNOWN' },
  { profile: 'BLUFF_HEAVY', hint: 'AGGRESSION_UP' },
  { profile: 'MANIAC', hint: 'AGGRESSION_UP' },
  { profile: 'MANIAC', hint: 'TIGHTER_RECENTLY' },
];

function buildInput(profile: string, hint: string): ManualHandInput {
  return {
    tableSize: 6,
    heroPosition: 'BTN',
    heroCards: ['Ah', 'Qc'],
    board: ['Qs', '8d', '3c', '6s', 'Ks'],
    street: 'RIVER',
    effectiveStackBB: 100,
    bigBlindBB: 2,
    seatStacksBB: { ...SEATS },
    actionHistory: [...HISTORY],
    environment: 'MID_LOW_STAKES',
    villain: { quickProfile: profile, dynamicHint: hint, stackBB: 100 },
  } as unknown as ManualHandInput;
}

console.log('局面：BTN A♥Q♣｜河牌 Q♠8♦3♣6♠K♠｜CO 下注 20BB（82% 池）｜需 31.0% 权益\n');console.log(
  '  画像                        诈唬质量%   权益      所需      跟注EV     边际        置信度  动作   范围前后组合数',
);

for (const c of CASES) {
  const input = buildInput(c.profile, c.hint);
  const r = analyzeManualHand(input, OPTIONS);
  const label = `${c.profile}${c.hint === 'UNKNOWN' ? '' : '+' + c.hint}`;
  if (!r.ok) {
    console.log(`  ${label.padEnd(28)}❌ ${JSON.stringify(r.issues)}`);
    continue;
  }

  const parsed = parseManualInput(input);
  let bluffMass = 0;
  let evidenceText = '';
  let combos = '';
  let equityBefore = '';
  let equityAfter = '';
  let providerLine = '';
  if (parsed.ok) {
    const gate = buildAnalyzableState(parsed.value);
    if (gate.ok) {
      const built = buildDecisionContext({
        state: gate.state,
        rules: RULES,
        environment: 'MID_LOW_STAKES',
        asOf: 1_757_000_000_000,
        quickProfile: c.profile,
        dynamicHint: c.hint as never,
      });
      const facts = built.context.postflopFacts?.opponentRangeFacts ?? null;
      bluffMass = facts?.actionMasses?.bluffMassShare ?? 0;
      const ev = built.context.profileRangeEvidence ?? null;
      if (ev !== null) {
        combos = `${ev.combosBefore} → ${ev.combosAfter}`;
        equityBefore = ev.equityBefore === null ? '—' : (ev.equityBefore * 100).toFixed(2) + '%';
        equityAfter = ev.equityAfter === null ? '—' : (ev.equityAfter * 100).toFixed(2) + '%';
        providerLine =
          `     维度来源：${ev.dimensionTierZh}｜${ev.dimensionNoteZh}\n` +
          `     调整：${ev.provider.noteZh.join('；')}`;
      } else {
        providerLine = '     （没有画像证据对象：本局没有画像 / 近期倾向）';
      }
    }
  }

  const m = r.decision.diagnostics.math;
  const margin = r.decision.diagnostics.decisionMargin;
  const post = r.decision.diagnostics.postflop;
  console.log(
    `  ${label.padEnd(28)}${(bluffMass * 100).toFixed(2).padStart(7)}%  ` +
      `${((m.heroEquity ?? 0) * 100).toFixed(3).padStart(6)}%  ` +
      `${(m.requiredEquity * 100).toFixed(2).padStart(5)}%  ` +
      `${(m.callEV ?? 0).toFixed(3).padStart(8)}  ` +
      `${(margin?.kind ?? '—').padEnd(10)}  ${(post?.confidence ?? '—').padEnd(6)}  ` +
      `${String(r.decision.action).padEnd(5)}  ${combos}`,
  );
  console.log(
    `     权益（范围调整前 → 后）：${equityBefore} → ${equityAfter}` +
      (evidenceText === '' ? '' : `｜${evidenceText}`),
  );
  if (providerLine !== '') console.log(providerLine);
}

/* ============================================================
 * 尺寸敏感性：「大注诈唬」与「小注诈唬」不是同一件事
 * ============================================================ */

console.log('\n\n尺寸敏感性（同一手 BB A♥9♥｜河牌 K♣9♠5♦2♥7♣｜BTN 偷盲线）：\n');
console.log('  河牌下注（池比例）  画像因子（BLUFF_HEAVY）        诈唬质量 NORMAL → BLUFF_HEAVY   权益 NORMAL → BLUFF_HEAVY');

function bluffCatchInput(betBB: number): ManualHandInput {
  return {
    tableSize: 9,
    heroPosition: 'BB',
    heroCards: ['Ah', '9h'],
    board: ['Kc', '9s', '5d', '2h', '7c'],
    street: 'RIVER',
    effectiveStackBB: 100,
    seatStacksBB: { UTG: 100, CO: 100, BTN: 100, BB: 100 },
    actionHistory: [
      { position: 'UTG', type: 'FOLD' },
      { position: 'UTG1', type: 'FOLD' },
      { position: 'UTG2', type: 'FOLD' },
      { position: 'LJ', type: 'FOLD' },
      { position: 'HJ', type: 'FOLD' },
      { position: 'CO', type: 'FOLD' },
      { position: 'BTN', type: 'RAISE', amountBB: 3 },
      { position: 'SB', type: 'FOLD' },
      { position: 'BB', type: 'CALL', amountBB: 2 },
      { position: 'BB', type: 'CHECK', street: 'FLOP' },
      { position: 'BTN', type: 'BET', amountBB: 1.5, street: 'FLOP' },
      { position: 'BB', type: 'CALL', amountBB: 1.5, street: 'FLOP' },
      { position: 'BB', type: 'CHECK', street: 'TURN' },
      { position: 'BTN', type: 'CHECK', street: 'TURN' },
      { position: 'BB', type: 'CHECK', street: 'RIVER' },
      { position: 'BTN', type: 'BET', amountBB: betBB, street: 'RIVER' },
    ],
    environment: 'MID_LOW_STAKES',
    villain: { quickProfile: 'BLUFF_HEAVY', dynamicHint: 'UNKNOWN' },
  } as unknown as ManualHandInput;
}

function measure(betBB: number, profile: string): {
  factorMax: number;
  bluffMass: number;
  equity: number;
} {
  const input = { ...bluffCatchInput(betBB), villain: { quickProfile: profile, dynamicHint: 'UNKNOWN' } } as unknown as ManualHandInput;
  const parsed = parseManualInput(input);
  if (!parsed.ok) return { factorMax: 0, bluffMass: 0, equity: 0 };
  const gate = buildAnalyzableState(parsed.value);
  if (!gate.ok) return { factorMax: 0, bluffMass: 0, equity: 0 };
  const built = buildDecisionContext({
    state: gate.state,
    rules: RULES,
    environment: 'MID_LOW_STAKES',
    asOf: 1_757_000_000_000,
    quickProfile: profile,
  });
  const ev = built.context.profileRangeEvidence;
  return {
    factorMax: ev?.provider.finalMultiplier.max ?? 1,
    bluffMass: built.context.postflopFacts?.opponentRangeFacts?.actionMasses?.bluffMassShare ?? 0,
    equity: built.context.math.heroEquity ?? 0,
  };
}

for (const bet of [1.5, 3, 6, 12, 18]) {
  const heavy = measure(bet, 'BLUFF_HEAVY');
  const normal = measure(bet, 'NORMAL');
  console.log(
    `  ${String(bet).padStart(4)}BB（≈${((bet / 9.5) * 100).toFixed(0)}% 池）`.padEnd(24) +
      `×1.000–${heavy.factorMax.toFixed(3)}`.padEnd(30) +
      `${(normal.bluffMass * 100).toFixed(2)}% → ${(heavy.bluffMass * 100).toFixed(2)}%`.padEnd(32) +
      `${(normal.equity * 100).toFixed(2)}% → ${(heavy.equity * 100).toFixed(2)}%`,
  );
}
