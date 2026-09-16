/**
 * rt-alpha-probe6 —— 攻击 10（分类 × 置信度联合分布、幂等真相）+ 攻击 3D（死字段）
 *                   + 攻击 7C（日志哈希碰撞）+ 攻击 11（9 人桌 2/3 对手）
 */

import { Position, Street } from '../src/domain/types.ts';
import { DECISION_ACTION_ZH, confidenceBandOf } from '../src/domain/decision/decision.types.ts';
import { toDecisionViewModel } from '../src/viewmodels/decisionViewModel.ts';
import { hashManualInput } from '../src/app/alphaPipeline.ts';
import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';
import { parseManualInput } from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import { decideAlpha } from '../src/app/decision/decisionEngine.ts';
import { GameEnvironment } from '../src/domain/range/gameEnvironment.ts';
import { RULES, analyze, fingerprint, hr, type Scenario } from './rt-alpha-lib.ts';
import type { ManualHandInput } from '../src/app/manualInput/manualInput.ts';

/** 造一批互相独立的场景，覆盖四条街与多种牌力 */
function corpus(): { name: string; scenario: Scenario }[] {
  const out: { name: string; scenario: Scenario }[] = [];
  const preflopHistory = (openBB: number) => [
    { position: Position.UTG, type: 'FOLD' as const },
    { position: Position.HJ, type: 'FOLD' as const },
    { position: Position.CO, type: 'FOLD' as const },
    { position: Position.BTN, type: 'RAISE' as const, amountBB: openBB },
    { position: Position.SB, type: 'FOLD' as const },
  ];

  const hands: readonly [string, string][] = [
    ['As', 'Ad'],
    ['As', 'Kd'],
    ['7h', '7d'],
    ['Js', 'Td'],
    ['5c', '4c'],
    ['7h', '2c'],
  ];
  for (const h of hands) {
    out.push({
      name: `翻牌前 ${h.join('')} vs BTN 开池 3BB`,
      scenario: {
        tableSize: 6,
        heroPosition: Position.BB,
        heroCards: h,
        board: [],
        street: Street.PREFLOP,
        effectiveStackBB: 100,
        actionHistory: preflopHistory(3),
        environment: 'MID_LOW_STAKES',
      },
    });
  }

  const boards = [
    ['Kh', '7c', '2d'],
    ['9s', '8s', '2h'],
    ['2c', '3d', '4h'],
    ['Qs', 'Js', 'Ts'],
  ];
  const flopHands: readonly [string, string][] = [
    ['As', 'Kd'],
    ['Ah', 'Ac'],
    ['8h', '8d'],
    ['5h', '4h'],
    ['7h', '2c'],
  ];
  for (const b of boards) {
    for (const h of flopHands) {
      const overlap = h.some((c) => b.includes(c));
      const acesOverlap = h[0] === 'Ah' && b[0] === '2c';
      if (overlap || acesOverlap) continue;
      out.push({
        name: `翻牌过牌到 Hero ${h.join('')}@${b.join('')}`,
        scenario: {
          tableSize: 6,
          heroPosition: Position.CO,
          heroCards: h,
          board: b,
          street: Street.FLOP,
          effectiveStackBB: 100,
          actionHistory: [
            { position: Position.UTG, type: 'FOLD' },
            { position: Position.HJ, type: 'FOLD' },
            { position: Position.CO, type: 'RAISE', amountBB: 3 },
            { position: Position.BTN, type: 'FOLD' },
            { position: Position.SB, type: 'FOLD' },
            { position: Position.BB, type: 'CALL', amountBB: 2 },
            { position: Position.BB, type: 'CHECK', street: Street.FLOP },
          ],
          environment: 'MID_LOW_STAKES',
        },
      });
      out.push({
        name: `翻牌面对 6BB 下注 ${h.join('')}@${b.join('')}`,
        scenario: {
          tableSize: 6,
          heroPosition: Position.CO,
          heroCards: h,
          board: b,
          street: Street.FLOP,
          effectiveStackBB: 100,
          actionHistory: [
            { position: Position.UTG, type: 'FOLD' },
            { position: Position.HJ, type: 'FOLD' },
            { position: Position.CO, type: 'RAISE', amountBB: 3 },
            { position: Position.BTN, type: 'FOLD' },
            { position: Position.SB, type: 'FOLD' },
            { position: Position.BB, type: 'CALL', amountBB: 2 },
            { position: Position.BB, type: 'BET', amountBB: 6, street: Street.FLOP },
          ],
          environment: 'MID_LOW_STAKES',
        },
      });
    }
  }
  return out;
}

/* ============================================================
 * 攻击 10D：分类 × 置信度联合分布
 * ============================================================ */

function runClassificationBandMatrix(): void {
  hr('攻击 10D：分类 × 置信度档位 联合分布（「明确决策」是否出现在低置信度）');

  const matrix = new Map<string, number>();
  const examples = new Map<string, string[]>();
  let total = 0;

  for (const { name, scenario } of corpus()) {
    const r = analyze(scenario);
    if (!r.ok) continue;
    total += 1;
    const key = `${r.decision.classification} × ${r.decision.band}（置信度 ${r.decision.confidence.toFixed(2)}）`;
    matrix.set(key, (matrix.get(key) ?? 0) + 1);
    const list = examples.get(key) ?? [];
    if (list.length < 3) list.push(name);
    examples.set(key, list);
  }

  console.log(`  可分析样本数 = ${total}`);
  const rows = [...matrix].sort((a, b) => b[1] - a[1]);
  for (const [key, count] of rows) {
    console.log(`    ${key.padEnd(58)} ${String(count).padStart(3)} 次   例：${examples.get(key)!.join(' / ')}`);
  }

  // 重点：CLEAR 但档位 ≤ MEDIUM_LOW
  let clearLowBand = 0;
  let clearLowBandExamples: string[] = [];
  for (const { name, scenario } of corpus()) {
    const r = analyze(scenario);
    if (!r.ok) continue;
    if (r.decision.classification === 'CLEAR' && (r.decision.band === 'LOW' || r.decision.band === 'MEDIUM_LOW')) {
      clearLowBand += 1;
      if (clearLowBandExamples.length < 5) {
        clearLowBandExamples.push(`${name}（${r.decision.band} ${r.decision.confidence.toFixed(2)}，动作 ${r.decision.action}）`);
      }
    }
  }
  console.log(`\n  **「明确决策」+ 低/中低置信度 = ${clearLowBand} / ${total}**`);
  for (const e of clearLowBandExamples) console.log(`    · ${e}`);
}

/* ============================================================
 * 攻击 10E：ViewModel 幂等的真相（不截断）
 * ============================================================ */

function runViewModelIdempotencyTruth(): void {
  hr('攻击 10E：ViewModel 幂等性 —— 精确定位差异');

  for (const { name, scenario } of corpus().slice(0, 6)) {
    const r = analyze(scenario);
    if (!r.ok) continue;
    const dp = JSON.parse(fingerprint(r.decision)) as Record<string, unknown>;
    const vp = JSON.parse(fingerprint(r.viewModel)) as Record<string, unknown>;
    void dp;
    console.log(`  ${name}`);
    console.log(`     VM.debug.timing = ${JSON.stringify((vp['debug'] as Record<string, unknown>)['timing'])}`);
    console.log(`     pipeline timings = ${JSON.stringify(r.timings)}`);

    const recomputed = toDecisionViewModel(r.decision, r.warnings, r.timings);
    const ra = JSON.parse(fingerprint(recomputed));
    const rb = JSON.parse(fingerprint(r.viewModel));
    const equal = JSON.stringify(ra) === JSON.stringify(rb);
    console.log(`     用管线 timings 重算 → 与管线返回是否完全一致：${equal ? '✔ 是' : '✘ 否'}`);
    if (!equal) {
      const a = ra as Record<string, unknown>;
      const b = rb as Record<string, unknown>;
      for (const key of Object.keys(a)) {
        if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) {
          const av = JSON.stringify(a[key]);
          const bv = JSON.stringify(b[key]);
          let i = 0;
          while (i < av.length && i < bv.length && av[i] === bv[i]) i++;
          console.log(`       差异字段 ${key}：首个不同位置 ${i}`);
          console.log(`         重算 …${av.slice(Math.max(0, i - 60), i + 120)}`);
          console.log(`         管线 …${bv.slice(Math.max(0, i - 60), i + 120)}`);
        }
      }
    }
  }
}

/* ============================================================
 * 攻击 3D：bigBlindBB 死字段
 * ============================================================ */

function runDeadFields(): void {
  hr('攻击 3D：bigBlindBB / villains / opponentCount 是否真正生效（死字段检查）');

  const base: ManualHandInput = {
    tableSize: 6,
    heroPosition: Position.BB,
    heroCards: ['As', 'Ad'],
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
  };

  console.log('  --- bigBlindBB（界面允许用户填大盲）---');
  const fps = new Map<string, number[]>();
  for (const bigBlindBB of [1, 2, 10, 0.01]) {
    const r = analyze({ ...base, bigBlindBB });
    if (!r.ok) {
      console.log(`    bigBlindBB=${bigBlindBB} → 阻断(${r.stage})`);
      continue;
    }
    const fp = fingerprint({
      action: r.decision.action,
      size: r.decision.sizeChips ?? null,
      math: r.decision.diagnostics.math,
      vm: r.viewModel,
    });
    const list = fps.get(fp) ?? [];
    list.push(bigBlindBB);
    fps.set(fp, list);
    console.log(
      `    bigBlindBB=${String(bigBlindBB).padEnd(5)} → 动作=${r.decision.action} size=${String(r.decision.sizeChips)} ` +
        `math.bigBlind=${r.decision.diagnostics.math.bigBlind} viewModel尺寸=${String(r.viewModel.sizeZh)}`,
    );
  }
  console.log(`    → 不同指纹数 = ${fps.size}（若为 1，说明 bigBlindBB 对输出**完全无效**）`);

  console.log('\n  --- villain.playerId 是否影响范围/决策 ---');
  for (const playerId of [undefined, 'villain-A', 'villain-B']) {
    const r = analyze({ ...base, villain: { quickProfile: 'NORMAL', ...(playerId !== undefined ? { playerId } : {}) } });
    if (!r.ok) continue;
    console.log(
      `    playerId=${String(playerId).padEnd(10)} → 动作=${r.decision.action} ` +
        `范围对象=${r.decision.diagnostics.range?.opponentId} 玩家对象=${r.decision.diagnostics.player?.playerId}`,
    );
  }
}

/* ============================================================
 * 攻击 11B：9 人桌 2 / 3 名活跃对手
 * ============================================================ */

function nineMax(extraCallers: number): ManualHandInput {
  // Hero 在 HJ（不是 BB），这样翻牌圈 Hero 先行动（BTN 之后……）
  // 实际 postflop 顺序：SB, BB, UTG, UTG1, UTG2, LJ, HJ, CO, BTN
  // Hero = HJ，所以需要 SB/BB/UTG/UTG1/UTG2/LJ 都弃牌或过牌。
  // 简化：Hero 在 BB，翻牌圈 Hero 先行动 → 让 Hero 过牌后轮到别人即可。
  // 这里改成：翻牌前轮到 Hero（BB），BB 是 preflop 最后行动者，天然是可分析点。
  const history: ManualHandInput['actionHistory'] = [
    { position: Position.UTG, type: 'FOLD' },
    { position: Position.UTG1, type: 'FOLD' },
    { position: Position.UTG2, type: 'FOLD' },
    { position: Position.LJ, type: 'FOLD' },
    { position: Position.HJ, type: 'RAISE', amountBB: 3 },
    { position: Position.CO, type: 'FOLD' },
    { position: Position.BTN, type: 'FOLD' },
    { position: Position.SB, type: 'FOLD' },
  ];
  // 插入 extraCallers 个跟注者（在 HJ 之后、CO 之前）
  const inserted: ManualHandInput['actionHistory'] = [];
  for (const a of history) {
    inserted.push(a);
    if (a.position === Position.HJ && extraCallers > 0) {
      inserted.push({ position: Position.CO, type: 'CALL', amountBB: 3 });
      if (extraCallers > 1) inserted.push({ position: Position.BTN, type: 'CALL', amountBB: 3 });
    }
  }
  return {
    tableSize: 9,
    heroPosition: Position.BB,
    heroCards: ['As', 'Ad'],
    board: [],
    street: Street.PREFLOP,
    effectiveStackBB: 200,
    actionHistory: inserted,
    environment: 'MID_LOW_STAKES',
  };
}

function runNineMax(): void {
  hr('攻击 11B：9 人桌 1 / 2 / 3 名活跃对手');

  for (const callers of [0, 1, 2]) {
    const scenario = nineMax(callers);
    const parsed = parseManualInput(scenario);
    if (!parsed.ok) {
      console.log(`  ${callers + 1} 名活跃对手：PARSE FAIL ${JSON.stringify(parsed.issues)}`);
      continue;
    }
    const gate = buildAnalyzableState(parsed.value);
    if (!gate.ok) {
      console.log(`  ${callers + 1} 名活跃对手：${gate.stage} FAIL ${JSON.stringify(gate.issues)}`);
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
      `  ${callers + 1} 名活跃对手：activeOpponentCount=${built.context.activeOpponentCount} ` +
        `范围针对=${built.context.range?.opponentPositionZh} 组合=${built.context.range?.supportSize}`,
    );
    console.log(
      `     动作=${d.action} 可执行=${d.actionable} 分类=${d.classification} 置信度=${d.confidence.toFixed(4)} ` +
        `底池=${d.diagnostics.math.pot} 权益=${String(d.diagnostics.math.heroEquity)} ` +
        `所需=${d.diagnostics.math.requiredEquity.toFixed(4)} AA`,
    );
    if (!d.actionable) {
      console.log(`     ViewModel 会显示：${JSON.stringify(toDecisionViewModel(d, []).actionZh)}，但 decision.action=${d.action}「${DECISION_ACTION_ZH[d.action]}」`);
    }
  }
}

/* ============================================================
 * 攻击 7C：日志哈希是否覆盖全部输入
 * ============================================================ */

function runHashCoverage(): void {
  hr('攻击 7C：hashManualInput 是否覆盖全部影响结果的输入');

  const base: ManualHandInput = {
    tableSize: 6,
    heroPosition: Position.BB,
    heroCards: ['As', 'Ad'],
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
  };

  const baseHash = hashManualInput(base);
  console.log(`  基准哈希 = ${baseHash}`);

  const variants: { name: string; input: ManualHandInput; changesDecision: boolean }[] = [
    { name: 'bigBlindBB=2', input: { ...base, bigBlindBB: 2 }, changesDecision: false },
    { name: 'villain.stackBB=20', input: { ...base, villain: { stackBB: 20 } }, changesDecision: true },
    { name: 'villain.playerId="x"', input: { ...base, villain: { playerId: 'x' } }, changesDecision: true },
    {
      name: 'actionHistory[0].street=PREFLOP（显式写 street）',
      input: {
        ...base,
        actionHistory: base.actionHistory.map((a) => ({ ...a, street: Street.PREFLOP })),
      },
      changesDecision: false,
    },
    {
      name: 'villains=[两个对手]（第 2 个被忽略）',
      input: { ...base, villains: [{ quickProfile: 'NORMAL' }, { quickProfile: 'MANIAC' }] },
      changesDecision: false,
    },
  ];

  for (const v of variants) {
    const h = hashManualInput(v.input);
    const r = analyze(v.input);
    let decisionFp = 'BLOCKED';
    if (r.ok) {
      decisionFp = fingerprint({
        action: r.decision.action,
        size: r.decision.sizeChips ?? null,
        math: r.decision.diagnostics.math,
      });
    }
    const rb = analyze(base);
    const baseFp = rb.ok
      ? fingerprint({ action: rb.decision.action, size: rb.decision.sizeChips ?? null, math: rb.decision.diagnostics.math })
      : 'BLOCKED';
    console.log(
      `  ${v.name.padEnd(42)} 哈希${h === baseHash ? '相同 ✘' : '不同 ✔'}  ` +
        `决策${decisionFp === baseFp ? '相同' : '不同'}`,
    );
  }
  console.log('  （哈希相同但决策不同 = 日志无法区分两个不同的建议）');
}

/* ============================================================
 * main
 * ============================================================ */

console.log(`知识库规则数=${RULES.length}`);

runClassificationBandMatrix();
runViewModelIdempotencyTruth();
runDeadFields();
runNineMax();
runHashCoverage();
void confidenceBandOf;
