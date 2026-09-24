import fs from "node:fs";
const j = JSON.parse(fs.readFileSync("reports/gtopen-validation/9max-cold-solve-repro/hero-allin-explain.json","utf8"));
const pr = j.preflopRaise;
for (const item of pr) {
  console.log("==== " + (item && item.label) + " ====");
  console.log(String(item && item.value));
}
