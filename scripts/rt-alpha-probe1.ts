/**
 * rt-alpha-probe1 —— 攻击 1 / 5 / 6 / 7
 *
 * 1. 数学被策略层污染：环境 / 画像 / 动态提示 / 对手筹码 全组合下，
 *    数学九项是否逐位不变？牌力 / SPR / 底池赔率 / 所需权益 是否不变？
 * 5. 低置信动态提示能否翻转 CLEAR 决策
 * 6. 结果污染（多余属性 / 原型链）
 * 7. 确定性 + 换蒙特卡洛种子是否只影响权益
 */

import { Position, Street } from '../src/domain/types.ts';
import {
  RULES,
  OPTS,
  analyze,
  fingerprint,
  flopTopPair,
  hr,
  mathNine,
  preflopHeroRaiseBbCall,
  riverFacingBet,
  show,
  turnTopPair,
  type Scenario,
} from './rt-alpha-lib.ts';
import { QuickProfile, DynamicHint } from '../src/app/manualInput/manualInput.ts';

/* ============================================================
 * 攻击 1：策略层污染数学
 * ============================================================ */

const ENVS = ['LOW_STAKES_ONLINE', 'MID_LOW_STAKES', 'THEORY_REFERENCE'] as const;
const PROFILES = Object.values(QuickProfile);
const HINTS = Object.values(DynamicHint);

function polluteScenarios(): { name: string; base: Scenario }[] {
  return [
    { name: '翻牌前(CO开池后BB跟注)', base: flopPreflop() },
    { name: '翻牌(顶对,BB过牌)', base: flopTopPair() },
    { name: '转牌(顶对,BB过牌)', base: turnTopPair() },
    { name: '河牌(顶对,BB下注10BB)', base: riverFacingBet() },
  ];
}

/** 翻牌前 Hero 是 CO，开池后 BB 跟注 → 本街结束，轮到……不，Hero 需要决策点。
 *  这里改成：UTG/HJ 弃牌，Hero CO 面对 BB 的 3bet？不 —— 简单点：
 *  Hero 是 BB，BTN 开池 3BB，SB 弃牌 → 轮到 Hero（BB）行动。
 */
function flopPreflop(): Scenario {
  return {
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
  };
}

function runPollutionSweep(): void {
  hr('攻击 1A：环境 × 画像 × 动态提示 全组合 → 数学九项是否逐位不变');

  for (const { name, base } of polluteScenarios()) {
    const buckets = new Map<string, string[]>();
    let count = 0;
    let failures = 0;

    for (const environment of ENVS) {
      for (const quickProfile of PROFILES) {
        for (const dynamicHint of HINTS) {
          const scenario: Scenario = {
            ...base,
            environment,
            villain: { quickProfile, dynamicHint },
          };
          const r = analyze(scenario);
          if (!r.ok) {
            failures += 1;
            continue;
          }
          const key = JSON.stringify(mathNine(r.decision.diagnostics.math));
          const label = `${environment}/${quickProfile}/${dynamicHint}`;
          const list = buckets.get(key) ?? [];
          list.push(label);
          buckets.set(key, list);
          count += 1;
        }
      }
    }

    show(`  场景「${name}」成功样本`, count);
    show(`  失败样本`, failures);
    show(`  不同的数学九项指纹数（应为 1）`, buckets.size);
    if (buckets.size > 1) {
      let i = 0;
      for (const [key, labels] of buckets) {
        i += 1;
        console.log(`   --- 指纹 ${i}（${labels.length} 个组合，示例 ${labels[0]}）---`);
        console.log(`   ${key}`);
        if (i >= 4) break;
      }
    }
  }
}

function runVillainStackSweep(): void {
  hr('攻击 1B：villain.stackBB（用户填的对手筹码）是否影响有效筹码/SPR 之外的东西');

  const base = flopTopPair();
  for (const stackBB of [undefined, 200, 50, 20, 5, 1, 0.5]) {
    const scenario: Scenario = {
      ...base,
      ...(stackBB !== undefined ? { villain: { stackBB } } : {}),
    };
    const r = analyze(scenario);
    if (!r.ok) {
      show(`  villain.stackBB=${String(stackBB)}`, `FAILED ${r.stage}: ${JSON.stringify(r.issues)}`);
      continue;
    }
    const m = r.decision.diagnostics.math;
    console.log(
      `  villain.stackBB=${String(stackBB).padEnd(9)} pot=${m.pot} callCost=${m.callCost} ` +
        `myStack=${m.myRemainingStack} effStack=${m.effectiveStack} spr=${String(m.spr)} ` +
        `potOdds=${m.potOdds.toFixed(6)} reqEq=${m.requiredEquity.toFixed(6)} ` +
        `heroEq=${m.heroEquity?.toFixed(6)} action=${r.decision.action} size=${String(r.decision.sizeChips)}`,
    );
  }
}

/* ============================================================
 * 攻击 5：低置信动态提示翻转 CLEAR
 * ============================================================ */

function runDynamicFlip(): void {
  hr('攻击 5：动态提示能否把动作从 A 翻成 B（同一输入只改 dynamicHint）');

  for (const { name, base } of polluteScenarios()) {
    const byHint = new Map<string, { action: string; size: string; conf: number; cls: string }>();
    for (const dynamicHint of HINTS) {
      const r = analyze({ ...base, villain: { quickProfile: 'UNKNOWN', dynamicHint } });
      if (!r.ok) continue;
      byHint.set(dynamicHint, {
        action: r.decision.action,
        size: String(r.decision.sizeChips ?? '-'),
        conf: r.decision.confidence,
        cls: r.decision.classification,
      });
    }
    const distinct = new Set([...byHint.values()].map((v) => `${v.action}@${v.size}`));
    console.log(`  场景「${name}」动作×尺寸的不同取值数 = ${distinct.size}`);
    for (const [hint, v] of byHint) {
      console.log(
        `    ${hint.padEnd(20)} → ${v.action.padEnd(7)} size=${v.size.padEnd(6)} ` +
          `conf=${v.conf.toFixed(4)} cls=${v.cls}`,
      );
    }
  }
}

/* ============================================================
 * 攻击 6：结果污染
 * ============================================================ */

function runResultContamination(): void {
  hr('攻击 6：结果信息（多余属性 / 原型链 / 嵌套）能否改变决策');

  const base = flopTopPair();
  const ref = analyze(base);
  if (!ref.ok) {
    show('  基准失败', JSON.stringify(ref.issues));
    return;
  }
  const refFp = fingerprint({
    action: ref.decision.action,
    sizeChips: ref.decision.sizeChips ?? null,
    confidence: ref.decision.confidence,
    classification: ref.decision.classification,
    math: mathNine(ref.decision.diagnostics.math),
    reasons: ref.decision.reasons,
  });
  show('  基准指纹', refFp);

  const variants: { name: string; make: () => unknown }[] = [
    {
      name: '多余自有属性 result/winner/heroProfit',
      make: () => ({ ...base, result: 'WIN', winner: 'hero', heroProfit: 100, villainHoleCards: ['Qh', 'Qd'] }),
    },
    {
      name: '多余自有属性 outcome=BAD_BEAT',
      make: () => ({ ...base, outcome: 'BAD_BEAT', isCooler: true, notes: '被河牌反超' }),
    },
    {
      name: '原型链注入（Object.create + __proto__）',
      make: () => {
        const proto = { result: 'LOSS', winner: 'villain', heroProfit: -100 };
        return Object.assign(Object.create(proto), base);
      },
    },
    {
      name: '嵌套 villain 带 result',
      make: () => ({ ...base, villain: { quickProfile: 'NORMAL', dynamicHint: 'UNKNOWN', result: 'LOSS' } }),
    },
    {
      name: 'actionHistory 条目带 result',
      make: () => ({
        ...base,
        actionHistory: base.actionHistory.map((a) => ({ ...a, result: 'LOSS', won: false })),
      }),
    },
    {
      name: 'Symbol 与不可枚举属性',
      make: () => {
        const o: Record<PropertyKey, unknown> = { ...base };
        o[Symbol('result')] = 'LOSS';
        Object.defineProperty(o, 'hiddenResult', { value: 'LOSS', enumerable: false });
        return o;
      },
    },
    {
      name: '构造函数原型污染（Object.prototype.result）',
      make: () => {
        (Object.prototype as Record<string, unknown>).rtResult = 'LOSS';
        return { ...base };
      },
    },
  ];

  for (const v of variants) {
    let payload: unknown;
    try {
      payload = v.make();
    } catch (e) {
      show(`  ${v.name}`, `构造失败 ${String(e)}`);
      continue;
    }
    let fp: string;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const r = analyze(payload as any);
      if (!r.ok) {
        show(`  ${v.name}`, `FAILED ${r.stage}: ${JSON.stringify(r.issues)}`);
        continue;
      }
      fp = fingerprint({
        action: r.decision.action,
        sizeChips: r.decision.sizeChips ?? null,
        confidence: r.decision.confidence,
        classification: r.decision.classification,
        math: mathNine(r.decision.diagnostics.math),
        reasons: r.decision.reasons,
      });
    } finally {
      delete (Object.prototype as Record<string, unknown>).rtResult;
    }
    show(`  ${v.name}`, fp === refFp ? '一致 ✔' : `**不同** ✘\n     ${fp}`);
  }
}

/* ============================================================
 * 攻击 7：确定性 + 种子隔离
 * ============================================================ */

function runDeterminismAndSeed(): void {
  hr('攻击 7：确定性（同输入多次）+ 换种子是否只影响权益');

  for (const { name, base } of polluteScenarios()) {
    const runs = Array.from({ length: 5 }, () => analyze(base));
    const oks = runs.filter((r) => r.ok);
    if (oks.length !== runs.length) {
      show(`  场景「${name}」`, `有失败：${JSON.stringify(runs.find((r) => !r.ok))}`);
      continue;
    }
    const fps = new Set(
      oks.map((r) =>
        fingerprint({
          action: (r as { decision: { action: string } }).decision.action,
          confidence: (r as { decision: { confidence: number } }).decision.confidence,
          math: mathNine((r as unknown as { decision: { diagnostics: { math: never } } }).decision.diagnostics.math),
        }),
      ),
    );
    show(`  场景「${name}」5 次运行的不同指纹数（应为 1）`, fps.size);
  }

  hr('攻击 7B：换 equitySeed（1000..1004）→ 除权益/EV 外是否逐位一致');

  for (const { name, base } of polluteScenarios()) {
    const rows: { seed: number; action: string; size: string; conf: number; eq: number | null; cls: string }[] = [];
    for (const seed of [1000, 1001, 1002, 1003, 1004, 999999]) {
      const r = analyze(base, { equitySeed: seed });
      if (!r.ok) continue;
      rows.push({
        seed,
        action: r.decision.action,
        size: String(r.decision.sizeChips ?? '-'),
        conf: r.decision.confidence,
        eq: r.decision.diagnostics.math.heroEquity,
        cls: r.decision.classification,
      });
    }
    const actions = new Set(rows.map((r) => r.action));
    const sizes = new Set(rows.map((r) => r.size));
    const confs = new Set(rows.map((r) => r.conf.toFixed(6)));
    console.log(`  场景「${name}」：动作集合 ${[...actions].join(',')} | 尺寸集合 ${[...sizes].join(',')} | 置信度取值 ${[...confs].join(',')}`);
    for (const r of rows) {
      console.log(
        `    seed=${String(r.seed).padEnd(7)} action=${r.action.padEnd(7)} size=${r.size.padEnd(6)} ` +
          `conf=${r.conf.toFixed(6)} eq=${r.eq === null ? 'null' : r.eq.toFixed(6)} cls=${r.cls}`,
      );
    }
  }
}

/* ============================================================
 * main
 * ============================================================ */

console.log(`知识库规则数=${RULES.length}  asOf=${OPTS.asOf}`);
void OPTS;

runPollutionSweep();
runVillainStackSweep();
runDynamicFlip();
runResultContamination();
runDeterminismAndSeed();
