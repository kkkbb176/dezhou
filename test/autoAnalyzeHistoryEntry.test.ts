/**
 * REAL-HAND UX ADDENDUM —— **真实 `table.js` 的模式闸门与陈旧排程回归**
 *
 * 覆盖两组同族保证，**全部跑生产脚本**：
 *
 * | 组 | Case | 保证 |
 * |---|---|---|
 * | **模式闸门**（闭合静态审计 F-8） | A–E | 录入历史下不自动分析 / 在途响应不得写 UI / 切回当前决策也不得让旧 epoch 复活 / 开新一手必须撤掉旧排程 |
 * | **陈旧排程**（Stage 6.5 HARDENING） | F–J | 重置、撤销、取消手牌之后旧排程不得基于新状态执行；非就绪状态绝不被自动分析；手动重试语义不变 |
 *
 * ## 这个文件为什么存在（闭合静态审计 F-8）
 *
 * > **F-8 — No test executes the production HISTORY_ENTRY mode gate.**
 *
 * 修复前只有两条路，**都不执行生产代码**：
 *
 * | 路径 | 问题 |
 * |---|---|
 * | `test/autoAnalyze.test.ts` AUTO-10..15 | 跑的是该文件**自建的 `AnalyzeScheduler` 模型**，不是 `table.js` |
 * | `test/interactiveTableRedteam2.test.ts` 的 DOM 桩 | 唯一真跑 `table.js`，但 `setTimeout: () => 0` 是 no-op，**从未进入 `HISTORY_ENTRY`** |
 *
 * 因此「模式闸门」在真实实现里**一次都没有被执行过**。本文件用
 * `test/helpers/tableJsHarness.ts` 真实执行 `src/app/web/table.js`，
 * 并用**真实 UI 点击**（点模式按钮 / 点分析按钮 / 点下一手）驱动它。
 *
 * ## 本文件**不做**的事
 *
 * - 🚫 不重新实现 `AnalyzeScheduler`、不重建模式闸门模型。
 * - 🚫 不复制 `HISTORY_ENTRY` 的业务判断 —— harness 里也没有。
 * - 🚫 不断言模型行为；每一条断言都落在 `table.js` 真实产生的
 *   DOM 文本（用户看到的）、请求计数（真实网络层）、或 timer 状态上。
 *
 * ## 观察口径
 *
 * | 观察点 | 是什么 |
 * |---|---|
 * | `analyzeRequests()` | 真正发往 `/api/analyze` 的请求数（网络层计数） |
 * | `text('debugDecision')` | `app.analysis` 的直接投影；**录入历史下也保留**（建议区被收起，调试面板不收起） |
 * | `text('result')` | 用户看到的建议区 |
 * | `timers.pending` | 真实排程的 debounce timer |
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createTableJsHarness, type TableJsHarness } from './helpers/tableJsHarness.ts';

/* ---------------- 用户可见文案（来自 table.js，不是测试自造） ---------------- */

const MODE_CURRENT = '当前决策';
const MODE_HISTORY = '录入历史';

/** `renderResult()`：当前决策且尚无结果 */
const RESULT_IDLE = '轮到 Hero 时会自动分析。';
/** `renderResult()`：录入历史模式 */
const RESULT_HISTORY = '录入历史中 —— 不显示建议（切回「当前决策」后会自动分析）。';
/** `renderDebug()`：`app.analysis === null` */
const DEBUG_NO_ANALYSIS = '（还没分析）';

/**
 * 起一手「已就绪」的牌局：6 人桌、Hero 在 UTG（翻牌前第一个行动）。
 *
 * 真实 UI 等价序列：新建 6 人桌（Hero UTG）→ 点手牌空位并选两张牌。
 */
async function bootReadyHero(): Promise<TableJsHarness> {
  const h = await createTableJsHarness({ tableSize: 6, heroPosition: 'UTG' });
  h.clickHeroCard('As');
  await h.settle();
  h.clickHeroCard('Kd');
  await h.settle();

  assert.equal(h.preview().decision.ready, true, '前置条件：两张手牌齐 + 轮到 Hero ⇒ 必须就绪');
  assert.equal(h.text('debugDecision'), DEBUG_NO_ANALYSIS, '前置条件：此刻还没有任何决策结果');
  assert.equal(h.analyzeRequests().length, 0, '前置条件：debounce 未到点，不应有请求');
  return h;
}

/* ============================================================
 * Case A —— HISTORY_ENTRY 禁止**手动**分析
 * ============================================================ */

test('Case A：HISTORY_ENTRY 下点真实 [重新分析] —— 不得发出请求、不得更新结果', async () => {
  const h = await bootReadyHero();

  // 1) CURRENT_DECISION → 2) 真实点击切到 HISTORY_ENTRY
  h.clickModeByLabel(MODE_HISTORY);
  await h.settle();

  assert.equal(h.text('result'), RESULT_HISTORY, '切到录入历史必须收起建议区');

  // 3) 点**真实的** analyze 按钮
  const btn = h.node('analyzeBtn');
  assert.equal(btn.disabled, true, '录入历史模式下必须禁用 [重新分析]（第一道：UI）');
  h.clickAnalyzeButton(); // 第二道：即使真的点到了处理函数
  await h.settle();
  h.timers.fireAll();
  await h.settle();

  // 4) 断言
  assert.equal(h.analyzeRequests().length, 0, '不得发送 analyze request');
  assert.equal(h.text('debugDecision'), DEBUG_NO_ANALYSIS, '不得更新决策结果');
  assert.equal(h.text('result'), RESULT_HISTORY, '建议区不得出现新结果');
  assert.deepEqual(h.pageErrors, [], '整段操作不得产生页面错误');
});

/* ============================================================
 * Case B —— HISTORY_ENTRY 禁止**自动**分析（排程后切模式）
 * ============================================================ */

test('Case B：CURRENT_DECISION 已排程 → 切 HISTORY_ENTRY → timer 不得执行', async () => {
  const h = await bootReadyHero();

  // 1) 真实 scheduleAutoAnalyze 已经排了一个 debounce timer
  const pending = h.timers.pending;
  assert.equal(pending.length, 1, `就绪后应当恰好有一个待触发 timer，实际 ${pending.length}`);
  const staleId = pending[0]!.id;
  // 在它被取消**之前**抓住真实回调，用来模拟「即使被取消也仍然到点执行」
  const staleCallback = h.timers.callbackOf(staleId);
  assert.notEqual(staleCallback, undefined, '必须能取到真实排程的回调');

  // 2) 在 timer fire 之前切到 HISTORY_ENTRY
  h.clickModeByLabel(MODE_HISTORY);
  await h.settle();

  // 3) 第一道：切模式必须主动取消在途 debounce timer
  assert.equal(
    h.timers.isPending(staleId),
    false,
    '切到录入历史必须取消在途的 debounce timer',
  );

  // 4) 第二道：让 timer「真的执行」—— 闸门必须独立拦住
  staleCallback!();
  await h.settle();
  h.timers.fireAll();
  await h.settle();

  // 5) 断言
  assert.equal(h.analyzeRequests().length, 0, 'runAnalyze 不得产生有效请求');
  assert.equal(h.text('debugDecision'), DEBUG_NO_ANALYSIS, '不得应用任何结果');
  assert.deepEqual(h.pageErrors, [], '整段操作不得产生页面错误');
});

/* ============================================================
 * Case C —— 已发出的请求在 HISTORY_ENTRY 期间返回
 * ============================================================ */

test('Case C：请求已发出 → 切 HISTORY_ENTRY → 请求返回 ⇒ 不得写 UI', async () => {
  const h = await bootReadyHero();

  // 1) 让 debounce 到点：runAnalyze 真的发出请求，但**挂起不返回**
  const gate = h.deferNextAnalyze();
  h.timers.fireAll();
  await h.settle();

  assert.equal(h.analyzeRequests().length, 1, '前置条件：请求已经真实发出');
  assert.equal(gate.released(), false, '前置条件：请求尚未返回');
  assert.equal(h.text('debugDecision'), DEBUG_NO_ANALYSIS, '前置条件：结果还没到，不得有结果');

  // 2) 用户在请求在途时切到 HISTORY_ENTRY
  h.clickModeByLabel(MODE_HISTORY);
  await h.settle();

  // 3) 旧请求现在才返回
  gate.release();
  await h.settle();
  h.timers.fireAll();
  await h.settle();

  // 4) 断言：旧结果绝不能写进用户可见的决策 UI
  assert.equal(
    h.text('debugDecision'),
    DEBUG_NO_ANALYSIS,
    '迟到的响应不得写入 app.analysis（调试面板在录入历史下仍保留，是直接证据）',
  );
  assert.equal(h.text('result'), RESULT_HISTORY, '建议区必须保持收起');
  assert.deepEqual(h.pageErrors, [], '整段操作不得产生页面错误');
});

/* ============================================================
 * Case D —— 切回 CURRENT_DECISION 也不得让旧 epoch 的响应复活
 * ============================================================ */

test('Case D：请求 A 在 epoch E 发出 → 进 HISTORY_ENTRY → 回 CURRENT_DECISION → A 才返回 ⇒ 仍不得接受', async () => {
  const h = await bootReadyHero();

  // 1) epoch E 下发出请求 A（挂起）
  const gate = h.deferNextAnalyze();
  h.timers.fireAll();
  await h.settle();
  assert.equal(h.analyzeRequests().length, 1, '前置条件：请求 A 已发出');

  // 2) 进入 HISTORY_ENTRY
  h.clickModeByLabel(MODE_HISTORY);
  await h.settle();

  // 3) 再返回 CURRENT_DECISION —— epoch 已经变了
  h.clickModeByLabel(MODE_CURRENT);
  await h.settle();

  // 此时界面上**确实**又是「当前决策」。刻意不触发新的 timer：
  // 本条要证的正是「现在处于当前决策」**不能**成为接受旧响应的理由。
  assert.equal(h.analyzeRequests().length, 1, '前置条件：切回后尚未发出任何新请求');

  // 4) A 现在才返回
  gate.release();
  await h.settle();

  // 5) 断言：旧 response A 仍然不得被接受
  assert.equal(
    h.text('debugDecision'),
    DEBUG_NO_ANALYSIS,
    '旧 epoch 的 response 不得因为「现在重新处于 CURRENT_DECISION」而被接受',
  );
  assert.equal(h.text('result'), RESULT_IDLE, '建议区不得显示旧结果');
  assert.deepEqual(h.pageErrors, [], '整段操作不得产生页面错误');
});

/* ============================================================
 * Case E —— beginFreshHand 之后旧 timer 不得污染新手牌
 * ============================================================ */

test('Case E：旧手牌已排程 → beginFreshHand → 旧 timer 不得污染新手牌', async () => {
  const h = await bootReadyHero();

  // 1) 旧手牌排了自动分析，但 timer 还没 fire
  const pending = h.timers.pending;
  assert.equal(pending.length, 1, `前置条件：旧手牌应有一个待触发 timer，实际 ${pending.length}`);
  const staleId = pending[0]!.id;
  const staleCallback = h.timers.callbackOf(staleId);
  const oldRevision = h.state().revision;
  assert.equal(h.analyzeRequests().length, 0, '前置条件：旧 timer 尚未到点');

  // 2) 真实点击「下一手」 → beginFreshHand()
  h.clickNextHand();
  await h.settle();

  const newRevision = h.state().revision;
  assert.notEqual(newRevision, oldRevision, '前置条件：「下一手」必须真的换了牌局 revision');
  assert.equal(
    h.preview().decision.ready,
    false,
    '前置条件：新手牌还没录手牌 ⇒ 闸门不就绪（否则下游会顺手重排 timer，本条就不再有鉴别力）',
  );

  // 3) 第一道：新牌局开始必须**主动取消**旧 debounce timer（defense-in-depth）
  assert.equal(
    h.timers.isPending(staleId),
    false,
    'beginFreshHand() 必须主动取消旧牌局的 debounce timer —— ' +
      '不能只靠下游 token/epoch/busy 兜底：runAnalyze 并不看 decision.ready',
  );
  assert.equal(h.text('debugDecision'), DEBUG_NO_ANALYSIS, '开新手牌必须清掉旧结果');

  // 4) 第二道：即使旧 timer 仍然执行、并且把剩下的 timer 全部 fire ——
  staleCallback!();
  h.timers.fireAll();
  await h.settle();

  // 5) 断言：不分析旧手牌、也不把旧结果写进新手牌
  const revisions = h.analyzeRequests().map((r) => r.revision);
  assert.equal(
    revisions.includes(oldRevision),
    false,
    `绝不能为**旧手牌** revision 发出分析请求（实际请求：${JSON.stringify(revisions)}）`,
  );
  assert.deepEqual(h.pageErrors, [], '整段操作不得产生页面错误');
});

/* ============================================================
 * Stage 6.5 HARDENING —— 同族异步风险（重置 / 撤销 / 陈旧排程）
 *
 * 共同形态：一个**已经排好、还没到点**的 debounce timer，在牌局被换掉之后
 * 才到点。`runAnalyze` 的引擎闸门只回答「现在**这个**状态就绪吗」，
 * 它回答不了「这次排程当初是为哪个 revision 排的」—— 后者必须由
 * (revision, modeEpoch) 钉住。
 * ============================================================ */

test('Case F：重置本手前已排程 → 重置 → 强行执行捕获的旧 callback ⇒ 不得分析', async () => {
  const h = await bootReadyHero();

  const pending = h.timers.pending;
  assert.equal(pending.length, 1, `前置条件：应当恰好有一个待触发 timer，实际 ${pending.length}`);
  const staleId = pending[0]!.id;
  const staleCallback = h.timers.callbackOf(staleId);
  const oldRevision = h.state().revision;

  // 点真实的 [重置本手]
  h.clickResetHand();
  await h.settle();

  assert.notEqual(h.state().revision, oldRevision, '前置条件：重置必须推进 revision');
  assert.equal(h.preview().decision.ready, false, '前置条件：重置后必须不就绪');

  // 第一道：重置前必须主动撤掉在途排程并清掉 handle
  assert.equal(h.timers.isPending(staleId), false, 'resetHandBtn 必须先清掉在途的 debounce 排程');

  // 第二道：即使旧 callback 仍然执行，也不得放行
  staleCallback!();
  h.timers.fireAll();
  await h.settle();

  assert.equal(h.analyzeRequests().length, 0, '旧 callback 不得产生任何 analyze 请求');
  assert.equal(h.text('debugDecision'), DEBUG_NO_ANALYSIS, '不得写入任何决策结果');
  assert.deepEqual(h.pageErrors, [], '整段操作不得产生页面错误');
});

test('Case G：撤销前已排程 → 撤销（回到未就绪）→ 强行执行旧 callback ⇒ 不得分析', async () => {
  const h = await createTableJsHarness({ tableSize: 6, heroPosition: 'UTG' });
  h.clickHeroCard('As');
  await h.settle();
  assert.equal(h.preview().decision.ready, false, '前置条件：只有一张手牌时不就绪');

  h.clickHeroCard('Kd');
  await h.settle();
  assert.equal(h.preview().decision.ready, true, '前置条件：两张手牌齐 ⇒ 就绪 ⇒ 已排程');

  const pending = h.timers.pending;
  assert.equal(pending.length, 1, `前置条件：应当恰好有一个待触发 timer，实际 ${pending.length}`);
  const staleId = pending[0]!.id;
  const staleCallback = h.timers.callbackOf(staleId);
  const readyRevision = h.state().revision;

  // 点真实的 [撤销]：回到「只有一张手牌」
  h.clickUndo();
  await h.settle();

  assert.notEqual(h.state().revision, readyRevision, '前置条件：撤销必须推进 revision');
  assert.equal(h.preview().decision.ready, false, '前置条件：撤销后只有一张手牌 ⇒ 不就绪');

  assert.equal(h.timers.isPending(staleId), false, 'undoBtn 必须先清掉在途的 debounce 排程');

  staleCallback!();
  h.timers.fireAll();
  await h.settle();

  assert.equal(h.analyzeRequests().length, 0, '旧 callback 不得产生任何 analyze 请求');
  assert.equal(h.text('debugDecision'), DEBUG_NO_ANALYSIS, '不得写入任何决策结果');
  assert.deepEqual(h.pageErrors, [], '整段操作不得产生页面错误');
});

test('Case H：陈旧排程不得对「变过、但仍就绪」的状态执行（revision 必须仍然成立）', async () => {
  const h = await bootReadyHero();

  const pending = h.timers.pending;
  assert.equal(pending.length, 1, `前置条件：应当恰好有一个待触发 timer，实际 ${pending.length}`);
  const staleId = pending[0]!.id;
  const staleCallback = h.timers.callbackOf(staleId);
  assert.notEqual(staleCallback, undefined, '必须能取到真实排程的回调');
  const scheduledRevision = h.state().revision;

  /*
   * 录一个合法动作 → revision 变了、且不再轮到 Hero。
   * 此刻旧排程已经过期，但 `scheduleAutoAnalyze` 因为「不就绪」提前 return，
   * **不会**顺手清掉它 —— 这正是本条要攻击的窗口。
   */
  assert.equal(h.clickCheckOrCall(), true, '前置条件：应当能点到合法动作');
  await h.settle();
  const afterActRevision = h.state().revision;
  assert.notEqual(afterActRevision, scheduledRevision, '前置条件：录动作必须推进 revision');
  assert.equal(h.preview().decision.ready, false, '前置条件：录完动作后不再轮到 Hero');

  // 撤销 → revision 再变一次，而且**重新变成就绪**（危险点就在这里）
  h.clickUndo();
  await h.settle();
  const afterUndoRevision = h.state().revision;
  assert.notEqual(afterUndoRevision, afterActRevision, '前置条件：撤销必须推进 revision');
  assert.equal(h.preview().decision.ready, true, '前置条件：撤销后又回到「就绪」');

  /*
   * 关键断言：现在**确实就绪**，但旧排程是为 `scheduledRevision` 排的。
   * 「就绪」不是充分条件 —— (revision, modeEpoch) 也必须仍然成立，
   * 否则一个陈旧 timer 会拿一个它从未被排程过的牌局去跑分析。
   */
  staleCallback!();
  await h.settle();

  assert.equal(
    h.analyzeRequests().length,
    0,
    '陈旧排程不得基于新的 revision 执行：就绪闸门不是充分条件',
  );
  assert.equal(h.text('debugDecision'), DEBUG_NO_ANALYSIS, '不得写入任何决策结果');
  assert.deepEqual(h.pageErrors, [], '整段操作不得产生页面错误');
});

test('Case I：非 ready 状态不得被 AUTO_ANALYZE 路径分析', async () => {
  const h = await bootReadyHero();

  const pending = h.timers.pending;
  assert.equal(pending.length, 1, `前置条件：应当恰好有一个待触发 timer，实际 ${pending.length}`);
  const staleId = pending[0]!.id;
  const staleCallback = h.timers.callbackOf(staleId);
  const readyRevision = h.state().revision;

  // 点已选中的第 1 张牌 = 取消它 → 手牌只剩一张
  h.clickHeroHandSlot(0);
  await h.settle();

  assert.notEqual(h.state().revision, readyRevision, '前置条件：取消手牌必须推进 revision');
  assert.equal(h.preview().decision.ready, false, '前置条件：只剩一张手牌 ⇒ 不就绪');
  /*
   * ⚠️ 这里**刻意断言旧排程仍然在途**。
   *
   * 「取消手牌」不是本轮登记的撤销点（它只发一条 `SET_HERO_CARD`，
   * 没有 `cancelPendingAnalyze()`），所以旧 timer 会留下来。
   * 这正好让本条变成一个**更硬**的判据：即使排程活着、并且真的执行了，
   * 未就绪状态也绝不能被自动分析路径分析 —— 闸门必须**独立**成立，
   * 而不只是靠「上游把 timer 撤掉了」。
   */
  assert.equal(
    h.timers.isPending(staleId),
    true,
    '前置条件：取消手牌不是撤销点，旧排程仍在途（本条正是要证明闸门独立成立）',
  );

  staleCallback!();
  h.timers.fireAll();
  await h.settle();

  assert.equal(h.analyzeRequests().length, 0, '未就绪状态绝不能被 AUTO_ANALYZE 路径分析');
  assert.equal(h.text('debugDecision'), DEBUG_NO_ANALYSIS, '不得写入任何决策结果');
  assert.deepEqual(h.pageErrors, [], '整段操作不得产生页面错误');
});

test('Case J：合法手动重试不得被破坏 —— 就绪时 [重新分析] 仍然只发一次且结果照常上屏', async () => {
  const h = await bootReadyHero();

  const btn = h.node('analyzeBtn');
  assert.equal(btn.disabled, false, '前置条件：就绪且非录入历史时 [重新分析] 必须可用');
  assert.equal(h.analyzeRequests().length, 0, '前置条件：还没点，不应有任何请求');

  h.clickAnalyzeButton();
  await h.settle();

  assert.equal(h.analyzeRequests().length, 1, '手动重试必须**恰好**发出一次请求');
  assert.match(
    h.text('debugDecision'),
    /CALL/,
    '手动分析的结果必须照常写入 —— 手动重试语义不得被 AUTO 闸门改变',
  );
  assert.match(h.visibleText('result'), /跟注/, '建议必须照常上屏（建议区不得被误收起）');
  assert.deepEqual(h.pageErrors, [], '整段操作不得产生页面错误');
});
