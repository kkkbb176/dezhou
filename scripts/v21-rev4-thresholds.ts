/**
 * Reviewer 4 · probe 1 — `profileMaterialityOf` 的阈值边界反转（1 ULP 两侧）
 *
 * 只读生产实现，不改任何 src 文件。
 * 运行：node --experimental-strip-types scripts/v21-rev4-thresholds.ts
 */
import {
  MATERIALITY_THRESHOLDS,
  ProfileMateriality,
  profileMaterialityOf,
} from '../src/domain/player/behaviorProfile.ts';

const T = MATERIALITY_THRESHOLDS;
const f = (x: number | null, d = 20): string =>
  x === null ? 'null' : Number.isFinite(x) ? x.toPrecision(20) : String(x);

console.log('=========== 0. 阈值本体 ===========');
console.log(JSON.stringify(T, null, 2));

/**
 * **真正直接**的判定路径：`equityA = 0` ⇒ `equityB − equityA ≡ equityB`（逐位），
 * `bluffMassA = 0` ⇒ 同理。这样 delta 原样进入比较，不经过任何加减。
 */
function verdict(eqDelta: number | null, massDelta: number): string {
  return profileMaterialityOf({
    equityA: eqDelta === null ? null : 0,
    equityB: eqDelta === null ? null : eqDelta,
    bluffMassA: 0,
    bluffMassB: massDelta,
    evA: 0,
    evB: 0,
    rangeDistance: 0,
  }).verdict;
}

/** 与 `reportVerdictConsistency.test.ts` 的 `verdictOf()` **逐字相同**的路径（base+delta 反推） */
function verdictTestHelper(eqDelta: number, massDelta: number): string {
  const equityA = 0.5;
  const equityB = equityA + eqDelta;
  const massA = 0.1;
  const massB = massA + massDelta;
  return profileMaterialityOf({ equityA, equityB, bluffMassA: massA, bluffMassB: massB, evA: 0, evB: 0, rangeDistance: 0 }).verdict;
}

/** 把 x 向指定方向移动 n 个 ULP（可逆的 nextafter 实现） */
function nextAfter(x: number, dir: 1 | -1, n = 1): number {
  let cur = x;
  for (let i = 0; i < n; i++) {
    const buf = new DataView(new ArrayBuffer(8));
    buf.setFloat64(0, cur);
    let bits = buf.getBigUint64(0);
    if (cur === 0) {
      bits = dir > 0 ? 1n : 0x8000000000000001n;
    } else if ((cur > 0) === (dir > 0)) {
      bits += 1n;
    } else {
      bits -= 1n;
    }
    buf.setBigUint64(0, bits);
    const nxt = buf.getFloat64(0);
    if (!Number.isFinite(nxt)) break;
    cur = nxt;
  }
  return cur;
}

console.log('\n=========== 1. 权益阈值边界（1 ULP 两侧）===========');
console.log('准备：ulp@0.005 =', nextAfter(0.005, 1) - 0.005);
console.log('准备：ulp@0.02  =', nextAfter(0.02, 1) - 0.02);
console.log('准备：ulp@0.05  =', nextAfter(0.05, 1) - 0.05);
console.log('准备：ulp@0.01  =', nextAfter(0.01, 1) - 0.01);

type Row = { name: string; eq: number; mass: number; direct: string; helper: string; helperMismatch: boolean };
const rows: Row[] = [];

for (const [name, thr] of [
  ['equityTrivial', T.equityTrivial],
  ['equityMaterial', T.equityMaterial],
  ['equityStrong', T.equityStrong],
] as const) {
  for (const side of [-1, 0, 1] as const) {
    const v = side === 0 ? thr : nextAfter(thr, side as 1 | -1, 1);
    const d = verdict(v, 0);
    const h = verdictTestHelper(v, 0);
    rows.push({ name: `${name}${side === 0 ? ' == 阈值' : side < 0 ? ' -1ulp' : ' +1ulp'}`, eq: v, mass: 0, direct: d, helper: h, helperMismatch: d !== h });
  }
}

for (const [name, thr] of [
  ['massTrivial', T.massTrivial],
  ['massMaterial', T.massMaterial],
] as const) {
  for (const side of [-1, 0, 1] as const) {
    const v = side === 0 ? thr : nextAfter(thr, side as 1 | -1, 1);
    const d = verdict(0, v);
    const h = verdictTestHelper(0, v);
    rows.push({ name: `${name}${side === 0 ? ' == 阈值' : side < 0 ? ' -1ulp' : ' +1ulp'}`, eq: 0, mass: v, direct: d, helper: h, helperMismatch: d !== h });
  }
}

for (const r of rows) {
  console.log(
    `${r.name.padEnd(24)} eq=${f(r.eq, 21)} mass=${f(r.mass, 21)}\n` +
      `    ⇒ 直接(A=0)=${r.direct.padEnd(9)} ｜ 测试助手(base=0.5 反推)=${r.helper.padEnd(9)} ｜ 一致=${r.helperMismatch ? 'N **助手改变结论**' : 'Y'}`,
  );
}

console.log('\n=========== 2. 「多 ULP / 1e-15 / 1e-9 / 1e-7」逼近 ===========');
for (const [name, thr] of [
  ['equityTrivial', T.equityTrivial],
  ['equityMaterial', T.equityMaterial],
  ['equityStrong', T.equityStrong],
] as const) {
  for (const eps of [1e-16, 1e-15, 1e-12, 1e-9, 1e-7]) {
    const lo = thr - eps;
    const hi = thr + eps;
    console.log(
      `${name} -${eps}: ${lo.toPrecision(20)} ⇒ ${verdict(lo, 0).padEnd(9)} | +${eps}: ${hi.toPrecision(20)} ⇒ ${verdict(hi, 0).padEnd(9)} | 显示 toFixed(2)=(${lo.toFixed(2)},${hi.toFixed(2)})`,
    );
  }
}
for (const eps of [1e-16, 1e-15, 1e-12, 1e-9, 1e-7]) {
  const lo = T.massMaterial - eps;
  const hi = T.massMaterial + eps;
  console.log(
    `massMaterial -${eps}: ${lo.toPrecision(20)} ⇒ ${verdict(0, lo).padEnd(9)} | +${eps}: ${hi.toPrecision(20)} ⇒ ${verdict(0, hi).padEnd(9)} | 显示 toFixed(2)=(${lo.toFixed(2)},${hi.toFixed(2)})`,
  );
}

console.log('\n=========== 3. 结合律：base + delta 反推是否逐位等于 delta ===========');
let mismatch = 0;
let total = 0;
for (const [name, thr] of [
  ['equityTrivial', T.equityTrivial],
  ['equityMaterial', T.equityMaterial],
  ['equityStrong', T.equityStrong],
] as const) {
  for (const side of [-1, 0, 1] as const) {
    const v = side === 0 ? thr : nextAfter(thr, side as 1 | -1, 1);
    for (const base of [0.5, 0.6, 0.42, 0.123456789, 1 / 3]) {
      const back = base + v - base;
      total++;
      if (back !== v) {
        mismatch++;
        console.log(`  ✖ base=${base} delta=${v.toPrecision(20)} ⇒ 反推=${back.toPrecision(20)}（差 ${(back - v).toExponential(3)}）`);
      }
    }
  }
}
console.log(`  权益：base+delta-base !== delta 的比例 = ${mismatch}/${total}`);

let m2 = 0;
let t2 = 0;
for (const thr of [T.massTrivial, T.massMaterial]) {
  for (const side of [-1, 0, 1] as const) {
    const v = side === 0 ? thr : nextAfter(thr, side as 1 | -1, 1);
    for (const base of [0.1, 0.05, 0.3, 0.123456789, 1 / 3]) {
      const back = base + v - base;
      t2++;
      if (back !== v) {
        m2++;
        console.log(`  ✖ 质量 base=${base} delta=${v.toPrecision(20)} ⇒ 反推=${back.toPrecision(20)}（差 ${(back - v).toExponential(3)}）`);
      }
    }
  }
}
console.log(`  质量：base+delta-base !== delta 的比例 = ${m2}/${t2}`);

console.log('\n=========== 4. equityDelta === null ⇒ NO_EFFECT？===========');
console.log('A null / B number :', profileMaterialityOf({ equityA: null, equityB: 0.6, bluffMassA: 0.1, bluffMassB: 0.9, evA: 0, evB: 5, rangeDistance: 0.9 }).verdict);
console.log('A number / B null :', profileMaterialityOf({ equityA: 0.6, equityB: null, bluffMassA: 0.1, bluffMassB: 0.9, evA: 0, evB: 5, rangeDistance: 0.9 }).verdict);
console.log('both null         :', profileMaterialityOf({ equityA: null, equityB: null, bluffMassA: 0.1, bluffMassB: 0.9, evA: null, evB: null, rangeDistance: 0.9 }).verdict);
console.log('→ 即使 bluffMassDelta=0.8（远超 massMaterial=0.05）也判 NO_EFFECT ⇒ 质量维度在缺权益时被**完全忽略**');

console.log('\n=========== 5. NaN 能否穿过 Math.abs(NaN) < x ===========');
const nanVerdict = (label: string, eq: number, mass: number): void => {
  const out = profileMaterialityOf({ equityA: 0, equityB: eq, bluffMassA: 0, bluffMassB: mass, evA: 0, evB: 0, rangeDistance: 0 });
  console.log(
    `${label.padEnd(34)} verdict=${String(out.verdict).padEnd(9)} equityDelta=${f(out.equityDelta)} bluffMassDelta=${f(out.bluffMassDelta)} noteZh含NaN=${out.noteZh.includes('NaN')}`,
  );
};
nanVerdict('equityA=0, equityB=NaN', Number.NaN, 0);
nanVerdict('equityA=NaN, equityB=0.6', Number.NaN - 0, 0);
nanVerdict('equityB=Infinity', Number.POSITIVE_INFINITY, 0);
nanVerdict('equityA=Infinity,equityB=Infinity', Number.NaN, 0); // (Inf-Inf)=NaN
nanVerdict('bluffMassB=NaN（权益正常 0.001）', 0.001, Number.NaN);
nanVerdict('bluffMassB=NaN（权益 0.03）', 0.03, Number.NaN);

const infOut = profileMaterialityOf({ equityA: 0, equityB: Number.POSITIVE_INFINITY, bluffMassA: 0, bluffMassB: 0, evA: 0, evB: 0, rangeDistance: 0 });
console.log('equityB=+Infinity ⇒', infOut.verdict, '| noteZh =', infOut.noteZh);

console.log('\n=========== 6. 判定分支真值表（直接枚举所有组合）===========');
const grid: string[] = [];
for (const eq of [0, 0.004999999, 0.005, 0.019999, 0.02, 0.049, 0.05, -0.05, -0.019, -0.006]) {
  for (const bm of [0, 0.00999, 0.01, 0.049, 0.05, -0.05]) {
    grid.push(`${String(eq).padStart(10)} / ${String(bm).padStart(8)} ⇒ ${verdict(eq, bm)}`);
  }
}
console.log(grid.join('\n'));

console.log('\n=========== 7. 非单调性检查：|equityDelta| 增大而 verdict 降级？===========');
let prevEq = -1;
let prevV = '';
let demotions = 0;
for (let eq = 0; eq <= 0.06; eq += 0.0005) {
  for (const bm of [0, 0.01, 0.05]) {
    const v = verdict(eq, bm);
    if (bm === 0) {
      const rank: Record<string, number> = { NO_EFFECT: 0, TRIVIAL: 1, MATERIAL: 2, STRONG: 3 };
      if (prevEq >= 0 && rank[v]! < rank[prevV]!) {
        demotions++;
        console.log(`  ✖ 降级：|eq|=${prevEq.toFixed(4)} ⇒ ${prevV}；|eq|=${eq.toFixed(4)} ⇒ ${v}`);
      }
      prevEq = eq;
      prevV = v;
    }
  }
}
console.log(`  权益维度单调性违例数 = ${demotions}`);

console.log('\n=========== 9. `equityTrivial` / `massTrivial` 是否是**死参数**？===========');
/*
 * 源码分支结构（behaviorProfile.ts:1121-1132）：
 *   A. |eq| < TRIV && |mass| < MTRIV           ⇒ TRIVIAL
 *   B. |eq| >= STRONG                          ⇒ STRONG
 *   C. |eq| >= MAT || |mass| >= MMAT           ⇒ MATERIAL
 *   D. 否则                                   ⇒ TRIVIAL
 * A 与 D **返回同一个常量** ⇒ 无论 TRIV/MTRIV 取何值，verdict 都不变。
 * 用一个与源码逐字同构的本地副本（独立重算）在网格上验证。
 */
const localVerdict = (
  eq: number,
  mass: number,
  thr: { TRIV: number; MTRIV: number; MAT: number; STRONG: number; MMAT: number },
): string =>
  Math.abs(eq) < thr.TRIV && Math.abs(mass) < thr.MTRIV
    ? 'TRIVIAL'
    : Math.abs(eq) >= thr.STRONG
      ? 'STRONG'
      : Math.abs(eq) >= thr.MAT || Math.abs(mass) >= thr.MMAT
        ? 'MATERIAL'
        : 'TRIVIAL';

const base = { TRIV: T.equityTrivial, MTRIV: T.massTrivial, MAT: T.equityMaterial, STRONG: T.equityStrong, MMAT: T.massMaterial };
const mutated = { ...base, TRIV: 0.0199999, MTRIV: 0.0499999 }; // 把 trivial 阈值抬到几乎等于 material

let diffLocal = 0;
let diffProd = 0;
let checked = 0;
for (let i = 0; i <= 260; i++) {
  const eq = i / 2600; // 0 .. 0.1 步长 ~3.85e-5
  for (let j = 0; j <= 130; j++) {
    const mass = j / 1300; // 0 .. 0.1
    checked++;
    if (localVerdict(eq, mass, base) !== localVerdict(eq, mass, mutated)) diffLocal++;
    if (verdict(eq, mass) !== localVerdict(eq, mass, base)) diffProd++;
  }
}
console.log(`  网格 ${checked} 点：把 equityTrivial→0.0199999 / massTrivial→0.0499999 后，本地同构判定变化数 = ${diffLocal}`);
console.log(`  生产 verdict 与本地同构重算不一致数 = ${diffProd}（0 ⇒ 本地副本忠实）`);
console.log('  ⇒ equityTrivial / massTrivial 对 verdict **零影响**（死参数）：分支 A 与分支 D 同为 TRIVIAL');

console.log('\n=========== 10. 展示值与判定值的矛盾（noteZh 四舍五入 vs 阈值）===========');
const showMismatch = (label: string, eq: number, mass: number): void => {
  const out = profileMaterialityOf({ equityA: 0, equityB: eq, bluffMassA: 0, bluffMassB: mass, evA: 0, evB: 0, rangeDistance: 0 });
  console.log(`${label}\n    verdict=${out.verdict}  精确 eqDelta=${eq.toPrecision(21)}  massDelta=${mass.toPrecision(21)}\n    noteZh=${out.noteZh}`);
};
showMismatch('权益差 = 0.05 − 1ULP（判定 MATERIAL，显示 5.00pp）', nextAfter(0.05, -1), 0);
showMismatch('权益差 = 0.05 恰好（判定 STRONG，显示 5.00pp）', 0.05, 0);
showMismatch('权益差 = 0.02 − 1ULP（判定 TRIVIAL，显示 2.00pp）', nextAfter(0.02, -1), 0);
showMismatch('质量差 = 0.05 − 1ULP（判定 TRIVIAL，显示 5.00pp）', 0, nextAfter(0.05, -1));
showMismatch('权益差 = 0.02 恰好（判定 MATERIAL，显示 2.00pp）', 0.02, 0);

console.log('eq=0.005（== equityTrivial，需 < 才是 TRIVIAL-lower）:', verdict(T.equityTrivial, 0), '（期望 TRIVIAL，落入 else 尾部）');
console.log('eq=0.005,mass=0.01（两个都恰好等于）       :', verdict(T.equityTrivial, T.massTrivial));
console.log('eq=0.0199,mass=0.05（质量恰好达标）        :', verdict(0.0199, T.massMaterial));
console.log('eq=0.05,mass=0                            :', verdict(T.equityStrong, 0), '（>= strong ⇒ STRONG）');
console.log('eq=0.05-1ulp,mass=0.05                    :', verdict(nextAfter(T.equityStrong, -1), T.massMaterial), '（权益差 1ULP 不到 strong ⇒ 降为 MATERIAL）');
console.log('eq=0.0499,mass=0                          :', verdict(0.0499, 0));
console.log('eq=0.049999999999999996,mass=0            :', verdict(nextAfter(T.equityStrong, -1), 0));
