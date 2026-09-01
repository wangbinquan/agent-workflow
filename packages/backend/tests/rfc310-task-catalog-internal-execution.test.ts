// Public task catalogs use TaskEngine's generic visibility boundary. Internal
// executions remain durable and directly addressable without entering public
// pagination, hierarchy or facets.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { TaskCatalogVisibility } from '@agent-workflow/shared'

import { buildActor } from '../src/auth/actor'
import { createInMemoryDb } from '../src/db/client'
import { tasks, users, workflows } from '../src/db/schema'
import { composeTaskExecutionCatalogSources } from '../src/modules/task-execution/composition/sqliteTaskCatalogSources'
import { listTaskItems, listTasks } from '../src/services/task'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function task(
  id: string,
  startedAt: number,
  options: {
    catalogVisibility?: TaskCatalogVisibility
    parentTaskId?: string
    rootTaskId?: string
  } = {},
) {
  return {
    id,
    name: id,
    workflowId: 'wf-rfc310-catalog',
    workflowSnapshot: '{}',
    repoPath: `/tmp/${id}`,
    worktreePath: `/tmp/wt-${id}`,
    baseBranch: 'main',
    branch: `agent-workflow/${id}`,
    status: 'done' as const,
    inputs: '{}',
    startedAt,
    finishedAt: startedAt + 1,
    runningMs: 1,
    ownerUserId: 'catalog-owner',
    launchOrigin: 'manual' as const,
    catalogVisibility: options.catalogVisibility ?? 'public',
    parentTaskId: options.parentTaskId ?? null,
    invocationDepth: options.parentTaskId === undefined ? 0 : 1,
    branchStartedAt: startedAt,
    rootTaskId: options.rootTaskId ?? id,
  }
}

describe('task catalog internal execution boundary', () => {
  test('public workflow pages, cursors and facets exclude generic internal trees', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const now = 1_788_278_400_000
    await db.insert(users).values({
      id: 'catalog-owner',
      username: 'catalog-owner',
      displayName: 'Catalog Owner',
      role: 'admin',
      createdAt: now,
      updatedAt: now,
    })
    await db.insert(workflows).values({
      id: 'wf-rfc310-catalog',
      name: 'Public workflow',
      definition: JSON.stringify({ nodes: [], edges: [], inputs: [] }),
    })
    await db.insert(tasks).values([
      task('public-new', 500),
      task('internal-attempt-1', 400, { catalogVisibility: 'internal' }),
      task('internal-attempt-2', 300, { catalogVisibility: 'internal' }),
      task('internal-host', 200, { catalogVisibility: 'internal' }),
      task('internal-host-child', 250, {
        catalogVisibility: 'internal',
        parentTaskId: 'internal-host',
        rootTaskId: 'internal-host',
      }),
      task('internal-under-public', 450, {
        catalogVisibility: 'internal',
        parentTaskId: 'public-new',
        rootTaskId: 'public-new',
      }),
      task('public-old', 100),
    ])

    const requestActor = buildActor({
      user: {
        id: 'catalog-owner',
        username: 'catalog-owner',
        displayName: 'Catalog Owner',
        role: 'admin',
        status: 'active',
      },
      source: 'session',
    })
    const workflowSource = composeTaskExecutionCatalogSources(db).find(
      (source) => source.sourceId === 'workflow',
    )
    if (workflowSource === undefined) throw new Error('workflow source is missing')

    const first = await workflowSource.list({ actor: requestActor, limit: '1' })
    expect(first.items.map((item) => item.id)).toEqual(['public-new'])
    expect(first.facets).toEqual({ all: 2, active: 0, attention: 0, finished: 2 })
    expect(first.nextCursor).not.toBeNull()

    const second = await workflowSource.list({
      actor: requestActor,
      limit: '1',
      cursor: first.nextCursor ?? undefined,
    })
    expect(second.items.map((item) => item.id)).toEqual(['public-old'])
    expect(second.nextCursor).toBeNull()

    const [legacyRows, legacyItems] = await Promise.all([
      listTasks(db, { catalogVisibility: 'public' }),
      listTaskItems(db, { catalogVisibility: 'public' }),
    ])
    expect(legacyRows.map((item) => item.id)).toEqual(['public-new', 'public-old'])
    expect(legacyItems.map((item) => [item.id, item.childCount])).toEqual([
      ['public-new', 0],
      ['public-old', 0],
    ])

    const durableInternalRows = await db
      .select({ id: tasks.id })
      .from(tasks)
      .then((rows) =>
        rows
          .map((row) => row.id)
          .filter((id) => id.startsWith('internal-'))
          .sort(),
      )
    expect(durableInternalRows).toEqual([
      'internal-attempt-1',
      'internal-attempt-2',
      'internal-host',
      'internal-host-child',
      'internal-under-public',
    ])
  })

  test('public task components contain no digital-employee source branch', () => {
    const commonService = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'services', 'taskOperations.ts'),
      'utf8',
    )
    const catalogAdapter = readFileSync(
      resolve(
        import.meta.dir,
        '..',
        'src',
        'modules',
        'task-execution',
        'application',
        'adapters',
        'task-catalog-adapter.ts',
      ),
      'utf8',
    )
    const legacyRoute = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'routes', 'tasks.ts'),
      'utf8',
    )

    for (const source of [commonService, catalogAdapter, legacyRoute]) {
      expect(source).not.toContain('digitalEmployee')
      expect(source).not.toContain('digital_employee')
    }
    expect(commonService).toContain('catalogVisibility')
    expect(catalogAdapter).toContain("catalogVisibility: 'public'")
    expect(legacyRoute).toContain("catalogVisibility: 'public'")
  })
})
