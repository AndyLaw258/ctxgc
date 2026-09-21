/**
 * 多帧 zstd 解码。
 *
 * DSH 的会话日志是「无结束标记的多帧 zstd 增量流」：每追加一批事件，就往文件尾部
 * 拼接一个独立的 zstd 帧。因此文件里不存在一个总的帧头，Node 自带的
 * `zstdDecompressSync` / `createZstdDecompress` 都只解出**第一帧**就停下
 * （实测：一个 897 KB 的日志只能解出 209 字节，恰好是会话头）。
 *
 * 做法：扫描 zstd 帧魔数（28 B5 2F FD）定位每个帧的起点，逐帧独立解压后拼接。
 * 压缩数据内部理论上可能出现相同的字节序列，因此对每个候选位置都 try/catch，
 * 解不出来的候选直接丢弃（实测 556 个候选中 0 个误判）。
 *
 * @module ctxgc/zstd
 */

import { zstdDecompressSync } from 'node:zlib';

/** zstd 帧魔数的字节序列（小端 0xFD2FB528）。 */
export const ZSTD_MAGIC = Object.freeze([0x28, 0xb5, 0x2f, 0xfd]);

/**
 * 找出缓冲区里所有可能的 zstd 帧起点。
 *
 * @param {Buffer|Uint8Array} buffer - 待扫描的字节。
 * @returns {number[]} 升序排列的候选偏移量。
 */
export function findFrameOffsets(buffer) {
  const offsets = [];
  const last = buffer.length - ZSTD_MAGIC.length;
  for (let i = 0; i <= last; i += 1) {
    if (
      buffer[i] === ZSTD_MAGIC[0]
      && buffer[i + 1] === ZSTD_MAGIC[1]
      && buffer[i + 2] === ZSTD_MAGIC[2]
      && buffer[i + 3] === ZSTD_MAGIC[3]
    ) {
      offsets.push(i);
    }
  }
  return offsets;
}

/**
 * 逐帧解压一个多帧 zstd 缓冲区。
 *
 * @param {Buffer|Uint8Array} buffer - 原始字节。
 * @returns {{text: string, frameCandidates: number, decodedFrames: number, failedCandidates: number, bytes: number}}
 *   `text` 是拼接后的 UTF-8 文本；`decodedFrames` 是成功解出的帧数。
 * @throws {Error} 当没有任何一帧能解出时（说明这不是 zstd 流）。
 */
export function decodeZstdFrames(buffer) {
  const offsets = findFrameOffsets(buffer);
  if (offsets.length === 0) {
    throw new Error('ctxgc: 未找到 zstd 帧魔数，这不是一个 zstd 多帧流');
  }

  const chunks = [];
  let failedCandidates = 0;
  for (const offset of offsets) {
    try {
      chunks.push(zstdDecompressSync(buffer.subarray(offset)));
    } catch {
      // 候选位置落在压缩数据内部，或该帧被截断（日志正在写入）——两种情况都跳过。
      failedCandidates += 1;
    }
  }

  const merged = Buffer.concat(chunks);
  return {
    text: merged.toString('utf8'),
    frameCandidates: offsets.length,
    decodedFrames: chunks.length,
    failedCandidates,
    bytes: merged.length,
  };
}
