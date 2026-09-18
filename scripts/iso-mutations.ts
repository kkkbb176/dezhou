/**
 * 变异测试（M1–M8）：把「修复」逐个改回坏版本，**测试必须变红**。
 *
 * 用法：E:\node.exe --experimental-strip-types scripts\iso-mutations.ts
 *
 * 纪律：
 * - 每个变异都是**精确字面替换**（找不到锚点即报错，不静默跳过）；
 * - 每个变异跑完立刻把文件恢复成原始字节，最后逐字节校验；
 * - 只跑目标测试文件（`test/multiLimpIsolation.test.ts`）。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const TARGET = 'test/multiLimpIsolation.test.ts';

type Mutation = { id: string; why: string; file: string; from: string; to: string };

const ENGINE = 'src/app/decision/decisionEngine.ts';
const CONTEXT = 'src/app/manualInput/contextBuilder.ts';
const MODEL = 'src/app/manualInput/limpIsolation.ts';

const ISO_USABLE =
  '      const isoUsable =\n' +
  '        iso !== null && isoEv !== null && raiseCandidate !== null && raiseCandidate.sizeChips === isoToChips;';

const MUTATIONS: readonly Mutation[] = [
  {
    id: 'M1',
    why: '隔离加注退回「EV 不可得的启发式」⇒ 又被清晰跟注证据拦住',
    file: ENGINE,
    from: ISO_USABLE,
    to: '      const isoUsable = false;',
  },
  {
    id: 'M2',
    why: '跛入范围退回任意两张（1225）⇒ 画像/位置进不了引擎主链',
    file: CONTEXT,
    from: '      weights = arrival.weights;',
    to: '      weights = bigBlindCheckWeights();',
  },
  {
    id: 'M3',
    why: '跟注站的跟注倾向被抹平（=普通原型）⇒ 类型不再影响响应',
    file: MODEL,
    from: 'CALLING_STATION: { width: 0.9, fold: 0.65, call: 1.35, reraise: 0.55 },',
    to: 'CALLING_STATION: { width: 0.9, fold: 0.65, call: 1.0, reraise: 0.55 },',
  },
  {
    id: 'M4',
    why: '尺寸忽略人数（永远按 1 家算）⇒ 3 家与 1 家同尺寸',
    file: MODEL,
    from: 'const raw = baseOpen + perLimper * input.limperCount + positionAdj + stickinessAdj + stackAdj;',
    to: 'const raw = baseOpen + perLimper * 1 + positionAdj + stickinessAdj + stackAdj;',
  },
  {
    id: 'M5',
    why: '拿**到达范围**权益去算加注 EV（§8 禁止的口径）',
    file: CONTEXT,
    from: '    equityVsOneCaller,\n    equityVsThreeCallers: equityVsMultiCallers,',
    to: '    equityVsOneCaller: args.equityVsArrival,\n    equityVsThreeCallers: equityVsMultiCallers,',
  },
  {
    id: 'M6',
    why: '身后玩家风险只写文案、不进 EV',
    file: MODEL,
    from: '  const playersBehindAdjustment = -input.playersBehind.cold3betRisk * raise;',
    to: '  const playersBehindAdjustment = 0;',
  },
  {
    id: 'M7',
    why: '把结果硬编码成「只有 K♠Q♠ 才给加注 EV」',
    file: ENGINE,
    from: ISO_USABLE,
    to:
      '      const isoUsable =\n' +
      "        iso !== null && isoEv !== null && raiseCandidate !== null && raiseCandidate.sizeChips === isoToChips && context.heroCards.join('') === 'KsQs';",
  },
  {
    id: 'M8',
    why: '被跟注时当作必胜（丢掉 eq 因子）⇒ 弱牌也能靠死钱加注',
    file: MODEL,
    from: '    eq === null ? null : eq * (pot + raise + k * input.callerAddsChips) - raise;',
    to: '    eq === null ? null : pot + raise + k * input.callerAddsChips - raise;',
  },
];

const originals = new Map<string, string>();
for (const file of new Set(MUTATIONS.map((m) => m.file))) {
  originals.set(file, readFileSync(file, 'utf8'));
}

let caught = 0;
try {
  for (const m of MUTATIONS) {
    const original = originals.get(m.file)!;
    if (!original.includes(m.from)) {
      console.log(`❌ ${m.id}：找不到锚点（${m.file}）—— 变异未执行，报告为**失败**`);
      continue;
    }
    const mutated = original.replace(m.from, m.to);
    writeFileSync(m.file, mutated, 'utf8');

    const run = spawnSync(process.execPath, ['--experimental-strip-types', '--test', TARGET], {
      encoding: 'utf8',
    });
    const out = `${run.stdout ?? ''}${run.stderr ?? ''}`;
    const failCount = Number(/ℹ fail (\d+)/.exec(out)?.[1] ?? 'NaN');
    const failed = run.status !== 0 && failCount > 0;
    console.log(
      `${failed ? '✅' : '❌'} ${m.id}：${m.why} —— 失败用例 ${Number.isNaN(failCount) ? '未知' : failCount} 个` +
        (failed ? '' : '（**测试没有变红 ⇒ 该缺陷无人看守**）'),
    );
    if (failed) {
      const names = out
        .split('\n')
        .filter((l) => l.startsWith('✖ ') && !l.includes('failing tests'))
        .map((l) => l.replace(/^✖ /, '').replace(/ \(.*$/, ''));
      console.log(`     捕获者：${[...new Set(names)].slice(0, 3).join('｜')}`);
      caught += 1;
    }
    writeFileSync(m.file, original, 'utf8');
  }
} finally {
  for (const [file, original] of originals) writeFileSync(file, original, 'utf8');
}

const intact = [...originals].every(([file, original]) => readFileSync(file, 'utf8') === original);
console.log(
  `\n变异捕获：${caught}/${MUTATIONS.length}｜源文件已恢复且逐字节一致：${intact ? '是' : '否（！手工检查）'}`,
);
