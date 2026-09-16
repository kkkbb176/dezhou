/**
 * Phase 1.3 实况探针：前台不等求解器、后台补算、第二次命中 GTO
 *
 * ## 它验证什么
 *
 * Phase 1.2 的缺陷是「给建议」与「算 GTO」在同一条路径上，于是
 * 冷启动第一次查询会被求解拖住（实测 6 人桌 109 ms 就放弃、
 * 9 人桌 195 312 ms）。这一轮把它们拆开。本探针用**真实服务**验证拆分成立。
 *
 * ## 用法
 *
 * ```sh
 * # 需要 Alpha 在 5173、GTOpen 在 3737 上运行
 * node --experimental-strip-types scripts/gto-phase13-probe.ts
 *
 * # 冷启动验证（需要先清空缓存并重启求解器）
 * node --experimental-strip-types scripts/gto-phase13-probe.ts --cold
 * ```
 *
 * ## 判据（**任何一条不成立就是回归**）
 *
 * | # | 判据 |
 * |---|---|
 * | 1 | 前台回答**永远**快（不随求解耗时变化） |
 * | 2 | 缓存未命中时**如实标注**「GTO 正在后台计算」，且说明「之后会自动改用 GTO」 |
 * | 3 | 后台算完后，同样的查询**自动**变成 `fromSolver=true` |
 * | 4 | 结构上算不了的局面对**等也不会变**说清楚，不误导成「稍后就有」 |
 */

const BASE = process.env['ALPHA_BASE'] ?? 'http://127.0.0.1:5173';
const COLD = process.argv.includes('--cold');

/** 前台耗时的上限。判据是「与求解耗时无关」，而不是一个具体的毫秒数 */
const FRONTEND_BUDGET_MS = Number(process.env['ALPHA_PROBE_BUDGET_MS'] ?? 2000);

let failures = 0;
function check(ok: boolean, label: string, detail: string): void {
  console.log(`  ${ok ? '✔' : '✖'} ${label}${detail === '' ? '' : ` —— ${detail}`}`);
  if (!ok) failures += 1;
}

type Spot = ReturnType<typeof utgOpen>;

/** 6 人桌，UTG 开池 2.5BB，英雄在大盲位 AhKh */
function utgOpen() {
  return {
    input: {
      tableSize: 6,
      heroPosition: 'BB',
      heroCards: ['Ah', 'Kh'],
      board: [],
      street: 'PREFLOP',
      effectiveStackBB: 100,
      actionHistory: [
        { position: 'UTG', type: 'RAISE', amountBB: 2.5 },
        { position: 'HJ', type: 'FOLD' },
        { position: 'CO', type: 'FOLD' },
        { position: 'BTN', type: 'FOLD' },
        { position: 'SB', type: 'FOLD' },
      ],
      environment: 'LOW_STAKES_ONLINE',
    },
  };
}

/** 6 人桌，CO 开池 2.5BB —— 本项目**结构上算不了**（RFI 只覆盖第一个行动位） */
function coOpen() {
  return {
    input: {
      ...utgOpen().input,
      actionHistory: [
        { position: 'UTG', type: 'FOLD' },
        { position: 'HJ', type: 'FOLD' },
        { position: 'CO', type: 'RAISE', amountBB: 2.5 },
        { position: 'BTN', type: 'FOLD' },
        { position: 'SB', type: 'FOLD' },
      ],
    },
  };
}

async function analyze(spot: Spot): Promise<{ ms: number; body: Record<string, unknown> }> {
  const t0 = Date.now();
  const res = await fetch(`${BASE}/api/analyze`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(spot),
  });
  return { ms: Date.now() - t0, body: (await res.json()) as Record<string, unknown> };
}

/** 从响应里取出我们要断言的那几样（只读公开字段） */
function facts(body: Record<string, unknown>) {
  const gto = (body['gtoStatus'] ?? {}) as Record<string, unknown>;
  const prov = (body['rangeProvenance'] ?? []) as readonly Record<string, unknown>[];
  return {
    state: String(gto['state'] ?? ''),
    messageZh: String(gto['messageZh'] ?? ''),
    elapsedMs: Number(gto['elapsedMs'] ?? -1),
    reasons: ((gto['reasons'] ?? []) as readonly unknown[]).map((r) => String(r)),
    background:
      (gto['background'] as readonly Record<string, unknown>[] | undefined)?.map(
        (b) => `${String(b['thingZh'])}:${String(b['state'])}`,
      ) ?? [],
    ranges: prov.map((r) => ({
      positionZh: String(r['positionZh'] ?? ''),
      fromSolver: r['fromSolver'] === true,
      outcome: String(r['gtoOutcomeState'] ?? ''),
      reasonZh: r['gtoReasonZh'] === undefined ? null : String(r['gtoReasonZh']),
    })),
  };
}

console.log(`Phase 1.3 实况探针 —— ${BASE}${COLD ? '（冷启动模式）' : ''}\n`);

/* ---- 1) UTG 开池：前台必须快，且如实交代 GTO 状态 ---- */
console.log('① UTG 开池（本模型支持）');
const first = await analyze(utgOpen());
const f1 = facts(first.body);
console.log(`   耗时 ${first.ms} ms ｜ 前台取数 ${f1.elapsedMs} ms ｜ state=${f1.state}`);
console.log(`   ${f1.messageZh}`);
for (const r of f1.ranges) {
  console.log(`   · ${r.positionZh}: fromSolver=${r.fromSolver} outcome=${r.outcome}`);
}

check(
  first.ms < FRONTEND_BUDGET_MS,
  '前台回答足够快',
  `${first.ms} ms（上限 ${FRONTEND_BUDGET_MS} ms）`,
);
check(
  f1.ranges.length > 0,
  '必须给出对手范围的来源说明',
  `${f1.ranges.length} 家`,
);

if (f1.state === 'BACKGROUND_SOLVING' || f1.state === 'MIXED') {
  /*
   * ⚠️ 断言按状态**分别**写，因为两种状态要交代的事不同：
   *
   * - `BACKGROUND_SOLVING`：全部是启发式 ⇒ 必须说明「算完会自动改用 GTO」
   * - `MIXED`：一部分已经是 GTO、另一部分在算 ⇒ 必须说清哪部分是哪部分
   *
   * 用一句统一的断言去卡两种状态会误报（实测踩过）。
   */
  if (f1.state === 'BACKGROUND_SOLVING') {
    check(
      f1.messageZh.includes('后台计算') && f1.messageZh.includes('自动'),
      '必须说明「正在后台计算」且「之后会自动改用 GTO（不需要任何操作）」',
      f1.messageZh.slice(0, 40) + '…',
    );
    check(
      f1.ranges.some((r) => !r.fromSolver),
      '未命中时如实标注为启发式',
      '',
    );
  } else {
    check(
      f1.messageZh.includes('后台计算') && f1.messageZh.includes('启发式'),
      'MIXED 时必须同时说清「哪部分已用 GTO」与「哪部分在用启发式」',
      f1.messageZh.slice(0, 40) + '…',
    );
    check(
      f1.ranges.some((r) => r.fromSolver) || f1.background.some((b) => b.includes('RUNNING')),
      'MIXED 必须至少有一家在算或已用上',
      f1.background.join(' / '),
    );
  }

  /* ---- 2) 等后台算完，同样的查询必须自动用上 GTO ---- */
  console.log('\n② 等后台算完（最多 240 秒）…');
  let flipped = false;
  for (let i = 1; i <= 48; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const again = await analyze(utgOpen());
    const f2 = facts(again.body);
    if (f2.ranges.some((r) => r.fromSolver)) {
      console.log(`   +${i * 5} 秒：已用上 GTO（耗时 ${again.ms} ms）`);
      for (const r of f2.ranges) console.log(`   · ${r.positionZh}: fromSolver=${r.fromSolver}`);
      check(true, '后台算完后同样的查询自动命中 GTO 范围', `+${i * 5} 秒`);
      check(
        again.ms < FRONTEND_BUDGET_MS,
        '命中 GTO 之后前台**依然**快（缓存命中不该变慢）',
        `${again.ms} ms`,
      );
      flipped = true;
      break;
    }
  }
  if (!flipped) {
    check(false, '后台算完后同样的查询自动命中 GTO 范围', '等待 240 秒仍未翻转');
  }
} else if (f1.ranges.some((r) => r.fromSolver)) {
  console.log('   （缓存已命中 —— 这是「第二次查询」的状态，符合预期）');
  check(true, '缓存命中时用上求解器范围', '');
  check(first.ms < FRONTEND_BUDGET_MS, '命中缓存时前台足够快', `${first.ms} ms`);
}

/* ---- 3) CO 开池：结构上算不了，必须说清楚「等也不会变」 ---- */
console.log('\n③ CO 开池（本模型**结构上算不了**）');
const third = await analyze(coOpen());
const f3 = facts(third.body);
console.log(`   耗时 ${third.ms} ms ｜ state=${f3.state}`);
console.log(`   ${f3.messageZh}`);
for (const r of f3.ranges) {
  if (r.reasonZh !== null) console.log(`   ⚠ ${r.reasonZh}`);
}
for (const reason of f3.reasons) console.log(`   · ${reason}`);
check(
  f3.ranges.every((r) => !r.fromSolver),
  '算不了的局面不得假装拿到 GTO 范围',
  '',
);
/*
 * 具体理由可能在两处：逐家的 `gtoReasonZh`，或（没有 outcome 可挂时）
 * `gtoStatus.reasons`。两处**合起来**必须点明「等也不会变」——
 * 否则使用者会一直等一个不会来的结果。
 */
const allReasons = [...f3.ranges.map((r) => r.reasonZh ?? ''), ...f3.reasons];
check(
  allReasons.some((t) => t.includes('等也不会变')),
  '必须点明「等也不会变」（否则使用者会一直等一个不会来的结果）',
  '',
);

console.log(`\n${failures === 0 ? '✔ 全部通过' : `✖ ${failures} 项未通过`}`);
/*
 * ⚠️ 用 `exitCode` 而不是 `process.exit()`：在 Windows 上立刻退出会让
 * libuv 在终端句柄关闭后仍尝试写入，打出一行
 * `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` ——
 * 那是**退出方式的噪音**，与本探针的结论无关，但会让人以为探针崩了。
 */
process.exitCode = failures === 0 ? 0 : 1;
