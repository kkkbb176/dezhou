/*
 * 从真实牌局里找出「SB 平跟 → BB 隔离加注 → SB 跟注」然后翻牌 BB 下注的那一手，
 * 把 `toValidatorSnapshots` 产出的**精确**输入（含每条行动的真实 amountBB）打出来 ——
 * 用于写最小复现，避免手写金额再次踩 CALL 口径的坑。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { parsePhh } from '../src/domain/realHands/phh.ts';
import { toValidatorSnapshotsDetailed } from '../src/domain/realHands/phhToEngineInput.ts';
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { loadKnowledgeBase } from '../src/domain/knowledge/knowledgeLoader.ts';

const knowledge = loadKnowledgeBase();
if (!knowledge.ok) throw new Error('知识库加载失败');
const rules = knowledge.index.allRules();

const root = join(process.cwd(), 'third_party', 'phh-dataset');
let found = 0;

for (const d of readdirSync(root)) {
  const dir = join(root, d);
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    continue;
  }
  for (const f of files.filter((x) => x.endsWith('.phh'))) {
    const parsed = parsePhh(readFileSync(join(dir, f), 'utf8'));
    if (!parsed.ok) continue;
    const { snapshots } = toValidatorSnapshotsDetailed(parsed.hand);

    for (const snap of snapshots) {
      const pre = snap.input.actionHistory.filter((a) => a.street === 'PREFLOP');
      const shape = pre.map((a) => `${a.position}${a.type}`).join(' ');
      /* 目标形态：全员弃到 SB → SB 跟 → BB 加 → SB 跟 */
      if (shape !== 'UTGFOLD HJFOLD COFOLD BTNFOLD SBCALL BBRAISE SBCALL') continue;

      const r = analyzeManualHand(snap.input, { rules, writeLog: false, equitySeed: 1 });
      if (r.ok) continue;

      console.log(`\n文件 ${d}/${f}（hand=${parsed.hand.handId}）`);
      console.log(`失败 stage=${r.stage}`);
      for (const i of r.issues) console.log(`  ${i.code}: ${i.message}`);
      console.log(`\n我方=${snap.heroPosition} 手牌=${snap.input.heroCards.join('')} 牌面=${snap.input.board.join(' ')}`);
      console.log(`真实动作=${snap.realAction}`);
      console.log('精确 actionHistory（可直接粘进复现脚本）：');
      for (const a of snap.input.actionHistory) {
        console.log(
          `  { position: '${a.position}', type: '${a.type}', ` +
            `${a.amountBB === undefined ? '' : `amountBB: ${a.amountBB}, `}street: '${a.street}' },`,
        );
      }
      console.log(`seatStacksBB = ${JSON.stringify(snap.input.seatStacksBB)}`);
      console.log(`effectiveStackBB = ${snap.input.effectiveStackBB}`);
      console.log(`bigBlindBB = ${snap.input.bigBlindBB}  buttonPosition = ${snap.input.buttonPosition}`);

      found += 1;
      if (found >= 1) process.exit(0);
    }
  }
}
console.log('没有找到匹配的失败样本');
