/**
 * 真实牌局复盘「测试局 1」：6max · CO A♠J♠
 *
 * 节点 ①（翻前）：盲注 1/2，有效 100BB；UTG 弃 → HJ 开 3BB → Hero CO 行动
 * 节点 ②（翻牌）：Hero 3bet 到 9BB，HJ 跟 6BB（其余全弃）；底池 19.5BB，身后 81BB，SPR 4.15
 *                牌面 Q♦8♠4♠，HJ 过牌 → Hero 行动
 *
 * 用法：`E:\node.exe --experimental-strip-types scripts/review-hand-01.ts`
 */
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import { deriveLegalActions } from '../src/app/manualInput/legalActions.ts';
import { parseManualInput } from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';
import { advisePostflop } from '../src/app/decision/postflopAdvisor.ts';
import type { ManualHandInput } from '../src/app/manualInput/manualInput.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const OPTIONS = { rules: RULES, asOf: 1_757_000_000_000, writeLog: false } as const;

/** 1BB = 2 筹码 ⇒ 起始筹码（BB）：240/180/200/260/190/220 筹码 */
const SEATS = { UTG: 120, HJ: 90, CO: 100, BTN: 130, SB: 95, BB: 110 } as const;

/** 翻前完整动作：UTG 弃 → HJ 开 3BB → CO 3bet 到 9BB → BTN/SB/BB 弃 → HJ 跟 6BB */
const PREFLOP = [
  { position: 'UTG', type: 'FOLD' },
  { position: 'HJ', type: 'RAISE', amountBB: 3 },
  { position: 'CO', type: 'RAISE', amountBB: 9 },
  { position: 'BTN', type: 'FOLD' },
  { position: 'SB', type: 'FOLD' },
  { position: 'BB', type: 'FOLD' },
  { position: 'HJ', type: 'CALL', amountBB: 6 },
] as const;

function run(label: string, input: ManualHandInput): void {
  console.log(`\n════════ ${label} ════════`);
  const r = analyzeManualHand(input, OPTIONS);
  if (!r.ok) {
    console.log(`  ❌ 分析失败 stage=${r.stage}：${JSON.stringify(r.issues)}`);
    return;
  }
  const m = r.decision.diagnostics.math;
  const bb = 2;
  console.log(
    `  建议：${r.viewModel.actionZh}` +
      `${r.decision.sizeBB === undefined ? '' : ` ｜ 尺寸 ${r.decision.sizeBB}BB（${r.decision.sizeChips} 筹码）`}` +
      ` ｜ 置信度 ${r.viewModel.confidenceZh} ｜ 分类 ${r.decision.classification}`,
  );
  console.log(
    `  底池 ${m.pot} 筹码（${(m.pot / bb).toFixed(1)}BB）｜ 需补 ${m.callCost}（${(m.callCost / bb).toFixed(1)}BB）` +
      ` ｜ 有效筹码 ${m.effectiveStack}（${(m.effectiveStack / bb).toFixed(0)}BB）｜ SPR ${m.spr === null ? '—' : m.spr.toFixed(2)}`,
  );
  console.log(
    `  权益 ${m.heroEquity === null ? '—' : (m.heroEquity * 100).toFixed(1) + '%'}` +
      ` ｜ 所需权益 ${(m.requiredEquity * 100).toFixed(1)}% ｜ 牌力 ${m.handRankZh}`,
  );
  console.log(`  理由码：${r.decision.reasons.map((x) => x.code).join(', ')}`);
  for (const reason of r.decision.reasons.slice(0, 6)) {
    console.log(`    · [${reason.code}] ${reason.textZh.slice(0, 170)}`);
  }
  const post = r.decision.diagnostics.postflop;
  if (post !== undefined) {
    console.log(
      `  角色：${post.handRoleZh}（${post.handRole}）｜成交牌型 ${post.madeHandZh}｜强度 ${post.roleStrength.toFixed(2)}`,
    );
    console.log(
      `  价值判断：${String(post.valueAssessment['verdict'])}（下注偏好 ${Number(post.valueAssessment['estimatedBetEVScore']).toFixed(2)}` +
        ` vs 过牌偏好 ${Number(post.valueAssessment['estimatedCheckEVScore']).toFixed(2)}）`,
    );
    console.log(
      `  范围占比：更差 ${(Number(post.valueAssessment['weakerShare']) * 100).toFixed(1)}%、` +
        `更好 ${(Number(post.valueAssessment['strongerShare']) * 100).toFixed(1)}%` +
        (post.rangeCounts === null
          ? ''
          : `｜组合数：价值候选 ${String(post.rangeCounts['valueBetCandidateCount'])}、诈唬候选 ${String(post.rangeCounts['bluffCandidateCount'])}`),
    );
    console.log(
      `  决策依据：${post.decisionBasisKind}｜偏好顺序：${post.evRanking.map((x) => `${x.action} ${x.score.toFixed(2)}`).join(' > ')}`,
    );
  }
  console.log(
    `  候选：${r.decision.diagnostics.candidates
      .map((c) => `${c.action}${c.sizeBB === undefined ? '' : `@${c.sizeBB}BB`}`)
      .join(' ｜ ')}`,
  );
  console.log(`  一致性：${r.decision.diagnostics.consistency?.ok === true ? '通过' : '—'}`);
  for (const w of r.viewModel.warningsZh) console.log(`  ⚠️ ${w.slice(0, 150)}`);

  const parsed = parseManualInput(input);
  if (parsed.ok) {
    const gate = buildAnalyzableState(parsed.value);
    if (gate.ok) {
      const hero = gate.state.players.find((p) => p.holeCards !== null)!;
      const legal = deriveLegalActions(gate.state, hero);
      console.log(
        `  合法动作：${legal.actions.join(', ')}` +
          `${legal.minRaiseTo === undefined ? '' : ` ｜ 最小加注到 ${legal.minRaiseTo} 筹码`}` +
          ` ｜ 我的剩余 ${legal.myRemainingStack} 筹码`,
      );
    }
  }

  /* ---- 只读：把价值守门器的内部量也打出来（用于解释「为什么是 0.00」）---- */
  if (parsed.ok) {
    const gate = buildAnalyzableState(parsed.value);
    if (gate.ok) {
      const built = buildDecisionContext({
        state: gate.state,
        rules: RULES,
        environment: 'MID_LOW_STAKES',
        asOf: 1_757_000_000_000,
      });
      const hero = gate.state.players.find((p) => p.holeCards !== null)!;
      const legal = deriveLegalActions(gate.state, hero);
      const advice = advisePostflop(built.context, {
        facingBet: legal.callCost > 0,
        requiredEquity: built.context.math.requiredEquity,
        potAfterCall: built.context.math.pot + legal.callCost,
      });
      if (advice !== null) {
        const g = advice.gate;
        const facts = built.context.postflopFacts?.opponentRangeFacts ?? null;
        if (facts !== null) {
          const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
          console.log(
            `  【范围】可达 ${facts.supportSize} 组合｜档位分布 0..5 = ${facts.tierHistogram.map(pct).join(' / ')}` +
              `｜平均档 ${facts.meanTier.toFixed(2)}｜真听牌质量 ${pct(facts.drawShare)}`,
          );
        }
        console.log(
          `  【门内部】湿润度 ${advice.wetness.toFixed(2)}｜更差占比 ${(g.weakerShare * 100).toFixed(1)}%｜更好占比 ${(g.strongerShare * 100).toFixed(1)}%`,
        );
        console.log(
          `  【门内部】更好牌继续密度 ${g.betterContinueDensity.toFixed(2)}（罚 ×0.35 = ${(-g.betterContinueDensity * 0.35).toFixed(3)}）` +
            `｜被加注风险 ${g.raiseRisk.toFixed(2)}（罚 ×0.20 = ${(-g.raiseRisk * 0.2).toFixed(3)}）`,
        );
        console.log(
          `  【门内部】更差牌能跟密度 ${g.worseCallDensity.toFixed(2)}｜摊牌价值 ${g.showdownValue.toFixed(2)}` +
            `｜未来补牌保护分 ${g.futureCardProtectionScore.toFixed(2)}（加 ×0.15 = ${(g.futureCardProtectionScore * 0.15).toFixed(3)}）` +
            `｜空气密度 ${advice.compression.airDensity.toFixed(2)}`,
        );
        console.log(
          `  【门内部】下注偏好 ${g.estimatedBetEVScore.toFixed(3)} vs 过牌偏好 ${g.estimatedCheckEVScore.toFixed(3)}｜判定 ${g.verdict}｜指标 ${g.metricKind}`,
        );
      }
    }
  }
}

/* ---------------- 节点 ①：翻前面对 HJ 开池 ---------------- */
run('节点 ① 翻前：CO A♠J♠ 面对 HJ 开 3BB（画像=跟注站）', {
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
  villain: { quickProfile: 'CALLING_STATION', dynamicHint: 'UNKNOWN', stackBB: 90 },
} as unknown as ManualHandInput);

/* ---------------- 节点 ②：翻牌 Q♦8♠4♠，HJ 过牌 ---------------- */
run('节点 ② 翻牌：Q♦8♠4♠，HJ 过牌（底池 19.5BB / 身后 81BB / SPR 4.15）', {
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
  villain: { quickProfile: 'CALLING_STATION', dynamicHint: 'UNKNOWN', stackBB: 90 },
} as unknown as ManualHandInput);

/* ---------------- 节点 ③：转牌 2♥（翻牌过牌-过牌），HJ 再次过牌 ---------------- */
run('节点 ③ 转牌：Q♦8♠4♠—2♥（翻牌双方过牌），HJ 再次过牌', {
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
  villain: { quickProfile: 'CALLING_STATION', dynamicHint: 'UNKNOWN', stackBB: 90 },
} as unknown as ManualHandInput);

/* ---------------- 节点 ④：河牌 3♣（翻牌/转牌全过牌，听牌未成），HJ 第三次过牌 ---------------- */
run('节点 ④ 河牌：Q♦8♠4♠2♥—3♣（A 高未成花），HJ 第三次过牌', {
  tableSize: 6,
  heroPosition: 'CO',
  heroCards: ['As', 'Js'],
  board: ['Qd', '8s', '4s', '2h', '3c'],
  street: 'RIVER',
  effectiveStackBB: 100,
  bigBlindBB: 2,
  seatStacksBB: { ...SEATS },
  actionHistory: [
    ...PREFLOP,
    { position: 'HJ', type: 'CHECK', street: 'FLOP' },
    { position: 'CO', type: 'CHECK', street: 'FLOP' },
    { position: 'HJ', type: 'CHECK', street: 'TURN' },
    { position: 'CO', type: 'CHECK', street: 'TURN' },
    { position: 'HJ', type: 'CHECK', street: 'RIVER' },
  ],
  environment: 'MID_LOW_STAKES',
  villain: { quickProfile: 'CALLING_STATION', dynamicHint: 'UNKNOWN', stackBB: 90 },
} as unknown as ManualHandInput);

