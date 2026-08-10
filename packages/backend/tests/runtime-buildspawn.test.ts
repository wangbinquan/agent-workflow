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
import { buildClaudeMcpTestSpawn } from '@/services/runtime/claudeCode/mcpTest'
import type { McpTestSpawnContext, SystemAgentSpawnContext } from '@/services/runtime/types'
import { createLogger } from '@/util/log'

const BASE: SystemAgentSpawnContext = {
  agentName: 'aw-memory-distiller',
  systemPrompt: 'PERSONA TEXT',
  model: 'anthropic/claude-haiku',
  prompt: 'USER PROMPT',
  worktreePath: '/tmp/wt',
  runDir: '/tmp/run',
}

describe('opencodeDriver.buildSpawn (RFC-117 system agent)', () => {
  test('argv = opencode run/--agent/--format json/--thinking/--auto/-- <prompt>; stdin ignored', async () => {
    const plan = await opencodeDriver.buildSpawn(BASE)
    // Prompt is the trailing positional after `--` (opencode strict-parser safety
    // for `-`-leading prompts) — see runtime/opencode/spawn.ts buildCommand.
    expect(plan.cmd).toEqual([
      'opencode',
      'run',
      '--agent',
      'aw-memory-distiller',
      '--format',
      'json',
      '--thinking',
      '--auto',
      '--',
      'USER PROMPT',
    ])
    expect(plan.stdin).toEqual({ mode: 'ignore' })
  })

  test('inline config carries persona prompt + model only (no skills/mcp/plugins)', async () => {
    const plan = await opencodeDriver.buildSpawn(BASE)
    const inline = JSON.parse(plan.env.OPENCODE_CONFIG_CONTENT!)
    expect(inline).toEqual({
      agent: {
        'aw-memory-distiller': { prompt: 'PERSONA TEXT', model: 'anthropic/claude-haiku' },
      },
    })
    expect(plan.env.OPENCODE_CONFIG_DIR).toBe('/tmp/run')
    expect(plan.env.PWD).toBe('/tmp/wt')
  })

  test('model null/empty → inline config omits model (runtime default)', async () => {
    const inlineNull = JSON.parse(
      (await opencodeDriver.buildSpawn({ ...BASE, model: null })).env.OPENCODE_CONFIG_CONTENT!,
    )
    expect(inlineNull.agent['aw-memory-distiller']).toEqual({ prompt: 'PERSONA TEXT' })
    const inlineEmpty = JSON.parse(
      (await opencodeDriver.buildSpawn({ ...BASE, model: '' })).env.OPENCODE_CONFIG_CONTENT!,
    )
    expect(inlineEmpty.agent['aw-memory-distiller']).toEqual({ prompt: 'PERSONA TEXT' })
  })

  test('runtimeBinary overrides the opencode head (RFC-112 custom fork)', async () => {
    const plan = await opencodeDriver.buildSpawn({ ...BASE, runtimeBinary: '/opt/my-oc' })
    expect(plan.cmd[0]).toBe('/opt/my-oc')
    expect(plan.cmd[1]).toBe('run')
    // prompt stays the trailing positional after `--`
    expect(plan.cmd.slice(-2)).toEqual(['--', 'USER PROMPT'])
  })

  // IS_SANDBOX is a Claude CLI compatibility marker and is not part of the
  // OpenCode environment contract.
  test('does NOT inject the Claude-only IS_SANDBOX compatibility marker', async () => {
    const prev = process.env.IS_SANDBOX
    delete process.env.IS_SANDBOX
    try {
      expect((await opencodeDriver.buildSpawn(BASE)).env.IS_SANDBOX).toBeUndefined()
    } finally {
      if (prev !== undefined) process.env.IS_SANDBOX = prev
    }
  })
})

describe('claudeCodeDriver.buildSpawn (RFC-117 system agent)', () => {
  // claude buildSpawn writes a system-prompt file + config dir under runDir.
  async function withTmp(fn: (dir: string) => Promise<void>): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), 'rfc117-claude-'))
    try {
      await fn(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  test('argv = claude -p stream-json + --model + --append-system-prompt-file; stdin pipes prompt', async () => {
    await withTmp(async (dir) => {
      const plan = await claudeCodeDriver.buildSpawn({ ...BASE, runDir: dir })
      expect(plan.cmd.slice(0, 6)).toEqual([
        'claude',
        '-p',
        '--output-format',
        'stream-json',
        '--verbose',
        '--permission-mode',
      ])
      expect(plan.cmd).toContain('bypassPermissions')
      expect(plan.cmd).not.toContain('dontAsk')
      expect(plan.cmd).not.toContain('--tools')
      expect(plan.cmd).toContain('--model')
      expect(plan.cmd).toContain('anthropic/claude-haiku')
      expect(plan.cmd).toContain('--append-system-prompt-file')
      expect(plan.stdin).toEqual({ mode: 'pipe', data: 'USER PROMPT' })
    })
  })

  test('persona written to the --append-system-prompt-file target', async () => {
    await withTmp(async (dir) => {
      const plan = await claudeCodeDriver.buildSpawn({ ...BASE, runDir: dir })
      const idx = plan.cmd.indexOf('--append-system-prompt-file')
      const file = plan.cmd[idx + 1]!
      expect(readFileSync(file, 'utf-8')).toBe('PERSONA TEXT')
    })
  })

  test('probe and system calls share the natural argv shape', async () => {
    await withTmp(async (dir) => {
      const plan = await claudeCodeDriver.buildSpawn({
        ...BASE,
        runDir: dir,
      })
      expect(plan.cmd).toContain('bypassPermissions')
      expect(plan.cmd).not.toContain('dontAsk')
      expect(plan.cmd).not.toContain('--tools')
      expect(plan.cmd).not.toContain('--setting-sources')
      expect(plan.cmd).not.toContain('--disable-slash-commands')
      // model still flows — probe fidelity is about the SHAPE, not the profile.
      expect(plan.cmd).toContain('--model')
    })
  })

  test('runtimeBinary overrides the claude head', async () => {
    await withTmp(async (dir) => {
      const plan = await claudeCodeDriver.buildSpawn({
        ...BASE,
        runDir: dir,
        runtimeBinary: '/opt/my-cc',
      })
      expect(plan.cmd[0]).toBe('/opt/my-cc')
    })
  })

  test('model null → no --model flag (claude default)', async () => {
    await withTmp(async (dir) => {
      const plan = await claudeCodeDriver.buildSpawn({ ...BASE, runDir: dir, model: null })
      expect(plan.cmd).not.toContain('--model')
    })
  })

  test('env: IS_SANDBOX is default-off, scrubs ambient state, and explicit-on injects 1', async () => {
    await withTmp(async (dir) => {
      const prev = process.env.IS_SANDBOX
      process.env.IS_SANDBOX = 'ambient'
      try {
        const off = await claudeCodeDriver.buildSpawn({ ...BASE, runDir: dir })
        expect(off.env.IS_SANDBOX).toBeUndefined()
        const on = await claudeCodeDriver.buildSpawn({ ...BASE, runDir: dir, isSandbox: true })
        expect(on.env.IS_SANDBOX).toBe('1')
      } finally {
        if (prev === undefined) delete process.env.IS_SANDBOX
        else process.env.IS_SANDBOX = prev
      }
    })
  })

  test('source: runtime-controlled IS_SANDBOX assignment follows ambient scrubbing', () => {
    const src = readFileSync(
      join(import.meta.dir, '../src/services/runtime/claudeCode/spawn.ts'),
      'utf-8',
    )
    const inherit = src.indexOf('for (const [key, value] of Object.entries(source))')
    const scrub = src.indexOf("key.toUpperCase() === 'IS_SANDBOX'")
    const toggle = src.indexOf('assembly.isSandbox === true')
    const marker = src.indexOf("env.IS_SANDBOX = '1'")
    expect(inherit).toBeGreaterThan(-1)
    expect(scrub).toBeGreaterThan(inherit)
    expect(toggle).toBeGreaterThan(scrub)
    expect(marker).toBeGreaterThan(toggle)
  })

  test('MCP-test Claude spawn consumes the same default-off runtime toggle', async () => {
    await withTmp(async (dir) => {
      const base: McpTestSpawnContext = {
        sessionId: 'session-1',
        turnId: 'turn-1',
        agentName: 'mcp-test',
        systemPrompt: 'MCP TEST',
        prompt: 'PING',
        executionMaterial: {
          codec: 'mcp-test-execution-material-v1',
          mcpId: 'mcp-1',
          runtimeKey: 'fixture',
          type: 'local',
          opencodeEntry: {},
          claudeEntry: { command: 'fixture' },
          root: dir,
        },
        model: null,
        worktreePath: '/tmp/wt',
        sessionRoot: dir,
        runDir: join(dir, 'off'),
        configDir: { env: 'CLAUDE_CONFIG_DIR', name: '.claude' },
        log: createLogger('runtime-buildspawn-test'),
      }
      const off = await buildClaudeMcpTestSpawn(base)
      expect(off.env.IS_SANDBOX).toBeUndefined()
      await off.cleanup?.()

      const on = await buildClaudeMcpTestSpawn({
        ...base,
        runDir: join(dir, 'on'),
        isSandbox: true,
      })
      expect(on.env.IS_SANDBOX).toBe('1')
      await on.cleanup?.()
    })
  })
})
