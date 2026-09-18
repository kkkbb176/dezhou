/**
 * 探针：固定节点（6-max 1/2，BTN K♠Q♠，UTG/HJ/CO limp 2）下
 * 「隔离加注事实包」到底有没有进上下文、里面是什么数字。
 *
 * 用法：E:\node.exe --experimental-strip-types scripts\preflop-iso-probe.ts
 */
import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';
import { deriveLegalActions } from '../src/app/manualInput/legalActions.ts';
import { parseManualInput, type ManualHandInput } from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const STACKS = { UTG: 90, HJ: 120, CO: 130, BTN: 150, SB: 95, BB: 110 } as const;

function build(profile: string, villainPlayerId?: string, limperCount = 3, heroPosition = 'BTN') {
  const seats = ['UTG', 'HJ', 'CO'] as const;
  const actions: { position: string; type: string; amountBB?: number }[] = [];
  seats.forEach((position, i) => {
    actions.push(
      i < limperCount ? { position, type: 'CALL', amountBB: 1 } : { position, type: 'FOLD' },
    );
  });
  if (heroPosition === 'BB') actions.push({ position: 'BTN', type: 'FOLD' }, { position: 'SB', type: 'FOLD' });
  const hand = {
    tableSize: 6,
    heroPosition,
    heroCards: ['Ks', 'Qs'],
    board: [],
    street: 'PREFLOP',
    effectiveStackBB: 150,
    bigBlindBB: 2,
    seatStacksBB: { ...STACKS },
    actionHistory: actions,
    environment: 'MID_LOW_STAKES',
    ...(villainPlayerId === undefined ? {} : { villainPlayerId }),
    villain: { quickProfile: profile, dynamicHint: 'UNKNOWN', stackBB: 150 },
  } as unknown as ManualHandInput;
  const parsed = parseManualInput(hand);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
  const g = buildAnalyzableState(parsed.value);
  if (!g.ok) throw new Error(`state: ${JSON.stringify(g.issues)}`);
  const context = buildDecisionContext({
    state: g.state,
    rules: RULES,
    environment: 'MID_LOW_STAKES',
    asOf: 1_757_000_000_000,
    quickProfile: profile,
    ...(villainPlayerId === undefined ? {} : { villainPlayerId }),
  });
  return { state: g.state, context: context.context, legal: deriveLegalActions(g.state, g.state.players.find((p) => p.holeCards !== null)!) };
}

const first = build('LOOSE', 'seat_CO');
console.log('翻前动作记录：');
for (const a of first.state.actions) {
  console.log(`  ${a.street} ${a.playerId} ${a.type} ${a.amount ?? ''}`);
}
console.log(`callCost=${first.legal.callCost} minRaiseTo=${first.legal.minRaiseToAmount} pot=${first.context.math.pot}`);

/* 人数 / 位置敏感性（报告 §12 用） */
for (const [label, count, heroPosition] of [
  ['1 家 limp（CO）', 1, 'BTN'],
  ['2 家 limp（HJ/CO）', 2, 'BTN'],
  ['3 家 limp（UTG/HJ/CO）', 3, 'BTN'],
  ['3 家 limp + Hero BB（SB 已弃牌）', 3, 'BB'],
] as const) {
  const { context } = build('UNKNOWN', undefined, count, heroPosition);
  const iso = context.preflopIso ?? null;
  console.log(
    `\n【${label}】${iso === null ? 'preflopIso = null' : `尺寸 ${iso.isoSize.legalIsoSize?.toFixed(2)}BB（请求 ${iso.isoSize.requestedIsoSize.toFixed(2)}BB）｜` +
      `全弃 ${(iso.joint.allFold * 100).toFixed(1)}%｜EV_iso ${iso.isoEV.proxyEV === null ? '—' : iso.isoEV.proxyEV.toFixed(2)}｜` +
      `身后修正 ${iso.isoEV.playersBehindAdjustment.toFixed(2)}｜cold3bet ${iso.playersBehind.cold3betRisk.toFixed(3)}`}`,
  );
}

for (const [label, profile, seat] of [
  ['CO 跟注站', 'CALLING_STATION', 'seat_CO'],
  ['UTG 松弱', 'LOOSE', 'seat_UTG'],
  ['无画像', 'UNKNOWN', undefined],
] as const) {
  const { context } = build(profile, seat);
  const iso = context.preflopIso ?? null;
  console.log(`\n──── ${label} ────`);
  if (iso === null) {
    console.log('  preflopIso = null（事实包没有进上下文）');
    continue;
  }
  console.log(`  limp 家数=${iso.limperCount}｜iso 尺寸=${iso.isoSize.legalIsoSize?.toFixed(2)}BB｜请求尺寸=${iso.isoSize.requestedIsoSize.toFixed(2)}BB`);
  for (const l of iso.perLimper) {
    console.log(
      `  ${l.positionZh}｜${l.archetypeZh}｜到达宽度 ${l.arrivalWidth.toFixed(2)}｜` +
        `弃 ${(l.foldProbability * 100).toFixed(1)}% / 跟 ${(l.callProbability * 100).toFixed(1)}% / 再加 ${(l.reraiseProbability * 100).toFixed(1)}%｜价格 ${(l.priceRequiredEquity * 100).toFixed(1)}%`,
    );
  }
  console.log(
    `  联合：全弃 ${(iso.joint.allFold * 100).toFixed(1)}%｜1 家 ${(iso.joint.oneCaller * 100).toFixed(1)}%｜` +
      `2 家 ${(iso.joint.twoCallers * 100).toFixed(1)}%｜3 家 ${(iso.joint.threeCallers * 100).toFixed(1)}%｜` +
      `任一再加 ${(iso.joint.anyReraise * 100).toFixed(1)}%｜期望跟注者 ${iso.joint.expectedCallers.toFixed(2)}`,
  );
  console.log(
    `  权益：到达 ${iso.heroEquity.vsArrival === null ? '—' : (iso.heroEquity.vsArrival * 100).toFixed(1)}%｜` +
      `1 家跟注 ${iso.heroEquity.vsOneCaller === null ? '—' : (iso.heroEquity.vsOneCaller * 100).toFixed(1)}%｜` +
      `多家跟注 ${iso.heroEquity.vsThreeCallers === null ? '—' : (iso.heroEquity.vsThreeCallers * 100).toFixed(1)}%`,
  );
  console.log(`  EV_iso = ${iso.isoEV.proxyEV === null ? '—' : iso.isoEV.proxyEV.toFixed(2)} 筹码（${iso.isoEV.noteZh}）`);
  console.log(`  CALL 代理 EV = ${iso.callProxyEV === null ? '—' : iso.callProxyEV.toFixed(2)} 筹码（作用域 ${iso.callScope}）`);
  console.log(`  身后风险：${iso.playersBehind.noteZh}`);
}
