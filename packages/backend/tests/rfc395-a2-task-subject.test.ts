import { createNodeRunQueries, createNodeOutputQueries } from '@/modules/task-execution/composition'
import { createTaskSubjectQueries } from '@/modules/task-execution/composition'
import { taskExecutionParticipants } from './helpers/taskExecutionParticipantBindings'
import { composeAgentLaunchResourceOperations } from '@/modules/resource-catalog/composition/agentLaunchResources'
import { legacyContentRef } from '@/platform/content/contentRef'
import { contentRowColumns } from '@/platform/content/infrastructure/contentStore'
// RFC-395 II-a A2: all subject readers must work without catalog host rows on either provider.
import { expect, test } from 'bun:test'
import { ulid } from 'ulid'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AgentSchema,
  WORKFLOW_SCHEMA_VERSION,
  taskExecutionKind,
  type WorkflowDefinition,
} from '@agent-workflow/shared'
import { buildActor } from '@/auth/actor'
import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf } from '@/platform/persistence/sessionTables'
import {
  definitionAnchorId,
  TASK_DEFINITION_HOSTS,
} from '@/modules/task-execution/domain/taskSubject'
import type { TaskSubject } from '@/modules/task-execution/public/types'
import {
  loadTaskProjection,
  taskListSummariesProjection,
  assertManualExecutionAllowedProjection,
  assertTaskWorkflowSyncable,
  taskWorkflowSyncPreviewProjection,
} from '@/modules/task-execution/infrastructure/taskRouteOperations'
import { createDatabaseTaskLifecycleWsProjection } from '@/modules/task-execution/infrastructure/taskLifecycleWsProjection'
import { getTask } from '@/modules/task-execution/infrastructure/taskDetailRead'
import { layoutBuiltinWorkflowSnapshot } from '@/modules/task-execution/domain/builtinWorkflowLayout'
import {
  getWorkflow,
  listWorkflows,
} from '@/modules/resource-catalog/infrastructure/legacy/workflow'
import { createWorkflowMutationParticipant } from '@/modules/resource-catalog/infrastructure/workflowMutationParticipant'
import { createTaskExecutionCatalogSourceFactory } from '@/modules/task-execution/infrastructure/taskExecutionCatalogSources'
import { createDatabaseTaskListPage } from '@/modules/task-execution/infrastructure/taskListPage'
import { composeOwnerIdentityQueries } from '@/modules/identity-access/composition/providerOperations'
import { createPortableBackupApplicationAssets } from '@/platform/persistence/portableApplicationAssets'
import {
  listReviewSummaries,
  countPendingReviews,
  getReviewDetail,
} from '@/modules/collaboration/infrastructure/review'
import { DrizzleMemoryInjectionReadStore } from '@/modules/memory/infrastructure/memoryInjectionReadStore'
import { DrizzleMemoryDistillWorkStore } from '@/modules/memory/infrastructure/memoryDistillWorkStore'
import { injectMemoryForRun } from '@/modules/memory/application/injection/injectMemory'
import { resourceScopeAccessReads } from '@/modules/resource-catalog/infrastructure/aggregateAdapters/resourceScopeAuthorization'
import {
  getAclResourceAccessRow,
  loadAclResourceNamesByIds,
  listAclResourceIdentityRowsByNames,
} from '@/modules/resource-catalog/infrastructure/aclReadRepository'
import { createResourcePackageReadPort } from '@/modules/resource-catalog/infrastructure/packageResourceRows'
import { createResourceCatalogOverviewCountPort } from '@/modules/resource-catalog/infrastructure/resourceCatalogOverview'
import { describeEachProvider } from './helpers/eachProvider'
import {
  taskFixture,
  nodeRunFixture,
  workflowFixture,
  patchWorkflowFixture,
  readWorkflowFixtures,
  type TaskFixtureSpec,
} from './helpers/model'
import {
  readTaskSubjectSqlFixtures,
  readTaskSubjectFacetFixtures,
} from './helpers/model/taskSubject'
import { createClarifyAnswerQueries } from '@/modules/collaboration/composition'
import { createWorkflow } from './helpers/model/resourceWrites'

const hosts = TASK_DEFINITION_HOSTS
const cases: readonly StoredTaskSubject[] = [
  { workflowId: 'authored' },
  { workflowId: hosts.agent.id, sourceAgentId: 'agent', sourceAgentName: 'writer' },
  { workflowId: hosts.workgroup.id, workgroupId: 'group' },
  { workflowId: hosts['digital-employee'].id },
  { workflowId: hosts['code-round'].id, codeRoundId: 'round' },
]
const definition: WorkflowDefinition = {
  $schema_version: WORKFLOW_SCHEMA_VERSION,
  inputs: [],
  nodes: [{ id: 'review', kind: 'review', title: 'Review' }],
  edges: [],
}
function fixture(row: StoredTaskSubject, id = ulid()): TaskFixtureSpec {
  return {
    id,
    name: id,
    ...row,
    workflowSnapshot: JSON.stringify(definition),
    workflowVersion: 7,
    repoPath: '/tmp/subject',
    worktreePath: '/tmp/subject',
    baseBranch: 'main',
    branch: id,
    status: 'awaiting_review',
    inputs: '{}',
    startedAt: 1,
  }
}
const actor = buildActor({
  user: {
    id: 'viewer',
    username: 'viewer',
    displayName: 'Viewer',
    role: 'admin',
    status: 'active',
  },
  source: 'session',
})
const activity = { awaitReleasedSettled: async () => {}, isActive: () => false }
const resourceAuthorityFor = () => {
  throw new Error('host subject must not load a workflow resource')
}

describeEachProvider('RFC-395 II-a A2 subject readers', (harness) => {
  test('context ancestors keep the subject of the listed source, including the all-sources composition', async () => {
    const db = harness.db
    await workflowFixture(db, {
      id: 'parent-workflow',
      name: 'Parent workflow',
      definition: JSON.stringify(definition),
    })
    await taskFixture(db, [
      {
        ...fixture({ workflowId: 'parent-workflow' }, 'parent'),
        name: 'Parent task',
        status: 'done',
      },
      {
        ...fixture({ workflowId: hosts.workgroup.id, workgroupId: 'group' }, 'group-child'),
        name: 'context-target-group',
        parentTaskId: 'parent',
        rootTaskId: 'parent',
        invocationDepth: 1,
      },
      {
        ...fixture(
          { workflowId: hosts.agent.id, sourceAgentId: 'agent', sourceAgentName: 'Agent' },
          'agent-child',
        ),
        name: 'context-target-agent',
        parentTaskId: 'parent',
        rootTaskId: 'parent',
        invocationDepth: 1,
      },
    ])
    const factory = createTaskExecutionCatalogSourceFactory(
      createDatabaseTaskListPage(db, composeOwnerIdentityQueries(db)),
    )
    const pages = await Promise.all(
      (['workflow', 'workgroup', 'agent'] as const).map((sourceId) =>
        factory.create(sourceId).list({ viewer: actor, q: 'context-target' }),
      ),
    )
    for (const sourceId of ['workgroup', 'agent'] as const) {
      const parent = pages
        .flatMap((page) => page.items)
        .find((item) => item.id === 'parent' && item.sourceId === sourceId)
      expect(parent).toBeDefined()
      expect(parent!.subject).toEqual({ resourceId: null, label: { 'zh-CN': '—', 'en-US': '—' } })
    }
    const workflowPage = await factory.create('workflow').list({ viewer: actor, q: 'Parent task' })
    expect(workflowPage.items.find((item) => item.id === 'parent')?.subject).toEqual({
      resourceId: 'parent-workflow',
      label: { 'zh-CN': 'Parent workflow', 'en-US': 'Parent workflow' },
    })
  })

  for (const host of Object.values(hosts)) {
    // RFC-401 T6 (proposal G5): the YAML import writer (the only caller of the reserved-name check per
    // import mode) is deleted; no production route imports a workflow through it.
    test(`reserved ${host.id} rejects create and the common copy-target insert`, async () => {
      const db = harness.db
      // The reserved id is the subject here; a reserved display name would fail the create schema first.
      await expect(
        createWorkflow(
          db,
          { name: 'reserved-host-probe', description: '', definition },
          { id: host.id },
        ),
      ).rejects.toMatchObject({ status: 403, code: 'builtin-readonly' })
      await expect(
        harness.session.transaction((tx) =>
          createWorkflowMutationParticipant(tx).create(
            { kind: 'system', userId: 'fixture-owner', reason: 'rfc395-reserved-host' },
            {
              id: host.id,
              content: { name: host.name, description: '', definition },
              provenance: 'verbatim-copy',
            },
          ),
        ),
      ).rejects.toMatchObject({ status: 403, code: 'builtin-readonly' })
      expect(await readWorkflowFixtures(db, { id: host.id })).toEqual([])
    })
  }

  test('residual catalog hosts are ignored by lookup, lists and YAML export without deleting physical rows', async () => {
    const db = harness.db
    await workflowFixture(db, {
      id: 'authored',
      name: 'Authored',
      definition: JSON.stringify(definition),
    })
    for (const host of Object.values(hosts)) {
      await workflowFixture(db, {
        id: host.id,
        name: host.name,
        builtin: true,
        definition: 'unreadable old host bytes',
      })
      expect(await getWorkflow(db, host.id)).toBeNull()
    }
    const hostIds = Object.values(hosts).map((host) => host.id)
    const hostNames = Object.values(hosts).map((host) => host.name)
    for (const id of hostIds) expect(await getAclResourceAccessRow(db, 'workflow', id)).toBeNull()
    expect(await loadAclResourceNamesByIds(db, 'workflow', ['authored', ...hostIds])).toEqual(
      new Map([['authored', 'Authored']]),
    )
    expect(await listAclResourceIdentityRowsByNames(db, 'workflow', hostNames)).toEqual([])
    const packages = createResourcePackageReadPort(db)
    expect(await packages.listByIds('workflow', hostIds)).toEqual([])
    expect(await packages.listByNames('workflow', hostNames)).toEqual([])
    const counts = createResourceCatalogOverviewCountPort(db)
    expect(await counts.countVisible(actor, 'workflow', { excludeBuiltin: false })).toBe(1)
    expect(
      await counts.countVisibleMany(actor, [{ kind: 'workflow', excludeBuiltin: false }]),
    ).toEqual(new Map([['workflow', 1]]))
    expect((await listWorkflows(db)).map((row) => row.id)).toEqual(['authored'])
    const directory = mkdtempSync(join(tmpdir(), 'rfc395-subject-export-'))
    try {
      expect(await createPortableBackupApplicationAssets({ db }).exportWorkflows(directory)).toBe(1)
      expect(readdirSync(directory)).toEqual(['authored.yaml'])
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
    expect(await readWorkflowFixtures(db)).toHaveLength(5)
  })

  test('five kinds project names, frozen versions and layout consistently across detail, summary and WS', async () => {
    const db = harness.db
    await workflowFixture(db, {
      id: 'authored',
      name: 'Live name',
      definition: JSON.stringify(definition),
      version: 99,
    })
    const rows = cases.map((row) => fixture(row))
    await taskFixture(db, rows)
    const queries = createTaskSubjectQueries(db)
    const subjects = await queries.taskSubjectProjection(rows.map((row) => row.id!))
    const summaries = await taskListSummariesProjection(db, {})
    for (const row of rows) {
      const subject = legacySubjectOracle(row as StoredTaskSubject)
      const expected = {
        workflowId: definitionAnchorId(subject),
        workflowName: subject.kind === 'workflow' ? 'Live name' : hosts[subject.kind].name,
      }
      expect(subjects.get(row.id!)).toEqual(expected)
      for (const detail of [await getTask(db, row.id!), await loadTaskProjection(db, row.id!)]) {
        expect(detail).toMatchObject({
          ...expected,
          workflowVersion: 7,
        })
        expect(detail?.workflowSnapshot).toEqual(
          subject.kind === 'workflow' ? definition : layoutBuiltinWorkflowSnapshot(definition),
        )
      }
      expect(summaries.find((summary) => summary.id === row.id)).toMatchObject(expected)
      expect(
        await createDatabaseTaskLifecycleWsProjection(db).findCreatedTask(row.id!),
      ).toMatchObject(expected)
    }
    await patchWorkflowFixture(db, { id: 'authored' }, { name: 'Renamed live' })
    expect(
      (await queries.taskSubjectProjection([rows[0]!.id!])).get(rows[0]!.id!)?.workflowName,
    ).toBe('Renamed live')
    expect((await readWorkflowFixtures(db)).map((row) => row.id)).toEqual(['authored'])
  })

  test('SQL discriminator agrees with the domain and shared helper for five kinds and mismatched host claims', async () => {
    const inputs = [
      ...cases,
      ...Object.values(hosts).flatMap((host) => [
        { workflowId: host.id, sourceAgentName: '', workgroupId: '', codeRoundId: '' },
        {
          workflowId: host.id,
          sourceAgentName: 'writer',
          workgroupId: 'group',
          codeRoundId: 'round',
        },
        { workflowId: host.id, sourceAgentName: 'writer', workgroupId: 'group' },
        { workflowId: host.id, sourceAgentName: 'writer' },
      ]),
    ]
    const rows = inputs.map((row) => fixture(row))
    await taskFixture(harness.db, rows)
    const sqlKinds = new Map(
      (await readTaskSubjectSqlFixtures(harness.db)).map((row) => [row.id, row.kind]),
    )
    for (const row of rows) {
      const stored = row as StoredTaskSubject
      expect(sqlKinds.get(row.id!)).toBe(legacySubjectOracle(stored).kind)
      expect(taskExecutionKind(stored)).toBe(legacySubjectOracle(stored).kind)
    }
    for (const facet of ['workflow', 'agent', 'workgroup'] as const) {
      const expected = rows
        .filter((row) => {
          const kind = legacySubjectOracle(row as StoredTaskSubject).kind
          return (
            (kind === 'digital-employee' || kind === 'code-round' ? 'workflow' : kind) === facet
          )
        })
        .map((row) => row.id!)
        .sort()
      expect(
        (await readTaskSubjectFacetFixtures(harness.db, facet)).map((row) => row.id).sort(),
      ).toEqual(expected)
    }
  })

  test('review list, badges and detail include every host and retain deleted authored workflow disappearance', async () => {
    const db = harness.db
    await workflowFixture(db, {
      id: 'authored',
      name: 'Live name',
      definition: JSON.stringify(definition),
    })
    const rows = [...cases, { workflowId: 'deleted-authored' }].map((row) => fixture(row))
    const { docVersions } = tablesOf(db)
    await taskFixture(db, rows)
    for (const row of rows) {
      const runId = `${row.id}-review`
      await nodeRunFixture(db, {
        id: runId,
        taskId: row.id!,
        nodeId: 'review',
        status: 'awaiting_review',
      })
      await insertOne(db, docVersions, {
        id: ulid(),
        taskId: row.id!,
        reviewNodeId: 'review',
        reviewNodeRunId: runId,
        sourceNodeId: 'source',
        sourcePortName: 'doc',
        versionIndex: 1,
        reviewIteration: 0,
        ...contentRowColumns(legacyContentRef('review-body-path', 'local-file', 'missing.md')),
        decision: 'pending',
      })
    }
    const listed = await listReviewSummaries(db, taskExecutionParticipants, { status: 'pending' })
    expect(listed).toHaveLength(5)
    expect(await countPendingReviews(db)).toBe(5)
    for (const row of rows.slice(0, 5)) {
      const detail = await getReviewDetail(
        db,
        taskExecutionParticipants,
        '/tmp/subject-missing-artifacts',
        `${row.id}-review`,
      )
      expect(detail.summary).toEqual(listed.find((review) => review.taskId === row.id)!)
    }
    await expect(
      getReviewDetail(
        db,
        taskExecutionParticipants,
        '/tmp/subject-missing-artifacts',
        `${rows[5]!.id}-review`,
      ),
    ).rejects.toMatchObject({ code: 'review-not-found' })
    expect((await readWorkflowFixtures(db)).map((row) => row.id)).toEqual(['authored'])
  })

  test('manual and sync guards keep host-specific errors without loading a workflow row', async () => {
    const db = harness.db
    for (const row of cases.slice(1)) {
      const task = fixture(row)
      await taskFixture(db, task)
      const kind = legacySubjectOracle(row).kind
      // RFC-466: the sync gate and preview take workflow visibility from the production seam.
      const seam = composeAgentLaunchResourceOperations({ db })
      const canViewWorkflow = seam.canViewWorkflow
      // RFC-470: the host-specific guards answer before the workflow row is read (this test's title), so reading it
      // fails the case; the preview's validation is the production seam's.
      const readWorkflow = async (): Promise<never> => {
        throw new Error('host-specific guards must not load a workflow row')
      }
      const validateHostWorkflow = seam.validateHostWorkflow
      const dependencies = {
        db,
        activity,
        resourceAuthorityFor,
        canViewWorkflow,
        readWorkflow,
        validateHostWorkflow,
      }
      if (kind === 'agent' || kind === 'code-round')
        await assertManualExecutionAllowedProjection(dependencies, actor, task.id!)
      else
        await expect(
          assertManualExecutionAllowedProjection(dependencies, actor, task.id!),
        ).rejects.toMatchObject({ code: 'builtin-readonly', status: 403 })
      await expect(assertTaskWorkflowSyncable(dependencies, actor, task.id!)).rejects.toMatchObject(
        { code: kind === 'digital-employee' ? 'builtin-readonly' : 'task-host-sync-unsupported' },
      )
      expect(await taskWorkflowSyncPreviewProjection(dependencies, actor, task.id!)).toMatchObject({
        syncable: false,
        reason: kind === 'digital-employee' ? 'builtin-workflow' : 'workflow-deleted',
      })
    }
    const dynamic = fixture({ workflowId: hosts.workgroup.id, workgroupId: 'dynamic' })
    await taskFixture(db, {
      ...dynamic,
      workgroupConfigJson: JSON.stringify({ mode: 'dynamic_workflow' }),
    })
    await assertManualExecutionAllowedProjection({ db, resourceAuthorityFor }, actor, dynamic.id!)
    expect(await readWorkflowFixtures(db)).toEqual([])
  })

  test('host scopes stay public and inject the same persisted workflow memory namespace', async () => {
    const db = harness.db
    const { memories } = tablesOf(db)
    const primaryAgent = AgentSchema.parse({
      id: 'agent',
      name: 'writer',
      description: '',
      bodyMd: '',
      outputs: [],
      skills: [],
      mcp: [],
      plugins: [],
      dependsOn: [],
      permission: {},
      frontmatterExtra: {},
      schemaVersion: 1,
      syncOutputsOnIterate: true,
      createdAt: 1,
      updatedAt: 1,
    })
    for (const row of cases.slice(1)) {
      const task = fixture(row)
      await taskFixture(db, task)
      const scopeId = definitionAnchorId(legacySubjectOracle(row))
      await insertOne(db, memories, {
        id: ulid(),
        scopeType: 'workflow',
        scopeId,
        title: 'Existing host memory',
        bodyMd: `remember ${scopeId}`,
        status: 'approved',
        sourceKind: 'manual',
        createdAt: 1,
      })
      expect(
        await harness.session.transaction((tx) =>
          resourceScopeAccessReads.scopeRow(tx, { kind: 'workflow', id: scopeId }),
        ),
      ).toEqual({ ownerUserId: null, visibility: 'public' })
      const store = new DrizzleMemoryInjectionReadStore(db, createNodeRunQueries(db))
      expect(await store.findTaskContext(task.id!)).toMatchObject({ workflowId: scopeId })
      expect(
        await new DrizzleMemoryDistillWorkStore(
          db,
          createClarifyAnswerQueries(db, taskExecutionParticipants),
          createNodeRunQueries(db),
          createNodeOutputQueries(db),
        ).findTaskScope(task.id!),
      ).toMatchObject({
        workflowId: scopeId,
      })
      const injected = await injectMemoryForRun({
        store,
        taskId: task.id!,
        primaryAgent,
        dependents: [],
      })
      expect(injected.block).toContain(`remember ${scopeId}`)
      expect(injected.snapshot).toMatchObject([{ scopeType: 'workflow', scopeId }])
    }
    expect(await readWorkflowFixtures(db)).toEqual([])
  })
})

// Frozen fixture oracle retains the epoch-1 precedence; runtime reads the native
// definition subject and never imports this legacy projection.
interface StoredTaskSubject {
  readonly workflowId: string
  readonly codeRoundId?: string | null
  readonly workgroupId?: string | null
  readonly sourceAgentId?: string | null
  readonly sourceAgentName?: string | null
}
function legacySubjectOracle(row: StoredTaskSubject): TaskSubject {
  if (row.codeRoundId) return { kind: 'code-round', sourceId: row.codeRoundId }
  if (row.workgroupId) return { kind: 'workgroup', sourceId: row.workgroupId }
  if (row.sourceAgentName)
    return { kind: 'agent', sourceId: row.sourceAgentId ?? null, sourceName: row.sourceAgentName }
  if (row.workflowId === hosts['digital-employee'].id)
    return { kind: 'digital-employee', sourceId: null }
  return { kind: 'workflow', sourceId: row.workflowId }
}
