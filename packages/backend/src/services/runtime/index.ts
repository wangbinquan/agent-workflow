// RFC-111 PR-A — runtime driver registry + resolution.
//
// `getRuntimeDriver` is the factory (multica's Backend-factory pattern) that
// maps a frozen `node_runs.runtime` kind to its driver. `RUNTIME_KINDS` /
// `isKnownRuntimeKind` are the single source for "which runtime kinds exist",
// derived from the DRIVERS registry (RFC-143).
//
// (RFC-143 deleted the old `resolveRuntime` pure fn — a hardcoded three-way with
// zero production callers; fresh-dispatch runtime selection flows through
// runtimeRegistry.resolveAgentRuntime, and resume/retry read the frozen
// node_runs.runtime.)

import type { RuntimeDriver, RuntimeKind } from './types'
import { opencodeDriver } from './opencode/driver'
import { claudeCodeDriver } from './claudeCode/driver'

export type { RuntimeKind, RuntimeDriver } from './types'

const DRIVERS: Record<RuntimeKind, RuntimeDriver> = {
  opencode: opencodeDriver,
  'claude-code': claudeCodeDriver,
}

/**
 * Look up the driver for a (frozen) runtime kind — EXECUTION paths
 * (spawn / probe / capture). RFC-282 C2（决策 13）: an unknown kind throws
 * loudly instead of silently running as opencode (a corrupt or future
 * runtime value used to be executed by the wrong driver with zero signal).
 * Read/display paths that must survive a dirty row use `tryGetRuntimeDriver`.
 */
export function getRuntimeDriver(kind: RuntimeKind): RuntimeDriver {
  const driver = DRIVERS[kind]
  if (driver === undefined) {
    throw new Error(
      `unknown runtime kind '${String(kind)}' — no registered driver (RFC-282 决策 13)`,
    )
  }
  return driver
}

/** Read/display-path lookup: null for an unknown kind so one dirty DB row
 *  degrades that row instead of 500-ing the whole page (设计门 P2-1). */
export function tryGetRuntimeDriver(kind: string | null | undefined): RuntimeDriver | null {
  return kind != null && isKnownRuntimeKind(kind) ? DRIVERS[kind] : null
}

/**
 * RFC-143 — the SINGLE source for "which runtime kinds exist", derived from the
 * DRIVERS registry. `RUNTIME_PROTOCOLS` / `BUILTIN_RUNTIMES` / `BUILTIN_NAMES`
 * (runtimeRegistry.ts) and `ProtocolSchema` (routes/runtimes.ts) all derive from
 * this instead of each re-hardcoding the `'opencode' | 'claude-code'` literal
 * set. Adding a runtime = register a driver here + widen the RuntimeKind union;
 * every derived set updates automatically.
 */
export const RUNTIME_KINDS = Object.keys(DRIVERS) as RuntimeKind[]

/** Type guard: is `v` a registered runtime kind? Replaces the hand-copied
 *  `v === 'opencode' || v === 'claude-code'` checks (nodeRunMint, registry). */
export function isKnownRuntimeKind(v: string | null | undefined): v is RuntimeKind {
  return v != null && (RUNTIME_KINDS as string[]).includes(v)
}

// ---------------------------------------------------------------------------
// RFC-282 C3 — the named external surface of the relocated opencode modules.
// Per design §4.2 this is deliberately NOT a barrel: each name is re-exported
// individually with its cycle argument. External code imports from HERE; deep
// imports are fenced by the A1 ESLint rule.
// ---------------------------------------------------------------------------

// probeOpencode: version probe used by registry/status faces.
// (resolveOpencodeCmd 已于 RFC-284 T19 删除——生产消费方自 RFC-282 C1 起为零，
// config.opencodePath 的头解析只活在 mint 冻结链 scheduler.freezeBinaryConfig。)
export { probeOpencode } from './opencode/util'
// Platform-owned claude flags (registry extraArgs validation).
export { CLAUDE_PLATFORM_OWNED_FLAGS } from './claudeCode/spawn'
// Startup-inventory run-root projection (the provider-neutral task read model
// supplies stored rows; only the in-flight file fallback remains here).
export { readSnapshotFromRunDir, runRootFor } from './opencode/inventory'
// Live-capture null object (runner's no-capability fallback handle).
export { NOOP_HANDLE } from './opencode/subagentLiveCapture'
// Distiller session sweep failure marker (memory distill session view).
export { DISTILL_CAPTURE_FAILED_KIND } from './opencode/distillSessionCapture'
// Frozen plugin runtime specifier projection used by startup inventory.
export { pluginFileSpec } from './opencode/pluginSpec'
