/**
 * 真实牌局 6：CO A♠J♠ 面对 HJ 开池 3BB（身后 BTN 激进 3bettor、BB 松凶）
 *
 * 使用者给出的局面（6-max 1/2）：UTG 弃 → HJ open 6（3BB）→ **轮到 Hero（CO A♠J♠）**
 * 对手画像（使用者描述）：
 *   HJ  ：偏松弱、喜欢跟注、翻后被动  ⇒ 映射到 `CALLING_STATION`
 *   BTN ：激进、喜欢 3bet            ⇒ 尚未行动（引擎只能提示，不能替他假设范围）
 *   BB  ：松凶、喜欢防守和施压        ⇒ 尚未行动（同上）
 *
 * 用法：`E:\node.exe --experimental-strip-types scripts/review-hand-06.ts`
 */
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';
import { deriveLegalActions } from '../src/app/manualInput/legalActions.ts';
import { parseManualInput, type ManualHandInput } from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const OPTIONS = { rules: RULES, asOf: 1_757_000_000_000, writeLog: false } as const;
const SEATS = { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 } as const;

function node(profile: string, stackBB = 100): ManualHandInput {
  return {
    tableSize: 6,
    heroPosition: 'CO',
    heroCards: ['As', 'Js'],
    board: [],
    street: 'PREFLOP',
    effectiveStackBB: stackBB,
    bigBlindBB: 2,
    seatStacksBB: { ...SEATS },
    actionHistory: [
      { position: 'UTG', type: 'FOLD' },
      { position: 'HJ', type: 'RAISE', amountBB: 3 },
    ],
    environment: 'MID_LOW_STAKES',
    villain: { quickProfile: profile, dynamicHint: 'UNKNOWN', stackBB: 100 },
  } as unknown as ManualHandInput;
}

function report(label: string, profile: string, verbose = false): void {
  const hand = node(profile);
  const result = analyzeManualHand(hand, OPTIONS);
  console.log(`\n════════ ${label} ════════`);
  if (!result.ok) {
    console.log(`  ❌ ${JSON.stringify(result.issues)}`);
    return;
  }
  const parsed = parseManualInput(hand);
  if (!parsed.ok) return;
  const g = buildAnalyzableState(parsed.value);
  if (!g.ok) return;
  const built = buildDecisionContext({
    state: g.state,
    rules: RULES,
    environment: 'MID_LOW_STAKES',
    asOf: 1_757_000_000_000,
    quickProfile: profile,
  });
  const hero = g.state.players.find((p) => p.holeCards !== null)!;
  const legal = deriveLegalActions(g.state, hero);
  const d = result.decision;
  const m = d.diagnostics.math;

  console.log(
    `  建议：${String(d.action)}${d.sizeBB === undefined ? '' : `｜尺寸 ${d.sizeBB}BB`}` +
      `｜置信度 ${d.confidence.toFixed(2)}（${d.band}）｜分类 ${d.classification}`,
  );
  console.log(
    `  底池 ${m.pot}（${(m.pot / m.bigBlind).toFixed(1)}BB）｜需补 ${m.callCost}（${(m.callCost / m.bigBlind).toFixed(1)}BB）` +
      `｜身后 ${m.myRemainingStack}（${(m.myRemainingStack / m.bigBlind).toFixed(1)}BB）｜SPR ${m.spr === null ? '—' : m.spr.toFixed(2)}` +
      `｜所需权益 ${(m.requiredEquity * 100).toFixed(1)}%`,
  );
  console.log(
    `  权益 ${m.heroEquity === null ? '—' : (m.heroEquity * 100).toFixed(1) + '%'}` +
      `｜跟注 EV ${m.callEV === null ? '—' : m.callEV.toFixed(2)} 筹码｜牌力 ${m.handRankZh}`,
  );
  const margin = d.diagnostics.decisionMargin;
  if (margin !== undefined) console.log(`  决策边际：${margin.kind ?? '—'}｜${margin.noteZh}`);
  console.log('  理由：');
  for (const reason of d.reasons) console.log(`    · [${reason.code}] ${reason.textZh}`);
  console.log(
    `  合法动作：${legal.actions.join('/')}｜跟注代价 ${legal.callCost}` +
      (legal.callIsAllIn ? '（跟注即全下）' : '') +
      `｜最小加注到 ${String((legal as unknown as Record<string, unknown>)['minRaiseToAmount'] ?? (legal as unknown as Record<string, unknown>)['minRaiseTo'] ?? '—')}`,
  );
  for (const w of built.warnings) console.log(`  ⚠️ ${w}`);
  if (verbose) {
    for (const dg of d.diagnostics.degradations) {
      console.log(`  · [降级/${dg.impact}] ${dg.textZh}`);
    }
  }
  const snap = built.context.range;
  if (snap !== null) {
    console.log(
      `  【对手范围】${snap.opponentPositionZh}｜支持集 ${snap.supportSize}｜熵 ${snap.metrics.entropyBits.toFixed(2)} bit｜来源 ${snap.sourceKind}`,
    );
    for (const t of snap.updateTrace) {
      console.log(`     · ${t.street} ${t.action}：${t.supportBefore} → ${t.supportAfter}｜熵 ${t.entropyBefore.toFixed(2)} → ${t.entropyAfter.toFixed(2)}`);
    }
  }
  const evidence = built.context.profileRangeEvidence ?? null;
  if (evidence !== null) {
    console.log(
      `  【画像链路】${evidence.dimensionTierZh}｜是否改变范围 ${String(evidence.provider.applied)}` +
        `｜权益 ${evidence.equityBefore === null ? '—' : (evidence.equityBefore * 100).toFixed(2) + '%'} → ` +
        `${evidence.equityAfter === null ? '—' : (evidence.equityAfter * 100).toFixed(2) + '%'}`,
    );
  }
  if (verbose) {
    const bd = d.diagnostics.betDecision ?? null;
    console.log(
      `  下注决策模型：${bd === null ? '—（翻前不适用）' : JSON.stringify(bd).slice(0, 120)}`,
    );
    const c = d.diagnostics.postflop;
    console.log(`  翻后快照：${c === null || c === undefined ? '—（翻前）' : '存在'}`);
    console.log(`  决策依据：${d.diagnostics.decisionBasis?.kind ?? '—'}｜${d.diagnostics.decisionBasis?.noteZh ?? ''}`);
    for (const w of result.warnings) console.log(`  ⚠️ ${w}`);
  }
}

console.log('局面：6-max 1/2｜UTG 弃｜HJ open 3BB｜Hero（CO）A♠J♠｜BTN 激进 / BB 松凶（均未行动）');
report('无画像（UNKNOWN）', 'UNKNOWN', true);
report('HJ = 偏松弱/爱跟/被动（CALLING_STATION）', 'CALLING_STATION', true);
report('HJ = 普通常客（NORMAL）', 'NORMAL');
report('HJ = 极紧（VERY_TIGHT）', 'VERY_TIGHT');
report('HJ = 疯子（MANIAC）', 'MANIAC');
