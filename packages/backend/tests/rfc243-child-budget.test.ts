// RFC-243 PR-2 — active-child-task budget locks (design §3.2).
//
// Locks in:
//   1. The design-gate P0-1 deadlock construction CANNOT reproduce: with the
//      cap saturated by tree A and tree B queued first, a grandchild request
//      whose ancestors hold units is granted PAST the queued head (scan-based
//      grants; FIFO only among grantable).
//   2. awaiting_* / interrupted children hold no quota; resume re-counts
//      without re-queuing.
//   3. Bookkeeping is idempotent (duplicate lifecycle notifications) and
//      rebuildable from the DB after a restart.
//   4. Abort rejects a queued waiter and deregisters it.
import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { tasks, workflows } from '../src/db/schema'
import { ChildTaskBudget } from '../src/services/execution/childBudget'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function budgetOf(db: DbClient, cap: number): ChildTaskBudget {
  return new ChildTaskBudget(db, () => cap)
}

const stubDb = null as unknown as DbClient // rebuildFromDb not used in pure tests

describe('RFC-243 §3.2 — grant rules', () => {
  test('under capacity grants immediately and bind converts hold → counted', async () => {
    const b = budgetOf(stubDb, 2)
    const hold = await b.acquire([])
    expect(b.activeCount()).toBe(1)
    hold.bind('C1')
    expect(b.activeCount()).toBe(1)
    b.onChildTaskStatus('C1', 'done')
    expect(b.activeCount()).toBe(0)
  })

  test('release without bind frees the unit (pre-insert launch failure)', async () => {
    const b = budgetOf(stubDb, 1)
    const hold = await b.acquire([])
    expect(b.activeCount()).toBe(1)
    hold.release()
    expect(b.activeCount()).toBe(0)
  })

  test('P0-1 construction: queued head does NOT block an ancestor-exempt grant', async () => {
    const b = budgetOf(stubDb, 2)
    // Tree A (root R): two active children a1, a2 saturate the cap.
    ;(await b.acquire(['R'])).bind('a1')
    ;(await b.acquire(['R'])).bind('a2')
    // Tree B queues first (no ancestors → effective 2 ≥ cap).
    const order: string[] = []
    const bWait = b.acquire([]).then((h) => {
      order.push('B')
      return h
    })
    await Bun.sleep(5)
    // Grandchild under a1: ancestors {a1, R} exempt a1 → effective 1 < 2 →
    // granted immediately even though B is queued ahead.
    const g = await b.acquire(['a1', 'R'])
    order.push('G')
    g.bind('g1')
    expect(order).toEqual(['G'])
    // a1 finishing is not enough for B (a2 + g1 still counted)…
    b.onChildTaskStatus('a1', 'done')
    await Bun.sleep(5)
    expect(order).toEqual(['G'])
    // …g1 finishing frees the second unit → B granted.
    b.onChildTaskStatus('g1', 'done')
    const bHold = await bWait
    expect(order).toEqual(['G', 'B'])
    bHold.release()
  })

  test('awaiting_* frees quota; resume re-counts without queuing', async () => {
    const b = budgetOf(stubDb, 1)
    ;(await b.acquire([])).bind('C1')
    const waiting = b.acquire([])
    b.onChildTaskStatus('C1', 'awaiting_human') // human gate → unit freed
    const hold = await waiting
    hold.bind('C2')
    // C1 resumes: re-counted unconditionally → burst to 2 > cap (accepted).
    b.onChildTaskStatus('C1', 'running')
    expect(b.activeCount()).toBe(2)
  })

  test('bookkeeping is idempotent under duplicate notifications', async () => {
    const b = budgetOf(stubDb, 4)
    ;(await b.acquire([])).bind('C1')
    b.onChildTaskStatus('C1', 'running')
    b.onChildTaskStatus('C1', 'running')
    expect(b.activeCount()).toBe(1)
    b.onChildTaskStatus('C1', 'failed')
    b.onChildTaskStatus('C1', 'failed')
    expect(b.activeCount()).toBe(0)
  })

  test('abort rejects a queued waiter and deregisters it', async () => {
    const b = budgetOf(stubDb, 1)
    ;(await b.acquire([])).bind('C1')
    const ctrl = new AbortController()
    const waiting = b.acquire([], { signal: ctrl.signal })
    ctrl.abort()
    await expect(waiting).rejects.toThrow('aborted')
    // The freed slot afterwards must not resolve the aborted waiter.
    b.onChildTaskStatus('C1', 'done')
    expect(b.activeCount()).toBe(0)
  })
})

describe('RFC-243 §3.2 — DB rebuild', () => {
  test('rebuildFromDb seeds counted from pending/running child rows only', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const wfId = ulid()
    await db.insert(workflows).values({ id: wfId, name: 'wf-budget', definition: '{}' })
    const base = {
      workflowId: wfId,
      workflowSnapshot: '{}',
      repoPath: '/x',
      worktreePath: '/x',
      baseBranch: 'main',
      inputs: '{}',
      startedAt: Date.now(),
    }
    const parent = ulid()
    await db
      .insert(tasks)
      .values({ id: parent, name: 'p', branch: 'b0', status: 'running', ...base })
    const mk = async (status: string): Promise<string> => {
      const id = ulid()
      await db.insert(tasks).values({
        id,
        name: `c-${status}`,
        branch: `b-${id.slice(-4)}`,
        status: status as 'running',
        parentTaskId: parent,
        invocationDepth: 1,
        ...base,
      })
      return id
    }
    await mk('running')
    await mk('pending')
    await mk('awaiting_human') // not counted
    await mk('done') // not counted
    const b = budgetOf(db, 8)
    await b.rebuildFromDb()
    expect(b.activeCount()).toBe(2)
  })
})
