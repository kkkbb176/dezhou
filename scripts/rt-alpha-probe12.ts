/**
 * rt-alpha-probe12 —— 复核：confidenceOf 的 dynamicConfidence 分量取值
 * 目的：确认「动态层分量」在 UNKNOWN 时到底是 0.5 还是 0（避免误报）
 */

import { Position, Street } from '../src/domain/types.ts';
import { parseManualInput, DynamicHint } from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';
import { GameEnvironment } from '../src/domain/range/gameEnvironment.ts';
import { RULES, hr } from './rt-alpha-lib.ts';
import type { ManualHandInput } from '../src/app/manualInput/manualInput.ts';

const FLOP: ManualHandInput = {
  tableSize: 6,
  heroPosition: Position.CO,
  heroCards: ['As', 'Kd'],
  board: ['Kh', '7c', '2d'],
  street: Street.FLOP,
  effectiveStackBB: 100,
  actionHistory: [
    { position: Position.UTG, type: 'FOLD' },
    { position: Position.HJ, type: 'FOLD' },
    { position: Position.CO, type: 'RAISE', amountBB: 3 },
    { position: Position.BTN, type: 'FOLD' },
    { position: Position.SB, type: 'FOLD' },
    { position: Position.BB, type: 'CALL', amountBB: 2 },
    { position: Position.BB, type: 'CHECK', street: Street.FLOP },
  ],
  environment: 'MID_LOW_STAKES',
};

hr('复核：动态快照的 computed / state / confidence 与 confidenceOf 的 dynamic 分量');

for (const hint of Object.values(DynamicHint)) {
  const parsed = parseManualInput({ ...FLOP, villain: { quickProfile: 'UNKNOWN', dynamicHint: hint } });
  if (!parsed.ok) continue;
  const gate = buildAnalyzableState(parsed.value);
  if (!gate.ok) continue;
  const built = buildDecisionContext({
    state: gate.state,
    rules: RULES,
    environment: GameEnvironment.MID_LOW_STAKES,
    asOf: 1_757_000_000_000,
    dynamicHint: hint,
  });
  const dyn = built.context.dynamic;
  // 复刻 decisionEngine.confidenceOf 第 5 步的判据
  const branch =
    dyn.computed && dyn.state !== 'UNKNOWN' && dyn.confidence > 0 ? dyn.confidence : 0.5;
  console.log(
    `  hint=${hint.padEnd(20)} computed=${String(dyn.computed).padEnd(5)} state=${dyn.state.padEnd(16)} ` +
      `conf=${dyn.confidence.toFixed(4)} → confidenceOf 用的 dynamicConfidence = ${branch}`,
  );
}

hr('复核：confidenceOf 的八个分量（用引擎内部分量说明）');
const parsed = parseManualInput(FLOP);
if (parsed.ok) {
  const gate = buildAnalyzableState(parsed.value);
  if (gate.ok) {
    const built = buildDecisionContext({
      state: gate.state,
      rules: RULES,
      environment: GameEnvironment.MID_LOW_STAKES,
      asOf: 1_757_000_000_000,
    });
    const c = built.context;
    const dynBound =
      c.dynamic.computed && c.dynamic.state !== 'UNKNOWN' && c.dynamic.confidence > 0
        ? c.dynamic.confidence
        : 0.5;
    const playerConf =
      c.player === null ? 0.5 : c.player.neutralized ? 0.5 : c.player.confidence > 0 ? c.player.confidence : 0.5;
    const parts = {
      completeness: 1,
      rangeConfidence: c.range?.confidence ?? 0,
      playerConfidence: playerConf,
      environmentConfidence: c.environment.advice.length > 0 ? 0.4 : 0.3,
      dynamicConfidence: dynBound,
      separation: '（取决于 EV 差，见下）',
      precision: c.math.equitySource
        ? c.math.equitySource.method === 'EXACT'
          ? 1
          : Math.max(0.3, Math.min(1, 1 - c.math.equitySource.confidenceHalfWidth * 10))
        : 0.2,
      degradationPenalty: 1,
    };
    console.log(`  ${JSON.stringify(parts, null, 2)}`);
  }
}
