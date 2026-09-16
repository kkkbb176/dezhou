/**
 * 决策日志（JSONL）
 *
 * ## 这个模块在端到端链中解决什么
 *
 * 每次分析都留下一条可追溯的记录（规范第 89 节）。
 * 这是「昨天建议 CALL，今天建议 FOLD，到底哪个版本的哪个模块变了」
 * 这类问题的唯一答案来源。
 *
 * ## 为什么第一版是 JSONL
 *
 * 明确裁定：**不必现在做完整数据库**。JSONL 够用：
 * - 追加写、无需事务
 * - 一行一条，可用任何工具读
 * - 出错时只影响一行，不会污染全库
 *
 * ## 隐私（规范第 91 节）
 *
 * 内部使用。日志**不写对手底牌**（本来就没有），
 * 也**不上传**任何地方。不含账户、不含云同步。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 默认日志路径（相对仓库根） */
export const DEFAULT_DECISION_LOG_PATH = fileURLToPath(
  new URL('../../data/decision-log.jsonl', import.meta.url),
);

/**
 * 一条决策日志。
 *
 * 🔴 **刻意不含对手底牌与结果。**
 * 这不是「约定不写」，而是类型里没有这两个字段 ——
 * 与 `DecisionContext` 的同一条纪律（规范第 20 节）。
 */
export type DecisionLogEntry = {
  /** ISO 时刻 */
  at: string;
  /** 输入哈希（同一输入 → 同一哈希，用于去重与追溯） */
  inputHash: string;
  /** 引擎重算的底池 */
  computedPot: number;
  /** 用户声明的底池（用于发现「说的和算的不一致」）；`null` = 用户未声明 */
  claimedPot: number | null;
  environment: string;
  /**
   * 建议的动作；**信息不足时为 `null`**。
   *
   * ⚠️ 刻意不做成 `'FOLD'`：那会让「系统拒绝给建议」与
   * 「系统建议弃牌」在日志里无法区分（红队 F-05）。
   */
  decision: string | null;
  sizeChips: number | null;
  confidence: number;
  classification: string;
  actionable: boolean;
  /** 各模块版本（追溯依据） */
  versions: Readonly<Record<string, string>>;
  /** 各阶段耗时（毫秒） */
  timingMs: Readonly<Record<string, number>>;
  /** 范围有效组合数 */
  rangeSupportSize: number | null;
  /** 范围来源类型 */
  rangeSourceKind: string | null;
  /** 动态层是否被采用 */
  dynamicApplied: boolean;
  /** Shadow 摘要 */
  shadow: Readonly<{
    actionChanged: boolean;
    dynamicConfidence: number;
    magnitudeProvenance: string;
  }>;
  /** 抽水口径 */
  rakeModel: string;
};

/**
 * 追加一条决策日志。
 *
 * ## 失败时的行为
 *
 * **抛异常**，由调用方决定如何处理。
 * `alphaPipeline` 会捕获它并降级为一条警告 ——
 * 因为「日志写不进去」不该让使用者拿不到建议。
 */
export function appendDecisionLog(entry: DecisionLogEntry, path?: string): void {
  const target = path !== undefined ? resolve(path) : DEFAULT_DECISION_LOG_PATH;
  const dir = dirname(target);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  appendFileSync(target, `${JSON.stringify(entry)}\n`, 'utf8');
}

/** 读取全部日志（供诊断与测试；文件不存在时返回空数组） */
export function readDecisionLog(path?: string): DecisionLogEntry[] {
  const target = path !== undefined ? resolve(path) : DEFAULT_DECISION_LOG_PATH;
  if (!existsSync(target)) return [];
  const text = readFileSync(target, 'utf8');
  const entries: DecisionLogEntry[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      entries.push(JSON.parse(trimmed) as DecisionLogEntry);
    } catch {
      // 单行损坏不影响其余记录（这正是 JSONL 的好处）
      continue;
    }
  }
  return entries;
}
