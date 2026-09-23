/**
 * DSH 适配器：把 DSH 的会话日志翻译成 {@link import('../ir.js').normalizeIR} 认得的 IR。
 *
 * 这一层是**翻译**，不是计算 —— 成本模型、归因、生命周期、模拟全在核心，
 * 这里只负责「读懂 DSH 的事件长什么样」。所以本文件是全项目唯一允许出现
 * `session.v3` / `system/message` / `tool/result` 这类字眼的地方（`items.js`
 * 与 `usage.js` 是它的下辖实现）。
 *
 * 复用而非重写：现有解析链已经跑通并有 70 项测试护着，适配器只做形状转换。
 */
import { listSessions, loadSession } from '../sessions.js';
import { analyzeUsage, growthWindows } from '../usage.js';
import { buildItems, CONTEXT_EVENT_TYPES, eventBytes } from '../items.js';
import { normalizeIR } from '../ir.js';

/**
 * 找出「不认识、却带着内容」的事件类型。
 *
 * 这是格式升级的第一手线索：DSH 加了新事件类型时，它不会被归因，报告数字会**偏低**
 * 但看起来正常 —— 静默少算比崩溃危险得多。所以这里把它揪出来交给自检层报警。
 *
 * 只报**携带实质内容**的：turn/start、step/end 这类心跳事件又小又无害，
 * 全报出来只会淹没真正重要的信号。
 *
 * @param events - 会话事件。
 * @returns `[{ type, bytes }]`，按字节降序。
 */
export function diagnoseEvents(events) {
  const known = new Set(CONTEXT_EVENT_TYPES);
  const unknown = new Map();
  for (const event of events ?? []) {
    const type = typeof event?.type === 'string' ? event.type : '(无 type 字段)';
    if (known.has(type)) continue;
    let bytes = 0;
    try {
      bytes = eventBytes(event);
    } catch {
      continue; // 结构畸形到算不出体积：不值得为它中断自检
    }
    if (bytes < UNKNOWN_EVENT_MIN_BYTES) continue;
    unknown.set(type, (unknown.get(type) ?? 0) + bytes);
  }
  return [...unknown.entries()]
    .map(([type, bytes]) => ({ type, bytes }))
    .sort((a, b) => b.bytes - a.bytes);
}

/** 小于这个体积的未知事件不报：心跳类事件没有诊断价值。 */
const UNKNOWN_EVENT_MIN_BYTES = 200;

/**
 * 把一个 DSH 会话句柄读成 IR。
 * @param handle - {@link listSessions} 返回的条目。
 * @param options - 目前未使用，保留给适配器统一签名。
 * @returns 规整后的 IR。
 */
export function dshToIR(handle, options = {}) {
    void options;
    const { events, frames } = loadSession(handle);
    const sessionEvent = events.find((e) => e.type === 'session');
    const usage = analyzeUsage(events);
    const windows = growthWindows(events, usage.calls);
    const { items, unattributed } = buildItems(events, usage.calls, windows);

    return normalizeIR({
        runtime: 'dsh',
        id: handle?.id ?? sessionEvent?.id ?? 'unknown',
        cwd: sessionEvent?.cwd ?? handle?.cwd ?? null,
        createdAt: sessionEvent?.createdAt ?? handle?.createdAt ?? null,
        frames,
        unattributed,
        diagnostics: { unknownEventTypes: diagnoseEvents(events) },
        // 调用序列：DSH 会逐次上报 usage，所以 contextSize 是精确值，不是估算
        calls: usage.calls.map((call, index) => ({
            index,
            contextSize: call.contextSize,
            outputTokens: call.outputTokens,
            readTokens: call.readTokens,
        })),
        items: items.map((item) => ({
            enteredAtIndex: item.enteredAtIndex,
            kind: item.kind,
            label: item.label,
            tokens: item.tokens,
            bytes: item.bytes,
            seq: item.seq,
            fingerprint: item.fingerprint ?? null,
        })),
    });
}

/**
 * DSH 适配器。核心只调用 `list` 与 `load`。
 * @type {import('../ir.js').Adapter}
 */
export const dshAdapter = {
    name: 'dsh',
    list: (options = {}) => listSessions(options),
    load: (handle, options = {}) => dshToIR(handle, options),
};
