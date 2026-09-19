/**
 * Reviewer 3 探针 3
 *   mode = item1 → 统一似然与倾斜 provider 是否会在**同一条动作**上同时生效（差分取证）
 *   mode = item5b → rangeCounter 是否进入决策输出（同一进程连续两次 + 全量 diagnostics 比对）
 */
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';
import { parseManualInput, type ManualHandInput } from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import { advisePostflop } from '../src/app/decision/postflopAdvisor.ts';
import { deriveLegalActions } from '../src/app/manualInput/legalActions.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const OPTIONS = { rules: RULES, asOf: 1_757_000_000_000, writeLog: false } as const;
const F = (position: string) => ({ position, type: 'FOLD' as const });

/** 对手最后一条动作可选 BET（河牌）或 CHECK（河牌）——其余逐字相同 */
function node(riverAction: 'BET' | 'CHECK', profile = 'BLUFF_HEAVY'): ManualHandInput {
  return {
    tableSize: 6,
    heroPosition: 'BTN',
    heroCards: ['Ah', 'Qc'],
    board: ['Qs', '8d', '3c', '6s', 'Ks'],
    street: 'RIVER',
    effectiveStackBB: 100,
    bigBlindBB: 2,
    seatStacksBB: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 },
    actionHistory: [
      F('UTG'),
      F('HJ'),
      { position: 'CO', type: 'RAISE', amountBB: 2.5 },
      { position: 'BTN', type: 'CALL', amountBB: 2.5 },
      F('SB'),
      F('BB'),
      { position: 'CO', type: 'BET', amountBB: 2, street: 'FLOP' },
      { position: 'BTN', type: 'CALL', amountBB: 2, street: 'FLOP' },
      { position: 'CO', type: 'BET', amountBB: 7, street: 'TURN' },
      { position: 'BTN', type: 'CALL', amountBB: 7, street: 'TURN' },
      riverAction === 'BET'
        ? { position: 'CO', type: 'BET', amountBB: 20, street: 'RIVER' }
        : { position: 'CO', type: 'CHECK', street: 'RIVER' },
    ],
    environment: 'MID_LOW_STAKES',
    villain: { quickProfile: profile as never, dynamicHint: 'UNKNOWN', stackBB: 100 },
  } as unknown as ManualHandInput;
}

function build(input: ManualHandInput) {
  const parsed = parseManualInput(input);
  if (!parsed.ok) throw new Error(`parse:${JSON.stringify(parsed.issues)}`);
  const gate = buildAnalyzableState(parsed.value);
  if (!gate.ok) throw new Error(`gate:${JSON.stringify(gate.issues)}`);
  const built = buildDecisionContext({
    state: gate.state, rules: RULES, environment: 'MID_LOW_STAKES',
    asOf: 1_757_000_000_000, quickProfile: input.villain?.quickProfile as never,
  });
  const hero = gate.state.players.find((p) => p.holeCards !== null)!;
  return { built, legal: deriveLegalActions(gate.state, hero) };
}

function item1(): void {
  console.log('=== item1：统一似然 vs 倾斜 provider —— 同一条动作是否互斥 ===\n');
  for (const riverAction of ['BET', 'CHECK'] as const) {
    const input = node(riverAction);
    const { built, legal } = build(input);
    const ev = built.context.profileRangeEvidence ?? null;
    const trace = built.context.range?.updateTrace ?? [];
    const advice = advisePostflop(built.context, {
      facingBet: legal.callCost > 0,
      requiredEquity: built.context.math.requiredEquity,
      potAfterCall: built.context.math.pot + legal.callCost,
    });
    console.log(
      `河牌动作=${riverAction}  权益=${((built.context.math.heroEquity ?? 0) * 100).toFixed(4)}%` +
        ` evidence.applied=${String(ev?.provider.applied)}\n` +
        `  profileMultiplier.calls=${String(ev?.provider.profileMultiplier.calls)}` +
        ` finalMultiplier.calls=${String(ev?.provider.finalMultiplier.calls)}` +
        ` comboWeight.calls=${String(ev?.provider.comboWeightMultiplier.calls)}` +
        ` actions=[${(ev?.provider.actions ?? []).join(',')}]\n` +
        `  trace=${JSON.stringify(
          trace.map((t) => ({ street: t.street, action: t.action, note: (t.noteZh ?? '').slice(0, 46) })),
        )}\n` +
        `  exploit.bluffCatchDelta=${advice?.exploit.bluffCatchDelta.toFixed(4)} deDuplicated=${String(advice?.exploit.deDuplicated)}`,
    );
  }
}

function item5b(): void {
  console.log('=== item5b：rangeCounter / 全量 diagnostics 是否随进程历史漂移 ===\n');
  const input = node('BET');
  const run = () => {
    const r = analyzeManualHand(input, OPTIONS);
    if (!r.ok) throw new Error('分析失败');
    return {
      full: JSON.stringify(r.decision.diagnostics),
      decision: JSON.stringify({
        action: r.decision.action, size: r.decision.sizeChips,
        conf: r.decision.confidence, band: r.decision.band,
      }),
      ids: [...JSON.stringify(r.decision).matchAll(/"(?:rangeId|previousRangeId|newRangeId)":"[^"]*"/g)].map((m) => m[0]),
    };
  };
  const a = run();
  // 中间插入另一手牌 + 另一个画像（推进 rangeCounter 与任何隐藏状态）
  const noise = analyzeManualHand(node('CHECK', 'MANIAC'), OPTIONS);
  const b = run();
  console.log(`决策快照 A===B ? ${a.decision === b.decision ? 'YES' : 'NO'}`);
  console.log(`全量 diagnostics A===B ? ${a.full === b.full ? 'YES（逐字节）' : 'NO'}`);
  console.log(`diagnostics 长度 A=${a.full.length} B=${b.full.length}`);
  console.log(`决策输出里出现 rangeId 字段的次数：A=${a.ids.length} B=${b.ids.length} ${JSON.stringify(a.ids.slice(0, 3))}`);
  if (a.full !== b.full) {
    for (let i = 0; i < Math.min(a.full.length, b.full.length); i += 1) {
      if (a.full[i] !== b.full[i]) {
        console.log(`首个差异 @${i}: A=${a.full.slice(Math.max(0, i - 80), i + 80)}`);
        console.log(`                B=${b.full.slice(Math.max(0, i - 80), i + 80)}`);
        break;
      }
    }
  }
  void noise;
}

const mode = process.argv[2] ?? 'item1';
if (mode === 'item1') item1();
else if (mode === 'item5b') item5b();
else console.log(`未知 mode：${mode}`);
