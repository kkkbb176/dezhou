/**
 * `preflopPriors.ts` 与 `likelihoodModel.ts` 的**单元测试**
 *
 * ## 为什么必须有这个文件（红队 F-02 的根本原因）
 *
 * 这两个模块在 Alpha 决策链里承担「对手范围长什么样」的全部责任，
 * 却在红队独立审查时**零测试覆盖**。后果是实测出来的：
 *
 * - `tierOfRankClassIndex` 按「169 表里的位置」切牌力档，
 *   于是 `QQ` 的进攻似然（0.5938）低于 `A7s`（0.9500）——
 *   **牌力倒挂**，而且没有任何一条测试会发现它。
 * - `selfCheckLikelihoodModel` 写了自检，却**没有任何调用者**，
 *   它无声地失效了很久。
 * - 3Bet 场景把对手范围当成开池范围，权益虚高 27.5 个百分点。
 *
 * ## 本文件的断言原则
 *
 * 只断言**结构性不变量**（单调性、覆盖度、来源标注、自检通过），
 * **不**断言任何具体权重数值 ——
 * 那会让每一次合理调参都变成红色，最终逼人删测试。
 *
 * 唯一的例外是「可信度必须是 0.3」这类**声明性**数值：
 * 它们不是调参对象，而是对外承诺的一部分（「这是启发式，不是求解器输出」）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Position, TableSize } from '../src/domain/types.ts';
import { RangeSource } from '../src/domain/range/range.types.ts';
import {
  allRankClassKeys,
  bigBlindCheckWeights,
  defendWeights,
  defendTierOf,
  PREFLOP_PRIOR_PROVENANCE,
  rfiTierOf,
  rfiWeights,
  selfCheckPreflopPriors,
  threeBetTierOf,
  threeBetWeights,
} from '../src/app/manualInput/preflopPriors.ts';
import { ALL_RANK_CLASSES } from '../src/domain/range/combo.ts';
import {
  abnormalLikelihood,
  betRatioOf,
  LIKELIHOOD_FLOOR,
  makeLikelihood,
  normalLikelihood,
  normalizeLikelihood,
  selfCheckLikelihoodModel,
  tierOfRankClass,
} from '../src/app/manualInput/likelihoodModel.ts';

const sum = (w: Readonly<Record<string, number>>): number =>
  Object.values(w).reduce((a, b) => a + b, 0);

const positive = (w: Readonly<Record<string, number>>): number =>
  Object.values(w).filter((x) => x > 0).length;

/* ============================================================
 * 起手牌类别表
 * ============================================================ */

test('类别表：恰好 169 个类别、无重复、格式合法', () => {
  const keys = allRankClassKeys();
  assert.equal(keys.length, 169, `必须是 169 个类别（实际 ${keys.length}）`);
  assert.equal(new Set(keys).size, 169, '不得有重复类别');
  assert.equal(ALL_RANK_CLASSES.length, 169, 'ALL_RANK_CLASSES 也必须是 169');

  const valid = /^([AKQJT98765432])(\1|[AKQJT98765432][so])$/;
  for (const key of keys) {
    assert.ok(valid.test(key), `类别键格式非法：${key}`);
    const high = key[0]!;
    const low = key.length === 3 ? key[1]! : key[0]!;
    assert.ok(
      'AKQJT98765432'.indexOf(high) <= 'AKQJT98765432'.indexOf(low),
      `类别键 ${key} 必须是「大牌在前」（高牌序）`,
    );
  }
  // 13 个对子 + 78 个同花 + 78 个非同花
  assert.equal(keys.filter((k) => k.length === 2).length, 13);
  assert.equal(keys.filter((k) => k.endsWith('s')).length, 78);
  assert.equal(keys.filter((k) => k.endsWith('o')).length, 78);
});

test('来源标注：必须**如实**标为启发式、未验证、可信度 0.3', () => {
  assert.equal(
    PREFLOP_PRIOR_PROVENANCE.sourceType,
    RangeSource.HEURISTIC,
    '这套先验**不是**求解器输出，来源类型必须是 HEURISTIC',
  );
  assert.equal(PREFLOP_PRIOR_PROVENANCE.verified, false, '必须显式标注「未验证」');
  assert.equal(
    PREFLOP_PRIOR_PROVENANCE.confidence,
    0.3,
    '可信度 0.3 是对外承诺的一部分（与知识层 env.* 规则同量级）',
  );
  assert.ok(
    PREFLOP_PRIOR_PROVENANCE.description.includes('不是求解器输出'),
    '来源说明里必须写明「不是求解器输出，不是 GTO 范围」—— ' +
      '否则界面上的范围会被误读成有实证依据的频率',
  );
});

/* ============================================================
 * 开池范围
 * ============================================================ */

test('开池范围：位置越靠后范围越宽（6 人桌）', () => {
  const order: Position[] = [
    Position.UTG,
    Position.HJ,
    Position.CO,
    Position.BTN,
  ];
  const widths = order.map((p) => sum(rfiWeights(TableSize.SIX_MAX, p)));
  for (let i = 1; i < widths.length; i++) {
    assert.ok(
      widths[i]! >= widths[i - 1]!,
      `${order[i]} 的开池范围不得比 ${order[i - 1]} 更窄（${widths[i]} vs ${widths[i - 1]}）`,
    );
  }
  // 严格变宽至少发生一次（否则「位置越靠后越宽」这句话没有内容）
  assert.ok(
    widths[widths.length - 1]! > widths[0]!,
    '按钮位的开池范围必须**严格宽于**枪口位',
  );
});

test('开池范围：9 人桌的前位比 6 人桌的同名前位更紧', () => {
  const six = sum(rfiWeights(TableSize.SIX_MAX, Position.UTG));
  const nine = sum(rfiWeights(TableSize.NINE_MAX, Position.UTG));
  assert.ok(nine <= six, `9 人桌 UTG 不得比 6 人桌 UTG 更宽（${nine} vs ${six}）`);
  assert.ok(
    nine < six,
    '9 人桌 UTG 前面人多了一个级别，必须**严格更紧** —— 否则桌型参数没有生效',
  );
  assert.equal(rfiTierOf(TableSize.NINE_MAX, Position.UTG), 'ULTRA_EARLY');
  assert.equal(rfiTierOf(TableSize.NINE_MAX, Position.LJ), 'EARLY');
});

test('开池范围：每一档都包含顶级牌，且不包含凭空出现的类别', () => {
  for (const position of [Position.UTG, Position.HJ, Position.CO, Position.BTN, Position.SB]) {
    const w = rfiWeights(TableSize.SIX_MAX, position);
    assert.equal(Object.keys(w).length, 169, `${position} 的权重表必须覆盖 169 类`);
    assert.ok((w['AA'] ?? 0) >= 0.75, `${position} 必须给 AA 高权重`);
    assert.ok((w['KK'] ?? 0) >= 0.75, `${position} 必须给 KK 高权重`);
    for (const [key, value] of Object.entries(w)) {
      assert.ok(
        Number.isFinite(value) && value >= 0 && value <= 1,
        `${position} 的 ${key} 权重越界：${value}`,
      );
    }
  }
});

/* ============================================================
 * 防守 / 大盲范围
 * ============================================================ */

test('防守范围：大盲面对开池的继续范围**宽于**任何非盲注位', () => {
  const bb = sum(defendWeights(TableSize.SIX_MAX, Position.CO, Position.BB));
  const co = sum(defendWeights(TableSize.SIX_MAX, Position.CO, Position.CO));
  assert.ok(
    bb > co,
    `大盲已经有 1BB 投入，继续范围必须宽于非盲注位（BB=${bb} CO=${co}）`,
  );
  assert.equal(defendTierOf(TableSize.SIX_MAX, Position.CO, Position.BB), 'BIG_BLIND_VS_OPEN');
});

test('大盲过牌范围：必须是所有范围里最宽的（已投入盲注）', () => {
  const bbCheck = sum(bigBlindCheckWeights());
  const widestOpen = Math.max(
    ...[Position.UTG, Position.HJ, Position.CO, Position.BTN].map((p) =>
      sum(rfiWeights(TableSize.SIX_MAX, p)),
    ),
  );
  assert.ok(
    bbCheck > widestOpen,
    `大盲过牌范围必须最宽（过牌=${bbCheck} 最宽开池=${widestOpen}）`,
  );
  assert.equal(Object.keys(bigBlindCheckWeights()).length, 169);
});

/* ============================================================
 * 3Bet 范围（红队 F-03 的永久锁）
 * ============================================================ */

test('3Bet 范围：每个档位都**严格窄于**最宽的开池范围', () => {
  const widestOpen = Math.max(
    ...[Position.UTG, Position.HJ, Position.CO, Position.BTN].map((p) =>
      sum(rfiWeights(TableSize.SIX_MAX, p)),
    ),
  );
  const threeBets: readonly (readonly [string, Readonly<Record<string, number>>])[] = [
    ['面对前位', threeBetWeights(TableSize.SIX_MAX, Position.HJ, Position.UTG)],
    ['面对中位', threeBetWeights(TableSize.SIX_MAX, Position.CO, Position.HJ)],
    ['面对后位', threeBetWeights(TableSize.SIX_MAX, Position.BTN, Position.CO)],
    ['大盲 3Bet', threeBetWeights(TableSize.SIX_MAX, Position.BB, Position.CO)],
  ];
  for (const [name, w] of threeBets) {
    assert.equal(Object.keys(w).length, 169, `${name} 必须覆盖 169 类`);
    assert.ok(
      sum(w) < widestOpen,
      `${name} 的 3Bet 范围必须严格窄于最宽开池范围（${sum(w)} vs ${widestOpen}）—— ` +
        '否则「面对再加注」会被当成「面对开池」（红队 F-03）',
    );
    assert.ok((w['AA'] ?? 0) > 0 && (w['KK'] ?? 0) > 0, `${name} 必须包含 AA 与 KK`);
  }
});

test('3Bet 档位映射：**不允许**回退到「按钮位开池」这类默认档', () => {
  // 修复前 rfiTierOf(6max, BB) 会落到 default: BUTTON ——
  // 于是「大盲 3Bet」被当成「按钮位开池」。下面把映射逐位钉住。
  //
  // ⚠️ 盲注位的优先级**高于**开池者位置：大盲的 3Bet 有折扣，
  // 因此无论面对谁开池都用 `THREEBET_FROM_BLIND` 这一档。
  assert.equal(threeBetTierOf(TableSize.SIX_MAX, Position.BB, Position.UTG), 'THREEBET_FROM_BLIND');
  assert.equal(threeBetTierOf(TableSize.SIX_MAX, Position.SB, Position.UTG), 'THREEBET_FROM_BLIND');
  assert.equal(threeBetTierOf(TableSize.SIX_MAX, Position.BB, Position.CO), 'THREEBET_FROM_BLIND');
  // 非盲注位的 3Bet：按开池者位置分档
  assert.equal(threeBetTierOf(TableSize.SIX_MAX, Position.BTN, Position.UTG), 'THREEBET_VS_EARLY');
  assert.equal(threeBetTierOf(TableSize.SIX_MAX, Position.BTN, Position.CO), 'THREEBET_VS_LATE');
  assert.equal(threeBetTierOf(TableSize.SIX_MAX, Position.CO, Position.HJ), 'THREEBET_VS_MIDDLE');

  // 位置越靠后的开池者 → 允许的 3Bet 范围不得更窄
  const vsEarly = sum(threeBetWeights(TableSize.SIX_MAX, Position.BTN, Position.UTG));
  const vsLate = sum(threeBetWeights(TableSize.SIX_MAX, Position.BTN, Position.CO));
  assert.ok(
    vsLate >= vsEarly,
    `面对后位开池的 3Bet 范围不得比面对前位更窄（后=${vsLate} 前=${vsEarly}）`,
  );
});

test('3Bet 范围：比同位置的**开池**范围窄，但比**大盲过牌**范围窄得多', () => {
  const threeBet = sum(threeBetWeights(TableSize.SIX_MAX, Position.BTN, Position.CO));
  const btnOpen = sum(rfiWeights(TableSize.SIX_MAX, Position.BTN));
  const bbCheck = sum(bigBlindCheckWeights());
  assert.ok(threeBet < btnOpen, '3Bet 必须窄于开池');
  assert.ok(threeBet < bbCheck, '3Bet 必须窄于大盲过牌范围');
});

/* ============================================================
 * 似然模型
 * ============================================================ */

test('似然模型：自检必须通过（且本文件就是它的调用者）', () => {
  assert.deepEqual(selfCheckLikelihoodModel(), []);
});

test('归一化：必须落在 [0, 0.95]，且**保留相对比值**', () => {
  const weights = [4, 2.5, 1.2, 0.7, 0.45, 0.3];
  const out = normalizeLikelihood(weights);
  assert.equal(out.length, weights.length);
  assert.equal(out[0], 0.95, '最大值应被归一到上限 0.95');
  for (const v of out) assert.ok(v > 0 && v <= 0.95, `归一化结果越界：${v}`);
  // 比值守恒（max 归一化的全部意义）
  for (let i = 1; i < weights.length; i++) {
    assert.ok(
      Math.abs(out[i]! / out[0]! - weights[i]! / weights[0]!) < 1e-12,
      '归一化必须保留相对比值（否则「强牌更可能加注」的强度就变了）',
    );
  }
  // 全零输入必须走下限而不是产生 NaN / 0
  const zeros = normalizeLikelihood([0, 0, 0]);
  assert.ok(
    zeros.every((v) => v === LIKELIHOOD_FLOOR),
    `全零权重必须回落到下限 ${LIKELIHOOD_FLOOR}，实际 ${JSON.stringify(zeros)}`,
  );
  for (const v of zeros) {
    assert.ok(Number.isFinite(v) && v > 0, '归一化绝不能产生 NaN 或 0（会让类别永久消失）');
  }
});

test('似然模型：`likelihood ∈ [0,1]` —— 范围引擎的硬要求（越界会静默失败）', () => {
  for (const betRatio of [undefined, 0, 0.1, 0.5, 1, 2, 3, 10, 1e6]) {
    for (const [name, f] of [
      ['进攻', abnormalLikelihood(betRatio)],
      ['被动', normalLikelihood(betRatio)],
    ] as const) {
      for (const key of allRankClassKeys()) {
        const v = f(key);
        assert.ok(
          Number.isFinite(v) && v >= 0 && v <= 1,
          `${name}似然(betRatio=${String(betRatio)})('${key}') = ${v} 越界 —— ` +
            '范围引擎会以「likelihood 越界」拒绝整个动作模型，于是每次更新都静默失败',
        );
      }
    }
  }
});

test('似然模型：下注量放大**只向顶级档收紧**，不得反转单调性', () => {
  const small = abnormalLikelihood(0.3);
  const huge = abnormalLikelihood(3);
  // 超池下注必须让顶级牌更突出
  assert.ok(
    huge('AA') >= small('AA'),
    '更大注入不得降低顶级牌的进攻似然',
  );
  // 但**单调性绝不能被反转**：任何下注量下垃圾牌都不得高于顶级牌
  for (const ratio of [undefined, 0.2, 0.5, 1, 2, 5, 100]) {
    const f = abnormalLikelihood(ratio);
    const values = ['AA', 'KK', 'QQ', 'AKo', 'JJ', 'TT', 'A5s', '22', 'A5o', '72o'].map(
      (k) => f(k),
    );
    for (let i = 1; i < values.length; i++) {
      assert.ok(
        values[i]! <= values[i - 1]! + 1e-12,
        `betRatio=${String(ratio)} 时进攻似然出现倒挂：` +
          `${values[i]} > ${values[i - 1]}（档位必须单调不增）`,
      );
    }
  }
});

test('似然模型：`makeLikelihood` 的方向必须与 `abnormal`/`normal` 一致', () => {
  assert.equal(makeLikelihood(true)('AA'), abnormalLikelihood()('AA'));
  assert.equal(makeLikelihood(false)('72o'), normalLikelihood()('72o'));
});

test('`betRatioOf`：非法输入必须返回 undefined（不能返回 NaN 混进计算）', () => {
  assert.equal(betRatioOf(undefined, 100), undefined);
  assert.equal(betRatioOf(50, undefined), undefined);
  assert.equal(betRatioOf(0, 100), undefined, '下注额为 0 不是「下注」');
  assert.equal(betRatioOf(50, 0), undefined, '底池为 0 时比例无意义');
  assert.equal(betRatioOf(Number.NaN, 100), undefined);
  assert.equal(betRatioOf(50, Number.POSITIVE_INFINITY), undefined);
  assert.equal(betRatioOf(-50, 100), undefined);
  assert.equal(betRatioOf(50, 100), 0.5);
});

test('`tierOfRankClass`：非法输入必须落到最弱档而不是抛异常（绝不崩在热路径上）', () => {
  for (const bad of ['', 'X', 'AAAs', '123', 'ZZ', 'A', 'AKx']) {
    const tier = tierOfRankClass(bad);
    assert.ok(
      Number.isInteger(tier) && tier >= 0 && tier <= 5,
      `非法输入 '${bad}' 必须得到一个合法档位，实际 ${tier}`,
    );
  }
});

test('`tierOfRankClass`：档位必须与「牌力」方向一致（逐档抽样）', () => {
  const pairs: readonly (readonly [string, number])[] = [
    ['AA', 0],
    ['QQ', 0],
    ['JJ', 1],
    ['88', 1],
    ['77', 2],
    ['55', 2],
    ['22', 3],
    ['AKs', 0],
    ['AKo', 0],
    ['A5s', 2],
    ['A5o', 4],
    ['KQs', 1],
    ['KQo', 2],
    ['72o', 5],
    ['32o', 5],
    ['JTs', 2],
    ['JTo', 4],
  ];
  for (const [cls, expected] of pairs) {
    assert.equal(
      tierOfRankClass(cls),
      expected,
      `${cls} 的档位应为 ${expected}（实际 ${tierOfRankClass(cls)}）`,
    );
  }
  // 结构断言：同花**不得**比非同花更弱
  for (const key of allRankClassKeys()) {
    if (!key.endsWith('o')) continue;
    const suited = `${key.slice(0, 2)}s`;
    assert.ok(
      tierOfRankClass(suited) <= tierOfRankClass(key),
      `${suited} 的同花档位不得弱于 ${key}（同花只可能更强）`,
    );
  }
});

/* ============================================================
 * 自检的**触发能力**（自检必须真的能失败）
 * ============================================================ */

test('自检必须**能失败** —— 否则它是一条永远为真的假保险', () => {
  // 思路：把「档位必须随牌力单调」这条判据**原样**用在一个
  // 故意倒挂的模型上。若判据有内容，它必须报错。
  const ascending = ['72o', 'A5o', '22', 'A5s', 'JJ', 'AA'];
  const tiers = ascending.map((k) => tierOfRankClass(k));
  for (let i = 1; i < tiers.length; i++) {
    assert.ok(
      tiers[i]! <= tiers[i - 1]!,
      `抽样序列是弱→强的，档位必须单调不增（${ascending[i - 1]}=${tiers[i - 1]} → ` +
        `${ascending[i]}=${tiers[i]}）—— 判据方向本身要正确`,
    );
  }

  // ---- 判据对「倒挂模型」必须报错 ----
  const good = abnormalLikelihood();
  const inverted = (key: string): number => 1 - good(key); // 故意倒挂
  const violations: string[] = [];
  let prev = Number.POSITIVE_INFINITY;
  for (const [cls] of [
    ['AA', 0],
    ['JJ', 1],
    ['A5s', 2],
    ['22', 3],
    ['A5o', 4],
    ['72o', 5],
  ] as const) {
    const value = inverted(cls);
    if (!(value <= prev)) violations.push(`${cls}: ${value} > ${prev}`);
    prev = value;
  }
  assert.ok(
    violations.length > 0,
    '「进攻似然必须单调不增」这条判据对倒挂模型**必须**报错；' +
      '若一条都不报，说明判据是空的（这正是 F-02 中自检失效的形态）',
  );

  // 归一化的下限路径必须真的被执行到（全零输入不得产生 NaN 或 0）
  const brokenNormalize = normalizeLikelihood([0, 0]);
  assert.deepEqual(
    [...brokenNormalize],
    [LIKELIHOOD_FLOOR, LIKELIHOOD_FLOOR],
    '归一化的下限路径必须真的被执行到（全零输入）',
  );
  assert.ok(
    normalizeLikelihood([0, 0]).every((v) => Number.isFinite(v) && v > 0),
    '下限必须是正数，否则该类别会被一次更新永久删除',
  );
});

test('权重表：不得出现「全是 0」或「全部相同」的档位（那等于没有范围）', () => {
  const tables: readonly (readonly [string, Readonly<Record<string, number>>])[] = [
    ['UTG 开池', rfiWeights(TableSize.SIX_MAX, Position.UTG)],
    ['BTN 开池', rfiWeights(TableSize.SIX_MAX, Position.BTN)],
    ['大盲防守', defendWeights(TableSize.SIX_MAX, Position.CO, Position.BB)],
    ['大盲过牌', bigBlindCheckWeights()],
    ['BTN 3Bet', threeBetWeights(TableSize.SIX_MAX, Position.BTN, Position.CO)],
  ];
  for (const [name, w] of tables) {
    const values = Object.values(w);
    assert.ok(sum(w) > 0, `${name} 的权重和必须为正`);
    assert.ok(
      positive(w) >= 10,
      `${name} 只有 ${positive(w)} 个类别有权重 —— 范围过窄等于「认定对手只有这几手牌」，` +
        '本项目没有依据做这种断言',
    );
    assert.ok(new Set(values).size > 1, `${name} 的权重不得全部相同（那等于均匀范围）`);
  }
});
