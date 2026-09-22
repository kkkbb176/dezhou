/**
 * GTO 场景 / 目录 / 契约边界测试
 *
 * ## 三组测试各自防什么
 *
 * 1. **桌人数隔离**：4MAX 的 CO 与 6MAX 的 CO 是两个世界。
 *    这条如果失守，界面上一切正常，只是数据是别人的。
 *
 * 2. **契约边界（静态扫描）**：只有 `GTOpenProvider` 可以碰 GTOpen。
 *    如果 `decisionEngine` / `contextBuilder` / 前端直接发 HTTP，
 *    「换一个求解器」就会变成一场全项目手术。
 *    这里用**源码扫描**把它锁死 —— 注释里写「请不要」是没有用的。
 *
 * 3. **前端资源**：13×13 矩阵与百分比格式化的约定必须与后端一致。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';

import {
  GTO_TABLE_SIZES,
  GtoScenarioKind,
  gtoPositionsFor,
  isGtoTableSize,
} from '../src/domain/gto/gto.types.ts';
import {
  buildGtoScenario,
  canHeroFaceThreeBet,
  describeScenarioZh,
  legalThreeBettorsFor,
  scenariosEquivalent,
  scenarioHashOf,
  selfCheckScenarioLayer,
} from '../src/domain/gto/gtoScenario.ts';
import {
  GTO_TEMPLATE_ZH,
  GtoScenarioTemplate,
  actionHistoryFor,
  catalogEntryLabelZh,
  catalogForTableSize,
  fullCatalog,
  selfCheckCatalog,
  supportedCatalog,
} from '../src/app/gto/gtoScenarioCatalog.ts';
import {
  GTO_POSITION_ZH,
  catalogScenarioOf,
  gtoCatalog,
  selfCheckGtoLayer,
} from '../src/app/gto/gtoApi.ts';
import {
  GTOPEN_CAPABILITY_TABLE,
  GTOPEN_PREFLOP_MAX_VERIFICATION,
  supportLevelFor,
} from '../src/domain/gto/providers/gtopenCapabilities.ts';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/* ============================================================
 * 一、场景哈希隔离
 * ============================================================ */

test('GTO-SCN-01：桌人数是哈希的一级参数 —— 同名位置在每个桌人数下都不同', () => {
  for (const position of ['CO', 'BTN', 'SB', 'BB'] as const) {
    const hashes = new Map<string, number>();
    for (const size of GTO_TABLE_SIZES) {
      const order = gtoPositionsFor(size);
      const heroIndex = order.indexOf(position);
      if (heroIndex < 0) continue;

      /*
       * 对每个「桌型 + 位置」选一个**能表达**的模板。
       *
       * ⚠️ 用多模板尝试而不是写死一个：不同桌型下同一个位置的角色不同
       * （4 人桌的 CO 是第一个行动位，6 人桌的 CO 前面有两家），
       * 而我们要测的是「桌人数是否进入哈希」，不是「某个模板是否支持」。
       */
      let scenario = null;
      for (const template of [
        GtoScenarioTemplate.FIRST_IN,
        GtoScenarioTemplate.FOLD_TO_HERO,
        GtoScenarioTemplate.VS_FIRST_OPEN_THEN_FOLDS,
      ]) {
        const history = actionHistoryFor(size, position, template);
        if (history === null) continue;
        scenario = buildGtoScenario({
          kind:
            template === GtoScenarioTemplate.VS_FIRST_OPEN_THEN_FOLDS
              ? GtoScenarioKind.VS_OPEN
              : GtoScenarioKind.RFI,
          tableSize: size,
          effectiveStackBB: 100,
          heroPosition: position,
          actionHistory: history,
        });
        if (scenario !== null) break;
      }
      assert.ok(scenario !== null, `${size}MAX ${position} 至少要有一个可表达的场景`);

      const hash = scenarioHashOf(scenario);
      assert.ok(
        !hashes.has(hash),
        `哈希冲突：${size}MAX ${position} 与 ${hashes.get(hash)}MAX ${position} 相同（${hash}）`,
      );
      hashes.set(hash, size);
    }
    assert.ok(hashes.size >= 3, `${position} 至少应在 3 个桌型上存在`);
  }
});

test('GTO-SCN-02：4MAX ≠ 5MAX ≠ 6MAX ≠ 8MAX ≠ 9MAX（第一个行动位的 RFI 逐一验证）', () => {
  const hashes = GTO_TABLE_SIZES.map((size) =>
    scenarioHashOf(
      buildGtoScenario({
        kind: GtoScenarioKind.RFI,
        tableSize: size,
        effectiveStackBB: 100,
        heroPosition: gtoPositionsFor(size)[0]!,
        actionHistory: [],
      })!,
    ),
  );
  assert.equal(new Set(hashes).size, 5, `5 个桌人数必须得到 5 个不同哈希：${hashes.join(',')}`);
});

test('GTO-SCN-03：筹码 / 尺寸 / 盲注 / 前序动作 / 场景类型 都必须改变哈希', () => {
  const base = buildGtoScenario({
    kind: GtoScenarioKind.RFI,
    tableSize: 6,
    effectiveStackBB: 100,
    heroPosition: 'UTG',
    actionHistory: [],
  })!;
  const baseHash = scenarioHashOf(base);

  const shorter = buildGtoScenario({
    kind: GtoScenarioKind.RFI,
    tableSize: 6,
    effectiveStackBB: 40,
    heroPosition: 'UTG',
    actionHistory: [],
  })!;
  assert.notEqual(scenarioHashOf(shorter), baseHash, '有效筹码必须影响哈希');

  const withAnte = buildGtoScenario({
    kind: GtoScenarioKind.RFI,
    tableSize: 6,
    effectiveStackBB: 100,
    heroPosition: 'UTG',
    actionHistory: [],
    blinds: { sbBB: 0.5, bbBB: 1, anteBB: 0.1 },
  })!;
  assert.notEqual(scenarioHashOf(withAnte), baseHash, '盲注结构（含 ante）必须影响哈希');

  const vsOpen = buildGtoScenario({
    kind: GtoScenarioKind.VS_OPEN,
    tableSize: 6,
    effectiveStackBB: 100,
    heroPosition: 'HJ',
    actionHistory: [{ position: 'UTG', kind: 'RAISE', sizeBB: 2.5 }],
  })!;
  const vsOpenBigger = buildGtoScenario({
    kind: GtoScenarioKind.VS_OPEN,
    tableSize: 6,
    effectiveStackBB: 100,
    heroPosition: 'HJ',
    actionHistory: [{ position: 'UTG', kind: 'RAISE', sizeBB: 3.0 }],
  })!;
  assert.notEqual(scenarioHashOf(vsOpenBigger), scenarioHashOf(vsOpen), '开池尺寸必须影响哈希');

  // Hero / Villain 反转：同一个位置不能既当 Hero 又当 Villain
  const heroIsCo = buildGtoScenario({
    kind: GtoScenarioKind.VS_OPEN,
    tableSize: 6,
    effectiveStackBB: 100,
    heroPosition: 'CO',
    villainPosition: 'UTG',
    actionHistory: [{ position: 'UTG', kind: 'RAISE', sizeBB: 2.5 }],
  })!;
  const heroIsUtg = buildGtoScenario({
    kind: GtoScenarioKind.VS_OPEN,
    tableSize: 6,
    effectiveStackBB: 100,
    heroPosition: 'UTG',
    villainPosition: 'CO',
    actionHistory: [{ position: 'UTG', kind: 'RAISE', sizeBB: 2.5 }],
  });
  assert.equal(heroIsUtg, null, 'Hero 不能是已经行动过的人');
  assert.notEqual(scenarioHashOf(heroIsCo), baseHash);
});

test('GTO-SCN-04：归一化消除浮点书写差异（2.5 与 2.5000000000000004 必须同哈希）', () => {
  const a = buildGtoScenario({
    kind: GtoScenarioKind.VS_OPEN,
    tableSize: 6,
    effectiveStackBB: 100,
    heroPosition: 'HJ',
    actionHistory: [{ position: 'UTG', kind: 'RAISE', sizeBB: 2.5 }],
  })!;
  const b = buildGtoScenario({
    kind: GtoScenarioKind.VS_OPEN,
    tableSize: 6,
    effectiveStackBB: 100,
    heroPosition: 'HJ',
    actionHistory: [{ position: 'UTG', kind: 'RAISE', sizeBB: 2.5000000000000004 }],
  })!;
  assert.equal(scenarioHashOf(a), scenarioHashOf(b));
  assert.equal(scenariosEquivalent(a, b), true);
});

test('GTO-SCN-05：7 人桌 / 不存在的组合必须返回 null（绝不就近取整）', () => {
  assert.equal(isGtoTableSize(7), false);
  assert.equal(
    buildGtoScenario({
      kind: GtoScenarioKind.RFI,
      tableSize: 7 as 6,
      effectiveStackBB: 100,
      heroPosition: 'CO',
      actionHistory: [],
    }),
    null,
  );
  // 4 人桌没有 UTG
  assert.equal(
    buildGtoScenario({
      kind: GtoScenarioKind.RFI,
      tableSize: 4,
      effectiveStackBB: 100,
      heroPosition: 'UTG',
      actionHistory: [],
    }),
    null,
  );
  // 位置不存在于该桌人数
  assert.equal(
    buildGtoScenario({
      kind: GtoScenarioKind.RFI,
      tableSize: 8,
      effectiveStackBB: 100,
      heroPosition: 'UTG2',
      actionHistory: [],
    }),
    null,
  );
});

test('GTO-SCN-06：前序动作必须严格按行动顺序，且不能有人抢在 Hero 之后行动', () => {
  // HJ 在 6 人桌是第 2 个行动位；给它一个「CO 已加注」的历史是非法的
  assert.equal(
    buildGtoScenario({
      kind: GtoScenarioKind.VS_OPEN,
      tableSize: 6,
      effectiveStackBB: 100,
      heroPosition: 'HJ',
      actionHistory: [{ position: 'CO', kind: 'RAISE', sizeBB: 2.5 }],
    }),
    null,
  );
  // 顺序颠倒（先 CO 后 UTG）也非法
  assert.equal(
    buildGtoScenario({
      kind: GtoScenarioKind.VS_OPEN,
      tableSize: 6,
      effectiveStackBB: 100,
      heroPosition: 'BTN',
      actionHistory: [
        { position: 'CO', kind: 'RAISE', sizeBB: 2.5 },
        { position: 'UTG', kind: 'FOLD', sizeBB: null },
      ],
    }),
    null,
  );
});

/* ============================================================
 * 二、目录
 * ============================================================ */

test('GTO-SCN-07：目录自检通过，且 5 个桌型都有可查询场景', () => {
  assert.deepEqual(selfCheckCatalog(), []);
  assert.deepEqual(selfCheckScenarioLayer(), []);
  assert.deepEqual(selfCheckGtoLayer(), []);
  for (const size of GTO_TABLE_SIZES) {
    const usable = supportedCatalog([size]);
    assert.ok(usable.length > 0, `${size} 人桌必须有可查询场景`);
  }
});

test('GTO-SCN-08：目录条目 id 唯一；每个桌型的第一个行动位都必须有一个「无前序动作」的场景', () => {
  const all = fullCatalog();
  assert.equal(new Set(all.map((e) => e.id)).size, all.length);
  for (const size of GTO_TABLE_SIZES) {
    const first = gtoPositionsFor(size)[0]!;
    const entry = all.find(
      (e) => e.tableSize === size && e.heroPosition === first && e.template === GtoScenarioTemplate.FIRST_IN,
    );
    assert.ok(entry !== undefined, `${size} 人桌 ${first} 的第一入池条目必须存在`);
    assert.ok(entry.scenario !== null, `${size} 人桌 ${first} 的第一入池必须可查询`);
    assert.equal(entry.scenario.actionHistory.length, 0);
  }
});

test('GTO-SCN-09：目录里「无法表达」的组合必须给出**具体**中文原因，而不是空话', () => {
  const entries = fullCatalog();
  const unsupported = entries.filter((e) => e.scenario === null);
  assert.ok(unsupported.length > 0, '目录里应当有无法表达的组合（例如非第一个座位的「第一入池」）');
  for (const entry of unsupported) {
    assert.ok(entry.unsupportedReason !== null && entry.unsupportedReason.length >= 10);
    // 必须说清楚是哪个座位 / 为什么
    assert.ok(
      /第一个行动位|前面还有|晚于|不成立/.test(entry.unsupportedReason),
      `原因不够具体：${entry.unsupportedReason}`,
    );
  }
});

test('GTO-SCN-10：5MAX 的 HJ 是第一行动位，而 6MAX 的 HJ 不是（位置角色随桌人数改变）', () => {
  assert.equal(gtoPositionsFor(5)[0], 'HJ');
  assert.equal(gtoPositionsFor(6)[0], 'UTG');
  // 5 人桌 HJ：无人入池 → 可构造
  assert.ok(
    buildGtoScenario({
      kind: GtoScenarioKind.RFI,
      tableSize: 5,
      effectiveStackBB: 100,
      heroPosition: 'HJ',
      actionHistory: [],
    }) !== null,
  );
  // 6 人桌 HJ：前面还有 UTG → 无人入池不成立
  assert.equal(
    buildGtoScenario({
      kind: GtoScenarioKind.RFI,
      tableSize: 6,
      effectiveStackBB: 100,
      heroPosition: 'HJ',
      actionHistory: [],
    }),
    null,
  );
});

test('GTO-SCN-11：8MAX 的位置错一格会被抓住（UTG1 与 LJ 不得互换）', () => {
  const order8 = gtoPositionsFor(8);
  assert.deepEqual([...order8], ['UTG', 'UTG1', 'LJ', 'HJ', 'CO', 'BTN', 'SB', 'BB']);
  const utg1 = buildGtoScenario({
    kind: GtoScenarioKind.VS_OPEN,
    tableSize: 8,
    effectiveStackBB: 100,
    heroPosition: 'UTG1',
    actionHistory: [{ position: 'UTG', kind: 'RAISE', sizeBB: 2.5 }],
  })!;
  const lj = buildGtoScenario({
    kind: GtoScenarioKind.VS_OPEN,
    tableSize: 8,
    effectiveStackBB: 100,
    heroPosition: 'LJ',
    actionHistory: [
      { position: 'UTG', kind: 'RAISE', sizeBB: 2.5 },
      { position: 'UTG1', kind: 'FOLD', sizeBB: null },
    ],
  })!;
  assert.notEqual(scenarioHashOf(utg1), scenarioHashOf(lj));
  assert.match(describeScenarioZh(utg1), /UTG1/);
  assert.match(describeScenarioZh(lj), /LJ/);
});

test('GTO-SCN-12：9MAX 的 UTG2 不得与 LJ 混为一谈', () => {
  const order9 = gtoPositionsFor(9);
  assert.deepEqual(
    [...order9],
    ['UTG', 'UTG1', 'UTG2', 'LJ', 'HJ', 'CO', 'BTN', 'SB', 'BB'],
  );
  const utg2 = actionHistoryFor(9, 'UTG2', GtoScenarioTemplate.VS_FIRST_OPEN_THEN_FOLDS);
  const lj = actionHistoryFor(9, 'LJ', GtoScenarioTemplate.VS_FIRST_OPEN_THEN_FOLDS);
  assert.ok(utg2 !== null && lj !== null);
  assert.equal(utg2.length, 2, 'UTG2 前面只有 UTG（开池）+ UTG1（弃牌）');
  assert.equal(lj.length, 3, 'LJ 前面有 UTG（开池）+ UTG1 + UTG2');
  assert.deepEqual(
    lj.map((a) => a.position),
    ['UTG', 'UTG1', 'UTG2'],
  );
});

/* ============================================================
 * 三、契约边界（静态扫描）
 * ============================================================ */

/** 递归收集 .ts 文件（跳过构建产物与引擎目录） */
function collectTsFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'target' || name === '.git') continue;
    const full = join(dir, name);
    const info = statSync(full);
    if (info.isDirectory()) {
      collectTsFiles(full, out);
    } else if (name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

test('GTO-SCN-13：只有 GTOpen 适配层可以出现 GTOpen 的端点字符串', () => {
  const files = collectTsFiles(join(REPO_ROOT, 'src'));
  const allowed = [
    join('src', 'domain', 'gto', 'providers', 'gtopenProvider.ts'),
    join('src', 'domain', 'gto', 'providers', 'gtopenHttpClient.ts'),
    join('src', 'domain', 'gto', 'providers', 'gtopenCapabilities.ts'),
  ];
  const offenders: string[] = [];
  for (const file of files) {
    const rel = relative(REPO_ROOT, file);
    if (allowed.includes(rel)) continue;
    const text = readFileSync(file, 'utf8');
    // 端点片段：出现即说明有人在适配层之外发 GTOpen 请求
    for (const needle of ['/api/preflop/', 'preflop/spot', 'preflop/node', 'preflop/solve']) {
      if (text.includes(needle)) offenders.push(`${rel} → ${needle}`);
    }
  }
  assert.deepEqual(offenders, [], `以下文件在适配层之外引用了 GTOpen 端点：\n${offenders.join('\n')}`);
});

test('GTO-SCN-14：Decision Engine / 上下文 / 先验 / 似然 不得 import 任何 GTO Provider', () => {
  const files = collectTsFiles(join(REPO_ROOT, 'src'));
  const forbiddenTargets = [
    'providers/gtopenProvider',
    'providers/gtopenHttpClient',
    'providers/providerRegistry',
    'gtoSafeLookup',
  ];
  const offenders: string[] = [];
  for (const file of files) {
    const rel = relative(REPO_ROOT, file);
    // 允许：应用层的装配点（gtoApi）与 gto 子域自身
    if (rel.startsWith(join('src', 'domain', 'gto'))) continue;
    if (rel === join('src', 'app', 'gto', 'gtoApi.ts')) continue;
    const text = readFileSync(file, 'utf8');
    // 只检查 import 语句，避免误判注释里提到的名字
    const importLines = text
      .split('\n')
      .filter((line) => /^\s*(import|export)\b.*\bfrom\b/.test(line));
    for (const line of importLines) {
      if (forbiddenTargets.some((target) => line.includes(target))) {
        offenders.push(`${rel} → ${line.trim()}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `以下文件非法依赖了 GTO Provider：\n${offenders.join('\n')}`);
});

test('GTO-SCN-15：Decision Engine 不得出现任何 GTO 相关分支（没有 if engine === …）', () => {
  const enginePath = join(REPO_ROOT, 'src', 'app', 'decision', 'decisionEngine.ts');
  const text = readFileSync(enginePath, 'utf8');
  // 本轮明确不改 Decision Engine；它连 gto 这个词都不应该出现
  assert.ok(!/gtopen/i.test(text), 'Decision Engine 不得出现 gtopen');
  assert.ok(!/\bgto\b/i.test(text.replace(/\/\*[\s\S]*?\*\//g, '')), 'Decision Engine 不得引用 GTO');
});

test('GTO-SCN-16：前端 JS 不得直接访问 GTOpen 端口（只能走 Alpha 自己的 API）', () => {
  for (const name of ['gto.js', 'table.js']) {
    const text = readFileSync(join(REPO_ROOT, 'src', 'app', 'web', name), 'utf8');
    /* ① 端口与求解器地址：任何硬编码都违规 */
    assert.ok(!/3737/.test(text), `${name} 不得硬编码 GTOpen 端口`);
    assert.ok(!/127\.0\.0\.1/.test(text), `${name} 不得硬编码求解器地址`);

    /*
     * ② **所有** `fetch` / `postJson` 的地址必须是**同源相对路径**。
     *
     * ## 为什么这样判（而不是继续用裸词 `/preflop/`）
     *
     * 原判据是 `/preflop/` —— 本意是「不得直接拼求解器端点」，却把
     * **任何**含 preflop 的标识符都当成违规。阶段 B 往牌桌调试区加了一条
     * **纯展示**字段 `preflopRaise`（翻前加注事实包的逐尺寸证据）后，这条
     * 断言误报。误报本身就是缺陷：一条安全断言如果会对无关标识符报警，
     * 维护者迟早会把它删掉。
     *
     * 也不能改成「路径黑名单」：`gto.js` 调 `/api/gto/range` **正是**本测试
     * 要求的做法（「只能走 Alpha 自己的 API」），而它包含 `/gto/range` 子串。
     *
     * 真正的语义是「不得直连求解器」，可执行的形式是：
     * **每一个请求地址都必须是 `'/'` 开头的同源相对路径** ——
     * 于是 `http://127.0.0.1:3737/...`、绝对 URL、协议相对 URL 一律不合法。
     */
    const callSites = [...text.matchAll(/(?:fetch|postJson)\s*\(\s*(['"`])([^'"`]*)\1/g)];
    assert.ok(callSites.length > 0, `${name} 应当有可检查的请求点（判据失效会让本断言变成空转）`);
    for (const site of callSites) {
      const url = site[2]!;
      assert.ok(
        url.startsWith('/') && !url.startsWith('//'),
        `${name} 的请求地址必须是同源相对路径，实际「${url}」` +
          '（直连求解器或外部地址一律不允许）',
      );
    }
  }
});

/* ============================================================
 * 四、能力表与可信度天花板
 * ============================================================ */

test('GTO-SCN-17：翻前可信度上限恒为 APPROXIMATE，且能力表声明了 5 个桌型', () => {
  assert.equal(GTOPEN_PREFLOP_MAX_VERIFICATION, 'APPROXIMATE');
  assert.equal(GTOPEN_CAPABILITY_TABLE.preflopApproximateModel, true);
  assert.deepEqual([...GTOPEN_CAPABILITY_TABLE.verifiedTableSizes], [4, 5, 6, 8, 9]);
  assert.equal(GTOPEN_CAPABILITY_TABLE.engineTableSizeRange.min, 2);
  assert.equal(GTOPEN_CAPABILITY_TABLE.engineTableSizeRange.max, 9);
  assert.ok(GTOPEN_CAPABILITY_TABLE.evidence.length >= 4, '每条能力都必须有依据');
});

test('GTO-SCN-18：7 人桌在能力表里是 UNSUPPORTED（源码允许不等于我们验证过）', () => {
  assert.equal(supportLevelFor(GtoScenarioKind.RFI, 7), 'UNSUPPORTED');
  assert.equal(supportLevelFor(GtoScenarioKind.RFI, 4), 'SUPPORTED');
  assert.equal(supportLevelFor(GtoScenarioKind.RFI, 9), 'SUPPORTED');
});

/* ============================================================
 * 五、界面数据（目录 JSON）
 * ============================================================ */

test('GTO-SCN-19：目录 JSON 的桌人数与位置顺序与领域层一致（界面零硬编码）', () => {
  const json = gtoCatalog();
  assert.deepEqual([...json.tableSizes], [4, 5, 6, 8, 9]);
  for (const size of GTO_TABLE_SIZES) {
    assert.deepEqual(
      [...json.positionsByTableSize[String(size)]!],
      [...gtoPositionsFor(size)],
      `${size} 人桌的位置下拉框必须来自权威顺序`,
    );
  }
  // 位置中文名必须齐全（否则界面会显示裸的英文键）
  for (const size of GTO_TABLE_SIZES) {
    for (const position of gtoPositionsFor(size)) {
      assert.ok(GTO_POSITION_ZH[position] !== undefined, `${position} 缺少中文名`);
    }
  }
});

test('GTO-SCN-20：目录 JSON 里 4 人桌只有 4 个位置，9 人桌有 9 个（UI 动态切换的基础）', () => {
  const json = gtoCatalog();
  assert.equal(json.positionsByTableSize['4']!.length, 4);
  assert.equal(json.positionsByTableSize['5']!.length, 5);
  assert.equal(json.positionsByTableSize['6']!.length, 6);
  assert.equal(json.positionsByTableSize['8']!.length, 8);
  assert.equal(json.positionsByTableSize['9']!.length, 9);
  assert.ok(!json.positionsByTableSize['4']!.includes('UTG'));
});

test('GTO-SCN-21：catalogScenarioOf 对不存在的组合返回 null（界面无法编造场景）', () => {
  assert.equal(
    catalogScenarioOf({ tableSize: 4, heroPosition: 'UTG', template: 'FIRST_IN' }),
    null,
  );
  assert.equal(catalogScenarioOf({ tableSize: 7, heroPosition: 'CO', template: 'FIRST_IN' }), null);
  assert.ok(catalogScenarioOf({ tableSize: 6, heroPosition: 'UTG', template: 'FIRST_IN' }) !== null);
});

test('GTO-SCN-22：每个目录条目的中文标签都带桌人数（同名位置必须能分辨）', () => {
  for (const entry of supportedCatalog()) {
    const label = catalogEntryLabelZh(entry);
    assert.ok(label.includes(String(entry.tableSize)), `${entry.id} 的标签必须含桌人数`);
  }
  // 模板中文名齐全
  for (const template of Object.values(GtoScenarioTemplate)) {
    assert.ok(GTO_TEMPLATE_ZH[template] !== undefined && GTO_TEMPLATE_ZH[template].length > 0);
  }
});

/* ============================================================
 * 七、3Bet 几何（Phase 1.1 第二轮：六次修正之后的最终形状）
 *
 * 这一节锁的是**本轮代价最大的一条结论**。写错的时候不会抛异常，
 * 只会让行动落到别人身上 —— 也就是读到别人的策略。
 * ============================================================ */

test('GTO-SCN-23：canHeroFaceThreeBet —— 只有第一个行动位能面对 3Bet', () => {
  /*
   * 依据（求解器源码 + 实测）：
   * `next_state_of` 的 `needs` 只为「除加注者之外的活人」重开行动，
   * 且 `next_actor_of` **不跳过任何还没行动过的座位**。
   * 因此只要 Hero 前面还有没行动过的人，那个人就是这一圈的收口人。
   */
  for (const size of GTO_TABLE_SIZES) {
    const order = gtoPositionsFor(size);
    for (const position of order) {
      const expected = position === order[0];
      assert.equal(
        canHeroFaceThreeBet(size, position),
        expected,
        `${size}MAX ${position}：${expected ? '是' : '不是'}第一个行动位`,
      );
    }
  }
});

test('GTO-SCN-24：legalThreeBettorsFor —— 3Bettor 必须在 Hero 之后且不是盲注位', () => {
  for (const size of GTO_TABLE_SIZES) {
    const order = gtoPositionsFor(size);
    for (const hero of order) {
      const heroIndex = order.indexOf(hero);
      const bettors = legalThreeBettorsFor(size, hero);
      for (const b of bettors) {
        assert.ok(order.indexOf(b) > heroIndex, `${size}MAX：${b} 必须在 ${hero} 之后`);
        assert.ok(b !== 'SB' && b !== 'BB', `${size}MAX：盲注位 ${b} 不得作为 3Bettor`);
      }
      // 完整性：Hero 之后所有非盲注座位都应当在内
      const shouldBe = order.slice(heroIndex + 1).filter((p) => p !== 'SB' && p !== 'BB');
      assert.deepEqual([...bettors], shouldBe, `${size}MAX ${hero} 的候选集不完整`);
    }
  }
});

test('GTO-SCN-25：VS_3BET 几何 —— 开池者是 Hero，弃牌顺序是**环绕**而不是数组那一段', () => {
  /*
   * 6MAX / Hero=UTG / 3Bettor=HJ 的**真实**顺序（实测逐位核对过）：
   *
   * ```text
   * UTG 加注 → HJ 3Bet → CO 弃 → BTN 弃 → SB 弃 → BB 弃 → 回到 UTG
   * ```
   *
   * 这一条之所以值得单独锁：早期版本把「3Bet 之后的弃牌」写成
   * 「数组里 3Bettor 之后的部分」，结果 6MAX/Hero=BTN 时漏掉 UTG/HJ，
   * 实测**行动落到了 SB 身上**。
   */
  const scenario = buildGtoScenario({
    kind: GtoScenarioKind.VS_3BET,
    tableSize: 6,
    effectiveStackBB: 100,
    heroPosition: 'UTG',
    villainPosition: 'HJ',
    openSizeBB: 2.5,
  });
  assert.ok(scenario !== null, '6MAX UTG vs HJ 3Bet 必须可构造');
  assert.deepEqual(
    scenario.actionHistory.map((a) => `${a.position}:${a.kind}`),
    ['UTG:RAISE', 'HJ:RAISE', 'CO:FOLD', 'BTN:FOLD', 'SB:FOLD', 'BB:FOLD'],
  );
  assert.equal(scenario.heroAlreadyActed, true, 'Hero 是开池者 ⇒ 他已经行动过');
  assert.equal(scenario.villainPosition, 'HJ', 'villain 是 3Bettor');

  /*
   * 8MAX 的写法更陡：Hero=UTG、3Bettor=BTN 时，
   * 3Bet 之后的环绕是 `SB BB`（数组里 BTN 之后的部分），但 Hero=UTG1 时
   * 前面的 UTG 还没动作，因此那个组合**不该**存在（见 GTO-SCN-23）。
   */
  const wide = buildGtoScenario({
    kind: GtoScenarioKind.VS_3BET,
    tableSize: 8,
    effectiveStackBB: 100,
    heroPosition: 'UTG',
    villainPosition: 'BTN',
    openSizeBB: 2.5,
  });
  assert.ok(wide !== null);
  assert.deepEqual(
    wide.actionHistory.map((a) => `${a.position}:${a.kind}`),
    ['UTG:RAISE', 'UTG1:FOLD', 'LJ:FOLD', 'HJ:FOLD', 'CO:FOLD', 'BTN:RAISE', 'SB:FOLD', 'BB:FOLD'],
  );
});

test('GTO-SCN-26：VS_3BET 的 `heroAlreadyActed` 由**场景类型**推导，不靠调用方记得传', () => {
  /*
   * 漏传的后果是 `buildGtoScenario` 返回 `null`，而 `null` 会被上层
   * 报成「参数组合不合法」—— 一个**看不见的**缺陷。
   *（真的发生过：`THREE_BET` 的 85 个条目全部悄悄变成「不支持」。）
   */
  const withoutFlag = buildGtoScenario({
    kind: GtoScenarioKind.VS_3BET,
    tableSize: 6,
    effectiveStackBB: 100,
    heroPosition: 'UTG',
    villainPosition: 'HJ',
    openSizeBB: 2.5,
  });
  const withFlag = buildGtoScenario({
    kind: GtoScenarioKind.VS_3BET,
    tableSize: 6,
    effectiveStackBB: 100,
    heroPosition: 'UTG',
    villainPosition: 'HJ',
    openSizeBB: 2.5,
    heroAlreadyActed: true,
  });
  assert.ok(withoutFlag !== null, '不传 heroAlreadyActed 也必须能构造出来');
  assert.ok(withFlag !== null);
  assert.equal(withoutFlag.heroAlreadyActed, true);
  assert.equal(
    scenarioHashOf(withoutFlag),
    scenarioHashOf(withFlag),
    '两种写法必须得到**同一个**场景（否则缓存会分裂）',
  );
});

test('GTO-SCN-27：VS_3BET 的 `heroAlreadyActed` 进入场景哈希（不能与别的形态混同）', () => {
  const base = {
    kind: GtoScenarioKind.VS_3BET,
    tableSize: 6,
    effectiveStackBB: 100,
    heroPosition: 'UTG',
    villainPosition: 'HJ',
    openSizeBB: 2.5,
  } as const;
  const acted = buildGtoScenario({ ...base, heroAlreadyActed: true });
  assert.ok(acted !== null);
  // 同一个 kind 下强制成 false 时应当被拒（B1：Hero 必须在历史里出现过）
  const notActed = buildGtoScenario({ ...base, heroAlreadyActed: false });
  assert.equal(notActed, null, 'heroAlreadyActed=false 时这个历史必须被拒');
});
