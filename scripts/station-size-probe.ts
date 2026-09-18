/**
 * 探针：TEST 5 的「跟注站 vs 紧手」尺寸方向 —— 连续混频之后到底发生了什么。
 *
 * 用法：E:\node.exe --experimental-strip-types scripts\station-size-probe.ts
 */
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import type { ManualHandInput } from '../src/app/manualInput/manualInput.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const OPTIONS = { rules: RULES, asOf: 1_757_000_000_000, writeLog: false } as const;
const F = (position: string) => ({ position, type: 'FOLD' }) as never;

function spot(profile: string): ManualHandInput {
  return {
    tableSize: 9, heroPosition: 'BTN', heroCards: ['Kd', 'Th'],
    board: ['Ts', '7c', '3h'], street: 'FLOP',
    effectiveStackBB: 100, seatStacksBB: { UTG: 100, BTN: 100, BB: 100 },
    actionHistory: [
      { position: 'UTG', type: 'CALL', amountBB: 1 }, F('UTG1'), F('UTG2'), F('LJ'), F('HJ'), F('CO'),
      { position: 'BTN', type: 'CALL', amountBB: 1 }, F('SB'), { position: 'BB', type: 'CHECK' },
      { position: 'BB', type: 'CHECK', street: 'FLOP' }, { position: 'UTG', type: 'CHECK', street: 'FLOP' },
    ],
    environment: 'MID_LOW_STAKES', villain: { quickProfile: profile, dynamicHint: 'UNKNOWN' },
  } as unknown as ManualHandInput;
}

for (const profile of ['CALLING_STATION', 'VERY_TIGHT']) {
  const r = analyzeManualHand(spot(profile), OPTIONS);
  if (!r.ok) {
    console.log(`${profile}: ❌ ${JSON.stringify(r.issues)}`);
    continue;
  }
  const bd = r.decision.diagnostics.betDecision as unknown as {
    checkEV: number | null; bestSize: string | null; preferredAction: string;
    sizes: readonly Record<string, unknown>[];
  } | null;
  console.log(`\n──── ${profile} ────`);
  console.log(
    `  动作 ${String(r.decision.action)}｜尺寸 ${String(r.decision.sizeChips)} 筹码` +
      `｜下注分 ${((r.decision.diagnostics.postflop as unknown as { gate?: { estimatedBetEVScore: number } })?.gate?.estimatedBetEVScore ?? 0).toFixed(3)}`,
  );
  if (bd === null) continue;
  console.log(`  CHECK EV ${bd.checkEV}｜最佳 ${String(bd.bestSize)} ⇒ ${bd.preferredAction}`);
  for (const s of bd.sizes) {
    console.log(
      `   · ${String(s['kind'])} = ${Number(s['betAmount']).toFixed(1)}（${(Number(s['ratioToPot']) * 100).toFixed(0)}%）` +
        `｜弃 ${Number(s['foldLikelihood']).toFixed(3)} / 跟 ${Number(s['callLikelihood']).toFixed(3)} / 加 ${Number(s['raiseLikelihood']).toFixed(3)}` +
        `｜EqVsCall ${s['heroEquityVsCallRange'] === null ? '—' : (Number(s['heroEquityVsCallRange']) * 100).toFixed(1) + '%'}` +
        `｜BetEV ${s['betEV'] === null ? '—' : Number(s['betEV']).toFixed(2)}｜分 ${Number(s['score']).toFixed(3)}` +
        `｜多人口径 ${String(s['evKind'])}`,
    );
  }
}
