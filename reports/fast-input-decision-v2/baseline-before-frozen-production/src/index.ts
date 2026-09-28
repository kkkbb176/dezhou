/**
 * 程序入口（薄壳）
 *
 * 职责只有两件：
 *   1. 聚合对外公开的 API（便于未来 UI 直接 `import { ... } from './index.ts'`）
 *   2. 在作为脚本直接运行时启动 CLI 演示
 *
 * 刻意保持「薄」：不含格式化、不含夹具、不含场景编排、不做业务判断。
 * 这些分别位于 src/cli/format.ts、src/cli/demoFixtures.ts、src/cli/demoScript.ts。
 *
 * 注意：**不在模块加载时执行任何演示**，因此本文件可以被安全导入与测试。
 */

/* ---------------- 领域层公开 API ---------------- */

export * from './domain/index.ts';

/* ---------------- 中文显示映射层 ---------------- */

export * from './i18n/index.ts';

/* ---------------- 基础设施 ---------------- */

export * from './infra/rng.ts';

/* ---------------- 决策管线基础设施 ---------------- */

export * from './app/decisionDeadline.ts';
export * from './app/decisionPipeline.ts';

/* ---------------- CLI 演示（显式触发） ---------------- */

import { pathToFileURL } from 'node:url';
import { runDemo } from './cli/demoScript.ts';
export { runDemo };

/* ---------------- 直接运行时的入口 ---------------- */

/**
 * 是否作为脚本直接运行。
 *
 * 必须把 `process.argv[1]` 通过 `pathToFileURL` 转成 file URL 再与 `import.meta.url` 比较：
 * Windows 下 `argv[1]` 是 `D:\德州\src\index.ts` 这样的原生路径，
 * 而 `import.meta.url` 是 `file:///D:/%E5%BE%B7%E5%B7%9E/src/index.ts`（**含百分号编码**）。
 * 直接字符串比对会永远为 false，导致 `npm run demo` 静默什么都不做。
 */
function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  runDemo();
}
