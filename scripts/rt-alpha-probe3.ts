/**
 * rt-alpha-probe3 —— 攻击 11（多人池退化）+ 攻击 4（信息不足却高置信）+ 攻击 8（概率统计）
 *                   + 攻击 2E（ALL_IN 语义边界）
 */

import { Position, Street } from '../src/domain/types.ts';
import { parseManualInput, QuickProfile } from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';
import { decideAlpha } from '../src/app/decision/decisionEngine.ts';
import { GameEnvironment } from '../src/domain/range/gameEnvironment.ts';
import { computeEquity } from '../src/domain/poker/equity.ts';
import { parseCardCode, cardCodeOf } from '../src/app/manualInput/manualInput.ts';
import { selfCheckPreflopPriors, rfiWeights, rfiTierOf } from '../src/app/manualInput/preflopPriors.ts';
import { selfCheckLikelihoodModel, abnormalLikelihood, normalLikelihood } from '../src/app/manualInput/likelihoodModel.ts';
import { TableSize } from '../src/domain/types.ts';
import { RULES, analyze, hr, show, type Scenario } from './rt-alpha-lib.ts';
import type { ManualHandInput } from '../src/app/manualInput/manualInput.ts';
import type { Card } from '../src/domain/types.ts';

/* ============================================================
 * 攻击 11：多人池
 * ============================================================ */

function multiwayScenario(activeOpponents: number): ManualHandInput {
  // Hero 在 CO 持 AsKd；UTG 开池 3BB，HJ 跟注，BTN 跟注，SB 弃牌，BB 跟注
  // → Hero 面对……不，Hero 是 CO 已经开池过。改成 Hero 在 BB。
  // Hero 是 BB；UTG 开池 3BB；HJ / CO / BTN / SB 按参数决定跟注还是弃牌。
  const history: ManualHandInput['actionHistory'] = [
    { position: Position.UTG, type: 'RAISE', amountBB: 3 },
  ];
  const middle = [Position.HJ, Position.CO, Position.BTN];
  for (let i = 0; i < middle.length; i++) {
    const p = middle[i]!;
    history.push(
      i < activeOpponents - 1
        ? { position: p, type: 'CALL', amountBB: 2 }
        : { position: p, type: 'FOLD' },
    );
  }
  history.push({ position: Position.SB, type: 'FOLD' });
  return {
    tableSize: 6,
    heroPosition: Position.BB,
    heroCards: ['As', 'Kd'],
    board: [],
    street: Street.PREFLOP,
    effectiveStackBB: 100,
    actionHistory: history,
    environment: 'MID_LOW_STAKES',
  };
}

function runMultiway(): void {
  hr('攻击 11：多人池（1 / 2 / 3 名活跃对手）行为');

  for (const opponents of [1, 2, 3]) {
    const scenario = multiwayScenario(opponents);
    const parsed = parseManualInput(scenario);
    if (!parsed.ok) {
      show(`  ${opponents} 名活跃对手`, `PARSE FAIL ${JSON.stringify(parsed.issues)}`);
      continue;
    }
    const gate = buildAnalyzableState(parsed.value);
    if (!gate.ok) {
      show(`  ${opponents} 名活跃对手`, `${gate.stage} FAIL ${JSON.stringify(gate.issues)}`);
      continue;
    }
    const built = buildDecisionContext({
      state: gate.state,
      rules: RULES,
      environment: GameEnvironment.MID_LOW_STAKES,
      asOf: 1_757_000_000_000,
    });
    const d = decideAlpha(built.context, built.legal);

    console.log(
      `  活跃对手=${opponents}  context.activeOpponentCount=${built.context.activeOpponentCount}  ` +
        `范围对手=${built.context.range?.opponentPositionZh ?? 'null'}  ` +
        `范围组合数=${built.context.range?.supportSize ?? 'null'}`,
    );
    console.log(
      `     动作=${d.action} size=${String(d.sizeChips)} 分类=${d.classification} 可执行=${d.actionable} ` +
        `置信度=${d.confidence.toFixed(4)} 权益=${String(d.diagnostics.math.heroEquity)} ` +
        `所需权益=${d.diagnostics.math.requiredEquity.toFixed(4)} 底池=${d.diagnostics.math.pot}`,
    );
    if (d.reasons.length > 0) {
      console.log(`     理由=${JSON.stringify(d.reasons.map((r) => r.textZh).slice(0, 3))}`);
    }
  }
}

/* ============================================================
 * 攻击 4：信息不足却高置信
 * ============================================================ */

function runLowInfoHighConfidence(): void {
  hr('攻击 4：零玩家数据 + 零动态数据 + 启发式范围 → 置信度与分类');

  // 构造一系列「信息极少」的场景，看置信度与分类。
  const cases: { name: string; scenario: ManualHandInput }[] = [];

  // 1) 完全没有 villain 字段，Hero 是 BB，BTN 开池
  cases.push({
    name: '完全没有 villain 字段',
    scenario: {
      tableSize: 6,
      heroPosition: Position.BB,
      heroCards: ['As', 'Kd'],
      board: [],
      street: Street.PREFLOP,
      effectiveStackBB: 100,
      actionHistory: [
        { position: Position.UTG, type: 'FOLD' },
        { position: Position.HJ, type: 'FOLD' },
        { position: Position.CO, type: 'FOLD' },
        { position: Position.BTN, type: 'RAISE', amountBB: 3 },
        { position: Position.SB, type: 'FOLD' },
      ],
      environment: 'MID_LOW_STAKES',
    },
  });

  // 2) villain 全 UNKNOWN
  cases.push({
    name: 'villain 全 UNKNOWN',
    scenario: {
      ...(cases[0]!.scenario as ManualHandInput),
      villain: { quickProfile: 'UNKNOWN', dynamicHint: 'UNKNOWN' },
    },
  });

  // 3) 翻牌前 72o 面对开池（垃圾牌）
  cases.push({
    name: '72o 面对 BTN 开池',
    scenario: { ...(cases[0]!.scenario as ManualHandInput), heroCards: ['7h', '2c'] },
  });

  // 4) 翻牌圈「空气」面对超池下注（用对手范围不可信时的权益）
  cases.push({
    name: '翻牌空气面对 2 倍底池下注',
    scenario: {
      tableSize: 6,
      heroPosition: Position.CO,
      heroCards: ['5c', '4c'],
      board: ['Kh', '9d', '2s'],
      street: Street.FLOP,
      effectiveStackBB: 100,
      actionHistory: [
        { position: Position.UTG, type: 'FOLD' },
        { position: Position.HJ, type: 'FOLD' },
        { position: Position.CO, type: 'RAISE', amountBB: 3 },
        { position: Position.BTN, type: 'FOLD' },
        { position: Position.SB, type: 'FOLD' },
        { position: Position.BB, type: 'CALL', amountBB: 2 },
        { position: Position.BB, type: 'BET', amountBB: 13, street: Street.FLOP },
      ],
      environment: 'MID_LOW_STAKES',
    },
  });

  for (const c of cases) {
    const r = analyze(c.scenario);
    if (!r.ok) {
      console.log(`  ${c.name} → 阻断(${r.stage}) ${r.issues.map((i) => i.code).join(',')}`);
      continue;
    }
    const d = r.decision;
    const p = d.diagnostics.player;
    const rg = d.diagnostics.range;
    console.log(
      `  ${c.name}\n     动作=${d.action} 分类=${d.classification} 档位=${d.band} ` +
        `置信度=${d.confidence.toFixed(4)} 可执行=${d.actionable}\n` +
        `     范围来源=${rg?.sourceKind ?? 'null'} 范围可信度=${rg?.confidence ?? 'null'} ` +
        `组合=${rg?.supportSize ?? 'null'} 更新轨迹条数=${rg?.updateTrace.length ?? 'null'}\n` +
        `     玩家标签=${p?.label ?? 'null'} 手数=${p?.handsObserved ?? 'null'} 中性化=${String(p?.neutralized)} ` +
        `玩家可信度=${p?.confidence ?? 'null'}\n` +
        `     动态 computed=${d.diagnostics.dynamic.computed} state=${d.diagnostics.dynamic.state} ` +
        `conf=${d.diagnostics.dynamic.confidence}`,
    );
  }

  hr('攻击 4B：极端「范围极不可靠」——把对手范围改成极窄/极宽后置信度是否有反馈');

  const base: ManualHandInput = cases[0]!.scenario as ManualHandInput;
  for (const qp of Object.values(QuickProfile)) {
    const r = analyze({ ...base, villain: { quickProfile: qp } });
    if (!r.ok) continue;
    console.log(
      `  quickProfile=${qp.padEnd(16)} → 分类=${r.decision.classification.padEnd(24)} ` +
        `置信度=${r.decision.confidence.toFixed(4)} 档位=${r.decision.band} ` +
        `动作=${r.decision.action} 范围可信度=${r.decision.diagnostics.range?.confidence}`,
    );
  }
}

/* ============================================================
 * 攻击 8：概率与统计正确性
 * ============================================================ */

function runProbabilityChecks(): void {
  hr('攻击 8A：范围先验自检 + 单调性');
  show('  selfCheckPreflopPriors()', selfCheckPreflopPriors());
  show('  selfCheckLikelihoodModel()', selfCheckLikelihoodModel());

  hr('  RFI 档位宽度（权重和）与「位置越靠后越宽」');
  const positions6: Position[] = [
    Position.UTG,
    Position.HJ,
    Position.CO,
    Position.BTN,
    Position.SB,
    Position.BB,
  ];
  for (const p of positions6) {
    const w = rfiWeights(TableSize.SIX_MAX, p as never);
    const sum = Object.values(w).reduce((a, b) => a + b, 0);
    const nonzero = Object.values(w).filter((v) => v > 0).length;
    console.log(`  6人桌 ${p.padEnd(4)} tier=${rfiTierOf(TableSize.SIX_MAX, p).padEnd(13)} 权重和=${sum.toFixed(2)} 非零类别=${nonzero}/169`);
  }

  hr('攻击 8B：类别的「强弱序」是否与似然/权重一致（抽查明显倒挂）');
  const abn = abnormalLikelihood();
  const nrm = normalLikelihood();
  const keys = ['AA', 'KK', 'QQ', 'AKs', 'AKo', 'AQs', '77', '22', 'T9s', '76s', 'KQo', 'A2o', '72o', '32o'];
  for (const k of keys) {
    console.log(`  ${k.padEnd(5)} 进攻似然=${abn(k).toFixed(4)} 被动似然=${nrm(k).toFixed(4)}`);
  }

  hr('攻击 8C：加权抽样是否真的生效（极端范围对照）');
  const hero: Card[] = [parseCardCode('As')!, parseCardCode('Kd')!];
  const board: Card[] = [];

  // 极强范围：只有 AA / KK
  const strongPairs: readonly (readonly [Card, Card])[] = [
    [parseCardCode('Ah')!, parseCardCode('Ac')!],
    [parseCardCode('Ad')!, parseCardCode('Ac')!],
    [parseCardCode('Ah')!, parseCardCode('Ad')!],
    [parseCardCode('Kh')!, parseCardCode('Kc')!],
    [parseCardCode('Kd')!, parseCardCode('Kc')!],
    [parseCardCode('Kh')!, parseCardCode('Kd')!],
  ];
  // 极弱范围：只有 72o / 32o
  const junk: readonly (readonly [Card, Card])[] = [
    [parseCardCode('7h')!, parseCardCode('2c')!],
    [parseCardCode('7d')!, parseCardCode('2c')!],
    [parseCardCode('7h')!, parseCardCode('2d')!],
    [parseCardCode('3h')!, parseCardCode('2c')!],
    [parseCardCode('3d')!, parseCardCode('2c')!],
    [parseCardCode('3h')!, parseCardCode('2d')!],
  ];

  const combosOf = (list: readonly (readonly [Card, Card])[]) => list.map((c) => [c[0], c[1]] as const);
  const seed = 20260913;

  const vsStrong = computeEquity(hero, board, [{ label: '强范围', combos: combosOf(strongPairs) }], {
    seed,
    iterations: 20000,
  });
  const vsJunk = computeEquity(hero, board, [{ label: '弱范围', combos: combosOf(junk) }], {
    seed,
    iterations: 20000,
  });
  show('  AKo vs {AA,KK} 权益', vsStrong.ok ? vsStrong.result.equity : `FAIL ${vsStrong.code}`);
  show('  AKo vs {72o,32o} 权益', vsJunk.ok ? vsJunk.result.equity : `FAIL ${vsJunk.code}`);

  hr('攻击 8D：同一范围，权重 99:1 加权 vs 均匀 —— 是否真的改变权益');
  const mix = [...combosOf(strongPairs), ...combosOf(junk)];
  const uniform = computeEquity(hero, board, [{ label: '混合', combos: mix }], { seed, iterations: 20000 });
  const weighted = computeEquity(hero, board, [{ label: '混合', combos: mix }], {
    seed,
    iterations: 20000,
    opponentWeights: [mix.map((_, i) => (i < strongPairs.length ? 0.99 / strongPairs.length : 0.01 / junk.length))],
  });
  const reverseWeight = computeEquity(hero, board, [{ label: '混合', combos: mix }], {
    seed,
    iterations: 20000,
    opponentWeights: [mix.map((_, i) => (i < strongPairs.length ? 0.01 / strongPairs.length : 0.99 / junk.length))],
  });
  show('  均匀抽样权益', uniform.ok ? uniform.result.equity : `FAIL ${uniform.code}`);
  show('  权重偏向强范围（0.99）权益', weighted.ok ? weighted.result.equity : `FAIL ${weighted.code}`);
  show('  权重偏向弱范围（0.99）权益', reverseWeight.ok ? reverseWeight.result.equity : `FAIL ${reverseWeight.code}`);

  hr('攻击 8E：权益是否随对手范围「变强」单调下降（逐个加入强牌）');
  const cumulative: { label: string; combos: readonly (readonly [Card, Card])[] }[] = [];
  let acc: (readonly [Card, Card])[] = [];
  const ladder: (readonly [Card, Card])[] = [
    [parseCardCode('Ah')!, parseCardCode('Ac')!],
    [parseCardCode('Kh')!, parseCardCode('Kc')!],
    [parseCardCode('Qh')!, parseCardCode('Qc')!],
  ];
  for (const add of ladder) {
    acc = [...acc, add];
    cumulative.push({ label: `${acc.length} 个顶级对子`, combos: acc });
  }
  // 反向：先垃圾再加强牌
  const reverseLadder: { label: string; combos: readonly (readonly [Card, Card])[] }[] = [
    { label: '纯垃圾', combos: combosOf(junk) },
    { label: '垃圾 + 1 个顶级对子', combos: [...combosOf(junk), [parseCardCode('Ah')!, parseCardCode('Ac')!]] },
    { label: '垃圾 + 3 个顶级对子', combos: [...combosOf(junk), ...combosOf(strongPairs)] },
  ];
  for (const c of [...cumulative, ...reverseLadder]) {
    const r = computeEquity(hero, board, [{ label: c.label, combos: combosOf(c.combos) }], {
      seed,
      iterations: 20000,
    });
    console.log(
      `  ${c.label.padEnd(20)} 组合数=${String(c.combos.length).padStart(2)} 权益=${r.ok ? r.result.equity.toFixed(4) : `FAIL ${r.code}`}`,
    );
  }

  hr('攻击 8F：加权抽样在「没有权重」时是否与修复前逐位一致（可复现性）');
  const a = computeEquity(hero, board, [{ label: 'x', combos: combosOf([...strongPairs, ...junk]) }], {
    seed,
    iterations: 5000,
  });
  const b = computeEquity(hero, board, [{ label: 'x', combos: combosOf([...strongPairs, ...junk]) }], {
    seed,
    iterations: 5000,
  });
  show('  两次无权重调用权益是否逐位相等', a.ok && b.ok ? a.result.equity === b.result.equity : 'FAIL');
  show('  无权重 vs 全 1 权重权益', (() => {
    const c = computeEquity(hero, board, [{ label: 'x', combos: combosOf([...strongPairs, ...junk]) }], {
      seed,
      iterations: 5000,
      opponentWeights: [combosOf([...strongPairs, ...junk]).map(() => 1)],
    });
    if (!a.ok || !c.ok) return 'FAIL';
    return `无权重=${a.result.equity} 全1权重=${c.result.equity} 相等=${a.result.equity === c.result.equity}`;
  })());

  hr('攻击 8G：权重非法时的行为（负数 / NaN / 全 0 / 长度不符）');
  const badWeightCases: { name: string; weights: number[][] }[] = [
    { name: '负权重', weights: [mix.map(() => -1)] },
    { name: 'NaN 权重', weights: [mix.map(() => Number.NaN)] },
    { name: '全部 0 权重', weights: [mix.map(() => 0)] },
    { name: '长度短一位', weights: [mix.slice(0, -1).map(() => 1)] },
    { name: '含 Infinity', weights: [mix.map(() => Number.POSITIVE_INFINITY)] },
  ];
  for (const c of badWeightCases) {
    let outcome: string;
    try {
      const r = computeEquity(hero, board, [{ label: 'x', combos: mix }], {
        seed,
        iterations: 2000,
        opponentWeights: c.weights,
      });
      outcome = r.ok ? `ok 权益=${r.result.equity}` : `cannotCompute ${r.code} ${JSON.stringify(r.params)}`;
    } catch (e) {
      outcome = `THROW ${(e as Error).message}`;
    }
    console.log(`  ${c.name.padEnd(12)} → ${outcome}`);
  }
}

/* ============================================================
 * 攻击 2E：ALL_IN 语义边界（精确复现）
 * ============================================================ */

function runAllInSemantics(): void {
  hr('攻击 2E：对手全下的录入路径（ALL_IN 的 amountBB 语义冲突）');

  // 场景：6 人桌，UTG 短筹码（8BB）全下，其余弃牌到 Hero（CO）
  // 用户视角：把 villain.stackBB 记为 8（UTG 起始筹码 8BB），行动记 ALL_IN
  for (const villainStack of [8, undefined] as const) {
    const scenario: ManualHandInput = {
      tableSize: 6,
      heroPosition: Position.CO,
      heroCards: ['As', 'Kd'],
      board: [],
      street: Street.PREFLOP,
      effectiveStackBB: 100,
      actionHistory: [
        { position: Position.UTG, type: 'ALL_IN' },
        { position: Position.HJ, type: 'FOLD' },
      ],
      environment: 'MID_LOW_STAKES',
      ...(villainStack !== undefined ? { villain: { stackBB: villainStack } } : {}),
    };
    const r = analyze(scenario);
    console.log(
      `  villain.stackBB=${String(villainStack).padEnd(8)} ALL_IN 不带金额 → ` +
        (r.ok
          ? `建议 ${r.decision.action} size=${String(r.decision.sizeChips)} 底池=${r.decision.diagnostics.math.pot} ` +
            `callCost=${r.decision.diagnostics.math.callCost} 权益=${String(r.decision.diagnostics.math.heroEquity)}`
          : `阻断(${r.stage}) ${r.issues.map((i) => `${i.code}: ${i.message}`).join(' | ')}`),
    );
  }

  // 用户按文档语义填「加注到的总额」= 他自己看到的全下额（8BB），但 stackBB 未填
  {
    const scenario: ManualHandInput = {
      tableSize: 6,
      heroPosition: Position.CO,
      heroCards: ['As', 'Kd'],
      board: [],
      street: Street.PREFLOP,
      effectiveStackBB: 100,
      actionHistory: [
        { position: Position.UTG, type: 'ALL_IN', amountBB: 8 },
        { position: Position.HJ, type: 'FOLD' },
      ],
      environment: 'MID_LOW_STAKES',
    };
    const r = analyze(scenario);
    console.log(
      `  用户按「全下 8BB」录入（amountBB=8，未填 stackBB） → ` +
        (r.ok ? `建议 ${r.decision.action}` : `阻断(${r.stage}) ${r.issues.map((i) => i.message).join(' | ')}`),
    );
  }

  // 全下额恰好等于 100BB → 能通过吗？
  {
    const scenario: ManualHandInput = {
      tableSize: 6,
      heroPosition: Position.CO,
      heroCards: ['As', 'Kd'],
      board: [],
      street: Street.PREFLOP,
      effectiveStackBB: 100,
      actionHistory: [
        { position: Position.UTG, type: 'ALL_IN', amountBB: 100 },
        { position: Position.HJ, type: 'FOLD' },
      ],
      environment: 'MID_LOW_STAKES',
    };
    const r = analyze(scenario);
    console.log(
      `  全下额恰好 100BB（= 起始筹码） → ` +
        (r.ok
          ? `建议 ${r.decision.action} 底池=${r.decision.diagnostics.math.pot} callCost=${r.decision.diagnostics.math.callCost}`
          : `阻断(${r.stage}) ${r.issues.map((i) => i.message).join(' | ')}`),
    );
  }

  // RAISE 超过对手筹码
  {
    const scenario: ManualHandInput = {
      tableSize: 6,
      heroPosition: Position.CO,
      heroCards: ['As', 'Kd'],
      board: [],
      street: Street.PREFLOP,
      effectiveStackBB: 100,
      villain: { stackBB: 20 },
      actionHistory: [
        { position: Position.UTG, type: 'FOLD' },
        { position: Position.HJ, type: 'FOLD' },
        { position: Position.BTN, type: 'RAISE', amountBB: 8 },
        { position: Position.SB, type: 'FOLD' },
      ],
      environment: 'MID_LOW_STAKES',
    };
    const r = analyze(scenario);
    console.log(
      `  对手只有 20BB，Hero 100BB，面对 8BB 开池 → ` +
        (r.ok
          ? `建议 ${r.decision.action} size=${String(r.decision.sizeChips)} ` +
            `有效筹码=${r.decision.diagnostics.math.effectiveStack} 底池=${r.decision.diagnostics.math.pot} ` +
            `合法=[${r.decision.diagnostics.legalActions.join(',')}]`
          : `阻断(${r.stage})`),
    );
  }
}

/* ============================================================
 * main
 * ============================================================ */

console.log(`知识库规则数=${RULES.length}`);
void cardCodeOf;
void show;

runMultiway();
runLowInfoHighConfidence();
runProbabilityChecks();
runAllInSemantics();
