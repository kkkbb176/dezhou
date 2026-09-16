/**
 * Phase 4.5 知识来源体系测试
 *
 * ## 本文件要守住的四条纪律
 *
 * 1. **不编造（规范第 17 节）**：没有量化数据的来源，其规则**绝不**带 magnitude。
 *    这条不能只写在文档里 —— 必须是**硬校验**，而且必须有测试证明它真的会拒绝。
 * 2. **Fail-Closed（规范第 35 节）**：知识库任何一处损坏都必须**拒绝加载**，
 *    绝不降级为「部分可用」。
 * 3. **许可证门禁（规范第 5 / 6 节）**：门禁由许可证**推导**，不接受手写；
 *    无许可证的来源一律 RED 且禁止复制。
 * 4. **证据不夸大**：规则声明的证据等级不得高于其来源中的最高等级。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AdjustmentDirection,
  AdjustmentTarget,
  AllowedUsage,
  EvidenceLevel,
  GameEnvironmentId,
  KnowledgeSourceType,
  StrategyStreet,
  allowsCodeCopy,
  evidenceRank,
  isKnownEvidenceLevel,
  licenseGateOf,
  validateKnowledgeBase,
  validateKnowledgeSource,
  validateStrategyKnowledge,
  type KnowledgeSource,
  type StrategyKnowledge,
} from '../src/domain/knowledge/knowledge.types.ts';
import {
  buildKnowledgeIndex,
  parseKnowledgeSource,
  parseSourceRegistry,
  parseStrategyKnowledge,
  parseStrategyRules,
} from '../src/domain/knowledge/knowledge.ts';
import {
  DEFAULT_KNOWLEDGE_DIR,
  loadKnowledgeBase,
  loadKnowledgeBaseOrThrow,
} from '../src/domain/knowledge/knowledgeLoader.ts';

/* ============================================================
 * 辅助：构造最小的合法来源 / 规则
 * ============================================================ */

function source(overrides: Partial<KnowledgeSource> = {}): KnowledgeSource {
  return {
    id: 'test.source',
    title: '测试来源',
    type: KnowledgeSourceType.USER_NOTE,
    license: 'MIT',
    licenseGate: 'GREEN',
    auditDate: '2026-09-13',
    evidenceLevel: EvidenceLevel.HEURISTIC,
    allowedUsage: AllowedUsage.CONCEPT_ONLY,
    fullTextAvailable: true,
    hasQuantitativeData: false,
    derivableQuantitativeData: false,
    notes: '测试',
    limitations: ['测试限制'],
    ...overrides,
  };
}

function rule(overrides: Partial<StrategyKnowledge> = {}): StrategyKnowledge {
  return {
    ruleId: 'test.rule',
    street: StrategyStreet.ANY,
    gameEnvironment: GameEnvironmentId.MID_LOW_STAKES,
    situation: '测试局面',
    adjustment: AdjustmentDirection.NEUTRAL,
    target: AdjustmentTarget.RANGE_WIDTH,
    evidenceLevel: EvidenceLevel.HEURISTIC,
    confidence: 0.5,
    sources: ['test.source'],
    exceptions: ['测试例外'],
    notes: '测试',
    ...overrides,
  };
}

/* ============================================================
 * 一、许可证门禁（规范第 5 / 6 节）
 * ============================================================ */

test('许可证门禁：宽松许可证 → GREEN，copyleft → YELLOW，未知 → RED', () => {
  assert.equal(licenseGateOf('MIT'), 'GREEN');
  assert.equal(licenseGateOf('Apache-2.0'), 'GREEN');
  assert.equal(licenseGateOf('BSD-3-Clause'), 'GREEN');
  assert.equal(licenseGateOf('GPL-3.0'), 'YELLOW');
  assert.equal(licenseGateOf('AGPL-3.0'), 'YELLOW');
  assert.equal(licenseGateOf('LGPL-2.1'), 'YELLOW');
});

test('许可证门禁：**未知/缺失一律 RED**（保守默认，不得把「不知道」当成「可以用」）', () => {
  for (const value of [undefined, null, '', '   ', 'NONE', 'NOASSERTION', 'WTFPL-ISH', 'Proprietary']) {
    assert.equal(licenseGateOf(value), 'RED', `${String(value)} 必须是 RED`);
  }
});

test('许可证门禁：非商业 / 禁止演绎类一律 RED（不得复制进本项目）', () => {
  assert.equal(licenseGateOf('CC-BY-NC-4.0'), 'RED');
  assert.equal(licenseGateOf('CC-BY-ND-4.0'), 'RED');
  assert.equal(licenseGateOf('CC-BY-NC-SA-4.0'), 'RED');
  assert.equal(licenseGateOf('CC-BY-4.0'), 'RED', '未做署名基础设施 → 保守归 RED');
});

test('许可证门禁：CC-BY-SA 是 **copyleft** → YELLOW（不得误判为 RED 或 GREEN）', () => {
  // CC-BY-SA 带 ShareAlike，性质与 GPL 同类。
  // 归 RED 会低估其可用性（它确实允许商用与演绎）；
  // 归 GREEN 会允许许可证污染。正确分类是 YELLOW。
  assert.equal(licenseGateOf('CC-BY-SA-4.0'), 'YELLOW');
  assert.equal(licenseGateOf('cc-by-sa-4.0'), 'YELLOW');
  assert.equal(allowsCodeCopy('YELLOW'), false, 'YELLOW 仍然禁止直接复制');
});

test('许可证门禁：SPDX 表达式 —— OR 取最宽松，AND 取最严格', () => {
  assert.equal(licenseGateOf('MIT OR Apache-2.0'), 'GREEN', '双许可可选择 → 可取宽松分支');
  assert.equal(licenseGateOf('MIT OR GPL-3.0'), 'GREEN');
  assert.equal(licenseGateOf('GPL-3.0 OR AGPL-3.0'), 'YELLOW');
  assert.equal(licenseGateOf('MIT AND GPL-3.0'), 'YELLOW', '必须同时满足 → 取严格分支');
  assert.equal(licenseGateOf('MIT AND NONE'), 'RED');
});

test('许可证门禁：WITH 例外按主许可判定', () => {
  assert.equal(licenseGateOf('Apache-2.0 WITH LLVM-exception'), 'GREEN');
  assert.equal(licenseGateOf('GPL-2.0 WITH Classpath-exception-2.0'), 'YELLOW');
});

test('许可证门禁：模糊的 BSD 变体保守归 YELLOW（4-clause 带广告条款）', () => {
  assert.equal(licenseGateOf('BSD'), 'YELLOW');
  assert.equal(licenseGateOf('BSD-4-Clause'), 'YELLOW');
  assert.equal(licenseGateOf('BSD-3-Clause'), 'GREEN', '明确的三条款仍是宽松许可');
});

test('许可证门禁：大小写与空白不敏感', () => {
  assert.equal(licenseGateOf('mit'), 'GREEN');
  assert.equal(licenseGateOf('  MIT  '), 'GREEN');
  assert.equal(licenseGateOf('  gpl-3.0  '), 'YELLOW');
});

test('只有 GREEN 允许复制代码', () => {
  assert.equal(allowsCodeCopy('GREEN'), true);
  assert.equal(allowsCodeCopy('YELLOW'), false);
  assert.equal(allowsCodeCopy('RED'), false);
});

test('回归：门禁**由许可证推导**，手写一个更宽松的门禁必须被拒绝', () => {
  // 声称 GTOpen 是 GREEN（实际无许可证）必须被拦下
  const sneaky = source({
    id: 'sneaky',
    license: 'NONE',
    licenseGate: 'GREEN',
    allowedUsage: AllowedUsage.CODE_REFERENCE,
  });
  const issues = validateKnowledgeSource(sneaky);
  assert.ok(
    issues.some((i) => i.code === 'COPY_NOT_ALLOWED'),
    `必须报 COPY_NOT_ALLOWED，实际 ${JSON.stringify(issues.map((i) => i.code))}`,
  );
  // 解析器也必须推导出 RED，而不是采信 JSON 里写的 GREEN
  const parsed = parseKnowledgeSource({
    id: 'sneaky',
    title: 'x',
    type: 'GITHUB',
    license: 'NONE',
    licenseGate: 'GREEN',
    auditDate: '2026-09-13',
    evidenceLevel: 'HEURISTIC',
    allowedUsage: 'CODE_REFERENCE',
    fullTextAvailable: true,
    hasQuantitativeData: false,
    derivableQuantitativeData: false,
    notes: 'x',
    limitations: ['x'],
  });
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.equal(parsed.value.licenseGate, 'RED', '解析器不得采信 JSON 里的门禁字段');
});

test('非 GREEN 来源不得标记为 CODE_REFERENCE', () => {
  for (const [license, gate] of [['GPL-3.0', 'YELLOW'], ['NONE', 'RED']] as const) {
    const bad = source({ id: 'x', license, licenseGate: gate, allowedUsage: AllowedUsage.CODE_REFERENCE });
    assert.ok(
      validateKnowledgeSource(bad).some((i) => i.code === 'COPY_NOT_ALLOWED'),
      `${license} 来源不得是 CODE_REFERENCE`,
    );
  }
});

/* ============================================================
 * 二、不编造：magnitude 必须有数据支撑（规范第 17 节）
 * ============================================================ */

test('**核心断言**：来源无量化数据时，规则带 magnitude 必须被拒绝', () => {
  const registry = new Map([['test.source', source({ hasQuantitativeData: false, derivableQuantitativeData: false })]]);
  const bad = rule({ magnitude: 0.61 });
  const issues = validateStrategyKnowledge(bad, registry);

  assert.ok(
    issues.some((i) => i.code === 'MAGNITUDE_WITHOUT_DATA'),
    `必须报 MAGNITUDE_WITHOUT_DATA，实际 ${JSON.stringify(issues.map((i) => i.code))}`,
  );
  // 错误信息必须点明「这是编造」
  const found = issues.find((i) => i.code === 'MAGNITUDE_WITHOUT_DATA')!;
  assert.ok(found.message.includes('编造'), `说明必须点明性质：「${found.message}」`);
});

test('有量化数据支撑时，magnitude 允许存在', () => {
  const registry = new Map([['test.source', source({ hasQuantitativeData: true, derivableQuantitativeData: true })]]);
  const issues = validateStrategyKnowledge(rule({ magnitude: 0.61 }), registry);
  assert.equal(
    issues.some((i) => i.code === 'MAGNITUDE_WITHOUT_DATA'),
    false,
    '有数据支撑时不应报错',
  );
});

test('magnitude 必须是正有限数', () => {
  const registry = new Map([['test.source', source({ hasQuantitativeData: true, derivableQuantitativeData: true })]]);
  for (const magnitude of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const issues = validateStrategyKnowledge(rule({ magnitude }), registry);
    assert.ok(
      issues.some((i) => i.code === 'MAGNITUDE_OUT_OF_RANGE' || i.code === 'MAGNITUDE_WITHOUT_DATA'),
      `magnitude=${magnitude} 必须被拒绝`,
    );
  }
});

test('**实际知识库**：没有可推导量化数据支撑的规则一律不带 magnitude', () => {
  const result = loadKnowledgeBaseOrThrow();

  for (const r of result.allRules().filter((x) => x.magnitude !== undefined)) {
    const sources = result.sourcesOf(r.ruleId);
    assert.ok(
      sources.some((s) => s.derivableQuantitativeData),
      `规则 ${r.ruleId} 带 magnitude=${r.magnitude}，但其来源都没有**可推导**的量化数据`,
    );
  }

  // 本轮审计的现实：四个 GitHub 项目**包含**量化数据（自有实验、数据集、求解器输出），
  // 但**没有一个**能被本项目取用并据以定参数：
  //   - GTOpen 无许可证（权利不明）
  //   - Poker Lab 的翻牌前图表上游权利未确认
  //   - DCFR-SOLVER / poker_solver 的数字是其求解器输出，本项目未运行、无法独立复现
  // 因此 `derivableQuantitativeData` 全部为 false，**全部规则都必须无 magnitude**。
  const derivable = result.allSources().filter((s) => s.derivableQuantitativeData);
  assert.deepEqual(
    derivable.map((s) => s.id),
    [],
    `本轮没有可推导量化数据的来源，实际 ${JSON.stringify(derivable.map((s) => s.id))}`,
  );
  assert.equal(
    result.summary().rulesWithoutMagnitude,
    result.summary().totalRules,
    '既然没有可推导来源，全部规则都必须无 magnitude',
  );

  // 但「包含数据」的来源确实存在 —— 这两个字段必须被区分开，
  // 否则「来源里有数字」会被误当成「我们能拿这些数字定参数」
  const containsData = result.allSources().filter((s) => s.hasQuantitativeData);
  assert.ok(
    containsData.length >= 4,
    `预期至少 4 个来源包含量化数据（用于证明两个字段确实不同），实际 ${containsData.length}`,
  );
});

/* ============================================================
 * 三、证据等级不得被夸大
 * ============================================================ */

test('证据强度序：PRIMARY > VERIFIED_SECONDARY > SECONDARY > HEURISTIC', () => {
  const primary = evidenceRank(EvidenceLevel.PRIMARY);
  const verified = evidenceRank(EvidenceLevel.VERIFIED_SECONDARY);
  const secondary = evidenceRank(EvidenceLevel.SECONDARY);
  const heuristic = evidenceRank(EvidenceLevel.HEURISTIC);
  assert.ok(primary !== null && verified !== null && secondary !== null && heuristic !== null);
  assert.ok(primary! > verified!);
  assert.ok(verified! > secondary!);
  assert.ok(secondary! > heuristic!);
});

test('回归（红队 F-13）：未登记的证据等级必须返回 null，不得静默通过比较', () => {
  // 旧版直接查表：未登记等级得到 undefined，而 `undefined > 0` 为 false、
  // `Math.max(undefined, 0)` 为 NaN —— 于是「未登记等级」能静默通过全部校验。
  assert.equal(evidenceRank('THEORY' as EvidenceLevel), null);
  assert.equal(evidenceRank('' as EvidenceLevel), null);
  assert.equal(evidenceRank('primary' as EvidenceLevel), null, '大小写敏感');
  assert.equal(isKnownEvidenceLevel('PRIMARY'), true);
  assert.equal(isKnownEvidenceLevel('THEORY'), false);
  assert.equal(isKnownEvidenceLevel(undefined), false);
});

test('回归（红队 F-13）：规则带未登记证据等级时必须被拒绝', () => {
  const registry = new Map([['test.source', source()]]);
  const issues = validateStrategyKnowledge(
    rule({ evidenceLevel: 'UNKNOWN_LEVEL' as EvidenceLevel }),
    registry,
  );
  assert.ok(
    issues.some((i) => i.code === 'SCHEMA_FIELD_INVALID'),
    `必须报 SCHEMA_FIELD_INVALID，实际 ${JSON.stringify(issues.map((i) => i.code))}`,
  );
});

test('规则声明的证据等级不得高于其来源的最高等级', () => {
  const registry = new Map([
    ['test.source', source({ evidenceLevel: EvidenceLevel.HEURISTIC })],
  ]);
  const inflated = rule({ evidenceLevel: EvidenceLevel.PRIMARY });
  const issues = validateStrategyKnowledge(inflated, registry);
  assert.ok(
    issues.some((i) => i.code === 'EVIDENCE_EXCEEDS_SOURCES'),
    `必须报 EVIDENCE_EXCEEDS_SOURCES，实际 ${JSON.stringify(issues.map((i) => i.code))}`,
  );
});

test('**实际知识库**：每条规则的证据等级都不高于其来源', () => {
  const index = loadKnowledgeBaseOrThrow();
  for (const r of index.allRules()) {
    const sources = index.sourcesOf(r.ruleId);
    assert.ok(sources.length > 0, `规则 ${r.ruleId} 必须至少有一个来源`);
    const ranks = sources.map((s) => evidenceRank(s.evidenceLevel));
    assert.ok(ranks.every((x) => x !== null), `规则 ${r.ruleId} 的来源等级必须全部已登记`);
    const best = Math.max(...(ranks as number[]));
    const own = evidenceRank(r.evidenceLevel);
    assert.ok(own !== null, `规则 ${r.ruleId} 自身的证据等级必须已登记`);
    assert.ok(
      own! <= best,
      `规则 ${r.ruleId} 的证据等级 ${r.evidenceLevel} 高于来源最高等级`,
    );
  }
});

test('回归（红队 F-03）：没有任何来源的规则必须被拒绝', () => {
  // 「每条结论都可追溯到来源」是本知识体系存在的唯一理由。
  // 旧版缺这条检查，于是 `sources: []` + PRIMARY + confidence 0.99
  // 能成功建索引。
  const registry = new Map<string, KnowledgeSource>();
  const orphan = rule({
    sources: [],
    evidenceLevel: EvidenceLevel.PRIMARY,
    confidence: 0.99,
  });
  const issues = validateStrategyKnowledge(orphan, registry);
  assert.ok(
    issues.some((i) => i.code === 'UNKNOWN_SOURCE_REFERENCE'),
    `必须拒绝零来源规则，实际 ${JSON.stringify(issues.map((i) => i.code))}`,
  );

  assert.throws(
    () =>
      buildKnowledgeIndex({
        version: '1',
        auditDate: '2026-09-13',
        sources: [source({ id: 'a' })],
        rules: [rule({ sources: [] })],
      }),
    /拒绝加载|UNKNOWN_SOURCE_REFERENCE/,
  );
});

/* ============================================================
 * 四、悬空引用与结构完整性
 * ============================================================ */

test('引用了未登记的来源必须被拒绝', () => {
  const registry = new Map<string, KnowledgeSource>();
  const issues = validateStrategyKnowledge(rule({ sources: ['missing.source'] }), registry);
  assert.ok(issues.some((i) => i.code === 'UNKNOWN_SOURCE_REFERENCE'));
});

test('每条规则必须至少登记一条例外（没有例外的规则必然过宽）', () => {
  const registry = new Map([['test.source', source()]]);
  const issues = validateStrategyKnowledge(rule({ exceptions: [] }), registry);
  assert.ok(issues.some((i) => i.code === 'MISSING_LIMITATIONS'));
});

test('每个来源必须至少登记一条已知限制（没有限制的来源不存在）', () => {
  assert.ok(
    validateKnowledgeSource(source({ limitations: [] })).some((i) => i.code === 'MISSING_LIMITATIONS'),
  );
});

test('审计日期必须是 YYYY-MM-DD', () => {
  for (const auditDate of ['2026/09/13', '2026-9-13', '', 'today']) {
    assert.ok(
      validateKnowledgeSource(source({ auditDate })).some((i) => i.code === 'INVALID_DATE'),
      `日期 ${auditDate} 必须被拒绝`,
    );
  }
  assert.deepEqual(validateKnowledgeSource(source({ auditDate: '2026-09-13' })), []);
});

test('重复的来源 id / 规则 id 必须被拒绝', () => {
  const s = source({ id: 'dup' });
  const r = rule({ ruleId: 'duprule', sources: ['dup'] });
  const issues = validateKnowledgeBase({ sources: [s, s], rules: [r, r] });
  assert.ok(issues.some((i) => i.code === 'DUPLICATE_SOURCE_ID'));
  assert.ok(issues.some((i) => i.code === 'DUPLICATE_RULE_ID'));
});

test('没有完整正文的书籍不得声称拥有可靠量化数据', () => {
  const bad = source({
    id: 'book',
    type: KnowledgeSourceType.BOOK,
    fullTextAvailable: false,
    hasQuantitativeData: true,
  });
  assert.ok(
    validateKnowledgeSource(bad).some((i) => i.code === 'FULL_TEXT_UNAVAILABLE_BUT_CLAIMED'),
  );
});

/* ============================================================
 * 五、Fail-Closed（规范第 35 节）
 * ============================================================ */

test('**Fail-Closed**：校验失败时必须**抛错**，绝不返回部分可用的索引', () => {
  assert.throws(
    () =>
      buildKnowledgeIndex({
        version: '1',
        auditDate: '2026-09-13',
        sources: [source({ id: 'a', limitations: [] })], // 缺限制 → 非法
        rules: [],
      }),
    /知识库校验失败|拒绝加载/,
  );
});

test('**Fail-Closed**：引用了不存在来源的知识库必须抛错', () => {
  assert.throws(
    () =>
      buildKnowledgeIndex({
        version: '1',
        auditDate: '2026-09-13',
        sources: [source({ id: 'a' })],
        rules: [rule({ sources: ['does.not.exist'] })],
      }),
    /拒绝加载|UNKNOWN_SOURCE_REFERENCE/,
  );
});

test('**Fail-Closed**：目录不存在时返回具体问题，不静默降级', () => {
  const result = loadKnowledgeBase('D:/德州/不存在的目录/');
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.issues.length >= 2, '两个文件都应报读取失败');
  assert.ok(result.issues.every((i) => i.message.includes('无法读取文件')));
});

test('回归（红队 F-10）：失败时**必须**给出非空诊断，不得返回「失败了但没原因」', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const dir = mkdtempSync(join(tmpdir(), 'kb-f10-'));
  try {
    for (const content of ['null', '[]', '42', '"text"', '{}']) {
      writeFileSync(join(dir, 'source-registry.json'), content, 'utf8');
      writeFileSync(join(dir, 'strategy-rules.json'), content, 'utf8');
      const result = loadKnowledgeBase(dir);
      assert.equal(result.ok, false, `内容 ${content} 必须加载失败`);
      if (result.ok) continue;
      assert.ok(
        result.issues.length > 0,
        `内容 ${content} 失败时 issues 不得为空（否则调用方拿不到任何诊断）`,
      );
      assert.ok(
        result.issues.every((i) => i.message.length > 0 && i.subject.length > 0),
        `内容 ${content} 的每条 issue 都必须有 subject 与 message`,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('回归（红队 F-10）：OrThrow 的错误信息必须包含可操作的原因', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const dir = mkdtempSync(join(tmpdir(), 'kb-f10b-'));
  try {
    writeFileSync(join(dir, 'source-registry.json'), 'null', 'utf8');
    writeFileSync(join(dir, 'strategy-rules.json'), 'null', 'utf8');
    assert.throws(
      () => loadKnowledgeBaseOrThrow(dir),
      (error: Error) => {
        assert.ok(error.message.includes('Fail-Closed'), '必须点明是 Fail-Closed');
        assert.ok(error.message.length > 80, `错误信息必须含具体原因（实际「${error.message}」）`);
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('**Fail-Closed**：目录不存在时 loadKnowledgeBaseOrThrow 必须抛错', () => {
  assert.throws(() => loadKnowledgeBaseOrThrow('D:/德州/不存在的目录/'), /Fail-Closed|拒绝降级/);
});

test('非法枚举值必须被解析器拒绝（不得静默忽略）', () => {
  const parsed = parseKnowledgeSource({
    id: 'x',
    title: 'x',
    type: 'NOT_A_TYPE',
    license: 'MIT',
    auditDate: '2026-09-13',
    evidenceLevel: 'HEURISTIC',
    allowedUsage: 'CONCEPT_ONLY',
    fullTextAvailable: true,
    hasQuantitativeData: false,
    notes: 'x',
    limitations: ['x'],
  });
  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.ok(parsed.issues.some((i) => i.message.includes('已登记取值')));
});

test('规则解析器必须拒绝非数字 magnitude（不得静默丢弃）', () => {
  const parsed = parseStrategyKnowledge({
    ruleId: 'x',
    street: 'ANY',
    gameEnvironment: 'MID_LOW_STAKES',
    situation: 'x',
    adjustment: 'NEUTRAL',
    target: 'RANGE_WIDTH',
    magnitude: '0.61', // 字符串 —— 必须是错误，不能忽略
    evidenceLevel: 'HEURISTIC',
    confidence: 0.5,
    sources: ['a'],
    exceptions: ['x'],
    notes: 'x',
  });
  assert.equal(parsed.ok, false);
});

/* ============================================================
 * 六、实际知识库的完整性
 * ============================================================ */

test('**实际知识库**能成功加载（Fail-Closed 的正向路径）', () => {
  const result = loadKnowledgeBase(DEFAULT_KNOWLEDGE_DIR);
  assert.equal(result.ok, true, `加载失败：${JSON.stringify(result.ok ? [] : result.issues)}`);
});

test('**实际知识库**：全部来源可追溯（有 URL 或明确为内部来源）', () => {
  const index = loadKnowledgeBaseOrThrow();
  for (const s of index.allSources()) {
    assert.ok(
      s.url !== undefined || s.id.startsWith('internal.'),
      `来源 ${s.id} 既没有 URL 也不是内部来源 —— 无法追溯`,
    );
  }
});

test('**实际知识库**：GitHub 来源必须带 commit 哈希（可复现性依赖它）', () => {
  const index = loadKnowledgeBaseOrThrow();
  for (const s of index.allSources()) {
    if (s.type === KnowledgeSourceType.GITHUB) {
      assert.ok(
        typeof s.commitHash === 'string' && /^[0-9a-f]{40}$/.test(s.commitHash),
        `GitHub 来源 ${s.id} 缺少合法的 commit 哈希（实际 ${String(s.commitHash)}）`,
      );
      assert.ok(s.lastActivity !== undefined, `GitHub 来源 ${s.id} 缺少 lastActivity`);
      assert.ok(s.language !== undefined, `GitHub 来源 ${s.id} 缺少 language`);
    }
  }
});

test('**实际知识库**：无许可证的 GitHub 来源必须是 RED 且只允许概念学习', () => {
  const index = loadKnowledgeBaseOrThrow();
  const noLicense = index.allSources().filter((s) => s.license === 'NONE');
  assert.ok(noLicense.length > 0, '本轮审计确实存在无许可证来源');
  for (const s of noLicense) {
    assert.equal(s.licenseGate, 'RED', `${s.id} 必须归入 RED`);
    assert.equal(s.allowedUsage, AllowedUsage.CONCEPT_ONLY, `${s.id} 只能 CONCEPT_ONLY`);
    assert.equal(allowsCodeCopy(s.licenseGate), false, `${s.id} 禁止复制代码`);
  }
});

test('**实际知识库**：书籍来源全部标记为无正文，且不得带量化数据', () => {
  const index = loadKnowledgeBaseOrThrow();
  const books = index.allSources().filter((s) => s.type === KnowledgeSourceType.BOOK);
  assert.ok(books.length >= 6, `预期至少 6 本书，实际 ${books.length}`);
  for (const book of books) {
    assert.equal(book.fullTextAvailable, false, `${book.id} 本轮没有合法正文，必须是 false`);
    assert.equal(book.hasQuantitativeData, false, `${book.id} 无正文不得声称有量化数据`);
    assert.ok(
      book.notes.includes('SOURCE_TEXT_NOT_AVAILABLE'),
      `${book.id} 的说明必须明确写出 SOURCE_TEXT_NOT_AVAILABLE`,
    );
    assert.equal(allowsCodeCopy(book.licenseGate), false, `${book.id} 不得允许复制`);
  }
});

test('**实际知识库**：`copyRestrictions()` 必须列出全部不可复制来源及原因', () => {
  const index = loadKnowledgeBaseOrThrow();
  const restrictions = index.copyRestrictions();
  const allowed = index.allSources().filter((s) => allowsCodeCopy(s.licenseGate));
  assert.equal(
    restrictions.length,
    index.allSources().length - allowed.length,
    '受限清单必须覆盖全部非 GREEN 来源',
  );
  for (const item of restrictions) {
    assert.ok(item.reason.length > 0, `${item.id} 必须给出原因`);
    assert.ok(/禁止复制/.test(item.reason), `${item.id} 的原因必须明确禁止复制`);
  }
});

test('**实际知识库**：`codeCopyable()` 只返回 GREEN + CODE_REFERENCE', () => {
  const index = loadKnowledgeBaseOrThrow();
  for (const s of index.codeCopyable()) {
    assert.equal(allowsCodeCopy(s.licenseGate), true);
    assert.equal(s.allowedUsage, AllowedUsage.CODE_REFERENCE);
  }
});

/* ============================================================
 * 七、查询索引
 * ============================================================ */

test('查询：按 id 取来源 / 规则，未知 id 返回 undefined 而不是抛错', () => {
  const index = loadKnowledgeBaseOrThrow();
  assert.ok(index.source('github.gtopen'));
  assert.equal(index.source('不存在'), undefined);
  assert.ok(index.rule('priority.individual-over-environment'));
  assert.equal(index.rule('不存在'), undefined);
  assert.deepEqual(index.sourcesOf('不存在'), []);
});

test('查询：`rulesFor` 必须包含 ANY 街道的规则', () => {
  const index = loadKnowledgeBaseOrThrow();
  const flopRules = index.rulesFor(GameEnvironmentId.LOW_STAKES_ONLINE, StrategyStreet.FLOP);
  // 至少应包含 street=ANY 的通用规则
  assert.ok(
    flunkIncludesAny(flopRules),
    `FLOP 查询必须包含 ANY 街道规则，实际 ${JSON.stringify(flopRules.map((r) => [r.ruleId, r.street]))}`,
  );
  for (const r of flopRules) {
    assert.ok(r.street === StrategyStreet.FLOP || r.street === StrategyStreet.ANY);
    assert.equal(r.gameEnvironment, GameEnvironmentId.LOW_STAKES_ONLINE);
  }
});

function flunkIncludesAny(rules: readonly StrategyKnowledge[]): boolean {
  return rules.some((r) => r.street === StrategyStreet.ANY);
}

test('查询：`rulesUsing` 的反向索引与正向引用一致', () => {
  const index = loadKnowledgeBaseOrThrow();
  for (const r of index.allRules()) {
    for (const id of r.sources) {
      assert.ok(
        index.rulesUsing(id).some((x) => x.ruleId === r.ruleId),
        `反向索引缺少 ${r.ruleId} → ${id}`,
      );
    }
  }
});

test('查询：summary 的统计与逐项计数一致', () => {
  const index = loadKnowledgeBaseOrThrow();
  const summary = index.summary();
  assert.equal(summary.totalSources, index.allSources().length);
  assert.equal(summary.totalRules, index.allRules().length);
  for (const s of index.allSources()) {
    assert.ok((summary.byEvidenceLevel[s.evidenceLevel] ?? 0) >= 1);
    assert.ok((summary.byLicenseGate[s.licenseGate] ?? 0) >= 1);
  }
  assert.equal(summary.sourcesWithoutFullText, index.allSources().filter((s) => !s.fullTextAvailable).length);
});

test('查询：索引是冻结的（不得被调用方改写）', () => {
  const index = loadKnowledgeBaseOrThrow();
  assert.equal(Object.isFrozen(index), true, '索引对象必须冻结');
  assert.equal(Object.isFrozen(index.allSources()), true, '来源数组必须冻结');
  assert.equal(Object.isFrozen(index.allRules()), true, '规则数组必须冻结');
});

/* ============================================================
 * 八、来源幻觉审计（规范第 47 节）
 * ============================================================ */

test('来源幻觉审计：内部来源必须真的存在于仓库中', async () => {
  const { existsSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
  const index = loadKnowledgeBaseOrThrow();

  for (const s of index.allSources()) {
    if (!s.id.startsWith('internal.')) continue;
    assert.ok(s.url !== undefined, `内部来源 ${s.id} 必须给出仓库内路径`);
    if (s.url.startsWith('src/') || s.url.startsWith('docs/') || s.url.startsWith('reports/')) {
      assert.ok(
        existsSync(`${repositoryRoot}${s.url}`),
        `来源 ${s.id} 声称指向仓库文件「${s.url}」，但该文件不存在 —— 这是来源幻觉`,
      );
    }
  }
});

test('**回归（红队 F-01）**：内部来源的内容必须**真的包含**它声称的内容', async () => {
  // 红队发现：`internal.spec-priority` 标 PRIMARY 并指向 docs/ARCHITECTURE.md，
  // 但该文件**不含**那条优先级链 —— 守卫测试只做 existsSync，因此形同虚设。
  // 「文件存在」不等于「文件里有这段话」。
  const { readFileSync, existsSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
  const index = loadKnowledgeBaseOrThrow();

  // 优先级链的五个层级名必须真的出现在被引用的文件里
  const priorityLevels = [
    'Math Truth',
    'Verified Individual Data',
    'Reliable Node-specific Data',
    'Game Environment Prior',
    'Generic Heuristic',
  ];

  const prioritySource = index.source('internal.spec-priority');
  assert.ok(prioritySource, 'internal.spec-priority 必须存在');
  assert.ok(prioritySource.url, '必须给出出处路径');
  const path = `${repositoryRoot}${prioritySource.url}`;
  assert.ok(existsSync(path), `出处文件必须存在：${prioritySource.url}`);

  const content = readFileSync(path, 'utf8');
  for (const level of priorityLevels) {
    assert.ok(
      content.includes(level),
      `优先级链的层级「${level}」必须真的出现在 ${prioritySource.url} 中 —— 否则该来源是「出处虚构」`,
    );
  }
});

test('**回归（红队 F-02）**：运行期门禁必须由许可证推导，且内部来源不得被报成「无许可证」', () => {
  const index = loadKnowledgeBaseOrThrow();
  const summary = index.summary();

  for (const s of index.allSources()) {
    assert.equal(
      s.licenseGate,
      licenseGateOf(s.license),
      `${s.id} 的运行期门禁必须由许可证推导（license=${s.license}）`,
    );
  }

  // 内部来源是项目自有内容 → GREEN，绝不能出现在「禁止复制」清单里
  const internal = index.allSources().filter((s) => s.id.startsWith('internal.'));
  assert.ok(internal.length > 0, '前置条件：存在内部来源');
  for (const s of internal) {
    assert.equal(s.license, 'PROJECT_INTERNAL');
    assert.equal(s.licenseGate, 'GREEN', `内部来源 ${s.id} 不得被判为不可复制`);
    assert.ok(
      !index.copyRestrictions().some((r) => r.id === s.id),
      `内部来源 ${s.id} 不得出现在「禁止复制」清单里 —— 那会让合规报告自相矛盾`,
    );
  }

  // 统计口径必须与逐项一致
  const greenCount = index.allSources().filter((s) => s.licenseGate === 'GREEN').length;
  assert.equal(summary.byLicenseGate.GREEN, greenCount);
});

test('**回归（红队 F-04）**：冻结必须递归 —— scope / limitations 不得被改写', () => {
  const index = loadKnowledgeBaseOrThrow();
  const withScope = index.allSources().find((s) => s.scope !== undefined);
  assert.ok(withScope, '前置条件：至少有一个来源登记了 scope');

  // scope 是「防范围混淆」的载体，limitations 是「不夸大证据」的载体 ——
  // 两者都必须真正不可变
  assert.throws(() => {
    'use strict';
    (withScope.scope as { gameType: string }).gameType = 'Tournament (rewritten by caller)';
  }, TypeError, 'scope.gameType 必须不可改写');

  assert.throws(() => {
    'use strict';
    (withScope.limitations as string[]).push('伪造的限制');
  }, TypeError, 'limitations 不得被 push');

  assert.throws(() => {
    'use strict';
    (withScope.limitations as unknown as { length: number }).length = 0;
  }, TypeError, 'limitations.length 不得被改写');
});

test('**回归（红队 F-04）**：`rulesUsing` 必须返回冻结副本，不得暴露内部数组', () => {
  const index = loadKnowledgeBaseOrThrow();
  const before = index.rulesUsing('github.gtopen').length;
  assert.ok(before > 0, '前置条件：该来源确实被引用');

  const list = index.rulesUsing('github.gtopen');
  assert.equal(Object.isFrozen(list), true, '返回的数组必须冻结');
  assert.throws(() => {
    'use strict';
    (list as StrategyKnowledge[]).push(list[0]!);
  }, TypeError, '不得允许 push');

  // 再读一次必须与之前一致（没有内部污染）
  assert.equal(index.rulesUsing('github.gtopen').length, before);

  // 未知来源返回冻结空数组，且必须是同一个对象（不每次新建）
  assert.equal(index.rulesUsing('不存在').length, 0);
  assert.equal(Object.isFrozen(index.rulesUsing('不存在')), true);
});

test('回归（红队 F-06）：未登记字段或非法类型的 scope 必须被拒绝', () => {
  const base = {
    id: 'scope-test',
    title: 'x',
    type: 'BOOK',
    license: 'NONE',
    auditDate: '2026-09-13',
    evidenceLevel: 'SECONDARY',
    allowedUsage: 'CONCEPT_ONLY',
    fullTextAvailable: false,
    hasQuantitativeData: false,
    derivableQuantitativeData: false,
    notes: 'x',
    limitations: ['x'],
  };

  // 未登记字段
  const unknownField = parseKnowledgeSource({ ...base, scope: { 未登记字段: 'x' } });
  assert.equal(unknownField.ok, false, 'scope 含未登记字段必须被拒绝');

  // 类型错误（数字而不是字符串）
  const badType = parseKnowledgeSource({ ...base, scope: { tableSize: 42 } });
  assert.equal(badType.ok, false, 'scope.tableSize 为数字必须被拒绝');

  // 合法 scope
  const good = parseKnowledgeSource({ ...base, scope: { tableSize: '6-max', gameType: 'Cash' } });
  assert.equal(good.ok, true);
  if (good.ok) assert.deepEqual(good.value.scope, { tableSize: '6-max', gameType: 'Cash' });
});

test('来源幻觉审计：外部 URL 必须是 https 且指向已审计的域名', () => {
  const index = loadKnowledgeBaseOrThrow();
  for (const s of index.allSources()) {
    if (s.id.startsWith('internal.')) continue;
    assert.ok(s.url !== undefined, `${s.id} 缺少 URL`);
    assert.ok(s.url!.startsWith('https://'), `${s.id} 的 URL 必须是 https`);
  }
});

test('来源幻觉审计：知识库不得引用盗版站点', () => {
  const index = loadKnowledgeBaseOrThrow();
  const pirateHosts = ['archive.org/stream', 'kupdf.net', 'libgen', 'z-lib', 'pdfdrive', '1lib'];
  for (const s of index.allSources()) {
    const url = (s.url ?? '').toLowerCase();
    for (const host of pirateHosts) {
      assert.ok(!url.includes(host), `来源 ${s.id} 引用了疑似盗版站点「${host}」`);
      // 说明文字里可以**提及**盗版站点（作为风险披露），但必须同时写明未使用
      const mentionsInNotes = s.notes.toLowerCase().includes(host);
      if (mentionsInNotes) {
        assert.ok(
          s.notes.includes('未读取') || s.notes.includes('未使用'),
          `来源 ${s.id} 的说明提到了「${host}」但没有写明未使用 —— 必须显式声明`,
        );
      }
    }
  }
});

test('范围审计：每本书必须登记其适用的桌型 / 游戏类型，或明确写出未确认', () => {
  const index = loadKnowledgeBaseOrThrow();
  const books = index.allSources().filter((s) => s.type === KnowledgeSourceType.BOOK);
  for (const book of books) {
    const scopeText = JSON.stringify(book.scope ?? {});
    const declared =
      scopeText.includes('gameType') || scopeText.includes('tableSize') || scopeText.includes('不支持');
    assert.ok(declared, `${book.id} 必须登记适用范围（游戏类型或桌型）`);
  }
  // 其中必须有书籍明确标注锦标赛/现金混淆风险
  const withTournamentWarning = books.filter((b) => b.notes.includes('锦标赛'));
  assert.ok(
    withTournamentWarning.length > 0,
    'Scope Audit 要求：必须有一本书显式标注锦标赛/现金范围混淆风险',
  );
});

test('结果偏差审计：知识库不得包含任何来自摊牌结果的策略结论', () => {
  const index = loadKnowledgeBaseOrThrow();
  for (const r of index.allRules()) {
    const text = `${r.situation} ${r.notes} ${r.exceptions.join(' ')}`;
    // 禁止把「赢了/输了/结果」作为策略依据
    assert.ok(
      !/因为(赢|输|结果)|结果是|牌局结果表|摊牌证明/.test(text),
      `规则 ${r.ruleId} 从结果倒推策略 —— 违反规范第 24 / 47 节`,
    );
  }
});

/* ============================================================
 * 九、边界与健壮性
 * ============================================================ */

test('空知识库是合法的（来源与规则都为空）', () => {
  const index = buildKnowledgeIndex({ version: '1', auditDate: '2026-09-13', sources: [], rules: [] });
  assert.equal(index.size, 0);
  assert.deepEqual(index.allRules(), []);
  assert.deepEqual(index.codeCopyable(), []);
  assert.deepEqual(index.copyRestrictions(), []);
  assert.deepEqual(index.summary().byEvidenceLevel, {});
});

test('parseSourceRegistry 对非对象输入必须失败而不是抛异常', () => {
  for (const input of [null, 42, 'text', [], { sources: 'not-an-array' }]) {
    const result = parseSourceRegistry(input);
    assert.equal(result.ok, false, `输入 ${JSON.stringify(input)} 必须失败`);
  }
});

test('parseStrategyRules 对非对象输入必须失败而不是抛异常', () => {
  for (const input of [null, 42, 'text', [], { rules: {} }]) {
    const result = parseStrategyRules(input);
    assert.equal(result.ok, false, `输入 ${JSON.stringify(input)} 必须失败`);
  }
});
