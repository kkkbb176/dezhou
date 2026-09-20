/**
 * flopriver-agent1-A.ts —— 用例 A：顶对 + 坚果同花听（Hero A♣J♣，板 J♦8♣4♣，转牌/河牌）
 *
 * 复现：node --experimental-strip-types scripts/flopriver-agent1-A.ts
 */
import {
  detailOf, prodContextOf, A_, PF_BTN_RAISE_BB_CALL, villainOf, line, kv, rule, n, pct,
  tierHistogramZh, type Node,
} from './flopriver-agent1-harness.ts';

const PRE_FLOP_FLOP = [
  ...PF_BTN_RAISE_BB_CALL,
  A_('BB', 'CHECK', undefined, 'FLOP'),
  A_('BTN', 'BET', 4, 'FLOP'),
  A_('BB', 'CALL', 4, 'FLOP'),
];

const NODES: readonly Node[] = [
  {
    tag: 'A1 转牌面对 BB 下注（顶对 + 坚果同花听）', heroCards: ['Ac', 'Jc'], board: ['Jd', '8c', '4c', '6s'], street: 'TURN',
    history: [...PRE_FLOP_FLOP, A_('BB', 'BET', 10, 'TURN')], villain: villainOf('CALLING_STATION'),
  },
  {
    tag: 'A2 河牌（同牌力，同花未完成，BB 过牌到 Hero）', heroCards: ['Ac', 'Jc'], board: ['Jd', '8c', '4c', '6s', '2h'], street: 'RIVER',
    history: [...PRE_FLOP_FLOP, A_('BB', 'BET', 10, 'TURN'), A_('BTN', 'CALL', 10, 'TURN'), A_('BB', 'CHECK', undefined, 'RIVER')],
    villain: villainOf('CALLING_STATION'),
  },
];

line(rule());
line(' 用例 A · Hero A♣J♣ ｜ 6-max 1/2 ｜ BTN vs BB ｜ 顶对 J + 坚果同花听');
line(rule());

for (const node of NODES) {
  const D = detailOf(node);
  const C = prodContextOf(D.built);
  line('');
  line(`── ${node.tag} ──`);
  kv('板 / 街 / 对手', `${node.board.join(' ')} ｜ ${node.street} ｜ CALLING_STATION`);
  kv('① handRankZh', String(D.math['handRankZh']));
  kv('② handCategory', String(D.math['handCategory']));
  kv('③ madeHand / madeHandZh', `${String(D.pf['madeHand'])} ｜ ${String(D.pf['madeHandZh'])}`);
  kv('④ handRole / handRoleZh / roleStrength', `${String(D.pf['handRole'])} ｜ ${String(D.pf['handRoleZh'])} ｜ ${n(D.pf['roleStrength'], 4)}`);
  kv('⑤ showdown / protection / bluffPotential', `${n(D.pf['showdownValue'], 4)} ｜ ${n(D.pf['protectionValue'], 4)} ｜ ${n(D.pf['bluffPotential'], 4)}`);
  kv('⑥ handStructure（成手+听牌）', JSON.stringify(C.postflopFacts?.['handStructure'] ?? null));
  kv('⑦ heroEquity 整体 / VsBetRange', `${pct(D.math['heroEquity'], 6)} ｜ ${pct(D.math['heroEquityVsBetRange'], 6)}`);
  kv('⑧ requiredEquity / callEV', `${pct(D.math['requiredEquity'], 4)} ｜ ${n(D.math['callEV'], 8)}`);
  kv('⑨ conditionalEquities', JSON.stringify(D.dg['conditionalEquities'] ?? null).slice(0, 320));
  kv('⑩ candidates', JSON.stringify((D.dg['candidates'] ?? []).map((c: any) => ({ a: c['action'], s: c['sizeChips'], ev: c['ev'] }))));
  kv('⑪ 最终动作', `${String(D.decision['action'])}${D.decision['sizeChips'] === undefined ? '' : ` ${String(D.decision['sizeChips'])}`} ｜ conf ${n(D.decision['confidence'], 4)} ｜ ${String(D.decision['classification'])}`);
  kv('⑫ 对手范围快照', C.snap === null ? 'null' : `${String(C.snap['sourceKind'])} ｜ conf ${n(C.snap['confidence'], 3)} ｜ support ${String(C.snap['supportSize'])} ｜ share ${n(C.snap['supportShare'], 4)} ｜ collapsed ${String(C.snap['collapsed'])}`);
  kv('⑬ 到达范围事实 opponentRangeFacts', C.facts === null ? 'null' : `support ${String(C.facts['supportSize'])} ｜ weaker ${pct(C.facts['weakerShare'], 3)} ｜ equal ${pct(C.facts['equalShare'], 3)} ｜ stronger ${pct(C.facts['strongerShare'], 3)} ｜ strongShare ${pct(C.facts['strongShare'], 3)} ｜ meanTier ${n(C.facts['meanTier'], 4)} ｜ suitFit ${pct(C.facts['suitFit'], 3)} ｜ drawShare ${pct(C.facts['drawShare'], 3)}`);
  kv('⑭ tierHistogram', tierHistogramZh(C.facts?.['tierHistogram']));
  kv('⑮ blockers 诊断', JSON.stringify(D.pf['blockers'] ?? null));
  line('reasons:');
  for (const rs of (D.decision['reasons'] ?? []) as readonly Record<string, any>[]) {
    line(`   · [${String(rs['code'])}] ${String(rs['textZh']).slice(0, 170)}`);
  }
}
line(rule());
