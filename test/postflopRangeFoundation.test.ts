/**
 * 翻后基础层回归锁（2026-09 翻后升级 · P0）
 *
 * 这一组锁的是**三个在审计中确认的 CRITICAL 基础缺陷**的修复。
 * 上层所有翻后逻辑（相对牌力 / Board Delta / 范围压缩 / 价值守门器）
 * 都建立在这三件事之上，因此它们必须独立可验证。
 *
 * | 缺陷 | 修复前实测 | 本文件 |
 * |---|---|---|
 * | **C1** 跛入池：翻后的下注被当成翻前开池 | BB 下注 ⇒ `CONTEXT_BUILD_FAILED` **整条分析失败**；CO 下注 ⇒ 静默套上「CO 开池范围」 | C1-A / C1-B |
 * | **C2** 跟注与过牌在似然上完全同义 | 「翻/转都跟注」与「翻/转都过牌」范围**逐位相同**（TV=0、KL=0） | C2-1 / C2-2 |
 * | **C3** 范围不随牌面变化 | 同花完成面上 ♣♣ 组合概率比 = 1.000000000（`p(A♣Q♣)=p(A♠Q♠)`） | C3-1 / C3-2 |
 *
 * ⚠️ 断言的是**性质与方向**（谁比谁更强 / 两者必须不同），不是某个魔法数字 ——
 * 因此它们不会把当前的启发式数值固化成「正确答案」。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';
import { parseManualInput } from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import {
  boardRelativeTierOf,
  boardRelativeTierOfShape,
} from '../src/domain/poker/boardRelativeStrength.ts';
import {
  likelihoodWeights,
  tierWeightOf,
  callLikelihood,
  checkLikelihood,
} from '../src/app/manualInput/likelihoodModel.ts';
import { C } from './helpers.ts';
import type { ManualHandInput } from '../src/app/manualInput/manualInput.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const OPTIONS = { rules: RULES, asOf: 1_757_000_000_000, writeLog: false } as const;
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

const F = (position: string) => ({ position, type: 'FOLD' as const });

/* ============================================================
 * C1：跛入池（翻前无人加注）—— 翻后动作不得被当成翻前开池
 * ============================================================ */

/** 跛入池：UTG 跟注、CO 跟注、BB 过牌 → 翻牌由 `flopBettor` 下注，Hero 面对下注 */
function limpedPot(flopBettor: 'BB' | 'CO', heroPosition: 'CO' | 'BB'): ManualHandInput {
  return {
    tableSize: 9,
    heroPosition,
    heroCards: ['As', 'Js'],
    board: ['Jd', '9c', '6c'],
    street: 'FLOP',
    effectiveStackBB: 100,
    seatStacksBB: { UTG: 100, CO: 100, BB: 100 },
    actionHistory: [
      { position: 'UTG', type: 'CALL', amountBB: 1 },
      F('UTG1'), F('UTG2'), F('LJ'), F('HJ'),
      { position: 'CO', type: 'CALL', amountBB: 1 },
      F('BTN'), F('SB'),
      { position: 'BB', type: 'CHECK' },
      ...(flopBettor === 'BB'
        ? [{ position: 'BB', type: 'BET', amountBB: 3, street: 'FLOP' }, { position: 'UTG', type: 'FOLD', street: 'FLOP' }]
        : [{ position: 'BB', type: 'CHECK', street: 'FLOP' }, { position: 'UTG', type: 'FOLD', street: 'FLOP' }, { position: 'CO', type: 'BET', amountBB: 3, street: 'FLOP' }]),
    ],
    environment: 'MID_LOW_STAKES',
    villain: { quickProfile: 'NORMAL', dynamicHint: 'UNKNOWN' },
  } as unknown as ManualHandInput;
}

function contextOf(input: ManualHandInput) {
  const parsed = parseManualInput(input);
  assert.equal(parsed.ok, true, '解析必须成功');
  if (!parsed.ok) throw new Error('unreachable');
  const gate = buildAnalyzableState(parsed.value);
  assert.equal(gate.ok, true, `门槛必须放行：${gate.ok ? '' : JSON.stringify(gate.issues)}`);
  if (!gate.ok) throw new Error('unreachable');
  return buildDecisionContext({
    state: gate.state,
    rules: RULES,
    environment: 'MID_LOW_STAKES',
    asOf: 1_757_000_000_000,
  }).context;
}

test('C1-A：跛入池 + BB 在翻牌下注 ⇒ 必须能分析（修复前整条 CONTEXT_BUILD_FAILED）', () => {
  /*
   * 修复前：`firstAggressionOf` 把翻牌的 BET 当成「全场第一个加注」，
   * 于是走「开池范围」分支并调用 `rfiWeightsByHandedness('BB')` ——
   * 大盲没有开池范围，函数**抛错**，整条分析以 `CONTEXT_BUILD_FAILED` 结束。
   */
  const result = analyzeManualHand(limpedPot('BB', 'CO'), OPTIONS);
  assert.equal(
    result.ok,
    true,
    `跛入池必须能分析（修复前抛 rfiTierByPositionName: BB 没有开池范围）：${
      result.ok ? '' : JSON.stringify(result.issues)
    }`,
  );
  if (!result.ok) return;
  assert.notEqual(result.decision.action, null, '必须给出方向');
});

test('C1-B：跛入池里翻牌下注者拿到的必须是**被动进入的宽范围**，不是翻前开池范围', () => {
  /*
   * 修复前：CO 在翻牌下注 ⇒ 静默套上「CO 的开池范围」。
   * 判据用**范围宽度**（开池范围明显更窄），而不是文案比对 ——
   * 文案可以改，宽度不会撒谎。
   */
  const limped = contextOf(limpedPot('CO', 'BB')).range!;
  const openContext = contextOf({
    tableSize: 9,
    heroPosition: 'BB',
    heroCards: ['As', 'Js'],
    board: [],
    street: 'PREFLOP',
    effectiveStackBB: 100,
    actionHistory: [
      F('UTG'), F('UTG1'), F('UTG2'), F('LJ'), F('HJ'),
      { position: 'CO', type: 'RAISE', amountBB: 3 },
      F('BTN'), F('SB'),
    ],
    environment: 'MID_LOW_STAKES',
    villain: { quickProfile: 'NORMAL', dynamicHint: 'UNKNOWN' },
  } as unknown as ManualHandInput).range!;

  assert.ok(
    limped.supportShare > openContext.supportShare,
    `跛入者的范围必须比开池范围宽：跛入 ${(limped.supportShare * 100).toFixed(1)}% ` +
      `vs 开池 ${(openContext.supportShare * 100).toFixed(1)}%`,
  );
});

/* ============================================================
 * C2：跟注 ≠ 过牌
 * ============================================================ */

/** 对手 BTN、Hero BB；三条线的差别只在「对手翻/转做了什么」 */
function lineOf(
  villainActs: readonly ('CHECK' | 'BET' | 'CALL')[],
  heroBets: boolean,
  sizes: readonly [number, number] = [3, 7],
): ManualHandInput {
  const actions: Record<string, unknown>[] = [
    F('UTG'), F('HJ'), F('CO'),
    { position: 'BTN', type: 'RAISE', amountBB: 3 },
    F('SB'),
    { position: 'BB', type: 'CALL', amountBB: 2 },
  ];
  /*
   * 每条街都必须**走完**（否则行动历史到不了下一街）：
   *   Hero 下注线：BB BET → BTN CALL            （街结束）
   *   对手过牌线：BB CHECK → BTN CHECK          （街结束）
   *   对手下注线：BB CHECK → BTN BET → BB CALL  （街结束）
   */
  for (const [index, street] of ['FLOP', 'TURN'].entries()) {
    const size = sizes[index]!;
    if (heroBets) {
      actions.push({ position: 'BB', type: 'BET', amountBB: size, street });
      actions.push({ position: 'BTN', type: 'CALL', amountBB: size, street });
      continue;
    }
    actions.push({ position: 'BB', type: 'CHECK', street });
    if (villainActs[index] === 'CHECK') {
      actions.push({ position: 'BTN', type: 'CHECK', street });
    } else {
      actions.push({ position: 'BTN', type: 'BET', amountBB: size, street });
      actions.push({ position: 'BB', type: 'CALL', amountBB: size, street });
    }
  }
  return {
    tableSize: 6,
    heroPosition: 'BB',
    heroCards: ['7d', '6d'],
    board: ['9c', '7c', '2d', 'Th', '3h'],
    street: 'RIVER',
    effectiveStackBB: 100,
    seatStacksBB: { BTN: 100, BB: 100 },
    actionHistory: actions,
    environment: 'MID_LOW_STAKES',
    villain: { quickProfile: 'NORMAL', dynamicHint: 'UNKNOWN' },
  } as unknown as ManualHandInput;
}

const metricsOf = (input: ManualHandInput): { entropy: number; top: number } => {
  const range = contextOf(input).range!;
  const m = range.metrics;
  return { entropy: m.entropyBits, top: m.topProbability };
};

test('C2-1：🔴「对手连跟两街」与「对手连续过牌」必须给出**不同**的范围（修复前逐位相同）', () => {
  const called = metricsOf(lineOf(['CALL', 'CALL'], true));
  const checked = metricsOf(lineOf(['CHECK', 'CHECK'], false));

  assert.notEqual(
    called.entropy,
    checked.entropy,
    `跟注两街与过牌两街的范围不得相同（修复前 TV=0、KL=0）：${called.entropy} vs ${checked.entropy}`,
  );
  assert.ok(
    called.top > checked.top,
    '跟注两街之后范围必须更集中于强牌（最高组合概率更高）：' +
      `${called.top.toFixed(6)} vs ${checked.top.toFixed(6)}`,
  );
});

test('C2-2：跟注的压缩必须**随注额增大**（方向单调，不伪造精确值）', () => {
  /*
   * 同一局面，只改**翻后**的下注尺寸：小注 vs 大注。对手都跟注
   * ⇒ 跟得越大，他的范围越强。
   *
   * ⚠️ 只改翻后的金额，翻前那条「BB CALL 2」必须保持 ——
   * 否则会被规则以 `CALL_AMOUNT_ILLEGAL` 拒绝（第一版就踩了这个坑）。
   */
  const small = metricsOf(lineOf(['CALL', 'CALL'], true, [1, 1]));
  const large = metricsOf(lineOf(['CALL', 'CALL'], true, [6, 12]));

  assert.notEqual(small.top, large.top, '跟注额不同必须产生不同的范围压缩');
  assert.ok(
    large.top >= small.top,
    `跟得越大范围应越集中：大注 ${large.top.toFixed(6)} vs 小注 ${small.top.toFixed(6)}`,
  );
});

/* ============================================================
 * C3：范围必须随**牌面**变化
 * ============================================================ */

test('C3-1：🔴 同一个**牌型类**（同点数、只差花色）在完成同花的牌面上必须得到更高档位', () => {
  /*
   * ## 这条才是 C3 的判别性断言
   *
   * 修复前范围只按**翻前牌型类**加权 ⇒ 同一个类里的组合权重**完全相同**
   * （独立复算：同花完成面上 38 个同花类的 `p(♣♣)/p(其它花色)` 精确 = 1.000000000）。
   * 因此判据必须是：**同点数、只差花色**的两手牌，牌面相对档位**必须不同**。
   *
   * ⚠️ 我第一版写的是「权益随牌面变化」—— 那条**不判别**：
   * 权益本来就随牌面变化（成手强度变了），把范围模型退回「不看牌面」后它仍然通过。
   * 变异测试当场抓住了这个错误，现在改成下面这条。
   */
  const board = C('9c 7c 2d 3c'); // 四张♣

  const clubAK = boardRelativeTierOf(C('Ac Kc'), board)!; // 六张♣ ⇒ 已成同花
  const spadeAK = boardRelativeTierOf(C('As Ks'), board)!; // 无♣ ⇒ 只有 A 高
  assert.ok(
    clubAK < spadeAK,
    `同点数只差花色必须给出不同档位：A♣K♣=${clubAK} 必须强于 A♠K♠=${spadeAK}`,
  );

  // 对照：没有同花可能的牌面上，同点数不同花色必须**同档**
  const dry = C('9h 7s 2d 3h');
  assert.equal(
    boardRelativeTierOf(C('Ac Kc'), dry),
    boardRelativeTierOf(C('As Ks'), dry),
    '没有同花可能时，同点数不同花色必须得到相同档位',
  );
});

test('C3-3：范围更新路径必须**真的**用牌面档位（接线锁）', () => {
  /*
   * 为什么需要一条静态锁：
   * 「档位函数是牌面相关的」（C3-1/C3-2）与「更新路径用了它」是两件事 ——
   * 把调用点退回 `tierOfRankClass` 之后，上面的单元断言**依然全绿**
   *（实测：变异后 C3-1 的旧版本通过）。
   * 与项目既有接线锁同一手法（`GTO-UI-24`、`interactiveTableRedteam` 的源码断言）。
   */
  const source = readFileSync(join(REPO_ROOT, 'src', 'app', 'manualInput', 'contextBuilder.ts'), 'utf8');
  const start = source.indexOf('function applyLikelihoodUpdates');
  assert.ok(start > 0, '必须能找到范围更新函数');
  const body = source.slice(start, source.indexOf('const result = updateRange', start));

  assert.match(body, /boardRelativeTierOf/, '范围更新必须调用牌面相对档位');
  assert.match(body, /boardAtAction/, '必须用「该行动当时」的公共牌，而不是最终牌面');
  /*
   * 公共牌前缀的截取逻辑（翻牌 3 / 转牌 4 / 河牌 5）在 2026-09 的 P0 修复里
   * 被**抽成单一事实来源** `boardAtStreetOf`（画像的弱牌判据也要用它，
   * 两处各写一份 `slice` 迟早漂移）。因此锁点从「函数体内出现三元表达式」
   * 改为「函数体调用该 helper」+「helper 本身按街道截取」——
   * 锁的是**更强**的性质：全项目只有一处截取逻辑。
   */
  assert.match(body, /boardAtStreetOf\(state, record\.street\)/, '必须经统一的牌面前缀函数取「当时」的公共牌');
  assert.match(
    source,
    /function boardAtStreetOf[\s\S]{0,400}?Street\.FLOP \? 3[\s\S]{0,200}?Street\.TURN \? 4[\s\S]{0,200}?Street\.RIVER \? 5/,
    '公共牌前缀必须按街道截取（翻牌 3 / 转牌 4 / 河牌 5），且只有一处实现',
  );
});

test('C3-2：牌面相对强度的映射必须覆盖全部形态，且牌面不足 3 张时返回 null', () => {
  // 直觉顺序：坚果级 < 强成手 < 强价值 < 中等 < 边缘 < 无对
  assert.ok(boardRelativeTierOfShape('QUADS') < boardRelativeTierOfShape('FLUSH'));
  assert.ok(boardRelativeTierOfShape('FLUSH') < boardRelativeTierOfShape('TWO_PAIR'));
  assert.ok(boardRelativeTierOfShape('TOP_TWO_PAIR') < boardRelativeTierOfShape('MIDDLE_PAIR'));
  assert.ok(boardRelativeTierOfShape('MIDDLE_PAIR') < boardRelativeTierOfShape('BOTTOM_PAIR'));
  assert.ok(boardRelativeTierOfShape('UNDERPAIR') < boardRelativeTierOfShape('HIGH_CARD'));

  // 牌面不足 3 张 ⇒ 必须返回 null（调用方回落翻前档，保证翻前逐位不变）
  assert.equal(boardRelativeTierOf(C('Ac Kc'), []), null, '翻前必须返回 null');
  assert.equal(
    boardRelativeTierOf(C('Ac Qc'), C('Qd Jh 2s')),
    2,
    'AQ 在 Q-J-2 上是顶对（属于「强价值」档）',
  );
  assert.equal(
    boardRelativeTierOf(C('Ac Kc'), C('Qd Jh 2s')),
    5,
    'AK 在 Q-J-2 上只有 A 高（无对 ⇒ 垃圾档）',
  );

  // 同一手牌在不同牌面上必须得到**不同**的档位（这就是「相对」的含义）
  const onFlushBoard = boardRelativeTierOf(C('Ac Qc'), C('Kc 9c 2c'))!;
  const onDryBoard = boardRelativeTierOf(C('Ac Qc'), C('Kd 9s 2h'))!;
  assert.ok(
    onFlushBoard < onDryBoard,
    `同花完成面上 A♣Q♣ 的档位必须高于（数值更小）干燥面：${onFlushBoard} vs ${onDryBoard}`,
  );
});

/* ============================================================
 * 似然权重：跟注 / 过牌 / 进攻 三者必须互不相同且保序
 * ============================================================ */

test('C2-3：三种动作的似然权重必须互不相同，且各自保序', () => {
  const aggressive = likelihoodWeights('AGGRESSIVE', 1);
  const call = likelihoodWeights('CALL', 0.5);
  const check = likelihoodWeights('CHECK');

  // 进攻：越强越可能
  assert.ok(tierWeightOf(aggressive, 0) > tierWeightOf(aggressive, 5), '进攻必须偏强牌');
  // 跟注：垃圾档必须**低于**过牌（跟注不能带空气，过牌可以）
  assert.ok(
    tierWeightOf(call, 5) < tierWeightOf(check, 5),
    `跟注的垃圾档必须低于过牌：${tierWeightOf(call, 5).toFixed(4)} vs ${tierWeightOf(check, 5).toFixed(4)}`,
  );
  // 跟注：中档最高（不是顶级 —— 顶级更常加注）
  assert.ok(
    tierWeightOf(call, 2) > tierWeightOf(call, 0),
    '跟注里中档必须多于顶级（顶级更常加注）',
  );
  // 过牌：不应表现出强收紧（最宽）
  assert.ok(
    tierWeightOf(check, 5) > tierWeightOf(aggressive, 5),
    '过牌必须比进攻保留更多垃圾牌',
  );
  // 大额跟注 ⇒ 比小额跟注更偏强牌
  const bigCall = likelihoodWeights('CALL', 2);
  const smallCall = likelihoodWeights('CALL', 0.2);
  assert.ok(
    tierWeightOf(bigCall, 0) > tierWeightOf(smallCall, 0),
    '跟得越大，顶级档权重必须越高',
  );

  // 兼容入口与统一入口必须一致（既有调用方不能出现第二套口径）
  assert.equal(callLikelihood(0.5)('AA'), tierWeightOf(call, 0));
  assert.equal(checkLikelihood()('72o'), tierWeightOf(check, 5));
});
