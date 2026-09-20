/** Agent 9 · 探针 0：字段发现（只读）—— 打印 diagnostics / postflop / math / legal 的键 */
import { A_, BASE, MANIAC, detailOf, line, kv, rule } from './flopriver-agent4-lib.ts';
import type { ManualHandInput } from '../src/app/manualInput/manualInput.ts';

const HISTORY = [
  A_('UTG', 'FOLD'), A_('HJ', 'FOLD'), A_('CO', 'FOLD'),
  A_('BTN', 'RAISE', 3), A_('SB', 'FOLD'), A_('BB', 'CALL', 2),
  A_('BB', 'CHECK', undefined, 'FLOP'), A_('BTN', 'BET', 4, 'FLOP'), A_('BB', 'CALL', 4, 'FLOP'),
  A_('BB', 'BET', 10, 'TURN'),
];
const input = { ...BASE, heroCards: ['9h', '9c'], board: ['Jd', '8c', '4c', '6s'], street: 'TURN', actionHistory: HISTORY, villain: MANIAC } as unknown as ManualHandInput;

const d = detailOf(input);
line(rule());
line(` diagnostics keys: ${Object.keys(d.dg).join(', ')}`);
line(rule());
line(` postflop keys: ${Object.keys(d.pf).join(', ')}`);
line(rule());
line(` math keys: ${Object.keys(d.math).join(', ')}`);
line(rule());
line(` legal keys: ${Object.keys(d.legal).join(', ')}`);
line(rule());
line(` built keys: ${Object.keys(d.built).join(', ')}`);
line(rule());
kv('decision.action', `${String(d.decision['action'])} ${String(d.decision['sizeChips'] ?? '')}`);
kv('classification', d.decision['classification']);
kv('confidence', d.decision['confidence']);
for (const k of Object.keys(d.pf)) {
  const v: any = (d.pf as any)[k];
  if (v !== null && typeof v === 'object') line(`  · pf.${k} keys: ${Object.keys(v).slice(0, 40).join(', ')}`);
}
