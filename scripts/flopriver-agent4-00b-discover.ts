/** Agent 9 · 探针 0b：字段发现 2（player / profileRange / betDecision / postflopAdvisor 子字段） */
import { A_, BASE, MANIAC, detailOf, line, kv, rule, J } from './flopriver-agent4-lib.ts';
import type { ManualHandInput } from '../src/app/manualInput/manualInput.ts';

const HISTORY = [
  A_('UTG', 'FOLD'), A_('HJ', 'FOLD'), A_('CO', 'FOLD'),
  A_('BTN', 'RAISE', 3), A_('SB', 'FOLD'), A_('BB', 'CALL', 2),
  A_('BB', 'CHECK', undefined, 'FLOP'), A_('BTN', 'BET', 4, 'FLOP'), A_('BB', 'CALL', 4, 'FLOP'),
  A_('BB', 'CHECK', undefined, 'TURN'),
];
const input = { ...BASE, heroCards: ['Ac', 'Jc'], board: ['Jd', '8c', '4c', '6s'], street: 'TURN', actionHistory: HISTORY, villain: MANIAC } as unknown as ManualHandInput;
const d = detailOf(input);
line(rule());
kv('dg.player', J(d.dg['player'], 1600));
line(rule());
kv('dg.profileRange', J(d.dg['profileRange'], 900));
line(rule());
kv('dg.range', J(d.dg['range'], 700));
line(rule());
kv('dg.opponentRanges', J(d.dg['opponentRanges'], 700));
line(rule());
const bd = (d.pf['betDecision'] ?? null) as Record<string, any> | null;
kv('betDecision keys', bd === null ? 'null' : Object.keys(bd).join(', '));
kv('betDecision.tendencies', bd === null ? '' : J(bd['tendencies'], 900));
kv('betDecision.tendenciesZh', bd === null ? '' : J(bd['tendenciesZh'], 500));
kv('betDecision.modelNoteZh', bd === null ? '' : J(bd['modelNoteZh'], 400));
kv('betDecision.sizes[0]', bd === null ? '' : J((bd['sizes'] as any[])[0], 1200));
kv('betDecision.legalSizes', bd === null ? '' : J(bd['legalSizes'], 600));
kv('betDecision.profileEvidence', bd === null ? '' : J(bd['profileEvidence'], 600));
kv('betDecision.checkTree', bd === null ? '' : J(bd['checkTree'], 900));
