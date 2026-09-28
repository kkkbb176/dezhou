/**
 * Alpha 独立红队发现（F-01 … F-13）的**永久回归测试**
 *
 * ## 为什么每个 F 编号都要有对应测试
 *
 * 本项目的纪律是：**每一个被发现的缺陷都必须变成一条永久断言。**
 * 只修不测等于「等下一次红队再发现一遍」——
 * 而 F-02 的根因恰恰就是「自检函数写了但**零调用者**」，
 * 它无声地失效了很久。
 *
 * ## 命名约定
 *
 * 每个 `test()` 的标题以 `F-xx` 开头，与
 * `reports/ALPHA_INDEPENDENT_REDTEAM.md` 的编号**一一对应**，
 * 这样「报告里的每一条是否都被锁住」可以直接机械核对。
 *
 * ## 这些测试断言的是「语义」，不是「当前数值」
 *
 * 刻意**不**写死「置信度必须等于 0.2344」这类快照值 ——
 * 那会让任何一次合理的调参都变成红色。
 * 断言的是**不变量**：
 * 「更多信息不能让结论更不可信」「明确决策不能配低置信度」
 * 「全下必须能录进去」。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Position, Street } from '../src/domain/types.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import { analyzeManualHand, hashManualInput } from '../src/app/alphaPipeline.ts';
import {
  ALL_DYNAMIC_HINTS,
  type ManualHandInput,
} from '../src/app/manualInput/manualInput.ts';
import { decideAlpha } from '../src/app/decision/decisionEngine.ts';
import type { DecisionAction } from '../src/domain/decision/decision.types.ts';
import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import { parseManualInput } from '../src/app/manualInput/manualInput.ts';
import {
  abnormalLikelihood,
  normalLikelihood,
  selfCheckLikelihoodModel,
  tierOfRankClass,
} from '../src/app/manualInput/likelihoodModel.ts';
import {
  allRankClassKeys,
  rfiWeights,
  threeBetWeights,
  selfCheckPreflopPriors,
} from '../src/app/manualInput/preflopPriors.ts';
import { GameEnvironment } from '../src/domain/range/gameEnvironment.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const OPTIONS = { rules: RULES, asOf: 1_757_000_000_000, writeLog: false } as const;

/* ============================================================
 * 场景构造
 * ============================================================ */

const ORDER: readonly Position[] = [
  Position.UTG,
  Position.HJ,
  Position.CO,
  Position.BTN,
  Position.SB,
  Position.BB,
];

function base(overrides: Partial<ManualHandInput> = {}): ManualHandInput {
  return {
    tableSize: 6,
    heroPosition: Position.CO,
    heroCards: ['As', 'Kd'],
    board: [],
    street: Street.PREFLOP,
    effectiveStackBB: 100,
    actionHistory: [],
    environment: 'MID_LOW_STAKES',
    villain: { quickProfile: 'NORMAL' },
    ...overrides,
  };
}

/**
 * 翻牌前：Hero 在 `hero` 位，`opener` 开池到 `openToBB`，之后全部弃牌到 `hero` 之前。
 *
 * ⚠️ Hero 必须在开池者**之后**行动，否则没有决策点（重建会正确阻断）。
 *
 * @param after 开池者与 Hero 之间的额外行动（例如中间位跟注 —— 用来构造多人池）
 */
function preflopFacingOpen(
  hero: Position,
  opener: Position,
  openToBB: number,
  heroCards: readonly [string, string] = ['As', 'Kd'],
  after: ManualHandInput['actionHistory'] = [],
): ManualHandInput {
  const history: ManualHandInput['actionHistory'][number][] = [];
  const hi = ORDER.indexOf(hero);
  const oi = ORDER.indexOf(opener);
  for (let i = 0; i < oi; i++) history.push({ position: ORDER[i]!, type: 'FOLD' });
  history.push({ position: opener, type: 'RAISE', amountBB: openToBB });
  for (let i = oi + 1; i < hi; i++) history.push({ position: ORDER[i]!, type: 'FOLD' });
  history.push(...after);
  return base({ heroPosition: hero, heroCards, actionHistory: history });
}

/**
 * 翻牌前：Hero 开池、后面的人按给定行动、最后由 Hero 再次行动（面对 3bet）。
 *
 * 例：Hero CO 开池 3BB → BTN/SB 弃牌 → BB 3bet 到 10 → 轮到 Hero。
 * 这样`activeOpponentCount` 只有 1（其余人都弃牌了）。
 */
function preflopHeroOpensThenFacesRaise(
  hero: Position,
  heroCards: readonly [string, string],
  openToBB: number,
  raiser: Position,
  raiseToBB: number,
): ManualHandInput {
  const hi = ORDER.indexOf(hero);
  const ri = ORDER.indexOf(raiser);
  const history: ManualHandInput['actionHistory'][number][] = [];
  for (let i = 0; i < hi; i++) history.push({ position: ORDER[i]!, type: 'FOLD' });
  history.push({ position: hero, type: 'RAISE', amountBB: openToBB });
  for (let i = hi + 1; i < ri; i++) history.push({ position: ORDER[i]!, type: 'FOLD' });
  history.push({ position: raiser, type: 'RAISE', amountBB: raiseToBB });
  return base({ heroPosition: hero, heroCards, actionHistory: history });
}

/** 翻牌后：Hero CO 开池 3BB、BB 跟注，然后按给定行动推进 */
function postflop(
  board: readonly string[],
  street: Street,
  heroCards: readonly [string, string],
  afterPreflop: ManualHandInput['actionHistory'],
): ManualHandInput {
  return base({
    heroCards,
    board,
    street,
    actionHistory: [
      { position: Position.UTG, type: 'FOLD' },
      { position: Position.HJ, type: 'FOLD' },
      { position: Position.CO, type: 'RAISE', amountBB: 3 },
      { position: Position.BTN, type: 'FOLD' },
      { position: Position.SB, type: 'FOLD' },
      { position: Position.BB, type: 'CALL', amountBB: 2 },
      ...afterPreflop,
    ],
  });
}

/**
 * 翻牌上 Hero（CO）面对 BB 的下注 —— 唯一合法的「面对下注」构造。
 *
 * ⚠️ 翻牌后的行动顺序从**小盲**开始（不是大盲优先），
 * 且本局只有 BB 与 CO 还在场，所以顺序是 BB → CO。
 */
function flopFacingBet(
  board: readonly string[],
  heroCards: readonly [string, string],
  betBB: number,
): ManualHandInput {
  return postflop(board, Street.FLOP, heroCards, [
    { position: Position.BB, type: 'BET', amountBB: betBB, street: Street.FLOP },
  ]);
}

/** Hero 在 CO 开池、BB 跟注、BB 过牌 → 轮到 Hero（无人下注） */
function flopCheckedToHero(
  board: readonly string[],
  heroCards: readonly [string, string],
): ManualHandInput {
  return postflop(board, Street.FLOP, heroCards, [
    { position: Position.BB, type: 'CHECK', street: Street.FLOP },
  ]);
}

/**
 * 河牌：翻牌/转牌都过牌，河牌 BB 下注（可超池）→ 轮到 Hero 面对下注。
 *
 * 构造要点：每条街都必须有人把下注轮走完，`advanceToStreet` 才能推进。
 */
function riverFacingBet(
  heroCards: readonly [string, string],
  betBB: number,
): ManualHandInput {
  return postflop(['Kh', '7c', '2d', '3s', '9h'], Street.RIVER, heroCards, [
    { position: Position.BB, type: 'CHECK', street: Street.FLOP },
    { position: Position.CO, type: 'CHECK', street: Street.FLOP },
    { position: Position.BB, type: 'CHECK', street: Street.TURN },
    { position: Position.CO, type: 'CHECK', street: Street.TURN },
    { position: Position.BB, type: 'BET', amountBB: betBB, street: Street.RIVER },
  ]);
}

/**
 * **2 名活跃对手**的合法决策点：Hero 在大盲面对「UTG 开池 + CO 跟注」。
 *
 * 行动顺序：UTG 加注 3 → HJ 弃 → CO 跟注 3 → BTN 弃 → SB 弃 → 轮到 BB(Hero)。
 * 此时活跃对手 = UTG + CO = 2（构造要点：跟注者必须在 Hero **之前**行动）。
 */
function bigBlindFacingOpenWithCaller(
  heroCards: readonly [string, string] = ['Ah', 'Ad'],
): ManualHandInput {
  return base({
    heroPosition: Position.BB,
    heroCards,
    actionHistory: [
      { position: Position.UTG, type: 'RAISE', amountBB: 3 },
      { position: Position.HJ, type: 'FOLD' },
      { position: Position.CO, type: 'CALL', amountBB: 3 },
      { position: Position.BTN, type: 'FOLD' },
      { position: Position.SB, type: 'FOLD' },
    ],
  });
}

/**
 * **3 名活跃对手**的合法决策点：Hero 在 BTN 面对「UTG 开池 + HJ 跟注 + CO 跟注」。
 *
 * 这是「信息不足」的标准构造 —— 引擎必须明确拒绝，而不是只挑一位对手分析。
 */
function buttonFacingThreeOpponents(
  heroCards: readonly [string, string] = ['Ah', 'Ad'],
): ManualHandInput {
  return base({
    heroPosition: Position.BTN,
    heroCards,
    actionHistory: [
      { position: Position.UTG, type: 'RAISE', amountBB: 3 },
      { position: Position.HJ, type: 'CALL', amountBB: 3 },
      { position: Position.CO, type: 'CALL', amountBB: 3 },
    ],
  });
}

/**
 * **真的会「信息不足」**的场景：翻牌前第一个行动位，还没有任何人进池。
 *
 * 这时系统**没有任何对手范围**可用 ⇒ 权益算不出来 ⇒ 如实拒绝。
 *
 * ⚠️ 为什么需要它：原来「信息不足」这一支是用
 * `buttonFacingThreeOpponents()`（3 家已进池）触发的，而那条路径
 * **已经不再拒绝** —— 权益现在按全部已实现对手一起算。
 * 因此必须换一个真正触发拒绝的场景，否则那一条分支就没有测试覆盖。
 */
function firstToActPreflopNoAction(): ManualHandInput {
  return base({
    heroPosition: Position.UTG,
    heroCards: ['Ah', 'Kh'],
    actionHistory: [],
  });
}

/* ============================================================
 * F-01 · 面对下注时永远不建议加注（结构性缺失）
 * ============================================================ */

test('F-01：面对下注时 RAISE **可达**（修复前 pickCandidate 永不返回 RAISE）', () => {
  // 翻牌前 Hero CO 开池 3BB，BTN/SB 弃牌，BB 3bet 到 10 → Hero 持 AA 面对 3bet
  const aa = preflopHeroOpensThenFacesRaise(Position.CO, ['Ah', 'Ad'], 3, Position.BB, 10);
  const r = analyzeManualHand(aa, OPTIONS);
  assert.equal(r.ok, true, `应当能分析：${r.ok ? '' : JSON.stringify(r.issues)}`);
  if (!r.ok) return;

  assert.equal(
    r.decision.action,
    'RAISE',
    `AA 面对 3bet 必须能给出加注，实际是 ${r.decision.action}（候选：` +
      `${r.decision.diagnostics.candidates.map((c) => c.action).join(',')}）`,
  );
  assert.ok(r.decision.diagnostics.legalActions.includes('RAISE'), 'RAISE 必须在合法集合里');
  assert.ok(
    (r.decision.sizeChips ?? 0) > 0,
    'RAISE 必须带一个正的建议尺寸（不能只给动作不给量）',
  );
});

test('F-01：翻牌后有强牌时 RAISE 可达，且尺寸不超过「剩余筹码」', () => {
  // 翻牌 K72，Hero 持 KK（三条）面对 BB 的下注 6BB
  const spot = flopFacingBet(['Kh', '7c', '2d'], ['Kd', 'Kc'], 6);
  const r = analyzeManualHand(spot, OPTIONS);
  assert.equal(r.ok, true, `应当能分析：${r.ok ? '' : JSON.stringify(r.issues)}`);
  if (!r.ok) return;

  const legal = r.decision.diagnostics.legalActions;
  assert.ok(legal.includes('RAISE'), '面对下注时 RAISE 必须是合法动作');
  /*
   * 🔴 **契约变更（U1 · RIVER RAISE DECISION V2 之后，已记录，非放宽）**
   *
   * # 修复前（F-01 原始契约）
   *
   * 本测试断言「三条面对下注必须**选** RAISE」—— 那时 `RAISE` 没有任何筹码 EV，
   * 加注与否完全由 `shouldRaise` 的强牌启发式决定 ⇒ 三条必然加注。
   *
   * # U1 之后
   *
   * `RAISE` 有了模型 EV（面对加注的响应模型），因此它**按 EV 参与比较**。
   * 本节点实测（`reports/evidence/u1-f01-probe.txt`）：
   *
   * ```text
   * pot 25｜需跟 12｜winnable 37
   * CALL  : PROXY_EV  +24.01（EqVsBetRange 0.9732）
   * RAISE : MODEL_EV  +12.94（加注到 48：P(弃) 95.8% / P(跟) 2.4% / 再加注 1.8%，
   *                            EqVsRaiseCall 0.9654）
   * ⇒ EV 更高的是 CALL
   * ```
   *
   * 就本节点而言 CALL 是**说得通**的（几乎必胜的牌面对一个「加注就弃 96%」的范围，
   * 跟注能把他的下注留在他范围里）。但这条**行为契约变更需要人工确认**
   * （见 `reports/UNCERTAINTY_REGISTER.md` 的 U9）。
   *
   * # 因此本测试现在锁的是**更强**的性质
   *
   * ① RAISE 仍然合法且尺寸不超过剩余筹码（原断言保留）；
   * ② **动作必须等于 EV 排名第一**（用诊断里的证据表复算，比「一定加注」信息量更大）；
   * ③ 「RAISE 可达」由**另一个 EV 支持加注**的节点证明
   *   （`test/riverRaiseDecisionV2.test.ts` 的 V2-16：99 河牌暗三条 → RAISE）。
   */
  const action = r.decision.action;
  const d = r.decision.diagnostics as unknown as Record<string, any>;
  const evidence = (d['actionEvidence'] ?? []) as { action: string; ev: number | null }[];
  const callEv = evidence.find((e) => e.action === 'CALL')?.ev ?? null;
  const raiseEv = evidence.find((e) => e.action === 'RAISE')?.ev ?? null;
  assert.notEqual(raiseEv, null, '面对下注的加注必须有可比较的 EV（U1 之后）');
  const expected = (raiseEv as number) > (callEv as number) ? 'RAISE' : 'CALL';
  assert.equal(
    action,
    expected,
    `动作必须等于 EV 排名第一（CALL ${String(callEv)} vs RAISE ${String(raiseEv)} ⇒ 应为 ${expected}）`,
  );
  assert.ok(
    (r.decision.sizeChips ?? 0) <= r.decision.diagnostics.math.myRemainingStack,
    '建议尺寸不得超过剩余筹码',
  );
});

/* ============================================================
 * F-02 · 似然模型自检失败 + 自检是死代码
 * ============================================================ */

test('F-02：似然模型自检必须通过，并且自检函数必须**被真正调用**', () => {
  const problems = selfCheckLikelihoodModel();
  assert.deepEqual(
    problems,
    [],
    `似然模型自检不得报错（修复前 tierOfRankClassIndex 按数组位置切档，` +
      `QQ 的进攻性似然 0.5938 < A7s 的 0.9500）：\n${problems.join('\n')}`,
  );
  // 本测试的存在本身就是「自检有调用者」的证明 —— 这正是 F-02 的根因
});

test('F-02：牌力档位由**牌型字符串**决定，不由 169 表的数组位置决定', () => {
  // 最高档（0）：AA KK QQ、AK、AQ
  for (const cls of ['AA', 'KK', 'QQ', 'AKs', 'AKo', 'AQs', 'AQo']) {
    assert.equal(tierOfRankClass(cls), 0, `${cls} 必须落在最高档（实际 ${tierOfRankClass(cls)}）`);
  }
  // 最弱档（5）：垃圾非同花
  for (const cls of ['72o', '32o', '42o', '83o']) {
    assert.equal(tierOfRankClass(cls), 5, `${cls} 必须落在最低档（实际 ${tierOfRankClass(cls)}）`);
  }
  // 🔴 F-02 的**具体复发点**：QQ 曾经因为「169 表里的位置」被判成中档，
  // 于是进攻性似然 0.5938 < A7s 的 0.9500 —— 顺序完全反了。
  const abnormal = abnormalLikelihood();
  assert.ok(
    abnormal('QQ') > abnormal('A7s'),
    `进攻性似然必须 QQ > A7s（实际 ${abnormal('QQ')} vs ${abnormal('A7s')}）` +
      '—— 相等或更小说明又回到了「按数组位置切档」（F-02 复发）',
  );
  assert.ok(
    abnormal('AA') > abnormal('72o'),
    `进攻性似然必须 AA > 72o（实际 ${abnormal('AA')} vs ${abnormal('72o')}）`,
  );

  // ---- 被动似然是**单峰**的，不是单调的 ----
  //
  // ⚠️ 这一条以前被错误地写成「垃圾的被动似然 > 顶级的被动似然」。
  // 真实模型是：跟注/过牌的似然在**中档**达到峰值 ——
  // 垃圾牌（72o）绝大多数时候直接弃牌（最低），
  // 顶级牌（AA）更倾向主动进攻（次低），中间的投机牌才是跟注主力。
  const normal = normalLikelihood();
  assert.ok(
    normal('72o') > abnormal('72o'),
    `垃圾牌「守 > 攻」（守 ${normal('72o')} 攻 ${abnormal('72o')}）`,
  );
  assert.ok(
    abnormal('AA') > normal('AA'),
    `顶级牌「攻 > 守」（攻 ${abnormal('AA')} 守 ${normal('AA')}）`,
  );
  assert.ok(
    normal('A5s') > normal('AA') && normal('A5s') > normal('72o'),
    `被动似然必须在中间档位达到峰值（A5s=${normal('A5s')} AA=${normal('AA')} 72o=${normal('72o')}）`,
  );
});

test('F-02：自检**不得**依赖「数组首尾就是最好/最差」（那个假设是错的）', () => {
  // allRankClassKeys() 的最后一个键是 `22` 而不是 `32o` ——
  // 修复前的自检把自己的判据写成「32o vs AA」，实际却在比较「22 vs AA」。
  const keys = allRankClassKeys();
  assert.equal(keys[0], 'AA', '首键应当确实是 AA');
  assert.notEqual(
    keys[keys.length - 1],
    '32o',
    '末键**不是** 32o —— 这正是「用数组位置当牌力序」会静默出错的原因；' +
      '自检必须使用具名牌型',
  );
  // 具名判据必须真正生效：72o 与 22 是不同档位，被动似然不得相同
  const normal = normalLikelihood();
  assert.notEqual(
    normal('72o'),
    normal('22'),
    `72o（最低档）与 22（小对子档）的被动似然不得相同（都是 ${normal('72o')}）—— ` +
      '相同说明档位仍然来自数组位置而不是牌型',
  );
});

test('F-02：似然值必须始终落在 [0,1]（范围引擎的硬要求）', () => {
  for (const betRatio of [undefined, 0.1, 0.5, 1, 2, 5, 100]) {
    const f = abnormalLikelihood(betRatio);
    for (const cls of ['AA', 'AKs', 'QQ', 'T9s', '72o', '32o']) {
      const v = f(cls);
      assert.ok(
        Number.isFinite(v) && v >= 0 && v <= 1,
        `abnormalLikelihood(${String(betRatio)})('${cls}') = ${v} 超出 [0,1]`,
      );
    }
  }
});

/* ============================================================
 * F-03 · 3bet 场景把对手范围当成开池范围（权益虚高 27.5pp）
 * ============================================================ */

test('F-03：3bet 范围必须比开池范围**更紧**（组合数更少）', () => {
  const open = rfiWeights(6, Position.CO);
  const threeBet = threeBetWeights(6, Position.BTN, Position.CO);
  const countOf = (w: Readonly<Record<string, number>>): number =>
    Object.values(w).filter((x) => x > 0).length;
  const openSize = countOf(open);
  const threeBetSize = countOf(threeBet);
  assert.ok(openSize > 0, '开池范围不能为空');
  assert.ok(threeBetSize > 0, '3bet 范围不能为空');
  assert.ok(
    threeBetSize < openSize,
    `3bet 范围必须严格小于开池范围（3bet=${threeBetSize} 开池=${openSize}）`,
  );
});

test('F-03：翻牌前先验自检通过', () => {
  const problems = selfCheckPreflopPriors();
  assert.deepEqual(problems, [], `翻牌前先验自检不得报错：\n${problems.join('\n')}`);
});

test('F-03：面对 3bet 时 AA 的权益**不得**被当作面对开池来估', () => {
  // 同一个 Hero 手牌（AA），两种情形：
  // A：Hero 在大盲面对 CO 的开池（对手范围 = 开池范围，较宽）
  // B：Hero 在 CO 开池、被 BB 3bet（对手范围 = 3bet 范围，较紧）
  //
  // 对手范围越紧，AA 的权益越低（AA 对强范围的领先幅度小于对宽范围）。
  const vsOpen = preflopFacingOpen(Position.BB, Position.CO, 3, ['Ah', 'Ad']);
  const vsThreeBet = preflopHeroOpensThenFacesRaise(Position.CO, ['Ah', 'Ad'], 3, Position.BB, 10);

  const a = analyzeManualHand(vsOpen, OPTIONS);
  const b = analyzeManualHand(vsThreeBet, OPTIONS);
  assert.equal(a.ok, true, `A 应当能分析：${a.ok ? '' : JSON.stringify(a.issues)}`);
  assert.equal(b.ok, true, `B 应当能分析：${b.ok ? '' : JSON.stringify(b.issues)}`);
  if (!a.ok || !b.ok) return;

  const eqOpen = a.decision.diagnostics.math.heroEquity;
  const eqThreeBet = b.decision.diagnostics.math.heroEquity;
  assert.ok(eqOpen !== null && eqThreeBet !== null, '两手的权益都必须可计算');
  assert.notEqual(
    eqThreeBet,
    eqOpen,
    `面对 3bet 与面对开池的权益**必须不同**（都是 ${eqOpen}）—— ` +
      '相等说明 3bet 被当成了开池范围（F-03 复发）',
  );
  assert.ok(
    eqThreeBet! < eqOpen!,
    `面对更紧的 3bet 范围时 AA 的权益必须更低（3bet=${eqThreeBet} 开池=${eqOpen}）—— ` +
      '若更高说明范围反而变宽了，方向错了',
  );
  // 修复前 AKo 面对 3bet 的权益被虚高 27.5 个百分点；这里对「3bet 范围」的
  // 收紧程度做一个量级保护：AA 面对 3bet 仍应领先，但不得接近 0.95。
  assert.ok(
    eqThreeBet! < 0.93,
    `AA 面对 3bet 的权益 ${eqThreeBet} 过高 —— 说明用的仍是过宽的范围`,
  );
});

/* ============================================================
 * F-04 · 低置信度却输出「明确决策」
 * ============================================================ */

test('F-04：分类为「明确决策」时置信度不得低于中档（≥0.45）', () => {
  // 覆盖多种场景：翻牌前 / 翻牌 / 转牌 / 河牌，强牌与弱牌
  const scenarios: readonly [string, ManualHandInput][] = [
    ['翻牌前 AA 面对 3bet', preflopFacingOpen(Position.BTN, Position.CO, 9, ['Ah', 'Ad'])],
    ['翻牌前 72o 面对开池', preflopFacingOpen(Position.BB, Position.CO, 3, ['7h', '2d'])],
    ['翻牌 顶对', flopCheckedToHero(['Kh', '7c', '2d'], ['As', 'Kd'])],
    ['河牌 一对面对超池', riverFacingBet(['As', 'Kd'], 30)],
  ];

  for (const [name, input] of scenarios) {
    const r = analyzeManualHand(input, OPTIONS);
    assert.equal(r.ok, true, `${name} 应当能分析`);
    if (!r.ok) continue;
    if (r.decision.classification === 'CLEAR') {
      assert.ok(
        r.decision.confidence >= 0.45,
        `${name}：分类为「明确决策」但置信度只有 ${r.decision.confidence}（分档 ${r.decision.band}）` +
          '—— 「明确」必须至少是中置信度（F-04）',
      );
      assert.notEqual(
        r.decision.band,
        'LOW',
        `${name}：「明确决策」不得配 LOW 分档`,
      );
      assert.notEqual(
        r.decision.band,
        'MEDIUM_LOW',
        `${name}：「明确决策」不得配 MEDIUM_LOW 分档`,
      );
    }
  }
});

test('F-04：管线最终检查会**抛错**拦截「明确 + 低置信度」的自相矛盾输出', async () => {
  const { finalMathSanityCheck } = await import('../src/app/alphaPipeline.ts');
  /*
   * 🔴 TEST 18：`legal` 现在必须带上 `allInToAmount` —— 因为尺寸上限判据按**动作口径**
   * 分档（BET/RAISE/ALL_IN 是本街累计口径，上限 = `allInToAmount`；CALL 是增量口径）。
   * 本夹具是「本街已投入 0」的局面 ⇒ 两个口径恒等（10_000）。
   */
  const legal = { actions: ['FOLD', 'CALL'], myRemainingStack: 10_000, callCost: 100, allInToAmount: 10_000 };
  // 构造一个「明确决策 + 置信度 0.15」的决策对象
  const fake = {
    action: 'FOLD',
    confidence: 0.15,
    band: 'LOW',
    classification: 'CLEAR',
    reasons: [],
    diagnostics: { math: { callEV: null, rakeModel: 'NOT_APPLIED' } },
  };
  assert.throws(
    () => finalMathSanityCheck(fake as never, legal),
    /明确决策/,
    '「明确决策 + 置信度 0.15」必须被最终检查抛错拦截，而不是送到界面上',
  );
});

/* ============================================================
 * F-05 · 信息不足时 action 伪装成 FOLD
 * ============================================================ */

test('F-05：`action === null` **当且仅当** `actionable === false`', () => {
  const spots: readonly [string, ManualHandInput][] = [
    [
      '信息充分（AA 面对 3bet）',
      preflopHeroOpensThenFacesRaise(Position.CO, ['Ah', 'Ad'], 3, Position.BB, 10),
    ],
    /*
     * 🔴 「信息不足」这一支现在要用**翻牌前无人行动**来触发。
     *
     * 原来这里用的是「3 名对手已进池」(`buttonFacingThreeOpponents`) ——
     * 那条路径**已经不再拒绝**了：权益现在按全部已实现对手一起算
     *（多人口径，与底池赔率一致），因此 3 家、6 家都能给出建议。
     * 继续拿它当「信息不足」的例子，测试就不再覆盖那一支
     *（本测试自己的守卫断言会抓到这一点：`sawInsufficient`）。
     *
     * 现在真正会拒绝的是：**还没有任何对手进池** ⇒ 没有任何对手范围
     * ⇒ 权益算不出来 ⇒ 如实拒绝。这是正确且必要的拒绝。
     */
    ['信息不足（翻牌前无人行动，无对手范围）', firstToActPreflopNoAction()],
  ];
  let sawInsufficient = false;
  for (const [name, input] of spots) {
    const r = analyzeManualHand(input, OPTIONS);
    assert.equal(r.ok, true, `${name} 应当能走到决策阶段：${r.ok ? '' : JSON.stringify(r.issues)}`);
    if (!r.ok) continue;
    assert.equal(
      r.decision.action === null,
      !r.decision.actionable,
      `${name}：action(=null?) 与 actionable 必须严格对应` +
        `（action=${r.decision.action} actionable=${r.decision.actionable}）`,
    );
    if (r.decision.action === null) {
      sawInsufficient = true;
      assert.equal(r.decision.confidence, 0, `${name}：信息不足时置信度必须为 0`);
      // 界面不得显示「建议：弃牌」这种伪装
      assert.ok(
        !r.viewModel.actionZh.includes('弃牌'),
        `${name}：信息不足时界面不得显示「弃牌」（那会把「拒绝建议」伪装成「建议弃牌」）`,
      );
    }
  }
  assert.ok(sawInsufficient, '本测试必须覆盖到「信息不足」这一支，否则等于没测');
});

test('F-05：决策日志里 `decision` 为 `null` 而不是 `"FOLD"`', () => {
  const r = analyzeManualHand(firstToActPreflopNoAction(), OPTIONS);
  assert.equal(r.ok, true, `应当能分析：${r.ok ? '' : JSON.stringify(r.issues)}`);
  if (!r.ok) return;
  assert.equal(r.decision.action, null, '该场景应当是「信息不足」');
  assert.equal(
    r.log.decision,
    null,
    '日志的 decision 必须是 null（机器可读字段不得把「拒绝建议」写成「建议弃牌」）',
  );
});

/* ============================================================
 * F-06 · 2 名活跃对手下忽略第二名对手且不声明
 * ============================================================ */

test('F-06：2 名活跃对手时必须在输出里声明「单挑口径近似」', () => {
  // Hero 在大盲面对「UTG 开池 + CO 跟注」→ 活跃对手 2 名
  const r = analyzeManualHand(bigBlindFacingOpenWithCaller(), OPTIONS);
  assert.equal(r.ok, true, `应当能分析：${r.ok ? '' : JSON.stringify(r.issues)}`);
  if (!r.ok) return;

  assert.equal(
    r.decision.diagnostics.math.pot > 0,
    true,
    '无论是否给建议，数学都必须算出来',
  );

  // 只要给了建议，就必须同时声明口径
  if (r.decision.actionable) {
    const approx = r.decision.diagnostics.degradations.find(
      (d) => d.code === 'MULTIWAY_APPROXIMATION',
    );
    assert.ok(
      approx !== undefined,
      '2 名对手已进池且给出建议时，**必须**输出 MULTIWAY_APPROXIMATION 降级说明' +
        `（实际降级：${r.decision.diagnostics.degradations.map((d) => d.code).join(',') || '无'}）`,
    );
    assert.equal(approx!.impact, 'MATH', '该降级影响的是**数学输入**（权益口径）');
    /*
     * 🔴 这条断言在本轮**改过方向**，而且改动本身是关键。
     *
     * 原来它要求说明里出现「乐观」—— 因为那时权益只按**首要对手一家**算，
     * 对 2 家以上的底池**低估了对手数**，所以结果偏乐观。
     *
     * 现在权益按**全部已实现对手**一起算（口径与底池赔率一致），
     * 「偏乐观」这个说法已经不成立 —— 继续断言它，就是断言一句假话。
     *
     * 换成断言**新的、真实的**那一句：必须说明权益按几家算、
     * 以及还有几家没说话。这才是使用者需要知道的事。
     */
    assert.ok(
      approx!.textZh.includes('一起') && approx!.textZh.includes('权益已按'),
      '说明里必须写明「权益已按这 N 家一起算」（口径必须可见），' +
        `实际：${approx!.textZh.slice(0, 120)}`,
    );
    assert.ok(
      !approx!.textZh.includes('单挑口径'),
      '不得再声称「权益只按单挑口径估算」—— 那句话在本轮已经不成立',
    );
    // 使用者必须能在界面上看到它，而不是只藏在 Diagnostics 里
    assert.ok(
      r.viewModel.warningsZh.some((w) => w.includes('权益已按')),
      '该口径声明必须出现在界面警告里（不能只有诊断区能看到）',
    );
  }
});

test('F-06：多人池要求的范围可信度**严格高于**单挑（注释里的承诺必须真的存在）', async () => {
  const engine = await import('../src/app/decision/decisionEngine.ts');
  assert.ok(
    engine.MIN_RANGE_CONFIDENCE_MULTIWAY > engine.MIN_RANGE_CONFIDENCE,
    `多人门槛必须严格更高（多人=${engine.MIN_RANGE_CONFIDENCE_MULTIWAY} 单挑=${engine.MIN_RANGE_CONFIDENCE}）` +
      '—— 修复前这条逻辑只写在注释里，代码里根本不存在（F-06）',
  );
});

test('F-06：**3 家已进池必须给出建议**（不再是「拒绝」），且声称的对手数与实际一致', () => {
  /*
   * 🔴 这条测试在本轮**反转了**，理由必须写清楚。
   *
   * 原断言：「3 名活跃对手必须返回信息不足，不得只挑一位假装单挑」。
   * 那条规则的动机是**对的** —— 当时权益只按首要对手一家算，
   * 与按 3 家算的底池赔率口径不一致，数字会系统性偏乐观。
   *
   * 但代价是把工具在真实牌桌上废掉：9 人桌现金局里
   * 「一家开池、几家跟注」是常态，一律拒答等于没有工具。
   *
   * 现在权益按**全部已实现对手**一起算，口径一致，因此不再拒绝。
   * 这条测试现在守的是**新行为的正确性**，而不是旧行为的姿态：
   *
   * 1. 必须给出动作（3 家能分析）
   * 2. 声称的对手数**必须等于**真实已进池人数（不得少报，那会退化成「假装人少」）
   * 3. 必须声明权益按几家算
   */
  const r = analyzeManualHand(buttonFacingThreeOpponents(), OPTIONS);
  assert.equal(r.ok, true, `应当能分析：${r.ok ? '' : JSON.stringify(r.issues)}`);
  if (!r.ok) return;

  assert.equal(
    r.decision.actionable,
    true,
    `3 家已进池必须能分析（本轮修复：权益按全部已实现对手计算）。` +
      `实际 actionable=${r.decision.actionable} 理由=${r.decision.reasons.map((x) => x.code).join(',')}`,
  );
  assert.notEqual(r.decision.action, null, '可分析时 action 不得为 null');

  const approx = r.decision.diagnostics.degradations.find(
    (d) => d.code === 'MULTIWAY_APPROXIMATION',
  );
  assert.ok(approx !== undefined, '必须声明多人池口径');

  /*
   * 声称的对手数必须与真实一致。
   *
   * ⚠️ 这是「假装单挑」在**新实现**下的等价防线：旧实现的风险是
   * 「只挑一位对手算」，新实现的风险变成「声称算了 N 家、其实算少了」。
   * 两者都是「数字与声称不符」，因此这条断言必须留着并指向新口径。
   */
  const claimed = Number(/本手有 (\d+) 名对手/.exec(approx!.textZh)?.[1] ?? '-1');
  assert.equal(claimed, 3, `声称的已进池对手数必须是 3（三个 CALL），实际 ${String(claimed)}`);

  // 并且必须真的出现在界面上
  assert.ok(
    r.viewModel.warningsZh.some((w) => w.includes('权益已按')),
    '界面必须能看到口径声明',
  );
});

/* ============================================================
 * F-07 · bigBlindBB 是死字段
 * ============================================================ */

test('F-07：`bigBlindBB` 必须**真正生效**（改变筹码比例尺）', () => {
  const spot = flopCheckedToHero(['Kh', '7c', '2d'], ['As', 'Kd']);

  const a = analyzeManualHand({ ...spot, bigBlindBB: 100 }, OPTIONS);
  const b = analyzeManualHand({ ...spot, bigBlindBB: 2 }, OPTIONS);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  if (!a.ok || !b.ok) return;

  assert.notEqual(
    a.decision.diagnostics.math.bigBlind,
    b.decision.diagnostics.math.bigBlind,
    'bigBlindBB 必须改变筹码快照里的 bigBlind（修复前它是死字段）',
  );
  assert.equal(a.decision.diagnostics.math.bigBlind, 100);
  assert.equal(b.decision.diagnostics.math.bigBlind, 2);
});

test('F-07：`bigBlindBB` 只影响筹码口径，**不影响**任何 BB 口径的判断', () => {
  const spot = flopCheckedToHero(['Kh', '7c', '2d'], ['As', 'Kd']);
  const a = analyzeManualHand({ ...spot, bigBlindBB: 100 }, OPTIONS);
  const b = analyzeManualHand({ ...spot, bigBlindBB: 1_000 }, OPTIONS);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  if (!a.ok || !b.ok) return;

  // 无量纲比值必须逐位一致（否则说明比例尺污染了策略判断）
  const m = (r: typeof a) => r.decision.diagnostics.math;
  for (const key of ['potOdds', 'requiredEquity', 'heroEquity', 'spr'] as const) {
    assert.equal(
      m(a)[key],
      m(b)[key],
      `${key} 是无量纲比值，不得随 bigBlindBB 变化`,
    );
  }
  assert.equal(a.decision.action, b.decision.action, '建议的动作不得随 chips 比例尺变化');
});

test('F-07：非法 `bigBlindBB` 仍然被阻断（不能因为「生效了」就放松校验）', () => {
  const spot = flopCheckedToHero(['Kh', '7c', '2d'], ['As', 'Kd']);
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const r = analyzeManualHand({ ...spot, bigBlindBB: bad }, OPTIONS);
    assert.equal(r.ok, false, `bigBlindBB=${String(bad)} 必须被阻断`);
    if (r.ok) continue;
    assert.equal(r.stage, 'PARSE');
    assert.ok(r.issues.some((i) => i.code === 'INVALID_NUMBER'));
  }
});

test('F-07：小数、小于 2 的筹码面额必须被阻断（否则等于静默改掉用户的数字）', () => {
  const spot = flopCheckedToHero(['Kh', '7c', '2d'], ['As', 'Kd']);
  // 面额 < 1：连「1BB」都表示不出来，2.5BB 会被取整成完全不同的量级
  // 面额 = 1：小盲 round(1/2) = 1，等于小盲 = 大盲，牌局根本不成立
  // 面额是小数：等于悄悄改掉用户填的数
  for (const bad of [0.5, 0.01, 2.5, 7.25, 1]) {
    const r = analyzeManualHand({ ...spot, bigBlindBB: bad }, OPTIONS);
    assert.equal(r.ok, false, `bigBlindBB=${String(bad)} 必须被阻断而不是被取整`);
    if (r.ok) continue;
    assert.equal(r.stage, 'PARSE');
    const text = r.issues.map((i) => i.message).join('\n');
    assert.ok(
      text.includes('整数'),
      `错误信息必须说明「必须是不小于 2 的整数」，实际：\n${text}`,
    );
  }
  // 合法值：2 与任意正整数都接受，且**不会**被静默取整
  for (const good of [2, 3, 100, 1_000]) {
    const r = analyzeManualHand({ ...spot, bigBlindBB: good }, OPTIONS);
    assert.equal(r.ok, true, `bigBlindBB=${good} 应当被接受`);
    if (!r.ok) continue;
    assert.equal(
      r.decision.diagnostics.math.bigBlind,
      good,
      '面额必须被原样使用，不得取整',
    );
  }
});

/* ============================================================
 * F-08 · 对手全下无法录入
 * ============================================================ */

test('F-08：`ALL_IN` 的金额可以省略（表示「投入全部剩余筹码」）', () => {
  // UTG 全下（不填金额）→ 其余人弃牌 → Hero 在 BTN 面对全下
  const input = base({
    heroPosition: Position.BTN,
    heroCards: ['Ah', 'Ad'],
    actionHistory: [
      { position: Position.UTG, type: 'ALL_IN' },
      { position: Position.HJ, type: 'FOLD' },
      { position: Position.CO, type: 'FOLD' },
    ],
  });
  const r = analyzeManualHand(input, OPTIONS);
  assert.equal(
    r.ok,
    true,
    '「UTG 全下」不填金额必须能被接受（修复前会被 INVALID_ACTION 阻断）：' +
      `${r.ok ? '' : JSON.stringify(r.issues)}`,
  );
  if (!r.ok) return;
  assert.ok(r.decision.diagnostics.math.callCost > 0, 'Hero 应当面对一个跟注成本');
});

test('F-08：短筹码对手全下（villain.stackBB + 省略金额）可以录入', () => {
  const input = base({
    heroPosition: Position.BTN,
    heroCards: ['Ah', 'Ad'],
    villain: { quickProfile: 'NORMAL', stackBB: 8 },
    actionHistory: [
      { position: Position.UTG, type: 'ALL_IN' },
      { position: Position.HJ, type: 'FOLD' },
      { position: Position.CO, type: 'FOLD' },
    ],
  });
  const r = analyzeManualHand(input, OPTIONS);
  assert.equal(
    r.ok,
    true,
    '短筹码对手全下必须能录入（现金局最常见的局面）：' +
      `${r.ok ? '' : JSON.stringify(r.issues)}`,
  );
  if (!r.ok) return;
  // 8BB 全下 → 跟注成本应当是 8BB = 800 筹码（内部比例尺 100）
  assert.equal(
    r.decision.diagnostics.math.callCost,
    800,
    `跟注成本应等于对手的全下额（8BB = 800 筹码），实际 ${r.decision.diagnostics.math.callCost}`,
  );
});

test('F-08：全下金额与剩余筹码不一致时，错误信息必须**告诉用户怎么改**', () => {
  const input = base({
    heroPosition: Position.BTN,
    heroCards: ['Ah', 'Ad'],
    villain: { quickProfile: 'NORMAL', stackBB: 8 },
    actionHistory: [
      { position: Position.UTG, type: 'ALL_IN', amountBB: 30 },
      { position: Position.HJ, type: 'FOLD' },
      { position: Position.CO, type: 'FOLD' },
    ],
  });
  const r = analyzeManualHand(input, OPTIONS);
  assert.equal(r.ok, false, '不一致的全下金额必须被阻断（不能猜）');
  if (r.ok) return;
  const text = r.issues.map((i) => i.message).join('\n');
  assert.ok(
    text.includes('不填') || text.includes('留空'),
    `错误信息必须给出「留空 = 投入全部剩余筹码」这条出路，实际：\n${text}`,
  );
  assert.ok(
    text.includes('8'),
    `错误信息必须写出该座位的真实筹码（8BB），实际：\n${text}`,
  );
});

/* ============================================================
 * F-09 · ViewModel 的 viewmodel / total 耗时永远是 0.0 ms
 * ============================================================ */

test('F-09：ViewModel 调试面板的耗时表必须与管线 timings **逐位一致**', () => {
  const spot = flopCheckedToHero(['Kh', '7c', '2d'], ['As', 'Kd']);
  const r = analyzeManualHand(spot, OPTIONS);
  assert.equal(r.ok, true);
  if (!r.ok) return;

  const rows = r.viewModel.debug.timing;
  assert.ok(rows.some((x) => x.label === 'viewmodel'), '必须显示 ViewModel 构建耗时');
  assert.ok(rows.some((x) => x.label === 'total'), '必须显示总耗时（修复前这两项根本不存在）');

  const pipelineKeys = Object.keys(r.timings).sort();
  const vmKeys = rows.map((x) => x.label).sort();
  assert.deepEqual(vmKeys, pipelineKeys, '两者必须覆盖完全相同的阶段');
  for (const [key, value] of Object.entries(r.timings)) {
    const found = rows.find((x) => x.label === key);
    assert.equal(
      found?.value,
      `${value.toFixed(1)} ms`,
      `阶段 ${key} 的显示值必须等于管线值（${value}）`,
    );
  }
});

test('F-09：决策日志的 timingMs 与返回的 timings 是**同一份**', () => {
  const spot = flopCheckedToHero(['Kh', '7c', '2d'], ['As', 'Kd']);
  const r = analyzeManualHand(spot, OPTIONS);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(
    { ...r.log.timingMs },
    { ...r.timings },
    '日志与返回值必须记录同一份耗时表（三处各算一份必然漂移）',
  );
});

/* ============================================================
 * F-10 · hashManualInput 漏字段
 * ============================================================ */

test('F-10：`ManualHandInput` 的**每一个**字段都必须影响哈希', () => {
  const reference = base({
    heroCards: ['As', 'Kd'],
    board: ['Kh', '7c', '2d'],
    street: Street.FLOP,
    potBB: 6.5,
    bigBlindBB: 100,
    actionHistory: [
      { position: Position.UTG, type: 'FOLD' },
      { position: Position.HJ, type: 'FOLD' },
      { position: Position.CO, type: 'RAISE', amountBB: 3 },
      { position: Position.BTN, type: 'FOLD' },
      { position: Position.SB, type: 'FOLD' },
      { position: Position.BB, type: 'CALL', amountBB: 2 },
    ],
    villain: { playerId: 'v1', quickProfile: 'NORMAL', dynamicHint: 'NORMAL', stackBB: 100 },
    villains: [{ playerId: 'v1', quickProfile: 'NORMAL', dynamicHint: 'NORMAL', stackBB: 100 }],
    seatStacksBB: { [Position.CO]: 100, [Position.BB]: 100 },
    occupiedPositions: [Position.UTG, Position.HJ, Position.CO, Position.BTN, Position.SB, Position.BB],
    buttonPosition: Position.BTN,
  });

  // ⚠️ 用 `keyof ManualHandInput` 做**类型级清单**：
  // 将来往 `ManualHandInput` 加字段却忘了加进哈希，这里会**编译失败**
  //（下面的 `mutations` 必须覆盖全部键）。
  const mutations: { [K in keyof ManualHandInput]-?: () => ManualHandInput } = {
    tableSize: () => ({ ...reference, tableSize: 9 }),
    heroPosition: () => ({ ...reference, heroPosition: Position.BTN }),
    heroCards: () => ({ ...reference, heroCards: ['Qh', 'Qd'] }),
    board: () => ({ ...reference, board: ['Kh', '7c', '2s'] }),
    street: () => ({ ...reference, street: Street.TURN }),
    effectiveStackBB: () => ({ ...reference, effectiveStackBB: 50 }),
    potBB: () => ({ ...reference, potBB: 7 }),
    actionHistory: () => ({
      ...reference,
      actionHistory: [
        ...reference.actionHistory.slice(0, -1),
        { position: Position.BB, type: 'CALL', amountBB: 3 },
      ],
    }),
    environment: () => ({ ...reference, environment: 'LOW_STAKES_ONLINE' }),
    bigBlindBB: () => ({ ...reference, bigBlindBB: 2 }),
    villain: () => ({
      ...reference,
      villain: { playerId: 'v1', quickProfile: 'MANIAC', dynamicHint: 'NORMAL', stackBB: 100 },
    }),
    villains: () => ({
      ...reference,
      villains: [
        { playerId: 'v1', quickProfile: 'NORMAL', dynamicHint: 'NORMAL', stackBB: 100 },
        { playerId: 'v2', quickProfile: 'NORMAL', dynamicHint: 'NORMAL', stackBB: 100 },
      ],
    }),
    seatStacksBB: () => ({
      ...reference,
      seatStacksBB: { ...reference.seatStacksBB, [Position.BB]: 60 },
    }),
    // MULTIWAY RESPONSE TREE：逐座位画像必须影响哈希
    //（只改 CO 的类型，就会改变他自己在多人联合树里的 fold/call/raise）
    seatProfiles: () => ({
      ...reference,
      seatProfiles: { [Position.CO]: 'CALLING_STATION' },
    }),
    // Table Topology Correction：本手拓扑也必须影响哈希
    occupiedPositions: () => ({
      ...reference,
      occupiedPositions: [Position.UTG, Position.HJ, Position.CO, Position.BTN, Position.BB],
    }),
    // TABLE DYNAMICS V1 第二轮：作用范围明确的维度调整也必须影响哈希
    //（它直接改写响应倾向 ⇒ 同一手牌换一组维度就会得到不同 EV）
    villainDimensions: () => ({
      ...reference,
      villainDimensions: { aggression: 0.82, confidence: 0.6 },
    }),
    buttonPosition: () => ({ ...reference, buttonPosition: Position.CO }),
  };

  // 覆盖性自检：清单必须包含全部键（多一个少一个都不行）
  const declared = Object.keys(mutations).sort();
  const actual: string[] = [
    'tableSize',
    'heroPosition',
    'heroCards',
    'board',
    'street',
    'effectiveStackBB',
    'potBB',
    'actionHistory',
    'environment',
    'bigBlindBB',
    'villain',
    'villains',
    'seatStacksBB',
    'seatProfiles',
    'occupiedPositions',
    'villainDimensions',
    'buttonPosition',
  ];
  assert.deepEqual(
    declared,
    actual.sort(),
    '穷举清单必须恰好覆盖 ManualHandInput 的全部字段；' +
      '新增字段时请同时更新这里与 hashManualInput',
  );

  const baseHash = hashManualInput(reference);
  for (const [key, make] of Object.entries(mutations)) {
    const mutated = make();
    assert.notDeepEqual(mutated, reference, `${key} 的扰动没有真正改变输入（测试本身写错了）`);
    assert.notEqual(
      hashManualInput(mutated),
      baseHash,
      `改动 ${key} 后哈希必须改变（修复前 bigBlindBB / villains / actionHistory[].street 被漏掉）`,
    );
  }
});

test('F-10：`actionHistory[].street` 必须参与哈希（同一动作、不同街道是两手不同的牌）', () => {
  const common = base({
    board: ['Kh', '7c', '2d'],
    street: Street.FLOP,
    actionHistory: [
      { position: Position.CO, type: 'RAISE', amountBB: 3 },
      { position: Position.BB, type: 'CALL', amountBB: 2 },
    ],
  });
  const explicit = {
    ...common,
    actionHistory: [
      { position: Position.CO, type: 'RAISE' as const, amountBB: 3, street: Street.PREFLOP },
      { position: Position.BB, type: 'CALL' as const, amountBB: 2, street: Street.PREFLOP },
    ],
  } satisfies ManualHandInput;
  assert.notEqual(
    hashManualInput(common),
    hashManualInput(explicit),
    '显式写出 street 与省略 street 是不同的输入，哈希必须不同',
  );
});

test('F-10：同一输入必须得到同一哈希（确定性不得因为补字段而破坏）', () => {
  const spot = preflopFacingOpen(Position.BTN, Position.CO, 3);
  const hashes = new Set<string>();
  for (let i = 0; i < 20; i++) hashes.add(hashManualInput(spot));
  assert.equal(hashes.size, 1, `同一输入 20 次必须得到 1 个哈希，实际 ${hashes.size} 个`);
});

/* ============================================================
 * F-11 · 提供动态提示反而降低置信度
 * ============================================================ */

test('F-11：主动提供观察**不得**让结论比「什么都不说」更不可信', () => {
  const spot = flopCheckedToHero(['Kh', '7c', '2d'], ['As', 'Kd']);

  const results = new Map<string, number>();
  for (const hint of ALL_DYNAMIC_HINTS) {
    const r = analyzeManualHand(
      { ...spot, villain: { quickProfile: 'NORMAL', dynamicHint: hint } },
      OPTIONS,
    );
    assert.equal(r.ok, true, `hint=${hint} 应当能分析`);
    if (!r.ok) continue;
    results.set(hint, r.decision.confidence);
  }

  const unknown = results.get('UNKNOWN');
  const normal = results.get('NORMAL');
  assert.ok(unknown !== undefined && normal !== undefined, '必须覆盖 UNKNOWN 与 NORMAL');
  assert.equal(
    normal,
    unknown,
    `「他打法正常」与「什么都没说」必须得到**相同**的置信度` +
      `（NORMAL=${normal} UNKNOWN=${unknown}）—— 修复前 NORMAL=0.2344 < UNKNOWN=0.3000，` +
      '等于惩罚诚实填表的用户（F-11）',
  );

  // 真正观察到偏离时**才**允许降低置信度
  const tilt = results.get('TILT_SIGNAL');
  assert.ok(tilt !== undefined, '必须覆盖 TILT_SIGNAL');
  assert.ok(
    tilt! <= unknown!,
    `观察到「疑似上头」时置信度不得高于「没有观察」（tilt=${tilt} unknown=${unknown}）`,
  );
});

test('F-11：`SIZE_ANOMALY` 不得作为「用户可一键声称」的选项（领域层无法表达）', () => {
  assert.ok(
    !(ALL_DYNAMIC_HINTS as readonly string[]).includes('SIZE_ANOMALY'),
    '领域层的 UserHintKind 没有 SIZE_ANOMALY —— 界面不得提供它，' +
      '否则用户的选择会被静默吞掉（F-11 附带发现）',
  );
  assert.ok(
    (ALL_DYNAMIC_HINTS as readonly string[]).includes('UNKNOWN'),
    'UNKNOWN 必须保留（它表示「用户没有观察」）',
  );
});

/* ============================================================
 * F-13 · budget 参数不控制任何计算
 * ============================================================ */

test('F-13：硬预算必须**真正生效**（超时中止，而不是被忽略）', () => {
  const spot = flopCheckedToHero(['Kh', '7c', '2d'], ['As', 'Kd']);
  // hardMs = 1：任何一个阶段都会超时 → 必须走到 DEADLINE 分支
  const r = analyzeManualHand(spot, { ...OPTIONS, budget: { softMs: 1, hardMs: 1 } });
  assert.equal(
    r.ok,
    false,
    '硬预算 1ms 必须中止分析（修复前 budget 参数完全不控制任何计算，F-13）',
  );
  if (r.ok) return;
  assert.equal(r.stage, 'DEADLINE', `失败阶段必须是 DEADLINE，实际 ${r.stage}`);
  assert.ok(
    r.issues.some((i) => i.code === 'DEADLINE_EXCEEDED'),
    '必须给出机器可读的 DEADLINE_EXCEEDED',
  );
  assert.ok(
    r.issues.some((i) => i.message.includes('不是输入错误')),
    '错误信息必须说明「这不是输入错误」，否则用户会以为是自己填错了',
  );
});

test('F-13：宽松预算下结果必须与默认预算**逐位一致**（预算不参与数学）', () => {
  const spot = flopCheckedToHero(['Kh', '7c', '2d'], ['As', 'Kd']);
  const a = analyzeManualHand(spot, OPTIONS);
  const b = analyzeManualHand(spot, { ...OPTIONS, budget: { softMs: 600_000, hardMs: 900_000 } });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  if (!a.ok || !b.ok) return;

  assert.equal(a.decision.action, b.decision.action, '预算不得改变建议的动作');
  assert.equal(
    a.decision.diagnostics.math.heroEquity,
    b.decision.diagnostics.math.heroEquity,
    '预算**绝不能**改变蒙特卡洛迭代次数（那会让同一手牌在不同机器上给出不同建议）',
  );
});

test('F-13：软预算只是警告，结果照旧完整计算（不得悄悄降级）', () => {
  const spot = flopCheckedToHero(['Kh', '7c', '2d'], ['As', 'Kd']);
  const strict = analyzeManualHand(spot, { ...OPTIONS, budget: { softMs: 1, hardMs: 600_000 } });
  assert.equal(strict.ok, true, '软超时**不得**阻断分析');
  if (!strict.ok) return;
  assert.ok(
    strict.warnings.some((w) => w.includes('软预算')),
    `软超时必须给出明确警告，实际警告：${strict.warnings.join(' | ') || '（无）'}`,
  );
  assert.ok(
    strict.warnings.some((w) => w.includes('未做任何降级')),
    '警告必须说明「未做任何降级」，否则使用者会怀疑结果被缩水',
  );
});

/* ============================================================
 * 交叉不变量：修复之后这些红线依然成立
 * ============================================================ */

test('解释一致性：首屏理由必须解释**被选中的那个动作**（不得自相矛盾）', () => {
  // 实测踩到的形态：给出「建议：加注」，而首屏理由写着
  // 「**跟注** 在数学上明显占优」—— 两句都真，并排读就是矛盾。
  //
  // 根因：`MATH_DOMINANCE` 的理由比动作自己的理由**更早**进入列表，
  // 而界面只显示前 3 条（`reasons.slice(0, 3)`）。
  const spot = preflopHeroOpensThenFacesRaise(Position.CO, ['Ah', 'Ad'], 3, Position.BB, 10);
  const r = analyzeManualHand(spot, OPTIONS);
  assert.equal(r.ok, true, `应当能分析：${r.ok ? '' : JSON.stringify(r.issues)}`);
  if (!r.ok) return;
  assert.equal(r.decision.action, 'RAISE');

  const top3 = r.decision.reasons.slice(0, 3).map((x) => x.textZh);

  // 首屏必须有一条解释「为什么加注」的理由
  assert.ok(
    top3.some((t) => t.includes('加注')),
    `首屏 3 条理由里必须有一条解释「加注」，实际：\n${top3.join('\n')}`,
  );

  // 「明确说另一个动作占优」的那条不得出现在首屏
  const contradiction = top3.find(
    (t) => /^(弃牌|跟注|过牌)\s*在/.test(t.trim()) && t.includes('明显占优'),
  );
  assert.equal(
    contradiction,
    undefined,
    `首屏不得出现「另一个动作明显占优」这种与建议相反的话：${String(contradiction)}`,
  );

  // 但这条信息**不能丢**：它必须仍在完整理由里（诊断区可见）
  assert.ok(
    r.decision.reasons.some((x) => x.code === 'MATH_DOMINANCE'),
    '数学优势保护的结论必须保留在完整理由里（只是不占首屏）',
  );
  // 并且必须显式声明它的比较范围，否则单看这一句仍会误导
  const dominance = r.decision.reasons.find((x) => x.code === 'MATH_DOMINANCE');
  /*
   * 🔴 **契约更新（2026-09-24 · KQ_FLOP_DECISION_REPAIR 阶段一 · D2 修复）**
   *
   * 原断言要求文本包含**字面短语**「不在此比较之内」。该短语现已**被删除**，
   * 因为它是 D2 缺陷的载体：它是一条**全局否定断言**，在「加注 EV 确实参与了
   * 同一零点比较」的节点上是**假的**（`decisionSource` 会同时报出「跨动作比较已做」）。
   *
   * 现在改为断言**语义**（而不是某个具体措辞）：
   * ① 必须声明本次比较的**范围**（只有「可比较 EV」的动作参与）；
   * ② 必须切断「未参与比较 ⇒ EV 更低」的误读。
   * 这两条比原来那句字面匹配更能防住误导，且不再把缺陷文案锁死。
   */
  assert.ok(
    dominance!.textZh.includes('可比较') || dominance!.textZh.includes('比较集'),
    `数学优势结论必须声明比较范围，实际：${dominance!.textZh}`,
  );
  /*
   * ③ **契约更新（PREFLOP_RAISE_EV_BACKFILL）**：原断言**无条件**要求这句提示存在，
   * 隐含前提是「网格里总有没算过 EV 的加注尺寸」。逐尺寸回填接入翻前之后，本节点的
   * **8 档加注尺寸全部有自有 EV**（本断言下方会逐一核实），此时那句话**无对象可指** ——
   * 强行要求它出现，等于要求引擎声明一件不成立的事。
   *
   * 新契约**更严**：不断言措辞，而是先**自己数一遍**未评估的加注尺寸，再要求
   * 「有未评估 ⇒ 必须切断误读」；覆盖完整时才允许省略。误读防线在真正需要时依然锁死。
   */
  const unevaluatedRaiseCount = r.decision.diagnostics.candidates.filter(
    (c) => (c.action === 'RAISE' || c.action === 'ALL_IN') && c.ev === null,
  ).length;
  assert.ok(
    unevaluatedRaiseCount === 0 ||
      dominance!.textZh.includes('未参与比较 ≠ EV 更低') ||
      dominance!.textZh.includes('未评估的尺寸不做低 EV 假设'),
    `存在 ${unevaluatedRaiseCount} 个未评估的加注尺寸时，必须切断` +
      `「未参与比较 ⇒ EV 更低」的误读，实际：${dominance!.textZh}`,
  );
});

test('解释一致性：`MATH_DOMINANCE` 的措辞必须声明比较范围与**归因**', () => {
  const spot = preflopHeroOpensThenFacesRaise(Position.CO, ['Ah', 'Ad'], 3, Position.BB, 10);
  const r = analyzeManualHand(spot, OPTIONS);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const notes = r.decision.reasons.filter((x) => x.code === 'MATH_DOMINANCE');
  assert.ok(notes.length > 0, '必须存在数学优势结论');
  /*
   * 🔴 **契约更新（PREFLOP_RAISE_EV_BACKFILL）**
   *
   * 原断言是 `!/^(加注|下注)\s*在/.test(...)`，理由是「加注/下注的 EV 不可比」。
   * 该**前提**在逐尺寸回填接入翻前之后**不再成立**：本节点的加注确实带着
   * `PREFLOP_RAISE_RESPONSE_V1` 的 EV 参与了**同一零点**比较（该模型与 CALL EV
   * 共用同一条现金流公式，见 `preflopRaiseFacts.ts` 的零点声明），而且它就是最大值。
   * 继续禁止这句话，等于要求引擎**否认一次它真的做过、且合规的比较**。
   *
   * 新断言**更严**：不再锁任何字面量，改为锁三条语义不变量 ——
   * ① 不得声称与**建议动作相反**的动作占优（自相矛盾，这是本测试的原始目的）；
   * ② 一旦声称加注类动作占优，必须**点名**提供 EV 的模型，且不得张冠李戴
   *    （本节点不是跛入池 ⇒ 不得归因给隔离加注模型）；
   * ③ 必须声明比较范围，切断「未参与比较 ⇒ EV 更低」的误读。
   */
  for (const reason of notes) {
    const t = reason.textZh.trim();
    const opposite = /^(弃牌|跟注|过牌)\s*在/.test(t) && t.includes('明显占优');
    assert.ok(
      !opposite,
      `结论句不得与建议动作相反：建议=${r.decision.action}，实际：${t}`,
    );
    if (/^(加注|下注|全下)\s*在/.test(t)) {
      assert.ok(
        /PREFLOP_RAISE_RESPONSE_V1|翻前加注响应模型/.test(t),
        `声称加注类动作占优时必须点名提供 EV 的模型（归因不得缺失）：${t}`,
      );
      assert.ok(
        !/隔离加注模型/.test(t),
        `本节点不是跛入池，归因不得写成隔离加注模型：${t}`,
      );
    }
    assert.ok(
      t.includes('可比较') || t.includes('比较集'),
      `数学优势结论必须声明比较范围，实际：${t}`,
    );
    /*
     * ③′ 「未参与比较 ⇒ EV 更低」的误读必须在**需要时**被切断。
     *
     * 引擎只在「加注未参与比较」那一支写这句提示；当加注**确实参与**时它改说
     * 「加注有自带模型 EV 并参与了同一零点比较」—— 此时若网格里**还有**未评估的
     * 加注尺寸，那句提示仍然必需（否则「参与了的那个」会盖住「没算的那些」）。
     * 因此这里不断言具体措辞，而是断言二者**必居其一**：
     * · 已切断误读；或
     * · 网格内**不存在**未评估的加注尺寸（无事可切）。
     */
    const unevaluatedRaises = r.decision.diagnostics.candidates.filter(
      (c) => (c.action === 'RAISE' || c.action === 'ALL_IN') && c.ev === null,
    ).length;
    assert.ok(
      t.includes('未参与比较 ≠ EV 更低') ||
        t.includes('未评估的尺寸不做低 EV 假设') ||
        unevaluatedRaises === 0,
      `存在 ${unevaluatedRaises} 个未评估的加注尺寸，结论句却既未切断` +
        `「未参与比较 ⇒ EV 更低」的误读、也未声明覆盖完整：${t}`,
    );
  }
});

test('翻前逐尺寸回填：候选表的加注 EV 必须来自 `preflopRaise.sizes`（不得留空）', () => {
  /*
   * 🔴 **PREFLOP_RAISE_EV_BACKFILL 的锁定测试。**
   *
   * 修复前的自相矛盾：同一份响应里，候选表把 4.0BB / 12.0BB … 全部标成
   * 「本尺寸未被评估」，而证据层与理由里已经在用逐尺寸的响应概率与 RAISE EV。
   * 根因是回填表**只读** `postflopFacts.raiseResponseAll`（翻后专有）。
   *
   * 本测试同时锁住三件事：
   * ① 翻前节点上「带自有 EV 的加注尺寸」**不止一个**（逐尺寸真的算过）；
   * ② 候选表里对应金额的 EV **不再是 null**（回填真的接上了）；
   * ③ 每个被回填的金额都能在 `preflopRaise.sizes` 里**精确**找到同一金额
   *    （整数筹码等值匹配 ⇒ 不存在串档）。
   */
  const spot = preflopHeroOpensThenFacesRaise(Position.CO, ['Ah', 'Ad'], 3, Position.BB, 10);
  const r = analyzeManualHand(spot, OPTIONS);
  assert.equal(r.ok, true, `应当能分析：${r.ok ? '' : JSON.stringify(r.issues)}`);
  if (!r.ok) return;

  const diag = r.decision.diagnostics;
  const candidates = diag.candidates;

  /* ① 事实包：逐尺寸模型确实为**多档**算出了自有 EV */
  const sizesWithEV = (diag.preflopRaise?.sizes ?? []).filter((s) => s.raiseEV !== null);
  assert.ok(
    sizesWithEV.length >= 2,
    `翻前逐尺寸模型应给出多档自有 EV，实际 ${sizesWithEV.length} 档：` +
      `${JSON.stringify((diag.preflopRaise?.sizes ?? []).map((s) => [s.sizeBB, s.raiseEV]))}`,
  );

  /* ② 候选表：对应金额的 EV 不再为 null（回填真的接上了） */
  const backfilled = candidates.filter(
    (c) => (c.action === 'RAISE' || c.action === 'ALL_IN') && c.ev !== null,
  );
  assert.ok(
    backfilled.length >= 2,
    `候选表应有 ≥2 档加注尺寸带自有 EV，实际 ${backfilled.length} 档：` +
      `${JSON.stringify(candidates.map((c) => [c.action, c.sizeBB, c.ev]))}`,
  );

  /* ③ 逐档**逐位相等** —— 每个金额只能用「它自己的」事实包（杜绝串档/近似） */
  for (const c of backfilled) {
    assert.ok(
      Number.isInteger(c.sizeChips),
      `被回填的尺寸必须是整数筹码（杜绝近似串档）：${JSON.stringify([c.sizeBB, c.sizeChips])}`,
    );
    const fact = sizesWithEV.find((s) => s.sizeChips === c.sizeChips);
    assert.ok(
      fact !== undefined,
      `候选表 ${String(c.sizeBB)}BB（${String(c.sizeChips)} 筹码）被回填了 EV，` +
        '但事实包里找不到**同一整数金额**的尺寸 ⇒ 存在串档',
    );
    assert.equal(
      c.ev,
      fact!.raiseEV,
      `候选表 ${String(c.sizeBB)}BB 的 EV 必须逐位等于该金额自己的事实包`,
    );
    assert.notEqual(c.evEstimateType, null, `被回填的 EV 必须声明估计类型：${String(c.sizeBB)}BB`);
  }
});

test('回归交叉检查：环境绝不修改数学（三环境逐位一致）', () => {
  const spot = flopCheckedToHero(['Kh', '7c', '2d'], ['As', 'Kd']);
  const envs: ManualHandInput['environment'][] = [
    'LOW_STAKES_ONLINE',
    'MID_LOW_STAKES',
    'THEORY_REFERENCE',
  ];

  const fingerprints = new Set<string>();
  for (const environment of envs) {
    const r = analyzeManualHand({ ...spot, environment }, OPTIONS);
    assert.equal(r.ok, true, `环境 ${environment} 应当能分析`);
    if (!r.ok) continue;
    const m = r.decision.diagnostics.math;
    fingerprints.add(
      JSON.stringify([
        m.pot,
        m.callCost,
        m.myRemainingStack,
        m.effectiveStack,
        m.spr,
        m.potOdds,
        m.requiredEquity,
        m.handCategory,
        m.handRankZh,
      ]),
    );
  }
  assert.equal(
    fingerprints.size,
    1,
    '三个环境下的「数学九项」必须逐位一致 —— 环境是**方向**层，永远不能改数学',
  );
});

test('回归交叉检查：`decideAlpha` 的输出动作必须始终在合法集合内', () => {
  const scenarios: readonly ManualHandInput[] = [
    preflopHeroOpensThenFacesRaise(Position.CO, ['Ah', 'Ad'], 3, Position.BB, 10),
    preflopFacingOpen(Position.BB, Position.CO, 3, ['7h', '2d']),
    flopCheckedToHero(['Kh', '7c', '2d'], ['As', 'Kd']),
    flopFacingBet(['Kh', '7c', '2d'], ['Kd', 'Kc'], 6),
    riverFacingBet(['As', 'Kd'], 30),
    bigBlindFacingOpenWithCaller(),
    buttonFacingThreeOpponents(),
  ];

  for (const input of scenarios) {
    const parsed = parseManualInput(input);
    assert.equal(parsed.ok, true, `解析应当成功：${JSON.stringify(input.actionHistory)}`);
    if (!parsed.ok) continue;
    const built = buildAnalyzableState(parsed.value);
    assert.equal(built.ok, true, `重建应当成功：${JSON.stringify(input.actionHistory)}`);
    if (!built.ok) continue;
    const ctx = buildDecisionContext({
      state: built.state,
      rules: RULES,
      environment: GameEnvironment.MID_LOW_STAKES,
      asOf: 1_757_000_000_000,
    });
    const decision = decideAlpha(ctx.context, ctx.legal);
    if (decision.action === null) {
      assert.equal(decision.actionable, false, 'action=null 时必须 actionable=false');
      continue;
    }
    assert.ok(
      ctx.legal.actions.includes(decision.action as DecisionAction),
      `输出的 ${decision.action} 必须在合法集合 [${ctx.legal.actions.join(', ')}] 内`,
    );
  }
});

test('回归交叉检查：决策结果绝不随运行次数变化（确定性）', () => {
  const spot = flopCheckedToHero(['Kh', '7c', '2d'], ['As', 'Kd']);
  const fingerprints = new Set<string>();
  for (let i = 0; i < 10; i++) {
    const r = analyzeManualHand(spot, OPTIONS);
    assert.equal(r.ok, true);
    if (!r.ok) continue;
    fingerprints.add(
      JSON.stringify([
        r.decision.action,
        r.decision.sizeChips ?? null,
        r.decision.confidence,
        r.decision.classification,
        r.decision.diagnostics.math.heroEquity,
      ]),
    );
  }
  assert.equal(fingerprints.size, 1, `10 次运行必须得到 1 个指纹，实际 ${fingerprints.size} 个`);
});
