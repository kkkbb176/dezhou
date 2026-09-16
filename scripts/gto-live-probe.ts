/**
 * 真实 GTOpen 联调探针（阶段一验证脚本）
 *
 * ## 它做什么
 *
 * 逐个桌人数跑**真实场景**，把结果
 * **同时**打印到控制台并**追加写入** `reports/evidence/gto-live-evidence.txt`。
 *
 * 为什么要落盘：这一轮的验证要**可复现、可引用**。
 * 一份只在终端里滚过的输出，无法被报告引用，也无法在会话中断后追回。
 *
 * 用法：
 *   node --experimental-strip-types scripts/gto-live-probe.ts [tableSize...]
 *
 * 前提：GTOpen 已在 3737 端口运行（见 `GTOopen/start-gtopen.ps1`）。
 */

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { buildGtoScenario, scenarioHashOf, describeScenarioZh } from '../src/domain/gto/gtoScenario.ts';
import { GtoScenarioKind, gtoPositionsFor, type GtoTableSize } from '../src/domain/gto/gto.types.ts';
import {
  GTOPEN_DEFAULT_BUDGET,
  GTOPEN_SIZE_PROFILES,
  GtopenProvider,
} from '../src/domain/gto/providers/gtopenProvider.ts';
import { actionHistoryFor, GtoScenarioTemplate } from '../src/app/gto/gtoScenarioCatalog.ts';
import { formatFrequencyPercent } from '../src/domain/gto/gtopenHandMatrix.ts';

/** 仅用于打印（真实取值由 Provider 内部按桌人数决定） */
const GTOPEN_ITERATION_HINT = GTOPEN_SIZE_PROFILES;

/* ============================================================
 * 输出通道：控制台 + 落盘（同一份内容，逐行同步）
 * ============================================================ */

const EVIDENCE_DIR = fileURLToPath(new URL('../reports/evidence/', import.meta.url));
const EVIDENCE_FILE = `${EVIDENCE_DIR}gto-live-evidence.txt`;
mkdirSync(EVIDENCE_DIR, { recursive: true });

/** 本次运行的输出（最后会整体写盘，防止中途中断丢失） */
const lines: string[] = [];

function emit(line: string): void {
  console.log(line);
  lines.push(line);
  // 每次都重写：即使进程被杀，已产生的部分也在盘上
  try {
    writeFileSync(EVIDENCE_FILE, `${lines.join('\n')}\n`, 'utf8');
  } catch {
    /* 写盘失败不影响探针本身 */
  }
}

function emitRaw(text: string): void {
  console.log(text);
  lines.push('');
  try {
    appendFileSync(EVIDENCE_FILE, text, 'utf8');
  } catch {
    /* 同上 */
  }
}

/* ============================================================
 * 目标桌人数
 * ============================================================ */

const sizes: GtoTableSize[] = (process.argv.slice(2).map(Number) as GtoTableSize[]).filter(
  (n) => [4, 5, 6, 8, 9].includes(n),
);
const targets: GtoTableSize[] = sizes.length > 0 ? sizes : [4, 5, 6, 8, 9];

const provider = new GtopenProvider({
  budget: {
    ...GTOPEN_DEFAULT_BUDGET,
    // 探针不覆盖迭代数：用 Provider **按桌人数标定**的那套值，
    // 这样「探针跑的就是生产跑的那套预算」。只放宽等待上限。
    solveWaitMs: Number(process.env.GTO_WAIT_MS ?? 900_000),
  },
});

emit('================================================================');
emit('GTOpen 真实联调证据（阶段一：多桌人数翻前）');
emit(`生成时间（本地）: ${new Date().toISOString()}`);
emit(`GTOpen 端点      : ${provider.baseUrl}`);
emit(`求解预算         : 开池 ${provider.budget.openSizesBB.join('/')}BB · 再加注 ${provider.budget.raiseMults.join('/')}× · 加注上限 ${provider.budget.maxRaises} · 跛入 ${provider.budget.limp ? '允许' : '关闭'}`);
emit('全下 / 迭代数（按桌人数，实测标定）：');
for (const [size, profile] of Object.entries(GTOPEN_SIZE_PROFILES)) {
  emit(`  ${size} 人桌：全下 ${profile.addAllin ? '提供' : '不提供'} · 迭代 ${profile.iterations} 次`);
}
emit('================================================================');
emit('');

const health = await provider.health();
emit(`健康检查: reachable=${health.reachable} endpoint=${health.endpoint}`);
emit(`          ${health.message}`);
if (!health.reachable) {
  emit('求解器不可达 —— 探针无法继续。Alpha 侧的降级行为由 gtoWebUi.test.ts 的 GTO-UI-09 覆盖。');
  process.exit(0);
}
emit('');

const SHOW_HANDS = ['AA', 'AKs', 'AKo', 'A5s', 'A5o', 'KQs', '22', '72o'];

/* ============================================================
 * 逐桌人数采集
 * ============================================================ */

for (const size of targets) {
  const order = gtoPositionsFor(size);
  const hero = order[0]!;
  const history = actionHistoryFor(size, hero, GtoScenarioTemplate.FIRST_IN)!;
  const scenario = buildGtoScenario({
    kind: GtoScenarioKind.RFI,
    tableSize: size,
    effectiveStackBB: 100,
    heroPosition: hero,
    actionHistory: history,
    openSizeBB: 2.5,
  });
  if (scenario === null) {
    emit(`[${size}MAX] 场景构造失败 —— 跳过`);
    continue;
  }
  emit(`=== ${describeScenarioZh(scenario)}`);
  emit(`    场景哈希: ${scenarioHashOf(scenario)}`);
  const t0 = Date.now();
  const result = await provider.lookupScenario(scenario);
  const elapsed = Date.now() - t0;

  if ('status' in result) {
    emit(`    ❌ 不可用（${result.cause}）: ${result.message}`);
    emit('');
    continue;
  }

  const meta = result.metadata;
  emit(
    `    ✅ 成功，耗时 ${elapsed} ms（${(elapsed / 1000).toFixed(1)} 秒）；` +
      `迭代 ${meta.solveSettings.iterationsCompleted} / 请求 ${meta.solveSettings.iterationsRequested}；` +
      `BR gap 之和 ${meta.solveSettings.reportedGap?.toFixed(8) ?? '（未测）'}；` +
      `模型 ${meta.solveSettings.modelName}`,
  );
  emit(
    `    求解状态 ${meta.solveStatus} / 可信度 ${meta.verification} / 未收敛=${meta.approximation.notConverged}`,
  );
  emit(
    `    动作菜单: ${result.range.actionMenu
      .map((a) => `${a.rawLabel}${a.sizeBB === null ? '' : `(=to ${a.sizeBB}BB)`}`)
      .join(' | ')}`,
  );
  emit(`    节点底池: ${result.range.potBB} BB`);
  for (const code of SHOW_HANDS) {
    const hand = result.range.hands.find((h) => h.hand === code);
    if (hand === undefined) continue;
    const freq = hand.actions
      .map(
        (a) =>
          `${a.kind}${a.sizeBB === null ? '' : `@${a.sizeBB}BB`}=${formatFrequencyPercent(a.frequency)}`,
      )
      .join('  ');
    emit(`      ${code.padEnd(4)} reach=${hand.reach === null ? '—' : hand.reach.toFixed(3)}  ${freq}`);
  }
  // 混合策略计数：这一档里有多少手牌是真正的混合（≥2 个动作）
  const mixed = result.range.hands.filter((h) => h.actions.length >= 2).length;
  const pureFold = result.range.hands.filter(
    (h) => h.actions.length === 1 && h.actions[0]!.kind === 'FOLD',
  ).length;
  const pureRaise = result.range.hands.filter(
    (h) => h.actions.length === 1 && h.actions[0]!.kind === 'RAISE',
  ).length;
  emit(
    `    169 类构成: 混合 ${mixed} · 纯弃牌 ${pureFold} · 纯加注 ${pureRaise} · 其它 ${169 - mixed - pureFold - pureRaise}`,
  );
  emit('');
}

emit('================================================================');
emit('探针结束');
emit(`证据文件: ${EVIDENCE_FILE}`);
