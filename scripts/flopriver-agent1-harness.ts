/**
 * flopriver-agent1-harness.ts —— **只读探针共享管道**（审计 Agent 1：牌力 / 权益 / 牌面结构）
 *
 * 不修改任何生产代码；只从**生产入口** `analyzeManualHand` 与 `buildDecisionContext`
 * 取值并原样打印。
 */
import { analyzeManualHand, finalMathSanityCheck } from '../src/app/alphaPipeline.ts';
import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import type { ManualHandInput, ManualVillain } from '../src/app/manualInput/manualInput.ts';
import { parseManualInput } from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import { ALL_CARDS } from '../src/domain/types.ts';

export const OPTIONS = {
  rules: loadKnowledgeBaseOrThrow().allRules(),
  asOf: 1_757_000_000_000,
  writeLog: false,
  equitySeed: 20_260_913,
  budget: { softMs: 120_000, hardMs: 240_000 },
} as const;

export const A_ = (p: string, t: string, bb?: number, s?: string): Record<string, unknown> => ({
  position: p, type: t, ...(bb === undefined ? {} : { amountBB: bb }), ...(s === undefined ? {} : { street: s }),
});

export const BASE = {
  tableSize: 6, heroPosition: 'BTN', effectiveStackBB: 100, bigBlindBB: 2,
  seatStacksBB: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 },
  environment: 'MID_LOW_STAKES',
} as const;

export type VillainLike = ManualVillain;
export const villainOf = (quickProfile: string | undefined, seatId = 'seat_BB'): ManualVillain => ({
  seatId, persistentPlayerId: 'player_001', displayName: '对手', dynamicHint: 'UNKNOWN', stackBB: 100,
  ...(quickProfile === undefined ? {} : { quickProfile: quickProfile as ManualVillain['quickProfile'] }),
});

/** 6-max 翻前标准弃牌到 BTN 后加注到 3BB、BB 跟注 */
export const PF_BTN_RAISE_BB_CALL = [
  A_('UTG', 'FOLD'), A_('HJ', 'FOLD'), A_('CO', 'FOLD'),
  A_('BTN', 'RAISE', 3), A_('SB', 'FOLD'), A_('BB', 'CALL', 2),
];

export type Node = {
  tag: string;
  heroCards: readonly string[];
  board: readonly string[];
  street: string;
  history: readonly Record<string, unknown>[];
  villain: ManualVillain;
};

export type Detail = {
  r: ReturnType<typeof analyzeManualHand>;
  decision: Record<string, any>;
  dg: Record<string, any>;
  math: Record<string, any>;
  pf: Record<string, any>;
  built: Record<string, any>;
  warnings: readonly string[];
  vm: Record<string, any>;
  sanity: readonly string[];
};

export function detailOf(node: Node): Detail {
  const input = {
    ...BASE,
    heroCards: [...node.heroCards],
    board: [...node.board],
    street: node.street,
    actionHistory: [...node.history],
    villain: node.villain,
  } as unknown as ManualHandInput;
  const r = analyzeManualHand(input, OPTIONS);
  if (!r.ok) throw new Error(`分析失败 ${node.tag}：${String((r as any).stage)} ${JSON.stringify((r as any).issues)}`);
  const decision = r.decision as unknown as Record<string, any>;
  const dg = decision['diagnostics'] as Record<string, any>;
  const p = parseManualInput(input);
  if (!p.ok) throw new Error(`解析失败 ${node.tag}`);
  const g = buildAnalyzableState(p.value);
  if (!g.ok) throw new Error(`重建失败 ${node.tag}`);
  const built = buildDecisionContext({
    state: g.state, rules: OPTIONS.rules, environment: 'MID_LOW_STAKES', asOf: OPTIONS.asOf,
    ...(p.value.villain.quickProfile === undefined ? {} : { quickProfile: p.value.villain.quickProfile }),
    ...(p.value.villain.dynamicHint === undefined ? {} : { dynamicHint: p.value.villain.dynamicHint }),
    ...(p.value.villain.persistentPlayerId === undefined || p.value.villain.persistentPlayerId === null ? {} : { villainPersistentPlayerId: p.value.villain.persistentPlayerId }),
    ...(p.value.villain.seatId === undefined || p.value.villain.seatId === null ? {} : { villainSeatId: p.value.villain.seatId }),
    ...(p.value.villain.observedStats === undefined || p.value.villain.observedStats === null ? {} : { observedStats: p.value.villain.observedStats }),
    equitySeed: OPTIONS.equitySeed, budget: OPTIONS.budget,
  } as never);
  return {
    r, decision, dg,
    math: dg['math'] as Record<string, any>,
    pf: (dg['postflop'] ?? {}) as Record<string, any>,
    built: built as unknown as Record<string, any>,
    warnings: r.warnings as readonly string[],
    vm: r.viewModel as unknown as Record<string, any>,
    sanity: finalMathSanityCheck(decision as never, built.legal as never),
  };
}

/* ------------------------------------------------------------------ */
/* 格式化                                                              */
/* ------------------------------------------------------------------ */
export const n = (v: unknown, d = 6): string =>
  typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : String(v);
export const pct = (v: unknown, d = 4): string =>
  typeof v === 'number' && Number.isFinite(v) ? `${(v * 100).toFixed(d)}%` : String(v);
export const line = (s = ''): void => console.log(s);
export const kv = (k: string, v: unknown, w = 40): void => line(`  ${k.padEnd(w)}${String(v)}`);
export const rule = (w = 100): string => '─'.repeat(w);
export const zh = (cards: readonly string[]): string => cards.join(' ');

/** 逐组合范围样本：包含某点数的组合数 / 质量，以及支持集规模 */
export type ComboScan = {
  entries: number;
  support: number;
  totalMass: number;
  rankCombos: Record<string, { combos: number; mass: number }>;
  sample: readonly string[];
  duplicateHeroCards: number;
  duplicateBoardCards: number;
};

/* ------------------------------------------------------------------ */
/* 生产上下文（range / postflopFacts）访问                              */
/* ------------------------------------------------------------------ */

export type ProdContext = {
  /** `context.range` —— 主对手范围快照（**只有聚合量，没有逐组合 entries**） */
  snap: Record<string, any> | null;
  opponentRanges: readonly Record<string, any>[];
  facts: Record<string, any> | null;
  postflopFacts: Record<string, any> | null;
};

export function prodContextOf(built: Record<string, any>): ProdContext {
  /** `buildDecisionContext` 返回 `{ context, legal, warnings }` —— 自动解开 */
  const root = (built['context'] ?? built) as Record<string, any>;
  const snap = (root['range'] ?? null) as Record<string, any> | null;
  return {
    snap,
    opponentRanges: (root['opponentRanges'] ?? []) as readonly Record<string, any>[],
    facts: ((root['postflopFacts'] ?? null) as Record<string, any> | null)?.['opponentRangeFacts'] ?? null,
    postflopFacts: (root['postflopFacts'] ?? null) as Record<string, any> | null,
  };
}

/**
 * 逐组合扫描：需要 `context.range.range.entries`。
 *
 * ⚠️ 生产 `DecisionContext.range` 是 `RangeSnapshot`（见 `contextBuilder.ts:1655`），
 * **不含 entries**；只有 `contextBuilder.ts:3774` 内部的 `Range` 才有。
 * 因此本函数在生产上下文上会如实报告 `AVAILABLE: false`，而不是编造组合列表。
 */
export function scanRangeOrNull(
  built: Record<string, any>,
  rankFilter: readonly number[],
  heroCodes: readonly string[],
  boardCodes: readonly string[],
): (ComboScan & { AVAILABLE: true }) | { AVAILABLE: false; noteZh: string } {
  const root = (built['context'] ?? built) as Record<string, any>;
  const direct = (root['range'] ?? {}) as Record<string, any>;
  const entries = (direct['range']?.['entries'] ?? direct['entries'] ?? null) as readonly unknown[] | null;
  if (entries === null) {
    return {
      AVAILABLE: false,
      noteZh: '生产 DecisionContext.range 是 RangeSnapshot（无逐组合 entries）；逐组合事实改由 postflopFacts.opponentRangeFacts 的聚合量替代',
    };
  }
  return { AVAILABLE: true, ...scanRange(direct['range'] ?? direct, rankFilter, heroCodes, boardCodes) };
}

export const tierHistogramZh = (h: readonly number[] | undefined): string => {
  if (h === undefined) return '——';
  const names = ['坚果级(0)', '强成手(1)', '价值(2)', '中对(3)', '边缘(4)', '垃圾(5)'];
  return h.map((v, i) => `${names[i] ?? i}:${(v * 100).toFixed(2)}%`).join(' ');
};

export const RANK_CHAR = '23456789TJQKA';
/** 牌索引 → 规范牌文本（ALL_CARDS 顺序：花色外层 × 点数内层） */
export const codeOfIndex = (idx: number): string => {
  const c = ALL_CARDS[idx]!;
  return `${RANK_CHAR[c.rank - 2]!}${c.suit}`;
};

export function scanRange(
  range: Record<string, any>,
  rankFilter: readonly number[],
  heroCodes: readonly string[],
  boardCodes: readonly string[],
  sampleLimit = 12,
): ComboScan {
  const heroSet = new Set(heroCodes.map((s) => `${s[0]!.toUpperCase()}${s[1]!.toLowerCase()}`));
  const boardSet = new Set(boardCodes.map((s) => `${s[0]!.toUpperCase()}${s[1]!.toLowerCase()}`));
  let support = 0;
  let totalMass = 0;
  let dupHero = 0;
  let dupBoard = 0;
  const rankCombos: Record<string, { combos: number; mass: number }> = {};
  for (const r of rankFilter) rankCombos[String(r)] = { combos: 0, mass: 0 };
  const sample: string[] = [];
  for (const entry of (range['entries'] ?? []) as readonly Record<string, any>[]) {
    const idx = entry['combo']?.['cardIndices'] as readonly [number, number];
    const c1 = codeOfIndex(idx[0]); const c2 = codeOfIndex(idx[1]);
    const p = Number(entry['probability'] ?? 0);
    const label = `${c1}${c2}`;
    if (heroSet.has(c1) || heroSet.has(c2)) dupHero += 1;
    if (boardSet.has(c1) || boardSet.has(c2)) dupBoard += 1;
    if (!(p > 0)) continue;
    support += 1;
    totalMass += p;
    for (const r of rankFilter) {
      if (ALL_CARDS[idx[0]]!.rank === r || ALL_CARDS[idx[1]]!.rank === r) {
        rankCombos[String(r)]!.combos += 1;
        rankCombos[String(r)]!.mass += p;
      }
    }
    if (sample.length < sampleLimit) sample.push(`${label}:${p.toFixed(6)}`);
  }
  return {
    entries: ((range['entries'] ?? []) as readonly unknown[]).length,
    support, totalMass,
    rankCombos,
    sample, duplicateHeroCards: dupHero, duplicateBoardCards: dupBoard,
  };
}
