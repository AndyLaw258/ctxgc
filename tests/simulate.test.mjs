/**
 * 反事实模拟测试。
 *
 * 模拟器最容易犯的错是"把不该动的也动了"。这里的测试重点验证：
 *   ① 只有工具结果受治理，助手输出/用户消息/系统提示词原样保留
 *   ② 边界：digest = 0（全落盘）与 digest 超大（等于不治理）
 *   ③ 单调性：digest 越大，节省越少
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { simulateDigest, sensitivity, topSavings, byTool, sampleCurve } from '../lib/simulate.js';
import { computeLifecycle } from '../lib/lifecycle.js';

const item = (over) => ({
  seq: 1,
  kind: 'tool:pwsh',
  label: 'x',
  bytes: 100,
  tokens: 1000,
  enteredAtIndex: 0,
  enteredAtSeq: 2,
  ...over,
});

/** 构造一组已带生命周期字段的条目。 */
function fixture() {
  return computeLifecycle([
    item({ kind: 'tool:pwsh', tokens: 10_000, enteredAtIndex: 0 }),
    item({ kind: 'tool:read', tokens: 200, enteredAtIndex: 0 }),
    item({ kind: 'assistant', tokens: 5_000, enteredAtIndex: 0 }),
    item({ kind: 'user', tokens: 100, enteredAtIndex: 0 }),
  ], 10);
}

test('只有工具结果受治理，助手输出与用户消息原样保留', () => {
  const items = fixture();
  const steps = simulateDigest(items, 10, 300);

  // 助手 5000 + 用户 100 不受影响；工具 10000→300、200→200
  const expectedAtEachStep = 5_000 + 100 + 300 + 200;
  assert.equal(steps.steps[0].simulated, expectedAtEachStep);
  assert.equal(steps.steps[0].real, 10_000 + 200 + 5_000 + 100);
});

test('digest = 0：工具结果全部落盘，只留非工具内容', () => {
  const items = fixture();
  const result = simulateDigest(items, 10, 0);
  assert.equal(result.steps[0].simulated, 5_100);
});

test('digest 超大：等同于不治理，节省为 0', () => {
  const items = fixture();
  const result = simulateDigest(items, 10, 1_000_000);
  assert.equal(result.saved, 0);
  assert.equal(result.totalSimulated, result.totalReal);
});

test('单调性：digest 越大，节省越少', () => {
  const items = fixture();
  const sweeps = sensitivity(items, 10, [0, 100, 300, 1000, 10_000]);
  for (let i = 1; i < sweeps.length; i += 1) {
    assert.ok(
      sweeps[i].saved <= sweeps[i - 1].saved,
      `digest=${sweeps[i].digestTokens} 的节省应不大于前一个`,
    );
  }
});

test('总读取 = 每一步上下文大小之和', () => {
  const items = fixture();
  const result = simulateDigest(items, 5, 300);
  const manual = result.steps.reduce((sum, s) => sum + s.simulated, 0);
  assert.equal(result.totalSimulated, manual);
});

test('后进入的条目不计入更早的步骤', () => {
  const items = computeLifecycle([
    item({ tokens: 1_000, enteredAtIndex: 3 }),
  ], 5);
  const result = simulateDigest(items, 5, 100);
  assert.equal(result.steps[0].simulated, 0, '第 0 步时它还没进入');
  assert.equal(result.steps[3].simulated, 100, '第 3 步进入并受治理');
});

test('savedRatio 在 0-1 之间，空会话不崩溃', () => {
  const result = simulateDigest([], 0, 300);
  assert.equal(result.savedRatio, 0);
  assert.equal(result.totalReal, 0);
});

test('topSavings：只列受治理且被削减的条目，按可省量降序', () => {
  const items = fixture();
  const top = topSavings(items, 300, 10);
  assert.equal(top.length, 1, '只有那条 10000 token 的 pwsh 超过了 300');
  assert.equal(top[0].after, 300);
  assert.equal(top[0].saved, (10_000 - 300) * top[0].reads);
});

test('topSavings：小结果与助手输出不出现', () => {
  const items = fixture();
  const top = topSavings(items, 300, 10);
  assert.ok(!top.some((i) => i.kind === 'assistant'));
  assert.ok(!top.some((i) => i.kind === 'tool:read'));
});

test('byTool：按工具汇总并降序', () => {
  const items = computeLifecycle([
    item({ kind: 'tool:pwsh', tokens: 1000, enteredAtIndex: 0 }),
    item({ kind: 'tool:pwsh', tokens: 500, enteredAtIndex: 0 }),
    item({ kind: 'tool:read', tokens: 100, enteredAtIndex: 0 }),
    item({ kind: 'assistant', tokens: 9999, enteredAtIndex: 0 }),
  ], 10);
  const tools = byTool(items);
  assert.equal(tools.length, 2, '助手输出不算工具');
  assert.equal(tools[0].tool, 'pwsh');
  assert.equal(tools[0].count, 2);
  assert.equal(tools[0].tokens, 1500);
});

test('sampleCurve：采样点数不超过上限，且覆盖首尾', () => {
  const steps = Array.from({ length: 100 }, (_, i) => ({ step: i, real: i, simulated: i }));
  const curve = sampleCurve(steps, 10);
  assert.equal(curve.length, 10);
  assert.equal(curve[0].step, 0);
  assert.equal(curve[curve.length - 1].step, 99);
});

test('sampleCurve：步数不足时原样返回', () => {
  const steps = [{ step: 0, real: 1, simulated: 1 }];
  assert.equal(sampleCurve(steps, 10).length, 1);
});
