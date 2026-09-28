/*
 * 🔴 **真实玩家频率**：这份数据集有**稳定的玩家身份**（名字跨手复用）——
 * 我此前判定「画像无法验证」是**错的**，本脚本先把这个前提核实清楚。
 *
 * 每手 6 个座位、455 手 ⇒ 每个身份约 200 手（MrBrown/MrOrange 中途换人）。
 *
 * 算的是**项目自己用的那几个维度**，口径与 `docs/player_types.md` 对齐：
 * - VPIP：主动入池（跟注或加注）的手数占比（**排除**盲注被迫投入）
 * - PFR：翻前主动加注的手数占比
 * - fold-to-flop-bet：面对翻牌下注时弃牌的比例
 *
 * ⚠️ 只读第三方数据。**不写生产文件。**
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { parsePhh } from '../src/domain/realHands/phh.ts';
import { seatPositionsOf } from '../src/domain/realHands/phh.ts';

const ROOT = process.cwd();
const DATA = join(ROOT, 'third_party', 'phh-dataset');
const OUT = join(ROOT, 'reports', 'real-player-frequencies-out.txt');

type Stat = {
  hands: number;
  vpip: number;
  pfr: number;
  /** 面对翻牌下注：机会数 / 弃牌数 */
  facingFlopBet: number;
  foldedToFlopBet: number;
};

const stats = new Map<string, Stat>();

type Street = 'PREFLOP' | 'FLOP' | 'TURN' | 'RIVER';

for (const d of readdirSync(DATA)) {
  const dir = join(DATA, d);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    continue;
  }
  for (const f of entries.filter((x) => x.endsWith('.phh'))) {
    const parsed = parsePhh(readFileSync(join(dir, f), 'utf8'));
    if (!parsed.ok) continue;
    const hand = parsed.hand;
    const positions = seatPositionsOf(hand);
    if (positions === null) continue;

    /** 本手每个身份的状态 */
    const st = new Map<string, { invested: number; raised: boolean; isBlind: boolean }>();
    hand.players.forEach((name, i) => {
      const pos = positions[i]!;
      const s = stats.get(name) ?? { hands: 0, vpip: 0, pfr: 0, facingFlopBet: 0, foldedToFlopBet: 0 };
      s.hands += 1;
      stats.set(name, s);
      st.set(name, { invested: 0, raised: false, isBlind: pos === 'SB' || pos === 'BB' });
    });

    let street: Street = 'PREFLOP';
    let boardCount = 0;
    /** 本街当前最高投入（用于判断「面对下注」） */
    let currentBet = 0;
    const committed = new Map<string, number>();
    for (const name of hand.players) committed.set(name, 0);

    for (const a of hand.actions) {
      if (a.kind === 'DEAL_HOLE') continue;
      if (a.kind === 'DEAL_BOARD') {
        boardCount += a.cards.length;
        const next: Street = boardCount >= 5 ? 'RIVER' : boardCount === 4 ? 'TURN' : boardCount === 3 ? 'FLOP' : 'PREFLOP';
        if (next !== street) {
          street = next;
          currentBet = 0;
          for (const name of hand.players) committed.set(name, 0);
        }
        continue;
      }
      if (a.kind === 'SHOW') continue;
      if (a.kind !== 'FOLD' && a.kind !== 'CHECK_OR_CALL' && a.kind !== 'BET_OR_RAISE_TO') continue;

      const name = hand.players[a.playerIndex];
      if (name === undefined) continue;
      const info = st.get(name);
      if (info === undefined) continue;
      const already = committed.get(name) ?? 0;
      const facing = currentBet > already;

      if (a.kind === 'FOLD') {
        if (street === 'FLOP' && facing) {
          const s = stats.get(name)!;
          s.facingFlopBet += 1;
          s.foldedToFlopBet += 1;
        }
      } else if (a.kind === 'CHECK_OR_CALL') {
        if (street === 'FLOP' && facing) stats.get(name)!.facingFlopBet += 1;
        if (street === 'PREFLOP') {
          /* 主动入池：面对下注而跟注（不是盲注被迫补齐） */
          const need = currentBet - already;
          if (need > 0 && !facing) {
            /* 无人加注 ⇒ 这是「补齐到大盲」，盲注位不算主动入池 */
            if (!info.isBlind) info.invested = 1;
          } else if (need > 0) {
            info.invested = 1;
          }
        }
        committed.set(name, Math.max(already, currentBet));
      } else {
        /* BET_OR_RAISE_TO */
        if (street === 'FLOP' && facing) stats.get(name)!.facingFlopBet += 1;
        if (street === 'PREFLOP') {
          info.raised = true;
          info.invested = 1;
        }
        committed.set(name, Math.max(already, a.amount));
        currentBet = Math.max(currentBet, a.amount);
      }
    }

    for (const [name, info] of st) {
      const s = stats.get(name)!;
      if (info.invested === 1) s.vpip += 1;
      if (info.raised) s.pfr += 1;
    }
  }
}

/* ============================================================
 * 输出
 * ============================================================ */

const lines: string[] = [];
const say = (s = ''): void => void lines.push(s);
say('真实玩家频率（455 手 Pluribus 6-max 真实牌局，$50/$100）');
say('='.repeat(88));
say('身份            手数    VPIP     PFR      面对翻牌下注   其中弃牌   fold-to-flop-bet');
say('-'.repeat(88));

const rows = [...stats.entries()].sort((a, b) => b[1].hands - a[1].hands);
for (const [name, s] of rows) {
  const v = s.hands === 0 ? 0 : s.vpip / s.hands;
  const p = s.hands === 0 ? 0 : s.pfr / s.hands;
  const fb = s.facingFlopBet === 0 ? null : s.foldedToFlopBet / s.facingFlopBet;
  say(
    `${name.padEnd(14)} ${String(s.hands).padStart(4)}   ${(v * 100).toFixed(1).padStart(5)}%   ` +
      `${(p * 100).toFixed(1).padStart(5)}%   ${String(s.facingFlopBet).padStart(12)}   ` +
      `${String(s.foldedToFlopBet).padStart(8)}   ${fb === null ? '—' : `${(fb * 100).toFixed(1)}%`}`,
  );
}

const withFacing = rows.filter(([, s]) => s.facingFlopBet > 0);
const allFacing = withFacing.reduce((a, [, s]) => a + s.facingFlopBet, 0);
const allFolded = withFacing.reduce((a, [, s]) => a + s.foldedToFlopBet, 0);
say('');
say('='.repeat(88));
say('汇总');
say('='.repeat(88));
say(`面对翻牌下注的总机会数   ${allFacing}`);
say(`其中弃牌                 ${allFolded}`);
say(`真实 fold-to-flop-bet    **${allFacing === 0 ? '—' : `${((allFolded / allFacing) * 100).toFixed(1)}%`}**`);
say('');
say('对照（`docs/player_types.md` 的实测库口径）：');
say('  Nit 10.5/7.1 ｜ Tight-passive 18.8/7.2 ｜ TAG 18.3/13.9');
say('  Loose-passive 33.4/10.1 ｜ LAG 29.9/21.6 ｜ Whale 56.5/12.5 ｜ Maniac 56.3/37.1');
say('  station: fold-to-flop-bet < 45% ｜ folder: > 65%');
say('');
say('判据（写死）：');
say('  · 若这些真实职业/半职业玩家之间 **VPIP/PFR 有明显差异** ⇒ 身份维度**可测**；');
say('  · 若 fold-to-flop-bet 也有差异 ⇒ **画像通道可以用真牌局验证**（我之前判定"不可验证"是错的）。');

writeFileSync(OUT, lines.join('\n') + '\n', 'utf8');
console.log(lines.join('\n'));
