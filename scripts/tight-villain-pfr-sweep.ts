/**
 * 验证探针：**只改对手的 PFR**（其余全部固定），看引擎给 Hero 的价往哪边走。
 *
 * 为什么这样能证伪/证实：
 *   对照组 A：pfr=0.09（很紧的 12/9 玩家）
 *   对照组 B：pfr=0.22（人群常态主动性）
 *   其余一切固定：标签 VERY_TIGHT、vpip=12%、3bet=3%、wtsd=24%、foldToFlopCBet=72%、
 *                 手数 2000、位置、牌面、下注尺寸、Hero 底牌全部相同。
 *
 * 若「pfr 越低 ⇒ 我们的权益越高」，则引擎在说：
 *   「一个翻前更不主动的对手，翻牌下注范围里诈唬更多」——
 *   这在扑克里需要被单独论证，因为 PFR 是**翻前**主动性。
 *
 * 同时输出：下注范围的构成（价值 / 薄价值 / 摊牌 / 纯空气）与逐尺寸响应，
 * 用来定位「权益变化来自哪一个分量」。
 */
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import type { ManualHandInput } from '../src/app/manualInput/manualInput.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const OPTIONS = {
  rules: RULES, asOf: 1_757_000_000_000, writeLog: false,
  equitySeed: 20_260_913, budget: { softMs: 600_000, hardMs: 1_200_000 },
} as const;

const A = (position: string, type: string, amountBB?: number, street?: string): Record<string, unknown> => ({
  position, type,
  ...(amountBB === undefined ? {} : { amountBB }),
  ...(street === undefined ? {} : { street }),
});
const W = (s: string): number => [...s].reduce((a, c) => a + (c.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
const pad = (s: string, w: number): string => s + ' '.repeat(Math.max(0, w - W(s)));
const rule = (w = 128): string => '='.repeat(w);
const pct = (v: unknown, d = 2): string =>
  typeof v === 'number' && Number.isFinite(v) ? `${(v * 100).toFixed(d)}%` : '—';
const n3 = (v: unknown): string => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(3) : '—');
const SEATS9 = { UTG: 100, UTG1: 100, UTG2: 100, LJ: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 } as const;

/** 其余实测统计**全部固定**，只有 pfr 由参数给出（null = 未观测） */
function statsWith(pfr: number | null): Record<string, unknown> | null {
  return {
    handsObserved: 2000, vpip: 0.12, threeBet: 0.03, wtsd: 0.24,
    foldToFlopCBet: 0.72, foldToTurnCBet: 0.55, foldToRiverBet: 0.6,
    flopCheckRaise: 0.1, turnCheckRaise: 0.07, riverCheckRaise: 0.08,
    ...(pfr === null ? {} : { pfr }),
  };
}

function facingBet(hero: readonly [string, string], villainStats: Record<string, unknown> | null): ManualHandInput {
  return {
    tableSize: 9, heroPosition: 'BTN', heroCards: hero, board: ['Ks', '7h', '2c'], street: 'FLOP',
    effectiveStackBB: 100, bigBlindBB: 100, seatStacksBB: SEATS9,
    actionHistory: [
      A('UTG', 'RAISE', 3), A('UTG1', 'FOLD'), A('UTG2', 'FOLD'), A('LJ', 'FOLD'), A('HJ', 'FOLD'), A('CO', 'FOLD'),
      A('BTN', 'CALL', 3), A('SB', 'FOLD'), A('BB', 'FOLD'), A('UTG', 'BET', 5, 'FLOP'),
    ],
    environment: 'MID_LOW_STAKES',
    villain: {
      persistentPlayerId: 'p_tight_utg', seatId: 'seat_UTG', stackBB: 100, quickProfile: 'VERY_TIGHT',
      ...(villainStats === null ? {} : { observedStats: villainStats }),
    },
  } as unknown as ManualHandInput;
}

type Reading = {
  ok: boolean;
  dims: Record<string, number> | null;
  eq: number | null;
  action: string;
  size: string;
  callEV: number | null;
  classes: Record<string, number>;
  notes: string;
};

function read(hero: readonly [string, string], stats: Record<string, unknown> | null): Reading {
  const r = analyzeManualHand(facingBet(hero, stats), OPTIONS);
  if (!r.ok) {
    return { ok: false, dims: null, eq: null, action: `FAIL/${r.stage}`, size: '-', callEV: null, classes: {}, notes: '' };
  }
  const d: any = r.decision;
  const dg: any = d.diagnostics;
  const pf: any = dg.postflop ?? {};
  const v3 = dg.profileV3 ?? null;
  const dims =
    (v3?.resolved?.resolvedDimensions ?? null) ??
    (dg.player?.adjustment?.dimensions ?? null);
  return {
    ok: true,
    dims: dims === null ? null : { ...dims },
    eq: d.diagnostics.math.heroEquityVsBetRange,
    action: String(d.action),
    size: d.sizeBB === undefined ? '—' : Number(d.sizeBB).toFixed(2),
    callEV: d.diagnostics.math.callEV,
    classes: (pf.bettingRangeFacts?.classMasses ?? {}) as Record<string, number>,
    notes: String(pf.bettingRangeFacts?.noteZh ?? '').replace(/\s+/g, ' '),
  };
}

/* ============================================================
 * 1. PFR 扫描（其余固定）
 * ============================================================ */
const PFRS: readonly (number | null)[] = [null, 0.05, 0.09, 0.13, 0.17, 0.22, 0.28, 0.35];

for (const hero of [['As', 'Qh'], ['Js', 'Jh'], ['Kh', 'Qh']] as const) {
  console.log('');
  console.log(rule());
  console.log(`PFR 扫描：Hero ${hero[0]}${hero[1]}｜K♠7♥2♣｜UTG 开池 3BB → Hero BTN 跟注 → UTG 下注 5BB`);
  console.log('其余画像输入全部固定：VERY_TIGHT + vpip12% / 3bet3% / wtsd24% / foldCbet72% / 2000 手');
  console.log(rule());
  console.log(
    pad('pfr', 9) + pad('aggression维度', 15) + pad('EqVs下注', 11) + pad('动作', 8) + pad('尺寸', 8) +
    pad('CALL_EV', 10) + pad('价值', 9) + pad('薄价值', 9) + pad('摊牌', 9) + pad('纯空气', 9),
  );
  console.log('-'.repeat(128));
  for (const pfr of PFRS) {
    const r = read(hero, statsWith(pfr));
    if (!r.ok) {
      console.log(pad(pfr === null ? '未观测' : `${(pfr * 100).toFixed(0)}%`, 9) + r.action);
      continue;
    }
    console.log(
      pad(pfr === null ? '未观测' : `${(pfr * 100).toFixed(0)}%`, 9) +
      pad(n3(r.dims?.['aggression']), 15) +
      pad(pct(r.eq), 11) + pad(r.action, 8) + pad(r.size, 8) + pad(n3(r.callEV), 10) +
      pad(pct(r.classes['valueMass']), 9) + pad(pct(r.classes['thinValueMass']), 9) +
      pad(pct(r.classes['showdownMass']), 9) + pad(pct(r.classes['pureAirMass']), 9),
    );
  }
}

/* ============================================================
 * 2. 把「紧」拆成两句互不相关的话：VPIP 管宽度，PFR 管主动性
 * ============================================================ */
console.log('');
console.log(rule());
console.log('交叉验证：同一个人（紧度固定 VPIP 12% / 3Bet 3%），只换「翻前主动性 PFR」');
console.log(rule());
console.log(pad('画像', 34) + pad('EqVs下注(AQ)', 15) + pad('动作(AQ)', 11) + pad('EqVs下注(JJ)', 15) + '动作(JJ)');
console.log('-'.repeat(128));
const CROSS: readonly { label: string; stats: Record<string, unknown> | null }[] = [
  { label: '无实测（只有 VERY_TIGHT 标签）', stats: null },
  { label: 'VPIP12 + PFR5%（超被动紧）', stats: statsWith(0.05) },
  { label: 'VPIP12 + PFR9%（很紧，实测档）', stats: statsWith(0.09) },
  { label: 'VPIP12 + PFR13%', stats: statsWith(0.13) },
  { label: 'VPIP12 + PFR22%（常态主动性）', stats: statsWith(0.22) },
  { label: 'VPIP12 + PFR35%（很凶）', stats: statsWith(0.35) },
];
for (const c of CROSS) {
  const aq = read(['As', 'Qh'], c.stats);
  const jj = read(['Js', 'Jh'], c.stats);
  console.log(
    pad(c.label, 34) + pad(pct(aq.eq), 15) + pad(`${aq.action} ${aq.size}`, 11) +
    pad(pct(jj.eq), 15) + `${jj.action} ${jj.size}`,
  );
}

/* ============================================================
 * 3. 引擎自己怎么说（下注范围构成的中文说明）
 * ============================================================ */
console.log('');
console.log(rule());
console.log('引擎自述：同一个 Hero A♠Q♥，只改 PFR');
console.log(rule());
for (const pfr of [0.09, 0.22] as const) {
  const r = read(['As', 'Qh'], statsWith(pfr));
  console.log(`【PFR ${(pfr * 100).toFixed(0)}%】EqVs下注=${pct(r.eq)} 动作=${r.action} ${r.size} CALL_EV=${n3(r.callEV)}`);
  console.log(`   ${r.notes}`);
  console.log('');
}
const noStats = read(['As', 'Qh'], null);
console.log(`【无实测】EqVs下注=${pct(noStats.eq)} 动作=${noStats.action} ${noStats.size} CALL_EV=${n3(noStats.callEV)}`);
console.log(`   ${noStats.notes}`);

/* ============================================================
 * 4. 对照方向自检：如果 PFR 代表「主动性」，越高应当越少诈唬？
 * ============================================================ */
console.log('');
console.log(rule());
console.log('单调性自检（用同一行的数字判定，不引入任何外部假设）');
console.log(rule());
const seq = PFRS.filter((x): x is number => x !== null).map((pfr) => ({ pfr, ...read(['As', 'Qh'], statsWith(pfr)) }));
let monotoneUp = true;
let monotoneDown = true;
for (let i = 1; i < seq.length; i++) {
  if (!(seq[i]!.eq! >= seq[i - 1]!.eq!)) monotoneUp = false;
  if (!(seq[i]!.eq! <= seq[i - 1]!.eq!)) monotoneDown = false;
}
console.log(`EqVs下注 随 PFR 单调递增？ ${monotoneUp ? '是' : '否'}｜单调递减？ ${monotoneDown ? '是' : '否'}`);
console.log(
  '逐点：' + seq.map((s) => `${(s.pfr * 100).toFixed(0)}%→${(s.eq! * 100).toFixed(1)}%`).join('  '),
);
