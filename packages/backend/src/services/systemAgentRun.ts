// RFC-234 §1 (T2) — runSystemAgent: the shared non-task system-agent run
// primitive (intent turn engine / change narrative / MCP playground consume it).
//
// RFC-280 T4 UPDATE: process reliability (spawn / stdin / timeout / TERM→KILL /
// reap / bounded drain) is no longer hand-rolled here — it lives in the unified
// agent executor (services/execution/agentProcess.ts → managedProcess, the one
// process-reliability authority for ALL five spawn paths). This module keeps
// only the system-agent-specific layer: scratch dir + seed files, the ordered
// event sink, output evidence, startup-inventory capture, and the result-domain
// mapping. runtimeSmoke and memoryDistiller call the same executor directly
// rather than adapting this module — the RFC-234 "extract on the third caller"
// skeleton became the RFC-280 "one executor" primitive.
//
// Differences from both precedents, by design:
//  - `seedFiles` — the platform writes the working-directory dump BEFORE spawn
//    (the intent agent has no tools to fetch anything itself).
//  - scratch lives under a caller-supplied APP-HOME parent, not the OS tmpdir,
//    so failed-run remnants have a deterministic GC owner (design §1.2 /
//    Codex design-gate P1-7). Success removes; failure retains and reports
//    `scratchRetained` for the caller to persist.
//  - stderr tails pass through maskDiagnosticsText before leaving this module
//    (design §8 — diagnostics are a secret egress surface too).

import {
  getRuntimeDriver,
  getNativeAgentMaterialReference,
  bindNativeAgentMaterialWorkspace,
  type RuntimeKind,
} from '@/services/runtime'
import type { AgentSpawnContext, AgentSpawnPlan } from '@/services/runtime/types'
import { bindNativeAgentInvocation } from '@/modules/task-execution/composition/agentInvocation'
import { bindNativeAgentProtocol } from '@/modules/runtime-management/infrastructure/local/agentProtocol'
import type {
  RuntimeDriver,
  SpawnPlan,
  StartupInventory,
  SystemAgentOutputEvidence,
} from '@/services/runtime/types'
import { createLogger, type Logger } from '@/util/log'
import type { DeclaredInjectionManifest } from '@agent-workflow/shared'
import type { SystemAgentEventSinkV1 } from '@/services/sessionEventSink'

export interface SystemAgentSeedFile {
  /** Relative path under the scratch worktree; `..` and absolute are rejected. */
  path: string
  content: string
}

export interface SystemAgentRunOptions {
  /** Log/scratch prefix, e.g. 'intent-builder'. */
  feature: string
  agentName: string
  systemPrompt: string
  prompt: string
  protocol: RuntimeKind
  /** Resolved runtime binary; null/undefined → driver default head. */
  runtimeBinary?: string | null
  /**
   * RFC-237 (P1-2) — RFC-154 config-dir profile of the selected runtime row
   * (env-var name + leaf), forwarded to the driver so custom claude forks land
   * in the private per-run dir. Omitted → protocol defaults.
   */
  configDirEnv?: string | null
  configDirName?: string | null
  model?: string | null
  /** RFC-276: opt-in Claude CLI compatibility marker; default false. */
  isSandbox?: boolean
  seedFiles?: readonly SystemAgentSeedFile[]
  /** App-home parent for scratch dirs (deterministic GC owner). */
  scratchParent: string
  /** Scratch leaf name (e.g. the turn id); default random. */
  scratchName?: string
  timeoutMs?: number
  maxEventTextBytes?: number
  /** Maximum UTF-8 bytes retained for one stdout/stderr frame. */
  /**
   * @deprecated RFC-280 T4 — line bounding now lives in the unified executor
   * (managedProcess 1MiB line cap; a clipped line still marks the capture
   * incomplete via onLineTruncated → 'stream-frame-limit-exceeded'). The value
   * is accepted for caller compatibility but no longer read.
   */
  maxRawFrameBytes?: number
  abortSignal?: AbortSignal
  /** RFC-235: auxiliary ordered Session event capture; never gates business output. */
  eventSink?: SystemAgentEventSinkV1
  /** MCP playground: sink root hooks also own the native single-writer lease. */
  nativeIdentityAuthoritative?: boolean
  log?: Logger
  /** RFC-282 C1 — TEST-ONLY runtime-neutral command-head override. */
  binaryOverride?: readonly string[]
  /**
   * RFC-282 B1b (§2.1b) — ctx-level seam replacing the old `buildPlan` escape
   * hatch: an adapter may customize the assembly INPUT, never the output. The
   * assembly itself always runs through `driver.buildSpawn`, so the
   * declared manifest and the actual injection are the same computation —
   * `buildPlan` could return an arbitrary plan and dodge all four guards.
   */
  buildCtx?: (args: {
    driver: RuntimeDriver
    worktreePath: string
    runDir: string
    log: Logger
  }) => AgentSpawnContext
  /**
   * §2.1b — wrap-only hook (实现门 P2-2: replacement is now TYPE-inexpressible):
   * the adapter returns ONLY the two wrappable slots; cmd/env/stdin/declared
   * never leave the driver's plan. runSystemAgent composes the result.
   */
  wrapPlan?: (
    basePlan: AgentSpawnPlan,
    args: { driver: RuntimeDriver; worktreePath: string; runDir: string; log: Logger },
  ) =>
    | Pick<AgentSpawnPlan, 'beforeSpawn' | 'cleanup'>
    | Promise<Pick<AgentSpawnPlan, 'beforeSpawn' | 'cleanup'>>
  /**
   * TEST-ONLY (§2.1b) — wholesale plan replacement for in-process fake runs
   * (fixture runFn doubles). Production adapters use buildCtx/wrapPlan.
   */
  testPlanOverride?: (args: {
    driver: RuntimeDriver
    worktreePath: string
    runDir: string
    log: Logger
  }) => SpawnPlan | Promise<SpawnPlan>
  /**
   * Called after spawn and before piped stdin is delivered. A failure triggers
   * the normal TERM→KILL→reap barrier and no successful result is returned.
   */
  onSpawned?: (receipt: {
    pid: number | null
    spawnedAt: number
    spawnBinaryPath: string
  }) => void | Promise<void>
  /** Session-owned scratch survives successful turns; end/idle removes it. */
  retainScratchOnSuccess?: boolean
  /**
   * RFC-367 — continue an existing native session instead of opening a new one
   * (`opencode run --session <id>` / `claude --resume <id>`, assembled by the
   * driver). Used for protocol follow-ups: the agent already holds the full
   * task context, so the follow-up turn only has to re-emit a corrected envelope.
   * Omitted → a fresh session, and the rendered ctx is field-for-field what it
   * was before this option existed.
   */
  resumeSessionId?: string
}

export type SystemAgentRunStatus =
  | 'ok'
  | 'spawn-failed'
  | 'timeout'
  | 'aborted'
  | 'exit-nonzero'
  /** RFC-237 (P2-4): clean exit but the runtime reported a terminal
   *  application error (claude `result` with `is_error:true` — auth/API
   *  failures that previously masqueraded as a missing envelope). */
  | 'result-error'
  | 'unreaped'

export interface SystemAgentRunResult {
  status: SystemAgentRunStatus
  exitCode: number | null
  /** Concatenated PARSED-event text — the envelope extraction source. */
  eventText: string
  /** Capped stderr tail, credential-masked. */
  stderrTail: string
  durationMs: number
  /** RFC-237 (P2-4): masked terminal error text for `status: 'result-error'`. */
  resultError?: string
  capturedSessionId?: string
  /** Native resume identity was contradicted or reset without a replacement. */
  nativeSessionIntegrityFailed?: boolean
  scratchDir: string
  /** True when the scratch dir was deliberately kept (failure diagnosis / GC). */
  scratchRetained: boolean
  /** Metadata-only stdout evidence; never contains assistant text. */
  outputEvidence: SystemAgentOutputEvidence
  /**
   * RFC-280 T6 — the runtime's one-shot startup report (claude init:
   * tools/agents/skills/mcp_servers with statuses), captured in-stream for the
   * startup-verification layer. Absent on runtimes that report none (opencode
   * observation rides the RFC-029 inventory file instead).
   */
  startupInventory?: StartupInventory
  /** RFC-282 B1b (§2.1b-2) — the declared manifest from THIS run's unified
   *  assembly. Absent on testPlanOverride fixture runs. Settle-time
   *  verification consumes this instead of re-rendering (same computation). */
  declared?: AgentSpawnPlan['declared']
}

export {
  classifyMissingEnvelope,
  emptySystemAgentOutputEvidence,
  type MissingEnvelopeReason,
} from '@/modules/task-execution/application/systemAgentRun'
import {
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_EVENT_TEXT_BYTES,
  runSystemAgentCore,
} from '@/modules/task-execution/application/systemAgentRun'

// Native compatibility names keep the original implementation and results.
export { releaseSystemAgentScratch, assertSafeSeedPath } from '@/services/runtime'

export async function runSystemAgent(opts: SystemAgentRunOptions): Promise<SystemAgentRunResult> {
  const log = opts.log ?? createLogger('systemAgentRun')
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxEventTextBytes = opts.maxEventTextBytes ?? DEFAULT_MAX_EVENT_TEXT_BYTES
  const startedAt = Date.now()
  const driver = getRuntimeDriver(opts.protocol)

  const materialWorkspace = bindNativeAgentMaterialWorkspace({
    kind: 'system',
    parent: () => opts.scratchParent,
    feature: () => opts.feature,
    scratchName: () => opts.scratchName,
    seedFiles: () => opts.seedFiles,
  })
  const scratchDir = materialWorkspace.locations.root
  const worktreeDir = materialWorkspace.locations.workingDirectory
  const runDir = materialWorkspace.locations.runDirectory

  const coreLog = Object.create(log, {
    warn: {
      get() {
        const warn = log.warn
        return (message: string, fields?: Record<string, unknown>) => {
          const projected =
            message !== 'system-agent-scratch-retained' || fields === undefined
              ? fields
              : Object.fromEntries(
                  Object.entries(fields).map(([key, value]) =>
                    key === 'retainedRef' ? ['scratchDir', scratchDir] : [key, value],
                  ),
                )
          return warn.call(log, message, projected)
        }
      },
    },
  }) as Logger
  const result = await runSystemAgentCore(opts, {
    log: coreLog,
    timeoutMs,
    maxEventTextBytes,
    startedAt,
    invocation: {
      workspace: materialWorkspace.workspace,
      acknowledgeStart: () => opts.onSpawned !== undefined,
      prepareWorkspace: () => materialWorkspace.workspace.prepare(),
      async compile() {
        let declaredForResult: DeclaredInjectionManifest | undefined
        const seamArgs = { driver, worktreePath: worktreeDir, runDir, log }
        const plan =
          opts.testPlanOverride !== undefined
            ? await opts.testPlanOverride(seamArgs)
            : await (async () => {
                const base = await driver.buildSpawn(
                  opts.buildCtx !== undefined ? opts.buildCtx(seamArgs) : defaultUnifiedCtx(),
                )
                declaredForResult = base.declared
                if (opts.wrapPlan === undefined) return base
                // Compose wrap-only slots over the driver's plan — the plan
                // itself is structurally out of the adapter's reach (§2.1b).
                const wrapped = await opts.wrapPlan(base, seamArgs)
                const composed = {
                  ...base,
                  ...(wrapped.beforeSpawn !== undefined
                    ? { beforeSpawn: wrapped.beforeSpawn }
                    : {}),
                  ...(wrapped.cleanup !== undefined ? { cleanup: wrapped.cleanup } : {}),
                }
                getNativeAgentMaterialReference(composed, base)
                return composed
              })()
        function defaultUnifiedCtx(): AgentSpawnContext {
          return {
            // RFC-282 B1b — persona-only unified assembly: empty injection
            // set, no boundary (taskMounts omitted), declared manifest is
            // the by-product (empty faces for a bare persona).
            injection: { mcps: [] },
            prompt: opts.prompt,
            agentName: opts.agentName,
            systemPrompt: opts.systemPrompt,
            resolvedParamsByAgent: new Map([
              [
                opts.agentName,
                {
                  model: opts.model != null && opts.model !== '' ? opts.model : null,
                  variant: null,
                  temperature: null,
                  steps: null,
                  maxSteps: null,
                  isSandbox: opts.isSandbox === true,
                },
              ],
            ]),
            cwd: worktreeDir,
            runRoot: runDir,
            // Callers pass the pair together (intent/narrative thread
            // runtime.configDir) or not at all; a single half keeps the
            // legacy omitted-default (unreached by any production caller).
            ...(opts.configDirEnv != null &&
            opts.configDirEnv !== '' &&
            opts.configDirName != null &&
            opts.configDirName !== ''
              ? { configDir: { env: opts.configDirEnv, name: opts.configDirName } }
              : {}),
            freshAgentRun: false,
            // RFC-367: absent → the spread contributes nothing, so a caller that
            // never resumes renders the exact pre-RFC-367 ctx.
            ...(opts.resumeSessionId != null && opts.resumeSessionId !== ''
              ? { resumeSessionId: opts.resumeSessionId }
              : {}),
            ...(opts.runtimeBinary != null && opts.runtimeBinary !== ''
              ? { runtimeBinary: opts.runtimeBinary }
              : {}),
            ...(opts.binaryOverride === undefined ? {} : { binaryOverride: opts.binaryOverride }),
            nodeRunId: `${opts.feature}-system`,
            log,
          }
        }
        const prepared = plan
        return {
          ...(declaredForResult === undefined ? {} : { declared: declaredForResult }),
          bind() {
            return bindNativeAgentInvocation({
              plan: prepared,
              protocol: bindNativeAgentProtocol(driver),
              workspace: materialWorkspace.workspace,
              workingDirectory: () => worktreeDir,
              nativeStartOwner: opts,
              cleanupReceiver: 'material',
              evidenceHooks: driver,
              evidenceScope: {
                environment: () => prepared.env,
                runContent: () => runDir,
                sessionLocation: () => ({ worktreePath: worktreeDir }),
              },
            })
          },
          cleanup: () => prepared.cleanup?.(),
        }
      },
    },
  })
  // Preserve the legacy field location/order as well as its physical value.
  return Object.fromEntries(
    Object.entries(result).map(([key, value]) =>
      key === 'retainedRef' ? ['scratchDir', scratchDir] : [key, value],
    ),
  ) as unknown as SystemAgentRunResult
}
