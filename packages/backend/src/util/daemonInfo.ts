// Runtime info the `start` command writes to `Paths.daemonInfo` right after
// `Bun.serve` resolves the *effective* binding (host + the concrete port, which
// is only known post-serve when bindPort was 0 / ephemeral).
//
// This is the single source of truth for "what host:port is the daemon actually
// listening on right now" — deliberately distinct from the PERSISTED
// bindHost/bindPort in config.json, which (a) may be blank (ephemeral port) and
// (b) can be overridden at launch by the --host / --port CLI flags without ever
// being written back. `agent-workflow status` and GET /api/daemon both read it
// here so neither re-implements the parse.

import { existsSync, readFileSync } from 'node:fs'
import { Paths } from '@/util/paths'
import type { DaemonRuntimeInfo } from '@/modules/system-operations/public/types'

export type DaemonInfo = DaemonRuntimeInfo

/**
 * Read the daemon run-info file. Returns null when it is absent (daemon not
 * running / not yet written) or unparseable, so callers can render a graceful
 * "unknown" rather than crashing.
 */
export function readDaemonInfo(path: string = Paths.daemonInfo): DaemonInfo | null {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as DaemonInfo
  } catch {
    return null
  }
}
