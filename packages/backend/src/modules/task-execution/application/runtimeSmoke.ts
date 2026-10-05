import { maskDiagnosticsText } from '@agent-workflow/shared'
import { outputTail } from '@/util/spawnDiagnostics'
import type {
  RuntimeSmokeCoreInput,
  RuntimeSmokeCompiledInvocation,
  RuntimeSmokeCorePolicy,
  SmokeResult,
  SmokeOutcome,
} from './ports/runtimeSmoke'

const MAX_OUTPUT_BYTES = 256 * 1024
export const DEFAULT_TIMEOUT_MS = 60_000
const CHILD_TERM_GRACE_MS = 2_000
const AUTH_SIGNATURES =
  /not logged in|unauthorized|authentication|invalid api key|please run .*login|no api key|anthropic_api_key|log ?in to/i
// 2026-08-04 (GLM-gateway incident): private Anthropic/OpenAI-compatible
// gateways report "model not licensed for this account" in vendor wording —
// observed live: "您暂无该模型的使用权限，请联系产品FSE开通或使用其它模型
// 【TM.00001005】". Cover both CJK orders (暂无/无权…模型 and 模型…权限) plus
// the OpenAI-style English phrase, so these land as model-call-failed instead
// of the bare stream-nonconforming fallback.
// 裸的 `503` / `529` **必须带 HTTP 语境**。它们原先是无边界的三位数，而 haystack
// 里含 stdout——冒烟自己发的 nonce 就是 `awsmoke-<16 位 hex>`，hex 串里凑巧出现
// "503"/"529" 的概率约 0.66%/次（实测 20 万次随机 nonce：1327 次误命中）。CI 上
// 因此会间歇把「协议不合规」误判成「模型调用失败」。
//
// 影响不止测试：生产里任何 stdout/stderr 含这三连数字的失败（commit hash 片段、
// 时间戳、字节数、端口号）都会被误分类，管理员照着「限流/配额」的提示去查，方向
// 完全错。故要求它们出现在 HTTP 状态码语境里（`http 503` / `status 529` /
// `error: 503` / `503 service unavailable` 之类），而不是任意位置的三位数。
// 语境词与数字之间允许引号 / 下划线 / `=`：真实中继常把状态码包成 JSON
// （`"status": 503`）或 `status_code=529`，而 `[: ]+` 跨不过引号和下划线，
// 这两种形态原本全漏（三轮门测试有效性自查）。
const HTTP_STATUS_CTX = String.raw`(?:\bhttp[/ ]?[\d.]*\s*|"?\bstatus(?:_?code)?"?\s*[:=]\s*|\berror\s*[:=]\s*|\bcode\s*[:=]\s*)`
/** 导出供回归测试直接断言——解析源码文本抠正则太脆（转义层数会骗人）。 */
export const MODEL_FAIL_SIGNATURES = new RegExp(
  [
    'rate limit',
    'overloaded',
    'quota',
    'model .*not found',
    'insufficient',
    'too many requests',
    `${HTTP_STATUS_CTX}(?:503|529)\\b`,
    String.raw`\b(?:503|529)\s+(?:service unavailable|overloaded)`,
    'does not have access to model',
    '(?:暂无|无权).{0,10}模型',
    '模型.{0,12}权限',
  ].join('|'),
  'i',
)
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

/** Shared smoke behavior; the selected invocation owns material and execution. */
export async function runRuntimeSmokeCore(
  opts: RuntimeSmokeCorePolicy,
  input: RuntimeSmokeCoreInput,
): Promise<SmokeResult> {
  const { log, timeoutMs, nonce } = input
  const prompt =
    `Output this exact token verbatim via your output protocol and nothing else: ${nonce}\n` +
    `Use the \`ok\` output port (or plain text if you have no ports).`
  await input.invocation.prepareWorkspace()
  let compiled: RuntimeSmokeCompiledInvocation
  try {
    compiled = await input.invocation.compile(prompt)
  } catch (err) {
    await input.invocation.workspace.discard()
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
  const invocation = compiled.bind()
  const localExecution = invocation.bindExecution()
  const run = await localExecution.effect.submit({
    executionRef: localExecution.executionRef,
    materialRef: localExecution.materialRef,
    workspaceRef: localExecution.workspaceRef,
    timeoutMs,
    termGraceMs: CHILD_TERM_GRACE_MS,
    ...(invocation.lifecycle.beforeStart !== undefined
      ? { beforeStart: invocation.lifecycle.beforeStart }
      : {}),
    ...(invocation.lifecycle.cleanup !== undefined
      ? { cleanup: invocation.lifecycle.cleanup }
      : {}),
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
        const ev = invocation.protocol.parseEvent(line)
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
    await invocation.workspace.discard()
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
    await invocation.workspace.discard()
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
