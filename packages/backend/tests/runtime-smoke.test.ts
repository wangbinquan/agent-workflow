// RFC-112 PR-B — deep-smoke conformance probe. smokeRuntime runs ONE minimal
// call through a protocol driver against a binary and classifies whether it
// speaks the protocol end-to-end (parseable events + captured session id + an
// echoed nonce). Auth/quota failures are classified apart from non-conformance
// (Codex P2). The mock binaries echo the prompt (MOCK_*_ECHO_PROMPT) so the
// freshly-generated nonce round-trips; a non-protocol binary (/bin/echo) emits
// no parseable events → stream-nonconforming; a missing path → spawn-failed.

import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { finalizeSmokeAttempt, smokeRuntime, smokeSandboxCtx } from '../src/services/runtimeSmoke'
import {
  ContainmentCoordinator,
  ContainmentProviderQualificationError,
} from '../src/services/sandbox'

const MOCK_CLAUDE = resolve(import.meta.dir, 'fixtures', 'mock-claude.ts')
const MOCK_OPENCODE = resolve(import.meta.dir, 'fixtures', 'mock-opencode.ts')
const SMOKE_TIMEOUT = 30_000

/** A single executable wrapper that execs `bun run <mock>` (binaryPath is one path). */
function wrapperFor(mockFile: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'aw-smoke-bin-'))
  const wrapper = join(dir, 'runtime-bin')
  writeFileSync(wrapper, `#!/bin/sh\nexec bun run ${mockFile} "$@"\n`)
  chmodSync(wrapper, 0o755)
  return wrapper
}

const SET_ENV_KEYS = [
  'MOCK_CLAUDE_CAPTURE_ARGV_TO',
  'MOCK_CLAUDE_ECHO_PROMPT',
  'MOCK_CLAUDE_SESSION_ID',
  'MOCK_CLAUDE_SKIP_ENVELOPE',
  'MOCK_CLAUDE_OUTPUTS',
  'MOCK_CLAUDE_IS_ERROR',
  'MOCK_CLAUDE_RESULT_TEXT',
  'MOCK_CLAUDE_EXIT_CODE',
  'MOCK_OPENCODE_ECHO_PROMPT',
  'MOCK_OPENCODE_EMIT_SESSION_ID',
  'MOCK_OPENCODE_REQUIRE_CONFIG_DIR_EXISTS',
]
afterEach(() => {
  for (const k of SET_ENV_KEYS) delete process.env[k]
})

describe('RFC-224 smoke store-destruction barrier', () => {
  test('verified system store is an explicit RW sandbox subtree under shadowed appHome', async () => {
    const coordinator = new ContainmentCoordinator({
      provider: {
        mode: 'enforce',
        status: { mechanism: 'seatbelt', available: true, detail: null },
        appHome: '/home/aw',
      },
      qualifySeatbelt: async () => {},
    })
    const containment = await coordinator.admit('runner-filesystem-v1')
    const ctx = smokeSandboxCtx('/work/attempt', '/work/run', {
      cmd: ['/bin/echo'],
      env: {},
      containment,
      sessionStore: {
        root: '/home/aw/opencode-stores/system-ephemeral/invocation',
        dbPath: '/home/aw/opencode-stores/system-ephemeral/invocation/opencode.db',
        persistent: false,
      },
    })
    expect(ctx?.taskWorktrees).toEqual([
      '/work/attempt',
      '/home/aw/opencode-stores/system-ephemeral/invocation',
    ])
  })

  test('never-settling child is bounded and strands cleanup/attemptDir after TERM → KILL', async () => {
    const signals: string[] = []
    let cleanupCalled = false
    let removeCalled = false
    let unrefCalled = false
    const startedAt = Date.now()

    const safe = await finalizeSmokeAttempt({
      child: {
        exited: new Promise<number>(() => {}),
        unref: () => {
          unrefCalled = true
        },
      },
      childReaped: false,
      killChild: (signal) => signals.push(signal),
      cleanup: async () => {
        cleanupCalled = true
      },
      removeAttemptDir: () => {
        removeCalled = true
      },
      termGraceMs: 5,
      reapDeadlineMs: 5,
    })

    expect(Date.now() - startedAt).toBeLessThan(500)
    expect(safe).toBe(false)
    expect(signals).toEqual(['SIGTERM', 'SIGKILL'])
    expect(unrefCalled).toBe(true)
    expect(cleanupCalled).toBe(false)
    expect(removeCalled).toBe(false)
  })

  test('plan cleanup failure is a hard barrier before outer attemptDir removal', async () => {
    const order: string[] = []
    const safe = await finalizeSmokeAttempt({
      child: { exited: Promise.resolve(0) },
      childReaped: true,
      killChild: (signal) => order.push(signal),
      cleanup: async () => {
        order.push('cleanup')
        throw new Error('store lock still live')
      },
      removeAttemptDir: () => {
        order.push('remove')
      },
    })

    expect(safe).toBe(false)
    expect(order).toEqual(['SIGKILL', 'cleanup'])
  })

  test('reaped child crosses cleanup then outer removal in that exact order', async () => {
    const order: string[] = []
    const safe = await finalizeSmokeAttempt({
      child: { exited: Promise.resolve(0) },
      childReaped: true,
      killChild: (signal) => order.push(signal),
      cleanup: async () => {
        order.push('cleanup')
      },
      removeAttemptDir: () => {
        order.push('remove')
      },
    })

    expect(safe).toBe(true)
    expect(order).toEqual(['SIGKILL', 'cleanup', 'remove'])
  })
})

describe('smokeRuntime (RFC-112 PR-B)', () => {
  test('production OpenCode smoke fails closed when the verified sandbox is unavailable', async () => {
    const containmentCoordinator = new ContainmentCoordinator({
      provider: {
        mode: 'enforce',
        status: { mechanism: 'bwrap', available: true, detail: null },
        appHome: '/tmp/aw-smoke',
      },
      qualifyBwrap: async () => {
        throw new ContainmentProviderQualificationError('provider-trial-rejected')
      },
    })
    const r = await smokeRuntime({
      protocol: 'opencode',
      binaryPath: '/bin/echo',
      model: 'openai/gpt-5',
      timeoutMs: SMOKE_TIMEOUT,
      containmentCoordinator,
    })
    expect(r).toMatchObject({
      outcome: 'execution-identity-failed',
      conforms: false,
      detail: 'execution-identity-containment-required',
      failureCode: 'execution-identity-containment-required',
      exitCode: null,
    })
  })

  test(
    'claude binary that echoes the prompt + emits a session → conforms',
    async () => {
      process.env.MOCK_CLAUDE_ECHO_PROMPT = '1'
      process.env.MOCK_CLAUDE_SESSION_ID = 'smoke-sess-cc'
      const r = await smokeRuntime({
        protocol: 'claude-code',
        binaryPath: wrapperFor(MOCK_CLAUDE),
        bridgeCredentials: false,
        timeoutMs: SMOKE_TIMEOUT,
      })
      expect(r.outcome).toBe('conforms')
      expect(r.conforms).toBe(true)
      expect(r.sawNonce).toBe(true)
      expect(r.capturedSessionId).toBe('smoke-sess-cc')
      expect(r.exitCode).toBe(0)
    },
    SMOKE_TIMEOUT,
  )

  test(
    'opencode binary that echoes the prompt + emits a session → conforms',
    async () => {
      process.env.MOCK_OPENCODE_ECHO_PROMPT = '1'
      process.env.MOCK_OPENCODE_EMIT_SESSION_ID = '1'
      const r = await smokeRuntime({
        protocol: 'opencode',
        testOnlyUnverifiedRuntime: true,
        binaryPath: wrapperFor(MOCK_OPENCODE),
        timeoutMs: SMOKE_TIMEOUT,
      })
      expect(r.outcome).toBe('conforms')
      expect(r.conforms).toBe(true)
      expect(r.sawNonce).toBe(true)
      expect(r.capturedSessionId).toBe('opc_mock_session_01')
    },
    SMOKE_TIMEOUT,
  )

  // Regression: opencode 1.17+ writes a `.gitignore` into OPENCODE_CONFIG_DIR on
  // startup and exits 1 (no events) if the dir is missing. The smoke probe set
  // OPENCODE_CONFIG_DIR=<attemptDir>/.opencode but never mkdir'd it, so EVERY
  // real opencode probe failed → stream-nonconforming ("no parseable events").
  // The mock now reproduces the startup write; with the runDir mkdir in place
  // this conforms, and reverting the mkdir turns it red.
  test(
    'opencode whose startup writes into OPENCODE_CONFIG_DIR → conforms (smoke must create the runDir)',
    async () => {
      process.env.MOCK_OPENCODE_ECHO_PROMPT = '1'
      process.env.MOCK_OPENCODE_EMIT_SESSION_ID = '1'
      process.env.MOCK_OPENCODE_REQUIRE_CONFIG_DIR_EXISTS = '1'
      const r = await smokeRuntime({
        protocol: 'opencode',
        testOnlyUnverifiedRuntime: true,
        binaryPath: wrapperFor(MOCK_OPENCODE),
        timeoutMs: SMOKE_TIMEOUT,
      })
      expect(r.outcome).toBe('conforms')
      expect(r.conforms).toBe(true)
      expect(r.exitCode).toBe(0)
    },
    SMOKE_TIMEOUT,
  )

  test(
    'a binary that emits events + a session but never the nonce → stream-nonconforming',
    async () => {
      // session emitted, but envelope suppressed + no echo → no nonce, no envelope.
      process.env.MOCK_CLAUDE_SESSION_ID = 'smoke-sess-x'
      process.env.MOCK_CLAUDE_SKIP_ENVELOPE = '1'
      const r = await smokeRuntime({
        protocol: 'claude-code',
        binaryPath: wrapperFor(MOCK_CLAUDE),
        bridgeCredentials: false,
        timeoutMs: SMOKE_TIMEOUT,
      })
      expect(r.outcome).toBe('stream-nonconforming')
      expect(r.conforms).toBe(false)
      expect(r.sawNonce).toBe(false)
    },
    SMOKE_TIMEOUT,
  )

  test(
    'a binary that emits an envelope but never echoes the nonce → stream-nonconforming (Codex P2: nonce required)',
    async () => {
      // envelope present (sawEnvelope) but no prompt echo → the nonce never
      // round-trips. The old (sawNonce ∨ sawEnvelope) gate would have FALSELY
      // passed this; conformance now requires the nonce.
      process.env.MOCK_CLAUDE_SESSION_ID = 'smoke-sess-env'
      process.env.MOCK_CLAUDE_OUTPUTS = '{"ok":"done"}'
      const r = await smokeRuntime({
        protocol: 'claude-code',
        binaryPath: wrapperFor(MOCK_CLAUDE),
        bridgeCredentials: false,
        timeoutMs: SMOKE_TIMEOUT,
      })
      expect(r.sawEnvelope).toBe(true)
      expect(r.sawNonce).toBe(false)
      expect(r.outcome).toBe('stream-nonconforming')
      expect(r.conforms).toBe(false)
    },
    SMOKE_TIMEOUT,
  )

  // RFC-116 regression: claude's region/proxy block is reported on STDOUT as
  // "Failed to authenticate. API Error: 403 Request not allowed" — it carries the
  // auth word AND the 403/network signal. The classifier checks NETWORK_SIGNATURES
  // BEFORE AUTH_SIGNATURES, so this lands as `network-blocked` (root cause = the
  // daemon can't reach the API, e.g. missing HTTP(S)_PROXY), NOT `auth-missing`.
  // (RFC-112 first rescued this from `stream-nonconforming`; RFC-116 splits the
  // proxy/network case out of `auth-missing` so the operator fixes the right thing.)
  test(
    'claude that emits a 403 region/proxy block on stdout → network-blocked (not auth-missing)',
    async () => {
      process.env.MOCK_CLAUDE_SESSION_ID = 'smoke-sess-netblock'
      process.env.MOCK_CLAUDE_IS_ERROR = '1'
      process.env.MOCK_CLAUDE_EXIT_CODE = '1'
      process.env.MOCK_CLAUDE_RESULT_TEXT =
        'Failed to authenticate. API Error: 403 Request not allowed'
      const r = await smokeRuntime({
        protocol: 'claude-code',
        binaryPath: wrapperFor(MOCK_CLAUDE),
        bridgeCredentials: false,
        timeoutMs: SMOKE_TIMEOUT,
      })
      expect(r.outcome).toBe('network-blocked')
      expect(r.conforms).toBe(false)
      expect(r.sawNonce).toBe(false)
    },
    SMOKE_TIMEOUT,
  )

  // RFC-116: a GENUINE credential failure (no network signal) must still land as
  // `auth-missing` — proves networkHit-before-authHit didn't swallow the auth path.
  test(
    'claude that emits a genuine auth error (no network signal) on stdout → auth-missing',
    async () => {
      process.env.MOCK_CLAUDE_SESSION_ID = 'smoke-sess-autherr'
      process.env.MOCK_CLAUDE_IS_ERROR = '1'
      process.env.MOCK_CLAUDE_EXIT_CODE = '1'
      process.env.MOCK_CLAUDE_RESULT_TEXT = 'Invalid API key · Please run /login'
      const r = await smokeRuntime({
        protocol: 'claude-code',
        binaryPath: wrapperFor(MOCK_CLAUDE),
        bridgeCredentials: false,
        timeoutMs: SMOKE_TIMEOUT,
      })
      expect(r.outcome).toBe('auth-missing')
      expect(r.conforms).toBe(false)
    },
    SMOKE_TIMEOUT,
  )

  // 2026-08-04 incident: an error text OUTSIDE the EN signature tables (a
  // subscription usage-limit message, a claude-protocol fork / GLM-gateway
  // error, often non-English) lands on the fallback branch. The detail used to
  // be a bare "(exit 1, nonce missing)" with the child's actual words
  // swallowed — the operator had to guess. The fallback now carries a capped
  // stdout/stderr tail so the real reason is readable in the probe result.
  test(
    'claude that fails with an UNRECOGNIZED error text → stream-nonconforming with the text surfaced in detail',
    async () => {
      process.env.MOCK_CLAUDE_SESSION_ID = 'smoke-sess-unclassified'
      process.env.MOCK_CLAUDE_IS_ERROR = '1'
      process.env.MOCK_CLAUDE_EXIT_CODE = '1'
      process.env.MOCK_CLAUDE_RESULT_TEXT = 'Claude AI usage limit reached — resets 3am'
      const r = await smokeRuntime({
        protocol: 'claude-code',
        binaryPath: wrapperFor(MOCK_CLAUDE),
        bridgeCredentials: false,
        timeoutMs: SMOKE_TIMEOUT,
      })
      expect(r.outcome).toBe('stream-nonconforming')
      expect(r.conforms).toBe(false)
      expect(r.detail).toContain('nonce missing')
      expect(r.detail).toContain('usage limit reached')
    },
    SMOKE_TIMEOUT,
  )

  // 2026-08-04 second round: the terminal `result` event carries the error
  // text near the HEAD of the line and a fat usage blob at the end. A
  // tail-only excerpt shows the blob and hides the reason (observed live:
  // `"modelUsage":{}` visible, actual GLM-gateway error invisible). The
  // evidence must quote the result line's head, so an error text pushed
  // beyond the 300-char tail window by the usage blob stays readable.
  test(
    'a long error result line still surfaces its HEAD (error text) in detail',
    async () => {
      process.env.MOCK_CLAUDE_SESSION_ID = 'smoke-sess-longresult'
      process.env.MOCK_CLAUDE_IS_ERROR = '1'
      process.env.MOCK_CLAUDE_EXIT_CODE = '1'
      process.env.MOCK_CLAUDE_RESULT_TEXT = `GATEWAY_ERR_HEAD ${'x'.repeat(600)}`
      const r = await smokeRuntime({
        protocol: 'claude-code',
        binaryPath: wrapperFor(MOCK_CLAUDE),
        bridgeCredentials: false,
        timeoutMs: SMOKE_TIMEOUT,
      })
      expect(r.outcome).toBe('stream-nonconforming')
      expect(r.detail).toContain('GATEWAY_ERR_HEAD')
    },
    SMOKE_TIMEOUT,
  )

  // 2026-08-04 — per-runtime extraArgs must reach the probed binary's argv, so
  // Test reproduces the exact shape a dispatch would use (a fork that needs
  // `--skip-safe-check` is probed WITH it).
  test(
    'probe passes runtime extraArgs through to the spawned argv',
    async () => {
      const captureDir = mkdtempSync(join(tmpdir(), 'aw-smoke-argv-'))
      const captureFile = join(captureDir, 'argv.json')
      process.env.MOCK_CLAUDE_SESSION_ID = 'smoke-sess-extra-args'
      process.env.MOCK_CLAUDE_ECHO_PROMPT = '1'
      process.env.MOCK_CLAUDE_CAPTURE_ARGV_TO = captureFile
      const r = await smokeRuntime({
        protocol: 'claude-code',
        binaryPath: wrapperFor(MOCK_CLAUDE),
        extraArgs: ['--skip-safe-check'],
        bridgeCredentials: false,
        timeoutMs: SMOKE_TIMEOUT,
      })
      expect(r.outcome).toBe('conforms')
      const argv = JSON.parse(
        readFileSync(captureFile, 'utf8').trim().split('\n').at(-1)!,
      ) as string[]
      expect(argv.at(-1)).toBe('--skip-safe-check')
    },
    SMOKE_TIMEOUT,
  )

  // 2026-08-04 GLM-gateway incident: a private gateway rejecting the model for
  // LICENSING reasons ("您暂无该模型的使用权限…【TM.00001005】") must classify
  // as model-call-failed (not the bare fallback), keep the verbatim vendor text
  // in the detail (evidence now rides along on EVERY failure branch), and —
  // when the probe carried no model — say explicitly that the binary fell back
  // to its own default model and the fix is the runtime's model field.
  test(
    'gateway model-permission error (CJK) → model-call-failed + verbatim text + no-model hint',
    async () => {
      process.env.MOCK_CLAUDE_SESSION_ID = 'smoke-sess-glm-perm'
      process.env.MOCK_CLAUDE_IS_ERROR = '1'
      process.env.MOCK_CLAUDE_EXIT_CODE = '1'
      process.env.MOCK_CLAUDE_RESULT_TEXT =
        '您暂无该模型的使用权限，请联系产品FSE开通或使用其它模型【TM.00001005】'
      const r = await smokeRuntime({
        protocol: 'claude-code',
        binaryPath: wrapperFor(MOCK_CLAUDE),
        bridgeCredentials: false,
        timeoutMs: SMOKE_TIMEOUT,
      })
      expect(r.outcome).toBe('model-call-failed')
      expect(r.detail).toContain('您暂无该模型的使用权限')
      expect(r.detail).toContain('no --model was passed')
    },
    SMOKE_TIMEOUT,
  )

  test(
    'same gateway error WITH an explicit model → model-call-failed without the no-model hint',
    async () => {
      process.env.MOCK_CLAUDE_SESSION_ID = 'smoke-sess-glm-perm-model'
      process.env.MOCK_CLAUDE_IS_ERROR = '1'
      process.env.MOCK_CLAUDE_EXIT_CODE = '1'
      process.env.MOCK_CLAUDE_RESULT_TEXT = '无权使用该模型'
      const r = await smokeRuntime({
        protocol: 'claude-code',
        binaryPath: wrapperFor(MOCK_CLAUDE),
        model: 'GLM-5.1-NN',
        bridgeCredentials: false,
        timeoutMs: SMOKE_TIMEOUT,
      })
      expect(r.outcome).toBe('model-call-failed')
      expect(r.detail).not.toContain('no --model was passed')
    },
    SMOKE_TIMEOUT,
  )

  test(
    'OpenAI-style "does not have access to model" → model-call-failed',
    async () => {
      process.env.MOCK_CLAUDE_SESSION_ID = 'smoke-sess-oai-perm'
      process.env.MOCK_CLAUDE_IS_ERROR = '1'
      process.env.MOCK_CLAUDE_EXIT_CODE = '1'
      process.env.MOCK_CLAUDE_RESULT_TEXT =
        'API Error: 403 Project does not have access to model gpt-x'
      const r = await smokeRuntime({
        protocol: 'claude-code',
        binaryPath: wrapperFor(MOCK_CLAUDE),
        bridgeCredentials: false,
        timeoutMs: SMOKE_TIMEOUT,
      })
      expect(r.outcome).toBe('model-call-failed')
    },
    SMOKE_TIMEOUT,
  )

  // RFC-116: a pure OS/transport network failure (no auth word at all) → network-blocked.
  test(
    'claude that emits a pure network error on stdout → network-blocked',
    async () => {
      process.env.MOCK_CLAUDE_SESSION_ID = 'smoke-sess-enet'
      process.env.MOCK_CLAUDE_IS_ERROR = '1'
      process.env.MOCK_CLAUDE_EXIT_CODE = '1'
      process.env.MOCK_CLAUDE_RESULT_TEXT =
        'request failed: getaddrinfo ENOTFOUND api.anthropic.com'
      const r = await smokeRuntime({
        protocol: 'claude-code',
        binaryPath: wrapperFor(MOCK_CLAUDE),
        bridgeCredentials: false,
        timeoutMs: SMOKE_TIMEOUT,
      })
      expect(r.outcome).toBe('network-blocked')
      expect(r.conforms).toBe(false)
    },
    SMOKE_TIMEOUT,
  )

  test(
    'a non-protocol binary (/bin/echo) emits no parseable events → stream-nonconforming',
    async () => {
      const r = await smokeRuntime({
        protocol: 'claude-code',
        binaryPath: '/bin/echo',
        bridgeCredentials: false,
        timeoutMs: SMOKE_TIMEOUT,
      })
      expect(r.outcome).toBe('stream-nonconforming')
      expect(r.conforms).toBe(false)
    },
    SMOKE_TIMEOUT,
  )

  test(
    'a missing binary path → spawn-failed',
    async () => {
      const r = await smokeRuntime({
        protocol: 'opencode',
        testOnlyUnverifiedRuntime: true,
        binaryPath: '/definitely/not/a/real/binary/aw-xyz',
        timeoutMs: SMOKE_TIMEOUT,
      })
      expect(r.outcome).toBe('spawn-failed')
      expect(r.conforms).toBe(false)
      expect(r.exitCode).toBeNull()
    },
    SMOKE_TIMEOUT,
  )
})
