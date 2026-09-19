/**
 * Reviewer 3 探针 2（V21 入口一致性 / UI 标签覆盖）
 *   mode = item7      → HTTP /api/analyze（{input} 与 {table}）vs 直调
 *   mode = item7-hole → 通过 HTTP 证明「villain.playerId 与首要对手不一致」可达
 *   mode = labels     → 界面 11 个 quickProfile 标签是否都能到达画像逻辑（静默 no-op 排查）
 */
import { analyzeManualHand, hashManualInput } from '../src/app/alphaPipeline.ts';
import { startAlphaServer } from '../src/app/webServer.ts';
import { parseManualInput, ALL_QUICK_PROFILES, type ManualHandInput } from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import { Position } from '../src/domain/types.ts';
import { createTable, seatOfPosition } from '../src/app/table/tableState.ts';
import { applyTableOp } from '../src/app/table/tableOps.ts';
import { buildTablePreview } from '../src/app/table/tablePreview.ts';
import { tableStateToManualHandInput } from '../src/app/table/tableAdapter.ts';
import type { PokerTableState } from '../src/app/table/table.types.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const OPTIONS = { rules: RULES, asOf: 1_757_000_000_000, writeLog: false } as const;
const F = (position: string) => ({ position, type: 'FOLD' as const });
type Node = ManualHandInput & { villainPlayerId?: string };

const pct = (x: number | null | undefined): string =>
  x === null || x === undefined ? 'null' : `${(x * 100).toFixed(4)}%`;

const must = (result: ReturnType<typeof applyTableOp>): PokerTableState => {
  if (!result.ok) throw new Error(`牌桌操作被拒绝：${result.issues.map((i) => i.message).join(' / ')}`);
  return result.state;
};

/** 三家跛入池，CO 是河牌下注者（与 probe1 的 limpedRiver 同源） */
function limpedRiver(profile: string, villainPlayerId: string): Node {
  return {
    tableSize: 6,
    heroPosition: 'BB',
    heroCards: ['Ah', '9h'],
    board: ['Kc', '9s', '5d', '2h', '7c'],
    street: 'RIVER',
    effectiveStackBB: 100,
    bigBlindBB: 2,
    seatStacksBB: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 },
    actionHistory: [
      { position: 'UTG', type: 'CALL', amountBB: 1 },
      F('HJ'),
      { position: 'CO', type: 'CALL', amountBB: 1 },
      F('BTN'),
      F('SB'),
      { position: 'BB', type: 'CHECK' },
      { position: 'BB', type: 'CHECK', street: 'FLOP' },
      { position: 'UTG', type: 'CHECK', street: 'FLOP' },
      { position: 'CO', type: 'BET', amountBB: 1.5, street: 'FLOP' },
      { position: 'BB', type: 'CALL', amountBB: 1.5, street: 'FLOP' },
      { position: 'UTG', type: 'CALL', amountBB: 1.5, street: 'FLOP' },
      { position: 'BB', type: 'CHECK', street: 'TURN' },
      { position: 'UTG', type: 'CHECK', street: 'TURN' },
      { position: 'CO', type: 'BET', amountBB: 4, street: 'TURN' },
      { position: 'BB', type: 'CALL', amountBB: 4, street: 'TURN' },
      { position: 'UTG', type: 'CALL', amountBB: 4, street: 'TURN' },
      { position: 'BB', type: 'CHECK', street: 'RIVER' },
      { position: 'UTG', type: 'CHECK', street: 'RIVER' },
      { position: 'CO', type: 'BET', amountBB: 12, street: 'RIVER' },
    ],
    environment: 'MID_LOW_STAKES',
    villain: { quickProfile: profile as never, dynamicHint: 'UNKNOWN', stackBB: 100 },
    villainPlayerId,
  } as unknown as Node;
}

/** 加注池（画像挂在首要对手 CO 身上，villain==primary） */
function raisedRiver(profile: string): Node {
  return {
    tableSize: 6,
    heroPosition: 'BTN',
    heroCards: ['Ah', 'Qc'],
    board: ['Qs', '8d', '3c', '6s', 'Ks'],
    street: 'RIVER',
    effectiveStackBB: 100,
    bigBlindBB: 2,
    seatStacksBB: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 },
    actionHistory: [
      F('UTG'),
      F('HJ'),
      { position: 'CO', type: 'RAISE', amountBB: 2.5 },
      { position: 'BTN', type: 'CALL', amountBB: 2.5 },
      F('SB'),
      F('BB'),
      { position: 'CO', type: 'BET', amountBB: 2, street: 'FLOP' },
      { position: 'BTN', type: 'CALL', amountBB: 2, street: 'FLOP' },
      { position: 'CO', type: 'BET', amountBB: 7, street: 'TURN' },
      { position: 'BTN', type: 'CALL', amountBB: 7, street: 'TURN' },
      { position: 'CO', type: 'BET', amountBB: 20, street: 'RIVER' },
    ],
    environment: 'MID_LOW_STAKES',
    villain: { quickProfile: profile as never, dynamicHint: 'UNKNOWN', stackBB: 100 },
  } as unknown as Node;
}

const directSnap = (input: Node) => {
  const r = analyzeManualHand(input, OPTIONS);
  if (!r.ok) throw new Error(`分析失败：${JSON.stringify(r.issues)}`);
  return {
    action: String(r.decision.action),
    confidence: r.decision.confidence,
    equity: r.decision.diagnostics.math.heroEquity,
    callEV: r.decision.diagnostics.math.callEV,
    reasons: r.decision.reasons.map((x) => x.code),
    inputHash: r.log.inputHash,
  };
};

async function withServer<T>(fn: (url: string) => Promise<T>): Promise<T> {
  const logDir = mkdtempSync(join(tmpdir(), 'v21rev3-'));
  const server = await startAlphaServer({
    port: 0,
    host: '127.0.0.1',
    rules: RULES,
    logPath: join(logDir, 'decision-log.jsonl'),
  });
  try {
    return await fn(server.url);
  } finally {
    await server.close();
    rmSync(logDir, { recursive: true, force: true });
  }
}

async function post(url: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${url}/api/analyze`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return (await res.json()) as Record<string, unknown>;
}

const httpSnap = (payload: Record<string, unknown>) => {
  const decision = payload['decision'] as Record<string, unknown> | undefined;
  if (decision === undefined) {
    return { ok: payload['ok'], stage: payload['stage'], issues: payload['issues'] };
  }
  const vm = (payload['viewModel'] ?? {}) as Record<string, unknown>;
  return {
    ok: payload['ok'],
    decision: {
      action: decision['action'],
      sizeChips: decision['sizeChips'],
      confidence: decision['confidence'],
      band: decision['band'],
      classification: decision['classification'],
      actionable: decision['actionable'],
    },
    actionZh: vm['actionZh'],
    confidenceZh: vm['confidenceZh'],
    classificationZh: vm['classificationZh'],
    reasonsZh: vm['reasonsZh'],
    warningsZh: vm['warningsZh'],
  };
};

/** 直调结果的同一投影（不含耗时类字段） */
const directHttpLike = (input: Node) => {
  const r = analyzeManualHand(input, OPTIONS);
  if (!r.ok) throw new Error(`分析失败：${JSON.stringify(r.issues)}`);
  const vm = (r as unknown as { viewModel: Record<string, unknown> }).viewModel;
  return {
    ok: true,
    decision: {
      action: r.decision.action,
      sizeChips: r.decision.sizeChips ?? null,
      confidence: r.decision.confidence,
      band: r.decision.band,
      classification: r.decision.classification,
      actionable: r.decision.actionable,
    },
    actionZh: vm['actionZh'],
    confidenceZh: vm['confidenceZh'],
    classificationZh: vm['classificationZh'],
    reasonsZh: vm['reasonsZh'],
    warningsZh: vm['warningsZh'],
  };
};

/** 找出不同的顶层键（耗时类噪声单独标注） */
const diffKeys = (a: Record<string, unknown>, b: Record<string, unknown>): string[] => {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const out: string[] = [];
  for (const k of keys) {
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) out.push(k);
  }
  return out;
};

async function item7(): Promise<void> {
  console.log('=== item7：HTTP /api/analyze vs 直调 analyzeManualHand ===\n');
  await withServer(async (url) => {
    for (const [name, input] of [
      ['跛入池 villain=seat_UTG', limpedRiver('MANIAC', 'seat_UTG')] as const,
      ['加注池 (nodeA) NORMAL', raisedRiver('NORMAL')] as const,
      ['加注池 (nodeA) MANIAC', raisedRiver('MANIAC')] as const,
    ]) {
      const d = directHttpLike(input);
      const form = httpSnap(await post(url, { input }));
      const dk = diffKeys(d as unknown as Record<string, unknown>, form as unknown as Record<string, unknown>);
      console.log(
        `${name}\n  直调 action=${String(d.decision.action)} conf=${String(d.decision.confidence)}` +
          ` reasons=${String((d.reasonsZh as unknown[])?.length)}\n` +
          `  HTTP action=${String((form as Record<string, unknown>)['decision'] !== undefined ? (form.decision as Record<string, unknown>)['action'] : 'n/a')}` +
          ` ⇒ 不同键 = ${dk.length === 0 ? '（无）逐字段相同' : dk.join(', ')}`,
      );
      for (const k of dk) {
        console.log(`    [${k}] 直调=${JSON.stringify((d as Record<string, unknown>)[k]).slice(0, 200)}`);
        console.log(`    [${k}] HTTP=${JSON.stringify((form as Record<string, unknown>)[k]).slice(0, 200)}`);
      }
    }

    /* 表格路径：{table} 与「适配器 + 直调」对照（含画像） */
    const tableState = (withProfile: boolean) => {
      let state = createTable({ tableSize: 6, heroPosition: Position.BB, defaultStackBB: 100 });
      for (const position of [
        Position.UTG, Position.HJ, Position.CO, Position.BTN, Position.SB,
      ]) {
        const seat = seatOfPosition(state, position)!;
        state = must(applyTableOp(state, { kind: 'ADD_PLAYER', seatId: seat.seatId }));
      }
      if (withProfile) {
        const utg = seatOfPosition(state, Position.UTG)!;
        state = must(
          applyTableOp(state, { kind: 'SET_PROFILE', seatId: utg.seatId, quickProfile: 'MANIAC' }),
        );
      }
      state = must(applyTableOp(state, { kind: 'SET_HERO_CARD', card: 'As' }));
      state = must(applyTableOp(state, { kind: 'SET_HERO_CARD', card: 'Kd' }));
      let guard = 0;
      while (guard < 8) {
        const p = buildTablePreview(state);
        if (p.isHeroTurn) break;
        const type = p.currentActorPosition === Position.UTG ? 'RAISE' : 'FOLD';
        const sizePool = p.actionButtons.filter((b) => b.type === type && b.group === 'SIZE');
        const pool = sizePool.length > 0 ? sizePool : p.actionButtons.filter((b) => b.type === type);
        const button = pool[0];
        if (button === undefined) throw new Error(`预览里找不到「${type}」按钮`);
        state = must(
          applyTableOp(state, {
            kind: 'ACT',
            action: {
              type: button.type,
              ...(button.amountChips !== undefined ? { amountChips: button.amountChips } : {}),
            },
          }),
        );
        guard += 1;
      }
      return state;
    };

    for (const withProfile of [false, true]) {
      const T = tableState(withProfile);
      const adapted = tableStateToManualHandInput(T);
      if (!adapted.ok) {
        console.log(`\n{table} 适配失败：${JSON.stringify(adapted.issues)}`);
        continue;
      }
      const d = directHttpLike(adapted.input as Node);
      const via = httpSnap(await post(url, { table: T }));
      const dk = diffKeys(d as unknown as Record<string, unknown>, via as unknown as Record<string, unknown>);
      console.log(
        `\n{table} 画像=${withProfile}（适配后 villain.quickProfile=${String(adapted.input.villain?.quickProfile)}` +
          ` playerId=${String(adapted.input.villain?.playerId)}）\n` +
          `  直调 action=${String(d.decision.action)} conf=${String(d.decision.confidence)}\n` +
          `  HTTP action=${String((via.decision as Record<string, unknown> | undefined)?.['action'])}` +
          ` ⇒ 不同键 = ${dk.length === 0 ? '（无）逐字段相同' : dk.join(', ')}`,
      );
      for (const k of dk) {
        console.log(`    [${k}] 直调=${JSON.stringify((d as Record<string, unknown>)[k]).slice(0, 180)}`);
        console.log(`    [${k}] HTTP=${JSON.stringify((via as Record<string, unknown>)[k]).slice(0, 180)}`);
      }
    }
  });
}

async function item7Hole(): Promise<void> {
  console.log('=== item7-hole：HTTP 能否指定与首要对手不一致的 villain.playerId ===\n');
  await withServer(async (url) => {
    for (const playerId of ['seat_UTG', 'seat_CO']) {
      const input = limpedRiver('MANIAC', playerId);
      const body = { input };
      const payload = await post(url, body);
      const snap = httpSnap(payload);
      console.log(
        `HTTP input.villain.playerId=${playerId} ⇒ ok=${String(payload['ok'])}` +
          ` ${JSON.stringify(snap).slice(0, 400)}`,
      );
    }
  });
}

/**
 * item2-ui：走**真实牌桌操作**复现「跛入原型通道」去重缺口。
 *
 * 牌桌：6-max，Hero = BB。UTG 跛入（CALL），其余弃牌，BB 过牌 → 翻牌。
 * 翻牌由 Hero（BB）**先行动** ⇒ 对手在本街/本手都还没有翻后记录。
 */
function item2Ui(): void {
  console.log('=== item2-ui：牌桌 UI 路径下 profileRangeEvidence.provider.applied=false 但范围已变 ===\n');
  const buildTable = (profile: string | null) => {
    let state = createTable({ tableSize: 6, heroPosition: Position.BB, defaultStackBB: 100 });
    for (const position of [Position.UTG, Position.HJ, Position.CO, Position.BTN, Position.SB]) {
      const seat = seatOfPosition(state, position)!;
      state = must(applyTableOp(state, { kind: 'ADD_PLAYER', seatId: seat.seatId }));
    }
    if (profile !== null) {
      const utg = seatOfPosition(state, Position.UTG)!;
      state = must(
        applyTableOp(state, { kind: 'SET_PROFILE', seatId: utg.seatId, quickProfile: profile as never }),
      );
    }
    state = must(applyTableOp(state, { kind: 'SET_HERO_CARD', card: 'Ah' }));
    state = must(applyTableOp(state, { kind: 'SET_HERO_CARD', card: '9h' }));
    // 翻前：UTG 跛入、其余弃牌到 Hero
    let guard = 0;
    while (guard < 8) {
      const p = buildTablePreview(state);
      if (p.isHeroTurn) break;
      const at = p.currentActorPosition;
      const want = at === Position.UTG ? 'CALL' : 'FOLD';
      const poolAll = p.actionButtons.filter((b) => b.type === want);
      const pool =
        poolAll.filter((b) => b.group === 'SIZE').length > 0
          ? poolAll.filter((b) => b.group === 'SIZE')
          : poolAll;
      const button = pool[0];
      if (button === undefined) throw new Error(`找不到「${want}」按钮：${p.actionButtons.map((b) => b.labelZh).join('/')}`);
      state = must(
        applyTableOp(state, {
          kind: 'ACT',
          action: {
            type: button.type,
            ...(button.amountChips !== undefined ? { amountChips: button.amountChips } : {}),
          },
        }),
      );
      guard += 1;
    }
    // Hero（BB）过牌
    {
      const p = buildTablePreview(state);
      const check = p.actionButtons.find((b) => b.type === 'CHECK');
      if (check === undefined) throw new Error(`BB 没有过牌按钮：${p.actionButtons.map((b) => b.type).join('/')}`);
      state = must(applyTableOp(state, { kind: 'ACT', action: { type: 'CHECK' } }));
    }
    // 翻牌
    for (const [slot, card] of [['Kc'], ['9s'], ['5d']].entries()) {
      state = must(applyTableOp(state, { kind: 'SET_BOARD_CARD', card: card[0]!, slot }));
    }
    return state;
  };

  const report = (label: string, profile: string | null) => {
    const T = buildTable(profile);
    const p = buildTablePreview(T);
    const adapted = tableStateToManualHandInput(T);
    if (!adapted.ok) {
      console.log(`${label}: 适配失败 ${JSON.stringify(adapted.issues)}`);
      return null;
    }
    const parsed = parseManualInput(adapted.input as never);
    if (!parsed.ok) {
      console.log(`${label}: 解析失败 ${JSON.stringify(parsed.issues)}`);
      return null;
    }
    const g = buildAnalyzableState(parsed.value);
    if (!g.ok) {
      console.log(`${label}: 门槛拒绝 ${JSON.stringify(g.issues)}`);
      return null;
    }
    const built = buildDecisionContext({
      state: g.state, rules: RULES, environment: 'MID_LOW_STAKES', asOf: 1_757_000_000_000,
      ...(adapted.input.villain?.quickProfile === undefined ? {} : { quickProfile: adapted.input.villain.quickProfile }),
      ...(adapted.input.villain?.playerId === undefined ? {} : { villainPlayerId: adapted.input.villain.playerId }),
    });
    const ev = built.context.profileRangeEvidence ?? null;
    const r = analyzeManualHand(adapted.input as Node, OPTIONS);
    console.log(
      `${label}\n` +
        `  座位序当前行动者=${String(p.currentActorPosition)} isHeroTurn=${String(p.isHeroTurn)}` +
        ` villain.playerId=${String(adapted.input.villain?.playerId)} quickProfile=${String(adapted.input.villain?.quickProfile)}\n` +
        `  profileRangeEvidence=${ev === undefined ? 'absent' : 'present'} provider.applied=${String(ev?.provider.applied)}` +
        ` equityBefore=${pct(ev?.equityBefore ?? null)} equityAfter=${pct(ev?.equityAfter ?? null)}` +
        ` delta=${ev?.equityDeltaPct === null || ev?.equityDeltaPct === undefined ? 'null' : ev.equityDeltaPct.toFixed(4)}\n` +
        `  heroEquity=${pct(built.context.math.heroEquity)} action=${r.ok ? r.decision.action : 'FAILED'}`,
    );
    return built.context.math.heroEquity ?? null;
  };

  for (const profile of [null, 'UNKNOWN', 'CALLING_STATION', 'MANIAC', 'NORMAL'] as const) {
    report(`牌桌路径 profile=${profile === null ? '（从未设置）' : profile}`, profile);
  }
}

function labels(): void {
  console.log('=== labels：界面 11 个快速画像标签的效果覆盖 ===\n');
  const baseline = (mk: (p: string) => Node, villainSeat?: string) => {
    const input = mk('UNKNOWN');
    if (villainSeat !== undefined) input.villainPlayerId = villainSeat;
    input.villain = {} as never;
    return directSnap(input);
  };
  const raisedBase = baseline(raisedRiver);
  const limpedBase = baseline(limpedRiver, 'seat_UTG');
  console.log(
    `基线（无画像）加注池 equity=${pct(raisedBase.equity)} action=${raisedBase.action}｜` +
      `跛入池 equity=${pct(limpedBase.equity)} action=${limpedBase.action}\n`,
  );
  console.log(
    '标签'.padEnd(18) + '加注池Δequity'.padEnd(16) + '加注池applied'.padEnd(16) +
      '加注池动作'.padEnd(12) + '跛入池Δ'.padEnd(14) + '跛入applied'.padEnd(14) + '跛入动作',
  );
  for (const p of ALL_QUICK_PROFILES) {
    const rNode = raisedRiver(p);
    const r = directSnap(rNode);
    const rEv = (() => {
      const parsed = parseManualInput(rNode);
      if (!parsed.ok) return null;
      const g = buildAnalyzableState(parsed.value);
      if (!g.ok) return null;
      const built = buildDecisionContext({
        state: g.state, rules: RULES, environment: 'MID_LOW_STAKES',
        asOf: 1_757_000_000_000, quickProfile: p as never,
      });
      return built.context.profileRangeEvidence ?? null;
    })();
    const lNode = limpedRiver(p, 'seat_UTG');
    const l = directSnap(lNode);
    const lEv = (() => {
      const parsed = parseManualInput(lNode);
      if (!parsed.ok) return null;
      const g = buildAnalyzableState(parsed.value);
      if (!g.ok) return null;
      const built = buildDecisionContext({
        state: g.state, rules: RULES, environment: 'MID_LOW_STAKES',
        asOf: 1_757_000_000_000, quickProfile: p as never, villainPlayerId: 'seat_UTG',
      });
      return built.context.profileRangeEvidence ?? null;
    })();
    const dR = (r.equity ?? 0) - (raisedBase.equity ?? 0);
    const dL = (l.equity ?? 0) - (limpedBase.equity ?? 0);
    console.log(
      p.padEnd(18) +
        `${(dR * 100).toFixed(4)}pp`.padEnd(16) +
        `${rEv === null ? 'none' : String(rEv.provider.applied)}`.padEnd(16) +
        `${r.action === raisedBase.action ? '同' : `**${r.action}**`}`.padEnd(12) +
        `${(dL * 100).toFixed(4)}pp`.padEnd(14) +
        `${lEv === null ? 'none' : String(lEv.provider.applied)}`.padEnd(14) +
        `${l.action === limpedBase.action ? '同' : `**${l.action}**`}`,
    );
  }
  void hashManualInput;
}

const mode = process.argv[2] ?? 'item7';
if (mode === 'item7') await item7();
else if (mode === 'item7-hole') await item7Hole();
else if (mode === 'item2-ui') item2Ui();
else if (mode === 'labels') labels();
else console.log(`未知 mode：${mode}`);
