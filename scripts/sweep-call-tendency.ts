/*
 * 🔴 **扫描「爱跟」系数的强度**：能不能靠它把弃牌率偏差压下去？
 *
 * ## 为什么这条路和前三次失败不同
 *
 * 前三次都在**改判据的形状**（把牌面代理换成权益），三次都失败。
 * 这一条改的是**一个既有环境系数的强度**：
 *
 * ```text
 * env.low.calling-tendency-up  LOW_STAKES_ONLINE  ANY  CALL_WEIGHT  INCREASE   ← 知识库已有
 * callScale = 1 + COEF × passive − 0.18 × tight                              ← COEF 默认 0.30
 * ```
 *
 * 即「把一条已有方向规则放到它应有的强度」，**不是**发明新常数。
 *
 * ## 判据（写死，避免事后解释）
 *
 * | 指标 | 期望 |
 * |---|---|
 * | 校准绝对误差（预测弃牌率 vs 实际） | **下降** |
 * | 引擎建议进攻占比 | 向真人靠拢（真人约 25–30%） |
 * | river 校准 | **不显著变差**（river 本来准） |
 * | 与真人一致率 | 对照用，不作为判据 |
 *
 * ## 实现
 *
 * 每个系数起一个干净子进程（环境变量在模块加载时读取），
 * 子进程跑 `calibrate-real-hands` 的同一套统计并输出 JSON。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const CHILD = join(ROOT, 'scripts', 'sweep-call-child.ts');
const CACHE = join(ROOT, 'scripts', 'tmp-ablation', 'snapshots.json');

if (!existsSync(CACHE)) {
  console.error(`缺少缓存 ${CACHE} —— 先跑一次 scripts/ablate-fold-model.ts 生成`);
  process.exit(1);
}

type ChildRow = {
  action: string | null;
  foldLikelihood: number | null;
  street: string;
  responseAction: string;
  realAction: string;
};
type ChildOut = { coef: number; rows: ChildRow[] };

/** 扫描的系数值。0.30 = 生产现值（对照组） */
const COEFS: readonly number[] = [0.0, 0.3, 0.6, 0.9, 1.2];

const results: { coef: number; rows: ChildRow[] }[] = [];

for (const coef of COEFS) {
  process.stdout.write(`系数 ${coef.toFixed(2)} … `);
  const r = spawnSync(process.execPath, ['--experimental-strip-types', CHILD], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, DSH_CALL_TENDENCY_COEF: String(coef) },
  });
  if (r.status !== 0) {
    console.log(`失败\n${r.stdout ?? ''}\n${r.stderr ?? ''}`);
    process.exit(1);
  }
  const out = JSON.parse(r.stdout!.trim().split('\n').pop()!) as ChildOut;
  results.push({ coef, rows: out.rows });
  console.log(`${out.rows.length} 行`);
}

/* ============================================================
 * 汇总
 * ============================================================ */

const lines: string[] = [];
const say = (s = ''): void => void lines.push(s);

say('扫描「爱跟」系数：能不能靠它把弃牌率偏差压下去？');
say('='.repeat(88));
say('系数 = `callScale = 1 + 系数 × passive − 0.18 × tight` 里的那个系数。');
say('知识库依据：`env.low.calling-tendency-up`（LOW_STAKES_ONLINE / CALL_WEIGHT / INCREASE）。');
say('生产现值 = **0.30**（即下面的对照组）。');
say('');
say('系数    建议分布 BET/CHECK/CALL/FOLD/RAISE      校准误差   进攻占比   与真人一致率');
say('-'.repeat(88));

for (const { coef, rows } of results) {
  const dist = new Map<string, number>();
  for (const row of rows) dist.set(row.action ?? 'NONE', (dist.get(row.action ?? 'NONE') ?? 0) + 1);
  const distText = ['BET', 'CHECK', 'CALL', 'FOLD', 'RAISE']
    .map((a) => `${a}:${String(dist.get(a) ?? 0).padStart(4)}`)
    .join(' ');

  /* 校准：只在「引擎建议 BET/RAISE」的节点上，与配对响应比对 */
  let n = 0;
  let predSum = 0;
  let folds = 0;
  for (const row of rows) {
    if (row.action !== 'BET' && row.action !== 'RAISE') continue;
    if (row.foldLikelihood === null) continue;
    if (row.responseAction === 'NONE') continue;
    n += 1;
    predSum += row.foldLikelihood;
    if (row.responseAction === 'FOLD') folds += 1;
  }
  const pred = n === 0 ? 0 : predSum / n;
  const act = n === 0 ? 0 : folds / n;
  const err = Math.abs(pred - act) * 100;

  /* 进攻占比 */
  const aggressive = (dist.get('BET') ?? 0) + (dist.get('RAISE') ?? 0);
  const total = [...dist.values()].reduce((a, b) => a + b, 0);
  const aggrShare = total === 0 ? 0 : aggressive / total;

  /* 与真人一致率（对照） */
  let hit = 0;
  let hn = 0;
  for (const row of rows) {
    if (row.action === null) continue;
    hn += 1;
    if (row.action === row.realAction) hit += 1;
  }

  say(
    `${coef.toFixed(2).padStart(4)}    ${distText}   ` +
      `${err.toFixed(1).padStart(6)}pp   ${(aggrShare * 100).toFixed(1).padStart(6)}%   ` +
      `${((hit / Math.max(1, hn)) * 100).toFixed(1).padStart(8)}%`,
  );
}

say('');
say('='.repeat(88));
say('按街的校准误差（看 river 有没有被弄坏）');
say('='.repeat(88));
say('系数    FLOP 预测/实际         TURN 预测/实际         RIVER 预测/实际');
for (const { coef, rows } of results) {
  const cells: string[] = [];
  for (const st of ['FLOP', 'TURN', 'RIVER']) {
    let n = 0;
    let ps = 0;
    let f = 0;
    for (const row of rows) {
      if (row.street !== st) continue;
      if (row.action !== 'BET' && row.action !== 'RAISE') continue;
      if (row.foldLikelihood === null || row.responseAction === 'NONE') continue;
      n += 1;
      ps += row.foldLikelihood;
      if (row.responseAction === 'FOLD') f += 1;
    }
    cells.push(
      n === 0
        ? '—'
        : `${((ps / n) * 100).toFixed(1)}% / ${((f / n) * 100).toFixed(1)}%`.padEnd(20),
    );
  }
  say(`${coef.toFixed(2).padStart(4)}    ${cells.join('  ')}`);
}

say('');
say('='.repeat(88));
say('怎么读');
say('='.repeat(88));
say('· 校准误差**随系数下降** ⇒ 这条路有效，且能直接读出该用哪个值。');
say('· 误差在某处**触底不再降** ⇒ 剩下的部分是结构性的（必须换层解决，不是调系数）。');
say('· river 的「预测/实际」若随系数明显变差 ⇒ 这条调整**伤到了本来准的街**，不可取。');
say('· ⚠️ 系数是**放大一条既有方向规则**，不是新策略常数；但放大多少仍是一个工程选择，');
say('  它的依据是**校准误差**（可测），不是"看起来对"。');

writeFileSync(join(ROOT, 'reports', 'call-tendency-sweep-out.txt'), lines.join('\n') + '\n', 'utf8');
console.log('\n' + lines.join('\n'));
