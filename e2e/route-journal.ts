// RFC-319 R1 —— 运行期端点命中账本的**采集端**。
//
// 判据是「跑完全套 e2e 之后，`allRouteMeta()` 声明的端点里有哪些一次都没被打到」。
// 分母（端点声明）来自活的源码；分子必须是**运行期实测**——静态扫 spec 只看得见
// `fetch(${baseUrl}/api/...)` 这种 fixture 直调，而绝大多数请求是浏览器点击触发的，
// 静态扫描一条都看不见。
//
// 零生产改动，靠三个既有事实拼起来：
//   1. `packages/backend/src/server.ts:317` 有 `app.use('*')` 中间件逐请求
//      `log.debug('req', { method, path, status, ms })`。
//   2. `packages/backend/src/cli/start.ts:274` 启动时
//      `configureLogger({ level: …, logFile: Paths.daemonLog })` —— 每行日志都会
//      append 到 `<AGENT_WORKFLOW_HOME>/logs/daemon.log`。
//   3. 同文件 `:375-378` 的 `if (config.logLevel !== 'info') configureLogger(...)`
//      —— config.json 里写非 `info` 就会生效。
//
// 所以 harness 只要把它写给每个 daemon 的 `logLevel` 从 `'info'` 改成 `'debug'`，
// 再在删临时 home **之前**把 `req` 行捞出来即可。
//
// **开关**：整套采集挂在 `AW_E2E_ROUTE_JOURNAL` 下。没设时 harness 写的仍是
// `logLevel: 'info'`、不读日志、不写 journal —— PR 腿的行为与今天逐字节相同，
// debug 日志量与额外文件 IO 都不会成为 flaky 的新来源。只有 `e2e-full-nightly`
// 设这个变量，而 R1 的判据本来也只在全量腿上成立（PR 腿只跑 PR 档，
// 它的命中集合天然小于全量，拿它比账本会得到一份错误的、过大的未命中集合）。

import { appendFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'

export const ROUTE_JOURNAL_ENV = 'AW_E2E_ROUTE_JOURNAL'

/** 一条实测命中：方法 + **具体**路径（归一成路由模式是聚合端的事）。 */
export interface RouteHit {
  readonly method: string
  readonly path: string
}

/** journal 目录；未开启采集时为 null。 */
export function routeJournalDir(): string | null {
  const raw = process.env[ROUTE_JOURNAL_ENV]
  return raw === undefined || raw === '' ? null : raw
}

/** harness 写进每个 daemon config.json 的 logLevel。 */
export function harnessLogLevel(): 'debug' | 'info' {
  return routeJournalDir() === null ? 'info' : 'debug'
}

/**
 * `daemon.log` 与它轮转出来的兄弟。
 *
 * `log.ts` 到 10MB 轮转、保留 5 份（`daemon.log.1` … `.5`）。debug 档下长 spec
 * 有机会触发，读漏了的后果是**少记命中**——方向上保守（把已覆盖的报成未覆盖），
 * 不会把未覆盖的漂绿。
 */
function daemonLogFiles(home: string): string[] {
  const logsDir = join(home, 'logs')
  let entries: string[]
  try {
    entries = readdirSync(logsDir)
  } catch {
    return []
  }
  return entries
    .filter((name) => name === 'daemon.log' || /^daemon\.log\.\d+$/.test(name))
    .map((name) => join(logsDir, name))
}

/**
 * 人类可读格式：`[ts] DEBUG [server] req method=GET path=/api/x status=200 ms=3`
 *
 * `formatVal` 会把含空白或引号的字符串 `JSON.stringify` 掉，所以 path 可能是
 * `path="/a b"` 的形态；两种都认。
 */
const HUMAN_REQ = /\breq\s+method=(?:"([^"]*)"|(\S+))\s+path=(?:"([^"]*)"|(\S+))(?:\s|$)/

function parseLine(line: string): RouteHit | null {
  const trimmed = line.trim()
  if (trimmed === '') return null
  // jsonMode
  if (trimmed.startsWith('{')) {
    try {
      const doc = JSON.parse(trimmed) as Record<string, unknown>
      if (doc.message !== 'req') return null
      const method = doc.method
      const path = doc.path
      if (typeof method !== 'string' || typeof path !== 'string') return null
      return { method: method.toUpperCase(), path }
    } catch {
      return null
    }
  }
  const m = HUMAN_REQ.exec(trimmed)
  if (m === null) return null
  const method = m[1] ?? m[2]
  const path = m[3] ?? m[4]
  if (method === undefined || path === undefined) return null
  return { method: method.toUpperCase(), path }
}

export function parseRouteHits(logText: string): RouteHit[] {
  const out: RouteHit[] = []
  for (const line of logText.split('\n')) {
    const hit = parseLine(line)
    if (hit !== null) out.push(hit)
  }
  return out
}

let sequence = 0

/**
 * 从一个 daemon 的临时 home 里捞出所有 `req` 行，去重后追加到 journal。
 *
 * **必须排在 `rmSync(home)` 之前**。`keepHome=true` 的分支（crash-recovery 复用
 * 同一个 home 起两次 daemon）会被调用两次，两次都读同一个 log 文件——聚合端做
 * 并集，重复无害。
 *
 * 采集是 best-effort：任何失败都不得让 spec 的 teardown 报错，否则一条与被测
 * 行为无关的 IO 抖动会把整条 spec 判红。
 */
export function captureRouteHits(home: string): void {
  const dir = routeJournalDir()
  if (dir === null) return
  try {
    const seen = new Set<string>()
    for (const file of daemonLogFiles(home)) {
      let text: string
      try {
        text = readFileSync(file, 'utf-8')
      } catch {
        continue
      }
      for (const hit of parseRouteHits(text)) seen.add(`${hit.method} ${hit.path}`)
    }
    if (seen.size === 0) return
    mkdirSync(dir, { recursive: true })
    sequence += 1
    const target = join(dir, `${basename(home)}-${process.pid}-${sequence}.jsonl`)
    const body = [...seen]
      .sort()
      .map((key) => {
        const idx = key.indexOf(' ')
        return JSON.stringify({ method: key.slice(0, idx), path: key.slice(idx + 1) })
      })
      .join('\n')
    appendFileSync(target, `${body}\n`, 'utf-8')
  } catch {
    // best-effort：采集失败不能让 teardown 变成 spec 失败。
    // 「采集全空」这件事由聚合端 fail closed（见 architecture 守卫），不在这里报。
  }
}
