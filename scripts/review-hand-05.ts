/**
 * 真实牌局 5：BB 9♠8♠｜河牌 T♠7♦6♣J♦7♣｜底池 177｜身后 112｜Hero 先行动
 *
 * 使用者给出的局面（与测试局 2 的河牌节点一致）：
 *   CO 开 2.5BB → BB 跟；翻牌 T♠7♦6♣：BB 过牌 → CO 下注 2BB → BB 加注到 12BB → CO 跟
 *   转牌 J♦：BB 下注 29.5BB → CO 跟；河牌 7♣：**Hero 先行动**
 *
 * 用法：`E:\node.exe --experimental-strip-types scripts/review-hand-05.ts`
 */
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { advisePostflop } from '../src/app/decision/postflopAdvisor.ts';
import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';
import { deriveLegalActions } from '../src/app/manualInput/legalActions.ts';
import { parseManualInput, type ManualHandInput } from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const OPTIONS = { rules: RULES, asOf: 1_757_000_000_000, writeLog: false } as const;

const SEATS = { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 } as const;
const HISTORY = [
  { position: 'UTG', type: 'FOLD' },
  { position: 'HJ', type: 'FOLD' },
  { position: 'CO', type: 'RAISE', amountBB: 2.5 },
  { position: 'BTN', type: 'FOLD' },
  { position: 'SB', type: 'FOLD' },
  { position: 'BB', type: 'CALL', amountBB: 1.5 },
  { position: 'BB', type: 'CHECK', street: 'FLOP' },
  { position: 'CO', type: 'BET', amountBB: 2, street: 'FLOP' },
  { position: 'BB', type: 'RAISE', amountBB: 12, street: 'FLOP' },
  { position: 'CO', type: 'CALL', amountBB: 10, street: 'FLOP' },
  { position: 'BB', type: 'BET', amountBB: 29.5, street: 'TURN' },
  { position: 'CO', type: 'CALL', amountBB: 29.5, street: 'TURN' },
] as const;

function input(profile: string): ManualHandInput {
  return {
    tableSize: 6,
    heroPosition: 'BB',
    heroCards: ['9s', '8s'],
    board: ['Ts', '7d', '6c', 'Jd', '7c'],
    street: 'RIVER',
    effectiveStackBB: 100,
    bigBlindBB: 2,
    seatStacksBB: { ...SEATS },
    actionHistory: [...HISTORY],
    environment: 'MID_LOW_STAKES',
    villain: { quickProfile: profile, dynamicHint: 'UNKNOWN', stackBB: 100 },
  } as unknown as ManualHandInput;
}

function report(label: string, profile: string, verbose = false): void {
  const hand = input(profile);
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
  const advice = advisePostflop(built.context, {
    facingBet: legal.callCost > 0,
    requiredEquity: built.context.math.requiredEquity,
    potAfterCall: built.context.math.pot + legal.callCost,
  });

  const m = result.decision.diagnostics.math;
  console.log(
    `  建议：${String(result.decision.action)}${result.decision.sizeBB === undefined ? '' : `｜尺寸 ${result.decision.sizeBB}BB`}` +
      `｜置信度 ${result.decision.confidence.toFixed(2)}（${result.decision.band}）｜分类 ${result.decision.classification}`,
  );
  console.log(
    `  底池 ${m.pot}（${(m.pot / m.bigBlind).toFixed(1)}BB）｜身后 ${m.myRemainingStack}（${(m.myRemainingStack / m.bigBlind).toFixed(1)}BB）` +
      `｜SPR ${m.spr === null ? '—' : m.spr.toFixed(2)}｜权益 ${((m.heroEquity ?? 0) * 100).toFixed(2)}%｜牌力 ${m.handRankZh}`,
  );
  for (const reason of result.decision.reasons.slice(0, 4)) {
    console.log(`    · [${reason.code}] ${reason.textZh}`);
  }
  const post = result.decision.diagnostics.postflop;
  if (post !== null) {
    console.log(`  角色：${post.handRoleZh}（强度 ${post.roleStrength.toFixed(2)}）｜成交牌型 ${post.madeHandZh}`);
    const facts = built.context.postflopFacts?.opponentRangeFacts ?? null;
    if (facts !== null) {
      console.log(
        `  【范围】可达 ${facts.supportSize}｜更强 ${(facts.strongerShare * 100).toFixed(1)}%｜更弱 ${(facts.weakerShare * 100).toFixed(1)}%` +
          `｜打平 ${(facts.equalShare * 100).toFixed(1)}%｜档位 0..5 = ${facts.tierHistogram.map((v) => (v * 100).toFixed(1) + '%').join(' / ')}`,
      );
    }
    console.log(
      `  【门内部】湿润度 ${(advice?.wetness ?? 0).toFixed(2)}｜更差能跟 ${Number(post.valueAssessment['worseCallDensity']).toFixed(2)}` +
        `｜更好继续 ${Number(post.valueAssessment['betterContinueDensity']).toFixed(2)}` +
        `｜被加注压力指数 ${Number(post.valueAssessment['raisePressureIndex'] ?? 0).toFixed(2)}` +
        `｜摊牌价值 ${post.showdownValue.toFixed(2)}｜下注偏好 ${Number(post.valueAssessment['estimatedBetEVScore']).toFixed(3)} vs 过牌 ${Number(post.valueAssessment['estimatedCheckEVScore']).toFixed(3)}`,
    );
    console.log(`  偏好分：${post.evRanking.map((x) => `${x.action} ${x.score.toFixed(3)}`).join('  ')}`);
  }

  const bd = advice?.betDecision ?? null;
  if (bd === null) {
    console.log('  （没有下注决策模型）');
    return;
  }
  console.log(`  听牌：${bd.draw.noteZh}`);
  console.log(
    `  实现因子：${bd.realization.factor.toFixed(3)}（过牌分支 ${bd.checkRealizationFactor.toFixed(3)}）｜CHECK EV ${bd.checkEV === null ? '—' : bd.checkEV.toFixed(1)}` +
      `｜最佳尺寸 ${bd.bestSize ?? '—'}${bd.bestAmount === null ? '' : `（合法 ${bd.bestAmount.toFixed(1)}）`} ⇒ ${bd.preferredAction}`,
  );
  if (bd.droppedSizes.length > 0) {
    console.log(
      `  被丢弃候选：${bd.droppedSizes.map((d) => `${d.requestedKind} 理论 ${d.requestedAmount.toFixed(1)} → 合法 ${d.legalAmount.toFixed(1)}`).join('；')}`,
    );
  }
  console.log('  尺寸         比例   建模额   P(弃)   P(跟)   P(加)   EqVsCall EqVsRaise  EV_call  EV_raise   BetEV    分     桶组合数');
  for (const s of bd.sizes) {
    console.log(
      `  ${s.kind.padEnd(12)} ${(s.ratioToPot * 100).toFixed(0).padStart(4)}% ${s.betAmount.toFixed(1).padStart(7)}  ` +
        `${s.foldLikelihood.toFixed(3)}  ${s.callLikelihood.toFixed(3)}  ${s.raiseLikelihood.toFixed(3)}   ` +
        `${s.heroEquityVsCallRange === null ? '  —   ' : (s.heroEquityVsCallRange * 100).toFixed(2) + '%'}` +
        `${s.heroEquityVsRaiseRange === null ? '    —    ' : '  ' + (s.heroEquityVsRaiseRange * 100).toFixed(2) + '%  '}` +
        `${s.evCallBranch === null ? '   —   ' : s.evCallBranch.toFixed(1).padStart(7)}` +
        ` ${s.evRaiseBranch === null ? '   —   ' : s.evRaiseBranch.toFixed(1).padStart(8)}` +
        ` ${s.betEV === null ? '   —   ' : s.betEV.toFixed(1).padStart(7)} ${s.score.toFixed(3)}  ` +
        `${s.buckets.map((b) => b.comboCount).join('/')}`,
    );
  }
  if (verbose) {
    const tree = bd.checkTree;
    console.log(
      `  【CHECK 树】${tree.kind}｜我在${tree.isInPosition ? '后位' : '前位'}｜` +
        `P(他过牌) ${tree.checkBackLikelihood.toFixed(3)} / P(他下注 ${tree.villainBetAmount.toFixed(1)}) ${tree.betLikelihood.toFixed(3)}`,
    );
    console.log(
      `    摊牌分支：EqVsCheckBack ${tree.heroEquityVsCheckBackRange === null ? '—' : (tree.heroEquityVsCheckBackRange * 100).toFixed(2) + '%'}` +
        ` ⇒ EV_showdown ${tree.evShowdown === null ? '—' : tree.evShowdown.toFixed(1)}`,
    );
    console.log(
      `    他下注分支：EqVsBet ${tree.heroEquityVsBetRange === null ? '—' : (tree.heroEquityVsBetRange * 100).toFixed(2) + '%'}` +
        ` ⇒ Hero CALL EV ${tree.heroCallEV === null ? '—' : tree.heroCallEV.toFixed(1)}｜FOLD EV ${tree.heroFoldEV}` +
        ` ⇒ 最佳应手 ${tree.heroBestResponseEV === null ? '—' : tree.heroBestResponseEV.toFixed(1)}（加注 ${tree.raiseResponse}）`,
    );
    console.log(
      `    **CHECK EV ${tree.checkEV === null ? '—' : tree.checkEV.toFixed(1)}**（≠ 权益×底池 ${(((built.context.math.heroEquity ?? 0) * bd.pot)).toFixed(1)}）`,
    );
    console.log(`  模型说明：${bd.modelNoteZh}`);
    console.log(
      `  【阻断牌】挡掉更强 ${post?.blockers.blockedStrongerCombos ?? '—'} 个／更弱 ${post?.blockers.blockedWeakerCombos ?? '—'} 个` +
        `｜净偏好 ${post === null || post === undefined ? '—' : post.blockers.netBlockerPreference.toFixed(3)}`,
    );
  }
}

console.log('局面：6-max 1/2｜BB 9♠8♠｜河牌 T♠7♦6♣ J♦ 7♣｜底池 177 筹码（88.5BB）｜身后 112（56BB）｜Hero 先行动');
report('无画像（UNKNOWN）', 'UNKNOWN', true);
report('普通常客（NORMAL）', 'NORMAL');
report('跟注站（CALLING_STATION）', 'CALLING_STATION');
report('极紧（VERY_TIGHT）', 'VERY_TIGHT');
report('疯子（MANIAC）', 'MANIAC');
