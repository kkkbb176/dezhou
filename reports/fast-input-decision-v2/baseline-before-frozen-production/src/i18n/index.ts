/**
 * 中文显示映射层（唯一文案出口）
 *
 * 规范第 2 / 3 / 7 / 40 / 41 / 47 条。
 *
 * 铁律：
 * - 任何界面代码不得自行拼接英文枚举，必须经过本模块。
 * - 领域层只输出码值，本模块负责把码值变成中文。
 * - 依赖方向：i18n → domain（单向）。领域层绝不反向依赖本模块。
 */

import { zhCN, type Dictionary, type MessageKey } from './zh-CN.ts';
import {
  CHAR_RANKS,
  RANK_CHARS,
  type Card,
  type Position,
  type Rank,
  type TableSize,
} from '../domain/types.ts';
import { positionAtSeatIndex, seatIndexOfPosition } from '../domain/poker/positions.ts';
import type { HandDescription } from '../domain/poker/handDescription.ts';

export { zhCN, type Dictionary, type MessageKey };
export * from '../domain/domainCodes.ts';
export type { HandDescription };

/** 当前语言（V1 固定简体中文，为未来 en-US 预留切换口） */
let activeDictionary: Dictionary = zhCN;

export function setDictionary(dict: Dictionary): void {
  activeDictionary = dict;
}

export function currentDictionary(): Dictionary {
  return activeDictionary;
}

/**
 * 渲染词条。
 * 占位符写法：{name}
 * 未找到词条时返回 key 本身（开发期便于发现遗漏，绝不返回 undefined）。
 */
export function t(key: MessageKey, params?: Readonly<Record<string, string | number>>): string {
  const template: string | undefined = activeDictionary[key];
  if (template === undefined) return key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}

/* ============================================================
 * 位置映射：必须结合桌型
 * ============================================================ */

/**
 * 位置顺序的唯一数据源是领域层，界面层不得自行维护第二份副本，
 * 否则修改桌型定义时必然出现「两边不一致」的静默 Bug。
 */
export function positionAtSeat(tableSize: TableSize, seat: number): Position {
  return positionAtSeatIndex(tableSize, seat - 1);
}

export function seatOfPosition(tableSize: TableSize, position: Position): number {
  return seatIndexOfPosition(tableSize, position) + 1;
}

/** 主显示：庄家位 */
export function positionMainLabel(tableSize: TableSize, position: Position): string {
  const seat = seatOfPosition(tableSize, position);
  return t(`position.${tableSize}.${seat}` as MessageKey);
}

/** 辅助小字：BTN */
export function positionAuxLabel(tableSize: TableSize, position: Position): string {
  const seat = seatOfPosition(tableSize, position);
  return t(`position.${tableSize}.${seat}.aux` as MessageKey);
}

/** 完整显示：庄家位（BTN） */
export function positionLabel(tableSize: TableSize, position: Position): string {
  return `${positionMainLabel(tableSize, position)}（${positionAuxLabel(tableSize, position)}）`;
}

/** 位置分组中文 */
export function positionGroupLabel(
  tableSize: TableSize,
  position: Position,
): string {
  if (position === 'SB' || position === 'BB') return t('position.role.blind');
  if (position === 'BTN' || position === 'CO') return t('position.role.late');
  if (position === 'HJ' || position === 'LJ') return t('position.role.middle');
  const seat = seatIndexOfPosition(tableSize, position);
  return seat <= 1 ? t('position.role.early') : t('position.role.middle');
}

/* ============================================================
 * 动作映射
 * ============================================================ */

export function actionMainLabel(action: string): string {
  return t(`action.${action}` as MessageKey);
}

export function actionAuxLabel(action: string): string {
  return t(`action.${action}.aux` as MessageKey);
}

export function actionLabel(action: string): string {
  return `${actionMainLabel(action)}（${actionAuxLabel(action)}）`;
}

/* ============================================================
 * 花色与牌
 * ============================================================ */

export function suitName(suit: string): string {
  return t(`suit.${suit}` as MessageKey);
}

export function suitSymbol(suit: string): string {
  return t(`suit.${suit}.symbol` as MessageKey);
}

export function rankChar(rank: Rank): string {
  return RANK_CHARS[rank];
}

/** 紧凑显示：Ad → A♦ */
export function cardShort(card: Card): string {
  return `${RANK_CHARS[card.rank]}${suitSymbol(card.suit)}`;
}

/** 完整显示：Ad → A♦ 方块A */
export function cardFull(card: Card): string {
  const rank = RANK_CHARS[card.rank];
  const suit = suitName(card.suit);
  return `${rank}${suitSymbol(card.suit)} ${suit}${rank}`;
}

export function cardsShort(cards: readonly Card[]): string {
  return cards.map(cardShort).join(' ');
}

export function cardsFull(cards: readonly Card[]): string {
  return cards.map(cardFull).join('　');
}

/** 严格解析点数显示字符（不做猜测式纠正） */
export function parseRankChar(input: string): Rank | null {
  const ch = input.trim().toUpperCase();
  return CHAR_RANKS[ch] ?? null;
}

/* ============================================================
 * 金额与百分比格式化
 * ============================================================ */

/** 金额千分位：60000 → 60,000 */
export function chips(amount: number): string {
  if (!Number.isFinite(amount)) return '—';
  return Math.round(amount).toLocaleString('en-US');
}

/** 百分比：0.42 → 42.0%（默认 1 位小数） */
export function percent(ratio: number, digits = 1): string {
  if (!Number.isFinite(ratio)) return '—';
  return `${(ratio * 100).toFixed(digits)}%`;
}

/** 整数百分比：0.42 → 42% */
export function percentInt(ratio: number): string {
  if (!Number.isFinite(ratio)) return '—';
  return `${Math.round(ratio * 100)}%`;
}

/** 以 BB 为单位显示：86000 筹码 / 1000 大盲 → 86BB */
export function bigBlinds(amount: number, bigBlind: number): string {
  if (!Number.isFinite(amount) || !Number.isFinite(bigBlind) || bigBlind <= 0) return '—';
  const value = amount / bigBlind;
  const text = Number.isInteger(value) ? String(value) : value.toFixed(1);
  return `${text}BB`;
}

/** 底池比例：0.3333 → 1/3底池；1.5 → 超池 1.50倍 */
export function potRatio(betAmount: number, pot: number): string {
  if (!Number.isFinite(betAmount) || !Number.isFinite(pot) || pot <= 0) return '—';
  const ratio = betAmount / pot;
  const known: ReadonlyArray<readonly [number, string]> = [
    [0.25, '1/4底池'],
    [1 / 3, '1/3底池'],
    [0.5, '1/2底池'],
    [2 / 3, '2/3底池'],
    [0.75, '3/4底池'],
    [1, '满池'],
  ];
  for (const [value, label] of known) {
    if (Math.abs(ratio - value) < 0.005) return label;
  }
  if (ratio > 1) return `超池 ${ratio.toFixed(2)}倍`;
  return `${(ratio * 100).toFixed(0)}%底池`;
}

/** 把「跟注 20000」这类动作渲染成完整中文句子 */
export function actionSentence(action: string, amount?: number, pot?: number): string {
  const main = actionMainLabel(action);
  if (action === 'FOLD' || action === 'CHECK') return main;
  if (amount === undefined) return main;
  if (
    (action === 'BET' || action === 'RAISE' || action === 'RERAISE' || action === 'ALL_IN') &&
    pot !== undefined &&
    pot > 0
  ) {
    return `${main} ${chips(amount)}（${potRatio(amount, pot)}）`;
  }
  return `${main} ${chips(amount)}`;
}

/* ============================================================
 * 牌力描述渲染
 * ============================================================ */

/**
 * 渲染牌力为中文。
 *
 * 规则（规范第 19 条）：
 * - 三条 / 明三条：显示为「J三条，Q踢脚」
 * - 两对：显示为「顶两对 KQ」
 * - 打公共牌：显示为「公共牌就是最佳五张牌」
 */
export function handDescriptionText(desc: HandDescription): string {
  const shape = t(desc.shapeCode as MessageKey);

  if (desc.shape === 'PLAY_THE_BOARD') {
    return t('HAND_RELATION.BOARD_IS_BEST_FIVE');
  }

  const ranks = desc.shapeRanks.map((r) => RANK_CHARS[r]).join('');

  switch (desc.shape) {
    case 'STRAIGHT':
    case 'FLUSH':
    case 'STRAIGHT_FLUSH':
    case 'FULL_HOUSE':
      return `${shape} ${rankTextOf(desc.keyRanks)}`;
    case 'QUADS':
      return `${rankTextOf([desc.keyRanks[0]!])}${shape}`;
    case 'SET':
      return `${rankTextOf(desc.shapeRanks)}${shape}`;
    case 'TRIPS':
      return desc.kickerRank !== undefined
        ? `${rankTextOf(desc.shapeRanks)}${shape}，${RANK_CHARS[desc.kickerRank]}踢脚`
        : `${rankTextOf(desc.shapeRanks)}${shape}`;
    case 'TOP_PAIR':
    case 'OVERPAIR':
    case 'MIDDLE_PAIR':
    case 'BOTTOM_PAIR':
    case 'UNDERPAIR':
      return desc.kickerRank !== undefined
        ? `${shape} ${rankTextOf(desc.shapeRanks)}，${RANK_CHARS[desc.kickerRank]}踢脚`
        : `${shape} ${rankTextOf(desc.shapeRanks)}`;
    case 'TWO_PAIR':
    case 'TOP_TWO_PAIR':
      return `${shape} ${ranks}`;
    default:
      return `${shape} ${rankTextOf(desc.keyRanks)}`;
  }
}

function rankTextOf(ranks: readonly Rank[]): string {
  return ranks.map((r) => RANK_CHARS[r] ?? '').join('');
}

/* ============================================================
 * 玩家画像渲染（Step 6）
 * ============================================================ */

/**
 * 画像标签的中文名。
 *
 * 未登记的标签返回「未知玩家」而不是原样输出英文枚举 ——
 * 界面**绝不允许**出现裸的枚举字符串（这是 i18n 层的铁律）。
 */
export function playerLabelText(label: string): string {
  const key = `profile.label.${label}` as MessageKey;
  const text = activeDictionary[key];
  return text === undefined ? t('profile.label.UNKNOWN') : text;
}

/** 连续维度的中文名 */
export function playerDimensionText(dimension: string): string {
  const key = `profile.dimension.${dimension}` as MessageKey;
  const text = activeDictionary[key];
  return text === undefined ? t('common.unknown') : text;
}

/** 样本分层的中文名 */
export function sampleTierText(tier: string): string {
  const key = `profile.tier.${tier}` as MessageKey;
  const text = activeDictionary[key];
  return text === undefined ? t('profile.tier.PRELIMINARY') : text;
}

/** 样本分层的说明（必须解释「为什么这个结论不够稳」） */
export function sampleTierNote(tier: string): string {
  const key = `profile.tier.${tier}.note` as MessageKey;
  const text = activeDictionary[key];
  return text === undefined ? t('profile.tier.PRELIMINARY.note') : text;
}

/** 指标的中文名（25 项指标全部登记） */
export function playerMetricText(metric: string): string {
  const key = `profile.metric.${metric}` as MessageKey;
  const text = activeDictionary[key];
  return text === undefined ? t('common.unknown') : text;
}

/**
 * 先验来源的中文名 + 免责说明。
 *
 * ⚠️ 免责说明是**强制**的：当前没有可靠人口统计数据库，
 * 若 UI 只显示「先验」而不说明它来自启发式估计，
 * 用户会误以为是理论最优数据 —— 这正是规范第十四节禁止的「编造」。
 */
export function priorSourceText(source: string): string {
  const key = `profile.prior.${source}` as MessageKey;
  const text = activeDictionary[key];
  return text === undefined ? t('common.unknown') : text;
}

/** 画像调整的一句话说明（把 stats 转成用户能读懂的因果解释） */
export function profileAdjustmentText(params: {
  neutralized: boolean;
  direction: 'WIDENED' | 'NARROWED' | 'UNCHANGED';
  meanFactor: number;
}): string {
  if (params.neutralized) return t('profile.adjust.neutral');
  switch (params.direction) {
    case 'WIDENED':
      return t('profile.adjust.widened', { meanFactor: params.meanFactor.toFixed(2) });
    case 'NARROWED':
      return t('profile.adjust.narrowed', { meanFactor: params.meanFactor.toFixed(2) });
    default:
      return t('profile.adjust.unchanged');
  }
}

/** 画像事件问题的中文说明（规范第十八节的修正流程） */
export function profileIssueText(code: string, params: Record<string, string | number>): string {
  switch (code) {
    case 'DUPLICATE_HAND':
      return t('profile.amend.duplicateHand', { handId: String(params.handId ?? '') });
    case 'UNKNOWN_PLAYER':
    case 'PLAYER_MISMATCH':
      return t('profile.amend.playerMismatch', {
        expected: String(params.expected ?? ''),
        actual: String(params.actual ?? ''),
      });
    case 'INVALID_TIMESTAMP':
      return t('profile.amend.invalidTimestamp', { timestamp: String(params.timestamp ?? '') });
    case 'UNKNOWN_METRIC':
      return t('profile.amend.unknownMetric', { metric: String(params.metric ?? '') });
    case 'NEGATIVE_COUNT':
    case 'OUT_OF_ORDER_SEQ':
      return t('profile.amend.negativeCount', { seq: String(params.seq ?? '') });
    case 'SEQ_OUT_OF_RANGE':
      return t('profile.amend.seqOutOfRange', {
        seq: String(params.seq ?? ''),
        maxSeq: String(params.maxSeq ?? ''),
        tolerance: String(params.tolerance ?? ''),
      });
    default:
      return t('common.unknown');
  }
}
