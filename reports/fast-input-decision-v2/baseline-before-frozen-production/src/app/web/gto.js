/*
 * GTO 范围页 —— 前端逻辑
 *
 * ## 三条纪律（与后端一致）
 *
 * 1. **百分比只在这里转一次**。后端给的一律是 0..1 的小数，
 *    `fmtPercent()` 是唯一做 `× 100` 的地方。任何其他地方自己乘 100
 *    都会制造出「0.65 显示成 0.65%」这类错误。
 *
 * 2. **不做任何策略判断**。「哪个动作是主要动作」只是按频率取最大，
 *    不是推荐；「是否近似」完全由后端字段决定，前端不猜。
 *
 * 3. **不可用就要看得出来**。拿不到数据时矩阵**不渲染**，
 *    并且明确写出中文原因 —— 绝不显示一个空的或全 0 的矩阵，
 *    那会被误读成「所有牌都弃牌」。
 */

'use strict';

/* ============================================================
 * 常量
 * ============================================================ */

// 13×13 的轴：与后端 GTO_RANK_CHARS 同序（A 在前）
const RANKS = ['A', 'K', 'Q', 'J', 'T', '9', '8', '7', '6', '5', '4', '3', '2'];

// 动作类别 → 中文
const KIND_ZH = {
  FOLD: '弃牌',
  CHECK: '过牌',
  CALL: '跟注',
  BET: '下注',
  RAISE: '加注',
  ALL_IN: '全下',
};

// 动作类别 → 颜色分组
const KIND_GROUP = {
  FOLD: 'fold',
  CHECK: 'call',
  CALL: 'call',
  BET: 'aggr',
  RAISE: 'aggr',
  ALL_IN: 'aggr',
};

/* ============================================================
 * 状态
 * ============================================================ */

const state = {
  catalog: null,
  /** Phase 1.1：扩展场景目录（面对开池 / 面对 3Bet / 面对 4Bet） */
  extendedEntries: [],
  /** 目录是按哪个有效筹码生成的（后端回执，用于显示与自检） */
  catalogStackBB: null,
  /** 是否已经做过「首次进入」的选择（做一次就够，之后尊重用户的选择） */
  initialized: false,
  tableSize: 4,
  heroPosition: null,
  /** 当前选中的**目录条目 id**（不再由界面拼场景） */
  entryId: null,
  /** 上一次通过校验的有效筹码（非法输入时回退到它，而不是悄悄用 100） */
  lastValidStackBB: null,
  template: null,
  response: null,
  selectedHand: null,
};

/* ============================================================
 * 工具
 * ============================================================ */

function $(id) {
  return document.getElementById(id);
}

/** 0..1 → 百分数字符串。**全项目唯一**做 ×100 的地方。 */
function fmtPercent(freq01, digits) {
  if (typeof freq01 !== 'number' || !Number.isFinite(freq01)) return '—';
  const d = digits === undefined ? 1 : digits;
  return (freq01 * 100).toFixed(d) + '%';
}

/** 动作的可读标签：`加注 2.5BB` */
function actionLabel(action) {
  const zh = KIND_ZH[action.kind] || action.kind;
  if (action.sizeBB === null || action.sizeBB === undefined) return zh;
  return zh + ' ' + action.sizeBB + 'BB';
}

function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.classList.add('show');
  setTimeout(function () {
    el.classList.remove('show');
  }, 3200);
}

/**
 * 读顶栏的「有效筹码」。
 *
 * 🔴 **这个输入框以前是完全无效的**（2026-09 修正轮）：页面从 `stackInput`
 * 取值这一步根本不存在，查询只发 `{ entryId }`，后端扩展端点也只读 entryId ——
 * 于是用户填 50BB 拿到的是 100BB 的策略，界面上没有任何线索。
 *
 * 现在它是一级场景参数：随目录与查询一起发送。非法输入不会静默退回 100，
 * 而是提示并保持上一次的合法值。
 */
const STACK_MIN_BB = 1;
const STACK_MAX_BB = 1000;

function readStackBB() {
  const raw = $('stackInput').value;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < STACK_MIN_BB || value > STACK_MAX_BB) {
    toast('有效筹码必须是 ' + STACK_MIN_BB + '–' + STACK_MAX_BB + 'BB 之间的数字（收到「' + raw + '」）');
    const fallback = state.lastValidStackBB === null ? 100 : state.lastValidStackBB;
    $('stackInput').value = String(fallback);
    return fallback;
  }
  state.lastValidStackBB = value;
  return value;
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      status: 'INVALID_RESPONSE',
      messageZh: '服务端返回的不是合法 JSON（HTTP ' + response.status + '）',
      approximationNotes: [],
      baseline: null,
    };
  }
}

/* ============================================================
 * 目录 → 下拉框
 * ============================================================ */

async function loadCatalog() {
  const response = await fetch('/api/gto/catalog');
  const catalog = await response.json();
  state.catalog = catalog;

  /*
   * Phase 1.1：扩展场景目录（与基础目录共用同一套桌人数/位置）
   *
   * 🔴 目录必须**按有效筹码**获取（2026-09 修正轮）：同一个条目 id 在不同
   * 筹码下是不同的决策节点（scenarioHash 与频率都不同），因此
   * 「supported / 未支持原因 / scenarioHash」都必须与当前筹码一致。
   * 修复前这里既不带筹码、页面也不发送筹码，于是顶栏那个输入框完全无效。
   */
  try {
    const stack = readStackBB();
    const ext = await fetch(
      '/api/gto/catalog/extended?effectiveStackBB=' + encodeURIComponent(String(stack)),
    );
    const extJson = await ext.json();
    state.extendedEntries = Array.isArray(extJson.entries) ? extJson.entries : [];
    state.catalogStackBB = typeof extJson.effectiveStackBB === 'number' ? extJson.effectiveStackBB : stack;
    if (extJson.ok === false && typeof extJson.messageZh === 'string') {
      toast(extJson.messageZh);
    }
  } catch (error) {
    state.extendedEntries = [];
  }

  // 牌桌人数按钮
  const sizeWrap = $('sizeButtons');
  sizeWrap.innerHTML = '';
  catalog.tableSizes.forEach(function (size) {
    const button = document.createElement('button');
    button.textContent = size + ' 人桌';
    button.dataset.size = String(size);
    button.addEventListener('click', function () {
      state.tableSize = size;
      renderSizeButtons();
      renderPositionOptions();
    });
    sizeWrap.appendChild(button);
  });

  /*
   * ⚠️ 只在「还没选」或「当前桌型在新目录里不存在」时才回到第一个桌型 ——
   * 否则改一次有效筹码就会把用户选的桌型重置成 4 人桌（看起来像 bug）。
   */
  if (state.tableSize === null || catalog.tableSizes.indexOf(state.tableSize) < 0) {
    state.tableSize = catalog.tableSizes[0];
  }

  /*
   * 🔴 **首次进入必须落在一个「查得到」的场景上**（2026-09 修正轮）。
   *
   * 目录是把**所有**节点都列出来的（不支持的也列，并写明原因）——
   * 这是刻意的设计。但默认选中的是「第一个桌型 + 第一个位置」，
   * 而 `4 人桌 CO` 是第一个行动位、**一条可查条目都没有**：
   * 用户一打开页面就看到「尚未验证 / CO 是第一个行动位…」，
   * 很容易以为整页是坏的（这正是使用者反馈的「跟个空壳一样」的形态）。
   *
   * 因此只在**首次**加载时把选择挪到第一个真正支持的组合上；
   * 之后用户主动选的位置一律尊重（选到不支持的就如实说明原因）。
   */
  if (state.initialized !== true) {
    const preferred = pickFirstSupportedSelection(catalog, state.extendedEntries);
    if (preferred !== null) {
      state.tableSize = preferred.tableSize;
      state.heroPosition = preferred.heroPosition;
    }
    state.initialized = true;
  }

  renderSizeButtons();
  renderPositionOptions();
}

/**
 * 找出「第一个真的查得到」的（桌型, 位置）。
 *
 * ⚠️ 判据是**后端目录里的 `supported`**，不是前端猜的 ——
 * 前端不得自己判断某个节点是否可解（那是场景模型的知识）。
 */
function pickFirstSupportedSelection(catalog, entries) {
  const sizes = catalog.tableSizes || [];
  for (const size of sizes) {
    const positions = (catalog.positionsByTableSize || {})[String(size)] || [];
    for (const position of positions) {
      const ok = entries.some(function (entry) {
        return entry.tableSize === size && entry.heroPosition === position && entry.supported;
      });
      if (ok) return { tableSize: size, heroPosition: position };
    }
  }
  return null;
}

function renderSizeButtons() {
  const buttons = $('sizeButtons').querySelectorAll('button');
  buttons.forEach(function (button) {
    button.classList.toggle('active', Number(button.dataset.size) === state.tableSize);
  });
}

/**
 * 位置下拉框**按桌人数动态渲染**。
 *
 * 🔴 关键点：位置列表来自后端目录的 `positionsByTableSize`，
 * 而不是前端写死的表。因此「4 人桌只有 CO/BTN/SB/BB、没有 UTG」
 * 是由后端保证的事实，前端无法显示一个不存在的座位。
 */
function renderPositionOptions() {
  const catalog = state.catalog;
  const positions = (catalog.positionsByTableSize[String(state.tableSize)] || []).slice();
  const select = $('positionSelect');
  select.innerHTML = '';
  positions.forEach(function (position) {
    const option = document.createElement('option');
    option.value = position;
    const zh = (catalog.positionZh || {})[position];
    option.textContent = zh ? position + '（' + zh + '）' : position;
    select.appendChild(option);
  });
  /*
   * ⚠️ 只在「还没选」或「当前位置在新桌型里不存在」时才回到第一个位置 ——
   * 否则改一次有效筹码/桌型就会把用户选的位置重置掉。
   */
  if (state.heroPosition === null || positions.indexOf(state.heroPosition) < 0) {
    state.heroPosition = positions.length > 0 ? positions[0] : null;
  }
  select.value = state.heroPosition ?? '';
  select.onchange = function () {
    state.heroPosition = select.value;
    renderTemplateOptions();
  };
  renderTemplateOptions();
}

/**
 * 场景下拉框 —— **Phase 1.1：改用扩展目录**。
 *
 * ## 为什么换成扩展目录
 *
 * Phase 1 的目录只有「第一个入池」与「前面全弃」两类，覆盖不到
 * 使用者真正关心的节点（面对开池 / 面对 3Bet）。
 * 扩展目录补上了这些，并且**每个开池者一个条目** ——
 * 因此「BB vs BTN 开池」与「BB vs UTG 开池」在下拉框里就是两个选项，
 * 不可能再出现「标签写 BTN、数据是 UTG」。
 *
 * ## 🔴 不支持项**照原样列出**并标注原因
 *
 * 「面对 3Bet」「面对 4Bet」在本阶段表达不了。它们**仍然出现在下拉框里**，
 * 选中后显示明确的中文原因 —— 而不是从下拉框里消失。
 * 消失会让人以为「这里本来就没有东西可查」，
 * 那与「我们明确知道它不支持」是两种完全不同的信息。
 */
function renderTemplateOptions() {
  const select = $('templateSelect');
  const openerSelect = $('openerSelect');
  const openerGroup = $('openerGroup');
  select.innerHTML = '';
  openerSelect.innerHTML = '';
  openerGroup.style.display = 'none';
  state.entryId = null;

  const entries = state.extendedEntries.filter(function (entry) {
    return entry.tableSize === state.tableSize && entry.heroPosition === state.heroPosition;
  });

  if (entries.length === 0) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = '（该位置没有可查询的场景）';
    select.appendChild(option);
    state.template = null;
    $('scenarioLine').textContent = '';
    return;
  }

  entries.forEach(function (entry) {
    const option = document.createElement('option');
    option.value = entry.id;
    // 不支持的项明确标注，而不是隐藏
    option.textContent = entry.supported ? entry.labelZh : entry.labelZh + '（尚未验证）';
    option.dataset.supported = entry.supported ? '1' : '0';
    select.appendChild(option);
  });

  // 默认选第一个**支持**的条目
  const firstSupported = entries.find((e) => e.supported);
  const initial = firstSupported === undefined ? entries[0] : firstSupported;
  select.value = initial.id;
  state.entryId = initial.id;
  state.template = initial.template;

  select.onchange = function () {
    const entry = entries.find((e) => e.id === select.value);
    state.entryId = entry === undefined ? null : entry.id;
    state.template = entry === undefined ? null : entry.template;

    // 「面对指定开池」需要额外选一个开池者 —— 但目录里
    // **每个开池者已经是一个独立条目**，因此这里只是把开池者显示出来，
    // 不提供二次选择（避免「界面选 BTN、数据是 UTG」这种不一致的入口）。
    if (entry !== undefined && entry.openerPosition !== null) {
      openerGroup.style.display = '';
      openerSelect.innerHTML = '';
      const o = document.createElement('option');
      o.value = entry.openerPosition;
      o.textContent = entry.openerPosition;
      openerSelect.appendChild(o);
      openerSelect.disabled = true; // 由条目决定，不允许改
    } else {
      openerGroup.style.display = 'none';
    }
    showEntryReason(entry);
  };
  showEntryReason(initial);
}

/** 显示所选条目的状态（可查询 / 为什么不支持） */
function showEntryReason(entry) {
  if (entry === undefined) {
    $('scenarioLine').textContent = '';
    return;
  }
  if (entry.supported) {
    const history =
      entry.actionHistory.length === 0
        ? '无人入池'
        : entry.actionHistory
            .map(function (a) {
              return a.position + ' ' + (KIND_ZH[a.kind] || a.kind) + (a.sizeBB === null ? '' : ' ' + a.sizeBB + 'BB');
            })
            .join(' → ');
    $('scenarioLine').textContent = '该节点：' + history + '（轮到 ' + entry.heroPosition + '）';
    return;
  }
  $('scenarioLine').textContent = '';
  $('statusBanner').className = 'banner bad';
  $('statusBanner').innerHTML =
    '<span class="tag">尚未验证</span>' + escapeHtml(entry.unsupportedReason || '该场景暂不支持');
}

/* ============================================================
 * 查询
 * ============================================================ */

async function loadRange() {
  if (state.entryId === null) {
    toast('请选择位置与场景');
    return;
  }

  $('statusBanner').className = 'banner info';
  $('statusBanner').textContent =
    '正在向本地 GTOpen 查询…（首次查询需要建树并求解：9 人桌可能 2–3 分钟；' +
    '命中本地缓存则只需几毫秒）';
  $('loadBtn').disabled = true;

  let result;
  try {
    /*
     * 🔴 Phase 1.1：改成按**目录条目 id** 查询。
     *
     * 之前是界面把「桌人数 + 位置 + 模板」三个字段发过去让后端拼场景。
     * 那样界面就有机会表达出「后端目录里不存在的组合」。
     * 现在界面只能引用目录里的条目 —— 场景由目录唯一决定。
     *
     * 🔴 有效筹码（2026-09 修正轮）：条目 id **不含筹码**，因此筹码作为
     * 独立字段随查询一起发。后端按它重新构造场景（scenarioHash 与缓存键
     * 都随之改变），响应里的「场景」会如实写出实际筹码。
     */
    const stackBB = readStackBB();
    result = await postJson('/api/gto/range/extended', {
      entryId: state.entryId,
      effectiveStackBB: stackBB,
    });
  } catch (error) {
    result = {
      ok: false,
      status: 'UNAVAILABLE',
      messageZh: '请求失败：' + String(error && error.message ? error.message : error),
      approximationNotes: [],
      baseline: null,
    };
  } finally {
    $('loadBtn').disabled = false;
  }

  state.response = result;
  state.selectedHand = null;
  render();
}

/* ============================================================
 * 渲染
 * ============================================================ */

function render() {
  const result = state.response;
  if (result === null) return;

  const baseline = result.baseline;
  const banner = $('statusBanner');

  if (!result.ok || baseline === null || baseline.status !== undefined) {
    // ---- 拿不到数据：**不渲染矩阵**，明确说明原因 ----
    banner.className = 'banner bad';
    banner.innerHTML =
      '<span class="tag">GTO_BASELINE_UNAVAILABLE</span>' +
      escapeHtml(result.messageZh || '未取得 GTO 数据');
    $('matrix').innerHTML = '';
    $('matrixAxisTop').innerHTML = '';
    $('matrixAxisLeft').innerHTML = '';
    $('matrixLegend').innerHTML = '';
    $('detailPanel').style.display = 'none';
    $('statusPanel').style.display = 'none';
    $('metaBody').innerHTML =
      '<div>本次<b>没有</b>使用任何近似先验或默认频率冒充 GTO。' +
      'Alpha 的其他功能（牌桌录入、建议、数学九项）不受影响。</div>';
    $('scenarioLine').textContent = '';
    return;
  }

  /*
   * ---- 成功：状态由**质量等级**决定 ----
   *
   * 🔴 两种成功状态的横幅**必须看起来不一样**：
   * - `LOW_CONVERGENCE`（未达标）→ 黄色 + 「质量有限」措辞
   * - `APPROXIMATE`（达标但模型近似）→ 蓝色 + 「近似策略」措辞
   *
   * 把未收敛的结果显示成与收敛结果同一种绿/蓝，等于告诉使用者
   * 「这两份数据一样可信」—— 而那正是本轮要禁止的事。
   */
  const quality = result.quality;
  const lowConv = result.status === 'LOW_CONVERGENCE';
  banner.className = lowConv ? 'banner bad' : 'banner approx';
  banner.innerHTML =
    '<span class="tag">' +
    escapeHtml(quality === null ? '近似策略' : quality.levelZh) +
    '</span>' +
    escapeHtml(result.messageZh || '') +
    (result.cache && result.cache.source !== 'solver'
      ? '　<span class="hint">（' + escapeHtml(result.cache.sourceZh) + '，未重新求解）</span>'
      : '　<span class="hint">（本次实时求解）</span>');

  $('scenarioLine').textContent = result.scenarioZh ? '场景：' + result.scenarioZh : '';

  renderMatrix(baseline);
  renderMeta(baseline, result);
  renderStatusPanel(result);
}

/**
 * 「本次数据的来源与质量」面板。
 *
 * 🔴 这一块的存在理由是**信任边界**：使用者必须能一眼看出
 * 「这是刚算的还是读缓存的」「迭代了多少次」「离收敛多远」。
 * 缺任何一项，他都会合理地高估或低估这份数据。
 */
function renderStatusPanel(result) {
  const panel = $('statusPanel');
  const grid = $('statusGrid');
  const notes = $('statusNotes');
  const cache = result.cache;
  const quality = result.quality;
  if (cache === null && quality === null) {
    panel.style.display = 'none';
    return;
  }
  panel.style.display = '';

  const baseline = result.baseline;
  const settings = baseline === null ? null : baseline.metadata.solveSettings;
  const source = baseline === null ? null : baseline.metadata.source;
  const fmtMs = function (ms) {
    if (ms === null || ms === undefined) return '—';
    return ms < 1000 ? ms + ' ms' : (ms / 1000).toFixed(1) + ' 秒';
  };

  const rows = [
    ['数据来源', cache === null ? '—' : cache.sourceZh],
    ['求解引擎', source === null ? '—' : source.engine],
    ['求解器版本（commit）', source === null || source.engineCommit === null ? '未记录' : source.engineCommit],
    ['质量等级', quality === null ? '—' : quality.levelZh],
    ['迭代次数', settings === null ? '—' : String(settings.iterationsCompleted ?? '未知')],
    ['收敛目标', settings === null ? '—' : String(settings.targetGap ?? '未设目标')],
    [
      'BR gap 之和',
      settings === null || settings.reportedGap === null ? '未测' : settings.reportedGap.toFixed(8),
    ],
    ['求解耗时', cache === null ? '—' : fmtMs(cache.solveDurationMs)],
    ['缓存写入时间', cache === null || cache.cachedAt === null ? '—' : cache.cachedAt],
    ['缓存键', cache === null ? '—' : cache.cacheKey],
    ['本次读取耗时', result.stats === null ? '—' : fmtMs(result.stats.latencyMs)],
  ];

  grid.innerHTML = rows
    .map(function (row) {
      return (
        '<dt>' + escapeHtml(row[0]) + '</dt><dd class="mono">' + escapeHtml(row[1]) + '</dd>'
      );
    })
    .join('');

  const notesList = [];
  if (quality !== null) notesList.push(quality.disclaimerZh);
  if (quality !== null && quality.summaryZh) notesList.push(quality.summaryZh);
  if (result.stats !== null && result.stats.cacheHit) {
    notesList.push(
      '⚠️ 这份策略是**本地缓存**里的，不是本次现算的。缓存按「场景 + 求解器版本 + 求解设置」' +
        '完整分键，任何一项变化都不会命中旧结果。',
    );
  }
  if (Array.isArray(result.fingerprintLines) && result.fingerprintLines.length > 0) {
    notesList.push('可读指纹（用于人工核对）：\n' + result.fingerprintLines.join('\n'));
  }
  notes.innerHTML = notesList
    .map(function (note) {
      return '<div class="note mono">' + escapeHtml(note).replace(/\n/g, '<br />') + '</div>';
    })
    .join('');
}

function renderMatrix(baseline) {
  const range = baseline.range;
  const byHand = new Map();
  range.hands.forEach(function (hand) {
    byHand.set(hand.hand, hand);
  });

  const matrix = $('matrix');
  matrix.innerHTML = '';
  const top = $('matrixAxisTop');
  const left = $('matrixAxisLeft');
  top.innerHTML = '';
  left.innerHTML = '';
  RANKS.forEach(function (rank) {
    const cell = document.createElement('div');
    cell.textContent = rank;
    top.appendChild(cell);
    const rowLabel = document.createElement('div');
    rowLabel.textContent = rank;
    left.appendChild(rowLabel);
  });

  for (let row = 0; row < 13; row++) {
    for (let col = 0; col < 13; col++) {
      const hand = handCode(row, col);
      const entry = byHand.get(hand);
      const cell = document.createElement('button');
      cell.className = 'cell';
      cell.dataset.hand = hand;
      const label = document.createElement('span');
      label.className = 'hand';
      label.textContent = hand;
      cell.appendChild(label);
      const freqLine = document.createElement('span');
      freqLine.className = 'freq';
      freqLine.textContent = '';
      cell.appendChild(freqLine);

      if (entry === undefined) {
        // 求解器没给这一类 —— 明确显示未知，**不显示 0%**
        cell.classList.add('unreach');
        freqLine.textContent = '无数据';
      } else if (entry.actions.length === 0) {
        cell.classList.add('fold');
        freqLine.textContent = '—';
      } else {
        const top = entry.actions.reduce(function (best, action) {
          return best === null || action.frequency > best.frequency ? action : best;
        }, null);
        cell.classList.add(KIND_GROUP[top.kind] || 'fold');
        freqLine.textContent = fmtPercent(top.frequency, 0);
        cell.title =
          hand +
          '\n' +
          entry.actions
            .map(function (action) {
              return actionLabel(action) + '  ' + fmtPercent(action.frequency);
            })
            .join('\n');
        cell.addEventListener('click', function () {
          state.selectedHand = hand;
          renderDetail(entry, baseline);
          highlightSelected(hand);
        });
      }
      matrix.appendChild(cell);
    }
  }

  $('matrixLegend').innerHTML =
    '<span><span class="swatch" style="background:rgba(63,166,106,.42)"></span>主要动作＝加注/全下</span>' +
    '<span><span class="swatch" style="background:rgba(74,144,217,.34)"></span>主要动作＝跟注</span>' +
    '<span><span class="swatch" style="background:rgba(120,128,140,.18)"></span>主要动作＝弃牌</span>' +
    '<span><span class="swatch" style="background:repeating-linear-gradient(45deg,rgba(200,86,74,.22),rgba(200,86,74,.22) 3px,transparent 3px,transparent 6px)"></span>求解器未提供该类数据</span>' +
    '<span>格子里的百分比＝该手牌范围内占比最高的那个动作的频率（不是「推荐」）</span>';

  $('detailPanel').style.display = 'none';
}

function highlightSelected(hand) {
  const cells = $('matrix').querySelectorAll('.cell');
  cells.forEach(function (cell) {
    cell.classList.toggle('selected', cell.dataset.hand === hand);
  });
}

/** 显示坐标 → 手牌代号（与后端 169 矩阵同一套约定） */
function handCode(row, col) {
  const hi = Math.min(row, col);
  const lo = Math.max(row, col);
  if (row === col) return RANKS[row] + RANKS[col];
  return RANKS[hi] + RANKS[lo] + (col > row ? 's' : 'o');
}

/**
 * 手牌详情：**完整**混合策略。
 *
 * 🔴 这里刻意把**每一个非零频率**都列出来，而不是只显示最大的那个。
 * 混合策略本身就是 GTO 的输出；只显示一个动作等于伪造了一个纯策略。
 */
function renderDetail(hand, baseline) {
  $('detailPanel').style.display = '';
  const title = $('detailTitle');
  const body = $('detailBody');
  title.textContent = '手牌详情：' + hand.hand;

  const rows = hand.actions
    .slice()
    .sort(function (a, b) {
      return b.frequency - a.frequency;
    })
    .map(function (action) {
      const group = KIND_GROUP[action.kind] || 'fold';
      return (
        '<tr>' +
        '<td>' +
        escapeHtml(actionLabel(action)) +
        '</td>' +
        '<td><div class="bar ' +
        group +
        '"><span style="width:' +
        (action.frequency * 100).toFixed(2) +
        '%"></span></div></td>' +
        '<td class="mono">' +
        fmtPercent(action.frequency) +
        '</td>' +
        '<td class="mono">' +
        (action.evBB === null || action.evBB === undefined ? '—（求解器未提供）' : action.evBB.toFixed(4)) +
        '</td>' +
        '<td class="hint">' +
        escapeHtml(action.rawLabel) +
        '</td>' +
        '</tr>'
      );
    })
    .join('');

  body.innerHTML =
    '<div class="kv">' +
    '<dt>手牌类别</dt><dd>' +
    escapeHtml(hand.hand) +
    '</dd>' +
    '<dt>组合数</dt><dd>' +
    hand.combos +
    '</dd>' +
    '<dt>到达该节点的比例</dt><dd>' +
    (hand.reach === null ? '—（求解器未提供）' : fmtPercent(hand.reach, 2)) +
    '</dd>' +
    '<dt>动作菜单</dt><dd>' +
    escapeHtml(
      baseline.range.actionMenu
        .map(function (action) {
          return actionLabel(action);
        })
        .join(' / '),
    ) +
    '</dd>' +
    '</div>' +
    '<table style="margin-top:10px"><thead><tr>' +
    '<th>动作</th><th>频率</th><th></th><th>EV（BB/手）</th><th>求解器原始标签</th>' +
    '</tr></thead><tbody>' +
    rows +
    '</tbody></table>' +
    '<div class="hint" style="margin-top:8px">频率之和应为 100%。EV 一栏为空是**如实反映**：' +
    'GTOpen 的翻前节点接口不返回逐动作 EV，本项目不会替它编一个。</div>';
}

function renderMeta(baseline, result) {
  const meta = baseline.metadata;
  const settings = meta.solveSettings;
  const notes = (result.approximationNotes || []).slice();

  const statusZh =
    result.status === 'APPROXIMATE'
      ? '近似求解（APPROXIMATE）'
      : result.status === 'UNAVAILABLE'
        ? '不可用（UNAVAILABLE）'
        : result.status;

  $('metaBody').innerHTML =
    '<div class="kv">' +
    '<dt>状态</dt><dd>' +
    escapeHtml(statusZh) +
    '</dd>' +
    '<dt>可信度</dt><dd>' +
    escapeHtml(result.verificationZh || '—') +
    '</dd>' +
    '<dt>来源</dt><dd>' +
    escapeHtml(meta.source.engine) +
    '</dd>' +
    '<dt>引擎 commit</dt><dd class="mono">' +
    escapeHtml(meta.source.engineCommit || '未记录') +
    '</dd>' +
    '<dt>端点</dt><dd class="mono">' +
    escapeHtml(meta.source.endpoint || '—') +
    '</dd>' +
    '<dt>模型</dt><dd>' +
    escapeHtml(settings.modelName || '—') +
    '</dd>' +
    '<dt>迭代</dt><dd>' +
    String(settings.iterationsCompleted === null ? '—' : settings.iterationsCompleted) +
    '（请求 ' +
    String(settings.iterationsRequested === null ? '—' : settings.iterationsRequested) +
    '）</dd>' +
    '<dt>BR gap 之和</dt><dd class="mono">' +
    (settings.reportedGap === null ? '—（未测）' : settings.reportedGap.toFixed(8)) +
    '</dd>' +
    '<dt>场景哈希</dt><dd class="mono">' +
    escapeHtml(meta.scenarioHash) +
    '</dd>' +
    '<dt>结果时间</dt><dd>' +
    escapeHtml(meta.timestamp) +
    '</dd>' +
    '<dt>耗时</dt><dd>' +
    meta.latencyMs +
    ' ms</dd>' +
    '</div>' +
    '<h2 style="margin-top:14px">近似说明（逐条）</h2>' +
    notes
      .map(function (note) {
        return '<div class="note">' + escapeHtml(note) + '</div>';
      })
      .join('');

  $('limits').innerHTML =
    '<div class="note">本页只显示**翻牌前**范围。翻牌后不在本阶段范围内。</div>' +
    '<div class="note">所有结果都来自本地 GTOpen 求解器；求解器不可用时本页**不会**显示任何数据（不会用启发式先验冒充 GTO）。</div>' +
    '<div class="note">翻前使用近似延续模型，因此状态恒为「近似求解」，**永远不会**显示成「绝对 GTO」或「已验证」。</div>' +
    '<div class="note">EV 为空表示求解器没有提供，本项目不编造。</div>' +
    '<div class="note">本工具不联网、不读牌、不点击任何扑克客户端。</div>';
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ============================================================
 * 引擎状态
 * ============================================================ */

async function refreshEngineBadge() {
  const badge = $('engineBadge');
  try {
    const response = await fetch('/api/gto/health');
    const payload = await response.json();
    if (payload.enabled === false) {
      badge.textContent = '引擎：已关闭';
      badge.style.color = 'var(--warn)';
      return;
    }
    if (payload.health && payload.health.reachable) {
      badge.textContent = '引擎：GTOpen 在线';
      badge.style.color = 'var(--ok)';
    } else {
      badge.textContent = '引擎：GTOpen 不在线（Alpha 其他功能不受影响）';
      badge.style.color = 'var(--danger)';
    }
  } catch (error) {
    badge.textContent = '引擎：状态未知';
    badge.style.color = 'var(--danger)';
  }
}

/* ============================================================
 * 入口
 * ============================================================ */

$('loadBtn').addEventListener('click', loadRange);
$('toTable').addEventListener('click', function () {
  window.location.href = '/';
});

/*
 * 🔴 改了有效筹码 ⇒ 屏幕上已有的范围**立刻作废**（2026-09 修正轮）。
 *
 * 不这样做的话，用户把 100 改成 50 之后，屏幕上仍然显示着 100BB 的 13×13，
 * 而顶栏写着 50 —— 这正是「误导」最典型的形态（数据没说谎，是界面在说谎）。
 * 因此这里：清空结果 + 重新按新筹码取目录 + 明确提示需要重新读取。
 */
$('stackInput').addEventListener('change', function () {
  const stackBB = readStackBB();
  clearDisplayedRange();
  $('statusBanner').className = 'banner info';
  $('statusBanner').innerHTML =
    '<span class="tag">已切换筹码</span>有效筹码 = <b>' +
    stackBB +
    'BB</b>。请点击「读取 GTO 范围」获取该筹码下的策略' +
    '（不同筹码是不同的决策节点，不能沿用上一个筹码的结果）。';
  loadCatalog().catch(function (error) {
    $('statusBanner').className = 'banner bad';
    $('statusBanner').textContent = '按新筹码加载目录失败：' + String(error);
  });
});

/** 清空上一次查询的结果（矩阵 / 详情 / 来源面板），避免旧筹码的数据继续停留在屏幕上 */
function clearDisplayedRange() {
  state.response = null;
  state.selectedHand = null;
  $('matrix').innerHTML = '';
  $('matrixAxisTop').innerHTML = '';
  $('matrixAxisLeft').innerHTML = '';
  $('matrixLegend').innerHTML = '';
  $('detailPanel').style.display = 'none';
  $('scenarioLine').textContent = '';
}

loadCatalog().catch(function (error) {
  $('statusBanner').className = 'banner bad';
  $('statusBanner').textContent = '加载场景目录失败：' + String(error);
});
refreshEngineBadge();
