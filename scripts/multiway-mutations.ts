/**
 * 变异测试（M1–M8）：MULTIWAY POSTFLOP RESPONSE TREE —— 每个变异必须让测试变红。
 *
 * 用法：E:\node.exe --experimental-strip-types scripts\multiway-mutations.ts
 *
 * 纪律与 `iso-mutations.ts` 相同：精确字面替换（找不到锚点即失败）、
 * 跑完立刻还原、末尾逐字节校验。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const TARGET = 'test/multiwayBetResponse.test.ts';
const RESPONSE = 'src/domain/postflop/betResponse.ts';
const CONTEXT = 'src/app/manualInput/contextBuilder.ts';

type Mutation = { id: string; why: string; file: string; from: string; to: string };

const MUTATIONS: readonly Mutation[] = [
  {
    id: 'M1',
    why: 'allFold 改成「平均弃牌率」',
    file: RESPONSE,
    from: '  const allFold = product((x) => x.fold);',
    to:
      '  const allFold =\n' +
      '    list.reduce((acc, x) => acc + x.fold, 0) / Math.max(1, list.length);',
  },
  {
    id: 'M2',
    why: '多人 EV 由 primary opponent 一个人决定（其余对手不参与）',
    file: CONTEXT,
    from: '      const shares: OpponentResponseShares[] = perOpponent.map((p) => {',
    to:
      '      const shares: OpponentResponseShares[] = perOpponent.slice(0, 1).map((p) => {',
  },
  {
    id: 'M3',
    why: '两个对手共用同一份响应对象（第二个直接抄第一个）',
    file: CONTEXT,
    from: '      for (const [index, p] of perOpponent.entries()) {\n        const size = p.model!.sizes[sizeIndex]!;',
    to:
      '      for (const [index, p] of perOpponent.entries()) {\n' +
      '        const size = perOpponent[0]!.model!.sizes[sizeIndex]!;',
  },
  {
    id: 'M4',
    why: 'BOTH_CALL 权益改成两次单挑权益的平均',
    file: CONTEXT,
    from: '      const allCallEquity = rangeEquityOfMany(input.heroHole, input.board, callEntrySets, input.seed + 613).value;',
    to:
      '      const allCallEquity = (() => {\n' +
      '        const vals = Object.values(equityByCallerId).filter((v): v is number => v !== null);\n' +
      '        return vals.length === 0 ? null : vals.reduce((a, b) => a + b, 0) / vals.length;\n' +
      '      })();',
  },
  {
    id: 'M5',
    why: '忽略 ANY_RAISE 分支（概率质量凭空消失）',
    file: RESPONSE,
    from: '  states.push({\n    kind: JointStateKind.ANY_RAISE,',
    to: '  if (false) states.push({\n    kind: JointStateKind.ANY_RAISE,',
  },
  {
    id: 'M6',
    why: 'Hero 下注成本在每个分支重复扣两次',
    file: RESPONSE,
    from: '    const ev = eq === null ? null : eq * resultingPot - bet;',
    to: '    const ev = eq === null ? null : eq * resultingPot - 2 * bet;',
  },
  {
    id: 'M7',
    why: 'MEDIUM / LARGE 共用同一份响应（三个尺寸都按最小尺寸的价格分类）',
    file: RESPONSE,
    from: '        cardsToCome,\n        ratioToPot,\n        priceRequiredEquity,',
    to:
      '        cardsToCome,\n' +
      '        ratioToPot: BET_SIZE_SPECS[0]!.ratioToPot,\n' +
      '        priceRequiredEquity:\n' +
      '          BET_SIZE_SPECS[0]!.ratioToPot / (1 + 2 * BET_SIZE_SPECS[0]!.ratioToPot),',
  },
  {
    id: 'M8',
    why: '逐座位画像不再影响**他自己**的响应（全部回落到中立先验）',
    file: CONTEXT,
    from: '        tendencies: responseTendenciesOf(o.dimensions, o.confidence),',
    to: '        tendencies: responseTendenciesOf(null, 0),',
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
      console.log(`❌ ${m.id}：找不到锚点（${m.file}）—— 变异未执行，记为**失败**`);
      continue;
    }
    writeFileSync(m.file, original.replace(m.from, m.to), 'utf8');
    const run = spawnSync(process.execPath, ['--experimental-strip-types', '--test', TARGET], {
      encoding: 'utf8',
    });
    const out = `${run.stdout ?? ''}${run.stderr ?? ''}`;
    const failCount = Number(/ℹ fail (\d+)/.exec(out)?.[1] ?? 'NaN');
    const failed = run.status !== 0 && failCount > 0;
    console.log(
      `${failed ? '✅' : '❌'} ${m.id}：${m.why} —— 失败用例 ${Number.isNaN(failCount) ? '未知（可能编译失败）' : failCount} 个` +
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
