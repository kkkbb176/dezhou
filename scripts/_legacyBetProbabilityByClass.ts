/**
 * **修复前的下注权重模型快照**（RIVER BET RANGE V1）—— 仅供历史脚本对照使用。
 *
 * ⚠️ 它不是产品代码，也不被任何产品路径调用。
 *
 * `src/app/manualInput/bettingRange.ts` 在 **RIVER BET RANGE V2** 里把
 * `betProbabilityByClass`（按**相对 Hero 的类别**给概率）替换为
 * `betProbabilityByBand`（按**公共强度带**给概率）。上一轮的审计脚本
 * （`audit-river-betrange*.ts`）需要复现**旧行为**才能做前后对照，
 * 因此把那条公式逐字冻结在这里。
 *
 * | 项 | 旧实现 |
 * |---|---|
 * | 判据 | `versusHero`（读 Hero 隐藏底牌）⇒ 已确认是缺陷 |
 * | `showdown` | `clamp01(0.10 + 0.15a + 0.15b − 0.20p)` ⇒ 被动画像下**精确 0**（整类消失） |
 * | 尺寸 | `polarize(x, e) = clamp(0.5 + (x−0.5)·e, 0, 1)` |
 */
import type { ResponseTendencies } from '../src/domain/postflop/betResponse.ts';

export type LegacyClassProbabilities = Readonly<Record<string, number>>;

function polarize(x: number, exponent: number): number {
  const centered = x - 0.5;
  return Math.max(0, Math.min(1, 0.5 + centered * exponent));
}

/** 与 V1 的 `betProbabilityByClass` 逐字相同（含它的夹取行为） */
export function legacyBetProbabilityByClass(
  tendencies: ResponseTendencies,
  ratioToPot?: number,
): LegacyClassProbabilities {
  const dims = tendencies.effectiveDimensions;
  const c = (v: number | undefined): number => {
    const x = Number.isFinite(v) ? Math.max(0, Math.min(1, v as number)) : 0.5;
    return (x - 0.5) * 2;
  };
  const aggro = c(dims?.aggression);
  const bluff = c(dims?.bluffTendency);
  const passive = c(dims?.passivity);
  const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));

  const ANCHOR = 2 / 3;
  const ratio = Number.isFinite(ratioToPot) ? Math.max(0, ratioToPot as number) : ANCHOR;
  const valueExponent = 1 + 0.5 * (ratio - ANCHOR);
  const bluffExponent = 1 + 0.7 * (ratio - ANCHOR);

  const strong = clamp01(0.45 + 0.3 * aggro + 0.25 * bluff);
  const thin = clamp01(0.25 + 0.3 * aggro + 0.3 * bluff);
  const showdown = clamp01(0.1 + 0.15 * aggro + 0.15 * bluff - 0.2 * passive);
  const bluffRate = clamp01((dims?.bluffTendency ?? 0.5) * strong);

  return Object.freeze({
    NUT_VALUE: polarize(strong, valueExponent),
    STRONG_VALUE: polarize(strong, valueExponent),
    THIN_VALUE: polarize(thin, valueExponent),
    SHOWDOWN_VALUE: polarize(showdown, valueExponent),
    MISSED_FLUSH_DRAW: polarize(bluffRate, bluffExponent),
    MISSED_STRAIGHT_DRAW: polarize(bluffRate, bluffExponent),
    MISSED_COMBO_DRAW: polarize(bluffRate, bluffExponent),
    PURE_AIR: polarize(bluffRate, bluffExponent),
  });
}
