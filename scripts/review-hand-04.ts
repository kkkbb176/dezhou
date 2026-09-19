/**
 * 真实牌局 4：CO A♠J♠ 3bet 后翻牌 Q♦8♠4♠，HJ 过牌
 *
 * 使用者给出的局面（6 人桌 1/2）：
 *   HJ 开 3BB → CO 3bet 9BB → 全部弃牌 → HJ 跟注（底池 19.5BB）
 *   翻牌 Q♦8♠4♠ → HJ 过牌 → **轮到 Hero（CO, A♠J♠）**
 *
 * 用法：`E:\node.exe --experimental-strip-types scripts/review-hand-04.ts`
 */
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';
import { deriveLegalActions } from '../src/app/manualInput/legalActions.ts';
import { parseManualInput, type ManualHandInput } from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import { boardTextureOf } from '../src/domain/postflop/boardDelta.ts';
import { boardWetnessOf } from '../src/domain/postflop/rangeCompression.ts';
import { parseCardsLoose } from '../src/domain/poker/cards.ts';
import type { Card } from '../src/domain/types.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const OPTIONS = { rules: RULES, asOf: 1_757_000_000_000, writeLog: false } as const;
const SEATS = { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 } as const;

const PREFLOP = [
  { position: 'UTG', type: 'FOLD' },
  { position: 'HJ', type: 'RAISE', amountBB: 3 },
  { position: 'CO', type: 'RAISE', amountBB: 9 },
  { position: 'BTN', type: 'FOLD' },
  { position: 'SB', type: 'FOLD' },
  { position: 'BB', type: 'FOLD' },
  { position: 'HJ', type: 'CALL', amountBB: 6 },
] as const;

/** 翻牌节点：HJ 过牌，轮到 Hero */
function flopNode(quickProfile: string, dynamicHint = 'UNKNOWN'): ManualHandInput {
  return {
    tableSize: 6,
    heroPosition: 'CO',
    heroCards: ['As', 'Js'],
    board: ['Qd', '8s', '4s'],
    street: 'FLOP',
    effectiveStackBB: 100,
    bigBlindBB: 2,
    seatStacksBB: { ...SEATS },
    actionHistory: [...PREFLOP, { position: 'HJ', type: 'CHECK', street: 'FLOP' }],
    environment: 'MID_LOW_STAKES',
    villain: { quickProfile, dynamicHint, stackBB: 100 },
  } as unknown as ManualHandInput;
}

/** 转牌节点：翻牌双方过牌 → 转牌 2♥ → HJ 再次过牌，轮到 Hero */
function turnNode(quickProfile: string, dynamicHint = 'UNKNOWN'): ManualHandInput {
  return {
    tableSize: 6,
    heroPosition: 'CO',
    heroCards: ['As', 'Js'],
    board: ['Qd', '8s', '4s', '2h'],
    street: 'TURN',
    effectiveStackBB: 100,
    bigBlindBB: 2,
    seatStacksBB: { ...SEATS },
    actionHistory: [
      ...PREFLOP,
      { position: 'HJ', type: 'CHECK', street: 'FLOP' },
      { position: 'CO', type: 'CHECK', street: 'FLOP' },
      { position: 'HJ', type: 'CHECK', street: 'TURN' },
    ],
    environment: 'MID_LOW_STAKES',
    villain: { quickProfile, dynamicHint, stackBB: 100 },
  } as unknown as ManualHandInput;
}

/** 翻前节点（回顾用）：HJ 开 3BB，轮到 CO */
function preflopNode(quickProfile: string): ManualHandInput {
  return {
    tableSize: 6,
    heroPosition: 'CO',
    heroCards: ['As', 'Js'],
    board: [],
    street: 'PREFLOP',
    effectiveStackBB: 100,
    bigBlindBB: 2,
    seatStacksBB: { ...SEATS },
    actionHistory: [
      { position: 'UTG', type: 'FOLD' },
      { position: 'HJ', type: 'RAISE', amountBB: 3 },
    ],
    environment: 'MID_LOW_STAKES',
    villain: { quickProfile, dynamicHint: 'UNKNOWN', stackBB: 100 },
  } as unknown as ManualHandInput;
}

function report(label: string, input: ManualHandInput, verbose = false): void {
  const r = analyzeManualHand(input, OPTIONS);
  console.log(`\n════════ ${label} ════════`);
  if (!r.ok) {
    console.log(`  ❌ 无法分析：${JSON.stringify(r.issues)}`);
    return;
  }
  const d = r.decision;
  const m = d.diagnostics.math;
  const post = d.diagnostics.postflop ?? null;

  console.log(
    `  建议：${String(d.action)}${d.sizeBB === undefined ? '' : `｜尺寸 ${d.sizeBB}BB`}` +
      `｜置信度 ${d.confidence.toFixed(2)}（${d.band}）｜分类 ${d.classification}`,
  );
  console.log(
    `  底池 ${m.pot}（${(m.pot / m.bigBlind).toFixed(1)}BB）｜需补 ${m.callCost}` +
      `｜身后 ${m.myRemainingStack}（${(m.myRemainingStack / m.bigBlind).toFixed(1)}BB）` +
      `｜SPR ${m.spr === null ? '—' : m.spr.toFixed(2)}｜所需权益 ${(m.requiredEquity * 100).toFixed(1)}%`,
  );
  console.log(
    `  权益 ${m.heroEquity === null ? '—' : (m.heroEquity * 100).toFixed(1) + '%'}` +
      `｜跟注 EV ${m.callEV === null ? '—' : m.callEV.toFixed(2)}` +
      `｜牌力 ${m.handRankZh}`,
  );
  const margin = d.diagnostics.decisionMargin;
  if (margin !== undefined) {
    console.log(`  决策边际：${margin.kind ?? '—'}｜${margin.noteZh}`);
  }
  console.log('  理由：');
  for (const reason of d.reasons) {
    console.log(`    · [${reason.code}] ${reason.textZh}`);
  }

  const parsed = parseManualInput(input);
  if (!parsed.ok) return;
  const gate = buildAnalyzableState(parsed.value);
  if (!gate.ok) return;
  const built = buildDecisionContext({
    state: gate.state,
    rules: RULES,
    environment: 'MID_LOW_STAKES',
    asOf: 1_757_000_000_000,
    quickProfile: input.villain?.quickProfile,
    ...(input.villain?.dynamicHint === undefined ? {} : { dynamicHint: input.villain.dynamicHint }),
  });
  const hero = gate.state.players.find((p) => p.holeCards !== null)!;
  const legal = deriveLegalActions(gate.state, hero);
  console.log(
    `  合法动作：${legal.actions.join('/')}｜跟注代价 ${legal.callCost}` +
      (legal.minRaiseTo === null ? '' : `｜最小加注到 ${legal.minRaiseTo}`),
  );

  const facts = built.context.postflopFacts?.opponentRangeFacts ?? null;
  if (facts !== null) {
    console.log(
      `  【范围】可达 ${facts.supportSize}｜档位 0..5 = ${facts.tierHistogram
        .map((v) => (v * 100).toFixed(1) + '%')
        .join(' / ')}｜更强 ${(facts.strongerShare * 100).toFixed(1)}%｜更弱 ${(facts.weakerShare * 100).toFixed(1)}%`,
    );
    const masses = facts.actionMasses;
    if (masses !== null) {
      console.log(
        `  【质量口径】价值 ${(masses.valueMassShare * 100).toFixed(1)}%（明确取值 ${(
          masses.clearValueMass * 100
        ).toFixed(1)}% + 薄价值 ${(masses.thinValueMass * 100).toFixed(1)}%）｜诈唬 ${(
          masses.bluffMassShare * 100
        ).toFixed(1)}%｜摊牌 ${(masses.showdownMassShare * 100).toFixed(1)}%｜证据不足 ${(
          masses.uncertainMassShare * 100
        ).toFixed(1)}%`,
      );
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

  if (verbose && post !== null) {
    const pref = new Map(post.evRanking.map((x) => [x.action, x.score]));
    const boardCards = parseCardsLoose((input.board ?? []).join(' '));
    const texture = boardTextureOf(boardCards as unknown as readonly Card[]);
    const wetness = texture === null ? null : boardWetnessOf(texture);
    console.log(
      `  【门内部】判定 ${post.valueAssessment['verdict']}｜下注分 ${Number(
        post.valueAssessment['estimatedBetEVScore'],
      ).toFixed(3)} vs 过牌分 ${Number(post.valueAssessment['estimatedCheckEVScore']).toFixed(3)}`,
    );
    console.log(
      `    更差能跟 ${Number(post.valueAssessment['worseCallDensity']).toFixed(3)}｜更好继续 ${Number(
        post.valueAssessment['betterContinueDensity'],
      ).toFixed(3)}｜加注风险 ${Number(post.valueAssessment['raiseRisk']).toFixed(3)}｜摊牌价值 ${Number(
        post.valueAssessment['showdownValue'],
      ).toFixed(3)}`,
    );
    console.log(
      `    保护收益（门内评分） ${Number(post.valueAssessment['protectionBenefit'] ?? 0).toFixed(3)}｜` +
        `未来补牌保护分 ${post.futureCardProtectionScore.toFixed(3)}｜摊牌价值 ${post.showdownValue.toFixed(3)}｜` +
        `湿板度 ${wetness === null ? '—' : wetness.toFixed(3)}`,
    );
    console.log(
      `    范围压缩：强度下限 ${post.rangeCompression['strengthFloor'].toFixed(2)}｜坚果密度 ${post.rangeCompression[
        'nutDensity'
      ].toFixed(2)}｜空气密度 ${post.rangeCompression['airDensity'].toFixed(2)}｜听牌密度 ${post.rangeCompression[
        'drawDensity'
      ].toFixed(2)}`,
    );
    console.log(
      `  【角色】${post.handRoleZh}（强度 ${post.roleStrength.toFixed(2)}）｜成交牌型 ${post.madeHandZh}`,
    );
    console.log(
      `  【偏好顺序】${[...pref.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k} ${v.toFixed(3)}`)
        .join(' > ')}`,
    );
    console.log(
      '  【阻断牌】' +
        (post.blockers === undefined
          ? '—'
          : `挡掉更强 ${post.blockers.blockedStrongerCombos} 个（质量 ${post.blockers.blocksValue.toFixed(3)}）／` +
            `更弱 ${post.blockers.blockedWeakerCombos} 个（${post.blockers.blocksBluff.toFixed(3)}）｜` +
            `净偏好 ${post.blockers.netBlockerPreference.toFixed(3)}（证据 ${post.blockers.evidenceQuality}）`),
    );
  }
}

console.log('局面：6 人桌 1/2｜HJ 开 3BB → CO 3bet 9BB → HJ 跟注（底池 19.5BB）');
console.log('翻牌 Q♦8♠4♠ → HJ 过牌 → Hero（CO）持 A♠J♠');

report('翻牌节点 · 无画像（UNKNOWN）', flopNode('UNKNOWN'), true);
report('翻牌节点 · 对手=普通常客（NORMAL）', flopNode('NORMAL'));
report('翻牌节点 · 对手=跟注站（CALLING_STATION）', flopNode('CALLING_STATION'));
report('翻牌节点 · 对手=极紧（VERY_TIGHT）', flopNode('VERY_TIGHT'));
report('回顾：翻前节点（HJ 开 3BB，Hero A♠J♠）', preflopNode('UNKNOWN'));

console.log('\n\n================ 转牌节点：Q♦8♠4♠ — 2♥（翻牌双方过牌，HJ 再次过牌） ================');
report('转牌节点 · 无画像（UNKNOWN）', turnNode('UNKNOWN'), true);
report('转牌节点 · 对手=普通常客（NORMAL）', turnNode('NORMAL'));
report('转牌节点 · 对手=跟注站（CALLING_STATION）', turnNode('CALLING_STATION'));
report('转牌节点 · 对手=极紧（VERY_TIGHT）', turnNode('VERY_TIGHT'));
report('转牌节点 · 无画像 + 近期变凶提示', turnNode('UNKNOWN', 'AGGRESSION_UP'));
