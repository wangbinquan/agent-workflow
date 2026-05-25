// RFC-062 PR-A T8 — daemonResume Step 4 actually spawns actor loops.
//
// Pre-RFC-062, resumeFromDisk's Step 4 (spawnActors) was self-
// described as "caller's responsibility for now" + "unused in
// production". Result: after every daemon restart (every `bun --watch`
// reload during dev, every release deploy in prod), all non-terminal
// tasks got a `task-resumed-after-daemon-restart` event + wake
// enqueued in their actor registry slot — but no actor was running to
// drain the queue. Tasks just sat in `running` with no progress.
//
// This file pins the fix: `resumeFromDisk({ db, launcher })` must
// call `launcher(taskId)` once per non-terminal task. Tests inject a
// counting mock launcher so we can assert call sites without standing
// up a full actor loop.

import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'

import { createInMemoryDb, type DbClient } from '../src/db/client'
import { tasks, workflows } from '../src/db/schema'
import { resumeFromDisk, spawnResumedActors } from '../src/scheduler-v2/daemonResume'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

type TaskStatus = 'pending' | 'running' | 'done' | 'failed' | 'canceled' | 'awaiting_human'

interface SeedTaskInput {
  id: string
  status: TaskStatus
}

function setupDb(seeds: SeedTaskInput[]): DbClient {
  const db = createInMemoryDb(MIGRATIONS)
  db.insert(workflows)
    .values({ id: 'wf1', name: 'wf-test', schemaVersion: 4, definition: '{}' })
    .run()
  for (const s of seeds) {
    db.insert(tasks)
      .values({
        id: s.id,
        name: `rfc062-daemonresume-${s.id}`,
        workflowId: 'wf1',
        workflowSnapshot: '{}',
        repoPath: '/tmp/aw-rfc062/repo',
        worktreePath: '',
        baseBranch: 'main',
        branch: `agent-workflow/${s.id}`,
        status: s.status,
        inputs: JSON.stringify({}),
        startedAt: Date.now(),
        ...(s.status === 'done' || s.status === 'failed' || s.status === 'canceled'
          ? { finishedAt: Date.now() }
          : {}),
      })
      .run()
  }
  return db
}

describe('resumeFromDisk Step 4 — spawnResumedActors', () => {
  test('calls launcher exactly once per non-terminal task; skips terminal tasks', async () => {
    const db = setupDb([
      { id: 'running1', status: 'running' },
      { id: 'pending1', status: 'pending' },
      { id: 'awaiting1', status: 'awaiting_human' },
      { id: 'done1', status: 'done' },
      { id: 'failed1', status: 'failed' },
      { id: 'canceled1', status: 'canceled' },
    ])

    const launched: string[] = []
    const launcher = (taskId: string) => {
      launched.push(taskId)
      return Promise.resolve()
    }

    await resumeFromDisk({ db, launcher })
    // Give the fire-and-forget launcher invocations a tick to land.
    await new Promise((r) => setTimeout(r, 10))

    expect(launched.sort()).toEqual(['awaiting1', 'pending1', 'running1'])
    // Terminal tasks must never be launched.
    expect(launched.includes('done1')).toBe(false)
    expect(launched.includes('failed1')).toBe(false)
    expect(launched.includes('canceled1')).toBe(false)
  })

  test('one launcher throwing does NOT abort the others (catch-and-log)', async () => {
    const db = setupDb([
      { id: 'good1', status: 'running' },
      { id: 'bad', status: 'running' },
      { id: 'good2', status: 'running' },
    ])

    const launched: string[] = []
    const launcher = (taskId: string) => {
      launched.push(taskId)
      if (taskId === 'bad') return Promise.reject(new Error('boom'))
      return Promise.resolve()
    }

    // Suppress the expected console.error from the catch handler.
    const origErr = console.error
    console.error = () => {}
    try {
      await resumeFromDisk({ db, launcher })
      await new Promise((r) => setTimeout(r, 10))
    } finally {
      console.error = origErr
    }

    expect(launched.sort()).toEqual(['bad', 'good1', 'good2'])
  })

  test('skipSpawn=true honors the dry-run path (no launcher calls)', async () => {
    const db = setupDb([
      { id: 'r1', status: 'running' },
      { id: 'r2', status: 'pending' },
    ])

    const launched: string[] = []
    const launcher = (taskId: string) => {
      launched.push(taskId)
      return Promise.resolve()
    }

    await resumeFromDisk({ db, launcher, skipSpawn: true })
    await new Promise((r) => setTimeout(r, 10))

    expect(launched.length).toBe(0)
  })

  test('omitting launcher entirely is a no-op (back-compat)', async () => {
    const db = setupDb([{ id: 'r1', status: 'running' }])
    // Should not throw despite no launcher; Steps 1-3 still run.
    const report = await resumeFromDisk({ db })
    expect(report.resumedTasks).toBe(1)
  })

  test('spawnResumedActors direct-call returns the count of launches scheduled', () => {
    const db = setupDb([
      { id: 'r1', status: 'running' },
      { id: 'r2', status: 'pending' },
      { id: 'done1', status: 'done' },
    ])
    const launched: string[] = []
    const launcher = (taskId: string) => {
      launched.push(taskId)
      return Promise.resolve()
    }
    const n = spawnResumedActors(db, launcher)
    expect(n).toBe(2) // r1 + r2; done1 excluded
  })
})
