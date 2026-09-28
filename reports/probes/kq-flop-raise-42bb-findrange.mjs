/*
 * Find the range that reproduces the engine's implied ~55% conditional equity.
 * Independent Monte Carlo (same validated evaluator as the main probe).
 */
const RANKS = { 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9, T: 10, J: 11, Q: 12, K: 13, A: 14 };
const SUIT_CHARS = ['s', 'h', 'd', 'c'];
const card = (t) => ({ r: RANKS[t[0]], s: SUIT_CHARS.indexOf(t[1]), t });
const DECK = []; for (const rk of Object.keys(RANKS)) for (const su of SUIT_CHARS) DECK.push(card(rk + su));

function score5(cs) {
  const ranks = cs.map((c) => c.r).sort((a, b) => b - a);
  const flush = cs.map((c) => c.s).every((s, _, a) => s === a[0]);
  const cnt = new Map(); for (const r of ranks) cnt.set(r, (cnt.get(r) ?? 0) + 1);
  const g = [...cnt.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const u = [...new Set(ranks)]; let sh = 0;
  if (u.length === 5) { if (u[0] - u[4] === 4) sh = u[0]; else if (u[0] === 14 && u[1] === 5) sh = 5; }
  if (flush && sh) return [8, sh];
  if (g[0][1] === 4) return [7, g[0][0], g[1][0]];
  if (g[0][1] === 3 && g[1][1] === 2) return [6, g[0][0], g[1][0]];
  if (flush) return [5, ...ranks];
  if (sh) return [4, sh];
  if (g[0][1] === 3) return [3, g[0][0], ...g.slice(1).map((x) => x[0])];
  if (g[0][1] === 2 && g[1][1] === 2) return [2, g[0][0], g[1][0], g[2][0]];
  if (g[0][1] === 2) return [1, g[0][0], ...g.slice(1).map((x) => x[0])];
  return [0, ...ranks];
}
const cmp = (a, b) => { for (let i = 0; i < Math.max(a.length, b.length); i++) { const x = a[i] ?? 0, y = b[i] ?? 0; if (x !== y) return x - y; } return 0; };
function best7(cs) { let b = null; for (let i = 0; i < 3; i++) for (let j = i + 1; j < 4; j++) for (let k = j + 1; k < 5; k++) for (let l = k + 1; l < 6; l++) for (let m = l + 1; m < 7; m++) { const s = score5([cs[i], cs[j], cs[k], cs[l], cs[m]]); if (!b || cmp(s, b) > 0) b = s; } return b; }

const allCombos = (r) => { const o = []; for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) o.push([card(r + SUIT_CHARS[i]), card(r + SUIT_CHARS[j])]); return o; };
const suited = (a, b) => SUIT_CHARS.map((s) => [card(a + s), card(b + s)]);
const offsuit = (a, b) => { const o = []; for (const s1 of SUIT_CHARS) for (const s2 of SUIT_CHARS) if (s1 !== s2) o.push([card(a + s1), card(b + s2)]); return o; };
const both = (a, b) => [...suited(a, b), ...offsuit(a, b)];
const DEAD = new Set(['Ks', 'Qs', 'Qh', '9s', '5s']);
const expand = (specs) => { const o = []; for (const [k, a, b] of specs) { const l = k === 'pair' ? allCombos(a) : k === 'suited' ? suited(a, b) : k === 'offsuit' ? offsuit(a, b) : both(a, b); for (const c of l) if (!DEAD.has(c[0].t) && !DEAD.has(c[1].t)) o.push(c); } return o; };

function equity(hero, board, combos, iters, seed) {
  let s = seed >>> 0; const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const dt = new Set([...hero, ...board].map((c) => c.t));
  const deck = DECK.filter((c) => !dt.has(c.t)); const need = 5 - board.length;
  let w = 0, t = 0;
  for (let i = 0; i < iters; i++) {
    const opp = combos[Math.floor(rnd() * combos.length)];
    const pool = deck.filter((c) => c.t !== opp[0].t && c.t !== opp[1].t);
    const used = new Set(); const ex = [];
    while (ex.length < need) { const k = Math.floor(rnd() * pool.length); if (used.has(k)) continue; used.add(k); ex.push(pool[k]); }
    const full = [...board, ...ex]; const c = cmp(best7([...hero, ...full]), best7([...opp, ...full]));
    if (c > 0) w++; else if (c === 0) t++;
  }
  return { eq: (w + t / 2) / iters, n: combos.length };
}

const hero = [card('Ks'), card('Qs')], board = [card('Qh'), card('9s'), card('5s')];
const clean = (l) => l.filter((c) => !DEAD.has(c[0].t) && !DEAD.has(c[1].t));
const probes = {
  'Q9 两对（挡我方 Q 出路）': clean(both('Q', '9')),
  'Q5 两对': clean(both('Q', '5')),
  '95 两对': clean(both('9', '5')),
  'J9 两对': clean(both('J', '9')),
  'JJ 超对': clean(allCombos('J')),
  'AA 超对': clean(allCombos('A')),
  'KK（Ks 已死）': clean(allCombos('K')),
  'AQ 顶对': clean(both('A', 'Q')),
  'A9 中对': clean(both('A', '9')),
  'TT 中对': clean(allCombos('T')),
  '88 小对': clean(allCombos('8')),
  '--- 价值合并：三+全部两对+JJ': clean([...allCombos('9'), ...allCombos('5'), ...allCombos('4'), ...allCombos('J'), ...both('J', '9'), ...both('Q', '9'), ...both('Q', '5'), ...both('9', '5')]),
  '--- 极强范围：仅 Q9+Q5+95+三': clean([...both('Q', '9'), ...both('Q', '5'), ...both('9', '5'), ...allCombos('9'), ...allCombos('5'), ...allCombos('4')]),
};
console.log('range'.padEnd(38), 'combos'.padStart(7), 'equity'.padStart(9));
for (const [name, combos] of Object.entries(probes)) {
  const r = equity(hero, board, combos, 20000, 20260924);
  console.log(name.padEnd(38), String(r.n).padStart(7), ((r.eq * 100).toFixed(2) + '%').padStart(9));
}
console.log('\nengine implied EqVsRaiseCallRange (back-solved) = 53.5% ~ 56.0%');
