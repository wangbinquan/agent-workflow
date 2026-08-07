// RFC-103 T2 + RFC-108 T4 — single source for launch-time runtime config.
//
// Resolves the settings that must be threaded into `StartTaskDeps` for EVERY
// scheduler-kicking entry point (JSON start / multipart start / resume / retry /
// repair-resume / parked clarify+review resume / fusion). Before this lived in
// routes/tasks.ts and only the task routes used it, so other production kicks
// (fusion, parked clarify/review resume) ran nodes with no commit&push, no
// concurrency cap, and — pre-RFC-108 — no hard-timeout floor (Codex impl gate
// P2). Hoisting it here lets all routes share one resolver.

import type { Language } from '@agent-workflow/shared'
import { loadConfig } from '@/config'

/** RFC-075: read the auto commit&push runtime config from settings. */
export function resolveCommitPushConfig(configPath: string):
  | {
      model?: string
      runtime?: string
      maxRepairRetries?: number
      diffMaxBytes?: number
      lang?: Language
    }
  | undefined {
  try {
    const cfg = loadConfig(configPath)
    const out: {
      model?: string
      runtime?: string
      maxRepairRetries?: number
      diffMaxBytes?: number
      lang?: Language
    } = {}
    if (cfg.commitPushModel !== undefined) out.model = cfg.commitPushModel
    // RFC-117: commit agent runtime profile (wins over the deprecated model).
    if (cfg.commitPushRuntime !== undefined) out.runtime = cfg.commitPushRuntime
    if (cfg.commitPushMaxRepairRetries !== undefined)
      out.maxRepairRetries = cfg.commitPushMaxRepairRetries
    if (cfg.commitPushDiffMaxBytes !== undefined) out.diffMaxBytes = cfg.commitPushDiffMaxBytes
    // RFC-157: commit-message output language (undefined ≡ en-US at spawn time).
    if (cfg.commitPushLang !== undefined) out.lang = cfg.commitPushLang
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
 *
 * RFC-266: `multiProcessSubprocessConcurrency` was the SAME defect one knob
 * over — Settings persisted it, the scheduler read `opts.multiProcessSubprocessConcurrency`,
 * but nothing in between ever read it off the config, so every fan-out ran at
 * the hard-coded `?? 4` no matter what the administrator set. It is threaded
 * here now, together with the new `maxConcurrentScriptNodes` (the independent
 * script-node pool). Three knobs, three defects of the exact same shape
 * (RFC-108 timeout, RFC-103 concurrency, RFC-266 fan-out) — the source-anchor
 * test in rfc103-launch-config-passthrough.test.ts now locks all of them.
 */
export function resolveLaunchRuntimeConfig(configPath: string): {
  commitPush?: {
    model?: string
    runtime?: string
    maxRepairRetries?: number
    diffMaxBytes?: number
    lang?: Language
  }
  maxConcurrentNodes?: number
  maxConcurrentScriptNodes?: number // RFC-266: independent script-node pool
  multiProcessSubprocessConcurrency?: number
  defaultPerNodeTimeoutMs?: number
  defaultRuntime?: string // RFC-112: a registered runtime NAME (built-ins or custom)
  defaultNodeRetries?: number // RFC-115: global per-node retry budget
  mergeAgent?: { model?: string; runtime?: string } // RFC-130: built-in merge resolver
  maxActiveChildTasks?: number // RFC-243 §3.2: global active-child-task cap
  maxInvocationDepth?: number // RFC-243 §3.2: invocation-chain depth ceiling
  // RFC-253 script nodes.
  scriptInterpreters?: { python?: string; bash?: string; node?: string }
  scriptDepsInstallTimeoutMs?: number
} {
  const out: {
    commitPush?: {
      model?: string
      runtime?: string
      maxRepairRetries?: number
      diffMaxBytes?: number
    }
    maxConcurrentNodes?: number
    maxConcurrentScriptNodes?: number // RFC-266
    multiProcessSubprocessConcurrency?: number
    defaultPerNodeTimeoutMs?: number
    defaultRuntime?: string // RFC-112: a registered runtime NAME (built-ins or custom)
    defaultNodeRetries?: number // RFC-115: global per-node retry budget
    claudeCodePath?: string // RFC-112: built-in claude binary (config.claudeCodePath)
    mergeAgent?: { model?: string; runtime?: string } // RFC-130: built-in merge resolver
    maxActiveChildTasks?: number // RFC-243
    maxInvocationDepth?: number // RFC-243
    scriptInterpreters?: { python?: string; bash?: string; node?: string } // RFC-253
    scriptDepsInstallTimeoutMs?: number // RFC-253
    maxConcurrentCodeHostCalls?: number // RFC-269
    codeHostRequestTimeoutMs?: number // RFC-269
    codeHostResponseMaxBytes?: number // RFC-269
  } = {}
  const commitPush = resolveCommitPushConfig(configPath)
  if (commitPush !== undefined) out.commitPush = commitPush
  try {
    const cfg = loadConfig(configPath)
    if (cfg.maxConcurrentNodes !== undefined) out.maxConcurrentNodes = cfg.maxConcurrentNodes
    // RFC-266: the script pool + the fan-out sub-pool ride the same funnel.
    if (cfg.maxConcurrentScriptNodes !== undefined)
      out.maxConcurrentScriptNodes = cfg.maxConcurrentScriptNodes
    // RFC-269: the code-host pool + its request knobs ride the same funnel.
    // Forgetting one here is the RFC-243/266 failure mode — the pool is a
    // daemon singleton with resize-on-read, so a missing key silently rewrites
    // the administrator's setting back to the default for the WHOLE daemon.
    if (cfg.maxConcurrentCodeHostCalls !== undefined)
      out.maxConcurrentCodeHostCalls = cfg.maxConcurrentCodeHostCalls
    if (cfg.codeHostRequestTimeoutMs !== undefined)
      out.codeHostRequestTimeoutMs = cfg.codeHostRequestTimeoutMs
    if (cfg.codeHostResponseMaxBytes !== undefined)
      out.codeHostResponseMaxBytes = cfg.codeHostResponseMaxBytes
    if (cfg.multiProcessSubprocessConcurrency !== undefined)
      out.multiProcessSubprocessConcurrency = cfg.multiProcessSubprocessConcurrency
    if (cfg.defaultPerNodeTimeoutMs !== undefined && cfg.defaultPerNodeTimeoutMs > 0)
      out.defaultPerNodeTimeoutMs = cfg.defaultPerNodeTimeoutMs
    // RFC-111: global default runtime threaded to the scheduler dispatch site.
    if (cfg.defaultRuntime !== undefined) out.defaultRuntime = cfg.defaultRuntime
    // RFC-115: global per-node retry budget (no `> 0` guard — 0 disables retries).
    if (cfg.defaultNodeRetries !== undefined) out.defaultNodeRetries = cfg.defaultNodeRetries
    // RFC-253: administrator interpreter overrides + dependency build budget.
    if (cfg.scriptInterpreters !== undefined && Object.keys(cfg.scriptInterpreters).length > 0)
      out.scriptInterpreters = cfg.scriptInterpreters
    if (cfg.scriptDepsInstallTimeoutMs !== undefined && cfg.scriptDepsInstallTimeoutMs > 0)
      out.scriptDepsInstallTimeoutMs = cfg.scriptDepsInstallTimeoutMs
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
  try {
    const cfg = loadConfig(configPath)
    out.maxActiveChildTasks = cfg.maxActiveChildTasks
    out.maxInvocationDepth = cfg.maxInvocationDepth
  } catch {
    // config unreadable — child-budget consumers fall back to defaults
  }
  return out
}
