/**
 * GTOpen 本地 HTTP 客户端（**唯一**允许发 GTOpen 请求的地方）
 *
 * ## 职责边界
 *
 * 本文件只做四件事：
 * 1. 发 HTTP 请求（带超时与连接失败处理）
 * 2. 把响应解析成 `unknown`，**不做任何结构解释**
 * 3. 把「连不上 / 超时 / 非 2xx / 不是 JSON」翻译成**结构化错误**
 * 4. 支持注入 `fetch`（测试用假服务器；生产用全局 `fetch`）
 *
 * 它**不**知道 169 类手牌、不知道场景、不知道频率的语义 ——
 * 那些全在 `gtopenProvider.ts` 里。
 *
 * ## 六种必须处理的失败（本轮强制）
 *
 * | 情形 | 本文件的行为 |
 * |---|---|
 * | GTOpen 没启动 | `fetch` 抛 → `kind: 'OFFLINE'` |
 * | 超时 | `AbortSignal.timeout` → `kind: 'TIMEOUT'` |
 * | 求解失败（5xx / 4xx） | `kind: 'HTTP_ERROR'` + 状态码 + 响应正文片段 |
 * | 响应不是 JSON | `kind: 'INVALID_RESPONSE'` |
 * | 响应超过体积上限 | `kind: 'INVALID_RESPONSE'`（防止一次拉爆内存） |
 * | 中途断流 | `kind: 'OFFLINE'`（网络层错误） |
 *
 * ## ⚠️ 为什么显式设置 `Content-Length` 上限
 *
 * GTOpen 的 `/api/preflop/node` 响应含 169 × 动作数 的浮点数组，
 * 正常情况下几百 KB。但一个 bug 或恶意响应可能是几十 MB。
 * 本工具是单人本地的，不需要防御攻击，但**需要防止自己卡死** ——
 * 「一个 API 慢 / 大导致整个界面永久冻结」是本轮明确列出的失败模式。
 */

import type { GtoSolveStatus } from '../gto.types.ts';

/** 默认超时（毫秒）。翻前 `node` 查询是在已求解的会话上读数据，正常 < 200ms。 */
export const DEFAULT_TIMEOUT_MS = 20_000;

/** 健康检查超时：故意更短，界面按钮不该等 20 秒才知道求解器不在。 */
export const HEALTH_TIMEOUT_MS = 3_000;

/** 响应体上限（字节）。正常 < 1MB；16MB 是「明显异常」的宽松上限。 */
export const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

/** 结构化错误 */
export type GtoHttpError = {
  /** 与 `GtoSolveStatus` 对齐的失败类别（`SOLVED` / `RUNNING` 不会出现在这里） */
  kind: Extract<
    GtoSolveStatus,
    'OFFLINE' | 'TIMEOUT' | 'INVALID_RESPONSE' | 'FAILED' | 'UNSUPPORTED'
  >;
  /** 中文说明（可直接显示） */
  message: string;
  /** HTTP 状态码（未发出请求时为 `null`） */
  status: number | null;
  /** 请求路径（诊断用） */
  path: string;
  /** 服务端返回的错误正文（截断；没有时为 `null`） */
  bodySnippet: string | null;
};

export type GtoHttpOk = { ok: true; value: unknown; status: number; bytes: number; latencyMs: number };
export type GtoHttpFail = { ok: false; error: GtoHttpError };

export type GtoHttpResult = GtoHttpOk | GtoHttpFail;

/** 可注入的 fetch 形状（只取我们用到的那部分） */
export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}>;

export type GtoHttpClientOptions = {
  /** 端点，例如 `http://127.0.0.1:3737`（不含尾斜杠） */
  baseUrl: string;
  /** 注入的 fetch；省略时用全局 `fetch` */
  fetchImpl?: FetchLike;
  /** 默认超时（毫秒） */
  timeoutMs?: number;
  /** 注入的时钟（毫秒）；测试用来断言耗时字段 |
   *  ⚠️ 只影响**我们记录的 latencyMs**，不影响超时（超时由 AbortSignal 负责） */
  now?: () => number;
};

/** 把任意异常翻译成 `OFFLINE` / `TIMEOUT` */
function classifyThrown(error: unknown): GtoHttpError['kind'] {
  const name = (error as { name?: unknown } | null)?.name;
  if (name === 'TimeoutError' || name === 'AbortError') return 'TIMEOUT';
  const message = String((error as { message?: unknown } | null)?.message ?? error);
  if (/timeout|timed out|aborted/i.test(message)) return 'TIMEOUT';
  return 'OFFLINE';
}

/** 4xx 里哪些属于「场景不支持」而不是「我们发错了」 */
function isUnsupportedStatus(status: number): boolean {
  return status === 422 || status === 400;
}

export class GtoHttpClient {
  readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(options: GtoHttpClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    const globalFetch = (globalThis as { fetch?: unknown }).fetch;
    if (options.fetchImpl === undefined) {
      if (typeof globalFetch !== 'function') {
        throw new Error(
          'GtoHttpClient: 运行环境没有全局 fetch，且没有注入 fetchImpl —— ' +
            '这会让所有 GTO 查询直接失败。请传入 fetchImpl（测试）或升级 Node（生产 ≥18）。',
        );
      }
      this.fetchImpl = globalFetch as FetchLike;
    } else {
      this.fetchImpl = options.fetchImpl;
    }
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.now = options.now ?? (() => Date.now());
  }

  /** GET 一个路径并解析 JSON */
  async getJson(path: string, timeoutMs = this.timeoutMs): Promise<GtoHttpResult> {
    return this.request('GET', path, undefined, timeoutMs);
  }

  /** POST 一个 JSON 体并解析 JSON */
  async postJson(
    path: string,
    body: unknown,
    timeoutMs = this.timeoutMs,
  ): Promise<GtoHttpResult> {
    return this.request('POST', path, body, timeoutMs);
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    timeoutMs: number,
  ): Promise<GtoHttpResult> {
    const url = `${this.baseUrl}${path}`;
    const startedAt = this.now();
    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: {
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const kind = classifyThrown(error);
      return {
        ok: false,
        error: {
          kind,
          status: null,
          path,
          bodySnippet: null,
          message:
            kind === 'TIMEOUT'
              ? `GTO 求解器在 ${timeoutMs} ms 内没有响应（${method} ${path}）。` +
                '本次不会使用 GTO 数据，Alpha 将按原有逻辑继续。'
              : `连不上 GTO 求解器（${method} ${path}）：${String((error as Error).message ?? error)}。` +
                '请确认它已经启动；本次将不使用 GTO 数据。',
        },
      };
    }

    const latencyMs = this.now() - startedAt;

    let raw: string;
    try {
      raw = await response.text();
    } catch (error) {
      return {
        ok: false,
        error: {
          kind: 'OFFLINE',
          status: response.status,
          path,
          bodySnippet: null,
          message: `读取 GTO 求解器响应失败（${method} ${path}）：${String((error as Error).message ?? error)}`,
        },
      };
    }

    const bytes = Buffer.byteLength(raw, 'utf8');
    if (bytes > MAX_RESPONSE_BYTES) {
      return {
        ok: false,
        error: {
          kind: 'INVALID_RESPONSE',
          status: response.status,
          path,
          bodySnippet: null,
          message:
            `GTO 求解器响应过大（${bytes} 字节 > 上限 ${MAX_RESPONSE_BYTES}），已拒绝解析。` +
            '这通常意味着请求的参数异常或求解器有缺陷。',
        },
      };
    }

    if (!response.ok) {
      const snippet = raw.length > 500 ? `${raw.slice(0, 500)}…` : raw;
      const kind = isUnsupportedStatus(response.status) ? 'UNSUPPORTED' : 'FAILED';
      return {
        ok: false,
        error: {
          kind,
          status: response.status,
          path,
          bodySnippet: snippet,
          message:
            kind === 'UNSUPPORTED'
              ? `GTO 求解器拒绝了这个场景（HTTP ${response.status}）：${snippet}`
              : `GTO 求解器返回错误（HTTP ${response.status}）：${snippet}`,
        },
      };
    }

    if (raw.trim().length === 0) {
      return {
        ok: false,
        error: {
          kind: 'INVALID_RESPONSE',
          status: response.status,
          path,
          bodySnippet: null,
          message: `GTO 求解器返回空响应（${method} ${path}）—— 无法作为基线使用。`,
        },
      };
    }

    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      const snippet = raw.length > 200 ? `${raw.slice(0, 200)}…` : raw;
      return {
        ok: false,
        error: {
          kind: 'INVALID_RESPONSE',
          status: response.status,
          path,
          bodySnippet: snippet,
          message: `GTO 求解器返回的不是合法 JSON（${method} ${path}）：${snippet}`,
        },
      };
    }

    return { ok: true, value, status: response.status, bytes, latencyMs };
  }
}
