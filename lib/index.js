/**
 * ctxgc —— Context Garbage Collector
 *
 * 审计 AI Agent 的上下文成本：找出进入上下文后再未被引用的内容，量化它随轮数
 * 放大的真实开销。
 *
 * 三层设计：
 *   ① 看得见 —— 审计引擎（本文件所在的一层，已实现）
 *   ② 管得住 —— 治理机制：工具结果结构化落盘 + 上下文句柄化（规划中）
 *   ③ 证得了 —— 开/关对照实验（规划中）
 *
 * @module ctxgc
 */

import { loadSession } from './sessions.js';
import { analyzeUsage, growthWindows } from './usage.js';
import { buildItems } from './items.js';
import { computeLifecycle, summarizeLifecycle, topOffenders } from './lifecycle.js';
import { simulateDigest, sensitivity, topSavings, byTool, sampleCurve } from './simulate.js';
import { inspectWorkspace, analyzeHabits, recommendations } from './workflow.js';

export { listSessions, loadSession, resolveDshHome, parseJsonl, SESSION_LOG_NAME } from './sessions.js';
export { decodeZstdFrames, findFrameOffsets, ZSTD_MAGIC } from './zstd.js';
export { analyzeUsage, extractCalls, normalizeUsage, growthWindows } from './usage.js';
export { buildItems, describeItem, describeToolCall, indexToolCalls, eventBytes, fingerprintOf, FINGERPRINT_KEYS, CONTEXT_EVENT_TYPES } from './items.js';
export {
  computeLifecycle,
  summarizeLifecycle,
  topOffenders,
  groupOf,
  formatTokens,
  GROUP_LABELS,
} from './lifecycle.js';
export {
  simulateDigest,
  sensitivity,
  topSavings,
  byTool,
  sampleCurve,
} from './simulate.js';
export {
  inspectWorkspace,
  analyzeHabits,
  recommendations,
  scaffoldWorkspace,
  isReadRepeat,
  WORKSPACE_SLOTS,
  ENTRY_TEMPLATE,
  MEMORY_TEMPLATE,
  SKILLS_TEMPLATE,
} from './workflow.js';
export {
  renderSessionReport,
  renderSimulation,
  renderWorkflow,
  renderOverview,
  pad,
  truncateDisplay,
  displayWidth,
  sparkline,
} from './report.js';

/**
 * 分析一个会话：从原始日志一路算到排行榜。
 *
 * @param {{id: string, project: string, logPath: string, bytes: number, modifiedAt: Date}} session
 *   {@link listSessions} 返回的会话条目。
 * @param {object} [options]
 * @param {number} [options.top=15] - 排行榜长度。
 * @param {number} [options.digestTokens=300] - 摘要形态的每条体积假设。
 * @returns {object} 分析结果。
 */
export function analyzeSession(session, options = {}) {
  const { events, frames } = loadSession(session);
  const sessionEvent = events.find((e) => e.type === 'session');
  const usage = analyzeUsage(events);
  const windows = growthWindows(events, usage.calls);
  const { items, unattributed } = buildItems(events, usage.calls, windows);
  const withLifecycle = computeLifecycle(items, usage.totalCalls);
  const summary = summarizeLifecycle(withLifecycle, { digestTokens: options.digestTokens });
  const offenders = topOffenders(withLifecycle, options.top ?? 15);

  return {
    session: { ...session, cwd: (sessionEvent && sessionEvent.cwd) || null },
    events,
    frames,
    usage,
    items: withLifecycle,
    summary,
    offenders,
    unattributed,
  };
}

/**
 * 反事实模拟：用真实调用序列重放「工具结果句柄化」策略。
 *
 * @param {object} analysis - {@link analyzeSession} 的结果。
 * @param {object} [options]
 * @param {number} [options.digestTokens=300] - 报告里着重展示的策略强度。
 * @param {number[]} [options.digests] - 敏感性分析扫描的取值。
 * @param {number} [options.top=12] - 治理收益排行长度。
 * @param {number} [options.points=14] - 曲线采样点数。
 * @returns {object} 模拟数据。
 */
export function simulateSession(analysis, options = {}) {
  const digestTokens = options.digestTokens ?? 300;
  const digests = options.digests ?? [0, 100, 300, 500, 1000, 2000, 4000];
  const calls = analysis.usage.totalCalls;
  const items = analysis.items;

  const sweeps = sensitivity(items, calls, digests.includes(digestTokens) ? digests : [...digests, digestTokens].sort((a, b) => a - b));
  const chosen = sweeps.find((s) => s.digestTokens === digestTokens) || sweeps[0];

  return {
    digestTokens,
    sweeps,
    chosen,
    savings: topSavings(items, digestTokens, options.top ?? 12),
    tools: byTool(items),
    curve: sampleCurve(chosen.steps, options.points ?? 14),
  };
}

/**
 * 工作流体检：把「记忆外置」这套工作方法变成可计算的指标。
 *
 * @param {object} analysis - {@link analyzeSession} 的结果。
 * @param {string} root - 工作区根目录。
 * @returns {{workspace: object, habits: object, advice: Array<object>}}
 */
export function inspectWorkflow(analysis, root) {
  const workspace = inspectWorkspace(root);
  const habits = analysis ? analyzeHabits(analysis) : {
    totalTokens: 0,
    userTokens: 0,
    toolTokens: 0,
    assistantTokens: 0,
    restatementRatio: 0,
    startupCost: 0,
    repeats: [],
    repeatCount: 0,
    repeatLifecycle: 0,
    repeatShare: 0,
  };
  return { workspace, habits, advice: recommendations(workspace, habits) };
}
