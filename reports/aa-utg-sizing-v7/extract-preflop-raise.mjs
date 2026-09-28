import fs from "node:fs";
const p = "reports/gtopen-validation/9max-cold-solve-v1/analysis/raw-production-response.json";
const j = JSON.parse(fs.readFileSync(p, "utf8"));
const arr = j.raw?.viewModel?.debug?.preflopRaise;
console.log(Array.isArray(arr), arr?.length);
for (const [i, item] of (arr ?? []).entries()) {
  console.log(`--- [${i}] label=${item?.label ?? ""} ---`);
  console.log(String(item?.value ?? "").slice(0, 4000));
}
