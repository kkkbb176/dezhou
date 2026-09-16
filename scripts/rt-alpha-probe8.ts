/**
 * rt-alpha-probe8 —— 攻击 10F（HTTP 与引擎逐字段一致）+ 攻击 11C（UI 文案与引擎阈值）
 *                    + 攻击 8I（3bet 场景的对手范围被当成开池范围）
 */

import { Position, Street } from '../src/domain/types.ts';
import { startAlphaServer } from '../src/app/webServer.ts';
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import { computeEquity } from '../src/domain/poker/equity.ts';
import { parseCardCode } from '../src/app/manualInput/manualInput.ts';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ManualHandInput } from '../src/app/manualInput/manualInput.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();

function hr(title: string): void {
  console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
}
function sortKeys(v: unknown): unknown {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(sortKeys);
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v as Record<string, unknown>).sort()) {
    out[k] = sortKeys((v as Record<string, unknown>)[k]);
  }
  return out;
}

/* ============================================================
 * 攻击 10F：HTTP /api/analyze vs 直接调引擎
 * ============================================================ */

const FLOP: ManualHandInput = {
  tableSize: 6,
  heroPosition: Position.CO,
  heroCards: ['As', 'Kd'],
  board: ['Kh', '7c', '2d'],
  street: Street.FLOP,
  effectiveStackBB: 100,
  actionHistory: [
    { position: Position.UTG, type: 'FOLD' },
    { position: Position.HJ, type: 'FOLD' },
    { position: Position.CO, type: 'RAISE', amountBB: 3 },
    { position: Position.BTN, type: 'FOLD' },
    { position: Position.SB, type: 'FOLD' },
    { position: Position.BB, type: 'CALL', amountBB: 2 },
    { position: Position.BB, type: 'CHECK', street: Street.FLOP },
  ],
  environment: 'MID_LOW_STAKES',
  villain: { quickProfile: 'NORMAL', dynamicHint: 'UNKNOWN' },
};

const THREE_WAY: ManualHandInput = {
  tableSize: 6,
  heroPosition: Position.BB,
  heroCards: ['As', 'Kd'],
  board: [],
  street: Street.PREFLOP,
  effectiveStackBB: 100,
  actionHistory: [
    { position: Position.UTG, type: 'RAISE', amountBB: 3 },
    { position: Position.HJ, type: 'CALL', amountBB: 3 },
    { position: Position.CO, type: 'FOLD' },
    { position: Position.BTN, type: 'FOLD' },
    { position: Position.SB, type: 'FOLD' },
  ],
  environment: 'MID_LOW_STAKES',
};

const ILLEGAL: ManualHandInput = {
  ...FLOP,
  heroCards: ['7d', '8c'],
  board: ['7d', 'Ks', '2h'],
};

async function runHttpComparison(): Promise<void> {
  hr('攻击 10F：HTTP /api/analyze 与直接调引擎是否逐字段一致');

  // 5173 上可能已有用户在跑的实例，这里用一个独立端口，避免干扰
  const server = await startAlphaServer({ port: 0, logPath: null, rules: RULES });
  console.log(`  服务器地址 = ${server.url}`);

  const post = async (body: unknown): Promise<{ status: number; json: unknown }> => {
    const res = await fetch(`${server.url}/api/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  };

  try {
    // ---- 用例 1：合法翻牌 ----
    {
      const http = await post({ input: FLOP });
      const direct = analyzeManualHand(FLOP, { rules: RULES, asOf: 1_757_000_000_000, writeLog: false });
      const p = http.json as Record<string, unknown>;
      console.log(`\n  用例1（合法翻牌）HTTP ${http.status} ok=${String(p['ok'])}`);
      if (direct.ok) {
        const vmSame = deepEqual(p['viewModel'], direct.viewModel);
        console.log(`     viewModel 与直接调用逐字段一致：${vmSame ? '✔' : '✘'}`);
        if (!vmSame) {
          const a = JSON.stringify(sortKeys(p['viewModel']));
          const b = JSON.stringify(sortKeys(direct.viewModel));
          let i = 0;
          while (i < a.length && i < b.length && a[i] === b[i]) i++;
          console.log(`       首个不同位置 ${i}：`);
          console.log(`         HTTP   …${a.slice(Math.max(0, i - 80), i + 120)}`);
          console.log(`         引擎   …${b.slice(Math.max(0, i - 80), i + 120)}`);
        }
        const dec = p['decision'] as Record<string, unknown>;
        console.log(`     decision 精简字段：${JSON.stringify(dec)}`);
        console.log(`     引擎 action=${direct.decision.action} size=${String(direct.decision.sizeChips)} ` +
          `conf=${direct.decision.confidence} band=${direct.decision.band} cls=${direct.decision.classification} actionable=${direct.decision.actionable}`);
        console.log(`     decision 是否覆盖引擎全部字段：` +
          `${['action', 'sizeChips', 'confidence', 'band', 'classification', 'actionable'].every((k) => k in dec) ? '✔（6 项）' : '✘'}`);
        console.log(`     meta = ${JSON.stringify(p['meta'])}`);
      }
    }

    // ---- 用例 2：多人池（信息不足）----
    {
      const http = await post({ input: THREE_WAY });
      const p = http.json as Record<string, unknown>;
      console.log(`\n  用例2（三人池）HTTP ${http.status} ok=${String(p['ok'])}`);
      console.log(`     **decision 字段 = ${JSON.stringify(p['decision'])}**`);
      console.log(`     viewModel.actionZh = ${JSON.stringify((p['viewModel'] as Record<string, unknown>)?.['actionZh'])}`);
      console.log(`     viewModel.warningsZh[0] = ${JSON.stringify(((p['viewModel'] as Record<string, unknown>)?.['warningsZh'] as string[])?.[0])}`);
    }

    // ---- 用例 3：非法输入 ----
    {
      const http = await post({ input: ILLEGAL });
      const p = http.json as Record<string, unknown>;
      console.log(`\n  用例3（重复牌）HTTP ${http.status} ok=${String(p['ok'])} stage=${String(p['stage'])}`);
      console.log(`     issues = ${JSON.stringify(p['issues'])}`);
    }

    // ---- 用例 4：协议错误 ----
    for (const [label, body] of [
      ['缺少 input', { foo: 1 }],
      ['input 是 null', { input: null }],
      ['input 是字符串', { input: 'x' }],
      ['完全空的 input 对象', { input: {} }],
      ['多余字段（result / winner）', { input: { ...FLOP, result: 'LOSS', winner: 'villain', heroProfit: -100 } }],
    ] as const) {
      let status = 0;
      let json: unknown = null;
      try {
        const r = await post(body);
        status = r.status;
        json = r.json;
      } catch (e) {
        json = { error: String(e) };
      }
      const p = json as Record<string, unknown>;
      console.log(
        `\n  用例4（${label}）HTTP ${status} ok=${String(p?.['ok'])} stage=${String(p?.['stage'])} ` +
          `issues=${JSON.stringify(p?.['issues'])?.slice(0, 200)}`,
      );
      if (p?.['ok'] === true) {
        const dec = p['decision'] as Record<string, unknown>;
        console.log(`     动作=${String(dec?.['action'])} size=${String(dec?.['sizeChips'])}`);
      }
    }

    // ---- 用例 5：坏 JSON ----
    {
      const res = await fetch(`${server.url}/api/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{ not json',
      });
      console.log(`\n  用例5（坏 JSON）HTTP ${res.status} ${JSON.stringify(await res.json())}`);
    }

    // ---- 用例 6：GET 其它路由 ----
    for (const path of ['/', '/api/health', '/api/nope']) {
      const res = await fetch(`${server.url}${path}`);
      const ct = res.headers.get('content-type');
      console.log(`  用例6 GET ${path.padEnd(12)} HTTP ${res.status} content-type=${ct}`);
    }
  } finally {
    await server.close();
    console.log('\n  服务器已关闭');
  }
}

/* ============================================================
 * 攻击 11C：UI 文案与引擎阈值
 * ============================================================ */

function runUiTextVsEngine(): void {
  hr('攻击 11C：UI 声明「只支持单挑」vs 引擎实际阈值（2 名活跃对手）');

  const html = readFileSync(fileURLToPath(new URL('../src/app/web/index.html', import.meta.url)), 'utf8');
  const claims = html
    .split('\n')
    .map((l, i) => ({ i: i + 1, l: l.trim() }))
    .filter((x) => /单挑|多人/.test(x.l));
  for (const c of claims) console.log(`  index.html:${c.i}  ${c.l}`);

  const r = analyzeManualHand(THREE_WAY, { rules: RULES, asOf: 1_757_000_000_000, writeLog: false });
  if (r.ok) {
    console.log(`\n  三人池实际：actionable=${r.decision.actionable} 分类=${r.decision.classification} ` +
      `范围针对=1 位对手（${r.decision.diagnostics.range?.opponentPositionZh}）`);
    console.log(`  → 引擎在「2 名活跃对手」时会给出动作建议（与 UI 声称的「只支持单挑」不符）`);
  } else {
    console.log(`  三人池被阻断：${r.stage}`);
  }
}

/* ============================================================
 * 攻击 8I：3bet 场景的对手范围
 * ============================================================ */

function runThreeBetRange(): void {
  hr('攻击 8I：BB 3bet 的对手范围被当成「开池范围」—— 权益被抬高多少？');

  const threeBet: ManualHandInput = {
    tableSize: 6,
    heroPosition: Position.CO,
    heroCards: ['As', 'Kd'],
    board: [],
    street: Street.PREFLOP,
    effectiveStackBB: 100,
    actionHistory: [
      { position: Position.UTG, type: 'FOLD' },
      { position: Position.HJ, type: 'FOLD' },
      { position: Position.CO, type: 'RAISE', amountBB: 3 },
      { position: Position.BTN, type: 'FOLD' },
      { position: Position.SB, type: 'FOLD' },
      { position: Position.BB, type: 'RAISE', amountBB: 10 },
    ],
    environment: 'MID_LOW_STAKES',
  };

  const r = analyzeManualHand(threeBet, { rules: RULES, asOf: 1_757_000_000_000, writeLog: false });
  if (!r.ok) {
    console.log(`  阻断(${r.stage}) ${JSON.stringify(r.issues)}`);
    return;
  }
  const range = r.decision.diagnostics.range!;
  console.log(`  引擎：范围针对「${range.opponentPositionZh}」`);
  console.log(`     来源说明 = ${range.sourceDescription}`);
  console.log(`     组合数 = ${range.supportSize}（占 1326 的 ${(range.supportShare * 100).toFixed(1)}%）`);
  console.log(`     权益 = ${r.decision.diagnostics.math.heroEquity?.toFixed(4)}  动作 = ${r.decision.action}`);

  // 对照：用「真正的 3bet 范围」（QQ+/AK 量级）手算权益
  const hero = [parseCardCode('As')!, parseCardCode('Kd')!];
  const tight3bet: readonly (readonly [ReturnType<typeof parseCardCode>, ReturnType<typeof parseCardCode>])[] = [
    ['Qh', 'Qc'], ['Qh', 'Qd'], ['Qs', 'Qc'], ['Qs', 'Qd'], ['Qc', 'Qd'],
    ['Kh', 'Kc'], ['Kh', 'Kd'], ['Ks', 'Kc'],
    ['Ah', 'Ac'], ['Ah', 'Ad'], ['As', 'Ac'],
    ['Ah', 'Ks'], ['Ah', 'Kc'],
  ].map((p) => [parseCardCode(p[0]!), parseCardCode(p[1]!)] as const);

  const tight = computeEquity(hero, [], [{ label: '3bet 范围 QQ+/AK', combos: tight3bet }], {
    seed: 20260913,
    iterations: 200000,
  });
  console.log(`\n  对照：若对手是紧 3bet 范围（QQ+/AK，13 个组合）`);
  console.log(`     AKo 权益 = ${tight.ok ? tight.result.equity.toFixed(4) : 'FAIL'}`);
  console.log(
    `     → 引擎用开池范围得到的权益 ${r.decision.diagnostics.math.heroEquity?.toFixed(4)} ` +
      `比紧 3bet 范围高 ${(
        ((r.decision.diagnostics.math.heroEquity ?? 0) - (tight.ok ? tight.result.equity : 0)) * 100
      ).toFixed(1)} 个百分点`,
  );
  console.log(`     所需权益 = ${(r.decision.diagnostics.math.requiredEquity * 100).toFixed(2)}%`);
}

/* ============================================================
 * main
 * ============================================================ */

await runHttpComparison();
runUiTextVsEngine();
runThreeBetRange();
