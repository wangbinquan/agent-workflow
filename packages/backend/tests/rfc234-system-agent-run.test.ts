// RFC-234 §1 (T2) — behavior lock for the runSystemAgent primitive:
// scratch lifecycle under an app-home parent (success removes, failure
// RETAINS — design §1.2 / Codex design-gate P1-7), platform-side seed files,
// seed path traversal rejection, envelope-source event text accumulation,
// timeout/abort escalation, and diagnostics masking. Uses the shared
// mock-opencode fixture via testOnlyUnverifiedRuntime (runtime-smoke.test.ts
// precedent).

import { afterEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { assertSafeSeedPath, runSystemAgent } from '../src/services/systemAgentRun'

const MOCK_OPENCODE = resolve(import.meta.dir, 'fixtures', 'mock-opencode.ts')

function wrapperFor(mockFile: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'aw-sysrun-bin-'))
  const wrapper = join(dir, 'mock-runtime')
  writeFileSync(wrapper, `#!/bin/sh\nexec bun run ${mockFile} "$@"\n`)
  chmodSync(wrapper, 0o755)
  return wrapper
}

const SET_ENV_KEYS = [
  'MOCK_OPENCODE_ECHO_PROMPT',
  'MOCK_OPENCODE_EMIT_SESSION_ID',
  'MOCK_OPENCODE_EXIT_CODE',
  'MOCK_OPENCODE_DELAY_MS',
  'MOCK_OPENCODE_STDERR',
]
afterEach(() => {
  for (const k of SET_ENV_KEYS) delete process.env[k]
})

function scratchParentDir(): string {
  return mkdtempSync(join(tmpdir(), 'aw-sysrun-scratch-'))
}

const baseOpts = (scratchParent: string, binary: string) => ({
  feature: 'intent-builder',
  agentName: 'aw-intent-builder',
  systemPrompt: 'You are a test system agent.',
  prompt: 'echo this back: sysrun-nonce-42',
  protocol: 'opencode' as const,
  runtimeBinary: binary,
  scratchParent,
  testOnlyUnverifiedRuntime: true,
  timeoutMs: 20_000,
})

describe('runSystemAgent', () => {
  test('ok path: event text accumulated, scratch removed', async () => {
    process.env.MOCK_OPENCODE_ECHO_PROMPT = '1'
    process.env.MOCK_OPENCODE_EMIT_SESSION_ID = 'sysrun-sess-1'
    const scratchParent = scratchParentDir()
    const r = await runSystemAgent({
      ...baseOpts(scratchParent, wrapperFor(MOCK_OPENCODE)),
      scratchName: 'turn-ok',
    })
    expect(r.status).toBe('ok')
    expect(r.exitCode).toBe(0)
    expect(r.eventText).toContain('sysrun-nonce-42')
    expect(r.capturedSessionId).toBe('sysrun-sess-1')
    expect(r.scratchRetained).toBe(false)
    expect(existsSync(join(scratchParent, 'turn-ok'))).toBe(false)
  })

  test('seed files land in worktree before spawn; failure retains scratch', async () => {
    process.env.MOCK_OPENCODE_ECHO_PROMPT = '1'
    process.env.MOCK_OPENCODE_EXIT_CODE = '3'
    const scratchParent = scratchParentDir()
    const r = await runSystemAgent({
      ...baseOpts(scratchParent, wrapperFor(MOCK_OPENCODE)),
      scratchName: 'turn-fail',
      seedFiles: [
        { path: 'INTENT.md', content: '# intent' },
        { path: 'mounted/res.agent.1.md', content: '---\nname: a\n---\n' },
      ],
    })
    expect(r.status).toBe('exit-nonzero')
    expect(r.exitCode).toBe(3)
    // Failure path retains the scratch dir (deterministic GC owner cleans later)
    // — and the retained tree proves the seeds were written before spawn.
    expect(r.scratchRetained).toBe(true)
    const worktree = join(scratchParent, 'turn-fail', 'worktree')
    expect(readFileSync(join(worktree, 'INTENT.md'), 'utf8')).toBe('# intent')
    expect(readFileSync(join(worktree, 'mounted', 'res.agent.1.md'), 'utf8')).toContain('name: a')
  })

  test('seed path traversal / absolute paths are rejected before any spawn', async () => {
    const scratchParent = scratchParentDir()
    for (const path of ['../escape.md', '/abs.md', 'a/../../x']) {
      const r = await runSystemAgent({
        ...baseOpts(scratchParent, wrapperFor(MOCK_OPENCODE)),
        seedFiles: [{ path, content: 'x' }],
      })
      expect(r.status).toBe('spawn-failed')
      expect(r.stderrTail).toContain('unsafe seed path')
    }
    // Nothing leaked outside the (removed) scratch dirs.
    expect(readdirSync(scratchParent)).toEqual([])
    expect(() => assertSafeSeedPath('/tmp/wt', '../up')).toThrow(/unsafe seed path/)
    expect(assertSafeSeedPath('/tmp/wt', 'ok/nested.md')).toBe('/tmp/wt/ok/nested.md')
  })

  test('timeout escalates TERM→KILL and retains scratch', async () => {
    process.env.MOCK_OPENCODE_DELAY_MS = '30000'
    const scratchParent = scratchParentDir()
    const r = await runSystemAgent({
      ...baseOpts(scratchParent, wrapperFor(MOCK_OPENCODE)),
      scratchName: 'turn-timeout',
      timeoutMs: 500,
    })
    expect(r.status).toBe('timeout')
    expect(r.scratchRetained).toBe(true)
    expect(existsSync(join(scratchParent, 'turn-timeout'))).toBe(true)
  }, 20_000)

  test('abort signal maps to aborted', async () => {
    process.env.MOCK_OPENCODE_DELAY_MS = '30000'
    const scratchParent = scratchParentDir()
    const controller = new AbortController()
    const runPromise = runSystemAgent({
      ...baseOpts(scratchParent, wrapperFor(MOCK_OPENCODE)),
      abortSignal: controller.signal,
    })
    setTimeout(() => controller.abort(), 300)
    const r = await runPromise
    expect(r.status).toBe('aborted')
  }, 20_000)

  test('spawn failure (missing binary) reports masked diagnostics', async () => {
    const scratchParent = scratchParentDir()
    const r = await runSystemAgent({
      ...baseOpts(scratchParent, '/nonexistent/bin/opencode-missing'),
    })
    expect(r.status).toBe('spawn-failed')
    expect(r.exitCode).toBeNull()
  })

  test('stderr tail is credential-masked', async () => {
    process.env.MOCK_OPENCODE_ECHO_PROMPT = '1'
    process.env.MOCK_OPENCODE_EXIT_CODE = '1'
    process.env.MOCK_OPENCODE_STDERR =
      'fetch failed https://u:sk-live-AAAABBBBCCCCDDDDEEEEFFFF11112222@api.example.com/x'
    const scratchParent = scratchParentDir()
    const r = await runSystemAgent({
      ...baseOpts(scratchParent, wrapperFor(MOCK_OPENCODE)),
    })
    expect(r.status).toBe('exit-nonzero')
    expect(r.stderrTail).not.toContain('sk-live-AAAABBBBCCCCDDDDEEEEFFFF11112222')
    expect(r.stderrTail).toContain('api.example.com')
  })

  // RFC-234 e2e seam: an UNBRANDED opencodeCmd rides the same legacy escape
  // the business path has (only reachable from tests / the e2e binary where
  // production branding is compiled out); a BRANDED command without the
  // explicit test flag must still hit the verified system plan (here: fails
  // identity because no auth/attestation exists — the fail-closed posture).
  test('opencodeCmd branding decides verified vs legacy system path', async () => {
    process.env.MOCK_OPENCODE_ECHO_PROMPT = '1'
    const { markProductionOpencodeCommand } = await import('../src/util/opencode')
    const scratchParent = scratchParentDir()
    const binary = wrapperFor(MOCK_OPENCODE)

    const { testOnlyUnverifiedRuntime: _drop, ...optsWithoutFlag } = baseOpts(scratchParent, binary)
    // Unbranded command, no test flag → legacy path runs the stub fine.
    const legacy = await runSystemAgent({
      ...optsWithoutFlag,
      opencodeCmd: [binary],
      scratchName: 'turn-unbranded',
    })
    expect(legacy.status).toBe('ok')

    // Branded command, no test flag → verified plan → identity failure
    // (source-run tests have no sealed binary/auth; must NOT silently fall
    // back to the legacy spawn).
    const verified = await runSystemAgent({
      ...optsWithoutFlag,
      opencodeCmd: markProductionOpencodeCommand([binary]),
      scratchName: 'turn-branded',
    })
    expect(verified.status).toBe('identity-failed')
  })
})
