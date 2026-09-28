import { preflopStrengthOf, PREFLOP_RAISE_TUNING } from "../../src/app/manualInput/preflopRaiseResponse.ts";
const classes = ["AA","KK","QQ","JJ","TT","99","88","77","66","55","44","33","22","AKs","AQs","AKo","KQs","AQo","AJs","KQo","A9s","JTs","ATs","KJs","A2s","76s"];
console.log("tuning", JSON.stringify(PREFLOP_RAISE_TUNING));
for (const k of classes) console.log(k.padEnd(4), preflopStrengthOf(k).toFixed(4));

