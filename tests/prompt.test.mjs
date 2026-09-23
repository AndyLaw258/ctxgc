/**
 * 常驻成本审计的测试。
 *
 * 这一层的价值全在「数据源取对了没有」：会话日志只落了系统提示一块，工具定义在
 * `request/header`、工作区约定在文件系统。取错地方**不会报错**，只会安静地少算
 * 三分之二 —— 所以每条来源都要单独钉住。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    estimateTokens,
    systemTextOf,
    collectTools,
    collectSystemPrompts,
    collectAgentsFiles,
    inspectPrompt,
    promptAdvice,
} from '../lib/prompt.js';

const headerEvent = (tools) => ({ type: 'request/header', data: { header: { tools } } });
const systemEvent = (text, turn = 1) => ({
    type: 'system/message',
    data: { turn, message: { content: [{ type: 'text', text }] } },
});

test('estimateTokens：CJK 与英文用不同系数，空输入为 0', () => {
    assert.equal(estimateTokens(''), 0);
    assert.equal(estimateTokens(undefined), 0);
    assert.equal(estimateTokens(null), 0);
    assert.equal(estimateTokens('a'.repeat(400)), 100, '400 个英文字符 ≈ 100 token');
    assert.equal(estimateTokens('字'.repeat(100)), 70, '100 个汉字 ≈ 70 token');
});

test('systemTextOf：系统提示在 message.content，不是 data.content', () => {
    // 这个位置差异曾经让提取结果变成 0 字符 —— 取错地方不会报错，只会静默为空
    assert.equal(systemTextOf({ data: { message: { content: [{ type: 'text', text: '甲' }] } } }), '甲');
    assert.equal(systemTextOf({ data: { message: { content: '乙' } } }), '乙', '纯字符串形态也要能吃');
    assert.equal(systemTextOf({ data: {} }), '');
});

test('collectTools：从 request/header 取，按体积降序', () => {
    const events = [
        headerEvent([
            { name: 'small', description: 'x', parameters: {} },
            { name: 'big', description: 'y'.repeat(400), parameters: {} },
        ]),
    ];
    const tools = collectTools(events);
    assert.equal(tools.found, true);
    assert.equal(tools.items.length, 2);
    assert.equal(tools.items[0].name, 'big', '最贵的排最前');
    assert.ok(tools.chars > 0 && tools.tokens > 0);
});

test('collectTools：没有 request/header 时如实报告未找到，而不是抛异常', () => {
    const tools = collectTools([systemEvent('x')]);
    assert.equal(tools.found, false);
    assert.equal(tools.chars, 0);
    assert.deepEqual(tools.items, []);
});

test('collectTools：多次记录时取最后一条（工具集会随 profile 变更）', () => {
    // 禁用工具插件后 DSH 会重新记录一次 request/header。取第一条会永远显示
    // 改造前的旧数据，让人误以为「改了没用」。
    const events = [
        headerEvent([{ name: 'old', description: 'x', parameters: {} }]),
        headerEvent([
            { name: 'new1', description: 'x', parameters: {} },
            { name: 'new2', description: 'x', parameters: {} },
        ]),
    ];
    const tools = collectTools(events);
    assert.equal(tools.items.length, 2, '应取最新那次的工具集');
    assert.ok(tools.items.some((t) => t.name === 'new1'));
    assert.equal(tools.items.some((t) => t.name === 'old'), false);
});

test('collectSystemPrompts：多条系统提示取最大的一条（接替关系，不是叠加）', () => {
    const events = [systemEvent('短', 1), systemEvent('长'.repeat(500), 11)];
    const system = collectSystemPrompts(events);
    assert.equal(system.count, 2);
    // 会话中途重建过一次系统提示，两条是先后接替 —— 叠起来会把开销算成两倍
    assert.equal(system.tokens, estimateTokens('长'.repeat(500)), '按最大的那条计费');
});

test('collectAgentsFiles：只收真实存在的文件，缺失的不占位', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ctxgc-prompt-'));
    try {
        writeFileSync(join(dir, 'AGENTS.md'), '# 约定\n- 用中文\n');
        const agents = collectAgentsFiles(dir, join(dir, 'nonexistent-home'));
        assert.equal(agents.items.length, 1, '只有存在的那份被计入');
        assert.equal(agents.items[0].scope, '工作区');
        assert.ok(agents.tokens > 0);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('inspectPrompt：每轮开销按轮数折算总额，且总额大于日志可见部分', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ctxgc-prompt-'));
    try {
        writeFileSync(join(dir, 'AGENTS.md'), 'a'.repeat(400));
        const analysis = {
            session: {
                events: [
                    headerEvent([{ name: 't', description: 'x'.repeat(400), parameters: {} }]),
                    systemEvent('s'.repeat(400)),
                ],
            },
            usage: { calls: new Array(10).fill({}) },
        };
        const result = inspectPrompt(analysis, { root: dir, dshHome: join(dir, 'nope') });
        assert.equal(result.turns, 10);
        assert.equal(result.perTurn, result.parts.reduce((sum, p) => sum + p.tokens, 0));
        assert.equal(result.total, result.perTurn * 10);
        assert.equal(result.visibleFromLog, result.system.tokens);
        // 这正是修掉「第二点」要保证的：总额必须大于只看日志时的数字
        assert.ok(result.perTurn > result.visibleFromLog, '工具定义 + 约定必须让总额大于日志可见部分');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('promptAdvice：指出日志可见部分与实际开销的差距，并点名最贵的工具', () => {
    const advice = promptAdvice({
        turns: 10,
        perTurn: 5000,
        visibleFromLog: 1000,
        tools: { items: [{ name: 'pwsh', chars: 400, tokens: 100 }], chars: 400, tokens: 100 },
        agents: { items: [], chars: 0, tokens: 0 },
    });
    assert.ok(advice.some((a) => a.text.includes('会话日志只能看到')));
    assert.ok(advice.some((a) => a.text.includes('pwsh')));
});

test('promptAdvice：没有轮数时不产生任何建议', () => {
    assert.deepEqual(
        promptAdvice({ turns: 0, perTurn: 0, visibleFromLog: 0, tools: { items: [] }, agents: { items: [] } }),
        []
    );
});
