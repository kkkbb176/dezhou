/**
 * Alpha 端到端演示（命令行）
 *
 * ## 用途
 *
 * 不需要打开网页就能验证整条链：**输入一手牌 → 打印完整建议与全部诊断**。
 * 它也是「端到端确实连通」的可复现证据（与 `test/alphaPipeline.test.ts` 互补：
 * 测试断言行为，本脚本展示真实输出）。
 *
 * ## 运行
 *
 * ```
 * node.exe --experimental-strip-types "scripts/alpha-demo.ts"
 * ```
 *
 * 默认场景：6 人桌，Hero 在关煞位持 AKo，翻牌 K 顶对，大盲过牌后轮到你。
 */

import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import type { ManualHandInput } from '../src/app/manualInput/manualInput.ts';
import { Position, Street } from '../src/domain/types.ts';

const SAMPLE: ManualHandInput = {
  tableSize: 6,
  heroPosition: Position.CO,
  heroCards: ['As', 'Kd'],
  board: ['Kh', '7c', '2d'],
  street: Street.FLOP,
  effectiveStackBB: 100,
  // 底池刻意不填 → 由引擎按行动记录重算
  actionHistory: [
    { position: Position.UTG, type: 'FOLD' },
    { position: Position.HJ, type: 'FOLD' },
    { position: Position.CO, type: 'RAISE', amountBB: 3 },
    { position: Position.BTN, type: 'FOLD' },
    { position: Position.SB, type: 'FOLD' },
    { position: Position.BB, type: 'CALL', amountBB: 2 },
    { position: Position.BB, type: 'CHECK', street: Street.FLOP },
  ],
  environment: 'MID_LOW_STAKES',
  villain: { quickProfile: 'NORMAL', dynamicHint: 'UNKNOWN' },
};

function main(): void {
  const index = loadKnowledgeBaseOrThrow();
  const rules = index.allRules();
  console.log(`知识库：${rules.length} 条规则（版本取自 source-registry）`);

  const result = analyzeManualHand(SAMPLE, { rules, asOf: 1_757_000_000_000, writeLog: false });

  if (!result.ok) {
    console.log(`\n[失败] 阶段 = ${result.stage}`);
    for (const issue of result.issues) console.log(`  [${issue.code}] ${issue.message}`);
    process.exitCode = 1;
    return;
  }

  const { decision, viewModel } = result;

  console.log('\n================ 输入 ================');
  console.log(`  6 人桌 · Hero ${SAMPLE.heroPosition} · 手牌 ${SAMPLE.heroCards.join(' ')}`);
  console.log(`  公共牌 ${SAMPLE.board.join(' ')} · 街道 ${SAMPLE.street} · 有效筹码 ${SAMPLE.effectiveStackBB}BB`);
  console.log(`  行动记录 ${SAMPLE.actionHistory.length} 条 · 环境 ${SAMPLE.environment}`);
  console.log(`  底池：引擎重算 = ${result.computedPot} 筹码（用户未声明）`);

  console.log('\n================ 建议 ================');
  console.log(`  ${viewModel.actionZh}`);
  if (viewModel.sizeZh !== undefined) console.log(`  尺寸：${viewModel.sizeZh}`);
  console.log(`  置信度：${viewModel.confidenceZh}`);
  console.log(`  类型：${viewModel.classificationZh}`);
  console.log('  核心原因：');
  for (const reason of viewModel.reasonsZh) console.log(`    · ${reason}`);
  if (viewModel.warningsZh.length > 0) {
    console.log('  警告：');
    for (const warning of viewModel.warningsZh) console.log(`    ! ${warning}`);
  }

  const debug = viewModel.debug;
  const section = (title: string, rows: readonly { label: string; value: string }[]): void => {
    console.log(`\n================ ${title} ================`);
    for (const row of rows) console.log(`  ${row.label}：${row.value}`);
  };

  section('数学（九项事实，只读）', debug.math);
  section('对手范围', debug.range);
  section('玩家画像', debug.player);
  section('牌局环境（仅方向）', debug.environment);
  section('动态行为', debug.dynamic);
  section('数学优势保护', debug.mathDominance);
  section('动态 Shadow 对比', debug.shadow);

  console.log('\n================ 候选动作 ================');
  console.log(`  合法动作：${debug.legalActionsZh.join(' / ')}`);
  for (const candidate of debug.candidates) {
    console.log(`  ${candidate.actionZh}  尺寸=${candidate.sizeZh}  EV=${candidate.evZh}  ${candidate.feasibleZh}`);
  }

  console.log('\n================ 追溯 ================');
  console.log(`  输入哈希：${result.log.inputHash}`);
  console.log(`  决策耗时：${JSON.stringify(result.timings)}`);
  for (const row of debug.versions) console.log(`  ${row.label}：${row.value}`);
  console.log(`  抽水口径：${debug.math.find((m) => m.label === '抽水模型')?.value ?? '—'}`);

  console.log('\n提示：网页版可运行 node.exe --experimental-strip-types "src/app/webServer.ts"');
  console.log(`（本次决策动作 = ${decision.action}，置信度 = ${decision.confidence.toFixed(3)}）`);
}

main();
