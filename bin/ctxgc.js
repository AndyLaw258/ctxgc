#!/usr/bin/env node
/**
 * ctxgc 命令行入口。
 *
 * 用法：
 *   ctxgc                  审计最近一个会话（详细报告）
 *   ctxgc list             列出所有会话
 *   ctxgc all              全部会话总览
 *   ctxgc report <id>      审计指定会话（id 可用前缀）
 *
 * 选项：
 *   --top <n>        排行榜长度，默认 15
 *   --digest <n>     摘要形态假设的单条体积，默认 300
 *   --json           以 JSON 输出（便于二次加工）
 *   --home <path>    指定 DSH_HOME
 *
 * @module ctxgc/bin
 */

import {
  listSessions,
  resolveDshHome,
  analyzeSession,
  simulateSession,
  inspectWorkflow,
  scaffoldWorkspace,
  renderSessionReport,
  renderSimulation,
  renderWorkflow,
  renderOverview,
  formatTokens,
} from '../lib/index.js';

const USAGE = `
ctxgc —— Context Garbage Collector

审计 AI Agent 的上下文成本：把 token 成本从「体积」扩展到「体积 × 存续轮数」，
找出那些进入上下文后再未被引用、却每一轮都要重读一遍的内容。

用法：
  ctxgc                    审计最近一个会话
  ctxgc simulate           反事实模拟：工具结果句柄化能省多少
  ctxgc workflow           工作流体检：记忆外置这套方法做得怎么样
  ctxgc init [路径]        生成记忆外置工作区骨架（不覆盖已有文件）
  ctxgc list               列出所有会话
  ctxgc all                全部会话总览
  ctxgc report <id前缀>    审计指定会话

选项：
  --top <n>       排行榜长度（默认 15）
  --digest <n>    摘要形态假设的单条体积（默认 300）
  --sweep         敏感性分析扫描更多取值
  --root <path>   指定工作区根目录（workflow / init 用）
  --dry-run       init 只预览，不落盘
  --json          输出 JSON
  --home <path>   指定 DSH_HOME（默认取 $DSH_HOME 或 ~/.dsh）
  -h, --help      显示本帮助
`;

/**
 * 解析命令行参数。
 *
 * @param {string[]} argv - `process.argv.slice(2)`。
 * @returns {{command: string, target: string|null, top: number, digestTokens: number, json: boolean, home: string|undefined, help: boolean}}
 */
export function parseArgs(argv) {
  const options = {
    command: 'report',
    target: null,
    top: 15,
    digestTokens: 300,
    sweep: false,
    root: undefined,
    dryRun: false,
    json: false,
    home: undefined,
    help: false,
  };

  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') options.help = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--sweep') options.sweep = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--top') { i += 1; options.top = Number(argv[i]) || 15; }
    else if (arg === '--digest') { i += 1; options.digestTokens = Number(argv[i]) || 300; }
    else if (arg === '--root') { i += 1; options.root = argv[i]; }
    else if (arg === '--home') { i += 1; options.home = argv[i]; }
    else positional.push(arg);
  }

  if (positional.length > 0) {
    const [first, second] = positional;
    if (['list', 'all', 'report', 'simulate', 'workflow', 'init'].includes(first)) {
      options.command = first;
      options.target = second ?? null;
    } else {
      options.command = 'report';
      options.target = first;
    }
  }

  return options;
}

/**
 * 按 id 前缀挑选会话。
 *
 * @param {Array<object>} sessions - 会话清单。
 * @param {string} prefix - id 前缀。
 * @returns {object|undefined} 匹配到的会话。
 */
export function pickSession(sessions, prefix) {
  return sessions.find((s) => s.id === prefix) || sessions.find((s) => s.id.includes(prefix));
}

function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    console.log(USAGE.trim());
    return;
  }

  if (options.command === 'init') {
    const root = options.root || options.target || process.cwd();
    const actions = scaffoldWorkspace(root, { dryRun: options.dryRun });
    if (options.json) {
      console.log(JSON.stringify({ root, dryRun: options.dryRun, actions }, null, 2));
      return;
    }
    console.log('');
    console.log(`  ctxgc · 生成记忆外置工作区骨架${options.dryRun ? '（预览）' : ''}`);
    console.log(`  ${'─'.repeat(76)}`);
    console.log(`  工作区  ${root}`);
    console.log('');
    for (const action of actions) {
      const rel = action.path.slice(root.length + 1) || action.path;
      const mark = action.action === 'created' ? '✅ 已创建'
        : (action.action === 'exists' ? '⏭  已存在，跳过' : '📋 将创建');
      console.log(`    ${mark}  ${rel}`);
    }
    console.log('');
    if (!options.dryRun) {
      console.log('  下一步：编辑 AGENTS.md，把「有什么资源、该读哪个」写清楚。');
      console.log('          这份文件由 DSH 每个新会话自动加载，不需要你口头交代。');
      console.log('');
    }
    return;
  }

  const home = resolveDshHome(options.home);
  const sessions = listSessions({ dshHome: home });

  if (sessions.length === 0) {
    console.error(`ctxgc: 在 ${home}\\sessions 下没有找到任何会话`);
    process.exitCode = 1;
    return;
  }

  const analyze = (session) => analyzeSession(session, {
    top: options.top,
    digestTokens: options.digestTokens,
  });

  if (options.command === 'list') {
    if (options.json) {
      console.log(JSON.stringify(sessions, null, 2));
      return;
    }
    console.log('');
    console.log(`  ctxgc · 会话清单（${home}）`);
    console.log(`  ${'─'.repeat(76)}`);
    for (const session of sessions) {
      console.log(`  ${session.id}`);
      console.log(`    ${session.project}   ${(session.bytes / 1024).toFixed(0)} KB   ${session.modifiedAt.toLocaleString('zh-CN')}`);
    }
    console.log('');
    return;
  }

  if (options.command === 'all') {
    const entries = sessions.map((session) => ({ session, analysis: analyze(session) }));
    if (options.json) {
      console.log(JSON.stringify(entries.map((e) => ({
        session: e.session,
        usage: e.analysis.usage,
        summary: e.analysis.summary,
      })), null, 2));
      return;
    }
    console.log(renderOverview(entries));
    return;
  }

  if (options.command === 'simulate') {
    const simTarget = options.target ? pickSession(sessions, options.target) : sessions[0];
    if (!simTarget) {
      console.error(`ctxgc: 找不到匹配的会话：${options.target}`);
      process.exitCode = 1;
      return;
    }
    const simAnalysis = analyze(simTarget);
    const simulation = simulateSession(simAnalysis, {
      digestTokens: options.digestTokens,
      digests: options.sweep
        ? [0, 50, 100, 200, 300, 500, 800, 1000, 1500, 2000, 3000, 4000, 8000]
        : undefined,
      top: options.top,
    });

    if (options.json) {
      console.log(JSON.stringify({
        session: simAnalysis.session,
        digestTokens: simulation.digestTokens,
        sweeps: simulation.sweeps.map((s) => ({
          digestTokens: s.digestTokens,
          totalReal: s.totalReal,
          totalSimulated: s.totalSimulated,
          saved: s.saved,
          savedRatio: s.savedRatio,
        })),
        savings: simulation.savings,
        tools: simulation.tools,
      }, null, 2));
      return;
    }

    console.log(renderSimulation(simAnalysis.session, simAnalysis, simulation));
    return;
  }

  if (options.command === 'workflow') {
    const wfTarget = options.target ? pickSession(sessions, options.target) : sessions[0];
    const wfAnalysis = wfTarget ? analyze(wfTarget) : null;
    const root = options.root || (wfAnalysis && wfAnalysis.session.cwd) || process.cwd();
    const result = inspectWorkflow(wfAnalysis, root);

    if (options.json) {
      console.log(JSON.stringify({
        root,
        score: result.workspace.score,
        slots: result.workspace.slots,
        habits: {
          restatementRatio: result.habits.restatementRatio,
          startupCost: result.habits.startupCost,
          repeatCount: result.habits.repeatCount,
          repeatShare: result.habits.repeatShare,
          repeats: result.habits.repeats,
        },
        advice: result.advice,
      }, null, 2));
      return;
    }

    console.log(renderWorkflow(
      wfAnalysis ? wfAnalysis.session : null,
      result.workspace,
      result.habits,
      result.advice,
    ));
    return;
  }

  const target = options.target ? pickSession(sessions, options.target) : sessions[0];
  if (!target) {
    console.error(`ctxgc: 找不到匹配的会话：${options.target}`);
    process.exitCode = 1;
    return;
  }

  const analysis = analyze(target);
  if (options.json) {
    console.log(JSON.stringify({
      session: analysis.session,
      usage: analysis.usage,
      summary: analysis.summary,
      offenders: analysis.offenders,
      unattributed: analysis.unattributed,
    }, null, 2));
    return;
  }

  console.log(renderSessionReport(analysis.session, { ...analysis, sessions: analysis.frames }));
  if (analysis.unattributed > 0) {
    console.log(`  注：有 ${formatTokens(analysis.unattributed)} token 未能归因到具体条目（窗口内无非上下文事件）`);
    console.log('');
  }
}

main();
