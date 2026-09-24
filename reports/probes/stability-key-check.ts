/** 探针：gto-stability.json 的键 vs 真实缓存键 */
import { buildGtoScenario, cacheKeyOf } from '../../src/domain/gto/gtoScenario.ts';
import { GtoScenarioKind, GtoActionKind } from '../../src/domain/gto/gto.types.ts';
import { GtopenProvider, GTOPEN_DEFAULT_BUDGET } from '../../src/domain/gto/providers/gtopenProvider.ts';

const provider = new GtopenProvider({ budget: GTOPEN_DEFAULT_BUDGET });
for (const size of [4, 5, 6, 8, 9] as const) {
  const sc = buildGtoScenario({
    kind: GtoScenarioKind.RFI,
    tableSize: size,
    effectiveStackBB: 100,
    heroPosition: 'UTG' as never,
    actionHistory: [],
    openSizeBB: 2.5,
  });
  if (sc === null) { console.log(size, 'RFI/UTG null'); continue; }
  const solve = provider.solveKeyParts(sc);
  console.log(`${size}MAX RFI/UTG/100BB -> cacheKey=${cacheKeyOf(sc, solve)} treeId=${solve.treeId}`);
}
