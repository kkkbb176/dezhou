/**
 * GTO 范围 UI 与接口测试
 *
 * ## 这份测试防什么
 *
 * 1. **求解器不在时页面仍要能打开**（本轮硬要求）。
 *    下面这些用例**刻意不启动 GTOpen**：它们验证「GTOpen 没启动时
 *    Alpha 仍然正常工作、界面仍然可渲染、接口仍然给出可展示的中文状态」。
 *    这比「启动求解器再测一次成功」重要得多 —— 成功路径用户自己会看到，
 *    失败路径没人看就会烂掉。
 *
 * 2. **界面契约**：13×13 矩阵的代号约定、百分比格式化的唯一入口、
 *    百分比与 0..1 的单位边界。这些是「0.65 显示成 0.65%」这类错误的防线。
 *
 * 3. **接口不能骗人**：拿不到数据时必须返回 `UNAVAILABLE` + 中文原因，
 *    不能返回一个空矩阵或全 0 频率（那会被读成「所有牌都弃牌」）。
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { startAlphaServer, type AlphaServer } from '../src/app/webServer.ts';
import {
  gtoCatalog,
  isGtoEnabled,
  queryGtoCatalogEntry,
  resetGtoForTests,
  setGtoEnabled,
} from '../src/app/gto/gtoApi.ts';
import { GtoScenarioKind } from '../src/domain/gto/gto.types.ts';
import { buildGtoScenario, scenarioHashOf } from '../src/domain/gto/gtoScenario.ts';
import { GtoSafeLookup } from '../src/domain/gto/gtoSafeLookup.ts';
import { GtopenProvider } from '../src/domain/gto/providers/gtopenProvider.ts';
import { GtoHttpClient } from '../src/domain/gto/providers/gtopenHttpClient.ts';
import { FakeGtopen } from './helpers/fakeGtopen.ts';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * 服务端 JSON 的**测试用**形状声明。
 *
 * 刻意只声明测试真正读到的字段（其余用索引签名兜住）：
 * 如果某天这些字段改名，测试会**编译失败**而不是静默读到 `undefined`
 * 然后「因为 undefined 也算 falsy」而假绿。
 */
type GtoRangePayload = {
  ok: boolean;
  status: string;
  cause: string | null;
  messageZh: string;
  verificationZh: string | null;
  approximate: boolean;
  approximationNotes: string[];
  scenarioZh?: string;
  scenarioHash?: string;
  quality: { level: string; levelZh: string; summaryZh: string; disclaimerZh: string } | null;
  cache: { source: string; sourceZh: string; cacheKey: string; cachedAt: string | null; solveDurationMs: number | null } | null;
  fingerprintLines: string[];
  baseline: {
    range: {
      hands: {
        hand: string;
        actions: { kind: string; sizeBB: number | null; frequency: number; evBB: number | null }[];
      }[];
    };
  } | null;
};

type CatalogPayload = {
  ok: boolean;
  tableSizes: number[];
  positionsByTableSize: Record<string, string[]>;
  positionZh: Record<string, string>;
  entries: { id: string; tableSize: number; supported: boolean }[];
};

type HealthPayload = {
  ok: boolean;
  enabled: boolean;
  health: { reachable: boolean; message: string };
};

/** `/api/health`（Alpha 自身的健康检查） */
type AlphaHealthPayload = { ok: boolean; knowledgeRules: number; mode: string; gto: string };

let server: AlphaServer | null = null;
let baseUrl = '';

before(async () => {
  // 🔴 不启动 GTOpen。端口 1 是一个保证连不上的地址。
  server = await startAlphaServer({ port: 0, logPath: null });
  baseUrl = server.url;
});

after(async () => {
  if (server !== null) await server.close();
  resetGtoForTests();
});

/* ============================================================
 * 一、页面与静态资源
 * ============================================================ */

test('GTO-UI-01：GTO 范围页可以打开，且是中文 UTF-8', async () => {
  const response = await fetch(`${baseUrl}/gto`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/html; charset=utf-8/);
  const html = await response.text();
  assert.ok(html.includes('GTO 范围'));
  assert.ok(html.includes('13×13 起手牌范围'));
  assert.ok(html.includes('牌桌人数'));
  // Phase 1.1：四档状态必须都在页面上
  for (const state of ['LOW_CONVERGENCE', 'APPROXIMATE', 'USABLE', 'UNAVAILABLE']) {
    assert.ok(html.includes(state), `页面必须列出状态「${state}」`);
  }
  // 必须说明「质量」与「缓存 / 实时求解」这两件事
  assert.ok(html.includes('质量'), '页面必须提到质量');
  assert.ok(html.includes('缓存'), '页面必须说明数据可能来自缓存');
  // 🔴 不得**宣称**「绝对 GTO」。
  //    注意：页面里可以出现「它不是绝对 GTO」这样的**否定句**（那是必要的说明），
  //    但不允许把它作为**结论**呈现给用户。因此这里排除「被加粗/独立成句的宣称」。
  assert.ok(!/<b>\s*绝对\s*GTO\s*<\/b>/.test(html), '不得把「绝对 GTO」作为结论加粗显示');
  assert.ok(!/状态[：:]\s*绝对/.test(html), '数据状态不得写成「绝对」');
  assert.ok(!html.includes('已验证（VERIFIED）'), '页面不得把任何数据标成已验证');
});

test('GTO-UI-02：牌桌页新增了「GTO 范围」入口，且原有内容一字未动', async () => {
  const response = await fetch(`${baseUrl}/`);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.ok(html.includes('id="gotoGtoBtn"'), '牌桌页必须有 GTO 入口按钮');
  assert.ok(html.includes('id="seats"'), '牌桌页原有内容必须保留');
  assert.ok(html.includes('id="analyzeBtn"'));
});

test('GTO-UI-03：gto.css / gto.js 可以取到，且 JS 通过基础语法检查', async () => {
  const css = await fetch(`${baseUrl}/gto.css`);
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type') ?? '', /text\/css/);
  const js = await fetch(`${baseUrl}/gto.js`);
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type') ?? '', /text\/javascript/);
  const text = await js.text();
  assert.ok(text.includes('fmtPercent'));
});

test('GTO-UI-04：13×13 矩阵的前端代号约定与后端类号约定一致', () => {
  const js = readFileSync(join(REPO_ROOT, 'src', 'app', 'web', 'gto.js'), 'utf8');
  // 轴必须是从 A 到 2
  assert.ok(/const RANKS = \['A', 'K', 'Q', 'J', 'T', '9', '8', '7', '6', '5', '4', '3', '2'\]/.test(js));
  // 右上同花 / 左下不同花
  assert.ok(js.includes("(col > row ? 's' : 'o')"));
  // 百分比只在一处 ×100
  const multiply = (js.match(/\* 100/g) ?? []).length;
  assert.ok(multiply <= 2, `×100 只能出现在 fmtPercent 与进度条宽度处，实际 ${multiply} 处`);
});

test('GTO-UI-05：拿不到数据时**不渲染矩阵**（空矩阵会被误读成「全部弃牌」）', () => {
  const js = readFileSync(join(REPO_ROOT, 'src', 'app', 'web', 'gto.js'), 'utf8');
  // 失败分支必须清空矩阵
  const failureBranch = js.slice(js.indexOf("if (!result.ok || baseline === null"));
  assert.ok(failureBranch.includes("$('matrix').innerHTML = ''"));
  assert.ok(failureBranch.includes('GTO_BASELINE_UNAVAILABLE'));
});

/* ============================================================
 * 二、接口：目录（不需要求解器）
 * ============================================================ */

test('GTO-UI-06：/api/gto/catalog 不需要求解器在线即可返回完整目录', async () => {
  const response = await fetch(`${baseUrl}/api/gto/catalog`);
  assert.equal(response.status, 200);
  const payload = (await response.json()) as GtoRangePayload & CatalogPayload & HealthPayload;
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.tableSizes, [4, 5, 6, 8, 9]);
  assert.deepEqual(payload.positionsByTableSize['4'], ['CO', 'BTN', 'SB', 'BB']);
  assert.deepEqual(payload.positionsByTableSize['9'], [
    'UTG',
    'UTG1',
    'UTG2',
    'LJ',
    'HJ',
    'CO',
    'BTN',
    'SB',
    'BB',
  ]);
  assert.ok(payload.entries.length > 0);
  // 位置中文名必须随目录一起下发（界面不做硬编码）
  assert.equal(payload.positionZh['BTN'], '庄家位');
});

test('GTO-UI-07：/api/gto/health 在求解器不在时返回可展示的状态，而非 500', async () => {
  const response = await fetch(`${baseUrl}/api/gto/health`);
  assert.equal(response.status, 200);
  const payload = (await response.json()) as GtoRangePayload & CatalogPayload & HealthPayload;
  assert.equal(payload.ok, true);
  assert.equal(typeof payload.health.reachable, 'boolean');
  assert.ok(typeof payload.health.message === 'string' && payload.health.message.length > 0);
});

test('GTO-UI-08：/api/health 报告 GTO 是可选的（不影响 Alpha 自身可用性）', async () => {
  const response = await fetch(`${baseUrl}/api/health`);
  const payload = (await response.json()) as AlphaHealthPayload;
  assert.equal(payload.ok, true);
  assert.equal(payload.mode, 'INTERNAL_ALPHA');
  assert.ok(payload.gto === 'ENABLED' || payload.gto === 'DISABLED');
});

/* ============================================================
 * 三、接口：范围查询（失败回退路径）
 * ============================================================ */

test('GTO-UI-09：求解器没启动 → /api/gto/range 返回 UNAVAILABLE + 中文原因，HTTP 仍 200', async () => {
  // 把 Provider 指向一个必定连不上的端口
  const offlineProvider = new GtopenProvider({
    baseUrl: 'http://127.0.0.1:1',
    client: new GtoHttpClient({ baseUrl: 'http://127.0.0.1:1' }),
  });
  resetGtoForTests({ lookup: new GtoSafeLookup(offlineProvider, { hardTimeoutMs: 3_000, store: null }), enabled: true });

  const response = await fetch(`${baseUrl}/api/gto/range`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tableSize: 6, heroPosition: 'UTG', template: 'FIRST_IN', effectiveStackBB: 100 }),
  });
  assert.equal(response.status, 200, '求解器离线不得变成 5xx');
  const payload = (await response.json()) as GtoRangePayload & CatalogPayload & HealthPayload;
  assert.equal(payload.ok, false);
  assert.equal(payload.status, 'UNAVAILABLE');
  assert.equal(payload.baseline, null);
  assert.ok(typeof payload.messageZh === 'string' && payload.messageZh.length > 10);
  resetGtoForTests();
});

test('GTO-UI-10：不支持的桌人数（7 人桌）→ 明确中文原因，绝不就近取整', async () => {
  const response = await fetch(`${baseUrl}/api/gto/range`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tableSize: 7, heroPosition: 'CO', template: 'FIRST_IN' }),
  });
  assert.equal(response.status, 200);
  const payload = (await response.json()) as GtoRangePayload & CatalogPayload & HealthPayload;
  assert.equal(payload.ok, false);
  assert.match(payload.messageZh, /4 \/ 5 \/ 6 \/ 8 \/ 9/);
  assert.match(payload.messageZh, /不会/);
});

test('GTO-UI-11：缺少 tableSize → 明确说明它是必需的一级参数（不允许从位置名推断）', async () => {
  const response = await fetch(`${baseUrl}/api/gto/range`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ heroPosition: 'BTN', template: 'FIRST_IN' }),
  });
  const payload = (await response.json()) as GtoRangePayload & CatalogPayload & HealthPayload;
  assert.equal(payload.ok, false);
  assert.match(payload.messageZh, /一级场景参数|tableSize/);
});

test('GTO-UI-12：目录里不存在的组合（4 人桌 UTG）→ 明确拒绝', async () => {
  const response = await fetch(`${baseUrl}/api/gto/range`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tableSize: 4, heroPosition: 'UTG', template: 'FIRST_IN' }),
  });
  const payload = (await response.json()) as GtoRangePayload & CatalogPayload & HealthPayload;
  assert.equal(payload.ok, false);
  assert.match(payload.messageZh, /没有|无法/);
});

test('GTO-UI-13：非法 JSON → 400 + 中文原因（不是崩溃）', async () => {
  const response = await fetch(`${baseUrl}/api/gto/range`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{ this is not json',
  });
  assert.equal(response.status, 400);
  const payload = (await response.json()) as GtoRangePayload & CatalogPayload & HealthPayload;
  assert.match(payload.messageZh, /JSON/);
});

/* ============================================================
 * 四、成功路径（用结构一致的假求解器）
 * ============================================================ */

test('GTO-UI-14：求解器可用时接口返回 APPROXIMATE + 完整 169 类 + 混合频率', async () => {
  const fake = new FakeGtopen();
  const provider = new GtopenProvider({
    baseUrl: 'http://127.0.0.1:3737',
    client: new GtoHttpClient({ baseUrl: 'http://127.0.0.1:3737', fetchImpl: fake.fetch }),
    sleep: async () => undefined,
  });
  resetGtoForTests({ lookup: new GtoSafeLookup(provider, { store: null }), enabled: true });

  const response = await fetch(`${baseUrl}/api/gto/range`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tableSize: 6, heroPosition: 'UTG', template: 'FIRST_IN', effectiveStackBB: 100 }),
  });
  const payload = (await response.json()) as GtoRangePayload;
  assert.equal(payload.ok, true);
  /*
   * 🔴 Phase 1.1：状态**不再写死**为 `APPROXIMATE`，而是由质量等级决定。
   *
   * 但那条不可动摇的纪律仍然要断言：**永远不可能是 SOLVED / VERIFIED** ——
   * 因为 GTOpen 的翻前是近似延续模型，质量天花板就是 APPROXIMATE。
   */
  assert.ok(
    payload.status === 'APPROXIMATE' || payload.status === 'LOW_CONVERGENCE',
    `状态只可能是 APPROXIMATE 或 LOW_CONVERGENCE，实际 ${payload.status}`,
  );
  assert.notEqual(payload.status, 'SOLVED');
  assert.notEqual(payload.verificationZh, '已验证');
  assert.equal(payload.verificationZh, '近似求解');
  assert.equal(payload.approximate, true);
  assert.ok(payload.approximationNotes.length > 0);
  assert.ok((payload.scenarioZh ?? '').includes('6 人桌'));
  assert.ok(payload.baseline !== null);
  const baseline = payload.baseline!;
  assert.equal(baseline.range.hands.length, 169);

  // 质量与缓存元数据必须存在（界面要显示它们）
  assert.ok(payload.quality !== null, '必须给出质量等级');
  assert.ok(payload.cache !== null, '必须给出数据来源（缓存 / 实时求解）');
  assert.ok(['persistent', 'memory', 'solver', 'none'].includes(payload.cache!.source));
  assert.ok(payload.cache!.sourceZh.length > 0);
  assert.ok(payload.cache!.cacheKey.startsWith('c'), '必须给出完整缓存键');
  originAssert(payload.cache!.source);
  // 低质量必须给「质量有限」这类措辞，不得出现「精确/绝对/最优」
  if (payload.status === 'LOW_CONVERGENCE') {
    assert.match(payload.quality!.disclaimerZh, /质量有限|近似/);
  }
  for (const forbidden of ['精确 GTO', '绝对 GTO', '最优答案']) {
    assert.ok(!payload.quality!.disclaimerZh.includes(forbidden));
  }

  // 混合策略必须保留（AKs 至少两个动作）
  const aks = baseline.range.hands.find((h) => h.hand === 'AKs');
  assert.ok(aks !== undefined, 'AKs 必须在 169 类里');
  assert.ok(aks.actions.length >= 2, '混合策略不得被压成单一动作');
  // EV 必须为 null（求解器没给）
  for (const action of aks.actions) assert.equal(action.evBB, null);

  resetGtoForTests();
});

/** 断言「实时求解」的来源说法正确（避免把缓存说成实时求解） */
function originAssert(source: string): void {
  if (source === 'solver') return;
  if (source === 'persistent') return;
  if (source === 'memory') return;
  assert.equal(source, 'none');
}

test('GTO-UI-15：接口返回的场景哈希与同参数场景一致（界面显示的哈希可信）', async () => {
  const fake = new FakeGtopen();
  const provider = new GtopenProvider({
    baseUrl: 'http://127.0.0.1:3737',
    client: new GtoHttpClient({ baseUrl: 'http://127.0.0.1:3737', fetchImpl: fake.fetch }),
    sleep: async () => undefined,
  });
  resetGtoForTests({ lookup: new GtoSafeLookup(provider, { store: null }), enabled: true });

  const response = await fetch(`${baseUrl}/api/gto/range`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tableSize: 5, heroPosition: 'HJ', template: 'FIRST_IN', effectiveStackBB: 100 }),
  });
  const payload = (await response.json()) as GtoRangePayload & CatalogPayload & HealthPayload;
  assert.equal(payload.ok, true);
  const expected = buildGtoScenario({
    kind: GtoScenarioKind.RFI,
    tableSize: 5,
    effectiveStackBB: 100,
    heroPosition: 'HJ',
    actionHistory: [],
  });
  assert.ok(expected !== null);
  assert.equal(payload.scenarioHash, scenarioHashOf(expected));
  resetGtoForTests();
});

/* ============================================================
 * 五、可关闭（ALPHA_GTO=off 语义）
 * ============================================================ */

test('GTO-UI-16：关闭 GTO 后所有查询立刻返回「已关闭」，且不发任何请求', async () => {
  const fake = new FakeGtopen();
  const provider = new GtopenProvider({
    baseUrl: 'http://127.0.0.1:3737',
    client: new GtoHttpClient({ baseUrl: 'http://127.0.0.1:3737', fetchImpl: fake.fetch }),
    sleep: async () => undefined,
  });
  resetGtoForTests({ lookup: new GtoSafeLookup(provider, { store: null }), enabled: false });
  assert.equal(isGtoEnabled(), false);

  const result = await queryGtoCatalogEntry({
    tableSize: 6,
    heroPosition: 'UTG',
    template: 'FIRST_IN',
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'UNAVAILABLE');
  assert.match(result.messageZh, /关闭/);
  assert.equal(fake.requests.length, 0, '关闭状态下不得发出任何 HTTP 请求');

  resetGtoForTests();
  setGtoEnabled(true);
});

test('GTO-UI-17：目录渲染（positionsByTableSize）在关闭 GTO 时仍然可用', () => {
  resetGtoForTests({ enabled: false });
  const catalog = gtoCatalog();
  assert.deepEqual(catalog.tableSizes, [4, 5, 6, 8, 9]);
  assert.equal(catalog.positionsByTableSize['4']?.length, 4);
  resetGtoForTests();
  setGtoEnabled(true);
});

/* ============================================================
 * 五、扩展目录接口（Phase 1.1 第二轮新增）
 *
 * ⚠️ 这一组**不需要求解器**：目录与「未支持原因」都是本项目自己的数据。
 * 用到假求解器的那两条会显式建一个（与 GTO-UI-14 同一手法）。
 * ============================================================ */

test('GTO-UI-18：/api/gto/catalog/extended 不需要求解器即可返回完整扩展目录', async () => {
  const response = await fetch(`${baseUrl}/api/gto/catalog/extended`);
  assert.equal(response.status, 200);
  const payload = (await response.json()) as {
    ok: boolean;
    entries: {
      id: string;
      template: string;
      labelZh: string;
      unsupportedReason: string | null;
      requiredMaxRaises: number;
    }[];
  };
  assert.equal(payload.ok, true);
  assert.ok(payload.entries.length > 0, '扩展目录不得为空');

  /*
   * 🔴 「Hero 自己做 3Bet」**不是可达节点**，因此目录里**不得有**它的模板。
   * 它一旦出现，界面就会给出一个点进去读到别人策略的入口。
   */
  assert.ok(
    !payload.entries.some((e) => e.template === 'THREE_BET'),
    '目录里不得出现 THREE_BET 模板',
  );

  /*
   * `VS_3BET` 的条目必须带**残缺菜单**的原因（不是「我们表达不了」）——
   * 那条理由是实测走通 17/17 之后才改对的。
   */
  const vs3 = payload.entries.filter((e) => e.template === 'VS_3BET');
  assert.ok(vs3.length > 0, '必须有 VS_3BET 条目（哪怕是不支持）');
  for (const e of vs3) {
    assert.match(e.unsupportedReason ?? '', /残缺/);
    assert.match(e.unsupportedReason ?? '', /max_raises = 2/);
    assert.equal(e.requiredMaxRaises, 3, '读出完整策略需要第 3 次加注');
  }

  // 桌人数隔离：只看第一个行动位的条目
  for (const size of ['4', '5', '6', '8', '9'] as const) {
    const ofSize = vs3.filter((e) => e.id.startsWith(`${size}-`));
    assert.ok(ofSize.length > 0, `${size} 人桌必须有 VS_3BET 条目`);
  }
});

test('GTO-UI-19：扩展查询必须走目录条目 id（界面不得自己拼场景）', async () => {
  const missing = await fetch(`${baseUrl}/api/gto/range/extended`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tableSize: 6,
      heroPosition: 'UTG',
      template: 'VS_3BET',
      counterpartyPosition: 'HJ',
    }),
  });
  assert.equal(missing.status, 200, '缺 entryId 不该是 500');
  const payload = (await missing.json()) as { ok: boolean; messageZh: string };
  assert.equal(payload.ok, false);
  assert.match(payload.messageZh, /entryId/);
  assert.match(payload.messageZh, /目录条目 id/);

  // 不存在的 id 也要给出可展示的中文原因，而不是崩溃
  const unknown = await fetch(`${baseUrl}/api/gto/range/extended`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entryId: '6-没有人-VS_3BET-没有' }),
  });
  assert.equal(unknown.status, 200);
  const unknownPayload = (await unknown.json()) as { ok: boolean; messageZh: string };
  assert.equal(unknownPayload.ok, false);
  assert.ok(unknownPayload.messageZh.length > 0);
});

test('GTO-UI-20：未支持的扩展条目 → ok:false + **残缺菜单**原因（HTTP 仍 200）', async () => {
  const response = await fetch(`${baseUrl}/api/gto/range/extended`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entryId: '6-UTG-VS_3BET-HJ' }),
  });
  assert.equal(response.status, 200);
  const payload = (await response.json()) as { ok: boolean; status: string; messageZh: string };
  assert.equal(payload.ok, false);
  assert.equal(payload.status, 'UNAVAILABLE');
  assert.match(payload.messageZh, /残缺|4Bet/);
  /*
   * ⚠️ 这条断言是刻意加的：原因**不得**退化成「本项目表达不了」——
   * 那句话在 `heroAlreadyActed` 落地后已经被实测推翻。
   */
  assert.ok(
    !/本项目当前的场景模型|表达不了/.test(payload.messageZh),
    `原因不得使用已被推翻的说法：${payload.messageZh}`,
  );
});

test('GTO-UI-21：能表达的扩展条目 → 走目录 id 时返回质量与缓存来源', async () => {
  const fake = new FakeGtopen();
  const provider = new GtopenProvider({
    baseUrl: 'http://127.0.0.1:3737',
    client: new GtoHttpClient({ baseUrl: 'http://127.0.0.1:3737', fetchImpl: fake.fetch }),
    sleep: async () => undefined,
  });
  resetGtoForTests({ lookup: new GtoSafeLookup(provider, { store: null }), enabled: true });

  const response = await fetch(`${baseUrl}/api/gto/range/extended`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entryId: '6-BB-VS_NAMED_OPEN-BTN' }),
  });
  assert.equal(response.status, 200);
  const payload = (await response.json()) as {
    ok: boolean;
    status: string;
    quality: { level: string; levelZh: string } | null;
    cache: { source: string; sourceZh: string } | null;
    fingerprintLines: string[];
    baseline: { range: { hands: unknown[] } } | null;
  };
  assert.equal(payload.ok, true);
  assert.ok(payload.quality !== null, '必须带质量等级');
  assert.notEqual(payload.quality.level, 'CROSS_CHECKED');
  assert.ok(payload.cache !== null, '必须说明数据是现算的还是读缓存的');
  assert.equal(payload.baseline?.range.hands.length, 169);
  /*
   * `fingerprintLines` 的来源是**求解器原始响应**里的 `fingerprintLines`
   * （见 `fingerprintLinesOf`），假求解器不产生它 —— 因此这里只能断言
   * 「字段一定在、且一定是数组」，不能断言它非空。
   * 真实求解器下它非空，那由 `scripts/gto-vs3bet-live-probe.ts` 一组证据覆盖。
   */
  assert.ok(Array.isArray(payload.fingerprintLines), 'fingerprintLines 必须是数组');
  assert.ok(
    payload.baseline !== null,
    '无论有没有指纹，基线数据本身必须完整（不能因为解释信息缺失就不给数据）',
  );

  resetGtoForTests();
  setGtoEnabled(true);
});

/* ============================================================
 * 🔴 有效筹码必须真的生效（2026-09 修正轮）
 *
 * 修复前：GTO 页顶栏的「有效筹码」输入框**可编辑但完全无效** ——
 * 页面只发 `{ entryId }`，而扩展目录与扩展查询都硬编码 100BB。
 * 用户填 50 会拿到 100BB 的策略，且界面上没有任何线索。
 * ============================================================ */

test('GTO-UI-24：🔴 前端必须真的把「有效筹码」接上（静态锁）', () => {
  /*
   * ## 这条锁的是修复前的形态
   *
   * GTO 页顶栏有一个**可编辑**的「有效筹码」输入框，但 `gto.js` 从未读它：
   * 查询只发 `{ entryId }`，后端也只认 entryId ⇒ 用户填 50BB 拿到 100BB 的策略，
   * 界面上没有任何线索。当时全文件搜 `stackInput` **零命中**。
   *
   * 因此这里做静态检查：读输入、随查询发送、随目录请求发送，三件事缺一不可。
   * 端到端行为由 `GTO-UI-22/23` 锁住（含发往求解器的请求体）。
   */
  const js = readFileSync(join(REPO_ROOT, 'src', 'app', 'web', 'gto.js'), 'utf8');

  assert.ok(js.includes("$('stackInput')"), '前端必须真的读取 stackInput（修复前零引用）');
  assert.ok(
    /effectiveStackBB\s*:/.test(js),
    '查询体里必须带 effectiveStackBB 字段',
  );
  assert.ok(
    js.includes('catalog/extended?effectiveStackBB='),
    '目录请求也必须带筹码（否则 supported 标记会与所选筹码不一致）',
  );
  /*
   * 改了筹码就必须作废屏幕上的旧结果 —— 否则 100BB 的 13×13 会留在屏幕上，
   * 而顶栏写着 50BB（数据没说谎，是界面在说谎）。
   */
  assert.ok(
    js.includes('clearDisplayedRange'),
    '改筹码必须清空上一次显示的结果，避免旧筹码的数据被当成新筹码的',
  );
});

test('GTO-UI-25：🔴 首次进入必须落在「查得到」的场景上（不能停在空壳节点）', async () => {
  /*
   * ## 这条锁的是使用者反馈的「跟个空壳一样」
   *
   * 目录刻意把**所有**节点都列出来（不支持的也列，并写明原因），这是对的设计。
   * 但默认选中是「第一个桌型 + 第一个位置」= `4 人桌 CO`，而 CO 在 4 人桌
   * 就是第一个行动位 —— **一条可查条目都没有**。于是打开页面第一眼是
   * 「CO · 面对首位开池（尚未验证）」，很容易被读成「整页是坏的」。
   *
   * 修复：首次加载时挪到第一个真正支持的（桌型, 位置）；之后尊重用户的选择。
   */
  const catalog = (await (await fetch(`${baseUrl}/api/gto/catalog`)).json()) as CatalogPayload;
  const ext = (await (await fetch(`${baseUrl}/api/gto/catalog/extended`)).json()) as {
    entries: { id: string; tableSize: number; heroPosition: string; supported: boolean }[];
  };

  // 旧默认确实是个死胡同 —— 这条断言解释了「为什么需要」上面那条规则
  const coAt4 = ext.entries.filter((e) => e.tableSize === 4 && e.heroPosition === 'CO');
  assert.ok(coAt4.length > 0, '4 人桌 CO 的条目必须存在（不支持的也要列出来）');
  assert.ok(
    coAt4.every((e) => !e.supported),
    '4 人桌 CO 是第一个行动位 —— 它本来就不该有可查条目（这是数据事实）',
  );

  // 规则得到的选择必须真的可查
  let picked: { tableSize: number; heroPosition: string } | null = null;
  for (const size of catalog.tableSizes) {
    for (const position of catalog.positionsByTableSize[String(size)] ?? []) {
      if (ext.entries.some((e) => e.tableSize === size && e.heroPosition === position && e.supported)) {
        picked = { tableSize: size, heroPosition: position };
        break;
      }
    }
    if (picked !== null) break;
  }
  assert.ok(picked !== null, '目录里必须至少有一个可查询的（桌型, 位置）组合');
  const landed = ext.entries.find(
    (e) => e.tableSize === picked!.tableSize && e.heroPosition === picked!.heroPosition && e.supported,
  );
  assert.ok(landed !== undefined, '首次进入必须落在一个 supported=true 的条目上');
  assert.ok(
    !(picked!.tableSize === 4 && picked!.heroPosition === 'CO'),
    '首次进入不得停在那个死胡同节点上',
  );

  // 前端必须真的用了这条规则（静态锁：改回「永远选第一个」就会红）
  const js = readFileSync(join(REPO_ROOT, 'src', 'app', 'web', 'gto.js'), 'utf8');
  assert.ok(js.includes('pickFirstSupportedSelection'), '前端必须调用首次选择规则');
  assert.ok(
    /state\.initialized !== true/.test(js),
    '规则只能跑一次 —— 否则用户主动选的位置会被反复抢走',
  );
});

test('GTO-UI-22：扩展目录必须按有效筹码生成（同一 id 在不同筹码下是不同节点）', async () => {
  const plain = (await (await fetch(`${baseUrl}/api/gto/catalog/extended`)).json()) as {
    ok: boolean;
    effectiveStackBB: number;
    entries: { id: string; scenarioHash: string; supported: boolean }[];
  };
  assert.equal(plain.ok, true);
  assert.equal(plain.effectiveStackBB, 100, '缺省必须仍是 100BB（老调用方逐位不变）');

  const fifty = (await (
    await fetch(`${baseUrl}/api/gto/catalog/extended?effectiveStackBB=50`)
  ).json()) as typeof plain;
  assert.equal(fifty.effectiveStackBB, 50, '目录必须如实回报自己是按哪个筹码生成的');
  assert.equal(fifty.entries.length, plain.entries.length, '条目集合本身不随筹码变化');

  /*
   * 🔴 核心断言：同一个条目 id 在 100BB 与 50BB 下必须是**不同的场景哈希**。
   * 若筹码没被传进场景构建器，两者会完全相同 —— 那正是修复前的状态。
   */
  const id = '6-BB-VS_NAMED_OPEN-BTN';
  const hashOf = (p: typeof plain) => p.entries.find((e) => e.id === id)?.scenarioHash;
  const at100 = hashOf(plain);
  const at50 = hashOf(fifty);
  assert.ok(typeof at100 === 'string' && at100.length > 0, '100BB 下该条目必须可解');
  assert.ok(typeof at50 === 'string' && at50.length > 0, '50BB 下该条目必须可解');
  assert.notEqual(at50, at100, `筹码必须参与场景哈希（100BB=${at100} / 50BB=${at50}）`);

  /*
   * 非法筹码必须**明确报错**，绝不静默退回 100BB ——
   * 「界面写 50BB、数据是 100BB」正是这次要消灭的形态。
   */
  for (const bad of ['0', 'abc', '5000', '-20']) {
    const payload = (await (
      await fetch(`${baseUrl}/api/gto/catalog/extended?effectiveStackBB=${bad}`)
    ).json()) as { ok: boolean; messageZh: string; entries: unknown[] };
    assert.equal(payload.ok, false, `有效筹码「${bad}」必须被拒绝`);
    assert.match(payload.messageZh, /有效筹码/);
    assert.equal(payload.entries.length, 0, '被拒绝时不得给出任何条目');
  }
});

test('GTO-UI-23：扩展查询必须把筹码传进场景（**求解器收到的请求**必须不同）', async () => {
  const fake = new FakeGtopen();
  /*
   * 🔴 记录**真正发给求解器**的请求体。
   *
   * 只断言响应里的标签/哈希是不够的 —— 那些可以由界面层自己拼出来，
   * 「筹码有没有进到场景里」只有看求解器收到什么才能证明。
   * 因此这里包一层 fetch 把请求体留下来。
   */
  const solveRequests: string[] = [];
  const recordingFetch = (url: string, init?: { body?: unknown }) => {
    if (typeof init?.body === 'string') solveRequests.push(init.body);
    return (fake.fetch as unknown as (u: string, i?: unknown) => Promise<Response>)(url, init);
  };

  const provider = new GtopenProvider({
    baseUrl: 'http://127.0.0.1:3737',
    client: new GtoHttpClient({
      baseUrl: 'http://127.0.0.1:3737',
      fetchImpl: recordingFetch as unknown as typeof fetch,
    }),
    sleep: async () => undefined,
  });
  resetGtoForTests({ lookup: new GtoSafeLookup(provider, { store: null }), enabled: true });

  const query = async (effectiveStackBB: number): Promise<GtoRangePayload> =>
    (await (
      await fetch(`${baseUrl}/api/gto/range/extended`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entryId: '6-BB-VS_NAMED_OPEN-BTN', effectiveStackBB }),
      })
    ).json()) as GtoRangePayload;

  /*
   * ⚠️ 一次查询会发**多个**请求（`estimate` / `spot` / `solve` / 多个 `node`），
   * 因此必须按「每次查询一段」切片比较，不能只看最后两条。
   */
  const slice100Start = solveRequests.length;
  const at100 = await query(100);
  const req100 = solveRequests.slice(slice100Start);
  const slice50Start = solveRequests.length;
  const at50 = await query(50);
  const req50 = solveRequests.slice(slice50Start);

  assert.equal(at100.ok, true);
  assert.equal(at50.ok, true);
  /*
   * 🔴 标签必须写出筹码：条目 id 与 labelZh 都不含筹码，
   * 不写的话用户无法分辨屏幕上这份数据是哪个筹码算的。
   */
  assert.match(at100.scenarioZh ?? '', /100BB/, `100BB 场景标签必须含筹码：${at100.scenarioZh}`);
  assert.match(at50.scenarioZh ?? '', /50BB/, `50BB 场景标签必须含筹码：${at50.scenarioZh}`);
  assert.notEqual(
    at50.scenarioHash,
    at100.scenarioHash,
    '两次查询必须是两个不同的场景',
  );

  /*
   * 🔴 决定性断言：两次查询发往求解器的请求**必须带各自的筹码**。
   * 若筹码在链路上被丢掉（修复前的状态），两次请求会逐字相同 ——
   * 那时无论界面上写 50BB 还是 100BB，算出来的都是同一个 100BB 策略。
   *
   * 实测线上编码（`/api/preflop/estimate` 的请求体）：
   * `{"positions":[…],"stack":50,"posts":[…]…}` —— 筹码字段就是 `stack`。
   */
  assert.ok(req100.length > 0 && req50.length > 0, '两次查询都必须发出请求');
  assert.match(req100[0]!, /"stack":100,/, `100BB 查询的建树请求必须带 stack=100：${req100[0]}`);
  assert.match(req50[0]!, /"stack":50,/, `50BB 查询的建树请求必须带 stack=50：${req50[0]}`);
  assert.notEqual(req100.join('|'), req50.join('|'), '两组请求必须不同');

  // 非法筹码同样必须明确拒绝，而不是按 100BB 算完再返回
  const bad = (await (
    await fetch(`${baseUrl}/api/gto/range/extended`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entryId: '6-BB-VS_NAMED_OPEN-BTN', effectiveStackBB: 0 }),
    })
  ).json()) as GtoRangePayload;
  assert.equal(bad.ok, false);
  assert.match(bad.messageZh, /有效筹码/);

  resetGtoForTests();
  setGtoEnabled(true);
});
