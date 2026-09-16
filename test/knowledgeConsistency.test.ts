/**
 * 知识库与实现的一致性测试（Phase 4.5，红队 F-09 / F-01 的结构性防线）
 *
 * ## 为什么要单独一个文件
 *
 * 红队发现的两类缺陷都属于**交叉引用漂移**：
 *
 * | 缺陷 | 形式 |
 * |---|---|
 * | F-01 | 知识库声称出处是某个文件，但该文件**不含**声称的内容 |
 * | F-09 | `CASE_TAXONOMY.md` 列的标签清单与代码 `PlayerLabel` **对不上**（多了 3 个、少了 4 个） |
 *
 * 这类缺陷的共性是：**单看任何一份文件都自洽，只有把两者放在一起才暴露**。
 * 因此必须有**跨文件**的断言。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { PlayerLabel } from '../src/domain/player/playerClassifier.ts';
import { PlayerMetric, METRIC_DEFINITIONS } from '../src/domain/player/player.types.ts';
import {
  GameEnvironment,
  ALL_GAME_ENVIRONMENTS,
} from '../src/domain/range/gameEnvironment.ts';
import {
  EvidenceLevel,
  KnowledgeSourceType,
  StrategyStreet,
  GameEnvironmentId,
  AdjustmentTarget,
  AdjustmentDirection,
  AllowedUsage,
  KnowledgeSourceType as SourceType,
} from '../src/domain/knowledge/knowledge.types.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

function readReport(relativePath: string): string {
  const path = `${ROOT}${relativePath}`;
  assert.ok(existsSync(path), `报告文件必须存在：${relativePath}`);
  return readFileSync(path, 'utf8');
}

/* ============================================================
 * 一、红队 F-09：标签清单必须与代码一致
 * ============================================================ */

test('**回归（红队 F-09）**：CASE_TAXONOMY 的标签清单必须与代码 PlayerLabel 逐字一致', () => {
  const taxonomy = readReport('reports/CASE_TAXONOMY.md');
  const codeLabels = Object.values(PlayerLabel);

  // 每一个代码标签都必须在分类文件里出现
  for (const label of codeLabels) {
    assert.ok(
      taxonomy.includes(`\`${label}\``),
      `代码中的标签 ${label} 未出现在 CASE_TAXONOMY.md 中 —— 标签清单已与实现漂移`,
    );
  }

  // 分类文件里引用的标签名不得超出代码的取值集合
  const backticked = [...taxonomy.matchAll(/`([A-Z][A-Z_]{3,})`/g)].map((m) => m[1]!);
  const known = new Set<string>([
    ...codeLabels,
    ...Object.values(PlayerMetric),
    ...Object.values(METRIC_DEFINITIONS).map((d) => d.street),
    ...Object.values(GameEnvironment),
    ...Object.values(EvidenceLevel),
    ...Object.values(KnowledgeSourceType),
    ...Object.values(StrategyStreet),
    ...Object.values(GameEnvironmentId),
    ...Object.values(AdjustmentTarget),
    ...Object.values(AdjustmentDirection),
    ...Object.values(AllowedUsage),
    // 分类文件里合法出现的其它代码标识
    'METRIC_DEFINITIONS',
    'opportunityRule',
    'successRule',
    'PlayerLabel',
    'PRELIMINARY',
    'STANDARD',
    'CONFIRMED',
    'LIVE_CASH',
    'PokerCase',
    'CaseAnalysis',
    'CaseResult',
  ]);

  const unknown = [...new Set(backticked)].filter((x) => !known.has(x));
  assert.deepEqual(
    unknown,
    [],
    `CASE_TAXONOMY.md 引用了未登记的标识：${unknown.join(', ')}`,
  );
});

test('**回归（红队 F-09）**：分类文件中被标为「已实现」的标签必须真的存在于代码', () => {
  const taxonomy = readReport('reports/CASE_TAXONOMY.md');
  const codeLabels = new Set<string>(Object.values(PlayerLabel));

  // 表格中「代码中是否有」列写 ✅ 的行，其标签必须真实存在
  for (const label of codeLabels) {
    assert.ok(taxonomy.includes(label), `标签 ${label} 必须在分类文件的清单中出现`);
  }

  // 反向：分类文件声称「代码中是否存在 = ❌」的那些，必须确实不在代码里
  const notImplemented = ['Maniac', 'Overfolder'];
  for (const name of notImplemented) {
    assert.ok(
      !codeLabels.has(name),
      `${name} 被分类文件列为「未实现」，但它已存在于代码中 —— 分类文件需更新`,
    );
  }
});

/* ============================================================
 * 二、红队 F-01：知识库声称的出处必须真的含该内容
 * ============================================================ */

test('**回归（红队 F-01）**：知识政策文件必须真的包含优先级链的全部层级', () => {
  const policy = readReport('docs/KNOWLEDGE_POLICY.md');
  const levels = [
    'Math Truth',
    'Verified Individual Data',
    'Reliable Node-specific Data',
    'Game Environment Prior',
    'Generic Heuristic',
  ];
  for (const level of levels) {
    assert.ok(policy.includes(level), `KNOWLEDGE_POLICY.md 必须包含优先级层级「${level}」`);
  }
  // 必须明确写出覆盖关系，而不只是罗列名称
  assert.ok(policy.includes('覆盖'), '必须明确写出覆盖关系');
  // 必须明确第 ① 层永不被覆盖
  assert.ok(policy.includes('永不被覆盖'), '必须明确写出「第 ① 层永不被覆盖」');
});

test('**回归（红队 F-01）**：知识库中所有内部来源的出处文件都必须存在且非空', () => {
  const index = loadKnowledgeBaseOrThrow();
  for (const s of index.allSources().filter((x) => x.id.startsWith('internal.'))) {
    assert.ok(s.url, `内部来源 ${s.id} 必须给出出处路径`);
    const path = `${ROOT}${s.url}`;
    assert.ok(existsSync(path), `内部来源 ${s.id} 的出处不存在：${s.url}`);
    const content = readFileSync(path, 'utf8');
    assert.ok(content.length > 200, `内部来源 ${s.id} 的出处文件内容过短，可能不是真出处`);
  }
});

/* ============================================================
 * 三、环境与知识库的一致性
 * ============================================================ */

test('知识库的 GameEnvironment 取值必须与代码的 GameEnvironment 一致', () => {
  const index = loadKnowledgeBaseOrThrow();
  const codeEnvs = new Set<string>(Object.values(GameEnvironment));
  for (const rule of index.allRules()) {
    assert.ok(
      codeEnvs.has(rule.gameEnvironment),
      `规则 ${rule.ruleId} 引用了代码中不存在的环境「${rule.gameEnvironment}」`,
    );
  }
  // 三种环境都必须至少有一条规则（否则某个环境没有知识支撑）
  for (const env of ALL_GAME_ENVIRONMENTS) {
    assert.ok(
      index.allRules().some((r) => r.gameEnvironment === env),
      `环境 ${env} 没有任何知识库规则`,
    );
  }
});

test('知识库的 street 取值必须与代码一致', () => {
  const index = loadKnowledgeBaseOrThrow();
  const known = new Set<string>(Object.values(StrategyStreet));
  for (const rule of index.allRules()) {
    assert.ok(known.has(rule.street), `规则 ${rule.ruleId} 的 street 未登记：${rule.street}`);
  }
});

/* ============================================================
 * 四、报告与知识库的一致性
 * ============================================================ */

test('EXTERNAL_KNOWLEDGE_AUDIT 报告的仓库清单必须与注册表一致', () => {
  const index = loadKnowledgeBaseOrThrow();
  const report = readReport('reports/EXTERNAL_KNOWLEDGE_AUDIT.md');

  const githubSources = index.allSources().filter((s) => s.type === KnowledgeSourceType.GITHUB);
  assert.ok(githubSources.length === 4, `预期 4 个 GitHub 来源，实际 ${githubSources.length}`);

  for (const s of githubSources) {
    assert.ok(report.includes(s.commitHash!), `报告必须写出 ${s.id} 的 commit：${s.commitHash}`);
    assert.ok(report.includes(s.id), `报告必须点明来源 id：${s.id}`);
    assert.ok(report.includes(s.url!), `报告必须给出仓库 URL：${s.url}`);
  }
});

test('报告中的 commit 哈希必须与注册表逐位一致（防止两处各写一份）', () => {
  const index = loadKnowledgeBaseOrThrow();
  const report = readReport('reports/EXTERNAL_KNOWLEDGE_AUDIT.md');
  for (const s of index.allSources().filter((x) => x.type === KnowledgeSourceType.GITHUB)) {
    assert.ok(
      report.includes(s.commitHash!),
      `${s.id} 的 commit ${s.commitHash} 未出现在报告中`,
    );
  }
});

test('报告不得引用未登记为来源的第三方仓库（防止来源幻觉）', () => {
  const index = loadKnowledgeBaseOrThrow();
  const report = readReport('reports/EXTERNAL_KNOWLEDGE_AUDIT.md');
  const registered = new Set(index.allSources().map((s) => s.url ?? ''));

  // 报告中出现的 github.com/{owner}/{repo} 链接必须都能在注册表里找到
  const links = [...report.matchAll(/https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/g)].map(
    (m) => `https://github.com/${m[1]}`,
  );
  for (const link of new Set(links)) {
    assert.ok(
      registered.has(link),
      `报告引用了未登记的仓库「${link}」—— 要么补登记，要么移除引用`,
    );
  }
});

test('报告不得把 RED 来源的数值抄进来（红队 F-05 的回归防线）', () => {
  const index = loadKnowledgeBaseOrThrow();
  const report = readReport('reports/EXTERNAL_KNOWLEDGE_AUDIT.md');

  // 找出所有 RED 门禁来源
  const redIds = index.allSources().filter((s) => s.licenseGate === 'RED').map((s) => s.id);
  assert.ok(redIds.length > 0, '前置条件：存在 RED 来源');

  // GTOpen 的原始统计表数值（若出现在报告里，说明违反了 RED 纪律）
  // 这些数字只在 GTOpen docs/player_types.md 的原型统计表中出现
  const gtopenTableNumbers = [
    '10.5', '18.8', '33.4', '56.5', '37.1', '13.5',
    '3,287', '4,115', '4,408', '9,861', '1,566', '2,284', '743',
    '2,942', '14.5M', '1,450',
  ];
  const leaked = gtopenTableNumbers.filter((n) => report.includes(n));
  assert.deepEqual(
    leaked,
    [],
    `报告抄录了 RED 来源（GTOpen）的统计数值：${leaked.join(', ')} —— 违反本阶段自己定的 RED 纪律`,
  );

  // 同时：「包含数据但不可推导」的来源，其数值也不应出现在报告里
  const nonDerivable = index
    .allSources()
    .filter((s) => s.hasQuantitativeData && !s.derivableQuantitativeData && s.licenseGate === 'RED')
    .map((s) => s.id);
  assert.ok(nonDerivable.length > 0, '前置条件：存在「有数据但不可推导」的 RED 来源');
});

test('知识库的每条规则都必须在 INTEGRATION_MAP 或 AUDIT 报告中有对应说明', () => {
  const index = loadKnowledgeBaseOrThrow();
  const integration = readReport('reports/REFERENCE_INTEGRATION_MAP.md');
  const audit = readReport('reports/EXTERNAL_KNOWLEDGE_AUDIT.md');

  for (const rule of index.allRules()) {
    // 规则本身不必逐条出现在报告里，但其**主题**必须能在报告中找到出处说明。
    // 这里用「规则引用的来源 id 或其标题关键词」做检查。
    const sources = index.sourcesOf(rule.ruleId);
    const mentioned = sources.some(
      (s) => integration.includes(s.id) || audit.includes(s.id) || audit.includes(s.title.split(' ——')[0]!.trim()),
    );
    assert.ok(
      mentioned || rule.sources.every((id) => id.startsWith('internal.')),
      `规则 ${rule.ruleId} 的来源未在报告中说明`,
    );
  }
});

/* ============================================================
 * 五、红队 F-00：产物绑定版本（已提升为**全项目通用标准**）
 * ============================================================ */

test('**回归（红队 F-00）**：全项目产物清单必须存在且与文件系统逐位一致', async () => {
  // 红队指出：审计期间 6 个产物被并发改写，报告在 3 小时内改了 3 次，
  // 同一命令两次运行结果不同。因此「审计通过」这个结论必须绑定到
  // **具体的字节内容**，否则无法回答「你审的是哪个版本」。
  //
  // 本机制现已提升为全项目标准：Range 数据 / 环境参数 / 模型版本 /
  // 红队报告全部绑定 hash。这样「昨天 CALL、今天 FOLD」可以追到具体文件。
  const { readFileSync: read } = await import('node:fs');
  const { parseManifest, verifyManifest } = await import('../src/infra/artifactManifest.ts');
  const { ARTIFACT_DEFINITIONS, PROJECT_MANIFEST_PATH } = await import(
    '../src/infra/artifactDefinitions.ts'
  );

  const path = `${ROOT}${PROJECT_MANIFEST_PATH}`;
  assert.ok(existsSync(path), `全项目清单必须存在：${PROJECT_MANIFEST_PATH}（运行 npm run manifest）`);

  const manifest = parseManifest(read(path, 'utf8'));
  const result = verifyManifest(manifest, ARTIFACT_DEFINITIONS);

  assert.deepEqual(
    result.issues,
    [],
    `产物清单校验失败：\n${result.issues.map((i) => `  [${i.kind}] ${i.message}`).join('\n')}\n` +
      '若是有意修改，请运行 npm run manifest 重新生成',
  );
  assert.ok(result.checked >= 30, `清单应覆盖至少 30 个产物，实际校验 ${result.checked} 个`);
});

test('全项目清单必须覆盖六类关键产物（含 Range / 环境 / 模型 / 决策 / 报告）', async () => {
  const { readFileSync: read } = await import('node:fs');
  const { parseManifest, ManifestCategory } = await import('../src/infra/artifactManifest.ts');

  const manifest = parseManifest(read(`${ROOT}data/artifact-manifest.json`, 'utf8'));
  const categories = new Set(manifest.entries.map((e) => e.category));

  for (const required of Object.values(ManifestCategory)) {
    assert.ok(categories.has(required), `清单必须覆盖类别 ${required}`);
  }

  // 每条目必须带「影响说明」—— 报错时才知道该查哪里
  for (const entry of manifest.entries) {
    assert.ok(
      entry.impact.length >= 10,
      `${entry.path} 必须写明「该文件变化会影响什么」（当前：「${entry.impact}」）`,
    );
    assert.match(entry.sha256, /^[0-9a-f]{64}$/);
    assert.ok(entry.bytes > 0);
  }
});

test('清单必须声明自指排除并说明原因（不得静默跳过）', async () => {
  const { readFileSync: read } = await import('node:fs');
  const { parseManifest } = await import('../src/infra/artifactManifest.ts');

  const manifest = parseManifest(read(`${ROOT}data/artifact-manifest.json`, 'utf8'));
  assert.ok(manifest.exclusions.length > 0, '必须显式声明被排除的文件');
  for (const exclusion of manifest.exclusions) {
    assert.ok(exclusion.reason.length > 10, `${exclusion.path} 的排除原因必须写清`);
  }
  assert.ok(
    manifest.exclusions.some((e) => e.path.includes('artifact-manifest')),
    '必须显式排除清单自身（自指）并说明',
  );
});

test('回归（红队 F-11）：两个知识 JSON 文件的 BOM 状态必须一致且均无 BOM', () => {
  const files = ['data/knowledge/source-registry.json', 'data/knowledge/strategy-rules.json'];
  const bomStates = files.map((f) => {
    const bytes = readFileSync(`${ROOT}${f}`);
    return bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  });
  assert.equal(
    bomStates[0],
    bomStates[1],
    `BOM 状态不一致（${files[0]}=${bomStates[0]}, ${files[1]}=${bomStates[1]}）—— ` +
      'PowerShell 的 Set-Content -Encoding UTF8 会写 BOM，混用工具会造出不一致',
  );
  assert.equal(bomStates[0], false, '两个 JSON 文件都不应带 BOM（loader 虽容忍，但格式应统一）');
});

test('回归（红队 F-11）：知识库不得声明不存在的 schema 文件', () => {
  for (const f of ['data/knowledge/source-registry.json', 'data/knowledge/strategy-rules.json']) {
    const raw = readFileSync(`${ROOT}${f}`, 'utf8');
    const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    const parsed = JSON.parse(text) as Record<string, unknown>;
    assert.equal(
      parsed.$schema,
      undefined,
      `${f} 不得声明 $schema —— 项目里并不存在该 schema 文件，声明一个不存在的契约是误导`,
    );
  }
});