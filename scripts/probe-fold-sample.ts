/*
 * 验证一个**结构性**问题：真实牌局里，「人弃牌」之后还存在可观测的响应吗？
 *
 * 怀疑：`phh` 只记录**实际发生的行动**。一手牌里只要有人弃牌，
 * 接下来的动作就是**别人**的 —— 那个弃牌的人**再也不会出现**。
 * 因此「引擎预测他会弃牌 X%，而实际他弃了没有」这个问题，
 * 在这份数据上**从根上就构造不出样本**：我们能观测到「他弃了」的那些节点，
 * 恰恰是**引擎已经建议了下注之后**他做的响应，而那时他面对的是**我的下注**——
 * 也就是引擎预测的那个尺寸。
 *
 * 等等 —— 如果真的是这样，那「realAction === 'FOLD'」**应该**存在。
 * 直接数出来。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { parsePhh } from '../src/domain/realHands/phh.ts';
import { toValidatorSnapshotsDetailed } from '../src/domain/realHands/phhToEngineInput.ts';

const ROOT = join(process.cwd(), 'third_party', 'phh-dataset');

const tally = new Map<string, number>();
let total = 0;
/** 按街道分别统计 FOLD 节点是否存在 */
const byStreet = new Map<string, Map<string, number>>();

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
    const { snapshots } = toValidatorSnapshotsDetailed(parsed.hand);
    for (const s of snapshots) {
      total += 1;
      tally.set(s.realAction, (tally.get(s.realAction) ?? 0) + 1);
      const m = byStreet.get(s.street) ?? new Map<string, number>();
      m.set(s.realAction, (m.get(s.realAction) ?? 0) + 1);
      byStreet.set(s.street, m);
    }
  }
}

console.log(`决策点总数 ${total}`);
console.log('\n按真实动作：');
for (const [k, v] of [...tally].sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(8)} ${v}`);
console.log('\n按街道 × 真实动作：');
for (const [street, m] of [...byStreet].sort()) {
  console.log(`  ${street}: ${[...m].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join('  ')}`);
}

/* 再看：翻前 FA 节点里 realAction=FOLD 的有多少（对照） */
console.log('\n结论用：上面若 FOLD 只出现在 PREFLOP —— 那说明翻后的「人弃牌」节点确实存在但很少');
