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

export { listSessions, loadSession, findSessionLog, resolveDshHome, parseJsonl, SESSION_LOG_NAME } from './sessions.js';
export { decompressSessionLog, GZIP_MAGIC } from './decompress.js';
export { decodeZstdFrames, findFrameOffsets, ZSTD_MAGIC } from './zstd.js';
export { analyzeUsage, extractCalls, normalizeUsage, growthWindows } from './usage.js';
export { buildItems, describeItem, describeToolCall, indexToolCalls, eventBytes, fingerprintOf, FINGERPRINT_KEYS, CONTEXT_EVENT_TYPES } from './items.js';
export {
  estimateTokens,
  systemTextOf,
  collectTools,
  collectSystemPrompts,
  collectAgentsFiles,
  inspectPrompt,
  promptAdvice,
} from './prompt.js';
export { IR_VERSION, ITEM_KINDS, normalizeIR, irTotals } from './ir.js';
export { inspectHealth, RECONCILIATION_TOLERANCE } from './health.js';
export { dshAdapter, dshToIR } from './adapters/dsh.js';
export { genericAdapter, genericToIR, GENERIC_SESSION_DIR } from './adapters/generic.js';
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
  renderPrompt,
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
 * 从 IR 分析一个会话 —— **核心入口，与运行时无关**。
 *
 * {@link analyzeSession} 是它的一条特化路径（DSH 会话 → IR → 这里）。任何运行时的
 * 日志，只要适配器能翻译成 IR，就能走到这里，拿到同样的成本模型、生命周期与模拟 ——
 * 这正是 v1.0 要的解耦：**核心不认识任何一种日志格式**。
 *
 * 与 `analyzeSession` 的差别只在 DSH 特有的附赠品：本函数拿不到 `events`
 * （那是 DSH 事件流的原始形态）与 `usage.calls[].growth`（由 DSH 的事件窗口算出），
 * 所以对应字段为空。报告里凡是依赖它们的行会自行跳过。
 *
 * @param ir - {@link import('./ir.js').normalizeIR} 规整后的 IR。
 * @param {object} [options]
 * @param {number} [options.digestTokens=300] - 摘要形态的每条体积假设。
 * @param {number} [options.top=15] - 排行榜长度。
 * @returns {object} 与 {@link analyzeSession} 同形状的分析结果（`events` 为 null）。
 */
export function analyzeIR(ir, options = {}) {
  const calls = Array.isArray(ir?.calls) ? ir.calls : [];
  const withLifecycle = computeLifecycle(Array.isArray(ir?.items) ? ir.items : [], calls.length);
  const summary = summarizeLifecycle(withLifecycle, { digestTokens: options.digestTokens });
  const offenders = topOffenders(withLifecycle, options.top ?? 15);

  // 从调用序列重建用量总览。恒等式与 DSH 路径一致：total = input + cacheRead + output
  const totals = { input: 0, output: 0, cacheRead: 0, reasoning: 0, total: 0 };
  let peakContextSize = 0;
  let finalContextSize = 0;
  let contractions = 0;

  for (const call of calls) {
    const read = call.readTokens ?? 0;
    const cacheRead = call.cacheReadTokens ?? 0;
    const input = Math.max(0, read - cacheRead); // 未命中部分 = 读入 − 命中缓存
    const output = call.outputTokens ?? 0;

    totals.input += input;
    totals.cacheRead += cacheRead;
    totals.output += output;
    totals.reasoning += call.reasoningTokens ?? 0;
    totals.total += input + cacheRead + output;

    const size = call.contextSize ?? 0;
    if (size < finalContextSize) contractions += 1; // 上下文被压缩过：growth 会为负
    if (size > peakContextSize) peakContextSize = size;
    finalContextSize = size;
  }

  return {
    session: {
      id: ir?.id ?? 'unknown',
      cwd: ir?.cwd ?? null,
      runtime: ir?.runtime ?? 'unknown',
      createdAt: ir?.createdAt ?? null,
    },
    runtime: ir?.runtime ?? 'unknown',
    events: null,
    frames: ir?.frames ?? null,
    usage: { calls, totalCalls: calls.length, finalContextSize, peakContextSize, contractions, totals },
    items: withLifecycle,
    summary,
    offenders,
    unattributed: ir?.unattributed ?? 0,
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
    userMessages: 0,
    userTokensPerMessage: 0,
    startupCost: 0,
    repeats: [],
    repeatCount: 0,
    repeatLifecycle: 0,
    repeatShare: 0,
  };
  return { workspace, habits, advice: recommendations(workspace, habits) };
}
