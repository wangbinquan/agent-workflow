// RFC-281 T2/T3 — the claude business spawn carries the workspace WRITE
// boundary as a per-run settings file.
//
// Why this file exists (do not delete on refactor): the production incident
// (design/RFC-281 §1) was an agent working inside a SIBLING task's worktree.
// On claude the fence is Claude Code's own sandbox: `write = cwd + tmp +
// allowWrite`, which refuses sibling worktrees by default (T0 §5-2, measured on
// claude 2.1.227 + macOS Seatbelt with appHome under $HOME).
//
// Two invariants are locked here, both of them "do not break business work"
// rules from proposal §0 rather than hardening rules:
//   1. the settings file NEVER contains denyWrite / denyRead / a deny list — an
//      appHome-ancestor denyWrite shadows the agent's OWN cwd (measured), i.e.
//      the "safer" shape is the one that kills every task;
//   2. an undeclared-permission node keeps its historical argv apart from the
//      added `--settings` (RFC-242 contract untouched).

import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent, Mcp, Plugin } from '@agent-workflow/shared'
import type { RuntimeProfile } from '@/services/runtimeRegistry'
import { claudeCodeDriver } from '@/services/runtime/claudeCode/driver'

const OWN = '/home/aw/iso/taskA/run1'
const SIBLING_ROOT = '/home/aw/iso'

interface CtxOpts {
  runRoot: string
  extraArgs?: readonly string[]
  taskMounts?: readonly string[]
  hostProbe?: { platform: NodeJS.Platform; hasExecutable: (bin: string) => boolean }
  warns?: Array<{ event: string; fields: Record<string, unknown> }>
}

function businessCtx(permission: Record<string, unknown>, opts: CtxOpts): never {
  return {
    agent: {
      id: 'a1',
      name: 'claude-agent',
      description: 'd',
      bodyMd: 'BODY',
      outputs: [],
      permission,
      skills: [],
      plugins: [],
    } as unknown as Agent,
    prompt: 'P',
    injectedMemoryBlock: null,
    dependents: [] as readonly Agent[],
    mcps: [] as readonly Mcp[],
    plugins: [] as readonly Plugin[],
    resolvedParamsByAgent:
      opts.extraArgs === undefined
        ? new Map<string, RuntimeProfile>()
        : // 生产里 extraArgs 来自 runtime profile（runtime 行的 extra_args_json），
          // 不是 spawn ctx —— fixture 必须走同一条路，否则测的是不存在的形态。
          new Map<string, RuntimeProfile>([
            ['claude-agent', { extraArgs: opts.extraArgs } as unknown as RuntimeProfile],
          ]),
    skills: [],
    worktreePath: OWN,
    taskMounts: opts.taskMounts ?? [OWN],
    runRoot: opts.runRoot,
    configDir: { env: 'CLAUDE_CONFIG_DIR', name: '.claude' },
    wantsInventory: false,
    nodeRunId: 'nr-1',
    runtimeCmd: ['bun', 'run', 'mock'],
    ...(opts.hostProbe === undefined ? {} : { boundaryHostProbe: opts.hostProbe }),
    log: {
      warn: (event: string, fields: Record<string, unknown>) => {
        opts.warns?.push({ event, fields })
      },
      info: () => {},
      error: () => {},
      debug: () => {},
    },
  } as never
}

function readSettings(cmd: readonly string[]): Record<string, unknown> {
  const at = cmd.indexOf('--settings')
  expect(at).toBeGreaterThan(-1)
  const file = cmd[at + 1]!
  expect(existsSync(file)).toBe(true)
  return JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>
}

describe('RFC-281 T2/T3 — claude per-run settings carry the write boundary', () => {
  test('the spawn writes a settings file and passes it via --settings', async () => {
    const runRoot = mkdtempSync(join(tmpdir(), 'aw-rfc281-claude-'))
    const plan = await claudeCodeDriver.buildBusinessSpawn(businessCtx({}, { runRoot }))
    const settings = readSettings(plan.cmd) as {
      sandbox?: { enabled?: boolean; filesystem?: { allowWrite?: string[] } }
    }
    expect(settings.sandbox?.enabled).toBe(true)
    // the agent's own worktree is the writable workspace
    expect(settings.sandbox?.filesystem?.allowWrite).toEqual([OWN])
  })

  test('NEVER emits denyWrite/denyRead — that shape would shadow the agent’s own cwd', async () => {
    const runRoot = mkdtempSync(join(tmpdir(), 'aw-rfc281-claude-'))
    const plan = await claudeCodeDriver.buildBusinessSpawn(businessCtx({}, { runRoot }))
    const raw = JSON.stringify(readSettings(plan.cmd))
    expect(raw).not.toContain('denyWrite')
    expect(raw).not.toContain('denyRead')
    // and never governs the appHome ancestor itself
    expect(raw).not.toContain(`"${SIBLING_ROOT}"`)
  })

  test('multi-repo mounts are all writable (business must not be fenced off)', async () => {
    const runRoot = mkdtempSync(join(tmpdir(), 'aw-rfc281-claude-'))
    const mounts = [OWN, '/home/aw/iso/taskA/run1-repoB']
    const plan = await claudeCodeDriver.buildBusinessSpawn(
      businessCtx({}, { runRoot, taskMounts: mounts }),
    )
    const settings = readSettings(plan.cmd) as {
      sandbox?: { filesystem?: { allowWrite?: string[] } }
    }
    expect(settings.sandbox?.filesystem?.allowWrite).toEqual(mounts)
  })

  test('a declared-permission node also gets additionalDirectories (B4: dontAsk reads)', async () => {
    const runRoot = mkdtempSync(join(tmpdir(), 'aw-rfc281-claude-'))
    const mounts = [OWN, '/home/aw/iso/taskA/run1-repoB']
    const plan = await claudeCodeDriver.buildBusinessSpawn(
      businessCtx({ read: 'allow', edit: 'allow' }, { runRoot, taskMounts: mounts }),
    )
    const settings = readSettings(plan.cmd) as {
      permissions?: { additionalDirectories?: string[] }
    }
    expect(plan.cmd).toContain('dontAsk')
    expect(settings.permissions?.additionalDirectories).toEqual(mounts)
  })

  test('the author’s literal external_directory dirs become writable on claude (T4)', async () => {
    const runRoot = mkdtempSync(join(tmpdir(), 'aw-rfc281-claude-'))
    const plan = await claudeCodeDriver.buildBusinessSpawn(
      businessCtx(
        { read: 'allow', external_directory: { '/home/me/refrepo/*': 'allow', '/a/*/b': 'allow' } },
        { runRoot },
      ),
    )
    const settings = readSettings(plan.cmd) as {
      sandbox?: { filesystem?: { allowWrite?: string[] } }
    }
    // literal dir honored; the mid-pattern glob is disclosed via a warning
    // (claude-external-directory-glob-unsupported) rather than silently granted.
    expect(settings.sandbox?.filesystem?.allowWrite).toEqual([OWN, '/home/me/refrepo'])
  })

  test('an undeclared node keeps its historical argv apart from --settings (RFC-242 intact)', async () => {
    const runRoot = mkdtempSync(join(tmpdir(), 'aw-rfc281-claude-'))
    const plan = await claudeCodeDriver.buildBusinessSpawn(businessCtx({}, { runRoot }))
    expect(plan.cmd).toContain('bypassPermissions')
    expect(plan.cmd).not.toContain('--tools')
    const withoutSettings = plan.cmd.filter(
      (a, i) => a !== '--settings' && plan.cmd[i - 1] !== '--settings',
    )
    expect(withoutSettings).not.toContain('--settings')
  })
})

describe('RFC-281 AC-6 — degrade loudly, never block (impl-gate P2-7)', () => {
  test('a host without the sandbox mechanism still spawns, and says so', async () => {
    const runRoot = mkdtempSync(join(tmpdir(), 'aw-rfc281-claude-'))
    const warns: Array<{ event: string; fields: Record<string, unknown> }> = []
    const plan = await claudeCodeDriver.buildBusinessSpawn(
      businessCtx(
        {},
        {
          runRoot,
          warns,
          // linux without bwrap/socat = the real degraded host
          hostProbe: { platform: 'linux', hasExecutable: () => false },
        },
      ),
    )
    // §0: the node RUNS. A missing fence must never block business work.
    expect(plan.cmd.length).toBeGreaterThan(0)
    const warn = warns.find((w) => w.event === 'claude-workspace-boundary-unavailable')
    expect(warn).toBeDefined()
    expect(String(warn?.fields.reason)).toContain('missing-dependencies')
  })

  test('a capable host emits no unavailability warning', async () => {
    const runRoot = mkdtempSync(join(tmpdir(), 'aw-rfc281-claude-'))
    const warns: Array<{ event: string; fields: Record<string, unknown> }> = []
    await claudeCodeDriver.buildBusinessSpawn(
      businessCtx(
        {},
        { runRoot, warns, hostProbe: { platform: 'darwin', hasExecutable: () => true } },
      ),
    )
    expect(warns.find((w) => w.event === 'claude-workspace-boundary-unavailable')).toBeUndefined()
  })

  test('an author glob that claude cannot express is disclosed, not silently dropped', async () => {
    const runRoot = mkdtempSync(join(tmpdir(), 'aw-rfc281-claude-'))
    const warns: Array<{ event: string; fields: Record<string, unknown> }> = []
    await claudeCodeDriver.buildBusinessSpawn(
      businessCtx({ read: 'allow', external_directory: { '/a/*/b': 'allow' } }, { runRoot, warns }),
    )
    const warn = warns.find((w) => w.event === 'claude-external-directory-glob-unsupported')
    expect(warn).toBeDefined()
    expect(warn?.fields.patterns).toEqual(['/a/*/b'])
  })
})

describe('RFC-281 P2-4 — stored extraArgs cannot override the boundary', () => {
  test('a legacy `--settings` in extraArgs is dropped and reported', async () => {
    const runRoot = mkdtempSync(join(tmpdir(), 'aw-rfc281-claude-'))
    const warns: Array<{ event: string; fields: Record<string, unknown> }> = []
    const plan = await claudeCodeDriver.buildBusinessSpawn(
      businessCtx(
        {},
        { runRoot, warns, extraArgs: ['--settings', '/ops/mine.json', '--skip-safe-check'] },
      ),
    )
    // exactly ONE --settings survives, and it is the platform's per-run file
    // (extraArgs land at the tail, so an un-dropped operator file would win).
    const settingsIdx = plan.cmd.reduce<number[]>(
      (acc, a, i) => (a === '--settings' ? [...acc, i] : acc),
      [],
    )
    expect(settingsIdx).toHaveLength(1)
    expect(plan.cmd[settingsIdx[0]! + 1]).toContain(runRoot)
    expect(plan.cmd).not.toContain('/ops/mine.json')
    // an unrelated fork flag is untouched
    expect(plan.cmd).toContain('--skip-safe-check')
    const warn = warns.find((w) => w.event === 'claude-extra-args-platform-owned-dropped')
    expect(warn?.fields.dropped).toEqual(['--settings', '/ops/mine.json'])
  })

  test('the =-joined spelling is dropped too', async () => {
    const runRoot = mkdtempSync(join(tmpdir(), 'aw-rfc281-claude-'))
    const plan = await claudeCodeDriver.buildBusinessSpawn(
      businessCtx({}, { runRoot, extraArgs: ['--settings=/ops/mine.json'] }),
    )
    expect(plan.cmd).not.toContain('--settings=/ops/mine.json')
  })
})
