// RFC-244 capacity smoke: keep this deterministic and generous. It is not a
// microbenchmark; it guards against accidentally returning to 500-row client
// scans or making each child expansion rescan every task globally.

import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'

import { buildActor } from '../src/auth/actor'
import { createInMemoryDb } from '../src/db/client'
import { dbTxSync } from '../src/db/txSync'
import { tasks, users, workflows } from '../src/db/schema'
import { listTaskOperationsPage } from '../src/services/taskOperations'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const ROOT_COUNT = 20
const CHILDREN_PER_ROOT = 999

describe('RFC-244 task operations capacity smoke', () => {
  test('20k tasks support one root page plus twenty bounded child expansions', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await db.insert(users).values({
      id: 'capacity-owner',
      username: 'capacity-owner',
      displayName: 'Capacity Owner',
      role: 'user',
      createdAt: 1,
      updatedAt: 1,
    })
    await db.insert(workflows).values({
      id: 'capacity-workflow',
      name: 'Capacity workflow',
      definition: JSON.stringify({ nodes: [], edges: [], inputs: [] }),
    })

    const rows: (typeof tasks.$inferInsert)[] = []
    for (let rootIndex = 0; rootIndex < ROOT_COUNT; rootIndex += 1) {
      const rootId = `capacity-root-${String(rootIndex).padStart(2, '0')}`
      rows.push(taskRow(rootId, null, rootIndex * 10_000))
      for (let childIndex = 0; childIndex < CHILDREN_PER_ROOT; childIndex += 1) {
        rows.push(
          taskRow(
            `${rootId}-child-${String(childIndex).padStart(4, '0')}`,
            rootId,
            rootIndex * 10_000 + childIndex + 1,
          ),
        )
      }
    }
    dbTxSync(db, (tx) => {
      for (let offset = 0; offset < rows.length; offset += 200) {
        tx.insert(tasks)
          .values(rows.slice(offset, offset + 200))
          .run()
      }
    })
    const actor = buildActor({
      user: {
        id: 'capacity-owner',
        username: 'capacity-owner',
        displayName: 'Capacity Owner',
        role: 'user',
        status: 'active',
      },
      source: 'session',
    })
    const started = performance.now()
    const rootPage = await listTaskOperationsPage(db, actor, { limit: '50' })
    expect(rootPage.kind).toBe('root')
    expect(rootPage.items).toHaveLength(ROOT_COUNT)
    for (const root of rootPage.items) {
      const children = await listTaskOperationsPage(db, actor, {
        parent_id: root.id,
        limit: '50',
      })
      expect(children.kind).toBe('children')
      expect(children.items).toHaveLength(50)
      expect(children.nextCursor).not.toBeNull()
    }
    const elapsedMs = performance.now() - started
    console.info(`[rfc244-capacity] 20k root+20-child-pages ${elapsedMs.toFixed(1)}ms`)
    // Wide enough for shared CI hosts; catches an accidental global child
    // plan or unbounded per-row query without pretending to be a perf SLA.
    expect(elapsedMs).toBeLessThan(30_000)
  }, 45_000)
})

function taskRow(
  id: string,
  parentTaskId: string | null,
  startedAt: number,
): typeof tasks.$inferInsert {
  return {
    id,
    name: id,
    workflowId: 'capacity-workflow',
    workflowSnapshot: '{}',
    repoPath: `/tmp/${id}`,
    worktreePath: `/tmp/wt-${id}`,
    baseBranch: 'main',
    branch: `agent-workflow/${id}`,
    status: 'done',
    inputs: '{}',
    startedAt,
    finishedAt: startedAt + 1,
    ownerUserId: 'capacity-owner',
    parentTaskId,
    invocationDepth: parentTaskId === null ? 0 : 1,
  }
}
