// RFC-112 PR-B — deep-smoke conformance probe. Given a (protocol, binaryPath),
// run ONE minimal real call through that protocol's driver against the binary
// and verify it speaks the protocol end-to-end: emits a parseable stream of the
// driver's events, captures a session id, and — proving it actually consumed the
// prompt and ran a model turn — echoes back a freshly-generated nonce. This is
// the conformance signal (D2: fork version strings are unreliable, so we never
// probe `--version`). Auth / quota / model failures are CLASSIFIED separately
// (Codex P2) so a conforming fork that merely lacks credentials isn't rejected.
//
// Lifecycle is fully self-contained (NOT runNode — no DB rows / worktree): a
// throwaway temp cwd, a try/finally that drains stdout+stderr under a byte cap,
// and a bounded process-group TERM→KILL→reap sequence. Temp/store deletion occurs
// only after reap and plan cleanup are both confirmed; unsafe remnants are
// deliberately retained for recovery instead of recursively deleted.

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { getRuntimeDriver, type RuntimeKind } from '@/services/runtime'
import type { SpawnPlan } from '@/services/runtime/types'
import { getSandboxProvider, wrapSandbox, type SandboxCtx } from '@/services/sandbox'
import { createLogger, type Logger } from '@/util/log'
import {
  isExecutionIdentityFailureCode,
  type ExecutionIdentityFailureCode,
} from '@agent-workflow/shared'
import { parseExecutionIdentityFailureOutput } from '@/services/runtime/opencode/failure'

export type SmokeOutcome =
  | 'conforms'
  | 'spawn-failed'
  | 'auth-missing'
  // RFC-116: binary speaks the protocol but the model endpoint is unreachable
  // (403 region block / connection refused/timeout/DNS / missing proxy).
  | 'network-blocked'
  | 'model-call-failed'
  | 'stream-nonconforming'
  | 'execution-identity-failed'

export interface SmokeResult {
  outcome: SmokeOutcome
  conforms: boolean
  detail: string
  capturedSessionId?: string
  sawNonce: boolean
  sawEnvelope: boolean
  exitCode: number | null
  failureCode?: ExecutionIdentityFailureCode
}

export interface SmokeOptions {
  protocol: RuntimeKind
  binaryPath: string
  config?: { opencodePath?: string | null; claudeCodePath?: string | null }
  model?: string
  timeoutMs?: number
  /**
   * Bridge the claude subscription credential into the temp config dir (real
   * runs). Tests pass false (mock-claude) so CI never touches the keychain. No
   * effect for the opencode protocol.
   */
  bridgeCredentials?: boolean
  log?: Logger
  /** Explicit dependency-injection seam for legacy mock-binary tests. */
  testOnlyUnverifiedRuntime?: boolean
}

const MAX_OUTPUT_BYTES = 256 * 1024
const DEFAULT_TIMEOUT_MS = 60_000
const CHILD_TERM_GRACE_MS = 2_000
const CHILD_REAP_DEADLINE_MS = 2_000
const AUTH_SIGNATURES =
  /not logged in|unauthorized|authentication|invalid api key|please run .*login|no api key|anthropic_api_key|log ?in to/i
const MODEL_FAIL_SIGNATURES =
  /rate limit|overloaded|quota|model .*not found|insufficient|too many requests|503|529/i
// RFC-116: endpoint reachability failures — the binary speaks the protocol but the
// request to the model API is refused/unreachable: 403 region block, connection
// refused/reset/timeout, DNS failure, no route, broken proxy tunnel. Checked BEFORE
// auth (see the classifier): claude's region-block text is "Failed to authenticate.
// API Error: 403 Request not allowed" — it carries the auth word too, but the root
// cause is the network.
// Codex impl-gate P2: bare `proxy` / `request not allowed` are deliberately NOT
// matched — they show up in generic auth/model error guidance too, and matching them
// before authHit would mis-route credential failures to networking. Every alternative
// below is an explicit connectivity signal (403-region phrase / *nix errno / DNS /
// fetch-failed / tunnel), so it can safely win over authHit.
const NETWORK_SIGNATURES =
  /403 request not allowed|not available in your (?:region|country|location)|fetch failed|network error|connection (?:error|refused|reset|timed ?out)|econnrefused|econnreset|econnaborted|enetunreach|ehostunreach|enetdown|enotfound|etimedout|eai_again|getaddrinfo|socket hang up|no route to host|network is unreachable|tunneling socket|unable to connect|could not connect|failed to connect/i

/** kill the whole process group (the child is `detached`), best-effort. */
function killGroup(child: Bun.Subprocess, signal: 'SIGTERM' | 'SIGKILL'): void {
  try {
    if (typeof child.pid === 'number') process.kill(-child.pid, signal)
    else child.kill(signal === 'SIGKILL' ? 9 : 15)
  } catch {
    /* already gone */
  }
}

type SmokeReapTarget = {
  exited: Promise<number>
  unref?: () => void
}

async function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      promise.then(
        () => true,
        () => false,
      ),
      new Promise<false>((resolve) => {
        timeoutHandle = setTimeout(() => resolve(false), timeoutMs)
        timeoutHandle.unref?.()
      }),
    ])
  } finally {
    if (timeoutHandle !== null) clearTimeout(timeoutHandle)
  }
}

/**
 * RFC-224 system-store destruction barrier.
 *
 * A plan cleanup may remove a store whose launcher still owns its lock, while
 * removing attemptDir can also erase the launcher's run/config inputs. Neither
 * is safe until the direct launcher is observably reaped. Cleanup failure is a
 * second hard barrier: preserve the outer attempt directory for recovery and
 * diagnostics instead of continuing with a recursive delete.
 *
 * Exported so the never-settling-child and live-lock branches can be tested
 * without launching an actually unkillable process.
 */
export async function finalizeSmokeAttempt(input: {
  child: SmokeReapTarget | null
  childReaped: boolean
  killChild: (signal: 'SIGTERM' | 'SIGKILL') => void
  cleanup?: () => void | Promise<void>
  removeAttemptDir: () => void | Promise<void>
  termGraceMs?: number
  reapDeadlineMs?: number
  terminationAlreadyExhausted?: boolean
}): Promise<boolean> {
  let reaped = input.child === null || input.childReaped
  if (input.child !== null) {
    if (!reaped && input.terminationAlreadyExhausted !== true) {
      input.killChild('SIGTERM')
      reaped = await settlesWithin(input.child.exited, input.termGraceMs ?? CHILD_TERM_GRACE_MS)
    }
    if (!reaped) {
      input.killChild('SIGKILL')
      reaped = await settlesWithin(
        input.child.exited,
        input.reapDeadlineMs ?? CHILD_REAP_DEADLINE_MS,
      )
    } else {
      // The direct child may have exited while a same-group descendant still
      // owns inherited pipes or the private store. Reap that group before
      // crossing the cleanup barrier.
      input.killChild('SIGKILL')
    }
    if (!reaped) {
      input.child.unref?.()
      return false
    }
  }

  try {
    await input.cleanup?.()
  } catch {
    return false
  }
  try {
    await input.removeAttemptDir()
  } catch {
    return false
  }
  return true
}

/**
 * Build the protocol's minimal smoke spawn plan (binary head = [binaryPath]).
 * RFC-143 PR-4: the smoke IS a system agent (one persona, no skills / mcp /
 * plugins / inventory), so it routes through `driver.buildSpawn` instead of
 * hand-assembling per-protocol argv here — the second spawn-assembly site is
 * gone and a third runtime's probe needs zero smoke changes.
 *
 * runDir = attemptDir: the config dir must EXIST before spawn (opencode 1.17+
 * writes a `.gitignore` into OPENCODE_CONFIG_DIR on startup and exits 1 when
 * it's missing — locked by runtime-smoke.test.ts). mkdtempSync created
 * attemptDir, so the contract holds without a protocol-specific mkdir; claude
 * treats it as the attempt dir and creates `.claude/` under it as before.
 */
async function buildSmokePlan(
  protocol: RuntimeKind,
  binaryPath: string,
  worktreeDir: string,
  runDir: string,
  prompt: string,
  model: string | undefined,
  bridgeCredentials: boolean,
  log: Logger,
  testOnlyUnverifiedRuntime: boolean,
): Promise<SpawnPlan> {
  const provider = getSandboxProvider()
  return getRuntimeDriver(protocol).buildSpawn({
    agentName: 'aw-smoke',
    systemPrompt: 'You are a runtime smoke-test agent. Follow the user prompt exactly.',
    ...(model !== undefined ? { model } : {}),
    prompt,
    worktreePath: worktreeDir,
    runDir,
    ...(provider === null ? {} : { appHome: provider.appHome }),
    runtimeBinary: binaryPath,
    bridgeCredentials,
    log,
    ...(testOnlyUnverifiedRuntime ? { testOnlyUnverifiedRuntime: true } : {}),
  })
}

export function smokeSandboxCtx(
  worktreeDir: string,
  runDir: string,
  plan: SpawnPlan,
): SandboxCtx | undefined {
  const provider = getSandboxProvider()
  if (provider === null) return undefined
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

function identityFailureCode(error: unknown): ExecutionIdentityFailureCode | null {
  if (error === null || typeof error !== 'object') return null
  const code = (error as { code?: unknown }).code
  return isExecutionIdentityFailureCode(code) ? code : null
}

/**
 * Run one minimal call against `binaryPath` via the `protocol` driver and
 * classify whether it conforms. Never throws — a spawn failure becomes a
 * `spawn-failed` result.
 */
export async function smokeRuntime(opts: SmokeOptions): Promise<SmokeResult> {
  const log = opts.log ?? createLogger('runtimeSmoke')
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const driver = getRuntimeDriver(opts.protocol)
  const nonce = `awsmoke-${randomBytes(8).toString('hex')}`
  const prompt =
    `Output this exact token verbatim via your output protocol and nothing else: ${nonce}\n` +
    `Use the \`ok\` output port (or plain text if you have no ports).`
  const attemptDir = mkdtempSync(join(tmpdir(), 'aw-runtime-smoke-'))
  const worktreeDir = join(attemptDir, 'worktree')
  const runDir = join(attemptDir, 'run')
  mkdirSync(worktreeDir, { recursive: true, mode: 0o700 })
  mkdirSync(runDir, { recursive: true, mode: 0o700 })

  let child: Bun.Subprocess<'ignore' | 'pipe', 'pipe', 'pipe'> | null = null
  let plan: SpawnPlan | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let sigkillTimer: ReturnType<typeof setTimeout> | null = null
  let reapDeadlineTimer: ReturnType<typeof setTimeout> | null = null
  let timedOut = false
  let childReaped = false
  let terminationAlreadyExhausted = false
  let cancelDrains: (() => Promise<void>) | null = null
  let result: SmokeResult | undefined
  let finalizationSafe = false
  try {
    result = await (async (): Promise<SmokeResult> => {
      try {
        plan = await buildSmokePlan(
          opts.protocol,
          opts.binaryPath,
          worktreeDir,
          runDir,
          prompt,
          opts.model,
          opts.bridgeCredentials === true,
          log,
          opts.testOnlyUnverifiedRuntime === true,
        )
      } catch (err) {
        const failureCode = identityFailureCode(err)
        if (failureCode !== null) {
          return {
            outcome: 'execution-identity-failed',
            conforms: false,
            detail: failureCode,
            failureCode,
            sawNonce: false,
            sawEnvelope: false,
            exitCode: null,
          }
        }
        return {
          outcome: 'spawn-failed',
          conforms: false,
          detail: `failed to prepare spawn: ${err instanceof Error ? err.message : String(err)}`,
          sawNonce: false,
          sawEnvelope: false,
          exitCode: null,
        }
      }

      try {
        child = Bun.spawn({
          cmd: wrapSandbox(plan.cmd, smokeSandboxCtx(worktreeDir, runDir, plan)),
          cwd: worktreeDir,
          env: plan.env,
          stdout: 'pipe',
          stderr: 'pipe',
          stdin: plan.stdin?.mode === 'pipe' ? 'pipe' : 'ignore',
          detached: true,
        })
      } catch (err) {
        return {
          outcome: 'spawn-failed',
          conforms: false,
          detail: `binary failed to start: ${err instanceof Error ? err.message : String(err)}`,
          sawNonce: false,
          sawEnvelope: false,
          exitCode: null,
        }
      }

      // deliver the prompt over stdin (claude) and close it.
      if (plan.stdin?.mode === 'pipe') {
        const sink = child.stdin as { write: (s: string) => void; end: () => void } | undefined
        if (sink !== undefined) {
          sink.write(plan.stdin.data)
          sink.end()
        }
      }

      const liveChild = child
      const reapDeadline = new Promise<{ kind: 'unreaped' }>((resolve) => {
        timer = setTimeout(() => {
          timedOut = true
          killGroup(liveChild, 'SIGTERM')
          // Track both escalation timers: the first sends SIGKILL, the second
          // turns a never-settling `child.exited` into a bounded unsafe result.
          sigkillTimer = setTimeout(() => {
            killGroup(liveChild, 'SIGKILL')
            reapDeadlineTimer = setTimeout(() => {
              terminationAlreadyExhausted = true
              resolve({ kind: 'unreaped' })
            }, CHILD_REAP_DEADLINE_MS)
            reapDeadlineTimer.unref?.()
          }, CHILD_TERM_GRACE_MS)
          sigkillTimer.unref?.()
        }, timeoutMs)
        timer.unref?.()
      })

      // drain stdout (parse events) + stderr (auth/model signatures), both capped.
      let sessionId: string | undefined
      let sawEvent = false
      let sawNonce = false
      let sawEnvelope = false
      let outBytes = 0
      let stderrText = ''
      // claude reports auth / API / network errors on STDOUT (the stream-json `result`
      // event carries `is_error` + e.g. "Failed to authenticate. API Error: 403 Request
      // not allowed"), not stderr. Accumulate stdout too so the network/auth/model
      // classifier sees those — else a reachable-but-unauthenticated, or (RFC-116)
      // proxy/region-blocked, claude misclassifies as `stream-nonconforming` when it
      // actually spoke the protocol fine and just couldn't reach/authenticate the API.
      let stdoutText = ''
      const activeReaders = new Set<{ cancel: () => Promise<void> | void }>()

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
            if (outBytes >= MAX_OUTPUT_BYTES) continue // keep draining to EOF, stop accumulating
            outBytes += value.byteLength
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
              // The stream may already be closing under SIGKILL.
            }
          }),
        )
      }

      // Codex P2: the nonce + envelope are detected ONLY in PARSED event text —
      // proving the model produced them THROUGH the protocol stream, not on a raw
      // stdout line a non-protocol binary could also print. drainAll runs
      // concurrently; the timeout timer kills the child if it overruns.
      const drainAll = Promise.all([
        readStream(child.stdout as ReadableStream<Uint8Array> | undefined, (line) => {
          // raw line (capped) feeds the auth/model classifier — claude's error is
          // here, not on stderr (see stdoutText decl).
          if (stdoutText.length < 8_192) stdoutText += line + '\n'
          const ev = driver.parseEvent(line)
          if (ev !== null) {
            sawEvent = true
            if (ev.sessionId !== undefined && sessionId === undefined) sessionId = ev.sessionId
            if (typeof ev.text === 'string') {
              if (ev.text.includes(nonce)) sawNonce = true
              if (ev.text.includes('<workflow-output')) sawEnvelope = true
            }
          }
        }),
        readStream(child.stderr as ReadableStream<Uint8Array> | undefined, (line) => {
          if (stderrText.length < 8_192) stderrText += line + '\n'
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
        return {
          outcome: 'execution-identity-failed',
          conforms: false,
          detail: 'execution-identity-store-unsafe',
          failureCode: 'execution-identity-store-unsafe',
          sawNonce: false,
          sawEnvelope: false,
          exitCode: null,
        }
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
      // Codex P2: bounded post-exit flush — a grandchild that inherited the stdout
      // pipe must not wedge the probe; classify on whatever drained within 2s.
      await Promise.race([
        drainAll,
        new Promise<void>((resolve) => {
          const g = setTimeout(resolve, 2_000)
          g.unref?.()
        }),
      ])

      // Scan BOTH streams: claude's auth/API errors land on stdout, opencode's on
      // stderr. Only consulted when the run didn't conform, so a healthy nonce echo
      // never trips a false auth/model hit.
      const haystack = `${stderrText}\n${stdoutText}`.toLowerCase()
      // RFC-116: networkHit is evaluated BEFORE authHit (see the if-chain). claude's
      // region/proxy block reads "Failed to authenticate. API Error: 403 Request not
      // allowed" — it carries the auth word AND the 403/network signal, but the root
      // cause is endpoint reachability (e.g. daemon lacks HTTP(S)_PROXY), not creds.
      const networkHit = NETWORK_SIGNATURES.test(haystack)
      const authHit = AUTH_SIGNATURES.test(haystack)
      const modelHit = MODEL_FAIL_SIGNATURES.test(haystack)
      // Codex P2: conformance REQUIRES the nonce round-trip (a real protocol turn
      // consumed the prompt) — sawEnvelope alone is too weak (a canned emitter).
      const conformed =
        !timedOut && exitCode === 0 && sawEvent && sessionId !== undefined && sawNonce
      const launcherFailure =
        plan.diagnostics?.verifiedIdentity === true
          ? parseExecutionIdentityFailureOutput(stderrText)
          : null
      if (launcherFailure !== null) {
        return {
          outcome: 'execution-identity-failed',
          conforms: false,
          detail: launcherFailure,
          failureCode: launcherFailure,
          sawNonce: false,
          sawEnvelope: false,
          exitCode,
        }
      }

      let outcome: SmokeOutcome
      let detail: string
      if (conformed) {
        outcome = 'conforms'
        detail = `binary speaks the ${opts.protocol} protocol (session captured, nonce echoed)`
      } else if (timedOut) {
        outcome = 'model-call-failed'
        detail = `timed out after ${timeoutMs}ms`
      } else if (networkHit) {
        outcome = 'network-blocked'
        detail =
          'binary started but the model endpoint is unreachable (e.g. 403 Request not allowed / connection failed). Check the daemon network/proxy (HTTP(S)_PROXY) so it can reach the model API, then re-probe.'
      } else if (authHit) {
        outcome = 'auth-missing'
        detail =
          'binary started but authentication failed (may still conform once credentials exist)'
      } else if (modelHit) {
        outcome = 'model-call-failed'
        detail = 'binary started + authed but the model call failed (rate limit / unavailable)'
      } else if (!sawEvent) {
        outcome = 'stream-nonconforming'
        detail = `no parseable ${opts.protocol} events on stdout (exit ${exitCode})`
      } else {
        outcome = 'stream-nonconforming'
        detail = `emitted events but did not complete the protocol turn (exit ${exitCode}, nonce ${
          sawNonce ? 'seen' : 'missing'
        })`
      }

      return {
        outcome,
        conforms: outcome === 'conforms',
        detail,
        ...(sessionId !== undefined ? { capturedSessionId: sessionId } : {}),
        sawNonce,
        sawEnvelope,
        exitCode,
      }
    })()
  } finally {
    if (timer !== null) clearTimeout(timer)
    if (sigkillTimer !== null) clearTimeout(sigkillTimer)
    if (reapDeadlineTimer !== null) clearTimeout(reapDeadlineTimer)
    const cancelPendingDrains = cancelDrains as (() => Promise<void>) | null
    if (cancelPendingDrains !== null) {
      await settlesWithin(cancelPendingDrains(), CHILD_REAP_DEADLINE_MS)
    }
    // Assignments happen inside the awaited attempt closure; keep the cleanup
    // reads explicit because TypeScript does not propagate closure writes into
    // outer control-flow narrowing.
    const spawnedChild = child as Bun.Subprocess<'ignore' | 'pipe', 'pipe', 'pipe'> | null
    const preparedPlan = plan as SpawnPlan | null
    finalizationSafe = await finalizeSmokeAttempt({
      child: spawnedChild,
      childReaped,
      killChild: (signal) => {
        if (spawnedChild !== null) killGroup(spawnedChild, signal)
      },
      ...(preparedPlan?.cleanup === undefined ? {} : { cleanup: preparedPlan.cleanup }),
      removeAttemptDir: () => rmSync(attemptDir, { recursive: true, force: true }),
      terminationAlreadyExhausted,
    })
  }
  if (!finalizationSafe || result === undefined) {
    return {
      outcome: 'execution-identity-failed',
      conforms: false,
      detail: 'execution-identity-store-unsafe',
      failureCode: 'execution-identity-store-unsafe',
      sawNonce: false,
      sawEnvelope: false,
      exitCode: null,
    }
  }
  return result
}
