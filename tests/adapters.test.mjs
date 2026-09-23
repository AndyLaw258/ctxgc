/**
 * 适配层测试（v1.0）。
 *
 * v1.0 把「读懂某种日志」和「算成本」分开，代价是多了一条路径 —— 而两条路径最危险的
 * 失败方式不是崩溃，是**悄悄漂移**：DSH 路径改了、IR 路径没跟上，报告数字从此不一致，
 * 还没人会发现。所以这里除了各自的形状，还要钉住 IR 这道边界的语义。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IR_VERSION, irTotals, normalizeIR } from '../lib/ir.js';
import { genericAdapter, genericToIR } from '../lib/adapters/generic.js';
import { analyzeIR } from '../lib/index.js';

const demoIR = {
    id: 'demo',
    cwd: 'C:/work',
    calls: [
        { contextSize: 1000, outputTokens: 100, readTokens: 900, cacheReadTokens: 800 },
        { contextSize: 2000, outputTokens: 200, readTokens: 1800, cacheReadTokens: 1500 },
    ],
    items: [
        { enteredAtIndex: 0, kind: 'system', label: '系统提示', tokens: 500, bytes: 1800 },
        { enteredAtIndex: 1, kind: 'tool:read', label: '读取文件', tokens: 300, bytes: 1100 },
    ],
};

test('normalizeIR：畸形输入不抛异常，字段补齐到可用', () => {
    assert.equal(normalizeIR(null).runtime, 'unknown');
    assert.equal(normalizeIR(undefined).version, IR_VERSION);
    assert.deepEqual(normalizeIR({}).calls, []);
    assert.deepEqual(normalizeIR('不是对象').items, []);
    const messy = normalizeIR({ items: [{ tokens: 'abc', kind: '' }, null] });
    assert.equal(messy.items[0].tokens, 0, '非数字体积归零而不是 NaN');
    assert.equal(messy.items[0].kind, 'other', '空 kind 回落到 other');
    assert.equal(messy.items[1].label, '(未命名)');
});

test('normalizeIR：缺少 contextSize 的调用被丢弃 —— 它无法参与归因', () => {
    const ir = normalizeIR({
        calls: [{ contextSize: 100 }, { outputTokens: 5 }, { contextSize: null }, { contextSize: 300 }],
    });
    assert.equal(ir.calls.length, 2, '留下两条能算的');
    assert.deepEqual(ir.calls.map((c) => c.index), [0, 3], 'index 保留原位置，便于回溯');
});

test('irTotals：轮数取调用条数，最终上下文取最后一条', () => {
    const totals = irTotals(normalizeIR(demoIR));
    assert.equal(totals.turns, 2);
    assert.equal(totals.finalContextSize, 2000);
    assert.equal(totals.totalOutputTokens, 300);
    assert.equal(irTotals(normalizeIR({})).finalContextSize, 0, '空会话不崩溃');
});

test('genericToIR：缺 calls 或 items 时直接抛错，并指出缺的是哪个', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ctxgc-ir-'));
    try {
        const bad = join(dir, 'bad.json');
        writeFileSync(bad, JSON.stringify({ items: [] }));
        assert.throws(() => genericToIR(bad), /缺少 calls/);

        writeFileSync(bad, JSON.stringify({ calls: [] }));
        assert.throws(() => genericToIR(bad), /缺少 items/);

        writeFileSync(bad, '[]');
        assert.throws(() => genericToIR(bad), /顶层必须是一个 JSON 对象/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('genericToIR：合法文件转成 IR，文件名兜底当 id', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ctxgc-ir-'));
    try {
        const file = join(dir, 'my-session.json');
        writeFileSync(file, JSON.stringify(demoIR));
        const ir = genericToIR(file);
        assert.equal(ir.runtime, 'generic');
        assert.equal(ir.id, 'demo', '文件内声明优先');
        assert.equal(ir.calls.length, 2);

        writeFileSync(file, JSON.stringify({ calls: demoIR.calls, items: demoIR.items }));
        assert.equal(genericToIR(file).id, 'my-session', '没声明就用文件名');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('genericAdapter.list：目录不存在时返回空数组而不是抛错', () => {
    assert.deepEqual(genericAdapter.list({ sessionsDir: join(tmpdir(), 'ctxgc-not-there-xyz') }), []);
});

test('genericAdapter.list：按最近修改排序（最近的在前面）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ctxgc-ir-'));
    try {
        const oldFile = join(dir, 'old.json');
        const newFile = join(dir, 'new.json');
        const body = JSON.stringify({ calls: [], items: [] });
        writeFileSync(oldFile, body);
        writeFileSync(newFile, body);
        utimesSync(oldFile, new Date(2000, 0, 1), new Date(2000, 0, 1));
        utimesSync(newFile, new Date(2026, 0, 1), new Date(2026, 0, 1));
        assert.deepEqual(
            genericAdapter.list({ sessionsDir: dir }).map((s) => s.id),
            ['new', 'old']
        );
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('analyzeIR：核心只吃 IR，产出与 DSH 路径同形状的结果', () => {
    // runtime 是由**适配器**标注的：直接 normalizeIR 一份裸对象只会得到 'unknown'
    const analysis = analyzeIR(normalizeIR({ ...demoIR, runtime: 'generic' }));
    assert.equal(analysis.runtime, 'generic');
    assert.equal(analysis.session.id, 'demo');
    assert.equal(analysis.usage.totalCalls, 2);
    // 恒等式与 DSH 路径一致：未命中 = 读入 − 命中缓存
    assert.equal(analysis.usage.totals.input, 100 + 300);
    assert.equal(analysis.usage.totals.cacheRead, 800 + 1500);
    assert.equal(analysis.usage.totals.total, 1000 + 2000);
    assert.equal(analysis.usage.peakContextSize, 2000);
    // 存续轮数：第 0 步进入的被读 2 次，第 1 步进入的被读 1 次
    assert.equal(analysis.items[0].reads, 2);
    assert.equal(analysis.items[1].reads, 1);
    assert.equal(analysis.items[0].lifecycleTokens, 1000);
    assert.equal(analysis.events, null, 'IR 路径拿不到 DSH 的事件流，如实为空');
});

test('analyzeIR：空会话与上下文收缩都不崩溃', () => {
    assert.equal(analyzeIR(normalizeIR({})).usage.totalCalls, 0);
    const shrinking = analyzeIR(
        normalizeIR({ calls: [{ contextSize: 5000 }, { contextSize: 900 }], items: [] })
    );
    assert.equal(shrinking.usage.contractions, 1, '上下文被压缩过要计数');
    assert.equal(shrinking.usage.peakContextSize, 5000, '峰值取历史最大');
    assert.equal(shrinking.usage.finalContextSize, 900);
});
