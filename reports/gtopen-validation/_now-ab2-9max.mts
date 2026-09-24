/**
 * 9MAX 已知节点 A/B（返回 9人 / 100BB / BB 面对 UTG 开池）
 *   A = 空缓存目录 ⇒ 无求解器范围（回落启发式）
 *   B = 生产缓存目录 ⇒ 使用通过准入的 9MAX 范围
 * 全程只读：A 用临时目录并关闭后台求解；B 只读生产缓存，不触发后台落盘。
 * 用法：node --experimental-strip-types <file> A|B
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mode = (process.argv[2] || 'B').toUpperCase();
let tempDir = null;
if (mode === 'A') {
  tempDir = mkdtempSync(join(tmpdir(), 'gtopen-9max-A-'));
  process.env['ALPHA_GTO_CACHE_DIR'] = tempDir;
}

const { startAlphaServer } = await import('../../src/app/webServer.ts');

const input = {
  tableSize: 9, heroPosition: 'BB', heroCards: ['Ah', 'Ad'], board: [], street: 'PREFLOP',
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

const server = await startAlphaServer({ port: 0, host: '127.0.0.1', gtoBackgroundSolve: false });
async function pick(label) {
  const res = await fetch(server.url + '/api/analyze', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ input }),
  });
  const j = await res.json();
  console.error('DEBUG_RESP=' + JSON.stringify(j).slice(0,1200));
  const vm = (j.result ?? j).viewModel;
  const get = (n) => (vm.debug.math.find((m) => m.label.includes(n)) || {}).value;
  return {
    label,
    actionZh: vm.actionZh,
    sizeZh: vm.sizeZh,
    confidenceZh: vm.confidenceZh,
    classificationZh: vm.classificationZh,
    equity: get('整体范围权益'),
    callEv: get('跟注 EV'),
    gtoState: (j.result ?? j).gtoStatus.state,
    gtoMsg: (j.result ?? j).gtoStatus.messageZh,
    cacheSource: ((j.result ?? j).gtoStatus.outcomes[0] || {}).cacheSource,
    prov: ((j.result ?? j).rangeProvenance[0]) || null,
    candidates: vm.debug.candidates.map((c) => `${c.actionZh}|${c.sizeZh}|${c.evZh}`),
  };
}
try {
  const noRange = await pick('NO_RANGE');
  const withProd = await pick('WITH_RANGE');
  console.log(JSON.stringify({
    mode,
    cacheDir: process.env['ALPHA_GTO_CACHE_DIR'] ?? '(production default)',
    NO_RANGE: noRange, WITH_RANGE: withProd,
  }, null, 2));
} finally {
  await server.close();
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
}

