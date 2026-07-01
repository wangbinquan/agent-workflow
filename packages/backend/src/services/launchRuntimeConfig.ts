// RFC-103 T2 + RFC-108 T4 — single source for launch-time runtime config.
//
// Resolves the settings that must be threaded into `StartTaskDeps` for EVERY
// scheduler-kicking entry point (JSON start / multipart start / resume / retry /
// repair-resume / parked clarify+review resume / fusion). Before this lived in
// routes/tasks.ts and only the task routes used it, so other production kicks
// (fusion, parked clarify/review resume) ran nodes with no commit&push, no
// concurrency cap, and — pre-RFC-108 — no hard-timeout floor (Codex impl gate
// P2). Hoisting it here lets all routes share one resolver.

import { loadConfig } from '@/config'

/** RFC-075: read the auto commit&push runtime config from settings. */
export function resolveCommitPushConfig(
  configPath: string,
):
  | { model?: string; runtime?: string; maxRepairRetries?: number; diffMaxBytes?: number }
  | undefined {
  try {
    const cfg = loadConfig(configPath)
    const out: {
      model?: string
      runtime?: string
      maxRepairRetries?: number
      diffMaxBytes?: number
    } = {}
    if (cfg.commitPushModel !== undefined) out.model = cfg.commitPushModel
    // RFC-117: commit agent runtime profile (wins over the deprecated model).
    if (cfg.commitPushRuntime !== undefined) out.runtime = cfg.commitPushRuntime
    if (cfg.commitPushMaxRepairRetries !== undefined)
      out.maxRepairRetries = cfg.commitPushMaxRepairRetries
    if (cfg.commitPushDiffMaxBytes !== undefined) out.diffMaxBytes = cfg.commitPushDiffMaxBytes
    return Object.keys(out).length > 0 ? out : undefined
  } catch {
    return undefined
  }
}

/**
 * Resolve runtime config (auto commit&push + global concurrency cap + RFC-108
 * per-node hard-timeout floor) from settings ONCE, for every launch entry
 * point. Single source so the entries can't drift again.
 *
 * RFC-108 T4 (AR-01): `defaultPerNodeTimeoutMs` (config default 30min) is read
 * here and threaded into `StartTaskDeps`; the scheduler applies it to every
 * node as a hard kill bound. RFC-115 removed the per-node `timeoutMs` override
 * (and added `defaultNodeRetries` + threads `defaultRuntime` through the same
 * funnel), so the global value is now the single source. Before RFC-108 this
 * field was threaded NOWHERE — default-config nodes ran with no timeout, so a
 * hung-but-alive opencode child was effectively immortal.
 */
export function resolveLaunchRuntimeConfig(configPath: string): {
  commitPush?: {
    model?: string
    runtime?: string
    maxRepairRetries?: number
    diffMaxBytes?: number
  }
  maxConcurrentNodes?: number
  defaultPerNodeTimeoutMs?: number
  defaultRuntime?: string // RFC-112: a registered runtime NAME (built-ins or custom)
  defaultNodeRetries?: number // RFC-115: global per-node retry budget
  mergeAgent?: { model?: string; runtime?: string } // RFC-130: built-in merge resolver
} {
  const out: {
    commitPush?: {
      model?: string
      runtime?: string
      maxRepairRetries?: number
      diffMaxBytes?: number
    }
    maxConcurrentNodes?: number
    defaultPerNodeTimeoutMs?: number
    defaultRuntime?: string // RFC-112: a registered runtime NAME (built-ins or custom)
    defaultNodeRetries?: number // RFC-115: global per-node retry budget
    claudeCodePath?: string // RFC-112: built-in claude binary (config.claudeCodePath)
    mergeAgent?: { model?: string; runtime?: string } // RFC-130: built-in merge resolver
  } = {}
  const commitPush = resolveCommitPushConfig(configPath)
  if (commitPush !== undefined) out.commitPush = commitPush
  try {
    const cfg = loadConfig(configPath)
    if (cfg.maxConcurrentNodes !== undefined) out.maxConcurrentNodes = cfg.maxConcurrentNodes
    if (cfg.defaultPerNodeTimeoutMs !== undefined && cfg.defaultPerNodeTimeoutMs > 0)
      out.defaultPerNodeTimeoutMs = cfg.defaultPerNodeTimeoutMs
    // RFC-111: global default runtime threaded to the scheduler dispatch site.
    if (cfg.defaultRuntime !== undefined) out.defaultRuntime = cfg.defaultRuntime
    // RFC-115: global per-node retry budget (no `> 0` guard — 0 disables retries).
    if (cfg.defaultNodeRetries !== undefined) out.defaultNodeRetries = cfg.defaultNodeRetries
    // RFC-130 §6.1: built-in merge-conflict resolver runtime (profile wins over model).
    if (cfg.mergeAgentModel !== undefined || cfg.mergeAgentRuntime !== undefined) {
      out.mergeAgent = {
        ...(cfg.mergeAgentModel !== undefined ? { model: cfg.mergeAgentModel } : {}),
        ...(cfg.mergeAgentRuntime !== undefined ? { runtime: cfg.mergeAgentRuntime } : {}),
      }
    }
    // RFC-113 §5: claudeCodePath is no longer threaded (the claude runtime row's
    // binary_path carries it now — RFC-112 P2 is收口).
  } catch {
    // fall back to the scheduler defaults
  }
  return out
}
