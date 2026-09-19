/**
 * ============================================================================
 * 第二阶段 · 任务一：**下注金额一致性**
 * ============================================================================
 * 缺陷（已复现）：响应模型评估的是 `betDecision.sizes[].betAmount`（= 按有效筹码封顶后的
 * 合法金额，本例 14），而最终推荐金额是在**另一套百分比网格**里取最近候选（本例 13）。
 * 两者相差 1 筹码 ⇒ 界面上展示的响应概率与 EV 属于**另一个金额**。
 *
 * 本文件先锁住「推荐金额 = 被评估金额」这条一致性，再锁「被评估金额必须是可执行金额」。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { deriveLegalActions } from '../src/app/manualInput/legalActions.ts';
import { parseManualInput, type ManualHandInput } from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const OPTIONS = {
  rules: RULES, asOf: 1_757_000_000_000, writeLog: false,
  equitySeed: 20_261_014, budget: { softMs: 120_000, hardMs: 240_000 },
} as const;

const A = (position: string, type: string, amountBB?: number, street?: string) => ({
  position, type,
  ...(amountBB === undefined ? {} : { amountBB }),
  ...(street === undefined ? {} : { street }),
});

/** 河牌 BB **过牌** ⇒ 轮到 Hero 下注 */
function riverCheckedToHero(bbStackBB: number): ManualHandInput {
  return {
    tableSize: 6, heroPosition: 'BTN', heroCards: ['As', 'Ks'],
    board: ['Kd', '9c', '4h', '6s', '2d'], street: 'RIVER',
    effectiveStackBB: 100, bigBlindBB: 2,
    seatStacksBB: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: bbStackBB },
    actionHistory: [
      A('UTG', 'FOLD'), A('HJ', 'FOLD'), A('CO', 'FOLD'), A('BTN', 'RAISE', 3), A('SB', 'FOLD'), A('BB', 'CALL', 2),
      A('BB', 'CHECK', undefined, 'FLOP'), A('BTN', 'BET', 2.5, 'FLOP'), A('BB', 'CALL', 2.5, 'FLOP'),
      A('BB', 'CHECK', undefined, 'TURN'), A('BTN', 'BET', 7.5, 'TURN'), A('BB', 'CALL', 7.5, 'TURN'),
      A('BB', 'CHECK', undefined, 'RIVER'),
    ],
    environment: 'MID_LOW_STAKES',
    villain: { quickProfile: 'CALLING_STATION', dynamicHint: 'UNKNOWN', stackBB: bbStackBB },
  } as unknown as ManualHandInput;
}

type Diag = Record<string, any>;

function decide(input: ManualHandInput): { action: string; sizeChips: number | null; diag: Diag } {
  const r = analyzeManualHand(input, OPTIONS);
  assert.equal(r.ok, true, `必须能分析：${r.ok ? '' : `${r.stage} ${JSON.stringify(r.issues)}`}`);
  if (!r.ok) throw new Error('unreachable');
  const d = r.decision as unknown as Record<string, any>;
  return {
    action: String(d['action']),
    sizeChips: (d['sizeChips'] ?? null) as number | null,
    diag: d['diagnostics'] as Diag,
  };
}

/** 响应模型**实际评估**的那个金额（= bestSize 对应的合法金额） */
function evaluatedBetAmount(diag: Diag): number | null {
  const bd = ((diag['postflop'] ?? {})['betDecision'] ?? null) as Diag | null;
  if (bd === null || bd['bestSize'] === null) return null;
  const spec = ((bd['sizes'] ?? []) as Diag[]).find((s) => s['size'] === bd['bestSize']);
  return spec === undefined ? null : (spec['betAmount'] as number);
}

test('任务一 T1：推荐下注金额必须**等于**响应模型评估的金额', () => {
  /*
   * BB 20BB：对手只剩 14 ⇒ 三个理论尺寸（1/3、2/3、1 池 = 17.67/35.33/53）
   * 全部被封顶到 **14** ⇒ 被评估金额 = 14。
   * 修复前最终推荐是 **13**（另一套网格 [2,13,18,27,35,40,53,174] 里离 14 最近的候选）。
   */
  const { action, sizeChips, diag } = decide(riverCheckedToHero(20));
  assert.equal(action, 'BET', `前置：本节点应当推荐下注（实际 ${action}）`);
  const evaluated = evaluatedBetAmount(diag);
  assert.notEqual(evaluated, null, '前置：响应模型必须给出被评估的金额');
  assert.equal(
    sizeChips,
    evaluated,
    `推荐金额必须等于被评估金额（被评估 ${String(evaluated)}，推荐 ${String(sizeChips)}）` +
      ' —— 否则界面展示的概率与 EV 属于另一个金额',
  );
});

test('任务一 T2：两者必须属于**同一个决策节点**（同一底池/街道/配置）', () => {
  const { diag } = decide(riverCheckedToHero(20));
  const bd = (diag['postflop'] ?? {})['betDecision'] as Diag;
  const math = diag['math'] as Diag;
  assert.equal(bd['pot'], math['pot'], '响应模型的底池必须与决策层同一底池');
  assert.equal(String(math['street']), 'RIVER', '响应模型必须在同一街道上评估');
  assert.equal(
    (diag['legalActions'] as string[]).includes('BET'),
    true,
    '同一节点必须允许下注（否则两者不可能属于同一决策）',
  );
});

test('任务一 T3：被评估的金额必须出现在决策层的下注候选里（否则不可执行/不可选）', () => {
  const { diag } = decide(riverCheckedToHero(20));
  const evaluated = evaluatedBetAmount(diag);
  assert.notEqual(evaluated, null);
  const bets = ((diag['candidates'] ?? []) as Diag[])
    .filter((c) => c['action'] === 'BET')
    .map((c) => c['sizeChips'] as number);
  assert.ok(
    bets.some((b) => Math.abs(b - (evaluated as number)) < 1e-9),
    `被评估金额 ${String(evaluated)} 必须可在候选里选中（下注候选：${bets.join(', ')}）`,
  );
});

test('任务一 T4：被评估金额必须是**合法金额**（≥ 最小下注、≤ 本街上限）', () => {
  /*
   * ⚠️ 本测试**不**要求被评估金额是整筹码：`betDecisionEngine.test.ts` 的 P0-1/P0-1b
   * 明文规定「底池 29 ⇒ 三个尺寸必须是 9.667 / 19.333 / 29」——
   * 合法下注额**按底池比例**（可含小数）是既有已验证契约。
   * 因此一致性必须由「推荐金额 = 被评估金额」保证（T1/T3），
   * 而不是把被评估金额取整（那会破坏比例契约，已经试过并回退）。
   */
  for (const bb of [20, 40, 100]) {
    const input = riverCheckedToHero(bb);
    const { action, sizeChips, diag } = decide(input);
    const parsed = parseManualInput(input);
    assert.equal(parsed.ok, true, `BB ${bb}BB：输入必须能解析`);
    if (!parsed.ok) continue;
    const gate = buildAnalyzableState(parsed.value);
    assert.equal(gate.ok, true);
    if (!gate.ok) continue;
    const st = gate.state;
    const hero = st.players.find((p) => p.id === st.userPlayerId)!;
    const legal = deriveLegalActions(st, hero);
    const evaluated = evaluatedBetAmount(diag);
    assert.notEqual(evaluated, null, `BB ${bb}BB：必须有被评估金额`);
    const amount = evaluated as number;
    assert.ok(amount >= legal.minBet - 1e-9, `BB ${bb}BB：被评估金额 ${amount} 不得低于最小下注 ${legal.minBet}`);
    assert.ok(amount <= legal.allInToAmount + 1e-9, `BB ${bb}BB：被评估金额 ${amount} 不得超过本街上限 ${legal.allInToAmount}`);
    // 关键：它必须能被决策层选中，并且最终推荐就是它
    const bets = ((diag['candidates'] ?? []) as Diag[])
      .filter((c) => c['action'] === 'BET' || c['action'] === 'ALL_IN')
      .map((c) => c['sizeChips'] as number);
    assert.ok(
      bets.some((b) => Math.abs(b - amount) < 1e-9),
      `BB ${bb}BB：被评估金额 ${amount} 必须出现在候选里（${bets.join(', ')}）`,
    );
    if (action === 'BET' || action === 'ALL_IN') {
      assert.equal(sizeChips, amount, `BB ${bb}BB：推荐金额必须等于被评估金额`);
    }
  }
});
