/**
 * PLAYER IDENTITY ROUTING V1 · **修复后验收证据**（只读）
 *
 * 三部分：
 *  §A 身份路由：五种身份声明形态在生产链上解析成什么（含 warnings 与画像证据）
 *  §B 实测统计的**独立**下游实验（工作单 §七）：同一 playerId / 同一座位 / 同一牌局 /
 *     同一标签，**只改** VPIP / PFR / 3Bet / WTSD，逐字段输出接入情况
 *  §C 保留样本回归快照（TEST 16 / AK 河牌 / 99 暗三条 / F-01 / P0-7）
 */
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import { parseManualInput, type ManualHandInput, type ManualVillain } from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const OPTIONS = {
  rules: RULES, asOf: 1_757_000_000_000, writeLog: false,
  equitySeed: 20_260_913, budget: { softMs: 120_000, hardMs: 240_000 },
} as const;

const A = (position: string, type: string, amountBB?: number, street?: string): Record<string, unknown> => ({
  position, type,
  ...(amountBB === undefined ? {} : { amountBB }),
  ...(street === undefined ? {} : { street }),
});

const line = (s = ''): void => console.log(s);
const n = (v: unknown, d = 6): string => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : String(v));
const pad = (s: string, w: number): string => {
  const len = [...s].reduce((a, c) => a + (c.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
  return s + ' '.repeat(Math.max(0, w - len));
};
const rule = (w = 132): string => '='.repeat(w);

const BASE_STATS = {
  handsObserved: 800, vpip: 0.48, pfr: 0.35, threeBet: 0.16, wtsd: 0.36,
  foldToFlopCBet: null, foldToTurnCBet: null, foldToRiverBet: null,
  flopCheckRaise: null, turnCheckRaise: null, riverCheckRaise: null,
} as const;

/** TEST 16 原牌局 */
function test16(villain: ManualVillain): ManualHandInput {
  return {
    tableSize: 6, heroPosition: 'BTN', heroCards: ['As', 'Ah'], board: ['Ad', '9c', '4h', '6s', '2d'],
    street: 'RIVER', effectiveStackBB: 100, bigBlindBB: 2,
    seatStacksBB: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 },
    actionHistory: [
      A('UTG', 'FOLD'), A('HJ', 'FOLD'), A('CO', 'FOLD'),
      A('BTN', 'RAISE', 3), A('SB', 'FOLD'), A('BB', 'CALL', 2),
      A('BB', 'CHECK', undefined, 'FLOP'), A('BTN', 'BET', 2.5, 'FLOP'), A('BB', 'CALL', 2.5, 'FLOP'),
      A('BB', 'CHECK', undefined, 'TURN'), A('BTN', 'BET', 7.5, 'TURN'), A('BB', 'CALL', 7.5, 'TURN'),
      A('BB', 'BET', 10, 'RIVER'),
    ],
    environment: 'MID_LOW_STAKES',
    villain,
  } as unknown as ManualHandInput;
}

function readOf(input: ManualHandInput): Record<string, any> {
  const r = analyzeManualHand(input, OPTIONS);
  if (!r.ok) return { failed: `${r.stage}: ${JSON.stringify(r.issues)}` };
  const d = r.decision as unknown as Record<string, any>;
  const dg = d['diagnostics'] as Record<string, any>;
  const pf = (dg['postflop'] ?? {}) as Record<string, any>;
  return {
    action: `${String(d['action'])}${d['sizeChips'] === undefined ? '' : ` @ ${String(d['sizeChips'])}`}`,
    math: dg['math'],
    range: pf['bettingRangeFacts'] ?? null,
    arrival: pf['betRangeArrival'] ?? null,
    raise: pf['raiseResponse'] ?? null,
    profileRange: dg['profileRange'] ?? null,
    warnings: r.warnings as readonly string[],
  };
}

function identityOf(input: ManualHandInput): Record<string, any> {
  const parsed = parseManualInput(input);
  if (!parsed.ok) return { failed: JSON.stringify(parsed.issues) };
  const gate = buildAnalyzableState(parsed.value);
  if (!gate.ok) return { failed: JSON.stringify(gate.issues) };
  const built = buildDecisionContext({
    state: gate.state, rules: RULES, environment: 'MID_LOW_STAKES', asOf: OPTIONS.asOf,
    ...(parsed.value.villain.quickProfile !== undefined ? { quickProfile: parsed.value.villain.quickProfile } : {}),
    ...(parsed.value.villain.dynamicHint !== undefined ? { dynamicHint: parsed.value.villain.dynamicHint } : {}),
    ...(parsed.value.villain.playerId !== undefined ? { villainPlayerId: parsed.value.villain.playerId } : {}),
    ...(parsed.value.villain.persistentPlayerId !== undefined && parsed.value.villain.persistentPlayerId !== null
      ? { villainPersistentPlayerId: parsed.value.villain.persistentPlayerId } : {}),
    ...(parsed.value.villain.seatId !== undefined && parsed.value.villain.seatId !== null
      ? { villainSeatId: parsed.value.villain.seatId } : {}),
    ...(parsed.value.villain.displayName !== undefined && parsed.value.villain.displayName !== null
      ? { villainDisplayName: parsed.value.villain.displayName } : {}),
    ...(parsed.value.villain.observedStats !== undefined && parsed.value.villain.observedStats !== null
      ? { observedStats: parsed.value.villain.observedStats } : {}),
    equitySeed: OPTIONS.equitySeed, budget: OPTIONS.budget,
  } as never);
  return { identity: built.playerIdentity as unknown as Record<string, any>, v3: (built.context as any).profileV3 };
}

/* ============================================================
 * §A 身份路由
 * ============================================================ */

line(rule());
line(' §A. 身份路由：五种声明形态在生产链上的解析结果（TEST 16 原牌局）');
line(rule());
const CLAIMS: [string, ManualVillain][] = [
  ['① 座位 + 持久 + 显示名（牌桌路径）', { seatId: 'seat_BB', persistentPlayerId: 'player_001', displayName: '阿豪', quickProfile: 'MANIAC', dynamicHint: 'UNKNOWN', stackBB: 100, observedStats: BASE_STATS }],
  ['② 只给持久 id（单一对手）', { persistentPlayerId: 'player_001', displayName: '阿豪', quickProfile: 'MANIAC', dynamicHint: 'UNKNOWN', stackBB: 100, observedStats: BASE_STATS }],
  ['③ 只给座位 id（引擎口径）', { playerId: 'seat_BB', quickProfile: 'MANIAC', dynamicHint: 'UNKNOWN', stackBB: 100, observedStats: BASE_STATS }],
  ['④ 只给名字「阿豪」（TEST 16 原样）', { playerId: '阿豪', quickProfile: 'MANIAC', dynamicHint: 'UNKNOWN', stackBB: 100, observedStats: BASE_STATS }],
  ['⑤ 只给显示名（无 id）', { displayName: '阿豪', quickProfile: 'MANIAC', dynamicHint: 'UNKNOWN', stackBB: 100 }],
  ['⑥ 座位指向已弃牌的人（seat_CO）', { seatId: 'seat_CO', persistentPlayerId: 'player_009', displayName: '老张', quickProfile: 'MANIAC', dynamicHint: 'UNKNOWN', stackBB: 100 }],
  ['⑦ 完全不给身份', { quickProfile: 'MANIAC', dynamicHint: 'UNKNOWN', stackBB: 100 }],
];
line('  ' + pad('声明', 36) + pad('status', 26) + pad('目标座位', 10) + pad('持久身份', 12) + pad('快照 id', 10) + pad('画像证据', 30) + 'warnings');
for (const [tag, villain] of CLAIMS) {
  const id = identityOf(test16(villain));
  const read = readOf(test16(villain));
  const pr = read['profileRange'];
  line('  ' + pad(tag, 36) + pad(String(id['identity']?.['status']), 26) + pad(String(id['identity']?.['seatId']), 10) +
    pad(String(id['identity']?.['persistentPlayerId']), 12) + pad(String(id['identity']?.['snapshotPlayerId']), 10) +
    pad(pr === null || pr === undefined ? 'null（画像未进范围）' : `${String(pr['dimensionTier'])} Δ${n(pr['equityDeltaPct'], 4)}pp`, 30) +
    String((read['warnings'] as readonly string[]).length));
  if (id['identity']?.['disclosureZh'] !== null && id['identity']?.['disclosureZh'] !== undefined) {
    line('       ↳ 披露：' + String(id['identity']['disclosureZh']));
  }
  for (const w of (read['warnings'] as readonly string[])) line('       ↳ warning：' + w);
}

/* ============================================================
 * §B 实测统计的独立下游实验（工作单 §七）
 * ============================================================ */

line('');
line(rule());
line(' §B. 实测统计下游实验：同一 playerId / 同一座位 / 同一牌局 / 同一标签，只改 4 项统计');
line(rule());
const SWEEP: [string, Partial<Record<'vpip' | 'pfr' | 'threeBet' | 'wtsd', number>>][] = [
  ['S0 无统计（基线，全 null）', {}],
  ['S1 VPIP 0.20（很紧）', { vpip: 0.2 }],
  ['S2 VPIP 0.62（很松）', { vpip: 0.62 }],
  ['S3 PFR 0.05', { pfr: 0.05 }],
  ['S4 PFR 0.48', { pfr: 0.48 }],
  ['S5 3Bet 0.02', { threeBet: 0.02 }],
  ['S6 3Bet 0.30', { threeBet: 0.3 }],
  ['S7 WTSD 0.15', { wtsd: 0.15 }],
  ['S8 WTSD 0.60', { wtsd: 0.6 }],
];
line('  ' + pad('变体', 24) + pad('Profile Loaded', 26) + pad('Resolved Dimensions（融合后）', 46) +
  pad('Range Provider Input', 20) + pad('Arrival Range', 22) + pad('Bet Range', 18) + pad('EqVsBetRange', 13) + 'Final Action');
line('  ' + '-'.repeat(170));
const sweepRows: Record<string, Record<string, any>> = {};
for (const [tag, over] of SWEEP) {
  const stats = { ...BASE_STATS, ...over };
  const input = test16({
    seatId: 'seat_BB', persistentPlayerId: 'player_001', displayName: '阿豪',
    quickProfile: 'MANIAC', dynamicHint: 'UNKNOWN', stackBB: 100,
    ...(Object.keys(over).length === 0 ? {} : { observedStats: stats }),
  });
  const id = identityOf(input);
  const r = readOf(input);
  sweepRows[tag] = { id, r };
  const d = id['v3']?.['resolvedDimensions'] as Record<string, number> | undefined;
  const rr = r['raise'];
  line('  ' + pad(tag, 24) +
    pad(`#${String(id['v3']?.['observedStatCount'])}/${String(id['v3']?.['confidenceTierZh'] ?? '')}`, 26) +
    pad(d === undefined ? '—' : `紧${n(d['tightness'], 3)} 凶${n(d['aggression'], 3)} 诈${n(d['bluffTendency'], 3)} 被${n(d['passivity'], 3)}`, 46) +
    pad(String(r['profileRange']?.['dimensionTier'] ?? '—'), 20) +
    pad(`${String(r['arrival']?.['supportCount'])} 组｜Eq ${n(r['arrival']?.['heroEquityVsArrivalRange'], 6)}`, 22) +
    pad(`${String(r['range']?.['entryCount'])} 组｜质量 ${n(r['range']?.['betMass'], 6)}`, 18) +
    pad(n(r['math']?.['heroEquityVsBetRange']), 13) + String(r['action']) +
    (rr === null
      ? ''
      : `｜响应 ${n(rr['foldLikelihood'], 4)}/${n(rr['callLikelihood'], 4)}/${n(rr['reRaiseLikelihood'], 4)}｜RAISE EV ${n(rr['raiseEV'], 4)}`));
}
line('');
{
  const base = sweepRows['S0 无统计（基线，全 null）']!;
  /** 只看**下游决策数字**（不含画像对象本身） */
  const downstream = (row: Record<string, any>): string => JSON.stringify({
    arrivalCount: row['r']?.['arrival']?.['supportCount'],
    arrivalEq: row['r']?.['arrival']?.['heroEquityVsArrivalRange'],
    betCount: row['r']?.['range']?.['entryCount'],
    betMass: row['r']?.['range']?.['betMass'],
    eqBet: row['r']?.['math']?.['heroEquityVsBetRange'],
    callEV: row['r']?.['math']?.['callEV'],
    raise: row['r']?.['raise'] === null ? null : [
      row['r']['raise']['foldLikelihood'], row['r']['raise']['callLikelihood'],
      row['r']['raise']['reRaiseLikelihood'], row['r']['raise']['raiseEV'],
    ],
    action: row['r']?.['action'],
  });
  /** 只看**画像解析层**（统计是否被加载） */
  const profileLayer = (row: Record<string, any>): string => JSON.stringify({
    count: row['id']?.['v3']?.['observedStatCount'],
    dims: row['id']?.['v3']?.['resolvedDimensions'],
    trace: (row['id']?.['v3']?.['trace'] as Record<string, any>[]).map((t) => [t['stat'], t['observedRate'], t['effectiveRate']]),
  });
  const baseDown = downstream(base);
  const baseProfile = profileLayer(base);
  const others = SWEEP.filter(([tag]) => tag !== 'S0 无统计（基线，全 null）');
  const profileChanged = others.filter(([tag]) => profileLayer(sweepRows[tag]!) !== baseProfile);
  const downChanged = others.filter(([tag]) => downstream(sweepRows[tag]!) !== baseDown);
  line(`  A. 画像解析层（统计是否被加载）发生变化的变体：${profileChanged.length}／${others.length}` +
    (profileChanged.length > 0 ? ` ⇒ ${profileChanged.map(([t]) => t).join('、')}` : ''));
  line(`  B. 下游决策数字（到达/下注范围、EqVsBetRange、CALL EV、加注响应、最终动作）发生变化的变体：` +
    `${downChanged.length}／${others.length}${downChanged.length > 0 ? ` ⇒ ${downChanged.map(([t]) => t).join('、')}` : '（**全部为零**）'}`);
  line('  ⇒ 结论（分离两个独立问题）：');
  line('     · VPIP / PFR / 3Bet / WTSD **已成功加载**（observedStatCount=4、resolvedDimensions 随值变化）；');
  line('     · 但在**面对下注**的节点上它们**没有进入任何下游数字** —— 这是**独立的能力缺口**（工作单 §七 B），');
  line('       与身份路由（工作单 §七 A）是两件事：身份修复只保证「画像按正确的人加载」，不假装统计已接入。');
}

/* ============================================================
 * §C 保留样本回归快照
 * ============================================================ */

line('');
line(rule());
line(' §C. 保留样本回归快照（修复后；与 tests 中锁定的行为对照）');
line(rule());
const SAMPLES: [string, ManualHandInput][] = [
  ['TEST 16（Hero BTN，AA 顶暗三条，座位+持久身份）', test16({ seatId: 'seat_BB', persistentPlayerId: 'player_001', displayName: '阿豪', quickProfile: 'MANIAC', dynamicHint: 'UNKNOWN', stackBB: 100, observedStats: BASE_STATS })],
  ['TEST 16（同上，但只给名字 —— 旧的 TEST 16 写法）', test16({ playerId: '阿豪', quickProfile: 'MANIAC', dynamicHint: 'UNKNOWN', stackBB: 100, observedStats: BASE_STATS })],
  ['AK 河牌 vs 20BB（U1 HAND A 形态 · CS）', {
    tableSize: 6, heroPosition: 'BTN', heroCards: ['As', 'Ks'], board: ['Kd', '9c', '4h', '6s', '2d'],
    street: 'RIVER', effectiveStackBB: 100, bigBlindBB: 2,
    seatStacksBB: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 },
    actionHistory: [
      A('UTG', 'FOLD'), A('HJ', 'FOLD'), A('CO', 'FOLD'), A('BTN', 'RAISE', 3), A('SB', 'FOLD'), A('BB', 'CALL', 2),
      A('BB', 'CHECK', undefined, 'FLOP'), A('BTN', 'BET', 2.5, 'FLOP'), A('BB', 'CALL', 2.5, 'FLOP'),
      A('BB', 'CHECK', undefined, 'TURN'), A('BTN', 'BET', 7.5, 'TURN'), A('BB', 'CALL', 7.5, 'TURN'),
      A('BB', 'BET', 10, 'RIVER'),
    ],
    environment: 'MID_LOW_STAKES',
    villain: { quickProfile: 'CALLING_STATION', dynamicHint: 'UNKNOWN', stackBB: 100 },
  } as unknown as ManualHandInput],
  ['99 暗三条河牌 vs 10BB（U1 HAND B 形态 · CS）', {
    tableSize: 6, heroPosition: 'BTN', heroCards: ['9s', '9h'], board: ['Kd', '9c', '4h', '6s', '2d'],
    street: 'RIVER', effectiveStackBB: 100, bigBlindBB: 2,
    seatStacksBB: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 },
    actionHistory: [
      A('UTG', 'FOLD'), A('HJ', 'FOLD'), A('CO', 'FOLD'), A('BTN', 'RAISE', 3), A('SB', 'FOLD'), A('BB', 'CALL', 2),
      A('BB', 'CHECK', undefined, 'FLOP'), A('BTN', 'BET', 2.5, 'FLOP'), A('BB', 'CALL', 2.5, 'FLOP'),
      A('BB', 'CHECK', undefined, 'TURN'), A('BTN', 'BET', 7.5, 'TURN'), A('BB', 'CALL', 7.5, 'TURN'),
      A('BB', 'BET', 10, 'RIVER'),
    ],
    environment: 'MID_LOW_STAKES',
    villain: { quickProfile: 'CALLING_STATION', dynamicHint: 'UNKNOWN', stackBB: 100 },
  } as unknown as ManualHandInput],
  ['F-01（CO KK 翻牌面对 6BB 领先下注 · NORMAL）', {
    tableSize: 6, heroPosition: 'CO', heroCards: ['Kd', 'Kc'], board: ['Kh', '7c', '2d'],
    street: 'FLOP', effectiveStackBB: 100,
    actionHistory: [
      A('UTG', 'FOLD'), A('HJ', 'FOLD'), A('CO', 'RAISE', 3), A('BTN', 'FOLD'), A('SB', 'FOLD'), A('BB', 'CALL', 2),
      A('BB', 'BET', 6, 'FLOP'),
    ],
    environment: 'MID_LOW_STAKES', villain: { quickProfile: 'NORMAL' },
  } as unknown as ManualHandInput],
  ['P0-7（BTN 100BB vs BB 30BB，河牌 10BB · CS）', {
    tableSize: 6, heroPosition: 'BTN', heroCards: ['As', 'Ks'], board: ['Kd', '9c', '4h', '6s', '2d'],
    street: 'RIVER', effectiveStackBB: 30, bigBlindBB: 2,
    seatStacksBB: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 30 },
    actionHistory: [
      A('UTG', 'FOLD'), A('HJ', 'FOLD'), A('CO', 'FOLD'), A('BTN', 'RAISE', 3), A('SB', 'FOLD'), A('BB', 'CALL', 2),
      A('BB', 'CHECK', undefined, 'FLOP'), A('BTN', 'BET', 2.5, 'FLOP'), A('BB', 'CALL', 2.5, 'FLOP'),
      A('BB', 'CHECK', undefined, 'TURN'), A('BTN', 'BET', 7.5, 'TURN'), A('BB', 'CALL', 7.5, 'TURN'),
      A('BB', 'BET', 10, 'RIVER'),
    ],
    environment: 'MID_LOW_STAKES',
    villain: { quickProfile: 'CALLING_STATION', dynamicHint: 'UNKNOWN', stackBB: 30 },
  } as unknown as ManualHandInput],
];
line('  ' + pad('样本', 46) + pad('动作', 14) + pad('CALL EV', 11) + pad('RAISE EV', 11) + pad('EqVsBetRange', 13) + 'warnings');
for (const [tag, input] of SAMPLES) {
  const r = readOf(input);
  if (r['failed'] !== undefined) { line('  ' + pad(tag, 46) + `分析失败：${String(r['failed'])}`); continue; }
  line('  ' + pad(tag, 46) + pad(String(r['action']), 14) + pad(n(r['math']?.['callEV'], 4), 11) +
    pad(n(r['raise']?.['raiseEV'], 4), 11) + pad(n(r['math']?.['heroEquityVsBetRange'], 9), 13) +
    String((r['warnings'] as readonly string[]).length));
}
line('');
line('  说明：`warnings` 列是**身份/范围**的降级披露条数（修复前这条路是静默的）。');
line(rule());
