/**
 * 生成全项目产物清单（`npm run manifest`）
 *
 * ## 用法
 *
 * ```sh
 * npm run manifest          # 重新生成 data/artifact-manifest.json
 * npm run manifest -- --check   # 只校验，不写入（CI / 验收用）
 * ```
 *
 * ## 为什么需要一个脚本而不是手写命令
 *
 * 手写 PowerShell `Get-FileHash` 有三个问题：
 * 1. 容易漏文件（本项目已经发生过）
 * 2. `Set-Content -Encoding UTF8` 会写 **BOM**（本项目已经踩过，见红队 F-11）
 * 3. 无法在 CI 中以「校验模式」运行
 *
 * 本脚本只用 `src/infra/artifactManifest.ts` 的纯逻辑，因此生成与校验
 * **共用同一套代码**，不存在「生成用一种方式、校验用另一种方式」的漂移。
 */

import { readFileSync, existsSync } from 'node:fs';

import {
  REPOSITORY_ROOT,
  describeManifest,
  generateManifest,
  parseManifest,
  verifyManifest,
  writeManifest,
} from '../src/infra/artifactManifest.ts';
import {
  ARTIFACT_DEFINITIONS,
  MANIFEST_EXCLUSIONS,
  PROJECT_MANIFEST_PATH,
} from '../src/infra/artifactDefinitions.ts';

const checkOnly = process.argv.includes('--check');
const manifestAbsolute = `${REPOSITORY_ROOT}${PROJECT_MANIFEST_PATH}`;

if (checkOnly) {
  if (!existsSync(manifestAbsolute)) {
    console.error(`✖ 清单不存在：${PROJECT_MANIFEST_PATH}`);
    console.error('  请先运行：npm run manifest');
    process.exit(1);
  }
  const manifest = parseManifest(readFileSync(manifestAbsolute, 'utf8'));
  const result = verifyManifest(manifest, ARTIFACT_DEFINITIONS);
  if (result.manifestMatches) {
    for (const line of describeManifest(manifest)) console.log(line);
    console.log(`✔ 全部 ${result.checked} 个产物与清单一致`);
    process.exit(0);
  }
  console.error(`✖ 清单校验失败（${result.issues.length} 项）：`);
  for (const issue of result.issues) {
    console.error(`  [${issue.kind}] ${issue.message}`);
  }
  process.exit(1);
}

const generated = generateManifest(ARTIFACT_DEFINITIONS, {
  generatedAt: new Date().toISOString().slice(0, 10),
  manifestVersion: '1.0.0',
  generator: 'npm run manifest（src/infra/artifactManifest.ts）',
  exclusions: MANIFEST_EXCLUSIONS,
});

if (!generated.ok) {
  console.error('✖ 生成失败：以下产物不存在，定义表与实际不符：');
  for (const path of generated.missing) console.error(`  ${path}`);
  console.error('  请修正 src/infra/artifactDefinitions.ts 或补上缺失文件。');
  process.exit(1);
}

writeManifest(manifestAbsolute, generated.manifest);
for (const line of describeManifest(generated.manifest)) console.log(line);
console.log(`✔ 已写入 ${PROJECT_MANIFEST_PATH}（UTF-8 无 BOM）`);
