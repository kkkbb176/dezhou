/*
 * 阶段四端到端证明：**真实玩家画像是否改变生产决策**。
 *
 * 路径：真实历史 JSONL →（落座注入 observedStats）→ /api/table 牌桌路径
 *       → /api/analyze {table} → 响应概率 / 条件权益 / EV
 *
 * 三组对照（BB 座位分别绑定不同身份的玩家，其余一切相同）：
 *   C：全新玩家（无历史）
 *   A：p3（VPIP 71.9% / PFR 0.0% / 3Bet 0.0%）
 *   B：p1（VPIP 100% / PFR 48.1% / 3Bet 60.0%）
 *
 * ⚠️ 服务端必须以 DSH_PLAYER_HISTORY_DIR 指向**隔离目录**运行，否则本探针
 *    会写入真实玩家历史（上一轮已实测过该缺口）。
 */
const BASE = 'http://127.0.0.1:5173';
let seq = 0;

async function post(path, body) {
  const r = await fetch(BASE + path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json() };
}

/**
 * 建桌 → 把 BB 换成**指定身份**的玩家 → 打到「翻牌面对过牌-加注」决策点。
 *
 * ⚠️ 两个实测约束（第一版探针踩到）：
 * ① `FILL_EMPTY_SEATS` 会把**历史里已有的玩家**（p1…p9）安排到座位上 ⇒
 *    「新玩家」并不是无历史的对照，必须显式新建；
 * ② 同一 `playerId` 不能同时占两个座位（引擎会以自相矛盾拒绝）⇒
 *    要绑的人若已在别座，必须先把那一座腾空，并在腾空处补一名**全新**玩家，
 *    以保证各组的**人数与场景完全一致**（否则 8 人桌 vs 9 人桌不可比）。
 */
async function runCase(binding) {
  let state = null, preview = null;
  const op = async (kind, extra = {}) => {
    const id = `p4e2e-${Date.now().toString(36)}-${++seq}-${kind}`;
    const body = state === null
      ? { tableSize: 9, heroPosition: 'CO', requestId: id }
      : { state, op: { kind, ...extra }, requestId: id };
    const r = await post('/api/table', body);
    if (!r.json?.ok) throw new Error(`${kind}: ${JSON.stringify(r.json?.issues ?? r.json).slice(0, 220)}`);
    state = r.json.state; preview = r.json.preview;
  };

  await op('NEW_TABLE');
  await op('FILL_EMPTY_SEATS');
  /** 🔴 `NEXT_HAND` 会**轮转庄家位** ⇒ 各组的行动顺序会漂移、场景不再可比。
   *  记下开桌时的庄家座位，换手后用 `SET_BUTTON` **钉回原位**（本手未开始时允许）。 */
  const buttonSeatId = state.buttonSeatId;

  const bbSeatId = state.seats.find((s) => s.logicalPosition === 'BB').seatId;
  // 目标玩家可能已被安排在别座 ⇒ 记下那一座，稍后补人
  const occupiedByTarget = binding.playerId === null
    ? null
    : state.seats.find((s) => s.playerId === binding.playerId)?.seatId ?? null;

  await op('CLEAR_SEAT', { seatId: bbSeatId, activeHandChoice: 'LEAVE_AFTER_HAND' });
  if (occupiedByTarget !== null && occupiedByTarget !== bbSeatId) {
    await op('CLEAR_SEAT', { seatId: occupiedByTarget, activeHandChoice: 'LEAVE_AFTER_HAND' });
  }
  await op('NEXT_HAND');
  await op('ADD_PLAYER', binding.playerId === null
    ? { seatId: bbSeatId }                                  // 全新玩家（无历史）
    : { seatId: bbSeatId, playerId: binding.playerId, displayName: binding.displayName });
  if (occupiedByTarget !== null && occupiedByTarget !== bbSeatId) {
    await op('ADD_PLAYER', { seatId: occupiedByTarget });   // 补一名全新玩家，保持 9 人
  }
  /* ⚠️ `SET_BUTTON` 必须在**座位补齐之后**：庄家座位若空着会被拒
     （实测 `SEAT_EMPTY` —— 目标玩家原本就坐在 BTN 上，腾空后尚未补人）。 */
  await op('SET_BUTTON', { seatId: buttonSeatId });   // ← 钉回庄家位，恢复与各组一致的顺序
  await op('SET_HERO_CARD', { card: 'Ks' });
  await op('SET_HERO_CARD', { card: 'Qs' });

  const boundPlayer = state.seats.find((s) => s.seatId === bbSeatId)?.playerId;
  const injected = state.playersById[boundPlayer]?.observedStats ?? null;
  const seatCount = state.seats.filter((s) => s.playerId !== null).length;

  const posOf = (seatId) => state.seats.find((s) => s.seatId === seatId)?.logicalPosition;
  const act = async (type, toChips) => {
    const action = { position: posOf(preview.currentActorSeatId), type };
    if (toChips !== undefined) action.amountChips = toChips;
    await op('ACT', { action });
  };

  // 翻前：弃到 CO → 加注 2.5BB → BTN/SB 弃 → BB 跟注
  for (let i = 0; i < 5; i++) await act('FOLD');
  await act('RAISE', 250);
  await act('FOLD');
  await act('FOLD');
  await act('CALL', 150);
  // 发翻牌（牌桌路径必须手动录公共牌）
  await op('SET_BOARD_CARD', { card: 'Qh', slot: 0 });
  await op('SET_BOARD_CARD', { card: '9s', slot: 1 });
  await op('SET_BOARD_CARD', { card: '5s', slot: 2 });
  // 翻牌：BB 过牌 → CO 下注 3.5BB → BB 加注到 14BB
  await act('CHECK');
  await act('BET', 350);
  await act('RAISE', 1400);

  const r = await post('/api/analyze', { table: state, requestToken: 1 });
  if (!r.json?.ok) throw new Error('analyze: ' + JSON.stringify(r.json).slice(0, 300));
  const b = r.json;
  const md = b.viewModel.debug.math;
  const g = (n) => { const x = md.find((y) => (y.label ?? '').includes(n)); return x ? String(x.value).split('｜')[0].trim() : '?'; };
  const raise42 = (b.viewModel.debug.candidates ?? []).find((c) => c.sizeZh === '42.0BB');
  const rr = (raise42?.evZh ?? '').match(/弃 ([\d.]+)% \/ 跟 ([\d.]+)% \/ 再加注 ([\d.]+)%｜条件权益 ([\d.]+)%/);
  const measured = (b.viewModel.debug.player ?? []).find((x) => x.label === '本次进入模型')?.value
    ?? '（无 measuredStats —— 未绑定真实玩家或该玩家无统计）';
  return {
    boundPlayer, injected, seatCount,
    decision: `${b.decision.action} ${b.decision.sizeBB}BB`,
    hash: b.meta.inputHash,
    eqBet: g('对手下注范围权益'),
    eqWhole: g('整体范围权益'),
    callEV: g('跟注 EV'),
    fold: rr?.[1] ?? '—', call: rr?.[2] ?? '—', reRaise: rr?.[3] ?? '—', condEq: rr?.[4] ?? '—',
    enterModel: String(measured).slice(0, 120),
  };
}

const cases = [
  ['C 对照：BB = 全新玩家（无历史）', { playerId: null, displayName: null }],
  ['A BB = p7（VPIP / 折叠 c-bet 0.0% / 过牌加注 100%）', { playerId: 'p7', displayName: '玩家7' }],
  ['B BB = p9（VPIP 17.0 / 折叠 c-bet 0.0% / 过牌加注 100%）', { playerId: 'p9', displayName: '玩家9' }],
];

const out = [];
for (const [label, binding] of cases) {
  try {
    const r = await runCase(binding);
    out.push([label, r]);
    console.log(`\n### ${label}`);
    console.log(`  绑定=${r.boundPlayer}  注入 observedStats=${JSON.stringify(r.injected)}`);
    console.log(`  决策=${r.decision}  hash=${r.hash}`);
    console.log(`  对下注范围权益=${r.eqBet}｜整体范围权益=${r.eqWhole}｜CALL EV=${r.callEV}`);
    console.log(`  42BB 分支：弃 ${r.fold}% / 跟 ${r.call}% / 再加注 ${r.reRaise}%｜条件权益 ${r.condEq}%`);
    console.log(`  进入模型的统计=${r.enterModel}`);
  } catch (e) {
    console.log(`\n### ${label}\n  FAILED: ${e.message}`);
  }
}

console.log('\n=== 判定：真实画像是否改变了生产决策？ ===');
const c = out.find(([l]) => l.startsWith('C'))?.[1];
const a = out.find(([l]) => l.startsWith('A'))?.[1];
const b = out.find(([l]) => l.startsWith('B'))?.[1];
const cmp = (x, y, k, name) => {
  if (!x || !y) return;
  const same = x[k] === y[k];
  console.log(`  ${name}: ${same ? `**相同**（${x[k]}）` : `**不同**（${x[k]} → ${y[k]}）`}`);
};
console.log('  [C → A] 注入真实画像 p3：');
cmp(c, a, 'eqWhole', '    整体范围权益');
cmp(c, a, 'eqBet', '    对下注范围权益');
cmp(c, a, 'callEV', '    CALL EV');
cmp(c, a, 'fold', '    P(弃)');
console.log('  [C → B] 注入真实画像 p1：');
cmp(c, b, 'eqWhole', '    整体范围权益');
cmp(c, b, 'callEV', '    CALL EV');
cmp(c, b, 'fold', '    P(弃)');
console.log('  [A vs B] 两个不同真实玩家之间：');
cmp(a, b, 'callEV', '    CALL EV');
cmp(a, b, 'fold', '    P(弃)');
