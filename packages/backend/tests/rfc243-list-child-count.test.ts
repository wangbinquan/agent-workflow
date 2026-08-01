// RFC-243 follow-up — `TaskListItem.childCount`, the signal the /tasks page
// keys its expand arrow off.
//
// Why this file exists: PR-5 shipped an always-on expand arrow gated only by
// STATUS, because the list carried no has-children signal. Every ordinary
// running/awaiting/done task therefore advertised an expand that opened onto
// 「无子任务」, while a FAILED parent that really did own children had no arrow
// at all. `loadChildCounts` replaces that with one grouped query per page.
//
// The invariant these tests defend — and the one that is easy to break by
// "optimizing" the count into a plain `parent_task_id IN (...)` — is that the
// count runs under the SAME visibility predicate as the list itself. If the two
// ever diverge, the arrow starts promising rows the viewer cannot open.

import { describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { sql } from 'drizzle-orm'
import { resolve } from 'node:path'

import { createInMemoryDb } from '../src/db/client'
import { tasks, users } from '../src/db/schema'
import { listTaskItems } from '../src/services/task'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

type Db = ReturnType<typeof createInMemoryDb>

function baseTask(id: string, ownerUserId: string | null) {
  const now = Date.now()
  return {
    id,
    name: id,
    workflowId: 'wf-child-count',
    workflowSnapshot: '{}',
    repoPath: '/tmp/rfc243-child-count',
    repoUrl: null,
    worktreePath: `/tmp/rfc243-child-count-${id}`,
    branch: `agent-workflow/${id}`,
    baseBranch: 'main',
    baseCommit: null,
    status: 'done' as const,
    inputs: '{}',
    maxDurationMs: null,
    maxTotalTokens: null,
    startedAt: now,
    finishedAt: now,
    errorSummary: null,
    errorMessage: null,
    failedNodeId: null,
    expiresAt: null,
    deletedAt: null,
    schemaVersion: 1,
    ownerUserId,
  }
}

async function seed(
  db: Db,
  rows: { id: string; owner: string | null; parent?: string; status?: string }[],
): Promise<void> {
  await db.run(sql`PRAGMA foreign_keys = OFF`)
  await db.insert(tasks).values(
    rows.map((r) => ({
      ...baseTask(r.id, r.owner),
      ...(r.parent === undefined ? {} : { parentTaskId: r.parent, invocationDepth: 1 }),
      ...(r.status === undefined ? {} : { status: r.status as 'done' }),
    })),
  )
  await db.run(sql`PRAGMA foreign_keys = ON`)
}

function countOf(rows: { id: string; childCount: number }[], id: string): number | undefined {
  return rows.find((r) => r.id === id)?.childCount
}

describe('RFC-243 — list childCount', () => {
  test('counts DIRECT children only, per row, and reports 0 for childless rows', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seed(db, [
      { id: 'p-two', owner: null },
      { id: 'p-one', owner: null },
      { id: 'p-none', owner: null },
      { id: 'c-a', owner: null, parent: 'p-two' },
      { id: 'c-b', owner: null, parent: 'p-two' },
      { id: 'c-c', owner: null, parent: 'p-one' },
      // Grandchild: belongs to c-a, and must NOT roll up into p-two.
      { id: 'g-a', owner: null, parent: 'c-a' },
    ])

    const rows = await listTaskItems(db)
    expect(countOf(rows, 'p-two')).toBe(2)
    expect(countOf(rows, 'p-one')).toBe(1)
    expect(countOf(rows, 'p-none')).toBe(0)
    // The child that is itself a parent carries its own count — this is what
    // lets the UI recurse into a second nesting level.
    expect(countOf(rows, 'c-a')).toBe(1)
    expect(countOf(rows, 'c-b')).toBe(0)
  })

  test('status is not a gate: a failed parent still reports its children', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seed(db, [
      { id: 'p-failed', owner: null, status: 'failed' },
      { id: 'c-of-failed', owner: null, parent: 'p-failed' },
    ])

    // The old status-gated arrow hid children under failed/canceled parents —
    // exactly the rows a user most needs to open when diagnosing a failure.
    expect(countOf(await listTaskItems(db), 'p-failed')).toBe(1)
  })

  test('counts only children VISIBLE to the actor (same predicate as the list)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const now = Date.now()
    await db.insert(users).values([
      { id: 'alice', username: 'alice', displayName: 'Alice', createdAt: now, updatedAt: now },
      { id: 'bob', username: 'bob', displayName: 'Bob', createdAt: now, updatedAt: now },
    ])
    await seed(db, [
      { id: 'p-alice', owner: 'alice' },
      { id: 'c-alice', owner: 'alice', parent: 'p-alice' },
      // Bob's child of Alice's parent: real row, invisible to Alice's scope.
      { id: 'c-bob', owner: 'bob', parent: 'p-alice' },
    ])

    const asAlice = await listTaskItems(db, {
      visibility: { actorUserId: 'alice', scope: 'mine' },
    })
    // 1, not 2 — an arrow that counted Bob's row would open onto a list Alice
    // cannot see, because the children fetch applies this same filter.
    expect(countOf(asAlice, 'p-alice')).toBe(1)

    // Unfiltered (admin scope=all) sees the true total.
    expect(countOf(await listTaskItems(db), 'p-alice')).toBe(2)
  })

  test('children query rows carry their own counts (nested expansion)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seed(db, [
      { id: 'root', owner: null },
      { id: 'mid', owner: null, parent: 'root' },
      { id: 'leaf', owner: null, parent: 'mid' },
    ])

    const children = await listTaskItems(db, { parentTaskId: 'root' })
    expect(children.map((r) => r.id)).toEqual(['mid'])
    expect(countOf(children, 'mid')).toBe(1)

    const grandchildren = await listTaskItems(db, { parentTaskId: 'mid' })
    expect(countOf(grandchildren, 'leaf')).toBe(0)
  })

  test('one grouped query for the whole page — never a per-row probe', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const parents = Array.from({ length: 25 }, (_, i) => ({
      id: `p${String(i).padStart(2, '0')}`,
      owner: null,
    }))
    await seed(db, [
      ...parents,
      ...parents.map((p) => ({ id: `c-${p.id}`, owner: null, parent: p.id })),
    ])

    // Observe the REAL SQL at the bun:sqlite handle (drizzle's `db.all` is not
    // the path a select takes — hooking it counts nothing and the assertion
    // below would pass vacuously, which is exactly how this test first shipped
    // green while measuring zero).
    const raw = (db as unknown as { $client: Database }).$client
    const realPrepare = raw.prepare.bind(raw)
    let prepared = 0
    let childCountPrepares = 0
    raw.prepare = ((text: string, ...rest: unknown[]) => {
      prepared += 1
      if (/parent_task_id/i.test(text) && /count\(/i.test(text)) childCountPrepares += 1
      return realPrepare(text, ...(rest as []))
    }) as typeof raw.prepare

    const rows = await listTaskItems(db)
    raw.prepare = realPrepare

    expect(rows.filter((r) => r.id.startsWith('p')).every((r) => r.childCount === 1)).toBe(true)
    // Self-check: if the hook ever stops seeing statements, fail loudly here
    // rather than let the N+1 assertion below pass on an empty sample.
    expect(prepared).toBeGreaterThan(0)
    // 25 parents → exactly ONE grouped count, not 25 probes.
    expect(childCountPrepares).toBe(1)
  })
})
