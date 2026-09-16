/**
 * 项目状态一致性测试 —— 防止「文档说待办、代码已完成」的状态漂移
 *
 * ## 为什么需要它
 *
 * 本次审计发现真实的漂移：
 * `reports/V2_ARCHITECTURE.md` §17 的状态表里，
 * Range Engine 与 Player Profile 都还写着「待办」，
 * 而它们**早已完成并通过独立红队**。
 *
 * 根因：架构文档在 Phase 1–3 期间写成，之后每个 Step 只更新
 * `STEP_REPORTS.md` / `TEST_MATRIX.md`，没人回头更新状态列。
 *
 * ## 本文件的做法
 *
 * 把「某模块是否已实现」变成**可执行断言**：
 * - 代码存在 → 状态文档必须标「已实现」
 * - 代码不存在 → 状态文档**不得**标「已实现」
 *
 * 两个方向都查。只查一个方向会漏掉「文档超前于代码」的情况。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { ALL_GAME_ENVIRONMENTS } from '../src/domain/range/gameEnvironment.ts';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const STATUS_PATH = `${ROOT}CURRENT_PROJECT_STATUS.md`;

/**
 * 读取状态文档，并把表格行「| ① | Poker Core | …」规范化成「| ① Poker Core | …」。
 *
 * 为什么要规范化：Markdown 表格里「序号」与「层名」是两个独立单元格，
 * 而测试用 `| ① Poker Core |` 定位。两种写法都是合法的 Markdown，
 * 规范化后测试不依赖于任一种排版选择。
 */
function readStatusNormalized(): string {
  return readStatus().replace(/\|\s*([①-⑫])\s*\|\s*([^|]+?)\s*\|/g, '| $1 $2 |');
}

function readStatus(): string {
  assert.ok(existsSync(STATUS_PATH), 'CURRENT_PROJECT_STATUS.md 必须存在（它是状态的单一事实来源）');
  return readFileSync(STATUS_PATH, 'utf8');
}

/* ============================================================
 * 一、十二层状态必须与代码一致
 * ============================================================ */

/** 每层的「已实现证据文件」—— 任一存在即视为已实现 */
const LAYER_EVIDENCE: ReadonlyArray<{ layer: string; files: readonly string[] }> = [
  {
    layer: '① Poker Core',
    files: ['src/domain/poker/cards.ts', 'src/domain/poker/handEval.ts', 'src/domain/poker/fastEval.ts'],
  },
  {
    layer: '② 状态检查器',
    files: ['src/domain/poker/validator.ts', 'src/domain/poker/gameState.ts', 'src/domain/poker/engine.ts'],
  },
  {
    layer: '③ 数学引擎',
    files: ['src/domain/poker/odds.ts', 'src/domain/poker/equity.ts', 'src/domain/poker/equityExact.ts'],
  },
  {
    layer: '④ 范围引擎',
    files: ['src/domain/range/range.ts', 'src/domain/range/rangeUpdate.ts', 'src/domain/range/rangeLogSpace.ts'],
  },
  {
    layer: '⑤ 玩家模型',
    files: ['src/domain/player/playerProfile.ts', 'src/domain/player/playerClassifier.ts'],
  },
  {
    layer: '⑥ 动态行为引擎',
    files: [
      'src/domain/dynamic/dynamic.types.ts',
      'src/domain/dynamic/dynamicStats.ts',
      'src/domain/dynamic/dynamicDeviation.ts',
      'src/domain/dynamic/dynamicBehavior.ts',
      'src/domain/dynamic/dynamicAdapter.ts',
    ],
  },
  {
    layer: '⑦ Exploit 引擎',
    // Alpha 阶段：环境 / 画像 / 动态的**方向**通过 `contextBuilder` 汇总进 Decision，
    // 刻意**没有**独立大模块（规范第 43 节：「不要建立新大模块」）。
    // 因此该层的可执行证据是环境方向接入层。
    files: ['src/domain/environment/environmentAccess.ts'],
  },
  {
    layer: '⑧ 决策引擎',
    files: [
      'src/domain/decision/decision.types.ts',
      'src/app/decision/decisionEngine.ts',
      'src/app/alphaPipeline.ts',
    ],
  },
  {
    layer: '⑨ 多智能体对抗审查',
    files: ['src/agents/'],
  },
  {
    layer: '⑩ 复盘引擎',
    files: ['src/app/replay.ts', 'src/app/replayEngine.ts'],
  },
  {
    layer: '⑪ 漏洞引擎',
    files: ['src/app/leak.ts', 'src/app/leakEngine.ts'],
  },
  {
    layer: '⑫ 中文 UI',
    // 词条层 + **Alpha 最小界面**都已实现 → ✅。
    // 三个证据文件都存在才算完全实现（词条出口 / 交互页面 / ViewModel 映射）。
    files: [
      'src/i18n/index.ts',
      'src/app/web/index.html',
      'src/viewmodels/decisionViewModel.ts',
    ],
  },
];

test('**防漂移**：每一层的「已实现 / 未实现」必须与代码事实一致', () => {
  const status = readStatusNormalized();
  const mismatches: string[] = [];

  for (const { layer, files } of LAYER_EVIDENCE) {
    const present = files.filter((f) => existsSync(`${ROOT}${f}`));
    const implemented = present.length > 0;
    const fullyImplemented = present.length === files.length;

    // 在状态文档中定位该层所在的行（规范化后为 `| ① Poker Core | … |`）
    const line = status.split('\n').find((l) => l.includes(`| ${layer} |`));
    assert.ok(line !== undefined, `状态文档必须列出「${layer}」`);

    const claimsImplemented = line.includes('✅');
    const claimsNotImplemented = line.includes('⬜');
    const claimsPartial = line.includes('🟡');

    if (!implemented) {
      if (!claimsNotImplemented) {
        mismatches.push(`${layer}：代码不存在（证据文件 ${files.join(' / ')} 都不存在），但状态文档未标 ⬜`);
      }
      continue;
    }
    // 已实现：要么 ✅（全部证据文件存在），要么 🟡（部分）
    if (!claimsImplemented && !claimsPartial) {
      mismatches.push(
        `${layer}：代码已实现（${present.join(' / ')} 存在），但状态文档既未标 ✅ 也未标 🟡 —— 这是状态漂移`,
      );
    }
    if (claimsImplemented && !fullyImplemented) {
      mismatches.push(
        `${layer}：状态文档标 ✅（完全实现），但只找到部分证据文件（${present.join(' / ')} / 缺 ${files
          .filter((f) => !present.includes(f))
          .join(' / ')}）—— 应标 🟡`,
      );
    }
    if (claimsPartial && fullyImplemented) {
      mismatches.push(`${layer}：状态文档标 🟡（部分），但全部证据文件都已存在 —— 应升级为 ✅`);
    }
  }

  assert.deepEqual(mismatches, [], `状态漂移：\n${mismatches.map((m) => `  ${m}`).join('\n')}`);
});

test('**防漂移**：状态文档声称「未实现」的模块，代码必须真的不存在', () => {
  const status = readStatusNormalized();
  for (const { layer, files } of LAYER_EVIDENCE) {
    const line = status.split('\n').find((l) => l.includes(`| ${layer} |`));
    if (!line || !line.includes('⬜ **未实现**')) continue;
    for (const file of files) {
      assert.equal(
        existsSync(`${ROOT}${file}`),
        false,
        `状态文档说「${layer}」未实现，但 ${file} 已存在 —— 必须更新状态文档`,
      );
    }
  }
});

/* ============================================================
 * 二、产品定位必须被锁死
 * ============================================================ */

test('产品定位必须写明「仅供内部个人使用」与 1–3 秒目标', () => {
  const status = readStatus();
  assert.ok(status.includes('仅供内部个人使用'), '必须写明内部个人使用');
  assert.ok(status.includes('1～3 秒'), '必须写明 1～3 秒目标');
  assert.ok(status.includes('低级别线上'), '必须写明主场景');
  assert.ok(status.includes('中低级别线上'), '必须写明次场景');

  // 必须明确排除不属于本项目的定位
  for (const notThis of ['商业产品', '完整扑克平台', '研究项目']) {
    assert.ok(status.includes(notThis), `必须明确排除「${notThis}」定位`);
  }
});

test('必须写明「唯一重要的问题」判据', () => {
  const status = readStatus();
  assert.ok(
    status.includes('这个功能是否直接提升「现在这手怎么打」的质量'),
    '必须写明任务筛选判据 —— 否则「延后」缺少依据',
  );
});

/* ============================================================
 * 三、热路径必须被锁定
 * ============================================================ */

test('热路径必须被完整列出，且顺序与规范一致', () => {
  const status = readStatus();

  // 只在热路径代码块内检查顺序 —— 文档其它地方也会提到这些词
  // （例如产品进度表里就有「Action + Size + Confidence」），
  // 全文搜索会误判顺序。
  // 代码块不要求语言标记（``` 与 ```text 都接受）。
  const block = /```[a-z]*\r?\n\s*(Manual Input[\s\S]*?)```/.exec(status);
  assert.ok(block, '必须有一个以 Manual Input 开头的热路径代码块');
  const body = block![1]!;

  const order = [
    'Manual Input',
    'Validator',
    'Poker Math',
    'Range',
    'Player Profile',
    'Game Environment',
    'Dynamic Behavior',
    'Exploit Adjustment',
    'Decision Engine',
    'Action + Size + Confidence',
  ];
  let previousIndex = -1;
  for (const step of order) {
    const index = body.indexOf(step);
    assert.ok(index >= 0, `热路径必须包含「${step}」`);
    assert.ok(index > previousIndex, `热路径顺序错误：「${step}」出现在了更早的位置`);
    previousIndex = index;
  }
});

/* ============================================================
 * 四、数学层绝对优先级必须被声明
 * ============================================================ */

test('九项数学量必须被显式列为「不得被修改」', () => {
  const status = readStatus();
  for (const quantity of [
    'Pot',
    'Stack',
    'Effective Stack',
    'Hand Rank',
    'SPR',
    'Pot Odds',
    'Required Equity',
    'Equity 算法',
    'EV 算法',
  ]) {
    assert.ok(status.includes(quantity), `必须显式列出「${quantity}」为不可修改`);
  }
});

test('六个可修改的概率维度必须被显式列出，且明确「不能输出 Action」', () => {
  const status = readStatus();
  for (const dimension of [
    'Range Weight',
    'Action Likelihood',
    'Bluff Weight',
    'Value Weight',
    'Range Width',
    'Strategy Preference',
  ]) {
    assert.ok(status.includes(dimension), `必须显式列出可修改维度「${dimension}」`);
  }
  assert.ok(
    status.includes('不能**直接输出最终 Action') || status.includes('不能直接输出最终 Action'),
    '必须明确「不能直接输出最终 Action」',
  );
});

/* ============================================================
 * 五、三种环境的纪律
 * ============================================================ */

test('三种环境必须全部登记在状态文档中', () => {
  const status = readStatus();
  for (const environment of ALL_GAME_ENVIRONMENTS) {
    assert.ok(status.includes(environment), `状态文档必须登记环境 ${environment}`);
  }
});

test('环境必须被标为「仅方向」，且遗留数值必须标为 deprecated', () => {
  const status = readStatus();
  assert.ok(status.includes('仅方向'), '环境的能力必须标为「仅方向」');
  assert.ok(
    status.includes('deprecated / legacy-only'),
    '遗留数值参数必须被标为 deprecated / legacy-only',
  );
  assert.ok(
    status.includes('禁止新的生产 Decision 路径依赖'),
    '必须明确禁止新的生产路径依赖遗留数值',
  );
});

/* ============================================================
 * 六、降级与禁止项
 * ============================================================ */

test('已降级的模块必须被明确标注（防止横向扩张）', () => {
  const status = readStatus();
  for (const item of ['多智能体', 'Replay', 'Leak']) {
    assert.ok(status.includes(item), `状态文档必须提到「${item}」的处置`);
  }
  assert.ok(status.includes('降级'), '必须写明降级');
});

test('禁止新增清单必须存在', () => {
  const status = readStatus();
  for (const forbidden of ['云同步', '账户系统', '排行榜', '社交功能', '高级 Dashboard']) {
    assert.ok(status.includes(forbidden), `禁止新增清单必须包含「${forbidden}」`);
  }
});

test('Phase 4.5 必须标为已 PASS 且停止扩展', () => {
  const status = readStatus();
  assert.ok(status.includes('Phase 4.5'), '必须提到 Phase 4.5');
  assert.ok(status.includes('PASS'), 'Phase 4.5 必须标为 PASS');
  assert.ok(status.includes('停止扩展'), '必须写明 Phase 4.5 停止扩展');
});

test('Step 5B 必须标为 BLOCKED / NOT REQUIRED', () => {
  const status = readStatus();
  assert.ok(
    status.includes('BLOCKED / NOT REQUIRED FOR CURRENT DEVELOPMENT'),
    'Step 5B 的状态必须精确标为 BLOCKED / NOT REQUIRED FOR CURRENT DEVELOPMENT',
  );
});

/* ============================================================
 * 七、产品进度必须与「测试数」分开
 * ============================================================ */

test('必须明确声明「测试数量不是产品进度」', () => {
  const status = readStatus();
  assert.ok(
    status.includes('测试数量不是产品进度'),
    '必须明确切开测试进度与产品进度 —— 921 项测试不代表软件完成 92%',
  );
});

test('产品进度必须覆盖八个维度（街道 × 人数 × 环境）', () => {
  const status = readStatus();
  for (const dimension of [
    'Preflop',
    'Flop',
    'Turn',
    'River',
    'HU（单挑）',
    'Multiway',
    'LOW_STAKES_ONLINE',
    'MID_LOW_STAKES',
  ]) {
    assert.ok(status.includes(dimension), `产品进度表必须覆盖「${dimension}」`);
  }
});

/**
 * 产品能力的声明必须与**代码事实**一致。
 *
 * ## ⚠️ 这条断言被改写过（诚实记录）
 *
 * 它原本断言「必须标注端到端为 0%」—— 那时决策引擎确实不存在，
 * 而那条断言的作用是**防止在能力为零时含糊其辞**。
 *
 * Alpha 阶段落地后，端到端**真的可以用了**，因此继续断言「必须写 0%」
 * 会变成「要求文档撒谎」。改成**双向一致**：
 *
 * - 决策引擎存在 → 文档必须声明「可端到端使用」，且**不得**再说 0%
 * - 决策引擎不存在 → 文档必须声明「0%」（原意图）
 *
 * 这样这条断言在**两种状态下都有效**，而不是把某一时刻的事实钉死。
 */
test('产品能力声明必须与决策引擎的存在性一致（不得含糊）', () => {
  const full = readStatus();

  // ⚠️ 只检查**当前状态声明**区，不检查历史与漂移记录区。
  //
  // 为什么：§12「状态漂移的修正记录」会**引用**被修正掉的旧表述
  //（例如「修正前：产品能力 = 0% 可端到端使用」）——
  // 那是**历史**，必须保留；直接全文搜会把历史记录误判成当前声明。
  const currentSections = full
    .split(/^## /m)
    .filter((section) => section.startsWith('1. 一句话状态') || section.startsWith('5. 产品决策能力'))
    .join('\n');
  assert.ok(currentSections.length > 0, '必须能找到「当前状态声明」区（§1 与 §5）');

  const engineExists =
    existsSync(`${ROOT}src/app/decision/decisionEngine.ts`) &&
    existsSync(`${ROOT}src/app/alphaPipeline.ts`);

  if (engineExists) {
    assert.ok(
      currentSections.includes('可端到端使用'),
      '决策引擎已存在 → 当前状态声明必须写明端到端「可端到端使用」',
    );
    assert.ok(
      !currentSections.includes('产品能力 = 0% 可端到端使用'),
      '决策引擎已存在 → 当前状态声明**不得**再声称端到端能力为 0%',
    );
    assert.ok(
      currentSections.includes('真实牌局'),
      '声明「可用」的同时必须说明尚未用真实牌局验证（否则「可用」会变成夸大）',
    );
  } else {
    assert.ok(
      currentSections.includes('产品能力 = 0% 可端到端使用'),
      '决策引擎不存在 → 必须诚实标注端到端能力为 0%',
    );
  }
});

/* ============================================================
 * 八、下一路线必须被锁死
 * ============================================================ */

test('下一路线必须按锁定顺序列出', () => {
  const status = readStatus();
  const route = [
    'Step 7 Dynamic Behavior',
    'Step 7 独立红队',
    'Environment 最小接入',
    'Alpha Decision Engine',
    'Golden Smoke Spots', // 或 Decision Golden Spots —— 见下方说明
    'Internal Alpha',
  ];
  let previousIndex = -1;
  for (const step of route) {
    // ⚠️ 措辞可能随阶段微调（例如「Decision Golden Spots」→「Golden Smoke Spots」），
    // 因此这里检查**关键要素**而不是锁死整句话。
    assert.ok(status.includes(step), `下一路线必须包含「${step}」`);
    const index = status.indexOf(step);
    assert.ok(index > previousIndex, `下一路线顺序错误：「${step}」位置不对`);
    previousIndex = index;
  }
  // 这两项是路线的**终点环节**，必须存在
  for (const tail of ['真实牌局', '最小中文 UI']) {
    assert.ok(status.includes(tail), `下一路线必须包含「${tail}」`);
  }
  assert.ok(
    status.includes('禁止在') && status.includes('插入新的大 Phase'),
    '必须明确禁止插入新的大 Phase',
  );
});

/* ============================================================
 * 九、冗余保护：状态文档不得声称不存在的测试数
 * ============================================================ */

test('状态文档声称的测试文件数必须与实际一致', async () => {
  const { readdirSync } = await import('node:fs');
  const actual = readdirSync(`${ROOT}test`).filter((f) => f.endsWith('.test.ts')).length;
  const status = readStatus();

  // 文档里写「N 项 / N 套件 / N 个测试文件」
  //
  // 数字**允许千位分隔符**（`1,017` 与 `1017` 都接受）：
  // 项目跨过 1000 项测试后，报告可读性要求保留分隔符，
  // 而写测试时不该被迫为了迁就正则而写成更难读的形式。
  const NUM = String.raw`\d[\d,]*`;
  const match = new RegExp(String.raw`\*\*(${NUM}) 项 \/ ${NUM} 套件 \/ (${NUM}) 个测试文件\*\*`).exec(
    status,
  );
  assert.ok(match, '状态文档必须给出「N 项 / N 套件 / N 个测试文件」');
  assert.equal(
    Number(match![2]!.replace(/,/g, '')),
    actual,
    `状态文档说 ${match![2]} 个测试文件，实际 ${actual} 个 —— 必须同步更新`,
  );
});
