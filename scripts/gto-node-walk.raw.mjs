/**
 * 直接走 GTOpen 的 `/api/preflop/node`，把每个节点的**行动者**打出来。
 *
 * 这个脚本不看本项目的任何场景模型，只问求解器：
 * 「按这条路径走下去，每一步轮到谁」—— 用来判定几何，而不是推断几何。
 *
 * 用法：
 *   node --experimental-strip-types scripts/gto-node-walk.raw.mjs 6 "0,0" "1,0,0" ...
 */

const baseUrl = process.env['GTOPEN_URL'] ?? 'http://127.0.0.1:3737';
const size = Number(process.argv[2] ?? 6);
const session = await (await fetch(`${baseUrl}/api/preflop/session`)).json();
const positions = session?.config?.positions ?? session?.positions ?? [];
console.log(`会话 positions（${positions.length}）: ${positions.join(' ')}  期望桌型 ${size}`);

const paths = process.argv.slice(3);
if (paths.length === 0) {
  console.log('请给出至少一条路径，例如 "1,0,0,2,0,0"');
  process.exit(0);
}

for (const raw of paths) {
  const path = raw === '' ? [] : raw.split(',').map(Number);
  const res = await fetch(`${baseUrl}/api/preflop/node`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path }),
  });
  if (!res.ok) {
    console.log(`路径 [${path.join(',')}] → HTTP ${res.status}`);
    continue;
  }
  const node = await res.json();
  const actor = node.actor;
  const actorPos = node.actorPos ?? node.actor_pos ?? (actor === null ? null : positions[actor]);
  const actions = (node.actions ?? [])
    .map((a, i) => `${i}:${a.label ?? a.kind}`)
    .join('  ');
  console.log(
    `路径 [${path.join(',')}] → 行动者 ${actorPos}（座位 ${actor}）` +
      `  kind=${node.kind}  toCall=${node.toCall ?? node.to_call ?? '?'}` +
      `\n    菜单：${actions}`,
  );
}
