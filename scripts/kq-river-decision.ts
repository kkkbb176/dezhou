/**
 * ============================================================================
 * 单节点生产决策 —— Hero BTN K♠Q♠｜K♦9♣4♥6♠2♦｜河牌面对 BB 老周下注 20
 * ============================================================================
 *
 * 只读：调用生产入口 `analyzeManualHand`，把该节点的决策与全部相关诊断原样打印。
 * 使用者给定的手牌与统计（**合成测试输入**，不编造缺失项）：
 *
 * ```text
 * 有效筹码 200 筹码（100BB）｜Hero BTN K♠Q♠｜最终公共牌 K♦9♣4♥6♠2♦
 * 行动：UTG/HJ/CO 弃｜BTN 加注到 6｜SB 弃｜BB 跟注        → 底池 13
 *       翻牌 BB 过牌、BTN 下注 5、BB 跟注                → 底池 23
 *       转牌 BB 过牌、BTN 下注 15、BB 跟注               → 底池 53
 *       河牌 BB 主动下注 20                             → 底池 73，Hero 需补 20，剩余 174
 * 画像：老周 = CALLING_STATION，1200 手实测统计（VPIP 49 / PFR 9 / 3Bet 3 / WTSD 42 /
 *       Fold to Flop CBet 23 / Fold to Turn CBet 19 / Fold to River Bet 16 / River Check-Raise 2）
 *       Flop Check-Raise / Turn Check-Raise 及其余未提供的统计 → **null（不编造）**
 * ```
 */
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import type { ManualHandInput } from '../src/app/manualInput/manualInput.ts';

const OPTIONS = {
  rules: (await import('../src/domain/knowledge/knowledgeLoader.ts')).loadKnowledgeBaseOrThrow().allRules(),
  asOf: 1_757_000_000_000,
  writeLog: false,
  equitySeed: 20_261_014,
  budget: { softMs: 120_000, hardMs: 240_000 },
} as const;

const A = (position: string, type: string, amountBB?: number, street?: string) => ({
  position, type,
  ...(amountBB === undefined ? {} : { amountBB }),
  ...(street === undefined ? {} : { street }),
});

const input: ManualHandInput = {
  tableSize: 6,
  heroPosition: 'BTN',
  heroCards: ['Ks', 'Qs'],
  board: ['Kd', '9c', '4h', '6s', '2d'],
  street: 'RIVER',
  effectiveStackBB: 100,
  bigBlindBB: 2,
  seatStacksBB: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 },
  actionHistory: [
    A('UTG', 'FOLD'), A('HJ', 'FOLD'), A('CO', 'FOLD'), A('BTN', 'RAISE', 3), A('SB', 'FOLD'), A('BB', 'CALL', 2),
    A('BB', 'CHECK', undefined, 'FLOP'), A('BTN', 'BET', 2.5, 'FLOP'), A('BB', 'CALL', 2.5, 'FLOP'),
    A('BB', 'CHECK', undefined, 'TURN'), A('BTN', 'BET', 7.5, 'TURN'), A('BB', 'CALL', 7.5, 'TURN'),
    A('BB', 'BET', 10, 'RIVER'),
  ],
  environment: 'MID_LOW_STAKES',
  villain: {
    playerId: '老周',
    quickProfile: 'CALLING_STATION',
    dynamicHint: 'UNKNOWN',
    stackBB: 100,
    /* 合成测试统计：未提供的统计一律 null（不编造） */
    observedStats: {
      handsObserved: 1200,
      vpip: 0.49,
      pfr: 0.09,
      threeBet: 0.03,
      wtsd: 0.42,
      foldToFlopCBet: 0.23,
      foldToTurnCBet: 0.19,
      foldToRiverBet: 0.16,
      flopCheckRaise: null,
      turnCheckRaise: null,
      riverCheckRaise: 0.02,
    },
  },
} as unknown as ManualHandInput;

const r = analyzeManualHand(input, OPTIONS);
if (!r.ok) {
  console.log(`分析失败：${r.stage} ${JSON.stringify(r.issues)}`);
  process.exit(1);
}

const line = (s = ''): void => console.log(s);
const num = (v: unknown, d = 4): string => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : '—');
const pct = (v: unknown, d = 1): string => (typeof v === 'number' && Number.isFinite(v) ? `${(v * 100).toFixed(d)}%` : '—');
const pad = (s: string, w: number): string => {
  const len = [...s].reduce((a, c) => a + (c.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
  return s + ' '.repeat(Math.max(0, w - len));
};

const d = r.decision as unknown as Record<string, any>;
const dg = d['diagnostics'] as Record<string, any>;
const math = dg['math'] as Record<string, any>;
const pf = (dg['postflop'] ?? {}) as Record<string, any>;
const facts = (pf['raiseResponse'] ?? null) as Record<string, any> | null;
const ev = (act: string): Record<string, any> | undefined =>
  ((dg['actionEvidence'] ?? []) as Record<string, any>[]).find((e) => e['action'] === act);

line('='.repeat(104));
line(' Hero BTN K♠Q♠｜K♦9♣4♥6♠2♦｜河牌面对 BB「老周」（跟注站 + 1200 手实测统计）下注 20');
line('='.repeat(104));
line('');
line('【节点事实（引擎重算）】');
line(`  底池（决策时，含他这一注） = ${num(math['pot'], 0)}｜需跟注 = ${num(math['callCost'], 0)}｜Hero 剩余 = ${num(math['myRemainingStack'], 0)}`);
line(`  所需权益 = ${pct(math['requiredEquity'], 2)}｜可争夺量 winnable = ${num(math['winnable'], 0)}｜SPR = ${num(math['spr'], 2)}`);
line(`  牌力 = ${String(math['handRankZh'])}｜类别 = ${num(math['handCategory'], 0)}｜牌面相对档 tier = ${String(math['tier'])}`);
line('');
line('【对手画像证据】');
const pr = (dg['profileRange'] ?? null) as Record<string, any> | null;
if (pr !== null) {
  line(`  范围链路画像证据：${String(pr['noteZh'] ?? '').slice(0, 200)}`);
} else {
  line('  （无范围链路画像证据字段）');
}
const tend = dg['player'] as Record<string, any> | undefined;
line(`  player 摘要：${tend === undefined ? '—' : JSON.stringify(tend).slice(0, 260)}`);
line('');
line('【三个动作的 EV（同一节点增量口径：零点 = 弃牌 ≡ 0）】');
for (const act of ['FOLD', 'CALL', 'RAISE']) {
  const e = ev(act);
  line(`  ${pad(act, 7)}${e === undefined ? '（证据表中没有该动作）' : `estimateType = ${pad(String(e['estimateType']), 22)}ev = ${num(e['ev'], 6)}｜边际 = ${String(e['decisionMargin'])}`}`);
}
line('');
line('【最终动作】');
line(`  Final Action        = ${String(d['action'])}`);
line(`  Recommended Size    = ${d['sizeChips'] == null ? '—（弃牌/过牌无尺寸）' : `${num(d['sizeChips'], 0)} 筹码（${num((d['sizeBB'] ?? 0), 1)}BB）`}`);
line(`  动作形态            = ${String((dg['actionShape'] ?? {})['kind'])}｜${String((dg['actionShape'] ?? {})['noteZh'])}`);
line(`  decisionSource      = ${String((dg['decisionSource'] ?? {})['kind'])}｜${String((dg['decisionSource'] ?? {})['noteZh'] ?? '').slice(0, 160)}`);
line(`  置信度              = ${num(d['confidence'], 3)}（${String(d['band'])}）｜classification = ${String(d['classification'])}`);
line('');
line('【条件权益（三把尺子必须分开）】');
const cond = (dg['conditionalEquities'] ?? {}) as Record<string, any>;
line(`  EqVsArrivalRange        = ${num(cond['arrivalRange'], 6)}`);
line(`  EqVsBetRange            = ${num(cond['betRange'], 6)}   ← CALL EV 与加注门槛用它`);
line(`  math.heroEquity（整体）  = ${num(cond['wholeRange'], 6)}`);
line(`  EqVsRaiseCallRange      = ${num(cond['raiseContinueRange'] === 'NOT_IMPLEMENTED' ? NaN : cond['raiseContinueRange'], 6)}`);
line(`  加注门槛实际读取         = ${String(cond['usedByRaiseThreshold'])}`);
line('');
line('【加注（U1 模型）】');
if (facts === null) {
  line('  本节点没有加注响应事实（引擎已如实标注为「未评估」，不得当作 EV = 0）');
} else {
  line(`  Best RAISE Size        = ${num(facts['sizeChips'], 0)} 筹码（${num(facts['sizeBB'], 1)}BB）｜资金口径 ${String(facts['cashflowContract'])}`);
  line(`  RAISE EV               = ${num(facts['raiseEV'], 6)}（${String(facts['evKind'])}）`);
  line(`  资金：底池 ${num(facts['currentPot'], 0)}｜我方新增 ${num(facts['heroAdd'], 0)}（留在池中 ${num(facts['heroContestedAdd'], 0)}，退回 ${num(facts['uncalledReturn'], 0)}）｜他补 ${num(facts['villainAdd'], 0)}｜终池 ${num(facts['finalPot'], 0)}`);
  line(`  Villain Fold / Call / Reraise = ${pct(facts['foldLikelihood'], 2)} / ${pct(facts['callLikelihood'], 2)} / ${pct(facts['reRaiseLikelihood'], 2)}`);
  line(`  对手跟注所需权益（价格）  = ${num((facts['model'] ?? {})['priceRequiredEquity'], 6)}｜余量 ${num((facts['model'] ?? {})['margin'], 2)}`);
  line(`  EqVsRaiseCallRange     = ${num(facts['heroEquityVsRaiseCallRange'], 6)}（${String(facts['equityMethod'])}，${num(facts['equityIterations'], 0)} 次）`);
  line(`  跟注桶组合数            = ${num(facts['callCombos'], 0)}／可达 ${num(facts['reachableCombos'], 0)}`);
  line('  复算式（引擎自述）：');
  line(`    ${String(facts['noteZh'])}`);
  line('  假设：');
  for (const a of (facts['assumptionsZh'] ?? []) as string[]) line(`    · ${a}`);
}
line('');
line('【全下保护 / 未评估动作】');
line(`  allInGuard = ${JSON.stringify(dg['allInGuard'])}`);
const un = (dg['unevaluatedActions'] ?? []) as Record<string, any>[];
line(`  未评估的合法动作（${un.length} 项）：${un.length === 0 ? '无' : un.map((u) => `${String(u['action'])}@${String(u['sizeChips'])}`).join('、')}`);
line('');
line('【合法动作与候选尺寸】');
line(`  legalActions = ${JSON.stringify(dg['legalActions'])}｜本街总额上限 allInTo = ${num((dg['actionShape'] ?? {})['allInToAmount'], 0)}`);
const cands = (dg['candidates'] ?? []) as Record<string, any>[];
line(`  候选：${cands.map((c) => `${String(c['action'])}${c['sizeChips'] == null ? '' : `@${String(c['sizeChips'])}`}${c['ev'] == null ? '' : `(ev=${num(c['ev'], 2)})`}`).join('｜')}`);
line('');
line('【最终动作依据链（首屏理由，最多 6 条）】');
for (const x of (d['reasons'] ?? []) as Record<string, any>[]) {
  line(`  · [${String(x['code'])}] ${String(x['textZh'])}`);
}
line('');
line('【管线警告】');
line(r.warnings.length === 0 ? '  无' : r.warnings.map((w) => `  · ${w}`).join('\n'));
line('');
/* ---- Task C：把诊断里所有与「画像 / 统计证据」有关的块原样打印出来 ---- */
line('【画像与统计证据（诊断原文，供 Task C 溯源）】');
const keys = Object.keys(dg).filter((k) => /player|profile|stat|tendenc|behavior/i.test(k));
line(`  诊断中相关字段：${keys.join('、')}`);
for (const k of keys) {
  line(`  ── ${k} ──`);
  line(`  ${JSON.stringify(dg[k]).slice(0, 1200)}`);
}
if (pr !== null) line(`  ── profileRange ──\n  ${JSON.stringify(pr).slice(0, 900)}`);
line('');
line('='.repeat(104));
