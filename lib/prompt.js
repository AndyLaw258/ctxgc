/**
 * 常驻成本审计：系统提示词里**每一轮都要付一次钱**的部分。
 *
 * 为什么单独做一层：会话日志只落了系统提示的一小块。实测三块的真实比例约为
 * **7.5 : 2 : 0.7**（工具定义 : 系统提示 : 工作区约定），只读会话日志时只能看到
 * 中间那块 —— 于是每轮固定开销被低估到实际的三分之一。
 *
 *   工具定义    `request/header` 事件的 `data.header.tools`（结构化，不是拼好的文本）
 *   系统提示    `system/message` 事件的 `data.message.content`
 *   工作区约定  文件系统的 `AGENTS.md`（**根本不进日志**）
 *
 * 只有三块都取到，"删掉哪句能省多少"才是可回答的问题。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 估算文本的 token 数。
 *
 * 这是**估算**，不是 DSH 上报的真实用量 —— 工具定义与系统提示都不单独上报。
 * 系数取自实测：CJK 约 0.7 token/字，其余（英文、JSON、标点）约 4 字符/token。
 * @param text - 待估算的文本。
 * @returns 估算的 token 数（非字符串返回 0）。
 */
export function estimateTokens(text) {
    if (typeof text !== 'string' || text.length === 0) return 0;
    const cjk = (text.match(/[\u3400-\u9fff\u3000-\u303f\uff00-\uffef]/g) || []).length;
    return Math.round(cjk * 0.7 + (text.length - cjk) / 4);
}

/**
 * 取系统提示词的文本。
 *
 * 注意取的是 `data.message.content` —— 与 `user/message` 的 `data.content`
 * **不是同一个位置**，早先按后者取只会拿到空字符串。
 * @param event - 一个 `system/message` 事件。
 * @returns 拼好的纯文本。
 */
export function systemTextOf(event) {
    const content = event?.data?.message?.content ?? event?.data?.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content
            .filter((c) => c?.type === 'text')
            .map((c) => c.text ?? '')
            .join('');
    }
    return '';
}

/**
 * 工具定义：只出现在 `request/header` 里，且只在工具集变化时记录一次。
 * @param events - 会话事件列表。
 * @returns `{ found, items, chars, tokens }`，items 按体积降序。
 */
export function collectTools(events) {
    // 取**最后**一条：工具集会随 profile 变更（禁用插件后 DSH 会重新记录一次），
    // 最新的那条才代表当前生效的定义。取第一条会永远显示改造前的旧数据。
    const header = (events ?? []).filter((e) => e.type === 'request/header').pop();
    const tools = header?.data?.header?.tools;
    if (!Array.isArray(tools) || tools.length === 0) {
        return { found: false, items: [], chars: 0, tokens: 0 };
    }
    const items = tools
        .map((tool) => {
            const raw = JSON.stringify(tool ?? null);
            return {
                name: tool?.name ?? tool?.function?.name ?? '(未命名)',
                chars: raw.length,
                tokens: estimateTokens(raw),
            };
        })
        .sort((a, b) => b.chars - a.chars);
    return {
        found: true,
        items,
        chars: items.reduce((sum, i) => sum + i.chars, 0),
        tokens: items.reduce((sum, i) => sum + i.tokens, 0),
    };
}

/**
 * 会话日志里落盘的系统提示词（可能有多条：会话中途重建过）。
 * @param events - 会话事件列表。
 * @returns `{ count, items, chars, tokens }`。
 */
export function collectSystemPrompts(events) {
    const items = (events ?? [])
        .filter((e) => e.type === 'system/message')
        .map((e) => {
            const text = systemTextOf(e);
            return {
                turn: e?.data?.turn ?? null,
                chars: text.length,
                tokens: estimateTokens(text),
            };
        });
    return {
        count: items.length,
        items,
        chars: items.reduce((sum, i) => sum + i.chars, 0),
        // 多条系统提示是先后接替的关系，不是叠加 —— 取最大的一条才是每轮真实开销
        tokens: items.reduce((max, i) => Math.max(max, i.tokens), 0),
    };
}

/**
 * 工作区约定文件。这部分完全不进日志，只能从文件系统量。
 * @param root - 工作区根目录。
 * @param dshHome - DSH 家目录（`AGENTS.md` 在那里是全局约定）。
 * @returns `{ items, chars, tokens }`，items 只含真实存在的文件。
 */
export function collectAgentsFiles(root, dshHome) {
    const candidates = [
        dshHome ? { path: join(dshHome, 'AGENTS.md'), scope: '用户全局' } : null,
        root ? { path: join(root, 'AGENTS.md'), scope: '工作区' } : null,
    ].filter(Boolean);

    const items = [];
    for (const { path, scope } of candidates) {
        if (!existsSync(path)) continue;
        let text = '';
        try {
            text = readFileSync(path, 'utf8');
        } catch {
            continue; // 权限或竞态：忽略，保持审计不中断
        }
        items.push({ scope, path, chars: text.length, tokens: estimateTokens(text) });
    }
    return {
        items,
        chars: items.reduce((sum, i) => sum + i.chars, 0),
        tokens: items.reduce((sum, i) => sum + i.tokens, 0),
    };
}

/**
 * 汇总每轮固定开销。
 * @param analysis - {@link import('./index.js').analyzeSession} 的结果。
 * @param options - `{ root, dshHome }`。
 * @returns 各部分的体积、每轮成本、以及按轮数折算的总额。
 */
export function inspectPrompt(analysis, options = {}) {
    const events = analysis?.session?.events ?? analysis?.events ?? [];
    const turns = analysis?.usage?.calls?.length ?? 0;

    const tools = collectTools(events);
    const system = collectSystemPrompts(events);
    const agents = collectAgentsFiles(options.root, options.dshHome);

    const parts = [
        { key: 'tools', label: '工具定义', count: tools.items.length, chars: tools.chars, tokens: tools.tokens },
        { key: 'system', label: '系统提示', count: system.count, chars: system.chars, tokens: system.tokens },
        { key: 'agents', label: '工作区约定', count: agents.items.length, chars: agents.chars, tokens: agents.tokens },
    ].sort((a, b) => b.tokens - a.tokens);

    const perTurn = parts.reduce((sum, p) => sum + p.tokens, 0);

    return {
        turns,
        parts,
        tools,
        system,
        agents,
        perTurn,
        total: perTurn * turns,
        /** 会话日志只落了系统提示，工具定义与约定都看不到 —— 用它说明漏了多少。 */
        visibleFromLog: system.tokens,
    };
}

/**
 * 给出可操作的优化建议。
 *
 * 只对**用户真的能改**的东西开口：工具定义属于 profile 的插件开关，约定文件是用户自己的。
 * 系统提示里由 DSH 决定的部分不提建议 —— 提了也做不到。
 * @param prompt - {@link inspectPrompt} 的结果。
 * @returns 建议数组 `{ level, text }`。
 */
export function promptAdvice(prompt) {
    const out = [];
    if (prompt.turns === 0) return out;

    if (prompt.visibleFromLog > 0 && prompt.perTurn > prompt.visibleFromLog * 2) {
        out.push({
            level: 'info',
            text: `每轮固定开销 ${prompt.perTurn.toLocaleString('en-US')} token，其中会话日志只能看到 ${prompt.visibleFromLog.toLocaleString('en-US')} —— 剩下的是工具定义与约定文件，它们同样每轮都在付钱`,
        });
    }

    // 工具定义：列出最贵的几个，并提示"用不到的工具是纯支出"
    const heavy = prompt.tools.items.slice(0, 3);
    if (heavy.length > 0) {
        out.push({
            level: 'mid',
            text: `工具定义占 ${prompt.tools.tokens.toLocaleString('en-US')} token/轮（${prompt.tools.items.length} 个工具），最贵的是 ${heavy
                .map((t) => `${t.name} ${t.tokens}`)
                .join('、')} —— 用不到的工具插件可以在 profile 层关掉，每关一个都是每轮省一次`,
        });
    }

    const agentsTotal = prompt.agents.tokens;
    if (agentsTotal > 0) {
        out.push({
            level: agentsTotal > 500 ? 'mid' : 'info',
            text: `AGENTS.md 合计 ${agentsTotal.toLocaleString('en-US')} token/轮（本会话已烧 ${(agentsTotal * prompt.turns).toLocaleString('en-US')}）—— 这是完全由你控制的部分，读一次就够的说明该下沉到 memory/ 按需读取`,
        });
    }

    return out;
}
