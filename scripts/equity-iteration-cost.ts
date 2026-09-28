import { computeEquity } from '../src/domain/poker/equity.ts';
import { parseCardCode } from '../src/app/manualInput/manualInput.ts';
import { ALL_CARDS } from '../src/domain/poker/cards.ts';
const board = ['Qs','Js','8s'].map((c) => parseCardCode(c)) as any[];
const hero = ['Kh','Qh'].map((c) => parseCardCode(c)) as any[];
const all: any[] = ALL_CARDS as any;
const used = new Set<string>([...board, ...hero].map((c: any) => `${c.rank}${c.suit}`));
const mk = (n: number): any[] => {
  const out: any[] = [];
  for (let a = 0; a < all.length && out.length < n; a++) for (let b = a + 1; b < all.length && out.length < n; b++) {
    if (used.has(`${all[a].rank}${all[a].suit}`) || used.has(`${all[b].rank}${all[b].suit}`)) continue;
    out.push({ cardIndices: [a, b], probability: 1 });
  }
  return out;
};
for (const entries of [mk(200), mk(600)] as any[][]) {
  for (const iters of [1000, 10000, 100000] as any[]) {
    const t0 = Date.now();
    const r: any = computeEquity(hero, board, [{ entries }] as any, { seed: 1601, iterations: iters, maxIterations: iters, adaptive: false } as any);
    const ms = Date.now() - t0;
    const ok = r?.ok === true;
    const v = ok ? (r.result ?? r.value) : null;
    console.log('entries=' + String(entries.length).padEnd(4), 'iterations=' + String(iters).padEnd(7),
      '→ ' + String(ms).padStart(4) + 'ms', ok ? ('方法=' + v.method + ' 实际迭代=' + v.iterations + ' 权益=' + (v.equity ?? v.value)?.toFixed?.(4)) : JSON.stringify(r).slice(0, 150));
  }
}
