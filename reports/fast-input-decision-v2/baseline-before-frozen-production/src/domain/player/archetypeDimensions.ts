/**
 * 🔴 **画像原型 → 连续维度**（P0 架构修复：画像必须进入 Range，而不是只当末端偏好）
 *
 * ## 修的是什么（真实缺陷，不是参数问题）
 *
 * 使用者用五个画像跑同一个河牌节点（CO 下注 40 进 49），得到：
 *
 * ```text
 * VERY_TIGHT  CALL 分 0.364
 * UNDERBLUFFER CALL 分 0.368
 * NORMAL      CALL 分 0.379
 * BLUFF_HEAVY CALL 分 0.414
 * MANIAC      CALL 分 0.415
 * ⇒ 六个情形的**动作、权益（17.5%）、跟注 EV（−17.43）、强牌质量（81.3%）全部相同**
 * ```
 *
 * 根因有两条，**都在「画像 → 维度」这一步断掉**：
 *
 * 1. 手选画像只在 `buildPlayerSnapshot` 里把 `confidence` 抬到
 *    `QUICK_PROFILE_CONFIDENCE`，**维度仍然来自「零手样本」的画像** ——
 *    也就是全部落在 0.5 中立点 ⇒ 所有调整因子恒为 1。
 * 2. 于是即便把 `RangeAdjustmentProvider` 接进 `updateRange`（本模块的姊妹改动），
 *    因子也全是 1，**范围逐位不变** ⇒ 权益不变 ⇒ EV 不变 ⇒ 动作不变。
 *
 * 本模块只解决第 1 条：把「用户手选的类型」翻译成**连续维度**，
 * 让下游那条既有且已测试的管线真正有东西可用。
 *
 * ## 证据等级（逐项标注，禁止含糊）
 *
 * | 内容 | 等级 |
 * |---|---|
 * | 「类型标签 ⇒ 维度向量」的对应关系 | 【公开扑克理论】原型描述（紧/松、凶/被动、诈唬多/少） |
 * | 表里的具体数值 | 【启发式】**结构性定义**，不是拟合参数、不是实测频率 |
 * | 手选画像可信度上限 | 【工程约束】沿用既有 `QUICK_PROFILE_CONFIDENCE` |
 * | 实测数据优先于手选画像 | 【工程约束】证据优先级：直接观测 > 用户断言 > 群体先验 |
 *
 * ⚠️ **本文件不产生任何动作**，也不含任何 `Action` 字段 ——
 * 规范第二十节的禁令（画像绝不直接决策）在这里同样成立。
 * 它只把标签翻译成维度，之后一切都走既有的「维度 ⇒ 乘性因子 ⇒ Range」链路。
 *
 * ⚠️ 表里的数字**不代表**「这类玩家 VPIP 是 15%」这种可引用统计 ——
 * 本项目没有分级别的实测数据。它们只表达**序关系**：
 * `VERY_TIGHT` 的紧度高于 `TIGHT`，`MANIAC` 的诈唬倾向高于 `BLUFF_HEAVY`。
 */

import type { QuickProfile } from '../../app/manualInput/manualInput.ts';
import { SampleTier } from './playerStats.ts';
import type { PlayerDimensions } from './playerClassifier.ts';

/* ============================================================
 * 原型表
 * ============================================================ */

export type ArchetypeSpec = {
  /** 紧（1）↔ 松（0） */
  tightness: number;
  /** 凶（1）↔ 弱（0） */
  aggression: number;
  /** 诈唬多（1）↔ 诈唬少（0） */
  bluffTendency: number;
  /** 被动跟注（1）↔ 主动弃牌（0） */
  passivity: number;
  /** 中文一句描述（进 UI，必须能让人看出这是个**刻板印象**而不是实测） */
  labelZh: string;
};

/**
 * 画像原型 → 维度。
 *
 * `UNKNOWN` 刻意是 `null`（**没有原型证据**），而不是「中立原型」——
 * 后者会让「没画像」与「NORMAL 画像」在日志里长得一样，
 * 而它们是两件不同的事（信息缺失 vs 一个断言）。
 */
export const ARCHETYPE_DIMENSIONS: Readonly<Record<QuickProfile, ArchetypeSpec | null>> =
  Object.freeze({
    UNKNOWN: null,

    // 极紧：入池极少，且下注基本代表有牌
    VERY_TIGHT: {
      tightness: 0.88,
      aggression: 0.45,
      bluffTendency: 0.15,
      passivity: 0.45,
      labelZh: '极紧（很少入池；进攻几乎总是价值）',
    },
    TIGHT: {
      tightness: 0.72,
      aggression: 0.5,
      bluffTendency: 0.28,
      passivity: 0.45,
      labelZh: '偏紧（入池克制，诈唬偏少）',
    },

    // 中性：**全部 0.5**，因此因子恒为 1 —— 这是「NORMAL = 不调整」的落地，
    // 而不是「NORMAL 有调整但看不出来」。
    NORMAL: {
      tightness: 0.5,
      aggression: 0.5,
      bluffTendency: 0.5,
      passivity: 0.5,
      labelZh: '普通常客（中性原型，不产生任何调整）',
    },

    LOOSE: {
      tightness: 0.32,
      aggression: 0.55,
      bluffTendency: 0.6,
      passivity: 0.5,
      labelZh: '偏松（入池宽，诈唬略多）',
    },
    VERY_LOOSE: {
      tightness: 0.18,
      aggression: 0.6,
      bluffTendency: 0.68,
      passivity: 0.5,
      labelZh: '极松（入池很宽）',
    },

    // 跟注站：松而被动 —— 「不弃牌」是它最关键的信息，不是「爱诈唬」
    CALLING_STATION: {
      tightness: 0.3,
      aggression: 0.3,
      bluffTendency: 0.35,
      passivity: 0.8,
      labelZh: '跟注站（松而被动：跟得多、诈唬少）',
    },

    AGGRESSIVE: {
      tightness: 0.45,
      aggression: 0.82,
      bluffTendency: 0.6,
      passivity: 0.3,
      labelZh: '激进（主动加注多）',
    },
    BLUFF_HEAVY: {
      tightness: 0.42,
      aggression: 0.78,
      bluffTendency: 0.85,
      passivity: 0.35,
      labelZh: '过度诈唬（进攻里空气占比偏高）',
    },
    UNDERBLUFFER: {
      tightness: 0.62,
      aggression: 0.45,
      bluffTendency: 0.12,
      passivity: 0.5,
      labelZh: '不诈唬型（进攻几乎总是价值）',
    },
    MANIAC: {
      tightness: 0.15,
      aggression: 0.92,
      bluffTendency: 0.9,
      passivity: 0.35,
      labelZh: '疯子（极松极凶，什么牌都可能开火）',
    },
  });

/** 原型可信度（手选画像的可信度上限；与 `QUICK_PROFILE_CONFIDENCE` 同一条纪律） */
export const ARCHETYPE_CONFIDENCE = 0.35;

/* ============================================================
 * 维度构造与合并
 * ============================================================ */

/** 证据层级（**优先级从高到低**：直接观测 > 用户断言 > 群体先验） */
export const TendencyEvidenceTier = {
  /** 实测数据（有手数支撑的维度） */
  MEASURED: 'MEASURED',
  /** 实测 + 原型的可信度加权合并（实测不足但存在） */
  MEASURED_ARCHETYPE_BLEND: 'MEASURED_ARCHETYPE_BLEND',
  /** 只有用户手选画像（**主观断言**，没有实测支撑） */
  USER_ARCHETYPE: 'USER_ARCHETYPE',
  /** 没有任何证据 ⇒ 中立（恒等因子） */
  PRIOR: 'PRIOR',
} as const;
export type TendencyEvidenceTier =
  (typeof TendencyEvidenceTier)[keyof typeof TendencyEvidenceTier];

export const TENDENCY_TIER_ZH: Readonly<Record<TendencyEvidenceTier, string>> = Object.freeze({
  MEASURED: '实测数据（优先）',
  MEASURED_ARCHETYPE_BLEND: '实测 + 手选画像加权合并',
  USER_ARCHETYPE: '用户手选画像（主观判断）',
  PRIOR: '无证据（中立，不做任何调整）',
});

/** 中立的零证据维度（全部落在 0.5，因此任何乘性因子都是 1） */
export function neutralDimensions(): PlayerDimensions {
  return {
    tightness: 0.5,
    aggression: 0.5,
    bluffTendency: 0.5,
    passivity: 0.5,
    confidence: 0,
    sampleSize: 0,
    tier: SampleTier.PRELIMINARY,
  };
}

/**
 * 手选画像 → 维度。
 *
 * @param confidence 该断言的可信度（调用方给；本模块不自己决定上限）
 * @returns `UNKNOWN` 或未知标签时返回 `null`（**没有证据**，而不是「中立证据」）
 */
export function archetypeDimensionsOf(
  quickProfile: QuickProfile | null | undefined,
  confidence: number,
): PlayerDimensions | null {
  if (quickProfile === null || quickProfile === undefined) return null;
  const spec = ARCHETYPE_DIMENSIONS[quickProfile];
  if (spec === undefined || spec === null) return null;

  const clamped = Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0;
  return {
    tightness: spec.tightness,
    aggression: spec.aggression,
    bluffTendency: spec.bluffTendency,
    passivity: spec.passivity,
    confidence: clamped,
    // 手选画像**没有样本**：样本量如实记 0，分层记 PRELIMINARY。
    // 不允许把「用户断言」伪装成「观测了 N 手」。
    sampleSize: 0,
    tier: SampleTier.PRELIMINARY,
  };
}

export type ResolvedTendencyDimensions = {
  dimensions: PlayerDimensions;
  tier: TendencyEvidenceTier;
  /** 实测与手选各自的权重（0..1；合并时相加为 1，未参与的一侧为 0） */
  weights: { measured: number; archetype: number };
  /** 中文说明（必须能解释「为什么用了这一份维度」） */
  noteZh: string;
};

/**
 * 按**证据优先级**解析出用于调整的维度。
 *
 * 规则（刻意简单且可验证）：
 *
 * ```text
 * 实测可信度 ≥ 原型可信度        ⇒ 只用实测（原型被忽略，并如实说明）
 * 0 < 实测可信度 < 原型可信度    ⇒ 按可信度**加权平均**（同一量的两个估计合并）
 * 实测可信度 = 0 且 有手选画像   ⇒ 只用原型
 * 两者都没有                     ⇒ 中立（恒等因子）
 * ```
 *
 * ## 为什么用「加权平均」而不是「两次相乘」
 *
 * 实测维度与原型维度是**同一个量**（这个人的松/凶/诈唬倾向）的两个估计。
 * 对同一个量施加两次乘性调整就是**重复计票**：一个「实测也偏松、画像也说偏松」
 * 的对手会被调整两遍，幅度远超证据支持。
 * 加权平均只产出**一份**维度，因此下游只乘**一次**。
 *
 * ## 为什么实测优先要**严格**按可信度
 *
 * 「有 3 手数据」不足以推翻用户明确的画像断言：3 手的置信度低于 0.35，
 * 此时按权重合并（实测占小头）；而一旦实测可信度追平原型，
 * 原型就完全退出，避免一个过期的主观印象长期污染范围。
 */
export function resolveTendencyDimensions(options: {
  measured: PlayerDimensions;
  measuredConfidence: number;
  quickProfile: QuickProfile | null | undefined;
  archetypeConfidence?: number;
}): ResolvedTendencyDimensions {
  const archetypeConfidence = options.archetypeConfidence ?? ARCHETYPE_CONFIDENCE;
  const archetype = archetypeDimensionsOf(options.quickProfile, archetypeConfidence);
  const measuredConfidence = Number.isFinite(options.measuredConfidence)
    ? Math.max(0, Math.min(1, options.measuredConfidence))
    : 0;

  // ---- 无原型证据 ----
  if (archetype === null) {
    if (measuredConfidence <= 0) {
      return {
        dimensions: neutralDimensions(),
        tier: TendencyEvidenceTier.PRIOR,
        weights: { measured: 0, archetype: 0 },
        noteZh: '没有实测数据，也没有手选画像 ⇒ 维度全中立，范围不做任何画像调整',
      };
    }
    return {
      dimensions: { ...options.measured, confidence: measuredConfidence },
      tier: TendencyEvidenceTier.MEASURED,
      weights: { measured: 1, archetype: 0 },
      noteZh: `使用实测维度（可信度 ${measuredConfidence.toFixed(2)}，样本 ${options.measured.sampleSize}）`,
    };
  }

  // ---- 只有原型 ----
  if (measuredConfidence <= 0) {
    return {
      dimensions: archetype,
      tier: TendencyEvidenceTier.USER_ARCHETYPE,
      weights: { measured: 0, archetype: 1 },
      noteZh:
        `无实测数据，改用用户手选画像原型（可信度上限 ${archetypeConfidence}）—— ` +
        '这是**主观断言**，不是观测',
    };
  }

  // ---- 实测可信度已追平原型：原型退出（避免过期印象长期污染）----
  if (measuredConfidence >= archetypeConfidence) {
    return {
      dimensions: { ...options.measured, confidence: measuredConfidence },
      tier: TendencyEvidenceTier.MEASURED,
      weights: { measured: 1, archetype: 0 },
      noteZh:
        `实测可信度 ${measuredConfidence.toFixed(2)} ≥ 手选画像上限 ${archetypeConfidence} ⇒ ` +
        '**只用实测维度**，手选画像不再参与（证据优先级：观测 > 断言）',
    };
  }

  // ---- 两份证据都弱：按可信度加权平均 ----
  const total = measuredConfidence + archetypeConfidence;
  const wMeasured = total > 0 ? measuredConfidence / total : 0;
  const wArchetype = total > 0 ? archetypeConfidence / total : 0;
  const mix = (a: number, b: number): number => a * wMeasured + b * wArchetype;

  return {
    dimensions: {
      tightness: mix(options.measured.tightness, archetype.tightness),
      aggression: mix(options.measured.aggression, archetype.aggression),
      bluffTendency: mix(options.measured.bluffTendency, archetype.bluffTendency),
      passivity: mix(options.measured.passivity, archetype.passivity),
      /*
       * 合并后的可信度取**两者中较高者**：合并估计比任何单一来源都更有信息量，
       * 但**不叠加**（叠加会凭空制造可信度）。
       */
      confidence: Math.max(measuredConfidence, archetypeConfidence),
      sampleSize: options.measured.sampleSize,
      tier: options.measured.tier,
    },
    tier: TendencyEvidenceTier.MEASURED_ARCHETYPE_BLEND,
    weights: { measured: wMeasured, archetype: wArchetype },
    noteZh:
      `实测可信度 ${measuredConfidence.toFixed(2)} 低于手选画像上限 ${archetypeConfidence} ⇒ ` +
      `按可信度加权合并（实测 ${wMeasured.toFixed(2)} / 手选 ${wArchetype.toFixed(2)}）—— ` +
      '同一量的两个估计只合并一次，不做两次乘性调整',
  };
}
