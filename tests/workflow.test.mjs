/**
 * 工作流审计测试。
 *
 * 重点防回归的是**重复检测的精度** —— 开发过程中它连续误报过两次：
 *   ① 46 次 → 因为用截断到 96 字符的 label 做指纹，不同长命令前缀相同
 *   ② 3 次  → 因为只取第一个参数，同目录不同 pattern 的 grep 被判为重复
 *   ③ 2 次  → 正确
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { indexToolCalls, fingerprintOf, FINGERPRINT_KEYS } from '../lib/items.js';
import { inspectWorkspace, analyzeHabits, recommendations, scaffoldWorkspace, isReadRepeat } from '../lib/workflow.js';

function toolCall(seq, callId, name, args) {
  return { type: 'tool/call', seq, data: { callId, name, arguments: JSON.stringify(args) } };
}

function toolResult(seq, callId) {
  return {
    type: 'tool/result',
    seq,
    data: { message: { source: { callId }, content: [{ type: 'text', text: 'ok' }] } },
  };
}

function fpOf(name, args) {
  const events = [toolCall(1, 'c1', name, args), toolResult(2, 'c1')];
  return fingerprintOf(events[1], indexToolCalls(events));
}

// ── 重复检测精度 ──────────────────────────────────────────

test('grep：同目录不同 pattern 必须是不同指纹（踩过的误报）', () => {
  const a = fpOf('grep', { pattern: 'foo', path: 'C:\\proj' });
  const b = fpOf('grep', { pattern: 'bar', path: 'C:\\proj' });
  assert.notEqual(a, b);
});

test('grep：同 pattern 同目录是相同指纹（真实重复）', () => {
  const a = fpOf('grep', { pattern: 'foo', path: 'C:\\proj' });
  const b = fpOf('grep', { pattern: 'foo', path: 'C:\\proj' });
  assert.equal(a, b);
});

test('read：同文件是相同指纹，不同文件不同', () => {
  assert.equal(fpOf('read', { file_path: 'a.md' }), fpOf('read', { file_path: 'a.md' }));
  assert.notEqual(fpOf('read', { file_path: 'a.md' }), fpOf('read', { file_path: 'b.md' }));
});

test('read：description 之类的无关参数不影响指纹（防漏报）', () => {
  const a = fpOf('read', { file_path: 'a.md', description: '第一次' });
  const b = fpOf('read', { file_path: 'a.md', description: '换个描述' });
  assert.equal(a, b);
});

test('指纹归一化：大小写与空白差异不产生新指纹', () => {
  assert.equal(
    fpOf('pwsh', { command: "Get-ChildItem  'C:\\X'" }),
    fpOf('pwsh', { command: "get-childitem 'c:\\x'" }),
  );
});

test('写入类工具没有指纹 —— 同一文件反复编辑不算重复获取', () => {
  assert.equal(fpOf('edit', { file_path: 'a.js', old_string: 'x', new_string: 'y' }), null);
  assert.equal(fpOf('write', { file_path: 'a.js', content: 'z' }), null);
  assert.equal(fpOf('present', { files: [] }), null);
});

test('白名单之外的读取类工具不参与检测', () => {
  assert.ok(!('todo_write' in FINGERPRINT_KEYS));
  assert.ok(!('ask_user_question' in FINGERPRINT_KEYS));
  assert.equal(fpOf('todo_write', { todos: [] }), null);
});

test('isReadRepeat：无指纹的条目不参与', () => {
  assert.equal(isReadRepeat({ kind: 'tool:edit', fingerprint: null }), false);
  assert.equal(isReadRepeat({ kind: 'assistant', fingerprint: 'x' }), false);
  assert.equal(isReadRepeat({ kind: 'tool:grep', fingerprint: 'grep::x' }), true);
});

// ── 习惯指标 ──────────────────────────────────────────────

function analysisWith(items, calls) {
  return {
    items,
    usage: { calls: calls ?? [{ contextSize: 8590 }], totals: { input: 0, cacheRead: 15_246_260 } },
  };
}

const item = (over) => ({
  kind: 'tool:pwsh',
  label: 'pwsh | x',
  fingerprint: null,
  tokens: 100,
  reads: 10,
  lifecycleTokens: 1000,
  ...over,
});

test('analyzeHabits：重复获取只统计同指纹的读取类条目', () => {
  const analysis = analysisWith([
    item({ fingerprint: 'pwsh::a', tokens: 100, lifecycleTokens: 1000 }),
    item({ fingerprint: 'pwsh::a', tokens: 100, lifecycleTokens: 1000 }),
    item({ fingerprint: 'pwsh::b', tokens: 100, lifecycleTokens: 1000 }),
    item({ kind: 'tool:edit', fingerprint: null, tokens: 100, lifecycleTokens: 1000 }),
  ]);
  const habits = analyzeHabits(analysis);
  assert.equal(habits.repeats.length, 1);
  assert.equal(habits.repeats[0].count, 2);
  assert.equal(habits.repeatCount, 1, '多出来的那一次才算重复');
});

test('analyzeHabits：占比仍按「用户消息 ÷ 总量」算（降级为参考项）', () => {
  const analysis = analysisWith([
    item({ kind: 'user', tokens: 500, lifecycleTokens: 500 }),
    item({ kind: 'assistant', tokens: 500, lifecycleTokens: 500 }),
  ]);
  const habits = analyzeHabits(analysis);
  assert.equal(habits.restatementRatio, 0.5);
});

test('analyzeHabits：每条用户消息的平均体积 —— 不随会话变长而稀释', () => {
  // 修掉「占比被稀释」之后，判定改用平均值。构造两个只有助手输出不同的会话：
  // 用户消息完全一样，后一个的助手输出多得多。
  const userItem = item({ kind: 'user', tokens: 400, lifecycleTokens: 400 });
  const short = analyzeHabits(
    analysisWith([userItem, item({ kind: 'assistant', tokens: 200, lifecycleTokens: 200 })])
  );
  const long = analyzeHabits(
    analysisWith([
      userItem,
      item({ kind: 'assistant', tokens: 200, lifecycleTokens: 200 }),
      item({ kind: 'assistant', tokens: 5000, lifecycleTokens: 5000 }),
      item({ kind: 'assistant', tokens: 9000, lifecycleTokens: 9000 }),
    ])
  );
  // 占比确实被助手输出稀释 —— 同一会话实测从 9.0% 掉到 2.0% 就是这个原因
  assert.ok(long.restatementRatio < short.restatementRatio, '占比应随会话变长而下降');
  // 平均值纹丝不动，所以它才是可用的趋势指标
  assert.equal(short.userTokensPerMessage, 400);
  assert.equal(long.userTokensPerMessage, 400);
  assert.equal(long.userMessages, 1);
});

test('analyzeHabits：上下文启动成本取第一次调用', () => {
  const analysis = analysisWith([], [{ contextSize: 1234 }, { contextSize: 9999 }]);
  assert.equal(analyzeHabits(analysis).startupCost, 1234);
});

// ── 工作区体检 ────────────────────────────────────────────

test('inspectWorkspace：空目录得低分且列出缺失的必需项', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ctxgc-'));
  try {
    const result = inspectWorkspace(dir);
    assert.equal(result.score, 0);
    assert.deepEqual(result.missingRequired, ['自动入口', '长期记忆']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('inspectWorkspace：四要素齐全得满分', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ctxgc-'));
  try {
    writeFileSync(join(dir, 'AGENTS.md'), '# 入口');
    mkdirSync(join(dir, 'memory'));
    writeFileSync(join(dir, 'memory', 'a.md'), 'x');
    mkdirSync(join(dir, 'skills'));
    mkdirSync(join(dir, 'sessions'));
    const result = inspectWorkspace(dir);
    assert.equal(result.score, 100);
    assert.equal(result.missingRequired.length, 0);
    const memory = result.slots.find((s) => s.key === 'memory');
    assert.equal(memory.fileCount, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('inspectWorkspace：产出归档要递归统计子目录（约定本就是一层文件夹）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ctxgc-'));
  try {
    // 约定是 sessions/<日期-任务名>/，产出天然躺在子目录里 ——
    // 只数顶层会把它们全部漏掉：实测曾把 5 个文件、28 KB 报成「1 个文件，0.0 KB」，
    // 而且还显示 ✅ 达标，体检结论因此完全失真。
    mkdirSync(join(dir, 'sessions', '2026-09-21-some-task'), { recursive: true });
    writeFileSync(join(dir, 'sessions', '.gitkeep'), '');
    writeFileSync(join(dir, 'sessions', '2026-09-21-some-task', 'README.md'), 'x'.repeat(120));
    const sessions = inspectWorkspace(dir).slots.find((s) => s.label === '产出归档');
    assert.equal(sessions.fileCount, 2, '顶层与子目录里的文件都要数到');
    assert.ok(sessions.bytes >= 120, `子目录里的体积不能被漏掉，实际 ${sessions.bytes}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('scaffoldWorkspace：生成骨架但绝不覆盖已有文件', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ctxgc-'));
  try {
    writeFileSync(join(dir, 'AGENTS.md'), '我自己的内容');
    const actions = scaffoldWorkspace(dir);
    assert.equal(actions.find((a) => a.path.endsWith('AGENTS.md')).action, 'exists');
    assert.equal(readFileSync(join(dir, 'AGENTS.md'), 'utf8'), '我自己的内容');    assert.ok(existsSync(join(dir, 'memory', 'README.md')));
    assert.ok(existsSync(join(dir, 'skills', 'README.md')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('scaffoldWorkspace：dryRun 不落盘', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ctxgc-'));
  try {
    const actions = scaffoldWorkspace(dir, { dryRun: true });
    assert.ok(actions.every((a) => a.action === 'planned'));
    assert.ok(!existsSync(join(dir, 'memory')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 建议 ──────────────────────────────────────────────────

test('recommendations：缺必需项时给出高优先级建议', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ctxgc-'));
  try {
    const workspace = inspectWorkspace(dir);
    const advice = recommendations(workspace, {
      repeatCount: 0, repeatShare: 0, restatementRatio: 0, startupCost: 1000,
    });
    assert.ok(advice.some((a) => a.level === 'high' && a.text.includes('自动入口')));
    assert.ok(advice.some((a) => a.level === 'high' && a.text.includes('长期记忆')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recommendations：用户消息平均偏长才告警，占比高不算', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ctxgc-'));
  try {
    // 占比高、但每条都很短 → 不该告警（旧逻辑会在这里误报）
    const quiet = recommendations(inspectWorkspace(dir), {
      repeatCount: 0, repeatShare: 0, restatementRatio: 0.3,
      userMessages: 20, userTokensPerMessage: 40, startupCost: 1000,
    });
    assert.equal(
      quiet.some((a) => a.text.includes('背景重述')),
      false,
      '占比高不等于在反复交代背景 —— 那只是助手输出少'
    );

    // 每条都很长 → 必须告警
    const chatty = recommendations(inspectWorkspace(dir), {
      repeatCount: 0, repeatShare: 0, restatementRatio: 0.01,
      userMessages: 20, userTokensPerMessage: 900, startupCost: 1000,
    });
    assert.ok(chatty.some((a) => a.text.includes('背景重述')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recommendations：结构健康且指标正常时给出正向反馈', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ctxgc-'));
  try {
    writeFileSync(join(dir, 'AGENTS.md'), 'x');
    mkdirSync(join(dir, 'memory'));
    writeFileSync(join(dir, 'memory', 'a.md'), 'x');
    const advice = recommendations(inspectWorkspace(dir), {
      repeatCount: 0, repeatShare: 0, restatementRatio: 0, startupCost: 1000,
    });
    assert.ok(advice.some((a) => a.level === 'info'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
