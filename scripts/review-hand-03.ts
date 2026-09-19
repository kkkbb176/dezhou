/**
 * 真实牌局复盘「测试局 3」：6max · BTN A♥Q♣（河牌抓诈唬）
 *
 * 1/2，100BB。CO（偏激进、爱连续开火、河牌过度诈唬）开 2.5BB → Hero BTN 跟 → 其余弃
 * 翻牌 Q♠8♦3♣：CO 下注 2BB → Hero 跟（池 10.5BB）
 * 转牌 6♠：CO 下注 7BB → Hero 跟（池 24.5BB）
 * 河牌 K♠：CO 下注 20BB（82% 池）→ Hero 需跟 20BB，身后 68.5BB，需要 31.0% 权益
 *
 * 用法：`E:\node.exe --experimental-strip-types scripts/review-hand-03.ts`
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
const SEATS = { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 } as const;

const HISTORY = [
  { position: 'UTG', type: 'FOLD' },
  { position: 'HJ', type: 'FOLD' },
  { position: 'CO', type: 'RAISE', amountBB: 2.5 },
  { position: 'BTN', type: 'CALL', amountBB: 2.5 },
  { position: 'SB', type: 'FOLD' },
  { position: 'BB', type: 'FOLD' },
  { position: 'CO', type: 'BET', amountBB: 2, street: 'FLOP' },
  { position: 'BTN', type: 'CALL', amountBB: 2, street: 'FLOP' },
  { position: 'CO', type: 'BET', amountBB: 7, street: 'TURN' },
  { position: 'BTN', type: 'CALL', amountBB: 7, street: 'TURN' },
  { position: 'CO', type: 'BET', amountBB: 20, street: 'RIVER' },
] as const;

function run(profile: string, hint: string): void {
  const input = {
    tableSize: 6,
    heroPosition: 'BTN',
    heroCards: ['Ah', 'Qc'],
    board: ['Qs', '8d', '3c', '6s', 'Ks'],
    street: 'RIVER',
    effectiveStackBB: 100,
    bigBlindBB: 2,
    seatStacksBB: { ...SEATS },
    actionHistory: [...HISTORY],
    environment: 'MID_LOW_STAKES',
    villain: { quickProfile: profile, dynamicHint: hint, stackBB: 100 },
  } as unknown as ManualHandInput;

  const r = analyzeManualHand(input, OPTIONS);
  console.log(`\n════════ 对手画像 = ${profile} ｜ 动态提示 = ${hint} ════════`);
  if (!r.ok) {
    console.log(`  ❌ 分析失败 stage=${r.stage}：${JSON.stringify(r.issues)}`);
    return;
  }
  const m = r.decision.diagnostics.math;
  const bb = 2;
  console.log(
    `  建议：${r.viewModel.actionZh}${r.decision.sizeBB === undefined ? '' : `（${r.decision.sizeBB}BB）`}` +
      ` ｜ 置信度 ${r.viewModel.confidenceZh} ｜ 分类 ${r.decision.classification}`,
  );
  console.log(
    `  底池 ${m.pot} 筹码（${(m.pot / bb).toFixed(1)}BB）｜ 需补 ${m.callCost}（${(m.callCost / bb).toFixed(1)}BB）` +
      ` ｜ 身后 ${m.myRemainingStack}（${(m.myRemainingStack / bb).toFixed(1)}BB）｜ 所需权益 ${(m.requiredEquity * 100).toFixed(1)}%`,
  );
  console.log(
    `  权益 ${m.heroEquity === null ? '—' : (m.heroEquity * 100).toFixed(1) + '%'}` +
      ` ｜ 跟注 EV ${m.callEV === null ? '—' : m.callEV.toFixed(2) + ' 筹码'}` +
      ` ｜ 可争夺量 ${m.winnable} ｜ 牌力 ${m.handRankZh}`,
  );
  console.log(`  理由码：${r.decision.reasons.map((x) => x.code).join(', ')}`);
  for (const reason of r.decision.reasons.slice(0, 7)) {
    console.log(`    · [${reason.code}] ${reason.textZh.slice(0, 200)}`);
  }
  const post = r.decision.diagnostics.postflop;
  if (post !== undefined) {
    console.log(
      `  角色：${post.handRoleZh}（${post.handRole}）｜成交牌型 ${post.madeHandZh}｜强度 ${post.roleStrength.toFixed(2)}`,
    );
    console.log(
      `  范围：更强 ${(Number(post.valueAssessment['strongerShare']) * 100).toFixed(1)}%、更弱 ${(Number(post.valueAssessment['weakerShare']) * 100).toFixed(1)}%` +
        `｜偏好顺序 ${post.evRanking.map((x) => `${x.action} ${x.score.toFixed(3)}`).join(' > ')}`,
    );
    console.log(
      `  阻断牌：挡掉更强 ${String(post.blockers['blockedStrongerCombos'])} / 更弱 ${String(post.blockers['blockedWeakerCombos'])}` +
        `｜其中价值候选 ${String(post.blockers['blockedValueBetCandidateCount'])}、诈唬候选 ${String(post.blockers['blockedBluffCandidateCount'])}` +
        `｜净偏好 ${Number(post.blockers['netBlockerPreference']).toFixed(3)}（证据 ${String(post.blockers['evidenceQuality'])}）`,
    );
    console.log(`  决策依据：${post.decisionBasisKind}｜置信度 ${post.confidence}（差 ${post.confidenceGap.toFixed(3)}）`);
  }
  console.log(`  一致性：${r.decision.diagnostics.consistency?.ok === true ? '通过' : '—'}`);
  for (const w of r.viewModel.warningsZh) console.log(`  ⚠️ ${w.slice(0, 170)}`);

  const parsed = parseManualInput(input);
  if (parsed.ok) {
    const gate = buildAnalyzableState(parsed.value);
    if (gate.ok) {
      const hero = gate.state.players.find((p) => p.holeCards !== null)!;
      const legal = deriveLegalActions(gate.state, hero);
      const built = buildDecisionContext({
        state: gate.state,
        rules: RULES,
        environment: 'MID_LOW_STAKES',
        asOf: 1_757_000_000_000,
        quickProfile: profile,
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
          const c = facts.counts;
          console.log(
            `  【范围】可达 ${facts.supportSize}｜档位 0..5 = ${facts.tierHistogram.map(pct).join(' / ')}｜更强占比 ${pct(facts.strongerShare)}`,
          );
          if (c !== null) {
            console.log(
              `  【分类计数】价值候选 ${c.valueBetCandidateCount}、诈唬候选 ${c.bluffCandidateCount}、摊牌牌 ${c.showdownCount}、证据不足 ${c.uncertainCount}` +
                `（合计 ${c.reachableRangeCount}）`,
            );
          }
        }
        console.log(
          `  【门内部】我更强?${(g.strongerShare * 100).toFixed(1)}%｜更差能跟 ${g.worseCallDensity.toFixed(3)}｜更好继续 ${g.betterContinueDensity.toFixed(3)}` +
            `｜加注风险 ${g.raiseRisk.toFixed(3)}｜摊牌价值 ${g.showdownValue.toFixed(3)}`,
        );
        console.log(`  【剥削层】${advice.exploit.applied ? advice.exploit.reasonsZh.join('；').slice(0, 160) : '未触发'}`);
        console.log(`  【剥削层】bluffCatchDelta = ${advice.exploit.bluffCatchDelta.toFixed(4)}`);
      }
    }
  }
}

run('BLUFF_HEAVY', 'UNKNOWN');
run('NORMAL', 'UNKNOWN');
run('UNDERBLUFFER', 'UNKNOWN');
