/**
 * 会话发现与加载。
 *
 * DSH 把每个会话存成
 *   `$DSH_HOME/sessions/<cwd 转义>/<session-id>/session.v3.jsonl.zstd`
 * 其中 `<cwd 转义>` 是把工作目录路径里的分隔符换成 `-`（如 `--C-Users-hhh14-Desktop-ds--`）。
 *
 * @module ctxgc/sessions
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { decodeZstdFrames } from './zstd.js';

/** 会话日志的文件名。 */
export const SESSION_LOG_NAME = 'session.v3.jsonl.zstd';

/**
 * 解析 DSH_HOME。优先级：显式参数 > 环境变量 > `~/.dsh`。
 *
 * @param {string} [explicit] - 调用方显式指定的路径。
 * @returns {string} 绝对路径。
 */
export function resolveDshHome(explicit) {
  if (explicit) return explicit;
  if (process.env.DSH_HOME) return process.env.DSH_HOME;
  return join(homedir(), '.dsh');
}

/**
 * 列出磁盘上的所有会话。
 *
 * @param {object} [options]
 * @param {string} [options.dshHome] - DSH_HOME，默认自动解析。
 * @returns {Array<{id: string, project: string, logPath: string, bytes: number, modifiedAt: Date}>}
 *   按修改时间降序排列。
 */
export function listSessions(options = {}) {
  const home = resolveDshHome(options.dshHome);
  const root = join(home, 'sessions');
  if (!existsSync(root)) return [];

  const sessions = [];
  for (const project of readdirSync(root)) {
    const projectDir = join(root, project);
    if (!statSync(projectDir).isDirectory()) continue;
    for (const id of readdirSync(projectDir)) {
      const logPath = join(projectDir, id, SESSION_LOG_NAME);
      if (!existsSync(logPath)) continue;
      const stat = statSync(logPath);
      sessions.push({
        id,
        project,
        logPath,
        bytes: stat.size,
        modifiedAt: new Date(stat.mtimeMs),
      });
    }
  }
  return sessions.sort((a, b) => b.modifiedAt - a.modifiedAt);
}

/**
 * 解析一行行 JSONL，跳过坏行（日志可能正在被写入，尾部会有半行）。
 *
 * @param {string} text - 解压后的 JSONL 文本。
 * @returns {Array<object>} 事件对象数组。
 */
export function parseJsonl(text) {
  const events = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // 尾部半行 / 损坏行：跳过
    }
  }
  return events;
}

/**
 * 加载一个会话的全部事件。
 *
 * @param {{logPath: string}} session - {@link listSessions} 返回的条目。
 * @returns {{events: Array<object>, frames: object}} 事件与解压元信息。
 */
export function loadSession(session) {
  const raw = readFileSync(session.logPath);
  const frames = decodeZstdFrames(raw);
  return { events: parseJsonl(frames.text), frames };
}
