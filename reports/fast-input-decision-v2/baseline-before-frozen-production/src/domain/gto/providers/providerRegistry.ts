/**
 * Provider 注册表 —— 用**注册**而不是 `if (engine === 'gtopen')`
 *
 * ## 这一轮要为未来准备什么
 *
 * 下一阶段会接入第二个求解器（`chirenonhive/poker-solver`）做交叉验证，
 * 之后还可能有我们自己的求解器。届时唯一应该发生的事情是：
 *
 * ```
 * registerGtoProvider(new OtherSolverProvider(...))
 * ```
 *
 * **而不是**：
 *
 * ```ts
 * if (engine === 'gtopen') { … } else if (engine === 'other') { … }   // ❌ 禁止
 * ```
 *
 * 后者的后果是「引擎判断」会散布到 Decision Engine、UI、缓存、日志里，
 * 每加一个求解器就要改五六处，而漏掉任何一处都会静默走错分支。
 * 因此：
 *
 * - 所有引擎都是 `GtoProvider`，上层**只**认这个接口；
 * - 引擎之间**可以**并联（`GtoProviderSet`），用于交叉验证；
 * - 没有任何地方需要知道某个引擎的**名字**才能工作（名字只用于显示与日志）。
 */

import {
  GtoSolveStatus,
  type GtoLookupResult,
  type GtoProvider,
  type GtoScenario,
  type GtoSolveKeyParts,
} from '../gto.types.ts';
import { GtopenProvider, type GtopenProviderOptions } from './gtopenProvider.ts';

/* ============================================================
 * 注册表
 * ============================================================ */

const REGISTRY = new Map<string, () => GtoProvider>();

/**
 * 注册一个 Provider 工厂。
 *
 * 工厂（而不是实例）的理由：Provider 可能持有连接与状态，
 * 测试需要拿到**干净**的实例，不能让测试之间共享互相影响。
 */
export function registerGtoProvider(engine: string, factory: () => GtoProvider): void {
  REGISTRY.set(engine, factory);
}

/** 已注册的引擎名 */
export function registeredGtoEngines(): readonly string[] {
  return Object.freeze([...REGISTRY.keys()].sort());
}

/** 按名字创建 Provider；未注册返回 `null`（**不抛**） */
export function createGtoProvider(engine: string): GtoProvider | null {
  const factory = REGISTRY.get(engine);
  return factory === undefined ? null : factory();
}

// ---- 内置注册：GTOpen（唯一接入的引擎） ----
registerGtoProvider('gtopen', () => new GtopenProvider());

/** 便捷构造（可注入选项；测试用） */
export function createGtopenProvider(options: GtopenProviderOptions = {}): GtopenProvider {
  return new GtopenProvider(options);
}

/* ============================================================
 * 多引擎集合（为交叉验证预留）
 * ============================================================ */

/**
 * 一组 Provider，对外表现得像**一个** Provider。
 *
 * 本阶段只有 GTOpen 一个成员，但接口先立起来 —— 将来加第二个求解器时，
 * Decision Engine 一行都不用改（它看到的一直是同一个 `GtoProvider`）。
 *
 * 语义：
 * - `lookupScenario` 用**主引擎**的结果（第一个成员）
 * - `crossCheck` 逐个问其它引擎，用于把可信度从 `SOLVED` 提到 `CROSS_CHECKED`
 *   （本阶段不实现提升逻辑：只有交叉验证**全部一致**时才可以提升，
 *    而那需要两个引擎都真的在位）
 */
export class GtoProviderSet implements GtoProvider {
  readonly engine: string;
  readonly displayName: string;
  private readonly members: readonly GtoProvider[];

  constructor(members: readonly GtoProvider[], displayName?: string) {
    if (members.length === 0) throw new Error('GtoProviderSet: 至少需要一个 Provider');
    this.members = members;
    this.engine = members[0]!.engine;
    this.displayName = displayName ?? members.map((m) => m.displayName).join(' + ');
  }

  /** 全部成员（交叉验证用） */
  all(): readonly GtoProvider[] {
    return this.members;
  }

  async health() {
    return this.members[0]!.health();
  }

  async capabilities() {
    return this.members[0]!.capabilities();
  }

  /**
   * 求解侧参数取**主引擎**（第一个成员）的那一份。
   *
   * ⚠️ 交叉验证时两个引擎的设置可能不同。那种情况下缓存键必须只描述
   * 「**实际产出这份结果的那次**求解」。本阶段只有 GTOpen 一个成员，
   * 因此取第一个成员即是正确行为。将来接入第二引擎时，
   * 交叉验证的结果**不写进主缓存**（它有自己的键），由调用方保证。
   */
  solveKeyParts(scenario: GtoScenario): GtoSolveKeyParts {
    return this.members[0]!.solveKeyParts(scenario);
  }

  async lookupScenario(scenario: GtoScenario): Promise<GtoLookupResult> {
    let last: GtoLookupResult | null = null;
    for (const member of this.members) {
      const result = await member.lookupScenario(scenario);
      if (!('status' in result)) return result;
      last = result;
    }
    return (
      last ?? {
        status: GtoSolveStatus.GTO_BASELINE_UNAVAILABLE,
        cause: GtoSolveStatus.FAILED,
        message: 'GtoProviderSet: 没有可用的 Provider',
        scenario,
        scenarioHash: '',
        metadata: null as never,
      }
    );
  }

  /**
   * 逐个问其它引擎，返回每个引擎的结果。
   *
   * ⚠️ **本阶段不做「一致性判定」**：判定需要至少两个真实在位的引擎，
   * 而本轮只有一个。因此这里只是把结果列出来供人工查看，
   * 上层**不得**据此把可信度提升到 `CROSS_CHECKED`。
   */
  async crossCheck(scenario: GtoScenario): Promise<readonly { engine: string; result: GtoLookupResult }[]> {
    const out: { engine: string; result: GtoLookupResult }[] = [];
    for (const member of this.members) {
      out.push({ engine: member.engine, result: await member.lookupScenario(scenario) });
    }
    return Object.freeze(out);
  }
}
