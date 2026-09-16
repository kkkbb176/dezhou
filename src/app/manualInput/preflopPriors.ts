/**
 * 翻牌前范围先验（**启发式**）
 *
 * ## 这个模块在端到端链中解决什么
 *
 * Range 引擎需要一个**起始范围**才能用行动历史做贝叶斯更新。
 * 本项目**没有**任何可引用的翻牌前范围数据（Phase 4.5 审计的 4 个 GitHub 项目
 * 与 6 本书，没有一个提供），因此这里给出一份**明确标注为启发式**的先验。
 *
 * ## 🔴 这不是 GTO 范围，也不是任何求解器输出
 *
 * 数据来源：公开的扑克常识区间（「前位开池约 15%、按钮位约 45%」这类
 * 广泛讨论的粗略量级），由本项目自行整理成 169 个起手牌类别的相对权重。
 *
 * 因此：
 * - `sourceType` 一律为 `RangeSource.HEURISTIC`，`verified: false`
 * - `confidence` 刻意压低（0.3），与知识层 `env.*` 规则同量级
 * - 界面上**必须**显示为「启发式范围」或「粗略范围」，
 *   **绝不允许**显示为「GTO 范围」或「最优范围」
 *
 * ## 为什么权重是 0 / 0.1 / … / 1.0 的离散档位
 *
 * 连续的精确频率会**伪造精度**。公开资料给的是「这个位置大概开多少牌」
 * 这种量级判断，因此权重只表达「这手牌在这个位置打得有多频繁」的
 * **粗档位**，而不是声称某个精确百分比。
 *
 * ## 未纳入的部分（诚实记录）
 *
 * - 面对 3Bet 后的 4Bet/跟注范围**未建模**（行动历史会通过似然更新收缩范围，
 *   但收缩后的形状只反映「他加注了」，不反映真实的 4Bet 构造）
 * - 盲注位的冷跟范围、挤压范围未单独建模
 * - 这些缺口会体现在 `RangeSnapshot.confidence` 与决策的 `INSUFFICIENT_INFORMATION` 上，
 *   **不会**被静默补一个数字
 */

import { Position, TableSize } from '../../domain/types.ts';
import { RangeSource } from '../../domain/range/range.types.ts';
import type { RankClassWeights } from '../../domain/range/range.ts';
import { ALL_RANK_CLASSES } from '../../domain/range/combo.ts';

/* ============================================================
 * 权重档位
 * ============================================================ */

/**
 * 权重档位。
 *
 * | 值 | 含义 |
 * |---|---|
 * | 1.0 | 这个位置**几乎总会**这样打 |
 * | 0.75 | 大多数时候 |
 * | 0.5 | 混合策略（约一半） |
 * | 0.25 | 偶尔 |
 * | 0.1 | 极少（保留少量组合，避免范围被人为切断） |
 */
const W = { ALWAYS: 1, MOSTLY: 0.75, MIXED: 0.5, SOMETIMES: 0.25, RARE: 0.1 } as const;

/* ============================================================
 * 起手牌分类生成
 * ============================================================ */

const RANKS_DESC = ['A', 'K', 'Q', 'J', 'T', '9', '8', '7', '6', '5', '4', '3', '2'] as const;

/** 全部 169 个类别键（AA / AKs / AKo 形式） */
export function allRankClassKeys(): readonly string[] {
  const keys: string[] = [];
  for (let i = 0; i < RANKS_DESC.length; i++) {
    for (let j = 0; j < RANKS_DESC.length; j++) {
      const a = RANKS_DESC[i]!;
      const b = RANKS_DESC[j]!;
      if (i === j) keys.push(`${a}${b}`);
      else if (i < j) keys.push(`${a}${b}s`, `${a}${b}o`);
    }
  }
  return keys;
}

type Spec = {
  /** 对子（AA..22）中 ≥ minRank 的部分 */
  readonly pairsFrom?: string;
  /** 同花牌：A 带脚 ≥ kickerFrom */
  readonly axSuitedFrom?: string;
  /** 同花牌：两张都 ≥ from */
  readonly suitedFrom?: string;
  /** 同花连张（含间隔 ≤ 2）从某张起 */
  readonly suitedConnectorsFrom?: string;
  /** 非同花：A 带脚 ≥ kickerFrom */
  readonly axOffsuitFrom?: string;
  /** 非同花：两张都 ≥ from */
  readonly offsuitFrom?: string;
  /** 显式点名的类别（最高优先，直接生效不再看其它条件） */
  readonly exact?: Readonly<Record<string, number>>;
};

type SpecItem = { readonly spec: Spec; readonly weight: number };

/** 类型标注用的恒等函数（见文件末尾说明） */
function specs(items: readonly SpecItem[]): readonly SpecItem[] {
  return items;
}

function rankIndex(rank: string): number {
  return RANKS_DESC.indexOf(rank as (typeof RANKS_DESC)[number]);
}

/**
 * 把规格展开成 169 类的权重表。
 *
 * 同一类别取**最大值**（不是相加）——相加会让同时满足多个条件的类别
 * （例如 AKs 既是「A 带脚」又是「同花」）权重溢出，等于重复计票。
 */
function buildWeights(items: readonly SpecItem[]): RankClassWeights {
  const table: Record<string, number> = {};
  for (const key of allRankClassKeys()) table[key] = 0;

  const apply = (key: string, weight: number): void => {
    if (!(key in table)) return;
    table[key] = Math.max(table[key]!, weight);
  };

  for (const { spec, weight } of items) {
    for (const key of allRankClassKeys()) {
      if (spec.exact !== undefined && key in spec.exact) {
        apply(key, spec.exact[key]!);
        continue;
      }

      const isPair = key.length === 2;
      const suited = key.endsWith('s');
      const r1 = key[0]!;
      const i1 = rankIndex(r1);
      const i2 = rankIndex(key[1]!);
      const high = Math.min(i1, i2);
      const low = Math.max(i1, i2);

      let matches = false;
      if (isPair && spec.pairsFrom !== undefined) {
        matches = high <= rankIndex(spec.pairsFrom);
      } else if (!isPair && suited && spec.axSuitedFrom !== undefined) {
        matches = r1 === 'A' && low <= rankIndex(spec.axSuitedFrom);
      } else if (!isPair && suited && spec.suitedFrom !== undefined) {
        matches = high <= rankIndex(spec.suitedFrom) && low <= rankIndex(spec.suitedFrom);
      } else if (!isPair && suited && spec.suitedConnectorsFrom !== undefined) {
        matches = high <= rankIndex(spec.suitedConnectorsFrom) && low - high <= 2;
      } else if (!isPair && !suited && spec.axOffsuitFrom !== undefined) {
        matches = r1 === 'A' && low <= rankIndex(spec.axOffsuitFrom);
      } else if (!isPair && !suited && spec.offsuitFrom !== undefined) {
        matches = high <= rankIndex(spec.offsuitFrom) && low <= rankIndex(spec.offsuitFrom);
      }

      if (matches) apply(key, weight);
    }
  }

  return Object.freeze(table);
}

/* ============================================================
 * 开池（RFI）范围
 * ============================================================ */

/**
 * 开池范围规格（按位置从紧到松）。
 *
 * 每一档都比前一档**严格更宽**（新增一批牌），因此「位置越靠后范围越宽」
 * 这个单调性是结构性成立的，并由 `selfCheckPreflopPriors()` 断言。
 */
const RFI_SPECS: Readonly<Record<string, readonly SpecItem[]>> = Object.freeze({
  /* ---- 最紧：9 人桌前位（UTG / UTG1 / UTG2）---- */
  ULTRA_EARLY: specs([
    { spec: { pairsFrom: '7' }, weight: W.ALWAYS },
    { spec: { axSuitedFrom: 'T' }, weight: W.ALWAYS },
    { spec: { axOffsuitFrom: 'Q' }, weight: W.ALWAYS },
    {
      spec: {
        exact: {
          KQs: W.ALWAYS, KJs: W.MOSTLY, QJs: W.MOSTLY, JTs: W.MOSTLY, T9s: W.MIXED,
          AKo: W.ALWAYS, AQo: W.ALWAYS, AJo: W.MIXED, KQo: W.MIXED,
        },
      },
      weight: W.MIXED,
    },
    {
      spec: {
        exact: {
          '66': W.MIXED, '55': W.SOMETIMES, '44': W.SOMETIMES, '33': W.RARE, '22': W.RARE,
          '98s': W.SOMETIMES, '87s': W.SOMETIMES, '76s': W.RARE, '65s': W.RARE, '54s': W.RARE,
          A9s: W.MIXED, A8s: W.SOMETIMES, A7s: W.SOMETIMES, A6s: W.SOMETIMES,
          A5s: W.MIXED, A4s: W.SOMETIMES, A3s: W.RARE, A2s: W.RARE,
          KTs: W.MIXED, K9s: W.RARE, QTs: W.MIXED, Q9s: W.RARE, J9s: W.SOMETIMES, T8s: W.RARE,
          ATo: W.SOMETIMES, KJo: W.SOMETIMES, QJo: W.RARE, A9o: W.RARE, KTo: W.RARE,
        },
      },
      weight: W.SOMETIMES,
    },
  ]),

  /* ---- 早位：6 人桌 UTG / 9 人桌 LJ ---- */
  EARLY: specs([
    { spec: { pairsFrom: '5' }, weight: W.ALWAYS },
    { spec: { axSuitedFrom: '9' }, weight: W.ALWAYS },
    { spec: { axOffsuitFrom: 'T' }, weight: W.ALWAYS },
    { spec: { suitedFrom: 'T' }, weight: W.MOSTLY },
    {
      spec: {
        exact: {
          KQo: W.ALWAYS, AJo: W.ALWAYS, ATo: W.MOSTLY, KJo: W.MOSTLY,
          QJo: W.SOMETIMES, A9o: W.SOMETIMES, KTo: W.SOMETIMES,
          '44': W.MIXED, '33': W.MIXED, '22': W.MIXED,
        },
      },
      weight: W.MOSTLY,
    },
    { spec: { suitedConnectorsFrom: '9' }, weight: W.MIXED },
    {
      spec: {
        exact: {
          K9s: W.MIXED, K8s: W.SOMETIMES, Q9s: W.MIXED, Q8s: W.RARE,
          J9s: W.MIXED, J8s: W.RARE, T8s: W.SOMETIMES, '97s': W.SOMETIMES,
          '86s': W.RARE, '75s': W.RARE, '64s': W.RARE, '53s': W.RARE,
          A8o: W.SOMETIMES, A7o: W.RARE, K9o: W.SOMETIMES, QTo: W.SOMETIMES, JTo: W.MIXED,
        },
      },
      weight: W.SOMETIMES,
    },
  ]),

  /* ---- 中位：6 人桌 HJ / 9 人桌 HJ ---- */
  MIDDLE: specs([
    { spec: { pairsFrom: '3' }, weight: W.ALWAYS },
    { spec: { axSuitedFrom: '5' }, weight: W.ALWAYS },
    { spec: { axOffsuitFrom: '9' }, weight: W.MOSTLY },
    { spec: { suitedFrom: '9' }, weight: W.MOSTLY },
    {
      spec: {
        exact: {
          KQo: W.ALWAYS, KJo: W.ALWAYS, QJo: W.MOSTLY, KTo: W.MOSTLY,
          QTo: W.MIXED, JTo: W.MIXED, A8o: W.MOSTLY,
          A7o: W.SOMETIMES, A6o: W.SOMETIMES, A5o: W.MIXED,
          A4o: W.SOMETIMES, A3o: W.RARE, A2o: W.RARE,
          '22': W.MOSTLY,
        },
      },
      weight: W.MOSTLY,
    },
    { spec: { suitedConnectorsFrom: 'T' }, weight: W.MIXED },
    {
      spec: {
        exact: {
          K8s: W.MIXED, K7s: W.MIXED, K6s: W.SOMETIMES, K5s: W.SOMETIMES,
          K4s: W.RARE, K3s: W.RARE, K2s: W.RARE,
          Q8s: W.MIXED, Q7s: W.SOMETIMES, Q6s: W.RARE,
          J8s: W.MIXED, J7s: W.SOMETIMES, T7s: W.MIXED,
          '96s': W.SOMETIMES, '85s': W.SOMETIMES, '74s': W.SOMETIMES,
          '63s': W.RARE, '52s': W.RARE, '43s': W.SOMETIMES,
          K9o: W.MIXED, Q9o: W.MIXED, J9o: W.MIXED, T9o: W.SOMETIMES, '98o': W.SOMETIMES,
        },
      },
      weight: W.SOMETIMES,
    },
  ]),

  /* ---- 后位：6 人桌 CO / 9 人桌 CO ---- */
  LATE: specs([
    { spec: { pairsFrom: '2' }, weight: W.ALWAYS },
    { spec: { axSuitedFrom: '2' }, weight: W.ALWAYS },
    { spec: { axOffsuitFrom: '5' }, weight: W.MOSTLY },
    { spec: { suitedFrom: '6' }, weight: W.MOSTLY },
    {
      spec: {
        exact: {
          KQo: W.ALWAYS, KJo: W.ALWAYS, KTo: W.ALWAYS, QJo: W.ALWAYS,
          QTo: W.MOSTLY, JTo: W.MOSTLY, T9o: W.MIXED, '98o': W.MIXED,
          A4o: W.MOSTLY, A3o: W.MOSTLY, A2o: W.MIXED,
          K9o: W.MOSTLY, Q9o: W.MIXED, J9o: W.MIXED,
        },
      },
      weight: W.MOSTLY,
    },
    { spec: { suitedConnectorsFrom: 'J' }, weight: W.MIXED },
    {
      spec: {
        exact: {
          K8s: W.MOSTLY, K7s: W.MOSTLY, K6s: W.MIXED, K5s: W.MIXED,
          K4s: W.MIXED, K3s: W.SOMETIMES, K2s: W.SOMETIMES,
          Q8s: W.MOSTLY, Q7s: W.MIXED, Q6s: W.MIXED, Q5s: W.SOMETIMES, Q4s: W.SOMETIMES,
          J8s: W.MOSTLY, J7s: W.MIXED, J6s: W.SOMETIMES,
          T8s: W.MOSTLY, T7s: W.MIXED, T6s: W.SOMETIMES,
          '97s': W.MOSTLY, '96s': W.MIXED, '95s': W.SOMETIMES,
          '87s': W.MOSTLY, '86s': W.MIXED, '85s': W.SOMETIMES,
          '76s': W.MOSTLY, '75s': W.MIXED, '65s': W.MOSTLY, '64s': W.MIXED,
          '54s': W.MOSTLY, '53s': W.SOMETIMES, '43s': W.MIXED, '42s': W.RARE, '32s': W.RARE,
        },
      },
      weight: W.MIXED,
    },
  ]),

  /* ---- 按钮位 ---- */
  BUTTON: specs([
    { spec: { pairsFrom: '2' }, weight: W.ALWAYS },
    { spec: { axSuitedFrom: '2' }, weight: W.ALWAYS },
    { spec: { axOffsuitFrom: '2' }, weight: W.MOSTLY },
    { spec: { suitedFrom: '4' }, weight: W.MOSTLY },
    {
      spec: {
        exact: {
          KQo: W.ALWAYS, KJo: W.ALWAYS, KTo: W.ALWAYS, K9o: W.ALWAYS,
          QJo: W.ALWAYS, QTo: W.ALWAYS, Q9o: W.MOSTLY,
          JTo: W.ALWAYS, J9o: W.MOSTLY, T9o: W.MOSTLY, T8o: W.MIXED,
          '98o': W.MOSTLY, '97o': W.MIXED, '87o': W.MIXED, '76o': W.MIXED,
          '65o': W.SOMETIMES, '54o': W.SOMETIMES, '43o': W.RARE, '32o': W.RARE,
        },
      },
      weight: W.MOSTLY,
    },
    { spec: { suitedConnectorsFrom: 'Q' }, weight: W.MIXED },
    {
      spec: {
        exact: {
          K7s: W.MOSTLY, K6s: W.MOSTLY, K5s: W.MOSTLY, K4s: W.MIXED, K3s: W.MIXED, K2s: W.MIXED,
          Q7s: W.MOSTLY, Q6s: W.MIXED, Q5s: W.MIXED, Q4s: W.MIXED, Q3s: W.SOMETIMES, Q2s: W.SOMETIMES,
          J7s: W.MOSTLY, J6s: W.MIXED, J5s: W.SOMETIMES, J4s: W.SOMETIMES,
          T7s: W.MOSTLY, T6s: W.MIXED, T5s: W.SOMETIMES, T4s: W.SOMETIMES,
          '96s': W.MOSTLY, '95s': W.MIXED, '94s': W.SOMETIMES,
          '86s': W.MOSTLY, '85s': W.MIXED, '84s': W.SOMETIMES,
          '75s': W.MOSTLY, '74s': W.MIXED, '73s': W.SOMETIMES,
          '64s': W.MOSTLY, '63s': W.MIXED, '53s': W.MOSTLY, '52s': W.MIXED, '42s': W.SOMETIMES,
        },
      },
      weight: W.MIXED,
    },
  ]),

  /* ---- 小盲位开池（常以加注代替溜入）---- */
  SMALL_BLIND: specs([
    { spec: { pairsFrom: '2' }, weight: W.MOSTLY },
    { spec: { axSuitedFrom: '2' }, weight: W.MOSTLY },
    { spec: { axOffsuitFrom: '4' }, weight: W.MIXED },
    { spec: { suitedFrom: '5' }, weight: W.MIXED },
    {
      spec: {
        exact: {
          KQo: W.ALWAYS, KJo: W.ALWAYS, KTo: W.MOSTLY, QJo: W.MOSTLY,
          QTo: W.MIXED, JTo: W.MIXED, T9o: W.MIXED, '98o': W.SOMETIMES,
          A5o: W.MIXED, A4o: W.MIXED, A3o: W.SOMETIMES, A2o: W.SOMETIMES, K9o: W.MIXED,
        },
      },
      weight: W.MIXED,
    },
    { spec: { suitedConnectorsFrom: 'J' }, weight: W.MIXED },
  ]),
});

/* ============================================================
 * 面对开池的继续范围
 * ============================================================ */

/**
 * 面对一个开池加注时的继续范围（跟注 + 3Bet **合并**）。
 *
 * ⚠️ **第一版的简化（必须如实告知）**：
 * 这里给的是「继续（含跟注与 3Bet）」的**合并**范围，而不是分别建模。
 * 理由：分开建模需要 3Bet/跟注的比例假设，而那个比例没有任何数据支撑。
 * 合并后的范围在**宽度**上是合理的，但**形状偏平**
 * （不区分「3Bet 的强牌」与「跟注的中等牌」）。
 *
 * 这个缺口会让 `INSUFFICIENT_INFORMATION` 更容易被触发（保守方向）。
 */
const DEFEND_SPECS: Readonly<Record<string, readonly SpecItem[]>> = Object.freeze({
  /** 面对**前位**开池：收紧 */
  VS_EARLY: specs([
    { spec: { pairsFrom: '8' }, weight: W.ALWAYS },
    { spec: { axSuitedFrom: 'T' }, weight: W.ALWAYS },
    { spec: { axOffsuitFrom: 'Q' }, weight: W.ALWAYS },
    {
      spec: {
        exact: {
          AKo: W.ALWAYS, AQo: W.ALWAYS, AJo: W.MIXED, KQo: W.MIXED,
          '77': W.MIXED, '66': W.SOMETIMES, '55': W.SOMETIMES, '44': W.RARE, '33': W.RARE, '22': W.RARE,
          KQs: W.ALWAYS, KJs: W.MOSTLY, KTs: W.MIXED,
          QJs: W.MOSTLY, QTs: W.MIXED, JTs: W.MOSTLY,
          T9s: W.MIXED, '98s': W.MIXED, '87s': W.SOMETIMES, '76s': W.SOMETIMES,
          A9s: W.MIXED, A8s: W.SOMETIMES, A5s: W.MIXED, A4s: W.SOMETIMES,
          A3s: W.RARE, A2s: W.RARE, ATo: W.MIXED, KJo: W.SOMETIMES, QJo: W.RARE,
        },
      },
      weight: W.MIXED,
    },
  ]),

  /** 面对**中位**开池 */
  VS_MIDDLE: specs([
    { spec: { pairsFrom: '5' }, weight: W.ALWAYS },
    { spec: { axSuitedFrom: '8' }, weight: W.ALWAYS },
    { spec: { axOffsuitFrom: 'T' }, weight: W.ALWAYS },
    {
      spec: {
        exact: {
          AKo: W.ALWAYS, AQo: W.ALWAYS, AJo: W.ALWAYS, ATo: W.MOSTLY,
          KQo: W.ALWAYS, KJo: W.MOSTLY, QJo: W.MIXED, A9o: W.MIXED, KTo: W.MIXED,
          '44': W.MIXED, '33': W.MIXED, '22': W.MIXED,
          KQs: W.ALWAYS, KJs: W.ALWAYS, KTs: W.MOSTLY, K9s: W.MIXED,
          QJs: W.ALWAYS, QTs: W.MOSTLY, Q9s: W.MIXED,
          JTs: W.MOSTLY, J9s: W.MIXED, T9s: W.MOSTLY, T8s: W.MIXED,
          '98s': W.MOSTLY, '87s': W.MIXED, '76s': W.MIXED, '65s': W.SOMETIMES,
          A7s: W.MIXED, A6s: W.MIXED, A5s: W.MOSTLY, A4s: W.MIXED,
          A3s: W.SOMETIMES, A2s: W.SOMETIMES,
        },
      },
      weight: W.MIXED,
    },
  ]),

  /** 面对**后位/按钮**开池：可以宽很多 */
  VS_LATE: specs([
    { spec: { pairsFrom: '2' }, weight: W.MOSTLY },
    { spec: { axSuitedFrom: '2' }, weight: W.MOSTLY },
    { spec: { axOffsuitFrom: '7' }, weight: W.MOSTLY },
    { spec: { suitedFrom: 'J' }, weight: W.MIXED },
    {
      spec: {
        exact: {
          AKo: W.ALWAYS, AQo: W.ALWAYS, AJo: W.ALWAYS, ATo: W.ALWAYS,
          KQo: W.ALWAYS, KJo: W.ALWAYS, KTo: W.MOSTLY, QJo: W.MOSTLY,
          QTo: W.MIXED, JTo: W.MIXED, T9o: W.MIXED, '98o': W.MIXED,
          A6o: W.MIXED, A5o: W.MIXED, A4o: W.MIXED, A3o: W.SOMETIMES, A2o: W.SOMETIMES,
          K9o: W.MIXED, Q9o: W.MIXED,
        },
      },
      weight: W.MIXED,
    },
    {
      spec: {
        exact: {
          K8s: W.MOSTLY, K7s: W.MIXED, K6s: W.MIXED, K5s: W.MIXED,
          K4s: W.SOMETIMES, K3s: W.SOMETIMES, K2s: W.SOMETIMES,
          Q8s: W.MOSTLY, Q7s: W.MIXED, Q6s: W.MIXED, Q5s: W.SOMETIMES, Q4s: W.SOMETIMES,
          J8s: W.MOSTLY, J7s: W.MIXED, J6s: W.SOMETIMES,
          T8s: W.MOSTLY, T7s: W.MIXED,
          '97s': W.MOSTLY, '96s': W.MIXED,
          '87s': W.MOSTLY, '86s': W.MIXED,
          '76s': W.MOSTLY, '75s': W.MIXED,
          '65s': W.MOSTLY, '64s': W.MIXED,
          '54s': W.MOSTLY, '53s': W.MIXED, '43s': W.MIXED,
        },
      },
      weight: W.MIXED,
    },
  ]),

  /** 大盲位面对开池（有折扣，可最宽） */
  BIG_BLIND_VS_OPEN: specs([
    { spec: { pairsFrom: '2' }, weight: W.MOSTLY },
    { spec: { axSuitedFrom: '2' }, weight: W.MOSTLY },
    { spec: { axOffsuitFrom: '5' }, weight: W.MOSTLY },
    { spec: { suitedFrom: 'T' }, weight: W.MIXED },
    {
      spec: {
        exact: {
          AKo: W.ALWAYS, AQo: W.ALWAYS, AJo: W.ALWAYS, ATo: W.ALWAYS, A9o: W.MOSTLY,
          A4o: W.MOSTLY, A3o: W.MOSTLY, A2o: W.MOSTLY,
          KQo: W.ALWAYS, KJo: W.ALWAYS, KTo: W.ALWAYS, K9o: W.MOSTLY,
          QJo: W.ALWAYS, QTo: W.MOSTLY, Q9o: W.MIXED,
          JTo: W.MOSTLY, J9o: W.MIXED, T9o: W.MOSTLY, T8o: W.MIXED,
          '98o': W.MOSTLY, '97o': W.MIXED, '87o': W.MIXED, '76o': W.MIXED,
          '65o': W.SOMETIMES, '54o': W.SOMETIMES,
        },
      },
      weight: W.MIXED,
    },
    {
      spec: {
        exact: {
          K8s: W.MOSTLY, K7s: W.MOSTLY, K6s: W.MIXED, K5s: W.MIXED,
          K4s: W.MIXED, K3s: W.MIXED, K2s: W.MIXED,
          Q8s: W.MOSTLY, Q7s: W.MOSTLY, Q6s: W.MIXED, Q5s: W.MIXED,
          Q4s: W.MIXED, Q3s: W.MIXED, Q2s: W.SOMETIMES,
          J8s: W.MOSTLY, J7s: W.MOSTLY, J6s: W.MIXED, J5s: W.MIXED, J4s: W.SOMETIMES,
          T7s: W.MOSTLY, T6s: W.MIXED,
          '97s': W.MOSTLY, '96s': W.MIXED, '95s': W.MIXED,
          '87s': W.MOSTLY, '86s': W.MOSTLY, '85s': W.MIXED,
          '76s': W.MOSTLY, '75s': W.MIXED, '74s': W.MIXED,
          '65s': W.MOSTLY, '64s': W.MIXED,
          '54s': W.MOSTLY, '53s': W.MIXED, '43s': W.MIXED,
          '42s': W.SOMETIMES, '32s': W.SOMETIMES,
        },
      },
      weight: W.MIXED,
    },
  ]),
});

/* ============================================================
 * 再加注（3Bet）范围
 * ============================================================ */

/**
 * 面对已开池者**再加注**（3Bet）的范围。
 *
 * ## ⚠️ 为什么必须有这一档（红队 F-03 的修复）
 *
 * 修复前**任何** `RAISE` 都用 `rfiWeights`（开池范围）。后果：
 * 对手 3Bet 之后，系统仍把「他可能用大盲位置的开池范围加注」当成事实。
 * 实测 `BB 3bet 后 AKo 权益 = 0.6306`，而按真实紧 3Bet 范围（QQ+/AK）
 * 只有 **0.3558** —— **虚高 27.5 个百分点**。
 * 该误差让系统对 3Bet 过度乐观，叠加 F-01（不能加注）会放大损失。
 *
 * ## 这仍然是**启发式**
 *
 * 公开的扑克常识：正常 3Bet 范围大致是「QQ+ / AK 为主，
 * 加少量诈唬（A5s、同花连张）」。这里是它的**粗略版本**，
 * **不是**求解器输出，也**不声称**精确频率。
 */
const THREEBET_SPECS: Readonly<Record<string, readonly SpecItem[]>> = Object.freeze({
  /** 面对前位开池的 3Bet：最紧 */
  THREEBET_VS_EARLY: specs([
    { spec: { pairsFrom: 'Q' }, weight: W.ALWAYS }, // QQ+
    { spec: { exact: { AKo: W.ALWAYS, AKs: W.ALWAYS, AQs: W.MIXED, JJ: W.MIXED } }, weight: W.ALWAYS },
    {
      spec: {
        exact: {
          '99': W.RARE, TT: W.SOMETIMES, A5s: W.SOMETIMES, A4s: W.RARE,
          KQs: W.SOMETIMES, AQo: W.SOMETIMES,
        },
      },
      weight: W.SOMETIMES,
    },
  ]),
  /** 面对中位开池的 3Bet */
  THREEBET_VS_MIDDLE: specs([
    { spec: { pairsFrom: 'T' }, weight: W.ALWAYS }, // TT+
    {
      spec: { exact: { AKo: W.ALWAYS, AKs: W.ALWAYS, AQs: W.ALWAYS, AQo: W.MOSTLY, AJs: W.MOSTLY, KQs: W.MOSTLY } },
      weight: W.ALWAYS,
    },
    {
      spec: {
        exact: {
          '99': W.MIXED, '88': W.SOMETIMES, A5s: W.MOSTLY, A4s: W.MIXED, A3s: W.SOMETIMES,
          KJs: W.MIXED, QJs: W.MIXED, JTs: W.SOMETIMES, AJo: W.SOMETIMES, KQo: W.SOMETIMES,
        },
      },
      weight: W.MIXED,
    },
  ]),
  /** 面对后位/按钮开池的 3Bet：可含更多诈唬 */
  THREEBET_VS_LATE: specs([
    { spec: { pairsFrom: '8' }, weight: W.ALWAYS }, // 88+
    {
      spec: {
        exact: {
          AKo: W.ALWAYS, AKs: W.ALWAYS, AQs: W.ALWAYS, AQo: W.ALWAYS,
          AJs: W.ALWAYS, AJo: W.MOSTLY, KQs: W.ALWAYS, KQo: W.MOSTLY,
        },
      },
      weight: W.ALWAYS,
    },
    {
      spec: {
        exact: {
          '77': W.MIXED, '66': W.SOMETIMES, '55': W.SOMETIMES,
          A5s: W.ALWAYS, A4s: W.MOSTLY, A3s: W.MIXED, A2s: W.MIXED,
          KJs: W.MOSTLY, KTs: W.MIXED, QJs: W.MOSTLY, QTs: W.MIXED,
          JTs: W.MOSTLY, T9s: W.MIXED, '98s': W.SOMETIMES, '87s': W.SOMETIMES,
          ATs: W.MOSTLY, A9s: W.MIXED, K9s: W.SOMETIMES, ATo: W.MIXED,
        },
      },
      weight: W.MIXED,
    },
  ]),
  /** 大盲位面对开池的 3Bet（有折扣，可稍宽） */
  THREEBET_FROM_BLIND: specs([
    { spec: { pairsFrom: '9' }, weight: W.ALWAYS }, // 99+
    {
      spec: { exact: { AKo: W.ALWAYS, AKs: W.ALWAYS, AQs: W.ALWAYS, AQo: W.MOSTLY, AJs: W.MOSTLY, KQs: W.MOSTLY } },
      weight: W.ALWAYS,
    },
    {
      spec: {
        exact: {
          '88': W.MIXED, '77': W.SOMETIMES, A5s: W.MOSTLY, A4s: W.MIXED, A3s: W.MIXED,
          KJs: W.MIXED, QJs: W.MIXED, JTs: W.MIXED, ATs: W.MIXED,
          AJo: W.SOMETIMES, KQo: W.SOMETIMES, '98s': W.RARE, '87s': W.RARE,
        },
      },
      weight: W.MIXED,
    },
  ]),
});

/* ============================================================
 * 位置 → 范围档位
 * ============================================================ */

type RfiTier = keyof typeof RFI_SPECS;
type DefendTier = keyof typeof DEFEND_SPECS;
type ThreeBetTier = keyof typeof THREEBET_SPECS;

/**
 * 位置 → 开池档位。
 *
 * 与桌型有关：9 人桌的 UTG 比 6 人桌的 UTG **更紧**（前面人更多）。
 * 这个映射是**结构性**的（人越多、越靠前越紧），不是逐位手调。
 */
export function rfiTierOf(tableSize: TableSize, position: Position): RfiTier {
  if (tableSize === TableSize.NINE_MAX) {
    switch (position) {
      case Position.UTG:
      case Position.UTG1:
      case Position.UTG2:
        return 'ULTRA_EARLY';
      case Position.LJ:
        return 'EARLY';
      case Position.HJ:
        return 'MIDDLE';
      case Position.CO:
        return 'LATE';
      case Position.BTN:
        return 'BUTTON';
      case Position.SB:
        return 'SMALL_BLIND';
      default:
        return 'BUTTON';
    }
  }
  switch (position) {
    case Position.UTG:
      return 'EARLY';
    case Position.HJ:
      return 'MIDDLE';
    case Position.CO:
      return 'LATE';
    case Position.BTN:
      return 'BUTTON';
    case Position.SB:
      return 'SMALL_BLIND';
    default:
      return 'BUTTON';
  }
}

/** 开池者的位置 → 面对他开池时该用的继续档位 */
export function defendTierOf(tableSize: TableSize, opener: Position, defender: Position): DefendTier {
  if (defender === Position.BB) return 'BIG_BLIND_VS_OPEN';
  const openerTier = rfiTierOf(tableSize, opener);
  if (openerTier === 'ULTRA_EARLY' || openerTier === 'EARLY') return 'VS_EARLY';
  if (openerTier === 'MIDDLE') return 'VS_MIDDLE';
  return 'VS_LATE';
}

/**
 * 3Bet 者的位置 + 被开池者的位置 → 3Bet 范围档位。
 *
 * 判据与 `defendTierOf` 同构：面对越靠前的开池，3Bet 范围越紧；
 * 盲注位的 3Bet 有折扣，因此可稍宽。
 */
export function threeBetTierOf(
  tableSize: TableSize,
  threeBettor: Position,
  opener: Position,
): ThreeBetTier {
  if (threeBettor === Position.BB || threeBettor === Position.SB) return 'THREEBET_FROM_BLIND';
  const openerTier = rfiTierOf(tableSize, opener);
  if (openerTier === 'ULTRA_EARLY' || openerTier === 'EARLY') return 'THREEBET_VS_EARLY';
  if (openerTier === 'MIDDLE') return 'THREEBET_VS_MIDDLE';
  return 'THREEBET_VS_LATE';
}

/**
 * 3Bet 范围权重（169 类）。
 *
 * ⚠️ 这是「对手**主动再加注**」时应使用的范围 ——
 * **不要**在这里退回开池范围（那正是红队 F-03 的缺陷）。
 */
export function threeBetWeights(
  tableSize: TableSize,
  threeBettor: Position,
  opener: Position,
): RankClassWeights {
  const tier = threeBetTierOf(tableSize, threeBettor, opener);
  return cachedWeights(`3bet:${tier}`, THREEBET_SPECS[tier]!);
}

/* ============================================================
 * 缓存与导出
 * ============================================================ */

const WEIGHT_CACHE = new Map<string, RankClassWeights>();

function cachedWeights(key: string, items: readonly SpecItem[]): RankClassWeights {
  const hit = WEIGHT_CACHE.get(key);
  if (hit !== undefined) return hit;
  const built = buildWeights(items);
  WEIGHT_CACHE.set(key, built);
  return built;
}

/** 某个位置的开池范围权重（169 类） */
export function rfiWeights(tableSize: TableSize, position: Position): RankClassWeights {
  const tier = rfiTierOf(tableSize, position);
  return cachedWeights(`rfi:${tier}`, RFI_SPECS[tier]!);
}

/** 面对开池时的继续范围权重（169 类） */
export function defendWeights(
  tableSize: TableSize,
  opener: Position,
  defender: Position,
): RankClassWeights {
  const tier = defendTierOf(tableSize, opener, defender);
  return cachedWeights(`defend:${tier}`, DEFEND_SPECS[tier]!);
}

/* ============================================================
 * 🔴 按**本手人数**（handedness）选档 —— Table Topology Correction
 * ============================================================ */

/**
 * 位置名 → 开池档位（**只看位置名，不看桌型**）。
 *
 * ## 为什么这是对的（而不是把两个概念又混起来）
 *
 * 档位表 `RFI_SPECS` 是按**位置相对 Button 的距离**分档的，而
 * `canonicalRolesOf(n)` 给每个本手人数分配的位置名本身**就编码了那个距离**：
 *
 * | 本手人数 | 角色表 | UTG 离 Button 多远 |
 * |---|---|---|
 * | 9 | UTG UTG1 UTG2 LJ HJ CO BTN SB BB | 7 位 |
 * | 8 | UTG UTG1 LJ HJ CO BTN SB BB | 6 位 |
 * | 6 | UTG HJ CO BTN SB BB | 4 位 |
 * | 3 | BTN SB BB | —（没有 UTG） |
 *
 * 于是「用位置名选档」**自动**得到正确的人数控档：8 人桌的 UTG 比 9 人桌的
 * UTG 少一个人在前面，因此该用次紧一档。而 `canonicalRolesOf` 已经保证
 * 8 人桌不会出现 `UTG2`、3 人桌不会出现 `UTG` —— 位置名与人数的对应关系
 * 是**构造出来的**，不需要在这里再查一遍人数。
 *
 * ## 修复前的缺陷
 *
 * 旧入口按 `tableSize`（**座位容量**）二分：`=== 9 ? 9人档 : 6人档`。
 * 于是 8 人桌的 UTG 被当成 6 人桌 UTG（`EARLY`，**比应得的更松**），
 * 2/3/4/5/7/8 人全部落进同一个 6 人档。那正是「容量当人数用」。
 */
function rfiTierByPositionName(position: Position): RfiTier {
  switch (position) {
    // 9 人桌前三位：前面还有 7 个人
    case Position.UTG:
    case Position.UTG1:
    case Position.UTG2:
      return 'ULTRA_EARLY';
    // 「早位」一档覆盖 9 人桌 LJ 与 6 人桌 UTG —— 它们离 Button 都是 5 位
    case Position.LJ:
      return 'EARLY';
    // 同理：9 人桌 HJ 与 6 人桌 HJ 都离 Button 4 位
    case Position.HJ:
      return 'MIDDLE';
    case Position.CO:
      return 'LATE';
    case Position.BTN:
      return 'BUTTON';
    case Position.SB:
      return 'SMALL_BLIND';
    default:
      /*
       * 大盲位**没有开池范围** —— 大盲不可能「开池」（他面对的是一次开池）。
       * 这里如实抛错而不是编一个档位：旧实现给它兜底 `BUTTON`，
       * 结果 6 人桌的大盲被赋予按钮位的开池范围（权重和 84.20），
       * 这正是红队 F-03 命中的那个缺陷。宁可响亮地失败。
       */
      throw new Error(
        `rfiTierByPositionName: 「${position}」没有开池范围 —— 大盲位不能开池，请改用 3Bet / 防守范围`,
      );
  }
}

/**
 * 某个位置的**本手人数口径**开池档位。
 *
 * ⚠️ 与 `rfiTierOf(tableSize, position)` 的区别见 `rfiTierByPositionName` 的说明。
 * 新代码请用这个 —— 传的是**本手人数**（`state.players.length`），
 * 而 `rfiTierOf` 收的是**座位容量**（`config.tableSize`）。
 */
export function rfiTierByHandedness(position: Position): RfiTier {
  return rfiTierByPositionName(position);
}

/** 面对开池时的继续档位（本手人数口径） */
export function defendTierByHandedness(opener: Position, defender: Position): DefendTier {
  if (defender === Position.BB) return 'BIG_BLIND_VS_OPEN';
  const openerTier = rfiTierByPositionName(opener);
  if (openerTier === 'ULTRA_EARLY' || openerTier === 'EARLY') return 'VS_EARLY';
  if (openerTier === 'MIDDLE') return 'VS_MIDDLE';
  return 'VS_LATE';
}

/** 3Bet 档位（本手人数口径） */
export function threeBetTierByHandedness(
  threeBettor: Position,
  opener: Position,
): ThreeBetTier {
  if (threeBettor === Position.BB || threeBettor === Position.SB) return 'THREEBET_FROM_BLIND';
  const openerTier = rfiTierByPositionName(opener);
  if (openerTier === 'ULTRA_EARLY' || openerTier === 'EARLY') return 'THREEBET_VS_EARLY';
  if (openerTier === 'MIDDLE') return 'THREEBET_VS_MIDDLE';
  return 'THREEBET_VS_LATE';
}

/** 开池范围权重（本手人数口径） */
export function rfiWeightsByHandedness(position: Position): RankClassWeights {
  const tier = rfiTierByPositionName(position);
  return cachedWeights(`rfi:${tier}`, RFI_SPECS[tier]!);
}

/** 面对开池时的继续范围权重（本手人数口径） */
export function defendWeightsByHandedness(
  opener: Position,
  defender: Position,
): RankClassWeights {
  const tier = defendTierByHandedness(opener, defender);
  return cachedWeights(`defend:${tier}`, DEFEND_SPECS[tier]!);
}

/** 3Bet 范围权重（本手人数口径） */
export function threeBetWeightsByHandedness(
  threeBettor: Position,
  opener: Position,
): RankClassWeights {
  const tier = threeBetTierByHandedness(threeBettor, opener);
  return cachedWeights(`3bet:${tier}`, THREEBET_SPECS[tier]!);
}

/** 大盲位「无人加注时的过牌范围」—— 大盲已投入，范围极宽 */
export function bigBlindCheckWeights(): RankClassWeights {
  return cachedWeights('bb-check', [
    { spec: { pairsFrom: '2' }, weight: W.ALWAYS },
    { spec: { axSuitedFrom: '2' }, weight: W.ALWAYS },
    { spec: { axOffsuitFrom: '2' }, weight: W.ALWAYS },
    { spec: { suitedFrom: '2' }, weight: W.ALWAYS },
    { spec: { offsuitFrom: '2' }, weight: W.MOSTLY },
  ]);
}

/* ============================================================
 * Provenance（界面必须显示「这是启发式」）
 * ============================================================ */

export const PREFLOP_PRIOR_PROVENANCE = Object.freeze({
  sourceId: 'heuristic.preflop-rfi.v1',
  sourceType: RangeSource.HEURISTIC,
  version: '1.0.0',
  description:
    '启发式翻牌前范围先验：依据公开讨论的粗略量级（前位约 15%、按钮位约 45%）' +
    '自行整理为 169 个起手牌类别的相对权重。**不是求解器输出，不是 GTO 范围。**',
  verified: false,
  confidence: 0.3,
});

/** 中文说明（界面与诊断用） */
export const PREFLOP_PRIOR_NOTE =
  '范围来源：本项目自建的启发式先验（非求解器输出，可信度 0.3）';

/* ============================================================
 * 自检
 * ============================================================ */

/**
 * 范围表自检（构建期与测试用）。
 *
 * 检查五件事：
 * 1. 权重表恰好覆盖 169 个类别
 * 2. 所有权重有限且落在 0..1
 * 3. **位置单调**：位置越靠后，开池范围不更窄
 *    （这是「位置越靠后越宽」这一扑克常识的**可执行断言**，
 *     防止有人手工改表时破坏它）
 * 4. **3Bet 严格窄于开池**（红队 F-03 的永久锁）
 *    —— 修复前 `rfiTierOf(6max, BB)` 会落到 `default: BUTTON`，
 *    于是「对手 3Bet」被当成「对手在按钮位开池」，权益虚高 27.5 个百分点。
 *    只把 3Bet 表建出来是不够的：还必须断言它**真的更紧**，
 *    否则一次手滑把某个 3Bet 档位写宽，缺陷会静默复活。
 * 5. **顶级牌必须真的在范围里**：每一档开池与 3Bet 都必须给 `AA` / `KK`
 *    最高权重 —— 没有哪张表能合理地「不包含 AA」。
 */
export function selfCheckPreflopPriors(): string[] {
  const problems: string[] = [];
  const expected = ALL_RANK_CLASSES.length;

  const tiers: RfiTier[] = ['ULTRA_EARLY', 'EARLY', 'MIDDLE', 'LATE', 'BUTTON'];
  const widths: number[] = [];

  for (const tier of tiers) {
    const weights = cachedWeights(`rfi:${tier}`, RFI_SPECS[tier]!);
    const entries = Object.entries(weights);
    if (entries.length !== expected) {
      problems.push(`档位 ${tier} 的类别数为 ${entries.length}，应为 ${expected}`);
    }
    let sum = 0;
    for (const [key, value] of entries) {
      if (!Number.isFinite(value) || value < 0 || value > 1) {
        problems.push(`档位 ${tier} 的 ${key} 权重越界：${value}`);
      }
      sum += value;
    }
    widths.push(sum);

    // ---- 5. 顶级牌必须在范围里 ----
    for (const premium of ['AA', 'KK']) {
      const value = weights[premium];
      if (value === undefined || !(value >= W.MOSTLY)) {
        problems.push(`开池档位 ${tier} 必须给 ${premium} 高权重（实际 ${String(value)}）`);
      }
    }
  }

  for (let i = 1; i < widths.length; i++) {
    if (widths[i]! < widths[i - 1]! - 1e-9) {
      problems.push(
        `开池范围宽度不单调：${tiers[i - 1]} 的权重和 ${widths[i - 1]!.toFixed(2)} ` +
          `> ${tiers[i]} 的 ${widths[i]!.toFixed(2)}`,
      );
    }
  }

  /* ---- 4. 3Bet 必须严格窄于同一个位置的开池范围 ---- */
  //
  // 对齐关系刻意保守：每个 3Bet 档位只与**最宽的那个**开池档位比较。
  // 若它连最宽的对手范围都更窄，那么对任何更紧的对手它也一样更窄。
  const widestRfi = Math.max(...widths);
  const threeBetTiers: ThreeBetTier[] = [
    'THREEBET_VS_EARLY',
    'THREEBET_VS_MIDDLE',
    'THREEBET_VS_LATE',
    'THREEBET_FROM_BLIND',
  ];
  for (const tier of threeBetTiers) {
    const entries = Object.entries(cachedWeights(`3bet:${tier}`, THREEBET_SPECS[tier]!));
    if (entries.length !== expected) {
      problems.push(`3Bet 档位 ${tier} 的类别数为 ${entries.length}，应为 ${expected}`);
    }
    let sum = 0;
    for (const [key, value] of entries) {
      if (!Number.isFinite(value) || value < 0 || value > 1) {
        problems.push(`3Bet 档位 ${tier} 的 ${key} 权重越界：${value}`);
      }
      sum += value;
    }
    if (!(sum < widestRfi)) {
      problems.push(
        `3Bet 档位 ${tier} 的权重和 ${sum.toFixed(2)} 不小于最宽开池范围的 ${widestRfi.toFixed(2)} —— ` +
          '3Bet 范围必须**严格更紧**，否则「面对再加注」会被当成「面对开池」（红队 F-03）',
      );
    }
    for (const premium of ['AA', 'KK']) {
      if (!(entries.some(([key, value]) => key === premium && value >= W.MOSTLY))) {
        problems.push(`3Bet 档位 ${tier} 必须包含 ${premium}`);
      }
    }
  }

  /* ---- 大盲「无人加注时的过牌范围」必须比任何开池范围都宽 ---- */
  const bbCheck = Object.values(bigBlindCheckWeights()).reduce((a, b) => a + b, 0);
  if (!(bbCheck > widestRfi)) {
    problems.push(
      `大盲过牌范围的权重和 ${bbCheck.toFixed(2)} 不大于最宽开池范围 ${widestRfi.toFixed(2)} —— ` +
        '大盲已经投入盲注，跟注范围理应最宽',
    );
  }

  return problems;
}

/**
 * 为什么需要 `specs()` 这个恒等函数（写给未来的维护者）
 *
 * 对象字面量被 `as const` 或上下文类型推断时，`exact: { KQs: 1, KJs: 0.75 }`
 * 会得到**精确的字面量类型**（键集固定、未列出的键为 `undefined`），
 * 于是它无法赋给 `Record<string, number>`：
 *
 * ```
 * Type '{ KQs: 1; ... }' is not assignable to type 'Readonly<Record<string, number>>'.
 *   Property 'AKo' is incompatible with index signature.
 *     Type 'undefined' is not assignable to type 'number'.
 * ```
 *
 * `specs()` 把推断结果**拓宽**回 `readonly SpecItem[]`，同时保留
 * 「就地写对象字面量」的可读性。它没有任何运行时开销（直接返回入参）。
 */
export const __specsIdentityForTypes = specs;
