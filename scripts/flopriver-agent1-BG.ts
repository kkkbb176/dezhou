/**
 * flopriver-agent1-BG.ts —— 用例 B / C / D / E / F / G（Agent 1：牌力 · 权益 · 牌面结构）
 *
 * 复现：node --experimental-strip-types scripts/flopriver-agent1-BG.ts
 */
import {
  detailOf, prodContextOf, A_, PF_BTN_RAISE_BB_CALL, villainOf, line, kv, rule, n, pct,
  tierHistogramZh, type Node,
} from './flopriver-agent1-harness.ts';

const FLOP = (bet: number, call: number) => [
  A_('BB', 'CHECK', undefined, 'FLOP'), A_('BTN', 'BET', bet, 'FLOP'), A_('BB', 'CALL', call, 'FLOP'),
];
const TURN_CB = (bet: number) => [A_('BB', 'BET', bet, 'TURN'), A_('BTN', 'CALL', bet, 'TURN')];

/** 把内部牌文本（如 '14s'）转成中文显示 */
const zhOf = (codes: readonly string[]): string =>
  codes.map((c) => {
    const rank = Number(c.slice(0, -1));
    const suit = c.slice(-1);
    const rk = '23456789TJQKA'[rank - 2] ?? '?';
    const st = ({ s: '♠', h: '♥', d: '♦', c: '♣' } as Record<string, string>)[suit] ?? suit;
    return `${rk}${st}`;
  }).join(' ');

function show(tag: string, node: Node, extra: readonly (readonly [string, string])[] = []): void {
  const D = detailOf(node);
  const C = prodContextOf(D.built);
  line('');
  line(`── ${tag} ──`);
  kv('节点', `${zhOf(node.heroCards.map(cn))} ｜ 板 ${zhOf(node.board.map(cn))} ｜ ${node.street} ｜ 对手 ${String(node.villain.quickProfile ?? 'UNKNOWN')}`);
  kv('① handRankZh', String(D.math['handRankZh']));
  kv('② handCategory', String(D.math['handCategory']));
  kv('③ madeHand / madeHandZh', `${String(D.pf['madeHand'])} ｜ ${String(D.pf['madeHandZh'])}`);
  kv('④ role / roleZh / roleStrength', `${String(D.pf['handRole'])} ｜ ${String(D.pf['handRoleZh'])} ｜ ${n(D.pf['roleStrength'], 4)}`);
  kv('⑤ showdown / protection / bluffPotential', `${n(D.pf['showdownValue'], 4)} ｜ ${n(D.pf['protectionValue'], 4)} ｜ ${n(D.pf['bluffPotential'], 4)}`);
  const hs = C.postflopFacts?.['handStructure'] ?? null;
  if (hs !== null) {
    kv('⑥ handStructure', `${String(hs['structureLabel'])} ｜ flushDraw=${String(hs['flushDraw'])} openEnded=${String(hs['openEnded'])} gutshot=${String(hs['gutshot'])} ｜ raw ${String(hs['rawOuts'])}/clean ${String(hs['cleanOuts'])}/disc ${String(hs['discountedOuts'])}/dirty ${String(hs['dirtyOuts'])}`);
  }
  kv('⑦ heroEquity / VsBetRange', `${pct(D.math['heroEquity'], 6)} ｜ ${pct(D.math['heroEquityVsBetRange'], 6)}`);
  kv('⑧ requiredEquity / callEV', `${pct(D.math['requiredEquity'], 4)} ｜ ${n(D.math['callEV'], 8)}`);
  kv('⑨ conditionalEquities', JSON.stringify(D.dg['conditionalEquities'] ?? null).slice(0, 240));
  kv('⑩ candidates', JSON.stringify((D.dg['candidates'] ?? []).map((c: any) => ({ a: c['action'], s: c['sizeChips'], ev: c['ev'] }))));
  kv('⑪ 最终动作', `${String(D.decision['action'])}${D.decision['sizeChips'] === undefined ? '' : ` ${String(D.decision['sizeChips'])}`} ｜ conf ${n(D.decision['confidence'], 4)} ｜ ${String(D.decision['classification'])}`);
  kv('⑫ 范围快照', C.snap === null ? 'null' : `${String(C.snap['sourceKind'])} ｜ support ${String(C.snap['supportSize'])} ｜ share ${n(C.snap['supportShare'], 4)} ｜ conf ${n(C.snap['confidence'], 3)}`);
  kv('⑬ 到达范围事实', C.facts === null ? 'null' : `support ${String(C.facts['supportSize'])} ｜ weaker ${pct(C.facts['weakerShare'], 3)}/equal ${pct(C.facts['equalShare'], 3)}/stronger ${pct(C.facts['strongerShare'], 3)} ｜ strongShare ${pct(C.facts['strongShare'], 3)} ｜ meanTier ${n(C.facts['meanTier'], 4)} ｜ suitFit ${pct(C.facts['suitFit'], 3)} ｜ drawShare ${pct(C.facts['drawShare'], 3)}`);
  kv('⑭ tierHistogram', tierHistogramZh(C.facts?.['tierHistogram']));
  const b = D.pf['blockers'] as Record<string, any> | undefined;
  if (b !== undefined) kv('⑮ blockers', `更强被挡 ${String(b['blockedStrongerCombos'])} / 更弱被挡 ${String(b['blockedWeakerCombos'])} ｜ 价值候选 ${String(b['blockedValueBetCandidateCount'])} / 诈唬候选 ${String(b['blockedBluffCandidateCount'])} ｜ net ${n(b['netBlockerPreference'], 4)} ｜ evidence ${String(b['evidenceQuality'])}`);
  for (const [k, v] of extra) kv(k, v);
}

/** 牌文本：'As' → 内部键 '14s' */
function cn(code: string): string {
  const rank = code[0]!.toUpperCase();
  const suit = code[1]!.toLowerCase();
  const r = '23456789TJQKA'.indexOf(rank) + 2;
  return `${r}${suit}`;
}

/* ==================================================================
 * B · 暗三条面对三张同花牌面
 * ================================================================== */
line(rule());
line(' B · 暗三条 vs 三花牌面：Hero 9♥9♣ ｜ 板 9♦ K♣ 4♣ / 6♣');
line(rule());
show('B1 转牌第三张♣ 已到，Hero 面对 BB 14BB 下注', {
  tag: 'B1', heroCards: ['9h', '9c'], board: ['9d', 'Kc', '4c', '6c'], street: 'TURN',
  history: [...PF_BTN_RAISE_BB_CALL, ...FLOP(4, 4), A_('BB', 'BET', 14, 'TURN')],
  villain: villainOf('CALLING_STATION'),
});
show('B2 对照：翻牌（只有两张♣）同一手牌', {
  tag: 'B2', heroCards: ['9h', '9c'], board: ['9d', 'Kc', '4c'], street: 'FLOP',
  history: [...PF_BTN_RAISE_BB_CALL, A_('BB', 'BET', 4, 'FLOP')],
  villain: villainOf('CALLING_STATION'),
});

/* ==================================================================
 * C · 河牌一对面对明显的成花
 * ================================================================== */
line('');
line(rule());
line(' C · 河牌一对 vs 三张♣ 成花：Hero 9♥9♣ ｜ 板 K♦ Q♣ J♣ 4♠ 2♣');
line(rule());
show('C1 河牌面对 BB 20BB 下注（♣ 成花）', {
  tag: 'C1', heroCards: ['9h', '9c'], board: ['Kd', 'Qc', 'Jc', '4s', '2c'], street: 'RIVER',
  history: [...PF_BTN_RAISE_BB_CALL, ...FLOP(4, 4), ...TURN_CB(10), A_('BB', 'BET', 20, 'RIVER')],
  villain: villainOf('CALLING_STATION'),
});
show('C2 对照：同牌面对手过牌（Hero 无人下注）', {
  tag: 'C2', heroCards: ['9h', '9c'], board: ['Kd', 'Qc', 'Jc', '4s', '2c'], street: 'RIVER',
  history: [...PF_BTN_RAISE_BB_CALL, ...FLOP(4, 4), ...TURN_CB(10), A_('BB', 'CHECK', undefined, 'RIVER')],
  villain: villainOf('CALLING_STATION'),
});

/* ==================================================================
 * D · 河牌板面四张 / 五张同花
 * ================================================================== */
line('');
line(rule());
line(' D · 板面四张♣：Hero 9♥9♣ ｜ 板 A♣ K♣ 7♣ 2♣ → 河牌 3♣（板面自成为 A 高同花）');
line(rule());
show('D1 河牌 3♣，面对 BB 20BB 下注', {
  tag: 'D1', heroCards: ['9h', '9c'], board: ['Ac', 'Kc', '7c', '2c', '3c'], street: 'RIVER',
  history: [...PF_BTN_RAISE_BB_CALL, ...FLOP(4, 4), ...TURN_CB(10), A_('BB', 'BET', 20, 'RIVER')],
  villain: villainOf('CALLING_STATION'),
});
show('D2 对照：同样四张♣ 的板面，但那是转牌（板 A♣K♣7♣2♣），Hero 面对下注', {
  tag: 'D2', heroCards: ['9h', '9c'], board: ['Ac', 'Kc', '7c', '2c'], street: 'TURN',
  history: [...PF_BTN_RAISE_BB_CALL, ...FLOP(4, 4), A_('BB', 'BET', 20, 'TURN')],
  villain: villainOf('CALLING_STATION'),
});

/* ==================================================================
 * E · 板面成对，重新分类两对
 * ================================================================== */
line('');
line(rule());
line(' E · 板面成对：Hero A♦Q♦ ｜ 板 A♠ K♥ Q♠ 4♦ / K♦（河牌 K 让板面成对）');
line(rule());
show('E1 河牌 K♦（Hero 两对 A+K，Q 踢脚；板面自为 A K Q K 4）', {
  tag: 'E1', heroCards: ['Ad', 'Qd'], board: ['As', 'Kh', 'Qs', '4d', 'Kd'], street: 'RIVER',
  history: [...PF_BTN_RAISE_BB_CALL, ...FLOP(4, 4), ...TURN_CB(10), A_('BB', 'BET', 20, 'RIVER')],
  villain: villainOf('CALLING_STATION'),
});
show('E2 对照：河牌 2♦（板面未成对，Hero 两对 A-Q）', {
  tag: 'E2', heroCards: ['Ad', 'Qd'], board: ['As', 'Kh', 'Qs', '4d', '2d'], street: 'RIVER',
  history: [...PF_BTN_RAISE_BB_CALL, ...FLOP(4, 4), ...TURN_CB(10), A_('BB', 'BET', 20, 'RIVER')],
  villain: villainOf('CALLING_STATION'),
});

/* ==================================================================
 * F · 阻断牌：Hero 持 / 不持 A♠（三张♠ 河牌）
 * ================================================================== */
line('');
line(rule());
line(' F · 三张♠ 河牌：Hero A♥J♦（不挡同花，A 高）vs Hero J♠T♥（持♠ 挡同花，K 高）');
line(rule());
show('F1 Hero A♥J♦（高牌 A）', {
  tag: 'F1', heroCards: ['Ah', 'Jd'], board: ['Ks', 'Qs', '7s', '2d', '3h'], street: 'RIVER',
  history: [...PF_BTN_RAISE_BB_CALL, ...FLOP(4, 4), ...TURN_CB(10), A_('BB', 'BET', 20, 'RIVER')],
  villain: villainOf('CALLING_STATION'),
});
show('F2 Hero J♠T♥（持♠，高牌 K）', {
  tag: 'F2', heroCards: ['Js', 'Th'], board: ['Ks', 'Qs', '7s', '2d', '3h'], street: 'RIVER',
  history: [...PF_BTN_RAISE_BB_CALL, ...FLOP(4, 4), ...TURN_CB(10), A_('BB', 'BET', 20, 'RIVER')],
  villain: villainOf('CALLING_STATION'),
});

/* ==================================================================
 * G · 死牌剔除：Hero A♠A♥ vs 8♠8♥，其余逐字相同
 * ================================================================== */
line('');
line(rule());
line(' G · 死牌 / 重复组合：Hero A♠A♥ vs Hero 8♠8♥（板 K♦7♣2♥、历史、对手全部相同）');
line(rule());
show('G1 Hero A♠A♥（范围必须不含任何 A）', {
  tag: 'G1', heroCards: ['As', 'Ah'], board: ['Kd', '7c', '2h'], street: 'FLOP',
  history: [...PF_BTN_RAISE_BB_CALL, A_('BB', 'BET', 4, 'FLOP')],
  villain: villainOf('CALLING_STATION'),
});
show('G2 Hero 8♠8♥（基线）', {
  tag: 'G2', heroCards: ['8s', '8h'], board: ['Kd', '7c', '2h'], street: 'FLOP',
  history: [...PF_BTN_RAISE_BB_CALL, A_('BB', 'BET', 4, 'FLOP')],
  villain: villainOf('CALLING_STATION'),
});
line(rule());
