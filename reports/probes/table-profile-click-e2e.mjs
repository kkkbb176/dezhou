/**
 * 牌桌页「点击」路径实战验证：**不同画像会不会改变「牌力的下注」**
 *
 * ## 为什么必须走这条路径
 *
 * 牌桌页不是直接调 `analyzeManualHand`：它把画布上的点击翻译成
 * `POST /api/table` 的 op（`SET_PROFILE` / `SET_HERO_CARD` / `SET_BOARD_CARD` / `ACT` …），
 * 然后再用 `POST /api/analyze { table: state }` 拿结论。
 * 画像是在**服务端**由 `tableAdapter` 从**座位**注入的 —— 因此「手动录入会变、牌桌页不变」
 * 这种接线缺口只能在这条路径上才测得出来。
 *
 * ## 双向对照（本脚本的核心）
 *
 * | 组 | 改谁的画像 | 期望 |
 * |---|---|---|
 * | 1–6 | **对手座位（BB）** | 决策 / 尺寸 / EV **应当变化** |
 * | 7–8 | **非对手座位（UTG 等）** | 决策**必须不变**（否则 = 拿错座位的画像） |
 *
 * ⚠️ 必须指向**隔离实例**（独立端口 + `DSH_PLAYER_HISTORY_DIR`），
 * 否则牌桌 op 会写入真实玩家历史。
 *
 * ```powershell
 * node reports/probes/table-profile-click-e2e.mjs
 * ```
 */

const BASE = process.env.TABLE_BASE ?? 'http://127.0.0.1:5199';
let seq = 0;

async function post(path, body) {
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json() };
}

/**
 * 建一桌并打到「翻牌 BB 过牌后、Hero CO 待行动」的决策点。
 *
 * @param {(setProfile: (seatId: string, quickProfile: string) => Promise<void>) => Promise<void>} tweak
 *        在决策点之前对座位做的画像调整
 */
async function buildAndAnalyze(tweak) {
  let state = null;

  const op = async (kind, extra = {}) => {
    const id = `tpce-${Date.now().toString(36)}-${++seq}-${kind}`;
    const body = state === null
      ? { tableSize: 9, heroPosition: 'CO', requestId: id }
      : { state, op: { kind, ...extra }, requestId: id };
    const r = await post('/api/table', body);
    if (!r.json?.ok) throw new Error(`${kind}: ${JSON.stringify(r.json?.issues ?? r.json).slice(0, 200)}`);
    state = r.json.state;
  };

  await op('NEW_TABLE');
  await op('FILL_EMPTY_SEATS');

  const seatOf = (pos) => state.seats.find((s) => s.logicalPosition === pos)?.seatId;
  const heroSeatId = seatOf('CO');
  const bbSeatId = seatOf('BB');
  const buttonSeatId = state.buttonSeatId;

  await op('SET_BUTTON', { seatId: buttonSeatId });
  await op('SET_HERO_CARD', { card: 'Ks' });
  await op('SET_HERO_CARD', { card: 'Qs' });

  const posOf = (seatId) => state.seats.find((s) => s.seatId === seatId)?.logicalPosition;
  const act = async (type, amountChips) => {
    const action = { position: posOf(state.currentActorSeatId), type };
    if (amountChips !== undefined) action.amountChips = amountChips;
    await op('ACT', { action });
  };

  // 翻前：弃到 CO → 加注 2.5BB → BTN/SB 弃 → BB 跟注
  for (let i = 0; i < 5; i++) await act('FOLD');
  await act('RAISE', 250);
  await act('FOLD');
  await act('FOLD');
  await act('CALL', 150);
  // 翻牌
  await op('SET_BOARD_CARD', { card: 'Qh', slot: 0 });
  await op('SET_BOARD_CARD', { card: '9s', slot: 1 });
  await op('SET_BOARD_CARD', { card: '5s', slot: 2 });
  await act('CHECK'); // BB 过牌 ⇒ 轮到 Hero CO

  const setProfile = async (seatId, quickProfile) => {
    await op('SET_PROFILE', { seatId, quickProfile });
  };
  await tweak(setProfile, { bb: bbSeatId, utg: seatOf('UTG') });

  const r = await post('/api/analyze', { table: state, requestToken: 1 });
  if (!r.json?.ok) throw new Error('analyze: ' + JSON.stringify(r.json).slice(0, 300));
  const b = r.json;

  const cands = b.viewModel?.debug?.candidates ?? [];
  const bet = cands.filter((c) => /下注/.test(c.actionZh ?? ''));
  const playerRow = (b.viewModel?.debug?.player ?? []).find((x) => x.label === '本次进入模型');
  const seatProfiles = state.seats
    .filter((s) => s.playerId !== null)
    .map((s) => `${s.logicalPosition}=${s.quickProfile}`).join(' ');

  return {
    decision: `${b.decision.action}${b.decision.sizeBB ? ' ' + b.decision.sizeBB + 'BB' : ''}`,
    hash: b.meta?.inputHash ?? '?',
    betSizes: bet.map((c) => String(c.sizeZh).trim()).join('/') || '—',
    betEV: bet.map((c) => String(c.evZh ?? '').replace(/\*\*/g, '').replace(/（.*/s, '').trim()).join(' | ') || '—',
    enterModel: String(playerRow?.value ?? '（无）').slice(0, 90),
    seatProfiles,
    heroSeatId, bbSeatId,
  };
}

/** 只改对手（BB）的画像 */
const villainOnly = (profile) => async (set, seats) => { await set(seats.bb, profile); };
/** 只改非对手（UTG）的画像，对手保持默认 */
const nonVillainOnly = (profile) => async (set, seats) => { await set(seats.utg, profile); };
/** 对手 = A，同时把非对手设成 B */
const villainPlusNoise = (a, b) => async (set, seats) => { await set(seats.utg, b); await set(seats.bb, a); };

const CASES = [
  ['① 基线：对手(BB) = UNKNOWN', async () => {}],
  ['② 对手(BB) = CALLING_STATION', villainOnly('CALLING_STATION')],
  ['③ 对手(BB) = MANIAC', villainOnly('MANIAC')],
  ['④ 对手(BB) = VERY_TIGHT', villainOnly('VERY_TIGHT')],
  ['⑤ 对手(BB) = LOOSE', villainOnly('LOOSE')],
  ['⑥ 对手(BB) = BLUFF_HEAVY', villainOnly('BLUFF_HEAVY')],
  ['⑦ 对照·只改非对手(UTG) = MANIAC', nonVillainOnly('MANIAC')],
  ['⑧ 对照·对手=MANIAC 且非对手=CALLING_STATION', villainPlusNoise('MANIAC', 'CALLING_STATION')],
];

const rows = [];
console.log(`目标实例：${BASE}\n`);
for (const [label, tweak] of CASES) {
  try {
    const r = await buildAndAnalyze(tweak);
    rows.push([label, r]);
    console.log(`### ${label}`);
    console.log(`  建议 = ${r.decision}   ｜inputHash = ${r.hash}`);
    console.log(`  下注候选尺寸 = ${r.betSizes}`);
    console.log(`  下注候选 EV   = ${r.betEV}`);
    console.log(`  进入模型的统计 = ${r.enterModel}`);
    console.log(`  座位画像 = ${r.seatProfiles}\n`);
  } catch (e) {
    console.log(`### ${label}\n  FAILED: ${e.message}\n`);
    rows.push([label, { decision: 'FAILED', hash: 'FAILED', betSizes: 'FAILED', betEV: 'FAILED', enterModel: 'FAILED', seatProfiles: 'FAILED' }]);
  }
}

console.log('════════ 判定 ════════');
const base = rows[0][1];
const same = (a, b, k) => a[k] === b[k];
for (const [label, r] of rows.slice(1)) {
  const verdict = ['decision', 'hash', 'betSizes', 'betEV'].map((k) => `${k}:${same(base, r, k) ? '同' : '★异'}`).join('  ');
  console.log(`  ${label.padEnd(38)} ${verdict}`);
}
console.log('\n  期望：①→②③④⑤⑥ 至少「决策或下注 EV」不同；⑦⑧ 的决策与 EV 与 ①/③ 一致（不得被非对手画像影响）');
