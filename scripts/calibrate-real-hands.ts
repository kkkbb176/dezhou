/*
 * 校准检验：**引擎自己预测的「他会弃牌」** vs **真实牌局里对手的实际响应**。
 *
 * ## 🔴 配对怎么定义（我第一版搞错了，这里是修正后的口径）
 *
 * 第一版把「该决策点的真实动作」当作对手的响应 —— **从根上错了**。
 * 交叉表证明得很干净（`scripts/cross-tab-engine-vs-real.ts`）：
 *
 * ```text
 * 引擎建议 BET ⇒ 真实动作 CHECK 476 ｜ RAISE 273 ｜ FOLD 0 ｜ CALL 0
 * ```
 *
 * 因为「该决策点的真实动作」是**轮到的那个人**做的，而**对手的响应发生在他之后**。
 * 把两者当成一回事，永远只会得到「0 个弃牌」——那不是模型校准失败，
 * 是**我把两个不同主体的动作配错了对**。
 *
 * ## 正确的配对
 *
 * 对每个「引擎建议 BET/RAISE」的决策点，取**同一手牌里、它之后的第一条
 * 不是该行动者做的动作**，那才是「对手对我这一注的响应」。
 * 它可能落在同一条街（正常），也可能落在下一街（本街被关闭）—— 都记下来并分类。
 *
 * ## 判据（写死在脚本里，避免事后解释）
 *
 * - 预测值 = 引擎为该建议尺寸算的 `foldLikelihood`；
 * - 实际值 = 配到的那个对手动作**是不是弃牌**；
 * - 分桶比较，给出二项 95% 区间 —— **区间覆盖预测均值才算相容**。
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { loadKnowledgeBase } from '../src/domain/knowledge/knowledgeLoader.ts';
import { parsePhh } from '../src/domain/realHands/phh.ts';
import { toValidatorSnapshotsDetailed, type ValidatorSnapshot } from '../src/domain/realHands/phhToEngineInput.ts';

const ROOT = process.cwd();
const DATA = join(ROOT, 'third_party', 'phh-dataset');
const OUT = join(ROOT, 'reports', 'real-hand-calibration-out.txt');

const knowledge = loadKnowledgeBase();
if (!knowledge.ok) throw new Error('知识库加载失败');
const rules = knowledge.index.allRules();

/** 一条观测：引擎预测「他会弃牌 p」，而配到的对手响应确实是弃牌吗 */
type Obs = { predicted: number; folded: boolean; gap: 'SAME_STREET' | 'NEXT_STREET'; tag: string };

const obs: Obs[] = [];
/** 带双方真实底牌的子集，用于「按对手真实牌力分层」——排除范围假设的混淆 */
type Stratum = {
  predicted: number;
  folded: boolean;
  heroCards: string;
  oppCards: string;
  board: string[];
  street: string;
};
const strata: Stratum[] = [];
const realActionTally = new Map<string, number>();
let considered = 0;
let noPrediction = 0;
let noPair = 0;

function files(): { dir: string; file: string }[] {
  const out: { dir: string; file: string }[] = [];
  for (const d of readdirSync(DATA)) {
    const dir = join(DATA, d);
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of entries.filter((x) => x.endsWith('.phh'))) out.push({ dir: d, file: join(dir, f) });
  }
  return out;
}

/** 把快照按发生顺序排好（`historyLength` → 输入里的行动条数 → 读入顺序） */
function ordered(snaps: readonly ValidatorSnapshot[]): ValidatorSnapshot[] {
  return [...snaps].sort(
    (a, b) =>
      a.input.actionHistory.length - b.input.actionHistory.length ||
      Number(a.heroPosition > b.heroPosition) - Number(a.heroPosition < b.heroPosition),
  );
}

for (const { dir, file } of files()) {
  const parsed = parsePhh(readFileSync(file, 'utf8'));
  if (!parsed.ok) continue;
  const { snapshots } = toValidatorSnapshotsDetailed(parsed.hand);
  if (snapshots.length === 0) continue;

  /* 快照本身就是按 PHH 动作顺序产出的（`toValidatorSnapshotsDetailed` 顺序 push），
     `index` 未导出，因此用输入里行动历史长度的**非降**顺序稳妥对齐 */
  const seq = [...snapshots];

  for (let i = 0; i < seq.length; i += 1) {
    const snap = seq[i]!;
    const r = analyzeManualHand(snap.input, { rules, writeLog: false, equitySeed: 1 });
    if (!r.ok) continue;
    const action = r.decision.action;
    /* 只检验「我方主动进攻」的节点 —— 引擎只有在这些节点上用到弃牌率 */
    if (action !== 'BET' && action !== 'RAISE') continue;
    considered += 1;

    type SizeLike = { sizeChips?: number; betAmount?: number; foldLikelihood?: number };
    const diag = r.decision.diagnostics as unknown as {
      betDecision?: { sizes?: readonly SizeLike[] };
      preflopRaise?: { sizes?: readonly SizeLike[] };
    };
    const sizes: readonly SizeLike[] = diag.betDecision?.sizes ?? diag.preflopRaise?.sizes ?? [];
    if (sizes.length === 0) {
      noPrediction += 1;
      continue;
    }
    const amountOf = (s: SizeLike): number => s.betAmount ?? s.sizeChips ?? 0;
    const want = r.decision.sizeChips;
    const hit =
      want === undefined
        ? sizes[0]!
        : (sizes.find((s) => amountOf(s) === want) ??
          sizes.reduce((a, b) => (Math.abs(amountOf(b) - want) < Math.abs(amountOf(a) - want) ? b : a)));
    const predicted = hit.foldLikelihood;
    if (typeof predicted !== 'number' || !Number.isFinite(predicted)) {
      noPrediction += 1;
      continue;
    }

    /*
     * 🔴 **配对**：找我之后的**第一个「不是我做」的动作** = 对手对我这一注的响应。
     * 找不到（我是本手最后一个动作的人）⇒ 这一注**没有被响应过**，剔除并计数。
     */
    const later = seq.slice(i + 1).find((s) => s.heroName !== snap.heroName);
    if (later === undefined) {
      noPair += 1;
      continue;
    }
    const gap: Obs['gap'] = later.street === snap.street ? 'SAME_STREET' : 'NEXT_STREET';

    obs.push({
      predicted,
      folded: later.realAction === 'FOLD',
      gap,
      tag: `${dir}/${file.slice(file.lastIndexOf('\\') + 1)} ${snap.street} ${snap.heroPosition}→${later.heroName}`,
    });
    realActionTally.set(later.realAction, (realActionTally.get(later.realAction) ?? 0) + 1);

    /*
     * 🔴 **分层用的关键对照**：引擎是对**它自己假设的范围**预测弃牌率的，
     * 而我手里有**对手的真实底牌**。两者不一致时弃牌率当然会对不上 ——
     * 那属于「范围假设」问题，不是「弃牌频率模型」问题。
     * 因此把决策时刻双方底牌记下来，后续按对手真实牌力分组。
     */
    const oppCards = Object.values(snap.opponentCards)[0];
    if (oppCards !== undefined && oppCards.length === 4) {
      strata.push({
        predicted,
        folded: later.realAction === 'FOLD',
        heroCards: snap.input.heroCards.join(''),
        oppCards,
        board: [...snap.input.board],
        street: snap.street,
      });
    }
  }
}

/* ============================================================
 * 分桶 + 二项 95% 区间
 * ============================================================ */

const BUCKETS: readonly [number, number][] = [
  [0, 0.2], [0.2, 0.4], [0.4, 0.6], [0.6, 0.8], [0.8, 1.01],
];

/** Wilson 区间的粗略替代：正态近似（n 足够时可用，小 n 会偏窄 —— 如实标注） */
function ci95(successes: number, n: number): [number, number] {
  if (n === 0) return [0, 0];
  const p = successes / n;
  const se = Math.sqrt((p * (1 - p)) / n);
  return [Math.max(0, p - 1.96 * se), Math.min(1, p + 1.96 * se)];
}

const lines: string[] = [];
const say = (s = ''): void => void lines.push(s);

say('校准检验：引擎预测的「他会弃牌」vs 真实牌局里他实际弃牌的比例');
say('='.repeat(78));
say(`数据：${DATA}`);
say(`引擎建议下注/加注的节点数        ${considered}`);
say(`其中拿不到预测数值                ${noPrediction}`);
say(`其中后面**没有任何对手动作**可配对 ${noPair}`);
say(`进入校准样本                      ${obs.length}`);
say('');
say('配对到的「对手响应」分布（**用来自证配对没坏**）：');
for (const [k, v] of [...realActionTally].sort((a, b) => b[1] - a[1])) say(`  ${k.padEnd(10)} ${v}`);
say('');
say('⚠️ 样本口径是**保守**的：只取「真实行动者那一家」的响应；');
say('   多路底池里其他对手的响应没有计入（那需要逐对手建模，本轮未做）。');
say('');
say('预测区间            样本   预测均值   实际弃牌率    实际 95% 区间        区间是否覆盖预测');
say('-'.repeat(78));

let totalAbsError = 0;
let covered = 0;
let usedBuckets = 0;

for (const [lo, hi] of BUCKETS) {
  const inBucket = obs.filter((o) => o.predicted >= lo && o.predicted < hi);
  if (inBucket.length === 0) {
    say(`${`[${lo.toFixed(1)}, ${hi.toFixed(1)})`.padEnd(18)} ${'0'.padStart(4)}   —          —             —`);
    continue;
  }
  const n = inBucket.length;
  const meanPred = inBucket.reduce((s, o) => s + o.predicted, 0) / n;
  const folds = inBucket.filter((o) => o.folded).length;
  const actual = folds / n;
  const [ciLo, ciHi] = ci95(folds, n);
  const covers = meanPred >= ciLo && meanPred <= ciHi;
  if (covers) covered += 1;
  usedBuckets += 1;
  totalAbsError += Math.abs(actual - meanPred) * n;
  say(
    `${`[${lo.toFixed(1)}, ${hi.toFixed(1)})`.padEnd(18)} ${String(n).padStart(4)}   ` +
      `${(meanPred * 100).toFixed(1).padStart(7)}%   ${(actual * 100).toFixed(1).padStart(9)}%   ` +
      `[${(ciLo * 100).toFixed(1)}%, ${(ciHi * 100).toFixed(1)}%]`.padEnd(20) +
      `   ${covers ? '✅ 是' : '❌ 否'}`,
  );
}

const overallPred = obs.length === 0 ? 0 : obs.reduce((s, o) => s + o.predicted, 0) / obs.length;
const overallFolds = obs.filter((o) => o.folded).length;
const [oLo, oHi] = ci95(overallFolds, obs.length);

say('');
say('='.repeat(78));
say('总体');
say('='.repeat(78));
say(`预测平均弃牌率   ${(overallPred * 100).toFixed(1)}%`);
say(`实际弃牌率       ${(overallFolds / Math.max(1, obs.length) * 100).toFixed(1)}%  （${overallFolds} / ${obs.length}）`);
say(`实际 95% 区间    [${(oLo * 100).toFixed(1)}%, ${(oHi * 100).toFixed(1)}%]`);
say(`区间是否覆盖预测 ${overallPred >= oLo && overallPred <= oHi ? '✅ 是（相容）' : '❌ 否（不相容）'}`);
say(`分桶覆盖         ${covered} / ${usedBuckets}`);
say(`加权平均绝对误差 ${obs.length === 0 ? '—' : `${(totalAbsError / obs.length * 100).toFixed(1)} 个百分点`}`);

const sameStreet = obs.filter((o) => o.gap === 'SAME_STREET');
const nextStreet = obs.filter((o) => o.gap === 'NEXT_STREET');
say('');
say('按「响应发生在本街还是下一街」拆开：');
for (const [name, group] of [['同街响应', sameStreet], ['跨街响应', nextStreet]] as const) {
  if (group.length === 0) continue;
  const p = group.reduce((s, o) => s + o.predicted, 0) / group.length;
  const f = group.filter((o) => o.folded).length;
  const a = f / group.length;
  const [lo, hi] = ci95(f, group.length);
  say(
    `  ${name} n=${String(group.length).padStart(4)}  预测 ${(p * 100).toFixed(1)}%  ` +
      `实际 ${(a * 100).toFixed(1)}%  [${(lo * 100).toFixed(1)}%, ${(hi * 100).toFixed(1)}%]  ` +
      `${p >= lo && p <= hi ? '✅ 相容' : '❌ 不相容'}`,
  );
}
say('');
say('⚠️ **跨街响应**要谨慎读：本街被关闭后，对手在下一街的「弃牌」可能是');
say('   面对**新的一注**（不是我这一注）的反应 ⇒ 它与本次预测并非同一件事。');

say('');
say('='.repeat(78));
say('按「对手真实牌力 vs 我方」分层（**用来排除「范围假设」这个混淆因素**）');
say('='.repeat(78));
say('逻辑：引擎是对**它假设的范围**预测弃牌率的。若偏差**只**出现在某一层，');
say('说明问题在「它以为对手是什么牌」，而不是「弃牌频率模型」本身。');
say('');
say('对手真实牌力         样本   预测均值    实际弃牌率   95% 区间            是否相容');

const { describeHand } = await import('../src/domain/poker/handDescription.ts');
const { parseCardCode } = await import('../src/app/manualInput/manualInput.ts');

const toCards = (s: string): { rank: number; suit: string }[] | null => {
  const a = parseCardCode(s.slice(0, 2));
  const b = parseCardCode(s.slice(2, 4));
  return a === null || b === null ? null : [a as never, b as never];
};

const tiers = new Map<string, { n: number; predSum: number; folds: number }>();
for (const s of strata) {
  const hero = toCards(s.heroCards);
  const opp = toCards(s.oppCards);
  const board = s.board.map((c) => parseCardCode(c)).filter((c) => c !== null) as never[];
  if (hero === null || opp === null || board.length < 3) continue;
  let heroVal: number;
  let oppVal: number;
  try {
    heroVal = describeHand(hero as never, board).value;
    oppVal = describeHand(opp as never, board).value;
  } catch {
    continue;
  }
  const tier =
    oppVal > heroVal * 1.05 ? '对手明显更强'
    : oppVal < heroVal * 0.95 ? '对手明显更弱'
    : '两者接近';
  const t = tiers.get(tier) ?? { n: 0, predSum: 0, folds: 0 };
  t.n += 1;
  t.predSum += s.predicted;
  if (s.folded) t.folds += 1;
  tiers.set(tier, t);
}

for (const [tier, t] of [...tiers].sort((a, b) => b[1].n - a[1].n)) {
  const pred = t.predSum / t.n;
  const actual = t.folds / t.n;
  const [lo, hi] = ci95(t.folds, t.n);
  say(
    `${tier.padEnd(20)} ${String(t.n).padStart(4)}   ${(pred * 100).toFixed(1).padStart(7)}%   ` +
      `${(actual * 100).toFixed(1).padStart(9)}%   ` +
      `[${(lo * 100).toFixed(1)}%, ${(hi * 100).toFixed(1)}%]`.padEnd(20) +
      `  ${pred >= lo && pred <= hi ? '✅ 相容' : '❌ 不相容'}`,
  );
}

say('');
say('='.repeat(78));
say('怎么读这个结果（判据写死在脚本里，避免事后解释）');
say('='.repeat(78));
say('1. 「实际 95% 区间覆盖预测均值」= 预测与事实**相容** ⇒ 没有证据说它错。');
say('2. 「不覆盖」= 预测与事实**显著不符** ⇒ 该尺寸的弃牌率假设与实际不符，');
say('   建立在其上的 EV 需要重新审视。');
say('3. ⚠️ **不覆盖也可能是范围假设偏差**（引擎假设的范围 ≠ 真实对手的范围），');
say('   本检验**无法**区分「弃牌率模型错」与「范围假设错」—— 两者都会表现为同一个现象。');
say('4. ⚠️ 二项区间用**正态近似**；小样本桶（n 小）的区间偏窄，应谨慎解读。');
say('5. ⚠️ 配对口径：只取**同一手里、我之后第一个不是我的动作**。');
say('   多路底池里那可能是**另一个对手**做的，不一定是「面对我这一注」的那个人 ⇒');
say('   本轮**未**逐对手建模，因此这是**近似配对**，样本里混入了这一层噪声。');

writeFileSync(OUT, lines.join('\n') + '\n', 'utf8');
console.log(lines.join('\n'));
console.log(`\n已写入 ${OUT}`);
