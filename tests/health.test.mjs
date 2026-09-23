/**
 * 守门层测试。
 *
 * 这一层的价值全在**不该响的时候不响**。第一版把「未知事件类型」单独当警报，
 * 在一个数字完全正确的真机会话上误报 —— 而一个总在喊狼来了的自检层，比没有自检层
 * 更糟：使用者会学会忽略它。所以下面**一半的用例是「不该报警」**。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RECONCILIATION_TOLERANCE, inspectHealth } from '../lib/health.js';

/** 造一个够用的 analysis：守门层只看 items 的体积与 usage 的两个数。 */
const analysisWith = (items, finalContextSize, totalCalls = 5) => ({
    items,
    usage: { finalContextSize, totalCalls, calls: [] },
});

const irWith = (unknownEventTypes = []) => ({ diagnostics: { unknownEventTypes } });

test('对账偏差超容差时报警，并说清差了多少', () => {
    // 账面 800，实际 1000 → 差 200（20%），远超 2% 容差
    const health = inspectHealth(irWith(), analysisWith([{ tokens: 800 }], 1000));
    assert.equal(health.ok, false);
    assert.ok(Math.abs(health.deviation - 0.2) < 1e-9);
    assert.equal(health.unexplained, 200);
    assert.ok(health.warnings.some((w) => w.level === 'high' && w.text.includes('20.0%')));
});

test('对账在容差内时不报警 —— 真机会话就是这种情况', () => {
    const health = inspectHealth(irWith(), analysisWith([{ tokens: 1000 }], 1000));
    assert.equal(health.ok, true);
    assert.deepEqual(health.warnings, []);
    assert.ok(RECONCILIATION_TOLERANCE >= 0.02);
});

test('未知事件类型单独出现时不报警 —— 不进上下文的元事件不该被冤枉', () => {
    // DSH 有一大批元事件（tool/call、request/header、agent/inbox/spliced…），
    // 它们本来就不该被归因。对账既然对得上，就说明没漏东西。
    const health = inspectHealth(
        irWith([{ type: 'tool/call', bytes: 370_679 }, { type: 'request/header', bytes: 172_573 }]),
        analysisWith([{ tokens: 1000 }], 1000)
    );
    assert.equal(health.ok, true, '数字正确就不该喊狼来了');
    assert.deepEqual(health.warnings, []);
    // 但线索要保留下来，供对账异常时使用
    assert.equal(health.unknownEventTypes.length, 2);
});

test('对账异常 + 有未知类型：报主因，并把未知类型作为元凶列出', () => {
    const health = inspectHealth(
        irWith([{ type: 'brand/new-event', bytes: 50_000 }]),
        analysisWith([{ tokens: 500 }], 1000)
    );
    assert.equal(health.ok, false);
    assert.ok(health.warnings.some((w) => w.text.includes('对账偏差')));
    assert.ok(health.warnings.some((w) => w.text.includes('brand/new-event')));
});

test('对账异常但没有未知类型：指向归因逻辑，而不是日志格式', () => {
    const health = inspectHealth(irWith(), analysisWith([{ tokens: 500 }], 1000));
    assert.equal(health.ok, false);
    assert.ok(
        health.warnings.some((w) => w.text.includes('归因逻辑本身')),
        '没有新事件类型时，别把责任推给格式升级'
    );
});

test('没有模型调用时给出 mid 提示（报告会是空的）', () => {
    const health = inspectHealth(irWith(), analysisWith([], 0, 0));
    assert.equal(health.ok, false);
    assert.ok(health.warnings.every((w) => w.level === 'mid'));
    assert.ok(health.warnings.some((w) => w.text.includes('空的')));
});

test('畸形输入不崩溃', () => {
    assert.equal(inspectHealth(undefined, undefined).ok, false);
    assert.equal(inspectHealth(null, { items: null, usage: null }).deviation, 0);
    assert.deepEqual(inspectHealth({ diagnostics: { unknownEventTypes: [null, { bytes: 1 }] } }, analysisWith([], 0, 1)).unknownEventTypes, []);
});
