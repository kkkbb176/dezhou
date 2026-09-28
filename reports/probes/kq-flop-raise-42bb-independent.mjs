/*
 * KQ FLOP RAISE 42BB CHECK — independent recomputation (v2, bug-fixed).
 *
 * v1 BUG (mine): RANK_OF was keyed by number but called with rank chars ('9'),
 * yielding undefined ranks -> all equity numbers were garbage. Fixed below.
 * Validation cases added so the measuring instrument itself is checked.
 */
const RANKS = { 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9, T: 10, J: 11, Q: 12, K: 13, A: 14 };
const SUIT_CHARS = ['s', 'h', 'd', 'c'];
const SUITS = { s: 0, h: 1, d: 2, c: 3 };
const card = (t) => ({ r: RANKS[t[0]], s: SUITS[t[1]], t });
const DECK = [];
for (const rk of Object.keys(RANKS)) for (const su of SUIT_CHARS) DECK.push(card(rk + su));
if (DECK.some((c) => !Number.isFinite(c.r))) throw new Error('deck build failed');

function score5(cs) {
  const ranks = cs.map((c) => c.r).sort((a, b) => b - a);
  const suits = cs.map((c) => c.s);
  const flush = suits.every((s) => s === suits[0]);
  const cnt = new Map();
  for (const r of ranks) cnt.set(r, (cnt.get(r) ?? 0) + 1);
  const groups = [...cnt.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const uniq = [...new Set(ranks)];
  let sh = 0;
  if (uniq.length === 5) {
    if (uniq[0] - uniq[4] === 4) sh = uniq[0];
    else if (uniq[0] === 14 && uniq[1] === 5) sh = 5;
  }
  if (flush && sh) return [8, sh];
  if (groups[0][1] === 4) return [7, groups[0][0], groups[1][0]];
  if (groups[0][1] === 3 && groups[1][1] === 2) return [6, groups[0][0], groups[1][0]];
  if (flush) return [5, ...ranks];
  if (sh) return [4, sh];
  if (groups[0][1] === 3) return [3, groups[0][0], ...groups.slice(1).map((g) => g[0])];
  if (groups[0][1] === 2 && groups[1][1] === 2) return [2, groups[0][0], groups[1][0], groups[2][0]];
  if (groups[0][1] === 2) return [1, groups[0][0], ...groups.slice(1).map((g) => g[0])];
  return [0, ...ranks];
}
function cmp(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0, y = b[i] ?? 0;
    if (x !== y) return x - y;
  }
  return 0;
}
function best7(cs) {
  let best = null;
  for (let a = 0; a < 3; a++) for (let b = a + 1; b < 4; b++) for (let c = b + 1; c < 5; c++)
    for (let d = c + 1; d < 6; d++) for (let e = d + 1; e < 7; e++) {
      const s = score5([cs[a], cs[b], cs[c], cs[d], cs[e]]);
      if (best === null || cmp(s, best) > 0) best = s;
    }
  return best;
}

const allCombos = (r) => { const out = []; for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) out.push([card(r + SUIT_CHARS[i]), card(r + SUIT_CHARS[j])]); return out; };
const suitedCombos = (r1, r2) => SUIT_CHARS.map((s) => [card(r1 + s), card(r2 + s)]);
const offsuitCombos = (r1, r2) => { const out = []; for (const s1 of SUIT_CHARS) for (const s2 of SUIT_CHARS) if (s1 !== s2) out.push([card(r1 + s1), card(r2 + s2)]); return out; };
const bothCombos = (r1, r2) => [...suitedCombos(r1, r2), ...offsuitCombos(r1, r2)];

function expand(specs, dead) {
  const out = [];
  for (const [kind, a, b] of specs) {
    const list = kind === 'pair' ? allCombos(a)
      : kind === 'suited' ? suitedCombos(a, b)
        : kind === 'offsuit' ? offsuitCombos(a, b)
          : bothCombos(a, b);
    for (const c of list) {
      if (dead.has(c[0].t) || dead.has(c[1].t)) continue;
      if (c[0].t === c[1].t) continue;
      out.push(c);
    }
  }
  return out;
}

function equity(hero, board, combos, iters, seed) {
  let s = seed >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const deadT = new Set([...hero, ...board].map((c) => c.t));
  const deck = DECK.filter((c) => !deadT.has(c.t));
  const need = 5 - board.length;
  let win = 0, tie = 0;
  for (let i = 0; i < iters; i++) {
    const opp = combos[Math.floor(rnd() * combos.length)];
    const pool = deck.filter((c) => c.t !== opp[0].t && c.t !== opp[1].t);
    const extra = [];
    const usedIdx = new Set();
    while (extra.length < need) {
      const k = Math.floor(rnd() * pool.length);
      if (usedIdx.has(k)) continue;
      usedIdx.add(k); extra.push(pool[k]);
    }
    const full = [...board, ...extra];
    const c = cmp(best7([...hero, ...full]), best7([...opp, ...full]));
    if (c > 0) win++; else if (c === 0) tie++;
  }
  return { eq: (win + tie / 2) / iters, win: win / iters, tie: tie / iters };
}

/* ================= INSTRUMENT VALIDATION ================= */
console.log('=== INSTRUMENT VALIDATION (known benchmarks) ===');
const val = [
  ['AA vs KK preflop (expect ~81-82%)', [card('As'), card('Ah')], [], expand([['pair', 'K']], new Set(['As', 'Ah'])), 40000, 0.81, 0.83],
  ['AKs vs QQ preflop (expect ~46%)', [card('As'), card('Ks')], [], expand([['pair', 'Q']], new Set(['As', 'Ks'])), 40000, 0.44, 0.48],
  ['AKo vs 22 preflop (expect ~47-48%)', [card('As'), card('Kh')], [], expand([['pair', '2']], new Set(['As', 'Kh'])), 40000, 0.45, 0.50],
];
let instrumentOk = true;
for (const [label, h, b, opp, it, lo, hi] of val) {
  const r = equity(h, b, opp, it, 12345);
  const ok = r.eq >= lo && r.eq <= hi;
  if (!ok) instrumentOk = false;
  console.log(`  ${label.padEnd(38)} got ${(r.eq * 100).toFixed(2)}%  ${ok ? 'PASS' : '*** FAIL ***'}`);
}
console.log(`  instrument: ${instrumentOk ? 'VALID' : 'INVALID — do not trust numbers below'}\n`);

/* ================= HAND 3 RANGES ================= */
const hero = [card('Ks'), card('Qs')];
const board = [card('Qh'), card('9s'), card('5s')];
const DEAD = new Set(['Ks', 'Qs', 'Qh', '9s', '5s']);
const IT = 20000;

const ranges = {
  'R1 仅暗三条+两对（最紧价值）': [['pair', '9'], ['pair', '5'], ['pair', '4'], ['pair', 'J'], ['suited', 'J', '9'], ['offsuit', 'J', '9']],
  'R2 三+两对+顶对': [['pair', '9'], ['pair', '5'], ['pair', '4'], ['pair', 'J'], ['suited', 'J', '9'], ['offsuit', 'J', '9'], ['both', 'A', 'Q'], ['both', 'K', 'Q'], ['suited', 'Q', 'J'], ['suited', 'Q', 'T']],
  'R3 混合（价值+顶对+听牌）': [['pair', '9'], ['pair', '5'], ['pair', '4'], ['pair', 'J'], ['suited', 'J', '9'], ['offsuit', 'J', '9'], ['both', 'A', 'Q'], ['both', 'K', 'Q'], ['suited', 'Q', 'J'], ['suited', 'Q', 'T'], ['suited', 'A', '5'], ['suited', 'T', '8'], ['suited', '8', '7'], ['suited', '6', '5'], ['both', 'T', '8'], ['suited', 'J', 'T']],
  'R4 听牌为主': [['suited', 'A', '5'], ['suited', 'T', '8'], ['suited', '8', '7'], ['suited', '6', '5'], ['suited', 'A', 'T'], ['suited', 'K', 'T'], ['both', 'T', '8'], ['suited', '7', '6']],
  'R5 顶对为主': [['both', 'A', 'Q'], ['both', 'K', 'Q'], ['suited', 'Q', 'J'], ['suited', 'Q', 'T']],
  'S1 只暗三条': [['pair', '9'], ['pair', '5'], ['pair', '4']],
  'S2 只两对': [['suited', 'J', '9'], ['offsuit', 'J', '9'], ['suited', '9', '5']],
  'S3 只同花听': [['suited', 'A', '5'], ['suited', 'T', '8'], ['suited', 'A', 'T'], ['suited', 'K', 'T'], ['suited', '8', '7']],
  'S4 组合听牌': [['suited', 'T', '8'], ['suited', 'A', '5'], ['suited', '6', '5'], ['suited', '8', '7']],
  'S5 顺子听（卡顺/两头）': [['both', 'T', '8'], ['suited', 'J', 'T'], ['suited', '8', '7']],
};

console.log('=== HERO KsQs vs Qh 9s 5s — independent equity (own evaluator) ===');
console.log('range'.padEnd(34), 'combos'.padStart(7), 'equity'.padStart(9), 'win'.padStart(8), 'tie'.padStart(8));
for (const [name, specs] of Object.entries(ranges)) {
  const combos = expand(specs, DEAD);
  if (combos.length === 0) { console.log(name.padEnd(34), 'EMPTY'); continue; }
  const r = equity(hero, board, combos, IT, 20260924);
  console.log(name.padEnd(34), String(combos.length).padStart(7), ((r.eq * 100).toFixed(2) + '%').padStart(9), ((r.win * 100).toFixed(2) + '%').padStart(8), ((r.tie * 100).toFixed(2) + '%').padStart(8));
}

/* ================= CASH FLOW ================= */
console.log('\n=== INDEPENDENT CASH FLOW (chips, 1BB=100) ===');
const BB = 100, potBefore = 2300, heroC = 350, villainC = 1400;
const heroRem = 10000 - 250 - 350, villainRem = 10000 - 250 - 1400;
console.log(`hero remaining=${heroRem} (${heroRem / BB}BB)  villain remaining=${villainRem} (${villainRem / BB}BB)  pot=${potBefore} (${potBefore / BB}BB)`);
console.log(`call cost=${villainC - heroC} (${(villainC - heroC) / BB}BB)  min raise-to=${2 * villainC - heroC} (${(2 * villainC - heroC) / BB}BB)  max raise-to=${heroC + heroRem} (${(heroC + heroRem) / BB}BB)`);
console.log('\nsizeBB | heroAdd | villAddRaw | villAdd | contested | finalPot | uncalled');
for (const raiseTo of [2450, 2625, 3150, 4200, 5250, 6300, 8400, 9750]) {
  const heroAdd = Math.max(0, raiseTo - heroC);
  const raw = Math.max(0, raiseTo - villainC);
  const vAdd = Math.min(raw, villainRem);
  const contested = Math.max(0, Math.min(heroAdd, villainC + vAdd - heroC));
  console.log(`${String(raiseTo / BB).padStart(6)} | ${String(heroAdd).padStart(7)} | ${String(raw).padStart(10)} | ${String(vAdd).padStart(7)} | ${String(contested).padStart(9)} | ${String(potBefore + contested + vAdd).padStart(8)} | ${String(Math.max(0, heroAdd - contested)).padStart(8)}`);
}

/* ================= BACK-SOLVE ================= */
console.log('\n=== BACK-SOLVE engine implied conditional equity ===');
const f = 0.880, cc = 0.077, rr = 0.043;
const hA = 3850, vA = 2800, contested42 = 3850, finalPot42 = 8950;
console.log(`P(fold)+P(call)+P(reraise) = ${(f + cc + rr).toFixed(4)}  (must be 1)`);
console.log(`RAISE 42BB cash flow: heroAdd=${hA} villainAdd=${vA} contested=${contested42} finalPot=${finalPot42}`);
for (const [lbl, rrEV] of [['rr = lower bound -3850', -contested42], ['rr = -3449', -3449], ['rr = 0', 0]]) {
  const implied = (1948.14 - f * potBefore - rr * rrEV + cc * contested42) / (cc * finalPot42);
  console.log(`  ${lbl.padEnd(24)} => implied EqVsRaiseCallRange = ${(implied * 100).toFixed(2)}%`);
}
console.log(`\nCALL EV check: 0.8043 x 3350 - 1050 = ${(0.8043 * 3350 - 1050).toFixed(2)} (engine 1644.52)`);
console.log(`RAISE vs CALL gap = 1948.14 - 1644.52 = ${(1948.14 - 1644.52).toFixed(2)} chips; tolerance band = ${(0.05 * 3350).toFixed(2)} => exceeds band? ${(1948.14 - 1644.52) > 0.05 * 3350}`);
