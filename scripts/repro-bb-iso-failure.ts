/*
 * 最小复现：**SB 平跟、BB 加注隔离 ⇒ 翻牌 BB 下注** —— 引擎整条分析失败。
 *
 * 现场（真实牌局 455 手里的 40 个节点，形态完全一致）：
 *
 * ```text
 * 翻前 [UTG弃 HJ弃 CO弃 BTN弃 SB跟注 BB加注 SB跟注]  街=FLOP  我=SB
 * ⇒ CONTEXT_BUILD_FAILED: rfiTierByPositionName: 「BB」没有开池范围 ——
 *    大盲位不能开池，请改用 3Bet / 防守范围
 * ```
 *
 * 6 人桌真实牌局里这是**很常见的局面**（SB 平跟进池、BB 用加注隔离）。
 */
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { loadKnowledgeBase } from '../src/domain/knowledge/knowledgeLoader.ts';
import type { ManualHandInput } from '../src/app/manualInput/manualInput.ts';

const knowledge = loadKnowledgeBase();
if (!knowledge.ok) throw new Error('知识库加载失败');
const rules = knowledge.index.allRules();

const base = {
  tableSize: 6 as const,
  board: ['7s', '9c', 'Tc'] as readonly string[],
  street: 'FLOP' as never,
  effectiveStackBB: 100,
  environment: 'MID_LOW_STAKES' as never,
  bigBlindBB: 100,
  buttonPosition: 'BTN' as never,
  seatStacksBB: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 },
};

/**
 * 场景 A：**真实牌局 `105/27.phh` 的原样输入**（金额逐字来自该手记录，未手改）。
 *
 * 这是 455 手里 40 个失败节点的共同形态。
 */
const scenarioA: ManualHandInput = {
  tableSize: 6 as const,
  heroPosition: 'SB' as never,
  heroCards: ['Ts', 'Jh'] as readonly [string, string],
  board: ['Kc', '4s', 'Qs'] as readonly string[],
  street: 'FLOP' as never,
  effectiveStackBB: 95.5,
  actionHistory: [
    { position: 'UTG', type: 'FOLD', street: 'PREFLOP' },
    { position: 'HJ', type: 'FOLD', street: 'PREFLOP' },
    { position: 'CO', type: 'FOLD', street: 'PREFLOP' },
    { position: 'BTN', type: 'FOLD', street: 'PREFLOP' },
    { position: 'SB', type: 'CALL', amountBB: 0.5, street: 'PREFLOP' },
    { position: 'BB', type: 'RAISE', amountBB: 4.5, street: 'PREFLOP' },
    { position: 'SB', type: 'CALL', amountBB: 3.5, street: 'PREFLOP' },
  ] as never,
  environment: 'MID_LOW_STAKES' as never,
  bigBlindBB: 100,
  seatStacksBB: { SB: 95.5, BB: 95.5 },
  buttonPosition: 'BTN' as never,
};

/** 场景 B：对照 —— BTN 开池、BB 跟注 ⇒ 翻牌 BB 下注（**应当正常工作**） */
const scenarioB: ManualHandInput = {
  ...base,
  heroPosition: 'BB' as never,
  heroCards: ['Ah', 'Kd'] as readonly [string, string],
  actionHistory: [
    { position: 'UTG', type: 'FOLD', street: 'PREFLOP' },
    { position: 'HJ', type: 'FOLD', street: 'PREFLOP' },
    { position: 'CO', type: 'FOLD', street: 'PREFLOP' },
    { position: 'BTN', type: 'RAISE', amountBB: 2.5, street: 'PREFLOP' },
    { position: 'SB', type: 'FOLD', street: 'PREFLOP' },
    { position: 'BB', type: 'CALL', amountBB: 1.5, street: 'PREFLOP' },
  ] as never,
};

/** 场景 C：对照 —— 翻前**无人加注**（全员平跟）⇒ 翻牌 **SB** 下注（C1-A 已修） */
const scenarioC: ManualHandInput = {
  ...base,
  heroPosition: 'SB' as never,
  heroCards: ['Ts', 'Jh'] as readonly [string, string],
  actionHistory: [
    { position: 'UTG', type: 'CALL', amountBB: 1, street: 'PREFLOP' },
    { position: 'HJ', type: 'CALL', amountBB: 1, street: 'PREFLOP' },
    { position: 'CO', type: 'FOLD', street: 'PREFLOP' },
    { position: 'BTN', type: 'CALL', amountBB: 1, street: 'PREFLOP' },
    { position: 'SB', type: 'CALL', amountBB: 0.5, street: 'PREFLOP' },
    { position: 'BB', type: 'CHECK', street: 'PREFLOP' },
  ] as never,
};

/** 场景 D：对照 —— **把翻前的 BB 加注换成 CO 加注**，其余局面等价 ⇒ 应当正常 */
const scenarioD: ManualHandInput = {
  ...base,
  heroPosition: 'SB' as never,
  heroCards: ['Ts', 'Jh'] as readonly [string, string],
  actionHistory: [
    { position: 'UTG', type: 'FOLD', street: 'PREFLOP' },
    { position: 'HJ', type: 'FOLD', street: 'PREFLOP' },
    { position: 'CO', type: 'RAISE', amountBB: 4.5, street: 'PREFLOP' },
    { position: 'BTN', type: 'FOLD', street: 'PREFLOP' },
    { position: 'SB', type: 'CALL', amountBB: 4, street: 'PREFLOP' },
    { position: 'BB', type: 'FOLD', street: 'PREFLOP' },
  ] as never,
};

const cases: [string, ManualHandInput][] = [
  ['A 真实牌局 105/27：SB平跟→**BB**隔离加注→SB跟注 ⇒ 翻牌 SB 行动（**失败的那个**）', scenarioA],
  ['B BTN开池→BB跟注 ⇒ 翻牌 BB 下注（对照：应当正常）', scenarioB],
  ['C 全员平跟的跛入池 ⇒ 翻牌 SB 下注（对照：应当正常）', scenarioC],
  ['D 同上，但翻前加注者是 **CO** 而非 BB（对照：应当正常）', scenarioD],
];

for (const [name, input] of cases) {
  const r = analyzeManualHand(input, { rules, writeLog: false, equitySeed: 1 });
  console.log(`\n=== ${name} ===`);
  console.log(`  引擎 ok = ${r.ok}`);
  if (!r.ok) {
    console.log(`  ✖ stage=${r.stage}`);
    for (const i of r.issues.slice(0, 3)) console.log(`     ${i.code}: ${i.message}`);
  } else {
    console.log(
      `  ✅ ${r.decision.action} ${r.decision.sizeBB === undefined ? '' : `${r.decision.sizeBB.toFixed(2)}BB`} ` +
        `| 置信 ${r.decision.confidence.toFixed(3)} | 底池 ${r.computedPot}`,
    );
  }
}
