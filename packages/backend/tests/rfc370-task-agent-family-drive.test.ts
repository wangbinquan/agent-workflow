// RFC-370: a replacement complete family must be consumed by the actual
// SQLite and PostgreSQL Task drive, including the original persisted failure.
import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ulid } from 'ulid'
import { WORKFLOW_SCHEMA_VERSION, type WorkflowDefinition } from '@agent-workflow/shared'
import { agents, nodeRuns, tasks, users, workflows } from '../src/db/schema'
import { createTaskExecutionContext } from '../src/modules/task-execution/application/taskExecutionContext'
import { createWorkerIdentity } from '../src/modules/task-execution/domain/ownership'
import { composeLocalTaskAgentRunFamilyFor } from '../src/modules/task-execution/composition/localTaskAgentRunFamily'
import type {
  TaskAgentRunFamily,
  TaskAgentRunScope,
} from '../src/modules/task-execution/application/ports/taskAgentRunFamily'
import type { TaskAgentRunPurpose } from '../src/modules/task-execution/application/ports/taskAgentMaterial'
import { describeEachProvider } from './helpers/eachProvider'
import { createEachProviderTaskExecution } from './helpers/eachProviderTaskExecution'
import { seedBuiltinRuntimes } from './helpers/runtimeRegistryApplication'
import { runtimeRegistryPersistence } from './helpers/runtimeRegistryPersistence'
import { MemoryIsolationFactory, MemoryIsolationStore } from './helpers/isolationWorkspace'

function unselected(): never {
  throw new Error('selected compile rejection must precede physical execution')
}

describeEachProvider('RFC-370 complete Task family in real provider drives', (harness) => {
  for (const protocol of ['opencode', 'claude-code'] as const) {
    test(`${protocol}: the real root binds and consumes the chosen family and persists its compile failure`, async () => {
      const db = harness.db,
        appHome = mkdtempSync(join(tmpdir(), 'aw-family-drive-'))
      const userId = ulid(),
        agentId = ulid(),
        workflowId = ulid(),
        taskId = ulid()
      const scopes: TaskAgentRunScope[] = []
      const isolation = new MemoryIsolationStore()
      const canonicalRef = `memory:canonical:${taskId}`
      let selections = 0,
        compiles = 0
      let execution: Awaited<ReturnType<typeof createEachProviderTaskExecution>> | undefined
      const reason = new Error('chosen complete family compilation failed')
      try {
        await db.insert(users).values({
          id: userId,
          username: userId,
          displayName: userId,
          role: 'admin',
          status: 'active',
          createdAt: 1,
          updatedAt: 1,
        })
        await db.insert(agents).values({
          id: agentId,
          name: 'family-' + agentId,
          outputs: '["summary"]',
          bodyMd: 'Use the selected family.',
          runtime: protocol,
        })
        await seedBuiltinRuntimes(runtimeRegistryPersistence(db))
        const definition: WorkflowDefinition = {
          $schema_version: WORKFLOW_SCHEMA_VERSION,
          inputs: [],
          nodes: [
            {
              id: 'worker',
              kind: 'agent-single',
              agentId,
              agentName: 'family-' + agentId,
            },
          ],
          edges: [],
        }
        await db
          .insert(workflows)
          .values({ id: workflowId, name: workflowId, definition: JSON.stringify(definition) })
        await db.insert(tasks).values({
          id: taskId,
          executionLineageId: taskId,
          lineageSlotPathJson: JSON.stringify([
            { stableNodeKey: 'task-root', frozenOccurrenceKey: taskId, workflowRevision: null },
          ]),
          name: taskId,
          ownerUserId: userId,
          workflowId,
          workflowSnapshot: JSON.stringify(definition),
          repoPath: `memory:repository:${taskId}`,
          worktreePath: canonicalRef,
          baseBranch: 'main',
          branch: 'agent-workflow/' + taskId,
          status: 'pending',
          startedAt: 1,
          inputs: '{}',
          autoCommitPush: false,
        })
        execution = await createEachProviderTaskExecution(
          harness,
          { appHome, defaultRuntime: protocol, defaultNodeRetries: 0 },
          userId,
          {
            workspacePresence: { exists: () => true },
            isolationWorkspaces: new MemoryIsolationFactory(isolation),
            taskAgentRunsFor(binding) {
              selections++
              const local = composeLocalTaskAgentRunFamilyFor(binding)
              const family: TaskAgentRunFamily = {
                runtimeBindings: local.runtimeBindings,
                materialReferences: local.materialReferences,
                open(scope) {
                  expect(this).toBe(family)
                  scopes.push(scope)
                  const workspace = {
                    workspace: {
                      owner: 'source-control' as const,
                      reference: 'chosen:working:' + taskId,
                      version: 1,
                    },
                    runContent: {
                      owner: 'runtime-management' as const,
                      reference: 'chosen:run:' + taskId,
                      version: 1,
                    },
                    retainedRef: 'chosen:retained:' + taskId,
                    prepare: unselected,
                    discard: unselected,
                  }
                  const purpose: TaskAgentRunPurpose = {
                    workspace,
                    nodeRunPrompts: binding.nodeRunPrompts,
                    portArtifacts: binding.portArtifacts,
                    outputWorkspaceRef: workspace.workspace.reference,
                    outputValidation: { resolve: unselected },
                    gitControlObservation: { capture: unselected },
                    selectMaterial(receivedProtocol, receivedWorkspace) {
                      expect(receivedProtocol).toBe(protocol)
                      expect(receivedWorkspace).toBe(workspace)
                      return {
                        prepareMounts() {
                          scope.taskMountRefs()
                        },
                        async compile(declaration) {
                          compiles++
                          expect(declaration.protocol).toBe(protocol)
                          throw reason
                        },
                      }
                    },
                    bindExecutionParticipants: unselected,
                  }
                  return purpose
                },
              }
              return family
            },
          },
        )
        const intentId = ulid(),
          now = Date.now()
        await execution.persistence.intents.submitContinuation({
          taskId,
          intentId,
          kind: 'launch',
          source: 'rest',
          actorUserId: userId,
          payload: { v: 1 },
          now,
          advanceOperationGeneration: false,
        })
        const token = await execution.persistence.ownership.claimPendingIntent({
          intentId,
          identity: createWorkerIdentity({ ownerId: ulid(), daemonGeneration: 'family-' + ulid() }),
          now,
          leaseMs: 30_000,
        })
        const executionContext = createTaskExecutionContext({
          intentId,
          token,
          persistence: execution.persistence,
        })
        await execution.provider.runtime.schedulerDriver.drive({
          taskId,
          appHome,
          executionContext,
          signal: new AbortController().signal,
        })
        expect(selections).toBe(1)
        expect(scopes).toHaveLength(1)
        expect(scopes[0]!.taskId).toBe(taskId)
        const creates = isolation.calls.filter((call) => call.method === 'create')
        expect(creates).toHaveLength(1)
        const createdKey = (creates[0]!.args[0] as { key: string }).key
        expect(scopes[0]!.workspaceRef).toBe('memory:workspace:' + createdKey)
        expect(creates[0]!.binding.taskId).toBe(taskId)
        expect(compiles).toBe(1)
        const rows = await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
        expect(rows).toHaveLength(1)
        expect(rows[0]).toMatchObject({
          id: scopes[0]!.nodeRunId,
          nodeId: 'worker',
          status: 'failed',
          runtime: protocol,
          errorMessage: `spawn ${protocol} failed: chosen complete family compilation failed`,
        })
        expect((await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]?.status).toBe(
          'failed',
        )
      } finally {
        await execution?.shutdown()
        rmSync(appHome, { recursive: true, force: true })
      }
    })
  }
})
