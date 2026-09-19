/**
 * 真实牌局 9（测试局 3）：9 人桌 BB 9♠8♠ —— 转牌面对松弱玩家的突然大注
 *
 * 使用者给出的局面（9-max，1/2，有效 120BB）：
 *
 * ```text
 * 翻前：UTG 弃｜UTG+1 加注 3BB｜UTG+2 弃｜LJ 跟｜HJ/CO/BTN/SB 弃｜Hero BB 9♠8♠ 跟
 *       底池 9.5BB
 * 翻牌：T♠ 7♦ 2♠｜Hero check｜UTG+1 下注 3BB｜LJ 跟 3BB｜Hero 跟 ⇒ 底池 18.5BB
 * 转牌：8♦｜Hero check｜UTG+1 check｜LJ 下注 14BB（≈76% pot）⇒ **轮到 Hero**
 * ```
 *
 * 画像：UTG+1 紧弱（VPIP 17/PFR 12，翻牌 CBet 70%，被跟后转牌减速）
 *       LJ  松弱娱乐（VPIP 48/PFR 8，爱跟、追听、很少主动诈唬，突然大注偏强）
 *
 * 用法：E:\node.exe --experimental-strip-types scripts\review-hand-09.ts
 */
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';
import { deriveLegalActions } from '../src/app/manualInput/legalActions.ts';
import { parseManualInput, type ManualHandInput } from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const OPTIONS = { rules: RULES, asOf: 1_757_000_000_000, writeLog: false } as const;
const STACK = 120;

const num = (v: unknown, digits = 2): string => (typeof v === 'number' ? v.toFixed(digits) : '—');
const pct = (v: unknown, digits = 1): string =>
  typeof v === 'number' ? `${(v * 100).toFixed(digits)}%` : '—';

/** 固定节点：9 人桌，Hero BB 9♠8♠，转牌 8♦ 面对 LJ 的 14BB 下注 */
function node(seatProfiles: Readonly<Record<string, string>> = { UTG1: 'TIGHT', LJ: 'LOOSE' }): ManualHandInput {
  const F = (position: string, street?: string) =>
    ({ position, type: 'FOLD', ...(street === undefined ? {} : { street }) }) as never;
  return {
    tableSize: 9,
    heroPosition: 'BB',
    heroCards: ['9s', '8s'],
    board: ['Ts', '7d', '2s', '8d'],
    street: 'TURN',
    effectiveStackBB: STACK,
    bigBlindBB: 2,
    seatStacksBB: { UTG1: STACK, LJ: STACK, BB: STACK },
    seatProfiles,
    actionHistory: [
      F('UTG'),
      { position: 'UTG1', type: 'RAISE', amountBB: 3 },
      F('UTG2'),
      { position: 'LJ', type: 'CALL', amountBB: 3 },
      F('HJ'),
      F('CO'),
      F('BTN'),
      F('SB'),
      // BB 已投入 1BB 盲注 ⇒ 跟注 3BB 需要再投入 2BB
      { position: 'BB', type: 'CALL', amountBB: 2 },
      // 翻牌
      { position: 'BB', type: 'CHECK', street: 'FLOP' },
      { position: 'UTG1', type: 'BET', amountBB: 3, street: 'FLOP' },
      { position: 'LJ', type: 'CALL', amountBB: 3, street: 'FLOP' },
      { position: 'BB', type: 'CALL', amountBB: 3, street: 'FLOP' },
      // 转牌
      { position: 'BB', type: 'CHECK', street: 'TURN' },
      { position: 'UTG1', type: 'CHECK', street: 'TURN' },
      { position: 'LJ', type: 'BET', amountBB: 14, street: 'TURN' },
    ],
    environment: 'MID_LOW_STAKES',
    villain: { playerId: 'seat_LJ', quickProfile: 'LOOSE', dynamicHint: 'UNKNOWN', stackBB: STACK },
  } as unknown as ManualHandInput;
}

function report(label: string, input: ManualHandInput, verbose = false): void {
  console.log(`\n════════ ${label} ════════`);
  const result = analyzeManualHand(input, OPTIONS);
  if (!result.ok) {
    console.log(`  ❌ ${JSON.stringify(result.issues)}`);
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
  const d = result.decision;
  const m = d.diagnostics.math;

  console.log(
    `  建议：${String(d.action)}${d.sizeBB === undefined ? '' : `｜尺寸 ${d.sizeBB}BB`}` +
      `｜置信度 ${d.confidence.toFixed(2)}（${d.band}）｜分类 ${d.classification}`,
  );
  console.log(
    `  底池 ${m.pot}（${(m.pot / m.bigBlind).toFixed(1)}BB）｜需补 ${m.callCost}（${(m.callCost / m.bigBlind).toFixed(1)}BB）` +
      `｜身后 ${m.myRemainingStack}（${(m.myRemainingStack / m.bigBlind).toFixed(1)}BB）｜有效筹码 ${m.effectiveStack}` +
      `｜SPR ${m.spr === null ? '—' : m.spr.toFixed(2)}｜所需权益 ${pct(m.requiredEquity)}`,
  );
  console.log(
    `  权益 ${pct(m.heroEquity)}｜跟注 EV ${num(m.callEV)} 筹码｜牌力 ${m.handRankZh}｜类别 ${m.handCategory}` +
      `｜可争夺 ${num(m.winnable, 1)}`,
  );
  const layered = m.layeredEV;
  if (layered !== undefined && layered !== null) {
    console.log(`  分层 EV：${num(layered.value)}（精确 ${String(layered.exact)}｜层数 ${layered.layerCount}）`);
  }
  const margin = d.diagnostics.decisionMargin;
  if (margin !== undefined) {
    console.log(
      `  决策边际：${margin.kind ?? '—'}｜作用域 ${margin.scope}｜EV ${num(margin.evChips)} vs 带 ±${margin.bandChips.toFixed(2)}`,
    );
  }
  const src = d.diagnostics.decisionSource;
  if (src !== null && src !== undefined) {
    console.log(
      `  动作来源：${String(src['kind'])}｜证据类型 ${String(src['estimateType'])}｜范围 ${String(src['evidenceScope'])}` +
        `｜阻断 ${String(src['overrideBlockedReason'] ?? '—')}`,
    );
  }
  const postflop = d.diagnostics.postflop;
  if (postflop !== null && postflop !== undefined) {
    console.log(
      `  【翻后】成交牌型 ${postflop.madeHandZh}｜角色 ${postflop.handRoleZh}（上街 ${postflop.previousHandRoleZh ?? '—'}）` +
        `｜强度 ${postflop.roleStrength.toFixed(3)}`,
    );
    console.log(
      `  【价值/摊牌】摊牌价值 ${postflop.showdownValue.toFixed(3)}｜保护 ${postflop.protectionValue.toFixed(3)}` +
        `｜诈唬潜力 ${postflop.bluffPotential.toFixed(3)}｜未来牌保护 ${postflop.futureCardProtectionScore.toFixed(3)}` +
        `｜指标 ${postflop.metricKind}`,
    );
    console.log(
      `  【真实 EV 排名】${postflop.trueEvRanking
        .map((r) => `${r.action} ${r.evChips === null ? '—' : r.evChips.toFixed(2)}`)
        .join('｜')}｜容差带 ±${postflop.uncertaintyBandChips.toFixed(2)}`,
    );
    console.log(
      `  【动作偏好序】${postflop.evRanking.map((r) => `${r.action} ${r.score.toFixed(3)}`).join('｜')}`,
    );
    console.log(
      `  【范围压缩】${Object.entries(postflop.rangeCompression)
        .map(([k, v]) => `${k} ${v.toFixed(3)}`)
        .join('｜')}`,
    );
    console.log(
      `  【价值守门器】${Object.entries(postflop.valueAssessment)
        .map(([k, v]) => `${k} ${typeof v === 'number' ? v.toFixed(3) : String(v)}`)
        .join('｜')}`,
    );
    if (postflop.exploitAdjustmentZh !== null) console.log(`  【画像偏移】${postflop.exploitAdjustmentZh}`);
    if (postflop.roleChangeReasonZh !== null) console.log(`  【角色迁移】${postflop.roleChangeReasonZh}`);
  }
  console.log(
    `  【动作顺序】pendingQueue = [${g.state.pendingQueue.join(', ')}]｜currentBet ${g.state.currentBet}` +
      `｜本街还没说过话的人 = ${built.context.playersYetToAct} 家` +
      `｜**我之后还要行动的人 = ${built.context.playersRemainingToAct} 家**（isClosingAction ${String(built.context.isClosingAction)}）` +
      `（${
        built.context.opponentRanges.map((r) => r.opponentPositionZh).join(' / ') || '—'
      } 已进入权益）`,
  );
  console.log('  理由：');
  for (const reason of d.reasons) console.log(`    · [${reason.code}] ${reason.textZh}`);
  for (const snap of built.context.opponentRanges) {
    console.log(
      `  【对手范围】${snap.opponentPositionZh}｜组合 ${snap.supportSize}｜熵 ${snap.metrics.entropyBits.toFixed(2)}` +
        `｜来源 ${snap.sourceKind}｜可信度 ${snap.confidence.toFixed(2)}`,
    );
    for (const t of snap.updateTrace) {
      console.log(
        `     · ${t.street} ${t.action}：组合 ${t.supportBefore} → ${t.supportAfter}｜熵 ${t.entropyBefore.toFixed(2)} → ${t.entropyAfter.toFixed(2)}`,
      );
    }
  }
  console.log(
    `  合法动作：${legal.actions.join('/')}｜跟注代价 ${legal.callCost}｜最小加注到 ${legal.minRaiseToAmount}｜全下到 ${legal.allInToAmount}`,
  );
  if (verbose) {
    for (const w of built.warnings) console.log(`  ⚠️ ${w}`);
    for (const dg of d.diagnostics.degradations) console.log(`  · [降级/${dg.impact}] ${dg.textZh}`);
  }
}

console.log(
  '局面：9-max 1/2｜Hero BB 9♠8♠｜翻前 UTG+1 开池 3BB、LJ 跟、Hero 跟（9.5BB）\n' +
    '翻牌 T♠7♦2♠：Hero check｜UTG+1 下注 3BB｜LJ 跟｜Hero 跟（18.5BB）\n' +
    '转牌 8♦：Hero check｜UTG+1 check｜LJ 下注 14BB（76% pot）⇒ 轮到 Hero｜有效 120BB',
);
report('LJ 松弱 + UTG+1 紧弱（使用者给的画像）', node(), true);
report('对照：两人都当普通常客（NORMAL/NORMAL）', node({ UTG1: 'NORMAL', LJ: 'NORMAL' }));
report('对照：LJ 改成疯子（MANIAC，会诈唬）', node({ UTG1: 'TIGHT', LJ: 'MANIAC' }));
