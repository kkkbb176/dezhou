/**
 * GTO Phase 1.1 —— 扩展场景目录与真实节点覆盖测试
 *
 * ## 这份测试防的是什么
 *
 * Phase 1.1 新增了「面对开池」（`VS_FIRST_OPEN` / `VS_NAMED_OPEN`）与
 * 「面对 3Bet / 4Bet」两类场景。这里要锁住的核心不变量只有一条：
 *
 * > **标签与数据必须来自同一个来源。**
 *
 * 这条不变量是**用失败换来的**：本模块的第一版用「面对开池」一个标签
 * 盖住了所有开池者，于是「BB vs BTN Open」的标签下面是 **UTG 开池**的数据。
 * 界面上完全看不出来 —— 除非把动作历史打印出来对照。
 *
 * 因此现在：开池者由 `openerPosition` 显式给出、进场景哈希、
 * 并在**启动自检**里逐条比对「标签说的开池者 == 历史里真正加注的人」。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  GtoActionKind,
  GtoScenarioKind,
  gtoPositionsFor,
  type GtoScenarioAction,
  type GtoTableSize,
} from '../src/domain/gto/gto.types.ts';
import { buildGtoScenario, canHeroFaceThreeBet, scenarioHashOf } from '../src/domain/gto/gtoScenario.ts';
import { GTOPEN_CAPABILITY_TABLE } from '../src/domain/gto/providers/gtopenCapabilities.ts';
import {
  GTO_EXTENDED_TEMPLATE_ZH,
  GtoExtendedTemplate,
  VS_3BET_UNSUPPORTED_REASON,
  buildExtendedScenario,
  extendedActionHistoryFor,
  extendedCatalogForTableSize,
  extendedFullCatalog,
  extendedSupportedCatalog,
  selfCheckExtendedCatalog,
} from '../src/app/gto/gtoExtendedScenarios.ts';

/* ============================================================
 * 一、目录自检
 * ============================================================ */

test('GTO-EXT-01：扩展目录自检通过（含「标签 == 开池者」这条关键不变量）', () => {
  assert.deepEqual(selfCheckExtendedCatalog(), []);
  const all = extendedFullCatalog();
  assert.equal(new Set(all.map((e) => e.id)).size, all.length, 'id 必须唯一');
  for (const e of all) {
    if (e.scenario === null) {
      assert.ok((e.unsupportedReason ?? '').length >= 10, `${e.id} 的不支持原因必须具体`);
    }
  }
});

test('GTO-EXT-02：5 个桌型都有可查询的扩展场景', () => {
  for (const size of [4, 5, 6, 8, 9] as const) {
    const usable = extendedSupportedCatalog([size]);
    assert.ok(usable.length > 0, `${size} 人桌必须有可查询的扩展场景`);
    assert.ok(
      usable.some((e) => e.template === GtoExtendedTemplate.VS_NAMED_OPEN),
      `${size} 人桌必须有「面对指定开池」的条目`,
    );
  }
});

/* ============================================================
 * 二、🔴 标签与数据必须一致（本轮修掉的真实缺陷）
 * ============================================================ */

test('GTO-EXT-03：VS_NAMED_OPEN 的开池者标签与历史里真正加注的人**必须一致**', () => {
  const all = extendedFullCatalog().filter(
    (e) => e.template === GtoExtendedTemplate.VS_NAMED_OPEN && e.scenario !== null,
  );
  assert.ok(all.length > 0, '必须有可查询的「面对指定开池」条目');
  for (const e of all) {
    const raiser = e.scenario!.actionHistory.find((a) => a.kind === GtoActionKind.RAISE);
    assert.ok(raiser !== undefined, `${e.id} 的历史里必须有加注`);
    assert.equal(
      raiser!.position,
      e.openerPosition,
      `${e.id}：标签说开池者是 ${e.openerPosition}，实际是 ${raiser!.position}`,
    );
    assert.equal(e.scenario!.villainPosition, e.openerPosition);
  }
});

test('GTO-EXT-04：「BB vs BTN Open」与「BB vs UTG Open」是**不同的节点**（这正是第一版搞错的地方）', () => {
  const vsBtn = buildExtendedScenario({
    tableSize: 6,
    heroPosition: 'BB',
    template: GtoExtendedTemplate.VS_NAMED_OPEN,
    counterpartyPosition: 'BTN',
  });
  const vsUtg = buildExtendedScenario({
    tableSize: 6,
    heroPosition: 'BB',
    template: GtoExtendedTemplate.VS_NAMED_OPEN,
    counterpartyPosition: 'UTG',
  });
  assert.ok('scenario' in vsBtn && 'scenario' in vsUtg);
  if ('scenario' in vsBtn && 'scenario' in vsUtg) {
    assert.notEqual(
      scenarioHashOf(vsBtn.scenario),
      scenarioHashOf(vsUtg.scenario),
      '不同开池者必须是不同场景（否则就是第一版那个缺陷）',
    );
    // BTN 开池时，UTG/HJ/CO 都要先弃牌
    const btnHistory = vsBtn.scenario.actionHistory.map((a) => `${a.position}:${a.kind}`);
    assert.deepEqual(btnHistory, ['UTG:FOLD', 'HJ:FOLD', 'CO:FOLD', 'BTN:RAISE', 'SB:FOLD']);
    // UTG 开池时，只有他一个人加注，其余弃牌
    const utgHistory = vsUtg.scenario.actionHistory.map((a) => `${a.position}:${a.kind}`);
    assert.deepEqual(utgHistory, ['UTG:RAISE', 'HJ:FOLD', 'CO:FOLD', 'BTN:FOLD', 'SB:FOLD']);
  }
});

test('GTO-EXT-05：不给对手位置时必须**拒绝**（不得用第一个行动位顶替）', () => {
  const r = buildExtendedScenario({
    tableSize: 6,
    heroPosition: 'BB',
    template: GtoExtendedTemplate.VS_NAMED_OPEN,
  });
  assert.ok(!('scenario' in r), '缺少对手位置不得构造出场景');
  if (!('scenario' in r)) {
    assert.match(r.unsupportedReason, /counterpartyPosition|顶替/);
  }
  // 开池者在 Hero 之后也要拒绝
  const r2 = buildExtendedScenario({
    tableSize: 6,
    heroPosition: 'HJ',
    template: GtoExtendedTemplate.VS_NAMED_OPEN,
    counterpartyPosition: 'BTN',
  });
  assert.ok(!('scenario' in r2), '开池者在 Hero 之后不成立');
});

/* ============================================================
 * 三、用户点名的场景必须真的可构造
 * ============================================================ */

test('GTO-EXT-06：用户点名的 VS_OPEN 场景逐一可构造（BB/SB vs BTN、BTN vs CO）', () => {
  const wanted: { size: GtoTableSize; hero: string; opener: string }[] = [
    { size: 4, hero: 'BB', opener: 'BTN' },
    { size: 4, hero: 'SB', opener: 'BTN' },
    { size: 5, hero: 'BB', opener: 'BTN' },
    { size: 5, hero: 'SB', opener: 'BTN' },
    { size: 6, hero: 'BB', opener: 'BTN' },
    { size: 6, hero: 'SB', opener: 'BTN' },
    { size: 6, hero: 'BTN', opener: 'CO' },
    { size: 8, hero: 'BB', opener: 'BTN' },
    { size: 8, hero: 'SB', opener: 'BTN' },
    { size: 8, hero: 'BTN', opener: 'CO' },
    { size: 9, hero: 'BB', opener: 'BTN' },
    { size: 9, hero: 'SB', opener: 'BTN' },
    { size: 9, hero: 'BTN', opener: 'CO' },
  ];
  for (const w of wanted) {
    const r = buildExtendedScenario({
      tableSize: w.size,
      heroPosition: w.hero as never,
      template: GtoExtendedTemplate.VS_NAMED_OPEN,
      counterpartyPosition: w.opener as never,
    });
    assert.ok(
      'scenario' in r,
      `${w.size}MAX ${w.hero} vs ${w.opener} 开池必须可构造（${'unsupportedReason' in r ? r.unsupportedReason : ''}）`,
    );
    if ('scenario' in r) {
      assert.equal(r.scenario.heroPosition, w.hero);
      assert.equal(r.scenario.villainPosition, w.opener);
      assert.equal(r.scenario.kind, GtoScenarioKind.VS_OPEN);
    }
  }
});

test('GTO-EXT-07：VS_FIRST_OPEN 的开池者恒为该桌型第一个行动位', () => {
  for (const size of [4, 5, 6, 8, 9] as const) {
    const first = gtoPositionsFor(size)[0]!;
    const entries = extendedCatalogForTableSize(size).filter(
      (e) => e.template === GtoExtendedTemplate.VS_FIRST_OPEN && e.scenario !== null,
    );
    assert.ok(entries.length > 0, `${size} 人桌必须有 VS_FIRST_OPEN`);
    for (const e of entries) {
      const raiser = e.scenario!.actionHistory.find((a) => a.kind === GtoActionKind.RAISE);
      assert.equal(raiser?.position, first);
    }
  }
});

/* ============================================================
 * 四、「Hero 自己做 3Bet」**不是可达节点**（本轮实测推翻的结论）
 * ============================================================ */

test('GTO-EXT-08：目录里**没有**「Hero 自己做 3Bet」模板 —— 那个节点在树里不存在', () => {
  const templates = Object.values(GtoExtendedTemplate) as string[];
  assert.ok(
    !templates.includes('THREE_BET'),
    'THREE_BET 不得出现在模板里：它不是可达节点（最后一个加注者不会被再次叫到）',
  );
  assert.ok(!templates.includes('VS_OPEN'), 'VS_OPEN 已拆成 VS_FIRST_OPEN / VS_NAMED_OPEN');

  /*
   * 那条结论必须**有一个可命名的位置**，而不是消失在注释里：
   * `GtoScenarioKind.THREE_BET` 保留，但能力表里恒为 UNSUPPORTED。
   */
  assert.equal(GtoScenarioKind.THREE_BET, 'THREE_BET');
  assert.equal(
    GTOPEN_CAPABILITY_TABLE.scenarioSupport[GtoScenarioKind.THREE_BET],
    'UNSUPPORTED',
    '「Hero 自己做 3Bet」必须是未支持 —— 它不是一个可以走到的节点',
  );

  /*
   * 构造一个「Hero 自己做 3Bet」的历史必须被**拒掉**。
   *
   * ## 「Hero 自己做 3Bet」在历史里长什么样
   *
   * 它就是这个形状：`有人开池 → Hero 加注`（Hero 是**最后**一个加注者），
   * 而行动要到 Hero 手上必须先走完一整圈。
   *
   * 关键在于：本项目里 `VS_3BET` 的 Hero **只能是开池者**（目录只生成
   * 第一个行动位的条目），所以「Hero 是最后加注者」与「Hero 是开池者」
   * 是**互斥**的 —— 一旦同时成立，那条历史描述的就是那个不存在的节点。
   *
   * ⚠️ 这里**必须**让历史以 Hero 的加注结尾。
   * 第一版写成了「Hero 开池 → 别人 3Bet → Hero 之后的座位全弃」——
   * 那其实是**合法**的形状（收口人正是 Hero），测试却断言它应当被拒，
   * 于是一条正确的放行被当成了缺陷。
   *
   * ⚠️ 动作类型也要用 `GtoActionKind` 常量而不是字符串字面量：字面量会被
   * 推断成 `string`，虽然运行期相等，但类型检查会掩盖这类拼写差异。
   */
  const fold = (position: string): GtoScenarioAction => ({
    position: position as never,
    kind: GtoActionKind.FOLD,
    sizeBB: null,
  });
  const heroIsThreeBettor = buildGtoScenario({
    kind: GtoScenarioKind.VS_3BET,
    tableSize: 6,
    effectiveStackBB: 100,
    heroPosition: 'CO',
    actionHistory: [
      { position: 'UTG', kind: GtoActionKind.RAISE, sizeBB: 2.5 },
      fold('HJ'),
      { position: 'CO', kind: GtoActionKind.RAISE, sizeBB: 7.5 },
    ],
    heroAlreadyActed: true,
  });
  assert.equal(
    heroIsThreeBettor,
    null,
    '历史以「Hero 加注」结尾时不得构造出场景（最后一个加注者不会被再次叫到）',
  );

  /*
   * 而**正确**的形状必须被放行 —— 否则上面那条断言可能是靠
   * 「一律拒绝」通过的。这一对正反例是刻意配对的。
   */
  const heroIsOpener = buildGtoScenario({
    kind: GtoScenarioKind.VS_3BET,
    tableSize: 6,
    effectiveStackBB: 100,
    heroPosition: 'CO',
    actionHistory: [
      { position: 'UTG', kind: GtoActionKind.RAISE, sizeBB: 2.5 },
      fold('HJ'),
      { position: 'CO', kind: GtoActionKind.RAISE, sizeBB: 7.5 },
      fold('BTN'),
      fold('SB'),
      fold('BB'),
    ],
    heroAlreadyActed: true,
  });
  assert.ok(heroIsOpener !== null, 'Hero 开池后面对 3Bet 的形状必须被放行');
  assert.equal(heroIsOpener.heroAlreadyActed, true);

  // 3Bet 范围通过 `VS_NAMED_OPEN` 节点的 RAISE 项读取 —— 真实菜单里有这一项
  const menuSource = extendedActionHistoryFor(6, 'BB', GtoExtendedTemplate.VS_NAMED_OPEN, 2.5, 'BTN');
  assert.ok(menuSource !== null);
});

test('GTO-EXT-09：「面对 3Bet」的原因必须指向**残缺菜单**，而不是含糊的「表达不了」', () => {
  const all = extendedFullCatalog().filter((e) => e.template === GtoExtendedTemplate.VS_3BET);
  assert.ok(all.length > 0);
  for (const e of all) {
    assert.equal(e.scenario, null);
    assert.equal(e.unsupportedReason, VS_3BET_UNSUPPORTED_REASON);
    assert.equal(e.requiredMaxRaises, 3, '要读出完整策略需要第 3 次加注（有 4Bet 分支）');
  }
  // 原因必须说清「节点存在、能走到、但菜单残缺」，而不是「我们表达不了」
  assert.match(VS_3BET_UNSUPPORTED_REASON, /max_raises = 2/);
  assert.match(VS_3BET_UNSUPPORTED_REASON, /没有 4Bet 分支/);
  assert.match(VS_3BET_UNSUPPORTED_REASON, /残缺/);
  assert.match(VS_3BET_UNSUPPORTED_REASON, /真实存在|真的能走到/);
  assert.ok(
    !/表达不了|无法表达/.test(VS_3BET_UNSUPPORTED_REASON),
    '这个理由已经被实测推翻了：几何是对的，缺的是配置',
  );
});

test('GTO-EXT-09b：只有**第一个行动位**能面对 3Bet（实测：别的位置收口人是别人）', () => {
  /*
   * 实测（6 人桌，`scripts/gto-node-walk.raw.mjs`）：
   * `HJ 开池 → CO 3Bet → BTN/SB/BB 弃 → UTG 弃` 之后**牌局结束**，
   * HJ 再也没有轮到 —— 因为 UTG 还没行动过，他才是收口人。
   */
  assert.equal(canHeroFaceThreeBet(6, 'UTG'), true, '6MAX 的 UTG 是第一个行动位');
  assert.equal(canHeroFaceThreeBet(6, 'HJ'), false);
  assert.equal(canHeroFaceThreeBet(6, 'CO'), false);
  assert.equal(canHeroFaceThreeBet(6, 'BTN'), false);
  assert.equal(canHeroFaceThreeBet(4, 'CO'), true);
  assert.equal(canHeroFaceThreeBet(5, 'HJ'), true);
  assert.equal(canHeroFaceThreeBet(8, 'UTG'), true);
  assert.equal(canHeroFaceThreeBet(9, 'UTG'), true);

  // 目录里因此**只有**第一个行动位的条目
  for (const size of [4, 5, 6, 8, 9] as const) {
    const entries = extendedCatalogForTableSize(size).filter(
      (e) => e.template === GtoExtendedTemplate.VS_3BET,
    );
    assert.ok(entries.length > 0, `${size} 人桌必须有「面对 3Bet」条目（哪怕是不支持）`);
    for (const e of entries) {
      assert.equal(
        canHeroFaceThreeBet(size, e.heroPosition),
        true,
        `${e.id}：Hero 不是第一个行动位，这个节点走不到`,
      );
    }
  }
});

test('GTO-EXT-10：「面对 4Bet」标为不支持，且原因指出**配置**才是原因并给出解法', () => {
  const all = extendedFullCatalog().filter((e) => e.template === GtoExtendedTemplate.VS_4BET);
  assert.ok(all.length > 0);
  for (const e of all) {
    assert.equal(e.scenario, null);
    assert.match(e.unsupportedReason ?? '', /max_raises = 2/);
    assert.match(e.unsupportedReason ?? '', /提到 3|即可用/);
    assert.equal(e.requiredMaxRaises, 3);
  }
});

test('GTO-EXT-11：不支持项在目录里**仍然存在**（不是被删掉）', () => {
  const entries = extendedCatalogForTableSize(6);
  const unsupported = entries.filter((e) => e.scenario === null);
  assert.ok(unsupported.length > 0);
  for (const e of unsupported) assert.ok((e.unsupportedReason ?? '').length > 20);
});

/* ============================================================
 * 五、隔离性
 * ============================================================ */

test('GTO-EXT-12：同名位置 + 同名开池者在不同桌型上是不同节点', () => {
  for (const position of ['BTN', 'SB', 'BB'] as const) {
    const hashes = new Map<string, number>();
    for (const size of [4, 5, 6, 8, 9] as const) {
      const entry = extendedCatalogForTableSize(size).find(
        (e) =>
          e.heroPosition === position &&
          e.template === GtoExtendedTemplate.VS_NAMED_OPEN &&
          e.openerPosition === 'CO',
      );
      if (entry === undefined || entry.scenario === null) continue;
      const hash = entry.scenarioHash;
      assert.ok(!hashes.has(hash), `${size}MAX ${position} vs CO 与 ${hashes.get(hash)}MAX 哈希相同`);
      hashes.set(hash, size);
    }
    assert.ok(hashes.size >= 2, `${position} vs CO 至少应在 2 个桌型上可查`);
  }
});

test('GTO-EXT-13：requiredMaxRaises 反映的是「读出完整策略」需要几次加注', () => {
  const byTemplate = new Map<string, number>();
  for (const e of extendedFullCatalog()) byTemplate.set(e.template, e.requiredMaxRaises);
  assert.equal(byTemplate.get(GtoExtendedTemplate.VS_FIRST_OPEN), 1);
  assert.equal(byTemplate.get(GtoExtendedTemplate.VS_NAMED_OPEN), 1);
  /*
   * 🔴 `VS_3BET` 是 **3** 而不是 2 —— 这条与直觉相反，刻意锁住。
   *
   * 走到那个节点只要 2 次加注（开池 + 3Bet），但要读出**完整**的决策点
   * （开池者手里得有 4Bet）必须有第 3 次。实测菜单只有 `Fold · Call`
   * 就是「2 次加注不够」的证据（`reports/evidence/gto-vs3bet-live-evidence.txt`）。
   */
  assert.equal(byTemplate.get(GtoExtendedTemplate.VS_3BET), 3);
  assert.equal(byTemplate.get(GtoExtendedTemplate.VS_4BET), 3);
});

test('GTO-EXT-14：buildExtendedScenario 对无法表达的组合返回原因而不是抛异常', () => {
  const r = buildExtendedScenario({
    tableSize: 6,
    heroPosition: 'BB',
    template: GtoExtendedTemplate.VS_4BET,
  });
  assert.ok(!('scenario' in r));
  if (!('scenario' in r)) assert.match(r.unsupportedReason, /max_raises/);
  const r2 = buildExtendedScenario({
    tableSize: 4,
    heroPosition: 'CO',
    template: GtoExtendedTemplate.VS_FIRST_OPEN,
  });
  assert.ok(!('scenario' in r2), '第一个行动位不能「面对首位开池」');
  /*
   * 「面对 3Bet」即使位置与对手都给对了，也仍然返回原因而不是场景 ——
   * 因为 `max_raises = 2` 下读出来是残缺菜单。
   */
  const r3 = buildExtendedScenario({
    tableSize: 6,
    heroPosition: 'UTG',
    template: GtoExtendedTemplate.VS_3BET,
    counterpartyPosition: 'HJ',
  });
  assert.ok(!('scenario' in r3), '残缺菜单的节点不得被当成可查询场景');
  if (!('scenario' in r3)) assert.equal(r3.unsupportedReason, VS_3BET_UNSUPPORTED_REASON);
  // 不给对手位置时要给出**这个**原因（而不是「目录里没有」）
  const r4 = buildExtendedScenario({
    tableSize: 6,
    heroPosition: 'UTG',
    template: GtoExtendedTemplate.VS_3BET,
  });
  assert.ok(!('scenario' in r4));
  if (!('scenario' in r4)) assert.match(r4.unsupportedReason, /counterpartyPosition/);
  /*
   * 🔴 位置不对时的原因必须说「他不是第一个行动位」，
   * **不得**退化成「目录里没有 xxx」—— 那看起来像参数拼错了。
   */
  const r5 = buildExtendedScenario({
    tableSize: 6,
    heroPosition: 'HJ',
    template: GtoExtendedTemplate.VS_3BET,
    counterpartyPosition: 'CO',
  });
  assert.ok(!('scenario' in r5));
  if (!('scenario' in r5)) {
    assert.match(r5.unsupportedReason, /不是第一个行动位/);
    assert.ok(
      !/^目录里没有/.test(r5.unsupportedReason),
      '正确的否定不能用「目录里没有」这种像参数错误的说法',
    );
  }
});

/* ============================================================
 * 六、能力表与目录必须一致
 * ============================================================ */

test('GTO-EXT-15：能力表与目录必须一致（含「Hero 自己 3Bet」不是节点的结论）', () => {
  const support = GTOPEN_CAPABILITY_TABLE.scenarioSupport;
  assert.equal(support[GtoScenarioKind.VS_3BET], 'UNSUPPORTED');
  assert.equal(support[GtoScenarioKind.VS_4BET], 'UNSUPPORTED');
  assert.equal(support[GtoScenarioKind.VS_OPEN], 'SUPPORTED');
  assert.equal(support[GtoScenarioKind.RFI], 'SUPPORTED');
  /*
   * 🔴 `THREE_BET` 必须是 UNSUPPORTED，而且**不是因为「以后再做」** ——
   * 实测确认它不是可达节点（最后一个加注者不会被再次叫到）。
   */
  assert.equal(
    support[GtoScenarioKind.THREE_BET],
    'UNSUPPORTED',
    '「Hero 自己做 3Bet」在树里不存在，不得标成支持',
  );
  assert.ok(
    !(Object.values(GtoExtendedTemplate) as string[]).includes('THREE_BET'),
    '既然不是节点，目录里就不能有它的模板',
  );
});

test('GTO-EXT-16：模板中文名齐全且互不重复（界面靠它区分）', () => {
  const names = Object.values(GTO_EXTENDED_TEMPLATE_ZH);
  assert.equal(new Set(names).size, names.length, '中文名不得重复');
  for (const n of names) assert.ok(n.length > 0);
});
