/**
 * flopriver-agent1-rel.ts —— 附加必查项：
 *   H · 顶对 vs 中对 / 顶对强踢脚 vs 弱踢脚 / 超对 vs 口袋对 vs 板面对子
 *   I · 阻断牌受控对照（同形状、只差一张♠）＋ 用死牌枚举独立复算支持集
 *   J · 同一个河牌顶对，两个完全不同对手画像（松凶 vs 极紧）
 *   K · 死牌剔除的独立复算（枚举 1326 组合扣除 英雄底牌+公共牌）
 *
 * 复现：node --experimental-strip-types scripts/flopriver-agent1-rel.ts
 */
import {
  detailOf, prodContextOf, A_, BASE, PF_BTN_RAISE_BB_CALL, villainOf, line, kv, rule, n, pct,
  tierHistogramZh, type Node,
} from './flopriver-agent1-harness.ts';

const FLOP = (bet: number, call: number) => [
  A_('BB', 'CHECK', undefined, 'FLOP'), A_('BTN', 'BET', bet, 'FLOP'), A_('BB', 'CALL', call, 'FLOP'),
];
const TURN_CB = (bet: number) => [A_('BB', 'BET', bet, 'TURN'), A_('BTN', 'CALL', bet, 'TURN')];

const cardCode = (rank: number, suit: string): string => `${'23456789TJQKA'[rank - 2]!}${suit}`;
const zhOf = (codes: readonly string[]): string =>
  codes.map((c) => {
    const rk = c[0]!; const suit = c[1]!.toLowerCase();
    const st = ({ s: '♠', h: '♥', d: '♦', c: '♣' } as Record<string, string>)[suit] ?? suit;
    return `${rk}${st}`;
  }).join(' ');
type Row = {
  tag: string; hero: readonly string[]; board: readonly string[]; street: string;
  history: readonly Record<string, unknown>[]; villain: ReturnType<typeof villainOf>;
};

const results: Record<string, any> = {};

function run(row: Row): Record<string, any> {
  const node: Node = { tag: row.tag, heroCards: row.hero, board: row.board, street: row.street, history: row.history, villain: row.villain };
  const D = detailOf(node);
  const C = prodContextOf(D.built);
  const out = {
    hero: row.hero, board: row.board, street: row.street,
    villain: String(row.villain.quickProfile ?? 'UNKNOWN'),
    handRankZh: D.math['handRankZh'], handCategory: D.math['handCategory'],
    madeHandZh: D.pf['madeHandZh'], handRole: D.pf['handRole'], handRoleZh: D.pf['handRoleZh'],
    roleStrength: D.pf['roleStrength'],
    showdownValue: D.pf['showdownValue'], protectionValue: D.pf['protectionValue'], bluffPotential: D.pf['bluffPotential'],
    heroEquity: D.math['heroEquity'], heroEquityVsBetRange: D.math['heroEquityVsBetRange'],
    requiredEquity: D.math['requiredEquity'], callEV: D.math['callEV'],
    cond: D.dg['conditionalEquities'],
    cands: (D.dg['candidates'] ?? []).map((c: any) => ({ a: c['action'], s: c['sizeChips'], ev: c['ev'] })),
    action: `${String(D.decision['action'])}${D.decision['sizeChips'] === undefined ? '' : ` ${String(D.decision['sizeChips'])}`}`,
    classification: D.decision['classification'],
    support: C.snap?.['supportSize'] ?? null,
    sourceKind: C.snap?.['sourceKind'] ?? null,
    facts: C.facts === null ? null : {
      supportSize: C.facts['supportSize'], weakerShare: C.facts['weakerShare'], equalShare: C.facts['equalShare'],
      strongerShare: C.facts['strongerShare'], strongShare: C.facts['strongShare'], meanTier: C.facts['meanTier'],
      suitFit: C.facts['suitFit'], drawShare: C.facts['drawShare'], tierHistogram: C.facts['tierHistogram'],
    },
    blockers: D.pf['blockers'] ?? null,
    handStructure: C.postflopFacts?.['handStructure'] ?? null,
    reasons: (D.decision['reasons'] ?? []).map((x: any) => `[${String(x['code'])}] ${String(x['textZh']).slice(0, 150)}`),
  };
  results[row.tag] = out;
  return out;
}

const V_BASE = villainOf('CALLING_STATION');
const board_RIVER = ['Kd', 'Qc', '7h', '4s', '2d'] as const;
const histRIVER = [...PF_BTN_RAISE_BB_CALL, ...FLOP(4, 4), ...TURN_CB(10), A_('BB', 'BET', 20, 'RIVER')];

/* ============================================================
 * H · 对子层级与踢脚
 * ============================================================ */
const H = [
  ['H-顶对(强踢脚) K♠Q♥', ['Ks', 'Qh']],
  ['H-顶对(弱踢脚) K♠5♥', ['Ks', '5h']],
  ['H-中对 Q♠J♥', ['Qs', 'Jh']],
  ['H-超对 A♠A♥', ['As', 'Ah']],
  ['H-小对子(低于板面) 6♠6♥', ['6s', '6h']],
] as const;
line(rule());
line(' H · 同一河牌节点（板 K♦ Q♣ 7♥ 4♠ 2♦，BB 下注 20BB）只换 Hero 底牌');
line(rule());
line(`   ${'Hero'.padEnd(24)}| ${'handRankZh'.padEnd(24)}| ${'madeHandZh'.padEnd(10)}| ${'roleZh'.padEnd(12)}| 强度   | 权益(整体) | 权益(下注范围) | CALL EV  | 动作`);
for (const [tag, hero] of H) {
  const o = run({ tag, hero, board: board_RIVER, street: 'RIVER', history: histRIVER, villain: V_BASE });
  line(
    `   ${tag.padEnd(24)}| ${String(o.handRankZh).padEnd(24)}| ${String(o.madeHandZh).padEnd(10)}| ${String(o.handRoleZh).padEnd(12)}|` +
    ` ${n(o.roleStrength, 3).padStart(6)} | ${pct(o.heroEquity, 3).padStart(10)} | ${pct(o.heroEquityVsBetRange, 3).padStart(14)} |` +
    ` ${n(o.callEV, 3).padStart(8)} | ${String(o.action).padEnd(9)} ${String(o.classification)}`,
  );
}
line('');
line('   权益口径冲突检查（same node）：');
{
  const a = results['H-顶对(强踢脚) K♠Q♥']!;
  const b = results['H-顶对(弱踢脚) K♠5♥']!;
  const c = results['H-中对 Q♠J♥']!;
  const d = results['H-小对子(低于板面) 6♠6♥']!;
  kv('   KQ 两对：整体权益 vs 角色档位', `${pct(a.heroEquity, 3)} ⇒ 角色「${String(a.handRoleZh)}」(${n(a.roleStrength, 3)})，EQUITY_BANDS.MEDIUM=0.58`);
  kv('   K5 顶对：整体权益 vs 角色档位', `${pct(b.heroEquity, 3)} ⇒ 角色「${String(b.handRoleZh)}」(${n(b.roleStrength, 3)})`);
  kv('   QJ 中对：整体权益 vs 角色档位', `${pct(c.heroEquity, 3)} ⇒ 角色「${String(c.handRoleZh)}」(${n(c.roleStrength, 3)})`);
  kv('   66 小对子：整体权益 vs 角色档位', `${pct(d.heroEquity, 3)} ⇒ 角色「${String(d.handRoleZh)}」(${n(d.roleStrength, 3)})（equity < THIN 0.45 ⇒ AIR 分支）`);
  kv('   小对子 66 的 weaker+equal+stronger 占比合计', `${n((d.facts.weakerShare + d.facts.equalShare + d.facts.strongerShare), 6)}（<1 的部分 = 与 Hero 底牌/公共牌冲突、被跳过但计入分母的组合：rangeFacts.ts:146-158 的 total 仍包含它们）`);
}

line('');
line('   逐项细节（H 组）：');
for (const [tag] of H) {
  const o = results[tag]!;
  kv(`   ${tag}`, `support ${String(o.support)} ｜ facts weaker ${pct(o.facts?.weakerShare, 2)} / equal ${pct(o.facts?.equalShare, 2)} / stronger ${pct(o.facts?.strongerShare, 2)} ｜ suitFit ${pct(o.facts?.suitFit, 2)} ｜ structure ${String(o.handStructure?.['structureLabel'])}`);
}

/* 板面成对：超对/顶对在两对板面上的降级 */
line('');
line('   板面成对节点的「对子 vs 板面对子」：板 K♦ Q♣ K♥ 4♠ 2♦（成对）');
for (const [tag, hero] of [['H2-超对 AA（板面有 K 对）', ['As', 'Ah']], ['H2-顶对 K（板面 K 对 = 明三条）', ['Ks', 'Qh']], ['H2-两对 Q（板 K 对 + 我 Q 对）', ['Qs', 'Qh']]] as const) {
  const o = run({ tag, hero, board: ['Kd', 'Qc', 'Kh', '4s', '2d'], street: 'RIVER', history: histRIVER, villain: V_BASE });
  kv(`   ${tag}`, `${String(o.handRankZh)} ｜ cat ${String(o.handCategory)} ｜ ${String(o.madeHandZh)} ｜ ${String(o.handRoleZh)}(${n(o.roleStrength, 3)}) ｜ eq ${pct(o.heroEquity, 3)} ｜ eqVsBet ${pct(o.heroEquityVsBetRange, 3)} ｜ ${String(o.action)}`);
}

/* ============================================================
 * I · 阻断牌受控对照：同点数形状、只差花色
 * ============================================================ */
const board_SPADE_RIVER = ['Ks', 'Qs', '7s', '2d', '3h'] as const;
line('');
line(rule());
line(' I · 阻断牌受控对照（板 K♠ Q♠ 7♠ 2♦ 3♥，BB 下注 20BB）：只改 Hero 手牌花色');
line(rule());
line(`   ${'Hero'.padEnd(16)}| ${'handRankZh'.padEnd(20)}| 权益(整体)  | 权益(下注范围) | 挡更强/挡更弱 | 价值候选/诈唬候选 | net    | support`);
const I_ROWS = [
  ['I1 J♠T♥（持♠）', ['Js', 'Th']],
  ['I2 J♥T♦（不持♠）', ['Jh', 'Td']],
  ['I3 A♠J♥（持 A♠）', ['As', 'Jh']],
  ['I4 A♥J♦（不持♠）', ['Ah', 'Jd']],
] as const;
for (const [tag, hero] of I_ROWS) {
  const o = run({ tag, hero, board: board_SPADE_RIVER, street: 'RIVER', history: histRIVER, villain: V_BASE });
  const b = o.blockers ?? {};
  line(
    `   ${tag.padEnd(16)}| ${String(o.handRankZh).padEnd(20)}| ${pct(o.heroEquity, 4).padStart(10)} | ${pct(o.heroEquityVsBetRange, 4).padStart(14)} |` +
    ` ${String(b['blockedStrongerCombos'] ?? '—').padStart(5)}/${String(b['blockedWeakerCombos'] ?? '—').padEnd(5)} | ${String(b['blockedValueBetCandidateCount'] ?? '—').padStart(5)}/${String(b['blockedBluffCandidateCount'] ?? '—').padEnd(5)} |` +
    ` ${n(b['netBlockerPreference'], 3).padStart(6)} | ${String(o.support)}`,
  );
}
line('');
line('   细节（I 组）：');
for (const [tag] of I_ROWS) {
  const o = results[tag]!;
  kv(`   ${tag}`, `structure ${String(o.handStructure?.['structureLabel'])} ｜ ${String(o.handRoleZh)}(${n(o.roleStrength, 3)}) ｜ ${String(o.action)} ｜ blockers net ${n(o.blockers?.['netBlockerPreference'], 4)}`);
}

/* ============================================================
 * J · 同一河牌顶对，两个完全不同对手画像
 * ============================================================ */
line('');
line(rule());
line(' J · 同一节点（Hero K♠Q♥ ｜ 板 K♦Q♣7♥4♠2♦ ｜ BB 下注 20BB）只改对手画像');
line(rule());
line(`   ${'对手'.padEnd(30)}| 权益(整体)  | 权益(下注范围) | 到达范围权益 | support | 更差/更好     | 动作     | 分类`);
const VILLAINS = [
  ['J1 极紧 VERY_TIGHT（无统计）', villainOf('VERY_TIGHT')],
  ['J2 松凶 MANIAC 800 手 72/55/28', { seatId: 'seat_BB', persistentPlayerId: 'player_001', displayName: '阿豪', quickProfile: 'MANIAC', dynamicHint: 'UNKNOWN' as const, stackBB: 100, observedStats: { handsObserved: 800, vpip: 0.72, pfr: 0.55, threeBet: 0.28, wtsd: 0.2, foldToFlopCBet: null, foldToTurnCBet: null, foldToRiverBet: null, flopCheckRaise: null, turnCheckRaise: null, riverCheckRaise: null } } as any],
  ['J3 跟注站 CALLING_STATION', villainOf('CALLING_STATION')],
] as const;
for (const [tag, vil] of VILLAINS) {
  const o = run({ tag, hero: ['Ks', 'Qh'], board: board_RIVER, street: 'RIVER', history: histRIVER, villain: vil });
  line(
    `   ${tag.padEnd(30)}| ${pct(o.heroEquity, 4).padStart(10)} | ${pct(o.heroEquityVsBetRange, 4).padStart(14)} |` +
    ` ${pct(o.cond?.['arrivalRange'], 4).padStart(12)} | ${String(o.support).padStart(7)} | ${pct(o.facts?.weakerShare, 2)}/${pct(o.facts?.strongerShare, 2)} |` +
    ` ${String(o.action).padEnd(8)} | ${String(o.classification)}`,
  );
}
line('');
line('   细节（J 组）：');
for (const [tag] of VILLAINS) {
  const o = results[tag]!;
  kv(`   ${tag}`, `${String(o.handRankZh)} ｜ ${String(o.handRoleZh)}(${n(o.roleStrength, 3)}) ｜ req ${pct(o.requiredEquity, 2)} ｜ callEV ${n(o.callEV, 3)} ｜ cands ${JSON.stringify(o.cands)}`);
  kv('     reasons', String((o.reasons ?? []).slice(0, 3).join(' ‖ ')).slice(0, 260));
}

/* ============================================================
 * K · 死牌剔除独立复算（枚举全部 1326 组合）
 * ============================================================ */
line('');
line(rule());
line(' K · 死牌独立复算：枚举 52 张的 1326 组合，扣除「Hero 底牌 + 公共牌」');
line(rule());
{
  const { ALL_COMBOS } = await import('../src/domain/range/combo.ts');
  const { ALL_CARDS } = await import('../src/domain/types.ts');
  /** 规范牌文本 → 索引（与 ALL_CARDS 同序：花色外层 × 点数内层） */
  const idxOfCode = new Map<string, number>();
  ALL_CARDS.forEach((c, i) => idxOfCode.set(`${'23456789TJQKA'[c.rank - 2]!}${c.suit}`, i));
  const FLOP_H = [...PF_BTN_RAISE_BB_CALL, A_('BB', 'BET', 4, 'FLOP')];
  const checks: readonly (readonly [string, readonly string[], readonly string[], string])[] = [
    ['K1 A♠A♥ + 板 K♦7♣2♥（= 用例 G1）', ['As', 'Ah'], ['Kd', '7c', '2h'], 'K1'],
    ['K2 8♠8♥ + 板 K♦7♣2♥（= 用例 G2）', ['8s', '8h'], ['Kd', '7c', '2h'], 'K2'],
    ['K3 A♦Q♦ + 板 A♠K♥Q♠4♦K♦（= 用例 E1）', ['Ad', 'Qd'], ['As', 'Kh', 'Qs', '4d', 'Kd'], 'K3'],
    ['K4 K♠Q♥ + 板 K♦Q♣7♥4♠2♦（= H/J）', ['Ks', 'Qh'], ['Kd', 'Qc', '7h', '4s', '2d'], 'K4'],
  ];
  for (const [tag, hero, board, rtag] of checks) {
    const street = board.length === 3 ? 'FLOP' : 'RIVER';
    const history = board.length === 3 ? FLOP_H : histRIVER;
    const o = run({ tag: rtag, hero, board, street, history, villain: V_BASE });
    const dead = new Set<number>();
    for (const code of [...hero, ...board]) {
      const i = idxOfCode.get(code);
      if (i === undefined) throw new Error(`未知牌 ${code}`);
      dead.add(i);
    }
    let withDeadCombo = 0;
    let withAce = 0;
    for (const combo of ALL_COMBOS) {
      const [i1, i2] = combo.cardIndices;
      if (dead.has(i1) || dead.has(i2)) { withDeadCombo += 1; continue; }
      if (ALL_CARDS[i1]!.rank === 14 || ALL_CARDS[i2]!.rank === 14) withAce += 1;
    }
    const remaining = 1326 - withDeadCombo;
    kv(
      `   ${tag}`,
      `死牌 ${dead.size} ⇒ 1326 − ${withDeadCombo} = ${remaining}（合法组合上限）｜ 合法组合中含 A 的 ${withAce} 个 ｜ **生产 supportSize = ${String(o.support)}**（差 ${remaining - Number(o.support)} = 权重为 0 的牌类组合）`,
    );
  }
}
line(rule());
