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
// a process-group kill escalation on timeout, and temp-dir cleanup on every exit.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { getRuntimeDriver, type RuntimeKind } from '@/services/runtime'
import type { SpawnPlan } from '@/services/runtime/types'
import { createLogger, type Logger } from '@/util/log'

export type SmokeOutcome =
  | 'conforms'
  | 'spawn-failed'
  | 'auth-missing'
  // RFC-116: binary speaks the protocol but the model endpoint is unreachable
  // (403 region block / connection refused/timeout/DNS / missing proxy).
  | 'network-blocked'
  | 'model-call-failed'
  | 'stream-nonconforming'

export interface SmokeResult {
  outcome: SmokeOutcome
  conforms: boolean
  detail: string
  capturedSessionId?: string
  sawNonce: boolean
  sawEnvelope: boolean
  exitCode: number | null
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
}

const MAX_OUTPUT_BYTES = 256 * 1024
const DEFAULT_TIMEOUT_MS = 60_000
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
function buildSmokePlan(
  protocol: RuntimeKind,
  binaryPath: string,
  attemptDir: string,
  prompt: string,
  model: string | undefined,
  bridgeCredentials: boolean,
  log: Logger,
): SpawnPlan {
  return getRuntimeDriver(protocol).buildSpawn({
    agentName: 'aw-smoke',
    systemPrompt: 'You are a runtime smoke-test agent. Follow the user prompt exactly.',
    ...(model !== undefined ? { model } : {}),
    prompt,
    worktreePath: attemptDir,
    runDir: attemptDir,
    runtimeBinary: binaryPath,
    bridgeCredentials,
    log,
  })
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

  let child: Bun.Subprocess<'ignore' | 'pipe', 'pipe', 'pipe'> | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let sigkillTimer: ReturnType<typeof setTimeout> | null = null
  let timedOut = false
  try {
    let plan: SpawnPlan
    try {
      plan = buildSmokePlan(
        opts.protocol,
        opts.binaryPath,
        attemptDir,
        prompt,
        opts.model,
        opts.bridgeCredentials === true,
        log,
      )
    } catch (err) {
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
        cmd: plan.cmd,
        cwd: attemptDir,
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
    timer = setTimeout(() => {
      timedOut = true
      killGroup(liveChild, 'SIGTERM')
      // Codex P2: track the SIGKILL escalation timer so finally can clear it —
      // an untracked one could fire after cleanup and keep the loop alive 2s.
      sigkillTimer = setTimeout(() => killGroup(liveChild, 'SIGKILL'), 2_000)
      sigkillTimer.unref?.()
    }, timeoutMs)
    timer.unref?.()

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

    const readStream = async (
      stream: ReadableStream<Uint8Array> | undefined,
      onLine: (line: string) => void,
    ): Promise<void> => {
      if (stream === undefined) return
      const reader = stream.getReader()
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
        reader.releaseLock()
      }
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

    const exitCode = await child.exited
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    if (sigkillTimer !== null) {
      clearTimeout(sigkillTimer)
      sigkillTimer = null
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
    const conformed = !timedOut && exitCode === 0 && sawEvent && sessionId !== undefined && sawNonce

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
      detail = 'binary started but authentication failed (may still conform once credentials exist)'
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
  } finally {
    if (timer !== null) clearTimeout(timer)
    if (sigkillTimer !== null) clearTimeout(sigkillTimer)
    if (child !== null) {
      killGroup(child, 'SIGKILL')
    }
    try {
      rmSync(attemptDir, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  }
}
