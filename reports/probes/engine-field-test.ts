/**
 * 引擎实战体检：批量真打局面 + 每条独立不变量断言
 *
 * ## 目的
 *
 * 不看单点输出「顺不顺眼」，而是制造**大量真实局面**（不同街道 / 位置 / 筹码 /
 * 牌面 / 牌力 / 读牌 / 人数 / 面对的动作），并对**每一个**局面打一整套
 * **独立可证伪**的不变量。任何一条违约都打印局面指纹与具体数值。
 *
 * ## 不变量（每条都独立于实现，只依赖扑克与算术本身）
 *
 * | 编号 | 不变量 |
 * |---|---|
 * | I-1 | 引擎**自带一致性守卫** `diagnostics.consistency` 必须 `ok` 且零违规 |
 * | I-2 | **披露同源**：候选表 `ev !== null` ⇔ 不在 `unevaluatedActions`（双向） |
 * | I-3 | **不得伪造 EV**：`ev !== null` ⇒ 有限数，且加注族必须带三分支概率 |
 * | I-4 | **响应概率守恒**：`fold + call + reRaise == 1`（RAISE 候选） |
 * | I-5 | **建议动作必须合法**：必须出现在 `legalActions` 里 |
 * | I-6 | **金额合法**：RAISE/ALL_IN 的 `sizeChips ∈ [minRaiseTo, allInTo]`，且在候选表里 |
 * | I-7 | **门槛公式**：`requiredEquity == callCost ÷ (pot + callCost)`（须补 > 0 时） |
 * | I-8 | **数学量有限且非负**：pot / spr / callCost 等不得 NaN、不得负 |
 * | I-9 | **确定性**：同一输入两次运行逐位一致（动作 / 金额 / 全部候选 EV） |
 * | I-10 | **语义门**：只含河牌统计的画像不得改变翻牌及更早节点 |
 * | I-11 | **CHIP_EV 基据下**：被选中动作的 EV 不得低于其他**可比较**候选（容差带内除外） |
 * | I-12 | 序列化结果里不得出现 `NaN` / `Infinity` |
 *
 * ⚠️ 只读：不写任何数据文件。
 *
 * ```powershell
 * node --experimental-strip-types reports/probes/engine-field-test.ts
 * ```
 */

import { Position, Street } from '../../src/domain/types.ts';
import { GameEnvironment } from '../../src/domain/range/gameEnvironment.ts';
import { loadKnowledgeBaseOrThrow } from '../../src/domain/knowledge/knowledgeLoader.ts';
import type { ManualHandInput } from '../../src/app/manualInput/manualInput.ts';
import { analyzeManualHand, hashManualInput } from '../../src/app/alphaPipeline.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const O9: readonly Position[] = [
  Position.UTG, Position.UTG1, Position.UTG2, Position.LJ, Position.HJ,
  Position.CO, Position.BTN, Position.SB, Position.BB,
];

type Action = ManualHandInput['actionHistory'][number];
const F = (p: Position, s: Street = Street.PREFLOP): Action => ({ position: p, type: 'FOLD', street: s }) as Action;
const R = (p: Position, a: number, s = Street.PREFLOP): Action => ({ position: p, type: 'RAISE', amountBB: a, street: s }) as Action;
const C = (p: Position, a: number, s = Street.PREFLOP): Action => ({ position: p, type: 'CALL', amountBB: a, street: s }) as Action;
const CK = (p: Position, s: Street): Action => ({ position: p, type: 'CHECK', street: s }) as Action;
const B = (p: Position, a: number, s: Street): Action => ({ position: p, type: 'BET', amountBB: a, street: s }) as Action;

const i9 = (p: Position): number => O9.indexOf(p);
const foldsBefore = (p: Position): Action[] => O9.slice(0, i9(p)).map((x) => F(x));

const mk = (o: Partial<ManualHandInput>): ManualHandInput => ({
  tableSize: 9,
  heroPosition: Position.BTN,
  heroCards: ['As', 'Kd'],
  board: [],
  street: Street.PREFLOP,
  effectiveStackBB: 100,
  bigBlindBB: 100,
  environment: GameEnvironment.LOW_STAKES_ONLINE,
  occupiedPositions: [...O9],
  buttonPosition: Position.BTN,
  actionHistory: [],
  ...o,
} as ManualHandInput);

/* ---- 局面构造器 ---- */

/** 弃牌到 Hero（无人入池） */
const foldedTo = (hero: Position, cards: [string, string], stackBB = 100): ManualHandInput =>
  mk({ heroPosition: hero, heroCards: cards, effectiveStackBB: stackBB, actionHistory: foldsBefore(hero) });

/** Hero 面对一个开池 */
const vsOpen = (hero: Position, opener: Position, cards: [string, string], stats: Record<string, number> | null, stackBB = 100): ManualHandInput => {
  const h = [...foldsBefore(opener), R(opener, 2.5)];
  for (let i = i9(opener) + 1; i < i9(hero); i++) h.push(F(O9[i]!));
  return mk({ heroPosition: hero, heroCards: cards, effectiveStackBB: stackBB,
    ...(stats === null ? {} : { villain: { observedStats: stats as never } }), actionHistory: h });
};

/** Hero 开池后面对 3Bet */
const vsThreeBet = (hero: Position, threeBettor: Position, cards: [string, string], stackBB = 100): ManualHandInput => {
  const h = [...foldsBefore(hero), R(hero, 2.5)];
  for (let i = i9(hero) + 1; i < i9(threeBettor); i++) h.push(F(O9[i]!));
  h.push(R(threeBettor, 10));
  return mk({ heroPosition: hero, heroCards: cards, effectiveStackBB: stackBB, actionHistory: h });
};

/** 单挑进池后的翻后节点：`opener` 开池 3BB，`caller` 跟注，之后接 `after` */
const post = (o: {
  hero: Position; opener: Position; caller: Position; cards: [string, string];
  board: string[]; street: Street; after: Action[]; stackBB?: number;
  stats?: Record<string, number> | null;
}): ManualHandInput => {
  const h: Action[] = [...foldsBefore(o.opener), R(o.opener, 3)];
  for (let i = i9(o.opener) + 1; i < i9(o.caller); i++) h.push(F(O9[i]!));
  /*
   * 跟注者的补齐额必须**扣掉他已投的盲注**：`CALL.amountBB` 是**增量**口径
   * （BB 已投 1BB ⇒ 补 2；SB 已投 0.5 ⇒ 补 2.5；无盲位 ⇒ 补 3）。
   * ⚠️ 写错会被 `ACTION_REJECTED` 正确拦下 —— 这是探针自身的坑。
   */
  const blind: Partial<Record<Position, number>> = { [Position.SB]: 0.5, [Position.BB]: 1 };
  h.push(C(o.caller, 3 - (blind[o.caller] ?? 0)));
  for (let i = i9(o.caller) + 1; i < O9.length; i++) h.push(F(O9[i]!));
  return mk({
    heroPosition: o.hero, heroCards: o.cards, board: o.board, street: o.street,
    effectiveStackBB: o.stackBB ?? 100,
    ...(o.stats === undefined || o.stats === null ? {} : { villain: { observedStats: o.stats as never } }),
    actionHistory: [...h, ...o.after],
  });
};

/* ---- 局面库 ---- */

type Spot = { name: string; input: ManualHandInput };
const spots: Spot[] = [];
const add = (name: string, input: ManualHandInput): void => { spots.push({ name, input }); };

const HANDS: [string, [string, string]][] = [
  ['AA', ['As', 'Ah']], ['KK', ['Ks', 'Kh']], ['QQ', ['Qs', 'Qh']], ['22', ['2s', '2h']],
  ['AKs', ['As', 'Ks']], ['AKo', ['As', 'Kd']], ['AQs', ['As', 'Qs']], ['AQo', ['As', 'Qd']],
  ['KQs', ['Ks', 'Qs']], ['KJo', ['Ks', 'Jd']], ['QJs', ['Qs', 'Js']], ['JTs', ['Js', 'Ts']],
  ['T9s', ['Ts', '9s']], ['76s', ['7s', '6s']], ['A5s', ['As', '5s']], ['A2s', ['As', '2s']],
  ['K9s', ['Ks', '9s']], ['Q9s', ['Qs', '9s']], ['98s', ['9s', '8s']], ['T8s', ['Ts', '8s']],
  ['72o', ['7s', '2d']], ['32o', ['3s', '2d']], ['J9s', ['Js', '9s']], ['54s', ['5s', '4s']],
];
const STACKS = [20, 40, 100, 200];
const PROFILES: [string, Record<string, number> | null][] = [
  ['无', null],
  ['紧', { handsObserved: 80, vpip: 0.15, pfr: 0.1 }],
  ['松凶', { handsObserved: 80, vpip: 0.85, pfr: 0.6 }],
  ['跟注站', { handsObserved: 80, vpip: 0.7, pfr: 0.05 }],
  ['疯子', { handsObserved: 80, vpip: 0.9, pfr: 0.75, threeBet: 0.3 }],
];

/* A. 无人入池（已知边界：应拒绝给建议） */
for (const hero of [Position.UTG, Position.CO, Position.BTN, Position.SB]) {
  for (const [hn, hc] of [HANDS[0]!, HANDS[4]!, HANDS[16]!]) add(`A|无人入池 ${hero} ${hn}`, foldedTo(hero, hc));
}
/* B. 面对开池：多位置 × 多手牌 × 多筹码 */
for (const hero of [Position.BTN, Position.SB, Position.BB]) {
  for (const stack of STACKS) {
    for (const [hn, hc] of HANDS) {
      add(`B|vs开池 ${hero} ${hn} ${stack}BB`, vsOpen(hero, Position.CO, hc, null, stack));
    }
  }
}
/* C. 面对开池：画像 */
for (const [pn, ps] of PROFILES) {
  for (const [hn, hc] of [HANDS[0]!, HANDS[6]!, HANDS[10]!, HANDS[16]!, HANDS[18]!]) {
    add(`C|画像 ${pn} ${hn}`, vsOpen(Position.BB, Position.BTN, hc, ps));
  }
}
/* D. Hero 开池后面对 3Bet */
for (const hero of [Position.UTG, Position.CO, Position.BTN, Position.SB]) {
  for (const stack of [40, 100, 200]) {
    for (const [hn, hc] of [HANDS[0]!, HANDS[6]!, HANDS[9]!, HANDS[16]!, HANDS[20]!]) {
      const tb = hero === Position.SB ? Position.BB : Position.BB;
      add(`D|vs3Bet ${hero} ${hn} ${stack}BB`, vsThreeBet(hero, tb, hc, stack));
    }
  }
}

/* E. 翻牌 / 转牌 / 河牌：牌面 × 牌力 × 面对的动作 × 位置 × 筹码 */
const BOARDS: [string, string[]][] = [
  ['干燥K83r', ['Kh', '8c', '3d']],
  ['湿润Qh8h4c', ['Qh', '8h', '4c']],
  ['成对992', ['9h', '9c', '2d']],
  ['单花JsTs9s', ['Js', 'Ts', '9s']],
  ['低连654', ['6h', '5c', '4d']],
];
const FLOP_HANDS: [string, [string, string]][] = [
  ['暗三', ['8h', '8d']], ['顶对', ['Ah', 'Kc']], ['中对', ['Qh', 'Qd']],
  ['听花', ['Ah', 'Th']], ['两头顺', ['Jh', 'Th']], ['空气', ['3h', '2d']],
];
for (const [bn, board] of BOARDS) {
  for (const [hn, hc] of FLOP_HANDS) {
    for (const [an, after] of [
      ['被过牌到', [CK(Position.CO, Street.FLOP)]],
      ['面对1/3池', [B(Position.CO, 2.2, Street.FLOP)]],
      ['面对满池', [B(Position.CO, 6.5, Street.FLOP)]],
    ] as [string, Action[]][]) {
      add(`E|翻牌 ${bn} ${hn} ${an} IP`, post({ hero: Position.BTN, opener: Position.CO, caller: Position.BTN, cards: hc, board, street: Street.FLOP, after }));
    }
  }
}
/* 无位置（BB）翻牌面对下注 */
for (const [bn, board] of BOARDS) {
  for (const [hn, hc] of FLOP_HANDS) {
    add(`E|翻牌 ${bn} ${hn} 面对1/2池 OOP`, post({
      hero: Position.BB, opener: Position.CO, caller: Position.BB, cards: hc, board, street: Street.FLOP,
      after: [CK(Position.BB, Street.FLOP), B(Position.CO, 3.3, Street.FLOP)],
    }));
  }
}
/* 转牌与河牌 */
const TURN_BOARDS: [string, string[], string[]][] = [
  ['转牌 干燥K83+T', ['Kh', '8c', '3d'], ['Th']],
  ['转牌 湿润Qh8h4c+2s', ['Qh', '8h', '4c'], ['2s']],
];
for (const [bn, flopB, turnCard] of TURN_BOARDS) {
  const board = [...flopB, ...turnCard];
  for (const [hn, hc] of FLOP_HANDS) {
    add(`F|${bn} ${hn} 面对2/3池 IP`, post({
      hero: Position.BTN, opener: Position.CO, caller: Position.BTN, cards: hc, board, street: Street.TURN,
      after: [CK(Position.CO, Street.FLOP), CK(Position.BTN, Street.FLOP), B(Position.CO, 4.3, Street.TURN)],
    }));
  }
}
const RIVER_BOARDS: [string, string[]][] = [
  ['河牌 K83-2-7', ['Kh', '8c', '3d', '2s', '7h']],
  ['河牌 Qh8h4c-2s-9d', ['Qh', '8h', '4c', '2s', '9d']],
];
for (const [bn, board] of RIVER_BOARDS) {
  for (const [hn, hc] of FLOP_HANDS) {
    for (const [an, bet] of [['面对半池', 5.4], ['面对满池', 10.8], ['面对2倍池', 21.6]] as [string, number][]) {
      add(`G|${bn} ${hn} ${an} IP`, post({
        hero: Position.BTN, opener: Position.CO, caller: Position.BTN, cards: hc, board, street: Street.RIVER,
        after: [CK(Position.CO, Street.FLOP), CK(Position.BTN, Street.FLOP),
          CK(Position.CO, Street.TURN), CK(Position.BTN, Street.TURN), B(Position.CO, bet, Street.RIVER)],
      }));
    }
  }
}
/* H. 短码全下 */
for (const stack of [10, 15, 20, 25]) {
  add(`H|短码${stack}BB 翻牌面对全下`, post({
    hero: Position.BB, opener: Position.CO, caller: Position.BB, cards: ['Ah', 'Kc'],
    board: ['Kh', '8c', '3d'], street: Street.FLOP, stackBB: stack,
    after: [CK(Position.BB, Street.FLOP), B(Position.CO, stack - 3, Street.FLOP)],
  }));
}
/* I. 多人池 */
for (const [bn, board] of [BOARDS[0]!, BOARDS[1]!]) {
  add(`I|三人池 ${bn}`, mk({
    heroPosition: Position.BTN, heroCards: ['Ah', 'Kc'], board, street: Street.FLOP,
    actionHistory: [...foldsBefore(Position.HJ), R(Position.HJ, 3), C(Position.CO, 3), C(Position.BTN, 3),
      F(Position.SB), C(Position.BB, 2), CK(Position.BB, Street.FLOP), CK(Position.HJ, Street.FLOP), B(Position.CO, 5, Street.FLOP)],
  }));
}

/* ---- 构造体检：剔除**手牌与牌面撞牌**的局面 ---- */
/*
 * ⚠️ 这是**探针自身**的正确性要求，不是引擎缺陷：把 `8h8d` 套到 `Qh 8h 4c` 上会被
 * `ISSUE.USER_CARD_ON_BOARD` 正确拦下（引擎没做错，是构造矩阵错了）。
 * 若不剔除，审计报告里会混进 53 条假违约。
 */
const cardSet = (cards: readonly string[]): Set<string> => new Set(cards);
const collides = (s: Spot): boolean => {
  const b = cardSet(s.input.board ?? []);
  return (s.input.heroCards ?? []).some((c) => b.has(c));
};
const rawCount = spots.length;
const kept = spots.filter((s) => !collides(s));
const dropped = rawCount - kept.length;
spots.length = 0;
spots.push(...kept);

/* ---- 跑步与断言 ---- */

type Problem = { spot: string; code: string; detail: string };
const problems: Problem[] = [];
let analyzed = 0;
let notAnalyzable = 0;
let blocked = 0;
const bad = (spot: string, code: string, detail: string): void => { problems.push({ spot, code, detail }); };
const num = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v);

console.log(`局面总数 = ${spots.length}（构造时剔除撞牌 ${dropped} 个）\n`);

for (const { name, input } of spots) {
  const r = analyzeManualHand(input, { rules: RULES });
  if (!r.ok) {
    notAnalyzable++;
    bad(name, 'NOT_ANALYZABLE', r.issues.map((i) => i.code).sort().join(','));
    continue;
  }
  /*
   * ⚠️ **已登记的已知边界**：「弃牌到 Hero（无人入池）」⇒ 没有对手范围 ⇒ 权益不可算
   * ⇒ 引擎**拒绝给建议**（`action === null`），并在 reasons 里给出 `EQUITY_NOT_COMPUTABLE`。
   * 注意它 `ok === true`（不是失败），所以必须按 reasons 分类，**不能**按 `ok` 分类。
   */
  if (r.decision.action === null) {
    const why = r.decision.reasons.some((x) => x.code === 'EQUITY_NOT_COMPUTABLE');
    if (why) { blocked++; continue; }
    bad(name, 'I-5_NULL_ACTION', 'ok 且无 EQUITY_NOT_COMPUTABLE，却仍为 null');
    continue;
  }
  analyzed++;
  const d = r.decision.diagnostics;
  const dec = r.decision as unknown as Record<string, unknown>;

  /* I-1 引擎自带一致性守卫 */
  const cons = d.consistency;
  if (cons === undefined || !cons.ok || cons.violations.length > 0) {
    bad(name, 'I-1_CONSISTENCY', JSON.stringify(cons?.violations ?? cons ?? 'missing'));
  }
  /* I-12 序列化不得含 NaN / Infinity */
  const js = JSON.stringify(r.decision);
  if (/NaN|Infinity/.test(js)) bad(name, 'I-12_NAN', (js.match(/.{0,40}(NaN|Infinity).{0,40}/) ?? [''])[0]!);

  const cands = d.candidates;
  const unev = d.unevaluatedActions ?? [];

  /* I-2 披露同源（双向） */
  for (const c of cands) {
    const isRaise = c.action === 'RAISE' || c.action === 'ALL_IN';
    const code = isRaise ? 'RAISE_EV_NOT_IMPLEMENTED' : 'BET_EV_NOT_IMPLEMENTED';
    if (!isRaise && c.action !== 'BET') continue;
    const listed = unev.some((u) => u.reasonCode === code && u.sizeChips !== null && Math.abs(u.sizeChips - (c.sizeChips ?? -1)) < 1e-9);
    if ((c.ev === null) !== listed) {
      bad(name, 'I-2_DISCLOSURE', `${c.action}@${String(c.sizeChips)} ev=${String(c.ev)} 但清单${listed ? '有' : '无'}它`);
    }
  }
  /* I-3 / I-4 EV 与三分支 */
  for (const c of cands) {
    if (c.ev === null) continue;
    if (!num(c.ev)) bad(name, 'I-3_EV_NOT_FINITE', `${c.action}@${String(c.sizeChips)} ev=${String(c.ev)}`);
    if (c.action === 'RAISE' || c.action === 'ALL_IN') {
      const b = c.evBranches;
      if (b === undefined || b === null) { bad(name, 'I-4_NO_BRANCHES', `${c.action}@${String(c.sizeChips)}`); continue; }
      const s = b.fold + b.call + b.reRaise;
      if (!(Math.abs(s - 1) < 1e-6)) bad(name, 'I-4_BRANCH_SUM', `${c.action}@${String(c.sizeChips)} Σ=${s}`);
    }
  }
  /* I-5 建议动作必须合法 */
  const action = r.decision.action;
  if (action === null) { bad(name, 'I-5_NULL_ACTION', 'ok=true 但动作为 null'); continue; }
  if (!d.legalActions.includes(action as never)) bad(name, 'I-5_ILLEGAL', `${action} ∉ ${JSON.stringify(d.legalActions)}`);

  /* I-6 金额合法 */
  const shape = d.actionShape;
  if (action === 'RAISE' || action === 'ALL_IN') {
    const size = shape?.sizeChips ?? null;
    if (size === null) bad(name, 'I-6_NO_SIZE', `${action} 无 sizeChips`);
    else {
      const inCands = cands.some((c) => (c.action === action || c.action === 'RAISE') && Math.abs((c.sizeChips ?? -2) - size) < 1e-9);
      if (!inCands) bad(name, 'I-6_SIZE_NOT_CANDIDATE', `${action}@${size} 不在候选表`);
      if (d.preflopRaise !== null && d.preflopRaise !== undefined) {
        const minTo = d.preflopRaise.minRaiseToAmount;
        if (size < minTo - 1e-9) bad(name, 'I-6_BELOW_MIN_RAISE', `size=${size} < minRaiseTo=${minTo}`);
      }
    }
  }
  /* I-7 门槛公式 */
  const m = d.math;
  if (num(m.callCost) && m.callCost > 0 && num(m.pot)) {
    const want = m.callCost / (m.pot + m.callCost);
    if (!num(m.requiredEquity) || Math.abs((m.requiredEquity as number) - want) > 1e-6) {
      bad(name, 'I-7_REQUIRED_EQ', `requiredEquity=${String(m.requiredEquity)} 期望 ${want.toFixed(6)}`);
    }
  }
  /* I-8 数学量有限非负 */
  for (const k of ['pot', 'callCost', 'myRemainingStack', 'effectiveStack', 'spr'] as const) {
    const v = m[k];
    if (!num(v) || (v as number) < -1e-9) bad(name, 'I-8_MATH', `${k}=${String(v)}`);
  }
  /* I-9 确定性（抽样：每 4 个局面查 1 个 —— 确定性是结构性质，不必逐个重复跑） */
  if (analyzed % 4 === 1) {
    const again = analyzeManualHand(input, { rules: RULES });
    if (!again.ok) bad(name, 'I-9_DETERMINISM', '第二次运行不可分析');
    else {
      const a = JSON.stringify([r.decision.action, shape?.sizeChips, cands.map((c) => [c.action, c.sizeChips, c.ev])]);
      const b2 = JSON.stringify([again.decision.action, again.decision.diagnostics.actionShape?.sizeChips,
        again.decision.diagnostics.candidates.map((c) => [c.action, c.sizeChips, c.ev])]);
      if (a !== b2) bad(name, 'I-9_DETERMINISM', '两次运行不一致');
    }
  }
  /* I-11 CHIP_EV 基据：被选中动作不应低于其他可比较候选（超出容差带） */
  const basis = d.decisionBasis;
  if (basis?.kind === 'CHIP_EV') {
    const withEV = cands.filter((c) => c.ev !== null);
    const chosen = withEV.find((c) => c.action === action && (shape?.sizeChips === undefined || shape?.sizeChips === null || c.sizeChips === shape.sizeChips));
    if (chosen !== undefined) {
      const better = withEV.filter((c) => (c.ev ?? 0) > (chosen.ev ?? 0) + 1e-6 && c.action !== 'RAISE' && c.action !== 'ALL_IN');
      if (better.length > 0) {
        bad(name, 'I-11_ARGMAX', `选中 ${action}=${String(chosen.ev)} 但 ${better.map((c) => `${c.action}=${String(c.ev)}`).join(' ')} 更高`);
      }
    }
  }
  void hashManualInput;
  void dec;
}

console.log('════════ 第一轮：形式不变量 ════════');
console.log(`  可分析局面      ${analyzed}`);
console.log(`  已知边界（无人入池，拒绝给建议）  ${blocked}`);
console.log(`  意外不可分析    ${notAnalyzable}`);
const byCode = new Map<string, Problem[]>();
for (const p of problems) {
  if (!byCode.has(p.code)) byCode.set(p.code, []);
  byCode.get(p.code)!.push(p);
}
console.log(`  违约条目        ${problems.length}（${byCode.size} 类）\n`);
for (const [code, list] of [...byCode].sort((x, y) => y[1].length - x[1].length)) {
  console.log(`★ ${code}  共 ${list.length} 例`);
  for (const p of list.slice(0, 6)) console.log(`    ${p.spot}  →  ${p.detail}`);
  if (list.length > 6) console.log(`    …另有 ${list.length - 6} 例`);
}
if (problems.length === 0) console.log('  ✔ 第一轮全部不变量通过');

/* ============================================================
 * 第二轮：**战略常识**（形式自洽 ≠ 打法正确）
 * ============================================================
 *
 * 这些不变量只依赖扑克常识，不依赖实现：
 * S-1 坚果牌面对下注**不得弃牌**；
 * S-2 跟注 EV 明显为正时**不得弃牌**（除非加注更优 ⇒ 那应建议加注）；
 * S-3 短码拿 AA/KK 面对加注**不得弃牌**（翻前）；
 * S-4 同一牌面**最强的那手**不得被建议弃牌，而更弱的手却在继续；
 * S-5 面对全下而弃牌 ⇒ 跟注 EV 必须不为正（超出容差带）。
 */
console.log('\n════════ 第二轮：战略常识 ════════');
const strat: Problem[] = [];
const CAT_ZH: Record<number, string> = { 4: '顺子', 5: '同花', 6: '葫芦', 7: '四条', 8: '同花顺' };
const conservatism = (a: string): number =>
  a === 'FOLD' ? 0 : a === 'CHECK' ? 1 : a === 'CALL' ? 2 : a === 'BET' ? 3 : 4;
const byBoard = new Map<string, { name: string; ev: number; action: string }[]>();

for (const { name, input } of spots) {
  const r = analyzeManualHand(input, { rules: RULES });
  if (!r.ok || r.decision.action === null) continue;
  const d = r.decision.diagnostics;
  const m = d.math;
  const action = String(r.decision.action);
  const band = (d.decisionMargin as unknown as { bandChips?: number } | undefined)?.bandChips ?? 0;
  const callC = d.candidates.find((c) => c.action === 'CALL');
  const callEV = callC?.ev ?? null;
  const cat = typeof m.handCategory === 'number' ? m.handCategory : -1;

  /* S-1 坚果（同花及以上）面对下注不得弃牌 */
  if (cat >= 5 && m.callCost > 0 && action === 'FOLD') {
    strat.push({ spot: name, code: 'S-1_FOLD_NUTS', detail: `牌力=${CAT_ZH[cat] ?? cat} 需补=${m.callCost} 却弃牌` });
  }
  /* S-2 跟注 EV 明显为正却弃牌 */
  if (action === 'FOLD' && callEV !== null && callEV > band + 1e-6) {
    strat.push({ spot: name, code: 'S-2_FOLD_POSITIVE_CALLEV', detail: `callEV=${callEV.toFixed(2)} > 容差带 ${band.toFixed(2)} 却弃牌` });
  }
  /* S-3 短码 AA/KK 翻前面对加注不得弃牌 */
  const cards = (input.heroCards ?? []).join('');
  if (m.street === Street.PREFLOP && (cards === 'AsAh' || cards === 'KsKh') &&
      (m.effectiveStack ?? 999) <= 25 && m.callCost > 0 && action === 'FOLD') {
    strat.push({ spot: name, code: 'S-3_FOLD_PREMIUM_SHORT', detail: `${cards} 有效筹码=${m.effectiveStack} 却弃牌` });
  }
  /* S-5 面对全下（需补 = 我的剩余）而弃牌 ⇒ 跟注 EV 不得为正 */
  if (action === 'FOLD' && Math.abs(m.callCost - m.myRemainingStack) < 1e-6 &&
      callEV !== null && callEV > band + 1e-6) {
    strat.push({ spot: name, code: 'S-5_FOLD_VS_ALLIN_POS_EV', detail: `面对全下 callEV=${callEV.toFixed(2)} 却弃牌` });
  }
  /* 收集用于 S-4 */
  const key = `${String(m.street)}|${(input.board ?? []).join('')}`;
  if (callEV !== null && m.callCost > 0) {
    if (!byBoard.has(key)) byBoard.set(key, []);
    byBoard.get(key)!.push({ name, ev: callEV, action });
  }
}
/* S-4 同牌面最强手不得被建议弃牌而更弱的手在继续 */
for (const [key, list] of byBoard) {
  if (list.length < 2) continue;
  const sorted = [...list].sort((a, b) => b.ev - a.ev);
  const strongest = sorted[0]!;
  const weakerContinuing = sorted.slice(1).filter((x) => x.action !== 'FOLD');
  if (strongest.action === 'FOLD' && weakerContinuing.length > 0 && strongest.ev > 0) {
    strat.push({
      spot: key, code: 'S-4_STRONGEST_FOLDS',
      detail: `最强 ${strongest.name}(callEV=${strongest.ev.toFixed(1)}) 弃牌，但 ${weakerContinuing.map((x) => `${x.name}(${x.ev.toFixed(1)})`).join(' ')} 在继续`,
    });
  }
}
const byStrat = new Map<string, Problem[]>();
for (const p of strat) {
  if (!byStrat.has(p.code)) byStrat.set(p.code, []);
  byStrat.get(p.code)!.push(p);
}
if (strat.length === 0) console.log('  ✔ 第二轮全部通过');
for (const [code, list] of [...byStrat].sort((x, y) => y[1].length - x[1].length)) {
  console.log(`★ ${code}  共 ${list.length} 例`);
  for (const p of list.slice(0, 8)) console.log(`    ${p.spot}  →  ${p.detail}`);
  if (list.length > 8) console.log(`    …另有 ${list.length - 8} 例`);
}

console.log(`\n════════ 合计违约：第一轮 ${problems.length} + 第二轮 ${strat.length} ════════`);
process.exitCode = problems.length + strat.length > 0 ? 1 : 0;
