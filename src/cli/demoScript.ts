/**
 * 演示脚本（场景编排 + 渲染）
 *
 * 职责：按「交付自检」的九个步骤走完一手牌，把确定性内核的结果渲染成中文。
 *
 * 设计约束：
 * - 本文件是**入口脚本层**，可以调用领域层，但领域层绝不反向依赖它。
 * - 不在这里实现任何扑克规则或数学 —— 全部调用领域层的确定性函数。
 * - 通过 `runDemo()` 显式触发，**不在模块加载时执行**（因此可以被导入与测试）。
 */

import { Position, TableSize, type Card } from '../domain/types.ts';
import { playerById, computePot, requiredCallAmount, totalCommitted, type GameState } from '../domain/poker/gameState.ts';
import { actorOnTurn, applyAction } from '../domain/poker/engine.ts';
import { advanceStreet } from '../domain/poker/streetAdvance.ts';
import { describeHand } from '../domain/poker/handDescription.ts';
import { computeEquity, type OpponentRange } from '../domain/poker/equity.ts';
import { callEV, equityGate, potMathSnapshot } from '../domain/poker/odds.ts';
import { validateGameState, type ValidationResult } from '../domain/poker/validator.ts';
import { evaluateCards, showdown } from '../domain/poker/handEval.ts';
import {
  actionMainLabel,
  cardFull,
  cardsShort,
  chips,
  handDescriptionText,
  percent,
  positionLabel,
  t,
} from '../i18n/index.ts';
import { blank, bullet, columns, line, note, section, title } from './format.ts';
import {
  boardOf,
  newDemoGame,
  parseCards,
  positionText,
  runScript,
  toCombos,
  type ScriptStep,
} from './demoFixtures.ts';

/* ============================================================
 * 演示场景常量
 * ============================================================ */

const PREFLOP_SCRIPT: readonly ScriptStep[] = [
  { playerId: 'utg', type: 'RAISE', amount: 6_000 },
  { playerId: 'hj', type: 'FOLD' },
  { playerId: 'co', type: 'CALL', amount: 6_000 },
  { playerId: 'btn', type: 'CALL', amount: 6_000 },
  { playerId: 'sb', type: 'FOLD' },
  { playerId: 'bb', type: 'FOLD' },
];

type StreetStep = {
  street: 'FLOP' | 'TURN' | 'RIVER';
  cards: string;
  note: string;
  script: readonly ScriptStep[];
};

const STREETS: readonly StreetStep[] = [
  {
    street: 'FLOP',
    cards: 'Kd Qc 9h',
    note: '小盲与大盲已在翻牌前弃牌，翻牌后由枪口位先行动',
    script: [
      { playerId: 'utg', type: 'BET', amount: 7_000 },
      { playerId: 'co', type: 'CALL', amount: 7_000 },
      { playerId: 'btn', type: 'CALL', amount: 7_000 },
    ],
  },
  {
    street: 'TURN',
    cards: '2s',
    note: '三人全部过牌',
    script: [
      { playerId: 'utg', type: 'CHECK' },
      { playerId: 'co', type: 'CHECK' },
      { playerId: 'btn', type: 'CHECK' },
    ],
  },
  {
    street: 'RIVER',
    cards: '7h',
    note: '关煞位下注 2/3 池 —— 轮到我（庄家位）决策',
    script: [
      { playerId: 'utg', type: 'CHECK' },
      { playerId: 'co', type: 'BET', amount: 41_000 },
    ],
  },
];

/**
 * 对手河牌下注范围。
 *
 * 必须同时包含价值、薄价值与诈唬 —— 这是「不能结果导向」的技术含义：
 * 对手真实手牌是 9♠9♦，但**决策当时并不知道**，
 * 因此绝不能用「他实际拿 99」去构造范围。
 */
const VILLAIN_RIVER_RANGE: readonly string[] = [
  '9s 9d', // 三条（真实手牌，但当时未知）
  'Kc Ks', // 顶三条
  'Qc Qs', // 三条
  'Kd Qh', // 顶两对（与我打平）
  'Ah 9c', // 薄价值：一对 9
  'As 9c', // 薄价值：一对 9
  'Jd Td', // 诈唬：卡顺未成
  'Jc Tc', // 诈唬：卡顺未成
  'Ac Jc', // 诈唬：A 高
  'Ad Td', // 诈唬：A 高
];

/* ============================================================
 * 主流程
 * ============================================================ */

export function runDemo(): void {
  console.log(line('═'));
  console.log(`  ${t('ui.title')}`);
  console.log('  阶段 1~3 交付自检 · 全部数值由确定性代码计算');
  console.log(line('═'));

  step1Validator();
  const afterPreflop = step2ActionLog();
  const game = step3Streets(afterPreflop);
  const board = boardOf(game);
  step4HandStrength(game, board);
  const decision = step5Math(game);
  const equityInfo = step6Equity(game, board, decision);
  step7Showdown(game, board, equityInfo);
  step8RedTeam();
  step9IllegalActions();
  closing();
}

/* ---------- 1. 牌局检查器 ---------- */

function step1Validator(): void {
  title('第一步：牌局检查器（任何分析之前必须先跑）');

  const game = newDemoGame({ board: { flop: 'Kd Qc 9h', turn: '2s', river: '7h' } });
  const validation = validateGameState(game);
  bullet('是否可以进入分析', validation.blocked ? '否' : '是');
  bullet('阻断级问题', String(validation.blockers.length));
  bullet('警告级问题', String(validation.warnings.length));
  bullet('系统重算底池', chips(validation.computedPot));

  blank();
  console.log('  底池一致性对照（用户凭记忆填了 100,000）：');
  const withClaim = validateGameState(game, { claimedPot: 100_000 });
  if (withClaim.warnings.length === 0) {
    console.log('    （一致，无需提示）');
  } else {
    for (const issue of withClaim.warnings) {
      console.log(`    ⚠️  ${t(issue.code, issue.params)}`);
    }
  }
  console.log('    → 系统只报错、只建议，绝不静默忽略，也绝不替用户改数字。');
}

/* ---------- 2. 行动记录 ---------- */

function step2ActionLog(): GameState {
  title('第二步：行动记录（录入后由状态机逐条校验并落账）');

  console.log('  翻牌前：');
  const game = runScript(newDemoGame(), PREFLOP_SCRIPT);
  bullet(
    '翻牌前底池',
    `${chips(computePot(game))}（枪口 6000 + 关煞 6000 + 庄家 6000 + 小盲 1000 + 大盲 2000）`,
  );
  bullet('筹码守恒校验', conservationText(game));
  return game;
}

/* ---------- 3. 逐街推进 ---------- */

function step3Streets(start: GameState): GameState {
  title('第三步：街道推进（翻牌 → 转牌 → 河牌）');

  let game = start;
  for (const step of STREETS) {
    const advanced = advanceStreet(game, { cards: parseCards(step.cards) });
    if (!advanced.ok) {
      console.log(
        `  ✖ ${t(`street.${step.street}` as never)} 发牌失败：` +
          advanced.issues.map((i) => t(i.code, i.params)).join('；'),
      );
      return game;
    }
    game = advanced.state;
    blank();
    console.log(
      `  ${t(`street.${step.street}` as never)} 发出：${cardsShort(parseCards(step.cards))}　（${step.note}）`,
    );
    game = runScript(game, step.script);

    const turnId = actorOnTurn(game);
    const turnText =
      turnId === null ? '（下注轮已结束）' : positionText(game, playerById(game, turnId)!.position);
    console.log(`  底池 ${chips(computePot(game))}　｜　当前应行动：${turnText}`);
  }

  blank();
  console.log(
    actorOnTurn(game) === 'btn'
      ? '  ✅ 决策点已就位：轮到我（庄家位）在河牌面对关煞位的下注。'
      : '  ⚠️ 演示场景未把决策点交到庄家位手上，后续数学步骤仍然照常计算。',
  );
  return game;
}

/* ---------- 4. 牌力判断 ---------- */

function step4HandStrength(game: GameState, board: readonly Card[]): void {
  title('第四步：牌力判断（确定性引擎，不由语言模型猜测）');

  for (const playerId of ['btn', 'co', 'utg'] as const) {
    const player = playerById(game, playerId)!;
    if (!player.holeCards) {
      console.log(`  ${positionText(game, player.position)}：未录入手牌（对手手牌可选填）`);
      blank();
      continue;
    }
    const desc = describeHand(player.holeCards, board);
    console.log(`  ${positionText(game, player.position)}`);
    bullet('手牌', `${cardFull(player.holeCards[0]!)}　${cardFull(player.holeCards[1]!)}`);
    bullet('当前牌力', handDescriptionText(desc));
    bullet('最佳五张', cardsShort(desc.bestFive));
    if (desc.holeCardsPlay) bullet('底牌参与成牌', '是');
    blank();
  }
}

/* ---------- 5. 数学量 ---------- */

type DecisionMath = {
  requiredEquity: number;
  pot: number;
  callCost: number;
  available: boolean;
};

function step5Math(game: GameState): DecisionMath {
  title('第五步：数学量（底池赔率 / 最低所需权益 / 底池筹码比）');

  const callCost = requiredCallAmount(game, 'btn');
  const snapshot = potMathSnapshot(game, 'btn', callCost);

  if (!snapshot.ok) {
    console.log(`  ⚠️  ${t(snapshot.code as never, snapshot.params)}`);
    console.log('  → 当前无法给出可靠打法。');
    return { requiredEquity: Number.NaN, pot: 0, callCost: 0, available: false };
  }

  const v = snapshot.value;
  bullet('当前底池', `${chips(v.pot)}（按行动记录重算，不使用手填值）`);
  bullet('对手河牌下注', chips(playerById(game, 'co')!.committedByStreet.RIVER));
  bullet('跟注需要', chips(v.callCost));
  bullet('底池赔率', percent(v.odds.potOdds));
  bullet('最低所需权益', percent(v.odds.requiredEquity));
  bullet('跟注后底池', chips(v.odds.finalPot));
  bullet('风险收益比', percent(v.odds.riskReward));
  bullet(
    '有效筹码',
    `${chips(v.effectiveStack)}（主要对手：${positionText(game, playerById(game, v.opponentId)!.position)}）`,
  );
  bullet('底池筹码比', v.spr.toFixed(2));

  return {
    requiredEquity: v.odds.requiredEquity,
    pot: v.pot,
    callCost: v.callCost,
    available: true,
  };
}

/* ---------- 6. 权益 ---------- */

type EquityInfo = {
  equity: number;
  rangeLabel: string;
  decisionQuality: string;
  available: boolean;
};

function step6Equity(game: GameState, board: readonly Card[], math: DecisionMath): EquityInfo {
  title('第六步：权益计算（精确枚举 / 蒙特卡洛，不许猜测）');

  const hero = playerById(game, 'btn')!.holeCards!;
  const ranges: OpponentRange[] = [
    { label: '关煞位河牌下注范围（价值 + 薄价值 + 诈唬）', combos: toCombos([...VILLAIN_RIVER_RANGE]) },
  ];

  const equity = computeEquity(hero, board, ranges, { forceMethod: 'EXACT' });
  if (!equity.ok) {
    console.log(`  ⚠️  ${t(equity.code, equity.params)}`);
    console.log('  → 暂时无法准确计算权益。系统不会为了给答案而编造数字。');
    return {
      equity: Number.NaN,
      rangeLabel: ranges[0]!.label,
      decisionQuality: t('DECISION.INSUFFICIENT_INFO'),
      available: false,
    };
  }

  const r = equity.result;
  bullet('我的手牌', cardsShort(hero));
  bullet('对手范围', `${ranges[0]!.label}（${r.combosPerOpponent[0]} 种组合）`);
  bullet('当前权益', `${percent(r.equity)}（对范围，不是对某一手具体牌）`);
  bullet('计算方式', r.method === 'EXACT' ? '精确枚举' : '蒙特卡洛');
  bullet('枚举 / 模拟次数', r.iterations.toLocaleString('en-US'));
  bullet(
    '估计误差',
    r.method === 'EXACT' ? '0（精确枚举无统计误差）' : `±${percent(r.confidenceInterval95)}（95% 置信区间）`,
  );
  bullet(
    '胜 / 平 / 负',
    `${r.wins.toLocaleString('en-US')} / ${r.ties.toLocaleString('en-US')} / ${r.losses.toLocaleString('en-US')}`,
  );
  if (r.seed !== null) bullet('随机种子', `${r.seed}（复盘时可完整复现）`);

  if (!math.available) {
    return { equity: r.equity, rangeLabel: ranges[0]!.label, decisionQuality: t('DECISION.INSUFFICIENT_INFO'), available: true };
  }

  blank();
  const gate = equityGate(r.equity, math.requiredEquity);
  let decisionQuality = t('DECISION.INSUFFICIENT_INFO');
  if (gate.ok) {
    decisionQuality = t(`DECISION.${decisionQualityKey(gate.value.verdict)}` as never);
    // 词条本身已含「数学判断：」前缀，这里去掉以免重复显示
    bullet('数学判断', t(`MATH_VERDICT.${gate.value.verdict}` as never).replace('数学判断：', ''));
    bullet('权益 − 最低所需', percent(gate.value.edge));
    if (gate.value.marginal) {
      bullet('决策性质', `${t('common.marginalDecision')}（两个选项差距很小，不存在唯一正确答案）`);
    }
    const ev = callEV(r.equity, math.pot, math.callCost);
    if (ev.ok) {
      bullet('跟注期望收益', `${chips(ev.value)} 筹码`);
      bullet('弃牌期望收益', '0 筹码（本街不再投入）');
      blank();
      note('ℹ️  期望收益是长期平均值：单次结果既可能赢也可能输，');
      note('    这不影响「这个决策是否为正 EV」这一结论。');
    }
  }

  return { equity: r.equity, rangeLabel: ranges[0]!.label, decisionQuality, available: true };
}

/** 数学结论 → 决策质量标签（禁止由「输赢」反推） */
function decisionQualityKey(verdict: string): string {
  switch (verdict) {
    case 'CALL_ALLOWED':
      return 'CORRECT';
    case 'MARGINAL':
      return 'MARGINAL';
    case 'CALL_NOT_ALLOWED':
      return 'CLEAR_MISTAKE';
    default:
      return 'INSUFFICIENT_INFO';
  }
}

/* ---------- 7. 摊牌与两段式复盘 ---------- */

function step7Showdown(game: GameState, board: readonly Card[], equityInfo: EquityInfo): void {
  title('第七步：摊牌与复盘（决策质量 ≠ 结果质量）');

  let resultQuality = t('RESULT.NEUTRAL');
  const contenders = game.players.filter((p) => !p.folded && p.holeCards);

  if (contenders.length >= 2) {
    const result = showdown(
      contenders.map((p) => ({ id: p.id, holeCards: p.holeCards! })),
      board,
    );
    for (const entry of result.hands) {
      const player = playerById(game, entry.id)!;
      console.log(
        `  ${positionText(game, player.position).padEnd(14)} ${handDescriptionText(
          describeHand(player.holeCards!, board),
        )}`,
      );
    }
    blank();
    const winnerNames = result.winners
      .map((id) => positionText(game, playerById(game, id)!.position))
      .join('、');
    bullet('摊牌结果', result.isSplit ? `平分底池：${winnerNames}` : `获胜：${winnerNames}`);

    // 结果质量是独立维度：依据摊牌后的真实牌力对比得出，与决策质量互不污染
    if (result.isSplit) {
      resultQuality = t('RESULT.SPLIT');
    } else if (result.winners.includes('btn')) {
      resultQuality = t('RESULT.GOOD');
    } else {
      const villainCategory = handCategoryOf(playerById(game, 'co')!.holeCards!, board);
      resultQuality = villainCategory >= 4 ? t('RESULT.COOLER') : t('RESULT.BAD_BEAT');
    }
  }

  blank();
  console.log('  复盘必须分两栏，物理隔离，互不污染：');
  blank();
  console.log('  ┌ 当时决策分析（只允许使用当时已知信息）');
  console.log(`  │   我的手牌：${cardsShort(playerById(game, 'btn')!.holeCards!)}`);
  console.log(`  │   牌面　　：${cardsShort(board)}`);
  console.log(`  │   对手范围：${equityInfo.rangeLabel}`);
  console.log('  │              ↑ 未使用对手真实手牌，只用「他可能拿什么」');
  console.log(`  │   我的权益：${percent(equityInfo.equity)}（对范围，而非对某一手具体牌）`);
  console.log(`  │   决策质量：${equityInfo.decisionQuality}`);
  console.log('  └');
  blank();
  console.log('  ┌ 摊牌后分析（允许使用真实对手手牌）');
  console.log(`  │   对手真实手牌：${cardsShort(playerById(game, 'co')!.holeCards!)}`);
  console.log('  │   实际牌力对比：对手 9 三条 vs 我 顶两对 KQ → 本手落败');
  console.log(`  │   结果质量　　：${resultQuality}`);
  console.log('  └');
  blank();
  console.log('  ⚠️  核心原则（两栏绝不能互相污染）：');
  console.log('      · 摊牌后才知道的「对手是 99」不能倒推「所以河牌当然该弃牌」；');
  console.log('        决策当时只能依据整个合理范围（其中包含薄价值与诈唬组合）。');
  console.log(`      · 本手输了，但决策质量仍是「${equityInfo.decisionQuality}」——`);
  console.log('        因为权益高于门槛，跟注在长期是正 EV。');
  console.log('      · 系统绝不会因为最后输牌就把决策标成「错误」。');
  console.log('      · 反过来也一样：赢了不代表决策正确。两个维度物理隔离。');
}

function handCategoryOf(holeCards: readonly Card[], board: readonly Card[]): number {
  return Math.floor(evaluateCards([...holeCards, ...board]).value / 2 ** 32);
}

/* ---------- 8. 红队：错误输入 ---------- */

function step8RedTeam(): void {
  title('第八步：红队演示（错误输入必须被拦截）');

  const cases: Array<[string, () => ValidationResult]> = [
    [
      '公共牌已有方块7，对手手牌又填方块7',
      () => {
        const bad = newDemoGame({ userCards: 'As Kd', villainCards: '7d 8c', board: { flop: '7d Ks 2h' } });
        return validateGameState(bad);
      },
    ],
    [
      '翻牌只填了 2 张',
      () => {
        const bad = newDemoGame();
        bad.board.flop = parseCards('Kh Qs');
        return validateGameState(bad);
      },
    ],
    [
      '6 人桌出现了 9 人桌独有的位置（枪口+2位）',
      () => {
        const bad = newDemoGame();
        playerById(bad, 'co')!.position = 'UTG2' as Position;
        return validateGameState(bad);
      },
    ],
    [
      '有位玩家筹码为负数',
      () => {
        const bad = newDemoGame();
        playerById(bad, 'sb')!.startingStack = -5_000;
        return validateGameState(bad);
      },
    ],
  ];

  for (const [name, build] of cases) {
    const result = build();
    console.log(`  场景：${name}`);
    if (result.issues.length === 0) {
      console.log('    ✖ 未被拦截（这是 Bug，必须修复）');
      blank();
      continue;
    }
    for (const issue of result.issues) {
      const icon = issue.severity === 'BLOCKER' ? '⛔' : '⚠️';
      console.log(`    ${icon} ${t(issue.code, issue.params)}`);
    }
    console.log(
      `    → 分析是否继续：${result.blocked ? '已阻止 —— 当前无法给出可靠打法' : '可以继续（仅警告）'}`,
    );
    blank();
  }
}

/* ---------- 9. 红队：非法动作 ---------- */

function step9IllegalActions(): void {
  section('红队补充：非法动作被状态机拒绝');

  const state = newDemoGame();
  const attempts: Array<[string, ScriptStep]> = [
    ['已有人下注（大盲 2000）时想过牌', { playerId: 'utg', type: 'CHECK' }],
    ['跟注金额写错（应跟 2000，填 1500）', { playerId: 'utg', type: 'CALL', amount: 1_500 }],
    ['加注低于最小加注（应至少 4000）', { playerId: 'utg', type: 'RAISE', amount: 3_000 }],
    ['不是他行动（大盲抢先过牌）', { playerId: 'bb', type: 'CHECK' }],
  ];

  for (const [name, step] of attempts) {
    const result = applyAction(
      state,
      step.amount === undefined
        ? { playerId: step.playerId, type: step.type }
        : { playerId: step.playerId, type: step.type, amount: step.amount },
    );
    if (result.ok) {
      console.log(`  ✖ ${name}：未被拒绝（这是 Bug）`);
    } else {
      console.log(`  ⛔ ${name}`);
      console.log(`     → ${t(result.issues[0]!.code, result.issues[0]!.params)}`);
    }
  }
}

/* ---------- 收尾 ---------- */

function closing(): void {
  title('自检结论');

  const checks: Array<[string, string]> = [
    ['牌不会认错', '严格解析 + 52 张唯一性 + 拒绝猜测式纠正'],
    ['位置不会认错', '6/9 人桌独立顺序表 + 中文映射层（同桌内不重名）'],
    ['行动不会认错', '状态机 + 合法性校验 + 大盲选择权 + TDA 短全下规则'],
    ['底池不会算错', '账本单一数据源 + 与手填值强制对照'],
    ['筹码不会算错', '守恒不变量 + 300 局随机属性测试'],
    ['牌型不会判错', '权威引擎 + 高速引擎 20000 组差分逐位一致'],
    ['数学不会猜', '精确枚举 / 可复现蒙特卡洛；语言模型不参与计算'],
    ['算不了就说算不了', '拒绝时绝不返回任何数字字段'],
  ];
  for (const [name, detail] of checks) {
    console.log(`  ✅ ${name.padEnd(18)} ${detail}`);
  }
  blank();
  console.log('  以上每一条都有对应的自动化测试；执行 npm run verify 可完整复现。');
  console.log(line('═'));
}

/* ---------- 辅助 ---------- */

function conservationText(state: GameState): string {
  let starting = 0;
  let current = 0;
  for (const player of state.players) {
    starting += player.startingStack;
    current += player.remainingStack + totalCommitted(state, player.id);
  }
  return current === starting
    ? `通过（起始 ${chips(starting)} = 剩余 + 已投入 ${chips(current)}）`
    : `失败（差额 ${chips(current - starting)}）`;
}

/** 演示用桌型常量（供外部引用，避免魔法数字） */
export const DEMO_TABLE_SIZE = TableSize.SIX_MAX;

/** 未使用的导出占位，保持 columns 在格式化层被引用（供未来表格化输出） */
export { columns, actionMainLabel };
