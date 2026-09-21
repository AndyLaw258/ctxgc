/**
 * 归因引擎测试。
 *
 * 这里的核心是三条不变式：
 *   ① `totalTokens = inputTokens + cacheReadTokens + outputTokens`
 *   ② `contextSize = totalTokens - outputTokens`
 *   ③ `Σ growth = 最终 contextSize`（无收缩时）
 *
 * 第 ③ 条是整个项目的自检基准 —— 它保证「每个条目进入时的体积之和」等于上下文
 * 实际大小。实测在真实会话上偏差为 +0.0%。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { analyzeUsage, extractCalls, growthWindows, normalizeUsage } from '../lib/usage.js';

function callEvent(seq, step, usage) {
  const { input = 0, output = 0, cacheRead = 0 } = usage;
  return {
    type: 'assistant/message',
    seq,
    time: seq,
    data: {
      turn: 1,
      step,
      usage: {
        inputTokens: input,
        outputTokens: output,
        cacheReadTokens: cacheRead,
        totalTokens: input + output + cacheRead,
      },
      message: { content: [] },
    },
  };
}

const userEvent = (seq) => ({ type: 'user/message', seq, time: seq, data: { content: [{ type: 'text', text: 'hi' }] } });
const resultEvent = (seq) => ({ type: 'tool/result', seq, time: seq, data: { message: { content: [{ type: 'text', text: 'x' }] } } });

test('extractCalls 只取带 usage 的 assistant/message', () => {
  const events = [userEvent(1), callEvent(2, 1, { input: 10, output: 5 }), { type: 'step/start', seq: 3, data: {} }];
  assert.equal(extractCalls(events).length, 1);
});

test('normalizeUsage：totalTokens 缺失时按恒等式回算', () => {
  const usage = normalizeUsage({ inputTokens: 100, outputTokens: 50, cacheReadTokens: 25 });
  assert.equal(usage.total, 175);
});

test('不变式②：contextSize = totalTokens - outputTokens', () => {
  const events = [callEvent(2, 1, { input: 800, output: 200, cacheRead: 0 })];
  const { calls } = analyzeUsage(events);
  assert.equal(calls[0].contextSize, 800);
});

test('不变式③：Σ growth 等于最终 contextSize（无收缩）', () => {
  const events = [
    callEvent(2, 1, { input: 1000, output: 100, cacheRead: 0 }),   // contextSize 1000
    callEvent(4, 2, { input: 200, output: 150, cacheRead: 1200 }), // contextSize 1400
    callEvent(6, 3, { input: 300, output: 120, cacheRead: 1650 }), // contextSize 1950
  ];
  const { calls, finalContextSize } = analyzeUsage(events);
  const sumGrowth = calls.reduce((sum, c) => sum + c.growth, 0);
  assert.equal(finalContextSize, 1950);
  assert.equal(sumGrowth, 1950);
});

test('growth 是相邻上下文大小之差（不减上一步输出）', () => {
  const events = [
    callEvent(2, 1, { input: 1000, output: 100 }),   // 1000
    callEvent(4, 2, { input: 0, output: 50, cacheRead: 1300 }), // 1300 -> growth 300
  ];
  const { calls } = analyzeUsage(events);
  assert.equal(calls[1].growth, 300);
});

test('上下文收缩被计数，且 growth 保留负号（供报告提示）', () => {
  const events = [
    callEvent(2, 1, { input: 5000, output: 10 }),   // 5000
    callEvent(4, 2, { input: 100, output: 10 }),    // 100 -> 收缩
  ];
  const { calls, contractions } = analyzeUsage(events);
  assert.equal(contractions, 1);
  assert.equal(calls[1].growth, -4900);
});

test('readTokens = inputTokens + cacheReadTokens', () => {
  const events = [callEvent(2, 1, { input: 300, output: 10, cacheRead: 700 })];
  const { calls } = analyzeUsage(events);
  assert.equal(calls[0].readTokens, 1000);
});

test('totals 汇总各项用量', () => {
  const events = [
    callEvent(2, 1, { input: 100, output: 20, cacheRead: 200 }),
    callEvent(4, 2, { input: 50, output: 30, cacheRead: 300 }),
  ];
  const { totals } = analyzeUsage(events);
  assert.equal(totals.input, 150);
  assert.equal(totals.output, 50);
  assert.equal(totals.cacheRead, 500);
});

test('growthWindows：区间是 [S(n-1), S(n))，左闭 —— 必须包含上一步助手输出', () => {
  const events = [
    userEvent(1),
    callEvent(2, 1, { input: 10, output: 5 }),
    resultEvent(3),
    callEvent(4, 2, { input: 10, output: 5 }),
  ];
  const eventsSorted = events.slice().sort((a, b) => a.seq - b.seq);
  const { calls } = analyzeUsage(eventsSorted);
  const windows = growthWindows(eventsSorted, calls);

  // 第 0 次调用的窗口：seq < 2
  assert.deepEqual(windows.get(0).map((e) => e.seq), [1]);
  // 第 1 次调用的窗口：[2, 4) —— 含 seq=2 的助手输出本身
  assert.deepEqual(windows.get(1).map((e) => e.seq), [2, 3]);
});

test('空会话不崩溃', () => {
  const { calls, totalCalls, peakContextSize } = analyzeUsage([]);
  assert.equal(totalCalls, 0);
  assert.equal(calls.length, 0);
  assert.equal(peakContextSize, 0);
});
