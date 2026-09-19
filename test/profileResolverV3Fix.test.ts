/**
 * PLAYER PROFILE V3 RESOLVER 定向修复 —— 回归锁
 *
 * ## 这一轮修什么（TEST 12 已证实）
 *
 * ```text
 * 真跟注站（1500 手：VPIP 52 / PFR 9 / WTSD 43 / FoldRiver 14）
 *   修前 resolved：tightness 0.5377 / aggression 0.2277 / passivity 0.4700 / bluff 0.5000
 *   ⇒ 「比中性略紧、比中性略不被动」—— 与扑克语义完全冲突
 * ```
 *
 * 三个根因：
 * ① 所有 HUD 统计统一以 **0.5** 为中性点（`(rate − 0.5) × 2`）⇒ 松的方向几乎不可见、
 *    WTSD 43% 反而把 passivity 往下推；
 * ② 有实测时 resolved 维度**覆盖**标签维度（同一份实测 + CS/NIT 标签 ⇒ 逐位相同）；
 * ③ `bluffTendency` 没有任何观测通道 ⇒ 有实测时恒为 0.5，标签值被清掉。
 *
 * ## 本文件守什么
 *
 * - **TEST VECTOR A–J**：语义方向锁（不锁脆弱小数）
 * - **MURPHY 1–10**：对抗性边界锁（小样本劫持 / 大样本锁死 / 重复计票 /
 *   无证据轴被重置 / null 当 0 / Fold 串线 aggression / sticky 误判 bluffy / 四象限）
 * - **算术锁**：用公开参数表**独立重算** blend 公式，证明实现就是这个式子
 *
 * ⚠️ 旧测试（`playerProfileV3.test.ts`）一行未改：`resolved.dimensions` 语义
 * **保持不变**（只有实测说话、无实测时精确 0.5），新增
 * `observedOnlyDimensions` / `resolvedDimensions` / `baseDimensions` 三个显式字段。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolvePlayerProfile,
  STAT_EVIDENCE_SPECS,
  STAT_DIMENSION_POLARITY,
  STAT_TO_STREET_TRAIT,
  ALL_OBSERVED_STAT_KEYS,
  K_PROFILE_LABEL,
  type PlayerObservedStats,
} from '../src/domain/player/observedStats.ts';
import { ARCHETYPE_DIMENSIONS } from '../src/domain/player/archetypeDimensions.ts';
import type { QuickProfile } from '../src/app/manualInput/manualInput.ts';
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';

type Dims = { tightness: number; aggression: number; bluffTendency: number; passivity: number };
const AXES = ['tightness', 'aggression', 'bluffTendency', 'passivity'] as const;

type ResolvedShape = {
  dimensions: Dims;
  observedOnlyDimensions?: Dims;
  resolvedDimensions?: Dims;
  baseDimensions?: Dims;
  evidenceMass?: Record<string, number>;
  blendWeight?: Record<string, number>;
  street: Record<string, Record<string, number>>;
};
type TraceRow = {
  stat: string; observedRate: number | null; effectiveRate: number;
  confidence: number; opportunities: number;
};

/** 读解析结果；旧代码没有新字段 ⇒ 由 fused() 给出可诊断的失败 */
function R(base: QuickProfile | null, stats: PlayerObservedStats | null): {
  resolved: ResolvedShape; trace: readonly TraceRow[];
} {
  return resolvePlayerProfile({ baseArchetype: base as never, observedStats: stats }) as unknown as {
    resolved: ResolvedShape; trace: readonly TraceRow[];
  };
}
function fused(base: QuickProfile | null, stats: PlayerObservedStats | null): Dims {
  const { resolved } = R(base, stats);
  assert.ok(
    resolved.resolvedDimensions !== undefined,
    '修复后必须存在 resolved.resolvedDimensions（标签 prior 与实测融合的结果）',
  );
  return resolved.resolvedDimensions;
}
function observedOnly(base: QuickProfile | null, stats: PlayerObservedStats | null): Dims {
  const { resolved } = R(base, stats);
  assert.ok(
    resolved.observedOnlyDimensions !== undefined,
    '修复后必须存在 resolved.observedOnlyDimensions（只有实测说话的中间量）',
  );
  return resolved.observedOnlyDimensions;
}

const S = (o: Partial<PlayerObservedStats> & { handsObserved: number }): PlayerObservedStats =>
  o as PlayerObservedStats;

/* ---------------- 固定向量 ---------------- */

const TRUE_CS = S({
  handsObserved: 1500,
  vpip: 0.52, pfr: 0.09, threeBet: 0.03, wtsd: 0.43,
  foldToFlopCBet: 0.20, foldToTurnCBet: 0.18, foldToRiverBet: 0.14,
  flopCheckRaise: 0.04, turnCheckRaise: 0.03, riverCheckRaise: 0.02,
});
const TIGHT_WEAK = S({
  handsObserved: 1500,
  vpip: 0.18, pfr: 0.12, threeBet: 0.04, wtsd: 0.20,
  foldToFlopCBet: 0.52, foldToTurnCBet: 0.61, foldToRiverBet: 0.68,
  flopCheckRaise: 0.03, turnCheckRaise: 0.02, riverCheckRaise: 0.01,
});
const NIT_3000 = S({
  handsObserved: 3000,
  vpip: 0.17, pfr: 0.10, threeBet: 0.03, wtsd: 0.18,
  foldToFlopCBet: 0.55, foldToTurnCBet: 0.62, foldToRiverBet: 0.70,
});
const LAG = S({
  handsObserved: 1500,
  vpip: 0.45, pfr: 0.35, threeBet: 0.15, wtsd: 0.28,
  foldToFlopCBet: 0.40, foldToTurnCBet: 0.40, foldToRiverBet: 0.40,
  flopCheckRaise: 0.14, turnCheckRaise: 0.12, riverCheckRaise: 0.10,
});
const TAG = S({
  handsObserved: 1500,
  vpip: 0.22, pfr: 0.19, threeBet: 0.09, wtsd: 0.27,
  foldToFlopCBet: 0.46, foldToTurnCBet: 0.46, foldToRiverBet: 0.46,
});
const STICKY = S({
  handsObserved: 1500,
  vpip: 0.50, pfr: 0.08, threeBet: 0.03, wtsd: 0.45,
  foldToFlopCBet: 0.18, foldToTurnCBet: 0.16, foldToRiverBet: 0.12,
  flopCheckRaise: 0.03, turnCheckRaise: 0.02, riverCheckRaise: 0.01,
});

const LOOSE_PASSIVE = S({ handsObserved: 1500, vpip: 0.45, pfr: 0.09, threeBet: 0.03, wtsd: 0.40 });
const LOOSE_AGGRESSIVE = S({ handsObserved: 1500, vpip: 0.45, pfr: 0.35, threeBet: 0.15, wtsd: 0.28 });
const TIGHT_PASSIVE = S({ handsObserved: 1500, vpip: 0.18, pfr: 0.08, threeBet: 0.03, wtsd: 0.35 });
const TIGHT_AGGRESSIVE = S({ handsObserved: 1500, vpip: 0.18, pfr: 0.28, threeBet: 0.14, wtsd: 0.24 });

/* ============================================================
 * TEST VECTOR A —— True Calling Station
 * ============================================================ */

test('VECTOR A：真跟注站（1500 手）⇒ loose + passive + sticky，且 bluff 保留标签先验', () => {
  const d = fused('CALLING_STATION', TRUE_CS);
  assert.ok(d.tightness < 0.5, `真跟注站 tightness 必须 < 0.5，实际 ${d.tightness}`);
  assert.ok(d.aggression < 0.5, `真跟注站 aggression 必须 < 0.5，实际 ${d.aggression}`);
  assert.ok(d.passivity > 0.5, `真跟注站 passivity 必须 > 0.5（黏），实际 ${d.passivity}`);
  assert.equal(d.bluffTendency, ARCHETYPE_DIMENSIONS.CALLING_STATION!.bluffTendency,
    'bluffTendency 没有观测通道 ⇒ 必须逐位等于标签先验');
});

test('VECTOR A2：真跟注站必须比紧弱玩家更松、更被动（两个向量必须分开）', () => {
  const cs = fused('CALLING_STATION', TRUE_CS);
  const tw = fused('CALLING_STATION', TIGHT_WEAK);
  assert.ok(cs.tightness < tw.tightness,
    `真跟注站必须比紧弱更松：${cs.tightness} < ${tw.tightness}`);
  assert.ok(cs.passivity > tw.passivity,
    `真跟注站必须比紧弱更被动：${cs.passivity} > ${tw.passivity}`);
});

/* ============================================================
 * TEST VECTOR B —— Weak Tight（标签被贴错）
 * ============================================================ */

test('VECTOR B：紧弱实测 + CS 标签 ⇒ tightness > 0.5 且 passivity > 0.5（紧 != 不被动）', () => {
  const d = fused('CALLING_STATION', TIGHT_WEAK);
  assert.ok(d.tightness > 0.5, `紧弱 tightness 必须 > 0.5，实际 ${d.tightness}`);
  assert.ok(d.passivity > 0.5,
    `紧弱玩家仍然被动（Fold 多 != 凶）⇒ passivity > 0.5，实际 ${d.passivity}`);
  assert.ok(d.aggression < 0.5, `紧弱 aggression 必须 < 0.5，实际 ${d.aggression}`);
});

test('VECTOR B2：Fold 类统计不得推高 aggression（语义不得串线）', () => {
  const low = fused('CALLING_STATION', S({
    handsObserved: 2000, foldToFlopCBet: 0.05, foldToTurnCBet: 0.05, foldToRiverBet: 0.05,
  }));
  const high = fused('CALLING_STATION', S({
    handsObserved: 2000, foldToFlopCBet: 0.95, foldToTurnCBet: 0.95, foldToRiverBet: 0.95,
  }));
  assert.equal(low.aggression, high.aggression,
    '弃牌率从 5% 拉到 95% 不得改变 aggression（一条统计只走一个通道）');
  assert.equal(low.tightness, high.tightness, '弃牌率不得改变 tightness（同上）');
});

/* ============================================================
 * TEST VECTOR C —— 标签 prior 必须存在（大样本下仍不消失）
 * ============================================================ */

test('VECTOR C：同一份 1500 手实测，CS 与 NIT 标签必须接近但不相同', () => {
  const cs = fused('CALLING_STATION', TIGHT_WEAK);
  const nit = fused('VERY_TIGHT', TIGHT_WEAK);
  const d1500 = Math.abs(cs.tightness - nit.tightness);
  const cs50 = fused('CALLING_STATION', S({ ...TIGHT_WEAK, handsObserved: 50 }));
  const nit50 = fused('VERY_TIGHT', S({ ...TIGHT_WEAK, handsObserved: 50 }));
  const d50 = Math.abs(cs50.tightness - nit50.tightness);

  assert.ok(d1500 > 0, '大样本也不得让标签完全消失（distance > 0）');
  assert.ok(d1500 < d50, `大样本的标签差异必须小于小样本：${d1500} < ${d50}`);
});

/* ============================================================
 * TEST VECTOR D —— 0 手必须等于 base
 * ============================================================ */

test('VECTOR D：0 手 ⇒ resolvedDimensions 必须逐位等于 baseDimensions', () => {
  for (const base of ['CALLING_STATION', 'VERY_TIGHT', 'MANIAC', 'NORMAL'] as const) {
    const d = fused(base, null);
    const spec = ARCHETYPE_DIMENSIONS[base]!;
    for (const axis of AXES) {
      assert.equal(d[axis], spec[axis], `0 手时 ${base}.${axis} 必须逐位等于标签维度`);
    }
  }
});

test('VECTOR D2：0 手时 observedOnlyDimensions 才是 0.5（两个字段语义必须分清）', () => {
  const p = R('CALLING_STATION', null);
  for (const axis of AXES) {
    assert.equal(p.resolved.observedOnlyDimensions![axis], 0.5,
      `${axis}：observed-only 在无证据时是中立 0.5`);
    assert.equal(p.resolved.dimensions[axis], 0.5,
      `${axis}：既有字段 resolved.dimensions 语义不变（旧测试 P1b 锁定）`);
    assert.equal(p.resolved.resolvedDimensions![axis], ARCHETYPE_DIMENSIONS.CALLING_STATION![axis],
      `${axis}：resolvedDimensions 必须落到标签先验`);
  }
});

/* ============================================================
 * TEST VECTOR E —— 小样本不得劫持标签
 * ============================================================ */

test('VECTOR E：15 手极端统计不得把 NIT 变成 Calling Station', () => {
  const base = ARCHETYPE_DIMENSIONS.VERY_TIGHT!;
  const d = fused('VERY_TIGHT', S({ handsObserved: 15, vpip: 0.70, pfr: 0.05, wtsd: 0.60 }));
  assert.ok(Math.abs(d.tightness - base.tightness) < 0.12,
    `15 手必须仍靠近 NIT 标签：${d.tightness} vs base ${base.tightness}`);
  assert.ok(d.tightness > 0.7, `15 手不得翻转成松：tightness ${d.tightness}`);
  assert.ok(d.passivity > 0.3, `15 手不得把 NIT 的被动性打乱：passivity ${d.passivity}`);
});

/* ============================================================
 * TEST VECTOR F —— 大样本必须能纠错
 * ============================================================ */

test('VECTOR F：3000 手紧弱实测必须纠正 CS 标签，且距实测更近', () => {
  const f = fused('CALLING_STATION', NIT_3000);
  const o = observedOnly('CALLING_STATION', NIT_3000);
  const base = ARCHETYPE_DIMENSIONS.CALLING_STATION!;
  assert.ok(f.tightness > 0.5, `3000 手紧弱 ⇒ tightness 必须明显过 0.5，实际 ${f.tightness}`);
  assert.ok(
    Math.abs(f.tightness - o.tightness) < Math.abs(f.tightness - base.tightness),
    `大样本必须更靠近实测：|${f.tightness}-${o.tightness}| < |${f.tightness}-${base.tightness}|`,
  );
});

/* ============================================================
 * TEST VECTOR G —— Sticky != Bluffy
 * ============================================================ */

test('VECTOR G：黏（低 Fold / 高 WTSD）不得被当成爱诈唬', () => {
  const d = fused('CALLING_STATION', STICKY);
  assert.ok(d.tightness < 0.5, `VPIP 50% ⇒ loose，实际 tightness ${d.tightness}`);
  assert.ok(d.passivity > 0.5, `WTSD 45% ⇒ sticky，实际 passivity ${d.passivity}`);
  assert.equal(d.bluffTendency, ARCHETYPE_DIMENSIONS.CALLING_STATION!.bluffTendency,
    'bluffTendency 不得因低 Fold 自动升高（没有主动下注证据）');
});

/* ============================================================
 * TEST VECTOR H / I / J —— 四象限与轴独立性
 * ============================================================ */

test('VECTOR H：Loose Aggressive 不得被修成 passive', () => {
  const d = fused('NORMAL', LAG);
  assert.ok(d.tightness < 0.5, `LAG 必须偏松，实际 ${d.tightness}`);
  assert.ok(d.aggression > 0.5, `LAG 必须偏凶，实际 ${d.aggression}`);
});

test('VECTOR I：Tight Aggressive 的两轴不得互为反数（tight 但仍凶）', () => {
  const tagD = fused('NORMAL', TAG);
  const looseD = fused('NORMAL', LOOSE_PASSIVE);
  const passiveD = fused('NORMAL', TIGHT_PASSIVE);
  assert.ok(tagD.tightness > looseD.tightness,
    `TAG 必须比松玩家更紧：${tagD.tightness} > ${looseD.tightness}`);
  assert.ok(tagD.aggression > passiveD.aggression,
    `TAG 必须比被动玩家更凶：${tagD.aggression} > ${passiveD.aggression}`);
  assert.ok(tagD.tightness > 0.5 && tagD.aggression > 0.5,
    `TAG 必须落在 紧 x 凶 象限：${tagD.tightness} / ${tagD.aggression}`);
});

test('VECTOR J：四个象限必须都能表达（不得 tight→passive / loose→aggressive 绑定）', () => {
  const lp = fused('NORMAL', LOOSE_PASSIVE);
  const la = fused('NORMAL', LOOSE_AGGRESSIVE);
  const tp = fused('NORMAL', TIGHT_PASSIVE);
  const ta = fused('NORMAL', TIGHT_AGGRESSIVE);
  assert.ok(lp.tightness < 0.5 && la.tightness < 0.5, '两种松玩家都必须 tightness < 0.5');
  assert.ok(tp.tightness > 0.5 && ta.tightness > 0.5, '两种紧玩家都必须 tightness > 0.5');
  assert.ok(la.aggression > lp.aggression + 0.2,
    `松的两种必须能区分凶/被动：${la.aggression} vs ${lp.aggression}`);
  assert.ok(ta.aggression > tp.aggression + 0.2,
    `紧的两种必须能区分凶/被动：${ta.aggression} vs ${tp.aggression}`);
  assert.ok(la.aggression > 0.5 && lp.aggression < 0.5, '松凶 vs 松被动必须在 0.5 两侧');
  assert.ok(ta.aggression > 0.5 && tp.aggression < 0.5, '紧凶 vs 紧被动必须在 0.5 两侧');
});

/* ============================================================
 * MURPHY 1 —— 边界值
 * ============================================================ */

test('MURPHY 1：0 / 0.01 / anchor / 0.99 / 1 全统计 ⇒ 无 NaN、无 Infinity、维度 ∈ [0,1]', () => {
  for (const key of ALL_OBSERVED_STAT_KEYS) {
    const anchor = STAT_EVIDENCE_SPECS[key].neutralAnchor;
    for (const value of [0, 0.01, anchor, 0.99, 1]) {
      const stats = S({ handsObserved: 2000, [key]: value } as never);
      const p = R('CALLING_STATION', stats);
      for (const axis of AXES) {
        const v = p.resolved.resolvedDimensions![axis];
        assert.ok(Number.isFinite(v), `${key}=${value} 的 ${axis} 必须是有限数（实际 ${v}）`);
        assert.ok(v >= 0 && v <= 1, `${key}=${value} 的 ${axis} 必须 ∈ [0,1]（实际 ${v}）`);
      }
      const streets = (p.resolved as unknown as {
        street: Record<string, Record<string, number>>;
      }).street;
      for (const street of ['PREFLOP', 'FLOP', 'TURN', 'RIVER'] as const) {
        for (const k of ['foldScale', 'callScale', 'checkRaiseScale', 'betScale'] as const) {
          const fv = streets[street]![k]!;
          assert.ok(Number.isFinite(fv) && fv > 0,
            `${key}=${value} 的 ${street}.${k} 必须是正有限数（实际 ${fv}）`);
        }
      }
    }
  }
});

/* ============================================================
 * MURPHY 2 / 3 —— null 不得当 0；部分统计只更新有证据的轴
 * ============================================================ */

test('MURPHY 2：null / undefined / 缺失 一律不得被当成 0', () => {
  const none = fused('CALLING_STATION', S({ handsObserved: 2000 }));
  for (const key of ALL_OBSERVED_STAT_KEYS) {
    const withNull = fused('CALLING_STATION', S({ handsObserved: 2000, [key]: null } as never));
    const withUndef = fused('CALLING_STATION', S({ handsObserved: 2000, [key]: undefined } as never));
    for (const axis of AXES) {
      assert.equal(withNull[axis], none[axis], `${key}=null 不得改变 ${axis}`);
      assert.equal(withUndef[axis], none[axis], `${key}=undefined 不得改变 ${axis}`);
    }
    const probeAxis = STAT_DIMENSION_POLARITY[key].tightness !== 0 ? 'tightness' : 'passivity';
    if (STAT_DIMENSION_POLARITY[key][probeAxis] !== 0) {
      const zero = fused('CALLING_STATION', S({ handsObserved: 2000, [key]: 0 } as never));
      assert.notEqual(zero[probeAxis], none[probeAxis],
        `${key}=0 必须与「缺失」产生不同结果（${probeAxis}）`);
    }
  }
});

test('MURPHY 3：只有 VPIP/PFR ⇒ 只有 tightness/aggression 被更新，其余轴逐位等于 base', () => {
  const base = ARCHETYPE_DIMENSIONS.CALLING_STATION!;
  const d = fused('CALLING_STATION', S({ handsObserved: 1500, vpip: 0.45, pfr: 0.30 }));
  assert.ok(d.tightness < base.tightness,
    `有 VPIP 证据 ⇒ tightness 必须被推动（${d.tightness} < ${base.tightness}）`);
  assert.ok(d.aggression > base.aggression,
    `有 PFR 证据 ⇒ aggression 必须被推动（${d.aggression} > ${base.aggression}）`);
  assert.equal(d.passivity, base.passivity, 'passivity 无证据 ⇒ 必须逐位等于 base');
  assert.equal(d.bluffTendency, base.bluffTendency, 'bluffTendency 无证据 ⇒ 必须逐位等于 base');
});

/* ============================================================
 * MURPHY 4 —— 无证据的轴不得被重置成 0.5
 * ============================================================ */

test('MURPHY 4：bluffTendency 无合法观测源 ⇒ 四种标签下都必须保留 base', () => {
  for (const base of ['CALLING_STATION', 'VERY_TIGHT', 'MANIAC', 'NORMAL'] as const) {
    const spec = ARCHETYPE_DIMENSIONS[base]!;
    for (const stats of [null, TRUE_CS, TIGHT_WEAK, LAG]) {
      const d = fused(base, stats);
      assert.equal(d.bluffTendency, spec.bluffTendency,
        `${base} + ${stats === null ? '无统计' : '有统计'} ⇒ bluff 必须 = ${spec.bluffTendency}`);
    }
  }
});

/* ============================================================
 * MURPHY 5 / 6 —— 错误标签被纠正 / 正确标签被强化
 * ============================================================ */

test('MURPHY 5：MANIAC 标签 + 3000 手紧弱实测 ⇒ 标签必须被纠正', () => {
  const base = ARCHETYPE_DIMENSIONS.MANIAC!;
  const d = fused('MANIAC', NIT_3000);
  assert.ok(d.tightness > 0.5,
    `MANIAC(0.15) + 3000 手紧弱 ⇒ tightness 必须过 0.5，实际 ${d.tightness}`);
  assert.ok(d.aggression < base.aggression - 0.3,
    `aggression 必须被实测拉下来：${d.aggression} vs ${base.aggression}`);
});

test('MURPHY 6：正确标签 + 支持它的实测 ⇒ 不得被拉向中立', () => {
  const base = ARCHETYPE_DIMENSIONS.CALLING_STATION!;
  const d = fused('CALLING_STATION', TRUE_CS);
  assert.ok(d.tightness < 0.4,
    `CS 标签 + 跟注站实测 ⇒ tightness 必须仍在松侧（不是 0.5），实际 ${d.tightness}`);
  assert.ok(d.passivity > 0.6,
    `CS 标签 + 黏实测 ⇒ passivity 必须仍在被动侧，实际 ${d.passivity}`);
  assert.ok(d.passivity > base.passivity - 0.1,
    `不得把 passivity 拉离标签太远：${d.passivity} vs ${base.passivity}`);
});

/* ============================================================
 * MURPHY 7 —— 证据饱和
 * ============================================================ */

test('MURPHY 7：样本量增加时移动单调、增量递减、且有界', () => {
  const at = (n: number): number =>
    fused('CALLING_STATION', S({ handsObserved: n, vpip: 0.18 })).tightness;
  const seq = [100, 500, 1500, 5000].map(at);
  for (let i = 1; i < seq.length; i += 1) {
    assert.ok(seq[i]! > seq[i - 1]!, `tightness 必须随样本单调上升：${seq[i - 1]} → ${seq[i]}`);
  }
  const d1 = seq[1]! - seq[0]!;
  const d2 = seq[2]! - seq[1]!;
  const d3 = seq[3]! - seq[2]!;
  assert.ok(d2 < d1 && d3 < d2, `增量必须递减（饱和）：${d1} / ${d2} / ${d3}`);
  assert.ok(seq[3]! < 0.9, `5000 手也不得无限逼近极端：${seq[3]}`);
  assert.ok(seq[3]! > seq[2]!, '1500 → 5000 必须仍有证据差异（未提前撞 cap）');
});

/* ============================================================
 * MURPHY 8 —— 机会数不得等于手数
 * ============================================================ */

test('MURPHY 8：低频统计的机会数不得等于手数；真实 opportunities 优先', () => {
  const approximated = R('CALLING_STATION', S({ handsObserved: 10000, foldToRiverBet: 0.2 }));
  const row = approximated.trace.find((x) => x.stat === 'foldToRiverBet')!;
  assert.notEqual(row.opportunities, 10000,
    'FoldToRiverBet 每 10 手才有 1 次机会 ⇒ 机会数不得等于手数');
  assert.equal(row.opportunities,
    Math.round(10000 * STAT_EVIDENCE_SPECS.foldToRiverBet.opportunityRate),
    '近似的机会数必须 = 手数 x 频率');

  const approximatedVpip = R('CALLING_STATION', S({ handsObserved: 10000, vpip: 0.30 }));
  const realRow = resolvePlayerProfile({
    baseArchetype: 'CALLING_STATION' as never,
    observedStats: S({ handsObserved: 10000, vpip: 0.30 }),
    opportunities: { vpip: 12345 },
  }).trace.find((x) => x.stat === 'vpip')!;
  assert.equal(realRow.opportunities, 12345, '给了真实机会数就必须优先使用');
  assert.notEqual(realRow.opportunities,
    approximatedVpip.trace.find((x) => x.stat === 'vpip')!.opportunities,
    '真实机会数与近似值必须能区分');
});

/* ============================================================
 * MURPHY 9 —— 重复计票审计
 * ============================================================ */

test('MURPHY 9：每条统计只走一个通道（global 维度 XOR 分街直接系数）', () => {
  for (const key of ALL_OBSERVED_STAT_KEYS) {
    const hasDimension = AXES.some((a) => STAT_DIMENSION_POLARITY[key][a] !== 0);
    const hasStreet = STAT_TO_STREET_TRAIT[key] !== undefined;
    assert.ok(
      !(hasDimension && hasStreet),
      `「${key}」不得同时进入 global 维度与分街直接系数（重复计票）`,
    );
  }
});

test('MURPHY 9b：FoldToRiverBet 从 5% 拉到 95% ⇒ 四个维度逐位不变', () => {
  const low = fused('CALLING_STATION', S({ handsObserved: 2000, foldToRiverBet: 0.05 }));
  const high = fused('CALLING_STATION', S({ handsObserved: 2000, foldToRiverBet: 0.95 }));
  for (const axis of AXES) {
    assert.equal(low[axis], high[axis], `${axis} 不得受 FoldToRiverBet 影响`);
  }
});

/* ============================================================
 * MURPHY 10 —— 标签矛盾的过渡（50 / 500 / 1500 手）
 * ============================================================ */

test('MURPHY 10：50 手 base 主导 → 500 手中间 → 1500 手实测主导', () => {
  const base = ARCHETYPE_DIMENSIONS.CALLING_STATION!;
  const at = (n: number): { d: Dims; w: number } => {
    const p = R('CALLING_STATION', S({ ...TIGHT_WEAK, handsObserved: n }));
    return { d: p.resolved.resolvedDimensions!, w: p.resolved.blendWeight!.tightness! };
  };
  const a = at(50), b = at(500), c = at(1500);
  assert.ok(a.w < 0.25, `50 手时标签权重必须占主导，实际 w=${a.w}`);
  assert.ok(b.w > 0.35 && b.w < 0.7, `500 手时必须是中间态，实际 w=${b.w}`);
  assert.ok(c.w > 0.7, `1500 手时实测必须占主导，实际 w=${c.w}`);
  assert.ok(a.w < b.w && b.w < c.w, '标签权重必须随样本单调下降');
  assert.ok(a.d.tightness < b.d.tightness && b.d.tightness < c.d.tightness,
    `tightness 必须单调向紧侧移动：${a.d.tightness} / ${b.d.tightness} / ${c.d.tightness}`);
  assert.ok(a.d.tightness < base.tightness + 0.05, '50 手时结果必须仍贴近标签（0.30 附近）');
});

/* ============================================================
 * 算术锁 —— 用公开参数表独立重算 blend 公式
 * ============================================================ */

test('算术锁：resolvedDimensions 必须等于公式手算值（1e-12）', () => {
  const p = R('CALLING_STATION', TRUE_CS);
  const base = ARCHETYPE_DIMENSIONS.CALLING_STATION!;
  const clampPm1 = (v: number): number => Math.max(-1, Math.min(1, v));

  const vpipRow = p.trace.find((x) => x.stat === 'vpip')!;
  const threeBetRow = p.trace.find((x) => x.stat === 'threeBet')!;
  const devVpip = clampPm1(
    (0.52 - STAT_EVIDENCE_SPECS.vpip.neutralAnchor) / STAT_EVIDENCE_SPECS.vpip.scale);
  const dev3Bet = clampPm1(
    (0.03 - STAT_EVIDENCE_SPECS.threeBet.neutralAnchor) / STAT_EVIDENCE_SPECS.threeBet.scale);
  const pVpip = STAT_DIMENSION_POLARITY.vpip.tightness;
  const p3Bet = STAT_DIMENSION_POLARITY.threeBet.tightness;

  const num = pVpip * devVpip * vpipRow.confidence + p3Bet * dev3Bet * threeBetRow.confidence;
  const den = Math.abs(pVpip) * vpipRow.confidence + Math.abs(p3Bet) * threeBetRow.confidence;
  const observedTightness = 0.5 + (num / (1 + den)) / 2;
  const mass = Math.abs(pVpip) * vpipRow.opportunities + Math.abs(p3Bet) * threeBetRow.opportunities;
  const w = mass / (mass + K_PROFILE_LABEL);
  const expected = (1 - w) * base.tightness + w * observedTightness;

  assert.ok(Math.abs(p.resolved.observedOnlyDimensions!.tightness - observedTightness) < 1e-12,
    `observed-only tightness 必须等于手算值：${p.resolved.observedOnlyDimensions!.tightness} vs ${observedTightness}`);
  assert.ok(Math.abs(p.resolved.blendWeight!.tightness! - w) < 1e-12,
    `blendWeight 必须等于 mass/(mass+K)：${p.resolved.blendWeight!.tightness} vs ${w}`);
  assert.ok(Math.abs(p.resolved.resolvedDimensions!.tightness - expected) < 1e-12,
    `resolved tightness 必须等于 (1-w)*base + w*observed：${p.resolved.resolvedDimensions!.tightness} vs ${expected}`);
  assert.ok(Math.abs(p.resolved.evidenceMass!.tightness! - mass) < 1e-12,
    'evidenceMass 必须等于 Σ|极性| x 机会数');
});

/* ============================================================
 * UNIFIED RESOLVED PROFILE —— 双画像源统一（先红后绿）
 * ============================================================ */

const MANIAC_AT = (n: number): PlayerObservedStats => S({
  handsObserved: n,
  vpip: 0.60, pfr: 0.45, threeBet: 0.18, wtsd: 0.35,
  foldToFlopCBet: 0.22, foldToTurnCBet: 0.20, foldToRiverBet: 0.18,
  flopCheckRaise: 0.18, turnCheckRaise: 0.15, riverCheckRaise: 0.12,
});

/** `calibratedBetScaleOf` 的 shape 部分（0.5 中立、±1 刻度） */
const shapeOf = (d: { aggression: number; bluffTendency: number; passivity: number }): number => {
  const c = (v: number): number => (Math.max(0, Math.min(1, v)) - 0.5) * 2;
  return 1 + 0.3 * c(d.aggression) + 0.25 * c(d.bluffTendency) - 0.3 * c(d.passivity);
};
const labelShape = (base: 'CALLING_STATION' | 'VERY_TIGHT' | 'MANIAC' | 'NORMAL'): number =>
  shapeOf(ARCHETYPE_DIMENSIONS[base]!);

test('UNIFIED-1：betScale 的输入必须是**融合后的** resolved 维度（不是 observed-only）', () => {
  const p = R('VERY_TIGHT', MANIAC_AT(20));
  const betScale = p.resolved.street['RIVER']!['betScale']!;
  const fromResolved = shapeOf(p.resolved.resolvedDimensions!);
  // 旧实现：shape(observed-only) + [shape(标签) − 1]（标签校准项）
  const legacy = shapeOf(p.resolved.observedOnlyDimensions!) + (labelShape('VERY_TIGHT') - 1);

  assert.ok(Math.abs(fromResolved - legacy) > 1e-6,
    `本测试必须有区分力：两种来源必须给出不同值（resolved ${fromResolved} vs legacy ${legacy}）`);
  assert.ok(Math.abs(betScale - fromResolved) < 1e-12,
    `betScale(${betScale}) 必须等于 shape(resolved dimensions)=${fromResolved}；` +
    `若等于 shape(observed-only)+标签校准=${legacy} 则说明**双画像源未统一**`);
});

test('UNIFIED-2：无统计时 betScale 必须逐位等于 shape(标签维度)（标签**只计一次**）', () => {
  for (const base of ['CALLING_STATION', 'VERY_TIGHT', 'MANIAC', 'NORMAL'] as const) {
    const p = R(base, null);
    assert.equal(p.resolved.street['RIVER']!['betScale'], labelShape(base),
      `${base}：无统计时 betScale 必须逐位 = shape(标签)。` +
      `若得到 2×shape−1，说明标签被重复计票`);
  }
});

test('UNIFIED-3：betScale 必须随样本从「标签主导」转向「实测主导」（20 手不得劫持 NIT）', () => {
  const at = (n: number): number => R('VERY_TIGHT', MANIAC_AT(n)).resolved.street['RIVER']!['betScale']!;
  const b20 = at(20), b1500 = at(1500);
  const labelShapeNit = labelShape('VERY_TIGHT');

  // ① 20 手：必须仍由 NIT 标签主导
  assert.ok(Math.abs(b20 - labelShapeNit) < 0.02,
    `20 手必须仍由 NIT 标签主导：betScale ${b20} vs shape(NIT)=${labelShapeNit}`);
  // ② 证据增加必须把开火倾向推离标签（MANIAC 实测 ⇒ 应上升）
  assert.ok(b1500 > b20 + 0.05,
    `1500 手必须明显偏离标签：${b1500} vs ${b20}`);
  // ③ ⚠️ 但**不能**要求它等于 observed-only 的 shape：按 P0-C，bluffTendency
  //    没有观测通道 ⇒ 永远停留在 base 的 −0.175 项。这是设计要求，不是缺陷。
  const bluffBase = ARCHETYPE_DIMENSIONS.VERY_TIGHT!.bluffTendency;
  assert.equal(R('VERY_TIGHT', MANIAC_AT(1500)).resolved.resolvedDimensions!.bluffTendency, bluffBase,
    'bluffTendency 必须仍等于 NIT 标签（无观测通道）');
  // ④ 有证据的轴必须由实测主导（这才是「大样本能被纠正」的判据）
  const p1500 = R('VERY_TIGHT', MANIAC_AT(1500)).resolved;
  assert.ok(
    Math.abs(p1500.resolvedDimensions!.aggression - p1500.observedOnlyDimensions!.aggression) <
    Math.abs(p1500.resolvedDimensions!.aggression - ARCHETYPE_DIMENSIONS.VERY_TIGHT!.aggression),
    '1500 手时 aggression 必须更靠近实测而不是标签',
  );
});

test('UNIFIED-4：响应模型与主动下注模型必须报出**同一套**全局维度', () => {
  for (const [base, stats] of [
    ['VERY_TIGHT', MANIAC_AT(20)], ['VERY_TIGHT', MANIAC_AT(1500)],
    ['MANIAC', NIT_3000], ['CALLING_STATION', TRUE_CS],
  ] as const) {
    const p = R(base, stats);
    const r = p.resolved.resolvedDimensions!;
    // betScale 只能由这一套维度决定（同输入同输出 ⇒ 用同一函数复算必须逐位相同）
    assert.equal(p.resolved.street['RIVER']!['betScale'], shapeOf(r),
      `${base}：betScale 必须完全由 resolved 维度决定`);
    for (const axis of AXES) {
      assert.ok(Number.isFinite(r[axis]), `${base}.${axis} 必须有限`);
    }
  }
});

test('结构锁：每个统计都必须有显式 neutralAnchor 与 scale，且锚点不得统一为 0.5', () => {
  const anchors = new Set<number>();
  for (const key of ALL_OBSERVED_STAT_KEYS) {
    const spec = STAT_EVIDENCE_SPECS[key];
    assert.ok(Number.isFinite(spec.neutralAnchor), `${key} 必须有 neutralAnchor`);
    assert.ok(Number.isFinite(spec.scale) && spec.scale > 0, `${key} 必须有正 scale`);
    assert.notEqual(spec.neutralAnchor, 0.5, `${key} 的锚点不得是统一的 0.5`);
    anchors.add(spec.neutralAnchor);
  }
  assert.ok(anchors.size >= 5, `锚点必须逐统计设置（至少 5 个不同值），实际 ${anchors.size}`);
  assert.ok(K_PROFILE_LABEL > 0, 'K_PROFILE_LABEL 必须是正数');
});

/* ============================================================
 * MURPHY 11 / 12 —— 对抗性：重复计票的数学不变量与 K 的语义锚点
 * ============================================================ */

test('MURPHY 11：resolved 必须是 base 与 observed-only 的**凸组合**（证明标签只进一次）', () => {
  /*
   * 这是本轮最重要的**结构性**断言：
   *
   * ```text
   * base ≤ resolved ≤ observedOnly   （或反向）
   * ```
   *
   * 只要有任何**第三条**标签通路偷偷进入维度链（例如分街先验又被算进维度、
   * 或 `effectiveRate` 被拿来当推力），resolved 就会跳出这个区间 ——
   * 那时它既不是「标签」也不是「实测」，而是两者的混合物 + 额外偏置。
   */
  for (const base of ['CALLING_STATION', 'VERY_TIGHT', 'MANIAC', 'NORMAL'] as const) {
    for (const [name, stats] of [
      ['TRUE_CS', TRUE_CS], ['TIGHT_WEAK', TIGHT_WEAK], ['LAG', LAG], ['NIT_3000', NIT_3000],
    ] as const) {
      const p = R(base, stats);
      const o = p.resolved.observedOnlyDimensions!;
      const b = p.resolved.baseDimensions!;
      const r = p.resolved.resolvedDimensions!;
      for (const axis of AXES) {
        const lo = Math.min(b[axis], o[axis]) - 1e-12;
        const hi = Math.max(b[axis], o[axis]) + 1e-12;
        assert.ok(r[axis] >= lo && r[axis] <= hi,
          `${base} / ${name} / ${axis}：resolved ${r[axis]} 必须落在 [${lo}, ${hi}]（凸组合）`);
      }
    }
  }
});

test('MURPHY 12：K_PROFILE_LABEL 的语义锚点 —— 该轴 500 次机会时标签与实测**恰好等权**', () => {
  const p = R('CALLING_STATION', S({ handsObserved: K_PROFILE_LABEL, vpip: 0.18 }));
  assert.equal(p.resolved.evidenceMass!.tightness, K_PROFILE_LABEL,
    '仅 VPIP 时，tightness 的证据质量必须等于机会数');
  assert.equal(p.resolved.blendWeight!.tightness, 0.5,
    '500 次机会 ⇒ w 必须精确为 0.5（这是 K 的定义，不是拟合出来的数）');
  const bigger = R('CALLING_STATION', S({ handsObserved: K_PROFILE_LABEL * 4, vpip: 0.18 }));
  assert.ok(bigger.resolved.blendWeight!.tightness! > 0.75,
    '机会数翻 4 倍 ⇒ 实测必须占主导');
});

/* ============================================================
 * 管线级方向锁（TEST 12 §三十二 的验收）
 * ============================================================ */

test('VECTOR A3（管线）：真跟注站的 Call% / EqVsCall / 薄价值 EV 必须优于紧弱玩家', () => {
  type Pipeline = {
    action: string;
    fold: Record<string, number>; call: Record<string, number>;
    eqVsCall: Record<string, number>; betEV: Record<string, number>;
  };
  const pipeline = (base: QuickProfile, stats: PlayerObservedStats): Pipeline => {
    const input = {
      tableSize: 6, heroPosition: 'BTN', heroCards: ['As', 'Ks'],
      board: ['Kd', '9c', '4h', '6s', '2c'], street: 'RIVER',
      effectiveStackBB: 100, bigBlindBB: 2,
      seatStacksBB: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 },
      actionHistory: [
        { position: 'UTG', type: 'FOLD' }, { position: 'HJ', type: 'FOLD' },
        { position: 'CO', type: 'FOLD' }, { position: 'BTN', type: 'RAISE', amountBB: 3 },
        { position: 'SB', type: 'FOLD' }, { position: 'BB', type: 'CALL', amountBB: 2 },
        { position: 'BB', type: 'CHECK', street: 'FLOP' },
        { position: 'BTN', type: 'BET', amountBB: 2.5, street: 'FLOP' },
        { position: 'BB', type: 'CALL', amountBB: 2.5, street: 'FLOP' },
        { position: 'BB', type: 'CHECK', street: 'TURN' },
        { position: 'BTN', type: 'BET', amountBB: 7.5, street: 'TURN' },
        { position: 'BB', type: 'CALL', amountBB: 7.5, street: 'TURN' },
        { position: 'BB', type: 'CHECK', street: 'RIVER' },
      ],
      environment: 'MID_LOW_STAKES',
      villain: { quickProfile: base, dynamicHint: 'UNKNOWN', stackBB: 100, observedStats: stats },
    } as unknown as Parameters<typeof analyzeManualHand>[0];

    const rules = loadKnowledgeBaseOrThrow().allRules();
    const r = analyzeManualHand(input, {
      rules, asOf: 1_757_000_000_000, writeLog: false, equitySeed: 20_261_012,
      budget: { softMs: 120_000, hardMs: 240_000 },
    });
    assert.equal(r.ok, true, '管线必须成功分析');
    if (!r.ok) throw new Error('unreachable');
    const bd = (r.decision.diagnostics.postflop as unknown as { betDecision: {
      sizes: readonly Record<string, number | string>[];
    } }).betDecision;
    const pick = (field: string): Record<string, number> => Object.fromEntries(
      bd.sizes.map((s) => [String(s['size']), Number(s[field])]),
    );
    return {
      action: String(r.decision.action),
      fold: pick('foldLikelihood'),
      call: pick('callLikelihood'),
      betEV: pick('betEV'),
      eqVsCall: pick('heroEquityVsCallRange'),
    };
  };

  const cs = pipeline('CALLING_STATION', TRUE_CS);
  const tw = pipeline('CALLING_STATION', TIGHT_WEAK);
  assert.ok(cs.fold['BET_SMALL']! < tw.fold['BET_SMALL']!,
    `真跟注站弃牌率必须更低：${cs.fold['BET_SMALL']} < ${tw.fold['BET_SMALL']}`);
  assert.ok(cs.call['BET_SMALL']! > tw.call['BET_SMALL']!,
    `真跟注站跟注率必须更高：${cs.call['BET_SMALL']} > ${tw.call['BET_SMALL']}`);
  assert.ok(cs.eqVsCall['BET_SMALL']! > tw.eqVsCall['BET_SMALL']!,
    `被跟注时权益必须更好：${cs.eqVsCall['BET_SMALL']} > ${tw.eqVsCall['BET_SMALL']}`);
  assert.ok(cs.betEV['BET_SMALL']! > tw.betEV['BET_SMALL']!,
    `薄价值 EV 必须更高：${cs.betEV['BET_SMALL']} > ${tw.betEV['BET_SMALL']}`);
});
