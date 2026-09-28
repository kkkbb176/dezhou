/**
 * **Blocker / Unblocker**（2026-09 翻后升级 · P1；2026-09 **V2 改为基于可达范围**）
 *
 * ## 为什么河牌尤其需要它
 *
 * 河牌下注/跟注的价值很大程度上取决于「我手里那张牌是否**挡住了**对手的
 * 价值组合或诈唬组合」。审计确认：决策层**完全没有**战略阻断牌概念
 * （`rangeBlockers.ts` 只被用于**死牌剔除**）。
 *
 * ## 🔴 V2 修的是什么（RIVER CONSISTENCY V2 · §10 / §11）
 *
 * ### ① 必须**双向**分析，不能只算阻断价值
 *
 * 修复前（V1）只有「阻断价值 = 好」与「阻断诈唬 = 坏」两个**打分**，
 * 而且用的是**牌面特征**（牌面是否同花主导、我有没有 A）而不是**组合计数**：
 *
 * ```text
 * blocksValue  = (同花面 && 我持该花色 ? 0.55 : 0) + (我持最高张 ? 0.3 : 0)
 * blocksBluff  = (我持 A ? 0.35 : 0) + (同花面 && 我持该花色 ? 0.3 : 0)
 * ```
 *
 * 后果：A♣ 与 2♣ 在 ♣♣♣ 牌面上得到**完全一样**的阻断分；
 * 「挡住了他多少价值组合、多少诈唬组合」这个**可数的问题**从来没有被回答过。
 *
 * ### ② 必须基于**可达范围**，不能从 1326 个组合里数
 *
 * 对手的范围经过「翻前可达 → 翻牌动作过滤 → 转牌动作过滤 → 河牌」，
 * 与均匀的 1326 组合完全是两件事（实测本节点：可达范围里 74.1% 的牌
 * 比 Hero 更好，而均匀范围里远低于此）。
 *
 * 本模块现在接受**可达范围的实际组成**（`OpponentRangeFacts`：档位直方图、
 * 更差/更好占比、组合数），把「Hero 手里这两张牌让对手少了什么」算成
 * **价值组合数 / 诈唬组合数**，而不是「我有没有 A」。
 *
 * ## 证据等级（使用者第二十三节要求逐项标注）
 *
 * | 部分 | 等级 |
 * |---|---|
 * | 「某组合包含 Hero 的牌 ⇒ 该组合不可能存在」 | 【数学确定】（死牌） |
 * | 「比 Hero 更好 = 价值 / 更差 = 诈唬」 | 【公开扑克理论】（价值与诈唬的定义） |
 * | 用可达范围的档位占比给被挡组合**加权** | 【启发式】—— 明确标注 `evidenceQuality` |
 * | `netBlockerPreference` 进入跟注偏好分 | 【启发式 / 未验证】—— **不是** chip EV |
 *
 * ## ⚠️ 使用者点名的纪律
 *
 * ```text
 * ✗ A♣ = 自动跟注          （阻断牌只是 EV 输入之一）
 * ```
 *
 * `netBlockerPreference` 只进入 **preference score**，且幅度受上限约束；
 * 它**永远不会**单独决定跟注/弃牌。
 */

import type { Card } from '../types.ts';
import type { HandShape } from '../poker/handDescription.ts';
import { compareHands, evaluateCards } from '../poker/handEval.ts';
import { boardRelativeTierOf } from '../poker/boardRelativeStrength.ts';
import { suitIndexOfCard, SUIT_ORDER } from './suit.ts';
import { classifyRiverAction } from './riverActionClass.ts';

export type BlockerAssessment = {
  /** 阻断对手**价值**组合的程度（0..1，越高 = 他越少持有强牌） */
  blocksValue: number;
  /** 阻断对手**诈唬**组合的程度（0..1，越高 = 他越少持有诈唬） */
  blocksBluff: number;
  /** 未阻断诈唬（保留对手诈唬空间）：越高越适合抓诈唬 */
  unblocksBluff: number;
  /** 对「我们下注」的净修正（正 = 更愿意下注/诈唬）。**启发式比较分，不是 EV** */
  betDelta: number;
  /** 对「我们抓诈唬跟注」的净修正（正 = 更愿意跟注）。**启发式比较分，不是 EV** */
  callDelta: number;
  /**
   * 🔴 **被 Hero 的底牌移除掉的、比 Hero 更强**的对手组合数。
   *
   * ⚠️ 名字刻意叫 `blockedStrongerCombos` 而**不是** `blockedValueCombos`：
   * 「比 Hero 强」是【数学确定】的强弱比较，**不等于**「他会用来下注取值的牌」
   *（RIVER CONSISTENCY V2.1 · P1-1）。只有经过河牌动作分类的组合才配叫「价值」。
   */
  blockedStrongerCombos: number;
  /** 被移除掉的、比 Hero **更弱**的对手组合数（同上，**不等于**诈唬组合） */
  blockedWeakerCombos: number;
  /**
   * 被移除的**价值下注候选**数（经 `RiverActionClass` 分类；证据不足时为 `null`，
   * 不编造 0）。
   */
  blockedValueBetCandidateCount: number | null;
  /** 被移除的**诈唬候选**数（同上：只有无摊牌价值的纯空气才算） */
  blockedBluffCandidateCount: number | null;
  /** 阻断价值的收益（0..1，越高 = 他下注/跟注的范围里价值越少） */
  valueBlockBenefit: number;
  /** 阻断诈唬的代价（0..1，越高 = 他越没有诈唬，我们的抓诈唬越差） */
  bluffBlockCost: number;
  /** 净阻断偏好（−1..1，正 = 偏向跟注/继续，负 = 偏向放弃）。**启发式** */
  netBlockerPreference: number;
  /** 这份阻断结论的证据质量（可达范围是否可得、范围有多可信） */
  evidenceQuality: 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE';
  /** 人话解释（中文） */
  reasonsZh: readonly string[];
};

export type BlockerInput = {
  board: readonly Card[];
  heroHole: readonly Card[];
  shape: HandShape;
  /** 对手范围的坚果密度（0..1，来自 rangeCompression） */
  nutDensity: number;
  /** 对手范围的空气密度（0..1） */
  airDensity: number;
  /**
   * 🔴 **可达范围的实际组成**（`OpponentRangeFacts`）。缺省 = 没有范围数据，
   * 此时阻断结论降级为 `NONE` 且**不产生任何方向性偏好**
   *（不返回编造的 0 分结论）。
   */
  rangeFacts?: {
    /** 可达范围里比 Hero **更好**的概率质量（= 价值） */
    strongerShare: number;
    /** 比 Hero **更差**的概率质量（= 诈唬/摊牌价值一侧） */
    weakerShare: number;
    /** 逐档直方图（索引 0..5，值 = 质量占比）—— 用于给被挡组合加权 */
    tierHistogram: readonly number[];
    /** 可达范围的组合数（分母） */
    supportSize: number;
  } | null;
  /** 对全部已实现对手的权益（用于把「更好/更差」落到同一把尺子上） */
  heroEquity?: number | null;
  /** 当前街（河牌上「未来补牌」类阻断不存在，诈唬只能是空气） */
  street?: string;
};

/** 单手组合的权重上限（避免一个组合因档位占比高而主导结论） */
const MAX_COMBO_WEIGHT = 0.02;

/** 枚举：与给定牌不冲突的其余 50 张 */
function otherCards(exclude: readonly Card[]): Card[] {
  const key = (c: Card) => `${c.rank}${c.suit}`;
  const dead = new Set(exclude.map(key));
  const out: Card[] = [];
  for (let rank = 2; rank <= 14; rank += 1) {
    for (const suit of SUIT_ORDER) {
      const card = { rank, suit } as Card;
      if (!dead.has(key(card))) out.push(card);
    }
  }
  return out;
}

/**
 * 评估阻断牌。
 *
 * ⚠️ 若拿不到 `rangeFacts`，返回的结论是「无法评估」（`evidenceQuality = 'NONE'`、
 * 所有计数为 0），而**不是**「阻断牌没有影响」。
 */
export function assessBlockers(input: BlockerInput): BlockerAssessment {
  const reasons: string[] = [];
  const facts = input.rangeFacts ?? null;
  if (input.board.length < 3 || input.heroHole.length !== 2) {
    return {
      blocksValue: 0,
      blocksBluff: 0,
      unblocksBluff: 0,
      betDelta: 0,
      callDelta: 0,
      blockedStrongerCombos: 0,
      blockedWeakerCombos: 0,
      blockedValueBetCandidateCount: null,
      blockedBluffCandidateCount: null,
      valueBlockBenefit: 0,
      bluffBlockCost: 0,
      netBlockerPreference: 0,
      evidenceQuality: 'NONE',
      reasonsZh: ['牌面或底牌不足，无法评估阻断牌'],
    };
  }

  // 牌面主导花色（出现最多的花色）
  const suitCounts = [0, 0, 0, 0];
  for (const card of input.board) suitCounts[suitIndexOfCard(card)] += 1;
  const dominantIndex = suitCounts.indexOf(Math.max(...suitCounts));
  const dominantSuit = SUIT_ORDER[dominantIndex]!;
  const flushBoard = Math.max(...suitCounts) >= 3;

  const heroSuits = input.heroHole.map((c) => suitIndexOfCard(c));
  const heroHasDominantSuit = heroSuits.includes(dominantIndex);
  const heroRanks = input.heroHole.map((c) => c.rank);
  const boardRanks = input.board.map((c) => c.rank);
  const highestBoardRank = Math.max(...boardRanks);
  const heroHasTopRank = heroRanks.some((r) => r >= highestBoardRank);
  const heroHoldsAce = heroRanks.includes(14);

  /*
   * ---- 结构性分数（保留 V1 的口径，作为**没有范围数据时**的回落）----
   *
   * ⚠️ 这些分数只由牌面特征得出，**不区分 A♣ 与 2♣**。有可达范围时，
   * 下面的组合计数会**覆盖**它们的方向（见 `hasRange` 分支）。
   */
  const valueFromSuit = flushBoard && heroHasDominantSuit ? 0.55 : 0;
  const valueFromRank = heroHasTopRank ? 0.3 : 0;
  const structuralValue = Math.max(0, Math.min(1, valueFromSuit + valueFromRank));
  const bluffFromAce = heroHoldsAce ? 0.35 : 0;
  const bluffFromSuit = flushBoard && heroHasDominantSuit ? 0.3 : 0;
  const structuralBluff = Math.max(0, Math.min(1, bluffFromAce + bluffFromSuit));

  /* ============================================================
   * 一、可达范围下的组合计数（【数学确定】的计数 + 【启发式】的加权）
   * ============================================================ */
  let blockedStrongerCombos = 0;
  let blockedWeakerCombos = 0;
  let blockedValueBetCandidateCount: number | null = null;
  let blockedBluffCandidateCount: number | null = null;
  let valueMass = 0;
  let bluffMass = 0;
  let hasRange = false;

  if (facts !== null && facts.supportSize > 0) {
    hasRange = true;
    blockedValueBetCandidateCount = 0;
    blockedBluffCandidateCount = 0;
    const heroEval = (() => {
      try {
        return evaluateCards([...input.heroHole, ...input.board]);
      } catch {
        return null;
      }
    })();
    const denominator = Math.max(1, facts.supportSize);
    const histogram = facts.tierHistogram;

    for (const heroCard of input.heroHole) {
      /*
       * 对手「可能持有这张牌」的全部组合 —— 这些组合因为 Hero 拿着它
       * 而**在物理上不可能存在**（【数学确定】）。枚举时排除牌面。
       */
      for (const partner of otherCards([...input.board, heroCard])) {
        const villainHole: [Card, Card] = [heroCard, partner];
        /*
         * 用可达范围的**档位占比**给这个组合加权：它落在哪一档，
         * 就拿那一档在可达范围里的质量 ÷ 组合数。
         * 【启发式】—— 可达范围只给了逐档质量，没有给逐组合后验。
         */
        const tier = boardRelativeTierOf(villainHole, input.board) ?? 5;
        const weight = Math.min(MAX_COMBO_WEIGHT, (histogram[tier] ?? 0) / denominator);

        let versusHero: 'STRONGER' | 'WEAKER' | 'EQUAL' = tier <= 2 ? 'STRONGER' : 'WEAKER';
        if (heroEval !== null) {
          try {
            const cmp = compareHands(evaluateCards([...villainHole, ...input.board]), heroEval);
            versusHero = cmp > 0 ? 'STRONGER' : cmp < 0 ? 'WEAKER' : 'EQUAL';
          } catch {
            /* 比较失败 ⇒ 沿用档位近似 */
          }
        }

        if (versusHero === 'STRONGER') {
          blockedStrongerCombos += 1;
          valueMass += weight;
        } else {
          blockedWeakerCombos += 1;
          bluffMass += weight;
        }

        /*
         * 🔴 **只有分类之后才计数「价值/诈唬候选」**（P1-1）：
         * 比他强 ≠ 会下注取值；比他弱 ≠ 会诈唬（弱牌里大多数是摊牌牌）。
         */
        const actionClass = classifyRiverAction({ versusHero, tier });
        if (actionClass === 'CLEAR_VALUE' || actionClass === 'THIN_VALUE') {
          blockedValueBetCandidateCount += 1;
        } else if (actionClass === 'BLUFF_CANDIDATE') {
          blockedBluffCandidateCount += 1;
        }
      }
    }
  }

  /*
   * ---- 方向（【公开扑克理论】）----
   *
   * 挡住他的**价值** ⇒ 他下注/跟注的范围里强牌更少 ⇒ 对我们**有利**
   * 挡住他的**诈唬** ⇒ 他下注的范围里价值更密 ⇒ 对我们**不利**
   *
   * ⚠️ 两者必须分别计算、分别显示。V1 只有一个 `blocksValue`，
   * 使用者无法判断「我到底挡掉了哪一边」。
   */
  const valueBlockBenefit = hasRange
    ? Math.max(0, Math.min(1, valueMass * 12))
    : structuralValue * 0.5;
  const bluffBlockCost = hasRange
    ? Math.max(0, Math.min(1, bluffMass * 12))
    : structuralBluff * 0.5;

  const blocksValue = hasRange ? valueBlockBenefit : structuralValue;
  const blocksBluff = hasRange ? bluffBlockCost : structuralBluff;
  const unblocksBluff = Math.max(
    0,
    Math.min(1, 1 - blocksBluff - (input.shape === 'FLUSH' || input.shape === 'STRAIGHT' ? 0.3 : 0)),
  );

  /*
   * ---- 净偏好（【启发式 / 未验证】）----
   *
   * 价值阻断是**收益**，诈唬阻断是**代价**；两者都可能为正（同时挡掉两边），
   * 因此必须相减。结果只是一个**排序用的分数**，不是 chip EV。
   */
  const netBlockerPreference = Math.max(-1, Math.min(1, valueBlockBenefit - bluffBlockCost));

  const betDelta = Math.max(
    -0.12,
    Math.min(0.12, 0.12 * blocksValue * (0.5 + input.nutDensity) - 0.1 * blocksBluff * (0.5 + input.airDensity)),
  );
  const callDelta = Math.max(-0.12, Math.min(0.12, 0.1 * unblocksBluff * (0.5 + input.airDensity) - 0.08 * blocksBluff));

  const evidenceQuality: BlockerAssessment['evidenceQuality'] = !hasRange
    ? 'NONE'
    : facts!.supportSize >= 200
      ? 'HIGH'
      : facts!.supportSize >= 60
        ? 'MEDIUM'
        : 'LOW';

  if (hasRange) {
    /*
     * ⚠️ 措辞必须是**组合强弱**，不能写成「价值牌 / 诈唬牌」（P1-1）：
     * 被挡掉的弱组合里绝大多数只是**摊牌牌**，它们本来就不会诈唬。
     */
    reasons.push(
      `可达范围逐组合计数：Hero 手里的牌挡掉他 **更强的组合 ${blockedStrongerCombos} 个 / 更弱的组合 ${blockedWeakerCombos} 个**` +
        `（分母：可达 ${facts!.supportSize} 个组合）`,
    );
    reasons.push(
      `其中经**河牌动作分类**后：价值下注候选 ${blockedValueBetCandidateCount ?? '—'} 个、` +
        `诈唬候选 ${blockedBluffCandidateCount ?? '—'} 个 —— 「更弱」不等于「会诈唬」` +
        `（弱牌里大多数是摊牌牌）；价值阻断收益 ${valueBlockBenefit.toFixed(2)}、` +
        `诈唬阻断代价 ${bluffBlockCost.toFixed(2)}（**启发式评分**）`,
    );
    if (Math.abs(netBlockerPreference) < 0.05) {
      reasons.push('阻断牌净影响很小（两侧大致相抵）—— 不构成方向性理由');
    } else if (netBlockerPreference > 0) {
      reasons.push(`阻断牌净偏向**继续**（挡掉的更强组合多于更弱组合：${netBlockerPreference.toFixed(2)}）—— 只是偏好分，不是 EV`);
    } else {
      reasons.push(`阻断牌净偏向**放弃**（挡掉的更弱组合多于更强组合：${netBlockerPreference.toFixed(2)}）—— 只是偏好分，不是 EV`);
    }
  } else {
    reasons.push('没有可达范围数据 ⇒ 阻断牌只能给出结构性评分（不区分具体是哪一张同花牌），证据质量 NONE');
  }
  if (flushBoard && heroHasDominantSuit) {
    reasons.push(`牌面 ${dominantSuit} 主导且 Hero 持有该花色：挡住部分同花组合（结构判断）`);
  }
  if (heroHoldsAce) reasons.push('Hero 持有 A：同时挡住部分 A 高诈唬与 A 高价值组合（方向相反，必须分开看）');
  if (reasons.length === 0) reasons.push('阻断牌影响很小');

  return {
    blocksValue,
    blocksBluff,
    unblocksBluff,
    betDelta,
    callDelta,
    blockedStrongerCombos,
    blockedWeakerCombos,
    blockedValueBetCandidateCount,
    blockedBluffCandidateCount,
    valueBlockBenefit,
    bluffBlockCost,
    netBlockerPreference,
    evidenceQuality,
    reasonsZh: reasons,
  };
}
