/**
 * M1 分解探针（只读）—— 用于把「实测统计」在**面对下注节点**上的影响
 * 拆成 P1（响应刻度）与 P2（下注范围带速率）。
 *
 * 本文件在**仓库副本**里配合 `M1_FREEZE_BAND` 环境变量使用：
 *   - 副本中把 `contextBuilder.ts` 的「下注范围」调用点改为可冻结为旧标签实现；
 *   - `M1_FREEZE_BAND=1` ⇒ 下注范围层不消费实测（只留 P1）；
 *   - 不设 ⇒ 完整 M1（P1 + P2）。
 *
 * 主仓库内运行时只会打印**完整 M1**与**纯标签**两行（不设开关时等价生产）。
 */
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import type { ManualHandInput, ManualVillain } from '../src/app/manualInput/manualInput.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const OPTIONS = {
  rules: RULES, asOf: 1_757_000_000_000, writeLog: false,
  equitySeed: 20_260_913, budget: { softMs: 120_000, hardMs: 240_000 },
} as const;

const A_ = (position: string, type: string, amountBB?: number, street?: string): Record<string, unknown> => ({
  position, type, ...(amountBB === undefined ? {} : { amountBB }), ...(street === undefined ? {} : { street }),
});
function test16(villain: ManualVillain): ManualHandInput {
  return {
    tableSize: 6, heroPosition: 'BTN', heroCards: ['As', 'Ah'], board: ['Ad', '9c', '4h', '6s', '2d'],
    street: 'RIVER', effectiveStackBB: 100, bigBlindBB: 2,
    seatStacksBB: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 },
    actionHistory: [
      A_('UTG', 'FOLD'), A_('HJ', 'FOLD'), A_('CO', 'FOLD'),
      A_('BTN', 'RAISE', 3), A_('SB', 'FOLD'), A_('BB', 'CALL', 2),
      A_('BB', 'CHECK', undefined, 'FLOP'), A_('BTN', 'BET', 2.5, 'FLOP'), A_('BB', 'CALL', 2.5, 'FLOP'),
      A_('BB', 'CHECK', undefined, 'TURN'), A_('BTN', 'BET', 7.5, 'TURN'), A_('BB', 'CALL', 7.5, 'TURN'),
      A_('BB', 'BET', 10, 'RIVER'),
    ],
    environment: 'MID_LOW_STAKES', villain,
  } as unknown as ManualHandInput;
}

const STATS = {
  handsObserved: 800, vpip: 0.48, pfr: 0.35, threeBet: 0.16, wtsd: 0.36,
  foldToFlopCBet: null, foldToTurnCBet: null, foldToRiverBet: null,
  flopCheckRaise: null, turnCheckRaise: null, riverCheckRaise: null,
} as const;
const BASE: ManualVillain = { seatId: 'seat_BB', persistentPlayerId: 'p1', quickProfile: 'MANIAC', dynamicHint: 'UNKNOWN', stackBB: 100 };

const n = (v: unknown, d = 6): string => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : String(v));
const note = (l: string, r: Record<string, any>): void =>
  console.log(`  ${l.padEnd(26)}${r.action.padEnd(12)}${n(r.callEV, 9).padStart(15)}${n(r.raiseEV, 9).padStart(15)}${n(r.betMass, 12).padStart(15)}${n(r.fold, 6).padStart(9)}${n(r.call, 6).padStart(9)}${n(r.reRaise, 6).padStart(9)}${n(r.scales.fold, 5).padStart(8)}`);

function measure(withStats: boolean): Record<string, any> {
  const r = analyzeManualHand(test16(withStats ? { ...BASE, observedStats: STATS } : BASE), OPTIONS);
  if (!r.ok) throw new Error(`失败：${r.stage}`);
  const d = r.decision as unknown as Record<string, any>;
  const dg = d['diagnostics'] as Record<string, any>;
  const pf = (dg['postflop'] ?? {}) as Record<string, any>;
  const rr = pf['raiseResponse'] as Record<string, any>;
  const br = pf['bettingRangeFacts'] as Record<string, any>;
  const nm = String(rr?.['model']?.['noteZh'] ?? '');
  const g = (k: string): number => Number(new RegExp(`${k}\\s+([0-9.]+)`).exec(nm)?.[1] ?? NaN);
  return {
    action: `${String(d['action'])} @ ${String(d['sizeChips'])}`,
    callEV: (dg['math'] ?? {})['callEV'],
    raiseEV: rr?.['raiseEV'], betMass: br?.['betMass'],
    eqBet: (dg['math'] ?? {})['heroEquityVsBetRange'],
    eqCall: rr?.['heroEquityVsRaiseCallRange'], eqReraise: rr?.['heroEquityVsReraiseRange'],
    fold: rr?.['foldLikelihood'], call: rr?.['callLikelihood'], reRaise: rr?.['reRaiseLikelihood'],
    callCombos: rr?.['callCombos'], reRaiseCombos: rr?.['reRaiseCombos'],
    scales: { call: g('callScale'), fold: g('foldScale'), raise: g('raiseScale') },
  };
}

const frozen = process.env['M1_FREEZE_BAND'] === '1';
const plain = measure(false);
const withS = measure(true);
console.log(`\n=== M1 分解探针（M1_FREEZE_BAND=${String(process.env['M1_FREEZE_BAND'] ?? '0')}${frozen ? '：下注范围层冻结为旧标签实现' : '：完整 M1'}）===`);
console.log('  ' + '情形'.padEnd(24) + '动作'.padEnd(12) + 'CALL EV'.padStart(15) + 'RAISE EV'.padStart(15) + 'betMass'.padStart(15) + 'P(弃)'.padStart(9) + 'P(跟)'.padStart(9) + 'P(再加)'.padStart(9) + 'foldSc'.padStart(8));
note('纯标签（无统计）', plain);
note('MANIAC + 800 手统计', withS);
console.log(`\n  逐项差值（统计 − 纯标签）：`);
console.log(`    CALL EV  ${n((withS['callEV'] as number) - (plain['callEV'] as number), 9)}`);
console.log(`    RAISE EV ${n((withS['raiseEV'] as number) - (plain['raiseEV'] as number), 9)}`);
console.log(`    betMass  ${n((withS['betMass'] as number) - (plain['betMass'] as number), 12)}`);
console.log(`    EqVsBetRange ${n((withS['eqBet'] as number) - (plain['eqBet'] as number), 12)}｜EqVsRaiseCall ${n((withS['eqCall'] as number) - (plain['eqCall'] as number), 12)}｜EqVsReraise ${n((withS['eqReraise'] as number) - (plain['eqReraise'] as number), 12)}`);
console.log(`    P(弃/跟/再加) ${n((withS['fold'] as number) - (plain['fold'] as number), 6)} / ${n((withS['call'] as number) - (plain['call'] as number), 6)} / ${n((withS['reRaise'] as number) - (plain['reRaise'] as number), 6)}｜桶组合数 ${String(withS['callCombos'])} vs ${String(plain['callCombos'])}`);
console.log(`    响应刻度 fold：${n(plain['scales']['fold'], 4)} → ${n(withS['scales']['fold'], 4)}`);
console.log('');
