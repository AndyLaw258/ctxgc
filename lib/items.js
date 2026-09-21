/**
 * 内容项提取：把会话事件转成「占据上下文的条目」，并归因真实 token 成本。
 *
 * 不是所有事件都进模型上下文 —— `turn/start`、`step/start`、`approval/*` 这类是
 * DSH 的内部记账事件。真正占据上下文的是这四类：
 *   `system/message`、`user/message`、`assistant/message`、`tool/result`
 *
 * 归因方法：把每次调用窗口内的 `growth`（见 usage.js）按**字节占比**分摊到窗口内
 * 的条目上。之所以用字节占比而不是平均分，是因为同一步里可能既有 12 KB 的目录
 * 列表，也有 200 字节的小结果 —— 平均分会把两者算成一样贵。
 *
 * @module ctxgc/items
 */

/** 会进入模型上下文的事件类型。 */
export const CONTEXT_EVENT_TYPES = Object.freeze([
  'system/message',
  'user/message',
  'assistant/message',
  'tool/result',
]);

/**
 * 事件数据的字节数（UTF-8）——分摊权重的依据。
 *
 * @param {object} event - 会话事件。
 * @returns {number} 字节数。
 */
export function eventBytes(event) {
  if (!event || event.data === undefined) return 0;
  try {
    return Buffer.byteLength(JSON.stringify(event.data), 'utf8');
  } catch {
    return 0;
  }
}

/**
 * 建立 `callId → 工具调用` 索引。
 *
 * @param {Array<object>} events - 会话事件。
 * @returns {Map<string, {name: string, args: object}>} 索引。
 */
export function indexToolCalls(events) {
  const index = new Map();
  for (const event of events) {
    if (event.type !== 'tool/call') continue;
    let args = {};
    try {
      args = JSON.parse(event.data.arguments || '{}');
    } catch {
      args = {};
    }
    index.set(event.data.callId, { name: event.data.name, args, seq: event.seq });
  }
  return index;
}

/**
 * 把工具调用参数压成一行可读摘要。
 *
 * @param {string} name - 工具名。
 * @param {object} args - 参数对象。
 * @returns {string} 摘要，如 `pwsh | Get-ChildItem -Recurse`。
 */
export function describeToolCall(name, args) {
  const target = args.command
    || args.url
    || args.file_path
    || args.path
    || args.pattern
    || args.description
    || args.prompt
    || '';
  const flat = String(target).replace(/\s+/g, ' ').trim().slice(0, 96);
  return flat ? `${name} | ${flat}` : String(name || '未知工具');
}

/**
 * 生成一个内容条目的可读描述。
 *
 * @param {object} event - 会话事件。
 * @param {Map<string, object>} toolCalls - {@link indexToolCalls} 的结果。
 * @returns {{label: string, kind: string}} 标签与类别。
 */
export function describeItem(event, toolCalls) {
  switch (event.type) {
    case 'system/message':
      return { label: '系统提示词', kind: 'system' };
    case 'user/message': {
      const text = (event.data.content || [])
        .filter((c) => c.type === 'text')
        .map((c) => c.text)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      const isContext = /^Current runtime context\./.test(text);
      return {
        label: isContext ? '运行时上下文快照' : `用户消息：${text.slice(0, 72)}`,
        kind: isContext ? 'runtime' : 'user',
      };
    }
    case 'assistant/message': {
      const blocks = (event.data.message && event.data.message.content) || [];
      const hasText = blocks.some((b) => b.type === 'text' && String(b.text || '').trim());
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join(' ').replace(/\s+/g, ' ').trim();
      return {
        label: hasText ? `助手回复：${text.slice(0, 72)}` : '助手思考 + 工具调用',
        kind: 'assistant',
      };
    }
    case 'tool/result': {
      const callId = event.data.message && event.data.message.source && event.data.message.source.callId;
      const call = callId ? toolCalls.get(callId) : undefined;
      const label = call ? describeToolCall(call.name, call.args) : '工具结果（无法追溯调用）';
      const toolName = call ? call.name : 'unknown';
      return { label, kind: `tool:${toolName}` };
    }
    default:
      return { label: event.type, kind: 'other' };
  }
}

/**
 * 每种工具「真正决定返回什么」的参数。
 *
 * 指纹只取这些键，理由：
 * - 用整个参数对象会把 `description`、`timeoutMs` 这类无关字段算进去，导致同一份
 *   信息因描述不同而被判为两次获取（漏报）。
 * - 只用第一个参数又会让「同目录不同 pattern 的 grep」被判为重复（误报，实测踩过）。
 * - 不在表里的工具一律不参与重复检测 —— 白名单比黑名单干净。
 */
export const FINGERPRINT_KEYS = Object.freeze({
  read: ['file_path'],
  grep: ['pattern', 'path'],
  glob: ['pattern', 'path'],
  web_fetch: ['url'],
  web_search: ['queries'],
  pwsh: ['command'],
  bash: ['command'],
  read_image: ['file_path'],
  job_output: ['job_id'],
});

function normalizeArg(value) {
  if (value === undefined || value === null) return '';
  if (Array.isArray(value)) return value.join('|');
  return String(value).replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * 计算工具结果的「目标指纹」——用于检测重复获取。
 *
 * 注意用的是**完整参数**而不是展示用的 `label`：`label` 为排版截断到 96 字符，
 * 两条不同的长命令可能因此前缀相同，造成误报（实测踩过）。
 *
 * @param {object} event - 会话事件。
 * @param {Map<string, object>} toolCalls - {@link indexToolCalls} 的结果。
 * @returns {string|null} 指纹，该工具不参与检测时返回 null。
 */
export function fingerprintOf(event, toolCalls) {
  if (!event || event.type !== 'tool/result') return null;
  const callId = event.data.message && event.data.message.source && event.data.message.source.callId;
  const call = callId ? toolCalls.get(callId) : undefined;
  if (!call) return null;

  const keys = FINGERPRINT_KEYS[call.name];
  if (!keys) return null;

  const parts = keys
    .map((key) => [key, normalizeArg(call.args[key])])
    .filter(([, value]) => value !== '')
    .map(([key, value]) => `${key}=${value}`);

  if (parts.length === 0) return null;
  return `${call.name}::${parts.join('&')}`;
}

/**
 * 构建内容项清单，并把每次调用的 `growth` 分摊到窗口内的条目上。
 *
 * @param {Array<object>} events - 会话事件。
 * @param {Array<object>} calls - {@link import('./usage.js').analyzeUsage} 返回的 calls。
 * @param {Map<number, Array<object>>} windows - {@link import('./usage.js').growthWindows} 的结果。
 * @returns {{items: Array<object>, unattributed: number}} 条目清单与未能归因的 token 量。
 */
export function buildItems(events, calls, windows) {
  const toolCalls = indexToolCalls(events);
  const items = [];
  let unattributed = 0;

  calls.forEach((call, index) => {
    const window = (windows.get(index) || []).filter((e) => CONTEXT_EVENT_TYPES.includes(e.type));
    if (window.length === 0) {
      unattributed += Math.max(0, call.growth);
      return;
    }

    const sized = window.map((event) => ({ event, bytes: eventBytes(event) }));
    const windowBytes = sized.reduce((sum, s) => sum + s.bytes, 0);
    const growth = Math.max(0, call.growth);

    for (const { event, bytes } of sized) {
      const share = windowBytes > 0 ? (bytes / windowBytes) * growth : growth / sized.length;
      const { label, kind } = describeItem(event, toolCalls);
      items.push({
        seq: event.seq,
        kind,
        label,
        fingerprint: fingerprintOf(event, toolCalls),
        bytes,
        tokens: Math.round(share),
        enteredAtIndex: index,
        enteredAtSeq: call.seq,
      });
    }
  });

  return { items, unattributed: Math.round(unattributed) };
}
