/**
 * 产物清单与字节级校验（Phase 4.5 红队 F-00 的产物，已提升为**全项目通用标准**）
 *
 * ## 它解决什么问题
 *
 * 当出现「昨天建议 CALL、今天同一手牌建议 FOLD」时，必须能回答：
 * **究竟是哪一个版本发生了变化？**
 *
 * 没有字节级绑定，这个问题无法回答 —— 因为「代码没改」是一个印象，
 * 不是一个可验证的事实。
 *
 * ## 三条设计纪律
 *
 * 1. **不进决策热路径**（规范第 41 / 42 节）。
 *    生成与校验都是一次性离线操作。决策路径**绝不**读清单。
 * 2. **清单描述的是「当前应该是什么」，不是「曾经是什么」**。
 *    有意修改后必须重新生成；忘记重新生成会让测试失败 —— 这是**预期的**，
 *    因为「改了东西却没更新清单」正是这个机制要暴露的事。
 * 3. **不计入清单自身的哈希**。清单无法包含自己的哈希（自指）。
 *    因此 `VERIFY_EXCLUDED` 显式列出被排除的文件，而不是静默跳过。
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/* ============================================================
 * 类型
 * ============================================================ */

/**
 * 产物类别。
 *
 * 每一类都对应一个**真实存在变更风险**的东西：
 * 参数被调、模型被换、报告被改，都会改变建议。
 */
export const ManifestCategory = {
  /** 知识层（来源注册表、策略规则、政策文件） */
  KNOWLEDGE: 'KNOWLEDGE',
  /** 范围数据（含来源元数据） */
  RANGE: 'RANGE',
  /** 环境参数（三种模式的调整因子） */
  ENVIRONMENT: 'ENVIRONMENT',
  /** 玩家画像相关（模型版本、衰减参数等） */
  PLAYER_MODEL: 'PLAYER_MODEL',
  /** 决策引擎关键常量 */
  DECISION: 'DECISION',
  /** 外部知识与红队报告 */
  REPORT: 'REPORT',
} as const;
export type ManifestCategory = (typeof ManifestCategory)[keyof typeof ManifestCategory];

export type ArtifactEntry = {
  /** 仓库相对路径（POSIX 分隔符） */
  path: string;
  category: ManifestCategory;
  sha256: string;
  /** 字节数（便于快速判断变化规模） */
  bytes: number;
  /** 中文：这个文件一旦变化会影响什么 */
  impact: string;
};

export type ArtifactManifest = {
  manifestVersion: string;
  generatedAt: string;
  /** 生成方式说明（可复现性） */
  generator: string;
  /** 被排除的文件及原因（例如清单自身） */
  exclusions: ReadonlyArray<{ path: string; reason: string }>;
  entries: readonly ArtifactEntry[];
};

/* ============================================================
 * 生成
 * ============================================================ */

export type ArtifactDefinition = {
  path: string;
  category: ManifestCategory;
  impact: string;
};

/**
 * 解析仓库根。
 *
 * 本文件位于 `src/infra/`，因此根是上两级。
 */
export const REPOSITORY_ROOT = fileURLToPath(new URL('../../', import.meta.url));

export function sha256OfFile(absolutePath: string): { sha256: string; bytes: number } {
  const content = readFileSync(absolutePath);
  return {
    sha256: createHash('sha256').update(content).digest('hex'),
    bytes: content.length,
  };
}

export type GenerateResult =
  | { ok: true; manifest: ArtifactManifest }
  | { ok: false; missing: string[] };

/**
 * 由定义表生成清单。
 *
 * **Fail-Closed**：定义表里任何一个文件不存在都返回失败，
 * 而不是「跳过缺失项生成一个残缺清单」—— 后者会让清单看起来完整却少了一部分。
 */
export function generateManifest(
  definitions: readonly ArtifactDefinition[],
  options: {
    generatedAt: string;
    manifestVersion?: string;
    generator?: string;
    exclusions?: ReadonlyArray<{ path: string; reason: string }>;
  },
): GenerateResult {
  const missing: string[] = [];
  const entries: ArtifactEntry[] = [];

  for (const definition of definitions) {
    const absolute = `${REPOSITORY_ROOT}${definition.path}`;
    if (!existsSync(absolute)) {
      missing.push(definition.path);
      continue;
    }
    const { sha256, bytes } = sha256OfFile(absolute);
    entries.push({
      path: definition.path,
      category: definition.category,
      sha256,
      bytes,
      impact: definition.impact,
    });
  }

  if (missing.length > 0) return { ok: false, missing };

  return {
    ok: true,
    manifest: {
      manifestVersion: options.manifestVersion ?? '1.0.0',
      generatedAt: options.generatedAt,
      generator: options.generator ?? 'src/infra/artifactManifest.ts',
      exclusions: options.exclusions ?? [],
      entries,
    },
  };
}

/* ============================================================
 * 校验
 * ============================================================ */

export type VerifyIssue = {
  path: string;
  category: ManifestCategory | 'UNKNOWN';
  kind: 'MISSING' | 'CHANGED' | 'UNLISTED';
  expected?: string;
  actual?: string;
  /** 中文说明 */
  message: string;
};

export type VerifyResult = {
  /** 清单内的条目是否全部与文件一致 */
  manifestMatches: boolean;
  issues: VerifyIssue[];
  /** 已校验条目数 */
  checked: number;
};

/**
 * 校验清单与文件系统是否一致。
 *
 * 两个方向都查：
 * - **清单有、文件变了或没了** → `CHANGED` / `MISSING`
 * - **定义表有、清单里没有** → `UNLISTED`（有人加了新产物却忘了登记）
 *
 * 第二个方向容易被忽略，但它是「新增产物忘记绑定 hash」的唯一防线。
 */
export function verifyManifest(
  manifest: ArtifactManifest,
  definitions: readonly ArtifactDefinition[],
): VerifyResult {
  const issues: VerifyIssue[] = [];
  const defined = new Map(definitions.map((d) => [d.path, d]));

  let checked = 0;
  for (const entry of manifest.entries) {
    const absolute = `${REPOSITORY_ROOT}${entry.path}`;
    if (!existsSync(absolute)) {
      issues.push({
        path: entry.path,
        category: entry.category,
        kind: 'MISSING',
        expected: entry.sha256,
        message: `清单登记的产物不存在了：${entry.path}`,
      });
      continue;
    }
    const { sha256 } = sha256OfFile(absolute);
    checked++;
    if (sha256 !== entry.sha256) {
      issues.push({
        path: entry.path,
        category: entry.category,
        kind: 'CHANGED',
        expected: entry.sha256,
        actual: sha256,
        message:
          `${entry.path} 内容已变化（${entry.sha256.slice(0, 12)}… → ${sha256.slice(0, 12)}…）。` +
          `影响：${entry.impact}`,
      });
    }
  }

  const listed = new Set(manifest.entries.map((e) => e.path));
  for (const definition of definitions) {
    if (!listed.has(definition.path)) {
      issues.push({
        path: definition.path,
        category: definition.category,
        kind: 'UNLISTED',
        message:
          `${definition.path} 在定义表里，但清单里没有 —— ` +
          '有人新增了产物却忘记登记（该产物的变化将无法被追溯）',
      });
    }
  }

  return { manifestMatches: issues.length === 0, issues, checked };
}

/** 从 JSON 文本解析清单（容忍 BOM —— Windows 工具链常见） */
export function parseManifest(text: string): ArtifactManifest {
  const normalized = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  return JSON.parse(normalized) as ArtifactManifest;
}

/** 写出清单（UTF-8 **无 BOM** —— 与项目其余 JSON 保持一致） */
export function writeManifest(absolutePath: string, manifest: ArtifactManifest): void {
  writeFileSync(absolutePath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

/* ============================================================
 * 生成器：路径化调用（避免手写 PowerShell 脚本）
 * ============================================================ */

/**
 * 把一个清单写成适合人工阅读的分组摘要。
 *
 * 用途：`npm run manifest` 时打印「哪些类别的产物被绑定」，
 * 让人一眼看出覆盖范围，而不是只看一个数字。
 */
export function describeManifest(manifest: ArtifactManifest): string[] {
  const byCategory = new Map<ManifestCategory, number>();
  for (const entry of manifest.entries) {
    byCategory.set(entry.category, (byCategory.get(entry.category) ?? 0) + 1);
  }
  const lines = [`产物清单 v${manifest.manifestVersion}（生成于 ${manifest.generatedAt}）`];
  for (const category of Object.values(ManifestCategory)) {
    const count = byCategory.get(category) ?? 0;
    if (count > 0) lines.push(`  ${category}: ${count} 个文件`);
  }
  lines.push(`  合计：${manifest.entries.length} 个文件`);
  return lines;
}
