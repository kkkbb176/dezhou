/**
 * 搜索「画像使动作翻转」的真实节点（P0 修复验收用例）
 *
 * 目标：找到 `equity` 靠近 `requiredEquity` 的真实节点，
 * 使得 NORMAL（= 无画像调整）与 BLUFF_HEAVY / MANIAC 之间**动作不同**。
 *
 * 用法：`E:\node.exe --experimental-strip-types scripts/profile-flip-search.ts`
 */
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import type { ManualHandInput } from '../src/app/manualInput/manualInput.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const OPTIONS = { rules: RULES, asOf: 1_757_000_000_000, writeLog: false } as const;
const BOARD = ['Kc', '9s', '5d', '2h', '7c'] as const;

type Config = {
  name: string;
  /** 加注者的位置（他的范围宽窄） */
  opener: 'UTG' | 'CO' | 'BTN';
  heroCards: string[];
  /** 翻牌他在位置上是否持续下注（比例） */
  flopBetShare: number;
  turnCheck: boolean;
};

const CONFIGS: readonly Config[] = [
  { name: 'BTN 偷盲线 + A9', opener: 'BTN', heroCards: ['Ah', '9h'], flopBetShare: 0.5, turnCheck: true },
  { name: 'BTN 偷盲线 + 88', opener: 'BTN', heroCards: ['8h', '8d'], flopBetShare: 0.5, turnCheck: true },
  { name: 'CO 开池线 + A9', opener: 'CO', heroCards: ['Ah', '9h'], flopBetShare: 0.5, turnCheck: true },
  { name: 'BTN 两街开火 + A9', opener: 'BTN', heroCards: ['Ah', '9h'], flopBetShare: 0.5, turnCheck: false },
  { name: 'BTN 偷盲线 + AJ 高张', opener: 'BTN', heroCards: ['As', 'Js'], flopBetShare: 0.33, turnCheck: true },
];

const SEAT_ORDER = ['UTG', 'UTG1', 'UTG2', 'LJ', 'HJ', 'CO', 'BTN', 'SB', 'BB'] as const;

function build(cfg: Config, betShare: number, profile: string): ManualHandInput {
  const potAfterFlop = 6.5; // 3BB 开池 + 跟注 + 翻牌半个池 ≈ 基准
  const flopBet = (3 * cfg.flopBetShare).toFixed(2);
  const turnBet = cfg.turnCheck ? null : (3 * cfg.flopBetShare * 2).toFixed(2);
  const potBeforeRiver = cfg.turnCheck ? 3 + Number(flopBet) * 2 : 3 + Number(flopBet) * 2 + Number(turnBet) * 2;
  const riverBet = (potBeforeRiver * betShare).toFixed(2);

  const history: Record<string, unknown>[] = [];
  for (const seat of SEAT_ORDER) {
    if (seat === cfg.opener) {
      history.push({ position: seat, type: 'RAISE', amountBB: 3 });
      continue;
    }
    if (seat === 'BB') continue; // Hero 最后处理
    history.push({ position: seat, type: 'FOLD' });
  }
  history.push({ position: 'BB', type: 'CALL', amountBB: 2 });

  history.push({ position: 'BB', type: 'CHECK', street: 'FLOP' });
  history.push({ position: cfg.opener, type: 'BET', amountBB: Number(flopBet), street: 'FLOP' });
  history.push({ position: 'BB', type: 'CALL', amountBB: Number(flopBet), street: 'FLOP' });

  history.push({ position: 'BB', type: 'CHECK', street: 'TURN' });
  history.push(
    turnBet === null
      ? { position: cfg.opener, type: 'CHECK', street: 'TURN' }
      : { position: cfg.opener, type: 'BET', amountBB: Number(turnBet), street: 'TURN' },
  );
  if (turnBet !== null) history.push({ position: 'BB', type: 'CALL', amountBB: Number(turnBet), street: 'TURN' });

  history.push({ position: 'BB', type: 'CHECK', street: 'RIVER' });
  history.push({ position: cfg.opener, type: 'BET', amountBB: Number(riverBet), street: 'RIVER' });

  void potAfterFlop;
  return {
    tableSize: 9,
    heroPosition: 'BB',
    heroCards: [...cfg.heroCards],
    board: [...BOARD],
    street: 'RIVER',
    effectiveStackBB: 100,
    seatStacksBB: { UTG: 100, CO: 100, BTN: 100, BB: 100 },
    actionHistory: history,
    environment: 'MID_LOW_STAKES',
    villain: { quickProfile: profile, dynamicHint: 'UNKNOWN' },
  } as unknown as ManualHandInput;
}

const PROFILES = ['NORMAL', 'VERY_TIGHT', 'BLUFF_HEAVY', 'MANIAC'] as const;
type Row = { cfg: string; share: number; cells: string[]; flip: boolean };
const rows: Row[] = [];

for (const cfg of CONFIGS) {
  for (const share of [0.25, 0.33, 0.5, 0.66, 0.75, 1]) {
    const cells: string[] = [];
    let flip = false;
    let firstAction = '';
    for (const p of PROFILES) {
      const r = analyzeManualHand(build(cfg, share, p), OPTIONS);
      if (!r.ok) {
        cells.push('ERR');
        continue;
      }
      const m = r.decision.diagnostics.math;
      const action = String(r.decision.action);
      if (firstAction === '') firstAction = action;
      else if (action !== firstAction) flip = true;
      cells.push(
        `${action.padEnd(4)} ${((m.heroEquity ?? 0) * 100).toFixed(2).padStart(5)}%/${(m.requiredEquity * 100).toFixed(2).padStart(5)}%`,
      );
    }
    rows.push({ cfg: cfg.name, share, cells, flip });
  }
}

console.log('NORMAL / VERY_TIGHT / BLUFF_HEAVY / MANIAC（动作 权益/所需）\n');
for (const row of rows) {
  console.log(
    `${row.flip ? '★翻转' : '     '} ${(row.cfg + ` @${row.share}`).padEnd(30)} ${row.cells.join('  ')}`,
  );
}
