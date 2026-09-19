/**
 * 测试牌局 06 —— BTN A♣5♣，**转牌 CHECK BACK**，河牌未完成同花，BB「老郑」过牌
 *
 * 6-max 现金桌，盲注 1/2，有效筹码 200（100BB）
 *
 * 老郑（BB）＝NIT / 紧弱型，1180 手：
 *   VPIP 17% / PFR 11% / 3Bet 4% / WTSD 21%
 *   FoldFlopCBet 47% / FoldTurnCBet 55% / **FoldRiverBet 63%**
 *   Flop/Turn/River CheckRaise 4% / 3% / 1%
 *
 * 牌局与测试牌局 04 的**牌面与行动线完全相同**，只换了对手画像与我的手牌：
 *   翻前：UTG/HJ/CO 弃 → BTN 开 6 → SB 弃 → BB 跟 ⇒ 13
 *   翻牌 K♣8♦4♣：BB 过 / BTN 下 5 / BB 跟 ⇒ 23
 *   转牌 2♠：BB 过 / **BTN 过牌（CHECK BACK，不下注）** ⇒ 底池仍 23
 *   河牌 Q♦：BB 过 ⇒ Hero 决策（双方各剩 **189**，SPR **8.22**）
 *
 * 我的牌：A♣5♣ = A 高 + **未完成**坚果同花听牌（零摊牌价值）
 *
 * ## 三组对照（这是本测试的核心）
 * A. V2 archetype-only（VERY_TIGHT，无统计）
 * B. V3 老郑（VERY_TIGHT + 1180 手连续统计）
 * C. 反证：把同一牌面换成「跟注站」（测试牌局 04 的老林）作为下界
 *
 * ⚠️ 行为记录文本（「转牌开始明显过度弃牌」等）引擎不支持文本输入，
 *    **不注入**，只在报告里作为人工审查依据。
 */

import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';
import { parseManualInput } from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import { resolvePlayerProfile, type PlayerObservedStats } from '../src/domain/player/observedStats.ts';
import type { ManualHandInput } from '../src/app/manualInput/manualInput.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const SEED = 20_260_913;

const A = (p: string, t: string, a?: number, s?: string) => ({
  position: p, type: t,
  ...(a === undefined ? {} : { amountBB: a }),
  ...(s === undefined ? {} : { street: s }),
});

const HISTORY = [
  A('UTG', 'FOLD'), A('HJ', 'FOLD'), A('CO', 'FOLD'),
  A('BTN', 'RAISE', 3), A('SB', 'FOLD'), A('BB', 'CALL', 2),
  A('BB', 'CHECK', undefined, 'FLOP'), A('BTN', 'BET', 2.5, 'FLOP'), A('BB', 'CALL', 2.5, 'FLOP'),
  A('BB', 'CHECK', undefined, 'TURN'), A('BTN', 'CHECK', undefined, 'TURN'),
  A('BB', 'CHECK', undefined, 'RIVER'),
];
/* 与测试牌局 04 相同的牌面 */
const BOARD = ['Kc', '8d', '4c', '2s', 'Qd'];
const SEATS: Record<string, number> = { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 };

/** 老郑：NIT / 紧弱（全部 0..1） */
const LAOZHENG: PlayerObservedStats = {
  handsObserved: 1180,
  vpip: 0.17, pfr: 0.11, threeBet: 0.04,
  wtsd: 0.21,
  foldToFlopCBet: 0.47, foldToTurnCBet: 0.55, foldToRiverBet: 0.63,
  flopCheckRaise: 0.04, turnCheckRaise: 0.03, riverCheckRaise: 0.01,
};

/** 测试牌局 04 的老林：跟注站（作为反证下界） */
const LAOLIN: PlayerObservedStats = {
  handsObserved: 860,
  vpip: 0.49, pfr: 0.09, threeBet: 0.03, wtsd: 0.40,
  foldToFlopCBet: 0.21, foldToTurnCBet: 0.24, foldToRiverBet: 0.16,
  flopCheckRaise: 0.05, turnCheckRaise: 0.03, riverCheckRaise: 0.02,
};

type M = Record<string, any>;

function run(label: string, quickProfile: string, observedStats: PlayerObservedStats | null, hero: [string, string]): M {
  const input = {
    tableSize: 6, heroPosition: 'BTN', heroCards: hero,
    board: BOARD, street: 'RIVER',
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

  const pickProb = (f: string): Record<string, number> =>
    Object.fromEntries([...probByKind].map(([k, v]) => [k, Number(v[f])]));
  const pickScore = (f: string): Record<string, number> =>
    Object.fromEntries([...scoreByKind].map(([k, v]) => [k, Number(v[f])]));

  return {
    label,
    action: String(d['action']),
    bestSize: bdDiag?.['bestSize'] ?? null,
    confidence: d['confidence'],
    classification: String(d['classification']),
    fold: pickProb('foldLikelihood'),
    call: pickProb('callLikelihood'),
    raise: pickProb('raiseLikelihood'),
    score: pickScore('score'),
    betEV: pickScore('betEV'),
    amounts: Object.fromEntries(
      [...scoreByKind].map(([k, v]) => [k, { chips: Number(v['betAmount']), ratio: Number(v['ratioToPot']) }]),
    ),
    profileV3: ctx['profileV3'] ?? null,
    math: ctx['math'] as M,
    reasons: (d['reasons'] ?? []) as readonly M[],
  };
}

/* A/B/C 三组 */
const A2 = run('A. V2（VERY_TIGHT 无统计）', 'VERY_TIGHT', null, ['Ac', '5c']);
const B3 = run('B. V3 老郑 1180 手', 'VERY_TIGHT', LAOZHENG, ['Ac', '5c']);
const C4 = run('C. 反证：跟注站老林', 'CALLING_STATION', LAOLIN, ['Ac', '5c']);

const f = (x: unknown, d = 2): string => (typeof x === 'number' && Number.isFinite(x) ? x.toFixed(d) : '—');
const pct = (x: unknown, d = 2): string => (typeof x === 'number' && Number.isFinite(x) ? `${(x * 100).toFixed(d)}%` : '—');
const line = (s = ''): void => console.log(s);

line('='.repeat(84));
line(' 测试牌局 06 —— BTN A♣5♣ ｜ K♣8♦4♣2♠Q♦ ｜ **转牌过牌让牌** ｜ 河牌 BB 过牌');
line('='.repeat(84));
line('');
line(`  底池 ${f(B3.math['pot'])} ｜ 有效筹码 ${f(B3.math['effectiveStack'])} ｜ SPR ${f(B3.math['spr'])}`);
line(`  我的牌力 = ${String(B3.math['handRankZh'])}（类别 ${String(B3.math['handCategory'])}）`);
line(`  权益来源 = ${JSON.stringify(B3.math['equitySource'])}`);
line('');

line('  ── 三组对照 ──');
line('');
line('  指标'.padEnd(24) + 'A. V2 紧弱'.padEnd(20) + 'B. V3 老郑'.padEnd(20) + 'C. 跟注站老林');
line('  ' + '-'.repeat(80));
const row = (n: string, a: unknown, b: unknown, c: unknown): void =>
  line('  ' + n.padEnd(22) + String(a).padEnd(20) + String(b).padEnd(20) + String(c));
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
  row(`${k} BetEV`, f(A2.betEV[k]), f(B3.betEV[k]), f(C4.betEV[k]));
}
line('');
for (const k of ['BET_SMALL', 'BET_MEDIUM', 'BET_LARGE']) {
  row(`${k} 策略评分`, f(A2.score[k], 4), f(B3.score[k], 4), f(C4.score[k], 4));
}
line('');
line('  ── V3 分街系数（老郑） ──');
line(`    river: ${JSON.stringify(B3.profileV3?.street?.RIVER)}`);
line(`    turn : ${JSON.stringify(B3.profileV3?.street?.TURN)}`);
line(`    flop : ${JSON.stringify(B3.profileV3?.street?.FLOP)}`);
line(`    resolved 维度 = ${JSON.stringify(B3.profileV3?.dimensions)}`);
line(`    实测项数 = ${B3.profileV3?.observedStatCount} ｜ 可信度档 = ${B3.profileV3?.confidenceTierZh}`);
line('');
line('  ── 逐统计 trace ──');
for (const t of (B3.profileV3?.trace ?? []) as readonly M[]) {
  const obs = t['observedRate'];
  line(
    `    ${String(t['stat']).padEnd(18)} 实测 ${obs === null ? '—' : Number(obs).toFixed(3)}` +
      `  先验 ${Number(t['priorRate']).toFixed(3)}  可信度 ${Number(t['confidence']).toFixed(4)}` +
      `  生效 ${Number(t['effectiveRate']).toFixed(4)}` +
      (t['streetTrait'] === null ? '' : `  → ${String(t['streetTrait'])}`),
  );
}
line('');
line('  ── 引擎理由（B：V3 老郑） ──');
for (const reason of B3.reasons.slice(0, 6)) {
  line(`    [${String(reason['code'])}] ${String(reason['textZh']).slice(0, 210)}`);
}
line('');
line('  运行前写定的预期：');
line('    老郑 FoldRiver 63%（远高于人群中心）⇒ riverFoldScale 应 > 1（更容易被赶走）；');
line('    我又持有**零摊牌价值**的未完成同花 ⇒ 纯诈唬的弃牌收益是唯一收益来源；');
line('    ⇒ 预期引擎应比「跟注站」那一侧明显更倾向下注，且大注的弃牌率更高。');
