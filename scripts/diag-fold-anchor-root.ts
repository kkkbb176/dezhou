/*
 * 弃牌率偏高 4 倍 —— **根因定位**：把真实牌局里 `classifyResponse` 的中间量打出来。
 *
 * 要回答的问题：引擎认为「他会弃」的那些组合，实际数值离门槛差多少？
 * 若 `continueIndex` 普遍**只差一点点**，说明门槛（margin）或牌力曲线整体偏低；
 * 若差很多，说明函数形状错了。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { classifyResponse } from '../src/domain/postflop/betResponse.ts';
import { ALL_CARDS, cardIndex } from '../src/domain/poker/cards.ts';
import { parseCardCode } from '../src/app/manualInput/manualInput.ts';
import { describeHand } from '../src/domain/poker/handDescription.ts';
import { loadKnowledgeBase } from '../src/domain/knowledge/knowledgeLoader.ts';
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { parsePhh } from '../src/domain/realHands/phh.ts';
import { toValidatorSnapshotsDetailed } from '../src/domain/realHands/phhToEngineInput.ts';

const knowledge = loadKnowledgeBase();
if (!knowledge.ok) throw new Error('知识库加载失败');
const rules = knowledge.index.allRules();

const ROOT = join(process.cwd(), 'third_party', 'phh-dataset');

/** 收集：引擎判「会弃」而真实是「继续」的组合，看它们的数值 */
type Row = {
  continueIndex: number;
  requiredWithMargin: number;
  gap: number;
  foldWeight: number;
  tier: number;
  boardStrength: number;
  ratioToPot: number;
  street: string;
  realFolded: boolean;
};

const rows: Row[] = [];

for (const d of readdirSync(ROOT)) {
  const dir = join(ROOT, d);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    continue;
  }
  for (const f of entries.filter((x) => x.endsWith('.phh'))) {
    const parsed = parsePhh(readFileSync(join(dir, f), 'utf8'));
    if (!parsed.ok) continue;
    const snaps = toValidatorSnapshotsDetailed(parsed.hand).snapshots;
    for (let i = 0; i < snaps.length; i += 1) {
      const snap = snaps[i]!;
      const r = analyzeManualHand(snap.input, { rules, writeLog: false, equitySeed: 1 });
      if (!r.ok) continue;
      if (r.decision.action !== 'BET' && r.decision.action !== 'RAISE') continue;

      const later = snaps.slice(i + 1).find((s) => s.heroName !== snap.heroName);
      if (later === undefined) continue;
      const oppCardsStr = Object.values(snap.opponentCards)[0];
      if (oppCardsStr === undefined || oppCardsStr.length !== 4) continue;

      const c1 = parseCardCode(oppCardsStr.slice(0, 2));
      const c2 = parseCardCode(oppCardsStr.slice(2, 4));
      if (c1 === null || c2 === null) continue;
      const board = snap.input.board.map((c) => parseCardCode(c)).filter((c) => c !== null) as never[];
      if (board.length < 3) continue;

      let desc;
      try {
        desc = describeHand([c1 as never, c2 as never], board);
      } catch {
        continue;
      }

      /*
       * 复算 `classifyResponse`。
       * ⚠️ `tier` 用 `describeHand` 的强度值**粗略映射到 0..5 档** ——
       * 这只是为了让本探针能跑起来看清形状；若引擎内部的 `tier` 定义不同，
       * 本探针的绝对数值不可直接采信（结论只看**方向与量级**）。
       */
      const tier = Math.max(0, Math.min(5, Math.round((1 - desc.value) * 5)));
      const betChips = r.decision.sizeChips ?? 0;
      const potChips = r.computedPot;
      const ratioToPot = potChips > 0 ? betChips / potChips : 0;
      const priceRequiredEquity = potChips + 2 * betChips > 0 ? betChips / (potChips + 2 * betChips) : 0;
      const cardsToCome = snap.street === 'FLOP' ? 2 : snap.street === 'TURN' ? 1 : 0;

      const cls = classifyResponse({
        hole: [ALL_CARDS[cardIndex(c1 as never)]!, ALL_CARDS[cardIndex(c2 as never)]!],
        versusHero: 'WORSE',
        tier,
        street: snap.street as never,
        cardsToCome,
        ratioToPot,
        priceRequiredEquity,
        spr: 4,
        opponentCount: 1,
        wetness: 0.5,
        tendencies: {
          callScale: 1,
          foldScale: 1,
          raiseScale: 1,
          bluffRaiseScale: 1,
        } as never,
        villainDraw: 'NO_DRAW',
        heroIsAllIn: false,
        villainIsAllInByCall: false,
      });

      rows.push({
        continueIndex: cls.continueIndex,
        requiredWithMargin: cls.requiredWithMargin,
        gap: cls.continueIndex - cls.requiredWithMargin,
        foldWeight: cls.weights.fold,
        tier,
        boardStrength: 0.15 + 0.6 * (1 - tier / 5),
        ratioToPot,
        street: snap.street,
        realFolded: later.realAction === 'FOLD',
      });
    }
  }
}

const mean = (xs: number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);

console.log(`样本 ${rows.length}`);
console.log('');
console.log('按引擎的 fold 权重分桶，看「继续指数 − 门槛」的分布：');
console.log('fold权重区间      样本   continueIndex  requiredWithMargin   gap均值    实际弃牌率');
for (const [lo, hi] of [[0, 0.1], [0.1, 0.5], [0.5, 0.9], [0.9, 1.01]] as const) {
  const g = rows.filter((r) => r.foldWeight >= lo && r.foldWeight < hi);
  if (g.length === 0) continue;
  const fr = g.filter((r) => r.realFolded).length / g.length;
  console.log(
    `[${lo.toFixed(1)}, ${hi.toFixed(1)})`.padEnd(18) +
      String(g.length).padStart(4) + '   ' +
      mean(g.map((r) => r.continueIndex)).toFixed(3).padStart(12) + '   ' +
      mean(g.map((r) => r.requiredWithMargin)).toFixed(3).padStart(17) + '   ' +
      mean(g.map((r) => r.gap)).toFixed(3).padStart(8) + '   ' +
      `${(fr * 100).toFixed(1)}%`.padStart(10),
  );
}

console.log('');
console.log('引擎判「会弃」（fold 权重大于 0.5）而**真实却继续**的样本：');
const wrong = rows.filter((r) => r.foldWeight > 0.5 && !r.realFolded);
console.log(`  ${wrong.length} / ${rows.filter((r) => r.foldWeight > 0.5).length}`);
console.log(`  它们的 gap 均值 = ${mean(wrong.map((r) => r.gap)).toFixed(3)}（越接近 0 = 越"擦边"）`);
console.log(`  它们的 continueIndex 均值 = ${mean(wrong.map((r) => r.continueIndex)).toFixed(3)}，门槛均值 = ${mean(wrong.map((r) => r.requiredWithMargin)).toFixed(3)}`);
console.log(`  它们的 ratioToPot 均值 = ${mean(wrong.map((r) => r.ratioToPot)).toFixed(3)}`);
console.log(`  它们的 tier 分布 = ${JSON.stringify(
  wrong.reduce<Record<number, number>>((a, r) => {
    a[r.tier] = (a[r.tier] ?? 0) + 1;
    return a;
  }, {}),
)}`);
