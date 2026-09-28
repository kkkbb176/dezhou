/*
 * 🔴 **对抗模拟：弃牌率缺陷到底要不要紧？**
 *
 * ## 要回答的问题
 *
 * 我已经证明「引擎预测的弃牌率 74.8% vs 实际 18.2%」（732 个配对样本）。
 * 但**证明不了**「引擎因此打错了牌」—— 预测错了不等于决策错了：
 * 若把弃牌率改对，引擎的答案**根本不变**，那这条缺陷就不值得动大手术。
 *
 * ## 所以本脚本量三件事
 *
 * | 指标 | 回答什么 |
 * |---|---|
 * | **改答案比例**（argmax flip rate） | 修正弃牌率后，**多少决策的动作变了** —— 这是"要不要紧"的直接判据 |
 * | **校准改善** | 修正后预测与实际是否更接近 |
 * | **与真人的一致率** | 修正后更像真人还是更不像（**不是**准确率，只是对照） |
 *
 * ## 为什么要 spawn 子进程
 *
 * `betResponse.ts` 的三个常数在**模块加载时**读取环境变量（生产默认值逐位不变）。
 * 要在一轮里扫多个配置，只能每个配置起一个干净的进程。
 *
 * ## 用法
 *
 * ```powershell
 * node --experimental-strip-types scripts/ablate-fold-model.ts
 * ```
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { parsePhh } from '../src/domain/realHands/phh.ts';
import { toValidatorSnapshotsDetailed } from '../src/domain/realHands/phhToEngineInput.ts';

const ROOT = process.cwd();
const DATA = join(ROOT, 'third_party', 'phh-dataset');
const CACHE_DIR = join(ROOT, 'scripts', 'tmp-ablation');
const CACHE = join(CACHE_DIR, 'snapshots.json');
const CHILD = join(ROOT, 'scripts', 'ablate-child.ts');

/* ============================================================
 * ① 准备：把「真实决策点 + 配对信息」缓存下来（父进程只做一次）
 * ============================================================ */

type CachedSnap = {
  /** 送进引擎的输入（**只有行动者自己的底牌**） */
  input: unknown;
  street: string;
  heroName: string;
  heroPosition: string;
  realAction: string;
  /** 配对到的「对手响应」（同一手里、之后第一个不是该行动者） */
  responseAction: string;
  responseStreet: string;
  /** 对手真实底牌（**仅供报告对照**） */
  opponentCards: Readonly<Record<string, string>>;
  tag: string;
};

function buildCache(): CachedSnap[] {
  if (existsSync(CACHE)) {
    console.log(`复用缓存 ${CACHE}`);
    return JSON.parse(readFileSync(CACHE, 'utf8')) as CachedSnap[];
  }
  mkdirSync(CACHE_DIR, { recursive: true });
  const out: CachedSnap[] = [];
  let files = 0;
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
      for (let i = 0; i < snaps.length; i += 1) {
        const s = snaps[i]!;
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
  console.log(`从 ${files} 个文件缓存 ${out.length} 个决策点 → ${CACHE}`);
  return out;
}

/* ============================================================
 * ② 配置
 * ============================================================ */

type Config = { name: string; strong: number; weak: number; none: number };

const CONFIGS: readonly Config[] = [
  /* 生产当前值 */
  { name: 'A 生产（0.14/0.09/0.06）', strong: 0.14, weak: 0.09, none: 0.06 },
  /* 关闭待发牌权益 ⇒ 回到修复前的模型（用来标定"改动本身"的影响） */
  { name: 'B 归零（= 修复前模型）', strong: 0, weak: 0, none: 0 },
  /* 向上推：看"把弃牌率压下来"要付多大代价 */
  { name: 'C 中等（0.25/0.17/0.12）', strong: 0.25, weak: 0.17, none: 0.12 },
  /* 上限探测用过的极端值 */
  { name: 'D 极端（0.45/0.30/0.25）', strong: 0.45, weak: 0.30, none: 0.25 },
];

/* ============================================================
 * ③ 每个配置起一个干净子进程
 * ============================================================ */

const snaps = buildCache();

type ChildRow = {
  index: number;
  action: string | null;
  sizeBB: number | null;
  foldLikelihood: number | null;
  actionable: boolean;
};
type ChildOut = { config: string; rows: ChildRow[] };

const results: { config: Config; rows: ChildRow[] }[] = [];

for (const cfg of CONFIGS) {
  process.stdout.write(`跑配置 ${cfg.name} … `);
  const r = spawnSync(
    process.execPath,
    ['--experimental-strip-types', CHILD],
    {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      env: {
        ...process.env,
        DSH_LIVE_EQUITY_STRONG: String(cfg.strong),
        DSH_LIVE_EQUITY_WEAK: String(cfg.weak),
        DSH_LIVE_EQUITY_NONE: String(cfg.none),
      },
    },
  );
  if (r.status !== 0) {
    console.log(`失败\n${r.stdout ?? ''}\n${r.stderr ?? ''}`);
    process.exit(1);
  }
  const parsedOut = JSON.parse(r.stdout!.trim().split('\n').pop()!) as ChildOut;
  results.push({ config: cfg, rows: parsedOut.rows });
  console.log(`${parsedOut.rows.length} 行`);
}

/* ============================================================
 * ④ 汇总
 * ============================================================ */

const lines: string[] = [];
const say = (s = ''): void => void lines.push(s);
const pct = (n: number, d: number): string => (d === 0 ? '—' : `${((n / d) * 100).toFixed(1)}%`);

say('对抗模拟：修正弃牌率模型后，引擎的答案会变多少？');
say('='.repeat(84));
say(`决策点 ${snaps.length}（来自 455 手真实牌局，$50/$100 6-max）`);
say('');
say('配置                 建议动作分布（BET/RAISE/CHECK/CALL/FOLD）        与生产**不同**的动作数   改答案比例');
say('-'.repeat(84));

const base = results.find((r) => r.config.name.startsWith('A'))!;
const actionKey = (row: ChildRow): string =>
  `${row.action ?? 'NONE'}|${row.sizeBB === null ? '-' : row.sizeBB.toFixed(3)}`;

for (const { config, rows } of results) {
  const dist = new Map<string, number>();
  for (const row of rows) dist.set(row.action ?? 'NONE', (dist.get(row.action ?? 'NONE') ?? 0) + 1);
  const distText = ['BET', 'RAISE', 'CHECK', 'CALL', 'FOLD']
    .map((a) => `${a}:${String(dist.get(a) ?? 0).padStart(4)}`)
    .join(' ');
  /* 「改答案」= 动作或尺寸与生产不同 */
  let changed = 0;
  let changedAction = 0;
  for (let i = 0; i < rows.length; i += 1) {
    const a = rows[i]!;
    const b = base.rows[i]!;
    if (actionKey(a) !== actionKey(b)) changed += 1;
    if ((a.action ?? 'NONE') !== (b.action ?? 'NONE')) changedAction += 1;
  }
  say(
    `${config.name.padEnd(22)}${distText}   ${String(changed).padStart(6)}（其中动作类 ${changedAction}）`.padEnd(40) +
      `   ${pct(changed, rows.length)}`,
  );
}

/* ---- 校准：每个配置的预测弃牌率 vs 实际 ---- */
say('');
say('='.repeat(84));
say('校准：只在「引擎建议 BET/RAISE」的节点上，与配对到的对手实际响应比对');
say('='.repeat(84));
say('配置                  样本   预测弃牌率   实际弃牌率   绝对误差');
say('-'.repeat(84));
for (const { config, rows } of results) {
  let n = 0;
  let predSum = 0;
  let folds = 0;
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]!;
    if (row.action !== 'BET' && row.action !== 'RAISE') continue;
    if (row.foldLikelihood === null) continue;
    const resp = snaps[i]!.responseAction;
    if (resp === 'NONE') continue;
    n += 1;
    predSum += row.foldLikelihood;
    if (resp === 'FOLD') folds += 1;
  }
  const pred = n === 0 ? 0 : predSum / n;
  const act = n === 0 ? 0 : folds / n;
  say(
    `${config.name.padEnd(22)}${String(n).padStart(5)}   ${(pred * 100).toFixed(1).padStart(8)}%   ` +
      `${(act * 100).toFixed(1).padStart(9)}%   ${(Math.abs(pred - act) * 100).toFixed(1).padStart(7)}pp`,
  );
}

/* ---- 与真人的一致率（对照，不是准确率） ---- */
say('');
say('='.repeat(84));
say('与真人一致率（**对照用，不是准确率** —— 真人也会错）');
say('='.repeat(84));
for (const { config, rows } of results) {
  let hit = 0;
  let n = 0;
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]!;
    if (row.action === null) continue;
    n += 1;
    if (row.action === snaps[i]!.realAction) hit += 1;
  }
  say(`${config.name.padEnd(22)}${String(hit).padStart(5)} / ${String(n).padStart(5)} = ${pct(hit, n)}`);
}

say('');
say('='.repeat(84));
say('怎么读');
say('='.repeat(84));
say('· **改答案比例低**（例如 <10%）⇒ 这条缺陷对引擎的**输出**影响很小，不值得动大手术。');
say('· **改答案比例高**（例如 >30%）⇒ 弃牌率假设直接决定引擎给什么建议，必须修。');
say('· 配置 B（归零）= **修复前模型** ⇒ B 与 A 的差异 = **我这次改动本身**的影响。');
say('· ⚠️ 本模拟**不含对抗最优策略搜索**：它量的是「引擎自己的答案有多依赖这个参数」，');
say('  不是「修正后能赢多少」。后者需要完整的对抗博弈模拟，本轮未做。');

writeFileSync(join(ROOT, 'reports', 'fold-model-ablation-out.txt'), lines.join('\n') + '\n', 'utf8');
console.log('\n' + lines.join('\n'));
