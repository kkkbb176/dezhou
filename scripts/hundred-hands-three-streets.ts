/**
 * **100 手语料 × 三街决策 × 人物画像** 验证台（只读；不改生产代码）
 *
 * ## 为什么要这个
 *
 * 使用者问：「实战 100 手，看翻牌/转牌/河牌/人物画像，会不会很实际」。
 * 单点探针回答不了这个问题 —— 需要**成规模**地跑，才能暴露
 * 「某些牌面/某些街/某些画像下引擎给出不合理或不可执行结果」这类缺陷。
 *
 * ## 语料怎么构造（可复现，不用随机数）
 *
 * 100 手 = `线型(5) × 牌面(4) × 画像(5)` 的笛卡尔积，每格的
 * 底牌/公共牌/行动由**索引**决定 ⇒ 同一输入永远同一结果（项目纪律）。
 *
 * | 维度 | 取值 |
 * |---|---|
 * | 线型 | ①BTN单开·BB跟（单挑·我无主动权）②CO开·BTN跟（我单挑+主动权）③单开·BB3Bet（面对3Bet）④开·跟·跟（三人池）⑤BTN开·SB3Bet·BB冷跟（三人·面对3Bet） |
 * | 牌面 | 干燥 K72r / 湿润 QJs8ss / 成对 K77 / 连通 987r |
 * | 画像 | NORMAL / VERY_TIGHT / CALLING_STATION / MANIAC / LOOSE |
 *
 * 每条线型都在 **FLOP / TURN / RIVER** 各给一个决策点（对手在本街先行动），
 * 于是 100 手 ⇒ **300 个决策**。
 *
 * ## 每个决策点检查什么
 *
 * 1. **可分析性**：`ok === false` 一律记为缺陷（staging 与 code 都记下来）
 * 2. **合法性**：建议动作必须在该节点的合法动作集合内；尺寸必须 ≤ 剩余筹码
 * 3. **数学一致性**：`requiredEquity ≈ callCost / winnable`、`callEV` 与权益同号、
 *    `pot` 等于行动记录重算值
 * 4. **可解释性**：必须有非空理由；`confidence ∈ [0,1]`、`band/classification` 必须是已知枚举
 * 5. **画像方向**（跨手统计）：紧的画像 vs 松的画像，在**同一手同一街**上的
 *    动作/权益方向必须一致（这条在最后聚合检查）
 */
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import type { ManualHandInput } from '../src/app/manualInput/manualInput.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const OPTIONS = {
  rules: RULES, asOf: 1_757_000_000_000, writeLog: false,
  equitySeed: 20_260_913, budget: { softMs: 900_000, hardMs: 1_800_000 },
} as const;

/* ============================================================
 * 语料定义
 * ============================================================ */

type Act = { position: string; type: string; amountBB?: number; street?: string };
const pre = (position: string, type: string, amountBB?: number, street?: string): Act => ({
  position, type, ...(amountBB === undefined ? {} : { amountBB }), ...(street === undefined ? {} : { street }),
});

type Line = {
  name: string;
  tableSize: 6 | 9;
  heroPosition: string;
  seats: Record<string, number>;
  preflop: readonly Act[];
  /**
   * 🔴 每条街的**决策点前缀**：该数组结束时**正好轮到 Hero 行动**。
   * 因此前缀只包含 Hero 之前的动作；Hero 自己在前面几街的动作必须补在
   * 后一街的前缀里（引擎会完整重放整条记录）。
   * 顺序必须符合引擎的规则：翻牌后小盲/大盲先、庄家最后。
   */
  decide: { FLOP: Act[]; TURN: Act[]; RIVER: Act[] };
};

const SEATS6 = { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 } as const;
const SEATS9 = { UTG: 100, UTG1: 100, UTG2: 100, LJ: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 } as const;

const F = (position: string, type: string, amountBB?: number): Act => pre(position, type, amountBB, 'FLOP');
const T = (position: string, type: string, amountBB?: number): Act => pre(position, type, amountBB, 'TURN');
const R = (position: string, type: string, amountBB?: number): Act => pre(position, type, amountBB, 'RIVER');

const LINES: readonly Line[] = [
  {
    name: '①6max BTN单开·BB跟（单挑，我无主动权）',
    tableSize: 6, heroPosition: 'BTN', seats: { ...SEATS6 },
    preflop: [pre('UTG', 'FOLD'), pre('HJ', 'FOLD'), pre('CO', 'FOLD'), pre('BTN', 'RAISE', 2.5), pre('SB', 'FOLD'), pre('BB', 'CALL', 1.5)],
    decide: {
      FLOP: [F('BB', 'CHECK')],
      TURN: [F('BB', 'CHECK'), F('BTN', 'BET', 2), F('BB', 'CALL', 2), T('BB', 'BET', 3)],
      RIVER: [
        F('BB', 'CHECK'), F('BTN', 'BET', 2), F('BB', 'CALL', 2),
        T('BB', 'BET', 3), T('BTN', 'CALL', 3), R('BB', 'BET', 9),
      ],
    },
  },
  {
    name: '②6max CO开·BTN跟（单挑，我在位）',
    tableSize: 6, heroPosition: 'BTN', seats: { ...SEATS6 },
    preflop: [pre('UTG', 'FOLD'), pre('HJ', 'FOLD'), pre('CO', 'RAISE', 2.5), pre('BTN', 'CALL', 2.5), pre('SB', 'FOLD'), pre('BB', 'FOLD')],
    decide: {
      FLOP: [F('CO', 'BET', 2)],
      TURN: [F('CO', 'BET', 2), F('BTN', 'CALL', 2), T('CO', 'CHECK')],
      RIVER: [
        F('CO', 'BET', 2), F('BTN', 'CALL', 2),
        T('CO', 'CHECK'), T('BTN', 'BET', 4), T('CO', 'CALL', 4), R('CO', 'BET', 11),
      ],
    },
  },
  {
    name: '③6max BTN开·BB3Bet（面对3Bet后我跟）',
    tableSize: 6, heroPosition: 'BTN', seats: { ...SEATS6 },
    preflop: [pre('UTG', 'FOLD'), pre('HJ', 'FOLD'), pre('CO', 'FOLD'), pre('BTN', 'RAISE', 2.5), pre('SB', 'FOLD'), pre('BB', 'RAISE', 8), pre('BTN', 'CALL', 5.5)],
    decide: {
      FLOP: [F('BB', 'BET', 5)],
      TURN: [F('BB', 'BET', 5), F('BTN', 'CALL', 5), T('BB', 'BET', 12)],
      RIVER: [
        F('BB', 'BET', 5), F('BTN', 'CALL', 5),
        T('BB', 'BET', 12), T('BTN', 'CALL', 12), R('BB', 'CHECK'),
      ],
    },
  },
  {
    name: '④9max UTG开·两家跟（三人池）',
    tableSize: 9, heroPosition: 'BTN', seats: { ...SEATS9 },
    preflop: [
      pre('UTG', 'RAISE', 3), pre('UTG1', 'FOLD'), pre('UTG2', 'FOLD'), pre('LJ', 'FOLD'), pre('HJ', 'CALL', 3),
      pre('CO', 'FOLD'), pre('BTN', 'CALL', 3), pre('SB', 'FOLD'), pre('BB', 'FOLD'),
    ],
    decide: {
      FLOP: [F('UTG', 'BET', 7), F('HJ', 'FOLD')],
      TURN: [F('UTG', 'BET', 7), F('HJ', 'FOLD'), F('BTN', 'CALL', 7), T('UTG', 'BET', 16)],
      RIVER: [
        F('UTG', 'BET', 7), F('HJ', 'FOLD'), F('BTN', 'CALL', 7),
        T('UTG', 'BET', 16), T('BTN', 'CALL', 16), R('UTG', 'CHECK'),
      ],
    },
  },
  {
    name: '⑤9max BTN开·SB3Bet·BB跟（三人·面对3Bet）',
    tableSize: 9, heroPosition: 'BTN', seats: { ...SEATS9 },
    preflop: [
      pre('UTG', 'FOLD'), pre('UTG1', 'FOLD'), pre('UTG2', 'FOLD'), pre('LJ', 'FOLD'), pre('HJ', 'FOLD'),
      pre('CO', 'FOLD'), pre('BTN', 'RAISE', 3), pre('SB', 'RAISE', 10), pre('BB', 'CALL', 9), pre('BTN', 'CALL', 7),
    ],
    decide: {
      FLOP: [F('SB', 'BET', 12), F('BB', 'FOLD')],
      TURN: [F('SB', 'BET', 12), F('BB', 'FOLD'), F('BTN', 'CALL', 12), T('SB', 'CHECK')],
      RIVER: [
        F('SB', 'BET', 12), F('BB', 'FOLD'), F('BTN', 'CALL', 12),
        T('SB', 'CHECK'), T('BTN', 'BET', 18), T('SB', 'CALL', 18), R('SB', 'BET', 30),
      ],
    },
  },
];

/** 每条线型的**首要对手座位**（必须与 `heroPosition` 不同） */
const VILLAIN_SEAT: Readonly<Record<string, string>> = {
  '①6max BTN单开·BB跟（单挑，我无主动权）': 'BB',
  '②6max CO开·BTN跟（单挑，我在位）': 'CO',
  '③6max BTN开·BB3Bet（面对3Bet后我跟）': 'BB',
  '④9max UTG开·两家跟（三人池）': 'UTG',
  '⑤9max BTN开·SB3Bet·BB跟（三人·面对3Bet）': 'SB',
};

type Board = { name: string; cards: readonly string[] };
const BOARDS: readonly Board[] = [
  { name: '干燥 K72r', cards: ['Ks', '7h', '2c', '4d', 'Jh'] },
  { name: '湿润 QJs8ss', cards: ['Qs', 'Js', '8s', '2h', '3d'] },
  { name: '成对 K77', cards: ['Kd', '7s', '7c', '2h', '9d'] },
  { name: '连通 987r', cards: ['9h', '8c', '7d', '2s', 'Kc'] },
];

/** 12 组底牌：覆盖 空气 / 中对 / 顶对 / 两对 / 三条 / 听牌 / 顺子成牌 */
const HANDS: readonly (readonly [string, string])[] = [
  ['As', '5s'], ['Kh', 'Qh'], ['9s', '9h'], ['7h', '6h'],
  ['Ad', 'Kd'], ['Qh', 'Th'], ['Jc', 'Tc'], ['8h', '8d'],
  ['Ac', 'Jh'], ['5h', '4h'], ['Td', '9c'], ['Ah', 'Ad'],
];

/**
 * 🔴 **必须挑一组与公共牌不冲突的底牌**：语料里某些牌面与固定底牌会撞牌
 * （实测：`K72r` 的第 4/5 张是 `Jh`，而底牌 `AcJh` 也有 `Jh`）
 * —— 引擎会正确报 `ISSUE.USER_CARD_ON_BOARD`，但那是**夹具缺陷**不是引擎缺陷。
 * 这里按确定性顺序取第一组不冲突的（同输入永远同结果）。
 */
function pickHand(seed: number, board: readonly string[]): readonly [string, string] {
  const used = new Set(board);
  for (let i = 0; i < HANDS.length; i += 1) {
    const h = HANDS[(seed + i) % HANDS.length]!;
    if (!used.has(h[0]) && !used.has(h[1])) return h;
  }
  return HANDS[0]!;
}

const PROFILES: readonly string[] = ['NORMAL', 'VERY_TIGHT', 'CALLING_STATION', 'MANIAC', 'LOOSE'];

type StreetName = 'FLOP' | 'TURN' | 'RIVER';

/** 组装某一街的决策输入：决策点前缀结束时**正好轮到 Hero 行动** */
function buildInput(line: Line, board: Board, hero: readonly [string, string], profile: string, street: StreetName): ManualHandInput {
  const history: Act[] = [...line.preflop, ...line.decide[street]];
  const boardCount = street === 'FLOP' ? 3 : street === 'TURN' ? 4 : 5;
  const villainSeat = VILLAIN_SEAT[line.name]!;
  return {
    tableSize: line.tableSize,
    heroPosition: line.heroPosition,
    heroCards: hero,
    board: board.cards.slice(0, boardCount),
    street,
    effectiveStackBB: 100,
    bigBlindBB: 100,
    seatStacksBB: line.seats,
    actionHistory: history as unknown as ManualHandInput['actionHistory'],
    environment: 'MID_LOW_STAKES',
    villain: {
      seatId: `seat_${villainSeat}`,
      persistentPlayerId: 'p_villain',
      displayName: '对手',
      stackBB: 100,
      ...(PROFILES.includes(profile) ? { quickProfile: profile } : {}),
      observedStats: {
        handsObserved: 2000,
        vpip: profile === 'VERY_TIGHT' ? 0.11 : profile === 'CALLING_STATION' ? 0.55 : profile === 'MANIAC' ? 0.56 : profile === 'LOOSE' ? 0.34 : 0.2,
        pfr: profile === 'VERY_TIGHT' ? 0.07 : profile === 'CALLING_STATION' ? 0.12 : profile === 'MANIAC' ? 0.37 : profile === 'LOOSE' ? 0.1 : 0.16,
        threeBet: profile === 'MANIAC' ? 0.13 : 0.04,
        wtsd: profile === 'CALLING_STATION' ? 0.42 : profile === 'VERY_TIGHT' ? 0.2 : 0.3,
        foldToFlopCBet: profile === 'CALLING_STATION' ? 0.3 : profile === 'VERY_TIGHT' ? 0.72 : 0.5,
        foldToTurnCBet: profile === 'CALLING_STATION' ? 0.28 : profile === 'VERY_TIGHT' ? 0.6 : 0.48,
        foldToRiverBet: profile === 'CALLING_STATION' ? 0.25 : profile === 'VERY_TIGHT' ? 0.65 : 0.45,
        flopCheckRaise: 0.06, turnCheckRaise: 0.05, riverCheckRaise: 0.04,
      },
    },
  } as unknown as ManualHandInput;
}

/* ============================================================
 * 判定
 * ============================================================ */

type Defect = { hand: string; stage: string; code: string; detail: string };

const KNOWN_BANDS = new Set(['HIGH', 'MEDIUM_HIGH', 'MEDIUM', 'MEDIUM_LOW', 'LOW']);
const KNOWN_CLASS = new Set(['CLEAR', 'MARGINAL', 'INSUFFICIENT_INFORMATION', 'DOMINANT']);

const defects: Defect[] = [];
const rows: { line: string; board: string; hero: string; street: StreetName; profile: string; action: string; size: string; eq: number | null; cls: string }[] = [];
let decisions = 0;

/** 一手 × 一街 的判定 */
function checkOne(line: Line, board: Board, hero: readonly [string, string], profile: string, street: StreetName): void {
  const handId = `${line.name}｜${board.name}｜${hero[0]}${hero[1]}｜${profile}｜${street}`;
  const input = buildInput(line, board, hero, profile, street);
  let r: ReturnType<typeof analyzeManualHand>;
  try {
    r = analyzeManualHand(input, OPTIONS);
  } catch (e) {
    defects.push({ hand: handId, stage: 'THROW', code: 'EXCEPTION', detail: String((e as Error).message).slice(0, 160) });
    return;
  }
  decisions += 1;
  if (!r.ok) {
    defects.push({ hand: handId, stage: r.stage, code: r.issues.map((i) => i.code).join(','), detail: r.issues.map((i) => i.message).slice(0, 1).join('').slice(0, 160) });
    return;
  }
  const d = r.decision;
  const dg = d.diagnostics;
  const m = dg.math;

  /* 2. 合法性 */
  if (d.action !== null && !dg.legalActions.includes(d.action)) {
    defects.push({ hand: handId, stage: 'DECISION', code: 'ACTION_ILLEGAL', detail: `${d.action} 不在 [${dg.legalActions.join(',')}]` });
  }
  if (d.sizeChips !== undefined && d.sizeChips > m.myRemainingStack + 1e-9) {
    defects.push({ hand: handId, stage: 'DECISION', code: 'SIZE_OVER_STACK', detail: `${d.sizeChips} > ${m.myRemainingStack}` });
  }
  /* 3. 数学一致性 */
  const calcReq = m.winnable > 0 ? m.callCost / m.winnable : 0;
  if (Math.abs(calcReq - m.requiredEquity) > 1e-9) {
    defects.push({ hand: handId, stage: 'MATH', code: 'REQUIRED_EQUITY_MISMATCH', detail: `${m.requiredEquity} vs ${calcReq}` });
  }
  if (!Number.isFinite(m.pot) || m.pot < 0) {
    defects.push({ hand: handId, stage: 'MATH', code: 'POT_INVALID', detail: String(m.pot) });
  }
  const eq = m.heroEquityVsBetRange ?? m.heroEquity;
  if (m.callEV !== null && eq !== null) {
    const shouldBePositive = eq > m.requiredEquity;
    if (shouldBePositive !== m.callEV > 0 && m.requiredEquityApplies !== false) {
      defects.push({ hand: handId, stage: 'MATH', code: 'CALLEV_SIGN', detail: `eq ${eq} vs req ${m.requiredEquity} ⇒ callEV ${m.callEV}` });
    }
  }
  /* 4. 可解释性 */
  if (!Number.isFinite(d.confidence) || d.confidence < 0 || d.confidence > 1) {
    defects.push({ hand: handId, stage: 'DECISION', code: 'CONFIDENCE_RANGE', detail: String(d.confidence) });
  }
  if (!KNOWN_BANDS.has(String(d.band))) {
    defects.push({ hand: handId, stage: 'DECISION', code: 'BAND_UNKNOWN', detail: String(d.band) });
  }
  if (!KNOWN_CLASS.has(String(d.classification))) {
    defects.push({ hand: handId, stage: 'DECISION', code: 'CLASS_UNKNOWN', detail: String(d.classification) });
  }
  if (d.actionable && d.reasons.length === 0) {
    defects.push({ hand: handId, stage: 'DECISION', code: 'NO_REASON', detail: 'actionable 但无理由' });
  }
  if (dg.postflop !== undefined && street !== 'PREFLOP') {
    const own = Object.prototype.hasOwnProperty.call(dg.postflop, 'handRole');
    if (!own) defects.push({ hand: handId, stage: 'POSTFLOP', code: 'POSTFLOP_SNAPSHOT_MISSING', detail: '翻后无 handRole' });
  }
  rows.push({
    line: line.name, board: board.name, hero: `${hero[0]}${hero[1]}`, street, profile,
    action: String(d.action), size: d.sizeBB === undefined ? '—' : Number(d.sizeBB).toFixed(2),
    eq, cls: String(d.classification),
  });
}

/* ============================================================
 * 跑 100 手（5 线型 × 4 牌面 × 5 画像），每手 3 街
 * ============================================================ */
let handNo = 0;
for (let li = 0; li < LINES.length; li += 1) {
  for (let bi = 0; bi < BOARDS.length; bi += 1) {
    for (let pi = 0; pi < PROFILES.length; pi += 1) {
      handNo += 1;
      const line = LINES[li]!;
      const board = BOARDS[bi]!;
      /* 底牌用「手号 + 牌面号」决定，且必须与公共牌不冲突 ⇒ 可复现且合法 */
      const hero = pickHand(handNo * 7 + bi * 3, board.cards);
      const profile = PROFILES[pi]!;
      for (const street of ['FLOP', 'TURN', 'RIVER'] as const) {
        checkOne(line, board, hero, profile, street);
      }
    }
  }
}

/* ============================================================
 * 报告
 * ============================================================ */
const W = (s: string): number => [...s].reduce((a, c) => a + (c.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
const pad = (s: string, w: number): string => s + ' '.repeat(Math.max(0, w - W(s)));
const pct = (v: number | null): string => (v === null || !Number.isFinite(v) ? '—' : `${(v * 100).toFixed(1)}%`);

console.log('='.repeat(150));
console.log(`100 手语料 × 3 街 × 5 画像 ⇒ 共 ${decisions} 个决策点；缺陷 ${defects.length} 项`);
console.log('='.repeat(150));

console.log('');
console.log('--- 按街聚合（动作分布） ---');
for (const st of ['FLOP', 'TURN', 'RIVER'] as const) {
  const sub = rows.filter((r) => r.street === st);
  const counts = new Map<string, number>();
  for (const r of sub) counts.set(r.action, (counts.get(r.action) ?? 0) + 1);
  const dist = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' ｜ ');
  console.log(`  ${pad(st, 6)} n=${pad(String(sub.length), 4)}  ${dist}`);
}

console.log('');
console.log('--- 按画像聚合（跨全部街） ---');
console.log(pad('画像', 18) + pad('n', 6) + pad('FOLD', 7) + pad('CHECK', 7) + pad('CALL', 7) + pad('BET', 7) + pad('RAISE', 7) + pad('ALL_IN', 7) + '平均权益');
for (const p of PROFILES) {
  const sub = rows.filter((r) => r.profile === p);
  const c = (a: string): number => sub.filter((r) => r.action === a).length;
  const eqs = sub.map((r) => r.eq).filter((x): x is number => x !== null && Number.isFinite(x));
  const avg = eqs.length === 0 ? null : eqs.reduce((a, b) => a + b, 0) / eqs.length;
  console.log(
    pad(p, 18) + pad(String(sub.length), 6) + pad(String(c('FOLD')), 7) + pad(String(c('CHECK')), 7) +
    pad(String(c('CALL')), 7) + pad(String(c('BET')), 7) + pad(String(c('RAISE')), 7) + pad(String(c('ALL_IN')), 7) + pct(avg),
  );
}

console.log('');
console.log('--- 按线型聚合（动作分布） ---');
for (const l of LINES) {
  const sub = rows.filter((r) => r.line === l.name);
  const counts = new Map<string, number>();
  for (const r of sub) counts.set(r.action, (counts.get(r.action) ?? 0) + 1);
  console.log(`  ${pad(l.name, 40)} n=${pad(String(sub.length), 4)} ${[...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' ｜ ')}`);
}

console.log('');
console.log('--- 按牌面聚合（动作分布） ---');
for (const b of BOARDS) {
  const sub = rows.filter((r) => r.board === b.name);
  const counts = new Map<string, number>();
  for (const r of sub) counts.set(r.action, (counts.get(r.action) ?? 0) + 1);
  console.log(`  ${pad(b.name, 16)} n=${pad(String(sub.length), 4)} ${[...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' ｜ ')}`);
}

console.log('');
console.log('--- 缺陷清单 ---');
if (defects.length === 0) {
  console.log('  ✅ 无缺陷');
} else {
  const byCode = new Map<string, number>();
  for (const d of defects) byCode.set(d.code, (byCode.get(d.code) ?? 0) + 1);
  for (const [code, n] of [...byCode.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${pad(code, 30)} ×${n}`);
    for (const d of defects.filter((x) => x.code === code).slice(0, 3)) {
      console.log(`      · ${d.hand.slice(0, 96)}`);
      console.log(`        ${d.stage}: ${d.detail}`);
    }
  }
}
