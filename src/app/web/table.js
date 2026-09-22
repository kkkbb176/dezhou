/*
 * 交互式牌桌录入 —— 客户端
 *
 * ============================================================
 * 🔴 本文件里**没有**任何牌局规则
 * ============================================================
 *
 * 它不知道：
 *   - 现在轮到谁（用 preview.currentActorSeatId）
 *   - 谁能做什么（用 preview.actionButtons，那是后端从 Poker Core 推出来的）
 *   - 街道何时推进（用 preview.street）
 *   - 谁已经弃牌（用 seat.status / seat.folded）
 *   - 底池与筹码（用 preview.potBB / preview.remainingStacksBB）
 *   - 视觉位置（用 seat.visualIndex / seat.angleDeg，也是后端算的）
 *
 * 它只做两件事：
 *   1. 把点击翻译成「操作意图」→ POST /api/table
 *   2. 用服务端返回的 state + preview 重新渲染
 *
 * ============================================================
 * 状态源只有一个（规范第 59 / 60 条）
 * ============================================================
 *
 * `app.state` 是**服务端返回的最后一个状态**。DOM 完全由它渲染出来，
 * 不存在「hidden input 里还藏着一份」的第三份状态。
 *
 * ============================================================
 * 竞态与双击（规范第 76 / 77 / 78 条）
 * ============================================================
 *
 * - `app.inflight`：请求在途时**所有**按钮禁用（挡住双击）
 * - `app.revision`：单调递增；**版本不高于已应用版本的响应一律丢弃**
 *   （挡住乱序返回把界面回退）
 * - 服务端还有一道 `RevisionGuard` 水位线（挡住已经在路上的旧请求）
 */

(function () {
  'use strict';

  /* ============================================================
   * 常量
   * ============================================================ */

  var SUITS = [
    { code: 's', glyph: '\u2660', red: false },
    { code: 'h', glyph: '\u2665', red: true },
    { code: 'd', glyph: '\u2666', red: true },
    { code: 'c', glyph: '\u2663', red: false },
  ];
  var RANKS = ['A', 'K', 'Q', 'J', 'T', '9', '8', '7', '6', '5', '4', '3', '2'];

  /* ============================================================
   * 应用状态（**唯一状态源**）
   * ============================================================ */

  var app = {
    state: null, // 服务端返回的 PokerTableState
    preview: null, // 服务端返回的 TablePreview
    meta: null, // 枚举与中文标签
    analysis: null, // 最近一次分析结果
    inflight: 0, // 在途请求数（>0 时禁用全部控件）
    revision: -1, // 已应用的最大版本号
    target: { kind: 'HERO' }, // 牌矩阵的落点：HERO 或 BOARD:slot
    sizeExpanded: null, // 展开尺寸行的动作类型
    pendingLeave: null, // 待用户选择的离桌决策
    /**
     * 「新建牌桌」弹层里**尚未确认**的选择 `{ size, hero }`。
     *
     * 🔴 必须存在这里，**不能**存在 `openNewTableModal()` 的局部变量里：
     * 点桌型 / 座位按钮会 `closeModal()` 再 `openNewTableModal()`，
     * 局部变量每次重进函数都被重置，使用者的选择当场丢失
     *（实测：桌型根本选不动）。见该函数里的详细说明。
     *
     * `null` = 还没打开过（下次打开用「当前牌桌」作为初值）。
     */
    pendingNewTable: null,

    /* ---- AUTO ANALYZE ---- */
    /**
     * 模式。**只有两个取值，默认 `CURRENT_DECISION`**。
     *
     * | 模式 | 中文 | 行为 |
     * |---|---|---|
     * | `CURRENT_DECISION` | 当前决策 | 轮到 Hero 且信息齐备 → **自动分析** |
     * | `HISTORY_ENTRY` | 录入历史 | **永不自动分析** |
     *
     * 🔴 **为什么必须是显式模式，而不是猜**：
     * 「用户正在补录历史」与「用户正常打牌」在**牌局状态上完全一样**
     *（都是：轮到 Hero + 手牌完整 + 牌面够 + 状态合法）。
     * 任何「根据哪个字段变了去猜意图」的做法都会在同一种字段变化上
     * 猜错一半 —— 实测反例：正常打牌时你自己录完前位的弃牌、轮到你了，
     * 「行动历史变了」就会被误判成历史录入。
     *
     * 因此模式由**用户显式选择**，而不是由状态推导。
     */
    mode: 'CURRENT_DECISION',
    /**
     * 模式纪元（invalidation 令牌）。
     *
     * 每次切换模式 +1。用途有两层：
     *
     * 1. **请求失效**：在途的分析请求带的是旧纪元，回来时纪元已变 → 丢弃。
     *    「切到录入历史后，旧异步结果不得重新显示」由它保证。
     * 2. **重新判断**：切回 `CURRENT_DECISION` 时纪元变化会强制重新评估
     *    「现在该不该自动分析」—— 即使牌局 revision 恰好没变。
     *
     * 为什么不用「把 revision 改一下」：revision 是**牌局状态**的版本，
     * 而模式是**界面意图**，两者不是一回事。挪用一个字段去表达另一个概念，
     * 就是本项目一直在清的那类混用。
     */
    modeEpoch: 0,
    /** 自动分析状态（由 `preview.decision.state` 推导 + 本地「正在分析」叠加） */
    autoState: null,
    /** 已经为哪个 (revision, modeEpoch) 自动分析过 —— 保证「一个 revision 最多一次」 */
    autoAnalyzedKey: null,
    /** 在途分析请求的令牌（single-flight） */
    analyzeToken: 0,
    /** 已发出的分析请求里最新的那个令牌（迟到响应比对用） */
    analyzeLatestToken: 0,
    /** debounce 定时器 */
    analyzeTimer: null,
  };

  /** debounce 间隔（毫秒）。一次点击会引发 render + preview + state 三次更新，
   *  必须合并成**一次** Analyze —— 否则一个 revision 会跑三遍决策引擎。 */
  var ANALYZE_DEBOUNCE_MS = 60;

  /* ============================================================
   * DOM 辅助
   * ============================================================ */

  function $(id) {
    return document.getElementById(id);
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function toast(message, danger) {
    var node = $('toast');
    node.textContent = message;
    node.className = 'show' + (danger ? ' danger' : '');
    window.clearTimeout(toast._timer);
    toast._timer = window.setTimeout(function () {
      node.className = '';
    }, 4200);
  }

  function busy() {
    return app.inflight > 0;
  }

  var RED_SUITS = { h: true, d: true };

  function cardLabel(code) {
    if (typeof code !== 'string' || code.length < 2) return { text: '?', red: false };
    var rank = code.slice(0, -1);
    var suit = code.slice(-1);
    var glyph = '\u2660';
    for (var i = 0; i < SUITS.length; i += 1) if (SUITS[i].code === suit) glyph = SUITS[i].glyph;
    return { text: rank + glyph, red: RED_SUITS[suit] === true };
  }

  /* ============================================================
   * 通信
   * ============================================================ */

  function post(url, body) {
    if (busy()) return Promise.resolve(null);
    app.inflight += 1;
    setControlsDisabled(true);
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then(function (res) {
        return res.json();
      })
      .catch(function (error) {
        toast('网络或服务端错误：' + String(error), true);
        return null;
      })
      .then(function (payload) {
        app.inflight -= 1;
        setControlsDisabled(false);
        return payload;
      });
  }

  /**
   * 应用服务端返回的牌桌状态。
   *
   * 🔴 版本保护：**不高于**已应用版本的响应一律丢弃。
   * 乱序返回时，迟到的旧响应不能把界面回退到旧状态。
   *
   * ⚠️ 但 `leaveDecision` **必须先于**版本判断处理（红队命中）：
   * 「本手进行中清空座位」是一个**失败**响应，它带的状态与请求**同版本**，
   * 因此会被版本保护整包丢掉 —— 于是离桌选择对话框永远不会出现，
   * 用户点了「清空座位」之后什么都没发生。
   */
  function applyTableResponse(payload, options) {
    if (!payload) return false;

    // 1) 离桌选择：与版本无关，必须先记下来
    if (payload.leaveDecision) {
      app.pendingLeave = { decision: payload.leaveDecision, seatId: payload.leaveDecision.seatId };
    }

    // 2) 状态：版本保护只作用于它
    var applied = false;
    if (payload.state) {
      var isSameTable = app.state && payload.state.tableId === app.state.tableId;
      if (!isSameTable || payload.state.revision > app.revision || (options && options.force)) {
        app.state = payload.state;
        app.revision = payload.state.revision;
        applied = true;
      }
    }
    if (payload.preview) app.preview = payload.preview;

    render();
    return applied || Boolean(payload.leaveDecision);
  }

  function sendOp(op) {
    if (!app.state) {
      toast('牌桌还没准备好', true);
      return Promise.resolve(false);
    }
    return post('/api/table', { state: app.state, op: op }).then(function (payload) {
      if (!payload) return false;
      if (!payload.ok) {
        var messages = (payload.issues || []).map(function (i) {
          return i.message;
        });
        toast(messages.join('\n') || '操作被拒绝', true);
        // 失败时仍然刷新界面（服务端会回传当前状态与预览）
        applyTableResponse(payload);
        render();
        return false;
      }
      return applyTableResponse(payload);
    });
  }

  /**
   * 关闭弹层 —— **但有待处理的离桌决策时不关**。
   *
   * 🔴 红队命中：座位菜单里的「清空座位」写作 `sendOp(...).then(closeUnlessPending)`，
   * 于是后端刚返回 `leaveDecision`、弹层刚被 `render()` 打开，
   * 这一句就立刻把它关掉并清空 `pendingLeave` —— 用户永远看不到 §8 要求的选择。
   */
  function closeUnlessPending() {
    if (app.pendingLeave) return;
    closeModal();
  }

  function createTable(tableSize, heroPosition) {
    return post('/api/table', {
      tableSize: tableSize || 6,
      heroPosition: heroPosition || 'BTN',
    }).then(function (payload) {
      if (!payload || !payload.ok) {
        toast('无法建立牌桌', true);
        return;
      }
      app.revision = -1;
      // 新牌桌：模式回到默认的「当前决策」（见 `beginFreshHand` 的说明）
      beginFreshHand();
      applyTableResponse(payload, { force: true });
    });
  }

  /* ============================================================
   * AUTO ANALYZE（Hero Decision Ready ⇒ 自动分析）
   * ============================================================ */

  /**
   * **唯一的分析入口**。手动点「重新分析」与自动触发都走这里。
   *
   * ## 四道保护（缺一不可）
   *
   * | 保护 | 挡的是什么 |
   * |---|---|
   * | **debounce** | 一次点击引发 render + preview + state 三次更新 → 合并成一次 |
   * | **single-flight** | 同一个 revision 上并发多次触发 → 只保留最后一个令牌 |
   * | **revision 保护** | 旧响应回来时牌局已经变了 → 丢弃，不用旧结论覆盖新状态 |
   * | **modeEpoch 保护** | 切到「录入历史」后旧响应回来 → 丢弃，不重新显示建议 |
   *
   * ## 为什么 revision 与 epoch **都要**
   *
   * - 只看 revision：切模式时牌局没变 → 旧响应会被当成「当前有效」而显示出来。
   * - 只看 epoch：打了一张牌又撤销（revision 变了）→ 旧响应会覆盖新状态。
   *
   * 两者正交，必须同时成立。
   */
  function runAnalyze(reason, scheduledKey) {
    if (!app.state) return Promise.resolve(null);
    // 录入历史模式：**永不**自动分析。手动点按钮也不发 ——
    // 那会让「补录历史」重新变成一件会弹结果的事。
    if (app.mode === 'HISTORY_ENTRY') return Promise.resolve(null);

    /*
     * ---- 自动路径 fail-closed ----
     *
     * 🔴 **手动重试刻意不套这一层。** 「重新分析」是使用者显式要求的动作，
     * 它的可用性已经由按钮状态决定（`updateActionDisabled` 只在
     * `decision.ready === true` 且非录入历史时启用它）。在 `runAnalyze` 顶层
     * 统一 return 等于顺手改掉一条既有语义，而收益为零 —— 因此本闸门
     * 只约束 `auto`，手动路径的判据与改动前逐字相同。
     *
     * 自动路径要过两道：
     *
     * 1. **闸门必须说「就绪」。** 未就绪（手牌没齐 / 公共牌还在选 /
     *    轮到别人 / 人员不足 / 状态非法 …）时，自动分析一次都不该发。
     * 2. **这次排程必须还没过期。** 排程时钉住的是 (revision, modeEpoch)；
     *    若之后牌局变了（重置 / 撤销 / 开新一手）或模式变了，即使这个 timer
     *    真的到点，也**不得**拿**新状态**去跑一次当初没被批准的分析。
     */
    if (reason === 'auto') {
      var autoGate = app.preview;
      if (!autoGate || !autoGate.decision || autoGate.decision.ready !== true) {
        return Promise.resolve(null);
      }
      if (scheduledKey === undefined) return Promise.resolve(null);
      if (scheduledKey !== keyOf(app.state.revision, app.modeEpoch)) {
        return Promise.resolve(null);
      }
    }

    var requestRevision = app.state.revision;
    var requestEpoch = app.modeEpoch;
    app.analyzeToken += 1;
    var token = app.analyzeToken;
    app.analyzeLatestToken = token;

    app.autoState = 'ANALYZING';
    renderAutoAnalyzeLine();

    return post('/api/analyze', { table: app.state }).then(function (payload) {
      /*
       * ---- 迟到响应保护 ----
       *
       * 三个条件任一不成立就**整包丢弃**，不写 `app.analysis`、不 render：
       * 1. 这是不是**最新**的那次请求（single-flight）
       * 2. 牌局还是不是当初那个 revision
       * 3. 模式还是不是当初那个纪元
       */
      if (token !== app.analyzeLatestToken) return null;
      if (!app.state || app.state.revision !== requestRevision) return null;
      if (app.modeEpoch !== requestEpoch) return null;
      if (app.mode === 'HISTORY_ENTRY') return null;

      app.analysis = payload;
      app.autoAnalyzedKey = keyOf(requestRevision, requestEpoch);
      app.autoState = null; // 交回给 preview 推导
      render();
      return payload;
    });
  }

  function keyOf(revision, epoch) {
    return String(revision) + '@' + String(epoch);
  }

  /**
   * 判断「现在该不该自动分析」，该就 debounce 后跑一次。
   *
   * ## 触发条件**全部**来自后端
   *
   * 这里**不做任何规则判断** —— 只读 `preview.decision.ready`。
   * 那 8 个条件（轮到 Hero / 手牌完整 / 状态合法 / 牌面够 /
   * 有决策点 / 本手未结束 / 人员足 / 模式）里，前 7 个由后端算，
   * 第 8 个（模式）由 `app.mode` 提供。
   *
   * ## 「一个 revision 最多一次」
   *
   * 用 `autoAnalyzedKey` 记住「已经为哪个 (revision, epoch) 分析过」。
   * 于是连续三次 render 不会跑三次决策引擎。
   * **但**：只要 revision 变了（真的打了一张牌 / 改了画像 / 换了环境），
   * key 就变，会重新分析 —— 这正是规范要求的「自动重新分析触发」。
   */
  function scheduleAutoAnalyze() {
    var p = app.preview;
    if (!p || !p.decision) return;

    // 录入历史：不自动分析（状态条会显示「自动分析已暂停」）
    if (app.mode === 'HISTORY_ENTRY') {
      renderAutoAnalyzeLine();
      return;
    }

    if (p.decision.ready !== true) {
      renderAutoAnalyzeLine();
      return;
    }

    var key = keyOf(app.state ? app.state.revision : -1, app.modeEpoch);
    if (app.autoAnalyzedKey === key) {
      renderAutoAnalyzeLine();
      return;
    }

    // debounce：把同一轮里的多次触发合并成一次
    if (app.analyzeTimer !== null) window.clearTimeout(app.analyzeTimer);
    /*
     * `key` 在这里**钉进闭包**：它记住「这次排程是为哪个 (revision, modeEpoch)
     * 排的」。到点时 `runAnalyze('auto', key)` 会再比一次 —— 期间牌局或模式
     * 若变过，这次排程已经过期，不得基于新状态执行（见 `runAnalyze` 的说明）。
     */
    app.analyzeTimer = window.setTimeout(function () {
      app.analyzeTimer = null;
      runAnalyze('auto', key);
    }, ANALYZE_DEBOUNCE_MS);
    renderAutoAnalyzeLine();
  }

  /**
   * 取消在途的 debounce 分析排程（若有），并清掉 handle。
   *
   * 为什么必须是一个**显式动作**，而不是指望下游闸门兜底：
   * 凡是「牌局或模式被换掉」的入口（新建 / 下一手 / 重置本手 / 撤销 /
   * 切模式），都会让一个**已经排好、但还没到点**的 timer 变得没有意义。
   * 让它留着的唯一后果，就是到点后拿新状态跑一次当初没被批准的分析。
   */
  function cancelPendingAnalyze() {
    if (app.analyzeTimer !== null) {
      window.clearTimeout(app.analyzeTimer);
      app.analyzeTimer = null;
    }
  }

  /* ============================================================
   * 渲染
   * ============================================================ */

  function setControlsDisabled(disabled) {
    var nodes = document.querySelectorAll('button, select, input');
    for (var i = 0; i < nodes.length; i += 1) {
      var node = nodes[i];
      if (disabled) {
        node.dataset.prevDisabled = node.disabled ? '1' : '0';
        node.disabled = true;
      } else if (node.dataset.prevDisabled !== undefined) {
        node.disabled = node.dataset.prevDisabled === '1';
        delete node.dataset.prevDisabled;
      }
    }
    if (!disabled) updateActionDisabled();
  }

  /** 行动按钮与「重新分析」的可用性由**预览**决定 */
  function updateActionDisabled() {
    var p = app.preview;
    var analyzeBtn = $('analyzeBtn');
    /*
     * ⚠️ 按钮文案**不再**是「分析当前决策 → 等待轮到你」。
     *
     * 正常流程不需要点它 —— 轮到 Hero 时会自动分析。它只在
     * 「手动重试 / 调试 / 主动刷新」时用，因此固定叫「重新分析」，
     * 只在**真的可分析**且不在录入历史模式时可用。
     */
    var usable = Boolean(p && p.decision && p.decision.ready) && app.mode !== 'HISTORY_ENTRY';
    analyzeBtn.disabled = !usable || busy();
    analyzeBtn.title =
      app.mode === 'HISTORY_ENTRY'
        ? '录入历史模式下不分析。切回「当前决策」即可。'
        : usable
          ? '正常流程不需要点它 —— 轮到 Hero 时会自动分析。这里用于手动重试。'
          : '现在还轮不到 Hero，或信息还没齐。';
  }

  /**
   * 顶部「自动分析」状态条。
   *
   * 🔴 **必须始终可见、必须如实**。规范原文：
   * 「禁止用户猜测『到底有没有开始分析』」。
   *
   * 文案由 `preview.decision.state`（后端算好的）决定，
   * 前端只做一次**穷举映射** —— 不在这里做任何规则判断。
   */
  var AUTO_STATE_ZH = {
    WAITING_CARDS: { text: '等待手牌', cls: 'wait' },
    WAITING_OTHERS: { text: '等待前位行动', cls: 'wait' },
    WAITING_BOARD: { text: '等待公共牌', cls: 'wait' },
    ANALYZING: { text: '正在分析…', cls: 'busy' },
    DONE: { text: '建议已更新', cls: 'ok' },
    INSUFFICIENT: { text: '信息不足', cls: 'warn' },
    ERROR: { text: '状态错误', cls: 'danger' },
  };

  function renderAutoAnalyzeLine() {
    var node = $('autoAnalyzeLine');
    if (!node) return;

    // ---- 录入历史：明确写出「已暂停」，并**不留**旧建议 ----
    if (app.mode === 'HISTORY_ENTRY') {
      node.className = 'autoLine paused';
      node.textContent = '录入历史中 · 自动分析已暂停';
      return;
    }

    var p = app.preview;
    if (!p || !p.decision) {
      node.className = 'autoLine';
      node.textContent = '—';
      return;
    }

    /*
     * 本地「正在分析」优先：`decision.state` 是从**牌局状态**推导的，
     * 它不知道请求已经在路上。若不叠加这一层，界面会在分析期间
     * 显示「建议已更新」或旧状态 —— 那正是「用户猜不到有没有开始分析」。
     */
    var state = app.autoState === 'ANALYZING' ? 'ANALYZING' : p.decision.state;

    // 已经拿到结果：区分「有建议」与「信息不足」
    if (state !== 'ANALYZING' && app.analysis && app.analysis.ok === true) {
      state = app.analysis.decision && app.analysis.decision.action ? 'DONE' : 'INSUFFICIENT';
    }

    var info = AUTO_STATE_ZH[state] || { text: String(state), cls: '' };
    node.className = 'autoLine ' + info.cls;
    node.textContent = '自动分析：开启 · ' + info.text;
  }

  /**
   * 顶部模式切换。
   *
   * 只有两个按钮，**不做复杂模式系统**（规范原文）。默认「当前决策」。
   */
  function renderModeButtons() {
    var box = $('modeButtons');
    if (!box) return;
    clear(box);

    var modes = [
      { value: 'CURRENT_DECISION', labelZh: '当前决策', title: '正常打牌：轮到 Hero 且信息齐备时自动分析' },
      { value: 'HISTORY_ENTRY', labelZh: '录入历史', title: '补录过去已经发生的动作：不自动分析，也不会弹出策略结果' },
    ];
    modes.forEach(function (m) {
      var b = el('button', app.mode === m.value ? 'active' : '', m.labelZh);
      b.title = m.title;
      b.onclick = function () {
        setMode(m.value);
      };
      box.appendChild(b);
    });

    var badge = $('autoAnalyzeBadge');
    if (badge) {
      badge.textContent = app.mode === 'CURRENT_DECISION' ? '自动分析：开启' : '自动分析：已暂停';
      badge.className = 'badge' + (app.mode === 'CURRENT_DECISION' ? '' : ' paused');
    }
  }

  /**
   * 切换模式。
   *
   * ## 三件必须做的事
   *
   * 1. **`modeEpoch += 1`** —— 失效在途请求。
   *    「切到录入历史后旧异步结果回来不得重新显示」由它保证。
   * 2. **切到录入历史时清掉 `app.analysis`** ——
   *    否则一条**过期的建议**会留在「建议」面板里，而使用者正在补录历史，
   *    会把它当成当前局面的建议。规范原文：「不要显示旧的 Decision 结果造成误导」。
   * 3. **切回当前决策时重新评估** —— 靠 `modeEpoch` 变化让
   *    `autoAnalyzedKey` 失配，于是会重新判断「现在该不该自动分析」，
   *    即使牌局 revision 恰好没变。
   */
  function setMode(next) {
    if (next === app.mode) return;
    app.mode = next;
    app.modeEpoch += 1;

    // 在途的自动分析作废
    if (app.analyzeTimer !== null) {
      window.clearTimeout(app.analyzeTimer);
      app.analyzeTimer = null;
    }
    app.analyzeLatestToken += 1; // 让所有在途响应的 token 失配
    app.autoState = null;

    if (next === 'HISTORY_ENTRY') {
      // 收起建议（调试面板保留 —— 它本来就是给调试看的）
      app.analysis = null;
    }

    render();
  }

  function render() {
    if (!app.state || !app.preview) return;
    renderTopbar();
    renderModeButtons();
    renderNotices();
    renderSeats();
    renderCenter();
    renderHand();
    renderPicker();
    renderActorPanel();
    renderTimeline();
    renderDebug();
    updateActionDisabled();
    renderModal();
    /*
     * 自动分析放在**最后**：它可能会 debounce 一个请求，
     * 而请求回来又会 render 一次。放在最后可以确保这一帧的
     * 界面已经完全画好（状态条不会闪一下旧文案）。
     */
    scheduleAutoAnalyze();
  }

  function renderTopbar() {
    var meta = app.meta;
    if (!meta) return;

    var sizeBox = $('tableSizeButtons');
    clear(sizeBox);
    meta.tableSizes.forEach(function (size) {
      var b = el('button', app.state.tableSize === size.value ? 'active' : '', size.labelZh);
      b.title = '切换桌型（会清空多余座位的玩家）';
      b.onclick = function () {
        sendOp({ kind: 'SET_TABLE_SIZE', tableSize: size.value });
      };
      sizeBox.appendChild(b);
    });

    var posBox = $('heroPositionButtons');
    clear(posBox);
    var positions = meta.positions.filter(function (p) {
      return meta.tableSizes
        .filter(function (s) {
          return s.value === app.state.tableSize;
        })[0]
        .positions.indexOf(p.value) >= 0;
    });
    positions.forEach(function (p) {
      var b = el(
        'button',
        app.state.heroPosition === p.value ? 'active' : '',
        p.labelZh + '（' + p.value + '）',
      );
      /*
       * 🔴 **座位对调语义**（2026-09）：目标座位上如果有人，两个人是**交换座位**
       * 而不是「把对方顶掉」。筹码跟着座位走（谁都没有被吞掉筹码）。
       *
       * 提示必须写清楚 —— 否则使用者点完只会看到一条 notice，
       * 而不知道「对面那个人去哪了」（旧实现是把人解绑，盘面上直接消失）。
       */
      b.title =
        '把 Hero 放到 ' + p.value + '（牌桌视图会旋转，Hero 固定在底部）。' +
        '那个座位上如果有人，会与 Hero **对调座位**；筹码留在各自座位上。';
      b.onclick = function () {
        sendOp({ kind: 'SET_HERO_POSITION', position: p.value });
      };
      posBox.appendChild(b);
    });

    var envSelect = $('environmentSelect');
    if (envSelect.options.length === 0) {
      meta.environments.forEach(function (e) {
        var option = el('option', null, e.labelZh);
        option.value = e.value;
        envSelect.appendChild(option);
      });
      envSelect.onchange = function () {
        sendOp({ kind: 'SET_ENVIRONMENT', environment: envSelect.value });
      };
    }
    envSelect.value = app.state.environment;

    $('undoBtn').disabled = app.state.undo.length === 0;

    /*
     * 「一键加入玩家」：标签直接写出**会加几个人**，禁用时写明原因。
     *
     * 判据与后端 `fillEmptySeats` 同源：本手进行中不能加、没有空位无需加。
     * 界面不自己判断「谁算空位」之外的东西 —— 真正的门禁始终在后端。
     */
    var emptySeatCount = (app.preview ? app.preview.seats : []).filter(function (s) {
      return s.playerId === null;
    }).length;
    var fillBtn = $('fillSeatsBtn');
    fillBtn.textContent = emptySeatCount > 0 ? '一键加入玩家（+' + emptySeatCount + '）' : '一键加入玩家';
    fillBtn.disabled = app.state.handActive || emptySeatCount === 0 || busy();
    fillBtn.title = app.state.handActive
      ? '本手进行中：请先点「下一手」或「重置本手」'
      : emptySeatCount === 0
        ? '所有座位都已经有人了'
        : '在全部 ' + emptySeatCount + ' 个空位各加入一名新玩家（默认筹码、画像「未知」），可用「撤销」一次退回';

    $('limits').innerHTML =
      '支持<b>任意数量已进池对手</b>：权益按**全部已进池对手一起**计算，与底池赔率同口径。<br />' +
      '⚠️ 但对手越多、启发式范围的误差叠加越严重，结果只能当参考（界面会写明算了几家）。<br />' +
      '⚠️ <b>还没有任何人进池</b>时（例如翻牌前第一个行动）没有对手范围可算权益，' +
      '此时会如实返回「信息不足」—— 等有人跟注/加注后再分析即可。<br />' +
      '范围是启发式先验（可信度 0.3），<b>不是</b>求解器输出。<br />' +
      '抽水未计入（<code>Rake model: NOT_APPLIED</code>）。<br />' +
      '下注/加注的 EV 不参与比较，翻牌后的加注是<b>定性</b>判断。<br />' +
      '结果<b>尚未</b>用真实牌局校准过；仅供内部个人参考。<br />' +
      '<b>空座位 / 暂离</b>只意味着「本手少几个人」—— 他们不参与本手，' +
      '但**不再**让整张牌桌无法分析（容量 ≠ 本手人数）。';

    /*
     * 本手人数指示（Table Topology Correction §61）。
     *
     * 🔴 必须在界面上把「几个座位」与「本手几个人」分开显示。
     * 这两个数字从前永远相等，因此从来不需要区分；现在不等了，
     * 而使用者判断范围宽紧的第一依据就是本手人数。
     */
    var topo = app.preview.handTopology;
    var sizeBox = $('handSize');
    if (sizeBox) {
      if (topo) {
        var blindText =
          topo.buttonAlsoPostsSmallBlind
            ? '（单挑：Button 本人下小盲）'
            : '';
        sizeBox.innerHTML =
          '<b>' +
          topo.tableCapacity +
          ' 座桌 · 本手 ' +
          topo.handedness +
          ' 人</b>' +
          blindText +
          '　Button：' +
          positionZhOfSeat(topo.buttonSeatId) +
          '，小盲：' +
          positionZhOfSeat(topo.smallBlindSeatId) +
          '，大盲：' +
          positionZhOfSeat(topo.bigBlindSeatId);
        sizeBox.className = 'banner info';
      } else {
        sizeBox.innerHTML = '本手还没开始（先给至少 2 个座位加入玩家）';
        sizeBox.className = 'banner warn';
      }
    }
  }

  /** 由 seatId 取界面上的位置中文（只用后端给的拓扑，前端不推导） */
  function positionZhOfSeat(seatId) {
    var seats = app.preview.seats || [];
    for (var i = 0; i < seats.length; i += 1) {
      if (seats[i].seatId === seatId) {
        return (seats[i].handRoleZh || seats[i].positionZh) + '（' + seats[i].logicalPosition + '）';
      }
    }
    return seatId;
  }

  function renderNotices() {
    var box = $('notices');
    clear(box);
    var notices = (app.preview.warnings || []).filter(function (w) {
      return typeof w === 'string' && w.length > 0;
    });
    notices.slice(0, 4).forEach(function (text) {
      box.appendChild(el('div', 'banner warn', text));
    });
    if (!app.preview.ok && app.preview.issues && app.preview.issues.length > 0) {
      box.appendChild(
        el(
          'div',
          'banner danger',
          app.preview.issues
            .map(function (i) {
              return i.message;
            })
            .join('\n'),
        ),
      );
    }
  }

  /**
   * 座位渲染。
   *
   * ⚠️ 位置完全由后端的 `angleDeg` 决定 —— 前端不把视觉序号换算成
   * 逻辑位置，也**不**用视觉位置推断任何规则。
   */
  function renderSeats() {
    var box = $('seats');
    clear(box);

    app.preview.seats.forEach(function (seat) {
      var classes = ['seat'];
      if (seat.isHero) classes.push('hero');
      if (seat.isCurrentActor) classes.push('actor');
      if (!seat.playerId) classes.push('empty');
      if (seat.folded) classes.push('folded');
      if (seat.status === 'LEAVING_AFTER_HAND') classes.push('leaving');
      if (seat.status === 'SITTING_OUT') classes.push('sittingOut');
      /*
       * 不参与本手的座位画淡。
       *
       * 🔴 这是「容量 ≠ 本手人数」在界面上的可见后果：9 座桌 8 人时，
       * 使用者必须一眼看出「这张桌子有 9 个座位，但这一手只发 8 份牌」。
       * 从前两者永远相等，所以从来不需要这种区分 —— 现在需要了。
       */
      if (!seat.isParticipant) classes.push('notInHand');

      var node = el('div', classes.join(' '));
      /*
       * 🔴 **PLAYER PROFILE TABLE UI V1：把稳定身份暴露到 DOM**。
       *
       * 供浏览器验收（`scripts/browser-e2e-player-picker.ts`）断言「这个座位上
       * 到底绑的是哪一位玩家」—— 只看显示名会被同名玩家骗过。
       */
      node.setAttribute('data-player-id', seat.playerId || '');
      node.setAttribute('data-seat-id', seat.seatId);
      /*
       * 椭圆布局：`angleDeg` 的约定是 **0° = 6 点钟（正下方）**，
       * 沿行动方向（屏幕上逆时针：下 → 左 → 上 → 右）增大。
       *
       * 🔴 红队命中：修复前用 `(angleDeg - 90)`，于是 Hero 被画在**正上方**
       * （50%, 8%）—— 整张桌子相对约定旋转了 180°，还顺带把方向镜像了。
       * 现在用 `(angleDeg + 90)`：0° → 90° → sin=1 → y 最大 → 正下方。
       */
      var rad = ((seat.angleDeg + 90) * Math.PI) / 180;
      var x = 50 + 40 * Math.cos(rad);
      var y = 48 + 40 * Math.sin(rad);
      node.style.left = x + '%';
      node.style.top = y + '%';

      if (seat.isDealer) node.appendChild(el('div', 'dealer', 'D'));

      /*
       * 🔴 座位上的位置标签显示**本手角色**，不是物理座位名。
       *
       * Table Topology Correction：空座位会让两者分开 —— 9 座桌 8 人时
       * 某些座位的角色与它「满桌时」的名字不同。修复前两者被当成一回事，
       * 界面于是在一个本该是 UTG 的座位上写「关煞位」。
       *
       * 不参与本手的座位（空 / 暂离 / 0 筹码）没有角色，标成「本手不参与」——
       * 否则使用者会以为它也在这一手里。
       */
      var roleText = seat.handRoleZh
        ? seat.handRoleZh + '（' + seat.handRole + '）'
        : seat.positionZh + '（' + seat.logicalPosition + '）· 本手不参与';

      if (!seat.playerId) {
        node.appendChild(el('div', 'name', '+ 加入玩家'));
        node.appendChild(el('div', 'pos', roleText));
      } else {
        node.appendChild(el('div', 'name', seat.displayName || seat.playerId));
        node.appendChild(el('div', 'pos', roleText));
        var stackText =
          seat.remainingStackBB === null
            ? seat.stackBB + 'BB'
            : seat.remainingStackBB + 'BB' +
              (seat.committedBB ? '（本街已投 ' + seat.committedBB + 'BB）' : '');
        node.appendChild(el('div', 'stack', stackText));
        var tags = [];
        if (seat.quickProfileZh && seat.quickProfileZh !== '未知') tags.push(seat.quickProfileZh);
        if (seat.dynamicHintZh && seat.dynamicHintZh !== '未知') tags.push('动态:' + seat.dynamicHintZh);
        if (tags.length > 0) node.appendChild(el('div', 'tags', tags.join(' · ')));
        node.appendChild(el('div', 'status', seat.isHero ? 'Hero · ' + seat.statusZh : seat.statusZh));

        if (seat.isHero && app.state.heroCards.length > 0) {
          var row = el('div', 'heroCards');
          app.state.heroCards.forEach(function (code) {
            var info = cardLabel(code);
            row.appendChild(el('span', 'card small' + (info.red ? ' red' : ''), info.text));
          });
          node.appendChild(row);
        }
      }

      node.onclick = function () {
        hideSeatTip();
        openSeatMenu(seat);
      };
      /* 悬停显示真实画像（PLAYER PROFILE TABLE UI V1 §三） */
      node.onmouseenter = function (ev) {
        showSeatTip(seat, ev);
      };
      node.onmousemove = function (ev) {
        var tip = $('seatTip');
        if (tip && tip.className === 'show') positionTip(tip, ev);
      };
      node.onmouseleave = hideSeatTip;
      box.appendChild(node);
    });
  }

  function renderCenter() {
    var p = app.preview;
    $('potLine').textContent =
      '底池 ' + p.potBB + 'BB' + (p.currentBetBB > 0 ? '　当前注 ' + p.currentBetBB + 'BB' : '');
    var street = p.streetZh;
    if (p.boardSelectionInProgress) street += '（公共牌选择中…）';
    if (p.handComplete) street += '（本手结束）';
    $('streetLine').textContent = street;

    var row = $('boardRow');
    clear(row);
    for (var slot = 0; slot < 5; slot += 1) {
      var code = app.state.board[slot];
      var isTarget = app.target.kind === 'BOARD' && app.target.slot === slot;
      var node = el('div', 'slot' + (code ? ' filled' : '') + (isTarget ? ' target' : ''));
      if (code) {
        var info = cardLabel(code);
        node.textContent = info.text;
        if (info.red) node.style.color = '#b3271e';
        node.title = '点击清空这一张';
        node.onclick = function (index) {
          return function () {
            var existing = app.state.board[index];
            if (existing) {
              sendOp({ kind: 'SET_BOARD_CARD', card: existing, slot: index }).then(function () {
                var next = Math.min(index, app.state.board.length);
                app.target = { kind: 'BOARD', slot: next };
                render();
              });
            } else {
              app.target = { kind: 'BOARD', slot: Math.min(index, app.state.board.length) };
              render();
            }
          };
        }(slot);
      } else {
        node.textContent = '+';
        node.title = '点击后从下方牌面选牌';
        node.onclick = function (index) {
          return function () {
            /*
             * ⚠️ 公共牌必须**按顺序**填：后端会拒绝「跳着填」。
             * 这里把落点夹到「下一张可填的槽位」，于是使用者点哪个空槽
             * 都只会落到同一个正确位置 —— 不会出现「点了没反应」。
             */
            var next = Math.min(index, app.state.board.length);
            app.target = { kind: 'BOARD', slot: next };
            render();
          };
        }(slot);
      }
      row.appendChild(node);
    }
  }

  function renderHand() {
    var row = $('heroHandRow');
    clear(row);
    for (var i = 0; i < 2; i += 1) {
      var code = app.state.heroCards[i];
      if (code) {
        var info = cardLabel(code);
        var node = el('div', 'card' + (info.red ? ' red' : ''), info.text);
        node.title = '点击取消这张';
        node.style.cursor = 'pointer';
        node.onclick = function (card) {
          return function () {
            sendOp({ kind: 'SET_HERO_CARD', card: card });
          };
        }(code);
        row.appendChild(node);
      } else {
        var isTarget = app.target.kind === 'HERO';
        var empty = el('div', 'card empty' + (isTarget ? ' target' : ''), '＋');
        empty.style.cursor = 'pointer';
        empty.onclick = function () {
          app.target = { kind: 'HERO' };
          render();
        };
        row.appendChild(empty);
      }
    }
    $('handHint').textContent =
      app.state.heroCards.length === 2
        ? '手牌已选好。点已选的牌可以取消。'
        : '点下方牌面选牌（已选的 ' + app.state.heroCards.length + ' / 2 张）';
  }

  function usedCards() {
    var used = {};
    app.state.heroCards.forEach(function (c) {
      used[c] = true;
    });
    app.state.board.forEach(function (c) {
      if (c) used[c] = true;
    });
    return used;
  }

  function renderPicker() {
    var grid = $('pickerGrid');
    var used = usedCards();
    $('pickerTarget').textContent =
      app.target.kind === 'HERO'
        ? '落点：我的手牌'
        : '落点：公共牌第 ' + (app.target.slot + 1) + ' 张';

    if (grid.dataset.built === '1') {
      // 只更新禁用状态（避免每次渲染重建 52 个按钮）
      var buttons = grid.querySelectorAll('button.pick');
      for (var i = 0; i < buttons.length; i += 1) {
        var code = buttons[i].dataset.card;
        buttons[i].disabled = used[code] === true;
      }
      return;
    }

    var table = el('table');
    SUITS.forEach(function (suit) {
      var tr = el('tr');
      tr.appendChild(el('td', 'suit' + (suit.red ? ' red' : ''), suit.glyph));
      RANKS.forEach(function (rank) {
        var code = rank + suit.code;
        var td = el('td');
        var btn = el('button', 'pick' + (suit.red ? ' red' : ''), rank);
        btn.dataset.card = code;
        btn.disabled = used[code] === true;
        btn.title = code;
        btn.onclick = function () {
          pickCard(code);
        };
        td.appendChild(btn);
        tr.appendChild(td);
      });
      table.appendChild(tr);
    });
    clear(grid);
    grid.appendChild(table);
    grid.dataset.built = '1';
  }

  function pickCard(code) {
    if (app.target.kind === 'HERO') {
      sendOp({ kind: 'SET_HERO_CARD', card: code }).then(function (ok) {
        if (!ok) return;
        autoAdvanceTarget();
      });
      return;
    }
    var slot = app.target.slot;
    sendOp({ kind: 'SET_BOARD_CARD', card: code, slot: slot }).then(function (ok) {
      if (!ok) return;
      autoAdvanceTarget();
    });
  }

  /** 选完一张后自动把落点移到下一个空位（把点击数降到最低） */
  function autoAdvanceTarget() {
    if (!app.state) return;
    if (app.target.kind === 'HERO') {
      if (app.state.heroCards.length >= 2) {
        app.target = { kind: 'BOARD', slot: app.state.board.length };
        if (app.target.slot > 4) app.target = { kind: 'HERO' };
      }
    } else {
      var next = app.state.board.length;
      app.target = next <= 4 ? { kind: 'BOARD', slot: next } : { kind: 'HERO' };
    }
    render();
  }

  function renderActorPanel() {
    var p = app.preview;
    var line = $('actorLine');
    var stats = $('statGrid');
    clear(stats);

    if (p.currentActorPosition === null) {
      line.textContent = p.handComplete ? '本手已结束' : '本街下注轮已结束';
      line.className = '';
    } else if (p.isHeroTurn) {
      line.textContent = '现在轮到你（' + p.currentActorNameZh + '）';
      line.className = 'hero';
    } else {
      line.textContent = p.currentActorNameZh + ' 当前行动';
      line.className = '';
    }

    function stat(key, value) {
      stats.appendChild(el('div', 'k', key));
      stats.appendChild(el('div', null, value));
    }
    stat('当前底池', p.potBB + 'BB');
    stat('需要跟注', p.callAmountBB + 'BB');
    stat('当前注额', p.currentBetBB + 'BB');
    if (p.minRaiseToBB !== null) stat('最小加注到', p.minRaiseToBB + 'BB');
    if (p.effectiveStackBB !== null) stat('有效筹码', p.effectiveStackBB + 'BB');
    var heroSeat = p.seats.filter(function (s) {
      return s.isHero;
    })[0];
    if (heroSeat) stat('我的剩余筹码', (heroSeat.remainingStackBB ?? heroSeat.stackBB) + 'BB');

    // ---- 行动按钮（**只来自后端**）----
    var box = $('actionButtons');
    var sizeBox = $('sizeButtons');
    clear(box);
    clear(sizeBox);

    /*
     * 🔴 按钮分三组（与后端 `TableActionButton.group` 一一对应）：
     *   PRIMARY = 直接可执行的合法动作
     *   EXPAND  = **不是动作**，点了只展开尺寸行（下注 / 加注）
     *   SIZE    = 展开后的具体尺寸，全部是合法动作
     *
     * 红队 F-02 命中：后端把下注/加注的展开按钮改成 `EXPAND` 之后，
     * 前端仍只认 `PRIMARY` —— 于是「下注 / 加注」连同全部合法尺寸
     * 从界面上消失，用户只剩弃牌 / 过牌 / 全下。
     * 屏幕不提供后端已判定的合法动作，与契约正好相反。
     */
    var primary = p.actionButtons.filter(function (b) {
      return b.group === 'PRIMARY' || b.group === 'EXPAND';
    });
    var sizes = p.actionButtons.filter(function (b) {
      return b.group === 'SIZE';
    });

    primary.forEach(function (button) {
      var b = el('button', button.isAllIn ? 'danger' : '', button.labelZh);
      if (button.group === 'EXPAND') {
        // 尺寸展开：先点动作，再点具体尺寸（规范第 31 / 32 条）
        b.onclick = function () {
          app.sizeExpanded = app.sizeExpanded === button.type ? null : button.type;
          render();
        };
        if (app.sizeExpanded === button.type) b.className = 'active';
      } else {
        b.onclick = function () {
          app.sizeExpanded = null;
          sendOp({
            kind: 'ACT',
            action: {
              type: button.type,
              ...(button.amountChips !== undefined ? { amountChips: button.amountChips } : {}),
            },
          });
        };
      }
      box.appendChild(b);
    });

    if (app.sizeExpanded !== null) {
      var relevant = sizes.filter(function (b) {
        return b.type === app.sizeExpanded;
      });
      relevant.forEach(function (button) {
        var b = el('button', button.isAllIn ? 'danger' : '', button.labelZh);
        b.onclick = function () {
          app.sizeExpanded = null;
          sendOp({
            kind: 'ACT',
            action: {
              type: button.type,
              ...(button.amountChips !== undefined ? { amountChips: button.amountChips } : {}),
            },
          });
        };
        sizeBox.appendChild(b);
      });
      if (relevant.length === 0) sizeBox.appendChild(el('span', 'hint', '（没有合法尺寸可选）'));
    } else if (sizes.length > 0) {
      sizeBox.appendChild(
        el('span', 'hint', '点「' + (sizes[0].type === 'BET' ? '下注' : '加注') + '」展开合法尺寸'),
      );
    }

    var blockers = $('blockers');
    clear(blockers);
    if (p.analyzeBlockers.length > 0) {
      p.analyzeBlockers.forEach(function (text) {
        blockers.appendChild(el('div', 'warn', '· ' + text));
      });
    }

    renderResult();
  }

  function renderResult() {
    var box = $('result');
    clear(box);

    /*
     * 🔴 **录入历史模式：收起建议。**
     *
     * 规范原文：「切到 HISTORY_ENTRY 时：清除/隐藏当前建议区的 active
     * recommendation」「不要显示旧的 Decision 结果造成误导」。
     *
     * 为什么这条不能省：使用者正在补录过去的动作，而面板里留着一条
     * **针对另一个局面**的建议。他会把它当成当前局面的建议 ——
     * 那比没有建议更危险。
     *
     * ⚠️ 调试面板（`renderDebug`）**保留** —— 它明确标着「调试」，
     * 是给排查问题看的，不承担「当前建议」的语义。
     */
    if (app.mode === 'HISTORY_ENTRY') {
      box.className = 'hint paused';
      box.textContent = '录入历史中 —— 不显示建议（切回「当前决策」后会自动分析）。';
      return;
    }

    var a = app.analysis;
    if (!a) {
      box.className = 'hint';
      box.textContent = '轮到 Hero 时会自动分析。';
      return;
    }
    box.className = '';
    if (!a.ok) {
      box.appendChild(el('div', 'blocked', '未给出建议：' + (a.stage || '') ));
      (a.issues || []).forEach(function (issue) {
        box.appendChild(el('div', 'blocked', '· ' + issue.message));
      });
      return;
    }

    /*
     * ⚠️ 这里以前留了一行调试残骸：
     *   box.appendChild(el('div', null, a.viewModel.actionZh).id ? box : box);
     * 三元两边都是 `box`，于是实际执行 `box.appendChild(box)` ——
     * 真实 DOM 会抛 HierarchyRequestError（新子节点包含父节点）。
     *
     * 后果远不止「建议不显示」：抛错点在 `renderActorPanel()` 里，
     * 于是**同一次 render 的后半段全部被跳过** —— 时间线、调试面板、
     * 弹层都不再更新；而 `app.analysis` 一旦被设置就不会自动清空，
     * 此后每一次 render 都在同一行抛错，界面进入「半冻结」：
     * 连「离桌选择」弹层都打不开。
     *
     * 下面几行已经在构造 `action` 并 append，删掉即可。
     */
    var action = el('div', null, a.viewModel.actionZh);
    action.id = 'resultAction';
    box.appendChild(action);

    var meta = [a.viewModel.confidenceZh, a.viewModel.classificationZh];
    if (a.viewModel.sizeZh) meta.unshift(a.viewModel.sizeZh);
    var metaLine = el('div', null, meta.join(' · '));
    metaLine.id = 'resultMeta';
    box.appendChild(metaLine);

    var list = el('ul');
    list.id = 'resultReasons';
    (a.viewModel.reasonsZh || []).forEach(function (text) {
      list.appendChild(el('li', null, text));
    });
    box.appendChild(list);

    (a.viewModel.warningsZh || []).forEach(function (text) {
      box.appendChild(el('div', 'warn', text));
    });

    /*
     * 🔴 **这条建议用了什么范围** —— 必须与建议同屏。
     *
     * 为什么不能只靠底部固定的「说明」区：那里说的是「本项目**一般**用
     * 启发式范围」，是一句**免责声明**；使用者真正需要知道的是
     * 「**这一条**建议基于什么范围、可不可信」，那是**证据**。
     * 两者不是同一句话，放在两个地方就等于让使用者自己把两句话拼起来。
     *
     * 数据来自后端回传的 `rangeProvenance` —— 它是**这一次决策真正拿去算
     * 权益的那些范围**（不是重新构建一份，也不是只取首要对手）。
     */
    var prov = a.rangeProvenance || [];
    if (prov.length > 0) {
      var provBox = el('div', 'warn');
      /*
       * 🔴 判据用后端给的 `fromSolver`（**结构化**），不是文案匹配。
       *
       * 踩过的坑：曾经用 `/求解器输出/` 去匹配描述，而启发式的描述里写着
       * 「自建启发式先验 —— **非**求解器输出」—— **命中了**，
       * 于是把猜的范围判成了算的。
       * 后端现在直接给布尔值，界面不再做字符串判断。
       */
      var allFromSolver = prov.every(function (r) {
        return r.fromSolver === true;
      });
      var solverCount = prov.filter(function (r) {
        return r.fromSolver === true;
      }).length;
      provBox.appendChild(
        el(
          'div',
          null,
          '这条建议用到的对手范围（' + prov.length + ' 家，其中 ' + solverCount + ' 家来自求解器）' +
            (allFromSolver ? '' : '　⚠️ 其余是启发式先验（非求解器输出）'),
        ),
      );
      prov.forEach(function (r) {
        /*
         * 🔴 **两个「组合数」必须分开显示**（2026-09-22 修复）。
         *
         * 修复前这一行是 `'｜ 有效组合 ' + r.supportSize`，实测会渲染成
         * 「有效组合 1225」—— 而 1225 = C(50,2) 是**全部**合法组合
         * （求解器在 169 类上都留了一点频率），**不携带任何范围宽窄信息**；
         * 真实等效宽度是 `effectiveComboCount`（同一局面实测 **94.1**，
         * 只有 1225 的 7.7%）。
         *
         * 只显示前者会让使用者把对手范围读宽约 13 倍。
         */
        var widthText =
          '｜ 正权重组合 ' +
          r.supportSize +
          (r.effectiveComboCount === undefined || r.effectiveComboCount === null
            ? ''
            : '（等效宽度 ' + Number(r.effectiveComboCount).toFixed(1) + '，即 1/Σp²）');
        var line =
          el(
            'div',
            null,
            '· ' +
              r.positionZh +
              '：' +
              (r.fromSolver === true ? '【求解器】' : '【启发式】') +
              r.sourceZh +
              ' ｜ 可信度 ' +
              Number(r.confidence).toFixed(2) +
              widthText,
          );
        provBox.appendChild(line);

        /*
         * 🔴 **这一家为什么不是 GTO** —— 必须逐家说清楚（Phase 1.3）。
         *
         * 修复前这里只有「【启发式】」三个字，而它背后有三种完全不同的原因：
         *
         * | 原因 | 使用者该做什么 |
         * |---|---|
         * | GTO 正在后台计算 | 等一会儿重看（**会自动变成 GTO**） |
         * | 计算失败 | 去看求解器（**不会自己好**） |
         * | 这局面结构上算不了 | 接受启发式（**等也没用**） |
         *
         * 把这三件事混成一个标签，使用者就无从决定下一步 ——
         * 而那正是本轮要修的原始缺陷。
         */
        if (r.fromSolver !== true && r.gtoReasonZh) {
          provBox.appendChild(el('div', 'gtoReason', '　　↳ ' + r.gtoReasonZh));
        }
        if (r.gtoPending === true) {
          line.className = 'gtoPendingLine';
        }
      });
      box.appendChild(provBox);

      /*
       * 🔴 **这次 GTO 到底怎么回事** —— 与建议同屏的**唯一**必显说明。
       *
       * 渲染规则刻意简单：**只有「全部对手都用了已缓存的 GTO 策略」时不显示**，
       * 其余状态一律显示。理由：
       *
       * - 显示少了 → 使用者不知道「为什么不是 GTO」，也不知道该等、该修、还是该死心
       * - 显示多了 → 只是多一行字，代价远小于前者的代价
       *
       * 三句关键措辞都由后端给（`gtoStatus.messageZh`），界面**不再自己拼** ——
       * 界面拼措辞就会与后端的判定分歧，而那种分歧在界面上看不出来。
       */
      var gto = a.gtoStatus;
      if (gto && gto.state === 'SOLVE_FAILED') {
        box.appendChild(el('div', 'warn', '⚠️ ' + gto.messageZh));
      } else if (gto && gto.state !== 'SOLVER_RANGE' && gto.messageZh) {
        var cls =
          gto.state === 'BACKGROUND_SOLVING' || gto.state === 'MIXED' ? 'gtoPending' : 'gtoReason';
        var prefix = cls === 'gtoPending' ? '⏳ ' : 'ℹ️ ';
        box.appendChild(el('div', cls, prefix + gto.messageZh));
      }

      /*
       * ============================================================
       * 🔴 牌桌动态适应 V1 —— 可展开的桌况摘要
       * ============================================================
       *
       * ## 三条展示纪律（授权 §七）
       *
       * 1. **一句话摘要 + 可展开**：不新增占位的大型仪表盘。
       * 2. **样本不足显示「观察中」**：绝不显示编造的频率或提升幅度。
       * 3. **实验结果不能看起来像正式建议**：因此整块带 `tableDynamics`
       *    前缀，且**正式建议仍在上面**（本块只读 `a.tableDynamics`，
       *    永远不覆盖 `a.decision`）。
       *
       * 数据全部来自后端回传的 `a.tableDynamics`；界面**不做任何计算**，
       * 也不自己拼结论 —— 拼措辞就会与后端判定分歧，而那种分歧看不出来。
       */
      renderTableDynamics(box, a.tableDynamics);

      /*
       * 具体理由（逐条）。对 `NO_SCENARIO` 这类**没有 outcome 可挂**的状态，
       * 笼统的那句话回答不了「到底是哪一家、为什么」——
       * 具体理由只在 `reasons` 里，因此必须显示它。
       *
       * ⚠️ 已在上面逐家渲染过的理由不重复显示（用 `gtoReasonZh` 判重）。
       */
      if (gto && Array.isArray(gto.reasons)) {
        var shown = {};
        prov.forEach(function (r) {
          if (r.gtoReasonZh) shown[r.gtoReasonZh] = true;
        });
        gto.reasons.forEach(function (reason) {
          if (typeof reason !== 'string' || shown[reason] === true) return;
          if (reason === gto.messageZh) return;
          box.appendChild(el('div', 'gtoReason', '　· ' + reason));
        });
      }
    }

    /*
     * 🔴 **底池是怎么分的**（2026-09 边池轮）。
     *
     * ## 为什么必须显示
     *
     * 短筹码全下时他**赢不到全部底池** —— 这话只听一遍很难相信，
     * 而看不到它就会高估自己的处境：以为「底池 1550，我 30% 权益
     * 就该跟」，实际他能争的只有主池。
     *
     * ## 为什么只在真有分层时才显示
     *
     * 两边筹码相等时显示「主池 / 边池 / 退回」纯属噪音 ——
     * 那种局面下三者退化成「全部都是主池」。
     * 因此由后端给 `hasLayering` 开关，界面不做判断
     *（界面自己判断就会与后端口径分歧）。
     *
     * ⚠️ 只呈现**钱怎么分**，绝不呈现「谁会赢」——
     * 本项目不派彩，也不做摊牌比牌。
     */
    var lp = a.meta ? a.meta.layeredPot : null;
    if (lp && (lp.hasLayering === true || lp.hasPendingUnmatched === true)) {
      var lpBox = el('div', 'warn');
      lpBox.appendChild(
        el(
          'div',
          null,
          '底池分层（总投入 ' +
            lp.total +
            '，其中可争夺 ' +
            lp.contested +
            '）',
        ),
      );
      /*
       * 🔴 **按事件 id 去重后再渲染**（RIVER CONSISTENCY V2 §18）。
       *
       * 使用者实测：同一句「无人跟注，退回 X」在界面上出现**两次** ——
       * 一次来自这里，一次来自下面的 `returnedTotal` 分支（两处独立拼接）。
       * 现在服务端给出带稳定 id 的事件列表，渲染层只按 id 去重渲染一遍，
       * 并且**不再**另拼一条退回文案。
       */
      var seen = {};
      var events = lp.events || [];
      for (var i = 0; i < events.length; i += 1) {
        var ev = events[i];
        if (ev && ev.id) {
          if (seen[ev.id]) continue;
          seen[ev.id] = true;
        }
        if (ev && ev.kind === 'PENDING_UNMATCHED') {
          /*
           * ⚠️ 「尚未匹配」**不是**退回：下注轮还没结束，这笔钱会被跟注。
           * 修复前它与退回共用一行文案，于是在 Hero 还没决定跟不跟的时候
           * 界面就宣布「无人跟注，退回 2200」—— 提前结算。
           */
          lpBox.appendChild(el('div', 'gtoReason', '　· ' + ev.textZh));
          continue;
        }
        lpBox.appendChild(el('div', 'gtoReason', '　· ' + (ev ? ev.textZh : '')));
      }
      box.appendChild(lpBox);
    }
  }

  /**
   * 牌桌动态适应 V1 —— 可展开的桌况摘要（授权 §七）
   *
   * ## 为什么是「一行摘要 + 折叠」而不是仪表盘
   *
   * 牌桌页面的核心价值是「轮到我时 1 秒看懂该做什么」。一块常驻的
   * 统计数据会把建议挤下去 —— 因此默认只显示一句话，细节靠展开。
   *
   * ## 为什么样式刻意低调（`gtoReason` 而非高亮）
   *
   * 影子结果是**实验**，不是建议。用与「补充说明」同一档的样式，
   * 使用者一眼就能分清「上面那条是要我做的，下面这段是系统在观察」。
   *
   * ## 不编造数字
   *
   * 逐维度一律显示 `成功/机会`（分母必须可见）；机会数为 0 显示「观察中」；
   * 后端没给的字段（例如 `comparison`）就不渲染，绝不用 0 顶替。
   */
  function renderTableDynamics(box, td) {
    if (!td) return;
    if (td.status === 'NOT_APPLICABLE') return; // 表单路径：不占地方

    var details = el('details', 'tdPanel');
    details.id = 'tableDynamicsPanel';

    var summary = el('summary', 'tdSummary');
    summary.textContent =
      '桌况（实验·' + (td.mode === 'SHADOW' ? '影子模式' : String(td.mode)) + '）：' + td.summaryZh;
    details.appendChild(summary);

    /* ---- ① 模式与可信度（先讲清楚「这不是建议」） ---- */
    details.appendChild(
      el(
        'div',
        'tdNote',
        '以下内容是**实验对比**，不会改变上面的建议。' +
          '模式：' +
          (td.modeZh || td.mode) +
          '｜可信度：' +
          td.confidenceZh +
          '｜已观察 ' +
          td.handsObserved +
          ' 手（' +
          td.recordsUsed +
          ' 条记录）',
      ),
    );

    /* ---- ② 逐维度证据（机会数必须可见） ---- */
    var dims = td.dimensions || [];
    var withData = dims.filter(function (d) {
      return d.opportunities > 0;
    });
    if (withData.length === 0) {
      details.appendChild(el('div', 'tdObserving', '观察中：还没有足够的有效机会。'));
    } else {
      var list = el('div', 'tdDims');
      list.appendChild(el('div', 'tdHead', '统计依据（成功次数 / 有效机会）：'));
      withData.forEach(function (d) {
        var dirZh =
          d.direction === 'HIGHER' ? '偏高' : d.direction === 'LOWER' ? '偏低' : '正常';
        list.appendChild(
          el(
            'div',
            'tdDim',
            '· ' +
              d.labelZh +
              '：' +
              d.rateZh +
              '　' +
              dirZh +
              '　可信度 ' +
              (Number(d.confidence) * 100).toFixed(0) +
              '%',
          ),
        );
      });
      var empty = dims.filter(function (d) {
        return d.opportunities === 0;
      });
      if (empty.length > 0) {
        list.appendChild(
          el(
            'div',
            'tdObserving',
            '· 暂无有效机会（观察中）：' +
              empty
                .map(function (d) {
                  return d.labelZh;
                })
                .join('、'),
          ),
        );
      }
      details.appendChild(list);
    }

    /* ---- ③ 当前相关玩家 ---- */
    var players = td.relevantPlayers || [];
    if (players.length > 0) {
      var pBox = el('div', 'tdPlayers');
      pBox.appendChild(el('div', 'tdHead', '当前相关玩家（这次要调整的座位）：'));
      players.forEach(function (p) {
        pBox.appendChild(
          el(
            'div',
            'tdDim',
            '· ' +
              p.positionZh +
              '：' +
              p.quickProfile +
              '　依据' +
              (p.source === 'INDIVIDUAL' ? '个体证据' : '整桌（个体不足）') +
              '　可信度 ' +
              (Number(p.confidence) * 100).toFixed(0) +
              '%',
          ),
        );
      });
      details.appendChild(pBox);
    }

    /* ---- ④ 五类调整方向 ---- */
    var adjs = td.adjustments || [];
    if (adjs.length > 0) {
      var aBox = el('div', 'tdAdjust');
      aBox.appendChild(el('div', 'tdHead', '建议调整方向（五类分别判断，不使用统一松紧倍率）：'));
      adjs.forEach(function (a) {
        var badge =
          a.status === 'SUGGESTED'
            ? '【建议】'
            : a.status === 'OBSERVING'
              ? '【观察中】'
              : '【不适用】';
        var directionZh =
          a.status !== 'SUGGESTED'
            ? ''
            : a.direction === 'HIGHER'
              ? '偏高'
              : a.direction === 'LOWER'
                ? '偏低'
                : '不变';
        aBox.appendChild(
          el(
            'div',
            'tdDim',
            '· ' +
              badge +
              a.labelZh +
              (directionZh ? '：' + directionZh : '') +
              '　作用对象：' +
              a.appliesTo,
          ),
        );
        aBox.appendChild(el('div', 'tdWhy', '　　' + (a.unsupportedReasonZh || a.reasonZh || '')));
      });
      details.appendChild(aBox);
    }

    /* ---- ⑤ 影子对比（正式 vs 调整后） ---- */
    if (td.comparison) {
      var c = td.comparison;
      var cBox = el('div', 'tdCompare');
      cBox.appendChild(el('div', 'tdHead', '影子对比（仅供复盘）：'));
      cBox.appendChild(el('div', 'tdDim', '· 正式建议（未调整）：' + c.baseZh));
      cBox.appendChild(el('div', 'tdDim', '· 调整后建议（实验）：' + c.adjustedZh));
      cBox.appendChild(
        el(
          'div',
          'tdWhy',
          c.changed
            ? '　　⇒ 桌况调整**改变了建议**（正式建议未受影响，这只是一次实验记录）'
            : '　　⇒ 桌况调整**没有改变建议**（可能是调整幅度不足，也可能是这个节点本来就不敏感）',
        ),
      );
      if (c.sameCashflowContract !== true) {
        cBox.appendChild(
          el('div', 'warn', '　　⚠️ 两次结果未使用同一收益口径 ⇒ **本次对比不可比**，请勿据此判断'),
        );
      }
      if ((td.appliedChanges || []).length > 0) {
        cBox.appendChild(el('div', 'tdHead', '调整了哪些输入参数：'));
        td.appliedChanges.forEach(function (line) {
          cBox.appendChild(el('div', 'tdWhy', '　· ' + line));
        });
      }
      details.appendChild(cBox);
    }

    /* ---- ⑥ 数据不足 / 失败的原因（必须显示，不能沉默） ---- */
    if (td.reasonZh) {
      details.appendChild(el('div', 'tdWhy', '说明：' + td.reasonZh));
    }
    if (td.logIssueZh) {
      details.appendChild(el('div', 'warn', '⚠️ ' + td.logIssueZh));
    }
    /* ---- ⑦ 记录口径（排除了多少条、为什么） ---- */
    details.appendChild(el('div', 'tdWhy', td.coverageZh || ''));

    box.appendChild(details);
  }

  function renderTimeline() {
    var box = $('timeline');
    clear(box);
    if (app.state.actionHistory.length === 0) {
      box.appendChild(el('div', 'hint', '还没有行动记录。'));
      return;
    }
    var groups = [];
    var byStreet = {};
    app.state.actionHistory.forEach(function (action) {
      var street = action.street || 'PREFLOP';
      if (!byStreet[street]) {
        byStreet[street] = [];
        groups.push(street);
      }
      byStreet[street].push(action);
    });

    var streetZh = {};
    (app.meta ? app.meta.streets : []).forEach(function (s) {
      streetZh[s.value] = s.labelZh;
    });
    var positionZh = {};
    (app.meta ? app.meta.positions : []).forEach(function (p) {
      positionZh[p.value] = p.labelZh;
    });
    var actionZh = {};
    (app.meta ? app.meta.actionTypes : []).forEach(function (x) {
      actionZh[x.value] = x.labelZh;
    });

    groups.forEach(function (street) {
      var group = el('div', 'streetGroup');
      group.appendChild(el('div', 'streetName', streetZh[street] || street));
      byStreet[street].forEach(function (action) {
        var text = (positionZh[action.position] || action.position) + ' ' + (actionZh[action.type] || action.type);
        if (action.amountBB !== undefined && action.type !== 'FOLD' && action.type !== 'CHECK') {
          text +=
            action.type === 'CALL' ? ' ' + action.amountBB + 'BB' : '到 ' + action.amountBB + 'BB';
        }
        group.appendChild(el('span', 'entry', text));
      });
      box.appendChild(group);
    });
  }

  function renderDebug() {
    var p = app.preview;
    $('debugSeats').textContent = JSON.stringify(
      {
        currentActor: p.currentActorPosition,
        isHeroTurn: p.isHeroTurn,
        handComplete: p.handComplete,
        bettingRoundComplete: p.bettingRoundComplete,
        seats: p.seats.map(function (s) {
          return {
            seatId: s.seatId,
            logicalPosition: s.logicalPosition,
            visualIndex: s.visualIndex,
            angleDeg: s.angleDeg,
            playerId: s.playerId,
            displayName: s.displayName,
            status: s.status,
            stackBB: s.stackBB,
            remainingStackBB: s.remainingStackBB,
            isCurrentActor: s.isCurrentActor,
          };
        }),
        playersById: app.state.playersById,
      },
      null,
      2,
    );
    $('debugMath').textContent = JSON.stringify(
      {
        street: p.street,
        potBB: p.potBB,
        currentBetBB: p.currentBetBB,
        callAmountBB: p.callAmountBB,
        minBetBB: p.minBetBB,
        minRaiseToBB: p.minRaiseToBB,
        effectiveStackBB: p.effectiveStackBB,
        remainingStacksBB: p.remainingStacksBB,
        legalActionTypes: p.legalActionTypes,
      },
      null,
      2,
    );
    $('debugInput').textContent = JSON.stringify(p.manualHandInput, null, 2);
    $('debugFingerprint').textContent = p.stateFingerprint || '（无）';
    $('debugDecision').textContent = app.analysis
      ? JSON.stringify(
          {
            stage: app.analysis.stage,
            decision: app.analysis.decision,
            /*
             * 🔴 范围来源与逐条原因必须出现在调试区。
             *
             * 从前这里只放 `decision` + `issues` + `timings`，**丢掉**了
             * `viewModel` —— 于是「这条建议基于什么范围」在界面上
             * 一个字都看不到（`viewModel.debug.range` 才是那份数据）。
             * 排查「为什么给这个建议」时，缺了它等于缺了半条证据链。
             */
            rangeProvenance: app.analysis.rangeProvenance,
            reasonsZh: app.analysis.viewModel ? app.analysis.viewModel.reasonsZh : undefined,
            warningsZh: app.analysis.viewModel ? app.analysis.viewModel.warningsZh : undefined,
            /*
             * 🔴 **PREFLOP RAISE DECISION 阶段 B**：翻前加注的**逐尺寸**证据。
             *
             * 「他弃/跟/再加注」「每个尺寸的 EV」「被再加注后我评估过哪些应对」
             * 这几件事都是**逐尺寸**的，只显示一条建议看不出来。
             * 数据来自 `decisionViewModel.debug.preflopRaise`（由 `preflopRaise`
             * 事实包原样搬运，**不在界面层重算**）。
             */
            preflopRaise:
              app.analysis.viewModel && app.analysis.viewModel.debug
                ? app.analysis.viewModel.debug.preflopRaise
                : undefined,
            issues: app.analysis.issues,
            timings: app.analysis.meta ? app.analysis.meta.timings : undefined,
            warnings: app.analysis.meta ? app.analysis.meta.warnings : undefined,
          },
          null,
          2,
        )
      : '（还没分析）';
  }

  /* ============================================================
   * 座位菜单与离桌决策
   * ============================================================ */

  function openModal(title, subtitle, buildBody) {
    var modal = $('modal');
    clear(modal);
    modal.appendChild(el('h3', null, title));
    if (subtitle) modal.appendChild(el('div', 'sub', subtitle));
    buildBody(modal);
    var row = el('div', 'row');
    var close = el('button', null, '关闭');
    close.onclick = closeModal;
    row.appendChild(close);
    modal.appendChild(row);
    $('overlay').className = 'show';
  }

  function closeModal() {
    $('overlay').className = '';
    app.pendingLeave = null;
    render();
  }

  function renderModal() {
    if (app.pendingLeave) {
      var leave = app.pendingLeave.decision;
      openModal(
        '该玩家本手已参与牌局 —— 请选择处理方式',
        leave.displayName + '（' + leave.position + '）',
        function (modal) {
          modal.appendChild(el('div', 'note', leave.noteZh));
          var row = el('div', 'row');
          /*
           * **哪些可选**由后端决定（`leave.options`，「不许默认猜」）；
           * **中文标签**来自后端元数据（前端不硬编码）。
           * 两者都来自后端，前端只是把它们并起来渲染。
           */
          var labelOf = {};
          ((app.meta && app.meta.leaveChoices) || []).forEach(function (c) {
            labelOf[c.value] = c.labelZh;
          });
          var allowed = leave.options || [];
          allowed.forEach(function (choice) {
            var b = el(
              'button',
              choice === 'FOLD_AND_LEAVE' ? 'danger' : '',
              labelOf[choice] || choice,
            );
            b.disabled = busy();
            b.onclick = function () {
              app.pendingLeave = null;
              sendOp({
                kind: 'CLEAR_SEAT',
                seatId: leave.seatId,
                activeHandChoice: choice,
              }).then(function () {
                closeModal();
              });
            };
            row.appendChild(b);
          });
          if (allowed.length === 0) {
            row.appendChild(el('span', 'hint', '（后端没有提供可选处理方式，请刷新页面）'));
          }
          modal.appendChild(row);
          modal.appendChild(
            el(
              'div',
              'note',
              '为什么不能直接清空：本手的底池与行动台账里已经有他的筹码，' +
                '直接删除会让筹码守恒被破坏。因此「离桌」只在本手结束后生效。',
            ),
          );
        },
      );
    }
  }

  /* ============================================================
   * PLAYER PROFILE TABLE UI V1 · 玩家名册 / 选人弹窗 / 悬停画像
   * ============================================================
   *
   * 数据来源**只有一个**：后端 `/api/table/players`（读真实历史 JSONL）。
   * 前端**不缓存统计数字**到本地存储、不自己算比率 —— 否则界面与引擎会各说各话。
   * 未观察到机会的指标后端返回 `null`，前端显示「暂无机会」，**绝不显示 0%**。
   */

  var rosterCache = null;

  function fetchRoster(query) {
    var url = '/api/table/players' + (query ? '?q=' + encodeURIComponent(query) : '');
    return fetch(url, { cache: 'no-store' })
      .then(function (r) {
        return r.json();
      })
      .then(function (body) {
        return body;
      })
      .catch(function (e) {
        return { ok: false, issues: [{ code: 'NETWORK', message: String(e) }] };
      });
  }

  function statLine(label, pair) {
    if (!pair) return label + '：暂无机会（未观察到 ⇒ 不是 0%）';
    var pct = pair.opportunities > 0 ? Math.round((pair.successes / pair.opportunities) * 100) : null;
    return (
      label + '：' + pair.successes + ' / ' + pair.opportunities + ' 次机会' +
      (pct === null ? '' : '（' + pct + '%）')
    );
  }

  function profileTextOf(player) {
    if (!player) return ['暂无历史记录'];
    var lines = [];
    lines.push('玩家：' + player.displayName + '（' + player.playerId + '）');
    lines.push('历史累计：' + player.handsObserved + ' 手（已完成 ' + player.handsComplete + ' 手）');
    lines.push('实测可信度（收缩权重）：' + player.measuredConfidence);
    lines.push(statLine('河牌面对下注弃牌', player.foldToRiverBet));
    lines.push(statLine('河牌过牌加注', player.riverCheckRaise));
    lines.push(
      '已进入决策模型：' +
        (player.connectedStatKeys.length ? player.connectedStatKeys.join('、') : '无'),
    );
    lines.push('尚未接通：' + player.unconnectedStatKeys.join('、'));
    return lines;
  }

  /** 悬停提示（**不遮挡公共牌 / 底池 / 行动按钮**：靠边吸附 + 指针穿透关闭） */
  function showSeatTip(seat, ev) {
    var tip = $('seatTip');
    if (!tip) return;
    var body = ['座位：' + seat.positionZh + '（' + seat.logicalPosition + '）'];
    if (!seat.playerId) {
      body.push('空座位 —— 点击可选择历史玩家或新建玩家');
      tip.textContent = body.join('\n');
      tip.className = 'show';
      positionTip(tip, ev);
      return;
    }
    body.push('当前画像：' + (seat.quickProfileZh || '未知') + '（标签先验）');
    if (seat.dynamicHintZh && seat.dynamicHintZh !== '未知') body.push('近期观察：' + seat.dynamicHintZh);
    tip.textContent = body.concat(['统计加载中…']).join('\n');
    tip.className = 'show';
    positionTip(tip, ev);
    /** 悬停即取真实统计（只读接口；失败时如实写「读取失败」而不是编数字） */
    fetchRoster('').then(function (res) {
      if (tip.className !== 'show') return;
      if (!res.ok) {
        tip.textContent = body.concat(['实测统计：读取失败（' + (res.issues || [])[0]?.code + '）']).join('\n');
        return;
      }
      var mine = (res.players || []).filter(function (p) {
        return p.playerId === seat.playerId;
      })[0];
      tip.textContent = body.concat(profileTextOf(mine)).join('\n');
    });
  }

  function positionTip(tip, ev) {
    var x = (ev && ev.clientX ? ev.clientX : 0) + 14;
    var y = (ev && ev.clientY ? ev.clientY : 0) + 14;
    var w = 360;
    if (x + w > window.innerWidth - 8) x = window.innerWidth - w - 8;
    if (x < 8) x = 8;
    if (y + 180 > window.innerHeight - 8) y = Math.max(8, (ev ? ev.clientY : 0) - 190);
    tip.style.left = x + 'px';
    tip.style.top = y + 'px';
  }

  function hideSeatTip() {
    var tip = $('seatTip');
    if (tip) tip.className = '';
  }

  /**
   * 选人弹窗（授权 §二）。
   *
   * | 功能 | 实现 |
   * |---|---|
   * | 按名字搜索 | `/api/table/players?q=` |
   * | 显示名称 / 稳定 id / 区分信息 | `displayName` + `playerId` + 手数 + `duplicateName` 标记 |
   * | 选择已有玩家入座 | `ADD_PLAYER{seatId, playerId, displayName}`（历史按 **playerId** 绑定） |
   * | 新建玩家 | `ADD_PLAYER{seatId, displayName}`（新 id，**不继承**任何历史） |
   * | 同名区分 | 列出全部候选，**绝不自动合并** |
   */
  function openPlayerPicker(seat) {
    openModal(
      '选择玩家 · ' + seat.positionZh + '（' + seat.logicalPosition + '）',
      '按名字搜索已有玩家，或新建一位玩家。历史记录按「稳定身份」绑定，换座位不会丢；同名不会合并。',
      function (modal) {
        var input = el('input', 'pickerSearch');
        input.type = 'text';
        input.setAttribute('data-testid', 'playerSearch');
        input.placeholder = '输入玩家名称或身份标识搜索…';
        modal.appendChild(input);

        var listBox = el('div', 'pickerList');
        modal.appendChild(listBox);

        function renderList(res) {
          clear(listBox);
          if (!res.ok) {
            listBox.appendChild(
              el('div', 'note danger', '历史读取失败：' + ((res.issues || [])[0]?.message || '未知原因') +
                '（不会显示任何统计，以免把损坏数据当真实画像）'),
            );
            return;
          }
          var players = res.players || [];
          if (players.length === 0) {
            listBox.appendChild(el('div', 'note', '暂无历史记录 —— 可直接「新建玩家」。'));
            return;
          }
          players.forEach(function (p) {
            var row = el('div', 'pickerRow');
            var head = el('div', 'pickerName', p.displayName + (p.duplicateName ? '（同名，请按身份区分）' : ''));
            row.appendChild(head);
            row.appendChild(el('div', 'pickerId', '身份 ' + p.playerId + '　历史 ' + p.handsObserved + ' 手'));
            row.appendChild(
              el(
                'div',
                'pickerStats',
                statLine('河牌面对下注弃牌', p.foldToRiverBet) + '　｜　' + statLine('河牌过牌加注', p.riverCheckRaise),
              ),
            );
            row.appendChild(
              el(
                'div',
                'pickerConnected',
                '已进入决策模型：' + (p.connectedStatKeys.length ? p.connectedStatKeys.join('、') : '无') +
                  '　｜　尚未接通：' + p.unconnectedStatKeys.join('、'),
              ),
            );
            var pick = el('button', 'primary', '让这位玩家入座');
            pick.setAttribute('data-testid', 'pick-' + p.playerId);
            pick.disabled = busy();
            pick.onclick = function () {
              sendOp({
                kind: 'ADD_PLAYER',
                seatId: seat.seatId,
                playerId: p.playerId,
                displayName: p.displayName,
              }).then(function () {
                rosterCache = null;
                closeUnlessPending();
              });
            };
            row.appendChild(pick);
            listBox.appendChild(row);
          });
        }

        function refresh() {
          fetchRoster(input.value).then(function (res) {
            rosterCache = res;
            renderList(res);
          });
        }
        input.oninput = refresh;
        refresh();

        var row = el('div', 'row');
        var nameInput = el('input', 'pickerNewName');
        nameInput.type = 'text';
        nameInput.setAttribute('data-testid', 'newPlayerName');
        nameInput.placeholder = '新玩家名称（可留空）';
        row.appendChild(nameInput);
        var create = el('button', null, '新建玩家并入座');
        create.setAttribute('data-testid', 'createPlayer');
        create.disabled = busy();
        create.onclick = function () {
          var name = nameInput.value.trim();
          sendOp({
            kind: 'ADD_PLAYER',
            seatId: seat.seatId,
            ...(name.length > 0 ? { displayName: name } : {}),
          }).then(function () {
            rosterCache = null;
            closeUnlessPending();
          });
        };
        row.appendChild(create);
        modal.appendChild(row);
        modal.appendChild(
          el(
            'div',
            'note',
            '新建玩家得到**新的稳定身份**，不会读取任何旧历史；' +
              '要让同一位玩家延续历史，请在上面的列表里选择他（按身份匹配，不按名字）。',
          ),
        );
      },
    );
  }

  function openSeatMenu(seat) {
    if (!seat.playerId) {
      openModal('空座位', seat.positionZh + '（' + seat.logicalPosition + '）', function (modal) {
        var row = el('div', 'row');
        var add = el('button', 'primary', '加入玩家');
        add.disabled = busy();
        add.onclick = function () {
          sendOp({ kind: 'ADD_PLAYER', seatId: seat.seatId }).then(closeUnlessPending);
        };
        row.appendChild(add);
        var pickFromHistory = el('button', null, '选择历史玩家…');
        pickFromHistory.disabled = busy();
        pickFromHistory.onclick = function () {
          openPlayerPicker(seat);
        };
        row.appendChild(pickFromHistory);
        modal.appendChild(row);
        modal.appendChild(
          el(
            'div',
            'note',
            '新玩家默认：新身份、' + app.state.defaultStackBB + 'BB、画像「未知」。' +
              '本手进行中无法加入（会破坏当前牌局）。',
          ),
        );
      });
      return;
    }

    openModal(
      seat.displayName + '　' + seat.positionZh,
      '状态：' + seat.statusZh + '　筹码：' + seat.stackBB + 'BB' + (seat.isHero ? '　（Hero）' : ''),
      function (modal) {
        /*
         * 🔴 **PLAYER PROFILE TABLE UI V1**：真实玩家画像（第一行）。
         *
         * 数字**只来自后端**（`/api/table/players`，读真实历史 JSONL）；
         * 没有历史 ⇒ 显示「暂无历史记录」；没有观测机会 ⇒ 显示「暂无机会」，
         * **绝不**显示 0%，也**绝不**把未接通的指标标成已生效。
         */
        var realBox = el('div', 'note drawerProfile');
        realBox.textContent = '真实历史：加载中…';
        modal.appendChild(realBox);
        fetchRoster('').then(function (res) {
          clear(realBox);
          if (!res.ok) {
            realBox.appendChild(el('div', 'danger', '真实历史读取失败：' + ((res.issues || [])[0]?.message || '')));
            return;
          }
          var mine = (res.players || []).filter(function (p) {
            return p.playerId === seat.playerId;
          })[0];
          profileTextOf(mine).forEach(function (line) {
            realBox.appendChild(el('div', null, line));
          });
          realBox.appendChild(
            el(
              'div',
              'hint',
              '「真实观测统计」来自本工具记录的真实行动；「标签先验」由上面的快速画像提供；' +
                '「尚未接通」的指标**没有**输入通道，不作为本次决策依据。',
            ),
          );
        });

        // ---- 画像 ----
        var profileRow = el('div', 'row');
        profileRow.appendChild(el('div', 'label', '快速画像（只作为输入证据，不直接改结论）'));
        (app.meta.quickProfiles || []).forEach(function (p) {
          var b = el('button', null, p.labelZh);
          b.disabled = busy();
          b.onclick = function () {
            sendOp({ kind: 'SET_PROFILE', seatId: seat.seatId, quickProfile: p.value }).then(closeUnlessPending);
          };
          profileRow.appendChild(b);
        });
        modal.appendChild(profileRow);

        // ---- 动态观察 ----
        var dynRow = el('div', 'row');
        dynRow.appendChild(el('div', 'label', '近期观察'));
        (app.meta.dynamicHints || []).forEach(function (h) {
          var b = el('button', null, h.labelZh);
          b.disabled = busy();
          b.onclick = function () {
            sendOp({ kind: 'SET_DYNAMIC_HINT', seatId: seat.seatId, dynamicHint: h.value }).then(
              closeModal,
            );
          };
          dynRow.appendChild(b);
        });
        modal.appendChild(dynRow);

        /*
         * 🔴 **筹码编辑必须在 Hero 的提前 return 之前**（2026-09 修复）。
         *
         * 修复前这段代码在 `if (seat.isHero) { … return; }` **之后**，
         * 于是 Hero 的座位菜单里根本没有「编辑筹码」这一行 ——
         * 使用者反馈「HERO 还是无法修改筹码数量」就是这个 `return` 造成的。
         * 那个 return 的本意只是隐藏「清空座位 / 更换玩家」。
         */
        appendStackEditor(modal, seat);

        if (seat.isHero) {
          modal.appendChild(el('div', 'note', 'Hero 的座位不能清空或更换玩家（本工具需要一位 Hero）。'));
          return;
        }

        // ---- 生命周期 ----
        var lifeRow = el('div', 'row');
        lifeRow.appendChild(el('div', 'label', '座位管理'));

        /*
         * 「设为庄家」（§19 / §76）。
         *
         * 为什么它必须在座位菜单里，而不是顶栏：Button 是**座位**的属性，
         * 使用者在牌桌上看到的也是「筹码牌在谁面前」。放到顶栏去选位置名，
         * 就等于逼他把「我看到的座位」翻译成「位置名」—— 那正是
         * 「Seat ≠ Position」被混淆的地方。
         *
         * ⚠️ 只在本手未开始时可用（本手进行中改 Button = 改已发生事实的归属）。
         */
        if (!app.state.handActive && seat.playerId) {
          var btnSeat = el(
            'button',
            app.state.buttonSeatId === seat.seatId ? 'active' : '',
            app.state.buttonSeatId === seat.seatId ? '当前庄家' : '设为庄家',
          );
          btnSeat.disabled = busy() || app.state.buttonSeatId === seat.seatId;
          btnSeat.onclick = function () {
            sendOp({ kind: 'SET_BUTTON', seatId: seat.seatId }).then(closeUnlessPending);
          };
          lifeRow.appendChild(btnSeat);
        }

        if (seat.status === 'SITTING_OUT' || seat.sitOutNextHand) {
          /*
           * 「重新入座」必须同时覆盖**已暂离**与**已标记下一手暂离**两种情形。
           *
           * 🔴 红队 RT-L6 命中：修复前只在 `status === 'SITTING_OUT'` 时给这个按钮，
           * 于是本手进行中标记了「下一手暂离」之后**没有任何取消入口** ——
           * 再点「暂时离座」只会得到「已经标记为下一手暂离」。
           * 后端 `SIT_IN` 本来就支持取消标记，只是界面没给按钮。
           */
          var back = el('button', 'primary', seat.sitOutNextHand && seat.status !== 'SITTING_OUT'
            ? '取消「下一手暂离」'
            : '重新入座');
          back.disabled = busy();
          back.onclick = function () {
            sendOp({ kind: 'SIT_IN', seatId: seat.seatId }).then(closeUnlessPending);
          };
          lifeRow.appendChild(back);
        } else {
          var out = el('button', null, '暂时离座');
          out.disabled = busy();
          out.onclick = function () {
            sendOp({ kind: 'SIT_OUT', seatId: seat.seatId }).then(closeUnlessPending);
          };
          lifeRow.appendChild(out);
        }

        var replace = el('button', null, '更换玩家');
        replace.disabled = busy();
        replace.title = '新玩家一律「未知」画像，绝不继承上一位玩家的数据';
        replace.onclick = function () {
          sendOp({ kind: 'REPLACE_PLAYER', seatId: seat.seatId }).then(closeUnlessPending);
        };
        lifeRow.appendChild(replace);

        var clearBtn = el('button', 'danger', '清空座位');
        clearBtn.disabled = busy();
        clearBtn.onclick = function () {
          sendOp({ kind: 'CLEAR_SEAT', seatId: seat.seatId }).then(closeUnlessPending);
        };
        lifeRow.appendChild(clearBtn);
        modal.appendChild(lifeRow);

        modal.appendChild(
          el(
            'div',
            'note',
            '「弃牌」请用右侧的行动按钮（走 Poker Engine），不要在座位菜单里完成 —— ' +
              '座位菜单一旦能改行动，就会出现绕过引擎的第二条路径。',
          ),
        );
      },
    );
  }

  /** 常用筹码预设（BB）—— 一键设置，省去手输 */
  var STACK_PRESETS_BB = [100, 150, 200];

  /**
   * 座位菜单里的「筹码编辑」：**预设 + 手动输入**。
   *
   * ## 为什么单独抽成一个函数
   *
   * 它必须对 **Hero 与其他座位一视同仁** —— 而座位菜单在 Hero 那一支有个
   * 提前 `return`（跳过「清空座位 / 更换玩家」）。把这段代码留在 return 之后，
   * Hero 就永远拿不到筹码编辑入口（这正是使用者报的那个 bug）。
   * 抽成函数并在 `return` **之前**调用，顺序就不会再被后来的改动破坏。
   *
   * ⚠️ 唯一门禁来自后端：本手进行中不允许改筹码（本手的筹码守恒基于开局筹码）。
   * 这里按同一条件**禁用**控件并写明原因 —— 点了才被拒是更差的体验。
   */
  function appendStackEditor(modal, seat) {
    var locked = app.state.handActive === true;

    var row = el('div', 'row');
    row.appendChild(el('div', 'label', '编辑筹码（本手未开始时可用）'));

    var input = el('input');
    input.type = 'number';
    input.min = '1';
    input.step = '1';
    input.value = String(seat.stackBB);
    input.style.width = '80px';
    input.disabled = locked;
    row.appendChild(input);

    var save = el('button', 'primary', '保存筹码');
    save.disabled = locked || busy();
    save.onclick = function () {
      /*
       * ⚠️ 必须用 `closeUnlessPending` 而不是 `closeModal`：
       * 后端一旦回传 `leaveDecision`，`render()` 会立刻打开离桌选择弹层，
       * 直接关掉它就等于把 §8 要求的选择吞掉（红队 RT-L2 命中过同一形态）。
       */
      sendOp({ kind: 'SET_STACK', seatId: seat.seatId, stackBB: Number(input.value) }).then(
        closeUnlessPending,
      );
    };
    row.appendChild(save);
    modal.appendChild(row);

    /* 常用筹码：一键设置（与手输等价，只是少打字） */
    var presetRow = el('div', 'row');
    presetRow.appendChild(el('div', 'label', '常用'));
    STACK_PRESETS_BB.forEach(function (bb) {
      var b = el('button', seat.stackBB === bb ? 'active' : '', bb + 'BB');
      b.disabled = locked || busy();
      b.onclick = function () {
        sendOp({ kind: 'SET_STACK', seatId: seat.seatId, stackBB: bb }).then(closeUnlessPending);
      };
      presetRow.appendChild(b);
    });
    modal.appendChild(presetRow);

    modal.appendChild(
      el(
        'div',
        'note',
        locked
          ? '本手进行中：筹码只能在**本手未开始**时修改（本手的筹码守恒基于开局筹码）。' +
              '请先点「重置本手」或「下一手」。'
          : '改完顶栏的「有效筹码」会按「我与对手中较小者」重新计算。',
      ),
    );
  }

  function saveBtnGuard(button, handler) {
    button.disabled = busy();
    button.onclick = handler;
  }

  /* ============================================================
   * 新建牌桌对话框（桌型 + Hero 位置都在这里选，不许默认猜）
   * ============================================================ */

  /**
   * 「新牌桌」必须让使用者选**桌型**与**Hero 的座位**。
   *
   * ⚠️ 这两项都能在顶栏改，但**开局第一手**必须在建桌前就定下来：
   * 顶栏的「桌型 / Hero」走的是 `SET_TABLE_SIZE` / `SET_HERO_POSITION`，
   * 而 `NEW_TABLE` 会把它们重置回默认值。先建桌再改，会多两次操作，
   * 而且中间那一瞬间的牌桌是错的（Hero 在 BTN 而实际不坐在那儿）。
   */
  function openNewTableModal() {
    var meta = app.meta || {};
    var sizes = meta.tableSizes || [
      { value: 6, labelZh: '6 人桌', positions: [] },
      { value: 9, labelZh: '9 人桌', positions: [] },
    ];
    /*
     * 🔴 选择项必须存在**弹层之外**的持久位置。
     *
     * 修复前的写法是：
     *
     * ```js
     * var chosenSize = app.state ? app.state.tableSize : 6;
     * ... b.onclick = function () { chosenSize = size.value; closeModal(); openNewTableModal(); };
     * ```
     *
     * 这里 `chosenSize` 是 `openNewTableModal()` 的**局部变量**，
     * 而点桌型/座位按钮会 `closeModal()` 再 `openNewTableModal()` ——
     * 重新进入函数时这两行立刻把它**重置回 `app.state` 的旧值**，
     * 使用者刚做的选择当场被丢弃。
     *
     * 实测（真实 Chrome，见 `test/newTableModal.test.ts`）：
     * 点「9 人桌」之后，弹层里 `active` 仍是「6 人桌」，
     * 确认按钮文案仍是「建立 6 座桌，Hero 在 BTN」——
     * 也就是**桌型根本选不动**，只能建出与当前桌型相同的桌子。
     *
     * 现在的规则：
     * - 第一次打开时用**当前牌桌**作为初值（符合直觉：默认沿用现状）；
     * - 之后每次重开都**保留使用者已经点过的选择**；
     * - 只有「建立」或「取消」才把它清掉。
     */
    if (app.pendingNewTable === null) {
      app.pendingNewTable = {
        size: app.state ? app.state.tableSize : 6,
        hero: app.state ? app.state.heroPosition : 'BTN',
      };
    }
    var chosenSize = app.pendingNewTable.size;
    var chosenHero = app.pendingNewTable.hero;

    openModal('新建牌桌', '座位容量与本手人数是两件事：先选桌子有几个座位。', function (modal) {
      var sizeRow = el('div', 'row');
      sizeRow.appendChild(el('span', 'label', '桌型'));
      var sizeButtons = el('span', 'position-buttons');
      sizes.forEach(function (size) {
        var b = el('button', size.value === chosenSize ? 'active' : '', size.labelZh);
        b.onclick = function () {
          app.pendingNewTable.size = size.value;
          var allowed = size.positions && size.positions.length > 0
            ? size.positions
            : size.value === 9
              ? ['UTG', 'UTG1', 'UTG2', 'LJ', 'HJ', 'CO', 'BTN', 'SB', 'BB']
              : ['UTG', 'HJ', 'CO', 'BTN', 'SB', 'BB'];
          /*
           * 换了桌型之后，原来的 Hero 座位可能**不存在于新桌型**（例如
           * UTG1 不在 6 人桌上）。这时回落到 BTN —— 而不是保留一个
           * 新桌子上没有的座位名（那会让「建立」发出一个非法请求）。
           */
          if (allowed.indexOf(app.pendingNewTable.hero) < 0) {
            app.pendingNewTable.hero = 'BTN';
          }
          closeModal();
          openNewTableModal();
        };
        sizeButtons.appendChild(b);
      });
      sizeRow.appendChild(sizeButtons);
      modal.appendChild(sizeRow);

      var size = null;
      for (var i = 0; i < sizes.length; i += 1) {
        if (sizes[i].value === chosenSize) size = sizes[i];
      }
      var positions =
        size && size.positions && size.positions.length > 0
          ? size.positions
          : chosenSize === 9
            ? ['UTG', 'UTG1', 'UTG2', 'LJ', 'HJ', 'CO', 'BTN', 'SB', 'BB']
            : ['UTG', 'HJ', 'CO', 'BTN', 'SB', 'BB'];

      var heroRow = el('div', 'row');
      heroRow.appendChild(el('span', 'label', 'Hero 座位'));
      var heroButtons = el('span', 'position-buttons');
      positions.forEach(function (p) {
        var info = null;
        for (var k = 0; k < (meta.positions || []).length; k += 1) {
          if (meta.positions[k].value === p) info = meta.positions[k];
        }
        var b = el('button', p === chosenHero ? 'active' : '', info ? info.labelZh : p);
        b.onclick = function () {
          app.pendingNewTable.hero = p;
          closeModal();
          openNewTableModal();
        };
        heroButtons.appendChild(b);
      });
      heroRow.appendChild(heroButtons);
      modal.appendChild(heroRow);

      var confirmRow = el('div', 'row');
      var confirm = el(
        'button',
        'primary',
        '建立 ' + chosenSize + ' 座桌，Hero 在 ' + chosenHero,
      );
      confirm.onclick = function () {
        closeModal();
        app.pendingNewTable = null;
        createTable(chosenSize, chosenHero);
      };
      confirmRow.appendChild(confirm);
      var cancel = el('button', null, '取消');
      cancel.onclick = function () {
        closeModal();
        app.pendingNewTable = null;
      };
      confirmRow.appendChild(cancel);
      modal.appendChild(confirmRow);

      modal.appendChild(
        el(
          'div',
          'note',
          '空座位不必补满：本手人数由「实际参与的人」决定，' +
            '9 座桌坐 8 人照样可以分析。Button 会自动按座位轮转，' +
            '也可以在座位菜单里手动指定。',
        ),
      );
    });
  }

  /* ============================================================
   * 启动
   * ============================================================ */

  /**
   * 「开一手新的」时的共同收尾。
   *
   * 🔴 **模式必须回到 `CURRENT_DECISION`**（规范：新牌桌 / 下一手，默认当前决策）。
   *
   * 为什么这不是小事：如果使用者上一手在「录入历史」模式下补录，
   * 下一手开始时若模式没重置，他会**以为**系统在自动分析，
   * 而实际上自动分析是关着的 —— 于是「怎么没反应」。
   * 默认值必须是「能用的那一个」，而不是「上次碰巧停在的那一个」。
   *
   * ⚠️ 这里**不**动 `revision`：模式是界面意图，不是牌局状态。
   * 失效由 `modeEpoch` 负责（见 `setMode` 的说明）。
   */
  function beginFreshHand() {
    app.analysis = null;
    app.autoState = null;
    /*
     * 🔴 **主动取消上一个牌局遗留的 debounce 排程。**
     *
     * 不能指望随后的 `scheduleAutoAnalyze` 顺手清掉：新手牌还没录手牌 ⇒
     * `decision.ready !== true` ⇒ 它在「清 timer」之前就 `return` 了，
     * 旧 timer 会原封不动留下来。
     * （回归：`test/autoAnalyzeHistoryEntry.test.ts` Case E。）
     */
    cancelPendingAnalyze();
    if (app.mode !== 'CURRENT_DECISION') {
      app.mode = 'CURRENT_DECISION';
      app.modeEpoch += 1;
      app.analyzeLatestToken += 1;
    }
  }

  function bindTopbar() {
    $('nextHandBtn').onclick = function () {
      beginFreshHand();
      sendOp({ kind: 'NEXT_HAND' });
    };
    $('resetHandBtn').onclick = function () {
      app.analysis = null;
      /*
       * 重置会清掉手牌并推进 revision ⇒ 旧排程针对的牌局已经不存在了。
       * 必须先撤掉它，否则它到点后会拿**重置后**的状态跑一次分析。
       * （回归：`test/autoAnalyzeHistoryEntry.test.ts` Case A / Case C。）
       */
      cancelPendingAnalyze();
      sendOp({ kind: 'RESET_HAND' });
    };
    $('undoBtn').onclick = function () {
      app.analysis = null;
      /*
       * 撤销会**推进** revision（实测 8 → 9）并可能把状态重新变回「就绪」。
       * 因此只靠下游的「就绪闸门」是不够的 —— 撤销后的状态本来就是就绪的，
       * 旧 timer 到点后完全可能通过闸门、却是在为一个**它从未被排程过**的
       * revision 跑分析。必须在撤销前把这次排程撤掉。
       * （回归：`test/autoAnalyzeHistoryEntry.test.ts` Case B。）
       */
      cancelPendingAnalyze();
      sendOp({ kind: 'UNDO' });
    };
    /*
     * 「新牌桌」= **新建牌桌对话框**，不再硬编码 6 人桌。
     *
     * 🔴 修复前这一句直接 `post('/api/table', { tableSize: 6, heroPosition: 'BTN' })`。
     * 使用者从界面上**无从表达**自己坐在哪种桌型的哪个位置 ——
     * 而这两件事决定了之后每一手的盲注归属。开局就错，后面全错。
     */
    $('newTableBtn').onclick = function () {
      openNewTableModal();
    };
    $('clearVillainsBtn').onclick = function () {
      app.analysis = null;
      sendOp({ kind: 'CLEAR_ALL_VILLAINS' });
    };
    /*
     * 一键加入玩家（2026-09）。
     *
     * 🔴 语义：在**每一个空位**各加入一名新玩家（一次请求 = 一次撤销）。
     * 逐个点空位 → 「加入玩家」仍然可用；这个按钮只是把最费手的那条路变一键。
     *
     * ⚠️ 与「清空其他玩家」对称：都会改变「本手有几个对手」，
     * 因此同样要把**上一次的结论作废**（`app.analysis = null`）——
     * 否则屏幕上会留着「按 1 个对手算出来的建议」而牌桌上已经有 5 个对手。
     * 作废后由自动分析按新 revision 重跑。
     */
    $('fillSeatsBtn').onclick = function () {
      app.analysis = null;
      sendOp({ kind: 'FILL_EMPTY_SEATS' });
    };
    $('analyzeBtn').onclick = function () {
      /*
       * 「重新分析」= 手动强制跑一次。
       *
       * 用途只有三个：手动重试 / 调试 / 主动刷新（规范原文）。
       * 它不是正常流程的必经步骤 —— 轮到 Hero 时会自动分析。
       *
       * ⚠️ 这里**不**清 `app.analysis`：跑的时候状态条会显示「正在分析…」，
       * 若先把旧结果清掉，界面会在请求往返期间空一下，看起来像「没反应」。
       */
      runAnalyze('manual');
    };
    $('overlay').onclick = function (event) {
      if (event.target === $('overlay')) closeModal();
    };
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') closeModal();
    });
  }

  function boot() {
    bindTopbar();
    /*
     * 「GTO 范围」入口。
     *
     * 刻意做成**跳转到一个独立页面**（`/gto`），而不是在本页内嵌：
     * 本页的状态机（牌桌 / 行动 / 自动分析）已经足够复杂，
     * 把 GTO 的 169 格矩阵塞进来会让「一次误点就改了牌桌状态」成为可能。
     * 独立页面之间没有共享可变状态，这是最安全的做法。
     */
    var gotoGto = document.getElementById('gotoGtoBtn');
    if (gotoGto) {
      gotoGto.addEventListener('click', function () {
        window.location.href = '/gto';
      });
    }
    fetch('/api/table/meta')
      .then(function (res) {
        return res.json();
      })
      .then(function (payload) {
        app.meta = payload.meta;
        return createTable();
      })
      .catch(function (error) {
        toast('初始化失败：' + String(error), true);
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  /*
   * ============================================================
   * 🔴 **浏览器验收钩子**（只读，不改变任何行为）
   * ============================================================
   *
   * ## 为什么需要它
   *
   * 本文件是一个 IIFE，`app` 与 `render` 都是**私有**的。于是
   * 「这条建议在**真实页面**上到底显示成什么」只能靠**截图人工看**，
   * 自动化验收做不到 —— 而人工看无法进入回归。
   *
   * 有了这个钩子，验收脚本可以：
   *
   * ```js
   * window.__dshTest.app.analysis = <服务端真实返回的 payload>;
   * window.__dshTest.render();          // ← 调用**本文件自己的** render
   * document.body.innerText             // ← 读它生成的真实 DOM
   * ```
   *
   * 关键点：渲染走的是**同一个 `render()`**，验收读的是**同一份 DOM**，
   * 因此「验收通过」与「页面正确」是同一件事，不是两套实现。
   *
   * ## 为什么它不会影响生产
   *
   * - **只读暴露**：只把已有的对象与方法挂出去，不新增任何逻辑分支；
   * - **不参与任何判定**：`render` 的行为不读这个钩子；
   * - 验收脚本是本仓库的 `probes/`（临时目录），不随产品发布；
   * - 最坏情况（有人在控制台乱改 `app.analysis`）与在控制台里手改
   *   DOM 是同一类事情，**本来就能做**，因此不引入新的攻击面。
   */
  try {
    window.__dshTest = {
      app: app,
      render: render,
      renderResult: typeof renderResult === 'function' ? renderResult : null,
      /*
       * 🔴 把**真实用户点击所走的那一步**也暴露出来。
       *
       * 为什么必须带上它：只改 `app.state` 会让 `app.preview` 停在旧值，
       * 于是横幅 / 时间线 / 行动者显示的是**上一手**的内容 ——
       * 验收脚本会把这个不一致误报成产品缺陷
       * （我第一次截图就踩到了：建议区已经出了「全下」，
       * 横幅却还写着「本手还没开始」）。
       *
       * `applyTableResponse` 是「服务端响应 → state + preview」的**唯一**入口，
       * 挂上它之后，验收走的就是与真实点击完全相同的那条路。
       */
      applyTableResponse: applyTableResponse,
    };
  } catch (hookError) {
    /* 钩子失败绝不影响页面 */
    void hookError;
  }
})();
