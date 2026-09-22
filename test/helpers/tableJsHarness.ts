/**
 * 真实 `table.js` 的执行 harness。
 *
 * ## 只放四件**通用**的事
 *
 * 1. **DOM 桩** —— 让 `src/app/web/table.js` 这个无构建步骤的浏览器脚本
 *    能在 Node 里真实执行（含 `appendChild` 的层级检查，见 F-01）。
 * 2. **可控 fake timer** —— schedule / cancel / inspect pending / deterministic fire。
 * 3. **fetch 桩** —— 一个**真后端语义**的 `/api/table`、`/api/table/meta`、
 *    `/api/analyze`：`/api/table` 用真实的 `applyTableOp` 应用操作，
 *    预览用真实的 `buildTablePreview` 计算。
 * 4. **bootstrap** —— 读源码、`new Function` 执行、`boot()` 的 Promise 链收敛。
 *
 * ## 🚫 这里**不放**业务判断
 *
 * 本文件**不知道** `CURRENT_DECISION` / `HISTORY_ENTRY` 的存在，也不知道
 * 「什么状态该自动分析」。断言必须写在测试文件里、直接观察真实 `table.js`
 * 的行为 —— 否则就会退化成「再实现一遍模型」。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { createTable, seatOfPosition } from '../../src/app/table/tableState.ts';
import { applyTableOp } from '../../src/app/table/tableOps.ts';
import { buildTablePreview } from '../../src/app/table/tablePreview.ts';
import { positionMainLabel } from '../../src/i18n/index.ts';
import type { PokerTableState, TablePreview } from '../../src/app/table/table.types.ts';

/* ============================================================
 * DOM 桩
 * ============================================================ */

export type StubNode = {
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
  options: StubNode[];
  firstChild: StubNode | undefined;
  onclick: (() => void) | undefined;
  appendChild(child: StubNode): StubNode;
  removeChild(child: StubNode): void;
  querySelectorAll(selector: string): StubNode[];
  setAttribute(): void;
  addEventListener(): void;
};

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
    onclick: undefined as (() => void) | undefined,
    get firstChild(): StubNode | undefined {
      return node.children[0];
    },
    appendChild(child: StubNode): StubNode {
      // 浏览器的层级检查 —— 没有它，F-01 那类自环会被静默接受
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
      const i = node.children.indexOf(child);
      if (i >= 0) node.children.splice(i, 1);
      const j = node.options.indexOf(child);
      if (j >= 0) node.options.splice(j, 1);
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

/** `table.js` 会去 `$()` 的全部 id（含 `renderXxx` 里的 `if (!node) return` 保护项） */
const ELEMENT_IDS: readonly string[] = [
  'topbar', 'tableSizeButtons', 'heroPositionButtons', 'environmentSelect',
  'nextHandBtn', 'resetHandBtn', 'undoBtn', 'newTableBtn', 'clearVillainsBtn',
  /* `fillSeatsBtn` = 「一键加入玩家」（2026-09 新增；漏了它会让 $() 返回 null） */
  'fillSeatsBtn',
  'saveHint', 'notices', 'tableWrap', 'tableCenter', 'potLine', 'streetLine',
  'boardRow', 'seats', 'handPanel', 'heroHandRow', 'handHint', 'cardPicker',
  'pickerTarget', 'pickerGrid', 'timeline', 'actorLine', 'statGrid',
  'actionButtons', 'sizeButtons', 'analyzeBtn', 'blockers', 'result', 'limits',
  /* LIVE UI V2：右栏「本手最近动作」（`renderRecentActions()` 用 `$()` 取） */
  'recentActions',
  /*
   * LIVE UI V2：顶栏「设置 ▾」菜单。`table.js` 用 `getElementById` 取它们，
   * 取不到就静默跳过（假 DOM 里没有 `addEventListener`，绑不上事件）——
   * 因此它们**不是**必须项，但登记之后「控件是否被卡在 disabled」这类断言
   * 才有地方可测（真实缺陷：重叠请求会把按钮永久禁用）。
   */
  'moreBtn', 'moreMenu',
  /* V3：完整时间线的 <details>（enderTimeline() 用它找 <summary> 写条数） */
  'timelinePanel', 'timelineSummary',
  'debugSeats', 'debugMath', 'debugInput', 'debugFingerprint', 'debugDecision',
  'overlay', 'modal', 'toast',
  'autoAnalyzeLine', 'autoAnalyzeBadge', 'modeButtons',
];

/* ============================================================
 * 可控 fake timer
 * ============================================================ */

export type PendingTimer = { id: number; ms: number };

export class FakeTimers {
  private nextId = 1;
  private readonly live = new Map<number, { id: number; ms: number; fn: () => void }>();
  private readonly cancelled = new Set<number>();

  readonly setTimeout = (fn: () => void, ms?: number): number => {
    const id = this.nextId;
    this.nextId += 1;
    this.live.set(id, { id, ms: ms ?? 0, fn });
    return id;
  };

  readonly clearTimeout = (id?: number): void => {
    if (id === undefined) return;
    if (this.live.delete(id)) this.cancelled.add(id);
  };

  /** inspect：当前尚未到点、也未被取消的 timer */
  get pending(): readonly PendingTimer[] {
    return [...this.live.values()].map((t) => ({ id: t.id, ms: t.ms }));
  }

  get pendingCount(): number {
    return this.live.size;
  }

  /** 被 `clearTimeout` 取消过的 timer id（含已取消后又被重新排程的旧 id） */
  get cancelledIds(): readonly number[] {
    return [...this.cancelled];
  }

  isPending(id: number): boolean {
    return this.live.has(id);
  }

  /**
   * 取一个**尚未到点**的 timer 的回调。
   *
   * 用途：在它被 `clearTimeout` 取消**之前**抓住回调，之后手动执行它 ——
   * 即「模拟一个即使被取消也仍然到点执行了的 timer」，
   * 用来验证下游闸门是否独立成立（defense-in-depth）。
   */
  callbackOf(id: number): (() => void) | undefined {
    return this.live.get(id)?.fn;
  }

  /** deterministic fire：按 id 精确触发一个 timer */
  fire(id: number): boolean {
    const t = this.live.get(id);
    if (t === undefined) return false;
    this.live.delete(id);
    t.fn();
    return true;
  }

  /**
   * 触发当前全部待触发 timer。
   *
   * 先取快照：fire 期间**新排程**的 timer 不在本次范围内 ——
   * 否则 `render → schedule → fire → render → schedule` 会变成不确定的递归。
   */
  fireAll(): number {
    const ids = [...this.live.keys()];
    let fired = 0;
    for (const id of ids) if (this.fire(id)) fired += 1;
    return fired;
  }
}

/* ============================================================
 * harness
 * ============================================================ */

export type AnalyzeRequest = { table: PokerTableState; revision: number };

export type TableJsHarness = {
  readonly timers: FakeTimers;
  readonly pageErrors: readonly string[];
  /** 发往 `/api/analyze` 的请求（真实网络层计数 + 载荷） */
  analyzeRequests(): readonly AnalyzeRequest[];
  tableRequestCount(): number;
  /** 服务端权威状态 */
  state(): PokerTableState;
  /** 由真实 `buildTablePreview` 算出的预览（用于断言前置条件） */
  preview(): TablePreview;
  /** 收敛 boot()/post() 的 Promise 链（不推进 fake timer） */
  settle(): Promise<void>;
  /** DOM 节点**自身**的文本 */
  text(id: string): string;
  /**
   * 节点自身 + 全部后代的可见文本 —— 真实 DOM `textContent` 的语义。
   *
   * `text()` 只能看到显式赋值的那一层：`renderResult()` 在「已应用建议」时
   * 是 `appendChild` 若干子节点、**不**设置父节点文本，只用 `text()` 会看到空串。
   */
  visibleText(id: string): string;
  /** 按文本找按钮（真实 UI 只有文案可点） */
  buttonByText(id: string, text: string): StubNode | undefined;
  node(id: string): StubNode;
  /* ---- 真实 UI 操作 ---- */
  clickHeroCard(card: string): void;
  /** 点手牌第 `index` 个槽位 —— 已选中的牌就是「取消这张」 */
  clickHeroHandSlot(index: number): void;
  clickBoardCard(card: string): void;
  /** 点当前行动者合法动作里第一个 CHECK / CALL；返回是否点到 */
  clickCheckOrCall(): boolean;
  clickAnalyzeButton(): void;
  clickNextHand(): void;
  clickResetHand(): void;
  clickUndo(): void;
  /** 点顶栏模式切换按钮（按文案点，harness 不知道有哪些模式） */
  clickModeByLabel(labelZh: string): void;
  /* ---- 请求控制 ---- */
  /** 让**下一次** `/api/analyze` 挂起，直到 release() */
  deferNextAnalyze(): { release: () => void; released: () => boolean };
  setAnalyzePayload(payload: unknown): void;
  /**
   * 取 `table.js` 自己挂出来的验收钩子 `window.__dshTest`（只读）。
   *
   * 🔴 **为什么测试需要它**：`app` 是 IIFE 私有变量，只从 DOM 读是无法回答
   * 「服务端给的建议有没有被当成 Hero 的实际动作写进牌局」这类问题的 ——
   * DOM 上「建议区显示加注」与「动作历史里有加注」看起来可以一模一样，
   * 而这两件事的正确性要求**正好相反**（建议只能显示，不能落库）。
   *
   * 返回 `null` 表示钩子没挂上（那本身就是一种失败，调用方应断言）。
   */
  exposedTest(): {
    app: Record<string, unknown>;
    render: () => void;
  } | null;
};

export type HarnessOptions = {
  /** 桩服务端建桌时的桌型（真实 UI 里由新建牌桌对话框决定） */
  tableSize?: 6 | 9;
  /**
   * 桩服务端**建桌时**使用的 Hero 座位。
   *
   * ⚠️ 它会覆盖客户端请求里的 `heroPosition`：`table.js` 的 `createTable()`
   * 在无参调用时也会显式发出 `heroPosition: 'BTN'`（见其实现），
   * 因此只靠「请求里没带就用默认值」是覆盖不到的。
   *
   * 真实 UI 里这一步由「新建牌桌对话框」的桌型 / 座位按钮决定 ——
   * 桩替测试把它定下来，避免每个用例都点一遍弹层。
   */
  heroPosition?: string;
  /**
   * `/api/table/meta` 要**广告**哪几档桌型（默认只有 `tableSize` 那一档）。
   *
   * 🔴 这是给「新建牌桌弹层能改桌型」这类测试用的：
   * `table.js` 的弹层**完全由 meta 驱动** —— meta 只广告一档，
   * 弹层里就只有一个桌型按钮，测试也就无从验证「点了另一个桌型会怎样」。
   *
   * 默认值刻意只含 `tableSize`，保证既有用例行为**逐位不变**。
   */
  tableSizes?: readonly (6 | 9)[];
};

const ORDER_BY_SIZE: Record<number, readonly string[]> = {
  6: ['UTG', 'HJ', 'CO', 'BTN', 'SB', 'BB'],
  9: ['UTG', 'UTG1', 'UTG2', 'LJ', 'HJ', 'CO', 'BTN', 'SB', 'BB'],
};

export async function createTableJsHarness(options: HarnessOptions = {}): Promise<TableJsHarness> {
  const tableSize: 6 | 9 = options.tableSize ?? 6;
  const order = ORDER_BY_SIZE[tableSize] ?? ORDER_BY_SIZE[6]!;
  const advertisedSizes: readonly (6 | 9)[] = options.tableSizes ?? [tableSize];
  /*
   * `/api/table/meta` 的 `positions` 必须覆盖**所有被广告的桌型**，
   * 而且每个座位的标签要来自**含有它的最大桌型**。
   *
   * 为什么不能直接用初始桌型的 `order`：
   * 6 人桌与 9 人桌都有 `UTG1` 这个名字吗？没有 —— 6 人桌没有。
   * 但 9 人桌有，而它的中文标签（`枪口+1`）只有按 9 人桌查才对。
   * 若拿 6 人桌去查，`positionMainLabel(6,'UTG1')` 查不到，
   * 弹层里那个按钮的文案就会与真实后端不一致。
   *
   * 真实后端返回的是**全量 9 个位置**（含各自的正确标签），这里照做。
   */
  const allPositions: readonly string[] = Array.from(
    new Set(advertisedSizes.flatMap((v) => ORDER_BY_SIZE[v] ?? ORDER_BY_SIZE[6]!)),
  );

  /**
   * 某个位置的中文标签 —— 取**含有它的最大桌型**来查
   *（`UTG1` 只有 9 人桌有，就用 9 人桌的标签 `枪口+1`）。
   */
  const labelForPosition = (position: string): string => {
    for (const size of [9, 6] as const) {
      if ((ORDER_BY_SIZE[size] ?? []).includes(position)) {
        return positionMainLabel(size, position as never);
      }
    }
    return position;
  };

  const registry = new Map<string, StubNode>();
  for (const id of ELEMENT_IDS) registry.set(id, makeNode('div'));

  const documentStub = {
    readyState: 'complete',
    getElementById: (id: string) => registry.get(id) ?? null,
    createElement: (tag: string) => makeNode(tag),
    querySelectorAll: () => [] as StubNode[],
    addEventListener: () => undefined,
  };

  const timers = new FakeTimers();
  const windowStub = {
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    addEventListener: () => undefined,
  };

  /* ---------- 真后端语义的 fetch 桩 ---------- */
  let serverState: PokerTableState | null = null;
  /*
   * `/api/analyze` 的默认响应 —— 形状必须与真实契约一致。
   *
   * `renderResult()` 在 `ok: true` 时会直接读 `a.viewModel.actionZh` 等字段；
   * 桩若少给 `viewModel`，一次「结果被应用」就会以 TypeError 收场，
   * 测试会误报成产品缺陷。
   */
  let analyzePayload: unknown = {
    ok: true,
    stage: 'DONE',
    decision: { action: 'CALL' },
    viewModel: {
      actionZh: '跟注',
      confidenceZh: '中',
      classificationZh: '价值',
      sizeZh: '',
      reasonsZh: ['（harness 桩的示例理由）'],
      warningsZh: [],
    },
    meta: { timings: {}, warnings: [] },
  };
  let analyzeGate: { promise: Promise<void>; release: () => void } | null = null;
  const analyzeRequests: AnalyzeRequest[] = [];
  let tableRequestCount = 0;

  const seatAll = (hero: string, size: 6 | 9 = tableSize): PokerTableState => {
    let s = createTable({ tableSize: size, heroPosition: hero as never });
    for (const p of ORDER_BY_SIZE[size] ?? ORDER_BY_SIZE[6]!) {
      if (p === hero) continue;
      const seat = seatOfPosition(s, p as never);
      if (!seat) continue;
      const r = applyTableOp(s, { kind: 'ADD_PLAYER', seatId: seat.seatId });
      if (r.ok) s = r.state;
    }
    return s;
  };

  const respond = (payload: unknown): unknown => ({
    json: () => Promise.resolve(payload),
    text: () => Promise.resolve(JSON.stringify(payload)),
    status: 200,
  });

  const fetchStub = (url: string, init?: { body?: string }): Promise<unknown> => {
    const body = init && init.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    if (url.endsWith('/api/table/meta')) {
      return Promise.resolve(
        respond({
          ok: true,
          meta: {
            /*
             * 🔴 座位**中文标签必须来自生产代码**（`positionMainLabel`），
             * 不能自己造。
             *
             * 原因：`table.js` 的新建牌桌弹层直接用 `meta.positions[].labelZh`
             * 当按钮文案。桩里若返回 `UTG` 而生产返回 `枪口位`，
             * 测试点的按钮文案就与真实界面**不是同一个** ——
             * 那种测试即使全绿，也没有验证到使用者真正会点的东西。
             *
             * （历史上这里返回的是 `p` 本身，因为当时没有测试依赖文案。）
             */
            positions: allPositions.map((p) => ({
              value: p,
              labelZh: labelForPosition(p),
            })),
            /*
             * ⚠️ 默认只广告**建桌时用的那一档**，与旧行为逐位一致
             *（`tableSizes` 只有一个元素时，`table.js` 的「新建牌桌」弹层
             * 里就只有一个桌型按钮）。
             *
             * 要测「弹层里能改桌型」必须显式传 `HarnessOptions.tableSizes`，
             * 否则弹层根本**没有第二个桌型可选** —— 那不是产品缺陷，
             * 是桩没提供。见 `test/newTableModal.test.ts`。
             */
            tableSizes: advertisedSizes.map((v) => ({
              value: v,
              labelZh: `${v} 人桌`,
              positions: ORDER_BY_SIZE[v] ?? ORDER_BY_SIZE[6]!,
            })),
            seatStatuses: [],
            occupiedStatuses: [],
            quickProfiles: [{ value: 'UNKNOWN', labelZh: '未知' }],
            dynamicHints: [{ value: 'UNKNOWN', labelZh: '未知' }],
            environments: [{ value: 'MID_LOW_STAKES', labelZh: '中低级别' }],
            actionTypes: [],
            streets: [],
            leaveChoices: [],
          },
        }),
      );
    }
    if (url.endsWith('/api/table')) {
      tableRequestCount += 1;
      const op = body['op'];
      if (op !== undefined) {
        const posted = body['state'] as PokerTableState;
        let result: ReturnType<typeof applyTableOp>;
        try {
          result = applyTableOp(posted, op as never);
        } catch (error) {
          return Promise.resolve(
            respond({
              ok: false,
              issues: [{ message: `THROWN: ${String(error)}` }],
              state: posted,
              preview: buildTablePreview(posted),
            }),
          );
        }
        if (result.ok) {
          serverState = result.state;
          return Promise.resolve(
            respond({ ok: true, state: result.state, preview: buildTablePreview(result.state) }),
          );
        }
        return Promise.resolve(
          respond({
            ok: false,
            issues: result.issues,
            state: posted,
            preview: buildTablePreview(posted),
          }),
        );
      }
      const requested = body['heroPosition'] as string | undefined;
      /*
       * ⚠️ 桌型的判定要区分「**初次加载**」与「**弹层里换了桌型**」。
       *
       * 麻烦在于：初次加载时 `table.js` 是**无参**调用 `createTable()`，
       * 于是它发出 `tableSize: 6`（硬编码默认值）—— 与「用户真的选了 6 人桌」
       * 在**请求上完全一样**。只靠请求内容分不开。
       *
       * 因此用「是不是第一次建桌」来分：
       *
       * | 时机 | 规则 |
       * |---|---|
       * | 第一次（页面加载） | 一律用 `HarnessOptions.tableSize` —— 请求里的 6 是**默认值**，不是意图 |
       * | 之后 | 用请求里的桌型（若被广告），那就是弹层里真的换了桌子 |
       *
       * 早先写成「请求桌型 ≠ 初始桌型 且被广告 ⇒ 采纳请求」，
       * 结果 `tableSize: 9` 的桩在第一次就被请求里的 6 顶掉了 ——
       * 桩把自己的选项吃掉，`NEWTABLE-08` 因此永远建不出 9 人桌。
       */
      const requestedSize = body['tableSize'] as 6 | 9 | undefined;
      const isFirstCreate = serverState === null;
      const size: 6 | 9 =
        !isFirstCreate && requestedSize !== undefined && advertisedSizes.includes(requestedSize)
          ? requestedSize
          : tableSize;
      /*
       * Hero 座位：**首次建桌用 `options.heroPosition`，之后用请求里的**。
       *
       * 🔴 `options.heroPosition` 的语义就是「**覆盖**客户端请求」（见它的
       * 类型定义）：初次加载时 `table.js` 总是无参调用 `createTable()`，
       * 请求里带头硬编码的 `heroPosition: 'BTN'`，所以只靠请求是测不到
       * 「Hero 在 UTG」这类场景的 —— 这个选项存在的唯一理由就是压过它。
       *
       * 但「弹层里改 Hero 座位」必须走请求，否则同样测不到。
       * 两者用「是不是第一次建桌」区分即可，不会互相干扰。
       */
      const hero = isFirstCreate ? (options.heroPosition ?? 'BTN') : (requested ?? 'BTN');
      serverState = seatAll(hero, size);
      return Promise.resolve(
        respond({
          ok: true,
          created: true,
          state: serverState,
          preview: buildTablePreview(serverState),
        }),
      );
    }
    if (url.endsWith('/api/analyze')) {
      const table = body['table'] as PokerTableState;
      analyzeRequests.push({ table, revision: table.revision });
      const gate = analyzeGate;
      analyzeGate = null;
      if (gate !== null) return gate.promise.then(() => respond(analyzePayload));
      return Promise.resolve(respond(analyzePayload));
    }
    return Promise.resolve(respond({ ok: false }));
  };

  /* ---------- 执行真实 table.js ---------- */
  const source = readFileSync(
    join(fileURLToPath(new URL('..', import.meta.url)), '..', 'src', 'app', 'web', 'table.js'),
    'utf8',
  );
  const pageErrors: string[] = [];
  const run = new Function('document', 'window', 'fetch', 'console', 'performance', source);
  run(
    documentStub,
    windowStub,
    fetchStub,
    {
      error: (m: unknown) => pageErrors.push(String(m)),
      log: () => undefined,
      warn: () => undefined,
    },
    { now: () => 0 },
  );

  const settle = async (): Promise<void> => {
    for (let i = 0; i < 6; i += 1) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 1);
      });
    }
  };
  await settle();

  const node = (id: string): StubNode => {
    const found = registry.get(id);
    if (found === undefined) throw new Error(`stub 里没有 id=${id}`);
    return found;
  };

  const findDeep = (root: StubNode, pred: (n: StubNode) => boolean): StubNode | null => {
    for (const c of root.children) {
      if (pred(c)) return c;
      const hit = findDeep(c, pred);
      if (hit !== null) return hit;
    }
    return null;
  };

  const pickCard = (card: string): void => {
    const btn = findDeep(
      node('pickerGrid'),
      (n) => n.tagName === 'button' && n.dataset['card'] === card,
    );
    if (btn === null) throw new Error(`牌面里找不到 ${card}`);
    if (btn.onclick === undefined) throw new Error(`${card} 没有绑定点击处理`);
    btn.onclick();
  };

  const currentState = (): PokerTableState => {
    if (serverState === null) throw new Error('桩服务端还没有建出牌桌');
    return serverState;
  };

  return {
    timers,
    pageErrors,
    analyzeRequests: () => [...analyzeRequests],
    tableRequestCount: () => tableRequestCount,
    state: currentState,
    preview: () => buildTablePreview(currentState()),
    settle,
    text: (id: string) => node(id).textContent,
    visibleText: (id: string) => {
      const collect = (n: StubNode): string =>
        [n.textContent, ...n.children.map(collect)].filter((t) => t.length > 0).join(' ');
      return collect(node(id));
    },
    node,
    buttonByText: (id: string, text: string) =>
      [...node(id).children].find((n) => n.textContent === text),
    clickHeroCard: (card: string) => {
      const empty = [...node('heroHandRow').children].find((n) => n.className.includes('empty'));
      if (empty === undefined) throw new Error('没有手牌空位');
      if (empty.onclick === undefined) throw new Error('手牌空位没有绑定点击处理');
      empty.onclick();
      pickCard(card);
    },
    clickBoardCard: (card: string) => {
      const slot = [...node('boardRow').children].find((n) => n.textContent === '+');
      if (slot === undefined) throw new Error('没有公共牌空槽');
      if (slot.onclick === undefined) throw new Error('公共牌空槽没有绑定点击处理');
      slot.onclick();
      pickCard(card);
    },
    clickCheckOrCall: (): boolean => {
      const p = buildTablePreview(currentState());
      const want = p.actionButtons.find((b) => b.type === 'CHECK' || b.type === 'CALL');
      if (want === undefined) return false;
      const child = [...node('actionButtons').children].find((n) => n.textContent === want.labelZh);
      if (child === undefined || child.onclick === undefined) return false;
      child.onclick();
      return true;
    },
    clickAnalyzeButton: (): void => {
      const btn = node('analyzeBtn');
      if (btn.onclick === undefined) throw new Error('分析按钮没有绑定点击处理');
      btn.onclick();
    },
    clickNextHand: (): void => {
      const btn = node('nextHandBtn');
      if (btn.onclick === undefined) throw new Error('「下一手」没有绑定点击处理');
      btn.onclick();
    },
    clickResetHand: (): void => {
      const btn = node('resetHandBtn');
      if (btn.onclick === undefined) throw new Error('「重置本手」没有绑定点击处理');
      btn.onclick();
    },
    clickUndo: (): void => {
      const btn = node('undoBtn');
      if (btn.onclick === undefined) throw new Error('「撤销」没有绑定点击处理');
      btn.onclick();
    },
    clickHeroHandSlot: (index: number): void => {
      const slot = node('heroHandRow').children[index];
      if (slot === undefined) throw new Error(`手牌区没有第 ${index} 个槽位`);
      if (slot.onclick === undefined) throw new Error(`手牌槽位 ${index} 没有绑定点击处理`);
      slot.onclick();
    },
    clickModeByLabel: (labelZh: string): void => {
      const btn = [...node('modeButtons').children].find((n) => n.textContent === labelZh);
      if (btn === undefined) throw new Error(`顶栏没有「${labelZh}」按钮`);
      if (btn.onclick === undefined) throw new Error(`「${labelZh}」没有绑定点击处理`);
      btn.onclick();
    },
    deferNextAnalyze: () => {
      let release!: () => void;
      let released = false;
      const promise = new Promise<void>((resolve) => {
        release = () => {
          released = true;
          resolve();
        };
      });
      analyzeGate = { promise, release };
      return { release, released: () => released };
    },
    setAnalyzePayload: (payload: unknown) => {
      analyzePayload = payload;
    },
    exposedTest: () => {
      const hook = (windowStub as Record<string, unknown>)['__dshTest'];
      if (hook === null || hook === undefined) return null;
      return hook as { app: Record<string, unknown>; render: () => void };
    },
  };
}
