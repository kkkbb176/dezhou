/**
 * ============================================================================
 * RIVER BET RANGE V2 —— 旧缺陷复现（第一阶段：先写测试，再改产品代码）
 * ============================================================================
 *
 * 本文件**只使用修改前就已存在的 API**，因此每一条失败都指向真实行为缺陷，
 * 而不是「新接口还没写」：
 *
 * | 编号 | 复现什么 | 修改前的表现 |
 * |---|---|---|
 * | D-1 | 下注概率直接依赖 Hero 的**隐藏底牌**（第四阶段：信息泄漏） | 同一个对手组合、同一牌面/尺寸/画像，换掉 Hero 底牌后权重从 0 变成 0.0197 |
 * | D-2 | `SHOWDOWN_VALUE` 整类被夹到精确 0（第三阶段） | 被动画像下 showdownMass = 0.000000 |
 * | D-3 | 连「Hero 能击败的成手牌」也一个都进不了下注范围（同上） | 下注范围里没有任何一对能被 Hero 击败 |
 *
 * ⚠️ 本文件**不锁任何最终动作**，也不锁权益的具体百分比。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';
import { buildBettingRangeFacts } from '../src/app/manualInput/bettingRange.ts';
import { parseManualInput, type ManualHandInput } from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import { responseTendenciesOf } from '../src/domain/postflop/betResponse.ts';
import { archetypeDimensionsOf } from '../src/domain/player/archetypeDimensions.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import { ALL_CARDS, parseCardStrict } from '../src/domain/poker/cards.ts';
import { compareHands, evaluateCards } from '../src/domain/poker/handEval.ts';
import { describeHand } from '../src/domain/poker/handDescription.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const SEED = 20_261_014;
const BOARD = ['Kd', '9c', '4h', '6s', '2d'] as const;

type Row = { position: string; type: string; amountBB?: number; street?: string };
const A = (position: string, type: string, amountBB?: number, street?: string): Row => ({
  position,
  type,
  ...(amountBB === undefined ? {} : { amountBB }),
  ...(street === undefined ? {} : { street }),
});

/** Hero BTN A♠K♠；BB 河牌领打 20BB（= 40 筹码，底池 93） */
function akInput(riverBetBB = 20, profile = 'CALLING_STATION'): ManualHandInput {
  return {
    tableSize: 6,
    heroPosition: 'BTN',
    heroCards: ['As', 'Ks'],
    board: [...BOARD],
    street: 'RIVER',
    effectiveStackBB: 100,
    bigBlindBB: 2,
    seatStacksBB: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 },
    actionHistory: [
      A('UTG', 'FOLD'), A('HJ', 'FOLD'), A('CO', 'FOLD'), A('BTN', 'RAISE', 3), A('SB', 'FOLD'), A('BB', 'CALL', 2),
      A('BB', 'CHECK', undefined, 'FLOP'), A('BTN', 'BET', 2.5, 'FLOP'), A('BB', 'CALL', 2.5, 'FLOP'),
      A('BB', 'CHECK', undefined, 'TURN'), A('BTN', 'BET', 7.5, 'TURN'), A('BB', 'CALL', 7.5, 'TURN'),
      A('BB', 'BET', riverBetBB, 'RIVER'),
    ],
    environment: 'MID_LOW_STAKES',
    villain: { quickProfile: profile, dynamicHint: 'UNKNOWN', stackBB: 100 },
  } as unknown as ManualHandInput;
}

function contextOf(input: ManualHandInput) {
  const parsed = parseManualInput(input);
  assert.equal(parsed.ok, true, '必须能解析');
  if (!parsed.ok) throw new Error('unreachable');
  const gate = buildAnalyzableState(parsed.value);
  assert.equal(gate.ok, true, '必须能重建');
  if (!gate.ok) throw new Error('unreachable');
  return buildDecisionContext({
    state: gate.state,
    rules: RULES,
    environment: 'MID_LOW_STAKES',
    asOf: 1_757_000_000_000,
    quickProfile: input.villain?.quickProfile,
    equitySeed: SEED,
  }).context;
}

/* ============================================================
 * D-1 下注概率不得依赖 Hero 的隐藏底牌（第四阶段 / M5）
 * ============================================================ */

test('D-1（信息泄漏）：同一对手组合的下注权重不得随 Hero 隐藏底牌变化', () => {
  const board = BOARD.map(parseCardStrict);

  /*
   * 固定到达范围：只取**与两副 Hero 底牌都不重叠**的牌池，
   * 因此不存在「合法阻断」造成的差异 —— 任何权重差异都只能来自
   * 「模型读了 Hero 的底牌」。
   *
   * 牌池刻意包含 Kc/Kh（能在 K 高牌面组成顶对）与 J/T/9/8/7/5/3/2 各两张，
   * 使得同一组合在两副 Hero 底牌下的「相对 Hero 强弱」不同。
   */
  const pool = ['Kc', 'Kh', 'Jc', 'Jd', 'Tc', 'Td', '8c', '8d', '7c', '7d', '5c', '5d', '3c', '3d', '2c', '2h'];
  const cards = pool.map(parseCardStrict);
  const arrival: { cardIndices: readonly [number, number]; probability: number }[] = [];
  for (let i = 0; i < cards.length; i += 1) {
    for (let j = i + 1; j < cards.length; j += 1) {
      const idx = (c: (typeof cards)[number]): number => ALL_CARDS.findIndex((x) => x.rank === c.rank && x.suit === c.suit);
      arrival.push({ cardIndices: [idx(cards[i]!), idx(cards[j]!)] as const, probability: 1 });
    }
  }
  assert.ok(arrival.length > 50, `牌池必须给出足够多的组合（实际 ${arrival.length}）`);

  const dims = archetypeDimensionsOf('CALLING_STATION', 0.35);
  const tendencies = responseTendenciesOf(dims, 0.35, null);

  const weightsUnder = (heroHole: readonly string[], heroStr: string): Map<string, number> => {
    const hero = heroHole.map(parseCardStrict);
    const f = buildBettingRangeFacts({
      arrivalEntries: arrival,
      board,
      heroHole: hero,
      potChips: 53,
      betChips: 40,
      street: 'RIVER',
      tendencies,
    });
    assert.ok(f, `${heroStr}：必须能构造下注范围`);
    const heroEval = evaluateCards([...hero, ...board]);
    const out = new Map<string, number>();
    for (const e of f!.entries) {
      const hole = [ALL_CARDS[e.cardIndices[0]]!, ALL_CARDS[e.cardIndices[1]]!] as const;
      // Hero 自己的底牌构成的组合属于**合法阻断**，不参与比较
      if (hole.some((c) => hero.some((h) => h.rank === c.rank && h.suit === c.suit))) continue;
      const vs = compareHands(evaluateCards([...hole, ...board]), heroEval);
      void vs;
      out.set(`${hole[0].rank}${hole[0].suit}${hole[1].rank}${hole[1].suit}`, e.probability);
    }
    return out;
  };

  const w1 = weightsUnder(['As', 'Ks'], 'Hero=A♠K♠（顶对 K，A 踢脚）');
  const w2 = weightsUnder(['Ah', 'Qh'], 'Hero=A♥Q♥（A 高牌）');

  const shared = [...w1.keys()].filter((k) => w2.has(k));
  assert.ok(shared.length > 30, `两副 Hero 底牌下都必须有足够多的共同组合（实际 ${shared.length}）`);

  const leaks: string[] = [];
  for (const key of shared) {
    const a = w1.get(key)!;
    const b = w2.get(key)!;
    if (Math.abs(a - b) > 1e-12) leaks.push(`${key}: ${a.toFixed(6)} vs ${b.toFixed(6)}`);
  }
  assert.deepEqual(
    leaks.slice(0, 8),
    [],
    `共有 ${leaks.length}/${shared.length} 个组合的下注权重随 Hero 隐藏底牌变化 ⇒ ` +
      'Villain 的下注行为模型读了它不该读的信息（第四阶段：分类解耦）',
  );
});

/* ============================================================
 * D-2 / D-3 SHOWDOWN 整类不得被夹到 0（第三阶段）
 * ============================================================ */

test('D-2（结构性过滤）：被动画像下，「有摊牌价值的牌」不得整类消失', () => {
  const c = contextOf(akInput(20, 'CALLING_STATION'));
  const bet = c.postflopFacts?.bettingRangeFacts;
  assert.ok(bet, '下注范围必须存在');

  assert.ok(
    bet!.classMasses.showdownMass > 0,
    `被动画像的下注范围里，摊牌类质量不得为 0（实际 ${bet!.classMasses.showdownMass}）——` +
      '一个极宽的类别因为线性公式被 clamp 到 0 就整体消失，是结构性缺陷',
  );
  assert.ok(
    bet!.classMasses.showdownMass + bet!.classMasses.bluffMass > 0.0001,
    '「Hero 能击败的牌」不得在下注范围里被完全删除',
  );
});

test('D-3（结构性过滤）：下注范围里必须有「Hero 能击败的成手牌」', () => {
  const board = BOARD.map(parseCardStrict);
  const hero = ['As', 'Ks'].map(parseCardStrict);
  const heroEval = evaluateCards([...hero, ...board]);

  /*
   * 合成到达范围：只有**弱顶对**（K + 弱踢脚，Hero 的 A♠K♠ 全部击败它们）
   * 与一个参照用的暗三条。同一个画像、同一个尺寸。
   *
   * 修改前：弱顶对落在 `SHOWDOWN_VALUE`，其 P(BET) 被夹到精确 0
   * ⇒ 下注范围里一个「Hero 能击败的成手牌」都没有（只剩诈唬的空气）。
   */
  const pairs: Array<[string, string]> = [
    ['Kc', 'Jd'], ['Kc', 'Td'], ['Kc', '8d'], ['Kc', '7d'], ['Kc', '5d'], ['Kc', '3d'],
    ['Kh', 'Jc'], ['Kh', 'Tc'], ['Kh', '8c'], ['Kh', '7c'], ['Kh', '5c'], ['Kh', '3c'],
    ['9d', '9h'], ['4d', '4c'],
  ];
  const idx = (s: string): number => {
    const card = parseCardStrict(s);
    return ALL_CARDS.findIndex((x) => x.rank === card.rank && x.suit === card.suit);
  };
  const arrival = pairs.map(([a, b]) => ({ cardIndices: [idx(a), idx(b)] as const, probability: 1 }));

  const dims = archetypeDimensionsOf('CALLING_STATION', 0.35);
  const tendencies = responseTendenciesOf(dims, 0.35, null);
  const f = buildBettingRangeFacts({
    arrivalEntries: arrival, board, heroHole: hero, potChips: 53, betChips: 40, street: 'RIVER', tendencies,
  });
  assert.ok(f, '必须能构造下注范围');

  const weakerMadeHands: string[] = [];
  for (const e of f!.entries) {
    const hole = [ALL_CARDS[e.cardIndices[0]]!, ALL_CARDS[e.cardIndices[1]]!] as const;
    const cmp = compareHands(evaluateCards([...hole, ...board]), heroEval);
    if (cmp >= 0) continue; // Hero 没赢
    const shape = describeHand([hole[0], hole[1]], board).shape;
    if (shape === 'HIGH_CARD' || shape === 'PLAY_THE_BOARD') continue; // 纯空气不算
    weakerMadeHands.push(`${hole[0].rank}${hole[0].suit}${hole[1].rank}${hole[1].suit}(${shape})`);
  }
  assert.ok(
    weakerMadeHands.length > 0,
    '下注范围里必须存在「Hero 能击败的成手牌」（弱顶对 / 次级对子等）—— ' +
      '否则说明模型把「不会诈唬」当成了「不会下注」',
  );
});
