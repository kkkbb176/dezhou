/**
 * Agent 9 · 探针 3：身份路由 / 再加注合法性 / 披露措辞 / 纹理标签（只读）
 * 覆盖 M5 M7 M9 M12 M19
 */
import {
  A_, BASE, MANIAC, detailOf, guard, line, kv, rule, n, pct, J, type Rec,
} from './flopriver-agent4-lib.ts';
import type { ManualHandInput, ManualVillain } from '../src/app/manualInput/manualInput.ts';
import { boardTextureLabelOf } from '../src/domain/postflop/riverProfileClassify.ts';
import { parseCardStrict } from '../src/domain/poker/cards.ts';

const H = (over: Record<string, unknown>): ManualHandInput => ({ ...BASE, ...over } as unknown as ManualHandInput);
const section = (t: string): void => { line(''); line(rule()); line(` ${t}`); line(rule()); };

const statsOf = (hands: number, foldTurn: number | null) => ({
  handsObserved: hands, vpip: 0.35, pfr: 0.25, threeBet: 0.1, wtsd: 0.3,
  foldToFlopCBet: 0.5, foldToTurnCBet: foldTurn, foldToRiverBet: 0.5,
  flopCheckRaise: null, turnCheckRaise: null, riverCheckRaise: null,
}) as ManualVillain['observedStats'];

/* ============================================================
 * §1 M5：实测统计存在时，玩家层披露措辞是否仍说「无实测数据」
 * ============================================================ */
section('§1 M5 · 玩家层披露（dg.player.note / label / handsObserved）与实际使用的统计');
const PRE = [A_('UTG', 'FOLD'), A_('HJ', 'FOLD'), A_('CO', 'FOLD'), A_('BTN', 'RAISE', 3), A_('SB', 'FOLD'), A_('BB', 'CALL', 2)];
const TURN_BET_NODE = [...PRE, A_('BB', 'CHECK', undefined, 'FLOP'), A_('BTN', 'BET', 4, 'FLOP'), A_('BB', 'CALL', 4, 'FLOP'), A_('BB', 'CHECK', undefined, 'TURN')];
for (const [tag, villain] of [
  ['无 observedStats（只有标签 MANIAC）', { seatId: 'seat_BB', persistentPlayerId: 'player_001', quickProfile: 'MANIAC', dynamicHint: 'UNKNOWN', stackBB: 100 } as ManualVillain],
  ['observedStats 800 手 foldToTurnCBet=0.75', { seatId: 'seat_BB', persistentPlayerId: 'player_001', quickProfile: 'MANIAC', dynamicHint: 'UNKNOWN', stackBB: 100, observedStats: statsOf(800, 0.75) } as ManualVillain],
  ['observedStats 800 手（无标签，quickProfile 未给）', { seatId: 'seat_BB', persistentPlayerId: 'player_001', dynamicHint: 'UNKNOWN', stackBB: 100, observedStats: statsOf(800, 0.75) } as ManualVillain],
] as ReadonlyArray<readonly [string, ManualVillain]>) {
  const d = guard(H({ heroCards: ['Ac', 'Jc'], board: ['Jd', '8c', '4c', '6s'], street: 'TURN', actionHistory: TURN_BET_NODE, villain }), tag);
  if (!d.r.ok) continue;
  const pl = (d.dg['player'] ?? {}) as Rec;
  const bd = (d.pf['betDecision'] ?? null) as Rec | null;
  const s0 = bd === null ? null : (bd['sizes'] as Rec[])[0] ?? null;
  kv(tag, '');
  kv('    dg.player.label / confidence / handsObserved', `${String(pl['label'])} ｜ ${n(pl['confidence'], 4)} ｜ ${String(pl['handsObserved'])}`);
  kv('    dg.player.note（用户可见）', J(pl['note'], 300));
  kv('    betDecision.tendenciesZh', J(bd?.['tendenciesZh'], 300));
  kv('    sizes[0].foldLikelihood', n(s0?.['foldLikelihood'], 6));
  kv('    profileRange.dimensionNoteZh', J(((d.dg['profileRange'] ?? {}) as Rec)['dimensionNoteZh'], 300));
  kv('    profileRange.dimensionTier', String(((d.dg['profileRange'] ?? {}) as Rec)['dimensionTier']));
}

/* ============================================================
 * §2 M7：身份路由（同一手、只改 villain 身份字段）
 * ============================================================ */
section('§2 M7 · 两家进池时的身份路由（UTG 开池、HJ 跟注、Hero BTN 待行动）');
const PRE_2LIVE = [A_('UTG', 'RAISE', 3), A_('HJ', 'CALL', 3), A_('CO', 'FOLD')];
const ROUTES: ReadonlyArray<readonly [string, ManualVillain]> = [
  ['seatId=seat_UTG（开池者）', { seatId: 'seat_UTG', quickProfile: 'MANIAC', dynamicHint: 'UNKNOWN', stackBB: 100 } as ManualVillain],
  ['seatId=seat_HJ（跟注者）', { seatId: 'seat_HJ', quickProfile: 'MANIAC', dynamicHint: 'UNKNOWN', stackBB: 100 } as ManualVillain],
  ['seatId=seat_XX（不存在的座位）', { seatId: 'seat_XX', quickProfile: 'MANIAC', dynamicHint: 'UNKNOWN', stackBB: 100 } as ManualVillain],
  ['无 seatId（应绑到「首要对手」）', { quickProfile: 'MANIAC', dynamicHint: 'UNKNOWN', stackBB: 100 } as ManualVillain],
  ['persistentPlayerId 无关 id（应拒绝注入）', { persistentPlayerId: 'player_zzz', quickProfile: 'MANIAC', dynamicHint: 'UNKNOWN', stackBB: 100 } as ManualVillain],
  ['无任何身份 / 无画像', { dynamicHint: 'UNKNOWN', stackBB: 100 } as ManualVillain],
];
for (const [tag, villain] of ROUTES) {
  const d = guard(H({ heroCards: ['Ac', 'Jc'], board: [], street: 'PREFLOP', actionHistory: PRE_2LIVE, villain }), tag);
  if (!d.r.ok) continue;
  const ident = (d.built['playerIdentity'] ?? {}) as Rec;
  const pl = (d.dg['player'] ?? {}) as Rec;
  kv(`  ${tag}`, '');
  kv('    playerIdentity.status / seatId', `${String(ident['status'])} ｜ ${String(ident['seatId'])}`);
  kv('    playerIdentity.disclosureZh', J(ident['disclosureZh'], 300));
  kv('    是否出现在 warnings', String((d.r.warnings as readonly string[]).some((w) => w.includes('🧭'))));
  kv('    dg.player.playerId / label / note', `${String(pl['playerId'])} ｜ ${String(pl['label'])} ｜ ${J(pl['note'], 140)}`);
  kv('    dg.profileRange.provider.applied / mean', `${String(((d.dg['profileRange'] ?? {}) as Rec)['provider']?.['applied'])} ｜ ${n(((d.dg['profileRange'] ?? {}) as Rec)['provider']?.['profileMultiplier']?.['mean'], 6)}`);
  kv('    decision.action', `${String(d.decision['action'])} ${String(d.decision['sizeChips'] ?? '')}`);
}

/* ============================================================
 * §3 M9：再加注分支的规则可达性（短筹码 ⇒ 只能不足最小加注额的全下）
 * ============================================================ */
section('§3 M9 · 再加注分支：reRaiseTo / 最小合法再加注 / 是否全下 / 引擎是否接受');
const preflopShort = [A_('UTG', 'FOLD'), A_('HJ', 'FOLD'), A_('CO', 'FOLD'), A_('BTN', 'RAISE', 3), A_('SB', 'FOLD'), A_('BB', 'CALL', 2)];
for (const [tag, stackBB, remAfterRaise] of [
  ['标准 100BB（BB 全额深）', 100, null],
  ['BB 只有 25BB', 25, null],
  ['BB 只有 16BB', 16, null],
  ['BB 只有 13BB', 13, null],
] as ReadonlyArray<readonly [string, number, number | null]>) {
  const seatStacks = { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: stackBB };
  /** 他的加注额按筹码缩放（否则被引擎以 BET_EXCEEDS_STACK 拒绝，那是输入错误不是缺陷） */
  const villainRaiseTo = Math.min(40, Math.max(4, Math.round(stackBB * 0.6)));
  const input = H({
    seatStacksBB: seatStacks, effectiveStackBB: stackBB,
    heroCards: ['Ac', 'Jc'], board: ['Jd', '8c', '4c', '6s'], street: 'TURN',
    actionHistory: [
      ...preflopShort,
      A_('BB', 'CHECK', undefined, 'FLOP'), A_('BTN', 'BET', 4, 'FLOP'), A_('BB', 'CALL', 4, 'FLOP'),
      A_('BB', 'CHECK', undefined, 'TURN'), A_('BTN', 'BET', 10, 'TURN'), A_('BB', 'RAISE', villainRaiseTo, 'TURN'),
    ],
    villain: { seatId: 'seat_BB', quickProfile: 'MANIAC', dynamicHint: 'UNKNOWN', stackBB } as ManualVillain,
  });
  const d = guard(input, tag);
  if (!d.r.ok) continue;
  const rr = (d.pf['raiseResponse'] ?? null) as Rec | null;
  kv(tag, '');
  kv('    action', `${String(d.decision['action'])} ${String(d.decision['sizeChips'] ?? '')}`);
  kv('    reRaiseLikelihood / reRaiseCombos', `${n(rr?.['reRaiseLikelihood'], 6)} ｜ ${String(rr?.['reRaiseCombos'])}`);
  kv('    reRaiseTo / reRaiseMinLegalTo / villainReRaiseIsAllIn', `${String(rr?.['reRaiseTo'])} ｜ ${String(rr?.['reRaiseMinLegalTo'])} ｜ ${String(rr?.['villainReRaiseIsAllIn'])}`);
  kv('    villainIsAllInByCall / heroIsAllIn', `${String(rr?.['villainIsAllInByCall'])} ｜ ${String(rr?.['model']?.['heroIsAllIn'])}`);
  kv('    heroFourBetSupported / heroAdditionalCallVsReRaise', `${String(rr?.['heroFourBetSupported'])} ｜ ${String(rr?.['heroAdditionalCallVsReRaise'])}`);
  kv('    reraiseBranchKind / reraiseBranchEV', `${String(rr?.['reraiseBranchKind'])} ｜ ${n(rr?.['reraiseBranchEV'], 4)}`);
  kv('    raiseEV / sizeChips', `${n(rr?.['raiseEV'], 4)} ｜ ${String(rr?.['sizeChips'])}`);
  kv('    model.noteZh 尾段', J(String(rr?.['model']?.['noteZh'] ?? '').slice(-260), 300));
}
/* 规则不可能性自证：把「他的再加注若不是全下」与 heroFourBetSupported 对照 */
section('§3b M9/M19 · heroFourBetSupported 与 assumptionsZh 的自述是否一致');
for (const [tag, stackBB] of [['BB=100BB', 100], ['BB=25BB', 25], ['BB=16BB', 16]] as ReadonlyArray<readonly [string, number]>) {
  const rTo = Math.min(40, Math.max(4, Math.round(stackBB * 0.6)));
  const d = guard(H({
    seatStacksBB: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: stackBB }, effectiveStackBB: stackBB,
    heroCards: ['Ac', 'Jc'], board: ['Jd', '8c', '4c', '6s'], street: 'TURN',
    actionHistory: [...preflopShort, A_('BB', 'CHECK', undefined, 'FLOP'), A_('BTN', 'BET', 4, 'FLOP'), A_('BB', 'CALL', 4, 'FLOP'), A_('BB', 'CHECK', undefined, 'TURN'), A_('BTN', 'BET', 10, 'TURN'), A_('BB', 'RAISE', rTo, 'TURN')],
    villain: { seatId: 'seat_BB', quickProfile: 'MANIAC', dynamicHint: 'UNKNOWN', stackBB } as ManualVillain,
  }), tag);
  if (!d.r.ok) continue;
  const rr = (d.pf['raiseResponse'] ?? null) as Rec | null;
  const assumptions = (rr?.['assumptionsZh'] as readonly string[] | undefined) ?? [];
  const hit = assumptions.filter((x) => x.includes('heroFourBetSupported'));
  kv(tag, `heroFourBetSupported=${String(rr?.['heroFourBetSupported'])}｜自述「恒为 false」的条目=${hit.length}｜${J(hit, 260)}`);
}

/* ============================================================
 * §4 M19：牌面纹理标签 vs 结构事实
 * ============================================================ */
section('§4 M19 · boardTextureLabelOf 的输出 vs 牌面结构事实（用户可见措辞是否矛盾）');
for (const [tag, board] of [
  ['Jd 8c 4c（两张同花 + 无连张）', ['Jd', '8c', '4c']],
  ['Ah Kh Qh（三张同花）', ['Ah', 'Kh', 'Qh']],
  ['9h 9d 9c（三条面 + 三张…实为对子+三张）', ['9h', '9d', '9c']],
  ['9h 9d 2c 2d（两对牌面）', ['9h', '9d', '2c', '2d']],
  ['9s Ts Jd Qc（四连张）', ['9s', 'Ts', 'Jd', 'Qc']],
  ['9s Ts Jd Qc Kd（已成顺牌面）', ['9s', 'Ts', 'Jd', 'Qc', 'Kd']],
  ['As Ks Qs Js Ts（同花顺牌面）', ['As', 'Ks', 'Qs', 'Js', 'Ts']],
  ['2c 7d 9h（彩虹干燥）', ['2c', '7d', '9h']],
] as ReadonlyArray<readonly [string, readonly string[]]>) {
  const cards = board.map((c) => parseCardStrict(c));
  const label = boardTextureLabelOf(cards as never);
  kv(`  ${tag}`, `→ ${String(label)}`);
}
