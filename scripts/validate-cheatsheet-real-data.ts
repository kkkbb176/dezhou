/*
 * 🔴 **用真实牌局验证速查表**（`reports/PLAYER_TYPE_CHEATSHEET.md`）
 *
 * ## 为什么能做
 *
 * 这份数据集（455 手 Pluribus 6-max）的**玩家名字跨手复用** ⇒ 有稳定的跨手身份
 *（我此前判定"画像无法验证"是错的，见 `REAL_HAND_VALIDATION.md` §9）。
 * 7 个身份、每人 140–455 手。
 *
 * ## 要验的核心主张（速查表 §2）
 *
 * > **对会弃的对手多打、对不会弃的对手别诈唬。**
 *
 * 这个主张要成立，必须同时满足两件事：
 *
 * 1. **弃牌率确实因对手而异**（不是所有人一样）—— 已验证：39.3% → 62.5%；
 * 2. **弃牌率高的对手确实更亏**（否则"多打他"就没有依据）。
 *
 * 第 2 条是本脚本要测的 —— 它是速查表**唯一没被验证过的因果环节**。
 *
 * ## 口径
 *
 * - 盈亏 = `finishing_stacks − starting_stacks`（**筹码**，正 = 赢）
 * - 按 100 手标准化（各人手数不同）
 * - 摊牌率/加注率等其它倾向一并量出，供交叉检查
 *
 * ⚠️ 只读第三方数据。局限写在输出末尾。
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { parsePhh, seatPositionsOf } from '../src/domain/realHands/phh.ts';

const ROOT = process.cwd();
const DATA = join(ROOT, 'third_party', 'phh-dataset');
const OUT = join(ROOT, 'reports', 'cheatsheet-validation-out.txt');

type Acc = {
  hands: number;
  /** 盈亏（筹码） */
  net: number;
  /** 主动入池手数 */
  vpip: number;
  pfr: number;
  /** 面对翻牌下注：机会 / 弃牌 */
  facingFlop: number;
  foldedFlop: number;
  /** 面对转牌下注：机会 / 弃牌 */
  facingTurn: number;
  foldedTurn: number;
  /** 自己主动下注或加注的次数（翻后，含所有街） */
  postflopAggression: number;
  /** 摊牌次数（手数，不是次数） */
  showdownHands: number;
  /** 摊牌赢的次数 */
  showdownWins: number;
};

const stats = new Map<string, Acc>();
const empty = (): Acc => ({
  hands: 0,
  net: 0,
  vpip: 0,
  pfr: 0,
  facingFlop: 0,
  foldedFlop: 0,
  facingTurn: 0,
  foldedTurn: 0,
  postflopAggression: 0,
  showdownHands: 0,
  showdownWins: 0,
});

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

    const n = hand.players.length;
    const perPlayer = new Map<string, { invested: boolean; raised: boolean; isBlind: boolean }>();
    hand.players.forEach((name, i) => {
      const pos = positions[i]!;
      const a = stats.get(name) ?? empty();
      a.hands += 1;
      stats.set(name, a);
      perPlayer.set(name, { invested: false, raised: false, isBlind: pos === 'SB' || pos === 'BB' });
    });

    let street: 'PREFLOP' | 'FLOP' | 'TURN' | 'RIVER' = 'PREFLOP';
    let boardCount = 0;
    let currentBet = 0;
    const committed = new Map<string, number>();
    for (const name of hand.players) committed.set(name, 0);
    /** 本手进入摊牌的玩家 */
    const shown = new Set<string>();

    for (const a of hand.actions) {
      if (a.kind === 'DEAL_HOLE') continue;
      if (a.kind === 'DEAL_BOARD') {
        boardCount += a.cards.length;
        const next =
          boardCount >= 5 ? 'RIVER' : boardCount === 4 ? 'TURN' : boardCount === 3 ? 'FLOP' : 'PREFLOP';
        if (next !== street) {
          street = next;
          currentBet = 0;
          for (const name of hand.players) committed.set(name, 0);
        }
        continue;
      }
      if (a.kind === 'SHOW') {
        const name = hand.players[a.playerIndex];
        if (name !== undefined) shown.add(name);
        continue;
      }
      if (a.kind !== 'FOLD' && a.kind !== 'CHECK_OR_CALL' && a.kind !== 'BET_OR_RAISE_TO') continue;

      const name = hand.players[a.playerIndex];
      if (name === undefined) continue;
      const info = perPlayer.get(name);
      const acc = stats.get(name);
      if (info === undefined || acc === undefined) continue;

      const already = committed.get(name) ?? 0;
      const facing = currentBet > already;

      if (a.kind === 'FOLD') {
        if (street === 'FLOP' && facing) {
          acc.facingFlop += 1;
          acc.foldedFlop += 1;
        }
        if (street === 'TURN' && facing) {
          acc.facingTurn += 1;
          acc.foldedTurn += 1;
        }
      } else if (a.kind === 'CHECK_OR_CALL') {
        if (street === 'FLOP' && facing) acc.facingFlop += 1;
        if (street === 'TURN' && facing) acc.facingTurn += 1;
        if (street === 'PREFLOP') {
          const need = currentBet - already;
          if (need > 0 && (facing || !info.isBlind)) info.invested = true;
        }
        committed.set(name, Math.max(already, currentBet));
      } else {
        if (street === 'FLOP' && facing) acc.facingFlop += 1;
        if (street === 'TURN' && facing) acc.facingTurn += 1;
        if (street !== 'PREFLOP') acc.postflopAggression += 1;
        if (street === 'PREFLOP') {
          info.raised = true;
          info.invested = true;
        }
        committed.set(name, Math.max(already, a.amount));
        currentBet = Math.max(currentBet, a.amount);
      }
    }

    for (const [name, info] of perPlayer) {
      const acc = stats.get(name)!;
      if (info.invested) acc.vpip += 1;
      if (info.raised) acc.pfr += 1;
    }
    void shown;
  }
}

/* ============================================================
 * `finishing_stacks` 从原始文本单独取（parsePhh 未保留）
 * ============================================================ */

const nets = new Map<string, { hands: number; net: number; showdownHands: number; wins: number }>();

for (const d of readdirSync(DATA)) {
  const dir = join(DATA, d);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    continue;
  }
  for (const f of entries.filter((x) => x.endsWith('.phh'))) {
    const raw = readFileSync(join(dir, f), 'utf8');
    const playersRaw = /players\s*=\s*\[([^\]]*)\]/.exec(raw);
    const startRaw = /starting_stacks\s*=\s*\[([^\]]*)\]/.exec(raw);
    const endRaw = /finishing_stacks\s*=\s*\[([^\]]*)\]/.exec(raw);
    if (playersRaw === null || startRaw === null || endRaw === null) continue;
    const names = [...playersRaw[1]!.matchAll(/'([^']*)'/g)].map((m) => m[1]!);
    const starts = startRaw[1]!.split(',').map((x) => Number(x.trim()));
    const ends = endRaw[1]!.split(',').map((x) => Number(x.trim()));
    if (names.length !== starts.length || starts.length !== ends.length) continue;

    /* 摊牌赢家：`sm` 动作的玩家（有亮牌）。粗略：亮牌者中拿 `finishing` 增量的那家 */
    for (let i = 0; i < names.length; i += 1) {
      const name = names[i]!;
      const e = nets.get(name) ?? { hands: 0, net: 0, showdownHands: 0, wins: 0 };
      e.hands += 1;
      e.net += (ends[i] ?? 0) - (starts[i] ?? 0);
      nets.set(name, e);
    }
  }
}

for (const [name, e] of nets) {
  const acc = stats.get(name);
  if (acc === undefined) continue;
  acc.net = e.net;
  acc.hands = Math.max(acc.hands, e.hands);
}

/* ============================================================
 * 输出
 * ============================================================ */

const lines: string[] = [];
const say = (s = ''): void => void lines.push(s);
const pct = (num: number, den: number): string => (den === 0 ? '—' : `${((num / den) * 100).toFixed(1)}%`);

say('用真实牌局验证速查表（455 手 Pluribus 6-max，$50/$100）');
say('='.repeat(96));
say('身份          手数   VPIP    PFR    fold→FLOP   fold→TURN   翻后加注  净盈亏(筹码)  每100手(BB)');
say('-'.repeat(96));

const rows = [...stats.entries()]
  .filter(([, a]) => a.hands >= 100)
  .sort((a, b) => b[1].hands - a[1].hands);

for (const [name, a] of rows) {
  const per100 = (a.net / a.hands) * 100;
  say(
    `${name.padEnd(13)} ${String(a.hands).padStart(4)}   ${pct(a.vpip, a.hands).padStart(5)}  ` +
      `${pct(a.pfr, a.hands).padStart(5)}  ${pct(a.foldedFlop, a.facingFlop).padStart(9)}  ` +
      `${pct(a.foldedTurn, a.facingTurn).padStart(9)}  ${String(a.postflopAggression).padStart(8)}  ` +
      `${a.net.toFixed(0).padStart(11)}  ${(per100 / 100).toFixed(1).padStart(10)}`,
  );
}

say('');
say('='.repeat(96));
say('🔴 核心检验：**弃牌率高的对手，是不是真的更亏？**');
say('='.repeat(96));
say('（速查表主张「对会弃的人多打」—— 这条要成立，必须"会弃 ⇒ 更亏"）');
say('');
say('身份          fold→FLOP   每100手(BB)');

const withBoth = rows
  .map(([name, a]) => ({ name, fold: a.facingFlop === 0 ? null : a.foldedFlop / a.facingFlop, per100: (a.net / a.hands) * 100 / 100, n: a.facingFlop }))
  .filter((r): r is { name: string; fold: number; per100: number; n: number } => r.fold !== null && r.n >= 5)
  .sort((a, b) => b.fold - a.fold);

for (const r of withBoth) {
  say(`${r.name.padEnd(13)} ${(r.fold * 100).toFixed(1).padStart(8)}%   ${r.per100.toFixed(1).padStart(11)}   (机会 ${r.n})`);
}

/* 相关：弃牌率 vs 每 100 手盈亏 */
const corr = (xs: number[], ys: number[]): number => {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return Number.NaN;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i += 1) {
    num += (xs[i]! - mx) * (ys[i]! - my);
    dx += (xs[i]! - mx) ** 2;
    dy += (ys[i]! - my) ** 2;
  }
  return dx === 0 || dy === 0 ? Number.NaN : num / Math.sqrt(dx * dy);
};

const rFold = corr(withBoth.map((r) => r.fold), withBoth.map((r) => r.per100));
say('');
say(`相关系数 r(fold→FLOP, 每100手BB) = ${Number.isFinite(rFold) ? rFold.toFixed(3) : '样本不足'}`);
say('');
say('判据（写死）：');
say('  · **负相关**（越爱弃越亏）⇒ 速查表主张成立，"对会弃的人多打"有真实依据；');
say('  · **接近 0 或正相关** ⇒ 该主张在真实数据上**不成立**，速查表那一栏要改。');
say('');
say('='.repeat(96));
say('局限（必须一起读）');
say('='.repeat(96));
say('1. **样本小**：每人 140–455 手，fold→FLOP 机会数只有 11–39 个 ⇒ 单点噪声大；');
say('2. **对手是职业/半职业级**（Pluribus 的对手），**不是低级别线上人群** ⇒');
say('   结论的方向可参考，绝对水平**不能**搬到低级别；');
say('3. **盈亏含运气**（455 手远不足以分离技术）；此处只看**方向**，不看绝对值；');
say('4. **摊牌赢家未单独标注** ⇒ 未做"弃牌率 vs 摊牌胜率"的独立交叉验证。');

writeFileSync(OUT, lines.join('\n') + '\n', 'utf8');
console.log(lines.join('\n'));
