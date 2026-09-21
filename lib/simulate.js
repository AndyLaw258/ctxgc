/**
 * 反事实模拟（counterfactual simulation）。
 *
 * ## 它回答什么问题
 *
 * 审计只告诉你"浪费了多少"，但它不能回答**"治理之后能省多少"**。
 * 本模块用一条真实会话的**实际调用序列与实际归因数据**，重算另一种上下文策略下
 * 会发生什么 —— 不是估算，是重放。
 *
 * ## 模型
 *
 * 给定策略「每条工具结果进入上下文时最多保留 `digest` 个 token，其余落盘待取」：
 *
 *   条目模拟体积 = min(实际体积, digest)
 *   第 k 步上下文 = Σ { 条目体积 | 该条目在 k 步或之前已进入 }
 *   模拟总读取     = Σ over k (第 k 步上下文)
 *
 * ## 交叉验证
 *
 * 由于 `readTokens = inputTokens + cacheReadTokens = contextSize`，必然有：
 *
 *   `Σ items.tokens × reads == Σ calls.contextSize == 累计读入`
 *
 * 实测两侧同为 15.25M。模拟结果与这条恒等式共用同一套基础数据，因此可信。
 *
 * @module ctxgc/simulate
 */

/**
 * 模拟「工具结果只保留 digest 个 token」后的上下文演化。
 *
 * 只对工具结果生效 —— 系统提示词、用户消息、助手输出是必要内容，不在治理范围内。
 *
 * @param {Array<object>} items - {@link import('./lifecycle.js').computeLifecycle} 的结果。
 * @param {number} totalCalls - 会话总调用次数。
 * @param {number} digestTokens - 策略允许的单条工具结果体积上限。
 * @returns {{digestTokens: number, steps: Array<{step: number, real: number, simulated: number}>, totalReal: number, totalSimulated: number, saved: number, savedRatio: number}}
 */
export function simulateDigest(items, totalCalls, digestTokens) {
  const governed = items.filter((item) => item.kind.startsWith('tool:'));

  const steps = [];
  let totalReal = 0;
  let totalSimulated = 0;

  for (let k = 0; k < totalCalls; k += 1) {
    let real = 0;
    let simulated = 0;
    for (const item of items) {
      if (item.enteredAtIndex > k) continue;
      real += item.tokens;
      simulated += item.kind.startsWith('tool:') ? Math.min(item.tokens, digestTokens) : item.tokens;
    }
    steps.push({ step: k, real, simulated });
    totalReal += real;
    totalSimulated += simulated;
  }

  return {
    digestTokens,
    steps,
    totalReal,
    totalSimulated,
    saved: totalReal - totalSimulated,
    savedRatio: totalReal > 0 ? (totalReal - totalSimulated) / totalReal : 0,
    governedCount: governed.length,
  };
}

/**
 * 敏感性分析：扫描一组 digest 取值，看节省如何随策略强度变化。
 *
 * @param {Array<object>} items - 条目。
 * @param {number} totalCalls - 会话总调用次数。
 * @param {number[]} [digests] - 待扫描的取值。
 * @returns {Array<object>} 每个取值对应的模拟结果。
 */
export function sensitivity(items, totalCalls, digests = [0, 100, 300, 500, 1000, 2000, 4000]) {
  return digests
    .filter((d) => Number.isFinite(d) && d >= 0)
    .map((digestTokens) => simulateDigest(items, totalCalls, digestTokens));
}

/**
 * 治理收益排行榜：换成句柄形态后省得最多的条目。
 *
 * @param {Array<object>} items - 条目。
 * @param {number} digestTokens - 策略上限。
 * @param {number} [limit=12] - 返回条数。
 * @returns {Array<object>} 排行榜。
 */
export function topSavings(items, digestTokens, limit = 12) {
  return items
    .filter((item) => item.kind.startsWith('tool:') && item.tokens > digestTokens)
    .map((item) => ({
      ...item,
      after: digestTokens,
      perReadSaved: item.tokens - digestTokens,
      saved: (item.tokens - digestTokens) * item.reads,
    }))
    .sort((a, b) => b.saved - a.saved)
    .slice(0, limit);
}

/**
 * 按工具名汇总生命周期成本 —— 回答"哪类工具最费"。
 *
 * @param {Array<object>} items - 条目。
 * @returns {Array<{tool: string, count: number, tokens: number, lifecycleTokens: number}>}
 *   按累计读取量降序。
 */
export function byTool(items) {
  const map = new Map();
  for (const item of items) {
    if (!item.kind.startsWith('tool:')) continue;
    const tool = item.kind.slice('tool:'.length);
    const entry = map.get(tool) || { tool, count: 0, tokens: 0, lifecycleTokens: 0 };
    entry.count += 1;
    entry.tokens += item.tokens;
    entry.lifecycleTokens += item.lifecycleTokens;
    map.set(tool, entry);
  }
  return [...map.values()].sort((a, b) => b.lifecycleTokens - a.lifecycleTokens);
}

/**
 * 从增长曲线里等距采样，便于终端绘图。
 *
 * @param {Array<{step: number, real: number, simulated: number}>} steps - 逐步数据。
 * @param {number} [points=12] - 采样点数。
 * @returns {Array<object>} 采样后的点。
 */
export function sampleCurve(steps, points = 12) {
  if (steps.length === 0) return [];
  if (steps.length <= points) return steps.slice();
  const stride = (steps.length - 1) / (points - 1);
  const sampled = [];
  for (let i = 0; i < points; i += 1) {
    sampled.push(steps[Math.round(i * stride)]);
  }
  return sampled;
}
