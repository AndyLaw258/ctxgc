/**
 * 生命周期成本模型测试。
 *
 * 核心命题：同一条内容，体积相同但存续轮数不同，成本差几十倍。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeLifecycle,
  summarizeLifecycle,
  topOffenders,
  groupOf,
  formatTokens,
  GROUP_LABELS,
} from '../lib/lifecycle.js';

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

test('reads = 总调用数 - 进入时的调用序号', () => {
  const items = [item({ enteredAtIndex: 0 }), item({ enteredAtIndex: 90 })];
  const result = computeLifecycle(items, 100);
  assert.equal(result[0].reads, 100);
  assert.equal(result[1].reads, 10);
});

test('最后一步进入的内容 reads 为 0（还没被重读过）', () => {
  const result = computeLifecycle([item({ enteredAtIndex: 99 })], 100);
  assert.equal(result[0].reads, 1, '进入的那次调用本身就读到了它，所以至少 1 次');
});

test('lifecycleTokens = tokens × reads', () => {
  const result = computeLifecycle([item({ tokens: 12_512, enteredAtIndex: 2 })], 90);
  assert.equal(result[0].reads, 88);
  assert.equal(result[0].lifecycleTokens, 12_512 * 88);
});

test('同体积不同存续期：成本可以差 10 倍（本模型的意义）', () => {
  const items = [
    item({ tokens: 1000, enteredAtIndex: 0 }),  // reads 100
    item({ tokens: 1000, enteredAtIndex: 90 }), // reads 10
  ];
  const result = computeLifecycle(items, 100);
  assert.equal(result[0].lifecycleTokens / result[1].lifecycleTokens, 10);
});

test('groupOf 把 tool:* 归并为一类', () => {
  assert.equal(groupOf('tool:pwsh'), 'tool');
  assert.equal(groupOf('tool:read'), 'tool');
  assert.equal(groupOf('assistant'), 'assistant');
  assert.equal(groupOf('user'), 'user');
});

test('summarize：分类汇总与放大系数', () => {
  const items = computeLifecycle([
    item({ kind: 'tool:pwsh', tokens: 1000, enteredAtIndex: 0 }),
    item({ kind: 'user', tokens: 100, enteredAtIndex: 0 }),
  ], 11);
  const summary = summarizeLifecycle(items);
  assert.equal(summary.totalTokens, 1100);
  assert.equal(summary.totalLifecycle, 1000 * 11 + 100 * 11);
  assert.equal(summary.itemCount, 2);
  const tool = summary.groups.find((g) => g.group === 'tool');
  assert.equal(tool.count, 1);
  assert.equal(tool.lifecycleTokens, 11_000);
});

test('summarize：可避免量按摘要形态重算，且不超过当前成本', () => {
  const items = computeLifecycle([
    item({ tokens: 10_000, enteredAtIndex: 0 }), // reads 10
  ], 10);
  const summary = summarizeLifecycle(items, { digestTokens: 300 });
  assert.equal(summary.toolLifecycle, 100_000);
  assert.equal(summary.digestLifecycle, 3_000);
  assert.equal(summary.avoidable, 97_000);
});

test('summarize：小结果不会被"摘要化"放大成本', () => {
  const items = computeLifecycle([item({ tokens: 100, enteredAtIndex: 0 })], 10);
  const summary = summarizeLifecycle(items, { digestTokens: 300 });
  // 100 < 300，取 min 后仍是 100
  assert.equal(summary.digestLifecycle, 1000);
  assert.equal(summary.avoidable, 0);
});

test('topOffenders 按累计读取量降序，且尊重 limit', () => {
  const items = computeLifecycle([
    item({ label: 'small', tokens: 10, enteredAtIndex: 0 }),
    item({ label: 'big', tokens: 10_000, enteredAtIndex: 0 }),
    item({ label: 'mid', tokens: 500, enteredAtIndex: 0 }),
  ], 10);
  const top = topOffenders(items, 2);
  assert.deepEqual(top.map((i) => i.label), ['big', 'mid']);
});

test('formatTokens 输出人类可读单位', () => {
  assert.equal(formatTokens(932), '932');
  assert.equal(formatTokens(1_500), '1.50k');
  assert.equal(formatTokens(18_400), '18.4k');
  assert.equal(formatTokens(1_234_567), '1.23M');
});

test('每个类别都有中文标签（防止报告出现 undefined）', () => {
  for (const kind of ['system', 'runtime', 'user', 'assistant', 'tool', 'other']) {
    assert.ok(GROUP_LABELS[kind], `${kind} 缺标签`);
  }
});
