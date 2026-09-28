/*
 * KQ FLOP RAISE 42BB CHECK — probe (read-only; no production code touched).
 *
 * Hand 3: 9-max, 1BB = 100 chips. Hero CO KsQs. BB check-raises to 14BB on Qh 9s 5s.
 *
 * IMPORTANT INPUT CONTRACT (verified in src/app/manualInput/reconstruct.ts:274-295):
 *   seatStacksBB[position] -> createGame({ startingStack })
 *   => it is the stack AT HAND START (blinds not yet posted), NOT the current stack.
 *   The task's 94BB / 83.5BB are CURRENT remainders, which follow from 100BB start
 *   (Hero: 100-2.5-3.5 = 94BB; BB: 100-2.5-14 = 83.5BB). So we start everyone at 100BB.
 */
const BASE = 'http://127.0.0.1:5173';

const base = {
  tableSize: 9,
  heroPosition: 'CO',
  heroCards: ['Ks', 'Qs'],
  board: ['Qh', '9s', '5s'],
  street: 'FLOP',
  effectiveStackBB: 100,
  bigBlindBB: 100,
  environment: 'LOW_STAKES_ONLINE',
  occupiedPositions: ['UTG', 'UTG1', 'UTG2', 'LJ', 'HJ', 'CO', 'BTN', 'SB', 'BB'],
  buttonPosition: 'BTN',
  potBB: 23,
  actionHistory: [
    { position: 'UTG', type: 'FOLD', street: 'PREFLOP' },
    { position: 'UTG1', type: 'FOLD', street: 'PREFLOP' },
    { position: 'UTG2', type: 'FOLD', street: 'PREFLOP' },
    { position: 'LJ', type: 'FOLD', street: 'PREFLOP' },
    { position: 'HJ', type: 'FOLD', street: 'PREFLOP' },
    { position: 'CO', type: 'RAISE', amountBB: 2.5, street: 'PREFLOP' },
    { position: 'BTN', type: 'FOLD', street: 'PREFLOP' },
    { position: 'SB', type: 'FOLD', street: 'PREFLOP' },
    // NOTE: CALL amountBB is the INCREMENTAL call (BB already posted 1BB), unlike
    // BET/RAISE which are raise-to totals. Verified via reconstruct legality check.
    { position: 'BB', type: 'CALL', amountBB: 1.5, street: 'PREFLOP' },
    { position: 'BB', type: 'CHECK', street: 'FLOP' },
    { position: 'CO', type: 'BET', amountBB: 3.5, street: 'FLOP' },
    { position: 'BB', type: 'RAISE', amountBB: 14, street: 'FLOP' },
  ],
};

async function analyze(input) {
  const r = await fetch(BASE + '/api/analyze', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input }),
  });
  return { status: r.status, body: await r.json() };
}

const variants = [
  ['A 默认画像（无任何对手读牌）', (v) => { delete v.villain; delete v.seatProfiles; }],
  ['B 偏松激进标签 AGGRESSIVE', (v) => { v.seatProfiles = { BB: 'AGGRESSIVE' }; v.villain = { position: 'BB', quickProfile: 'AGGRESSIVE' }; }],
  ['C AGGRESSIVE + 实测 150 手 VPIP42/PFR28', (v) => {
    v.seatProfiles = { BB: 'AGGRESSIVE' };
    v.villain = {
      position: 'BB', quickProfile: 'AGGRESSIVE',
      observedStats: { handsObserved: 150, vpip: 0.42, pfr: 0.28 },
      observedStatsNoteZh: '题目设定（隔离输入）：150 手，VPIP 42%、PFR 28%。',
    };
  }],
  ['D 紧弱标签 TIGHT（反向对照）', (v) => { v.seatProfiles = { BB: 'TIGHT' }; v.villain = { position: 'BB', quickProfile: 'TIGHT' }; }],
];

for (const [label, mutate] of variants) {
  const input = structuredClone(base);
  mutate(input);
  const { status, body } = await analyze(input);
  console.log(`\n${'='.repeat(78)}\n### ${label}\n${'='.repeat(78)}`);
  if (!body.ok) { console.log('FAILED', status, JSON.stringify(body.issues).slice(0, 600)); continue; }

  console.log('decision :', JSON.stringify(body.decision));
  console.log('pot      : computed', body.meta.computedPot, '/ claimed', body.meta.claimedPot);
  console.log('inputHash:', body.meta.inputHash);

  const md = body.viewModel.debug.math;
  const row = (n) => md.find((r) => (r.label ?? '').includes(n));
  for (const n of ['底池:', '可争夺量', '跟注需要', '本街已投入', '本次补入', '我的剩余筹码', '有效筹码', 'SPR', '底池赔率', '所需权益', '对手下注范围权益', '整体范围权益', '跟注 EV', '当前牌力']) {
    const r = row(n);
    if (r) console.log(`  ${r.label}: ${String(r.value).replace(/\s+/g, ' ').slice(0, 150)}`);
  }

  console.log('  --- candidates (engine-generated) ---');
  for (const c of body.viewModel.debug.candidates ?? []) {
    console.log(`    ${c.actionZh} ${c.sizeZh} | EV ${c.evZh} | ${c.feasibleZh}`);
  }

  const pl = body.viewModel.debug.player ?? [];
  console.log('  --- player/profile ---');
  for (const r of pl) console.log(`    ${r.label}: ${String(r.value).replace(/\s+/g, ' ').slice(0, 190)}`);
  for (const r of body.viewModel.debug.profileRange ?? []) {
    if (/权益|维度来源|FINAL_MULTIPLIER|可达组合/.test(r.label)) {
      console.log(`    [range] ${r.label}: ${String(r.value).replace(/\s+/g, ' ').slice(0, 170)}`);
    }
  }
}
