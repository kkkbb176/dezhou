import { resolvePlayerProfile } from '../src/domain/player/observedStats.ts';
const BASE = { handsObserved: 2000, vpip: 0.105, threeBet: 0.03, wtsd: 0.24, flopCheckRaise: 0.06 };
console.log('PFR 是否真的推动 betScale？（标签 VERY_TIGHT，只改 pfr）');
for (const pfr of [0.05, 0.09, 0.22, 0.4] as const) {
  const r: any = resolvePlayerProfile({ baseArchetype: 'VERY_TIGHT' as any, street: 'FLOP', observedStats: { ...BASE, pfr } });
  console.log('  pfr=', (pfr*100).toFixed(0)+'%',
    '| resolved.aggression=', r.resolved.resolvedDimensions.aggression.toFixed(4),
    '| FLOP.betScale=', r.resolved.street.FLOP.betScale.toFixed(4),
    '| betAggression=', r.resolved.street.FLOP.betAggression.toFixed(4));
}
console.log('');
console.log('其它统计对 betScale 的影响（对照）');
for (const [tag, extra] of [['只有 wtsd=0.5', { wtsd: 0.5 }], ['只有 vpip=0.6', { vpip: 0.6 }], ['只有 foldToFlopCBet=0.9', { foldToFlopCBet: 0.9 }], ['只有 flopCheckRaise=0.2', { flopCheckRaise: 0.2 }]] as any[]) {
  const r: any = resolvePlayerProfile({ baseArchetype: 'VERY_TIGHT' as any, street: 'FLOP', observedStats: { ...BASE, ...extra } });
  console.log('  ', tag.padEnd(24), 'FLOP.betScale=', r.resolved.street.FLOP.betScale.toFixed(4));
}
