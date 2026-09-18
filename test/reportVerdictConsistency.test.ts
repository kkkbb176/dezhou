/**
 * REPORT VERDICT CONSISTENCY GATE（V2 收口 · 消灭多重真相源）
 *
 * ## 这一组测试守的是什么
 *
 * V2 交付时出现过一次真实的**多重真相源**事故：
 *
 * ```text
 * profileMaterialityOf() 的规则  ⇒ TRIVIAL   （0.0180 < 0.02 且 0.0422 < 0.05）
 * 报告 §二十五 正文             ⇒ 「两项都刚好没到阈值」（正确）
 * 报告页首 verdict 一栏         ⇒ MATERIAL   （**手工填写，错**）
 * ```
 *
 * 也就是说：**规则只有一份，结论却手写了两份而且互相矛盾。**
 * 本文件把三处钉成同一个来源：
 *
 * ```text
 * 生产计算 profileMaterialityOf()  ==  报告页首 verdict  ==  报告 §二十五 正文
 * ```
 *
 * ## 🔴 数值展示与业务判定必须分离
 *
 * 业务判定的**唯一**依据是 `MATERIALITY_THRESHOLDS` 的数值比较。
 * **禁止**把 `toFixed(...)` 之后的字符串再拿去判定 —— 例如
 * `(0.0199999).toFixed(2) === '0.02'`，用字符串判会得出 MATERIAL，
 * 而规则说它**低于**阈值必须是 TRIVIAL。`Case D` 就是专门锁这一条的。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  MATERIALITY_THRESHOLDS,
  ProfileMateriality,
  profileMaterialityOf,
} from '../src/domain/player/behaviorProfile.ts';

const REPORT_URL = new URL('../reports/PLAYER_PROFILE_QUANTIFICATION_V2_REPORT.md', import.meta.url);

/** 只走生产函数的判定路径 —— 测试里**不重写**任何阈值或规则 */
function verdictOf(equityDelta: number, bluffMassDelta: number): string {
  // 用基准值 + delta 反推 A/B，避免测试自己实现一遍 delta 语义
  const equityA = 0.5;
  const equityB = equityA + equityDelta;
  const massA = 0.1;
  const massB = massA + bluffMassDelta;
  return profileMaterialityOf({
    equityA,
    equityB,
    bluffMassA: massA,
    bluffMassB: massB,
    evA: 0,
    evB: 0,
    rangeDistance: 0,
  }).verdict;
}

/* ============================================================
 * Case A–C：三条判定路径
 * ============================================================ */

test('Case A：V2 实测值（equityDelta 0.018 / massDelta 0.0422）必须是 TRIVIAL', () => {
  // 这两个数字是 V2 §四十八 A/B 表的**实测值**，不得为了变绿而修改
  assert.equal(
    verdictOf(0.018, 0.0422),
    ProfileMateriality.TRIVIAL,
    '两个维度都未达阈值 ⇒ 只能是 TRIVIAL',
  );
});

test('Case B：equityDelta ≥ equityMaterial ⇒ MATERIAL', () => {
  assert.equal(verdictOf(MATERIALITY_THRESHOLDS.equityMaterial, 0), ProfileMateriality.MATERIAL);
  assert.equal(verdictOf(0.04, 0), ProfileMateriality.MATERIAL, '明显超过阈值也应是 MATERIAL');
});

test('Case C：仅靠 bluffMassDelta ≥ massMaterial 也必须是 MATERIAL', () => {
  // 权益维度低于阈值（0.001 < 0.02），只有质量维度达标
  assert.equal(
    verdictOf(0.001, MATERIALITY_THRESHOLDS.massMaterial),
    ProfileMateriality.MATERIAL,
    '质量维度单独达标即可判 MATERIAL（两个维度是「或」关系）',
  );
});

/* ============================================================
 * Case D：浮点边界 —— 展示与判定必须分离
 * ============================================================ */

test('Case D：浮点边界不得因四舍五入而错位（禁止 toFixed 字符串参与判定）', () => {
  const { equityMaterial, massMaterial } = MATERIALITY_THRESHOLDS;

  // --- 权益维度边界 ---
  // 低于阈值，但 toFixed(2) 会四舍五入成 "0.02" ⇒ 字符串判定会误判 MATERIAL
  const justBelow = equityMaterial - 1e-7;
  assert.equal(
    justBelow.toFixed(2),
    '0.02',
    '前提校验：这个值经 toFixed(2) 确实会显示成 0.02（正是陷阱所在）',
  );
  assert.equal(
    verdictOf(justBelow, 0),
    ProfileMateriality.TRIVIAL,
    `低于阈值必须是 TRIVIAL（哪怕显示成 0.02）：${justBelow}`,
  );

  // 恰好等于阈值 ⇒ MATERIAL（规则用的是 `>=`）
  assert.equal(
    verdictOf(equityMaterial, 0),
    ProfileMateriality.MATERIAL,
    '恰好等于阈值必须判 MATERIAL（规则是 >=）',
  );
  // 略高于阈值
  assert.equal(verdictOf(equityMaterial + 1e-7, 0), ProfileMateriality.MATERIAL);

  // --- 质量维度边界 ---
  const massBelow = massMaterial - 1e-7;
  assert.equal(
    verdictOf(0, massBelow),
    ProfileMateriality.TRIVIAL,
    `质量维度低于阈值必须是 TRIVIAL：${massBelow}`,
  );
  assert.equal(verdictOf(0, massMaterial), ProfileMateriality.MATERIAL, '恰好等于阈值 ⇒ MATERIAL');
  assert.equal(verdictOf(0, massMaterial + 1e-7), ProfileMateriality.MATERIAL);
});

test('Case D2：TRIVIAL 下界（equityTrivial / massTrivial）也必须是数值比较', () => {
  const { equityTrivial, massTrivial } = MATERIALITY_THRESHOLDS;
  // 两个维度都极小 ⇒ TRIVIAL（下界分支）
  assert.equal(verdictOf(0, 0), ProfileMateriality.TRIVIAL);
  assert.equal(verdictOf(equityTrivial - 1e-9, massTrivial - 1e-9), ProfileMateriality.TRIVIAL);
  // 仅权益越过 trivial 下界、但远未到 material ⇒ 仍是 TRIVIAL（不是 NO_EFFECT，也不够 MATERIAL）
  assert.equal(verdictOf(equityTrivial + 1e-9, 0), ProfileMateriality.TRIVIAL);
});

/* ============================================================
 * 报告一致性：代码 verdict == 页首 == §二十五 正文
 * ============================================================ */

test('报告 verdict 必须与生产规则一致，且不得出现手工填写的矛盾结论', () => {
  const md = readFileSync(REPORT_URL, 'utf8');

  // V2 §四十八 A/B 表的实测 delta（与 Case A 同一组数字）
  const expected = verdictOf(0.018, 0.0422);

  // 报告中所有 `PROFILE_RANGE_INFLUENCE = X` 出现处都必须等于规则输出
  const summary = [...md.matchAll(/PROFILE_RANGE_INFLUENCE\s*=\s*([A-Z_]+)/g)].map((m) => m[1]!);
  assert.ok(summary.length >= 1, '报告必须给出 PROFILE_RANGE_INFLUENCE');
  for (const v of summary) {
    assert.equal(
      v,
      expected,
      `报告里的 PROFILE_RANGE_INFLUENCE=${v} 与 profileMaterialityOf() 的 ${expected} 不一致 —— ` +
        'verdict 不允许手工填写，必须复用生产计算',
    );
  }

  // §二十五 正文的 `materiality = X` 也必须一致
  const body = [...md.matchAll(/^\s*materiality\s*=\s*([A-Z_]+)/gm)].map((m) => m[1]!);
  assert.ok(body.length >= 1, '报告 §二十五 必须给出 materiality 结论');
  for (const v of body) {
    assert.equal(v, expected, `§二十五 正文 materiality=${v} 与规则输出 ${expected} 不一致`);
  }
});
