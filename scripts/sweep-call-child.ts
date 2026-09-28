/*
 * 「爱跟系数」扫描的子进程：在**一个固定系数**下跑完所有真实决策点，输出 JSON。
 *
 * 为什么要独立进程：系数在**模块加载时**读取环境变量（`DSH_CALL_TENDENCY_COEF`），
 * 同一进程里改不了。只读，不写生产文件。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { loadKnowledgeBase } from '../src/domain/knowledge/knowledgeLoader.ts';
import type { ManualHandInput } from '../src/app/manualInput/manualInput.ts';

const ROOT = process.cwd();
const CACHE = join(ROOT, 'scripts', 'tmp-ablation', 'snapshots.json');

const knowledge = loadKnowledgeBase();
if (!knowledge.ok) {
  console.error('知识库加载失败');
  process.exit(1);
}
const rules = knowledge.index.allRules();

type CachedSnap = {
  input: ManualHandInput;
  street: string;
  realAction: string;
  responseAction: string;
};

const snaps = JSON.parse(readFileSync(CACHE, 'utf8')) as CachedSnap[];

const rows: {
  action: string | null;
  foldLikelihood: number | null;
  street: string;
  responseAction: string;
  realAction: string;
}[] = [];

for (const snap of snaps) {
  const r = analyzeManualHand(snap.input, { rules, writeLog: false, equitySeed: 1 });
  if (!r.ok) {
    rows.push({
      action: null,
      foldLikelihood: null,
      street: snap.street,
      responseAction: snap.responseAction,
      realAction: snap.realAction,
    });
    continue;
  }

  type SizeLike = { sizeChips?: number; betAmount?: number; foldLikelihood?: number };
  const diag = r.decision.diagnostics as unknown as {
    betDecision?: { sizes?: readonly SizeLike[] };
    preflopRaise?: { sizes?: readonly SizeLike[] };
  };
  const sizes: readonly SizeLike[] = diag.betDecision?.sizes ?? diag.preflopRaise?.sizes ?? [];
  const amountOf = (s: SizeLike): number => s.betAmount ?? s.sizeChips ?? 0;
  const want = r.decision.sizeChips;
  const hit =
    sizes.length === 0
      ? undefined
      : want === undefined
        ? sizes[0]
        : (sizes.find((s) => amountOf(s) === want) ??
          sizes.reduce((a, b) => (Math.abs(amountOf(b) - want) < Math.abs(amountOf(a) - want) ? b : a)));

  rows.push({
    action: r.decision.action,
    foldLikelihood: hit?.foldLikelihood ?? null,
    street: snap.street,
    responseAction: snap.responseAction,
    realAction: snap.realAction,
  });
}

process.stdout.write(
  JSON.stringify({ coef: Number(process.env['DSH_CALL_TENDENCY_COEF'] ?? '0.30'), rows }) + '\n',
);
