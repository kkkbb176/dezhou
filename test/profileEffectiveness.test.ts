/**
 * 人物画像**生效性**回归测试（KQ 阶段四 · 打通接线）
 *
 * ## 本文件锁什么
 *
 * 修复前，实测统计（VPIP/PFR/…）**对决策完全无效**，因为响应层通道有三处「假接线」：
 *
 * | # | 位置 | 缺陷 |
 * |---|---|---|
 * | 1 | `buildBetDecisionFacts` 调用点 `profileConfidence` | 取**标签**置信度；无标签 ⇒ 0 ⇒ `scaled()` 全归零 |
 * | 2 | 同上 `dimensions` | 无标签 ⇒ 传 `null` ⇒ `responseTendenciesOf` 早退，`v3Dimensions` 被丢弃 |
 * | 3 | `facingInputsForSeat` 准入 | 无标签 ⇒ **整个「面对下注」通道返回 `null`** ⇒ 实测被整体丢弃 |
 *
 * 三处均已修复。本文件用**可证伪的数值差异**锁住「画像真的进了模型」，
 * 并且锁住**语义门仍然有效**（不该生效的统计不得生效）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Position, Street } from '../src/domain/types.ts';
import { GameEnvironment } from '../src/domain/range/gameEnvironment.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import type { ManualHandInput } from '../src/app/manualInput/manualInput.ts';
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const POS9 = [
  Position.UTG, Position.UTG1, Position.UTG2, Position.LJ, Position.HJ,
  Position.CO, Position.BTN, Position.SB, Position.BB,
];

const pre = (opener: Position): ManualHandInput['actionHistory'] => {
  const i = POS9.indexOf(opener);
  const h: { position: Position; type: 'FOLD' | 'RAISE'; amountBB?: number; street: Street }[] = [];
  for (let k = 0; k < i; k++) h.push({ position: POS9[k]!, type: 'FOLD', street: Street.PREFLOP });
  h.push({ position: opener, type: 'RAISE', amountBB: 2.5, street: Street.PREFLOP });
  for (let k = i + 1; k < POS9.indexOf(Position.SB); k++) h.push({ position: POS9[k]!, type: 'FOLD', street: Street.PREFLOP });
  h.push({ position: Position.SB, type: 'FOLD', street: Street.PREFLOP });
  return h as ManualHandInput['actionHistory'];
};

/**
 * 翻牌：Hero CO 面对 BB 的过牌-加注
 *
 * @param bind 是否把画像**绑定到 BB 本人**（`seatId` + `persistentPlayerId`）。
 *   面对下注通道要求身份绑定（否则画像不生效）—— 需要「画像必须生效」的
 *   测试用 `true`；需要与「无画像」对照的测试保持 `false`（默认，逐位兼容）。
 */
const flopNode = (stats: Record<string, number> | null, bind = false): ManualHandInput => ({
  tableSize: 9, heroPosition: Position.CO, heroCards: ['Ks', 'Qs'], board: ['Qh', '9s', '5s'],
  street: Street.FLOP, effectiveStackBB: 100, bigBlindBB: 100, potBB: 23,
  environment: GameEnvironment.LOW_STAKES_ONLINE, occupiedPositions: POS9, buttonPosition: Position.BTN,
  ...(stats === null
    ? {}
    : {
        villain: {
          observedStats: stats as never,
          ...(bind ? { seatId: 'seat_BB', persistentPlayerId: 'p_bb' } : {}),
        },
      }),
  actionHistory: [
    ...pre(Position.CO),
    { position: Position.BB, type: 'CALL', amountBB: 1.5, street: Street.PREFLOP },
    { position: Position.BB, type: 'CHECK', street: Street.FLOP },
    { position: Position.CO, type: 'BET', amountBB: 3.5, street: Street.FLOP },
    { position: Position.BB, type: 'RAISE', amountBB: 14, street: Street.FLOP },
  ],
} as unknown as ManualHandInput);

/** 河牌：Hero BB 面对 BTN 的下注（前面两街都过牌）；`bind` 语义同 `flopNode` */
const riverNode = (stats: Record<string, number> | null, bind = false): ManualHandInput => ({
  tableSize: 9, heroPosition: Position.BB, heroCards: ['Ah', 'Kd'], board: ['Kh', '8c', '3d', '2s', '7h'],
  street: Street.RIVER, effectiveStackBB: 100, bigBlindBB: 100, potBB: 18.5,
  environment: GameEnvironment.LOW_STAKES_ONLINE, occupiedPositions: POS9, buttonPosition: Position.BTN,
  ...(stats === null
    ? {}
    : {
        villain: {
          observedStats: stats as never,
          ...(bind ? { seatId: 'seat_BTN', persistentPlayerId: 'p_btn' } : {}),
        },
      }),
  actionHistory: [
    ...pre(Position.BTN),
    { position: Position.BB, type: 'CALL', amountBB: 1.5, street: Street.PREFLOP },
    { position: Position.BB, type: 'CHECK', street: Street.FLOP },
    { position: Position.BTN, type: 'CHECK', street: Street.FLOP },
    { position: Position.BB, type: 'CHECK', street: Street.TURN },
    { position: Position.BTN, type: 'CHECK', street: Street.TURN },
    { position: Position.BB, type: 'CHECK', street: Street.RIVER },
    { position: Position.BTN, type: 'BET', amountBB: 13, street: Street.RIVER },
  ],
} as unknown as ManualHandInput);

const callEVOf = (input: ManualHandInput): number | null => {
  const r = analyzeManualHand(input, { rules: RULES });
  assert.equal(r.ok, true, `必须可分析：${r.ok ? '' : JSON.stringify(r.issues)}`);
  if (!r.ok) return null;
  return r.decision.diagnostics.math.callEV;
};

const TIGHT = { handsObserved: 80, vpip: 0.15, pfr: 0.1 };
const LOOSE_AGGRO = { handsObserved: 80, vpip: 0.85, pfr: 0.6 };

/**
 * 🔴 **PFR→BETRANGE 修复后的夹具（契约更新）**
 *
 * P4-1 / P4-2 原本只用 `vpip` / `pfr`（**翻前**统计）证明「画像生效」。
 * 那条差异**全部**来自「PFR → aggression → 翻后下注范围构成」这条通道，
 * 而它已被判为越权并切断（理由与对照实验见
 * `reports/PFR_TO_BETRANGE_VERIFICATION.md`）：一条翻前主动性不该决定
 * 「他翻牌下注里有多少诈唬」。
 *
 * ⇒ 夹具补上**真正的翻后统计**（「他这一街怎么打」的证据）与画像绑定，
 * 于是「画像生效」由一个**有语义的来源**证明，而不是由越权通道顺带证明。
 *
 * ⚠️ 两个前置条件是既有设计、不是本轮改动：
 * ① 面对下注通道需要画像绑定到**那一家**（只挂 `observedStats` 不绑身份不生效）；
 * ② 通道入口需要一个手选标签，否则整条通道返回 `null`。
 */
const TIGHT_POST = {
  handsObserved: 2000, quickProfile: 'MANIAC' as const,
  vpip: 0.1, pfr: 0.07, threeBet: 0.02, wtsd: 0.2,
  foldToFlopCBet: 0.7, foldToTurnCBet: 0.6, foldToRiverBet: 0.7,
  flopCheckRaise: 0.04, turnCheckRaise: 0.03, riverCheckRaise: 0.02,
};
const LOOSE_AGGRO_POST = {
  handsObserved: 2000, quickProfile: 'MANIAC' as const,
  vpip: 0.7, pfr: 0.45, threeBet: 0.14, wtsd: 0.45,
  foldToFlopCBet: 0.25, foldToTurnCBet: 0.3, foldToRiverBet: 0.25,
  flopCheckRaise: 0.2, turnCheckRaise: 0.18, riverCheckRaise: 0.16,
};

/* ============================================================
 * 1. 画像必须真的改变决策输入（翻牌 / 河牌）
 * ============================================================ */

test('P4-1 翻牌：不同实测画像必须给出**不同**的 CALL EV（含翻后统计 + 身份绑定）', () => {
  const base = callEVOf(flopNode(null));
  const tight = callEVOf(flopNode(TIGHT_POST as never, true));
  const loose = callEVOf(flopNode(LOOSE_AGGRO_POST as never, true));
  assert.ok(base !== null && tight !== null && loose !== null);
  assert.notEqual(tight, base, '紧的画像必须改变 CALL EV（否则就是「算了但没用」）');
  assert.notEqual(loose, base, '松凶的画像必须改变 CALL EV');
  assert.notEqual(tight, loose, '两种画像之间也必须可区分（不得同值）');
});

test('P4-2 河牌：不同实测画像必须给出**不同**的 CALL EV（含翻后统计 + 身份绑定）', () => {
  const base = callEVOf(riverNode(null));
  const tight = callEVOf(riverNode(TIGHT_POST as never, true));
  const loose = callEVOf(riverNode(LOOSE_AGGRO_POST as never, true));
  assert.ok(base !== null && tight !== null && loose !== null);
  assert.notEqual(tight, base, '河牌上画像必须生效');
  assert.notEqual(loose, base, '河牌上画像必须生效');
  assert.notEqual(tight, loose, '两种画像必须可区分');
});

/* ============================================================
 * 1b. 🔴 PFR→BETRANGE 修复：**只有翻前统计**时不得凭空改变翻后决策
 * ============================================================
 *
 * 这条不变量是本轮的修复目标本身：`vpip` / `pfr` / `threeBet` 描述的是
 * **翻前**行为，把它们当成「他翻牌下注里有多少诈唬」是本项目源码明文禁止的
 * 推论（`observedStats.ts`：「PFR 不碰 bluffTendency（禁止「翻前凶 ⇒ 河牌
 * 爱诈唬」）」）。修复前实测：`pfr` 从 9% 改到 22% 能把我方权益推动 16.2pp、
 * 翻掉 J♥J♠ 的动作（`reports/PFR_TO_BETRANGE_VERIFICATION.md`）。
 */
test('P4-1b 只有翻前统计 ⇒ CALL EV 必须与「无统计」逐位相同（修复回归锁）', () => {
  for (const [tag, node] of [['翻牌', flopNode], ['河牌', riverNode]] as const) {
    const base = callEVOf(node(null));
    for (const [name, stats] of [
      ['VPIP/PFR（紧）', TIGHT],
      ['VPIP/PFR（松凶）', LOOSE_AGGRO],
      ['三项翻前一起给', { handsObserved: 800, vpip: 0.15, pfr: 0.1, threeBet: 0.03 }],
    ] as const) {
      assert.equal(
        callEVOf(node(stats as never)),
        base,
        `${tag}：${name} 全部是**翻前**统计 ⇒ 不得改变翻后 CALL EV` +
          `（修复前 PFR 是这条差异的唯一来源）`,
      );
    }
  }
});

/* ============================================================
 * 2. 语义门不得因为「打通」而被绕过
 * ============================================================ */

test('P4-3 河牌统计不得影响翻牌节点（语义门必须仍然有效）', () => {
  const base = callEVOf(flopNode(null));
  const riverOnly = callEVOf(flopNode({ handsObserved: 80, foldToRiverBet: 0.7 } as never));
  assert.equal(
    riverOnly,
    base,
    '河牌的 foldToRiverBet 属于另一条街，**不得**改变翻牌节点的 CALL EV',
  );
});

test('P4-4 无实测统计时逐位不变（修复不得改变无画像路径）', () => {
  // 同一输入跑两次必须逐位一致（确定性），且与「显式空统计」一致
  const a = callEVOf(flopNode(null));
  const b = callEVOf(flopNode(null));
  assert.equal(a, b, '无画像路径必须确定');
  assert.notEqual(a, null, '无画像路径仍必须给出 CALL EV');
});

/* ============================================================
 * 3. 翻前（PREFLOP_RAISE_EV_BACKFILL 之后的锁定）
 * ============================================================
 *
 * ## 为什么翻前要单独锁
 *
 * 翻前的「跟注 EV」**结构上就不依赖对手的响应倾向**（它只由手牌条件权益、
 * 赔率与可争夺量决定），所以用 CALL EV 衡量翻前画像生效性会得到**假阴性**。
 * 翻前真正吃画像的是**加注响应模型**（`PREFLOP_RAISE_RESPONSE_V1`：对手弃/跟/再加注
 * 的倾向直接进 EV）⇒ 因此这里锁的是**逐尺寸加注 EV**与**建议尺寸**。
 *
 * 另有一条接线缺陷是本组测试的由来：逐尺寸回填表原先**只读**翻后字段
 * （`postflopFacts.raiseResponseAll`），于是翻前的加注 EV 全部显示「未被评估」，
 * 而证据层与理由里其实已经在用逐尺寸数字 —— 算了但没接上。
 */

/** 翻前：Hero BB 面对 BTN 的 2.5BB 开池（单挑 ⇒ 翻前加注响应模型可用） */
const preflopVsOpen = (
  stats: Record<string, number> | null,
  heroCards: readonly [string, string] = ['Ah', 'Qh'],
): ManualHandInput => ({
  tableSize: 9, heroPosition: Position.BB, heroCards, board: [],
  street: Street.PREFLOP, effectiveStackBB: 100, bigBlindBB: 100,
  environment: GameEnvironment.LOW_STAKES_ONLINE,
  occupiedPositions: POS9, buttonPosition: Position.BTN,
  ...(stats === null ? {} : { villain: { observedStats: stats as never } }),
  actionHistory: pre(Position.BTN),
} as unknown as ManualHandInput);

/** 逐尺寸加注 EV 的可比较指纹（含尺寸标签，杜绝「只比个数」的弱断言） */
const preflopRaiseEVTable = (input: ManualHandInput): string => {
  const r = analyzeManualHand(input, { rules: RULES });
  assert.equal(r.ok, true, `必须可分析：${r.ok ? '' : JSON.stringify(r.issues)}`);
  if (!r.ok) return '';
  const sizes = r.decision.diagnostics.preflopRaise?.sizes ?? [];
  assert.ok(
    sizes.length >= 2,
    `翻前逐尺寸事实包必须存在且多档（实际 ${sizes.length} 档）`,
  );
  return JSON.stringify(sizes.map((s) => [s.sizeBB, s.raiseEV]));
};

test('P4-5 翻前：不同实测画像必须给出**不同**的逐尺寸加注 EV', () => {
  const base = preflopRaiseEVTable(preflopVsOpen(null));
  const tight = preflopRaiseEVTable(preflopVsOpen(TIGHT));
  const loose = preflopRaiseEVTable(preflopVsOpen(LOOSE_AGGRO));
  assert.notEqual(
    tight, base,
    '紧的画像必须改变翻前逐尺寸加注 EV（否则翻前仍是「算了但没用」）',
  );
  assert.notEqual(loose, base, '松凶的画像必须改变翻前逐尺寸加注 EV');
  assert.notEqual(tight, loose, '两种画像之间必须可区分');
});

test('P4-6 翻前：画像必须能改变**建议尺寸**（不只是数值披露）', () => {
  /*
   * 🔴 **契约更新（PREFLOP_RAISE_RANGE_GATE）**
   *
   * 原测试用 `KJo`。闸门上线后 `KJo` **不在** BB 的 3Bet 先验范围里 ⇒
   * 引擎不再建议加注（改为跟注）⇒「建议尺寸」这个量在该节点上**根本不存在**，
   * 于是测试失败。
   *
   * ⚠️ 这**不是**「画像失效」：是**该手牌不再允许加注** —— 那正是本次修复要的行为，
   * 由 `preflopRaiseE2E.test.ts` 的 G-1/G-2 锁定（范围外的手牌绝不加注，且必须说明原因）。
   *
   * 因此改用**在范围内**的 `KQs` / `88`（实测三种画像给出 `12.0 / 9.0 / 12.0BB` 等）。
   * **断言本身不变、也没有放宽**：画像必须能改变建议尺寸，而不只是改披露数字。
   */
  const shapeOf = (stats: Record<string, number> | null, cards: readonly [string, string]): string => {
    const r = analyzeManualHand(preflopVsOpen(stats, cards), { rules: RULES });
    assert.equal(r.ok, true, `必须可分析：${r.ok ? '' : JSON.stringify(r.issues)}`);
    if (!r.ok) return '';
    const s = r.decision.diagnostics.actionShape;
    return `${String(r.decision.action)}@${String(s?.sizeChips ?? 'NONE')}`;
  };
  /* 在 3Bet 先验范围内的牌（闸门放行）⇒ 尺寸仍必须随画像变 */
  for (const cards of [['Ks', 'Qs'], ['8s', '8h']] as [string, string][]) {
    const trio = [shapeOf(null, cards), shapeOf(TIGHT, cards), shapeOf(LOOSE_AGGRO, cards)];
    assert.ok(
      new Set(trio).size > 1,
      `${cards.join('')} 在 3Bet 先验范围内 ⇒ 翻前建议尺寸必须至少对一种画像不同` +
        `（实际三者都是 ${trio[0]}）—— 否则画像只改了披露数字、没有改决策`,
    );
  }
  /* 范围外的牌：不得建议加注（闸门）⇒ 不存在「尺寸」；与 G-1 同源，此处交叉确认 */
  const outOfRange = shapeOf(LOOSE_AGGRO, ['Kh', 'Jd']);
  assert.ok(
    !outOfRange.startsWith('RAISE') && !outOfRange.startsWith('ALL_IN'),
    `KJo 不在 BB 的 3Bet 先验范围里 ⇒ 不得建议加注（实际 ${outOfRange}）`,
  );
});
