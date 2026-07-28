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
import { randomBytes } from 'node:crypto'
import { getRuntimeDriver, type RuntimeKind } from '@/services/runtime'
import type { SpawnPlan, SystemPermissionProfile } from '@/services/runtime/types'
import {
  wrapSpawnPlanSandbox,
  type ContainmentCoordinator,
  type PreparedContainmentPlan,
  type SandboxCtx,
} from '@/services/sandbox'
import { createLogger, type Logger } from '@/util/log'
import {
  isExecutionIdentityFailureCode,
  maskDiagnosticsText,
  type ExecutionIdentityFailureCode,
} from '@agent-workflow/shared'
import { parseExecutionIdentityFailureOutput } from '@/services/runtime/opencode/failure'

const DEFAULT_TIMEOUT_MS = 600_000
const DEFAULT_MAX_EVENT_TEXT_BYTES = 8 * 1024 * 1024
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
  abortSignal?: AbortSignal
  bridgeCredentials?: boolean
  log?: Logger
  /** Explicit dependency-injection seam for legacy mock-binary tests. */
  testOnlyUnverifiedRuntime?: boolean
  /** Branded production command head (see SystemAgentSpawnContext.opencodeCmd). */
  opencodeCmd?: readonly string[]
}

export type SystemAgentRunStatus =
  | 'ok'
  | 'spawn-failed'
  | 'timeout'
  | 'aborted'
  | 'exit-nonzero'
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
  const abs = resolve(worktreeDir, relPath)
  if (abs !== worktreeDir && !abs.startsWith(`${worktreeDir}/`)) {
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
}): Promise<{ reaped: boolean; scratchRemoved: boolean }> {
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
      return { reaped: false, scratchRemoved: false }
    }
  }
  try {
    await input.cleanup?.()
  } catch {
    return { reaped: true, scratchRemoved: false }
  }
  if (!input.wantScratchRemoved) return { reaped: true, scratchRemoved: false }
  try {
    input.removeScratch()
  } catch {
    return { reaped: true, scratchRemoved: false }
  }
  return { reaped: true, scratchRemoved: true }
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
      preparedContainment = await opts.containmentCoordinator.admit('runner-filesystem-v1')
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

  try {
    result = await (async (): Promise<SystemAgentRunResult> => {
      try {
        plan = await driver.buildSpawn({
          agentName: opts.agentName,
          systemPrompt: opts.systemPrompt,
          ...(opts.model != null && opts.model !== '' ? { model: opts.model } : {}),
          prompt: opts.prompt,
          worktreePath: worktreeDir,
          runDir,
          ...(preparedContainment === undefined
            ? {}
            : { appHome: preparedContainment.sandbox.appHome, containment: preparedContainment }),
          ...(opts.runtimeBinary != null && opts.runtimeBinary !== ''
            ? { runtimeBinary: opts.runtimeBinary }
            : {}),
          ...(opts.bridgeCredentials !== undefined
            ? { bridgeCredentials: opts.bridgeCredentials }
            : {}),
          log,
          ...(opts.testOnlyUnverifiedRuntime === true ? { testOnlyUnverifiedRuntime: true } : {}),
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

      try {
        child = Bun.spawn({
          cmd: wrapSpawnPlanSandbox(
            plan.cmd,
            systemSandboxCtx(worktreeDir, runDir, plan),
            plan.sandboxTopology,
          ),
          cwd: worktreeDir,
          env: plan.env,
          stdout: 'pipe',
          stderr: 'pipe',
          stdin: plan.stdin?.mode === 'pipe' ? 'pipe' : 'ignore',
          detached: true,
        })
      } catch (err) {
        return fail('spawn-failed', {
          stderrTail: maskDiagnosticsText(
            `binary failed to start: ${err instanceof Error ? err.message : String(err)}`,
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
      const escalate = (): void => {
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
      const activeReaders = new Set<{
        cancel: () => Promise<void> | void
        releaseLock?: () => void
      }>()

      const readStream = async (
        stream: ReadableStream<Uint8Array> | undefined,
        onLine: (line: string) => void,
      ): Promise<void> => {
        if (stream === undefined) return
        const reader = stream.getReader()
        activeReaders.add(reader)
        const decoder = new TextDecoder()
        let buf = ''
        try {
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            buf += decoder.decode(value, { stream: true })
            let nl: number
            while ((nl = buf.indexOf('\n')) >= 0) {
              const line = buf.slice(0, nl)
              buf = buf.slice(nl + 1)
              if (line.length > 0) onLine(line)
            }
          }
          if (buf.length > 0) onLine(buf)
        } catch {
          /* stream closed under us (kill) */
        } finally {
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
        readStream(child.stdout as ReadableStream<Uint8Array> | undefined, (line) => {
          const ev = driver.parseEvent(line)
          if (ev === null) return
          if (ev.sessionId !== undefined && sessionId === undefined) sessionId = ev.sessionId
          if (typeof ev.text === 'string' && ev.text.length > 0) {
            if (eventTextBytes < maxEventTextBytes) {
              eventText += ev.text
              eventTextBytes += ev.text.length
            }
          }
        }),
        readStream(child.stderr as ReadableStream<Uint8Array> | undefined, (line) => {
          if (stderrText.length < STDERR_TAIL_CAP) stderrText += line + '\n'
        }),
      ])

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
      await Promise.race([
        drainAll,
        new Promise<void>((resolveRace) => {
          const g = setTimeout(resolveRace, 2_000)
          g.unref?.()
        }),
      ])

      const stderrTail = maskDiagnosticsText(stderrText.slice(0, STDERR_TAIL_CAP))
      const launcherFailure =
        plan.diagnostics?.verifiedIdentity === true
          ? parseExecutionIdentityFailureOutput(stderrText)
          : null
      if (launcherFailure !== null) {
        return fail('identity-failed', {
          failureCode: launcherFailure,
          exitCode,
          stderrTail,
        })
      }

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
      return { status: 'ok', ...base }
    })()
  } finally {
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
    const wantScratchRemoved = result !== undefined && result.status === 'ok'
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
    } else if (result !== undefined) {
      result = { ...result, scratchRetained: !finalized.scratchRemoved }
      if (result.status === 'ok' && !finalized.scratchRemoved) {
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
