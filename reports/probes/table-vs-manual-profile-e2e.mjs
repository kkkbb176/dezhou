/**
 * 「手动录入」vs「牌桌页点击」**同节点**对照：画像到底改不改「牌力的下注」？
 *
 * ## 为什么要两条路径对跑
 *
 * 用户的判据是：**如果手动录入会变、牌桌页点击不变 ⇒ 牌桌接线有 bug**。
 * 所以必须把**同一个局面**分别通过两条路径跑，逐项对照：
 *
 * | 路径 | 怎么进 | 画像从哪来 |
 * |---|---|---|
 * | 手动录入 | `POST /api/analyze { input }` | `input.villain.quickProfile` |
 * | 牌桌页点击 | `POST /api/table`（op 序列）→ `POST /api/analyze { table }` | 座位 → `tableAdapter` → `villain.quickProfile` |
 *
 * ## 两种节点（这就是「下注」与「面对下注」的区别）
 *
 * | 场景 | 行动序列 | 期望画像是否影响 |
 * |---|---|---|
 * | A 被过牌到（**Hero 要下注**） | BB CHECK ⇒ Hero CO | 取决于**下注 EV 是否建模** |
 * | B 面对下注 | BB BET ⇒ Hero CO | 应当影响（响应/面对下注通道） |
 *
 * ⚠️ 指向隔离实例（独立端口 + `DSH_PLAYER_HISTORY_DIR`）。
 * ⚠️ 为排除"历史统计"干扰，牌桌一律把对手换成**全新玩家**（无 `observedStats`），
 *    这样牌桌路径的 villain 只剩 `quickProfile`，与手动录入严格可比。
 *
 * ```powershell
 * node reports/probes/table-vs-manual-profile-e2e.mjs
 * ```
 */

const BASE = process.env.TABLE_BASE ?? 'http://127.0.0.1:5199';
let seq = 0;

async function post(path, body) {
  const r = await fetch(BASE + path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return await r.json();
}

/* ---------------- 手动录入路径 ---------------- */

const POS9 = ['UTG', 'UTG1', 'UTG2', 'LJ', 'HJ', 'CO', 'BTN', 'SB', 'BB'];
const manualInput = (quickProfile, scenario) => ({
  tableSize: 9,
  heroPosition: 'CO',
  heroCards: ['Ks', 'Qs'],
  board: ['Qh', '9s', '5s'],
  street: 'FLOP',
  effectiveStackBB: 100,
  bigBlindBB: 100,
  environment: 'LOW_STAKES_ONLINE',
  occupiedPositions: POS9,
  buttonPosition: 'BTN',
  villain: { seatId: 'seat_BB', quickProfile },
  actionHistory: [
    ...POS9.slice(0, 5).map((p) => ({ position: p, type: 'FOLD', street: 'PREFLOP' })),
    { position: 'CO', type: 'RAISE', amountBB: 2.5, street: 'PREFLOP' },
    { position: 'BTN', type: 'FOLD', street: 'PREFLOP' },
    { position: 'SB', type: 'FOLD', street: 'PREFLOP' },
    { position: 'BB', type: 'CALL', amountBB: 1.5, street: 'PREFLOP' },
    /*
     * ⚠️ 翻后 {CO, BB} 里 **BB 先行动** ⇒ 该座位在翻牌只能有**一个**动作：
     * 要构造「面对下注」，BB 必须**直接下注**（不能先 CHECK 再 BET —— 那是同一人两次行动，
     * 实测被 `ACTION_NOT_ACTOR` 拦下，本脚本第一版正是这个错）。
     */
    ...(scenario === 'facingBet'
      ? [{ position: 'BB', type: 'BET', amountBB: 3.5, street: 'FLOP' }]
      : [{ position: 'BB', type: 'CHECK', street: 'FLOP' }]),
  ],
});

const summarize = (b, tag) => {
  if (!b?.ok) return { tag, decision: `失败[${(b?.issues ?? []).map((i) => i.code).join(',')}]`, hash: '—', evs: '—', sizes: '—' };
  const cands = b.viewModel?.debug?.candidates ?? [];
  const call = cands.find((c) => /跟注/.test(c.actionZh ?? ''));
  const bets = cands.filter((c) => /下注|加注/.test(c.actionZh ?? ''));
  const clean = (s) => String(s ?? '—').replace(/\*\*/g, '').replace(/（.*/s, '').replace(/筹码/, '').trim();
  return {
    tag,
    decision: `${b.decision.action}${b.decision.sizeBB ? ' ' + b.decision.sizeBB + 'BB' : ''}`,
    hash: b.meta?.inputHash ?? '—',
    callEV: clean(call?.evZh),
    sizes: bets.map((c) => String(c.sizeZh).trim()).join('/') || '—',
    evs: bets.map((c) => clean(c.evZh)).join(' | ') || '—',
  };
};

/* ---------------- 牌桌页路径 ---------------- */

async function tablePath(quickProfile, scenario) {
  let state = null;
  const op = async (kind, extra = {}) => {
    const id = `tvmp-${Date.now().toString(36)}-${++seq}-${kind}`;
    const body = state === null
      ? { tableSize: 9, heroPosition: 'CO', requestId: id }
      : { state, op: { kind, ...extra }, requestId: id };
    const r = await post('/api/table', body);
    if (!r?.ok) throw new Error(`${kind}: ${JSON.stringify(r?.issues ?? r).slice(0, 200)}`);
    state = r.state;
  };

  await op('NEW_TABLE');
  await op('FILL_EMPTY_SEATS');
  const seatOf = (p) => state.seats.find((s) => s.logicalPosition === p)?.seatId;
  const bb = seatOf('BB');
  const btn = state.buttonSeatId;
  const btnWasBb = btn === bb;

  /* 把 BB 换成全新玩家（无历史）⇒ 牌桌路径的 villain 只剩 quickProfile，与手动录入可比 */
  await op('CLEAR_SEAT', { seatId: bb, activeHandChoice: 'LEAVE_AFTER_HAND' });
  await op('NEXT_HAND');
  await op('ADD_PLAYER', { seatId: bb });
  await op('SET_BUTTON', { seatId: btnWasBb ? seatOf('BTN') : btn });
  if (quickProfile !== 'UNKNOWN') await op('SET_PROFILE', { seatId: bb, quickProfile });

  await op('SET_HERO_CARD', { card: 'Ks' });
  await op('SET_HERO_CARD', { card: 'Qs' });
  const posOf = (seatId) => state.seats.find((s) => s.seatId === seatId)?.logicalPosition;
  const act = async (type, amountChips) => {
    const action = { position: posOf(state.currentActorSeatId), type };
    if (amountChips !== undefined) action.amountChips = amountChips;
    await op('ACT', { action });
  };
  for (let i = 0; i < 5; i++) await act('FOLD');
  await act('RAISE', 250);
  await act('FOLD');
  await act('FOLD');
  await act('CALL', 150);
  await op('SET_BOARD_CARD', { card: 'Qh', slot: 0 });
  await op('SET_BOARD_CARD', { card: '9s', slot: 1 });
  await op('SET_BOARD_CARD', { card: '5s', slot: 2 });
  /* 翻后 {CO, BB}：BB 先行动 ⇒ 一个动作就够（要面对下注就让 BB 直接下注） */
  if (scenario === 'facingBet') await act('BET', 350);
  else await act('CHECK');

  const boundSeat = state.seats.find((s) => s.logicalPosition === 'BB');
  const boundProfile = state.playersById?.[boundSeat?.playerId]?.quickProfile;
  const b = await post('/api/analyze', { table: state, requestToken: 1 });
  return { ...summarize(b, 'table'), boundProfile, heroCards: 'KsQs' };
}

/* ---------------- 跑 ---------------- */

const PROFILES = ['UNKNOWN', 'MANIAC', 'VERY_TIGHT', 'CALLING_STATION'];
console.log(`目标实例：${BASE}\n`);

for (const scenario of ['checkedTo', 'facingBet']) {
  console.log(`\n════════ 场景 ${scenario === 'checkedTo' ? 'A：BB 过牌 ⇒ Hero CO 要**下注**' : 'B：BB 下注 3.5BB ⇒ Hero CO **面对下注**'} ════════`);
  const manualRows = [];
  const tableRows = [];
  for (const p of PROFILES) {
    manualRows.push(summarize(await post('/api/analyze', { input: manualInput(p, scenario) }), `手动 ${p}`));
    try { tableRows.push(await tablePath(p, scenario)); }
    catch (e) { tableRows.push({ tag: `牌桌 ${p}`, decision: 'FAILED: ' + e.message, hash: '—', callEV: '—', sizes: '—', evs: '—', boundProfile: '?' }); }
  }

  const show = (rows) => rows.forEach((r) => {
    console.log(`  ${r.tag.padEnd(26)} ${String(r.decision).padEnd(12)} hash=${String(r.hash).padEnd(11)}` +
      ` 跟注EV=${String(r.callEV).padEnd(9)} 下注EV=${String(r.evs).slice(0, 40)}` +
      (r.boundProfile !== undefined ? ` 座位画像=${String(r.boundProfile)}` : ''));
  });
  console.log('\n  --- 手动录入路径 ---'); show(manualRows);
  console.log('  --- 牌桌页点击路径 ---'); show(tableRows);

  const distinct = (rows, k) => new Set(rows.map((r) => String(r[k]))).size;
  console.log(`\n  手动路径：建议有 ${distinct(manualRows, 'decision')} 种 / 跟注EV 有 ${distinct(manualRows, 'callEV')} 种`);
  console.log(`  牌桌路径：建议有 ${distinct(tableRows, 'decision')} 种 / 跟注EV 有 ${distinct(tableRows, 'callEV')} 种`);
  const manualChanges = distinct(manualRows, 'decision') > 1 || distinct(manualRows, 'callEV') > 1;
  const tableChanges = distinct(tableRows, 'decision') > 1 || distinct(tableRows, 'callEV') > 1;
  console.log(`  ⇒ 手动会变=${manualChanges ? '是' : '否'}，牌桌会变=${tableChanges ? '是' : '否'} ⇒ ` +
    `${manualChanges === tableChanges ? '**两条路径行为一致**（没有牌桌特有缺陷）' : '★ 两条路径行为不一致 ⇒ 牌桌接线有缺陷'}`);
}
