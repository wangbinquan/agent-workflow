// RFC-319 R1 —— 运行期端点命中账本的**聚合端**。
//
// 采集端在 `e2e/route-journal.ts`（harness 在删临时 home 之前，从
// `<home>/logs/daemon.log*` 捞出 `server.ts:317` 写的逐请求 `req` 行）。
// 这里把那些**具体**路径归一成路由模式，与 `allRouteMeta()` 的声明表求差，
// 得到「一次都没被任何 e2e 打到的端点」。
//
// 守卫与播种脚本共用本模块：判据只能有一套。

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { compilePatterns, resolveConcretePath, routeKey, type RoutePattern } from './routeMatch'

export interface JournalEntry {
  readonly method: string
  readonly path: string
}

export interface HitReport {
  /** 读到的 journal 文件数——0 表示这次跑根本没采到，必须 fail closed。 */
  readonly journalFiles: number
  /** 去重后的具体请求数。 */
  readonly distinctRequests: number
  /** 被打到的路由模式（`METHOD /path`），已排序。 */
  readonly hit: readonly string[]
  /** 声明了但一次都没被打到的路由模式，已排序。 */
  readonly uncovered: readonly string[]
  /**
   * 日志里出现、却对不上任何一条注册路由的具体请求。
   *
   * 这是**反方向**的信号：要么归一器写错了，要么有路径绕过了 `allRouteMeta()`。
   * 两种都不该静默，所以它单独成一栏而不是被丢弃。
   */
  readonly unresolved: readonly string[]
}

export function readJournalDir(dir: string): { files: number; entries: JournalEntry[] } {
  let names: string[]
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.jsonl'))
  } catch {
    return { files: 0, entries: [] }
  }
  const entries: JournalEntry[] = []
  for (const name of names) {
    const text = readFileSync(join(dir, name), 'utf-8')
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      try {
        const doc = JSON.parse(trimmed) as Partial<JournalEntry>
        if (typeof doc.method === 'string' && typeof doc.path === 'string') {
          entries.push({ method: doc.method, path: doc.path })
        }
      } catch {
        // 单行坏掉不该让整次聚合失败；「整体采空」由 journalFiles / distinctRequests 兜底。
      }
    }
  }
  return { files: names.length, entries }
}

export function buildHitReport(
  declared: readonly RoutePattern[],
  journal: { files: number; entries: readonly JournalEntry[] },
): HitReport {
  const compiled = compilePatterns(declared)
  const hit = new Set<string>()
  const unresolved = new Set<string>()
  const distinct = new Set<string>()
  for (const e of journal.entries) {
    distinct.add(`${e.method} ${e.path}`)
    const resolved = resolveConcretePath(compiled, e.method, e.path)
    if (resolved === null) unresolved.add(`${e.method} ${e.path}`)
    else hit.add(routeKey(resolved))
  }
  const all = declared.map(routeKey)
  const uncovered = all.filter((k) => !hit.has(k))
  return {
    journalFiles: journal.files,
    distinctRequests: distinct.size,
    hit: [...hit].sort(),
    uncovered: [...new Set(uncovered)].sort(),
    unresolved: [...unresolved].sort(),
  }
}

export interface EndpointLedger {
  readonly schemaVersion: number
  readonly note: string
  readonly recordedAtSha: string
  /** 一次都没被 e2e 打到的端点，`METHOD /path`，升序去重。 */
  readonly uncovered: readonly string[]
}

export function parseLedger(text: string): EndpointLedger {
  return JSON.parse(text) as EndpointLedger
}
