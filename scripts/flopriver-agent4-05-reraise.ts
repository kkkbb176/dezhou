/** Agent 9 · 探针 5：heroFourBetSupported 自述矛盾（单节点内自证）+ 河牌范围类别的错失听牌子类 */
import { A_, BASE, MANIAC, guard, line, kv, rule, n, J, type Rec } from './flopriver-agent4-lib.ts';
import type { ManualHandInput, ManualVillain } from '../src/app/manualInput/manualInput.ts';
const H = (over: Record<string, unknown>): ManualHandInput => ({ ...BASE, ...over } as unknown as ManualHandInput);
const section = (t: string): void => { line(''); line(rule()); line(` ${t}`); line(rule()); };
const PRE = [A_('UTG', 'FOLD'), A_('HJ', 'FOLD'), A_('CO', 'FOLD'), A_('BTN', 'RAISE', 3), A_('SB', 'FOLD'), A_('BB', 'CALL', 2)];
const deep = 300;

section('§1 · 同一份事实包内：heroFourBetSupported 的值 vs assumptionsZh 的自述');
for (const villainBB of [300, 60]) {
  const d = guard(H({
    seatStacksBB: { UTG: deep, HJ: deep, CO: deep, BTN: deep, SB: deep, BB: villainBB }, effectiveStackBB: deep,
    heroCards: ['Ac', 'Jc'], board: ['Jd', '8c', '4c', '6s'], street: 'TURN',
    actionHistory: [...PRE, A_('BB', 'CHECK', undefined, 'FLOP'), A_('BTN', 'BET', 4, 'FLOP'), A_('BB', 'CALL', 4, 'FLOP'), A_('BB', 'BET', 10, 'TURN')],
    villain: { seatId: 'seat_BB', quickProfile: 'MANIAC', dynamicHint: 'UNKNOWN', stackBB: villainBB } as ManualVillain,
  }), `villain ${villainBB}BB`);
  if (!d.r.ok) continue;
  const rr = (d.pf['raiseResponse'] ?? null) as Rec | null;
  const assum = (rr?.['assumptionsZh'] as readonly string[] | undefined) ?? [];
  kv(`  villain ${villainBB}BB`, '');
  kv('    villainReRaiseIsAllIn / heroFourBetSupported', `${String(rr?.['villainReRaiseIsAllIn'])} ｜ ${String(rr?.['heroFourBetSupported'])}`);
  kv('    reRaiseTo / minLegal', `${String(rr?.['reRaiseTo'])} ｜ ${String(rr?.['reRaiseMinLegalTo'])}`);
  kv('    reraiseBranchKind / reraiseBranchEV', `${String(rr?.['reraiseBranchKind'])} ｜ ${n(rr?.['reraiseBranchEV'], 4)}`);
  kv('    assumptionsZh 中含 heroFourBetSupported 的条目', J(assum.filter((x) => x.includes('heroFourBetSupported')), 320));
}

section('§3 · 同一翻牌节点（BB 领打 6BB，MANIAC）逐牌力：EqVsBet / EqWhole / 动作 / CALL EV');
for (const [tag, cards] of [
  ['三条 JhJc', ['Jh', 'Jc']],
  ['听花 AcJc（顶对+听花）', ['Ac', 'Jc']],
  ['中对 8h8d', ['8h', '8d']],
  ['底对 4d5d', ['4d', '5d']],
  ['空气 AsKs', ['As', 'Ks']],
  ['空气 2h3d', ['2h', '3d']],
] as ReadonlyArray<readonly [string, readonly string[]]>) {
  const d = guard(H({
    heroCards: cards, board: ['Jd', '8c', '4c'], street: 'FLOP',
    actionHistory: [...PRE, A_('BB', 'BET', 6, 'FLOP')], villain: MANIAC,
  }), tag);
  if (!d.r.ok) continue;
  const br = (d.pf['bettingRangeFacts'] ?? null) as Rec | null;
  kv(`  ${tag}`, `EqVsBet=${pct(d.math['heroEquityVsBetRange'], 3)}｜EqWhole=${pct(d.math['heroEquity'], 3)}｜callEV=${n(d.math['callEV'], 3)}｜${String(d.decision['action'])} ${String(d.decision['sizeChips'] ?? '')}｜betMass=${n(br?.['betMass'], 4)}`);
}

for (const [tag, cards, board] of [
  ['Hero AA（顶三条）', ['As', 'Ah'], ['Ad', '9c', '4h', '6s', '2d']],
  ['Hero AcJc（对 J）', ['Ac', 'Jc'], ['Jd', '8c', '4c', '6s', '2h']],
] as ReadonlyArray<readonly [string, readonly string[], readonly string[]]>) {
  const d = guard(H({
    heroCards: cards, board, street: 'RIVER',
    actionHistory: [...PRE, A_('BB', 'CHECK', undefined, 'FLOP'), A_('BTN', 'BET', 4, 'FLOP'), A_('BB', 'CALL', 4, 'FLOP'), A_('BB', 'CHECK', undefined, 'TURN'), A_('BTN', 'BET', 10, 'TURN'), A_('BB', 'CALL', 10, 'TURN'), A_('BB', 'BET', 20, 'RIVER')],
    villain: MANIAC,
  }), tag);
  if (!d.r.ok) continue;
  const cm = (((d.pf['bettingRangeFacts'] ?? {}) as Rec)['classMasses'] ?? {}) as Rec;
  const missedSum = (cm['missedFlushMass'] ?? 0) + (cm['missedStraightMass'] ?? 0) + (cm['missedComboMass'] ?? 0);
  kv(`  ${tag}`, `missedFlush=${n(cm['missedFlushMass'], 5)} missedStraight=${n(cm['missedStraightMass'], 5)} missedCombo=${n(cm['missedComboMass'], 5)} pureAir=${n(cm['pureAirMass'], 5)} ⇒ 合计 ${n(missedSum, 5)} / bluffMass ${n(cm['bluffMass'], 5)}｜错失+空气==bluff: ${String(Math.abs(missedSum + (cm['pureAirMass'] ?? 0) - (cm['bluffMass'] ?? 0)) < 1e-9)}`);
}
