// Structured logger for the daemon.
// Light wrapper over process.stdout + appendFileSync; design.md §12 selects
// "Bun built-in console + 轻量结构化包装" over pino.
//
// API:
//   const log = createLogger('myservice')
//   log.info('something happened', { taskId, duration: 42 })
//   const child = log.child('subsystem')  // service = 'myservice.subsystem'
//
// Configuration is global (one daemon process == one log destination):
//   configureLogger({ level: 'debug', logFile: '/path/to/log', jsonMode: false })

import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { dirname } from 'node:path'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
}

interface LoggerState {
  level: LogLevel
  logFile: string | null
  jsonMode: boolean
  // rotate bookkeeping
  writesSinceCheck: number
}

const ROTATE_BYTES = 10 * 1024 * 1024 // 10 MB per design.md §1
const ROTATE_KEEP = 5
const ROTATE_CHECK_INTERVAL = 100 // stat() every N writes

const state: LoggerState = {
  level: (process.env.LOG_LEVEL as LogLevel | undefined) ?? 'info',
  logFile: null,
  jsonMode: false,
  writesSinceCheck: 0,
}

type StdoutWriter = (line: string) => void

const defaultStdoutWriter: StdoutWriter = (line) => {
  process.stdout.write(line)
}

let stdoutWriter = defaultStdoutWriter

export function configureLogger(opts: {
  level?: LogLevel
  logFile?: string | null
  jsonMode?: boolean
}): void {
  if (opts.level) state.level = opts.level
  if (opts.logFile !== undefined) state.logFile = opts.logFile
  if (opts.jsonMode !== undefined) state.jsonMode = opts.jsonMode
  if (state.logFile) mkdirSync(dirname(state.logFile), { recursive: true })
}

/** Test helper: reset to defaults between test cases. */
export function resetLoggerForTest(): void {
  state.level = 'info'
  state.logFile = null
  state.jsonMode = false
  state.writesSinceCheck = 0
  stdoutWriter = defaultStdoutWriter
}

/** Test helper: capture logger output without mutating the process-global stdout stream. */
export function setLoggerStdoutWriterForTest(writer: StdoutWriter): void {
  stdoutWriter = writer
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void
  info(msg: string, fields?: Record<string, unknown>): void
  warn(msg: string, fields?: Record<string, unknown>): void
  error(msg: string, fields?: Record<string, unknown>): void
  /** Returns a logger whose service field is `${parent}.${name}`. */
  child(name: string): Logger
}

export function createLogger(service: string): Logger {
  const emit = (level: LogLevel, msg: string, fields?: Record<string, unknown>): void => {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[state.level]) return
    const ts = new Date().toISOString()
    const line = state.jsonMode
      ? JSON.stringify({ ts, level, service, message: msg, ...(fields ?? {}) }) + '\n'
      : formatHuman(ts, level, service, msg, fields)
    try {
      stdoutWriter(line)
    } catch {
      // stdout may be closed, or Bun may fail to materialize its WriteStream.
      // Logging is best-effort and must never fail daemon work.
    }
    if (state.logFile !== null) {
      try {
        rotateIfNeeded(state.logFile)
        appendFileSync(state.logFile, line)
      } catch {
        // Best-effort; never let logging crash the daemon.
      }
    }
  }

  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (name) => createLogger(`${service}.${name}`),
  }
}

function formatHuman(
  ts: string,
  level: LogLevel,
  service: string,
  msg: string,
  fields?: Record<string, unknown>,
): string {
  const lvl = level.toUpperCase().padEnd(5)
  let line = `[${ts}] ${lvl} [${service}] ${msg}`
  if (fields && Object.keys(fields).length > 0) {
    const pairs = Object.entries(fields)
      .map(([k, v]) => `${k}=${formatVal(v)}`)
      .join(' ')
    line += ` ${pairs}`
  }
  return line + '\n'
}

function formatVal(v: unknown): string {
  if (typeof v === 'string') return /[\s"]/.test(v) ? JSON.stringify(v) : v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (v === null) return 'null'
  if (v === undefined) return 'undefined'
  if (v instanceof Error) return JSON.stringify({ name: v.name, message: v.message })
  return JSON.stringify(v)
}

function rotateIfNeeded(path: string): void {
  state.writesSinceCheck += 1
  if (state.writesSinceCheck % ROTATE_CHECK_INTERVAL !== 1) return
  let size = 0
  try {
    size = statSync(path).size
  } catch {
    return
  }
  if (size < ROTATE_BYTES) return
  // Shift existing rotated files, oldest first.
  for (let i = ROTATE_KEEP - 1; i >= 1; i--) {
    const src = `${path}.${i}`
    const dst = `${path}.${i + 1}`
    try {
      renameSync(src, dst)
    } catch {
      // file may not exist yet; ignore
    }
  }
  try {
    renameSync(path, `${path}.1`)
  } catch {
    // concurrent rotate from another writer; ignore
  }
}
