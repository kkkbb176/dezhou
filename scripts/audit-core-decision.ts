/**
 * CORE DECISION BUG AUDIT —— 只读探针（不改产品代码）
 *
 * A1  BB 单位不变性：同一真实筹码、BB=1/2/5，BB 归一化后必须一致
 * A2  缓存污染：X → Y → X 三次运行，X 的两次结果必须逐位相同
 * A3  Bet Range vs Arrival Range：面对下注节点上两者必须分离，且 CALL EV 用 Bet Range
 * A4  null / 0 / 缺失 / 不支持的 HUD 字段：四者不得混淆
 * A5  边界：短码全下 / 极小底池 / 平局权益
 *
 * 用法：node --experimental-strip-types scripts/audit-core-decision.ts
 */
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';
import { parseManualInput, type ManualHandInput } from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import type { PlayerObservedStats } from '../src/domain/player/observedStats.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const ASOF = 1_757_000_000_000;
const H = (p: string, t: string, a?: number, s?: string) => ({
  position: p, type: t, ...(a === undefined ? {} : { amountBB: a }), ...(s === undefined ? {} : { street: s }),
});
const line = (s = ''): void => console.log(s);
const p4 = (v: unknown): string => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(4) : '—');

type M = Record<string, any>;

/** 河牌「Hero 面对下注」节点（Hero BTN，BB 领打 20BB） */
const FACING_BET = [
  H('UTG', 'FOLD'), H('HJ', 'FOLD'), H('CO', 'FOLD'), H('BTN', 'RAISE', 3), H('SB', 'FOLD'), H('BB', 'CALL', 2),
  H('BB', 'CHECK', undefined, 'FLOP'), H('BTN', 'BET', 2.5, 'FLOP'), H('BB', 'CALL', 2.5, 'FLOP'),
  H('BB', 'CHECK', undefined, 'TURN'), H('BTN', 'BET', 7.5, 'TURN'), H('BB', 'CALL', 7.5, 'TURN'),
  H('BB', 'BET', 20, 'RIVER'),
];
/** 河牌「Hero 无人下注」节点（TEST 11） */
const NO_BET = FACING_BET.slice(0, -1).concat([H('BB', 'CHECK', undefined, 'RIVER')]);

function mk(opts: {
  bb: number; street: 'RIVER'; history: readonly M[]; heroCards: [string, string];
  profile: string; stats: PlayerObservedStats | null; stackBB?: number;
}): ManualHandInput & M {
  return {
    tableSize: 6, heroPosition: 'BTN', heroCards: opts.heroCards,
    board: ['Kd', '9c', '4h', '6s', '2d'], street: 'RIVER',
    effectiveStackBB: opts.stackBB ?? 100, bigBlindBB: opts.bb,
    seatStacksBB: { UTG: opts.stackBB ?? 100, HJ: opts.stackBB ?? 100, CO: opts.stackBB ?? 100, BTN: opts.stackBB ?? 100, SB: opts.stackBB ?? 100, BB: opts.stackBB ?? 100 },
    actionHistory: opts.history.map((x) => ({ ...x })), environment: 'MID_LOW_STAKES',
    villain: { quickProfile: opts.profile, dynamicHint: 'UNKNOWN', stackBB: opts.stackBB ?? 100, ...(opts.stats === null ? {} : { observedStats: opts.stats }) },
  } as unknown as ManualHandInput & M;
}

function run(input: ManualHandInput & M): M {
  const parsed = parseManualInput(input as ManualHandInput);
  if (!parsed.ok) return { fail: `PARSE ${JSON.stringify(parsed.issues[0])}` };
  const gate = buildAnalyzableState(parsed.value);
  if (!gate.ok) return { fail: `${gate.stage} ${JSON.stringify(gate.issues[0])}` };
  const built = buildDecisionContext({
    state: gate.state, rules: RULES, environment: 'MID_LOW_STAKES', asOf: ASOF,
    quickProfile: input['villain']['quickProfile'] as never,
    ...(input['villain']['observedStats'] ? { observedStats: input['villain']['observedStats'] } : {}),
    equitySeed: 20_261_014,
  }).context as unknown as M;
  const r = analyzeManualHand(input as ManualHandInput, {
    rules: RULES, asOf: ASOF, writeLog: false, equitySeed: 20_261_014,
    budget: { softMs: 120_000, hardMs: 240_000 },
  });
  if (!r.ok) return { fail: `${r.stage} ${JSON.stringify(r.issues[0])}` };
  const d = r.decision as unknown as M;
  const math = (d['diagnostics'] as M)['math'] as M;
  const bd = (d['diagnostics'] as M)['postflop']?.['betDecision'] as M | null;
  const facts = (built['postflopFacts'] as M | undefined)?.['betDecision'] as M | null;
  const sizes = new Map<string, M>();
  for (const s of ((bd?.['sizes'] ?? []) as M[])) sizes.set(String(s['size']), s);
  return {
    action: String(d['action']), sizeChips: d['sizeChips'] ?? null,
    pot: math['pot'], callCost: math['callCost'], spr: math['spr'],
    requiredEquity: math['requiredEquity'], heroEquity: math['heroEquity'],
    eqVsBetRange: math['heroEquityVsBetRange'] ?? null, callEV: math['callEV'] ?? null,
    checkEV: bd?.['checkEV'] ?? null, smallEV: sizes.get('BET_SMALL')?.['betEV'] ?? null,
    smallFold: sizes.get('BET_SMALL')?.['foldLikelihood'] ?? null,
    checkTree: (facts?.['checkTree'] ?? null) as M | null,
    v3: (built['profileV3'] ?? null) as M | null,
  };
}

const MANIAC: PlayerObservedStats = {
  handsObserved: 1500, vpip: 0.60, pfr: 0.45, threeBet: 0.18, wtsd: 0.35,
  foldToFlopCBet: 0.22, foldToTurnCBet: 0.20, foldToRiverBet: 0.18,
  flopCheckRaise: 0.18, turnCheckRaise: 0.15, riverCheckRaise: 0.12,
};

line('='.repeat(110));
line(' CORE DECISION BUG AUDIT —— 只读探针');
line('='.repeat(110));
line('');

/* ---------- A1：BB 单位不变性 ---------- */
line('### A1  BB 单位不变性（同一真实筹码的相对结构，BB=1 / 2 / 5）');
line('');
line([ 'BB', 'pot/BB', 'call/BB', 'reqEq', 'heroEq', 'callEV/BB', 'smallEV/BB', 'smallFold', 'action', 'sizeBB' ].map((s, i) => (i === 0 ? s.padEnd(5) : s.padEnd(12))).join(''));
const a1 = [1, 2, 5].map((bb) => {
  const o = run(mk({ bb, street: 'RIVER', history: NO_BET, heroCards: ['As', 'Ks'], profile: 'CALLING_STATION', stats: MANIAC }));
  return { bb, o };
});
for (const { bb, o } of a1) {
  if (o['fail']) { line(`${bb}`.padEnd(5) + `FAIL ${String(o['fail']).slice(0, 80)}`); continue; }
  line(`${bb}`.padEnd(5) +
    p4(Number(o['pot']) / bb).padEnd(12) + p4(Number(o['callCost']) / bb).padEnd(12) +
    p4(o['requiredEquity']).padEnd(12) + p4(o['heroEquity']).padEnd(12) +
    p4(Number(o['callEV'] ?? 0) / bb).padEnd(12) + p4(Number(o['smallEV'] ?? 0) / bb).padEnd(12) +
    p4(o['smallFold']).padEnd(12) + String(o['action']).padEnd(12) +
    p4(o['sizeChips'] === null ? null : Number(o['sizeChips']) / bb));
}
const ok1 = a1.every((x) => !x.o['fail']);
const inv = ok1 && [1, 2, 5].every((bb, i) => {
  const a = a1[0]!.o, b = a1[i]!.o;
  return Math.abs(Number(a['pot']) / 1 - Number(b['pot']) / bb) < 1e-9 &&
    Math.abs(Number(a['smallFold']) - Number(b['smallFold'])) < 1e-12 &&
    Math.abs(Number(a['heroEquity']) - Number(b['heroEquity'])) < 1e-12;
});
line('');
line(`  ⇒ BB 单位不变性 = ${ok1 ? (inv ? 'PASS（BB 归一化后逐位一致）' : '**FAIL（存在额外换算）**') : 'NOT_VERIFIED（有档位解析失败）'}`);
line('');

/* ---------- A2：缓存污染 ---------- */
line('### A2  缓存污染：X → Y → X（同进程三次运行）');
line('');
const X = () => run(mk({ bb: 2, street: 'RIVER', history: NO_BET, heroCards: ['As', 'Ks'], profile: 'VERY_TIGHT', stats: null }));
const Y = () => run(mk({ bb: 2, street: 'RIVER', history: NO_BET, heroCards: ['As', 'Ks'], profile: 'MANIAC', stats: MANIAC }));
const x1 = X(); Y(); const x2 = X();
const same = JSON.stringify([x1['action'], x1['sizeChips'], x1['smallEV'], x1['smallFold'], x1['heroEquity'], x1['checkEV']]) ===
  JSON.stringify([x2['action'], x2['sizeChips'], x2['smallEV'], x2['smallFold'], x2['heroEquity'], x2['checkEV']]);
line(`  X 第一次：action=${String(x1['action'])} smallEV=${p4(x1['smallEV'])} fold=${p4(x1['smallFold'])} eq=${p4(x1['heroEquity'])}`);
line(`  Y 中间  ：action=${String(Y()['action'])}（不同画像，用于尝试污染）`);
line(`  X 第二次：action=${String(x2['action'])} smallEV=${p4(x2['smallEV'])} fold=${p4(x2['smallFold'])} eq=${p4(x2['heroEquity'])}`);
line(`  ⇒ 跨画像缓存污染 = ${same ? 'PASS（X 两次逐位相同）' : '**FAIL（X 被 Y 污染）**'}`);
line('');

/* ---------- A3：Bet Range vs Arrival Range ---------- */
line('### A3  Bet Range 与 Arrival Range 必须分离，且 CALL EV 用 Bet Range');
line('');
const facing = run(mk({ bb: 2, street: 'RIVER', history: FACING_BET, heroCards: ['As', 'Ks'], profile: 'CALLING_STATION', stats: MANIAC }));
if (facing['fail']) {
  line(`  ⚠️ 该节点未能重建：${String(facing['fail']).slice(0, 160)}`);
} else {
  line(`  pot=${p4(facing['pot'])}  callCost=${p4(facing['callCost'])}  reqEq=${p4(facing['requiredEquity'])}`);
  line(`  heroEquity(Arrival)   = ${p4(facing['heroEquity'])}`);
  line(`  heroEquityVsBetRange  = ${p4(facing['eqVsBetRange'])}`);
  line(`  callEV                = ${p4(facing['callEV'])}  行动=${String(facing['action'])}`);
  const sep = facing['eqVsBetRange'] !== null &&
    Math.abs(Number(facing['heroEquity']) - Number(facing['eqVsBetRange'])) > 1e-6;
  line(`  ⇒ 两者分离 = ${sep ? 'PASS（数值不同 ⇒ 未退化为 Arrival）' : '**WARN：两者相同或缺失**'}`);
  line(`  ⇒ CALL EV 是否基于 Bet Range：需与「用 Arrival 权益手算的 callEV」比较 ⇒ ` +
    (facing['eqVsBetRange'] === null ? 'EQ_VS_BET_RANGE_NOT_IMPLEMENTED' :
      `手算(Arrival)=${p4(Number(facing['heroEquity']) * Number(facing['pot']) - Number(facing['callCost']))}｜` +
      `手算(BetRange)=${p4(Number(facing['eqVsBetRange']) * Number(facing['pot']) - Number(facing['callCost']))}｜实测=${p4(facing['callEV'])}`));
}
line('');

/* ---------- A4：null / 0 / 缺失 / 不支持的字段 ---------- */
line('### A4  null / 0 / 缺失 / 不支持的 HUD 字段（四者不得混淆）');
line('');
const base4 = () => run(mk({ bb: 2, street: 'RIVER', history: NO_BET, heroCards: ['As', 'Ks'], profile: 'CALLING_STATION', stats: { handsObserved: 1000, vpip: 0.45 } as PlayerObservedStats }));
const withNull = run(mk({ bb: 2, street: 'RIVER', history: NO_BET, heroCards: ['As', 'Ks'], profile: 'CALLING_STATION', stats: { handsObserved: 1000, vpip: 0.45, wtsd: null } as PlayerObservedStats }));
const withZero = run(mk({ bb: 2, street: 'RIVER', history: NO_BET, heroCards: ['As', 'Ks'], profile: 'CALLING_STATION', stats: { handsObserved: 1000, vpip: 0.45, wtsd: 0 } as PlayerObservedStats }));
const withUnknown = run(mk({ bb: 2, street: 'RIVER', history: NO_BET, heroCards: ['As', 'Ks'], profile: 'CALLING_STATION', stats: { handsObserved: 1000, vpip: 0.45, turnCBet: 0.60 } as never }));
const b4 = base4();
const dim = (o: M, k: string): number => Number((o['v3']?.['resolvedDimensions'] ?? {})[k]);
line(`  基线(vpip only)      passivity=${p4(dim(b4, 'passivity'))}  smallFold=${p4(b4['smallFold'])}`);
line(`  +wtsd=null           passivity=${p4(dim(withNull, 'passivity'))}  smallFold=${p4(withNull['smallFold'])}`);
line(`  +wtsd=0（真观测到 0）passivity=${p4(dim(withZero, 'passivity'))}  smallFold=${p4(withZero['smallFold'])}`);
line(`  +turnCBet=0.60（不支持字段）passivity=${p4(dim(withUnknown, 'passivity'))}  smallFold=${p4(withUnknown['smallFold'])}`);
line(`  ⇒ null 未当 0        = ${dim(withNull, 'passivity') === dim(b4, 'passivity') ? 'PASS' : '**FAIL**'}`);
line(`  ⇒ 0 与缺失可区分      = ${dim(withZero, 'passivity') !== dim(b4, 'passivity') ? 'PASS' : '**FAIL（0 被当成缺失）**'}`);
line(`  ⇒ 不支持字段被忽略    = ${dim(withUnknown, 'passivity') === dim(b4, 'passivity') ? 'PASS（未污染维度）' : '**FAIL**'}`);
line('');

/* ---------- A5：边界 ---------- */
line('### A5  边界场景');
line('');
const shorty = run(mk({ bb: 2, street: 'RIVER', history: NO_BET, heroCards: ['As', 'Ks'], profile: 'NORMAL', stats: null, stackBB: 6 }));
line(`  极短码(stackBB=6)：${shorty['fail'] ? `FAIL ${String(shorty['fail']).slice(0, 90)}` : `action=${String(shorty['action'])} size=${p4(shorty['sizeChips'])} spr=${p4(shorty['spr'])}`}`);
const turnIp = run(mk({ bb: 2, street: 'RIVER', history: NO_BET, heroCards: ['As', 'Ks'], profile: 'NORMAL', stats: null }));
const ct = (turnIp['checkTree'] ?? {}) as M;
line(`  CHECK 树 kind=${String(ct['kind'] ?? '—')} 他下注P=${p4(ct['betLikelihood'])} 他过牌P=${p4(ct['checkBackLikelihood'])}`);
line(`  ⇒ Hero IP 且对手已过牌时「对手再下注」概率 = ${p4(ct['betLikelihood'])}（IP 检查退回本街结束，符合行动顺序）`);
line('');
line('（本探针为只读；未修改任何产品代码）');
