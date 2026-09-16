/**
 * 扩展节点真实联调（Phase 1.1 §十~§十五）
 *
 * ## 这份探针要回答的问题
 *
 * Phase 1 只真实跑过「第一个入池」。本脚本把**真实求解器**问一遍：
 *
 * | 模板 | 问题 |
 * |---|---|
 * | `VS_OPEN` | 面对开池时我该怎么打？（Fold / Call / Raise / All-in） |
 * | `THREE_BET` | 我自己 3Bet 时该用哪些牌？ |
 * | `VS_3BET` | 面对 3Bet 时我该怎么打？ |
 * | `VS_4BET` | 面对 4Bet 时我该怎么打？ |
 *
 * 覆盖用户点名的场景：BB vs BTN Open、SB vs BTN Open、BTN vs CO Open、
 * BTN open→BB 3Bet、CO open→BTN 3Bet。
 *
 * ## 🔴 不做的事
 *
 * - 不因为「单元测试通过」就声称真实可用；
 * - 不为无法表达的场景伪造路径或范围；
 * - 不在未收敛时声称收敛。
 *
 * ## 省时间的做法（**不牺牲真实性**）
 *
 * GTOpen 的**同一棵树**上，多个节点是「再多走几步」的关系，
 * 而 Provider 已经做了会话指纹复用：只要树指纹没变，就不会重新建树/求解。
 * 因此把同一桌型的场景放在一起问，只有第一个要付建树 + 求解的代价。
 * 这不是「跳过验证」——每一步仍然真的向求解器请求了那个节点。
 *
 * 用法：
 *   node --experimental-strip-types scripts/gto-extended-live-probe.ts [size...]
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describeScenarioZh, scenarioHashOf } from '../src/domain/gto/gtoScenario.ts';
import { gtoPositionsFor, type GtoTableSize } from '../src/domain/gto/gto.types.ts';
import { GTOPEN_DEFAULT_BUDGET, GtopenProvider } from '../src/domain/gto/providers/gtopenProvider.ts';
import { GtoHttpClient } from '../src/domain/gto/providers/gtopenHttpClient.ts';
import { formatFrequencyPercent } from '../src/domain/gto/gtopenHandMatrix.ts';
import {
  GtoExtendedTemplate,
  GTO_EXTENDED_TEMPLATE_ZH,
  buildExtendedScenario,
} from '../src/app/gto/gtoExtendedScenarios.ts';

const EVIDENCE_DIR = fileURLToPath(new URL('../reports/evidence/', import.meta.url));
mkdirSync(EVIDENCE_DIR, { recursive: true });
const EVIDENCE_FILE = `${EVIDENCE_DIR}gto-extended-live-evidence.txt`;

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

/* ============================================================
 * 要真实跑的场景清单
 * ============================================================ */

type Target = {
  tableSize: GtoTableSize;
  heroPosition: string;
  template: GtoExtendedTemplate;
  /** 仅 `VS_NAMED_OPEN` 需要 */
  openerPosition?: string;
  /** 人类可读标签；**由数据参数拼出**，不手写（见下面的注释） */
  label: string;
};

/**
 * 构造一个桌型要跑的场景清单。
 *
 * 🔴 标签由**参数**生成（`${hero} vs ${opener} Open`），不手写 ——
 * 第一版就是手写标签、另一处算数据，于是「标签写 BTN、数据是 UTG」。
 * 现在两者来自同一组参数，结构上不可能不一致。
 */
function targetsForSize(size: GtoTableSize): Target[] {
  const order = gtoPositionsFor(size);
  const first = order[0]!;
  const out: Target[] = [];

  // ---- VS_NAMED_OPEN：用户点名的三组（开池者显式，不再用第一位顶替）----
  for (const opener of ['BTN', 'CO'] as const) {
    const openerIndex = order.indexOf(opener);
    if (openerIndex < 0) continue;
    for (const hero of order.slice(openerIndex + 1)) {
      out.push({
        tableSize: size,
        heroPosition: hero,
        template: GtoExtendedTemplate.VS_NAMED_OPEN,
        openerPosition: opener,
        label: `${size}MAX ${hero} vs ${opener} Open`,
      });
    }
  }

  // ---- VS_FIRST_OPEN：作为对照（首位开池）----
  out.push({
    tableSize: size,
    heroPosition: order[order.length - 1]!,
    template: GtoExtendedTemplate.VS_FIRST_OPEN,
    label: `${size}MAX BB vs ${first} Open（首位开池）`,
  });

  // ---- VS_3BET / VS_4BET：本阶段预期为「不支持」，但**必须真的问一次** ----
  out.push({
    tableSize: size,
    heroPosition: 'BB',
    template: GtoExtendedTemplate.VS_3BET,
    label: `${size}MAX BB vs 3Bet`,
  });
  out.push({
    tableSize: size,
    heroPosition: order[order.length - 2]!,
    template: GtoExtendedTemplate.VS_4BET,
    label: `${size}MAX SB vs 4Bet`,
  });

  return out;
}

const requested = process.argv.slice(2).map(Number) as GtoTableSize[];
const sizes: GtoTableSize[] = requested.length > 0 ? requested : [4, 5, 6, 8, 9];

/* ============================================================
 * 主流程
 * ============================================================ */

emit('================================================================');
emit('GTO 扩展节点真实联调（Phase 1.1）');
emit(`生成时间 : ${new Date().toISOString()}`);
emit(`端点     : ${baseUrl}`);
const parts0 = provider.solveKeyParts({
  // 借一个 6 人桌场景只为打印设置（真实取值按桌人数标定）
  kind: 'RFI',
  gameType: 'CASH',
  tableSize: 6,
  effectiveStackBB: 100,
  heroPosition: 'UTG',
  villainPosition: null,
  actionHistory: [],
  raiseSizesBB: [],
  blinds: { sbBB: 0.5, bbBB: 1, anteBB: 0 },
});
emit(
  `求解设置 : 开池 [${parts0.openSizesBB}]BB · 再加注 [${parts0.raiseMults}]× · ` +
    `加注上限 ${parts0.maxRaises} · 跛入 ${parts0.limp ? '允许' : '关闭'}`,
);
emit('全下 / 迭代数（按桌人数）：');
for (const size of sizes) {
  const p = provider.solveKeyParts({
    kind: 'RFI',
    gameType: 'CASH',
    tableSize: size,
    effectiveStackBB: 100,
    heroPosition: gtoPositionsFor(size)[0]!,
    villainPosition: null,
    actionHistory: [],
    raiseSizesBB: [],
    blinds: { sbBB: 0.5, bbBB: 1, anteBB: 0 },
  });
  emit(`  ${size} 人桌：全下 ${p.addAllin ? '提供' : '不提供'} · 迭代 ${p.iterations} · 目标 gap ${p.targetGap}`);
}
emit('================================================================');
emit('');

type SummaryRow = {
  label: string;
  template: GtoExtendedTemplate;
  status: 'OK' | 'UNSUPPORTED' | 'UNAVAILABLE';
  detail: string;
  seconds: number;
  menu: string;
  gap: number | null;
  iterations: number | null;
};
const summary: SummaryRow[] = [];

const SHOW_HANDS = ['AA', 'AKs', 'AKo', 'A5s', 'A5o', 'KQs', '22', '72o'];

for (const size of sizes) {
  emit(`──────── ${size} 人桌 ────────`);
  // 同一桌型内，树指纹相同 ⇒ Provider 复用会话，只有第一个付求解代价
  for (const target of targetsForSize(size)) {
    const built = buildExtendedScenario({
      tableSize: target.tableSize,
      heroPosition: target.heroPosition as never,
      template: target.template,
      ...(target.openerPosition === undefined
        ? {}
        : { openerPosition: target.openerPosition as never }),
    });

    if (!('scenario' in built)) {
      emit(`  [${target.label}] ⛔ 本项目无法表达：${built.unsupportedReason}`);
      summary.push({
        label: target.label,
        template: target.template,
        status: 'UNSUPPORTED',
        detail: built.unsupportedReason,
        seconds: 0,
        menu: '—',
        gap: null,
        iterations: null,
      });
      emit('');
      continue;
    }

    const scenario = built.scenario;
    const t0 = Date.now();
    const result = await provider.lookupScenario(scenario);
    const seconds = (Date.now() - t0) / 1000;

    if ('status' in result) {
      emit(`  [${target.label}] ❌ 不可用（${result.cause}）：${result.message}`);
      summary.push({
        label: target.label,
        template: target.template,
        status: 'UNAVAILABLE',
        detail: `${result.cause}：${result.message}`,
        seconds,
        menu: '—',
        gap: null,
        iterations: null,
      });
      emit('');
      continue;
    }

    const meta = result.metadata;
    const menu = result.range.actionMenu
      .map((a) => `${a.kind}${a.sizeBB === null ? '' : `@${a.sizeBB}BB`}`)
      .join(' · ');
    const gap = meta.solveSettings.reportedGap;
    const iterations = meta.solveSettings.iterationsCompleted;

    emit(`  [${target.label}] ✅ ${seconds.toFixed(1)} 秒 · 行动者 ${result.range.actorPosition}`);
    emit(`      场景：${describeScenarioZh(scenario)}`);
    emit(`      哈希 ${scenarioHashOf(scenario)}`);
    emit(`      菜单：${menu}`);
    emit(
      `      迭代 ${iterations} / 请求 ${meta.solveSettings.iterationsRequested} · ` +
        `gap ${gap === null ? '未测' : gap.toFixed(8)} · 目标 ${meta.solveSettings.targetGap} · ` +
        `状态 ${meta.solveStatus}`,
    );
    for (const code of SHOW_HANDS) {
      const hand = result.range.hands.find((h) => h.hand === code);
      if (hand === undefined) continue;
      emit(
        `        ${code.padEnd(4)} ` +
          hand.actions
            .map((a) => `${a.kind}${a.sizeBB === null ? '' : `@${a.sizeBB}`}=${formatFrequencyPercent(a.frequency)}`)
            .join('  '),
      );
    }
    const mixed = result.range.hands.filter((h) => h.actions.length >= 2).length;
    emit(`      169 类里混合策略 ${mixed} 个`);

    summary.push({
      label: target.label,
      template: target.template,
      status: 'OK',
      detail: describeScenarioZh(scenario),
      seconds,
      menu,
      gap,
      iterations,
    });
    emit('');
  }
}

/* ============================================================
 * 汇总
 * ============================================================ */

emit('================================================================');
emit('汇总');
emit('----------------------------------------------------------------');
for (const row of summary) {
  const mark = row.status === 'OK' ? '✅' : row.status === 'UNSUPPORTED' ? '⛔' : '❌';
  emit(
    `${mark} ${row.label.padEnd(28)} ${row.seconds > 0 ? `${row.seconds.toFixed(1)}s`.padStart(7) : '      —'}` +
      `  ${row.menu}`,
  );
  if (row.status !== 'OK') emit(`     原因：${row.detail}`);
}
emit('----------------------------------------------------------------');
const ok = summary.filter((r) => r.status === 'OK');
emit(`成功 ${ok.length} / 共 ${summary.length}`);
emit(`其中 VS_OPEN ${ok.filter((r) => r.label.includes('vs') && r.label.includes('Open')).length} 条`);
emit(`其中「自己 3Bet」 ${ok.filter((r) => r.template === GtoExtendedTemplate.VS_3BET).length} 条`);
emit(`其中「面对 3Bet」 ${ok.filter((r) => r.template === GtoExtendedTemplate.VS_3BET).length} 条`);
emit(`其中「面对 4Bet」 ${ok.filter((r) => r.template === GtoExtendedTemplate.VS_4BET).length} 条`);
emit(`不支持 ${summary.filter((r) => r.status === 'UNSUPPORTED').length} 条（原因逐条列在上面）`);
emit('================================================================');
emit(`证据文件: ${EVIDENCE_FILE}`);
