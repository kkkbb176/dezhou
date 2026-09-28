/**
 * 目标(1) 复核：**无标签 + 只有实测统计**时，录入的数据到底进不进模型？
 *
 * 三个决策面各测一遍（每个都对比 5 种形态）：
 *   A 面对下注（响应层：弃/跟刻度 + 分街条目）
 *   B 他过牌给我（下注范围层 + 下注决策）
 *   C 翻前面对 3Bet（翻前加注响应模型）
 *
 * 形态：① 什么都没有 ② 只有 stats ③ stats + 标签 ④ stats + 身份 ⑤ stats + 标签 + 身份
 */
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import type { ManualHandInput } from '../src/app/manualInput/manualInput.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const OPTIONS = {
  rules: RULES, asOf: 1_757_000_000_000, writeLog: false,
  equitySeed: 20_260_913, budget: { softMs: 900_000, hardMs: 1_800_000 },
} as const;

const A = (position: string, type: string, amountBB?: number, street?: string): Record<string, unknown> => ({
  position, type,
  ...(amountBB === undefined ? {} : { amountBB }),
  ...(street === undefined ? {} : { street }),
});
const W = (s: string): number => [...s].reduce((a, c) => a + (c.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
const pad = (s: string, w: number): string => s + ' '.repeat(Math.max(0, w - W(s)));
const rule = (w = 156): string => '='.repeat(w);
const n = (v: unknown, d = 2): string => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : '—');
const pct = (v: unknown, d = 1): string =>
  typeof v === 'number' && Number.isFinite(v) ? `${(v * 100).toFixed(d)}%` : '—';
const S9 = { UTG: 100, UTG1: 100, UTG2: 100, LJ: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 } as const;

/** 一个「很紧且在翻牌面对 c-bet 会弃很多」的对手（2000 手） */
const STATS = {
  handsObserved: 2000, vpip: 0.105, pfr: 0.071, threeBet: 0.03, wtsd: 0.24,
  foldToFlopCBet: 0.78, foldToTurnCBet: 0.6, foldToRiverBet: 0.6,
  flopCheckRaise: 0.06, turnCheckRaise: 0.05, riverCheckRaise: 0.04,
} as const;

type Form = { name: string; villain: Record<string, unknown> };
const FORMS: readonly Form[] = [
  { name: '① 什么都没有（对照）', villain: {} },
  { name: '② 只有 stats', villain: { observedStats: STATS } },
  { name: '③ stats + 标签', villain: { observedStats: STATS, quickProfile: 'VERY_TIGHT' } },
  { name: '④ stats + 身份', villain: { observedStats: STATS, seatId: 'seat_UTG', persistentPlayerId: 'p_utg', stackBB: 100 } },
  { name: '⑤ stats + 标签 + 身份', villain: { observedStats: STATS, quickProfile: 'VERY_TIGHT', seatId: 'seat_UTG', persistentPlayerId: 'p_utg', stackBB: 100 } },
];

const preflopTo = (): Record<string, unknown>[] => [
  A('UTG', 'RAISE', 3), A('UTG1', 'FOLD'), A('UTG2', 'FOLD'), A('LJ', 'FOLD'), A('HJ', 'FOLD'), A('CO', 'FOLD'),
  A('BTN', 'CALL', 3), A('SB', 'FOLD'), A('BB', 'FOLD'),
];

function mk(
  form: Form,
  opts: { hero: readonly [string, string]; checkedTo?: boolean; threeBet?: boolean; heroPos?: string },
): ManualHandInput {
  const heroPos = opts.heroPos ?? 'BTN';
  if (opts.threeBet === true) {
    return {
      tableSize: 9, heroPosition: 'BTN', heroCards: opts.hero, board: [], street: 'PREFLOP',
      effectiveStackBB: 100, bigBlindBB: 100, seatStacksBB: S9,
      actionHistory: [
        A('UTG', 'FOLD'), A('UTG1', 'FOLD'), A('UTG2', 'FOLD'), A('LJ', 'FOLD'), A('HJ', 'FOLD'),
        A('CO', 'FOLD'), A('BTN', 'RAISE', 3), A('SB', 'FOLD'), A('BB', 'RAISE', 9),
      ],
      environment: 'MID_LOW_STAKES', villain: form.villain,
    } as unknown as ManualHandInput;
  }
  const hist = [...preflopTo()];
  hist.push(opts.checkedTo === true ? A('UTG', 'CHECK', undefined, 'FLOP') : A('UTG', 'BET', 5, 'FLOP'));
  return {
    tableSize: 9, heroPosition: heroPos, heroCards: opts.hero, board: ['Ks', '7h', '2c'], street: 'FLOP',
    effectiveStackBB: 100, bigBlindBB: 100, seatStacksBB: S9,
    actionHistory: hist, environment: 'MID_LOW_STAKES', villain: form.villain,
  } as unknown as ManualHandInput;
}

type Snapshot = {
  action: string;
  size: string;
  eqBet: number | null;
  callEV: number | null;
  foldLarge: number | null;
  betEV: number | null;
  checkEV: number | null;
  streetFoldScale: number | null;
  usedStats: number;
  strengths: string;
};

function snap(input: ManualHandInput): Snapshot {
  const r = analyzeManualHand(input, OPTIONS);
  if (!r.ok) {
    return {
      action: `FAIL/${r.stage}`, size: '-', eqBet: null, callEV: null, foldLarge: null, betEV: null,
      checkEV: null, streetFoldScale: null, usedStats: 0, strengths: '',
    };
  }
  const d: any = r.decision;
  const dg: any = d.diagnostics;
  const pf: any = dg.postflop ?? {};
  const bd: any = pf.betDecision ?? {};
  const sizes: any[] = bd.sizes ?? [];
  const last = sizes.length === 0 ? null : sizes[sizes.length - 1];
  const rr: any = pf.raiseResponse ?? {};
  const tend = rr.tendencies ?? null;
  const v3: any = dg.profileV3 ?? null;
  return {
    action: String(d.action),
    size: d.sizeBB === undefined ? '—' : Number(d.sizeBB).toFixed(2),
    eqBet: dg.math.heroEquityVsBetRange ?? null,
    callEV: dg.math.callEV ?? null,
    foldLarge: last === null ? null : (last.foldLikelihood ?? null),
    betEV: last === null ? null : (last.betEV ?? null),
    checkEV: bd.checkEV ?? null,
    streetFoldScale: tend === null ? null : (tend.streetFoldScale ?? null),
    usedStats: ((dg.player?.measuredStats?.usedStatKeys ?? []) as readonly string[]).length,
    strengths:
      v3 === null
        ? '（无 V3 快照）'
        : `agg=${n(v3.resolved?.resolvedDimensions?.aggression, 3)} betAgg=${n(v3.resolved?.street?.FLOP?.betAggression, 3)} foldScale=${n(v3.resolved?.street?.FLOP?.foldScale, 3)}`,
  };
}

function section(title: string, build: (f: Form) => ManualHandInput): void {
  console.log('');
  console.log(rule());
  console.log(title);
  console.log(rule());
  console.log(
    pad('形态', 26) + pad('动作', 8) + pad('尺寸', 7) + pad('EqVs下注', 10) + pad('CALL EV', 9) +
    pad('P(弃)最大档', 11) + pad('BetEV', 9) + pad('CHECK', 9) + pad('streetFold', 11) + pad('接入', 5) + 'V3',
  );
  console.log('-'.repeat(156));
  for (const f of FORMS) {
    const s = snap(build(f));
    console.log(
      pad(f.name, 26) + pad(s.action, 8) + pad(s.size, 7) + pad(pct(s.eqBet), 10) + pad(n(s.callEV, 1), 9) +
      pad(pct(s.foldLarge), 11) + pad(n(s.betEV, 1), 9) + pad(n(s.checkEV, 1), 9) +
      pad(n(s.streetFoldScale, 4), 11) + pad(String(s.usedStats), 5) + s.strengths,
    );
  }
}

section('A 面对下注（Hero A♠Q♥ 面对 UTG 的 5BB）→ 响应层是否吃统计', (f) => mk(f, { hero: ['As', 'Qh'] }));
section('B 他过牌给我（Hero A♠5♠ 空气）→ 下注范围层是否吃统计', (f) => mk(f, { hero: ['As', '5s'], checkedTo: true }));
section('C 翻前面对 3Bet（Hero A♠Q♠）→ 翻前加注响应模型是否吃统计', (f) => mk(f, { hero: ['As', 'Qs'], threeBet: true }));
