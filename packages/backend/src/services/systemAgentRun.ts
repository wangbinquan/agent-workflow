// RFC-234 §1 (T2) — runSystemAgent: the shared non-task system-agent run
// primitive.
//
// memoryDistiller and runtimeSmoke each hand-roll the same lifecycle:
//   scratch dir (worktree/ + run/, 0700) → containment admit (once, before any
//   store touch) → driver.buildSpawn → wrapSpawnPlanSandbox → Bun.spawn
//   (detached) → capped drains → timeout TERM→KILL→reap-deadline escalation →
//   reap-then-cleanup barrier → scratch removal (retain on failure).
// This module is the third caller's extraction of that skeleton (design §1 —
// "第三处出现时应抽公共原语"); the intent turn engine (T5) consumes it, and
// distiller/smoke migrate onto it as thin adapters in the T2 follow-up.
//
// Differences from both precedents, by design:
//  - `seedFiles` — the platform writes the working-directory dump BEFORE spawn
//    (the intent agent has no tools to fetch anything itself).
//  - `systemPermissionProfile` — forwarded to the driver (RFC-234 §1.1 frozen
//    enum; 'intent-read-v1' is only provable on the opencode verified path).
//  - scratch lives under a caller-supplied APP-HOME parent, not the OS tmpdir,
//    so failed-run remnants have a deterministic GC owner (design §1.2 /
//    Codex design-gate P1-7). Success removes; failure retains and reports
//    `scratchRetained` for the caller to persist.
//  - stderr tails pass through maskDiagnosticsText before leaving this module
//    (design §8 — diagnostics are a secret egress surface too).

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { getRuntimeDriver, type RuntimeKind } from '@/services/runtime'
import type { RuntimeDriver, SpawnPlan, SystemPermissionProfile } from '@/services/runtime/types'
import {
  wrapSpawnPlanSandbox,
  type ContainmentRequirementProfileId,
  type ContainmentCoordinator,
  type PreparedContainmentPlan,
  type SandboxCtx,
} from '@/services/sandbox'
import { createLogger, type Logger } from '@/util/log'
import { explainSpawnEnoent } from '@/util/spawnDiagnostics'
import { isLexicallyInsideForHost } from '@/util/platformExec'
import {
  isExecutionIdentityFailureCode,
  maskDiagnosticsText,
  type ExecutionIdentityFailureCode,
} from '@agent-workflow/shared'
import { parseExecutionIdentityFailureOutput } from '@/services/runtime/opencode/failure'
import { platformSpawnOptionsForHost } from '@/util/platformExec'
import type {
  SessionCaptureIncompleteReason,
  SystemAgentEventSinkV1,
} from '@/services/sessionEventSink'

const DEFAULT_TIMEOUT_MS = 600_000
const DEFAULT_MAX_EVENT_TEXT_BYTES = 8 * 1024 * 1024
const DEFAULT_MAX_RAW_FRAME_BYTES = 2 * 1024 * 1024
const STDERR_TAIL_CAP = 8 * 1024
const CHILD_TERM_GRACE_MS = 2_000
const CHILD_REAP_DEADLINE_MS = 2_000

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
  seedFiles?: readonly SystemAgentSeedFile[]
  systemPermissionProfile?: SystemPermissionProfile
  /** RFC-233 daemon-scoped admission authority; admit runs EXACTLY ONCE here. */
  containmentCoordinator?: ContainmentCoordinator
  /** App-home parent for scratch dirs (deterministic GC owner). */
  scratchParent: string
  /** Scratch leaf name (e.g. the turn id); default random. */
  scratchName?: string
  timeoutMs?: number
  maxEventTextBytes?: number
  /** Maximum UTF-8 bytes retained for one stdout/stderr frame. */
  maxRawFrameBytes?: number
  abortSignal?: AbortSignal
  /** RFC-235: auxiliary ordered Session event capture; never gates business output. */
  eventSink?: SystemAgentEventSinkV1
  bridgeCredentials?: boolean
  log?: Logger
  /** Explicit dependency-injection seam for legacy mock-binary tests. */
  testOnlyUnverifiedRuntime?: boolean
  /** Branded production command head (see SystemAgentSpawnContext.opencodeCmd). */
  opencodeCmd?: readonly string[]
  /**
   * RFC-238: closed product adapters may supply a driver-owned plan without
   * widening SystemAgentSpawnContext. Existing system-agent callers omit this
   * and remain byte-for-byte on driver.buildSpawn.
   */
  buildPlan?: (ctx: {
    driver: RuntimeDriver
    worktreePath: string
    runDir: string
    containment?: PreparedContainmentPlan
    log: Logger
  }) => Promise<SpawnPlan>
  /** Capability-specific admission profile; defaults to runner-filesystem-v1. */
  containmentProfile?: ContainmentRequirementProfileId
  /**
   * Called after spawn and before piped stdin is delivered. A failure triggers
   * the normal TERM→KILL→reap barrier and no successful result is returned.
   */
  onSpawned?: (receipt: {
    pid: number | null
    spawnedAt: number
    spawnBinaryPath: string
    rawCommandDigest?: string
    spawnCommandDigest: string
  }) => void | Promise<void>
  /**
   * Verified persistent launchers emit a private marker on stderr and wait for
   * an ACK before prompting. Product adapters consume it here; consumed frames
   * never enter user-visible stderr/events.
   */
  onControlLine?: (input: {
    line: string
    control: Exclude<NonNullable<SpawnPlan['control']>, { kind: 'none' }>
  }) => Promise<{ kind: 'stderr'; line: string } | { kind: 'session-ready'; sessionId: string }>
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
  | 'identity-failed'
  | 'unreaped'

export interface SystemAgentRunResult {
  status: SystemAgentRunStatus
  exitCode: number | null
  /** Concatenated PARSED-event text — the envelope extraction source. */
  eventText: string
  /** Capped stderr tail, credential-masked. */
  stderrTail: string
  durationMs: number
  failureCode?: ExecutionIdentityFailureCode
  /** RFC-237 (P2-4): masked terminal error text for `status: 'result-error'`. */
  resultError?: string
  capturedSessionId?: string
  scratchDir: string
  /** True when the scratch dir was deliberately kept (failure diagnosis / GC). */
  scratchRetained: boolean
}

/** kill the whole process group (the child is `detached`), best-effort. */
function killGroup(child: Bun.Subprocess, signal: 'SIGTERM' | 'SIGKILL'): void {
  try {
    if (typeof child.pid === 'number') process.kill(-child.pid, signal)
    else child.kill(signal === 'SIGKILL' ? 9 : 15)
  } catch {
    /* already gone */
  }
}

async function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      promise.then(
        () => true,
        () => false,
      ),
      new Promise<false>((resolveRace) => {
        timeoutHandle = setTimeout(() => resolveRace(false), timeoutMs)
        timeoutHandle.unref?.()
      }),
    ])
  } finally {
    if (timeoutHandle !== null) clearTimeout(timeoutHandle)
  }
}

function identityFailureCode(error: unknown): ExecutionIdentityFailureCode | null {
  if (error === null || typeof error !== 'object') return null
  const code = (error as { code?: unknown }).code
  return isExecutionIdentityFailureCode(code) ? code : null
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

function systemSandboxCtx(
  worktreeDir: string,
  runDir: string,
  plan: SpawnPlan,
): SandboxCtx | undefined {
  const provider = plan.containment?.sandbox
  if (provider === undefined) return undefined
  return {
    mode: provider.mode,
    status: provider.status,
    appHome: provider.appHome,
    taskWorktrees: [
      worktreeDir,
      ...(plan.sessionStore === undefined ? [] : [plan.sessionStore.root]),
    ],
    runDir,
    ...(plan.readOnlySubtrees === undefined ? {} : { readOnlySubtrees: plan.readOnlySubtrees }),
    // 2026-08-04 audit: this field was silently DROPPED by three of the four
    // SandboxCtx assemblers (only `runner.ts` consumed it). It is latent today
    // because no system plan ships plugins — the moment one does, RFC-251's
    // Linux `file://<cachedPath>` ENOENT returns with no assertion to catch it.
    ...(plan.readOnlyAllowSubtrees === undefined
      ? {}
      : { readOnlyAllowSubtrees: plan.readOnlyAllowSubtrees }),
    ...(provider.wrapCommand === undefined ? {} : { wrapCommand: provider.wrapCommand }),
  }
}

/**
 * Reap-then-cleanup barrier (finalizeDistillerSpawnAttempt /
 * finalizeSmokeAttempt discipline): plan cleanup only after confirmed reap,
 * scratch removal only after cleanup succeeded. Returns false when anything
 * along the barrier failed — the scratch dir is then RETAINED.
 */
async function finalizeSystemAgentAttempt(input: {
  child: { exited: Promise<number>; unref?: () => void } | null
  childReaped: boolean
  killChild: (signal: 'SIGTERM' | 'SIGKILL') => void
  cleanup?: () => void | Promise<void>
  removeScratch: () => void
  terminationAlreadyExhausted: boolean
  wantScratchRemoved: boolean
}): Promise<{ reaped: boolean; cleanupSucceeded: boolean; scratchRemoved: boolean }> {
  let reaped = input.child === null || input.childReaped
  if (input.child !== null) {
    if (!reaped && !input.terminationAlreadyExhausted) {
      input.killChild('SIGTERM')
      reaped = await settlesWithin(input.child.exited, CHILD_TERM_GRACE_MS)
    }
    if (!reaped) {
      input.killChild('SIGKILL')
      reaped = await settlesWithin(input.child.exited, CHILD_REAP_DEADLINE_MS)
    } else {
      // A same-group descendant may still own inherited pipes / the private
      // store; sweep the group before crossing the cleanup barrier.
      input.killChild('SIGKILL')
    }
    if (!reaped) {
      input.child.unref?.()
      return { reaped: false, cleanupSucceeded: false, scratchRemoved: false }
    }
  }
  try {
    await input.cleanup?.()
  } catch {
    return { reaped: true, cleanupSucceeded: false, scratchRemoved: false }
  }
  if (!input.wantScratchRemoved) {
    return { reaped: true, cleanupSucceeded: true, scratchRemoved: false }
  }
  try {
    input.removeScratch()
  } catch {
    return { reaped: true, cleanupSucceeded: true, scratchRemoved: false }
  }
  return { reaped: true, cleanupSucceeded: true, scratchRemoved: true }
}

export async function runSystemAgent(opts: SystemAgentRunOptions): Promise<SystemAgentRunResult> {
  const log = opts.log ?? createLogger('systemAgentRun')
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxEventTextBytes = opts.maxEventTextBytes ?? DEFAULT_MAX_EVENT_TEXT_BYTES
  const maxRawFrameBytes = opts.maxRawFrameBytes ?? DEFAULT_MAX_RAW_FRAME_BYTES
  const startedAt = Date.now()
  const driver = getRuntimeDriver(opts.protocol)

  const scratchName = opts.scratchName ?? `${opts.feature}-${randomBytes(8).toString('hex')}`
  const scratchDir = join(opts.scratchParent, scratchName)
  const worktreeDir = join(scratchDir, 'worktree')
  const runDir = join(scratchDir, 'run')

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
    ...extra,
  })

  // ── containment admit: exactly once, before any store/scratch side effect ──
  let preparedContainment: PreparedContainmentPlan | undefined
  if (opts.containmentCoordinator !== undefined) {
    try {
      // System agents expose no model-controlled shell/MCP child — including
      // 'intent-read-v1', whose only additions are in-process read tools.
      preparedContainment = await opts.containmentCoordinator.admit(
        opts.containmentProfile ?? 'runner-filesystem-v1',
      )
    } catch (error) {
      const failureCode = identityFailureCode(error) ?? 'execution-identity-containment-required'
      return fail('identity-failed', { failureCode })
    }
  }

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

  let child: Bun.Subprocess<'ignore' | 'pipe', 'pipe', 'pipe'> | null = null
  let plan: SpawnPlan | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let sigkillTimer: ReturnType<typeof setTimeout> | null = null
  let reapDeadlineTimer: ReturnType<typeof setTimeout> | null = null
  let timedOut = false
  let aborted = false
  let childReaped = false
  let terminationAlreadyExhausted = false
  let cancelDrains: (() => Promise<void>) | null = null
  let onAbort: (() => void) | null = null
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
  const setSinkRoot = async (sessionId: string): Promise<void> => {
    if (opts.eventSink === undefined || sinkFailed) return
    try {
      await opts.eventSink.setRootSessionId(sessionId)
    } catch (error) {
      await failSink('stream-persist-failed', error)
    }
  }

  try {
    result = await (async (): Promise<SystemAgentRunResult> => {
      try {
        plan =
          opts.buildPlan !== undefined
            ? await opts.buildPlan({
                driver,
                worktreePath: worktreeDir,
                runDir,
                ...(preparedContainment === undefined ? {} : { containment: preparedContainment }),
                log,
              })
            : await driver.buildSpawn({
                agentName: opts.agentName,
                systemPrompt: opts.systemPrompt,
                ...(opts.model != null && opts.model !== '' ? { model: opts.model } : {}),
                prompt: opts.prompt,
                worktreePath: worktreeDir,
                runDir,
                ...(preparedContainment === undefined
                  ? {}
                  : {
                      appHome: preparedContainment.sandbox.appHome,
                      containment: preparedContainment,
                    }),
                ...(opts.runtimeBinary != null && opts.runtimeBinary !== ''
                  ? { runtimeBinary: opts.runtimeBinary }
                  : {}),
                ...(opts.configDirEnv != null && opts.configDirEnv !== ''
                  ? { configDirEnv: opts.configDirEnv }
                  : {}),
                ...(opts.configDirName != null && opts.configDirName !== ''
                  ? { configDirName: opts.configDirName }
                  : {}),
                ...(opts.bridgeCredentials !== undefined
                  ? { bridgeCredentials: opts.bridgeCredentials }
                  : {}),
                log,
                ...(opts.testOnlyUnverifiedRuntime === true
                  ? { testOnlyUnverifiedRuntime: true }
                  : {}),
                ...(opts.opencodeCmd === undefined ? {} : { opencodeCmd: opts.opencodeCmd }),
                ...(opts.systemPermissionProfile === undefined
                  ? {}
                  : { systemPermissionProfile: opts.systemPermissionProfile }),
              })
        if (preparedContainment !== undefined) {
          plan = {
            ...plan,
            containment: preparedContainment,
            sandboxTopology: preparedContainment.spawnTopology,
          }
        }
      } catch (err) {
        const failureCode = identityFailureCode(err)
        if (failureCode !== null) return fail('identity-failed', { failureCode })
        return fail('spawn-failed', {
          stderrTail: maskDiagnosticsText(
            `failed to prepare spawn: ${err instanceof Error ? err.message : String(err)}`,
          ),
        })
      }

      let spawnCmd: string[] | undefined
      try {
        await plan.preSpawnVerify?.()
        spawnCmd = wrapSpawnPlanSandbox(
          plan.cmd,
          systemSandboxCtx(worktreeDir, runDir, plan),
          plan.sandboxTopology,
        )
        child = Bun.spawn({
          ...platformSpawnOptionsForHost(),
          cmd: spawnCmd,
          cwd: worktreeDir,
          env: plan.env,
          stdout: 'pipe',
          stderr: 'pipe',
          stdin: plan.stdin?.mode === 'pipe' ? 'pipe' : 'ignore',
          detached: true,
        })
        if (opts.onSpawned !== undefined) {
          const rawCommandDigest = createHash('sha256')
            .update(JSON.stringify(plan.cmd))
            .digest('hex')
          await opts.onSpawned({
            pid: typeof child.pid === 'number' ? child.pid : null,
            spawnedAt: Date.now(),
            spawnBinaryPath: plan.cmd[0] ?? '',
            rawCommandDigest,
            spawnCommandDigest: createHash('sha256').update(JSON.stringify(spawnCmd)).digest('hex'),
          })
        }
      } catch (err) {
        // RFC-237 (P1-3): a preSpawnVerify seal-mutation rejection carries an
        // execution-identity code — surface it as identity-failed, not as a
        // generic start failure.
        const failureCode = identityFailureCode(err)
        if (failureCode !== null) return fail('identity-failed', { failureCode })
        // 2026-08-04: Bun's posix_spawn ENOENT names argv[0] even when the
        // missing path is the cwd — probe both so the tail blames the right one.
        return fail('spawn-failed', {
          stderrTail: maskDiagnosticsText(
            `binary failed to start: ${explainSpawnEnoent(
              err instanceof Error ? err.message : String(err),
              { argv0: spawnCmd?.[0] ?? plan.cmd[0], cwd: worktreeDir },
            )}`,
          ),
        })
      }

      if (plan.stdin?.mode === 'pipe') {
        const sink = child.stdin as { write: (s: string) => void; end: () => void } | undefined
        if (sink !== undefined) {
          sink.write(plan.stdin.data)
          sink.end()
        }
      }

      const liveChild = child
      const activePlan = plan as SpawnPlan
      let terminating = false
      const escalate = (): void => {
        if (terminating) return
        terminating = true
        killGroup(liveChild, 'SIGTERM')
        sigkillTimer = setTimeout(() => {
          killGroup(liveChild, 'SIGKILL')
          reapDeadlineTimer = setTimeout(() => {
            terminationAlreadyExhausted = true
            resolveReapDeadline({ kind: 'unreaped' })
          }, CHILD_REAP_DEADLINE_MS)
          reapDeadlineTimer.unref?.()
        }, CHILD_TERM_GRACE_MS)
        sigkillTimer.unref?.()
      }
      let resolveReapDeadline: (v: { kind: 'unreaped' }) => void = () => {}
      const reapDeadline = new Promise<{ kind: 'unreaped' }>((resolveRace) => {
        resolveReapDeadline = resolveRace
        timer = setTimeout(() => {
          timedOut = true
          escalate()
        }, timeoutMs)
        timer.unref?.()
      })
      if (opts.abortSignal !== undefined) {
        if (opts.abortSignal.aborted) {
          aborted = true
          escalate()
        } else {
          onAbort = () => {
            aborted = true
            escalate()
          }
          opts.abortSignal.addEventListener('abort', onAbort, { once: true })
        }
      }

      let sessionId: string | undefined
      let eventText = ''
      let eventTextBytes = 0
      let stderrText = ''
      // RFC-237 (P2-4): terminal application error reported on a clean-exit
      // stdout line (claude `result` is_error). Last one wins.
      let resultError: string | undefined
      const activeReaders = new Set<{
        cancel: () => Promise<void> | void
        releaseLock?: () => void
      }>()

      class LineHandlerError {
        constructor(readonly cause: unknown) {}
      }
      const readStream = async (
        stream: ReadableStream<Uint8Array> | undefined,
        onLine: (line: string) => void | Promise<void>,
        onOverflow: () => void | Promise<void>,
      ): Promise<void> => {
        if (stream === undefined) return
        const reader = stream.getReader()
        activeReaders.add(reader)
        const decoder = new TextDecoder('utf-8', { fatal: true })
        let buffered = Buffer.alloc(0)
        let dropping = false
        try {
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            let chunk = Buffer.from(value)
            while (chunk.byteLength > 0) {
              const newline = chunk.indexOf(0x0a)
              const segment = newline < 0 ? chunk : chunk.subarray(0, newline)
              if (!dropping) {
                if (buffered.byteLength + segment.byteLength > maxRawFrameBytes) {
                  buffered = Buffer.alloc(0)
                  dropping = true
                  try {
                    await onOverflow()
                  } catch (error) {
                    throw new LineHandlerError(error)
                  }
                } else if (segment.byteLength > 0) {
                  buffered = Buffer.concat([buffered, segment])
                }
              }
              if (newline < 0) break
              if (!dropping && buffered.byteLength > 0) {
                let line: string
                try {
                  line = decoder.decode(buffered)
                } catch (error) {
                  throw new LineHandlerError(error)
                }
                try {
                  await onLine(line.endsWith('\r') ? line.slice(0, -1) : line)
                } catch (error) {
                  throw new LineHandlerError(error)
                }
              }
              buffered = Buffer.alloc(0)
              dropping = false
              chunk = chunk.subarray(newline + 1)
            }
          }
          if (!dropping && buffered.byteLength > 0) {
            try {
              await onLine(decoder.decode(buffered))
            } catch (error) {
              throw new LineHandlerError(error)
            }
          }
        } catch (error) {
          if (error instanceof LineHandlerError) throw error.cause
          /* stream closed under us (kill) */
        } finally {
          buffered.fill(0)
          activeReaders.delete(reader)
          reader.releaseLock()
        }
      }
      cancelDrains = async () => {
        await Promise.allSettled(
          [...activeReaders].map(async (reader) => {
            try {
              await reader.cancel()
            } catch {
              /* already closing under SIGKILL */
            }
          }),
        )
      }

      const drainAll = Promise.all([
        readStream(
          child.stdout as ReadableStream<Uint8Array> | undefined,
          async (line) => {
            const terminalError = driver.parseTerminalResultError?.(line)
            if (terminalError != null) resultError = terminalError
            const ev = driver.parseEvent(line)
            if (ev === null) {
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
            if (ev.sessionId !== undefined && sessionId === undefined) {
              sessionId = ev.sessionId
              await setSinkRoot(ev.sessionId)
            }
            if (typeof ev.text === 'string' && ev.text.length > 0) {
              const bytes = Buffer.byteLength(ev.text, 'utf8')
              if (eventTextBytes + bytes <= maxEventTextBytes) {
                eventText += ev.text
                eventTextBytes += bytes
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
          () =>
            failSink(
              'stream-frame-limit-exceeded',
              new Error('stdout frame exceeded the configured byte limit'),
            ),
        ),
        readStream(
          child.stderr as ReadableStream<Uint8Array> | undefined,
          async (line) => {
            const control = activePlan.control
            if (
              opts.onControlLine !== undefined &&
              control !== undefined &&
              control.kind !== 'none'
            ) {
              const handled = await opts.onControlLine({ line, control })
              if (handled.kind === 'session-ready') {
                if (sessionId !== undefined && sessionId !== handled.sessionId) {
                  throw new Error('runtime control/session stream id mismatch')
                }
                sessionId = handled.sessionId
                await setSinkRoot(handled.sessionId)
                return
              }
              line = handled.line
            }
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
          () =>
            failSink(
              'stream-frame-limit-exceeded',
              new Error('stderr frame exceeded the configured byte limit'),
            ),
        ),
      ])
      void drainAll.catch(() => escalate())

      const exitOutcome = await Promise.race([
        child.exited.then(
          (exitCode) => ({ kind: 'exited' as const, exitCode }),
          () => ({ kind: 'unreaped' as const }),
        ),
        reapDeadline,
      ])
      if (exitOutcome.kind === 'unreaped') {
        await settlesWithin(cancelDrains(), CHILD_REAP_DEADLINE_MS)
        return fail('unreaped', { failureCode: 'execution-identity-store-unsafe' })
      }
      childReaped = true
      const exitCode = exitOutcome.exitCode
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      if (sigkillTimer !== null) {
        clearTimeout(sigkillTimer)
        sigkillTimer = null
      }
      if (reapDeadlineTimer !== null) {
        clearTimeout(reapDeadlineTimer)
        reapDeadlineTimer = null
      }
      // Bounded post-exit flush — an inherited-pipe grandchild must not wedge.
      // A timeout is evidence loss, not successful completion: stop the readers
      // before settling the capture so no late append can race its terminal row.
      const drainsFlushed = await settlesWithin(drainAll, CHILD_REAP_DEADLINE_MS)
      if (!drainsFlushed) {
        await settlesWithin(cancelDrains(), CHILD_REAP_DEADLINE_MS)
        await failSink(
          'post-exit-flush-timeout',
          new Error('stdout/stderr did not reach EOF after child exit'),
        )
      }

      const stderrTail = maskDiagnosticsText(stderrText.slice(0, STDERR_TAIL_CAP))
      const launcherFailure =
        plan.diagnostics?.verifiedIdentity === true
          ? parseExecutionIdentityFailureOutput(stderrText)
          : null
      if (launcherFailure !== null) {
        await markSinkTerminal('complete')
        return fail('identity-failed', {
          failureCode: launcherFailure,
          exitCode,
          stderrTail,
        })
      }

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
          ...(plan.sessionStore === undefined
            ? {}
            : { sessionStoreDbPath: plan.sessionStore.dbPath }),
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
      }
      if (aborted) return { status: 'aborted', ...base }
      if (timedOut) return { status: 'timeout', ...base }
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
    if (timer !== null) clearTimeout(timer)
    if (sigkillTimer !== null) clearTimeout(sigkillTimer)
    if (reapDeadlineTimer !== null) clearTimeout(reapDeadlineTimer)
    if (onAbort !== null) opts.abortSignal?.removeEventListener('abort', onAbort)
    const cancelPendingDrains = cancelDrains as (() => Promise<void>) | null
    if (cancelPendingDrains !== null) {
      await settlesWithin(cancelPendingDrains(), CHILD_REAP_DEADLINE_MS)
    }
    const spawnedChild = child as Bun.Subprocess<'ignore' | 'pipe', 'pipe', 'pipe'> | null
    const preparedPlan = plan as SpawnPlan | null
    const wantScratchRemoved =
      result !== undefined && result.status === 'ok' && opts.retainScratchOnSuccess !== true
    const finalized = await finalizeSystemAgentAttempt({
      child: spawnedChild,
      childReaped,
      killChild: (signal) => {
        if (spawnedChild !== null) killGroup(spawnedChild, signal)
      },
      ...(preparedPlan?.cleanup === undefined ? {} : { cleanup: preparedPlan.cleanup }),
      removeScratch: () => rmSync(scratchDir, { recursive: true, force: true }),
      terminationAlreadyExhausted,
      wantScratchRemoved,
    })
    if (!finalized.reaped) {
      result = fail('unreaped', {
        failureCode: 'execution-identity-store-unsafe',
        scratchRetained: true,
      })
    } else if (!finalized.cleanupSucceeded) {
      result = {
        ...(result ?? fail('identity-failed')),
        status: 'identity-failed',
        failureCode: 'execution-identity-store-unsafe',
        scratchRetained: true,
      }
    } else if (result !== undefined) {
      result = { ...result, scratchRetained: !finalized.scratchRemoved }
      if (
        result.status === 'ok' &&
        !finalized.scratchRemoved &&
        opts.retainScratchOnSuccess !== true
      ) {
        // Cleanup barrier failed on a success path: surface it — the store may
        // still be locked; retaining scratch is deliberate (recovery + GC).
        log.warn('system-agent-scratch-retained', {
          feature: opts.feature,
          scratchDir,
        })
      }
    }
  }
  return result ?? fail('spawn-failed', { scratchRetained: true })
}
