/**
 * ============================================================================
 * 翻前加注决策（阶段 A/B）· 参数敏感性与误差披露探针
 * ============================================================================
 *
 * 回答使用者第七节 / 第十九节的两个问题：
 *
 * 1. **参数敏感性**：改变合理假设后，推荐动作或尺寸是否变化？
 * 2. **权益采样误差可能导致动作翻转吗**？
 *
 * ## 为什么可以在同一条公式上扫参数（而不是复制一份公式）
 *
 * `preflopRaiseResponse.PREFLOP_RAISE_TUNING` 是可注入的显式调参对象，
 * 默认值 = 生产常数。探针显式传入被扫的值 ⇒ **同一份代码、同一条公式**，
 * 因此这份敏感度报告证明的就是生产路径本身。
 *
 * ## 输出
 *
 * `reports/evidence/preflop-raise-sensitivity.txt`（可复现证据）
 *
 * 运行：`node --experimental-strip-types scripts/rr-sensitivity.ts`
 */

import { writeFileSync, mkdirSync } from 'node:fs';

import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import { parseManualInput, type ManualHandInput } from '../src/app/manualInput/manualInput.ts';
import {
  PREFLOP_RAISE_TUNING,
  preflopStrengthOf,
  type PreflopRaiseTuning,
} from '../src/app/manualInput/preflopRaiseResponse.ts';
import { buildPreflopRaiseFacts, arrivalEntriesOf } from '../src/app/manualInput/preflopRaiseFacts.ts';
import { neutralResponseTendencies } from '../src/domain/postflop/betResponse.ts';
import { computeEquity } from '../src/domain/poker/equity.ts';
import { EquityComputeMode } from '../src/domain/poker/equity.types.ts';
import { ALL_CARDS } from '../src/domain/types.ts';
import { deriveLegalActions } from '../src/app/manualInput/legalActions.ts';
import { buildRangeFromRankClasses } from '../src/domain/range/range.ts';
import { RangeSource } from '../src/domain/range/range.types.ts';
import { rfiWeightsByHandedness } from '../src/app/manualInput/preflopPriors.ts';
import type { GameState } from '../src/domain/poker/gameState.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const OPTIONS = {
  rules: RULES,
  asOf: 1_757_000_000_000,
  writeLog: false,
  equitySeed: 20_260_913,
  budget: { softMs: 300_000, hardMs: 600_000 },
} as const;

const out: string[] = [];
const line = (s = ''): void => {
  out.push(s);
  console.log(s);
};

const HANDS: readonly (readonly [string, readonly [string, string]])[] = [
  ['AA', ['As', 'Ah']],
  ['AKs', ['As', 'Ks']],
  ['QQ', ['Qs', 'Qh']],
  ['76s', ['7d', '6d']],
  ['Q9o', ['Qh', '9c']],
];

function bbVsBtnInput(heroCards: readonly [string, string], openBB = 2.5, stackBB = 100): ManualHandInput {
  return {
    tableSize: 6,
    heroPosition: 'BB',
    heroCards: [...heroCards],
    board: [],
    street: 'PREFLOP',
    effectiveStackBB: stackBB,
    bigBlindBB: 100,
    seatStacksBB: { UTG: stackBB, HJ: stackBB, CO: stackBB, BTN: stackBB, SB: stackBB, BB: stackBB },
    actionHistory: [
      { position: 'UTG', type: 'FOLD', street: 'PREFLOP' },
      { position: 'HJ', type: 'FOLD', street: 'PREFLOP' },
      { position: 'CO', type: 'FOLD', street: 'PREFLOP' },
      { position: 'BTN', type: 'RAISE', amountBB: openBB, street: 'PREFLOP' },
      { position: 'SB', type: 'FOLD', street: 'PREFLOP' },
    ],
    environment: 'MID_LOW_STAKES',
    villain: { quickProfile: 'NORMAL', dynamicHint: 'UNKNOWN', stackBB },
  } as unknown as ManualHandInput;
}

function runOf(input: ManualHandInput, options: Record<string, unknown> = {}): Record<string, any> | null {
  const r = analyzeManualHand(input, { ...OPTIONS, ...options } as never);
  if (!r.ok) return null;
  return r.decision as unknown as Record<string, any>;
}

function stateOf(input: ManualHandInput): GameState | null {
  const parsed = parseManualInput(input);
  if (!parsed.ok) return null;
  const gate = buildAnalyzableState(parsed.value);
  return gate.ok ? gate.state : null;
}

function arrivalOf(state: GameState) {
  const opener = state.players.find((p) => p.id !== state.userPlayerId && !p.folded);
  if (opener === undefined) return [];
  const built = buildRangeFromRankClasses(rfiWeightsByHandedness(opener.position), {
    provenance: {
      sourceId: 'heuristic.preflop-rfi.v1',
      sourceType: RangeSource.HEURISTIC,
      version: '1.0.0',
      description: 'SENSITIVITY PROBE ONLY',
      verified: false,
      confidence: 0.3,
    },
    deadCards: state.players.find((p) => p.id === state.userPlayerId)?.holeCards ?? [],
  });
  return built.ok ? arrivalEntriesOf(built.value) : [];
}

/** 在**同一条公式**上带调参跑一次事实包 */
function factsWith(state: GameState, tuning: PreflopRaiseTuning): Record<string, any> | null {
  const hero = state.players.find((p) => p.id === state.userPlayerId)!;
  const opponent = state.players.find((p) => p.id !== state.userPlayerId && !p.folded)!;
  const legal = deriveLegalActions(state, hero);
  const built = buildPreflopRaiseFacts({
    state,
    hero,
    opponent,
    legal,
    arrivalEntries: arrivalOf(state),
    arrivalSource: 'SENSITIVITY_PROBE',
    range: null,
    tendencies: neutralResponseTendencies(),
    playersRemainingToAct: 0,
    seed: 20_260_913,
    tuning,
    equityOf: (entries, seedOffset) => {
      if (entries.length === 0) {
        return { value: null, method: 'NOT_AVAILABLE', iterations: 0, confidenceHalfWidth: null };
      }
      const outcome = computeEquity(
        [hero.holeCards![0]!, hero.holeCards![1]!],
        [],
        [{
          label: '条件范围',
          combos: entries.map((e) => [ALL_CARDS[e.cardIndices[0]]!, ALL_CARDS[e.cardIndices[1]]!] as const),
        }],
        {
          mode: EquityComputeMode.FAST,
          seed: 20_260_913 + seedOffset,
          iterations: 6000,
          opponentWeights: [entries.map((e) => e.probability)],
        },
      );
      if (!outcome.ok) return { value: null, method: 'NOT_AVAILABLE', iterations: 0, confidenceHalfWidth: null };
      return {
        value: outcome.result.equity,
        method: outcome.result.method === 'EXACT' ? 'EXACT' : 'MONTE_CARLO',
        iterations: outcome.result.iterations,
        confidenceHalfWidth: null,
      };
    },
  });
  return built.ok ? (built.facts as unknown as Record<string, any>) : null;
}

/** 事实包里 EV 最高的尺寸（与决策层同一个判据：`raiseEV` 最大） */
function bestSizeOf(facts: Record<string, any>): { sizeBB: number; ev: number; fold: number; call: number; rr: number } | null {
  let best: Record<string, any> | null = null;
  for (const s of (facts['sizes'] as readonly Record<string, any>[]) ?? []) {
    if (s['raiseEV'] === null) continue;
    if (best === null || (s['raiseEV'] as number) > (best['raiseEV'] as number)) best = s;
  }
  if (best === null) return null;
  return {
    sizeBB: best['sizeBB'] as number,
    ev: best['raiseEV'] as number,
    fold: best['foldLikelihood'] as number,
    call: best['callLikelihood'] as number,
    rr: best['reRaiseLikelihood'] as number,
  };
}

/* ============================================================
 * 输出
 * ============================================================ */

line('='.repeat(84));
line('翻前加注决策（阶段 A/B）· 参数敏感性与误差披露');
line('='.repeat(84));
line('');
line(`生产默认调参（\`PREFLOP_RAISE_TUNING\`）：`);
line(`  continueMargin          = ${PREFLOP_RAISE_TUNING.continueMargin}`);
line(`  reRaiseGate             = ${PREFLOP_RAISE_TUNING.reRaiseGate}`);
line(`  reRaiseValueThreshold   = ${PREFLOP_RAISE_TUNING.reRaiseValueThreshold}`);
line(`  reRaiseMaxShare         = ${PREFLOP_RAISE_TUNING.reRaiseMaxShare}`);
line(`  reRaiseValueFloor       = ${PREFLOP_RAISE_TUNING.reRaiseValueFloor}`);
line('');

/* ---- 1. 起点 ---- */
line('--- 1. 默认参数下的起点输出（生产管线 `analyzeManualHand`） ---');
for (const [tag, cards] of HANDS) {
  const d = runOf(bbVsBtnInput(cards));
  if (d === null) {
    line(`  ${tag.padEnd(5)} 分析失败`);
    continue;
  }
  const pr = (d['diagnostics'] as Record<string, any>)['preflopRaise'] as Record<string, any> | null;
  const sizes = pr === null
    ? []
    : (pr['sizes'] as readonly Record<string, any>[]).map(
      (s) => `${s['sizeBB']}BB:${s['raiseEV'] === null ? '—' : (s['raiseEV'] as number).toFixed(1)}`,
    );
  line(
    `  ${tag.padEnd(5)} 建议 ${String(d['action']).padEnd(6)} ${String(d['sizeBB'] ?? '-').padStart(6)}BB` +
    `｜候选 EV(raise-to) ${sizes.join(' ')}`,
  );
}
line('');

/* ---- 2. 权益采样误差 ---- */
line('--- 2. 权益采样误差：换随机种子（同一份输入、同一套参数） ---');
line('    说明：每个尺寸的条件权益是 6,000 次蒙特卡洛估计（与 U1 同口径）。');
line('    若不同种子给出不同建议 ⇒ 该节点的结论落在采样噪声之内。');
for (const [tag, cards] of HANDS) {
  const rows: string[] = [];
  for (const seed of [20_260_913, 20_260_914, 777, 123_456, 999_999]) {
    const d = runOf(bbVsBtnInput(cards), { equitySeed: seed });
    rows.push(d === null ? 'FAIL' : `${String(d['action'])}@${String(d['sizeBB'] ?? '-')}`);
  }
  const unique = new Set(rows);
  line(`  ${tag.padEnd(5)} ${rows.join(' | ')}${unique.size > 1 ? '   ← ⚠️ 种子改变了建议' : '   （五个种子一致）'}`);
}
line('');

/* ---- 3. 继续门槛余量 ---- */
const stateAA = stateOf(bbVsBtnInput(['As', 'Ah']));
line('--- 3a. 继续门槛余量 `continueMargin`（生产默认见上方） ---');
line('    它决定「他跟不跟」：门槛 = 价格 + 余量。');
line('    下表 = 每个 margin 下、每个手牌节点的**最高 EV 尺寸**（EV 单位：筹码；底池 400）。');
line(`    ${'margin'.padEnd(8)}${HANDS.map(([t]) => t.padEnd(22)).join('')}`);
for (const margin of [0.0, 0.06, 0.09, 0.12, 0.18, 0.24]) {
  const cells: string[] = [];
  for (const [, cards] of HANDS) {
    const st = stateOf(bbVsBtnInput(cards));
    if (st === null) {
      cells.push('FAIL'.padEnd(22));
      continue;
    }
    const facts = factsWith(st, { ...PREFLOP_RAISE_TUNING, continueMargin: margin });
    const best = facts === null ? null : bestSizeOf(facts);
    cells.push(
      (best === null ? '（无 EV）' : `${best.sizeBB.toFixed(1)}BB EV ${best.ev.toFixed(1)}`).padEnd(22),
    );
  }
  line(`    ${margin.toFixed(2).padEnd(8)}${cells.join('')}`);
}
line('');

/* ---- 4. 4Bet 闸门 ---- */
line('--- 4. 再加注闸门 `reRaiseGate`（默认 0.44） ---');
line('    它决定「他会不会 4Bet」（进而决定被再加注分支的权重与收益）。');
line(`    ${'gate'.padEnd(8)}${HANDS.map(([t]) => t.padEnd(22)).join('')}`);
for (const gate of [0.3, 0.38, 0.44, 0.52, 0.6, 0.7]) {
  const cells: string[] = [];
  for (const [, cards] of HANDS) {
    const st = stateOf(bbVsBtnInput(cards));
    if (st === null) {
      cells.push('FAIL'.padEnd(22));
      continue;
    }
    const facts = factsWith(st, { ...PREFLOP_RAISE_TUNING, reRaiseGate: gate });
    const best = facts === null ? null : bestSizeOf(facts);
    cells.push(
      (best === null
        ? '（无 EV）'
        : `${best.sizeBB.toFixed(1)}BB EV ${best.ev.toFixed(1)} rr${(best.rr * 100).toFixed(0)}%`).padEnd(22),
    );
  }
  line(`    ${gate.toFixed(2).padEnd(8)}${cells.join('')}`);
}
line('');

/* ---- 5. 开池尺寸 / 筹码深度 ---- */
line('--- 5. 开池尺寸 × 筹码深度（默认参数） ---');
line(`    ${'开池/深度'.padEnd(12)}${HANDS.map(([t]) => t.padEnd(22)).join('')}`);
for (const openBB of [2, 2.5, 3, 4]) {
  const cells: string[] = [];
  for (const [, cards] of HANDS) {
    const st = stateOf(bbVsBtnInput(cards, openBB));
    const facts = st === null ? null : factsWith(st, PREFLOP_RAISE_TUNING);
    const best = facts === null ? null : bestSizeOf(facts);
    cells.push((best === null ? '（无 EV）' : `${best.sizeBB.toFixed(1)}BB EV ${best.ev.toFixed(1)}`).padEnd(22));
  }
  line(`    ${`开 ${openBB}BB`.padEnd(12)}${cells.join('')}`);
}
for (const stackBB of [20, 40, 100, 200]) {
  const cells: string[] = [];
  for (const [, cards] of HANDS) {
    const st = stateOf(bbVsBtnInput(cards, 2.5, stackBB));
    const facts = st === null ? null : factsWith(st, PREFLOP_RAISE_TUNING);
    const best = facts === null ? null : bestSizeOf(facts);
    cells.push((best === null ? '（无 EV）' : `${best.sizeBB.toFixed(1)}BB EV ${best.ev.toFixed(1)}`).padEnd(22));
  }
  line(`    ${`${stackBB}BB 深`.padEnd(12)}${cells.join('')}`);
}
line('');

/* ---- 6. 强度阶梯锚点 ---- */
line('--- 6. 强度阶梯（可独立复算；只有序关系有意义） ---');
for (const key of ['AA', 'KK', 'QQ', 'JJ', 'TT', '99', '88', '77', '66', '55', '44', '33', '22', 'AKs', 'AKo', 'AQs', 'KQs', 'A5s', '76s', '54s', '32o']) {
  line(`    ${key.padEnd(4)} ${preflopStrengthOf(key).toFixed(4)}`);
}
line('');
void stateAA;

/* ---- 7. 误差披露（分列三类，不合并） ---- */
line('--- 7. 误差披露（三类必须分列，不得互相冒充） ---');
line('  ① 权益采样误差：每个条件范围权益是 6,000 次蒙特卡洛估计；');
line('     其 95% 置信区间半宽随样本给出（诊断里是 `confidenceHalfWidth`）。');
line('     ⚠️ 它**只**描述「给定范围下的胜率估计有多准」，');
line('     不代表整个策略模型的可靠性。');
line('  ② 响应概率的模型误差：**未校准的结构性先验**，本项目**没有**它的置信区间，');
line('     因此不能给出「P(他跟注) = 0.35 ± 0.04」这种说法 —— 只能说 0.35 是模型值。');
line('  ③ 未来街近似误差：非全下分支按「打到摊牌、后续街不再下注」计算；');
line('     全下分支没有未来街 ⇒ 精确。两类在 `assumptionsZh` 里逐尺寸分别标注。');
line('  ⚠️ 抽样置信区间**不能**代表整个策略模型的可靠性 —— 两者不是同一个量。');
line('');

mkdirSync('reports/evidence', { recursive: true });
writeFileSync('reports/evidence/preflop-raise-sensitivity.txt', `${out.join('\n')}\n`, 'utf8');
console.log('\n✔ 已写入 reports/evidence/preflop-raise-sensitivity.txt');
