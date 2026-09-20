/**
 * flriver-gent2-sweep · READ-ONLY anomaly sweep (Agent 3)
 *
 * Enumerates FLOP / TURN / RIVER decision nodes and tests, per node:
 *   (i)   action = FOLD  while CALL EV > 0  (any of math.callEV / actionEvidence / candidates)
 *   (ii)  action = BET/ALL_IN while CHECK EV >= every evaluated BET EV (or bestScore <= checkScore)
 *   (ii-) action = CHECK while bestScore > checkScore
 *   (iii) action = RAISE/ALL_IN whose RAISE evidence has ev = null / HEURISTIC, while the node's
 *         reason text claims the raise is EV-best
 *   (iii-b) chosen RAISE size listed in unevaluatedActions (RAISE_EV_NOT_IMPLEMENTED self-contradiction)
 *   (iii-c) decisionSource.estimateType = MODEL_EV on a RAISE while raiseContinueRange = NOT_IMPLEMENTED
 *   (v)   diagnostics.consistency.violations non-empty
 *
 * Prints a compact one-line-per-node table plus FULL details for every hit.
 * Writes nothing; read-only.
 */
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import type { ManualHandInput, ManualVillain } from '../src/app/manualInput/manualInput.ts';

const OPTIONS = {
  rules: loadKnowledgeBaseOrThrow().allRules(),
  asOf: 1_757_000_000_000,
  writeLog: false,
  equitySeed: 20_260_913,
  budget: { softMs: 120_000, hardMs: 240_000 },
} as const;

const A_ = (p: string, t: string, bb?: number, s?: string): Record<string, unknown> => ({
  position: p, type: t, ...(bb === undefined ? {} : { amountBB: bb }), ...(s === undefined ? {} : { street: s }),
});
const base = {
  tableSize: 6, effectiveStackBB: 100, bigBlindBB: 2,
  seatStacksBB: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 },
  environment: 'MID_LOW_STAKES',
} as const;
const V_ = (q: string): ManualVillain => ({ quickProfile: q, dynamicHint: 'UNKNOWN', stackBB: 100 } as ManualVillain);
const num = (x: unknown, d = 3): string => (typeof x === 'number' && Number.isFinite(x) ? x.toFixed(d) : String(x));
const J = (x: unknown): string => JSON.stringify(x, null, 1);

const PRE_BTN = [A_('UTG', 'FOLD'), A_('HJ', 'FOLD'), A_('CO', 'FOLD'), A_('BTN', 'RAISE', 3), A_('SB', 'FOLD'), A_('BB', 'CALL', 2)];
const PRE_BB = [A_('UTG', 'FOLD'), A_('HJ', 'FOLD'), A_('CO', 'FOLD'), A_('BTN', 'RAISE', 3), A_('SB', 'FOLD'), A_('BB', 'CALL', 2)];

type Cfg = {
  tag: string;
  street: 'FLOP' | 'TURN' | 'RIVER';
  /** 'IP' = hero BTN acted last (villain checks to hero) ; 'OOP' = hero BB acts first ; 'FACE' = hero faces a bet */
  mode: 'IP' | 'OOP' | 'FACE';
  heroCards: readonly [string, string];
  board: readonly string[];
  betBB: number;
  profile: string;
};

const BOARDS: Record<string, readonly string[]> = {
  flopK94: ['Kd', '9c', '4h'],
  flopTs8s2h: ['Ts', '8s', '2h'],
  flopQcJd5d: ['Qc', 'Jd', '5d'],
  flopAh7h3c: ['Ah', '7h', '3c'],
  turnK94_6s: ['Kd', '9c', '4h', '6s'],
  turnTs8s2h_Jc: ['Ts', '8s', '2h', 'Jc'],
  riverK94_6s2d: ['Kd', '9c', '4h', '6s', '2d'],
  riverTs8s2h_Jc3d: ['Ts', '8s', '2h', 'Jc', '3d'],
  riverQcJd5d_9h2s: ['Qc', 'Jd', '5d', '9h', '2s'],
};

const HANDS: ReadonlyArray<readonly [string, readonly [string, string]]> = [
  ['AKs', ['As', 'Ks']],
  ['AA', ['As', 'Ah']],
  ['99', ['9h', '9c']],
  ['76s', ['7s', '6s']],
  ['QJs', ['Qs', 'Js']],
];

/** build the action history that lands hero on `street` with hero to act */
function historyFor(cfg: Cfg): Record<string, unknown>[] {
  const h: Record<string, unknown>[] = [...PRE_BTN];
  const preflopTable = cfg.mode === 'OOP' ? PRE_BB : PRE_BTN;
  h.length = 0;
  h.push(...preflopTable);
  // FLOP
  if (cfg.street === 'FLOP') {
    if (cfg.mode === 'FACE') h.push(A_('BB', 'BET', cfg.betBB, 'FLOP'));
    else if (cfg.mode === 'IP') h.push(A_('BB', 'CHECK', undefined, 'FLOP'));
    return h;
  }
  // finish FLOP without a bet if mode is OOP (hero checks first, villain checks back), else standard
  h.push(A_('BB', 'CHECK', undefined, 'FLOP'));
  if (cfg.mode !== 'OOP') { h.push(A_('BTN', 'BET', 4, 'FLOP'), A_('BB', 'CALL', 4, 'FLOP')); }
  if (cfg.street === 'TURN') {
    if (cfg.mode === 'OOP') return h; // hero BB to act first on turn
    if (cfg.mode === 'FACE') { h.push(A_('BB', 'CHECK', undefined, 'TURN'), A_('BTN', 'BET', cfg.betBB, 'TURN')); return h; }
    h.push(A_('BB', 'CHECK', undefined, 'TURN'));
    return h;
  }
  // RIVER
  if (cfg.mode === 'OOP') {
    h.push(A_('BB', 'CHECK', undefined, 'TURN'), A_('BTN', 'CHECK', undefined, 'TURN'));
    return h; // hero BB to act first on river
  }
  h.push(A_('BB', 'CHECK', undefined, 'TURN'), A_('BTN', 'BET', 10, 'TURN'), A_('BB', 'CALL', 10, 'TURN'));
  if (cfg.mode === 'FACE') h.push(A_('BB', 'BET', cfg.betBB, 'RIVER'));
  else h.push(A_('BB', 'CHECK', undefined, 'RIVER'));
  return h;
}

const cfgs: Cfg[] = [];
for (const street of ['FLOP', 'RIVER'] as const) {
  for (const mode of ['IP', 'OOP', 'FACE'] as const) {
    for (const [hn, hc] of HANDS) {
      for (const [bn, bd] of Object.entries(BOARDS)) {
        if (street === 'FLOP' && !bn.startsWith('flop')) continue;
        if (street === 'RIVER' && !bn.startsWith('river')) continue;
        if (street === 'FLOP' && bn === 'flopAh7h3c') continue;
        if (street === 'RIVER' && bn === 'riverQcJd5d_9h2s') continue;
        for (const profile of mode === 'FACE' ? ['NORMAL', 'MANIAC'] : ['NORMAL']) {
          for (const betBB of mode === 'FACE' ? [5, 10, 44] : [0]) {
            cfgs.push({
              tag: `${street}-${mode}-${hn}-${bn}-${profile}-b${betBB}`,
              street, mode, heroCards: hc, board: bd, betBB, profile,
            });
          }
        }
      }
    }
  }
}

type Hit = { tag: string; code: string; detail: string };
const hits: Hit[] = [];
const rows: string[] = [];
let ran = 0;
let failed = 0;
const t0 = Date.now();

for (const cfg of cfgs) {
  const input = {
    ...base,
    heroPosition: cfg.mode === 'OOP' ? 'BB' : 'BTN',
    heroCards: [...cfg.heroCards],
    board: [...cfg.board],
    street: cfg.street,
    actionHistory: historyFor(cfg),
    villain: V_(cfg.profile),
  } as unknown as ManualHandInput;
  const r = analyzeManualHand(input, OPTIONS);
  if (!r.ok) { failed++; continue; }
  ran++;
  const d = r.decision as unknown as Record<string, any>;
  const dx = d['diagnostics'] as Record<string, any>;
  const math = dx['math'] as Record<string, any>;
  const action = String(d['action']);
  const bd = dx['betDecision'] as Record<string, any> | null;
  const evList = (dx['actionEvidence'] as readonly Record<string, any>[]) ?? [];
  const cands = (dx['candidates'] as readonly Record<string, any>[]) ?? [];
  const unev = (dx['unevaluatedActions'] as readonly Record<string, any>[]) ?? [];
  const reasons = (d['reasons'] as readonly Record<string, any>[]) ?? [];
  const cond = dx['conditionalEquities'] as Record<string, any>;
  const dsrc = dx['decisionSource'] as Record<string, any> | null;
  const raiseEv = evList.find((e) => e.action === 'RAISE');
  const callEvEv = evList.find((e) => e.action === 'CALL');
  const sizeChips = typeof d['sizeChips'] === 'number' ? d['sizeChips'] : null;
  const reasonText = reasons.map((x) => String(x['textZh'])).join(' || ');

  rows.push(
    [
      cfg.tag,
      action, num(sizeChips, 2),
      `callEV=${num(math['callEV'])}`,
      `checkEV=${bd === null ? (raiseEv === undefined ? '-' : '-') : num(bd['checkEV'])}`,
      `best=${bd === null ? '-' : String(bd['bestSize'])}@${bd === null ? '-' : num(bd['bestScore'])}`,
      `chk=${bd === null ? '-' : num(bd['checkScore'])}`,
      `betEVs=[${bd === null ? '' : (bd['sizes'] as readonly Record<string, any>[]).map((s) => `${String(s['kind']).replace('BET_', '')}:${num(s['betEV'], 2)}`).join(',')}]`,
      `raiseEV=${raiseEv === undefined ? '-' : (raiseEv['ev'] === null ? 'null' : num(raiseEv['ev'], 2))}/${raiseEv === undefined ? '-' : String(raiseEv['estimateType'])}`,
      `callEvSrc=${callEvEv === undefined ? '-' : (callEvEv['ev'] === null ? 'null' : num(callEvEv['ev'], 2))}/${callEvEv === undefined ? '-' : String(callEvEv['estimateType'])}`,
      `ownEVsizes=[${(dx['allInGuard']?.['raiseSizesWithOwnEV'] ?? []).join(',')}]`,
      `unev=${unev.length}`,
      `raiseCont=${String(cond['raiseContinueRange'])}`,
      `src=${dsrc === null ? '-' : String(dsrc['kind'])}/${dsrc === null ? '-' : String(dsrc['estimateType'])}`,
      `scroll=${(dx['consistency']?.['violations'] ?? []).length}`,
    ].join(' | '),
  );

  /* ---------- (i) FOLD while CALL EV > 0 ---------- */
  if (action === 'FOLD') {
    const candCall = cands.find((c) => c['action'] === 'CALL');
    const positives: string[] = [];
    if (typeof math['callEV'] === 'number' && math['callEV'] > 0) positives.push(`math.callEV=${num(math['callEV'])}`);
    if (candCall && typeof candCall['ev'] === 'number' && candCall['ev'] > 0) positives.push(`candidate CALL ev=${num(candCall['ev'])}`);
    if (callEvEv && typeof callEvEv['ev'] === 'number' && (callEvEv['ev'] as number) > 0) positives.push(`actionEvidence CALL ev=${num(callEvEv['ev'])}`);
    if (positives.length > 0) {
      hits.push({ tag: cfg.tag, code: 'ANOM-i-FOLD_WITH_POSITIVE_CALL_EV', detail: `${positives.join(' ; ')} | reasons=${reasonText}` });
    }
  }

  /* ---------- (ii) BET while CHECK >= every evaluated BET ---------- */
  if ((action === 'BET' || action === 'ALL_IN') && bd !== null && bd['checkEV'] !== null) {
    const sizes = (bd['sizes'] as readonly Record<string, any>[]).filter((s) => s['betEV'] !== null);
    const maxBet = sizes.length === 0 ? null : Math.max(...sizes.map((s) => s['betEV'] as number));
    const inconsistent = bd['bestSize'] === null || (bd['bestScore'] as number) <= (bd['checkScore'] as number);
    if (maxBet !== null && maxBet < (bd['checkEV'] as number)) {
      hits.push({ tag: cfg.tag, code: 'ANOM-ii-BET_WITH_CHECK_HIGHER', detail: `checkEV=${num(bd['checkEV'])} maxBetEV=${num(maxBet)} best=${String(bd['bestSize'])} bestScore=${num(bd['bestScore'])} checkScore=${num(bd['checkScore'])} | ${reasonText}` });
    } else if (inconsistent) {
      hits.push({ tag: cfg.tag, code: 'ANOM-ii-SCORE_INCONSISTENT', detail: `best=${String(bd['bestSize'])} bestScore=${num(bd['bestScore'])} checkScore=${num(bd['checkScore'])} checkEV=${num(bd['checkEV'])} | ${reasonText}` });
    }
  }
  /* ---------- (ii-) CHECK while bestScore > checkScore ---------- */
  if (action === 'CHECK' && bd !== null && bd['checkEV'] !== null) {
    const sizes = (bd['sizes'] as readonly Record<string, any>[]).filter((s) => s['betEV'] !== null);
    const maxBet = sizes.length === 0 ? null : Math.max(...sizes.map((s) => s['betEV'] as number));
    if ((bd['bestScore'] as number) > (bd['checkScore'] as number) || (maxBet !== null && maxBet > (bd['checkEV'] as number))) {
      hits.push({ tag: cfg.tag, code: 'ANOM-iiR-CHECK_WITH_HIGHER_BET', detail: `checkEV=${num(bd['checkEV'])} maxBetEV=${num(maxBet)} bestScore=${num(bd['bestScore'])} checkScore=${num(bd['checkScore'])} | ${reasonText}` });
    }
  }

  /* ---------- (iii) RAISE claims ---------- */
  const claimCodes = ['RAISE_MODEL_EV', 'ISO_RAISE_MODEL_EV', 'STRATEGIC_RAISE_FOR_VALUE'];
  const hasRaiseClaim = reasons.some((x) => claimCodes.includes(String(x['code'])));
  const claimsEvBest = /EV\s*=\s*[\d.\-+]+|模型 EV|EV 更高|EV 比较/.test(reasonText) && hasRaiseClaim;
  if (hasRaiseClaim && (raiseEv === undefined || raiseEv['ev'] === null)) {
    hits.push({ tag: cfg.tag, code: 'ANOM-iii-RAISE_CLAIM_WITHOUT_RAISE_EV', detail: `action=${action} raiseEvidence=${raiseEv === undefined ? 'ABSENT' : String(raiseEv['estimateType']) + '/ev=' + String(raiseEv['ev'])} | ${reasonText}` });
  } else if (claimsEvBest && raiseEv !== undefined && raiseEv['estimateType'] === 'HEURISTIC') {
    hits.push({ tag: cfg.tag, code: 'ANOM-iii-HEURISTIC_RAISE_CALLED_EV', detail: `raiseEvidence=HEURISTIC ev=${String(raiseEv['ev'])} | ${reasonText}` });
  }
  /* (iii-b) chosen raise size is itself listed as unevaluated */
  if ((action === 'RAISE' || action === 'ALL_IN') && sizeChips !== null) {
    const listed = unev.filter((u) => (u['action'] === 'RAISE' || u['action'] === 'ALL_IN') && Math.abs((u['sizeChips'] ?? -1) - sizeChips) < 1e-6);
    if (listed.length > 0) {
      hits.push({ tag: cfg.tag, code: 'ANOM-iiiB-CHOSEN_RAISE_LISTED_UNEVALUATED', detail: `action=${action} size=${sizeChips} listed=${J(listed)} ownEVsizes=${J(dx['allInGuard']?.['raiseSizesWithOwnEV'])} | ${reasonText}` });
    }
  }
  /* (iii-c) MODEL_EV source on RAISE while raiseContinueRange NOT_IMPLEMENTED */
  if ((action === 'RAISE' || action === 'ALL_IN') && dsrc !== null && dsrc['estimateType'] === 'MODEL_EV' && cond['raiseContinueRange'] === 'NOT_IMPLEMENTED') {
    hits.push({ tag: cfg.tag, code: 'ANOM-iiiC-MODEL_EV_WITH_RAISE_CONTINUE_NOT_IMPLEMENTED', detail: `${J(dsrc)} | ${reasonText}` });
  }

  /* ---------- (v) consistency violations ---------- */
  const viol = (dx['consistency']?.['violations'] ?? []) as readonly unknown[];
  if (viol.length > 0) hits.push({ tag: cfg.tag, code: 'ANOM-v-CONSISTENCY_VIOLATION', detail: J(viol) });
}

console.log(`nodes configured = ${cfgs.length}, ran = ${ran}, failed = ${failed}, elapsedMs = ${Date.now() - t0}`);
console.log('\n===== ONE LINE PER NODE =====');
/* print a deduped subset: unique by (street, mode, action) to keep it readable, plus all FACE nodes */
const seen = new Set<string>();
for (const row of rows) {
  console.log(row);
}
console.log('\n===== SUBJECT (hero acting after villain check => CHECK/BET node) =====');
for (const row of rows) {
  if (row.includes('-IP-') || row.includes('-OOP-')) console.log(row);
}
console.log('\n===== HITS =====');
if (hits.length === 0) console.log('NO HITS');
for (const h of hits) console.log(`\n[${h.code}] ${h.tag}\n  ${h.detail}`);
const byCode = new Map<string, number>();
for (const h of hits) byCode.set(h.code, (byCode.get(h.code) ?? 0) + 1);
console.log('\n===== HIT COUNTS =====');
for (const [k, v] of [...byCode.entries()].sort()) console.log(`  ${k} = ${v}`);
void seen;
console.log('\nDONE flriver-gent2-sweep');
