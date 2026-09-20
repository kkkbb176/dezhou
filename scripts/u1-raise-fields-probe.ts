/**
 * U1 证据脚本：**加注 EV 落地后，`candidates` / `unevaluatedActions` / 证据表各自说了什么**
 *
 * 目的（写在最前面，避免误读）：
 *
 * 1. V2-14 里有一条断言是「每个加注候选的 `ev` 必须保持 null」，它在 U1 之后
 *    **仍然通过** —— 本脚本用证据说明它**为什么**通过：`candidates[].ev` 与
 *    `actionEvidence[].ev` 是两个字段，加注候选的那个字段从来不带 EV。
 * 2. U1 落地时发现并修掉一处**披露自相矛盾**：动作靠 RAISE EV 选出（99 暗三条
 *    节点 RAISE 174 ⇐ MODEL_EV +140.01），同一份诊断却把 174 列进
 *    `unevaluatedActions` 的 `RAISE_EV_NOT_IMPLEMENTED`。本脚本输出修复后的
 *    口径（174 只出现在 `allInGuard.raiseSizesWithOwnEV` 里）。
 *
 * 只读。
 */
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import { akInput } from './rrda-lib.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const OPTIONS = {
  rules: RULES, asOf: 1_757_000_000_000, writeLog: false,
  equitySeed: 20_261_014, budget: { softMs: 120_000, hardMs: 240_000 },
} as const;

const line = (s = ''): void => console.log(s);
const show = (v: unknown): string => (v === null ? 'null' : v === undefined ? 'undefined' : String(v));

const corpus: { tag: string; input: ReturnType<typeof akInput> }[] = [
  { tag: 'AK 河牌（CS）', input: akInput(20, 'CALLING_STATION') },
  { tag: '99 河牌（暗三条，CS）', input: akInput(20, 'CALLING_STATION', ['9s', '9h']) },
  { tag: 'AJ 河牌（空气，MANIAC）', input: akInput(20, 'MANIAC', ['As', 'Js']) },
];

line('='.repeat(118));
line(' U1 证据：加注候选 / 未评估动作 / 动作证据表 三个字段各说什么');
line('='.repeat(118));

for (const { tag, input } of corpus) {
  const r = analyzeManualHand(input, OPTIONS);
  line('');
  line(`【${tag}】`);
  if (!r.ok) { line(`  ANALYZE FAIL ${JSON.stringify(r.issues)}`); continue; }
  const d = r.decision as unknown as Record<string, any>;
  const dg = d['diagnostics'] as Record<string, any>;
  line(`  最终动作 = ${show(d['action'])}${d['sizeChips'] === undefined || d['sizeChips'] === null ? '' : ` @ ${show(d['sizeChips'])}`}`);

  line('  candidates[]（候选动作表 —— 注意这里的 ev 字段）：');
  for (const c of (dg['candidates'] ?? []) as Record<string, any>[]) {
    line(`    ${String(c['action']).padEnd(8)} sizeChips=${String(c['sizeChips']).padEnd(6)} ` +
      `ev=${show(c['ev'])} kind=${show(c['estimateType'] ?? c['kind'])}`);
  }

  line('  actionEvidence[]（证据表 —— 真正参与裁决的 EV 在这里）：');
  for (const e of (dg['actionEvidence'] ?? []) as Record<string, any>[]) {
    line(`    ${String(e['action']).padEnd(8)} estimateType=${String(e['estimateType']).padEnd(30)} ` +
      `ev=${show(e['ev'])} commitsStack=${show(e['commitsStack'])}`);
  }

  line('  unevaluatedActions[]（未评估清单 —— 哪些加注金额确实没有 EV）：');
  for (const u of (dg['unevaluatedActions'] ?? []) as Record<string, any>[]) {
    line(`    ${String(u['action']).padEnd(8)} sizeChips=${show(u['sizeChips'])} reasonCode=${show(u['reasonCode'])}`);
  }

  const facts = (dg['postflop'] as Record<string, any> | undefined)?.['raiseResponse'] as Record<string, any> | null | undefined;
  if (facts === null || facts === undefined) {
    line('  加注响应事实：无');
  } else {
    line('  加注响应事实（诊断口径）：');
    line(`    sizeChips=${show(facts['sizeChips'])} raiseTo=${show(facts['raiseToAmount'])} increment=${show(facts['raiseIncrement'])}`);
    line(`    P(弃)=${show(facts['foldLikelihood'])} P(跟)=${show(facts['callLikelihood'])} P(再加注)=${show(facts['reRaiseLikelihood'])}`);
    line(`    EqVsRaiseCallRange=${show(facts['eqVsRaiseCallRange'])} RAISE EV=${show(facts['raiseEV'])} kind=${show(facts['evKind'])}`);
    line(`    模型=${show((facts['model'] as Record<string, any> | undefined)?.['kind'])} ` +
      `不读 Hero 底牌=${show((facts['model'] as Record<string, any> | undefined)?.['usesHeroHiddenCards'])}`);
  }
  line(`  allInGuard: ${JSON.stringify(dg['allInGuard'])}`);
  line(`  conditionalEquities: ${JSON.stringify(dg['conditionalEquities'])}`);
  /*
   * `decision.reasons` 被 `slice(0, 6)` 截断（`decisionEngine` 第 3440 行附近）——
   * 因此「部分金额未评估」这类事实理由**可能根本进不了首屏理由**。
   * 这里如实打印，供判断「披露是否真的到达用户」。
   */
  const reasons = (d['reasons'] ?? []) as Record<string, any>[];
  line(`  decision.reasons（截断到 6 条，实际 ${reasons.length} 条）：`);
  for (const x of reasons) line(`    [${String(x['code'])}] ${String(x['textZh']).slice(0, 90)}`);
}

line('');
line('='.repeat(118));
line(' 读法（逐条都由上面的输出支持，不是推断）：');
line(' · `candidates[].ev`：FOLD/CALL 有数值（0 / CALL EV），**加注候选恒为 null** ——');
line('   加注 EV 只挂在 `actionEvidence[].ev` 上（`estimateType = MODEL_EV`）。');
line('   因此 V2-14 的「加注候选不得有伪造 EV」成立的原因与 U1 无关：那个字段本来就不带加注 EV。');
line(' · `unevaluatedActions` 只列出**确实没有 EV 的**那些加注金额：U1 只给「决策层选中的那个尺寸」');
line('   算 EV（此处 174），其余金额（80/100/120/160）仍未建模，如实保留。');
line('   修复前 174 也被列进去（`RAISE_EV_NOT_IMPLEMENTED`），与它自己刚刚被用来做决策相矛盾；');
line('   现在由 `allInGuard.raiseSizesWithOwnEV` 与它同源，两边口径一致。');
line(' · `model.usesHeroHiddenCards` 的字段名是「是否读 Hero 隐藏底牌」，恒为 false。');
line('='.repeat(118));
