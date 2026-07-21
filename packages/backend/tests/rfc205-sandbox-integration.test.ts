// RFC-205 — degradation alert dedupe, the enforce launch gate, and the gated
// REAL-mechanism integration smoke (design §4-4 / §4-6).
//
// The "no provider → zero wrapping" contract needs no test of its own: every
// existing runner-path test in this suite runs without a provider and stayed
// byte-green through the RFC — that IS the lock.

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { createInMemoryDb } from '../src/db/client'
import { lifecycleAlerts, tasks, workflows } from '../src/db/schema'
import { ulid } from 'ulid'
import { createLogger } from '../src/util/log'
import { alertSandboxDegradedOnce } from '../src/services/runner'
import { setSandboxProvider } from '../src/services/sandbox'
import { startTask } from '../src/services/task'
import { DomainError } from '../src/util/errors'
import { computeSandboxPolicy, renderSeatbeltProfile } from '../src/services/sandbox/policy'
import { probeSandboxMechanism } from '../src/services/sandbox/probe'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const log = createLogger('rfc205-int-test')

afterEach(() => setSandboxProvider(null))

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
    expect(rows[0]?.severity).toBe('warn')
  })
})

describe('enforce launch gate', () => {
  test('enforce + unavailable refuses at the door with sandbox-unavailable', async () => {
    setSandboxProvider({
      mode: 'enforce',
      status: { mechanism: 'bwrap', available: false, detail: 'not installed' },
      appHome: '/tmp/nope',
    })
    // The gate sits at the very top of startTask — deps are never touched.
    await expect(startTask({} as never, {} as never)).rejects.toMatchObject({
      code: 'sandbox-unavailable',
    })
    await expect(startTask({} as never, {} as never)).rejects.toBeInstanceOf(DomainError)
  })

  test('warn + unavailable does NOT block the gate (falls through to deps)', async () => {
    setSandboxProvider({
      mode: 'warn',
      status: { mechanism: 'bwrap', available: false, detail: 'x' },
      appHome: '/tmp/nope',
    })
    // Falls past the gate and dies later on the empty deps — proving the gate
    // itself let it through.
    await expect(startTask({} as never, {} as never)).rejects.not.toMatchObject({
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
