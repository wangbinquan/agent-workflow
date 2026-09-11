// RFC-122 — route test for the per-(task, asking-node) clarify directive toggle:
//   GET  /api/tasks/:id/clarify-directives
//   POST /api/tasks/:id/nodes/:nodeId/clarify-directive
//
// The daemon TOKEN actor is the '__system__' user; seeding the task with
// ownerUserId='__system__' makes it the owner so the member/visibility gates
// pass (member-vs-non-member ACL itself is covered by the RFC-099 taskCollab
// tests; a source-level assertion below locks that the write path is
// requireTaskMember-gated). Locks: GET map shape, set stop/continue happy paths +
// persistence, non-asking-node → 422, invalid directive → 422, missing task → 404,
// contract-registry registration.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Hono } from 'hono'
import { tasks, workflows } from '../src/db/schema'
import { getNodeClarifyDirective } from '../src/services/taskClarifyDirective'
import type { ProviderNeutralDatabase } from '../src/db/query'
import type { ProviderHarness } from './helpers/eachProvider'
import { describeEachProviderHttpApplication } from './helpers/providerHttpApplicationScope'

const TOKEN = 'a'.repeat(64)
const AUTH = { Authorization: `Bearer ${TOKEN}` }

// selfAgent has a self-clarify channel; questioner feeds a cross node; clar / cc1
// are the channel nodes; plain is a plain agent — only the first two are asking.
const SNAPSHOT = JSON.stringify({
  $schema_version: 3,
  inputs: [],
  nodes: [
    { id: 'selfAgent', kind: 'agent-single', agentName: 'a' },
    { id: 'clar', kind: 'clarify' },
    { id: 'questioner', kind: 'agent-single', agentName: 'q' },
    { id: 'cc1', kind: 'clarify-cross-agent' },
    { id: 'plain', kind: 'agent-single', agentName: 'p' },
  ],
  edges: [
    {
      id: 'e1',
      source: { nodeId: 'selfAgent', portName: '__clarify__' },
      target: { nodeId: 'clar', portName: 'questions' },
    },
    {
      id: 'e2',
      source: { nodeId: 'questioner', portName: '__clarify__' },
      target: { nodeId: 'cc1', portName: 'questions' },
    },
  ],
  outputs: [],
})

async function seedTask(
  db: ProviderNeutralDatabase,
  taskId: string,
  lineage?: typeof providerTaskLineage,
): Promise<void> {
  await db.insert(workflows).values({
    id: `wf-${taskId}`,
    name: 'wf',
    definition: '{}',
    description: '',
    version: 1,
    schemaVersion: 3,
  })
  await db.insert(tasks).values({
    id: taskId,
    name: 'fixture',
    ownerUserId: '__system__',
    workflowId: `wf-${taskId}`,
    workflowSnapshot: SNAPSHOT,
    repoPath: '/tmp/r',
    worktreePath: '',
    baseBranch: 'main',
    branch: 'b',
    status: 'awaiting_human',
    inputs: '{}',
    startedAt: Date.now(),

    ...(lineage?.(taskId) ?? {}),
  })
}

function post(app: Hono, taskId: string, nodeId: string, body: unknown) {
  return app.request(`/api/tasks/${taskId}/nodes/${nodeId}/clarify-directive`, {
    method: 'POST',
    headers: { ...AUTH, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('RFC-122 clarify-directive route', () => {
  registerProviderApplication((harness, makeApp, seedTask) => {
    test('GET returns {} for a fresh task; POST stop persists; GET reflects it', async () => {
      const db = harness.db
      await seedTask(db, 'task1')
      const app = await makeApp(db)

      const empty = await app.request('/api/tasks/task1/clarify-directives', { headers: AUTH })
      expect(empty.status).toBe(200)
      expect(await empty.json()).toEqual({})

      const set = await post(app, 'task1', 'selfAgent', { directive: 'stop' })
      expect(set.status).toBe(200)
      expect(await set.json()).toEqual({ ok: true, nodeId: 'selfAgent', directive: 'stop' })
      expect(await getNodeClarifyDirective(db, 'task1', 'selfAgent')).toBe('stop')

      const after = await app.request('/api/tasks/task1/clarify-directives', { headers: AUTH })
      expect(await after.json()).toEqual({ selfAgent: 'stop' })
    })
  })

  registerProviderApplication((harness, makeApp, seedTask) => {
    test('POST continue flips an existing stop back', async () => {
      const db = harness.db
      await seedTask(db, 'task2')
      const app = await makeApp(db)
      await post(app, 'task2', 'questioner', { directive: 'stop' })
      expect(await getNodeClarifyDirective(db, 'task2', 'questioner')).toBe('stop')

      const flip = await post(app, 'task2', 'questioner', { directive: 'continue' })
      expect(flip.status).toBe(200)
      expect(await getNodeClarifyDirective(db, 'task2', 'questioner')).toBe('continue')
    })
  })

  registerProviderApplication((harness, makeApp, seedTask) => {
    test('cross-questioner is a valid asking node', async () => {
      const db = harness.db
      await seedTask(db, 'task3')
      const app = await makeApp(db)
      const res = await post(app, 'task3', 'questioner', { directive: 'stop' })
      expect(res.status).toBe(200)
    })
  })

  registerProviderApplication((harness, makeApp, seedTask) => {
    test('422 on a channel node / plain agent (not an asking node)', async () => {
      const db = harness.db
      await seedTask(db, 'task4')
      const app = await makeApp(db)
      for (const nodeId of ['clar', 'cc1', 'plain', 'nope']) {
        const res = await post(app, 'task4', nodeId, { directive: 'stop' })
        expect(res.status).toBe(422)
        expect(((await res.json()) as { code?: string }).code).toBe('not-asking-node')
      }
      expect(await getNodeClarifyDirective(db, 'task4', 'plain')).toBeUndefined()
    })
  })

  registerProviderApplication((harness, makeApp, seedTask) => {
    test('422 on an invalid directive value', async () => {
      const db = harness.db
      await seedTask(db, 'task5')
      const app = await makeApp(db)
      const res = await post(app, 'task5', 'selfAgent', { directive: 'halt' })
      expect(res.status).toBe(422)
      expect(((await res.json()) as { code?: string }).code).toBe('clarify-directive-invalid')
    })
  })

  registerProviderApplication((harness, makeApp) => {
    test('404 on a missing task', async () => {
      const db = harness.db
      const app = await makeApp(db)
      const res = await post(app, 'ghost', 'selfAgent', { directive: 'stop' })
      expect(res.status).toBe(404)
    })
  })

  test('write path is member-gated + registered in the contract registry', () => {
    const routeSrc = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'routes', 'taskClarifyDirective.ts'),
      'utf8',
    )
    expect(routeSrc).toContain('requireTaskMember')
    const registry = readFileSync(resolve(import.meta.dir, 'contracts', 'registry.ts'), 'utf8')
    expect(registry).toContain("path: '/api/tasks/:id/clarify-directives'")
    expect(registry).toContain("path: '/api/tasks/:id/nodes/:nodeId/clarify-directive'")
  })
})

// RFC-359 W50: keep native registrations while the selected calls use the complete provider application.
// RFC-359 AC-6：生命周期走共用的 `describeEachProviderHttpApplication`（`tests/helpers/`）。
// 合并前这一份把 `config.json` 放在**另一个**临时目录里；共用作用域统一放进本次的 app home——
// 两者都是用完即删的临时目录，本文件没有任何判据读它，形态差别对用例不可见。
function registerProviderApplication(
  register: (
    harness: ProviderHarness,
    makeApp: (db: ProviderNeutralDatabase) => Promise<Hono>,
    seedTaskFixture: typeof seedTask,
  ) => void,
): void {
  describeEachProviderHttpApplication(
    'provider',
    { token: TOKEN, opencodeVersion: '1.14.25', dbVersion: 1, tempPrefix: 'aw-cd-home-' },
    (scope) =>
      register(
        scope.harness,
        async (db) => {
          if (db !== scope.harness.db) throw new Error('provider fixture database mismatch')
          return (await scope.open()).app
        },
        (db, taskId) => seedTask(db, taskId, providerTaskLineage),
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
