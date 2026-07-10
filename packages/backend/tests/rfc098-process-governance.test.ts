import { rimrafDir } from './helpers/cleanup'
// RFC-098 WP-8 — process-tree governance oracle (scheduler audit S-15).
//
// The cooperative mock-opencode dies on first SIGTERM, so it can never
// exercise the escalation machinery. These tests drive the ADVERSARIAL
// fixture (tests/fixtures/stubborn-opencode.ts: traps SIGTERM, setInterval
// keep-alive, spawns a SIGTERM-trapping grandchild that holds our stdout
// pipe, 60s absolute self-destruct) and lock in:
//
//   1. runner timeout path returns 'failed' within a bounded wall clock
//      (timeout + grace + margin) — no unbounded `await child.exited` — and
//      the group kill reaps BOTH the child and the grandchild (ESRCH).
//   2. runner abort path: same bounded reaping, status 'canceled'.
//   3. reapOrphanRuns group-kills a still-alive orphan (TERM→KILL) before
//      flipping the row to interrupted; rows outside the 48h startedAt
//      window are left alive (PID-reuse noise gate).
//   4. resumeTask kill-then-proceed: a failed row whose recorded child is
//      still alive gets its process tree killed before the rollback runs.
//
// 对抗检视修订 #4: every spawned pid is recorded and afterEach best-effort
// SIGKILLs the whole group so a red assertion can't leak process trees.

import { afterEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'

import type { Agent } from '@agent-workflow/shared'

import { createInMemoryDb, type DbClient } from '../src/db/client'
import { nodeRuns, tasks, workflows } from '../src/db/schema'
import { reapOrphanRuns } from '../src/services/orphans'
import { runNode } from '../src/services/runner'
import { resumeTask } from '../src/services/task'
import { STALE_RUN_PID_MAX_AGE_MS } from '../src/util/process'

// RFC-windows PR-1: this file locks POSIX-specific SIGTERM-trapping + process-group
// kill behaviour (the stubborn-opencode fixture traps SIGTERM; the grandchild
// is only reaped because `process.kill(-pid)` reaches it across the group).
// Windows has neither SIGTERM delivery nor process groups — kill escalation
// there is an immediate hard tree-kill via `taskkill /T /F` (POSIX escalation
// is a no-op map onto the same hard kill), covered in tests/platform.test.ts.
// Skipping on Windows is a platform-conditional guard, not a masked red.
const describePosix = process.platform === 'win32' ? describe.skip : describe

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const STUBBORN = resolve(import.meta.dir, 'fixtures', 'stubborn-opencode.ts')

const TIMEOUT_MS = 500
const GRACE_MS = 700
const MARGIN_MS = 5_000

// ---------------------------------------------------------------------------
// pid bookkeeping (修订 #4): kill every recorded group on the way out.
// ---------------------------------------------------------------------------

const trackedPids: number[] = []

function track(pid: number | null | undefined): void {
  if (typeof pid === 'number' && pid > 0) trackedPids.push(pid)
}

afterEach(() => {
  for (const pid of trackedPids) {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      // group already gone / not a leader
    }
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // already gone
    }
  }
  trackedPids.length = 0
})

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function waitDead(pid: number, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return true
    await Bun.sleep(50)
  }
  return !pidAlive(pid)
}

async function waitForFile(path: string, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(path)) return true
    await Bun.sleep(25)
  }
  return existsSync(path)
}

function readGrandchildPid(pidFile: string): number {
  const pid = Number.parseInt(readFileSync(pidFile, 'utf8').trim(), 10)
  expect(Number.isInteger(pid) && pid > 0).toBe(true)
  track(pid)
  return pid
}

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

interface Harness {
  db: DbClient
  appHome: string
  worktreePath: string
  taskId: string
  pidFile: string
  cleanup: () => void
}

async function buildHarness(taskStatus: 'running' | 'failed' = 'running'): Promise<Harness> {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc098-wp8-'))
  const worktreePath = join(appHome, 'worktree-fake')
  mkdirSync(worktreePath, { recursive: true })
  const db = createInMemoryDb(MIGRATIONS)
  const workflowId = ulid()
  const taskId = ulid()
  await db.insert(workflows).values({
    id: workflowId,
    name: 'wf',
    definition: JSON.stringify({ $schema_version: 2, inputs: [], nodes: [], edges: [] }),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  await db.insert(tasks).values({
    name: 'fixture-task',
    id: taskId,
    workflowId,
    workflowSnapshot: JSON.stringify({ $schema_version: 2, inputs: [], nodes: [], edges: [] }),
    repoPath: '/tmp/repo',
    worktreePath,
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: taskStatus,
    inputs: '{}',
    startedAt: Date.now(),
    finishedAt: taskStatus === 'failed' ? Date.now() : null,
    errorSummary: taskStatus === 'failed' ? 'boom' : null,
  })
  return {
    db,
    appHome,
    worktreePath,
    taskId,
    pidFile: join(appHome, 'grandchild.pid'),
    cleanup: () => rimrafDir(appHome),
  }
}

async function insertRun(
  db: DbClient,
  taskId: string,
  opts: { status?: 'pending' | 'running' | 'failed'; pid?: number; startedAt?: number } = {},
): Promise<string> {
  const id = ulid()
  await db.insert(nodeRuns).values({
    id,
    taskId,
    nodeId: 'node1',
    status: opts.status ?? 'pending',
    retryIndex: 0,
    iteration: 0,
    ...(opts.pid !== undefined ? { pid: opts.pid } : {}),
    startedAt: opts.startedAt ?? Date.now(),
  })
  return id
}

function makeAgent(): Agent {
  return {
    id: ulid(),
    name: 'test-agent',
    description: 'an agent',
    outputs: ['summary'],
    syncOutputsOnIterate: true,
    permission: {},
    skills: [],
    dependsOn: [],
    mcp: [],
    plugins: [],
    frontmatterExtra: {},
    bodyMd: 'You are a test agent.',
    schemaVersion: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

function withEnv<T>(env: Record<string, string>, body: () => Promise<T>): Promise<T> {
  const prev: Record<string, string | undefined> = {}
  for (const k of Object.keys(env)) {
    prev[k] = process.env[k]
    process.env[k] = env[k]
  }
  return body().finally(() => {
    for (const k of Object.keys(env)) {
      const p = prev[k]
      if (p === undefined) delete process.env[k]
      else process.env[k] = p
    }
  })
}

function spawnStubborn(pidFile: string): Bun.Subprocess {
  const child = Bun.spawn({
    cmd: ['bun', 'run', STUBBORN, 'run', 'prompt', '--agent', 'x', '--format', 'json'],
    env: { ...process.env, STUBBORN_OPENCODE_GRANDCHILD_PID_FILE: pidFile },
    stdout: 'ignore',
    stderr: 'ignore',
    stdin: 'ignore',
    detached: true,
  })
  track(child.pid)
  return child
}

// ---------------------------------------------------------------------------
// 1+2. runner escalation paths
// ---------------------------------------------------------------------------

describePosix('RFC-098 WP-8 — runner escalation against a stubborn child', () => {
  let h: Harness
  afterEach(() => h?.cleanup())

  test('timeout: failed within (timeout+grace+margin); child AND grandchild group-killed', async () => {
    h = await buildHarness()
    const nodeRunId = await insertRun(h.db, h.taskId)
    const t0 = Date.now()
    const result = await withEnv({ STUBBORN_OPENCODE_GRANDCHILD_PID_FILE: h.pidFile }, () =>
      runNode({
        taskId: h.taskId,
        nodeRunId,
        nodeId: 'node1',
        agent: makeAgent(),
        inputs: {},
        worktreePath: h.worktreePath,
        templateMeta: { repoPath: '/tmp/repo', baseBranch: 'main', taskId: h.taskId },
        skills: [],
        appHome: h.appHome,
        opencodeCmd: ['bun', 'run', STUBBORN],
        db: h.db,
        timeoutMs: TIMEOUT_MS,
        killEscalationGraceMs: GRACE_MS,
      }),
    )
    const elapsed = Date.now() - t0

    // Bounded wall clock — the unbounded `await child.exited` is gone.
    expect(elapsed).toBeLessThan(TIMEOUT_MS + GRACE_MS + MARGIN_MS)
    // The child DID die (SIGKILL escalation) so this is a plain node-timeout
    // failure, not child-unkillable.
    expect(result.status).toBe('failed')
    expect(result.errorMessage).toContain('node-timeout')

    // Child pid was persisted by the runner; group kill reaped it.
    const row = (await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, nodeRunId)))[0]!
    expect(typeof row.pid).toBe('number')
    track(row.pid)
    expect(await waitDead(row.pid as number)).toBe(true)

    // Grandchild died WITH the group — the single-pid SIGTERM of old could
    // never reach it.
    expect(await waitForFile(h.pidFile)).toBe(true)
    const grandchildPid = readGrandchildPid(h.pidFile)
    expect(await waitDead(grandchildPid)).toBe(true)
  }, 30_000)

  test('abort: canceled within bounds; group dead', async () => {
    h = await buildHarness()
    const nodeRunId = await insertRun(h.db, h.taskId)
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 150)
    const t0 = Date.now()
    const result = await withEnv({ STUBBORN_OPENCODE_GRANDCHILD_PID_FILE: h.pidFile }, () =>
      runNode({
        taskId: h.taskId,
        nodeRunId,
        nodeId: 'node1',
        agent: makeAgent(),
        inputs: {},
        worktreePath: h.worktreePath,
        templateMeta: { repoPath: '/tmp/repo', baseBranch: 'main', taskId: h.taskId },
        skills: [],
        appHome: h.appHome,
        opencodeCmd: ['bun', 'run', STUBBORN],
        db: h.db,
        signal: controller.signal,
        killEscalationGraceMs: GRACE_MS,
      }),
    )
    const elapsed = Date.now() - t0

    expect(elapsed).toBeLessThan(150 + GRACE_MS + MARGIN_MS)
    expect(result.status).toBe('canceled')
    expect(result.errorMessage).toContain('aborted')

    const row = (await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, nodeRunId)))[0]!
    track(row.pid)
    expect(await waitDead(row.pid as number)).toBe(true)
    expect(await waitForFile(h.pidFile)).toBe(true)
    const grandchildPid = readGrandchildPid(h.pidFile)
    expect(await waitDead(grandchildPid)).toBe(true)
  }, 30_000)
})

// ---------------------------------------------------------------------------
// 3. orphan reaping
// ---------------------------------------------------------------------------

describePosix('RFC-098 WP-8 — reapOrphanRuns kills live orphans before flipping', () => {
  let h: Harness
  afterEach(() => h?.cleanup())

  test('live orphan within the window: TERM→KILL group kill, then interrupted', async () => {
    h = await buildHarness()
    const child = spawnStubborn(h.pidFile)
    expect(await waitForFile(h.pidFile)).toBe(true)
    const grandchildPid = readGrandchildPid(h.pidFile)
    const runId = await insertRun(h.db, h.taskId, {
      status: 'running',
      pid: child.pid,
      startedAt: Date.now(),
    })

    const r = await reapOrphanRuns(h.db)
    expect(r).toEqual({ tasks: 1, runs: 1 })

    // The stubborn child trapped SIGTERM — only the KILL escalation (and the
    // group signal, for the grandchild) explains both pids dying.
    expect(await waitDead(child.pid)).toBe(true)
    expect(await waitDead(grandchildPid)).toBe(true)

    const row = (await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, runId)))[0]!
    expect(row.status).toBe('interrupted')
    const t = (await h.db.select().from(tasks).where(eq(tasks.id, h.taskId)))[0]!
    expect(t.status).toBe('interrupted')
  }, 30_000)

  test('startedAt outside the 48h window: pid left alone (PID-reuse gate), row still flipped', async () => {
    h = await buildHarness()
    const child = spawnStubborn(h.pidFile)
    expect(await waitForFile(h.pidFile)).toBe(true)
    const runId = await insertRun(h.db, h.taskId, {
      status: 'running',
      pid: child.pid,
      startedAt: Date.now() - STALE_RUN_PID_MAX_AGE_MS - 60_000,
    })

    const r = await reapOrphanRuns(h.db)
    expect(r).toEqual({ tasks: 1, runs: 1 })

    // Window gate refused the kill — the process is presumed PID-reuse.
    expect(pidAlive(child.pid)).toBe(true)
    const row = (await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, runId)))[0]!
    expect(row.status).toBe('interrupted')
  }, 30_000)
})

// ---------------------------------------------------------------------------
// 4. resumeTask kill-then-proceed
// ---------------------------------------------------------------------------

describePosix('RFC-098 WP-8 — resumeTask kills the target row’s live child before rollback', () => {
  let h: Harness
  afterEach(() => h?.cleanup())

  test('failed row with a live pid: process tree dead by the time resumeTask returns', async () => {
    h = await buildHarness('failed')
    const child = spawnStubborn(h.pidFile)
    expect(await waitForFile(h.pidFile)).toBe(true)
    const grandchildPid = readGrandchildPid(h.pidFile)
    await insertRun(h.db, h.taskId, {
      status: 'failed',
      pid: child.pid,
      startedAt: Date.now(),
    })

    const after = await resumeTask(h.db, h.taskId, {
      db: h.db,
      appHome: h.appHome,
      opencodeCmd: ['/usr/bin/env', 'true'],
    })
    expect(after.status).toBe('pending')

    // Kill-then-proceed ran synchronously before the rollback: both pids gone.
    expect(await waitDead(child.pid)).toBe(true)
    expect(await waitDead(grandchildPid)).toBe(true)
  }, 30_000)
})
