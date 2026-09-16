/**
 * 单档桌人数速度标定（8/9 人桌专用）
 *
 * 用法：node scripts/gto-timing-probe.mjs <size> <iters> <allin:0|1> <limp:0|1>
 *
 * 为什么要单独一个脚本：8/9 人桌一次迭代要几十秒，
 * 必须能**独立、并行**地在后台跑，并把结果落盘，
 * 而不是塞在一个大脚本里等它整体结束。
 */

import { writeFileSync, mkdirSync } from 'node:fs';

const BASE = 'http://127.0.0.1:3737';
const ORDER = {
  4: ['CO', 'BTN', 'SB', 'BB'],
  5: ['HJ', 'CO', 'BTN', 'SB', 'BB'],
  6: ['UTG', 'HJ', 'CO', 'BTN', 'SB', 'BB'],
  8: ['UTG', 'UTG1', 'LJ', 'HJ', 'CO', 'BTN', 'SB', 'BB'],
  9: ['UTG', 'UTG1', 'UTG2', 'LJ', 'HJ', 'CO', 'BTN', 'SB', 'BB'],
};

const size = Number(process.argv[2] ?? 9);
const iters = Number(process.argv[3] ?? 5);
const addAllin = (process.argv[4] ?? '1') === '1';
const limp = (process.argv[5] ?? '0') === '1';

const positions = ORDER[size];
const config = {
  positions,
  stack: 100,
  posts: positions.map((p) => (p === 'SB' ? 0.5 : p === 'BB' ? 1 : 0)),
  ante: 0,
  limp,
  open_raises: [2.5],
  raise_mults: [3],
  max_raises: 2,
  add_allin: addAllin,
  rake_pct: 0,
  rake_cap: 0,
  no_flop_no_drop: true,
  realization: 'static',
  call_only_seats: [],
  open_raises_by_seat: null,
  raise_mults_by_seat: null,
};

const outDir = 'D:/德州/reports/evidence';
mkdirSync(outDir, { recursive: true });
const outFile = `${outDir}/gto-timing-${size}max-allin${addAllin ? 1 : 0}-limp${limp ? 1 : 0}.txt`;

function emit(line) {
  console.log(line);
  writeFileSync(outFile, `${line}\n`, { encoding: 'utf8', flag: 'a' });
}

async function post(path, body) {
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const t = await r.text();
  let j;
  try {
    j = JSON.parse(t);
  } catch {
    j = t;
  }
  return { status: r.status, j };
}
const get = async (p) => (await fetch(BASE + p)).json();

const tag = `${size}MAX allin=${addAllin} limp=${limp}`;
const est = await post('/api/preflop/estimate', config);
if (est.status !== 200) {
  emit(`${tag} 预检失败: ${JSON.stringify(est.j)}`);
  process.exit(1);
}
const tBuild = Date.now();
const built = await post('/api/preflop/spot', config);
const buildMs = Date.now() - tBuild;
if (built.status !== 200) {
  emit(`${tag} 建树失败: ${JSON.stringify(built.j)}`);
  process.exit(1);
}

const t0 = Date.now();
const solve = await post('/api/preflop/solve', {
  iterations: iters,
  check_every: iters,
  target_gap: 0,
  early_preview: false,
});
if (solve.status !== 200) {
  emit(`${tag} 求解请求失败: ${JSON.stringify(solve.j)}`);
  process.exit(1);
}
let st = null;
const deadline = Date.now() + 1_800_000;
while (Date.now() < deadline) {
  st = await get('/api/preflop/status');
  if (st.state !== 'running') break;
  await new Promise((r) => setTimeout(r, 500));
}
const solveMs = Date.now() - t0;

emit(
  `${tag} | 节点 ${est.j.nodes} | 建树 ${(buildMs / 1000).toFixed(1)}s | ` +
    `${iters} 次迭代 ${(solveMs / 1000).toFixed(1)}s → ${(solveMs / iters / 1000).toFixed(1)}s/迭代 | ` +
    `gap_total ${st?.gap_total?.toFixed(6) ?? '—'} | state=${st?.state} stop=${st?.stop_reason}`,
);
