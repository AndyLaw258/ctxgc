/**
 * 用量归因引擎。
 *
 * ## 核心恒等式
 *
 * 实测 DSH 每次模型调用都会记录：
 *   `{ inputTokens, outputTokens, cacheReadTokens, reasoningTokens, totalTokens }`
 * 且满足
 *   `totalTokens = inputTokens + cacheReadTokens + outputTokens`
 *
 * 于是**模型在这一次调用中实际看到的上下文大小**可以精确算出：
 *   `contextSize = totalTokens - outputTokens`
 *
 * ## 归因
 *
 * 相邻两次调用之间，上下文净增多少：
 *   `growth(n) = contextSize(n) - contextSize(n-1)`
 *
 * `growth(n)` 就是「第 n-1 步产出、并在第 n 步被读到的全部内容」的**真实 token
 * 成本** —— 既包括工具结果，也包括上一步模型自己的输出（助手回复与工具调用参数）。
 * 两者都要计入：漏掉后者会让账面体积远小于实际上下文（实测差一倍）。
 *
 * `growth` 为负说明上下文发生了收缩（DSH 的压缩机制介入，或会话被重新投影），
 * 此时按 0 处理并单独计数，便于报告里提示。
 * 这是精确归因，不是按字节数的启发式估算 —— 也是本项目相对"拍脑袋估 token"
 * 的核心差别。
 *
 * @module ctxgc/usage
 */

/**
 * 提取每一次模型调用的用量记录。
 *
 * @param {Array<object>} events - 会话事件。
 * @returns {Array<{seq: number, step: number, turn: number, time: number, usage: object}>}
 *   按事件顺序排列。
 */
export function extractCalls(events) {
  const calls = [];
  for (const event of events) {
    if (event.type !== 'assistant/message') continue;
    const usage = event.data && event.data.usage;
    if (!usage) continue;
    calls.push({
      seq: event.seq,
      step: event.data.step,
      turn: event.data.turn,
      time: event.time,
      usage,
    });
  }
  return calls;
}

/**
 * 归一化一次调用的用量字段（兼容字段缺失）。
 *
 * @param {object} usage - 原始 usage 对象。
 * @returns {{input: number, output: number, cacheRead: number, reasoning: number, total: number}}
 */
export function normalizeUsage(usage) {
  const input = num(usage.inputTokens);
  const output = num(usage.outputTokens);
  const cacheRead = num(usage.cacheReadTokens);
  const reasoning = num(usage.reasoningTokens);
  // 优先用上报的 totalTokens；缺失时按恒等式回算
  const total = num(usage.totalTokens) || input + cacheRead + output;
  return { input, output, cacheRead, reasoning, total };
}

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * 建立上下文大小序列，并计算每一步的净增。
 *
 * @param {Array<object>} events - 会话事件。
 * @returns {{calls: Array<object>, totalCalls: number, finalContextSize: number, peakContextSize: number, contractions: number, totals: object}}
 *   `calls` 中每一项在原始用量之外附加：
 *   - `contextSize`：该次调用看到的上下文大小
 *   - `growth`：相比上一次调用，上下文净增多少（首次调用为 `contextSize` 本身）
 *   - `readTokens`：该次调用实际读入的 token（input + cacheRead）
 */
export function analyzeUsage(events) {
  const rawCalls = extractCalls(events);
  const calls = [];
  const totals = { input: 0, output: 0, cacheRead: 0, reasoning: 0, total: 0 };
  let contractions = 0;

  let previous = null;
  for (const call of rawCalls) {
    const usage = normalizeUsage(call.usage);
    const contextSize = Math.max(0, usage.total - usage.output);
    const growth = previous === null ? contextSize : contextSize - previous.contextSize;
    if (previous !== null && growth < 0) contractions += 1;

    calls.push({
      ...call,
      usage,
      contextSize,
      growth,
      readTokens: usage.input + usage.cacheRead,
    });

    totals.input += usage.input;
    totals.output += usage.output;
    totals.cacheRead += usage.cacheRead;
    totals.reasoning += usage.reasoning;
    totals.total += usage.total;

    previous = { contextSize, usage };
  }

  return {
    calls,
    totalCalls: calls.length,
    finalContextSize: calls.length ? calls[calls.length - 1].contextSize : 0,
    peakContextSize: calls.reduce((max, c) => Math.max(max, c.contextSize), 0),
    contractions,
    totals,
  };
}

/**
 * 计算一次调用相对上一次新增了哪些事件。
 *
 * 判定依据是事件序号：第 n 次调用（`assistant/message`，seq = `S_n`）看到的上下文
 * 是 `seq < S_n` 的全部事件，因此相对上一次调用新增的区间是 **[S_{n-1}, S_n)**。
 *
 * 注意左边界是**闭**的 —— `S_{n-1}` 正是上一次模型自己的输出，它同样会被后续
 * 每一次调用读到，必须计入。
 *
 * @param {Array<object>} events - 会话事件。
 * @param {Array<object>} calls - {@link analyzeUsage} 返回的 calls。
 * @returns {Map<number, Array<object>>} 调用序号（0-based）→ 该次调用新增的事件数组。
 */
export function growthWindows(events, calls) {
  const sorted = events.slice().sort((a, b) => a.seq - b.seq);
  const windows = new Map();

  calls.forEach((call, index) => {
    const from = index === 0 ? -Infinity : calls[index - 1].seq;
    const added = sorted.filter((e) => e.seq >= from && e.seq < call.seq);
    windows.set(index, added);
  });

  return windows;
}
