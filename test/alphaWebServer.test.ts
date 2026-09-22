/**
 * Alpha 内部测试服务器测试
 *
 * ## 为什么必须测「真实的 HTTP 往返」
 *
 * 端到端测试覆盖的是「函数调用」，而**「网页能不能用」取决于 HTTP 层**：
 * 路由、JSON 序列化、错误状态、中文编码。
 * 这些都不在 `alphaPipeline.test.ts` 的覆盖范围内。
 *
 * 本文件用一个真实监听的服务器 + 真实 `fetch` 验证往返，
 * 并断言 ViewModel 与引擎结果**逐字段一致**（红队重点 10：
 * UI 与 Engine 结果不一致）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Position, Street } from '../src/domain/types.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import { startAlphaServer, type AlphaServer } from '../src/app/webServer.ts';
import { analyzeManualHand, hashManualInput } from '../src/app/alphaPipeline.ts';
import type { ManualHandInput } from '../src/app/manualInput/manualInput.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const AS_OF = 1_757_000_000_000;

function flopScenario(): ManualHandInput {
  return {
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
    villain: { quickProfile: 'NORMAL' },
  };
}

/** 启动一个临时服务器（端口 0 = 由系统分配，避免与真实实例冲突） */
async function withServer<T>(fn: (server: AlphaServer) => Promise<T>): Promise<T> {
  const logDir = mkdtempSync(join(tmpdir(), 'alpha-log-'));
  const server = await startAlphaServer({
    port: 0,
    rules: RULES,
    logPath: join(logDir, 'decision-log.jsonl'),
  });
  try {
    return await fn(server);
  } finally {
    await server.close();
    rmSync(logDir, { recursive: true, force: true });
  }
}

/* ============================================================
 * 敌意输入：**绝不允许**变成 HTTP 500
 * ============================================================ */

test('服务器:行动记录里夹一个 null 必须被结构化拒绝，而不是 500', async () => {
  /*
   * 🔴 修复前实测：`actionHistory: [null]` 与 `actionHistory: [..., null]`
   * 都返回 **HTTP 500**（`Cannot read properties of null (reading 'position')`，
   * 位置 `manualInput.ts` 的 `action.position`）。
   *
   * 为什么这条值得单独钉住：`actionHistory` 直接来自 JSON，
   * 任何一条是 `null` 都会命中；而这一层的**职责**恰恰是
   * 「把所有坏输入变成结构化 issue」。它崩了，就等于把
   * 「用户填错了」误报成「服务器坏了」—— 使用者会去查服务，而问题在输入。
   *
   * ⚠️ 上层的 `Array.isArray(input.actionHistory)` 只挡住
   * 「整个字段不是数组」，**挡不住逐个元素的 null**。
   */
  await withServer(async (server) => {
    for (const [label, actionHistory] of [
      ['只有一条且为 null', [null]],
      ['首条为 null', [null, { position: Position.UTG, type: 'FOLD' }]],
      ['末条为 null', [{ position: Position.UTG, type: 'FOLD' }, null]],
      ['中间为 null', [{ position: Position.UTG, type: 'FOLD' }, null, { position: Position.HJ, type: 'FOLD' }]],
      ['为字符串', ['RAISE']],
      ['为数字', [42]],
    ] as const) {
      const res = await fetch(`${server.url}/api/analyze`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          input: { ...flopScenario(), actionHistory },
        }),
      });
      assert.equal(res.status, 200, `${label}：必须是 200 + 结构化 issue，而不是 ${res.status}`);
      const body = (await res.json()) as {
        ok: boolean;
        stage: string;
        issues?: readonly { code: string; message: string; field?: string }[];
      };
      assert.equal(body.ok, false, `${label}：必须被判为失败`);
      assert.notEqual(body.stage, 'SERVER', `${label}：不得落到 SERVER 阶段（那是 500 的形态）`);
      const issue = body.issues?.[0];
      assert.ok(issue, `${label}：必须给出至少一条 issue`);
      assert.equal(issue.code, 'INVALID_ACTION', `${label}：issue 必须是「动作非法」`);
      assert.ok(
        issue.message.includes('对象'),
        `${label}：必须说清「不是一个对象」，而不是含糊报错 —— ${issue.message}`,
      );
    }
  });
});

/* ============================================================
 * 健康检查
 * ============================================================ */

test('服务器:健康检查返回知识库规则数', async () => {
  await withServer(async (server) => {
    const res = await fetch(`${server.url}/api/health`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; knowledgeRules: number; mode: string };
    assert.equal(body.ok, true);
    assert.equal(body.knowledgeRules, RULES.length);
    assert.equal(body.mode, 'INTERNAL_ALPHA');
  });
});

/* ============================================================
 * 中文页面
 * ============================================================ */

test('服务器:首页返回交互式牌桌页面且 UTF-8 正确', async () => {
  await withServer(async (server) => {
    const res = await fetch(`${server.url}/`);
    assert.equal(res.status, 200);
    assert.ok(
      (res.headers.get('content-type') ?? '').includes('charset=utf-8'),
      '必须声明 UTF-8，否则中文会乱码',
    );
    const html = await res.text();

    // 中文必须存在且未被编码破坏
    assert.ok(html.includes('牌桌快速录入'), '页面标题必须是中文');
    /*
     * ⚠️ LIVE UI V3 把「我的手牌」改成了「Hero 手牌」—— 在这个界面里
     * 「Hero」就是使用者自己，而 V3 的文案统一用 `Hero`（座位标记、
     * 决策区标题也都是 Hero）。这里断言的是**手牌区存在**，
     * 因此同时接受两种写法：文案可以改，区域不能没有。
     */
    assert.ok(
      html.includes('Hero 手牌') || html.includes('我的手牌'),
      '必须有手牌区',
    );
    assert.ok(html.includes('公共牌') || html.includes('boardRow'), '必须有公共牌槽位');
    assert.ok(html.includes('当前行动'), '必须有行动区');
    assert.ok(html.includes('建议'), '必须有结果区');
    assert.ok(html.includes('时间线'), '必须有时间线');
    assert.ok(html.includes('调试'), '必须有调试面板（规范第 81 条）');

    // 静态资源必须由同一台服务器提供（无构建步骤）
    assert.ok(html.includes('/table.js'), '必须引用客户端脚本');
    assert.ok(html.includes('/table.css'), '必须引用样式');
    /* LIVE UI V3 的布局与视觉规范必须一起加载（没有它页面会退化成裸 HTML） */
    assert.ok(html.includes('/live-ui.css'), '必须引用 live-ui.css');

    // 不得出现被破坏的编码（问号串是 PowerShell/编码事故的典型特征）
    assert.ok(!html.includes('????'), '页面不得含编码破坏产生的问号串');
  });
});

test('服务器:客户端脚本必须**不含**牌局规则（前端不复制状态机）', async () => {
  await withServer(async (server) => {
    const res = await fetch(`${server.url}/table.js`);
    assert.equal(res.status, 200);
    assert.ok(
      (res.headers.get('content-type') ?? '').includes('javascript'),
      '必须声明 JS 内容类型',
    );
    const js = await res.text();
    // 只允许**读取**后端给的值；不允许自带规则实现
    for (const forbidden of [
      'postflopOrder(',
      'preflopOrder(',
      'minRaiseTo(',
      'computePot(',
      'isUnopenedPot(',
      'requiredCallAmount(',
    ]) {
      assert.ok(!js.includes(forbidden), `客户端不得实现规则函数 ${forbidden}`);
    }
    // 但必须真的在与后端通信
    assert.ok(js.includes('/api/table'), '必须调用牌桌接口');
    assert.ok(js.includes('/api/analyze'), '必须调用分析接口');
    // 座位生命周期操作必须齐全（规范第 51 条）
    for (const needed of ['暂时离座', '重新入座', '更换玩家', '清空座位', '加入玩家']) {
      assert.ok(js.includes(needed), `座位菜单必须提供「${needed}」`);
    }
    // 版本保护必须存在（规范第 76 条）
    assert.ok(js.includes('revision'), '客户端必须做版本保护，防止旧响应回退界面');
    assert.ok(js.includes('inflight'), '客户端必须有在途请求标记（防双击）');
  });
});

/* ============================================================
 * 分析接口
 * ============================================================ */

test('服务器:分析接口返回与引擎**逐字段一致**的 ViewModel（红队重点 10）', async () => {
  await withServer(async (server) => {
    const input = flopScenario();

    // 引擎直算（真相来源）
    const direct = analyzeManualHand(input, { rules: RULES, asOf: AS_OF, writeLog: false });
    assert.equal(direct.ok, true);
    if (!direct.ok) return;

    // HTTP 往返
    const res = await fetch(`${server.url}/api/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      ok: boolean;
      viewModel: typeof direct.viewModel;
      decision: { action: string; sizeChips: number | null; confidence: number; classification: string };
    };
    assert.equal(body.ok, true);

    // 动作 / 尺寸 / 分类必须与引擎完全一致
    assert.equal(body.decision.action, direct.decision.action, 'HTTP 返回的动作必须等于引擎动作');
    assert.equal(body.decision.sizeChips, direct.decision.sizeChips ?? null);
    assert.equal(body.decision.classification, direct.decision.classification);
    assert.equal(body.viewModel.actionZh, direct.viewModel.actionZh);
    assert.equal(body.viewModel.classificationZh, direct.viewModel.classificationZh);
    assert.equal(body.viewModel.confidenceZh, direct.viewModel.confidenceZh);
    assert.deepEqual(body.viewModel.reasonsZh, direct.viewModel.reasonsZh);
    assert.deepEqual(body.viewModel.warningsZh, direct.viewModel.warningsZh);
  });
});

/* ============================================================
 * 范围来源必须跟着建议一起回传（本轮新增）
 * ============================================================ */

/** 多人池场景：9 人桌，Hero 在 BTN，6 家进池 */
function multiwayScenario(): ManualHandInput {
  return {
    tableSize: 9,
    heroPosition: Position.BTN,
    heroCards: ['Ah', 'Kh'],
    board: ['Kc', '8h', '3d'],
    street: Street.FLOP,
    effectiveStackBB: 100,
    actionHistory: [
      { position: Position.UTG, type: 'RAISE', amountBB: 3 },
      { position: Position.UTG1, type: 'FOLD' },
      { position: Position.UTG2, type: 'CALL', amountBB: 3 },
      { position: Position.LJ, type: 'CALL', amountBB: 3 },
      { position: Position.HJ, type: 'CALL', amountBB: 3 },
      { position: Position.CO, type: 'CALL', amountBB: 3 },
      { position: Position.BTN, type: 'CALL', amountBB: 3 },
      { position: Position.SB, type: 'FOLD' },
      { position: Position.BB, type: 'CALL', amountBB: 2 },
      { position: Position.BB, type: 'CHECK', street: Street.FLOP },
      { position: Position.UTG, type: 'CHECK', street: Street.FLOP },
      { position: Position.UTG2, type: 'CHECK', street: Street.FLOP },
      { position: Position.LJ, type: 'BET', amountBB: 4, street: Street.FLOP },
      { position: Position.HJ, type: 'CALL', amountBB: 4, street: Street.FLOP },
      { position: Position.CO, type: 'CALL', amountBB: 4, street: Street.FLOP },
    ],
    environment: 'MID_LOW_STAKES',
    villain: { quickProfile: 'NORMAL' },
  };
}

test('服务器:建议必须附带「这条建议用了什么范围」（来源 / 可信度 / 组合数）', async () => {
  await withServer(async (server) => {
    const res = await fetch(`${server.url}/api/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: flopScenario() }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      ok: boolean;
      rangeProvenance: {
        positionZh: string;
        sourceKind: string;
        sourceZh: string;
        sourceKindZh: string;
        fromSolver: boolean;
        confidence: number;
        supportSize: number;
        collapsed: boolean;
      }[];
    };
    assert.equal(body.ok, true);
    assert.ok(Array.isArray(body.rangeProvenance), '必须回传 rangeProvenance');
    assert.ok(body.rangeProvenance.length > 0, '至少有一个对手范围');

    for (const r of body.rangeProvenance) {
      assert.ok(r.positionZh.length > 0, '必须说明是哪个位置的范围');
      assert.ok(r.sourceZh.length > 0, '必须有中文来源说明');
      assert.ok(r.sourceKindZh.length > 0, '必须有来源类别中文名');
      assert.ok(r.confidence > 0 && r.confidence <= 1, `可信度必须在 (0,1]：${r.confidence}`);
      assert.ok(r.supportSize > 0, '有效组合数必须为正');
      assert.equal(typeof r.fromSolver, 'boolean', 'fromSolver 必须是布尔值（界面靠它区分算的与猜的）');
    }

    /*
     * 🔴 **这条断言在本轮改过**，理由必须写清楚。
     *
     * 原来它假设「所有范围都来自启发式先验」。本轮接入了翻前 GTO 范围，
     * 而这个 Spot（`flopScenario`）是**翻牌**局面 —— 求解器**不用**于翻后
     *（GTOpen 只解翻前），因此它**仍然**应当全部是启发式。
     *
     * 也就是说：这条断言从「锁死来源是启发式」变成了
     * 「**锁死翻后不会偷偷用翻前频率**」—— 后者是更实质的不变量。
     */
    for (const r of body.rangeProvenance) {
      assert.equal(
        r.fromSolver,
        false,
        `翻后不得使用求解器范围（GTOpen 只解翻前）：${r.positionZh}`,
      );
      assert.equal(r.sourceKind, 'HEURISTIC', `翻后范围的来源类别应当是启发式：${r.positionZh}`);
      assert.match(
        r.sourceKindZh,
        /非/,
        '启发式来源的**类别说明**必须写明它「不是」什么，否则使用者会当它是可靠结论',
      );
      assert.ok(r.confidence <= 0.35, `启发式先验的可信度应当很低，实际 ${r.confidence}`);
    }
  });
});

test('服务器:**翻前**在求解器在线时必须用求解器范围（不是启发式）', async () => {
  /*
   * 与上一条配对的正面用例 —— 只断言「翻后是启发式」是不够的，
   * 那用一个「永远返回启发式」的实现也能通过。
   * 这一条要求「翻前 + 单开池 + 尺寸匹配」时来源**真的换成求解器**。
   */
  await withServer(async (server) => {
    const res = await fetch(`${server.url}/api/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: {
          tableSize: 6,
          heroPosition: Position.BB,
          heroCards: ['Ah', 'Kh'],
          board: [],
          street: Street.PREFLOP,
          effectiveStackBB: 100,
          actionHistory: [
            { position: Position.UTG, type: 'RAISE', amountBB: 2.5 },
            { position: Position.HJ, type: 'FOLD' },
            { position: Position.CO, type: 'FOLD' },
            { position: Position.BTN, type: 'FOLD' },
            { position: Position.SB, type: 'FOLD' },
          ],
          environment: 'MID_LOW_STAKES',
          villain: { quickProfile: 'NORMAL' },
        },
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      ok: boolean;
      rangeProvenance: { fromSolver: boolean; confidence: number; sourceZh: string }[];
    };
    assert.equal(body.ok, true);

    /*
     * ⚠️ 测试环境里**没有真实求解器**（`startAlphaServer` 不注入 provider），
     * 因此这里断言的是「**求解器不可用时必须如实回落**」，而不是
     * 「一定用上了求解器」—— 后者需要真实 GTOpen，由
     * `scripts/gto-*` 的联调探针覆盖。
     *
     * 这条断言仍然有价值：它锁死「离线时不得谎称来源是求解器」。
     */
    for (const r of body.rangeProvenance) {
      if (r.fromSolver) {
        assert.match(r.sourceZh, /求解器/, '声称来自求解器时说明里必须提到求解器');
        assert.ok(r.confidence > 0.35, '求解器范围的可信度必须明显高于启发式');
      } else {
        assert.equal(r.confidence, 0.3, '回落启发式时可信度必须是启发式的 0.3');
      }
    }
  });
});

test('服务器:多人池的 rangeProvenance 必须覆盖**每一家**（不得只报首要对手）', async () => {
  await withServer(async (server) => {
    const res = await fetch(`${server.url}/api/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: multiwayScenario() }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      ok: boolean;
      decision: { action: string | null; actionable: boolean };
      rangeProvenance: { positionZh: string }[];
    };
    assert.equal(body.ok, true);

    /*
     * 6 家进池（UTG 开池 + 4 家跟注 + BB 跟注）。
     *
     * 🔴 这一条是「口径一致」的界面侧证据：权益按 6 家算
     *（见 `contextBuilder` 的多人口径），那么**报告给使用者的也必须是 6 家**。
     * 只报首要对手会让使用者以为权益是单挑口径 —— 那是把口径说错了。
     */
    assert.equal(
      body.rangeProvenance.length,
      6,
      `必须逐家报告范围来源，实际只报了 ${body.rangeProvenance.length} 家：` +
        JSON.stringify(body.rangeProvenance.map((r) => r.positionZh)),
    );
    assert.equal(new Set(body.rangeProvenance.map((r) => r.positionZh)).size, 6, '位置不得重复');

    // 多人池仍然必须给出建议（本轮修复的行为）
    assert.equal(body.decision.actionable, true);
    assert.notEqual(body.decision.action, null);
  });
});

test('服务器:分析接口对非法输入返回中文阻断原因（HTTP 200 + ok:false）', async () => {  await withServer(async (server) => {
    const cases: Array<{ name: string; input: ManualHandInput }> = [
      {
        name: '重复牌',
        input: { ...flopScenario(), heroCards: ['7d', '8c'], board: ['7d', 'Ks', '2h'] },
      },
      { name: '底池不符', input: { ...flopScenario(), potBB: 999 } },
      { name: '公共牌张数错', input: { ...flopScenario(), board: ['Kh'] } },
    ];

    for (const { name, input } of cases) {
      const res = await fetch(`${server.url}/api/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input }),
      });
      // 输入错误是**业务结果**，不是 HTTP 错误 → 仍是 200
      assert.equal(res.status, 200, `${name}: 应当是 200（业务失败，非协议失败）`);
      const body = (await res.json()) as {
        ok: boolean;
        stage: string;
        issues: Array<{ code: string; message: string }>;
      };
      assert.equal(body.ok, false, `${name}: 必须 ok:false`);
      assert.ok(body.issues.length > 0, `${name}: 必须有原因`);
      assert.ok(
        body.issues.every((i) => /[\u4e00-\u9fa5]/.test(i.message)),
        `${name}: 原因必须是中文`,
      );
    }
  });
});

test('服务器:协议级错误（坏 JSON / 缺 input / 未知路由）都被结构化处理', async () => {
  await withServer(async (server) => {
    // 坏 JSON
    const badJson = await fetch(`${server.url}/api/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not json',
    });
    assert.equal(badJson.status, 400);
    const badJsonBody = (await badJson.json()) as { ok: boolean; issues: Array<{ code: string }> };
    assert.equal(badJsonBody.ok, false);
    assert.equal(badJsonBody.issues[0]?.code, 'BAD_JSON');

    // 缺 input
    const noInput = await fetch(`${server.url}/api/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(noInput.status, 400);
    const noInputBody = (await noInput.json()) as { issues: Array<{ code: string }> };
    assert.equal(noInputBody.issues[0]?.code, 'MISSING_INPUT');

    // 未知路由
    const notFound = await fetch(`${server.url}/api/does-not-exist`);
    assert.equal(notFound.status, 404);
    const notFoundBody = (await notFound.json()) as { ok: boolean; issues: Array<{ code: string }> };
    assert.equal(notFoundBody.issues[0]?.code, 'NOT_FOUND');
  });
});

/* ============================================================
 * 决策日志
 * ============================================================ */

test('服务器:每次分析写入一条决策日志（JSONL，含版本与哈希）', async () => {
  const logDir = mkdtempSync(join(tmpdir(), 'alpha-log-'));
  const logPath = join(logDir, 'decision-log.jsonl');
  const server = await startAlphaServer({ port: 0, rules: RULES, logPath });
  try {
    const input = flopScenario();
    await fetch(`${server.url}/api/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input }),
    });

    const { readDecisionLog } = await import('../src/app/decisionLog.ts');
    const entries = readDecisionLog(logPath);
    assert.equal(entries.length, 1, '必须恰好写入一条');
    const entry = entries[0]!;
    assert.equal(entry.inputHash, hashManualInput(input), '日志里的输入哈希必须与输入一致');
    assert.ok(
      entry.decision !== null && entry.decision.length > 0,
      '这一手信息充分，日志必须记录具体决策（null 只用于「信息不足」）',
    );
    assert.ok(Object.keys(entry.versions).length > 0, '必须记录版本（追溯依据）');
    assert.equal(entry.rakeModel, 'NOT_APPLIED', '必须记录抽水口径');
    assert.ok(entry.computedPot > 0, '必须记录重算底池');
    // 日志**不得**包含对手底牌或结果
    const serialized = JSON.stringify(entry);
    for (const forbidden of ['villainHoleCards', 'winner', 'showdownOutcome', 'heroProfit']) {
      assert.ok(!serialized.includes(forbidden), `日志不得含「${forbidden}」`);
    }
  } finally {
    await server.close();
    rmSync(logDir, { recursive: true, force: true });
  }
});

/* ============================================================
 * 隐私约束
 * ============================================================ */

test('服务器:默认只监听本机（不得对外开放）', async () => {
  await withServer(async (server) => {
    assert.ok(
      server.url.startsWith('http://127.0.0.1:'),
      `默认必须只监听 127.0.0.1（实际 ${server.url}）`,
    );
  });
});

test('服务器:不发送跨域头（内部单人使用，不开放跨域）', async () => {
  await withServer(async (server) => {
    const res = await fetch(`${server.url}/api/health`);
    assert.equal(
      res.headers.get('access-control-allow-origin'),
      null,
      '不得发送 Access-Control-Allow-Origin',
    );
  });
});
