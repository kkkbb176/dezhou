/**
 * 只读审计工具：把 `src/app/manualInput/contextBuilder.ts` 的**私有函数**
 * 暴露给探针脚本使用。
 *
 * 做法：读源码 → 只重写**相对导入路径**（使其在 scripts/ 下可解析）→
 * 在文件末尾追加一条 `export { ... }`。
 * 产品代码**一个字节都没有改动**；本文件与生成的影子模块都是临时审计产物。
 */
import { readFileSync, writeFileSync } from 'node:fs';

const SRC = 'src/app/manualInput/contextBuilder.ts';
const OUT = 'scripts/__shadow-contextBuilder.ts';

let text = readFileSync(SRC, 'utf8');

// 相对导入重写：源文件位于 src/app/manualInput/，影子位于 scripts/
text = text.replace(/(from\s+')(\.\.\/\.\.\/|\.\.\/manualInput\/|\.\/)/g, (_m, p1: string, p2: string) => {
  if (p2 === '../../') return `${p1}../src/`;
  if (p2 === '../manualInput/') return `${p1}../src/app/manualInput/`;
  return `${p1}../src/app/manualInput/`; // './'
});

const EXPORTS = [
  'buildRangeSnapshot',
  'buildPlayerSnapshot',
  'nodeActionContextOf',
  'firstPreflopActionOf',
  'boardAtStreetOf',
  'rangeEquityOfMany',
  'TENDENCY_TIER_ZH',
  'QUICK_PROFILE_CONFIDENCE',
];

text +=
  '\n/* ==== AUDIT SHADOW EXPORTS (temp) ==== */\n' +
  `export { ${EXPORTS.join(', ')} };\n`;

writeFileSync(OUT, text, 'utf8');
console.log(`wrote ${OUT}: ${text.split('\n').length} lines`);
