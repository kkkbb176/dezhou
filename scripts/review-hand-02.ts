/**
 * 真实牌局复盘「测试局 2」：6max · BB 9♠8♠
 *
 * 盲注 1/2，有效 100BB。UTG/HJ 弃 → CO 开 2.5BB → BTN/SB 弃 → Hero BB 跟 1.5BB
 * 翻牌 T♠7♦6♣（底池 5.5BB）：Hero 过牌 → CO 下注 2BB（36% 池）→ Hero 行动
 *
 * 用法：`E:\node.exe --experimental-strip-types scripts/review-hand-02.ts`
 */
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { advisePostflop } from '../src/app/decision/postflopAdvisor.ts';
import { deriveLegalActions } from '../src/app/manualInput/legalActions.ts';
import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';
import { parseManualInput } from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import type { ManualHandInput } from '../src/app/manualInput/manualInput.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const OPTIONS = { rules: RULES, asOf: 1_757_000_000_000, writeLog: false } as const;

/** 1BB = 2 筹码：UTG/HJ/BTN/SB 100BB、CO 110BB、Hero BB 100BB */
const SEATS = { UTG: 100, HJ: 100, CO: 110, BTN: 100, SB: 100, BB: 100 } as const;

const CO_FLOP_LINE = [
  { position: 'BB', type: 'CHECK', street: 'FLOP' },
  { position: 'CO', type: 'BET', amountBB: 2, street: 'FLOP' },
  { position: 'BB', type: 'RAISE', amountBB: 12, street: 'FLOP' },
  { position: 'CO', type: 'CALL', amountBB: 10, street: 'FLOP' },
] as const;

const NODES: readonly { label: string; board: readonly string[]; street: 'FLOP' | 'TURN' | 'RIVER'; history: readonly Record<string, unknown>[] }[] = [
  {
    label: '节点 ① 翻牌 T♠7♦6♣：Hero 过牌 → CO 下注 2BB（36% 池）',
    board: ['Ts', '7d', '6c'],
    street: 'FLOP',
    history: [
      { position: 'BB', type: 'CHECK', street: 'FLOP' },
      { position: 'CO', type: 'BET', amountBB: 2, street: 'FLOP' },
    ],
  },
  {
    label: '节点 ② 转牌 T♠7♦6♣—J♦：Hero 先行动（底池 29.5BB / 身后 85.5BB / SPR 2.9）',
    board: ['Ts', '7d', '6c', 'Jd'],
    street: 'TURN',
    history: [...CO_FLOP_LINE],
  },
  {
    label: '节点 ③ 河牌 T♠7♦6♣J♦—7♣（牌面对成）：Hero 先行动（底池 88.5BB / 身后 56BB / SPR 0.63）',
    board: ['Ts', '7d', '6c', 'Jd', '7c'],
    street: 'RIVER',
    history: [
      ...CO_FLOP_LINE,
      { position: 'BB', type: 'BET', amountBB: 29.5, street: 'TURN' },
      { position: 'CO', type: 'CALL', amountBB: 29.5, street: 'TURN' },
    ],
  },
];

for (const node of NODES) {
  const input = {
    tableSize: 6,
    heroPosition: 'BB',
    heroCards: ['9s', '8s'],
    board: [...node.board],
    street: node.street,
    effectiveStackBB: 100,
    bigBlindBB: 2,
    seatStacksBB: { ...SEATS },
    actionHistory: [
      { position: 'UTG', type: 'FOLD' },
      { position: 'HJ', type: 'FOLD' },
      { position: 'CO', type: 'RAISE', amountBB: 2.5 },
      { position: 'BTN', type: 'FOLD' },
      { position: 'SB', type: 'FOLD' },
      { position: 'BB', type: 'CALL', amountBB: 1.5 },
      ...node.history,
    ],
    environment: 'MID_LOW_STAKES',
    villain: { quickProfile: 'AGGRESSIVE', dynamicHint: 'UNKNOWN', stackBB: 110 },
  } as unknown as ManualHandInput;
  analyze(node.label, input);
}

function analyze(label: string, input: ManualHandInput): void {
  const r = analyzeManualHand(input, OPTIONS);
  console.log(`\n════════ ${label} ════════`);
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
      ` ｜ 有效筹码 ${m.effectiveStack}（${(m.effectiveStack / bb).toFixed(1)}BB）｜ SPR ${m.spr === null ? '—' : m.spr.toFixed(2)}`,
  );
  console.log(
    `  权益 ${m.heroEquity === null ? '—' : (m.heroEquity * 100).toFixed(1) + '%'}` +
      ` ｜ 所需权益 ${(m.requiredEquity * 100).toFixed(1)}% ｜ 跟注 EV ${m.callEV === null ? '—' : m.callEV.toFixed(1) + ' 筹码'}` +
      ` ｜ 牌力 ${m.handRankZh}`,
  );
  console.log(`  理由码：${r.decision.reasons.map((x) => x.code).join(', ')}`);
  for (const reason of r.decision.reasons.slice(0, 6)) {
    console.log(`    · [${reason.code}] ${reason.textZh.slice(0, 180)}`);
  }
  const post = r.decision.diagnostics.postflop;
  if (post !== undefined) {
    console.log(
      `  角色：${post.handRoleZh}（${post.handRole}）｜成交牌型 ${post.madeHandZh}｜强度 ${post.roleStrength.toFixed(2)}` +
        `｜范围：更强 ${(Number(post.valueAssessment['strongerShare']) * 100).toFixed(1)}%、更弱 ${(Number(post.valueAssessment['weakerShare']) * 100).toFixed(1)}%`,
    );
    console.log(`  承诺：${JSON.stringify(post.commitment)}`);
  }
  console.log(
    `  候选：${r.decision.diagnostics.candidates
      .map((c) => `${c.action}${c.sizeBB === undefined ? '' : `@${c.sizeBB}BB`}${c.ev === null ? '' : `(ev ${c.ev.toFixed(1)})`}`)
      .join(' ｜ ')}`,
  );
  console.log(`  一致性：${r.decision.diagnostics.consistency?.ok === true ? '通过' : '—'}`);

  const parsed = parseManualInput(input);
  if (parsed.ok) {
    const gate = buildAnalyzableState(parsed.value);
    if (gate.ok) {
      const hero = gate.state.players.find((p) => p.holeCards !== null)!;
      const legal = deriveLegalActions(gate.state, hero);
      console.log(
        `  合法动作：${legal.actions.join(', ')}${legal.minRaiseTo === undefined ? '' : ` ｜ 最小加注到 ${legal.minRaiseTo} 筹码`}` +
          ` ｜ 我的剩余 ${legal.myRemainingStack} 筹码`,
      );
      const built = buildDecisionContext({
        state: gate.state,
        rules: RULES,
        environment: 'MID_LOW_STAKES',
        asOf: 1_757_000_000_000,
      });
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
            `  【范围】可达 ${facts.supportSize}｜档位 0..5 = ${facts.tierHistogram.map(pct).join(' / ')}｜更强占比 ${pct(facts.strongerShare)}`,
          );
        }
        console.log(
          `  【门内部】湿润度 ${advice.wetness.toFixed(2)}｜更差能跟 ${g.worseCallDensity.toFixed(2)}｜更好继续 ${g.betterContinueDensity.toFixed(2)}` +
            `｜加注风险 ${g.raiseRisk.toFixed(2)}｜摊牌价值 ${g.showdownValue.toFixed(2)}｜下注偏好 ${g.estimatedBetEVScore.toFixed(3)} vs 过牌 ${g.estimatedCheckEVScore.toFixed(3)}`,
        );
        console.log(`  【尺码】建议尺寸 ${(advice.sizing.gridRatio * 100).toFixed(0)}% 底池`);
      }
    }
  }
}


