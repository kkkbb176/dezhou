import fs from "node:fs";
const p = "reports/gtopen-validation/9max-cold-solve-v1/analysis/raw-production-response.json";
const j = JSON.parse(fs.readFileSync(p, "utf8"));
function find(o, path = "", out = []) {
  if (o === null || typeof o !== "object") return out;
  for (const [k, v] of Object.entries(o)) {
    const p2 = `${path}.${k}`;
    if (k.toLowerCase().includes("preflop")) out.push([p2, Array.isArray(v) ? `array(${v.length})` : typeof v]);
    if (out.length < 80) find(v, p2, out);
  }
  return out;
}
console.log(JSON.stringify(find(j).slice(0, 80), null, 2));
