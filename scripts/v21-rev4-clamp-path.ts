/**
 * Reviewer 4 · probe 6 — 审计脚本的钳位判定为何恒为 null（fail-open 验证）
 *
 * 运行：node --experimental-strip-types scripts/v21-rev4-clamp-path.ts
 */
import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';
import { parseManualInput } from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import type { ManualHandInput } from '../src/app/manualInput/manualInput.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const SEATS = { UTG: 100, UTG1: 100, UTG2: 100, LJ: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 };
const HISTORY = [
  { position: 'UTG', type: 'FOLD' }, { position: 'UTG1', type: 'FOLD' }, { position: 'UTG2', type: 'FOLD' },
  { position: 'LJ', type: 'FOLD' }, { position: 'HJ', type: 'FOLD' },
  { position: 'CO', type: 'RAISE', amountBB: 2.5 }, { position: 'BTN', type: 'FOLD' }, { position: 'SB', type: 'FOLD' },
  { position: 'BB', type: 'CALL', amountBB: 1.5 },
  { position: 'BB', type: 'CHECK', street: 'FLOP' }, { position: 'CO', type: 'BET', amountBB: 2, street: 'FLOP' },
  { position: 'BB', type: 'CALL', amountBB: 2, street: 'FLOP' },
  { position: 'BB', type: 'CHECK', street: 'TURN' }, { position: 'CO', type: 'CHECK', street: 'TURN' },
  { position: 'BB', type: 'BET', amountBB: 7, street: 'RIVER' },
] as const;
const hand = (qp: string): ManualHandInput => ({
  tableSize: 9, heroPosition: 'CO', heroCards: ['Ac', 'Jh'],
  board: ['Ad', '8s', '4s', '2c', 'Kd'], street: 'RIVER',
  effectiveStackBB: 100, bigBlindBB: 2, seatStacksBB: { ...SEATS },
  actionHistory: [...HISTORY], environment: 'MID_LOW_STAKES',
  villain: { quickProfile: qp, dynamicHint: 'UNKNOWN', stackBB: 100 },
} as unknown as ManualHandInput);

for (const qp of ['MANIAC', 'CALLING_STATION', 'NORMAL']) {
  const parsed = parseManualInput(hand(qp));
  if (!parsed.ok) throw new Error('parse');
  const gate = buildAnalyzableState(parsed.value);
  if (!gate.ok) throw new Error('gate');
  const built = buildDecisionContext({
    state: gate.state, rules: RULES, environment: 'MID_LOW_STAKES', asOf: 1_757_000_000_000, quickProfile: qp as never,
  });

  const ctx = built.context as unknown as Record<string, unknown>;
  const pff = ctx['postflopFacts'] as Record<string, unknown> | undefined;
  const orf = pff?.['opponentRangeFacts'] as Record<string, unknown> | null | undefined;
  const snap = ctx['range'] as Record<string, unknown> | undefined;

  console.log(`\n########## quickProfile = ${qp} ##########`);
  console.log(`  opponentRangeFacts 的键 = ${orf === null || orf === undefined ? '（null/undefined）' : Object.keys(orf).join(', ')}`);
  console.log(`  opponentRangeFacts.updateTrace = ${String((orf as Record<string, unknown> | undefined)?.['updateTrace'])}（审计脚本读的就是这个）`);
  const snapTrace = (snap?.['updateTrace'] ?? []) as readonly { noteZh?: string; street?: string; action?: string }[];
  console.log(`  context.range.updateTrace 长度 = ${snapTrace.length}`);
  for (const t of snapTrace) {
    const nz = t.noteZh ?? '';
    console.log(`    ${String(t.street)}/${String(t.action)}：noteZh 长度=${nz.length}${nz === '' ? '（空）' : ''}`);
    if (nz !== '') console.log(`        ${nz}`);
  }

  // 完全复刻 v21-decision-impact.ts:252-260 的读取逻辑
  const ranges = pff?.['opponentRangeFacts'] as { updateTrace?: readonly { noteZh?: string }[] } | undefined;
  const notes = (ranges?.updateTrace ?? []).map((t) => t.noteZh ?? '').join('\n');
  const clampMatch = /钳位 (\d+)\/(\d+)/.exec(notes);
  const traitMatch = /条目数 (\d+)–(\d+)/.exec(notes);
  console.log(`  【复刻 v21-decision-impact.ts:252-260】notes 长度 = ${notes.length}`);
  console.log(`    clampMatch = ${clampMatch === null ? 'null' : JSON.stringify(clampMatch.slice(0, 3))} ⇒ clampedCount = ${clampMatch === null ? 'null（**检查静默失效**）' : Number(clampMatch[1])}`);
  console.log(`    traitMatch = ${traitMatch === null ? 'null' : JSON.stringify(traitMatch.slice(0, 3))} ⇒ traitCountRange = ${traitMatch === null ? 'null' : '有值'}`);
  const violation = clampMatch !== null && Number(clampMatch[1]) > 0;
  console.log(`    判定「似然被钳位」违规 = ${violation}  ← 即使真实钳位数 > 0 也恒为 false（fail-open）`);

  // 正确的读取位置
  const correct = (snap?.['updateTrace'] ?? []) as readonly { noteZh?: string }[];
  const correctNotes = correct.map((t) => t.noteZh ?? '').join('\n');
  const correctMatch = /钳位 (\d+)\/(\d+)/.exec(correctNotes);
  console.log(`  【正确位置 context.range.updateTrace】clampMatch = ${correctMatch === null ? 'null' : JSON.stringify(correctMatch.slice(0, 3))}`);
}

/* ============================================================
 * 钳位是否真的可达？（极端但**合法**的实测证据）
 * ============================================================ */
console.log('\n\n########## 钳位可达性：极端合法证据 ##########');
const { behaviorProfileOf, estimateUnifiedActionLikelihood } = await import('../src/domain/player/behaviorProfile.ts');
const node = (size: string, line: string) => ({
  street: 'RIVER', heroPosition: 'CO', villainPosition: 'BB', potType: 'SRP', playerCount: 2,
  previousStreetLine: line, currentAction: 'BET', sizeBucket: size, boardTexture: 'SEMI_DRY',
});
const OBS = (s: number, o: number) => ({ successes: s, opportunities: o });
const SCENARIOS: readonly { label: string; archetype: string | null; observed?: Record<string, { successes: number; opportunities: number }> }[] = [
  { label: 'MANIAC 标签（无实测）', archetype: 'MANIAC' },
  { label: '无标签 + 全条目 1e9/1e9 实测', archetype: null, observed: { riverBluff: OBS(1e9, 1e9), missedDrawBluff: OBS(1e9, 1e9), riverLargeBetBluff: OBS(1e9, 1e9), probeAfterTurnCheckBack: OBS(1e9, 1e9) } },
  { label: '无标签 + 全条目 1e6/1e6 实测', archetype: null, observed: { riverBluff: OBS(1e6, 1e6), missedDrawBluff: OBS(1e6, 1e6), riverLargeBetBluff: OBS(1e6, 1e6), probeAfterTurnCheckBack: OBS(1e6, 1e6) } },
  { label: 'MANIAC + 全条目 1e9/1e9 实测', archetype: 'MANIAC', observed: { riverBluff: OBS(1e9, 1e9), missedDrawBluff: OBS(1e9, 1e9), riverLargeBetBluff: OBS(1e9, 1e9), probeAfterTurnCheckBack: OBS(1e9, 1e9) } },
  { label: 'MANIAC + 人工全 VERY_HIGH', archetype: 'MANIAC' },
];
for (const sc of SCENARIOS) {
  const manual = sc.label.includes('人工') ? { riverBluff: 'VERY_HIGH', missedDrawBluff: 'VERY_HIGH', riverLargeBetBluff: 'VERY_HIGH', probeAfterTurnCheckBack: 'VERY_HIGH' } : undefined;
  const prof = behaviorProfileOf({
    playerId: 'x', archetype: sc.archetype as never,
    ...(sc.observed === undefined ? {} : { observed: sc.observed as never }),
    ...(manual === undefined ? {} : { manual: manual as never }),
  });
  for (const [cls, bucket] of [['MISSED_FLUSH_DRAW', 5], ['PURE_AIR', 5], ['THIN_VALUE', 2]] as const) {
    for (const ratio of [0.75, 1.5]) {
      const L = estimateUnifiedActionLikelihood({
        semanticClass: cls as never, strengthBucket: bucket, betRatio: ratio,
        node: node(ratio > 1 ? 'OVERBET' : 'LARGE', 'TURN_CHECK_BACK') as never,
        profile: prof, action: 'BET',
      });
      if (L.clamped || L.rawLikelihood > 0.5) {
        console.log(`  ${sc.label.padEnd(34)} ${cls.padEnd(20)} ratio=${ratio} base=${L.baseLikelihood.toPrecision(8)} combined=${L.combinedAdjustment.toPrecision(8)} raw=${L.rawLikelihood.toPrecision(8)} → ${L.likelihood.toPrecision(8)} clamped=${L.clamped}`);
      }
    }
  }
}
console.log('  （只打印 clamped=true 或 raw > 0.5 的单元；无输出 ⇒ 未触达钳位）');

console.log('\n########## 钳位可达性：需要多少「实测机会数」？ ##########');
for (const n of [6, 10, 20, 30, 50, 75, 100, 150, 200, 500]) {
  const obs = {
    riverBluff: OBS(n, n), missedDrawBluff: OBS(n, n), riverLargeBetBluff: OBS(n, n),
  };
  const prof = behaviorProfileOf({ playerId: 'x', archetype: null, observed: obs as never });
  for (const [cls, bucket] of [['MISSED_FLUSH_DRAW', 5], ['PURE_AIR', 5]] as const) {
    const L = estimateUnifiedActionLikelihood({
      semanticClass: cls as never, strengthBucket: bucket, betRatio: 0.75,
      node: node('LARGE', 'TURN_CHECK_BACK') as never, profile: prof, action: 'BET',
    });
    console.log(
      `  n=${String(n).padStart(4)}（全成功，3 条目）${cls.padEnd(19)} combined=${L.combinedAdjustment.toPrecision(8).padStart(16)} raw=${L.rawLikelihood.toPrecision(8).padStart(16)} → ${L.likelihood.toPrecision(4)}  clamped=${L.clamped}`,
    );
  }
}
console.log('  ⇒ n=100 时 raw=0.980（未饱和）；n=150 时 raw=1.281 ⇒ 在 n≈120 处首次撞上钳位 1.0（三条目各 100% 成功率）');
