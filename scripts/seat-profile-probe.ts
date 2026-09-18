/** 探针：逐座位画像 → 维度 → 响应倾向，到底有没有区别。 */
import { archetypeDimensionsOf } from '../src/domain/player/archetypeDimensions.ts';
import { responseTendenciesOf } from '../src/domain/postflop/betResponse.ts';
import { QUICK_PROFILE_CONFIDENCE } from '../src/app/manualInput/manualInput.ts';

for (const p of ['NORMAL', 'CALLING_STATION', 'VERY_TIGHT', 'MANIAC'] as const) {
  const dims = archetypeDimensionsOf(p, QUICK_PROFILE_CONFIDENCE);
  const t = responseTendenciesOf(dims, QUICK_PROFILE_CONFIDENCE);
  console.log(
    `${p}: dims=${dims === null ? 'null' : `tight ${dims.tightness} aggro ${dims.aggression} passive ${dims.passivity} bluff ${dims.bluffTendency}`}`,
  );
  console.log(
    `   call ×${t.callScale.toFixed(4)}｜fold ×${t.foldScale.toFixed(4)}｜raise ×${t.raiseScale.toFixed(4)}`,
  );
}
