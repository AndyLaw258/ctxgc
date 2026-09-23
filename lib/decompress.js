/**
 * 按**魔数**选择解压方式。
 *
 * 为什么不能写死 zstd：会话日志现在是多帧 zstd，但压缩方式属于实现细节 ——
 * 换掉它不会有人通知我们。而「解不开」是最难诊断的失效：报错只会说
 * "invalid zstd frame"，不会说"我们换压缩算法了"。
 *
 * 魔数是格式自带的指纹，认它比认扩展名可靠（扩展名会被改、会被省）。
 * brotli 没有固定魔数，因此不在自动识别范围内 —— 真遇到时按扩展名提示用户。
 */
import { gunzipSync } from 'node:zlib';
import { ZSTD_MAGIC, decodeZstdFrames } from './zstd.js';

/** gzip 的魔数。 */
export const GZIP_MAGIC = Object.freeze([0x1f, 0x8b]);

/** 判断一段字节是否以给定魔数开头。 */
function startsWith(buffer, magic) {
    if (!Buffer.isBuffer(buffer) || buffer.length < magic.length) return false;
    return magic.every((byte, index) => buffer[index] === byte);
}

/**
 * 解压一份会话日志，自动识别压缩方式。
 *
 * @param buffer - 文件原始字节。
 * @returns `{ text, codec, frames }`。`codec` 是识别出的压缩方式（`zstd` / `gzip` / `none`）。
 * @throws 数据是 zstd 却解不开时抛错 —— 帧结构变了必须让人知道，而不是给一份空报告。
 */
export function decompressSessionLog(buffer) {
    const raw = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? '');

    if (startsWith(raw, ZSTD_MAGIC)) {
        const decoded = decodeZstdFrames(raw);
        return { text: decoded.text, codec: 'zstd', frames: decoded };
    }
    if (startsWith(raw, GZIP_MAGIC)) {
        return { text: gunzipSync(raw).toString('utf8'), codec: 'gzip', frames: null };
    }
    // 兜底：未压缩的 JSONL。这不是错误 —— 也许哪天 DSH 就不压了。
    return { text: raw.toString('utf8'), codec: 'none', frames: null };
}
