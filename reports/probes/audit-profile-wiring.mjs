/*
 * 验证「人物画像接线」修复：无手选标签时，实测统计是否终于影响决策。
 * 覆盖两种节点：A) Hero 未被下注（走 betDecision 路径）；B) Hero 面对下注（走 facingBet 路径）。
 */
const BASE = 'http://127.0.0.1:5173';
const analyze = async (input) => {
  const r = await fetch(BASE + '/api/analyze', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ input }),
  });
  return r.json();
};

const pick = (b, labels) => {
  const md = b.viewModel.debug.math;
  const out = {};
  for (const l of labels) {
    const x = md.find((y) => (y.label ?? '').includes(l));
    out[l] = x ? String(x.value).split('｜')[0].trim() : '—';
  }
  return out;
};

/* ---- A) Hero 未被下注：HJ 翻前加注、CO 跟注、翻牌 HJ 过牌 → Hero 可过牌/下注 ---- */
const noBetNode = (stats) => ({
  tableSize: 6, heroPosition: 'CO', heroCards: ['As', 'Ks'], board: ['Kh', '7c', '2d'], street: 'FLOP',
  effectiveStackBB: 100, bigBlindBB: 100, environment: 'LOW_STAKES_ONLINE', potBB: 6.5,
  occupiedPositions: ['UTG', 'HJ', 'CO', 'BTN', 'SB', 'BB'], buttonPosition: 'BTN',
  ...(stats === null ? {} : { villain: { observedStats: stats } }),
  actionHistory: [
    { position: 'UTG', type: 'FOLD', street: 'PREFLOP' },
    { position: 'HJ', type: 'RAISE', amountBB: 2.5, street: 'PREFLOP' },
    { position: 'CO', type: 'CALL', amountBB: 2.5, street: 'PREFLOP' },
    { position: 'BTN', type: 'FOLD', street: 'PREFLOP' },
    { position: 'SB', type: 'FOLD', street: 'PREFLOP' },
    { position: 'BB', type: 'FOLD', street: 'PREFLOP' },
    { position: 'HJ', type: 'CHECK', street: 'FLOP' },
  ],
});

/* ---- B) Hero 面对下注（KQ 黄金节点）---- */
const facingNode = (stats) => ({
  tableSize: 9, heroPosition: 'CO', heroCards: ['Ks', 'Qs'], board: ['Qh', '9s', '5s'], street: 'FLOP',
  effectiveStackBB: 100, bigBlindBB: 100, environment: 'LOW_STAKES_ONLINE', potBB: 23,
  occupiedPositions: ['UTG', 'UTG1', 'UTG2', 'LJ', 'HJ', 'CO', 'BTN', 'SB', 'BB'], buttonPosition: 'BTN',
  ...(stats === null ? {} : { villain: { observedStats: stats } }),
  actionHistory: [
    { position: 'UTG', type: 'FOLD', street: 'PREFLOP' }, { position: 'UTG1', type: 'FOLD', street: 'PREFLOP' },
    { position: 'UTG2', type: 'FOLD', street: 'PREFLOP' }, { position: 'LJ', type: 'FOLD', street: 'PREFLOP' },
    { position: 'HJ', type: 'FOLD', street: 'PREFLOP' },
    { position: 'CO', type: 'RAISE', amountBB: 2.5, street: 'PREFLOP' },
    { position: 'BTN', type: 'FOLD', street: 'PREFLOP' }, { position: 'SB', type: 'FOLD', street: 'PREFLOP' },
    { position: 'BB', type: 'CALL', amountBB: 1.5, street: 'PREFLOP' },
    { position: 'BB', type: 'CHECK', street: 'FLOP' },
    { position: 'CO', type: 'BET', amountBB: 3.5, street: 'FLOP' },
    { position: 'BB', type: 'RAISE', amountBB: 14, street: 'FLOP' },
  ],
});

const CASES = [
  ['无实测统计（基线）', null],
  ['vpip=0.15 / pfr=0.10（紧）', { handsObserved: 60, vpip: 0.15, pfr: 0.10 }],
  ['vpip=0.85 / pfr=0.60（松凶）', { handsObserved: 60, vpip: 0.85, pfr: 0.60 }],
];

for (const [name, node] of [['A）Hero 未被下注（betDecision 路径）', noBetNode], ['B）Hero 面对下注（facingBet 路径）', facingNode]]) {
  console.log(`\n########## ${name} ##########`);
  for (const [label, stats] of CASES) {
    const b = await analyze(node(stats));
    if (!b.ok) { console.log(`${label} → 失败: ${JSON.stringify(b.issues).slice(0, 110)}`); continue; }
    const v = pick(b, ['整体范围权益', '对手下注范围权益', '跟注 EV', '底池赔率']);
    const cand = (b.viewModel.debug.candidates ?? []).filter((c) => c.ev !== null).map((c) => c.sizeZh + ':' + c.evZh.split(' ')[0]);
    console.log(
      `${label.padEnd(26)} | 建议=${(b.decision.action + ' ' + (b.decision.sizeBB ?? '')).padEnd(12)} | ` +
      `整体=${v['整体范围权益'].padEnd(7)} | 对下注=${v['对手下注范围权益'].padEnd(7)} | CALL EV=${v['跟注 EV']}`,
    );
    if (cand.length) console.log(`   候选 EV: ${cand.join('  ')}`);
  }
}
