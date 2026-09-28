/*
 * 阶段四端到端验证：把 BB 绑定到**不同真实玩家**（库里已有历史），
 * 走**牌桌路径**（POST /api/table + /api/analyze {table}），比较响应概率与 EV。
 *
 * 对照组：BB = 全新玩家（无历史）⇒ 无 observedStats 注入。
 * 只有 A/B 与 C 出现差异、且 A 与 B 之间也有差异，才能报告「真实画像已生效」。
 */
const BASE = 'http://127.0.0.1:5173';
let seq = 0;
const post = async (path, body) => {
  const r = await fetch(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json() };
};

async function buildAndPlay(bbBinding) {
  let state = null, preview = null;
  const op = async (kind, extra = {}) => {
    const id = `p4-${Date.now().toString(36)}-${++seq}-${kind}`;
    const body = state === null
      ? { tableSize: 9, heroPosition: 'CO', requestId: id }
      : { state, op: { kind, ...extra }, requestId: id };
    const r = await post('/api/table', body);
    if (!r.json?.ok) throw new Error(`${kind} failed: ${r.text?.slice(0, 200) ?? JSON.stringify(r.json).slice(0, 200)}`);
    state = r.json.state; preview = r.json.preview;
    return r.json;
  };

  await op('NEW_TABLE');
  await op('FILL_EMPTY_SEATS');
  await op('SET_HERO_CARD', { card: 'Ks' });
  await op('SET_HERO_CARD', { card: 'Qs' });

  // 找到 BB 座位，换成指定绑定
  const bb = state.seats.find((s) => s.logicalPosition === 'BB');
  if (!bb) throw new Error('no BB seat');
  await op('CLEAR_SEAT', { seatId: bb.seatId });
  await op('ADD_PLAYER', bbBinding.playerId === null
    ? { seatId: bb.seatId }
    : { seatId: bb.seatId, playerId: bbBinding.playerId, displayName: bbBinding.displayName });

  const posOf = (seatId) => state.seats.find((s) => s.seatId === seatId)?.logicalPosition;
  const act = async (type, toChips) => {
    const action = { position: posOf(preview.currentActorSeatId), type };
    if (toChips !== undefined) action.amountChips = toChips;
    await op('ACT', { action });
  };

  // 打一手：翻前全部弃到 CO，CO 加注 2.5BB，SB 弃，BB 跟注；翻牌 BB 过牌、CO 下注 3.5BB、BB 加注到 14BB
  const order = ['UTG', 'UTG1', 'UTG2', 'LJ', 'HJ'];
  for (let i = 0; i < order.length; i++) await act('FOLD');
  await act('RAISE', 250);          // CO (Hero)
  await act('FOLD');                // BTN
  await act('FOLD');                // SB
  await act('CALL');                // BB 跟注
  if (state.street !== 'FLOP') {
    // 引擎会自动发翻牌
  }
  await act('CHECK');               // BB 过牌
  await act('BET', 350);            // CO 下注 3.5BB
  await act('RAISE', 1400);         // BB 加注到 14BB

  const r = await post('/api/analyze', { table: state, requestToken: 1 });
  if (!r.json?.ok) throw new Error('analyze failed: ' + JSON.stringify(r.json).slice(0, 300));
  const b = r.json;
  const md = b.viewModel.debug.math;
  const g = (n) => { const x = md.find((y) => (y.label ?? '').includes(n)); return x ? String(x.value).split('｜')[0].trim() : '?'; };
  const raise42 = (b.viewModel.debug.candidates ?? []).find((c) => c.sizeZh === '42.0BB');
  const rr = (raise42?.evZh ?? '').match(/弃 ([\d.]+)% \/ 跟 ([\d.]+)% \/ 再加注 ([\d.]+)%｜条件权益 ([\d.]+)%/);
  return {
    decision: `${b.decision.action} ${b.decision.sizeBB}BB`,
    hash: b.meta.inputHash,
    eqBet: g('对手下注范围权益'),
    eqWhole: g('整体范围权益'),
    callEV: g('跟注 EV'),
    raise42EV: raise42?.evZh?.slice(0, 40) ?? '?',
    fold: rr?.[1], call: rr?.[2], reRaise: rr?.[3], condEq: rr?.[4],
    note: ((b.viewModel.debug.player ?? []).find((x) => x.label === '实测统计来源')?.value ?? '（无 measuredStats）').slice(0, 150),
  };
}

const cases = [
  ['C 对照：BB = 全新玩家（无历史）', { playerId: null, displayName: null }],
  ['A BB = p3（57 手，VPIP 71.9% / PFR 0% / 3Bet 0%）', { playerId: 'p3', displayName: '玩家3' }],
  ['B BB = p4（57 手，VPIP 73.7% / PFR 7.0% / 3Bet 8.3%）', { playerId: 'p4', displayName: '玩家4' }],
];

const out = [];
for (const [label, binding] of cases) {
  try {
    const r = await buildAndPlay(binding);
    out.push([label, r]);
    console.log(`\n### ${label}`);
    console.log(`  决策=${r.decision}  hash=${r.hash}`);
    console.log(`  对下注范围权益=${r.eqBet}  整体范围权益=${r.eqWhole}  CALL EV=${r.callEV}`);
    console.log(`  RAISE 42BB：${r.raise42EV}`);
    console.log(`  42BB 分支：弃 ${r.fold}% / 跟 ${r.call}% / 再加注 ${r.reRaise}%  条件权益 ${r.condEq}%`);
    console.log(`  统计披露：${r.note}`);
  } catch (e) {
    console.log(`\n### ${label}\n  FAILED: ${e.message}`);
  }
}

console.log('\n=== 结论判定 ===');
if (out.length >= 2) {
  const c = out.find(([l]) => l.startsWith('C'))?.[1];
  const a = out.find(([l]) => l.startsWith('A'))?.[1];
  const b = out.find(([l]) => l.startsWith('B'))?.[1];
  const diff = (x, y, k) => (x && y ? (x[k] === y[k] ? '相同' : `不同（${x[k]} vs ${y[k]}）`) : 'n/a');
  if (c && a) console.log(`  对照 C vs A（有无真实画像）：权益 ${diff(c, a, 'eqWhole')}｜CALL EV ${diff(c, a, 'callEV')}｜弃牌率 ${diff(c, a, 'fold')}`);
  if (a && b) console.log(`  A vs B（两个不同真实玩家）：权益 ${diff(a, b, 'eqWhole')}｜CALL EV ${diff(a, b, 'callEV')}｜弃牌率 ${diff(a, b, 'fold')}`);
}
