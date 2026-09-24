import { parentPort, workerData } from 'node:worker_threads';
import { computeAnalysisWork, type AnalysisWork } from './analysisWork.ts';

const started = performance.now();
try {
  parentPort!.postMessage({ kind: 'started' });
  const output = computeAnalysisWork(workerData as AnalysisWork);
  parentPort!.postMessage({ ok: true, output, computeMs: performance.now() - started });
} catch (error) {
  parentPort!.postMessage({ ok: false, message: error instanceof Error ? error.message : String(error) });
}
