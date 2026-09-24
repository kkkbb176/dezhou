import { readFileSync } from 'node:fs';
import { buildPreflopRaiseResponse, preflopStrengthOf, rankClassOfIndices, PREFLOP_RAISE_TUNING } from '../../src/app/manualInput/preflopRaiseResponse.ts';
import { arrivalEntriesOf } from '../../src/app/manualInput/preflopRaiseFacts.ts';

const strategy = JSON.parse(readFileSync('reports/gtopen-validation/9max-cold-solve-repro/cache/strategy/c7348fc89.json','utf8'));
console.log('strategy top keys', Object.keys(strategy));
console.log('range keys', Object.keys(strategy.range ?? {}));
console.log('scenario', JSON.stringify(strategy.scenario));
console.log('solveMeta', JSON.stringify(strategy.solveMeta).slice(0,3000));
console.log('range compact', JSON.stringify(strategy.range).slice(0,7000));
