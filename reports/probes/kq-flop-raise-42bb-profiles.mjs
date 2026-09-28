/*
 * Profile A/B: does the read move the range, the response probabilities,
 * the candidate EVs, or the final decision? Numbers parsed from the engine's
 * own disclosure strings (allReasonsZh) — no engine internals are re-implemented.
 */
const BASE = 'http://127.0.0.1:5173';

const base = {
  tableSize: 9, heroPosition: 'CO', heroCards: ['Ks', 'Qs'], board: ['Qh', '9s', '5s'],
  street: 'FLOP', effectiveStackBB: 100, bigBlindBB: 100, environment: 'LOW_STAKES_ONLINE',
  occupiedPositions: ['UTG', 'UTG1', 'UTG2', 'LJ', 'HJ', 'CO', 'BTN', 'SB', 'BB'],
  buttonPosition: 'BTN', potBB: 23,
  actionHistory: [
    { position: 'UTG', type: 'FOLD', street: 'PREFLOP' }, { position: 'UTG1', type: 'FOLD', street: 'PREFLOP' },
    { position: 'UTG2', type: 'FOLD', street: 'PREFLOP' }, { position: 'LJ', type: 'FOLD', street: 'PREFLOP' },
    { position: 'HJ', type: 'FOLD', street: 'PREFLOP' }, { position: 'CO', type: 'RAISE', amountBB: 2.5, street: 'PREFLOP' },
    { position: 'BTN', type: 'FOLD', street: 'PREFLOP' }, { position: 'SB', type: 'FOLD', street: 'PREFLOP' },
    { position: 'BB', type: 'CALL', amountBB: 1.5, street: 'PREFLOP' },
    { position: 'BB', type: 'CHECK', street: 'FLOP' }, { position: 'CO', type: 'BET', amountBB: 3.5, street: 'FLOP' },
    { position: 'BB', type: 'RAISE', amountBB: 14, street: 'FLOP' },
  ],
};

const variants = [
  ['1 默认（无任何读牌）', () => {}],
  ['2 标签 AGGRESSIVE（偏松激进）', (v) => { v.seatProfiles = { BB: 'AGGRESSIVE' }; v.villain = { position: 'BB', quickProfile: 'AGGRESSIVE' }; }],
  ['3 AGGRESSIVE + 实测VPIP42/PFR28/150手', (v) => { v.seatProfiles = { BB: 'AGGRESSIVE' }; v.villain = { position: 'BB', quickProfile: 'AGGRESSIVE', observedStats: { handsObserved: 150, vpip: 0.42, pfr: 0.28 }, observedStatsNoteZh: '题目设定（隔离输入）' }; }],
  ['4 标签 CALLING_STATION（偏被动）', (v) => { v.seatProfiles = { BB: 'CALLING_STATION' }; v.villain = { position: 'BB', quickProfile: 'CALLING_STATION' }; }],
  ['5 标签 MANIAC', (v) => { v.seatProfiles = { BB: 'MANIAC' }; v.villain = { position: 'BB', quickProfile: 'MANIAC' }; }],
  ['6 标签 TIGHT', (v) => { v.seatProfiles = { BB: 'TIGHT' }; v.villain = { position: 'BB', quickProfile: 'TIGHT' }; }],
];

async function analyze(input) {
  const r = await fetch(BASE + '/api/analyze', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ input }) });
  return r.json();
}

const num = (s, re) => { const m = s.match(re); return m ? Number(m[1]) : null; };

console.log('variant'.padEnd(34), '| action  | fold%  | call%  | reras% | RAISE_EV | CALL_EV | eqBet%');
console.log('-'.repeat(112));
const out = [];
for (const [label, mutate] of variants) {
  const v = structuredClone(base); mutate(v);
  const b = await analyze(v);
  if (!b.ok) { console.log(label.padEnd(34), '| FAILED:', JSON.stringify(b.issues).slice(0, 90)); continue; }
  const all = (b.viewModel.allReasonsZh ?? []).join(' || ');
  const md = b.viewModel.debug.math;
  const g = (n) => { const r = md.find((x) => (x.label ?? '').includes(n)); return r ? String(r.value).split('｜')[0].trim() : '—'; };
  const fold = num(all, /弃 ([\d.]+)% \/ 跟/);
  const call = num(all, /跟 ([\d.]+)% \/ 再加注/);
  const rr = num(all, /再加注 ([\d.]+)%/);
  const raiseEV = num(all, /响应模型 EV\*\* = ([\d.]+)/);
  const row = {
    label, action: `${b.decision.action} ${b.decision.sizeBB}BB`, fold, call, rr, raiseEV,
    callEV: g('跟注 EV'), eqBet: g('对手下注范围权益'), eqOverall: g('整体范围权益'),
    classZh: b.viewModel.classificationZh,
  };
  out.push(row);
  console.log(
    label.padEnd(34), '|', row.action.padEnd(8), '|',
    String(fold ?? '—').padStart(6), '|', String(call ?? '—').padStart(6), '|', String(rr ?? '—').padStart(6), '|',
    String(raiseEV ?? '—').padStart(8), '|', row.callEV.padStart(8), '|', row.eqBet.padStart(7),
  );
}

console.log('\n=== profile disclosure (variant 3 vs 1) ===');
for (const [label, mutate] of [variants[0], variants[2]]) {
  const v = structuredClone(base); mutate(v);
  const b = await analyze(v);
  const pl = b.viewModel.debug.player ?? [];
  console.log(`\n[${label}]`);
  for (const r of pl) console.log(`   ${r.label}: ${String(r.value).replace(/\s+/g, ' ').slice(0, 200)}`);
}
console.log('\n=== does the chosen raise EV exist in the candidate list? (variant 1) ===');
{
  const b = await analyze(structuredClone(base));
  const c = (b.viewModel.debug.candidates ?? []).find((x) => String(x.sizeZh).startsWith('42'));
  console.log('  candidates[] entry for 42.0BB :', JSON.stringify(c));
  const ds = (b.viewModel.debug.decisionSource ?? []).find((x) => x.label === '证据 RAISE');
  console.log('  decisionSource 证据 RAISE     :', String(ds?.value).slice(0, 160));
  const mm = (b.viewModel.debug.mathDominance ?? []).find((x) => x.label === '说明');
  console.log('  mathDominance 说明            :', String(mm?.value).slice(0, 260));
}
