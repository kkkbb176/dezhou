/**
 * 独立红队探针公共库（rt-alpha）
 *
 * 刻意**不复用** test/helpers.ts —— 独立审计要有自己的夹具，
 * 否则会继承作者夹具里的隐含假设。
 */

import { Position, Street } from '../src/domain/types.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import { analyzeManualHand, type AnalyzeOptions } from '../src/app/alphaPipeline.ts';
import type { ManualHandInput } from '../src/app/manualInput/manualInput.ts';
import type { MathSnapshot } from '../src/domain/decision/decision.types.ts';

export const RULES = loadKnowledgeBaseOrThrow().allRules();

export const OPTS: AnalyzeOptions = {
  rules: RULES,
  asOf: 1_757_000_000_000,
  writeLog: false,
};

export type Scenario = ManualHandInput;

/** 6 人桌翻牌前：UTG...BB 全弃牌到 BTN，BTN 开池 3BB，SB 弃牌，BB 跟注 → 轮到 BTN 之后的翻牌 */
export function preflopHeroRaiseBbCall(): Scenario {
  return {
    tableSize: 6,
    heroPosition: Position.CO,
    heroCards: ['As', 'Kd'],
    board: [],
    street: Street.PREFLOP,
    effectiveStackBB: 100,
    actionHistory: [
      { position: Position.UTG, type: 'FOLD' },
      { position: Position.HJ, type: 'FOLD' },
      { position: Position.CO, type: 'RAISE', amountBB: 3 },
      { position: Position.BTN, type: 'FOLD' },
      { position: Position.SB, type: 'FOLD' },
      // 到这里队列应为 BB；BB 跟注 2 后本街结束
    ],
    environment: 'MID_LOW_STAKES',
  };
}

/** 翻牌：Hero 在 CO 持 AKo，K 高翻牌，BB 过牌 → 轮到 Hero */
export function flopTopPair(): Scenario {
  return {
    tableSize: 6,
    heroPosition: Position.CO,
    heroCards: ['As', 'Kd'],
    board: ['Kh', '7c', '2d'],
    street: Street.FLOP,
    effectiveStackBB: 100,
    actionHistory: [
      { position: Position.UTG, type: 'FOLD' },
      { position: Position.HJ, type: 'FOLD' },
      { position: Position.CO, type: 'RAISE', amountBB: 3 },
      { position: Position.BTN, type: 'FOLD' },
      { position: Position.SB, type: 'FOLD' },
      { position: Position.BB, type: 'CALL', amountBB: 2 },
      { position: Position.BB, type: 'CHECK', street: Street.FLOP },
    ],
    environment: 'MID_LOW_STAKES',
  };
}

/** 河牌：Hero CO，BB 下注 10BB → 轮到 Hero 面对下注 */
export function riverFacingBet(): Scenario {
  return {
    tableSize: 6,
    heroPosition: Position.CO,
    heroCards: ['As', 'Kd'],
    board: ['Kh', '7c', '2d', '3s', '9h'],
    street: Street.RIVER,
    effectiveStackBB: 100,
    actionHistory: [
      { position: Position.UTG, type: 'FOLD' },
      { position: Position.HJ, type: 'FOLD' },
      { position: Position.CO, type: 'RAISE', amountBB: 3 },
      { position: Position.BTN, type: 'FOLD' },
      { position: Position.SB, type: 'FOLD' },
      { position: Position.BB, type: 'CALL', amountBB: 2 },
      { position: Position.BB, type: 'CHECK', street: Street.FLOP },
      { position: Position.CO, type: 'CHECK', street: Street.FLOP },
      { position: Position.BB, type: 'CHECK', street: Street.TURN },
      { position: Position.CO, type: 'CHECK', street: Street.TURN },
      { position: Position.BB, type: 'BET', amountBB: 10, street: Street.RIVER },
    ],
    environment: 'MID_LOW_STAKES',
  };
}

/** 转牌：Hero CO，BB 过牌 → 轮到 Hero */
export function turnTopPair(): Scenario {
  return {
    tableSize: 6,
    heroPosition: Position.CO,
    heroCards: ['As', 'Kd'],
    board: ['Kh', '7c', '2d', '3s'],
    street: Street.TURN,
    effectiveStackBB: 100,
    actionHistory: [
      { position: Position.UTG, type: 'FOLD' },
      { position: Position.HJ, type: 'FOLD' },
      { position: Position.CO, type: 'RAISE', amountBB: 3 },
      { position: Position.BTN, type: 'FOLD' },
      { position: Position.SB, type: 'FOLD' },
      { position: Position.BB, type: 'CALL', amountBB: 2 },
      { position: Position.BB, type: 'CHECK', street: Street.FLOP },
      { position: Position.CO, type: 'CHECK', street: Street.FLOP },
      { position: Position.BB, type: 'CHECK', street: Street.TURN },
    ],
    environment: 'MID_LOW_STAKES',
  };
}

/** 数学九项（红队口径）—— 只取「只能来自确定性代码」的那些 */
export function mathNine(m: MathSnapshot): Record<string, unknown> {
  return {
    pot: m.pot,
    callCost: m.callCost,
    myRemainingStack: m.myRemainingStack,
    myCommittedThisStreet: m.myCommittedThisStreet,
    effectiveStack: m.effectiveStack,
    spr: m.spr,
    potOdds: m.potOdds,
    requiredEquity: m.requiredEquity,
    handCategory: m.handCategory,
    handRankZh: m.handRankZh,
    bigBlind: m.bigBlind,
    street: m.street,
  };
}

/** 全量结构指纹（用于逐位确定性对比，排除权益与耗时） */
export function fingerprint(value: unknown): string {
  const seen = new WeakSet<object>();
  const normalize = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') {
      if (typeof v === 'number' && !Number.isFinite(v)) return `__num:${String(v)}`;
      return v;
    }
    if (seen.has(v as object)) return '__cycle';
    seen.add(v as object);
    if (Array.isArray(v)) return v.map(normalize);
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(v as Record<string, unknown>).sort()) {
      out[key] = normalize((v as Record<string, unknown>)[key]);
    }
    return out;
  };
  return JSON.stringify(normalize(value));
}

export function analyze(scenario: Scenario, overrides: Partial<AnalyzeOptions> = {}) {
  return analyzeManualHand(scenario, { ...OPTS, ...overrides });
}

export function hr(title: string): void {
  console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
}

export function show(label: string, value: unknown): void {
  console.log(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
}
