/**
 * 知识库文件加载（Node 侧）—— Phase 4.5
 *
 * 与 `knowledge.ts` 分开的原因：领域层必须保持**纯函数、零 I/O**。
 * 本模块承担唯一的一处文件读取，读取后立刻交给纯校验器。
 *
 * ## Fail-Closed（规范第 35 节）
 *
 * - 文件缺失 → 抛错
 * - JSON 解析失败 → 抛错（并指出文件路径）
 * - schema 不符 → 抛错（并列出**全部**问题）
 * - 引用悬空 → 抛错
 *
 * **绝不**返回「部分可用的知识库」。一个静默残缺的知识库比没有知识库更危险：
 * 它会让使用者以为结论有依据。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  buildKnowledgeIndex,
  parseSourceRegistry,
  parseStrategyRules,
  type KnowledgeBase,
  type KnowledgeIndex,
} from './knowledge.ts';

/** 默认知识目录（相对本文件） */
export const DEFAULT_KNOWLEDGE_DIR = fileURLToPath(new URL('../../../data/knowledge/', import.meta.url));

export type LoadIssue = { subject: string; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export type LoadResult =
  | { ok: true; index: KnowledgeIndex; base: KnowledgeBase }
  | { ok: false; issues: LoadIssue[] };

function readJson(path: string, issues: LoadIssue[]): { ok: true; value: unknown } | { ok: false } {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    issues.push({ subject: path, message: `无法读取文件：${(error as Error).message}` });
    return { ok: false };
  }
  // 去掉 UTF-8 BOM。`JSON.parse` 不接受前导 U+FEFF —— 而 Windows 上
  // PowerShell 的 `Set-Content -Encoding UTF8` 与不少编辑器**默认**写 BOM。
  // 不剥掉它会让一个内容完全正确的知识库在解析阶段就整体失败。
  // 注意：这是**格式容忍**，不是**内容修复** —— 剥掉 BOM 不改变任何语义。
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  try {
    // ⚠️ 必须区分「读取/解析失败」与「解析成功但结果是 null」。
    // 红队 F-10：旧版用 `null` 当失败哨兵，而 `JSON.parse('null')` 恰好
    // 返回 `null`，于是「文件内容是字面 null」被当成「读取失败」，
    // 走进了一个不会产生任何诊断的分支 —— 调用方收到 ok:false 但 issues 为空。
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (error) {
    issues.push({ subject: path, message: `JSON 解析失败：${(error as Error).message}` });
    return { ok: false };
  }
}

/**
 * 从目录加载并校验知识库。
 *
 * @param directory 默认 `data/knowledge/`
 */
export function loadKnowledgeBase(directory: string = DEFAULT_KNOWLEDGE_DIR): LoadResult {
  const issues: LoadIssue[] = [];

  const registryRead = readJson(`${directory}/source-registry.json`, issues);
  const rulesRead = readJson(`${directory}/strategy-rules.json`, issues);
  if (!registryRead.ok || !rulesRead.ok) return { ok: false, issues };

  const registry = parseSourceRegistry(registryRead.value);
  if (!registry.ok) {
    for (const issue of registry.issues) {
      issues.push({ subject: `${issue.subject} [${issue.code}]`, message: issue.message });
    }
    // 红队 F-10：解析器可能返回 ok:false 但 issues 为空。
    // 此时必须补一条**可诊断**的说明，绝不能让调用方收到「失败了但没有原因」。
    if (issues.length === 0) {
      issues.push({
        subject: `${directory}/source-registry.json`,
        message: '来源注册表解析失败，但解析器未给出具体原因（根结构不是对象，或缺 sources 数组）',
      });
    }
    return { ok: false, issues };
  }

  const rules = parseStrategyRules(rulesRead.value);
  if (!rules.ok) {
    for (const issue of rules.issues) {
      issues.push({ subject: `${issue.subject} [${issue.code}]`, message: issue.message });
    }
    if (issues.length === 0) {
      issues.push({
        subject: `${directory}/strategy-rules.json`,
        message: '策略规则解析失败，但解析器未给出具体原因（根结构不是对象，或缺 rules 数组）',
      });
    }
    return { ok: false, issues };
  }

  const registryMeta = isRecord(registryRead.value) ? registryRead.value : {};
  const version = typeof registryMeta.registryVersion === 'string' ? registryMeta.registryVersion : 'unknown';
  const auditDate = typeof registryMeta.auditDate === 'string' ? registryMeta.auditDate : 'unknown';

  const base: KnowledgeBase = {
    version,
    auditDate,
    sources: registry.value,
    rules: rules.value,
  };

  try {
    const index = buildKnowledgeIndex(base);
    return { ok: true, index, base };
  } catch (error) {
    issues.push({ subject: 'knowledge-base', message: (error as Error).message });
    return { ok: false, issues };
  }
}

/**
 * 加载知识库；失败即抛错。
 *
 * 启动路径应当用这个版本 —— 让「知识库坏了」在启动时立刻暴露，
 * 而不是等到某个用户查询时才静默返回空结果。
 */
export function loadKnowledgeBaseOrThrow(directory: string = DEFAULT_KNOWLEDGE_DIR): KnowledgeIndex {
  const result = loadKnowledgeBase(directory);
  if (!result.ok) {
    const detail = result.issues.map((i) => `  ${i.subject}：${i.message}`).join('\n');
    throw new Error(`loadKnowledgeBaseOrThrow: 知识库加载失败（Fail-Closed，拒绝降级）：\n${detail}`);
  }
  return result.index;
}
