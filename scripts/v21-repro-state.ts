/**
 * V2.1 可复现的文件状态清单 + 哈希
 *
 * 用法：
 * ```text
 * # 先由 shell 落盘一份 git 快照（本脚本**不**自己 spawn git，见下）
 * git rev-parse HEAD >  logs/v21-git.txt
 * git log -1 --pretty=%s >> logs/v21-git.txt
 * git status --porcelain=v1 >> logs/v21-git.txt
 * node --experimental-strip-types scripts/v21-repro-state.ts logs/v21-git.txt > reports/evidence/v21-repro-state.txt
 * ```
 *
 * ## 为什么不由脚本自己调 git
 *
 * 本环境的沙箱不允许进程通过**管道**捕获另一个程序的输出
 * （Node `child_process` 默认 `stdio: 'pipe'` 会失败）。这是**环境事实**，
 * 不是缺陷，因此改成「shell 落盘 → 脚本读文件」，结果可复现且不依赖沙箱行为。
 *
 * ## 为什么需要它
 *
 * 接手时工作区**不干净也不能被称作「干净 Git 基线」**：有大量未提交修改与未跟踪文件，
 * 且这些是**既有工作**，本轮一律保留。因此「基线」只能用
 * **具体文件 + 具体哈希**来锚定，不能用「工作区干净」这句话。
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/*
 * ⚠️ 必须用 `fileURLToPath`：仓库路径含非 ASCII 字符（`D:\德州`），
 * `new URL(...).pathname` 会把它百分号编码成 `%E5%BE%B7%E5%B7%9E`，
 * 于是一切 `readFileSync` 都 ENOENT。这是实测踩过的坑。
 */
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(SCRIPT_DIR, '..');

const snapshotPath = process.argv[2] ?? 'logs/v21-git.txt';
const snapshot = readFileSync(snapshotPath, 'utf8').split('\n');

const head = snapshot[0]?.trim() ?? 'UNKNOWN';
const subject = snapshot[1]?.trim() ?? 'UNKNOWN';
const status = snapshot.slice(2).filter((l) => l.trim() !== '');

/** 本轮（V2.1 审计）新增或修改的文件 —— 用于把「既有工作」与「本轮工作」分开 */
const V21_PREFIXES = [
  'reports/V21_',
  'reports/PROFILE_V21_',
  'reports/evidence/v21-',
  'scripts/v21-',
];

const isV21 = (path: string): boolean => V21_PREFIXES.some((p) => path.replace(/\\/g, '/').startsWith(p));

function hashOf(rel: string): { sha256: string; bytes: number } | { error: string } {
  try {
    const buf = readFileSync(resolve(REPO, rel));
    return { sha256: createHash('sha256').update(buf).digest('hex'), bytes: buf.byteLength };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

/** 表格单元格转义：含 `|` 的文件名（例如 `src/a|b.ts`）会破坏 Markdown 表格 */
const esc = (s: string): string => s.replace(/\|/g, '\\|');

const out: string[] = [];
const p = (s = ''): void => { out.push(s); };

p('# V2.1 文件状态与哈希（可复现）');
p();
p(`生成时刻：${new Date().toISOString()}`);
p(`git 快照来源：\`${snapshotPath}\`（由 shell 落盘，脚本不 spawn git）`);
p();
p('## 1. Git');
p();
p('```text');
p(`HEAD      = ${head}`);
p(`HEAD 提交 = ${subject}`);
p('```');
p();
const modified = status.filter((l) => /^ M/.test(l)).map((l) => l.slice(3).trim());
const untracked = status.filter((l) => /^\?\?/.test(l)).map((l) => l.slice(3).trim());
p(`- 已修改（tracked）：**${modified.length}**`);
p(`- 未跟踪：**${untracked.length}**`);
p(`- 其中**本轮 V2.1 新增**：**${untracked.filter(isV21).length}**`);
p(`- **接手前就有的既有工作**（未跟踪，未计入本轮）：**${untracked.filter((f) => !isV21(f)).length}**`);
p();
p('> ⚠️ **这不是「干净 Git 基线」** —— 工作区带着既有未提交工作。');
p('> 「基线」在本报告里的含义是「本节列出的具体文件 + 具体哈希」，不是「工作区干净」。');
p();

p('## 2. 已修改的 tracked 文件（sha256）');
p();
p('| 文件 | 字节 | sha256 | 本轮 V2.1 是否修改 |');
p('|---|---|---|---|');
const V21_TOUCHED = new Set([
  'src/domain/player/behaviorProfile.ts',
  'src/app/manualInput/manualInput.ts',
  'src/app/manualInput/contextBuilder.ts',
  'src/domain/decision/decision.types.ts',
  'src/app/decision/postflopAdvisor.ts',
]);
for (const rel of modified.sort()) {
  const h = hashOf(rel);
  p(`| \`${esc(rel)}\` | ${'bytes' in h ? h.bytes : '—'} | ${'sha256' in h ? '`' + h.sha256.slice(0, 16) + '…`' : '**' + esc(h.error) + '**'} | ${V21_TOUCHED.has(rel) ? '**是**' : '否（既有工作）'} |`);
}
p();

p('## 3. 未跟踪文件（sha256）');
p();
p('### 3.1 本轮 V2.1 新增（脚本 / 报告 / 证据）');
p();
p('| 文件 | 字节 | sha256 |');
p('|---|---|---|');
for (const rel of untracked.filter(isV21).sort()) {
  const h = hashOf(rel);
  p(`| \`${esc(rel)}\` | ${'bytes' in h ? h.bytes : '—'} | ${'sha256' in h ? '`' + h.sha256.slice(0, 16) + '…`' : '**' + esc(h.error) + '**'} |`);
}
p();
p('### 3.2 接手前既有工作（未跟踪）—— **本轮一律保留，未修改、未删除**');
p();
p('| 文件 | 字节 | sha256 |');
p('|---|---|---|');
for (const rel of untracked.filter((f) => !isV21(f)).sort()) {
  const h = hashOf(rel);
  p(`| \`${esc(rel)}\` | ${'bytes' in h ? h.bytes : '—'} | ${'sha256' in h ? '`' + h.sha256.slice(0, 16) + '…`' : '**' + esc(h.error) + '**'} |`);
}
p();
p('## 4. 完整 git status');
p();
p('```text');
p(status.join('\n'));
p('```');

console.log(out.join('\n'));
