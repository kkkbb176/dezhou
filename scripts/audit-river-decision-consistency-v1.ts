/**
 * RIVER DECISION CONSISTENCY · 复现探针（只读，不改产品代码）
 *
 * 复现用户报告：9 人桌 · Hero BTN · A♠K♠ · 牌面 J♥8♠Q♠K♥K♦ · 河牌 CO 过牌 · 轮 Hero
 * 底池 97.5BB · Hero 剩余 55BB · CO 剩余 55BB ⇒ 「最终建议下注 55BB」而「内部最高 EV = ALL_IN」
 * 并出现 DECISION_CONSISTENCY_ERROR / ACTION_CONTRADICTS_PREFERENCE。
 */
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';

const OPTIONS = {
  rules: loadKnowledgeBaseOrThrow().allRules(),
  asOf: 1_757_000_000_000,
  writeLog: false,
  equitySeed: 20_260_913,
  budget: { softMs: 120_000, hardMs: 240_000 },
} as const;

/** 1BB = 50 筹码（与既有探针口径一致） */
const BB = 50;
const START = 55 + 48; // 已投入 48BB（3 + 10 + 35）⇒ 剩余 55BB

const input = {
  tableSize: 9,
  heroPosition: 'BTN',
  heroCards: ['As', 'Ks'],
  board: ['Jh', '8s', 'Qs', 'Kh', 'Kd'],
  street: 'RIVER',
  effectiveStackBB: 55,
  bigBlindBB: BB,
  seatStacksBB: {
    UTG: START, UTG1: 100, UTG2: 100, LJ: 100, HJ: 100,
    CO: START, BTN: START, SB: 100, BB: 100,
  },
  actionHistory: [
    { position: 'UTG', type: 'FOLD' },
    { position: 'UTG1', type: 'FOLD' },
    { position: 'UTG2', type: 'FOLD' },
    { position: 'LJ', type: 'FOLD' },
    { position: 'HJ', type: 'FOLD' },
    { position: 'CO', type: 'CALL', amountBB: 1 },
    { position: 'BTN', type: 'RAISE', amountBB: 3 },
    { position: 'SB', type: 'FOLD' },
    { position: 'BB', type: 'FOLD' },
    { position: 'CO', type: 'CALL', amountBB: 2 },
    { position: 'CO', type: 'BET', amountBB: 10, street: 'FLOP' },
    { position: 'BTN', type: 'CALL', amountBB: 10, street: 'FLOP' },
    { position: 'CO', type: 'BET', amountBB: 35, street: 'TURN' },
    { position: 'BTN', type: 'CALL', amountBB: 35, street: 'TURN' },
    { position: 'CO', type: 'CHECK', street: 'RIVER' },
  ],
  environment: 'MID_LOW_STAKES',
  villain: { quickProfile: 'NORMAL', dynamicHint: 'UNKNOWN', stackBB: 55 },
} as const;

const result0 = analyzeManualHand(input as never, OPTIONS);
console.log('ok =', result0.ok, result0.ok ? '' : `stage=${result0.stage}`);
if (!result0.ok) {
  console.log(JSON.stringify(result0.issues, null, 1));
}

/* ---- 紧凑报告器 + 变体扫描 ---- */
type Variant = { label: string; history: readonly Record<string, unknown>[]; profile: string };

const PASSIVE = [
  { position: 'UTG', type: 'FOLD' }, { position: 'UTG1', type: 'FOLD' }, { position: 'UTG2', type: 'FOLD' },
  { position: 'LJ', type: 'FOLD' }, { position: 'HJ', type: 'FOLD' },
  { position: 'CO', type: 'CALL', amountBB: 1 }, { position: 'BTN', type: 'RAISE', amountBB: 3 },
  { position: 'SB', type: 'FOLD' }, { position: 'BB', type: 'FOLD' }, { position: 'CO', type: 'CALL', amountBB: 2 },
  { position: 'CO', type: 'CHECK', street: 'FLOP' }, { position: 'BTN', type: 'BET', amountBB: 10, street: 'FLOP' },
  { position: 'CO', type: 'CALL', amountBB: 10, street: 'FLOP' },
  { position: 'CO', type: 'CHECK', street: 'TURN' }, { position: 'BTN', type: 'BET', amountBB: 35, street: 'TURN' },
  { position: 'CO', type: 'CALL', amountBB: 35, street: 'TURN' },
  { position: 'CO', type: 'CHECK', street: 'RIVER' },
];

const VARIANTS: readonly Variant[] = [
  { label: 'A 被动线 NORMAL', history: PASSIVE, profile: 'NORMAL' },
  { label: 'B 被动线 LOOSE_PASSIVE', history: PASSIVE, profile: 'LOOSE_PASSIVE' },
  { label: 'C 被动线 CALL_STATION', history: PASSIVE, profile: 'CALL_STATION' },
  { label: 'D 被动线 TIGHT', history: PASSIVE, profile: 'TIGHT' },
  { label: 'E 领注线 NORMAL', history: input.actionHistory as unknown as readonly Record<string, unknown>[], profile: 'NORMAL' },
];

for (const v of VARIANTS) {
  const r = analyzeManualHand(
    { ...input, actionHistory: v.history, villain: { quickProfile: v.profile, dynamicHint: 'UNKNOWN', stackBB: 55 } } as never,
    OPTIONS,
  );
  if (!r.ok) {
    console.log(`\n### ${v.label} ⇒ 拒绝 stage=${r.stage}`);
    continue;
  }
  const d = r.decision as unknown as Record<string, unknown>;
  const dg = (d['diagnostics'] ?? {}) as Record<string, unknown>;
  const math = (dg['math'] ?? {}) as Record<string, unknown>;
  const bd = (dg['betDecision'] ?? null) as Record<string, unknown> | null;
  const basis = (dg['decisionBasis'] ?? {}) as Record<string, unknown>;
  const cons = (dg['consistency'] ?? {}) as Record<string, unknown>;

  console.log(`\n### ${v.label}`);
  console.log(`  math: pot=${String(math['pot'])} stack=${String(math['myRemainingStack'])} eff=${String(math['effectiveStack'])} equity=${Number(math['heroEquity']).toFixed(4)} callCost=${String(math['callCost'])} hand=${String(math['handRankZh'])}`);
  console.log(`  最终 action=${JSON.stringify(d['action'])} ｜ basis=${String(basis['kind'])} ｜ consistency.ok=${String(cons['ok'])}`);
  const viol = (cons['violations'] ?? []) as readonly Record<string, unknown>[];
  for (const x of viol) console.log(`    ✖ ${String(x['code'])}：${String(x['messageZh'] ?? x['message'] ?? '')}`);
  if (bd !== null) {
    console.log(`  checkEV=${Number(bd['checkEV']).toFixed(1)} checkScore=${Number(bd['checkScore']).toFixed(3)} bestSize=${String(bd['bestSize'])} bestScore=${Number(bd['bestScore']).toFixed(3)}`);
    for (const s of (bd['sizes'] ?? []) as readonly Record<string, unknown>[]) {
      console.log(
        `    size ${String(s['kind']).padEnd(11)} bet=${Number(s['betAmount']).toFixed(0).padStart(5)} EV=${(s['betEV'] === null ? '—' : Number(s['betEV']).toFixed(1)).padStart(8)} score=${Number(s['score']).toFixed(3)} ΔvsCheck=${(s['deltaVsCheck'] === null ? '—' : Number(s['deltaVsCheck']).toFixed(1))}`,
      );
    }
  } else {
    console.log('  betDecision = null');
  }
  const shape = dg['actionShape'];
  if (shape !== undefined) console.log(`  actionShape=${JSON.stringify(shape)}`);
  const primary = dg['primaryAction'];
  if (primary !== undefined) console.log(`  primaryAction=${JSON.stringify(primary)}`);
  const cands = (dg['candidates'] ?? []) as readonly Record<string, unknown>[];
  console.log(`  candidates=${JSON.stringify(cands.map((c) => ({ a: c['action'], amt: c['amountBB'] ?? c['betAmount'] ?? c['amountChips'], ev: c['ev'] ?? c['evChips'] })))}`);
  const ps = (dg['preferenceScores'] ?? null) as readonly Record<string, unknown>[] | null;
  if (ps !== null) console.log(`  preferenceScores=${JSON.stringify(ps)}`);
}
