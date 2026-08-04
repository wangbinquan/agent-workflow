// RFC-205 — degradation alert dedupe, the enforce launch gate, and the gated
// REAL-mechanism integration smoke (design §4-4 / §4-6).
//
// The "no provider → zero wrapping" contract needs no test of its own: every
// existing runner-path test in this suite runs without a provider and stayed
// byte-green through the RFC — that IS the lock.

import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { createInMemoryDb } from '../src/db/client'
import { agents, lifecycleAlerts, runtimes, tasks, workflows } from '../src/db/schema'
import { ulid } from 'ulid'
import { createLogger } from '../src/util/log'
import { alertSandboxDegradedOnce, resolveSandboxDegradedIfHealthy } from '../src/services/runner'
import {
  ContainmentCoordinator,
  ContainmentProviderQualificationError,
} from '../src/services/sandbox'
import { startTask } from '../src/services/task'
import { DomainError } from '../src/util/errors'
import { computeSandboxPolicy, renderSeatbeltProfile } from '../src/services/sandbox/policy'
import { probeSandboxMechanism } from '../src/services/sandbox/probe'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const log = createLogger('rfc205-int-test')

describe('sandbox-degraded alert (warn + unavailable)', () => {
  test('exactly one OPEN alert per task across repeated spawns', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const wfId = ulid()
    db.insert(workflows).values({ id: wfId, name: 'wf', definition: '{}' }).run()
    const taskId = ulid()
    await db.insert(tasks).values({
      id: taskId,
      name: 't',
      workflowId: wfId,
      workflowSnapshot: '{}',
      repoPath: '/tmp/x',
      worktreePath: '/tmp/x-wt',
      baseBranch: 'main',
      branch: 'b',
      status: 'running',
      inputs: '{}',
      startedAt: Date.now(),
    })
    await alertSandboxDegradedOnce(db, taskId, 'bwrap not found', log)
    await alertSandboxDegradedOnce(db, taskId, 'bwrap not found', log) // second spawn
    const rows = await db.select().from(lifecycleAlerts).where(eq(lifecycleAlerts.taskId, taskId))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.rule).toBe('sandbox-degraded')
    // 2026-08-04 audit: 'warning', not 'warn'. `LifecycleAlertSeverity` only has
    // 'warning' | 'error', so the old value fell through every severity lookup
    // and the diagnose panel rendered the bare key
    // `tasks.diagnose.severity.warn`.
    expect(rows[0]?.severity).toBe('warning')
  })

  test('边界恢复后告警被 resolve（此前全仓无人 resolve ⇒ 横幅永久留着）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const wfId = ulid()
    db.insert(workflows).values({ id: wfId, name: 'wf', definition: '{}' }).run()
    const taskId = ulid()
    await db.insert(tasks).values({
      id: taskId,
      name: 't',
      workflowId: wfId,
      workflowSnapshot: '{}',
      repoPath: '/tmp/x',
      worktreePath: '/tmp/x-wt',
      baseBranch: 'main',
      branch: 'b',
      status: 'running',
      inputs: '{}',
      startedAt: Date.now(),
    })
    await alertSandboxDegradedOnce(db, taskId, 'bwrap not found', log)
    await resolveSandboxDegradedIfHealthy(db, taskId, log)
    const rows = await db.select().from(lifecycleAlerts).where(eq(lifecycleAlerts.taskId, taskId))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.resolvedAt).not.toBeNull()
    // 再次降级要能重新开一条（resolve 掉的不参与去重）。
    await alertSandboxDegradedOnce(db, taskId, 'bwrap not found', log)
    const after = await db.select().from(lifecycleAlerts).where(eq(lifecycleAlerts.taskId, taskId))
    expect(after).toHaveLength(2)
  })
})

describe('enforce launch gate', () => {
  async function launchDeps(
    containmentCoordinator: ContainmentCoordinator,
    protocol: 'opencode' | 'claude-code' = 'opencode',
    permission?: Record<string, string>,
  ) {
    const db = createInMemoryDb(MIGRATIONS)
    const agentId = ulid()
    const workflowId = ulid()
    await db.insert(runtimes).values({
      id: ulid(),
      name: protocol,
      protocol,
      model: protocol === 'opencode' ? 'openai/gpt-5' : 'sonnet',
    })
    await db.insert(agents).values({
      id: agentId,
      name: 'agent',
      runtime: protocol,
      ...(permission === undefined ? {} : { permission: JSON.stringify(permission) }),
    })
    await db.insert(workflows).values({
      id: workflowId,
      name: 'workflow',
      definition: JSON.stringify({
        $schema_version: 1,
        inputs: [],
        nodes: [{ id: 'node', kind: 'agent-single', agentId, agentName: 'agent' }],
        edges: [],
      }),
    })
    return {
      input: { workflowId } as never,
      deps: { db, containmentCoordinator, defaultRuntime: protocol } as never,
    }
  }

  test('enforce + unavailable refuses at the door with sandbox-unavailable', async () => {
    const containmentCoordinator = new ContainmentCoordinator({
      provider: {
        mode: 'enforce',
        status: { mechanism: 'bwrap', available: false, detail: 'not installed' },
        appHome: '/tmp/nope',
      },
      qualifyBwrap: async () => {
        throw new ContainmentProviderQualificationError('provider-not-found')
      },
    })
    const launch = await launchDeps(containmentCoordinator)
    await expect(startTask(launch.input, launch.deps)).rejects.toMatchObject({
      code: 'sandbox-unavailable',
    })
    await expect(startTask(launch.input, launch.deps)).rejects.toBeInstanceOf(DomainError)
  })

  test('warn + unavailable does NOT block the gate (falls through to deps)', async () => {
    const containmentCoordinator = new ContainmentCoordinator({
      provider: {
        mode: 'warn',
        status: { mechanism: 'bwrap', available: false, detail: 'x' },
        appHome: '/tmp/nope',
      },
      qualifyBwrap: async () => {
        throw new ContainmentProviderQualificationError('provider-not-found')
      },
    })
    // Falls past the profile-aware gate and dies later in ordinary launch
    // validation/materialization — proving warn itself did not block.
    const launch = await launchDeps(containmentCoordinator)
    await expect(startTask(launch.input, launch.deps)).rejects.not.toMatchObject({
      code: 'sandbox-unavailable',
    })
  })

  test('mixed capability proof does not let OpenCode hide behind a filesystem-only preview', async () => {
    const containmentCoordinator = new ContainmentCoordinator({
      provider: {
        mode: 'enforce',
        status: { mechanism: 'bwrap', available: true, detail: null },
        appHome: '/tmp/nope',
      },
      qualifyBwrapFilesystem: async () => '/usr/bin/bwrap',
      qualifyBwrapFull: async () => {
        throw new ContainmentProviderQualificationError('provider-trial-rejected')
      },
    })

    const claude = await launchDeps(containmentCoordinator, 'claude-code')
    await expect(startTask(claude.input, claude.deps)).rejects.not.toMatchObject({
      code: 'sandbox-unavailable',
    })

    const opencode = await launchDeps(containmentCoordinator, 'opencode')
    await expect(startTask(opencode.input, opencode.deps)).rejects.toMatchObject({
      code: 'sandbox-unavailable',
      status: 409,
    })
  })

  test('OpenCode with no model-controlled child only requires the filesystem profile', async () => {
    const containmentCoordinator = new ContainmentCoordinator({
      provider: {
        mode: 'enforce',
        status: { mechanism: 'bwrap', available: true, detail: null },
        appHome: '/tmp/nope',
      },
      qualifyBwrapFilesystem: async () => '/usr/bin/bwrap',
      qualifyBwrapFull: async () => {
        throw new ContainmentProviderQualificationError('provider-trial-rejected')
      },
    })

    const launch = await launchDeps(containmentCoordinator, 'opencode', { bash: 'deny' })
    await expect(startTask(launch.input, launch.deps)).rejects.not.toMatchObject({
      code: 'sandbox-unavailable',
    })
  })
})

// Gated REAL-mechanism smoke (design §4-6). Run manually / on capable hosts:
//   RUN_SANDBOX_ITEST=1 bun test tests/rfc205-sandbox-integration.test.ts
const itest = process.env.RUN_SANDBOX_ITEST === '1' ? test : test.skip

describe('REAL mechanism smoke (gated)', () => {
  itest('sandboxed cat: platform secrets refused, own worktree readable', async () => {
    const status = await probeSandboxMechanism()
    if (!status.available) return // capable-host gate double-checked
    // realpath: macOS $TMPDIR is a symlink (/var → /private/var) and Seatbelt
    // matches kernel paths — production normalises in wrapSandbox; the direct
    // renderer call here must do the same or the deny silently evaporates.
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'rfc205-real-')))
    try {
      const wt = join(home, 'worktrees', 'r', 't1')
      mkdirSync(wt, { recursive: true })
      writeFileSync(join(home, 'secret.key'), 'TOP-SECRET')
      writeFileSync(join(wt, 'code.txt'), 'WORK')
      const policy = computeSandboxPolicy({
        appHome: home,
        taskWorktrees: [wt],
        runDir: join(home, 'runs', 't1', 'n1'),
      })
      const run = async (target: string): Promise<number> => {
        const proc = Bun.spawn(
          status.mechanism === 'seatbelt'
            ? ['/usr/bin/sandbox-exec', '-p', renderSeatbeltProfile(policy), '/bin/cat', target]
            : [
                'bwrap',
                '--bind',
                '/',
                '/',
                '--tmpfs',
                home,
                '--bind',
                wt,
                wt,
                '--',
                '/bin/cat',
                target,
              ],
          { stdout: 'ignore', stderr: 'ignore' },
        )
        return await proc.exited
      }
      expect(await run(join(home, 'secret.key'))).not.toBe(0) // A1 refused
      expect(await run(join(wt, 'code.txt'))).toBe(0) // own worktree fine
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
