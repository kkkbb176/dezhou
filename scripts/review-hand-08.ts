/**
 * 真实牌局 8（测试局 2）：隔离加注成功一半 —— 翻牌三人池
 *
 * 使用者给出的局面（6-max 1/2）：
 *
 * ```text
 * 翻前：UTG limp 2｜HJ limp 2｜CO limp 2｜Hero BTN K♠Q♠ Raise 到 16（8BB）
 *       SB 弃｜BB 弃｜UTG 跟 14｜HJ 弃｜CO 跟 14
 * 翻牌：J♦ 8♣ 4♥｜底池 53（26.5BB）｜有效后手 = UTG 164（82BB）
 *       UTG CHECK｜CO CHECK ⇒ **轮到 Hero（BTN）**
 * ```
 *
 * 对手画像（使用者描述）：
 *   UTG：松弱、喜欢 limp-call     ⇒ LOOSE
 *   HJ ：普通偏被动（已弃牌）
 *   CO ：明显跟注站               ⇒ CALLING_STATION
 *   SB ：偏紧（已弃牌）｜BB：普通（已弃牌）
 *
 * ⚠️ 手动录入只支持**一个**画像，因此这里分别跑「主对手 = CO / UTG / 无画像」三遍，
 * 而不是把三个人的画像同时塞进去（那会编造数据）。
 *
 * 用法：`E:\node.exe --experimental-strip-types scripts/review-hand-08.ts`
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
    board: ['Jd', '8c', '4h'],
    street: 'FLOP',
    /** 有效后手 = 场上最短（UTG 164 筹码 = 82BB） */
    effectiveStackBB: 82,
    bigBlindBB: 2,
    seatStacksBB: { ...STACKS },
    /**
     * 🔴 **逐座位画像**（MULTIWAY RESPONSE TREE 新增能力）：
     * UTG = 松弱、CO = 跟注站 —— 两个人必须各有自己的响应模型。
     * （旧字段 `villain.quickProfile` 只能表达**一个**对手。）
     */
    seatProfiles: { UTG: 'LOOSE', CO: 'CALLING_STATION' },
    actionHistory: [
      { position: 'UTG', type: 'CALL', amountBB: 1 },
      { position: 'HJ', type: 'CALL', amountBB: 1 },
      { position: 'CO', type: 'CALL', amountBB: 1 },
      { position: 'BTN', type: 'RAISE', amountBB: 8 },
      { position: 'SB', type: 'FOLD' },
      { position: 'BB', type: 'FOLD' },
      { position: 'UTG', type: 'CALL', amountBB: 7 },
      { position: 'HJ', type: 'FOLD' },
      { position: 'CO', type: 'CALL', amountBB: 7 },
      { position: 'UTG', type: 'CHECK', street: 'FLOP' },
      { position: 'CO', type: 'CHECK', street: 'FLOP' },
    ],
    environment: 'MID_LOW_STAKES',
    ...(villainPlayerId === undefined ? {} : { villainPlayerId }),
    villain: { quickProfile: profile, dynamicHint: 'UNKNOWN', stackBB: 82 },
  } as unknown as ManualHandInput;
}

const num = (v: unknown, digits = 2): string => (typeof v === 'number' ? v.toFixed(digits) : '—');
const pct = (v: unknown, digits = 1): string =>
  typeof v === 'number' ? `${(v * 100).toFixed(digits)}%` : '—';

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
    `  建议：${String(d.action)}${d.sizeBB === undefined ? '' : `｜尺寸 ${d.sizeBB}BB`}` +
      `｜置信度 ${d.confidence.toFixed(2)}（${d.band}）｜分类 ${d.classification}`,
  );
  console.log(
    `  底池 ${m.pot}（${(m.pot / m.bigBlind).toFixed(1)}BB）｜需补 ${m.callCost}｜身后 ${m.myRemainingStack}` +
      `（${(m.myRemainingStack / m.bigBlind).toFixed(1)}BB）｜有效筹码 ${m.effectiveStack}｜SPR ${m.spr === null ? '—' : m.spr.toFixed(2)}` +
      `｜所需权益 ${pct(m.requiredEquity)}`,
  );
  console.log(
    `  权益 ${pct(m.heroEquity)}｜牌力 ${m.handRankZh}｜类别 ${m.handCategory}｜可争夺 ${m.winnable}` +
      `｜已实现对手 ${String(d.diagnostics.math === undefined ? '' : '')}`,
  );
  const margin = d.diagnostics.decisionMargin;
  if (margin !== undefined) {
    console.log(`  决策边际：${margin.kind ?? '—'}｜作用域 ${margin.scope}｜EV ${num(margin.evChips)} vs 带 ±${margin.bandChips.toFixed(2)}`);
  }
  const basis = d.diagnostics.decisionBasis;
  if (basis !== undefined) console.log(`  决策依据：${basis.kind}｜${basis.noteZh}`);
  const src = d.diagnostics.decisionSource;
  if (src !== null && src !== undefined) {
    console.log(
      `  动作来源：${String(src['kind'])}｜证据类型 ${String(src['estimateType'])}｜范围 ${String(src['evidenceScope'])}` +
        `｜阻断 ${String(src['overrideBlockedReason'] ?? '—')}`,
    );
  }

  /* ---- 下注决策模型（每个尺寸独立） ---- */
  const bd = d.diagnostics.betDecision ?? null;
  if (bd !== null) {
    console.log(
      `  【下注决策】CHECK EV ${num(bd['checkEV'])}｜最佳 ${String(bd['bestSize'] ?? 'CHECK')}` +
        `（偏好分 ${num(bd['bestScore'], 3)}）⇒ ${String(bd['preferredAction'])}`,
    );
    const sizes = (bd['sizes'] ?? []) as readonly Readonly<Record<string, unknown>>[];
    for (const s of sizes) {
      const label = `${String(s['kind'])}${s['labelZh'] === undefined ? '' : `（${String(s['labelZh'])}）`}`;
      console.log(
        `     · ${label} = ${num(s['betAmount'], 1)} 筹码（${pct(s['ratioToPot'], 0)} 池）` +
          `｜P(弃) ${num(s['foldLikelihood'])} / P(跟) ${num(s['callLikelihood'])} / P(加) ${num(s['raiseLikelihood'])}` +
          `｜EqVsCall ${pct(s['heroEquityVsCallRange'])}｜BetEV ${num(s['betEV'])}（ΔvsCHECK ${num(s['deltaVsCheck'])}）` +
          `｜分 ${num(s['score'], 3)}`,
      );
    }
    const draw = (bd['draw'] ?? {}) as Readonly<Record<string, unknown>>;
    const realization = (bd['realization'] ?? {}) as Readonly<Record<string, unknown>>;
    const evidence = (bd['evidence'] ?? {}) as Readonly<Record<string, unknown>>;
    console.log(`  【听牌】${String(draw['noteZh'] ?? '—')}`);
    console.log(
      `  【权益实现】factor ${num(realization['factor'], 3)}（${String(realization['kind'] ?? '—')}）` +
        `｜过牌分支 ${num(bd['checkRealizationFactor'], 3)}`,
    );
    console.log(
      `  【证据等级】概率 ${String(evidence['probabilities'])}｜条件范围权益 ${String(evidence['equityVsConditionalRanges'])}` +
        `｜权益实现 ${String(evidence['realization'])}｜被加注分支 ${String(evidence['raiseBranch'])}`,
    );
    console.log(`  【模型说明】${String(bd['modelNoteZh'] ?? '—')}`);
    const checkTree = (bd['checkTree'] ?? null) as Readonly<Record<string, unknown>> | null;
    if (checkTree !== null) {
      console.log(
        `  【CHECK 树】${String(checkTree['kind'])}｜${String(checkTree['noteZh'] ?? '')}`,
      );
    }
  }

  console.log('  理由：');
  for (const reason of d.reasons) console.log(`    · [${reason.code}] ${reason.textZh}`);

  /* ---- 多人联合响应树（§18） ---- */
  const mw = d.diagnostics.multiwayBetDecision ?? null;
  if (mw === null) {
    console.log('  【多人联合树】—（单挑节点 / 拿不到全部对手范围）');
  } else {
    console.log(`  【多人联合树】${mw.noteZh}`);
    console.log(`     · JOINT_MODEL = ${mw.jointModel}｜${mw.independenceAssumption}`);
    console.log(
      `     · 参与对手：${mw.opponents.map((o) => `${o.positionZh}(${o.comboCount} 组合, ${o.tendencyNoteZh})`).join('｜')}`,
    );
    console.log('     ── Per-opponent response ──');
    for (const r of mw.perOpponentResponse) {
      console.log(
        `     · ${r.positionZh} × ${String(r.kind)}（${r.betAmount.toFixed(1)} 筹码）：` +
          `弃 ${pct(r.foldProbability)} / 跟 ${pct(r.callProbability)} / 加 ${pct(r.raiseProbability)}` +
          `（封顶前加 ${pct(r.rawRaiseProbability)}｜弹性 ${r.foldElasticityVsPrevious === null ? '—' : r.foldElasticityVsPrevious.toFixed(3)}）` +
          `｜EqVsCall ${pct(r.heroEquityVsCallRange)}`,
      );
    }
    console.log('     ── Joint states ──');
    for (const s of mw.jointStates) {
      console.log(
        `     · ${String(s.kind)}（${s.betAmount.toFixed(1)} 筹码）：` +
          s.states.states
            .map((st) => `${st.kind}${st.callerId === null ? '' : `[${st.callerId}]`} ${pct(st.probability)}`)
            .join('｜') +
          `｜Σ=${s.states.total.toFixed(4)}`,
      );
    }
    console.log('     ── Conditional equity ──');
    for (const e of mw.conditionalEquities) {
      console.log(`     · ${String(e.kind)}（${e.betAmount.toFixed(1)} 筹码）：${e.noteZh}`);
    }
    console.log('     ── Branch EV ──');
    for (const b of mw.branchEVs) {
      console.log(`     · ${String(b.kind)}（${b.betAmount.toFixed(1)} 筹码）：`);
      for (const br of b.branches) {
        console.log(
          `        - ${br.kind}${br.callerId === null ? '' : `[${br.callerId}]`}｜p ${pct(br.probability)}` +
            `｜eq ${pct(br.heroEquity)}｜实现后 ${pct(br.realizedEquity)}｜底池 ${br.resultingPot.toFixed(1)}` +
            `｜Hero 投入 ${br.heroCostChips.toFixed(1)}｜EV ${num(br.ev)}`,
        );
      }
    }
    console.log('     ── Total BetEV ──');
    for (const t of mw.totalBetEV) {
      console.log(
        `     · ${String(t.kind)}（${t.betAmount.toFixed(1)} 筹码）：${num(t.totalEV)} 筹码｜证据 ${String(t.evKind)}`,
      );
    }
    console.log(`     · 尺寸饱和：${mw.sizeSaturation.status}｜${mw.sizeSaturation.reasonZh}`);
    console.log(
      `     · 弹性：${mw.sizeElasticity.map((e) => `${e.opponentId} [${e.foldDeltaPerSize.map((v) => v.toFixed(3)).join(', ')}]`).join('｜')}`,
    );
    console.log(`     · primaryOpponentUsedForEV = ${String(mw.primaryOpponentUsedForEV)}｜模型可信度 ${mw.modelConfidence}`);
  }

  /* ---- 对手范围 ---- */
  for (const snap of built.context.opponentRanges) {
    console.log(
      `  【对手范围】${snap.opponentPositionZh}｜组合 ${snap.supportSize}｜熵 ${snap.metrics.entropyBits.toFixed(2)}` +
        `｜来源 ${snap.sourceKind}｜可信度 ${snap.confidence.toFixed(2)}`,
    );
  }
  const facts = built.context.postflopFacts?.opponentRangeFacts ?? null;
  if (facts !== null) {
    console.log(
      `  【牌面适配（首要对手）】支持集 ${facts.supportSize}｜更强 ${num((facts as unknown as Record<string, unknown>)['strongerShare'], 3)}` +
        `｜更弱 ${num((facts as unknown as Record<string, unknown>)['weakerShare'], 3)}`,
    );
  }
  const evidenceProfile = built.context.profileRangeEvidence ?? null;
  if (evidenceProfile !== null) {
    console.log(
      `  【画像链路】${evidenceProfile.dimensionTierZh}｜provider 通道 ${String(evidenceProfile.provider.applied)}` +
        `｜权益 ${pct(evidenceProfile.equityBefore, 2)} → ${pct(evidenceProfile.equityAfter, 2)}` +
        (evidenceProfile.equityDeltaPct === null ? '' : `（Δ ${evidenceProfile.equityDeltaPct.toFixed(3)} 个百分点）`),
    );
  }
  console.log(`  合法动作：${legal.actions.join('/')}｜可过牌 ${legal.canCheck}｜可下注 ${legal.canBet}｜最小下注 ${legal.minBet}`);
  for (const w of built.warnings) console.log(`  ⚠️ ${w}`);
  if (verbose) {
    for (const dg of d.diagnostics.degradations) console.log(`  · [降级/${dg.impact}] ${dg.textZh}`);
    for (const w of result.warnings) console.log(`  ⚠️ ${w}`);
  }
}

console.log(
  '局面：6-max 1/2｜翻前 3 家 limp → Hero BTN K♠Q♠ 隔离加注 8BB → UTG/CO 跟，HJ/SB/BB 弃\n' +
    '翻牌 J♦ 8♣ 4♥｜底池 53（26.5BB）｜UTG CHECK｜CO CHECK ⇒ 轮到 Hero（BTN）｜有效后手 164（82BB）',
);
report('主对手 = CO（跟注站 → CALLING_STATION）', 'CALLING_STATION', 'seat_CO', true);
report('主对手 = UTG（松弱 → LOOSE）', 'LOOSE', 'seat_UTG', true);
report('无画像（UNKNOWN）', 'UNKNOWN', undefined, true);
report('主对手 = CO（普通 NORMAL，对照）', 'NORMAL', 'seat_CO');
