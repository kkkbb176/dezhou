/**
 * 🔴 **翻后建议器**（2026-09 翻后升级 · P2）
 *
 * 把 P1 的全部模块按使用者给定的**顺序**组装成一条可解释的建议：
 *
 * ```text
 * 1. Legal Actions           （调用方已给）
 * 2. Pot / Stack / SPR       → commitment.ts
 * 3. Hero Hand Role          → relativeHandRole.ts
 * 4. Board Delta             → boardDelta.ts（用 context.postflopFacts.previousBoard）
 * 5. Villain Range Compression → rangeCompression.ts（用 opponentRangeFacts）
 * 6. Multiway Adjustment     → multiway.ts
 * 7. Value / Bluff / Showdown 分类 → valueBetGate.ts
 * 8. Pot Odds / Fold Equity  （既有 math + exploit）
 * 9. Blockers                → blockers.ts
 * 10. Player Profile Exploit → exploit.ts（**最后**，且幅度受上限与可信度约束）
 * 11. Action EV comparison   → evScore.ts
 * 12. Bet sizing             → sizing.ts（**独立一步**）
 * 13. Confidence             → evScore.ts（只看首选比次选好多少）
 * ```
 *
 * ## 两条纪律
 *
 * 1. **顺序不可颠倒**（使用者第二十二节）：画像在**最后**，且**不能覆盖硬数学**。
 * 2. **本模块不做动作决定**：它输出结构化建议与分数，
 *    真正的动作仍由 `decisionEngine` 的 EV 判据产生（保持既有安全网不变）。
 */

import type { DecisionContext } from '../../domain/decision/decision.types.ts';
import { QuickProfile } from '../manualInput/manualInput.ts';
import { PlayerLabel } from '../../domain/player/playerClassifier.ts';
import { describeHand } from '../../domain/poker/handDescription.ts';
import { RelativeHandRole, RELATIVE_ROLE_ZH } from '../../domain/postflop/types.ts';
import { classifyRelativeRole, normalizeRiverRole, roleChangeReasonZh, madeHandClassOf, MADE_HAND_CLASS_ZH, hasShowdownValueOf, type MadeHandClass } from '../../domain/postflop/relativeHandRole.ts';
import { computeBoardDelta, type BoardDelta } from '../../domain/postflop/boardDelta.ts';
import { drawProfileOf } from '../../domain/postflop/draws.ts';
import {
  boardWetnessOf,
  compressionStateOf,
  type RangeCompressionState,
} from '../../domain/postflop/rangeCompression.ts';
import { boardTextureOf } from '../../domain/postflop/boardDelta.ts';
import { multiwayAdjustment, type MultiwayAdjustment } from '../../domain/postflop/multiway.ts';
import { assessCommitment, type CommitmentAssessment } from '../../domain/postflop/commitment.ts';
import {
  assessValueBet,
  roleStrengthOf,
  type ValueBetAssessment,
} from '../../domain/postflop/valueBetGate.ts';
import { assessBlockers, type BlockerAssessment } from '../../domain/postflop/blockers.ts';
import { chooseSizing, elasticityOf, type SizingChoice } from '../../domain/postflop/sizing.ts';
import {
  confidenceOf,
  ActionScoreKind,
  EV_SCORE_DISCLAIMER_ZH,
  type ActionScore,
  type Confidence,
} from '../../domain/postflop/evScore.ts';
import { exploitAdjustmentOf, EXPLOIT_CONFIDENCE_CAP, type ExploitAdjustment } from '../../domain/postflop/exploit.ts';
import { boardRelativeTierOf } from '../../domain/poker/boardRelativeStrength.ts';

export type PostflopAdvice = {
  street: string;
  /**
   * 🔴 **成交牌型**（`MadeHandClass`，RIVER CONSISTENCY V2.1 · P0-1）。
   * 与 `role` 是**两个问题**：「我是什么牌」vs「这手牌相对对手范围是什么角色」。
   */
  madeHand: MadeHandClass;
  madeHandZh: string;
  /** 牌型序号（1..9），供下游映射 */
  category: number;
  role: RelativeHandRole;
  roleZh: string;
  roleStrength: number;
  /**
   * 🔴 **上一街的角色**（历史参考）。
   *
   * 使用者的原话：可以保存 `previousStreetRole = DRAW` 表示「Hero 在转牌曾经是听牌」，
   * 但**当前街**的角色必须根据最终五张公共牌与两张手牌重新确定。
   * 两者是**不同的问题**，因此分开存放（翻牌前 / 无上一街时为 `null`）。
   */
  previousStreetRole: RelativeHandRole | null;
  /** 跨街角色迁移原因（中文；首次判定时为 null） */
  roleChangeReason: string | null;
  boardDelta: BoardDelta | null;
  compression: RangeCompressionState;
  multiway: MultiwayAdjustment;
  commitment: CommitmentAssessment;
  gate: ValueBetAssessment;
  blockers: BlockerAssessment;
  exploit: ExploitAdjustment;
  /** 独立一步的尺寸建议（只在建议主动下注时有意义） */
  sizing: SizingChoice;
  wetness: number;
  scores: readonly ActionScore[];
  confidence: Confidence;
  confidenceGap: number;
  reasonsZh: readonly string[];
  warningsZh: readonly string[];
};

/**
 * 用户手选画像 / 实测标签 → 剥削层的定性词汇。
 *
 * ⚠️ 两个来源**分开标注**，因为性质不同（主观判断 vs 实测证据），
 * 且可信度不同（见返回的 `confidenceScale`）。
 */
export function exploitSourceOf(context: DecisionContext): {
  profile: QuickProfile;
  confidenceScale: number;
  sourceZh: string;
} {
  const player = context.player;
  if (player === null) {
    return { profile: QuickProfile.UNKNOWN, confidenceScale: 0, sourceZh: '没有对手画像' };
  }

  // 证据优先：实测标签（handsObserved > 0）比用户主观判断更可靠
  if (player.handsObserved > 0 && player.label !== PlayerLabel.UNKNOWN) {
    const mapped = mapPlayerLabel(player.label);
    if (mapped !== QuickProfile.UNKNOWN) {
      return {
        profile: mapped,
        confidenceScale: Math.max(0, Math.min(1, player.confidence)),
        sourceZh: `实测标签「${player.label}」（样本 ${player.handsObserved} 手，可信度 ${player.confidence.toFixed(2)}）`,
      };
    }
  }

  // 兜底：用户手选画像（**主观判断**，可信度上限已由 contextBuilder 截断）
  if (player.quickProfile !== null && player.quickProfile !== QuickProfile.UNKNOWN) {
    return {
      profile: player.quickProfile,
      /*
       * 🔴 主观画像的可信度必须**再**被 `EXPLOIT_CONFIDENCE_CAP` 夹一次。
       * 审计实测：`handsObserved > 0` 且标签为 UNKNOWN 时，手选画像会按
       * **实测样本的可信度**缩放（例如 5 手 ⇒ 0.60），绕过了 0.35 的上限 ——
       * 而那 0.60 说的是「实测数据可信」，不是「用户的主观判断可信」。
       */
      confidenceScale: Math.max(0, Math.min(EXPLOIT_CONFIDENCE_CAP, player.confidence)),
      sourceZh: `用户手选画像「${player.quickProfile}」（主观判断，可信度上限 ${Math.min(EXPLOIT_CONFIDENCE_CAP, player.confidence).toFixed(2)}）`,
    };
  }

  return { profile: QuickProfile.UNKNOWN, confidenceScale: 0, sourceZh: '没有可用画像' };
}

/** 实测标签 → 剥削词汇（只映射有明确方向含义的类别） */
function mapPlayerLabel(label: PlayerLabel): QuickProfile {
  switch (label) {
    case PlayerLabel.CALLING_STATION:
      return QuickProfile.CALLING_STATION;
    case PlayerLabel.BLUFF_HEAVY:
      return QuickProfile.BLUFF_HEAVY;
    case PlayerLabel.BLUFF_LIGHT:
      return QuickProfile.UNDERBLUFFER;
    case PlayerLabel.ULTRA_TIGHT:
      return QuickProfile.VERY_TIGHT;
    case PlayerLabel.TIGHT_PASSIVE:
    case PlayerLabel.TIGHT_AGGRESSIVE:
      return QuickProfile.TIGHT;
    case PlayerLabel.LOOSE_PASSIVE:
      return QuickProfile.LOOSE;
    case PlayerLabel.LOOSE_AGGRESSIVE:
      return QuickProfile.LOOSE;
    default:
      return QuickProfile.UNKNOWN;
  }
}

/**
 * 生成翻后建议。**翻前返回 `null`**（本模块只管翻后）。
 */
export function advisePostflop(
  context: DecisionContext,
  options: { facingBet: boolean; requiredEquity: number; potAfterCall: number },
): PostflopAdvice | null {
  const math = context.math;
  const board = context.board;
  const hole = context.heroCards;
  if (board.length < 3 || hole.length !== 2) return null;

  const street = math.street;
  const facingBet = options.facingBet;
  const texture = boardTextureOf(board);
  if (texture === null) return null;
  const wetness = boardWetnessOf(texture);

  const described = describeHand([hole[0]!, hole[1]!], board);
  const draws = drawProfileOf(hole, board);

  // ---- 3. Hero 相对牌力角色 ----
  const facts = context.postflopFacts?.opponentRangeFacts ?? null;
  const rawRole = classifyRelativeRole({
    heroHole: hole,
    board,
    street,
    shape: described.shape,
    category: described.category,
    heroEquity: math.heroEquity,
    requiredEquity: options.requiredEquity,
    spr: math.spr,
    opponentCount: context.realizedOpponentCount,
    facingBet,
    hasInitiative: !facingBet,
    opponentRangeFacts: facts,
    draws,
  });
  /*
   * 🔴 **河牌不变量**（【数学确定】· RIVER CONSISTENCY V2）：
   * 河牌之后没有任何公共牌，「听牌 / 半诈唬」在语义上不可能存在。
   * 分类器本身已经不会产出它们（听牌分支在河牌整段不适用），
   * 这里在**产出侧**再规范化一次 —— 分类器以外还有别的入口。
   */
  const role = normalizeRiverRole({
    street,
    role: rawRole,
    facingBet,
    heroEquity: math.heroEquity,
    requiredEquity: options.requiredEquity,
    spr: math.spr,
    /*
     * 🔴 P0-1：「不知道」不能当成「没有摊牌价值」—— 拿不到范围事实时，
     * 规范化按**有**摊牌价值处理（SHOWDOWN_VALUE，而不是 AIR）。
     */
    hasShowdownValue: hasShowdownValueOf(facts),
  });
  const roleStrength = roleStrengthOf(role);

  /*
   * 🔴 **成交牌型与相对角色分开**（RIVER CONSISTENCY V2.1 · P0-1）：
   * 一个是「我手里是什么」（纯牌型，与对手无关），
   * 一个是「这手牌相对对手范围是什么」（需要范围与权益）。
   */
  const madeHand = madeHandClassOf(described.category);

  /*
   * 🔴 **上一街角色**（历史参考，不是当前身份）。
   *
   * 使用者的原话：「可以保存 previousStreetRole = DRAW 表示 Hero 在 turn 曾经是听牌，
   * 但是 currentStreetRole 必须重新根据最终五张公共牌和两张手牌确定」。
   * 上一街的牌面是 `previousBoard`（比当前少一张），街名由长度决定。
   */
  const previousBoardForRole = context.postflopFacts?.previousBoard ?? [];
  const previousStreet: 'FLOP' | 'TURN' | null =
    previousBoardForRole.length === 3 ? 'FLOP' : previousBoardForRole.length === 4 ? 'TURN' : null;
  const previousStreetRole: RelativeHandRole | null =
    previousStreet === null
      ? null
      : classifyRelativeRole({
          heroHole: hole,
          board: previousBoardForRole,
          street: previousStreet,
          shape: describeHand([hole[0]!, hole[1]!], previousBoardForRole).shape,
          category: describeHand([hole[0]!, hole[1]!], previousBoardForRole).category,
          heroEquity: math.heroEquity,
          requiredEquity: options.requiredEquity,
          spr: math.spr,
          opponentCount: context.realizedOpponentCount,
          facingBet,
          hasInitiative: !facingBet,
          opponentRangeFacts: facts,
          draws,
        });

  // ---- 4. Board Delta ----
  const previousBoard = context.postflopFacts?.previousBoard ?? [];
  const previousTier =
    previousBoard.length >= 3 ? boardRelativeTierOf(hole, previousBoard) : null;
  const boardDelta = computeBoardDelta({
    previousBoard,
    board,
    heroHole: hole,
    street,
    rangeFacts: context.postflopFacts?.opponentRangeFacts ?? null,
    previousTier,
  });

  // ---- 5. 范围压缩 ----
  /*
   * ⚠️ 画像**必须**带上可信度：否则 `profileCompressionMultiplier` 会在
   * 可信度 0 时仍然改变动作，而同一份输出里还打印「不做任何画像调整」
   *（对抗性审计抓到的「文案与行为相反」）。这里用 **同一份** `exploitSource`，
   * 与 exploit 偏移量共享同一个可信度来源。
   */
  const exploitSource = exploitSourceOf(context);
  const compressionInput = {
    betRatioToPot: math.pot > 0 && math.callCost > 0 ? math.callCost / math.pot : facingBet ? 0.6 : 0.5,
    street,
    opponentCount: context.realizedOpponentCount,
    quickProfile: exploitSource.profile,
    profileConfidence: exploitSource.confidenceScale,
    wetness,
    aggressive: facingBet,
  };
  const compression = compressionStateOf(
    compressionInput,
    facts === null
      ? null
      : {
          strongShare: facts.strongShare,
          drawShare: facts.drawShare,
          meanTier: facts.meanTier,
          /*
           * 🔴 弱尾质量取自**真实直方图**（档 ≥4 的占比）。修复前「强度下限」
           * 由 `strongShare` 派生 ⇒ 成对/成花牌面上饱和到 1.0，把下游
           * 「更差的牌会跟」压到 0，导致坚果牌拒不下注（见 `rangeFacts.ts`）。
           */
          weakShare: (facts.tierHistogram[4] ?? 0) + (facts.tierHistogram[5] ?? 0),
        },
  );

  // ---- 6. 多人调整 ----
  const multiway = multiwayAdjustment(context.realizedOpponentCount);

  // ---- 2. SPR / 承诺 ----
  const commitment = assessCommitment({
    spr: math.spr,
    remainingAfterCall: Math.max(0, math.myRemainingStack - math.callCost),
    potAfterCall: options.potAfterCall,
    onePairOrBetter: described.category >= 2,
    roleStrength,
    /*
     * 🔴 河牌没有下一街 ⇒ `futureStreetCommitmentBonus` 恒为 0
     *（【数学确定】· RIVER CONSISTENCY V2 §13）。
     */
    street,
  });

  // ---- 10. 画像（**在价值判断之前算出来，但只在最后应用**）----
  const exploit = exploitAdjustmentOf(exploitSource.profile, {
    facingLargeAggression: facingBet && math.pot > 0 && math.callCost / math.pot >= 0.66,
    drawCompleted: boardDelta?.flushCompleted === true || boardDelta?.straightCompleted === true,
  });
  /*
   * 偏移幅度按来源可信度缩放 —— 这是使用者第十九节「小样本玩家画像不得
   * 导致过度剥削」的落地：可信度 0 ⇒ 偏移为 0（等于没有画像）。
   */
  const scale = exploitSource.confidenceScale;
  const scaledExploit: ExploitAdjustment = {
    ...exploit,
    thinValueDelta: exploit.thinValueDelta * scale,
    bluffCatchDelta: exploit.bluffCatchDelta * scale,
    bluffDelta: exploit.bluffDelta * scale,
    sizingMultiplier: 1 + (exploit.sizingMultiplier - 1) * scale,
  };

  // ---- 7. 价值 / 诈唬 / 摊牌分类 ----
  const gate = assessValueBet({
    role,
    heroEquity: math.heroEquity ?? 0,
    opponentCount: context.realizedOpponentCount,
    compression,
    wetness,
    spr: math.spr,
    hasInitiative: !facingBet,
    thinValueDelta: scaledExploit.thinValueDelta,
    bluffDelta: scaledExploit.bluffDelta,
    protectionRelevant: wetness > 0.4 || (facts?.drawShare ?? 0) > 0.25,
    /*
     * 🔴 「有哪些更差的牌会跟 / 更好的牌会继续」是**相对于我这手牌**的问题，
     * 只有范围层与我这手牌的精确比较能回答（审计 CRITICAL）。
     */
    rangeComparison:
      facts === null
        ? null
        : { weakerShare: facts.weakerShare, strongerShare: facts.strongerShare },
    /*
     * 🔴 河牌没有补牌 ⇒ 保护收益必然为 0（审计抓到的非单调来源之一）。
     */
    hasCardsToCome: street !== 'RIVER',
  });

  // ---- 9. 阻断牌（**基于可达范围的双向分析**）----
  const blockers = assessBlockers({
    board,
    heroHole: hole,
    shape: described.shape,
    nutDensity: compression.nutDensity,
    airDensity: compression.airDensity,
    /*
     * 🔴 阻断牌**必须**基于可达范围（使用者 §11）：从 1326 个组合里数
     * 是另一回事。这里把范围的真实组成（逐档直方图 + 组合数）传下去，
     * 由 `blockers.ts` 逐组合计数「Hero 手里的牌挡掉了他多少价值/诈唬组合」。
     */
    rangeFacts:
      facts === null
        ? null
        : {
            strongerShare: facts.strongerShare,
            weakerShare: facts.weakerShare,
            tierHistogram: facts.tierHistogram,
            supportSize: facts.supportSize,
          },
    heroEquity: math.heroEquity,
    street,
  });

  // ---- 11. 动作 EV 比较（启发式分数）----
  const scores: ActionScore[] = [];
  const potOddsEquity = options.requiredEquity;
  const equity = math.heroEquity;
  if (facingBet) {
    const edge = equity === null ? null : equity - potOddsEquity;
    /*
     * 跟注分：权益优势 + 抓诈唬价值（含画像偏移）。**硬数学仍由 decisionEngine 判**——
     * 这里只产出相对分数，用于比较与置信度。
     */
    const callScore =
      edge === null
        ? 0
        : Math.max(
            0,
            Math.min(
              1,
              0.5 +
                edge * 1.2 +
                (role === RelativeHandRole.BLUFF_CATCHER ? 0.1 : 0) +
                scaledExploit.bluffCatchDelta +
                blockers.callDelta,
            ),
          );
    scores.push({ action: ActionScoreKind.CALL, normalizedEVScore: callScore });
    scores.push({ action: ActionScoreKind.RAISE, normalizedEVScore: Math.max(0, Math.min(1, roleStrength * 0.8 + commitment.commitmentScore * 0.2)) });
    scores.push({ action: ActionScoreKind.FOLD, normalizedEVScore: Math.max(0, 1 - callScore) });
  } else {
    scores.push({ action: ActionScoreKind.CHECK, normalizedEVScore: gate.estimatedCheckEVScore });
    scores.push({ action: ActionScoreKind.BET_SMALL, normalizedEVScore: gate.estimatedBetEVScore * 0.95 });
    scores.push({ action: ActionScoreKind.BET_MEDIUM, normalizedEVScore: gate.estimatedBetEVScore });
    scores.push({ action: ActionScoreKind.BET_LARGE, normalizedEVScore: Math.max(0, gate.estimatedBetEVScore - 0.08) });
  }
  /*
   * 🔴 **置信度按「动作族」比较**（审计抓到的缺陷）。
   *
   * 第一版直接拿前三名比：`BET_SMALL = 0.95 × BET_MEDIUM` 意味着只要下注分
   * 最高，前两名必然是 `BET_MEDIUM` 与 `BET_SMALL`，分差 ≤ 0.05 < 0.06
   * ⇒ **置信度恒为 LOW**（实测 CLEAR_VALUE、bet 0.69 vs check 0.24 也是 LOW）。
   * 那不是「不确定」，而是把「尺寸之间的微小差别」误当成了「动作之间的不确定」。
   *
   * 现在：先把分数按**动作族**（CHECK / BET / CALL / RAISE / FOLD）取最大，
   * 再比较前两名族 —— 这才是使用者定义的「首选动作比第二选择好多少」。
   */
  const familyOf = (action: string): string => (action.startsWith('BET') ? 'BET' : action);
  const bestPerFamily = new Map<string, number>();
  for (const score of scores) {
    const family = familyOf(score.action);
    bestPerFamily.set(family, Math.max(bestPerFamily.get(family) ?? 0, score.normalizedEVScore));
  }
  const familyConfidence = confidenceOf(
    [...bestPerFamily.entries()].map(([action, normalizedEVScore]) => ({
      action: action as ActionScoreKind,
      normalizedEVScore,
    })),
  );

  // ---- 12. 独立尺寸选择 ----
  /*
   * 🔴 **坚果优势与范围优势都必须相对于我这手牌**（审计修复）。
   *
   * 修复前：`nutAdvantage = 角色强度 − strongShare`。成对/成花牌面上
   * `strongShare` 饱和到 1.0 ⇒ 拿坚果时坚果优势 = **0** ⇒ 尺寸被压到最小
   * （审计实测坚果同花的 verdict 是 NOT_VALUE + 尺寸 0）。
   * 现在改用「他的范围里**比我好**的质量」（精确比较）：拿坚果时它接近 0
   * ⇒ 坚果优势接近满值。
   */
  const strongerShare = facts === null ? Math.max(0, 1 - (equity ?? 0.5)) : facts.strongerShare;
  const sizing = chooseSizing({
    nutAdvantage: Math.max(0, Math.min(1, roleStrength - strongerShare)),
    rangeAdvantage: Math.max(0, Math.min(1, (equity ?? 0.5) - strongerShare)),
    wetness,
    valueThickness: roleStrength,
    bluffShare: role === RelativeHandRole.PURE_BLUFF || role === RelativeHandRole.SEMI_BLUFF ? 0.7 : 0.15,
    spr: math.spr,
    opponentCount: context.realizedOpponentCount,
    elasticity: elasticityOf(compression),
    sizingCap: commitment.sizingCap,
    exploitMultiplier: scaledExploit.sizingMultiplier,
    protectionWeight: gate.protectionBenefit,
  });

  // ---- 13. 组装理由 ----
  const reasonsZh: string[] = [];
  const warningsZh: string[] = [];

  reasonsZh.push(
    `相对牌力角色：**${RELATIVE_ROLE_ZH[role]}**（形状 ${described.shape}，` +
      `对全部已实现对手权益 ${equity === null ? '未知' : (equity * 100).toFixed(1) + '%'}）` +
      (previousStreetRole === null
        ? ''
        : `；上一街角色（历史参考）「${RELATIVE_ROLE_ZH[previousStreetRole]}」`),
  );
  if (previousStreetRole !== null && previousStreetRole !== role) {
    reasonsZh.push(
      `跨街角色迁移：上一街「${RELATIVE_ROLE_ZH[previousStreetRole]}」⇒ 本街「${RELATIVE_ROLE_ZH[role]}」` +
        (street === 'RIVER' && previousStreetRole === RelativeHandRole.DRAW
          ? '（**河牌没有未来公共牌**：「听牌」是上一街的身份，当前牌力按最终五张公共牌重算）'
          : ''),
    );
  }
  const changeReason = roleChangeReasonZh({
    previous: previousStreetRole,
    current: role,
    delta: null,
    equityBefore: null,
    equityAfter: equity,
  });
  reasonsZh.push(changeReason);
  if (boardDelta !== null) {
    const parts: string[] = [];
    if (boardDelta.flushCompleted) parts.push('这张牌让同花成为可能');
    if (boardDelta.straightCompleted) parts.push('这张牌让顺子成为可能');
    if (boardDelta.fourToFlush) parts.push('牌面已有四张同花');
    if (boardDelta.overcardImpact > 0.3) parts.push(`新牌高于原牌面（${boardDelta.overcardImpact.toFixed(2)}）`);
    if (boardDelta.pairedBoard) parts.push('牌面已成对');
    if (parts.length > 0) {
      reasonsZh.push(`牌面变化：${parts.join('；')}（白板度 ${boardDelta.blankScore.toFixed(2)}）`);
    } else {
      reasonsZh.push(`牌面接近空白（白板度 ${boardDelta.blankScore.toFixed(2)}）—— **不因此恢复牌力**`);
    }
    if (boardDelta.villainRangeImprovement !== null) {
      reasonsZh.push(`对手范围与新牌面适配度 ${boardDelta.villainRangeImprovement.toFixed(2)}`);
    }
  }
  /*
   * 🔴 **评分与概率必须分开措辞**（使用者 §14）。
   *
   * 下面这几个数是 **0..1 的启发式评分**（归一化标尺），**不是**概率：
   * 「坚果密度 0.76」不表示「他有 76% 的概率是坚果」。
   * 真正是**占比**的量（更差 / 更好 / 逐档质量）在 `rangeFacts` 里，
   * 它们同时带有**分母**（可达组合数 `supportSize`）。
   */
  reasonsZh.push(
    `对手范围压缩（**内部评分，不是概率**）：强度下限评分 ${compression.strengthFloor.toFixed(2)}、` +
      `坚果密度评分 ${compression.nutDensity.toFixed(2)}、空气密度评分 ${compression.airDensity.toFixed(2)}` +
      `（进攻可信度 ${compression.aggressionCredibility.toFixed(2)}）`,
  );
  if (facts !== null) {
    reasonsZh.push(
      `可达范围占比（**分母 = ${facts.supportSize} 个组合**）：比我这手更差 ${(facts.weakerShare * 100).toFixed(1)}%、` +
        `打平 ${(facts.equalShare * 100).toFixed(1)}%、更好 ${(facts.strongerShare * 100).toFixed(1)}%`,
    );
  }
  if (multiway.multiwayStrengthPenalty > 0) {
    reasonsZh.push(
      `多人池（${context.realizedOpponentCount} 家）：强度惩罚 ${multiway.multiwayStrengthPenalty.toFixed(3)}、` +
        `诈唬惩罚 ${multiway.multiwayBluffPenalty.toFixed(3)}、价值门槛抬高 ${multiway.multiwayValueThresholdAdjustment.toFixed(3)}`,
    );
  }
  reasonsZh.push(
    `价值判断：${gate.verdict}（下注偏好分 ${gate.estimatedBetEVScore.toFixed(2)} vs 过牌偏好分 ${gate.estimatedCheckEVScore.toFixed(2)}，` +
      '**内部评分，不是 EV**）',
  );
  reasonsZh.push(...gate.reasonsZh);
  reasonsZh.push(commitment.noteZh);
  if (street === 'RIVER') {
    reasonsZh.push(
      '河牌口径：未来补牌保护分 = **0**（没有补牌）；未来街承诺加分 = **0**（没有下一街）—— ' +
        '本次动作只由当前节点的赔率、牌力、可达范围、阻断牌与偏好分决定',
    );
  }
  reasonsZh.push(...blockers.reasonsZh);
  if (scaledExploit.applied && scale > 0) {
    reasonsZh.push(`画像来源：${exploitSource.sourceZh}；偏移按可信度缩放 ×${scale.toFixed(2)}`);
    reasonsZh.push(...scaledExploit.reasonsZh);
  } else if (exploit.applied && scale === 0) {
    warningsZh.push(
      `有画像「${exploitSource.profile}」但**可信度为 0** ⇒ 剥削偏移被缩放到 0（不做任何画像调整）`,
    );
  }
  /*
   * ⚠️ 尺寸建议只在**无人下注**（我可能主动下注）时有意义。面对下注时
   * 输出一个「下注尺寸」会让使用者以为系统在建议下注 —— 那是口径混淆。
   */
  if (!facingBet) {
    reasonsZh.push(`尺寸建议：${(sizing.gridRatio * 100).toFixed(0)}% 底池 —— ${sizing.reasonsZh.join('；')}`);
  } else {
    reasonsZh.push(
      `面对下注：本节点可选项是跟注/加注/弃牌；尺寸建议（${(sizing.gridRatio * 100).toFixed(0)}% 底池）仅供「若改为主动下注」参考`,
    );
  }
  warningsZh.push(EV_SCORE_DISCLAIMER_ZH);

  return {
    street,
    madeHand,
    madeHandZh: MADE_HAND_CLASS_ZH[madeHand],
    category: described.category,
    role,
    roleZh: RELATIVE_ROLE_ZH[role],
    roleStrength,
    previousStreetRole,
    roleChangeReason: changeReason,
    boardDelta,
    compression,
    multiway,
    commitment,
    gate,
    blockers,
    exploit: scaledExploit,
    sizing,
    wetness,
    scores: Object.freeze(scores),
    confidence: familyConfidence.level,
    confidenceGap: familyConfidence.gap,
    reasonsZh: Object.freeze(reasonsZh),
    warningsZh: Object.freeze(warningsZh),
  };
}
