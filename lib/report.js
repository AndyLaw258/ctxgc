/**
 * 终端报告渲染。
 *
 * 中文在终端里占两格宽度，直接 `padEnd` 会错位，因此这里统一用显示宽度对齐。
 *
 * @module ctxgc/report
 */

import { GROUP_LABELS, formatTokens } from './lifecycle.js';

/**
 * 计算字符串在终端里的显示宽度（CJK 字符算 2）。
 *
 * @param {string} text - 文本。
 * @returns {number} 显示宽度。
 */
export function displayWidth(text) {
  let width = 0;
  for (const ch of String(text)) {
    const code = ch.codePointAt(0);
    const wide = (
      (code >= 0x1100 && code <= 0x115f)
      || (code >= 0x2e80 && code <= 0xa4cf)
      || (code >= 0xac00 && code <= 0xd7a3)
      || (code >= 0xf900 && code <= 0xfaff)
      || (code >= 0xfe30 && code <= 0xfe6f)
      || (code >= 0xff00 && code <= 0xff60)
      || (code >= 0xffe0 && code <= 0xffe6)
    );
    width += wide ? 2 : 1;
  }
  return width;
}

/**
 * 按显示宽度截断。
 *
 * @param {string} text - 文本。
 * @param {number} max - 最大显示宽度。
 * @returns {string} 截断后的文本。
 */
export function truncateDisplay(text, max) {
  let out = '';
  let width = 0;
  for (const ch of String(text)) {
    const w = displayWidth(ch);
    if (width + w > max - 1) return `${out}…`;
    out += ch;
    width += w;
  }
  return out;
}

/**
 * 按显示宽度补空格。
 *
 * @param {string} text - 文本。
 * @param {number} width - 目标宽度。
 * @param {'left'|'right'} [align='left'] - 对齐方向。
 * @returns {string} 补齐后的文本。
 */
export function pad(text, width, align = 'left') {
  const value = String(text);
  const fill = ' '.repeat(Math.max(0, width - displayWidth(value)));
  return align === 'right' ? fill + value : value + fill;
}

function num(value) {
  return Math.round(value).toLocaleString('en-US');
}

/**
 * 渲染单个会话的完整报告。
 *
 * @param {object} session - 会话元信息。
 * @param {object} analysis - 分析结果（usage / items / lifecycle / summary）。
 * @returns {string} 报告文本。
 */
export function renderSessionReport(session, analysis) {
  const { usage, summary, offenders, sessions } = analysis;
  const lines = [];
  const rule = '─'.repeat(78);

  lines.push('');
  lines.push('  ctxgc · 上下文成本审计');
  lines.push(rule);
  lines.push(`  会话     ${session.id}`);
  lines.push(`  工作目录 ${session.cwd || session.project.replace(/^--|-{2}$/g, '')}`);
  lines.push(`  时间     ${session.modifiedAt.toLocaleString('zh-CN')}`);
  if (sessions) lines.push(`  日志     ${sessions.decodedFrames} 帧 / ${num(sessions.bytes)} 字节解压`);
  lines.push('');

  // ── 概览 ──────────────────────────────────────────────
  lines.push('  概览');
  lines.push(`    模型调用        ${num(usage.totalCalls)} 次`);
  lines.push(`    上下文峰值      ${num(usage.peakContextSize)} token`);
  lines.push(`    上下文最终      ${num(usage.finalContextSize)} token`);
  if (usage.contractions > 0) {
    lines.push(`    上下文收缩      ${num(usage.contractions)} 次（压缩机制介入，归因会相应低估）`);
  }
  lines.push(`    累计读入        ${num(usage.totals.input + usage.totals.cacheRead)} token`
    + `   (未命中 ${num(usage.totals.input)} / 命中缓存 ${num(usage.totals.cacheRead)})`);
  lines.push(`    累计生成        ${num(usage.totals.output)} token`
    + `   (其中思考 ${num(usage.totals.reasoning)})`);
  lines.push('');

  // ── 归因对账（自检）────────────────────────────────────
  const drift = summary.totalTokens - usage.finalContextSize;
  const driftRatio = usage.finalContextSize > 0 ? (drift / usage.finalContextSize) * 100 : 0;
  lines.push('  归因对账');
  lines.push(`    账面体积合计 ${pad(formatTokens(summary.totalTokens), 10, 'right')} token`
    + `   上下文最终 ${pad(formatTokens(usage.finalContextSize), 10, 'right')} token`
    + `   偏差 ${driftRatio >= 0 ? '+' : ''}${driftRatio.toFixed(1)}%`);
  lines.push('    （各条目「进入时的体积」之和应当等于上下文最终大小；偏差说明存在收缩或漏归因）');
  lines.push('');

  // ── 分类汇总 ──────────────────────────────────────────
  lines.push('  分类汇总（按累计读取量排序）');
  lines.push(`    ${pad('类别', 14)}${pad('条目', 7, 'right')}${pad('体积', 11, 'right')}`
    + `${pad('累计读取', 13, 'right')}${pad('放大', 8, 'right')}`);
  for (const group of summary.groups) {
    const label = GROUP_LABELS[group.group] || group.group;
    const amplification = group.tokens > 0 ? (group.lifecycleTokens / group.tokens).toFixed(1) : '0';
    lines.push(`    ${pad(label, 14)}${pad(num(group.count), 7, 'right')}`
      + `${pad(formatTokens(group.tokens), 11, 'right')}`
      + `${pad(formatTokens(group.lifecycleTokens), 13, 'right')}`
      + `${pad(`${amplification}x`, 8, 'right')}`);
  }
  lines.push(`    ${'─'.repeat(52)}`);
  lines.push(`    ${pad('合计', 14)}${pad(num(summary.itemCount), 7, 'right')}`
    + `${pad(formatTokens(summary.totalTokens), 11, 'right')}`
    + `${pad(formatTokens(summary.totalLifecycle), 13, 'right')}`
    + `${pad(`${summary.amplification.toFixed(1)}x`, 8, 'right')}`);
  lines.push('');

  // ── 排行榜 ────────────────────────────────────────────
  lines.push('  浪费排行榜（累计读取量最高的条目）');
  lines.push(`    ${pad('#', 4)}${pad('步', 5, 'right')}${pad('体积', 10, 'right')}`
    + `${pad('存续', 6, 'right')}${pad('累计读取', 12, 'right')}  内容`);
  offenders.forEach((item, index) => {
    lines.push(`    ${pad(index + 1, 4)}${pad(item.enteredAtIndex + 1, 5, 'right')}`
      + `${pad(formatTokens(item.tokens), 10, 'right')}`
      + `${pad(`${item.reads}轮`, 6, 'right')}`
      + `${pad(formatTokens(item.lifecycleTokens), 12, 'right')}  `
      + truncateDisplay(item.label, Math.max(10, 78 - 40)));
  });
  lines.push('');

  // ── 可避免量 ──────────────────────────────────────────
  lines.push('  可避免量（上界估算）');
  lines.push(`    工具结果当前累计读取   ${pad(formatTokens(summary.toolLifecycle), 12, 'right')} token`
    + `   (${num(summary.toolCount)} 条)`);
  lines.push(`    改为摘要形态后         ${pad(formatTokens(summary.digestLifecycle), 12, 'right')} token`
    + `   (每条保留 ${summary.digestTokens} token，其余落盘待取)`);
  lines.push(`    ${'─'.repeat(46)}`);
  const ratio = summary.toolLifecycle > 0 ? (summary.avoidable / summary.toolLifecycle) * 100 : 0;
  lines.push(`    可避免                 ${pad(formatTokens(summary.avoidable), 12, 'right')} token`
    + `   (${ratio.toFixed(1)}% 的工具结果读取量)`);
  lines.push('');
  lines.push('  说明：以上是「可避免量」的上界，不是实际节省。真实收益需要第二层治理机制');
  lines.push('        落地后，用开/关对照实验实测。本工具只负责让浪费可见、可归因。');
  lines.push('');

  return lines.join('\n');
}

/**
 * 用块字符画迷你曲线。
 *
 * @param {number[]} values - 数值序列。
 * @returns {string} 一行火花线。
 */
export function sparkline(values) {
  const blocks = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
  if (values.length === 0) return '';
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min || 1;
  return values
    .map((v) => blocks[Math.min(blocks.length - 1, Math.max(0, Math.round(((v - min) / span) * (blocks.length - 1))))])
    .join('');
}

/**
 * 渲染反事实模拟报告。
 *
 * @param {object} session - 会话元信息。
 * @param {object} analysis - {@link import('./index.js').analyzeSession} 的结果。
 * @param {object} simulation - 模拟数据。
 * @returns {string} 报告文本。
 */
export function renderSimulation(session, analysis, simulation) {
  const { sweeps, savings, tools, curve, digestTokens } = simulation;
  const chosen = sweeps.find((s) => s.digestTokens === digestTokens) || sweeps[0];
  const lines = [];
  const rule = '─'.repeat(78);

  lines.push('');
  lines.push('  ctxgc · 反事实模拟：工具结果句柄化');
  lines.push(rule);
  lines.push(`  会话     ${session.id}`);
  lines.push(`  策略     每条工具结果在上下文里最多保留 ${digestTokens} token，其余落盘待取`);
  lines.push('');
  lines.push('  说明：这不是估算，而是用这条会话的真实调用序列与真实归因数据**重放**');
  lines.push('        另一种上下文策略。基础数据全部来自日志中上报的实测用量。');
  lines.push('');

  // ── 交叉验证 ──────────────────────────────────────────
  const reported = analysis.usage.totals.input + analysis.usage.totals.cacheRead;
  const ok = Math.abs(chosen.totalReal - reported) / Math.max(1, reported) < 0.005;
  lines.push('  交叉验证');
  lines.push(`    重放得到的基线读取 ${pad(formatTokens(chosen.totalReal), 10, 'right')} token`
    + `   日志上报累计读入 ${pad(formatTokens(reported), 10, 'right')} token`
    + `   ${ok ? '✓ 一致' : '✗ 不一致'}`);
  lines.push(`    模型调用 ${analysis.usage.totalCalls} 次，条目 ${analysis.summary.itemCount} 条`
    + `（其中受治理的工具结果 ${chosen.governedCount} 条）`);
  lines.push('');

  // ── 敏感性分析 ────────────────────────────────────────
  lines.push('  敏感性分析（策略强度 → 节省）');
  lines.push(`    ${pad('摘要体积', 10)}${pad('模拟总读取', 14, 'right')}${pad('节省', 13, 'right')}${pad('降幅', 9, 'right')}   条`);
  for (const sweep of sweeps) {
    const barLength = Math.round(sweep.savedRatio * 24);
    const bar = '█'.repeat(barLength) + '·'.repeat(24 - barLength);
    lines.push(`    ${pad(sweep.digestTokens === 0 ? '全落盘' : String(sweep.digestTokens), 10)}`
      + `${pad(formatTokens(sweep.totalSimulated), 14, 'right')}`
      + `${pad(formatTokens(sweep.saved), 13, 'right')}`
      + `${pad(`${(sweep.savedRatio * 100).toFixed(1)}%`, 9, 'right')}   ${bar}`);
  }
  lines.push('');

  // ── 增长曲线 ──────────────────────────────────────────
  lines.push(`  上下文增长曲线（相对形态，采样 ${curve.length} 点）`);
  lines.push(`    真实  ${sparkline(curve.map((p) => p.real))}   ${formatTokens(curve[curve.length - 1].real)}`);
  lines.push(`    模拟  ${sparkline(curve.map((p) => p.simulated))}   ${formatTokens(curve[curve.length - 1].simulated)}`);
  lines.push('');
  lines.push(`    ${pad('步', 6)}${pad('真实', 12, 'right')}${pad('模拟', 12, 'right')}${pad('差值', 12, 'right')}`);
  for (const point of curve) {
    lines.push(`    ${pad(point.step + 1, 6)}${pad(formatTokens(point.real), 12, 'right')}`
      + `${pad(formatTokens(point.simulated), 12, 'right')}`
      + `${pad(formatTokens(point.real - point.simulated), 12, 'right')}`);
  }
  lines.push('');

  // ── 治理收益排行 ──────────────────────────────────────
  lines.push('  治理收益排行（换成句柄后省得最多的条目）');
  lines.push(`    ${pad('#', 4)}${pad('步', 5, 'right')}${pad('体积', 10, 'right')}`
    + `${pad('存续', 6, 'right')}${pad('可省', 11, 'right')}  内容`);
  savings.forEach((item, index) => {
    lines.push(`    ${pad(index + 1, 4)}${pad(item.enteredAtIndex + 1, 5, 'right')}`
      + `${pad(formatTokens(item.tokens), 10, 'right')}`
      + `${pad(`${item.reads}轮`, 6, 'right')}`
      + `${pad(formatTokens(item.saved), 11, 'right')}  `
      + truncateDisplay(item.label, 30));
  });
  lines.push('');

  // ── 按工具汇总 ────────────────────────────────────────
  lines.push('  按工具汇总（哪类工具最费）');
  lines.push(`    ${pad('工具', 20)}${pad('条数', 7, 'right')}${pad('体积', 11, 'right')}`
    + `${pad('累计读取', 13, 'right')}${pad('放大', 8, 'right')}`);
  for (const tool of tools) {
    const amplification = tool.tokens > 0 ? (tool.lifecycleTokens / tool.tokens).toFixed(1) : '0';
    lines.push(`    ${pad(tool.tool, 20)}${pad(num(tool.count), 7, 'right')}`
      + `${pad(formatTokens(tool.tokens), 11, 'right')}`
      + `${pad(formatTokens(tool.lifecycleTokens), 13, 'right')}`
      + `${pad(`${amplification}x`, 8, 'right')}`);
  }
  lines.push('');

  lines.push('  重要提醒：本模拟假设「落盘的内容随时可取回」，因此不损失信息。');
  lines.push('           真实收益必须由第二层治理机制落地后的开/关对照实验确认 ——');
  lines.push('           尤其要验证：取回机制是否引入额外调用、任务成功率是否下降。');
  lines.push('');

  return lines.join('\n');
}

/**
 * 渲染工作流体检报告。
 *
 * @param {object} session - 会话元信息。
 * @param {object} workspace - {@link import('./workflow.js').inspectWorkspace} 的结果。
 * @param {object} habits - {@link import('./workflow.js').analyzeHabits} 的结果。
 * @param {Array<object>} advice - {@link import('./workflow.js').recommendations} 的结果。
 * @returns {string} 报告文本。
 */
export function renderWorkflow(session, workspace, habits, advice) {
  const lines = [];
  const rule = '─'.repeat(78);

  lines.push('');
  lines.push('  ctxgc · 工作流体检');
  lines.push(rule);
  lines.push(`  工作区    ${workspace.root}`);
  if (session) lines.push(`  参照会话  ${session.id}`);
  lines.push(`  结构健康度 ${workspace.score}/100`);
  lines.push('');

  // ── 结构四要素 ────────────────────────────────────────
  lines.push('  结构四要素');
  for (const slot of workspace.slots) {
    const mark = slot.present ? '✅' : (slot.required ? '❌' : '⚠️ ');
    const detail = slot.present
      ? `${slot.name}${slot.isDir ? `（${slot.fileCount} 个文件，${(slot.bytes / 1024).toFixed(1)} KB）` : `（${(slot.bytes / 1024).toFixed(1)} KB）`}`
      : '缺失';
    const weight = slot.required ? '必需' : '建议';
    lines.push(`    ${mark} ${pad(slot.label, 12)}${pad(detail, 34)}${weight}`);
  }
  lines.push('');
  lines.push('    说明：自动入口由 DSH 每个新会话自动注入，是「不靠人提醒」的关键；');
  lines.push('          长期记忆替代「翻聊天记录」；两者是记忆外置的最小可用组合。');
  lines.push('');

  // ── 会话习惯 ──────────────────────────────────────────
  lines.push('  会话习惯（来自真实用量）');
  const restatement = `${(habits.restatementRatio * 100).toFixed(1)}%`;
  const restatementFlag = habits.restatementRatio > 0.05 ? '  ⚠️ 偏高' : '  ✓';
  lines.push(`    背景重述成本   ${pad(restatement, 8, 'right')}${restatementFlag}`
    + `   用户消息占上下文（高 = 每次都在重新交代背景）`);
  lines.push(`    上下文启动     ${pad(formatTokens(habits.startupCost), 8, 'right')}`
    + `            第一次调用时的上下文大小`);
  lines.push(`    重复获取       ${pad(`${habits.repeatCount} 次`, 8, 'right')}`
    + `            同一目标被取回多次`);
  if (habits.repeatShare > 0) {
    lines.push(`    重复获取占比   ${pad(`${(habits.repeatShare * 100).toFixed(1)}%`, 8, 'right')}`
      + `            占累计读取量的比例`);
  }
  lines.push('');

  // ── 重复获取明细 ──────────────────────────────────────
  if (habits.repeats.length > 0) {
    lines.push('  重复获取明细（固化到 memory/ 或 skills/ 的候选）');
    lines.push(`    ${pad('#', 4)}${pad('次数', 6, 'right')}${pad('累计读取', 12, 'right')}  目标`);
    habits.repeats.slice(0, 8).forEach((repeat, index) => {
      lines.push(`    ${pad(index + 1, 4)}${pad(repeat.count, 6, 'right')}`
        + `${pad(formatTokens(repeat.lifecycleTokens), 12, 'right')}  `
        + truncateDisplay(repeat.label, 40));
    });
    lines.push('');
  }

  // ── 建议 ──────────────────────────────────────────────
  lines.push('  建议');
  for (const item of advice) {
    const mark = item.level === 'high' ? '⚠️ ' : (item.level === 'mid' ? '·  ' : '✓  ');
    lines.push(`    ${mark}${item.text}`);
  }
  lines.push('');

  return lines.join('\n');
}

/**
 * 渲染多会话总览。
 *
 * @param {Array<{session: object, analysis: object}>} entries - 各会话的分析结果。
 * @returns {string} 总览文本。
 */
export function renderOverview(entries) {
  const lines = [];
  const rule = '─'.repeat(78);
  lines.push('');
  lines.push('  ctxgc · 全部会话总览');
  lines.push(rule);
  lines.push(`    ${pad('会话', 22)}${pad('调用', 7, 'right')}${pad('体积', 11, 'right')}`
    + `${pad('累计读取', 13, 'right')}${pad('可避免', 12, 'right')}`);
  lines.push(`    ${'─'.repeat(62)}`);

  let totalCalls = 0;
  let totalTokens = 0;
  let totalLifecycle = 0;
  let totalAvoidable = 0;

  for (const { session, analysis } of entries) {
    totalCalls += analysis.usage.totalCalls;
    totalTokens += analysis.summary.totalTokens;
    totalLifecycle += analysis.summary.totalLifecycle;
    totalAvoidable += analysis.summary.avoidable;
    lines.push(`    ${pad(truncateDisplay(session.id.replace(/^session-/, ''), 21), 22)}`
      + `${pad(num(analysis.usage.totalCalls), 7, 'right')}`
      + `${pad(formatTokens(analysis.summary.totalTokens), 11, 'right')}`
      + `${pad(formatTokens(analysis.summary.totalLifecycle), 13, 'right')}`
      + `${pad(formatTokens(analysis.summary.avoidable), 12, 'right')}`);
  }

  lines.push(`    ${'─'.repeat(62)}`);
  lines.push(`    ${pad('合计', 22)}${pad(num(totalCalls), 7, 'right')}`
    + `${pad(formatTokens(totalTokens), 11, 'right')}`
    + `${pad(formatTokens(totalLifecycle), 13, 'right')}`
    + `${pad(formatTokens(totalAvoidable), 12, 'right')}`);
  lines.push('');
  return lines.join('\n');
}
