/**
 * flopriver-agent1-pairs.ts —— H2：干净牌面上的「对子层级 / 踢脚」对照
 *   板 K♦ 8♣ 3♥ 2♠ 7♦（无同花可能、无顺子可能、无两对）
 *   同一节点只换 Hero 底牌 ⇒ 直接比较「顶对强踢脚 / 顶对弱踢脚 / 中对 / 底对 / 超对 / 小对子」
 *   附加 H3：板面第 7 张成对（板 K♦ 8♣ 3♥ 2♠ K♠）时顶对的重新分类
 *
 * 复现：node --experimental-strip-types scripts/flopriver-agent1-pairs.ts
 */
import {
  detailOf, prodContextOf, A_, PF_BTN_RAISE_BB_CALL, villainOf, line, kv, rule, n, pct, type Node,
} from './flopriver-agent1-harness.ts';

const FLOP = (bet: number, call: number) => [
  A_('BB', 'CHECK', undefined, 'FLOP'), A_('BTN', 'BET', bet, 'FLOP'), A_('BB', 'CALL', call, 'FLOP'),
];
const TURN_CB = (bet: number) => [A_('BB', 'BET', bet, 'TURN'), A_('BTN', 'CALL', bet, 'TURN')];
const HIST = [...PF_BTN_RAISE_BB_CALL, ...FLOP(4, 4), ...TURN_CB(10), A_('BB', 'BET', 20, 'RIVER')];
const V = villainOf('CALLING_STATION');

const zhOf = (codes: readonly string[]): string =>
  codes.map((c) => {
    const rk = c[0]!; const suit = c[1]!.toLowerCase();
    const st = ({ s: '♠', h: '♥', d: '♦', c: '♣' } as Record<string, string>)[suit] ?? suit;
    return `${rk}${st}`;
  }).join('');

const CASES: readonly (readonly [string, readonly string[]])[] = [
  ['顶对 K + 强踢脚 Q', ['Ks', 'Qh']],
  ['顶对 K + 弱踢脚 5', ['Ks', '5h']],
  ['顶对 K + 弱踢脚 4（K♥4♥）', ['Kh', '4h']],
  ['中对 8（8♥6♥，牌面第二大）', ['8h', '6h']],
  ['底对 3（3♠4♠）', ['3s', '4s']],
  ['超对 A（A♠A♥）', ['As', 'Ah']],
  ['比你小的口袋对 6（6♠6♥）', ['6s', '6h']],
  ['高牌 A（A♠J♥）', ['As', 'Jh']],
];

function dump(board: readonly string[], cases: typeof CASES, title: string): void {
  line(rule());
  line(` ${title}`);
  line(rule());
  line(`   ${'Hero'.padEnd(30)}| ${'handRankZh'.padEnd(22)}| ${'made'.padEnd(10)}| ${'role'.padEnd(14)}| 强度  | 权益(整体) | 权益(下注) | 更差/相同/更好            | CALL EV  | 动作`);
  for (const [tag, hero] of cases) {
    const node: Node = { tag, heroCards: hero, board, street: 'RIVER', history: HIST, villain: V };
    const D = detailOf(node);
    const C = prodContextOf(D.built);
    const f = C.facts;
    line(
      `   ${`${zhOf(hero)} ${tag}`.padEnd(30)}| ${String(D.math['handRankZh']).padEnd(22)}| ${String(D.pf['madeHand']).padEnd(10)}|` +
      ` ${String(D.pf['handRoleZh']).padEnd(14)}| ${n(D.pf['roleStrength'], 3).padStart(5)} | ${pct(D.math['heroEquity'], 3).padStart(10)} |` +
      ` ${pct(D.math['heroEquityVsBetRange'], 3).padStart(10)} | ${pct(f?.['weakerShare'], 2)}/${pct(f?.['equalShare'], 2)}/${pct(f?.['strongerShare'], 2)} |` +
      ` ${n(D.math['callEV'], 3).padStart(8)} | ${String(D.decision['action'])}${D.decision['sizeChips'] === undefined ? '' : ` ${String(D.decision['sizeChips'])}`}`,
    );
  }
}

dump(['Kd', '8c', '3h', '2s', '7d'], CASES, 'H2 · 板 K♦ 8♣ 3♥ 2♠ 7♦（无同花/无顺子/未成对，BB 河牌下注 20BB）');

line('');
dump(
  ['Kd', '8c', '3h', '2s', 'Ks'],
  [
    ['板面成对 + 我的 K（明三条 K，K♣Q♥）', ['Kc', 'Qh']],
    ['板面成对 + 我 88（两对 K+8）', ['8h', '8d']],
    ['板面成对 + 我 AA（两对 A+K）', ['As', 'Ah']],
    ['板面成对 + 我 33（两对 K+3）', ['3s', '3d']],
    ['板面成对 + 我 22（两对 K+2）', ['2h', '2d']],
  ],
  'H3 · 板 K♦ 8♣ 3♥ 2♠ K♠（板面成对）—— 三条/两对的重分类（同一节点，BB 河牌下注 20BB）',
);
line(rule());
