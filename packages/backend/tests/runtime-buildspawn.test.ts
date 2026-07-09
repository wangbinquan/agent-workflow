import { rimrafDir } from './helpers/cleanup'
import { isWindows } from './helpers/stub-runtime'
// RFC-117 — RuntimeDriver.buildSpawn (system-agent spawn) for the framework's
// internal agents (distiller / commit / fusion-merger). Locks that:
//   - opencode produces a MINIMAL inline config (prompt + model only, NO
//     skills/mcp/plugins/inventory) + positional prompt (stdin ignored);
//   - claude produces its system-prompt-file + stdin-pipe form;
//   - both honor a custom runtimeBinary head (RFC-112 fork) and omit the model
//     flag when the profile model is null/''.
// This is the seam distiller (PR-B) routes through to drop ~150 lines of
// duplicated opencode argv/env/parse logic. The runner.ts business-node spawn
// path deliberately does NOT route here (its golden lock stays in
// runtime-opencode-golden.test.ts / runtime-spawn-head.test.ts).

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { opencodeDriver } from '@/services/runtime/opencode/driver'
import { claudeCodeDriver } from '@/services/runtime/claudeCode/driver'
import { claudeSandboxEnv } from '@/services/runtime/claudeCode/spawn'
import type { SystemAgentSpawnContext } from '@/services/runtime/types'

const BASE: SystemAgentSpawnContext = {
  agentName: 'aw-memory-distiller',
  systemPrompt: 'PERSONA TEXT',
  model: 'anthropic/claude-haiku',
  prompt: 'USER PROMPT',
  worktreePath: '/tmp/wt',
  runDir: '/tmp/run',
}

describe('opencodeDriver.buildSpawn (RFC-117 system agent)', () => {
  test('argv = opencode run/prompt/--agent/--format json/--thinking/--dangerously; stdin ignored', () => {
    const plan = opencodeDriver.buildSpawn(BASE)
    // Windows: Bun.spawn truncates argv elements at '\n', so the prompt is
    // piped via stdin (omitted from argv) instead of passed positionally.
    const expectedCmd = isWindows
      ? [
          'opencode',
          'run',
          '--agent',
          'aw-memory-distiller',
          '--format',
          'json',
          '--thinking',
          '--dangerously-skip-permissions',
        ]
      : [
          'opencode',
          'run',
          'USER PROMPT',
          '--agent',
          'aw-memory-distiller',
          '--format',
          'json',
          '--thinking',
          '--dangerously-skip-permissions',
        ]
    expect(plan.cmd).toEqual(expectedCmd)
    expect(plan.stdin).toEqual(
      isWindows ? { mode: 'pipe', data: 'USER PROMPT' } : { mode: 'ignore' },
    )
  })

  test('inline config carries persona prompt + model only (no skills/mcp/plugins)', () => {
    const plan = opencodeDriver.buildSpawn(BASE)
    const inline = JSON.parse(plan.env.OPENCODE_CONFIG_CONTENT!)
    expect(inline).toEqual({
      agent: {
        'aw-memory-distiller': { prompt: 'PERSONA TEXT', model: 'anthropic/claude-haiku' },
      },
    })
    expect(plan.env.OPENCODE_CONFIG_DIR).toBe('/tmp/run')
    expect(plan.env.PWD).toBe('/tmp/wt')
  })

  test('model null/empty → inline config omits model (runtime default)', () => {
    const inlineNull = JSON.parse(
      opencodeDriver.buildSpawn({ ...BASE, model: null }).env.OPENCODE_CONFIG_CONTENT!,
    )
    expect(inlineNull.agent['aw-memory-distiller']).toEqual({ prompt: 'PERSONA TEXT' })
    const inlineEmpty = JSON.parse(
      opencodeDriver.buildSpawn({ ...BASE, model: '' }).env.OPENCODE_CONFIG_CONTENT!,
    )
    expect(inlineEmpty.agent['aw-memory-distiller']).toEqual({ prompt: 'PERSONA TEXT' })
  })

  test('runtimeBinary overrides the opencode head (RFC-112 custom fork)', () => {
    const plan = opencodeDriver.buildSpawn({ ...BASE, runtimeBinary: '/opt/my-oc' })
    expect(plan.cmd[0]).toBe('/opt/my-oc')
    // Windows omits the positional prompt (piped via stdin); see the argv test.
    expect(plan.cmd.slice(1, 3)).toEqual(isWindows ? ['run', '--agent'] : ['run', 'USER PROMPT'])
  })

  // IS_SANDBOX is a claude-code-only root-gate escape hatch; opencode has no
  // root guard (verified in its source), so its env must stay uninjected.
  test('does NOT inject IS_SANDBOX (root gate is claude-code-specific)', () => {
    const prev = process.env.IS_SANDBOX
    delete process.env.IS_SANDBOX
    try {
      expect(opencodeDriver.buildSpawn(BASE).env.IS_SANDBOX).toBeUndefined()
    } finally {
      if (prev !== undefined) process.env.IS_SANDBOX = prev
    }
  })
})

describe('claudeCodeDriver.buildSpawn (RFC-117 system agent)', () => {
  // claude buildSpawn writes a system-prompt file + config dir under runDir.
  function withTmp(fn: (dir: string) => void): void {
    const dir = mkdtempSync(join(tmpdir(), 'rfc117-claude-'))
    try {
      fn(dir)
    } finally {
      rimrafDir(dir)
    }
  }

  test('argv = claude -p stream-json + --model + --append-system-prompt-file; stdin pipes prompt', () => {
    withTmp((dir) => {
      const plan = claudeCodeDriver.buildSpawn({ ...BASE, runDir: dir })
      expect(plan.cmd.slice(0, 6)).toEqual([
        'claude',
        '-p',
        '--output-format',
        'stream-json',
        '--verbose',
        '--permission-mode',
      ])
      expect(plan.cmd).toContain('bypassPermissions')
      expect(plan.cmd).toContain('--model')
      expect(plan.cmd).toContain('anthropic/claude-haiku')
      expect(plan.cmd).toContain('--append-system-prompt-file')
      expect(plan.stdin).toEqual({ mode: 'pipe', data: 'USER PROMPT' })
    })
  })

  test('persona written to the --append-system-prompt-file target', () => {
    withTmp((dir) => {
      const plan = claudeCodeDriver.buildSpawn({ ...BASE, runDir: dir })
      const idx = plan.cmd.indexOf('--append-system-prompt-file')
      const file = plan.cmd[idx + 1]!
      expect(readFileSync(file, 'utf-8')).toBe('PERSONA TEXT')
    })
  })

  test('runtimeBinary overrides the claude head', () => {
    withTmp((dir) => {
      const plan = claudeCodeDriver.buildSpawn({
        ...BASE,
        runDir: dir,
        runtimeBinary: '/opt/my-cc',
      })
      expect(plan.cmd[0]).toBe('/opt/my-cc')
    })
  })

  test('model null → no --model flag (claude default)', () => {
    withTmp((dir) => {
      const plan = claudeCodeDriver.buildSpawn({ ...BASE, runDir: dir, model: null })
      expect(plan.cmd).not.toContain('--model')
    })
  })

  // Regression lock: claude ≥2.x exits 1 ("--dangerously-skip-permissions cannot
  // be used with root/sudo privileges") on bypassPermissions when getuid()===0
  // and env.IS_SANDBOX !== '1' (exact-string check). Root daemons could not run
  // ANY claude-code node/smoke/distiller spawn without injecting the flag; the
  // uid gate keeps non-root env pristine (Codex P1: never spoof where the gate
  // wouldn't fire). CI is never uid 0, so the root branch is pinned via the
  // pure-function oracle and the spread-order source assert below.
  test('claudeSandboxEnv: IS_SANDBOX=1 iff uid 0 (root bypassPermissions gate)', () => {
    expect(claudeSandboxEnv(0)).toEqual({ IS_SANDBOX: '1' })
    expect(claudeSandboxEnv(501)).toEqual({})
    expect(claudeSandboxEnv(undefined)).toEqual({})
  })

  test('env: IS_SANDBOX follows the uid gate, no unconditional spoof', () => {
    withTmp((dir) => {
      const prev = process.env.IS_SANDBOX
      delete process.env.IS_SANDBOX
      try {
        const got = claudeCodeDriver.buildSpawn({ ...BASE, runDir: dir }).env.IS_SANDBOX
        if (process.getuid?.() === 0) expect(got).toBe('1')
        else expect(got).toBeUndefined()
      } finally {
        if (prev !== undefined) process.env.IS_SANDBOX = prev
      }
    })
  })

  // Source-level bottom line for the branch CI cannot execute (uid 0): the
  // helper must be spread AFTER the static env keys, so a root daemon's
  // injected '1' overrides an inherited IS_SANDBOX=0 instead of losing to it.
  test('source: claudeSandboxEnv spread after CLAUDE_CONFIG_DIR (override precedence)', () => {
    const src = readFileSync(
      join(import.meta.dir, '../src/services/runtime/claudeCode/spawn.ts'),
      'utf-8',
    )
    const anchor = src.indexOf('CLAUDE_CONFIG_DIR: configDir')
    const spread = src.indexOf('...claudeSandboxEnv(process.getuid?.())')
    expect(anchor).toBeGreaterThan(-1)
    expect(spread).toBeGreaterThan(anchor)
  })
})
