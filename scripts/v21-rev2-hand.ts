/**
 * REV2 探针 ③：参考手在生产链路上的画像 / 前序线 / 尺寸响应（执行得出）
 *
 * 固定手：9-max，Hero CO Ac Jh，牌面 Ad 8s 4s 2c Kd，河牌，CO 开 2.5，BB 跟
 * 翻牌 BB check / CO bet 2 / BB call；转牌 BB check / CO **check-back**；
 * 河牌 BB bet 7。
 *
 * 用法：node --experimental-strip-types scripts/v21-rev2-hand.ts
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
  budget: { softMs: 120_000, hardMs: 240_000 },
} as const;
const SEATS = { UTG: 100, UTG1: 100, UTG2: 100, LJ: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 };

type Line = 'CHECK_BACK' | 'BET_CALL';
type Spec = { label: string; archetype: string; line: Line; riverBet: number };

function historyOf(line: Line, riverBet: number): unknown[] {
  const h: unknown[] = [
    { position: 'UTG', type: 'FOLD' }, { position: 'UTG1', type: 'FOLD' }, { position: 'UTG2', type: 'FOLD' },
    { position: 'LJ', type: 'FOLD' }, { position: 'HJ', type: 'FOLD' },
    { position: 'CO', type: 'RAISE', amountBB: 2.5 },
    { position: 'BTN', type: 'FOLD' }, { position: 'SB', type: 'FOLD' },
    { position: 'BB', type: 'CALL', amountBB: 1.5 },
    { position: 'BB', type: 'CHECK', street: 'FLOP' },
    { position: 'CO', type: 'BET', amountBB: 2, street: 'FLOP' },
    { position: 'BB', type: 'CALL', amountBB: 2, street: 'FLOP' },
    { position: 'BB', type: 'CHECK', street: 'TURN' },
  ];
  if (line === 'CHECK_BACK') {
    h.push({ position: 'CO', type: 'CHECK', street: 'TURN' });
  } else {
    h.push({ position: 'CO', type: 'BET', amountBB: 5.5, street: 'TURN' });
    h.push({ position: 'BB', type: 'CALL', amountBB: 5.5, street: 'TURN' });
  }
  h.push({ position: 'BB', type: 'BET', amountBB: riverBet, street: 'RIVER' });
  return h;
}

function hand(spec: Spec): ManualHandInput {
  return {
    tableSize: 9, heroPosition: 'CO', heroCards: ['Ac', 'Jh'],
    board: ['Ad', '8s', '4s', '2c', 'Kd'], street: 'RIVER',
    effectiveStackBB: 100, bigBlindBB: 2, seatStacksBB: { ...SEATS },
    actionHistory: historyOf(spec.line, spec.riverBet),
    environment: 'MID_LOW_STAKES',
    villain: { stackBB: 100, quickProfile: spec.archetype },
  } as unknown as ManualHandInput;
}

type Row = Record<string, unknown>;

function measure(spec: Spec): Row {
  const input = hand(spec);
  const r = analyzeManualHand(input, OPTIONS);
  if (!r.ok) return { label: spec.label, ok: false, issues: JSON.stringify(r.issues) };
  const m = r.decision.diagnostics.math;
  const post = r.decision.diagnostics.postflop as unknown as Row;
  const bd = post['betDecision'] as Row | null;
  const sized = (bd?.['sizes'] as Row[] | undefined) ?? [];
  const chosen = sized.find((s) => s['labelZh'] === bd?.['bestSize']) ?? sized[0] ?? null;
  const sizes = sized.map((s) => ({
    label: s['labelZh'], amount: s['betAmount'], ratio: s['ratioToPot'],
    fold: s['foldLikelihood'], call: s['callLikelihood'], raise: s['raiseLikelihood'], ev: s['ev'],
  }));

  const parsed = parseManualInput(input);
  let masses: Row | null = null;
  let riverTrace = '';
  let evidence: Row | null = null;
  if (parsed.ok) {
    const gate = buildAnalyzableState(parsed.value);
    if (gate.ok) {
      const built = buildDecisionContext({
        state: gate.state, rules: RULES, environment: 'MID_LOW_STAKES',
        asOf: 1_757_000_000_000, budget: { softMs: 120_000, hardMs: 240_000 },
        equitySeed: 20260913,
        ...(spec.archetype === 'UNKNOWN' ? {} : { quickProfile: spec.archetype as never }),
      });
      const facts = built.context.postflopFacts?.opponentRangeFacts as unknown as Row | null;
      masses = (facts?.['profileClassMasses'] as Row | undefined) ?? null;
      const trace = (built.context.range?.updateTrace ?? []) as Row[];
      riverTrace = trace.filter((t) => t['street'] === 'RIVER').map((t) => String(t['noteZh'])).join(' | ');
      const ev = built.context.profileRangeEvidence as unknown as Row | undefined;
      evidence = ev === undefined ? null : { eqBefore: ev['equityBefore'], eqAfter: ev['equityAfter'], deltaPct: ev['equityDeltaPct'] };
    }
  }

  return {
    label: spec.label, ok: true, action: r.decision.action,
    sizing: r.decision.sizing, equity: m.heroEquity, requiredEquity: m.requiredEquity, callEV: m.callEV,
    pot: bd?.['pot'] ?? null, checkEV: bd?.['checkEV'] ?? null, bestSize: bd?.['bestSize'] ?? null,
    chosen: chosen === null ? null : { label: chosen['labelZh'], fold: chosen['foldLikelihood'], call: chosen['callLikelihood'], raise: chosen['raiseLikelihood'], ratio: chosen['ratioToPot'] },
    sizes, masses, riverTrace, evidence,
  };
}

const pct = (v: unknown, d = 2): string => (typeof v === 'number' ? `${(v * 100).toFixed(d)}%` : '—');
const num = (v: unknown, d = 3): string => (typeof v === 'number' ? v.toFixed(d) : '—');

/* ============================================================ */
console.log('################ A. 参考手：BB 下注 7 / 转牌 CO check-back ################');
const base: Spec = { label: 'base', archetype: 'UNKNOWN', line: 'CHECK_BACK', riverBet: 7 };
const r0 = measure(base);
console.log(`  pot=${num(r0['pot'], 2)}  river 下注金额=${num((r0['sizes'] as Row[])[0]?.['amount'], 2)}（这是**我自己**的下注尺寸，不是 BB 的）`);
console.log(`  河牌范围更新 trace: ${String(r0['riverTrace']).slice(0, 400)}`);

const ORDER = ['UNKNOWN', 'NORMAL', 'VERY_TIGHT', 'LOOSE', 'CALLING_STATION', 'BLUFF_HEAVY', 'UNDERBLUFFER', 'MANIAC'];
console.log('\n画像            动作      权益     所需权益   callEV   弃/跟/加(响应模型)     诈唬质量  价值质量  thin  showdown  纯空气');
const rows: Record<string, Row> = {};
for (const a of ORDER) {
  const row = measure({ ...base, archetype: a });
  rows[a] = row;
  const m = (row['masses'] ?? {}) as Row;
  const c = (row['chosen'] ?? {}) as Row;
  console.log(
    `${a.padEnd(15)}${String(row['action']).padEnd(9)}${pct(row['equity']).padEnd(9)}${pct(row['requiredEquity']).padEnd(10)}` +
      `${num(row['callEV'], 3).padEnd(9)}${`${num(c['fold'])}/${num(c['call'])}/${num(c['raise'])}`.padEnd(24)}` +
      `${pct(m['bluffMass']).padEnd(10)}${pct(m['valueMass']).padEnd(10)}${pct(m['thinValueMass']).padEnd(6)}${pct(m['showdownMass']).padEnd(10)}${pct(m['pureAirMass'])}`,
  );
}

console.log('\n--- A2. 每个标签的 质量分量（含 missed flush/straight/combo）与画像不可见质量占比 ---');
for (const a of ORDER) {
  const m = (rows[a]!['masses'] ?? {}) as Row;
  const total = typeof m['totalMass'] === 'number' ? (m['totalMass'] as number) : 0;
  const invisible =
    ((m['nutValueMass'] as number) ?? 0) + ((m['strongValueMass'] as number) ?? 0) +
    ((m['thinValueMass'] as number) ?? 0) + ((m['showdownMass'] as number) ?? 0);
  console.log(
    `  ${a.padEnd(15)} total=${num(total, 4)} nut=${pct(m['nutValueMass'])} strong=${pct(m['strongValueMass'])} ` +
      `thin=${pct(m['thinValueMass'])} showdown=${pct(m['showdownMass'])} mF=${pct(m['missedFlushMass'])} ` +
      `mS=${pct(m['missedStraightMass'])} mC=${pct(m['missedComboMass'])} air=${pct(m['pureAirMass'])} ` +
      `⇒ **画像不可见质量占比=${pct(invisible / total)}**`,
  );
}

console.log('\n--- A3. 声明中的版本变更数字复核（decision.types.ts §1.0.5：bluffMass 0.78%→5.00%、equity 55.81%→57.61%、callEV 12.230→13.076）---');
for (const a of ORDER) {
  const m = (rows[a]!['masses'] ?? {}) as Row;
  console.log(
    `  ${a.padEnd(15)} bluffMass=${pct(m['bluffMass'])} missedDraw=${pct(m['missedDrawMass'])} equity=${pct(rows[a]!['equity'], 4)} callEV=${num(rows[a]!['callEV'], 4)}`,
  );
}

console.log('\n################ B. 尺寸响应：河牌下注 36% / 75% / 154% ################');
for (const [label, amount] of [['36%', 7], ['75%', 14.63], ['154%', 30]] as const) {
  const row = measure({ label, archetype: 'UNKNOWN', line: 'CHECK_BACK', riverBet: amount });
  const sized = row['sizes'] as Row[];
  console.log(`\n  --- BB 河牌下注 ${label}（金额 ${amount}）---`);
  const trace = String(row['riverTrace']);
  const bucket = /\/[A-Z_]+\/(SMALL|MEDIUM|LARGE|OVERBET)\//.exec(trace)?.[1] ?? '(trace 未给出)';
  console.log(`  引擎认定的尺寸档 = ${bucket}；范围 trace: ${trace.slice(0, 220)}`);
  console.log(`  权益=${pct(row['equity'])} 所需权益=${pct(row['requiredEquity'])} callEV=${num(row['callEV'], 3)} 动作=${String(row['action'])}`);
  console.log('  【Hero 自己下注的响应模型】尺寸标签            比例    弃牌     跟注     加注     EV');
  for (const s of sized) {
    console.log(
      `                              ${String(s['label']).padEnd(16)}${num(s['ratio'], 3).padEnd(8)}${num(s['fold']).padEnd(9)}${num(s['call']).padEnd(9)}${num(s['raise']).padEnd(9)}${num(s['ev'], 2)}`,
    );
  }
}

console.log('\n################ C. 前序线：转牌 CO check-back vs CO bet-call（只改这一项）################');
console.log('--- C1. 河牌下注金额**同为 7**（底池因转牌下注而变大，比例不同）---');
for (const a of ['UNKNOWN', 'CALLING_STATION', 'MANIAC']) {
  for (const line of ['CHECK_BACK', 'BET_CALL'] as const) {
    const row = measure({ label: `${a}/${line}`, archetype: a, line, riverBet: 7 });
    const m = (row['masses'] ?? {}) as Row;
    const trace = String(row['riverTrace']);
    const seen = /(TURN_CHECK_BACK|TURN_BET_CALL)\/(SMALL|MEDIUM|LARGE|OVERBET)/.exec(trace);
    console.log(
      `  ${a.padEnd(15)} ${line.padEnd(11)} 节点=${seen === null ? '?' : seen[0]} 权益=${pct(row['equity'])} ` +
        `所需=${pct(row['requiredEquity'])} callEV=${num(row['callEV'], 3)} 动作=${String(row['action'])} bluffMass=${pct(m['bluffMass'])} valueMass=${pct(m['valueMass'])}`,
    );
  }
}
console.log('--- C2. 河牌下注**同比例 36%**（金额随底池缩放 ⇒ 只改前序线）---');
for (const a of ['UNKNOWN', 'CALLING_STATION', 'MANIAC']) {
  const cb = measure({ label: `${a}/cb36`, archetype: a, line: 'CHECK_BACK', riverBet: 7 });
  const bc = measure({ label: `${a}/bc36`, archetype: a, line: 'BET_CALL', riverBet: 16.7 });
  for (const [tag, row] of [['CHECK_BACK', cb], ['BET_CALL', bc]] as const) {
    const m = (row['masses'] ?? {}) as Row;
    const trace = String(row['riverTrace']);
    const seen = /(TURN_CHECK_BACK|TURN_BET_CALL)\/(SMALL|MEDIUM|LARGE|OVERBET)/.exec(trace);
    console.log(
      `  ${a.padEnd(15)} ${tag.padEnd(11)} 节点=${seen === null ? '?' : seen[0]} 权益=${pct(row['equity'])} ` +
        `所需=${pct(row['requiredEquity'])} callEV=${num(row['callEV'], 3)} 动作=${String(row['action'])} bluffMass=${pct(m['bluffMass'])}`,
    );
  }
}
