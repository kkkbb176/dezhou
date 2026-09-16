/**
 * 产物清单机制测试（全项目通用标准）
 *
 * ## 这个机制要回答的问题
 *
 * > 「昨天建议 CALL，今天同一手牌建议 FOLD —— 究竟是哪一个版本变了？」
 *
 * 没有字节级绑定，这个问题无法回答：「代码没改」是一个印象，不是可验证的事实。
 *
 * ## 本文件的测试分三层
 *
 * 1. **机制自身正确性**：生成、校验、两个方向的漂移检测
 * 2. **Fail-Closed**：定义表里有文件不存在时必须拒绝生成（不得产生残缺清单）
 * 3. **实际清单的覆盖与质量**：类别齐全、影响说明非空、自指排除已声明
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ManifestCategory,
  REPOSITORY_ROOT,
  describeManifest,
  generateManifest,
  parseManifest,
  sha256OfFile,
  verifyManifest,
  writeManifest,
  type ArtifactDefinition,
} from '../src/infra/artifactManifest.ts';
import {
  ARTIFACT_DEFINITIONS,
  MANIFEST_EXCLUSIONS,
  PROJECT_MANIFEST_PATH,
} from '../src/infra/artifactDefinitions.ts';

/* ============================================================
 * 一、机制自身
 * ============================================================ */

test('生成：清单条目必须包含 sha256 / 字节数 / 类别 / 影响说明', () => {
  const result = generateManifest(
    [
      {
        path: 'package.json',
        category: ManifestCategory.DECISION,
        impact: '包定义变化会影响脚本与依赖版本',
      },
    ],
    { generatedAt: '2026-09-13' },
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.manifest.entries.length, 1);
  const entry = result.manifest.entries[0]!;
  assert.match(entry.sha256, /^[0-9a-f]{64}$/);
  assert.ok(entry.bytes > 0);
  assert.equal(entry.category, ManifestCategory.DECISION);
  assert.ok(entry.impact.length > 0);
});

test('**Fail-Closed**：定义表中有文件不存在时必须拒绝生成，不得产生残缺清单', () => {
  const result = generateManifest(
    [
      { path: 'package.json', category: ManifestCategory.DECISION, impact: 'x'.repeat(20) },
      {
        path: '这个文件不存在.txt',
        category: ManifestCategory.DECISION,
        impact: 'x'.repeat(20),
      },
    ],
    { generatedAt: '2026-09-13' },
  );
  assert.equal(result.ok, false, '缺文件时必须失败');
  if (result.ok) return;
  assert.deepEqual(result.missing, ['这个文件不存在.txt']);
});

test('校验：内容未变时通过', () => {
  const definitions: ArtifactDefinition[] = [
    { path: 'package.json', category: ManifestCategory.DECISION, impact: 'x'.repeat(20) },
  ];
  const generated = generateManifest(definitions, { generatedAt: '2026-09-13' });
  assert.equal(generated.ok, true);
  if (!generated.ok) return;

  const verdict = verifyManifest(generated.manifest, definitions);
  assert.equal(verdict.manifestMatches, true);
  assert.deepEqual(verdict.issues, []);
  assert.equal(verdict.checked, 1);
});

test('校验：内容变化时必须报 CHANGED，并带上影响说明', () => {
  const dir = mkdtempSync(join(tmpdir(), 'manifest-changed-'));
  try {
    const file = join(dir, 'sample.txt');
    writeFileSync(file, 'v1', 'utf8');

    // 直接构造一个「清单说 v1、文件其实是 v2」的场景
    const manifest = {
      manifestVersion: '1.0.0',
      generatedAt: '2026-09-13',
      generator: 'test',
      exclusions: [],
      entries: [
        {
          path: 'package.json',
          category: ManifestCategory.DECISION,
          sha256: 'a'.repeat(64),
          bytes: 2,
          impact: '这个文件变化会影响建议',
        },
      ],
    };
    const verdict = verifyManifest(manifest, [
      { path: 'package.json', category: ManifestCategory.DECISION, impact: 'x' },
    ]);
    assert.equal(verdict.manifestMatches, false);
    assert.equal(verdict.issues.length, 1);
    assert.equal(verdict.issues[0]!.kind, 'CHANGED');
    assert.ok(
      verdict.issues[0]!.message.includes('这个文件变化会影响建议'),
      `报错必须带上影响说明，实际「${verdict.issues[0]!.message}」`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('校验：清单登记的文件消失时必须报 MISSING', () => {
  const manifest = {
    manifestVersion: '1.0.0',
    generatedAt: '2026-09-13',
    generator: 'test',
    exclusions: [],
    entries: [
      {
        path: '不存在的产物.txt',
        category: ManifestCategory.REPORT,
        sha256: 'a'.repeat(64),
        bytes: 1,
        impact: 'x'.repeat(20),
      },
    ],
  };
  const verdict = verifyManifest(manifest, []);
  assert.equal(verdict.issues.length, 1);
  assert.equal(verdict.issues[0]!.kind, 'MISSING');
});

test('**回归**：定义表里有、清单里没有 → 必须报 UNLISTED（新增产物忘记登记的唯一防线）', () => {
  const manifest = {
    manifestVersion: '1.0.0',
    generatedAt: '2026-09-13',
    generator: 'test',
    exclusions: [],
    entries: [],
  };
  const verdict = verifyManifest(manifest, [
    { path: 'package.json', category: ManifestCategory.DECISION, impact: 'x' },
  ]);
  assert.equal(verdict.manifestMatches, false);
  assert.equal(verdict.issues[0]!.kind, 'UNLISTED');
  assert.ok(
    verdict.issues[0]!.message.includes('忘记登记'),
    '必须点明是「忘记登记」而不是「内容变了」—— 两者的修复动作完全不同',
  );
});

test('写出与读回：必须是 UTF-8 无 BOM，且往返一致', () => {
  const dir = mkdtempSync(join(tmpdir(), 'manifest-io-'));
  try {
    const path = join(dir, 'manifest.json');
    const generated = generateManifest(
      [{ path: 'package.json', category: ManifestCategory.DECISION, impact: 'x'.repeat(20) }],
      { generatedAt: '2026-09-13' },
    );
    assert.equal(generated.ok, true);
    if (!generated.ok) return;

    writeManifest(path, generated.manifest);

    // 无 BOM
    const bytes = readFileSync(path);
    assert.equal(
      bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf,
      false,
      '写出的清单不得带 BOM（与项目其余 JSON 保持一致）',
    );
    // 以换行结尾（便于 diff）
    assert.equal(bytes[bytes.length - 1], 0x0a);

    const readBack = parseManifest(readFileSync(path, 'utf8'));
    assert.deepEqual(readBack, generated.manifest);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('解析必须容忍 BOM（Windows 工具链常见），但生成端不写 BOM', () => {
  const manifest = {
    manifestVersion: '1.0.0',
    generatedAt: '2026-09-13',
    generator: 'test',
    exclusions: [],
    entries: [],
  };
  const withBom = `\uFEFF${JSON.stringify(manifest)}`;
  assert.doesNotThrow(() => parseManifest(withBom));
  assert.deepEqual(parseManifest(withBom), manifest);
});

test('sha256OfFile 与 Node crypto 的结果一致（防止自造哈希实现）', async () => {
  const { createHash } = await import('node:crypto');
  const absolute = `${REPOSITORY_ROOT}package.json`;
  const expected = createHash('sha256').update(readFileSync(absolute)).digest('hex');
  assert.equal(sha256OfFile(absolute).sha256, expected);
  assert.equal(sha256OfFile(absolute).bytes, readFileSync(absolute).length);
});

test('describeManifest 必须按类别汇总（便于人工看出覆盖范围）', () => {
  const generated = generateManifest(
    [
      { path: 'package.json', category: ManifestCategory.DECISION, impact: 'x'.repeat(20) },
      { path: 'tsconfig.json', category: ManifestCategory.DECISION, impact: 'x'.repeat(20) },
    ],
    { generatedAt: '2026-09-13' },
  );
  assert.equal(generated.ok, true);
  if (!generated.ok) return;

  const lines = describeManifest(generated.manifest);
  assert.ok(lines.some((l) => l.includes('DECISION: 2')), `实际：${lines.join(' / ')}`);
  assert.ok(lines.some((l) => l.includes('合计：2')));
});

/* ============================================================
 * 二、实际清单
 * ============================================================ */

test('实际清单文件存在、可解析、且校验通过', () => {
  const path = `${REPOSITORY_ROOT}${PROJECT_MANIFEST_PATH}`;
  assert.ok(existsSync(path), `${PROJECT_MANIFEST_PATH} 必须存在（运行 npm run manifest）`);

  const manifest = parseManifest(readFileSync(path, 'utf8'));
  const verdict = verifyManifest(manifest, ARTIFACT_DEFINITIONS);

  assert.deepEqual(
    verdict.issues,
    [],
    `校验失败：\n${verdict.issues.map((i) => `  [${i.kind}] ${i.message}`).join('\n')}`,
  );
});

test('实际清单必须覆盖全部六类产物', () => {
  const manifest = parseManifest(readFileSync(`${REPOSITORY_ROOT}${PROJECT_MANIFEST_PATH}`, 'utf8'));
  const categories = new Set(manifest.entries.map((e) => e.category));

  for (const category of Object.values(ManifestCategory)) {
    assert.ok(
      categories.has(category),
      `清单必须覆盖 ${category} —— 缺失意味着该类产物的变化无法被追溯`,
    );
  }
});

test('实际清单的关键产物必须被绑定（防「昨天 CALL 今天 FOLD」追不到源）', () => {
  const manifest = parseManifest(readFileSync(`${REPOSITORY_ROOT}${PROJECT_MANIFEST_PATH}`, 'utf8'));
  const paths = new Set(manifest.entries.map((e) => e.path));

  // 这四个文件是「建议为何变化」最高频的嫌疑对象
  for (const critical of [
    'src/domain/range/gameEnvironment.ts',
    'data/knowledge/strategy-rules.json',
    'src/domain/player/playerClassifier.ts',
    'src/domain/player/playerStats.ts',
  ]) {
    assert.ok(paths.has(critical), `关键产物必须被绑定：${critical}`);
  }
});

test('实际清单的每条影响说明必须具体（不得是「未知」之类占位）', () => {
  const manifest = parseManifest(readFileSync(`${REPOSITORY_ROOT}${PROJECT_MANIFEST_PATH}`, 'utf8'));
  const placeholders = ['未知', 'TODO', '待补', 'n/a', 'N/A', ''];
  for (const entry of manifest.entries) {
    assert.ok(
      !placeholders.some((p) => entry.impact.trim() === p),
      `${entry.path} 的影响说明是占位符：「${entry.impact}」`,
    );
    assert.ok(entry.impact.length >= 10, `${entry.path} 的影响说明过短：「${entry.impact}」`);
  }
});

test('定义表不得重复登记同一路径', () => {
  const seen = new Set<string>();
  for (const definition of ARTIFACT_DEFINITIONS) {
    assert.ok(!seen.has(definition.path), `定义表重复登记：${definition.path}`);
    seen.add(definition.path);
  }
});

test('实际清单的 generatedAt 必须是合法日期（便于「这是哪一版」的追溯）', () => {
  const manifest = parseManifest(readFileSync(`${REPOSITORY_ROOT}${PROJECT_MANIFEST_PATH}`, 'utf8'));
  assert.match(manifest.generatedAt, /^\d{4}-\d{2}-\d{2}/, `generatedAt 格式不正确：${manifest.generatedAt}`);
  assert.ok(manifest.generator.length > 0, '必须记录生成方式');
  assert.ok(manifest.manifestVersion.length > 0, '必须有清单版本号');
});

test('排除项必须与定义表不冲突（不得既登记又排除）', () => {
  const defined = new Set(ARTIFACT_DEFINITIONS.map((d) => d.path));
  for (const exclusion of MANIFEST_EXCLUSIONS) {
    assert.ok(
      !defined.has(exclusion.path),
      `${exclusion.path} 同时出现在定义表与排除表中 —— 语义冲突`,
    );
  }
});
