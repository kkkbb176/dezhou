/*
 * 只**建缓存**：把真实牌局的全部决策点 + 配对信息落成 JSON。
 *
 * 为什么不复用 `ablate-fold-model.ts`：那个会对每个配置跑完整扫描（几十分钟）。
 * 本脚本只做一次解析，给所有扫描脚本共用。
 *
 * 缓存路径：`scripts/tmp-ablation/snapshots.json`（已被 `.gitignore` 的 `scripts/tmp-*` 覆盖）。
 *
 * ⚠️ 只读第三方数据，不写任何生产文件。
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { parsePhh } from '../src/domain/realHands/phh.ts';
import { toValidatorSnapshotsDetailed } from '../src/domain/realHands/phhToEngineInput.ts';

const ROOT = process.cwd();
const DATA = join(ROOT, 'third_party', 'phh-dataset');
const CACHE_DIR = join(ROOT, 'scripts', 'tmp-ablation');
const CACHE = join(CACHE_DIR, 'snapshots.json');

mkdirSync(CACHE_DIR, { recursive: true });

const out: unknown[] = [];
let files = 0;
let hands = 0;

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
    files += 1;
    const snaps = toValidatorSnapshotsDetailed(parsed.hand).snapshots;
    if (snaps.length === 0) continue;
    hands += 1;
    for (let i = 0; i < snaps.length; i += 1) {
      const s = snaps[i]!;
      /* 配对：同一手里、**之后第一个不是该行动者**的动作 = 对手对我这一注的响应 */
      const later = snaps.slice(i + 1).find((x) => x.heroName !== s.heroName);
      out.push({
        input: s.input,
        street: s.street,
        heroName: s.heroName,
        heroPosition: s.heroPosition,
        realAction: s.realAction,
        responseAction: later?.realAction ?? 'NONE',
        responseStreet: later?.street ?? 'NONE',
        opponentCards: s.opponentCards,
        tag: `${d}/${f} ${s.street} ${s.heroPosition}`,
      });
    }
  }
}

writeFileSync(CACHE, JSON.stringify(out), 'utf8');
console.log(`从 ${files} 个文件 / ${hands} 手牌缓存 ${out.length} 个决策点`);
console.log(`→ ${CACHE}`);
