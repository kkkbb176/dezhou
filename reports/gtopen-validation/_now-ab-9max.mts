/**
 * 9MAX 已知节点 A/B 对照探针（只读，不写生产缓存）
 *   A = 空缓存目录（ALPHA_GTO_CACHE_DIR 指向临时目录）⇒ 无求解器范围
 *   B = 生产缓存目录 ⇒ 使用已通过准入的 9MAX 求解器范围
 * 用法：node --experimental-strip-types <此文件> A|B
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mode = (process.argv[2] || 'B').toUpperCase();
let tempDir = null;
if (mode === 'A') {
  tempDir = mkdtempSync(join(tmpdir(), 'gtopen-9max-A-'));
  process.env['ALPHA_GTO_CACHE_DIR'] = tempDir;
}

const input = {
  tableSize: 9,
  heroPosition: 'BB',
  heroCards: ['Ah', 'Ad'],
  board: [],
  street: 'PREFLOP',
  effectiveStackBB: 100,
  actionHistory: [
    { position: 'UTG', type: 'RAISE', amountBB: 2.5, street: 'PREFLOP' },
    { position: 'UTG1', type: 'FOLD', street: 'PREFLOP' },
    { position: 'UTG2', type: 'FOLD', street: 'PREFLOP' },
    { position: 'LJ', type: 'FOLD', street: 'PREFLOP' },
    { position: 'HJ', type: 'FOLD', street: 'PREFLOP' },
    { position: 'CO', type: 'FOLD', street: 'PREFLOP' },
    { position: 'BTN', type: 'FOLD', street: 'PREFLOP' },
    { position: 'SB', type: 'FOLD', street: 'PREFLOP' },
  ],
  environment: 'LOW_STAKES_ONLINE',
};

const { analyzeManualHand, prefetchSolverRangesForInput } = await import('../../src/app/alphaPipeline.ts');
const { gtoCachedLookup, gtoProvider } = await import('../../src/app/gto/gtoApi.ts');

const pf = await prefetchSolverRangesForInput(input, { gtoProvider: gtoProvider(), gtoLookup: gtoCachedLookup() });
const rangeKeys = Object.keys(pf.ranges);
const withRange = analyzeManualHand(input, { asOf: 1758500000000, gtoRanges: pf.ranges });
const noRange = analyzeManualHand(input, { asOf: 1758500000000 });

function pick(r) {
  const vm = r.viewModel;
  const math = vm.debug.math;
  const get = (needle) => (math.find((m) => m.label.includes(needle)) || {}).value;
  return {
    actionZh: vm.actionZh,
    sizeZh: vm.sizeZh,
    confidenceZh: vm.confidenceZh,
    classificationZh: vm.classificationZh,
    equityRef: get('整体范围权益'),
    callEv: get('跟注 EV'),
    gtoState: r.gtoStatus.state,
    gtoMsg: r.gtoStatus.messageZh,
    cacheSource: (r.gtoStatus.outcomes[0] || {}).cacheSource,
    provFromSolver: (r.rangeProvenance[0] || {}).fromSolver,
    provSupport: (r.rangeProvenance[0] || {}).supportSize,
    provEffCombos: (r.rangeProvenance[0] || {}).effectiveComboCount,
    provConfidence: (r.rangeProvenance[0] || {}).confidence,
    candidates: vm.debug.candidates.map((c) => `${c.actionZh} ${c.sizeZh} = ${c.evZh}`),
  };
}

console.log(JSON.stringify({
  mode,
  cacheDir: process.env['ALPHA_GTO_CACHE_DIR'] ?? '(production default)',
  prefetchOutcomes: pf.outcomes.map((o) => ({ opponentId: o.opponentId, state: o.state, priorOk: o.prior ? o.prior.ok : null })),
  rangeKeys,
  NO_RANGE: pick(noRange),
  WITH_RANGE: pick(withRange),
}, null, 2));
