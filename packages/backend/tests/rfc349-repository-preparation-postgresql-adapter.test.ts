import { withSourceControlTaskPorts } from './helpers/sourceControlTaskPorts'
import { describeEachProvider } from './helpers/eachProvider'
import { composeRepositoryPreparation } from '@/modules/source-control/composition/repositoryPreparation'
import { afterEach, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import type { TaskDriveSubmission } from '@/modules/task-execution/application/drive/taskDriveTypes'
import { createRepositoryPreparationRetryCommand } from '@/modules/task-execution/infrastructure/repositoryPreparationRetryCommand'
import { createTaskWorkspaceMaterializer } from '@/modules/task-execution/infrastructure/taskRouteWorkspaceParticipant'
import { registerAfterCommitEventPump } from '@/platform/events/committed/runtime'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { workflowFixture, taskFixture, nodeRunFixture, readTaskFixtures } from './helpers/model'
import { eq } from 'drizzle-orm'

afterEach(() => {
  registerAfterCommitEventPump(null)
})

describeEachProvider('RFC-349 repository preparation retry', (harness) => {
  test('commits pending status and continuation before background drive; preparation belongs to that drive', async () => {
    const trace: string[] = []
    const db = harness.db
    await workflowFixture(db, { id: 'workflow-1', name: 'workflow-1', definition: '{}' })
    await taskFixture(db, {
      id: 'task-1',
      name: 'Retry repository',
      workflowId: 'workflow-1',
      workflowSnapshot: '{}',
      repoPath: '',
      worktreePath: '',
      baseBranch: 'main',
      branch: 'main',
      cachedRepoId: 'cached-1',
      status: 'failed',
      inputs: { prompt: 'repair it' },
      startedAt: 1,
      finishedAt: 10,
      errorSummary: 'old failure',
      errorMessage: 'old detail',
      failedNodeId: '__repo_prep__',
      gitUserName: 'Owner',
      gitUserEmail: 'owner@example.test',
      spaceKind: 'remote',
      lifecycleEventRevision: 1,
    })
    await nodeRunFixture(db, {
      id: 'prep-0',
      taskId: 'task-1',
      nodeId: '__repo_prep__',
      status: 'failed',
      retryIndex: 0,
    })
    const recording = harness.recordStatements()
    const submissions: TaskDriveSubmission[] = []
    registerAfterCommitEventPump({
      async publishNow() {
        expect(recording.statements.some((entry) => /^commit\b/i.test(entry.sql.trim()))).toBe(true)
        expect((await readTaskFixtures(db, { id: 'task-1' }))[0]?.status).toBe('pending')
        trace.push('event:publish')
      },
      nudge() {},
    })
    const ids = ['operation-1', 'intent-1', 'prep-1']
    const command = createRepositoryPreparationRetryCommand({
      db,
      coordinator: {
        async submit(input) {
          expect(trace).toContain('event:publish')
          const intents = await db
            .select()
            .from(tablesOf(db).taskExecutionIntents)
            .where(eq(tablesOf(db).taskExecutionIntents.id, input.intentId!))
          expect(intents).toHaveLength(1)
          trace.push('coordinator')
          submissions.push(input)
          return { kind: 'accepted', taskId: input.taskId }
        },
      },
      isTaskActive: () => false,
      awaitTaskSettled: async () => {},
      id() {
        const id = ids.shift()
        if (id === undefined) throw new Error('fixture id sequence exhausted')
        return id
      },
      now: () => 1_700_000_000_000,
    })

    try {
      await command.retry('task-1')
    } finally {
      recording.stop()
    }

    expect(submissions).toEqual([
      { taskId: 'task-1', intentId: 'intent-1', completionMode: 'background' },
    ])
    expect(trace.indexOf('event:publish')).toBeLessThan(trace.indexOf('coordinator'))
    expect(
      recording.statements.filter((entry) =>
        /insert into [^;]*(?:node_runs|task_repository_mounts)/i.test(entry.sql),
      ),
    ).toEqual([])
    expect((await db.select().from(tablesOf(db).nodeRuns)).map((row) => row.id)).toEqual(['prep-0'])
    expect(await db.select().from(tablesOf(db).taskRepositoryMounts)).toEqual([])
  })

  test('composition exposes production workspace and retry factories without SQLite escape hatches', () => {
    const backend = resolve(import.meta.dir, '..', 'src')
    const workspace = readFileSync(
      resolve(backend, 'modules/task-execution/infrastructure/taskRouteWorkspaceParticipant.ts'),
      'utf8',
    )
    const retry = readFileSync(
      resolve(
        backend,
        'modules/task-execution/infrastructure/repositoryPreparationRetryCommand.ts',
      ),
      'utf8',
    )
    const provider = readFileSync(
      resolve(backend, 'modules/task-execution/composition/providerRuntime.ts'),
      'utf8',
    )
    expect(workspace).toContain('createTaskWorkspaceMaterializer')
    expect(workspace).toContain('dependencies.repositoryPreparation.legacy.prepare')
    expect(workspace).not.toContain("from '@/modules/source-control/composition'")
    expect(retry).not.toContain('dependencies.workspace')
    expect(retry).toContain("completionMode: 'background'")
    expect(retry).toContain('createRepositoryPreparationRetryCommand')
    expect(retry).toContain('submitTaskContinuation')
    expect(retry).toContain('await publishCommittedEventsAfterCommit')
    expect(provider).toContain('createTaskRouteWorkspaceParticipant(workspaceDependencies)')
    expect(provider).toContain('createRepositoryPreparationRetryCommand({')
    expect(`${workspace}\n${retry}`).not.toContain("from '@/db/client'")
    expect(`${workspace}\n${retry}`).not.toContain('createSqlite')
    expect(`${workspace}\n${retry}`).not.toContain('as DbClient')
  })
})

describeEachProvider('RFC-363 real-provider scratch rollback lease', (harness) => {
  test('production workspace materializer returns a real rollback lease', async () => {
    const appHome = await mkdtemp(join(tmpdir(), 'rfc349-workspace-pg-'))
    try {
      const materializer = createTaskWorkspaceMaterializer({
        sourceContexts: () => {
          throw new Error('legacy materializer must not seal a request source')
        },
        repositoryPreparation: composeRepositoryPreparation(
          withSourceControlTaskPorts({ db: harness.db, appHome: appHome }),
        ),
        db: harness.db,
        appHome,
      })
      const prepared = await materializer.prepare({
        taskId: 'task-scratch',
        task: {
          name: 'Scratch workspace',
          inputs: {},
          scratch: true,
        },
        gitCommitIdentity: { name: 'Owner', email: 'owner@example.test' },
      })

      expect(prepared.kind).toBe('scratch')
      expect(prepared.earlyError).toBeNull()
      expect(prepared.repositories).toHaveLength(1)
      expect(existsSync(prepared.worktreePath)).toBe(true)
      const report = await prepared.rollback()
      expect(report.complete).toBe(true)
      expect(existsSync(prepared.worktreePath)).toBe(false)
    } finally {
      await rm(appHome, { recursive: true, force: true })
    }
  })
})
