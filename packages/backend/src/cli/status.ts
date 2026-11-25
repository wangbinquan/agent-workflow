// `agent-workflow status` — print daemon state.

import type { DaemonRuntimeQueries } from '@/modules/system-operations/public/queries'
import type { DaemonRuntimeInfo } from '@/modules/system-operations/public/types'
import { isProcessAlive, readPidFromLock } from '@/platform/execution/local/daemonLock'
import { Paths } from '@/platform/configuration/installationPaths'

export interface HealthReport {
  ok: boolean
  opencodeVersion: string | null
  dbVersion: number
  uptime: number
  runningTasks: number
}

export interface StatusResult {
  state: 'running' | 'not-running' | 'stale-lock'
  pid?: number
  info?: DaemonRuntimeInfo
  /** Result of fetching /health, if reachable. */
  health?: HealthReport
  /** Error string when /health probe failed. */
  healthError?: string
}

/**
 * RFC-573: the run-info comes through system-operations' query port. `main.ts` hands in the file implementation that
 * bootstrap composes — the same one `GET /api/daemon` reads through.
 */
export async function statusCommand(daemonRuntime: DaemonRuntimeQueries): Promise<StatusResult> {
  const pid = readPidFromLock(Paths.lock)
  if (pid === null) return { state: 'not-running' }
  if (!isProcessAlive(pid)) return { state: 'stale-lock', pid }

  // info file missing/garbled → undefined; still report 'running' via PID.
  const info: DaemonRuntimeInfo | undefined = (await daemonRuntime.readCurrent()) ?? undefined

  let health: HealthReport | undefined
  let healthError: string | undefined
  if (info) {
    try {
      const res = await fetch(`http://${info.host}:${info.port}/health`)
      if (res.ok) {
        health = (await res.json()) as HealthReport
      } else {
        healthError = `HTTP ${res.status}`
      }
    } catch (err) {
      healthError = (err as Error).message
    }
  }

  const result: StatusResult = { state: 'running', pid }
  if (info !== undefined) result.info = info
  if (health !== undefined) result.health = health
  if (healthError !== undefined) result.healthError = healthError
  return result
}

export function formatStatus(r: StatusResult): string {
  if (r.state === 'not-running') return 'agent-workflow: daemon is not running\n'
  if (r.state === 'stale-lock') {
    return `agent-workflow: stale lock for dead PID ${r.pid ?? '?'} — run \`agent-workflow stop\` to clean it up\n`
  }
  const lines: string[] = []
  lines.push(`agent-workflow: daemon running`)
  lines.push(`  pid:        ${r.pid}`)
  if (r.info) {
    lines.push(`  url:        ${r.info.url}`)
    lines.push(`  host:port:  ${r.info.host}:${r.info.port}`)
    lines.push(`  startedAt:  ${r.info.startedAt}`)
  }
  if (r.health) {
    lines.push(`  opencode:   ${r.health.opencodeVersion ?? '(not checked at startup)'}`)
    lines.push(`  db version: ${r.health.dbVersion}`)
    lines.push(`  uptime:     ${r.health.uptime}s`)
    lines.push(`  tasks now:  ${r.health.runningTasks}`)
  } else if (r.healthError) {
    lines.push(`  /health:    unreachable (${r.healthError})`)
  }
  return lines.join('\n') + '\n'
}
