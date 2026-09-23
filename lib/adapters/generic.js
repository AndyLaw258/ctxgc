/**
 * 通用适配器：读**标准 JSON** 会话文件，让任何 Agent 运行时都能接进来。
 *
 * 这是 v1.0 的关键一步 —— 它让 ctxgc 从「一个 DSH 的配套脚本」变成
 * 「一个可对任意运行时做上下文成本审计的工具」。
 *
 * 为什么不是「再写一个 Claude Code 适配器」：适配器的正确与否，只能靠**真实日志样本**
 * 检验。手上没有样本时写出来的适配器是**不可验证的代码**，与这个项目「先测量、
 * 再断言」的原则相悖。通用适配器把这一步交还给用户：写 20 行转换脚本，
 * 格式对不对一眼能看见，而且立刻能跑出结果。
 *
 * 文件格式（一个文件一个会话，UTF-8 JSON）：
 *
 *   {
 *     "id": "session-2026-09-22",     // 可选，缺省用文件名
 *     "cwd": "C:/work/project",       // 可选
 *     "createdAt": 1789976131032,     // 可选
 *     "unattributed": 0,              // 可选：无法归因到条目的增量
 *     "calls": [                      // 必需：模型调用序列
 *       { "contextSize": 12345, "outputTokens": 200, "readTokens": 12145 }
 *     ],
 *     "items": [                      // 必需：进入上下文的条目
 *       { "enteredAtIndex": 3, "kind": "tool:read", "label": "读取配置", "tokens": 500, "bytes": 1800 }
 *     ]
 *   }
 *
 * `enteredAtIndex` 是「第几次调用时进入上下文」（从 0 数），成本模型的存续轮数完全
 * 依赖它 —— 填错的代价是报告数字全错，所以转换脚本里最该校对的就是这一列。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { normalizeIR } from '../ir.js';

/** 通用会话文件的默认目录。可用 `--sessions <dir>` 覆盖。 */
export const GENERIC_SESSION_DIR = join(homedir(), '.ctxgc', 'sessions');

/**
 * 读一个标准 JSON 会话文件并转成 IR。
 *
 * 与 DSH 适配器不同，这里的**格式错误直接抛出** —— 文件是用户自己生成的，
 * 静默容错只会让人对着一个空报告猜哪里写错了。
 *
 * @param filePath - 会话文件的绝对路径。
 * @returns 规整后的 IR。
 */
export function genericToIR(filePath) {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`${filePath}: 顶层必须是一个 JSON 对象`);
    }
    if (!Array.isArray(parsed.calls)) {
        throw new Error(`${filePath}: 缺少 calls 数组（模型调用序列）`);
    }
    if (!Array.isArray(parsed.items)) {
        throw new Error(`${filePath}: 缺少 items 数组（进入上下文的条目）`);
    }
    return normalizeIR({
        ...parsed,
        runtime: 'generic',
        id: typeof parsed.id === 'string' ? parsed.id : basename(filePath, extname(filePath)),
    });
}

/**
 * 通用适配器。
 * @type {import('../ir.js').Adapter}
 */
export const genericAdapter = {
    name: 'generic',

    /**
     * 列出目录下的会话文件，**最近修改的排在前面**（和 DSH 适配器的默认一致）。
     * @param options - `{ sessionsDir }`，缺省用 {@link GENERIC_SESSION_DIR}。
     * @returns `[{ id, path, mtime }]`。
     */
    list(options = {}) {
        const dir = options.sessionsDir ?? GENERIC_SESSION_DIR;
        if (!existsSync(dir)) return [];
        return readdirSync(dir)
            .filter((name) => name.endsWith('.json'))
            .map((name) => {
                const path = join(dir, name);
                let mtime = 0;
                try {
                    mtime = statSync(path).mtimeMs;
                } catch {
                    // 竞态或权限：排序退化到文件名，不影响能不能读
                }
                return { id: basename(name, '.json'), path, mtime };
            })
            .sort((a, b) => b.mtime - a.mtime);
    },

    load(handle) {
        return genericToIR(handle.path);
    },
};
