/**
 * 翻前逐尺寸 EV × 画像 对照表（`PREFLOP_RAISE_EV_BACKFILL` 的证据脚本）
 *
 * ## 这个脚本回答什么问题
 *
 * 「翻前的输出到底随不随画像变化？」—— 修复前所有加注尺寸都显示「未被评估」，
 * 且**跟注 EV 恒定**（201.20），于是很容易得出「翻前画像没生效」的结论。
 *
 * ⚠️ **那是一个假阴性**：翻前跟注 EV 结构上就**不依赖**对手的响应倾向
 * （只由条件权益、赔率与可争夺量决定）。翻前真正吃画像的是**加注响应模型**
 * （`PREFLOP_RAISE_RESPONSE_V1`：对手弃/跟/再加注的倾向直接进 RAISE EV）。
 * 因此本脚本打印**逐尺寸加注 EV**与**建议动作**，而不是跟注 EV。
 *
 * ## 用法
 *
 * ```powershell
 * node --experimental-strip-types src/app/webServer.ts   # 另开一个终端
 * node reports/probes/kq-preflop-profile-table.mjs
 * ```
 *
 * 只读：全部请求都是 `POST /api/analyze`（纯计算），**不写入任何历史/缓存**。
 */

const BASE = process.env.ANALYZE_URL ?? 'http://127.0.0.1:5173/api/analyze';

const POS9 = ['UTG', 'UTG1', 'UTG2', 'LJ', 'HJ', 'CO', 'BTN', 'SB', 'BB'];

/** 弃牌到 BTN，BTN 开池 2.5BB，SB 弃牌 ⇒ Hero（BB）面对开池且身后无人 */
const preflopToButtonOpen = () => {
  const h = [];
  for (const p of ['UTG', 'UTG1', 'UTG2', 'LJ', 'HJ', 'CO']) {
    h.push({ position: p, type: 'FOLD', street: 'PREFLOP' });
  }
  h.push({ position: 'BTN', type: 'RAISE', amountBB: 2.5, street: 'PREFLOP' });
  h.push({ position: 'SB', type: 'FOLD', street: 'PREFLOP' });
  return h;
};

const node = (heroCards, stats) => ({
  tableSize: 9,
  heroPosition: 'BB',
  heroCards,
  board: [],
  street: 'PREFLOP',
  effectiveStackBB: 100,
  bigBlindBB: 100,
  environment: 'LOW_STAKES_ONLINE',
  occupiedPositions: POS9,
  buttonPosition: 'BTN',
  ...(stats === null ? {} : { villain: { observedStats: stats } }),
  actionHistory: preflopToButtonOpen(),
});

const PROFILES = [
  ['无统计', null],
  ['紧 15/10', { handsObserved: 80, vpip: 0.15, pfr: 0.1 }],
  ['松凶 85/60', { handsObserved: 80, vpip: 0.85, pfr: 0.6 }],
];

const analyze = async (input) => {
  const r = await fetch(BASE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input }),
  });
  const b = await r.json();
  if (!b.ok) throw new Error(`分析失败：${JSON.stringify(b.issues ?? b)}`);
  return b;
};

const candidatesOf = (body) =>
  body.viewModel?.debug?.candidates ?? body.viewModel?.candidates ?? [];

const strip = (s) =>
  String(s ?? '—').replace(/\*\*/g, '').replace(/（.*/s, '').replace(/筹码/, '').trim();

const main = async () => {
  console.log('=== 1. 逐尺寸加注 EV（Hero BB ♥A♥Q 面对 BTN 2.5BB 开池）===\n');
  const tables = [];
  for (const [label, stats] of PROFILES) {
    const body = await analyze(node(['Ah', 'Qh'], stats));
    const rows = candidatesOf(body)
      .filter((c) => /加注|全下/.test(c.actionZh))
      .map((c) => [String(c.sizeZh ?? '').trim(), strip(c.evZh)]);
    tables.push([label, rows, `${body.decision.action} ${body.decision.sizeBB ?? ''}`.trim()]);
  }
  const sizes = tables[0][1].map((r) => r[0]);
  console.log(['尺寸', ...tables.map((t) => t[0])].join('\t'));
  for (const size of sizes) {
    const cells = tables.map((t) => (t[1].find((r) => r[0] === size) ?? ['', '—'])[1]);
    console.log([size, ...cells].join('\t'));
  }
  console.log('\n建议：' + tables.map((t) => `${t[0]}=${t[2]}`).join('  |  '));

  console.log('\n=== 2. 建议尺寸是否随画像变化（10 手牌扫描）===\n');
  const hands = [
    ['Ah', 'Qh'], ['9h', '9c'], ['Ah', '9c'], ['Kh', 'Jd'], ['2h', '2c'],
    ['7h', '6h'], ['Ah', '2h'], ['Kh', '9h'], ['Jh', 'Td'], ['3h', '3c'],
  ];
  let flips = 0;
  for (const cards of hands) {
    const out = [];
    for (const [label, stats] of PROFILES) {
      const body = await analyze(node(cards, stats));
      out.push(`${label}:${body.decision.action}${body.decision.sizeBB ? ` ${body.decision.sizeBB}BB` : ''}`);
    }
    const distinct = new Set(out.map((x) => x.split(':')[1]));
    if (distinct.size > 1) flips++;
    console.log(`${distinct.size > 1 ? '★翻转 ' : '      '}${cards.join('')}  ${out.join(' | ')}`);
  }
  console.log(`\n--- 建议尺寸随画像不同的手牌数：${flips}/${hands.length} ---`);
};

await main();
