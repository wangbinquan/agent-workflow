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
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  assembleClaudeEnv,
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
