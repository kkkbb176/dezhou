import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const context: Record<string, any> = {};
runInNewContext(readFileSync(new URL('../src/app/web/fast-input.js', import.meta.url), 'utf8'), context);
const { parseAmount, formatBB } = context.FastInput;

test('金额输入：整数筹码与十进制 BB 必须精确等价，不经过浮点取整', () => {
  for (const [text, unit, blind, chips] of [
    ['1000', 'CHIPS', 100, 1000], ['10', 'BB', 100, 1000], ['2.505', 'BB', 200, 501],
    ['0.29', 'BB', 100, 29], [' 1,234.00 ', 'CHIPS', 100, 1234],
    ['0.01', 'BB', 100, 1], ['9007199254740991','CHIPS',100,Number.MAX_SAFE_INTEGER],
  ] as const) assert.equal(parseAmount(text, unit, blind).chips, chips);
});

test('金额输入：拒绝空值、无穷、NaN、负数、科学计数、错误分组及零碎筹码', () => {
  for (const text of ['', ' ', '-1', '0', 'NaN', 'Infinity', '1e3', '+10', '1,00', '0x10', '1.001', '9007199254740992']) {
    assert.ok(parseAmount(text,'CHIPS',100).error, text);
  }
  assert.ok(parseAmount('2.501','BB',200).error);
  assert.ok(parseAmount('0.001','BB',100).error);
});

test('金额输入：常用整数盲注精度的显示/解析往返保持金额', () => {
  for (const blind of [2,5,10,20,50,100,200,500]) {
    for (const chips of [1,7,29,501,12345,100000]) {
      assert.equal(parseAmount(formatBB(chips,blind),'BB',blind).chips,chips);
    }
  }
});
import { createTableJsHarness } from './helpers/tableJsHarness.ts';

test('server cooperative deadline is displayed as timeout, not generic failure', async () => {
  const h = await createTableJsHarness({ tableSize: 6, heroPosition: 'UTG' });
  h.clickHeroCard('As'); await h.settle(); h.clickHeroCard('Kd'); await h.settle();
  h.setAnalyzePayload({ ok: false, stage: 'DEADLINE', issues: [{ code: 'DEADLINE_EXCEEDED', message: '计算超过时间预算' }] });
  h.clickAnalyzeButton(); await h.settle();
  assert.match(h.text('autoAnalyzeLine'), /超时/);
  assert.doesNotMatch(h.text('autoAnalyzeLine'), /分析失败/);
});
