/**
 * BET DECISION ENGINE PHASE 1 · 验收探针（固定节点，输入不许改）
 *
 * 用法：`E:\node.exe --experimental-strip-types scripts/bet-decision-probe.ts`
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
const PREFLOP = [
  { position: 'UTG', type: 'FOLD' },
  { position: 'HJ', type: 'RAISE', amountBB: 3 },
  { position: 'CO', type: 'RAISE', amountBB: 9 },
  { position: 'BTN', type: 'FOLD' },
  { position: 'SB', type: 'FOLD' },
  { position: 'BB', type: 'FOLD' },
  { position: 'HJ', type: 'CALL', amountBB: 6 },
] as const;

function node(street: 'FLOP' | 'TURN', profile: string, heroCards: string[] = ['As', 'Js']): ManualHandInput {
  const flopHistory = [
    { position: 'HJ', type: 'CHECK', street: 'FLOP' },
    ...(street === 'TURN' ? [{ position: 'CO', type: 'CHECK', street: 'FLOP' }] : []),
    ...(street === 'TURN' ? [{ position: 'HJ', type: 'CHECK', street: 'TURN' }] : []),
  ];
  return {
    tableSize: 6, heroPosition: 'CO', heroCards: [...heroCards],
    board: street === 'FLOP' ? ['Qd', '8s', '4s'] : ['Qd', '8s', '4s', '2h'],
    street, effectiveStackBB: 100, bigBlindBB: 2, seatStacksBB: { ...SEATS },
    actionHistory: [...PREFLOP, ...flopHistory],
    environment: 'MID_LOW_STAKES',
    villain: { quickProfile: profile, dynamicHint: 'UNKNOWN', stackBB: 100 },
  } as unknown as ManualHandInput;
}

function report(label: string, input: ManualHandInput, verbose = false): void {
  const result = analyzeManualHand(input, OPTIONS);
  console.log(`\n════════ ${label} ════════`);
  if (!result.ok) {
    console.log(`  ❌ ${JSON.stringify(result.issues)}`);
    return;
  }
  const parsed = parseManualInput(input);
  if (!parsed.ok) return;
  const g = buildAnalyzableState(parsed.value);
  if (!g.ok) return;
  const built = buildDecisionContext({
    state: g.state, rules: RULES, environment: 'MID_LOW_STAKES', asOf: 1_757_000_000_000,
    quickProfile: input.villain?.quickProfile,
  });
  const hero = g.state.players.find((p) => p.holeCards !== null)!;
  const legal = deriveLegalActions(g.state, hero);
  const advice = advisePostflop(built.context, {
    facingBet: legal.callCost > 0,
    requiredEquity: built.context.math.requiredEquity,
    potAfterCall: built.context.math.pot + legal.callCost,
  });

  console.log(
    `  引擎：${String(result.decision.action)}${result.decision.sizeBB === undefined ? '' : ` ${result.decision.sizeBB}BB`}` +
      `｜置信度 ${result.decision.confidence.toFixed(2)}｜分类 ${result.decision.classification}` +
      `｜依据 ${result.decision.diagnostics.decisionBasis?.kind ?? '—'}`,
  );
  const m = result.decision.diagnostics.math;
  console.log(`  权益 ${((m.heroEquity ?? 0) * 100).toFixed(2)}%｜底池 ${m.pot}｜SPR ${m.spr?.toFixed(2) ?? '—'}`);

  const post = result.decision.diagnostics.postflop;
  if (post !== null) {
    console.log(
      `  偏好分：${post.evRanking.map((x) => `${x.action} ${x.score.toFixed(3)}`).join('  ')}`,
    );
    console.log(
      `  价值门：${String(post.valueAssessment['verdict'])}｜下注分 ${Number(post.valueAssessment['estimatedBetEVScore']).toFixed(3)}` +
        ` vs 过牌分 ${Number(post.valueAssessment['estimatedCheckEVScore']).toFixed(3)}`,
    );
  }
  const bd = advice?.betDecision ?? null;
  if (bd === null) {
    console.log('  （没有 betDecision：面对下注 / 无范围 / 翻前）');
    return;
  }
  console.log(
    `  听牌：${bd.draw.noteZh}`,
  );
  console.log(
    `  实现因子：${bd.realization.factor.toFixed(3)}（${bd.realization.kind}）｜CHECK EV ${bd.checkEV === null ? '—' : bd.checkEV.toFixed(2)}` +
      `｜最佳尺寸 ${bd.bestSize ?? '—'}（偏好分 ${bd.bestScore.toFixed(3)}）⇒ ${bd.preferredAction}`,
  );
  console.log(
    '  尺寸       比例  建模额  P(fold) P(call) P(raise)  EqVsCall EqVsRaise  EV_fold  EV_call  EV_raise   BetEV   分    桶组合数',
  );
  for (const s of bd.sizes) {
    const comboCounts = s.buckets.map((b) => b.comboCount).join('/');
    console.log(
      `  ${s.kind.padEnd(11)} ${(s.ratioToPot * 100).toFixed(0).padStart(4)}% ${s.betAmount.toFixed(1).padStart(6)}  ` +
        `${s.foldLikelihood.toFixed(3)}  ${s.callLikelihood.toFixed(3)}   ${s.raiseLikelihood.toFixed(3)}   ` +
        `${s.heroEquityVsCallRange === null ? '  —   ' : (s.heroEquityVsCallRange * 100).toFixed(2) + '%'}` +
        `${s.heroEquityVsRaiseRange === null ? '    —    ' : '  ' + (s.heroEquityVsRaiseRange * 100).toFixed(2) + '%  '}` +
        `${s.evFoldBranch.toFixed(1).padStart(8)} ${s.evCallBranch === null ? '   —   ' : s.evCallBranch.toFixed(1).padStart(8)}` +
        ` ${s.evRaiseBranch === null ? '   —   ' : s.evRaiseBranch.toFixed(1).padStart(8)}` +
        ` ${s.betEV === null ? '   —   ' : s.betEV.toFixed(2).padStart(8)} ${s.score.toFixed(3)}  ${comboCounts}`,
    );
  }
  console.log(
    `  画像证据：range层=${String(bd.profileEvidence.rangeLayerApplied)}｜scorer层=${String(bd.profileEvidence.scorerLayerApplied)}` +
      `｜已阻断重复=${String(bd.profileEvidence.doubleCountBlocked)}`,
  );
  if (verbose) {
    console.log(`  模型说明：${bd.modelNoteZh}`);
    console.log(`  响应倾向：${bd.tendencies.noteZh}`);
  }
}

console.log('BET DECISION ENGINE PHASE 1 · 固定节点验收');
report('TEST1 转牌 A♠J♠（NORMAL）', node('TURN', 'NORMAL'), true);
report('TEST2 翻牌 A♠J♠（NORMAL）', node('FLOP', 'NORMAL'), true);
report('TEST3a 转牌 · 跟注站', node('TURN', 'CALLING_STATION'));
report('TEST3b 转牌 · 紧手/过弃', node('TURN', 'VERY_TIGHT'));
report('TEST3c 转牌 · 疯子', node('TURN', 'MANIAC'));
report('TEST5a 转牌 · 纯空气（T♣9♦ 无听牌）', node('TURN', 'NORMAL', ['Tc', '9d']));
report('TEST5b 转牌 · 坚果同花听（A♠J♠）', node('TURN', 'NORMAL', ['As', 'Js']));
