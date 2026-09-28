/* 直接数：交叉表「引擎建议动作 × 真实动作」。不推断，只计数。 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { loadKnowledgeBase } from '../src/domain/knowledge/knowledgeLoader.ts';
import { parsePhh } from '../src/domain/realHands/phh.ts';
import { toValidatorSnapshotsDetailed } from '../src/domain/realHands/phhToEngineInput.ts';

const rules = loadKnowledgeBaseOrThrowRules();
function loadKnowledgeBaseOrThrowRules() {
  const k = loadKnowledgeBase();
  if (!k.ok) throw new Error('知识库加载失败');
  return k.index.allRules();
}

const ROOT = join(process.cwd(), 'third_party', 'phh-dataset');
const cross = new Map<string, Map<string, number>>();

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
    for (const snap of toValidatorSnapshotsDetailed(parsed.hand).snapshots) {
      const r = analyzeManualHand(snap.input, { rules, writeLog: false, equitySeed: 1 });
      const engineAction = r.ok ? (r.decision.action ?? 'NONE') : 'FAILED';
      const m = cross.get(engineAction) ?? new Map<string, number>();
      m.set(snap.realAction, (m.get(snap.realAction) ?? 0) + 1);
      cross.set(engineAction, m);
    }
  }
}

const reals = ['CHECK', 'CALL', 'RAISE', 'FOLD'];
console.log('引擎建议 \\ 真实动作      ' + reals.map((x) => x.padStart(7)).join('') + '    合计');
console.log('-'.repeat(60));
for (const [engineAction, m] of [...cross].sort()) {
  const total = [...m.values()].reduce((a, b) => a + b, 0);
  console.log(
    engineAction.padEnd(22) + reals.map((x) => String(m.get(x) ?? 0).padStart(7)).join('') + String(total).padStart(8),
  );
}
