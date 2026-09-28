/**
 * 玩家名称功能 · **HTTP 端到端**验证（牌桌页真实路径）
 *
 * ## 为什么必须走 HTTP
 *
 * 上一轮的教训：纯函数单测（直接调 `applyTableOp`）**过了**，但浏览器走的是
 * `POST /api/table` → `parseOp` → `applyTableOp` → `buildTablePreview` → 渲染。
 * 中间任何一环丢字段都会让「单测绿、实际不生效」。所以这里全程走 HTTP，
 * 并断言**服务端返回的 `preview.seats[].displayName`** —— 那正是渲染读的字段。
 *
 * ## 覆盖两条路径
 *
 * | 路径 | op | 场景 |
 * |---|---|---|
 * | A 给**空座位的新**玩家命名 | `ADD_PLAYER{seatId, displayName}` | 座位是空的 |
 * | B 给**已入座**玩家改名 | `SET_PLAYER_NAME{seatId, displayName}` | 座位已经有人（实测反馈的正是这种） |
 *
 * ⚠️ 指向**隔离实例**（独立端口 + `DSH_PLAYER_HISTORY_DIR`），否则会写真实玩家历史。
 *
 * ```powershell
 * node reports/probes/table-player-name-e2e.mjs
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

let state = null;
/**
 * ⚠️ `preview` 是 `/api/table` 响应里的**顶层字段**，**不在 `state` 上**
 * （浏览器端也是分开存的：`state = r.json.state; preview = r.json.preview`）。
 * 本探针第一版误读 `state.preview`，于是永远显示「无该座位」。
 */
let preview = null;
const op = async (kind, extra = {}) => {
  const id = `tpname-${Date.now().toString(36)}-${++seq}-${kind}`;
  const body = state === null
    ? { tableSize: 9, heroPosition: 'BTN', requestId: id }
    : { state, op: { kind, ...extra }, requestId: id };
  const r = await post('/api/table', body);
  if (!r?.ok) throw new Error(`${kind}: ${JSON.stringify(r?.issues ?? r).slice(0, 220)}`);
  state = r.state;
  preview = r.preview ?? preview;
  return r;
};

/** 渲染读的就是 preview.seats[].displayName —— 断言这个字段才有意义 */
const shownName = (seatId) => {
  const p = preview?.seats?.find((s) => s.seatId === seatId);
  return p === undefined ? '（无该座位）' : p.displayName;
};

let fails = 0;
const check = (name, ok, detail) => {
  if (!ok) fails++;
  console.log(`${ok ? '  ✔' : '  ★'} ${name}${detail ? ` —— ${detail}` : ''}`);
};

await op('NEW_TABLE');
await op('FILL_EMPTY_SEATS');
const seatOf = (pos) => state.seats.find((s) => s.logicalPosition === pos)?.seatId;
/** 找一个空座位（把 CO 腾空） */
const co = seatOf('CO');
await op('CLEAR_SEAT', { seatId: co, activeHandChoice: 'LEAVE_AFTER_HAND' });
await op('NEXT_HAND');

console.log('════════ 路径 A：给空座位的新玩家命名（ADD_PLAYER{displayName}）════════\n');
const rA = await op('ADD_PLAYER', { seatId: co, displayName: '老张' });
check('ADD_PLAYER 被接受', rA.ok === true, '');
const afterAdd = shownName(co);
check('preview 里显示的就是输入的名字', afterAdd === '老张', `实际 ${JSON.stringify(afterAdd)}`);
const boundPid = state.seats.find((s) => s.seatId === co)?.playerId;
check('身份仍是自动 p{n}（名字只影响显示）', /^p\d+$/.test(String(boundPid)), `playerId=${String(boundPid)}`);

console.log('\n════════ 路径 B：给**已入座**玩家改名（SET_PLAYER_NAME）════════\n');
const bb = seatOf('BB');
console.log(`  改名前 BB 座位显示：${JSON.stringify(shownName(bb))}`);
const rB = await op('SET_PLAYER_NAME', { seatId: bb, displayName: '阿豪' });
check('SET_PLAYER_NAME 被接受', rB.ok === true, '');
const afterRename = shownName(bb);
check('preview 里立刻显示新名字', afterRename === '阿豪', `实际 ${JSON.stringify(afterRename)}`);
const bbPid = state.seats.find((s) => s.seatId === bb)?.playerId;
check(
  '身份未被改动（历史绑定不受影响）',
  state.playersById[bbPid]?.playerId === bbPid,
  `playerId=${String(bbPid)}`,
);

console.log('\n════════ 拒绝路径（必须显式失败，且状态不变）════════\n');
const before = JSON.stringify(state.seats.map((s) => s.playerId));
const bad = await post('/api/table', {
  state,
  op: { kind: 'SET_PLAYER_NAME', seatId: bb, displayName: '   ' },
  requestId: `tpname-${Date.now().toString(36)}-blank`,
});
check('全空白名字必须被拒', bad.ok === false, `code=${String(bad.issues?.[0]?.code)}`);
check(
  '被拒后状态未变',
  JSON.stringify((bad.state ?? state).seats.map((s) => s.playerId)) === before,
  '',
);

const long = await post('/api/table', {
  state,
  op: { kind: 'SET_PLAYER_NAME', seatId: bb, displayName: 'x'.repeat(25) },
  requestId: `tpname-${Date.now().toString(36)}-long`,
});
check('超长名字必须被拒', long.ok === false, `code=${String(long.issues?.[0]?.code)}`);

console.log(`\n════════ 结果：失败 ${fails} 项 ════════`);
process.exitCode = fails > 0 ? 1 : 0;
