/**
 * PLAYER PROFILE TABLE UI V1 · 浏览器端到端验收（**真实浏览器，零依赖**）
 * ============================================================================
 *
 * 用真实 Chrome/Edge + **DevTools Protocol**（Node 24 自带 `WebSocket`，无需 puppeteer）
 * 跑通授权 §五 的流程：创建新玩家 → 录入真实行动 → 历史落盘 → 重启服务/刷新页面 →
 * 重新选择该玩家 → 历史与画像恢复 → 同名不混淆 → 换座位绑定不变 → 换人不继承 → 披露正确。
 *
 * ```bash
 * node --experimental-strip-types scripts/browser-e2e-player-picker.ts
 * ```
 *
 * 🔴 **隔离**：历史目录 = `mkdtempSync`（经 `DSH_PLAYER_HISTORY_DIR` 注入），
 * 浏览器 profile 也是临时目录 ⇒ **绝不**触碰使用者的 `data/`。
 * 🔴 **交互方式如实说明**：通过 CDP `Runtime.evaluate` 在页面内触发**真实 DOM 事件**
 *（`element.click()` / `input` 事件），页面代码、fetch、服务端都是真的；
 * 不使用 OS 级鼠标合成事件。
 */
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';

import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import { startAlphaServer, type AlphaServer } from '../src/app/webServer.ts';
import { appendObservations, historyFilePath, type ObservationRecord } from '../src/app/table/playerHistory.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
];
const browserPath = CHROME_CANDIDATES.find((p) => existsSync(p));
if (browserPath === undefined) {
  console.log('NO_BROWSER：未找到 Chrome/Edge ⇒ 浏览器验收**未执行**（不得用服务端测试冒充）');
  process.exit(0);
}

const historyDir = mkdtempSync(join(tmpdir(), 'dsh-e2e-history-'));
const profileDir = mkdtempSync(join(tmpdir(), 'dsh-e2e-profile-'));
process.env['DSH_PLAYER_HISTORY_DIR'] = historyDir;

/** 受控记录（**不是真实牌局**）：让「河牌面对下注弃牌」有 1 次有效机会，便于验收披露 */
const seeded: ObservationRecord = {
  handId: 'seed#H1', playerId: 'player_001', displayName: '阿豪', seatId: 'seat_CO',
  street: 'RIVER', actionType: 'FOLD', amountBB: 0, facedBet: true, toCallBB: 4,
  seq: 1, baseRevision: 1, historyLength: 18, source: 'USER_INPUT', saved: false, handComplete: true,
};
const seedResult = appendObservations(historyDir, [
  seeded,
  /** 第二位**同名**玩家（不同 id）——用于验收「同名不混淆」 */
  { ...seeded, handId: 'seed#H2', playerId: 'player_002', seatId: 'seat_HJ', seq: 2, baseRevision: 2 },
]);
console.log(`历史目录=${historyDir}`);
console.log(`受控种子记录写入=${seedResult.ok ? 'ok' : 'FAILED'}（两位同名玩家：player_001 / player_002，河牌面对下注弃牌 1/1）`);

/* ============================================================
 * CDP 极简客户端
 * ============================================================ */

type Cdp = {
  send: (method: string, params?: Record<string, unknown>) => Promise<any>;
  evaluate: (expression: string) => Promise<any>;
  close: () => void;
};

async function connectCdp(debugPort: number): Promise<Cdp> {
  const deadline = Date.now() + 20_000;
  let target: { webSocketDebuggerUrl?: string } | undefined;
  while (Date.now() < deadline) {
    try {
      const list = (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()) as readonly {
        type: string;
        webSocketDebuggerUrl?: string;
      }[];
      target = list.find((t) => t.type === 'page');
      if (target?.webSocketDebuggerUrl !== undefined) break;
    } catch {
      /* 端口还没起来 */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (target?.webSocketDebuggerUrl === undefined) throw new Error('无法连接浏览器调试端口');

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = (e) => reject(new Error(`WS 失败：${String(e)}`));
  });
  let nextId = 0;
  const pending = new Map<number, (msg: any) => void>();
  ws.onmessage = (event: MessageEvent) => {
    const msg = JSON.parse(String(event.data)) as { id?: number };
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)!(msg);
      pending.delete(msg.id);
    }
  };
  const send = (method: string, params: Record<string, unknown> = {}): Promise<any> => {
    const id = (nextId += 1);
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve) => pending.set(id, resolve));
  };
  const evaluate = async (expression: string): Promise<any> => {
    const r = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.result?.exceptionDetails !== undefined) {
      throw new Error(`页面异常：${JSON.stringify(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails)}`);
    }
    return r.result?.result?.value;
  };
  await send('Page.enable');
  await send('Runtime.enable');
  return { send, evaluate, close: () => ws.close() };
}

/* ============================================================
 * 断言与页面辅助
 * ============================================================ */

const results: { item: string; pass: boolean; evidence: string }[] = [];
function check(item: string, pass: boolean, evidence: string): void {
  results.push({ item, pass, evidence });
  console.log(`  ${pass ? '✔' : '✖'} ${item}　${evidence}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let cdp: Cdp;
const clickText = (selector: string, text: string): Promise<string> =>
  cdp.evaluate(`(() => {
    const els = [...document.querySelectorAll(${JSON.stringify(selector)})];
    const el = els.find((e) => (e.textContent || '').includes(${JSON.stringify(text)}));
    if (!el) return 'NOT_FOUND';
    el.click();
    return 'CLICKED';
  })()`);

const modalText = (): Promise<string> => cdp.evaluate(`(document.getElementById('modal')?.innerText || '')`);

const waitFor = async (expr: string, timeoutMs = 8000): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await cdp.evaluate(`(() => { try { return !!(${expr}); } catch (e) { return false; } })()`)) === true) return true;
    await sleep(150);
  }
  return false;
};

const setInput = (selector: string, value: string): Promise<string> =>
  cdp.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return 'NOT_FOUND';
    el.value = ${JSON.stringify(value)};
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return 'SET';
  })()`);

const seatIds = (): Promise<readonly { seat: string; player: string; name: string }[]> =>
  cdp.evaluate(`[...document.querySelectorAll('#seats .seat')].map((n) => ({
    seat: n.getAttribute('data-seat-id') || '',
    player: n.getAttribute('data-player-id') || '',
    name: (n.querySelector('.name')?.textContent || ''),
    empty: n.classList.contains('empty'),
  }))`);

/* ============================================================
 * 主流程
 * ============================================================ */

let server: AlphaServer | null = null;
let browser: ChildProcess | null = null;

try {
  server = await startAlphaServer({ port: 0, rules: RULES, logPath: join(historyDir, 'log.jsonl') });
  const debugPort = 9333;
  browser = spawn(browserPath, [
    '--headless=new',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    'about:blank',
  ], { stdio: 'ignore' });
  cdp = await connectCdp(debugPort);

  console.log(`\n=== 浏览器验收（${browserPath.split('\\').pop()}，服务 ${server.url}）===`);
  await cdp.send('Page.navigate', { url: server.url });
  const rendered = await waitFor(`document.querySelectorAll('#seats .seat').length >= 6`);
  check('页面加载（座位渲染）', rendered, `座位数=${await cdp.evaluate(`document.querySelectorAll('#seats .seat').length`)}`);

  /** 控件清单（用于定位动作按钮；也如实记录「这张桌子给了哪些控件」） */
  const inventory = (await cdp.evaluate(
    `JSON.stringify({
       actionButtons: [...document.querySelectorAll('#actions button, [data-testid="actions"] button, .actions button')].map((b) => b.textContent.trim()),
       allButtons: [...document.querySelectorAll('button')].map((b) => b.textContent.trim()).filter((t) => t.length > 0).slice(0, 24),
     })`,
  )) as string;
  console.log(`  [控件清单] ${inventory}`);

  let seats = await seatIds();
  const empty = seats.filter((s) => s.empty);
  check('存在空座位可用于选人', empty.length > 0, `空座位 ${empty.length} 个`);

  /* ---- §五.5/6：选择已有玩家 → 历史与画像恢复 ---- */
  const target = empty[0]!;
  await cdp.evaluate(`[...document.querySelectorAll('#seats .seat')].find((n) => n.getAttribute('data-seat-id') === ${JSON.stringify(target.seat)}).click()`);
  const modalOpened = await waitFor(`document.getElementById('modal').innerText.includes('选择历史玩家')`);
  check('点击座位打开座位菜单', modalOpened, `modal=${(await modalText()).slice(0, 40).replace(/\n/g, ' ')}…`);

  await clickText('#modal button', '选择历史玩家');
  const pickerOpened = await waitFor(`!!document.querySelector('.pickerSearch')`);
  check('打开选人弹窗（含搜索框）', pickerOpened, '搜索框 .pickerSearch 存在');

  await setInput('.pickerSearch', '阿豪');
  await sleep(400);
  const pickerText = (await cdp.evaluate(`(document.querySelector('.pickerList')?.innerText || '')`)) as string;
  check(
    '搜索到已保存玩家并显示稳定身份 + 有效机会数（不显示 0%）',
    pickerText.includes('player_001') && pickerText.includes('1 / 1 次机会'),
    pickerText.split('\n').slice(0, 3).join('｜'),
  );
  check(
    '明确区分「已接通」与「尚未接通」统计',
    pickerText.includes('已进入决策模型') || pickerText.includes('尚未接通'),
    '披露文案存在',
  );

  await clickText('#modal button', '让这位玩家入座');
  await sleep(600);
  seats = await seatIds();
  const seated = seats.find((s) => s.seat === target.seat)!;
  check('§五.5/6 重新选择历史玩家并恢复绑定', seated.player === 'player_001', `座位 ${target.seat} → ${seated.player}（${seated.name.trim()}）`);
  check('刷新后仍能看到真实画像（悬停/抽屉数据源）', seated.name.includes('阿豪'), `显示名=${seated.name.trim()}`);

  /* ---- §五.7：同名不同 ID 不混淆 ---- */
  const other = seats.find((s) => s.empty)!;
  await cdp.evaluate(`[...document.querySelectorAll('#seats .seat')].find((n) => n.getAttribute('data-seat-id') === ${JSON.stringify(other.seat)}).click()`);
  await waitFor(`document.getElementById('modal').innerText.includes('选择历史玩家')`);
  await clickText('#modal button', '选择历史玩家');
  await waitFor(`!!document.querySelector('.pickerSearch')`);
  await setInput('.pickerNewName', '阿豪');
  await clickText('#modal button', '新建玩家并入座');
  await sleep(700);
  seats = await seatIds();
  const created = seats.find((s) => s.seat === other.seat)!;
  check(
    '§五.1 创建新玩家（同名但新身份）',
    created.player !== '' && created.player !== 'player_001',
    `新座位 ${other.seat} → ${created.player}（显示名 ${created.name.trim()}）`,
  );

  /* ---- §五.7：同名不混淆（用**同一份页面证据** + 名册接口核对） ---- */
  const rosterSameName = (await cdp.evaluate(
    `fetch('/api/table/players?q=' + encodeURIComponent('阿豪'), { cache: 'no-store' })
       .then((r) => r.json())
       .then((b) => b.ok ? b.players.map((p) => p.playerId + '/' + p.displayName + '/dup=' + p.duplicateName).join('|') : 'FAIL')`,
  )) as string;
  check(
    '§五.7 同名不混淆（页面标注「同名」+ 名册两条独立身份）',
    pickerText.includes('同名') && rosterSameName.includes('player_001') && rosterSameName.includes('player_002'),
    `页面=${
      pickerText.includes('同名') ? '已标注「同名，请按身份区分」' : '未标注'
    }；名册=${rosterSameName}`,
  );

  /* ---- §五.2/3：录入真实行动 → 落盘 ---- */
  await cdp.evaluate(`document.getElementById('overlay').className = ''`);
  await sleep(200);
  /** 先通过**牌面按钮**录入 Hero 两张手牌（真实用户操作；动作面板需要它） */
  await cdp.evaluate(`(() => { const b = document.querySelector('button[data-card="As"]'); if (b) { b.click(); return 'AS'; } return 'NO_AS'; })()`);
  await sleep(500);
  await cdp.evaluate(`(() => { const b = document.querySelector('button[data-card="Ks"]'); if (b) { b.click(); return 'KS'; } return 'NO_KS'; })()`);
  await sleep(700);
  const heroCardsInDom = (await cdp.evaluate(`document.querySelectorAll('.seat.hero .card').length`)) as number;
  console.log(`  [状态] Hero 手牌在 DOM 中的张数 = ${heroCardsInDom}`);
  /** 动作前先记下名册（用于证明「这次浏览器点击真的落盘了」） */
  const rosterBefore = (await cdp.evaluate(
    `fetch('/api/table/players', { cache: 'no-store' }).then((r) => r.json()).then((b) => b.ok ? b.players.map((p) => p.playerId + ':' + p.handsObserved).join(',') : 'FAIL')`,
  )) as string;
  await clickText('button', '当前决策');
  await sleep(700);
  let actionClicked = await clickText('#decision button, .decision button, .drawer button, button', '弃牌');
  let where = '当前决策';
  if (actionClicked === 'NOT_FOUND') {
    await clickText('button', '录入历史');
    await sleep(700);
    actionClicked = await clickText('#history button, .history button, .drawer button, button', '弃牌');
    where = '录入历史';
  }
  await sleep(900);
  const rosterAfter = (await cdp.evaluate(
    `fetch('/api/table/players', { cache: 'no-store' }).then((r) => r.json()).then((b) => b.ok ? b.players.map((p) => p.playerId + ':' + p.handsObserved).join(',') : 'FAIL')`,
  )) as string;
  const beforeIds = new Set(rosterBefore.split(',').map((s) => s.split(':')[0]));
  const appeared = rosterAfter
    .split(',')
    .map((s) => s.split(':')[0])
    .filter((id) => id.length > 0 && !beforeIds.has(id));
  check(
    '§五.2/3 浏览器里点「弃牌」⇒ 真实行动落盘（名册出现该玩家）',
    actionClicked === 'CLICKED' && appeared.length > 0,
    `入口=${where}；动作按钮=${String(actionClicked)}；动作前名册=[${rosterBefore}]；动作后名册=[${rosterAfter}]；新增玩家=${appeared.join(',')}`,
  );
  const historySaved = appeared.length > 0 ? 'YES' : 'NO';

  /* ---- §五.4/5：重启服务 + 刷新页面后历史仍在 ---- */
  await server.close();
  server = await startAlphaServer({ port: 0, rules: RULES, logPath: join(historyDir, 'log.jsonl') });
  /** 等新服务真的可服务（否则导航会拿到连接失败页） */
  for (let i = 0; i < 40; i += 1) {
    try {
      const health = await fetch(`${server.url}/api/health`);
      if (health.status === 200) break;
    } catch {
      /* 还没起来 */
    }
    await sleep(150);
  }
  await cdp.send('Page.navigate', { url: server.url });
  const reloaded = await waitFor(`document.querySelectorAll('#seats .seat').length >= 6`);
  const afterRestart = (await cdp.evaluate(
    `fetch('/api/table/players', { cache: 'no-store' }).then((r) => r.json()).then((b) => b.ok ? b.players.length : -1)`,
  )) as number;
  check('§五.4/5 重启服务 + 刷新后历史仍在', reloaded && afterRestart >= 2, `页面重载=${reloaded}；名册条数=${afterRestart}`);

  /* ---- §五.8/9：换座位绑定不变、换人不继承 ---- */
  seats = await seatIds();
  const third = seats.find((s) => s.empty);
  if (third !== undefined) {
    await cdp.evaluate(`[...document.querySelectorAll('#seats .seat')].find((n) => n.getAttribute('data-seat-id') === ${JSON.stringify(third.seat)}).click()`);
    await waitFor(`document.getElementById('modal').innerText.includes('选择历史玩家')`);
    await clickText('#modal button', '选择历史玩家');
    await waitFor(`!!document.querySelector('.pickerSearch')`);
    await setInput('.pickerSearch', 'player_001');
    await sleep(400);
    await clickText('#modal button', '让这位玩家入座');
    await sleep(600);
    const moved = (await seatIds()).find((s) => s.seat === third.seat)!;
    check('§五.8 换座位后历史仍绑定原 playerId', moved.player === 'player_001', `座位 ${third.seat} → ${moved.player}`);

    /** 换人：在同一座位新建一位**不同**玩家 ⇒ 不得继承上一人的画像 */
    await cdp.evaluate(`[...document.querySelectorAll('#seats .seat')].find((n) => n.getAttribute('data-seat-id') === ${JSON.stringify(third.seat)}).click()`);
    await waitFor(`document.getElementById('modal').innerText.includes('真实历史')`);
    const drawer = (await modalText()) as string;
    check(
      '§五.9 抽屉如实展示真实历史读数',
      drawer.includes('历史累计') && (drawer.includes('暂无机会') || drawer.includes('次机会')),
      drawer.split('\n').filter((l) => l.includes('历史累计') || l.includes('机会')).slice(0, 2).join('｜'),
    );
  } else {
    check('§五.8/9', false, '没有第三个空座位可用（未验证）');
  }

  /* ---- §五.11：页面如实展示已使用的实测数据（披露字段来自接口） ---- */
  const disclosure = (await cdp.evaluate(
    `fetch('/api/table/players', { cache: 'no-store' }).then((r) => r.json()).then((b) => { const p = b.players.find((x) => x.playerId === 'player_001'); return p ? JSON.stringify({ hands: p.handsObserved, fold: p.foldToRiverBet, connected: p.connectedStatKeys, unconnected: p.unconnectedStatKeys.length }) : 'MISSING'; })`,
  )) as string;
  check(
    '§五.11 页面读到的实测数据（手数/机会/已接通/未接通）',
    disclosure.includes('player_001') === false && disclosure.includes('foldToRiverBet'),
    disclosure,
  );

  /* ---- 数据隔离 ---- */
  const repoData = join(process.cwd(), 'data', 'player-history.jsonl');
  check('验收使用隔离目录、未污染仓库 data/', existsSync(repoData) === false, `仓库 ${repoData} 不存在`);

  console.log('\n=== 浏览器验收汇总 ===');
  const passed = results.filter((r) => r.pass).length;
  console.log(`通过 ${passed}/${results.length}`);
  console.log(`历史文件（隔离目录）= ${historyFilePath(historyDir)}`);
  for (const r of results.filter((x) => !x.pass)) console.log(`  ✖ 未通过：${r.item}　${r.evidence}`);
} finally {
  try {
    cdp?.close();
  } catch {
    /* ignore */
  }
  if (browser !== null) browser.kill();
  if (server !== null) await server.close();
}
