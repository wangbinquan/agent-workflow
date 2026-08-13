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

import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { getRuntimeDriver, type RuntimeKind } from '@/services/runtime'
import type { SpawnPlan } from '@/services/runtime/types'
import { createLogger, type Logger } from '@/util/log'
import { maskDiagnosticsText } from '@agent-workflow/shared'
import { outputTail } from '@/util/spawnDiagnostics'
import { runAgentProcess } from '@/services/execution/agentProcess'
import { Paths } from '@/util/paths'

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
  /** RFC-254: a string is the binary path (production); an array is a full spawn
   *  command head (`[bun, run, mock]`) — used by Windows tests where a single-file
   *  `.sh`/`.cmd` wrapper cannot stream the protocol. Routed to the driver's
   *  command-array seam (opencodeCmd / runtimeCmd), not runtimeBinary. */
  binaryPath: string | readonly string[]
  config?: { opencodePath?: string | null; claudeCodePath?: string | null }
  model?: string
  /** 2026-08-04 — the runtime row's extraArgs, so a probe reproduces the exact
   *  argv a dispatch would use (fork flags like `--skip-safe-check`). */
  extraArgs?: readonly string[]
  /** RFC-276: reproduce the runtime profile's optional Claude CLI marker. */
  isSandbox?: boolean
  timeoutMs?: number
  log?: Logger
}

const MAX_OUTPUT_BYTES = 256 * 1024
const DEFAULT_TIMEOUT_MS = 60_000
const CHILD_TERM_GRACE_MS = 2_000
const AUTH_SIGNATURES =
  /not logged in|unauthorized|authentication|invalid api key|please run .*login|no api key|anthropic_api_key|log ?in to/i
// 2026-08-04 (GLM-gateway incident): private Anthropic/OpenAI-compatible
// gateways report "model not licensed for this account" in vendor wording —
// observed live: "您暂无该模型的使用权限，请联系产品FSE开通或使用其它模型
// 【TM.00001005】". Cover both CJK orders (暂无/无权…模型 and 模型…权限) plus
// the OpenAI-style English phrase, so these land as model-call-failed instead
// of the bare stream-nonconforming fallback.
const MODEL_FAIL_SIGNATURES =
  /rate limit|overloaded|quota|model .*not found|insufficient|too many requests|503|529|does not have access to model|(?:暂无|无权).{0,10}模型|模型.{0,12}权限/i
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
 * only writes its generated system prompt there (since RFC-276 it gets no
 * platform-owned config dir at all — it reads the operator's own).
 */
async function buildSmokePlan(
  protocol: RuntimeKind,
  binaryPath: string | readonly string[],
  worktreeDir: string,
  runDir: string,
  prompt: string,
  model: string | undefined,
  extraArgs: readonly string[] | undefined,
  isSandbox: boolean,
  log: Logger,
): Promise<SpawnPlan> {
  const driver = getRuntimeDriver(protocol)
  // RFC-282 B1b — unified persona-only assembly. RFC-254: an array binaryPath
  // is a full command head → the runtime-neutral binaryOverride (each driver
  // maps it onto its own seam); a string stays the plain runtimeBinary.
  return driver.buildSpawn({
    injection: { mcps: [] },
    prompt,
    agentName: 'aw-smoke',
    systemPrompt: 'You are a runtime smoke-test agent. Follow the user prompt exactly.',
    resolvedParamsByAgent: new Map([
      [
        'aw-smoke',
        {
          model: model ?? null,
          variant: null,
          temperature: null,
          steps: null,
          maxSteps: null,
          isSandbox,
        },
      ],
    ]),
    cwd: worktreeDir,
    runRoot: runDir,
    freshAgentRun: false,
    ...(extraArgs !== undefined && extraArgs.length > 0 ? { extraArgs } : {}),
    ...(typeof binaryPath === 'string'
      ? { runtimeBinary: binaryPath }
      : { binaryOverride: binaryPath }),
    nodeRunId: 'runtime-smoke',
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
  // RFC-280 T4/T5（落差⑤）：appHome scratch，不再 OS tmpdir —— GC 归属确定，
  // 与 systemAgentRun 的 scratch 策略一致。
  const attemptDir = join(Paths.root, 'scratch', `runtime-smoke-${randomBytes(8).toString('hex')}`)
  const worktreeDir = join(attemptDir, 'worktree')
  const runDir = join(attemptDir, 'run')
  mkdirSync(worktreeDir, { recursive: true, mode: 0o700 })
  mkdirSync(runDir, { recursive: true, mode: 0o700 })

  let plan: SpawnPlan
  try {
    plan = await buildSmokePlan(
      opts.protocol,
      opts.binaryPath,
      worktreeDir,
      runDir,
      prompt,
      opts.model,
      opts.extraArgs,
      opts.isSandbox === true,
      log,
    )
  } catch (err) {
    rmSync(attemptDir, { recursive: true, force: true })
    return {
      outcome: 'spawn-failed',
      conforms: false,
      detail: `failed to prepare spawn: ${err instanceof Error ? err.message : String(err)}`,
      sawNonce: false,
      sawEnvelope: false,
      exitCode: null,
    }
  }

  // Classification accumulators — fed by the executor's line callbacks.
  let sessionId: string | undefined
  let pendingConversationReset: { outgoingSessionId: string; newConversationId: string } | undefined
  let nativeSessionProtocolInvalid = false
  let sawEvent = false
  let sawNonce = false
  let sawEnvelope = false
  let outBytes = 0
  let stderrText = ''
  // claude reports auth / API / network errors on STDOUT (the stream-json `result`
  // event carries `is_error` + e.g. "Failed to authenticate. API Error: 403 Request
  // not allowed"), not stderr. Accumulate stdout too so the network/auth/model
  // classifier sees those.
  let stdoutText = ''
  // The terminal `result` event puts the error text NEAR THE HEAD of the line;
  // keep the LAST result-shaped line so the evidence can quote its head.
  let lastResultLine = ''

  // RFC-280 T4 — process reliability is the unified executor's job
  // (managedProcess adapter): spawn/stdin/timeout/TERM→KILL/reap/drain all live
  // there; this probe only classifies what came back.
  const run = await runAgentProcess({
    cmd: plan.cmd,
    cwd: worktreeDir,
    env: plan.env,
    timeoutMs,
    termGraceMs: CHILD_TERM_GRACE_MS,
    ...(plan.stdin?.mode === 'pipe' ? { stdin: plan.stdin } : {}),
    ...(plan.beforeSpawn !== undefined ? { beforeSpawn: plan.beforeSpawn } : {}),
    ...(plan.cleanup !== undefined ? { cleanup: plan.cleanup } : {}),
    capture: {
      onStdoutLine: (line) => {
        if (outBytes >= MAX_OUTPUT_BYTES) return
        outBytes += Buffer.byteLength(line, 'utf8') + 1
        // raw line (capped) feeds the auth/model classifier — claude's error is
        // here, not on stderr (see stdoutText decl).
        if (stdoutText.length < 8_192) stdoutText += line + '\n'
        if (line.includes('"type":"result"') || line.includes('"is_error":true')) {
          lastResultLine = line
        }
        const ev = driver.parseEvent(line)
        if (ev !== null) {
          sawEvent = true
          if (ev.sessionId !== undefined) {
            if (sessionId === undefined) {
              sessionId = ev.sessionId
            } else if (
              ev.sessionId !== sessionId &&
              pendingConversationReset?.outgoingSessionId === sessionId
            ) {
              sessionId = ev.sessionId
              pendingConversationReset = undefined
            } else if (ev.sessionId !== sessionId) {
              nativeSessionProtocolInvalid = true
            }
          }
          if (ev.conversationReset !== undefined) {
            if (
              sessionId === undefined ||
              ev.conversationReset.outgoingSessionId !== sessionId ||
              pendingConversationReset !== undefined
            ) {
              nativeSessionProtocolInvalid = true
            } else {
              pendingConversationReset = ev.conversationReset
            }
          }
          if (typeof ev.text === 'string') {
            if (ev.text.includes(nonce)) sawNonce = true
            if (ev.text.includes('<workflow-output')) sawEnvelope = true
          }
        }
      },
      onStderrLine: (line) => {
        if (stderrText.length < 8_192) stderrText += line + '\n'
      },
    },
    log,
  })

  if (run.outcome === 'spawn-failed') {
    rmSync(attemptDir, { recursive: true, force: true })
    return {
      outcome: 'spawn-failed',
      conforms: false,
      detail: `binary failed to start: ${run.spawnError ?? 'unknown spawn failure'}`,
      sawNonce: false,
      sawEnvelope: false,
      exitCode: null,
    }
  }
  if (run.outcome === 'unreaped') {
    // Child may still own the attempt dir — retain it (reap-then-cleanup barrier).
    return {
      outcome: 'spawn-failed',
      conforms: false,
      detail: 'runtime process could not be reaped after termination',
      sawNonce: false,
      sawEnvelope: false,
      exitCode: null,
    }
  }
  if (run.cleanupFailed === true) {
    return {
      outcome: 'spawn-failed',
      conforms: false,
      detail: 'runtime process cleanup did not complete safely',
      sawNonce: false,
      sawEnvelope: false,
      exitCode: null,
    }
  }

  const timedOut = run.outcome === 'timeout'
  const exitCode = run.exitCode

  // Scan BOTH streams: claude's auth/API errors land on stdout, opencode's on
  // stderr. Only consulted when the run didn't conform, so a healthy nonce echo
  // never trips a false auth/model hit.
  const haystack = `${stderrText}\n${stdoutText}`.toLowerCase()
  // RFC-116: networkHit is evaluated BEFORE authHit (see the if-chain). claude's
  // region/proxy block reads "Failed to authenticate. API Error: 403 Request not
  // allowed" — it carries the auth word AND the 403/network signal, but the root
  // cause is endpoint reachability, not creds.
  const networkHit = NETWORK_SIGNATURES.test(haystack)
  const authHit = AUTH_SIGNATURES.test(haystack)
  const modelHit = MODEL_FAIL_SIGNATURES.test(haystack)
  // Codex P2: conformance REQUIRES the nonce round-trip (a real protocol turn
  // consumed the prompt) — sawEnvelope alone is too weak (a canned emitter).
  const conformed =
    !timedOut &&
    exitCode === 0 &&
    sawEvent &&
    sessionId !== undefined &&
    pendingConversationReset === undefined &&
    !nativeSessionProtocolInvalid &&
    sawNonce
  // Surface a masked, capped excerpt on EVERY failure branch (curated guidance
  // stays, the verbatim vendor text rides along). The result line is quoted
  // from its HEAD (error text precedes the usage blob), the raw streams from
  // their TAILS (errors come last there).
  const resultHead = lastResultLine.replace(/\s+/g, ' ').trim()
  const evidence = [
    resultHead.length > 0
      ? `result: ${resultHead.length > 400 ? `${resultHead.slice(0, 400)}…` : resultHead}`
      : null,
    stderrText.trim().length > 0 ? `stderr tail: ${outputTail(stderrText)}` : null,
    stdoutText.trim().length > 0 ? `stdout tail: ${outputTail(stdoutText)}` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(' | ')
  const withEvidence = (base: string): string =>
    evidence.length === 0 ? base : `${base} — ${maskDiagnosticsText(evidence)}`

  let outcome: SmokeOutcome
  let detail: string
  if (conformed) {
    outcome = 'conforms'
    detail = `binary speaks the ${opts.protocol} protocol (session captured, nonce echoed)`
  } else if (timedOut) {
    outcome = 'model-call-failed'
    detail = withEvidence(`timed out after ${timeoutMs}ms`)
  } else if (networkHit) {
    outcome = 'network-blocked'
    detail = withEvidence(
      'binary started but the model endpoint is unreachable (e.g. 403 Request not allowed / connection failed). Check the daemon network/proxy (HTTP(S)_PROXY) so it can reach the model API, then re-probe.',
    )
  } else if (authHit) {
    outcome = 'auth-missing'
    detail = withEvidence(
      'binary started but authentication failed (may still conform once credentials exist)',
    )
  } else if (modelHit) {
    outcome = 'model-call-failed'
    detail = withEvidence(
      'binary started + authed but the model call failed (rate limit / unavailable / model not licensed)',
    )
  } else if (!sawEvent) {
    outcome = 'stream-nonconforming'
    detail = withEvidence(`no parseable ${opts.protocol} events on stdout (exit ${exitCode})`)
  } else {
    outcome = 'stream-nonconforming'
    detail = withEvidence(
      `emitted events but did not complete the protocol turn (exit ${exitCode}, nonce ${
        sawNonce ? 'seen' : 'missing'
      })`,
    )
  }
  // 2026-08-04 (GLM-gateway incident): with no --model the binary falls back to
  // its OWN default model — for a fork wrapping a private gateway that default
  // is often unlicensed. Say so at the failure site.
  if (
    opts.model === undefined &&
    (outcome === 'model-call-failed' || outcome === 'stream-nonconforming')
  ) {
    detail +=
      ' [no --model was passed (runtime model field is empty) — the binary used its own default model; set the runtime model and re-probe]'
  }

  try {
    rmSync(attemptDir, { recursive: true, force: true })
  } catch {
    return {
      outcome: 'spawn-failed',
      conforms: false,
      detail: 'runtime process cleanup did not complete safely',
      sawNonce: false,
      sawEnvelope: false,
      exitCode: null,
    }
  }

  return {
    outcome,
    conforms: outcome === 'conforms',
    detail,
    ...(sessionId !== undefined &&
    pendingConversationReset === undefined &&
    !nativeSessionProtocolInvalid
      ? { capturedSessionId: sessionId }
      : {}),
    sawNonce,
    sawEnvelope,
    exitCode,
  }
}
