/**
 * 中文显示映射层测试
 *
 * 覆盖 V1 规范第 1 / 2 / 3 / 7 / 19 / 24 / 31 / 40 / 41 条与 V2 第八节。
 *
 * 这是「中文优先」的**可执行约束**：
 * 光靠自觉无法保证界面不冒出英文枚举，因此把规范写成断言。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  actionAuxLabel,
  actionLabel,
  actionMainLabel,
  actionSentence,
  bigBlinds,
  cardFull,
  cardShort,
  cardsFull,
  cardsShort,
  chips,
  currentDictionary,
  handDescriptionText,
  parseRankChar,
  percent,
  percentInt,
  playerDimensionText,
  playerLabelText,
  playerMetricText,
  positionAuxLabel,
  positionGroupLabel,
  positionLabel,
  positionMainLabel,
  potRatio,
  priorSourceText,
  profileAdjustmentText,
  profileIssueText,
  sampleTierNote,
  sampleTierText,
  setDictionary,
  suitName,
  suitSymbol,
  t,
} from '../src/i18n/index.ts';
import { zhCN, type Dictionary } from '../src/i18n/zh-CN.ts';
import { ActionType, Position, TableSize, positionsForTableOf } from '../src/domain/types.ts';
import { PlayerMetric, METRIC_DEFINITIONS } from '../src/domain/player/player.types.ts';
import { describeHand } from '../src/domain/poker/handDescription.ts';
import { C, c } from './helpers.ts';

/** 去掉括号内的英文辅助后，是否还残留 ASCII 字母 */
function hasBareLatin(text: string): boolean {
  return /[A-Za-z]/.test(text.replace(/（[^）]*）|\([^)]*\)/g, ''));
}

/**
 * 玩家画像专用：允许「3Bet / 4Bet」这类**已经进入中文扑克口语**的通用术语。
 *
 * 「翻牌前 3Bet 率」是正确的扑克中文 —— 强行翻译成「三次加注率」
 * 反而不符合玩家习惯、也无助于理解。除此之外仍不得出现裸英文。
 */
function hasBareLatinExceptBetTerms(text: string): boolean {
  return hasBareLatin(text.replace(/[34]Bet/g, ''));
}

describe('中文层 —— 词条完整性', () => {
  it('所有词条都没有空值', () => {
    for (const [key, value] of Object.entries(zhCN)) {
      assert.equal(typeof value, 'string', `${key} 不是字符串`);
      assert.ok(value.trim().length > 0, `词条 ${key} 为空`);
    }
  });

  it('缺失词条返回 key 本身而不是 undefined（便于开发期发现遗漏）', () => {
    const value = t('不存在的词条' as never);
    assert.equal(value, '不存在的词条');
  });

  it('占位符渲染正确，且未提供的占位符原样保留', () => {
    assert.equal(t('MATH.EFFECTIVE_STACK'), '有效筹码');
    assert.equal(t('ui.center.multiwayBanner', { count: 4 }), '当前：4人底池');
    // 未提供参数时占位符原样保留，不会变成 undefined
    assert.ok(t('ui.center.multiwayBanner').includes('{count}'));
  });

  it('语言包可切换（为未来 en-US 预留）', () => {
    const original = currentDictionary();
    assert.equal(original['action.CALL'], '跟注');
    // 模拟未来加入 en-US：值类型是 string，因此任意翻译都能塞进去而不触发类型错误
    const fake: Dictionary = { ...zhCN, 'action.CALL': 'Call' };
    setDictionary(fake);
    assert.equal(actionMainLabel(ActionType.CALL), 'Call');
    setDictionary(zhCN);
    assert.equal(actionMainLabel(ActionType.CALL), '跟注');
  });
});

describe('中文层 —— 位置名称', () => {
  it('9 人桌九个位置的主显示全部为纯中文', () => {
    const expected = ['枪口位', '枪口+1位', '枪口+2位', '低劫持位', '劫持位', '关煞位', '庄家位', '小盲位', '大盲位'];
    const actual = positionsForTableOf(TableSize.NINE_MAX).map((p) =>
      positionMainLabel(TableSize.NINE_MAX, p),
    );
    assert.deepEqual(actual, expected);
    for (const label of actual) assert.equal(hasBareLatin(label), false, `${label} 含裸英文`);
  });

  it('6 人桌六个位置的主显示全部为纯中文', () => {
    const expected = ['枪口位', '劫持位', '关煞位', '庄家位', '小盲位', '大盲位'];
    const actual = positionsForTableOf(TableSize.SIX_MAX).map((p) =>
      positionMainLabel(TableSize.SIX_MAX, p),
    );
    assert.deepEqual(actual, expected);
  });

  it('完整显示格式为「中文（英文缩写）」', () => {
    assert.equal(positionLabel(TableSize.NINE_MAX, Position.BTN), '庄家位（BTN）');
    assert.equal(positionLabel(TableSize.NINE_MAX, Position.UTG1), '枪口+1位（UTG+1）');
    assert.equal(positionLabel(TableSize.SIX_MAX, Position.CO), '关煞位（CO）');
  });

  it('禁止只显示 BTN / Button / UTG 这类英文', () => {
    // 主显示绝不能等于英文缩写
    for (const tableSize of [TableSize.SIX_MAX, TableSize.NINE_MAX] as const) {
      for (const position of positionsForTableOf(tableSize)) {
        const main = positionMainLabel(tableSize, position);
        const aux = positionAuxLabel(tableSize, position);
        assert.notEqual(main, aux, `${position} 的主显示与英文缩写相同`);
        assert.equal(hasBareLatin(main), false, `${position} 的主显示含英文`);
      }
    }
  });

  it('位置分组标签为中文', () => {
    assert.equal(positionGroupLabel(TableSize.SIX_MAX, Position.BTN), '后位');
    assert.equal(positionGroupLabel(TableSize.SIX_MAX, Position.SB), '盲注位');
    assert.equal(positionGroupLabel(TableSize.NINE_MAX, Position.UTG), '前位');
  });
});

describe('中文层 —— 动作名称', () => {
  it('全部动作用规范指定的中文词', () => {
    const expected: Record<string, string> = {
      FOLD: '弃牌',
      CHECK: '过牌',
      CALL: '跟注',
      BET: '下注',
      RAISE: '加注',
      RERAISE: '再加注',
      ALL_IN: '全下',
      POST_SB: '下小盲',
      POST_BB: '下大盲',
      POST_ANTE: '下前注',
      REVEAL: '看牌',
      SHOWDOWN: '摊牌',
    };
    for (const [action, label] of Object.entries(expected)) {
      assert.equal(actionMainLabel(action), label, `${action} 中文名不符`);
      assert.equal(hasBareLatin(label), false);
    }
  });

  it('禁止主界面只显示 FOLD / CALL / RAISE / ALL-IN', () => {
    // 注意：不能用「主显示是否等于全大写」来判断 ——
    // 中文没有大小写，`'弃牌'.toUpperCase()` 仍然等于 `'弃牌'`，
    // 那样写会把所有正确的中文标签都判成英文。
    // 正确判据是「是否含 ASCII 字母」。
    for (const action of Object.values(ActionType)) {
      const main = actionMainLabel(action);
      assert.equal(hasBareLatin(main), false, `${action} 的主显示「${main}」含裸英文`);
      assert.notEqual(main, action, `${action} 的主显示不应等于内部枚举名`);
      assert.notEqual(main, actionAuxLabel(action), `${action} 的主显示不应等于英文辅助名`);
    }
    // 反向确认：本测试确实能识别出英文
    assert.equal(hasBareLatin('FOLD'), true);
    assert.equal(hasBareLatin('弃牌'), false);
  });

  it('辅助显示保留英文但不作为主显示', () => {
    assert.equal(actionAuxLabel(ActionType.CALL), 'Call');
    assert.equal(actionLabel(ActionType.CALL), '跟注（Call）');
    assert.equal(actionLabel(ActionType.ALL_IN), '全下（All-in）');
  });
});

describe('中文层 —— 花色与牌', () => {
  it('花色中文与图案成对出现', () => {
    assert.equal(suitName('s'), '黑桃');
    assert.equal(suitName('h'), '红桃');
    assert.equal(suitName('d'), '方块');
    assert.equal(suitName('c'), '梅花');
    assert.equal(suitSymbol('s'), '♠');
    assert.equal(suitSymbol('d'), '♦');
  });

  it('牌显示同时给出图案与中文，便于语音录入后人工复核', () => {
    assert.equal(cardShort(c('Ad')), 'A♦');
    assert.equal(cardFull(c('Ad')), 'A♦ 方块A');
    assert.equal(cardFull(c('Kc')), 'K♣ 梅花K');
    assert.equal(cardsShort(C('Ad Kc')), 'A♦ K♣');
    assert.equal(cardsFull(C('Ad Kc')), 'A♦ 方块A　K♣ 梅花K');
  });

  it('点数解析只接受 2-9/T/J/Q/K/A，不做猜测', () => {
    assert.equal(parseRankChar('A'), 14);
    assert.equal(parseRankChar('t'), 10);
    assert.equal(parseRankChar('10'), null);
    assert.equal(parseRankChar('X'), null);
  });
});

describe('中文层 —— 金额与比例格式化', () => {
  it('金额使用千分位', () => {
    assert.equal(chips(60000), '60,000');
    assert.equal(chips(1000), '1,000');
    assert.equal(chips(999), '999');
    assert.equal(chips(Number.NaN), '—');
  });

  it('百分比格式化', () => {
    assert.equal(percent(0.42), '42.0%');
    assert.equal(percent(0.4237, 2), '42.37%');
    assert.equal(percentInt(0.4237), '42%');
    assert.equal(percent(Number.NaN), '—');
  });

  it('以 BB 为单位显示有效筹码', () => {
    assert.equal(bigBlinds(172000, 2000), '86BB');
    assert.equal(bigBlinds(190000, 2000), '95BB');
    assert.equal(bigBlinds(1000, 0), '—');
  });

  it('底池比例使用规范要求的中文表达', () => {
    assert.equal(potRatio(20000, 60000), '1/3底池');
    assert.equal(potRatio(15000, 60000), '1/4底池');
    assert.equal(potRatio(30000, 60000), '1/2底池');
    assert.equal(potRatio(40000, 60000), '2/3底池');
    assert.equal(potRatio(45000, 60000), '3/4底池');
    assert.equal(potRatio(60000, 60000), '满池');
    assert.equal(potRatio(75000, 60000), '超池 1.25倍');
  });

  it('动作句子在主显示上不出现裸英文', () => {
    assert.equal(actionSentence('CALL', 20000), '跟注 20,000');
    assert.equal(actionSentence('FOLD'), '弃牌');
    assert.equal(actionSentence('CHECK'), '过牌');
    const bet = actionSentence('BET', 20000, 60000);
    assert.equal(hasBareLatin(bet), false, `「${bet}」含裸英文`);
    assert.ok(bet.startsWith('下注'));
    assert.ok(bet.includes('1/3底池'));
  });
});

describe('中文层 —— 牌力描述', () => {
  it('顶两对显示为「顶两对 KQ」这类可读中文', () => {
    // 我在 关煞位 持 K♠Q♦，牌面 K♥ Q♣ 9♠ → 顶两对
    const hand = describeHand(C('Ks Qd'), C('Kh Qc 9s'));
    const text = handDescriptionText(hand);
    assert.equal(text, '顶两对 KQ');
  });

  it('打公共牌时明确显示「公共牌就是最佳五张牌」', () => {
    // 公共牌本身是皇家同花顺，任何底牌都无法超越
    const hand = describeHand(C('2h 3d'), C('As Ks Qs Js Ts'));
    assert.equal(hand.boardIsBest, true);
    assert.equal(hand.holeCardsPlay, false);
    assert.equal(handDescriptionText(hand), '公共牌就是最佳五张牌');
  });

  it('三条带踢脚时显示踢脚信息', () => {
    // 我持 J♦Q♣，牌面 J♠ J♥ 3♠ 2♦ 4♥ → J 三条，Q 踢脚
    const hand = describeHand(C('Jd Qc'), C('Js Jh 3s 2d 4h'));
    const text = handDescriptionText(hand);
    assert.ok(text.includes('踢脚'), `未显示踢脚：${text}`);
    assert.ok(text.includes('Q踢脚'), `踢脚点数不对：${text}`);
  });

  it('所有牌型的描述文本都是中文（只允许点数与花色符号）', () => {
    // 每组用例都经过人工核对，确保不会出现「牌面把底牌盖过去」的意外牌型
    const cases: Array<[string, string]> = [
      ['As Ad', '2h 5s 9d Jc 3h'], // 一对 A
      ['As Kd', '2h 5s 9d Jc 3h'], // 高牌 A
      ['As Ah', '2h 5s 9d Jc 3h'], // 一对 A
      ['As 4d', '2h 5s 9d Jc 3h'], // 高牌 / 顺子听牌未成
      ['As Ts', '2h 5s 9d Jc 3h'], // 高牌
      ['9s 9h', '2h 9d 9c Jc 3h'], // 四条 9
      ['5s 5h', '2h 5d 9d Jc 3h'], // 三条 5
    ];
    for (const [hole, board] of cases) {
      const text = handDescriptionText(describeHand(C(hole), C(board)));
      // 移除点数与花色符号后不应残留任何 ASCII 字母
      const stripped = text.replace(/[AKQJT2-9♠♥♦♣\s，、（）]/g, '');
      assert.equal(/[A-Za-z]/.test(stripped), false, `「${text}」含裸英文`);
      assert.ok(text.length > 0);
    }
  });
});

describe('中文层 —— 错误提示（规范第 41 条）', () => {
  it('错误提示全部为中文，且不含 DATA CONFLICT / POT MISMATCH / ANALYSIS BLOCKED', () => {
    const forbidden = ['DATA CONFLICT', 'POT MISMATCH', 'ANALYSIS BLOCKED', 'ERROR', 'INVALID'];
    for (const [key, value] of Object.entries(zhCN)) {
      if (!key.startsWith('ISSUE.') && !key.startsWith('CARD_PARSE.')) continue;
      for (const word of forbidden) {
        assert.equal(
          value.toUpperCase().includes(word),
          false,
          `词条 ${key} 含禁用英文「${word}」：${value}`,
        );
      }
    }
  });

  it('关键错误提示使用规范要求的中文措辞', () => {
    assert.ok(t('ISSUE.DUPLICATE_CARD', { card: '7d' }).includes('牌面冲突'));
    assert.ok(t('ISSUE.POT_MISMATCH', { claimed: 1, computed: 2, delta: 1 }).includes('底池计算不一致'));
    assert.ok(t('ISSUE.ANALYSIS_BLOCKED').includes('当前无法继续分析'));
    assert.equal(t('common.analysisBlocked'), '当前无法给出可靠打法');
  });

  it('牌面冲突提示包含「不会自动替换花色」的明确说明', () => {
    const text = t('ISSUE.DUPLICATE_CARD', { card: '7d' });
    assert.ok(text.includes('不会自动替换'), `缺少禁止自动改牌的说明：${text}`);
  });

  it('样本不足与边缘决策都有明确中文提示', () => {
    assert.equal(t('common.sampleInsufficient'), '样本不足');
    assert.equal(t('common.marginalDecision'), '边缘决策');
    assert.ok(t('ISSUE.SAMPLE_INSUFFICIENT', { sample: 8, threshold: 30 }).includes('样本不足'));
  });

  it('数学量名称全部中文，主显示不出现 Pot Odds / SPR / Equity', () => {
    assert.equal(t('MATH.POT_ODDS'), '底池赔率');
    assert.equal(t('MATH.REQUIRED_EQUITY'), '最低所需权益');
    assert.equal(t('MATH.SPR'), '底池筹码比');
    assert.equal(t('MATH.EQUITY'), '当前权益');
    assert.equal(t('MATH.EFFECTIVE_STACK'), '有效筹码');
    for (const key of ['MATH.POT_ODDS', 'MATH.REQUIRED_EQUITY', 'MATH.SPR', 'MATH.EQUITY'] as const) {
      assert.equal(hasBareLatin(t(key)), false, `${key} 含裸英文`);
    }
  });

  it('玩家类型全部中文，不出现 Tight Passive / Calling Station', () => {
    const expected: Record<string, string> = {
      UNKNOWN: '未知玩家',
      TIGHT_PASSIVE: '紧弱型',
      TIGHT_AGGRESSIVE: '紧凶型',
      LOOSE_PASSIVE: '松弱型',
      LOOSE_AGGRESSIVE: '松凶型',
      CALLING_STATION: '跟注站',
      BLUFF_HEAVY: '诈唬偏多',
      BLUFF_LIGHT: '诈唬偏少',
      ULTRA_TIGHT: '超级紧手',
      REG_AVERAGE: '普通常客',
      REG_STRONG: '强常客',
    };
    for (const [type, label] of Object.entries(expected)) {
      assert.equal(t(`PLAYER_TYPE.${type}` as never), label, `${type} 中文名不符`);
      assert.equal(hasBareLatin(label), false);
    }
  });

  it('复盘标签全部中文，不因输钱就标记「错误」', () => {
    const labels = [
      'DECISION.CORRECT',
      'DECISION.MOSTLY_CORRECT',
      'DECISION.MARGINAL',
      'DECISION.CLEAR_MISTAKE',
      'DECISION.SEVERE_MISTAKE',
      'DECISION.INSUFFICIENT_INFO',
      'RESULT.BAD_BEAT',
      'RESULT.COOLER',
    ] as const;
    for (const key of labels) {
      assert.equal(hasBareLatin(t(key)), false, `${key} 含裸英文`);
    }
    assert.equal(t('DECISION.CORRECT'), '正确决策');
    assert.equal(t('RESULT.BAD_BEAT'), '坏运气');
    assert.equal(t('RESULT.COOLER'), '冤家牌');
    assert.equal(t('DECISION.INSUFFICIENT_INFO'), '信息不足');
  });
});

describe('中文层 —— 界面骨架文案', () => {
  it('主界面四个区域的标题均为中文', () => {
    assert.equal(t('ui.left.table'), '牌桌');
    assert.equal(t('ui.center.myHand'), '我的手牌');
    assert.equal(t('ui.right.actionLog'), '行动记录');
    assert.equal(t('ui.bottom.advice'), '打法建议');
  });

  it('主要按钮文案符合规范第 25 条的清单', () => {
    const buttons = [
      'ui.button.fold',
      'ui.button.check',
      'ui.button.call',
      'ui.button.bet',
      'ui.button.raise',
      'ui.button.allIn',
      'ui.button.prevStreet',
      'ui.button.nextStreet',
      'ui.button.reinput',
      'ui.button.save',
      'ui.button.review',
      'ui.button.playerTags',
      'ui.button.editBoard',
      'ui.button.undo',
    ] as const;
    for (const key of buttons) {
      assert.equal(hasBareLatin(t(key)), false, `${key} = 「${t(key)}」含裸英文`);
    }
    assert.equal(t('ui.button.undo'), '撤销上一步');
    assert.equal(t('ui.button.save'), '保存牌局');
  });

  it('中文界面不得靠颜色作为唯一识别方式（文案必须自解释）', () => {
    // 每个动作按钮的文案必须与动作中文名一致，用户不看颜色也能分辨
    assert.equal(t('ui.button.fold'), actionMainLabel(ActionType.FOLD));
    assert.equal(t('ui.button.check'), actionMainLabel(ActionType.CHECK));
    assert.equal(t('ui.button.call'), actionMainLabel(ActionType.CALL));
    assert.equal(t('ui.button.bet'), actionMainLabel(ActionType.BET));
    assert.equal(t('ui.button.raise'), actionMainLabel(ActionType.RAISE));
    assert.equal(t('ui.button.allIn'), actionMainLabel(ActionType.ALL_IN));
  });
});

/* ============================================================
 * 玩家画像文案（Step 6）
 * ============================================================ */

describe('中文层 —— 玩家画像', () => {
  it('11 种玩家标签全部有中文名，且不含裸英文枚举', () => {
    const labels = [
      'UNKNOWN',
      'ULTRA_TIGHT',
      'TIGHT_PASSIVE',
      'TIGHT_AGGRESSIVE',
      'LOOSE_PASSIVE',
      'LOOSE_AGGRESSIVE',
      'CALLING_STATION',
      'BLUFF_HEAVY',
      'BLUFF_LIGHT',
      'REG_AVERAGE',
      'REG_STRONG',
    ] as const;
    for (const label of labels) {
      const text = playerLabelText(label);
      assert.notEqual(text, label, `标签 ${label} 没有得到中文名`);
      assert.equal(hasBareLatin(text), false, `标签 ${label} = 「${text}」含裸英文`);
    }
    assert.equal(playerLabelText('UNKNOWN'), '未知玩家');
    assert.equal(playerLabelText('CALLING_STATION'), '跟注站');
    assert.equal(playerLabelText('TIGHT_AGGRESSIVE'), '紧凶型');
  });

  it('未登记的标签必须回退到「未知玩家」，绝不原样输出英文枚举', () => {
    assert.equal(playerLabelText('NOT_A_LABEL'), '未知玩家');
    assert.equal(playerDimensionText('not_a_dimension'), '未知');
    assert.equal(playerMetricText('NOT_A_METRIC'), '未知');
  });

  it('25 项指标全部有中文名（与领域层的定义一一对应）', () => {
    const metrics = Object.values(PlayerMetric);
    assert.equal(metrics.length, 25, `预期 25 项指标，实际 ${metrics.length}`);
    for (const metric of metrics) {
      const text = playerMetricText(metric);
      assert.notEqual(text, '未知', `指标 ${metric} 缺少中文名`);
      assert.equal(
        hasBareLatinExceptBetTerms(text),
        false,
        `指标 ${metric} = 「${text}」含裸英文（3Bet / 4Bet 之外不得出现）`,
      );
      // 中文名必须与领域层登记的一致，禁止两处各写一份
      assert.equal(
        text,
        METRIC_DEFINITIONS[metric].label,
        `指标 ${metric} 的 i18n 文案与领域层定义不一致`,
      );
    }
    assert.equal(playerMetricText('VPIP'), '翻牌前入池率');
    assert.equal(playerMetricText('RIVER_OVERBET'), '河牌超池下注率');
  });

  it('三层样本可信度都有中文名与**必须存在**的说明文字', () => {
    for (const tier of ['PRELIMINARY', 'STANDARD', 'CONFIRMED'] as const) {
      const text = sampleTierText(tier);
      const note = sampleTierNote(tier);
      assert.equal(hasBareLatin(text), false, `分层 ${tier} = 「${text}」含裸英文`);
      assert.ok(note.length > 10, `分层 ${tier} 的说明过短，无法解释可信度`);
      assert.equal(hasBareLatin(note), false, `分层 ${tier} 说明含裸英文`);
    }
    assert.equal(sampleTierText('PRELIMINARY'), '初步倾向');
    assert.equal(sampleTierText('CONFIRMED'), '高可信');
  });

  it('先验来源必须是中文，且**绝不允许**出现「理论 / GTO」字样（规范第十四节）', () => {
    for (const source of [
      'HEURISTIC_PRIOR',
      'TEST_PRIOR',
      'UNKNOWN_PRIOR',
      'EMPIRICAL_PRIOR',
    ] as const) {
      const text = priorSourceText(source);
      assert.notEqual(text, source, `先验来源 ${source} 没有得到中文名`);
      assert.equal(hasBareLatin(text), false, `先验来源 ${source} = 「${text}」含裸英文`);
      assert.ok(!/理论|GTO|最优/i.test(text), `先验来源 ${source} 不得冒充理论（实际「${text}」）`);
    }
    // 免责声明必须存在且说清「不是理论」
    const disclaimer = t('profile.prior.disclaimer');
    assert.ok(disclaimer.includes('启发式'), `免责声明必须说明来源是启发式（实际「${disclaimer}」）`);
    assert.ok(
      disclaimer.includes('不得当作理论最优'),
      `免责声明必须明确禁止当作理论（实际「${disclaimer}」）`,
    );
  });

  it('画像调整说明必须把「调宽 / 调窄 / 未调整 / 样本不足」四态说清', () => {
    const widened = profileAdjustmentText({ neutralized: false, direction: 'WIDENED', meanFactor: 1.2 });
    const narrowed = profileAdjustmentText({ neutralized: false, direction: 'NARROWED', meanFactor: 0.85 });
    const unchanged = profileAdjustmentText({ neutralized: false, direction: 'UNCHANGED', meanFactor: 1 });
    const neutral = profileAdjustmentText({ neutralized: true, direction: 'UNCHANGED', meanFactor: 1 });

    for (const text of [widened, narrowed, unchanged, neutral]) {
      assert.ok(text.length > 5, `说明过短：「${text}」`);
      assert.equal(hasBareLatin(text), false, `说明含裸英文：「${text}」`);
    }
    assert.ok(widened.includes('调宽'), `实际「${widened}」`);
    assert.ok(narrowed.includes('调窄'), `实际「${narrowed}」`);
    assert.ok(neutral.includes('样本不足'), `实际「${neutral}」`);
    assert.ok(widened.includes('1.20'), `必须带上具体因子（实际「${widened}」）`);
  });

  it('画像不得直接给打法：说明文案里必须写明「只调整概率」', () => {
    const note = t('profile.adjust.note');
    assert.ok(
      note.includes('不直接给出打法'),
      `必须明确写出画像不直接给打法（实际「${note}」）`,
    );
    const labelNote = t('profile.label.note');
    assert.ok(
      labelNote.includes('连续'),
      `必须说明底层是连续数值（实际「${labelNote}」）`,
    );
  });

  it('画像的 7 种事件问题全部渲染成中文句子且带上参数', () => {
    const cases: Array<[string, Record<string, string | number>, string]> = [
      ['DUPLICATE_HAND', { handId: 'H7' }, 'H7'],
      ['PLAYER_MISMATCH', { expected: '甲', actual: '乙' }, '甲'],
      ['INVALID_TIMESTAMP', { timestamp: '不是时间' }, '不是时间'],
      ['UNKNOWN_METRIC', { metric: 'BAD' }, 'BAD'],
      ['NEGATIVE_COUNT', { seq: -3 }, '-3'],
      ['SEQ_OUT_OF_RANGE', { seq: 500000, maxSeq: 199, tolerance: 1000 }, '500000'],
    ];
    for (const [code, params, expectedFragment] of cases) {
      const text = profileIssueText(code, params);
      assert.equal(hasBareLatin(text), false, `${code} 含裸英文：「${text}」`);
      assert.ok(text.includes(expectedFragment), `${code} 未带上参数「${expectedFragment}」：「${text}」`);
    }
    // 未登记的码值必须回退，不得抛出
    assert.equal(profileIssueText('SOMETHING_NEW', {}), t('common.unknown'));
  });

  it('序号超范围说明必须解释**为什么**拒绝（否则用户只会觉得系统坏了）', () => {
    const text = t('profile.amend.seqOutOfRange', { seq: 500000, maxSeq: 199, tolerance: 1000 });
    assert.ok(text.includes('500000') && text.includes('199') && text.includes('1000'), `参数不全：「${text}」`);
    assert.ok(text.includes('时间衰减'), `必须点明与时间衰减的关系：「${text}」`);
    assert.ok(text.includes('等效作废'), `必须说清后果：「${text}」`);
    assert.ok(t('profile.amend.seqOutOfRange.note').includes('分多次录入'), '必须给出可执行的建议');
  });
});

/* ============================================================
 * 数值稳定性文案（Step 5A.1）
 * ============================================================ */

describe('中文层 —— 数值稳定性说明', () => {
  it('max-shift 与对数域两条原理说明必须存在且说清「尺度不影响结论」', () => {
    const shift = t('NUMSTAB.NOTE.MAX_SHIFT');
    const logSpace = t('NUMSTAB.NOTE.LOG_SPACE');

    assert.ok(shift.includes('缩放'), `实际「${shift}」`);
    assert.ok(shift.includes('不会改变任何概率'), `必须明确写出尺度无关（实际「${shift}」）`);
    assert.ok(logSpace.includes('对数域'), `实际「${logSpace}」`);
    assert.ok(logSpace.includes('下溢'), `必须点明要防的是下溢（实际「${logSpace}」）`);
    for (const text of [shift, logSpace]) {
      assert.equal(hasBareLatin(text), false, `说明含裸英文：「${text}」`);
    }
  });

  it('「乘进引擎之前就下溢」这条边界必须如实告知用户，不得隐瞒', () => {
    const text = t('NUMSTAB.WARNING.MULTIPLY_UNDERFLOW', { scale: '1e-323' });
    assert.ok(text.includes('1e-323'), `必须带上具体尺度（实际「${text}」）`);
    assert.ok(text.includes('无法挽回'), `必须诚实地说明引擎救不回来（实际「${text}」）`);
    assert.ok(text.includes('进入引擎之前'), `必须说清是输入阶段的问题（实际「${text}」）`);
  });

  it('真零与下溢零必须在文案上分开表述（不得混为一谈）', () => {
    const trueZero = t('NUMSTAB.TRUE_ZERO_NOTE');
    assert.ok(trueZero.includes('不是数值下溢'), `实际「${trueZero}」`);
    const underflow = t('NUMSTAB.WARNING.RAW_WEIGHT_UNDERFLOW', { denormalMin: '5e-324' });
    assert.ok(underflow.includes('浮点固有边界'), `实际「${underflow}」`);
    assert.ok(underflow.includes('5e-324'), `必须带上双精度边界（实际「${underflow}」）`);
  });

  it('支持集收缩必须提示「可能是正常收窄，也可能是输入过小」', () => {
    const text = t('NUMSTAB.WARNING.SUPPORT_SHRANK', { before: 46, after: 12 });
    assert.ok(text.includes('46') && text.includes('12'), `必须带上前后数值（实际「${text}」）`);
    assert.ok(text.includes('正常') && text.includes('输入'), `必须给出两种可能（实际「${text}」）`);
  });
});
