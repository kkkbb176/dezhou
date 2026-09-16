/**
 * 牌桌现场验收走查（规范第 86 / 87 / 91 条）
 *
 * 用法：`node --experimental-strip-types scripts/table-walkthrough.ts`
 *
 * ## 它测什么、不测什么（**必须说清楚**）
 *
 * **测**：
 * - 每个 Spot 完成录入需要**多少次点击**（每次点击 = 一次 API 往返）
 * - 每次往返的服务端耗时与总耗时
 * - 最终真的能拿到建议（`canAnalyze` 与 `/api/analyze` 的返回）
 *
 * **不测**：人类思考与移动鼠标的时间。
 * 那是**使用者自己的**现场验收（规范第 91 条：人工点击完成 A–J）。
 * 本脚本给的是**下界**：点击次数 × 人的反应时间 + 服务端耗时。
 *
 * ## 为什么把它做成脚本而不是人工记录
 *
 * 点击次数是**客观量**：它决定了界面的效率上限，也最容易在后续改动中悄悄变多
 *（例如「加一个确认弹窗」就会让每个 Spot 多两次点击）。
 * 把它固化成可重跑的脚本，效率退化会立刻暴露。
 */

import { Position, Street } from '../src/domain/types.ts';
import { startAlphaServer } from '../src/app/webServer.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import type { PokerTableState, TablePreview } from '../src/app/table/table.types.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();

type Json = Record<string, unknown>;

type TableResponse = {
  ok: boolean;
  state?: PokerTableState;
  preview?: TablePreview;
  issues?: readonly { message: string }[];
  leaveDecision?: unknown;
};

type AnalyzeResponse = {
  ok: boolean;
  viewModel?: { actionZh: string; sizeZh?: string; confidenceZh: string; classificationZh: string };
  decision?: { action: string | null; confidence: number; classification: string };
  issues?: readonly { message: string }[];
};

/* ============================================================
 * 客户端（与 table.js 做同样的事：只发意图、只渲染结果）
 * ============================================================ */

class Client {
  clicks = 0;
  setupClicks = 0;
  latencyMs = 0;
  state: PokerTableState | null = null;
  preview: TablePreview | null = null;
  lastAnalysis: AnalyzeResponse | null = null;
  private readonly url: string;

  constructor(url: string) {
    this.url = url;
  }

  /**
   * 标记「一次性布置」结束。
   *
   * ⚠️ 建桌 + 把 5～8 个座位坐满是**一次性成本**：真实使用时开一次牌桌，
   * 之后每一手都只需要「下一手」，座位不用重填。
   * 把它算进「每手成本」会严重高估录入时间，因此分开统计。
   */
  markSetupDone(): void {
    this.setupClicks = this.clicks;
  }

  get handClicks(): number {
    return this.clicks - this.setupClicks;
  }

  private async post(path: string, body: unknown): Promise<Json> {
    const t0 = performance.now();
    const res = await fetch(`${this.url}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const payload = (await res.json()) as Json;
    this.latencyMs += performance.now() - t0;
    return payload;
  }

  async newTable(tableSize: 6 | 9, heroPosition: Position): Promise<void> {
    this.clicks += 1;
    const payload = (await this.post('/api/table', { tableSize, heroPosition })) as TableResponse;
    if (!payload.ok || !payload.state) throw new Error(`建桌失败：${JSON.stringify(payload)}`);
    this.state = payload.state;
    this.preview = payload.preview ?? null;
  }

  /** 一次点击 = 一个操作 */
  async op(op: unknown): Promise<TableResponse> {
    this.clicks += 1;
    const payload = (await this.post('/api/table', {
      state: this.state,
      op,
    })) as TableResponse;
    if (payload.state) this.state = payload.state;
    if (payload.preview) this.preview = payload.preview;
    return payload;
  }

  async mustOp(op: unknown): Promise<void> {
    const payload = await this.op(op);
    if (!payload.ok) {
      throw new Error(`操作被拒绝：${(payload.issues ?? []).map((i) => i.message).join(' / ')}`);
    }
  }

  /** 填满所有座位（一次性成本，`下一手` 不会重置） */
  async seatEveryone(): Promise<void> {
    if (!this.state) throw new Error('还没有牌桌');
    const empties = this.state.seats.filter((s) => s.playerId === null);
    for (const seat of empties) {
      await this.mustOp({ kind: 'ADD_PLAYER', seatId: seat.seatId });
    }
  }

  /** 点预览里给出的动作按钮（行动者由**后端**决定） */
  async click(type: string, sizeIndex = 0): Promise<void> {
    if (!this.preview) throw new Error('还没有预览');
    const sizes = this.preview.actionButtons.filter((b) => b.type === type && b.group === 'SIZE');
    const pool = sizes.length > 0 ? sizes : this.preview.actionButtons.filter((b) => b.type === type);
    const button = pool[sizeIndex] ?? pool[0];
    if (!button) {
      throw new Error(
        `没有可点的「${type}」按钮（当前合法动作：${this.preview.actionButtons
          .map((b) => b.labelZh)
          .join(' / ')}）`,
      );
    }
    await this.mustOp({
      kind: 'ACT',
      action: {
        type: button.type,
        ...(button.amountChips !== undefined ? { amountChips: button.amountChips } : {}),
      },
    });
  }

  async card(code: string): Promise<void> {
    await this.mustOp({ kind: 'SET_HERO_CARD', card: code });
  }

  async board(code: string, slot: number): Promise<void> {
    await this.mustOp({ kind: 'SET_BOARD_CARD', card: code, slot });
  }

  /** 一直弃牌到轮到 Hero */
  async foldToHero(max = 12): Promise<void> {
    for (let i = 0; i < max; i += 1) {
      if (!this.preview) return;
      if (this.preview.isHeroTurn) return;
      if (this.preview.currentActorPosition === null) return;
      await this.click('FOLD', -1);
    }
  }

  async analyze(): Promise<AnalyzeResponse> {
    this.clicks += 1;
    const payload = (await this.post('/api/analyze', { table: this.state })) as AnalyzeResponse;
    this.lastAnalysis = payload;
    return payload;
  }
}

/* ============================================================
 * 走查
 * ============================================================ */

type SpotResult = {
  id: string;
  note: string;
  clicks: number;
  handClicks: number;
  latencyMs: number;
  canAnalyze: boolean;
  advice: string;
  ok: boolean;
};

const results: SpotResult[] = [];

async function spot(
  id: string,
  note: string,
  run: (client: Client) => Promise<string>,
): Promise<void> {
  const server = await startAlphaServer({ port: 0, rules: RULES, logPath: null });
  const client = new Client(server.url);
  try {
    const advice = await run(client);
    results.push({
      id,
      note,
      clicks: client.clicks,
      handClicks: client.handClicks,
      latencyMs: Math.round(client.latencyMs),
      canAnalyze: client.preview?.canAnalyze ?? false,
      advice,
      ok: true,
    });
  } catch (error) {
    results.push({
      id,
      note,
      clicks: client.clicks,
      handClicks: client.handClicks,
      latencyMs: Math.round(client.latencyMs),
      canAnalyze: client.preview?.canAnalyze ?? false,
      advice: `失败：${(error as Error).message}`,
      ok: false,
    });
  } finally {
    await server.close();
  }
}

function formatAdvice(a: AnalyzeResponse): string {
  if (!a.ok || !a.viewModel) {
    return `未给出建议（${(a.issues ?? []).map((i) => i.message).join('；') || '未知原因'}）`;
  }
  return `${a.viewModel.actionZh}${a.viewModel.sizeZh ? ' ' + a.viewModel.sizeZh : ''} · ${a.viewModel.confidenceZh} · ${a.viewModel.classificationZh}`;
}

/**
 * A：9-max，Hero 在 UTG 开池，全部弃牌到大盲跟注，翻牌大盲过牌。
 *
 * ⚠️ 翻牌前**不**在这里分析：Hero 是第一个行动的人，此时 8 名对手都还没弃牌，
 * 引擎的多人池门槛（≥3 名活跃对手）会返回「信息不足」。
 * 这是既有引擎的**已知限制**，牌桌会**提前**用阻塞原因告诉使用者。
 */
async function spotA(c: Client): Promise<string> {
  await c.newTable(9, Position.UTG);
  await c.seatEveryone();
  c.markSetupDone();
  await c.card('Ah');
  await c.card('Ad');
  await c.click('RAISE', 0); // Hero UTG 开池
  // 其余 8 人：除了大盲全部弃牌
  for (const position of [
    Position.UTG1,
    Position.UTG2,
    Position.LJ,
    Position.HJ,
    Position.CO,
    Position.BTN,
    Position.SB,
  ]) {
    await c.click('FOLD', -1);
  }
  await c.click('CALL', -1); // 大盲跟注
  await c.board('Kh', 0);
  await c.board('7c', 1);
  await c.board('2d', 2);
  await c.click('CHECK', -1); // 大盲过牌 → 轮到 Hero（UTG）
  return formatAdvice(await c.analyze());
}

/**
 * A2：[Table Topology Correction 已迁移] 满桌 Hero 在 UTG **必须可分析**，
 *     且「还有人没说话」只提示、不劝退。
 *
 * ## 为什么这个 Spot 的语义被改了（而不是被删掉）
 *
 * 修复前这个 Spot 断言的是「翻牌前 UTG 就**提前提示**多人池限制」。
 * 那个提示当时用「未弃牌人数」判定 —— 而 Hero 在 UTG 时后面 8 个人
 * **一个字都还没说**。于是它实际断言的是「把未行动当成已参战」这个缺陷。
 *
 * 现在门槛改用**已实现**对手数（跟注/加注/全下），因此这个 Spot 改为断言：
 *
 * 1. 满桌 UTG **不得**出现任何劝退式阻塞，且 `canAnalyze === true`
 *    —— 这正是本轮的头号目标，必须由现场走查钉住；
 * 2. 预览里的两个计数必须正确（已实现 0 / 未行动 8）；
 * 3. **真的点下去**必须拿到一个建议（`action !== null`）。
 *
 * ⚠️ 「必须输出 `PLAYERS_YET_TO_ACT` 降级条目」这一条**不在这里**断言：
 * HTTP 响应体里的 `decision` 只有 `{ action, confidence, classification }`，
 * 不含 `diagnostics`。那一条由 `test/tableTopology.test.ts` §7 在决策层断言 ——
 * 两层各测自己能看到的东西，不越界声称。
 */
async function spotA2(c: Client): Promise<string> {
  await c.newTable(9, Position.UTG);
  await c.seatEveryone();
  c.markSetupDone();
  await c.card('Ah');
  await c.card('Ad');
  const p = c.preview;
  if (!p) throw new Error('无预览');

  // ---- 1. 不得因为「后面还有人没说话」就劝退 ----
  const discouraging = p.analyzeBlockers.filter(
    (b) => b.includes('活跃对手') || b.includes('真正进入'),
  );
  if (discouraging.length > 0) {
    throw new Error(
      '满桌 UTG 开池时不得出现多人池劝退 —— 那 8 个人还没轮到说话。' +
        `实际阻塞项：${p.analyzeBlockers.join(' / ')}`,
    );
  }
  if (!p.canAnalyze) {
    throw new Error(
      `满桌 UTG 必须可分析，实际 canAnalyze=false；阻塞项：${p.analyzeBlockers.join(' / ')}`,
    );
  }

  // ---- 2. 两个计数必须正确 ----
  if (p.realizedOpponentCount !== 0) {
    throw new Error(
      `还没有人进池 → realizedOpponentCount 必须是 0，实际 ${p.realizedOpponentCount}`,
    );
  }
  if (p.playersYetToAct !== 8) {
    throw new Error(`还没说话的人必须是 8 个，实际 ${p.playersYetToAct}`);
  }

  // ---- 3. 真的点下去必须拿到建议 ----
  const advice = await c.analyze();
  if (!advice.ok || !advice.decision || advice.decision.action === null) {
    throw new Error(
      '满桌 UTG 必须给出建议（action 不得为 null）；' +
        `ok=${String(advice.ok)} issues=${(advice.issues ?? []).map((i) => i.message).join(' / ')}`,
    );
  }

  return (
    `本手 ${p.handTopology?.handedness ?? '?'} 人｜已实现对手 ${p.realizedOpponentCount} / ` +
    `未行动 ${p.playersYetToAct} → **不劝退**，给出建议：` +
    `${advice.viewModel?.actionZh ?? advice.decision.action}`
  );
}

/** B：Hero 在小盲，面对关煞位开池、按钮位弃牌 */
async function spotB(c: Client): Promise<string> {
  await c.newTable(6, Position.SB);
  await c.seatEveryone();
  c.markSetupDone();
  await c.card('As');
  await c.card('Kd');
  await c.click('FOLD', -1); // UTG
  await c.click('FOLD', -1); // HJ
  await c.click('RAISE', 0); // CO 开池
  await c.click('FOLD', -1); // BTN 弃牌 → 只剩 CO 与大盲未弃牌 = 2 名对手
  return formatAdvice(await c.analyze());
}

/** C：Hero 在大盲，全部弃牌到小盲，小盲补齐 */
async function spotC(c: Client): Promise<string> {
  await c.newTable(6, Position.BB);
  await c.seatEveryone();
  c.markSetupDone();
  await c.card('Qh');
  await c.card('Qs');
  await c.click('FOLD', -1); // UTG
  await c.click('FOLD', -1); // HJ
  await c.click('FOLD', -1); // CO
  await c.click('FOLD', -1); // BTN
  await c.click('CALL', -1); // SB 补齐 → 只剩 SB 一个对手
  return formatAdvice(await c.analyze());
}

/** D：玩家中途弃牌（HJ 在 Hero 之后行动，先弃牌再让 Hero 决策） */
async function spotD(c: Client): Promise<string> {
  await c.newTable(6, Position.SB);
  await c.seatEveryone();
  c.markSetupDone();
  await c.card('Jh');
  await c.card('Jd');
  await c.click('FOLD', -1); // UTG 弃牌
  await c.click('RAISE', 0); // HJ 开池
  await c.click('FOLD', -1); // CO 弃牌
  await c.click('FOLD', -1); // BTN 弃牌
  return formatAdvice(await c.analyze());
}

/** E：玩家离桌（手后离桌）—— 本手仍要能继续分析 */
async function spotE(c: Client): Promise<string> {
  await c.newTable(6, Position.SB);
  await c.seatEveryone();
  c.markSetupDone();
  await c.card('Th');
  await c.card('Td');
  await c.click('FOLD', -1); // UTG 弃牌
  if (!c.state) throw new Error('无状态');
  const hjSeat = c.state.seats.find((s) => s.logicalPosition === Position.HJ)!;
  const leave = await c.op({ kind: 'CLEAR_SEAT', seatId: hjSeat.seatId });
  if (leave.ok) throw new Error('本手进行中直接清空座位必须被拒绝');
  await c.mustOp({
    kind: 'CLEAR_SEAT',
    seatId: hjSeat.seatId,
    activeHandChoice: 'LEAVE_AFTER_HAND',
  });
  await c.click('RAISE', 0); // HJ（已标记手后离桌）仍然可以正常行动
  await c.click('FOLD', -1); // CO
  await c.click('FOLD', -1); // BTN
  return formatAdvice(await c.analyze());
}

/** F：换新玩家 —— 新玩家必须是 UNKNOWN */
async function spotF(c: Client): Promise<string> {
  await c.newTable(6, Position.SB);
  await c.seatEveryone();
  c.markSetupDone();
  if (!c.state) throw new Error('无状态');
  const utgSeat = c.state.seats.find((s) => s.logicalPosition === Position.UTG)!;
  await c.mustOp({ kind: 'SET_PROFILE', seatId: utgSeat.seatId, quickProfile: 'CALLING_STATION' });
  await c.mustOp({ kind: 'REPLACE_PLAYER', seatId: utgSeat.seatId });
  const replaced = c.state!.seats.find((s) => s.logicalPosition === Position.UTG)!;
  const player = c.state!.playersById[replaced.playerId!]!;
  if (player.quickProfile !== 'UNKNOWN') {
    throw new Error(`换人后画像必须是 UNKNOWN，实际 ${player.quickProfile}`);
  }
  await c.card('9s');
  await c.card('9d');
  await c.click('FOLD', -1); // 新玩家（UTG）弃牌
  await c.click('RAISE', 0); // HJ 开池
  await c.click('FOLD', -1); // CO
  await c.click('FOLD', -1); // BTN
  const advice = formatAdvice(await c.analyze());
  return `换人后画像=${player.quickProfile}（正确）· ${advice}`;
}

/** G：暂离再回来 */
async function spotG(c: Client): Promise<string> {
  await c.newTable(6, Position.CO);
  await c.seatEveryone();
  c.markSetupDone();
  if (!c.state) throw new Error('无状态');
  const bbSeat = c.state.seats.find((s) => s.logicalPosition === Position.BB)!;
  await c.mustOp({ kind: 'SET_PROFILE', seatId: bbSeat.seatId, quickProfile: 'MANIAC' });
  await c.mustOp({ kind: 'SIT_OUT', seatId: bbSeat.seatId });
  const sitting = c.preview!;
  if (sitting.canAnalyze) throw new Error('暂离状态下不得可以分析');
  await c.mustOp({ kind: 'SIT_IN', seatId: bbSeat.seatId });
  const back = c.state!.seats.find((s) => s.logicalPosition === Position.BB)!;
  const player = c.state!.playersById[back.playerId!]!;
  if (player.quickProfile !== 'MANIAC') throw new Error('重新入座后画像必须保留');
  return '暂离→重新入座，画像保留（正确）';
}

/** H：150BB 深筹码，翻牌决策 */
async function spotH(c: Client): Promise<string> {
  await c.newTable(6, Position.CO);
  await c.seatEveryone();
  c.markSetupDone();
  if (!c.state) throw new Error('无状态');
  for (const seat of c.state.seats) {
    await c.mustOp({ kind: 'SET_STACK', seatId: seat.seatId, stackBB: 150 });
  }
  await c.card('Ac');
  await c.card('Kc');
  await c.click('FOLD', -1); // UTG
  await c.click('FOLD', -1); // HJ
  await c.click('RAISE', 0); // Hero CO 开池
  await c.click('FOLD', -1); // BTN
  await c.click('FOLD', -1); // SB
  await c.click('CALL', -1); // BB 跟注
  await c.board('Kh', 0);
  await c.board('7c', 1);
  await c.board('2d', 2);
  await c.click('CHECK', -1); // BB 过牌 → Hero
  return formatAdvice(await c.analyze());
}

/** I：河牌决策 —— 一路过牌到河牌，大盲下注 */
async function spotI(c: Client): Promise<string> {
  await c.newTable(6, Position.CO);
  await c.seatEveryone();
  c.markSetupDone();
  await c.card('As');
  await c.card('Kd');
  await c.click('FOLD', -1); // UTG
  await c.click('FOLD', -1); // HJ
  await c.click('RAISE', 0); // Hero CO 开池
  await c.click('FOLD', -1); // BTN
  await c.click('FOLD', -1); // SB
  await c.click('CALL', -1); // BB 跟注
  await c.board('Kh', 0);
  await c.board('7c', 1);
  await c.board('2d', 2);
  await c.click('CHECK', -1); // BB 过牌
  await c.click('CHECK', -1); // Hero 过牌
  await c.board('3s', 3);
  await c.click('CHECK', -1); // BB 过牌
  await c.click('CHECK', -1); // Hero 过牌
  await c.board('9h', 4);
  await c.click('BET', 0); // BB 下注 → Hero 面对下注
  return formatAdvice(await c.analyze());
}

/** J：下一手继续同桌 —— 座位与画像保留，手牌/公共牌/历史清空 */
async function spotJ(c: Client): Promise<string> {
  await c.newTable(6, Position.CO);
  await c.seatEveryone();
  c.markSetupDone();
  if (!c.state) throw new Error('无状态');
  const utgSeat = c.state.seats.find((s) => s.logicalPosition === Position.UTG)!;
  await c.mustOp({ kind: 'SET_PROFILE', seatId: utgSeat.seatId, quickProfile: 'TIGHT' });

  await c.card('As');
  await c.card('Kd');
  await c.click('FOLD', -1);
  await c.click('FOLD', -1);
  await c.click('RAISE', 0);
  await c.click('FOLD', -1);
  await c.click('FOLD', -1);
  await c.click('CALL', -1);
  await c.board('Kh', 0);
  await c.board('7c', 1);
  await c.board('2d', 2);
  await c.click('CHECK', -1);
  await c.analyze();
  const adviceBefore = formatAdvice(c.lastAnalysis!);

  const before = c.state.seats.map((s) => s.playerId);
  await c.mustOp({ kind: 'NEXT_HAND' });

  const after = c.state!.seats.map((s) => s.playerId);
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    throw new Error('下一手之后座位绑定必须保持不变');
  }
  if (c.state!.actionHistory.length !== 0) throw new Error('下一手必须清空行动历史');
  if (c.state!.board.length !== 0) throw new Error('下一手必须清空公共牌');
  if (c.state!.heroCards.length !== 0) throw new Error('下一手必须清空手牌');
  const keptProfile = c.state!.playersById[
    c.state!.seats.find((s) => s.logicalPosition === Position.UTG)!.playerId!
  ]!;
  if (keptProfile.quickProfile !== 'TIGHT') throw new Error('下一手必须保留玩家画像');

  // 下一手可以立刻继续录（座位不用重填）
  await c.card('Qh');
  await c.card('Qd');
  await c.click('FOLD', -1);
  await c.click('FOLD', -1);
  await c.click('RAISE', 0);
  await c.click('FOLD', -1);
  await c.click('FOLD', -1);
  await c.click('CALL', -1);
  await c.board('Qs', 0);
  await c.board('8h', 1);
  await c.board('3c', 2);
  await c.click('CHECK', -1);
  const second = formatAdvice(await c.analyze());
  return `上一手 ${adviceBefore} → 下一手 ${second}（座位与画像保留）`;
}

/* ============================================================
 * 主流程
 * ============================================================ */

const SPOTS: readonly (readonly [string, string, (c: Client) => Promise<string>])[] = [
  ['A', '9-max · Hero UTG（翻牌决策）', spotA],
  ['A2', '9-max · 翻牌前**提前提示**多人池限制', spotA2],
  ['B', 'Hero 小盲 · 面对开池', spotB],
  ['C', 'Hero 大盲 · 小盲补齐', spotC],
  ['D', '玩家中途弃牌', spotD],
  ['E', '玩家离桌（手后离桌）', spotE],
  ['F', '换新玩家（不得继承画像）', spotF],
  ['G', '暂离再回来', spotG],
  ['H', '150BB 深筹码', spotH],
  ['I', '河牌决策', spotI],
  ['J', '下一手继续同桌', spotJ],
];

console.log('交互式牌桌 —— 现场走查（A–J）');
console.log('');
console.log('| Spot | 场景 | 本手点击 | 含布置 | 服务端耗时 | 结果 |');
console.log('|---|---|---:|---:|---:|---|');

for (const [id, note, run] of SPOTS) {
  await spot(id, note, run);
}

for (const r of results) {
  const mark = r.ok ? '' : '❌ ';
  console.log(
    `| ${r.id} | ${r.note} | ${r.handClicks} | ${r.clicks} | ${r.latencyMs} ms | ${mark}${r.advice} |`,
  );
}

const handClicks = results.filter((r) => r.ok).map((r) => r.handClicks);
const sorted = [...handClicks].sort((a, b) => a - b);
const median = sorted.length === 0 ? 0 : sorted[Math.floor(sorted.length / 2)]!;

console.log('');
console.log(`成功 Spot：${results.filter((r) => r.ok).length} / ${results.length}`);
console.log(
  `**每手**点击次数：中位数 ${median}，最小 ${sorted[0] ?? 0}，最大 ${sorted[sorted.length - 1] ?? 0}`,
);
console.log(
  `一次性布置（建桌 + 坐满座位）：${results[0]?.clicks !== undefined ? results[0]!.clicks - results[0]!.handClicks : 0} 次点击 —— 开一次牌桌只需做一次`,
);
console.log(
  `服务端耗时合计：${results.reduce((a, r) => a + r.latencyMs, 0)} ms` +
    `（每手约 ${Math.round(results.reduce((a, r) => a + r.latencyMs, 0) / Math.max(1, results.length))} ms，**不含**人的思考与移动鼠标时间）`,
);
console.log('');
console.log('⚠️ 人类输入耗时（规范第 86 条：普通 Spot ≤10 秒）必须由使用者亲自点一遍才有意义 ——');
console.log('   本脚本给出的是下界：点击次数 × 单次反应时间 + 服务端耗时。');
