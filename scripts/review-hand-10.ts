/**
 * 真实牌局 10（测试局 03A）：河牌 bluff-catcher —— CO A♣J♥ 面对被动松弱的 75% 河牌下注
 *
 * ```text
 * 9-max 1/2，有效 100BB
 * 翻前：UTG~HJ 弃｜Hero CO 开 2.5BB｜BTN/SB 弃｜BB 跟 ⇒ 底池 5.5BB
 * 翻牌 A♦8♠4♠：BB check｜Hero 下注 1.8BB（33%）｜BB 跟 ⇒ 底池 9.1BB
 * 转牌 2♣：BB check｜Hero check back
 * 河牌 K♦：BB 下注 6.8BB（75%）⇒ **轮到 Hero**｜底池（含他下注）15.9BB
 * ```
 *
 * 画像：BB = 被动松弱（VPIP 44 / PFR 8 / 3Bet 2%，翻牌跟得宽、主动少、
 *       河牌下注频率低、很少把听牌转诈唬、大注偏价值、一对常常直接摊牌）
 *
 * 用法：E:\node.exe --experimental-strip-types scripts/review-hand-10.ts
 */
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';
import { deriveLegalActions } from '../src/app/manualInput/legalActions.ts';
import { parseManualInput, type ManualHandInput } from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const OPTIONS = { rules: RULES, asOf: 1_757_000_000_000, writeLog: false } as const;

const pct = (v: unknown, d = 1): string => (typeof v === 'number' ? `${(v * 100).toFixed(d)}%` : '—');
const num = (v: unknown, d = 2): string => (typeof v === 'number' ? v.toFixed(d) : '—');

function node(bbProfile: string): ManualHandInput & { seatProfiles: Record<string, string> } {
  return {
    tableSize: 9,
    heroPosition: 'CO',
    heroCards: ['Ac', 'Jh'],
    board: ['Ad', '8s', '4s', '2c', 'Kd'],
    street: 'RIVER',
    effectiveStackBB: 100,
    bigBlindBB: 2,
    seatStacksBB: { CO: 100, BB: 100 },
    seatProfiles: { BB: bbProfile },
    actionHistory: [
      { position: 'UTG', type: 'FOLD' },
      { position: 'UTG1', type: 'FOLD' },
      { position: 'UTG2', type: 'FOLD' },
      { position: 'LJ', type: 'FOLD' },
      { position: 'HJ', type: 'FOLD' },
      { position: 'CO', type: 'RAISE', amountBB: 2.5 },
      { position: 'BTN', type: 'FOLD' },
      { position: 'SB', type: 'FOLD' },
      { position: 'BB', type: 'CALL', amountBB: 1.5 },
      // 翻牌
      { position: 'BB', type: 'CHECK', street: 'FLOP' },
      { position: 'CO', type: 'BET', amountBB: 1.8, street: 'FLOP' },
      { position: 'BB', type: 'CALL', amountBB: 1.8, street: 'FLOP' },
      // 转牌
      { position: 'BB', type: 'CHECK', street: 'TURN' },
      { position: 'CO', type: 'CHECK', street: 'TURN' },
      // 河牌
      { position: 'BB', type: 'BET', amountBB: 6.8, street: 'RIVER' },
    ],
    environment: 'MID_LOW_STAKES',
    villain: { playerId: 'seat_BB', quickProfile: bbProfile, dynamicHint: 'UNKNOWN', stackBB: 100 },
  } as unknown as ManualHandInput & { seatProfiles: Record<string, string> };
}

function report(label: string, input: ManualHandInput & { seatProfiles: Record<string, string> }, verbose = false): void {
  console.log(`\n════════ ${label} ════════`);
  const r = analyzeManualHand(input, OPTIONS);
  if (!r.ok) {
    console.log(`  ❌ ${JSON.stringify(r.issues)}`);
    return;
  }
  const parsed = parseManualInput(input);
  if (!parsed.ok) return;
  const g = buildAnalyzableState(parsed.value);
  if (!g.ok) return;
  const built = buildDecisionContext({
    state: g.state,
    rules: RULES,
    environment: 'MID_LOW_STAKES',
    asOf: 1_757_000_000_000,
    seatProfiles: input.seatProfiles as never,
    quickProfile: input.villain?.quickProfile,
    ...(input.villain?.playerId === undefined ? {} : { villainPlayerId: input.villain.playerId }),
  });
  const hero = g.state.players.find((p) => p.holeCards !== null)!;
  const legal = deriveLegalActions(g.state, hero);
  const d = r.decision;
  const m = d.diagnostics.math;

  console.log(
    `  建议：${String(d.action)}${d.sizeBB === undefined ? '' : `｜尺寸 ${d.sizeBB}BB`}` +
      `｜置信度 ${d.confidence.toFixed(2)}（${d.band}）｜分类 ${d.classification}`,
  );
  console.log(
    `  底池 ${m.pot}（${(m.pot / m.bigBlind).toFixed(1)}BB）｜需补 ${m.callCost}（${(m.callCost / m.bigBlind).toFixed(1)}BB）` +
      `｜身后 ${m.myRemainingStack}｜有效筹码 ${m.effectiveStack}｜SPR ${m.spr === null ? '—' : m.spr.toFixed(2)}`,
  );
  console.log(
    `  所需权益 ${pct(m.requiredEquity)}（= ${m.callCost} / (${m.pot} + ${m.callCost})）｜Hero Equity ${pct(m.heroEquity)}` +
      `｜跟注 EV ${num(m.callEV)} 筹码｜牌力 ${m.handRankZh}｜类别 ${m.handCategory}`,
  );
  const margin = d.diagnostics.decisionMargin;
  if (margin !== undefined) {
    console.log(`  决策边际：${margin.kind ?? '—'}｜作用域 ${margin.scope}｜带 ±${margin.bandChips.toFixed(2)}`);
  }
  const src = d.diagnostics.decisionSource;
  if (src !== null && src !== undefined) {
    console.log(
      `  动作来源：${String(src['kind'])}｜证据类型 ${String(src['estimateType'])}｜范围 ${String(src['evidenceScope'])}` +
        `｜阻断 ${String(src['overrideBlockedReason'] ?? '—')}`,
    );
  }
  const pf = d.diagnostics.postflop;
  if (pf !== null && pf !== undefined) {
    console.log(
      `  【翻后】成手 ${pf.madeHandZh}｜角色 ${pf.handRoleZh}（上街 ${pf.previousHandRoleZh ?? '—'}）｜强度 ${pf.roleStrength.toFixed(3)}`,
    );
    console.log(`  【真实 EV 排名】${pf.trueEvRanking.map((x) => `${x.action} ${num(x.evChips)}`).join('｜')}｜容差带 ±${pf.uncertaintyBandChips.toFixed(2)}`);
    console.log(`  【排序语义】${pf.evRanking.map((x) => `${x.action} ${x.score.toFixed(3)}(${x.kind})`).join('｜')}`);
    console.log(`  【范围压缩】${Object.entries(pf.rangeCompression).map(([k, v]) => `${k} ${num(v, 3)}`).join('｜')}`);
    console.log(`  【价值门】${Object.entries(pf.valueAssessment).map(([k, v]) => `${k} ${typeof v === 'number' ? num(v, 3) : String(v)}`).join('｜')}`);
    if (pf.exploitAdjustmentZh !== null) console.log(`  【画像偏移】${pf.exploitAdjustmentZh}`);
    console.log(`  【牌面变化】${JSON.stringify(pf.boardDelta)}`);
  }
  console.log('  理由：');
  for (const reason of d.reasons) console.log(`    · [${reason.code}] ${reason.textZh}`);
  for (const snap of built.context.opponentRanges) {
    console.log(
      `  【对手河牌范围】${snap.opponentPositionZh}｜组合 ${snap.supportSize}｜熵 ${snap.metrics.entropyBits.toFixed(2)}` +
        `｜来源 ${snap.sourceKind}｜可信度 ${snap.confidence.toFixed(2)}`,
    );
    for (const t of snap.updateTrace) {
      console.log(
        `     · ${t.street} ${t.action}：组合 ${t.supportBefore} → ${t.supportAfter}｜熵 ${t.entropyBefore.toFixed(2)} → ${t.entropyAfter.toFixed(2)}`,
      );
    }
  }
  const facts = built.context.postflopFacts?.opponentRangeFacts ?? null;
  if (facts !== null) {
    console.log(
      `  【牌面适配】支持集 ${facts.supportSize}｜更强 ${num(facts.strongerShare, 3)}｜更弱 ${num(facts.weakerShare, 3)}`,
    );
  }
  console.log(`  合法动作：${legal.actions.join('/')}｜最小加注到 ${legal.minRaiseToAmount}｜全下到 ${legal.allInToAmount}`);
  if (verbose) {
    for (const w of built.warnings) console.log(`  ⚠️ ${w}`);
    for (const dg of d.diagnostics.degradations) console.log(`  · [降级/${dg.impact}] ${dg.textZh}`);
  }
}

console.log(
  '局面：9-max 1/2｜Hero CO A♣J♥｜翻前开 2.5BB、BB 跟（5.5BB）\n' +
    '翻牌 A♦8♠4♠：BB check｜Hero 1.8BB（33%）｜BB 跟（9.1BB）｜转牌 2♣：双方 check\n' +
    '河牌 K♦（A♦8♠4♠2♣K♦）：BB 下注 6.8BB（75%）⇒ 轮到 Hero｜底池（含他下注）15.9BB｜需补 6.8BB',
);
report('BB = 画像 B：松凶 + 河牌过度诈唬（MANIAC，使用者给的画像 B）', node('MANIAC'), true);
report('对照：BB = 松（LOOSE）', node('LOOSE'));
report('对照：BB = 普通（NORMAL）', node('NORMAL'));
report('对照：BB = 过度诈唬型（BLUFF_HEAVY）', node('BLUFF_HEAVY'));
report('对照：BB = 被动松弱（CALLING_STATION，画像 A）', node('CALLING_STATION'));
