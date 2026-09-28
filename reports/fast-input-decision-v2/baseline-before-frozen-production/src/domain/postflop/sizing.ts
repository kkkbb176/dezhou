/**
 * **Bet Sizing 独立层**（2026-09 翻后升级 · P1）
 *
 * ## 使用者点名的纪律
 *
 * ```text
 * ✗ BET → 默认 50% 底池
 * ```
 *
 * 因此尺寸选择是**独立的一步**，输入是「为什么选这个尺寸」的量，
 * 而不是「动作已经选了 BET，所以给个默认比例」。
 *
 * ## 依赖（使用者给定）
 *
 * | 输入 | 方向 |
 * |---|---|
 * | 坚果优势（nut advantage） | 越大 ⇒ 越可用大尺寸（极化） |
 * | 范围优势（range advantage） | 越大 ⇒ 越可用中大尺寸 |
 * | 牌面纹理 | 越湿 ⇒ 越需要保护 ⇒ 中大尺寸 |
 * | 价值厚度（value thickness） | 越薄 ⇒ 尺寸越小（薄价值用小注） |
 * | 诈唬密度 | 越高 ⇒ 尺寸越两极化（大 or 小） |
 * | SPR | 越低 ⇒ 越接近直接全下 |
 * | 人数 | 越多 ⇒ 尺寸越小（多人池用小注控池 / 大注需要更强牌） |
 * | 对手弹性（elasticity） | 跟注站 ⇒ 放大；紧手 ⇒ 缩小 |
 */

import { multiwayAdjustment } from './multiway.ts';

/**
 * 合法尺寸网格 —— **必须与 `legalActions.buildSizeGrid` 的底池比例一致**。
 *
 * 🔴 审计抓到的问题（2026-09）：第一版这里写了 `[0.25, 1/3, 0.5, 2/3, 0.75, 1, 1.25, 1.5, 2]`，
 * 而下注网格实际只有 `[0.25, 1/3, 0.5, 2/3, 0.75, 1]`（超池下注不在网格里）。
 * 于是当目标比例 > 1 时，引擎的 `pickClosestAggressive` 找不到对应档，
 * **退化为「最大的合法下注」** —— 界面写着「100% 底池」而实际下的是别的量。
 * 现在两边同源：本网格只包含下注网格里真实存在的比例。
 */
export const SIZING_GRID: readonly number[] = Object.freeze([0.25, 1 / 3, 0.5, 2 / 3, 0.75, 1]);

export type SizingInput = {
  /** 坚果优势 0..1（我方范围里的坚果密度 − 对手的） */
  nutAdvantage: number;
  /** 范围优势 0..1 */
  rangeAdvantage: number;
  /** 牌面湿润度 0..1 */
  wetness: number;
  /** 价值厚度 0..1（越厚越能用大注取值） */
  valueThickness: number;
  /** 诈唬比例 0..1（我方这次下注里诈唬的占比） */
  bluffShare: number;
  spr: number | null;
  opponentCount: number;
  /** 对手弹性 0..1（跟注站 ≈ 1，紧手 ≈ 0.2） */
  elasticity: number;
  /** 承诺评估给出的尺寸上限（相对底池） */
  sizingCap: number;
  /** 画像带来的尺寸乘数（`exploit.ts`，1 = 不变） */
  exploitMultiplier: number;
  /** 价值或诈唬之外的第三个用途：保护 */
  protectionWeight: number;
};

export type SizingChoice = {
  /** 目标比例（相对底池） */
  targetRatio: number;
  /** 网格里最接近的合法比例 */
  gridRatio: number;
  reasonsZh: readonly string[];
};

/**
 * 选择**目标比例**（第二步：动作已定之后）。
 *
 * @returns 目标比例 + 理由（界面要显示「为什么是这个尺寸」）
 */
export function chooseSizing(input: SizingInput): SizingChoice {
  const reasons: string[] = [];

  /*
   * 基准 50%：这是「中间值」，不是默认答案 —— 下面每一行都会按因素移动它。
   */
  let ratio = 0.5;

  // 坚果优势 / 范围优势：极化与放大
  ratio += 0.5 * Math.max(0, Math.min(1, input.nutAdvantage));
  ratio += 0.35 * (Math.max(0, Math.min(1, input.rangeAdvantage)) - 0.5);
  if (input.nutAdvantage > 0.3) reasons.push(`坚果优势 ${input.nutAdvantage.toFixed(2)} ⇒ 可用更大尺寸（极化）`);

  // 价值厚度：越薄 ⇒ 越小
  ratio *= 0.7 + 0.6 * Math.max(0, Math.min(1, input.valueThickness));
  if (input.valueThickness < 0.4) reasons.push(`价值较薄（${input.valueThickness.toFixed(2)}）⇒ 收小尺寸`);

  // 牌面湿润：保护需求 ⇒ 放大（同时也降低被反超的代价）
  ratio += 0.25 * input.wetness * (1 - input.protectionWeight * 0.5);
  if (input.wetness > 0.55) reasons.push(`牌面偏湿（${input.wetness.toFixed(2)}）⇒ 需要保护，尺寸上调`);

  // 诈唬比例：两极化
  if (input.bluffShare > 0.5) {
    ratio += 0.3;
    reasons.push('本次下注以诈唬为主 ⇒ 走两极化大尺寸（或极小尺寸），不用中间尺寸');
  }

  // 人数：越多越小
  const multi = multiwayAdjustment(input.opponentCount);
  ratio *= 1 - 0.5 * multi.multiwayStrengthPenalty;
  if (multi.multiwayStrengthPenalty > 0) {
    reasons.push(`多人池（${input.opponentCount} 家）⇒ 尺寸收缩 ${(0.5 * multi.multiwayStrengthPenalty).toFixed(2)}`);
  }

  // 对手弹性：跟注站放大，紧手缩小
  ratio *= 0.85 + 0.3 * Math.max(0, Math.min(1, input.elasticity));
  if (input.elasticity > 0.7) reasons.push('对手偏黏（弹性高）⇒ 价值尺寸放大');
  if (input.elasticity < 0.35) reasons.push('对手偏紧（弹性低）⇒ 尺寸收缩，避免只被更强的牌跟注');

  // 画像乘数
  if (input.exploitMultiplier !== 1) {
    ratio *= input.exploitMultiplier;
    reasons.push(`画像修正：尺寸 ×${input.exploitMultiplier}`);
  }

  // SPR：低 SPR ⇒ 趋向承诺（全下）；高 SPR ⇒ 不超过承诺上限
  if (input.spr !== null) {
    if (input.spr <= 3) {
      /*
       * 🔴 **必须连续，不能是悬崖**（审计抓到的 MAJOR）。
       *
       * 第一版是 `ratio = Math.max(ratio, 1)`：`SPR 3.0` 的目标是 1.0（满池），
       * 而 `SPR 3.1` 落回 0.20 —— **3% 的筹码深度变化造成 4 倍尺寸跳变**。
       * 现在用连续函数：SPR 1 ⇒ 约 1.4；SPR 2 ⇒ 约 0.9；SPR 3 ⇒ 0.4；
       * SPR > 3.8 ⇒ 0（不施加任何强制）。
       */
      const jamPressure = Math.max(0, Math.min(1.4, 0.4 + 0.5 * (3 - input.spr)));
      if (jamPressure > 0) {
        ratio = Math.max(ratio, jamPressure);
        reasons.push(
          `SPR ${input.spr.toFixed(2)} 偏低 ⇒ 尺寸下限抬到 ${(jamPressure * 100).toFixed(0)}%（连续过渡，非悬崖）`,
        );
      }
    } else if (input.spr > 12) {
      ratio = Math.min(ratio, input.sizingCap);
      reasons.push(`SPR ${input.spr.toFixed(2)} 很深 ⇒ 用承诺上限 ${input.sizingCap} 收住`);
    }
  }

  /*
   * 🔴 有限数守卫（审计指出的未守卫入口）：任何一个入参是 NaN / Infinity
   * 都会让 `ratio` 变成 NaN，于是 `targetRatio` 输出 `NaN` —— 而 `gridRatio`
   * 因为「NaN 比较恒为 false」仍然落在网格上，界面会出现「尺寸 25%、
   * 目标 NaN」这种自相矛盾的组合。这里回落到中间尺寸并如实说明。
   */
  if (!Number.isFinite(ratio)) {
    ratio = 0.5;
    reasons.push('尺寸入参里出现了非有限数（NaN/Infinity）⇒ 回落到中间尺寸（这是数据异常，不是策略结论）');
  }
  ratio = Math.max(0.2, Math.min(2, ratio));
  const gridRatio = SIZING_GRID.reduce(
    (best, candidate) => (Math.abs(candidate - ratio) < Math.abs(best - ratio) ? candidate : best),
    SIZING_GRID[0]!,
  );
  if (Math.abs(gridRatio - ratio) > 0.01) {
    reasons.push(`目标 ${(ratio * 100).toFixed(0)}% 底池 ⇒ 取网格里最近的 ${(gridRatio * 100).toFixed(0)}%`);
  }
  /*
   * 🔴 界面必须**永远**能解释尺寸。没有任何显著因素时也要说明
   * 「没有明显因素 ⇒ 取中间尺寸」，而不是给一个空白理由（使用者点了名：
   * 不允许「BET → 默认 50%」这种无解释的绑定）。
   */
  if (reasons.length === 0) {
    reasons.push('没有明显的坚果优势/薄价值/多人/弹性因素 ⇒ 取中间尺寸（约半个底池）');
  }

  return { targetRatio: Number(ratio.toFixed(4)), gridRatio, reasonsZh: reasons };
}

/**
 * 对手弹性（0..1）：对手**越愿意用更差的牌跟注**，弹性越高。
 * 由范围压缩状态得出（强度下限越低、空气越多 ⇒ 越黏）。
 */
export function elasticityOf(state: {
  strengthFloor: number;
  airDensity: number;
  showdownDensity: number;
}): number {
  return Math.max(
    0,
    Math.min(
      1,
      (1 - state.strengthFloor) * 0.6 + state.airDensity * 0.2 + state.showdownDensity * 0.2,
    ),
  );
}
