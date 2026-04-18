/**
 * Leveled logger — replaces ad-hoc `console.log` calls throughout the pipeline.
 *
 * Design:
 *  - Four levels: debug, info, warn, error.
 *  - JSON output to rotating file at ~/.clawdcursor/logs/clawdcursor-YYYYMMDD.log.
 *  - Human output to stderr when stdout is a TTY (for CLI use).
 *  - Correlation ID pulled from AsyncLocalStorage when present (see correlation.ts).
 *  - Max file size 10 MB; keeps the 5 most recent rotated files.
 *
 * The audit counted 775 `console.*` calls across 35 files. Migrating to this
 * logger is incremental — each file is converted in the same commit as its
 * refactor, so the migration arrives with the pipeline port, not as a separate
 * mega-PR.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB per file
const KEEP_FILES = 5;

const envLevel = (process.env.CLAWD_LOG_LEVEL || 'info').toLowerCase() as Level;
const minLevel = LEVEL_ORDER[envLevel] ?? LEVEL_ORDER.info;

let logDir: string | null = null;
function getLogDir(): string {
  if (logDir) return logDir;
  logDir = path.join(os.homedir(), '.clawdcursor', 'logs');
  try { fs.mkdirSync(logDir, { recursive: true }); } catch { /* best-effort */ }
  return logDir;
}

function currentLogPath(): string {
  const d = new Date();
  const day = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
  return path.join(getLogDir(), `clawdcursor-${day}.log`);
}

function rotateIfNeeded(filePath: string): void {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size < MAX_BYTES) return;
    // shift .0 .. .N-1 and bump new
    for (let i = KEEP_FILES - 2; i >= 0; i--) {
      const src = i === 0 ? filePath : `${filePath}.${i - 1}`;
      const dst = `${filePath}.${i}`;
      try {
        if (fs.existsSync(src)) fs.renameSync(src, dst);
      } catch { /* best-effort */ }
    }
  } catch { /* file doesn't exist — fine */ }
}

function writeLine(line: string): void {
  const filePath = currentLogPath();
  rotateIfNeeded(filePath);
  try {
    fs.appendFileSync(filePath, line + '\n');
  } catch {
    // If logging itself fails we silently drop — logger MUST NOT throw.
  }
}

const isTty = process.stderr.isTTY === true;

function emit(level: Level, msg: string, meta?: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] < minLevel) return;
  const record = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...(meta && Object.keys(meta).length ? { meta } : {}),
  };
  writeLine(JSON.stringify(record));
  if (isTty && !streamMode) {
    // Default TTY form — color-free to keep CI logs grep-able. Stream mode
    // renders a richer tree via emitStream() instead.
    const metaStr = meta && Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
    process.stderr.write(`[${level}] ${msg}${metaStr}\n`);
  }
}

// ─── TTY streaming (richer, opt-in via CLAWD_LOG=stream) ─────────────
// The default TTY output is a single `[level] event {json}` line per event.
// When CLAWD_LOG=stream (or CLAWD_LOG_FORMAT=stream), we switch to a tree-
// shaped stream optimized for humans watching a live task: indentation
// follows pipeline → subtask → turn → tool, colored emoji markers, and
// compact inline args. JSON file logs are unaffected — this only changes
// what the terminal sees.
const streamMode = (process.env.CLAWD_LOG || process.env.CLAWD_LOG_FORMAT || '').toLowerCase() === 'stream';

/**
 * Event catalog — every pipeline event emits one of these names. Central
 * list makes it trivial for dashboards, tests, or the CLI pretty-printer to
 * recognize semantic events without parsing free-text.
 *
 * Kept flat. If you add an event, add it here first.
 */
export const EVENTS = {
  PIPELINE_START: 'pipeline.start',
  PIPELINE_PREPROCESS: 'pipeline.preprocess',
  PIPELINE_SUBTASK: 'pipeline.subtask',
  PIPELINE_RUNG: 'pipeline.rung',
  PIPELINE_DONE: 'pipeline.done',
  AGENT_TURN_START: 'agent.turn.start',
  AGENT_THINK: 'agent.think',
  AGENT_TOOL_CALL: 'agent.tool.call',
  AGENT_TOOL_RESULT: 'agent.tool.result',
  AGENT_TURN_END: 'agent.turn.end',
  AGENT_STAGNATION: 'agent.stagnation',
  ADAPTER_CALL: 'adapter.call',
} as const;

/** Depth tracker for tree-style indentation in stream mode. */
let indentDepth = 0;
const indentStr = () => '  '.repeat(Math.max(0, indentDepth));

/** Tree-style marker chosen from the event name. */
function streamMarker(event: string): string {
  if (event === EVENTS.PIPELINE_START)      return '▶ ';
  if (event === EVENTS.PIPELINE_PREPROCESS) return '  ├─ preprocess';
  if (event === EVENTS.PIPELINE_SUBTASK)    return '  ├─ subtask';
  if (event === EVENTS.PIPELINE_RUNG)       return '  ├─ rung';
  if (event === EVENTS.PIPELINE_DONE)       return '■ done';
  if (event === EVENTS.AGENT_TURN_START)    return '  ├─ turn';
  if (event === EVENTS.AGENT_THINK)         return '  │  · think';
  if (event === EVENTS.AGENT_TOOL_CALL)     return '  │  → tool';
  if (event === EVENTS.AGENT_TOOL_RESULT)   return '  │  ← result';
  if (event === EVENTS.AGENT_TURN_END)      return '  │  ↳ turn-end';
  if (event === EVENTS.AGENT_STAGNATION)    return '  ⚠ stagnation';
  if (event === EVENTS.ADAPTER_CALL)        return '  │   ∟ adapter';
  return '  · ' + event;
}

/** Compact inline meta for stream output (truncates long values). */
function compactMeta(meta?: Record<string, unknown>): string {
  if (!meta) return '';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(meta)) {
    if (k === 'correlationId' || k === 'task') continue; // noisy / redundant
    let s: string;
    if (v == null) s = 'null';
    else if (typeof v === 'string') s = v.length > 80 ? v.slice(0, 77) + '…' : v;
    else if (typeof v === 'object') s = JSON.stringify(v).slice(0, 80);
    else s = String(v);
    parts.push(`${k}=${s}`);
  }
  return parts.length ? ' ' + parts.join(' ') : '';
}

function emitStream(level: Level, msg: string, meta?: Record<string, unknown>): void {
  const marker = streamMarker(msg);
  const line = `${indentStr()}${marker}${compactMeta(meta)}\n`;
  process.stderr.write(line);
}

/**
 * Begin a nested span — subsequent log events indent one level deeper until
 * `end()` is called. Useful for wrapping agent turns / subtasks / playbook
 * steps so the stream output stays tree-shaped.
 */
export function beginSpan(): { end: () => void } {
  indentDepth++;
  let ended = false;
  return {
    end: () => {
      if (ended) return;
      ended = true;
      indentDepth = Math.max(0, indentDepth - 1);
    },
  };
}

export const logger = {
  debug: (msg: string, meta?: Record<string, unknown>) => emitAll('debug', msg, meta),
  info:  (msg: string, meta?: Record<string, unknown>) => emitAll('info',  msg, meta),
  warn:  (msg: string, meta?: Record<string, unknown>) => emitAll('warn',  msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => emitAll('error', msg, meta),
  /** Child logger bound to a correlation ID — inlined into every record's meta. */
  with: (extra: Record<string, unknown>) => ({
    debug: (msg: string, meta?: Record<string, unknown>) => emitAll('debug', msg, { ...extra, ...(meta || {}) }),
    info:  (msg: string, meta?: Record<string, unknown>) => emitAll('info',  msg, { ...extra, ...(meta || {}) }),
    warn:  (msg: string, meta?: Record<string, unknown>) => emitAll('warn',  msg, { ...extra, ...(meta || {}) }),
    error: (msg: string, meta?: Record<string, unknown>) => emitAll('error', msg, { ...extra, ...(meta || {}) }),
  }),
  /** Begin a nested log span (tree indentation in stream mode). */
  span: beginSpan,
};

function emitAll(level: Level, msg: string, meta?: Record<string, unknown>): void {
  emit(level, msg, meta);
  if (streamMode && LEVEL_ORDER[level] >= minLevel) emitStream(level, msg, meta);
}

export type Logger = typeof logger;
