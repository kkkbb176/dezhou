/**
 * 翻后升级 · P3：输出契约测试（2026-09）
 *
 * 使用者第二十三节要求：
 * - 内部保留完整数据（角色 / 牌面变化 / 范围压缩 / 价值评估 / 分数 / 置信度…）
 * - 界面只显示五项：**推荐动作 / 推荐尺度 / 主要原因 / 风险 / 置信度**
 * - 明确标注「启发式比较分不是 solver EV」
 * - 置信度的语义是**首选比次选好多少**，不是「牌有多强」
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import type { ManualHandInput } from '../src/app/manualInput/manualInput.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const OPTIONS = { rules: RULES, asOf: 1_757_000_000_000, writeLog: false } as const;
const F = (position: string) => ({ position, type: 'FOLD' as const });

/** 一个翻后局面（Hero 顶对，无人下注） */
const postflopSpot: ManualHandInput = {
  tableSize: 9, heroPosition: 'BTN', heroCards: ['Kd', 'Th'],
  board: ['Ts', '7c', '3h'], street: 'FLOP',
  effectiveStackBB: 100, seatStacksBB: { UTG: 100, BTN: 100, BB: 100 },
  actionHistory: [
    { position: 'UTG', type: 'CALL', amountBB: 1 }, F('UTG1'), F('UTG2'), F('LJ'), F('HJ'), F('CO'),
    { position: 'BTN', type: 'CALL', amountBB: 1 }, F('SB'), { position: 'BB', type: 'CHECK' },
    { position: 'BB', type: 'CHECK', street: 'FLOP' }, { position: 'UTG', type: 'CHECK', street: 'FLOP' },
  ],
  environment: 'MID_LOW_STAKES', villain: { quickProfile: 'NORMAL', dynamicHint: 'UNKNOWN' },
} as unknown as ManualHandInput;

/** 一个翻前局面（用于确认翻后字段不出现） */
const preflopSpot: ManualHandInput = {
  tableSize: 9, heroPosition: 'BTN', heroCards: ['Kd', 'Th'], board: [], street: 'PREFLOP',
  effectiveStackBB: 100,
  actionHistory: [F('UTG'), F('UTG1'), F('UTG2'), F('LJ'), F('HJ'), F('CO')],
  environment: 'MID_LOW_STAKES', villain: { quickProfile: 'NORMAL', dynamicHint: 'UNKNOWN' },
} as unknown as ManualHandInput;

function diagnosticsOf(input: ManualHandInput) {
  const r = analyzeManualHand(input, OPTIONS);
  assert.equal(r.ok, true, `必须能分析：${r.ok ? '' : JSON.stringify(r.issues)}`);
  if (!r.ok) throw new Error('unreachable');
  return r.decision.diagnostics;
}

test('P3-1：翻后必须给出完整的决策快照；翻前不得出现该字段', () => {
  const postflop = diagnosticsOf(postflopSpot).postflop;
  assert.notEqual(postflop, undefined, '翻后必须有 postflop 快照');

  const p = postflop!;
  assert.equal(typeof p.handRole, 'string');
  assert.ok(p.handRoleZh.length > 0, '角色必须有中文标签');
  assert.ok(p.roleStrength >= 0 && p.roleStrength <= 1);
  assert.notEqual(p.boardDelta, null, '跨街牌面变化必须被计算');
  assert.equal(typeof p.boardDelta!['blankScore'], 'number');
  for (const key of ['strengthFloor', 'nutDensity', 'airDensity', 'showdownDensity']) {
    assert.ok(typeof p.rangeCompression[key] === 'number', `范围压缩必须含 ${key}`);
    const v = p.rangeCompression[key]!;
    assert.ok(v >= 0 && v <= 1, `${key} 必须落在 0..1，实际 ${v}`);
  }
  for (const key of ['verdict', 'estimatedBetEVScore', 'estimatedCheckEVScore']) {
    assert.ok(p.valueAssessment[key] !== undefined, `价值评估必须含 ${key}`);
  }
  assert.ok(p.evRanking.length >= 2, '必须给出至少两个动作的比较分');
  assert.ok(
    p.evRanking.every((x) => x.score >= 0 && x.score <= 1),
    `动作分数必须落在 0..1：${JSON.stringify(p.evRanking)}`,
  );
  assert.equal(typeof p.commitment['bandZh'], 'string');
  assert.ok(typeof p.blockers['blocksValue'] === 'number');

  // 翻前：不得出现（避免把翻后口径误用到翻前）
  assert.equal(diagnosticsOf(preflopSpot).postflop, undefined, '翻前不得有 postflop 快照');
});

test('P3-2：🔴 必须显式声明「启发式比较分不是 solver EV」（禁止伪精确 EV）', () => {
  const p = diagnosticsOf(postflopSpot).postflop!;
  assert.ok(p.evScoreDisclaimerZh.length > 10, '必须有口径说明');
  assert.match(p.evScoreDisclaimerZh, /启发式|比较分/);
  assert.match(p.evScoreDisclaimerZh, /不是.*solver EV|非.*solver/i);
});

test('P3-3：置信度语义必须是「首选比次选好多少」，且与牌力无关', () => {
  const p = diagnosticsOf(postflopSpot).postflop!;
  /*
   * ⚠️ 置信度按**动作族**比较（CHECK / BET / CALL / RAISE / FOLD 各取最大），
   * 不是直接拿前三名比 —— 否则 `BET_SMALL = 0.95 × BET_MEDIUM` 会让前两名
   * 永远是两个下注变体、分差恒 ≤0.05 ⇒ 置信度恒 LOW（审计抓到的缺陷）。
   */
  const familyOf = (action: string): string => (action.startsWith('BET') ? 'BET' : action);
  const byFamily = new Map<string, number>();
  for (const entry of p.evRanking) {
    const family = familyOf(entry.action);
    byFamily.set(family, Math.max(byFamily.get(family) ?? 0, entry.score));
  }
  const sortedFamilies = [...byFamily.values()].sort((a, b) => b - a);
  assert.ok(sortedFamilies.length >= 2, '必须至少有两个动作族可比较');
  const gap = sortedFamilies[0]! - sortedFamilies[1]!;
  assert.ok(
    Math.abs(gap - p.confidenceGap) < 1e-4,
    `置信度差必须等于前两名**动作族**的分数差（允许显示取整）：${gap} vs ${p.confidenceGap}`,
  );
  const expected = gap >= 0.15 ? 'HIGH' : gap >= 0.06 ? 'MEDIUM' : 'LOW';
  assert.equal(p.confidence, expected, `置信度必须只由分差决定：${p.confidence} vs ${expected}`);
});

test('P3-4：界面必须能看到「角色 / 牌面变化 / 价值判断 / 承诺 / 阻断 / 偏好顺序 / 置信度」', () => {
  const r = analyzeManualHand(postflopSpot, OPTIONS);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const rows =
    (r.viewModel as { debug?: { postflop?: readonly { label: string; value: string }[] } }).debug
      ?.postflop ?? [];
  assert.ok(rows.length >= 8, `翻后诊断行不得少于 8 行，实际 ${rows.length}`);
  const labels = rows.map((x) => x.label).join(' / ');
  for (const needle of ['相对牌力角色', '牌面变化', '价值判断', 'SPR 承诺', '置信度']) {
    assert.ok(labels.includes(needle), `诊断区必须含「${needle}」，实际：${labels}`);
  }
  assert.ok(
    rows.some((x) => x.value.includes('启发式') || x.value.includes('不是')),
    '诊断区必须显示 EV 口径说明',
  );
  /*
   * 🔴 「对手范围 vs 我的牌」必须单独成行：它是价值守门器第一、二问的唯一口径
   *（更差 / 更好是**相对于我这手牌**的精确比较）。修复前这两问由「他的范围整体多强」
   * 冒充 —— 使用者看不到口径，只能看到「权益 94.7% 却不该下注」这种自相矛盾的输出。
   */
  const compareRow = rows.find((x) => x.label.includes('对手范围 vs 我的牌'));
  assert.ok(compareRow !== undefined, `诊断区必须含「对手范围 vs 我的牌」，实际：${labels}`);
  assert.ok(
    compareRow!.value.includes('更差') && compareRow!.value.includes('更好'),
    `该行必须同时给出两个占比，实际：${compareRow!.value}`,
  );

  /*
   * 🔴 「动作偏好顺序」必须**真的按分数降序**：快照里的顺序是候选动作的构造顺序，
   * 直接拼接会显示成 `CHECK 0.25 > BET_SMALL 0.69`（读起来像首选过牌）。
   */
  const orderRow = rows.find((x) => x.label.includes('偏好顺序'));
  assert.ok(orderRow !== undefined, '诊断区必须含偏好顺序');
  const parsed = [...orderRow!.value.matchAll(/([A-Z_]+)\s+([0-9.]+)/g)].map((m) => ({
    action: m[1]!,
    score: Number(m[2]!),
  }));
  assert.ok(parsed.length >= 2, `偏好顺序必须至少含两个动作，实际：${orderRow!.value}`);
  for (let i = 1; i < parsed.length; i += 1) {
    assert.ok(
      parsed[i - 1]!.score >= parsed[i]!.score,
      `偏好顺序必须按分数降序，实际：${orderRow!.value}`,
    );
  }
});

test('P3-5：面对下注时也必须给出角色与牌面变化（不得只在无人下注时给）', () => {
  const facingBet: ManualHandInput = {
    ...(postflopSpot as object),
    actionHistory: [
      { position: 'UTG', type: 'CALL', amountBB: 1 }, F('UTG1'), F('UTG2'), F('LJ'), F('HJ'), F('CO'),
      { position: 'BTN', type: 'CALL', amountBB: 1 }, F('SB'), { position: 'BB', type: 'CHECK' },
      { position: 'BB', type: 'BET', amountBB: 3, street: 'FLOP' },
      { position: 'UTG', type: 'FOLD', street: 'FLOP' },
    ],
  } as unknown as ManualHandInput;

  const r = analyzeManualHand(facingBet, OPTIONS);
  assert.equal(r.ok, true, `面对下注的局面必须能分析：${r.ok ? '' : JSON.stringify(r.issues)}`);
  if (!r.ok) return;
  const codes = r.decision.reasons.map((x) => x.code);
  assert.ok(codes.includes('POSTFLOP_ROLE'), `面对下注必须给出角色理由，实际 ${codes.join(',')}`);
  assert.ok(codes.includes('BOARD_DELTA'), `面对下注必须给出牌面变化理由，实际 ${codes.join(',')}`);
  assert.ok(codes.includes('SPR_COMMITMENT'), `面对下注必须给出承诺评估，实际 ${codes.join(',')}`);
});
