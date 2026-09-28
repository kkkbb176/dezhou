/*
 * 🔴 **真实牌局验证**：拿真实牌局跑引擎，看它答得对不对。
 *
 * ## 数据来源
 *
 * `third_party/phh-dataset/`（`github.com/uoftcprg/phh-dataset`，**MIT** 许可）
 * 的 Pluribus 子集：2019 年 Pluribus 与职业牌手打的 **6-max NLHE**，$50/$100，100BB。
 *
 * **为什么必须是这一份**：每手 6 个玩家的底牌都是已知的（`d dh pN XxYy`）。
 * 引擎要回答「这手怎么打」，只有在知道所有底牌时才能被检验 —— 否则连
 * 「他拿什么」都不知道，验不了。
 *
 * ## ⚠️ 引擎**只拿到 Hero 的底牌**（这是关键设计）
 *
 * 真实使用者手动录入时**只知道自己的牌**。因此送进引擎的 `heroCards`
 * 只有行动者的两张；对手底牌**只用于对照**（见下面的「对照」）。
 * 若把对手底牌喂给引擎，那验证的就是一个「开了上帝视角的引擎」——
 * 与实战无关。
 *
 * ## 三类检验，**严格分开报**（不许混成一句「准确率」）
 *
 * | 类别 | 判据 | 说明 |
 * |---|---|---|
 * | **合法性**（客观） | 引擎建议的动作在该节点是否合法、尺寸是否在 `[min, allIn]` 内 | 违反 ⇒ **确诊缺陷** |
 * | **一致性**（客观） | 引擎建议 vs **真实玩家实际动作** | 不同**不等于错** —— 真实玩家也会失误 |
 * | **结果对照**（客观） | 引擎建议弃牌的牌，摊牌时是否真的输了 | 只作参考，单次结果噪声极大 |
 *
 * ## 输出
 *
 * `reports/real-hand-validation-out.txt`：逐手明细 + 汇总统计。
 *
 * ## 用法
 *
 * ```powershell
 * node --experimental-strip-types scripts/validate-real-hands.ts --limit 200
 * ```
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { loadKnowledgeBase } from '../src/domain/knowledge/knowledgeLoader.ts';
import { parsePhh } from '../src/domain/realHands/phh.ts';
import { toValidatorSnapshotsDetailed, type ValidatorSnapshot } from '../src/domain/realHands/phhToEngineInput.ts';
import type { ManualHandInput } from '../src/app/manualInput/manualInput.ts';

const ROOT = process.cwd();
const DATA = join(ROOT, 'third_party', 'phh-dataset');
const OUT = join(ROOT, 'reports', 'real-hand-validation-out.txt');

type Args = { limit: number; dirs: string[] | null; verbose: boolean };

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (f: string): string | null => {
    const i = argv.indexOf(f);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1]! : null;
  };
  const dirs = get('--dirs');
  return {
    limit: Number(get('--limit') ?? '200'),
    dirs: dirs === null ? null : dirs.split(',').map((s) => s.trim()).filter((s) => s !== ''),
    verbose: argv.includes('--verbose'),
  };
}

function listFiles(args: Args): { dir: string; file: string }[] {
  if (!existsSync(DATA)) {
    throw new Error(`找不到 ${DATA} —— 先运行 npm run fetch:real-hands`);
  }
  const out: { dir: string; file: string }[] = [];
  for (const d of readdirSync(DATA)) {
    if (args.dirs !== null && !args.dirs.includes(d)) continue;
    const dir = join(DATA, d);
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of entries.filter((x) => x.endsWith('.phh')).sort((a, b) => Number(a.replace('.phh', '')) - Number(b.replace('.phh', '')))) {
      out.push({ dir: d, file: join(dir, f) });
    }
  }
  return out;
}

/* ============================================================
 * 汇总结构
 * ============================================================ */

type Tally = Map<string, number>;
const bump = (t: Tally, k: string): void => void t.set(k, (t.get(k) ?? 0) + 1);

const lines: string[] = [];
const say = (s = ''): void => {
  lines.push(s);
};

/* ============================================================
 * 主流程
 * ============================================================ */

const args = parseArgs();
const knowledge = loadKnowledgeBase();
if (!knowledge.ok) {
  throw new Error(
    `知识库加载失败（${knowledge.issues.length} 项）：\n` +
      knowledge.issues.map((i) => `  [${i.code}] ${i.subject}：${i.message}`).join('\n'),
  );
}
/*
 * ⚠️ `KnowledgeIndex` 不是「一个装着 rules 数组的对象」——
 * 它暴露的是 `allRules()` / `rulesFor(env, street)` 这类**方法**
 *（`knowledge.ts:389`）。第一版写成 `knowledge.index.rules`，
 * 运行时才炸 `rules is not iterable`（类型检查没拦住，因为 `AnalyzeOptions.rules`
 * 要的是数组，而我给了 `undefined` 后被 `as never` 之类的宽松处吞掉了）。
 */
const rules = knowledge.index.allRules();

const files = listFiles(args).slice(0, args.limit);
say('真实牌局验证 —— 引擎答案 vs 真实牌局');
say(`数据：${DATA}`);
say(`牌局数（本次）：${files.length}`);
say('');

const rejectByReason: Tally = new Map();
const engineByAction: Tally = new Map();
const agreementByStreet: Tally = new Map();
const agreementTotalByStreet: Tally = new Map();
const engineActionByRealAction: Tally = new Map();
const failuresByStage: Tally = new Map();
const failuresByCode: Tally = new Map();
/** 每个失败码下的**具体原因**样本（最多 5 条）—— 只统计码等于没诊断 */
const contextFailureDetail = new Map<string, Set<string>>();
/** 「节点未被产出」的原因（`ENGINE_CANNOT_REBUILD` 等）—— 这类必须暴露，不能静默丢 */
const skipByReason: Tally = new Map();
const skipDetail = new Map<string, Set<string>>();
/** 「引擎建议 vs 引擎自己的价值门槛」分桶：进攻 vs 被动 */
const worseByAction = new Map<string, { n: number; sum: number; below50: number; below25: number; noGate: number }>();
/** 「引擎动作 / 该动作下我是否落后 ｜ 理由码」→ 次数（回答**为什么**） */
const reasonByAction: Tally = new Map();
const sizingIllegal: string[] = [];
const illegalActionSamples: string[] = [];
const showdownContradictions: string[] = [];

let handsParsed = 0;
let handsWithSnapshot = 0;
let decisions = 0;
let decisionsActionable = 0;
let agreements = 0;
let totalMs = 0;

for (const { dir, file } of files) {
  const raw = readFileSync(file, 'utf8');
  const parsed = parsePhh(raw);
  if (!parsed.ok) {
    bump(rejectByReason, parsed.reason);
    continue;
  }
  handsParsed += 1;

  const detailed = toValidatorSnapshotsDetailed(parsed.hand);
  const snaps = detailed.snapshots;
  for (const s of detailed.skipped) {
    bump(skipByReason, s.reason);
    const bucket = skipDetail.get(s.reason) ?? new Set<string>();
    if (bucket.size < 6) bucket.add(s.detail.slice(0, 200));
    skipDetail.set(s.reason, bucket);
  }
  if (snaps.length === 0) {
    bump(rejectByReason, detailed.skipped.length > 0 ? 'ALL_SNAPSHOTS_SKIPPED' : 'NO_DECISION_POINT');
    continue;
  }
  handsWithSnapshot += 1;

  const tag = `${dir}/${file.slice(file.lastIndexOf('\\') + 1)}`;

  for (const snap of snaps) {
    decisions += 1;
    const t0 = Date.now();
    const result = analyzeManualHand(snap.input, {
      rules,
      writeLog: false,
      equitySeed: 1,
    });
    totalMs += Date.now() - t0;

    if (!result.ok) {
      bump(failuresByStage, result.stage);
      for (const i of result.issues) {
        bump(failuresByCode, i.code);
        /*
         * 失败**具体原因**要单独收一份：只统计 `code` 会看到
         * 「40 次 CONTEXT_BUILD_FAILED」而不知道到底哪里建不起来。
         *
         * ⚠️ 还要带上**翻前形态**：同一个错误码在不同形态下是完全不同的问题
         *（跛入池 / 有人加注后跟注 / 单加注 …），不带形态就无法归因。
         */
        const preflopShape = snap.input.actionHistory
          .filter((a) => a.street === 'PREFLOP')
          .map((a) => `${a.position}${a.type}`)
          .join(' ');
        const key = `${i.code} ｜ 翻前[${preflopShape}] ｜ 街=${snap.street} 我=${snap.heroPosition}`;
        const bucket = contextFailureDetail.get(i.code) ?? new Set<string>();
        if (bucket.size < 8) bucket.add(`${i.message.slice(0, 120)} ｜ 翻前[${preflopShape}] 街=${snap.street} 我=${snap.heroPosition}`);
        contextFailureDetail.set(i.code, bucket);
        void key;
      }
      continue;
    }

    const engineAction = result.decision.action;
    if (engineAction === null || !result.decision.actionable) {
      bump(engineByAction, 'NOT_ACTIONABLE');
      continue;
    }
    decisionsActionable += 1;
    bump(engineByAction, engineAction);

    /* ---- ① 合法性（客观）---- */
    const legal = snap.legal;
    const isLegalAction = legal.actions.includes(engineAction);
    if (!isLegalAction) {
      if (illegalActionSamples.length < 25) {
        illegalActionSamples.push(
          `${tag} ${parsed.hand.handId} ${snap.street} 位置=${snap.heroPosition} ` +
            `引擎=${engineAction} 合法=${legal.actions.join('/')}`,
        );
      }
      bump(failuresByCode, 'ENGINE_ACTION_NOT_LEGAL');
    }
    if ((engineAction === 'BET' || engineAction === 'RAISE') && result.decision.sizeChips !== undefined) {
      const size = result.decision.sizeChips;
      /* `minTo`/`allInTo` 已在快照里换算成 BB，因此这里也用 BB 比 */
      const sizeBB = result.decision.sizeBB ?? size / snap.input.bigBlindBB!;
      if (sizeBB < snap.legal.minToBB - 1e-6 || sizeBB > snap.legal.allInToBB + 1e-6) {
        if (sizingIllegal.length < 25) {
          sizingIllegal.push(
            `${tag} ${parsed.hand.handId} ${snap.street} ${engineAction} 尺寸=${sizeBB.toFixed(3)}BB ` +
              `合法区间=[${snap.legal.minToBB.toFixed(3)}, ${snap.legal.allInToBB.toFixed(3)}]BB`,
          );
        }
        bump(failuresByCode, 'ENGINE_SIZE_OUT_OF_RANGE');
      }
    }

    /* ---- ② 一致性（客观，但「不同」≠「错」）---- */
    const streetKey = snap.street;
    agreementTotalByStreet.set(streetKey, (agreementTotalByStreet.get(streetKey) ?? 0) + 1);
    const realAction = snap.realAction;
    bump(engineActionByRealAction, `${realAction} → ${engineAction}`);
    const same =
      engineAction === realAction ||
      /* CHECK 与「面对下注为 0 时的 CALL」在引擎里是两件事，真实记录里也是两件事，
         这里**不**做等价折算 —— 折算会把「引擎让我过牌、他下注了」这种真实分歧抹平 */
      false;
    if (same) {
      agreements += 1;
      agreementByStreet.set(streetKey, (agreementByStreet.get(streetKey) ?? 0) + 1);
    }

    /* ---- ②b 引擎**自己的**价值门槛：它是在什么牌力上下注的？---- */
    /*
     * `VALUE_GATE` 理由里带「对手范围与我的牌逐组合比较：更差 X% / 更好 Y%」。
     * 把它抽出来按动作分桶 —— 这能回答一个客观问题：
     * **引擎的 BET 里，有多少是在「对手范围多数比我好」时下的？**
     * 这不是「与真人不同」，这是引擎**自己**的数字自相矛盾。
     */
    const gate = result.decision.reasons.find((x) => x.code === 'VALUE_GATE' && /更差/.test(x.textZh ?? ''));
    const m = gate === undefined ? null : /更差\s*([\d.]+)%\s*\/\s*更好\s*([\d.]+)%/.exec(gate.textZh ?? '');
    {
      const bucket = engineAction === 'BET' || engineAction === 'RAISE' ? 'AGGRESSIVE' : 'PASSIVE';
      const t = worseByAction.get(bucket) ?? { n: 0, sum: 0, below50: 0, below25: 0, noGate: 0 };
      if (m === null) {
        t.noGate += 1;
      } else {
        const worse = Number(m[1]);
        t.n += 1;
        t.sum += worse;
        if (worse < 50) t.below50 += 1;
        if (worse < 25) t.below25 += 1;
      }
      worseByAction.set(bucket, t);

      /*
       * 理由分布按「引擎动作 × 该动作下是否落后」拆开。
       * 这样能回答**为什么**：它是在报「价值」还是在报「诈唬 / 弃牌权益」？
       */
      const behind = m === null ? '无门槛' : Number(m[1]) < 50 ? '落后' : '领先';
      for (const reason of result.decision.reasons) {
        const key = `${engineAction}/${behind} ｜ ${reason.code}`;
        reasonByAction.set(key, (reasonByAction.get(key) ?? 0) + 1);
      }
    }

    /* ---- ③ 结果对照（只做参考）---- */
    if (showdownContradictions.length < 25 && engineAction === 'FOLD' && snap.showdownWon === true) {
      showdownContradictions.push(
        `${tag} ${parsed.hand.handId} ${snap.street} 位置=${snap.heroPosition} ` +
          `底牌=${snap.input.heroCards.join('')} 牌面=${snap.input.board.join(' ')} —— ` +
          '引擎建议弃牌，但摊牌是**赢**的（单次结果噪声大，仅供参考）',
      );
    }

    if (args.verbose) {
      say(
        `  ${tag} ${snap.street} ${snap.heroPosition} ${snap.input.heroCards.join('')} ` +
          `| 引擎=${engineAction}${result.decision.sizeBB !== undefined ? ` ${result.decision.sizeBB.toFixed(2)}BB` : ''} ` +
          `| 真实=${realAction}`,
      );
    }
  }
}

/* ============================================================
 * 报告
 * ============================================================ */

const pct = (n: number, d: number): string => (d === 0 ? '—' : `${((n / d) * 100).toFixed(1)}%`);

say('='.repeat(72));
say('① 解析');
say('='.repeat(72));
say(`读过文件          ${files.length}`);
say(`成功解析          ${handsParsed}`);
say(`含可验证决策点    ${handsWithSnapshot}`);
for (const [k, v] of [...rejectByReason].sort((a, b) => b[1] - a[1])) say(`  排除 ${k.padEnd(24)} ${v}`);
if (skipByReason.size > 0) {
  say('');
  say('被跳过的决策节点（**不是**「本来不该问」，而是重放/重建失败）：');
  for (const [k, v] of [...skipByReason].sort((a, b) => b[1] - a[1])) {
    say(`  ${k.padEnd(24)} ${v}`);
    for (const d of skipDetail.get(k) ?? []) say(`       · ${d}`);
  }
}

say('');
say('='.repeat(72));
say('② 决策规模');
say('='.repeat(72));
say(`决策点总数        ${decisions}`);
say(`引擎给出可执行建议 ${decisionsActionable}（${pct(decisionsActionable, decisions)}）`);
say(`平均单次耗时      ${decisions === 0 ? '—' : `${(totalMs / decisions).toFixed(1)}ms`}`);
say('');
say('引擎建议分布：');
for (const [k, v] of [...engineByAction].sort((a, b) => b[1] - a[1])) say(`  ${k.padEnd(20)} ${v}`);

say('');
say('='.repeat(72));
say('③ 客观检验：合法性（违反 = 确诊缺陷）');
say('='.repeat(72));
say(`动作不被该节点允许  ${failuresByCode.get('ENGINE_ACTION_NOT_LEGAL') ?? 0}`);
say(`尺寸越界            ${failuresByCode.get('ENGINE_SIZE_OUT_OF_RANGE') ?? 0}`);
if (illegalActionSamples.length > 0) {
  say('');
  say('样本（最多 25 条）：');
  for (const s of illegalActionSamples) say(`  ✖ ${s}`);
}
if (sizingIllegal.length > 0) {
  say('');
  say('尺寸越界样本（最多 25 条）：');
  for (const s of sizingIllegal) say(`  ✖ ${s}`);
}
if (failuresByStage.size > 0) {
  say('');
  say('引擎**未能给出建议**的阶段：');
  for (const [k, v] of [...failuresByStage].sort((a, b) => b[1] - a[1])) say(`  ${k.padEnd(20)} ${v}`);
  say('  细分原因：');
  for (const [k, v] of [...failuresByCode].sort((a, b) => b[1] - a[1])) {
    if (k === 'ENGINE_ACTION_NOT_LEGAL' || k === 'ENGINE_SIZE_OUT_OF_RANGE') continue;
    say(`    ${k.padEnd(34)} ${v}`);
    for (const detail of contextFailureDetail.get(k) ?? []) say(`         · ${detail}`);
  }
}

say('');
say('='.repeat(72));
say('③b 引擎**自己的价值门槛**（不是与真人比，是它自己两个模块之间是否自洽）');
say('='.repeat(72));
say('「更差 X%」= 对手范围里比我这手更差的组合占比（引擎 VALUE_GATE 自己算的）');
say('');
say('动作      样本    更差%均值   更差<50%（我落后）      更差<25%（我明显落后）   无门槛字段');
for (const [k, v] of [...worseByAction].sort()) {
  say(
    `${k.padEnd(10)} ${String(v.n).padStart(4)}   ${(v.n === 0 ? 0 : v.sum / v.n).toFixed(1).padStart(8)}%   ` +
      `${String(v.below50).padStart(5)} (${pct(v.below50, v.n).padStart(6)})   ` +
      `${String(v.below25).padStart(5)} (${pct(v.below25, v.n).padStart(6)})   ` +
      `${String(v.noGate).padStart(5)}`,
  );
}

say('');
say('「引擎为什么这么打」—— 动作 × 落后与否 ｜ 理由码（前 24 条）');
for (const [k, v] of [...reasonByAction].sort((a, b) => b[1] - a[1]).slice(0, 24)) {
  say(`  ${k.padEnd(52)} ${v}`);
}

say('');
say('='.repeat(72));
say('④ 对照：引擎建议 vs 真实玩家动作（**不同 ≠ 错**）');
say('='.repeat(72));
say(`完全一致          ${agreements} / ${decisionsActionable} = ${pct(agreements, decisionsActionable)}`);
say('');
say('分街道：');
for (const [k, v] of [...agreementTotalByStreet].sort()) {
  const hit = agreementByStreet.get(k) ?? 0;
  say(`  ${k.padEnd(10)} ${String(hit).padStart(4)} / ${String(v).padStart(4)} = ${pct(hit, v)}`);
}
say('');
say('真实动作 → 引擎建议（前 20 种组合）：');
for (const [k, v] of [...engineActionByRealAction].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
  say(`  ${k.padEnd(34)} ${v}`);
}

say('');
say('='.repeat(72));
say('⑤ 结果对照（仅参考 —— 单次结果噪声极大）');
say('='.repeat(72));
if (showdownContradictions.length === 0) {
  say('无「引擎建议弃牌、摊牌却赢」的样本。');
} else {
  say(`样本 ${showdownContradictions.length} 条（最多 25 条）：`);
  for (const s of showdownContradictions) say(`  • ${s}`);
}

writeFileSync(OUT, lines.join('\n') + '\n', 'utf8');
console.log(lines.join('\n'));
console.log(`\n已写入 ${OUT}`);
