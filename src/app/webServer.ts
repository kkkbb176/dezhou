/**
 * Alpha 内部测试服务器（最小中文 Web UI）
 *
 * ## 这个模块在端到端链中解决什么
 *
 * 让使用者**真的能打开网页、输入一手牌、拿到建议**。
 * 在这之前整条链只能通过测试与脚本访问 —— 那不是「可测试版本」。
 *
 * ## 为什么是 Node 内置 `http`
 *
 * 项目依赖只有 `typescript` 与 `@types/node`，**没有 web 框架**
 *（`package.json` 仅有 devDependencies）。
 * 为一个内部单人使用的表单页面引入 Express / Vite 属于过度工程，
 * 而且会新增一条需要审计的依赖链。
 *
 * ## 服务端职责边界（规范第 63 节）
 *
 * 服务端**不做任何策略判断**：
 * - 解析请求体 → 交给 `analyzeManualHand`
 * - 把 `DecisionViewModel` 原样返回给前端
 *
 * 前端也**不做策略判断**：它只渲染收到的字段。
 * 「建议：跟注」这句话从引擎一路传到屏幕，中间没有任何环节重新推导它。
 *
 * ## 隐私（规范第 91 节）
 *
 * - 默认只监听 `127.0.0.1`（**不是** 0.0.0.0）
 * - 无账户、无云同步、无遥测
 * - 不支持跨域（不发 `Access-Control-Allow-Origin`）
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { loadKnowledgeBaseOrThrow } from '../domain/knowledge/knowledgeLoader.ts';
import type { StrategyKnowledge } from '../domain/knowledge/knowledge.types.ts';
import { analyzeManualHand, prefetchSolverRangesForInput, queueBackgroundSolverRangesForInput, GtoRangeOutcomeState } from './alphaPipeline.ts';
import type { GtoPrefetchStatus } from './alphaPipeline.ts';
import { BackgroundSolveState, backgroundSolveQueue, type BackgroundSolveRecord } from './gto/backgroundSolve.ts';
import { parseManualInput, type ManualHandInput } from './manualInput/manualInput.ts';
import { buildAnalyzableState } from './manualInput/reconstruct.ts';
import {
  computeLayeredPot,
  describeLayeredPotZh,
  dedupeSettlementEvents,
  settlementEventsOf,
  SETTLEMENT_SCOPE_ZH,
  selfCheckLayeredPot,
} from '../domain/poker/pots.ts';
import type { RangeSource } from '../domain/range/range.types.ts';
import { selfCheckLikelihoodModel } from './manualInput/likelihoodModel.ts';
import { selfCheckPreflopPriors } from './manualInput/preflopPriors.ts';
import {
  RevisionGuard,
  handleTableRequest,
  parseTableState,
  tableMetadata,
  type TableApiDeps,
} from './table/tableApi.ts';
import { tableStateToManualHandInput } from './table/tableAdapter.ts';
import {
  gtoCatalog,
  gtoCapabilities,
  gtoCachedLookup,
  gtoHealth,
  gtoProvider,
  isGtoEnabled,
  catalogScenarioOf,
  gtoExtendedCatalog,
  queryGtoCatalogEntry,
  queryGtoExtendedEntry,
  selfCheckGtoLayer,
} from './gto/gtoApi.ts';
import { describeScenarioZh, scenarioHashOf } from '../domain/gto/gtoScenario.ts';
import {
  GtoScenarioKind,
  gtoTableSizeOf,
  type GtoPosition,
  type GtoScenario,
  type GtoTableSize,
} from '../domain/gto/gto.types.ts';

export type ServerOptions = {
  port?: number;
  host?: string;
  /** 决策日志路径；`null` 表示不写日志（测试用） */
  logPath?: string | null;
  /** 知识层规则（默认从 `data/knowledge/` 加载一次） */
  rules?: readonly StrategyKnowledge[];
  /**
   * 🔴 **后台补算开关**（Phase 1.3）。
   *
   * 缓存未命中时是否把该场景排进后台求解队列。默认 `true` ——
   * 关掉它等于「第一次用永远是启发式范围」，而那正是本轮要修的问题。
   *
   * 关掉的唯一合理场景是**测试**（后台任务会在测试进程退出后才跑完，
   * 让「进程为什么还在跑」变得难以解释）。
   */
  gtoBackgroundSolve?: boolean;
};

export type AlphaServer = {
  server: Server;
  url: string;
  close: () => Promise<void>;
};

const DEFAULT_PORT = 5173;
const DEFAULT_HOST = '127.0.0.1';

/* ============================================================
 * 静态页面
 * ============================================================ */

function pagePath(): string {
  return fileURLToPath(new URL('./web/index.html', import.meta.url));
}

function gtoPagePath(): string {
  return fileURLToPath(new URL('./web/gto.html', import.meta.url));
}

function readPage(): string {
  return readFileSync(pagePath(), 'utf8');
}

function readGtoPage(): string {
  return readFileSync(gtoPagePath(), 'utf8');
}

/** 读取同目录下的静态资源；不存在时返回 `null`（不抛） */
function readAsset(name: string): string | null {
  try {
    return readFileSync(fileURLToPath(new URL(`./web/${name}`, import.meta.url)), 'utf8');
  } catch {
    return null;
  }
}

/* ============================================================
 * 请求体解析
 * ============================================================ */

/**
 * 请求体上限。
 *
 * 🔴 红队命中：原来是 128KB，而**客户端自己持有并回传整副牌桌状态**
 *（含撤销栈）。实测一手 24 条行动 + 36 层撤销栈 = 87.7KB，
 * 再点十几次就超过 128KB → `req.destroy()` 让客户端只看到 `fetch failed`，
 * 而且它会**一直重发同一个超限状态**，只能刷新页面（等于丢桌）。
 *
 * 现在：
 * - 上限提到 1MB（内部单人工具，状态最大也就 ~200KB）
 * - 超限时返回**可读的 413 JSON**，而不是直接掐断连接
 * - `MAX_UNDO_DEPTH` 同时收紧到 40，让常态负载远低于上限
 */
const MAX_BODY_BYTES = 1024 * 1024;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;
    req.on('data', (chunk: Buffer) => {
      if (aborted) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        aborted = true;
        const error = new Error(
          `请求体过大（上限 ${MAX_BODY_BYTES} 字节 = ${Math.round(MAX_BODY_BYTES / 1024)}KB，` +
            `收到超过 ${Math.round(size / 1024)}KB）。` +
            '这通常意味着牌桌状态异常膨胀 —— 请刷新页面重新开始，并把这个现象反馈给开发者。',
        );
        error.name = 'BODY_TOO_LARGE';
        // 先把响应发出去，再停止读取；不 destroy，否则客户端只能看到 fetch failed
        reject(error);
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * 解析「有效筹码」参数（2026-09 修正轮）。
 *
 * ## 三条纪律
 *
 * | 输入 | 处理 | 为什么 |
 * |---|---|---|
 * | 缺省（`null` / `''`） | 按 **100BB** | GTOpen Phase 1 的目标筹码；也让老调用方逐位不变 |
 * | 正数（≤ `MAX_EFFECTIVE_STACK_BB`） | 采用 | 筹码是真实的一级场景参数 |
 * | 其它（0 / 负数 / NaN / 超上限 / 乱填） | **明确报错** | 绝不静默退回 100BB —— 那正是「界面写 50BB、数据是 100BB」的来源 |
 */
function parseEffectiveStackBB(raw: string | null): { value: number } | { errorZh: string } {
  if (raw === null || raw.trim() === '') return { value: 100 };
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    return {
      errorZh: `有效筹码必须是正数（收到「${raw}」）—— 不会退回默认 100BB 冒充这次查询。`,
    };
  }
  if (value > MAX_EFFECTIVE_STACK_BB) {
    return {
      errorZh:
        `有效筹码上限 ${MAX_EFFECTIVE_STACK_BB}BB（收到 ${value}BB）—— ` +
        '更大的筹码会让动作树急剧膨胀且没有实际意义。',
    };
  }
  return { value };
}

/** 有效筹码上限（防御性护栏，不是「GTOpen 只支持到这个数」的声明） */
const MAX_EFFECTIVE_STACK_BB = 1000;

function sendJson(res: ServerResponse, status: number, payload: unknown): void {  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body, 'utf8'),
    // 内部单人使用：明确不开放跨域
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

/* ============================================================
 * 服务器
 * ============================================================ */

/**
 * 启动 Alpha 内部测试服务器。
 *
 * ## 路由
 *
 * | 方法 | 路径 | 作用 |
 * |---|---|---|
 * | GET | `/` | 牌桌界面（交互式录入） |
 * | GET | `/table.css` / `/table.js` | 静态资源（无构建步骤） |
 * | GET | `/api/health` | 健康检查（含知识库版本） |
 * | GET | `/api/table/meta` | 枚举与中文标签（前端零硬编码） |
 * | POST | `/api/table` | 新建牌桌 / 应用一个牌桌操作 → 返回状态 + 预览 |
 * | POST | `/api/analyze` | 分析一手牌：接受 `{ table }` 或 `{ input }` |
 *
 * ## 服务端**无游戏状态**
 *
 * 牌桌状态由客户端持有并回传，服务端只做「校验 → 操作 → 预览」。
 * 唯一的例外是 `RevisionGuard` 的版本水位线 —— 它是传输层护栏，不是游戏状态。
 */
export async function startAlphaServer(options: ServerOptions = {}): Promise<AlphaServer> {
  const port = options.port ?? DEFAULT_PORT;
  const host = options.host ?? DEFAULT_HOST;
  const rules = options.rules ?? loadKnowledgeBaseOrThrow().allRules();

  /**
   * 牌桌请求的依赖。
   *
   * ⚠️ `tableId` 用**进程内自增计数**而不是 `Date.now()`：
   * 时间戳会让「同一次会话的同一个动作」在不同毫秒下得到不同的状态，
   * 使重放与比对变得不可能。计数器是确定性的。
   */
  const tableSeq = { n: 0 };
  const tableDeps: TableApiDeps = {
    newTableId: () => {
      tableSeq.n += 1;
      return `t${tableSeq.n}`;
    },
    guard: new RevisionGuard(),
  };

  // ---- 启动自检（Fail-Closed）----
  //
  // 🔴 红队 F-02 的根因是「自检函数写了但**零调用者**」——
  // 于是 `tierOfRankClassIndex` 造成的牌力倒挂（QQ 的进攻似然 0.5938 <
  // A7s 的 0.9500）在系统里活了很久，没有任何东西会说话。
  //
  // 现在两个自检在这里**真的被调用**，且**失败即拒绝启动**：
  // 一个范围模型坏掉的服务器，给出的建议比「没有建议」危险得多。
  // 宁可起不来，也不要静默地给错建议。
  const selfCheckProblems = [...selfCheckLikelihoodModel(), ...selfCheckPreflopPriors()];
  if (selfCheckProblems.length > 0) {
    throw new Error(
      `Alpha 服务器拒绝启动：范围/似然模型自检失败（${selfCheckProblems.length} 项）。\n` +
        selfCheckProblems.map((p) => `  · ${p}`).join('\n'),
    );
  }

  // ---- GTO 场景目录自检（Fail-Closed，但**不依赖求解器在线**）----
  //
  // 为什么也放在启动自检里：目录决定了「界面上能选哪些场景」，
  // 一个错位的目录会让 4 人桌的 BTN 读到 6 人桌的节点 ——
  // 而这种错误在界面上**完全看不出来**（两边都写着 BTN）。
  // 因此它必须在服务器起来之前就被验一遍。
  const gtoProblems = selfCheckGtoLayer();
  if (gtoProblems.length > 0) {
    throw new Error(
      `Alpha 服务器拒绝启动：GTO 场景目录自检失败（${gtoProblems.length} 项）。\n` +
        gtoProblems.map((p) => `  · ${p}`).join('\n'),
    );
  }

  // ---- 分层底池自检（Fail-Closed）----
  //
  // 底池分层一旦算错，**底池赔率、跟注 EV、可赢上限全线偏移**，
  // 而那种偏移在界面上完全看不出来（数字都很"正常"）。
  // 因此它必须与其它自检一样，在服务器起来之前验一遍守恒不变量：
  // 「主池 + 边池 + 退回 === 所有人投入之和」。
  const potProblems = selfCheckLayeredPot();
  if (potProblems.length > 0) {
    throw new Error(
      `Alpha 服务器拒绝启动：分层底池自检失败（${potProblems.length} 项）。\n` +
        potProblems.map((p) => `  · ${p}`).join('\n'),
    );
  }

  const server = createServer((req, res) => {
    void handleRequest(req, res, rules, options, tableDeps);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const address = server.address();
  const actualPort = typeof address === 'object' && address !== null ? address.port : port;

  return {
    server,
    url: `http://${host}:${actualPort}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  rules: readonly StrategyKnowledge[],
  options: ServerOptions,
  tableDeps: TableApiDeps,
): Promise<void> {
  try {
    const rawUrl = req.url ?? '/';
    /*
     * 🔴 路径与查询串必须**分开**（2026-09 修正轮）。
     *
     * 下面所有路由都是 `url === '/api/xxx'` 的精确匹配，因此带查询串的请求
     * （例如 `/api/gto/catalog/extended?effectiveStackBB=50`）此前会落空 404。
     * 现在 `url` 只保留路径，查询串由 `params` 提供。
     */
    const queryAt = rawUrl.indexOf('?');
    const url = queryAt < 0 ? rawUrl : rawUrl.slice(0, queryAt);
    const params = new URLSearchParams(queryAt < 0 ? '' : rawUrl.slice(queryAt + 1));
    const method = req.method ?? 'GET';

    if (method === 'GET' && (url === '/' || url === '/index.html')) {
      const html = readPage();
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': Buffer.byteLength(html, 'utf8'),
        'Cache-Control': 'no-store',
      });
      res.end(html);
      return;
    }

    // ---- 静态资源（无构建步骤：浏览器直接拿 TS 之外的纯 JS/CSS）----
    if (method === 'GET' && (url === '/table.css' || url === '/table.js')) {
      const asset = readAsset(url === '/table.css' ? 'table.css' : 'table.js');
      if (asset === null) {
        sendJson(res, 404, {
          ok: false,
          stage: 'REQUEST',
          issues: [{ code: 'NOT_FOUND', message: `找不到资源：${url}` }],
        });
        return;
      }
      res.writeHead(200, {
        'Content-Type':
          url === '/table.css' ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8',
        'Content-Length': Buffer.byteLength(asset, 'utf8'),
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(asset);
      return;
    }

    // ---- GTO 范围页（新增页面；与牌桌页共用同一份 CSS 变量）----
    if (method === 'GET' && (url === '/gto' || url === '/gto.html')) {
      const html = readGtoPage();
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': Buffer.byteLength(html, 'utf8'),
        'Cache-Control': 'no-store',
      });
      res.end(html);
      return;
    }

    if (method === 'GET' && (url === '/gto.css' || url === '/gto.js')) {
      const asset = readAsset(url === '/gto.css' ? 'gto.css' : 'gto.js');
      if (asset === null) {
        sendJson(res, 404, {
          ok: false,
          stage: 'REQUEST',
          issues: [{ code: 'NOT_FOUND', message: `找不到资源：${url}` }],
        });
        return;
      }
      res.writeHead(200, {
        'Content-Type':
          url === '/gto.css' ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8',
        'Content-Length': Buffer.byteLength(asset, 'utf8'),
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(asset);
      return;
    }

    if (method === 'GET' && url === '/api/health') {
      sendJson(res, 200, {
        ok: true,
        knowledgeRules: rules.length,
        // 让使用者能确认「服务跑的是哪个知识库版本」
        mode: 'INTERNAL_ALPHA',
        tableInput: 'INTERACTIVE',
        // GTO 是**可选**能力：这里只报告它是否启用，不影响 Alpha 自身的可用性
        gto: isGtoEnabled() ? 'ENABLED' : 'DISABLED',
      });
      return;
    }

    if (method === 'GET' && url === '/api/table/meta') {
      sendJson(res, 200, { ok: true, meta: tableMetadata() });
      return;
    }

    /* ---- GTO 范围（新增；GTOpen 不可用时全部返回可展示的「不可用」状态） ---- */

    if (method === 'GET' && url === '/api/gto/health') {
      const health = await gtoHealth();
      sendJson(res, 200, {
        ok: true,
        enabled: isGtoEnabled(),
        health,
        capabilities: await gtoCapabilities(),
      });
      return;
    }

    if (method === 'GET' && url === '/api/gto/catalog') {
      // 纯本地计算：**不需要**求解器在线。界面因此永远能渲染出选择器。
      sendJson(res, 200, gtoCatalog());
      return;
    }

    /* ---- Phase 1.1：扩展场景目录（面对开池 / 面对 3Bet / 面对 4Bet）---- */
    if (method === 'GET' && url === '/api/gto/catalog/extended') {
      /*
       * 🔴 有效筹码是**一级场景参数**（2026-09 修正轮）。
       *
       * 同一个条目 id 在 100BB 与 50BB 下是不同节点（`scenarioHash` 不同，
       * 频率也不同 —— 实测 6 人桌 UTG 开池 AA 加注：100BB 93.4% / 50BB 97.4% /
       * 40BB 86.5% / 200BB 75.1%）。因此目录也必须按筹码生成，
       * 否则下拉框里的 `supported` 标记会与用户选中的筹码不一致。
       */
      const stack = parseEffectiveStackBB(params.get('effectiveStackBB'));
      if ('errorZh' in stack) {
        sendJson(res, 200, {
          ok: false,
          status: 'UNAVAILABLE',
          messageZh: stack.errorZh,
          entries: [],
        });
        return;
      }
      sendJson(res, 200, gtoExtendedCatalog(undefined, 2, stack.value));
      return;
    }

    if (method === 'POST' && url === '/api/gto/range/extended') {
      const raw = await readBody(req);
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        sendJson(res, 400, {
          ok: false,
          status: 'INVALID_RESPONSE',
          messageZh: '请求体不是合法 JSON',
          baseline: null,
        });
        return;
      }
      const body =
        parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : null;
      const entryId = body === null ? undefined : body['entryId'];
      if (typeof entryId !== 'string') {
        sendJson(res, 200, {
          ok: false,
          status: 'UNAVAILABLE',
          messageZh:
            '缺少 entryId —— 扩展场景必须通过**目录条目 id** 查询，界面不得自己拼场景。',
          verificationZh: null,
          approximate: false,
          approximationNotes: [],
          baseline: null,
          stats: null,
          quality: null,
          cache: null,
          fingerprintLines: [],
        });
        return;
      }

      /*
       * 🔴 有效筹码必须**真的参与场景构造**（2026-09 修正轮）。
       *
       * 修复前这个端点只读 `entryId`，于是 GTO 页顶栏那个「有效筹码」
       * 输入框虽然可编辑、却完全无效：用户填 50 拿到的是 100BB 的策略，
       * 而且页面上没有任何线索。现在它被传进场景构建器 ——
       * 报告无法表达的筹码时如实说明，**绝不**退回 100BB 冒充。
       */
      const stackRaw = body === null ? null : body['effectiveStackBB'];
      const stack = parseEffectiveStackBB(
        typeof stackRaw === 'number' || typeof stackRaw === 'string' ? String(stackRaw) : null,
      );
      if ('errorZh' in stack) {
        sendJson(res, 200, {
          ok: false,
          status: 'UNAVAILABLE',
          messageZh: stack.errorZh,
          verificationZh: null,
          approximate: false,
          approximationNotes: [],
          baseline: null,
          stats: null,
          quality: null,
          cache: null,
          fingerprintLines: [],
        });
        return;
      }

      const result = await queryGtoExtendedEntry(entryId, stack.value);
      const entry = gtoExtendedCatalog(undefined, 2, stack.value).entries.find(
        (e) => e.id === entryId,
      );
      sendJson(res, 200, {
        ...result,
        /*
         * 🔴 场景标签**必须带筹码**（2026-09 修正轮）。
         *
         * 条目 id 与 `labelZh`（如「BB vs BTN 开池」）都**不含筹码** ——
         * 同一个标签在 100BB 与 50BB 下对应两种不同策略。修复前这里只贴
         * 「6 人桌 · BB vs BTN 开池」，于是用户无法从界面上分辨屏幕上这份
         * 数据是哪个筹码算的。现在按与基础路径同源的格式写成
         * 「6 人桌 / 50BB · BB vs BTN 开池」。
         */
        ...(entry === undefined
          ? {}
          : {
              scenarioZh: `${entry.tableSize} 人桌 / ${stack.value}BB · ${entry.labelZh}`,
              /*
               * 与基础端点（`/api/gto/range`）保持同源：都下发场景哈希，
               * 让「为什么是这个数字」面板与缺陷排查有同一个锚点。
               * ⚠️ 它来自**条目**（按本次筹码构造），不是求解器回执 —— 因此
               * 假求解器下也有值，可以断言「筹码真的进了场景」。
               */
              scenarioHash: entry.scenarioHash,
            }),
      });
      return;
    }

    if (method === 'POST' && url === '/api/gto/range') {
      const raw = await readBody(req);
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        sendJson(res, 400, {
          ok: false,
          status: 'INVALID_RESPONSE',
          messageZh: '请求体不是合法 JSON',
          baseline: null,
        });
        return;
      }
      const body =
        parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : null;
      if (body === null) {
        sendJson(res, 400, {
          ok: false,
          status: 'INVALID_RESPONSE',
          messageZh: '请求体必须是一个 JSON 对象',
          baseline: null,
        });
        return;
      }

      const tableSizeRaw = body['tableSize'];
      const heroPositionRaw = body['heroPosition'];
      const templateRaw = body['template'];
      if (typeof tableSizeRaw !== 'number') {
        sendJson(res, 200, {
          ok: false,
          status: 'UNAVAILABLE',
          messageZh:
            '缺少 tableSize（牌桌人数）。它是**一级场景参数**，必须显式给出，' +
            '不允许从位置名推断 —— 同一个位置名在不同人数下是完全不同的决策节点。',
          verificationZh: null,
          approximate: true,
          approximationNotes: [],
          baseline: null,
          stats: null,
        });
        return;
      }
      const result = await queryGtoCatalogEntry({
        tableSize: tableSizeRaw,
        heroPosition: typeof heroPositionRaw === 'string' ? heroPositionRaw : '',
        template: typeof templateRaw === 'string' ? templateRaw : '',
        ...(typeof body['effectiveStackBB'] === 'number'
          ? { effectiveStackBB: body['effectiveStackBB'] }
          : {}),
        ...(typeof body['openSizeBB'] === 'number' ? { openSizeBB: body['openSizeBB'] } : {}),
      });
      const scenario = catalogScenarioOf({
        tableSize: tableSizeRaw,
        heroPosition: typeof heroPositionRaw === 'string' ? heroPositionRaw : '',
        template: typeof templateRaw === 'string' ? templateRaw : '',
        ...(typeof body['effectiveStackBB'] === 'number'
          ? { effectiveStackBB: body['effectiveStackBB'] }
          : {}),
      });
      sendJson(res, 200, {
        ...result,
        ...(scenario === null
          ? {}
          : { scenarioZh: describeScenarioZh(scenario), scenarioHash: scenarioHashOf(scenario) }),
      });
      return;
    }

    if (method === 'POST' && url === '/api/table') {
      const raw = await readBody(req);
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        sendJson(res, 400, {
          ok: false,
          issues: [{ code: 'BAD_JSON', message: '请求体不是合法 JSON' }],
        });
        return;
      }
      const result = handleTableRequest(parsed, tableDeps);
      sendJson(res, 200, result);
      return;
    }

    if (method === 'POST' && url === '/api/analyze') {
      const raw = await readBody(req);
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        sendJson(res, 400, {
          ok: false,
          stage: 'REQUEST',
          issues: [{ code: 'BAD_JSON', message: '请求体不是合法 JSON' }],
        });
        return;
      }

      // ---- 两种入口：`{ table }`（牌桌路径）或 `{ input }`（表单路径）----
      //
      // 🔴 牌桌路径**必须**复用同一个 `tableStateToManualHandInput`，
      //    否则「屏幕显示」与「实际提交」就有了两条可能分叉的代码路径。
      //
      // ⚠️ `parsed` 可能是 `null`（请求体就是 `null`）或标量（`42` / `"x"`）——
      //    直接取属性会抛出 TypeError 并变成 500（红队 V-MAL 命中）。
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        sendJson(res, 400, {
          ok: false,
          stage: 'REQUEST',
          issues: [{ code: 'BAD_BODY', message: '请求体必须是一个 JSON 对象' }],
        });
        return;
      }
      const body = parsed as { input?: unknown; table?: unknown };
      let input: unknown = body.input;
      const tableRaw = body.table;

      if (input === undefined && tableRaw !== undefined) {
        const parsedTable = parseTableState(tableRaw);
        if (!parsedTable.ok) {
          sendJson(res, 200, {
            ok: false,
            stage: 'REQUEST',
            issues: parsedTable.issues,
          });
          return;
        }
        const adapted = tableStateToManualHandInput(parsedTable.state);
        if (!adapted.ok) {
          sendJson(res, 200, {
            ok: false,
            stage: 'REQUEST',
            issues: adapted.issues,
          });
          return;
        }
        input = adapted.input;
      }

      if (input === null || typeof input !== 'object') {
        sendJson(res, 400, {
          ok: false,
          stage: 'REQUEST',
          issues: [
            {
              code: 'MISSING_INPUT',
              message: '缺少 input 或 table 字段（应为 ManualHandInput 或 PokerTableState）',
            },
          ],
        });
        return;
      }

      /*
       * 🔴 **求解器范围取数**（Phase 1.3）—— 在分析**之前**做，且**只读缓存**。
       *
       * `analyzeManualHand` 是同步纯函数；查 GTOpen 是异步网络动作。
       * 因此「取数据」在这里 await，「算决策」交给下面的同步调用。
       *
       * ## 四条纪律
       *
       * 1. **GTO 关闭时不发任何请求** —— 与 `/api/gto/*` 的行为一致。
       * 2. **前台绝不求解**：只读内存 / 持久化缓存，未命中立刻回落。
       *    实测冷求解 6 人桌 59 秒、9 人桌 195 秒 —— 让前台等它，
       *    等于放弃「1～3 秒给建议」这个核心指标。
       * 3. **未命中就排后台**（见下面的 `queueBackgroundSolverRangesForInput`），
       *    求解完成后**自动落盘**，于是**第二次同样的局面直接命中 GTO 范围**。
       * 4. **失败不阻断、不静默**：回落启发式，但原因一路带到响应里
       *   （`gtoStatus`），使用者永远能知道「这条建议为什么不是 GTO」。
       */
      const gtoPrefetched = isGtoEnabled()
        ? await prefetchSolverRangesForInput(input as ManualHandInput, {
            gtoProvider: gtoProvider(),
            gtoLookup: gtoCachedLookup(),
          })
        : {
            ranges: {} as Record<string, never>,
            warnings: [] as string[],
            outcomes: [],
            elapsedMs: 0,
          };

      /*
       * 后台补算：**刻意不 await**。
       *
       * 这一步必须在响应生成**之前**发起（这样求解与渲染并行），
       * 但绝不能等它 —— `queueBackgroundSolverRangesForInput` 返回的是
       * 「入队状态」而不是求解结果，从类型上就杜绝了误等。
       */
      const background =
        isGtoEnabled() && options.gtoBackgroundSolve !== false
          ? queueBackgroundSolverRangesForInput(input as ManualHandInput, {
              gtoProvider: gtoProvider(),
              gtoLookup: gtoCachedLookup(),
            })
          : [];

      const gtoStatus = buildGtoStatusJson(gtoPrefetched, background);

      /*
       * 🔴 **分层底池要在路由里单独算一次**（2026-09 边池轮）。
       *
       * 为什么不能从 `result` 里取：`analyzeManualHand` 的产出一路只带
       * **决策所需**的量，而「主池/边池/退回」是**呈现层**的事 ——
       * 决策引擎不需要它（它只用可争夺量，那已经体现在所需权益与 EV 里）。
       *
       * ⚠️ 这里必须用**与决策同一次解析**的状态，因此复走一遍
       * `parseManualInput` → `buildAnalyzableState`（与
       * `prefetchSolverRangesForInput` 用的是同一对函数）。
       * 失败时返回 `null`：那种情况下上面的 `analyzeManualHand` 已经
       * 给出了结构化的失败响应，这里不需要也不应该抢答。
       */
      const analysisState = (() => {
        const parsed = parseManualInput(input as ManualHandInput);
        if (!parsed.ok) return null;
        const gate = buildAnalyzableState(parsed.value);
        return gate.ok ? gate.state : null;
      })();

      const result = analyzeManualHand(input as ManualHandInput, {
        rules,
        asOf: Date.now(),
        ...(Object.keys(gtoPrefetched.ranges).length > 0
          ? { gtoRanges: gtoPrefetched.ranges }
          : {}),
        ...(options.logPath !== undefined && options.logPath !== null
          ? { logPath: options.logPath }
          : {}),
        ...(options.logPath === null ? { writeLog: false } : {}),
      });

      if (!result.ok) {
        sendJson(res, 200, {
          ok: false,
          stage: result.stage,
          issues: result.issues,
          timings: result.timings,
        });
        return;
      }

      sendJson(res, 200, {
        ok: true,
        viewModel: result.viewModel,
        decision: {
          action: result.decision.action,
          sizeChips: result.decision.sizeChips ?? null,
          sizeBB: result.decision.sizeBB ?? null,
          confidence: result.decision.confidence,
          band: result.decision.band,
          classification: result.decision.classification,
          actionable: result.decision.actionable,
        },
        /*
         * 🔴 **范围来源必须跟着建议一起回传**。
         *
         * 为什么不能只放在固定「说明」区里：那句话说的是「本项目**一般**用启发式范围」，
         * 而使用者需要知道的是「**这一条**建议用了什么范围、可不可信」。
         * 两者不是同一句话 —— 前者是免责声明，后者是证据。
         *
         * 数据来源是 `decision.diagnostics.opponentRanges`，
         * 也就是**这一次决策真正拿去算权益的那些范围**（不是重新构建一份）。
         */
        rangeProvenance: result.decision.diagnostics.opponentRanges.map((r) => ({
          positionZh: r.opponentPositionZh,
          sourceKind: r.sourceKind,
          /*
           * 🔴 中文说明取**具体来源描述**，不取 `sourceKind` 的通用标签。
           *
           * 踩过的坑：求解器范围的 `sourceKind` 是 `EMPIRICAL`（刻意不用
           * `THEORY_SOURCE` —— 那会把它抬高成「理论来源」），于是界面上
           * 显示成「经验数据（有依据，但未达已验证标准）」，
           * 与同一行里「求解器翻前范围」的说明**互相矛盾**，使用者无从判断
           * 这份范围到底是不是算出来的。
           *
           * 通用标签只说「可信到什么程度」，而使用者需要知道的是
           * 「**它是什么**」。后者只有 `sourceDescription` 有。
           */
          sourceZh: r.sourceDescription,
          sourceKindZh: rangeSourceZh(r.sourceKind),
          /*
           * 🔴 **显式标记「这份范围是不是求解器算的」**，不让界面去猜。
           *
           * 为什么不靠 `sourceKind`：求解器范围刻意用 `EMPIRICAL`
           *（不用 `THEORY_SOURCE` —— 翻前是**近似模型**，标成理论来源会抬高它），
           * 而真正的经验数据**也**是 `EMPIRICAL`。两者在 `sourceKind` 上
           * **分不开**，界面靠它判断就会把启发式说成求解器、或反过来。
           *
           * 判据用 `sourceId` 的**结构化前缀**（`solver.` / `heuristic.`）——
           * 那是 `contextBuilder` 与 `preflopPriors` 各自写死的前缀，
           * 比在中文描述里搜字符串可靠。
           */
          fromSolver: rangeIsFromSolver(r.sourceId),
          confidence: r.confidence,
          supportSize: r.supportSize,
          collapsed: r.collapsed,
          /*
           * 🔴 这一家的**取数结局**（Phase 1.3）。
           *
           * 为什么必须逐家带上：`fromSolver: false` 有**三种完全不同的原因**
           *（正在算 / 算失败 / 这局面结构上算不了），使用者要采取的行动
           * 也完全不同（等一下 / 去看求解器 / 接受启发式）。
           * 只给一个布尔值等于把这三件事混成一件 —— 那是本轮的原始缺陷。
           */
          ...gtoStatusFor(gtoStatus, r.opponentPositionZh),
        })),
        gtoStatus,
        meta: {
          computedPot: result.computedPot,
          claimedPot: result.claimedPot,
          inputHash: result.log.inputHash,
          timings: result.timings,
          /*
           * 🔴 **分层底池**（2026-09 边池轮）。
           *
           * 为什么要露出来：短筹码全下时**赢不到全部底池**，
           * 而使用者看不到这件事就会高估自己的处境。
           * 修复前底池只是一个整池数字，主池/边池/退回全都看不见。
           *
           * ⚠️ 只做**如实呈现**，不做任何派彩声称 —— 本项目不发池，
           * 因此这里给的是「钱是怎么分的」，不是「谁会赢」。
           */
          layeredPot: (() => {
            if (analysisState === null) return null;
            const layered = computeLayeredPot(analysisState);
            const returnedSum = Object.values(layered.returned).reduce((a, b) => a + b, 0);
            const pendingSum = Object.values(layered.pendingUnmatched).reduce((a, b) => a + b, 0);
            /*
             * 🔴 **结算事件必须带稳定 id，并在服务端就去重**（RIVER CONSISTENCY V2 §18）。
             *
             * 修复前这里只给「几行文本」，客户端又自己拼了一遍「无人跟注、退回 X」
             * ⇒ 同一件事在界面上出现两次，且没有任何标识能判断它们是不是同一件事。
             */
            const street = analysisState.street ?? null;
            const { events, duplicateIds } = dedupeSettlementEvents(
              settlementEventsOf(layered, street),
            );
            return {
              total: layered.total,
              contested: layered.contested,
              main: layered.main,
              sideTotal: layered.sideTotal,
              returned: layered.returned,
              returnedTotal: returnedSum,
              /*
               * 🔴 **尚未匹配**的超额（下注轮未结束）。它与 `returned` 的金额
               * 可能一样，但**时序完全不同**：这笔钱只是还没人跟，
               * 不是退回。界面必须分开显示，否则会在决策节点提前结算。
               */
              pendingUnmatched: layered.pendingUnmatched,
              pendingTotal: pendingSum,
              roundClosed: layered.roundClosed,
              /*
               * 🔴 **结算作用域**（RIVER CONSISTENCY V2.1 · P1-2）：
               * 让界面能说清「这次的退回/未匹配是按哪条规则算的」——
               * 单挑关闭轮次允许简化未匹配路径，多人/全下必须走投入台账分层。
               */
              scope: layered.scope,
              scopeZh: SETTLEMENT_SCOPE_ZH[layered.scope],
              events,
              duplicateEventIds: duplicateIds,
              /**
               * 是否出现「有人跟不起」的分层。
               *
               * 🔴 **只用最终事件**判断：下注轮未结束时那笔「尚未匹配」
               * 不该让界面弹出「退回」面板（那正是修复前的误导）。
               */
              hasLayering: layered.sideTotal > 0 || returnedSum > 0,
              hasPendingUnmatched: pendingSum > 0,
              linesZh: describeLayeredPotZh(layered, street),
            };
          })(),
          /*
           * 🔴 GTO 取数的原因**必须**在这里露出来（Phase 1.3 修复）。
           *
           * 修复前 `gtoPrefetched.warnings` 算出来就被丢掉了 ——
           * 于是「为什么用的是启发式范围」在界面上**无从得知**，
           * 使用者只看到一个「启发式先验」标签。
           */
          warnings: [...result.warnings, ...gtoStatus.warnings],
        },
      });
      return;
    }

    sendJson(res, 404, {
      ok: false,
      stage: 'REQUEST',
      issues: [{ code: 'NOT_FOUND', message: `未定义的路由：${method} ${url}` }],
    });
  } catch (error) {
    // 请求体超限 → **413 + 可读中文**（不是 500，也不是掐断连接）
    const isTooLarge = error instanceof Error && error.name === 'BODY_TOO_LARGE';
    if (isTooLarge) {
      sendJson(res, 413, {
        ok: false,
        stage: 'REQUEST',
        issues: [{ code: 'BODY_TOO_LARGE', message: (error as Error).message }],
      });
      return;
    }
    // 任何未预期异常都必须变成结构化响应 —— 绝不能 hang 或返回半截对象
    sendJson(res, 500, {
      ok: false,
      stage: 'SERVER',
      issues: [{ code: 'INTERNAL_ERROR', message: `服务端异常：${(error as Error).message}` }],
    });
  }
}

/**
 * 范围来源的中文说明（**给使用者看的**，不是给开发者看的）。
 *
 * 🔴 这份映射存在的唯一理由：**使用者必须能一眼看出这条建议的范围可不可信**。
 * 项目里最容易发生的事故是把「启发式先验 + 可信度 0.3」的建议当成可靠结论执行，
 * 因此 `HEURISTIC` 的措辞刻意写得**不能产生误解**：
 *
 * - 不写「启发式范围」（那是个中性词，看不出问题）
 * - 写「自建启发式**先验**，**非**求解器输出」+ 明确的可信度数字
 *
 * ⚠️ `TEST_ONLY` 出现在生产建议里是**严重缺陷**（`rangeProvenance.ts` 明令禁止），
 * 因此它的文案必须刺眼 —— 宁可界面难看，也不要静默地把合成数据当策略。
 */
function rangeSourceZh(kind: RangeSource): string {
  switch (kind) {
    case 'THEORY_SOURCE':
      return '理论来源（求解器输出 / 权威公开数据集）';
    case 'VERIFIED_DATA':
      return '实测数据（真实牌局统计，样本充分）';
    case 'USER_DEFINED':
      return '用户自定义';
    case 'EMPIRICAL':
      return '经验数据（有依据，但未达「已验证」标准）';
    case 'HEURISTIC':
      return '自建启发式先验 —— **非**求解器输出、**非**实测数据';
    case 'FALLBACK':
      return '⚠️ 兜底范围（不是可信来源，置信度已下调）';
    case 'TEST_ONLY':
      return '🔴 测试用合成数据 —— 出现在建议里属于严重缺陷';
    default:
      return String(kind);
  }
}

/**
 * 这份范围是不是**求解器算出来的**。
 *
 * 🔴 判据是 `sourceId` 的**结构化前缀**，不是在中文描述里搜字符串。
 *
 * | 前缀 | 出处 | 含义 |
 * |---|---|---|
 * | `solver.` | `contextBuilder`（`solverRangeOverride` 分支） | GTOpen 频率 |
 * | `heuristic.` | `preflopPriors.PREFLOP_PRIOR_PROVENANCE` | 自建启发式先验 |
 *
 * 为什么不能在描述里搜「求解器」三个字：启发式的描述里也有
 *「**非**求解器输出」—— 搜字符串会命中它，把猜的判成算的。
 *（这个坑在本轮真的踩过一次，见 `test/alphaWebServer.test.ts`。）
 */
function rangeIsFromSolver(sourceId: string): boolean {
  return sourceId.startsWith('solver.');
}

/* ============================================================
 * GTO 取数状态的响应形状（Phase 1.3）
 * ============================================================ */

/** `gtoStatus` 的 JSON 形状（界面直接消费） */
type GtoStatusJson = {
  enabled: boolean;
  state: string;
  messageZh: string;
  elapsedMs: number;
  outcomes: readonly Record<string, unknown>[];
  background: readonly Record<string, unknown>[];
  warnings: readonly string[];
  /**
   * 具体原因（逐条中文）。
   *
   * ⚠️ 与 `warnings` 的区别：`warnings` 是**逐家**的（一家一条），
   * 而 `reasons` 是**可直接显示的具体理由**——包括「一个对手都枚举不出来」
   * 这一类（那时没有 outcome 可挂，理由只存在于 warnings 里）。
   * 界面渲染后者，使用者才能看到**具体**是哪一家、为什么，
   * 而不是一句笼统的「本手没有可映射的对手」。
   */
  reasons: readonly string[];
};

/**
 * 🔴 **GTO 取数状态**（Phase 1.3）—— 界面上「这条建议为什么不是 GTO」的答案。
 *
 * ## 为什么要单独一个结构，而不是只看 `rangeProvenance[].fromSolver`
 *
 * `fromSolver: false` 是一个**结论**，不是**原因**。而它有三种原因，
 * 对使用者意味着三件完全不同的事：
 *
 * | 原因 | 使用者该做什么 |
 * |---|---|
 * | 正在后台计算 | 等一会儿重看（**会自动变成 GTO**） |
 * | 计算失败 | 去看求解器（**不会自己好**） |
 * | 这局面结构上算不了 | 接受启发式（**等也没用**） |
 *
 * 把这三件事混成一个「启发式」标签，正是本轮要修的原始缺陷。
 *
 * ## `elapsedMs` 为什么也要露出来
 *
 * 它是「前台没有在等求解器」的**证据**。修复前这个数可以是 195 312 ms；
 * 现在必然是几次磁盘读（毫秒级）。把这个数字放进响应，
 * 任何人（包括下一次接手的人）都能一眼看出这件事有没有退化。
 */
function buildGtoStatusJson(
  prefetched: GtoPrefetchStatus,
  background: readonly BackgroundSolveRecord[],
): GtoStatusJson {
  const enabled = isGtoEnabled();
  const outcomes = prefetched.outcomes.map((o) => ({
    opponentId: o.opponentId,
    position: o.position,
    positionZh: o.positionZh,
    state: o.state,
    fromSolver: o.fromSolver,
    cacheSource: o.cacheSource,
    reasonZh: o.reasonZh,
  }));

  const backgroundJson = background.map((b) => ({
    cacheKey: b.cacheKey,
    thingZh: b.thingZh,
    state: b.state,
    iterationZh: iterationNoteZh(b),
  }));

  const solvedCount = prefetched.outcomes.filter((o) => o.fromSolver).length;

  /*
   * 🔴 **`pendingCount` 必须只数「真的在算、且这次没用上 GTO」的对手。**
   *
   * 修复前它直接数 `background` 数组里 QUEUED/RUNNING 的记录 —— 而那与
   * `outcomes` 是**两个不同的集合**，于是单家对手的局面上会输出假话：
   *
   * ```text
   * gtoStatus.messageZh = "1 家对手用了已缓存的 GTO 策略；
   *                        另有 1 家正在后台计算，本次先用启发式范围。"
   * outcomes            = 只有 1 家，且 fromSolver = true   ← 同一家！
   * ```
   *
   * 成因是时序：`submit()` 会同步启动任务，而 `execute` 要等第一个 `await`
   * 之后才会把 `DONE` 写回；`buildGtoStatusJson` 在同步段里执行，
   * 于是必然看到 `RUNNING`。**那家对手其实已经用上缓存了。**
   *
   * ⚠️ 第二个坑（同一次修复里被抓到）：只数 `!fromSolver` 也不够 ——
   * 尺寸对不上时 `outcome` 是 `NOT_APPLICABLE`，那种情况**根本没入队**，
   * 说「正在后台计算」等于承诺一件永远不会发生的事（使用者会一直等）。
   * 因此判据是「**既没用上 GTO、又确实有后台任务在跑**」。
   */
  const applicableCount = prefetched.outcomes.filter((o) => o.fromSolver).length;
  const pendingCount = prefetched.outcomes.filter(
    (o) => !o.fromSolver && o.state !== GtoRangeOutcomeState.NOT_APPLICABLE,
  ).length;
  const failedCount = prefetched.outcomes.filter(
    (o) => o.state === GtoRangeOutcomeState.SOLVE_FAILED,
  ).length;
  const backgroundFailed = background.filter(
    (b) => b.state === BackgroundSolveState.FAILED,
  ).length;

  let state: string;
  if (!enabled) state = 'DISABLED';
  else if (prefetched.outcomes.length === 0) state = 'NO_SCENARIO';
  else if (pendingCount > 0 && applicableCount > 0) state = 'MIXED';
  else if (pendingCount > 0) state = 'BACKGROUND_SOLVING';
  else if (applicableCount > 0) {
    /*
     * ⚠️ 全部命中 GTO **但**后台有失败记录时，不能简单报 `SOLVER_RANGE` ——
     * 那会把失败完全咽掉。分成两种：本次全部可用（`SOLVER_RANGE`）
     * 与本次可用但后台另有失败（`SOLVER_RANGE_WITH_FAILURES`）。
     */
    state = backgroundFailed > 0 ? 'SOLVER_RANGE_WITH_FAILURES' : 'SOLVER_RANGE';
  } else if (failedCount > 0) state = 'SOLVE_FAILED';
  else state = 'NOT_APPLICABLE';

  return {
    enabled,
    state,
    messageZh: gtoStatusMessageZh({ state, solvedCount, pendingCount, failedCount }),
    elapsedMs: prefetched.elapsedMs,
    outcomes,
    background: backgroundJson,
    warnings: prefetched.warnings,
    reasons: prefetched.warnings,
  };
}/** 后台任务的一句话（含「算到哪一步了」，让等待变得可判断） */
function iterationNoteZh(b: BackgroundSolveRecord): string | null {
  if (b.state === BackgroundSolveState.DONE && b.iterationsCompleted !== null) {
    const gap = b.reportedGap === null ? '未报告' : b.reportedGap.toFixed(6);
    return `${b.iterationsCompleted} 次迭代，BR gap ${gap}`;
  }
  if (b.state === BackgroundSolveState.RUNNING) {
    return b.durationMs === null ? '正在求解' : `已求解 ${Math.round(b.durationMs / 1000)} 秒`;
  }
  return null;
}

function gtoStatusMessageZh(input: {
  state: string;
  solvedCount: number;
  pendingCount: number;
  failedCount: number;
}): string {
  const { state, solvedCount, pendingCount, failedCount } = input;
  switch (state) {
    case 'DISABLED':
      return 'GTO 查询已关闭 —— 本次全部使用启发式范围。';
    case 'NO_SCENARIO':
      return '本手没有可映射到求解场景的对手（翻后 / 跛入 / 多次加注 / 人数不支持）—— 使用启发式范围。';
    case 'SOLVER_RANGE':
      return `${solvedCount} 家对手的范围来自**已缓存的 GTO 策略**。`;
    case 'SOLVER_RANGE_WITH_FAILURES':
      return (
        `${solvedCount} 家对手的范围来自已缓存的 GTO 策略；` +
        '另有场景在后台**求解失败**（本次分析不受影响，失败详情见下）。'
      );
    case 'MIXED':
      return (
        `${solvedCount} 家对手用了已缓存的 GTO 策略；` +
        `另有 ${pendingCount} 家正在后台计算，本次先用启发式范围。`
      );
    case 'BACKGROUND_SOLVING':
      return (
        `本次全部使用启发式范围 —— **GTO 正在后台计算**（${pendingCount} 个场景）。` +
        '算完会写入本地缓存，**之后同样的局面会自动改用 GTO 范围**，不需要任何操作。'
      );
    case 'SOLVE_FAILED':
      return (
        `GTO 计算失败（${failedCount} 个场景）—— 本次使用启发式范围。` +
        '这**不是**「等一会儿就好」，请检查求解器是否在运行。'
      );
    default:
      return '本局面在本项目的求解场景模型里算不了 —— 使用启发式范围（等也不会变）。';
  }
}

/**
 * 把某一家的取数结局贴到 `rangeProvenance` 上。
 *
 * ⚠️ 用**位置中文名**匹配：一个位置上只能有一个人（桌面位置唯一），
 * 因此位置名在这里是可靠的键。
 *
 * 🚫 **不按 `sourceId` 或描述文字匹配** —— 启发式的描述里含
 * 「**非**求解器输出」这类字样，用字符串搜索会把启发式判成求解器
 *（这个坑本项目真的踩过一次）。
 */
function gtoStatusFor(
  gtoStatus: GtoStatusJson,
  positionZh: string,
): Record<string, unknown> {
  const hit = gtoStatus.outcomes.find((o) => o['positionZh'] === positionZh);
  if (hit === undefined) return {};
  return {
    gtoOutcomeState: hit['state'],
    gtoReasonZh: hit['reasonZh'],
    gtoPending:
      hit['state'] === GtoRangeOutcomeState.SOLVING ||
      hit['state'] === GtoRangeOutcomeState.COMPUTING,
  };
}

/* ============================================================
 * 直接运行 * ============================================================ */

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === new URL(`file://${entry.replace(/\\/g, '/')}`).href;
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  startAlphaServer({
    port: Number(process.env.ALPHA_PORT ?? DEFAULT_PORT),
  })
    .then((instance) => {
      console.log(`Alpha 内部测试服务器已启动：${instance.url}`);
      console.log('按 Ctrl+C 停止。');
    })
    .catch((error: unknown) => {
      console.error(`启动失败：${(error as Error).message}`);
      process.exit(1);
    });
}
