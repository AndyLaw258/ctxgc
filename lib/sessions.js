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

import { decompressSessionLog } from './decompress.js';

/**
 * 会话日志的**历史**文件名，仅为向下兼容保留 —— **不要再拿它拼路径**。
 * 实际定位请用 {@link findSessionLog}：它扫 `session.v*.jsonl[.zstd]`，
 * 取版本号最高的那个；写死 v3 会在升级时表现为「找不到会话」，比「读不了」更难诊断。
 */
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
 * 匹配会话日志文件名：`session.v<数字>.jsonl[.zstd|.gz]`，也接受无版本号的形态。
 *
 * **不硬编码版本号**：DSH 已演进到 v3 并带 v0→v1→v2→v3 的迁移链。写死 v3 意味着
 * 它出 v4 时我们会「找不到会话」—— 那是比「读不了」更难诊断的失效。
 */
const SESSION_LOG_PATTERN = /^session(?:\.v(\d+))?\.jsonl(?:\.(zstd|gz))?$/;

/**
 * 在一个会话目录里挑出日志文件，**优先版本号最高的**。
 *
 * @param dir - 会话目录（`.../sessions/<项目>/<会话 id>`）。
 * @returns `{ path, name, version, codec }`；找不到返回 null。无版本号时 `version` 为 null。
 */
export function findSessionLog(dir) {
  if (!existsSync(dir)) return null;
  let best = null;
  for (const name of readdirSync(dir)) {
    const match = SESSION_LOG_PATTERN.exec(name);
    if (match === null) continue;
    const version = match[1] === undefined ? null : Number(match[1]);
    const rank = version ?? -1; // 无版本号的排在所有带版本号的之后
    if (best === null || rank > best.rank) {
      best = { path: join(dir, name), name, version, codec: match[2] ?? 'none', rank };
    }
  }
  if (best === null) return null;
  return { path: best.path, name: best.name, version: best.version, codec: best.codec };
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
      const found = findSessionLog(join(projectDir, id));
      if (found === null) continue;
      const stat = statSync(found.path);
      sessions.push({
        id,
        project,
        logPath: found.path,
        bytes: stat.size,
        modifiedAt: new Date(stat.mtimeMs),
        /** 日志格式版本（无版本号时为 null）与文件名推断的压缩方式。 */
        formatVersion: found.version,
        codec: found.codec,
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
  // 解压方式按魔数自动识别，不写死 zstd —— 换压缩算法时不会有人通知我们
  const { text, codec, frames } = decompressSessionLog(raw);
  return { events: parseJsonl(text), frames, codec };
}
