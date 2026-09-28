/*
 * 验证：不同画像在 翻前 / 翻牌 / 河牌 是否给出不同输出。
 * 每个节点同一手牌、同一行动，只改对手实测统计。
 */
const BASE = 'http://127.0.0.1:5173';
const A = async (input) => (await fetch(BASE + '/api/analyze', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ input }),
})).json();

const POS9 = ['UTG', 'UTG1', 'UTG2', 'LJ', 'HJ', 'CO', 'BTN', 'SB', 'BB'];
const pre = (opener, to = 2.5) => {
  const i = POS9.indexOf(opener);
  const h = [];
  for (let k = 0; k < i; k++) h.push({ position: POS9[k], type: 'FOLD', street: 'PREFLOP' });
  h.push({ position: opener, type: 'RAISE', amountBB: to, street: 'PREFLOP' });
  for (let k = i + 1; k < POS9.indexOf('SB'); k++) h.push({ position: POS9[k], type: 'FOLD', street: 'PREFLOP' });
  h.push({ position: 'SB', type: 'FOLD', street: 'PREFLOP' });
  return h;
};

/* 翻前：Hero 在 BB 面对 BTN 开池 2.5BB */
const preflopNode = (stats) => ({
  tableSize: 9, heroPosition: 'BB', heroCards: ['Ah', 'Qh'], board: [], street: 'PREFLOP',
  effectiveStackBB: 100, bigBlindBB: 100, environment: 'LOW_STAKES_ONLINE',
  occupiedPositions: POS9, buttonPosition: 'BTN',
  ...(stats === null ? {} : { villain: { observedStats: stats } }),
  actionHistory: pre('BTN'),
});

/* 翻牌：KQ 黄金节点（Hero 面对过牌-加注） */
const flopNode = (stats) => ({
  tableSize: 9, heroPosition: 'CO', heroCards: ['Ks', 'Qs'], board: ['Qh', '9s', '5s'], street: 'FLOP',
  effectiveStackBB: 100, bigBlindBB: 100, environment: 'LOW_STAKES_ONLINE', potBB: 23,
  occupiedPositions: POS9, buttonPosition: 'BTN',
  ...(stats === null ? {} : { villain: { observedStats: stats } }),
  actionHistory: [
    ...pre('CO'), { position: 'BB', type: 'CALL', amountBB: 1.5, street: 'PREFLOP' },
    { position: 'BB', type: 'CHECK', street: 'FLOP' },
    { position: 'CO', type: 'BET', amountBB: 3.5, street: 'FLOP' },
    { position: 'BB', type: 'RAISE', amountBB: 14, street: 'FLOP' },
  ],
});

/* 河牌：Hero 在 BB 面对 BTN 开池后打到河牌、对手下注 */
const riverNode = (stats) => ({
  tableSize: 9, heroPosition: 'BB', heroCards: ['Ah', 'Kd'], board: ['Kh', '8c', '3d', '2s', '7h'], street: 'RIVER',
  effectiveStackBB: 100, bigBlindBB: 100, environment: 'LOW_STAKES_ONLINE', potBB: 18.5,
  occupiedPositions: POS9, buttonPosition: 'BTN',
  ...(stats === null ? {} : { villain: { observedStats: stats } }),
  actionHistory: [
    ...pre('BTN'), { position: 'BB', type: 'CALL', amountBB: 1.5, street: 'PREFLOP' },
    { position: 'BB', type: 'CHECK', street: 'FLOP' }, { position: 'BTN', type: 'CHECK', street: 'FLOP' },
    { position: 'BB', type: 'CHECK', street: 'TURN' }, { position: 'BTN', type: 'CHECK', street: 'TURN' },
    { position: 'BB', type: 'CHECK', street: 'RIVER' }, { position: 'BTN', type: 'BET', amountBB: 13, street: 'RIVER' },
  ],
});

const PROFILES = [
  ['无实测统计（基线）', null],
  ['紧：VPIP 15% / PFR 10%', { handsObserved: 80, vpip: 0.15, pfr: 0.10 }],
  ['松凶：VPIP 85% / PFR 60%', { handsObserved: 80, vpip: 0.85, pfr: 0.60 }],
  ['河牌爱弃：foldToRiverBet 70%', { handsObserved: 80, foldToRiverBet: 0.70 }],
];

for (const [name, node] of [['翻前（BB 面对 BTN 开池）', preflopNode], ['翻牌（面对过牌-加注）', flopNode], ['河牌（面对下注）', riverNode]]) {
  console.log(`\n########## ${name} ##########`);
  for (const [label, stats] of PROFILES) {
    const b = await A(node(stats));
    if (!b.ok) { console.log(`${label.padEnd(28)} → 失败: ${JSON.stringify(b).slice(0, 130)}`); continue; }
    const md = b.viewModel.debug.math;
    const g = (n) => { const x = md.find((y) => (y.label ?? '').includes(n)); return x ? String(x.value).split('｜')[0].trim() : '—'; };
    console.log(
      `${label.padEnd(28)} | 建议=${(b.decision.action + ' ' + (b.decision.sizeBB ?? '')).padEnd(12)} | ` +
      `整体=${g('整体范围权益').padEnd(7)} | 跟注EV=${g('跟注 EV')}`,
    );
  }
}
