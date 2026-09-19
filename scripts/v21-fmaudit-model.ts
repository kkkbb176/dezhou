/**
 * V21 画像失败模式审计 —— 模型层探针（items 1/2/3/4/5/6/10/17 的模型侧）
 *
 * 用法：
 * ```text
 * node --experimental-strip-types scripts/v21-fmaudit-model.ts
 * ```
 *
 * 只调用**生产函数本身**（不重写公式、不做镜像实现）：
 * `statEvidenceOf` / `manualReadEvidence` / `behaviorProfileOf` /
 * `estimateUnifiedActionLikelihood` / `riverComboClassOf` / `MATERIALITY_THRESHOLDS`。
 * 每个探针都打印**原始数值**，判定写在报告里而不是脚本里。
 */

import {
  BehaviorTraitKey,
  ENVIRONMENT_BEHAVIOR_PRIOR,
  ENVIRONMENT_PRIOR_WEIGHT,
  MANUAL_READ_CONFIDENCE_CAP,
  MANUAL_READ_PSEUDO_COUNT,
  MATERIALITY_THRESHOLDS,
  StatSource,
  behaviorProfileOf,
  estimateUnifiedActionLikelihood,
  manualReadEvidence,
  profileMaterialityOf,
  statEvidenceOf,
  type BehaviorNodeContext,
  type PlayerBehaviorProfile,
} from '../src/domain/player/behaviorProfile.ts';

const line = (s = ''): void => console.log(s);
const h = (t: string): void => {
  line();
  line('='.repeat(78));
  line(t);
  line('='.repeat(78));
};
const n = (x: unknown, d = 6): string =>
  typeof x === 'number' ? (Number.isNaN(x) ? 'NaN' : x.toFixed(d)) : String(x);

/** 与黄金夹具同一个节点语义（河牌 + 大注 + 我让牌后他开火） */
const NODE: BehaviorNodeContext = {
  street: 'RIVER',
  heroPosition: 'CO',
  villainPosition: 'BB',
  potType: 'SRP',
  playerCount: 2,
  previousStreetLine: 'TURN_CHECK_BACK',
  currentAction: 'BET',
  sizeBucket: 'LARGE',
  boardTexture: 'SEMI_WET',
};

const likeOf = (
  profile: PlayerBehaviorProfile,
  semanticClass: Parameters<typeof estimateUnifiedActionLikelihood>[0]['semanticClass'],
  strengthBucket: number,
  betRatio = 0.7,
) =>
  estimateUnifiedActionLikelihood({
    semanticClass,
    strengthBucket,
    betRatio,
    node: NODE,
    profile,
    action: 'BET',
    withTrace: true,
  });

/* ============================================================
 * ITEM 1 —— 零样本（opportunities = 0）
 * ============================================================ */
h('ITEM 1 零样本：observed { successes: 0, opportunities: 0 }');
{
  const e = statEvidenceOf({
    successes: 0,
    opportunities: 0,
    priorRate: 0.28,
    priorWeight: ENVIRONMENT_PRIOR_WEIGHT,
    source: StatSource.OBSERVED_HAND_HISTORY,
  });
  line(`opportunities=0: observedRate=${String(e.observedRate)} confidence=${n(e.confidence)}`);
  line(`  priorRate=${n(e.priorRate)} effectiveRate=${n(e.effectiveRate)} 逐位相等=${e.effectiveRate === e.priorRate}`);
  line(`  noteZh=${e.noteZh}`);

  // 与「不传 observed」对照：必须逐位一致
  const withObserved0 = behaviorProfileOf({
    playerId: 'p',
    archetype: 'MANIAC' as never,
    observed: { [BehaviorTraitKey.RIVER_BLUFF]: { successes: 0, opportunities: 0 } } as never,
  });
  const withoutObserved = behaviorProfileOf({ playerId: 'p', archetype: 'MANIAC' as never });
  line(
    `  observed 0/0 vs 不传 observed：riverBluff effectiveRate ` +
      `${n(withObserved0.traits.riverBluff.effectiveRate)} vs ${n(withoutObserved.traits.riverBluff.effectiveRate)}` +
      ` 逐位相等=${withObserved0.traits.riverBluff.effectiveRate === withoutObserved.traits.riverBluff.effectiveRate}`,
  );
  line(
    `  但 source 不同：${withObserved0.traits.riverBluff.source} vs ${withoutObserved.traits.riverBluff.source}` +
      `（前者声称「实测手牌历史」，实测为 0 次）`,
  );
  const u = likeOf(withObserved0, 'PURE_AIR', 5);
  const u0 = likeOf(withoutObserved, 'PURE_AIR', 5);
  line(`  似然：observed0=${n(u.likelihood)} 无observed=${n(u0.likelihood)} 逐位相等=${u.likelihood === u0.likelihood}`);
  line(`  confidence 是否被下游读到：profileMaterialityOf 不读 confidence；此处仅记录`);
  line(`  MATERIALITY_THRESHOLDS=${JSON.stringify(MATERIALITY_THRESHOLDS)}`);
  line(`  MANUAL_READ_CONFIDENCE_CAP=${MANUAL_READ_CONFIDENCE_CAP} MANUAL_READ_PSEUDO_COUNT=${MANUAL_READ_PSEUDO_COUNT}`);
}

/* ============================================================
 * ITEM 2 —— 极少样本（1/1、2/2、0/1）
 * ============================================================ */
h('ITEM 2 极少样本：1/1、2/2、0/1 的收缩');
{
  for (const [s, o] of [
    [1, 1],
    [2, 2],
    [0, 1],
    [1, 2],
    [0, 0],
    [5, 5],
    [60, 100],
  ] as const) {
    const e = statEvidenceOf({
      successes: s,
      opportunities: o,
      priorRate: ENVIRONMENT_BEHAVIOR_PRIOR.riverBluff,
      priorWeight: ENVIRONMENT_PRIOR_WEIGHT,
      source: StatSource.OBSERVED_HAND_HISTORY,
    });
    const rateOdds = (r: number): number => {
      const p = Math.max(0.001, Math.min(0.999, r));
      return p / (1 - p);
    };
    const cond = rateOdds(e.effectiveRate) / rateOdds(ENVIRONMENT_BEHAVIOR_PRIOR.riverBluff);
    line(
      `${s}/${o}: observedRate=${e.observedRate === null ? 'null' : n(e.observedRate)} ` +
        `effectiveRate=${n(e.effectiveRate)} confidence=${n(e.confidence)} 相对池先验几率比=${n(cond, 4)}×`,
    );
  }
  const p = behaviorProfileOf({
    playerId: 'p',
    observed: { [BehaviorTraitKey.RIVER_BLUFF]: { successes: 2, opportunities: 2 } } as never,
  });
  const u = likeOf(p, 'PURE_AIR', 5);
  line(
    `2/2 画像 × PURE_AIR 似然=${n(u.likelihood)}（钳位=${u.clamped}）` +
      ` 相对中性=${n(u.likelihood / likeOf(behaviorProfileOf({ playerId: 'n' }), 'PURE_AIR', 5).likelihood, 4)}×`,
  );
  line(`  2/2 不会变成 100%：effectiveRate=${n(p.traits.riverBluff.effectiveRate)} < 1`);
}

/* ============================================================
 * ITEM 3 —— 缺失字段
 * ============================================================ */
h('ITEM 3 缺失字段：无 archetype / 空 manual / 只给一个条目 / 缺 traits 键');
{
  const bare = behaviorProfileOf({ playerId: 'x' });
  line(`无 archetype：isUnknownPlayer=${bare.isUnknownPlayer} archetypePriorAvailable=${bare.archetypePriorAvailable}`);
  line(`  priorNoteZh=${bare.priorNoteZh}`);
  const keys = Object.values(BehaviorTraitKey);
  line(
    `  6 条目是否全部等于池先验：` +
      keys
        .map((k) => `${k}=${bare.traits[k].effectiveRate === ENVIRONMENT_BEHAVIOR_PRIOR[k]}`)
        .join(' '),
  );
  const emptyManual = behaviorProfileOf({ playerId: 'x', manual: {} });
  line(
    `空 manual {}：逐位等于无 manual = ${keys.every(
      (k) => emptyManual.traits[k].effectiveRate === bare.traits[k].effectiveRate,
    )}`,
  );
  const partial = behaviorProfileOf({
    playerId: 'x',
    observed: { [BehaviorTraitKey.RIVER_BLUFF]: { successes: 3, opportunities: 10 } } as never,
  });
  line(
    `只给 observed.riverBluff：riverBluff source=${partial.traits.riverBluff.source}，` +
      `其余 5 条 source=${keys
        .filter((k) => k !== BehaviorTraitKey.RIVER_BLUFF)
        .map((k) => partial.traits[k].source)
        .filter((v, i2, a2) => a2.indexOf(v) === i2)
        .join(',')}`,
  );
  line(`  priorNoteZh=${partial.priorNoteZh}`);

  // 手工残缺画像（生产入口 input.behaviorProfile 不经校验 —— 见 manualInput.ts:226）
  const broken = {
    playerId: 'x',
    playerName: null,
    archetype: null,
    traits: { [BehaviorTraitKey.RIVER_BLUFF]: partial.traits.riverBluff },
    isUnknownPlayer: true,
    archetypePriorAvailable: false,
    priorNoteZh: 'hand-made',
  } as unknown as PlayerBehaviorProfile;
  try {
    const u = likeOf(broken, 'PURE_AIR', 5);
    line(`残缺 traits（只有 riverBluff）→ PURE_AIR 似然=${n(u.likelihood)}（未抛错）`);
  } catch (err) {
    line(`残缺 traits（只有 riverBluff）→ 抛错：${(err as Error).constructor.name}: ${(err as Error).message}`);
    try {
      likeOf(broken, 'MISSED_FLUSH_DRAW', 5);
    } catch (err2) {
      line(`    MISSED_FLUSH_DRAW 也抛：${(err2 as Error).message}`);
    }
  }
}

/* ============================================================
 * ITEM 4 —— 非法数值（NaN / Infinity / 负数 / successes>opportunities / 浮点机会数）
 * ============================================================ */
h('ITEM 4 非法数值进 statEvidenceOf');
{
  const rows: readonly [string, { successes: number; opportunities: number; priorRate: number; priorWeight: number }][] = [
    ['基线 3/10', { successes: 3, opportunities: 10, priorRate: 0.28, priorWeight: 6 }],
    ['successes=NaN', { successes: NaN, opportunities: 10, priorRate: 0.28, priorWeight: 6 }],
    ['opportunities=NaN', { successes: 3, opportunities: NaN, priorRate: 0.28, priorWeight: 6 }],
    ['successes=Infinity', { successes: Infinity, opportunities: 10, priorRate: 0.28, priorWeight: 6 }],
    ['opportunities=Infinity', { successes: 3, opportunities: Infinity, priorRate: 0.28, priorWeight: 6 }],
    ['priorWeight=Infinity', { successes: 3, opportunities: 10, priorRate: 0.28, priorWeight: Infinity }],
    ['opportunities=-5', { successes: 3, opportunities: -5, priorRate: 0.28, priorWeight: 6 }],
    ['successes=-3', { successes: -3, opportunities: 10, priorRate: 0.28, priorWeight: 6 }],
    ['successes=99>opportunities=10', { successes: 99, opportunities: 10, priorRate: 0.28, priorWeight: 6 }],
    ['priorRate=1.7', { successes: 3, opportunities: 10, priorRate: 1.7, priorWeight: 6 }],
    ['priorRate=-0.4', { successes: 3, opportunities: 10, priorRate: -0.4, priorWeight: 6 }],
    ['priorRate=NaN', { successes: 3, opportunities: 10, priorRate: NaN, priorWeight: 6 }],
    ['opportunities=2.5（浮点）', { successes: 1, opportunities: 2.5, priorRate: 0.28, priorWeight: 6 }],
    ['opportunities=10.9（浮点）', { successes: 3, opportunities: 10.9, priorRate: 0.28, priorWeight: 6 }],
  ];
  line(
    'case'.padEnd(30) +
      'observedRate'.padEnd(14) +
      'effectiveRate'.padEnd(15) +
      'confidence'.padEnd(12) +
      '反推似然（PURE_AIR）',
  );
  for (const [label, input] of rows) {
    const e = statEvidenceOf({ ...input, source: StatSource.OBSERVED_HAND_HISTORY });
    const prof = behaviorProfileOf({
      playerId: 'p',
      observed: { [BehaviorTraitKey.RIVER_BLUFF]: { successes: input.successes, opportunities: input.opportunities } } as never,
    });
    let like = '—';
    let clamped = '—';
    try {
      const u = likeOf(prof, 'PURE_AIR', 5);
      like = n(u.likelihood, 6);
      clamped = String(u.clamped);
    } catch (err) {
      like = `抛错 ${(err as Error).message}`;
    }
    line(
      label.padEnd(30) +
        String(e.observedRate === null ? 'null' : n(e.observedRate)).padEnd(14) +
        n(e.effectiveRate).padEnd(15) +
        n(e.confidence, 4).padEnd(12) +
        `${like} (clamped=${clamped})`,
    );
  }
  line('★ 期望：非法数值必须被拒或被钳；实际见上表（NaN 会穿透整条链）。');
  line(
    `priorWeight=Infinity 的 effectiveRate=${n(
      statEvidenceOf({ successes: 3, opportunities: 10, priorRate: 0.28, priorWeight: Infinity, source: StatSource.OBSERVED_HAND_HISTORY })
        .effectiveRate,
    )}`,
  );
}

/* ============================================================
 * ITEM 5 —— 概率边界（恰好 0 / 恰好 1）
 * ============================================================ */
h('ITEM 5 概率边界：rate → 0 / → 1，以及是否可达');
{
  line('（a）经 behaviorProfileOf 是否可达 0 或 1：');
  for (const [label, s, o] of [
    ['0/100000', 0, 100_000],
    ['100000/100000', 100_000, 100_000],
    ['0/1', 0, 1],
    ['1/1', 1, 1],
  ] as const) {
    const p = behaviorProfileOf({
      playerId: 'p',
      observed: { [BehaviorTraitKey.RIVER_BLUFF]: { successes: s, opportunities: o } } as never,
    });
    const r = p.traits.riverBluff.effectiveRate;
    line(`  ${label}: effectiveRate=${r} ===0?${r === 0} ===1?${r === 1}`);
  }
  const manualVH = manualReadEvidence({ tendency: 'VERY_HIGH', environmentPrior: 0.28 });
  const manualVL = manualReadEvidence({ tendency: 'VERY_LOW', environmentPrior: 0.28 });
  line(`  manual VERY_HIGH effectiveRate=${manualVH.effectiveRate} VERY_LOW=${manualVL.effectiveRate}`);

  line('（b）注入式画像（input.behaviorProfile 不经校验）可以给出恰好 0 / 1：');
  for (const rate of [0, 1, 0.999, 0.001]) {
    for (const cls of ['PURE_AIR', 'MISSED_FLUSH_DRAW', 'THIN_VALUE', 'NUT_VALUE'] as const) {
      const prof = behaviorProfileOf({
        playerId: 'p',
        observed: { [BehaviorTraitKey.RIVER_BLUFF]: { successes: 0, opportunities: 0 } } as never,
      });
      const traits = { ...prof.traits } as Record<string, unknown>;
      traits[BehaviorTraitKey.RIVER_BLUFF] = { ...prof.traits.riverBluff, effectiveRate: rate };
      traits[BehaviorTraitKey.MISSED_DRAW_BLUFF] = { ...prof.traits.missedDrawBluff, effectiveRate: rate };
      traits[BehaviorTraitKey.RIVER_LARGE_BET_BLUFF] = { ...prof.traits.riverLargeBetBluff, effectiveRate: rate };
      traits[BehaviorTraitKey.PROBE_AFTER_TURN_CHECK_BACK] = { ...prof.traits.probeAfterTurnCheckBack, effectiveRate: rate };
      const injected = { ...prof, traits } as unknown as PlayerBehaviorProfile;
      const u = likeOf(injected, cls, cls === 'NUT_VALUE' ? 0 : 5);
      line(
        `  effectiveRate=${rate} ${cls.padEnd(18)} base=${n(u.baseLikelihood)} ` +
          `combined=${n(u.combinedAdjustment, 4)} raw=${n(u.rawLikelihood)} like=${n(u.likelihood)} clamped=${u.clamped}`,
      );
    }
  }
  line('（c）rateOdds 的钳位：0 → 1e-3/0.999、1 → 0.999/1e-3（最大/最小几率比）。');
  const lo = (0.001 / 0.999) / (ENVIRONMENT_BEHAVIOR_PRIOR.riverLargeBetBluff / (1 - ENVIRONMENT_BEHAVIOR_PRIOR.riverLargeBetBluff));
  const hi = (0.999 / 0.001) / (ENVIRONMENT_BEHAVIOR_PRIOR.riverLargeBetBluff / (1 - ENVIRONMENT_BEHAVIOR_PRIOR.riverLargeBetBluff));
  line(`  大注诈唬条目单条几率比范围 = [${n(lo, 5)}×, ${n(hi, 4)}×]（非 0、非 ∞ ⇒ 概率本身有界）`);
}

/* ============================================================
 * ITEM 6 —— 陈旧数据 / 时间衰减（模型层有无时间字段）
 * ============================================================ */
h('ITEM 6 陈旧数据：StatEvidence / PlayerBehaviorProfile 是否存在时间字段');
{
  const p = behaviorProfileOf({
    playerId: 'p',
    archetype: 'MANIAC' as never,
    observed: { [BehaviorTraitKey.RIVER_BLUFF]: { successes: 30, opportunities: 50 } } as never,
  });
  line(`PlayerBehaviorProfile 字段：${Object.keys(p).join(', ')}`);
  line(`StatEvidence 字段：${Object.keys(p.traits.riverBluff).join(', ')}`);
  line(`behaviorProfileOf 入参允许的键：playerId / playerName / archetype / manual / observed（见 behaviorProfile.ts:409-417）`);
  line('★ 无任何时间戳 ⇒ 「5 年前的 30/50」与「昨天的 30/50」在本层逐位相同。');
}

/* ============================================================
 * ITEM 10 —— 机会数分母（模型层：分母只由调用方给定）
 * ============================================================ */
h('ITEM 10 错误分母：把「总手数」当「该行为的机会数」会发生什么');
{
  const asBehaviour = statEvidenceOf({
    successes: 12,
    opportunities: 50, // 「河牌面对下注」50 次，其中 12 次诈唬
    priorRate: 0.28,
    priorWeight: 6,
    source: StatSource.OBSERVED_HAND_HISTORY,
  });
  const asHands = statEvidenceOf({
    successes: 12,
    opportunities: 1000, // 「打过 1000 手」，其中 12 次河牌诈唬 ⇒ 同一个 12 被当成 1.2%
    priorRate: 0.28,
    priorWeight: 6,
    source: StatSource.OBSERVED_HAND_HISTORY,
  });
  const ro = (r: number): number => {
    const q = Math.max(0.001, Math.min(0.999, r));
    return q / (1 - q);
  };
  line(`行为分母 12/50  ： effectiveRate=${n(asBehaviour.effectiveRate)} confidence=${n(asBehaviour.confidence, 4)}`);
  line(`总手数分母 12/1000： effectiveRate=${n(asHands.effectiveRate)} confidence=${n(asHands.confidence, 4)}`);
  line(
    `两者相对池先验的几率比： ${n(ro(asBehaviour.effectiveRate) / ro(0.28), 4)}× vs ` +
      `${n(ro(asHands.effectiveRate) / ro(0.28), 4)}× ⇒ 相差 ${n(
        (ro(asBehaviour.effectiveRate) / ro(asHands.effectiveRate)),
        2,
      )}×`,
  );
  line(`confidence 却从 ${n(asBehaviour.confidence, 3)} 升到 ${n(asHands.confidence, 3)}（错的分母看起来更可信）`);
  line('★ unknownOutcomeOpportunities 与 opportunities 之间无一致性校验：');
  const weird = statEvidenceOf({
    successes: 1,
    opportunities: 1,
    unknownOutcomeOpportunities: 500,
    priorRate: 0.28,
    priorWeight: 6,
    source: StatSource.OBSERVED_HAND_HISTORY,
  });
  line(`  1/1 + unknown 500 ⇒ opportunities=${weird.opportunities} unknown=${weird.unknownOutcomeOpportunities}（被接受）`);
}

/* ============================================================
 * ITEM 17 —— 极端画像的模型侧边界
 * ============================================================ */
h('ITEM 17 极端值：似然是否越界 / 会被钳位 / 会不会 0');
{
  const classes = [
    ['NUT_VALUE', 0],
    ['STRONG_VALUE', 1],
    ['THIN_VALUE', 2],
    ['SHOWDOWN_VALUE', 3],
    ['MISSED_FLUSH_DRAW', 5],
    ['MISSED_STRAIGHT_DRAW', 5],
    ['MISSED_COMBO_DRAW', 5],
    ['PURE_AIR', 5],
  ] as const;
  for (const archetype of ['MANIAC', 'CALLING_STATION', 'BLUFF_HEAVY', 'UNDERBLUFFER'] as const) {
    const prof = behaviorProfileOf({ playerId: 'p', archetype: archetype as never });
    const row = classes.map(([cls, bucket]) => {
      const u = likeOf(prof, cls, bucket);
      return `${cls}:${n(u.likelihood, 4)}${u.clamped ? '!' : ''}`;
    });
    line(`${archetype.padEnd(16)} ${row.join(' ')}   （! = 钳到 1）`);
  }
  line('--- 全条目极值（注入式：6 条全部 effectiveRate=0.999） ---');
  const base = behaviorProfileOf({ playerId: 'p' });
  const extremeTraits = { ...base.traits } as Record<string, unknown>;
  for (const k of Object.values(BehaviorTraitKey)) {
    extremeTraits[k] = { ...(base.traits as never as Record<string, { effectiveRate: number }>)[k], effectiveRate: 0.999 };
  }
  const extreme = { ...base, traits: extremeTraits } as unknown as PlayerBehaviorProfile;
  for (const [cls, bucket] of classes) {
    const u = likeOf(extreme, cls, bucket);
    line(
      `  ${cls.padEnd(20)} base=${n(u.baseLikelihood)} combined=${n(u.combinedAdjustment, 4)} ` +
        `raw=${n(u.rawLikelihood)} like=${n(u.likelihood)} clamped=${u.clamped}`,
    );
  }
  line('--- 全条目 0.0001 ---');
  for (const k of Object.values(BehaviorTraitKey)) {
    (extremeTraits as Record<string, { effectiveRate: number }>)[k] = {
      ...(extremeTraits[k] as { effectiveRate: number }),
      effectiveRate: 0.0001,
    };
  }
  const extremeLow = { ...base, traits: extremeTraits } as unknown as PlayerBehaviorProfile;
  for (const [cls, bucket] of classes) {
    const u = likeOf(extremeLow, cls, bucket);
    line(
      `  ${cls.padEnd(20)} base=${n(u.baseLikelihood)} combined=${n(u.combinedAdjustment, 6)} ` +
        `raw=${n(u.rawLikelihood)} like=${n(u.likelihood)} clamped=${u.clamped}（>0? ${u.likelihood > 0}）`,
    );
  }
  line('--- 极小概率下 profileMaterialityOf 的判定 ---');
  const a = likeOf(behaviorProfileOf({ playerId: 'a', archetype: 'CALLING_STATION' as never }), 'PURE_AIR', 5);
  const b = likeOf(behaviorProfileOf({ playerId: 'b', archetype: 'MANIAC' as never }), 'PURE_AIR', 5);
  const mat = profileMaterialityOf({
    equityA: 0.5,
    equityB: 0.5 + 1e-9,
    bluffMassA: a.likelihood,
    bluffMassB: b.likelihood,
    evA: 0,
    evB: 0,
    rangeDistance: 0,
  });
  line(`  ${mat.noteZh}`);
}
