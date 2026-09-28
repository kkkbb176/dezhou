import { computeEquity } from '../src/domain/poker/equity.ts';
import { parseCardCode } from '../src/app/manualInput/manualInput.ts';
import { ALL_CARDS } from '../src/domain/poker/cards.ts';
const board = ['Qs','Js','8s'].map(parseCardCode);
const hero = ['Kh','Qh'].map(parseCardCode);
// 造一份 ~600 组可达范围（模拟 callContinueEntries 量级）
const entries: { cardIndices: readonly [number, number]; probability: number }[] = [];
const used = new Set([...board, ...hero].map((c: any) => `${c.rank}${c.suit}`));
const all = ALL_CARDS.map((c: any, i: number) => ({ c, i, k: `${c.rank}${c.suit}` }));
for (let a = 0; a < all.length; a++) for (let b = a + 1; b < all.length; b++) {
  if (used.has(all[a]!.k) || used.has(all[b]!.k)) continue;
  entries.push({ cardIndices: [all[a]!.i, all[b]!.i] as const, probability: 1 });
  if (entries.length >= 600) break;
}
console.log('entries =', entries.length);
for (const iters of [undefined, 2000, 5000] as any[]) {
  const t0 = Date.now();
  const r: any = computeEquity({
    heroHole: hero as any, board: board as any,
    opponents: [{ entries }],
    ...(iters === undefined ? {} : { options: { maxIterations: iters } }),
    seed: 1601,
  } as any);
  const ms = Date.now() - t0;
  console.log('  迭代上限', String(iters ?? '默认').padEnd(7), '→', ms + 'ms', '方法', r?.ok ? (r.value.method ?? r.value.source?.method) : JSON.stringify(r).slice(0,120), '迭代', r?.ok ? (r.value.iterations ?? r.value.source?.iterations) : '—', '权益', r?.ok ? (r.value.value ?? r.value.equity)?.toFixed?.(4) : '—');
}

