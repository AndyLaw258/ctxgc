/**
 * 工作流审计：验证「记忆外置」这套工作方法到底省了多少。
 *
 * ## 为什么需要这一层
 *
 * 审计与模拟能算出「上下文里的浪费」，但管不到**你怎么工作**。而实践中最大的
 * 一笔节省来自工作方式本身：
 *
 *   把信息放文件系统（记忆外置），按需读取
 *   而不是把信息堆在对话历史里（每轮重读）
 *
 * 这套方法有效，但有个致命短板：**没有度量**。做了却不知道省了多少、哪部分
 * 最有效。本模块把它变成可计算的指标。
 *
 * ## 四个指标
 *
 * | 指标 | 算法 | 高值说明 |
 * |---|---|---|
 * | 背景重述成本 | 用户消息 token ÷ 上下文总量 | 每次都在重新交代背景 → 记忆没外置 |
 * | 重复获取 | 相同文件/命令被获取多次 | 结果没沉淀 → 该固化到 memory/skills |
 * | 上下文启动成本 | 首次调用的上下文大小 | 入口过重或背景塞太多 |
 * | 归档健康度 | 目录结构四要素是否健全 | 产出散落，下次找不到 |
 *
 * @module ctxgc/workflow
 */

import { existsSync, readdirSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';

/**
 * 工作区结构的四要素及其常见命名。
 *
 * 命名不硬编码 —— DSH 的入口文件由 `dsh-agent-instructions` 自动发现，其余三类
 * 是约定，随团队习惯变化，因此这里给候选集合而不是唯一答案。
 */
export const WORKSPACE_SLOTS = Object.freeze({
  entry: {
    label: '自动入口',
    candidates: ['AGENTS.md', 'CLAUDE.md'],
    purpose: '每个新会话自动注入，负责告诉 AI「有什么资源、该读哪个」',
    required: true,
  },
  memory: {
    label: '长期记忆',
    candidates: ['memory', 'docs', 'notes', 'knowledge'],
    purpose: '项目背景、约定、踩过的坑 —— 替代「翻聊天记录」',
    required: true,
  },
  skills: {
    label: '可复用流程',
    candidates: ['skills', '.skills', 'workflows'],
    purpose: '把做对过的流程固化成文件，下次直接调用',
    required: false,
  },
  archive: {
    label: '产出归档',
    candidates: ['sessions', 'archive', 'outputs', 'tasks'],
    purpose: '一次工作一个文件夹，产出归类，下次能找到',
    required: false,
  },
});

/**
 * 体检工作区结构。
 *
 * @param {string} root - 工作区根目录。
 * @returns {{root: string, slots: Array<object>, score: number, missingRequired: string[]}}
 *   `score` 为 0-100 的结构健康度（必需项权重更高）。
 */
export function inspectWorkspace(root) {
  const slots = [];
  let earned = 0;
  let total = 0;

  for (const [key, spec] of Object.entries(WORKSPACE_SLOTS)) {
    const weight = spec.required ? 2 : 1;
    total += weight;

    let found = null;
    for (const candidate of spec.candidates) {
      const path = join(root, candidate);
      if (existsSync(path)) {
        found = { path, name: candidate, isDir: statSync(path).isDirectory() };
        break;
      }
    }

    let fileCount = 0;
    let bytes = 0;
    if (found && found.isDir) {
      try {
        for (const entry of readdirSync(found.path)) {
          const p = join(found.path, entry);
          if (statSync(p).isFile()) {
            fileCount += 1;
            bytes += statSync(p).size;
          }
        }
      } catch {
        // 权限或竞态：忽略，保持体检不中断
      }
    } else if (found) {
      fileCount = 1;
      bytes = statSync(found.path).size;
    }

    if (found) earned += weight;

    slots.push({
      key,
      label: spec.label,
      purpose: spec.purpose,
      required: spec.required,
      present: Boolean(found),
      name: found ? found.name : null,
      isDir: found ? found.isDir : false,
      fileCount,
      bytes,
    });
  }

  return {
    root,
    slots,
    score: total > 0 ? Math.round((earned / total) * 100) : 0,
    missingRequired: slots.filter((s) => s.required && !s.present).map((s) => s.label),
  };
}

/**
 * 判断一个条目是否属于「重复获取」的候选。
 *
 * 判定权已经交给 `items.js` 的 `fingerprintOf` —— 只有列入白名单、且参数能确定
 * 唯一目标的工具才会带指纹。写入类工具（`edit` / `write`）天然无指纹，
 * 因此同一文件被反复编辑不会被误判为重复获取（实测：一次重构里同一文件编辑 9 次
 * 是健康的）。
 *
 * @param {object} item - 内容条目。
 * @returns {boolean} 命中返回 true。
 */
export function isReadRepeat(item) {
  return Boolean(item && item.kind.startsWith('tool:') && item.fingerprint);
}

/**
 * 分析会话的工作习惯。
 *
 * @param {object} analysis - {@link import('./index.js').analyzeSession} 的结果。
 * @returns {object} 习惯指标。
 */
export function analyzeHabits(analysis) {
  const { items, usage } = analysis;

  const userTokens = sum(items.filter((i) => i.kind === 'user').map((i) => i.tokens));
  const toolTokens = sum(items.filter((i) => i.kind.startsWith('tool:')).map((i) => i.tokens));
  const assistantTokens = sum(items.filter((i) => i.kind === 'assistant').map((i) => i.tokens));
  const totalTokens = sum(items.map((i) => i.tokens));

  // 重复获取：同一目标被多个「读取类」条目命中
  const byFingerprint = new Map();
  for (const item of items) {
    if (!isReadRepeat(item)) continue;
    const list = byFingerprint.get(item.fingerprint) || [];
    list.push(item);
    byFingerprint.set(item.fingerprint, list);
  }
  const repeats = [...byFingerprint.entries()]
    .filter(([, list]) => list.length > 1)
    .map(([fingerprint, list]) => ({
      fingerprint,
      count: list.length,
      tokens: sum(list.map((i) => i.tokens)),
      lifecycleTokens: sum(list.map((i) => i.lifecycleTokens)),
      label: list[0].label,
    }))
    .sort((a, b) => b.lifecycleTokens - a.lifecycleTokens);

  const repeatLifecycle = sum(repeats.map((r) => r.lifecycleTokens));

  return {
    totalTokens,
    userTokens,
    toolTokens,
    assistantTokens,
    /** 背景重述成本：用户消息占上下文的比例。越高说明越依赖"重新交代背景"。 */
    restatementRatio: totalTokens > 0 ? userTokens / totalTokens : 0,
    /** 上下文启动成本：第一次调用时上下文有多大。 */
    startupCost: usage.calls.length ? usage.calls[0].contextSize : 0,
    /** 重复获取：同一目标被获取多次。 */
    repeats,
    repeatCount: repeats.reduce((n, r) => n + (r.count - 1), 0),
    repeatLifecycle,
    repeatShare: sum(items.map((i) => i.lifecycleTokens)) > 0
      ? repeatLifecycle / sum(items.map((i) => i.lifecycleTokens))
      : 0,
  };
}

function sum(values) {
  return values.reduce((a, b) => a + b, 0);
}

/**
 * 生成建议。
 *
 * @param {object} workspace - {@link inspectWorkspace} 的结果。
 * @param {object} habits - {@link analyzeHabits} 的结果。
 * @returns {Array<{level: 'high'|'mid'|'info', text: string}>} 建议清单，按优先级排序。
 */
export function recommendations(workspace, habits) {
  const out = [];

  if (!workspace.slots.find((s) => s.key === 'entry')?.present) {
    out.push({
      level: 'high',
      text: '缺少自动入口（AGENTS.md）—— 这是「不靠人提醒」的关键。没有它，AI 每次都要你口头交代去哪找资料',
    });
  }
  if (!workspace.slots.find((s) => s.key === 'memory')?.present) {
    out.push({
      level: 'high',
      text: '缺少长期记忆目录 —— 信息只能堆在对话历史里，每轮重读。建 memory/ 存放项目背景与约定',
    });
  }
  if (!workspace.slots.find((s) => s.key === 'skills')?.present && habits.repeatCount > 0) {
    out.push({
      level: 'mid',
      text: `本会话有 ${habits.repeatCount} 次重复获取 —— 这些流程适合固化到 skills/，下次直接调用而不是重新摸索`,
    });
  }
  if (habits.restatementRatio > 0.05) {
    out.push({
      level: 'high',
      text: `背景重述占上下文 ${(habits.restatementRatio * 100).toFixed(1)}% —— 偏高。说明每次都在重新交代背景，应写进 memory/ 让入口自动加载`,
    });
  }
  if (habits.startupCost > 15_000) {
    out.push({
      level: 'mid',
      text: `上下文启动成本 ${habits.startupCost.toLocaleString('en-US')} token —— 入口偏重。检查 AGENTS.md 是否塞了太多细节，细节应放 memory/ 按需读取`,
    });
  }
  if (habits.repeatShare > 0.02) {
    out.push({
      level: 'mid',
      text: `重复获取占总读取 ${(habits.repeatShare * 100).toFixed(1)}% —— 同一份信息被反复取回，正是「结果没沉淀」的特征`,
    });
  }
  if (out.length === 0) {
    out.push({ level: 'info', text: '结构健康，未发现明显问题' });
  }

  return out;
}

/**
 * 生成记忆外置工作区的骨架文件。
 *
 * 已存在的文件一律不覆盖 —— 骨架是引导，不是接管。
 *
 * @param {string} root - 工作区根目录。
 * @param {object} [options]
 * @param {boolean} [options.dryRun=false] - 只报告将创建什么，不落盘。
 * @returns {Array<{path: string, action: 'created'|'exists'|'planned'}>} 操作记录。
 */
export function scaffoldWorkspace(root, options = {}) {
  const dryRun = options.dryRun === true;
  const files = [
    { rel: 'AGENTS.md', content: ENTRY_TEMPLATE },
    { rel: 'memory/README.md', content: MEMORY_TEMPLATE },
    { rel: 'skills/README.md', content: SKILLS_TEMPLATE },
    { rel: 'sessions/.gitkeep', content: '' },
  ];

  const actions = [];
  for (const file of files) {
    const path = join(root, ...file.rel.split('/'));
    if (existsSync(path)) {
      actions.push({ path, action: 'exists' });
      continue;
    }
    if (dryRun) {
      actions.push({ path, action: 'planned' });
      continue;
    }
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, file.content, 'utf8');
    actions.push({ path, action: 'created' });
  }
  return actions;
}

/** 入口模板：自动注入，负责路由到各层，自身保持精简。 */
export const ENTRY_TEMPLATE = `# 工作区入口

本文件由 DSH 在每个新会话自动加载。**保持精简** —— 这里只放「有什么、该读哪个」，
细节一律放 \`memory/\`，按需读取。

## 目录约定

| 目录 | 放什么 | 什么时候读 |
|---|---|---|
| \`memory/\` | 项目背景、约定、踩过的坑 | 接到任务先扫一遍索引 |
| \`skills/\` | 可复用流程（一步步怎么做） | 遇到同类任务时读对应文件 |
| \`sessions/\` | 一次工作一个文件夹，存放产出 | 需要历史产出时再找 |

## 工作规则

1. **先查再问**：接任务先看 \`memory/\` 与 \`skills/\` 有没有现成答案，不要重新摸索
2. **产出归位**：所有产出写进 \`sessions/<日期-任务名>/\`，不要散落在根目录
3. **做完沉淀**：任务结束时，若产生了可复用的流程，写进 \`skills/\`；
   若踩了坑或确立了约定，写进 \`memory/\`
4. **不翻聊天记录**：需要历史信息时读文件，不要依赖对话历史

<!-- 以下按项目实际情况补充 -->
`;

export const MEMORY_TEMPLATE = `# 长期记忆

存放**跨会话需要保留**的信息。目标是：新会话读这里就能恢复上下文，
不需要用户重新交代一遍。

## 建议结构

- \`project.md\`   —— 这个项目是什么、目标、边界
- \`conventions.md\` —— 约定（命名、格式、语言、称呼）
- \`lessons.md\`   —— 踩过的坑与解法（**最值钱的一类**）

## 写法建议

- 一条一事，短句为主，便于检索
- 坑要写清「现象 / 根因 / 解法」三段
- 过时的条目及时删 —— 记忆也会占用入口预算
`;

export const SKILLS_TEMPLATE = `# 可复用流程

把**做对过的流程**固化成文件，下次遇到同类任务直接调用，不要重新摸索。

## 一个 skill 应该包含

1. **何时用** —— 什么情况下该调用它
2. **前置条件** —— 需要什么输入、什么环境
3. **步骤** —— 一步步怎么做，含具体命令
4. **验收** —— 怎么判断做对了
5. **已知坑** —— 做的时候容易错在哪

## 为什么值得做

同一条流程每次重新摸索，要花掉大量上下文去试错；固化成文件后，
读一遍（几百 token）就能直接执行。这是「不翻聊天记录」之外的第二笔大节省。
`;
