// `agent-workflow status` — print daemon state.

import { existsSync, readFileSync } from 'node:fs'
import { isProcessAlive, readPidFromLock } from '@/util/lock'
import { Paths } from '@/util/paths'

interface DaemonInfo {
  pid: number
  host: string
  port: number
  url: string
  startedAt: string
}

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
  info?: DaemonInfo
  /** Result of fetching /health, if reachable. */
  health?: HealthReport
  /** Error string when /health probe failed. */
  healthError?: string
}

export async function statusCommand(): Promise<StatusResult> {
  const pid = readPidFromLock(Paths.lock)
  if (pid === null) return { state: 'not-running' }
  if (!isProcessAlive(pid)) return { state: 'stale-lock', pid }

  let info: DaemonInfo | undefined
  if (existsSync(Paths.daemonInfo)) {
    try {
      info = JSON.parse(readFileSync(Paths.daemonInfo, 'utf-8')) as DaemonInfo
    } catch {
      // info file missing/garbled; still report 'running' via PID
    }
  }

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
    lines.push(`  opencode:   ${r.health.opencodeVersion ?? '(unknown)'}`)
    lines.push(`  db version: ${r.health.dbVersion}`)
    lines.push(`  uptime:     ${r.health.uptime}s`)
    lines.push(`  tasks now:  ${r.health.runningTasks}`)
  } else if (r.healthError) {
    lines.push(`  /health:    unreachable (${r.healthError})`)
  }
  return lines.join('\n') + '\n'
}
