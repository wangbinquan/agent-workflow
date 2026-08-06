// RFC-237 (2026-07-31 unification) — assembleClaudeEnv is the SINGLE env
// assembly point for every Claude Code child. The root-deployment incident
// proved per-call-site env tails drift: the read-only branch dropped the uid-0
// IS_SANDBOX assert, and the RFC-238 MCP playground copied a third variant
// (its own hardening set, no sandbox assert at all). This file locks:
//   1. the assembly behavior matrix (inherit policy × hardening × uid ×
//      config-dir scrub × git identity);
//   2. the declared-control ARGV group's byte-exact shape (same drift class:
//      mcpTest.ts had grown a second copy of the security flag group);
//   3. a directory-level source ratchet — no claudeCode/ module other than
//      spawn.ts may hand-roll the env OR argv control surface, so a further
//      variant cannot appear silently.

import { afterEach, describe, expect, test } from 'bun:test'
import { claudeCodeDriver } from '../src/services/runtime/claudeCode/driver'
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  assembleClaudeEnv,
  buildClaudeSpawn,
  claudeDeclaredControlArgv,
  CLAUDE_HEADLESS_BASE_ARGV,
  CLAUDE_INTENT_READONLY_TOOLS,
} from '../src/services/runtime/claudeCode/spawn'

const ENV_KEYS = ['IS_SANDBOX', 'CLAUDECODE', 'DISABLE_TELEMETRY', 'ANTHROPIC_API_KEY']
const saved = new Map<string, string | undefined>()
for (const k of ENV_KEYS) saved.set(k, process.env[k])
afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = saved.get(k)
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

const base = {
  inherit: 'controlled' as const,
  hardening: true,
  worktreePath: '/wt',
  configDirEnv: 'CLAUDE_CONFIG_DIR',
  configDir: '/run/.claude',
}

describe('assembleClaudeEnv behavior matrix', () => {
  test('uid-0 asserts IS_SANDBOX=1 on BOTH inherit policies; non-root asserts nothing', () => {
    process.env.IS_SANDBOX = '1' // ambient — must not be what decides the child
    expect(assembleClaudeEnv(base, 0).IS_SANDBOX).toBe('1')
    expect(assembleClaudeEnv(base, 501).IS_SANDBOX).toBeUndefined()
    expect(assembleClaudeEnv({ ...base, inherit: 'full' }, 0).IS_SANDBOX).toBe('1')
    // full inherit + non-root: the ambient value flows through UNCHANGED
    // (legacy byte-compatibility — the strip is a controlled-branch property).
    expect(assembleClaudeEnv({ ...base, inherit: 'full' }, 501).IS_SANDBOX).toBe('1')
  })

  test('controlled inherit strips internal markers, keeps auth; full inherit keeps everything', () => {
    process.env.CLAUDECODE = '1'
    process.env.ANTHROPIC_API_KEY = 'sk-test-not-real'
    const controlled = assembleClaudeEnv(base, 501)
    expect(controlled.CLAUDECODE).toBeUndefined()
    expect(controlled.ANTHROPIC_API_KEY).toBe('sk-test-not-real')
    const full = assembleClaudeEnv({ ...base, inherit: 'full' }, 501)
    expect(full.CLAUDECODE).toBe('1')
  })

  test('hardening toggles the no-telemetry set; PWD and config dir always land', () => {
    const on = assembleClaudeEnv(base, 501)
    expect(on.DISABLE_TELEMETRY).toBe('1')
    expect(on.DISABLE_AUTOUPDATER).toBe('1')
    expect(on.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe('1')
    const off = assembleClaudeEnv({ ...base, hardening: false, inherit: 'full' }, 501)
    expect(off.DISABLE_AUTOUPDATER ?? process.env.DISABLE_AUTOUPDATER).toBe(
      process.env.DISABLE_AUTOUPDATER,
    )
    expect(on.PWD).toBe('/wt')
    expect(on.CLAUDE_CONFIG_DIR).toBe('/run/.claude')
  })

  test('custom config-dir key scrubs the protocol default; git identity needs both fields', () => {
    const custom = assembleClaudeEnv(
      { ...base, configDirEnv: 'MY_FORK_DIR', configDir: '/run/.fork' },
      501,
    )
    expect(custom.MY_FORK_DIR).toBe('/run/.fork')
    expect(custom.CLAUDE_CONFIG_DIR).toBeUndefined()
    const withGit = assembleClaudeEnv({ ...base, gitUserName: 'aw', gitUserEmail: 'aw@x.dev' }, 501)
    expect(withGit.GIT_AUTHOR_NAME).toBe('aw')
    expect(withGit.GIT_COMMITTER_EMAIL).toBe('aw@x.dev')
    const half = assembleClaudeEnv({ ...base, gitUserName: 'aw', gitUserEmail: '' }, 501)
    expect(half.GIT_AUTHOR_NAME).toBeUndefined()
  })
})

describe('assembleClaudeArgv — declared-control flag group is single-owned', () => {
  test('byte-exact groups for both capabilities (intent read-only / MCP playground)', () => {
    // These two literals ARE the pre-unification hand-rolled groups; keeping
    // them byte-exact proves the collapse changed no production argv.
    expect(claudeDeclaredControlArgv({ tools: CLAUDE_INTENT_READONLY_TOOLS })).toEqual([
      '--permission-mode',
      'dontAsk',
      '--tools',
      'Read,Grep,Glob',
      '--strict-mcp-config',
      '--setting-sources',
      '',
      '--disable-slash-commands',
    ])
    expect(
      claudeDeclaredControlArgv({
        tools: '',
        mcpConfigFile: '/private/mcp.json',
        allowedTools: 'mcp__k__*',
      }),
    ).toEqual([
      '--permission-mode',
      'dontAsk',
      '--tools',
      '',
      '--mcp-config',
      '/private/mcp.json',
      '--strict-mcp-config',
      '--setting-sources',
      '',
      '--disable-slash-commands',
      '--allowedTools',
      'mcp__k__*',
    ])
    // strict-mcp-config is UNCONDITIONAL (no --mcp-config ⇒ zero MCP servers):
    // dropping it would silently re-admit inherited MCP config.
    const noMcp = claudeDeclaredControlArgv({ tools: 'Read' })
    expect(noMcp).toContain('--strict-mcp-config')
    expect(noMcp).not.toContain('--mcp-config')
    expect(CLAUDE_HEADLESS_BASE_ARGV).toEqual(['-p', '--output-format', 'stream-json', '--verbose'])
  })
})

describe('RFC-242 §3 — system/business surface split cannot leak', () => {
  test('the business surface keeps its tools; only the system surface denies all', async () => {
    // Regression: collapsing all-deny into the SHARED assembler once made
    // business nodes inherit `--tools ""` — every claude workflow node would
    // have lost every tool. The surface is explicit and defaults to business.
    const scratch = mkdtempSync(join(tmpdir(), 'rfc242-surface-'))
    const common = {
      prompt: 'p',
      systemPromptText: 'sp',
      attemptDir: join(scratch, 'run'),
      worktreePath: join(scratch, 'wt'),
    }
    const business = buildClaudeSpawn(common)
    expect(business.cmd).toContain('bypassPermissions')
    expect(business.cmd).not.toContain('--tools')

    const system = buildClaudeSpawn({ ...common, surface: 'system' })
    expect(system.cmd).not.toContain('bypassPermissions')
    const toolsAt = system.cmd.indexOf('--tools')
    expect(toolsAt).toBeGreaterThan(-1)
    expect(system.cmd[toolsAt + 1]).toBe('')

    // And the business default is what an OMITTED surface means (no silent
    // tightening of a business spawn that skips optional fields).
    expect(buildClaudeSpawn({ ...common, surface: undefined }).cmd).toEqual(business.cmd)
  })

  test('only the system-agent driver entry marks the system surface', () => {
    const driverSrc = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'services', 'runtime', 'claudeCode', 'driver.ts'),
      'utf8',
    )
    // buildSpawn (system) marks it; buildBusinessSpawn must NOT. 2026-08-06:
    // the system entry carries the probe carve-out ternary — the DEFAULT stays
    // 'system' and only the explicit probeDispatchShape flag flips to the
    // business dispatch shape (probe fidelity, GLM-fork incident). The exact
    // literal is asserted so a refactor cannot silently widen the default.
    const systemAt = driverSrc.indexOf(
      "surface: ctx.probeDispatchShape === true ? 'business' : 'system'",
    )
    const businessAt = driverSrc.indexOf('async buildBusinessSpawn(')
    expect(systemAt).toBeGreaterThan(-1)
    expect(systemAt).toBeLessThan(businessAt)
    expect(driverSrc.slice(businessAt)).not.toContain("surface: 'system'")
    expect(driverSrc.slice(businessAt)).not.toContain('probeDispatchShape')
  })
})

describe('claudeCode env-surface source ratchet', () => {
  test('only spawn.ts may touch the raw env surface — no fourth variant', () => {
    const dir = resolve(import.meta.dir, '..', 'src', 'services', 'runtime', 'claudeCode')
    const offenders: string[] = []
    // The full env surface a hand-rolled variant would need to re-implement.
    // Any of these outside spawn.ts = a call site rebuilding what
    // assembleClaudeEnv owns (the exact drift that caused the root incident).
    // Code-shaped forms only (key/assignment/call/quoted flag), so a comment
    // MENTIONING a key does not trip the ratchet while re-implementations do.
    // Covers BOTH surfaces spawn.ts owns: env assembly and the
    // declared-control argv group (2026-07-31 unification).
    const surface =
      /\.\.\.process\.env|claudeControlledInheritEnv\(|claudeSandboxEnv\(|DISABLE_AUTOUPDATER\s*:|IS_SANDBOX\s*[:=]|'--permission-mode'|'--setting-sources'|'--disable-slash-commands'|'--strict-mcp-config'|'--allowedTools'|'dontAsk'/
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.ts') || name === 'spawn.ts') continue
      const text = readFileSync(resolve(dir, name), 'utf8')
      if (surface.test(text)) offenders.push(name)
    }
    expect(offenders).toEqual([])
  })
})

// RFC-242 T6 — anti-relapse ratchet for the business tool gate.
//
// T1-T3 made a DECLARED-permission business node run under the declared-control
// contract (mapped `--tools`, dontAsk, sealed binary, controlled env). The
// posture that must never come back is the one the RFC removed: a node whose
// agent declared a permission silently falling back to `bypassPermissions`.
// The surface split test above proves the two shapes differ; this one proves
// the DECLARED side can never regress into the bypassed side — the exact
// regression a future refactor of buildClaudeSpawn / buildBusinessSpawn would
// otherwise reintroduce without any test noticing.
describe('RFC-242 T6 — a declared-permission business node can never relapse to bypass', () => {
  const scratchRoot = () => mkdtempSync(join(tmpdir(), 'rfc242-t6-'))

  /** Business ctx with a mock head so no seal/keychain is touched. */
  const ctx = (permission: Record<string, unknown>, runRoot: string) =>
    ({
      agent: { name: 'a', bodyMd: 'persona', permission } as never,
      prompt: 'p',
      injectedMemoryBlock: null,
      dependents: [],
      mcps: [],
      plugins: [],
      resolvedParamsByAgent: new Map(),
      skills: [],
      worktreePath: '/wt',
      runRoot,
      configDir: { env: 'CLAUDE_CONFIG_DIR', name: '.claude' },
      wantsInventory: false,
      nodeRunId: 'nr-t6',
      runtimeCmd: ['bun', 'run', 'mock'],
      log: { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} },
    }) as never

  test('every non-empty permission shape produces a gated argv, never bypassPermissions', async () => {
    // Spans the mapping's whole behavior space: allow / deny / wildcard /
    // headless-ask / pattern rule / unknown key / fully-denied. Whatever the
    // gate resolves to — even the empty load set — the node must stay gated.
    const shapes: Array<Record<string, unknown>> = [
      { read: 'allow' },
      { bash: 'deny' },
      { '*': 'allow' },
      { '*': 'deny' },
      { bash: 'ask' },
      { bash: { 'git *': 'allow' } },
      { not_a_real_key: 'allow' },
      { read: 'allow', edit: 'allow', bash: 'deny', websearch: 'allow' },
    ]
    for (const permission of shapes) {
      const plan = await claudeCodeDriver.buildBusinessSpawn(ctx(permission, scratchRoot()))
      const argv = plan.cmd.join(' ')
      expect(argv).not.toContain('bypassPermissions')
      expect(argv).not.toContain('--dangerously-skip-permissions')
      expect(argv).toContain('--permission-mode dontAsk')
      expect(plan.cmd).toContain('--tools')
      // Controlled env travels with the gate (no full inherit for a gated node).
      expect(plan.env.DISABLE_TELEMETRY).toBe('1')
    }
  })

  test('ONLY an empty declaration keeps the unconstrained shape (the documented escape valve)', async () => {
    const plan = await claudeCodeDriver.buildBusinessSpawn(ctx({}, scratchRoot()))
    expect(plan.cmd).toContain('bypassPermissions')
    // …and that shape is the ONLY one allowed to skip the gate, so a future
    // change that widens "unconstrained" beyond `{}` fails here.
    expect(plan.cmd).not.toContain('--tools')
  })
})
