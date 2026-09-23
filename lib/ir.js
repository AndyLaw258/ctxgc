/**
 * 中间表示（IR）：ctxgc 核心与具体 Agent 运行时之间的**唯一契约**。
 *
 * 为什么需要它：核心的成本模型（体积 × 存续轮数）、归因、生命周期、模拟、报告，
 * 都不该知道 DSH 的日志长什么样。把它们绑死在一种格式上，换一个运行时就得重写
 * 全部 —— 而这个工具的价值恰恰在于它的**方法**（归因 + 反事实模拟 + 假阳性控制），
 * 方法不该被一种日志格式绑架。
 *
 * 两个概念，别混淆：
 *   - `calls` —— 模型调用序列。**唯一能算出真实上下文大小**的来源：运行时会逐次
 *     上报用量，而 `contextSize = totalTokens - outputTokens` 是精确的。
 *   - `items` —— 进入上下文的内容条目。体积是**按字节分摊的估算**，不是精确 token。
 *     报告里所有"某条内容多贵"的数字都建立在这一层，因此是估算。
 *
 * 适配器把某个运行时的日志翻译成这个形状；核心只认这个形状。
 */

/** IR 版本：适配器产出、核心消费，双方按它对齐。 */
export const IR_VERSION = 1;

/**
 * 条目类别约定。
 *
 * 固定值：`system` / `user` / `assistant` / `runtime` / `other`
 * 工具结果：`tool:<工具名>`，例如 `tool:read`、`tool:pwsh`。
 *
 * 报告的中文标签按 `tool:` 前缀归并成「工具结果」一类，其余按固定值取标签。
 */
export const ITEM_KINDS = {
  fixed: ['system', 'user', 'assistant', 'runtime', 'other'],
  toolPrefix: 'tool:',
};

/**
 * 规整一份 IR。
 *
 * 适配器是**自由代码**（用户可能自己写一个），产出畸形数据不该让核心抛异常 ——
 * 边界都在这里收口：丢弃非有限数、补齐缺失字段、过滤掉无法参与计算的调用。
 *
 * @param input - 适配器产出的候选 IR。
 * @returns 规整后的 IR。输入完全不可用时给出一个空会话，而不是抛异常。
 */
export function normalizeIR(input) {
  const source = input && typeof input === 'object' ? input : {};
  const num = (value) => (Number.isFinite(value) ? value : null);

  const calls = (Array.isArray(source.calls) ? source.calls : [])
    .map((call, i) => ({
      index: Number.isInteger(call?.index) ? call.index : i,
      contextSize: num(call?.contextSize),
      outputTokens: num(call?.outputTokens),
      readTokens: num(call?.readTokens),
      /** 可选的细分项：拿不到就是 null，报告会跳过对应行，而不是显示一个假的 0。 */
      cacheReadTokens: num(call?.cacheReadTokens),
      reasoningTokens: num(call?.reasoningTokens),
    }))
    // 没有 contextSize 的调用无法参与归因 —— 留着只会污染 growth 窗口
    .filter((call) => call.contextSize !== null);

  const items = (Array.isArray(source.items) ? source.items : []).map((item) => ({
    /**
     * 第几次调用时进入上下文。成本模型的**存续轮数完全依赖它** ——
     * 填错的代价是报告里每个数字都错，所以适配器最该校对的就是这一列。
     * （沿用核心既有字段名，避免为了改名而同时改动 20 处测试。）
     */
    enteredAtIndex: Number.isInteger(item?.enteredAtIndex) ? item.enteredAtIndex : 0,
    kind: typeof item?.kind === 'string' && item.kind.length > 0 ? item.kind : 'other',
    label: typeof item?.label === 'string' && item.label.length > 0 ? item.label : '(未命名)',
    tokens: num(item?.tokens) ?? 0,
    /** 原始字节数：报告展示与「归因对账」都要它，且它不受 token 估算系数影响。 */
    bytes: num(item?.bytes) ?? 0,
    /** 运行时内部的位置标记，只用于定位，核心不解释它的含义。 */
    seq: num(item?.seq),
    fingerprint: typeof item?.fingerprint === 'string' ? item.fingerprint : null,
  }));

  return {
    version: IR_VERSION,
    runtime: typeof source.runtime === 'string' ? source.runtime : 'unknown',
    id: typeof source.id === 'string' ? source.id : 'unknown',
    cwd: typeof source.cwd === 'string' ? source.cwd : null,
    createdAt: num(source.createdAt),
    /** 运行时特有的读取/解压元信息，只为报告展示，核心不解释它。 */
    frames: source.frames ?? null,
    /** 无法归因到任何条目的上下文增量（该窗口内没有可识别的事件）。对账时必须算上它。 */
    unattributed: num(source.unattributed) ?? 0,
    /**
     * 适配器的自检信息 —— **格式对不对，只有适配器自己知道**。
     *
     * 目前只有一项：遇到的不认识、却携带实质内容的事件类型。它是「日志格式可能
     * 已升级」的第一手线索。核心不解释它，只负责把它传给自检层去报警。
     */
    diagnostics: {
      unknownEventTypes: Array.isArray(source.diagnostics?.unknownEventTypes)
        ? source.diagnostics.unknownEventTypes
            .filter((entry) => entry && typeof entry.type === 'string')
            .map((entry) => ({ type: entry.type, bytes: num(entry.bytes) ?? 0 }))
        : [],
    },
    calls,
    items,
  };
}

/**
 * 会话级总览：报告开头的三个数。
 * @param ir - 规整后的 IR。
 * @returns `{ turns, finalContextSize, totalOutputTokens }`。
 */
export function irTotals(ir) {
  const calls = ir?.calls ?? [];
  const last = calls.length > 0 ? calls[calls.length - 1] : null;
  return {
    turns: calls.length,
    finalContextSize: last?.contextSize ?? 0,
    totalOutputTokens: calls.reduce((sum, call) => sum + (call.outputTokens ?? 0), 0),
  };
}

/**
 * 一个适配器要满足的形状。核心只调用这两个方法。
 *
 * @typedef {object} Adapter
 * @property {string} name - 运行时名（`dsh` / `generic` / …），出现在报告里。
 * @property {(options: object) => Array<object>} list - 列出可用会话（运行时自己的句柄）。
 * @property {(handle: object, options: object) => object} load - 把句柄加载成 IR。
 */
