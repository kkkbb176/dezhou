/*
 * 对抗模拟的**子进程**：在**一个固定配置**下跑完全部真实决策点，把结果以 JSON 打到 stdout。
 *
 * 为什么要独立进程：`betResponse.ts` 的三个常数在**模块加载时**读取环境变量，
 * 同一进程里改不了。父进程 `ablate-fold-model.ts` 负责按配置 spawn。
 *
 * ⚠️ 只读：不写任何生产文件。
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

type CachedSnap = { input: ManualHandInput };

const snaps = JSON.parse(readFileSync(CACHE, 'utf8')) as CachedSnap[];

const rows: {
  index: number;
  action: string | null;
  sizeBB: number | null;
  foldLikelihood: number | null;
  actionable: boolean;
}[] = [];

for (let i = 0; i < snaps.length; i += 1) {
  const input = snaps[i]!.input;
  const r = analyzeManualHand(input, { rules, writeLog: false, equitySeed: 1 });
  if (!r.ok) {
    rows.push({ index: i, action: null, sizeBB: null, foldLikelihood: null, actionable: false });
    continue;
  }

  /* 取被建议尺寸的 foldLikelihood（字段名在翻前/翻后不同，见 calibrate 脚本的说明） */
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
    index: i,
    action: r.decision.action,
    sizeBB: r.decision.sizeBB ?? null,
    foldLikelihood: hit?.foldLikelihood ?? null,
    actionable: r.decision.actionable,
  });
}

process.stdout.write(JSON.stringify({ config: 'child', rows }) + '\n');
