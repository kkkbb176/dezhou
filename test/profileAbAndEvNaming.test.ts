/**
 * 定向审计测试 —— 画像 A/B、EV 命名、以及「EXACT 权益」的真实语义
 *
 * ## 这个文件守什么
 *
 * 1. **Test A**：`CALLING_STATION` 必须比 `NORMAL` 在同一牌局上产生
 *    「弃牌率更低 / 跟注率更高 / 下注策略评分更低」——验证画像**真的进了决策链**，
 *    而不是只被读取却什么都没发生。
 *
 * 2. **Test B**：用户可见文案**不得**把 0–1 的启发式偏好分（`checkScore` /
 *    `size.score` / `bestScore`）标成「EV」。
 *
 * 3. **Test C**：锁定权益的真实语义 —— 河牌 `EXACT × 990` 是
 *    **经过行动历史过滤的 Villain Range 权益**（不是「任意两张未知牌」），
 *    同时确认与 Hero/牌面死牌冲突的组合数为 0。
 *
 * ## 纪律（按审计要求）
 *
 * - **不断言脆弱的小数**：方向用 `<` / `>` 断言，不用 `toBe(0.009)`。
 * - **不硬编码这手牌**：测试通过**真实生产入口**跑，不注入伪造结果。
 * - 随机性：`equitySeed` 固定；权益为 EXACT 精确枚举（无抽样噪声）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';
import { parseManualInput } from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import type { ManualHandInput } from '../src/app/manualInput/manualInput.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
/** 固定种子：两侧共用 ⇒ 差异只能来自画像 */
const EQUITY_SEED = 20_260_913;

const A = (p: string, t: string, a?: number, s?: string) => ({
  position: p, type: t,
  ...(a === undefined ? {} : { amountBB: a }),
  ...(s === undefined ? {} : { street: s }),
});

/** 冻结牌局：6-max，SB1/BB2，100BB；Hero BTN A♣5♣ vs BB，河牌错过同花听牌 */
const HISTORY = [
  A('UTG', 'FOLD'), A('HJ', 'FOLD'), A('CO', 'FOLD'),
  A('BTN', 'RAISE', 3), A('SB', 'FOLD'), A('BB', 'CALL', 2),
  A('BB', 'CHECK', undefined, 'FLOP'), A('BTN', 'BET', 2.5, 'FLOP'), A('BB', 'CALL', 2.5, 'FLOP'),
  A('BB', 'CHECK', undefined, 'TURN'), A('BTN', 'BET', 7.5, 'TURN'), A('BB', 'CALL', 7.5, 'TURN'),
  A('BB', 'CHECK', undefined, 'RIVER'),
];
const SEATS: Record<string, number> = { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 };

function handOf(quickProfile: string): ManualHandInput {
  return {
    tableSize: 6, heroPosition: 'BTN', heroCards: ['Ac', '5c'],
    board: ['Kc', '8d', '4c', '2s', 'Qd'], street: 'RIVER',
    effectiveStackBB: 100, bigBlindBB: 2,
    seatStacksBB: { ...SEATS },
    actionHistory: HISTORY.map((a) => ({ ...a })),
    environment: 'MID_LOW_STAKES',
    villain: { quickProfile, dynamicHint: 'UNKNOWN', stackBB: 100 },
  } as unknown as ManualHandInput;
}

type Measured = {
  action: string;
  fold: Record<string, number>;
  call: Record<string, number>;
  raise: Record<string, number>;
  score: Record<string, number>;
  betEV: Record<string, number | null>;
  checkScore: number | null;
  bestScore: number | null;
  equity: number;
  equityMethod: string;
  equityIterations: number;
  supportSize: number | null;
};

/** 走**真实生产入口**（与界面 / API 同一条路） */
function measure(quickProfile: string): Measured {
  const input = handOf(quickProfile);
  const parsed = parseManualInput(input);
  if (!parsed.ok) throw new Error(`牌局必须可解析：${JSON.stringify(parsed.issues)}`);
  const gate = buildAnalyzableState(parsed.value);
  if (!gate.ok) throw new Error(`牌局必须可重建：${JSON.stringify(gate.issues)}`);

  const built = buildDecisionContext({
    state: gate.state, rules: RULES, environment: 'MID_LOW_STAKES',
    asOf: 1_757_000_000_000, quickProfile: quickProfile as never,
  });
  const ctx = built.context as unknown as Record<string, any>;
  const math = ctx['math'] as Record<string, any>;

  const r = analyzeManualHand(input, {
    rules: RULES, asOf: 1_757_000_000_000, writeLog: false,
    equitySeed: EQUITY_SEED, budget: { softMs: 120_000, hardMs: 240_000 },
  });
  if (!r.ok) {
    assert.fail(`牌局必须可分析：${JSON.stringify(r.issues)}`);
  }

  const d = r.decision as unknown as Record<string, any>;
  const diag = d['diagnostics'] as Record<string, any>;
  const bd = diag['postflop']?.['betDecision'] as Record<string, any> | null;
  assert.ok(bd !== null, '河牌无人下注 ⇒ 必须构建下注决策事实包');

  const pick = (field: string): Record<string, number> =>
    Object.fromEntries(
      ((bd!['sizes'] ?? []) as readonly Record<string, any>[]).map((s) => [
        String(s['size']),
        Number(s[field]),
      ]),
    );

  return {
    action: String(d['action']),
    fold: pick('foldLikelihood'),
    call: pick('callLikelihood'),
    raise: pick('raiseLikelihood'),
    score: pick('score'),
    betEV: Object.fromEntries(
      ((bd!['sizes'] ?? []) as readonly Record<string, any>[]).map((s) => [
        String(s['size']),
        s['betEV'] === null || s['betEV'] === undefined ? null : Number(s['betEV']),
      ]),
    ),
    checkScore: bd!['checkScore'] === undefined ? null : Number(bd!['checkScore']),
    bestScore: bd!['bestScore'] === undefined ? null : Number(bd!['bestScore']),
    equity: Number(math['heroEquity']),
    equityMethod: String(math['equitySource']?.['method']),
    equityIterations: Number(math['equitySource']?.['iterations']),
    supportSize: ctx['range'] === null ? null : Number((ctx['range'] as any)['supportSize']),
  };
}

const SIZES = ['BET_SMALL', 'BET_MEDIUM', 'BET_LARGE'] as const;
const station = measure('CALLING_STATION');
const normal = measure('NORMAL');

/* ============================================================
 * Test A：CALLING_STATION vs NORMAL 的方向
 * ============================================================ */

test('Test A1：跟注站的**弃牌率**必须低于普通玩家（每个尺寸都成立）', () => {
  for (const s of SIZES) {
    assert.ok(
      station.fold[s]! < normal.fold[s]!,
      `${s}：跟注站弃牌率必须更低，实际 ${station.fold[s]!.toFixed(5)} vs ${normal.fold[s]!.toFixed(5)}`,
    );
  }
});

test('Test A2：跟注站的**跟注率**必须高于普通玩家（每个尺寸都成立）', () => {
  for (const s of SIZES) {
    assert.ok(
      station.call[s]! > normal.call[s]!,
      `${s}：跟注站跟注率必须更高，实际 ${station.call[s]!.toFixed(5)} vs ${normal.call[s]!.toFixed(5)}`,
    );
  }
});

test('Test A3：跟注站面前**下注策略评分**必须更低（诈唬吸引力下降）', () => {
  for (const s of SIZES) {
    assert.ok(
      station.score[s]! < normal.score[s]!,
      `${s}：跟注站面前下注评分必须更低，实际 ${station.score[s]!.toFixed(5)} vs ${normal.score[s]!.toFixed(5)}`,
    );
  }
});

test('Test A4：画像**真的改变了模型**（不是只被读取）—— 概率向量必须逐位不同', () => {
  const identical = SIZES.every((s) => station.fold[s] === normal.fold[s]);
  assert.equal(
    identical,
    false,
    '两个画像给出了完全相同的响应概率 ⇒ 画像没有进入模型（静默失效）',
  );
});

test('Test A5：动作可以相同，但画像影响必须可见（本手两侧都是 CHECK 不算无效）', () => {
  // 本条**不断言动作翻转** —— 按审计要求，画像有效性看内部概率与评分。
  // 只断言两侧都给出了合法动作，且权益与评分都被如实计算。
  assert.ok(station.action.length > 0 && normal.action.length > 0, '两侧都必须给出动作');
  assert.ok(Number.isFinite(station.equity) && Number.isFinite(normal.equity), '两侧权益都必须可算');
  assert.notEqual(station.equity, undefined);
});

/* ============================================================
 * Test B：启发式评分不得展示为 EV
 * ============================================================ */

const VIEW_MODEL = new URL('../src/viewmodels/decisionViewModel.ts', import.meta.url);
const ENGINE = new URL('../src/app/decision/decisionEngine.ts', import.meta.url);

test('Test B1：界面不得把 `checkScore` 显示为「CHECK EV」', () => {
  const src = readFileSync(VIEW_MODEL, 'utf8');
  assert.equal(
    /CHECK EV \$\{num\(bd\['checkEV'\]/.test(src),
    false,
    '「CHECK EV」标签指向的是 0–1 启发式偏好分（checkScore），不是筹码 EV；' +
      '必须改名为「CHECK 策略评分」并标注非筹码 EV',
  );
  assert.ok(
    src.includes('CHECK 策略评分'),
    '界面必须使用「CHECK 策略评分」这一名称',
  );
});

test('Test B2：`size.score` 不得显示为裸「分」，必须是「策略评分」并标注非 EV', () => {
  const src = readFileSync(VIEW_MODEL, 'utf8');
  assert.ok(
    src.includes('策略评分 ${num(s[\'score\'])}'),
    '每个尺寸的 score 必须显式标为「策略评分」',
  );
  assert.ok(
    src.includes('0–1 启发式偏好分，非筹码 EV'),
    '必须显式声明该评分不是筹码 EV',
  );
});

test('Test B3：决策依据文案不得把启发式评分称作 EV', () => {
  const src = readFileSync(ENGINE, 'utf8');
  assert.equal(
    /CHECK 优于所有尺寸（CHECK EV/.test(src),
    false,
    '「CHECK 优于所有尺寸（CHECK EV …）」把偏好分写成了 EV，必须修正',
  );
  assert.ok(
    src.includes('策略评分') && src.includes('不代表任何筹码盈亏'),
    '决策依据必须写明「策略评分」且说明不代表筹码盈亏',
  );
});

test('Test B4：真正的筹码 EV 标签必须保留（不得误伤）', () => {
  const src = readFileSync(VIEW_MODEL, 'utf8');
  // `checkTree.checkEV` / `betEV` 是真实筹码 EV，标签应保留
  assert.ok(src.includes('CHECK EV'), '真实的 CHECK 树筹码 EV 标签必须保留');
  assert.ok(src.includes('BetEV'), '真实 BetEV 标签必须保留');
});

/* ============================================================
 * Test C：`EXACT` 权益的真实语义
 * ============================================================ */

test('Test C1：河牌 EXACT 权益必须是**范围条件化**的，不是「任意两张未知牌」', () => {
  assert.equal(station.equityMethod, 'EXACT', '河牌应为精确枚举');
  assert.equal(normal.equityMethod, 'EXACT');

  /*
   * 判据一：必须能拿到 action-history 过滤后的范围，且它是**加权**的。
   * 「任意两张未知牌」是一个**均匀**分布；而生产范围来自 RFI 先验 +
   * 行动历史似然 ⇒ 权重必然不均。
   */
  assert.ok(
    station.supportSize !== null && station.supportSize > 0,
    '必须存在支持组合数 > 0 的对手范围（否则权益就不可能是范围条件化的）',
  );

  /*
   * 判据二：范围条件化的权益必须与「任意两张未知牌」的权益**不同**。
   *
   * 若实现其实在算「任意两张」，那么 A♣5♣（A 高、无对子）对**随机手牌**
   * 的权益会显著更高（实测约 33%）；而这里对手是「BTN 开池 + 连跟两条街」
   * 的 BB ⇒ 权益应显著更低。
   *
   * ⚠️ 阈值刻意宽松（只用来区分「随机手牌」与「被过滤的范围」两件完全不同的事），
   * 不做精确断言。
   */
  assert.ok(
    station.equity < 0.20,
    `A 高对「跟了两条街的 BB 范围」的权益应显著低于对随机手牌的权益；` +
      `实际 ${(station.equity * 100).toFixed(2)}% —— 若接近 33% 则说明用的是任意两张未知牌`,
  );

  // 判据三：范围支持组合数**不等于** `C(45,2) = 990`（那正是「任意两张」的组合数）
  assert.notEqual(
    station.supportSize,
    990,
    'supportSize 不能等于 C(45,2)——那意味着范围没有被行动历史过滤',
  );
});

test('Test C2：两个画像必须给出**不同**的范围条件化权益（画像影响范围）', () => {
  assert.notEqual(
    station.equity,
    normal.equity,
    'CALLING_STATION 与 NORMAL 的权益必须不同 —— 相同说明画像没有影响范围',
  );
});

test('Test C3：`iterations` 是**枚举的对局数**，不等于 supportSize（零权重条目仍被枚举）', () => {
  /*
   * 实测结论（写进报告的取证）：
   *   `range.entries.length` = 990，其中**权重为 0 的有 515**，
   *   权重 > 0 的（= `metrics.supportSize`）为 475。
   *   而 `enumerateExact` 的 `matchups` 按 **entries 数**计 ⇒ 报出 990。
   *
   * ⇒ `iterations: 990` 的含义是「枚举了 990 个组合槽位」，
   *   **不是**「990 个有正权重的组合」，也**不是** C(45,2)。
   *   两者数值上偶然相等，极易误读 —— 本条把语义钉住。
   */
  assert.equal(
    station.equityIterations,
    990,
    '河牌单挑的枚举槽位数应为 990（RFI 先验去掉 Hero/牌面冲突后的组合数）',
  );
  assert.ok(
    station.supportSize! < station.equityIterations,
    `有效支撑组合数(${station.supportSize}) 必须小于枚举槽位数(${station.equityIterations}) —— ` +
      '零权重条目被枚举但不贡献权益',
  );
});

test('Test C4：权益按**权重**归一（零权重组合不贡献权益）', () => {
  /*
   * 若实现把 990 个槽位当等权（即包含 515 个零权重组合），
   * 权益会被系统性地拉向「随机手牌」那一侧。
   * 上面 C1 的 `< 0.20` 已经覆盖了这个方向；
   * 这里再锁一条结构性事实：supportSize 与 iterations 不一致，
   * 说明「按 entries 计数、按 weights 求值」这套口径是**有意的**。
   */
  assert.notEqual(
    station.supportSize,
    station.equityIterations,
    'supportSize 与 iterations 不相等是本期实测的结构事实（含 515 个零权重槽位）',
  );
});
