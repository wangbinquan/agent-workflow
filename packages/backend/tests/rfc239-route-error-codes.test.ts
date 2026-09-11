// RFC-239 — route-level error codes, named here so the route-error-code
// coverage guard sees a test that exercises each NEW code:
//   file-content-side-invalid / narrative-scope-invalid / narrative-not-found
// (the service-level codes are asserted in task-file-content.test.ts /
// change-narrative.test.ts by behavior).

import { afterEach, describe, expect, test } from 'bun:test'
import type { Hono } from 'hono'
import { tasks, workflows } from '../src/db/schema'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'
import { resetChangeNarrativeStateForTests } from '../src/services/changeNarrative'
import type { ProviderNeutralDatabase } from '../src/db/query'
import { describeEachProviderHttpApplication } from './helpers/providerHttpApplicationScope'

const TOKEN = 'a'.repeat(64)

afterEach(() => {
  resetBroadcastersForTests()
  resetChangeNarrativeStateForTests()
})

async function seedTask(
  db: ProviderNeutralDatabase,
  lineage?: typeof providerTaskLineage,
): Promise<string> {
  const taskId = `01RC${Math.random().toString(36).slice(2, 10).toUpperCase()}`
  const workflowId = `wf-${taskId}`
  await db.insert(workflows).values({
    id: workflowId,
    name: 'w',
    definition: JSON.stringify({ nodes: [], edges: [] }),
  })
  await db.insert(tasks).values({
    id: taskId,
    name: 't',
    workflowId,
    workflowSnapshot: '{}',
    repoPath: '/tmp/none',
    worktreePath: '/tmp/none',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: '{}',
    startedAt: Date.now(),

    ...(lineage?.(taskId) ?? {}),
  })
  return taskId
}

async function getJson(
  app: Hono,
  path: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await app.request(path, {
    headers: { authorization: `Bearer ${TOKEN}` },
  })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

describe('RFC-239 route error codes', () => {
  registerProviderApplication((buildApp, seedTask) => {
    test('file-content with a bad side → 422 file-content-side-invalid', async () => {
      const { db, app } = await buildApp()
      const id = await seedTask(db)
      const r = await getJson(app, `/api/tasks/${id}/file-content?path=a.md&side=weird`)
      expect(r.status).toBe(422)
      expect(r.body.code).toBe('file-content-side-invalid')
    })
  })

  registerProviderApplication((buildApp, seedTask) => {
    test('change-narrative with a non-task scope → 422 narrative-scope-invalid', async () => {
      const { db, app } = await buildApp()
      const id = await seedTask(db)
      const r = await getJson(app, `/api/tasks/${id}/change-narrative?scope=node`)
      expect(r.status).toBe(422)
      expect(r.body.code).toBe('narrative-scope-invalid')
    })
  })

  registerProviderApplication((buildApp, seedTask) => {
    test('change-narrative before any generation → 404 narrative-not-found', async () => {
      const { db, app } = await buildApp()
      const id = await seedTask(db)
      const r = await getJson(app, `/api/tasks/${id}/change-narrative`)
      expect(r.status).toBe(404)
      expect(r.body.code).toBe('narrative-not-found')
    })
  })
})

// RFC-359 W50: keep native registrations while the selected calls use the complete provider application.
// RFC-359 AC-6：生命周期走共用的 `describeEachProviderHttpApplication`（`tests/helpers/`），
// 这里只剩「把本文件的 seed 夹具绑上去」这一点文件私有的东西。
function registerProviderApplication(
  register: (
    buildApp: () => Promise<{ db: ProviderNeutralDatabase; app: Hono }>,
    seedTaskFixture: typeof seedTask,
  ) => void,
): void {
  describeEachProviderHttpApplication(
    'provider',
    {
      token: TOKEN,
      opencodeVersion: '1.15.0',
      dbVersion: 1,
      tempPrefix: 'rfc359-w50-rfc239-route-error-codes-',
    },
    (scope) =>
      register(
        async () => ({ db: scope.harness.db, app: (await scope.open()).app }),
        (db) => seedTask(db, providerTaskLineage),
      ),
  )
}

function providerTaskLineage(id: string) {
  return {
    executionLineageId: id,
    lineageSlotPathJson: JSON.stringify([
      { stableNodeKey: 'task-root', frozenOccurrenceKey: id, workflowRevision: null },
    ]),
  }
}
