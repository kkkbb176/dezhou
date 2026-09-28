import { writeFileSync, mkdirSync } from 'node:fs';
const OUT = 'D:/德州决策/reports/aa-utg-sizing-v11';
mkdirSync(OUT, { recursive: true });

const comboMod = await import('file:///D:/德州决策/src/domain/range/combo.ts');
const respMod  = await import('file:///D:/德州决策/src/app/manualInput/preflopRaiseResponse.ts');
const typesMod = await import('file:///D:/德州决策/src/domain/types.ts');
const eqMod    = await import('file:///D:/德州决策/src/domain/poker/equity.ts');
const eqTypes  = await import('file:///D:/德州决策/src/domain/poker/equity.types.ts');
const fs = await import('node:fs');

const strat = JSON.parse(fs.readFileSync('D:/德州决策/reports/gtopen-validation/9max-cold-solve-repro/cache/strategy/c7348fc89.json','utf8'));
const ALL_CARDS = typesMod.ALL_CARDS;
const keyOf = (c) => `${typesMod.RANK_CHARS[c.rank]}${c.suit}`;
const heroKeys = new Set(['Ah','Ad']);
const RAISE_KINDS = new Set(['RAISE','ALL_IN']);

// ---------- arrival range (independent rebuild) ----------
const arrival = [];
for (const hand of strat.range.hands) {
  let w = 0;
  for (const a of hand.actions) if (RAISE_KINDS.has(a.kind)) w += a.frequency;
  w = Math.min(1, Math.max(0, w));
  if (!(w > 0)) continue;
  for (const combo of comboMod.COMBOS_BY_RANK_CLASS.get(hand.hand) ?? []) {
    if (heroKeys.has(keyOf(combo.card1)) || heroKeys.has(keyOf(combo.card2))) continue;
    arrival.push({ combo, probability: w });
  }
}
const totalMass = arrival.reduce((a,x)=>a+x.probability,0);
const arrivalNorm = arrival.map(x=>({ combo:x.combo, probability:x.probability/totalMass }));

// ---------- HAND-CODED response model (independent of production code) ----------
const RANKS = ['A','K','Q','J','T','9','8','7','6','5','4','3','2'];
const rankIdx = (ch) => RANKS.indexOf(ch);
function strengthOf(rc) {
  const isPair = rc.length === 2;
  const suited = rc.endsWith('s');
  const high = rankIdx(rc[0]), low = rankIdx(rc[1]);
  if (isPair) return 1 - 0.045*high;
  const connector = Math.abs(low-high-1) <= 1 ? 0.008 : 0;
  const v = 0.55 - 0.02*(high+low) + (suited?0.035:0) + connector;
  return Math.max(0.05, Math.min(0.99, v));
}
const MARGIN=0.19, GATE=0.44, VALUE_THRESHOLD=0.6, VALUE_FLOOR=0.25, MAX_SHARE=0.85, BLUFF_MAX=0.12;
function handResponse(strength, price, canReRaise) {
  const required = Math.max(0, price + MARGIN);
  if (strength < required) return { fold:1, call:0, rr:0 };
  let reRaiseShare = 0;
  if (canReRaise && strength >= GATE) {
    const span = 1 - GATE;
    const pos = span > 0 ? (strength - GATE)/span : 0;
    const isValue = strength >= VALUE_THRESHOLD;
    reRaiseShare = isValue ? VALUE_FLOOR + (MAX_SHARE-VALUE_FLOOR)*Math.max(0,Math.min(1,pos)) : 0;
  }
  reRaiseShare = Math.max(0, Math.min(1, reRaiseShare));
  return { fold:0, call:1-reRaiseShare, rr:reRaiseShare };
}

const sizes = [
  { sizeBB:4, raiseTo:400 }, { sizeBB:4.5, raiseTo:450 }, { sizeBB:6, raiseTo:600 },
  { sizeBB:7.5, raiseTo:750 }, { sizeBB:9, raiseTo:900 }, { sizeBB:12, raiseTo:1200 },
  { sizeBB:100, raiseTo:10000 },
];
const pot0=400, heroCommitted=100, villainCommitted=250, heroRemaining=9900, villainRemaining=9750;
const SEED = 1757000000000;
const ITER = 6000;

function equityVs(entries, seed) {
  const o = eqMod.computeEquity(
    [ {rank:14,suit:'h'}, {rank:14,suit:'d'} ], [],
    [ { label:'cond', combos: entries.map(e=>[e.combo.card1, e.combo.card2]) } ],
    { mode: eqTypes.EquityComputeMode.FAST, seed, iterations: ITER,
      opponentWeights: [ entries.map(e=>e.probability) ] },
  );
  return o.ok ? o.result.equity : null;
}

const rows = [];
for (const d of sizes) {
  const heroAdd = d.raiseTo - heroCommitted;
  const villainAddRaw = d.raiseTo - villainCommitted;
  const villainAdd = Math.min(villainAddRaw, villainRemaining);
  const villainTotal = villainCommitted + villainAdd;
  const contested = Math.min(heroAdd, villainTotal - heroCommitted);
  const finalPot = pot0 + contested + Math.min(villainAdd, contested);
  const heroIsAllIn = d.raiseTo >= 10000 - 1e-9;
  const villainIsAllInByCall = villainRemaining <= villainAdd + 1e-9;
  const price = villainAdd / finalPot;
  const canReRaise = !heroIsAllIn && !villainIsAllInByCall;

  let fold=0, call=0, rr=0;
  const callEntries=[], rrEntries=[];
  for (const e of arrivalNorm) {
    const p = e.probability;
    const s = strengthOf(e.combo.rankClass);
    const r = handResponse(s, price, canReRaise);
    fold += p*r.fold; call += p*r.call; rr += p*r.rr;
    if (r.call>0) callEntries.push({ combo:e.combo, probability:p*r.call });
    if (r.rr>0) rrEntries.push({ combo:e.combo, probability:p*r.rr });
  }
  const norm = (arr) => { const t = arr.reduce((a,x)=>a+x.probability,0); return t>0 ? arr.map(x=>({combo:x.combo, probability:x.probability/t})) : []; };
  const nCall = norm(callEntries), nRR = norm(rrEntries);

  const eqCall = equityVs(nCall, SEED+1301);
  const eqRR = nRR.length ? equityVs(nRR, SEED+2601) : null;

  // reraise branch winnable: villain min-reraises to raiseTo + (raiseTo - villainCommittedBefore)
  let rrFoldEV = -contested, rrCallEV = null, rrWinnable = null, reRaiseTo = null, additionalCall = null;
  if (canReRaise) {
    const minReRaiseTo = d.raiseTo + (d.raiseTo - villainCommitted);
    const villainMaxTo = villainTotal + Math.max(0, villainRemaining - villainAdd);
    reRaiseTo = Math.min(minReRaiseTo, villainMaxTo);
    additionalCall = Math.min(reRaiseTo - d.raiseTo, Math.max(0, heroRemaining - heroAdd));
    rrWinnable = pot0 + Math.max(heroAdd, reRaiseTo - heroCommitted) + villainAdd + additionalCall;
    rrCallEV = eqRR === null ? null : eqRR * rrWinnable - contested - additionalCall;
  }
  const rrBranchEV = rrCallEV === null ? rrFoldEV : Math.max(rrFoldEV, rrCallEV);
  const rrKind = rrCallEV === null ? 'FOLD_ONLY_UNAVAILABLE' : (rrCallEV > rrFoldEV + 1e-9 ? 'CALL' : 'FOLD');
  const raiseEV = eqCall === null ? null : fold*pot0 + call*(eqCall*finalPot - contested) + rr*rrBranchEV;

  rows.push({ sizeBB:d.sizeBB, raiseTo:d.raiseTo, heroAdd, villainAdd, villainTotal, contested, finalPot,
    heroIsAllIn, villainIsAllInByCall, price,
    f:fold, c:call, rr, sum:fold+call+rr,
    eqCall, eqRR, callCombos:nCall.length, rrCombos:nRR.length,
    reRaiseTo, additionalCall, rrWinnable, rrFoldEV, rrCallEV, rrBranchEV, rrKind, raiseEV });
}

writeFileSync(OUT+'/independent-full.json', JSON.stringify({ arrivalCombos: arrivalNorm.length, rows }, null, 2), 'utf8');
console.log('sizeBB  f      c      rr     sum      price  eqCall  eqRR   rrKind rrEV       raiseEV');
for (const r of rows) {
  console.log(String(r.sizeBB).padEnd(7), r.f.toFixed(4), r.c.toFixed(4), r.rr.toFixed(4),
    (r.sum).toFixed(8), r.price.toFixed(4),
    (r.eqCall ?? 0).toFixed(4), (r.eqRR ?? 0).toFixed(4),
    r.rrKind.padEnd(6), (r.rrBranchEV).toFixed(2).padStart(9), (r.raiseEV).toFixed(2).padStart(10));
}
