/*
 * 看一手的**完整决策理由**：引擎为什么在这里选 BET？
 *
 * 目的：区分「引擎在打价值/诈唬（可能合理）」与「模型缺陷」。
 * 只看结论不够 —— 要看它列出的原因、权益、底池赔率、对手范围假设。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parsePhh } from '../src/domain/realHands/phh.ts';
import { toValidatorSnapshotsDetailed } from '../src/domain/realHands/phhToEngineInput.ts';
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { loadKnowledgeBase } from '../src/domain/knowledge/knowledgeLoader.ts';

const file = process.argv[2] ?? join('third_party', 'phh-dataset', '100', '1.phh');
const wanted = process.argv[3]; // 可选：只打印某个位置（如 UTG）

const parsed = parsePhh(readFileSync(file, 'utf8'));
if (!parsed.ok) throw new Error(`解析失败 ${parsed.reason}`);
const knowledge = loadKnowledgeBase();
if (!knowledge.ok) throw new Error('知识库加载失败');
const rules = knowledge.index.allRules();

const { snapshots, skipped } = toValidatorSnapshotsDetailed(parsed.hand);
console.log(`文件 ${file}`);
console.log(`决策点 ${snapshots.length} 个，跳过 ${skipped.length} 个`);
for (const s of skipped) console.log(`  跳过: ${s.heroName} ${s.street} ${s.realAction} ← ${s.detail}`);

console.log(`\n玩家：${parsed.hand.players.join(' / ')}`);
console.log(`起手筹码：${parsed.hand.startingStacks.join(' / ')}\n`);

for (const snap of snapshots) {
  if (wanted !== undefined && snap.heroPosition !== wanted) continue;
  const r = analyzeManualHand(snap.input, { rules, writeLog: false, equitySeed: 1 });
  console.log('='.repeat(78));
  console.log(
    `${snap.street} | ${snap.heroPosition} | 我的手牌 ${snap.input.heroCards.join('')} | ` +
      `牌面 ${snap.input.board.join(' ')} | 面对 ${snap.toCallBB.toFixed(2)}BB`,
  );
  console.log(`对手底牌（**引擎看不到**，仅供我们判断）：${JSON.stringify(snap.opponentCards)}`);
  console.log(`真实动作：${snap.realAction}${snap.realRaiseToBB === undefined ? '' : ` 到 ${snap.realRaiseToBB.toFixed(2)}BB`}`);
  if (!r.ok) {
    console.log(`引擎失败：${r.stage} ${r.issues.map((i) => `${i.code}: ${i.message}`).join('；')}`);
    continue;
  }
  console.log(
    `引擎：${r.decision.action ?? '（无）'} ${r.decision.sizeBB === undefined ? '' : `${r.decision.sizeBB.toFixed(2)}BB`} ` +
      `| 置信 ${r.decision.confidence.toFixed(3)} ${r.decision.band} | 分类 ${r.decision.classification} | actionable=${r.decision.actionable}`,
  );
  console.log('理由：');
  for (const reason of r.decision.reasons) {
    console.log(`  · [${reason.code}] ${reason.textZh ?? reason.text ?? JSON.stringify(reason).slice(0, 160)}`);
  }
  const diag = r.decision.diagnostics as unknown as Record<string, unknown>;
  const interesting = ['equity', 'potOdds', 'requiredEquity', 'spr', 'myEquity', 'foldEquity', 'opponentRange', 'opponentCount'];
  console.log('诊断（节选）：');
  for (const k of interesting) {
    if (diag[k] !== undefined) console.log(`  ${k} = ${JSON.stringify(diag[k]).slice(0, 200)}`);
  }
  console.log(`底池（引擎重算）= ${r.computedPot} 筹码`);
}
