const BASE = "http://127.0.0.1:3737";
const ORDER = {
  4: ["CO","BTN","SB","BB"],
  5: ["HJ","CO","BTN","SB","BB"],
  6: ["UTG","HJ","CO","BTN","SB","BB"],
  8: ["UTG","UTG1","LJ","HJ","CO","BTN","SB","BB"],
  9: ["UTG","UTG1","UTG2","LJ","HJ","CO","BTN","SB","BB"],
};
function config(size, {open=[2.5], mults=[3], maxRaises=2, limp=true, addAllin=false}={}) {
  const positions = ORDER[size];
  const posts = positions.map(p => p === "SB" ? 0.5 : p === "BB" ? 1 : 0);
  return { positions, stack: 100, posts, ante: 0, limp, open_raises: open, raise_mults: mults,
           max_raises: maxRaises, add_allin: addAllin, rake_pct: 0, rake_cap: 0,
           no_flop_no_drop: true, realization: "static", call_only_seats: [],
           open_raises_by_seat: null, raise_mults_by_seat: null };
}
async function estimate(cfg) {
  const t0 = Date.now();
  const r = await fetch(BASE + "/api/preflop/estimate", { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify(cfg) });
  const j = await r.json();
  return { status: r.status, ms: Date.now()-t0, ...j };
}
for (const size of [4,5,6,8,9]) {
  const e = await estimate(config(size));
  console.log(`size=${size} open=[2.5] mults=[3] maxRaises=2  -> status=${e.status} nodes=${e.nodes} actionNodes=${e.action_nodes} arenaMB=${e.arena_mb?.toFixed(1)} ok=${e.ok} truncated=${e.truncated} (${e.ms}ms)`);
}
