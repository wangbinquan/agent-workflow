// RFC-237 — locks the claude-code materialization of the 'intent-read-v1'
// system-permission profile (design §2): declared-control argv (`--tools`
// load-set pruning + dontAsk, NO bypassPermissions), controlled env
// (internal-marker stripping incl. IS_SANDBOX + hardening injections), the
// sealed-binary TOCTOU fence (shared binarySnapshot module + preSpawnVerify
// spawn-boundary re-verification, design-gate P1-3), the RFC-154 configDir
// threading (P1-2), the legacy bypass branch staying byte-compatible, and the
// systemAgentRun 'result-error' normalization for clean-exit is_error results
// (P2-4). The binarySnapshot re-export identity (T-B) is locked here too.

import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { claudeCodeDriver } from '../src/services/runtime/claudeCode/driver'
import {
  assembleClaudeEnv,
  claudeControlledInheritEnv,
  claudeSandboxEnv,
} from '../src/services/runtime/claudeCode/spawn'
import {
  RUNTIME_BINARY_SNAPSHOT_ERROR_CODE,
  RuntimeBinarySnapshotError,
} from '../src/services/runtime/binarySnapshot'
import {
  RUNTIME_OPENCODE_BINARY_ERROR_CODE,
  RuntimeOpencodeBinaryError,
} from '../src/services/runtime/opencode/runtimeBinary'
import { runSystemAgent } from '../src/services/systemAgentRun'
import type { SystemAgentSpawnContext } from '../src/services/runtime/types'

const MOCK_CLAUDE = resolve(import.meta.dir, 'fixtures', 'mock-claude.ts')

const roots: string[] = []
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  roots.push(dir)
  return dir
}

/** Single-file executable wrapper (the seal needs one PATH token / one file). */
function claudeWrapper(): string {
  const wrapper = join(tempDir('rfc237-bin-'), 'mock-claude')
  writeFileSync(wrapper, `#!/bin/sh\nexec bun run ${MOCK_CLAUDE} "$@"\n`)
  chmodSync(wrapper, 0o755)
  return wrapper
}

const ENV_KEYS = [
  'CLAUDECODE',
  'CLAUDECODE_INTERNAL_X',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_GIT_BASH_PATH',
  'IS_SANDBOX',
  'ANTHROPIC_API_KEY',
  'MOCK_CLAUDE_IS_ERROR',
  'MOCK_CLAUDE_RESULT_TEXT',
  'MOCK_CLAUDE_EXIT_CODE',
  'MOCK_CLAUDE_OUTPUTS',
]
const saved = new Map<string, string | undefined>()
for (const k of ENV_KEYS) saved.set(k, process.env[k])
afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = saved.get(k)
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

function baseCtx(overrides: Partial<SystemAgentSpawnContext> = {}): SystemAgentSpawnContext {
  const scratch = tempDir('rfc237-ctx-')
  return {
    agentName: 'aw-intent-builder',
    systemPrompt: 'system persona',
    prompt: 'user prompt',
    worktreePath: join(scratch, 'worktree'),
    runDir: join(scratch, 'run'),
    ...overrides,
  }
}

describe('RFC-237 §2.2 declared-control argv (intent-read-v1)', () => {
  test('read-only branch: --tools pruning + dontAsk, no bypass, no IS_SANDBOX', async () => {
    // P2-2 (refined 2026-07-31): the INHERITED value must not survive — on a
    // non-root runner (CI) the branch tail injects nothing, so absence below
    // proves the strip; the uid-0 deliberate re-assert is locked separately.
    process.env.IS_SANDBOX = '1'
    const plan = await claudeCodeDriver.buildSpawn(
      baseCtx({
        systemPermissionProfile: 'intent-read-v1',
        testOnlyUnverifiedRuntime: true,
        runtimeBinary: claudeWrapper(),
      }),
    )
    const argv = plan.cmd.join(' ')
    expect(argv).toContain('--permission-mode dontAsk')
    expect(argv).toContain('--tools Read,Grep,Glob')
    expect(argv).toContain('--strict-mcp-config')
    expect(argv).toContain('--disable-slash-commands')
    // --setting-sources takes an EMPTY value (own argv slot).
    const i = plan.cmd.indexOf('--setting-sources')
    expect(i).toBeGreaterThan(0)
    expect(plan.cmd[i + 1]).toBe('')
    expect(argv).not.toContain('bypassPermissions')
    expect(argv).not.toContain('--dangerously-skip-permissions')
    // No MCP config / agents / resume in the intent shape.
    expect(argv).not.toContain('--mcp-config ')
    expect(argv).not.toContain('--agents')
    expect(plan.env.IS_SANDBOX).toBeUndefined()
  })

  test('legacy branch (profile omitted / all-deny) keeps the bypass shape byte-compatible', async () => {
    for (const profile of [undefined, 'all-deny' as const]) {
      const plan = await claudeCodeDriver.buildSpawn(
        baseCtx({
          ...(profile === undefined ? {} : { systemPermissionProfile: profile }),
          testOnlyUnverifiedRuntime: true,
          runtimeBinary: claudeWrapper(),
        }),
      )
      const argv = plan.cmd.join(' ')
      expect(argv).toContain('--permission-mode bypassPermissions')
      expect(argv).not.toContain('--tools')
      expect(argv).not.toContain('--setting-sources')
      expect(argv).not.toContain('--disable-slash-commands')
    }
  })

  test('an undeclared narrowed profile still fails closed', async () => {
    await expect(
      claudeCodeDriver.buildSpawn(
        baseCtx({
          systemPermissionProfile: 'not-a-profile' as never,
          testOnlyUnverifiedRuntime: true,
        }),
      ),
    ).rejects.toThrow(/cannot enforce system permission profile/)
  })

  test('driver declares exactly the intent-read-v1 narrowed profile', () => {
    expect(claudeCodeDriver.narrowedSystemPermissionProfiles).toEqual(['intent-read-v1'])
  })
})

describe('RFC-237 §2.3 controlled env', () => {
  test('read-only branch strips internal markers, injects hardening, keeps auth/user config', async () => {
    process.env.CLAUDECODE = '1'
    process.env.CLAUDECODE_INTERNAL_X = 'x'
    process.env.CLAUDE_CODE_ENTRYPOINT = 'cli'
    process.env.CLAUDE_CODE_SESSION_ID = 'parent-session'
    process.env.CLAUDE_CODE_GIT_BASH_PATH = '/usr/bin/bash' // user config → keep
    process.env.IS_SANDBOX = '1'
    process.env.ANTHROPIC_API_KEY = 'sk-test-not-real'
    const plan = await claudeCodeDriver.buildSpawn(
      baseCtx({
        systemPermissionProfile: 'intent-read-v1',
        testOnlyUnverifiedRuntime: true,
        runtimeBinary: claudeWrapper(),
      }),
    )
    expect(plan.env.CLAUDECODE).toBeUndefined()
    expect(plan.env.CLAUDECODE_INTERNAL_X).toBeUndefined()
    expect(plan.env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined()
    expect(plan.env.CLAUDE_CODE_SESSION_ID).toBeUndefined()
    expect(plan.env.IS_SANDBOX).toBeUndefined()
    expect(plan.env.CLAUDE_CODE_GIT_BASH_PATH).toBe('/usr/bin/bash')
    expect(plan.env.ANTHROPIC_API_KEY).toBe('sk-test-not-real')
    expect(plan.env.DISABLE_AUTOUPDATER).toBe('1')
    expect(plan.env.DISABLE_TELEMETRY).toBe('1')
    expect(plan.env.DISABLE_ERROR_REPORTING).toBe('1')
    expect(plan.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe('1')
    // Private config dir still points inside the run dir (D16 unchanged).
    expect(plan.env.CLAUDE_CONFIG_DIR).toContain('/run')
  })

  test('legacy branch does NOT strip / inject (byte-compatible full inherit)', async () => {
    process.env.CLAUDECODE = '1'
    const plan = await claudeCodeDriver.buildSpawn(
      baseCtx({ testOnlyUnverifiedRuntime: true, runtimeBinary: claudeWrapper() }),
    )
    expect(plan.env.CLAUDECODE).toBe('1')
    expect(plan.env.DISABLE_TELEMETRY).toBeUndefined()
  })

  test('uid-0 daemon deliberately re-asserts IS_SANDBOX=1 on the read-only branch (2026-07-31 root report)', () => {
    // CI cannot run as root, so the root behavior is locked at two layers:
    // the pure helper's uid gate, and the source shape proving the read-only
    // branch tail composes hardening WITH claudeSandboxEnv (spread last, so a
    // uid-0 daemon's '1' always lands after the inherited value was stripped).
    // Claude 2.1.220's two root gates are bypass-only (binary-verified), but a
    // root daemon is a container-shaped deployment where the assertion is
    // honest — and this forward-proofs against a widened gate.
    expect(claudeSandboxEnv(0)).toEqual({ IS_SANDBOX: '1' })
    expect(claudeSandboxEnv(501)).toEqual({})
    expect(claudeSandboxEnv(undefined)).toEqual({})
    // Behavior-level via the unified assembly point (uid dependency-injected):
    // controlled inherit strips the AMBIENT value, then a uid-0 daemon
    // re-asserts '1'; non-root stays absent on both inherit policies.
    process.env.IS_SANDBOX = '1'
    const base = {
      inherit: 'controlled' as const,
      hardening: true,
      worktreePath: '/wt',
      configDirEnv: 'CLAUDE_CONFIG_DIR',
      configDir: '/cfg/.claude',
    }
    expect(assembleClaudeEnv(base, 0).IS_SANDBOX).toBe('1')
    expect(assembleClaudeEnv(base, 501).IS_SANDBOX).toBeUndefined()
    expect(assembleClaudeEnv({ ...base, inherit: 'full' }, 0).IS_SANDBOX).toBe('1')
  })

  test('claudeControlledInheritEnv is a pure blacklist (auth families untouched)', () => {
    const out = claudeControlledInheritEnv({
      CLAUDECODE: '1',
      CLAUDECODE_FOO: 'x',
      CLAUDE_CODE_SSE_PORT: '123',
      CLAUDE_CODE_EXECPATH: '/x',
      IS_SANDBOX: '1',
      CLAUDE_CODE_USE_BEDROCK: '1',
      ANTHROPIC_API_KEY: 'k',
      HTTPS_PROXY: 'http://p',
      PATH: '/usr/bin',
      GONE: undefined,
    })
    expect(out.CLAUDECODE).toBeUndefined()
    expect(out.CLAUDECODE_FOO).toBeUndefined()
    expect(out.CLAUDE_CODE_SSE_PORT).toBeUndefined()
    expect(out.CLAUDE_CODE_EXECPATH).toBeUndefined()
    expect(out.IS_SANDBOX).toBeUndefined()
    expect(out.GONE).toBeUndefined()
    expect(out.CLAUDE_CODE_USE_BEDROCK).toBe('1')
    expect(out.ANTHROPIC_API_KEY).toBe('k')
    expect(out.HTTPS_PROXY).toBe('http://p')
    expect(out.PATH).toBe('/usr/bin')
  })

  test('RFC-154 custom configDir keys are threaded and the default key is scrubbed (P1-2)', async () => {
    const plan = await claudeCodeDriver.buildSpawn(
      baseCtx({
        systemPermissionProfile: 'intent-read-v1',
        testOnlyUnverifiedRuntime: true,
        runtimeBinary: claudeWrapper(),
        configDirEnv: 'MY_FORK_CONFIG_DIR',
        configDirName: '.myfork',
      }),
    )
    expect(plan.env.MY_FORK_CONFIG_DIR).toContain('.myfork')
    expect(plan.env.CLAUDE_CONFIG_DIR).toBeUndefined()
  })
})

describe('RFC-237 §2.4 sealed binary + preSpawnVerify (P1-3)', () => {
  test('production shape seals into <runDir>/bin and verifies at the spawn boundary', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test-not-real' // env auth short-circuits the keychain bridge
    const ctx = baseCtx({
      systemPermissionProfile: 'intent-read-v1',
      runtimeBinary: claudeWrapper(),
    })
    const plan = await claudeCodeDriver.buildSpawn(ctx)
    const seal = plan.cmd[0]!
    expect(seal).toBe(join(ctx.runDir, 'bin', 'claude-sealed'))
    expect(existsSync(seal)).toBe(true)
    expect(statSync(seal).mode & 0o777).toBe(0o500)
    expect(plan.preSpawnVerify).toBeDefined()
    await plan.preSpawnVerify!() // pristine seal verifies

    // Mutate the seal after plan construction → the spawn boundary refuses.
    chmodSync(seal, 0o700)
    writeFileSync(seal, '#!/bin/sh\necho pwned\n')
    let thrown: unknown
    try {
      await plan.preSpawnVerify!()
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(RuntimeBinarySnapshotError)
    expect((thrown as RuntimeBinarySnapshotError).code).toBe('execution-identity-untrusted-binary')
  })

  test('the explicit test seam skips the seal (mock head verbatim)', async () => {
    const wrapper = claudeWrapper()
    const plan = await claudeCodeDriver.buildSpawn(
      baseCtx({
        systemPermissionProfile: 'intent-read-v1',
        testOnlyUnverifiedRuntime: true,
        runtimeBinary: wrapper,
      }),
    )
    expect(plan.cmd[0]).toBe(wrapper)
    expect(plan.preSpawnVerify).toBeUndefined()
  })

  test('T-B: the opencode legacy names are the SAME runtime objects (re-export identity)', () => {
    expect(RuntimeOpencodeBinaryError).toBe(RuntimeBinarySnapshotError)
    expect(RUNTIME_OPENCODE_BINARY_ERROR_CODE).toBe(RUNTIME_BINARY_SNAPSHOT_ERROR_CODE)
    expect(new RuntimeOpencodeBinaryError('changed')).toBeInstanceOf(RuntimeBinarySnapshotError)
  })
})

describe('RFC-237 §4.1 result-error normalization (P2-4)', () => {
  test('clean exit + is_error result fails the run as result-error, not a phantom envelope miss', async () => {
    process.env.MOCK_CLAUDE_IS_ERROR = '1'
    process.env.MOCK_CLAUDE_RESULT_TEXT = 'Not logged in · run claude auth login'
    process.env.MOCK_CLAUDE_EXIT_CODE = '0' // the P2-4 shape: clean exit
    const r = await runSystemAgent({
      feature: 'intent-builder',
      agentName: 'aw-intent-builder',
      systemPrompt: 'sp',
      prompt: 'p',
      protocol: 'claude-code',
      runtimeBinary: claudeWrapper(),
      scratchParent: tempDir('rfc237-scratch-'),
      testOnlyUnverifiedRuntime: true,
      timeoutMs: 20_000,
    })
    expect(r.status).toBe('result-error')
    expect(r.exitCode).toBe(0)
    expect(r.resultError).toContain('Not logged in')
    // Impl-gate P2: with no real stderr, the terminal text doubles as the
    // stderr tail so persisted diagnostics carry the actionable cause.
    expect(r.stderrTail).toContain('Not logged in')
  })

  test('a claude run with an event sink completes the capture without a child sweep', async () => {
    process.env.MOCK_CLAUDE_OUTPUTS = JSON.stringify({ summary: 'ok' })
    const appended: string[] = []
    let terminal: { state: string; reason?: string } | undefined
    const r = await runSystemAgent({
      feature: 'intent-builder',
      agentName: 'aw-intent-builder',
      systemPrompt: 'sp',
      prompt: 'p',
      protocol: 'claude-code',
      runtimeBinary: claudeWrapper(),
      scratchParent: tempDir('rfc237-scratch-'),
      testOnlyUnverifiedRuntime: true,
      timeoutMs: 20_000,
      eventSink: {
        append: async (e) => {
          appended.push(String(e.kind))
        },
        setRootSessionId: async () => {},
        markTerminal: async (state, reason) => {
          terminal = { state, ...(reason === undefined ? {} : { reason }) }
        },
      },
    })
    expect(r.status).toBe('ok')
    // The full main session streamed through parseEvent into the sink; no
    // opencode child sweep ran (claude omits captureSessionsToSink) and the
    // capture still settles complete.
    expect(appended.length).toBeGreaterThan(0)
    expect(terminal).toEqual({ state: 'complete' })
  })
})
