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

import { lstatSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { getRuntimeDriver, type RuntimeKind } from '@/services/runtime'
import type { AgentSpawnContext, AgentSpawnPlan } from '@/services/runtime/types'
import { runAgentProcess } from '@/services/execution/agentProcess'
import type {
  RuntimeDriver,
  SpawnPlan,
  StartupInventory,
  SystemAgentOutputEvidence,
} from '@/services/runtime/types'
import { createLogger, type Logger } from '@/util/log'
import { isLexicallyInsideForHost } from '@/util/platformExec'
import { maskDiagnosticsText } from '@agent-workflow/shared'
import type {
  SessionCaptureIncompleteReason,
  SystemAgentEventSinkV1,
} from '@/services/sessionEventSink'

const DEFAULT_TIMEOUT_MS = 600_000
const DEFAULT_MAX_EVENT_TEXT_BYTES = 8 * 1024 * 1024
const STDERR_TAIL_CAP = 8 * 1024
const CHILD_TERM_GRACE_MS = 2_000

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

export function emptySystemAgentOutputEvidence(): SystemAgentOutputEvidence {
  return {
    assistantTextSeen: false,
    observedAssistantTextBytes: 0,
    retainedAssistantTextBytes: 0,
    eventTextCapHit: false,
    unparsedStdoutSeen: false,
    lastNormalizedEventKind: null,
    lastRuntimeEventType: null,
    terminalResult: 'not-observed',
  }
}

function saturatingAdd(left: number, right: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, left + right)
}

export function releaseSystemAgentScratch(input: {
  scratchDir: string
  expectedParent: string
  expectedName: string
}): { removed: boolean; reason?: 'unsafe-path' | 'remove-failed' } {
  if (
    !isAbsolute(input.expectedParent) ||
    resolve(input.expectedParent) !== input.expectedParent ||
    input.expectedName.length === 0 ||
    input.expectedName.includes('\0') ||
    input.expectedName.includes('/') ||
    input.expectedName.includes('\\') ||
    !isAbsolute(input.scratchDir) ||
    resolve(input.scratchDir) !== input.scratchDir ||
    input.scratchDir !== join(input.expectedParent, input.expectedName)
  ) {
    return { removed: false, reason: 'unsafe-path' }
  }
  try {
    const metadata = lstatSync(input.scratchDir)
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      return { removed: false, reason: 'unsafe-path' }
    }
    rmSync(input.scratchDir, { recursive: true, force: true })
    return { removed: true }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { removed: true }
    return { removed: false, reason: 'remove-failed' }
  }
}

/** Reject traversal/absolute seed paths BEFORE any filesystem write. */
export function assertSafeSeedPath(worktreeDir: string, relPath: string): string {
  if (relPath.length === 0 || isAbsolute(relPath)) {
    throw new Error(`unsafe seed path: ${relPath}`)
  }
  // RFC-254 T1: `resolve()` yields `\`-separated paths on Windows, so the old
  // `${worktreeDir}/` prefix test rejected every legitimate seed path there.
  const abs = resolve(worktreeDir, relPath)
  if (!isLexicallyInsideForHost(worktreeDir, abs)) {
    throw new Error(`unsafe seed path: ${relPath}`)
  }
  return abs
}

export async function runSystemAgent(opts: SystemAgentRunOptions): Promise<SystemAgentRunResult> {
  const log = opts.log ?? createLogger('systemAgentRun')
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxEventTextBytes = opts.maxEventTextBytes ?? DEFAULT_MAX_EVENT_TEXT_BYTES
  const startedAt = Date.now()
  const driver = getRuntimeDriver(opts.protocol)

  const scratchName = opts.scratchName ?? `${opts.feature}-${randomBytes(8).toString('hex')}`
  const scratchDir = join(opts.scratchParent, scratchName)
  const worktreeDir = join(scratchDir, 'worktree')
  const runDir = join(scratchDir, 'run')

  const outputEvidence = emptySystemAgentOutputEvidence()
  const fail = (
    status: SystemAgentRunStatus,
    extra: Partial<SystemAgentRunResult> = {},
  ): SystemAgentRunResult => ({
    status,
    exitCode: null,
    eventText: '',
    stderrTail: '',
    durationMs: Date.now() - startedAt,
    scratchDir,
    scratchRetained: false,
    outputEvidence: { ...outputEvidence },
    ...extra,
  })

  // ── scratch layout + seed files (platform-side; agent never fetches) ──
  try {
    mkdirSync(opts.scratchParent, { recursive: true, mode: 0o700 })
    mkdirSync(worktreeDir, { recursive: true, mode: 0o700 })
    mkdirSync(runDir, { recursive: true, mode: 0o700 })
    for (const seed of opts.seedFiles ?? []) {
      const abs = assertSafeSeedPath(worktreeDir, seed.path)
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, seed.content)
    }
  } catch (err) {
    rmSync(scratchDir, { recursive: true, force: true })
    return fail('spawn-failed', {
      stderrTail: maskDiagnosticsText(
        `scratch setup failed: ${err instanceof Error ? err.message : String(err)}`,
      ),
    })
  }

  let plan: SpawnPlan | null = null
  // RFC-282 B1b — declared manifest from the unified assembly (absent on
  // testPlanOverride fixtures); threaded onto the result for settle-time
  // verification so no consumer re-renders it (§2.1b-2).
  let declaredForResult: AgentSpawnPlan['declared'] | undefined
  let result: SystemAgentRunResult | undefined
  let sinkTerminal = false
  let sinkFailed = false
  let sinkFailureReason: SessionCaptureIncompleteReason | undefined
  let sinkTerminalIntent:
    | { state: 'complete' | 'incomplete'; reason?: SessionCaptureIncompleteReason }
    | undefined

  const markSinkTerminal = async (
    state: 'complete' | 'incomplete',
    reason?: SessionCaptureIncompleteReason,
  ): Promise<void> => {
    if (opts.eventSink === undefined || sinkTerminal) return
    if (
      sinkTerminalIntent === undefined ||
      (state === 'incomplete' && sinkTerminalIntent.state === 'complete')
    ) {
      sinkTerminalIntent = {
        state,
        ...(state === 'incomplete' && reason !== undefined ? { reason } : {}),
      }
    }
    const terminal = sinkTerminalIntent
    try {
      await opts.eventSink.markTerminal(terminal.state, terminal.reason)
      sinkTerminal = true
    } catch (error) {
      log.warn('system-agent-session-terminal-persist-failed', {
        feature: opts.feature,
        err: maskDiagnosticsText(error instanceof Error ? error.message : String(error)),
      })
    }
  }
  const failSink = async (
    reason: SessionCaptureIncompleteReason,
    error: unknown,
  ): Promise<void> => {
    if (!sinkFailed) {
      sinkFailed = true
      sinkFailureReason = reason
      log.warn('system-agent-session-event-persist-failed', {
        feature: opts.feature,
        reason,
        err: maskDiagnosticsText(error instanceof Error ? error.message : String(error)),
      })
    }
    await markSinkTerminal('incomplete', reason)
  }
  const appendSink = async (
    event: Parameters<SystemAgentEventSinkV1['append']>[0],
  ): Promise<void> => {
    if (opts.eventSink === undefined || sinkFailed) return
    try {
      await opts.eventSink.append(event)
    } catch (error) {
      await failSink('stream-persist-failed', error)
    }
  }
  const setSinkRoot = async (sessionId: string, previousSessionId?: string): Promise<void> => {
    if (opts.eventSink === undefined) return
    if (sinkFailed && opts.nativeIdentityAuthoritative !== true) return
    try {
      await opts.eventSink.setRootSessionId(sessionId, previousSessionId)
    } catch (error) {
      await failSink('stream-persist-failed', error)
      // This hook owns native-session claim/rotation for MCP. Continuing the
      // child after a collision would violate the single-writer lease.
      if (opts.nativeIdentityAuthoritative === true) throw error
    }
  }
  const markSinkResetPending = async (sessionId: string): Promise<void> => {
    if (opts.eventSink === undefined) return
    if (sinkFailed && opts.nativeIdentityAuthoritative !== true) return
    if (opts.eventSink.markRootSessionResetPending === undefined) {
      if (opts.nativeIdentityAuthoritative === true) {
        throw new Error('authoritative native-session sink cannot persist reset boundaries')
      }
      return
    }
    try {
      await opts.eventSink.markRootSessionResetPending(sessionId)
    } catch (error) {
      await failSink('stream-persist-failed', error)
      if (opts.nativeIdentityAuthoritative === true) throw error
    }
  }

  try {
    result = await (async (): Promise<SystemAgentRunResult> => {
      try {
        const seamArgs = { driver, worktreePath: worktreeDir, runDir, log }
        plan =
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
                return {
                  ...base,
                  ...(wrapped.beforeSpawn !== undefined
                    ? { beforeSpawn: wrapped.beforeSpawn }
                    : {}),
                  ...(wrapped.cleanup !== undefined ? { cleanup: wrapped.cleanup } : {}),
                }
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
            wantsInventory: false,
            ...(opts.runtimeBinary != null && opts.runtimeBinary !== ''
              ? { runtimeBinary: opts.runtimeBinary }
              : {}),
            ...(opts.binaryOverride === undefined ? {} : { binaryOverride: opts.binaryOverride }),
            nodeRunId: `${opts.feature}-system`,
            log,
          }
        }
      } catch (err) {
        return fail('spawn-failed', {
          stderrTail: maskDiagnosticsText(
            `failed to prepare spawn: ${err instanceof Error ? err.message : String(err)}`,
          ),
        })
      }

      // RFC-280 T4 — the child's whole lifecycle (spawn / stdin / timers /
      // TERM→KILL / reap / bounded drain) lives in the unified agent executor;
      // this function keeps only what is system-agent-specific: the event
      // sink, output evidence, and the result-domain mapping.
      let sessionId: string | undefined
      let pendingConversationReset:
        | { outgoingSessionId: string; newConversationId: string }
        | undefined
      let nativeSessionIntegrityFailed = false
      let eventText = ''
      let eventTextBytes = 0
      let stderrText = ''
      // RFC-237 (P2-4): terminal application error reported on a clean-exit
      // stdout line (claude `result` is_error). Last one wins.
      let resultError: string | undefined
      let receiptError: unknown
      let capturedStartupInventory: StartupInventory | null = null

      const run = await runAgentProcess({
        cmd: plan.cmd,
        cwd: worktreeDir,
        env: plan.env,
        timeoutMs,
        termGraceMs: CHILD_TERM_GRACE_MS,
        ...(opts.abortSignal !== undefined ? { abortSignal: opts.abortSignal } : {}),
        ...(plan.stdin?.mode === 'pipe' ? { stdin: plan.stdin } : {}),
        ...(plan.beforeSpawn !== undefined ? { beforeSpawn: plan.beforeSpawn } : {}),
        ...(opts.onSpawned !== undefined
          ? {
              onSpawned: async (receipt: {
                pid: number
                spawnedAt: number
                spawnBinaryPath: string
              }) => {
                try {
                  await opts.onSpawned?.({
                    pid: receipt.pid,
                    spawnedAt: receipt.spawnedAt,
                    spawnBinaryPath: receipt.spawnBinaryPath,
                  })
                } catch (err) {
                  // Historical contract: a failed spawn receipt is a SPAWN
                  // failure (mcp playground admission fence) — remember the
                  // cause and let the executor abort the child.
                  receiptError = err
                  throw err
                }
              },
            }
          : {}),
        capture: {
          onStdoutLine: async (line) => {
            const observation = driver.observeSystemEvent?.(line)
            if (observation !== undefined) {
              if (observation.runtimeEventType !== null) {
                outputEvidence.lastRuntimeEventType = observation.runtimeEventType
              }
              if (observation.terminalResult === 'error') {
                outputEvidence.terminalResult = 'error'
              } else if (
                observation.terminalResult === 'success' &&
                outputEvidence.terminalResult !== 'error'
              ) {
                outputEvidence.terminalResult = 'success'
              }
            }
            const terminalError = driver.parseTerminalResultError?.(line)
            if (terminalError != null) resultError = terminalError
            const ev = driver.parseEvent(line)
            // RFC-280 T6 / RFC-297 T14 —— 一次性启动报告。改为消费 driver 在
            // **同一次解析**里挂上的事件载荷，不再对同一行二次 JSON.parse。
            if (capturedStartupInventory === null && ev !== null) {
              const faces = ev.data?.inventory?.faces
              if (faces !== undefined) {
                capturedStartupInventory = {
                  ...(faces.tools === undefined ? {} : { tools: faces.tools.map((t) => t.key) }),
                  ...(faces.agents === undefined ? {} : { agents: faces.agents.map((a) => a.key) }),
                  ...(faces.skills === undefined ? {} : { skills: faces.skills.map((s) => s.key) }),
                  ...(faces.mcps === undefined
                    ? {}
                    : {
                        mcpServers: faces.mcps.map((m) => ({
                          name: m.key,
                          status: m.status ?? '',
                        })),
                      }),
                }
              }
            }
            if (ev === null) {
              outputEvidence.unparsedStdoutSeen = true
              await appendSink({
                ts: Date.now(),
                kind: 'text',
                payload: line,
                sessionId: sessionId ?? null,
                parentSessionId: null,
                source: 'stream',
              })
              return
            }
            outputEvidence.lastNormalizedEventKind = ev.kind
            if (ev.sessionId !== undefined) {
              if (sessionId === undefined) {
                sessionId = ev.sessionId
                try {
                  await setSinkRoot(ev.sessionId)
                } catch {
                  nativeSessionIntegrityFailed = true
                  throw new Error('runtime native session claim failed')
                }
              } else if (sessionId !== ev.sessionId) {
                if (
                  pendingConversationReset === undefined ||
                  pendingConversationReset.outgoingSessionId !== sessionId
                ) {
                  nativeSessionIntegrityFailed = true
                  throw new Error('runtime changed native session id without a conversation reset')
                }
                const previousSessionId = sessionId
                sessionId = ev.sessionId
                pendingConversationReset = undefined
                try {
                  await setSinkRoot(sessionId, previousSessionId)
                } catch {
                  nativeSessionIntegrityFailed = true
                  throw new Error('runtime native session rotation failed')
                }
              }
            }
            if (ev.conversationReset !== undefined) {
              if (
                sessionId === undefined ||
                ev.conversationReset.outgoingSessionId !== sessionId ||
                pendingConversationReset !== undefined
              ) {
                nativeSessionIntegrityFailed = true
                throw new Error('runtime reported an invalid conversation reset boundary')
              }
              pendingConversationReset = ev.conversationReset
              try {
                await markSinkResetPending(sessionId)
              } catch {
                nativeSessionIntegrityFailed = true
                throw new Error('runtime native session reset fence failed')
              }
            }
            if (typeof ev.text === 'string' && ev.text.length > 0) {
              const bytes = Buffer.byteLength(ev.text, 'utf8')
              outputEvidence.assistantTextSeen = true
              outputEvidence.observedAssistantTextBytes = saturatingAdd(
                outputEvidence.observedAssistantTextBytes,
                bytes,
              )
              if (eventTextBytes + bytes <= maxEventTextBytes) {
                eventText += ev.text
                eventTextBytes += bytes
                outputEvidence.retainedAssistantTextBytes = saturatingAdd(
                  outputEvidence.retainedAssistantTextBytes,
                  bytes,
                )
              } else {
                outputEvidence.eventTextCapHit = true
              }
            }
            await appendSink({
              ts: ev.timestamp ?? Date.now(),
              kind: ev.kind,
              payload: ev.rawLine,
              sessionId: ev.sessionId ?? sessionId ?? null,
              parentSessionId: null,
              source: 'stream',
            })
          },
          onStderrLine: async (line) => {
            const remaining = STDERR_TAIL_CAP - Buffer.byteLength(stderrText, 'utf8')
            if (remaining > 0) {
              stderrText += Buffer.from(`${line}\n`, 'utf8').subarray(0, remaining).toString('utf8')
            }
            await appendSink({
              ts: Date.now(),
              kind: 'stderr',
              payload: maskDiagnosticsText(line),
              sessionId: sessionId ?? null,
              parentSessionId: null,
              source: 'stream',
            })
          },
          // A clipped frame stored as if whole would lie to the session view —
          // mark the capture incomplete exactly like the historical
          // frame-limit path did.
          onLineTruncated: () =>
            failSink(
              'stream-frame-limit-exceeded',
              new Error('stream line exceeded the executor line cap'),
            ),
        },
        log,
      })

      if (run.outcome === 'spawn-failed' || receiptError !== undefined) {
        const message =
          receiptError !== undefined
            ? receiptError instanceof Error
              ? receiptError.message
              : String(receiptError)
            : (run.spawnError ?? 'unknown spawn failure')
        return fail('spawn-failed', {
          stderrTail: maskDiagnosticsText(`binary failed to start: ${message}`),
        })
      }
      if (run.outcome === 'unreaped') {
        return fail('unreaped')
      }
      if (run.pumpError !== undefined) {
        await failSink('stream-persist-failed', new Error(run.pumpError))
        return fail('exit-nonzero', {
          stderrTail: maskDiagnosticsText(run.pumpError).slice(0, STDERR_TAIL_CAP),
          ...(nativeSessionIntegrityFailed || pendingConversationReset !== undefined
            ? { nativeSessionIntegrityFailed: true }
            : {}),
        })
      }
      if (pendingConversationReset !== undefined) {
        await failSink(
          'stream-persist-failed',
          new Error(
            'runtime ended before reporting the replacement native session id after conversation reset',
          ),
        )
        return fail('exit-nonzero', {
          stderrTail:
            'runtime ended before reporting the replacement native session id after conversation reset',
          nativeSessionIntegrityFailed: true,
        })
      }
      const exitCode = run.exitCode
      if (run.drainTimedOut === true) {
        // Bounded post-exit flush expired — evidence loss, not completion.
        await failSink(
          'post-exit-flush-timeout',
          new Error('stdout/stderr did not reach EOF after child exit'),
        )
      }

      const stderrTail = maskDiagnosticsText(stderrText.slice(0, STDERR_TAIL_CAP))
      // RFC-237 — post-exit child-session sweep is a driver capability now
      // (opencode: private-store SQLite walk; claude omits it — the full main
      // session already streamed through parseEvent into the sink).
      if (
        !sinkFailed &&
        opts.eventSink !== undefined &&
        sessionId !== undefined &&
        driver.captureSessionsToSink !== undefined
      ) {
        const captured = await driver.captureSessionsToSink({
          rootSessionId: sessionId,
          sink: opts.eventSink,
          log,
        })
        if (captured.failed) {
          await failSink('child-capture-failed', captured.failureReason)
        }
      }
      if (!sinkFailed) await markSinkTerminal('complete')

      const base = {
        exitCode,
        eventText,
        stderrTail,
        durationMs: Date.now() - startedAt,
        ...(sessionId === undefined ? {} : { capturedSessionId: sessionId }),
        scratchDir,
        scratchRetained: false,
        outputEvidence: { ...outputEvidence },
        ...(capturedStartupInventory === null
          ? {}
          : { startupInventory: capturedStartupInventory }),
        ...(declaredForResult === undefined ? {} : { declared: declaredForResult }),
      }
      if (run.outcome === 'aborted') return { status: 'aborted', ...base }
      if (run.outcome === 'timeout') return { status: 'timeout', ...base }
      if (exitCode !== 0) return { status: 'exit-nonzero', ...base }
      // RFC-237 (P2-4): clean exit but a terminal is_error result — fail the
      // run with the masked error text instead of letting the caller chase a
      // phantom missing envelope. Impl-gate P2: the text must reach the
      // caller's PERSISTED diagnostics — stderr is commonly empty in this
      // shape, so it doubles as the stderr tail when there was none.
      if (resultError !== undefined) {
        const masked = maskDiagnosticsText(resultError).slice(0, STDERR_TAIL_CAP)
        return {
          status: 'result-error',
          ...base,
          ...(base.stderrTail.length === 0 ? { stderrTail: masked } : {}),
          resultError: masked,
        }
      }
      return { status: 'ok', ...base }
    })()
  } finally {
    if (!sinkTerminal) {
      await markSinkTerminal(
        sinkFailed || result?.status === 'unreaped' ? 'incomplete' : 'complete',
        sinkFailed
          ? sinkFailureReason
          : result?.status === 'unreaped'
            ? 'post-exit-flush-timeout'
            : undefined,
      )
    }
    // RFC-280 T4: the child's kill/reap lifecycle lives in the unified
    // executor; what remains here are the two ordered barriers that must run
    // AFTER the post-exit capture sweep — plan cleanup, then scratch disposal.
    const preparedPlan = plan as SpawnPlan | null
    if (result?.status === 'unreaped') {
      // The child (or a descendant) may still own files under scratch — no
      // cleanup, retain everything for recovery.
      result = { ...result, scratchRetained: true }
    } else {
      let cleanupOk = true
      try {
        await preparedPlan?.cleanup?.()
      } catch {
        cleanupOk = false
      }
      if (!cleanupOk) {
        result = {
          ...(result ?? fail('spawn-failed')),
          status: 'spawn-failed',
          stderrTail: 'runtime cleanup failed',
          scratchRetained: true,
        }
      } else {
        const wantScratchRemoved =
          result !== undefined && result.status === 'ok' && opts.retainScratchOnSuccess !== true
        let scratchRemoved = false
        if (wantScratchRemoved) {
          try {
            rmSync(scratchDir, { recursive: true, force: true })
            scratchRemoved = true
          } catch {
            // Retained deliberately — recovery + GC own it now.
          }
        }
        if (result !== undefined) {
          result = { ...result, scratchRetained: !scratchRemoved }
          if (result.status === 'ok' && !scratchRemoved && opts.retainScratchOnSuccess !== true) {
            // Cleanup barrier failed on a success path: surface it — the store
            // may still be locked; retaining scratch is deliberate.
            log.warn('system-agent-scratch-retained', {
              feature: opts.feature,
              scratchDir,
            })
          }
        }
      }
    }
  }
  return result ?? fail('spawn-failed', { scratchRetained: true })
}
