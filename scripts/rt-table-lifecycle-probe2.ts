/**
 * 红队探针 2：把**真实的** src/app/web/table.js 放进一个最小 DOM 里跑起来，
 * 用真实 HTTP 服务端（startAlphaServer 的 /api/table）驱动它。
 *
 * 目的：§8「离桌决策」这条 UI 流程到底能不能走通 —— 不能只靠读代码下结论。
 *
 * 运行：
 *   node.exe --experimental-strip-types "scripts/rt-table-lifecycle-probe2.ts"
 */

import { writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

import { startAlphaServer } from '../src/app/webServer.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';

const OUT: string[] = [];
function line(text = ''): void {
  OUT.push(text);
  console.log(text);
}
function head(title: string): void {
  line('');
  line('='.repeat(78));
  line(`== ${title}`);
  line('='.repeat(78));
}
function info(t: string): void {
  line(`   · ${t}`);
}
function ok(t: string): void {
  line(`   PASS  ${t}`);
}
function hit(t: string): void {
  line(`   >>> HIT  ${t}`);
}
function bad(t: string): void {
  line(`   !!! FAIL ${t}`);
}

/* ============================================================
 * 最小 DOM
 * ============================================================ */

type FakeEl = {
  tagName: string;
  className: string;
  id: string;
  textContent: string;
  title: string;
  type: string;
  min: string;
  step: string;
  value: string;
  disabled: boolean;
  style: Record<string, string>;
  dataset: Record<string, string>;
  children: FakeEl[];
  parentNode: FakeEl | null;
  onclick: (() => void) | null;
  firstChild: FakeEl | null;
  appendChild: (c: FakeEl) => FakeEl;
  removeChild: (c: FakeEl) => FakeEl;
  querySelectorAll: (sel: string) => FakeEl[];
  _timer?: number;
};

function makeEl(tag: string): FakeEl {
  const node: Partial<FakeEl> = {
    tagName: String(tag).toUpperCase(),
    className: '',
    id: '',
    textContent: '',
    title: '',
    type: '',
    min: '',
    step: '',
    value: '',
    disabled: false,
    style: {},
    dataset: {},
    children: [],
    parentNode: null,
    onclick: null,
  };
  node.appendChild = (child: FakeEl): FakeEl => {
    child.parentNode = node as FakeEl;
    node.children!.push(child);
    return child;
  };
  node.removeChild = (child: FakeEl): FakeEl => {
    const i = node.children!.indexOf(child);
    if (i >= 0) node.children!.splice(i, 1);
    child.parentNode = null;
    return child;
  };
  Object.defineProperty(node, 'firstChild', {
    get: () => (node.children!.length > 0 ? node.children![0]! : null),
  });
  // <select>.options：客户端的环境下拉框会读它
  Object.defineProperty(node, 'options', {
    get: () => node.children!.filter((c) => c.tagName === 'OPTION'),
  });
  node.querySelectorAll = (sel: string): FakeEl[] => {
    const parts = sel.split(',').map((s) => s.trim());
    const out: FakeEl[] = [];
    const walk = (el: FakeEl): void => {
      for (const part of parts) {
        const [tag, cls] = part.split('.');
        const tagOk = !tag || el.tagName === tag.toUpperCase();
        const clsOk =
          !cls ||
          el.className
            .split(/\s+/)
            .filter((c) => c.length > 0)
            .includes(cls);
        if (tagOk && clsOk) {
          out.push(el);
          break;
        }
      }
      for (const child of el.children) walk(child);
    };
    for (const child of node.children!) walk(child);
    return out;
  };
  return node as FakeEl;
}

function allButtons(root: FakeEl): FakeEl[] {
  return root.querySelectorAll('button');
}
function textOf(root: FakeEl): string {
  let out = root.textContent ?? '';
  for (const c of root.children) out += ' ' + textOf(c);
  return out.replace(/\s+/g, ' ').trim();
}
function findButtonByText(root: FakeEl, needle: string): FakeEl | null {
  for (const b of allButtons(root)) {
    if (textOf(b).includes(needle)) return b;
  }
  return null;
}
function flatText(root: FakeEl): string {
  return textOf(root);
}

/* ============================================================
 * 装配沙箱
 * ============================================================ */

const html = readFileSync(fileURLToPath(new URL('../src/app/web/index.html', import.meta.url)), 'utf8');
const jsSource = readFileSync(fileURLToPath(new URL('../src/app/web/table.js', import.meta.url)), 'utf8');

const byId: Record<string, FakeEl> = {};
for (const m of html.matchAll(/id="([^"]+)"/g)) {
  const el = makeEl('div');
  el.id = m[1]!;
  byId[m[1]!] = el;
}
const documentSandbox = {
  readyState: 'complete',
  getElementById: (id: string): FakeEl | null => byId[id] ?? null,
  createElement: (tag: string): FakeEl => makeEl(tag),
  querySelectorAll: (sel: string): FakeEl[] => {
    const roots = Object.values(byId);
    const out: FakeEl[] = [];
    const parts = sel.split(',').map((s) => s.trim());
    for (const root of roots) {
      for (const part of parts) {
        const [tag, cls] = part.split('.');
        if (root.tagName === tag!.toUpperCase() && (!cls || root.className.includes(cls))) out.push(root);
      }
      out.push(...root.querySelectorAll(sel));
    }
    return out;
  },
  addEventListener: (): void => {
    /* DOMContentLoaded 不触发：readyState='complete' 时 boot() 会同步执行 */
  },
};

const pending: Promise<unknown>[] = [];
let baseUrl = '';
let fetchCount = 0;
process.on('unhandledRejection', (reason) => {
  info(`[unhandledRejection] ${String((reason as Error)?.stack ?? reason)}`);
});
const fetchSandbox = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => {
  fetchCount += 1;
  const opKind = init && init.body ? (/\"kind\":\"([A-Z_]+)\"/.exec(String(init.body))?.[1] ?? '?') : '';
  let opSeat = '';
  if (init && init.body) {
    try {
      const parsedBody = JSON.parse(String(init.body)) as { op?: { seatId?: string; card?: string; stackBB?: number } };
      opSeat = parsedBody.op?.seatId ?? parsedBody.op?.card ?? String(parsedBody.op?.stackBB ?? '');
    } catch {
      opSeat = '';
    }
  }
  info(`   [fetch #${fetchCount}] ${String(url)} op=${opKind}${opSeat ? ` arg=${opSeat}` : ''}`);
  const abs = String(url).startsWith('http') ? String(url) : `${baseUrl}${String(url)}`;
  const p = fetch(abs, init).then((res) => {
    if (opKind !== '') {
      const clone = res.clone();
      void clone
        .json()
        .then((body: unknown) => {
          const b = body as {
            ok?: boolean;
            created?: boolean;
            issues?: { code: string }[];
            state?: { revision: number };
            preview?: { seats?: { logicalPosition: string; status: string }[]; currentActorPosition?: string | null };
          };
          const sb = b.preview?.seats?.find((s) => s.logicalPosition === 'SB');
          const utg = b.preview?.seats?.find((s) => s.logicalPosition === 'UTG');
          const allStatuses = (b.preview?.seats ?? []).map((s) => `${s.logicalPosition}:${s.status}`).join(' ');
          info(
            `   [resp  #${fetchCount}] op=${opKind} ok=${String(b.ok)} rev=${String(b.state?.revision)} ` +
              `preview=${b.preview ? 'yes' : 'NO'} actor=${String(b.preview?.currentActorPosition)} ` +
              `issues=${JSON.stringify((b.issues as unknown as { code: string; message?: string }[] | undefined)?.map((i) => `${i.code}:${String(i.message).slice(0, 90)}`) ?? [])}\n        seats: ${allStatuses}\n        SB=${String(sb?.status)} UTG=${String(utg?.status)}`,
          );
        })
        .catch(() => info(`   [resp  #${fetchCount}] op=${opKind}（响应体不是 JSON）`));
    }
    return res;
  });
  pending.push(p);
  return p;
};

const sandbox = {
  document: documentSandbox,
  window: {
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms) as unknown as number,
    clearTimeout: (t: number) => clearTimeout(t),
  },
  fetch: fetchSandbox,
  console,
  Promise,
  JSON,
  Object,
  Array,
  Number,
  String,
  Math,
  Date,
  setTimeout,
  clearTimeout,
  isNaN,
  parseInt,
  parseFloat,
};

async function drain(ms = 120): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/* ============================================================
 * 主流程
 * ============================================================ */

const server = await startAlphaServer({
  port: 0,
  rules: loadKnowledgeBaseOrThrow().allRules(),
  logPath: null,
});
baseUrl = server.url;
info(`真实服务端已启动：${server.url}`);

try {
  runInNewContext(jsSource, sandbox, { filename: 'table.js' });
  await drain(600);
  info(`[诊断] toast = "${byId['toast']!.textContent}"`);
  info(`[诊断] #seats 子节点数 = ${byId['seats']!.children.length}，debugSeats = "${byId['debugSeats']!.textContent.slice(0, 60)}"`);
  info(`[诊断] #notices 文本 = "${flatText(byId['notices']!).slice(0, 80)}"`);

  /* ---------- 1. 启动后的座位渲染 ---------- */
  head('§C1 客户端启动后的座位渲染（视觉旋转是否把 Hero 放在底部、位置标签是否如实）');
  const seatsBox = byId['seats']!;
  const seatNodes = seatsBox.querySelectorAll('div.seat');
  info(`渲染出的座位数 = ${seatNodes.length}`);
  const rendered = seatNodes.map((n) => ({
    text: flatText(n).slice(0, 40),
    full: flatText(n),
    left: n.style['left'],
    top: n.style['top'],
    hero: n.className.includes('hero'),
  }));
  for (const r of rendered) info(`  ${r.hero ? '[HERO]' : '      '} ${r.text}  @(${r.left}, ${r.top})`);
  const heroNode = rendered.find((r) => r.hero);
  const debugSeats = JSON.parse(byId['debugSeats']!.textContent) as {
    seats: { logicalPosition: string; visualIndex: number; angleDeg: number; isCurrentActor: boolean }[];
  };
  const posText = (left: string | undefined, top: string | undefined): string =>
    `(${String(left)}, ${String(top)})`;
  info(
    '约定（tableState.ts / table.js 注释）：0°=0° 正下方 6 点钟；60°=左下；120°=左上；180°=正上方；240°=右上；300°=右下',
  );
  for (const s of debugSeats.seats) {
    const node = rendered.find((r) => r.full.includes(`（${s.logicalPosition}）`));
    const documented =
      s.angleDeg === 0
        ? '正下方'
        : s.angleDeg === 60
          ? '左下'
          : s.angleDeg === 120
            ? '左上'
            : s.angleDeg === 180
              ? '正上方'
              : s.angleDeg === 240
                ? '右上'
                : '右下';
    info(
      `  ${s.logicalPosition.padEnd(4)} v${s.visualIndex}/${String(s.angleDeg).padStart(3)}° 渲染于 ${posText(node?.left, node?.top)}（按约定应为「${documented}」）`,
    );
  }
  if (heroNode !== undefined && heroNode.left === '50%' && heroNode.top === '88%') {
    ok(`Hero 固定在正下方 (${heroNode.left}, ${heroNode.top})`);
  } else {
    hit(
      `Hero 被渲染在屏幕**正上方** ${posText(heroNode?.left, heroNode?.top)}，而角度约定 0°=正下方 —— ` +
        '整个椭圆布局相对约定旋转了 180°（同时把「逆时针」镜像成了「顺时针」）',
    );
  }

  /* ---------- 2. 坐满 6 人 ---------- */
  head('§C2 用界面把 6 个座位坐满（点座位 → 加入玩家）');
  for (let round = 0; round < 6; round += 1) {
    const nodes = byId['seats']!.querySelectorAll('div.seat');
    const empty = nodes.find((n) => n.className.includes('empty'));
    if (empty === undefined) break;
    empty.onclick!();
    await drain(30);
    const addBtn = findButtonByText(byId['modal']!, '加入玩家');
    if (addBtn === null) {
      bad('空座位菜单里没有「加入玩家」按钮');
      break;
    }
    addBtn.onclick!();
    await drain(150);
  }
  const dbg2 = JSON.parse(byId['debugSeats']!.textContent) as {
    seats: { logicalPosition: string; playerId: string | null }[];
  };
  info(`坐满后：${JSON.stringify(dbg2.seats.map((s) => `${s.logicalPosition}:${s.playerId ?? '空'}`))}`);

  /* ---------- 3. 选 Hero 手牌（让本手开始） ---------- */
  head('§C3 通过牌面矩阵选 Hero 手牌（本手开始）');
  const grid = byId['pickerGrid']!;
  const pickByCard = async (code: string): Promise<void> => {
    const btn = grid.querySelectorAll('button.pick').find((b) => b.dataset['card'] === code);
    if (btn === undefined) {
      bad(`牌面矩阵里找不到 ${code}`);
      return;
    }
    btn.onclick!();
    await drain(150);
  };
  await pickByCard('As');
  await pickByCard('Kd');
  info(`手中牌 = ${flatText(byId['heroHandRow']!)}`);
  info(`当前行动 = ${flatText(byId['actorLine']!)}`);
  info(`行动按钮 = ${JSON.stringify(allButtons(byId['actionButtons']!).map((b) => textOf(b)))}`);

  /* ---------- 4. 本手进行中点「清空座位」 ---------- */
  head('§C4 本手进行中，点某个座位的「清空座位」—— 界面能否给出「离桌选择」');
  const seatNodes2 = byId['seats']!.querySelectorAll('div.seat');
  const utgNode = seatNodes2.find((n) => flatText(n).includes('（UTG）'));
  if (utgNode === undefined) {
    bad('找不到 UTG 座位节点');
  } else {
    utgNode.onclick!();
    await drain(30);
    info(`座位菜单标题：${flatText(byId['modal']!).slice(0, 60)}`);
    const clearBtn = findButtonByText(byId['modal']!, '清空座位');
    if (clearBtn === null) {
      bad('座位菜单里没有「清空座位」按钮');
    } else {
      clearBtn.onclick!();
      await drain(400);
      const overlayShown = byId['overlay']!.className.includes('show');
      const modalText = flatText(byId['modal']!);
      const toastText = byId['toast']!.textContent;
      info(`点击后：overlay.className = "${byId['overlay']!.className}"`);
      info(`点击后：toast = "${toastText.slice(0, 120)}"`);
      info(`点击后：弹窗内容 = "${modalText.slice(0, 200)}"`);
      const hasLeaveChoice =
        findButtonByText(byId['modal']!, '仅标记手后离桌') !== null ||
        findButtonByText(byId['modal']!, '本手视为弃牌并离桌') !== null;
      const hasCancel = findButtonByText(byId['modal']!, '取消') !== null;
      info(`弹窗里有「仅标记手后离桌」类选项=${String(hasLeaveChoice)}；有「取消」=${String(hasCancel)}`);
      if (overlayShown && hasLeaveChoice) {
        ok('本手进行中点「清空座位」→ 弹出「离桌选择」，用户可以选择「仅标记手后离桌」（RT-L2 已修复）');
        // 选「仅标记手后离桌」并确认状态真的落地
        const leaveBtn = findButtonByText(byId['modal']!, '仅标记手后离桌')!;
        leaveBtn.onclick!();
        await drain(400);
        const dbgLeave = JSON.parse(byId['debugSeats']!.textContent) as {
          seats: { logicalPosition: string; playerId: string | null; status: string }[];
        };
        const utg = dbgLeave.seats.find((s) => s.logicalPosition === 'UTG')!;
        info(`选择后：UTG playerId=${String(utg.playerId)} status=${utg.status}`);
        if (utg.status === 'LEAVING_AFTER_HAND' && utg.playerId !== null) {
          ok('「仅标记手后离桌」已生效，且本手期间绑定与历史都保留');
        } else {
          bad(`离桌标记没有正确落地：${JSON.stringify(utg)}`);
        }
      } else {
        hit(
          '本手进行中点「清空座位」后，界面**没有**弹出「离桌选择」—— ' +
            '使用者无法选择「仅标记手后离桌」',
        );
      }
      // 关键补充：座位是否真的被清掉了（若被清掉就是更严重的后果）
      const dbg3 = JSON.parse(byId['debugSeats']!.textContent) as {
        seats: { logicalPosition: string; playerId: string | null; status: string }[];
      };
      info(`点击后座位状态：${JSON.stringify(dbg3.seats.map((s) => `${s.logicalPosition}:${s.playerId ?? '空'}/${s.status}`))}`);
      const utgSeat = dbg3.seats.find((s) => s.logicalPosition === 'UTG')!;
      if (utgSeat.playerId === null) hit('UTG 座位真的被清空了（本手历史事实被删除）');
      else ok(`UTG 座位未被清空（playerId=${utgSeat.playerId}，status=${utgSeat.status}）—— 后端守住了不变量`);
    }
  }

  /* ---------- 5. 对照：本手进行中点「暂时离座」 ---------- */
  head('§C4b 本手进行中点「暂时离座」：当前手必须不受影响，且意图必须可见/可取消');
  {
    const nodes = byId['seats']!.querySelectorAll('div.seat');
    const target = nodes.find((n) => flatText(n).includes('（SB）'));
    if (target === undefined) {
      bad('找不到 SB 座位');
    } else {
      target.onclick!();
      await drain(30);
      const outBtn = findButtonByText(byId['modal']!, '暂时离座');
      if (outBtn === null) bad('座位菜单里没有「暂时离座」按钮');
      else {
        outBtn.onclick!();
        await drain(400);
        info(`暂离标记后：当前行动 = ${flatText(byId['actorLine']!)}`);
        info(`暂离标记后：行动按钮 = ${JSON.stringify(allButtons(byId['actionButtons']!).map((b) => textOf(b)))}`);
        info(`暂离标记后：toast = ${byId['toast']!.textContent.slice(0, 110)}`);
        const seatsNow = byId['seats']!.querySelectorAll('div.seat');
        const sbText = flatText(seatsNow.find((n) => flatText(n).includes('（SB）'))!);
        info(`暂离标记后：SB 座位显示 = "${sbText}"`);
        if (allButtons(byId['actionButtons']!).length > 0) {
          ok('当前手不受影响（行动按钮仍在）—— RT-L4 已修复');
        } else {
          hit('暂离标记后行动按钮消失：当前手仍然被毁掉');
        }
        if (sbText.includes('暂离')) {
          ok('座位上看得出「暂离」状态');
        } else {
          hit('座位仍显示「在座」—— 使用者看不到自己刚标记的「下一手暂离」');
        }
        // 用户想取消：重新打开该座位菜单，看看有没有入口
        const sbNode = byId['seats']!.querySelectorAll('div.seat').find((n) => flatText(n).includes('（SB）'));
        sbNode?.onclick!();
        await drain(30);
        const menuText = flatText(byId['modal']!);
        const hasSitIn = findButtonByText(byId['modal']!, '重新入座') !== null;
        const hasSitOut = findButtonByText(byId['modal']!, '暂时离座') !== null;
        info(`再次打开座位菜单：有「重新入座」=${String(hasSitIn)}，有「暂时离座」=${String(hasSitOut)}`);
        if (!hasSitIn && hasSitOut) {
          const again = findButtonByText(byId['modal']!, '暂时离座')!;
          again.onclick!();
          await drain(300);
          info(`再次点「暂时离座」→ toast = ${byId['toast']!.textContent.slice(0, 110)}`);
          hit('界面没有任何「取消下一手暂离」的入口：座位虽然显示「（下一手暂离）」，但菜单仍只给「暂时离座」，再点一次只会报错（只能靠「撤销」）');
        } else if (hasSitIn) {
          ok('菜单提供「重新入座」，可以取消暂离标记');
        }
        void menuText;
      }
    }
  }

  /* ---------- 6. 端到端复现 RT-L5：新玩家继承上一位的「下一手暂离」 ---------- */
  head('§C6 端到端：新玩家是否继承上一位玩家的「下一手暂离」（RT-L5）');
  {
    const seatByText = (needle: string): FakeEl | undefined =>
      byId['seats']!.querySelectorAll('div.seat').find((n) => flatText(n).includes(needle));
    const clickModal = async (label: string, wait = 300): Promise<boolean> => {
      const b = findButtonByText(byId['modal']!, label);
      if (b === null) {
        bad(`弹窗里找不到「${label}」按钮`);
        return false;
      }
      b.onclick!();
      await drain(wait);
      return true;
    };
    // 新牌桌 → 坐一个 villain 到 UTG
    byId['newTableBtn']!.onclick!();
    await drain(300);
    seatByText('（UTG）')?.onclick!();
    await drain(30);
    await clickModal('加入玩家');
    // 选 Hero 手牌 → 本手开始
    await pickByCard('As');
    await pickByCard('Kd');
    info(`本手已开始：当前行动 = ${flatText(byId['actorLine']!)}`);
    // UTG 暂离（只标记下一手）
    seatByText('（UTG）')?.onclick!();
    await drain(30);
    await clickModal('暂时离座');
    info(`暂离后 UTG 座位显示 = "${flatText(seatByText('（UTG）')!)}"`);
    info(`暂离后 toast = ${byId['toast']!.textContent.slice(0, 90)}`);
    // 重置本手 → 手未开始，标记按设计保留
    byId['resetHandBtn']!.onclick!();
    await drain(300);
    // 清空座位（此时立即解绑）
    seatByText('（UTG）')?.onclick!();
    await drain(30);
    await clickModal('清空座位');
    info(`清空后 UTG 座位显示 = "${flatText(seatByText('（UTG）') ?? byId['seats']!.querySelectorAll('div.seat')[0]!)}"`);
    // 新玩家坐进来
    seatByText('（UTG）')?.onclick!();
    await drain(30);
    await clickModal('加入玩家');
    // 下一手
    byId['nextHandBtn']!.onclick!();
    await drain(400);
    const dbgNext = JSON.parse(byId['debugSeats']!.textContent) as {
      seats: { logicalPosition: string; displayName: string; status: string }[];
    };
    const utgSeat = dbgNext.seats.find((s) => s.logicalPosition === 'UTG')!;
    info(`下一手后 UTG：${JSON.stringify(utgSeat)}`);
    info(`阻塞提示 = ${flatText(byId['blockers']!).slice(0, 110)}`);
    if (utgSeat.status === 'SITTING_OUT') {
      hit(`端到端复现：新坐进 UTG 的「${utgSeat.displayName}」在下一手直接是 SITTING_OUT —— 他从未点过暂离，却继承了上一位玩家的标记，牌桌随即无法分析`);
    } else {
      ok('新玩家没有继承暂离标记');
    }
  }
  /* ---------- 6. 对照实验：本手未开始时清空座位是可以走通的 ---------- */
  head('§C6b 对照实验：点「新牌桌」回到本手未开始，再清空座位');  {
    byId['newTableBtn']!.onclick!();
    await drain(400);
    info(`新牌桌后：手牌 = "${flatText(byId['heroHandRow']!)}"，当前行动 = ${flatText(byId['actorLine']!)}`);
    const nodes = byId['seats']!.querySelectorAll('div.seat');
    const target = nodes.find((n) => flatText(n).includes('（SB）'));
    if (target === undefined) {
      bad('找不到 SB 座位');
    } else {
      // 新牌桌后 SB 是空座：先加入一个玩家，再清空
      target.onclick!();
      await drain(30);
      const addBtn = findButtonByText(byId['modal']!, '加入玩家');
      if (addBtn === null) bad('空座位菜单缺少加入按钮');
      else {
        addBtn.onclick!();
        await drain(300);
        const after = byId['seats']!.querySelectorAll('div.seat').find((n) => flatText(n).includes('（SB）'));
        after?.onclick!();
        await drain(30);
        const clearBtn = findButtonByText(byId['modal']!, '清空座位');
        if (clearBtn === null) bad('座位菜单缺少清空按钮');
        else {
          clearBtn.onclick!();
          await drain(300);
          const dbg4 = JSON.parse(byId['debugSeats']!.textContent) as {
            seats: { logicalPosition: string; playerId: string | null }[];
          };
          const sb = dbg4.seats.find((s) => s.logicalPosition === 'SB')!;
          info(`清空后 SB：playerId=${String(sb.playerId)}`);
          info(`toast=${byId['toast']!.textContent.slice(0, 120)}`);
          if (sb.playerId === null) ok('本手未开始时，点「清空座位」立即生效（说明 §C4 的失败只发生在本手进行中）');
          else bad('本手未开始时清空座位也失败了');
        }
      }
    }
  }
} finally {
  await server.close();
}

head('§C7 汇总');
line(`证据文件由本脚本自行写入（utf8）`);
const evidencePath = fileURLToPath(new URL('./rt-table-lifecycle-evidence2.txt', import.meta.url));
writeFileSync(evidencePath, OUT.join('\r\n') + '\r\n', 'utf8');
console.log(`\n证据已写入：${evidencePath}`);
