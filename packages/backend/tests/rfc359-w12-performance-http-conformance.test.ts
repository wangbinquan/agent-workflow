// RFC-359 AC11: functional evidence for the actual HTTP benchmark graph.
// These small fixtures establish live query/response behavior, not full-corpus P95.
import {
  CachedRepoPageSchema,
  OverviewResponseSchema,
  TaskCatalogPageSchema,
  WorkgroupRuntimeConfigSchema,
} from '@agent-workflow/shared'
import { afterEach, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import type { Hono } from 'hono'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PERF_CORPUS_ENTRY, type PerfCorpusDimensions } from '../../../scripts/perf-corpus'
import { readPerformanceCorpusReceipt, seedPerformanceCorpus } from '../../../scripts/perf-seed'
import type { ProviderNeutralDatabase } from '@/db/query'
import {
  cachedRepos,
  clarifyRounds,
  docVersions,
  employeeCases,
  employeeContextRecords,
  employeeDefinitionRevisions,
  employeeDefinitions,
  nodeRuns,
  taskCollaborators,
  tasks,
  workflows,
  workgroupTaskState,
} from '@/db/schema'
import { developmentEmployeeTypePackage } from '@/modules/development-automation/composition/employeeTypePackage'
import {
  contentDigest,
  digitalEmployeeDefinitionContentSchema,
  digitalEmployeeDefinitionDraftSchema,
  employeeTypePackageDescriptorSchema,
} from '@/modules/digital-employee/domain/model'
import { encodeLineageSlotPath } from '@/modules/task-execution/domain/executionIntent'
import { describeEachProvider, type ProviderHarness } from './helpers/eachProvider'
import { createProductionPerformanceApplication } from './helpers/productionPerformanceApplication'

const DIMENSIONS: PerfCorpusDimensions = {
  tasks: 123,
  runsPerTask: 2,
  events: 37,
  deliveries: 11,
  repos: 7,
}
const homes: string[] = []

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

async function fixture(harness: ProviderHarness) {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc359-http-performance-'))
  homes.push(appHome)
  const configPath = join(appHome, 'config.json')
  writeFileSync(configPath, '{}\n')
  const receipt = await seedPerformanceCorpus({
    db: harness.db,
    session: harness.session,
    dimensions: DIMENSIONS,
  })
  const app = await createProductionPerformanceApplication({
    db: harness.db,
    appHome,
    configPath,
    daemonToken: PERF_CORPUS_ENTRY.bearerToken,
  })
  return { app, appHome, receipt }
}

function request(app: Hono, path: string) {
  return app.request(path, {
    headers: { Authorization: `Bearer ${PERF_CORPUS_ENTRY.bearerToken}` },
  })
}

async function json(app: Hono, path: string): Promise<unknown> {
  const response = await request(app, path)
  const body: unknown = await response.json()
  expect(response.status, `${path}: ${JSON.stringify(body)}`).toBe(200)
  return body
}

async function seedTask(
  db: ProviderNeutralDatabase,
  id: string,
  status: typeof tasks.$inferInsert.status,
  extra: Partial<typeof tasks.$inferInsert> = {},
): Promise<void> {
  const now = Date.now()
  await db.insert(tasks).values({
    id,
    name: id,
    workflowId: PERF_CORPUS_ENTRY.workflowId,
    workflowSnapshot: JSON.stringify({
      $schema_version: 4,
      inputs: [],
      nodes: [
        { id: 'writer', kind: 'agent-single', agentName: 'writer' },
        { id: 'review', kind: 'review', title: 'Review', description: '' },
        { id: 'clarify', kind: 'clarify', title: 'Clarify' },
      ],
      edges: [],
    }),
    repoPath: '/repo/perf-0',
    worktreePath: '',
    baseBranch: 'main',
    branch: `agent-workflow/${id}`,
    status,
    inputs: '{}',
    ownerUserId: PERF_CORPUS_ENTRY.userId,
    startedAt: now,
    branchStartedAt: now,
    rootTaskId: id,
    executionLineageId: id,
    lineageSlotPathJson: encodeLineageSlotPath([
      { stableNodeKey: 'task-root', frozenOccurrenceKey: id, workflowRevision: null },
    ]),
    ...extra,
  })
  await db.insert(taskCollaborators).values({
    taskId: id,
    userId: PERF_CORPUS_ENTRY.userId,
    role: 'owner',
    addedBy: PERF_CORPUS_ENTRY.userId,
    addedAt: now,
  })
}

describeEachProvider('RFC-359 production HTTP performance graph', (harness) => {
  test('serves all nine original benchmark scenarios without changing the corpus', async () => {
    const { app, receipt } = await fixture(harness)
    const first = TaskCatalogPageSchema.parse(await json(app, '/api/task-catalog?limit=50'))
    expect(first.schemaVersion).toBe(1)
    expect(first.sourceIds).toEqual(['agent', 'workflow', 'workgroup', 'digital-employee'])
    expect(first.items).toHaveLength(50)
    expect(first.items.every((item) => item.sourceId === 'workflow')).toBe(true)
    expect(first.nextCursor).not.toBeNull()
    if (first.nextCursor === null) throw new Error('the original second-page scenario is required')
    const second = TaskCatalogPageSchema.parse(
      await json(app, `/api/task-catalog?limit=50&cursor=${encodeURIComponent(first.nextCursor)}`),
    )
    expect(second.items).toHaveLength(50)
    expect(second.items.some((item) => first.items.some((head) => head.id === item.id))).toBe(false)
    const combined = [...first.items, ...second.items]
    expect(combined.map((item) => item.id)).toEqual(
      [...combined]
        .sort(
          (left, right) =>
            right.hierarchy.branchStartedAt - left.hierarchy.branchStartedAt ||
            right.id.localeCompare(left.id),
        )
        .map((item) => item.id),
    )
    const running = TaskCatalogPageSchema.parse(
      await json(app, '/api/task-catalog?limit=50&statuses=running'),
    )
    expect(running.items.map((item) => item.id)).toEqual(
      [117, 110, 103, 96, 88, 82, 75, 68, 61, 54, 47, 40, 33, 26, 18, 12, 5].map(
        (index) => `perftask${String(index).padStart(7, '0')}`,
      ),
    )
    expect(
      running.items
        .filter((item) => item.hierarchy.matchKind === 'self')
        .every((item) => item.status === 'running'),
    ).toBe(true)
    // Running children 19 and 89 retain their parent branch rows in the filtered view.
    expect(
      running.items
        .filter((item) => item.hierarchy.matchKind === 'context')
        .map((item) => ({ id: item.id, matches: item.hierarchy.matchingDescendantCount })),
    ).toEqual([
      { id: 'perftask0000088', matches: 1 },
      { id: 'perftask0000018', matches: 1 },
    ])
    const repositories = CachedRepoPageSchema.parse(await json(app, '/api/cached-repos?limit=50'))
    const referenced = CachedRepoPageSchema.parse(
      await json(app, '/api/cached-repos?limit=50&view=referenced'),
    )
    expect(repositories.items).toHaveLength(DIMENSIONS.repos)
    expect(referenced.items).toHaveLength(DIMENSIONS.repos)
    expect(referenced.facets).toEqual(repositories.facets)
    expect(await json(app, '/api/reviews/pending-count')).toEqual({ count: 0 })
    expect(await json(app, '/api/clarify/pending-count')).toEqual({ count: 0 })
    expect(await json(app, '/api/workgroup-tasks/pending-count')).toEqual({
      gates: 0,
      deliveries: 0,
      total: 0,
    })
    const overview = OverviewResponseSchema.parse(await json(app, '/api/overview'))
    expect(overview.resources.repos).toBe(DIMENSIONS.repos)
    expect(overview.resources.workflows).toBe(1)
    const after = await readPerformanceCorpusReceipt(harness.db, DIMENSIONS)
    expect(after.actualCounts).toEqual(receipt.actualCounts)
    expect(after.actualDigests).toEqual(receipt.actualDigests)
    expect(after.matchesExpected).toBe(true)
  })

  test('the same HTTP instance reads changed task and repository rows', async () => {
    const { app } = await fixture(harness)
    const first = TaskCatalogPageSchema.parse(await json(app, '/api/task-catalog?limit=50'))
    const target = first.items[0]!
    await harness.db
      .update(tasks)
      .set({ name: 'changed after HTTP construction', status: 'running' })
      .where(eq(tasks.id, target.id))
    await harness.db
      .update(cachedRepos)
      .set({ defaultBranch: 'changed-branch' })
      .where(eq(cachedRepos.id, 'perfrepo000000'))
    const after = TaskCatalogPageSchema.parse(await json(app, '/api/task-catalog?limit=50'))
    expect(after.items.find((item) => item.id === target.id)).toMatchObject({
      title: 'changed after HTTP construction',
      status: 'running',
    })
    const repositories = CachedRepoPageSchema.parse(await json(app, '/api/cached-repos?limit=50'))
    expect(repositories.items.find((item) => item.id === 'perfrepo000000')?.defaultBranch).toBe(
      'changed-branch',
    )
  })

  test('all three badge routes observe real pending rows and their later settlement', async () => {
    const { app, appHome } = await fixture(harness)
    const db = harness.db
    await seedTask(db, 'http-review', 'awaiting_review')
    await seedTask(db, 'http-clarify', 'awaiting_human')
    await seedTask(db, 'http-workgroup', 'awaiting_review', {
      workgroupId: 'http-group',
      workgroupConfigJson: JSON.stringify(
        WorkgroupRuntimeConfigSchema.parse({
          workgroupId: 'http-group',
          workgroupName: 'HTTP fixture room',
          mode: 'free_collab',
          leaderMemberId: null,
          switches: { shareOutputs: true, directMessages: false, blackboard: false },
          maxRounds: 5,
          completionGate: true,
          goal: 'Complete the fixture',
          instructions: '',
          members: [
            {
              id: 'human',
              memberType: 'human',
              agentName: null,
              agentId: null,
              userId: PERF_CORPUS_ENTRY.userId,
              displayName: 'fixture-owner',
              roleDesc: 'reviewer',
            },
          ],
        }),
      ),
    })
    await db.insert(nodeRuns).values([
      { id: 'http-review-run', taskId: 'http-review', nodeId: 'review', status: 'awaiting_review' },
      { id: 'http-asker-run', taskId: 'http-clarify', nodeId: 'writer', status: 'done' },
      {
        id: 'http-clarify-run',
        taskId: 'http-clarify',
        nodeId: 'clarify',
        status: 'awaiting_human',
      },
    ])
    writeFileSync(join(appHome, 'http-review.md'), '# A real review artifact\n')
    await db.insert(docVersions).values({
      id: 'http-doc',
      taskId: 'http-review',
      reviewNodeId: 'review',
      reviewNodeRunId: 'http-review-run',
      sourceNodeId: 'writer',
      sourcePortName: 'out',
      versionIndex: 1,
      reviewIteration: 0,
      bodyPath: 'http-review.md',
      decision: 'pending',
    })
    await db.insert(clarifyRounds).values({
      id: 'http-round',
      taskId: 'http-clarify',
      kind: 'self',
      askingNodeId: 'writer',
      askingNodeRunId: 'http-asker-run',
      intermediaryNodeId: 'clarify',
      intermediaryNodeRunId: 'http-clarify-run',
      questionsJson: '[]',
      status: 'awaiting_human',
    })
    await db.insert(workgroupTaskState).values({
      taskId: 'http-workgroup',
      gateStatus: 'awaiting_confirmation',
      updatedAt: Date.now(),
    })
    expect(await json(app, '/api/reviews/pending-count')).toEqual({ count: 1 })
    expect(await json(app, '/api/clarify/pending-count')).toEqual({ count: 1 })
    expect(await json(app, '/api/workgroup-tasks/pending-count')).toEqual({
      gates: 1,
      deliveries: 0,
      total: 1,
    })
    await db.update(docVersions).set({ decision: 'approved' }).where(eq(docVersions.id, 'http-doc'))
    await db.update(nodeRuns).set({ status: 'done' }).where(eq(nodeRuns.id, 'http-review-run'))
    await db
      .update(clarifyRounds)
      .set({ status: 'answered', answersJson: '[]' })
      .where(eq(clarifyRounds.id, 'http-round'))
    await db
      .update(workgroupTaskState)
      .set({ gateStatus: 'approved' })
      .where(eq(workgroupTaskState.taskId, 'http-workgroup'))
    expect(await json(app, '/api/reviews/pending-count')).toEqual({ count: 0 })
    expect(await json(app, '/api/clarify/pending-count')).toEqual({ count: 0 })
    expect(await json(app, '/api/workgroup-tasks/pending-count')).toEqual({
      gates: 0,
      deliveries: 0,
      total: 0,
    })
  })

  test('the default catalog reads and refreshes a stored digital-employee case', async () => {
    const { app } = await fixture(harness)
    const db = harness.db
    const descriptor = employeeTypePackageDescriptorSchema.parse(
      JSON.parse(developmentEmployeeTypePackage.descriptorJson),
    )
    const now = Date.now()
    const configuration = digitalEmployeeDefinitionDraftSchema.parse({
      schemaVersion: 1,
      typeRef: descriptor.typeRef,
      jobTemplateRef: { id: 'http-job', revision: 1 },
      displayName: 'HTTP employee',
      workScope: {},
      toolOverrides: [],
      collaborationOverrides: [],
    })
    const content = digitalEmployeeDefinitionContentSchema.parse({
      schemaVersion: 1,
      typeRef: descriptor.typeRef,
      jobTemplateRef: configuration.jobTemplateRef,
      displayName: configuration.displayName,
      workScopeRef: { id: 'http-scope', revision: 1 },
      workScopeSummary: 'HTTP case fixture',
      exactToolBindings: [],
      exactCollaborationBindings: [],
      compiledClosureDigest: contentDigest({ fixture: 'http-case' }),
    })
    await db.insert(employeeDefinitions).values({
      id: 'http-employee',
      name: configuration.displayName,
      typeId: descriptor.typeRef.typeId,
      typeRevision: descriptor.typeRef.revision,
      configurationJson: JSON.stringify(configuration),
      currentRevision: 1,
      ownerUserId: PERF_CORPUS_ENTRY.userId,
      createdAt: now,
      updatedAt: now,
    })
    await db.insert(employeeDefinitionRevisions).values({
      employeeId: 'http-employee',
      revision: 1,
      contentJson: JSON.stringify(content),
      contentDigest: contentDigest(content),
      createdAt: now,
    })
    await db.insert(employeeCases).values({
      id: 'http-case',
      name: 'A persisted employee case',
      employeeId: 'http-employee',
      employeeRevision: 1,
      typeId: descriptor.typeRef.typeId,
      typeRevision: descriptor.typeRef.revision,
      primaryContextId: 'http-context',
      executionPolicyRevision: 1,
      ownerUserId: PERF_CORPUS_ENTRY.userId,
      state: 'active',
      createdAt: now,
      updatedAt: now,
    })
    await db.insert(employeeContextRecords).values({
      id: 'http-context',
      caseId: 'http-case',
      typeId: 'fixture-context',
      schemaVersion: 1,
      currentRevision: 1,
      lifecycleState: 'active',
      stateJson: JSON.stringify({ subjectRef: 'http-subject', repositoryRef: 'http-repository' }),
      artifactRefsJson: '[]',
      createdAt: now,
      updatedAt: now,
    })
    const recording = harness.recordStatements()
    const first = TaskCatalogPageSchema.parse(await json(app, '/api/task-catalog?limit=50'))
    recording.stop()
    expect(recording.statements.some((statement) => statement.sql.includes('employee_cases'))).toBe(
      true,
    )
    expect(first.items.find((item) => item.id === 'http-case')).toMatchObject({
      sourceId: 'digital-employee',
      title: 'A persisted employee case',
      status: 'running',
      targetLabel: 'http-repository',
    })
    await db
      .update(employeeCases)
      .set({ name: 'The same case changed', state: 'blocked', blockReason: 'fixture-block' })
      .where(eq(employeeCases.id, 'http-case'))
    const after = TaskCatalogPageSchema.parse(await json(app, '/api/task-catalog?limit=50'))
    expect(after.items.find((item) => item.id === 'http-case')).toMatchObject({
      title: 'The same case changed',
      status: 'failed',
      statusDetail: { 'zh-CN': 'fixture-block', 'en-US': 'fixture-block' },
    })
  })

  test('overview retains its real owner queries across requests', async () => {
    const { app } = await fixture(harness)
    const before = OverviewResponseSchema.parse(await json(app, '/api/overview'))
    await harness.db.insert(workflows).values({
      id: 'http-extra-workflow',
      name: 'HTTP extra workflow',
      definition: '{"nodes":[],"edges":[],"inputs":[]}',
    })
    await seedTask(harness.db, 'http-new-done', 'done', { finishedAt: Date.now() })
    const after = OverviewResponseSchema.parse(await json(app, '/api/overview'))
    expect(before.tasks).not.toBeNull()
    expect(after.tasks).not.toBeNull()
    expect(after.resources.workflows).toBe((before.resources.workflows ?? 0) + 1)
    expect(after.tasks?.done7d).toBe((before.tasks?.done7d ?? 0) + 1)
    expect(after.resources.repos).toBe(DIMENSIONS.repos)
  })

  test('the shared HTTP shell retains query errors and missing-route responses', async () => {
    const { app } = await fixture(harness)
    const invalid = await request(app, '/api/cached-repos?limit=0')
    expect(invalid.status).toBe(422)
    expect(await invalid.json()).toMatchObject({ ok: false, code: 'invalid_query' })
    const missing = await request(app, '/api/rfc359-performance-missing-route')
    expect(missing.status).toBe(404)
    expect(await missing.json()).toEqual({
      ok: false,
      code: 'route-not-found',
      message: 'no route for /api/rfc359-performance-missing-route',
    })
  })
})
