/**
 * 多帧 zstd 解码测试。
 *
 * 这里测的是一个真实踩过的坑：DSH 的会话日志是「多帧 zstd 拼接」，Node 自带的
 * `zstdDecompressSync` 只会解出第一帧就停 —— 一个 897 KB 的日志只能解出 209 字节。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';

import { decodeZstdFrames, findFrameOffsets, ZSTD_MAGIC } from '../lib/zstd.js';

const frame = (text) => zstdCompressSync(Buffer.from(text, 'utf8'));

test('单帧：能解出内容', () => {
  const result = decodeZstdFrames(frame('hello'));
  assert.equal(result.text, 'hello');
  assert.equal(result.decodedFrames, 1);
  assert.equal(result.failedCandidates, 0);
});

test('多帧：逐帧解出并拼接（模拟增量写入）', () => {
  const parts = ['第一段\n', '第二段\n', '第三段\n'];
  const buffer = Buffer.concat(parts.map(frame));
  const result = decodeZstdFrames(buffer);
  assert.equal(result.text, parts.join(''));
  assert.equal(result.decodedFrames, 3);
});

test('对照：Node 原生解压多帧只能拿到第一帧（本模块存在的理由）', () => {
  const parts = ['A', 'B', 'C'];
  const buffer = Buffer.concat(parts.map(frame));
  // 原生 API 对同一个 buffer 只返回第一帧内容
  assert.equal(zstdDecompressSync(buffer).toString('utf8'), 'A');
  // 本模块拿到全部
  assert.equal(decodeZstdFrames(buffer).text, 'ABC');
});

test('魔数扫描：能定位到每一帧的起点', () => {
  const buffer = Buffer.concat([frame('x'), frame('y')]);
  const offsets = findFrameOffsets(buffer);
  assert.equal(offsets.length, 2);
  assert.equal(offsets[0], 0);
  assert.ok(offsets[1] > 0);
  assert.deepEqual(ZSTD_MAGIC, [0x28, 0xb5, 0x2f, 0xfd]);
});

test('非 zstd 数据：抛出明确错误', () => {
  assert.throws(() => decodeZstdFrames(Buffer.from('这不是 zstd')), /未找到 zstd 帧魔数/);
});

test('超大内容（跨多个压缩块）也能正确解出', () => {
  const big = 'A'.repeat(200_000) + '尾部标记';
  const result = decodeZstdFrames(frame(big));
  assert.equal(result.text.length, big.length);
  assert.ok(result.text.endsWith('尾部标记'));
});

test('UTF-8 中文跨帧边界不产生乱码（逐帧独立解码的前提是每帧自包含）', () => {
  const parts = ['中文一', '中文二', '中文三'];
  const result = decodeZstdFrames(Buffer.concat(parts.map(frame)));
  assert.equal(result.text, '中文一中文二中文三');
});
