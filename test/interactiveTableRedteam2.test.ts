/**
 * 交互式牌桌 —— 独立红队**第二轮**发现的永久回归测试
 *
 * 对应报告：
 * - `reports/TABLE_INTERACTIVE_REDTEAM_LIFECYCLE.md`（RT-L5 …）
 * - `reports/TABLE_INTERACTIVE_REDTEAM_ADAPTER.md`（F-01 / F-02 / V27 / V-ALLIN / V-EFF / V-MAL / 载荷上限）
 *
 * ## 这一轮发现的共同点
 *
 * 全部都是「**屏幕与后端不一致**」：
 * - 屏幕把「展开按钮」当成动作 → 后端拒绝
 * - 屏幕上的「有效筹码」与引擎用的不是同一个数
 * - 分析与渲染共用一条代码路径，一行渲染残骸让整块面板不再更新
 * - 后端改了分组名，前端没跟上 → 合法动作从界面上消失
 *
 * 因此这里的断言大多落在「两个来源必须一致」上，而不是单点行为。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { Position } from '../src/domain/types.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { createTable, seatOfPosition, staffingProblems } from '../src/app/table/tableState.ts';
import { applyTableOp } from '../src/app/table/tableOps.ts';
import { buildTablePreview } from '../src/app/table/tablePreview.ts';
import { tableStateToManualHandInput } from '../src/app/table/tableAdapter.ts';
import { parseTableState } from '../src/app/table/tableApi.ts';
import { startAlphaServer } from '../src/app/webServer.ts';
import { SeatStatus, type PokerTableState } from '../src/app/table/table.types.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const OPTIONS = { rules: RULES, asOf: 1_757_000_000_000, writeLog: false } as const;

const ORDER_6: readonly Position[] = [
  Position.UTG,
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

function fullTable(hero: Position, stackBB = 100): PokerTableState {
  let state = createTable({ tableSize: 6, heroPosition: hero, defaultStackBB: stackBB });
  for (const position of ORDER_6) {
    if (position === hero) continue;
    state = must(
      applyTableOp(state, { kind: 'ADD_PLAYER', seatId: seatOfPosition(state, position)!.seatId }),
    );
  }
  return state;
}

const tableJs = (): string =>
  readFileSync(
    join(fileURLToPath(new URL('..', import.meta.url)), 'src', 'app', 'web', 'table.js'),
    'utf8',
  );

/* ============================================================
 * F-01（CRITICAL）：渲染残骸让整块面板不再更新
 * ============================================================ */

/**
 * 去掉注释后的**可执行代码**。
 *
 * ⚠️ 必须去注释：F-01 的修复把出错的那一行原样写进注释里当说明，
 * 直接对全文做正则会把注释也当成代码（自己抓自己）。
 */
function tableJsCode(): string {
  return tableJs()
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

test('F-01（CRITICAL）：`table.js` 不得出现 `appendChild(自身)` 这类自毁语句', () => {
  const js = tableJsCode();

  /**
   * 修复前这里有：
   *   `box.appendChild(el('div', null, a.viewModel.actionZh).id ? box : box);`
   * 三元两边都是 `box` → 实际执行 `box.appendChild(box)` →
   * 真实 DOM 抛 `HierarchyRequestError`。
   *
   * 后果远不止「建议不显示」：抛错点在 `renderActorPanel()` 里，
   * 于是同一次 render 的后半段（时间线 / 调试面板 / 弹层 / 按钮可用性）
   * **全部被跳过**；而 `app.analysis` 一旦被设置就不会自动清空，
   * 此后每一次 render 都在同一行抛错，界面进入「半冻结」——
   * 连 §8 要求的离桌选择弹层都打不开。
   */
  assert.ok(
    !/\.id\s*\?\s*box\s*:\s*box/.test(js),
    'table.js 不得出现「三元两边相同」的残骸语句（那会导致 appendChild(自身)）',
  );

  // 更一般地：任何 `X.appendChild(X)` 都不允许出现
  const selfAppend = /(\w+)\.appendChild\(\s*\1\s*\)/.exec(js);
  assert.equal(
    selfAppend,
    null,
    `table.js 不得把节点 append 到自身：${selfAppend?.[0] ?? ''}`,
  );

  // 「建议」必须真的被写进结果面板
  assert.ok(
    js.includes("action.id = 'resultAction'") && js.includes('box.appendChild(action)'),
    '结果面板必须真的有 appendChild(action)',
  );
});

test('F-01（CRITICAL）：分析成功之后，渲染函数必须**跑到底**（不得半途抛错）', () => {
  /**
   * 这里用一个**极简 DOM 桩**真实执行 `table.js` 里的渲染路径。
   *
   * 桩的重点：`appendChild` 会在「新子节点包含父节点」时抛错 ——
   * 这正是浏览器 `HierarchyRequestError` 的判据，也正是 F-01 的成因。
   * 没有这个判据，桩会静默接受自环，测试就抓不到这类 Bug。
   */
  const errors: string[] = [];
  type StubNode = {
    tagName: string;
    children: StubNode[];
    parentNode: StubNode | null;
    className: string;
    textContent: string;
    innerHTML: string;
    id: string;
    style: Record<string, string>;
    dataset: Record<string, string>;
    disabled: boolean;
    title: string;
    value: string;
    min: string;
    step: string;
    type: string;
    firstChild: StubNode | undefined;
    options: StubNode[];
    appendChild(child: StubNode): StubNode;
    removeChild(child: StubNode): void;
    querySelectorAll(selector: string): StubNode[];
    setAttribute(): void;
    addEventListener(): void;
  };

  /**
   * 极简 DOM 桩。
   *
   * ## 两个刻意实现的判据
   *
   * 1. **层级检查**：`appendChild` 在「新子节点包含父节点」时抛错 ——
   *    这正是浏览器 `HierarchyRequestError` 的判据，也是 F-01 的成因。
   *    没有它，桩会静默接受自环，测试就抓不到这类 Bug。
   * 2. **`select.appendChild(option)` 同时进入 `options`**：真实 DOM 的行为。
   *    客户端会用 `select.options.length === 0` 判断「还没初始化」——
   *    少了这一条，`renderTopbar` 会在第一次渲染就抛错，
   *    整个桩测试就变成在测一个假环境。
   */
  const makeNode = (tagName: string): StubNode => {
    const node = {
      tagName,
      children: [] as StubNode[],
      parentNode: null as StubNode | null,
      className: '',
      textContent: '',
      innerHTML: '',
      id: '',
      style: {} as Record<string, string>,
      dataset: {} as Record<string, string>,
      disabled: false,
      title: '',
      value: '',
      min: '',
      step: '',
      type: '',
      options: [] as StubNode[],
      get firstChild(): StubNode | undefined {
        return node.children[0];
      },
      appendChild(child: StubNode): StubNode {
        // ---- 浏览器的层级检查（F-01 的判据）----
        let cursor: StubNode | null = node as unknown as StubNode;
        while (cursor !== null) {
          if (cursor === child) {
            throw new Error('HierarchyRequestError: The new child element contains the parent.');
          }
          cursor = cursor.parentNode;
        }
        if (child.parentNode !== null) child.parentNode.removeChild(child);
        child.parentNode = node as unknown as StubNode;
        node.children.push(child);
        // 真实 DOM：option 同时进入 select.options
        if (tagName === 'select' && child.tagName === 'option') node.options.push(child);
        return child;
      },
      removeChild(child: StubNode): void {
        const index = node.children.indexOf(child);
        if (index >= 0) node.children.splice(index, 1);
        const optionIndex = node.options.indexOf(child);
        if (optionIndex >= 0) node.options.splice(optionIndex, 1);
        child.parentNode = null;
      },
      querySelectorAll(selector: string): StubNode[] {
        const wanted = selector.replace(/^button\./, '');
        const out: StubNode[] = [];
        const walk = (n: StubNode): void => {
          for (const c of n.children) {
            if (c.tagName === 'button' && c.className.split(/\s+/).includes(wanted)) out.push(c);
            walk(c);
          }
        };
        walk(node as unknown as StubNode);
        return out;
      },
      setAttribute(): void {
        /* 桩：不需要 */
      },
      addEventListener(): void {
        /* 桩：不需要 */
      },
    };
    return node as unknown as StubNode;
  };

  const ids = [
    'topbar', 'tableSizeButtons', 'heroPositionButtons', 'environmentSelect',
    'nextHandBtn', 'resetHandBtn', 'undoBtn', 'newTableBtn', 'clearVillainsBtn',
    /* `fillSeatsBtn` = 「一键加入玩家」（2026-09 新增）；漏了它 renderTopbar 会抛错 */
    'fillSeatsBtn',
    'saveHint', 'notices', 'tableWrap', 'tableCenter', 'potLine', 'streetLine',
    'boardRow', 'seats', 'handPanel', 'heroHandRow', 'handHint', 'cardPicker',
    'pickerTarget', 'pickerGrid', 'timeline', 'actorLine', 'statGrid',
    'actionButtons', 'sizeButtons', 'analyzeBtn', 'blockers', 'result', 'limits',
    /* LIVE UI V2：右栏「本手最近动作」（`renderRecentActions()` 用 `$()` 取） */
    'recentActions',
    /* LIVE UI V2：顶栏设置菜单（用 `getElementById` 取，见 harness 里的说明） */
    'moreBtn', 'moreMenu',
    'debugSeats', 'debugMath', 'debugInput', 'debugFingerprint', 'debugDecision',
    'overlay', 'modal', 'toast',
  ];
  const registry = new Map<string, StubNode>();
  for (const id of ids) registry.set(id, makeNode('div'));
  const documentStub = {
    readyState: 'complete',
    getElementById: (id: string) => registry.get(id) ?? null,
    createElement: (tag: string) => makeNode(tag),
    querySelectorAll: () => [] as StubNode[],
    addEventListener: () => undefined,
  };

  const pending: Promise<unknown>[] = [];
  const windowStub = {
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    addEventListener: () => undefined,
  };

  const fetchStub = (url: string, init?: { body?: string }): Promise<unknown> => {
    const body = init && init.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    const respond = (payload: unknown) => ({
      json: () => Promise.resolve(payload),
      text: () => Promise.resolve(JSON.stringify(payload)),
      status: 200,
    });
    if (url.endsWith('/api/table/meta')) {
      return Promise.resolve(
        respond({
          ok: true,
          meta: {
            positions: [{ value: 'CO', labelZh: '关煞位' }],
            tableSizes: [{ value: 6, labelZh: '6 人桌', positions: ORDER_6 }],
            seatStatuses: [],
            occupiedStatuses: [],
            quickProfiles: [{ value: 'UNKNOWN', labelZh: '未知' }],
            dynamicHints: [{ value: 'UNKNOWN', labelZh: '未知' }],
            environments: [{ value: 'MID_LOW_STAKES', labelZh: '中低级别' }],
            actionTypes: [],
            streets: [],
            leaveChoices: [
              { value: 'FOLD_AND_LEAVE', labelZh: '本手视为弃牌并离桌' },
              { value: 'LEAVE_AFTER_HAND', labelZh: '仅标记手后离桌' },
              { value: 'CANCEL', labelZh: '取消' },
            ],
          },
        }),
      );
    }
    if (url.endsWith('/api/table')) {
      // 返回一个真实的牌桌状态 + 预览（由真后端算出来）
      const state = (body['state'] as PokerTableState | undefined) ?? null;
      const table = state ?? fullTable(Position.CO);
      const preview = buildTablePreview(table);
      return Promise.resolve(respond({ ok: true, created: state === null, state: table, preview }));
    }
    if (url.endsWith('/api/analyze')) {
      const table = body['table'] as PokerTableState;
      const adapted = tableStateToManualHandInput(table);
      if (!adapted.ok) {
        return Promise.resolve(respond({ ok: false, stage: 'REQUEST', issues: adapted.issues }));
      }
      const result = analyzeManualHand(adapted.input, OPTIONS);
      return Promise.resolve(respond(result.ok ? result : { ok: false, stage: result.stage, issues: result.issues }));
    }
    return Promise.resolve(respond({ ok: false }));
  };

  const source = tableJs();
  const run = new Function('document', 'window', 'fetch', 'console', 'performance', source);

  const errorsBefore = errors.length;
  run(documentStub, windowStub, fetchStub, { error: (m: unknown) => errors.push(String(m)) }, { now: () => 0 });

  // 让 boot() 里的 Promise 链跑完，然后**真的点一次「分析当前决策」** ——
  // F-01 的症状正是「分析成功之后结果面板仍然是空的」。
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      void pending;
      const analyzeBtn = registry.get('analyzeBtn')!;
      assert.equal(
        typeof (analyzeBtn as unknown as { onclick?: unknown }).onclick,
        'function',
        '必须绑定了「分析」按钮的处理函数',
      );
      (analyzeBtn as unknown as { onclick: () => void }).onclick();

      setTimeout(() => {
        assert.equal(
          errors.length,
          errorsBefore,
          `渲染与分析的整个过程都不得抛错：${errors.join(' | ')}`,
        );
        // 关键：分析之后结果面板必须真的有内容（修复前因为 appendChild(自身) 抛错而为空）
        const result = registry.get('result')!;
        assert.ok(
          result.children.length > 0,
          '分析之后结果面板必须有内容（修复前因为 appendChild(自身) 抛错而为空）',
        );
        // 而且不能是一个自我包含的环
        for (const child of result.children) {
          assert.notEqual(child, result, '结果面板不得被 append 到自身');
        }
        // 后半段渲染也必须跑完：时间线 / 调试面板都要有内容
        assert.ok(
          registry.get('debugSeats')!.textContent.length > 0,
          '调试面板必须被更新（修复前 render 在结果面板处就抛错，后半段全部跳过）',
        );
        resolve();
      }, 60);
    }, 60);
  });
});

/* ============================================================
 * F-02（CRITICAL）：前端必须认全后端的按钮分组
 * ============================================================ */

test('F-02（CRITICAL）：前端的按钮分组必须与后端契约一致（EXPAND 不得被丢弃）', () => {
  const js = tableJs();
  assert.ok(js.includes("b.group === 'EXPAND'"), '前端必须识别 EXPAND 组（展开按钮）');
  assert.ok(js.includes("b.group === 'PRIMARY'"), '前端必须识别 PRIMARY 组');
  assert.ok(js.includes("b.group === 'SIZE'"), '前端必须识别 SIZE 组');

  // 后端确实会产出 EXPAND
  let state = fullTable(Position.CO);
  state = must(applyTableOp(state, { kind: 'SET_HERO_CARD', card: 'As' }));
  state = must(applyTableOp(state, { kind: 'SET_HERO_CARD', card: 'Kd' }));
  state = must(applyTableOp(state, { kind: 'ACT', action: { type: 'FOLD' } }));
  state = must(applyTableOp(state, { kind: 'ACT', action: { type: 'FOLD' } }));
  const preview = buildTablePreview(state);
  assert.equal(preview.isHeroTurn, true, '应当轮到 Hero');

  const groups = new Set(preview.actionButtons.map((b) => b.group));
  assert.ok(groups.has('EXPAND'), 'Hero 可以下注/加注时，预览必须给出 EXPAND 按钮');
  assert.ok(groups.has('SIZE'), '必须给出具体尺寸');
  assert.ok(
    preview.actionButtons.some((b) => b.type === 'BET' || b.type === 'RAISE'),
    '下注/加注必须出现在按钮集合里（修复前前端会把它整条丢掉）',
  );
});

/* ============================================================
 * V27 / V-ALLIN：可执行按钮必须**全部**被后端接受
 * ============================================================ */

test('V27：预览里每一个可执行按钮（PRIMARY / SIZE）都必须被后端接受', () => {
  /**
   * 契约（见 `TableActionButton` 的文档）：
   * - `PRIMARY` / `SIZE` 一定是合法动作 —— 点下去后端必须接受
   * - `EXPAND` 不是动作，只用来展开尺寸行
   *
   * 修复前 BET/RAISE 的「（选尺寸）」按钮混在 `PRIMARY` 里，
   * 于是「预览给出的按钮」与「后端接受的动作」不是同一个集合。
   */
  const state0 = fullTable(Position.CO);
  const withCards = must(
    applyTableOp(must(applyTableOp(state0, { kind: 'SET_HERO_CARD', card: 'As' })), {
      kind: 'SET_HERO_CARD',
      card: 'Kd',
    }),
  );

  let tried = 0;
  const rejected: string[] = [];

  /** 深度优先：从每个状态出发，把每个可执行按钮都点一遍 */
  const walk = (state: PokerTableState, depth: number): void => {
    if (depth > 6) return;
    const preview = buildTablePreview(state);
    for (const button of preview.actionButtons) {
      if (button.group === 'EXPAND') continue;
      tried += 1;
      const result = applyTableOp(state, {
        kind: 'ACT',
        action: {
          type: button.type,
          ...(button.amountChips !== undefined ? { amountChips: button.amountChips } : {}),
        },
      });
      if (!result.ok) {
        rejected.push(`${button.labelZh} → ${result.issues[0]!.code}：${result.issues[0]!.message}`);
        continue;
      }
      // 只沿着部分分支继续，避免组合爆炸
      if (button.group === 'PRIMARY') walk(result.state, depth + 1);
    }
  };

  walk(withCards, 0);
  assert.ok(tried > 20, `必须真的试过一批按钮（实际 ${tried}）`);
  assert.deepEqual(rejected, [], `可执行按钮不得被后端拒绝：\n${rejected.join('\n')}`);
});

test('V-ALLIN：全下按钮不得携带金额（引擎只接受「本次投入的剩余筹码」）', () => {
  const state = fullTable(Position.CO, 37);
  const withCards = must(
    applyTableOp(must(applyTableOp(state, { kind: 'SET_HERO_CARD', card: 'As' })), {
      kind: 'SET_HERO_CARD',
      card: 'Kd',
    }),
  );
  const preview = buildTablePreview(withCards);
  const allIn = preview.actionButtons.find((b) => b.type === 'ALL_IN');
  assert.ok(allIn !== undefined, '必须给出全下按钮');

  assert.equal(
    allIn!.amountChips,
    undefined,
    'ALL_IN 按钮不得带 amountChips —— 带本街总额会被 ALLIN_AMOUNT_MISMATCH 拒绝',
  );
  assert.ok(allIn!.amountBB !== undefined, '但必须给出金额用于展示');

  // 真实点一次：必须成功
  const clicked = applyTableOp(withCards, { kind: 'ACT', action: { type: 'ALL_IN' } });
  assert.equal(clicked.ok, true, `全下必须成功：${clicked.ok ? '' : JSON.stringify(clicked.issues)}`);
  if (!clicked.ok) return;
  const recorded = clicked.state.actionHistory[clicked.state.actionHistory.length - 1]!;
  assert.equal(recorded.type, 'ALL_IN');
  assert.equal(recorded.amountBB, undefined, 'ALL_IN 不得记录金额');
});

/* ============================================================
 * V-EFF：屏幕上的「有效筹码」必须等于引擎用的那个数
 * ============================================================ */

test('V-EFF：预览的 effectiveStackBB 必须等于决策引擎的 effectiveStack', () => {
  /**
   * 修复前预览自己算「所有还能下注的玩家里最小的剩余筹码」，
   * 而 `contextBuilder` 用 `effectiveStackBetween(hero, 首要对手)`。
   * 两者会给出**不同的数字**，而界面与调试区都叫它「有效筹码」。
   */
  const run = (hero: Position, stacks: Partial<Record<Position, number>>): void => {
    let state = fullTable(hero, 100);
    for (const [position, stackBB] of Object.entries(stacks)) {
      state = must(
        applyTableOp(state, {
          kind: 'SET_STACK',
          seatId: seatOfPosition(state, position as Position)!.seatId,
          stackBB: stackBB!,
        }),
      );
    }
    state = must(applyTableOp(state, { kind: 'SET_HERO_CARD', card: 'As' }));
    state = must(applyTableOp(state, { kind: 'SET_HERO_CARD', card: 'Kd' }));

    /*
     * 构造一个**一定**轮到 Hero 的决策点：
     * 第一个行动的人（UTG）加注，其余人弃牌直到 Hero。
     *
     * ⚠️ 不能让所有人都弃牌 —— 那样本手直接结束（大盲不战而胜），
     *    根本没有决策点，`analyzeManualHand` 会如实拒绝。
     */
    state = must(applyTableOp(state, { kind: 'ACT', action: { type: 'RAISE', amountChips: 200 } }));
    let guard = 0;
    while (guard < 10) {
      const p = buildTablePreview(state);
      if (p.isHeroTurn || p.handComplete || p.currentActorPosition === null) break;
      state = must(applyTableOp(state, { kind: 'ACT', action: { type: 'FOLD' } }));
      guard += 1;
    }
    const preview = buildTablePreview(state);
    assert.equal(preview.isHeroTurn, true, `Hero=${hero} 时应当轮到他（当前 ${String(preview.currentActorPosition)}）`);
    const adapted = tableStateToManualHandInput(state);
    assert.equal(adapted.ok, true);
    if (!adapted.ok) return;
    const analyzed = analyzeManualHand(adapted.input, OPTIONS);
    assert.equal(analyzed.ok, true, `应当能分析：${analyzed.ok ? '' : JSON.stringify(analyzed.issues)}`);
    if (!analyzed.ok) return;

    assert.equal(
      preview.effectiveStackBB,
      analyzed.decision.diagnostics.math.effectiveStack / 100,
      `Hero=${hero} 筹码=${JSON.stringify(stacks)}：` +
        `屏幕上的有效筹码（${preview.effectiveStackBB}BB）必须等于引擎实际使用的` +
        `（${analyzed.decision.diagnostics.math.effectiveStack / 100}BB）`,
    );
  };

  run(Position.BB, {});
  run(Position.BB, { [Position.UTG]: 19 });
  run(Position.SB, { [Position.CO]: 40, [Position.BB]: 200 });
  run(Position.BB, { [Position.UTG]: 250 });
  run(Position.SB, { [Position.BB]: 19 });
});

/* ============================================================
 * RT-L5：座位属性不得被下一个坐进来的人继承
 * ============================================================ */

test('RT-L5（MAJOR）：`sitOutNextHand` 是**玩家**的意图，不得留在空座位上被继承', () => {
  let state = fullTable(Position.CO);
  state = must(applyTableOp(state, { kind: 'SET_HERO_CARD', card: 'As' }));
  state = must(applyTableOp(state, { kind: 'SET_HERO_CARD', card: 'Kd' }));

  const utgSeatId = seatOfPosition(state, Position.UTG)!.seatId;
  // 1) 本手进行中标「下一手暂离」
  state = must(applyTableOp(state, { kind: 'SIT_OUT', seatId: utgSeatId }));
  assert.equal(seatOfPosition(state, Position.UTG)!.sitOutNextHand, true);

  // 2) 重置本手（handActive → false，但标记仍在）
  state = must(applyTableOp(state, { kind: 'RESET_HAND' }));
  assert.equal(state.handActive, false);

  // 3) 清空座位：**必须把标记一起清掉**
  state = must(applyTableOp(state, { kind: 'CLEAR_SEAT', seatId: utgSeatId }));
  const emptySeat = seatOfPosition(state, Position.UTG)!;
  assert.equal(emptySeat.playerId, null);
  assert.equal(
    emptySeat.sitOutNextHand,
    false,
    '空座位不得挂着「下一手暂离」—— 那会被下一个坐进来的人继承',
  );

  // 4) 新玩家坐进来：他从未点过暂离
  state = must(applyTableOp(state, { kind: 'ADD_PLAYER', seatId: utgSeatId }));
  assert.equal(
    seatOfPosition(state, Position.UTG)!.sitOutNextHand,
    false,
    '新玩家不得继承上一位玩家的暂离意图',
  );

  // 5) 下一手：他必须正常参与
  state = must(applyTableOp(state, { kind: 'NEXT_HAND' }));
  assert.equal(
    seatOfPosition(state, Position.UTG)!.status,
    SeatStatus.SEATED_ACTIVE,
    '新玩家下一手必须正常在座（修复前会变成 SITTING_OUT，整张牌桌无法分析）',
  );
  assert.equal(staffingProblems(state).length, 0, '不得出现任何人员阻塞');
});

test('RT-L5：`CLEAR_ALL_VILLAINS` 也必须清掉座位上的暂离标记', () => {
  let state = fullTable(Position.CO);
  state = must(applyTableOp(state, { kind: 'SET_HERO_CARD', card: 'As' }));
  state = must(applyTableOp(state, { kind: 'SET_HERO_CARD', card: 'Kd' }));
  const seatId = seatOfPosition(state, Position.UTG)!.seatId;
  state = must(applyTableOp(state, { kind: 'SIT_OUT', seatId }));
  state = must(applyTableOp(state, { kind: 'RESET_HAND' }));
  state = must(applyTableOp(state, { kind: 'CLEAR_ALL_VILLAINS' }));

  for (const seat of state.seats) {
    if (seat.logicalPosition === Position.CO) continue;
    assert.equal(seat.playerId, null, '非 Hero 座位必须清空');
    assert.equal(seat.sitOutNextHand, false, `${seat.logicalPosition} 不得残留暂离标记`);
  }
});

test('RT-L5：`parseTableState` 必须拒绝「空座位带暂离标记」与「非布尔标记」', () => {
  const base = fullTable(Position.CO);

  const withEmptyFlag = {
    ...base,
    seats: base.seats.map((s) =>
      s.logicalPosition === Position.UTG
        ? { ...s, playerId: null, status: SeatStatus.EMPTY, sitOutNextHand: true }
        : s,
    ),
  };
  const a = parseTableState(withEmptyFlag);
  assert.equal(a.ok, false, '空座位带暂离标记必须被拒绝');
  if (!a.ok) {
    assert.ok(
      a.issues.some((i) => i.message.includes('继承')),
      `原因必须说清「会被继承」：${a.issues.map((i) => i.message).join('；')}`,
    );
  }

  const nonBoolean = {
    ...base,
    seats: base.seats.map((s) => (s.logicalPosition === Position.UTG ? { ...s, sitOutNextHand: 'yes' } : s)),
  };
  assert.equal(parseTableState(nonBoolean).ok, false, 'sitOutNextHand 非布尔必须被拒绝');
});

/* ============================================================
 * 视觉旋转：整体校验，而不只是 Hero 那一格
 * ============================================================ */

test('RT-L5 附带：整体旋转（无重复序号）也必须被拒绝', () => {
  const base = fullTable(Position.CO);
  // 整体 +1：没有重复，但 Hero 不再是 0 号位 —— 屏幕上的座位顺序与逻辑不符
  const rotated = {
    ...base,
    seats: base.seats.map((s) => ({ ...s, visualIndex: (s.visualIndex + 1) % base.seats.length })),
  };
  const parsed = parseTableState(rotated);
  assert.equal(parsed.ok, false, '整体旋转过的视觉序号必须被拒绝');
  if (!parsed.ok) {
    assert.ok(
      parsed.issues.some((i) => i.message.includes('视觉序号')),
      `原因必须指出视觉序号：${parsed.issues.map((i) => i.message).join('；')}`,
    );
  }

  // 交换两个非 Hero 座位（会产生重复序号）同样必须被拒绝
  const swapped = {
    ...base,
    seats: base.seats.map((s) => {
      if (s.logicalPosition === Position.UTG) return { ...s, visualIndex: 1 };
      if (s.logicalPosition === Position.HJ) return { ...s, visualIndex: 0 };
      return s;
    }),
  };
  const swappedParsed = parseTableState(swapped);
  assert.equal(swappedParsed.ok, false, '交换两个座位的视觉序号必须被拒绝');
  if (!swappedParsed.ok) {
    assert.ok(
      swappedParsed.issues.some((i) => i.message.includes('visualIndex') || i.message.includes('视觉序号')),
      `原因必须指出视觉序号问题：${swappedParsed.issues.map((i) => i.message).join('；')}`,
    );
  }
});

/* ============================================================
 * V-MAL / 载荷上限：畸形载荷与超大载荷都必须是**可读的结构化失败**
 * ============================================================ */

test('V-MAL：畸形请求体必须返回结构化失败，不得 5xx', async () => {
  const server = await startAlphaServer({ port: 0, rules: RULES, logPath: null });
  try {
    const payloads: readonly unknown[] = [
      null,
      42,
      'string',
      [],
      {},
      { table: null },
      { table: 42 },
      { table: [] },
      { table: { seats: [] } },
      { state: null, op: {} },
      { state: {}, op: { kind: 'ACT' } },
      { state: {}, op: { kind: 'ACT', action: null } },
      { state: {}, op: { kind: 'ACT', action: { type: 'TELEPORT' } } },
      { state: {}, op: { kind: 'ACT', action: { type: 'ALL_IN', amountChips: 'x' } } },
      { state: {}, op: { kind: '__proto__' } },
    ];
    for (const [index, payload] of payloads.entries()) {
      for (const path of ['/api/table', '/api/analyze']) {
        const res = await fetch(`${server.url}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        assert.ok(
          res.status < 500,
          `载荷 #${index} 打到 ${path} 时不得 5xx（实际 ${res.status}）`,
        );
        const text = await res.text();
        assert.ok(text.startsWith('{'), `载荷 #${index} @ ${path} 必须返回 JSON`);
      }
    }
  } finally {
    await server.close();
  }
});

test('载荷上限：超大请求体必须是可读的 413，而不是让客户端看到 fetch failed', async () => {
  /**
   * 红队命中：客户端自持状态 + 撤销栈会接近上限，
   * 而修复前 `req.destroy()` 让浏览器只看到 `fetch failed`，
   * 且客户端会一直重发同一个超限状态，只能刷新页面（等于丢桌）。
   */
  const server = await startAlphaServer({ port: 0, rules: RULES, logPath: null });
  try {
    const huge = { padding: 'x'.repeat(2 * 1024 * 1024) };
    const res = await fetch(`${server.url}/api/table`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(huge),
    });
    assert.equal(res.status, 413, '超大请求体必须返回 413');
    const payload = (await res.json()) as { ok: boolean; issues: readonly { code: string; message: string }[] };
    assert.equal(payload.ok, false);
    assert.equal(payload.issues[0]!.code, 'BODY_TOO_LARGE');
    assert.ok(
      payload.issues[0]!.message.includes('刷新'),
      `必须告诉使用者怎么恢复：${payload.issues[0]!.message}`,
    );
  } finally {
    await server.close();
  }
});

test('载荷上限：正常的一手牌（含撤销栈）必须远低于上限', () => {
  /**
   * 用真实的一手牌测量：把每个中间状态的 JSON 长度都记下来，
   * 断言最大值远低于服务端上限（1MB）。
   */
  let state = fullTable(Position.CO);
  state = must(applyTableOp(state, { kind: 'SET_HERO_CARD', card: 'As' }));
  state = must(applyTableOp(state, { kind: 'SET_HERO_CARD', card: 'Kd' }));

  const sequence: readonly { type: string }[] = [
    { type: 'FOLD' },
    { type: 'FOLD' },
    { type: 'RAISE' },
    { type: 'FOLD' },
    { type: 'FOLD' },
    { type: 'CALL' },
  ];
  let maxBytes = 0;
  for (const step of sequence) {
    const preview = buildTablePreview(state);
    const sizes = preview.actionButtons.filter((b) => b.type === step.type && b.group === 'SIZE');
    const button = sizes[0] ?? preview.actionButtons.find((b) => b.type === step.type);
    if (button === undefined) break;
    state = must(
      applyTableOp(state, {
        kind: 'ACT',
        action: {
          type: button.type,
          ...(button.amountChips !== undefined ? { amountChips: button.amountChips } : {}),
        },
      }),
    );
    maxBytes = Math.max(maxBytes, Buffer.byteLength(JSON.stringify({ state, op: {} }), 'utf8'));
  }

  assert.ok(maxBytes > 0, '必须真的测到状态');
  assert.ok(
    maxBytes < 256 * 1024,
    `一手牌（含撤销栈）的请求体不该超过 256KB（实际 ${Math.round(maxBytes / 1024)}KB）—— ` +
      '否则使用者会在录入过程中撞上上限并丢桌',
  );
});
