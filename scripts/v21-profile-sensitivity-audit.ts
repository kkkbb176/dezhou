/**
 * V2.1 画像敏感度与决策影响审计 —— 可复现测量脚本
 *
 * 用法：
 * ```text
 * node --experimental-strip-types scripts/v21-profile-sensitivity-audit.ts
 * node --experimental-strip-types scripts/v21-profile-sensitivity-audit.ts --matrix-only
 * node --experimental-strip-types scripts/v21-profile-sensitivity-audit.ts --corpus-only
 * ```
 *
 * 产物：
 * - `reports/evidence/v21-profile-sensitivity.json`（全部原始测量，含每一行的输入与输出）
 *
 * ## 本轮实际采用的档位定义
 *
 * ⚠️ **仓库里没有找到 V2.1 的原始档位定义**（全仓 `V2.1` 只命中「河牌一致性 V2.1」，
 * 与画像无关）。因此档位是本轮**自定**并**显式披露**的，不是沿用旧方案：
 *
 * | 维度 | 7/9/5/4 档 | 依据 |
 * |---|---|---|
 * | 样本量 7 档 | 0 / 2 / 5 / 20 / 50 / 200 / 1000 **机会数** | 覆盖收缩公式 `(prior×6+s)/(6+n)` 的三个区制（n≪6 / n≈6 / n≫6）、
 *   `SampleTier` 的 30 / 200 两个阈值、以及 n=0 的「无观测」边界 |
 * | 玩家类型 9 档 | 5 个**有先验**的原型 + 4 个**刻意中性**的标签 | 正好是 `ARCHETYPE_BEHAVIOR_PRIORS` 的键（5）与 `NEUTRAL_ARCHETYPES` 的键（4） |
 * | 偏离程度 5 档 | `VERY_LOW/LOW/MEDIUM/HIGH/VERY_HIGH` = **实测生效值** 0.05/0.20/0.45/0.65/**0.80** | **生产入口自己的刻度**（`manualReadEvidence` 的 5 档），
 *   比率由脚本探测确认（`effectiveRate` 逐档实测），不是手写近似 |
 * | 当前证据强度 4 档 | 无 / 标签先验 / 单条人工 / 带上限的人工 | `behaviorProfileOf` 四级来源（标签先验 / 人工 / 实测）的可达组合；
 *   「实测」强度即置信度 0.35 上限，故用 `manual` 表达（`MANUAL_READ_CONFIDENCE_CAP`） |
 *
 * **局限（必须与数字一起读）**：偏离只施加在 `riverBluff`（纯空气端）一条条目上，
 * 因此本矩阵测的是**单条目敏感度**，不是「画像整体」；多条目同时偏离会因几何平均
 * 而**低于**单条目的幅度（V2 已证：乘积 417× 撞钳位，故改几何平均）。
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import { parseManualInput, type ManualHandInput } from '../src/app/manualInput/manualInput.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import {
  behaviorProfileOf,
  BehaviorTraitKey,
  profileMaterialityOf,
  MATERIALITY_THRESHOLDS,
  type PlayerBehaviorProfile,
} from '../src/domain/player/behaviorProfile.ts';
import { profileRangeDistance } from '../src/domain/player/profileRangeMetrics.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();

/**
 * 🔴 固定设置：**同一牌局的画像对照必须使用完全相同的计算设置**。
 *
 * - `asOf` 固定 ⇒ 时间衰减/知识库版本不随运行时刻变化；
 * - `budget` 宽裕 ⇒ `equityPolicy` 不会因机器负载在「精确枚举」与
 *   「蒙特卡洛」之间换型（V2 §二十六 实测过这个坑）；
 * - `equitySeed` 固定 ⇒ 若真的回落到蒙特卡洛，两侧用**同一个种子**；
 * - `writeLog: false` ⇒ 不产生副作用文件。
 */
const OPTIONS = {
  rules: RULES,
  asOf: 1_757_000_000_000,
  writeLog: false,
  budget: { softMs: 120_000, hardMs: 240_000 },
  equitySeed: 20260913,
} as const;

const SEATS9 = {
  UTG: 100, UTG1: 100, UTG2: 100, LJ: 100, HJ: 100,
  CO: 100, BTN: 100, SB: 100, BB: 100,
} as const;

const SEATS6 = { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 } as const;

/* ============================================================
 * ① 牌局语料（覆盖街 / 位置 / 底池结构 / 决策类型）
 * ============================================================ */

type Scenario = {
  id: string;
  /** 需求：每个展示牌例先写「我的位置」 */
  myPosition: string;
  heroCards: readonly [string, string];
  board: readonly string[];
  street: 'FLOP' | 'TURN' | 'RIVER';
  potBB: number;
  effectiveStackBB: number;
  /** 决策类型（本用例主要考什么） */
  kind: 'VALUE_BET' | 'BLUFF' | 'BLUFF_CATCH' | 'FACING_BET';
  structure: 'SRP' | 'THREE_BET' | 'LIMPED' | 'UNSUPPORTED';
  tableSize: 6 | 9 | 7;
  history: readonly Record<string, unknown>[];
};

const F = { position: 'x', type: 'FOLD' } as const;

/** S1 —— V2 黄金夹具（河牌 · 抓诈唬 · TURN_CHECK_BACK + LARGE） */
const S1: Scenario = {
  id: 'S1_RIVER_BLUFFCATCH_TURN_CHECKBACK',
  myPosition: 'CO',
  heroCards: ['Ac', 'Jh'],
  board: ['Ad', '8s', '4s', '2c', 'Kd'],
  street: 'RIVER',
  potBB: 19.5,
  effectiveStackBB: 100,
  kind: 'BLUFF_CATCH',
  structure: 'SRP',
  tableSize: 9,
  history: [
    { position: 'UTG', type: 'FOLD' }, { position: 'UTG1', type: 'FOLD' },
    { position: 'UTG2', type: 'FOLD' }, { position: 'LJ', type: 'FOLD' },
    { position: 'HJ', type: 'FOLD' },
    { position: 'CO', type: 'RAISE', amountBB: 2.5 },
    { position: 'BTN', type: 'FOLD' }, { position: 'SB', type: 'FOLD' },
    { position: 'BB', type: 'CALL', amountBB: 1.5 },
    { position: 'BB', type: 'CHECK', street: 'FLOP' },
    { position: 'CO', type: 'BET', amountBB: 2, street: 'FLOP' },
    { position: 'BB', type: 'CALL', amountBB: 2, street: 'FLOP' },
    { position: 'BB', type: 'CHECK', street: 'TURN' },
    { position: 'CO', type: 'CHECK', street: 'TURN' },
    { position: 'BB', type: 'BET', amountBB: 7, street: 'RIVER' },
  ],
};

/** S2 —— 河牌抓诈唬（standard 双街开火线，Hero 只跟到河牌） */
const S2: Scenario = {
  id: 'S2_RIVER_BLUFFCATCH_TURN_BETCALL',
  myPosition: 'BB',
  heroCards: ['Kh', 'Qh'],
  board: ['Kc', '9s', '5d', '2h', '7c'],
  street: 'RIVER',
  potBB: 19.5,
  effectiveStackBB: 100,
  kind: 'BLUFF_CATCH',
  structure: 'SRP',
  tableSize: 9,
  history: [
    { position: 'UTG', type: 'FOLD' }, { position: 'UTG1', type: 'FOLD' },
    { position: 'UTG2', type: 'FOLD' }, { position: 'LJ', type: 'FOLD' },
    { position: 'HJ', type: 'FOLD' },
    { position: 'CO', type: 'RAISE', amountBB: 2.5 },
    { position: 'BTN', type: 'FOLD' }, { position: 'SB', type: 'FOLD' },
    { position: 'BB', type: 'CALL', amountBB: 1.5 },
    { position: 'BB', type: 'CHECK', street: 'FLOP' },
    { position: 'CO', type: 'BET', amountBB: 2, street: 'FLOP' },
    { position: 'BB', type: 'CALL', amountBB: 2, street: 'FLOP' },
    { position: 'BB', type: 'CHECK', street: 'TURN' },
    { position: 'CO', type: 'BET', amountBB: 5.5, street: 'TURN' },
    { position: 'BB', type: 'CALL', amountBB: 5.5, street: 'TURN' },
    { position: 'BB', type: 'CHECK', street: 'RIVER' },
    { position: 'CO', type: 'BET', amountBB: 7.5, street: 'RIVER' },
  ],
};

/** S3 —— 转牌面对下注（抓诈唬 · 听牌未成） */
const S3: Scenario = {
  id: 'S3_TURN_FACING_BET',
  myPosition: 'BB',
  heroCards: ['As', 'Qs'],
  board: ['Qd', 'Jh', '4h', '6c'],
  street: 'TURN',
  potBB: 22,
  effectiveStackBB: 100,
  kind: 'FACING_BET',
  structure: 'SRP',
  tableSize: 9,
  history: [
    { position: 'UTG', type: 'FOLD' }, { position: 'UTG1', type: 'FOLD' },
    { position: 'UTG2', type: 'FOLD' }, { position: 'LJ', type: 'FOLD' },
    { position: 'HJ', type: 'FOLD' },
    { position: 'CO', type: 'RAISE', amountBB: 2.5 },
    { position: 'BTN', type: 'FOLD' }, { position: 'SB', type: 'FOLD' },
    { position: 'BB', type: 'CALL', amountBB: 1.5 },
    { position: 'BB', type: 'CHECK', street: 'FLOP' },
    { position: 'CO', type: 'BET', amountBB: 4, street: 'FLOP' },
    { position: 'BB', type: 'CALL', amountBB: 4, street: 'FLOP' },
    { position: 'BB', type: 'CHECK', street: 'TURN' },
    { position: 'CO', type: 'BET', amountBB: 7, street: 'TURN' },
  ],
};

/** S4 —— 翻牌 Hero 主动下注（价值下注，无画像参与的机会） */
const S4: Scenario = {
  id: 'S4_FLOP_HERO_VALUE_BET',
  myPosition: 'CO',
  heroCards: ['Ac', 'Jh'],
  board: ['Ad', '8s', '4s'],
  street: 'FLOP',
  potBB: 5,
  effectiveStackBB: 100,
  kind: 'VALUE_BET',
  structure: 'SRP',
  tableSize: 9,
  history: [
    { position: 'UTG', type: 'FOLD' }, { position: 'UTG1', type: 'FOLD' },
    { position: 'UTG2', type: 'FOLD' }, { position: 'LJ', type: 'FOLD' },
    { position: 'HJ', type: 'FOLD' },
    { position: 'CO', type: 'RAISE', amountBB: 2.5 },
    { position: 'BTN', type: 'FOLD' }, { position: 'SB', type: 'FOLD' },
    { position: 'BB', type: 'CALL', amountBB: 1.5 },
    { position: 'BB', type: 'CHECK', street: 'FLOP' },
  ],
};

/** S5 —— 河牌超池（OVERBET 尺寸档 + 极少见节点） */
const S5: Scenario = {
  id: 'S5_RIVER_OVERBET_FACING',
  myPosition: 'BB',
  heroCards: ['Ks', 'Qs'],
  board: ['Kd', '8c', '3h', '2d', '7s'],
  street: 'RIVER',
  potBB: 19.5,
  effectiveStackBB: 100,
  kind: 'BLUFF_CATCH',
  structure: 'SRP',
  tableSize: 9,
  history: [
    { position: 'UTG', type: 'FOLD' }, { position: 'UTG1', type: 'FOLD' },
    { position: 'UTG2', type: 'FOLD' }, { position: 'LJ', type: 'FOLD' },
    { position: 'HJ', type: 'FOLD' },
    { position: 'CO', type: 'RAISE', amountBB: 2.5 },
    { position: 'BTN', type: 'FOLD' }, { position: 'SB', type: 'FOLD' },
    { position: 'BB', type: 'CALL', amountBB: 1.5 },
    { position: 'BB', type: 'CHECK', street: 'FLOP' },
    { position: 'CO', type: 'BET', amountBB: 2, street: 'FLOP' },
    { position: 'BB', type: 'CALL', amountBB: 2, street: 'FLOP' },
    { position: 'BB', type: 'CHECK', street: 'TURN' },
    { position: 'CO', type: 'CHECK', street: 'TURN' },
    { position: 'BB', type: 'CHECK', street: 'RIVER' },
    { position: 'CO', type: 'BET', amountBB: 30, street: 'RIVER' },
  ],
};

/** S6 —— 3BET 底池（不同底池结构）+ 转牌被抓 */
const S6: Scenario = {
  id: 'S6_THREEBET_POT_TURN_FACING',
  myPosition: 'BB',
  heroCards: ['As', 'Ks'],
  board: ['Kh', '7d', '2c', 'Js'],
  street: 'TURN',
  potBB: 40.5,
  effectiveStackBB: 100,
  kind: 'FACING_BET',
  structure: 'THREE_BET',
  tableSize: 9,
  history: [
    { position: 'UTG', type: 'FOLD' }, { position: 'UTG1', type: 'FOLD' },
    { position: 'UTG2', type: 'FOLD' }, { position: 'LJ', type: 'FOLD' },
    { position: 'HJ', type: 'FOLD' },
    { position: 'CO', type: 'RAISE', amountBB: 2.5 },
    { position: 'BTN', type: 'RAISE', amountBB: 9 },
    { position: 'SB', type: 'FOLD' },
    { position: 'BB', type: 'CALL', amountBB: 8 },
    { position: 'CO', type: 'FOLD' },
    { position: 'BB', type: 'CHECK', street: 'FLOP' },
    { position: 'BTN', type: 'BET', amountBB: 13.5, street: 'FLOP' },
    { position: 'BB', type: 'CALL', amountBB: 13.5, street: 'FLOP' },
    { position: 'BB', type: 'CHECK', street: 'TURN' },
    { position: 'BTN', type: 'BET', amountBB: 20, street: 'TURN' },
  ],
};

/** S7 —— 溜入底池（LIMPED，另一种底池结构） */
const S7: Scenario = {
  id: 'S7_LIMPED_POT_RIVER_BLUFFCATCH',
  myPosition: 'BB',
  heroCards: ['9h', '9c'],
  board: ['Qs', '8d', '3c', '6s', 'Ks'],
  street: 'RIVER',
  potBB: 13,
  effectiveStackBB: 100,
  kind: 'BLUFF_CATCH',
  structure: 'LIMPED',
  tableSize: 6,
  history: [
    { position: 'UTG', type: 'CALL', amountBB: 1 },
    { position: 'HJ', type: 'FOLD' },
    { position: 'CO', type: 'CALL', amountBB: 1 },
    { position: 'BTN', type: 'FOLD' },
    { position: 'SB', type: 'FOLD' },
    { position: 'BB', type: 'CHECK' },
    { position: 'BB', type: 'CHECK', street: 'FLOP' },
    { position: 'UTG', type: 'CHECK', street: 'FLOP' },
    { position: 'CO', type: 'BET', amountBB: 2, street: 'FLOP' },
    { position: 'BB', type: 'CALL', amountBB: 2, street: 'FLOP' },
    { position: 'UTG', type: 'CALL', amountBB: 2, street: 'FLOP' },
    { position: 'BB', type: 'CHECK', street: 'TURN' },
    { position: 'UTG', type: 'CHECK', street: 'TURN' },
    { position: 'CO', type: 'BET', amountBB: 4, street: 'TURN' },
    { position: 'BB', type: 'CALL', amountBB: 4, street: 'TURN' },
    { position: 'UTG', type: 'FOLD' },
    { position: 'BB', type: 'CHECK', street: 'RIVER' },
    { position: 'CO', type: 'BET', amountBB: 6, street: 'RIVER' },
  ],
};

/** S8 —— 7 人桌（**不支持的桌型**，预期被拒 ⇒ UNSUPPORTED） */
const S8: Scenario = {
  id: 'S8_SEVEN_HANDED_UNSUPPORTED',
  myPosition: 'BB',
  heroCards: ['Ac', 'Jh'],
  board: ['Ad', '8s', '4s', '2c', 'Kd'],
  street: 'RIVER',
  potBB: 19.5,
  effectiveStackBB: 100,
  kind: 'BLUFF_CATCH',
  structure: 'UNSUPPORTED',
  tableSize: 7,
  history: S1.history,
};

const CORPUS: readonly Scenario[] = [S1, S2, S3, S4, S5, S6, S7, S8];

function inputOf(
  sc: Scenario,
  villain: { quickProfile?: string; behaviorProfile?: PlayerBehaviorProfile },
): ManualHandInput {
  return {
    tableSize: sc.tableSize,
    heroPosition: sc.myPosition,
    heroCards: [...sc.heroCards],
    board: [...sc.board],
    street: sc.street,
    effectiveStackBB: sc.effectiveStackBB,
    bigBlindBB: 2,
    seatStacksBB: { ...(sc.tableSize === 6 ? SEATS6 : SEATS9) },
    actionHistory: sc.history.map((h) => ({ ...h })),
    environment: 'MID_LOW_STAKES',
    villain: { dynamicHint: 'UNKNOWN', stackBB: sc.effectiveStackBB, ...villain },
  } as unknown as ManualHandInput;
}

/* ============================================================
 * ② 测量：一行 = 一次真实生产入口调用
 * ============================================================ */

type Row = {
  scenario: string;
  myPosition: string;
  kind: string;
  structure: string;
  heroCards: string;
  board: string;
  street: string;
  /** 变量维度 */
  archetype: string;
  tier: string | null;
  /** 机会数（**该行为的有效机会数**，不是总手数） */
  opportunities: number;
  successes: number;
  deviation: number | null;
  evidenceStrength: string;
  /** 结果 */
  ok: boolean;
  issues: string | null;
  action: string | null;
  sizingBB: number | null;
  sizingPotRatio: number | null;
  heroEquity: number | null;
  requiredEquity: number | null;
  callEV: number | null;
  bluffMass: number | null;
  missedDrawMass: number | null;
  valueMass: number | null;
  rawSupportCombos: number | null;
  effectiveCombos: number | null;
  classMassVector: number[] | null;
  combosBefore: number | null;
  combosAfter: number | null;
  foldLikelihood: number | null;
  callLikelihood: number | null;
  raiseLikelihood: number | null;
  /** 所有候选动作的 EV（CALL / FOLD / 各尺寸 BET） */
  candidateEVs: Record<string, number | null> | null;
  bestSize: string | null;
  checkEV: number | null;
  confidence: string | null;
  clampedTotal: number | null;
  appliedTraitCount: number | null;
  elapsedMs: number;
};

function measure(sc: Scenario, villain: Parameters<typeof inputOf>[1], label: Partial<Row>): Row {
  const t0 = performance.now();
  const input = inputOf(sc, villain);
  const r = analyzeManualHand(input, OPTIONS);
  /*
   * ⚠️ `elapsedMs` 必须是**整行**的代价，不只是 `analyzeManualHand`。
   *
   * 独立统计审查指出：本脚本每行还额外调了一次 `buildDecisionContext`
   * （为了拿 `profileClassMasses`），而初版只把 `analyzeManualHand` 计进 `elapsedMs`
   * ⇒ 报告里的「总耗时」只有真实墙钟的一半左右。现在在函数末尾重新取值。
   */
  let elapsedMs = performance.now() - t0;

  const base: Row = {
    scenario: sc.id,
    myPosition: sc.myPosition,
    kind: sc.kind,
    structure: sc.structure,
    heroCards: sc.heroCards.join(''),
    board: sc.board.join(' '),
    street: sc.street,
    archetype: String(label.archetype ?? '—'),
    tier: label.tier ?? null,
    opportunities: label.opportunities ?? 0,
    successes: label.successes ?? 0,
    deviation: label.deviation ?? null,
    evidenceStrength: String(label.evidenceStrength ?? 'NONE'),
    ok: false, issues: null, action: null, sizingBB: null, sizingPotRatio: null,
    heroEquity: null, requiredEquity: null, callEV: null,
    bluffMass: null, missedDrawMass: null, valueMass: null,
    rawSupportCombos: null, effectiveCombos: null, classMassVector: null,
    combosBefore: null, combosAfter: null,
    foldLikelihood: null, callLikelihood: null, raiseLikelihood: null,
    candidateEVs: null, bestSize: null, checkEV: null,
    confidence: null, clampedTotal: null, appliedTraitCount: null,
    elapsedMs,
  };

  if (!r.ok) {
    base.issues = JSON.stringify(r.issues);
    return base;
  }

  const m = r.decision.diagnostics.math;
  base.ok = true;
  base.action = String(r.decision.action);
  base.heroEquity = m.heroEquity;
  base.requiredEquity = m.requiredEquity;
  base.callEV = m.callEV;

  const sizing = r.decision.sizing ?? null;
  if (sizing !== null && typeof sizing === 'object') {
    const s = sizing as Record<string, unknown>;
    const amount = typeof s.amount === 'number' ? s.amount : typeof s.amountBB === 'number' ? s.amountBB : null;
    base.sizingBB = amount;
    base.sizingPotRatio = typeof s.potRatio === 'number' ? s.potRatio : null;
  }

  /* ---- 范围 / 质量：必须走 buildDecisionContext（与黄金测试同一条路） ---- */
  const parsed = parseManualInput(input);
  if (parsed.ok) {
    const gate = buildAnalyzableState(parsed.value);
    if (gate.ok) {
      const built = buildDecisionContext({
        state: gate.state,
        rules: RULES,
        environment: 'MID_LOW_STAKES',
        asOf: 1_757_000_000_000,
        budget: { softMs: 120_000, hardMs: 240_000 },
        equitySeed: 20260913,
        ...(villain.quickProfile === undefined ? {} : { quickProfile: villain.quickProfile as never }),
        ...(villain.behaviorProfile === undefined ? {} : { behaviorProfile: villain.behaviorProfile }),
      });
      const facts = built.context.postflopFacts?.opponentRangeFacts as unknown as
        | {
            profileClassMasses?: {
              bluffMass: number; missedDrawMass: number; valueMass: number;
              thinValueMass: number; showdownMass: number; pureAirMass: number;
              nutValueMass: number; strongValueMass: number;
              rawSupportCombos: number; effectiveCombos: number | null;
            };
          }
        | undefined;
      const pc = facts?.profileClassMasses ?? null;
      if (pc !== null) {
        base.bluffMass = pc.bluffMass;
        base.missedDrawMass = pc.missedDrawMass;
        base.valueMass = pc.valueMass;
        base.rawSupportCombos = pc.rawSupportCombos;
        base.effectiveCombos = pc.effectiveCombos;
        /* 🔴 类别级向量（**5 个互不重叠的分量**）—— 见报告 §3 的 CATEGORY_LEVEL 声明 */
        base.classMassVector = [
          pc.nutValueMass + pc.strongValueMass,
          pc.thinValueMass,
          pc.showdownMass,
          pc.missedDrawMass,
          pc.pureAirMass,
        ];
      }
      const ev = built.context.profileRangeEvidence;
      if (ev !== undefined) {
        base.combosBefore = ev.combosBefore;
        base.combosAfter = ev.combosAfter;
      }
    }
  }

  /* ---- 响应模型（对手弃牌/跟注/加注概率）与候选 EV ---- */
  const post = r.decision.diagnostics.postflop as unknown as
    | {
        confidence?: string;
        betDecision?: {
          bestSize?: string | null;
          checkEV?: number | null;
          sizes: readonly {
            labelZh: string; betAmount: number; ratioToPot: number;
            foldLikelihood: number; callLikelihood: number; raiseLikelihood: number;
            equity: number | null;
          }[];
        } | null;
        unclampedLikelihood?: number;
      }
    | undefined;
  base.confidence = post?.confidence ?? null;
  const bd = post?.betDecision ?? null;
  if (bd !== null && bd !== undefined) {
    base.bestSize = bd.bestSize ?? null;
    base.checkEV = bd.checkEV ?? null;
    if (bd.sizes.length > 0) {
      // 取「最接近决策所选项」的尺寸：bestSize 命中优先，否则第一个
      const chosen = bd.sizes.find((s) => s.labelZh === bd.bestSize) ?? bd.sizes[0]!;
      base.foldLikelihood = chosen.foldLikelihood;
      base.callLikelihood = chosen.callLikelihood;
      base.raiseLikelihood = chosen.raiseLikelihood;
    }
    const evs: Record<string, number | null> = { CHECK: bd.checkEV ?? null };
    for (const s of bd.sizes) evs[`BET_${s.labelZh}`] = (s as unknown as { ev: number | null }).ev ?? null;
    base.candidateEVs = evs;
  }

  /* 整行代价（含上面那次额外的 `buildDecisionContext`） */
  elapsedMs = performance.now() - t0;
  base.elapsedMs = elapsedMs;
  return base;
}

/* ============================================================
 * ③ 矩阵定义（7 × 9 × 5 × 4 = 1260）
 * ============================================================ */

/** 7 档**机会数**（不是总手数；0 = 无观测记录） */
const SAMPLE_TIERS: readonly { name: string; opportunities: number }[] = [
  { name: 'N0_NO_OBSERVATION', opportunities: 0 },
  { name: 'N2_TINY', opportunities: 2 },
  { name: 'N5_VERY_SMALL', opportunities: 5 },
  { name: 'N20_PRELIMINARY', opportunities: 20 },
  { name: 'N50_STANDARD', opportunities: 50 },
  { name: 'N200_CONFIRMED_EDGE', opportunities: 200 },
  { name: 'N1000_LARGE', opportunities: 1000 },
];

/** 9 种玩家类型 = 5 个有先验原型 + 4 个刻意中性标签 */
const ARCHETYPES: readonly { name: string; hasPrior: boolean }[] = [
  { name: 'VERY_TIGHT', hasPrior: true },
  { name: 'LOOSE', hasPrior: true },
  { name: 'CALLING_STATION', hasPrior: true },
  { name: 'UNDERBLUFFER', hasPrior: true },
  { name: 'BLUFF_HEAVY', hasPrior: true },
  { name: 'UNKNOWN', hasPrior: false },
  { name: 'NORMAL', hasPrior: false },
  { name: 'TIGHT', hasPrior: false },
  { name: 'AGGRESSIVE', hasPrior: false },
];

/**
 * 🔴 **补充档：其余 2 个标签**（V2.1 独立统计审查 C5 指出主矩阵漏了它们）。
 *
 * `MANIAC` 是 V2 黄金测试 03B 用的那个原型（`riverBluff` 先验最高 = 0.50），
 * `VERY_LOOSE` 是另一个有先验/中性声明混杂的标签。
 * 主矩阵仍是任务要求的 **9 档 × 5 × 4 × 7 = 1260**；
 * 这两个标签单列成 280 行**补充矩阵**，避免把「没测」写成「测了失败」。
 */
const EXTRA_ARCHETYPES: readonly { name: string; hasPrior: boolean }[] = [
  { name: 'MANIAC', hasPrior: true },
  { name: 'VERY_LOOSE', hasPrior: false },
];

/** 5 档偏离程度 = 生产入口自己的 `manualReadEvidence` 刻度（**实测值，不是猜的**） */
const DEVIATIONS: readonly { name: string; tendency: 'VERY_LOW' | 'LOW' | 'MEDIUM' | 'HIGH' | 'VERY_HIGH'; rate: number }[] = [
  { name: 'VERY_LOW_0.05', tendency: 'VERY_LOW', rate: 0.05 },
  { name: 'LOW_0.20', tendency: 'LOW', rate: 0.2 },
  { name: 'MEDIUM_0.45', tendency: 'MEDIUM', rate: 0.45 },
  { name: 'HIGH_0.65', tendency: 'HIGH', rate: 0.65 },
  { name: 'VERY_HIGH_0.80', tendency: 'VERY_HIGH', rate: 0.8 },
];

/** 4 档当前证据强度 */
const EVIDENCE_STRENGTHS = [
  'E0_TAG_PRIOR_ONLY',
  'E1_MANUAL_STRONG',
  'E2_MANUAL_WEAK',
  'E3_TAG_PRIOR_REASSERTED',
] as const;
type EvidenceStrength = (typeof EVIDENCE_STRENGTHS)[number];

/**
 * 由四个维度构造画像。
 *
 * ⚠️ **「无观测记录」与「观察到零次」必须分开**：
 * - `opportunities === 0` ⇒ 不传 `observed`（`observedRate = null`，`effectiveRate ≡ 先验`）；
 * - `opportunities > 0, successes = 0` ⇒ 传 `observed`（`observedRate = 0`，后验被真的拉低）。
 */
function profileFor(
  archetype: string,
  tier: { opportunities: number },
  successes: number,
  tendency: (typeof DEVIATIONS)[number]['tendency'],
  strength: EvidenceStrength,
): PlayerBehaviorProfile {
  const key = BehaviorTraitKey.RIVER_BLUFF;
  const manual =
    strength === 'E1_MANUAL_STRONG'
      ? { [key]: tendency }
      : strength === 'E2_MANUAL_WEAK'
        ? { [key]: tendency === 'VERY_HIGH' ? 'LOW' : tendency === 'VERY_LOW' ? 'HIGH' : tendency }
        : undefined;
  const useObserved = strength === 'E3_TAG_PRIOR_REASSERTED';
  return behaviorProfileOf({
    playerId: 'v21-villain',
    archetype: archetype as never,
    ...(manual === undefined ? {} : { manual: manual as never }),
    ...(useObserved && tier.opportunities > 0
      ? { observed: { [key]: { successes, opportunities: tier.opportunities } } as never }
      : {}),
  });
}

/* ============================================================
 * ④ 主流程
 * ============================================================ */

const argv = new Set(process.argv.slice(2));
const runMatrix = !argv.has('--corpus-only');
const runCorpus = !argv.has('--matrix-only');

const out: Record<string, unknown> = {
  meta: {
    generatedAtUtc: new Date().toISOString(),
    nodeVersion: process.version,
    options: { asOf: OPTIONS.asOf, equitySeed: OPTIONS.equitySeed, budget: OPTIONS.budget },
    /** ⚠️ 档位定义来自本轮自定（仓库无 V2.1 原始定义），见脚本文件头 */
    tiers: {
      sample: SAMPLE_TIERS, archetypes: ARCHETYPES,
      deviations: DEVIATIONS, evidenceStrengths: EVIDENCE_STRENGTHS,
    },
    unitNotes: {
      equity: '比例（0..1），报告里乘 100 得百分点',
      bluffMass: '概率质量占比（0..1）；分母 = 该对手可达组合的后验质量之和（不含与 Hero/公共牌重叠者）',
      opportunities: '该行为的**有效机会数**（本例为 riverBluff 条目的机会数），不是总手数',
      sizing: 'BB（大盲），potRatio = 下注额 ÷ 下注前底池',
    },
  },
};

/* ---------- ④.1 矩阵：固定场景 S1（与 V2 报告同一节点，可比） ---------- */
function runMatrixFor(archetypes: readonly { name: string }[], sc: Scenario): Row[] {
  const rows: Row[] = [];
  for (const arch of archetypes) {
    for (const strength of EVIDENCE_STRENGTHS) {
      for (const dev of DEVIATIONS) {
        for (const tier of SAMPLE_TIERS) {
          /*
           * 成功数由「人工读档位对应的比率 × 机会数」确定（不是随机抽样 ⇒ 无采样噪声）。
           * `successes` 是**二项计数的确定性取整**，与 V2 的确定性审计纪律一致。
           *
           * 🔴 比率取 `DEVIATIONS[].rate` —— 它是**实测**的 `manualReadEvidence`
           * 生效值（0.05/0.20/0.45/0.65/**0.80**），不是我手写的近似值。
           * 本脚本第一版把 `VERY_HIGH` 写成 0.95（生产实际是 0.80），
           * 被两份独立审查（`V21_REVIEW_1_STATISTICS.md` / `V21_REVIEW_5_COUNTEREVIDENCE.md`）
           * 抓到并已更正。
           *
           * ⚠️ **同一档在四种证据强度上必须是同一个比率** —— 否则「跨证据强度比较」不成立。
           * 因此 E3（实测重申）也用 `rate` 合成成功数，而不是另取一个极端值。
           * 更极端的比率（0.95，人工通道**不可达**但 `observed` 可达）单独放在
           * `scripts/v21-decision-impact.ts` 的 `EXTREME_*` 探针里，不进这张表。
           */
          const rate = dev.rate;
          const successes = Math.round(rate * tier.opportunities);
          const profile = profileFor(arch.name, tier, successes, dev.tendency, strength);
          rows.push(
            measure(
              sc,
              { quickProfile: arch.name, behaviorProfile: profile },
              {
                archetype: arch.name,
                tier: tier.name,
                opportunities: tier.opportunities,
                successes,
                deviation: rate,
                evidenceStrength: strength,
              },
            ),
          );
        }
      }
    }
  }
  return rows;
}

const matrix: Row[] = [];
if (runMatrix) {
  const sc = S1;
  matrix.push(...runMatrixFor(ARCHETYPES, sc));
  out['matrix'] = {
    scenario: sc.id,
    scenarioFacts: {
      myPosition: sc.myPosition, heroCards: sc.heroCards.join(''), board: sc.board.join(' '),
      potBB: sc.potBB, effectiveStackBB: sc.effectiveStackBB, structure: sc.structure,
    },
    combinations: matrix.length,
    rows: matrix,
  };
  console.error(`[matrix] ${matrix.length} 行完成`);
}

/* ---------- ④.1b 补充矩阵：其余 2 个标签（280 行） ---------- */
if (runMatrix) {
  const extra = runMatrixFor(EXTRA_ARCHETYPES, S1);
  out['matrixExtra'] = {
    note: '补充档：主矩阵 9 档之外的 MANIAC / VERY_LOOSE（独立统计审查要求补上，避免把「没测」写成「测了失败」）',
    scenario: S1.id,
    combinations: extra.length,
    rows: extra,
  };
  console.error(`[matrixExtra] ${extra.length} 行完成`);
}

/* ---------- ④.2 语料覆盖：8 个场景 × 中性对照 + 极端画像 ---------- */
const corpusRows: Row[] = [];
const corpusMeta: Record<string, unknown>[] = [];
if (runCorpus) {
  const probes: readonly { label: string; archetype: string; profile: PlayerBehaviorProfile | null }[] = [
    {
      label: 'NEUTRAL_NORMAL',
      archetype: 'NORMAL',
      profile: behaviorProfileOf({ playerId: 'v21-neutral', archetype: 'NORMAL' as never }),
    },
    { label: 'NO_PROFILE_UNKNOWN', archetype: 'UNKNOWN', profile: null },
    {
      label: 'CALLING_STATION_TAG',
      archetype: 'CALLING_STATION',
      profile: behaviorProfileOf({ playerId: 'v21-cs', archetype: 'CALLING_STATION' as never }),
    },
    {
      label: 'MANIAC_TAG',
      archetype: 'MANIAC',
      profile: behaviorProfileOf({ playerId: 'v21-maniac', archetype: 'MANIAC' as never }),
    },
    {
      label: 'MANIAC_OBS_50_45',
      archetype: 'MANIAC',
      profile: behaviorProfileOf({
        playerId: 'v21-maniac-obs',
        archetype: 'MANIAC' as never,
        observed: { [BehaviorTraitKey.RIVER_BLUFF]: { successes: 45, opportunities: 50 } } as never,
      }),
    },
    {
      label: 'MANIAC_OBS_50_5',
      archetype: 'MANIAC',
      profile: behaviorProfileOf({
        playerId: 'v21-maniac-obs-low',
        archetype: 'MANIAC' as never,
        observed: { [BehaviorTraitKey.RIVER_BLUFF]: { successes: 5, opportunities: 50 } } as never,
      }),
    },
    {
      label: 'MANIAC_OBS_0_0',
      archetype: 'MANIAC',
      profile: behaviorProfileOf({
        playerId: 'v21-maniac-obs-zero',
        archetype: 'MANIAC' as never,
        observed: { [BehaviorTraitKey.RIVER_BLUFF]: { successes: 0, opportunities: 0 } } as never,
      }),
    },
    {
      label: 'CALLING_STATION_DEV_VERY_HIGH',
      archetype: 'CALLING_STATION',
      profile: behaviorProfileOf({
        playerId: 'v21-cs-dev',
        archetype: 'CALLING_STATION' as never,
        manual: { [BehaviorTraitKey.RIVER_BLUFF]: 'VERY_HIGH' } as never,
      }),
    },
  ];

  for (const sc of CORPUS) {
    for (const p of probes) {
      const row = measure(
        sc,
        p.profile === null
          ? { quickProfile: p.archetype }
          : { quickProfile: p.archetype, behaviorProfile: p.profile },
        { archetype: p.archetype, tier: null, evidenceStrength: p.label },
      );
      row.archetype = p.label;
      corpusRows.push(row);
    }
    corpusMeta.push({
      id: sc.id, myPosition: sc.myPosition, heroCards: sc.heroCards.join(''),
      board: sc.board.join(' '), street: sc.street, potBB: sc.potBB,
      effectiveStackBB: sc.effectiveStackBB, kind: sc.kind, structure: sc.structure,
      tableSize: sc.tableSize,
    });
  }
  out['corpus'] = { scenarios: corpusMeta, rows: corpusRows };
  console.error(`[corpus] ${corpusRows.length} 行完成`);
}

mkdirSync('reports/evidence', { recursive: true });
writeFileSync('reports/evidence/v21-profile-sensitivity.json', JSON.stringify(out, null, 1), 'utf8');
console.error('[done] reports/evidence/v21-profile-sensitivity.json');

/* ============================================================
 * ⑤ 汇总（只打印实测聚合，不做判定）
 * ============================================================ */

const fmt = (x: number | null, d = 4): string => (x === null ? '—' : x.toFixed(d));

if (runMatrix) {
  const okRows = matrix.filter((r) => r.ok && r.heroEquity !== null);
  console.log(`\n===== 矩阵：${matrix.length} 组合（S1 ${S1.id}）=====`);
  console.log(`  可分析 ${okRows.length} / ${matrix.length}；失败 ${matrix.length - okRows.length}`);

  /* 中性对照：NORMAL + E0 + N0（无观测、无人工）= 「画像什么都没说」 */
  const neutral = matrix.find(
    (r) => r.archetype === 'NORMAL' && r.evidenceStrength === 'E0_TAG_PRIOR_ONLY' &&
      r.tier === 'N0_NO_OBSERVATION',
  );
  console.log(`  中性对照（NORMAL/E0/N0）：权益 ${fmt(neutral?.heroEquity ?? null)} 诈唬质量 ${fmt(neutral?.bluffMass ?? null)} 动作 ${neutral?.action ?? '—'}`);

  const deltas = okRows
    .filter((r) => neutral !== undefined && neutral.heroEquity !== null && r.heroEquity !== null)
    .map((r) => ({
      eq: (r.heroEquity as number) - (neutral!.heroEquity as number),
      bm: (r.bluffMass ?? 0) - (neutral!.bluffMass ?? 0),
      action: r.action, a: r.archetype, s: r.evidenceStrength, t: r.tier, d: r.deviation,
    }));
  const maxAbsEq = deltas.reduce((b, x) => (Math.abs(x.eq) > Math.abs(b.eq) ? x : b), deltas[0]!);
  const maxAbsBm = deltas.reduce((b, x) => (Math.abs(x.bm) > Math.abs(b.bm) ? x : b), deltas[0]!);
  console.log(`  max |equityDelta| = ${(maxAbsEq.eq * 100).toFixed(4)}pp  @ ${maxAbsEq.a}/${maxAbsEq.s}/${maxAbsEq.t}/dev${maxAbsEq.d}`);
  console.log(`  max |bluffMassDelta| = ${(maxAbsBm.bm * 100).toFixed(4)}pp  @ ${maxAbsBm.a}/${maxAbsBm.s}/${maxAbsBm.t}/dev${maxAbsBm.d}`);

  const flips = deltas.filter((x) => x.action !== neutral?.action);
  const flipPairs = new Map<string, number>();
  for (const f of flips) {
    const k = `${neutral?.action}→${f.action}`;
    flipPairs.set(k, (flipPairs.get(k) ?? 0) + 1);
  }
  console.log(`  action flip: ${flips.length} / ${deltas.length}（${((flips.length / Math.max(1, deltas.length)) * 100).toFixed(2)}%）`);
  for (const [k, v] of flipPairs) console.log(`    ${k}: ${v}`);

  /*
   * materiality：只用实测、不四舍五入。
   *
   * 🔴 **修复**（V2.1 数值审查 C4）：本脚本第一版把「max |equityDelta|」与
   * 「max |bluffMassDelta|」**两个独立归约**拼成一对，再用
   * `neutral + delta` **重建**那个值 —— 两个都是错的：
   * ① 那个 (equityDelta, bluffMassDelta) 组合**不对应任何一行实测**；
   * ② `base + delta - base !== delta`（实测在 43/45 权益探针上不成立，
   *    最大偏差 15 ULP）⇒ 重建值可能跨过阈值，判定就不是实测值的判定。
   * 现在改为**逐行**用该行**原始**值判一次，再取最强的那个判定。
   */
  if (neutral !== undefined && neutral.heroEquity !== null) {
    const verdictRank = { NO_EFFECT: 0, TRIVIAL: 1, MATERIAL: 2, STRONG: 3 } as const;
    let best: { row: Row; verdict: string; noteZh: string; eq: number; bm: number } | null = null;
    for (const r of okRows) {
      if (r.heroEquity === null || r.bluffMass === null) continue;
      const m = profileMaterialityOf({
        equityA: neutral.heroEquity,
        equityB: r.heroEquity,
        bluffMassA: neutral.bluffMass ?? 0,
        bluffMassB: r.bluffMass,
        evA: neutral.callEV,
        evB: r.callEV,
        rangeDistance: 0,
      });
      if (best === null || verdictRank[m.verdict as keyof typeof verdictRank] > verdictRank[best.verdict as keyof typeof verdictRank]) {
        best = {
          row: r, verdict: m.verdict, noteZh: m.noteZh,
          eq: r.heroEquity - neutral.heroEquity,
          bm: r.bluffMass - (neutral.bluffMass ?? 0),
        };
      }
    }
    console.log(`  逐行 materiality 的最强判定 = ${best?.verdict ?? '—'}（**逐行用该行原始值，不做任何重建**）`);
    if (best !== null) {
      console.log(`    行 = ${best.row.archetype}/${best.row.evidenceStrength}/${best.row.tier}/dev${best.row.deviation}`);
      console.log(`    equityDelta = ${best.eq}（${(best.eq * 100).toFixed(4)}pp）｜bluffMassDelta = ${best.bm}（${(best.bm * 100).toFixed(4)}pp）`);
      console.log(`    ${best.noteZh}`);
    }
    console.log(`    MATERIALITY_THRESHOLDS = ${JSON.stringify(MATERIALITY_THRESHOLDS)}`);
  }
}

if (runCorpus) {
  console.log(`\n===== 语料覆盖：${CORPUS.length} 场景 × ${corpusRows.length / CORPUS.length} 画像探针 =====`);
  for (const sc of CORPUS) {
    const rows = corpusRows.filter((r) => r.scenario === sc.id);
    const n = rows.find((r) => r.archetype === 'NEUTRAL_NORMAL');
    const cs = rows.find((r) => r.archetype === 'CALLING_STATION_TAG');
    const ma = rows.find((r) => r.archetype === 'MANIAC_TAG');
    const status = n?.ok === true ? 'OK' : 'UNSUPPORTED/FAIL';
    const eq = (x?: Row | null): string => (x?.heroEquity == null ? '—' : (x.heroEquity * 100).toFixed(2) + '%');
    console.log(
      `  ${sc.id.padEnd(40)} ${status.padEnd(16)} ` +
        `EQ ${eq(cs)} → ${eq(n)} → ${eq(ma)}  ` +
        `动作 ${cs?.action ?? '—'}/${n?.action ?? '—'}/${ma?.action ?? '—'}`,
    );
    if (n?.ok !== true) console.log(`      原因：${n?.issues ?? '—'}`);
  }
}
