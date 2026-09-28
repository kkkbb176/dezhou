/*
 * 阶段三：88% 弃牌率的可靠性审查 —— 第一性原理推导 + 与引擎实测交叉验证。
 *
 * 机制（读出 src/app/manualInput/raiseResponse.ts:281-322）：
 *   price    = villainAdd / finalPot              ← 他自己的跟注赔率（数学确定）
 *   required = price + marginOfStreet(street)     ← margin: FLOP 0.16 / TURN 0.14 / RIVER 0.10
 *   strength = RAISE_RESPONSE_BAND_STRENGTH[band] + playability   ← **离散阶梯**
 *   continueIndex = strength × callScale − 0.05 × foldScale
 *   继续 ⟺ continueIndex ≥ required ；否则计入 foldMass
 *
 * ⇒ 因为 strength 只取 9 个离散值，`P(弃)` 是 required 的**阶梯函数**。
 *   本脚本用「现金流的独立复算」推出每个尺寸的 required，再判定各强度带继续/弃牌，
 *   与引擎实测的 P(弃) 对照。
 */

const BB = 100, potBefore = 2300, heroC = 350, villainC = 1400;
const heroRem = 10000 - 250 - 350;      // 94BB
const villainRem = 10000 - 250 - 1400;  // 83.5BB

/** 与 contextBuilder 逐式对应的现金流（整数筹码） */
function cash(raiseTo) {
  const heroAdd = Math.max(0, raiseTo - heroC);
  const villainAddRaw = Math.max(0, raiseTo - villainC);
  const villainAdd = Math.min(villainAddRaw, villainRem);
  const contested = Math.max(0, Math.min(heroAdd, villainC + villainAdd - heroC));
  const finalPot = potBefore + contested + villainAdd;
  return { heroAdd, villainAdd, contested, finalPot };
}

/** 强度带 → 继续强度代理（raiseResponse.ts:76-86） */
const BAND = {
  NUT: 0.97, STRONG_MADE: 0.86, TWO_PAIR: 0.72, OVERPAIR: 0.62,
  TOP_PAIR_GOOD: 0.52, TOP_PAIR_WEAK: 0.4, MIDDLE_PAIR: 0.3, WEAK_PAIR: 0.2, AIR: 0.07,
};
const MARGIN_FLOP = 0.16;
/** 中性倾向：callScale = 1、foldScale = 1（默认无读牌） */
const TENDENCY_OFFSET = 0.05;

const sizes = [2450, 2625, 3150, 4200, 5250, 6300, 8400, 9750];

console.log('=== 每个尺寸的 price / required 与「继续的强度带」 ===');
console.log('sizeBB | raiseTo | villainAdd | finalPot |  price | required | 继续的带（阈值 ≥ required）');
const rows = [];
for (const to of sizes) {
  const c = cash(to);
  const price = c.villainAdd / c.finalPot;
  const required = price + MARGIN_FLOP;
  const continuing = Object.entries(BAND)
    .map(([k, s]) => [k, s - TENDENCY_OFFSET])
    .filter(([, thr]) => thr >= required)
    .map(([k]) => k);
  const folding = Object.keys(BAND).filter((k) => !continuing.includes(k));
  rows.push({ to, price, required, continuing, folding });
  console.log(
    `${String(to / BB).padStart(6)} | ${String(to).padStart(7)} | ${String(c.villainAdd).padStart(10)} | ${String(c.finalPot).padStart(8)} | ${price.toFixed(5)} | ${required.toFixed(5)} | ${continuing.join(', ')}`,
  );
}

console.log('\n=== 临界余量（fragility）：每个「刚好在门槛附近」的带 ===');
for (const r of rows) {
  for (const [k, s] of Object.entries(BAND)) {
    const thr = s - TENDENCY_OFFSET;
    const margin = thr - r.required;
    if (Math.abs(margin) < 0.02) {
      console.log(
        `  ${(r.to / BB).toString().padStart(5)}BB: 带 ${k} 阈值 ${thr.toFixed(3)} vs required ${r.required.toFixed(4)} ⇒ 余量 ${margin >= 0 ? '+' : ''}${margin.toFixed(5)}（${margin >= 0 ? '继续' : '弃牌'}）`,
      );
    }
  }
}

console.log('\n=== 与引擎实测 P(弃) 对照 ===');
const measured = { 24.5: 76.7, 26.3: 76.7, 31.5: 76.7, 42: 88.0, 52.5: 88.0, 63: 88.0, 84: 88.0, 97.5: 91.3 };
console.log('sizeBB | 弃牌带集合（推导） | 引擎实测 P(弃) | 推导是否自洽');
let prevKey = null;
for (const r of rows) {
  const key = r.folding.slice().sort().join(',');
  const bb = r.to / BB;
  const label = measured[bb] ?? measured[Number(bb.toFixed(1))];
  const changed = prevKey !== null && key !== prevKey;
  console.log(
    `${String(bb).padStart(6)} | ${(key.length > 46 ? key.slice(0, 46) + '…' : key).padEnd(48)} | ${String(label).padStart(13)}% | ${changed ? '★ 带集合在此改变（⇒ P(弃) 跳变）' : '（与上一档同集合）'}`,
  );
  prevKey = key;
}

console.log('\n=== 跳变幅度（由引擎实测反推各带的概率质量）===');
console.log('  76.7% → 88.0% = 11.3pp  ⇒「TOP_PAIR_GOOD」这一带的权重 ≈ 11.3% of 对手下注范围');
console.log('  88.0% → 91.3% =  3.3pp  ⇒「OVERPAIR」这一带的权重 ≈ 3.3% of 对手下注范围');
console.log('  （推导：31.5BB 的 required=0.4155 < 0.47 ⇒ 该带继续；42BB 的 required=0.4728 > 0.47 ⇒ 该带弃牌）');

console.log('\n=== 建议翻转所需的变化幅度（阶段三核心问答）===');
// RAISE EV = f×pot + c×(eq×finalPot − contested) + rr×rrEV
const f = 0.880, c = 0.077, rr = 0.043, pot = 2300, eq = 0.4101;
const cf = cash(4200);
const callBranch = eq * cf.finalPot - cf.contested;
const rrTerm = 1948.14 - (f * pot + c * callBranch); // 由引擎实测 EV 反解再加注项
const rrEV = rrTerm / rr;
console.log(`  42BB: f=${f} 弃牌项=${(f * pot).toFixed(2)} 跟注项=${(c * callBranch).toFixed(2)} 再加注项=${rrTerm.toFixed(2)}（⇒ rrEV≈${rrEV.toFixed(1)}）`);
const slope = pot - callBranch; // dEV/df
console.log(`  d(EV)/d(f) = pot − 跟注分支值 = ${pot} − (${callBranch.toFixed(2)}) = ${slope.toFixed(2)} 筹码/单位 f`);
const gap = 1948.14 - 1644.52;
console.log(`  RAISE 相对 CALL 的优势 = ${gap.toFixed(2)} 筹码`);
console.log(`  ⇒ 需要 P(弃) 下降 ${((gap / slope) * 100).toFixed(2)} 个百分点才会翻转`);
console.log(`  ⇒ 一个完整强度带 = 11.3pp ⇒ ${(gap / slope) * 100 > 11.3 ? '**一个带不足以翻转**（需要跨过约两个带）' : '一个带即可翻转'}`);
console.log(`  实测对照：CALLING_STATION 把 P(弃) 降到 74.7%（−13.3pp）⇒ 优势收窄到 90.94（仍在 ±167.50 容差带**内** ⇒ 已成掷硬币）`);
