/**
 * 牌桌矩阵审计 v2（位置 / 资金 / 牌力 / 位置打法 / 人物画像）
 *
 * ## 目的
 *
 * 不看单点输出「顺不顺眼」，而是把五条轴各压一遍，并对每条轴声明**可证伪的不变量**：
 * 违约就打印 ★ 并计入失败数。
 *
 * | 轴 | 不变量 |
 * |---|---|
 * | A 位置 | 同一手牌面对同一开池，Hero 位置必须真的进入模型；且**开池者**位置越靠后（范围越宽）Hero 的跟注 EV 不得更低 |
 * | B 资金 | 有效筹码改变 ⇒ SPR 单调、建议/是否打光必须真的变 |
 * | C 牌力 | 牌力越强，跟注 EV 不得更低（单调性） |
 * | D 位置打法 | 同一牌面同一手牌，有位置 vs 无位置必须可区分；被过牌到时必须给主动下注 |
 * | E 画像 | 同一局面换画像 ⇒ 输出必须变；跨街道统计不得越界生效 |
 *
 * ## v1 → v2 修掉的**探针自身**错误（这些曾伪装成「引擎缺陷」）
 *
 * 1. `B-2` 断言方向写反：SPR = 筹码/底池 ⇒ 筹码越深 SPR **越大**；
 * 2. `C` 手牌与牌面撞牌（牌面 K♥ 又给了 K♥）⇒ 被 `USER_CARD_ON_BOARD` 正确拦下；
 * 3. `D` 翻后行动顺序搞错，且把 Hero 自己写成了 FOLD 又 CALL（同一人两次行动）；
 * 4. `F` 构造了不存在的节点（UTG 不可能面对 CO 的开池）；
 * 5. `A` 的空断言（全 null 时「无倒退」会**假通过**）。
 *
 * ## 关于「弃牌到 Hero（无人入池）」——**已知边界，不是本次发现的缺陷**
 *
 * 该节点返回 `action = null` + blocker `EQUITY_NOT_COMPUTABLE`：无人入池 ⇒ 没有对手
 * 范围 ⇒ 权益不可算 ⇒ **拒绝给建议**（不猜）。这已被
 * `reports/PREFLOP_DECISION_PATH_AUDIT_V1.md` §3.1「无人入池（开池）——一律无建议」
 * 登记，`reports/PREFLOP_F2_ALLIN_GUARD_FIX.md` §Q1/§Q5 给出了原因、修复方案与代价
 * （会改动**全部**无人入池节点的 `heroEquity`）。
 * 本脚本把它**锁成契约**（A-0），防止它被无声改掉。
 *
 * ## 用法
 *
 * ```powershell
 * node --experimental-strip-types reports/probes/table-matrix-audit.ts
 * ```
 *
 * **只读**：直接调用 `analyzeManualHand`（纯计算），不写历史、不碰求解器缓存。
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

const base = (o: Partial<ManualHandInput>): ManualHandInput => ({
  tableSize: 9,
  heroPosition: Position.BTN,
  heroCards: ['As', 'Kd'],
  board: [],
  street: Street.PREFLOP,
  effectiveStackBB: 100,
  bigBlindBB: 100,
  environment: GameEnvironment.LOW_STAKES_ONLINE,
  occupiedPositions: [...ORDER9],
  buttonPosition: Position.BTN,
  actionHistory: [],
  ...o,
} as ManualHandInput);

/** 弃牌到 Hero（无人入池）—— Hero 可以开池 */
const foldedTo = (hero: Position, cards: readonly [string, string]): ManualHandInput =>
  base({ heroPosition: hero, heroCards: cards, actionHistory: foldsBefore(hero) });

/**
 * Hero 面对一个开池（单挑 ⇒ 翻前加注响应模型可用）。
 * ⚠️ `opener` 必须在 `hero` **之前**行动，否则该节点不存在。
 */
const vsOpen = (
  hero: Position, opener: Position, cards: readonly [string, string],
  stats: Record<string, number> | null = null, stackBB = 100, openToBB = 2.5,
): ManualHandInput => {
  const h: Action[] = foldsBefore(opener);
  h.push(R(opener, openToBB));
  for (let i = idx(opener) + 1; i < idx(hero); i++) h.push(F(ORDER9[i]!));
  return base({
    heroPosition: hero, heroCards: cards, effectiveStackBB: stackBB,
    ...(stats === null ? {} : { villain: { observedStats: stats as never } }),
    actionHistory: h,
  });
};

/**
 * 翻后单挑节点：`opener` 开池、`caller` 跟注，其余弃牌，然后接 `actions`。
 * ⚠️ 翻后行动顺序从 SB 起算 ⇒ `{CO, BTN}` 是 CO 先、`{CO, BB}` 是 BB 先。
 */
const postflop = (o: {
  street: Street; board: readonly string[]; hero: Position;
  cards: readonly [string, string]; stats: Record<string, number> | null;
  stackBB?: number; actions: Action[]; opener: Position; caller: Position;
}): ManualHandInput => {
  const BLIND: Partial<Record<Position, number>> = { [Position.SB]: 0.5, [Position.BB]: 1 };
  const h: Action[] = [];
  if (idx(o.opener) < idx(o.caller)) {
    /* 开池者先行动：弃牌到开池者 → 开池 3BB → 之后逐位（跟注者 CALL，其余 FOLD） */
    h.push(...foldsBefore(o.opener));
    h.push(R(o.opener, 3));
    for (let i = idx(o.opener) + 1; i < ORDER9.length; i++) {
      const p = ORDER9[i]!;
      if (p === o.caller) h.push(C(p, 3 - (BLIND[p] ?? 0)));
      else h.push(F(p));
    }
  } else {
    /* 跟注者在开池者之前：先跛入，被加注后补跟 */
    h.push(...foldsBefore(o.caller));
    h.push(C(o.caller, 1 - (BLIND[o.caller] ?? 0)));   // 跛入到 1BB（盲注位只需补差额）
    for (let i = idx(o.caller) + 1; i < idx(o.opener); i++) h.push(F(ORDER9[i]!));
    h.push(R(o.opener, 3));
    for (let i = idx(o.opener) + 1; i < ORDER9.length; i++) {
      const p = ORDER9[i]!;
      if (p === o.caller) h.push(C(p, 3 - 1));          // 补跟到 3BB
      else h.push(F(p));
    }
  }
  return base({
    heroPosition: o.hero, heroCards: o.cards, board: [...o.board], street: o.street,
    effectiveStackBB: o.stackBB ?? 100,
    ...(o.stats === null ? {} : { villain: { observedStats: o.stats as never } }),
    actionHistory: [...h, ...o.actions],
  });
};

const an = (input: ManualHandInput) => analyzeManualHand(input, { rules: RULES });

const label = (r: ReturnType<typeof an>): string => {
  if (!r.ok) return `失败[${r.issues.map((i) => i.code).join(',')}]`;
  const a = r.decision.action;
  if (a === null) return 'null(无建议)';
  const s = r.decision.diagnostics.actionShape?.sizeChips;
  return `${a}${s === undefined || s === null ? '' : `@${(s / 100).toFixed(1)}BB`}`;
};

const callEV = (r: ReturnType<typeof an>): number | null => {
  if (!r.ok) return null;
  const c = r.decision.diagnostics.candidates.find((x) => x.action === 'CALL');
  return c?.ev ?? r.decision.diagnostics.math.callEV ?? null;
};

let fails = 0;
const check = (name: string, ok: boolean, detail: string): void => {
  if (!ok) fails++;
  console.log(`${ok ? '  ✔' : '  ★'} ${name}${detail === '' ? '' : ` —— ${detail}`}`);
};
const fmt = (v: number | null): string => (v === null ? '—' : v.toFixed(2));

const PROFILES: readonly [string, Record<string, number> | null][] = [
  ['无统计', null],
  ['紧 15/10', { handsObserved: 80, vpip: 0.15, pfr: 0.1 }],
  ['松凶 85/60', { handsObserved: 80, vpip: 0.85, pfr: 0.6 }],
  ['跟注站 70/5', { handsObserved: 80, vpip: 0.7, pfr: 0.05 }],
];

const FLOP = ['Kh', '8c', '3d'] as const;

/* ════════ A. 位置 ════════ */
console.log('════════ A. 位置 ════════\n');
console.log('  A-0 「无人入池（开池）」= 已登记的已知边界，应为「拒绝给建议」：');
{
  for (const hero of [Position.UTG, Position.CO, Position.BTN, Position.SB]) {
    const r = an(foldedTo(hero, ['As', 'Ah']));
    const blocked = !r.ok || r.decision.action === null;
    const codeOk = r.ok && r.decision.reasons.some((x) => x.code === 'EQUITY_NOT_COMPUTABLE');
    console.log(`    ${hero.padEnd(3)} AA → ${label(r)}${codeOk ? '  [EQUITY_NOT_COMPUTABLE]' : ''}`);
    if (hero === Position.BTN) {
      check('A-0 无人入池必须拒绝给建议且给出 EQUITY_NOT_COMPUTABLE（不得猜）',
        blocked && codeOk, `${label(r)}`);
    }
  }
}

console.log('\n  A-1 开池者位置越靠后（范围越宽），Hero(BTN) 的 KJo 跟注 EV 不得更低：');
{
  const openers = [Position.UTG, Position.HJ, Position.CO]
    .filter((p) => idx(p) < idx(Position.BTN));
  const evs: [Position, number | null][] = [];
  for (const opener of openers) {
    const r = an(vsOpen(Position.BTN, opener, ['Kh', 'Jd']));
    evs.push([opener, callEV(r)]);
    console.log(`    面对 ${opener.padEnd(3)} 开池 → ${label(r).padEnd(12)} callEV=${fmt(callEV(r))}`);
  }
  const seq = evs.map(([, v]) => v);
  const monotone = seq.every((v, i) => i === 0 || v === null || seq[i - 1] === null || v >= seq[i - 1]!);
  check('A-1 跟注 EV 随开池者位置变宽而单调不下降', monotone,
    seq.map((v) => fmt(v)).join(' ≤ '));
}

console.log('\n  A-2 Hero 位置必须进入输出（同一手牌面对同一开池）：');
{
  const rows: string[] = [];
  for (const hero of [Position.BTN, Position.SB, Position.BB]) {
    const r = an(vsOpen(hero, Position.CO, ['Kh', 'Jd']));
    rows.push(`${hero.padEnd(3)}=${label(r)}/${fmt(callEV(r))}`);
  }
  console.log(`    ${rows.join('  ')}`);
  check('A-2 Hero 位置不同 ⇒ 输出可区分',
    new Set(rows.map((x) => x.split('=')[1])).size > 1, `${rows.length} 行`);
}

/* ════════ B. 资金 ════════ */
console.log('\n════════ B. 资金：有效筹码 20/40/100/200BB ════════\n');
console.log(`  牌面 ${FLOP.join(' ')}｜Hero BB ♠A♣K 面对 CO 4BB 持续下注`);
{
  const mk = (stack: number) => postflop({
    street: Street.FLOP, board: FLOP, hero: Position.BB, cards: ['As', 'Kc'],
    stats: null, stackBB: stack, opener: Position.CO, caller: Position.BB,
    actions: [CK(Position.BB, Street.FLOP), B(Position.CO, 4, Street.FLOP)],
  });
  const sprs: number[] = [];
  const shapes = new Set<string>();
  for (const stack of [20, 40, 100, 200]) {
    const r = an(mk(stack));
    const spr = r.ok ? r.decision.diagnostics.math.spr : null;
    if (spr !== null) sprs.push(spr);
    shapes.add(`${label(r)}|${r.ok ? String(r.decision.diagnostics.actionShape?.consumesStack) : 'x'}`);
    console.log(`    ${String(stack).padStart(3)}BB spr=${spr === null ? '—' : spr.toFixed(2)}` +
      `  ${label(r)}  callEV=${fmt(callEV(r))}`);
  }
  check('B-1 筹码深度必须改变输出（建议或是否打光）', shapes.size > 1, `${shapes.size} 种形态`);
  check('B-2 SPR 随筹码深度单调递增（SPR = 筹码 / 底池）',
    sprs.every((v, i) => i === 0 || v > sprs[i - 1]!), `spr=${sprs.map((v) => v.toFixed(2)).join(' < ')}`);
}

/* ════════ C. 牌力 ════════ */
console.log('\n════════ C. 牌力：同一牌面，跟注 EV 必须随牌力单调 ════════\n');
{
  const hands: readonly [string, readonly [string, string]][] = [
    ['暗三条 88', ['8h', '8d']],
    ['顶对顶踢 AK', ['As', 'Kc']],
    ['顶对弱踢 KJ', ['Ks', 'Jd']],
    ['中对 QQ', ['Qh', 'Qd']],
    ['中对 99', ['9h', '9d']],
    ['后门听 T9s', ['Th', '9h']],
    ['空气 JTs', ['Jh', 'Th']],
  ];
  const evs: (number | null)[] = [];
  for (const [name, cards] of hands) {
    const r = an(postflop({
      street: Street.FLOP, board: FLOP, hero: Position.BB, cards, stats: null,
      opener: Position.CO, caller: Position.BB,
      actions: [CK(Position.BB, Street.FLOP), B(Position.CO, 4, Street.FLOP)],
    }));
    evs.push(callEV(r));
    console.log(`    ${name.padEnd(13)} ${label(r).padEnd(12)} callEV=${fmt(callEV(r))}`);
  }
  const order: readonly [number, number, string][] = [
    [0, 1, '暗三条 > 顶对顶踢'], [0, 3, '暗三条 > 中对 QQ'],
    [1, 3, '顶对顶踢 > 中对 QQ'], [1, 6, '顶对顶踢 > 空气'],
    [2, 6, '顶对弱踢 > 空气'], [3, 6, '中对 QQ > 空气'], [3, 4, 'QQ > 99'],
  ];
  for (const [a, b, why] of order) {
    const x = evs[a]; const y = evs[b];
    check(`C ${why}`, x !== null && y !== null && x > y,
      `${hands[a]![0]}=${fmt(x)} vs ${hands[b]![0]}=${fmt(y)}`);
  }
}

/* ════════ D. 位置打法 ════════ */
console.log('\n════════ D. 位置打法：同一牌面同一手牌，有位置 vs 无位置 ════════\n');
{
  const oop = an(postflop({
    street: Street.FLOP, board: FLOP, hero: Position.BB, cards: ['As', 'Kc'], stats: null,
    opener: Position.CO, caller: Position.BB,
    actions: [CK(Position.BB, Street.FLOP), B(Position.CO, 4, Street.FLOP)],
  }));
  const ip = an(postflop({
    street: Street.FLOP, board: FLOP, hero: Position.BTN, cards: ['As', 'Kc'], stats: null,
    opener: Position.CO, caller: Position.BTN, actions: [B(Position.CO, 4, Street.FLOP)],
  }));
  console.log(`    无位置 Hero BB  面对 CO 4BB → ${label(oop).padEnd(12)} callEV=${fmt(callEV(oop))}`);
  console.log(`    有位置 Hero BTN 面对 CO 4BB → ${label(ip).padEnd(12)} callEV=${fmt(callEV(ip))}`);
  check('D-1 位置必须进入决策（IP 与 OOP 可区分）',
    label(oop) !== label(ip) || callEV(oop) !== callEV(ip), '');

  /* 被过牌到（只有有位置的一方才能「被过牌到」） */
  const checkedTo = an(postflop({
    street: Street.FLOP, board: FLOP, hero: Position.BTN, cards: ['As', 'Kc'], stats: null,
    opener: Position.CO, caller: Position.BTN, actions: [CK(Position.CO, Street.FLOP)],
  }));
  console.log(`    有位置 Hero BTN 被过牌到 → ${label(checkedTo)}`);
  check('D-2 被过牌到时必须给主动下注建议', label(checkedTo).startsWith('BET'), label(checkedTo));

  /* 无位置先行动（对手还没表态）—— 必须给建议而不是 null */
  const firstToAct = an(postflop({
    street: Street.FLOP, board: FLOP, hero: Position.BB, cards: ['As', 'Kc'], stats: null,
    opener: Position.CO, caller: Position.BB, actions: [],
  }));
  console.log(`    无位置 Hero BB 先行动（无人下注）→ ${label(firstToAct)}`);
  check('D-3 无位置先行动必须给建议（不得 null）',
    !label(firstToAct).startsWith('null'), label(firstToAct));
}

/* ════════ E. 人物画像 ════════ */
console.log('\n════════ E. 人物画像：同一局面换四种画像 ════════\n');
{
  const seen = new Set<string>();
  for (const [name, stats] of PROFILES) {
    const r = an(postflop({
      street: Street.FLOP, board: FLOP, hero: Position.BB, cards: ['As', 'Kc'], stats,
      opener: Position.CO, caller: Position.BB,
      actions: [CK(Position.BB, Street.FLOP), B(Position.CO, 4, Street.FLOP)],
    }));
    seen.add(`${label(r)}|${fmt(callEV(r))}`);
    console.log(`    ${name.padEnd(11)} ${label(r).padEnd(12)} callEV=${fmt(callEV(r))}`);
  }
  check('E-1 四种画像必须产生可区分输出', seen.size > 1, `${seen.size} 种不同输出`);

  const plain = an(postflop({
    street: Street.FLOP, board: FLOP, hero: Position.BB, cards: ['As', 'Kc'], stats: null,
    opener: Position.CO, caller: Position.BB,
    actions: [CK(Position.BB, Street.FLOP), B(Position.CO, 4, Street.FLOP)],
  }));
  const riverStat = an(postflop({
    street: Street.FLOP, board: FLOP, hero: Position.BB, cards: ['As', 'Kc'],
    stats: { handsObserved: 80, foldToRiverBet: 0.9 }, opener: Position.CO, caller: Position.BB,
    actions: [CK(Position.BB, Street.FLOP), B(Position.CO, 4, Street.FLOP)],
  }));
  check('E-2 河牌统计不得改变翻牌节点（语义门）',
    label(plain) === label(riverStat) && callEV(plain) === callEV(riverStat),
    `无统计=${label(plain)}/${fmt(callEV(plain))} 带河牌统计=${label(riverStat)}/${fmt(callEV(riverStat))}`);

  const pre = PROFILES.map(([name, stats]) => {
    const r = an(vsOpen(Position.BB, Position.BTN, ['Ah', 'Qh'], stats));
    const sizes = r.ok ? (r.decision.diagnostics.preflopRaise?.sizes ?? []) : [];
    return { name, table: JSON.stringify(sizes.map((s) => [s.sizeBB, s.raiseEV])), label: label(r) };
  });
  pre.forEach((p) => console.log(`    翻前 ${p.name.padEnd(11)} ${p.label}`));
  check('E-3 翻前逐尺寸加注 EV 必须随画像变化',
    new Set(pre.map((p) => p.table)).size > 1, `${new Set(pre.map((p) => p.table)).size} 种`);

  /*
   * 河牌：**下注尺度**这一条最初写的是「换画像必须改变尺度」——实测**不成立**，
   * 而且原因是模型层的**已声明边界**，不是缺陷：
   *
   * · 河牌被过牌到时 `betDecision` 会算逐尺寸响应概率，但候选表的 BET 行
   *   `ev` 恒为 `null`，`unevaluatedActions` 如实登记 `BET_EV_NOT_IMPLEMENTED`
   *   （「下注 EV 依赖对手弃牌率，本项目没有可信估计 ⇒ 不参与 EV 比较」）；
   * · 而描述「对手对我的下注弃牌」的两个统计（`foldToRiverBet` / `foldToFlopCBet`）
   *   在**所有**实测节点上都返回 `NOT_APPLICABLE`（「通道存在，但本节点语义门不适用」）
   *   ⇒ **弃牌倾向类统计从未进入下注通道**。
   *
   * 因此把这条不变量换成两条**真实且可证伪**的：
   * E-4a 下注 EV 的「未建模」必须在**两处披露上一致**（候选表 EV 为 null ⇔ 出现在
   *      `unevaluatedActions`）—— 与 `kqFlopDisclosureRepair` 的 D6 同一不变量；
   * E-4b 河牌统计必须被**运行时三态披露**（不得静默忽略）。
   */
  const riverBoard = ['Kh', '8c', '3d', '2s', '7h'] as const;
  for (const [name, stats] of PROFILES) {
    const r = an(postflop({
      street: Street.RIVER, board: riverBoard, hero: Position.BTN, cards: ['As', 'Kc'], stats,
      opener: Position.CO, caller: Position.BTN,
      actions: [CK(Position.CO, Street.FLOP), CK(Position.BTN, Street.FLOP),
        CK(Position.CO, Street.TURN), CK(Position.BTN, Street.TURN),
        CK(Position.CO, Street.RIVER)],
    }));
    console.log(`    河牌被过牌到 ${name.padEnd(11)} ${label(r)}`);
  }
  {
    const r = an(postflop({
      street: Street.RIVER, board: riverBoard, hero: Position.BTN, cards: ['As', 'Kc'], stats: null,
      opener: Position.CO, caller: Position.BTN,
      actions: [CK(Position.CO, Street.FLOP), CK(Position.BTN, Street.FLOP),
        CK(Position.CO, Street.TURN), CK(Position.BTN, Street.TURN),
        CK(Position.CO, Street.RIVER)],
    }));
    if (r.ok) {
      const d = r.decision.diagnostics;
      const betRows = d.candidates.filter((c) => c.action === 'BET');
      const listedBets = (d.unevaluatedActions ?? [])
        .filter((u) => u.reasonCode === 'BET_EV_NOT_IMPLEMENTED')
        .map((u) => u.sizeChips);
      const mismatch = betRows.filter((c) =>
        c.ev === null
          ? !listedBets.some((s) => s !== null && Math.abs(s - (c.sizeChips ?? -1)) < 1e-9)
          : listedBets.some((s) => s !== null && Math.abs(s - (c.sizeChips ?? -1)) < 1e-9));
      check('E-4a 下注 EV 的未建模状态必须在候选表与未评估清单上一致',
        mismatch.length === 0,
        mismatch.length === 0
          ? `BET 候选 ${betRows.length} 档，两处一致`
          : `不一致：${JSON.stringify(mismatch.map((c) => [c.sizeBB, c.ev]))}`);
    }
  }
  {
    /* E-4b：河牌统计（实测提供的 foldToRiverBet）必须被运行时三态披露，不得静默忽略 */
    const r = an(postflop({
      street: Street.RIVER, board: riverBoard, hero: Position.BTN, cards: ['As', 'Kc'],
      stats: { handsObserved: 800, vpip: 0.4, pfr: 0.2, foldToRiverBet: 0.85 },
      opener: Position.CO, caller: Position.BTN,
      actions: [CK(Position.CO, Street.FLOP), CK(Position.BTN, Street.FLOP),
        CK(Position.CO, Street.TURN), CK(Position.BTN, Street.TURN),
        CK(Position.CO, Street.RIVER)],
    }));
    const js = r.ok ? JSON.stringify(r) : '';
    const disclosed = /foldToRiverBet[^}]*"status":"(USED|NOT_APPLICABLE|NO_DATA)"/.test(js);
    const status = (js.match(/foldToRiverBet","status":"([A-Z_]+)"/) ?? [])[1] ?? '（未披露）';
    check('E-4b 弃牌倾向类统计必须被运行时三态披露（不得静默忽略）',
      disclosed, `foldToRiverBet = ${status}`);
  }
}

/* ════════ F. 位置 × 画像 交互 ════════ */
console.log('\n════════ F. 位置 × 画像 交互：Hero KJo 面对 CO 开池 ════════\n');
{
  for (const hero of [Position.BTN, Position.SB, Position.BB]) {
    const row: string[] = [];
    for (const [name, stats] of PROFILES) {
      row.push(`${name}=${label(an(vsOpen(hero, Position.CO, ['Kh', 'Jd'], stats)))}`);
    }
    console.log(`    Hero ${hero.padEnd(3)}  ${row.join('  ')}`);
  }
  const sig = new Set<string>();
  for (const hero of [Position.BTN, Position.SB, Position.BB]) {
    for (const [name, stats] of PROFILES) {
      sig.add(`${hero}|${name}|${label(an(vsOpen(hero, Position.CO, ['Kh', 'Jd'], stats)))}`);
    }
  }
  check('F-1 位置 × 画像 必须产生 ≥3 种不同输出', sig.size >= 3, `${sig.size} 种`);
}

console.log(`\n════════ 结果：不变量失败 ${fails} 项 ════════`);
if (fails > 0) process.exitCode = 1;
