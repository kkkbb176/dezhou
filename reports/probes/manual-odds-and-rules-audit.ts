/**
 * 《德州牌桌手册 V1.4》↔ 决策引擎：**赔率与规则**逐项核对
 *
 * | 手册 | 内容 | 本脚本怎么核对 |
 * |---|---|---|
 * | P11 | 跟注门槛 `C ÷ (P现 + C)`；单挑下注速查表 `B ÷ (P + 2B)` | 造 7 档下注节点，读 `math.requiredEquity` |
 * | P11 | 面对加注时「要补多少」不得算成「加到多少」 | 造「我下10、对手加到30」节点，核对 `callCost` |
 * | P9 | 固定例子：底池 5.5 → 9.5 → 21.5，河牌满池，门槛 33.3%，跟后总池 64.5 | 逐街复现，核对 `pot`/`callCost`/`requiredEquity` |
 * | P12/P13 | 补牌表、隐含赔率、直接价格 EV | 独立复算（验证**手册本身**的算术） |
 *
 * ⚠️ `potBB` 的语义 = **决策点当时**的底池（含此前所有投入）。写错会被
 * `ISSUE.POT_MISMATCH` 正确拦下 —— 本脚本第一版正是踩了这个坑。
 *
 * ⚠️ 只读：不写任何数据文件。
 *
 * ```powershell
 * node --experimental-strip-types reports/probes/manual-odds-and-rules-audit.ts
 * ```
 */

import { Position, Street } from '../../src/domain/types.ts';
import { GameEnvironment } from '../../src/domain/range/gameEnvironment.ts';
import { loadKnowledgeBaseOrThrow } from '../../src/domain/knowledge/knowledgeLoader.ts';
import type { ManualHandInput } from '../../src/app/manualInput/manualInput.ts';
import { analyzeManualHand } from '../../src/app/alphaPipeline.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const ORDER9: readonly Position[] = [
  Position.UTG, Position.UTG1, Position.UTG2, Position.LJ, Position.HJ,
  Position.CO, Position.BTN, Position.SB, Position.BB,
];

type Action = ManualHandInput['actionHistory'][number];
const F = (position: Position, street: Street = Street.PREFLOP): Action =>
  ({ position, type: 'FOLD', street }) as Action;
const R = (position: Position, amountBB: number, street = Street.PREFLOP): Action =>
  ({ position, type: 'RAISE', amountBB, street }) as Action;
const C = (position: Position, amountBB: number, street = Street.PREFLOP): Action =>
  ({ position, type: 'CALL', amountBB, street }) as Action;
const CK = (position: Position, street: Street): Action =>
  ({ position, type: 'CHECK', street }) as Action;
const B = (position: Position, amountBB: number, street: Street): Action =>
  ({ position, type: 'BET', amountBB, street }) as Action;

const idx = (p: Position): number => ORDER9.indexOf(p);
const foldsBefore = (p: Position): Action[] => ORDER9.slice(0, idx(p)).map((x) => F(x));

/** CO 开池 3BB / BTN 与 SB 弃 / BB 跟注 2 ⇒ 翻牌前底池 6.5BB */
const headsUpToFlop = (): Action[] => [
  ...foldsBefore(Position.CO), R(Position.CO, 3), F(Position.BTN), F(Position.SB), C(Position.BB, 2),
];

const node = (o: Partial<ManualHandInput>): ManualHandInput => ({
  tableSize: 9,
  heroPosition: Position.BB,
  heroCards: ['As', 'Kc'],
  board: ['Kh', '8c', '3d'],
  street: Street.FLOP,
  effectiveStackBB: 100,
  bigBlindBB: 100,
  environment: GameEnvironment.LOW_STAKES_ONLINE,
  occupiedPositions: [...ORDER9],
  buttonPosition: Position.BTN,
  actionHistory: [],
  ...o,
} as ManualHandInput);

let fails = 0;
const check = (name: string, ok: boolean, detail: string): void => {
  if (!ok) fails++;
  console.log(`${ok ? '  ✔' : '  ★'} ${name}${detail === '' ? '' : ` —— ${detail}`}`);
};
const pct = (v: number | null): string => (v === null ? '—' : `${(v * 100).toFixed(2)}%`);

console.log('════════ 手册 P11：单挑下注速查表 门槛 = B ÷ (P + 2B) ════════\n');
console.log('  （P = 对手下注前的底池 = 6.5BB；B = 该档 × P）\n');
console.log('  下注档     手册表   引擎 requiredEquity   底池B前/需补   独立复算 B/(P+2B)');
{
  const P = 6.5;
  const table: readonly [string, number, number][] = [
    ['1/3池', 1 / 3, 20.0],
    ['1/2池', 1 / 2, 25.0],
    ['2/3池', 2 / 3, 28.6],
    ['3/4池', 3 / 4, 30.0],
    ['满池', 1, 33.3],
    ['1.5倍池', 1.5, 37.5],
    ['2倍池', 2, 40.0],
  ];
  let bad = 0;
  for (const [label, ratio, want] of table) {
    const bet = P * ratio;
    const r = analyzeManualHand(node({
      /* `potBB` = 决策点当时的底池 = 下注前底池 + 他的下注（P9 那组已验证此语义） */
      potBB: P + bet,
      actionHistory: [...headsUpToFlop(), CK(Position.BB, Street.FLOP), B(Position.CO, bet, Street.FLOP)],
    }), { rules: RULES });
    if (!r.ok) {
      bad++;
      console.log(`  ${label.padEnd(8)} 失败 ${JSON.stringify(r.issues.map((i) => i.code))} ★`);
      continue;
    }
    const m = r.decision.diagnostics.math;
    const got = m.requiredEquity === null ? null : m.requiredEquity * 100;
    const ok = got !== null && Math.abs(got - want) < 0.06;
    if (!ok) bad++;
    console.log(
      `  ${label.padEnd(8)} ${want.toFixed(1).padStart(5)}%   ${ok ? '✔' : '★'} ` +
        `${(got === null ? '—' : got.toFixed(2)).padStart(6)}%        ` +
        `${String((m.pot - m.callCost) / 100).padStart(4)}BB / ${String(m.callCost / 100).padStart(4)}BB   ` +
        `${((bet / (P + 2 * bet)) * 100).toFixed(2)}%`,
    );
  }
  check('P11 七档下注门槛全部与手册表一致', bad === 0, `${bad} 档不符`);
}

console.log('\n════════ 手册 P11：面对加注时「要补多少」不得算成「加到多少」 ════════\n');
{
  /* 手册例：原池 40，我下 10；对手加到 30（本轮共放 30）⇒ 我还需补 20，不是 30 */
  const r = analyzeManualHand(node({
    heroPosition: Position.BB, heroCards: ['As', 'Kc'], board: ['Kh', '8c', '3d'],
    street: Street.FLOP, potBB: 6.5 + 10 + 30,
    actionHistory: [
      ...headsUpToFlop(),
      B(Position.BB, 10, Street.FLOP), R(Position.CO, 30, Street.FLOP),
    ],
  }), { rules: RULES });
  if (!r.ok) {
    console.log(`  节点不可分析：${JSON.stringify(r.issues.map((i) => i.code))}`);
    fails++;
  } else {
    const m = r.decision.diagnostics.math;
    console.log(`  引擎：底池=${(m.pot / 100).toFixed(2)}BB 需补=${(m.callCost / 100).toFixed(2)}BB 门槛=${pct(m.requiredEquity)}`);
    console.log('  手册口径：底池 = 6.5 + 我下10 + 他加到30 = 46.5BB；需补 = 30 − 10 = 20BB；门槛 20/66.5 = 30.08%');
    check('P11 需补额 = 加注额 − 我本街已投入（不是「加到多少」）',
      Math.abs(m.callCost / 100 - 20) < 1e-9, `引擎 ${(m.callCost / 100).toFixed(2)}BB，期望 20BB`);
    check('P11 底池含对手本次加注的**全额**',
      Math.abs(m.pot / 100 - 46.5) < 1e-9, `引擎 ${(m.pot / 100).toFixed(2)}BB，期望 46.5BB`);
    check('P11 门槛 = C ÷ (P现 + C)',
      m.requiredEquity !== null && Math.abs(m.requiredEquity - 20 / 66.5) < 1e-9,
      `引擎 ${pct(m.requiredEquity)}，期望 ${((20 / 66.5) * 100).toFixed(2)}%`);
  }
}

console.log('\n════════ 手册 P9：固定例子的底池链 与 河牌满池门槛 33.3% ════════\n');
{
  const preflop = [...foldsBefore(Position.BTN), R(Position.BTN, 2.5), F(Position.SB), C(Position.BB, 1.5)];
  const flopDone = [...preflop, CK(Position.BB, Street.FLOP), B(Position.BTN, 2, Street.FLOP), C(Position.BB, 2, Street.FLOP)];
  const turnDone = [...flopDone, CK(Position.BB, Street.TURN), B(Position.BTN, 6, Street.TURN), C(Position.BB, 6, Street.TURN)];

  const stages: readonly [string, Street, readonly string[], Action[], number][] = [
    ['翻牌（他过牌后）', Street.FLOP, ['Qh', '8h', '4c'], [...preflop, CK(Position.BB, Street.FLOP)], 5.5],
    ['转牌（他过牌后）', Street.TURN, ['Qh', '8h', '4c', '2s'], [...flopDone, CK(Position.BB, Street.TURN)], 9.5],
    ['河牌（他下满池后）', Street.RIVER, ['Qh', '8h', '4c', '2s', '9d'], [...turnDone, B(Position.BB, 21.5, Street.RIVER)], 43],
  ];
  let bad = 0;
  for (const [label, street, board, history, wantPot] of stages) {
    const r = analyzeManualHand(node({
      heroPosition: Position.BTN, heroCards: ['As', 'Qc'], board, street, potBB: wantPot,
      actionHistory: history,
    }), { rules: RULES });
    if (!r.ok) {
      bad++;
      console.log(`  ${label.padEnd(9)} 失败 ${JSON.stringify(r.issues.map((i) => i.code))} ★`);
      continue;
    }
    const m = r.decision.diagnostics.math;
    const potBB = m.pot / 100;
    const ok = Math.abs(potBB - wantPot) < 0.01;
    if (!ok) bad++;
    console.log(
      `  ${label.padEnd(9)} ${ok ? '✔' : '★'} 底池=${potBB.toFixed(2)}BB（手册 ${wantPot}BB）` +
        ` 需补=${(m.callCost / 100).toFixed(2)}BB 门槛=${pct(m.requiredEquity)}`,
    );
  }
  check('P9 三街底池链 5.5 → 9.5 → 43（河牌含他的 21.5）全部一致', bad === 0, `${bad} 街不符`);

  const river = analyzeManualHand(node({
    heroPosition: Position.BTN, heroCards: ['As', 'Qc'], board: ['Qh', '8h', '4c', '2s', '9d'],
    street: Street.RIVER, potBB: 43, actionHistory: [...turnDone, B(Position.BB, 21.5, Street.RIVER)],
  }), { rules: RULES });
  if (river.ok) {
    const m = river.decision.diagnostics.math;
    check('P9 河牌满池门槛 = 33.3%（= 21.5 ÷ 64.5）',
      m.requiredEquity !== null && Math.abs(m.requiredEquity - 21.5 / 64.5) < 0.002,
      `引擎 ${pct(m.requiredEquity)}`);
    check('P9 跟注后总池 = 64.5BB',
      Math.abs((m.pot + m.callCost) / 100 - 64.5) < 0.01,
      `引擎 ${((m.pot + m.callCost) / 100).toFixed(2)}BB`);
  }
}

console.log('\n════════ 手册 P12/P13：独立复算（验证手册本身的算术）════════\n');
{
  const rows: readonly [string, number, number, number, number][] = [
    ['口袋对子再中', 2, 4.3, 4.3, 8.4],
    ['卡顺', 4, 8.5, 8.7, 16.5],
    ['两张高牌配对', 6, 12.8, 13.0, 24.1],
    ['两头顺', 8, 17.0, 17.4, 31.5],
    ['听花', 9, 19.1, 19.6, 35.0],
    ['听花+卡顺', 12, 25.5, 26.1, 45.0],
    ['听花+两头顺', 15, 31.9, 32.6, 54.1],
  ];
  let bad = 0;
  for (const [label, n, wantFlop, wantTurn, wantTwo] of rows) {
    const f = (n / 47) * 100;
    const t = (n / 46) * 100;
    const two = (1 - ((47 - n) / 47) * ((46 - n) / 46)) * 100;
    const ok = Math.abs(f - wantFlop) < 0.06 && Math.abs(t - wantTurn) < 0.06 && Math.abs(two - wantTwo) < 0.06;
    if (!ok) bad++;
    console.log(
      `  ${label.padEnd(13)} n=${String(n).padStart(2)}  手册 ${wantFlop}/${wantTurn}/${wantTwo}  ` +
        `复算 ${f.toFixed(1)}/${t.toFixed(1)}/${two.toFixed(1)}  ${ok ? '✔' : '★'}`,
    );
  }
  check('P12 补牌表七行全部可复算', bad === 0, `${bad} 行不符`);
  check('P12 易错点②「15张×4=60%」确实高估（精算 54.1%）', true, '');
  const I = 20 / (9 / 46) - 80;
  check('P13 隐含赔率 I = C/p − (P+C) = 22.22BB', Math.abs(I - 22.22) < 0.01, `复算 ${I.toFixed(2)}`);
  const ev = (9 / 46) * 80 - 20;
  check('P13 直接价格 EV = (9/46)×80 − 20 = −4.35BB', Math.abs(ev + 4.35) < 0.01, `复算 ${ev.toFixed(2)}`);
}

console.log(`\n════════ 赔率与规则：不一致 ${fails} 项 ════════`);
if (fails > 0) process.exitCode = 1;
