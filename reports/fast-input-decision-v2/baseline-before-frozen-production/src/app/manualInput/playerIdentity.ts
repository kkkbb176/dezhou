/**
 * ============================================================================
 * 玩家身份路由（PLAYER IDENTITY ROUTING V1）
 * ============================================================================
 *
 * ## 存在的唯一理由
 *
 * TEST 16 实测：`contextBuilder` 用**一个**字符串同时表达三件事，于是
 * 「调用方传的是对手名字」时范围链**静默**拿不到画像：
 *
 * ```text
 * opponent.id = "seat_BB"      ← 引擎口径座位 id（行动记录 / 动态层按它匹配）
 * villainId   = "阿豪"          ← 调用方给的「对手稳定 id」，实际是显示名
 * 结果：opponent.id === villainId 恒为 false ⇒ 画像 provider / 行为画像整体未注入
 * ```
 *
 * ## 三个概念**必须分开**（§二）
 *
 * | 概念 | 本项目里叫什么 | 用于 | 换座位会变吗 |
 * |---|---|---|---|
 * | ① 玩家持久身份 | `persistentPlayerId`（如 `player_001`） | 历史画像 / 实测统计 / 复盘 | ❌ 不变 |
 * | ② 当前座位身份 | `seatId`（= `seat_<位置>`，`reconstruct.playerIdOfPosition`） | 行动顺序 / 筹码 / 本局行动记录 | ✅ 每手可变 |
 * | ③ 显示名 | `displayName`（可重复、可缺省） | **只用于显示** | ✅ 可变 |
 *
 * 🔴 **显示名永不参与绑定**：同名不同人是常态，按姓名合并画像就是编造数据
 *（§六.3）。需要「姓名 → 持久 id」时用 `resolveRosterSelection`，它在
 * 多候选时返回 `AMBIGUOUS`（待用户选择），**绝不猜**。
 *
 * ## 本模块不新建任何玩家数据库
 *
 * 它只做**一次解析**：把「调用方声明的身份」映射到「本手真实存在的座位」。
 * 持久画像本身仍由调用方按 `persistentPlayerId` 提供（`ManualVillain` 的
 * `observedStats` / `quickProfile` / `dynamicHint`，牌桌路径来自
 * `playersById[seat.playerId]`）—— 与既有模型完全一致。
 *
 * ## 不猜的三条硬规则
 *
 * 1. 定位不到目标座位 ⇒ `SEAT_NOT_FOUND`，**不注入**（宁可没有画像，
 *    也不能用甲的性格给乙做决策）；
 * 2. 有 ≥2 家对手而只给了「非座位口径」的 id ⇒ `AMBIGUOUS_MULTI_OPPONENT`，
 *    **不注入**；
 * 3. 只给了显示名 ⇒ `NAME_ONLY_NO_BINDING`：画像仍按「本手唯一对手槽位」
 *    生效，但**不做任何持久身份绑定**（因此也不会去读任何历史统计）。
 */

/** 引擎口径座位 id 的前缀（与 `reconstruct.playerIdOfPosition` 同源） */
export const ENGINE_SEAT_ID_PREFIX = 'seat_';

/** 这个字符串是不是「引擎口径座位 id」（`seat_BB` 这种） */
export function isEngineSeatId(value: string): boolean {
  return value.startsWith(ENGINE_SEAT_ID_PREFIX) && value.length > ENGINE_SEAT_ID_PREFIX.length;
}

/** 调用方声明的玩家身份（四个字段都可缺省） */
export type PlayerIdentityClaim = {
  /**
   * **引擎口径 id**（`seat_<位置>`）。历史字段，仍被接受：
   * 它指向「哪个座位」，**不是**玩家持久身份。
   */
  readonly playerId?: string | null;
  /** ① **玩家持久身份**（关联历史画像 / 实测统计的唯一键） */
  readonly persistentPlayerId?: string | null;
  /** ② **当前座位身份**（显式绑定；优先级最高） */
  readonly seatId?: string | null;
  /** ③ **显示名**（只显示；**永不**参与绑定） */
  readonly displayName?: string | null;
};

export type PlayerIdentityStatus =
  /** 显式 `seatId`（或引擎口径 id）命中真实对手座位 —— 最明确的一档 */
  | 'BOUND_BY_SEAT_ID'
  /** 给了持久 id + 本手只有一家对手 ⇒ 结构上就是那一家 */
  | 'BOUND_BY_PERSISTENT_ID'
  /** 给了非座位口径的自由文本 id + 只有一家对手 ⇒ 按唯一对手槽位路由（非持久绑定） */
  | 'BOUND_BY_SOLE_OPPONENT'
  /** 没给任何身份 ⇒ 行为保持：路由到首要对手，并披露「按陌生玩家处理」 */
  | 'BOUND_TO_PRIMARY_OPPONENT'
  /** 只给了显示名 ⇒ 不绑定持久身份 */
  | 'NAME_ONLY_NO_BINDING'
  /** ≥2 家对手 + 非座位口径 id ⇒ 无法判断属于谁，**不注入** */
  | 'AMBIGUOUS_MULTI_OPPONENT'
  /** 声明的座位/id 在本手对手集合里不存在 ⇒ **不注入、不回退到别人身上** */
  | 'SEAT_NOT_FOUND';

export type PlayerIdentityResolution = {
  readonly status: PlayerIdentityStatus;
  /** 画像目标座位（`null` ⇒ **不注入**任何画像） */
  readonly seatId: string | null;
  /** ① 玩家持久身份（`null` = 未绑定持久身份） */
  readonly persistentPlayerId: string | null;
  /**
   * 盖在**玩家快照 / 行为画像**上的 id —— **引擎口径座位 id**。
   *
   * ⚠️ 它**不是**持久身份（§六.4：不得把 `seat_BB` 当成玩家持久 id）。
   * 之所以仍然盖座位 id：`PlayerSnapshot.playerId` 是与
   * `RangeSnapshot.opponentId`（同一口径）并列展示/追溯的诊断字段，
   * 决策层与既有测试都用它指向「本手哪一家」。持久身份请读
   * `persistentPlayerId`。
   */
  readonly snapshotPlayerId: string;
  /** 给使用者看的一句话结论（界面可直接显示） */
  readonly noteZh: string;
  /** **必须如实披露**的推断/回退（`null` = 无话可说，即身份明确） */
  readonly disclosureZh: string | null;
};

const trimmed = (value: string | null | undefined): string | null => {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  return t.length === 0 ? null : t;
};

/**
 * 把调用方声明的身份映射到本手的**一个**对手座位。
 *
 * @param input.claim 调用方声明的身份（四个字段都可缺省）
 * @param input.opponentSeatIds 本手**对手**座位的 id（顺序稳定；不含 Hero）
 * @param input.primarySeatId 首要对手座位（`null` = 本手没有对手）
 */
export function resolvePlayerIdentity(input: {
  readonly claim: PlayerIdentityClaim;
  readonly opponentSeatIds: readonly string[];
  readonly primarySeatId: string | null;
}): PlayerIdentityResolution {
  const seats = Object.freeze([...new Set(input.opponentSeatIds.filter((s) => typeof s === 'string' && s.length > 0))]);
  const primary = input.primarySeatId;

  const claimSeat = trimmed(input.claim.seatId);
  const claimPlayer = trimmed(input.claim.playerId);
  const claimPersistent = trimmed(input.claim.persistentPlayerId);
  const claimName = trimmed(input.claim.displayName);

  /** 组装结果：只有 `seatId !== null` 才会注入画像 */
  const make = (
    status: PlayerIdentityStatus,
    seatId: string | null,
    noteZh: string,
    disclosureZh: string | null,
  ): PlayerIdentityResolution =>
    Object.freeze({
      status,
      seatId,
      persistentPlayerId: claimPersistent,
      snapshotPlayerId: seatId ?? '',
      noteZh,
      disclosureZh,
    });

  const none = (status: PlayerIdentityStatus, noteZh: string, disclosureZh: string): PlayerIdentityResolution =>
    make(status, null, noteZh, disclosureZh);

  /* ---- 1. 显式座位绑定（最明确） ---- */
  if (claimSeat !== null) {
    if (seats.includes(claimSeat)) {
      return make(
        'BOUND_BY_SEAT_ID',
        claimSeat,
        `身份已绑定：座位 ${claimSeat}${claimPersistent === null ? '（未提供持久 playerId）' : ` ← 玩家 ${claimPersistent}`}`,
        claimPersistent === null
          ? `玩家身份：座位 ${claimSeat} 上没有绑定持久 playerId ⇒ 画像是「本座位」口径，` +
            '不会去读取任何历史统计（不得把座位 id 当成玩家持久 id）。'
          : null,
      );
    }
    return none(
      'SEAT_NOT_FOUND',
      `身份未绑定：本手对手座位里没有 ${claimSeat}`,
      `玩家身份：指定的座位「${claimSeat}」不在本手对手座位（${seats.join('、') || '无'}）里 ⇒ ` +
        '**不注入任何画像**（不猜测绑定，也不会套到别的座位上）。请检查座位 id 或改用持久 playerId。',
    );
  }

  /* ---- 2. 引擎口径 id（向后兼容：它指的是座位） ---- */
  if (claimPlayer !== null && isEngineSeatId(claimPlayer)) {
    if (seats.includes(claimPlayer)) {
      return make(
        'BOUND_BY_SEAT_ID',
        claimPlayer,
        `身份已绑定：引擎口径 id ${claimPlayer}`,
        claimPersistent === null
          ? `玩家身份：只给了引擎口径 id「${claimPlayer}」（不是持久 playerId）⇒ 画像按本座位生效，未绑定历史统计。`
          : null,
      );
    }
    return none(
      'SEAT_NOT_FOUND',
      `身份未绑定：本手对手座位里没有 ${claimPlayer}`,
      `玩家身份：引擎口径 id「${claimPlayer}」不在本手对手座位（${seats.join('、') || '无'}）里 ⇒ **不注入任何画像**（不猜）。`,
    );
  }

  /* ---- 3. 自由文本 id（名字 / 遗留写法）：只有一家对手时按唯一槽位路由 ---- */
  if (claimPlayer !== null) {
    if (seats.length === 1) {
      return make(
        'BOUND_BY_SOLE_OPPONENT',
        seats[0]!,
        `身份按「本手唯一对手」路由到 ${seats[0]}`,
        `玩家身份：id「${claimPlayer}」既不是座位 id（${ENGINE_SEAT_ID_PREFIX}<位置>），也不是持久 playerId ⇒ ` +
          `已按「本手唯一对手」路由到 ${seats[0]}；**未做任何持久身份绑定**（不读历史统计）。` +
          '若要绑定已保存玩家，请传 `persistentPlayerId`（+ 可选 `seatId`）。',
      );
    }
    if (seats.length === 0) {
      return none(
        'SEAT_NOT_FOUND',
        '身份未绑定：本手没有可绑定的对手',
        `玩家身份：本手没有任何对手 ⇒ 不注入画像。`,
      );
    }
    return none(
      'AMBIGUOUS_MULTI_OPPONENT',
      `身份未绑定：本手有 ${seats.length} 家对手，无法判断「${claimPlayer}」是哪一家`,
      `玩家身份：id「${claimPlayer}」不是座位 id，而本手有 ${seats.length} 家对手（${seats.join('、')}）⇒ ` +
        '**不注入任何画像**（不猜是哪一家）。请显式传 `seatId`（或引擎口径 id）。',
    );
  }

  /* ---- 4. 持久 id（正式写法） ---- */
  if (claimPersistent !== null) {
    if (seats.length === 1) {
      return make(
        'BOUND_BY_PERSISTENT_ID',
        seats[0]!,
        `身份已绑定：玩家 ${claimPersistent} ← 座位 ${seats[0]}`,
        null,
      );
    }
    if (seats.length === 0) {
      return none(
        'SEAT_NOT_FOUND',
        '身份未绑定：本手没有可绑定的对手',
        `玩家身份：本手没有任何对手 ⇒ 不注入画像。`,
      );
    }
    return none(
      'AMBIGUOUS_MULTI_OPPONENT',
      `身份未绑定：本手有 ${seats.length} 家对手，玩家 ${claimPersistent} 坐在哪一家未指定`,
      `玩家身份：给了持久 id「${claimPersistent}」但本手有 ${seats.length} 家对手（${seats.join('、')}）⇒ ` +
        '**不注入任何画像**（不猜是哪一家）。请同时传 `seatId`。',
    );
  }

  /* ---- 5. 只有显示名：不绑定持久身份 ---- */
  if (claimName !== null) {
    return make(
      'NAME_ONLY_NO_BINDING',
      primary,
      primary === null ? '身份未绑定（本手没有对手）' : `身份：只给了显示名「${claimName}」，按首要对手 ${primary} 的槽位生效`,
      `玩家身份：只给了显示名「${claimName}」⇒ **不做持久身份绑定**（同名可能是不同人，按姓名合并画像就是编造数据）。` +
        '画像按「本手对手槽位」生效；要读取已保存玩家的历史统计，请传 `persistentPlayerId`。',
    );
  }

  /* ---- 6. 完全没有身份：行为保持（路由到首要对手）+ 如实披露 ---- */
  return make(
    'BOUND_TO_PRIMARY_OPPONENT',
    primary,
    primary === null ? '身份未提供（本手没有对手）' : `身份未提供：按首要对手 ${primary} 处理`,
    '玩家身份：未提供任何玩家身份（`persistentPlayerId` / `seatId`）⇒ 按**陌生玩家**处理：' +
      '不读取任何历史画像或实测统计（手选的 quickProfile / 内联 observedStats 仍按输入生效）。',
  );
}

/* ============================================================
 * 「已保存玩家」花名册查询（姓名 → 持久 id）
 * ============================================================ */

/**
 * 花名册条目。
 *
 * ⚠️ 它**不是**第二套玩家数据库：本项目的玩家记录仍然是
 * `PokerTableState.playersById`（+ 座位绑定 `TableSeat.playerId`），
 * 这里只是把它「投影」成查询用的最小形状。
 */
export type PlayerRosterEntry = {
  readonly playerId: string;
  readonly displayName?: string | null;
  readonly seatId?: string | null;
};

export type RosterSelection =
  | {
      readonly status: 'UNIQUE';
      readonly entry: PlayerRosterEntry;
      readonly matchedBy: 'PLAYER_ID' | 'DISPLAY_NAME';
      readonly noteZh: string;
    }
  | {
      readonly status: 'AMBIGUOUS';
      readonly candidates: readonly PlayerRosterEntry[];
      readonly noteZh: string;
    }
  | { readonly status: 'NOT_FOUND'; readonly noteZh: string };

/**
 * 把用户输入的「某个人」解析成唯一持久玩家。
 *
 * 判据顺序：**持久 id 精确命中** → 显示名精确命中（去空格、大小写敏感）。
 * 显示名命中 **多个不同持久 id** 时返回 `AMBIGUOUS`（界面必须让用户选），
 * **绝不**按顺序取第一个。
 */
export function resolveRosterSelection(input: {
  readonly query: string;
  readonly roster: readonly PlayerRosterEntry[];
}): RosterSelection {
  const query = input.query.trim();
  if (query.length === 0) {
    return { status: 'NOT_FOUND', noteZh: '没有输入要查找的玩家。' };
  }

  const byId = input.roster.filter((entry) => entry.playerId === query);
  if (byId.length === 1) {
    return {
      status: 'UNIQUE',
      entry: byId[0]!,
      matchedBy: 'PLAYER_ID',
      noteZh: `按持久 id 精确命中：${byId[0]!.playerId}`,
    };
  }
  if (byId.length > 1) {
    /* 持久 id 在本项目里是主键：重复即为数据损坏，同样按「待选择」处理而不是猜 */
    return {
      status: 'AMBIGUOUS',
      candidates: Object.freeze([...byId]),
      noteZh: `持久 id「${query}」在花名册里出现了 ${byId.length} 次（主键重复，数据异常）⇒ 待人工确认。`,
    };
  }

  const byName = input.roster.filter(
    (entry) => (entry.displayName ?? '').trim() === query,
  );
  if (byName.length === 1) {
    return {
      status: 'UNIQUE',
      entry: byName[0]!,
      matchedBy: 'DISPLAY_NAME',
      noteZh: `按显示名唯一命中：${query} → ${byName[0]!.playerId}`,
    };
  }
  if (byName.length > 1) {
    return {
      status: 'AMBIGUOUS',
      candidates: Object.freeze([...byName]),
      noteZh:
        `显示名「${query}」对应 ${byName.length} 个不同玩家（${byName
          .map((e) => e.playerId)
          .join('、')}）⇒ **必须由用户选择**，不按姓名自动合并画像。`,
    };
  }

  return { status: 'NOT_FOUND', noteZh: `花名册里没有「${query}」（既不是持久 id，也不是显示名）。` };
}
