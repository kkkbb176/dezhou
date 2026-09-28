/**
 * 全部「可翻译码值」的唯一定义处。
 *
 * 设计原则（规范第 40 / 47 条）：
 * - 领域层只允许返回码值 + 参数，禁止返回中文字符串。
 * - 中文文案一律集中在 src/i18n/zh-CN.ts。
 * - 这样未来加 en-US.json 时无需改动领域层任何一行代码。
 */

/* ============================================================
 * 牌 / 解析
 * ============================================================ */

export const CardParseCode = {
  NOT_A_STRING: 'CARD_PARSE.NOT_A_STRING',
  EMPTY: 'CARD_PARSE.EMPTY',
  BAD_LENGTH: 'CARD_PARSE.BAD_LENGTH',
  BAD_RANK: 'CARD_PARSE.BAD_RANK',
  BAD_SUIT: 'CARD_PARSE.BAD_SUIT',
  TEN_AS_10: 'CARD_PARSE.TEN_AS_10',
  RANK_SUIT_ORDER: 'CARD_PARSE.RANK_SUIT_ORDER',
} as const;
export type CardParseCode = (typeof CardParseCode)[keyof typeof CardParseCode];

export const HandCategoryLabelCode = {
  HIGH_CARD: 'HAND_CATEGORY.HIGH_CARD',
  ONE_PAIR: 'HAND_CATEGORY.ONE_PAIR',
  TWO_PAIR: 'HAND_CATEGORY.TWO_PAIR',
  THREE_OF_A_KIND: 'HAND_CATEGORY.THREE_OF_A_KIND',
  STRAIGHT: 'HAND_CATEGORY.STRAIGHT',
  FLUSH: 'HAND_CATEGORY.FLUSH',
  FULL_HOUSE: 'HAND_CATEGORY.FULL_HOUSE',
  FOUR_OF_A_KIND: 'HAND_CATEGORY.FOUR_OF_A_KIND',
  STRAIGHT_FLUSH: 'HAND_CATEGORY.STRAIGHT_FLUSH',
} as const;
export type HandCategoryLabelCode =
  (typeof HandCategoryLabelCode)[keyof typeof HandCategoryLabelCode];

/* ============================================================
 * 牌局检查器（规范第 13 / 14 / 41 / 42 条）
 * ============================================================ */

export const IssueCode = {
  /* —— 牌面与重复 —— */
  DUPLICATE_CARD: 'ISSUE.DUPLICATE_CARD',
  USER_CARD_ON_BOARD: 'ISSUE.USER_CARD_ON_BOARD',
  OPPONENT_CARD_ON_BOARD: 'ISSUE.OPPONENT_CARD_ON_BOARD',
  SAME_CARD_BOTH_PLAYERS: 'ISSUE.SAME_CARD_BOTH_PLAYERS',

  /* —— 结构 —— */
  BOARD_FLOP_INCOMPLETE: 'ISSUE.BOARD_FLOP_INCOMPLETE',
  BOARD_TURN_WITHOUT_FLOP: 'ISSUE.BOARD_TURN_WITHOUT_FLOP',
  BOARD_RIVER_WITHOUT_TURN: 'ISSUE.BOARD_RIVER_WITHOUT_TURN',
  HOLE_CARD_COUNT_INVALID: 'ISSUE.HOLE_CARD_COUNT_INVALID',

  /* —— 配置 —— */
  TABLE_SIZE_UNSUPPORTED: 'ISSUE.TABLE_SIZE_UNSUPPORTED',
  PLAYER_COUNT_MISMATCH: 'ISSUE.PLAYER_COUNT_MISMATCH',
  POSITION_MISMATCH: 'ISSUE.POSITION_MISMATCH',
  POSITION_DUPLICATED: 'ISSUE.POSITION_DUPLICATED',
  BLIND_INVALID: 'ISSUE.BLIND_INVALID',
  ANTE_NEGATIVE: 'ISSUE.ANTE_NEGATIVE',
  NO_USER_PLAYER: 'ISSUE.NO_USER_PLAYER',
  USER_NOT_IN_HAND: 'ISSUE.USER_NOT_IN_HAND',

  /* —— 筹码与底池 —— */
  STACK_NEGATIVE: 'ISSUE.STACK_NEGATIVE',
  STACK_MISSING: 'ISSUE.STACK_MISSING',
  STACK_ZERO: 'ISSUE.STACK_ZERO',
  CHIPS_CONSERVATION_BROKEN: 'ISSUE.CHIPS_CONSERVATION_BROKEN',
  POT_NEGATIVE: 'ISSUE.POT_NEGATIVE',
  POT_MISMATCH: 'ISSUE.POT_MISMATCH',
  OPPONENT_STACK_MISSING: 'ISSUE.OPPONENT_STACK_MISSING',

  /* —— 行动顺序与合法性 —— */
  BET_EXCEEDS_STACK: 'ISSUE.BET_EXCEEDS_STACK',
  ACTION_NOT_LEGAL_NOW: 'ISSUE.ACTION_NOT_LEGAL_NOW',
  NOT_PLAYERS_TURN: 'ISSUE.NOT_PLAYERS_TURN',
  FOLDED_PLAYER_ACTED: 'ISSUE.FOLDED_PLAYER_ACTED',
  ALLIN_PLAYER_ACTED: 'ISSUE.ALLIN_PLAYER_ACTED',
  CHECK_NOT_ALLOWED: 'ISSUE.CHECK_NOT_ALLOWED',
  CHECK_FACING_BET: 'ISSUE.CHECK_FACING_BET',
  CALL_AMOUNT_ILLEGAL: 'ISSUE.CALL_AMOUNT_ILLEGAL',
  RAISE_AMOUNT_ILLEGAL: 'ISSUE.RAISE_AMOUNT_ILLEGAL',
  RAISE_BELOW_MIN: 'ISSUE.RAISE_BELOW_MIN',
  RAISE_NOT_REOPENED_FOR_PLAYER: 'ISSUE.RAISE_NOT_REOPENED_FOR_PLAYER',
  ALLIN_AMOUNT_MISMATCH: 'ISSUE.ALLIN_AMOUNT_MISMATCH',
  BET_BELOW_MIN: 'ISSUE.BET_BELOW_MIN',
  /**
   * 下注/加注被拒：**没有任何其他玩家能跟注**（其余人都已全下或弃牌）。
   *
   * 规则依据：无人能跟的筹码会原样退回，因此那种下注在现实中不会发生；
   * 此时下注轮直接关闭、跑牌到摊牌。
   */
  BET_NOT_ALLOWED: 'ISSUE.BET_NOT_ALLOWED',
  ACTION_ZERO_AMOUNT: 'ISSUE.ACTION_ZERO_AMOUNT',
  ACTION_NEGATIVE_AMOUNT: 'ISSUE.ACTION_NEGATIVE_AMOUNT',
  STREET_NOT_COMPLETE: 'ISSUE.STREET_NOT_COMPLETE',
  STREET_ALREADY_RIVER: 'ISSUE.STREET_ALREADY_RIVER',
  BOARD_FULL: 'ISSUE.BOARD_FULL',
  UNKNOWN_PLAYER: 'ISSUE.UNKNOWN_PLAYER',
  ACTION_AFTER_HAND_OVER: 'ISSUE.ACTION_AFTER_HAND_OVER',

  /* —— 数学与计算 —— */
  MATH_DIVIDE_BY_ZERO: 'ISSUE.MATH_DIVIDE_BY_ZERO',
  MATH_INVALID_INPUT: 'ISSUE.MATH_INVALID_INPUT',
  EQUITY_NOT_COMPUTABLE: 'ISSUE.EQUITY_NOT_COMPUTABLE',
  SIMULATION_TOO_FEW: 'ISSUE.SIMULATION_TOO_FEW',

  /* —— 系统性 —— */
  ANALYSIS_BLOCKED: 'ISSUE.ANALYSIS_BLOCKED',
  SAMPLE_INSUFFICIENT: 'ISSUE.SAMPLE_INSUFFICIENT',
} as const;
export type IssueCode = (typeof IssueCode)[keyof typeof IssueCode];

/** 严重程度：BLOCKER 会阻止策略分析（规范第 42 条） */
export const IssueSeverity = {
  BLOCKER: 'BLOCKER',
  WARNING: 'WARNING',
  INFO: 'INFO',
} as const;
export type IssueSeverity = (typeof IssueSeverity)[keyof typeof IssueSeverity];

/* ============================================================
 * 牌面结构（规范第 29 条）
 * ============================================================ */

export const BoardTextureCode = {
  /* 湿润度 */
  DRY: 'BOARD.DRY',
  SEMI_WET: 'BOARD.SEMI_WET',
  WET: 'BOARD.WET',
  /* 对子 */
  PAIRED: 'BOARD.PAIRED',
  TRIPS_BOARD: 'BOARD.TRIPS_BOARD',
  TWO_PAIR_BOARD: 'BOARD.TWO_PAIR_BOARD',
  /* 花色 */
  RAINBOW: 'BOARD.RAINBOW',
  TWO_TONE: 'BOARD.TWO_TONE',
  MONOTONE: 'BOARD.MONOTONE',
  FLUSH_COMPLETE: 'BOARD.FLUSH_COMPLETE',
  FLUSH_POSSIBLE: 'BOARD.FLUSH_POSSIBLE',
  /* 顺子 */
  CONNECTED: 'BOARD.CONNECTED',
  HIGHLY_CONNECTED: 'BOARD.HIGHLY_CONNECTED',
  STRAIGHT_COMPLETE: 'BOARD.STRAIGHT_COMPLETE',
  STRAIGHT_POSSIBLE: 'BOARD.STRAIGHT_POSSIBLE',
  /* 高低张 */
  HIGH_CARD_BOARD: 'BOARD.HIGH_CARD_BOARD',
  LOW_CARD_BOARD: 'BOARD.LOW_CARD_BOARD',
  /* 转牌性质 */
  BLANK_TURN: 'BOARD.BLANK_TURN',
  DANGER_CARD: 'BOARD.DANGER_CARD',
  HIGH_TURN: 'BOARD.HIGH_TURN',
} as const;
export type BoardTextureCode = (typeof BoardTextureCode)[keyof typeof BoardTextureCode];

/* ============================================================
 * 牌力描述（规范第 19 / 20 条）
 * ============================================================ */

export const HandShapeCode = {
  HIGH_CARD: 'HAND_SHAPE.HIGH_CARD',
  OVERPAIR: 'HAND_SHAPE.OVERPAIR',
  TOP_PAIR: 'HAND_SHAPE.TOP_PAIR',
  OVERPAIR_TOP: 'HAND_SHAPE.OVERPAIR_TOP',
  MIDDLE_PAIR: 'HAND_SHAPE.MIDDLE_PAIR',
  BOTTOM_PAIR: 'HAND_SHAPE.BOTTOM_PAIR',
  UNDERPAIR: 'HAND_SHAPE.UNDERPAIR',
  POCKET_PAIR_OVER: 'HAND_SHAPE.POCKET_PAIR_OVER',
  TWO_PAIR: 'HAND_SHAPE.TWO_PAIR',
  TOP_TWO_PAIR: 'HAND_SHAPE.TOP_TWO_PAIR',
  SET: 'HAND_SHAPE.SET',
  TRIPS: 'HAND_SHAPE.TRIPS',
  STRAIGHT: 'HAND_SHAPE.STRAIGHT',
  FLUSH: 'HAND_SHAPE.FLUSH',
  FULL_HOUSE: 'HAND_SHAPE.FULL_HOUSE',
  QUADS: 'HAND_SHAPE.QUADS',
  STRAIGHT_FLUSH: 'HAND_SHAPE.STRAIGHT_FLUSH',
  PLAY_THE_BOARD: 'HAND_SHAPE.PLAY_THE_BOARD',
} as const;
export type HandShapeCode = (typeof HandShapeCode)[keyof typeof HandShapeCode];

/** 牌力描述中的「是否用到底牌 / 是否用尽公共牌」标记 */
export const HandRelationCode = {
  HOLE_CARDS_PLAY: 'HAND_RELATION.HOLE_CARDS_PLAY',
  BOARD_PLAYS: 'HAND_RELATION.BOARD_PLAYS',
  BOARD_IS_BEST_FIVE: 'HAND_RELATION.BOARD_IS_BEST_FIVE',
  KICKER_PLAYS: 'HAND_RELATION.KICKER_PLAYS',
  SPLIT_POSSIBLE: 'HAND_RELATION.SPLIT_POSSIBLE',
} as const;
export type HandRelationCode = (typeof HandRelationCode)[keyof typeof HandRelationCode];

/* ============================================================
 * 数学量名称（规范第 17 条）
 * ============================================================ */

export const MathLabelCode = {
  POT_ODDS: 'MATH.POT_ODDS',
  REQUIRED_EQUITY: 'MATH.REQUIRED_EQUITY',
  SPR: 'MATH.SPR',
  EQUITY: 'MATH.EQUITY',
  EV: 'MATH.EV',
  EFFECTIVE_STACK: 'MATH.EFFECTIVE_STACK',
  CALL_COST: 'MATH.CALL_COST',
  RISK_REWARD: 'MATH.RISK_REWARD',
  FINAL_POT: 'MATH.FINAL_POT',
  BET_RATIO: 'MATH.BET_RATIO',
} as const;
export type MathLabelCode = (typeof MathLabelCode)[keyof typeof MathLabelCode];

/** 数学结论（纯数学判断，不含对手倾向） */
export const MathVerdictCode = {
  CALL_ALLOWED: 'MATH_VERDICT.CALL_ALLOWED',
  CALL_NOT_ALLOWED: 'MATH_VERDICT.CALL_NOT_ALLOWED',
  MARGINAL: 'MATH_VERDICT.MARGINAL',
  NOT_COMPUTABLE: 'MATH_VERDICT.NOT_COMPUTABLE',
} as const;
export type MathVerdictCode = (typeof MathVerdictCode)[keyof typeof MathVerdictCode];

/* ============================================================
 * 置信度与复盘标签（规范第 26 / 31 条）
 * ============================================================ */

export const ConfidenceLevelCode = {
  HIGH: 'CONFIDENCE.HIGH',
  MEDIUM: 'CONFIDENCE.MEDIUM',
  LOW: 'CONFIDENCE.LOW',
} as const;
export type ConfidenceLevelCode = (typeof ConfidenceLevelCode)[keyof typeof ConfidenceLevelCode];

export const DecisionQualityCode = {
  CORRECT: 'DECISION.CORRECT',
  MOSTLY_CORRECT: 'DECISION.MOSTLY_CORRECT',
  MARGINAL: 'DECISION.MARGINAL',
  CLEAR_MISTAKE: 'DECISION.CLEAR_MISTAKE',
  SEVERE_MISTAKE: 'DECISION.SEVERE_MISTAKE',
  INSUFFICIENT_INFO: 'DECISION.INSUFFICIENT_INFO',
} as const;
export type DecisionQualityCode = (typeof DecisionQualityCode)[keyof typeof DecisionQualityCode];

export const ResultQualityCode = {
  GOOD_RESULT: 'RESULT.GOOD',
  NEUTRAL_RESULT: 'RESULT.NEUTRAL',
  BAD_RESULT: 'RESULT.BAD',
  BAD_BEAT: 'RESULT.BAD_BEAT',
  COOLER: 'RESULT.COOLER',
  SPLIT: 'RESULT.SPLIT',
} as const;
export type ResultQualityCode = (typeof ResultQualityCode)[keyof typeof ResultQualityCode];
