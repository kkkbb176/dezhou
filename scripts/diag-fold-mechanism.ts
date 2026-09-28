/*
 * 🔴 **修法前的机理确认**：83.7% 的弃牌质量到底从哪来？
 *
 * 上一轮的上限探测说明「调常数压不下去」。但那也可能是**我猜错了机理**——
 * 若真正的成因不是「牌力代理偏低」，而是「门槛/余量算错」，那么换代理也白做。
 *
 * 所以在动手术之前，先把**逐组合的 continueFraction 分布**打出来：
 *
 * - 若分布是「**一大片组合**都落在低分区」⇒ 机理 = 代理整体偏低 ⇒ 换代理有效；
 * - 若是「**少数组合**拿了巨大权重」⇒ 机理 = 权重/归一化问题 ⇒ 换代理无效。
 *
 * 同时把**权重**与**组合占比**并排打出来（`diag-fold-composition` 已经显示
 * 两者差异很大：质量 74.8% vs 组合占比未知），这是判据的关键。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { buildResponseModel } from '../src/domain/postflop/betResponse.ts';
import { parseCardCode } from '../src/app/manualInput/manualInput.ts';
import { loadKnowledgeBase } from '../src/domain/knowledge/knowledgeLoader.ts';
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { parsePhh } from '../src/domain/realHands/phh.ts';
import { toValidatorSnapshotsDetailed } from '../src/domain/realHands/phhToEngineInput.ts';

const knowledge = loadKnowledgeBase();
if (!knowledge.ok) throw new Error('知识库加载失败');
const rules = knowledge.index.allRules();

const ROOT = join(process.cwd(), 'third_party', 'phh-dataset');

/** 逐组合的（质量份额, fold 权重, tier） */
const comboRows: { massShare: number; foldWeight: number; continueFraction: number; tier: number; street: string }[] = [];

for (const d of readdirSync(ROOT)) {
  const dir = join(ROOT, d);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    continue;
  }
  for (const f of entries.filter((x) => x.endsWith('.phh'))) {
    const parsed = parsePhh(readFileSync(join(dir, f), 'utf8'));
    if (!parsed.ok) continue;
    for (const snap of toValidatorSnapshotsDetailed(parsed.hand).snapshots) {
      const r = analyzeManualHand(snap.input, { rules, writeLog: false, equitySeed: 1 });
      if (!r.ok) continue;
      if (r.decision.action !== 'BET' && r.decision.action !== 'RAISE') continue;

      const diag = r.decision.diagnostics as unknown as {
        betDecision?: {
          sizes?: readonly {
            betAmount?: number;
            buckets?: readonly { bucket: string; entries?: readonly { probability: number }[]; mass?: number }[];
          }[];
        };
      };
      const sizes = diag.betDecision?.sizes ?? [];
      const want = r.decision.sizeChips;
      const hit =
        sizes.length === 0
          ? undefined
          : (sizes.find((s) => s.betAmount === want) ??
            sizes.reduce((a, b) => (Math.abs((b.betAmount ?? 0) - want) < Math.abs((a.betAmount ?? 0) - want) ? b : a)));
      if (hit?.buckets === undefined) continue;

      const allEntries = hit.buckets.flatMap((b) => b.entries ?? []);
      const totalProb = allEntries.reduce((s, e) => s + e.probability, 0);
      if (!(totalProb > 0)) continue;

      const foldBucket = hit.buckets.find((b) => b.bucket === 'FOLD');
      const foldEntries = new Set(foldBucket?.entries ?? []);

      for (const e of allEntries) {
        const isFold = foldEntries.has(e);
        comboRows.push({
          massShare: e.probability / totalProb,
          foldWeight: isFold ? 1 : 0,
          continueFraction: isFold ? 0 : 1,
          tier: -1,
          street: snap.street,
        });
      }
    }
  }
}

console.log(`桶内 entries 样本 ${comboRows.length}（跨全部决策点的建议尺寸）`);
console.log('');
console.log('⚠️ **口径**：桶内 `entries` 是**按桶各自归一化**的权重，');
console.log('   因此**不能**跨桶求和当作总体质量（我第一版就是这么错的，得到了 >100% 的荒谬数）。');
console.log('   本探针只用它回答一个**计数**问题：判弃的**组合个数**占多少。');
console.log('');
const foldRows = comboRows.filter((r) => r.foldWeight > 0);
const foldShareByCount = foldRows.length / comboRows.length;
console.log(
  `判弃的组合个数 ${foldRows.length} / ${comboRows.length} = **${(foldShareByCount * 100).toFixed(1)}%**`,
);
console.log('');
console.log('判据（写死，避免事后解释）：');
console.log('  · 若这个比例**接近**引擎报的判弃质量（如 83.7%）⇒ 机理 = 「一大片组合都判弃」');
console.log('    ⇒ **代理整体偏低** ⇒ 换代理有效；');
console.log('  · 若组合占比**远小于**质量占比 ⇒ 机理 = 少数组合独大 ⇒ 换代理无效。');
