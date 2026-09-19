/**
 * P1 · 墨菲定律反证 + 影响面扫描（**只读**；合成范围仅用于本次审计，不写入生产策略）
 *
 * 目标：证明「数学证据支持 CALL 却弃牌」这一分歧的**方向与边界**：
 *   A  原始 99 节点（MANIAC 800 手）                      → 分歧出现
 *   B  紧弱画像（CALL EV 为负、带内）                      → 应弃牌且无告警
 *   B′ 合成**强范围**（CALL EV 明显为负、超出容差带）        → 应弃牌且无告警
 *   C  合成**弱范围**（CALL EV 明显为正、超出容差带）        → 应跟注（若仍弃牌 ⇒ 同一缺陷）
 *   D  中性画像（CALL EV ≈ +0.05，带内）                  → 按既定规则 EV > ε 应跟注
 *   E  无画像（置信度最低）                                → 与 D 对照：置信度是否构成覆盖授权
 *   F  无人下注（callCost = 0 ⇒ callEV = null）            → 不得产生 FOLD 硬判
 *
 * 合成范围通过**生产入口的既有输入** `AnalyzeOptions.gtoRanges` 注入（不改任何代码）。
 */
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import type { ManualHandInput, ManualVillain } from '../src/app/manualInput/manualInput.ts';
import type { SolverRangeOverride } from '../src/app/manualInput/contextBuilder.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const BASE_OPTIONS = {
  rules: RULES, asOf: 1_757_000_000_000, writeLog: false,
  equitySeed: 20_260_913, budget: { softMs: 120_000, hardMs: 240_000 },
} as const;
const A_ = (p: string, t: string, bb?: number, s?: string): Record<string, unknown> => ({
  position: p, type: t, ...(bb === undefined ? {} : { amountBB: bb }), ...(s === undefined ? {} : { street: s }),
});
const base = {
  tableSize: 6, heroPosition: 'BTN', effectiveStackBB: 100, bigBlindBB: 2,
  seatStacksBB: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 },
  environment: 'MID_LOW_STAKES',
};
const HISTORY_FACING_BET = [
  A_('UTG', 'FOLD'), A_('HJ', 'FOLD'), A_('CO', 'FOLD'),
  A_('BTN', 'RAISE', 3), A_('SB', 'FOLD'), A_('BB', 'CALL', 2),
  A_('BB', 'CHECK', undefined, 'FLOP'), A_('BTN', 'BET', 4, 'FLOP'), A_('BB', 'CALL', 4, 'FLOP'),
  A_('BB', 'BET', 10, 'TURN'),
];
/** 转牌 BB **过牌**（无下注）⇒ 轮到我、`callCost = 0`、`callEV = null`（墨菲 F 用） */
const HISTORY_UNOPENED = [...HISTORY_FACING_BET.slice(0, -1), A_('BB', 'CHECK', undefined, 'TURN')];

const maniac: ManualVillain = {
  seatId: 'seat_BB', persistentPlayerId: 'player_001', displayName: '阿豪', quickProfile: 'MANIAC', dynamicHint: 'UNKNOWN', stackBB: 100,
  observedStats: { handsObserved: 800, vpip: 0.48, pfr: 0.35, threeBet: 0.16, wtsd: 0.36, foldToFlopCBet: null, foldToTurnCBet: null, foldToRiverBet: null, flopCheckRaise: null, turnCheckRaise: null, riverCheckRaise: null },
};
const inputOf = (villain: ManualVillain, history: readonly Record<string, unknown>[]): ManualHandInput =>
  ({ ...base, heroCards: ['9h', '9c'], board: ['Jd', '8c', '4c', '6s'], street: 'TURN', actionHistory: history, villain } as unknown as ManualHandInput);

const strongRange: SolverRangeOverride = {
  weights: { AA: 1, KK: 1, QQ: 1, JJ: 1, TT: 1, '99': 1, '88': 1, AKs: 1, AKo: 1, AQs: 1, 'AJo': 0.8, 'KQs': 0.8 },
  labelZh: '审计用合成范围：**只有强牌**（AA–88 / AK / AQ / KQ）',
  engineCommit: null, usedActions: ['RAISE'], reportedGap: null, iterationsCompleted: null,
};
const weakRange: SolverRangeOverride = {
  weights: { '72o': 1, '83o': 1, '94o': 1, 'T2o': 1, 'J3o': 1, '52o': 1, '64o': 1, 'A2o': 0.5 },
  labelZh: '审计用合成范围：**只有垃圾**（72o/83o/94o/T2o/J3o/52o/64o）',
  engineCommit: null, usedActions: ['CALL'], reportedGap: null, iterationsCompleted: null,
};

const n = (v: unknown, d = 4): string => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : String(v));
const line = (s = ''): void => console.log(s);
const rule = (w = 128): string => '─'.repeat(w);

type Row = {
  readonly tag: string; readonly action: string; readonly callEV: number | null;
  readonly required: number; readonly eqBet: number | null; readonly eqArr: number | null;
  readonly band: number; readonly inBand: boolean; readonly basisKind: string;
  readonly conf: number; readonly violations: readonly string[]; readonly warnings: readonly string[];
};

function rowOf(tag: string, villain: ManualVillain, history: readonly Record<string, unknown>[], gtoRanges?: Record<string, SolverRangeOverride>): Row {
  const input = inputOf(villain, history);
  const r = analyzeManualHand(input, { ...BASE_OPTIONS, ...(gtoRanges === undefined ? {} : { gtoRanges }) } as never);
  if (!r.ok) throw new Error(`${tag} 分析失败：${r.stage}`);
  const d = r.decision as unknown as Record<string, any>;
  const dg = d['diagnostics'] as Record<string, any>;
  const math = dg['math'] as Record<string, any>;
  const cons = (dg['consistency'] ?? null) as Record<string, any> | null;
  const band = 0.05 * math['winnable'];
  return {
    tag, action: `${String(d['action'])}${d['sizeChips'] === undefined ? '' : ` ${String(d['sizeChips'])}`}`,
    callEV: math['callEV'], required: math['requiredEquity'],
    eqBet: math['heroEquityVsBetRange'], eqArr: math['heroEquity'],
    band, inBand: math['callEV'] !== null && Math.abs(math['callEV']) <= band,
    basisKind: String(dg['decisionBasis']['kind'] ?? dg['decisionSource']?.['kind'] ?? '—'),
    conf: d['confidence'],
    violations: ((cons?.['violations'] as readonly Record<string, any>[]) ?? []).map((v) => String(v['code'])),
    warnings: r.warnings as readonly string[],
  };
}

line(rule());
line(' P1 · 墨菲定律反证（同一节点：BTN 9♥9♣ ｜ J♦8♣4♣6♠ ｜ 转牌面对 BB 10BB 领先下注）');
line(rule());
line('  变体                                 | 动作      | CALL EV      | 所需权益 | EqVsBet | EqArr  | 容差带 | 带内  | 依据       | 置信 | 一致性告警');
const rows: Row[] = [
  rowOf('A  原始（MANIAC 800 手）', maniac, HISTORY_FACING_BET),
  rowOf('B  紧弱（VERY_TIGHT，无统计）', { ...maniac, quickProfile: 'VERY_TIGHT', observedStats: undefined } as ManualVillain, HISTORY_FACING_BET),
  rowOf('B′ 合成强范围（只用强牌）', maniac, HISTORY_FACING_BET, { seat_BB: strongRange }),
];
/* 弱范围：对手 id 由引擎内部决定 ⇒ 先跑一次拿 id，再注入 */
{
  const probe = analyzeManualHand(inputOf(maniac, HISTORY_FACING_BET), BASE_OPTIONS);
  if (!probe.ok) throw new Error('probe failed');
  const ids = ((probe.decision as unknown as Record<string, any>)['diagnostics']['opponentRanges'] as readonly Record<string, any>[])
    .map((x) => String(x['opponentId']));
  const id = ids[0] ?? 'seat_BB';
  rows.push(rowOf(`C  合成弱范围（只用垃圾，id=${id}）`, maniac, HISTORY_FACING_BET, { [id]: weakRange }));
}
rows.push(rowOf('D  中性（NORMAL，无统计）', { ...maniac, quickProfile: 'NORMAL', observedStats: undefined } as ManualVillain, HISTORY_FACING_BET));
rows.push(rowOf('E  无画像（UNKNOWN，无统计）', { seatId: 'seat_BB', persistentPlayerId: 'player_001', displayName: '阿豪', dynamicHint: 'UNKNOWN', stackBB: 100 }, HISTORY_FACING_BET));
rows.push(rowOf('F  无人下注（callCost = 0）', maniac, HISTORY_UNOPENED));

for (const r of rows) {
  line(
    `  ${r.tag.padEnd(36)}| ${r.action.padEnd(9)} | ${n(r.callEV, 6).padStart(12)} | ${`${(r.required * 100).toFixed(2)}%`.padStart(8)} | ` +
    `${r.eqBet === null ? '—' : `${(r.eqBet * 100).toFixed(2)}%`.padStart(6)} | ${r.eqArr === null ? '—' : `${(r.eqArr * 100).toFixed(2)}%`.padStart(5)} | ` +
    `${n(r.band, 2).padStart(6)} | ${String(r.inBand).padStart(5)} | ${r.basisKind.padEnd(10)} | ${n(r.conf, 2)} | ${r.violations.length === 0 ? '无' : r.violations.join(',')}`,
  );
}

line('');
line(rule());
line(' 影响面扫描：现有场景网格（5 画像 × 5 统计形态 × 3 牌面 = 75 局面）里有多少「CALL EV > ε 却弃牌」');
line(rule());
const PROFILES = ['MANIAC', 'CALLING_STATION', 'VERY_TIGHT', 'NORMAL', null] as const;
const STATS: ReadonlyArray<readonly [string, Record<string, unknown> | null]> = [
  ['无统计', null],
  ['四轴 800 手', { handsObserved: 800, vpip: 0.48, pfr: 0.35, threeBet: 0.16, wtsd: 0.36, foldToFlopCBet: null, foldToTurnCBet: null, foldToRiverBet: null, flopCheckRaise: null, turnCheckRaise: null, riverCheckRaise: null }],
  ['仅 VPIP', { handsObserved: 800, vpip: 0.62, pfr: null, threeBet: null, wtsd: null, foldToFlopCBet: null, foldToTurnCBet: null, foldToRiverBet: null, flopCheckRaise: null, turnCheckRaise: null, riverCheckRaise: null }],
  ['仅 PFR 低', { handsObserved: 800, vpip: null, pfr: 0.08, threeBet: null, wtsd: null, foldToFlopCBet: null, foldToTurnCBet: null, foldToRiverBet: null, flopCheckRaise: null, turnCheckRaise: null, riverCheckRaise: null }],
  ['仅分街', { handsObserved: 800, vpip: null, pfr: null, threeBet: null, wtsd: null, foldToFlopCBet: null, foldToTurnCBet: null, foldToRiverBet: 0.55, flopCheckRaise: null, turnCheckRaise: null, riverCheckRaise: 0.1 }],
];
const BOARDS: ReadonlyArray<readonly [string, readonly [string, string], readonly string[]]> = [
  ['99/Jd8c4c6s（本例：中对）', ['9h', '9c'], ['Jd', '8c', '4c', '6s']],
  ['AJ/Jd8c4c6s（顶对+听花）', ['Ac', 'Jc'], ['Jd', '8c', '4c', '6s']],
  ['AA/Ad9c4h6s2d（河牌超对）', ['As', 'Ah'], ['Ad', '9c', '4h', '6s', '2d']],
];
let total = 0; let foldedPositive = 0; const hits: string[] = [];
for (const [boardTag, heroCards, board] of BOARDS) {
  for (const qp of PROFILES) {
    for (const [statTag, stats] of STATS) {
      const villain: ManualVillain = {
        seatId: 'seat_BB', persistentPlayerId: 'player_001', displayName: '阿豪', dynamicHint: 'UNKNOWN', stackBB: 100,
        ...(qp === null ? {} : { quickProfile: qp as never }),
        ...(stats === null ? {} : { observedStats: stats as never }),
      };
      /* 河牌牌面需要自己的历史：翻前 → 翻牌 → 转牌 → 河牌 BB 领打 */
      const history = board.length === 5
        ? [
            A_('UTG', 'FOLD'), A_('HJ', 'FOLD'), A_('CO', 'FOLD'),
            A_('BTN', 'RAISE', 3), A_('SB', 'FOLD'), A_('BB', 'CALL', 2),
            A_('BB', 'CHECK', undefined, 'FLOP'), A_('BTN', 'BET', 2.5, 'FLOP'), A_('BB', 'CALL', 2.5, 'FLOP'),
            A_('BB', 'CHECK', undefined, 'TURN'), A_('BTN', 'BET', 7.5, 'TURN'), A_('BB', 'CALL', 7.5, 'TURN'),
            A_('BB', 'BET', 10, 'RIVER'),
          ]
        : HISTORY_FACING_BET;
      const input = { ...base, heroCards, board, street: board.length === 5 ? 'RIVER' : 'TURN', actionHistory: history, villain } as unknown as ManualHandInput;
      const r = analyzeManualHand(input, BASE_OPTIONS);
      if (!r.ok) continue;
      total += 1;
      const d = r.decision as unknown as Record<string, any>;
      const math = (d['diagnostics'] as Record<string, any>)['math'] as Record<string, any>;
      const ev = math['callEV'] as number | null;
      const isFold = String(d['action']) === 'FOLD';
      if (isFold && ev !== null && ev > 1e-6) {
        foldedPositive += 1;
        hits.push(`      ${boardTag.padEnd(30)} ${String(qp ?? 'NONE').padEnd(16)} ${statTag.padEnd(12)} CALL EV = ${n(ev, 4)}（容差带 ±${n(0.05 * math['winnable'], 2)}）`);
      }
    }
  }
}
line(`  扫描局面数 = ${total} ｜ 「CALL EV > 0 却弃牌」= ${foldedPositive}`);
for (const h of hits) line(h);
line(rule());
