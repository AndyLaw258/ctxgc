/**
 * 自检：判断「这次分析可不可信」。
 *
 * 为什么单独做一层：日志格式升级最危险的后果**不是崩溃，而是静默少算** ——
 * 认不出的事件被丢掉，报告给出一个偏低的、却看起来完全正常的数字，使用者无从察觉。
 * 一个会崩的工具你立刻知道它坏了；一个数字偏低的工具你会照着它做决策。
 * 这一层负责让失效**发出声音**。
 *
 * ## 判据只有一条：对账对不上
 *
 * 账面体积之和应当等于上下文最终大小。对不上，就说明有内容没被归因。
 *
 * **未知事件类型本身不是警报** —— 这是踩过坑才定下来的：DSH 有一大批**不进上下文**
 * 的元事件（`tool/call` 是工具调用参数、`request/header` 是请求头、
 * `agent/inbox/spliced` 是内部调度…），它们本来就不该被归因。第一版把「不认识的事件
 * 类型」单独当警报，结果在一个**数字完全正确**的会话上误报 —— 一个总在喊狼来了的
 * 自检层，比没有自检层更糟：使用者会学会忽略它。
 *
 * 所以未知类型降级为**线索**：只有对账异常时才附上，用来指出最可能的元凶。
 */

/** 对账偏差超过这个比例就判为不可信。2% 是浮点与取整误差的量级。 */
export const RECONCILIATION_TOLERANCE = 0.02;

/** 未知事件类型在警告里最多列几个。 */
const MAX_LISTED_UNKNOWN = 5;

/**
 * 检查一次分析结果的可信度。
 *
 * @param ir - 规整后的 IR（提供 `diagnostics`）。
 * @param analysis - {@link import('./index.js').analyzeIR} 或 `analyzeSession` 的结果。
 * @returns `{ ok, deviation, accounted, actual, unexplained, unknownEventTypes, warnings }`。
 */
export function inspectHealth(ir, analysis) {
    const items = Array.isArray(analysis?.items) ? analysis.items : [];
    const accounted = items.reduce((sum, item) => sum + (item.tokens ?? 0), 0);
    const actual = analysis?.usage?.finalContextSize ?? 0;
    const deviation = actual > 0 ? (actual - accounted) / actual : 0;
    const unexplained = Math.max(0, actual - accounted);
    // 正常路径上 ir 已经过 normalizeIR 规整，但本模块到处都在防畸形输入，
    // 这里保持一致：被直接调用时也不该因为一个 null 条目就崩。
    const unknownEventTypes = (ir?.diagnostics?.unknownEventTypes ?? []).filter(
        (entry) => entry && typeof entry.type === 'string'
    );
    const warnings = [];

    const overTolerance = actual > 0 && Math.abs(deviation) > RECONCILIATION_TOLERANCE;

    if (overTolerance) {
        warnings.push({
            level: 'high',
            text:
                `归因对账偏差 ${(deviation * 100).toFixed(1)}%（容差 ±${(RECONCILIATION_TOLERANCE * 100).toFixed(0)}%）` +
                ` —— 有 ${Math.round(unexplained).toLocaleString('en-US')} token 没能归因到任何条目。` +
                '下面的数字请当作偏低的估计。',
        });

        // 对账既然对不上，未知事件类型就是头号嫌疑 —— 这时候列出来才有诊断价值
        if (unknownEventTypes.length > 0) {
            const shown = unknownEventTypes
                .slice(0, MAX_LISTED_UNKNOWN)
                .map((entry) => `${entry.type}（${entry.bytes.toLocaleString('en-US')} 字节）`)
                .join('、');
            warnings.push({
                level: 'high',
                text:
                    `最可能的元凶是 ${unknownEventTypes.length} 种没被认出来的事件类型：${shown}` +
                    `${unknownEventTypes.length > MAX_LISTED_UNKNOWN ? ' 等' : ''}` +
                    ' —— 若它们本该进入上下文，适配器需要跟上（lib/adapters/dsh.js）。',
            });
        } else {
            warnings.push({
                level: 'mid',
                text: '没有发现未知事件类型，所以问题更可能在适配器的归因逻辑本身，而不是日志格式。',
            });
        }
    }

    if ((analysis?.usage?.totalCalls ?? 0) === 0) {
        warnings.push({
            level: 'mid',
            text: '这个会话没有任何带用量的模型调用 —— 报告会是空的。确认一下选对了会话。',
        });
    }

    return {
        ok: warnings.length === 0,
        deviation,
        accounted,
        actual,
        unexplained,
        unknownEventTypes,
        warnings,
    };
}
