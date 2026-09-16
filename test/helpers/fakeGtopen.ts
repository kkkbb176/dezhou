/**
 * GTO 集成测试的假求解器
 *
 * ## 它是什么
 *
 * 一个**纯内存**的 GTOpen 替身：实现我们真正会调用的那几个端点
 * （`/api/preflop/estimate`、`/spot`、`/solve`、`/status`、`/node`），
 * 返回与真实求解器**结构完全一致**的 JSON。
 *
 * ## 它为什么必须是「结构完全一致」而不是「大致像」
 *
 * 因为测试要验证的正是「我们解对了没有」。如果假的响应比真的宽松，
 * 测试会通过而生产会失败 —— 那是**最坏**的一种假绿。
 * 这个替身的字段名、嵌套、单位都按**实测抓下来的真实响应**写
 * （见 `scripts/gto-live-probe.ts` 与 `reports/GTO_MULTI_TABLE_TEST_REPORT.md`）。
 *
 * ## 它**不是**GTO 数据
 *
 * 里面的频率是**确定性构造**的（按类号算出来的伪随机但可复现的值），
 * 不是求解结果，也**不会**出现在生产路径上：它只在测试进程内存在。
 * 这样既不需要真的跑求解器（几秒到几分钟），又能覆盖全部边界
 * （断连 / 超时 / 坏 JSON / 部分响应 / 座位错位 / 频率越界）。
 */

/** 假求解器支持的行为开关 */
export type FakeGtopenBehaviour = {
  /** 连接直接失败（模拟求解器没启动） */
  offline?: boolean;
  /** 所有请求都超时（模拟网络黑洞） */
  hang?: boolean;
  /** `/node` 返回坏 JSON */
  badJson?: boolean;
  /** `/node` 返回缺字段的对象 */
  partialResponse?: boolean;
  /** `/node` 回显的座位表被改过（模拟「读到了别的场景的结果」） */
  wrongSeats?: boolean;
  /** `/node` 的 `strategy` 数组长度不对 */
  wrongStrategyLength?: boolean;
  /** 频率用百分数（0..100）而不是 0..1 —— 模拟单位混淆 */
  percentFrequencies?: boolean;
  /** `/api/preflop/estimate` 报告树超限 */
  treeTooLarge?: boolean;
  /** `/api/preflop/solve` 返回 500 */
  solveFails?: boolean;
  /** 求解状态一直停在 running（模拟不收敛 / 卡住） */
  neverFinishes?: boolean;
  /** `/node` 的 strategy 为 null（求解器拒绝给策略） */
  noStrategy?: boolean;
  /** 求解状态里的迭代与 gap 报告值 */
  iterations?: number;
  /** 求解状态里**回显**的收敛目标；不填则回显 `/solve` 请求里的值（与真实求解器一致） */
  targetGap?: number;
  gapTotal?: number;
  stopReason?: string;
  /** 求解状态除外的响应延迟（毫秒） */
  delayMs?: number;
};

type NodeAction = { label: string; kind: string; to: number; freq: number };

/** 位置顺序（与 GTOopen 一致的座位语义：数组顺序即翻牌前行动顺序） */
export const FAKE_SEAT_ORDER: Readonly<Record<number, readonly string[]>> = Object.freeze({
  4: ['CO', 'BTN', 'SB', 'BB'],
  5: ['HJ', 'CO', 'BTN', 'SB', 'BB'],
  6: ['UTG', 'HJ', 'CO', 'BTN', 'SB', 'BB'],
  8: ['UTG', 'UTG1', 'LJ', 'HJ', 'CO', 'BTN', 'SB', 'BB'],
  9: ['UTG', 'UTG1', 'UTG2', 'LJ', 'HJ', 'CO', 'BTN', 'SB', 'BB'],
});

export type FakeGtopenRequest = {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
};

/**
 * 假求解器的状态机（与真实求解器的关键行为一致）：
 * - **只有一个会话**：`/spot` 会替换它
 * - `/solve` 是**异步**的：立即返回，`state` 从 `running` 变成 `done`
 *   （在假实现里用「下一次 `/status` 查询时变成 done」模拟）
 */
export class FakeGtopen {
  private behaviour: FakeGtopenBehaviour;
  private positions: string[] = [];
  private stack = 100;
  private solved = false;
  private solving = false;
  private solvePolls = 0;
  /** 上一次 /solve 请求的迭代数（真实求解器汇报的是它实际跑的，这里等价） */
  private solveIterations = 60;
  /** 上一次 /solve 请求的收敛目标（真实求解器会回显它） */
  private solveTargetGap = 0;
  /** 记录收到的全部请求（测试用来断言「发了什么」） */
  readonly requests: FakeGtopenRequest[] = [];
  /** `/spot` 被调用的次数（用来验证缓存不重复建树） */
  spotBuilds = 0;

  constructor(behaviour: FakeGtopenBehaviour = {}) {
    this.behaviour = behaviour;
  }

  setBehaviour(next: FakeGtopenBehaviour): void {
    this.behaviour = next;
  }

  /** 注入用的 fetch 实现 */
  fetch = async (
    input: string,
    init?: { method?: string; body?: string },
  ): Promise<{ ok: boolean; status: number; text: () => Promise<string> }> => {
    const method = init?.method ?? 'GET';
    const path = new URL(input).pathname;
    let body: Record<string, unknown> | null = null;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body) as Record<string, unknown>;
      } catch {
        body = null;
      }
    }
    this.requests.push({ method, path, body });

    if (this.behaviour.offline) {
      throw new TypeError('fetch failed: ECONNREFUSED 127.0.0.1:3737');
    }
    if (this.behaviour.hang) {
      throw Object.assign(new Error('The operation was aborted due to timeout'), {
        name: 'TimeoutError',
      });
    }
    if (this.behaviour.delayMs !== undefined && this.behaviour.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.behaviour.delayMs));
    }

    const respond = (status: number, payload: unknown) => {
      const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
      return { ok: status >= 200 && status < 300, status, text: async () => text };
    };

    if (path === '/api/preflop/capabilities') {
      return respond(200, {
        raise_multiples: true,
        model_evidence_sizing: true,
        early_preview_v1: true,
        fresh_build_multiway_models: ['coupled_deck_v1'],
      });
    }

    if (path === '/api/preflop/estimate') {
      const nodes = this.behaviour.treeTooLarge ? 9_999_999 : 1_234;
      return respond(200, {
        nodes,
        action_nodes: Math.floor(nodes / 2),
        arena_mb: nodes / 830,
        truncated: this.behaviour.treeTooLarge === true,
        ok: this.behaviour.treeTooLarge !== true,
        limit_nodes: 1_200_000,
        limit_arena_mb: 1600,
      });
    }

    if (path === '/api/preflop/spot') {
      // 真实求解器：先 stop 并 join，再**替换**会话
      this.spotBuilds += 1;
      const positions = body?.['positions'];
      this.positions = Array.isArray(positions) ? (positions as string[]) : [];
      this.stack = typeof body?.['stack'] === 'number' ? (body['stack'] as number) : 100;
      this.solved = false;
      this.solving = false;
      this.solvePolls = 0;
      return respond(200, {
        nodes: 1_234,
        action_nodes: 617,
        arena_mb: 1.49,
        multiway_equity_model: 'coupled_deck_v1',
      });
    }

    if (path === '/api/preflop/solve') {
      if (this.behaviour.solveFails) {
        return respond(500, 'solver exploded');
      }
      /*
       * 🔴 记录**请求的迭代数**，随后在 status / publication 里按它汇报。
       *
       * 为什么必须这样：真实求解器汇报的是它**实际**迭代了多少次，
       * 而 Phase 1.1 的一致性校验会比对
       * 「请求的迭代数（进缓存键）」与「完成的迭代数（进元数据）」。
       * 如果假实现永远返回 60，那么所有非 60 次迭代的场景
       *（例如 9 人桌的 12 次）都会写出**自相矛盾**的条目 ——
       * 测试会以「缓存的锅」的形式失败，掩盖真正的问题。
       */
      this.solveIterations =
        typeof body?.['iterations'] === 'number' ? (body['iterations'] as number) : 60;
      /*
       * 同样记录**收敛目标**并在 status / publication 里回显 ——
       * 真实求解器就是这么做的（实测：请求 `target_gap: 0.05`，
       * 它的 status 与 publication 都回显 `0.05`）。
       *
       * 假实现若不回显，就会造出「请求了 0.2 但元数据写 0」的自相矛盾条目，
       * 而 Phase 1.1 的一致性校验会正确地拒绝它 —— 于是测试失败在
       * 「缓存的锅」上，掩盖了脚手架不真实这个问题。
       */
      this.solveTargetGap =
        typeof body?.['target_gap'] === 'number' ? (body['target_gap'] as number) : 0;
      this.solving = true;
      this.solved = false;
      this.solvePolls = 0;
      // 真实求解器：立即返回，后台推进
      return respond(200, { ok: true });
    }

    if (path === '/api/preflop/status') {
      if (this.solving && !this.behaviour.neverFinishes) {
        this.solvePolls += 1;
        // 第二次轮询时「求解完成」，模拟真实的异步推进
        if (this.solvePolls >= 2) {
          this.solving = false;
          this.solved = true;
        }
      }
      const running = this.solving || this.behaviour.neverFinishes;
      return respond(200, {
        state: this.positions.length === 0 ? '' : running ? 'running' : 'done',
        phase: running ? 'iterating' : 'idle',
        gpu: false,
        gpu_note: '',
        iteration: this.behaviour.iterations ?? this.solveIterations,
        published_iteration: this.behaviour.iterations ?? this.solveIterations,
        accuracy_iteration: this.behaviour.iterations ?? this.solveIterations,
        target_gap: this.behaviour.targetGap ?? this.solveTargetGap,
        stop_reason: running ? '' : (this.behaviour.stopReason ?? 'iteration_limit'),
        preview_note: '',
        gaps: [0.01, 0.02, 0.03],
        gap_total: this.behaviour.gapTotal ?? 0.06,
        evs: [0.1, -0.2, -0.1],
        hero: null,
        frozen: this.positions.map(() => false),
        error: '',
        realization_note: '',
        multiway_equity_model: 'coupled_deck_v1',
      });
    }

    if (path === '/api/preflop/node') {
      if (this.positions.length === 0) {
        return respond(400, { error: 'no preflop game built yet' });
      }
      if (this.behaviour.badJson) {
        return respond(200, '<html>not json at all</html>');
      }

      const stepped = this.walkPath(body === null ? [] : (body['path'] as number[] | undefined) ?? []);
      if (!stepped.ok) return respond(400, { error: stepped.error });
      const actorIndex = stepped.actor;
      const positions = this.behaviour.wrongSeats
        ? [...this.positions].reverse()
        : this.positions;
      const actions = this.actionsFor(stepped.menu);
      const strategy = this.strategyMatrix(actions);

      if (this.behaviour.noStrategy) {
        return respond(200, {
          kind: 'action',
          actor: actorIndex,
          actor_pos: positions[actorIndex],
          positions,
          pot: 1.5,
          actions: [],
          strategy: null,
          reach: null,
          strategy_note: 'Not solved — no accumulated strategy at this point.',
          exportable: false,
        });
      }

      if (this.behaviour.partialResponse) {
        return respond(200, { kind: 'action', actor: actorIndex });
      }
      if (this.behaviour.wrongStrategyLength) {
        return respond(200, {
          kind: 'action',
          actor: actorIndex,
          actor_pos: positions[actorIndex],
          positions,
          pot: 1.5,
          actions,
          strategy: strategy.slice(0, strategy.length - 5),
          reach: this.reachVector(),
          strategy_note: null,
          exportable: false,
        });
      }

      return respond(200, {
        model_evidence: { kind: 'solver', label: 'Solver', summary: '', details: [] },
        strategy_note: null,
        kind: 'action',
        actor: actorIndex,
        actor_pos: positions[actorIndex],
        positions,
        pot: 1.5,
        invested: this.positions.map(() => 0),
        live: this.positions.map(() => true),
        actions,
        strategy,
        reach: this.reachVector(),
        exportable: false,
        history: [],
        reaches_all: [],
        publication: {
          multiway_model: 'coupled_deck_v1',
          published_iteration: this.behaviour.iterations ?? this.solveIterations,
          accuracy_iteration: this.behaviour.iterations ?? this.solveIterations,
          gap_total: this.behaviour.gapTotal ?? 0.06,
          target_gap: this.behaviour.targetGap ?? this.solveTargetGap,
          converged: false,
        },
      });
    }

    if (path === '/api/preflop/session') {
      return respond(200, { config: { positions: this.positions, stack: this.stack } });
    }

    return respond(404, { error: `unknown path ${path}` });
  };

  /** 根节点的动作菜单（与真实求解器同结构：label / kind / to / freq） */
  private actionsFor(menu: 'first-in' | 'facing-raise'): NodeAction[] {
    const freqs = this.behaviour.percentFrequencies
      ? { fold: 60, call: 0, raise: 40, jam: 0 }
      : { fold: 0.6, call: 0, raise: 0.4, jam: 0 };
    const fold = { label: 'Fold', kind: 'fold', to: 0, freq: freqs.fold };
    const raise = { label: 'Raise 2.5', kind: 'raise', to: 2.5, freq: freqs.raise };
    const allIn = { label: 'All-in 100', kind: 'jam', to: 100, freq: freqs.jam };
    if (menu === 'facing-raise') {
      // 面对加注时菜单里多一个「Call」（与真实求解器一致）
      return [fold, { label: 'Call 2.5', kind: 'call', to: 2.5, freq: 0 }, raise, allIn];
    }
    return [fold, raise, allIn];
  }

  /**
   * 🔴 极简的树模型：按路径推进座位并判断当前行动者。
   *
   * ## 为什么假求解器**必须**有这个东西
   *
   * Phase 1 的假实现永远返回「座位 0 在行动」。这在只有 RFI 时够用，
   * 但 Phase 1.1 要测 VS_OPEN / 3BET 这类**多步路径**，那种假实现会让
   * 「走到 BB 却拿到 UTG 的策略」这种错误**通过测试** —— 假绿是最坏的情况。
   *
   * 这里的模型足够回答两个问题：
   * 1. 走完这些路径之后，轮到谁？（按行动顺序找下一个未弃牌的座位）
   * 2. 他面对加注了吗？（有 raise 且加注者不是他自己 → 菜单含 Call）
   *
   * ⚠️ 它**不是**真求解器：不建树、不算均衡、不做最小加注夹取。
   * 它的唯一价值是「多步路径不会静默走错座位」。
   */
  private walkPath(path: readonly number[]):
    | { ok: true; actor: number; menu: 'first-in' | 'facing-raise' }
    | { ok: false; error: string } {
    const n = this.positions.length;
    if (n === 0) return { ok: false, error: 'no session' };
    const folded = new Set<number>();
    let nextSeat = 0;
    let raiser = -1;

    for (let step = 0; step < path.length; step++) {
      const actor = this.nextActor(folded, nextSeat);
      if (actor < 0) return { ok: false, error: 'no actor left' };
      const menu = this.actionsFor(raiser >= 0 && raiser !== actor ? 'facing-raise' : 'first-in');
      const index = path[step]!;
      if (index < 0 || index >= menu.length) {
        return { ok: false, error: 'bad path index ' + index + ' at step ' + step };
      }
      const chosen = menu[index]!;
      if (chosen.kind === 'fold') {
        folded.add(actor);
      } else if (chosen.kind === 'raise' || chosen.kind === 'jam') {
        raiser = actor;
      }
      nextSeat = (actor + 1) % n;
    }

    const actor = this.nextActor(folded, nextSeat);
    if (actor < 0) return { ok: false, error: 'no actor left at target node' };
    return {
      ok: true,
      actor,
      menu: raiser >= 0 && raiser !== actor ? 'facing-raise' : 'first-in',
    };
  }

  /** 从 rom 开始找下一个未弃牌的座位（环绕） */
  private nextActor(folded: ReadonlySet<number>, from: number): number {
    const n = this.positions.length;
    for (let k = 0; k < n; k++) {
      const seat = (from + k) % n;
      if (!folded.has(seat)) return seat;
    }
    return -1;
  }

  /**
   * 确定性策略矩阵（动作优先展平：`strategy[a * 169 + classIndex]`）。
   *
   * 每类手牌的频率由**类号**决定，因此：
   * - 同一类手牌每次得到同一个值（可复现）
   * - 不同的类号得到不同的值（能验证「我们没有把类号搞错」）
   *
   * 已知锚点（与真实矩阵的类号一致）：
   * - `AA`（类号 168）：加注 1.00（纯加注）
   * - `22`（类号 0）：弃牌 1.00（纯弃牌）
   * - `AKs`（类号 167）：加注 0.75 / 弃牌 0.25（混合）
   * - `AKo`（类号 155）：加注 0.50 / 弃牌 0.50（混合）
   */
  private strategyMatrix(actions: NodeAction[]): number[] {
    const flat: number[] = new Array(actions.length * 169).fill(0);
    const raiseIndex = actions.findIndex((a) => a.kind === 'raise');
    const foldIndex = actions.findIndex((a) => a.kind === 'fold');
    const jamIndex = actions.findIndex((a) => a.kind === 'jam');
    const scale = this.behaviour.percentFrequencies ? 100 : 1;

    for (let classIndex = 0; classIndex < 169; classIndex++) {
      let raiseFreq: number;
      if (classIndex === 168) raiseFreq = 1;
      else if (classIndex === 167) raiseFreq = 0.75;
      else if (classIndex === 155) raiseFreq = 0.5;
      else if (classIndex === 0) raiseFreq = 0;
      else raiseFreq = ((classIndex % 10) + 1) / 20; // 0.05 .. 0.50
      const foldFreq = 1 - raiseFreq;
      if (raiseIndex >= 0) flat[raiseIndex * 169 + classIndex] = raiseFreq * scale;
      if (foldIndex >= 0) flat[foldIndex * 169 + classIndex] = foldFreq * scale;
      if (jamIndex >= 0) flat[jamIndex * 169 + classIndex] = 0;
    }
    return flat;
  }

  private reachVector(): number[] {
    return new Array(169).fill(1);
  }
}
