/*
 * 🔴 **牌力档 + 「这条建议该不该信」** 的回归锁。
 *
 * ## 这个功能为什么存在（不是 UI 偏好，是实测结论的落地）
 *
 * `reports/REAL_HAND_VALIDATION.md` §6 实测：引擎预测的弃牌率**系统性偏高**
 * （预测 65–75% vs 真实 `fold-to-flop-bet` 51.6%），且**几乎没有分辨力**
 * （与真实弃牌的相关系数 r ≈ −0.03）。
 *
 * 这个偏差**只落在依赖弃牌率的建议上**，所以「该不该信」可以由牌力档推出：
 *
 * | 档 | 建议的利润来自 | 该不该信 |
 * |---|---|---|
 * | 强牌（坚果/强价值） | **摊牌权益**（数学） | ✅ 可以信 |
 * | 中等牌 | 混合 | ⚠️ 打折 |
 * | 弱牌/听牌 | **弃牌率**（引擎算高了） | ❌ 最不可信 |
 *
 * ⚠️ 本测试锁的是**映射关系与 Fail-Closed 行为**，不是配色或文案措辞。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AdviceTrust,
  HandStrengthTier,
  handStrengthHintOf,
} from '../src/viewmodels/handStrengthHint.ts';
import { RelativeHandRole, RELATIVE_ROLE_ZH } from '../src/domain/postflop/types.ts';

test('H1：强牌（坚果/强价值）⇒ 可以信 —— 它们靠权益赢，与弃牌率无关', () => {
  for (const role of [RelativeHandRole.NUT_VALUE, RelativeHandRole.STRONG_VALUE]) {
    const h = handStrengthHintOf(role, 0.9);
    assert.ok(h !== null, `${role} 必须有映射`);
    assert.equal(h!.tier, HandStrengthTier.STRONG, `${role} 必须是强牌档`);
    assert.equal(h!.trust, AdviceTrust.TRUST, `${role} 必须判「可以信」`);
  }
});

test('H2：弱牌/听牌 ⇒ 最不可信 —— 它们基本靠弃牌率（而引擎把弃牌率算高了）', () => {
  for (const role of [
    RelativeHandRole.DRAW,
    RelativeHandRole.SEMI_BLUFF,
    RelativeHandRole.PURE_BLUFF,
    RelativeHandRole.AIR,
  ]) {
    const h = handStrengthHintOf(role, 0.2);
    assert.ok(h !== null, `${role} 必须有映射`);
    assert.equal(h!.tier, HandStrengthTier.WEAK, `${role} 必须是弱牌档`);
    assert.equal(h!.trust, AdviceTrust.DISTRUST, `${role} 必须判「最不可信」`);
  }
});

test('H3：中等牌 ⇒ 打折 —— 它们混合依赖，不能一刀切', () => {
  for (const role of [
    RelativeHandRole.MEDIUM_VALUE,
    RelativeHandRole.THIN_VALUE,
    RelativeHandRole.BLUFF_CATCHER,
    RelativeHandRole.SHOWDOWN_VALUE,
  ]) {
    const h = handStrengthHintOf(role, 0.5);
    assert.ok(h !== null, `${role} 必须有映射`);
    assert.equal(h!.tier, HandStrengthTier.MEDIUM, `${role} 必须是中等牌档`);
    assert.equal(h!.trust, AdviceTrust.DISCOUNT, `${role} 必须判「打折」`);
  }
});

test('H4：10 档角色**全部**有映射，且中文名取自领域层那一份（不得两处各写一份）', () => {
  const all = Object.values(RelativeHandRole);
  assert.equal(all.length, 10, '`RelativeHandRole` 必须是 10 档（若改动本测试需同步）');
  for (const role of all) {
    const h = handStrengthHintOf(role, 0.5);
    assert.ok(h !== null, `${role} 必须有映射（不得漏档）`);
    assert.equal(
      h!.roleZh,
      RELATIVE_ROLE_ZH[role],
      `${role} 的中文名必须与领域层 \`RELATIVE_ROLE_ZH\` 一致`,
    );
  }
});

test('H5：🔴 Fail Closed —— 未知角色 / 缺角色必须返回 null（**不猜**一个信任等级）', () => {
  assert.equal(handStrengthHintOf(null, 0.5), null, 'null 角色 ⇒ null');
  assert.equal(handStrengthHintOf(undefined, 0.5), null, 'undefined 角色 ⇒ null');
  assert.equal(handStrengthHintOf('', 0.5), null, '空串 ⇒ null');
  /*
   * 关键一条：快照层的 `handRole` 被放宽成了 `string`
   *（`decision.types.ts:467`），所以**运行时白名单校验**是唯一防线。
   * 若哪天有人往引擎里加了一个新角色而忘了在这里登记，
   * 必须表现为「界面显示 —」，**不是**给一个错的信任等级 ——
   * 那会让使用者照着一个错误的「可以信」下注。
   */
  assert.equal(handStrengthHintOf('SOME_FUTURE_ROLE', 0.5), null, '未知角色 ⇒ null（不得猜）');
  assert.equal(handStrengthHintOf('nut_value', 0.5), null, '大小写不符 ⇒ null（不得宽松匹配）');
});

test('H6：强度缺失/非法时不得产生 NaN 文案', () => {
  for (const bad of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
    const h = handStrengthHintOf(RelativeHandRole.STRONG_VALUE, bad as never);
    assert.ok(h !== null);
    assert.ok(Number.isFinite(h!.strength), `强度 ${String(bad)} 必须被收敛成有限数`);
    assert.ok(!h!.lineZh.includes('NaN'), '文案里不得出现 NaN');
  }
});

test('H7：`lineZh` 同时含牌力档、角色名与信任结论（首屏一句话可读）', () => {
  const h = handStrengthHintOf(RelativeHandRole.AIR, 0.1);
  assert.ok(h !== null);
  assert.ok(h!.lineZh.includes('弱牌'), '必须含牌力档');
  assert.ok(h!.lineZh.includes(RELATIVE_ROLE_ZH[RelativeHandRole.AIR]), '必须含角色名');
  assert.ok(h!.lineZh.includes('弃牌率'), '必须说明「为什么不可信」（机理，不是泛泛的「小心」）');
});
