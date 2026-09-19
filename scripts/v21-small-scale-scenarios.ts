/**
 * V2.1 第一轮 —— 画像决策小规模验证（12 个代表场景）
 *
 * ## 这个脚本回答什么
 *
 * 「玩家画像在**有依据**的情况下，是否改善中低级别现金局决策？」
 * 做法：对每个场景跑**两次**真实生产入口，只改一个东西 ——
 * `villain.quickProfile`（中性 vs 有依据的画像），其余逐位相同。
 *
 * ## 生产入口（与界面 / `/api/analyze` 同一条路）
 *
 * ```text
 * analyzeManualHand（决策）
 *   └─ buildDecisionContext
 *        ├─ behaviorProfileOf(quickProfile)          ← 画像
 *        ├─ estimateUnifiedActionLikelihood(...)     ← 画像 → 动作似然
 *        ├─ riverComboClassOf(...)                   ← 类别 + 档位（单一来源）
 *        ├─ updateRange(likelihoods)                 ← 似然 → 对手范围
 *        ├─ opponentRangeFactsOf(range)              ← 范围 → 类别质量
 *        ├─ computeHeroEquity(...)                   ← 范围 → 权益
 *        ├─ buildBetDecisionFacts(range)             ← 范围 → Fold/Call/Raise
 *        └─ valueBetGate / decisionEngine             ← → 动作与尺度
 * ```
 *
 * ⚠️ 本脚本**不**直接调用 `estimateUnifiedActionLikelihood` 断言它「能输出不同数字」——
 * 那只能证明孤立函数可调用。所有数字都取自上面这条真实链路。
 *
 * ## 只改画像（其余全部相同）
 *
 * 每个 `Scenario` 指定 `cases`：`{ key, quickProfile }`。同一个场景的两次运行
 * **共用同一份 actionHistory / 底牌 / 牌面 / 筹码 / seed / budget**。
 * 历史画像输入**不含**本手牌的未来行动或摊牌结果（本夹具只到决策时刻为止）。
 *
 * ## 复现
 *
 * ```text
 * node --experimental-strip-types scripts/v21-small-scale-scenarios.ts
 * ```
 *
 * ⚠️ 权益来自精确枚举或蒙特卡洛（由 `equityPolicy` 按预算选型）。
 * 本脚本给**宽裕预算**（120s/240s）让同一场景的两侧走**同一条**估计量路径 ——
 * 否则「画像效果」会被「估计量被负载切换」污染（V2 §11 的实测教训）。
 */

import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';
import { parseManualInput } from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import { createProfile, observeHand } from '../src/domain/player/playerProfile.ts';
import { PlayerMetric } from '../src/domain/player/player.types.ts';
import type { ManualHandInput } from '../src/app/manualInput/manualInput.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();

/**
 * 🔴 **宽裕预算**：让同一场景两侧走同一条估计量路径（V2 §11）。
 * 固定 `asOf` 与 `equitySeed` ⇒ 可比且可复现。
 */
const OPTIONS = {
  rules: RULES,
  asOf: 1_757_000_000_000,
  writeLog: false,
  equitySeed: 20_260_913,
  budget: { softMs: 120_000, hardMs: 240_000 },
} as const;

const SEATS = {
  UTG: 100, UTG1: 100, UTG2: 100, LJ: 100, HJ: 100,
  CO: 100, BTN: 100, SB: 100, BB: 100,
};

/* ============================================================
 * 场景定义
 * ============================================================ */

type HistoryAction = {
  position: string;
  type: string;
  amountBB?: number;
  street?: string;
};

type CaseSpec = {
  key: string;
  /** `undefined` = 完全不给画像；`'UNKNOWN'` = 明确未知；其余 = 标签 */
  quickProfile?: string;
  /** 期望方向（写测试**之前**定好，不用输出倒推） */
  expectationZh: string;
};

/** 一条街上的行动（按**真实行动顺序**书写，跳过该街不行动的一方） */
type StreetActions = { street: string; sides: readonly ('HERO' | 'VILLAIN')[] };

type Scenario = {
  id: string;
  group: 'A_STATION' | 'B_MANIAC' | 'C_TIGHT_WEAK' | 'D_GUARDRAIL';
  titleZh: string;
  /** 🔴 每个牌例先写「我的位置」 */
  heroPosition: string;
  /** 翻前开池者（若是 Hero 则 `HERO`） */
  opener: 'HERO' | 'VILLAIN';
  heroCards: readonly [string, string];
  board: readonly string[];
  /** 行动过程（人类可读，与 actionHistory 同源） */
  lineZh: string;
  effectiveStackBB: number;
  /** 画像的行为证据 + 有效机会次数（本轮画像来自**标签先验**，见报告 §5） */
  evidenceZh: string;
  streets: readonly StreetActions[];
  cases: readonly CaseSpec[];
  /** 可选：实测样本画像（D1 用） */
  villainProfileHands?: number;
};

/* ============================================================
 * 行动顺序（🔴 这里曾是本轮自查抓到的夹具缺陷，勿随意改写）
 *
 * 9-max 翻前顺序 = UTG → UTG1 → UTG2 → LJ → HJ → CO → BTN → SB → BB；
 * 翻后顺序 = SB → BB → … → BTN（**已弃牌的跳过**）。
 *
 * 因此「CO 开池、SB 弃、BB 跟」之后，**翻后每一条街都是 BB 先说话**。
 * 照着翻前顺序写翻后动作会被状态重建以 `ACTION_NOT_ACTOR` 拒绝
 * （本轮第一版夹具正是这样错的 —— 见报告 §6 缺陷 D-1）。
 * ============================================================ */

const PREFLOP_ORDER = ['UTG', 'UTG1', 'UTG2', 'LJ', 'HJ', 'CO', 'BTN', 'SB', 'BB'] as const;

/** 该位置在**翻后**的行动次序（越小越先说话）：SB(7)→0、BB(8)→1、UTG(0)→2、…、BTN(6)→8 */
function postflopRank(pos: string): number {
  const idx = PREFLOP_ORDER.indexOf(pos as (typeof PREFLOP_ORDER)[number]);
  if (idx < 0) throw new Error(`未知位置 ${pos}`);
  return idx >= 7 ? idx - 7 : idx + 2;
}

/**
 * 把「逐街的**作者顺序**行动」按真实行动顺序写成引擎接受的记录。
 *
 * 🔴 **两条本轮实测出来的规则**（第一版夹具两条都踩了 —— 见报告 §6 缺陷 D-1）：
 *
 * 1. 同一位玩家在同一条街上可以**连续**行动（BB 下注 → CO 跟注 之后，
 *    转牌又是 BB 先动）。因此**不能**按位置给同一街的动作排序 ——
 *    `sort` 会把同一玩家的两个动作并到一起、打乱真实次序。
 * 2. 本引擎的单挑翻后顺序**固定为「大盲位先说话」**（与谁翻前开池无关）。
 *    实测：CO 开池、BB 跟注 ⇒ 翻后 BB 先动；**BB 开池、BTN 跟注 ⇒ 翻后仍是
 *    BB 先动**（`scripts/tmp-v21-history-shape-probe.ts` 的 V6/V7 被拒）。
 *    因此「第一个说话的人」= BB，不是「开池者」。
 *
 * 正确的变换只有一处：**第一位说话的人如果该街没有动作，插入一个过牌**。
 * 这同时覆盖「他该先过牌」与「他面对下注后过牌-加注」两种真实结构。
 */
function withStreetOrder(
  street: string,
  heroPos: string,
  villainPos: string,
  specs: readonly { side: 'HERO' | 'VILLAIN'; type: string; amountBB?: number }[],
): HistoryAction[] {
  const firstSide: 'HERO' | 'VILLAIN' = postflopRank(heroPos) < postflopRank(villainPos)
    ? 'HERO'
    : 'VILLAIN';
  const posOf = (side: 'HERO' | 'VILLAIN'): string => (side === 'HERO' ? heroPos : villainPos);
  const firstHasAction = specs.some((s) => s.side === firstSide);
  const seq = firstHasAction ? specs : [{ side: firstSide, type: 'CHECK' } as const, ...specs];
  return seq.map((s) => ({
    position: posOf(s.side),
    type: s.type,
    ...(s.amountBB === undefined ? {} : { amountBB: s.amountBB }),
    street,
  }));
}

/**
 * 单挑（Hero vs BB/CO）完整行动历史。
 *
 * `streets` 逐街给出**两侧各自**的动作（顺序任意，本函数负责排序）。
 * 翻前固定为「一路弃到开池位 → 开池 → 剩下的弃牌 → 对手跟注」。
 */
function buildHistory(spec: Scenario): HistoryAction[] {
  const heroPos = spec.heroPosition;
  const villainPos = heroPos === 'CO' ? 'BB' : 'CO';
  const openBB = 2.5;

  /* ---- 翻前 ---- */
  const pre: HistoryAction[] = [];
  const openerPos = spec.opener === 'HERO' ? heroPos : villainPos;
  const callerPos = spec.opener === 'HERO' ? villainPos : heroPos;
  const openIdx = PREFLOP_ORDER.indexOf(openerPos as (typeof PREFLOP_ORDER)[number]);
  const callIdx = PREFLOP_ORDER.indexOf(callerPos as (typeof PREFLOP_ORDER)[number]);
  for (let i = 0; i < PREFLOP_ORDER.length; i += 1) {
    const pos = PREFLOP_ORDER[i]!;
    if (i === openIdx) {
      pre.push({ position: pos, type: 'RAISE', amountBB: openBB });
    } else if (i === callIdx) {
      // ⚠️ CALL 的 amountBB 是**增量**：大盲已投 1，跟到 2.5 只需再补 1.5
      pre.push({ position: pos, type: 'CALL', amountBB: openBB - 1 });
    } else if (i > openIdx && i > callIdx) {
      pre.push({ position: pos, type: 'FOLD' });
    } else if (i < openIdx) {
      pre.push({ position: pos, type: 'FOLD' });
    } else if (i < callIdx) {
      pre.push({ position: pos, type: 'FOLD' });
    }
  }

  /* ---- 翻后 ---- */
  const post: HistoryAction[] = [];
  for (const st of spec.streets) {
    post.push(...withStreetOrder(st.street, heroPos, villainPos, st.sides));
  }
  return [...pre, ...post];
}

const SCENARIOS: readonly Scenario[] = [
  /* ============================================================
   * A. 跟注站（CALLING_STATION）—— 3 个场景
   * ============================================================ */
  {
    id: 'A1',
    group: 'A_STATION',
    titleZh: '跟注站 · 弱牌诈唬（纯诈唬的弃牌收益被削弱）',
    heroPosition: 'CO',
    opener: 'HERO',
    heroCards: ['9c', '8c'],
    board: ['Ad', 'Ks', '7h', '3c', '2d'],
    lineZh:
      'CO 开 2.5 → BB 跟；翻牌 BB 过 / CO 过；转牌 BB 过 / CO 过；河牌 BB 过 → 我的决策（我要不要开火）',
    effectiveStackBB: 100,
    evidenceZh:
      '标签先验 CALLING_STATION：riverBluff↓ / riverLargeBetBluff↓ / missedDrawBluff↓；' +
      '有效机会次数 = 0（无实测样本，纯标签先验，可信度 0.35）',
    streets: [
      { street: 'FLOP', sides: [{ side: 'VILLAIN', type: 'CHECK' }, { side: 'HERO', type: 'CHECK' }] },
      { street: 'TURN', sides: [{ side: 'VILLAIN', type: 'CHECK' }, { side: 'HERO', type: 'CHECK' }] },
      { street: 'RIVER', sides: [{ side: 'VILLAIN', type: 'CHECK' }] },
    ],
    cases: [
      { key: 'NEUTRAL', expectationZh: '基线' },
      {
        key: 'STATION',
        quickProfile: 'CALLING_STATION',
        expectationZh:
          '跟注站的 Call 概率高于中性 ⇒ 纯诈唬的**弃牌收益**下降 ⇒ 下注 EV 不得上升（方向：降或平）',
      },
    ],
  },
  {
    id: 'A2',
    group: 'A_STATION',
    titleZh: '跟注站 · 强牌价值下注（更差的牌跟得更多）',
    heroPosition: 'CO',
    opener: 'HERO',
    heroCards: ['Ac', 'Ah'],
    board: ['Ad', 'Ks', '7h', '3c', '2d'],
    lineZh: 'CO 开 2.5 → BB 跟；翻牌 BB 过 / CO 下 2 / BB 跟；转牌 BB 过 / CO 下 5 / BB 跟；河牌 BB 过 → 我决策',
    effectiveStackBB: 100,
    evidenceZh: '同 A1；有效机会次数 = 0',
    streets: [
      {
        street: 'FLOP',
        sides: [
          { side: 'VILLAIN', type: 'CHECK' },
          { side: 'HERO', type: 'BET', amountBB: 2 },
          { side: 'VILLAIN', type: 'CALL', amountBB: 2 },
        ],
      },
      {
        street: 'TURN',
        sides: [
          { side: 'VILLAIN', type: 'CHECK' },
          { side: 'HERO', type: 'BET', amountBB: 5 },
          { side: 'VILLAIN', type: 'CALL', amountBB: 5 },
        ],
      },
      { street: 'RIVER', sides: [{ side: 'VILLAIN', type: 'CHECK' }] },
    ],
    cases: [
      { key: 'NEUTRAL', expectationZh: '基线' },
      {
        key: 'STATION',
        quickProfile: 'CALLING_STATION',
        expectationZh:
          '跟注站跟注更宽 ⇒ Call 分支的**条件权益**下降。但坚果牌下注仍应成立；' +
          '方向断言：下注倾向不得**下降**到过牌（坚果不该因为对手爱跟而不下注）',
      },
    ],
  },
  {
    id: 'A3',
    group: 'A_STATION',
    titleZh: '跟注站 · 边缘牌薄价值（河牌对手过牌，我决定是否薄价值下注）',
    heroPosition: 'CO',
    opener: 'HERO',
    heroCards: ['Th', '9d'],
    board: ['Ah', 'Ts', '5c', '3d', '2h'],
    lineZh:
      'CO 开 2.5 → BB 跟；翻牌 BB 过 / CO 下 2 / BB 跟；转牌 BB 过 / CO 过；' +
      '河牌 BB 过 → 我决策（一对 T，踢脚一般）',
    effectiveStackBB: 100,
    evidenceZh:
      '同 A1；有效机会次数 = 0。⚠️ 河牌**无人做进攻动作** ⇒ 预期画像似然通道不触发',
    streets: [
      {
        street: 'FLOP',
        sides: [
          { side: 'VILLAIN', type: 'CHECK' },
          { side: 'HERO', type: 'BET', amountBB: 2 },
          { side: 'VILLAIN', type: 'CALL', amountBB: 2 },
        ],
      },
      {
        street: 'TURN',
        sides: [
          { side: 'VILLAIN', type: 'CHECK' },
          { side: 'HERO', type: 'CHECK' },
        ],
      },
      { street: 'RIVER', sides: [{ side: 'VILLAIN', type: 'CHECK' }] },
    ],
    cases: [
      { key: 'NEUTRAL', expectationZh: '基线' },
      {
        key: 'STATION',
        quickProfile: 'CALLING_STATION',
        expectationZh:
          '⚠️ 河牌**没有进攻动作** ⇒ 画像似然通道按设计不触发；' +
          '预期：两侧**逐位相同**（这是链路边界证据，不是缺陷）。' +
          '同时记录：响应层的 Fold/Call 仍应随画像改变（行为层与范围层是两条独立通道）',
      },
    ],
  },

  /* ============================================================
   * B. 疯狂型（MANIAC）—— 3 个场景
   * ============================================================ */
  {
    id: 'B1',
    group: 'B_MANIAC',
    titleZh: '疯狂型 · 有证据支持的抓诈唬（面对 75% 池下注）',
    heroPosition: 'CO',
    opener: 'HERO',
    heroCards: ['Ac', 'Jh'],
    board: ['Ad', '8s', '4s', '2c', 'Kd'],
    lineZh:
      'CO 开 2.5 → BB 跟；翻牌 BB 过 / CO 下 2 / BB 跟；转牌 BB 过 / **CO 过牌让牌**；' +
      '河牌 BB 下 7（75% 池）→ 我决策',
    effectiveStackBB: 100,
    evidenceZh:
      '标签先验 MANIAC：riverBluff↑ / riverLargeBetBluff↑ / missedDrawBluff↑ / probeAfterTurnCheckBack↑；' +
      '有效机会次数 = 0（纯标签先验）。节点 = TURN_CHECK_BACK + LARGE',
    streets: [
      {
        street: 'FLOP',
        sides: [
          { side: 'VILLAIN', type: 'CHECK' },
          { side: 'HERO', type: 'BET', amountBB: 2 },
          { side: 'VILLAIN', type: 'CALL', amountBB: 2 },
        ],
      },
      {
        street: 'TURN',
        sides: [
          { side: 'VILLAIN', type: 'CHECK' },
          { side: 'HERO', type: 'CHECK' },
        ],
      },
      { street: 'RIVER', sides: [{ side: 'VILLAIN', type: 'BET', amountBB: 7 }] },
    ],
    cases: [
      { key: 'NEUTRAL', expectationZh: '基线' },
      {
        key: 'MANIAC',
        quickProfile: 'MANIAC',
        expectationZh:
          '过度诈唬者 ⇒ 诈唬质量、Hero 权益、Call EV **同向上升**（这是我方顶对抓诈唬的依据）',
      },
      {
        key: 'STATION_反证',
        quickProfile: 'CALLING_STATION',
        expectationZh:
          '反向对照：被动型对手 ⇒ 同样的牌面与行动线下，权益与 Call EV 必须**低于** MANIAC',
      },
    ],
  },
  {
    id: 'B2',
    group: 'B_MANIAC',
    titleZh: '疯狂型 · 当前行动线明显偏强（不得只凭标签扩大跟注）',
    heroPosition: 'CO',
    opener: 'HERO',
    heroCards: ['Qc', 'Qd'],
    board: ['Jh', '8s', '4c', '2d', '9h'],
    lineZh:
      'CO 开 2.5 → BB 跟；翻牌 BB 下 3（约 50% 池）/ CO 跟；转牌 BB **下 9（大注）** / CO 跟；' +
      '河牌 BB **下 24（超池）** → 我决策（一对 Q，牌面上有 J/9）',
    effectiveStackBB: 100,
    evidenceZh:
      '标签先验 MANIAC（同 B1）；有效机会次数 = 0。' +
      '⚠️ 本场景的**当前行动线**是三轮连续进攻 + 超池 —— 与「爱诈唬」标签形成冲突',
    streets: [
      {
        street: 'FLOP',
        sides: [
          { side: 'VILLAIN', type: 'BET', amountBB: 3 },
          { side: 'HERO', type: 'CALL', amountBB: 3 },
        ],
      },
      {
        street: 'TURN',
        sides: [
          { side: 'VILLAIN', type: 'BET', amountBB: 9 },
          { side: 'HERO', type: 'CALL', amountBB: 9 },
        ],
      },
      { street: 'RIVER', sides: [{ side: 'VILLAIN', type: 'BET', amountBB: 24 }] },
    ],
    cases: [
      { key: 'NEUTRAL', expectationZh: '基线' },
      {
        key: 'MANIAC',
        quickProfile: 'MANIAC',
        expectationZh:
          '**约束**：MANIAC 的权益可以更高，但 Hero 面对超池的**跟注门槛**（requiredEquity）' +
          '不得因标签而降低；若两侧都是 FOLD，则「标签不足以翻转」成立',
      },
    ],
  },
  {
    id: 'B3',
    group: 'B_MANIAC',
    titleZh: '疯狂型 · 价值牌面对激进动作（顶三条 vs 超池）',
    heroPosition: 'CO',
    opener: 'HERO',
    heroCards: ['Kc', 'Kd'],
    board: ['Kh', '8s', '4c', '2d', '9h'],
    lineZh:
      'CO 开 2.5 → BB 跟；翻牌 BB 过 / CO 下 2 / BB 加注到 7 / CO 跟；' +
      '转牌 BB 下 12 / CO 跟；河牌 BB 下 30（超池）→ 我决策',
    effectiveStackBB: 100,
    evidenceZh: '标签先验 MANIAC；有效机会次数 = 0',
    streets: [
      {
        street: 'FLOP',
        sides: [
          { side: 'VILLAIN', type: 'CHECK' },
          { side: 'HERO', type: 'BET', amountBB: 2 },
          { side: 'VILLAIN', type: 'RAISE', amountBB: 7 },
          { side: 'HERO', type: 'CALL', amountBB: 5 },
        ],
      },
      {
        street: 'TURN',
        sides: [
          { side: 'VILLAIN', type: 'BET', amountBB: 12 },
          { side: 'HERO', type: 'CALL', amountBB: 12 },
        ],
      },
      { street: 'RIVER', sides: [{ side: 'VILLAIN', type: 'BET', amountBB: 30 }] },
    ],
    cases: [
      { key: 'NEUTRAL', expectationZh: '基线' },
      {
        key: 'MANIAC',
        quickProfile: 'MANIAC',
        expectationZh:
          '三条顶对是价值牌 ⇒ 面对诈唬更多的对手，Call EV 应**上升**；' +
          '方向断言：MANIAC 下的 Call EV ≥ NEUTRAL（价值牌从对手过诈唬中获利）',
      },
    ],
  },

  /* ============================================================
   * C. 紧弱型（VERY_TIGHT）—— 3 个场景
   * ============================================================ */
  {
    id: 'C1',
    group: 'C_TIGHT_WEAK',
    titleZh: '紧弱型 · 有依据的弃牌率提升与诈唬机会',
    heroPosition: 'CO',
    opener: 'HERO',
    heroCards: ['9c', '8c'],
    board: ['Ad', 'Ks', '7h', '3c', '2d'],
    lineZh: 'CO 开 2.5 → BB 跟；翻牌 BB 过 / CO 过；转牌 BB 过 / CO 过；河牌 BB 过 → 我决策',
    effectiveStackBB: 100,
    evidenceZh:
      '标签先验 VERY_TIGHT：riverBluff↓ / riverLargeBetBluff↓ / missedDrawBluff↓（他很少诈唬）；' +
      '同时维度 tightness↑ ⇒ 响应层 Fold 概率↑。有效机会次数 = 0',
    streets: [
      { street: 'FLOP', sides: [{ side: 'VILLAIN', type: 'CHECK' }, { side: 'HERO', type: 'CHECK' }] },
      { street: 'TURN', sides: [{ side: 'VILLAIN', type: 'CHECK' }, { side: 'HERO', type: 'CHECK' }] },
      { street: 'RIVER', sides: [{ side: 'VILLAIN', type: 'CHECK' }] },
    ],
    cases: [
      { key: 'NEUTRAL', expectationZh: '基线' },
      {
        key: 'VERY_TIGHT',
        quickProfile: 'VERY_TIGHT',
        expectationZh:
          '紧弱对手 Fold 概率更高 ⇒ **纯诈唬的弃牌收益上升** ⇒ 下注应更有吸引力（方向：不降）',
      },
    ],
  },
  {
    id: 'C2',
    group: 'C_TIGHT_WEAK',
    titleZh: '紧弱型 · 对手采取强行动后，「容易弃牌」的判断需更新',
    heroPosition: 'CO',
    opener: 'HERO',
    heroCards: ['Ac', 'Jh'],
    board: ['Ad', '8s', '4s', '2c', 'Kd'],
    lineZh:
      'CO 开 2.5 → BB 跟；翻牌 BB 过 / CO 下 2 / BB 跟；转牌 BB 过 / CO 下 5 / BB **加注到 10** / CO 跟；' +
      '河牌 BB **下 25（超池）** → 我决策',
    effectiveStackBB: 100,
    evidenceZh:
      '标签先验 VERY_TIGHT；有效机会次数 = 0。' +
      '⚠️ 冲突：历史「紧弱、很少开火」vs 当前**转牌加注 + 河牌超池**两条强行动',
    streets: [
      {
        street: 'FLOP',
        sides: [
          { side: 'VILLAIN', type: 'CHECK' },
          { side: 'HERO', type: 'BET', amountBB: 2 },
          { side: 'VILLAIN', type: 'CALL', amountBB: 2 },
        ],
      },
      {
        street: 'TURN',
        sides: [
          { side: 'VILLAIN', type: 'CHECK' },
          { side: 'HERO', type: 'BET', amountBB: 5 },
          { side: 'VILLAIN', type: 'RAISE', amountBB: 10 },
          { side: 'HERO', type: 'CALL', amountBB: 5 },
        ],
      },
      { street: 'RIVER', sides: [{ side: 'VILLAIN', type: 'BET', amountBB: 25 }] },
    ],
    cases: [
      { key: 'NEUTRAL', expectationZh: '基线' },
      {
        key: 'VERY_TIGHT',
        quickProfile: 'VERY_TIGHT',
        expectationZh:
          '**约束**：紧弱标签意味着他诈唬更少 ⇒ 面对他的超池，Hero 权益应**不高于**中性；' +
          '「他容易弃牌」这条不能用来扩大跟注（本场景我面对的是下注，不是我在下注）',
      },
    ],
  },
  {
    id: 'C3',
    group: 'C_TIGHT_WEAK',
    titleZh: '紧弱型 · 价值下注尺度与对手继续范围的关系',
    heroPosition: 'CO',
    opener: 'HERO',
    heroCards: ['Ac', 'Ah'],
    board: ['Ad', 'Ks', '7h', '3c', '2d'],
    lineZh: 'CO 开 2.5 → BB 跟；翻牌 BB 过 / CO 下 2 / BB 跟；转牌 BB 过 / CO 下 5 / BB 跟；河牌 BB 过 → 我决策',
    effectiveStackBB: 100,
    evidenceZh: '标签先验 VERY_TIGHT；有效机会次数 = 0',
    streets: [
      {
        street: 'FLOP',
        sides: [
          { side: 'VILLAIN', type: 'CHECK' },
          { side: 'HERO', type: 'BET', amountBB: 2 },
          { side: 'VILLAIN', type: 'CALL', amountBB: 2 },
        ],
      },
      {
        street: 'TURN',
        sides: [
          { side: 'VILLAIN', type: 'CHECK' },
          { side: 'HERO', type: 'BET', amountBB: 5 },
          { side: 'VILLAIN', type: 'CALL', amountBB: 5 },
        ],
      },
      { street: 'RIVER', sides: [{ side: 'VILLAIN', type: 'CHECK' }] },
    ],
    cases: [
      { key: 'NEUTRAL', expectationZh: '基线' },
      {
        key: 'VERY_TIGHT',
        quickProfile: 'VERY_TIGHT',
        expectationZh:
          '紧弱对手**继续范围更窄** ⇒ 他的 Call 范围更强 ⇒ 我的条件权益与下注收益面临更强对抗；' +
          '方向断言：下注仍成立（坚果），但权益不得高于中性',
      },
    ],
  },

  /* ============================================================
   * D. 防护场景 —— 3 个
   * ============================================================ */
  {
    id: 'D1',
    group: 'D_GUARDRAIL',
    titleZh: '样本不足 / 无画像 —— 画像影响必须受限',
    heroPosition: 'CO',
    opener: 'HERO',
    heroCards: ['Ac', 'Jh'],
    board: ['Ad', '8s', '4s', '2c', 'Kd'],
    lineZh: '同 B1 黄金夹具（河牌 BB 下 7 = 75% 池 → 我决策）',
    effectiveStackBB: 100,
    evidenceZh:
      '四种「没有可用画像」的形态：完全不给 / UNKNOWN / NORMAL（刻意中性）/ 零手实测画像。' +
      '有效机会次数 = 0',
    streets: [
      {
        street: 'FLOP',
        sides: [
          { side: 'VILLAIN', type: 'CHECK' },
          { side: 'HERO', type: 'BET', amountBB: 2 },
          { side: 'VILLAIN', type: 'CALL', amountBB: 2 },
        ],
      },
      {
        street: 'TURN',
        sides: [
          { side: 'VILLAIN', type: 'CHECK' },
          { side: 'HERO', type: 'CHECK' },
        ],
      },
      { street: 'RIVER', sides: [{ side: 'VILLAIN', type: 'BET', amountBB: 7 }] },
    ],
    cases: [
      { key: 'NO_PROFILE', expectationZh: '基线：完全不给画像' },
      { key: 'UNKNOWN', quickProfile: 'UNKNOWN', expectationZh: '明确未知 ⇒ 必须与基线逐位相同' },
      { key: 'NORMAL', quickProfile: 'NORMAL', expectationZh: '刻意中性标签 ⇒ 应与基线逐位相同' },
      {
        key: 'ZERO_HAND_PROFILE',
        villainProfileHands: 0,
        expectationZh: '给了实测画像但 0 手 ⇒ 等同无证据，不得产生调整',
      },
    ],
  },
  {
    id: 'D2',
    group: 'D_GUARDRAIL',
    titleZh: '历史画像与当前行动冲突（尺寸证据与画像证据是否重复计入）',
    heroPosition: 'CO',
    opener: 'HERO',
    heroCards: ['Ac', 'Jh'],
    board: ['Ad', '8s', '4s', '2c', 'Kd'],
    lineZh:
      'CO 开 2.5 → BB 跟；翻牌 BB 过 / CO 下 2 / BB 跟；转牌 BB 过 / **CO 过牌让牌**；' +
      '河牌 BB **下 2（25% 池，小注）** → 我决策',
    effectiveStackBB: 100,
    evidenceZh:
      'MANIAC 标签先验含 riverLargeBetBluff↑（只对 LARGE/OVERBET 生效）与 riverBluff↑（对所有尺寸生效）；' +
      '有效机会次数 = 0。与 B1 相比**只改河牌下注尺寸**（7 → 2）',
    streets: [
      {
        street: 'FLOP',
        sides: [
          { side: 'VILLAIN', type: 'CHECK' },
          { side: 'HERO', type: 'BET', amountBB: 2 },
          { side: 'VILLAIN', type: 'CALL', amountBB: 2 },
        ],
      },
      {
        street: 'TURN',
        sides: [
          { side: 'VILLAIN', type: 'CHECK' },
          { side: 'HERO', type: 'CHECK' },
        ],
      },
      { street: 'RIVER', sides: [{ side: 'VILLAIN', type: 'BET', amountBB: 2 }] },
    ],
    cases: [
      { key: 'NEUTRAL_SMALL', expectationZh: '小注基线' },
      {
        key: 'MANIAC_SMALL',
        quickProfile: 'MANIAC',
        expectationZh:
          '小注下 `riverLargeBetBluff` 条目**不应**被施加 ⇒ 调整幅度应小于大注情景（尺寸隔离）；' +
          '与 B1 的 Δ 对比可验证「同一条倾向未被重复计入」',
      },
    ],
  },
  {
    id: 'D3',
    group: 'D_GUARDRAIL',
    titleZh: '中性画像与无画像基线的兼容性（不给 == UNKNOWN == NORMAL）',
    heroPosition: 'CO',
    opener: 'HERO',
    heroCards: ['Ac', 'Jh'],
    board: ['Ad', '8s', '4s', '2c', 'Kd'],
    lineZh: '同 B1 黄金夹具',
    effectiveStackBB: 100,
    evidenceZh: '无画像 / UNKNOWN / NORMAL 三者：有效机会次数均为 0，均不携带任何行为证据',
    streets: [
      {
        street: 'FLOP',
        sides: [
          { side: 'VILLAIN', type: 'CHECK' },
          { side: 'HERO', type: 'BET', amountBB: 2 },
          { side: 'VILLAIN', type: 'CALL', amountBB: 2 },
        ],
      },
      {
        street: 'TURN',
        sides: [
          { side: 'VILLAIN', type: 'CHECK' },
          { side: 'HERO', type: 'CHECK' },
        ],
      },
      { street: 'RIVER', sides: [{ side: 'VILLAIN', type: 'BET', amountBB: 7 }] },
    ],
    cases: [
      { key: 'NO_PROFILE', expectationZh: '基线' },
      { key: 'UNKNOWN', quickProfile: 'UNKNOWN', expectationZh: '必须逐位相同' },
      { key: 'NORMAL', quickProfile: 'NORMAL', expectationZh: '必须逐位相同' },
    ],
  },
];

/* ============================================================
 * 夹具构造
 * ============================================================ */

function buildInput(spec: Scenario, caseSpec: CaseSpec): ManualHandInput {
  const villain: Record<string, unknown> = {
    quickProfile: caseSpec.quickProfile ?? 'UNKNOWN',
    dynamicHint: 'UNKNOWN',
    stackBB: spec.effectiveStackBB,
  };

  if (caseSpec.villainProfileHands !== undefined) {
    // 实测画像：observation 的**机会数与成功数都由本参数决定**（0 = 零手证据）
    const n = caseSpec.villainProfileHands;
    let profile = createProfile('BB');
    if (n > 0) {
      const obs = [
        { metric: PlayerMetric.VPIP, success: true },
        { metric: PlayerMetric.RIVER_BET, success: false },
      ];
      for (let i = 0; i < n; i += 1) {
        const r = observeHand(profile, {
          handId: `h${i}`,
          playerId: 'BB',
          seq: i + 1,
          timestamp: new Date(1_756_000_000_000 + i * 60_000).toISOString(),
          observations: obs,
        });
        if (!r.ok) throw new Error(`观测被拒：${JSON.stringify(r.issues)}`);
        profile = r.value;
      }
    }
    villain['profile'] = profile;
    // 零手实测画像必须**不带**手选标签，否则会被手选标签的 0.35 兜底
    delete villain['quickProfile'];
  }

  return {
    tableSize: 9,
    heroPosition: spec.heroPosition,
    heroCards: [...spec.heroCards],
    board: [...spec.board],
    street: spec.board.length === 5 ? 'RIVER' : spec.board.length === 4 ? 'TURN' : 'FLOP',
    effectiveStackBB: spec.effectiveStackBB,
    bigBlindBB: 2,
    seatStacksBB: { ...SEATS },
    actionHistory: buildHistory(spec).map((a) => ({ ...a })),
    environment: 'MID_LOW_STAKES',
    villain,
  } as unknown as ManualHandInput;
}

/* ============================================================
 * 测量（全部取自真实生产链路）
 * ============================================================ */

type Measured = {
  key: string;
  quickProfile: string;
  ok: boolean;
  failReason: string | null;

  /* 画像是否真的进了链路 */
  playerConfidence: number | null;
  playerNeutralized: boolean | null;
  handsObserved: number | null;
  /* 范围层 */
  supportSize: number | null;
  valueMass: number | null;
  thinValueMass: number | null;
  showdownMass: number | null;
  missedDrawMass: number | null;
  pureAirMass: number | null;
  bluffMass: number | null;
  categoryRangeDistanceTV: number | null;
  categoryRangeDistanceJS: number | null;
  effectiveCombos: number | null;
  posteriorMassCombos90: number | null;
  /* 行为层（响应模型：对手对我下注的反应） */
  respFold: number | null;
  respCall: number | null;
  respRaise: number | null;
  /* 权益 / EV */
  heroEquity: number | null;
  equityVsCallRange: number | null;
  callEV: number | null;
  requiredEquity: number | null;
  potOdds: number | null;
  pot: number | null;
  winnable: number | null;
  spr: number | null;
  /* 动作 */
  action: string;
  betSizeBB: number | null;
  betSizePotRatio: number | null;
  evGap: number | null;
  dominant: boolean | null;
  /* 候选动作 */
  checkEV: number | null;
  betEVs: readonly { label: string; ratio: number; ev: number | null }[];
  /* 画像证据去重闸门 */
  rangeLayerApplied: boolean | null;
  scorerLayerApplied: boolean | null;
  doubleCountBlocked: boolean | null;

  noteZh: string;
};

/* ---- 只取 M 的类别级分布（5 个互不重叠分量）---- */
const CATEGORY_VECTOR_ZH =
  'CATEGORY_LEVEL_RANGE_DISTANCE：由 M.profileClassMasses 的 5 个互不重叠类别构成，' +
  '不是 1326 combo 级逐组合距离';

function categoryVector(m: Measured): number[] | null {
  if (m.valueMass === null || m.thinValueMass === null) return null;
  return [
    m.valueMass - m.thinValueMass,
    m.thinValueMass,
    m.showdownMass ?? 0,
    m.missedDrawMass ?? 0,
    m.pureAirMass ?? 0,
  ];
}

function tvDistance(a: readonly number[], b: readonly number[]): number {
  const sa = a.reduce((x, y) => x + Math.max(0, y), 0);
  const sb = b.reduce((x, y) => x + Math.max(0, y), 0);
  let tv = 0;
  for (let i = 0; i < a.length; i += 1) {
    tv += Math.abs((a[i] ?? 0) / sa - (b[i] ?? 0) / sb);
  }
  return tv / 2;
}

function measure(spec: Scenario, caseSpec: CaseSpec): Measured {
  const input = buildInput(spec, caseSpec);
  const base: Measured = {
    key: caseSpec.key,
    quickProfile: caseSpec.quickProfile ?? '(不给画像)',
    ok: false,
    failReason: null,
    playerConfidence: null,
    playerNeutralized: null,
    handsObserved: null,
    supportSize: null,
    valueMass: null,
    thinValueMass: null,
    showdownMass: null,
    missedDrawMass: null,
    pureAirMass: null,
    bluffMass: null,
    categoryRangeDistanceTV: null,
    categoryRangeDistanceJS: null,
    effectiveCombos: null,
    posteriorMassCombos90: null,
    respFold: null,
    respCall: null,
    respRaise: null,
    heroEquity: null,
    equityVsCallRange: null,
    callEV: null,
    requiredEquity: null,
    potOdds: null,
    pot: null,
    winnable: null,
    spr: null,
    action: '—',
    betSizeBB: null,
    betSizePotRatio: null,
    evGap: null,
    dominant: null,
    checkEV: null,
    betEVs: [],
    rangeLayerApplied: null,
    scorerLayerApplied: null,
    doubleCountBlocked: null,
    noteZh: '',
  };

  const parsed = parseManualInput(input);
  if (!parsed.ok) {
    return { ...base, failReason: `PARSE: ${JSON.stringify(parsed.issues)}` };
  }
  const gate = buildAnalyzableState(parsed.value);
  if (!gate.ok) {
    return { ...base, failReason: `STATE: ${JSON.stringify(gate.issues)}` };
  }

  const built = buildDecisionContext({
    state: gate.state,
    rules: RULES,
    environment: 'MID_LOW_STAKES',
    asOf: 1_757_000_000_000,
    ...(caseSpec.quickProfile === undefined
      ? {}
      : { quickProfile: caseSpec.quickProfile as never }),
  });

  const result = analyzeManualHand(input, OPTIONS);
  if (!result.ok) {
    return { ...base, failReason: `ANALYZE: ${JSON.stringify(result.issues)}` };
  }

  const ctx = built.context as unknown as Record<string, any>;
  const facts = ctx['postflopFacts']?.['opponentRangeFacts'] as Record<string, any> | null;
  const masses = facts?.['profileClassMasses'] as Record<string, any> | null;
  const range = ctx['range'] as Record<string, any> | null;
  const player = ctx['player'] as Record<string, any> | null;
  const math = ctx['math'] as Record<string, any>;
  const decision = result.decision as unknown as Record<string, any>;
  const bd = decision['diagnostics']?.['postflop']?.['betDecision'] as Record<string, any> | null;
  const sizes = (bd?.['sizes'] ?? []) as readonly Record<string, any>[];
  const firstSize = sizes[0];
  const pref = bd?.['preference'] ?? bd?.['sizes']?.[0]?.['preference'] ?? null;

  const advice = decision['diagnostics']?.['postflop']?.['advice'] as Record<string, any> | null;
  const gateEvidence = (bd?.['profileEvidence'] ?? advice?.['betDecision']?.['profileEvidence'] ?? null) as
    | Record<string, any>
    | null;

  return {
    ...base,
    ok: true,
    playerConfidence: player === null ? null : Number(player['confidence']),
    playerNeutralized: player === null ? null : player['neutralized'] === true,
    handsObserved: player === null ? null : Number(player['handsObserved']),
    supportSize: range === null ? null : Number(range['supportSize']),
    valueMass: masses ? Number(masses['valueMass']) : null,
    thinValueMass: masses ? Number(masses['thinValueMass']) : null,
    showdownMass: masses ? Number(masses['showdownMass']) : null,
    missedDrawMass: masses ? Number(masses['missedDrawMass']) : null,
    pureAirMass: masses ? Number(masses['pureAirMass']) : null,
    bluffMass: masses ? Number(masses['bluffMass']) : null,
    effectiveCombos: masses ? Number(masses['effectiveCombos']) : null,
    posteriorMassCombos90: masses ? Number(masses['posteriorMassCombos90']) : null,
    respFold: firstSize ? Number(firstSize['foldLikelihood']) : null,
    respCall: firstSize ? Number(firstSize['callLikelihood']) : null,
    respRaise: firstSize ? Number(firstSize['raiseLikelihood']) : null,
    heroEquity: math['heroEquity'] === null ? null : Number(math['heroEquity']),
    equityVsCallRange: firstSize?.['equityVsCallRange'] === undefined
      ? null
      : (firstSize['equityVsCallRange'] as number | null),
    callEV: math['callEV'] === null ? null : Number(math['callEV']),
    requiredEquity: Number(math['requiredEquity']),
    potOdds: Number(math['potOdds']),
    pot: Number(math['pot']),
    winnable: Number(math['winnable']),
    spr: math['spr'] === null ? null : Number(math['spr']),
    action: String(decision['action']),
    betSizeBB: pref?.['betAmount'] === undefined ? null : Number(pref['betAmount']) / 2,
    betSizePotRatio: pref?.['ratioToPot'] === undefined ? null : Number(pref['ratioToPot']),
    evGap: math['mathDominance']?.['evGap'] === null || math['mathDominance']?.['evGap'] === undefined
      ? null
      : Number(math['mathDominance']['evGap']),
    dominant: math['mathDominance']?.['dominant'] === undefined
      ? null
      : math['mathDominance']['dominant'] === true,
    checkEV: bd?.['checkTree']?.['checkEV'] === undefined ? null : Number(bd['checkTree']['checkEV']),
    betEVs: sizes.map((s) => ({
      label: String(s['labelZh'] ?? s['kind']),
      ratio: Number(s['ratioToPot']),
      ev: s['ev'] === undefined || s['ev'] === null ? null : Number(s['ev']),
    })),
    rangeLayerApplied: gateEvidence === null ? null : gateEvidence['rangeLayerApplied'] === true,
    scorerLayerApplied: gateEvidence === null ? null : gateEvidence['scorerLayerApplied'] === true,
    doubleCountBlocked: gateEvidence === null ? null : gateEvidence['doubleCountBlocked'] === true,
    noteZh: String(bd?.['modelNoteZh'] ?? ''),
  };
}

/* ============================================================
 * 输出
 * ============================================================ */

const f = (x: number | null, d = 4): string => (x === null || !Number.isFinite(x) ? '—' : x.toFixed(d));
const pct = (x: number | null, d = 2): string =>
  x === null || !Number.isFinite(x) ? '—' : `${(x * 100).toFixed(d)}%`;
const pp = (x: number | null): string =>
  x === null || !Number.isFinite(x) ? '—' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(2)}pp`;
const bb = (x: number | null): string => (x === null || !Number.isFinite(x) ? '—' : x.toFixed(2));

/** 数值等效比较（用于「必须逐位相同」类断言） */
function identical(a: Measured, b: Measured): { same: boolean; diffs: string[] } {
  const diffs: string[] = [];
  const keys: readonly (keyof Measured)[] = [
    'supportSize', 'valueMass', 'thinValueMass', 'showdownMass', 'missedDrawMass',
    'pureAirMass', 'bluffMass', 'effectiveCombos', 'posteriorMassCombos90',
    'heroEquity', 'callEV', 'action',
  ];
  for (const k of keys) {
    const va = a[k];
    const vb = b[k];
    if (va === vb) continue;
    diffs.push(`${String(k)}: ${String(va)} ≠ ${String(vb)}`);
  }
  return { same: diffs.length === 0, diffs };
}

console.log('============================================================');
console.log(' V2.1 第一轮 · 画像决策小规模验证（12 场景 / 真实生产链路）');
console.log('============================================================');
console.log(`asOf=${OPTIONS.asOf}  equitySeed=${OPTIONS.equitySeed}  budget=${OPTIONS.budget.softMs}/${OPTIONS.budget.hardMs} ms`);
console.log(`RULES 条数=${RULES.length}`);
console.log(`范围距离口径：${CATEGORY_VECTOR_ZH}`);
console.log('');

type Row = { scenario: Scenario; results: Measured[]; distanceTV: number | null; distanceJS: number | null };
const rows: Row[] = [];

for (const spec of SCENARIOS) {
  console.log('------------------------------------------------------------');
  console.log(`【${spec.id}】${spec.titleZh}`);
  console.log(`  我的位置：${spec.heroPosition}`);
  console.log(`  我的手牌：${spec.heroCards.join(' ')}`);
  console.log(`  公共牌：${spec.board.join(' ')}`);
  console.log(`  有效筹码：${spec.effectiveStackBB} BB`);
  console.log(`  行动过程：${spec.lineZh}`);
  console.log(`  画像证据 / 有效机会次数：${spec.evidenceZh}`);
  console.log(
    `  行动记录（发给引擎的原文）：${buildHistory(spec)
      .map((a) => `${a.position}${a.type}${a.amountBB === undefined ? '' : a.amountBB}${a.street === undefined ? '' : `@${a.street}`}`)
      .join(' ')}`,
  );
  console.log('');

  const results = spec.cases.map((c) => measure(spec, c));
  const dTV = (() => {
    const va = categoryVector(results[0]!);
    const vb = categoryVector(results[1] ?? results[0]!);
    return va === null || vb === null ? null : tvDistance(va, vb);
  })();

  console.log(
    '  ' +
      '案例'.padEnd(18) +
      '动作'.padEnd(10) +
      '尺度BB'.padEnd(9) +
      '底池'.padEnd(8) +
      '权益'.padEnd(9) +
      'CallEV'.padEnd(10) +
      '诈唬质量'.padEnd(11) +
      '对手弃/跟/加'.padEnd(22) +
      '门槛',
  );
  for (const m of results) {
    if (!m.ok) {
      console.log(`  ${m.key.padEnd(18)}✖ ${m.failReason}`);
      continue;
    }
    const resp =
      m.respFold === null
        ? 'NOT_AVAILABLE（我面对下注）'
        : `${pct(m.respFold, 1)}/${pct(m.respCall, 1)}/${pct(m.respRaise, 1)}`;
    console.log(
      '  ' +
        m.key.padEnd(18) +
        m.action.padEnd(10) +
        bb(m.betSizeBB).padEnd(9) +
        bb(m.pot).padEnd(8) +
        pct(m.heroEquity).padEnd(9) +
        bb(m.callEV).padEnd(10) +
        f(m.bluffMass).padEnd(11) +
        resp.padEnd(22) +
        pct(m.requiredEquity, 1),
    );
  }

  const [a, b] = results;
  if (a?.ok && b?.ok) {
    const dOf = (x: number | null, y: number | null): string =>
      x === null || y === null ? 'NOT_AVAILABLE' : pp(y - x);
    console.log('');
    console.log(`  Δ 权益        = ${pp((b.heroEquity ?? 0) - (a.heroEquity ?? 0))}`);
    console.log(`  Δ 诈唬质量    = ${f((b.bluffMass ?? 0) - (a.bluffMass ?? 0))}（${pp((b.bluffMass ?? 0) - (a.bluffMass ?? 0))}）`);
    console.log(`  Δ CallEV      = ${bb((b.callEV ?? 0) - (a.callEV ?? 0))} 筹码`);
    console.log(`  Δ 对手弃牌率  = ${dOf(a.respFold, b.respFold)}`);
    console.log(`  Δ 对手跟注率  = ${dOf(a.respCall, b.respCall)}`);
    console.log(`  Δ 对手加注率  = ${dOf(a.respRaise, b.respRaise)}`);
    console.log(`  Δ 最优/次优EV差 = ${dOf(a.evGap, b.evGap)}`);
    console.log(`  EqVsCall（对跟注范围权益）：${pct(a.equityVsCallRange)} → ${pct(b.equityVsCallRange)}`);
    console.log(
      `  候选下注 EV：${a.betEVs.map((s) => `${bb(s.ev)}@${(s.ratio * 100).toFixed(0)}%`).join(' / ') || 'NOT_AVAILABLE'}` +
        `  →  ${b.betEVs.map((s) => `${bb(s.ev)}@${(s.ratio * 100).toFixed(0)}%`).join(' / ') || 'NOT_AVAILABLE'}`,
    );
    console.log(`  过牌 EV：${bb(a.checkEV)} → ${bb(b.checkEV)}`);
    console.log(
      `  尺度变化：${a.betSizeBB === null || b.betSizeBB === null ? 'NOT_AVAILABLE' : `${bb(a.betSizeBB)}BB → ${bb(b.betSizeBB)}BB`}` +
        `（底池比例 ${a.betSizePotRatio === null ? '—' : (a.betSizePotRatio * 100).toFixed(0) + '%'} → ${b.betSizePotRatio === null ? '—' : (b.betSizePotRatio * 100).toFixed(0) + '%'}）`,
    );
    console.log(`  动作：${a.action} → ${b.action}${a.action === b.action ? '（无 flip）' : '  🔴 ACTION FLIP'}`);
    console.log(
      `  画像证据去重闸门：rangeLayer=${String(a.rangeLayerApplied)}/${String(b.rangeLayerApplied)} ` +
        `scorerLayer=${String(a.scorerLayerApplied)}/${String(b.scorerLayerApplied)} ` +
        `doubleCountBlocked=${String(a.doubleCountBlocked)}/${String(b.doubleCountBlocked)}`,
    );
    const same = identical(a, b);
    console.log(`  逐位相等：${same.same ? '是' : `否 ⇒ ${same.diffs.join('；')}`}`);
  }
  console.log(`  期望（运行前写定）：${spec.cases[1]?.expectationZh ?? spec.cases[0]?.expectationZh ?? '—'}`);
  console.log('');

  rows.push({ scenario: spec, results, distanceTV: dTV, distanceJS: null });
}

/* ============================================================
 * 汇总
 * ============================================================ */

console.log('============================================================');
console.log(' 汇总');
console.log('============================================================');

let flips = 0;
let sizingChanges = 0;
let maxAbsEquityDelta = 0;
let maxAbsEquityLabel = '';
let maxAbsBluffDelta = 0;
let maxAbsBluffLabel = '';
const rowLines: string[] = [];

for (const r of rows) {
  const [a, b] = r.results;
  if (!a?.ok || !b?.ok) {
    rowLines.push(`${r.scenario.id} | ${r.scenario.titleZh} | NOT_TESTED（${a?.failReason ?? b?.failReason}）`);
    continue;
  }
  const dEq = (b.heroEquity ?? 0) - (a.heroEquity ?? 0);
  const dBl = (b.bluffMass ?? 0) - (a.bluffMass ?? 0);
  if (Math.abs(dEq) > Math.abs(maxAbsEquityDelta)) {
    maxAbsEquityDelta = dEq;
    maxAbsEquityLabel = r.scenario.id;
  }
  if (Math.abs(dBl) > Math.abs(maxAbsBluffDelta)) {
    maxAbsBluffDelta = dBl;
    maxAbsBluffLabel = r.scenario.id;
  }
  const flip = a.action !== b.action;
  const sizeCh =
    a.action === b.action &&
    a.betSizeBB !== null && b.betSizeBB !== null &&
    Math.abs(a.betSizeBB - b.betSizeBB) > 1e-9;
  if (flip) flips += 1;
  if (sizeCh) sizingChanges += 1;
  rowLines.push(
    `${r.scenario.id} | ${r.scenario.titleZh} | ${a.action}→${b.action} | ` +
      `Δ权益 ${pp(dEq)} | Δ诈唬 ${bb(dBl)} | ΔCallEV ${bb((b.callEV ?? 0) - (a.callEV ?? 0))} | ` +
      `Δ弃 ${pp((b.respFold ?? 0) - (a.respFold ?? 0))} | CATEGORY_LEVEL_RANGE_DISTANCE(TV) ${f(r.distanceTV)}` +
      (flip ? ' | 🔴FLIP' : '') +
      (sizeCh ? ' | 🔴SIZING' : ''),
  );
}

for (const line of rowLines) console.log(line);
console.log('');
console.log(`场景总数            = ${rows.length}`);
console.log(`action flip 数      = ${flips}`);
console.log(`sizing change 数    = ${sizingChanges}`);
console.log(`最大 |Δ权益|        = ${pp(maxAbsEquityDelta)}（${maxAbsEquityLabel}）`);
console.log(`最大 |Δ诈唬质量|    = ${f(Math.abs(maxAbsBluffDelta), 4)}（${maxAbsBluffLabel}）`);
console.log('');

/* ---- 关键不变量检查 ---- */
console.log('------------------------------------------------------------');
console.log(' 不变量检查');
console.log('------------------------------------------------------------');

const d1 = rows.find((r) => r.scenario.id === 'D1');
if (d1) {
  const [noProfile, unknown, normal, zeroHand] = d1.results;
  if (noProfile?.ok && unknown?.ok) {
    const c = identical(noProfile, unknown);
    console.log(`D1 无画像 == UNKNOWN ：${c.same ? 'PASS（逐位相同）' : `FAIL ⇒ ${c.diffs.join('；')}`}`);
  }
  if (noProfile?.ok && normal?.ok) {
    const c = identical(noProfile, normal);
    console.log(`D1 无画像 == NORMAL  ：${c.same ? 'PASS（逐位相同）' : `FAIL ⇒ ${c.diffs.join('；')}`}`);
  }
  if (noProfile?.ok && zeroHand?.ok) {
    const c = identical(noProfile, zeroHand);
    console.log(
      `D1 无画像 == 零手实测画像：${c.same ? 'PASS（逐位相同）' : `FAIL ⇒ ${c.diffs.join('；')}`}` +
        `（零手画像 handsObserved=${zeroHand.handsObserved}，neutralized=${zeroHand.playerNeutralized}）`,
    );
  }
}

const b1 = rows.find((r) => r.scenario.id === 'B1');
if (b1) {
  const [neutral, maniac, station] = b1.results;
  if (neutral?.ok && maniac?.ok && station?.ok) {
    const okBluff = (maniac.bluffMass ?? 0) > (neutral.bluffMass ?? 0);
    const okBluffRev = (station.bluffMass ?? 0) < (neutral.bluffMass ?? 0);
    const okEq = (maniac.heroEquity ?? 0) > (neutral.heroEquity ?? 0);
    const okEqRev = (station.heroEquity ?? 0) < (neutral.heroEquity ?? 0);
    const okEv = (maniac.callEV ?? 0) > (neutral.callEV ?? 0);
    console.log(`B1 诈唬质量 MANIAC > 中性 ：${okBluff ? 'PASS' : 'FAIL'}（${f(maniac.bluffMass)} vs ${f(neutral.bluffMass)}）`);
    console.log(`B1 诈唬质量 STATION < 中性：${okBluffRev ? 'PASS' : 'FAIL'}（${f(station.bluffMass)} vs ${f(neutral.bluffMass)}）`);
    console.log(`B1 权益 MANIAC > 中性      ：${okEq ? 'PASS' : 'FAIL'}（${pct(maniac.heroEquity)} vs ${pct(neutral.heroEquity)}）`);
    console.log(`B1 权益 STATION < 中性     ：${okEqRev ? 'PASS' : 'FAIL'}（${pct(station.heroEquity)} vs ${pct(neutral.heroEquity)}）`);
    console.log(`B1 CallEV MANIAC > 中性    ：${okEv ? 'PASS' : 'FAIL'}（${bb(maniac.callEV)} vs ${bb(neutral.callEV)}）`);
  }
}

/* ---- 确定性 ---- */
console.log('');
console.log('------------------------------------------------------------');
console.log(' 确定性（同一输入重复 3 次必须逐位相同）');
console.log('------------------------------------------------------------');
const detSpec = SCENARIOS.find((s) => s.id === 'B1')!;
const detCase = detSpec.cases[1]!;
const reps = [measure(detSpec, detCase), measure(detSpec, detCase), measure(detSpec, detCase)];
const allSame =
  reps.every((r) => r.heroEquity === reps[0]!.heroEquity) &&
  reps.every((r) => r.callEV === reps[0]!.callEV) &&
  reps.every((r) => r.bluffMass === reps[0]!.bluffMass);
console.log(
  `B1/MANIAC × 3：${allSame ? 'PASS（确定性）' : 'FAIL（不确定！）'}  ` +
    `equity=${pct(reps[0]!.heroEquity)} callEV=${bb(reps[0]!.callEV)} bluff=${f(reps[0]!.bluffMass)}`,
);

/* ---- A3 链路边界 ---- */
const a3 = rows.find((r) => r.scenario.id === 'A3');
if (a3 && a3.results[0]?.ok && a3.results[1]?.ok) {
  const c = identical(a3.results[0]!, a3.results[1]!);
  console.log('');
  console.log(`A3 河牌无进攻动作 ⇒ 画像似然通道不触发：${c.same ? 'PASS（两侧逐位相同，符合设计）' : `注意 ⇒ ${c.diffs.join('；')}`}`);
  console.log(`  A3 模型说明：${a3.results[0]!.noteZh.slice(0, 160)}`);
}
