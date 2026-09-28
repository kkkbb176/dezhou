/*
 * 🔴 **反事实结算**：照引擎的下注建议打，对不同「响应假设」的对手会亏多少？
 *
 * ## 为什么这个测法干净
 *
 * 一个下注的 EV 只由三样东西决定：
 *
 * ```text
 * EV(下注) = fold × 底池 + call × [权益 × (底池 + 2×注额) − 注额]
 *            └ 弃牌收益 ┘   └ 被跟时的净收益 ─────────────┘
 * ```
 *
 * - **底池**：引擎重算的，可核对；
 * - **权益**：引擎自己的权益引擎算的（对**对手真实那一手**）—— 数学事实；
 * - **他会弃多少**：**唯一的不确定项**，也是这整条缺陷所在。
 *
 * ⇒ 所以本测**不引入任何新假设**，只把同一个下注放进三套响应假设里比较：
 *
 * | 假设 | 含义 |
 * |---|---|
 * | `ENGINE` | 引擎自己算的 fold（实测高估约 4 倍） |
 * | `REAL_DATA` | 用**真实牌局实测**的弃牌率（18.2%，732 个配对样本） |
 * | `BALANCED` | **平衡型对手**（按赔率防守 ⇒ 不弃）—— 你问的那种 |
 *
 * ## 判据（写死）
 *
 * - 若某个假设下 **EV(下注) < EV(过牌)**，那这个下注就是**错的**（在该假设下）；
 * - 统计「下注错的比例」与「平均损失（每 100 手）」。
 *
 * ⚠️ 局限（如实标注）：`REAL_DATA` 用的是**全局**弃牌率，而非逐尺寸的。
 *    依据是实测：引擎的预测与真实弃牌**相关系数 r ≈ −0.03**，即它**不区分**尺寸与局面
 *    ⇒ 用一个全局率反而是对现有信息最诚实的用法。
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { computeEquity } from '../src/domain/poker/equity.ts';
import { parseCardCode } from '../src/app/manualInput/manualInput.ts';
import { loadKnowledgeBase } from '../src/domain/knowledge/knowledgeLoader.ts';
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { parsePhh } from '../src/domain/realHands/phh.ts';
import { toValidatorSnapshotsDetailed } from '../src/domain/realHands/phhToEngineInput.ts';
import type { Card } from '../src/domain/types.ts';

const knowledge = loadKnowledgeBase();
if (!knowledge.ok) throw new Error('知识库加载失败');
const rules = knowledge.index.allRules();

const ROOT = process.cwd();
const DATA = join(ROOT, 'third_party', 'phh-dataset');
const OUT = join(ROOT, 'reports', 'bet-advice-counterfactual-out.txt');

/** 真实牌局实测的 fold-to-flop-bet（scripts/real-player-frequencies.ts，188 个机会 / 97 弃牌）
 * ⚠️ 修正：此前用的 0.182 来自一个**口径不对**的配对（'引擎建议下注后同一手里下一个动作是否弃牌'），
 *    它混了不同主体。正确口径是 51.6%。 */
const REAL_FOLD_RATE = 0.516;
/** 平衡型对手：按赔率防守 ⇒ 不弃（保守下界） */
const BALANCED_FOLD_RATE = 0.0;

type Row = {
  /** 引擎在**它自己的假设**下的 EV（筹码） */
  engineEV: number;
  /** 引擎假设的弃牌率 */
  engineFold: number;
  /** 用真实弃牌率重算的下注 EV */
  realEV: number;
  /** 用平衡对手假设重算的下注 EV */
  balancedEV: number;
  /** 过牌 EV（引擎自己的数） */
  checkEV: number;
  pot: number;
  bet: number;
  /** 我方对**对手真实那一手**的权益 */
  equity: number;
  street: string;
};

const rows: Row[] = [];
let noCards = 0;
let eqFailed = 0;

const toCards = (s: string): Card[] | null => {
  const a = parseCardCode(s.slice(0, 2));
  const b = parseCardCode(s.slice(2, 4));
  return a === null || b === null ? null : [a as Card, b as Card];
};

/** 下注 EV（给定弃牌率）—— 唯一的不确定项被显式参数化 */
function betEVOf(fold: number, pot: number, bet: number, equity: number): number {
  const call = 1 - fold;
  return fold * pot + call * (equity * (pot + 2 * bet) - bet);
}

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
    for (const snap of toValidatorSnapshotsDetailed(parsed.hand).snapshots) {
      const r = analyzeManualHand(snap.input, { rules, writeLog: false, equitySeed: 1 });
      if (!r.ok) continue;
      if (r.decision.action !== 'BET') continue; /* 只看「引擎建议下注」的节点 */

      const bd = r.decision.diagnostics.betDecision;
      if (bd === null) continue;
      const sizeChips = r.decision.sizeChips ?? 0;
      const hit =
        bd.sizes.find((s) => s.betAmount === sizeChips) ??
        bd.sizes.reduce((a, b) =>
          Math.abs(b.betAmount - sizeChips) < Math.abs(a.betAmount - sizeChips) ? b : a,
        );
      const engineEV = hit.betEV;
      if (engineEV === null || bd.checkEV === null) continue;

      const oppStr = Object.values(snap.opponentCards)[0];
      if (oppStr === undefined) {
        noCards += 1;
        continue;
      }
      const opp = toCards(oppStr);
      const hero = toCards(snap.input.heroCards.join(''));
      const board = snap.input.board.map((c) => parseCardCode(c)).filter((c): c is Card => c !== null);
      if (opp === null || hero === null || board.length < 3) {
        noCards += 1;
        continue;
      }

      /* 我方对**对手真实那一手**的权益（数学事实，不含任何响应假设） */
      const out = computeEquity(
        hero,
        board,
        [{ label: 'ACTUAL', combos: [[opp[0], opp[1]]] }],
        { seed: 20260926, forceMethod: 'MONTE_CARLO', iterations: 600, maxIterations: 600 },
      );
      if (!out.ok) {
        eqFailed += 1;
        continue;
      }
      const equity = out.result.equity;

      const pot = bd.pot;
      const bet = hit.betAmount;
      rows.push({
        engineEV,
        engineFold: hit.foldLikelihood,
        realEV: betEVOf(REAL_FOLD_RATE, pot, bet, equity),
        balancedEV: betEVOf(BALANCED_FOLD_RATE, pot, bet, equity),
        checkEV: bd.checkEV,
        pot,
        bet,
        equity,
        street: snap.street,
      });
    }
  }
}

/* ============================================================
 * 汇总
 * ============================================================ */

const lines: string[] = [];
const say = (s = ''): void => void lines.push(s);
const mean = (xs: number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);

say('反事实结算：照引擎的下注建议打，对不同响应假设的对手会亏多少？');
say('='.repeat(84));
say(`样本：${rows.length} 个「引擎建议 BET」的真实决策点（无底牌 ${noCards}，权益失败 ${eqFailed}）`);
say('');
say('下注 EV = fold × 底池 + (1−fold) × [权益 × (底池 + 2×注额) − 注额]');
say('唯一的不确定项 = **fold**（他会弃多少）。底池与权益都是可核对的量。');
say('');
say('三套假设：');
say(`  ENGINE   = 引擎自己算的 fold（实测高估约 4 倍）`);
say(`  REAL_DATA= 真实牌局实测弃牌率 ${(REAL_FOLD_RATE * 100).toFixed(1)}%`);
say(`  BALANCED = 平衡型对手按赔率防守 ⇒ 不弃（${(BALANCED_FOLD_RATE * 100).toFixed(0)}%）`);
say('');

for (const [name, pick] of [
  ['ENGINE', (r: Row) => r.engineEV],
  ['REAL_DATA', (r: Row) => r.realEV],
  ['BALANCED', (r: Row) => r.balancedEV],
] as const) {
  const bad = rows.filter((r) => pick(r) < r.checkEV);
  const lossPerSpot = mean(bad.map((r) => r.checkEV - pick(r)));
  const totalLoss = bad.reduce((a, r) => a + (r.checkEV - pick(r)), 0);
  say(`--- ${name} ---`);
  say(`  平均弃牌率假设     ${(name === 'ENGINE' ? mean(rows.map((r) => r.engineFold)) * 100 : name === 'REAL_DATA' ? REAL_FOLD_RATE * 100 : 0).toFixed(1)}%`);
  say(`  平均下注 EV        ${mean(rows.map(pick)).toFixed(1)} 筹码`);
  say(`  平均过牌 EV        ${mean(rows.map((r) => r.checkEV)).toFixed(1)} 筹码`);
  say(`  下注 EV < 过牌 EV 的节点   ${bad.length} / ${rows.length} = ${((bad.length / Math.max(1, rows.length)) * 100).toFixed(1)}%`);
  say(`  这些节点上平均每手亏       ${lossPerSpot.toFixed(1)} 筹码 = ${(lossPerSpot / 100).toFixed(2)} BB`);
  say(`  ⇒ 每 100 手总损失          ${(totalLoss / Math.max(1, rows.length) * 100 / 100).toFixed(1)} BB`);
  say('');
}

say('='.repeat(84));
say('按街拆开（REAL_DATA 假设下）');
say('='.repeat(84));
say('街道      样本   下注错的比例   平均每手亏(BB)');
for (const st of ['FLOP', 'TURN', 'RIVER']) {
  const g = rows.filter((r) => r.street === st);
  if (g.length === 0) continue;
  const bad = g.filter((r) => r.realEV < r.checkEV);
  const loss = mean(bad.map((r) => r.checkEV - r.realEV));
  say(
    `${st.padEnd(9)} ${String(g.length).padStart(4)}   ${((bad.length / g.length) * 100).toFixed(1).padStart(11)}%   ` +
      `${(loss / 100).toFixed(2).padStart(13)}`,
  );
}

say('');
say('='.repeat(84));
say('怎么读');
say('='.repeat(84));
say('· 在 ENGINE 假设下，下注几乎总是"对"的（引擎自己算的 EV 当然支持它自己的选择）—— 这是**自洽性检查**，不是证据。');
say('· 在 REAL_DATA / BALANCED 假设下，**下注错的比例**与**每手亏多少**才是你要的数。');
say('· ⚠️ 这**不是**"完整的对抗 EV"：它假设「下注后被跟 ⇒ 摊牌」，未建模后续街的行动。');
say('   因此它是一个**方向性下界**，不是精确的每 100 手盈亏。');
say('· ⚠️ `REAL_DATA` 用全局弃牌率而非逐尺寸（依据：引擎预测与真实弃牌的相关系数 r ≈ −0.03，');
say('   即它**不区分**尺寸与局面）。');

writeFileSync(OUT, lines.join('\n') + '\n', 'utf8');
console.log(lines.join('\n'));
