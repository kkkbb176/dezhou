/**
 * V2.1 第一轮 · 补充指标探针
 *
 * 主脚本（`v21-small-scale-scenarios.ts`）在**面对下注**的节点上拿不到
 * 「对手对我的下注会怎么反应」（响应模型只在**无人下注**的下注决策节点构建）。
 * 本探针补三件事：
 *
 * 1. **无人下注节点**上的 Fold / Call / Raise 概率（A1 / A3 / C1 / C3），
 *    以及候选下注 EV、过牌 EV、最优/次优 EV 差 —— 这是行为层画像的作用面；
 * 2. **EV 差占底池比**（`mathDominance.evGapToPotRatio`）与
 *    `EqVsCall`（对跟注范围权益）的可用性核查；
 * 3. **决策稳定性**：对同一场景做「合理输入微扰」
 *    （下注额 ±1 个大盲内的连续取值），检查动作与尺度是否异常跳变。
 *
 * 复现：
 * ```text
 * node --experimental-strip-types scripts/v21-small-scale-supplement.ts
 * ```
 */

import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';
import { parseManualInput } from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import type { ManualHandInput } from '../src/app/manualInput/manualInput.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const OPTIONS = {
  rules: RULES,
  asOf: 1_757_000_000_000,
  writeLog: false,
  equitySeed: 20_260_913,
  budget: { softMs: 120_000, hardMs: 240_000 },
} as const;

const SEATS = {
  UTG: 100, UTG1: 100, UTG2: 100, LJ: 100, HJ: 100,
  CO: 100, BTN: 100, SB: 100, BB: 100,
};

const PRE = [
  { position: 'UTG', type: 'FOLD' },
  { position: 'UTG1', type: 'FOLD' },
  { position: 'UTG2', type: 'FOLD' },
  { position: 'LJ', type: 'FOLD' },
  { position: 'HJ', type: 'FOLD' },
  { position: 'CO', type: 'RAISE', amountBB: 2.5 },
  { position: 'BTN', type: 'FOLD' },
  { position: 'SB', type: 'FOLD' },
  { position: 'BB', type: 'CALL', amountBB: 1.5 },
] as const;

const F = (position: string, type: string, street: string, amountBB?: number) => ({
  position, type, street, ...(amountBB === undefined ? {} : { amountBB }),
});

type Node = {
  id: string;
  titleZh: string;
  heroCards: readonly [string, string];
  board: readonly string[];
  history: readonly Record<string, unknown>[];
  profiles: readonly { key: string; quickProfile: string }[];
};

/** 无人下注的河牌节点：Hero 决定「开火还是过牌」 */
const NO_BET_NODES: readonly Node[] = [
  {
    id: 'A1',
    titleZh: '跟注站 · 弱牌诈唬（空气，河牌对手过牌）',
    heroCards: ['9c', '8c'],
    board: ['Ad', 'Ks', '7h', '3c', '2d'],
    history: [
      ...PRE,
      F('BB', 'CHECK', 'FLOP'), F('CO', 'CHECK', 'FLOP'),
      F('BB', 'CHECK', 'TURN'), F('CO', 'CHECK', 'TURN'),
      F('BB', 'CHECK', 'RIVER'),
    ],
    profiles: [
      { key: 'NEUTRAL', quickProfile: 'NORMAL' },
      { key: 'STATION', quickProfile: 'CALLING_STATION' },
      { key: 'VERY_TIGHT', quickProfile: 'VERY_TIGHT' },
    ],
  },
  {
    id: 'A3',
    titleZh: '跟注站 · 边缘牌薄价值（一对 T，河牌对手过牌）',
    heroCards: ['Th', '9d'],
    board: ['Ah', 'Ts', '5c', '3d', '2h'],
    history: [
      ...PRE,
      F('BB', 'CHECK', 'FLOP'), F('CO', 'BET', 'FLOP', 2), F('BB', 'CALL', 'FLOP', 2),
      F('BB', 'CHECK', 'TURN'), F('CO', 'CHECK', 'TURN'),
      F('BB', 'CHECK', 'RIVER'),
    ],
    profiles: [
      { key: 'NEUTRAL', quickProfile: 'NORMAL' },
      { key: 'STATION', quickProfile: 'CALLING_STATION' },
      { key: 'VERY_TIGHT', quickProfile: 'VERY_TIGHT' },
    ],
  },
];

function inputOf(node: Node, quickProfile: string, riverBetBB?: number): ManualHandInput {
  const history = riverBetBB === undefined
    ? [...node.history]
    : [
        ...node.history.filter((a) => a['street'] !== 'RIVER'),
        F('BB', 'BET', 'RIVER', riverBetBB),
      ];
  return {
    tableSize: 9,
    heroPosition: 'CO',
    heroCards: [...node.heroCards],
    board: [...node.board],
    street: 'RIVER',
    effectiveStackBB: 100,
    bigBlindBB: 2,
    seatStacksBB: { ...SEATS },
    actionHistory: history,
    environment: 'MID_LOW_STAKES',
    villain: { quickProfile, dynamicHint: 'UNKNOWN', stackBB: 100 },
  } as unknown as ManualHandInput;
}

type M = Record<string, unknown>;

function run(node: Node, quickProfile: string, riverBetBB?: number): M {
  const input = inputOf(node, quickProfile, riverBetBB);
  const parsed = parseManualInput(input);
  if (!parsed.ok) return { fail: `PARSE ${JSON.stringify(parsed.issues)}` };
  const gate = buildAnalyzableState(parsed.value);
  if (!gate.ok) return { fail: `STATE ${JSON.stringify(gate.issues)}` };

  const built = buildDecisionContext({
    state: gate.state,
    rules: RULES,
    environment: 'MID_LOW_STAKES',
    asOf: 1_757_000_000_000,
    quickProfile: quickProfile as never,
  });
  const result = analyzeManualHand(input, OPTIONS);
  if (!result.ok) return { fail: `ANALYZE ${JSON.stringify(result.issues)}` };

  const ctx = built.context as unknown as Record<string, any>;
  const bd = (result.decision as unknown as Record<string, any>)
    ['diagnostics']?.['postflop']?.['betDecision'] as Record<string, any> | null;
  const math = ctx['math'] as Record<string, any>;
  const decision = result.decision as unknown as Record<string, any>;
  const diag = decision['diagnostics'] as Record<string, any>;
  const sizes = (bd?.['sizes'] ?? []) as readonly Record<string, any>[];
  const betEVs = sizes
    .map((s) => (s['betEV'] === null || s['betEV'] === undefined ? null : Number(s['betEV'])))
    .filter((x): x is number => x !== null)
    .sort((a, b) => b - a);
  const candidates = ((diag?.['candidates'] ?? []) as readonly Record<string, any>[]).map((c) => ({
    action: String(c['action']),
    sizeChips: c['sizeChips'] ?? null,
    ev: c['ev'] === null || c['ev'] === undefined ? null : Number(c['ev']),
  }));

  return {
    action: String(decision['action']),
    heroEquity: math['heroEquity'],
    callEV: math['callEV'],
    pot: math['pot'],
    winnable: math['winnable'],
    requiredEquity: math['requiredEquity'],
    potOdds: math['potOdds'],
    checkEV: bd?.['checkEV'] ?? null,
    sizes: sizes.map((s) => ({
      labelZh: s['labelZh'] ?? s['size'],
      ratio: Number(s['ratioToPot']),
      betAmount: Number(s['betAmount']),
      fold: Number(s['foldLikelihood']),
      call: Number(s['callLikelihood']),
      raise: Number(s['raiseLikelihood']),
      betEV: s['betEV'] === null || s['betEV'] === undefined ? null : Number(s['betEV']),
      deltaVsCheck: s['deltaVsCheck'] === null || s['deltaVsCheck'] === undefined ? null : Number(s['deltaVsCheck']),
      evCallBranch: s['evCallBranch'] ?? null,
      foldRangeMass: s['foldRangeMass'] ?? null,
      callRangeMass: s['callRangeMass'] ?? null,
      equityVsCallRange: s['heroEquityVsCallRange'] ?? null,
      equityMethod: s['equityMethod'] ?? null,
      equityIterations: s['equityIterations'] ?? null,
    })),
    bestBetEvGap: betEVs.length >= 2 ? betEVs[0]! - betEVs[1]! : null,
    bestBetEvGapToPot:
      betEVs.length >= 2 && Number(math['pot']) > 0 ? (betEVs[0]! - betEVs[1]!) / Number(math['pot']) : null,
    candidates,
    mathDominance: diag?.['mathDominance'] ?? null,
    profileEvidence: bd?.['profileEvidence'] ?? null,
  };
}

const out: string[] = [];
const log = (s: string): void => {
  out.push(s);
  console.log(s);
};

const f = (x: unknown, d = 4): string =>
  typeof x === 'number' && Number.isFinite(x) ? x.toFixed(d) : '—';
const pct = (x: unknown, d = 2): string =>
  typeof x === 'number' && Number.isFinite(x) ? `${(x * 100).toFixed(d)}%` : '—';
const pp = (a: unknown, b: unknown): string =>
  typeof a === 'number' && typeof b === 'number' ? `${((b - a) * 100 >= 0 ? '+' : '')}${((b - a) * 100).toFixed(2)}pp` : '—';

log('============================================================');
log(' V2.1 第一轮 · 补充指标（无人下注节点 = 行为层作用面）');
log('============================================================');
log('');

/* ============================================================
 * 1. 无人下注节点：对手 Fold/Call/Raise + 候选下注 EV
 * ============================================================ */
for (const node of NO_BET_NODES) {
  log('------------------------------------------------------------');
  log(`【${node.id}】${node.titleZh}`);
  log(`  我的位置：CO ｜ 我的手牌：${node.heroCards.join(' ')} ｜ 公共牌：${node.board.join(' ')}`);
  log('');

  const results = new Map<string, M>();
  for (const p of node.profiles) results.set(p.key, run(node, p.quickProfile));
  const neutral = results.get('NEUTRAL')!;

  for (const p of node.profiles) {
    const m = results.get(p.key)!;
    if (m['fail']) {
      log(`  ${p.key.padEnd(12)} ✖ ${String(m['fail'])}`);
      continue;
    }
    log(
      `  ${p.key.padEnd(12)} 动作=${String(m['action']).padEnd(6)} ` +
        `权益=${pct(m['heroEquity']).padEnd(8)} 过牌EV=${f(m['checkEV'], 2).padEnd(7)} ` +
        `底池=${f(m['pot'], 1).padEnd(6)} 门槛=${pct(m['requiredEquity'], 1)}`,
    );
    const sizes = m['sizes'] as readonly Record<string, unknown>[];
    for (const s of sizes) {
      log(
        `      ${String(s['labelZh']).padEnd(14)} ${(Number(s['ratio']) * 100).toFixed(0).padStart(3)}%池 ` +
          `${f(Number(s['betAmount']) / 2, 2).padStart(6)}BB ` +
          `弃${pct(s['fold'], 1).padStart(7)} 跟${pct(s['call'], 1).padStart(7)} 加${pct(s['raise'], 1).padStart(7)} ` +
          `BetEV=${f(s['betEV'], 3).padStart(7)} Δvs过牌=${f(s['deltaVsCheck'], 3).padStart(7)} ` +
          `EqVsCall=${pct(s['equityVsCallRange'], 1).padStart(7)} ${String(s['equityMethod'])}/${String(s['equityIterations'])}`,
      );
    }
    log(
      `      候选下注 EV 的最优/次优差 = ${f(m['bestBetEvGap'], 4)} 筹码（= 底池的 ${pct(m['bestBetEvGapToPot'], 2)}）`,
    );
    const md = m['mathDominance'] as Record<string, unknown> | null;
    log(
      `      mathDominance：dominant=${String(md?.['dominant'])} evGap=${f(md?.['evGap'], 4)} ` +
        `evGapToPotRatio=${pct(md?.['evGapToPotRatio'], 2)} 阈值=${pct(md?.['thresholdRatio'], 0)}`,
    );
    const cands = m['candidates'] as readonly Record<string, unknown>[];
    log(
      `      候选动作（diagnostics.candidates）：` +
        cands
          .map((c) => `${String(c['action'])}${c['sizeChips'] === null ? '' : `@${String(c['sizeChips'])}`}=${c['ev'] === null ? 'EV_NOT_AVAILABLE' : f(c['ev'], 3)}`)
          .join(' '),
    );
  }

  const st = results.get('STATION')!;
  const vt = results.get('VERY_TIGHT')!;
  if (!neutral['fail'] && !st['fail'] && !vt['fail']) {
    const s0 = (neutral['sizes'] as readonly Record<string, unknown>[])[0]!;
    const s1 = (st['sizes'] as readonly Record<string, unknown>[])[0]!;
    const s2 = (vt['sizes'] as readonly Record<string, unknown>[])[0]!;
    log('');
    log(`  Δ 对手弃牌率（第一档尺寸）STATION  vs 中性：${pp(s0['fold'], s1['fold'])}`);
    log(`  Δ 对手跟注率（第一档尺寸）STATION  vs 中性：${pp(s0['call'], s1['call'])}`);
    log(`  Δ 对手加注率（第一档尺寸）STATION  vs 中性：${pp(s0['raise'], s1['raise'])}`);
    log(`  Δ 对手弃牌率（第一档尺寸）TIGHT    vs 中性：${pp(s0['fold'], s2['fold'])}`);
    log(`  Δ 下注 EV（第一档尺寸）     STATION vs 中性：${f((s1['betEV'] as number) - (s0['betEV'] as number), 4)} 筹码`);
    log(`  Δ 下注 EV（第一档尺寸）     TIGHT   vs 中性：${f((s2['betEV'] as number) - (s0['betEV'] as number), 4)} 筹码`);
    log(`  Δ 最优/次优下注 EV 差       STATION vs 中性：${f((st['bestBetEvGap'] as number) - (neutral['bestBetEvGap'] as number), 4)} 筹码`);
    log(`  Δ 过牌 EV                   STATION vs 中性：${f((st['checkEV'] as number) - (neutral['checkEV'] as number), 4)} 筹码`);
    log(`  Δ 权益                      STATION vs 中性：${pp(neutral['heroEquity'], st['heroEquity'])}`);
  }
  log('');
}

/* ============================================================
 * 2. 面对下注节点：门槛与 EqVsCall 可用性
 * ============================================================ */
log('------------------------------------------------------------');
log(' 面对下注的节点：候选动作 EV / EqVsCall / 最优-次优差 的可用性');
log('------------------------------------------------------------');
{
  const node: Node = {
    id: 'B1',
    titleZh: 'B1 黄金节点（河牌 BB 下 7 = 75% 池）',
    heroCards: ['Ac', 'Jh'],
    board: ['Ad', '8s', '4s', '2c', 'Kd'],
    history: [
      ...PRE,
      F('BB', 'CHECK', 'FLOP'), F('CO', 'BET', 'FLOP', 2), F('BB', 'CALL', 'FLOP', 2),
      F('BB', 'CHECK', 'TURN'), F('CO', 'CHECK', 'TURN'),
      F('BB', 'BET', 'RIVER', 7),
    ],
    profiles: [
      { key: 'NEUTRAL', quickProfile: 'NORMAL' },
      { key: 'MANIAC', quickProfile: 'MANIAC' },
    ],
  };
  for (const p of node.profiles) {
    const m = run(node, p.quickProfile);
    if (m['fail']) {
      log(`  ${p.key} ✖ ${String(m['fail'])}`);
      continue;
    }
    log(
      `  ${p.key.padEnd(10)} 动作=${String(m['action'])} 权益=${pct(m['heroEquity'])} ` +
        `CallEV=${f(m['callEV'], 3)} 门槛=${pct(m['requiredEquity'], 2)} 底池赔率=${pct(m['potOdds'], 2)} ` +
        `可争夺量=${f(m['winnable'], 1)}`,
    );
    log(
      `      候选下注 EV=${(m['sizes'] as unknown[]).length === 0 ? 'NOT_AVAILABLE（我面对下注 ⇒ 响应模型不构建）' : JSON.stringify(m['sizes'])}` +
        ` ｜ mathDominance=${JSON.stringify(m['mathDominance'])}`,
    );
  }
  log('');
  log('  ---- 无人下注节点上「候选动作 EV」的真实字段名核查 ----');
  {
    const nb: Node = NO_BET_NODES[0]!;
    const input = inputOf(nb, 'NORMAL');
    const parsed = parseManualInput(input);
    if (parsed.ok) {
      const gate = buildAnalyzableState(parsed.value);
      if (gate.ok) {
        const built = buildDecisionContext({
          state: gate.state, rules: RULES, environment: 'MID_LOW_STAKES',
          asOf: 1_757_000_000_000, quickProfile: 'NORMAL' as never,
        });
        const ctx = built.context as unknown as Record<string, any>;
        const raw = ctx['postflopFacts']?.['betDecision'] as Record<string, any> | null;
        log(`  postflopFacts.betDecision.checkTree.checkEV = ${f(raw?.['checkTree']?.['checkEV'], 3)}`);
        const rawSizes = (raw?.['sizes'] ?? []) as readonly Record<string, unknown>[];
        log(`  原始 SizeResponseWithEquity 第一档的键：${Object.keys(rawSizes[0] ?? {}).join(', ')}`);
        log(`  原始第一档：${JSON.stringify(rawSizes[0], null, 2).split('\n').slice(0, 30).join('\n  ')}`);

        const advice = analyzeManualHand(input, OPTIONS);
        if (advice.ok) {
          const bd = (advice.decision as unknown as Record<string, any>)
            ['diagnostics']?.['postflop']?.['betDecision'] as Record<string, any> | null;
          log(`  diagnostics.postflop.betDecision 的键：${Object.keys(bd ?? {}).join(', ')}`);
          log(`  checkEV=${f(bd?.['checkEV'], 3)} checkScore=${f(bd?.['checkScore'], 3)}`);
          const ds = (bd?.['sizes'] ?? []) as readonly Record<string, unknown>[];
          log(`  诊断 sizes[0] 的键：${Object.keys(ds[0] ?? {}).join(', ')}`);
          log(`  诊断 sizes[0]：${JSON.stringify(ds[0], null, 2).split('\n').slice(0, 34).join('\n  ')}`);
        }
      }
    }
  }
}
log('');

/* ============================================================
 * 3. 决策稳定性：合理输入微扰
 * ============================================================ */
log('------------------------------------------------------------');
log(' 决策稳定性 A：跨尺寸档宽扫描（2–30 BB，覆盖 SMALL/MEDIUM/LARGE/OVERBET）');
log('------------------------------------------------------------');
{
  const node: Node = {
    id: 'STAB',
    titleZh: 'B1 节点外形，连续改变河牌下注额',
    heroCards: ['Ac', 'Jh'],
    board: ['Ad', '8s', '4s', '2c', 'Kd'],
    history: [
      ...PRE,
      F('BB', 'CHECK', 'FLOP'), F('CO', 'BET', 'FLOP', 2), F('BB', 'CALL', 'FLOP', 2),
      F('BB', 'CHECK', 'TURN'), F('CO', 'CHECK', 'TURN'),
    ],
    profiles: [],
  };
  const bets = [2, 3, 4, 5, 6, 7, 8, 10, 12, 15, 20, 25, 30];
  for (const profile of ['NORMAL', 'MANIAC']) {
    const rows: string[] = [];
    let prevAction: string | null = null;
    let flips = 0;
    let maxEqJump = 0;
    let prevEq: number | null = null;
    const eqSeen = new Set<string>();
    for (const bet of bets) {
      const m = run(node, profile, bet);
      if (m['fail']) {
        rows.push(`${bet}BB:✖`);
        continue;
      }
      const eq = m['heroEquity'] as number;
      eqSeen.add(eq.toFixed(6));
      if (prevEq !== null) maxEqJump = Math.max(maxEqJump, Math.abs(eq - prevEq));
      if (prevAction !== null && String(m['action']) !== prevAction) flips += 1;
      prevAction = String(m['action']);
      prevEq = eq;
      rows.push(`${bet}BB:${String(m['action'])},${(eq * 100).toFixed(2)}%`);
    }
    log(`  ${profile}：${rows.join('  ')}`);
    log(
      `  ⇒ 动作跳变次数=${flips}  相邻步最大权益跳变=${(maxEqJump * 100).toFixed(3)}pp  ` +
        `出现过的不同权益值=${eqSeen.size}/${bets.length}`,
    );
  }
}

log('');
log('------------------------------------------------------------');
log(' 决策稳定性 B：合理输入微扰（6.0–8.0 BB，步长 0.25 BB）');
log('------------------------------------------------------------');
{
  const node: Node = {
    id: 'STAB',
    titleZh: 'B1 节点外形，连续改变河牌下注额',
    heroCards: ['Ac', 'Jh'],
    board: ['Ad', '8s', '4s', '2c', 'Kd'],
    history: [
      ...PRE,
      F('BB', 'CHECK', 'FLOP'), F('CO', 'BET', 'FLOP', 2), F('BB', 'CALL', 'FLOP', 2),
      F('BB', 'CHECK', 'TURN'), F('CO', 'CHECK', 'TURN'),
    ],
    profiles: [],
  };
  for (const profile of ['NORMAL', 'MANIAC', 'CALLING_STATION']) {
    const rows: string[] = [];
    let prevAction: string | null = null;
    let flips = 0;
    let maxEqJump = 0;
    let prevEq: number | null = null;
    for (let bet = 6; bet <= 8.0001; bet += 0.25) {
      const m = run(node, profile, Number(bet.toFixed(2)));
      if (m['fail']) {
        rows.push(`${bet.toFixed(2)}✖`);
        continue;
      }
      const eq = m['heroEquity'] as number;
      if (prevEq !== null) maxEqJump = Math.max(maxEqJump, Math.abs(eq - prevEq));
      if (prevAction !== null && String(m['action']) !== prevAction) flips += 1;
      prevAction = String(m['action']);
      prevEq = eq;
      rows.push(`${bet.toFixed(2)}:${String(m['action'])},${(eq * 100).toFixed(2)}%`);
    }
    log(`  ${profile.padEnd(16)} ${rows.join(' ')}`);
    log(`  ⇒ 动作跳变次数=${flips}  相邻步最大权益跳变=${(maxEqJump * 100).toFixed(3)}pp`);
  }
}

log('');
log('============================================================');
log(' 说明：本探针不改变任何生产代码，只读取现有接口。');
log('============================================================');

const fs = await import('node:fs');
fs.mkdirSync('reports/evidence', { recursive: true });
fs.writeFileSync('reports/evidence/v21-supplement.out.txt', out.join('\n'), 'utf8');
