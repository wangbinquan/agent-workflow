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
  symlinkSync,
  unlinkSync,
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
import { parseUnusableMcpServers } from '../src/services/runtime/claudeCode/events'
import { materializeClaudeNetlessMcp } from '../src/services/runtime/claudeCode/netlessMcp'
import {
  NetlessSubprocessManifestSchema,
  renderNetlessBwrapArgs,
  renderNetlessInvocation,
} from '../src/services/runtime/opencode/sealedSubprocess'
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

// ---------------------------------------------------------------------------
// Adversarial-review + Codex impl-gate regressions on the FIRST cut of the
// fence (commit e050d792). Every case below is an escape or a silent capability
// loss that shipped and was reproduced by hand; each one is red without its
// fix. Read `netlessProjection.ts` for why they share one module: the two
// escapes are the same defect — an attacker-influenced path becoming a WRITABLE
// allow-back, which is applied AFTER the realHome/appHome masks.
// ---------------------------------------------------------------------------

/** A real git repo with one commit. */
async function initRepo(path: string): Promise<void> {
  mkdirSync(path, { recursive: true })
  const git = async (args: string[]): Promise<void> => {
    const child = Bun.spawn(['git', ...args], { cwd: path, stdout: 'ignore', stderr: 'ignore' })
    expect(await child.exited).toBe(0)
  }
  await git(['init', '-q', '-b', 'main'])
  await git(['config', 'user.email', 'a@b.c'])
  await git(['config', 'user.name', 'a'])
  writeFileSync(join(path, 'f.txt'), 'x')
  await git(['add', '.'])
  await git(['commit', '-qm', 'init'])
}

describe('RFC-242 T5 — a `.git` pointer inside the worktree cannot mint an allow-back', () => {
  test('a forged pointer naming ANOTHER repository fails closed', async () => {
    // REPRODUCED 2026-07-31 against git 2.50.1. `<worktree>/.git` is an ordinary
    // writable file inside the agent's own workspace — writable by every node of
    // the task AND by the fenced MCP child itself (the worktree is one of the
    // manifest's writable allow-backs). Point it at any other valid repository
    // and git faithfully reports THAT common dir; the first cut canonicalized it
    // and published it as a writable subtree, so a process inside the real
    // Seatbelt/bwrap child boundary could write e.g.
    // `<appHome>/repos/<other>/.git/hooks/post-commit` — a file the daemon later
    // executes with no sandbox at all.
    //
    // The fix is the check the opencode plan always had: when the reported
    // common dir lands outside the worktree, that worktree must be REGISTERED in
    // it (`git worktree list`). The forged repo lists only its own worktrees.
    const f = fixture('rfc242-netless-gitforge-')
    const server = mkExecutable(join(f.base, 'mcp'), 'server', '#!/bin/sh\nexit 0\n')
    const repo = join(f.base, 'repo')
    const foreign = join(f.base, 'foreign')
    await initRepo(repo)
    await initRepo(foreign)
    const linked = join(f.base, 'linked')
    const add = Bun.spawn(['git', 'worktree', 'add', '-q', linked, '-b', 'wt'], {
      cwd: repo,
      stdout: 'ignore',
      stderr: 'ignore',
    })
    expect(await add.exited).toBe(0)

    const containment = await admitContainment(f.appHome)
    const materialize = async (): Promise<ReadonlyMap<string, string>> =>
      (
        await materializeClaudeNetlessMcp({
          mcps: [localMcp('search', [server])],
          containment,
          runRoot: f.runRoot,
          worktreePath: linked,
          appHome: f.appHome,
          repoWorktreePaths: [linked],
          log,
          sourceEnv: { PATH: '/usr/bin:/bin' },
        })
      ).wrapperByName

    // Untampered: the real external common dir IS projected (git must keep working).
    await materialize()
    expect(
      NetlessSubprocessManifestSchema.parse(
        JSON.parse(
          readFileSync(join(f.runRoot, 'claude-mcp-seal', 'search', 'netless.json'), 'utf8'),
        ),
      ).gitCommonDirs,
    ).toEqual([realpathSync(join(repo, '.git'))])

    // Tampered: the agent rewrites its own `.git` pointer at the foreign repo.
    writeFileSync(join(linked, '.git'), `gitdir: ${realpathSync(join(foreign, '.git'))}\n`)
    const probe = Bun.spawn(['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: linked,
      stdout: 'pipe',
      stderr: 'ignore',
    })
    // Precondition of the whole attack: git really does report the forged dir.
    expect((await new Response(probe.stdout).text()).trim()).toBe(
      realpathSync(join(foreign, '.git')),
    )
    await expect(materialize()).rejects.toThrow(/execution-identity-store-unsafe/)
  }, 60_000)

  test('a symlinked pointer is canonicalized by git and still projects the REAL dir', async () => {
    // MEASURED against git 2.50.1: git resolves symlinks in a `gitdir:` pointer
    // BEFORE reporting `--git-common-dir`, so a link cannot smuggle a
    // non-canonical answer past the daemon on this platform. The
    // `realpath(reported) === reported` check the opencode plan carries is kept
    // as defense in depth for a git that reports the link verbatim — and this
    // case is the other half of that contract: the legitimate linked worktree
    // must NOT be over-blocked.
    const f = fixture('rfc242-netless-gitlink-')
    const server = mkExecutable(join(f.base, 'mcp'), 'server', '#!/bin/sh\nexit 0\n')
    const repo = join(f.base, 'repo')
    await initRepo(repo)
    const linked = join(f.base, 'linked')
    const add = Bun.spawn(['git', 'worktree', 'add', '-q', linked, '-b', 'wt'], {
      cwd: repo,
      stdout: 'ignore',
      stderr: 'ignore',
    })
    expect(await add.exited).toBe(0)
    symlinkSync(realpathSync(join(repo, '.git')), join(linked, 'gitlink'))
    writeFileSync(join(linked, '.git'), `gitdir: ${join(linked, 'gitlink')}\n`)

    const containment = await admitContainment(f.appHome)
    await materializeClaudeNetlessMcp({
      mcps: [localMcp('search', [server])],
      containment,
      runRoot: f.runRoot,
      worktreePath: linked,
      appHome: f.appHome,
      repoWorktreePaths: [linked],
      log,
      sourceEnv: { PATH: '/usr/bin:/bin' },
    })
    expect(
      NetlessSubprocessManifestSchema.parse(
        JSON.parse(
          readFileSync(join(f.runRoot, 'claude-mcp-seal', 'search', 'netless.json'), 'utf8'),
        ),
      ).gitCommonDirs,
    ).toEqual([realpathSync(join(repo, '.git'))])
  }, 60_000)
})

describe('RFC-242 T5 — the private scratch cannot be re-entered through a symlink', () => {
  test('a scratch subdir replaced by a link fails closed instead of exporting HOME', async () => {
    // An inline-clarify resume REUSES the run root, and the previous run's
    // fenced child had write access to `claude-mcp-scratch` (it is one of the
    // manifest's writable subtrees). Replacing `home` with a symlink used to be
    // accepted by `mkdir(…, {recursive:true})` and followed by `realpath`, so
    // the NEXT run published the link target as HOME — and
    // `netlessWritableSubtrees` grants HOME write access AFTER the realHome /
    // appHome masks. That is a straight escape out of the boundary.
    const f = fixture('rfc242-netless-scratchlink-')
    const server = mkExecutable(join(f.base, 'mcp'), 'server', '#!/bin/sh\nexit 0\n')
    const outside = join(f.base, 'outside-the-fence')
    mkdirSync(outside, { recursive: true })
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
    await materializeClaudeNetlessMcp(input)

    const home = join(f.runRoot, 'claude-mcp-scratch', 'home')
    rmSync(home, { recursive: true, force: true })
    symlinkSync(outside, home)
    await expect(materializeClaudeNetlessMcp(input)).rejects.toThrow(
      /execution-identity-store-unsafe/,
    )
    // The decisive assertion: the run produced NO manifest at all, so the
    // outside directory never became an allow-back (the seal is rebuilt before
    // the scratch is verified, so a rejected run leaves nothing behind).
    expect(existsOrNull(join(f.runRoot, 'claude-mcp-seal', 'search', 'netless.json'))).toBeNull()
    expect(existsOrNull(join(outside, 'private.txt'))).toBeNull()
  })

  test('the seal root itself is rebuilt, never followed', async () => {
    const f = fixture('rfc242-netless-seallink-')
    const server = mkExecutable(join(f.base, 'mcp'), 'server', '#!/bin/sh\nexit 0\n')
    const outside = join(f.base, 'outside-seal')
    mkdirSync(outside, { recursive: true })
    symlinkSync(outside, join(f.runRoot, 'claude-mcp-seal'))
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
    // The link was unlinked and a real private dir took its place; nothing was
    // written through it into the external target.
    expect(result.wrapperByName.get('search')).toBe(
      join(f.runRoot, 'claude-mcp-seal', 'search', 'run'),
    )
    expect(existsOrNull(join(outside, 'search'))).toBeNull()
  })
})

describe('RFC-242 T5 — the fenced command is the one the author configured', () => {
  test('a worktree-relative command resolves against the WORKTREE, not the daemon cwd', async () => {
    // `./tools/server` is a legitimate local-MCP command: before the fence,
    // claude forked it with the task worktree as cwd. `Bun.which` resolves a
    // slash-bearing token against the DAEMON's cwd, which either fails outright
    // or — worse — finds an unrelated same-named file inside the install dir.
    const f = fixture('rfc242-netless-relcmd-')
    const server = mkExecutable(join(f.worktreePath, 'tools'), 'server', '#!/bin/sh\nexit 0\n')
    const containment = await admitContainment(f.appHome)
    const result = await materializeClaudeNetlessMcp({
      mcps: [localMcp('search', ['./tools/server', '--stdio'])],
      containment,
      runRoot: f.runRoot,
      worktreePath: f.worktreePath,
      appHome: f.appHome,
      log,
      sourceEnv: { PATH: '/usr/bin:/bin' },
    })
    const manifest = NetlessSubprocessManifestSchema.parse(
      JSON.parse(
        readFileSync(join(f.runRoot, 'claude-mcp-seal', 'search', 'netless.json'), 'utf8'),
      ),
    )
    expect(manifest.command).toEqual([realpathSync(server), '--stdio'])
    expect(result.wrapperByName.size).toBe(1)
  })

  test("an interpreted launcher's interpreter is on the fenced PATH and bound read-only", async () => {
    // MEASURED 2026-07-31: `npx` on this machine realpaths to
    // `…/npm/bin/npx-cli.js` (`#!/usr/bin/env node`) and there is no `node` in
    // that directory. PATH-ing only the launcher's own dir made the wrapper exit
    // 127; claude reported `mcp_servers:[{status:"failed"}]` and the node still
    // finished is_error:false with its MCP tools silently missing.
    const f = fixture('rfc242-netless-shebang-')
    const interpreterDir = join(f.base, 'interp')
    const interpreter = mkExecutable(interpreterDir, 'fakenode', '#!/bin/sh\nexec /bin/sh "$@"\n')
    const launcherDir = join(f.base, 'launcher')
    const launcher = mkExecutable(launcherDir, 'server-cli.js', '#!/usr/bin/env fakenode\nexit 0\n')
    const containment = await admitContainment(f.appHome)
    await materializeClaudeNetlessMcp({
      mcps: [localMcp('search', [launcher])],
      containment,
      runRoot: f.runRoot,
      worktreePath: f.worktreePath,
      appHome: f.appHome,
      log,
      sourceEnv: { PATH: `${interpreterDir}:/usr/bin:/bin` },
    })
    const manifest = NetlessSubprocessManifestSchema.parse(
      JSON.parse(
        readFileSync(join(f.runRoot, 'claude-mcp-seal', 'search', 'netless.json'), 'utf8'),
      ),
    )
    // The interpreter's inode is bound (never its parent directory) and its
    // directory is on the child's PATH so `/usr/bin/env` can find it.
    expect(manifest.bindReadOnly).toEqual([realpathSync(launcher), realpathSync(interpreter)])
    expect(manifest.env.PATH?.split(':')).toEqual([
      realpathSync(launcherDir),
      realpathSync(interpreterDir),
      '/usr/bin',
      '/bin',
    ])
  })

  test('an interpreter that cannot be resolved fails closed', async () => {
    const f = fixture('rfc242-netless-shebang-missing-')
    const launcher = mkExecutable(
      join(f.base, 'launcher'),
      'server-cli.js',
      '#!/usr/bin/env definitely-not-an-interpreter-xyz\nexit 0\n',
    )
    const containment = await admitContainment(f.appHome)
    await expect(
      materializeClaudeNetlessMcp({
        mcps: [localMcp('search', [launcher])],
        containment,
        runRoot: f.runRoot,
        worktreePath: f.worktreePath,
        appHome: f.appHome,
        log,
        sourceEnv: { PATH: '/usr/bin:/bin' },
      }),
    ).rejects.toThrow(/execution-identity-mismatch/)
  })

  test('the interpreted launcher actually starts inside the wrapper', async () => {
    // The end-to-end form of the same regression: run the materialized wrapper
    // the way claude forks it and prove the interpreter resolved.
    const f = fixture('rfc242-netless-shebang-run-')
    const interpreterDir = join(f.base, 'interp')
    mkExecutable(interpreterDir, 'fakenode', '#!/bin/sh\nexec /bin/sh "$@"\n')
    const launcher = mkExecutable(
      join(f.base, 'launcher'),
      'server-cli.js',
      '#!/usr/bin/env fakenode\necho started-via-interpreter\n',
    )
    const containment = await new ContainmentCoordinator({
      provider: {
        mode: 'off',
        status: { mechanism: 'none', available: false, detail: null },
        appHome: f.appHome,
      },
    }).admit('model-child-netless-v1')
    const result = await materializeClaudeNetlessMcp({
      mcps: [localMcp('search', [launcher])],
      containment,
      runRoot: f.runRoot,
      worktreePath: f.worktreePath,
      appHome: f.appHome,
      log,
      sourceEnv: { PATH: `${interpreterDir}:/usr/bin:/bin` },
    })
    const run = await runWrapper(result.wrapperByName.get('search')!, '')
    expect(run.exitCode).toBe(0)
    expect(run.stdout.trim()).toBe('started-via-interpreter')
  }, 30_000)

  test('preSpawnVerify rejects a DIFFERENT file swapped into the planned path', async () => {
    // The pre-fix check was lstat-only (regular file, not a symlink), so
    // replacing the planned executable with another regular file passed while
    // the comment claimed "must still be that exact file". Identity is dev/ino.
    const f = fixture('rfc242-netless-swap-')
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
    await result.preSpawnVerify()
    unlinkSync(server)
    mkExecutable(join(f.base, 'mcp'), 'server', '#!/bin/sh\necho pwned\n')
    await expect(result.preSpawnVerify()).rejects.toThrow(/execution-identity-mismatch/)
  })
})

describe('RFC-242 T5 — MCP-authored env is forwarded, not silently policed', () => {
  test('ordinary lowercase / camelCase keys reach the manifest', async () => {
    // The first cut ran MCP env through the DAEMON-env allowlist, whose names
    // must be SCREAMING_CASE, and then hard-failed on the count mismatch. Every
    // one of these worked before the fence and is refused by no rule.
    const f = fixture('rfc242-netless-envkeys-')
    const server = mkExecutable(join(f.base, 'mcp'), 'server', '#!/bin/sh\nexit 0\n')
    const containment = await admitContainment(f.appHome)
    await materializeClaudeNetlessMcp({
      mcps: [
        localMcp('search', [server], {
          env: {
            token: 't',
            apiKey: 'k',
            PYTHONPATH: '/srv/lib',
            NODE_OPTIONS: '--max-old-space-size=512',
          },
        }),
      ],
      containment,
      runRoot: f.runRoot,
      worktreePath: f.worktreePath,
      appHome: f.appHome,
      log,
      sourceEnv: { PATH: '/usr/bin:/bin' },
    })
    const manifest = NetlessSubprocessManifestSchema.parse(
      JSON.parse(
        readFileSync(join(f.runRoot, 'claude-mcp-seal', 'search', 'netless.json'), 'utf8'),
      ),
    )
    expect(manifest.env.token).toBe('t')
    expect(manifest.env.apiKey).toBe('k')
    expect(manifest.env.PYTHONPATH).toBe('/srv/lib')
    expect(manifest.env.NODE_OPTIONS).toBe('--max-old-space-size=512')
  })

  test('a dynamic-loader key fails closed and the error names the MCP and the key', async () => {
    // This family is refused because it is read by the CONTAINMENT binary
    // itself (`bwrap` / `sandbox-exec` receive this environment before the
    // boundary exists), not because SCREAMING_CASE is a security property.
    const f = fixture('rfc242-netless-envdeny-')
    const server = mkExecutable(join(f.base, 'mcp'), 'server', '#!/bin/sh\nexit 0\n')
    const containment = await admitContainment(f.appHome)
    await expect(
      materializeClaudeNetlessMcp({
        mcps: [localMcp('search', [server], { env: { DYLD_INSERT_LIBRARIES: '/tmp/evil.dylib' } })],
        containment,
        runRoot: f.runRoot,
        worktreePath: f.worktreePath,
        appHome: f.appHome,
        log,
        sourceEnv: { PATH: '/usr/bin:/bin' },
      }),
    ).rejects.toThrow('/mcp/search/env/DYLD_INSERT_LIBRARIES')
  })
})

describe('RFC-242 T5 — the task git identity survives the fence', () => {
  test('RFC-067 identity is carried in the manifest, not inherited', async () => {
    // `runNetlessSubprocess` REPLACES the child environment, so a fenced MCP
    // that commits would otherwise use the machine default (or fail against the
    // private scratch HOME) even though claude itself got the task identity.
    const f = fixture('rfc242-netless-gitid-')
    const server = mkExecutable(join(f.base, 'mcp'), 'server', '#!/bin/sh\nexit 0\n')
    const containment = await admitContainment(f.appHome)
    const plan = await getRuntimeDriver('claude-code').buildBusinessSpawn(
      mkCtx(f, {
        mcps: [localMcp('search', [server])],
        containment,
        gitUserName: 'Task Bot',
        gitUserEmail: 'bot@example.test',
      }),
    )
    expect(plan.cmd.length).toBeGreaterThan(0)
    const manifest = NetlessSubprocessManifestSchema.parse(
      JSON.parse(
        readFileSync(join(f.runRoot, 'claude-mcp-seal', 'search', 'netless.json'), 'utf8'),
      ),
    )
    expect(manifest.env.GIT_AUTHOR_NAME).toBe('Task Bot')
    expect(manifest.env.GIT_AUTHOR_EMAIL).toBe('bot@example.test')
    expect(manifest.env.GIT_COMMITTER_NAME).toBe('Task Bot')
    expect(manifest.env.GIT_COMMITTER_EMAIL).toBe('bot@example.test')
  })
})

describe('RFC-242 T5 — MCP secrets never enter any argv', () => {
  test('the bwrap boundary carries the env out-of-band', () => {
    // `--setenv NAME VALUE` put every MCP secret into `/proc/<bwrap>/cmdline`,
    // which is world-readable — the very exposure that moving MCP env out of
    // claude's `--mcp-config` was meant to end. bwrap has no `--clearenv` here,
    // so passing the env to the bwrap PROCESS gives the child the same map.
    const manifest = NetlessSubprocessManifestSchema.parse({
      codec: 1,
      mode: 'mcp',
      provider: { providerId: 'linux-bwrap', config: { bwrapPath: '/usr/bin/bwrap' } },
      worktreePath: '/w',
      scratchPath: '/s',
      appHome: '/a',
      realHome: '/h',
      gitCommonDirs: [],
      bindReadOnly: [],
      env: { TOKEN: 'super-secret', HOME: '/s/home', TMPDIR: '/s/tmp' },
      command: ['/bin/true'],
    })
    const args = renderNetlessBwrapArgs(manifest, [])
    expect(args).not.toContain('--setenv')
    expect(args.join(' ')).not.toContain('super-secret')
    // …and the child still RECEIVES it. The Linux boundary is otherwise only
    // exercised by the gated integration suite, so lock the delivery here: a
    // bwrap child that silently lost its environment looks exactly like one
    // that never started.
    const invocation = renderNetlessInvocation(manifest, [])
    expect(invocation.cmd[0]).toBe('/usr/bin/bwrap')
    expect(invocation.cmd.join(' ')).not.toContain('super-secret')
    expect(invocation.env).toEqual(manifest.env)
  })

  test('the Seatbelt boundary keeps its out-of-band env too', () => {
    const manifest = NetlessSubprocessManifestSchema.parse({
      codec: 1,
      mode: 'mcp',
      provider: {
        providerId: 'macos-seatbelt',
        config: { sandboxExecPath: '/usr/bin/sandbox-exec' },
      },
      worktreePath: '/w',
      scratchPath: '/s',
      appHome: '/a',
      realHome: '/h',
      gitCommonDirs: [],
      bindReadOnly: [],
      env: { TOKEN: 'super-secret', HOME: '/s/home', TMPDIR: '/s/tmp' },
      command: ['/bin/true'],
    })
    const invocation = renderNetlessInvocation(manifest, [])
    expect(invocation.cmd[0]).toBe('/usr/bin/sandbox-exec')
    expect(invocation.cmd.join(' ')).not.toContain('super-secret')
    expect(invocation.env).toEqual(manifest.env)
  })
})

describe('RFC-242 T5 — the boundary TRADE is announced per node', () => {
  test('dropping the runner outer sandbox for the child boundary is warned, never silent', async () => {
    // Adversarial review P1-2. On a provider that cannot nest (macOS Seatbelt)
    // the model-child boundary REPLACES the runner's outer one and the child
    // launcher wraps only the MCP servers — claude's own in-process
    // Read/Edit/Write lose their platform filesystem boundary. RFC-227 already
    // makes that trade for the verified opencode server (its write/edit tools
    // are in-process too, `opencode/packages/opencode/src/tool/write.ts`), so
    // this is parity rather than a claude-only gap — but it is a TRADE, and the
    // node log has to say which layer was given up. Linux keeps both layers
    // (`runner-outer-and-child`) and must therefore NOT warn.
    const f = fixture('rfc242-netless-trade-')
    const server = mkExecutable(join(f.base, 'mcp'), 'server', '#!/bin/sh\nexit 0\n')
    const containment = await admitContainment(f.appHome)
    const warnings: string[] = []
    const capture = {
      debug: () => {},
      info: () => {},
      warn: (msg: string) => warnings.push(msg),
      error: () => {},
      child: () => capture,
    }
    await getRuntimeDriver('claude-code').buildBusinessSpawn(
      mkCtx(f, { mcps: [localMcp('search', [server])], containment, log: capture }),
    )
    expect(warnings.includes('claude-mcp-netless-outer-dropped')).toBe(
      containment.spawnTopology === 'provider-child-only',
    )
  })
})

describe('RFC-242 T5 — a fenced MCP that does not come up is a node failure', () => {
  test('parseUnusableMcpServers reads claude init inventory', () => {
    // MEASURED (design §4.4): claude freezes MCP availability at init — a
    // `pending` server's tools are absent for the whole turn just like a
    // `failed` one's, while the run still finishes is_error:false.
    const init = (servers: Array<{ name: string; status: string }>): string =>
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 's', mcp_servers: servers })
    expect(parseUnusableMcpServers(init([{ name: 'search', status: 'connected' }]))).toEqual([])
    expect(parseUnusableMcpServers(init([{ name: 'search', status: 'failed' }]))).toEqual([
      'search',
    ])
    expect(parseUnusableMcpServers(init([{ name: 'search', status: 'pending' }]))).toEqual([
      'search',
    ])
    // Anything that is not that inventory must stay out of the way.
    expect(parseUnusableMcpServers('not json')).toBeNull()
    expect(parseUnusableMcpServers(JSON.stringify({ type: 'assistant' }))).toBeNull()
    expect(
      parseUnusableMcpServers(JSON.stringify({ type: 'system', subtype: 'status' })),
    ).toBeNull()
  })

  test('the driver exposes the fenced server names on the spawn plan', async () => {
    const f = fixture('rfc242-netless-fencedlist-')
    const server = mkExecutable(join(f.base, 'mcp'), 'server', '#!/bin/sh\nexit 0\n')
    const containment = await admitContainment(f.appHome)
    const plan = await getRuntimeDriver('claude-code').buildBusinessSpawn(
      mkCtx(f, { mcps: [localMcp('search', [server]), remoteMcp('api')], containment }),
    )
    // Only the fenced (local, wrapped) server — a remote entry has no child.
    expect(plan.fencedMcpServers).toEqual(['search'])
  })

  test('an UNCONSTRAINED node declares no fenced servers (historical behavior kept)', async () => {
    const f = fixture('rfc242-netless-fencedlist-legacy-')
    const server = mkExecutable(join(f.base, 'mcp'), 'server', '#!/bin/sh\nexit 0\n')
    const containment = await admitContainment(f.appHome)
    const plan = await getRuntimeDriver('claude-code').buildBusinessSpawn(
      mkCtx(f, {
        agent: mkAgent({ permission: {} }),
        mcps: [localMcp('search', [server])],
        containment,
      }),
    )
    expect(plan.fencedMcpServers).toBeUndefined()
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

  test('a mock-head test spawn is untouched, and its DEMAND agrees', async () => {
    const f = fixture('rfc242-netless-mockhead-')
    const server = mkExecutable(join(f.base, 'mcp'), 'server', '#!/bin/sh\nexit 0\n')
    const containment = await admitContainment(f.appHome)
    const ctx = mkCtx(f, {
      runtimeBinary: null,
      runtimeCmd: ['bun', 'run', '/mock-claude.ts'],
      mcps: [localMcp('search', [server, '--stdio'])],
      containment,
    })
    const plan = await driver.buildBusinessSpawn(ctx)
    expect(mcpConfigOf(plan.cmd).search).toEqual({ command: server, args: ['--stdio'] })
    expect(existsOrNull(join(f.runRoot, 'claude-mcp-seal'))).toBeNull()
    // Codex impl-gate P2-7: the demand used to be computed from `agent` + `mcps`
    // ALONE, so this exact node asked for the model-child bundle — which drops
    // the runner's outer sandbox on a Seatbelt provider — while materializing no
    // fence at all. Demand and materialization now read the same three inputs.
    expect(
      driver.businessContainmentProfile?.({
        agent: ctx.agent,
        mcps: ctx.mcps,
        runtimeCmd: ctx.runtimeCmd,
      }),
    ).toBe('runner-filesystem-v1')
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

describe('RFC-242 T5 — the runner fails a node whose fenced MCP never came up', () => {
  async function seedTask(
    f: Fixture,
    nodeRunId: string,
  ): Promise<ReturnType<typeof createInMemoryDb>> {
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
      .values({ id: nodeRunId, taskId: 'task-1', nodeId: 'node-1', status: 'pending' })
    return db
  }

  /** A fake runtime that emits ONE claude init line and then a clean output turn. */
  function fakeRuntime(base: string, mcpStatus: string): string {
    const init = JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: 'sess-1',
      mcp_servers: [{ name: 'search', status: mcpStatus }],
    })
    const answer = JSON.stringify({
      type: 'assistant',
      session_id: 'sess-1',
      message: {
        id: 'm1',
        content: [
          {
            type: 'text',
            text: '<workflow-output><port name="result">ok</port></workflow-output>',
          },
        ],
      },
    })
    return mkExecutable(
      join(base, 'fake-runtime'),
      'runtime',
      `#!/bin/sh\ncat > /dev/null\nprintf '%s\\n' ${JSON.stringify(init)}\nprintf '%s\\n' ${JSON.stringify(answer)}\nexit 0\n`,
    )
  }

  async function runWithMcpStatus(
    f: Fixture,
    nodeRunId: string,
    mcpStatus: string,
  ): Promise<Awaited<ReturnType<typeof runNode>>> {
    const db = await seedTask(f, nodeRunId)
    const original = claudeCodeDriver.buildBusinessSpawn
    claudeCodeDriver.buildBusinessSpawn = async (): Promise<SpawnPlan> => ({
      cmd: [fakeRuntime(f.base, mcpStatus)],
      env: {},
      stdin: { mode: 'pipe', data: 'x' },
      fencedMcpServers: ['search'],
    })
    try {
      return await runNode({
        taskId: 'task-1',
        nodeRunId,
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
    } finally {
      claudeCodeDriver.buildBusinessSpawn = original
    }
  }

  test('a fenced server reported unusable fails the node instead of losing its tools', async () => {
    // MEASURED shape (design §4.4): claude answers normally with the server's
    // tools missing and the run ends is_error:false. Before this gate the node
    // reported DONE — a security fence that silently removes the node's declared
    // capability is worse than no fence, because nothing surfaces it.
    const f = fixture('rfc242-netless-mcpdown-')
    const result = await runWithMcpStatus(f, 'nr-mcp-failed', 'failed')
    expect(result.status).toBe('failed')
    expect(result.errorMessage).toContain('mcp-unavailable')
    expect(result.errorMessage).toContain('search')
  }, 30_000)

  test('a healthy fenced server runs the node to completion', async () => {
    const f = fixture('rfc242-netless-mcpup-')
    const result = await runWithMcpStatus(f, 'nr-mcp-ok', 'connected')
    expect(result.status).toBe('done')
    expect(result.outputs.result).toBe('ok')
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
