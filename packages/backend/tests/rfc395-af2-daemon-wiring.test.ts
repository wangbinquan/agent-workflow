// AF-D15/D16/D17: regressions must traverse composeDaemonApplication, not isolated consumers.
import { expect, test } from 'bun:test'
import { eq, sql } from 'drizzle-orm'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { ulid } from 'ulid'
import { buildActor } from '@/auth/actor'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { engineOf } from '@/platform/persistence/databaseTransaction'
import { rawRows } from '@/platform/persistence/queryHelpers'
import { metaTableName } from '@/platform/persistence/schema/history/meta'
import { compileContract } from '@/platform/persistence/schema/contract'
import { digestSchemaContract } from '@/platform/persistence/schema/canonical'
import { frozenEpoch1Registry } from '@/platform/persistence/migration/epoch1/definitions'
import { contentRowColumns } from '@/platform/content/infrastructure/contentStore'
import { legacyContentRef } from '@/platform/content/contentRef'
import { readCommittedReviewArtifactBody } from '@/modules/collaboration/public/queries'
import {
  dispatchReviewNode,
  rowToDocVersion,
  readDocVersionBody,
} from '@/modules/collaboration/infrastructure/review'
import { createLocalRuntimeContent } from '@/bootstrap/contentRuntime'
import { createLocalReviewArtifacts } from '@/modules/collaboration/composition/contentArtifacts'
import type { SchedulerDriverPort } from '@/modules/task-execution/public/commands'
import { DEFAULT_CONFIG, type WorkflowDefinition, type WorkflowNode } from '@agent-workflow/shared'
import { describeEachProvider } from './helpers/eachProvider'
import { createProviderHttpApplication } from './helpers/providerHttpApplication'
import {
  nodeRunFixture,
  nodeRunOutputFixture,
  patchTaskFixture,
  readTaskFixtures,
  taskFixture,
  workflowFixture,
} from './helpers/model'
import { seedNodeRunDisplayEvidence } from './helpers/rfc395Q1Evidence'
import { withO2Closure } from './helpers/o2Closure'

const actor = buildActor({
  user: {
    id: 'af2-admin',
    username: 'af2-admin',
    displayName: 'AF2',
    role: 'admin',
    status: 'active',
  },
  source: 'session',
})
const definition = {
  $schema_version: 5,
  inputs: [],
  nodes: [{ id: 'worker', kind: 'agent-single', agentName: 'writer', promptTemplate: '' }],
  edges: [],
}

describeEachProvider('RFC-395 AF-2 composed daemon wiring', (h) => {
  const meta = (name: string) => sql.raw(metaTableName(engineOf(h.db).provider, name))
  async function convertedInstallation() {
    const [active] = await rawRows<{ generation_id: string }>(
      h.db,
      sql`SELECT generation_id FROM ${meta('generations')} WHERE state = 'active'`,
    )
    const sourceContract = compileContract(frozenEpoch1Registry)
    const binding = { sourceGenerationId: 'af2-source', sourceContract }
    const run = {
      run_id: 'af2-conversion',
      operation_id: 'af2-operation',
      ordinal: 0,
      state: 'activated',
      kind: 'epoch-conversion',
      role: 'converted',
      source_provider: 'sqlite',
      source_epoch: 1,
      source_kind: 'sqlite-file',
      source_version: 'epoch-1-head',
      source_fingerprint: 'fixture',
      source_generation_id: 'af2-source',
      source_watermark: 'fixture',
      target_provider: engineOf(h.db).provider,
      target_epoch: 2,
      target_generation_id: active!.generation_id,
      migration_plan_digest: 'fixture',
      approval_digest: 'fixture',
      conversion_plan_json: '{}',
      conversion_plan_digest: 'fixture',
      converter_version: '1',
      rule_set_digest: 'fixture',
      candidate_build: 'af2',
      content_manifest_digest: 'fixture',
      plan_time: 1,
      chunk_limit: 100,
      binding_json: JSON.stringify(binding),
      binding_digest: digestSchemaContract(binding),
      started_at: 1,
    }
    await rawRows(
      h.db,
      sql`INSERT INTO ${meta('migration_runs')} (${sql.join(
        Object.keys(run).map((name) => sql.raw('"' + name + '"')),
        sql`, `,
      )}) VALUES (${sql.join(
        Object.values(run).map((value) => sql`${value}`),
        sql`, `,
      )})`,
    )
    await rawRows(
      h.db,
      sql`UPDATE ${meta('generations')} SET role = 'converted', run_id = 'af2-conversion', source_generation_id = 'af2-source' WHERE state = 'active'`,
    )
  }
  async function seedTask(
    home: string,
    status: 'interrupted' | 'failed' = 'interrupted',
    workflow: unknown = definition,
  ) {
    await h.db
      .insert(tablesOf(h.db).users)
      .values({
        id: actor.user.id,
        username: actor.user.id,
        displayName: actor.user.id,
        createdAt: 1,
        updatedAt: 1,
      })
      .onConflictDoNothing()
    const taskId = ulid(),
      runId = ulid()
    await workflowFixture(h.db, {
      id: taskId,
      name: taskId,
      definition: JSON.stringify(workflow),
      visibility: 'public',
    })
    await taskFixture(h.db, {
      id: taskId,
      name: taskId,
      workflowId: taskId,
      workflowSnapshot: JSON.stringify(workflow),
      workflowVersion: 1,
      repoPath: home,
      worktreePath: home,
      baseBranch: 'main',
      branch: taskId,
      spaceKind: 'internal',
      status,
      inputs: '{}',
      startedAt: Date.now() - 60000,
      finishedAt: Date.now(),
      errorSummary: 'daemon-restart',
      ownerUserId: actor.user.id,
      executionLineageId: taskId,
      lineageSlotPathJson: JSON.stringify([
        { stableNodeKey: 'task-root', frozenOccurrenceKey: taskId, workflowRevision: 1 },
      ]),
    })
    return { taskId, runId }
  }
  async function restrict(taskId: string, runId: string) {
    await nodeRunFixture(h.db, { id: runId, taskId, nodeId: 'worker', status: 'failed' })
    // Converted history cannot remain an executable slot selection.
    await h.db
      .update(tablesOf(h.db).nodeRunSelections)
      .set({ selectedRunId: null })
      .where(eq(tablesOf(h.db).nodeRunSelections.selectedRunId, runId))
    await h.db
      .update(tablesOf(h.db).nodeRuns)
      .set({
        recordMode: 'history-only',
        provenanceQuality: 'unknown',
        role: null,
        slotKey: null,
        attemptIndex: null,
        scopePath: null,
      })
      .where(eq(tablesOf(h.db).nodeRuns.id, runId))
    await seedNodeRunDisplayEvidence(h.db, taskId, runId)
    await rawRows(
      h.db,
      sql`INSERT INTO ${meta('migration_history_restrictions')} (task_id, source_table, source_phase, source_key, run_id, ordinal, node_run_id, execution, execution_use, reason, missing_fields_json, decision_code, unit_id) VALUES (${taskId}, 'node_runs', 'current', ${'mk1:' + runId}, 'af2-conversion', 0, ${runId}, 'retryable-history', NULL, NULL, '["role"]', 'history-only', 'af2-unit')`,
    )
  }
  function scheduler() {
    const requests: string[] = []
    const delivered = Promise.withResolvers<void>()
    const driver: SchedulerDriverPort = {
      async drive(request) {
        requests.push(request.taskId)
        delivered.resolve()
      },
      async cancelChild() {},
      async resumeChild() {},
      isTaskActive: () => false,
    }
    return { requests, delivered: delivered.promise, driver }
  }
  for (const action of ['resume', 'retry'] as const) {
    test(`${action}: converted history is refused through the default active-generation provider before mutation`, async () => {
      await convertedInstallation()
      const s = scheduler()
      const app = await createProviderHttpApplication(h, {
        token: 'af2',
        dbVersion: 1,
        schedulerDriver: s.driver,
      })
      try {
        const { taskId, runId } = await seedTask(app.appHome, 'failed')
        await restrict(taskId, runId)
        const before = await readTaskFixtures(h.db, { id: taskId })
        const call =
          action === 'resume'
            ? app.runtime.taskExecution.routes.tasks.resume({ actor, taskId })
            : app.runtime.taskExecution.routes.tasks.retry({
                actor,
                taskId,
                nodeRunId: runId,
                cascade: false,
              })
        await expect(call).rejects.toMatchObject({ code: 'history-only' })
        expect(await readTaskFixtures(h.db, { id: taskId })).toEqual(before)
        expect(
          await h.db
            .select({ id: tablesOf(h.db).nodeRuns.id })
            .from(tablesOf(h.db).nodeRuns)
            .where(eq(tablesOf(h.db).nodeRuns.taskId, taskId)),
        ).toEqual([{ id: runId }])
        expect(s.requests).toEqual([])
      } finally {
        await app.dispose()
      }
    }, 30000)
    test(`${action}: a fresh task reaches the scheduler through the composed daemon`, async () => {
      const s = scheduler()
      const app = await createProviderHttpApplication(h, {
        token: 'af2',
        dbVersion: 1,
        schedulerDriver: s.driver,
      })
      try {
        const { taskId, runId } = await seedTask(
          app.appHome,
          action === 'resume' ? 'interrupted' : 'failed',
        )
        if (action === 'retry')
          await nodeRunFixture(h.db, { id: runId, taskId, nodeId: 'worker', status: 'failed' })
        if (action === 'resume')
          await app.runtime.taskExecution.routes.tasks.resume({ actor, taskId })
        else
          await app.runtime.taskExecution.routes.tasks.retry({
            actor,
            taskId,
            nodeRunId: runId,
            cascade: false,
          })
        await s.delivered
        await app.runtime.taskExecution.executionModule.runtimeRegistry.awaitReleasedSettled(taskId)
        expect(s.requests).toEqual([taskId])
        expect((await readTaskFixtures(h.db, { id: taskId }))[0]?.status).toBe('pending')
        if (action === 'retry') {
          const { nodeRuns } = tablesOf(h.db)
          const attempts = await h.db
            .select({ attemptIndex: nodeRuns.attemptIndex })
            .from(nodeRuns)
            .where(eq(nodeRuns.taskId, taskId))
          expect(attempts.map((row) => row.attemptIndex).sort()).toEqual([0, 1])
        }
      } finally {
        await app.dispose()
      }
    }, 30000)
  }
  test('hosted-targeted-resume drives only the fresh recovered task and retains restricted history', async () => {
    await convertedInstallation()
    const s = scheduler(),
      recovered: string[] = []
    const app = await createProviderHttpApplication(h, {
      token: 'af2',
      dbVersion: 1,
      schedulerDriver: s.driver,
      recoveredExecutionTaskIds: () => recovered,
    })
    try {
      const old = await seedTask(app.appHome),
        fresh = await seedTask(app.appHome),
        untouched = await seedTask(app.appHome)
      await restrict(old.taskId, old.runId)
      recovered.push(old.taskId, fresh.taskId)
      const step = app.lifecycleSteps['hosted-targeted-resume']
      if (typeof step !== 'function') throw new Error('hosted-targeted-resume not composed')
      await step()
      await s.delivered
      await app.runtime.taskExecution.executionModule.runtimeRegistry.awaitReleasedSettled(
        fresh.taskId,
      )
      expect(s.requests).toEqual([fresh.taskId])
      expect((await readTaskFixtures(h.db, { id: old.taskId }))[0]?.status).toBe('interrupted')
      expect((await readTaskFixtures(h.db, { id: untouched.taskId }))[0]?.status).toBe(
        'interrupted',
      )
    } finally {
      await app.dispose()
    }
  }, 30000)
  test('runtime-registry seeds live configuration once and preserves edited/deleted existing rows on later boots', async () => {
    const paths = { opencodePath: '/opt/af2/opencode', claudeCodePath: '/opt/af2/claude' }
    let current = {
      ...DEFAULT_CONFIG,
      opencodePath: '/before/opencode',
      claudeCodePath: '/before/claude',
    }
    const app = await createProviderHttpApplication(h, {
      token: 'af2',
      dbVersion: 1,
      configuration: { read: async () => current },
    })
    current = { ...current, ...paths }
    try {
      const boot = app.lifecycleSteps['runtime-registry']
      if (typeof boot !== 'function') throw new Error('runtime-registry not composed')
      await boot()
      const { runtimes } = tablesOf(h.db)
      expect((await app.core.runtimeRegistry.getRuntime('opencode'))?.binaryPath).toBe(
        paths.opencodePath,
      )
      expect((await app.core.runtimeRegistry.getRuntime('claude-code'))?.binaryPath).toBe(
        paths.claudeCodePath,
      )
      await h.db.update(runtimes).set({ binaryPath: null }).where(eq(runtimes.name, 'opencode'))
      await h.db.delete(runtimes).where(eq(runtimes.name, 'claude-code'))
      current = { ...current, opencodePath: '/later/opencode', claudeCodePath: '/later/claude' }
      await boot()
      expect((await app.core.runtimeRegistry.getRuntime('opencode'))?.binaryPath).toBeNull()
      expect(await app.core.runtimeRegistry.getRuntime('claude-code')).toBeNull()
    } finally {
      await app.dispose()
    }
  }, 30000)
  test('converted pre-0212 review documents retain their file content through the composed reader', async () => {
    await convertedInstallation()
    const app = await createProviderHttpApplication(h, { token: 'af2', dbVersion: 1 })
    try {
      const { taskId, runId } = await seedTask(app.appHome)
      await nodeRunFixture(h.db, { id: runId, taskId, nodeId: 'review', status: 'awaiting_review' })
      const path = `runs/${taskId}/review/review/doc/v1.md`,
        body = '\ufeffOriginal review\r\n'
      await mkdir(dirname(join(app.appHome, path)), { recursive: true })
      await writeFile(join(app.appHome, path), body)
      const { docVersions, collaborationGateArtifacts } = tablesOf(h.db)
      await h.db.insert(docVersions).values({
        id: 'old-doc',
        taskId,
        reviewNodeId: 'review',
        reviewNodeRunId: runId,
        sourceNodeId: 'worker',
        sourcePortName: 'doc',
        versionIndex: 1,
        reviewIteration: 0,
        ...contentRowColumns(legacyContentRef('review-body', 'local-file', path)),
      })
      const [row] = await h.db.select().from(docVersions).where(eq(docVersions.id, 'old-doc'))
      const reader = {
        read: (reference: string) =>
          readCommittedReviewArtifactBody(app.collaborationContext, reference),
      }
      expect(await readDocVersionBody(h.db, app.appHome, rowToDocVersion(row!), reader)).toBe(body)
      expect(await reader.read('doc-content:old-doc')).toBe(body)
      expect(await h.db.select().from(collaborationGateArtifacts)).toEqual([])
    } finally {
      await app.dispose()
    }
  }, 30000)
  test('same-source awaiting-review repair creates a directly written document readable by the daemon', async () => {
    const app = await createProviderHttpApplication(h, { token: 'af2', dbVersion: 1 })
    try {
      const workflow: WorkflowDefinition = {
        $schema_version: 2,
        inputs: [],
        nodes: [
          {
            id: 'worker',
            kind: 'agent-single',
            agentName: 'writer',
            promptTemplate: '',
          } as WorkflowNode,
          { id: 'review', kind: 'review' } as WorkflowNode,
        ],
        edges: [
          {
            id: 'input',
            source: { nodeId: 'worker', portName: 'docpath' },
            target: { nodeId: 'review', portName: '__review_input__' },
          },
        ],
      }
      const { taskId, runId } = await seedTask(app.appHome, 'interrupted', workflow)
      await patchTaskFixture(h.db, { id: taskId }, { status: 'awaiting_review' })
      const sourceId = ulid()
      await nodeRunFixture(h.db, { id: sourceId, taskId, nodeId: 'worker', status: 'done' })
      await nodeRunOutputFixture(h.db, {
        nodeRunId: sourceId,
        portName: 'docpath',
        kind: 'markdown',
        content: '# repaired document',
      })
      await nodeRunFixture(h.db, {
        id: runId,
        taskId,
        nodeId: 'review',
        status: 'awaiting_review',
        consumedEdges: [{ producerNodeId: 'worker', producerRunId: sourceId }],
      })
      expect(
        (
          await dispatchReviewNode(
            withO2Closure({
              db: h.db,
              taskId,
              appHome: app.appHome,
              scopeRoot: app.appHome,
              definition: workflow,
              node: workflow.nodes[1]!,
              iteration: 0,
            }),
          )
        ).kind,
      ).toBe('awaiting_review')
      const { docVersions, collaborationGateArtifacts } = tablesOf(h.db)
      const [row] = await h.db
        .select()
        .from(docVersions)
        .where(eq(docVersions.reviewNodeRunId, runId))
      expect(row).toBeDefined()
      expect(JSON.parse(row!.contentRefJson!)).toMatchObject({
        location: { codec: 'review-body-path' },
      })
      expect(
        await readDocVersionBody(h.db, app.appHome, rowToDocVersion(row!), {
          read: (reference) => readCommittedReviewArtifactBody(app.collaborationContext, reference),
        }),
      ).toBe('# repaired document')
      expect(await h.db.select().from(collaborationGateArtifacts)).toEqual([])
    } finally {
      await app.dispose()
    }
  }, 30000)
  test('a profile-supplied review content port remains selected', async () => {
    const local = createLocalReviewArtifacts({
      db: h.db,
      content: createLocalRuntimeContent(h.db, '/unused-af2-home'),
      appHome: '/unused-af2-home',
    })
    const reads: string[] = []
    const app = await createProviderHttpApplication(h, {
      token: 'af2',
      dbVersion: 1,
      reviewArtifacts: {
        store: local.store,
        content: {
          async read(reference) {
            reads.push(reference)
            return { body: Buffer.from('profile review'), label: reference }
          },
        },
      },
    })
    try {
      expect(
        await readCommittedReviewArtifactBody(app.collaborationContext, 'profile-document'),
      ).toBe('profile review')
      expect(reads).toEqual(['profile-document'])
    } finally {
      await app.dispose()
    }
  }, 30000)
})
