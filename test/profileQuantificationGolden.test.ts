/**
 * PLAYER PROFILE QUANTIFICATION V1 —— 黄金测试 03A / 03B（规范 §十七–§二十）
 *
 * ## 固定牌局（§十七）
 *
 * ```text
 * 9-max · 100BB · 1/2
 * Hero CO  A♣J♥ 开池 2.5BB → BB 跟注
 * 翻牌 A♦8♠4♠   BB 过牌 · Hero 下注 33%（2BB）· BB 跟注
 * 转牌 2♣       BB 过牌 · Hero **过牌让牌**（check back）
 * 河牌 K♦       BB 下注 75%（7BB）→ **Hero 决策**
 * ```
 *
 * 这一手之所以是黄金夹具：转牌 Hero 让牌之后 BB 在河牌主动开火，
 * 于是节点恰好是 `previousStreetLine = TURN_CHECK_BACK` + `sizeBucket = LARGE`
 * —— 正是 §三十八 要求「必须与『跟注后 donk』不同」的那个节点。
 *
 * ## 只改画像（§十八 / §十九）
 *
 * | 案例 | 画像 | 语义 |
 * |---|---|---|
 * | 03A | `CALLING_STATION` | 被动松弱：河牌下注频率低、诈唬低、我让牌后不常开火 |
 * | 03B | `MANIAC` | 松凶过度诈唬：河牌诈唬高、错过听牌诈唬高、大注诈唬高、我让牌后开火高 |
 *
 * ## 🔴 断言纪律（§二十 / §二十二 / §四十七）
 *
 * **禁止**写死最终动作（例如「03A 必须 FOLD、03B 必须 CALL」）——
 * 那会把某一手牌的局面固化成「正确答案」。本文件断言的是
 * **单调性与实质影响**：03B 的诈唬质量必须高于 03A、权益与 EV 必须更高。
 * 两边最终动作**相同**也可以通过（§四十七），只要范围组成与权益发生了合理变化。
 *
 * ⚠️ 权益来自**蒙特卡洛**（`equitySeed 20260913`，约 6000 次）。p≈0.66 时标准误约
 * 0.6pp，因此本文件断言的是**方向**（严格大于），不断言具体数值；实测差约 2.2pp，
 * 高于该分辨率。范围/质量的断言是**精确**的（不抽样），是更强的那一层契约。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';
import { parseManualInput, ALL_QUICK_PROFILES } from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import { profileRangeDistance } from '../src/domain/player/profileRangeMetrics.ts';
import {
  ARCHETYPE_BEHAVIOR_PRIORS,
  NEUTRAL_ARCHETYPES,
  ProfileMateriality,
  behaviorProfileOf,
  profileMaterialityOf,
  selfCheckArchetypePriors,
} from '../src/domain/player/behaviorProfile.ts';
import type { ManualHandInput } from '../src/app/manualInput/manualInput.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
/*
 * 🔴 **V2 §二十六：必须显式给出宽裕的时间预算，否则本测试依赖机器负载。**
 *
 * `AnalyzeOptions.budget` 会构造真实的 `DecisionDeadline`，而 `equityPolicy`
 * 按**剩余预算**在「精确枚举」与「蒙特卡洛（迭代数可变）」之间选型。
 * 于是完整套件里（CPU 争用）它会选到更粗的估计量，
 * 03A/03B 的权益**随负载变化** —— 实测同一个文件：
 *
 * ```text
 * 单独运行：✔ §二十 通过
 * 完整套件：✖ §二十 失败
 * ```
 *
 * 这不是「画像效果」，也不是随机噪声，而是**估计量被负载切换**。
 * 给出宽裕预算后两次都走同一条（精确）路径，比较才有意义。
 * 若枚举量将来超出 `maxExactMatchups` 而回落到蒙特卡洛，
 * 报告必须给出**采样分辨率**（§二十六），不得把噪声当成画像效果。
 */
const OPTIONS = {
  rules: RULES,
  asOf: 1_757_000_000_000,
  writeLog: false,
  budget: { softMs: 120_000, hardMs: 240_000 },
} as const;

const SEATS = {
  UTG: 100, UTG1: 100, UTG2: 100, LJ: 100, HJ: 100,
  CO: 100, BTN: 100, SB: 100, BB: 100,
};

/**
 * §十七 的行动历史（逐字对应）。
 *
 * ⚠️ `CALL` 的 `amountBB` 是**增量**：大盲已投 1BB，跟到 2.5 只需再补 **1.5**。
 * 写 2.5 会被校验器以 `CALL_AMOUNT_ILLEGAL` 拒绝。
 */
const HISTORY = [
  { position: 'UTG', type: 'FOLD' },
  { position: 'UTG1', type: 'FOLD' },
  { position: 'UTG2', type: 'FOLD' },
  { position: 'LJ', type: 'FOLD' },
  { position: 'HJ', type: 'FOLD' },
  { position: 'CO', type: 'RAISE', amountBB: 2.5 },
  { position: 'BTN', type: 'FOLD' },
  { position: 'SB', type: 'FOLD' },
  { position: 'BB', type: 'CALL', amountBB: 1.5 },
  { position: 'BB', type: 'CHECK', street: 'FLOP' },
  { position: 'CO', type: 'BET', amountBB: 2, street: 'FLOP' },
  { position: 'BB', type: 'CALL', amountBB: 2, street: 'FLOP' },
  { position: 'BB', type: 'CHECK', street: 'TURN' },
  { position: 'CO', type: 'CHECK', street: 'TURN' },
  { position: 'BB', type: 'BET', amountBB: 7, street: 'RIVER' },
] as const;

/** 只把**画像**参数化；其余逐位相同（§十八 / §十九） */
function hand(quickProfile: string): ManualHandInput {
  return {
    tableSize: 9,
    heroPosition: 'CO',
    heroCards: ['Ac', 'Jh'],
    board: ['Ad', '8s', '4s', '2c', 'Kd'],
    street: 'RIVER',
    effectiveStackBB: 100,
    bigBlindBB: 2,
    seatStacksBB: { ...SEATS },
    actionHistory: [...HISTORY],
    environment: 'MID_LOW_STAKES',
    villain: { quickProfile, dynamicHint: 'UNKNOWN', stackBB: 100 },
  } as unknown as ManualHandInput;
}

type Masses = {
  valueMass?: number;
  thinValueMass?: number;
  showdownMass?: number;
  missedDrawMass?: number;
  bluffMass?: number;
  pureAirMass?: number;
};

type Measured = { equity: number; callEV: number; masses: Masses; action: string };

/**
 * 走**真实生产入口**（与界面/`/api/analyze` 同一条路）：
 * 只设置 `villain.quickProfile`，画像由 `contextBuilder` 自行派生。
 *
 * 🔴 这一点是**孤儿回归锁**：画像量化模块曾经完整、单测全绿，却
 * **没有任何生产调用者**（`behaviorProfileOf` 零调用），于是「用户选了画像
 * 却什么都不发生」。本测试只给 `quickProfile` —— 若派生被移除，两条画像
 * 会退化到同一范围，下面的单调性立刻变红。
 */
function measure(quickProfile: string): Measured {
  const input = hand(quickProfile);

  const r = analyzeManualHand(input, OPTIONS);
  assert.equal(
    r.ok,
    true,
    `固定牌局必须可分析（${quickProfile}）：${r.ok ? '' : JSON.stringify(r.issues)}`,
  );
  if (!r.ok) throw new Error('unreachable');

  const parsed = parseManualInput(input);
  assert.equal(parsed.ok, true, '固定牌局必须通过解析');
  if (!parsed.ok) throw new Error('unreachable');
  const gate = buildAnalyzableState(parsed.value);
  assert.equal(gate.ok, true, '固定牌局必须通过状态重建');
  if (!gate.ok) throw new Error('unreachable');

  const built = buildDecisionContext({
    state: gate.state,
    rules: RULES,
    environment: 'MID_LOW_STAKES',
    asOf: 1_757_000_000_000,
    quickProfile: quickProfile as never,
  });
  const facts = built.context.postflopFacts?.opponentRangeFacts as unknown as
    | { profileClassMasses?: Masses }
    | undefined;

  return {
    equity: r.decision.diagnostics.math.heroEquity ?? 0,
    callEV: r.decision.diagnostics.math.callEV ?? 0,
    masses: facts?.profileClassMasses ?? {},
    action: String(r.decision.action),
  };
}

/* ============================================================
 * §二十：四条单调性（**不写死动作**）
 * ============================================================ */

test('§二十 03A vs 03B：诈唬质量、错过听牌质量、权益与 EV 必须单调', () => {
  const a = measure('CALLING_STATION'); // 03A 被动松弱
  const b = measure('MANIAC'); // 03B 松凶过度诈唬

  const fmt = (x: number | undefined): string => (x === undefined ? '—' : x.toFixed(4));

  // ---- 1/2. 范围组成：这两条是**精确**的（概率质量，不抽样），是最强的契约 ----
  assert.ok(
    b.masses.bluffMass !== undefined && a.masses.bluffMass !== undefined,
    '必须拿到 range 质量结构（§十四）',
  );
  assert.ok(
    b.masses.bluffMass! > a.masses.bluffMass!,
    `03B 的诈唬质量必须高于 03A：${fmt(b.masses.bluffMass)} vs ${fmt(a.masses.bluffMass)}`,
  );
  assert.ok(
    b.masses.missedDrawMass! > a.masses.missedDrawMass!,
    `03B 的**错过听牌**诈唬质量必须高于 03A：${fmt(b.masses.missedDrawMass)} vs ${fmt(a.masses.missedDrawMass)}`,
  );

  // ---- 3/4. 权益与 EV：方向必须一致（§二十） ----
  //
  // 语义检查：面对一个拿错过听牌开火的松凶，Hero 的顶对应该赢更多；
  // 面对一个河牌只下价值的被动玩家，应该赢更少。
  assert.ok(
    b.equity > a.equity,
    `03B 的 Hero 权益必须高于 03A（面对过度诈唬者，顶对赢更多）：` +
      `${(b.equity * 100).toFixed(2)}% vs ${(a.equity * 100).toFixed(2)}%`,
  );
  assert.ok(
    b.callEV > a.callEV,
    `03B 的跟注 EV 必须高于 03A：${b.callEV.toFixed(2)} vs ${a.callEV.toFixed(2)}`,
  );

  // ---- 实质影响（§二十一），而不仅仅是「方向对、幅度可忽略」 ----
  const materiality = profileMaterialityOf({
    equityA: a.equity,
    equityB: b.equity,
    bluffMassA: a.masses.bluffMass!,
    bluffMassB: b.masses.bluffMass!,
    evA: a.callEV,
    evB: b.callEV,
    rangeDistance: Math.abs(b.masses.bluffMass! - a.masses.bluffMass!),
  });
  assert.notEqual(
    materiality.verdict,
    ProfileMateriality.NO_EFFECT,
    `两个极端画像不得「几乎无影响」（PLAYER_PROFILE_RANGE_INFLUENCE_TOO_WEAK 的形态）：${materiality.noteZh}`,
  );
  /*
   * 🔴 **§二十一 只要求「检测并记录」，不要求达到某个档位**（原文：
   * 「不要马上设置永久硬阈值……阈值先放配置或标成实验性」），而 §二十二 明确
   * **禁止为了跨动作阈值而改参数**。因此这里**不得**断言 `MATERIAL` ——
   * 那等于把一个实验性阈值变成硬契约，并制造「调参数直到过线」的动机。
   *
   * 本测试断言的是规范真正要求的两件事：
   * 1. 物性**被判定了**且**不是 NO_EFFECT**（两个极端画像不得等于毫无影响）；
   * 2. 四项度量被**如实记录**（equityDelta / bluffMassDelta / rangeDistance / evDelta），
   *    供报告与 debug 区审计。
   *
   * ⚠️ **实测档位是 `TRIVIAL`（权益差约 0.79pp、诈唬质量差约 1.95pp）**，
   * 已如实写入 `reports/PLAYER_PROFILE_QUANTIFICATION_V1_REPORT.md` 的
   * Known Limitations，**不得**在报告里粉饰成 MATERIAL。
   */
  assert.notEqual(
    materiality.verdict,
    ProfileMateriality.NO_EFFECT,
    `两个极端画像不得等于「毫无影响」：${materiality.noteZh}`,
  );
  assert.ok(
    materiality.equityDelta !== null && Number.isFinite(materiality.equityDelta),
    `权益差必须被记录：${materiality.noteZh}`,
  );
  assert.ok(
    Number.isFinite(materiality.bluffMassDelta) && Number.isFinite(materiality.rangeDistance),
    `诈唬质量差与范围距离必须被记录：${materiality.noteZh}`,
  );

  // §四十七：两边最终动作**允许相同** —— 只记录，不断言（禁止写死动作）
  // 断言动作会把这手牌固化成「正确答案」（§二十）。
  assert.ok(
    a.action.length > 0 && b.action.length > 0,
    '两个案例都必须给出动作（动作内容本身不断言）',
  );

  /*
   * 🔴 **§二十三 `profileRangeDistance`：两个画像的后验分布必须真的分开。**
   *
   * 用**互不重叠**的 5 个分量构成分布（value 已含 thin，必须减掉，
   * 否则同一个质量被数两次，距离会失真）：
   *
   * ```text
   * [ 坚果+强价值, 薄价值, 摊牌价值, 错过听牌, 纯空气 ]   （合计 ≈ 1）
   * ```
   *
   * **§四十二 变异 A 的靶子**：把 03A/03B 设成同一个画像 ⇒ 两侧分布相同
   * ⇒ 距离为 0 ⇒ 这条断言变红（见报告中的变异输出）。
   */
  const dist = (m: typeof a.masses): number[] => [
    (m.valueMass ?? 0) - (m.thinValueMass ?? 0),
    m.thinValueMass ?? 0,
    m.showdownMass ?? 0,
    m.missedDrawMass ?? 0,
    m.pureAirMass ?? 0,
  ];
  const distance = profileRangeDistance(dist(a.masses), dist(b.masses));
  assert.ok(distance !== null, '必须能算出两个后验分布的距离');
  assert.ok(
    distance.totalVariation > 0.02,
    `两个极端画像的后验分布必须有实质距离（全变差 > 0.02）：${distance.totalVariation.toFixed(4)}`,
  );
  assert.ok(
    distance.jsDivergence > 0.002,
    `JS 散度必须明显非零：${distance.jsDivergence.toFixed(6)}`,
  );
});

/* ============================================================
 * §三十八 + §八：节点必须是「我 turn check-back 后他 probe / 大注」
 * ============================================================ */

test('§八/§三十八 黄金夹具的节点必须是 TURN_CHECK_BACK + LARGE（画像似然真的生效）', () => {
  const parsed = parseManualInput(hand('MANIAC'));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const gate = buildAnalyzableState(parsed.value);
  assert.equal(gate.ok, true);
  if (!gate.ok) return;

  const built = buildDecisionContext({
    state: gate.state,
    rules: RULES,
    environment: 'MID_LOW_STAKES',
    asOf: 1_757_000_000_000,
    quickProfile: 'MANIAC',
  });

  const trace = built.context.range?.updateTrace ?? [];
  const river = trace.find((t) => t.street === 'RIVER' && t.action.includes('BET'));
  assert.ok(river !== undefined, '河牌下注必须出现在范围更新日志里（否则该动作没进似然通道）');

  const note = (river as unknown as { noteZh?: string }).noteZh ?? '';
  assert.ok(
    note.includes('TURN_CHECK_BACK'),
    `节点必须识别出「我让牌后他开火」这一条前序线，实际日志：${note}`,
  );
  assert.ok(note.includes('LARGE'), `75% 池必须归入 LARGE 尺寸档，实际日志：${note}`);
  assert.ok(
    // ⚠️ 断言的是**行为**（画像真的接管了这条动作的似然、并抑制了倾斜通道），
    // 不是某一版文案。此前写死「取代倾斜通道」四个字，在实现改为「调制档位似然」
    // 后立刻假红 —— 那是一句措辞，不是契约。
    note.includes('抑制 adjustmentProvider'),
    `河牌下注必须由画像似然驱动（而非旧的倾斜通道），实际日志：${note}`,
  );
});

/* ============================================================
 * §二十五 / §二十四：未知玩家必须安全 —— 不得被套上原型
 * ============================================================ */

test('§二十五 未知玩家不得与前两个画像产生同样强的调整（不替陌生人套原型）', () => {
  const a = measure('CALLING_STATION');
  const b = measure('MANIAC');
  const unknown = measure('UNKNOWN');

  /*
   * UNKNOWN **刻意不派生**画像（见 `contextBuilder` 的说明：替陌生人推一个
   * 纯池先验画像就是编造数据）。因此它必须与两个已画像案例都**不同** ——
   * 若它恰好落在两者之间或与某一个相同，说明画像没有真正生效、或 UNKNOWN
   * 被套上了原型。
   */
  assert.ok(
    unknown.equity !== a.equity && unknown.equity !== b.equity,
    `UNKNOWN 必须与两个已画像案例都不同：unknown ${(unknown.equity * 100).toFixed(2)}%` +
      ` vs A ${(a.equity * 100).toFixed(2)}% / B ${(b.equity * 100).toFixed(2)}%`,
  );
});

/* ============================================================
 * 🔴 标签先验覆盖锁（防止标签再次**静默失效**）
 * ============================================================ */

test('🔴 覆盖锁：每一个 QuickProfile 都必须「有先验」或「显式声明中性」', () => {
  /*
   * ## 修的是什么
   *
   * `ARCHETYPE_BEHAVIOR_PRIORS` 原先只有 4 个条目
   * （`CALLING_STATION` / `MANIAC` / `LOOSE` / `VERY_TIGHT`），
   * 其余 7 个标签回落到 `ENVIRONMENT_BEHAVIOR_PRIOR`，而那里的
   * 乘数 `(0.5+rate)/(0.5+envPrior)` **恒等于 1.000** ——
   * 标签被选中、被记录，然后**什么都不发生**。
   *
   * 致命之处在于：`BLUFF_HEAVY` / `UNDERBLUFFER`（§十八/§十九 那两个
   * 战术标签）**恰好**落在死区里。用户在界面上认真选了「过度诈唬」，
   * 系统收到的是一个中性画像。这是**静默**失效，原先没有任何测试看得见
   * —— 既有的 §35 用例只用了 `CALLING_STATION` 与 `MANIAC`
   * （两个恰好都有先验的极端），所以它一直全绿。
   *
   * ## 断言的是**枚举本身**
   *
   * `ALL_QUICK_PROFILES` 来自 `QuickProfile` 的 `Object.values`，
   * 因此将来**新增一个标签**会被这条锁立刻拦下，除非作者显式选择
   * 「给先验」或「声明中性并写明理由」。
   */
  const problems = selfCheckArchetypePriors(ALL_QUICK_PROFILES);
  assert.deepEqual(problems, [], `标签先验覆盖不完整：\n${problems.join('\n')}`);

  for (const archetype of ALL_QUICK_PROFILES) {
    const hasPrior = Object.prototype.hasOwnProperty.call(ARCHETYPE_BEHAVIOR_PRIORS, archetype);
    const neutral = Object.prototype.hasOwnProperty.call(NEUTRAL_ARCHETYPES, archetype);
    assert.ok(
      hasPrior || neutral,
      `标签「${archetype}」既没有先验也没有中性声明 —— 会静默失效`,
    );
  }

  // 中性声明必须带**理由**（空字符串不算）
  for (const [archetype, reason] of Object.entries(NEUTRAL_ARCHETYPES)) {
    assert.ok(
      typeof reason === 'string' && reason.trim().length >= 4,
      `中性标签「${archetype}」必须写明理由，实际「${String(reason)}」`,
    );
  }
});

test('🔴 画像不得假装确定：无先验的中性标签必须自报家门', () => {
  /*
   * `isUnknownPlayer` 只回答「有没有给标签」。给了 `NORMAL` 却与
   * 「什么都没给」**行为完全一致**时，界面若据此写「画像已生效」
   * 就是假装确定（§二十五）。
   * `archetypePriorAvailable` / `priorNoteZh` 让这个区别**可读**。
   */
  const maniac = behaviorProfileOf({ playerId: 'BB', archetype: 'MANIAC' });
  assert.equal(maniac.archetypePriorAvailable, true, 'MANIAC 必须有先验');
  assert.ok(maniac.priorNoteZh.includes('提供行为先验'), maniac.priorNoteZh);

  const bluffHeavy = behaviorProfileOf({ playerId: 'BB', archetype: 'BLUFF_HEAVY' });
  assert.equal(
    bluffHeavy.archetypePriorAvailable,
    true,
    'BLUFF_HEAVY 必须有先验（§十九 的战术标签，曾经的静默死区）',
  );

  const normal = behaviorProfileOf({ playerId: 'BB', archetype: 'NORMAL' });
  assert.equal(normal.archetypePriorAvailable, false, 'NORMAL 刻意中性');
  assert.ok(
    normal.priorNoteZh.includes('刻意中性'),
    `中性标签必须自报家门，实际：${normal.priorNoteZh}`,
  );
  assert.equal(
    normal.isUnknownPlayer,
    false,
    'isUnknownPlayer 语义**保持不变**：标签确实给了（只是先验中性）',
  );

  const none = behaviorProfileOf({ playerId: 'BB', archetype: null });
  assert.equal(none.isUnknownPlayer, true, '没有标签 ⇒ 未知玩家（语义不变）');
});
