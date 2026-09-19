/**
 * Reviewer 3 探针（V21 生产管线 / 缓存 / 身份隔离）
 *
 * 用法：node --experimental-strip-types scripts/v21-rev3-probe.ts <mode>
 *   mode = item2 | item4 | item5 | item6 | item7
 *
 * 只读：不写任何文件，不改任何 src/test。
 */
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';
import { parseManualInput, type ManualHandInput } from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import { advisePostflop } from '../src/app/decision/postflopAdvisor.ts';
import { deriveLegalActions } from '../src/app/manualInput/legalActions.ts';
import { profileCompressionMultiplier } from '../src/domain/postflop/rangeCompression.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const OPTIONS = { rules: RULES, asOf: 1_757_000_000_000, writeLog: false } as const;

type Node = ManualHandInput & { villainPlayerId?: string; seatProfiles?: Record<string, string> };

const F = (position: string) => ({ position, type: 'FOLD' as const });

/* ============================================================
 * 夹具 A：三家跛入池，CO 是河牌下注者（可用于「画像挂在哪一家」的 A/B）
 *
 * 6-max，Hero BB A♥9♥（一对 9 = 抓诈唬）。
 * 翻前：UTG limp、HJ fold、CO limp、BTN fold、SB fold、BB check
 * 翻牌：BB check → UTG check → CO bet 1.5 → BB call → UTG call
 * 转牌：BB check → UTG check → CO bet 4 → BB call → UTG call
 * 河牌：BB check → UTG check → CO bet 12  ⇒ Hero 面对下注
 * ============================================================ */
function limpedRiver(profile: string, villainPlayerId: string): Node {
  return {
    tableSize: 6,
    heroPosition: 'BB',
    heroCards: ['Ah', '9h'],
    board: ['Kc', '9s', '5d', '2h', '7c'],
    street: 'RIVER',
    effectiveStackBB: 100,
    bigBlindBB: 2,
    seatStacksBB: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 },
    actionHistory: [
      { position: 'UTG', type: 'CALL', amountBB: 1 },
      F('HJ'),
      { position: 'CO', type: 'CALL', amountBB: 1 },
      F('BTN'),
      F('SB'),
      { position: 'BB', type: 'CHECK' },
      { position: 'BB', type: 'CHECK', street: 'FLOP' },
      { position: 'UTG', type: 'CHECK', street: 'FLOP' },
      { position: 'CO', type: 'BET', amountBB: 1.5, street: 'FLOP' },
      { position: 'BB', type: 'CALL', amountBB: 1.5, street: 'FLOP' },
      { position: 'UTG', type: 'CALL', amountBB: 1.5, street: 'FLOP' },
      { position: 'BB', type: 'CHECK', street: 'TURN' },
      { position: 'UTG', type: 'CHECK', street: 'TURN' },
      { position: 'CO', type: 'BET', amountBB: 4, street: 'TURN' },
      { position: 'BB', type: 'CALL', amountBB: 4, street: 'TURN' },
      { position: 'UTG', type: 'CALL', amountBB: 4, street: 'TURN' },
      { position: 'BB', type: 'CHECK', street: 'RIVER' },
      { position: 'UTG', type: 'CHECK', street: 'RIVER' },
      { position: 'CO', type: 'BET', amountBB: 12, street: 'RIVER' },
    ],
    environment: 'MID_LOW_STAKES',
    villain: { quickProfile: profile as never, dynamicHint: 'UNKNOWN', stackBB: 100 },
    villainPlayerId,
  } as unknown as Node;
}

/* ============================================================
 * 夹具 B：跛入池 + **翻牌 Hero 先行动**（对手翻后**还没有任何记录**）
 *
 * 6-max，Hero BB A♥9♥。翻前 UTG limp，其余弃牌，BB check。
 * 翻牌 Hero（BB）先说话 ⇒ 对手（UTG）没有任何翻后行动记录。
 * ============================================================ */
function limpedFlopHeroFirst(profile: string): Node {
  return {
    tableSize: 6,
    heroPosition: 'BB',
    heroCards: ['Ah', '9h'],
    board: ['Kc', '9s', '5d'],
    street: 'FLOP',
    effectiveStackBB: 100,
    bigBlindBB: 2,
    seatStacksBB: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 },
    actionHistory: [
      { position: 'UTG', type: 'CALL', amountBB: 1 },
      F('HJ'),
      F('CO'),
      F('BTN'),
      F('SB'),
      { position: 'BB', type: 'CHECK' },
    ],
    environment: 'MID_LOW_STAKES',
    villain: { quickProfile: profile as never, dynamicHint: 'UNKNOWN', stackBB: 100 },
  } as unknown as Node;
}

/* ============================================================
 * 工具
 * ============================================================ */
function build(input: Node) {
  const parsed = parseManualInput(input);
  if (!parsed.ok) throw new Error(`parse 失败：${JSON.stringify(parsed.issues)}`);
  const gate = buildAnalyzableState(parsed.value);
  if (!gate.ok) throw new Error(`门槛拒绝：${JSON.stringify(gate.issues)}`);
  const built = buildDecisionContext({
    state: gate.state,
    rules: RULES,
    environment: 'MID_LOW_STAKES',
    asOf: 1_757_000_000_000,
    quickProfile: input.villain?.quickProfile as never,
    ...(input.villainPlayerId === undefined ? {} : { villainPlayerId: input.villainPlayerId }),
  });
  const hero = gate.state.players.find((p) => p.holeCards !== null)!;
  return { built, legal: deriveLegalActions(gate.state, hero), gate };
}

function analyze(input: Node) {
  const r = analyzeManualHand(input, OPTIONS);
  if (!r.ok) throw new Error(`分析失败：${JSON.stringify(r.issues)}`);
  return r;
}

const n4 = (x: number | null | undefined): string => (x === null || x === undefined ? 'null' : x.toFixed(4));
const pct = (x: number | null | undefined): string =>
  x === null || x === undefined ? 'null' : `${(x * 100).toFixed(4)}%`;

/* ============================================================
 * item2：去重闸门是否 airtight
 * ============================================================ */
function item2(): void {
  console.log('=== item2：去重闸门 airtight 检验 ===\n');

  /* --- A 组：画像挂在**非首要对手**（CO）身上 --- */
  for (const villainSeat of ['seat_CO', 'seat_UTG'] as const) {
    for (const profile of ['MANIAC', 'UNKNOWN'] as const) {
      const input = limpedRiver(profile, villainSeat);
      const { built, legal } = build(input);
      const advice = advisePostflop(built.context, {
        facingBet: legal.callCost > 0,
        requiredEquity: built.context.math.requiredEquity,
        potAfterCall: built.context.math.pot + legal.callCost,
      });
      const ev = built.context.profileRangeEvidence ?? null;
      const r = analyze(input);
      console.log(
        `[A] villain=${villainSeat} profile=${profile}\n` +
          `    profileRangeEvidence = ${ev === null ? 'null' : 'present'}` +
          (ev === null ? '' : ` provider.applied=${ev.provider.applied}`) +
          `｜equityBefore=${pct(ev?.equityBefore ?? null)} equityAfter=${pct(ev?.equityAfter ?? null)} delta=${n4(ev?.equityDeltaPct ?? null)}\n` +
          `    heroEquity=${pct(built.context.math.heroEquity)} callEV=${n4(built.context.math.callEV)} action=${r.decision.action}\n` +
          `    exploit.bluffCatchDelta=${n4(advice?.exploit.bluffCatchDelta ?? null)}` +
          ` deDuplicated=${String(advice?.exploit.deDuplicated)}\n` +
          `    gate.profileEvidence=${JSON.stringify(advice?.gate?.profileEvidence ?? null)}\n` +
          `    compression.aggressionCredibility=${n4(advice?.compression?.aggressionCredibility ?? null)}` +
          ` strengthFloor=${n4(advice?.compression?.strengthFloor ?? null)}`,
      );
    }
  }

  /* --- A 组对照：无任何画像（villain: {}）--- */
  {
    const input = limpedRiver('UNKNOWN', 'seat_CO');
    input.villain = {} as never;
    const { built } = build(input);
    const r = analyze(input);
    console.log(
      `[A-基线] 完全无画像 villain={}\n    heroEquity=${pct(built.context.math.heroEquity)}` +
        ` profileRangeEvidence=${built.context.profileRangeEvidence === undefined ? 'absent(undefined)' : 'present'}` +
        ` action=${r.decision.action}`,
    );
  }

  /* --- B 组：跛入原型通道（对手翻后还没有任何行动记录 ⇒ provider 从未被调用）--- */
  console.log('\n--- B 组：跛入池 + Hero 翻牌先行动（对手零翻后记录）---');
  for (const profile of ['CALLING_STATION', 'MANIAC', 'NORMAL', 'UNKNOWN'] as const) {
    const input = limpedFlopHeroFirst(profile);
    const { built, legal } = build(input);
    const advice = advisePostflop(built.context, {
      facingBet: legal.callCost > 0,
      requiredEquity: built.context.math.requiredEquity,
      potAfterCall: built.context.math.pot + legal.callCost,
    });
    const ev = built.context.profileRangeEvidence ?? null;
    const r = analyze(input);
    console.log(
      `[B] profile=${profile}\n` +
        `    profileRangeEvidence=${ev === null ? 'null' : `applied=${ev.provider.applied}`}` +
        `｜equityBefore=${pct(ev?.equityBefore ?? null)} equityAfter=${pct(ev?.equityAfter ?? null)}` +
        ` delta=${n4(ev?.equityDeltaPct ?? null)}｜heroEquity=${pct(built.context.math.heroEquity)}\n` +
        `    action=${r.decision.action} exploit.bluffCatchDelta=${n4(advice?.exploit.bluffCatchDelta ?? null)}` +
        ` deDuplicated=${String(advice?.exploit.deDuplicated)}\n` +
        `    gate.profileEvidence=${JSON.stringify(advice?.gate?.profileEvidence ?? null)}\n` +
        `    compression.aggressionCredibility=${n4(advice?.compression?.aggressionCredibility ?? null)}` +
        ` strengthFloor=${n4(advice?.compression?.strengthFloor ?? null)}`,
    );
  }

  /* --- B 组隔离：只改 scorer 层画像可信度，证明压缩乘数确实被乘上去 --- */
  {
    for (const p of ['MANIAC', 'CALLING_STATION'] as const) {
      console.log(
        `[B-隔离] profileCompressionMultiplier('${p}', 0.35)=${n4(
          profileCompressionMultiplier(p as never, 0.35),
        )} vs ('${p}', 0)=${n4(profileCompressionMultiplier(p as never, 0))}`,
      );
    }
  }
}

/* ============================================================
 * item4：画像是否泄漏给别的对手
 * ============================================================ */
function item4(): void {
  console.log('=== item4：多路底池里画像是否泄漏到别的对手 ===\n');
  const rangesOf = (input: Node) => {
    const { built } = build(input);
    const m = new Map<string, { support: number; entropy: number; strong: number; meanTier: number }>();
    for (const s of built.context.opponentRanges) {
      m.set(s.opponentId, {
        support: s.supportSize,
        entropy: s.metrics.entropyBits,
        strong: s.metrics.strongShare ?? -1,
        meanTier: s.metrics.meanTier ?? -1,
      });
    }
    return { m, context: built.context };
  };

  const base = rangesOf(limpedRiver('UNKNOWN', 'seat_CO'));
  for (const profile of ['MANIAC', 'CALLING_STATION', 'UNDERBLUFFER'] as const) {
    const withP = rangesOf(limpedRiver(profile, 'seat_CO'));
    for (const id of ['seat_UTG', 'seat_CO']) {
      const a = base.m.get(id);
      const b = withP.m.get(id);
      const same =
        a !== undefined && b !== undefined && JSON.stringify(a) === JSON.stringify(b);
      console.log(
        `profile=${profile.padEnd(16)} ${id}: baseline=${JSON.stringify(a)} vs profile=${JSON.stringify(b)} ⇒ ${same ? '逐位相同' : '**不同**'}`,
      );
    }
  }
  // 反向：画像挂在 UTG 时，CO 的范围必须不变
  const baseUTG = rangesOf(limpedRiver('UNKNOWN', 'seat_UTG'));
  const maniacUTG = rangesOf(limpedRiver('MANIAC', 'seat_UTG'));
  for (const id of ['seat_UTG', 'seat_CO']) {
    const a = baseUTG.m.get(id);
    const b = maniacUTG.m.get(id);
    const same = a !== undefined && b !== undefined && JSON.stringify(a) === JSON.stringify(b);
    console.log(
      `villain=seat_UTG profile=MANIAC   ${id}: ${same ? '逐位相同' : '**不同**'}  ${JSON.stringify(a)} -> ${JSON.stringify(b)}`,
    );
  }
}

/* ============================================================
 * item5：缓存审计 + 顺序无关性（逐位）
 * ============================================================ */
function item5(): void {
  console.log('=== item5：缓存 / 全局可变状态 + 顺序无关性 ===\n');
  const snap = (input: Node) => {
    const r = analyze(input);
    const { built } = build(input);
    return {
      profileRangeEvidence: built.context.profileRangeEvidence ?? null,
      json: JSON.stringify({
        math: r.decision.diagnostics.math,
        action: String(r.decision.action),
        confidence: r.decision.confidence,
        reasons: r.decision.reasons.map((x) => x.code),
        rangeSupport: built.context.range?.supportSize ?? null,
        trace: built.context.range?.updateTrace ?? null,
        facts: built.context.postflopFacts?.opponentRangeFacts ?? null,
      }),
    };
  };

  for (const profile of ['MANIAC', 'CALLING_STATION'] as const) {
    const a = snap(limpedRiver(profile, 'seat_CO'));
    const b = snap(limpedRiver(profile, 'seat_CO'));
    console.log(
      `连续两次同输入 profile=${profile}: 主链快照 ${a.json === b.json ? '逐字节相同' : '**不同**'}`,
    );
  }
}

/* ============================================================
 * item6：N 个画像 / 两种顺序，同一进程
 * ============================================================ */
function item6(): void {
  console.log('=== item6：同进程两种顺序 × 6 个画像 ===\n');
  const PROFILES = ['NORMAL', 'TIGHT', 'CALLING_STATION', 'UNDERBLUFFER', 'BLUFF_HEAVY', 'MANIAC'] as const;
  const snap = (p: string) => {
    const r = analyze(limpedRiver(p, 'seat_CO'));
    return JSON.stringify({
      math: r.decision.diagnostics.math,
      action: String(r.decision.action),
      confidence: r.decision.confidence,
      margin: r.decision.diagnostics.decisionMargin?.kind ?? null,
      reasons: r.decision.reasons.map((x) => x.code),
    });
  };

  const forward = new Map<string, string>();
  for (const p of PROFILES) forward.set(p, snap(p));
  const backward = new Map<string, string>();
  for (const p of [...PROFILES].reverse()) backward.set(p, snap(p));
  // 再来一轮（第三序，交错）
  const interleaved = new Map<string, string>();
  for (const p of [PROFILES[3]!, PROFILES[0]!, PROFILES[5]!, PROFILES[1]!, PROFILES[4]!, PROFILES[2]!]) {
    interleaved.set(p, snap(p));
  }

  let diff = 0;
  for (const p of PROFILES) {
    const f = forward.get(p)!;
    const b = backward.get(p)!;
    const i = interleaved.get(p)!;
    const ok = f === b && f === i;
    if (!ok) diff += 1;
    console.log(`profile=${p.padEnd(16)} 顺序A===顺序B===顺序C ? ${ok ? 'YES（逐字节）' : '**NO**'}`);
    if (!ok) {
      console.log(`   A=${f.slice(0, 220)}`);
      console.log(`   B=${b.slice(0, 220)}`);
      console.log(`   C=${i.slice(0, 220)}`);
    }
  }
  console.log(`\n6 个画像 × 3 种顺序：不一致数量 = ${diff}`);
}

/* ============================================================
 * item7：入口一致性（HTTP vs 直调）
 * ============================================================ */
async function item7(): Promise<void> {
  console.log('=== item7：HTTP /api/analyze vs 直调 analyzeManualHand ===\n');
  const input = limpedRiver('MANIAC', 'seat_CO');
  const direct = analyze(input);
  const directSnap = JSON.stringify({
    math: direct.decision.diagnostics.math,
    action: String(direct.decision.action),
    confidence: direct.decision.confidence,
    reasons: direct.decision.reasons.map((x) => x.code),
  });
  console.log(`直调：action=${direct.decision.action} equity=${pct(direct.decision.diagnostics.math.heroEquity)}`);
  console.log(`直调快照=${directSnap}`);

  const mod = (await import('../src/app/webServer.ts')) as Record<string, unknown>;
  console.log(`webServer 导出：${Object.keys(mod).join(', ')}`);
}

const mode = process.argv[2] ?? 'item2';
if (mode === 'item2') item2();
else if (mode === 'item4') item4();
else if (mode === 'item5') item5();
else if (mode === 'item6') item6();
else if (mode === 'item7') await item7();
else console.log(`未知 mode：${mode}`);
