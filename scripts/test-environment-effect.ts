/*
 * 🔴 **验证一个疑似真实缺陷**：牌局环境（`LOW_STAKES_ONLINE` 等）对**无画像对手**
 * 的「他会不会弃牌」有没有任何影响？
 *
 * ## 怀疑来源
 *
 * 扫描「爱跟系数」时，5 个系数给出**逐位相同**的结果（`scripts/sweep-call-tendency.ts`）。
 * 追下去发现：`responseTendenciesOf(null, 0, null)` 会走
 * `neutralResponseTendencies()`，而它把 `callScale` **硬编码为 1**。
 *
 * ## 为什么这可能是缺陷（而不是设计）
 *
 * 知识库里有这条规则：
 *
 * ```text
 * env.low.calling-tendency-up   LOW_STAKES_ONLINE   ANY   CALL_WEIGHT   INCREASE
 * ```
 *
 * 它表达的正是「低级别线上**对手更爱跟**」⇒「别指望他们弃牌」。
 * 而**无画像对手正是低级别线上最常见的形态** ——
 * 若环境对这条路径完全不起作用，那这条规则在**最需要它的地方**是死的。
 *
 * ## 判据（写死）
 *
 * 同一个局面，只改环境（低级别线上 / 中低级别 / 理论参考）：
 * - 若三者的 `foldLikelihood` **逐位相同** ⇒ 环境对无画像对手的响应**完全无效**；
 * - 若不同 ⇒ 环境有效，我的怀疑不成立。
 *
 * ⚠️ 只读，不改任何生产文件。
 */
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { loadKnowledgeBase } from '../src/domain/knowledge/knowledgeLoader.ts';
import type { ManualHandInput } from '../src/app/manualInput/manualInput.ts';

const knowledge = loadKnowledgeBase();
if (!knowledge.ok) throw new Error('知识库加载失败');
const rules = knowledge.index.allRules();

/** 一个常见的翻牌局面：BTN 开池、BB 跟注、翻牌 BB 过牌 ⇒ BTN 下注决策 */
function spot(environment: string): ManualHandInput {
  return {
    tableSize: 6,
    heroPosition: 'BTN',
    heroCards: ['As', 'Jd'],
    board: ['Jc', '7s', '2h'],
    street: 'FLOP',
    effectiveStackBB: 100,
    actionHistory: [
      { position: 'UTG', type: 'FOLD', street: 'PREFLOP' },
      { position: 'HJ', type: 'FOLD', street: 'PREFLOP' },
      { position: 'CO', type: 'FOLD', street: 'PREFLOP' },
      { position: 'BTN', type: 'RAISE', amountBB: 2.5, street: 'PREFLOP' },
      { position: 'SB', type: 'FOLD', street: 'PREFLOP' },
      { position: 'BB', type: 'CALL', amountBB: 1.5, street: 'PREFLOP' },
      { position: 'BB', type: 'CHECK', street: 'FLOP' },
    ],
    environment,
    bigBlindBB: 100,
  } as unknown as ManualHandInput;
}

const ENVS = ['LOW_STAKES_ONLINE', 'MID_LOW_STAKES', 'THEORY_REFERENCE'];

console.log('同局面、只改环境 —— 看无画像对手的响应概率是否变化');
console.log('='.repeat(84));
console.log('环境                  动作/尺寸    P(弃)     P(跟)     P(加)     三尺寸是否互不相同');

const snapshots: number[][] = [];
for (const env of ENVS) {
  const r = analyzeManualHand(spot(env), { rules, writeLog: false, equitySeed: 1 });
  if (!r.ok) {
    console.log(`${env.padEnd(22)} 引擎失败：${r.issues.map((i) => i.code).join(',')}`);
    continue;
  }
  type SizeLike = { kind?: string; foldLikelihood?: number; callLikelihood?: number; raiseLikelihood?: number };
  const diag = r.decision.diagnostics as unknown as { betDecision?: { sizes?: readonly SizeLike[] } };
  const sizes = diag.betDecision?.sizes ?? [];
  if (sizes.length === 0) {
    console.log(`${env.padEnd(22)} 无下注决策模型（本局面未走到那一步）`);
    continue;
  }
  const triple = sizes.map((s) => [s.foldLikelihood ?? 0, s.callLikelihood ?? 0, s.raiseLikelihood ?? 0]).flat();
  snapshots.push(triple);
  const mid = sizes[Math.floor(sizes.length / 2)]!;
  const distinct = new Set(sizes.map((s) => `${s.foldLikelihood?.toFixed(6)}`)).size > 1;
  console.log(
    `${env.padEnd(22)} ${r.decision.action ?? '—'} ${(r.decision.sizeBB ?? 0).toFixed(2)}BB   ` +
      `${((mid.foldLikelihood ?? 0) * 100).toFixed(2)}%   ${((mid.callLikelihood ?? 0) * 100).toFixed(2)}%   ` +
      `${((mid.raiseLikelihood ?? 0) * 100).toFixed(2)}%   ${distinct ? '是' : '否'}`,
  );
}

console.log('');
console.log('='.repeat(84));
if (snapshots.length >= 2) {
  const first = snapshots[0]!;
  let allSame = true;
  for (const s of snapshots.slice(1)) {
    if (s.length !== first.length) {
      allSame = false;
      break;
    }
    for (let i = 0; i < s.length; i += 1) {
      if (Math.abs(s[i]! - first[i]!) > 1e-12) {
        allSame = false;
        break;
      }
    }
    if (!allSame) break;
  }
  console.log(
    allSame
      ? '❌ **三个环境的全部响应概率逐位相同** ⇒ 环境对无画像对手的响应**完全无效**'
      : '✅ 环境确实改变了响应概率 ⇒ 我的怀疑不成立',
  );
} else {
  console.log('样本不足，无法判定');
}
console.log('='.repeat(84));
console.log('若为「完全无效」：');
console.log('  ⇒ 知识库的 `env.low.calling-tendency-up`（低级别线上 ⇒ 更爱跟）');
console.log('     在**无画像对手**这条路径上是**死的**，而那正是该规则最该生效的场合。');
console.log('  ⇒ 与实测吻合：引擎预测弃牌 74.8% vs 实际 18.2%，且环境改变不了它。');
