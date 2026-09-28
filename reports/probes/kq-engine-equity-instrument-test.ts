/*
 * Decisive instrument test: run the ENGINE's own equity engine (computeEquity)
 * on controlled ranges and compare with my independent Monte Carlo.
 * Read-only. No production code changed.
 *
 * NOTE: Card is an OBJECT { rank: 2..14, suit: 's'|'h'|'d'|'c' } (src/domain/poker/cards.ts:172).
 */
import { computeEquity } from '../../src/domain/poker/equity.ts';

const R = { 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9, T: 10, J: 11, Q: 12, K: 13, A: 14 };
const SUITS = ['s', 'h', 'd', 'c'];
const C = (t) => ({ rank: R[t[0]], suit: t[1] });

const pair = (r) => { const o = []; for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) o.push([C(r + SUITS[i]), C(r + SUITS[j])]); return o; };
const suited = (a, b) => SUITS.map((s) => [C(a + s), C(b + s)]);
const offsuit = (a, b) => { const o = []; for (const s1 of SUITS) for (const s2 of SUITS) if (s1 !== s2) o.push([C(a + s1), C(b + s2)]); return o; };
const dead = new Set(['Ks', 'Qs', 'Qh', '9s', '5s']);
const clean = (l) => l.filter((c) => !dead.has(`${Object.keys(R).find((k) => R[k] === c[0].rank)}${c[0].suit}`) && !dead.has(`${Object.keys(R).find((k) => R[k] === c[1].rank)}${c[1].suit}`));

const hero = [C('Ks'), C('Qs')];
const board = [C('Qh'), C('9s'), C('5s')];

const sets = clean([...pair('9'), ...pair('5'), ...pair('4')]);
const mixed = clean([...pair('9'), ...pair('5'), ...pair('4'), ...pair('J'), ...suited('J', '9'), ...offsuit('J', '9'), ...offsuit('A', 'Q'), ...offsuit('K', 'Q'), ...suited('Q', 'J'), ...suited('Q', 'T'), ...suited('A', '5'), ...suited('T', '8'), ...suited('8', '7'), ...suited('6', '5')]);

console.log(`sets combos=${sets.length}  mixed combos=${mixed.length}`);
console.log(`first set combo: ${JSON.stringify(sets[0])}`);

const cases = [
  ['S1 只暗三条 (独立算得 61.96%)', sets, 0.6196],
  ['R3 混合范围 (独立算得 78.27%)', mixed, 0.7827],
];

for (const [label, combos, mine] of cases) {
  console.log(`\n### ${label}  combos=${combos.length}`);
  for (const iters of [6000, 20000, 60000]) {
    const r = computeEquity(hero, board, [{ label: 'x', combos }], {
      mode: 'FAST', seed: 20260913 + 1601, iterations: iters,
      opponentWeights: [combos.map(() => 1)],
    });
    if (!r.ok) { console.log(`  iters=${iters} FAILED`, JSON.stringify(r).slice(0, 220)); continue; }
    const eq = r.result.equity;
    console.log(`  iters=${String(iters).padStart(6)}  engine=${(eq * 100).toFixed(2)}%  mine=${(mine * 100).toFixed(2)}%  delta=${((eq - mine) * 100).toFixed(2)}pp  method=${r.result.method}  exact=${r.result.exact ?? 'n/a'}`);
  }
}
