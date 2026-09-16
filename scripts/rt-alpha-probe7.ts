/**
 * rt-alpha-probe7 —— 攻击 7D：逐位确定性（全量指纹，不用固定 asOf）
 *                    + 攻击 3E：bigBlindBB 死字段的严格证明
 */

import { Position, Street } from '../src/domain/types.ts';
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import { fingerprint } from './rt-alpha-lib.ts';
import type { ManualHandInput } from '../src/app/manualInput/manualInput.ts';
import type { AnalyzeOptions } from '../src/app/alphaPipeline.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();

function base(): ManualHandInput {
  return {
    tableSize: 6,
    heroPosition: Position.BB,
    heroCards: ['As', 'Ad'],
    board: [],
    street: Street.PREFLOP,
    effectiveStackBB: 100,
    actionHistory: [
      { position: Position.UTG, type: 'FOLD' },
      { position: Position.HJ, type: 'FOLD' },
      { position: Position.CO, type: 'FOLD' },
      { position: Position.BTN, type: 'RAISE', amountBB: 3 },
      { position: Position.SB, type: 'FOLD' },
    ],
    environment: 'MID_LOW_STAKES',
  };
}

function hr(title: string): void {
  console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
}

/* ============================================================
 * 7D-1：完全不传 asOf（模拟真实的「连点两次分析按钮」）
 * ============================================================ */

function runNoAsOf(): void {
  hr('攻击 7D-1：不传 asOf（真实界面路径）→ 同一输入连跑 10 次是否逐位一致');

  const opts: AnalyzeOptions = { rules: RULES, writeLog: false }; // 不传 asOf

  const fps: string[] = [];
  const equities: string[] = [];
  const actions: string[] = [];
  const dynamics: string[] = [];

  for (let i = 0; i < 10; i++) {
    const r = analyzeManualHand(base(), opts);
    if (!r.ok) {
      console.log(`  第 ${i} 次失败 ${r.stage}`);
      continue;
    }
    // 排除耗时相关字段（时间本身不可能逐位一致）
    const fp = fingerprint({
      action: r.decision.action,
      sizeChips: r.decision.sizeChips ?? null,
      confidence: r.decision.confidence,
      band: r.decision.band,
      classification: r.decision.classification,
      math: r.decision.diagnostics.math,
      candidates: r.decision.diagnostics.candidates,
      range: r.decision.diagnostics.range,
      player: r.decision.diagnostics.player,
      dynamic: r.decision.diagnostics.dynamic,
      env: r.decision.diagnostics.environment,
      shadow: r.decision.diagnostics.shadow,
      dominance: r.decision.diagnostics.mathDominance,
    });
    fps.push(fp);
    equities.push(String(r.decision.diagnostics.math.heroEquity));
    actions.push(`${r.decision.action}@${String(r.decision.sizeChips)}`);
    dynamics.push(`${r.decision.diagnostics.dynamic.state}/${r.decision.diagnostics.dynamic.confidence}`);
  }

  const uniqFp = [...new Set(fps)];
  console.log(`  10 次运行的不同**全量**指纹数 = ${uniqFp.length}`);
  console.log(`  10 次的权益取值 = ${JSON.stringify([...new Set(equities)])}`);
  console.log(`  10 次的动作 = ${JSON.stringify([...new Set(actions)])}`);
  console.log(`  10 次的动态状态 = ${JSON.stringify([...new Set(dynamics)])}`);

  if (uniqFp.length > 1) {
    // 定位差异字段
    const parsed = uniqFp.map((f) => JSON.parse(f) as Record<string, unknown>);
    const keys = new Set(Object.keys(parsed[0]!));
    for (const k of keys) {
      const vals = new Set(parsed.map((p) => JSON.stringify(p[k])));
      if (vals.size > 1) {
        console.log(`  **差异字段 ${k}**（${vals.size} 种取值）：`);
        for (const v of vals) console.log(`     ${String(v).slice(0, 300)}`);
      }
    }
  }
}

/* ============================================================
 * 7D-2：固定 asOf，但逐次叠加真实时间
 * ============================================================ */

function runFixedAsOf(): void {
  hr('攻击 7D-2：固定 asOf → 同一输入连跑 10 次是否逐位一致');

  const opts: AnalyzeOptions = { rules: RULES, asOf: 1_757_000_000_000, writeLog: false };
  const fps: string[] = [];
  for (let i = 0; i < 10; i++) {
    const r = analyzeManualHand(base(), opts);
    if (!r.ok) continue;
    fps.push(
      fingerprint({
        action: r.decision.action,
        sizeChips: r.decision.sizeChips ?? null,
        confidence: r.decision.confidence,
        math: r.decision.diagnostics.math,
        range: r.decision.diagnostics.range,
        player: r.decision.diagnostics.player,
        dynamic: r.decision.diagnostics.dynamic,
      }),
    );
  }
  console.log(`  固定 asOf 下 10 次运行的不同指纹数 = ${new Set(fps).size}`);
}

/* ============================================================
 * 7D-3：只改余额无关字段 —— 严格证明 bigBlindBB 无效
 * ============================================================ */

function runBigBlindProof(): void {
  hr('攻击 3E：bigBlindBB 的严格证明（逐字段对比，不用模糊指纹）');

  const rows: { label: string; math: string; vmSize: string; legal: string; action: string }[] = [];
  for (const bigBlindBB of [1, 2, 10, 100, 0.01]) {
    const r = analyzeManualHand({ ...base(), bigBlindBB }, { rules: RULES, asOf: 1_757_000_000_000, writeLog: false });
    if (!r.ok) {
      rows.push({ label: String(bigBlindBB), math: `FAIL ${r.stage}`, vmSize: '-', legal: '-', action: '-' });
      continue;
    }
    const m = r.decision.diagnostics.math;
    rows.push({
      label: String(bigBlindBB),
      math:
        `pot=${m.pot} callCost=${m.callCost} stack=${m.myRemainingStack} eff=${m.effectiveStack} ` +
        `spr=${m.spr} potOdds=${m.potOdds} reqEq=${m.requiredEquity} bigBlind=${m.bigBlind}`,
      vmSize: String(r.viewModel.sizeZh),
      legal: r.decision.diagnostics.legalActions.join(','),
      action: `${r.decision.action}@${String(r.decision.sizeChips)}`,
    });
  }
  const distinctMath = new Set(rows.map((r) => r.math));
  for (const r of rows) {
    console.log(`  bigBlindBB=${r.label.padEnd(6)} ${r.action.padEnd(12)} VM=${String(r.vmSize).padEnd(20)} ${r.legal}`);
    console.log(`      ${r.math}`);
  }
  console.log(`  不同 math 取值数 = ${distinctMath.size}（固定 asOf 后应为 1，否则说明 bigBlindBB 真的有效）`);
  console.log(`  结论：${distinctMath.size === 1 ? 'bigBlindBB 对输出**完全无效**（死字段）' : 'bigBlindBB 有实际影响'}`);

  hr('攻击 3E-2：bigBlindBB 非法值时是否被阻断（可证明它至少被读了）');
  for (const v of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const r = analyzeManualHand(
      { ...base(), bigBlindBB: v },
      { rules: RULES, asOf: 1_757_000_000_000, writeLog: false },
    );
    console.log(`  bigBlindBB=${String(v).padEnd(6)} → ${r.ok ? 'ok（未阻断）' : `阻断 ${r.stage}: ${r.issues.map((i) => i.code).join(',')}`}`);
  }
}

/* ============================================================
 * 7D-4：动态层时间戳是否随真实时间漂移（影响决策吗）
 * ============================================================ */

function runDynamicTimestampDrift(): void {
  hr('攻击 7D-4：动态事件时间戳基于 asOf —— asOf 变化是否影响决策');

  const results: { asOf: number; state: string; conf: number; deviation: number; action: string; confidence: number }[] = [];
  for (const offsetMs of [0, 60_000, 3_600_000, 86_400_000, 30 * 86_400_000]) {
    const asOf = 1_757_000_000_000 + offsetMs;
    const r = analyzeManualHand(
      { ...base(), villain: { quickProfile: 'NORMAL', dynamicHint: 'TILT_SIGNAL' } },
      { rules: RULES, asOf, writeLog: false },
    );
    if (!r.ok) continue;
    results.push({
      asOf,
      state: r.decision.diagnostics.dynamic.state,
      conf: r.decision.diagnostics.dynamic.confidence,
      deviation: r.decision.diagnostics.dynamic.deviationScore,
      action: r.decision.action,
      confidence: r.decision.confidence,
    });
  }
  for (const x of results) {
    console.log(
      `  asOf=+${String(x.asOf - 1_757_000_000_000).padStart(12)}ms → 动态状态=${x.state} conf=${x.conf.toFixed(4)} ` +
        `偏离分=${x.deviation} 动作=${x.action} 决策置信度=${x.confidence.toFixed(4)}`,
    );
  }
}

/* ============================================================
 * main
 * ============================================================ */

runNoAsOf();
runFixedAsOf();
runBigBlindProof();
runDynamicTimestampDrift();
