/**
 * 《德州牌桌手册 V1.4》↔ 决策引擎：**翻前应对**（P5 / P6 / P7）集合对比
 *
 * ## 手册简写 → 169 类集合的解析规则
 *
 * 手册写法：`JJ+` `AQs+` `KQs` `AK` `AKo` `22-JJ` …
 *
 * | 写法 | 含义 |
 * |---|---|
 * | `XX` | 对子 |
 * | `XYs` / `XYo` | 同花 / 非同花，**无** `+` ⇒ 只这一类 |
 * | `XY` | **同花与非同花都要**（手册的 `AK` 即 `AKs` + `AKo`） |
 * | `XX+` | 对子从 XX 到 AA |
 * | `XY+` | 顶张固定 X，脚从 Y **一路升到紧邻 X 的那张**（`KTs+` = KTs/KJs/KQs；`T8s+` = T8s/T9s） |
 * | `22-JJ` | 对子区间 |
 *
 * ⚠️ 只读：不写任何数据文件。
 *
 * ```powershell
 * node --experimental-strip-types reports/probes/manual-preflop-response-audit.ts
 * ```
 */

import { Position, TableSize } from '../../src/domain/types.ts';
import { allRankClassKeys, defendWeights, threeBetWeights } from '../../src/app/manualInput/preflopPriors.ts';

const RANKS = ['A', 'K', 'Q', 'J', 'T', '9', '8', '7', '6', '5', '4', '3', '2'] as const;
const ri = (r: string): number => RANKS.indexOf(r as (typeof RANKS)[number]);
const ALL = allRankClassKeys();

function parseNotation(text: string): Set<string> {
  const out = new Set<string>();
  for (const token of text.split(/[\s；;，,]+/).filter(Boolean)) {
    const pairRange = /^([AKQJT2-9])\1?-([AKQJT2-9])\2$/.exec(token);
    if (pairRange) {
      const hi = Math.min(ri(pairRange[1]!), ri(pairRange[2]!));
      const lo = Math.max(ri(pairRange[1]!), ri(pairRange[2]!));
      for (let i = hi; i <= lo; i++) out.add(RANKS[i]! + RANKS[i]!);
      continue;
    }
    const plus = token.endsWith('+');
    const body = plus ? token.slice(0, -1) : token;
    const m = /^([AKQJT2-9])([AKQJT2-9])([so]?)$/.exec(body);
    if (!m) continue;
    const x = m[1]!;
    const y = m[2]!;
    const suffix = m[3]!;
    if (x === y) {
      if (!plus) out.add(x + y);
      else for (let i = 0; i <= ri(x); i++) out.add(RANKS[i]! + RANKS[i]!);
      continue;
    }
    const suffixes = suffix === '' ? ['s', 'o'] : [suffix];
    for (const s of suffixes) {
      if (!plus) { out.add(x + y + s); continue; }
      /* 脚从 Y 升到紧邻 X 的那张（rankIndex 更小 = 更大） */
      for (let k = ri(x) + 1; k <= ri(y); k++) out.add(x + RANKS[k]! + s);
    }
  }
  return out;
}

let fails = 0;
const check = (name: string, ok: boolean, detail: string): void => {
  if (!ok) fails++;
  console.log(`${ok ? '  ✔' : '  ★'} ${name}${detail === '' ? '' : ` —— ${detail}`}`);
};

const setOf = (weights: unknown): Set<string> => {
  const w = weights as Record<string, number>;
  return new Set(ALL.filter((k) => (w[k] ?? 0) > 0));
};

const compare = (label: string, manualText: string, engine: Set<string>): void => {
  const manual = parseNotation(manualText);
  const onlyManual = [...manual].filter((h) => !engine.has(h)).sort();
  const onlyEngine = [...engine].filter((h) => !manual.has(h)).sort();
  const both = [...manual].filter((h) => engine.has(h)).length;
  const jac = both / (manual.size + engine.size - both);
  console.log(
    `\n  【${label}】手册 ${manual.size} 类 / 引擎 ${engine.size} 类 / 交集 ${both}` +
      ` ⇒ Jaccard ${(jac * 100).toFixed(1)}%`,
  );
  console.log(`    手册范围：${manualText}`);
  if (onlyManual.length > 0) console.log(`    手册有·引擎无（${onlyManual.length}）：${onlyManual.join(' ')}`);
  else console.log('    手册有·引擎无（0）：—');
  if (onlyEngine.length > 0) console.log(`    引擎有·手册无（${onlyEngine.length}）：${onlyEngine.slice(0, 40).join(' ')}${onlyEngine.length > 40 ? ' …' : ''}`);
  else console.log('    引擎有·手册无（0）：—');
};

const T = TableSize.NINE_MAX;

console.log('════════ 手册 P5：3Bet（我不在 BB）════════');
compare('面对 UTG/UTG+1/UTG+2 开池', 'JJ+ AQs+ AKo',
  setOf(threeBetWeights(T, Position.HJ, Position.UTG)));
compare('面对 LJ/HJ 开池', 'TT+ AJs+ KQs AQo+',
  setOf(threeBetWeights(T, Position.CO, Position.LJ)));
compare('面对 CO 开池', '99+ ATs+ KJs+ QJs AJo+',
  setOf(threeBetWeights(T, Position.BTN, Position.CO)));
compare('面对 BTN 开池（仅 SB 可查）', '88+ A9s+ KTs+ QTs+ JTs ATo+ KQo',
  setOf(threeBetWeights(T, Position.SB, Position.BTN)));

console.log('\n\n════════ 手册 P5：3Bet（我在 BB）════════');
compare('面对 UTG 开池', 'QQ+ AK', setOf(threeBetWeights(T, Position.BB, Position.UTG)));
compare('面对 LJ 开池', 'JJ+ AQs+ AKo', setOf(threeBetWeights(T, Position.BB, Position.LJ)));
compare('面对 CO 开池', 'TT+ AJs+ KQs AQo+', setOf(threeBetWeights(T, Position.BB, Position.CO)));
compare('面对 BTN 开池', '99+ ATs+ KJs+ QJs AJo+', setOf(threeBetWeights(T, Position.BB, Position.BTN)));
compare('面对 SB 开池', '88+ A9s+ KTs+ QTs+ JTs ATo+ KQo', setOf(threeBetWeights(T, Position.BB, Position.SB)));

console.log('\n\n════════ 手册 P5：BB 的「继续范围」= 跟注 ∪ 3Bet ════════');
console.log('  ⚠️ 口径对齐：引擎 `defendWeights` 的语义是「**跟注 + 3Bet 合并**的继续范围」');
console.log('     （源码明确文档化为简化：分开建模需要无数据支撑的比例假设）。');
console.log('     因此必须拿手册的 跟注 ∪ 3Bet 去比，不能只比手册的「跟注」列。');
const BB_ROWS: readonly [string, string, string, Position, Position][] = [
  ['面对早位 UTG–UTG2', '22-JJ；A2s+ KTs+ QTs+ JTs T9s 98s 87s；AJo+ KQo', 'QQ+ AK', Position.UTG, Position.BB],
  ['面对中位 LJ/HJ', '22-JJ；A2s+ K9s+ Q9s+ J9s+ T8s+ 98s 97s 87s 76s；ATo+ KJo+ QJo', 'JJ+ AQs+ AKo', Position.LJ, Position.BB],
  ['面对 CO', '22-JJ；A2s+ K7s+ Q8s+ J8s+ T8s+ 98s 97s 87s 76s 65s 54s；ATo+ KTo+ QTo+ JTo', 'TT+ AJs+ KQs AQo+', Position.CO, Position.BB],
  ['面对 BTN', '22-JJ；A2s+ K5s+ Q7s+ J7s+ T7s+ 98s 97s 96s 87s 86s 76s 75s 65s 54s；A7o+ K9o+ Q9o+ J9o+ T9o', '99+ ATs+ KJs+ QJs AJo+', Position.BTN, Position.BB],
  ['面对 SB', '22-JJ；A2s+ K5s+ Q7s+ J7s+ T7s+ 98s 97s 96s 87s 86s 76s 75s 65s 54s；A7o+ K9o+ Q9o+ J9o+ T9o', '88+ A9s+ KTs+ QTs+ JTs ATo+ KQo', Position.SB, Position.BB],
];
for (const [label, callText, threeBetText, opener] of BB_ROWS) {
  const union = new Set([...parseNotation(callText), ...parseNotation(threeBetText)]);
  compare(`${label}（跟注 ∪ 3Bet）`, `${callText} ∪ ${threeBetText}`, setOf(defendWeights(T, opener, Position.BB)));
  console.log(`    （手册跟注 ${parseNotation(callText).size} 类 + 3Bet ${parseNotation(threeBetText).size} 类 = 继续 ${union.size} 类）`);
}

console.log('\n\n════════ 档位粒度：手册按开池者分档，引擎是否合并 ════════');
{
  const openers: readonly [string, Position][] = [
    ['UTG', Position.UTG], ['UTG1', Position.UTG1], ['UTG2', Position.UTG2],
    ['LJ', Position.LJ], ['HJ', Position.HJ], ['CO', Position.CO], ['BTN', Position.BTN],
  ];
  const sig = (s: Set<string>): string => [...s].sort().join(',');
  const rows = openers.map(([l, p]) => [
    l,
    sig(setOf(threeBetWeights(T, Position.HJ, p))),
    sig(setOf(defendWeights(T, p, Position.BB))),
  ] as const);
  const distinct3bet = new Set(rows.map((r) => r[1])).size;
  const distinctDefend = new Set(rows.map((r) => r[2])).size;
  console.log(`  非盲位 3Bet：7 个开池位置 → 引擎只有 ${distinct3bet} 种范围`);
  console.log(`  BB 防守：7 个开池位置 → 引擎只有 ${distinctDefend} 种范围`);
  console.log('  （手册：3Bet 按开池者分 4 档 + BB 另 5 档；BB 跟注按开池者分 4 档）');
}

console.log(`\n════════ 翻前应对：不一致 ${fails} 项 ════════`);
