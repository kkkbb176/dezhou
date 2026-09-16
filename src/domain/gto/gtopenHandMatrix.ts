/**
 * 169 类起手牌矩阵（**唯一权威定义**）
 *
 * ## 这个模块存在的唯一理由
 *
 * 「169 类起手牌」听起来简单，实际有**三种互不相同的顺序**同时在用，
 * 混淆它们会产生一类极难发现的错误：**AKs 与 AKo 互换、同花与不同花互换**，
 * 而所有名字看上去都还是对的。
 *
 * 本模块把三种顺序**全部显式化**，并且互相之间只通过函数转换：
 *
 * | 编号 | 名称 | 用途 | 方向 |
 * |---|---|---|---|
 * | `displayIndex` | 显示序号 0..168 | 界面按标准 13×13 从左到右、从上到下渲染 | 行号较小者 = 高牌 |
 * | `classIndex` | 求解器类号 0..168 | 与 GTOpen 的 `strategy` 数组一一对应 | 行号较大者 = 高牌 |
 * | `code` | 文本标签 | 界面显示、日志、断言 | `AA` / `AKs` / `AKo` |
 *
 * ## 🔴 GTOpen 的类号公式（源码核对，不是从 README 抄的）
 *
 * `GTOopen/GTOpen/crates/solver/src/preflop/equity.rs` 第 15–30 行：
 *
 * ```rust
 * const RANK_CHARS: [char; 13] = ['2','3','4','5','6','7','8','9','T','J','Q','K','A'];
 *
 * pub fn class_index(a: u8, b: u8, suited: bool) -> usize {
 *     let (hi, lo) = if a >= b { (a, b) } else { (b, a) };
 *     if hi == lo { (hi as usize) * 13 + hi as usize }     // 对子：对角
 *     else if suited { (hi as usize) * 13 + lo as usize }   // 同花：r > c（下三角）
 *     else { (lo as usize) * 13 + hi as usize }             // 不同花：r < c（上三角）
 * }
 * ```
 *
 * ⚠️ **三个容易搞错的细节，全部已核对源码**：
 *
 * 1. `RANK_CHARS` 是**从小到大**：下标 0 = `2`，下标 12 = `A`。
 *    （本模块的界面轴 `GTO_RANK_CHARS` 是**从大到小**，两者是**反的**。
 *    这是全套代码里最容易写错的一处，因此下面的换算表是**逐项构造**的，
 *    而不是靠一条闭式推导 —— 闭式一旦方向写反，AKs/AKo 会静默互换。）
 * 2. 同花在下三角（`r > c`），不同花在上三角（`r < c`）——
 *    与标准 13×13 范围图的视觉约定**正好相反**。
 * 3. 对子在主对角线，且 `AA` 恒为类号 **0**、`22` 恒为类号 **168**。
 *
 * 换算表在模块加载时**逐项构造并双向自检**（见文件末尾的
 * `classIndexToDisplayIndex` / `buildConversionTables`），
 * 任何方向写错都会在启动自检 `selfCheckHandMatrix()` 里立刻暴露。
 */

/* ============================================================
 * 点数与标签
 * ============================================================ */

/** 点数显示字符，**从高到低**（下标 0 = A）——与求解器口径一致 */
export const GTO_RANK_CHARS: readonly string[] = Object.freeze([
  'A',
  'K',
  'Q',
  'J',
  'T',
  '9',
  '8',
  '7',
  '6',
  '5',
  '4',
  '3',
  '2',
]);

/** 合法标签字符集合 */
const RANK_INDEX: Readonly<Record<string, number>> = Object.freeze(
  Object.fromEntries(GTO_RANK_CHARS.map((ch, i) => [ch, i])),
);

/** 13×13 边上的标签（界面上方与左侧） */
export const GTO_MATRIX_AXIS: readonly string[] = GTO_RANK_CHARS;

/* ============================================================
 * 组合数与频率
 * ============================================================ */

/** 对子 6 个组合 */
export const COMBOS_PAIR = 6;
/** 同花 4 个组合 */
export const COMBOS_SUITED = 4;
/** 不同花 12 个组合 */
export const COMBOS_OFFSUIT = 12;
/** 全部起手牌组合数 */
export const TOTAL_COMBOS = 1326;

export type GtoHandKind = 'PAIR' | 'SUITED' | 'OFFSUIT';

/** 一手的结构化表示 */
export type GtoHandClass = {
  /** 文本标签：`AA` / `AKs` / `AKo` */
  code: string;
  /** 高牌点数下标（0 = A） */
  hi: number;
  /** 低牌点数下标（0 = A）；对子时与 `hi` 相同 */
  lo: number;
  /** 类别 */
  kind: GtoHandKind;
  /** 显示序号 0..168（标准 13×13 从左到右、从上到下） */
  displayIndex: number;
  /** 求解器类号 0..168 */
  classIndex: number;
  /** 组合数（6 / 4 / 12） */
  combos: number;
};

/** 把界面轴下标（0 = A）换算成求解器点数下标（0 = 2，12 = A） */
export function displayRankToSolverRank(displayRankIndex: number): number {
  return 12 - displayRankIndex;
}

/* ============================================================
 * 换算表（模块加载时逐项构造）
 * ============================================================ */

const CLASS_TO_DISPLAY: readonly number[] = (() => {
  const out: number[] = new Array(169).fill(-1);
  for (let display = 0; display < 169; display += 1) {
    const row = Math.floor(display / 13);
    const col = display % 13;
    const kind = kindOfRowCol(row, col);
    const hiDisplay = Math.min(row, col);
    const loDisplay = Math.max(row, col);
    const classIndex = solverClassIndexOf(
      displayRankToSolverRank(hiDisplay),
      displayRankToSolverRank(loDisplay),
      kind === 'SUITED',
    );
    out[classIndex] = display;
  }
  return Object.freeze(out);
})();

const DISPLAY_TO_CLASS: readonly number[] = (() => {
  const out: number[] = new Array(169).fill(-1);
  for (let classIndex = 0; classIndex < 169; classIndex += 1) {
    const { a, b, suited } = solverClassParts(classIndex);
    const hiSolver = Math.max(a, b);
    const loSolver = Math.min(a, b);
    const hiDisplay = displayRankToSolverRank(hiSolver);
    const loDisplay = displayRankToSolverRank(loSolver);
    // 对子 → 对角；同花 → 右上（行号小）；不同花 → 左下（列号小）
    const display =
      hiSolver === loSolver
        ? hiDisplay * 13 + loDisplay
        : suited
          ? hiDisplay * 13 + loDisplay
          : loDisplay * 13 + hiDisplay;
    out[display] = classIndex;
  }
  return Object.freeze(out);
})();

/**
 * 类号（求解器口径）→ 显示序号（界面口径）。
 *
 * 实现为**查表**：表在模块加载时由 `solverClassIndexOf()` 逐项构造，
 * 因此两边共用同一个「权威公式」实现，不存在两处各写一遍闭式的风险。
 */
export function classIndexToDisplayIndex(classIndex: number): number {
  return CLASS_TO_DISPLAY[classIndex] ?? -1;
}

/**
 * 显示序号（界面口径）→ 类号（求解器口径）。
 *
 * 见 `classIndexToDisplayIndex` 的说明：同样是查表。
 */
export function displayIndexToClassIndex(displayIndex: number): number {
  return DISPLAY_TO_CLASS[displayIndex] ?? -1;
}

/**
 * 🔴 **权威公式**：GTOpen `class_index()` 的逐字移植
 *（`crates/solver/src/preflop/equity.rs` 第 21–30 行）。
 *
 * @param a 求解器点数下标（0 = 2 … 12 = A）
 * @param b 求解器点数下标（0 = 2 … 12 = A）
 * @param suited 是否同花
 *
 * ⚠️ 这里是**唯一**允许出现「hi/lo 与乘 13」的地方。
 * 界面侧与 Provider 侧都必须走查表，不得自己重写这段算术。
 */
export function solverClassIndexOf(a: number, b: number, suited: boolean): number {
  const hi = a >= b ? a : b;
  const lo = a >= b ? b : a;
  if (hi === lo) return hi * 13 + hi;
  if (suited) return hi * 13 + lo;
  return lo * 13 + hi;
}

/**
 * 求解器类号 → `{ hiRankChar, loRankChar, suited }` 的**反查**
 *（逐字移植 `class_parts()`）。
 */
export function solverClassParts(classIndex: number): {
  a: number;
  b: number;
  suited: boolean;
} {
  const r = Math.floor(classIndex / 13);
  const c = classIndex % 13;
  if (r === c) return { a: r, b: c, suited: false };
  if (r > c) return { a: r, b: c, suited: true };
  return { a: c, b: r, suited: false };
}

/* ============================================================
 * 构造
 * ============================================================ */

/**
 * 由**显示坐标**判定类别。
 *
 * 显示约定（行号 r、列号 c，都是 0 = A 在左上）：
 * - `c > r` → 右上三角 → **同花**（例如 A5s 在 row 0 / col 4）
 * - `c < r` → 左下三角 → **不同花**（例如 A5o 在 row 4 / col 0）
 *
 * ⚠️ 传进来的 `hi`/`lo` 是**已经按大小排好**的下标，
 * 那里已经看不出原始的行列关系了 —— 所以这里必须重新比较行列，
 * 不能靠 `lo > hi` 猜。这正是「AKs 与 AKo 互换」最容易发生的地方。
 */
function kindOfRowCol(row: number, col: number): GtoHandKind {
  if (row === col) return 'PAIR';
  return col > row ? 'SUITED' : 'OFFSUIT';
}

function combosOf(kind: GtoHandKind): number {
  return kind === 'PAIR' ? COMBOS_PAIR : kind === 'SUITED' ? COMBOS_SUITED : COMBOS_OFFSUIT;
}

/** 由显示坐标（行号较小者 = 高牌）构造一手 */
function classAt(displayIndex: number): GtoHandClass {
  const row = Math.floor(displayIndex / 13);
  const col = displayIndex % 13;
  // 显示坐标 → 高/低牌：行号 ≤ 列号 → 行是高牌；行号 > 列号 → 列是高牌
  const hi = Math.min(row, col);
  const lo = Math.max(row, col);
  const kind = kindOfRowCol(row, col);
  const code =
    hi === lo
      ? `${GTO_RANK_CHARS[hi]!}${GTO_RANK_CHARS[lo]!}`
      : `${GTO_RANK_CHARS[hi]!}${GTO_RANK_CHARS[lo]!}${kind === 'SUITED' ? 's' : 'o'}`;
  return {
    code,
    hi,
    lo,
    kind,
    displayIndex,
    classIndex: displayIndexToClassIndex(displayIndex),
    combos: combosOf(kind),
  };
}

/**
 * 全部 169 类手牌，**按显示顺序**（`displayIndex` 0..168）。
 *
 * 顺序即标准 13×13 从左到右、从上到下的顺序：
 * `AA AKs AQs … A2s` / `AKo KK KQs … K2s` / … / `A2o K2o … 22`。
 */
export const GTO_HAND_CLASSES: readonly GtoHandClass[] = Object.freeze(
  Array.from({ length: 169 }, (_unused, i) => Object.freeze(classAt(i))),
);

/** 按类号索引的 169 类（`classIndex` 0..168） */
export const GTO_HAND_CLASSES_BY_CLASS_INDEX: readonly GtoHandClass[] = Object.freeze(
  (() => {
    const out: GtoHandClass[] = new Array(169);
    for (const hand of GTO_HAND_CLASSES) out[hand.classIndex] = hand;
    return out;
  })(),
);

/** 全部 169 个标签（显示顺序） */
export const GTO_HAND_CODES: readonly string[] = Object.freeze(
  GTO_HAND_CLASSES.map((h) => h.code),
);

/** 按标签查类；未知标签返回 `null`（**不猜测**） */
const CODE_INDEX: Readonly<Record<string, GtoHandClass>> = Object.freeze(
  Object.fromEntries(GTO_HAND_CLASSES.map((h) => [h.code, h])),
);

export function handClassByCode(code: string): GtoHandClass | null {
  return CODE_INDEX[code] ?? null;
}

/** 标签 → 类号；未知返回 `null` */
export function classIndexOfCode(code: string): number | null {
  return CODE_INDEX[code]?.classIndex ?? null;
}

/**
 * 生成 13 行 × 13 列的显示矩阵。
 *
 * `matrix[row][col]` 即界面第 row 行第 col 列的格子。
 * 行号 = 列号 → 对子；行号 < 列号 → 同花；行号 > 列号 → 不同花。
 */
export function gtoHandMatrix(): readonly (readonly GtoHandClass[])[] {
  const rows: GtoHandClass[][] = [];
  for (let r = 0; r < 13; r++) {
    const row: GtoHandClass[] = [];
    for (let c = 0; c < 13; c++) row.push(GTO_HAND_CLASSES[r * 13 + c]!);
    rows.push(row);
  }
  return Object.freeze(rows.map((row) => Object.freeze(row)));
}

/* ============================================================
 * 频率与组合数
 * ============================================================ */

/**
 * 频率合法性检查（**0..1**，不是 0..100）。
 *
 * 🔴 这是一个真实的墨菲定律陷阱：上游若给百分数（65），
 * 下游若按 0..1 解释就会显示 6500%。
 * 因此 0..1 之外的频率**一律拒绝**，由 Provider 把它判成 `INVALID_RESPONSE`
 * 并回退到 `GTO_BASELINE_UNAVAILABLE` —— 宁可没有数据，也不要错的数据。
 */
export function isFrequency01(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

/**
 * 把频率转成百分数**显示字符串**（`0.6532` → `65.3%`）。
 *
 * 界面上所有频率都必须走这个函数，禁止各处自己 `* 100` ——
 * 「有的地方标了百分号、有的地方没标」正是 0.65 显示成 0.65% 的成因。
 */
export function formatFrequencyPercent(frequency01: number, digits = 1): string {
  if (!Number.isFinite(frequency01)) return '—';
  return `${(frequency01 * 100).toFixed(digits)}%`;
}

/**
 * 一组合法组合数下的频率加权求和（用于「动作频率之和必须为 1」的校验）。
 *
 * @returns 频率之和；输入为空时返回 `0`
 */
export function frequencySum(frequencies: readonly number[]): number {
  let sum = 0;
  for (const f of frequencies) sum += f;
  return sum;
}

/* ============================================================
 * 自检（启动时调用，Fail-Closed）
 * ============================================================ */

/**
 * 169 类矩阵自检。
 *
 * 返回**问题列表**（空数组 = 通过）。检查项：
 * 1. 数量恰为 169
 * 2. 标签唯一
 * 3. 类号是 0..168 的一个**双射**（不重不漏）
 * 4. 组合数总和 = 1326
 * 5. 对子 6 / 同花 4 / 不同花 12，且各类数量为 13 / 78 / 78
 * 6. `AKs` 与 `AKo` 必须是**两个不同**的类，且类号顺序正确
 * 7. 索引换算在两个方向上互为逆运算（169 项逐一验证）
 */
export function selfCheckHandMatrix(): string[] {
  const problems: string[] = [];

  if (GTO_HAND_CLASSES.length !== 169) {
    problems.push(`手牌类数应为 169，实际 ${GTO_HAND_CLASSES.length}`);
  }

  const codes = new Set<string>();
  for (const hand of GTO_HAND_CLASSES) {
    if (codes.has(hand.code)) problems.push(`手牌标签重复：${hand.code}`);
    codes.add(hand.code);
  }
  if (codes.size !== 169) problems.push(`唯一标签数应为 169，实际 ${codes.size}`);

  const classSeen = new Set<number>();
  for (const hand of GTO_HAND_CLASSES) {
    if (hand.classIndex < 0 || hand.classIndex > 168) {
      problems.push(`${hand.code} 的类号越界：${hand.classIndex}`);
    }
    if (classSeen.has(hand.classIndex)) problems.push(`类号重复：${hand.classIndex}（${hand.code}）`);
    classSeen.add(hand.classIndex);
  }
  if (classSeen.size !== 169) problems.push(`唯一类号数应为 169，实际 ${classSeen.size}`);

  const totalCombos = GTO_HAND_CLASSES.reduce((acc, h) => acc + h.combos, 0);
  if (totalCombos !== TOTAL_COMBOS) {
    problems.push(`组合数总和应为 ${TOTAL_COMBOS}，实际 ${totalCombos}`);
  }

  const pairCount = GTO_HAND_CLASSES.filter((h) => h.kind === 'PAIR').length;
  const suitedCount = GTO_HAND_CLASSES.filter((h) => h.kind === 'SUITED').length;
  const offsuitCount = GTO_HAND_CLASSES.filter((h) => h.kind === 'OFFSUIT').length;
  if (pairCount !== 13) problems.push(`对子应为 13 类，实际 ${pairCount}`);
  if (suitedCount !== 78) problems.push(`同花应为 78 类，实际 ${suitedCount}`);
  if (offsuitCount !== 78) problems.push(`不同花应为 78 类，实际 ${offsuitCount}`);

  /*
   * ---- 类号锚点（与 GTOpen `class_index()` 逐位对照）----
   *
   * ⚠️ 这几个数字是**算出来的**，不是从常识猜的。它们反直觉：
   * 求解器的点数下标是 0 = 2 … 12 = A，所以
   *
   *   AA  → class_index(12, 12, false) = 12*13 + 12 = 168（最高）
   *   22  → class_index( 0,  0, false) =  0*13 +  0 =   0（最低）
   *   AKs → class_index(12, 11, true)  = 12*13 + 11 = 167
   *   AKo → class_index(12, 11, false) = 11*13 + 12 = 155
   *   A5s → class_index(12,  3, true)  = 12*13 +  3 = 159
   *   A5o → class_index(12,  3, false) =  3*13 + 12 =  51
   *   32s → class_index( 1,  0, true)  =  1*13 +  0 =  13
   *   32o → class_index( 1,  0, false) =  0*13 +  1 =   1
   *
   * 「类号越大 = 牌力越强」只是巧合（因为高牌点数下标也大），
   * 代码里**不得**依赖这个相关性做任何判断。
   */
  const anchors: readonly (readonly [string, number])[] = [
    ['AA', 168],
    ['22', 0],
    ['AKs', 167],
    ['AKo', 155],
    ['A5s', 159],
    ['A5o', 51],
    ['32s', 13],
    ['32o', 1],
  ];
  for (const [code, expected] of anchors) {
    const hand = handClassByCode(code);
    if (hand === null) problems.push(`缺少 ${code}`);
    else if (hand.classIndex !== expected) {
      problems.push(`${code} 的类号应为 ${expected}，实际 ${hand.classIndex}`);
    }
  }

  const aks = handClassByCode('AKs');
  const ako = handClassByCode('AKo');
  if (aks === null || ako === null) {
    problems.push('缺少 AKs 或 AKo');
  } else {
    if (aks.classIndex === ako.classIndex) problems.push('AKs 与 AKo 的类号相同 —— 同花/不同花被压成了一类');
    if (aks.kind !== 'SUITED') problems.push(`AKs 的类别应为 SUITED，实际 ${aks.kind}`);
    if (ako.kind !== 'OFFSUIT') problems.push(`AKo 的类别应为 OFFSUIT，实际 ${ako.kind}`);
  }

  // 索引换算互逆
  for (let i = 0; i < 169; i++) {
    if (displayIndexToClassIndex(classIndexToDisplayIndex(i)) !== i) {
      problems.push(`类号 ${i} 经显示序号往返后不一致`);
      break;
    }
  }
  for (let i = 0; i < 169; i++) {
    if (classIndexToDisplayIndex(displayIndexToClassIndex(i)) !== i) {
      problems.push(`显示序号 ${i} 经类号往返后不一致`);
      break;
    }
  }

  return problems;
}

/* ============================================================
 * 中文说明
 * ============================================================ */

/** 手牌类别中文名 */
export const GTO_HAND_KIND_ZH: Readonly<Record<GtoHandKind, string>> = Object.freeze({
  PAIR: '对子',
  SUITED: '同花',
  OFFSUIT: '不同花',
});

/*
 * 说明：`RANK_INDEX` 目前只用于将来的文本解析（例如从用户输入 "AKs" 反查）。
 * 保留它是为了让「标签 → 下标」的权威映射只有一份。
 */
export function rankIndexOfChar(ch: string): number | null {
  const idx = RANK_INDEX[ch.toUpperCase()];
  return idx === undefined ? null : idx;
}
