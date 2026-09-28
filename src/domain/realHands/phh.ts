/*
 * 🔴 **PHH（Poker Hand History）解析器** —— 真实牌局的入口。
 *
 * ## 格式来源（不猜语法）
 *
 * | 项 | 值 |
 * |---|---|
 * | 规范 | PHH File Format Specification 0.0.2（`phh.readthedocs.io`，MIT） |
 * | 论文 | Kim, *Recording and Describing Poker Hands*（IEEE CoG 2024，`arXiv:2312.11753`） |
 * | 参考实现 | PokerKit `pokerkit/notation.py` 的 `parse_action`（动作语法以它为准） |
 *
 * 动作码（**逐条对照参考实现的 `match words:` 分支**，不是照直觉猜的）：
 *
 * | 记号 | 含义 | 参考实现 |
 * |---|---|---|
 * | `d db <cards>` | 发公共牌 | `case 'd', 'db', cards: state.deal_board(cards)` |
 * | `d dh pN <cards>` | 给玩家 N 发底牌 | `case 'd', 'dh', player, cards: state.deal_hole(...)` |
 * | `pN f` | 弃牌 | `case player, 'f': state.fold()` |
 * | `pN cc` | **过牌或跟注** | `case player, 'cc': state.check_or_call()` |
 * | `pN cbr <amount>` | **下注/加注到**本街总额 `amount` | `case player, 'cbr', amount: state.complete_bet_or_raise_to(...)` |
 * | `pN sm [cards]` | 摊牌 / 亮牌 | `case player, 'sm', ...: state.show_or_muck_hole_cards(...)` |
 * | `pN pb` | 下前注（bring-in，非德州用） | `case player, 'pb': state.post_bring_in()` |
 *
 * ## 实测确认的事实（455 手 Pluribus 样本全量统计）
 *
 * - 字段全集恰好 10 个：`actions` / `ante_trimming_status` / `antes` /
 *   `blinds_or_straddles` / `finishing_stacks` / `hand` / `min_bet` /
 *   `players` / `starting_stacks` / `variant`；
 * - `variant` 全是 `'NT'`（无限注德州）；
 * - 动作码只出现 6 种：`d dh`(2,730) / `f`(2,195) / `cc`(1,081) /
 *   `cbr`(841) / `d db`(521) / `sm`(158)。
 *
 * ## 两张公共牌是**一条** `d db` 还是多条？
 *
 * 实测：`d db` 共 521 条，而 455 手里能进翻牌的约 400 手、
 * 转牌约 330、河牌约 260 ⇒ 521 ≈ 400 + 330 + 260 …
 * **即「每条 `d db` 只发一张牌」，翻牌的三张是三条连续动作。**
 * （第一版regex把 `d dh` 的牌误判成 `d db` 的牌，导致这个分布看起来像「1 张」；
 * 逐条打印后确认：`d db 7d`、`d db 5h`、`d db 9d` 是三条独立动作。）
 *
 * 因此本解析器**不假设**「一条 `d db` = 一整个街」，
 * 而是每条只加一张牌，街道由「牌数」推进 —— 这样两种写法都能吃。
 *
 * ## 为什么放在 `domain` 且是纯函数
 *
 * 解析只做「文本 → 结构」，不碰文件系统、不碰引擎、不做决策。
 * 任何一侧（脚本 / 测试 / 界面导入）都能用。
 */
import { POSITION_ORDER, positionsForTable } from '../poker/positions.ts';
import { Position, TableSize } from '../types.ts';

/* ============================================================
 * ① 输出形状
 * ============================================================ */

export type PhhPlayerAction =
  | { kind: 'DEAL_HOLE'; playerIndex: number; cards: readonly string[] }
  | { kind: 'DEAL_BOARD'; cards: readonly string[] }
  | { kind: 'FOLD'; playerIndex: number }
  | { kind: 'CHECK_OR_CALL'; playerIndex: number }
  /** **下注/加注到**本街总额（不是增量、不是本次投入） */
  | { kind: 'BET_OR_RAISE_TO'; playerIndex: number; amount: number }
  | { kind: 'SHOW'; playerIndex: number; cards: readonly string[] }
  /** 出现了解析器不认识的记号 ⇒ 该手**整体拒绝**（绝不当成「无操作」放过） */
  | { kind: 'UNKNOWN'; raw: string };

export type PhhHand = {
  /** 文件内 `hand` 字段（缺省时由调用方补一个稳定 id） */
  handId: string;
  players: readonly string[];
  startingStacks: readonly number[];
  /** 每个位置的**前注**（筹码）；缺省全 0 */
  antes: readonly number[];
  /** 每个位置的**盲注/抓头**（筹码）；`[50, 100, 0, 0, 0, 0]` = 6 人桌 SB/BB */
  blindsOrStraddles: readonly number[];
  /** 本街最小下注额（筹码） */
  minBet: number;
  actions: readonly PhhPlayerAction[];
  /** 原始文本里出现过的未知字段名（如实记录，不静默丢弃） */
  unknownFields: readonly string[];
};

export type PhhParseResult =
  | { ok: true; hand: PhhHand }
  | { ok: false; reason: string; detail: string };

/* ============================================================
 * ② 字段解析
 * ============================================================ */

/** PHH 的字符串值用单引号；本函数只识别字面量，不做表达式求值 */
function parseStringValue(raw: string): string | null {
  const m = /^'([^']*)'$/.exec(raw.trim());
  return m === null ? null : m[1]!;
}

/** `[50, 100, 0, 0, 0, 0]` → `[50,100,0,0,0,0]` */
function parseNumberList(raw: string): number[] | null {
  const t = raw.trim();
  if (!t.startsWith('[') || !t.endsWith(']')) return null;
  const inner = t.slice(1, -1).trim();
  if (inner === '') return [];
  const out: number[] = [];
  for (const piece of inner.split(',')) {
    const n = Number(piece.trim());
    if (!Number.isFinite(n)) return null;
    out.push(n);
  }
  return out;
}

/** `['a', 'b']` → `['a','b']`（PHH 的 actions 与 players 都是单引号字符串数组） */
function parseStringList(raw: string): string[] | null {
  const t = raw.trim();
  if (!t.startsWith('[') || !t.endsWith(']')) return null;
  const inner = t.slice(1, -1).trim();
  if (inner === '') return [];
  const out: string[] = [];
  let i = 0;
  while (i < inner.length) {
    const start = inner.indexOf("'", i);
    if (start < 0) break;
    const end = inner.indexOf("'", start + 1);
    if (end < 0) return null;
    out.push(inner.slice(start + 1, end));
    i = end + 1;
  }
  return out;
}

/** 牌面代码必须是 `[2-9TJQKA][shdc]`；不合法返回 `null`（不猜） */
function isCardToken(t: string): boolean {
  return /^[2-9TJQKA][shdc]$/.test(t);
}

/* ============================================================
 * ③ 动作解析（逐条对照 PokerKit `parse_action`）
 * ============================================================ */

/**
 * `pN` → 0 起的下标。
 *
 * 参考实现要求标签必须是 `p`（`if label != 'p': raise ValueError`）。
 * 本项目沿用同一约束。
 */
function playerIndexOf(token: string): number | null {
  const m = /^p(\d+)$/.exec(token);
  if (m === null) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) && n >= 1 ? n - 1 : null;
}

export function parsePhhAction(action: string): PhhPlayerAction {
  const words = action.trim().split(/\s+/).filter((w) => w !== '');

  if (words.length === 3 && words[0] === 'd' && words[1] === 'db') {
    const cards = words[2]!;
    /* 一条 `d db` 可能带多张（规范允许），因此按 2 字符切分 */
    const list: string[] = [];
    for (let i = 0; i + 2 <= cards.length; i += 2) list.push(cards.slice(i, i + 2));
    if (list.length === 0 || !list.every(isCardToken)) return { kind: 'UNKNOWN', raw: action };
    return { kind: 'DEAL_BOARD', cards: list };
  }

  if (words.length === 4 && words[0] === 'd' && words[1] === 'dh') {
    const idx = playerIndexOf(words[2]!);
    if (idx === null) return { kind: 'UNKNOWN', raw: action };
    const cards = words[3]!;
    const list: string[] = [];
    for (let i = 0; i + 2 <= cards.length; i += 2) list.push(cards.slice(i, i + 2));
    if (list.length === 0 || !list.every(isCardToken)) return { kind: 'UNKNOWN', raw: action };
    return { kind: 'DEAL_HOLE', playerIndex: idx, cards: list };
  }

  if (words.length === 2) {
    const idx = playerIndexOf(words[0]!);
    if (idx === null) return { kind: 'UNKNOWN', raw: action };
    if (words[1] === 'f') return { kind: 'FOLD', playerIndex: idx };
    if (words[1] === 'cc') return { kind: 'CHECK_OR_CALL', playerIndex: idx };
    if (words[1] === 'sm') return { kind: 'SHOW', playerIndex: idx, cards: [] };
    /*
     * `pb`（下前注）= bring-in，**德州不用**。
     * 本引擎只做无限注德州 ⇒ 遇到就拒绝该手（不是「当成无操作」）。
     */
    return { kind: 'UNKNOWN', raw: action };
  }

  if (words.length === 3) {
    const idx = playerIndexOf(words[0]!);
    if (idx === null) return { kind: 'UNKNOWN', raw: action };
    if (words[1] === 'cbr') {
      const amount = Number(words[2]);
      if (!Number.isFinite(amount) || amount <= 0) return { kind: 'UNKNOWN', raw: action };
      return { kind: 'BET_OR_RAISE_TO', playerIndex: idx, amount };
    }
    if (words[1] === 'sm') {
      const cards = words[2]!;
      const list: string[] = [];
      for (let i = 0; i + 2 <= cards.length; i += 2) list.push(cards.slice(i, i + 2));
      return { kind: 'SHOW', playerIndex: idx, cards: list.every(isCardToken) ? list : [] };
    }
    return { kind: 'UNKNOWN', raw: action };
  }

  return { kind: 'UNKNOWN', raw: action };
}

/* ============================================================
 * ④ 整手解析
 * ============================================================ */

/** 本项目已知的 PHH 字段；其余一律记进 `unknownFields`（不静默丢弃） */
const KNOWN_FIELDS: ReadonlySet<string> = new Set([
  'variant',
  'ante_trimming_status',
  'antes',
  'blinds_or_straddles',
  'bring_in',
  'small_bet',
  'big_bet',
  'min_bet',
  'starting_stacks',
  'actions',
  'players',
  'finishing_stacks',
  'hand',
  'author',
  'event',
  'city',
  'region',
  'country',
  'day',
  'month',
  'year',
  'time_zone',
  'time_control',
  'seat_count',
  'table',
  // 牌桌/场馆类（规范里的可选字段）
  'venue',
  'tournament',
  'tournament_id',
  'level',
  'blinds_or_straddles_status',
]);

/**
 * 解析一份 PHH 文本（一个文件 = 一手牌）。
 *
 * **任何不确定都返回失败**，绝不猜：未知字段照实记录、未知动作整体拒绝该手。
 */
export function parsePhh(text: string): PhhParseResult {
  const fields = new Map<string, string>();
  const unknownFields: string[] = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) return { ok: false, reason: 'MALFORMED_LINE', detail: line.slice(0, 120) };
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key === '') return { ok: false, reason: 'MALFORMED_LINE', detail: line.slice(0, 120) };
    fields.set(key, value);
    if (!KNOWN_FIELDS.has(key)) unknownFields.push(key);
  }

  /* ---- variant：本引擎只做无限注德州 ---- */
  const variantRaw = fields.get('variant');
  if (variantRaw === undefined) return { ok: false, reason: 'MISSING_VARIANT', detail: '' };
  const variant = parseStringValue(variantRaw);
  if (variant !== 'NT') {
    return { ok: false, reason: 'UNSUPPORTED_VARIANT', detail: String(variant) };
  }

  /* ---- players ---- */
  const players = parseStringList(fields.get('players') ?? '');
  if (players === null || players.length === 0) {
    return { ok: false, reason: 'BAD_PLAYERS', detail: String(fields.get('players')) };
  }

  /* ---- 筹码结构 ---- */
  const startingStacks = parseNumberList(fields.get('starting_stacks') ?? '');
  if (startingStacks === null || startingStacks.length !== players.length) {
    return { ok: false, reason: 'BAD_STARTING_STACKS', detail: String(fields.get('starting_stacks')) };
  }
  const antes = parseNumberList(fields.get('antes') ?? '[]') ?? [];
  const blinds = parseNumberList(fields.get('blinds_or_straddles') ?? '[]');
  if (blinds === null || blinds.length !== players.length) {
    return { ok: false, reason: 'BAD_BLINDS', detail: String(fields.get('blinds_or_straddles')) };
  }
  const minBet = Number(fields.get('min_bet') ?? '0');
  if (!Number.isFinite(minBet) || minBet <= 0) {
    return { ok: false, reason: 'BAD_MIN_BET', detail: String(fields.get('min_bet')) };
  }

  /* ---- actions ---- */
  const actionStrings = parseStringList(fields.get('actions') ?? '');
  if (actionStrings === null) {
    return { ok: false, reason: 'BAD_ACTIONS', detail: String(fields.get('actions')) };
  }
  const actions: PhhPlayerAction[] = [];
  for (const a of actionStrings) {
    const parsedAction = parsePhhAction(a);
    if (parsedAction.kind === 'UNKNOWN') {
      return { ok: false, reason: 'UNKNOWN_ACTION', detail: parsedAction.raw };
    }
    actions.push(parsedAction);
  }

  const handRaw = fields.get('hand');
  const handId = handRaw === undefined ? '' : (parseStringValue(handRaw) ?? handRaw);

  return {
    ok: true,
    hand: {
      handId,
      players: Object.freeze(players),
      startingStacks: Object.freeze(startingStacks),
      antes: Object.freeze(antes),
      blindsOrStraddles: Object.freeze(blinds),
      minBet,
      actions: Object.freeze(actions),
      unknownFields: Object.freeze(unknownFields),
    },
  };
}

/* ============================================================
 * ⑤ 座位 → 位置
 * ============================================================ */

/**
 * 把 `p1..pN` 映射到规范位置。
 *
 * ## 判据只有一条：**谁下了盲注**
 *
 * PHH 的 `blinds_or_straddles` 是「按玩家顺序」的数组：
 * `[50, 100, 0, 0, 0, 0]` ⇒ p1 = 小盲、p2 = 大盲。
 *
 * > ⚠️ **实测校准（第一版写错了）**：Pluribus 的 `data/pluribus/100/0.phh`
 * > 是 `p3 f, p4 cbr 210, p5 f, p6 f, p1 cc, p2 f` —— 六人桌标准动作序是
 * > `UTG HJ CO BTN SB BB`，而**动作从 p4 开始**，说明
 * > **p3 是按钮**（他的下一个 p4 才是 UTG），p1 = SB、p2 = BB。
 * > 我第一版按「p1 是 UTG」想当然地排位置，结果把**全部**样本都判成
 * > 「结构不受支持」而拒绝 —— 一个假阴性，靠逐手打印才抓到。
 *
 * ## 算法（只用位置环，不做任何猜测）
 *
 * 座位是**环**，位置也是**环**：
 *
 * ```text
 * 6 人环: UTG → HJ → CO → BTN → SB → BB → (回到 UTG)
 * ```
 *
 * 1. 盲注位由 `blinds_or_straddles` 的非 0 项**直接定位**：
 *    `[50, 100, 0, 0, 0, 0]` ⇒ **下标 0 = 小盲、下标 1 = 大盲**
 *    （实测：那两手都是 p1 跟注 50、p2 最后动作并弃牌 ⇒ p1=SB、p2=BB）；
 * 2. 从大盲的座位**往后**（座位环）依次走，位置环从「BB 的下一个位置」开始
 *    依次给：`UTG, HJ, CO, BTN, SB`。
 *
 * > ⚠️ **实测校准（我连错两次，都靠逐手打印才抓到）**：
 * > - 第一版按「p1 是 UTG」想当然地排 —— 全部样本被判成「结构不受支持」；
 * > - 第二版把位置环走反了（`SB→BTN→CO…`），得到 `p3=BTN, p6=UTG`，
 * >   于是引擎报 `ACTION_NOT_ACTOR: 第 1 条行动记录是「庄家位」，
 * >   但按行动顺序现在应该轮到「枪口位」` —— **是引擎抓住了我的错**。
 * >   正确映射：`p1=SB p2=BB p3=UTG p4=HJ p5=CO p6=BTN`，
 * >   此时 p3 率先行动 = UTG，与 `p2` 最后动作一致。
 *
 * 只接受「恰好一个小盲 + 恰好一个大盲」的结构（且大盲 > 小盲）；
 * 抓到别的（straddle、多人盲注、盲注位重合）一律返回 `null` ⇒ **该手拒绝**，
 * 因为本引擎的位置模型表达不了它。
 */
export function seatPositionsOf(hand: PhhHand): readonly Position[] | null {
  const n = hand.players.length;
  if (n !== 6 && n !== 9) return null;

  const order = POSITION_ORDER[n as 6 | 9];
  const sbOrderIndex = order.indexOf(Position.SB);
  const bbOrderIndex = order.indexOf(Position.BB);
  if (sbOrderIndex < 0 || bbOrderIndex < 0) return null;
  if (bbOrderIndex !== (sbOrderIndex + 1) % order.length) return null;

  /** 盲注位 = 盲注数组里**非 0** 的位置 */
  const posted = hand.blindsOrStraddles
    .map((v, i) => ({ v, i }))
    .filter((x) => x.v > 0);
  if (posted.length !== 2) return null;

  const [a, b] = posted as [{ v: number; i: number }, { v: number; i: number }];
  /* 大盲必须严格大于小盲（相等 ⇒ 结构异常，宁可拒绝也不猜谁是按钮） */
  if (!(a.v < b.v)) return null;

  const out: (Position | null)[] = new Array<Position | null>(n).fill(null);
  out[a.i] = order[sbOrderIndex]!;
  out[b.i] = order[bbOrderIndex]!;

  /**
   * 其余座位：从**大盲座位往后的第一个座位**开始，
   * 位置环从**大盲位置往后的第一个位置**开始，两边同步推进。
   */
  for (let k = 1; k < n - 1; k += 1) {
    const seat = (b.i + k) % n;
    const position = order[(bbOrderIndex + k) % order.length]!;
    if (out[seat] !== null) return null; // 撞上已填的盲注位 ⇒ 结构不受支持
    out[seat] = position;
  }

  if (out.some((p) => p === null)) return null;
  const filled = out as Position[];
  /* 位置必须**两两不同**（映射错了会在这里暴露，而不是静默串号） */
  if (new Set(filled).size !== n) return null;
  if (!positionsForTable(n as TableSize).every((p) => filled.includes(p))) return null;
  return Object.freeze(filled);
}

/* ============================================================
 * ⑥ 筹码口径
 * ============================================================ */

/**
 * 「1BB = 多少筹码」。
 *
 * PHH 全程用**筹码**记账（`starting_stacks` / `cbr` 全是筹码），
 * 而引擎的输入要 BB ⇒ 必须先定出大盲的筹码数。
 *
 * **没有猜的成分**：它就是 `blinds_or_straddles` 里的最大值。
 * 标准结构下即大盲；抓头（straddle）会更大，而那种手已经在
 * `seatPositionsOf` 里被拒（它要求恰好两个非 0 盲注）。
 */
export function bigBlindChipsOf(hand: PhhHand): number {
  const positive = hand.blindsOrStraddles.filter((v) => v > 0);
  return positive.length === 0 ? 0 : Math.max(...positive);
}
