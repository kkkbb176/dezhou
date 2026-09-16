/**
 * 红队增量复验探针（作者在 13:18:56 最终快照之后又改了 4 处）
 *
 * 覆盖：
 *   RT-L6  「下一手暂离」的取消入口（DOM 桩驱动真实 table.js）
 *   RT-L7  新建牌桌的 heroPosition 必须在该桌型里存在 + 结果自校验
 *   RT-L8  SET_TABLE_SIZE 的 notice 必须点名被顶掉的玩家
 *   RT-L9  NEW_TABLE 的 notice 必须如实写出「Hero 筹码也被重置」
 *
 * 运行：
 *   node.exe --experimental-strip-types "scripts/rt-table-adapter-probe3.ts"
 *
 * 证据追加写入 scripts/rt-table-adapter-evidence.txt（UTF-8，Node 写文件）。
 */

import { createHash } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';

import { Position } from '../src/domain/types.ts';
import { createTable, seatOfPosition } from '../src/app/table/tableState.ts';
import { applyTableOp, engineViewOf } from '../src/app/table/tableOps.ts';
import { buildTablePreview } from '../src/app/table/tablePreview.ts';
import { parseTableState } from '../src/app/table/tableApi.ts';
import type { PokerTableState, TableOp } from '../src/app/table/table.types.ts';
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
const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);

/* ============================================================
 * 极简 DOM 桩（与探针 #2 同源，含 DOM 规范的 appendChild 祖先检查）
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
  querySelectorAll: (selector: string) =>
    created.filter((node) => selector.split(',').some((p) => node.tagName === p.trim().toUpperCase())),
  body: new El('body'),
};
byId.set('body', documentStub.body as El);
const $ = (id: string): El => documentStub.getElementById(id) as El;

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
const findButton = (text: string): El | undefined =>
  attachedNodes().find((n) => n.tagName === 'BUTTON' && n.textContent === text);

/* ============================================================
 * fetch 拦截
 * ============================================================ */

const requests: { url: string; body: any; status: number; response?: any }[] = [];
let pending = 0;
const sandboxErrors: string[] = [];

process.on('unhandledRejection', (reason) => {
  const error = reason as Error;
  const text = (error?.name ?? 'Error') + ': ' + (error?.message ?? String(reason));
  sandboxErrors.push(text);
  process.stderr.write('UNHANDLED REJECTION: ' + text + '\n');
});

function installFetch(base: string): void {
  const realFetch = globalThis.fetch;
  (globalThis as { fetch: unknown }).fetch = async (
    url: string,
    init?: { method?: string; headers?: Record<string, string>; body?: string },
  ) => {
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
      return { status: res.status, ok: res.ok, json: async () => body, text: async () => text };
    } finally {
      pending -= 1;
    }
  };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
async function flush(quietTicks = 8, maxMs = 20000): Promise<void> {
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
async function click(node: El | undefined, what: string): Promise<void> {
  if (node === undefined) throw new Error(`找不到可点击的元素：${what}`);
  if (node.disabled) throw new Error(`元素被禁用，点不动：${what}`);
  node.onclick?.({ target: node });
  await flush();
}

/* ============================================================
 * 纯函数辅助
 * ============================================================ */

const ORDER_6: readonly Position[] = [
  Position.UTG,
  Position.HJ,
  Position.CO,
  Position.BTN,
  Position.SB,
  Position.BB,
];
const ORDER_9: readonly Position[] = [
  Position.UTG,
  Position.UTG1,
  Position.UTG2,
  Position.LJ,
  Position.HJ,
  Position.CO,
  Position.BTN,
  Position.SB,
  Position.BB,
];

function must(result: ReturnType<typeof applyTableOp>): PokerTableState {
  if (!result.ok) throw new Error(`操作被拒绝：${result.issues.map((i) => i.message).join(' / ')}`);
  return result.state;
}

function fill(state: PokerTableState, order: readonly Position[]): PokerTableState {
  let current = state;
  for (const position of order) {
    if (position === current.heroPosition) continue;
    const seat = seatOfPosition(current, position);
    if (seat === undefined || seat.playerId !== null) continue;
    current = must(applyTableOp(current, { kind: 'ADD_PLAYER', seatId: seat.seatId }));
  }
  return current;
}

/* ============================================================
 * 主流程
 * ============================================================ */

let server: AlphaServer | null = null;

async function main(): Promise<void> {
  /* ---------- §0 最终快照 ---------- */
  section('§0 增量复验快照（sha256 前 16 位 + mtime）');
  const AUDITED = [
    'src/app/web/table.js',
    'src/app/table/tableApi.ts',
    'src/app/table/seatLifecycle.ts',
    'src/app/table/tablePreview.ts',
    'src/app/table/tableOps.ts',
    'src/app/table/table.types.ts',
    'src/app/table/tableAdapter.ts',
    'src/app/table/tableState.ts',
    'src/app/webServer.ts',
    'src/app/manualInput/manualInput.ts',
    'src/app/manualInput/reconstruct.ts',
    'src/app/manualInput/legalActions.ts',
  ];
  for (const rel of AUDITED) {
    const abs = fileURLToPath(new URL(`../${rel}`, import.meta.url));
    const text = readFileSync(abs, 'utf8');
    line(`${rel.padEnd(42)} ${sha(text)}  mtime=${statSync(abs).mtime.toISOString()}`);
  }

  /* ---------- §1 RT-L7：新建牌桌的 heroPosition / 自校验 ---------- */
  section('§1 RT-L7：POST /api/table 新建分支（真实 HTTP）');
  server = await startAlphaServer({ port: 0, logPath: null });
  const base = server.url;
  installFetch(base);
  line(`服务已启动：${base}`);

  const post = async (body: unknown): Promise<{ status: number; json: any }> => {
    const res = await fetch(`${base}/api/table`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  };

  const bad = await post({ tableSize: 6, heroPosition: 'UTG1' });
  line(`  {tableSize:6, heroPosition:"UTG1"} → status=${bad.status} ok=${String(bad.json.ok)} code=${String(bad.json.issues?.[0]?.code)}`);
  line(`    原因：${String(bad.json.issues?.[0]?.message ?? '（无）')}`);
  verdict(
    bad.status === 200 && bad.json.ok === false && /UTG1/.test(String(bad.json.issues?.[0]?.message ?? '')) &&
      /可选/.test(String(bad.json.issues?.[0]?.message ?? '')) && bad.json.state === undefined
      ? 'OK'
      : 'HIT',
    'L7-a',
    '6 人桌 + heroPosition="UTG1" 必须被拒绝、给出可读原因（含可选列表），且不得返回任何状态',
  );

  const cases: readonly { name: string; body: unknown; expectPosition: string; expectSize: number }[] = [
    { name: '{tableSize:6}', body: { tableSize: 6 }, expectPosition: 'BTN', expectSize: 6 },
    { name: '{tableSize:9, heroPosition:"UTG2"}', body: { tableSize: 9, heroPosition: 'UTG2' }, expectPosition: 'UTG2', expectSize: 9 },
    { name: '{heroPosition:"BTN"}', body: { heroPosition: 'BTN' }, expectPosition: 'BTN', expectSize: 6 },
    { name: '{tableSize:9, heroPosition:"LJ"}', body: { tableSize: 9, heroPosition: 'LJ' }, expectPosition: 'LJ', expectSize: 9 },
  ];
  for (const c of cases) {
    const r = await post(c.body);
    const state = r.json.state as PokerTableState | undefined;
    const parsed = state !== undefined ? parseTableState(state) : { ok: false as const };
    const heroSeat = state?.seats.find((s) => s.logicalPosition === state.heroPosition);
    const heroBound = heroSeat?.playerId === state?.heroPlayerId;
    const seatCount = state?.seats.length;
    const seatsUnique = state !== undefined && new Set(state.seats.map((s) => s.logicalPosition)).size === seatCount;
    const ok =
      r.status === 200 && r.json.ok === true && parsed.ok && heroBound && seatCount === c.expectSize &&
      seatsUnique && state?.heroPosition === c.expectPosition;
    line(
      `  ${c.name.padEnd(34)} status=${r.status} ok=${String(r.json.ok)} heroPosition=${String(state?.heroPosition)} 座位数=${String(seatCount)} 自校验=${parsed.ok} Hero绑定=${String(heroBound)}`,
    );
    verdict(ok ? 'OK' : 'HIT', `L7-b:${c.name}`, ok ? '返回 ok:true，且状态通过 parseTableState、Hero 正确绑定' : '不符合预期');
  }

  /* ---------- §2 RT-L8 / RT-L9：notice 必须点名/如实 ---------- */
  section('§2 RT-L8/L9：notice 文案必须点名被顶掉的玩家 / 如实说明 Hero 筹码');

  // 9 人桌、Hero 在 UTG1（6 人桌没有这个位置）→ 切到 6 人桌时 Hero 必须改到 BTN，
  // 而 BTN 上原本有人 → notice 必须点名那个人。
  let nine = fill(createTable({ tableSize: 9, heroPosition: Position.UTG1 }), ORDER_9);
  const displacedName = nine.playersById[seatOfPosition(nine, Position.BTN)!.playerId!]!.displayName;
  const shrunk = applyTableOp(nine, { kind: 'SET_TABLE_SIZE', tableSize: 6 });
  if (!shrunk.ok) {
    verdict('HIT', 'L8', `SET_TABLE_SIZE 被拒绝：${JSON.stringify(shrunk.issues)}`);
  } else {
    const notices = shrunk.state.notices;
    const named = notices.some((n) => n.includes(displacedName));
    const says = notices.some((n) => n.includes('已交给 Hero'));
    line(`  被顶掉的玩家 = ${displacedName}；Hero 位置 UTG1 → ${shrunk.state.heroPosition}`);
    for (const n of notices) line(`    notice: ${n}`);
    verdict(
      named && says ? 'OK' : 'HIT',
      'L8',
      named && says
        ? `notice 点名了「${displacedName}」并说明座位已交给 Hero`
        : `notice 未点名被顶掉的玩家（named=${named}, says=${says}）`,
    );
    // 顺带核对文案里的另一半承诺：Hero 的筹码跟着 Hero 走
    const heroStackBefore = seatOfPosition(nine, Position.UTG1)!.stackBB;
    const heroStackAfter = seatOfPosition(shrunk.state, shrunk.state.heroPosition)!.stackBB;
    verdict(
      heroStackBefore === heroStackAfter ? 'OK' : 'HIT',
      'L8-b',
      `「Hero 的筹码跟着 Hero 走」：切换前 ${heroStackBefore}BB → 切换后 ${heroStackAfter}BB`,
    );
  }

  // NEW_TABLE 的 notice 必须如实写出「包括 Hero」
  let pre = fill(createTable({ tableSize: 6, heroPosition: Position.BTN, defaultStackBB: 100 }), ORDER_6);
  pre = must(applyTableOp(pre, { kind: 'SET_STACK', seatId: seatOfPosition(pre, Position.BTN)!.seatId, stackBB: 250 }));
  pre = must(applyTableOp(pre, { kind: 'SET_STACK', seatId: seatOfPosition(pre, Position.UTG)!.seatId, stackBB: 42 }));
  const fresh = must(applyTableOp(pre, { kind: 'NEW_TABLE' }));
  const allDefault = fresh.seats.every((s) => s.stackBB === fresh.defaultStackBB);
  const heroStack = seatOfPosition(fresh, fresh.heroPosition)!.stackBB;
  line(`  NEW_TABLE 之前：Hero 250BB / UTG 42BB；之后：全部座位=${JSON.stringify(fresh.seats.map((s) => s.stackBB))}`);
  for (const n of fresh.notices) line(`    notice: ${n}`);
  const textSays = fresh.notices.some((n) => n.includes('包括 Hero'));
  verdict(
    allDefault && heroStack === fresh.defaultStackBB && textSays ? 'OK' : 'HIT',
    'L9',
    allDefault && textSays
      ? `notice 如实写出「所有座位筹码重置为默认 ${fresh.defaultStackBB}BB（包括 Hero）」，且实际状态与文案一致（Hero=${heroStack}BB）`
      : `文案与实际不一致（allDefault=${allDefault}, 文案含「包括 Hero」=${textSays}）`,
  );

  /* ---------- §3 RT-L6：DOM 桩驱动真实 table.js ---------- */
  section('§3 RT-L6：「下一手暂离」必须有取消入口（真实 table.js + DOM 桩）');

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
  runInContext(clientSource, createContext(sandbox), { filename: 'table.js' });
  await flush(20);

  const seatNode = (position: string): El | undefined =>
    $('seats')
      .querySelectorAll('div')
      .find((n) => n.className.includes('seat') && n.textContent.includes(`（${position}）`));

  // 加满玩家 + 选 Hero 手牌 + 让本手开始（弃牌一次）
  for (const position of ['UTG', 'HJ', 'CO', 'SB', 'BB']) {
    await click(seatNode(position), `座位 ${position}`);
    await click(findButton('加入玩家'), `${position} 的「加入玩家」`);
  }
  const emptySlot = $('heroHandRow').querySelectorAll('div').find((n) => n.className.includes('empty'));
  await click(emptySlot, 'Hero 手牌空槽');
  const picker = (): El[] => $('pickerGrid').querySelectorAll('button.pick');
  for (const code of ['As', 'Kd']) {
    await click(picker().find((b) => b.dataset.card === code), `牌面 ${code}`);
  }
  const handBefore = $('debugFingerprint').textContent;
  const potBefore = $('potLine').textContent;
  const actorBefore = $('actorLine').textContent;
  line(`  标记前的预览指纹（长度 ${handBefore.length}）：${handBefore.slice(0, 96)}…`);

  // 打开 UTG 座位菜单 → 点「暂时离座」（本手进行中：Hero 还没行动，但本手已开始）
  await click(seatNode('UTG'), '座位 UTG');
  const sitOutBtn = findButton('暂时离座');
  const hadSitOut = sitOutBtn !== undefined;
  if (hadSitOut) await click(sitOutBtn, '暂时离座');
  const sitOutRes = requests.filter((r) => r.url === '/api/table').at(-1)?.response;
  const afterSitOut = sitOutRes?.state as PokerTableState | undefined;
  const utgSeatAfter = afterSitOut?.seats.find((s) => s.logicalPosition === 'UTG');
  line(`  点击「暂时离座」：ok=${String(sitOutRes?.ok)} UTG.sitOutNextHand=${String(utgSeatAfter?.sitOutNextHand)} UTG.status=${String(utgSeatAfter?.status)}`);
  line(`  当前手是否变化：指纹 ${handBefore === $('debugFingerprint').textContent ? '未变' : '变了'}；底池 ${potBefore} → ${$('potLine').textContent}；行动者 ${actorBefore} → ${$('actorLine').textContent}`);
  verdict(
    hadSitOut && sitOutRes?.ok === true && utgSeatAfter?.sitOutNextHand === true && utgSeatAfter?.status === 'SEATED_ACTIVE'
      ? 'OK'
      : 'HIT',
    'L6-a',
    utgSeatAfter?.sitOutNextHand === true && utgSeatAfter?.status === 'SEATED_ACTIVE'
      ? '本手进行中点「暂时离座」→ 只设 sitOutNextHand=true，座位状态仍是 SEATED_ACTIVE（本手不受影响）'
      : `不符预期：${String(utgSeatAfter?.sitOutNextHand)} / ${String(utgSeatAfter?.status)}`,
  );
  verdict(
    handBefore === $('debugFingerprint').textContent && potBefore === $('potLine').textContent &&
      handBefore.length > 0
      ? 'OK'
      : 'HIT',
    'L6-b',
    `标记下一手暂离后，当前手的指纹（长度 ${handBefore.length}）与底池显示均未变化`,
  );
  line(`  座位区文本：${seatNode('UTG')?.textContent.replace(/\s+/g, ' ')}`);

  // 重新打开该座位菜单：必须出现「取消「下一手暂离」」
  await click(seatNode('UTG'), '座位 UTG（再次）');
  const cancelBtn = findButton('取消「下一手暂离」');
  const menuText = $('modal').textContent.replace(/\s+/g, ' ').slice(0, 160);
  line(`  座位菜单内容：${menuText}`);
  verdict(
    cancelBtn !== undefined ? 'OK' : 'HIT',
    'L6-c',
    cancelBtn !== undefined
      ? '座位菜单里出现了「取消「下一手暂离」」按钮'
      : '座位菜单里**没有**取消入口（仍只有「暂时离座」/「重新入座」）',
  );

  if (cancelBtn !== undefined) {
    await click(cancelBtn, '取消「下一手暂离」');
    const cancelReq = requests.filter((r) => r.url === '/api/table').at(-1);
    const cancelRes = cancelReq?.response;
    const afterCancel = cancelRes?.state as PokerTableState | undefined;
    const utgSeatCancel = afterCancel?.seats.find((s) => s.logicalPosition === 'UTG');
    line(`  点击载荷=${JSON.stringify(cancelReq?.body?.op)}`);
    line(`  取消后：UTG.sitOutNextHand=${String(utgSeatCancel?.sitOutNextHand)} UTG.status=${String(utgSeatCancel?.status)} 历史长度=${String(afterCancel?.actionHistory.length)} handActive=${String(afterCancel?.handActive)}`);
    verdict(
      cancelRes?.ok === true && utgSeatCancel?.sitOutNextHand === false && utgSeatCancel?.status === 'SEATED_ACTIVE'
        ? 'OK'
        : 'HIT',
      'L6-d',
      utgSeatCancel?.sitOutNextHand === false
        ? '点击后 sitOutNextHand 变回 false，座位回到 SEATED_ACTIVE，当前手状态未变'
        : `取消失败：sitOutNextHand=${String(utgSeatCancel?.sitOutNextHand)}`,
    );
  }

  /* ---------- §4 汇总 ---------- */
  section('§4 增量复验汇总');
  line(`OK=${counters.OK} HIT=${counters.HIT} INFO=${counters.INFO}`);
  line(`前端异常捕获：${sandboxErrors.length === 0 ? '（无）' : sandboxErrors.join(' | ')}`);
  verdict(
    sandboxErrors.length === 0 ? 'OK' : 'HIT',
    'L6-e',
    sandboxErrors.length === 0 ? '驱动真实 table.js 期间没有未处理的 Promise 异常' : `捕获到异常：${sandboxErrors[0]}`,
  );

  const text = OUT.join('\n');
  const outPath = fileURLToPath(new URL('./rt-table-adapter-evidence.txt', import.meta.url));
  const previous = readFileSync(outPath, 'utf8');
  writeFileSync(
    outPath,
    `${previous}\n\n\n${'#'.repeat(78)}\n# 探针 #3：增量复验（RT-L6 / RT-L7 / RT-L8 / RT-L9）\n${'#'.repeat(78)}${text}\n`,
    'utf8',
  );
  process.stdout.write(`\n[证据已追加] ${outPath}\n`);
}

main()
  .then(async () => {
    if (server !== null) await server.close();
    process.exit(0);
  })
  .catch(async (error) => {
    process.stderr.write(`探针 #3 崩溃：${String(error)}\n${(error as Error).stack ?? ''}\n`);
    if (server !== null) await server.close();
    process.exit(1);
  });
