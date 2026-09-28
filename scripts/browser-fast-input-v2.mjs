/**
 * FAST INPUT UI V2 acceptance: real isolated Chrome + CDP Input events.
 * Run: node scripts/browser-fast-input-v2.mjs
 * No app/DOM state injection. Runtime.evaluate reads DOM, geometry and the
 * existing read-only test hook; all interactions use CDP mouse/key/IME input.
 * A response-stage transport failure tests retry after the real server commits.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync } from 'node:fs';
import { tmpdir, cpus, release } from 'node:os';
import { createServer as httpServer, request as httpRequest } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'reports', 'fast-input-decision-v2', process.env.FAST_UI_RUN_SUFFIX || 'browser');
mkdirSync(output, { recursive: true });
const historyDir = mkdtempSync(join(tmpdir(), 'dsh-fast-v2-history-'));
const profileDir = mkdtempSync(join(tmpdir(), 'dsh-fast-v2-chrome-'));
const browserPath = [process.env.DSH_CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => p && existsSync(p));
const results = [], network = [], consoleLog = [], timings = [], serverLog = [];
const captures = [], tasks = new Set();
let browser, server, cdp, serverUrl, legacyProxy, browserVersion, failureArmed = false, droppedResponse = null, holdAnalysis = false;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now();
function record(name, pass, evidence) {
  results.push({ name, pass, evidence });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}: ${typeof evidence === 'string' ? evidence : JSON.stringify(evidence)}`);
}
function track(promise) {
  tasks.add(promise);
  promise.finally(() => tasks.delete(promise));
}
async function availablePort() {
  const listener = createServer();
  await new Promise((done) => listener.listen(0, '127.0.0.1', done));
  const port = listener.address().port;
  await new Promise((done) => listener.close(done));
  return port;
}
async function startServer() {
  const cacheDir=mkdtempSync(join(tmpdir(),'dsh-fast-v2-cache-'));
  if(process.env.FAST_UI_GTO==='1')cpSync(join(root,'data/gto-cache'),cacheDir,{recursive:true});
  const entry = pathToFileURL(join(root, 'src/app/webServer.ts')).href;
  const code = `import {startAlphaServer} from ${JSON.stringify(entry)}; const s = await startAlphaServer({port:0,logPath:null,gtoBackgroundSolve:false}); console.log('FAST_SERVER_URL='+s.url);`;
  server = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '--eval', code], {
    cwd: root, windowsHide: true, env: { ...process.env, DSH_PLAYER_HISTORY_DIR: historyDir,
      ALPHA_GTO: process.env.FAST_UI_GTO==='1'?'1':'0', ALPHA_GTO_CACHE_DIR:cacheDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (chunk) => {
    const value = String(chunk); serverLog.push(value);
    const match = value.match(/FAST_SERVER_URL=(http:\/\/[^\s]+)/);
    if (match) serverUrl = match[1];
  });
  server.stderr.on('data', (chunk) => serverLog.push(String(chunk)));
  for (let n = 0; n < 200 && !serverUrl; n++) {
    if (server.exitCode !== null) throw new Error(`Server exited: ${serverLog.join('')}`);
    await pause(100);
  }
  assert.ok(serverUrl, 'server startup timed out');
}
async function connect(port) {
  let target;
  for (let n = 0; n < 160; n++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (target) break;
    } catch { /* Browser starting. */ }
    await pause(100);
  }
  assert.ok(target, 'Chrome CDP unavailable');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((done, reject) => { ws.onopen = done; ws.onerror = reject; });
  let sequence = 0;
  const pending = new Map();
  const send = (method, params = {}) => new Promise((done, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout ${method}`)); }, 25000);
    pending.set(id, { done, reject, timer });
    ws.send(JSON.stringify({ id, method, params }));
  });
  ws.onmessage = ({ data }) => {
    const message = JSON.parse(String(data));
    if (message.id) {
      const handler = pending.get(message.id);
      if (!handler) return;
      pending.delete(message.id); clearTimeout(handler.timer);
      if (message.error) handler.reject(new Error(JSON.stringify(message.error)));
      else handler.done(message.result);
      return;
    }
    const { method, params } = message;
    if (method === 'Runtime.consoleAPICalled' || method === 'Runtime.exceptionThrown' || method === 'Log.entryAdded') {
      consoleLog.push({ at: new Date().toISOString(), method, params });
    }
    if (method?.startsWith('Network.')) {
      if (['Network.requestWillBeSent', 'Network.responseReceived', 'Network.loadingFailed'].includes(method)) {
        network.push({ at: new Date().toISOString(), method, params });
      }
      if (method === 'Network.loadingFinished') {
        const request = network.findLast((e) => e.method === 'Network.requestWillBeSent' && e.params.requestId === params.requestId);
        if (request?.params.request.url.endsWith('/api/analyze')) {
          track(send('Network.getResponseBody', { requestId: params.requestId }).then((body) => {
            const payload = JSON.parse(body.body);
            timings.push({ kind: 'serverAnalysis', serverTimings: payload.meta?.serverTimings ?? null, ok: payload.ok });
          }).catch((error) => timings.push({ kind: 'serverAnalysisReadError', message: String(error) })));
        }
      }
    }
    if (method === 'Fetch.requestPaused') {
      if (holdAnalysis && params.request.url.endsWith('/api/analyze')) return;
      let body;
      try { body = JSON.parse(params.request.postData || '{}'); } catch { body = {}; }
      if (failureArmed && params.responseStatusCode && body.op?.kind === 'ACT') {
        failureArmed = false;
        droppedResponse = { requestId: body.requestId, revision: body.state?.revision, action: body.op.action };
        track(send('Fetch.failRequest', { requestId: params.requestId, errorReason: 'ConnectionClosed' }).catch(() => {}));
      } else {
        track(send('Fetch.continueRequest', { requestId: params.requestId }).catch(() => {}));
      }
    }
  };
  const read = async (expression) => {
    const response = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || JSON.stringify(response.exceptionDetails));
    return response.result?.value;
  };
  await Promise.all(['Page.enable', 'Runtime.enable', 'Network.enable', 'Log.enable'].map((method) => send(method)));
  return { send, read, close: () => ws.close() };
}
async function wait(expression, ms = 10000) {
  const start = now();
  while (now() - start < ms) {
    try { if (await cdp.read(`Boolean(${expression})`)) return; } catch { /* Navigation transient. */ }
    await pause(40);
  }
  throw new Error(`Timed out: ${expression}`);
}
const appRead = (expression) => cdp.read(`(()=>{const a=window.__dshTest.app;return (${expression});})()`);
const state = () => appRead('({state:a.state,preview:a.preview,mode:a.mode,analysis:a.analysis,metrics:a.metrics||[]})');
async function point(selector, text, index = 0) {
  const value = await cdp.read(`(()=>{let els=[...document.querySelectorAll(${JSON.stringify(selector)})];
    if(${JSON.stringify(text ?? null)}!==null)els=els.filter(e=>e.textContent.includes(${JSON.stringify(text ?? '')}));
    const e=els[${index}];if(!e)return null;const r=e.getBoundingClientRect();
    return {x:r.x+r.width/2,y:r.y+r.height/2,width:r.width,height:r.height,disabled:!!e.disabled};})()`);
  assert.ok(value && value.width > 0 && value.height > 0, `Missing visible target ${selector} ${text ?? ''}`);
  return value;
}
async function click(selector, text, index = 0, count = 1) {
  const p = await point(selector, text, index);
  assert.equal(p.disabled, false, `Disabled target ${selector}`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
  for (let i = 1; i <= count; i++) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: i });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: i });
  }
}
async function key(keyName, code, options = {}) {
  const params = { key: keyName, code, ...options };
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...params });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...params });
}
async function text(selector, value) {
  await click(selector);
  await key('a', 'KeyA', { modifiers: 2, windowsVirtualKeyCode: 65 });
  await key('Backspace', 'Backspace', { windowsVirtualKeyCode: 8 });
  if (value) await cdp.send('Input.insertText', { text: value });
}
async function screenshot(name) {
  const response = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const path = join(output, `${name}.png`);
  writeFileSync(path, Buffer.from(response.data, 'base64')); captures.push(path);
}
async function mutation(selector, textValue, index = 0) {
  const before = await appRead('a.state.revision');
  const start = now();
  await click(selector, textValue, index);
  await wait(`window.__dshTest.app.state.revision > ${before}`);
  timings.push({ kind: 'browserMutationVisible', selector, elapsedMs: now() - start });
  // Ordinary steps model distinct user actions outside the documented 350 ms
  // duplicate-click guard. The dedicated double-click suite omits this spacing.
  await pause(380);
}
async function setup() {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url: serverUrl });
  await wait('window.__dshTest?.app?.state && document.querySelector("#amountInput")');
  await click('#modeButtons button', '录入历史');
  await mutation('#fillSeatsBtn');
  await click('#heroHandRow .card', undefined, 0);
  await mutation('button.pick[data-card="As"]');
  await mutation('button.pick[data-card="Kd"]');
  if (await cdp.read('!document.querySelector("#cardPicker").hidden')) await click('#closePickerBtn');
  await click('#unitBB');
  assert.equal((await state()).state.heroCards.length, 2);
}
async function act(selector, amount) {
  if (amount !== undefined) await text('#amountInput', String(amount));
  await mutation(selector);
}
async function fixture() {
  await setup();
  await act('#foldAction'); await act('#foldAction');
  await act('#raiseAction', '2.5'); await act('#raiseAction', '10');
  await act('#foldAction'); await act('#foldAction'); await act('#raiseAction', '22');
  const actual = await state();
  assert.equal(actual.preview.currentActorPosition, 'BTN');
  assert.equal(actual.preview.amountInput.minRaiseToChips / actual.preview.amountInput.bigBlindChips, 34);
}
async function suite(name, run) {
  if(process.env.FAST_UI_SUITES && !new RegExp(process.env.FAST_UI_SUITES).test(name))return;
  console.log(`RUN ${name}`);
  try { await run(); record(name, true, 'Assertions passed using real UI and server.'); }
  catch (error) {
    record(name, false, String(error.stack || error));
    try { await screenshot(`failure-${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`); } catch { /* Browser may be unavailable. */ }
  }
  try { timings.push({ kind:'frontendMetrics', suite:name, metrics:await appRead('a.metrics||[]') }); } catch { /* Failed navigation. */ }
}

try {
  assert.ok(browserPath, 'Chrome not found. Set DSH_CHROME_PATH to an installed Chrome executable.');
  await startServer();
  const port = await availablePort();
  browser = spawn(browserPath, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', 'about:blank'], { windowsHide: true, stdio: 'ignore' });
  cdp = await connect(port);
  browserVersion=await cdp.send('Browser.getVersion');

  await suite('raise-to minimum and action order', async () => {
    await fixture();
    const a = await state();
    assert.deepEqual(a.state.actionHistory.map((x) => [x.position, x.type]),
      [['UTG','FOLD'],['HJ','FOLD'],['CO','RAISE'],['BTN','RAISE'],['SB','FOLD'],['BB','FOLD'],['CO','RAISE']]);
    record('34 BB authoritative minimum', true, a.preview.amountInput);
    await screenshot('reraise-minimum-34bb');
    await act('#raiseAction', '34');
    assert.equal((await state()).state.actionHistory.at(-1).amountBB, 34);
    await mutation('#undoBtn');
    assert.equal((await state()).state.actionHistory.length, 7);
    await click('#unitChips');
    await act('#raiseAction', String(34 * a.preview.amountInput.bigBlindChips));
    assert.equal((await state()).state.actionHistory.at(-1).amountBB, 34);
  });

  await suite('invalid amounts and local input undo', async () => {
    await fixture();
    const revision = (await state()).state.revision;
    for (const invalid of ['', '-1', '1.23456789', 'Infinity', '99999999999999999999', '33.99']) {
      await text('#amountInput', invalid);
      await key('Enter', 'Enter', { windowsVirtualKeyCode: 13 });
      await pause(150);
      assert.equal((await state()).state.revision, revision, `Invalid amount committed: ${invalid}`);
      record(`reject ${invalid || '(empty)'}`, true, await cdp.read('({value:document.querySelector("#amountInput").value,error:document.querySelector("#amountError").textContent})'));
    }
    await text('#amountInput', '40');
    await cdp.send('Input.insertText', { text: '5' });
    await key('z', 'KeyZ', { modifiers: 2, windowsVirtualKeyCode: 90 });
    await pause(100);
    assert.equal((await state()).state.revision, revision, 'Ctrl+Z in text must not undo poker action');
    await screenshot('invalid-amount-feedback');
  });

  await suite('quick amount fills without submitting and unit round trip', async () => {
    await fixture();
    const revision=(await state()).state.revision;
    await click('#sizeButtons button',undefined,1);
    const bb=await cdp.read('document.querySelector("#amountInput").value');
    await click('#unitChips');
    assert.equal(Number(await cdp.read('document.querySelector("#amountInput").value')),Number(bb)*100);
    await click('#unitBB');
    assert.equal(await cdp.read('document.querySelector("#amountInput").value'),bb);
    assert.equal((await state()).state.revision,revision);
    await act('#raiseAction');
    assert.equal((await state()).state.actionHistory.at(-1).amountBB,Number(bb));
  });

  await suite('double click repeat and IME guards', async () => {
    await setup();
    const before = (await state()).state.actionHistory.length;
    await click('#foldAction', undefined, 0, 2);
    await wait(`window.__dshTest.app.state.actionHistory.length > ${before}`);
    await pause(250);
    assert.equal((await state()).state.actionHistory.length, before + 1, 'double click recorded more than one action');
    await text('#amountInput', '3');
    const revision = (await state()).state.revision;
    await cdp.send('Input.imeSetComposition', { text: '三', selectionStart: 1, selectionEnd: 1 });
    await key('Enter', 'Enter', { windowsVirtualKeyCode: 229, nativeVirtualKeyCode: 229 });
    await pause(100);
    assert.equal((await state()).state.revision, revision, 'IME Enter must not commit action');
    await cdp.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 });
    await text('#amountInput', '3');
    const length = (await state()).state.actionHistory.length;
    await key('Enter', 'Enter', { windowsVirtualKeyCode: 13 });
    for (let n = 0; n < 3; n++) await key('Enter', 'Enter', { windowsVirtualKeyCode: 13, autoRepeat: true });
    await wait(`window.__dshTest.app.state.actionHistory.length > ${length}`);
    await pause(200);
    assert.equal((await state()).state.actionHistory.length, length + 1, 'held Enter repeated an action');
  });

  await suite('card replacement clear and undo', async () => {
    await setup();
    await click('#heroHandRow .card', undefined, 0);
    await mutation('button.pick[data-card="Ah"]');
    const cards = (await state()).state.heroCards;
    assert.ok(cards.includes('Ah') && cards.includes('Kd') && !cards.includes('As'));
    await click('#heroHandRow .card', undefined, 1);
    await mutation('#clearCardBtn');
    assert.equal((await state()).state.heroCards.length, 1);
    if (await cdp.read('!document.querySelector("#cardPicker").hidden')) await click('#closePickerBtn');
    await mutation('#undoBtn');
    assert.equal((await state()).state.heroCards.length, 2);
    for (const [index, card] of ['2c','3d','4h'].entries()) {
      await click('#boardRow .slot', undefined, index);
      await mutation(`button.pick[data-card="${card}"]`);
    }
    await click('#boardRow .slot', undefined, 1);
    await mutation('button.pick[data-card="5s"]');
    assert.deepEqual((await state()).state.board, ['2c','5s','4h']);
    await click('#boardRow .slot', undefined, 2);
    await mutation('#clearCardBtn');
    assert.deepEqual((await state()).state.board, ['2c','5s']);
    await screenshot('card-editing');
  });

  await suite('all-in confirmation and undo', async () => {
    await setup();
    const before = (await state()).state.actionHistory.length;
    await click('#allinAction');
    await wait('document.querySelector("#confirmAllin")');
    assert.equal((await state()).state.actionHistory.length, before);
    await screenshot('allin-confirmation');
    await mutation('#confirmAllin');
    assert.equal((await state()).state.actionHistory.length, before + 1);
    await mutation('#undoBtn');
    assert.equal((await state()).state.actionHistory.length, before);
  });

  await suite('short all-in call and check follow engine', async () => {
    await cdp.send('Page.navigate',{url:serverUrl});
    await wait('window.__dshTest?.app?.state && document.querySelector("#amountInput")');
    await click('#modeButtons button','录入历史'); await mutation('#fillSeatsBtn');
    await click('[data-seat-id="seat_UTG"] .stack');
    await text('#modal input[type="number"]','0.5');
    await mutation('#modal button','保存筹码');
    await click('#heroHandRow .card',undefined,0); await mutation('button.pick[data-card="As"]'); await mutation('button.pick[data-card="Kd"]');
    const short=await state();assert.equal(short.preview.amountInput.callIsAllIn,true);
    assert.ok(await cdp.read('document.querySelector("#callAction").textContent.includes("跟注全下")'));
    await mutation('#callAction');assert.equal((await state()).state.actionHistory[0].type,'CALL');
    assert.equal((await state()).state.actionHistory[0].amountBB,0.5);
    await setup();
    for(let i=0;i<5;i++)await act('#callAction');
    assert.equal((await state()).preview.currentActorPosition,'BB');
    assert.equal(await cdp.read('document.querySelector("#callAction").textContent'),'过牌');
    await act('#callAction');assert.equal((await state()).state.actionHistory.at(-1).type,'CHECK');
    await screenshot('short-call-and-check');
  });

  await suite('record and edit during real analysis then reject stale response', async () => {
    await fixture(); await click('#modeButtons button','当前决策');
    const deadline=now()+10000;
    while(now()<deadline){const h=await(await fetch(serverUrl+'/api/health')).json();if(h.analysis?.computing)break;await pause(20);}
    assert.equal(await appRead('a.autoState'),'ANALYZING');
    await text('#amountInput','40');assert.equal(await cdp.read('document.querySelector("#amountInput").value'),'40');
    const oldRevision=(await state()).state.revision;
    await mutation('#callAction');assert.ok((await state()).state.revision>oldRevision);
    await pause(1100);assert.equal((await state()).analysis,null,'obsolete Hero result must stay hidden');
    await mutation('#undoBtn');
    await click('#modeButtons button','录入历史'); await pause(1100);
    assert.equal((await state()).analysis,null,'history mode must reject late analysis');
    await click('#heroHandRow .card',undefined,0);await mutation('button.pick[data-card="Ah"]');
    assert.equal((await state()).analysis,null);
    await screenshot('analysis-does-not-block-recording');
  });

  await suite('offline action recovery preserves single action', async () => {
    await setup();const before=(await state()).state.actionHistory.length;
    await cdp.send('Network.emulateNetworkConditions',{offline:true,latency:0,downloadThroughput:-1,uploadThroughput:-1});
    await click('#foldAction');await wait('document.querySelector("#retrySave")');
    assert.equal((await state()).state.actionHistory.length,before);
    assert.equal(await cdp.read('document.querySelector("#newTableBtn").disabled'),true,
      'uncertain save must lock new-table entry until exact retry resolves');
    await cdp.send('Network.emulateNetworkConditions',{offline:false,latency:0,downloadThroughput:-1,uploadThroughput:-1});
    await mutation('#retrySave');assert.equal((await state()).state.actionHistory.length,before+1);
  });

  await suite('analysis timeout is explicit and recoverable', async () => {
    await fixture();holdAnalysis=true;
    await cdp.send('Fetch.enable',{patterns:[{urlPattern:'*/api/analyze',requestStage:'Request'}]});
    await click('#modeButtons button','当前决策');
    await wait('window.__dshTest.app.analysis?.stage==="TIMEOUT"',35000);
    assert.ok(await cdp.read('document.querySelector("#autoAnalyzeLine").textContent.includes("超时")'));
    assert.equal(await cdp.read('document.querySelector("#callAction").disabled'),false);
    await screenshot('analysis-timeout');holdAnalysis=false;await cdp.send('Fetch.disable');
    await click('#analyzeBtn');await wait('window.__dshTest.app.analysis?.ok===true',20000);
  });

  await suite('lost committed response retry uses one requestId', async () => {
    await setup();
    const before = (await state()).state.actionHistory.length;
    const startNetwork = network.length;
    droppedResponse = null;
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/table', requestStage: 'Response' }] });
    failureArmed = true;
    try {
      await click('#foldAction');
      await wait('document.querySelector("#saveStatus")?.textContent.includes("重试")', 12000);
      assert.ok(droppedResponse, 'No committed response was dropped');
      assert.equal((await state()).state.actionHistory.length, before, 'failed response must not optimistically commit');
      await screenshot('retry-after-lost-response');
      await click('#saveStatus button', '重试');
      await wait(`window.__dshTest.app.state.actionHistory.length === ${before + 1}`);
      await pause(200);
      const posts = network.slice(startNetwork).filter((e) => e.method === 'Network.requestWillBeSent' && e.params.request.url.endsWith('/api/table'))
        .map((e) => JSON.parse(e.params.request.postData || '{}')).filter((body) => body.op?.kind === 'ACT');
      assert.ok(posts.length >= 2, 'Expected ACT and retry');
      assert.ok(posts[0].requestId, 'requestId missing');
      assert.equal(posts[0].requestId, posts[1].requestId, 'retry must reuse requestId');
      assert.equal((await state()).state.actionHistory.length, before + 1);
      record('transport loss evidence', true, { droppedResponse, requestIds: posts.map((p) => p.requestId) });
    } finally { failureArmed = false; await cdp.send('Fetch.disable'); }
  });

  await suite('real analysis with responsive layout and separate timings', async () => {
    await fixture();
    const analysisStart = now();
    await click('#modeButtons button', '当前决策');
    await wait('window.__dshTest.app.analysis !== null', 180000);
    const analyzed = await state();
    timings.push({ kind: 'browserAnalysisVisible', elapsedMs: now() - analysisStart, metrics: analyzed.metrics });
    assert.equal(analyzed.analysis?.ok, true, 'Analysis must succeed, not merely return an error payload');
    for (const [width, height] of [[1366,768],[1024,768],[911,512],[390,844]]) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      await pause(150);
      const geometry = await cdp.read(`(()=>{const ids=['inputDock','rail','tableWrap','amountInput','actionButtons'];
        return {width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,
        boxes:ids.map(id=>{const e=document.getElementById(id);const r=e.getBoundingClientRect();return {id,x:r.x,y:r.y,w:r.width,h:r.height,bottom:r.bottom};})};})()`);
      record(`layout ${width}x${height}`, geometry.scrollWidth <= width + 1, geometry);
      await screenshot(`layout-${width}x${height}`);
      if(width===1366)assert.ok(geometry.boxes.find(b=>b.id==='actionButtons').bottom<=height);
      if(width<1366){
        await cdp.send('Input.dispatchMouseEvent',{type:'mouseWheel',x:width/2,y:height/2,deltaX:0,deltaY:500});
        await pause(250);
        const target=await point('#allinAction');
        assert.ok(target.y>0&&target.y<height,'Action must be reachable by scrolling');
        await click('#allinAction');await wait('document.querySelector("#confirmAllin")');
        await screenshot(`reachable-actions-${width}`);
        await key('Escape','Escape',{windowsVirtualKeyCode:27});
        // Close via existing modal cancel action when Escape is not implemented.
        if(await cdp.read('document.querySelector("#overlay").classList.contains("show")'))await click('#modal button','取消');
        await cdp.send('Input.dispatchMouseEvent',{type:'mouseWheel',x:width/2,y:height/2,deltaX:0,deltaY:-1500});
        await pause(200);
      }
    }
    await cdp.send('Emulation.setDeviceMetricsOverride', { width:1366, height:768, deviceScaleFactor:1, mobile:false });
    const start = now();
    await text('#amountInput', '40');
    await cdp.read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))');
    timings.push({ kind:'browserInputThroughPaint', elapsedMs:now()-start,
      note:'Includes CDP round trips, focus, select-all, insertText and two animation frames; not a pure browser key-to-paint metric.' });
  });

  await suite('next hand and nine seat switch use real controls',async()=>{
    await setup();await act('#foldAction');await mutation('#nextHandBtn');
    assert.equal((await state()).state.actionHistory.length,0);
    assert.equal((await state()).state.heroCards.length,0);
    await click('#tableSizeButtons button','9 人桌');
    await wait('window.__dshTest.app.state.tableSize===9');
    await mutation('#fillSeatsBtn');
    assert.equal(await cdp.read('document.querySelectorAll("#seats .seat").length'),9);
    await screenshot('nine-seat-layout');
  });

  await suite('player profile opens and replacement keeps explicit identity flow',async()=>{
    await cdp.send('Emulation.setDeviceMetricsOverride',{width:1366,height:768,deviceScaleFactor:1,mobile:false});
    await cdp.send('Page.navigate',{url:serverUrl});await wait('window.__dshTest?.app?.state');
    await click('#modeButtons button','录入历史');await mutation('#fillSeatsBtn');
    const before=await cdp.read('document.querySelector("[data-seat-id=seat_UTG]").textContent');
    await click('[data-seat-id="seat_UTG"] .name');
    await wait('document.querySelector("#overlay").classList.contains("show")');
    await wait('document.querySelector("#modal").textContent.includes("真实历史")');
    assert.ok(await cdp.read('document.querySelector("#modal").textContent.includes("更换玩家")'));
    await mutation('#modal button','更换玩家');
    const after=await cdp.read('document.querySelector("[data-seat-id=seat_UTG]").textContent');
    assert.notEqual(after,before);
    await screenshot('player-profile-and-replacement');
  });

  await suite('baseline UI and V2 produce identical normalized input',async()=>{
    await setup();await act('#foldAction');await act('#foldAction');await act('#raiseAction','3');
    const modern=(await state()).preview.manualHandInput;
    legacyProxy=httpServer((req,res)=>{
      const file={'/':'index.html','/table.js':'table.js','/table.css':'table.css'}[req.url];
      if(file){res.setHeader('Content-Type',file.endsWith('.html')?'text/html; charset=utf-8':file.endsWith('.js')?'text/javascript; charset=utf-8':'text/css; charset=utf-8');
        res.end(readFileSync(join(root,'reports/fast-input-decision-v2/baseline-before-web-source',file)));return;}
      const upstream=httpRequest(serverUrl+req.url,{method:req.method,headers:req.headers},r=>{res.writeHead(r.statusCode,r.headers);r.pipe(res);});
      upstream.on('error',e=>{res.statusCode=502;res.end(String(e));});req.pipe(upstream);
    });
    await new Promise(r=>legacyProxy.listen(0,'127.0.0.1',r));
    await cdp.send('Emulation.setDeviceMetricsOverride',{width:1600,height:1400,deviceScaleFactor:1,mobile:false});
    await cdp.send('Page.navigate',{url:`http://127.0.0.1:${legacyProxy.address().port}`});
    await wait('window.__dshTest?.app?.state');
    await click('#modeButtons button','录入历史');await mutation('#fillSeatsBtn');
    await mutation('button.pick[data-card="As"]');await mutation('button.pick[data-card="Kd"]');
    await mutation('#actionButtons button','弃牌');await mutation('#actionButtons button','弃牌');
    await click('#actionButtons button','加注');
    const labels=await cdp.read('[...document.querySelectorAll("#sizeButtons button")].map(x=>x.textContent)');
    const i=labels.findIndex(x=>/加注到 3(?:\.0)? ?BB/.test(x));assert.ok(i>=0,JSON.stringify(labels));
    await mutation('#sizeButtons button',undefined,i);
    const legacy=(await state()).preview.manualHandInput;
    writeFileSync(join(output,'ui-normalized-comparison.json'),JSON.stringify({modern,legacy},null,2));
    assert.deepEqual(modern,legacy);
    await screenshot('original-ui-comparison');
    legacyProxy.close();legacyProxy=null;
  });

  await suite('cached supported nodes repeated real browser analysis',async()=>{
    if(process.env.FAST_UI_GTO!=='1')return;
    await cdp.send('Emulation.setDeviceMetricsOverride',{width:1366,height:768,deviceScaleFactor:1,mobile:false});
    await cdp.send('Page.navigate',{url:serverUrl});await wait('window.__dshTest?.app?.state');
    await click('#modeButtons button','录入历史');
    await click('#tableSizeButtons button','9 人桌');await wait('window.__dshTest.app.state.tableSize===9');
    await mutation('#fillSeatsBtn');await click('#tableSettings summary');
    await mutation('#heroPositionButtons button','（BB）');await click('#tableSettings summary');await click('#unitBB');
    await click('#heroHandRow .card',undefined,0);await mutation('button.pick[data-card="Ah"]');await mutation('button.pick[data-card="Ad"]');
    await act('#raiseAction','2.5');for(let n=0;n<7;n++)await act('#foldAction');
    assert.equal((await state()).preview.currentActorPosition,'BB');
    const samples=[];
    for(const cards of [['Ah','Ad'],['As','Ks'],['Qh','Qd']]){
      for(let i=0;i<2;i++){
        if((await state()).state.heroCards[i]===cards[i])continue;
        await click('#heroHandRow .card',undefined,i);await mutation(`button.pick[data-card="${cards[i]}"]`);
        if(await cdp.read('!document.querySelector("#cardPicker").hidden'))await click('#closePickerBtn');
      }
      await click('#modeButtons button','当前决策');
      await wait('window.__dshTest.app.analysis?.ok===true',20000);
      for(let repeat=0;repeat<10;repeat++){
        const before=await appRead('a.metrics.filter(x=>x.kind==="analysis").length');const started=now();
        await click('#analyzeBtn');
        await wait(`window.__dshTest.app.metrics.filter(x=>x.kind==="analysis").length>${before}`,20000);
        const result=await state();assert.equal(result.analysis.ok,true);
        assert.ok(result.analysis.rangeProvenance.some(p=>p.fromSolver),'Must actually use solver cache');
        const metric=result.metrics.filter(x=>x.kind==='analysis').at(-1);
        samples.push({cards,repeat,displayObservedMs:now()-started,metric,provenance:result.analysis.rangeProvenance,gtoStatus:result.analysis.gtoStatus});
      }
      await screenshot('cached-node-'+cards.join('-'));
      await click('#modeButtons button','录入历史');
    }
    writeFileSync(join(output,'cached-performance.json'),JSON.stringify({note:'Persisted range cache copied at startup. No solver jobs launched. 3 nodes x 10 repeated real analyses; no cached decisions.',samples},null,2));
  });
} catch (error) {
  record('harness startup or fatal error', false, String(error.stack || error));
} finally {
  if (cdp) {
    try { timings.push({ kind:'finalFrontendMetrics', metrics:await appRead('a.metrics||[]') }); } catch { /* Failed navigation. */ }
    await Promise.allSettled([...tasks]);
    cdp.close();
  }
  if (browser) browser.kill();
  if (server) server.kill();
  if(legacyProxy)legacyProxy.close();
  const report = { generatedAt:new Date().toISOString(), browserPath, serverUrl, historyDir, profileDir,
    machine:{cpu:cpus()[0].model,cpuCount:cpus().length,os:release(),node:process.version,browserVersion},
    configuration:{ actualServer:true, gtoEnabled:process.env.FAST_UI_GTO==='1', backgroundSolve:false, historyIsolated:true, decisionsLog:false,
      interaction:'CDP Input mouse/key/IME; read-only Runtime.evaluate; one response-stage network failure', appStateInjected:false },
    summary:{ passed:results.filter((r)=>r.pass).length, failed:results.filter((r)=>!r.pass).length }, results, timings, captures };
  writeFileSync(join(output,'acceptance.json'), JSON.stringify(report,null,2));
  writeFileSync(join(output,'console.json'), JSON.stringify(consoleLog,null,2));
  writeFileSync(join(output,'network.json'), JSON.stringify(network,null,2));
  writeFileSync(join(output,'server.log'), serverLog.join(''));
  console.log(`Report: ${join(output,'acceptance.json')}`);
  process.exitCode = report.summary.failed ? 1 : 0;
}
