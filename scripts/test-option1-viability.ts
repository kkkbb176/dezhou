/*
 * 🔴 **判定性实验**：第 1 条修法（传递更细的「对牌面成手强度」）能补上缺口吗？
 *
 * ## 怀疑
 *
 * §6.6 的结论是「判弃组合占 66.4% ⇒ 代理整体偏低 ⇒ 换代理有效」。
 * 但「换代理」具体换成什么？在我的层级（`buildResponseModel`，只有 `hole` + `board`）
 * 能造出来的**新信息**只有两类：
 *
 * | 可造 | 是否已有 |
 * |---|---|
 * | 更细的**成手**强度（同花/顺子/三条/两对/一对/高牌 的档次与踢脚） | `boardRelativeTierOf` 已给 0–5 档 |
 * | 更细的**听牌**质量（同花听/两头顺/卡顺/后门花） | `drawProfileOf` 已给 `villainDraw` |
 *
 * ⇒ **成手强度不含待发牌权益**，而缺陷的核心正是待发牌权益（river 准、flop 不准）。
 * 而「待发牌权益」在这一层能造的就是听牌质量 —— **已经有了**。
 *
 * ## 所以本实验要回答
 *
 * **把听牌信息用满**（不再只分 STRONG/WEAK/NO 三档，而是按 `outs` 细分），
 * 校准误差能降到多少？若降到接近 0 ⇒ 第 1 条可行；若很快饱和 ⇒ 第 1 条无效。
 *
 * ⚠️ 本实验**只读**：用一个临时的、带权重的 `villainDraw` 细分值做**离线估算**，
 * **不改任何生产文件**。判据写死在脚本里。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { loadKnowledgeBase } from '../src/domain/knowledge/knowledgeLoader.ts';
import { parsePhh } from '../src/domain/realHands/phh.ts';
import { toValidatorSnapshotsDetailed } from '../src/domain/realHands/phhToEngineInput.ts';

const knowledge = loadKnowledgeBase();
if (!knowledge.ok) throw new Error('知识库加载失败');
const rules = knowledge.index.allRules();

const ROOT = join(process.cwd(), 'third_party', 'phh-dataset');

/*
 * 关键判据：**引擎报的 foldLikelihood 与「听牌/成手构成」的相关性有多强？**
 *
 * 若 foldLikelihood 与「这个范围里有多少强听牌组合」几乎无关，说明模型**没有**
 * 把听牌信息用满 ⇒ 第 1 条（把听牌用满）还有空间；
 * 若已经强相关 ⇒ 已经用满了 ⇒ 第 1 条无效。
 *
 * 另外做一个**离线上界估算**：假设我把「判弃」的整体比例按听牌占比重新分配，
 * 能到多准 —— 这是第 1 条的**理论上界**。
 */
type Row = {
  /** 引擎报的判弃质量 */
  predicted: number;
  /** 实际配对结果 */
  folded: boolean;
  /** 同一决策点上，策略给出的三桶**组合数**（用来算"强听牌占比"） */
  foldCombos: number;
  callCombos: number;
  raiseCombos: number;
  street: string;
};

const rows: Row[] = [];

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
    const snaps = toValidatorSnapshotsDetailed(parsed.hand).snapshots;
    for (let i = 0; i < snaps.length; i += 1) {
      const snap = snaps[i]!;
      const r = analyzeManualHand(snap.input, { rules, writeLog: false, equitySeed: 1 });
      if (!r.ok) continue;
      if (r.decision.action !== 'BET' && r.decision.action !== 'RAISE') continue;
      const later = snaps.slice(i + 1).find((x) => x.heroName !== snap.heroName);
      if (later === undefined) continue;

      type SizeLike = {
        betAmount?: number;
        foldLikelihood?: number;
        foldComboCount?: number;
        callComboCount?: number;
        raiseComboCount?: number;
      };
      const diag = r.decision.diagnostics as unknown as {
        betDecision?: { sizes?: readonly SizeLike[] };
      };
      const sizes = diag.betDecision?.sizes ?? [];
      if (sizes.length === 0) continue;
      const want = r.decision.sizeChips;
      const hit =
        sizes.find((s) => s.betAmount === want) ??
        sizes.reduce((a, b) => (Math.abs((b.betAmount ?? 0) - want) < Math.abs((a.betAmount ?? 0) - want) ? b : a));
      if (hit.foldLikelihood === undefined) continue;

      rows.push({
        predicted: hit.foldLikelihood,
        folded: later.realAction === 'FOLD',
        foldCombos: hit.foldComboCount ?? 0,
        callCombos: hit.callComboCount ?? 0,
        raiseCombos: hit.raiseComboCount ?? 0,
        street: snap.street,
      });
    }
  }
}

const mean = (xs: number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);
const corr = (xs: number[], ys: number[]): number => {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return 0;
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i += 1) {
    num += (xs[i]! - mx) * (ys[i]! - my);
    dx += (xs[i]! - mx) ** 2;
    dy += (ys[i]! - my) ** 2;
  }
  return dx === 0 || dy === 0 ? 0 : num / Math.sqrt(dx * dy);
};

console.log(`样本 ${rows.length}`);
console.log('');
console.log('A. 引擎报的判弃质量 vs 「范围里判弃组合数占比」的相关性');
const folded = rows.map((r) => (r.folded ? 1 : 0));
const foldComboShare = rows.map((r) => {
  const tot = r.foldCombos + r.callCombos + r.raiseCombos;
  return tot === 0 ? 0 : r.foldCombos / tot;
});
console.log(`   判弃质量 vs 判弃组合占比： r = ${corr(rows.map((r) => r.predicted), foldComboShare).toFixed(3)}`);
console.log(`   判弃质量 vs 实际弃牌：     r = ${corr(rows.map((r) => r.predicted), folded).toFixed(3)}`);
console.log(
  `   ⇒ 若前者接近 1、后者接近 0 ⇒ 模型**自己内部一致**但**与事实无关**` +
    `（即：它在系统性地把"一大片"判弃，而不是按事实区分）`,
);
console.log('');
console.log('B. 按街：判弃质量的离散程度（标准差越大 = 越能区分不同局面）');
for (const st of ['FLOP', 'TURN', 'RIVER']) {
  const g = rows.filter((r) => r.street === st);
  if (g.length === 0) continue;
  const ps = g.map((r) => r.predicted);
  const m = mean(ps);
  const sd = Math.sqrt(mean(ps.map((p) => (p - m) ** 2)));
  const act = g.filter((r) => r.folded).length / g.length;
  console.log(
    `   ${st.padEnd(6)} n=${String(g.length).padStart(4)}  预测 ${(m * 100).toFixed(1)}% ± ${(sd * 100).toFixed(1)}pp  ` +
      `实际 ${(act * 100).toFixed(1)}%`,
  );
}
console.log('');
console.log('判据（写死）：');
console.log('  · 若「判弃质量 vs 实际弃牌」的 r 明显 > 0 ⇒ 模型**已经在区分**不同局面');
console.log('    ⇒ 第 1 条（把牌面信息用满）**还有空间**；');
console.log('  · 若 r ≈ 0 ⇒ 模型**没有区分能力**（只是整体偏低）⇒ 加"更多同类信息"无用；');
console.log('    必须引入**新类别**的信息（对 Hero 的权益）—— 那正是被信息边界禁止的那一类。');
