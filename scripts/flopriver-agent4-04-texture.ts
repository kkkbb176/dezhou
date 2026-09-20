/**
 * Agent 9 · 探针 4：牌面成对结构 / 再加注分支规则性 / 河牌尺寸敏感（只读）
 * 覆盖 M19 M9 M3
 */
import {
  A_, BASE, MANIAC, detailOf, guard, line, kv, rule, n, pct, J, type Rec,
} from './flopriver-agent4-lib.ts';
import type { ManualHandInput, ManualVillain } from '../src/app/manualInput/manualInput.ts';
import { boardTextureLabelOf } from '../src/domain/postflop/riverProfileClassify.ts';
import { boardTextureOf } from '../src/domain/postflop/boardDelta.ts';
import { parseCardStrict } from '../src/domain/poker/cards.ts';

const H = (over: Record<string, unknown>): ManualHandInput => ({ ...BASE, ...over } as unknown as ManualHandInput);
const section = (t: string): void => { line(''); line(rule()); line(` ${t}`); line(rule()); };
const PRE = [A_('UTG', 'FOLD'), A_('HJ', 'FOLD'), A_('CO', 'FOLD'), A_('BTN', 'RAISE', 3), A_('SB', 'FOLD'), A_('BB', 'CALL', 2)];

/* ============================================================
 * §1 M19：牌面成对结构事实（boardTextureOf 的 pairedBoard 是否可达）
 * ============================================================ */
section('§1 M19 · boardTextureOf 的 pairedBoard / tripsOnBoard 在所有牌面上的取值');
for (const [tag, board] of [
  ['翻牌 Jd 8c 4c（无对）', ['Jd', '8c', '4c']],
  ['转牌 Jd 8c 4c Js（**成对**）', ['Jd', '8c', '4c', 'Js']],
  ['河牌 Jd 8c 4c Js Jh（**三条面**）', ['Jd', '8c', '4c', 'Js', 'Jh']],
  ['翻牌 9h 9d 9c（**三条面**）', ['9h', '9d', '9c']],
  ['转牌 9h 9d 2c 2d（**两对牌面**）', ['9h', '9d', '2c', '2d']],
] as ReadonlyArray<readonly [string, readonly string[]]>) {
  const cards = board.map((c) => parseCardStrict(c));
  const t = boardTextureOf(cards as never);
  kv(`  ${tag}`, `pairedBoard=${String(t?.['pairedBoard'])}  tripsOnBoard=${String(t?.['tripsOnBoard'])}  maxRun=${String(t?.['maxRunLength'])}  纹理标签=${String(boardTextureLabelOf(cards as never))}`);
}

/* ============================================================
 * §2 M19：生产运行 —— 转牌「成对」时的用户可见措辞
 * ============================================================ */
section('§2 M19 · 生产节点：转牌让牌面成对（Jd 8c 4c → Js），措辞与实际结构');
for (const [tag, cards] of [['Hero AA', ['As', 'Ah']], ['Hero 听花 AcJc', ['Ac', 'Jc']], ['Hero 空气 AsKs', ['As', 'Ks']]] as ReadonlyArray<readonly [string, readonly string[]]>) {
  const d = guard(H({
    heroCards: cards, board: ['Jd', '8c', '4c', 'Js'], street: 'TURN',
    actionHistory: [...PRE, A_('BB', 'CHECK', undefined, 'FLOP'), A_('BTN', 'BET', 4, 'FLOP'), A_('BB', 'CALL', 4, 'FLOP'), A_('BB', 'CHECK', undefined, 'TURN')],
    villain: MANIAC,
  }), tag);
  if (!d.r.ok) continue;
  const bd = (d.pf['boardDelta'] ?? {}) as Rec;
  kv(tag, '');
  kv('    boardDelta.pairedBoard / blankScore', `${String(bd['pairedBoard'])} ｜ ${n(bd['blankScore'], 4)}`);
  kv('    boardDelta 其余', `flushCompleted=${String(bd['flushCompleted'])} straightCompleted=${String(bd['straightCompleted'])} 四条同花=${String(bd['fourToFlush'])}`);
  const reasons = ((d.decision['reasons'] as readonly Rec[]) ?? []).filter((r) => String(r['code']) === 'BOARD_DELTA');
  for (const r of reasons) line(`    BOARD_DELTA: ${String(r['textZh']).slice(0, 320)}`);
  kv('    rangeCompression.noteZh', J(((d.pf['rangeCompression'] ?? {}) as Rec)['noteZh'], 260));
  const dbg = (((d.vm['debug'] as Rec | undefined)?.['postflop'] as readonly Rec[] | undefined) ?? []).filter((x) => String(x['label']).includes('牌面') || String(x['value']).includes('成对'));
  kv('    界面「牌面」行', dbg.length === 0 ? '（无提到成对的行）' : J(dbg, 500));
  kv('    betRange.model.boardTexture', String((((d.pf['bettingRangeFacts'] ?? {}) as Rec)['model'] ?? {})['boardTexture']));
}

/* ============================================================
 * §3 M9：再加注分支的规则可达性（Hero 深筹码 ⇒ 不因全下而关闭分支）
 * ============================================================ */
section('§3 M9 · 再加注分支：reRaiseTo 是否 ≥ 最小合法再加注（或恰为全下）');
const deep = 300;
const DEEP_BASE = { seatStacksBB: { UTG: deep, HJ: deep, CO: deep, BTN: deep, SB: deep, BB: deep }, effectiveStackBB: deep } as const;
for (const [tag, villainBB, betTo] of [
  ['对手 300BB，Hero 300BB（双方深）', 300, 10],
  ['对手 60BB，Hero 300BB', 60, 10],
  ['对手 30BB，Hero 300BB', 30, 10],
  ['对手 300BB，河牌领打 40BB', 300, 40],
] as ReadonlyArray<readonly [string, number, number]>) {
  const seatStacks = { UTG: deep, HJ: deep, CO: deep, BTN: deep, SB: deep, BB: villainBB };
  const streetNb = betTo === 40 ? 'RIVER' : 'TURN';
  const board = betTo === 40 ? ['Jd', '8c', '4c', '6s', '2d'] : ['Jd', '8c', '4c', '6s'];
  const history = betTo === 40
    ? [...PRE, A_('BB', 'CHECK', undefined, 'FLOP'), A_('BTN', 'BET', 4, 'FLOP'), A_('BB', 'CALL', 4, 'FLOP'), A_('BB', 'CHECK', undefined, 'TURN'), A_('BTN', 'BET', 10, 'TURN'), A_('BB', 'CALL', 10, 'TURN'), A_('BB', 'BET', 40, 'RIVER')]
    : [...PRE, A_('BB', 'CHECK', undefined, 'FLOP'), A_('BTN', 'BET', 4, 'FLOP'), A_('BB', 'CALL', 4, 'FLOP'), A_('BB', 'BET', betTo, 'TURN')];
  const d = guard(H({ ...DEEP_BASE, seatStacksBB: seatStacks, heroCards: ['Ac', 'Jc'], board, street: streetNb, actionHistory: history, villain: { seatId: 'seat_BB', quickProfile: 'MANIAC', dynamicHint: 'UNKNOWN', stackBB: villainBB } as ManualVillain }), tag);
  if (!d.r.ok) continue;
  const rr = (d.pf['raiseResponse'] ?? null) as Rec | null;
  const reRaiseTo = rr?.['reRaiseTo'] as number | undefined;
  const minLegal = rr?.['reRaiseMinLegalTo'] as number | undefined;
  const isAllIn = rr?.['villainReRaiseIsAllIn'] as boolean | undefined;
  kv(tag, '');
  kv('    action / sizeChips', `${String(d.decision['action'])} ｜ ${String(d.decision['sizeChips'])}`);
  kv('    reRaiseLikelihood / reRaiseCombos', `${n(rr?.['reRaiseLikelihood'], 6)} ｜ ${String(rr?.['reRaiseCombos'])}`);
  kv('    reRaiseTo / minLegal / villainReRaiseIsAllIn', `${String(reRaiseTo)} ｜ ${String(minLegal)} ｜ ${String(isAllIn)}`);
  kv('    规则合法性（≥最小额 或 全下）', reRaiseTo === undefined || minLegal === undefined ? '（无分支）' : String(reRaiseTo >= minLegal - 1e-9 || isAllIn === true));
  kv('    villainIsAllInByCall / heroIsAllIn', `${String(rr?.['villainIsAllInByCall'])} ｜ ${String(rr?.['model']?.['heroIsAllIn'])}`);
  kv('    heroFourBetSupported', String(rr?.['heroFourBetSupported']));
  kv('    reraiseBranchKind / reraiseBranchEV', `${String(rr?.['reraiseBranchKind'])} ｜ ${n(rr?.['reraiseBranchEV'], 4)}`);
}

/* ============================================================
 * §4 M3：河牌「他的下注尺寸」是否进入条件范围 + 尺寸近似的披露
 * ============================================================ */
section('§4 M3/M19 · 河牌不同领打尺寸 ⇒ 下注范围是否变化 / 尺寸近似是否如实披露');
for (const bet of [10, 20, 40, 80]) {
  const d = guard(H({
    heroCards: ['As', 'Ah'], board: ['Ad', '9c', '4h', '6s', '2d'], street: 'RIVER',
    actionHistory: [...PRE, A_('BB', 'CHECK', undefined, 'FLOP'), A_('BTN', 'BET', 4, 'FLOP'), A_('BB', 'CALL', 4, 'FLOP'), A_('BB', 'CHECK', undefined, 'TURN'), A_('BTN', 'BET', 10, 'TURN'), A_('BB', 'CALL', 10, 'TURN'), A_('BB', 'BET', bet, 'RIVER')],
    villain: MANIAC,
  }), `RIVER bet ${bet}`);
  if (!d.r.ok) continue;
  const br = (d.pf['bettingRangeFacts'] ?? null) as Rec | null;
  const model = (br?.['model'] ?? {}) as Rec;
  kv(`  ${String(bet).padStart(2)}BB`, `EqVsBet=${pct(d.math['heroEquityVsBetRange'], 4)} betMass=${n(br?.['betMass'], 4)} model.ratioToPot=${n(model['ratioToPot'], 4)} texture=${String(model['boardTexture'])}`);
  kv('    noteZh', J(String(br?.['noteZh'] ?? '').slice(0, 400), 420));
}
