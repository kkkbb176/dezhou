/**
 * 场景目录 —— 第一阶段真正要跑的 4/5/6/8/9 人桌场景清单
 *
 * ## 这个模块解决什么
 *
 * 「验证 5 个人数 × 若干场景」不能靠人肉手打请求：那样既无法复现，
 * 也必然漏掉某一档。这里把**目录本身**变成代码，于是：
 *
 * - 目录可以被测试穷举（每个条目都必须能被真实求解器处理）
 * - 界面的下拉框直接来自这份目录（零硬编码）
 * - 加一个桌人数只需要在这里加一行
 *
 * ## 🔴 场景的构造规则（写清楚，因为它决定了「验证了什么」）
 *
 * GTOpen 的树是**一棵从第一个行动位开始的完整树**，节点路径决定读到谁。
 * 因此「BTN 的 RFI」在求解器里其实是「前面全部弃牌，轮到 BTN」。
 * 这里的规则是：
 *
 * | 场景模板 | 意思 | 前序动作 |
 * |---|---|---|
 * | `FIRST_IN` | 该桌型**第一个行动位**的开池 | 无 |
 * | `FOLD_TO_HERO` | 前面全部弃牌，轮到 Hero | 之前每个非盲注位置一条 FOLD |
 * | `VS_FIRST_OPEN` | 第一个人开池后轮到我 | 第一个行动位 加注到 2.5BB |
 * | `VS_FIRST_OPEN_THEN_FOLDS` | 第一个人开池、中间全弃，轮到我 | 开池 + 中间的 FOLD |
 *
 * ⚠️ **不构造**「Hero 前面有人开池、又有人跟注」这类多路池场景：
 * 那需要求解器支持「跟注后继续」的节点，而本阶段没有验证过它。
 * 目录里没有的，界面就不会显示 —— 「不显示」比「显示了但是错的」安全得多。
 *
 * ## 为什么盲注位（SB / BB）也没有 RFI
 *
 * SB 前面已经有大盲的强制投入，BB 更是「已经投过钱」——
 * 他们的「无人入池」决策在树里**不是**第一个动作节点，而是
 * 前面全部弃牌之后的节点。本目录用 `FOLD_TO_HERO` 表达 SB，
 * 而 BB 用 `VS_FIRST_OPEN_THEN_FOLDS`（因为 BB 面对开池才是最有意义的节点）。
 */

import {
  GtoActionKind,
  GtoScenarioKind,
  type GtoPosition,
  type GtoScenario,
  type GtoScenarioAction,
  type GtoTableSize,
  gtoPositionsFor,
} from '../../domain/gto/gto.types.ts';
import {
  DEFAULT_OPEN_SIZE_BB,
  buildGtoScenario,
  describeScenarioZh,
  scenarioHashOf,
  type GtoScenarioSpec,
} from '../../domain/gto/gtoScenario.ts';

/** 目录条目的模板类型 */
export const GtoScenarioTemplate = {
  /** 第一个行动位的开池（真正的 RFI） */
  FIRST_IN: 'FIRST_IN',
  /** 前面全部弃牌，轮到 Hero（等价于「无人入池的 RFI」，但 Hero 不是第一个座位） */
  FOLD_TO_HERO: 'FOLD_TO_HERO',
  /** 第一个行动位开池后轮到我 */
  VS_FIRST_OPEN: 'VS_FIRST_OPEN',
  /** 第一个行动位开池 + 中间全弃 + 轮到我 */
  VS_FIRST_OPEN_THEN_FOLDS: 'VS_FIRST_OPEN_THEN_FOLDS',
} as const;
export type GtoScenarioTemplate =
  (typeof GtoScenarioTemplate)[keyof typeof GtoScenarioTemplate];

export const GTO_TEMPLATE_ZH: Readonly<Record<GtoScenarioTemplate, string>> = Object.freeze({
  FIRST_IN: '第一个入池（开池）',
  FOLD_TO_HERO: '前面全部弃牌',
  VS_FIRST_OPEN: '面对第一个开池',
  VS_FIRST_OPEN_THEN_FOLDS: '面对开池（中间已弃牌）',
});

/** 一个目录条目 */
export type GtoCatalogEntry = {
  /** 稳定 id，`${tableSize}-${heroPosition}-${template}`；界面用它做 key */
  id: string;
  tableSize: GtoTableSize;
  heroPosition: GtoPosition;
  template: GtoScenarioTemplate;
  /** 中文标签（界面直接显示） */
  labelZh: string;
  /** 已构造并归一化的场景；`null` = 该组合无法严谨表达 */
  scenario: GtoScenario | null;
  /** 场景哈希；`scenario === null` 时为空串 */
  scenarioHash: string;
  /** 为什么无法表达（`scenario === null` 时给出中文原因） */
  unsupportedReason: string | null;
};

/* ============================================================
 * 前序动作构造
 * ============================================================ */

function foldOf(position: GtoPosition): GtoScenarioAction {
  return { position, kind: GtoActionKind.FOLD, sizeBB: null };
}

function openOf(position: GtoPosition, sizeBB: number): GtoScenarioAction {
  return { position, kind: GtoActionKind.RAISE, sizeBB };
}

/**
 * 为一个「Hero 位置 + 模板」构造前序动作。
 *
 * 返回 `null` 表示这个组合在本项目里无法严谨表达（而不是「求解器不支持」——
 * 求解器支持与否要在真的问过之后才知道）。
 */
export function actionHistoryFor(
  tableSize: GtoTableSize,
  heroPosition: GtoPosition,
  template: GtoScenarioTemplate,
  openSizeBB = DEFAULT_OPEN_SIZE_BB,
): GtoScenarioAction[] | null {
  const order = gtoPositionsFor(tableSize);
  const heroIndex = order.indexOf(heroPosition);
  if (heroIndex < 0) return null;
  const first = order[0]!;
  const between = order.slice(1, heroIndex); // Hero 之前、第一个座位之后的非盲注位置

  switch (template) {
    case GtoScenarioTemplate.FIRST_IN:
      return heroIndex === 0 ? [] : null;

    case GtoScenarioTemplate.FOLD_TO_HERO:
      // 第一个位置之外，前面的人全部弃牌
      if (heroIndex === 0) return null;
      return order.slice(0, heroIndex).map(foldOf);

    case GtoScenarioTemplate.VS_FIRST_OPEN:
      // 第一个行动位开池，紧跟着就轮到 Hero（中间不能有别人）
      if (heroIndex !== 1) return null;
      return [openOf(first, openSizeBB)];

    case GtoScenarioTemplate.VS_FIRST_OPEN_THEN_FOLDS:
      // 第一个行动位开池，中间的人全部弃牌，轮到 Hero
      if (heroIndex < 1) return null;
      return [openOf(first, openSizeBB), ...between.map(foldOf)];

    default:
      return null;
  }
}

/** 模板 → 场景类型 */
function kindOfTemplate(template: GtoScenarioTemplate): GtoScenarioKind {
  switch (template) {
    case GtoScenarioTemplate.FIRST_IN:
    case GtoScenarioTemplate.FOLD_TO_HERO:
      return GtoScenarioKind.RFI;
    case GtoScenarioTemplate.VS_FIRST_OPEN:
    case GtoScenarioTemplate.VS_FIRST_OPEN_THEN_FOLDS:
      return GtoScenarioKind.VS_OPEN;
    default:
      return GtoScenarioKind.RFI;
  }
}

/* ============================================================
 * 目录构造
 * ============================================================ */

/** 一个桌型下要尝试的全部模板（顺序即界面顺序） */
const TEMPLATES_PER_POSITION: readonly GtoScenarioTemplate[] = Object.freeze([
  GtoScenarioTemplate.FIRST_IN,
  GtoScenarioTemplate.FOLD_TO_HERO,
  GtoScenarioTemplate.VS_FIRST_OPEN,
  GtoScenarioTemplate.VS_FIRST_OPEN_THEN_FOLDS,
]);

/** 构造一个桌型的全部条目（**包含无法表达的组合**，用 `unsupportedReason` 说明） */
export function catalogForTableSize(
  tableSize: GtoTableSize,
  effectiveStackBB = 100,
  openSizeBB = DEFAULT_OPEN_SIZE_BB,
): GtoCatalogEntry[] {
  const order = gtoPositionsFor(tableSize);
  const entries: GtoCatalogEntry[] = [];
  for (const position of order) {
    for (const template of TEMPLATES_PER_POSITION) {
      const id = `${tableSize}-${position}-${template}`;
      const labelZh = `${position} · ${GTO_TEMPLATE_ZH[template]}`;
      const history = actionHistoryFor(tableSize, position, template, openSizeBB);
      if (history === null) {
        entries.push({
          id,
          tableSize,
          heroPosition: position,
          template,
          labelZh,
          scenario: null,
          scenarioHash: '',
          unsupportedReason: unsupportedReasonFor(tableSize, position, template),
        });
        continue;
      }
      const spec: GtoScenarioSpec = {
        kind: kindOfTemplate(template),
        tableSize,
        effectiveStackBB,
        heroPosition: position,
        villainPosition: null,
        actionHistory: history,
        openSizeBB,
      };
      const scenario = buildGtoScenario(spec);
      entries.push({
        id,
        tableSize,
        heroPosition: position,
        template,
        labelZh,
        scenario,
        scenarioHash: scenario === null ? '' : scenarioHashOf(scenario),
        unsupportedReason:
          scenario === null ? unsupportedReasonFor(tableSize, position, template) : null,
      });
    }
  }
  return entries;
}

/** 给「无法表达」的组合一句**具体**的中文原因（不是说「不支持」了事） */
function unsupportedReasonFor(
  tableSize: GtoTableSize,
  position: GtoPosition,
  template: GtoScenarioTemplate,
): string {
  const order = gtoPositionsFor(tableSize);
  const index = order.indexOf(position);
  switch (template) {
    case GtoScenarioTemplate.FIRST_IN:
      return `${tableSize} 人桌的第一个行动位是 ${order[0]}，不是 ${position} —— 只有第一个行动位才有「第一个入池」这个节点。`;
    case GtoScenarioTemplate.FOLD_TO_HERO:
      return `${position} 就是 ${tableSize} 人桌的第一个行动位，「前面全部弃牌」不成立。`;
    case GtoScenarioTemplate.VS_FIRST_OPEN:
      return `「面对开池且中间无人行动」要求 Hero 紧跟在第一个行动位之后，而 ${position} 前面还有 ${Math.max(0, index - 1)} 个位置。`;
    case GtoScenarioTemplate.VS_FIRST_OPEN_THEN_FOLDS:
      return `Hero 必须晚于第一个行动位 ${order[0]} 行动。`;
    default:
      return '该组合在当前场景规则下无法表达。';
  }
}

/** 全部桌型的完整目录 */
export function fullCatalog(
  tableSizes: readonly GtoTableSize[] = [4, 5, 6, 8, 9],
  effectiveStackBB = 100,
): GtoCatalogEntry[] {
  const out: GtoCatalogEntry[] = [];
  for (const size of tableSizes) out.push(...catalogForTableSize(size, effectiveStackBB));
  return out;
}

/** 只保留**可以被真实查询**的条目 */
export function supportedCatalog(
  tableSizes: readonly GtoTableSize[] = [4, 5, 6, 8, 9],
  effectiveStackBB = 100,
): GtoCatalogEntry[] {
  return fullCatalog(tableSizes, effectiveStackBB).filter((e) => e.scenario !== null);
}

/** 目录条目的中文全称（含桌人数，避免「同名位置」看不出来是哪张桌子） */
export function catalogEntryLabelZh(entry: GtoCatalogEntry): string {
  if (entry.scenario === null) return `${entry.tableSize} 人桌 · ${entry.labelZh}（不可表达）`;
  return `${entry.tableSize} 人桌 · ${describeScenarioZh(entry.scenario)}`;
}

/* ============================================================
 * 自检
 * ============================================================ */

/**
 * 目录自检（Fail-Closed）。
 *
 * 检查的事：
 * 1. 每个桌型都**至少**有一个可查询条目（否则那个桌人数形同不支持）
 * 2. id 唯一
 * 3. **桌人数隔离**：不同桌型的**同名位置 + 同模板**必须得到不同哈希
 * 4. 条目里的场景哈希与重新计算的一致（防止手写哈希与场景脱节）
 */
export function selfCheckCatalog(): string[] {
  const problems: string[] = [];
  const all = fullCatalog();
  const ids = new Set<string>();
  for (const entry of all) {
    if (ids.has(entry.id)) problems.push(`目录 id 重复：${entry.id}`);
    ids.add(entry.id);
    if (entry.scenario !== null && scenarioHashOf(entry.scenario) !== entry.scenarioHash) {
      problems.push(`目录条目 ${entry.id} 的哈希与场景不一致`);
    }
  }

  for (const size of [4, 5, 6, 8, 9] as const) {
    const entries = all.filter((e) => e.tableSize === size);
    const usable = entries.filter((e) => e.scenario !== null);
    if (usable.length === 0) problems.push(`${size} 人桌没有任何可查询的场景`);
    if (entries.length !== gtoPositionsFor(size).length * TEMPLATES_PER_POSITION.length) {
      problems.push(`${size} 人桌的目录条目数不符`);
    }
  }

  // 桌人数隔离：同名位置 + 同模板，哈希两两不同
  for (const position of ['CO', 'BTN', 'SB', 'BB'] as const) {
    for (const template of TEMPLATES_PER_POSITION) {
      const hashes = new Set<string>();
      let count = 0;
      for (const size of [4, 5, 6, 8, 9] as const) {
        const entry = all.find(
          (e) => e.tableSize === size && e.heroPosition === position && e.template === template,
        );
        if (entry === undefined || entry.scenario === null) continue;
        count++;
        hashes.add(entry.scenarioHash);
      }
      if (count >= 2 && hashes.size !== count) {
        problems.push(
          `桌人数隔离失败：位置 ${position} / 模板 ${template} 在 ${count} 个桌型上只有 ${hashes.size} 个不同哈希`,
        );
      }
    }
  }

  return problems;
}

