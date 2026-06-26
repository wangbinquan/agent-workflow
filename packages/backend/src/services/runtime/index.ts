// RFC-111 PR-A — runtime driver registry + resolution.
//
// `resolveRuntime` is the single source for "which runtime does this run use"
// (RFC-111 D1: global default + per-agent override; D15: the resolved value is
// frozen onto node_runs.runtime at mint time so resume/retry never re-resolve
// across a mutated agent/default). `getRuntimeDriver` is the factory (multica's
// Backend-factory pattern) that maps a frozen kind to its driver.

import type { RuntimeDriver, RuntimeKind } from './types'
import { opencodeDriver } from './opencode/driver'
import { claudeCodeDriver } from './claudeCode/driver'

export type { RuntimeKind, RuntimeDriver } from './types'

/**
 * Resolve the runtime for a fresh dispatch: per-agent `runtime` wins, else the
 * global `defaultRuntime`, else `'opencode'`. An unrecognized value falls back
 * to `'opencode'` (NULL/unset agents are the legacy default — zero behavior
 * change). Note: this is for the FIRST dispatch only; resume/clarify-rerun read
 * the frozen `node_runs.runtime` instead (RFC-111 D15) and fail closed on an
 * unknown frozen value rather than silently coercing here.
 */
export function resolveRuntime(
  agentRuntime: string | null | undefined,
  defaultRuntime: string | null | undefined,
): RuntimeKind {
  // Treat null / undefined / '' all as "inherit" so an empty-string column
  // value can't be mistaken for an explicit selection by `??`.
  const pick = (v: string | null | undefined): string | undefined =>
    typeof v === 'string' && v.length > 0 ? v : undefined
  const raw = pick(agentRuntime) ?? pick(defaultRuntime) ?? 'opencode'
  return raw === 'claude-code' ? 'claude-code' : 'opencode'
}

const DRIVERS: Record<RuntimeKind, RuntimeDriver> = {
  opencode: opencodeDriver,
  'claude-code': claudeCodeDriver,
}

/** Look up the driver for a (frozen) runtime kind. Unregistered → opencode. */
export function getRuntimeDriver(kind: RuntimeKind): RuntimeDriver {
  return DRIVERS[kind] ?? opencodeDriver
}
