/**
 * 测试牌局 10 —— CO A♥5♥，**转牌决策点**（BB 老许过牌，轮到我）
 *
 * 6-max 现金桌，盲注 1/2，有效筹码 200（100BB）
 *
 * 我的手牌：A♥5♥ = A 高 + **坚果同花听牌** + 轮子顺子潜力（未完成）
 * 对手：BB「老许」NIT/紧弱，1350 手
 *   VPIP 18% / PFR 12% / 3Bet 4% / WTSD 20%
 *   FoldFlopCBet 43% / FoldTurnCBet 61% / FoldRiverBet 58%
 *   CheckRaise: flop 5% / turn 3% / river 2%
 *
 * 翻前：UTG/HJ 弃 → CO 开 6（3BB）→ BTN/SB 弃 → BB 跟 ⇒ 13
 * 翻牌 K♥7♣3♥：BB 过 / CO 下 5（2.5BB）/ BB 跟 ⇒ 23
 * 转牌 4♠：BB 过 ⇒ **Hero 决策（本脚本的决策点）**
 *
 * 筹码：Hero 已投 6+5 = 11 ⇒ 剩 189；Villain 同 ⇒ 剩 189；SPR = 189/23 = 8.22
 *
 * ## 四组对照
 * A. NIT 老许 + 1350 手 observedStats（本局的正确建模）
 * B. NIT，无 observedStats（只靠标签先验）
 * C. NORMAL（中性标签）
 * D. 反证：CALLING_STATION + 高 WTSD / 低 FoldTurn
 */

import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';
import { parseManualInput } from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import type { PlayerObservedStats } from '../src/domain/player/observedStats.ts';
import type { ManualHandInput } from '../src/app/manualInput/manualInput.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const SEED = 20_261_010;

const A = (p: string, t: string, a?: number, s?: string) => ({
  position: p, type: t,
  ...(a === undefined ? {} : { amountBB: a }),
  ...(s === undefined ? {} : { street: s }),
});

/** 只到转牌决策点为止 */
const HISTORY = [
  A('UTG', 'FOLD'), A('HJ', 'FOLD'),
  A('CO', 'RAISE', 3), A('BTN', 'FOLD'), A('SB', 'FOLD'), A('BB', 'CALL', 2),
  A('BB', 'CHECK', undefined, 'FLOP'), A('CO', 'BET', 2.5, 'FLOP'), A('BB', 'CALL', 2.5, 'FLOP'),
  A('BB', 'CHECK', undefined, 'TURN'),
];
const BOARD = ['Kh', '7c', '3h', '4s'];
const SEATS: Record<string, number> = { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 };

const LAOXU: PlayerObservedStats = {
  handsObserved: 1350,
  vpip: 0.18, pfr: 0.12, threeBet: 0.04, wtsd: 0.20,
  foldToFlopCBet: 0.43, foldToTurnCBet: 0.61, foldToRiverBet: 0.58,
  flopCheckRaise: 0.05, turnCheckRaise: 0.03, riverCheckRaise: 0.02,
};
const STATION: PlayerObservedStats = {
  handsObserved: 1350,
  vpip: 0.51, pfr: 0.09, threeBet: null, wtsd: 0.41,
  foldToFlopCBet: 0.22, foldToTurnCBet: 0.19, foldToRiverBet: 0.17,
  flopCheckRaise: null, turnCheckRaise: 0.04, riverCheckRaise: null,
};

type M = Record<string, any>;

function run(label: string, quickProfile: string, observedStats: PlayerObservedStats | null): M {
  const input = {
    tableSize: 6, heroPosition: 'CO', heroCards: ['Ah', '5h'],
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
    sizeBB: d['sizeBB'] === undefined ? null : Number(d['sizeBB']),
    bestSize: bdDiag?.['bestSize'] ?? null,
    confidence: d['confidence'],
    band: String(d['band'] ?? ''),
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

const A1 = run('A. NIT 老许 + 1350 手', 'VERY_TIGHT', LAOXU);
const B1 = run('B. NIT 无统计', 'VERY_TIGHT', null);
const C1 = run('C. NORMAL', 'NORMAL', null);
const D1 = run('D. 跟注站反证', 'CALLING_STATION', STATION);

const f = (x: unknown, d = 2): string => (typeof x === 'number' && Number.isFinite(x) ? x.toFixed(d) : '—');
const pct = (x: unknown, d = 2): string => (typeof x === 'number' && Number.isFinite(x) ? `${(x * 100).toFixed(d)}%` : '—');
const line = (s = ''): void => console.log(s);

line('='.repeat(96));
line(' 测试牌局 10 —— CO A♥5♥ ｜ K♥7♣3♥4♠ ｜ **转牌 BB 过牌，轮到我**');
line('='.repeat(96));
line('');
line(`  底池 ${f(A1.math['pot'])}（${f(Number(A1.math['pot']) / 2, 1)}BB）｜ 有效筹码 ${f(A1.math['effectiveStack'])} ｜ SPR ${f(A1.math['spr'])}`);
line(`  我的牌力 = ${String(A1.math['handRankZh'])}（类别 ${String(A1.math['handCategory'])}）`);
line(`  权益 = ${pct(A1.math['heroEquity'], 3)} ｜ 来源 = ${JSON.stringify(A1.math['equitySource'])}`);
line(`  合法动作与尺寸 = ${JSON.stringify(A1.math['legalSizes'] ?? '—')}`);
line('');

line('  ── 四组对照 ──');
line('');
line('  指标'.padEnd(22) + 'A. NIT+1350手'.padEnd(22) + 'B. NIT 无统计'.padEnd(22) + 'C. NORMAL'.padEnd(18) + 'D. 跟注站');
line('  ' + '-'.repeat(92));
const row = (n: string, a: unknown, b: unknown, c: unknown, dd: unknown): void =>
  line('  ' + n.padEnd(20) + String(a).padEnd(22) + String(b).padEnd(22) + String(c).padEnd(18) + String(dd));
row('最终动作', A1.action, B1.action, C1.action, D1.action);
row('建议尺寸', String(A1.bestSize ?? '—'), String(B1.bestSize ?? '—'), String(C1.bestSize ?? '—'), String(D1.bestSize ?? '—'));
row('置信度', f(A1.confidence, 3), f(B1.confidence, 3), f(C1.confidence, 3), f(D1.confidence, 3));
row('分类', A1.classification, B1.classification, C1.classification, D1.classification);
row('决策依据', A1.basis, B1.basis, C1.basis, D1.basis);
line('');
for (const k of ['BET_SMALL', 'BET_MEDIUM', 'BET_LARGE']) {
  row(`${k} Fold%`, pct(A1.fold[k]), pct(B1.fold[k]), pct(C1.fold[k]), pct(D1.fold[k]));
}
line('');
for (const k of ['BET_SMALL', 'BET_MEDIUM', 'BET_LARGE']) {
  row(`${k} Call%`, pct(A1.call[k]), pct(B1.call[k]), pct(C1.call[k]), pct(D1.call[k]));
}
line('');
for (const k of ['BET_SMALL', 'BET_MEDIUM', 'BET_LARGE']) {
  row(`${k} BetEV`, f(A1.betEV[k]), f(B1.betEV[k]), f(C1.betEV[k]), f(D1.betEV[k]));
}
line('');
for (const k of ['BET_SMALL', 'BET_MEDIUM', 'BET_LARGE']) {
  row(`${k} ΔvsCheck`, f(A1.deltaVsCheck[k]), f(B1.deltaVsCheck[k]), f(C1.deltaVsCheck[k]), f(D1.deltaVsCheck[k]));
}
line('');
for (const k of ['BET_SMALL', 'BET_MEDIUM', 'BET_LARGE']) {
  row(`${k} 被跟权益`, pct(A1.eqVsCall[k]), pct(B1.eqVsCall[k]), pct(C1.eqVsCall[k]), pct(D1.eqVsCall[k]));
}
line('');
row('CHECK 树 EV', f(A1.checkEV, 3), f(B1.checkEV, 3), f(C1.checkEV, 3), f(D1.checkEV, 3));
row('他过牌概率', pct(A1.checkBackLikelihood, 1), pct(B1.checkBackLikelihood, 1), pct(C1.checkBackLikelihood, 1), pct(D1.checkBackLikelihood, 1));
row('他下注概率', pct(A1.betLikelihood, 1), pct(B1.betLikelihood, 1), pct(C1.betLikelihood, 1), pct(D1.betLikelihood, 1));
line('');

line('  ── V3 分街系数（A：老许 1350 手，本节点是 TURN） ──');
line(`    turn : ${JSON.stringify(A1.profileV3?.street?.TURN)}  ← 本街生效`);
line(`    flop : ${JSON.stringify(A1.profileV3?.street?.FLOP)}`);
line(`    river: ${JSON.stringify(A1.profileV3?.street?.RIVER)}`);
line(`    resolved 维度 = ${JSON.stringify(A1.profileV3?.dimensions)}`);
line(`    实测项数 = ${A1.profileV3?.observedStatCount} ｜ 可信度档 = ${A1.profileV3?.confidenceTierZh}`);
line(`    节点语义 = ${JSON.stringify(A1.profileV3?.actionContext)}`);
line(`    被节点门挡下的分街条目 = ${JSON.stringify(A1.profileV3?.deniedStreetTraits)}`);
line('');
line('  ── V3 分街系数（D：跟注站实测，本节点是 TURN） ──');
line(`    turn : ${JSON.stringify(D1.profileV3?.street?.TURN)}  ← 本街生效`);
line(`    resolved 维度 = ${JSON.stringify(D1.profileV3?.dimensions)}`);
line(`    实测项数 = ${D1.profileV3?.observedStatCount} ｜ 可信度档 = ${D1.profileV3?.confidenceTierZh}`);
line(`    节点语义 = ${JSON.stringify(D1.profileV3?.actionContext)}`);
line(`    被节点门挡下的分街条目 = ${JSON.stringify(D1.profileV3?.deniedStreetTraits)}`);
line('');

line('  ── 紧凑结果表（指定字段：A vs D） ──');
line('');
const compact = (n: string, a: unknown, dd: unknown): void =>
  line('  ' + n.padEnd(24) + String(a).padEnd(28) + String(dd));
compact('Final Action', A1.action, D1.action);
compact('Recommended Size', A1.sizeBB === null ? '—' : A1.sizeBB, D1.sizeBB === null ? '—' : D1.sizeBB);
compact('Confidence', f(A1.confidence, 3), f(D1.confidence, 3));
compact('Classification', A1.classification, D1.classification);
line('');
compact('Hero Equity', pct(A1.math['heroEquity'], 3), pct(D1.math['heroEquity'], 3));
compact('EqVsCall (S)', pct(A1.eqVsCall['BET_SMALL'], 2), pct(D1.eqVsCall['BET_SMALL'], 2));
compact('EqVsCall (M)', pct(A1.eqVsCall['BET_MEDIUM'], 2), pct(D1.eqVsCall['BET_MEDIUM'], 2));
compact('EqVsCall (L)', pct(A1.eqVsCall['BET_LARGE'], 2), pct(D1.eqVsCall['BET_LARGE'], 2));
line('');
compact('CHECK EV', f(A1.checkEV, 3), f(D1.checkEV, 3));
compact('BET_SMALL EV', f(A1.betEV['BET_SMALL'], 2), f(D1.betEV['BET_SMALL'], 2));
compact('BET_MEDIUM EV', f(A1.betEV['BET_MEDIUM'], 2), f(D1.betEV['BET_MEDIUM'], 2));
compact('BET_LARGE EV', f(A1.betEV['BET_LARGE'], 2), f(D1.betEV['BET_LARGE'], 2));
line('');
compact('Small Fold/Call/Raise', `${pct(A1.fold['BET_SMALL'], 1)} / ${pct(A1.call['BET_SMALL'], 1)} / ${pct(A1.raise['BET_SMALL'], 1)}`, `${pct(D1.fold['BET_SMALL'], 1)} / ${pct(D1.call['BET_SMALL'], 1)} / ${pct(D1.raise['BET_SMALL'], 1)}`);
compact('Medium Fold/Call/Raise', `${pct(A1.fold['BET_MEDIUM'], 1)} / ${pct(A1.call['BET_MEDIUM'], 1)} / ${pct(A1.raise['BET_MEDIUM'], 1)}`, `${pct(D1.fold['BET_MEDIUM'], 1)} / ${pct(D1.call['BET_MEDIUM'], 1)} / ${pct(D1.raise['BET_MEDIUM'], 1)}`);
compact('Large Fold/Call/Raise', `${pct(A1.fold['BET_LARGE'], 1)} / ${pct(A1.call['BET_LARGE'], 1)} / ${pct(A1.raise['BET_LARGE'], 1)}`, `${pct(D1.fold['BET_LARGE'], 1)} / ${pct(D1.call['BET_LARGE'], 1)} / ${pct(D1.raise['BET_LARGE'], 1)}`);
line('');

line('  ── 引擎理由（A：NIT 老许 + 1350 手） ──');
for (const reason of A1.reasons.slice(0, 8)) {
  line(`    [${String(reason['code'])}] ${String(reason['textZh']).slice(0, 250)}`);
}
line('');
line('  运行前写定的预期：');
line('    我持**坚果同花听牌**（8 张♥ 出牌）+ 轮子顺子潜力 + A 高；老许 FoldTurnCBet 61% ⇒ turnFoldScale 应 > 1；');
line('    Hero 是翻前进攻者且翻牌下注者 ⇒ 转牌再下注是真正的 Turn CBet ⇒ foldToTurnCBet 应合法进入模型（deniedStreetTraits 为空）；');
line('    半诈唬有两条收益：他弃牌（高弃牌率）+ 我中同花；他 check-raise 只有 3%；');
line('    预期引擎倾向下注，尺寸取决于「下注 EV vs 过牌树 EV」的比较。');
