/*
 * 专项审查：① 面对不同位置的打法；② 金额口径。
 * 只读探针（表单路径 + 牌桌路径），不做任何模型改动。
 */
const BASE = 'http://127.0.0.1:5173';

async function post(path, body) {
  const r = await fetch(BASE + path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json() };
}

const analyzeInput = async (input) => (await post('/api/analyze', { input })).json;

const num = (s) => Number(String(s).replace(/[^\d.]/g, ''));

/* ============================================================
 * ① 面对不同位置的打法：换开池者的位置，看对手范围与 Hero 的答案
 * ============================================================ */
console.log('=== ① 开池者位置 → 对手范围宽度 / Hero 权益 / 建议 ===');
console.log('开池位 | 对手范围正权重组合 | 等效宽度 | Hero对下注范围权益 | 整体权益 | 建议 | CALL EV');

const ORDER = ['UTG', 'UTG1', 'UTG2', 'LJ', 'HJ', 'CO', 'BTN'];
for (const opener of ORDER) {
  const idx = ORDER.indexOf(opener);
  const history = [];
  for (let i = 0; i < idx; i++) history.push({ position: ORDER[i], type: 'FOLD', street: 'PREFLOP' });
  history.push({ position: opener, type: 'RAISE', amountBB: 2.5, street: 'PREFLOP' });
  for (let i = idx + 1; i < ORDER.length; i++) history.push({ position: ORDER[i], type: 'FOLD', street: 'PREFLOP' });
  history.push({ position: 'SB', type: 'FOLD', street: 'PREFLOP' });
  // Hero 在 BB 面对开池（只有 Hero 与开池者）
  const input = {
    tableSize: 9, heroPosition: 'BB', heroCards: ['Ah', 'Qh'], board: [], street: 'PREFLOP',
    effectiveStackBB: 100, bigBlindBB: 100, environment: 'LOW_STAKES_ONLINE',
    occupiedPositions: ['UTG', 'UTG1', 'UTG2', 'LJ', 'HJ', 'CO', 'BTN', 'SB', 'BB'],
    buttonPosition: 'BTN',
    actionHistory: history,
  };
  const b = await analyzeInput(input);
  if (!b.ok) { console.log(`${opener.padEnd(6)} | 失败: ${JSON.stringify(b.issues).slice(0, 90)}`); continue; }
  const md = b.viewModel.debug.math;
  const g = (n) => { const x = md.find((y) => (y.label ?? '').includes(n)); return x ? String(x.value).split('｜')[0].trim() : '—'; };
  const rng = b.viewModel.debug.range;
  const rr = (l) => (rng ?? []).find((x) => (x.label ?? '').includes(l))?.value ?? '—';
  console.log(
    `${opener.padEnd(6)} | ${String(rr('正权重组合数')).split('—')[0].trim().padEnd(18)} | ` +
    `${String(rr('有效组合数')).split('（')[0].trim().padEnd(8)} | ${g('对手下注范围权益').padEnd(17)} | ` +
    `${g('整体范围权益').padEnd(8)} | ${b.decision.action} | ${g('跟注 EV')}`,
  );
}

/* ============================================================
 * ② 金额口径：盲注面额、全下与退回、最小加注边界
 * ============================================================ */
console.log('\n=== ② 金额：换 1BB 面额（只应改「筹码数字」，不应改任何 BB 口径判断）===');
const mk = (bigBlindBB) => ({
  tableSize: 6, heroPosition: 'CO', heroCards: ['As', 'Ks'], board: ['Kh', '7c', '2d'], street: 'FLOP',
  effectiveStackBB: 100, bigBlindBB, environment: 'LOW_STAKES_ONLINE',
  occupiedPositions: ['UTG', 'HJ', 'CO', 'BTN', 'SB', 'BB'], buttonPosition: 'BTN', potBB: 6,
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
for (const bb of [100, 50, 20]) {
  const b = await analyzeInput(mk(bb));
  if (!b.ok) { console.log(`1BB=${bb} 筹码 → 失败: ${JSON.stringify(b.issues).slice(0, 110)}`); continue; }
  const md = b.viewModel.debug.math;
  const g = (n) => { const x = md.find((y) => (y.label ?? '').includes(n)); return x ? String(x.value).split('｜')[0].trim() : '—'; };
  console.log(`1BB=${String(bb).padStart(3)} 筹码 → 底池=${g('底池:')}｜SPR=${g('SPR')}｜权益=${g('整体范围权益')}｜建议=${b.decision.action} ${b.decision.sizeChips ?? ''}`);
}

console.log('\n=== ② 金额：短筹码全下（未匹配部分必须退回，不得计入底池）===');
const shortStack = {
  tableSize: 6, heroPosition: 'CO', heroCards: ['As', 'Ks'], board: ['Kh', '7c', '2d'], street: 'FLOP',
  effectiveStackBB: 100, bigBlindBB: 100, environment: 'LOW_STAKES_ONLINE', potBB: 6,
  occupiedPositions: ['UTG', 'HJ', 'CO', 'BTN', 'SB', 'BB'], buttonPosition: 'BTN',
  seatStacksBB: { UTG: 100, HJ: 12, CO: 100, BTN: 100, SB: 100, BB: 100 }, // 对手只有 12BB
  actionHistory: [
    { position: 'UTG', type: 'FOLD', street: 'PREFLOP' },
    { position: 'HJ', type: 'RAISE', amountBB: 2.5, street: 'PREFLOP' },
    { position: 'CO', type: 'CALL', amountBB: 2.5, street: 'PREFLOP' },
    { position: 'BTN', type: 'FOLD', street: 'PREFLOP' },
    { position: 'SB', type: 'FOLD', street: 'PREFLOP' },
    { position: 'BB', type: 'FOLD', street: 'PREFLOP' },
    { position: 'HJ', type: 'CHECK', street: 'FLOP' },
  ],
};
{
  const b = await analyzeInput(shortStack);
  if (!b.ok) { console.log('失败: ' + JSON.stringify(b.issues).slice(0, 200)); }
  else {
    const md = b.viewModel.debug.math;
    for (const n of ['底池:', '我的剩余筹码', '有效筹码', 'SPR', '整体范围权益']) {
      const x = md.find((y) => (y.label ?? '').includes(n));
      if (x) console.log('  ' + x.label + ': ' + String(x.value).split('｜')[0].trim());
    }
    console.log('  建议: ' + b.decision.action + ' ' + (b.decision.sizeChips ?? ''));
    const lp = b.meta.layeredPot;
    if (lp) console.log('  分层底池: total=' + lp.total + ' contested=' + lp.contested + ' returnedTotal=' + lp.returnedTotal + ' pendingTotal=' + lp.pendingTotal);
  }
}
