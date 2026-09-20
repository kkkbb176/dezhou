/**
 * PLAYER PROFILE EXPLOIT VALIDATION V1 · 单统计敏感度探针（只读）
 *
 * 目的：把「实测统计通道」拆成**单变量**，看每一级是否真的动：
 *   身份字段 / 空统计 / 单个统计（逐项）/ 样本量 —— 分别对
 *   ① 玩家快照（player）② 对手范围（range）③ 响应概率（fold/call/raise）④ EV ⑤ 最终动作
 * 的影响。
 *
 * 固定牌局同 `audit-player-profile-exploit-v1.ts`（A♠K♠｜Jh 8s Qs Kh Kd｜pot 4875｜剩 2750）。
 * ⚠️ 受控测试输入：统计值为**人工设定**，用于验证链路，不代表真实玩家。
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

const BB = 50; const START = 103; const INVESTED = 48;
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

type Variant = { id: string; villain: Record<string, unknown> };
const V = (id: string, villain: Record<string, unknown>): Variant => ({ id, villain });

const VARIANTS: readonly Variant[] = [
  V('S0 无身份·无统计（基线）', { quickProfile: 'UNKNOWN', dynamicHint: 'UNKNOWN', stackBB: 55 }),
  V('S1 仅身份·无统计', { quickProfile: 'UNKNOWN', dynamicHint: 'UNKNOWN', stackBB: 55, persistentPlayerId: 'p1', displayName: '甲' }),
  V('S2 空统计（handsObserved=400，无任何键）', { quickProfile: 'UNKNOWN', dynamicHint: 'UNKNOWN', stackBB: 55, persistentPlayerId: 'p1', observedStats: { handsObserved: 400 } }),
  V('S3 foldToRiverBet=0.05', { quickProfile: 'UNKNOWN', dynamicHint: 'UNKNOWN', stackBB: 55, persistentPlayerId: 'p1', observedStats: { handsObserved: 400, foldToRiverBet: 0.05 } }),
  V('S4 foldToRiverBet=0.95', { quickProfile: 'UNKNOWN', dynamicHint: 'UNKNOWN', stackBB: 55, persistentPlayerId: 'p1', observedStats: { handsObserved: 400, foldToRiverBet: 0.95 } }),
  V('S5 riverCheckRaise=0.02', { quickProfile: 'UNKNOWN', dynamicHint: 'UNKNOWN', stackBB: 55, persistentPlayerId: 'p1', observedStats: { handsObserved: 400, riverCheckRaise: 0.02 } }),
  V('S6 riverCheckRaise=0.60', { quickProfile: 'UNKNOWN', dynamicHint: 'UNKNOWN', stackBB: 55, persistentPlayerId: 'p1', observedStats: { handsObserved: 400, riverCheckRaise: 0.6 } }),
  V('S7 vpip=0.08', { quickProfile: 'UNKNOWN', dynamicHint: 'UNKNOWN', stackBB: 55, persistentPlayerId: 'p1', observedStats: { handsObserved: 400, vpip: 0.08 } }),
  V('S8 vpip=0.80', { quickProfile: 'UNKNOWN', dynamicHint: 'UNKNOWN', stackBB: 55, persistentPlayerId: 'p1', observedStats: { handsObserved: 400, vpip: 0.8 } }),
  V('S9 wtsd=0.15', { quickProfile: 'UNKNOWN', dynamicHint: 'UNKNOWN', stackBB: 55, persistentPlayerId: 'p1', observedStats: { handsObserved: 400, wtsd: 0.15 } }),
  V('S10 wtsd=0.70', { quickProfile: 'UNKNOWN', dynamicHint: 'UNKNOWN', stackBB: 55, persistentPlayerId: 'p1', observedStats: { handsObserved: 400, wtsd: 0.7 } }),
  V('S11 threeBet=0.02', { quickProfile: 'UNKNOWN', dynamicHint: 'UNKNOWN', stackBB: 55, persistentPlayerId: 'p1', observedStats: { handsObserved: 400, threeBet: 0.02 } }),
  V('S12 threeBet=0.25', { quickProfile: 'UNKNOWN', dynamicHint: 'UNKNOWN', stackBB: 55, persistentPlayerId: 'p1', observedStats: { handsObserved: 400, threeBet: 0.25 } }),
  V('S13 pfr=0.04', { quickProfile: 'UNKNOWN', dynamicHint: 'UNKNOWN', stackBB: 55, persistentPlayerId: 'p1', observedStats: { handsObserved: 400, pfr: 0.04 } }),
  V('S14 pfr=0.55', { quickProfile: 'UNKNOWN', dynamicHint: 'UNKNOWN', stackBB: 55, persistentPlayerId: 'p1', observedStats: { handsObserved: 400, pfr: 0.55 } }),
  // 样本量扫描（同一极端统计，n 变化）
  V('N1 foldToRiverBet=1.0 n=1', { quickProfile: 'UNKNOWN', dynamicHint: 'UNKNOWN', stackBB: 55, persistentPlayerId: 'p1', observedStats: { handsObserved: 1, foldToRiverBet: 1.0 } }),
  V('N2 foldToRiverBet=1.0 n=20', { quickProfile: 'UNKNOWN', dynamicHint: 'UNKNOWN', stackBB: 55, persistentPlayerId: 'p1', observedStats: { handsObserved: 20, foldToRiverBet: 1.0 } }),
  V('N3 foldToRiverBet=1.0 n=400', { quickProfile: 'UNKNOWN', dynamicHint: 'UNKNOWN', stackBB: 55, persistentPlayerId: 'p1', observedStats: { handsObserved: 400, foldToRiverBet: 1.0 } }),
  V('N4 foldToRiverBet=1.0 n=100000', { quickProfile: 'UNKNOWN', dynamicHint: 'UNKNOWN', stackBB: 55, persistentPlayerId: 'p1', observedStats: { handsObserved: 100000, foldToRiverBet: 1.0 } }),
  V('N5 全维度极端 n=100000', { quickProfile: 'UNKNOWN', dynamicHint: 'UNKNOWN', stackBB: 55, persistentPlayerId: 'p1', observedStats: { handsObserved: 100000, vpip: 0.95, pfr: 0.9, threeBet: 0.5, wtsd: 0.9, foldToRiverBet: 0.99, riverCheckRaise: 0.8, flopCheckRaise: 0.5, turnCheckRaise: 0.5, foldToFlopCbet: 0.9, foldToTurnCbet: 0.9 } }),
  // 标签 + 实测冲突（实测应优先）
  V('L1 标签=VERY_TIGHT（无实测）', { quickProfile: 'VERY_TIGHT', dynamicHint: 'UNKNOWN', stackBB: 55, persistentPlayerId: 'p1' }),
  V('L2 标签=VERY_TIGHT + 实测=极松', { quickProfile: 'VERY_TIGHT', dynamicHint: 'UNKNOWN', stackBB: 55, persistentPlayerId: 'p1', observedStats: { handsObserved: 100000, vpip: 0.95, pfr: 0.9, wtsd: 0.9, foldToRiverBet: 0.99 } }),
];

const n = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const f2 = (x: unknown): string => (n(x) === null ? ' —  ' : n(x)!.toFixed(4));

console.log('=== 单统计敏感度（每行一个变体；弃/跟/加 = 对该尺寸下注的响应概率）===');
console.log('变体'.padEnd(34) + '│快照样本 快照置信 neutral│范围conf 范围指纹│小注 弃/跟/加        │全下 弃/跟/加        │过牌EV  全下EV  │动作@金额');
let rangeKeyPrinted = false;
const rangeFp = new Map<string, string>();
for (const v of VARIANTS) {
  const input = {
    tableSize: 9, heroPosition: 'BTN', heroCards: ['As', 'Ks'],
    board: ['Jh', '8s', 'Qs', 'Kh', 'Kd'], street: 'RIVER',
    effectiveStackBB: 55, bigBlindBB: BB,
    seatStacksBB: { UTG: START, UTG1: 100, UTG2: 100, LJ: 100, HJ: 100, CO: START, BTN: START, SB: 100, BB: 100 },
    actionHistory: HISTORY, environment: 'MID_LOW_STAKES', villain: v.villain,
  };
  const r = analyzeManualHand(input as never, OPTIONS);
  if (!r.ok) { console.log(`${v.id.padEnd(34)}│ 拒绝：${r.stage}`); continue; }
  const d = r.decision as unknown as Record<string, any>;
  const dg = d['diagnostics'] as Record<string, any>;
  const bd = dg['betDecision'] as Record<string, any> | null;
  const p = (dg['player'] ?? {}) as Record<string, any>;
  const range = (dg['range'] ?? {}) as Record<string, any>;
  const shape = (dg['actionShape'] ?? {}) as Record<string, any>;
  if (!rangeKeyPrinted) { console.log(`  [range 字段] ${Object.keys(range).join(', ')}`); rangeKeyPrinted = true; }
  const small = bd === null ? null : ((bd['sizes'] as readonly Record<string, any>[]).find((s) => s['kind'] === 'BET_SMALL') ?? null);
  const allIn = bd === null ? null : ((bd['sizes'] as readonly Record<string, any>[]).find((s) => s['kind'] === 'ALL_IN') ?? null);
  /** 完整范围的稳定指纹（对 metrics 做字符串 hash；与 confidence 无关） */
  const metrics = (range['metrics'] ?? null) as unknown;
  const metricsText = JSON.stringify(metrics) ?? '';
  let h = 0;
  for (let i = 0; i < metricsText.length; i += 1) h = (h * 31 + metricsText.charCodeAt(i)) % 1_000_003;
  const rangeSig = `${String(range['sourceKind'])}|sup=${String(range['supportSize'])}|share=${f2(range['supportShare']).trim()}|collapsed=${String(range['collapsed'])}|metrics#${h}`;
  rangeFp.set(v.id, rangeSig);
  console.log(
    v.id.padEnd(34) + '│' +
    String(p['handsObserved'] ?? '—').padStart(8) + ' ' + f2(p['confidence']).trim().padStart(8) + ' ' + String(p['neutralized'] ?? '—').padStart(7) + '│' +
    f2(range['confidence']).trim().padStart(8) + ' ' + rangeSig + '│' +
    `${f2(small?.['foldLikelihood'])}/${f2(small?.['callLikelihood'])}/${f2(small?.['raiseLikelihood'])}│` +
    `${f2(allIn?.['foldLikelihood'])}/${f2(allIn?.['callLikelihood'])}/${f2(allIn?.['raiseLikelihood'])}│` +
    `${f2(bd?.['checkEV']).trim().padStart(7)} ${f2(allIn?.['betEV']).trim().padStart(7)} │` +
    `${String(d['action'])}@${String(shape['sizeChips'])}`,
  );
}
const uniqRange = new Set(rangeFp.values());
console.log(`\n对手范围指纹（忽略 confidence）唯一值个数 = ${uniqRange.size} / ${rangeFp.size} ⇒ ${uniqRange.size === 1 ? '**全部变体的范围逐位相同**' : '存在差异'}`);
console.log('（探针结束）');
