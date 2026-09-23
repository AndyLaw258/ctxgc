/**
 * 会话发现与解压的容错测试（第 1 层防御）。
 *
 * 这一层防的是**硬失效**：DSH 改文件名或换压缩算法时，希望「照样能读」，
 * 而不是「找不到会话」或「解不开」。后者尤其难诊断 —— 报错只会说
 * "invalid frame"，不会说"我们改格式了"。
 *
 * 所以两个方向都要钉：**认得出现在的东西**，也**认得出来未来的形态**。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync, zstdCompressSync } from 'node:zlib';
import { findSessionLog } from '../lib/sessions.js';
import { GZIP_MAGIC, decompressSessionLog } from '../lib/decompress.js';

/** 造一个临时会话目录，用完自动清理。 */
function withDir(fn) {
    const dir = mkdtempSync(join(tmpdir(), 'ctxgc-disc-'));
    try {
        return fn(dir);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

test('findSessionLog：认出当前形态并报出版本号', () => {
    withDir((dir) => {
        writeFileSync(join(dir, 'session.v3.jsonl.zstd'), 'x');
        const found = findSessionLog(dir);
        assert.equal(found.name, 'session.v3.jsonl.zstd');
        assert.equal(found.version, 3);
        assert.equal(found.codec, 'zstd');
    });
});

test('findSessionLog：多个版本共存时取版本号最高的', () => {
    withDir((dir) => {
        // 这正是升级后的现场：老日志还在，新日志已出现
        writeFileSync(join(dir, 'session.v3.jsonl.zstd'), 'old');
        writeFileSync(join(dir, 'session.v4.jsonl.zstd'), 'new');
        const found = findSessionLog(dir);
        assert.equal(found.version, 4, '不能因为写死了 v3 就抱着老文件不放');
    });
});

test('findSessionLog：版本号按数值比，不是按字符串比', () => {
    withDir((dir) => {
        writeFileSync(join(dir, 'session.v9.jsonl.zstd'), 'x');
        writeFileSync(join(dir, 'session.v10.jsonl.zstd'), 'y');
        assert.equal(findSessionLog(dir).version, 10, 'v10 > v9，字符串比较会判反');
    });
});

test('findSessionLog：没有版本号、没有压缩的形态也认', () => {
    withDir((dir) => {
        writeFileSync(join(dir, 'session.jsonl'), '{}');
        const found = findSessionLog(dir);
        assert.equal(found.version, null);
        assert.equal(found.codec, 'none');
    });
});

test('findSessionLog：目录不存在或没有日志时返回 null，不抛异常', () => {
    assert.equal(findSessionLog(join(tmpdir(), 'ctxgc-not-here-xyz')), null);
    withDir((dir) => {
        writeFileSync(join(dir, 'unrelated.txt'), 'x');
        assert.equal(findSessionLog(dir), null);
    });
});

test('decompressSessionLog：未压缩的 JSONL 原样返回 —— 不压也是合法形态', () => {
    const result = decompressSessionLog(Buffer.from('{"type":"session"}\n', 'utf8'));
    assert.equal(result.codec, 'none');
    assert.match(result.text, /"type":"session"/);
});

test('decompressSessionLog：gzip 按魔数识别，不看扩展名', () => {
    const payload = Buffer.from('{"type":"session"}\n', 'utf8');
    const packed = gzipSync(payload);
    assert.deepEqual([...packed.subarray(0, 2)], [...GZIP_MAGIC]);
    const result = decompressSessionLog(packed);
    assert.equal(result.codec, 'gzip');
    assert.equal(result.text, payload.toString('utf8'));
});

test('decompressSessionLog：zstd 走多帧解码（当前形态不能被改坏）', () => {
    const one = Buffer.from('{"a":1}\n', 'utf8');
    const two = Buffer.from('{"b":2}\n', 'utf8');
    // 模拟 DSH 的增量追加：两个独立帧拼在一起，没有总帧头
    const multiFrame = Buffer.concat([zstdCompressSync(one), zstdCompressSync(two)]);
    const result = decompressSessionLog(multiFrame);
    assert.equal(result.codec, 'zstd');
    assert.equal(result.text, '{"a":1}\n{"b":2}\n', '两帧都要解出来，而不是只解第一帧');
});
