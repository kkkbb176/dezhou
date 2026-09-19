/**
 * 真实牌局 7：BTN K♠Q♠ 面对三个跛入（UTG 松弱 / HJ 普通偏被动 / CO 跟注站）
 *
 * 使用者给出的局面（6-max 1/2，筹码以 Hero 与主要对手为准）：
 *   UTG limp 2｜HJ limp 2｜CO limp 2 ⇒ 底池 9 筹码（4.5BB）⇒ 轮到 Hero（BTN K♠Q♠）
 *   身后 SB（偏紧 190）、BB（普通 220）尚未行动
 *   座位筹码：UTG 180｜HJ 240｜CO 260｜Hero 300｜SB 190｜BB 220
 *
 * 用法：`E:\node.exe --experimental-strip-types scripts/review-hand-07.ts`
 */
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';
import { deriveLegalActions } from '../src/app/manualInput/legalActions.ts';
import { parseManualInput, type ManualHandInput } from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const OPTIONS = { rules: RULES, asOf: 1_757_000_000_000, writeLog: false } as const;
/** 座位筹码（**BB 单位**：使用者给的筹码数 ÷ 2；1/2 盲注） */
const STACKS = { UTG: 90, HJ: 120, CO: 130, BTN: 150, SB: 95, BB: 110 } as const;

function node(profile: string, villainPlayerId?: string): ManualHandInput {
  return {
    tableSize: 6,
    heroPosition: 'BTN',
    heroCards: ['Ks', 'Qs'],
    board: [],
    street: 'PREFLOP',
    effectiveStackBB: 150,
    bigBlindBB: 2,
    seatStacksBB: { ...STACKS },
    actionHistory: [
      { position: 'UTG', type: 'CALL', amountBB: 1 },
      { position: 'HJ', type: 'CALL', amountBB: 1 },
      { position: 'CO', type: 'CALL', amountBB: 1 },
    ],
    environment: 'MID_LOW_STAKES',
    ...(villainPlayerId === undefined ? {} : { villainPlayerId }),
    villain: { quickProfile: profile, dynamicHint: 'UNKNOWN', stackBB: 150 },
  } as unknown as ManualHandInput;
}

function report(label: string, profile: string, villainPlayerId?: string, verbose = false): void {
  const hand = node(profile, villainPlayerId);
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
    ...(villainPlayerId === undefined ? {} : { villainPlayerId }),
  });
  const hero = g.state.players.find((p) => p.holeCards !== null)!;
  const legal = deriveLegalActions(g.state, hero);
  const d = result.decision;
  const m = d.diagnostics.math;

  console.log(
    `  建议：${String(d.action)}${d.sizeBB === undefined ? '' : `｜尺寸 ${d.sizeBB}BB（${d.sizeChips} 筹码）`}` +
      `｜置信度 ${d.confidence.toFixed(2)}（${d.band}）｜分类 ${d.classification}`,
  );
  console.log(
    `  底池 ${m.pot}（${(m.pot / m.bigBlind).toFixed(1)}BB）｜需补 ${m.callCost}（${(m.callCost / m.bigBlind).toFixed(1)}BB）` +
      `｜身后 ${m.myRemainingStack}（${(m.myRemainingStack / m.bigBlind).toFixed(1)}BB）｜有效筹码 ${m.effectiveStack}` +
      `｜SPR ${m.spr === null ? '—' : m.spr.toFixed(2)}｜所需权益 ${(m.requiredEquity * 100).toFixed(1)}%`,
  );
  console.log(
    `  权益 ${m.heroEquity === null ? '—' : (m.heroEquity * 100).toFixed(1) + '%'}` +
      `｜跟注 EV ${m.callEV === null ? '—' : m.callEV.toFixed(2)} 筹码｜牌力 ${m.handRankZh}` +
      `｜已实现对手 ${built.context.realizedOpponentCount} 家（未行动 ${built.context.playersYetToAct} 家）`,
  );
  const margin = d.diagnostics.decisionMargin;
  if (margin !== undefined) console.log(`  决策边际：${margin.kind ?? '—'}｜EV ${margin.evChips?.toFixed(2) ?? '—'} vs 容差带 ±${margin.bandChips.toFixed(2)}`);
  console.log('  理由：');
  for (const reason of d.reasons) console.log(`    · [${reason.code}] ${reason.textZh}`);
  console.log(
    `  合法动作：${legal.actions.join('/')}｜跟注代价 ${legal.callCost}` +
      (legal.minRaiseToAmount === undefined ? '' : `｜最小加注到 ${legal.minRaiseToAmount}`),
  );

  const ds = d.diagnostics.decisionSource as Readonly<Record<string, unknown>> | null;
  if (ds !== null) {
    console.log(
      `  【动作来源】${String(ds['kind'])}｜优先级 ${String(ds['priority'])}｜证据类型 ${String(ds['estimateType'])}` +
        `｜可覆盖 ${String(ds['canOverrideEvidence'])}｜范围 ${String(ds['evidenceScope'])}` +
        (ds['overrideBlockedReason'] === null ? '' : `｜阻断 = ${String(ds['overrideBlockedReason'])}`),
    );
    const alternatives = (d.diagnostics.alternativeActions ?? []) as readonly Readonly<Record<string, unknown>>[];
    if (alternatives.length > 0) {
      console.log(
        `  【备选】${alternatives.map((a) => `${String(a['action'])}（${String(a['estimateType'])}｜${String(a['statusZh'])}）`).join('；')}`,
      );
    }
  }

  for (const snap of built.context.opponentRanges) {
    console.log(
      `  【对手范围】${snap.opponentPositionZh}｜组合 ${snap.supportSize}｜熵 ${snap.metrics.entropyBits.toFixed(2)}` +
        `｜来源 ${snap.sourceKind}｜可信度 ${snap.confidence.toFixed(2)}`,
    );
  }
  const evidence = built.context.profileRangeEvidence ?? null;
  if (evidence !== null) {
    console.log(
      `  【画像链路】${evidence.dimensionTierZh}｜provider 乘数通道生效 ${String(evidence.provider.applied)}` +
        `｜权益（**实测**前后对比）${evidence.equityBefore === null ? '—' : (evidence.equityBefore * 100).toFixed(2) + '%'} → ` +
        `${evidence.equityAfter === null ? '—' : (evidence.equityAfter * 100).toFixed(2) + '%'}` +
        (evidence.equityDeltaPct === null || evidence.equityDeltaPct === 0
          ? '（本节点画像未改变权益）'
          : `（Δ ${evidence.equityDeltaPct.toFixed(3)} 个百分点 ⇒ 画像**确实**进了范围主链）`),
    );
  }
  if (verbose) {
    for (const dg of d.diagnostics.degradations) console.log(`  · [降级/${dg.impact}] ${dg.textZh}`);
    for (const w of built.warnings) console.log(`  ⚠️ ${w}`);
  }
}

console.log('局面：6-max 1/2｜UTG/HJ/CO 全部跛入 ⇒ 底池 9 筹码（4.5BB）｜Hero BTN K♠Q♠｜身后 SB/BB 未行动');
report('主对手 = UTG（松弱 → LOOSE）', 'LOOSE', undefined, true);
report('主对手 = CO（跟注站 → CALLING_STATION）', 'CALLING_STATION', 'seat_CO');
report('无画像（UNKNOWN）', 'UNKNOWN', undefined, true);
report('主对手 = UTG（更极端的松弱 → CALLING_STATION）', 'CALLING_STATION');
report('主对手 = HJ（普通偏被动 → NORMAL）', 'NORMAL', 'seat_HJ');
