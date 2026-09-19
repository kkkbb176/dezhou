/**
 * 测试牌局 07 —— BTN A♣5♣，**转牌决策点**（BB 老郑过牌，轮到我）
 *
 * 6-max 现金桌，盲注 1/2，有效筹码 200（100BB）
 *
 * 我的手牌：A♣5♣ = A 高 + **坚果同花听牌**（未完成）
 * 对手：BB「老郑」NIT/紧弱，1180 手
 *   VPIP 17% / PFR 11% / 3Bet 4% / WTSD 21%
 *   FoldFlopCBet 47% / FoldTurnCBet 55% / FoldRiverBet 63%
 *   CheckRaise: flop 4% / turn 3% / river 1%
 *
 * 翻前：UTG/HJ/CO 弃 → BTN 开 6 → SB 弃 → BB 跟 ⇒ 13
 * 翻牌 K♣8♦4♣：BB 过 / BTN 下 5 / BB 跟 ⇒ 23
 * 转牌 2♠：BB 过 ⇒ **Hero 决策（本脚本的决策点）**
 *
 * 筹码：Hero 已投 6+5 = 11 ⇒ 剩 189；Villain 同 ⇒ 剩 189；SPR = 189/23 = 8.22
 *
 * ## 三组对照
 * A. V2 archetype-only（VERY_TIGHT，无统计）
 * B. V3 老郑（VERY_TIGHT + 1180 手）
 * C. 反证：跟注站老林（VPIP 49 / FoldTurnCBet 24 / WTSD 40）
 */

import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';
import { parseManualInput } from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import type { PlayerObservedStats } from '../src/domain/player/observedStats.ts';
import type { ManualHandInput } from '../src/app/manualInput/manualInput.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const SEED = 20_260_913;

const A = (p: string, t: string, a?: number, s?: string) => ({
  position: p, type: t,
  ...(a === undefined ? {} : { amountBB: a }),
  ...(s === undefined ? {} : { street: s }),
});

/** 只到转牌决策点为止 */
const HISTORY = [
  A('UTG', 'FOLD'), A('HJ', 'FOLD'), A('CO', 'FOLD'),
  A('BTN', 'RAISE', 3), A('SB', 'FOLD'), A('BB', 'CALL', 2),
  A('BB', 'CHECK', undefined, 'FLOP'), A('BTN', 'BET', 2.5, 'FLOP'), A('BB', 'CALL', 2.5, 'FLOP'),
  A('BB', 'CHECK', undefined, 'TURN'),
];
const BOARD = ['Kc', '8d', '4c', '2s'];
const SEATS: Record<string, number> = { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 };

const LAOZHENG: PlayerObservedStats = {
  handsObserved: 1180,
  vpip: 0.17, pfr: 0.11, threeBet: 0.04, wtsd: 0.21,
  foldToFlopCBet: 0.47, foldToTurnCBet: 0.55, foldToRiverBet: 0.63,
  flopCheckRaise: 0.04, turnCheckRaise: 0.03, riverCheckRaise: 0.01,
};
const LAOLIN: PlayerObservedStats = {
  handsObserved: 860,
  vpip: 0.49, pfr: 0.09, threeBet: 0.03, wtsd: 0.40,
  foldToFlopCBet: 0.21, foldToTurnCBet: 0.24, foldToRiverBet: 0.16,
  flopCheckRaise: 0.05, turnCheckRaise: 0.03, riverCheckRaise: 0.02,
};

type M = Record<string, any>;

function run(label: string, quickProfile: string, observedStats: PlayerObservedStats | null): M {
  const input = {
    tableSize: 6, heroPosition: 'BTN', heroCards: ['Ac', '5c'],
    board: BOARD, street: 'TURN',
    effectiveStackBB: 100, bigBlindBB: 2,
    seatStacksBB: { ...SEATS },
    actionHistory: HISTORY.map((a) => ({ ...a })),
    environment: 'MID_LOW_STAKES',
    villain: {
      quickProfile, dynamicHint: 'UNKNOWN', stackBB: 100,
      ...(observedStats === null ? {} : { observedStats }),
    },
  } as unknown as ManualHandInput;

  const parsed = parseManualInput(input);
  if (!parsed.ok) throw new Error(`PARSE ${JSON.stringify(parsed.issues.slice(0, 3))}`);
  const gate = buildAnalyzableState(parsed.value);
  if (!gate.ok) throw new Error(`STATE ${JSON.stringify(gate.issues.slice(0, 3))}`);

  const built = buildDecisionContext({
    state: gate.state, rules: RULES, environment: 'MID_LOW_STAKES',
    asOf: 1_757_000_000_000, quickProfile: quickProfile as never,
    ...(observedStats === null ? {} : { observedStats }),
  });
  const ctx = built.context as unknown as Record<string, any>;

  const r = analyzeManualHand(input, {
    rules: RULES, asOf: 1_757_000_000_000, writeLog: false,
    equitySeed: SEED, budget: { softMs: 120_000, hardMs: 240_000 },
  });
  if (!r.ok) throw new Error(`ANALYZE ${JSON.stringify(r.issues.slice(0, 3))}`);
  const d = r.decision as unknown as Record<string, any>;

  const bdFacts = (ctx['postflopFacts'] as M | undefined)?.['betDecision'] as M | null;
  const bdDiag = (d['diagnostics'] as M)['postflop']?.['betDecision'] as M | null;
  const keyOf = (s: M): string => String(s['kind'] ?? s['size']);
  const probByKind = new Map<string, M>();
  for (const s of ((bdFacts?.['sizes'] ?? []) as readonly M[])) probByKind.set(keyOf(s), s);
  const scoreByKind = new Map<string, M>();
  for (const s of ((bdDiag?.['sizes'] ?? []) as readonly M[])) scoreByKind.set(keyOf(s), s);

  return {
    label,
    action: String(d['action']),
    bestSize: bdDiag?.['bestSize'] ?? null,
    confidence: d['confidence'],
    classification: String(d['classification']),
    basis: String((d['diagnostics'] as M)['decisionBasis']?.['kind']),
    fold: Object.fromEntries([...probByKind].map(([k, v]) => [k, Number(v['foldLikelihood'])])),
    call: Object.fromEntries([...probByKind].map(([k, v]) => [k, Number(v['callLikelihood'])])),
    raise: Object.fromEntries([...probByKind].map(([k, v]) => [k, Number(v['raiseLikelihood'])])),
    score: Object.fromEntries([...scoreByKind].map(([k, v]) => [k, Number(v['score'])])),
    betEV: Object.fromEntries([...scoreByKind].map(([k, v]) => [k, v['betEV'] === null ? null : Number(v['betEV'])])),
    deltaVsCheck: Object.fromEntries([...scoreByKind].map(([k, v]) => [k, v['deltaVsCheck'] === null ? null : Number(v['deltaVsCheck'])])),
    eqVsCall: Object.fromEntries([...probByKind].map(([k, v]) => [k, v['heroEquityVsCallRange'] === null ? null : Number(v['heroEquityVsCallRange'])])),
    amounts: Object.fromEntries([...scoreByKind].map(([k, v]) => [k, Number(v['betAmount'])])),
    /** 河牌前的 CHECK 树（前位过牌 ⇒ 他仍可下注） */
    checkEV: bdFacts?.['checkTree']?.['checkEV'] ?? null,
    checkTreeKind: bdFacts?.['checkTree']?.['kind'] ?? null,
    heroCallEV: bdFacts?.['checkTree']?.['heroCallEV'] ?? null,
    heroFoldEV: bdFacts?.['checkTree']?.['heroFoldEV'] ?? null,
    checkBackLikelihood: bdFacts?.['checkTree']?.['checkBackLikelihood'] ?? null,
    betLikelihood: bdFacts?.['checkTree']?.['betLikelihood'] ?? null,
    eqVsCheckBackRange: bdFacts?.['checkTree']?.['heroEquityVsCheckBackRange'] ?? null,
    eqVsBetRange: bdFacts?.['checkTree']?.['heroEquityVsBetRange'] ?? null,
    heroBestResponseEV: bdFacts?.['checkTree']?.['heroBestResponseEV'] ?? null,
    raiseResponse: bdFacts?.['checkTree']?.['raiseResponse'] ?? null,
    profileV3: ctx['profileV3'] ?? null,
    math: ctx['math'] as M,
    reasons: (d['reasons'] ?? []) as readonly M[],
  };
}

const A2 = run('A. V2（VERY_TIGHT 无统计）', 'VERY_TIGHT', null);
const B3 = run('B. V3 老郑 1180 手', 'VERY_TIGHT', LAOZHENG);
const C4 = run('C. 反证：跟注站老林', 'CALLING_STATION', LAOLIN);

const f = (x: unknown, d = 2): string => (typeof x === 'number' && Number.isFinite(x) ? x.toFixed(d) : '—');
const pct = (x: unknown, d = 2): string => (typeof x === 'number' && Number.isFinite(x) ? `${(x * 100).toFixed(d)}%` : '—');
const line = (s = ''): void => console.log(s);

line('='.repeat(86));
line(' 测试牌局 07 —— BTN A♣5♣ ｜ K♣8♦4♣2♠ ｜ **转牌 BB 过牌，轮到我**');
line('='.repeat(86));
line('');
line(`  底池 ${f(B3.math['pot'])} ｜ 有效筹码 ${f(B3.math['effectiveStack'])} ｜ SPR ${f(B3.math['spr'])}`);
line(`  我的牌力 = ${String(B3.math['handRankZh'])}（类别 ${String(B3.math['handCategory'])}）`);
line(`  权益 = ${pct(B3.math['heroEquity'], 3)} ｜ 来源 = ${JSON.stringify(B3.math['equitySource'])}`);
line(`  CHECK 树 = ${String(B3.checkTreeKind)} ｜ 他过牌概率 ${pct(B3.checkBackLikelihood, 1)} / 他下注概率 ${pct(B3.betLikelihood, 1)}`);
line('');

line('  ── 三组对照 ──');
line('');
line('  指标'.padEnd(22) + 'A. V2 紧弱'.padEnd(20) + 'B. V3 老郑'.padEnd(20) + 'C. 跟注站老林');
line('  ' + '-'.repeat(82));
const row = (n: string, a: unknown, b: unknown, c: unknown): void =>
  line('  ' + n.padEnd(20) + String(a).padEnd(20) + String(b).padEnd(20) + String(c));
row('最终动作', A2.action, B3.action, C4.action);
row('建议尺寸', String(A2.bestSize ?? '—'), String(B3.bestSize ?? '—'), String(C4.bestSize ?? '—'));
row('置信度', f(A2.confidence, 3), f(B3.confidence, 3), f(C4.confidence, 3));
row('分类', A2.classification, B3.classification, C4.classification);
line('');
for (const k of ['BET_SMALL', 'BET_MEDIUM', 'BET_LARGE']) {
  row(`${k} Fold%`, pct(A2.fold[k]), pct(B3.fold[k]), pct(C4.fold[k]));
}
line('');
for (const k of ['BET_SMALL', 'BET_MEDIUM', 'BET_LARGE']) {
  row(`${k} Call%`, pct(A2.call[k]), pct(B3.call[k]), pct(C4.call[k]));
}
line('');
for (const k of ['BET_SMALL', 'BET_MEDIUM', 'BET_LARGE']) {
  row(`${k} BetEV`, f(A2.betEV[k]), f(B3.betEV[k]), f(C4.betEV[k]));
}
line('');
for (const k of ['BET_SMALL', 'BET_MEDIUM', 'BET_LARGE']) {
  row(`${k} 策略评分`, f(A2.score[k], 4), f(B3.score[k], 4), f(C4.score[k], 4));
}
line('');
row('CHECK 树 EV', f(A2.checkEV, 3), f(B3.checkEV, 3), f(C4.checkEV, 3));
row('被跟注时我的权益', pct(A2.eqVsCall['BET_SMALL']), pct(B3.eqVsCall['BET_SMALL']), pct(C4.eqVsCall['BET_SMALL']));
line('');
line('  ── V3 分街系数（老郑，本节点是 TURN） ──');
line(`    turn : ${JSON.stringify(B3.profileV3?.street?.TURN)}  ← 本街生效`);
line(`    flop : ${JSON.stringify(B3.profileV3?.street?.FLOP)}`);
line(`    river: ${JSON.stringify(B3.profileV3?.street?.RIVER)}`);
line(`    resolved 维度 = ${JSON.stringify(B3.profileV3?.dimensions)}`);
line(`    实测项数 = ${B3.profileV3?.observedStatCount} ｜ 可信度档 = ${B3.profileV3?.confidenceTierZh}`);
line('');
line('  ── 引擎理由（B：V3 老郑） ──');
for (const reason of B3.reasons.slice(0, 7)) {
  line(`    [${String(reason['code'])}] ${String(reason['textZh']).slice(0, 230)}`);
}
line('');
line('  运行前写定的预期：');
line('    我持**坚果同花听牌**（9 张♥/♣补牌）+ A 高；老郑 FoldTurnCBet 55% ⇒ turnFoldScale 应 > 1；');
line('    诈唬有两条收益：他弃牌 + 我中同花 ⇒ 预期引擎倾向下注；');
line('    尺寸预期偏小（听牌半诈唬，且他 check-raise 只有 3%）。');
