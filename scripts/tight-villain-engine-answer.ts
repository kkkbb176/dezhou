/**
 * 「针对很紧的玩家（紧手 / 极紧）」—— **引擎答案**探针（只读，不写决策日志）
 *
 * 不写扑克理论：把问题交给生产链路，让引擎自己给出
 *   动作 / 尺寸 / 置信度 / 依据 / 对手范围与权益主链证据。
 *
 * 链路：parseManualInput → buildAnalyzableState → buildDecisionContext
 *        → decisionEngine（真实 EV 第一名）→ toDecisionViewModel
 *
 * 章节：
 *  §0 机制诊断：画像**具体改了哪个量**（范围形状？响应概率？尺寸？）
 *  §A 翻前：UTG 开池 3BB → Hero BTN（9 人桌 100BB）
 *  §B 翻前：Hero BTN 开池 3BB → 紧手 BB 3Bet 到 9BB → Hero 决策
 *  §C 翻后（面对紧手持续下注）：Hero BTN 跟注 → K♠7♥2♣ 面对 5BB 下注
 *  §D 翻后（紧手过牌给你）：同一牌面 Hero 有位置
 *  §E 引擎告警与口径限制
 */
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import type { ManualHandInput, ManualVillain } from '../src/app/manualInput/manualInput.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const OPTIONS = {
  rules: RULES,
  asOf: 1_757_000_000_000,
  writeLog: false,
  equitySeed: 20_260_913,
  budget: { softMs: 600_000, hardMs: 1_200_000 },
} as const;

type V = Partial<ManualVillain>;

const A = (position: string, type: string, amountBB?: number, street?: string): Record<string, unknown> => ({
  position,
  type,
  ...(amountBB === undefined ? {} : { amountBB }),
  ...(street === undefined ? {} : { street }),
});

const W = (s: string): number => [...s].reduce((a, c) => a + (c.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
const pad = (s: string, w: number): string => s + ' '.repeat(Math.max(0, w - W(s)));
const rule = (w = 118): string => '='.repeat(w);
const pct = (v: unknown, d = 1): string =>
  typeof v === 'number' && Number.isFinite(v) ? `${(v * 100).toFixed(d)}%` : '—';
const num = (v: unknown, d = 2): string =>
  typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : '—';

const SEATS9 = { UTG: 100, UTG1: 100, UTG2: 100, LJ: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 } as const;

const STATS_TIGHT_FOLDER = {
  handsObserved: 2000, vpip: 0.12, pfr: 0.09, threeBet: 0.03, wtsd: 0.24,
  foldToFlopCBet: 0.72, foldToTurnCBet: 0.55, foldToRiverBet: 0.6,
  flopCheckRaise: 0.1, turnCheckRaise: 0.07, riverCheckRaise: 0.08,
} as const;

const PROFILES: readonly { name: string; short: string; villain: V }[] = [
  { name: 'NORMAL(标签)', short: 'NORMAL', villain: { quickProfile: 'NORMAL' } },
  { name: 'VERY_TIGHT(标签)', short: 'V_TIGHT', villain: { quickProfile: 'VERY_TIGHT' } },
  { name: '紧手实测VPIP12/PFR9', short: '紧实测', villain: { quickProfile: 'VERY_TIGHT', observedStats: STATS_TIGHT_FOLDER as never } },
  { name: '松/跟注站(对照)', short: '跟注站', villain: { quickProfile: 'CALLING_STATION' } },
];
const NORMAL = PROFILES[0]!;
const TIGHT = PROFILES[1]!;
const TIGHT_STATS = PROFILES[2]!;
const STATION = PROFILES[3]!;

type Reading = {
  ok: boolean;
  action: string;
  sizeBB: string;
  conf: string;
  cls: string;
  eqArrival: string;
  eqBet: string;
  reqEq: string;
  callEV: string;
  reason: string;
  warnings: string;
  raw: ReturnType<typeof analyzeManualHand>;
};

function read(input: ManualHandInput): Reading {
  const r = analyzeManualHand(input, OPTIONS);
  if (!r.ok) {
    return {
      ok: false, action: `FAIL/${r.stage}`, sizeBB: '-', conf: '-', cls: '-', eqArrival: '-', eqBet: '-',
      reqEq: '-', callEV: '-', reason: r.issues.map((i) => `${i.code}: ${i.message}`).join(' | ').slice(0, 220),
      warnings: '', raw: r,
    };
  }
  const d = r.decision;
  const m = d.diagnostics.math;
  const pf = d.diagnostics.postflop;
  return {
    ok: true,
    action: String(d.action),
    sizeBB: d.sizeBB === undefined ? '—' : d.sizeBB.toFixed(2),
    conf: `${d.confidence.toFixed(2)}/${d.band}`,
    cls: d.classification,
    eqArrival: pct(pf?.betRangeArrival?.heroEquityVsArrivalRange ?? m.heroEquity),
    eqBet: pct(m.heroEquityVsBetRange ?? m.heroEquity),
    reqEq: pct(m.requiredEquity),
    callEV: num(m.callEV, 1),
    reason: (r.viewModel.reasonsZh[0] ?? '').replace(/\s+/g, ' ').slice(0, 150),
    warnings: (r.warnings as readonly string[]).join(' | ').replace(/\s+/g, ' ').slice(0, 260),
    raw: r,
  };
}

/** 找到诊断对象里含关键词的字段（递归，深度有限） */
function findFields(obj: unknown, keys: readonly string[], depth = 0): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (depth > 4 || obj === null || typeof obj !== 'object') return out;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (keys.some((want) => k === want || k.toLowerCase().includes(want.toLowerCase()))) out[k] = v;
    if (v !== null && typeof v === 'object') {
      Object.assign(out, findFields(v, keys, depth + 1));
    }
  }
  return out;
}

/* ============================================================
 * 局面构造
 * ============================================================ */

/** §A 翻前：UTG 开池 3BB，弃到 Hero 在 BTN */
function pFacingOpen(hero: readonly [string, string], villain: V): ManualHandInput {
  return {
    tableSize: 9, heroPosition: 'BTN', heroCards: hero, board: [], street: 'PREFLOP',
    effectiveStackBB: 100, bigBlindBB: 100, seatStacksBB: SEATS9,
    actionHistory: [A('UTG', 'RAISE', 3), A('UTG1', 'FOLD'), A('UTG2', 'FOLD'), A('LJ', 'FOLD'), A('HJ', 'FOLD'), A('CO', 'FOLD')],
    environment: 'MID_LOW_STAKES',
    villain: { persistentPlayerId: 'p_tight_utg', seatId: 'seat_UTG', displayName: '紧手', stackBB: 100, ...villain } as ManualVillain,
  } as unknown as ManualHandInput;
}

/** §B 翻前：Hero BTN 开池 3BB → SB 弃 → 紧手 BB 3Bet 到 9BB → Hero 决策 */
function pFacing3Bet(hero: readonly [string, string], villain: V): ManualHandInput {
  return {
    tableSize: 9, heroPosition: 'BTN', heroCards: hero, board: [], street: 'PREFLOP',
    effectiveStackBB: 100, bigBlindBB: 100, seatStacksBB: SEATS9,
    actionHistory: [
      A('UTG', 'FOLD'), A('UTG1', 'FOLD'), A('UTG2', 'FOLD'), A('LJ', 'FOLD'), A('HJ', 'FOLD'),
      A('CO', 'FOLD'), A('BTN', 'RAISE', 3), A('SB', 'FOLD'), A('BB', 'RAISE', 9),
    ],
    environment: 'MID_LOW_STAKES',
    villain: { persistentPlayerId: 'p_tight_bb', seatId: 'seat_BB', displayName: '紧手', stackBB: 100, ...villain } as ManualVillain,
  } as unknown as ManualHandInput;
}

/** §C/§D 翻后：UTG 开池 → Hero BTN 跟注 → K♠7♥2♣ */
function pPostflop(hero: readonly [string, string], villain: V, utgAction: 'BET' | 'CHECK'): ManualHandInput {
  return {
    tableSize: 9, heroPosition: 'BTN', heroCards: hero, board: ['Ks', '7h', '2c'], street: 'FLOP',
    effectiveStackBB: 100, bigBlindBB: 100, seatStacksBB: SEATS9,
    actionHistory: [
      A('UTG', 'RAISE', 3), A('UTG1', 'FOLD'), A('UTG2', 'FOLD'), A('LJ', 'FOLD'), A('HJ', 'FOLD'), A('CO', 'FOLD'),
      A('BTN', 'CALL', 3), A('SB', 'FOLD'), A('BB', 'FOLD'),
      utgAction === 'BET' ? A('UTG', 'BET', 5, 'FLOP') : A('UTG', 'CHECK', undefined, 'FLOP'),
    ],
    environment: 'MID_LOW_STAKES',
    villain: { persistentPlayerId: 'p_tight_utg', seatId: 'seat_UTG', displayName: '紧手', stackBB: 100, ...villain } as ManualVillain,
  } as unknown as ManualHandInput;
}

/* ============================================================
 * §0 机制诊断
 * ============================================================ */
console.log(rule());
console.log('§0 机制诊断：同一个局面，只改对手画像 —— 引擎改了哪个量？');
console.log(rule());

function diagnose(title: string, input: ManualHandInput): void {
  const r = read(input);
  if (!r.ok) {
    console.log(`${pad(title, 30)} FAIL ${r.action} ${r.reason}`);
    return;
  }
  const d = (r.raw as { decision: { diagnostics: Record<string, unknown> } }).decision;
  const dg = d.diagnostics as Record<string, any>;
  const pr = (dg['profileRange'] ?? null) as Record<string, any> | null;
  const range = (dg['range'] ?? {}) as Record<string, any>;
  const pf = (dg['postflop'] ?? null) as Record<string, any> | null;
  console.log(
    `${pad(title, 30)} ${pad(r.action, 7)} 尺寸=${pad(r.sizeBB, 7)} 权益到达=${pad(r.eqArrival, 8)} ` +
    `EqVs下注范围=${pad(r.eqBet, 8)} 需权益=${pad(r.reqEq, 8)} CALL_EV=${r.callEV}`,
  );
  console.log(
    `${' '.repeat(30)} 范围: 组合=${String(range['supportSize'] ?? '—')} 来源=${String(range['sourceKind'] ?? '—')}` +
    ` | 画像证据: ${pr === null ? 'null（画像未进入范围）' : `权益 ${pct(pr['equityBefore'])}→${pct(pr['equityAfter'])} Δ=${num(pr['equityDeltaPct'], 4)}`}`,
  );
  if (pf !== null) {
    const comp = pf['rangeCompression'] ?? null;
    const va = pf['valueAssessment'] ?? null;
    const bet = pf['betDecision'] ?? null;
    console.log(`${' '.repeat(30)} 范围压缩: ${comp === null ? '—' : JSON.stringify(comp)}`);
    console.log(`${' '.repeat(30)} 价值判定: ${va === null ? '—' : JSON.stringify(va)}`);
    if (bet !== null) console.log(`${' '.repeat(30)} 下注决策: ${JSON.stringify(bet).slice(0, 420)}`);
  }
  const resp = findFields(dg, ['fold', 'callProb', 'raiseProb', 'responseProbability', 'buckets'], 0);
  const respText = JSON.stringify(resp);
  if (respText.length > 2) console.log(`${' '.repeat(30)} 响应概率相关字段: ${respText.slice(0, 400)}`);
}

diagnose('翻前 AQs vs NORMAL', pFacingOpen(['As', 'Qs'], NORMAL.villain));
diagnose('翻前 AQs vs VERY_TIGHT', pFacingOpen(['As', 'Qs'], TIGHT.villain));
diagnose('翻前 AQs vs 紧实测', pFacingOpen(['As', 'Qs'], TIGHT_STATS.villain));
console.log('');
diagnose('翻后 K72r AQ vs NORMAL', pPostflop(['As', 'Qh'], NORMAL.villain, 'BET'));
diagnose('翻后 K72r AQ vs VERY_TIGHT', pPostflop(['As', 'Qh'], TIGHT.villain, 'BET'));
diagnose('翻后 K72r AQ vs 紧实测', pPostflop(['As', 'Qh'], TIGHT_STATS.villain, 'BET'));
diagnose('翻后 K72r AQ vs 跟注站', pPostflop(['As', 'Qh'], STATION.villain, 'BET'));

/* ============================================================
 * §A / §B 翻前
 * ============================================================ */
function preflopSection(title: string, hands: readonly [string, string][], build: (h: readonly [string, string], v: V) => ManualHandInput): void {
  console.log('');
  console.log(rule());
  console.log(title);
  console.log(rule());
  console.log(pad('手牌', 8) + pad('对手画像', 22) + pad('动作', 8) + pad('尺寸BB', 9) + pad('权益(到达)', 10) + pad('需权益', 9) + '分类');
  console.log('-'.repeat(118));
  for (const [hi, lo] of hands) {
    for (const p of [NORMAL, TIGHT, TIGHT_STATS]) {
      const r = read(build([hi, lo], p.villain));
      if (!r.ok) {
        console.log(pad(`${hi}${lo}`, 8) + pad(p.name, 22) + r.action + ' ' + r.reason);
        continue;
      }
      console.log(
        pad(`${hi}${lo}`, 8) + pad(p.name, 22) + pad(r.action, 8) + pad(r.sizeBB, 9) +
        pad(r.eqArrival, 10) + pad(r.reqEq, 9) + r.cls,
      );
    }
  }
}

preflopSection(
  '§A 翻前：UTG 开池 3BB → Hero BTN（9 人桌 / 100BB / 中低级别环境）',
  [['As', 'Ah'], ['Ks', 'Kh'], ['Qs', 'Qh'], ['Js', 'Jh'], ['Ts', 'Th'], ['9s', '9h'],
   ['As', 'Ks'], ['As', 'Qs'], ['As', 'Js'], ['Ks', 'Qs'], ['As', '5s'], ['7s', '6s'],
   ['As', 'Qh'], ['As', 'Th'], ['Ks', 'Qh'], ['Qs', 'Jh']],
  pFacingOpen,
);

preflopSection(
  '§B 翻前：Hero BTN 开池 3BB → 紧手 BB 3Bet 到 9BB → Hero 决策',
  [['As', 'Ah'], ['Ks', 'Kh'], ['Qs', 'Qh'], ['Js', 'Jh'], ['Ts', 'Th'],
   ['As', 'Ks'], ['As', 'Qs'], ['As', 'Js'], ['Ks', 'Qs'], ['As', '5s'], ['As', 'Qh'], ['7s', '6s']],
  pFacing3Bet,
);

/* ============================================================
 * §C / §D 翻后
 * ============================================================ */
function postflopSection(title: string, hands: readonly [string, string][], utgAction: 'BET' | 'CHECK'): void {
  console.log('');
  console.log(rule());
  console.log(title);
  console.log(rule());
  console.log(pad('手牌', 8) + pad('对手画像', 22) + pad('动作', 8) + pad('尺寸BB', 9) + pad('权益(到达)', 10) + pad('EqVs下注', 10) + pad('需权益', 9) + 'CALL_EV');
  console.log('-'.repeat(118));
  for (const [hi, lo] of hands) {
    for (const p of [NORMAL, TIGHT, TIGHT_STATS, STATION]) {
      const r = read(pPostflop([hi, lo], p.villain, utgAction));
      if (!r.ok) {
        console.log(pad(`${hi}${lo}`, 8) + pad(p.name, 22) + r.action + ' ' + r.reason);
        continue;
      }
      console.log(
        pad(`${hi}${lo}`, 8) + pad(p.name, 22) + pad(r.action, 8) + pad(r.sizeBB, 9) +
        pad(r.eqArrival, 10) + pad(r.eqBet, 10) + pad(r.reqEq, 9) + r.callEV,
      );
    }
  }
}

postflopSection(
  '§C 翻后：UTG 开池 → Hero BTN 跟注 → K♠7♥2♣，紧手 UTG 下注 5BB（≈2/3 池）',
  [['Kh', 'Qh'], ['As', 'Qh'], ['Js', 'Jh'], ['9s', '9h'], ['8s', '7s'], ['As', '5s'], ['5s', '4s'], ['As', 'Jh']],
  'BET',
);

postflopSection(
  '§D 翻后：K♠7♥2♣，紧手 UTG **过牌**给 Hero（Hero 有位置，可以下注）',
  [['As', '5s'], ['8s', '7s'], ['As', 'Jh'], ['As', 'Qh'], ['Js', 'Jh'], ['9s', '9h'], ['Kh', 'Qh']],
  'CHECK',
);

/* ============================================================
 * §E 告警
 * ============================================================ */
console.log('');
console.log(rule());
console.log('§E 引擎自报的口径限制（warnings）');
console.log(rule());
for (const [hi, lo] of [['As', 'Ks'], ['9s', '9h'], ['As', '5s']] as const) {
  const r = read(pFacingOpen([hi, lo], TIGHT.villain));
  console.log(`${pad(`翻前 ${hi}${lo}`, 14)} ${r.warnings}`);
}
for (const [hi, lo] of [['As', 'Qh'], ['8s', '7s']] as const) {
  const r = read(pPostflop([hi, lo], TIGHT.villain, 'BET'));
  console.log(`${pad(`翻后 ${hi}${lo}`, 14)} ${r.warnings}`);
}
for (const [hi, lo] of [['As', 'Qh'], ['8s', '7s']] as const) {
  const r = read(pPostflop([hi, lo], TIGHT.villain, 'CHECK'));
  console.log(`${pad(`翻后过牌 ${hi}${lo}`, 16)} ${r.warnings}`);
}

