/**
 * 测试牌局 04 —— BTN A♠Q♦，河牌第三次过牌后 Hero 决策
 *
 * 6-max 现金桌，盲注 1/2，有效筹码 200（100BB）
 *
 * 老林（BB）＝明显跟注站，860 手：
 *   VPIP 49% / PFR 9% / 3Bet 3%
 *   WTSD 40% / W$SD 44%（W$SD **无 V3 字段**，记录为未使用）
 *   FoldFlopCBet 21% / FoldTurnCBet 24% / FoldRiverBet 16%
 *   Flop/Turn/River CheckRaise 5% / 3% / 2%
 *
 * 翻前：UTG/HJ/CO 弃 → BTN 开 6 → SB 弃 → BB 跟 ⇒ 底池 13
 * 翻牌 Q♣9♠4♥：BB 过 / BTN 下 5 / BB 跟 ⇒ 底池 23
 * 转牌 6♣：BB 过 / BTN 下 15 / BB 跟 ⇒ 底池 53
 * 河牌 T♦：BB 第三次过 ⇒ **Hero 决策**（双方各剩 174，SPR 3.28）
 *
 * 单位：筹码（1BB = 2 筹码）。
 *
 * ## 对照设计
 * A. V2 archetype-only（CALLING_STATION，无统计）
 * B. V3（CALLING_STATION + 老林 860 手连续统计）
 * ⇒ 差异必须**只**来自 observedStats。
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

/* 筹码单位：$1/$2 ⇒ 1BB = 2 筹码。底池 13/23/53 筹码 = 6.5/11.5/26.5BB */
const HISTORY = [
  A('UTG', 'FOLD'), A('HJ', 'FOLD'), A('CO', 'FOLD'),
  A('BTN', 'RAISE', 3),          // 6 筹码 = 3BB
  A('SB', 'FOLD'),
  A('BB', 'CALL', 2),            // 跟到 6：已投 1BB，再补 2BB
  A('BB', 'CHECK', undefined, 'FLOP'),
  A('BTN', 'BET', 2.5, 'FLOP'),  // 5 筹码
  A('BB', 'CALL', 2.5, 'FLOP'),
  A('BB', 'CHECK', undefined, 'TURN'),
  A('BTN', 'BET', 7.5, 'TURN'),  // 15 筹码
  A('BB', 'CALL', 7.5, 'TURN'),
  A('BB', 'CHECK', undefined, 'RIVER'),
];

const SEATS: Record<string, number> = { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 };

/** 老林的连续统计（全部 0..1 口径） */
const LAOLIN: PlayerObservedStats = {
  handsObserved: 860,
  vpip: 0.49,
  pfr: 0.09,
  threeBet: 0.03,
  wtsd: 0.40,
  foldToFlopCBet: 0.21,
  foldToTurnCBet: 0.24,
  foldToRiverBet: 0.16,
  flopCheckRaise: 0.05,
  turnCheckRaise: 0.03,
  riverCheckRaise: 0.02,
};

type M = Record<string, any>;

function run(label: string, observedStats: PlayerObservedStats | null): M {
  const input = {
    tableSize: 6, heroPosition: 'BTN', heroCards: ['As', 'Qd'],
    board: ['Qc', '9s', '4h', '6c', 'Td'], street: 'RIVER',
    effectiveStackBB: 100, bigBlindBB: 2,
    seatStacksBB: { ...SEATS },
    actionHistory: HISTORY.map((a) => ({ ...a })),
    environment: 'MID_LOW_STAKES',
    villain: {
      quickProfile: 'CALLING_STATION', dynamicHint: 'UNKNOWN', stackBB: 100,
      ...(observedStats === null ? {} : { observedStats }),
    },
  } as unknown as ManualHandInput;

  const parsed = parseManualInput(input);
  if (!parsed.ok) throw new Error(`PARSE ${JSON.stringify(parsed.issues.slice(0, 3))}`);
  const gate = buildAnalyzableState(parsed.value);
  if (!gate.ok) throw new Error(`STATE ${JSON.stringify(gate.issues.slice(0, 3))}`);

  const built = buildDecisionContext({
    state: gate.state, rules: RULES, environment: 'MID_LOW_STAKES',
    asOf: 1_757_000_000_000, quickProfile: 'CALLING_STATION' as never,
    ...(observedStats === null ? {} : { observedStats }),
  });
  const ctx = built.context as unknown as Record<string, any>;

  const r = analyzeManualHand(input, {
    rules: RULES, asOf: 1_757_000_000_000, writeLog: false,
    equitySeed: SEED, budget: { softMs: 120_000, hardMs: 240_000 },
  });
  if (!r.ok) throw new Error(`ANALYZE ${JSON.stringify(r.issues.slice(0, 3))}`);
  const d = r.decision as unknown as Record<string, any>;
  const bd = ((ctx['postflopFacts'] as M | undefined)?.['betDecision'] ??
    (d['diagnostics'] as M)['postflop']?.['betDecision']) as M | null;

  /*
   * ⚠️ **两个 `betDecision` 对象携带的字段不同**（本轮实测）：
   *
   * | 来源 | 有 | 没有 |
   * |---|---|---|
   * | `context.postflopFacts.betDecision` | `sizes[].fold/call/raiseLikelihood`、`checkTree`、`tendencies` | `score`、`betEV`、`checkScore`、`bestScore`、`bestSize` |
   * | `diagnostics.postflop.betDecision`  | `sizes[].score/betEV`、`checkScore`、`bestScore`、`bestSize` | `sizes[].kind` 之外的键名不同（用 `size`） |
   *
   * 第一版只取其一 ⇒ 评分列全空。现在**分别取**，键用 `kind`/`size` 双兼容。
   */
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
    confidence: d['confidence'],
    classification: String(d['classification']),
    basis: String((d['diagnostics'] as M)['decisionBasis']?.['kind']),
    fold: pickProb('foldLikelihood'),
    call: pickProb('callLikelihood'),
    raise: pickProb('raiseLikelihood'),
    score: pickScore('score'),
    betEV: pickScore('betEV'),
    checkScore: bdDiag?.['checkScore'] ?? null,
    bestScore: bdDiag?.['bestScore'] ?? null,
    bestSize: bdDiag?.['bestSize'] ?? null,
    tendencies: bdFacts?.['tendencies'] ?? null,
    profileV3: ctx['profileV3'] ?? null,
    math: ctx['math'] as M,
    reasons: (d['reasons'] ?? []) as readonly M[],
  };
}

const v2 = run('V2 archetype-only', null);
const v3 = run('V3 老林 860 手', LAOLIN);

const f = (x: unknown, d = 2): string => (typeof x === 'number' && Number.isFinite(x) ? x.toFixed(d) : '—');
const pct = (x: unknown, d = 2): string => (typeof x === 'number' && Number.isFinite(x) ? `${(x * 100).toFixed(d)}%` : '—');
const line = (s = ''): void => console.log(s);

line('='.repeat(78));
line(' 测试牌局 04 —— BTN A♠Q♦ ｜ Q♣9♠4♥6♣T♦ ｜ 河牌 BB 第三次过牌');
line('='.repeat(78));
line('');
line(`  引擎重算底池 = ${f(v3.math['pot'])} 筹码 ｜ 有效筹码 = ${f(v3.math['effectiveStack'])} ｜ SPR = ${f(v3.math['spr'])}`);
line(`  我的牌力     = ${String(v3.math['handRankZh'])}`);
line(`  权益来源     = ${JSON.stringify(v3.math['equitySource'])}`);
line('');
line('  ── V2 vs V3 对照 ──');
line('');
line('  指标'.padEnd(26) + 'V2 (无统计)'.padEnd(22) + 'V3 (860 手)');
line('  ' + '-'.repeat(66));
const row = (n: string, a: unknown, b: unknown): void => line('  ' + n.padEnd(24) + String(a).padEnd(22) + String(b));
row('最终动作', v2.action, v3.action);
row('建议尺寸', String(v3.bestSize ?? '—'), String(v3.bestSize ?? '—'));
row('置信度', f(v2.confidence, 3), f(v3.confidence, 3));
row('分类', v2.classification, v3.classification);
line('');
for (const k of ['BET_SMALL', 'BET_MEDIUM', 'BET_LARGE']) {
  row(`${k} Fold%`, pct(v2.fold[k]), pct(v3.fold[k]));
}
line('');
for (const k of ['BET_SMALL', 'BET_MEDIUM', 'BET_LARGE']) {
  row(`${k} Call%`, pct(v2.call[k]), pct(v3.call[k]));
}
line('');
for (const k of ['BET_SMALL', 'BET_MEDIUM', 'BET_LARGE']) {
  row(`${k} 策略评分`, f(v2.score[k], 4), f(v3.score[k], 4));
}
line('');
row('CHECK 策略评分', f(v2.checkScore, 3), f(v3.checkScore, 3));
line('');
line('  ── V3 分街系数（老林） ──');
line(`    river: ${JSON.stringify(v3.profileV3?.street?.RIVER)}`);
line(`    flop : ${JSON.stringify(v3.profileV3?.street?.FLOP)}`);
line(`    turn : ${JSON.stringify(v3.profileV3?.street?.TURN)}`);
line(`    resolved 维度 = ${JSON.stringify(v3.profileV3?.dimensions)}`);
line(`    实测统计项数  = ${v3.profileV3?.observedStatCount} ｜ 可信度档 = ${v3.profileV3?.confidenceTierZh}`);
line('');
line('  ── 逐统计 trace（生效值 = 先验 + (实测−先验) × 可信度） ──');
for (const t of (v3.profileV3?.trace ?? []) as readonly M[]) {
  const obs = t['observedRate'];
  line(
    `    ${String(t['stat']).padEnd(18)} 实测 ${obs === null ? '—' : Number(obs).toFixed(3)}` +
      `  先验 ${Number(t['priorRate']).toFixed(3)}  可信度 ${Number(t['confidence']).toFixed(4)}` +
      `  生效 ${Number(t['effectiveRate']).toFixed(4)}` +
      (t['streetTrait'] === null ? '' : `  → ${String(t['streetTrait'])}`),
  );
}
line('');
line('  ── 引擎给出的理由（V3） ──');
for (const reason of v3.reasons.slice(0, 8)) {
  line(`    [${String(reason['code'])}] ${String(reason['textZh']).slice(0, 200)}`);
}
line('');
line('  运行前写定的预期：');
line('    老林 FoldRiver 16%（远低于人群中心）⇒ riverFoldScale 应 < 1；');
line('    WTSD 40% 高、VPIP 49% 松 ⇒ 下注类动作的弃牌收益被削弱；');
line('    但他「突然大加注通常很强」+ 河牌薄价值差 ⇒ 预期引擎不建议大注。');
