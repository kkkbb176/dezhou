import { writeFileSync, mkdirSync } from 'node:fs';

const OUT = 'D:/德州决策/reports/aa-utg-sizing-v11';
mkdirSync(OUT, { recursive: true });

const comboMod = await import('file:///D:/德州决策/src/domain/range/combo.ts');
const respMod  = await import('file:///D:/德州决策/src/app/manualInput/preflopRaiseResponse.ts');
const typesMod = await import('file:///D:/德州决策/src/domain/types.ts');

const ALL_COMBOS = comboMod.ALL_COMBOS;
const cardKeyOf = (c) => `${typesMod.RANK_CHARS[c.rank]}${c.suit}`;
const idxOf = (c) => ALL_COMBOS; // placeholder

const fs = await import('node:fs');
const strat = JSON.parse(fs.readFileSync('D:/德州决策/reports/gtopen-validation/9max-cold-solve-repro/cache/strategy/c7348fc89.json','utf8'));

// ---- 1. rebuild arrival range from solver cache, IndEPENDENTLY of production code ----
const heroCards = [ {rank:14,suit:'h'}, {rank:14,suit:'d'} ];
const heroKeys = new Set(['Ah','Ad']);
const RAISE_KINDS = new Set(['RAISE','ALL_IN']);
const arrival = [];
let solverWeightMass = 0;
for (const hand of strat.range.hands) {
  let w = 0;
  for (const a of hand.actions) if (RAISE_KINDS.has(a.kind)) w += a.frequency;
  w = Math.min(1, Math.max(0, w));
  if (!(w > 0)) continue;
  solverWeightMass += w;
  for (const combo of comboMod.COMBOS_BY_RANK_CLASS.get(hand.hand) ?? []) {
    const k1 = cardKeyOf(combo.card1), k2 = cardKeyOf(combo.card2);
    if (heroKeys.has(k1) || heroKeys.has(k2)) continue;
    arrival.push({ cardIndices: combo.cardIndices, probability: w });
  }
}
const arrivalMass = arrival.reduce((a,x)=>a+x.probability,0);
const arrivalNorm = arrival.map(x=>({ cardIndices:x.cardIndices, probability:x.probability/arrivalMass }));

console.log('solverWeightMass', solverWeightMass);
console.log('arrival combos (dead-card filtered)', arrivalNorm.length);

// ---- 2. replay response model via production function (same formula, our range) ----
const rows = [];
const priceOf = (villainAdd, finalPot) => villainAdd / finalPot;
const sizeDefs = [
  { sizeBB: 4,   raiseTo: 400  },
  { sizeBB: 4.5, raiseTo: 450  },
  { sizeBB: 6,   raiseTo: 600  },
  { sizeBB: 7.5, raiseTo: 750  },
  { sizeBB: 9,   raiseTo: 900  },
  { sizeBB: 12,  raiseTo: 1200 },
  { sizeBB: 100, raiseTo: 10000 },
];
const pot0 = 400, heroCommitted = 100, villainCommitted = 250, heroRemaining = 9900, villainRemaining = 9750;
for (const d of sizeDefs) {
  const heroAdd = d.raiseTo - heroCommitted;
  const villainAddRaw = Math.max(0, d.raiseTo - villainCommitted);
  const villainAdd = Math.min(villainAddRaw, villainRemaining);
  const villainTotal = villainCommitted + villainAdd;
  const contested = Math.max(0, Math.min(heroAdd, villainTotal - heroCommitted));
  const finalPot = pot0 + contested + Math.min(villainAdd, contested);
  const heroIsAllIn = d.raiseTo >= 10000 - 1e-9;
  const villainIsAllInByCall = villainRemaining <= villainAdd + 1e-9;
  const r = respMod.buildPreflopRaiseResponse({
    arrivalEntries: arrivalNorm,
    currentPot: pot0, heroAdd, villainAdd, finalPot,
    tendencies: { callScale:1, foldScale:1, raiseScale:1, bluffRaiseScale:1 },
    heroIsAllIn, villainIsAllInByCall,
  });
  if (!r) { rows.push({ sizeBB:d.sizeBB, error:'null response' }); continue; }
  rows.push({
    sizeBB: d.sizeBB, raiseTo: d.raiseTo, heroAdd, villainAdd, finalPot,
    f: r.foldLikelihood, c: r.callLikelihood, rr: r.reRaiseLikelihood,
    sum: r.foldLikelihood + r.callLikelihood + r.reRaiseLikelihood,
    conditionalRR: (1-r.foldLikelihood)>0 ? r.reRaiseLikelihood/(1-r.foldLikelihood) : null,
    price: r.priceRequiredEquity, requiredStrength: r.requiredStrength,
    callCombos: r.callCombos, reRaiseCombos: r.reRaiseCombos, reachable: r.reachableCombos,
    note: r.noteZh,
  });
}
writeFileSync(OUT + '/independent-replay.json', JSON.stringify({ arrivalCombos: arrivalNorm.length, arrivalMass, rows }, null, 2), 'utf8');
for (const r of rows) console.log(r.sizeBB, 'f='+r.f.toFixed(4), 'c='+r.c.toFixed(4), 'rr='+r.rr.toFixed(4), 'sum='+r.sum.toFixed(6), 'callCombos='+r.callCombos, 'rrCombos='+r.reRaiseCombos);
