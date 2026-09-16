/**
 * 两种「169 类手牌顺序」的**桥接与永久防线**
 *
 * ## 这个文件防的是什么
 *
 * 项目里同时存在**两套** 169 类顺序，而且它们**大部分不同**：
 *
 * | 顺序 | 出处 | 前几项 |
 * |---|---|---|
 * | **求解器显示顺序** | `GTO_HAND_CLASSES`（`gtopenHandMatrix.ts`） | `AA AKs AQs AJs … A2s AKo KK …`（13×13 逐行） |
 * | **先验权重顺序** | `allRankClassKeys()`（`preflopPriors.ts`） | `AA AKs AKo AQs AQo AJs AJo …`（逐高牌，先同花后不同花） |
 *
 * 实测只有 **5/169** 个位置恰好相同。
 *
 * ## 为什么必须挡住
 *
 * 把 GTOpen 的频率（按**显示顺序**给出）直接按序号灌进范围权重（按**先验顺序**
 * 索引）会得到：
 *
 * ```text
 * AKo 的频率 → 被当成 AQs 的权重
 * AJs 的频率 → 被当成 AQo 的权重
 * …（共 164 个错位）
 * ```
 *
 * 而且**不会有任何报错** —— 数组长度都是 169，类型都是 `number[]`。
 * 结果是一条看起来正常、实际上把「AKo 开池频率」当成「AQs」用的范围，
 * 进而算出一个**系统性错误但无法察觉**的权益。
 *
 * 这正是本项目反复强调的那类缺陷：**长度对得上、类型对得上、数字全错**。
 *
 * ## 因此这里做两件事
 *
 * 1. **钉住两套顺序的差异**（`gtoDisplayToPriorIndex`），让它变成可计算的东西
 * 2. **留一个按牌名对齐的通用转换器** —— 将来真的接 GTO 时用它，
 *    而不是按序号硬拷
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { GTO_HAND_CLASSES } from '../src/domain/gto/gtopenHandMatrix.ts';
import { allRankClassKeys } from '../src/app/manualInput/preflopPriors.ts';

const priorKeys: readonly string[] = allRankClassKeys();
const gtoCodes: readonly string[] = GTO_HAND_CLASSES.map((h) => h.code);

/* ============================================================
 * 一、先钉住「两套顺序确实不同」这个事实
 * ============================================================ */

test('CLASSORDER-01：两套 169 类顺序**大部分不同**（直接按序号对接必然错位）', () => {
  assert.equal(priorKeys.length, 169, '先验必须是 169 类');
  assert.equal(gtoCodes.length, 169, 'GTO 必须是 169 类');
  assert.equal(new Set(priorKeys).size, 169, '先验键不得重复');
  assert.equal(new Set(gtoCodes).size, 169, 'GTO 码不得重复');

  // 两边的**集合**必须完全相同（只是顺序不同）
  assert.deepEqual(
    [...new Set(gtoCodes)].sort(),
    [...new Set(priorKeys)].sort(),
    '两套顺序必须覆盖同一组 169 类牌型 —— 否则就有一边漏了牌',
  );

  let samePosition = 0;
  for (let i = 0; i < 169; i += 1) if (gtoCodes[i] === priorKeys[i]) samePosition += 1;

  /*
   * 🔴 这条断言是**故意写成「不相等」**的。
   *
   * 它记录的是一个**事实**：两边顺序不同。若将来有人「顺手把两套顺序统一」，
   * 这条会失败 —— 那时必须回来确认所有按序号对接的地方都已同步修改。
   * 静默统一是危险的：它会同时改变若干处依赖旧顺序的代码的行为。
   */
  assert.notEqual(
    samePosition,
    169,
    '两套顺序居然完全相同了 —— 若这是有意的统一，请同步检查所有按序号对接 GTO 频率的地方',
  );
  assert.ok(
    samePosition < 20,
    `两套顺序的相同位置应当很少（实测 5），实际 ${samePosition} —— 顺序可能被改动过`,
  );
});

test('CLASSORDER-02：差异必须是**可计算**的（给出 display → prior 的映射表）', () => {
  const map = priorIndexByGtoDisplay();
  assert.equal(map.length, 169, '映射表长度必须是 169');

  // 满射：每个先验序号恰好被一个 display 命中
  const hit = new Set(map);
  assert.equal(hit.size, 169, '映射必须是 169→169 的双射（否则有牌型被丢掉或重复）');

  // 逐项核对：map[i] 指向的先验键必须与 GTO 第 i 项**同名**
  for (let display = 0; display < 169; display += 1) {
    assert.equal(
      priorKeys[map[display]!],
      gtoCodes[display],
      `display ${display}（${gtoCodes[display]}）应当映射到先验的 ${gtoCodes[display]}，` +
        `实际指到 ${priorKeys[map[display]!]}`,
    );
  }
});

/* ============================================================
 * 二、通用转换器（将来接 GTO 时用它，不要按序号硬拷）
 * ============================================================ */

/** GTO 显示序号 → 先验序号 */
function priorIndexByGtoDisplay(): number[] {
  const indexByKey = new Map<string, number>();
  priorKeys.forEach((k, i) => indexByKey.set(k, i));
  return gtoCodes.map((code) => {
    const i = indexByKey.get(code);
    if (i === undefined) throw new Error(`先验里没有 ${code}`);
    return i;
  });
}

/**
 * 把**按 GTO 显示顺序**给出的 169 个值，重排成**先验顺序**。
 *
 * 这是将来接 GTO 范围时唯一允许使用的转换方式 ——
 * 它按**牌名**对齐，而不是按序号。
 */
function toPriorOrder(gtoOrderedValues: readonly number[]): number[] {
  assert.equal(gtoOrderedValues.length, 169, '输入必须是 169 个值');
  const map = priorIndexByGtoDisplay();
  const out = new Array<number>(169);
  for (let display = 0; display < 169; display += 1) {
    out[map[display]!] = gtoOrderedValues[display]!;
  }
  return out;
}

test('CLASSORDER-03：按牌名重排后，每一类的值都落在**正确**的牌上', () => {
  /*
   * 构造一个「每类值 = 它在 GTO 顺序里的序号」的向量。
   * 重排之后，值应当出现在**同名牌**的先验位置上。
   */
  const byDisplay = Array.from({ length: 169 }, (_v, i) => i);
  const byPrior = toPriorOrder(byDisplay);

  for (let display = 0; display < 169; display += 1) {
    const code = gtoCodes[display]!;
    const priorIndex = priorKeys.indexOf(code);
    assert.equal(
      byPrior[priorIndex],
      display,
      `${code} 的值应当是 ${display}，实际 ${String(byPrior[priorIndex])}`,
    );
  }
});

test('CLASSORDER-04：反证 —— **按序号直接拷**会错，而且错得很多', () => {
  /*
   * 这条是「为什么需要上面那个转换器」的**可直接观察的证据**。
   * 它模拟「直接按序号拷」这个错误做法，并证明它确实错位。
   */
  const byDisplay = Array.from({ length: 169 }, (_v, i) => i);
  let wrong = 0;
  for (let i = 0; i < 169; i += 1) {
    // 直接按序号拷：把 GTO 第 i 项放到先验第 i 项
    const codeAtPrior = priorKeys[i]!;
    const codeAtDisplay = gtoCodes[i]!;
    if (codeAtPrior !== codeAtDisplay) wrong += 1;
  }
  assert.ok(
    wrong > 100,
    `按序号直接拷应当错位很多（实测 164），实际 ${wrong} —— ` +
      '若这个数字变小，说明两套顺序被统一了，需要重新审视这个转换器是否还有必要',
  );
});
