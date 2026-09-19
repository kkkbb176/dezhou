/**
 * ============================================================================
 * P1-2a 定向修复 —— 再加注分支的**合法动作边界**测试
 * ============================================================================
 *
 * 缺陷（已独立复现）：对手**跟注即全下**时，下注轮随即结束、引擎拒绝他的任何再加注
 *（实测 `ISSUE.ACTION_AFTER_HAND_OVER`），但模型仍产出再加注分支，
 * 并按「Hero 弃牌、损失全部投入」计价 ⇒ 系统性**低估加注**。
 *
 * 本文件锁住「某个行动分支概率 > 0 ⇒ 该行动在当前节点真实可达」这条不变量，
 * 覆盖批准范围内的 8 个场景（A–H）与 4 条不变量（I1–I4）。
 *
 * ⚠️ 预期值全部来自**手算的有效筹码与合法动作规则**，不复制产品实现；
 * 也不使用审计报告里的「假设修正 EV」作为黄金值。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import type { ManualHandInput } from '../src/app/manualInput/manualInput.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const OPTIONS = {
  rules: RULES, asOf: 1_757_000_000_000, writeLog: false,
  equitySeed: 20_261_014, budget: { softMs: 120_000, hardMs: 240_000 },
} as const;

type Row = { position: string; type: string; amountBB?: number; street?: string };
const A = (position: string, type: string, amountBB?: number, street?: string): Row => ({
  position, type,
  ...(amountBB === undefined ? {} : { amountBB }),
  ...(street === undefined ? {} : { street }),
});

/**
 * 河牌面对 BB 领打的节点（与 P0-7 / KQ 节点同一条行动历史）。
 *
 * 手算的本街投入（BB = 2 筹码/BB）：翻前 3BB、翻牌 2.5BB、转牌 7.5BB、河牌下注 riverBetBB
 *   ⇒ 下注前本街累计 = 13BB + riverBetBB ⇒ 可用剩余 = bbStackBB − 13 − riverBetBB
 *   Hero 本街投入 0（河牌尚未行动）
 */
function riverFacingBet(opts: { btnStackBB: number; bbStackBB: number; riverBetBB: number; heroCards?: [string, string] }): ManualHandInput {
  const { btnStackBB, bbStackBB, riverBetBB } = opts;
  return {
    tableSize: 6, heroPosition: 'BTN',
    heroCards: opts.heroCards ?? ['As', 'Ks'],
    board: ['Kd', '9c', '4h', '6s', '2d'], street: 'RIVER',
    effectiveStackBB: Math.min(btnStackBB, bbStackBB), bigBlindBB: 2,
    seatStacksBB: { UTG: btnStackBB, HJ: btnStackBB, CO: btnStackBB, BTN: btnStackBB, SB: btnStackBB, BB: bbStackBB },
    actionHistory: [
      A('UTG', 'FOLD'), A('HJ', 'FOLD'), A('CO', 'FOLD'), A('BTN', 'RAISE', 3), A('SB', 'FOLD'), A('BB', 'CALL', 2),
      A('BB', 'CHECK', undefined, 'FLOP'), A('BTN', 'BET', 2.5, 'FLOP'), A('BB', 'CALL', 2.5, 'FLOP'),
      A('BB', 'CHECK', undefined, 'TURN'), A('BTN', 'BET', 7.5, 'TURN'), A('BB', 'CALL', 7.5, 'TURN'),
      A('BB', 'BET', riverBetBB, 'RIVER'),
    ],
    environment: 'MID_LOW_STAKES',
    villain: { quickProfile: 'CALLING_STATION', dynamicHint: 'UNKNOWN', stackBB: bbStackBB },
  } as unknown as ManualHandInput;
}

/** HAND H：Hero 本街**已经投入**（CO 下注 5BB → BB 加注到 20BB → 轮到 CO） */
function heroBetThenFacesRaise(): ManualHandInput {
  return {
    tableSize: 6, heroPosition: 'CO', heroCards: ['As', 'Ah'], board: ['Kh', '7c', '2d'],
    street: 'FLOP', effectiveStackBB: 100, bigBlindBB: 2,
    seatStacksBB: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 },
    actionHistory: [
      A('UTG', 'FOLD'), A('HJ', 'FOLD'), A('CO', 'RAISE', 3), A('BTN', 'FOLD'), A('SB', 'FOLD'), A('BB', 'CALL', 2),
      A('BB', 'CHECK', undefined, 'FLOP'), A('CO', 'BET', 5, 'FLOP'), A('BB', 'RAISE', 20, 'FLOP'),
    ],
    environment: 'MID_LOW_STAKES',
    villain: { quickProfile: 'CALLING_STATION', dynamicHint: 'UNKNOWN', stackBB: 100 },
  } as unknown as ManualHandInput;
}

type Diag = Record<string, any>;
type Facts = Diag;

function decide(input: ManualHandInput): { action: string; sizeChips: number | null; diag: Diag; facts: Facts | null; callEV: number } {
  const r = analyzeManualHand(input, OPTIONS);
  assert.equal(r.ok, true, `必须能分析：${r.ok ? '' : `${r.stage} ${JSON.stringify(r.issues)}`}`);
  if (!r.ok) throw new Error('unreachable');
  const d = r.decision as unknown as Record<string, any>;
  const dg = d['diagnostics'] as Diag;
  return {
    action: String(d['action']),
    sizeChips: (d['sizeChips'] ?? null) as number | null,
    diag: dg,
    facts: ((dg['postflop'] ?? {})['raiseResponse'] ?? null) as Facts | null,
    callEV: (dg['math'] as Diag)['callEV'] as number,
  };
}

/** 场景表：`villainRemainingChips` 与两个布尔量都是**手算**的 */
type Scenario = {
  id: string;
  label: string;
  input: ManualHandInput;
  /** 对手在本街下注后的剩余筹码（手算：bbStackBB×2 − 本街已投） */
  villainRemaining: number;
  /** 他跟平 Hero 加注是否必须投光全部剩余（手算，或由事实包断言） */
  expectVillainAllInByCall: boolean;
  /** 他是否还**有筹码**可以在跟注之后继续加注 */
  expectCanStillRaise: boolean;
};

const SCENARIOS: readonly Scenario[] = [
  {
    id: 'A',
    label: 'A：双方都未全下，可以合法再做一次完整加注',
    input: riverFacingBet({ btnStackBB: 100, bbStackBB: 200, riverBetBB: 10 }),
    villainRemaining: 400 - 46,
    expectVillainAllInByCall: false,
    expectCanStillRaise: true,
  },
  {
    id: 'B',
    label: 'B：Hero 全下 ⇒ 他不能再加注',
    /* Hero 60BB=120 筹码 − 本街前已投 26 = 94 剩余；最小加注到 80 ⇒ 只能全下到 94 */
    input: riverFacingBet({ btnStackBB: 60, bbStackBB: 100, riverBetBB: 20 }),
    villainRemaining: 200 - 46,
    expectVillainAllInByCall: false, // 他筹码够；不能加注是因为 **Hero** 全下
    expectCanStillRaise: false,
  },
  {
    id: 'C',
    label: 'C：对手跟注即全下（P0-7 夹具）⇒ 不得有再加注分支',
    input: riverFacingBet({ btnStackBB: 100, bbStackBB: 30, riverBetBB: 10 }),
    villainRemaining: 60 - 23 * 2,
    expectVillainAllInByCall: true,
    expectCanStillRaise: false,
  },
  {
    id: 'D',
    label: 'D：跟注后仍有筹码但不足完整再加注 ⇒ 短筹码全下加注仍然合法（KQ 节点）',
    input: riverFacingBet({ btnStackBB: 100, bbStackBB: 100, riverBetBB: 10, heroCards: ['Ks', 'Qs'] }),
    villainRemaining: 200 - 46,
    expectVillainAllInByCall: false,
    expectCanStillRaise: true,
  },
  {
    id: 'E',
    label: 'E：跟注后筹码充足，满足完整最小再加注',
    input: riverFacingBet({ btnStackBB: 200, bbStackBB: 200, riverBetBB: 20 }),
    villainRemaining: 400 - 46,
    expectVillainAllInByCall: false,
    expectCanStillRaise: true,
  },
  {
    id: 'F',
    label: 'F：Hero 的加注超过对手可匹配额 ⇒ 多余筹码退回',
    input: riverFacingBet({ btnStackBB: 100, bbStackBB: 40, riverBetBB: 10 }),
    villainRemaining: 80 - 46,
    expectVillainAllInByCall: true,
    expectCanStillRaise: false,
  },
  {
    id: 'G',
    label: 'G：边界 —— 对手恰好用完全部剩余筹码跟平',
    // 让「他需要补的钱」正好等于他的全部剩余：剩余 = 73×2 − 46 = 100 ⇒ R = 120（网格选中）
    input: riverFacingBet({ btnStackBB: 100, bbStackBB: 73, riverBetBB: 10 }),
    villainRemaining: 146 - 46,
    expectVillainAllInByCall: true,
    expectCanStillRaise: false,
  },
];

/* ============================================================
 * I1–I4：四条不变量，逐场景执行
 * ============================================================ */

test('I1–I4【不变量】每个场景都必须满足「非零概率 ⇒ 真实可达」等四条约束', () => {
  for (const s of SCENARIOS) {
    const { facts } = decide(s.input);
    assert.notEqual(facts, null, `${s.id}：必须有加注响应事实`);
    if (facts === null) continue;
    const f = facts['foldLikelihood'] as number;
    const c = facts['callLikelihood'] as number;
    const rr = facts['reRaiseLikelihood'] as number;
    const heroAdd = facts['heroAdd'] as number;
    const villainAdd = facts['villainAdd'] as number;
    const villainAddRaw = facts['villainAddRaw'] as number;
    const heroAllIn = (facts['model'] as Diag)['heroIsAllIn'] as boolean;
    const villainAllInByCall = (facts['model'] as Diag)['villainIsAllInByCall'] as boolean;

    /* I1：他跟注即全下 ⇒ 再加注概率必须为 0 */
    if (villainAllInByCall) {
      assert.equal(rr, 0, `${s.id}：他跟平即投光 ⇒ 不得生成再加注分支（实际 ${rr}）`);
    }
    /* I2：rr > 0 ⇒ 他必须真的有筹码可以继续加注（跟完还剩） */
    if (rr > 0) {
      assert.ok(
        villainAdd < s.villainRemaining - 1e-9,
        `${s.id}：rr>0 时他跟完之后必须**还有筹码**（补 ${villainAdd} vs 剩余 ${s.villainRemaining}）`,
      );
      assert.equal(heroAllIn, false, `${s.id}：rr>0 时 Hero 不得已全下`);
    }
    /* I3：三个概率之和必须为 1 */
    assert.ok(
      Math.abs(f + c + rr - 1) < 1e-12,
      `${s.id}：P(弃)+P(跟)+P(再加注) 必须为 1（实际 ${f + c + rr}）`,
    );
    /* I4：任何分支都不得投入超过玩家实际拥有的筹码 */
    assert.ok(heroAdd > 0 && villainAdd > 0, `${s.id}：两个新增投入都必须为正`);
    assert.ok(
      villainAdd <= s.villainRemaining + 1e-9,
      `${s.id}：对手补入 ${villainAdd} 不得超过他的剩余 ${s.villainRemaining}`,
    );

    /* 场景自述的期望（手算）与事实包一致 */
    assert.equal(
      villainAllInByCall,
      s.expectVillainAllInByCall,
      `${s.id}：villainIsAllInByCall 期望 ${s.expectVillainAllInByCall}（手算剩余 ${s.villainRemaining}、他要补 ${villainAddRaw}）`,
    );
    if (s.expectCanStillRaise) {
      assert.ok(rr > 0, `${s.id}：他仍有筹码 ⇒ 加注分支应当保留（实际 rr=${rr}）`);
    }
  }
});

/* ============================================================
 * A–H：逐场景断言
 * ============================================================ */

test('A【双方都未全下】完整再加注合法 ⇒ 再加注分支保留，且金额未被封顶', () => {
  const { facts } = decide(SCENARIOS[0]!.input);
  assert.notEqual(facts, null);
  if (facts === null) return;
  assert.equal((facts['model'] as Diag)['villainIsAllInByCall'], false);
  assert.equal((facts['model'] as Diag)['heroIsAllIn'], false);
  assert.ok((facts['reRaiseLikelihood'] as number) > 0, '他筹码充足 ⇒ 必须有再加注分支');
  assert.equal(facts['villainAdd'], facts['villainAddRaw'], '未被封顶时两者必须相等');
  assert.equal(facts['uncalledReturn'], 0, '双方都跟得满 ⇒ 没有退回');
  assert.equal(facts['finalPot'], (facts['currentPot'] as number) + (facts['heroAdd'] as number) + (facts['villainAdd'] as number));
});

test('B【Hero 全下】他不能再加注 ⇒ 再加注概率为 0，且质量迁移到跟注', () => {
  const { facts } = decide(SCENARIOS[1]!.input);
  assert.notEqual(facts, null);
  if (facts === null) return;
  assert.equal((facts['model'] as Diag)['heroIsAllIn'], true, '前置：本次加注就是 Hero 全下');
  assert.equal(facts['reRaiseLikelihood'], 0, 'Hero 全下 ⇒ 不得生成再加注分支');
  assert.ok(
    Math.abs((facts['foldLikelihood'] as number) + (facts['callLikelihood'] as number) - 1) < 1e-12,
    '质量必须迁移到跟注（不是丢弃）',
  );
  assert.equal((facts['model'] as Diag)['villainIsAllInByCall'], false, '本场景里他筹码够 —— 两个判据不得混用');
});

test('C【对手跟注即全下】P0-7 夹具：再加注概率必须为 0（修复前为 43.108%）', () => {
  const { facts } = decide(SCENARIOS[2]!.input);
  assert.notEqual(facts, null);
  if (facts === null) return;
  assert.equal((facts['model'] as Diag)['villainIsAllInByCall'], true, '前置：他跟平即投光');
  assert.equal(facts['reRaiseLikelihood'], 0, '🔴 修复的核心断言：不可能的分支必须为 0');
  assert.ok(
    Math.abs((facts['foldLikelihood'] as number) + (facts['callLikelihood'] as number) - 1) < 1e-12,
    '原再加注质量必须并入跟注桶',
  );
  // 资金量不得因本次修复而改变（修复只动分支结构，不动钱）
  assert.equal(facts['villainAdd'], 14, '他只能补 14');
  assert.equal(facts['heroContestedAdd'], 34, '被跟注的部分 34');
  assert.equal(facts['uncalledReturn'], 86, '未被跟注的 86 必须退回 Hero');
  assert.equal(facts['finalPot'], 121, '终池 = 73 + 34 + 14');
});

test('D【短筹码全下加注】他跟完仍有筹码 ⇒ 加注分支必须保留（不得被误杀）', () => {
  const { facts } = decide(SCENARIOS[3]!.input);
  assert.notEqual(facts, null);
  if (facts === null) return;
  assert.equal((facts['model'] as Diag)['villainIsAllInByCall'], false, '他跟完还有 54 筹码');
  assert.ok((facts['reRaiseLikelihood'] as number) > 0, '🔴 不足最小加注额的全下加注仍然合法 ⇒ 分支必须保留');
  assert.equal(facts['villainAdd'], facts['villainAddRaw'], '未被封顶');
});

test('E【完整再加注】他跟完仍买得起完整再加注 ⇒ 分支保留', () => {
  const { facts } = decide(SCENARIOS[4]!.input);
  assert.notEqual(facts, null);
  if (facts === null) return;
  const raw = facts['villainAddRaw'] as number;
  // 完整再加注需要 2×raw 筹码（最小再加注到 = 2R − B）
  assert.ok(2 * raw <= SCENARIOS[4]!.villainRemaining + 1e-9, '手算：他买得起完整再加注');
  assert.ok((facts['reRaiseLikelihood'] as number) > 0, '必须有再加注分支');
});

test('F【多余筹码退回】Hero 的加注超过对手可匹配额 ⇒ 退回与终池必须自洽', () => {
  const { facts } = decide(SCENARIOS[5]!.input);
  assert.notEqual(facts, null);
  if (facts === null) return;
  const heroAdd = facts['heroAdd'] as number;
  const contested = facts['heroContestedAdd'] as number;
  const villainAdd = facts['villainAdd'] as number;
  assert.equal((facts['model'] as Diag)['villainIsAllInByCall'], true);
  assert.ok(contested < heroAdd, '前置：我方有未被跟注的部分');
  assert.equal(facts['uncalledReturn'], heroAdd - contested, '退回 = 我方新增 − 留在池中的');
  assert.equal(facts['finalPot'], (facts['currentPot'] as number) + contested + villainAdd, '终池按「留在池中的」算');
  assert.equal(facts['reRaiseLikelihood'], 0, '他跟注即全下 ⇒ 无再加注分支');
});

test('G【边界】对手恰好用完全部剩余跟平 ⇒ 视为「跟注即全下」，不得有再加注分支', () => {
  const { facts } = decide(SCENARIOS[6]!.input);
  assert.notEqual(facts, null);
  if (facts === null) return;
  assert.equal(
    facts['villainAddRaw'],
    SCENARIOS[6]!.villainRemaining,
    `边界确认：他要补的 ${String(facts['villainAddRaw'])} 恰好等于他的全部剩余 ${SCENARIOS[6]!.villainRemaining}`,
  );
  assert.equal(facts['villainAdd'], facts['villainAddRaw'], '恰好用光 ⇒ 两个量相等（没有被截断）');
  assert.equal((facts['model'] as Diag)['villainIsAllInByCall'], true, '🔴 边界必须被判为「跟注即全下」');
  assert.equal(facts['reRaiseLikelihood'], 0, '边界处同样不得生成再加注分支');
  assert.equal(facts['uncalledReturn'], 0, '恰好匹配 ⇒ 没有退回');
});

test('H【本街已有投入】Hero 先下注后被加注 ⇒ 不重复扣 callCost，且分支判据仍按对手筹码', () => {
  const { facts, diag } = decide(heroBetThenFacesRaise());
  assert.notEqual(facts, null, '本街已有投入时不得静默关闭 U1');
  if (facts === null) return;
  const math = diag['math'] as Diag;
  assert.equal(math['myCommittedThisStreet'], 10, '前置：Hero 本街已投 10 筹码');
  assert.equal(facts['heroAdd'], (facts['sizeChips'] as number) - 10, 'heroAdd = raiseTo − 本街已投');
  assert.equal(
    facts['villainAdd'],
    (facts['sizeChips'] as number) - (facts['villainStreetCommitted'] as number),
    'villainAdd = raiseTo − 对手本街已投',
  );
  assert.equal(
    (facts['model'] as Diag)['villainIsAllInByCall'],
    false,
    '他筹码充足（100BB）⇒ 不触发本条的封顶判据',
  );
  assert.ok((facts['reRaiseLikelihood'] as number) > 0, '他仍有筹码 ⇒ 加注分支保留');
});

/* ============================================================
 * P1-4：同根因的**另一条通路**（「Hero 下注 → 他响应」= `betResponse`）
 * ============================================================ */

/** 河牌 **BB 过牌** ⇒ 轮到 Hero 下注（P1-4 所在的通路） */
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

function betSizesOf(input: ManualHandInput): Diag[] {
  const r = analyzeManualHand(input, OPTIONS);
  assert.equal(r.ok, true, `必须能分析：${r.ok ? '' : `${r.stage} ${JSON.stringify(r.issues)}`}`);
  if (!r.ok) throw new Error('unreachable');
  const dg = (r.decision as unknown as Record<string, unknown>)['diagnostics'] as Diag;
  const bd = ((dg['postflop'] ?? {})['betDecision'] ?? null) as Diag | null;
  assert.notEqual(bd, null, '必须有下注决策');
  return ((bd as Diag)['sizes'] ?? []) as Diag[];
}

test('P1-4-1【下注通路】下注额吃光对手筹码 ⇒ 加注概率必须为 0（修复前为 5.23%）', () => {
  /*
   * BB 只有 20BB = 40 筹码，本街前已投 26 ⇒ 只剩 **14**；合法下注额被封顶为 min(174, 14) = 14
   * ⇒ 他跟这一注就全下 ⇒ 引擎拒绝他的任何加注（实测 `ACTION_AFTER_HAND_OVER`）。
   */
  const sizes = betSizesOf(riverCheckedToHero(20));
  assert.ok(sizes.length > 0, '必须有下注尺寸');
  const allInSize = sizes.find((s) => s['betAmount'] === 14);
  assert.notEqual(allInSize, undefined, '前置：封顶后的尺寸必须是 14（= 他的全部剩余）');
  if (allInSize === undefined) return;
  assert.equal(allInSize['villainIsAllInByCall'], true, '🔴 必须如实标注「他跟注即全下」');
  assert.equal(allInSize['heroIsAllIn'], false, '两个全下判据必须分开：Hero 并没有全下');
  assert.equal(allInSize['raiseLikelihood'], 0, '🔴 修复的核心断言：不可能的分支必须为 0');
  assert.ok(
    Math.abs((allInSize['foldLikelihood'] as number) + (allInSize['callLikelihood'] as number) - 1) < 1e-12,
    '原加注质量必须并入跟注桶（弃 + 跟 = 1）',
  );
});

test('P1-4-2【不变量】每个下注尺寸都必须满足「加注概率 > 0 ⇒ 他真的还能加注」', () => {
  for (const stack of [20, 40, 100]) {
    const sizes = betSizesOf(riverCheckedToHero(stack));
    for (const s of sizes) {
      const allInByCall = s['villainIsAllInByCall'] as boolean;
      const raise = s['raiseLikelihood'] as number;
      if (allInByCall) {
        assert.equal(raise, 0, `BB ${stack}BB：他跟注即全下 ⇒ 加注概率必须为 0（实际 ${raise}）`);
      }
      if (raise > 1e-12) {
        assert.equal(allInByCall, false, `BB ${stack}BB：加注概率 > 0 ⇒ 他必须仍有筹码`);
      }
      assert.ok(
        Math.abs((s['foldLikelihood'] as number) + (s['callLikelihood'] as number) + raise - 1) < 1e-12,
        `BB ${stack}BB：三个概率之和必须为 1`,
      );
    }
  }
});

test('P1-4-3【控制组】对手筹码充足时，加注分支必须保留（不得被误杀）', () => {
  const sizes = betSizesOf(riverCheckedToHero(100));
  assert.ok(
    sizes.some((s) => (s['raiseLikelihood'] as number) > 0),
    '对手 100BB 时应当存在「他会加注」的尺寸 ⇒ 修复不得把合法的加注分支一并清零',
  );
  assert.ok(
    sizes.some((s) => s['villainIsAllInByCall'] === false),
    '必须存在「他不会因跟注全下」的尺寸',
  );
});


/* ============================================================
 * 控制组：本次修复**不得**影响没有该缺陷的节点
 * ============================================================ */

test('控制组：对手筹码充足（100BB）的节点，修复前后必须逐位不变', () => {
  /*
   * KQ 节点（D 场景，对手 100BB / 剩余 154）在**修复前**的生产路径实测（独立复核者探针）：
   *   P(弃) = 0.16952719033920757｜P(跟) = 0.6611688848970236｜P(再加注) = 0.16930392476376954
   * 该节点 `villainIsAllInByCall = false` ⇒ 本次修复**不得**触碰它的任何数字。
   */
  const { facts } = decide(SCENARIOS[3]!.input);
  assert.notEqual(facts, null);
  if (facts === null) return;
  assert.equal(facts['reRaiseLikelihood'], 0.16930392476376954, '修复前后必须逐位一致（该节点没有封顶）');
  assert.equal(facts['foldLikelihood'], 0.16952719033920757, '弃牌率逐位一致');
  assert.equal(facts['callLikelihood'], 0.6611688848970236, '跟注率逐位一致');
});
