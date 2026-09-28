/*
 * 定位「画像第三道门」：直接调用解析器，隔离所有接线。
 * 只读探针。
 */
import { resolvePlayerProfile, STAT_DIMENSION_POLARITY } from '../../src/domain/player/observedStats.ts';

const cases: [string, Record<string, unknown> | null, string | null][] = [
  ['无统计 + 无标签', null, null],
  ['vpip=0.15（紧）+ 无标签', { handsObserved: 60, vpip: 0.15, pfr: 0.10 }, null],
  ['vpip=0.85（松）+ 无标签', { handsObserved: 60, vpip: 0.85, pfr: 0.60 }, null],
  ['vpip=0.15 + 标签 AGGRESSIVE', { handsObserved: 60, vpip: 0.15, pfr: 0.10 }, 'AGGRESSIVE'],
];

console.log('=== 极性表（决定哪条统计推哪个轴）===');
for (const k of ['vpip', 'pfr', 'threeBet', 'wtsd', 'foldToFlopCBet', 'flopCheckRaise']) {
  console.log(`  ${k.padEnd(16)} ${JSON.stringify((STAT_DIMENSION_POLARITY as Record<string, unknown>)[k])}`);
}

for (const [label, observedStats, archetype] of cases) {
  const r = resolvePlayerProfile({
    baseArchetype: archetype as never,
    observedStats: observedStats as never,
    opportunities: null as never,
    actionContext: null as never,
    street: 'FLOP' as never,
  });
  const res = (r as unknown as Record<string, any>).resolved;
  console.log(`\n=== ${label} ===`);
  console.log('  observedStatCount =', (r as unknown as Record<string, unknown>)['observedStatCount']);
  console.log('  evidenceMass      =', JSON.stringify(res?.['evidenceMass']));
  console.log('  blendWeight       =', JSON.stringify(res?.['blendWeight']));
  console.log('  observedDimensions=', JSON.stringify(res?.['observedOnlyDimensions']));
  console.log('  resolvedDimensions=', JSON.stringify(res?.['resolvedDimensions']));
  console.log('  分街(FLOP)        =', JSON.stringify(res?.street?.['FLOP']));
}
