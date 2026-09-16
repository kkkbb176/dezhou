/**
 * 红队探针 #1 —— 交互式牌桌输入层（适配器 / 卡牌映射 / 竞态 / Fail-Closed）
 *
 * 覆盖审计清单：
 *   10 卡牌映射   11 视觉 vs 逻辑   12 陈旧响应   13 重复提交   14 上一手泄漏
 *   15 NEW_TABLE   §90 三方一致     §27/§29 前端不得实现规则
 *   applyTableAction 往返等价 / seatStacksBB / 暂离空座 / 畸形载荷 / meta / 性能
 *
 * 运行：
 *   node.exe --experimental-strip-types "scripts/rt-table-adapter-probe.ts"
 *
 * 证据同时写入 scripts/rt-table-adapter-evidence.txt（UTF-8，由 Node 写文件，
 * 不经 PowerShell 重定向 —— 避免中文被代码页破坏）。
 */

import { createHash } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { Position } from '../src/domain/types.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import type { StrategyKnowledge } from '../src/domain/knowledge/knowledge.types.ts';
import { parseManualInput, type ManualHandInput } from '../src/app/manualInput/manualInput.ts';
import { cardToString } from '../src/domain/poker/cards.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { GameEnvironment } from '../src/domain/range/gameEnvironment.ts';
import { createTable, seatOfPosition, staffingProblems } from '../src/app/table/tableState.ts';
import { applyTableOp, engineViewOf } from '../src/app/table/tableOps.ts';
import { buildTablePreview, stateFingerprintOf } from '../src/app/table/tablePreview.ts';
import {
  primaryOpponentPosition,
  tableStateToManualHandInput,
} from '../src/app/table/tableAdapter.ts';
import {
  ActiveHandLeaveChoice,
  type PokerTableState,
  type TableActionButton,
  type TableOp,
  type TablePreview,
} from '../src/app/table/table.types.ts';
import { startAlphaServer, type AlphaServer } from '../src/app/webServer.ts';

/* ============================================================
 * 输出收集
 * ============================================================ */

const OUT: string[] = [];
const counters = { OK: 0, HIT: 0, INFO: 0 };

function section(title: string): void {
  OUT.push('', '='.repeat(78), `## ${title}`, '='.repeat(78));
}

function line(text = ''): void {
  OUT.push(text);
}

/** 结论行：level = OK（干净） / HIT（发现问题） / INFO（中性事实） */
function verdict(level: 'OK' | 'HIT' | 'INFO', id: string, text: string): void {
  counters[level] += 1;
  OUT.push(`[${level}] ${id} ${text}`);
}

function guard(id: string, fn: () => void): void {
  try {
    fn();
  } catch (error) {
    counters.HIT += 1;
    OUT.push(`[HIT] ${id} 抛出异常：${(error as Error).message}`);
    OUT.push((error as Error).stack ?? '');
  }
}

async function guardAsync(id: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    counters.HIT += 1;
    OUT.push(`[HIT] ${id} 抛出异常：${(error as Error).message}`);
    OUT.push((error as Error).stack ?? '');
  }
}

/* ============================================================
 * 驱动辅助（与 test/interactiveTable*.test.ts 的做法一致）
 * ============================================================ */

const RULES: readonly StrategyKnowledge[] = loadKnowledgeBaseOrThrow().allRules();

const ORDER_6: readonly Position[] = [
  Position.UTG,
  Position.HJ,
  Position.CO,
  Position.BTN,
  Position.SB,
  Position.BB,
];

function must(result: ReturnType<typeof applyTableOp>): PokerTableState {
  if (!result.ok) throw new Error(`操作被拒绝：${result.issues.map((i) => i.message).join(' / ')}`);
  return result.state;
}

function drive(start: PokerTableState, ops: readonly TableOp[]): PokerTableState {
  let state = start;
  for (const op of ops) state = must(applyTableOp(state, op));
  return state;
}

function fullTable(hero: Position = Position.CO, stackBB = 100): PokerTableState {
  let state = createTable({ tableSize: 6, heroPosition: hero, defaultStackBB: stackBB });
  for (const position of ORDER_6) {
    if (position === hero) continue;
    state = must(
      applyTableOp(state, { kind: 'ADD_PLAYER', seatId: seatOfPosition(state, position)!.seatId }),
    );
  }
  return state;
}

const prev = (state: PokerTableState): TablePreview => buildTablePreview(state);

function buttonsOf(p: TablePreview, type: string): readonly TableActionButton[] {
  return p.actionButtons.filter((b) => b.type === type);
}

/** 完全按浏览器的做法提交一个按钮（table.js 的 payload 构造） */
function actWithButton(
  state: PokerTableState,
  button: TableActionButton,
): ReturnType<typeof applyTableOp> {
  return applyTableOp(state, {
    kind: 'ACT',
    action: {
      type: button.type,
      ...(button.amountChips !== undefined ? { amountChips: button.amountChips } : {}),
    },
  });
}

function clickButton(state: PokerTableState, type: string, index = 0): PokerTableState {
  const p = prev(state);
  // BET/RAISE 的 PRIMARY 按钮只是「展开尺寸行」，真正提交的是 SIZE 按钮
  const sizes = p.actionButtons.filter((b) => b.type === type && b.group === 'SIZE');
  const pool = sizes.length > 0 ? sizes : buttonsOf(p, type);
  const button = pool[index] ?? pool[0];
  if (button === undefined) {
    throw new Error(
      `预览里没有「${type}」按钮。现有：${p.actionButtons.map((b) => b.labelZh).join(' / ') || '（无）'}`,
    );
  }
  return must(actWithButton(state, button));
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

/**
 * 造一个「翻牌圈、轮到 Hero 行动」的标准局面（Hero 固定在 BTN）：
 * UTG/HJ/CO 弃牌 → Hero 跟注 → SB 弃牌 → BB 过牌 → 翻牌三张 → BB 过牌 → 轮到 Hero。
 */
function flopScenario(heroCards: readonly [string, string]): PokerTableState {
  let st = fullTable(Position.BTN);
  st = drive(st, [
    { kind: 'SET_HERO_CARD', card: heroCards[0] },
    { kind: 'SET_HERO_CARD', card: heroCards[1] },
  ]);
  st = clickButton(st, 'FOLD'); // UTG
  st = clickButton(st, 'FOLD'); // HJ
  st = clickButton(st, 'FOLD'); // CO
  st = clickButton(st, 'CALL'); // BTN = Hero
  st = clickButton(st, 'FOLD'); // SB
  st = clickButton(st, 'CHECK'); // BB
  st = drive(st, [
    { kind: 'SET_BOARD_CARD', card: 'Kh', slot: 0 },
    { kind: 'SET_BOARD_CARD', card: '7c', slot: 1 },
    { kind: 'SET_BOARD_CARD', card: '2d', slot: 2 },
  ]);
  return clickButton(st, 'CHECK'); // BB 过牌 → 轮到 Hero
}

function contextOf(
  state: Parameters<typeof buildDecisionContext>[0]['state'],
  villain: { quickProfile?: string; playerId?: string },
): ReturnType<typeof buildDecisionContext> {
  return buildDecisionContext({
    state,
    rules: RULES,
    environment: GameEnvironment.MID_LOW_STAKES,
    asOf: 1_757_000_000_000,
    ...(villain.quickProfile !== undefined ? { quickProfile: villain.quickProfile as never } : {}),
    ...(villain.playerId !== undefined ? { villainPlayerId: villain.playerId } : {}),
  });
}

/* ============================================================
 * §0 被测代码快照
 * ============================================================ */

const AUDITED = [
  'src/app/table/tableAdapter.ts',
  'src/app/table/tablePreview.ts',
  'src/app/table/tableOps.ts',
  'src/app/table/tableApi.ts',
  'src/app/table/tableState.ts',
  'src/app/table/seatLifecycle.ts',
  'src/app/table/table.types.ts',
  'src/app/web/table.js',
  'src/app/webServer.ts',
  'src/app/manualInput/manualInput.ts',
  'src/app/manualInput/reconstruct.ts',
  'src/app/manualInput/legalActions.ts',
];

function snapshot(): void {
  section('§0 被测代码快照（sha256 前 16 位 + mtime + 字节数）');
  for (const rel of AUDITED) {
    const abs = fileURLToPath(new URL(`../${rel}`, import.meta.url));
    const text = readFileSync(abs, 'utf8');
    line(
      `${rel.padEnd(42)} ${sha256(text)}  mtime=${statSync(abs).mtime.toISOString()}  chars=${text.length}`,
    );
  }
}

/* ============================================================
 * 向量 10：卡牌映射
 * ============================================================ */

/** 从浏览器客户端源码里抽出它真正会生成的牌面代码（不信任注释） */
function clientGridCodes(): readonly string[] {
  const abs = fileURLToPath(new URL('../src/app/web/table.js', import.meta.url));
  const src = readFileSync(abs, 'utf8');
  const suits = [...src.matchAll(/code:\s*'([shdc])'/g)].map((m) => m[1]!);
  const ranksBlock = /var RANKS = \[([^\]]+)\]/.exec(src);
  if (ranksBlock === null) throw new Error('table.js 里找不到 RANKS 字面量');
  const ranks = [...ranksBlock[1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
  const codes: string[] = [];
  for (const s of suits) for (const r of ranks) codes.push(`${r}${s}`);
  return codes;
}

function vector10Cards(): void {
  section('向量 10：卡牌映射（rank/suit ↔ 代码；4×13 网格 vs 后端解析）');

  const gridCodes = clientGridCodes();
  line(`  table.js 网格生成的代码（${gridCodes.length} 张）：${gridCodes.join(' ')}`);

  // --- 10a：网格里的每一张都能被牌桌后端接受，且存进去的就是它 ---
  let heroState = fullTable(Position.CO);
  const failedHero: string[] = [];
  for (const code of gridCodes) {
    const r = applyTableOp(heroState, { kind: 'SET_HERO_CARD', card: code });
    if (!r.ok) {
      failedHero.push(`${code}:${r.issues[0]?.code ?? '?'}`);
      continue;
    }
    const stored = r.state.heroCards[r.state.heroCards.length - 1]!;
    if (stored !== code) failedHero.push(`${code}->${stored}`);
    heroState = must(applyTableOp(r.state, { kind: 'SET_HERO_CARD', card: code })); // 再点一次取消
  }
  verdict(
    failedHero.length === 0 ? 'OK' : 'HIT',
    'V10a',
    failedHero.length === 0
      ? `网格 ${gridCodes.length} 张牌全部被 SET_HERO_CARD 原样接受（代码逐字不变）`
      : `有牌被拒绝或被改写：${failedHero.join(', ')}`,
  );

  // --- 10b：公共牌路径 + 引擎看到的 rank/suit 必须与代码一致 ---
  const st = flopScenario(['As', 'Kd']);
  const adapted = tableStateToManualHandInput(st);
  const view = engineViewOf(st);
  if (adapted.ok && view.ok) {
    const hero = view.engine.players.find((p) => p.position === Position.BTN)!;
    const hole = (hero.holeCards ?? []).map((c) => cardToString(c));
    const board = view.engine.board.flop.map((c) => cardToString(c));
    line(`      屏幕手牌=['As','Kd'] → 引擎 holeCards=${JSON.stringify(hole)}`);
    line(`      屏幕翻牌=['Kh','7c','2d'] → 引擎 flop=${JSON.stringify(board)}`);
    const ok =
      JSON.stringify(hole) === JSON.stringify(['As', 'Kd']) &&
      JSON.stringify(board) === JSON.stringify(['Kh', '7c', '2d']);
    verdict(
      ok ? 'OK' : 'HIT',
      'V10b',
      ok
        ? '4×13 网格代码 = 引擎 rank/suit（As 处处都是黑桃 A，花色字母 s/h/d/c 一一对应）'
        : '网格代码与引擎牌面不一致',
    );
  } else {
    verdict('HIT', 'V10b', '适配/重放失败');
  }

  // --- 10c：同一张牌不能在 Hero 手牌与公共牌里各出现一次 ---
  const dupHero = applyTableOp(st, { kind: 'SET_HERO_CARD', card: 'Kh' });
  const dupBoard = applyTableOp(st, { kind: 'SET_BOARD_CARD', card: 'As', slot: 3 });
  verdict(
    !dupHero.ok && !dupBoard.ok ? 'OK' : 'HIT',
    'V10c',
    `重复牌：hero→Kh ${dupHero.ok ? '被接受(!)' : '拒绝(' + dupHero.issues[0]!.code + ')'} / board→As ${dupBoard.ok ? '被接受(!)' : '拒绝(' + dupBoard.issues[0]!.code + ')'}`,
  );

  // --- 10d：同一张牌点两次 = 取消（不是重复选择） ---
  const twice = drive(fullTable(Position.CO), [
    { kind: 'SET_HERO_CARD', card: 'As' },
    { kind: 'SET_HERO_CARD', card: 'As' },
  ]);
  verdict(
    twice.heroCards.length === 0 ? 'OK' : 'HIT',
    'V10d',
    `同一张牌点两次 = 取消选择（heroCards=${JSON.stringify(twice.heroCards)}），不会出现 ['As','As']`,
  );

  // --- 10e：网格 52 张无重复 ---
  verdict(new Set(gridCodes).size === 52 ? 'OK' : 'HIT', 'V10e', `网格去重后 ${new Set(gridCodes).size} 张（应为 52）`);
}

/* ============================================================
 * §27/§29 + applyTableAction：只点按钮的属性检查
 *   属性 1（offer ⇒ accept）：预览给出的每个按钮，后端必须接受
 *   属性 2：点完之后，预览指纹必须等于重放指纹
 * ============================================================ */

type ButtonFailure = {
  scenario: string;
  label: string;
  payload: string;
  issue: string;
};

const buttonFailures: ButtonFailure[] = [];
const fingerprintFailures: string[] = [];
let buttonsTried = 0;

function exploitAllButtons(
  scenario: string,
  state: PokerTableState,
  depth: number,
  seen: Set<string>,
): void {
  if (depth <= 0) return;
  const p = prev(state);
  if (!p.ok) return;
  const v = engineViewOf(state);
  const key = v.ok ? stateFingerprintOf(v.engine) : JSON.stringify(state.actionHistory);
  if (seen.has(key)) return;
  seen.add(key);

  const uniq = new Map<string, TableActionButton>();
  for (const b of p.actionButtons) {
    // 浏览器的真实行为：BET/RAISE 的「展开尺寸」按钮不提交任何 ACT
    //（table.js 只对 group==='PRIMARY' 的非 BET/RAISE 按钮绑定提交；尺寸按钮是 group==='SIZE'）
    if (b.group !== 'PRIMARY' && b.group !== 'SIZE') continue;
    if (b.group === 'PRIMARY' && (b.type === 'BET' || b.type === 'RAISE')) continue;
    uniq.set(`${b.type}|${b.amountChips ?? '-'}`, b);
  }

  for (const b of uniq.values()) {
    buttonsTried += 1;
    const r = actWithButton(state, b);
    if (!r.ok) {
      buttonFailures.push({
        scenario,
        label: b.labelZh,
        payload: JSON.stringify({ type: b.type, amountChips: b.amountChips ?? null }),
        issue: r.issues.map((i) => `${i.code}:${i.message.split('\n')[0]}`).join(' | '),
      });
      continue;
    }
    const p2 = prev(r.state);
    const v2 = engineViewOf(r.state);
    if (v2.ok && p2.stateFingerprint !== stateFingerprintOf(v2.engine)) {
      fingerprintFailures.push(`${scenario} / ${b.labelZh}`);
    }
    exploitAllButtons(`${scenario}>${b.type}`, r.state, depth - 1, seen);
  }
}

function offeredButtonProperty(): void {
  section('§27/§29：预览给出的按钮 ⇒ 后端必须接受（穷举 5 层决策树）');

  const scenarios: { name: string; state: PokerTableState }[] = [];

  // 1) 满座翻牌前，Hero 在 CO
  scenarios.push({
    name: 'preflop-fullstack',
    state: drive(fullTable(Position.CO), [
      { kind: 'SET_HERO_CARD', card: 'As' },
      { kind: 'SET_HERO_CARD', card: 'Kd' },
    ]),
  });

  // 2) 短筹码：SB 40BB / BB 25BB / UTG 12BB
  let short = fullTable(Position.CO);
  for (const [position, bb] of [
    [Position.SB, 40],
    [Position.BB, 25],
    [Position.UTG, 12],
  ] as const) {
    short = must(
      applyTableOp(short, {
        kind: 'SET_STACK',
        seatId: seatOfPosition(short, position)!.seatId,
        stackBB: bb,
      }),
    );
  }
  scenarios.push({
    name: 'preflop-shortstacks',
    state: drive(short, [
      { kind: 'SET_HERO_CARD', card: 'As' },
      { kind: 'SET_HERO_CARD', card: 'Kd' },
    ]),
  });

  // 3) 翻牌单挑（Hero BTN）
  let flop = fullTable(Position.BTN);
  flop = drive(flop, [
    { kind: 'SET_HERO_CARD', card: 'Ah' },
    { kind: 'SET_HERO_CARD', card: 'Qh' },
  ]);
  flop = clickButton(flop, 'FOLD'); // UTG
  flop = clickButton(flop, 'FOLD'); // HJ
  flop = clickButton(flop, 'FOLD'); // CO
  flop = clickButton(flop, 'CALL'); // BTN(Hero) 平跟
  flop = clickButton(flop, 'FOLD'); // SB
  flop = clickButton(flop, 'CHECK'); // BB 过牌 → 翻牌前结束
  flop = drive(flop, [
    { kind: 'SET_BOARD_CARD', card: 'Kh', slot: 0 },
    { kind: 'SET_BOARD_CARD', card: '7c', slot: 1 },
    { kind: 'SET_BOARD_CARD', card: '2d', slot: 2 },
  ]);
  scenarios.push({ name: 'flop-hu', state: flop });

  // 4) 分数筹码 + 非 100 面额（bigBlindBB = 3）
  let frac = fullTable(Position.CO);
  frac = must(
    applyTableOp(frac, {
      kind: 'SET_STACK',
      seatId: seatOfPosition(frac, Position.BB)!.seatId,
      stackBB: 37.5,
    }),
  );
  frac = { ...frac, bigBlindBB: 3 } as PokerTableState;
  scenarios.push({
    name: 'fractional-bb3',
    state: drive(frac, [
      { kind: 'SET_HERO_CARD', card: 'As' },
      { kind: 'SET_HERO_CARD', card: 'Kd' },
    ]),
  });

  for (const s of scenarios) {
    const before = buttonFailures.length;
    exploitAllButtons(s.name, s.state, 5, new Set());
    line(
      `      场景 ${s.name.padEnd(22)} 本次新增按钮失败=${buttonFailures.length - before}（累计试 ${buttonsTried} 个）`,
    );
  }

  line('', `  —— 被拒绝的按钮（预览说合法、后端拒绝）：${buttonFailures.length} 条`);
  const byLabel = new Map<string, number>();
  for (const f of buttonFailures) {
    const key = f.label.replace(/（.*?）/, '（…）');
    byLabel.set(key, (byLabel.get(key) ?? 0) + 1);
  }
  line(`  按按钮标签汇总：${[...byLabel.entries()].map(([k, v]) => `${k}×${v}`).join(' / ') || '（无）'}`);
  const byIssue = new Map<string, number>();
  for (const f of buttonFailures) {
    const key = f.issue.split('。')[0]!;
    byIssue.set(key, (byIssue.get(key) ?? 0) + 1);
  }
  line('  按后端原因汇总：');
  for (const [k, v] of byIssue) line(`    ${v}× ${k}`);
  for (const f of buttonFailures.slice(0, 6)) {
    line(`  · 场景=${f.scenario}`);
    line(`    按钮=${f.label}`);
    line(`    载荷=${f.payload}`);
    line(`    后端=${f.issue}`);
  }
  verdict(
    buttonFailures.length === 0 ? 'OK' : 'HIT',
    'V27',
    `共试 ${buttonsTried} 个按钮，其中 ${buttonFailures.length} 个被后端拒绝`,
  );
  verdict(
    fingerprintFailures.length === 0 ? 'OK' : 'HIT',
    'V90f',
    `按钮生效后「预览指纹 vs 重放指纹」不一致次数=${fingerprintFailures.length}`,
  );
  for (const f of fingerprintFailures.slice(0, 5)) line(`  · ${f}`);
}

/* ============================================================
 * ALL_IN 专项：最小可复现
 * ============================================================ */

function allInFocus(): void {
  section('ALL_IN 专项（预览按钮携带的金额 vs 引擎对 ALL_IN 的语义）');

  let st = drive(fullTable(Position.BTN), [
    { kind: 'SET_HERO_CARD', card: 'As' },
    { kind: 'SET_HERO_CARD', card: 'Kd' },
  ]);
  st = clickButton(st, 'FOLD'); // UTG
  st = clickButton(st, 'FOLD'); // HJ
  st = clickButton(st, 'FOLD'); // CO
  st = clickButton(st, 'FOLD'); // BTN = Hero

  const p = prev(st);
  const allIn = p.actionButtons.find((b) => b.type === 'ALL_IN');
  line(`  复现 1：UTG..BTN 弃牌，轮到 ${String(p.currentActorPosition)}（本街已投入 0.5BB 盲注）`);
  line(
    `  预览按钮：${p.actionButtons
      .map((b) => `${b.labelZh}[${b.group}${b.amountChips !== undefined ? ' chips=' + b.amountChips : ''}]`)
      .join(' / ')}`,
  );
  if (allIn === undefined) {
    verdict('INFO', 'V-ALLIN-1', '该局面预览没有给出 ALL_IN 按钮');
  } else {
    line(`  ALL_IN 按钮：${JSON.stringify(allIn)}`);
    const view = engineViewOf(st);
    if (view.ok) {
      const actor = view.engine.players.find((x) => x.id === view.engine.pendingQueue[0]!)!;
      line(
        `  引擎口径：行动者剩余=${actor.remainingStack} 本街已投入=${actor.committedByStreet[view.engine.street]} → doAllIn 要求 amount === ${actor.remainingStack}`,
      );
      line(`  按钮携带 amountChips = ${String(allIn.amountChips)}（= 已投入 + 剩余）`);
    }
    const clicked = actWithButton(st, allIn);
    verdict(
      clicked.ok ? 'OK' : 'HIT',
      'V-ALLIN-1',
      clicked.ok
        ? '点 ALL_IN 按钮被后端接受'
        : `点 ALL_IN 按钮被后端拒绝：${clicked.issues.map((i) => `${i.code}:${i.message.split('\n')[0]}`).join(' | ')}`,
    );
    if (view.ok) {
      const actor = view.engine.players.find((x) => x.id === view.engine.pendingQueue[0]!)!;
      const fixed = applyTableOp(st, {
        kind: 'ACT',
        action: { type: 'ALL_IN', amountChips: actor.remainingStack },
      });
      line(
        `  对照 A：ALL_IN amountChips=${actor.remainingStack}（剩余筹码）→ ok=${fixed.ok}${
          fixed.ok ? '' : ' ' + JSON.stringify(fixed.issues.map((i) => i.code))
        }`,
      );
    }
    const raiseSizes = p.actionButtons.filter((b) => b.type === 'RAISE' && b.group === 'SIZE');
    const lastSize = raiseSizes[raiseSizes.length - 1];
    line(`  对照 B（同一条规则的另一条 UI 路径）：RAISE 尺寸按钮=${raiseSizes.map((b) => b.labelZh).join(' / ') || '（无）'}`);
    if (lastSize !== undefined) {
      const viaRaise = actWithButton(st, lastSize);
      line(`    RAISE(amountChips=${String(lastSize.amountChips)}) → ok=${viaRaise.ok}`);
    }
  }

  // 复现 2：平跟之后面对加注，行动权回到平跟者本人（本街已投入 1BB）
  let st2 = drive(fullTable(Position.BTN), [
    { kind: 'SET_HERO_CARD', card: 'As' },
    { kind: 'SET_HERO_CARD', card: 'Kd' },
  ]);
  st2 = clickButton(st2, 'CALL'); // UTG 平跟
  st2 = clickButton(st2, 'RAISE', 0); // HJ 加注
  st2 = clickButton(st2, 'FOLD'); // CO
  st2 = clickButton(st2, 'FOLD'); // BTN = Hero
  st2 = clickButton(st2, 'FOLD'); // SB
  st2 = clickButton(st2, 'FOLD'); // BB
  const p2 = prev(st2);
  const allIn2 = p2.actionButtons.find((b) => b.type === 'ALL_IN');
  line('', `  复现 2：UTG 平跟 → HJ 加注 → 其余弃牌 → 回到 ${String(p2.currentActorPosition)}（平跟者，已投入 1BB）`);
  line(`  预览按钮：${p2.actionButtons.map((b) => b.labelZh).join(' / ')}`);
  if (allIn2 !== undefined) {
    const r2 = actWithButton(st2, allIn2);
    verdict(
      r2.ok ? 'OK' : 'HIT',
      'V-ALLIN-2',
      `点 ALL_IN（${allIn2.labelZh}，chips=${String(allIn2.amountChips)}）→ ok=${r2.ok}` +
        (r2.ok ? '' : ` / ${r2.issues.map((i) => i.code).join(',')}`),
    );
  }

  // 复现 3：大盲面对小盲加注
  let st3 = drive(fullTable(Position.CO), [
    { kind: 'SET_HERO_CARD', card: 'As' },
    { kind: 'SET_HERO_CARD', card: 'Kd' },
  ]);
  st3 = clickButton(st3, 'FOLD'); // UTG
  st3 = clickButton(st3, 'FOLD'); // HJ
  st3 = clickButton(st3, 'FOLD'); // CO = Hero
  st3 = clickButton(st3, 'FOLD'); // BTN
  st3 = clickButton(st3, 'RAISE', 0); // SB 加注
  const p3 = prev(st3);
  const allIn3 = p3.actionButtons.find((b) => b.type === 'ALL_IN');
  line('', `  复现 3：SB 加注 → 轮到 ${String(p3.currentActorPosition)}（大盲已投入 1BB）`);
  line(`  预览按钮：${p3.actionButtons.map((b) => b.labelZh).join(' / ')}`);
  if (allIn3 !== undefined) {
    const r3 = actWithButton(st3, allIn3);
    verdict(
      r3.ok ? 'OK' : 'HIT',
      'V-ALLIN-3',
      `点 ALL_IN（${allIn3.labelZh}，chips=${String(allIn3.amountChips)}）→ ok=${r3.ok}` +
        (r3.ok ? '' : ` / ${r3.issues.map((i) => i.code).join(',')}`),
    );
  }

  // 记录：ALL_IN 记录进 actionHistory 的金额语义
  line('', '  记录语义检查（成功路径）：');
  let ok4 = drive(fullTable(Position.CO), [
    { kind: 'SET_HERO_CARD', card: 'As' },
    { kind: 'SET_HERO_CARD', card: 'Kd' },
  ]);
  const allIn4 = prev(ok4).actionButtons.find((b) => b.type === 'ALL_IN');
  if (allIn4 !== undefined) {
    const r4 = actWithButton(ok4, allIn4);
    ok4 = must(r4);
    const rec = ok4.actionHistory[ok4.actionHistory.length - 1]!;
    const view4 = engineViewOf(ok4);
    const actor = view4.ok ? view4.engine.players.find((x) => x.position === Position.UTG)! : null;
    line(`    UTG（本街已投入 0）全下成功：记录=${JSON.stringify(rec)} 引擎口径 committed=${actor?.committedByStreet.PREFLOP}`);
    line('    → 已投入为 0 时「本街总额」与「剩余筹码」恰好相等，因此这条记录能重放；一旦已投入 > 0，两者分叉');
  }

  // 复现 4：本街已投入 > 0 时，**连「填对金额」也无法全下**（记录层同样分叉）
  let st5 = drive(fullTable(Position.BTN), [
    { kind: 'SET_HERO_CARD', card: 'As' },
    { kind: 'SET_HERO_CARD', card: 'Kd' },
  ]);
  st5 = clickButton(st5, 'FOLD'); // UTG
  st5 = clickButton(st5, 'FOLD'); // HJ
  st5 = clickButton(st5, 'FOLD'); // CO
  st5 = clickButton(st5, 'FOLD'); // BTN = Hero
  const p5 = prev(st5);
  const view5 = engineViewOf(st5);
  const allIn5 = p5.actionButtons.find((b) => b.type === 'ALL_IN');
  if (view5.ok && allIn5 !== undefined) {
    const actor5 = view5.engine.players.find((x) => x.id === view5.engine.pendingQueue[0]!)!;
    const correct = applyTableOp(st5, {
      kind: 'ACT',
      action: { type: 'ALL_IN', amountChips: actor5.remainingStack },
    });
    line('', `  复现 4：同一局面，用「引擎语义的正确金额」${actor5.remainingStack}（= 剩余筹码）提交 ALL_IN`);
    verdict(
      correct.ok ? 'OK' : 'HIT',
      'V-ALLIN-4',
      correct.ok
        ? '按引擎语义提交 ALL_IN 成功'
        : `即使用正确金额也被拒绝（重放自检失败）：${correct.issues.map((i) => i.code + ':' + i.message.split('\n')[0]).join(' | ').slice(0, 200)}`,
    );
    if (!correct.ok) {
      const msg = correct.issues.map((i) => i.message).join('\n');
      const idx = msg.indexOf('应用：');
      if (idx >= 0) line(`      自检原文（截断）：${msg.slice(idx, idx + 260)}`);
    }
  }
}

/* ============================================================
 * 向量 11：视觉序号 vs 逻辑位置
 * ============================================================ */

function vector11Visual(): void {
  section('向量 11：视觉座位序号 vs 逻辑位置');

  const inputs: Record<string, string> = {};
  for (const hero of ORDER_6) {
    const st = drive(fullTable(hero), [
      { kind: 'SET_HERO_CARD', card: 'As' },
      { kind: 'SET_HERO_CARD', card: 'Kd' },
    ]);
    const r = tableStateToManualHandInput(st);
    if (!r.ok) {
      verdict('HIT', 'V11a', `${hero} 适配失败`);
      return;
    }
    inputs[hero] = JSON.stringify({
      heroPosition: r.input.heroPosition,
      seatStacksBB: r.input.seatStacksBB,
      actionHistory: r.input.actionHistory,
    });
  }
  const normalized = new Set(
    Object.values(inputs).map((s) => s.replace(/"heroPosition":"[A-Z0-9]+"/, '"heroPosition":"X"')),
  );
  verdict(
    normalized.size === 1 ? 'OK' : 'HIT',
    'V11a',
    `6 个 Hero 位置下提交给管线的 seatStacksBB/actionHistory 逐位一致（归一化后不同取值数=${normalized.size}）`,
  );

  const st = fullTable(Position.SB);
  const p = prev(st);
  const visuals = p.seats.map((s) => s.visualIndex).sort((a, b) => a - b);
  const heroSeat = p.seats.find((s) => s.isHero)!;
  line(`      seats(logical,visual,angle)=${JSON.stringify(p.seats.map((s) => [s.logicalPosition, s.visualIndex, s.angleDeg]))}`);
  verdict(
    heroSeat.visualIndex === 0 && JSON.stringify(visuals) === JSON.stringify([0, 1, 2, 3, 4, 5])
      ? 'OK'
      : 'HIT',
    'V11b',
    `Hero(SB) visualIndex=${heroSeat.visualIndex}；全部视觉序号=${visuals.join(',')}（双射且 Hero=0）`,
  );

  const abs = fileURLToPath(new URL('../src/app/web/table.js', import.meta.url));
  const src = readFileSync(abs, 'utf8');
  const uses = src
    .split('\n')
    .map((text, i) => ({ text, i: i + 1 }))
    .filter((x) => /visualIndex|angleDeg/.test(x.text));
  line('      table.js 使用 visualIndex/angleDeg 的位置：');
  for (const u of uses) line(`        L${u.i}: ${u.text.trim()}`);
  const suspicious = uses.filter(
    (u) => !/^\s*(\*|\/\*)/.test(u.text) && /indexOf|position|Position|order|raise|pot/i.test(u.text),
  );
  verdict(
    suspicious.length === 0 ? 'OK' : 'HIT',
    'V11c',
    `客户端把视觉序号用于逻辑判断的位置数=${suspicious.length}`,
  );
}

/* ============================================================
 * §90 三方一致
 * ============================================================ */

function tripleAgreement(): void {
  section('§90 三方一致：屏幕显示 == 实际提交 == 后端重建状态');

  const st = flopScenario(['Ah', 'Qh']);
  const p = prev(st);
  line(`  屏幕：街道=${p.streetZh} 底池=${p.potBB}BB 当前注=${p.currentBetBB}BB 需跟注=${p.callAmountBB}BB 行动者=${String(p.currentActorPosition)} HeroTurn=${p.isHeroTurn}`);
  line(`  屏幕按钮：${p.actionButtons.map((b) => b.labelZh).join(' / ')}`);
  line(`  屏幕座位[位置,玩家,起始BB,剩余BB,弃牌]=${JSON.stringify(p.seats.map((s) => [s.logicalPosition, s.playerId, s.stackBB, s.remainingStackBB, s.folded]))}`);

  const adapted = tableStateToManualHandInput(st);
  if (!adapted.ok) {
    verdict('HIT', 'V90', '适配失败');
    return;
  }
  const submitted = adapted.input;
  line(`  提交（ManualHandInput）hash=${sha256(JSON.stringify(submitted))}`);
  line(`  提交内容=${JSON.stringify(submitted)}`);

  const parsed = parseManualInput(submitted);
  if (!parsed.ok) {
    verdict('HIT', 'V90', `提交的输入无法解析：${JSON.stringify(parsed.issues)}`);
    return;
  }
  const gate = buildAnalyzableState(parsed.value);
  if (!gate.ok) {
    verdict('HIT', 'V90', `后端阻断：${JSON.stringify(gate.issues)}`);
    return;
  }
  const engine = gate.state;
  line(`  后端指纹=${stateFingerprintOf(engine)}`);
  line(`  后端底池=${gate.computedPot} 筹码 = ${gate.computedPot / st.bigBlindBB}BB`);

  const problems: string[] = [];
  if (Math.abs(gate.computedPot / st.bigBlindBB - p.potBB) > 1e-9) {
    problems.push(`底池：屏幕 ${p.potBB}BB vs 后端 ${gate.computedPot / st.bigBlindBB}BB`);
  }
  const actorId = engine.pendingQueue[0] ?? null;
  const actorPos = actorId !== null ? engine.players.find((x) => x.id === actorId)!.position : null;
  if (actorPos !== p.currentActorPosition) {
    problems.push(`行动者：屏幕 ${String(p.currentActorPosition)} vs 后端 ${String(actorPos)}`);
  }
  for (const seat of p.seats) {
    const ep = engine.players.find((x) => x.position === seat.logicalPosition)!;
    if (ep.startingStack !== seat.stackBB * st.bigBlindBB) {
      problems.push(`座位 ${seat.logicalPosition} 起始筹码：屏幕 ${seat.stackBB}BB vs 引擎 ${ep.startingStack} 筹码`);
    }
    const remainingBB = Number((ep.remainingStack / st.bigBlindBB).toFixed(2));
    if (seat.remainingStackBB !== null && Math.abs(remainingBB - seat.remainingStackBB) > 0.011) {
      problems.push(`座位 ${seat.logicalPosition} 剩余：屏幕 ${seat.remainingStackBB}BB vs 引擎 ${remainingBB}BB`);
    }
    if (seat.folded !== ep.folded) {
      problems.push(`座位 ${seat.logicalPosition} 弃牌：屏幕 ${seat.folded} vs 引擎 ${ep.folded}`);
    }
  }
  const heroEngine = engine.players.find((x) => x.id === engine.userPlayerId)!;
  const hole = (heroEngine.holeCards ?? []).map((c) => cardToString(c));
  if (JSON.stringify(hole) !== JSON.stringify([...st.heroCards])) {
    problems.push(`Hero 手牌：屏幕 ${JSON.stringify(st.heroCards)} vs 引擎 ${JSON.stringify(hole)}`);
  }
  const board = [
    ...engine.board.flop.map((c) => cardToString(c)),
    ...engine.board.turn.map((c) => cardToString(c)),
    ...engine.board.river.map((c) => cardToString(c)),
  ];
  if (JSON.stringify(board) !== JSON.stringify([...st.board])) {
    problems.push(`公共牌：屏幕 ${JSON.stringify(st.board)} vs 引擎 ${JSON.stringify(board)}`);
  }
  line(`  引擎台账=${engine.actions.map((a) => `${a.street}|${a.position}|${a.type}`).join(' ; ')}`);
  line(`  屏幕时间线=${st.actionHistory.map((a) => `${a.street ?? '?'}|${a.position}|${a.type}|${a.amountBB ?? '-'}`).join(' ; ')}`);

  const built = contextOf(engine, {
    ...(submitted.villain.quickProfile !== undefined ? { quickProfile: submitted.villain.quickProfile } : {}),
    ...(submitted.villain.playerId !== undefined ? { playerId: submitted.villain.playerId } : {}),
  });
  const decisionEffective = built.context.math.effectiveStack;
  line(`  有效筹码：屏幕 ${String(p.effectiveStackBB)}BB vs 决策引擎 ${decisionEffective / st.bigBlindBB}BB（math.effectiveStack=${decisionEffective} 筹码）`);
  if (Math.abs(decisionEffective / st.bigBlindBB - (p.effectiveStackBB ?? -1)) > 1e-9) {
    problems.push(`有效筹码：屏幕 ${String(p.effectiveStackBB)}BB vs 决策引擎 ${decisionEffective / st.bigBlindBB}BB`);
  }
  line(`  决策引擎首要对手=${String(built.context.villain?.playerId ?? '(未知)')}；适配器首要对手位置=${String(primaryOpponentPosition(st))}`);

  verdict(problems.length === 0 ? 'OK' : 'HIT', 'V90', `三方比对不一致项 ${problems.length} 条`);
  for (const problem of problems) line(`      · ${problem}`);
}

/* ============================================================
 * 有效筹码口径：屏幕 vs 决策引擎
 * ============================================================ */

function effectiveStackDivergence(): void {
  section('有效筹码口径：屏幕 vs 决策引擎（两名活跃对手、筹码不同）');

  // Hero CO 100BB；HJ 100BB（座位序第一 → 首要对手）；BTN 20BB
  let st = fullTable(Position.CO);
  st = must(
    applyTableOp(st, { kind: 'SET_STACK', seatId: seatOfPosition(st, Position.BTN)!.seatId, stackBB: 20 }),
  );
  st = drive(st, [
    { kind: 'SET_HERO_CARD', card: 'Ah' },
    { kind: 'SET_HERO_CARD', card: 'Qh' },
  ]);
  st = clickButton(st, 'FOLD'); // UTG
  st = clickButton(st, 'CALL'); // HJ
  st = clickButton(st, 'CALL'); // CO = Hero
  st = clickButton(st, 'CALL'); // BTN
  st = clickButton(st, 'FOLD'); // SB
  st = clickButton(st, 'FOLD'); // BB
  st = drive(st, [
    { kind: 'SET_BOARD_CARD', card: 'Kh', slot: 0 },
    { kind: 'SET_BOARD_CARD', card: '7c', slot: 1 },
    { kind: 'SET_BOARD_CARD', card: '2d', slot: 2 },
  ]);
  st = clickButton(st, 'CHECK'); // HJ 先行动
  const p = prev(st);
  line(`  轮到 ${String(p.currentActorPosition)}（HeroTurn=${p.isHeroTurn}）活跃对手=${p.activeOpponentCount}`);
  line(`  屏幕 preview.effectiveStackBB=${String(p.effectiveStackBB)}BB；各座位剩余=${JSON.stringify(p.remainingStacksBB)}`);

  const adapted = tableStateToManualHandInput(st);
  const view = engineViewOf(st);
  if (!adapted.ok || !view.ok) {
    verdict('HIT', 'V-EFF', '适配或重放失败');
    return;
  }
  const parsed = parseManualInput(adapted.input);
  if (!parsed.ok) {
    verdict('HIT', 'V-EFF', '解析失败');
    return;
  }
  const gate = buildAnalyzableState(parsed.value);
  if (!gate.ok) {
    verdict('INFO', 'V-EFF', `后端阻断（无法比较）：${JSON.stringify(gate.issues.map((i) => i.code))}`);
    return;
  }
  const built = contextOf(gate.state, {
    ...(parsed.value.villain.quickProfile !== undefined ? { quickProfile: parsed.value.villain.quickProfile } : {}),
    ...(parsed.value.villain.playerId !== undefined ? { playerId: parsed.value.villain.playerId } : {}),
  });
  const decisionEffectiveBB = built.context.math.effectiveStack / st.bigBlindBB;
  const primary = primaryOpponentPosition(st);
  line(`  适配器首要对手位置=${String(primary)}（= contextBuilder 的 opponents[0]）`);
  line(`  决策引擎 math.effectiveStack=${built.context.math.effectiveStack} 筹码 = ${decisionEffectiveBB}BB；SPR=${String(built.context.math.spr)}`);
  line(`  决策引擎可分析？activeOpponentCount=${built.context.activeOpponentCount}（门槛 3）`);
  const screenBB = p.effectiveStackBB ?? NaN;
  verdict(
    Math.abs(decisionEffectiveBB - screenBB) <= 1e-9 ? 'OK' : 'HIT',
    'V-EFF',
    Math.abs(decisionEffectiveBB - screenBB) <= 1e-9
      ? `屏幕与决策引擎的有效筹码一致（${screenBB}BB）`
      : `场景 A：屏幕「有效筹码」=${screenBB}BB，决策引擎实际使用=${decisionEffectiveBB}BB —— 同一个名字两个值`,
  );

  /* ---- 场景 B：面对全下（首要对手已全下）---- */
  let s3 = fullTable(Position.BTN);
  s3 = drive(s3, [
    { kind: 'SET_HERO_CARD', card: 'Ah' },
    { kind: 'SET_HERO_CARD', card: 'Qh' },
  ]);
  const shove = prev(s3).actionButtons.find((b) => b.type === 'ALL_IN');
  if (shove === undefined) {
    verdict('INFO', 'V-EFF-B', '该局面没有 ALL_IN 按钮');
    return;
  }
  s3 = must(actWithButton(s3, shove)); // UTG 全下
  s3 = clickButton(s3, 'FOLD'); // HJ
  s3 = clickButton(s3, 'FOLD'); // CO
  const p3 = prev(s3);
  line('', `  场景 B：UTG 全下后轮到 ${String(p3.currentActorPosition)}（HeroTurn=${p3.isHeroTurn}）活跃对手=${p3.activeOpponentCount}`);
  line(`  屏幕 preview.effectiveStackBB=${String(p3.effectiveStackBB)}BB；座位剩余=${JSON.stringify(p3.remainingStacksBB)}`);
  const a3 = tableStateToManualHandInput(s3);
  if (a3.ok) {
    const parsed3 = parseManualInput(a3.input);
    if (parsed3.ok) {
      const gate3 = buildAnalyzableState(parsed3.value);
      if (gate3.ok) {
        const built3 = contextOf(gate3.state, {
          ...(parsed3.value.villain.quickProfile !== undefined ? { quickProfile: parsed3.value.villain.quickProfile } : {}),
          ...(parsed3.value.villain.playerId !== undefined ? { playerId: parsed3.value.villain.playerId } : {}),
        });
        const effBB3 = built3.context.math.effectiveStack / s3.bigBlindBB;
        line(`  决策引擎 math.effectiveStack=${built3.context.math.effectiveStack} 筹码 = ${effBB3}BB；SPR=${String(built3.context.math.spr)}`);
        const run = analyzeManualHand(a3.input, { rules: RULES, asOf: 1_757_000_000_000, writeLog: false });
        if (run.ok) {
          const mathRows = (run.viewModel.debug?.math ?? []).filter((r: any) => /有效筹码|SPR|底池/.test(String(r.label ?? r.key ?? '')));
          line(`  分析结果 debug.math 行：${JSON.stringify(mathRows)}`);
          line(`  分析建议=${run.viewModel.actionZh} 置信度=${run.viewModel.confidenceZh}`);
        } else {
          line(`  分析未出结果：stage=${run.stage} ${JSON.stringify(run.issues.map((i) => i.code))}`);
        }
        verdict(
          Math.abs(effBB3 - (p3.effectiveStackBB ?? NaN)) <= 1e-9 ? 'OK' : 'HIT',
          'V-EFF-B',
          `场景 B：屏幕「有效筹码」=${String(p3.effectiveStackBB)}BB，决策引擎实际使用=${effBB3}BB`,
        );
      }
    }
  }
}

/* ============================================================
 * 向量 14/15：跨手泄漏 / NEW_TABLE
 * ============================================================ */

function leakage(): void {
  section('向量 14/15：上一手残留、NEW_TABLE、离桌玩家是否仍被发牌');

  let st = fullTable(Position.BTN);
  st = must(
    applyTableOp(st, { kind: 'SET_STACK', seatId: seatOfPosition(st, Position.HJ)!.seatId, stackBB: 40 }),
  );
  st = must(
    applyTableOp(st, {
      kind: 'SET_PROFILE',
      seatId: seatOfPosition(st, Position.UTG)!.seatId,
      quickProfile: 'CALLING_STATION',
    }),
  );
  st = must(
    applyTableOp(st, {
      kind: 'SET_DYNAMIC_HINT',
      seatId: seatOfPosition(st, Position.UTG)!.seatId,
      dynamicHint: 'TILT_SIGNAL',
    }),
  );
  st = drive(st, [
    { kind: 'SET_HERO_CARD', card: 'Ah' },
    { kind: 'SET_HERO_CARD', card: 'Qh' },
  ]);
  st = clickButton(st, 'FOLD'); // UTG
  st = clickButton(st, 'CALL'); // HJ
  st = clickButton(st, 'FOLD'); // CO
  st = clickButton(st, 'CALL'); // BTN = Hero
  st = clickButton(st, 'FOLD'); // SB
  st = clickButton(st, 'CHECK'); // BB
  st = drive(st, [
    { kind: 'SET_BOARD_CARD', card: 'Kh', slot: 0 },
    { kind: 'SET_BOARD_CARD', card: '7c', slot: 1 },
    { kind: 'SET_BOARD_CARD', card: '2d', slot: 2 },
  ]);
  st = clickButton(st, 'CHECK'); // BB
  st = clickButton(st, 'CHECK'); // HJ
  st = clickButton(st, 'CHECK'); // Hero
  st = drive(st, [{ kind: 'SET_BOARD_CARD', card: '9s', slot: 3 }]);

  const beforeNext = st;
  line(`  第 1 手打到转牌：街头=${prev(st).streetZh} 底池=${prev(st).potBB}BB 历史=${st.actionHistory.length} 条`);

  const nh = must(applyTableOp(st, { kind: 'NEXT_HAND' }));
  const rows: readonly (readonly [string, unknown, unknown])[] = [
    ['heroCards', JSON.stringify(beforeNext.heroCards), JSON.stringify(nh.heroCards)],
    ['board', JSON.stringify(beforeNext.board), JSON.stringify(nh.board)],
    ['actionHistory', beforeNext.actionHistory.length, nh.actionHistory.length],
    ['handActive', beforeNext.handActive, nh.handActive],
    ['tableId', beforeNext.tableId, nh.tableId],
    ['heroPosition', beforeNext.heroPosition, nh.heroPosition],
    ['environment', beforeNext.environment, nh.environment],
    ['座位状态', beforeNext.seats.map((s) => s.status).join(','), nh.seats.map((s) => s.status).join(',')],
    ['座位筹码', beforeNext.seats.map((s) => s.stackBB).join(','), nh.seats.map((s) => s.stackBB).join(',')],
    ['玩家对象数', Object.keys(beforeNext.playersById).length, Object.keys(nh.playersById).length],
    ['UTG 画像', beforeNext.playersById['p2']?.quickProfile, nh.playersById['p2']?.quickProfile],
  ];
  for (const [k, a, b] of rows) line(`      ${String(k).padEnd(14)} 上一手=${String(a)}  下一手=${String(b)}`);
  const leak =
    nh.heroCards.length !== 0 ||
    nh.board.length !== 0 ||
    nh.actionHistory.length !== 0 ||
    nh.handActive !== false ||
    nh.seats.some((s) => s.status !== 'SEATED_ACTIVE') ||
    nh.tableId !== beforeNext.tableId ||
    nh.heroPosition !== beforeNext.heroPosition;
  verdict(leak ? 'HIT' : 'OK', 'V14a', `NEXT_HAND 清理矩阵：${leak ? '存在残留' : '手牌/公共牌/历史/弃牌全下状态全部清空，座位绑定与画像保留'}`);
  line(`      下一手提示=${JSON.stringify(nh.notices)}`);

  // --- 离桌（LEAVE_AFTER_HAND）后 RESET_HAND ---
  let lv = fullTable(Position.BTN);
  lv = drive(lv, [
    { kind: 'SET_HERO_CARD', card: 'Ah' },
    { kind: 'SET_HERO_CARD', card: 'Qh' },
  ]);
  lv = clickButton(lv, 'CALL'); // UTG 平跟 → 本手已开始
  const utgSeatId = seatOfPosition(lv, Position.UTG)!.seatId;
  const marked = applyTableOp(lv, {
    kind: 'CLEAR_SEAT',
    seatId: utgSeatId,
    activeHandChoice: ActiveHandLeaveChoice.LEAVE_AFTER_HAND,
  });
  line('', `  标记 UTG「手后离桌」：ok=${marked.ok}`);
  if (marked.ok) {
    lv = marked.state;
    const reset = must(applyTableOp(lv, { kind: 'RESET_HAND' }));
    const seatAfterReset = seatOfPosition(reset, Position.UTG)!;
    line(`  RESET_HAND 后 UTG 座位：status=${seatAfterReset.status} playerId=${String(seatAfterReset.playerId)} handActive=${reset.handActive}`);
    const rp = prev(reset);
    line(`  预览：ok=${rp.ok} canAnalyze=${rp.canAnalyze} 阻塞项=${JSON.stringify(rp.analyzeBlockers)}`);
    const rv = engineViewOf(reset);
    const seatView = rp.seats.find((s) => s.logicalPosition === Position.UTG)!;
    line(`  屏幕上 UTG 显示：statusZh=${seatView.statusZh}`);
    if (rv.ok) {
      const utgEngine = rv.engine.players.find((p) => p.position === Position.UTG)!;
      line(`  引擎仍把 UTG 算进这一手：folded=${utgEngine.folded} startingStack=${utgEngine.startingStack}（staffingProblems=${JSON.stringify(staffingProblems(reset))}）`);
      verdict(
        rp.ok ? 'HIT' : 'OK',
        'V14b',
        rp.ok
          ? `RESET_HAND 后离桌意图被遗忘：屏幕显示「${seatView.statusZh}」，后端却仍把他当作本手在场玩家（计入底池/有效筹码/活跃对手）`
          : '离桌玩家被安全拒绝',
      );
    }
    const afterNext = must(applyTableOp(lv, { kind: 'NEXT_HAND' }));
    const utgAfterNext = seatOfPosition(afterNext, Position.UTG)!;
    verdict(
      utgAfterNext.playerId === null ? 'OK' : 'HIT',
      'V14c',
      `对照：NEXT_HAND 后 UTG 座位 playerId=${String(utgAfterNext.playerId)} status=${utgAfterNext.status}（离桌在这里才生效）`,
    );
  }

  // --- NEW_TABLE ---
  const nt = must(applyTableOp(beforeNext, { kind: 'NEW_TABLE' }));
  line('', `  NEW_TABLE：playersById keys=${JSON.stringify(Object.keys(nt.playersById))}`);
  line(`  NEW_TABLE：座位=${JSON.stringify(nt.seats.map((s) => [s.logicalPosition, s.playerId, s.status, s.stackBB]))}`);
  line(`  NEW_TABLE：heroCards=${JSON.stringify(nt.heroCards)} board=${JSON.stringify(nt.board)} 历史=${nt.actionHistory.length} handActive=${nt.handActive} nextPlayerNumber=${nt.nextPlayerNumber}`);
  const ntClean =
    Object.keys(nt.playersById).length === 1 &&
    nt.seats.filter((s) => s.playerId !== null).length === 1 &&
    nt.heroCards.length === 0 &&
    nt.board.length === 0 &&
    nt.actionHistory.length === 0 &&
    nt.handActive === false;
  const villainProfilesGone = !Object.values(nt.playersById).some(
    (p) => !p.isHero && (p.quickProfile !== 'UNKNOWN' || p.dynamicHint !== 'UNKNOWN'),
  );
  verdict(
    ntClean && villainProfilesGone ? 'OK' : 'HIT',
    'V15a',
    `NEW_TABLE 清空其他座位与全部 Villain 画像/动态：${ntClean && villainProfilesGone}`,
  );
  line(`  NEW_TABLE 后撤销栈深度=${nt.undo.length}`);
  const un = applyTableOp(nt, { kind: 'UNDO' });
  if (un.ok) {
    const villainsBack = Object.keys(un.state.playersById).length;
    verdict(
      'INFO',
      'V15b',
      `NEW_TABLE 之后 UNDO 恢复了 ${villainsBack} 个玩家对象（撤销栈刻意保留旧牌桌；若要「清干净」需先丢弃撤销栈）`,
    );
  }
}

/* ============================================================
 * seatStacksBB
 * ============================================================ */

function seatStacks(): void {
  section('seatStacksBB：完整性、缺位置回退、逐座位不同筹码');

  const st = drive(fullTable(Position.CO, 100), [
    { kind: 'SET_HERO_CARD', card: 'As' },
    { kind: 'SET_HERO_CARD', card: 'Kd' },
  ]);
  const r = tableStateToManualHandInput(st);
  if (!r.ok) {
    verdict('HIT', 'V-STACK-a', '适配失败');
    return;
  }
  line(`  6 人桌全座：seatStacksBB=${JSON.stringify(r.input.seatStacksBB)}`);
  const keys = Object.keys(r.input.seatStacksBB).sort();
  verdict(
    keys.length === 6 ? 'OK' : 'HIT',
    'V-STACK-a',
    `适配器写入的位置数=${keys.length}（${keys.join(',')}）—— 全座时完整`,
  );

  let diff = fullTable(Position.CO, 100);
  diff = must(applyTableOp(diff, { kind: 'SET_STACK', seatId: seatOfPosition(diff, Position.UTG)!.seatId, stackBB: 42 }));
  diff = must(applyTableOp(diff, { kind: 'SET_STACK', seatId: seatOfPosition(diff, Position.BB)!.seatId, stackBB: 7.5 }));
  const view = engineViewOf(diff);
  if (view.ok) {
    const stacks = view.engine.players.map((p) => [p.position, p.startingStack / diff.bigBlindBB]);
    line(`  引擎起始筹码（BB）=${JSON.stringify(stacks)}`);
    const ok =
      stacks.find((x) => x[0] === Position.UTG)![1] === 42 &&
      stacks.find((x) => x[0] === Position.BB)![1] === 7.5;
    verdict(ok ? 'OK' : 'HIT', 'V-STACK-b', '逐座位筹码按位置准确生效（UTG=42BB，BB=7.5BB）');
  }

  const partial: ManualHandInput = {
    ...r.input,
    seatStacksBB: {
      [Position.UTG]: 42,
      [Position.HJ]: 100,
      [Position.CO]: 100,
      [Position.BTN]: 100,
      [Position.SB]: 100,
      // BB 故意省略
    },
  };
  const parsed = parseManualInput(partial);
  if (parsed.ok) {
    const gate = buildAnalyzableState(parsed.value);
    if (gate.ok) {
      const bbStack = gate.state.players.find((p) => p.position === Position.BB)!.startingStack / 100;
      verdict(
        'INFO',
        'V-STACK-c',
        `省略某个位置时**静默回退**到 effectiveStackBB（BB=${bbStack}BB），不报错 —— 牌桌适配器总是写满，UI 路径不受影响`,
      );
    }
  } else {
    verdict('OK', 'V-STACK-c', `缺位置被解析层拒绝：${JSON.stringify(parsed.issues.map((i) => i.field))}`);
  }
}

/* ============================================================
 * 空座位 / 暂离
 * ============================================================ */

function degenerateStates(): void {
  section('空座位 / 暂离：必须干净拒绝（不崩、不静默发牌）');

  const empty = createTable({ tableSize: 6, heroPosition: Position.BTN });
  const p = prev(empty);
  line(`  空桌：ok=${p.ok} canAnalyze=${p.canAnalyze} 阻塞项=${JSON.stringify(p.analyzeBlockers)}`);
  verdict(
    !p.ok && p.currentActorPosition === null && p.potBB === 0 ? 'OK' : 'HIT',
    'V-SIT-a',
    '只有 Hero 时预览干净拒绝（ok=false、无行动者、底池 0）',
  );

  let sit = fullTable(Position.BTN);
  sit = must(applyTableOp(sit, { kind: 'SIT_OUT', seatId: seatOfPosition(sit, Position.UTG)!.seatId }));
  sit = drive(sit, [
    { kind: 'SET_HERO_CARD', card: 'As' },
    { kind: 'SET_HERO_CARD', card: 'Kd' },
  ]);
  const ps = prev(sit);
  line(`  暂离：ok=${ps.ok} canAnalyze=${ps.canAnalyze} 按钮数=${ps.actionButtons.length} 阻塞项=${JSON.stringify(ps.analyzeBlockers)}`);
  verdict(
    !ps.ok && ps.actionButtons.length === 0 && !ps.canAnalyze ? 'OK' : 'HIT',
    'V-SIT-b',
    '暂离座位 → 拒绝分析、不提供任何动作按钮',
  );
  const adapted = tableStateToManualHandInput(sit);
  verdict(
    adapted.ok === false ? 'OK' : 'HIT',
    'V-SIT-c',
    `暂离状态下适配器返回失败：${adapted.ok ? '仍返回 ok(!)' : JSON.stringify(adapted.issues.map((i) => i.code))}`,
  );

  let both = fullTable(Position.BTN);
  both = must(applyTableOp(both, { kind: 'SIT_OUT', seatId: seatOfPosition(both, Position.UTG)!.seatId }));
  both = must(applyTableOp(both, { kind: 'CLEAR_SEAT', seatId: seatOfPosition(both, Position.HJ)!.seatId }));
  const pb = prev(both);
  line(`  暂离+空座：阻塞项=${JSON.stringify(pb.analyzeBlockers)}`);
  verdict(
    pb.analyzeBlockers.length === new Set(pb.analyzeBlockers).size ? 'OK' : 'HIT',
    'V-SIT-d',
    '阻塞原因去重（同一条原因不显示两遍）',
  );
}

/* ============================================================
 * 畸形 HTTP 载荷
 * ============================================================ */

async function malformed(base: string): Promise<void> {
  section('畸形载荷：不得 500、不得半应用（真实 HTTP）');

  const post = async (body: unknown): Promise<{ status: number; json: any }> => {
    const res = await fetch(`${base}/api/table`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    let json: any = null;
    try {
      json = await res.json();
    } catch {
      json = { parseError: true };
    }
    return { status: res.status, json };
  };

  const created = await post({ tableSize: 6, heroPosition: 'BTN' });
  let st = created.json.state as PokerTableState;
  for (const position of ORDER_6) {
    if (position === Position.BTN) continue;
    st = (await post({ state: st, op: { kind: 'ADD_PLAYER', seatId: `seat_${position}` } })).json.state;
  }
  st = (await post({ state: st, op: { kind: 'SET_HERO_CARD', card: 'As' } })).json.state;
  st = (await post({ state: st, op: { kind: 'SET_HERO_CARD', card: 'Kd' } })).json.state;
  // 让本手真正开始（有行动台账），这样「伪造 handActive」这类案例才有意义
  st = (await post({ state: st, op: { kind: 'ACT', action: { type: 'FOLD' } } })).json.state;
  st = (await post({ state: st, op: { kind: 'ACT', action: { type: 'FOLD' } } })).json.state;

  /**
   * 每一条案例都基于**当前最新状态**（否则会被水位线以 STALE_REVISION 挡掉，
   * 掩盖真正要测的那条校验）。被接受的案例会把返回状态提升为新的光标。
   */
  const cases: readonly { name: string; make: (base: PokerTableState) => unknown }[] = [
    { name: 'null 载荷', make: () => null },
    { name: '数组载荷', make: () => [1, 2, 3] },
    { name: '字符串载荷', make: () => '"hello"' },
    { name: '空对象（无 state → 新建牌桌）', make: () => ({}) },
    { name: 'state=null', make: () => ({ state: null, op: { kind: 'ACT', action: { type: 'FOLD' } } }) },
    { name: 'state=字符串', make: () => ({ state: 'x', op: { kind: 'UNDO' } }) },
    { name: '未知 op', make: (b) => ({ state: b, op: { kind: 'DROP_TABLE' } }) },
    { name: 'op 是数组', make: (b) => ({ state: b, op: [] }) },
    { name: 'op 缺 kind', make: (b) => ({ state: b, op: { seatId: 'seat_UTG' } }) },
    { name: 'ACT 无 action', make: (b) => ({ state: b, op: { kind: 'ACT' } }) },
    { name: 'ACT action=null', make: (b) => ({ state: b, op: { kind: 'ACT', action: null } }) },
    { name: 'ACT 未知类型', make: (b) => ({ state: b, op: { kind: 'ACT', action: { type: 'TELEPORT' } } }) },
    { name: 'ACT RAISE 负金额', make: (b) => ({ state: b, op: { kind: 'ACT', action: { type: 'RAISE', amountChips: -999 } } }) },
    { name: 'ACT RAISE 字符串金额', make: (b) => ({ state: b, op: { kind: 'ACT', action: { type: 'RAISE', amountChips: '500' } } }) },
    { name: 'ACT RAISE 数组金额', make: (b) => ({ state: b, op: { kind: 'ACT', action: { type: 'RAISE', amountChips: [500] } } }) },
    { name: 'ACT CALL 0', make: (b) => ({ state: b, op: { kind: 'ACT', action: { type: 'CALL', amountChips: 0 } } }) },
    { name: 'ACT ALL_IN 1', make: (b) => ({ state: b, op: { kind: 'ACT', action: { type: 'ALL_IN', amountChips: 1 } } }) },
    { name: 'ACT CHECK 带金额', make: (b) => ({ state: b, op: { kind: 'ACT', action: { type: 'CHECK', amountChips: 500 } } }) },
    { name: 'SET_BOARD_CARD 非法牌面', make: (b) => ({ state: b, op: { kind: 'SET_BOARD_CARD', card: 'Zz', slot: 0 } }) },
    { name: 'SET_BOARD_CARD 数字牌面', make: (b) => ({ state: b, op: { kind: 'SET_BOARD_CARD', card: 123, slot: 0 } }) },
    { name: 'SET_STACK null', make: (b) => ({ state: b, op: { kind: 'SET_STACK', seatId: 'seat_UTG', stackBB: null } }) },
    { name: 'SET_STACK 字符串', make: (b) => ({ state: b, op: { kind: 'SET_STACK', seatId: 'seat_UTG', stackBB: '500' } }) },
    { name: 'seats 少一个', make: (b) => ({ state: { ...b, seats: b.seats.slice(1) }, op: { kind: 'UNDO' } }) },
    { name: '座位位置重复', make: (b) => ({ state: { ...b, seats: b.seats.map((s, i) => (i === 0 ? { ...s, logicalPosition: b.seats[1]!.logicalPosition } : s)) }, op: { kind: 'UNDO' } }) },
    { name: 'visualIndex 重复', make: (b) => ({ state: { ...b, seats: b.seats.map((s, i) => (i === 0 ? { ...s, visualIndex: b.seats[1]!.visualIndex } : s)) }, op: { kind: 'UNDO' } }) },
    { name: 'visualIndex 整体偏移 3', make: (b) => ({ state: { ...b, seats: b.seats.map((s) => ({ ...s, visualIndex: (s.visualIndex + 3) % 6 })) }, op: { kind: 'SET_DYNAMIC_HINT', seatId: 'seat_UTG', dynamicHint: 'NORMAL' } }) },
    { name: 'heroCards 三张', make: (b) => ({ state: { ...b, heroCards: ['As', 'Kd', 'Qh'] }, op: { kind: 'SET_BOARD_CARD', card: '2c', slot: 0 } }) },
    { name: 'board 含空串', make: (b) => ({ state: { ...b, board: ['', 'Ks', 'Qd'] }, op: { kind: 'SET_DYNAMIC_HINT', seatId: 'seat_UTG', dynamicHint: 'NORMAL' } }) },
    { name: 'board 重复牌', make: (b) => ({ state: { ...b, board: ['Ks', 'Ks', 'Qd'] }, op: { kind: 'SET_DYNAMIC_HINT', seatId: 'seat_UTG', dynamicHint: 'NORMAL' } }) },
    { name: 'bigBlindBB=2', make: (b) => ({ state: { ...b, bigBlindBB: 2 }, op: { kind: 'SET_DYNAMIC_HINT', seatId: 'seat_UTG', dynamicHint: 'NORMAL' } }) },
    { name: 'bigBlindBB=0', make: (b) => ({ state: { ...b, bigBlindBB: 0 }, op: { kind: 'SET_DYNAMIC_HINT', seatId: 'seat_UTG', dynamicHint: 'NORMAL' } }) },
    { name: 'undo 塞伪造快照', make: (b) => ({ state: { ...b, undo: [{ ...b, revision: 999, actionHistory: [], heroCards: [], board: [] }] }, op: { kind: 'UNDO' } }) },
    { name: 'undo 塞垃圾', make: (b) => ({ state: { ...b, undo: ['not-a-state'] }, op: { kind: 'UNDO' } }) },
    {
      name: 'undo 61 条（超上限）',
      make: (b) => {
        const core = { ...(b as unknown as Record<string, unknown>) };
        delete core['undo'];
        return { state: { ...core, undo: new Array(61).fill(core) }, op: { kind: 'UNDO' } };
      },
    },
    { name: 'handActive 伪造 false + SET_STACK', make: (b) => ({ state: { ...b, handActive: false }, op: { kind: 'SET_STACK', seatId: 'seat_UTG', stackBB: 500 } }) },
    { name: 'handActive 伪造 false + CLEAR_ALL_VILLAINS', make: (b) => ({ state: { ...b, handActive: false }, op: { kind: 'CLEAR_ALL_VILLAINS' } }) },
    { name: '坏 JSON', make: () => '{not json' },
  ];

  let status500 = 0;
  let accepted = 0;
  let transportError = 0;
  let cursor = st;
  for (const c of cases) {
    const body = c.make(cursor);
    let r: { status: number; json: any };
    try {
      r = await post(body);
    } catch (error) {
      transportError += 1;
      line(`  ${c.name.padEnd(40)} 传输层错误：${(error as Error).message}`);
      continue;
    }
    if (r.status >= 500) status500 += 1;
    const okFlag = r.json?.ok;
    const code = r.json?.issues?.[0]?.code ?? (okFlag === true ? 'ACCEPTED' : '?');
    line(`  ${c.name.padEnd(40)} status=${r.status} ok=${String(okFlag)} code=${String(code)}`);
    if (okFlag === true && r.json.state) {
      accepted += 1;
      const hist = r.json.state.actionHistory.length;
      const seatStacks = r.json.state.seats.map((s: any) => s.stackBB).join(',');
      line(`      ⚠ 被接受：revision ${cursor.revision}→${r.json.state.revision} 历史长度=${hist} 座位筹码=[${seatStacks}] 预览ok=${String(r.json.preview?.ok)} 预览阻塞=${JSON.stringify(r.json.preview?.analyzeBlockers ?? [])}`);
      // 新建牌桌（created=true）会把光标换到另一张桌子，后续案例必须继续用原桌子
      if (r.json.created !== true && r.json.state.tableId === cursor.tableId) {
        cursor = r.json.state as PokerTableState;
      }
    }
  }
  verdict(status500 === 0 ? 'OK' : 'HIT', 'V-MAL-a', `畸形载荷共 ${cases.length} 例，HTTP 5xx 数量=${status500}，传输层错误=${transportError}`);
  verdict('INFO', 'V-MAL-b', `畸形载荷中被**接受**的例数=${accepted}（逐条见上；「客户端自持状态」是设计前提，但被接受的每一条都要能自洽）`);
}

/* ============================================================
 * meta 与前端硬编码
 * ============================================================ */

async function metaCheck(base: string): Promise<void> {
  section('GET /api/table/meta 与前端硬编码枚举');

  const res = await fetch(`${base}/api/table/meta`);
  const payload: any = await res.json();
  const meta = payload.meta;
  line(`  条目数：positions=${meta.positions.length} tableSizes=${meta.tableSizes.length} seatStatuses=${meta.seatStatuses.length} quickProfiles=${meta.quickProfiles.length} dynamicHints=${meta.dynamicHints.length} environments=${meta.environments.length} actionTypes=${meta.actionTypes.length} streets=${meta.streets.length} leaveChoices=${meta.leaveChoices.length}`);
  line(`  quickProfiles=${meta.quickProfiles.map((x: any) => x.value).join(',')}`);
  line(`  streets=${meta.streets.map((x: any) => x.value).join(',')} actionTypes=${meta.actionTypes.map((x: any) => x.value).join(',')}`);
  line(`  leaveChoices=${meta.leaveChoices.map((x: any) => `${x.value}(${x.labelZh})`).join(' / ')}`);

  let st = fullTable(Position.BTN);
  const badProfiles: string[] = [];
  for (const p of meta.quickProfiles) {
    const r = applyTableOp(st, {
      kind: 'SET_PROFILE',
      seatId: seatOfPosition(st, Position.UTG)!.seatId,
      quickProfile: p.value,
    });
    if (!r.ok) badProfiles.push(p.value);
  }
  verdict(
    badProfiles.length === 0 ? 'OK' : 'HIT',
    'V-META-a',
    `meta.quickProfiles 全部被 SET_PROFILE 接受（${meta.quickProfiles.length} 项）${badProfiles.length ? '，拒绝：' + badProfiles.join(',') : ''}`,
  );

  const positions6 = new Set<string>(meta.tableSizes.find((s: any) => s.value === 6).positions);
  const badPositions: string[] = [];
  for (const p of meta.positions) {
    if (!positions6.has(p.value)) continue;
    const r = applyTableOp(st, { kind: 'SET_HERO_POSITION', position: p.value });
    if (!r.ok) badPositions.push(p.value);
    else st = r.state;
  }
  verdict(
    badPositions.length === 0 ? 'OK' : 'HIT',
    'V-META-b',
    `6 人桌位置全部被 SET_HERO_POSITION 接受（${[...positions6].join(',')}）`,
  );

  const abs = fileURLToPath(new URL('../src/app/web/table.js', import.meta.url));
  const src = readFileSync(abs, 'utf8');
  const hardcoded: string[] = [];
  for (const lit of ['LEAVING_AFTER_HAND', 'SITTING_OUT', 'FOLD_AND_LEAVE', 'LEAVE_AFTER_HAND', 'CANCEL', 'PREFLOP', 'PRIMARY', 'SIZE']) {
    const count = src.split(`'${lit}'`).length - 1;
    if (count > 0) hardcoded.push(`${lit}×${count}`);
  }
  line(`  客户端硬编码枚举字面量：${hardcoded.join(' ')}`);
  const leavesHardcoded = /choice === 'FOLD_AND_LEAVE'/.test(src) && /'仅标记手后离桌'/.test(src);
  verdict(
    leavesHardcoded ? 'HIT' : 'OK',
    'V-META-c',
    leavesHardcoded
      ? 'table.js 自己硬编码了离桌选项与中文标签，而 meta.leaveChoices 已提供同一份数据（后端改文案/加选项时前端会漂移）'
      : '前端未硬编码离桌选项',
  );

  const ruleFns = ['preflopOrder', 'postflopOrder', 'minRaiseTo', 'computePot', 'isUnopenedPot', 'requiredCallAmount'];
  const found = ruleFns.filter((f) => new RegExp(`\\b${f}\\b`).test(src));
  verdict(found.length === 0 ? 'OK' : 'HIT', 'V-META-d', `table.js 中出现的牌局规则函数名：${found.join(',') || '（无）'}`);

  const metaKeys = ['positions', 'tableSizes', 'environments', 'quickProfiles', 'dynamicHints', 'streets', 'actionTypes', 'leaveChoices', 'seatStatuses', 'occupiedStatuses'];
  const used = metaKeys.filter((k) => src.includes(`meta.${k}`));
  const unused = metaKeys.filter((k) => !src.includes(`meta.${k}`));
  line(`  客户端消费的 meta 字段：${used.join(',')}`);
  line(`  客户端**未**消费的 meta 字段：${unused.join(',')}`);
  verdict(unused.length === 0 ? 'OK' : 'INFO', 'V-META-e', `未被 table.js 消费的 meta 字段：${unused.join(',') || '（无）'}`);
}

/* ============================================================
 * 性能
 * ============================================================ */

async function perfSection(base: string): Promise<void> {
  section('性能：POST /api/table 延迟');

  const post = async (body: unknown): Promise<any> => {
    const res = await fetch(`${base}/api/table`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.json();
  };

  const created = await post({ tableSize: 6, heroPosition: 'BTN' });
  let st = created.state as PokerTableState;
  for (const position of ORDER_6) {
    if (position === Position.BTN) continue;
    st = (await post({ state: st, op: { kind: 'ADD_PLAYER', seatId: `seat_${position}` } })).state;
  }
  st = (await post({ state: st, op: { kind: 'SET_HERO_CARD', card: 'As' } })).state;
  st = (await post({ state: st, op: { kind: 'SET_HERO_CARD', card: 'Kd' } })).state;

  const stats = (samples: number[]): string => {
    const s = [...samples].sort((a, b) => a - b);
    const pick = (q: number): number => s[Math.min(s.length - 1, Math.floor(s.length * q))]!;
    return `min=${pick(0).toFixed(1)}ms p50=${pick(0.5).toFixed(1)}ms p95=${pick(0.95).toFixed(1)}ms max=${pick(1).toFixed(1)}ms`;
  };

  // 浅状态：满座 + 两张手牌（每次请求都跑完整的 preview 链）
  const shallowSamples: number[] = [];
  let cursor = st;
  for (let i = 0; i < 40; i += 1) {
    const t0 = performance.now();
    const r = await post({
      state: cursor,
      op: { kind: 'SET_DYNAMIC_HINT', seatId: 'seat_UTG', dynamicHint: i % 2 === 0 ? 'NORMAL' : 'TILT_SIGNAL' },
    });
    shallowSamples.push(performance.now() - t0);
    if (r.ok) cursor = r.state;
  }
  line(`  浅状态（满座+手牌，40 次 SET_DYNAMIC_HINT）：${stats(shallowSamples)}`);

  // 深状态：一路过牌到河牌（每一步都点预览给出的按钮，payload 与浏览器一致）
  let deep = fullTable(Position.BTN);
  deep = must(applyTableOp(deep, { kind: 'SET_HERO_CARD', card: 'Ah' }));
  deep = must(applyTableOp(deep, { kind: 'SET_HERO_CARD', card: 'Qh' }));
  const boardCards = ['Kh', '7c', '2d', '9s', '3h'];
  for (let i = 0; i < 80; i += 1) {
    const p = prev(deep);
    if (p.currentActorPosition === null) {
      const nextCard = boardCards[deep.board.length];
      if (nextCard === undefined) break;
      const r = applyTableOp(deep, { kind: 'SET_BOARD_CARD', card: nextCard, slot: deep.board.length });
      if (!r.ok) break;
      deep = r.state;
      continue;
    }
    const button =
      p.actionButtons.find((b) => b.type === 'CHECK') ??
      p.actionButtons.find((b) => b.type === 'CALL') ??
      p.actionButtons.find((b) => b.type === 'FOLD');
    if (button === undefined) break;
    const r = actWithButton(deep, button);
    if (!r.ok) break;
    deep = r.state;
  }
  line(`  深状态：历史=${deep.actionHistory.length} 条 公共牌=${deep.board.length} 张 街道=${prev(deep).streetZh} handComplete=${prev(deep).handComplete}`);

  const bodyOf = (s: PokerTableState): number =>
    Buffer.byteLength(
      JSON.stringify({ state: s, op: { kind: 'SET_DYNAMIC_HINT', seatId: 'seat_UTG', dynamicHint: 'NORMAL' } }),
      'utf8',
    );
  const capBytes = ((): number => {
    const src = readFileSync(fileURLToPath(new URL('../src/app/webServer.ts', import.meta.url)), 'utf8');
    const match = /const MAX_BODY_BYTES = ([^;]+);/.exec(src);
    if (match === null) return -1;
    const expr = match[1]!.trim();
    const product = /^(\d+)\s*\*\s*(\d+)$/.exec(expr);
    if (product !== null) return Number(product[1]) * Number(product[2]);
    return Number(expr);
  })();
  line(`  深状态请求体大小 = ${(bodyOf(deep) / 1024).toFixed(1)} KB（服务端上限 ${(capBytes / 1024).toFixed(0)} KB，见 webServer.ts 的 MAX_BODY_BYTES）`);
  line(`  深状态构成：历史 ${deep.actionHistory.length} 条 + 撤销栈 ${deep.undo.length} 层`);

  const deepSamples: number[] = [];
  let deepCursor = deep;
  for (let i = 0; i < 20; i += 1) {
    const t0 = performance.now();
    const op = {
      kind: 'SET_DYNAMIC_HINT',
      seatId: 'seat_UTG',
      dynamicHint: i % 2 === 0 ? 'NORMAL' : 'TILT_SIGNAL',
    } as const;
    let r: any = null;
    try {
      r = await post({ state: deepCursor, op });
    } catch {
      // 之前那条「被服务端销毁的连接」可能让池里的 socket 失效一次 → 重试一次以区分
      try {
        r = await post({ state: deepCursor, op });
      } catch (error) {
        line(
          `  深状态请求第 ${i + 1} 次失败（重试后仍失败，已采样 ${deepSamples.length} 次）：${(error as Error).message}` +
            `；此时请求体 ${(bodyOf(deepCursor) / 1024).toFixed(1)}KB，撤销栈 ${deepCursor.undo.length} 层`,
        );
        break;
      }
    }
    deepSamples.push(performance.now() - t0);
    if (r.ok) deepCursor = r.state;
  }
  line(`  深状态（20 次 SET_DYNAMIC_HINT）：${stats(deepSamples)}`);

  // ---- 显式超限：构造一个 >128KB 的请求体，看服务端怎么处理 ----
  const huge = { ...deep, notices: ['x'.repeat(140 * 1024)] };
  const hugeBytes = Buffer.byteLength(
    JSON.stringify({ state: huge, op: { kind: 'UNDO' } }),
    'utf8',
  );
  try {
    const r = await post({ state: huge, op: { kind: 'UNDO' } });
    verdict(
      'INFO',
      'V-SIZE',
      `超过旧上限（${(hugeBytes / 1024).toFixed(0)}KB）的请求体得到结构化响应 ok=${String(r.ok)}（上限已提到 ${(capBytes / 1024).toFixed(0)}KB）`,
    );
  } catch (error) {
    verdict(
      'HIT',
      'V-SIZE',
      `请求体 ${(hugeBytes / 1024).toFixed(0)}KB 超过 MAX_BODY_BYTES(${(capBytes / 1024).toFixed(0)}KB) → 服务端**销毁连接**，客户端只看到网络错误「${(error as Error).message}」，没有任何结构化原因；` +
        `而深状态（一手 24 条行动 + 36 层撤销栈）本身已经 ${(bodyOf(deep) / 1024).toFixed(1)}KB`,
    );
  }
  // 超限之后普通请求是否仍可用（对照）
  const afterHuge = await post({
    state: deepCursor,
    op: { kind: 'SET_DYNAMIC_HINT', seatId: 'seat_HJ', dynamicHint: 'NORMAL' },
  }).catch((error: Error) => ({ ok: false, issues: [{ message: (error as Error).message }] }) as never);
  line(`  超限之后的小请求：ok=${String((afterHuge as { ok?: boolean }).ok)}（连接池未损坏）`);

  const worst = Math.max(...shallowSamples, ...(deepSamples.length > 0 ? deepSamples : [0]));
  verdict(worst < 100 ? 'OK' : 'HIT', 'V-PERF', `最慢一次 POST /api/table = ${worst.toFixed(1)}ms（目标 <100ms）`);
}

/* ============================================================
 * 主流程
 * ============================================================ */

let server: AlphaServer | null = null;

async function main(): Promise<void> {
  snapshot();

  guard('V10', vector10Cards);
  guard('V11', vector11Visual);
  guard('V90', tripleAgreement);
  guard('V-EFF', effectiveStackDivergence);
  guard('V-LEAK', leakage);
  guard('V-STACK', seatStacks);
  guard('V-SIT', degenerateStates);
  guard('V27', offeredButtonProperty);
  guard('V-ALLIN', allInFocus);

  server = await startAlphaServer({ port: 0, logPath: null });
  const base = server.url;
  line('', `HTTP 服务已启动：${base}`);

  await guardAsync('V12/13', () => races(base));
  await guardAsync('V-MAL', () => malformed(base));
  await guardAsync('V-META', () => metaCheck(base));
  await guardAsync('V-PERF', () => perfSection(base));

  section('汇总');
  line(`OK=${counters.OK}  HIT=${counters.HIT}  INFO=${counters.INFO}`);
  line(`预览按钮被后端拒绝：${buttonFailures.length} 个（共试 ${buttonsTried} 个）`);

  const text = OUT.join('\n');
  const outPath = fileURLToPath(new URL('./rt-table-adapter-evidence.txt', import.meta.url));
  writeFileSync(outPath, text, 'utf8');
  process.stdout.write(text + '\n');
  process.stdout.write(`\n[证据已写入] ${outPath}\n`);
}

void races;

async function races(base: string): Promise<void> {
  section('向量 12/13：陈旧响应、重复提交、RevisionGuard（真实 HTTP）');

  const post = async (body: unknown): Promise<{ status: number; json: any }> => {
    const res = await fetch(`${base}/api/table`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  };

  const created = await post({ tableSize: 6, heroPosition: 'BTN' });
  let st = created.json.state as PokerTableState;
  line(`  建桌：status=${created.status} tableId=${st.tableId} revision=${st.revision}`);
  for (const position of ORDER_6) {
    if (position === Position.BTN) continue;
    const r = await post({ state: st, op: { kind: 'ADD_PLAYER', seatId: `seat_${position}` } });
    if (!r.json.ok) {
      verdict('HIT', 'V13-add', `加入 ${position} 失败：${JSON.stringify(r.json.issues)}`);
      return;
    }
    st = r.json.state;
  }
  st = (await post({ state: st, op: { kind: 'SET_HERO_CARD', card: 'As' } })).json.state;
  st = (await post({ state: st, op: { kind: 'SET_HERO_CARD', card: 'Kd' } })).json.state;
  line(`  准备完毕：revision=${st.revision}`);

  // 13a：同一 revision 的两个并发请求（双击 / 两个在途请求）
  const [a, b] = await Promise.all([
    post({ state: st, op: { kind: 'ACT', action: { type: 'FOLD' } } }),
    post({ state: st, op: { kind: 'ACT', action: { type: 'FOLD' } } }),
  ]);
  const oks = [a, b].filter((r) => r.json.ok).length;
  const stale = [a, b].filter((r) => !r.json.ok && r.json.issues[0]?.code === 'STALE_REVISION').length;
  line(`  并发同版本：ok=${oks} stale=${stale} status=${a.status}/${b.status} 码=${JSON.stringify([a.json.issues?.[0]?.code ?? 'ok', b.json.issues?.[0]?.code ?? 'ok'])}`);
  verdict(
    oks === 1 && stale === 1 && a.status === 200 && b.status === 200 ? 'OK' : 'HIT',
    'V13a',
    `并发同版本请求：恰好 1 个被应用（ok=${oks}, stale=${stale}），HTTP 200 无 500`,
  );

  const applied = [a, b].find((r) => r.json.ok)!;
  const stAfter = applied.json.state as PokerTableState;
  line(`  被应用后的 revision=${stAfter.revision} 历史长度=${stAfter.actionHistory.length}（请求前 ${st.actionHistory.length}）`);
  verdict(
    stAfter.actionHistory.length === st.actionHistory.length + 1 ? 'OK' : 'HIT',
    'V13a2',
    `行动历史恰好 +1（没有重复落账）：${st.actionHistory.length} → ${stAfter.actionHistory.length}`,
  );

  // 12a：迟到的旧请求
  const late = await post({ state: st, op: { kind: 'ACT', action: { type: 'FOLD' } } });
  line(`  旧版本（revision=${st.revision}）请求：ok=${late.json.ok} code=${late.json.issues?.[0]?.code} 回传 state.revision=${late.json.state?.revision} preview.revision=${late.json.preview?.revision}`);
  verdict(
    late.json.ok === false && late.json.issues[0].code === 'STALE_REVISION' ? 'OK' : 'HIT',
    'V12a',
    '迟到的旧版本请求被水位线拒绝，且回传的状态与预览都属于旧版本（客户端会丢弃）',
  );
  verdict(
    late.json.state.tableId === stAfter.tableId && late.json.state.revision <= stAfter.revision ? 'OK' : 'HIT',
    'V12b',
    `客户端丢弃判据成立：tableId 相同 且 回传 revision(${late.json.state.revision}) <= 已应用 revision(${stAfter.revision})`,
  );

  // 12c：UNDO 之后 revision 单调递增
  const undone = await post({ state: stAfter, op: { kind: 'UNDO' } });
  line(`  UNDO：ok=${undone.json.ok} revision ${stAfter.revision} → ${undone.json.state.revision}`);
  verdict(
    undone.json.ok && undone.json.state.revision > stAfter.revision ? 'OK' : 'HIT',
    'V12c',
    'UNDO 之后 revision 仍单调递增（客户端单调水位线不会卡住合法撤销）',
  );

  // 13b：非变更 op 保持 revision（用「本手未开始」的状态，避免被 handActive 挡住）
  let fresh = (await post({ tableSize: 6, heroPosition: 'BTN' })).json.state as PokerTableState;
  for (const position of ORDER_6) {
    if (position === Position.BTN) continue;
    fresh = (await post({ state: fresh, op: { kind: 'ADD_PLAYER', seatId: `seat_${position}` } })).json.state;
  }
  const noop0 = await post({ state: fresh, op: { kind: 'SET_TABLE_SIZE', tableSize: 6 } });
  const noop1 = await post({ state: noop0.json.state, op: { kind: 'SET_TABLE_SIZE', tableSize: 6 } });
  const noop2 = await post({ state: noop1.json.state, op: { kind: 'SET_TABLE_SIZE', tableSize: 6 } });
  line(`  非变更 op：ok=${noop0.json.ok}/${noop1.json.ok}/${noop2.json.ok} revision=${noop0.json.state?.revision}/${noop1.json.state?.revision}/${noop2.json.state?.revision} 码=${JSON.stringify(noop2.json.issues?.map((i: any) => i.code) ?? [])}`);
  const noopDiff =
    JSON.stringify(noop0.json.state?.seats) === JSON.stringify(noop2.json.state?.seats) &&
    noop0.json.state?.actionHistory.length === noop2.json.state?.actionHistory.length;
  verdict(
    noopDiff ? 'INFO' : 'HIT',
    'V13b',
    '同版本重放在「无副作用 op」上被接受且无累积效应；其他 op 一律 +1 revision，因此重复提交被水位线挡住',
  );
}

main()
  .then(async () => {
    if (server !== null) await server.close();
    process.exit(0);
  })
  .catch(async (error) => {
    process.stderr.write(`探针崩溃：${String(error)}\n${(error as Error).stack ?? ''}\n`);
    if (server !== null) await server.close();
    process.exit(1);
  });
