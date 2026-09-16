/**
 * 红队探针 #2 —— 用**真实的 table.js** 驱动真实 HTTP 服务端
 * （极简 DOM 桩 + fetch 拦截，不引第三方依赖）
 *
 * 目的（审计清单 §90 / §27 / §29、向量 10 / 12 / 13）：
 *   (a) 屏幕真正渲染出来的文本与数字
 *   (b) 浏览器真正提交出去的 payload（拦截 fetch）
 *   (c) 后端由该 payload 重建出来的状态（同进程调用适配器 + 重放）
 * 三者必须一致。另测：卡牌网格 → 提交的牌面代码、全下按钮、双击、陈旧分析结果。
 *
 * 运行：
 *   node.exe --experimental-strip-types "scripts/rt-table-adapter-probe2.ts"
 *
 * 证据追加写入 scripts/rt-table-adapter-evidence.txt。
 */

import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';

import { createHash } from 'node:crypto';
import { parseManualInput } from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import { tableStateToManualHandInput } from '../src/app/table/tableAdapter.ts';
import { stateFingerprintOf } from '../src/app/table/tablePreview.ts';
import { parseTableState } from '../src/app/table/tableApi.ts';
import type { PokerTableState } from '../src/app/table/table.types.ts';
import { startAlphaServer, type AlphaServer } from '../src/app/webServer.ts';

/* ============================================================
 * 输出
 * ============================================================ */

const OUT: string[] = [];
const counters = { OK: 0, HIT: 0, INFO: 0 };

function section(title: string): void {
  const text = ['', '='.repeat(78), `## ${title}`, '='.repeat(78)].join('\n');
  OUT.push(text);
  process.stdout.write(text + '\n');
}
function line(text = ''): void {
  OUT.push(text);
  process.stdout.write(text + '\n');
}
function verdict(level: 'OK' | 'HIT' | 'INFO', id: string, text: string): void {
  counters[level] += 1;
  const rendered = `[${level}] ${id} ${text}`;
  OUT.push(rendered);
  process.stdout.write(rendered + '\n');
}

/* ============================================================
 * 极简 DOM 桩
 * ============================================================ */

class El {
  tagName: string;
  children: El[] = [];
  parent: El | null = null;
  _text: string | null = null;
  _html: string | null = null;
  className = '';
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  disabled = false;
  value = '';
  title = '';
  id = '';
  options: El[] = [];
  onclick: ((event?: unknown) => void) | null = null;
  type = '';

  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }

  /** 文本在真实 DOM 里是一个子节点：它与元素子节点一起被 clear() 移除 */
  get firstChild(): El | null {
    if (this.children.length > 0) return this.children[0]!;
    if (this._text !== null) {
      const holder = new El('#text');
      holder._text = this._text;
      holder.parent = this;
      return holder;
    }
    return null;
  }

  appendChild(node: El): El {
    // 与 DOM 规范一致：把祖先（含自身）插进自己的子树必须抛 HierarchyRequestError
    let cursor: El | null = this;
    while (cursor !== null) {
      if (cursor === node) {
        const error = new Error(
          "HierarchyRequestError: Failed to execute 'appendChild' on 'Node': The new child element contains the parent.",
        );
        error.name = 'HierarchyRequestError';
        throw error;
      }
      cursor = cursor.parent;
    }
    node.parent = this;
    this.children.push(node);
    return node;
  }

  removeChild(node: El): El {
    const index = this.children.indexOf(node);
    if (index >= 0) this.children.splice(index, 1);
    if (node.tagName === '#TEXT' && node._text === this._text) this._text = null;
    return node;
  }

  set textContent(value: string) {
    this._text = String(value);
    this._html = null;
    this.children = [];
  }

  get textContent(): string {
    const own = this._text ?? this._html ?? '';
    return own + this.children.map((c) => c.textContent).join('');
  }

  set innerHTML(value: string) {
    this._html = String(value);
    this._text = null;
    this.children = [];
  }

  get innerHTML(): string {
    return this._html ?? this.textContent;
  }

  /** 支持 'button, select, input' 与 'button.pick' 两种选择器 */
  querySelectorAll(selector: string): El[] {
    const parts = selector.split(',').map((s) => s.trim());
    const out: El[] = [];
    const walk = (node: El): void => {
      for (const child of node.children) {
        for (const part of parts) {
          const [tag, cls] = part.split('.');
          const tagOk = !tag || child.tagName === tag.toUpperCase();
          const clsOk = !cls || child.className.split(/\s+/).includes(cls);
          if (tagOk && clsOk) {
            out.push(child);
            break;
          }
        }
        walk(child);
      }
    };
    walk(this);
    return out;
  }
}

const created: El[] = [];
const byId = new Map<string, El>();

const documentStub = {
  readyState: 'complete',
  createElement: (tag: string) => {
    const node = new El(tag);
    created.push(node);
    return node;
  },
  getElementById: (id: string) => {
    let node = byId.get(id);
    if (node === undefined) {
      node = new El('div');
      node.id = id;
      byId.set(id, node);
      created.push(node);
    }
    return node;
  },
  addEventListener: () => undefined,
  querySelectorAll: (selector: string) => {
    const parts = selector.split(',').map((s) => s.trim());
    return created.filter((node) =>
      parts.some((part) => node.tagName === part.toUpperCase()),
    );
  },
  body: new El('body'),
};

const $ = (id: string): El => documentStub.getElementById(id) as El;

/** 收集当前「挂在文档上」的全部节点（从 body 与所有具名 id 节点可达） */
function attachedNodes(): El[] {
  const seen = new Set<El>();
  const out: El[] = [];
  const walk = (node: El): void => {
    if (seen.has(node)) return;
    seen.add(node);
    out.push(node);
    for (const child of node.children) walk(child);
  };
  walk(documentStub.body as El);
  for (const node of byId.values()) walk(node);
  return out;
}

/** 按文本找一个按钮（模拟用户点击） */
function findButton(text: string): El | undefined {
  return attachedNodes().find((n) => n.tagName === 'BUTTON' && n.textContent === text);
}

/** 当前屏幕上可见的按钮（按 DOM 顺序） */
function visibleButtons(root: El): El[] {
  const reachable = new Set(attachedNodes());
  return root.querySelectorAll('button').filter((n) => reachable.has(n));
}

/* ============================================================
 * fetch 拦截
 * ============================================================ */

const requests: { url: string; body: any; status: number; response?: any }[] = [];
let pending = 0;

function installFetch(base: string): void {
  const realFetch = globalThis.fetch;
  const wrapped = async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
    const absolute = String(url).startsWith('http') ? String(url) : `${base}${String(url)}`;
    pending += 1;
    try {
      const res = await realFetch(absolute, init as never);
      const text = await res.text();
      let body: unknown = null;
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
      requests.push({
        url: String(url),
        body: init?.body !== undefined ? JSON.parse(init.body) : null,
        status: res.status,
        response: body,
      });
      return {
        status: res.status,
        ok: res.ok,
        json: async () => body,
        text: async () => text,
      };
    } finally {
      pending -= 1;
    }
  };
  (globalThis as { fetch: unknown }).fetch = wrapped;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 等到「在途请求清零并持续安静 quietTicks 个 tick」为止 */
async function flush(quietTicks = 6, maxMs = 20000): Promise<void> {
  const started = Date.now();
  let quiet = 0;
  while (Date.now() - started < maxMs) {
    await sleep(5);
    if (pending === 0) {
      quiet += 1;
      if (quiet >= quietTicks) return;
    } else {
      quiet = 0;
    }
  }
}

/** 点击一个节点（调用它自己的 onclick），并等待网络静默 */
async function click(node: El | undefined, what: string): Promise<void> {
  if (node === undefined) throw new Error(`找不到可点击的元素：${what}`);
  if (node.disabled) throw new Error(`元素被禁用，点不动：${what}`);
  node.onclick?.({ target: node });
  await flush();
}

const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);

/* ============================================================
 * 主流程
 * ============================================================ */

const sandboxErrors: string[] = [];
process.on('unhandledRejection', (reason) => {
  const error = reason as Error;
  const text = (error?.name ?? 'Error') + ': ' + (error?.message ?? String(reason));
  sandboxErrors.push(text);
  process.stderr.write('UNHANDLED REJECTION: ' + text + '\n');
});

let server: AlphaServer | null = null;

async function main(): Promise<void> {
  section('探针 #2 快照');
  for (const rel of ['src/app/web/table.js', 'src/app/web/index.html', 'src/app/table/tablePreview.ts', 'src/app/table/tableApi.ts']) {
    const abs = fileURLToPath(new URL(`../${rel}`, import.meta.url));
    const text = readFileSync(abs, 'utf8');
    line(`${rel.padEnd(36)} ${sha(text)} mtime=${statSync(abs).mtime.toISOString()}`);
  }

  server = await startAlphaServer({ port: 0, logPath: null });
  const base = server.url;
  line(`服务已启动：${base}`);
  installFetch(base);

  /* ---- 加载真实的 table.js ---- */
  const clientSource = readFileSync(fileURLToPath(new URL('../src/app/web/table.js', import.meta.url)), 'utf8');
  const sandbox: Record<string, unknown> = {
    document: documentStub,
    window: {
      setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
      clearTimeout: (handle: unknown) => clearTimeout(handle as NodeJS.Timeout),
    },
    fetch: globalThis.fetch,
    Promise,
    JSON,
    Math,
    Number,
    String,
    Object,
    Array,
    Boolean,
    Date,
    console,
  };
  sandbox['globalThis'] = sandbox;
  const context = createContext(sandbox);
  runInContext(clientSource, context, { filename: 'table.js' });
  await flush(20);

  section('§A 启动：客户端真的消费了 /api/table/meta 并建桌');
  const metaReq = requests.find((r) => r.url === '/api/table/meta');
  const createReq = requests.find((r) => r.url === '/api/table' && r.body?.state === undefined);
  line(`请求序列：${requests.map((r) => `${r.url}(${r.status})`).join(' → ')}`);
  verdict(
    metaReq !== undefined && createReq !== undefined ? 'OK' : 'HIT',
    'A1',
    `客户端先取 meta（${metaReq ? '是' : '否'}）再建桌（${createReq ? '是' : '否'}），建桌载荷=${JSON.stringify(createReq?.body)}`,
  );
  line(`  座位区文本：${$('seats').textContent.replace(/\s+/g, ' ').slice(0, 160)}`);
  line(`  街道行：${$('streetLine').textContent}`);
  line(`  底池行：${$('potLine').textContent}`);
  line(`  行动者行：${$('actorLine').textContent}`);

  // 工具：按位置找座位节点
  const seatNode = (position: string): El | undefined =>
    $('seats')
      .querySelectorAll('div')
      .find((n) => n.className.includes('seat') && n.textContent.includes(`（${position}）`));

  const addPlayer = async (position: string): Promise<void> => {
    await click(seatNode(position), `座位 ${position}`);
    const add = findButton('加入玩家');
    await click(add, `${position} 的「加入玩家」`);
  };

  /* ---- §B 卡牌网格 → 提交的牌面代码 ---- */
  section('§B 4×13 网格点击 → 浏览器真正提交的牌面代码');
  for (const position of ['UTG', 'HJ', 'CO', 'SB', 'BB']) await addPlayer(position);
  line(`  加满玩家后座位区：${$('seats').textContent.replace(/\s+/g, ' ').slice(0, 220)}`);

  const picker = (): El[] => $('pickerGrid').querySelectorAll('button.pick');
  const pickByCode = async (code: string): Promise<void> => {
    const button = picker().find((b) => b.dataset.card === code);
    await click(button, `牌面 ${code}`);
  };

  // 落点：Hero 手牌（点第一个空槽）
  const emptySlot = $('heroHandRow').querySelectorAll('div').find((n) => n.className.includes('empty'));
  await click(emptySlot, 'Hero 手牌空槽');
  const cardReqsBefore = requests.length;
  await pickByCode('As');
  await pickByCode('Kd');
  const cardReqs = requests.slice(cardReqsBefore);
  line(`  点击 As/Qs 之后发出的请求：${cardReqs.map((r) => JSON.stringify(r.body)).join(' / ')}`);
  const debugInput1 = JSON.parse($('debugInput').textContent) as { heroCards: string[] };
  line(`  屏幕 debugInput.heroCards=${JSON.stringify(debugInput1.heroCards)}`);
  const disabledNow = picker()
    .filter((b) => b.disabled)
    .map((b) => b.dataset.card);
  verdict(
    JSON.stringify(debugInput1.heroCards) === JSON.stringify(['As', 'Kd']) &&
      disabledNow.includes('As') &&
      disabledNow.includes('Kd')
      ? 'OK'
      : 'HIT',
    'B1',
    `网格点击 → 提交代码与屏幕一致；已用牌被禁用（禁用集合=${disabledNow.join(',') || '（空）'}）`,
  );

  /* ---- §C 双击与在途保护 ---- */
  section('§C 双击（同一按钮连点两次）');
  await flush();
  const beforeDbl = requests.length;
  const actionBox = $('actionButtons');
  const foldBtn = actionBox.querySelectorAll('button').find((b) => b.textContent === '弃牌');
  if (foldBtn === undefined) throw new Error('找不到「弃牌」按钮');
  // 模拟双击：同一个 tick 内触发两次
  foldBtn.onclick?.({ target: foldBtn });
  foldBtn.onclick?.({ target: foldBtn });
  await flush(20);
  const dblRequests = requests.slice(beforeDbl).filter((r) => r.url === '/api/table');
  line(`  连点两次「弃牌」→ 实际发出 ${dblRequests.length} 个 /api/table 请求`);
  verdict(
    dblRequests.length === 1 ? 'OK' : 'HIT',
    'C1',
    `双击只发出 ${dblRequests.length} 个请求（客户端 inflight 守卫）`,
  );

  /* ---- §E §90 三方一致（真实 UI 走到翻牌 Hero 决策点） ---- */
  section('§E §90 三方一致：屏幕渲染文本 vs 提交载荷 vs 后端状态');

  /** 通过界面选一张公共牌：先点槽位，再点牌面 */
  const boardSlotNodes = (): El[] =>
    $('boardRow')
      .querySelectorAll('div')
      .filter((n) => n.className.includes('slot'));
  const setBoardCard = async (slotIndex: number, code: string): Promise<void> => {
    const slot = boardSlotNodes()[slotIndex];
    if (slot === undefined) throw new Error(`找不到公共牌槽位 ${slotIndex}`);
    slot.onclick?.({ target: slot });
    await flush(4, 5000);
    await pickByCode(code);
  };
  const clickByText = async (text: string): Promise<boolean> => {
    const btn = $('actionButtons')
      .querySelectorAll('button')
      .find((b) => b.textContent === text || b.textContent.startsWith(text));
    if (btn === undefined) return false;
    await click(btn, text);
    return true;
  };

  // 1) HJ / CO 弃牌 → Hero(BTN) 跟注 → SB 弃牌 → BB 过牌，收掉翻牌前
  await clickByText('弃牌'); // HJ
  await clickByText('弃牌'); // CO
  await clickByText('跟注'); // BTN = Hero
  await clickByText('弃牌'); // SB
  await clickByText('过牌'); // BB
  line(`  翻牌前收尾后：街道行=${$('streetLine').textContent} 行动者行=${$('actorLine').textContent}`);

  // 2) 选翻牌三张（走真实界面：点槽位 → 点牌面）
  for (const [index, code] of [[0, 'Kh'], [1, '7c'], [2, '2d']] as const) {
    await setBoardCard(index, code);
  }
  line(`  选完三张公共牌：街道行=${$('streetLine').textContent} 槽位=${boardSlotNodes().map((n) => n.textContent).join(',')}`);

  // 3) 翻牌后过牌到 Hero（BB 先行动）
  for (let i = 0; i < 4; i += 1) {
    if ($('actorLine').textContent.includes('现在轮到你')) break;
    if (!(await clickByText('过牌'))) break;
  }
  line(`  街道行=${$('streetLine').textContent} 底池行=${$('potLine').textContent} 行动者行=${$('actorLine').textContent}`);
  line(`  按钮=${$('actionButtons').querySelectorAll('button').map((b) => b.textContent).join(' / ')}`);
  line(`  阻塞项=${$('blockers').textContent.replace(/\s+/g, ' ').slice(0, 200)}`);
  line(`  分析按钮：disabled=${$('analyzeBtn').disabled} 文本=${$('analyzeBtn').textContent}`);

  // 屏幕上的「提交内容」与「指纹」
  const screenInput = $('debugInput').textContent;
  const screenFingerprint = $('debugFingerprint').textContent;
  const screenPot = $('potLine').textContent;
  const screenStats = $('statGrid').textContent;

  // 点「分析当前决策」：拦截它提交的牌桌状态
  const analyzeBtn = $('analyzeBtn');
  const beforeAnalyze = requests.length;
  await click(analyzeBtn, '分析当前决策');
  await flush(40);
  const analyzeReq = requests.slice(beforeAnalyze).find((r) => r.url === '/api/analyze');
  line(`  分析响应：ok=${String(analyzeReq?.response?.ok)} stage=${String(analyzeReq?.response?.stage ?? '-')} actionZh=${String(analyzeReq?.response?.viewModel?.actionZh ?? '-')}`);
  line(`  分析面板内容：${$('result').textContent.replace(/\s+/g, ' ').slice(0, 160)}`);
  line(`  debugDecision=${$('debugDecision').textContent.replace(/\s+/g, ' ').slice(0, 120)}`);
  if (analyzeReq === undefined) {
    verdict('HIT', 'E1', '点击分析没有发出 /api/analyze 请求（可能按钮被禁用）');
  } else {
    const tableState = analyzeReq.body.table as PokerTableState;
    const parsedState = parseTableState(tableState);
    line(`  提交的牌桌状态：revision=${tableState.revision} heroCards=${JSON.stringify(tableState.heroCards)} board=${JSON.stringify(tableState.board)} 历史=${tableState.actionHistory.length} 条`);
    if (!parsedState.ok) {
      verdict('HIT', 'E1', `客户端提交的牌桌状态没通过后端校验：${JSON.stringify(parsedState.issues)}`);
    } else {
      const adapted = tableStateToManualHandInput(parsedState.state);
      if (!adapted.ok) {
        verdict('HIT', 'E1', `适配失败：${JSON.stringify(adapted.issues)}`);
      } else {
        const parsed = parseManualInput(adapted.input);
        if (!parsed.ok) {
          verdict('HIT', 'E1', `解析失败：${JSON.stringify(parsed.issues)}`);
        } else {
          const gate = buildAnalyzableState(parsed.value);
          const problems: string[] = [];
          // (a) 屏幕的 debugInput 必须（归一化后）逐字等于后端由同一状态适配出的输入
          const expectedInput = JSON.stringify(adapted.input);
          let screenInputNormalized = screenInput;
          try {
            screenInputNormalized = JSON.stringify(JSON.parse(screenInput));
          } catch {
            problems.push('屏幕 debugInput 不是合法 JSON');
          }
          if (screenInputNormalized !== expectedInput) {
            problems.push('屏幕 debugInput ≠ 后端适配结果');
            line(`    屏幕（归一化）：${screenInputNormalized.slice(0, 240)}`);
            line(`    后端　　　　　：${expectedInput.slice(0, 240)}`);
          } else {
            line(`    屏幕 debugInput（归一化）== 后端适配结果（${expectedInput.length} 字符）`);
          }
          // (b) 屏幕指纹必须等于后端重放指纹
          if (gate.ok) {
            const fp = stateFingerprintOf(gate.state);
            if (screenFingerprint !== fp) problems.push('屏幕指纹 ≠ 后端重放指纹');
            line(`    后端重放指纹=${fp.slice(0, 120)}…`);
            // (c) 屏幕上的底池数字必须等于后端重算值
            const potMatch = new RegExp(`底池 (-?[0-9.]+)BB`).exec(screenPot);
            const potBB = gate.computedPot / (parsed.value.bigBlindBB || 100);
            if (potMatch === null || Math.abs(Number(potMatch[1]) - potBB) > 1e-9) {
              problems.push(`屏幕底池 ${potMatch?.[1] ?? '?'}BB ≠ 后端 ${potBB}BB`);
            }
            // (d) 行动者：屏幕的「现在轮到你」必须与后端 pendingQueue 一致
            const heroId = gate.state.userPlayerId;
            const actorIsHero = gate.state.pendingQueue[0] === heroId;
            const screenSaysHero = $('actorLine').textContent.includes('现在轮到你');
            if (actorIsHero !== screenSaysHero) {
              problems.push(`屏幕行动者（HeroTurn=${screenSaysHero}）≠ 后端（HeroTurn=${actorIsHero}）`);
            }
            line(`    屏幕统计区=${screenStats.replace(/\s+/g, ' ').slice(0, 200)}`);
          } else {
            problems.push(`后端无法构建可分析状态：${JSON.stringify(gate.issues)}`);
          }
          verdict(
            problems.length === 0 ? 'OK' : 'HIT',
            'E1',
            problems.length === 0
              ? '屏幕显示的提交内容 / 指纹 / 底池 / 行动者 与后端由同一状态重建出的结果逐位一致'
              : `三方不一致：${problems.join('；')}`,
          );
        }
      }
    }
  }

  /* ---- §F 成功分析后，建议面板是否真的显示出来 ---- */
  section('§F 成功分析后建议面板是否真的渲染（同时看陈旧性）');
  const resultText = (): string => $('result').textContent.replace(/\s+/g, ' ').trim().slice(0, 140);
  const actionZh = String(analyzeReq?.response?.viewModel?.actionZh ?? '');
  const resultNow = resultText();
  line(`  后端返回的建议=${actionZh}`);
  line(`  屏幕 #result 的内容=${resultNow === '' ? '（空）' : resultNow}`);
  line(`  捕获到的前端异常：${sandboxErrors.length === 0 ? '（无）' : sandboxErrors.join(' | ')}`);
  const rendered = resultNow.includes('建议') || (actionZh !== '' && resultNow.includes(actionZh.replace('建议：', '')));
  verdict(
    rendered ? 'OK' : 'HIT',
    'F1',
    rendered
      ? '成功分析的建议确实渲染到了 #result'
      : `后端已经返回成功建议「${actionZh}」，但 #result 面板是空的` +
        (sandboxErrors.length > 0 ? `；前端抛出了异常：${sandboxErrors[0]}` : ''),
  );

  /* ---- §F2 分析成功后，界面还能不能正常处理「需要用户选择」的响应 ---- */
  const modalChoiceVisible = (): boolean =>
    attachedNodes().some((n) => n.tagName === 'BUTTON' && n.textContent.includes('手后离桌'));
  const bbSeat = seatNode('BB');
  if (bbSeat !== undefined && analyzeReq?.response?.ok === true) {
    await click(bbSeat, 'BB 座位');
    const clearBtn = findButton('清空座位');
    const hadSeatMenu = $('overlay').className.includes('show');
    await click(clearBtn, '清空座位');
    const lastClear = requests.filter((r) => r.url === '/api/table').at(-1);
    const needsChoice = lastClear?.response?.leaveDecision !== undefined;
    line(`  座位菜单打开=${hadSeatMenu}；后端返回 leaveDecision=${needsChoice}`);
    line(`  弹层 class=${$('overlay').className}；弹层内容=${$('modal').textContent.replace(/\s+/g, ' ').slice(0, 120)}`);
    line(`  「仅标记手后离桌」按钮存在=${modalChoiceVisible()}`);
    verdict(
      needsChoice && !modalChoiceVisible() ? 'HIT' : 'OK',
      'F2',
      needsChoice && !modalChoiceVisible()
        ? '后端要求用户明确选择离桌方式（§8），但由于 render() 在建议面板处抛异常，弹层没有重建 —— 用户看不到必须做的选择'
        : '离桌选择弹层正常显示（或本步不适用）',
    );
  } else {
    verdict('INFO', 'F2', '本步不适用（没有可点的座位或分析未成功）');
  }

  /* ---- §G 全下按钮：预览给出但后端拒绝（真实 UI 点击，新牌桌） ---- */
  section('§G 全下按钮（真实 UI 点击，重新开一桌）');
  await click($('newTableBtn'), '新建牌桌');
  for (const position of ['UTG', 'HJ', 'CO', 'SB', 'BB']) await addPlayer(position);
  // 重新落点 + 选 Hero 手牌
  const emptySlot2 = $('heroHandRow').querySelectorAll('div').find((n) => n.className.includes('empty'));
  await click(emptySlot2, 'Hero 手牌空槽');
  await pickByCode('As');
  await pickByCode('Kd');
  // 弃牌到小盲位（Hero 在 BTN，需要弃 4 次：UTG/HJ/CO/BTN）
  for (let i = 0; i < 4; i += 1) await clickByText('弃牌');
  const labels = $('actionButtons')
    .querySelectorAll('button')
    .map((b) => b.textContent);
  line(`  现在轮到：${$('actorLine').textContent}`);
  line(`  按钮：${labels.join(' / ')}`);
  const allInBtn = $('actionButtons')
    .querySelectorAll('button')
    .find((b) => b.textContent.startsWith('全下'));
  if (allInBtn === undefined) {
    verdict('INFO', 'G1', '当前局面没有全下按钮，跳过');
  } else {
    const fpBefore = $('debugFingerprint').textContent;
    const reqBefore = requests.filter((r) => r.url === '/api/table').length;
    await click(allInBtn, '全下按钮');
    const lastReq = requests.filter((r) => r.url === '/api/table').at(-1);
    line(`  点击载荷=${JSON.stringify(lastReq?.body?.op)}`);
    line(`  提示条：${$('toast').textContent.replace(/\s+/g, ' ')}`);
    line(`  指纹是否变化：${$('debugFingerprint').textContent !== fpBefore}（请求数 ${reqBefore}→${requests.filter((r) => r.url === '/api/table').length}）`);
    const rejected =
      $('toast').textContent.includes('ALLIN_AMOUNT_MISMATCH') || $('toast').textContent.includes('规则拒绝');
    verdict(
      rejected ? 'HIT' : 'OK',
      'G1',
      rejected
        ? `屏幕给出「${allInBtn.textContent}」按钮，点击后被后端拒绝，且状态未变：${$('toast').textContent.replace(/\s+/g, ' ').slice(0, 130)}`
        : '全下按钮被后端接受',
    );
  }

  /* ---- §H 汇总 ---- */
  section('探针 #2 汇总');
  line(`OK=${counters.OK} HIT=${counters.HIT} INFO=${counters.INFO}`);
  const text = OUT.join('\n');
  const outPath = fileURLToPath(new URL('./rt-table-adapter-evidence.txt', import.meta.url));
  const previous = readFileSync(outPath, 'utf8');
  writeFileSync(outPath, `${previous}\n\n\n${'#'.repeat(78)}\n# 探针 #2（真实 table.js + DOM 桩）\n${'#'.repeat(78)}${text}\n`, 'utf8');
  process.stdout.write(text + '\n');
}

main()
  .then(async () => {
    if (server !== null) await server.close();
    process.exit(0);
  })
  .catch(async (error) => {
    process.stderr.write(`探针 #2 崩溃：${String(error)}\n${(error as Error).stack ?? ''}\n`);
    if (server !== null) await server.close();
    process.exit(1);
  });
