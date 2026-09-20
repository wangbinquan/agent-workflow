// RFC-349 — a node-launched child already owns an inherited workspace. This
// locks the PostgreSQL-native mint (task/repo/membership/intent/event in one
// SERIALIZABLE transaction) and the commit-before-drive boundary without
// routing the provider client through the legacy SQLite launcher.

import { afterEach, expect, test } from 'bun:test'
import { WorkflowDefinitionSchema, type StartTask } from '@agent-workflow/shared'

import { buildActor } from '@/auth/actor'
import { eq } from 'drizzle-orm'
import {
  nodeRuns,
  taskCollaborators,
  taskExecutionIntents,
  taskRepos,
  taskSpaceNodes,
  tasks,
  users,
  workflows,
  committedEvents,
} from '@/db/schema'
import { describeEachProvider } from './helpers/eachProvider'
import { createWorkspacePreparationJournal } from '@/modules/task-execution/infrastructure/workspacePreparationJournal'
import { agentLaunchResourceIntegrityParticipantBrand } from '@/modules/resource-catalog/domain/participantBrands'
import { createProviderTaskExecutionModule } from '@/modules/task-execution/composition'
import { createTaskExecutionPersistence } from '@/modules/task-execution/composition/taskExecutionPersistence'
import type { SchedulerDriverPort } from '@/modules/task-execution/application/ports/taskExecutionTopology'
import type { TaskExecutionTopologyLogger } from '@/modules/task-execution/application/ports/taskExecutionTopology'
import {
  createChildExecutionLaunchOperations,
  type ChildExecutionLaunchDependencies,
} from '@/modules/task-execution/composition/childExecutionLaunch'
import { createTaskDriverLifecyclePort } from '@/modules/task-execution/infrastructure/taskDriverLifecycle'
import { registerAfterCommitEventPump } from '@/platform/events/committed/runtime'
import type { MaterializedSpace } from '@/services/task'

const actor = buildActor({
  user: {
    id: 'owner-1',
    username: 'owner',
    displayName: 'Owner',
    role: 'user',
    status: 'active',
  },
  source: 'session',
})

const inheritedSpace: MaterializedSpace = {
  kind: 'single',
  spaceKind: 'inherited',
  taskId: 'child-task',
  worktreePath: '/workspace/child-task',
  branch: 'agent-workflow/parent-task',
  baseCommit: 'base-commit',
  earlyError: null,
  resolvedSources: [],
  nodePaths: ['src'],
  cleanup: {
    taskId: 'child-task',
    ownedRoot: null,
    worktrees: [],
    state: 'owned',
    report: null,
  },
  repos: [
    {
      repoIndex: 0,
      repoPath: '/repo',
      repoUrl: null,
      cachedRepoId: null,
      baseBranch: 'main',
      branch: 'agent-workflow/parent-task',
      baseCommit: 'base-commit',
      worktreePath: '/workspace/child-task',
      worktreeDirName: '',
      mountPath: '',
      subdir: '',
      readonly: false,
      workspaceProfileVersion: 1,
      workspaceProfileDigest: 'profile-v1',
      submoduleInitOk: true,
      submoduleInitError: null,
      hasSubmodules: false,
    },
  ],
}

const childTask: StartTask = {
  workflowId: 'child-workflow',
  name: 'Child task',
  inputs: { input: 'value' },
  autoCommitPush: false,
}

function logger(): TaskExecutionTopologyLogger {
  const log: TaskExecutionTopologyLogger = {
    debug() {},
    info() {},
    warn() {},
    error() {},
    child() {
      return log
    },
  }
  return log
}

afterEach(() => {
  registerAfterCommitEventPump(null)
})

describeEachProvider('RFC-349 child execution launch commit boundary', (harness) => {
  test('mints a source-less inherited child atomically before coordinator admission', async () => {
    const trace: string[] = []
    const fixture = { db: harness.db }
    inheritedSpace.cleanup.state = 'owned'
    const snapshot = JSON.stringify({ $schema_version: 2, inputs: [], nodes: [], edges: [] })
    await fixture.db
      .insert(users)
      .values({
        id: actor.user.id,
        username: 'owner',
        displayName: 'Owner',
        role: 'user',
        status: 'active',
        createdAt: 1,
        updatedAt: 1,
      })
    await fixture.db
      .insert(workflows)
      .values({ id: 'child-workflow', name: 'Child', definition: snapshot })
    await fixture.db.insert(tasks).values({
      id: 'parent-task',
      name: 'Parent',
      workflowId: 'child-workflow',
      workflowSnapshot: snapshot,
      workflowVersion: 1,
      repoPath: '/repo',
      worktreePath: '/workspace/parent',
      baseBranch: 'main',
      branch: 'parent',
      status: 'running',
      inputs: '{}',
      startedAt: 1,
      ownerUserId: actor.user.id,
      launchOrigin: 'manual',
      catalogVisibility: 'public',
      rootTaskId: 'parent-task',
      executionLineageId: 'lineage-1',
      invocationDepth: 0,
      lineageSlotPathJson: JSON.stringify([
        { stableNodeKey: 'task-root', frozenOccurrenceKey: 'parent-task', workflowRevision: 1 },
      ]),
      gitUserName: 'Owner',
      gitUserEmail: 'owner@example.test',
    })
    await fixture.db
      .insert(nodeRuns)
      .values({
        id: 'parent-run',
        taskId: 'parent-task',
        nodeId: 'call-node',
        status: 'running',
        retryIndex: 0,
        iteration: 0,
        startedAt: 1,
        childTaskId: 'child-task',
        continuationSlotKey: 'call:node-1',
        operationGeneration: 2,
      })
    let publishedTask: typeof tasks.$inferSelect | undefined
    registerAfterCommitEventPump({
      async publishNow() {
        trace.push('event:after-commit')
        publishedTask = (await fixture.db.select().from(tasks).where(eq(tasks.id, 'child-task')))[0]
        // Preserve the original terminal-winner scenario using the real row.
        await fixture.db.update(tasks).set({ status: 'done' }).where(eq(tasks.id, 'child-task'))
      },
      nudge() {},
    })
    const persistence = createTaskExecutionPersistence(fixture.db)
    const executionModule = createProviderTaskExecutionModule({
      daemonGeneration: 'daemon-child-test',
      persistence,
    })
    const schedulerCalls: string[] = []
    const schedulerDriver: SchedulerDriverPort = {
      async drive(input) {
        schedulerCalls.push(input.taskId)
      },
      async cancelChild() {},
      async resumeChild() {},
      isTaskActive() {
        return false
      },
    }
    const dependencies: ChildExecutionLaunchDependencies = {
      db: fixture.db,
      persistence,
      // RFC-359 AC-1（plan §5hn 批次二 ⑤）：铸造机改收**端口**——`executionModule` /
      // `log` / `finalizeWorkspace` 三格只用于拼这一个端口，现在由装配方拼好交进来。
      lifecycle: createTaskDriverLifecyclePort({
        db: fixture.db,
        module: executionModule,
        claim: (intentId) => executionModule.claimPersisted({ intentId }),
        persistence,
        log: logger(),
        async finalizeWorkspace() {
          trace.push('workspace:finalize')
        },
      }),
      workgroup: {
        async loadExistingAgentIds() {
          throw new Error('workgroup resources are not used by workflow launch')
        },
        async ensureHostWorkflow() {
          throw new Error('workgroup resources are not used by workflow launch')
        },
        integrity: {
          [agentLaunchResourceIntegrityParticipantBrand]:
            'agent-launch-resource-integrity-participant',
          async assertUsable() {
            throw new Error('workgroup resources are not used by workflow launch')
          },
        },
      },
      id: () => 'intent-child',
      now: () => 1_700_000_000_000,
    }
    const definition = WorkflowDefinitionSchema.parse({
      $schema_version: 2,
      // RFC-359 W8-A：子启动现在也按**冻结定义**校验输入（`assertWorkflowLaunchInputs`），
      // 与 legacy 引擎同一道门、同一个 `workflow-inputs-invalid`。`childTask.inputs` 带了
      // `input`，冻结定义就必须声明它——此前这里写 `inputs: []`，靠的是 PG 侧根本不看
      // inputs 才没红（同一份 payload 在 SQLite 上一直是 `unknown-input` 拒启动）。
      inputs: [{ kind: 'text', key: 'input', label: 'Input' }],
      nodes: [],
      edges: [],
    })

    await createChildExecutionLaunchOperations(dependencies).launchWorkflow({
      actor,
      parentTaskId: 'parent-task',
      parentNodeRunId: 'parent-run',
      invocationDepth: 1,
      materializedSpace: inheritedSpace,
      runtime: { runConfig: { appHome: '/app-home' }, actorUserId: actor.user.id },
      schedulerDriver,
      workflowId: 'child-workflow',
      frozenWorkflowVersion: 7,
      payload: childTask,
      frozenSnapshotJson: JSON.stringify(definition),
      refClosureJson: null,
    })

    expect(inheritedSpace.cleanup.state).toBe('committed')
    expect(schedulerCalls).toEqual([])
    expect(trace).toEqual(['event:after-commit'])
    expect(publishedTask).toMatchObject({
      id: 'child-task',
      parentTaskId: 'parent-task',
      workflowVersion: 7,
      status: 'pending',
      executionLineageId: 'lineage-1',
    })
    expect(await createWorkspacePreparationJournal(fixture.db).forTask('child-task')).toMatchObject(
      { state: 'admitted', lane: 'pre-materialized' },
    )
    expect(
      await fixture.db.select().from(taskRepos).where(eq(taskRepos.taskId, 'child-task')),
    ).toHaveLength(1)
    expect(
      await fixture.db.select().from(taskSpaceNodes).where(eq(taskSpaceNodes.taskId, 'child-task')),
    ).toHaveLength(1)
    expect(
      await fixture.db
        .select()
        .from(taskCollaborators)
        .where(eq(taskCollaborators.taskId, 'child-task')),
    ).toHaveLength(1)
    expect(
      await fixture.db
        .select()
        .from(taskExecutionIntents)
        .where(eq(taskExecutionIntents.taskId, 'child-task')),
    ).toHaveLength(1)
    expect((await fixture.db.select().from(committedEvents)).length).toBeGreaterThan(0)
  })
})
