/*
 * 阶段二证据：黄金局面的**逐尺寸** EV 表（每个尺寸各自的分支概率与条件权益）。
 * 只读探针；不改生产代码。
 */
const BASE = 'http://127.0.0.1:5173';

const input = {
  tableSize: 9, heroPosition: 'CO', heroCards: ['Ks', 'Qs'], board: ['Qh', '9s', '5s'],
  street: 'FLOP', effectiveStackBB: 100, bigBlindBB: 100, environment: 'LOW_STAKES_ONLINE',
  occupiedPositions: ['UTG', 'UTG1', 'UTG2', 'LJ', 'HJ', 'CO', 'BTN', 'SB', 'BB'],
  buttonPosition: 'BTN', potBB: 23,
  actionHistory: [
    { position: 'UTG', type: 'FOLD', street: 'PREFLOP' },
    { position: 'UTG1', type: 'FOLD', street: 'PREFLOP' },
    { position: 'UTG2', type: 'FOLD', street: 'PREFLOP' },
    { position: 'LJ', type: 'FOLD', street: 'PREFLOP' },
    { position: 'HJ', type: 'FOLD', street: 'PREFLOP' },
    { position: 'CO', type: 'RAISE', amountBB: 2.5, street: 'PREFLOP' },
    { position: 'BTN', type: 'FOLD', street: 'PREFLOP' },
    { position: 'SB', type: 'FOLD', street: 'PREFLOP' },
    { position: 'BB', type: 'CALL', amountBB: 1.5, street: 'PREFLOP' },
    { position: 'BB', type: 'CHECK', street: 'FLOP' },
    { position: 'CO', type: 'BET', amountBB: 3.5, street: 'FLOP' },
    { position: 'BB', type: 'RAISE', amountBB: 14, street: 'FLOP' },
  ],
};

const r = await fetch(BASE + '/api/analyze', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ input }),
});
const b = await r.json();
const dg = b.viewModel.debug;
const md = dg.math;
const g = (n) => { const x = md.find((y) => (y.label ?? '').includes(n)); return x ? String(x.value).split('｜')[0].trim() : '?'; };

console.log(`decision = ${b.decision.action} ${b.decision.sizeBB}BB   inputHash = ${b.meta.inputHash}`);
console.log(`timings  = ${JSON.stringify(b.meta.timings)}`);
console.log(`CALL EV  = ${g('跟注 EV')}`);
console.log(`可争夺量 = ${g('可争夺量')}`);
console.log('');
console.log('| 本街累计 | 新增投入 | EV | P(弃) | P(跟) | P(再加) | 条件权益 | 评估状态 |');
console.log('|---|---:|---:|---:|---:|---:|---:|---|');

const rows = (dg.candidates ?? []).filter((c) => /加注|全下/.test(c.actionZh));
const parsed = [];
for (const c of rows) {
  const ev = c.evZh;
  const m = ev.match(/^([\d.]+) 筹码[^｜]*｜本尺寸：弃 ([\d.]+)% \/ 跟 ([\d.]+)% \/ 再加注 ([\d.]+)%｜条件权益 ([\d.]+)%/);
  const status = /近似计算/.test(ev) ? '近似计算' : (/已完整计算/.test(ev) ? '已完整计算' : '未计算');
  parsed.push({ size: c.sizeZh, ev: m ? Number(m[1]) : null, fold: m ? m[2] : '—', call: m ? m[3] : '—', rr: m ? m[4] : '—', eq: m && m[5] ? `${m[5]}%` : '—', status });
  console.log(`| ${c.sizeZh} | — | ${m ? m[1] : ev.slice(0, 24)} | ${m ? m[2] : '—'} | ${m ? m[3] : '—'} | ${m ? m[4] : '—'} | ${m && m[5] ? m[5] + '%' : '—'} | ${status} |`);
}

const withEV = parsed.filter((p) => p.ev !== null);
if (withEV.length > 0) {
  const best = withEV.reduce((a, x) => (x.ev > a.ev ? x : a));
  const chosen = parsed.find((p) => p.size === `${b.decision.sizeBB.toFixed(1)}BB`);
  console.log('');
  console.log(`最高 EV 尺寸 = ${best.size}（${best.ev}）`);
  console.log(`引擎选中尺寸 = ${b.decision.sizeBB}BB${chosen && chosen.ev !== null ? `（EV ${chosen.ev}）` : ''}`);
  if (chosen && chosen.ev !== null) {
    console.log(`选中 vs 最高之差 = ${(best.ev - chosen.ev).toFixed(2)} 筹码`);
    // 容差带 = 5% × winnable（winnable 从「可争夺量」行取第一个数）
    const winnable = Number((String(g('可争夺量')).match(/[\d.]+/) ?? ['0'])[0]);
    const band = 0.05 * winnable;
    console.log(`可争夺量 = ${winnable} 筹码 ⇒ 工程容差带 = ±${band.toFixed(2)} 筹码`);
    console.log(`⇒ 选中与最高的差是否**超出**容差带：${best.ev - chosen.ev > band ? '是（可据此认为该尺寸更好）' : '否（**在容差带内 ⇒ 不构成「这个尺寸更好」的证据**）'}`);
  }
  const vals = withEV.map((p) => p.ev);
  console.log(`尺寸间 EV 极差 = ${(Math.max(...vals) - Math.min(...vals)).toFixed(2)} chips（${Math.min(...vals)} … ${Math.max(...vals)}）`);
}
