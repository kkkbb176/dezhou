/**
 * flopriver-agent1-response.ts —— 河牌「幽灵听牌」是否影响对手响应模型
 *
 * 受控对照：两个节点的公共牌**点数完全相同**、只换花色；Hero 底牌同点数同花色。
 *   P1 板 K♠ Q♠ 7♠ 2♦ 3♥（三张♠ ⇒ 大量组合 `drawProfileOf.flushDraw = true`）
 *   P2 板 K♥ Q♥ 7♥ 2♦ 3♠（无三张同花 ⇒ 不存在同花听）
 * 若河牌上「听牌」被正确停用，P1 与 P2 的响应概率应只差在花色造成的范围差异上；
 * 若未停用，P1 的 `villainDraw = STRONG_DRAW` 会给「可玩性 +0.10」，抬高他的继续/加注倾向。
 *
 * 复现：node --experimental-strip-types scripts/flopriver-agent1-response.ts
 */
import {
  detailOf, prodContextOf, A_, PF_BTN_RAISE_BB_CALL, villainOf, line, kv, rule, n, pct, type Node,
} from './flopriver-agent1-harness.ts';

const FLOP = (bet: number, call: number) => [
  A_('BB', 'CHECK', undefined, 'FLOP'), A_('BTN', 'BET', bet, 'FLOP'), A_('BB', 'CALL', call, 'FLOP'),
];
const TURN_CB = (bet: number) => [A_('BB', 'BET', bet, 'TURN'), A_('BTN', 'CALL', bet, 'TURN')];
/** 无人下注的河牌节点：Hero 是下注方，betDecision 才有值 */
const HIST_RIVER_CHECK = [...PF_BTN_RAISE_BB_CALL, ...FLOP(4, 4), ...TURN_CB(10), A_('BB', 'CHECK', undefined, 'RIVER')];

const NODES: readonly Node[] = [
  { tag: 'P1 板 K♠Q♠7♠2♦3♥（三张♠）', heroCards: ['Jh', 'Td'], board: ['Ks', 'Qs', '7s', '2d', '3h'], street: 'RIVER', history: HIST_RIVER_CHECK, villain: villainOf('CALLING_STATION') },
  { tag: 'P2 板 K♥Q♥7♥2♦3♠（无三张同花）', heroCards: ['Jh', 'Td'], board: ['Kh', 'Qh', '7h', '2d', '3s'], street: 'RIVER', history: HIST_RIVER_CHECK, villain: villainOf('CALLING_STATION') },
];

line(rule());
line(' 河牌响应模型对照：三张♠ 的板 vs 点数相同但不构成同花听的板');
line(rule());
line(`   ${'节点'.padEnd(34)}| 尺寸        | foldLike  | callLike  | raiseLike | betEV     | CHECK EV`);
for (const node of NODES) {
  const D = detailOf(node);
  const C = prodContextOf(D.built);
  const bd = D.pf['betDecision'] as Record<string, any> | null;
  line('');
  line(`── ${node.tag} ──`);
  const hs = C.postflopFacts?.['handStructure'] ?? null;
  kv('  Hero / 结构', `${node.heroCards.join('')} ｜ ${String(hs?.['structureLabel'])} ｜ 整体权益 ${pct(D.math['heroEquity'], 4)}`);
  kv('  对手范围支持集', `${String(C.snap?.['supportSize'])} ｜ drawShare ${pct(C.facts?.['drawShare'], 3)} ｜ suitFit ${pct(C.facts?.['suitFit'], 3)}`);
  if (bd === null) { kv('  betDecision', 'null'); continue; }
  kv('  CHECK EV / 实现因子', `${n(bd['checkEV'], 4)} ｜ ${n(bd['checkRealizationFactor'], 4)}`);
  for (const s of (bd['sizes'] ?? []) as readonly Record<string, any>[]) {
    line(
      `   ${''.padEnd(34)}| ${String(s['size']).padEnd(11)} | ${n(s['foldLikelihood'], 6)} | ${n(s['callLikelihood'], 6)} | ${n(s['raiseLikelihood'], 6)} |` +
      ` ${n(s['betEV'], 4).padStart(9)} | ${n(s['deltaVsCheck'], 4)}`,
    );
  }
  kv('  最终动作', String(D.decision['action']) + (D.decision['sizeChips'] === undefined ? '' : ` ${String(D.decision['sizeChips'])}`));
}
line('');
line(rule());
line(' 参考：`drawProfileOf`（draws.ts:160-223）在河牌仍按「四张同花 ⇒ 同花听」判定，');
line('       而 `classifyResponse`（betResponse.ts:782）用它给可玩性加 0.10，未按 cardsToCome 停用。');
line(rule());
