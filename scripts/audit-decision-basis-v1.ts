/**
 * DECISION BASIS CONSISTENCY V1 · 只读审计探针
 *
 * 目的：用**生产入口**（`analyzeManualHand`）逐场景核对两套决策依据标签
 * （`ACTION_EV_COMPARISON` / `PREFERENCE_SCORE`）的输入、公式、排序与最终动作，
 * 并覆盖授权清单 §四 A–G 七个场景。
 *
 * ⚠️ 只读：不修改任何产品代码、不写入台账、不动未跟踪文件。
 */
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import { normalizeEVScore } from '../src/domain/postflop/betResponse.ts';
import { toDecisionViewModel } from '../src/viewmodels/decisionViewModel.ts';

const OPTIONS = {
  rules: loadKnowledgeBaseOrThrow().allRules(),
  asOf: 1_757_000_000_000,
  writeLog: false,
  equitySeed: 20_260_913,
  budget: { softMs: 120_000, hardMs: 240_000 },
} as const;

const BB = 50;
const BOARD = ['Jh', '8s', 'Qs', 'Kh', 'Kd'];
const INVESTED = 48;
/** 前三条街：CO 溜入 → BTN 加注 3 → CO 补 2 → 翻牌/转牌 CO 过牌·BTN 下注·CO 跟 → 河牌 CO 过牌 */
const HISTORY = [
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

type Diag = Record<string, any>;

const makeInput = (hole: readonly string[], startStackBB: number, profile: string, dynamicHint = 'UNKNOWN') => ({
  tableSize: 9,
  heroPosition: 'BTN',
  heroCards: [...hole],
  board: [...BOARD],
  street: 'RIVER',
  effectiveStackBB: startStackBB - INVESTED,
  bigBlindBB: BB,
  seatStacksBB: {
    UTG: startStackBB, UTG1: 100, UTG2: 100, LJ: 100, HJ: 100,
    CO: startStackBB, BTN: startStackBB, SB: 100, BB: 100,
  },
  actionHistory: HISTORY,
  environment: 'MID_LOW_STAKES',
  villain: { quickProfile: profile, dynamicHint, stackBB: startStackBB - INVESTED },
});

const HANDS: readonly { tag: string; hole: readonly string[] }[] = [
  { tag: 'A♠K♠ 三条K', hole: ['As', 'Ks'] },
  { tag: 'T♠9♠ 顺子', hole: ['Ts', '9s'] },
  { tag: 'Q♦J♣ 两对', hole: ['Qd', 'Jc'] },
  { tag: '7♣6♣ 空气', hole: ['7c', '6c'] },
  { tag: '5♥5♦ 小对', hole: ['5h', '5d'] },
];
const PROFILES = ['NORMAL', 'TIGHT', 'MANIAC', 'WEAK'];
const STACKS = [103, 300];

type Row = Record<string, unknown>;
const rows: Row[] = [];

for (const hand of HANDS) {
  for (const profile of PROFILES) {
    for (const stack of STACKS) {
      const result = analyzeManualHand(makeInput(hand.hole, stack, profile) as never, OPTIONS);
      if (!result.ok) {
        rows.push({ hand: hand.tag, profile, stack, rejected: `${result.stage}: ${result.issues.map((i) => i.message).join(' / ')}` });
        continue;
      }
      const decision = result.decision as unknown as Diag;
      const dg = decision['diagnostics'] as Diag;
      const math = dg['math'] as Diag;
      const bd = (dg['betDecision'] ?? null) as Diag | null;
      const shape = (dg['actionShape'] ?? {}) as Diag;
      const cons = (dg['consistency'] ?? {}) as Diag;
      const basis = (dg['decisionBasis'] ?? {}) as Diag;
      const vm = toDecisionViewModel(result.decision);

      const sizes = bd === null ? [] : ((bd['sizes'] ?? []) as readonly Diag[]);
      const legal = bd === null ? [] : ((bd['legalSizes'] ?? []) as readonly Diag[]);
      const argmaxEV = sizes.length === 0 ? null : sizes.reduce((a, b) => (Number(b['betEV']) > Number(a['betEV']) ? b : a));
      const argmaxScore = legal.length === 0 ? null : legal.reduce((a, b) => (Number(b['score']) > Number(a['score']) ? b : a));
      const saturated = sizes.filter((s) => Number(s['score']) >= 1 - 1e-12).map((s) => s['kind']);
      const evKinds = [...new Set(sizes.map((s) => String(s['evKind'])))];
      const amounts = sizes.map((s) => Number(s['betAmount']));
      const dupAmounts = amounts.filter((a, i) => amounts.indexOf(a) !== i);

      rows.push({
        hand: hand.tag,
        profile,
        stack,
        pot: math['pot'],
        stackChips: math['myRemainingStack'],
        equity: Number(math['heroEquity']).toFixed(4),
        handZh: math['handRankZh'],
        callCost: math['callCost'],
        checkEV: bd === null ? null : Number(bd['checkEV']).toFixed(1),
        sizes: sizes.map((s) => `${String(s['kind'])}@${Number(s['betAmount']).toFixed(0)}EV${s['betEV'] === null ? '—' : Number(s['betEV']).toFixed(1)}S${Number(s['score']).toFixed(3)}`),
        argmaxEV: argmaxEV === null ? null : `${String(argmaxEV['kind'])}@${Number(argmaxEV['betAmount']).toFixed(0)}`,
        argmaxScore: argmaxScore === null ? null : `${String(argmaxScore['kind'])}@${Number(argmaxScore['betAmount']).toFixed(0)}`,
        agree: argmaxEV !== null && argmaxScore !== null && argmaxEV['kind'] === argmaxScore['kind'],
        clampTie: saturated.length > 1 ? saturated : null,
        evKinds: evKinds.length > 1 ? evKinds : evKinds[0],
        dupAmounts: dupAmounts.length > 0 ? dupAmounts : null,
        bestSize: bd === null ? null : bd['bestSize'],
        chosenAction: decision['action'],
        sizeChips: shape['sizeChips'] ?? null,
        allInToAmount: shape['allInToAmount'] ?? null,
        consumesStack: shape['consumesStack'] ?? null,
        basis: basis['kind'],
        consOk: cons['ok'],
        violations: ((cons['violations'] ?? []) as readonly Diag[]).map((v) => v['code']),
        vmAction: vm.actionZh,
        vmSize: vm.sizeZh ?? null,
        player: {
          source: (dg['player'] ?? {})?.['source'] ?? null,
          confidence: (dg['player'] ?? {})?.['confidence'] ?? null,
          samples: (dg['player'] ?? {})?.['samples'] ?? (dg['player'] ?? {})?.['handsObserved'] ?? null,
        },
        rangeConfidence: (dg['range'] ?? {})?.['confidence'] ?? null,
        degradations: ((dg['degradations'] ?? []) as readonly Diag[]).map((d) => d['code'] ?? d['kind'] ?? ''),
      });
    }
  }
}

/* ---- 汇总 ---- */
let agree = 0; let disagree = 0; let clamp = 0; let duplicates = 0; let mixedEvKind = 0;
let allInBet = 0; let normalBet = 0; let rejected = 0;
const profileEv: Record<string, string[]> = {};
for (const r of rows) {
  if (r['rejected'] !== undefined) { rejected += 1; continue; }
  if (r['agree'] === true) agree += 1; else disagree += 1;
  if (r['clampTie'] !== null && r['clampTie'] !== undefined) clamp += 1;
  if (Array.isArray(r['dupAmounts'])) duplicates += 1;
  if (Array.isArray(r['evKinds'])) mixedEvKind += 1;
  if (r['consumesStack'] === true) allInBet += 1;
  else if (r['chosenAction'] === 'BET') normalBet += 1;
  const key = `${String(r['hand'])}|${String(r['stack'])}`;
  profileEv[key] = profileEv[key] ?? [];
  profileEv[key]!.push(`${String(r['profile'])}:${String(r['checkEV'])}/${(r['sizes'] as string[]).join(',')}`);
}

console.log('=== §四 场景扫描（生产入口 analyzeManualHand）===');
for (const r of rows) {
  if (r['rejected'] !== undefined) { console.log(`REJECT ${String(r['hand'])}/${String(r['profile'])}/${String(r['stack'])} ⇒ ${String(r['rejected'])}`); continue; }
  console.log(
    `${String(r['hand'])}｜${String(r['profile'])}｜stack=${String(r['stack'])}BB ⇒ pot=${String(r['pot'])} stack=${String(r['stackChips'])} eq=${String(r['equity'])} checkEV=${String(r['checkEV'])}\n` +
    `    sizes=[${(r['sizes'] as string[]).join(' | ')}]\n` +
    `    argmaxEV=${String(r['argmaxEV'])} argmaxScore=${String(r['argmaxScore'])} agree=${String(r['agree'])} clampTie=${JSON.stringify(r['clampTie'])} dupAmounts=${JSON.stringify(r['dupAmounts'])} evKinds=${JSON.stringify(r['evKinds'])}\n` +
    `    bestSize=${String(r['bestSize'])} action=${String(r['chosenAction'])} size=${String(r['sizeChips'])} allIn=${String(r['allInToAmount'])} consumesStack=${String(r['consumesStack'])}\n` +
    `    basis=${String(r['basis'])} consOk=${String(r['consOk'])} viol=${JSON.stringify(r['violations'])} vm=${String(r['vmAction'])}｜${String(r['vmSize'])}\n` +
    `    player=${JSON.stringify(r['player'])} rangeConf=${String(r['rangeConfidence'])} degradations=${JSON.stringify(r['degradations'])}`,
  );
}
console.log('=== 汇总 ===');
console.log(JSON.stringify({ agree, disagree, clamp, duplicates, mixedEvKind, allInBet, normalBet, rejected }, null, 1));
console.log('=== 画像差分（同手同深度、不同画像的 checkEV 与各尺寸 EV）===');
for (const [key, list] of Object.entries(profileEv)) console.log(`  ${key}\n    ${list.join('\n    ')}`);

/* ---- 公式边界：normalizeEVScore 是否严格单调（含钳位饱和）---- */
const pot = 4875;
const checkEV = 3711.5;
const probes = [
  { label: 'ΔEV = 0.1×pot', ev: checkEV + 0.1 * pot },
  { label: 'ΔEV = 0.5×pot（=0.75）', ev: checkEV + 0.5 * pot },
  { label: 'ΔEV = 1.0×pot（钳位边界）', ev: checkEV + 1.0 * pot },
  { label: 'ΔEV = 1.5×pot（钳位后）', ev: checkEV + 1.5 * pot },
  { label: 'ΔEV = 3.0×pot（钳位后）', ev: checkEV + 3.0 * pot },
  { label: 'ΔEV = −0.5×pot', ev: checkEV - 0.5 * pot },
  { label: 'ΔEV = −1.0×pot（下钳位）', ev: checkEV - 1.0 * pot },
];
console.log('=== §三 公式边界（pot=4875, checkEV=3711.5）===');
for (const p of probes) {
  console.log(`  ${p.label.padEnd(28)} ⇒ score=${normalizeEVScore(p.ev, checkEV, pot).toFixed(6)}`);
}
console.log(
  `  钳位饱和 ⇒ 两个不同 EV 得到同一 score：` +
  `${normalizeEVScore(checkEV + 1.0 * pot, checkEV, pot)} === ${normalizeEVScore(checkEV + 3.0 * pot, checkEV, pot)} ⇒ ` +
  `${normalizeEVScore(checkEV + 1.0 * pot, checkEV, pot) === normalizeEVScore(checkEV + 3.0 * pot, checkEV, pot)}`,
);
console.log('（探针结束）');
