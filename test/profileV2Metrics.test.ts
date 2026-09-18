/**
 * PLAYER PROFILE QUANTIFICATION V2 —— 统一似然与范围指标的永久锁
 *
 * 覆盖：
 * 1. **NEUTRAL_PARITY 网格**（§三/§三十一）：River 25/75/125% × 全部类别 ×
 *    两种前序线 —— 中性画像的结果必须与**既有档位权重**逐位相等。
 * 2. **`RiverComboClass` 覆盖锁**（§六/§四十一）：枚举成员不得有生产不可达者。
 *    （V2 删除了 `MEDIUM_VALUE`；这条锁防止将来再出现一个"死"成员。）
 * 3. **§二十七 / §二十八 指标**的公式与边界。
 * 4. **§二十三 `profileRangeDistance`**：相同 ⇒ 0，不相交 ⇒ 1，对称。
 * 5. **钳位可见性**（§十七）：03A/03B 在黄金节点上**不得饱和**（`clamped === false`）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ALL_CARDS, type Card } from '../src/domain/types.ts';
import { C } from './helpers.ts';
import {
  behaviorProfileOf,
  estimateUnifiedActionLikelihood,
  type BehaviorNodeContext,
  type RiverComboClass,
} from '../src/domain/player/behaviorProfile.ts';
import { riverComboClassOf } from '../src/domain/postflop/riverProfileClassify.ts';
import {
  effectiveCombosOf,
  posteriorMassCombosOf,
  profileRangeDistance,
} from '../src/domain/player/profileRangeMetrics.ts';
import { likelihoodWeights, tierWeightOf } from '../src/app/manualInput/likelihoodModel.ts';

/** 全部枚举成员（**手写清单**：新增成员时这条测试会要求你明确处理） */
const ALL_RIVER_COMBO_CLASSES: readonly RiverComboClass[] = [
  'NUT_VALUE',
  'STRONG_VALUE',
  'THIN_VALUE',
  'SHOWDOWN_VALUE',
  'MISSED_FLUSH_DRAW',
  'MISSED_STRAIGHT_DRAW',
  'MISSED_COMBO_DRAW',
  'PURE_AIR',
];

/** 生产里 `riverComboClassOf` 给出的类别 → 既有档位（代表值） */
const CLASS_BUCKET: readonly (readonly [RiverComboClass, number])[] = [
  ['NUT_VALUE', 0],
  ['STRONG_VALUE', 1],
  ['THIN_VALUE', 2],
  ['SHOWDOWN_VALUE', 3],
  ['MISSED_FLUSH_DRAW', 5],
  ['MISSED_STRAIGHT_DRAW', 5],
  ['MISSED_COMBO_DRAW', 5],
  ['PURE_AIR', 5],
];

const node = (line: BehaviorNodeContext['previousStreetLine']): BehaviorNodeContext => ({
  street: 'RIVER',
  heroPosition: 'CO',
  villainPosition: 'BB',
  potType: 'SRP',
  playerCount: 2,
  previousStreetLine: line,
  currentAction: 'BET',
  sizeBucket: 'LARGE',
  boardTexture: 'SEMI_WET',
});

/* ============================================================
 * 1. NEUTRAL_PARITY 网格（逐位相等，不接受容差）
 * ============================================================ */

test('NEUTRAL_PARITY：中性画像必须在 3 尺寸 × 8 类别 × 2 前序线上与既有档位权重**逐位相等**', () => {
  const neutral = behaviorProfileOf({ playerId: 'neutral', archetype: null });
  let cells = 0;
  let worst = 0;
  for (const ratio of [0.25, 0.75, 1.25]) {
    for (const [cls, bucket] of CLASS_BUCKET) {
      for (const line of ['TURN_CHECK_BACK', 'TURN_BET_CALL'] as const) {
        const legacy = tierWeightOf(likelihoodWeights('AGGRESSIVE', ratio), bucket);
        const u = estimateUnifiedActionLikelihood({
          semanticClass: cls,
          strengthBucket: bucket,
          betRatio: ratio,
          node: node(line),
          profile: neutral,
          action: 'BET',
        });
        const diff = Math.abs(u.likelihood - legacy);
        worst = Math.max(worst, diff);
        assert.equal(
          u.likelihood,
          legacy,
          `中性画像必须逐位等于既有档位权重：${cls} @ ${ratio} / ${line} ` +
            `⇒ ${u.likelihood} vs ${legacy}（差 ${diff}）`,
        );
        cells += 1;
      }
    }
  }
  assert.equal(cells, 48, '网格必须是 3 × 8 × 2 = 48 个单元');
  assert.equal(worst, 0, `最大绝对差必须为 0，实际 ${worst}`);
});

/* ============================================================
 * 2. RiverComboClass 覆盖锁（防"生产永不可达"的枚举成员）
 * ============================================================ */

test('覆盖锁：RiverComboClass 的每个成员都必须真的能被 riverComboClassOf 产出', () => {
  const boards: readonly { board: Card[]; hero: Card[] }[] = [
    { board: C('Ad 8s 4s 2c Kd'), hero: C('Ac Jh') },
    { board: C('Qs 8d 3c 6s Ks'), hero: C('Ah Qc') },
    { board: C('Kc 9s 5d 2h 7c'), hero: C('Ah 9h') },
    { board: C('Th 9h 2s 3d 4c'), hero: C('Ac Ad') },
    { board: C('7s 6s 2s Kh Qd'), hero: C('Ac Ks') },
    // 弱 Hero ⇒ 更多对手组合落在「比 Hero 强」，其中含该牌面的**绝对坚果**（档 0）
    // ⇒ 才能覆盖 NUT_VALUE（档 0 是相对**牌面**定义的，与 Hero 无关）
    { board: C('Ad 8s 4s 2c Kd'), hero: C('3c 2d') },
    { board: C('Qs 8d 3c 6s Ks'), hero: C('4h 2c') },
    { board: C('Kc 9s 5d 2h 7c'), hero: C('3h 2d') },
    /*
     * 档 0 = 同花顺 / 四条 / 葫芦（已成的顶级牌，见 `boardRelativeTierOfShape`）。
     * ⚠️ 在**无对子**的牌面上，两名对手各 2 张底牌**不可能**做出四条/葫芦
     * （最多三条 = 档 1）⇒ 必须用**有对子的牌面**或**同花顺牌面**才能覆盖 NUT_VALUE。
     * 这两条就是为此加的（弱 Hero ⇒ 对手的顶级牌同时满足「比 Hero 强」）。
     */
    { board: C('Ad As 8d 4c 2h'), hero: C('3c 2d') }, // 对手 AhAc ⇒ 四条 A（档 0）
    { board: C('7s 6s 5s 4s 2h'), hero: C('3c 2d') }, // 对手 9s8s ⇒ 同花顺（档 0）
  ];
  const produced = new Set<RiverComboClass>();
  for (const { board, hero } of boards) {
    for (let i = 0; i < ALL_CARDS.length; i += 1) {
      for (let j = i + 1; j < ALL_CARDS.length; j += 1) {
        const hole = [ALL_CARDS[i]!, ALL_CARDS[j]!] as const;
        const r = riverComboClassOf({ hole, board, heroHole: hero });
        if (r !== null) produced.add(r.category);
      }
    }
  }
  const missing = ALL_RIVER_COMBO_CLASSES.filter((c) => !produced.has(c));
  assert.deepEqual(
    missing,
    [],
    `以下枚举成员在本扫描中**从未被产出**，即生产不可达（§六/§四十一 禁止）：${missing.join(', ')}\n` +
      `若确为死成员 ⇒ 删除它；若应当可达 ⇒ 修正 classifyRiverAction/riverComboClassOf 的判据并同步黄金夹具。`,
  );
});

/* ============================================================
 * 3. §二十七 / §二十八 指标
 * ============================================================ */

test('§二十七 effectiveCombos：等权时等于组合数，集中时趋近 1', () => {
  const equal = effectiveCombosOf([0.25, 0.25, 0.25, 0.25]);
  assert.ok(equal !== null && Math.abs(equal - 4) < 1e-12, `等权 4 个组合 ⇒ 4，实际 ${equal}`);

  const concentrated = effectiveCombosOf([1, 0, 0, 0]);
  assert.ok(
    concentrated !== null && Math.abs(concentrated - 1) < 1e-12,
    `一个组合独占 ⇒ 1，实际 ${concentrated}`,
  );

  // 单调：越集中越小
  const spread = effectiveCombosOf([0.4, 0.3, 0.2, 0.1])!;
  const tight = effectiveCombosOf([0.7, 0.1, 0.1, 0.1])!;
  assert.ok(tight < spread, `越集中等效组合数越小：${tight} vs ${spread}`);

  assert.equal(effectiveCombosOf([]), null, '空输入必须返回 null（不编造 0）');
  assert.equal(effectiveCombosOf([0, 0, 0]), null, '全零权重必须返回 null');
});

test('§二十八 posteriorMassCombos：90% / 95% 质量所需的最少组合数', () => {
  assert.equal(posteriorMassCombosOf([1, 0, 0], 0.9), 1, '独占 ⇒ 1 个组合即达 90%');
  assert.equal(posteriorMassCombosOf([0.5, 0.5], 0.9), 2, '两个各半 ⇒ 需要 2 个');
  // 降序累计：0.6 + 0.3 = 0.9 ⇒ 需 2 个
  assert.equal(posteriorMassCombosOf([0.6, 0.3, 0.1], 0.9), 2, '0.6+0.3 = 0.9 ⇒ 2 个');
  // 95% 需要到第三个
  assert.equal(posteriorMassCombosOf([0.6, 0.3, 0.1], 0.95), 3, '90% 之外还要再取一个');
  assert.equal(posteriorMassCombosOf([], 0.9), null, '空输入必须返回 null');
  // 大量等权组合时，90% 所需个数应远小于总数（「不能把 N 当等权」的量化证据）
  const many = Array.from({ length: 400 }, () => 1);
  const n90 = posteriorMassCombosOf(many, 0.9)!;
  assert.ok(
    n90 >= 360 && n90 <= 400,
    `等权 400 个时 90% 需要 ≈360 个，实际 ${n90}`,
  );
});

/* ============================================================
 * 4. §二十三 profileRangeDistance
 * ============================================================ */

test('§二十三 profileRangeDistance：相同 ⇒ 0、不相交 ⇒ 1、且对称有界', () => {
  const identical = profileRangeDistance([0.5, 0.5], [0.5, 0.5])!;
  assert.equal(identical.totalVariation, 0, '相同分布的全变差必须为 0');
  assert.equal(identical.jsDivergence, 0, '相同分布的 JS 散度必须为 0');
  assert.equal(identical.sharedSupport, 2);

  const disjoint = profileRangeDistance([1, 0], [0, 1])!;
  assert.equal(disjoint.totalVariation, 1, '不相交分布的全变差必须为 1');
  assert.equal(disjoint.jsDivergence, 1, '不相交分布的 JS 散度必须为 1（log 底 2）');
  assert.equal(disjoint.sharedSupport, 0);

  const ab = profileRangeDistance([0.7, 0.3], [0.2, 0.8])!;
  const ba = profileRangeDistance([0.2, 0.8], [0.7, 0.3])!;
  assert.equal(ab.jsDivergence, ba.jsDivergence, 'JS 散度必须对称');
  assert.ok(ab.jsDivergence > 0 && ab.jsDivergence < 1, '介于 0 与 1 之间');

  assert.equal(profileRangeDistance([0.5], [0.5, 0.5]), null, '长度不一致必须返回 null');
  assert.equal(profileRangeDistance([], []), null, '空输入必须返回 null');
});

/* ============================================================
 * 5. 钳位可见性：03A/03B 在黄金节点上不得饱和（§十七）
 * ============================================================ */

test('§十七 钳位可见：03A / 03B 在黄金节点上不得出现饱和（clamped === false）', () => {
  const cs = behaviorProfileOf({ playerId: 'bb', archetype: 'CALLING_STATION' });
  const maniac = behaviorProfileOf({ playerId: 'bb', archetype: 'MANIAC' });
  for (const profile of [cs, maniac]) {
    for (const [cls, bucket] of CLASS_BUCKET) {
      const u = estimateUnifiedActionLikelihood({
        semanticClass: cls,
        strengthBucket: bucket,
        betRatio: 0.75,
        node: node('TURN_CHECK_BACK'),
        profile,
        action: 'BET',
        withTrace: true,
      });
      assert.equal(
        u.clamped,
        false,
        `${cls} 被钳位（raw=${u.rawLikelihood} ⇒ ${u.likelihood}）：` +
          `说明「能赢 Hero」与「Hero 能赢」的类别被压平成同一个值，类别区分已失效`,
      );
      /*
       * ⚠️ 「远离 1」只对**真正会施加条件化**的类别有意义：
       * 价值端（NUT/STRONG）与摊牌端的调整恒为 1，`raw` 就是基准
       * （坚果 0.95 本来就接近 1，那**不是**饱和风险 —— 没有任何因子会去乘它）。
       */
      const conditionable =
        cls === 'MISSED_FLUSH_DRAW' ||
        cls === 'MISSED_STRAIGHT_DRAW' ||
        cls === 'MISSED_COMBO_DRAW' ||
        cls === 'PURE_AIR';
      if (conditionable) {
        assert.ok(
          u.rawLikelihood <= 0.5,
          `${cls} 的钳位前似然必须远离 1（实得 ${u.rawLikelihood}）—— 否则画像一旦更强就会饱和`,
        );
      }
      assert.ok(u.trace.length > 0, 'withTrace: true 时必须产出 trace');
    }
  }
});
