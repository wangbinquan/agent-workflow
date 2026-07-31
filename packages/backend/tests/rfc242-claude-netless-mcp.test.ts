// RFC-242 T5 (PR-3) — locks the platform no-network boundary for a CONTROLLED
// Claude Code business node's local MCP children (design §4, decision C-1).
//
// Why these tests exist. Before T5, claude handed the raw MCP `command`/`args`
// to `--mcp-config`, so every model-controlled MCP child inherited full network
// AND the daemon's whole environment — while the opencode path had fenced the
// same surface since RFC-224. The regressions each case guards:
//
//  1. the demand: only a controlled node WITH an enabled local MCP may raise the
//     containment profile. Raising it for an unconstrained node would let
//     `sandboxMode=enforce` block a launch that works today (user decision
//     2026-07-31: existing workflows must not break);
//  2. the materialization: claude must be told to fork the 0500 wrapper, never
//     the raw command, and the real command/env must live in the 0400 manifest
//     instead of in argv;
//  3. the escape hatch stays open: an unconstrained node keeps the byte-exact
//     historical shape, remote MCP is untouched on both paths;
//  4. fail-closed: a controlled node that reached materialization without an
//     admission must fail, never silently run its MCP unfenced.
//
// A red test here means the claude runtime lost network parity with opencode.

import { afterEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DEFAULT_CONFIG_DIR_PROFILE, type Agent, type Mcp } from '@agent-workflow/shared'
import { ContainmentCoordinator, type PreparedContainmentPlan } from '../src/services/sandbox'
import { createInMemoryDb } from '../src/db/client'
import { nodeRuns, tasks, workflows } from '../src/db/schema'
import { runNode } from '../src/services/runner'
import { getRuntimeDriver } from '../src/services/runtime'
import { claudeCodeDriver } from '../src/services/runtime/claudeCode/driver'
import { ExecutionIdentityFailure } from '../src/services/runtime/opencode/failure'
import type { BusinessNodeSpawnContext, SpawnPlan } from '../src/services/runtime/types'
import { toClaudeMcpConfig } from '../src/services/runtime/claudeCode/inject'
import { materializeClaudeNetlessMcp } from '../src/services/runtime/claudeCode/netlessMcp'
import { NetlessSubprocessManifestSchema } from '../src/services/runtime/opencode/sealedSubprocess'
import { createLogger } from '../src/util/log'
import type { RuntimeProfile } from '../src/services/runtimeRegistry'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const tempDirs: string[] = []
const log = createLogger('rfc242-t5-test')

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function root(prefix: string): string {
  const value = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  tempDirs.push(value)
  return value
}

async function admitContainment(appHome: string): Promise<PreparedContainmentPlan> {
  const coordinator =
    process.platform === 'linux'
      ? new ContainmentCoordinator({
          provider: {
            mode: 'enforce',
            status: { mechanism: 'bwrap', available: true, detail: null },
            appHome,
          },
          qualifyBwrap: async () => '/usr/bin/bwrap',
        })
      : new ContainmentCoordinator({
          provider: {
            mode: 'enforce',
            status: { mechanism: 'seatbelt', available: true, detail: null },
            appHome,
          },
          qualifySeatbelt: async () => {},
        })
  return coordinator.admit('model-child-netless-v1')
}

function mkAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-claude',
    name: 'claude-agent',
    description: 'desc',
    outputs: ['result'],
    syncOutputsOnIterate: true,
    // A FENCED node by default: controlled (declares permission) and it does NOT
    // grant Bash — see claudeLocalMcpFenceDecision for why Bash excludes the
    // fence. `bashAgent()` below is the other side of that rule.
    permission: { read: 'allow', edit: 'allow' },
    skills: [],
    dependsOn: [],
    mcp: [],
    plugins: [],
    frontmatterExtra: {},
    bodyMd: '## persona',
    schemaVersion: 1,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

function bashAgent(): Agent {
  return mkAgent({ permission: { read: 'allow', bash: 'allow' } })
}

function localMcp(
  name: string,
  command: string[],
  overrides: { enabled?: boolean; env?: Record<string, string> } = {},
): Mcp {
  return {
    id: 'mcp-' + name,
    name,
    description: '',
    type: 'local',
    config: {
      command,
      ...(overrides.env === undefined ? {} : { env: overrides.env }),
    } as Extract<Mcp, { type: 'local' }>['config'],
    enabled: overrides.enabled ?? true,
    schemaVersion: 1,
    createdAt: 0,
    updatedAt: 0,
  }
}

function remoteMcp(name: string): Mcp {
  return {
    id: 'mcp-' + name,
    name,
    description: '',
    type: 'remote',
    config: { url: 'https://example.test/mcp', headers: { Authorization: 'Bearer secret' } },
    enabled: true,
    schemaVersion: 1,
    createdAt: 0,
    updatedAt: 0,
  }
}

/** A real, executable file so realpath/lstat/snapshot checks see a regular file. */
function mkExecutable(dir: string, name: string, body: string): string {
  mkdirSync(dir, { recursive: true })
  const path = join(dir, name)
  writeFileSync(path, body)
  chmodSync(path, 0o755)
  return path
}

interface Fixture {
  base: string
  appHome: string
  worktreePath: string
  runRoot: string
  claudeBinary: string
}

function fixture(prefix: string): Fixture {
  const base = root(prefix)
  const appHome = join(base, 'app-home')
  const worktreePath = join(base, 'worktree')
  const runRoot = join(appHome, 'runs', 'task-1', 'nr-1')
  for (const dir of [appHome, worktreePath, runRoot]) mkdirSync(dir, { recursive: true })
  // A stand-in for the claude binary: buildBusinessSpawn byte-freezes the head
  // of a controlled node, so it must be a real single-token executable.
  const claudeBinary = mkExecutable(join(base, 'bin'), 'claude', '#!/bin/sh\nexit 0\n')
  return { base, appHome, worktreePath, runRoot, claudeBinary }
}

function mkCtx(
  f: Fixture,
  overrides: Partial<BusinessNodeSpawnContext> = {},
): BusinessNodeSpawnContext {
  return {
    agent: mkAgent(),
    prompt: 'PROMPT',
    injectedMemoryBlock: null,
    dependents: [],
    mcps: [],
    plugins: [],
    resolvedParamsByAgent: new Map<string, RuntimeProfile>(),
    skills: [],
    worktreePath: f.worktreePath,
    repoWorktreePaths: [f.worktreePath],
    runRoot: f.runRoot,
    configDir: DEFAULT_CONFIG_DIR_PROFILE['claude-code'],
    runtimeBinary: f.claudeBinary,
    wantsInventory: false,
    nodeRunId: 'nr-1',
    appHome: f.appHome,
    taskId: 'task-1',
    nodeId: 'node-1',
    log,
    ...overrides,
  }
}

/** The `--mcp-config` value out of an assembled argv. */
function mcpConfigOf(cmd: readonly string[]): Record<string, Record<string, unknown>> {
  const index = cmd.lastIndexOf('--mcp-config')
  expect(index).toBeGreaterThan(-1)
  const parsed = JSON.parse(cmd[index + 1]!) as {
    mcpServers: Record<string, Record<string, unknown>>
  }
  return parsed.mcpServers
}

describe('RFC-242 T5 — containment demand for claude business nodes', () => {
  const driver = getRuntimeDriver('claude-code')

  test('controlled node with an enabled local MCP demands the model-child bundle', () => {
    expect(
      driver.businessContainmentProfile?.({
        agent: mkAgent(),
        mcps: [localMcp('search', ['/usr/bin/true'])],
      }),
    ).toBe('model-child-netless-v1')
  })

  test('an UNCONSTRAINED node keeps the filesystem-only demand even with local MCP', () => {
    // User decision 2026-07-31: raising the demand here would make
    // sandboxMode=enforce block launches that work today.
    expect(
      driver.businessContainmentProfile?.({
        agent: mkAgent({ permission: {} }),
        mcps: [localMcp('search', ['/usr/bin/true'])],
      }),
    ).toBe('runner-filesystem-v1')
  })

  test('remote-only and disabled-local MCP stay on the filesystem-only demand', () => {
    expect(
      driver.businessContainmentProfile?.({ agent: mkAgent(), mcps: [remoteMcp('api')] }),
    ).toBe('runner-filesystem-v1')
    expect(
      driver.businessContainmentProfile?.({
        agent: mkAgent(),
        mcps: [localMcp('off', ['/usr/bin/true'], { enabled: false })],
      }),
    ).toBe('runner-filesystem-v1')
    expect(driver.businessContainmentProfile?.({ agent: mkAgent(), mcps: [] })).toBe(
      'runner-filesystem-v1',
    )
  })

  test('a node that grants Bash keeps the filesystem-only demand', () => {
    // Measured 2026-07-31: nested sandbox-exec is impossible on macOS
    // (`sandbox_apply: Operation not permitted`), so a model-child boundary
    // COSTS the runner's outer sandbox there (RFC-227 provider-child-only).
    // That trade only pays when every model-controlled child is routed through
    // the child launcher — claude's Bash is not (RFC-242 C-2 deferred), so
    // fencing such a node would trade its shell's filesystem containment for its
    // MCP servers' network containment. Net loss ⇒ keep today's outer sandbox.
    expect(
      driver.businessContainmentProfile?.({
        agent: bashAgent(),
        mcps: [localMcp('search', ['/usr/bin/true'])],
      }),
    ).toBe('runner-filesystem-v1')
  })

  test('the demand matches what opencode asks for on the same surface', () => {
    // Parity is the point of RFC-242: a shell-free node whose only
    // model-controlled children are local MCP servers must produce the same
    // requirement bundle on both runtimes.
    const shellFree = mkAgent({ permission: { read: 'allow', bash: 'deny' } })
    const mcps = [localMcp('search', ['/usr/bin/true'])]
    expect(
      getRuntimeDriver('opencode').businessContainmentProfile?.({ agent: shellFree, mcps }),
    ).toBe('model-child-netless-v1')
    expect(driver.businessContainmentProfile?.({ agent: shellFree, mcps })).toBe(
      'model-child-netless-v1',
    )
  })
})

describe('RFC-242 T5 — toClaudeMcpConfig wrapper rewrite', () => {
  test('a wrapped local entry forks the wrapper and carries NO env into argv', () => {
    const config = toClaudeMcpConfig(
      [localMcp('search', ['/usr/bin/env', 'server'], { env: { TOKEN: 'super-secret' } })],
      new Map([['search', '/private/run/wrapper']]),
    )
    expect(config?.mcpServers.search).toEqual({ command: '/private/run/wrapper', args: [] })
    // The secret must not survive anywhere in the inline JSON (it is in the
    // 0400 manifest instead of every `ps` listing on the host).
    expect(JSON.stringify(config)).not.toContain('super-secret')
  })

  test('unwrapped local + remote entries keep their historical shape', () => {
    const config = toClaudeMcpConfig(
      [localMcp('search', ['uvx', 'search-mcp'], { env: { TOKEN: 't' } }), remoteMcp('api')],
      new Map(),
    )
    expect(config?.mcpServers.search).toEqual({
      command: 'uvx',
      args: ['search-mcp'],
      env: { TOKEN: 't' },
    })
    expect(config?.mcpServers.api).toEqual({
      type: 'http',
      url: 'https://example.test/mcp',
      headers: { Authorization: 'Bearer secret' },
    })
  })

  test('a wrapper map never rewrites a remote entry', () => {
    const config = toClaudeMcpConfig([remoteMcp('api')], new Map([['api', '/private/wrapper']]))
    expect(config?.mcpServers.api).toEqual({
      type: 'http',
      url: 'https://example.test/mcp',
      headers: { Authorization: 'Bearer secret' },
    })
  })

  test('omitting the map is byte-identical to the pre-T5 behavior', () => {
    const mcps = [localMcp('search', ['uvx', 'search-mcp'], { env: { TOKEN: 't' } })]
    expect(JSON.stringify(toClaudeMcpConfig(mcps))).toBe(
      JSON.stringify(toClaudeMcpConfig(mcps, new Map())),
    )
  })
})

describe('RFC-242 T5 — materializeClaudeNetlessMcp', () => {
  test('freezes a 0500 wrapper + 0400 manifest carrying the real command and env', async () => {
    const f = fixture('rfc242-netless-mat-')
    const server = mkExecutable(join(f.base, 'mcp'), 'server', '#!/bin/sh\nexit 0\n')
    const containment = await admitContainment(f.appHome)

    const result = await materializeClaudeNetlessMcp({
      mcps: [localMcp('search', [server, '--stdio'], { env: { TOKEN: 'secret-token' } })],
      containment,
      runRoot: f.runRoot,
      worktreePath: f.worktreePath,
      appHome: f.appHome,
      repoWorktreePaths: [f.worktreePath],
      log,
      sourceEnv: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' },
    })

    const wrapperPath = result.wrapperByName.get('search')
    expect(wrapperPath).toBeDefined()
    expect(statSync(wrapperPath!).mode & 0o777).toBe(0o500)
    // The wrapper re-enters THIS binary's hidden netless subcommand — the same
    // one opencode's local MCP already uses (design §4.2: zero new mechanism).
    const script = readFileSync(wrapperPath!, 'utf8')
    expect(script).toStartWith('#!/bin/sh\n')
    expect(script).toContain('__opencode-netless-subprocess')
    expect(script).toContain('--manifest')

    const manifestPath = join(f.runRoot, 'claude-mcp-seal', 'search', 'netless.json')
    expect(statSync(manifestPath).mode & 0o777).toBe(0o400)
    const manifest = NetlessSubprocessManifestSchema.parse(
      JSON.parse(readFileSync(manifestPath, 'utf8')),
    )
    expect(manifest.mode).toBe('mcp')
    expect(manifest.command).toEqual([realpathSync(server), '--stdio'])
    // The provider plan is the ADMITTED one, never re-derived from the OS.
    expect(manifest.provider).toEqual(containment.childProvider)
    expect(manifest.provider.providerId).not.toBe('none')
    expect(manifest.env.TOKEN).toBe('secret-token')
    expect(manifest.env.HOME).toBe(join(f.runRoot, 'claude-mcp-scratch', 'home'))
    expect(manifest.env.TMPDIR).toBe(join(f.runRoot, 'claude-mcp-scratch', 'tmp'))
    expect(manifest.env.PWD).toBe(f.worktreePath)
    expect(manifest.env.PATH).toEndWith('/usr/bin:/bin')
    // Nothing from the daemon's environment leaks in beyond the locale set.
    expect(manifest.env.LANG).toBe('en_US.UTF-8')
    expect(Object.keys(manifest.env).sort()).toEqual([
      'HOME',
      'LANG',
      'PATH',
      'PWD',
      'TMPDIR',
      'TOKEN',
    ])
    // Only the executable INODE is bound back — never its parent directory.
    expect(manifest.bindReadOnly).toEqual([realpathSync(server)])
    // The wrapper seal must NOT sit inside the child's writable scratch: a
    // model-controlled child cannot be allowed to rewrite its own fence.
    expect(wrapperPath!.startsWith(join(f.runRoot, 'claude-mcp-scratch'))).toBe(false)
  })

  test('a bare command token resolves to its canonical absolute path', async () => {
    const f = fixture('rfc242-netless-token-')
    const binDir = join(f.base, 'toolbin')
    const server = mkExecutable(binDir, 'my-mcp', '#!/bin/sh\nexit 0\n')
    const containment = await admitContainment(f.appHome)

    const result = await materializeClaudeNetlessMcp({
      mcps: [localMcp('search', ['my-mcp', '--stdio'])],
      containment,
      runRoot: f.runRoot,
      worktreePath: f.worktreePath,
      appHome: f.appHome,
      log,
      sourceEnv: { PATH: `${binDir}:/usr/bin:/bin` },
    })

    const manifest = NetlessSubprocessManifestSchema.parse(
      JSON.parse(
        readFileSync(join(f.runRoot, 'claude-mcp-seal', 'search', 'netless.json'), 'utf8'),
      ),
    )
    // A bare token cannot resolve inside the boundary (the child's PATH is the
    // fixed netless one), so the manifest must carry the resolved path.
    expect(manifest.command[0]).toBe(realpathSync(server))
    expect(result.wrapperByName.size).toBe(1)
  })

  test('an unresolvable command fails closed instead of shipping an unfenced child', async () => {
    const f = fixture('rfc242-netless-missing-')
    const containment = await admitContainment(f.appHome)
    await expect(
      materializeClaudeNetlessMcp({
        mcps: [localMcp('search', ['definitely-not-on-path-xyz'])],
        containment,
        runRoot: f.runRoot,
        worktreePath: f.worktreePath,
        appHome: f.appHome,
        log,
        sourceEnv: { PATH: '/usr/bin:/bin' },
      }),
    ).rejects.toThrow()
  })

  test("a linked worktree's EXTERNAL git common dir is projected, a plain clone's is not", async () => {
    // Without this projection every `git` call inside the boundary fails: a
    // linked worktree keeps objects/refs/index behind the appHome/HOME masks.
    const f = fixture('rfc242-netless-git-')
    const server = mkExecutable(join(f.base, 'mcp'), 'server', '#!/bin/sh\nexit 0\n')
    const repo = join(f.base, 'repo')
    mkdirSync(repo, { recursive: true })
    const git = async (cwd: string, args: string[]): Promise<void> => {
      const child = Bun.spawn(['git', ...args], { cwd, stdout: 'ignore', stderr: 'ignore' })
      expect(await child.exited).toBe(0)
    }
    await git(repo, ['init', '-q', '-b', 'main'])
    await git(repo, ['config', 'user.email', 'a@b.c'])
    await git(repo, ['config', 'user.name', 'a'])
    writeFileSync(join(repo, 'f.txt'), 'x')
    await git(repo, ['add', '.'])
    await git(repo, ['commit', '-qm', 'init'])
    const linked = join(f.base, 'linked')
    await git(repo, ['worktree', 'add', '-q', linked, '-b', 'wt'])

    const containment = await admitContainment(f.appHome)
    const manifestOf = async (worktreePath: string, repos: string[]): Promise<unknown> => {
      const runRoot = join(f.appHome, 'runs', 'task-1', `nr-${repos.length}-${worktreePath.length}`)
      mkdirSync(runRoot, { recursive: true })
      await materializeClaudeNetlessMcp({
        mcps: [localMcp('search', [server])],
        containment,
        runRoot,
        worktreePath,
        appHome: f.appHome,
        repoWorktreePaths: repos,
        log,
        sourceEnv: { PATH: '/usr/bin:/bin' },
      })
      return NetlessSubprocessManifestSchema.parse(
        JSON.parse(
          readFileSync(join(runRoot, 'claude-mcp-seal', 'search', 'netless.json'), 'utf8'),
        ),
      )
    }

    expect(await manifestOf(linked, [linked])).toMatchObject({
      gitCommonDirs: [realpathSync(join(repo, '.git'))],
    })
    // The plain clone's `.git` lives inside the already-bound worktree — adding
    // it back would be a redundant allow-back, so it must be filtered out.
    expect(await manifestOf(repo, [repo])).toMatchObject({ gitCommonDirs: [] })
  }, 60_000)

  test('a repeated MCP name resolves the same way toClaudeMcpConfig dedupes it', async () => {
    // The wrapper map and the emitted config must agree: rewriting an entry the
    // config never emitted (or vice versa) would unfence one of the two.
    const f = fixture('rfc242-netless-dupe-')
    const first = mkExecutable(join(f.base, 'mcp-a'), 'server', '#!/bin/sh\nexit 0\n')
    const second = mkExecutable(join(f.base, 'mcp-b'), 'server', '#!/bin/sh\nexit 0\n')
    const containment = await admitContainment(f.appHome)
    const mcps = [localMcp('search', [first]), localMcp('search', [second])]
    const result = await materializeClaudeNetlessMcp({
      mcps,
      containment,
      runRoot: f.runRoot,
      worktreePath: f.worktreePath,
      appHome: f.appHome,
      log,
      sourceEnv: { PATH: '/usr/bin:/bin' },
    })
    expect(result.wrapperByName.size).toBe(1)
    const manifest = NetlessSubprocessManifestSchema.parse(
      JSON.parse(
        readFileSync(join(f.runRoot, 'claude-mcp-seal', 'search', 'netless.json'), 'utf8'),
      ),
    )
    expect(manifest.command).toEqual([realpathSync(first)])
    expect(toClaudeMcpConfig(mcps, result.wrapperByName)?.mcpServers.search).toEqual({
      command: result.wrapperByName.get('search')!,
      args: [],
    })
  })

  test('remote-only input materializes nothing', async () => {
    const f = fixture('rfc242-netless-remote-')
    const containment = await admitContainment(f.appHome)
    const result = await materializeClaudeNetlessMcp({
      mcps: [remoteMcp('api')],
      containment,
      runRoot: f.runRoot,
      worktreePath: f.worktreePath,
      appHome: f.appHome,
      log,
    })
    expect(result.wrapperByName.size).toBe(0)
    await result.preSpawnVerify()
  })

  test('preSpawnVerify rejects a manifest tampered with after materialization', async () => {
    const f = fixture('rfc242-netless-toctou-')
    const server = mkExecutable(join(f.base, 'mcp'), 'server', '#!/bin/sh\nexit 0\n')
    const containment = await admitContainment(f.appHome)
    const result = await materializeClaudeNetlessMcp({
      mcps: [localMcp('search', [server])],
      containment,
      runRoot: f.runRoot,
      worktreePath: f.worktreePath,
      appHome: f.appHome,
      log,
      sourceEnv: { PATH: '/usr/bin:/bin' },
    })
    await result.preSpawnVerify() // clean

    const manifestPath = join(f.runRoot, 'claude-mcp-seal', 'search', 'netless.json')
    chmodSync(manifestPath, 0o600)
    writeFileSync(manifestPath, '{"codec":1}')
    await expect(result.preSpawnVerify()).rejects.toThrow()
  })

  test('re-entering the same run root re-materializes instead of colliding', async () => {
    // The wrapper writer is O_EXCL; an inline-clarify rerun keeps its runRoot.
    const f = fixture('rfc242-netless-reentry-')
    const server = mkExecutable(join(f.base, 'mcp'), 'server', '#!/bin/sh\nexit 0\n')
    const containment = await admitContainment(f.appHome)
    const input = {
      mcps: [localMcp('search', [server])],
      containment,
      runRoot: f.runRoot,
      worktreePath: f.worktreePath,
      appHome: f.appHome,
      log,
      sourceEnv: { PATH: '/usr/bin:/bin' },
    }
    const first = await materializeClaudeNetlessMcp(input)
    const second = await materializeClaudeNetlessMcp(input)
    expect(second.wrapperByName.get('search')).toBe(first.wrapperByName.get('search')!)
    await second.preSpawnVerify()
  })
})

describe('RFC-242 T5 — buildBusinessSpawn wiring', () => {
  const driver = getRuntimeDriver('claude-code')

  test('a controlled node points --mcp-config at the wrapper, not the raw command', async () => {
    const f = fixture('rfc242-netless-spawn-')
    const server = mkExecutable(join(f.base, 'mcp'), 'server', '#!/bin/sh\nexit 0\n')
    const containment = await admitContainment(f.appHome)
    const plan = await driver.buildBusinessSpawn(
      mkCtx(f, {
        mcps: [localMcp('search', [server, '--stdio'], { env: { TOKEN: 'secret-token' } })],
        containment,
      }),
    )

    const servers = mcpConfigOf(plan.cmd)
    const wrapperPath = join(f.runRoot, 'claude-mcp-seal', 'search', 'run')
    expect(servers.search).toEqual({ command: wrapperPath, args: [] })
    expect(plan.cmd.join(' ')).not.toContain('secret-token')
    expect(plan.cmd.join(' ')).not.toContain('--stdio')
    // The binary seal (T2) and the MCP fence (T5) share one pre-spawn fence.
    expect(plan.preSpawnVerify).toBeDefined()
    await plan.preSpawnVerify!()
    // Diagnostics still describe the node's MCP surface by NAME, unchanged.
    expect(plan.diagnostics?.mcpKeys).toEqual(['search'])
  })

  test('a Bash-granting node keeps the raw command — the outer sandbox wins', async () => {
    // Materialization must agree with businessContainmentProfile above, or the
    // node would be admitted under one boundary and built for another.
    const f = fixture('rfc242-netless-bash-')
    const server = mkExecutable(join(f.base, 'mcp'), 'server', '#!/bin/sh\nexit 0\n')
    const containment = await admitContainment(f.appHome)
    const plan = await driver.buildBusinessSpawn(
      mkCtx(f, {
        agent: bashAgent(),
        mcps: [localMcp('search', [server, '--stdio'], { env: { TOKEN: 'shell-token' } })],
        containment,
      }),
    )
    expect(mcpConfigOf(plan.cmd).search).toEqual({
      command: server,
      args: ['--stdio'],
      env: { TOKEN: 'shell-token' },
    })
    expect(existsOrNull(join(f.runRoot, 'claude-mcp-seal'))).toBeNull()
    // Still a CONTROLLED node: the tool gate and the sealed binary stay on.
    expect(plan.cmd).toContain('--tools')
    expect(plan.preSpawnVerify).toBeDefined()
  })

  test('a gated node allowlists its own MCP namespaces (dontAsk denies them otherwise)', async () => {
    // MEASURED against claude 2.1.220 on 2026-07-31: without --allowedTools the
    // server connects and every tool call comes back
    // "Permission to use mcp__probe__netprobe has been denied because Claude Code
    // is running in don't ask mode". With the allowlist the same run returned
    // NETPROBE_RESULT net=000 AND a working built-in Read — so the flag buys MCP
    // callability without costing the built-in cwd auto-decision.
    const f = fixture('rfc242-netless-allowed-')
    const server = mkExecutable(join(f.base, 'mcp'), 'server', '#!/bin/sh\nexit 0\n')
    const containment = await admitContainment(f.appHome)
    const plan = await driver.buildBusinessSpawn(
      mkCtx(f, {
        mcps: [localMcp('search', [server]), remoteMcp('api')],
        containment,
      }),
    )
    const at = plan.cmd.indexOf('--allowedTools')
    expect(at).toBeGreaterThan(-1)
    // Exactly this node's namespaces — never a broad `mcp__*`.
    expect(plan.cmd[at + 1]).toBe('mcp__search__*,mcp__api__*')
    // …and it stays inside the declared-control group, before the model/prompt tail.
    expect(at).toBeLessThan(plan.cmd.indexOf('--append-system-prompt-file'))
  })

  test('a gated node with NO MCP emits no allowlist at all', async () => {
    const f = fixture('rfc242-netless-noallow-')
    const containment = await admitContainment(f.appHome)
    const plan = await driver.buildBusinessSpawn(mkCtx(f, { containment }))
    expect(plan.cmd).not.toContain('--allowedTools')
  })

  test('an UNCONSTRAINED node keeps the raw command — no wrapper, no fence', async () => {
    const f = fixture('rfc242-netless-unconstrained-')
    const server = mkExecutable(join(f.base, 'mcp'), 'server', '#!/bin/sh\nexit 0\n')
    const containment = await admitContainment(f.appHome)
    const plan = await driver.buildBusinessSpawn(
      mkCtx(f, {
        agent: mkAgent({ permission: {} }),
        mcps: [localMcp('search', [server, '--stdio'], { env: { TOKEN: 'legacy-token' } })],
        containment,
      }),
    )

    const servers = mcpConfigOf(plan.cmd)
    expect(servers.search).toEqual({
      command: server,
      args: ['--stdio'],
      env: { TOKEN: 'legacy-token' },
    })
    expect(existsOrNull(join(f.runRoot, 'claude-mcp-seal'))).toBeNull()
  })

  test('a controlled node with only REMOTE MCP materializes no wrapper', async () => {
    const f = fixture('rfc242-netless-spawn-remote-')
    const containment = await admitContainment(f.appHome)
    const plan = await driver.buildBusinessSpawn(
      mkCtx(f, { mcps: [remoteMcp('api')], containment }),
    )
    expect(mcpConfigOf(plan.cmd).api).toEqual({
      type: 'http',
      url: 'https://example.test/mcp',
      headers: { Authorization: 'Bearer secret' },
    })
    expect(existsOrNull(join(f.runRoot, 'claude-mcp-seal'))).toBeNull()
  })

  test('a controlled node with local MCP but NO admission fails closed', async () => {
    // Reaching here means businessContainmentProfile already demanded the
    // model-child bundle: a missing admission is a wiring bug, and running the
    // MCP unfenced would be exactly the silent failure RFC-227 forbids.
    const f = fixture('rfc242-netless-noadmit-')
    const server = mkExecutable(join(f.base, 'mcp'), 'server', '#!/bin/sh\nexit 0\n')
    await expect(
      driver.buildBusinessSpawn(mkCtx(f, { mcps: [localMcp('search', [server])] })),
    ).rejects.toThrow()
  })

  test('a mock-head test spawn is untouched (the seam that gates the seal)', async () => {
    const f = fixture('rfc242-netless-mockhead-')
    const server = mkExecutable(join(f.base, 'mcp'), 'server', '#!/bin/sh\nexit 0\n')
    const containment = await admitContainment(f.appHome)
    const plan = await driver.buildBusinessSpawn(
      mkCtx(f, {
        runtimeBinary: null,
        runtimeCmd: ['bun', 'run', '/mock-claude.ts'],
        mcps: [localMcp('search', [server, '--stdio'])],
        containment,
      }),
    )
    expect(mcpConfigOf(plan.cmd).search).toEqual({ command: server, args: ['--stdio'] })
    expect(existsOrNull(join(f.runRoot, 'claude-mcp-seal'))).toBeNull()
  })
})

function existsOrNull(path: string): string | null {
  try {
    statSync(path)
    return path
  } catch {
    return null
  }
}

describe('RFC-242 T5 — the runner actually enforces the pre-spawn fence', () => {
  test('a rejecting preSpawnVerify fails the node BEFORE the runtime starts', async () => {
    // The seal (T2) and the MCP fence (T5) are both re-verified through
    // SpawnPlan.preSpawnVerify. systemAgentRun has awaited it since RFC-237;
    // the business path carried the hook but never called it, so both seals
    // were checked once at build time and then trusted. This case is the lock:
    // if the await disappears, the sentinel binary runs and the node "succeeds".
    const f = fixture('rfc242-netless-fence-')
    const marker = join(f.base, 'child-started.txt')
    const sentinel = mkExecutable(
      join(f.base, 'sentinel'),
      'runtime',
      `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 0\n`,
    )
    const db = createInMemoryDb(MIGRATIONS)
    await db.insert(workflows).values({ id: 'wf-1', name: 'wf-1', definition: '{}' })
    await db.insert(tasks).values({
      id: 'task-1',
      name: 'task-1',
      workflowId: 'wf-1',
      workflowSnapshot: '{}',
      repoPath: f.worktreePath,
      worktreePath: f.worktreePath,
      baseBranch: 'main',
      branch: 'aw/task-1',
      status: 'running',
      inputs: '{}',
      startedAt: 1,
    })
    await db
      .insert(nodeRuns)
      .values({ id: 'nr-fence', taskId: 'task-1', nodeId: 'node-1', status: 'pending' })

    const original = claudeCodeDriver.buildBusinessSpawn
    claudeCodeDriver.buildBusinessSpawn = async (): Promise<SpawnPlan> => ({
      cmd: [sentinel],
      env: {},
      stdin: { mode: 'pipe', data: 'x' },
      preSpawnVerify: async () => {
        throw new ExecutionIdentityFailure('execution-identity-mismatch')
      },
    })
    try {
      const result = await runNode({
        taskId: 'task-1',
        nodeRunId: 'nr-fence',
        nodeId: 'node-1',
        agent: mkAgent(),
        inputs: {},
        worktreePath: f.worktreePath,
        templateMeta: {
          repoPath: f.worktreePath,
          baseBranch: 'main',
          taskId: 'task-1',
          nodeId: 'node-1',
        },
        skills: [],
        appHome: f.appHome,
        runtime: 'claude-code',
        runtimeParams: {
          model: null,
          variant: null,
          temperature: null,
          steps: null,
          maxSteps: null,
        },
        db,
      })
      expect(result).toMatchObject({
        status: 'failed',
        failureCode: 'execution-identity-mismatch',
        errorMessage: 'execution-identity-mismatch',
      })
    } finally {
      claudeCodeDriver.buildBusinessSpawn = original
    }
    // The decisive assertion: the runtime never ran.
    expect(existsOrNull(marker)).toBeNull()
  }, 30_000)
})

/** Run a materialized wrapper exactly the way claude forks it: stdio, no args. */
async function runWrapper(
  wrapperPath: string,
  stdin: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([wrapperPath], {
    stdin: new TextEncoder().encode(stdin),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { exitCode, stdout, stderr }
}

describe('RFC-242 T5 — the wrapper actually executes (stdio passthrough)', () => {
  test('claude forking the wrapper reaches the real MCP command over inherited stdio', async () => {
    // This is the property the whole C-1 decision rests on (design §4.1): the
    // platform sits between claude and the MCP server WITHOUT proxying — the
    // wrapper re-execs into the netless subcommand which inherits stdio wholesale.
    // Containment `off` keeps this runnable on any CI host; the boundary itself
    // is proven by the gated case below.
    const f = fixture('rfc242-netless-stdio-')
    const server = mkExecutable(
      join(f.base, 'mcp'),
      'server',
      '#!/bin/sh\nread line\necho "seen:$line token:$TOKEN cwd:$PWD"\n',
    )
    const containment = await new ContainmentCoordinator({
      provider: {
        mode: 'off',
        status: { mechanism: 'none', available: false, detail: null },
        appHome: f.appHome,
      },
    }).admit('model-child-netless-v1')

    const result = await materializeClaudeNetlessMcp({
      mcps: [localMcp('search', [server], { env: { TOKEN: 'round-trip' } })],
      containment,
      runRoot: f.runRoot,
      worktreePath: f.worktreePath,
      appHome: f.appHome,
      log,
      sourceEnv: { PATH: '/usr/bin:/bin' },
    })

    const run = await runWrapper(result.wrapperByName.get('search')!, 'hello-from-claude\n')
    expect(run.exitCode).toBe(0)
    expect(run.stdout.trim()).toBe(`seen:hello-from-claude token:round-trip cwd:${f.worktreePath}`)
  }, 30_000)
})

// Real boundary evidence. Gated because it needs a capable host (and, on Linux,
// a root-owned bwrap):
//   RUN_SANDBOX_ITEST=1 bun test packages/backend/tests/rfc242-claude-netless-mcp.test.ts
const boundaryTest =
  process.env.RUN_SANDBOX_ITEST === '1' &&
  (process.platform === 'darwin' || process.platform === 'linux')
    ? test
    : test.skip

describe('RFC-242 T5 — REAL no-network boundary (gated)', () => {
  boundaryTest(
    'the fenced MCP child loses network while keeping worktree IO',
    async () => {
      const f = fixture('rfc242-netless-real-')
      const server = mkExecutable(
        join(f.base, 'mcp'),
        'server',
        [
          '#!/bin/sh',
          "code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 https://example.com 2>/dev/null)",
          'echo "net=${code:-none}"',
          'if echo ok > "$PWD/inside-boundary.txt" 2>/dev/null; then echo write=ok; else echo write=fail; fi',
          'if echo leak > "$HOME/private.txt" 2>/dev/null; then echo home=writable; else echo home=denied; fi',
          '',
        ].join('\n'),
      )
      const containment = await admitContainment(f.appHome)
      const result = await materializeClaudeNetlessMcp({
        mcps: [localMcp('search', [server])],
        containment,
        runRoot: f.runRoot,
        worktreePath: f.worktreePath,
        appHome: f.appHome,
        log,
        sourceEnv: { PATH: '/usr/bin:/bin' },
      })

      const run = await runWrapper(result.wrapperByName.get('search')!, '')
      // curl inside the boundary must not reach the internet. Seatbelt reports
      // 000 (design §4.1 measurement); bwrap's `--unshare-net` reports 000 too.
      expect(run.stdout).toContain('net=000')
      expect(run.stdout).not.toContain('net=200')
      // …while the child keeps doing its job in the worktree.
      expect(run.stdout).toContain('write=ok')
      expect(readFileSync(join(f.worktreePath, 'inside-boundary.txt'), 'utf8').trim()).toBe('ok')
      // The private HOME is inside the fence, so the write lands there and NOT
      // in the operator's real home directory.
      expect(run.stdout).toContain('home=writable')
      expect(
        readFileSync(join(f.runRoot, 'claude-mcp-scratch', 'home', 'private.txt'), 'utf8').trim(),
      ).toBe('leak')
    },
    120_000,
  )

  boundaryTest(
    'a real MCP JSON-RPC session still completes through the fence',
    async () => {
      // The other half of the acceptance criterion: the boundary must deny the
      // network WITHOUT breaking the protocol claude speaks to the server. This
      // drives the wrapper exactly the way claude does — line-delimited JSON-RPC
      // over inherited stdio — so a boundary that broke framing, cwd or the
      // private HOME would show up as a missing/incorrect tools/call result.
      const f = fixture('rfc242-netless-jsonrpc-')
      // Deliberately written against /bin/sh + curl only: the fenced child's PATH
      // is the fixed netless one, so a fixture needing bun/node from the daemon's
      // PATH would (correctly) fail to start. Request ids are fixed by the driver
      // below, so the replies can hardcode them.
      const server = mkExecutable(
        join(f.base, 'mcp'),
        'server',
        [
          '#!/bin/sh',
          'while IFS= read -r line; do',
          '  case "$line" in',
          '    *initialize*)',
          '      printf \'%s\\n\' \'{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05","capabilities":{"tools":{}},"serverInfo":{"name":"probe","version":"1"}}}\' ;;',
          '    *tools/list*)',
          '      printf \'%s\\n\' \'{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"ping","description":"ping","inputSchema":{"type":"object"}}]}}\' ;;',
          '    *tools/call*)',
          "      net=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 https://example.com 2>/dev/null)",
          '      printf \'{"jsonrpc":"2.0","id":3,"result":{"isError":false,"content":[{"type":"text","text":"pong net=%s home=%s"}]}}\\n\' "${net:-empty}" "$HOME" ;;',
          '  esac',
          'done',
          '',
        ].join('\n'),
      )
      const containment = await admitContainment(f.appHome)
      const result = await materializeClaudeNetlessMcp({
        mcps: [localMcp('probe', [server])],
        containment,
        runRoot: f.runRoot,
        worktreePath: f.worktreePath,
        appHome: f.appHome,
        log,
        sourceEnv: { PATH: '/usr/bin:/bin' },
      })

      const requests =
        [
          JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
          JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
          JSON.stringify({
            jsonrpc: '2.0',
            id: 3,
            method: 'tools/call',
            params: { name: 'ping', arguments: {} },
          }),
        ].join('\n') + '\n'
      const run = await runWrapper(result.wrapperByName.get('probe')!, requests)
      const replies = run.stdout
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as { id: number; result: Record<string, unknown> })

      expect(replies.map((r) => r.id)).toEqual([1, 2, 3])
      expect((replies[1]!.result as { tools: Array<{ name: string }> }).tools[0]!.name).toBe('ping')
      const call = replies[2]!.result as { isError: boolean; content: Array<{ text: string }> }
      expect(call.isError).toBe(false)
      // The tool answered — and its own outbound request was denied.
      expect(call.content[0]!.text).toContain('pong')
      expect(call.content[0]!.text).toContain('net=000')
      expect(call.content[0]!.text).toContain(join(f.runRoot, 'claude-mcp-scratch', 'home'))
    },
    180_000,
  )
})
