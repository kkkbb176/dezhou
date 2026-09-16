/**
 * rt-alpha-probe4 —— 攻击 8（自检失败精确复现）+ 攻击 11（多人池，修正跟注额）
 *                   + 攻击 2F（全下应对）+ 攻击 4（BB 开池范围档位）
 */

import { Position, Street, TableSize } from '../src/domain/types.ts';
import { parseManualInput } from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';
import { decideAlpha } from '../src/app/decision/decisionEngine.ts';
import { GameEnvironment } from '../src/domain/range/gameEnvironment.ts';
import {
  selfCheckLikelihoodModel,
  abnormalLikelihood,
  normalLikelihood,
  defaultRankClassIndex,
  DEFAULT_TOTAL_CLASSES,
} from '../src/app/manualInput/likelihoodModel.ts';
import { allRankClassKeys, rfiWeights, rfiTierOf } from '../src/app/manualInput/preflopPriors.ts';
import { RULES, analyze, hr, type Scenario } from './rt-alpha-lib.ts';
import type { ManualHandInput } from '../src/app/manualInput/manualInput.ts';

/* ============================================================
 * 攻击 8H：似然模型自检失败的精确复现
 * ============================================================ */

function runLikelihoodSelfCheck(): void {
  hr('攻击 8H：likelihoodModel.selfCheckLikelihoodModel() 是否通过？');

  const problems = selfCheckLikelihoodModel();
  console.log(`  返回值 = ${JSON.stringify(problems)}`);
  console.log(`  结果 = ${problems.length === 0 ? '通过 ✔' : `**失败 ✘（${problems.length} 项）**`}`);

  const keys = allRankClassKeys();
  const abn = abnormalLikelihood();
  const nrm = normalLikelihood();

  console.log(`\n  类别总数 = ${keys.length}（DEFAULT_TOTAL_CLASSES=${DEFAULT_TOTAL_CLASSES}）`);
  console.log(`  顶级（KEYS[0]） = ${keys[0]}  垃圾（KEYS[last]） = ${keys[keys.length - 1]}`);
  console.log(`  abnormal(top)=${abn(keys[0]!)}  abnormal(junk)=${abn(keys[keys.length - 1]!)}`);
  console.log(`  normal(top)=${nrm(keys[0]!)}    normal(junk)=${nrm(keys[keys.length - 1]!)}`);
  console.log(
    `  → 断言「被动性似然 junk > top」：${nrm(keys[keys.length - 1]!) > nrm(keys[0]!) ? '成立' : '**不成立**'}`,
  );

  console.log('\n  被动（NORMAL）似然表（169 类的取值集合）：');
  const passDistinct = new Map<number, string[]>();
  for (const k of keys) {
    const v = nrm(k);
    const list = passDistinct.get(v) ?? [];
    list.push(k);
    passDistinct.set(v, list);
  }
  for (const [v, ks] of [...passDistinct].sort((a, b) => b[0] - a[0])) {
    console.log(`    ${v.toFixed(4)}  共 ${String(ks.length).padStart(3)} 类  例：${ks.slice(0, 10).join(' ')}${ks.length > 10 ? ' …' : ''}`);
  }

  console.log('\n  明显不合理的档位（同档位内混入强弱极端）：');
  for (const key of ['72o', '32o', '22', 'AKo', 'AA', 'QQ', 'T9s', '76s']) {
    console.log(
      `    ${key.padEnd(5)} index=${String(defaultRankClassIndex(key)).padStart(3)} ` +
        `进攻=${abn(key).toFixed(4)} 被动=${nrm(key).toFixed(4)}`,
    );
  }

  // 断言「进攻似然应随牌力单调不增」
  console.log('\n  进攻似然 vs 牌力序的倒挂检查（前面应 ≥ 后面）：');
  let inversions = 0;
  for (let i = 1; i < keys.length; i++) {
    const prev = abn(keys[i - 1]!);
    const cur = abn(keys[i]!);
    if (cur > prev + 1e-12) {
      inversions += 1;
      if (inversions <= 12) {
        console.log(`    ${keys[i - 1]}(${prev.toFixed(4)}) < ${keys[i]}(${cur.toFixed(4)})`);
      }
    }
  }
  console.log(`  进攻似然的倒挂数 = ${inversions} / ${keys.length - 1} 个相邻对`);

  let pInversions = 0;
  for (let i = 1; i < keys.length; i++) {
    const prev = nrm(keys[i - 1]!);
    const cur = nrm(keys[i]!);
    if (cur < prev - 1e-12) {
      pInversions += 1;
      if (pInversions <= 12) {
        console.log(`    被动 ${keys[i - 1]}(${prev.toFixed(4)}) > ${keys[i]}(${cur.toFixed(4)})`);
      }
    }
  }
  console.log(`  被动似然的倒挂数 = ${pInversions} / ${keys.length - 1} 个相邻对（被动应当随牌力递减，即后面 ≥ 前面）`);
}

/* ============================================================
 * 攻击 11：多人池（修正 CALL 金额）
 * ============================================================ */

function multiwayScenarios(): { name: string; scenario: ManualHandInput; expectOpponents: number }[] {
  const out: { name: string; scenario: ManualHandInput; expectOpponents: number }[] = [];

  // Hero 在 BB。UTG 开池 3BB；HJ / CO / BTN 按参数决定跟注（3BB）还是弃牌。
  const build = (callers: Position[], name: string) => {
    const history: ManualHandInput['actionHistory'] = [{ position: Position.UTG, type: 'RAISE', amountBB: 3 }];
    for (const p of [Position.HJ, Position.CO, Position.BTN]) {
      history.push(
        callers.includes(p) ? { position: p, type: 'CALL', amountBB: 3 } : { position: p, type: 'FOLD' },
      );
    }
    history.push({ position: Position.SB, type: 'FOLD' });
    out.push({
      name,
      expectOpponents: 1 + callers.length,
      scenario: {
        tableSize: 6,
        heroPosition: Position.BB,
        heroCards: ['As', 'Kd'],
        board: [],
        street: Street.PREFLOP,
        effectiveStackBB: 100,
        actionHistory: history,
        environment: 'MID_LOW_STAKES',
      },
    });
  };

  build([], '1 名活跃对手（UTG 开池，其余弃牌）');
  build([Position.HJ], '2 名活跃对手（UTG 开池 + HJ 跟注）');
  build([Position.HJ, Position.CO], '3 名活跃对手（UTG 开池 + HJ/CO 跟注）');
  build([Position.CO, Position.BTN], '3 名活跃对手（UTG + CO/BTN 跟注）');
  return out;
}

function runMultiway(): void {
  hr('攻击 11：多人池 —— 是否明确返回信息不足（不得偷偷退化为单挑）');

  for (const { name, scenario, expectOpponents } of multiwayScenarios()) {
    const parsed = parseManualInput(scenario);
    if (!parsed.ok) {
      console.log(`  ${name}\n     PARSE FAIL ${JSON.stringify(parsed.issues)}`);
      continue;
    }
    const gate = buildAnalyzableState(parsed.value);
    if (!gate.ok) {
      console.log(`  ${name}\n     ${gate.stage} FAIL ${JSON.stringify(gate.issues)}`);
      continue;
    }
    const built = buildDecisionContext({
      state: gate.state,
      rules: RULES,
      environment: GameEnvironment.MID_LOW_STAKES,
      asOf: 1_757_000_000_000,
    });
    const d = decideAlpha(built.context, built.legal);

    console.log(`  ${name}`);
    console.log(
      `     期望活跃对手=${expectOpponents} 实际=${built.context.activeOpponentCount}  ` +
        `范围只针对=${built.context.range?.opponentPositionZh ?? 'null'}（组合 ${built.context.range?.supportSize ?? 'null'}）`,
    );
    console.log(
      `     动作=${d.action} 可执行=${d.actionable} 分类=${d.classification} ` +
        `置信度=${d.confidence.toFixed(4)} 底池=${d.diagnostics.math.pot} ` +
        `权益=${String(d.diagnostics.math.heroEquity)} 所需=${d.diagnostics.math.requiredEquity.toFixed(4)}`,
    );
    console.log(`     理由=${JSON.stringify(d.reasons.map((r) => r.textZh).slice(0, 2))}`);
  }
}

/* ============================================================
 * 攻击 2F：全下应对
 * ============================================================ */

function allInScenarios(): { name: string; scenario: ManualHandInput }[] {
  // 6 人桌：UTG 全下 N BB（起始筹码 N BB），其余弃牌到 Hero（CO）
  const build = (heroCards: readonly [string, string], shoveBB: number): ManualHandInput => ({
    tableSize: 6,
    heroPosition: Position.CO,
    heroCards,
    board: [],
    street: Street.PREFLOP,
    effectiveStackBB: 100,
    actionHistory: [
      { position: Position.UTG, type: 'ALL_IN', amountBB: shoveBB },
      { position: Position.HJ, type: 'FOLD' },
    ],
    environment: 'MID_LOW_STAKES',
    villain: { stackBB: shoveBB },
  });
  return [
    { name: 'AA 面对 UTG 10BB 全下', scenario: build(['As', 'Ad'], 10) },
    { name: 'AKo 面对 UTG 10BB 全下', scenario: build(['As', 'Kd'], 10) },
    { name: 'AA 面对 UTG 100BB 全下', scenario: build(['As', 'Ad'], 100) },
    { name: 'AKo 面对 UTG 100BB 全下', scenario: build(['As', 'Kd'], 100) },
    { name: 'KK 面对 UTG 100BB 全下', scenario: build(['Kh', 'Kd'], 100) },
    { name: 'QQ 面对 UTG 100BB 全下', scenario: build(['Qh', 'Qd'], 100) },
    { name: '77 面对 UTG 100BB 全下', scenario: build(['7h', '7d'], 100) },
    { name: '22 面对 UTG 30BB 全下', scenario: build(['2h', '2d'], 30) },
    { name: 'AKo 面对 UTG 30BB 全下', scenario: build(['As', 'Kd'], 30) },
    { name: '72o 面对 UTG 10BB 全下', scenario: build(['7h', '2c'], 10) },
  ];
}

function runAllInResponse(): void {
  hr('攻击 2F：面对全下时的建议（AA / KK / AKo 会不会被建议弃牌）');

  for (const { name, scenario } of allInScenarios()) {
    const r = analyze(scenario);
    if (!r.ok) {
      console.log(`  ${name} → 阻断(${r.stage}) ${r.issues.map((i) => i.message).join(' | ')}`);
      continue;
    }
    const m = r.decision.diagnostics.math;
    const need = m.callCost / (m.pot + m.callCost);
    console.log(
      `  ${name}\n     动作=${r.decision.action} 分类=${r.decision.classification} ` +
        `置信度=${r.decision.confidence.toFixed(4)} 可执行=${r.decision.actionable}\n` +
        `     底池=${m.pot} 需投入=${m.callCost} 所需权益=${(m.requiredEquity * 100).toFixed(2)}% ` +
        `（手算 ${(need * 100).toFixed(2)}%）估计权益=${m.heroEquity === null ? 'null' : (m.heroEquity * 100).toFixed(2)}% ` +
        `跟注EV=${m.callEV === null ? 'null' : m.callEV.toFixed(2)}\n` +
        `     范围组合=${String(r.decision.diagnostics.range?.supportSize)} ` +
        `范围来源=${String(r.decision.diagnostics.range?.sourceKind)} ` +
        `理由=${JSON.stringify(r.decision.reasons.map((x) => x.textZh).slice(0, 2))}`,
    );
  }
}

/* ============================================================
 * 攻击 4C：位置 → 范围档位映射（BB / SB 的正确性）
 * ============================================================ */

function runPositionTierMapping(): void {
  hr('攻击 4C：rfiTierOf 对「非开池场景」的位置是否给出错误档位');

  for (const p of [Position.UTG, Position.HJ, Position.CO, Position.BTN, Position.SB, Position.BB]) {
    const tier = rfiTierOf(TableSize.SIX_MAX, p);
    const w = rfiWeights(TableSize.SIX_MAX, p);
    const sum = Object.values(w).reduce((a, b) => a + b, 0);
    console.log(`  位置 ${p.padEnd(4)} → 档位 ${tier.padEnd(13)} 权重和 ${sum.toFixed(2)}`);
  }
  console.log('  （BB 位在 6 人桌没有独立档位，落到默认 BUTTON）');

  hr('攻击 4D：Hero 在 BB 加注（非开池）时，对手范围被当成什么？');

  // Hero 在 BB，BTN 溜入，Hero 加注到 5BB，BTN 跟注 → 翻牌 Hero 面对 BTN
  const scenario: ManualHandInput = {
    tableSize: 6,
    heroPosition: Position.CO,
    heroCards: ['As', 'Kd'],
    board: [],
    street: Street.PREFLOP,
    effectiveStackBB: 100,
    actionHistory: [
      { position: Position.UTG, type: 'FOLD' },
      { position: Position.HJ, type: 'FOLD' },
      { position: Position.CO, type: 'CALL', amountBB: 1 },
      { position: Position.BTN, type: 'CALL', amountBB: 1 },
      { position: Position.SB, type: 'FOLD' },
      { position: Position.BB, type: 'RAISE', amountBB: 5 },
      { position: Position.CO, type: 'FOLD' },
      { position: Position.BTN, type: 'CALL', amountBB: 4 },
    ],
    environment: 'MID_LOW_STAKES',
  };
  const r = analyze(scenario);
  if (r.ok) {
    console.log(`  Hero=CO 面对 BB 的加注：动作=${r.decision.action}`);
    console.log(
      `     范围来源说明=${r.decision.diagnostics.range?.sourceDescription}\n` +
        `     范围组合数=${r.decision.diagnostics.range?.supportSize} 更新轨迹=${r.decision.diagnostics.range?.updateTrace.length}`,
    );
  } else {
    console.log(`  失败(${r.stage}) ${JSON.stringify(r.issues)}`);
  }

  // 对照：Hero 在 CO，BB 3bet，看 BB 的范围来源说明
  const threeBet: ManualHandInput = {
    tableSize: 6,
    heroPosition: Position.CO,
    heroCards: ['As', 'Kd'],
    board: [],
    street: Street.PREFLOP,
    effectiveStackBB: 100,
    actionHistory: [
      { position: Position.UTG, type: 'FOLD' },
      { position: Position.HJ, type: 'FOLD' },
      { position: Position.CO, type: 'RAISE', amountBB: 3 },
      { position: Position.BTN, type: 'FOLD' },
      { position: Position.SB, type: 'FOLD' },
      { position: Position.BB, type: 'RAISE', amountBB: 10 },
    ],
    environment: 'MID_LOW_STAKES',
  };
  const r2 = analyze(threeBet);
  if (r2.ok) {
    console.log(`  Hero=CO 面对 BB 3bet：动作=${r2.decision.action}`);
    console.log(`     范围来源说明=${r2.decision.diagnostics.range?.sourceDescription}`);
    console.log(`     范围组合数=${r2.decision.diagnostics.range?.supportSize}`);
    console.log(`     权益=${String(r2.decision.diagnostics.math.heroEquity)}`);
  } else {
    console.log(`  失败(${r2.stage}) ${JSON.stringify(r2.issues)}`);
  }
}

/* ============================================================
 * main
 * ============================================================ */

console.log(`知识库规则数=${RULES.length}`);
void ((): Scenario | null => null);

runLikelihoodSelfCheck();
runMultiway();
runAllInResponse();
runPositionTierMapping();
