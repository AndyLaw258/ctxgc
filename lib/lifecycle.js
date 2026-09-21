/**
 * 生命周期成本模型 —— 本项目的核心。
 *
 * ## 为什么现有工具都算错了
 *
 * 所有 token 统计工具算的都是**体积**：这一步读了多少、这一步写了多少。但真正
 * 决定开销的是**这东西在上下文里待了多久**。
 *
 * 一条 12,512 token 的目录列表，如果只出现一次，成本就是 12,512。
 * 但它出现在第 2 步，而这次会话一共有 90 步 —— 它会被**重读 88 次**。
 *
 * 因此本模型把成本从
 *    `成本 = 体积 × 单价`
 * 扩展为
 *    `成本 = 体积 × 存续轮数 × 单价`
 *
 * ## 存续轮数
 *
 * 条目在第 `k` 次调用时进入上下文（调用 k 本身就读到了它），此后一直驻留到第
 * `N-1` 次调用。因此：
 *    `reads = N - k`
 *    `lifecycleTokens = tokens × reads`
 *
 * `lifecycleTokens` 的含义是：**这条内容累计被读了多少 token**。它既不是体积，
 * 也不是花费，而是"占用带宽的总量"——这正是体积视角完全看不到的那一半。
 *
 * @module ctxgc/lifecycle
 */

/**
 * 为每个条目计算存续轮数与生命周期读取量。
 *
 * @param {Array<object>} items - {@link import('./items.js').buildItems} 的结果。
 * @param {number} totalCalls - 会话总调用次数。
 * @returns {Array<object>} 附加了 `reads` 与 `lifecycleTokens` 的条目。
 */
export function computeLifecycle(items, totalCalls) {
  return items.map((item) => {
    const reads = Math.max(0, totalCalls - item.enteredAtIndex);
    return {
      ...item,
      reads,
      lifecycleTokens: item.tokens * reads,
    };
  });
}

/**
 * 类别归并：把 `tool:pwsh`、`tool:read` 归到 `tool`，其余保持原样。
 *
 * @param {string} kind - 条目的 kind。
 * @returns {string} 归并后的类别。
 */
export function groupOf(kind) {
  if (kind.startsWith('tool:')) return 'tool';
  return kind;
}

/** 类别的中文标签。 */
export const GROUP_LABELS = Object.freeze({
  system: '系统提示词',
  runtime: '运行时快照',
  user: '用户消息',
  assistant: '助手输出',
  tool: '工具结果',
  other: '其他',
});

/**
 * 汇总生命周期数据。
 *
 * `avoidable` 的算法是诚实的：它**不假装知道哪条内容是垃圾**，而是问一个可回答
 * 的问题——"如果每条工具结果只保留一个摘要形态（默认 300 token），其余落盘待取，
 * 总共能少读多少？" 这是可避免量的**上界**，真实收益要靠第二层的治理机制实测。
 *
 * @param {Array<object>} items - {@link computeLifecycle} 的结果。
 * @param {object} [options]
 * @param {number} [options.digestTokens=300] - 每条工具结果改为摘要形态后的体积。
 * @returns {object} 汇总报告数据。
 */
export function summarizeLifecycle(items, options = {}) {
  const digestTokens = options.digestTokens ?? 300;

  const groups = new Map();
  let totalLifecycle = 0;
  let totalTokens = 0;

  for (const item of items) {
    const group = groupOf(item.kind);
    const entry = groups.get(group) || { group, count: 0, tokens: 0, lifecycleTokens: 0, bytes: 0 };
    entry.count += 1;
    entry.tokens += item.tokens;
    entry.lifecycleTokens += item.lifecycleTokens;
    entry.bytes += item.bytes;
    groups.set(group, entry);

    totalLifecycle += item.lifecycleTokens;
    totalTokens += item.tokens;
  }

  // 可避免量：工具结果按摘要形态重算生命周期成本后的差额
  const toolItems = items.filter((item) => groupOf(item.kind) === 'tool');
  const toolLifecycle = toolItems.reduce((sum, i) => sum + i.lifecycleTokens, 0);
  const digestLifecycle = toolItems.reduce(
    (sum, i) => sum + Math.min(i.tokens, digestTokens) * i.reads,
    0,
  );

  return {
    totalTokens,
    totalLifecycle,
    itemCount: items.length,
    groups: [...groups.values()].sort((a, b) => b.lifecycleTokens - a.lifecycleTokens),
    toolCount: toolItems.length,
    toolLifecycle,
    digestLifecycle,
    avoidable: Math.max(0, toolLifecycle - digestLifecycle),
    digestTokens,
    amplification: totalTokens > 0 ? totalLifecycle / totalTokens : 0,
  };
}

/**
 * 取生命周期成本最高的若干条目。
 *
 * @param {Array<object>} items - {@link computeLifecycle} 的结果。
 * @param {number} [limit=15] - 返回条数。
 * @returns {Array<object>} 排行榜。
 */
export function topOffenders(items, limit = 15) {
  return items
    .slice()
    .sort((a, b) => b.lifecycleTokens - a.lifecycleTokens)
    .slice(0, limit);
}

/**
 * 格式化 token 数，便于终端阅读。
 *
 * @param {number} value - token 数。
 * @returns {string} 如 `1.2M`、`18.4k`、`932`。
 */
export function formatTokens(value) {
  const n = Math.round(value);
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (Math.abs(n) >= 1_000) return `${(n / 1000).toFixed(2)}k`;
  return String(n);
}
