/**
 * `VS_3BET` 几何真实联调（Phase 1.1 第二轮）
 *
 * ## 这份探针要回答的唯一问题
 *
 * 「Hero 开池 → 有人 3Bet → 一圈人弃牌 → 行动回到 Hero」这条几何，
 * **在真实求解器里到底走到谁手上**？
 *
 * 这个几何被实测推翻过**五次**。最后一次（第五版）的探针结果全部落在
 * 「开池者」身上，而这个现象本身就是答案：
 *
 * > 「最后一个加注者不会被再次叫到」（`next_state_of` 的 `needs` 公式），
 * > 所以行动回到的**总是开池者** —— Hero 必须是开池者。
 *
 * ## 断言
 *
 * 对每个 `(桌型, Hero=开池者, 3Bettor)` 组合真的走一遍路径，并要求
 * 求解器给出的行动者**逐位等于 Hero**。Provider 的 `walkToHero` 已经
 * 内建了这个断言（不等就报不可用），本脚本把结果落成证据文件。
 *
 * 同时打印菜单 —— 因为「菜单是否完整」正是 `VS_3BET` 在目录里
 * 仍标未支持的理由。
 *
 * 用法：
 *   node --experimental-strip-types scripts/gto-vs3bet-live-probe.ts [size...]
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  buildGtoScenario,
  describeScenarioZh,
  legalThreeBettorsFor,
  scenarioHashOf,
} from '../src/domain/gto/gtoScenario.ts';
import {
  GtoScenarioKind,
  gtoPositionsFor,
  type GtoTableSize,
} from '../src/domain/gto/gto.types.ts';
import {
  GTOPEN_DEFAULT_BUDGET,
  GtopenProvider,
} from '../src/domain/gto/providers/gtopenProvider.ts';
import { GtoHttpClient } from '../src/domain/gto/providers/gtopenHttpClient.ts';
import { formatFrequencyPercent } from '../src/domain/gto/gtopenHandMatrix.ts';

import {
  GtoExtendedTemplate,
  extendedCatalogForTableSize,
} from '../src/app/gto/gtoExtendedScenarios.ts';

const EVIDENCE_DIR = fileURLToPath(new URL('../reports/evidence/', import.meta.url));
mkdirSync(EVIDENCE_DIR, { recursive: true });
const EVIDENCE_FILE = `${EVIDENCE_DIR}gto-vs3bet-live-evidence.txt`;

const lines: string[] = [];
function emit(line: string): void {
  console.log(line);
  lines.push(line);
  writeFileSync(EVIDENCE_FILE, `${lines.join('\n')}\n`, 'utf8');
}

const baseUrl = process.env['GTOPEN_URL'] ?? 'http://127.0.0.1:3737';
const provider = new GtopenProvider({
  baseUrl,
  client: new GtoHttpClient({ baseUrl }),
  budget: {
    ...GTOPEN_DEFAULT_BUDGET,
    solveWaitMs: Number(process.env['GTO_WAIT_MS'] ?? 1_200_000),
  },
});

const requested = process.argv.slice(2).map(Number) as GtoTableSize[];
const sizes: GtoTableSize[] = requested.length > 0 ? requested : [4, 5, 6, 8, 9];

emit('================================================================');
emit('GTO「Hero 开池后面对 3Bet」几何真实联调（Phase 1.1 第二轮）');
emit(`生成时间 : ${new Date().toISOString()}`);
emit(`端点     : ${baseUrl}`);
emit('断言     : 走到路径终点时的行动者必须**逐位等于 Hero**');
emit('================================================================');
emit('');

type Row = {
  id: string;
  status: string;
  detail: string;
  seconds: number;
  menu: string;
  complete: string;
};
const rows: Row[] = [];

const SHOW_HANDS = ['AA', 'AKs', 'AKo', 'A5s', 'KQs', '22', '72o'];

for (const size of sizes) {
  emit(`──────── ${size} 人桌（${gtoPositionsFor(size).join(' → ')}）────────`);
  /*
   * 目标来自**目录**（而不是本地再枚举一遍位置）：
   * 目录已经按实测结论把「走不到 Hero 的位置」排除掉了，
   * 这里要验证的正是「目录里列出来的那些组合真的能走到 Hero」。
   */
  const targets = extendedCatalogForTableSize(size).filter(
    (e) => e.template === GtoExtendedTemplate.VS_3BET,
  );
  if (targets.length === 0) emit('  （本桌型没有可构造的「开池后面对 3Bet」组合）');
  for (const entry of targets) {
    const threeBettor = entry.id.split('-').pop() as GtoPosition;
    const heroPosition = entry.heroPosition;
    const scenario = buildGtoScenario({
      kind: GtoScenarioKind.VS_3BET,
      tableSize: size,
      effectiveStackBB: 100,
      heroPosition,
      villainPosition: threeBettor,
      openSizeBB: 2.5,
    });
    const id = entry.id;
    if (scenario === null) {
      emit(`  [${id}] ⛔ 场景构造失败`);
      rows.push({ id, status: '⛔', detail: '场景构造失败', seconds: 0, menu: '—', complete: '—' });
      continue;
    }
    const pathText = scenario.actionHistory
      .map((a) => `${a.position}${a.kind === 'FOLD' ? '弃' : `加${a.sizeBB}`}`)
      .join(' → ');
    emit(`  [${entry.labelZh}] ${pathText}`);

    const t0 = Date.now();
    const result = await provider.lookupScenario(scenario);
    const seconds = (Date.now() - t0) / 1000;

      if ('status' in result) {
        emit(`      ❌ 不可用（${result.cause}）：${result.message}`);
        rows.push({
          id,
          status: `❌ ${result.cause}`,
          detail: result.message,
          seconds,
          menu: '—',
          complete: '—',
        });
        emit('');
        continue;
      }

      const meta = result.metadata;
      const menu = result.range.actionMenu
        .map((a) => `${a.kind}${a.sizeBB === null ? '' : `@${a.sizeBB}`}`)
        .join(' · ');
      /*
       * 「菜单是否完整」= 有没有一个**再加注/全下**的选项。
       * 面对 3Bet 时如果只剩 Fold / Call，这个节点就是残缺的 ——
       * 那正是它被标未支持的理由。这里把它算出来当成证据，
       * 而不是靠人眼看。
       */
      const raiseLike = result.range.actionMenu.filter(
        (a) => a.kind === 'RAISE' || a.kind === 'ALL_IN' || a.kind === 'BET',
      );
      const complete = raiseLike.length > 0 ? `完整（${raiseLike.length} 个加注项）` : '残缺（无加注项）';

      emit(`      ✅ ${seconds.toFixed(1)} 秒 · 行动者 ${result.range.actorPosition}（= Hero）`);
      emit(`         场景：${describeScenarioZh(scenario)}`);
      emit(`         哈希 ${scenarioHashOf(scenario)} · heroAlreadyActed ${String(scenario.heroAlreadyActed)}`);
      emit(`         菜单：${menu}`);
      emit(`         菜单完整性：${complete}`);
      emit(
        `         迭代 ${meta.solveSettings.iterationsCompleted} / 请求 ${meta.solveSettings.iterationsRequested} · ` +
          `gap ${meta.solveSettings.reportedGap === null ? '未测' : meta.solveSettings.reportedGap.toFixed(8)} · ` +
          `状态 ${meta.solveStatus}`,
      );
      for (const code of SHOW_HANDS) {
        const hand = result.range.hands.find((h) => h.hand === code);
        if (hand === undefined) continue;
        emit(
          `           ${code.padEnd(4)} ` +
            hand.actions
              .map(
                (a) =>
                  `${a.kind}${a.sizeBB === null ? '' : `@${a.sizeBB}`}=${formatFrequencyPercent(a.frequency)}`,
              )
              .join('  '),
        );
      }
      const mixed = result.range.hands.filter((h) => h.actions.length >= 2).length;
      emit(`         169 类里混合策略 ${mixed} 个`);
      rows.push({
        id,
        status: '✅',
        detail: `行动者 ${result.range.actorPosition}`,
        seconds,
        menu,
        complete,
      });
      emit('');
  }
}

emit('================================================================');
emit('汇总');
emit('----------------------------------------------------------------');
for (const row of rows) {
  emit(
    `${row.status} ${row.id.padEnd(28)} ${row.seconds.toFixed(1).padStart(7)}s  ` +
      `${row.detail.padEnd(18)} ${row.complete}`,
  );
}
emit('----------------------------------------------------------------');
const ok = rows.filter((r) => r.status === '✅');
const completeCount = rows.filter((r) => r.complete.startsWith('完整')).length;
emit(`成功 ${ok.length} / 共 ${rows.length}`);
emit(`其中菜单完整（有再加注项）${completeCount} 条 · 残缺 ${ok.length - completeCount} 条`);
emit(`证据文件: ${EVIDENCE_FILE}`);
emit('================================================================');
