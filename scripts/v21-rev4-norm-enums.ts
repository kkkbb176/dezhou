/**
 * Reviewer 4 · probe 4 — 归一化稳定性 + 两个同名枚举
 *
 * 运行：node --experimental-strip-types scripts/v21-rev4-norm-enums.ts
 */
import {
  DENORMAL_MIN, LOG_ZERO, fromLogWeight, isLogWeightValid, isNumericallyZero,
  isStableNormalized, logSumExp, multiplyLogWeights, normalizeLogWeights,
  stableNormalize, toLogWeight,
} from '../src/domain/range/rangeLogSpace.ts';
import { normalizeWeights, probabilityMetrics } from '../src/domain/range/rangeNormalize.ts';
import { riverComboClassOf } from '../src/domain/postflop/riverProfileClassify.ts';
import { RelativeHandRole } from '../src/domain/postflop/types.ts';
import type { Card } from '../src/domain/types.ts';

const p17 = (x: number): string => (Number.isFinite(x) ? x.toPrecision(17) : String(x));

console.log('=========== 1. stableNormalize 的尺度不变性（1e-300 / 1e300）===========');
const SHAPES: readonly { label: string; w: number[] }[] = [
  { label: '均匀 [1,1,1]', w: [1, 1, 1] },
  { label: '阶梯 [1,1,0.5]', w: [1, 1, 0.5] },
  { label: '极陡 [1, 1e-12, 1e-300]', w: [1, 1e-12, 1e-300] },
  { label: '449 项长尾', w: Array.from({ length: 449 }, (_, i) => Math.exp(-i / 40)) },
  { label: '含极小 [1, 5e-324]', w: [1, 5e-324] },
  { label: '含 1e-320（denormal）', w: [1, 1e-320] },
];
for (const { label, w } of SHAPES) {
  const items = w.map((rawWeight, i) => ({ comboId: `c${i}`, rawWeight }));
  const base = stableNormalize(items);
  if (!base.ok) { console.log(`  ${label.padEnd(24)} 基线失败 ${base.code}`); continue; }
  const rows: string[] = [];
  for (const [tag, scale] of [['×1e-300', 1e-300], ['×1e300', 1e300], ['×1e-300→denorm', 1e-308], ['×1e-160', 1e-160]] as const) {
    const scaled = stableNormalize(w.map((x, i) => ({ comboId: `c${i}`, rawWeight: x * scale })));
    if (!scaled.ok) { rows.push(`${tag}:失败(${scaled.code})`); continue; }
    let maxAbs = 0; let identical = true;
    for (let i = 0; i < base.value.probabilities.length; i++) {
      const a = base.value.probabilities[i]!; const b = scaled.value.probabilities[i]!;
      if (a !== b) identical = false;
      maxAbs = Math.max(maxAbs, Math.abs(a - b));
    }
    rows.push(`${tag}:${identical ? '逐位相同' : `最大差 ${maxAbs.toExponential(3)}`}(support ${base.value.supportSize}→${scaled.value.supportSize}, Σp ${p17(base.value.probabilitySum)}→${p17(scaled.value.probabilitySum)})`);
  }
  console.log(`  ${label.padEnd(24)} support=${base.value.supportSize} Σp=${p17(base.value.probabilitySum)}\n      ${rows.join('\n      ')}`);
}
console.log('\n  —— 乘 1e300 时的溢出行为（w 已被放大到 > Number.MAX_VALUE）——');
const huge = stableNormalize([{ comboId: 'a', rawWeight: 1e300 }, { comboId: 'b', rawWeight: 1e300 }, { comboId: 'c', rawWeight: 5e299 }]);
console.log(`  [1e300, 1e300, 5e299] ⇒ ${huge.ok ? `ok, Σp=${p17(huge.value.probabilitySum)}, shift=${p17(huge.value.shift)}` : `失败 ${huge.code}`}`);
const overflow = stableNormalize([{ comboId: 'a', rawWeight: 1e308 * 10 }, { comboId: 'b', rawWeight: 1 }]);
console.log(`  [Infinity, 1] ⇒ ${overflow.ok ? 'ok（**未被拒绝**）' : `失败 ${overflow.code}：${JSON.stringify(overflow.details ?? {})}`}`);
const scaledOverflow = stableNormalize([{ comboId: 'a', rawWeight: 1e300 * 1e300 }, { comboId: 'b', rawWeight: 1e300 }]);
console.log(`  [1e300×1e300, 1e300] = [Infinity, 1e300] ⇒ ${scaledOverflow.ok ? 'ok（**未被拒绝**）' : `失败 ${scaledOverflow.code}`}`);

console.log('\n=========== 2. 对数域：±690 平移是否改变输出 ===========');
const logs = Array.from({ length: 449 }, (_, i) => -i / 40);
const l0 = normalizeLogWeights(logs.map((logWeight, i) => ({ comboId: `c${i}`, logWeight })));
for (const shift of [-690, -300, 300, 690, -1e15, 1e15]) {
  const l1 = normalizeLogWeights(logs.map((logWeight, i) => ({ comboId: `c${i}`, logWeight: logWeight + shift })));
  if (!l0.ok || !l1.ok) { console.log(`  shift=${shift}: 失败`); continue; }
  let ident = true; let maxAbs = 0;
  for (let i = 0; i < l0.value.probabilities.length; i++) {
    if (l0.value.probabilities[i] !== l1.value.probabilities[i]) ident = false;
    maxAbs = Math.max(maxAbs, Math.abs(l0.value.probabilities[i]! - l1.value.probabilities[i]!));
  }
  console.log(`  shift=${String(shift).padStart(8)}: ${ident ? '逐位相同' : `最大差 ${maxAbs.toExponential(3)}`}  Σp=${p17(l1.value.probabilitySum)} support=${l0.value.supportSize}→${l1.value.supportSize}`);
}
console.log('\n  —— 单点下溢：概率真的等于 0 的条目 ——');
for (const [label, lw] of [['log=-745.2', -745.2], ['log=-745.1332', -745.1332], ['log=-750', -750], ['log=-1074', -1074], ['log=-1075', -1075], ['-Infinity', LOG_ZERO]] as const) {
  console.log(`  exp(${String(label).padEnd(12)}) = ${p17(fromLogWeight(lw as number))}  isNumericallyZero=${isNumericallyZero(fromLogWeight(lw as number))}`);
}
console.log(`  DENORMAL_MIN = ${p17(DENORMAL_MIN)}（= 5e-324）`);
const tiny = normalizeLogWeights([{ comboId: 'a', logWeight: 0 }, { comboId: 'b', logWeight: -745.2 }, { comboId: 'c', logWeight: -800 }]);
console.log(`  [0, -745.2, -800] ⇒ ${tiny.ok ? `support=${tiny.value.supportSize}/3, p=[${tiny.value.probabilities.map(p17).join(', ')}], Σp=${p17(tiny.value.probabilitySum)}` : `失败 ${tiny.code}`}`);
console.log('  ⇒ support 从 3 掉到 2：logWeight=-745.2 的组合被**静默删除**（下溢到精确 0）—— 归一化不报错，`supportSize` 会显示 2');

console.log('\n=========== 3. 工具函数边界 ===========');
console.log(`  logSumExp([]) = ${logSumExp([])}（= -Infinity，表示「无有效项」）`);
console.log(`  logSumExp([-Infinity,-Infinity]) = ${logSumExp([-Infinity, -Infinity])}`);
console.log(`  logSumExp([NaN]) = ${logSumExp([Number.NaN])}`);
console.log(`  logSumExp([Infinity]) = ${logSumExp([Infinity])}`);
console.log(`  logSumExp([0, 0]) = ${p17(logSumExp([0, 0]))}（应=ln2=${p17(Math.LN2)}）`);
console.log(`  isLogWeightValid(NaN)=${isLogWeightValid(Number.NaN)} isLogWeightValid(+Inf)=${isLogWeightValid(Infinity)} isLogWeightValid(-Inf)=${isLogWeightValid(-Infinity)}`);
console.log(`  toLogWeight(0)=${toLogWeight(0)} toLogWeight(-1)=${toLogWeight(-1)} toLogWeight(1e-300)=${p17(toLogWeight(1e-300))} toLogWeight(1e300)=${p17(toLogWeight(1e300))} toLogWeight(Inf)=${toLogWeight(Infinity)} toLogWeight(NaN)=${toLogWeight(Number.NaN)}`);
console.log(`  multiplyLogWeights(0.1,0.2,0.3) = ${p17(multiplyLogWeights(0.1, 0.2, 0.3))} vs ln(0.1*0.2*0.3)=${p17(Math.log(0.1 * 0.2 * 0.3))} vs ln0.1+ln0.2+ln0.3=${p17(Math.log(0.1) + Math.log(0.2) + Math.log(0.3))}`);
console.log(`  multiplyLogWeights(-Inf, 5) = ${multiplyLogWeights(LOG_ZERO, 5)}（0×任何 = 0）`);
console.log(`  isStableNormalized(1.0000000000000040) = ${isStableNormalized(1.0000000000000040)}（EPSILON 容差）`);
const m1 = probabilityMetrics([0.5, 0.5, 0]);
console.log(`  probabilityMetrics([0.5,0.5,0]) = support=${m1.supportSize} total=${m1.totalEntries} entropy=${p17(m1.entropyBits)} effective=${p17(m1.effectiveComboCount)} Σp=${p17(m1.probabilitySum)}`);
const nw1 = normalizeWeights([{ comboId: 'a', rawWeight: 1 }, { comboId: 'b', rawWeight: 1 }, { comboId: 'c', rawWeight: 0.5 }]);
console.log(`  normalizeWeights([1,1,0.5]) ⇒ ${nw1.ok ? `Σp=${p17(nw1.value.probabilitySum)} w=[${nw1.value.probabilities.map(p17).join(', ')}]` : `失败 ${nw1.code}`}`);

console.log('\n=========== 4. 两个同名 MEDIUM_VALUE ===========');
console.log(`  RelativeHandRole.MEDIUM_VALUE（运行时值，可达）= ${JSON.stringify((RelativeHandRole as unknown as Record<string, unknown>)['MEDIUM_VALUE'])}`);
console.log(`  RelativeHandRole 全部成员 = ${Object.keys(RelativeHandRole).join(', ')}`);

console.log('\n=========== 5. RiverComboClass 可达性 / 覆盖矩阵（穷举扫描）===========');
const RANKS: Record<number, string> = { 2:'2',3:'3',4:'4',5:'5',6:'6',7:'7',8:'8',9:'9',10:'T',11:'J',12:'Q',13:'K',14:'A' };
const SUITS = ['s', 'h', 'd', 'c'] as const;
const ALL_CARDS: Card[] = [];
for (const r of [2,3,4,5,6,7,8,9,10,11,12,13,14]) for (const s of SUITS) ALL_CARDS.push({ rank: r, suit: s } as unknown as Card);
const c = (str: string): Card[] => str.trim().split(/\s+/).map((tok) => {
  const rank = tok.slice(0, -1); const suit = tok.slice(-1);
  return { rank: Number(Object.entries(RANKS).find(([, v]) => v === rank)![0]), suit } as unknown as Card;
});
const DECLARED = ['NUT_VALUE','STRONG_VALUE','THIN_VALUE','SHOWDOWN_VALUE','MISSED_FLUSH_DRAW','MISSED_STRAIGHT_DRAW','MISSED_COMBO_DRAW','PURE_AIR'] as const;

const BOARDS: readonly { board: Card[]; hero: Card[] }[] = [
  { board: c('Ad 8s 4s 2c Kd'), hero: c('Ac Jh') },
  { board: c('Qs 8d 3c 6s Ks'), hero: c('Ah Qc') },
  { board: c('Kc 9s 5d 2h 7c'), hero: c('Ah 9h') },
  { board: c('Th 9h 2s 3d 4c'), hero: c('Ac Ad') },
  { board: c('7s 6s 2s Kh Qd'), hero: c('Ac Ks') },
  { board: c('Ad 8s 4s 2c Kd'), hero: c('3c 2d') },
  { board: c('Qs 8d 3c 6s Ks'), hero: c('4h 2c') },
  { board: c('Kc 9s 5d 2h 7c'), hero: c('3h 2d') },
  { board: c('Ad As 8d 4c 2h'), hero: c('3c 2d') },
  { board: c('7s 6s 5s 4s 2h'), hero: c('3c 2d') },
];

const produced = new Map<string, Set<number>>();
const perBoard = new Map<string, Set<string>>();
let nullCount = 0; let total = 0;
let sawMediumString = 0;
const unknowns = new Set<string>();
for (const { board, hero } of BOARDS) {
  const key = `${board.map((x) => `${RANKS[x.rank]}${x.suit}`).join('')}/${hero.map((x) => `${RANKS[x.rank]}${x.suit}`).join('')}`;
  const set = new Set<string>();
  for (let i = 0; i < ALL_CARDS.length; i++) {
    for (let j = i + 1; j < ALL_CARDS.length; j++) {
      const hole = [ALL_CARDS[i]!, ALL_CARDS[j]!] as [Card, Card];
      if (hole.some((h) => board.some((b) => b.rank === h.rank && b.suit === h.suit))) continue;
      if (hole.some((h) => hero.some((b) => b.rank === h.rank && b.suit === h.suit))) continue;
      total++;
      const r = riverComboClassOf({ hole, board, heroHole: hero });
      if (r === null) { nullCount++; continue; }
      const cat = String(r.category);
      if (cat === 'MEDIUM_VALUE') sawMediumString++;
      if (!(DECLARED as readonly string[]).includes(cat)) unknowns.add(cat);
      (produced.get(cat) ?? produced.set(cat, new Set()).get(cat)!).add(r.strengthBucket);
      set.add(cat);
    }
  }
  perBoard.set(key, set);
}
console.log(`  扫描可达组合 ${total} 个（已排除与公共牌/Hero 重叠的组合）；riverComboClassOf 返回 null = ${nullCount}`);
console.log(`  产出 'MEDIUM_VALUE' 字符串的次数 = ${sawMediumString}（0 ⇒ 该成员确实**不可产出**）`);
console.log(`  产出声明之外的类别字符串 = ${unknowns.size === 0 ? '无' : [...unknowns].join(', ')}`);
console.log('\n  覆盖矩阵（类别 → 实测出现的 strengthBucket 集合 / 是否有该板面产出该类别）：');
for (const d of DECLARED) {
  const buckets = produced.get(d);
  const boards = [...perBoard.entries()].filter(([, s]) => s.has(d)).map(([k]) => k);
  console.log(
    `    ${d.padEnd(21)} buckets={${buckets === undefined ? '' : [...buckets].sort((a, b) => a - b).join(',')}}  ` +
      `板面数=${boards.length}/${BOARDS.length}  首次出现=${boards[0] ?? '（未出现 ⇒ 不可达）'}`,
  );
}
const missing = DECLARED.filter((d) => !produced.has(d));
console.log(`\n  未产出的声明成员 = ${missing.length === 0 ? '无（8/8 全部可达）' : missing.join(', ')}`);
console.log(`  ⇒ ` + (missing.length === 0 ? 'RiverComboClass 的 8 个成员全部可达' : '存在不可达成员'));
console.log(`\n  说明：`+"`RiverComboClass` 是**纯类型**（`export type`），运行时不存在同名对象，");
console.log(`  因此 \`RiverComboClass.MEDIUM_VALUE\` 在运行时**不可能**被求值（会 ReferenceError）；`);
console.log(`  而唯一的运行时同名成员 \`RelativeHandRole.MEDIUM_VALUE\` 属于**另一个枚举**。`);
