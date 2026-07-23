// RFC-112 PR-B — deep-smoke conformance probe. smokeRuntime runs ONE minimal
// call through a protocol driver against a binary and classifies whether it
// speaks the protocol end-to-end (parseable events + captured session id + an
// echoed nonce). Auth/quota failures are classified apart from non-conformance
// (Codex P2). The mock binaries echo the prompt (MOCK_*_ECHO_PROMPT) so the
// freshly-generated nonce round-trips; a non-protocol binary (/bin/echo) emits
// no parseable events → stream-nonconforming; a missing path → spawn-failed.

import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { finalizeSmokeAttempt, smokeRuntime, smokeSandboxCtx } from '../src/services/runtimeSmoke'
import { setSandboxProvider } from '../src/services/sandbox'

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
  setSandboxProvider(null)
})

describe('RFC-224 smoke store-destruction barrier', () => {
  test('verified system store is an explicit RW sandbox subtree under shadowed appHome', () => {
    setSandboxProvider({
      mode: 'enforce',
      status: { mechanism: 'seatbelt', available: true, detail: null },
      appHome: '/home/aw',
    })
    const ctx = smokeSandboxCtx('/work/attempt', '/work/run', {
      cmd: ['/bin/echo'],
      env: {},
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
    const r = await smokeRuntime({
      protocol: 'opencode',
      binaryPath: '/bin/echo',
      model: 'openai/gpt-5',
      timeoutMs: SMOKE_TIMEOUT,
    })
    expect(r).toMatchObject({
      outcome: 'execution-identity-failed',
      conforms: false,
      detail: 'execution-identity-sandbox-required',
      failureCode: 'execution-identity-sandbox-required',
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
