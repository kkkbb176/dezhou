/*
 * 🔴 **牌力档 + 「这条建议该不该信」**（使用者要求：一眼看出要不要信它）
 *
 * ## 为什么可信度要跟牌力挂钩（不是拍脑袋，是本项目实测的结论）
 *
 * `reports/REAL_HAND_VALIDATION.md` §6 实测：引擎预测的弃牌率**系统性偏高**
 * （预测 65–75% vs 真实 `fold-to-flop-bet` 51.6%），且**几乎没有分辨力**
 * （与真实弃牌的相关系数 r ≈ −0.03）。
 *
 * 后果**只落在依赖弃牌率的建议上**：
 *
 * | 牌力档 | 建议的利润来自哪 | 引擎可信度 |
 * |---|---|---|
 * | 强牌（坚果/强价值） | **摊牌权益** —— 数学，与弃牌率无关 | ✅ **可以信** |
 * | 中等牌（中等/薄价值/抓诈/摊牌） | 混合，开始依赖对手会不会弃/跟 | ⚠️ 打折 |
 * | 弱牌（听牌/半诈唬/空气/纯诈唬） | **几乎全靠弃牌率** —— 而它算高了 | ❌ **最不可信** |
 *
 * 这不是「牌力越强越信」的泛泛之谈 —— 它有**明确的机理**：
 * 引擎唯一被实测证伪的模块就是弃牌率，所以依赖它的建议最不可信。
 *
 * ## 为什么放在 `viewmodels` 层
 *
 * 它不改任何决策（纯展示）；依据是**领域层已有的** `RelativeHandRole`
 * 与本项目的实测结论。领域层保持纯函数，展示层负责翻译成人话。
 */
import { RelativeHandRole, RELATIVE_ROLE_ZH } from '../domain/postflop/types.ts';

/** 牌力档（给使用者看的一眼判断） */
export const HandStrengthTier = {
  STRONG: 'STRONG',
  MEDIUM: 'MEDIUM',
  WEAK: 'WEAK',
} as const;
export type HandStrengthTier = (typeof HandStrengthTier)[keyof typeof HandStrengthTier];

/** 「这条建议该不该信」 */
export const AdviceTrust = {
  /** 利润来自权益 ⇒ 与那个被证伪的模块无关 ⇒ 可以信 */
  TRUST: 'TRUST',
  /** 混合 ⇒ 打折看 */
  DISCOUNT: 'DISCOUNT',
  /** 几乎全靠弃牌率 ⇒ 最不可信 */
  DISTRUST: 'DISTRUST',
} as const;
export type AdviceTrust = (typeof AdviceTrust)[keyof typeof AdviceTrust];

/**
 * `RelativeHandRole` → 牌力档 + 信任等级。
 *
 * ## ⚠️ 这里的键类型是 `string`，**不是** `RelativeHandRole` —— 后果必须写清楚
 *
 * 我一度把它写成 `Record<RelativeHandRole, …>` 并在注释里声称「漏一档会在 TS 层报错」。
 * **那句话不成立**：为了能接受快照层放宽后的 `string`，键必须写成 `string`
 * ⇒ **TypeScript 不会**因为漏掉某一档而报错。
 *
 * 因此「10 档全覆盖」由**测试**保证，不是由类型保证：
 * `test/handStrengthHint.test.ts` 的 `H4` 遍历 `Object.values(RelativeHandRole)`
 * 逐个断言有映射。**改动本表必须同时看那条测试。**
 *
 * ## 为什么不能靠 `Record<RelativeHandRole, …>` 来拿类型保护
 *
 * 那样入参也得是 `RelativeHandRole`，而快照层给的是 `string`
 *（`decision.types.ts:467`）⇒ 要么改引擎契约（风险外溢），要么在调用处 `as`（等于没有保护）。
 * 选运行时白名单 + 测试锁，是这里能拿到的最强保证。
 */
const ROLE_TO_TIER: Readonly<Record<string, { tier: HandStrengthTier; trust: AdviceTrust }>> =
  Object.freeze({
    /* ---- 强牌：利润来自摊牌权益 ---- */
    [RelativeHandRole.NUT_VALUE]: { tier: HandStrengthTier.STRONG, trust: AdviceTrust.TRUST },
    [RelativeHandRole.STRONG_VALUE]: { tier: HandStrengthTier.STRONG, trust: AdviceTrust.TRUST },
    /* ---- 中等牌：混合，开始依赖对手反应 ---- */
    [RelativeHandRole.MEDIUM_VALUE]: { tier: HandStrengthTier.MEDIUM, trust: AdviceTrust.DISCOUNT },
    [RelativeHandRole.THIN_VALUE]: { tier: HandStrengthTier.MEDIUM, trust: AdviceTrust.DISCOUNT },
    [RelativeHandRole.BLUFF_CATCHER]: { tier: HandStrengthTier.MEDIUM, trust: AdviceTrust.DISCOUNT },
    [RelativeHandRole.SHOWDOWN_VALUE]: { tier: HandStrengthTier.MEDIUM, trust: AdviceTrust.DISCOUNT },
    /* ---- 弱牌：利润几乎全靠弃牌率（引擎算高的那一个） ---- */
    [RelativeHandRole.DRAW]: { tier: HandStrengthTier.WEAK, trust: AdviceTrust.DISTRUST },
    [RelativeHandRole.SEMI_BLUFF]: { tier: HandStrengthTier.WEAK, trust: AdviceTrust.DISTRUST },
    [RelativeHandRole.PURE_BLUFF]: { tier: HandStrengthTier.WEAK, trust: AdviceTrust.DISTRUST },
    [RelativeHandRole.AIR]: { tier: HandStrengthTier.WEAK, trust: AdviceTrust.DISTRUST },
  });

/**
 * 已知角色的白名单（运行时校验用）。
 *
 * ## 为什么需要它（而不是直接靠类型）
 *
 * `PostflopDecisionSnapshot.handRole` 在快照里被**放宽成了 `string`**
 *（`decision.types.ts:467`），而它真正的来源是精确的
 * `RelativeHandRole`（`postflopAdvisor.ts:158`）。
 *
 * 两种做法：
 * ① 改引擎契约把快照字段收窄 —— 动的是**决策层类型**，风险外溢；
 * ② 在这一层**运行时校验** —— 不认识就返回 `null`（界面显示「—」），**不猜**。
 *
 * 选 ②：它把校验放在**唯一需要它的边界**上，且失败是**安全**的
 *（返回 null 而不是给一个错的信任等级）。这也是本项目「未知就 Fail Closed」的纪律。
 */
const KNOWN_ROLES: ReadonlySet<string> = new Set<string>(Object.values(RelativeHandRole));

const TIER_ZH: Readonly<Record<HandStrengthTier, string>> = Object.freeze({
  STRONG: '强牌',
  MEDIUM: '中等牌',
  WEAK: '弱牌 / 听牌',
});

const TRUST_ZH: Readonly<Record<AdviceTrust, string>> = Object.freeze({
  TRUST: '✅ 可以信 —— 这手牌靠**权益**赢，不靠对手弃牌',
  DISCOUNT: '⚠️ 打折看 —— 这手牌有一部分靠对手反应',
  DISTRUST: '❌ 最不可信 —— 这手牌基本靠**弃牌率**，而引擎把弃牌率算高了',
});

export type HandStrengthHint = {
  tier: HandStrengthTier;
  /** 中文牌力档，如「强牌」 */
  tierZh: string;
  /** 领域层的相对牌力角色中文，如「坚果级价值」 */
  roleZh: string;
  /** 角色强度（0..1，引擎自己算的） */
  strength: number;
  trust: AdviceTrust;
  /** 一句中文结论（直接显示在建议旁边） */
  trustZh: string;
  /** 一行完整提示，如「强牌（坚果级价值 0.92）｜✅ 可以信 …」 */
  lineZh: string;
};

/**
 * 由**领域层已有的**相对牌力角色推出「牌力档 + 信任等级」。
 *
 * 入参用 `string` 并做**运行时白名单校验** —— 因为快照层把它放宽成了 `string`
 *（见 `KNOWN_ROLES` 的说明）。不认识的值 ⇒ 返回 `null`（界面显示「—」），**不猜**。
 *
 * 翻前 / 引擎没给角色 ⇒ 同样返回 `null`。
 */
export function handStrengthHintOf(
  role: string | null | undefined,
  strength: number | null | undefined,
): HandStrengthHint | null {
  if (role === null || role === undefined) return null;
  if (!KNOWN_ROLES.has(role)) return null;
  const mapped = ROLE_TO_TIER[role];
  if (mapped === undefined) return null;
  const s = typeof strength === 'number' && Number.isFinite(strength) ? strength : 0;
  const tierZh = TIER_ZH[mapped.tier];
  /*
   * 🔴 角色中文取**领域层那一份**（`RELATIVE_ROLE_ZH`），不在这里复制。
   * 两份映射迟早会分歧，而分歧的表现是「界面显示的角色与引擎内部的角色不是同一个名字」——
   * 那正是本项目严禁的「同一条事实两处各算一次」。
   */
  const roleZh = RELATIVE_ROLE_ZH[role as RelativeHandRole];
  return Object.freeze({
    tier: mapped.tier,
    tierZh,
    roleZh,
    strength: s,
    trust: mapped.trust,
    trustZh: TRUST_ZH[mapped.trust],
    lineZh: `牌力档：**${tierZh}**（${roleZh}，强度 ${s.toFixed(2)}）｜${TRUST_ZH[mapped.trust]}`,
  });
}
