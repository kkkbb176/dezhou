// Reproducible production evidence for FAST INPUT DECISION UI V2.
// Run with Node >=22: node --experimental-strip-types scripts/fast-ui-baseline.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync, spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
const root = process.cwd();
const out = path.join(root, 'reports/fast-input-decision-v2');
fs.mkdirSync(out, { recursive: true });
const phase = process.argv.includes('--phase') ? process.argv[process.argv.indexOf('--phase') + 1] : 'before';
if (!['before', 'after'].includes(phase)) throw Error('phase must be before or after');
const frozenBefore = process.argv.includes('--frozen-before');
const prefix = frozenBefore ? 'baseline-before-frozen' : `baseline-${phase}`;
const json = (name, data, exclusive = false) => fs.writeFileSync(path.join(out, name), JSON.stringify(data, null, 2) + '\n', { flag: exclusive ? 'wx' : 'w' });
// Named timing fields only: do not round numeric decisions or strip range/player identity.
const excludedKeys = ['timings', 'timingsMs', 'timingMs', 'timing', 'costMs', 'elapsedMs', 'durationMs', 'duration', 'createdAt', 'generatedAt', 'id', 'decisionId', 'logId', 'tableId'];
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([k]) => !excludedKeys.includes(k)).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, stable(v)]));
  return value;
}
function normalizedEvidence(report) {
  return { phase: report.phase, source: `${prefix}-fixtures.json`, excludedKeys, fixtures: report.fixtures.map(f => ({ name: f.name, deterministic: JSON.stringify(stable(f.result)) === JSON.stringify(stable(f.repeatedResult)), stable: stable({ preview: f.preview, normalized: f.normalizedInput, result: f.result }) })), fiveBetLegality: report.fiveBetLegality };
}
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
const protectedPaths = ['src/domain', 'src/app/decision', 'src/app/manualInput', 'src/viewmodels', 'src/app/alphaPipeline.ts', 'src/app/table', 'src/infra/artifactDefinitions.ts', 'data/artifact-manifest.json', 'data/gto-cache/index.json'];
const snapshotPaths = [...protectedPaths, 'src/app/web'];
const command = (cmd, args) => { const r = spawnSync(cmd, args, { cwd: root, encoding: 'utf8' }); return { exitCode: r.status, stdout: r.stdout, stderr: r.stderr }; };
const metaPath = path.join(out, `${prefix}-metadata.json`);
if (!fs.existsSync(metaPath)) {
  const files = snapshotPaths.flatMap(p => fs.statSync(p).isDirectory() ? walk(p) : [p]).sort();
  json(`${prefix}-metadata.json`, {
    capturedAt: new Date().toISOString(), root, phase,
    machine: { platform: process.platform, release: os.release(), arch: process.arch, cpu: os.cpus()[0]?.model, cpuCount: os.cpus().length, node: process.version, versions: process.versions },
    gitHead: command('git', ['rev-parse', 'HEAD']), gitStatus: command('git', ['status', '--porcelain=v1']),
    protectedPaths, hashes: Object.fromEntries(files.map(f => [f.replaceAll('\\', '/'), sha256(f)])),
  }, true);
  if (phase === 'before' && !frozenBefore) for (const file of walk('src/app/web')) {
    const dest = path.join(out, 'baseline-before-web-source', path.relative('src/app/web', file));
    fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(file, dest, fs.constants.COPYFILE_EXCL);
  }
  console.log(`Captured ${prefix}-metadata.json`);
}
if (process.argv.includes('--capture-only')) process.exit(0);
if (process.argv.includes('--normalize-only')) {
  const raw = JSON.parse(fs.readFileSync(path.join(out, `${prefix}-fixtures.json`), 'utf8'));
  const normalized = normalizedEvidence(raw);
  json(`${prefix}-stable.json`, normalized, true);
  const log = fs.readFileSync(path.join(out, `${prefix}-verify.log`), 'utf8');
  const counts = Object.fromEntries([...log.matchAll(/^(?:#|ℹ) (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) (.+)$/gm)].map(m => [m[1], Number(m[2])]));
  json(`${prefix}-verify-counts.json`, { counts, source: `${prefix}-verify.log`, sha256: sha256(path.join(out, `${prefix}-verify.log`)) }, true);
  console.log(JSON.stringify({ counts, deterministic: normalized.fixtures.map(f => [f.name, f.deterministic]) }));
  process.exit(0);
}
if (process.argv.includes('--verify')) {
  const logPath = path.join(out, `${prefix}-verify.log`);
  if (fs.existsSync(logPath)) throw Error(`Refusing to overwrite ${logPath}`);
  const start = Date.now(); const fd = fs.openSync(logPath, 'wx');
  const child = spawn(process.platform === 'win32' ? 'cmd.exe' : 'npm', process.platform === 'win32' ? ['/d', '/s', '/c', 'npm run verify'] : ['run', 'verify'], { cwd: root, stdio: ['ignore', fd, fd], windowsHide: true });
  child.on('exit', code => {
    fs.closeSync(fd); const log = fs.readFileSync(logPath, 'utf8');
    const counts = Object.fromEntries([...log.matchAll(/^(?:#|ℹ) (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) (.+)$/gm)].map(m => [m[1], Number(m[2])]));
    json(`${prefix}-verify-summary.json`, { command: 'npm run verify', exitCode: code, elapsedMs: Date.now() - start, counts, manifestMismatch: /manifest.*(mismatch|不一致|不匹配|过期)|manifest drift|MANIFEST_MISMATCH/i.test(log), logPath, sha256: sha256(logPath) }, true);
    console.log(JSON.stringify({ phase, verifyExit: code, counts, logPath })); process.exitCode = code ?? 1;
  });
} else {
  await captureFixtures();
}

async function captureFixtures() {
  const file = `${prefix}-fixtures.json`;
  if (fs.existsSync(path.join(out, file))) throw Error(`Refusing to overwrite ${file}`);
  let sourceRoot = root;
  if (frozenBefore) {
    sourceRoot = path.join(out, 'baseline-before-frozen-production');
    fs.mkdirSync(sourceRoot, { recursive: true });
    fs.cpSync(path.join(root, 'src'), path.join(sourceRoot, 'src'), { recursive: true, force: false, errorOnExist: true });
    const original = JSON.parse(fs.readFileSync(path.join(out, 'baseline-before-metadata.json'), 'utf8'));
    const restored = [];
    for (const [file, hash] of Object.entries(original.hashes)) {
      if (!file.startsWith('src/') || file.startsWith('src/app/web/')) continue;
      const copy = path.join(sourceRoot, file);
      if (sha256(copy) === hash) continue;
      // These files were clean in original git status. Never reconstruct dirty engine code from HEAD.
      if (!['src/app/table/table.types.ts', 'src/app/table/tablePreview.ts'].includes(file)) throw Error(`Unexpected changed source ${file}; cannot reconstruct original`);
      const old = spawnSync('git', ['show', `${original.gitHead.stdout.trim()}:${file}`], { cwd: root });
      if (old.status !== 0) throw Error(`Cannot recover ${file}`);
      // Windows working tree uses CRLF while Git stores LF.
      const variants = [old.stdout, Buffer.from(old.stdout.toString('utf8').replaceAll('\r\n', '\n').replaceAll('\n', '\r\n'))];
      const bytes = variants.find(b => crypto.createHash('sha256').update(b).digest('hex') === hash);
      if (!bytes) throw Error(`Git copy does not match recorded original SHA256: ${file}`);
      fs.writeFileSync(copy, bytes); restored.push(file);
    }
    fs.mkdirSync(path.join(sourceRoot, 'data'), { recursive: true });
    fs.cpSync(path.join(root, 'data/knowledge'), path.join(sourceRoot, 'data/knowledge'), { recursive: true });
    fs.copyFileSync(path.join(root, 'data/artifact-manifest.json'), path.join(sourceRoot, 'data/artifact-manifest.json'));
    json('baseline-before-frozen-provenance.json', { createdAt: new Date().toISOString(), originalMetadata: 'baseline-before-metadata.json', restoredFromHead: restored, allRecordedNonWebSourceHashesMatch: true, note: 'Frozen source copy reconstructs clean-at-start table files changed concurrently during raw fixture capture. Production files were not changed.' }, true);
  }
  const mod = rel => import(pathToFileURL(path.join(sourceRoot, 'src', rel)).href);
  const { createTable } = await mod('app/table/tableState.ts');
  const { handleTableRequest, RevisionGuard } = await mod('app/table/tableApi.ts');
  const { buildTablePreview } = await mod('app/table/tablePreview.ts');
  const { tableStateToManualHandInput } = await mod('app/table/tableAdapter.ts');
  const { parseManualInput } = await mod('app/manualInput/manualInput.ts');
  const { analyzeManualHand } = await mod('app/alphaPipeline.ts');
  const { loadKnowledgeBaseOrThrow } = await mod('domain/knowledge/knowledgeLoader.ts');
  const options = { rules: loadKnowledgeBaseOrThrow(path.join(root, 'data/knowledge')).allRules(), asOf: 1757000000000, equitySeed: 20260924, writeLog: false, budget: { softMs: 600000, hardMs: 1200000 } };
  const historyDir = path.join(out, `baseline-${phase}-isolated-history`);
  fs.mkdirSync(historyDir, { recursive: true });
  const deps = { guard: new RevisionGuard(), newTableId: () => 'fast-ui-fixed', historyDir };
  const traces = [];
  function op(state, operation) {
    const result = handleTableRequest({ state, op: operation }, deps);
    traces.push({ tableId: state.tableId, operation, ok: result.ok, revision: result.state?.revision, issues: result.ok ? [] : result.issues });
    if (!result.ok) throw Error(JSON.stringify({ operation, issues: result.issues }));
    return result.state;
  }
  function init(id, size = 9, cards = ['Ks', 'Kh']) {
    let s = createTable({ tableId: id, tableSize: size, heroPosition: 'BTN', defaultStackBB: 100, bigBlindBB: 100 });
    s = op(s, { kind: 'FILL_EMPTY_SEATS' });
    for (const card of cards) s = op(s, { kind: 'SET_HERO_CARD', card });
    return s;
  }
  function foldTo(s, position) {
    for (let i = 0; i < 12; i++) {
      const p = buildTablePreview(s);
      if (p.currentActorPosition === position) return s;
      if (!p.currentActorPosition) throw Error(`Cannot fold to ${position}: ${JSON.stringify(p.decision)}`);
      s = op(s, { kind: 'ACT', action: { type: 'FOLD' } });
    }
    throw Error(`Fold limit ${position}`);
  }
  const act = (s, type, bb) => op(s, { kind: 'ACT', action: { type, ...(bb === undefined ? (type === 'CALL' ? { amountChips: Math.round(buildTablePreview(s).callAmountBB * 100) } : {}) : { amountChips: Math.round(bb * 100) }) } });
  const cards = (s, list, start) => list.reduce((t, card, i) => op(t, { kind: 'SET_BOARD_CARD', slot: start + i, card }), s);
  const fixtures = [];
  function snapshot(name, state) {
    const preview = buildTablePreview(state);
    const adapter = tableStateToManualHandInput(state);
    if (!adapter.ok) throw Error(`${name}: ${JSON.stringify(adapter.issues)}`);
    const normalized = parseManualInput(adapter.input);
    const start = Date.now(); const first = analyzeManualHand(adapter.input, options); const elapsedMs = Date.now() - start;
    const second = analyzeManualHand(structuredClone(adapter.input), options);
    const stableFirst = stable(first), stableSecond = stable(second);
    const deterministic = JSON.stringify(stableFirst) === JSON.stringify(stableSecond);
    const differences = [];
    function diff(a, b, key = '') { if (JSON.stringify(a) === JSON.stringify(b)) return; if (a && b && typeof a === 'object' && typeof b === 'object') { for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diff(a[k], b[k], `${key}.${k}`); } else differences.push({ key, first: a, second: b }); }
    diff(stableFirst, stableSecond);
    fixtures.push({ name, state, preview, adapterInput: adapter.input, normalizedInput: normalized, result: first, repeatedResult: second, deterministic, elapsedMs, stable: stable({ preview, normalized, result: first }) });
    console.log(JSON.stringify({ name, ready: preview.canAnalyze, minRaiseToBB: preview.minRaiseToBB, ok: first.ok, deterministic, elapsedMs, differences }));
  }
  snapshot('preflop-open-9max-ready', foldTo(init('fixture-open9'), 'BTN'));
  snapshot('preflop-open-6max-ready', foldTo(init('fixture-open6', 6), 'BTN'));
  let five = foldTo(init('fixture-fivebet'), 'CO');
  five = act(five, 'RAISE', 2.5);
  snapshot('preflop-facing-open-ready', five);
  five = act(five, 'RAISE', 10);
  five = foldTo(five, 'CO'); five = act(five, 'RAISE', 22);
  snapshot('preflop-facing-4bet-min34-ready', five);
  const illegal32 = handleTableRequest({ state: five, op: { kind: 'ACT', action: { type: 'RAISE', amountChips: 3200 } } }, deps);
  const legal34 = handleTableRequest({ state: five, op: { kind: 'ACT', action: { type: 'RAISE', amountChips: 3400 } } }, deps);
  let post = foldTo(init('fixture-postflop', 6, ['Ah', 'Qc']), 'CO');
  post = act(post, 'RAISE', 2.5); post = act(post, 'CALL'); post = act(post, 'FOLD'); post = act(post, 'FOLD');
  post = cards(post, ['Qs', '8d', '3c'], 0);
  post = act(post, 'BET', 2); snapshot('flop-facing-bet-ready', post);
  post = act(post, 'CALL'); post = cards(post, ['6s'], 3);
  post = act(post, 'BET', 7); snapshot('turn-facing-bet-ready', post);
  post = act(post, 'CALL'); post = cards(post, ['Ks'], 4);
  post = act(post, 'BET', 20); snapshot('river-facing-bet-ready', post);
  const report = {
    phase, capturedAt: new Date().toISOString(), productionPath: 'handleTableRequest -> buildTablePreview -> tableStateToManualHandInput -> parseManualInput -> analyzeManualHand',
    options: { ...options, rules: undefined }, excludedStableKeys: excludedKeys,
    scope: 'Production synchronous pipeline with fixed seed/asOf; no GTO provider injected, no network/solver prefetch, no decision log writes. Table history isolated under evidence directory.',
    fixtures, operations: traces,
    fiveBetLegality: { expectedMinRaiseToBB: 34, actualMinRaiseToBB: buildTablePreview(five).minRaiseToBB, raise32: { ok: illegal32.ok, issues: illegal32.ok ? [] : illegal32.issues }, raise34: { ok: legal34.ok, issues: legal34.ok ? [] : legal34.issues } },
  };
  json(file, report, true);
  json(`${prefix}-stable.json`, normalizedEvidence(report), true);
  if (phase === 'after') {
    const beforeFile = fs.existsSync(path.join(out, 'baseline-before-frozen-stable.json')) ? 'baseline-before-frozen-stable.json' : 'baseline-before-stable.json';
    const before = JSON.parse(fs.readFileSync(path.join(out, beforeFile), 'utf8'));
    const beforeMeta = JSON.parse(fs.readFileSync(path.join(out, 'baseline-before-metadata.json'), 'utf8'));
    const nowMeta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    const diffs = fixtures.map(f => { const old = before.fixtures.find(x => x.name === f.name); return { name: f.name, identical: JSON.stringify(old?.stable) === JSON.stringify(f.stable), decisionIdentical: JSON.stringify(old?.stable.result) === JSON.stringify(stable(f.result)), normalizedInputIdentical: JSON.stringify(old?.stable.normalized) === JSON.stringify(stable(f.normalizedInput)), deterministic: f.deterministic }; });
    const protectedChanged = Object.entries(beforeMeta.hashes).filter(([file, hash]) => beforeMeta.protectedPaths.some(p => file === p || file.startsWith(p + '/')) && nowMeta.hashes[file] !== hash).map(([file]) => file);
    json('baseline-comparison.json', { comparedAt: new Date().toISOString(), beforeFile, fixtureComparisons: diffs, protectedChanged, allStableIdentical: diffs.every(d => d.identical), allDecisionsIdentical: diffs.every(d => d.decisionIdentical), allNormalizedInputsIdentical: diffs.every(d => d.normalizedInputIdentical), allRepeatDeterministic: fixtures.every(f => f.deterministic), legalityUnchanged: JSON.stringify(before.fiveBetLegality) === JSON.stringify(report.fiveBetLegality) });
  }
}
