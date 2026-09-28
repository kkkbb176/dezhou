/**
 * 简体中文词条表（V1 默认且唯一语言）。
 *
 * 规范第 2 / 3 / 7 / 12 / 17 / 19 / 24 / 31 / 40 / 41 / 47 条。
 *
 * 硬性约定：
 * - 英文只允许出现在中文之后的括号内，作为辅助信息。
 * - 位置名称按「桌型 + 座位」解析，见 positionLabel。
 * - 消息模板中的占位符使用 {name} 形式，由 t() 渲染。
 */

export const zhCN = {
  /* ================= 语言与通用 ================= */
  'lang.name': '简体中文',
  'common.yes': '是',
  'common.no': '否',
  'common.none': '无',
  'common.unknown': '未知',
  'common.sampleInsufficient': '样本不足',
  'common.marginalDecision': '边缘决策',
  'common.notComputable': '暂时无法准确计算权益。',
  'common.analysisBlocked': '当前无法给出可靠打法',
  'common.chips': '筹码',
  'common.bb': 'BB',
  'common.pot': '底池',
  /** 百分比渲染：`t('common.percent', { value: '27.0' })` → `27.0%` */
  'common.percent': '{value}%',
  /** 「建议：」前缀（Alpha 决策输出首屏用） */
  'common.suggestion': '建议：',

  /* ================= 街 ================= */
  'street.PREFLOP': '翻牌前',
  'street.FLOP': '翻牌',
  'street.TURN': '转牌',
  'street.RIVER': '河牌',

  /* ================= 位置 ================= */
  // 9 人桌
  'position.9.1': '枪口位',
  'position.9.1.aux': 'UTG',
  'position.9.2': '枪口+1位',
  'position.9.2.aux': 'UTG+1',
  'position.9.3': '枪口+2位',
  'position.9.3.aux': 'UTG+2',
  'position.9.4': '低劫持位',
  'position.9.4.aux': 'LJ',
  'position.9.5': '劫持位',
  'position.9.5.aux': 'HJ',
  'position.9.6': '关煞位',
  'position.9.6.aux': 'CO',
  'position.9.7': '庄家位',
  'position.9.7.aux': 'BTN',
  'position.9.8': '小盲位',
  'position.9.8.aux': 'SB',
  'position.9.9': '大盲位',
  'position.9.9.aux': 'BB',
  // 6 人桌
  'position.6.1': '枪口位',
  'position.6.1.aux': 'UTG',
  'position.6.2': '劫持位',
  'position.6.2.aux': 'HJ',
  'position.6.3': '关煞位',
  'position.6.3.aux': 'CO',
  'position.6.4': '庄家位',
  'position.6.4.aux': 'BTN',
  'position.6.5': '小盲位',
  'position.6.5.aux': 'SB',
  'position.6.6': '大盲位',
  'position.6.6.aux': 'BB',
  // 位置名词（用于说明文字）
  'position.role.blind': '盲注位',
  'position.role.late': '后位',
  'position.role.middle': '中位',
  'position.role.early': '前位',

  /* ================= 动作 ================= */
  'action.FOLD': '弃牌',
  'action.FOLD.aux': 'Fold',
  'action.CHECK': '过牌',
  'action.CHECK.aux': 'Check',
  'action.CALL': '跟注',
  'action.CALL.aux': 'Call',
  'action.BET': '下注',
  'action.BET.aux': 'Bet',
  'action.RAISE': '加注',
  'action.RAISE.aux': 'Raise',
  'action.RERAISE': '再加注',
  'action.RERAISE.aux': 'Re-raise',
  'action.ALL_IN': '全下',
  'action.ALL_IN.aux': 'All-in',
  'action.POST_SB': '下小盲',
  'action.POST_SB.aux': 'Post SB',
  'action.POST_BB': '下大盲',
  'action.POST_BB.aux': 'Post BB',
  'action.POST_ANTE': '下前注',
  'action.POST_ANTE.aux': 'Post Ante',
  'action.STRADDLE': '抓头',
  'action.STRADDLE.aux': 'Straddle',
  'action.REVEAL': '看牌',
  'action.REVEAL.aux': 'Reveal',
  'action.SHOWDOWN': '摊牌',
  'action.SHOWDOWN.aux': 'Showdown',

  /* ================= 花色 ================= */
  'suit.s': '黑桃',
  'suit.h': '红桃',
  'suit.d': '方块',
  'suit.c': '梅花',
  'suit.s.symbol': '♠',
  'suit.h.symbol': '♥',
  'suit.d.symbol': '♦',
  'suit.c.symbol': '♣',

  /* ================= 牌型 ================= */
  'HAND_CATEGORY.HIGH_CARD': '高牌',
  'HAND_CATEGORY.ONE_PAIR': '一对',
  'HAND_CATEGORY.TWO_PAIR': '两对',
  'HAND_CATEGORY.THREE_OF_A_KIND': '三条',
  'HAND_CATEGORY.STRAIGHT': '顺子',
  'HAND_CATEGORY.FLUSH': '同花',
  'HAND_CATEGORY.FULL_HOUSE': '葫芦',
  'HAND_CATEGORY.FOUR_OF_A_KIND': '四条',
  'HAND_CATEGORY.STRAIGHT_FLUSH': '同花顺',

  /* ================= 牌力形态 ================= */
  'HAND_SHAPE.HIGH_CARD': '高牌',
  'HAND_SHAPE.OVERPAIR': '超对',
  'HAND_SHAPE.TOP_PAIR': '顶对',
  'HAND_SHAPE.OVERPAIR_TOP': '超对（高于牌面最大牌）',
  'HAND_SHAPE.MIDDLE_PAIR': '中对',
  'HAND_SHAPE.BOTTOM_PAIR': '底对',
  'HAND_SHAPE.UNDERPAIR': '小对子（低于牌面）',
  'HAND_SHAPE.POCKET_PAIR_OVER': '口袋对子（超对）',
  'HAND_SHAPE.TWO_PAIR': '两对',
  'HAND_SHAPE.TOP_TWO_PAIR': '顶两对',
  'HAND_SHAPE.SET': '三条（暗三条）',
  'HAND_SHAPE.TRIPS': '三条（明三条）',
  'HAND_SHAPE.STRAIGHT': '顺子',
  'HAND_SHAPE.FLUSH': '同花',
  'HAND_SHAPE.FULL_HOUSE': '葫芦',
  'HAND_SHAPE.QUADS': '四条',
  'HAND_SHAPE.STRAIGHT_FLUSH': '同花顺',
  'HAND_SHAPE.PLAY_THE_BOARD': '打公共牌',
  'HAND_RELATION.HOLE_CARDS_PLAY': '底牌参与成牌',
  'HAND_RELATION.BOARD_PLAYS': '公共牌参与成牌',
  'HAND_RELATION.BOARD_IS_BEST_FIVE': '公共牌就是最佳五张牌',
  'HAND_RELATION.KICKER_PLAYS': '踢脚起作用',
  'HAND_RELATION.SPLIT_POSSIBLE': '存在平分底池可能',

  /* ================= 玩家类型 ================= */
  'PLAYER_TYPE.UNKNOWN': '未知玩家',
  'PLAYER_TYPE.TIGHT_PASSIVE': '紧弱型',
  'PLAYER_TYPE.TIGHT_AGGRESSIVE': '紧凶型',
  'PLAYER_TYPE.LOOSE_PASSIVE': '松弱型',
  'PLAYER_TYPE.LOOSE_AGGRESSIVE': '松凶型',
  'PLAYER_TYPE.CALLING_STATION': '跟注站',
  'PLAYER_TYPE.BLUFF_HEAVY': '诈唬偏多',
  'PLAYER_TYPE.BLUFF_LIGHT': '诈唬偏少',
  'PLAYER_TYPE.ULTRA_TIGHT': '超级紧手',
  'PLAYER_TYPE.REG_AVERAGE': '普通常客',
  'PLAYER_TYPE.REG_STRONG': '强常客',

  /* ================= 起始手牌分类 ================= */
  'PREFLOP_CLASS.PREMIUM': '顶级强牌',
  'PREFLOP_CLASS.STRONG': '强牌',
  'PREFLOP_CLASS.PLAYABLE': '可玩牌',
  'PREFLOP_CLASS.MARGINAL': '边缘牌',
  'PREFLOP_CLASS.SPECULATIVE': '投机牌',
  'PREFLOP_CLASS.TRASH': '垃圾牌',

  /* ================= 牌面结构 ================= */
  'BOARD.DRY': '干燥牌面',
  'BOARD.SEMI_WET': '半湿牌面',
  'BOARD.WET': '湿润牌面',
  'BOARD.PAIRED': '对子牌面',
  'BOARD.TRIPS_BOARD': '三条牌面',
  'BOARD.TWO_PAIR_BOARD': '两对牌面',
  'BOARD.RAINBOW': '彩虹牌面',
  'BOARD.TWO_TONE': '两同花牌面',
  'BOARD.MONOTONE': '单花牌面',
  'BOARD.FLUSH_COMPLETE': '同花完成牌',
  'BOARD.FLUSH_POSSIBLE': '同花听牌可能',
  'BOARD.CONNECTED': '连接牌面',
  'BOARD.HIGHLY_CONNECTED': '高度连接牌面',
  'BOARD.STRAIGHT_COMPLETE': '顺子完成牌',
  'BOARD.STRAIGHT_POSSIBLE': '顺子听牌可能',
  'BOARD.HIGH_CARD_BOARD': '高张牌面',
  'BOARD.LOW_CARD_BOARD': '低张牌面',
  'BOARD.BLANK_TURN': '空白转牌',
  'BOARD.DANGER_CARD': '危险牌',
  'BOARD.HIGH_TURN': '高张转牌',

  /* ================= 数学量 ================= */
  'MATH.POT_ODDS': '底池赔率',
  'MATH.REQUIRED_EQUITY': '最低所需权益',
  'MATH.SPR': '底池筹码比',
  'MATH.EQUITY': '当前权益',
  'MATH.POT_ODDS_BOARD': '当前牌面权益',
  'MATH.EV': '期望收益',
  'MATH.EFFECTIVE_STACK': '有效筹码',
  'MATH.CALL_COST': '跟注需要',
  'MATH.RISK_REWARD': '风险收益比',
  'MATH.FINAL_POT': '跟注后底池',
  'MATH.BET_RATIO': '下注占底池比例',
  // 下注尺寸
  'MATH.SIZE_QUARTER': '下注 1/4底池',
  'MATH.SIZE_THIRD': '下注 1/3底池',
  'MATH.SIZE_HALF': '下注 1/2底池',
  'MATH.SIZE_TWO_THIRDS': '下注 2/3底池',
  'MATH.SIZE_THREE_QUARTERS': '下注 3/4底池',
  'MATH.SIZE_POT': '下注满池',
  'MATH.SIZE_OVERBET': '超池下注',
  'MATH.SIZE_ALLIN': '全下',

  /* ================= 数学结论 ================= */
  'MATH_VERDICT.CALL_ALLOWED': '数学判断：允许跟注',
  'MATH_VERDICT.CALL_NOT_ALLOWED': '数学判断：不允许跟注',
  'MATH_VERDICT.MARGINAL': '数学判断：接近临界',
  'MATH_VERDICT.NOT_COMPUTABLE': '数学判断：暂时无法准确计算权益',

  /* ================= 置信度 ================= */
  'CONFIDENCE.HIGH': '高',
  'CONFIDENCE.MEDIUM_HIGH': '中高',
  'CONFIDENCE.MEDIUM': '中',
  'CONFIDENCE.MEDIUM_LOW': '中低',
  'CONFIDENCE.LOW': '低',

  /* ================= 决策结论（Alpha 决策引擎） ================= */
  'ALPHA_CLASSIFICATION.CLEAR': '明确决策',
  'ALPHA_CLASSIFICATION.MARGINAL': '边缘决策',
  'ALPHA_CLASSIFICATION.INSUFFICIENT_INFORMATION': '信息不足',

  /* ================= 牌局环境 ================= */
  'ENVIRONMENT.LOW_STAKES_ONLINE': '低级别线上',
  'ENVIRONMENT.MID_LOW_STAKES': '中低级别',
  'ENVIRONMENT.THEORY_REFERENCE': '理论参考',
  'ENVIRONMENT.PROVENANCE.HEURISTIC': '启发式环境先验（无分级别统计数据支撑）',

  /* ================= 决策质量（禁止结果导向） ================= */
  'DECISION.CORRECT': '正确决策',
  'DECISION.MOSTLY_CORRECT': '基本正确',
  'DECISION.MARGINAL': '边缘决策',
  'DECISION.CLEAR_MISTAKE': '明显错误',
  'DECISION.SEVERE_MISTAKE': '严重错误',
  'DECISION.INSUFFICIENT_INFO': '信息不足',

  /* ================= 结果质量（与决策质量分离） ================= */
  'RESULT.GOOD': '结果良好',
  'RESULT.NEUTRAL': '结果中性',
  'RESULT.BAD': '结果不佳',
  'RESULT.BAD_BEAT': '坏运气',
  'RESULT.COOLER': '冤家牌',
  'RESULT.SPLIT': '平分底池',

  /* ================= 牌 / 解析错误 ================= */
  'CARD_PARSE.NOT_A_STRING': '牌必须是文本，例如 As、Td、7c。',
  'CARD_PARSE.EMPTY': '牌不能为空。',
  'CARD_PARSE.BAD_LENGTH': '「{input}」长度不正确。一张牌必须恰好由「点数 + 花色」两个字符组成，例如 As、Td、7c。',
  'CARD_PARSE.BAD_RANK': '「{input}」中的点数「{rank}」无法识别。点数只能是 2 3 4 5 6 7 8 9 T J Q K A。',
  'CARD_PARSE.BAD_SUIT': '「{input}」中的花色「{suit}」无法识别。花色只能是 s（黑桃）、h（红桃）、d（方块）、c（梅花）。',
  'CARD_PARSE.TEN_AS_10': '「{input}」使用了「10」，请改用字母 T，例如 Ts 表示黑桃10。',
  'CARD_PARSE.RANK_SUIT_ORDER': '「{input}」顺序不正确。请写成「点数在前、花色在后」，例如 A♦ 写作 Ad。',

  /* ================= 检查器问题 ================= */
  'ISSUE.DUPLICATE_CARD': '牌面冲突：{card}已经出现，请重新检查牌面或手牌。系统不会自动替换成其他花色。',
  'ISSUE.USER_CARD_ON_BOARD': '牌面冲突：你的手牌{card}与公共牌重复。',
  'ISSUE.OPPONENT_CARD_ON_BOARD': '牌面冲突：{player}的手牌{card}与公共牌重复。',
  'ISSUE.SAME_CARD_BOTH_PLAYERS': '牌面冲突：{card}同时出现在{playerA}与{playerB}手中。',
  'ISSUE.BOARD_FLOP_INCOMPLETE': '公共牌结构错误：翻牌必须恰好 3 张，当前 {count} 张{detail}。',
  'ISSUE.BOARD_TURN_WITHOUT_FLOP': '公共牌结构错误：还没有完整的翻牌，不能填写转牌。',
  'ISSUE.BOARD_RIVER_WITHOUT_TURN': '公共牌结构错误：还没有转牌，不能填写河牌。',
  'ISSUE.HOLE_CARD_COUNT_INVALID': '{player}的手牌必须是 2 张，当前 {count} 张。',
  'ISSUE.TABLE_SIZE_UNSUPPORTED': '不支持的桌型：{tableSize} 人桌。V1 只支持 6 人桌与 9 人桌。',
  'ISSUE.PLAYER_COUNT_MISMATCH': '本手人数与座位容量不匹配：{tableSize} 座桌的本手人数必须在 {expected} 之间，当前 {actual} 位。',
  'ISSUE.POSITION_MISMATCH': '位置与桌型不匹配：{tableSize} 人桌不允许出现「{position}」。',
  'ISSUE.POSITION_DUPLICATED': '位置重复：同一桌中出现两个「{position}」，请检查座位设置。',
  'ISSUE.BLIND_INVALID': '盲注设置不合法：小盲 {smallBlind}、大盲 {bigBlind}。大盲必须大于小盲，且两者都必须是正整数。',
  'ISSUE.ANTE_NEGATIVE': '前注不能为负数，当前 {ante}。',
  'ISSUE.NO_USER_PLAYER': '未指定「我的位置」，无法进行针对性分析。',
  'ISSUE.USER_NOT_IN_HAND': '你（{position}）已经弃牌，本次行动没有可分析的决策点。',
  'ISSUE.STACK_NEGATIVE': '{player}的筹码为负数（{stack}），筹码不能为负。',
  'ISSUE.STACK_MISSING': '{player}的筹码信息缺失，无法计算有效筹码与底池筹码比，因此当前无法给出可靠打法。',
  'ISSUE.STACK_ZERO': '{player}的筹码为 0，无法参与本手牌。',
  'ISSUE.CHIPS_CONSERVATION_BROKEN': '筹码守恒校验失败：起始筹码合计 {startingTotal}，当前剩余加已投入合计 {currentTotal}，差额 {delta}。请检查行动记录。',
  'ISSUE.POT_NEGATIVE': '底池不能为负数，当前 {pot}。',
  'ISSUE.POT_MISMATCH': '底池计算不一致：你填写的是 {claimed}，系统按行动记录重新计算得到 {computed}，差额 {delta}。请检查行动记录，系统不会静默忽略。',
  'ISSUE.OPPONENT_STACK_MISSING': '主要对手「{player}」的筹码信息缺失，无法计算有效筹码。',
  'ISSUE.BET_EXCEEDS_STACK': '{player}下注 {amount}，但只剩 {stack}，下注不能超过持有筹码。',
  'ISSUE.ACTION_NOT_LEGAL_NOW': '行动不合法：当前是{street}的{action}阶段，{player}不能执行「{action}」。',
  'ISSUE.NOT_PLAYERS_TURN': '行动顺序错误：当前应该由{expected}行动，而不是{actual}。',
  'ISSUE.FOLDED_PLAYER_ACTED': '{player}已经弃牌，不能重新行动。',
  'ISSUE.ALLIN_PLAYER_ACTED': '{player}已经全下，不能再次普通下注或加注。',
  'ISSUE.CHECK_NOT_ALLOWED': '当前不能过牌：已经有人下注 {amount}，你只能跟注、加注或弃牌。',
  'ISSUE.CHECK_FACING_BET': '当前不能过牌：需要先跟注 {amount}。',
  'ISSUE.CALL_AMOUNT_ILLEGAL': '跟注金额不合法：需要跟注 {required}，实际提交 {provided}。',
  'ISSUE.RAISE_AMOUNT_ILLEGAL': '加注金额不合法：必须大于当前注额 {currentBet}，实际提交 {provided}。',
  'ISSUE.RAISE_BELOW_MIN': '加注金额过小：最小加注到 {minTo}，实际提交 {provided}。',
  'ISSUE.RAISE_NOT_REOPENED_FOR_PLAYER':
    '{player}的加注权未重开：前面的全下加注不足最小加注（{minTo}），此时只能跟注或弃牌。',
  'ISSUE.ALLIN_AMOUNT_MISMATCH': '全下金额不一致：全下必须投入全部剩余筹码 {expected}，实际提交 {provided}。',
  'ISSUE.BET_BELOW_MIN': '下注金额过小：最小下注 {minBet}，实际提交 {provided}。',
  'ISSUE.BET_NOT_ALLOWED':
    '{player}不能下注：其余玩家都已全下或弃牌，没有人能跟注 —— 多出的筹码会原样退回，' +
    '因此这个下注在现实中不存在（此时直接跑牌到摊牌）。',
  'ISSUE.ACTION_ZERO_AMOUNT': '金额不能为 0：{action}必须指定大于 0 的金额。',
  'ISSUE.ACTION_NEGATIVE_AMOUNT': '金额不能为负数：{action}收到 {amount}。',
  'ISSUE.STREET_NOT_COMPLETE': '还不能进入下一街：{player}尚未行动完（还需跟注 {amount}）。',
  'ISSUE.STREET_ALREADY_RIVER': '已经是河牌，没有下一街。',
  'ISSUE.BOARD_FULL': '公共牌已满 5 张，不能再发牌。',
  'ISSUE.UNKNOWN_PLAYER': '找不到玩家「{playerId}」，请检查牌局设置。',
  'ISSUE.ACTION_AFTER_HAND_OVER': '本手牌已经结束，不能再执行动作。',
  'ISSUE.MATH_DIVIDE_BY_ZERO': '数学计算出现除以零（{expr}），已停止分析以避免输出错误结论。',
  'ISSUE.MATH_INVALID_INPUT': '数学计算输入不合法：{detail}。',
  'ISSUE.EQUITY_NOT_COMPUTABLE': '暂时无法准确计算权益：{reason}。系统不会猜测数字。',
  'ISSUE.SIMULATION_TOO_FEW': '模拟次数过少（{iterations} 次），结果波动较大，仅供参考。建议至少 {recommended} 次。',
  'ISSUE.ANALYSIS_BLOCKED': '当前无法继续分析，原因见下方问题列表。',
  'ISSUE.SAMPLE_INSUFFICIENT': '样本不足：当前只有 {sample} 次样本（建议至少 {threshold} 次），暂不形成稳定结论。',

  /* ================= 范围引擎 ================= */
  'RANGE.STATE.NORMALIZED': '已归一化',
  'RANGE.STATE.UNNORMALIZED': '未归一化',
  'RANGE.STATE.COLLAPSED': '范围坍塌',
  'RANGE.SOURCE.THEORY_SOURCE': '理论来源',
  'RANGE.SOURCE.VERIFIED_DATA': '已验证数据',
  'RANGE.SOURCE.USER_DEFINED': '用户自定义',
  'RANGE.SOURCE.EMPIRICAL': '经验数据',
  'RANGE.SOURCE.HEURISTIC': '启发式基础范围',
  'RANGE.SOURCE.FALLBACK': '兜底范围（不可信）',
  'RANGE.SOURCE.TEST_ONLY': '仅测试数据（禁止用于生产建议）',
  'RANGE.ACTION.CHECK': '过牌',
  'RANGE.ACTION.BET': '下注',
  'RANGE.ACTION.CALL': '跟注',
  'RANGE.ACTION.RAISE': '加注',
  'RANGE.ACTION.FOLD': '弃牌',
  'RANGE.ACTION.ALL_IN': '全下',
  'RANGE.ERROR.RANGE_COLLAPSE':
    '范围无法可靠建立：{action} 动作更新后所有组合权重归零（{note}）。系统不会自动填充默认范围，也不会偷偷恢复翻牌前范围。',
  'RANGE.ERROR.RANGE_DEADLINE_EXCEEDED':
    '范围计算超出时间预算：已处理 {processedCombos}/{totalCombos} 个组合，剩余 {remainingMs} 毫秒。已中止且不返回部分结果。',
  'RANGE.ERROR.RANGE_NORMALIZE_FAILED': '范围归一化失败：{reason}',
  'RANGE.ERROR.RANGE_VALIDATION_FAILED': '范围数据不合法：组合 {comboId} 的 {problem}（共 {issueCount} 处问题）。',
  'RANGE.ERROR.RANGE_PARTIAL_ACTION_MODEL': '动作模型不完整：{note}',
  'RANGE.ERROR.RANGE_UNKNOWN_COMBO': '存在未知组合：{comboIds}（共 {unknownCount} 个）。',
  'RANGE.ERROR.RANGE_INVALID_LIKELIHOOD': '动作似然不合法：{problem}',
  'RANGE.LABEL.EFFECTIVE_COMBOS': '有效组合',
  'RANGE.LABEL.EFFECTIVE_COMBO_COUNT': '有效组合数',
  'RANGE.LABEL.ENTROPY': '熵',
  'RANGE.LABEL.TOP_PROBABILITY': '主导概率',
  'RANGE.LABEL.WEIGHTED_CONFIDENCE': '加权可信度',
  'RANGE.CONFIDENCE.NOTE':
    '范围可信度 {rangeConfidence}：{sourceName}。此可信度必须传入最终决策置信度，不得与数学可靠性简单平均。',
  'RANGE.WARNING.TEST_ONLY': '当前范围来自测试数据，禁止用于生产建议。',
  'RANGE.WARNING.FALLBACK': '当前范围是兜底值，不代表任何真实策略，最终决策置信度必须相应下调。',
  'RANGE.WARNING.FALLBACK_OR_TEST': '当前范围不是可信数据来源，结论仅供参考。',

  /* ================= 数值稳定性（Step 5A.1） ================= */
  // 归一化采用 max-shift / Log-Sum-Exp，因此**不存在绝对阈值**导致的假坍塌。
  'NUMSTAB.LABEL.SHIFT': '归一化平移量',
  'NUMSTAB.LABEL.LOG_TOTAL': '对数域总和',
  'NUMSTAB.LABEL.SUPPORT': '支持集大小',
  'NUMSTAB.NOTE.MAX_SHIFT':
    '本次归一化先把所有权重除以最大值再做判定，因此整体缩放（例如所有权重同时乘 1e-6）不会改变任何概率。',
  'NUMSTAB.NOTE.LOG_SPACE':
    '本次贝叶斯更新全程在对数域完成（连乘变相加），因此极小的似然不会因为浮点下溢而被静默丢弃。',
  'NUMSTAB.WARNING.TINY_LIKELIHOOD':
    '本次输入包含极小的动作似然（最小 {minLikelihood}）。引擎仍给出完整结果，但请确认这是真实数据而不是录入错误。',
  'NUMSTAB.WARNING.SUPPORT_SHRANK':
    '本次更新后有效组合数由 {before} 降到 {after}。这可能是正常的贝叶斯收窄，也可能是输入数据的似然过小 —— 请结合动作是否合理判断。',
  'NUMSTAB.WARNING.RAW_WEIGHT_UNDERFLOW':
    '部分组合的线性权重已小到无法用双精度表示（低于 {denormalMin}），其概率按 0 处理。这是浮点固有边界，不是数据错误。',
  'NUMSTAB.WARNING.MULTIPLY_UNDERFLOW':
    '似然在**进入引擎之前**的乘法阶段就已下溢为 0（例如 0.25 × {scale}），信息在那一步丢失，引擎无法挽回。请避免使用如此极端尺度的似然。',
  'NUMSTAB.WARNING.INFINITE_RAW_SUM': '组合权重之和溢出为无穷大，概率本身仍然正确。',
  'NUMSTAB.TRUE_ZERO_NOTE':
    '权重为 0 表示该组合确实不可能（似然为 0），而不是数值下溢 —— 两者在报告中分开计数。',

  /* ================= 权益计算方式与提前停止 ================= */
  'EQUITY_METHOD.EXACT': '精确枚举',
  'EQUITY_METHOD.MONTE_CARLO': '蒙特卡洛',
  'EQUITY_POLICY.EXACT_WITHIN_BUDGET': '组合规模在预算内，使用精确枚举（无统计误差）',
  'EQUITY_POLICY.TOO_MANY_MATCHUPS': '组合规模超出预算，改用蒙特卡洛模拟',
  'EQUITY_POLICY.FORCED_BY_CALLER': '按调用方指定的方式计算',
  'EQUITY_POLICY.VERIFY_MODE': '验证模式：强制精确枚举',
  'EQUITY_STOP.CI_CLEARS_THRESHOLD':
    '已可定论：95% 置信区间为 {lower}～{upper}，整体位于决策门槛 {threshold} 的{side}侧，继续模拟不会改变结论。',
  'EQUITY_STOP.CI_CLEARS_THRESHOLD.ABOVE': '上',
  'EQUITY_STOP.CI_CLEARS_THRESHOLD.BELOW': '下',
  'EQUITY_STOP.DEADLINE_REACHED':
    '已达时间预算：已用 {elapsedMs} 毫秒、剩余 {remainingMs} 毫秒，停止继续模拟，返回当前最可靠结论。',
  'EQUITY_STOP.DIMINISHING_RETURNS':
    '收益递减：即使把样本量翻倍，权益估计最多再变动 {maxMovementPct} 个百分点（阈值 {thresholdPct} 个百分点），没有必要继续计算。',
  'EQUITY_STOP.MAX_ITERATIONS': '已达到样本量上限 {maxIterations} 次。',
  'EQUITY.STOPPED_EARLY_NOTE': '本次为提前停止的结果，已附带停止原因。',
  'EQUITY.ABORTED_RUNS_NOTE': '另有 {abortedRuns} 次抽样因对手组合互相冲突而作废（未计入统计分母）。',

  /* ================= 决策管线阶段 ================= */
  'STAGE.VALIDATOR': '牌局检查',
  'STAGE.MATH': '数学计算',
  'STAGE.RANGE': '范围分析',
  'STAGE.PLAYER_MODEL': '玩家画像',
  'STAGE.EQUITY': '权益计算',
  'STAGE.AGENTS': '多智能体审查',

  /* ================= 决策管线中止原因 ================= */
  'ABORT.DEADLINE': '时间预算耗尽：已用 {elapsedMs} 毫秒，剩余 {remainingMs} 毫秒，停止启动新的计算阶段。',
  'ABORT.STAGE_BLOCKED': '该阶段判定无法继续：{note}',
  'ABORT.STAGE_ERROR': '该阶段执行异常：{message}',
  'ABORT.UPSTREAM_ABORTED': '上游阶段「{upstream}」已中止（{upstreamReason}），本阶段不再执行。',
  'ABORT.PREREQUISITE_MISSING': '缺少必需的前置阶段：{stage}。',
  'PIPELINE.DEGRADED': '本次结果不完整：有阶段被跳过，已如实标注，未伪造完整结论。',
  'PIPELINE.TIMED_OUT': '已达时间预算：返回当前最可靠结论，并标注哪些阶段未执行。',
  'PIPELINE.COMPLETE': '全部阶段正常完成。',

  /* ================= 时间预算 ================= */
  'DEADLINE.MODE.INTERACTIVE': '交互式决策',
  'DEADLINE.MODE.PRECISION': '高精度离线复盘',
  'DEADLINE.MODE.VERIFY': '验证模式',
  'DEADLINE.MODE.TEST': '测试模式',
  'DEADLINE.LABEL_SOFT': '软时间上限',
  'DEADLINE.LABEL_HARD': '硬时间上限',
  'DEADLINE.EXCEEDED': '已超过时间预算，返回当前最可靠建议。',
  'DEADLINE.MARGINAL_FALLBACK': '时间预算内无法稳定区分两个动作，这属于边缘决策。',

  /* ================= 界面骨架文案 ================= */
  'ui.title': '德州扑克决策与复盘训练系统',
  'ui.left.table': '牌桌',
  'ui.left.positions': '玩家位置',
  'ui.left.playersRemaining': '剩余玩家',
  'ui.left.playerType': '玩家类型',
  'ui.center.myHand': '我的手牌',
  'ui.center.board': '公共牌',
  'ui.center.currentPot': '当前底池',
  'ui.center.effectiveStack': '有效筹码',
  'ui.center.multiwayBanner': '当前：{count}人底池',
  'ui.right.actionLog': '行动记录',
  'ui.bottom.advice': '打法建议',
  'ui.bottom.suggestion': '建议',
  'ui.bottom.confidence': '置信度',
  'ui.bottom.type': '类型',
  'ui.bottom.detailButton': '查看详细分析',
  'ui.button.fold': '弃牌',
  'ui.button.check': '过牌',
  'ui.button.call': '跟注',
  'ui.button.bet': '下注',
  'ui.button.raise': '加注',
  'ui.button.allIn': '全下',
  'ui.button.prevStreet': '上一街',
  'ui.button.nextStreet': '下一街',
  'ui.button.reinput': '重新输入',
  'ui.button.save': '保存牌局',
  'ui.button.review': '开始复盘',
  'ui.button.playerTags': '玩家标签',
  'ui.button.editBoard': '修改牌面',
  'ui.button.undo': '撤销上一步',

  /* ================= 玩家画像（Step 6） ================= */
  // 标签只是「摘要」，底层永远是连续维度。UI 必须把这句话告诉用户。
  'profile.label.UNKNOWN': '未知玩家',
  'profile.label.ULTRA_TIGHT': '超紧型',
  'profile.label.TIGHT_PASSIVE': '紧弱型',
  'profile.label.TIGHT_AGGRESSIVE': '紧凶型',
  'profile.label.LOOSE_PASSIVE': '松弱型',
  'profile.label.LOOSE_AGGRESSIVE': '松凶型',
  'profile.label.CALLING_STATION': '跟注站',
  'profile.label.BLUFF_HEAVY': '爱诈唬',
  'profile.label.BLUFF_LIGHT': '很少诈唬',
  'profile.label.REG_AVERAGE': '普通常客',
  'profile.label.REG_STRONG': '强常客',
  'profile.label.note': '标签只是便于阅读的概括，实际计算使用连续的倾向数值，不会因为恰好跨过某个分界而突变。',

  // 连续维度
  'profile.dimension.tightness': '紧度',
  'profile.dimension.aggression': '凶度',
  'profile.dimension.bluffTendency': '诈唬倾向',
  'profile.dimension.passivity': '被动程度',
  'profile.dimension.confidence': '可信度',

  // 样本分层（规范第二十五节的三层置信度）
  'profile.tier.PRELIMINARY': '初步倾向',
  'profile.tier.STANDARD': '中等可信',
  'profile.tier.CONFIRMED': '高可信',
  'profile.tier.PRELIMINARY.note': '样本量不足 30 手（按有效样本量计算），只能视为初步倾向，不得当作稳定画像。',
  'profile.tier.STANDARD.note': '样本量在 30~200 手之间，可作为中等可信的参考。',
  'profile.tier.CONFIRMED.note': '有效样本量超过 200 手，可作为高可信画像使用。',
  'profile.sample.hands': '已统计 {hands} 手',
  'profile.sample.effective': '有效样本量 {effective}',
  'profile.sample.insufficient': '样本不足：{metric} 只有 {opportunities} 次机会，不足以判断。',

  // 调整说明（UI 必须能说清「为什么范围被调宽了」）
  'profile.adjust.widened': '依据玩家画像整体调宽范围（平均因子 {meanFactor}）',
  'profile.adjust.narrowed': '依据玩家画像整体调窄范围（平均因子 {meanFactor}）',
  'profile.adjust.unchanged': '玩家画像未改变范围的整体宽窄',
  'profile.adjust.neutral': '玩家样本不足，未对范围做任何调整',
  'profile.adjust.note': '画像只调整范围权重与动作概率，不直接给出打法。',

  // 先验来源透明化（规范第十四节：绝不允许冒充理论）
  'profile.prior.HEURISTIC_PRIOR': '启发式先验',
  'profile.prior.TEST_PRIOR': '测试先验',
  'profile.prior.UNKNOWN_PRIOR': '无先验',
  'profile.prior.EMPIRICAL_PRIOR': '实测先验',
  'profile.prior.disclaimer': '当前没有可靠的人口统计数据库，所有先验都是启发式估计，不得当作理论最优。',

  // 指标中文名（25 项；与 METRIC_DEFINITIONS 的 label 一一对应）
  'profile.metric.VPIP': '翻牌前入池率',
  'profile.metric.PFR': '翻牌前主动加注率',
  'profile.metric.LIMP': '翻牌前溜入率',
  'profile.metric.OPEN': '翻牌前开池率',
  'profile.metric.CALL_OPEN': '面对开池跟注率',
  'profile.metric.THREE_BET': '翻牌前 3Bet 率',
  'profile.metric.FOUR_BET': '翻牌前 4Bet 率',
  'profile.metric.FOLD_TO_THREE_BET': '面对 3Bet 弃牌率',
  'profile.metric.CALL_THREE_BET': '面对 3Bet 跟注率',
  'profile.metric.CBET': '翻牌持续下注率',
  'profile.metric.FOLD_TO_CBET': '面对持续下注弃牌率',
  'profile.metric.CALL_CBET': '面对持续下注跟注率',
  'profile.metric.RAISE_CBET': '面对持续下注加注率',
  'profile.metric.CHECK_RAISE_FLOP': '翻牌过牌加注率',
  'profile.metric.TURN_BARREL': '转牌连续开火率',
  'profile.metric.TURN_FOLD': '转牌弃牌率',
  'profile.metric.TURN_RAISE': '转牌加注率',
  'profile.metric.TURN_CHECK_RAISE': '转牌过牌加注率',
  'profile.metric.RIVER_BET': '河牌下注率',
  'profile.metric.RIVER_BARREL': '河牌连续开火率',
  'profile.metric.RIVER_OVERBET': '河牌超池下注率',
  'profile.metric.RIVER_CALL': '河牌跟注率',
  'profile.metric.RIVER_RAISE': '河牌加注率',
  'profile.metric.RIVER_FOLD': '河牌弃牌率',
  'profile.metric.RIVER_SHOWDOWN': '摊牌率',

  // 统计字段
  'profile.stat.successes': '成功次数',
  'profile.stat.opportunities': '机会次数',
  'profile.stat.rawRate': '原始比率',
  'profile.stat.adjustedRate': '收缩后比率',
  'profile.stat.adjustedRate.note': '向先验收缩后的比率：3 手 100% 入池不会得到 100% 的估计。',
  'profile.stat.confidence': '可信度',
  'profile.stat.effectiveSampleSize': '有效样本量',
  'profile.stat.noOpportunity': '没有机会',

  // 画像修正（规范第十八节）
  'profile.amend.duplicateHand': '这手牌已经在画像里了（handId {handId}），重复录入会被拒绝。',
  'profile.amend.unknownHand': '这手牌不在画像中（handId {handId}），无法修正。',
  'profile.amend.invalidTimestamp': '时间戳不合法（{timestamp}），必须是 2000 年至 2100 年之间的有效时间。',
  'profile.amend.playerMismatch': '手牌属于玩家 {actual}，不能记到玩家 {expected} 的画像上。',
  'profile.amend.unknownMetric': '未知的指标（{metric}），已忽略。',
  'profile.amend.negativeCount': '序号必须是非负整数（收到 {seq}）。',
  'profile.amend.seqOutOfRange':
    '序号 {seq} 超出允许范围（当前最大序号 {maxSeq}，单次最多前进 {tolerance}）。序号决定时间衰减，跳跃过大会把已有历史全部推到「很久以前」而等效作废，因此被拒绝。',
  'profile.amend.seqOutOfRange.note': '若确实中间很久没打牌，请分多次录入，或调整容差参数。',
} as const;

export type MessageKey = keyof typeof zhCN;

/**
 * 语言包结构。
 *
 * 值类型是 `string` 而不是字面量类型 —— 否则未来新增 en-US 时，
 * 任何一条翻译都会因为「与中文原文不相等」而被类型系统拒绝。
 */
export type Dictionary = Record<MessageKey, string>;

/** 简体中文语言包（V1 默认且唯一） */
export const zhCNLocale: Dictionary = zhCN;
