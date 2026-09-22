/**
 * ============================================================================
 * RAISE DECISION · 阶段 A/B 基线事实探针（**只读，不改任何生产行为**）
 * ============================================================================
 *
 * 用途：在动任何代码之前，用**真实生产入口**记录「翻前加注决策」当前的事实。
 * 每一条都必须是可复现的输出，而不是对代码的阅读印象。
 *
 * 运行：`node --experimental-strip-types scripts/rr-audit-baseline.ts`
 *
 * 探针逐节输出：
 *   S1  BB vs BTN 单挑：Hero 面对 BTN 开池时的候选 / EV / 建议
 *   S2  同局的合法尺寸网格与每个尺寸的可执行性
 *   S3  翻前加注是否拥有自有 EV（响应概率 / 条件范围 / raiseEV）
 *   S4  2.5 → 10 → 22 之后的最小再加注（引擎口径）
 *   S5  短全下 / 加注权 / 无人能跟
 *   S6  Hero 面对 4bet 时评估了哪些应对（FOLD / CALL / 5bet）
 */

import { Position } from '../src/domain/types.ts';
import { createTable } from '../src/app/table/tableState.ts';
import { applyTableOp, engineViewOf } from '../src/app/table/tableOps.ts';
import { buildTablePreview } from '../src/app/table/tablePreview.ts';
import { tableStateToManualHandInput } from '../src/app/table/tableAdapter.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import { parseManualInput, type ManualInputParse } from '../src/app/manualInput/manualInput.ts';
import { deriveLegalActions, buildSizeGrid, potOf } from '../src/app/manualInput/legalActions.ts';
import { minRaiseTo, type GameState, type ActionCommand } from '../src/domain/poker/gameState.ts';
import { applyAction } from '../src/domain/poker/engine.ts';
import type { PokerTableState, TableOp, TableIssue } from '../src/app/table/table.types.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const OPTIONS = { rules: RULES, asOf: 1_757_000_000_000, writeLog: false, equitySeed: 20_260_913 } as const;
const BB = 100;

const line = (s = ''): void => console.log(s);
const h1 = (s: string): void => line(`\n${'='.repeat(78)}\n${s}\n${'='.repeat(78)}`);
const h2 = (s: string): void => line(`\n--- ${s} ---`);
const kv = (k: string, v: unknown): void => line(`  ${k.padEnd(34)} ${String(v)}`);

function must(state: PokerTableState, op: TableOp): PokerTableState {
  const r = applyTableOp(state, op);
  if (!r.ok) {
    throw new Error(`${op.kind} 失败：${(r.issues as readonly TableIssue[]).map((i) => `${i.code}:${i.message}`).join(' / ')}`);
  }
  return r.state;
}

function seatAll(state: PokerTableState): PokerTableState {
  let s = state;
  for (const seat of s.seats) {
    if (seat.playerId !== null) continue;
    s = must(s, { kind: 'ADD_PLAYER', seatId: seat.seatId });
  }
  return s;
}

function foldUntil(state: PokerTableState, target: Position): PokerTableState {
  let s = state;
  for (let guard = 0; guard < 40; guard += 1) {
    const p = buildTablePreview(s);
    if (p.currentActorPosition === target) return s;
    if (p.currentActorPosition === null) throw new Error(`无法推进到 ${target}：已无人行动`);
    s = must(s, { kind: 'ACT', action: { type: 'FOLD' } });
  }
  throw new Error(`无法推进到 ${target}`);
}

/** 从牌桌状态取引擎（真实行动状态机） */
function engineOf(state: PokerTableState) {
  const view = engineViewOf(state);
  if (!view.ok) throw new Error('引擎视图不可重建');
  return view.engine;
}

function analysisOf(state: PokerTableState) {
  const adapted = tableStateToManualHandInput(state);
  if (!adapted.ok) throw new Error(`适配失败：${JSON.stringify(adapted.issues)}`);
  const r = analyzeManualHand(adapted.input, OPTIONS);
  if (!r.ok) return { ok: false as const, result: r, input: adapted.input };
  return { ok: true as const, result: r, input: adapted.input };
}

function contextOf(state: PokerTableState) {
  const adapted = tableStateToManualHandInput(state);
  if (!adapted.ok) throw new Error('适配失败');
  const parsed = parseManualInput(adapted.input);
  if (!parsed.ok) throw new Error('解析失败');
  const gate = buildAnalyzableState(parsed.value as never);
  if (!gate.ok) throw new Error('重建失败');
  const villainSeat = gate.state.players.find((p) => p.id !== gate.state.userPlayerId);
  return buildDecisionContext({
    state: gate.state,
    rules: RULES,
    environment: (adapted.input as { environment?: string }).environment ?? 'MID_LOW_STAKES',
    asOf: OPTIONS.asOf,
    quickProfile: 'UNKNOWN',
    dynamicHint: 'UNKNOWN',
    ...(villainSeat === undefined ? {} : { villainSeatId: villainSeat.id }),
    equitySeed: OPTIONS.equitySeed,
  } as never);
}

/* ============================================================
 * 场景：6 人桌，Hero BB，BTN 开池 2.5BB，其余弃牌 ⇒ 轮到 Hero
 * ============================================================ */

function bbVsBtnOpen(heroCards: readonly [string, string], stackBB = 100): PokerTableState {
  let state = createTable({ tableSize: 6, heroPosition: Position.BB, defaultStackBB: stackBB, bigBlindBB: BB });
  state = seatAll(state);
  state = must(state, { kind: 'SET_HERO_CARD', card: heroCards[0] });
  state = must(state, { kind: 'SET_HERO_CARD', card: heroCards[1] });
  state = foldUntil(state, Position.BTN);
  state = must(state, { kind: 'ACT', action: { type: 'RAISE', amountChips: Math.round(2.5 * BB) } });
  state = foldUntil(state, Position.BB);
  return state;
}

/** BB 3bet 到 `toBB`，BTN 4bet 到 `fourBetBB`（用于 Hero 面对 4bet 的局面） */
function bbVsBtnFourBet(heroCards: readonly [string, string], threeBetBB: number, fourBetBB: number, stackBB = 100): PokerTableState {
  let state = bbVsBtnOpen(heroCards, stackBB);
  state = must(state, { kind: 'ACT', action: { type: 'RAISE', amountChips: Math.round(threeBetBB * BB) } });
  state = foldUntil(state, Position.BTN);
  state = must(state, { kind: 'ACT', action: { type: 'RAISE', amountChips: Math.round(fourBetBB * BB) } });
  state = foldUntil(state, Position.BB);
  return state;
}

function dumpDecision(tag: string, state: PokerTableState): void {
  h2(tag);
  const engine = engineOf(state);
  const hero = engine.players.find((p) => p.id === engine.userPlayerId)!;
  const legal = deriveLegalActions(engine, hero);
  kv('currentBet (BB)', engine.currentBet / BB);
  kv('lastRaiseSize (BB)', engine.lastRaiseSize / BB);
  kv('minRaiseTo (BB)', minRaiseTo(engine) / BB);
  kv('pot', potOf(engine));
  kv('Hero 本街已投', hero.committedByStreet[engine.street]);
  kv('Hero 剩余', hero.remainingStack);
  kv('跟注额 callCost', legal.callCost);
  kv('合法动作', legal.actions.join(' / '));
  kv('加注网格 (toAmount BB)', buildSizeGrid(legal, potOf(engine), legal.canBet ? 'BET' : 'RAISE').map((o) => o.toAmount / BB).join(' / '));

  const a = analysisOf(state);
  if (!a.ok) {
    kv('分析', `失败 ${a.result.stage} ${JSON.stringify(a.result.issues)}`);
    return;
  }
  const d = a.result.decision as unknown as Record<string, any>;
  const dg = d['diagnostics'] as Record<string, any>;
  kv('建议动作', `${d['action']}  sizeBB=${d['sizeBB']}`);
  kv('actionable / band / class', `${d['actionable']} / ${d['band']} / ${d['classification']}`);
  kv('decisionBasisKind', dg['decisionBasisKind']);
  kv('postflop 快照存在?', dg['postflop'] !== null && dg['postflop'] !== undefined);
  const ev = dg['ev'] as Record<string, any> | undefined;
  if (ev !== undefined) {
    kv('ev.actionEVs', JSON.stringify(ev['actionEVs'] ?? null));
    kv('ev.evRanking', JSON.stringify(ev['evRanking'] ?? null));
    kv('ev.trueEvRanking', JSON.stringify(ev['trueEvRanking'] ?? null));
    kv('ev.raiseResponseFacts', JSON.stringify(ev['raiseResponseFacts'] ?? null));
  }
  const un = dg['unevaluatedActions'] as readonly Record<string, any>[] | undefined;
  kv('unevaluatedActions', JSON.stringify(un ?? null));
  const cand = dg['candidates'] as readonly Record<string, any>[] | undefined;
  if (cand !== undefined) {
    line('  候选（action / sizeBB / ev / note）：');
    for (const c of cand) line(`    ${String(c['action']).padEnd(8)} ${String(c['sizeBB'] ?? '-').padStart(8)}  ev=${String(c['ev'])}  ${String(c['noteZh'] ?? '').slice(0, 70)}`);
  }
  const reasons = d['reasons'] as readonly Record<string, any>[] | undefined;
  if (reasons !== undefined) {
    line('  理由：');
    for (const r of reasons.slice(0, 14)) line(`    [${r['code']}] ${String(r['textZh']).slice(0, 150)}`);
  }
}

/* ============================================================
 * S3：翻前 raise EV 的上下文事实
 * ============================================================ */

function dumpPreflopRaiseFacts(state: PokerTableState): void {
  const t0 = Date.now();
  const built = contextOf(state) as unknown as Record<string, any>;
  const elapsed = Date.now() - t0;
  const ctx = built['context'] as Record<string, any>;
  h2('S3 · 翻前加注 EV 的上下文事实（contextBuilder 产出）');
  kv('contextBuilder 耗时 ms', elapsed);
  line('  warnings：');
  for (const w of (built['warnings'] as readonly string[]) ?? []) line(`    · ${w}`);
  const pr = (ctx['preflopRaise'] ?? null) as Record<string, any> | null;
  kv('preflopRaise 存在?', pr !== null);
  if (pr === null) return;
  kv('version / model', `${pr['version']} / ${pr['modelVersion']}`);
  kv('到达范围组合数', `${pr['arrival']?.['comboCount']}（${pr['arrival']?.['source']}）`);
  kv('currentPot / heroCallCost', `${pr['currentPot']} / ${pr['heroCallCost']}`);
  kv('sprAfterCall', pr['sprAfterCall']);
  line('  逐尺寸事实：');
  for (const s of pr['sizes'] as readonly Record<string, any>[]) {
    const eq = s['heroEquityVsRaiseCallRange'] as Record<string, any>;
    const eqr = s['heroEquityVsReraiseRange'] as Record<string, any>;
    line(
      `    ${String(s['sizeBB']).padStart(7)}BB  f/c/rr = ${(s['foldLikelihood'] as number).toFixed(3)}/`
      + `${(s['callLikelihood'] as number).toFixed(3)}/${(s['reRaiseLikelihood'] as number).toFixed(3)}`
      + `  heroAdd=${s['heroAdd']} contested=${s['heroContestedAdd']} villainAdd=${s['villainAdd']}`
      + `  EqCall=${eq['value'] === null ? '—' : ((eq['value'] as number) * 100).toFixed(2) + '%'}(${eq['method']})`
      + `  EqRR=${eqr['value'] === null ? '—' : ((eqr['value'] as number) * 100).toFixed(2) + '%'}`
      + `  rrBranch=${s['reraiseBranchKind']}`
      + `  raiseEV=${s['raiseEV'] === null ? 'null' : (s['raiseEV'] as number).toFixed(2)}`,
    );
  }
}

/* ============================================================
 * S5：合法性 / 加注权 / 短全下（直接用 Poker Core）
 * ============================================================ */

function coreProbe(): void {
  h1('S5 · 合法性 · 短全下 · 加注权（Poker Core 直接调用）');

  const mk = (stacks: readonly [number, number]): GameState => {
    let s = createTable({ tableSize: 6, heroPosition: Position.BB, defaultStackBB: 100, bigBlindBB: BB });
    s = seatAll(s);
    s = must(s, { kind: 'SET_HERO_CARD', card: 'As' });
    s = must(s, { kind: 'SET_HERO_CARD', card: 'Ah' });
    const view = engineViewOf(s);
    if (!view.ok) throw new Error('view');
    return view.engine;
  };

  const act = (st: GameState, cmd: ActionCommand) => {
    const r = applyAction(st, cmd);
    return r;
  };

  // 5BET：CO 2.5 → BTN 10 → CO 22 → Hero？
  h2('2.5 → 10 → 22 之后的最小再加注');
  {
    let s = mk([100, 100]);
    // 6 人桌：UTG HJ CO BTN SB BB。为了做 CO vs BTN，需要先弃牌
    s = act(s, { playerId: 'utg', type: 'FOLD' }).state;
    s = act(s, { playerId: 'hj', type: 'FOLD' }).state;
    s = act(s, { playerId: 'co', type: 'RAISE', amount: 250 }).state;
    s = act(s, { playerId: 'btn', type: 'RAISE', amount: 1000 }).state;
    s = act(s, { playerId: 'sb', type: 'FOLD' }).state;
    s = act(s, { playerId: 'bb', type: 'FOLD' }).state;
    s = act(s, { playerId: 'co', type: 'RAISE', amount: 2200 }).state;
    kv('currentBet', s.currentBet);
    kv('lastRaiseSize', s.lastRaiseSize);
    kv('minRaiseTo', minRaiseTo(s));
    const r32 = act(s, { playerId: 'btn', type: 'RAISE', amount: 3200 });
    kv('RAISE to 3200 ok?', r32.ok);
    if (!r32.ok) kv('  拒绝原因', r32.issues.map((i) => i.code).join(','));
    const r34 = act(s, { playerId: 'btn', type: 'RAISE', amount: 3400 });
    kv('RAISE to 3400 ok?', r34.ok);
    if (!r34.ok) kv('  拒绝原因', r34.issues.map((i) => i.code).join(','));
  }

  /* 短全下：Hero 只剩 30BB（本街已投 10 ⇒ 全下到 40，min 34 ⇒ 是完整加注）
     以及 Hero 只剩 30BB 且本街已投 22 ⇒ 全下到 30 < min ?? 需要另设。 */
  h2('短全下（不足最小加注的全下）是否重开加注权');
  {
    /* 3 人简化：CO 开池 2.5，BTN 3bet 10，CO 4bet 22，Hero(BB) 只有 25BB
       ⇒ BB 全下到 25（增量 25 − 1 = 24 > 12 ⇒ 其实是完整加注）。
       为了造出「不足额全下」，让 BB 起始 20BB：全下到 20，增量 19 > 12 ⇒ 仍完整。
       真正的不足额：CO 加注到 22 之后，SB 起始 14BB ⇒ 全下到 14 < 22 ⇒ 只是跟注不足。 */
    let s = createTable({ tableSize: 6, heroPosition: Position.BB, defaultStackBB: 100, bigBlindBB: BB });
    s = seatAll(s);
    s = must(s, { kind: 'SET_HERO_CARD', card: 'As' });
    s = must(s, { kind: 'SET_HERO_CARD', card: 'Ah' });
    const v0 = engineViewOf(s);
    if (!v0.ok) throw new Error('view');
    let e = v0.engine;
    e = act(e, { playerId: 'utg', type: 'FOLD' }).state;
    e = act(e, { playerId: 'hj', type: 'FOLD' }).state;
    e = act(e, { playerId: 'co', type: 'RAISE', amount: 250 }).state;
    e = act(e, { playerId: 'btn', type: 'FOLD' }).state;
    /* SB 起始 14BB ⇒ 已投 1BB，剩 13BB；面对 2.5BB 只能全下到 14BB（不足最小加注 4BB） */
    const sb = e.players.find((p) => p.position === Position.SB)!;
    sb.startingStack = 1400;
    sb.remainingStack = 1400 - 100;
    kv('（构造）SB 起始筹码', sb.startingStack);
    const r = act(e, { playerId: 'sb', type: 'ALL_IN' });
    kv('SB ALL_IN（14BB，增量 13BB ≥ 最小加注 1.5BB ⇒ 其实是完整加注）ok?', r.ok);
    if (r.ok) {
      kv('  currentBet', r.state.currentBet);
      kv('  lastRaiseSize', r.state.lastRaiseSize);
      kv('  raiseClosedFor', JSON.stringify(r.state.raiseClosedFor));
    }
  }

  h2('真正的不足额全下（增量 < lastRaiseSize）');
  {
    let s = createTable({ tableSize: 6, heroPosition: Position.BB, defaultStackBB: 100, bigBlindBB: BB });
    s = seatAll(s);
    s = must(s, { kind: 'SET_HERO_CARD', card: 'As' });
    s = must(s, { kind: 'SET_HERO_CARD', card: 'Ah' });
    const v0 = engineViewOf(s);
    if (!v0.ok) throw new Error('view');
    let e = v0.engine;
    e = act(e, { playerId: 'utg', type: 'FOLD' }).state;
    e = act(e, { playerId: 'hj', type: 'FOLD' }).state;
    e = act(e, { playerId: 'co', type: 'RAISE', amount: 250 }).state;   // 开池 2.5BB，增量 1.5BB
    e = act(e, { playerId: 'btn', type: 'RAISE', amount: 1000 }).state; // 3bet 10BB，增量 7.5BB
    e = act(e, { playerId: 'sb', type: 'FOLD' }).state;
    /* BB 起始 12BB：已投 1BB，剩 11BB ⇒ 全下到 12BB < min 17.5BB ⇒ 不足额全下（增量 11 − 1 = 10BB ≥ 7.5BB？）
       lastRaiseSize = 7.5BB ⇒ 增量 10BB ≥ 7.5BB ⇒ 仍是完整加注。把 BB 起始降到 8BB ⇒ 增量 7BB < 7.5BB ⇒ 不足额。 */
    const bb = e.players.find((p) => p.position === Position.BB)!;
    bb.startingStack = 800;
    bb.remainingStack = 800 - 200;
    const r = act(e, { playerId: 'bb', type: 'ALL_IN' });
    kv('BB ALL_IN 到 8BB（增量 7BB < lastRaiseSize 7.5BB）ok?', r.ok);
    if (r.ok) {
      kv('  currentBet', r.state.currentBet);
      kv('  lastRaiseSize（应保持 7.5BB）', r.state.lastRaiseSize / BB);
      kv('  raiseClosedFor', JSON.stringify(r.state.raiseClosedFor));
      kv('  pendingQueue', JSON.stringify(r.state.pendingQueue));
      kv('  CO 还能加注吗（未行动过？）', !r.state.raiseClosedFor.includes('co'));
      /* CO 已对 10BB 表过态（他加注到 10BB 的是 BTN……），实际是 BTN 加注到 10 */
      kv('  BTN 还能加注吗', !r.state.raiseClosedFor.includes('btn'));
    }
  }

  h2('无人能跟时不得生成加注');
  {
    let s = createTable({ tableSize: 6, heroPosition: Position.BB, defaultStackBB: 100, bigBlindBB: BB });
    s = seatAll(s);
    s = must(s, { kind: 'SET_HERO_CARD', card: 'As' });
    s = must(s, { kind: 'SET_HERO_CARD', card: 'Ah' });
    const v0 = engineViewOf(s);
    if (!v0.ok) throw new Error('view');
    let e = v0.engine;
    e = act(e, { playerId: 'utg', type: 'FOLD' }).state;
    e = act(e, { playerId: 'hj', type: 'FOLD' }).state;
    e = act(e, { playerId: 'co', type: 'FOLD' }).state;
    e = act(e, { playerId: 'btn', type: 'FOLD' }).state;
    e = act(e, { playerId: 'sb', type: 'FOLD' }).state;
    const bb = e.players.find((p) => p.position === Position.BB)!;
    kv('（构造）其余人全弃牌，只剩 BB；pendingQueue', JSON.stringify(e.pendingQueue));
    kv('BB 能否加注（无人可跟）', deriveLegalActions(e, bb).actions.join('/'));
  }
}

/* ============================================================
 * 主流程
 * ============================================================ */

h1('RAISE DECISION · 基线事实探针（只读）');
line(`Node ${process.version}`);

h1('S1/S2 · BB 面对 BTN 开池（单挑翻前 3bet 决策点）');
for (const hand of [['As', 'Ah'], ['As', 'Ks'], ['7d', '6d'], ['Qh', '9c']] as const) {
  const st = bbVsBtnOpen(hand);
  dumpDecision(`Hero BB ${hand.join('')} vs BTN 开池 2.5BB`, st);
}

h1('S3 · 翻前加注 EV 上下文事实');
dumpPreflopRaiseFacts(bbVsBtnOpen(['As', 'Ah']));

h1('S4 · 面对 4bet：Hero 评估了哪些应对');
dumpDecision('BB AA 3bet 10 → BTN 4bet 22 → Hero', bbVsBtnFourBet(['As', 'Ah'], 10, 22));
dumpDecision('BB 76s 3bet 10 → BTN 4bet 22 → Hero', bbVsBtnFourBet(['7d', '6d'], 10, 22));

coreProbe();

h1('探针结束');
