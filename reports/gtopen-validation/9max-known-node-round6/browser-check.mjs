import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const outDir = 'D:/德州决策/reports/gtopen-validation/9max-known-node-round6';
mkdirSync(outDir, { recursive: true });
const chrome = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find(existsSync);
if (!chrome) throw new Error('NO_BROWSER');
if (typeof WebSocket !== 'function') throw new Error('NO_NODE_WEBSOCKET');
const profile = mkdtempSync(join(tmpdir(), 'dsh-gto-known-profile-'));
const port = 9387;
const payload = JSON.parse(readFileSync('D:/德州决策/reports/gtopen-validation/9max-known-node-round6/inject-analysis.json', 'utf8'));
const browser = spawn(chrome, [
  '--headless=new', '--remote-debugging-port=' + port, '--user-data-dir=' + profile,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=1100,2400', 'about:blank',
], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws;
try {
  let target;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
      target = list.find((x) => x.type === 'page');
      if (target?.webSocketDebuggerUrl) break;
    } catch {}
    await sleep(200);
  }
  if (!target?.webSocketDebuggerUrl) throw new Error('CDP_TARGET_MISSING');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let nextId = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data));
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params = {}) => new Promise((resolve) => {
    const id = ++nextId; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const m = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (m.result?.exceptionDetails) throw new Error(JSON.stringify(m.result.exceptionDetails));
    return m.result?.result?.value;
  };
  await send('Page.navigate', { url: 'http://127.0.0.1:5173/' });
  await sleep(1200);
  const result = {
    browser: chrome,
    hook: await evaluate('!!(window.__dshTest && window.__dshTest.render && window.__dshTest.app)'),
    title: await evaluate('document.title'),
    beforeTextLength: await evaluate('document.body.innerText.length'),
  };
  await evaluate('(()=>{' +
    'window.__dshTest.app.analysis=' + JSON.stringify(payload) + ';' +
    'window.__dshTest.render();return true;' +
  '})()');
  await sleep(300);
  const text = await evaluate('document.body.innerText');
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  writeFileSync(outDir + '/browser-dom.txt', text);
  writeFileSync(outDir + '/browser-proof.png', Buffer.from(shot.result.data, 'base64'));
  Object.assign(result, {
    afterTextLength: text.length,
    gtoVisible: text.includes('这条建议用到的对手范围'),
    solverVisible: text.includes('【求解器】'),
    admissionVisible: text.includes('已通过准入'),
    approximateVisible: text.includes('近似延续模型'),
    notVerifiedVisible: text.includes('不是已验证数据'),
    effectiveWidthVisible: text.includes('等效宽度 94.1'),
    bad1225Label: text.includes('有效组合 1225'),
    actionVisible: text.includes('建议：全下'),
    rangeExcerpt: text.split('\n').filter((l) => l.includes('对手范围') || l.includes('【求解器】') || l.includes('等效宽度')).slice(0, 6),
    screenshot: outDir + '/browser-proof.png',
  });
  writeFileSync(outDir + '/browser-result.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  try { ws?.close(); } catch {}
  browser.kill();
}
