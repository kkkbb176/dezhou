/**
 * Agent 9（对抗性失败模式清单）· 只读探针公共库
 *
 * 本文件**只做读取与打印**：不修改任何生产代码 / 测试 / 策略参数。
 * 全部走生产入口 `analyzeManualHand`（+ `buildDecisionContext` 取结构化事实）。
 */
import { analyzeManualHand, finalMathSanityCheck } from '../src/app/alphaPipeline.ts';
import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import { parseManualInput, type ManualHandInput, type ManualVillain } from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';

export const OPTIONS = {
  rules: loadKnowledgeBaseOrThrow().allRules(),
  asOf: 1_757_000_000_000,
  writeLog: false,
  equitySeed: 20_260_913,
  budget: { softMs: 120_000, hardMs: 240_000 },
} as const;

export const A_ = (p: string, t: string, bb?: number, s?: string): Record<string, unknown> => ({
  position: p,
  type: t,
  ...(bb === undefined ? {} : { amountBB: bb }),
  ...(s === undefined ? {} : { street: s }),
});

export const BASE = {
  tableSize: 6,
  heroPosition: 'BTN',
  effectiveStackBB: 100,
  bigBlindBB: 2,
  seatStacksBB: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 },
  environment: 'MID_LOW_STAKES',
} as const;

export const MANIAC: ManualVillain = {
  seatId: 'seat_BB',
  persistentPlayerId: 'player_001',
  displayName: '阿豪',
  quickProfile: 'MANIAC',
  dynamicHint: 'UNKNOWN',
  stackBB: 100,
  observedStats: {
    handsObserved: 800, vpip: 0.48, pfr: 0.35, threeBet: 0.16, wtsd: 0.36,
    foldToFlopCBet: null, foldToTurnCBet: null, foldToRiverBet: null,
    flopCheckRaise: null, turnCheckRaise: null, riverCheckRaise: null,
  },
};
export const NORMAL: ManualVillain = { seatId: 'seat_BB', persistentPlayerId: 'player_001', quickProfile: 'NORMAL', dynamicHint: 'UNKNOWN', stackBB: 100 };

export type Rec = Record<string, any>;

export type Detail = {
  readonly r: any;
  readonly decision: Rec;
  readonly dg: Rec;
  readonly math: Rec;
  readonly pf: Rec;
  readonly legal: Rec;
  readonly built: Rec;
  readonly vm: Rec;
  readonly sanity: readonly string[];
};

/** 一个节点的全部结构化事实（生产入口 + 上下文） */
export function detailOf(input: ManualHandInput, street?: string): Detail {
  const r = analyzeManualHand(input, OPTIONS);
  if (!r.ok) return { r, decision: {}, dg: {}, math: {}, pf: {}, legal: {}, built: {}, vm: {}, sanity: [], ...(street === undefined ? {} : {}) } as Detail;
  const decision = r.decision as unknown as Rec;
  const dg = decision['diagnostics'] as Rec;
  const p = parseManualInput(input);
  const built = p.ok
    ? (buildDecisionContext({
        state: buildAnalyzableState(p.value).ok ? (buildAnalyzableState(p.value) as any).state : null,
        rules: OPTIONS.rules, environment: 'MID_LOW_STAKES', asOf: OPTIONS.asOf,
        ...(p.value.villain.quickProfile === undefined ? {} : { quickProfile: p.value.villain.quickProfile }),
        ...(p.value.villain.dynamicHint === undefined ? {} : { dynamicHint: p.value.villain.dynamicHint }),
        ...(p.value.villain.persistentPlayerId == null ? {} : { villainPersistentPlayerId: p.value.villain.persistentPlayerId }),
        ...(p.value.villain.seatId == null ? {} : { villainSeatId: p.value.villain.seatId }),
        ...(p.value.villain.observedStats == null ? {} : { observedStats: p.value.villain.observedStats }),
        equitySeed: OPTIONS.equitySeed, budget: OPTIONS.budget,
      } as never) as unknown as Rec)
    : {};
  return {
    r, decision, dg,
    math: (dg['math'] ?? {}) as Rec,
    pf: (dg['postflop'] ?? {}) as Rec,
    legal: (built['legal'] ?? {}) as Rec,
    built,
    vm: r.viewModel as unknown as Rec,
    sanity: finalMathSanityCheck(decision as never, built['legal'] as never),
  };
}

export const n = (v: unknown, d = 4): string => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : String(v));
export const pct = (v: unknown, d = 2): string => (typeof v === 'number' && Number.isFinite(v) ? `${(v * 100).toFixed(d)}%` : String(v));
export const J = (v: unknown, max = 400): string => {
  const s = JSON.stringify(v ?? null);
  return s === undefined ? 'undefined' : s.length > max ? `${s.slice(0, max)}…` : s;
};
export const line = (s = ''): void => console.log(s);
export const kv = (k: string, v: unknown, w = 40): void => line(`  ${k.padEnd(w)}${String(v)}`);
export const rule = (w = 100): string => '─'.repeat(w);

/** 失败节点也要能打印，便于区分「跑不通」与「结论不同」 */
export function guard(input: ManualHandInput, tag: string): Detail {
  const d = detailOf(input);
  if (!d.r.ok) {
    line(`【${tag}】❌ 分析失败 stage=${String(d.r.stage)} issues=${J(d.r.issues, 600)}`);
  }
  return d;
}
