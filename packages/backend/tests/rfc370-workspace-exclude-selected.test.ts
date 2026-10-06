// RFC-370: the real provider drive keeps multi-repository order, waits for the
// selected profile acknowledgement and persists the existing failure facts.
import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ulid } from 'ulid'
import { WORKFLOW_SCHEMA_VERSION } from '@agent-workflow/shared'
import { taskRepos, tasks, users, workflows } from '@/db/schema'
import {
  bindWorkspaceExcludeProfile,
  selectWorkspaceExcludeProfileFactory,
  type WorkspaceExcludeProfileFactory,
} from '@/modules/source-control/public/participants'
import type { WorkspaceExcludeProfileReceipt } from '@/modules/source-control/public/types'
import { createTaskExecutionContext } from '@/modules/task-execution/application/taskExecutionContext'
import { createWorkerIdentity } from '@/modules/task-execution/domain/ownership'
import {
  composeTaskWorkspaceExcludeProfilesFor,
  type ProviderTaskRunBindingSelection,
  type LegacyTaskRunComposition,
} from '@/modules/task-execution/composition/localTaskRunSelection'
import type { createTaskExecutionRuntimeParticipants } from '@/modules/task-execution/infrastructure/taskExecutionRuntimeParticipants'
import { describeEachProvider, type ProviderHarness } from './helpers/eachProvider'
import { createEachProviderTaskExecution } from './helpers/eachProviderTaskExecution'
import { held } from './helpers/portArtifactContent'
import {
  chosenTaskRuns,
  unusedAgentFamily,
  unusedScriptFamily,
  unusedTaskRunContents,
} from './helpers/taskRunSelection'

async function fixture(
  harness: ProviderHarness,
  factory: WorkspaceExcludeProfileFactory,
  agentAck?: ReturnType<typeof held<ReturnType<typeof unusedAgentFamily>>>,
  legacy?: Extract<ProviderTaskRunBindingSelection, { readonly taskRunBinding?: undefined }>,
) {
  const db = harness.db,
    userId = ulid(),
    workflowId = ulid(),
    taskId = ulid()
  const appHome = mkdtempSync(join(tmpdir(), 'aw-exclude-selected-'))
  let execution: Awaited<ReturnType<typeof createEachProviderTaskExecution>> | undefined
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
    const definition = {
      $schema_version: WORKFLOW_SCHEMA_VERSION,
      inputs: [],
      nodes: [],
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
      // Parsing stops after the profile stage, so unrelated physical execution
      // cannot hide or manufacture the selected profile result.
      workflowSnapshot: '{}',
      repoPath: 'object:repo:0',
      worktreePath: 'object:workspace:0',
      baseBranch: 'main',
      branch: 'agent-workflow/' + taskId,
      status: 'pending',
      startedAt: 1,
      inputs: '{}',
      autoCommitPush: false,
    })
    for (const [repoIndex, mountPath] of ['', 'nested', 'nested/deeper'].entries()) {
      await db.insert(taskRepos).values({
        taskId,
        repoIndex,
        mountPath,
        repoPath: 'object:repo:' + repoIndex,
        worktreePath: 'object:workspace:' + repoIndex,
        branch: 'agent-workflow/' + taskId,
      })
    }
    const bindingEntered = held<void>()
    const chosen = chosenTaskRuns(unusedTaskRunContents(), {
      agent() {
        bindingEntered.resolve()
        return agentAck === undefined ? unusedAgentFamily() : agentAck.promise
      },
    })
    execution = await createEachProviderTaskExecution(harness, { appHome }, userId, {
      workspacePresence: { exists: () => true },
      ...(legacy === undefined ? { taskRunSelection: chosen.selection } : legacy),
      workspaceExcludeProfiles: factory,
    })
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
      identity: createWorkerIdentity({ ownerId: ulid(), daemonGeneration: 'root-' + ulid() }),
      now,
      leaseMs: 30_000,
    })
    const executionContext = createTaskExecutionContext({
      intentId,
      token,
      persistence: execution.persistence,
    })
    const driver = execution.provider.runtime.schedulerDriver
    return {
      taskId,
      chosen,
      provider: execution.provider,
      executionContext,
      bindingEntered,
      drive: () =>
        driver.drive({ taskId, appHome, executionContext, signal: new AbortController().signal }),
      async driveSeededChild() {
        const parent = (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!
        const childId = ulid()
        await db.insert(tasks).values({
          ...parent,
          id: childId,
          name: childId,
          parentTaskId: taskId,
          status: 'pending',
          errorSummary: null,
          errorMessage: null,
          finishedAt: null,
          branch: 'agent-workflow/' + childId,
          lineageSlotPathJson: JSON.stringify([
            { stableNodeKey: 'task-root', frozenOccurrenceKey: taskId, workflowRevision: null },
            { stableNodeKey: 'call-child', frozenOccurrenceKey: childId, workflowRevision: null },
          ]),
        })
        const childIntent = ulid(),
          childNow = Date.now()
        await execution!.persistence.intents.submitContinuation({
          taskId: childId,
          intentId: childIntent,
          kind: 'launch',
          source: 'rest',
          actorUserId: userId,
          payload: { v: 1 },
          now: childNow,
          advanceOperationGeneration: false,
        })
        const childToken = await execution!.persistence.ownership.claimPendingIntent({
          intentId: childIntent,
          identity: createWorkerIdentity({ ownerId: ulid(), daemonGeneration: 'child-' + ulid() }),
          now: childNow,
          leaseMs: 30_000,
        })
        const childContext = createTaskExecutionContext({
          intentId: childIntent,
          token: childToken,
          persistence: execution!.persistence,
        })
        await driver.drive({
          taskId: childId,
          appHome,
          executionContext: childContext,
          signal: new AbortController().signal,
        })
        return {
          childId,
          childContext,
          parentTaskId: (await db.select().from(tasks).where(eq(tasks.id, childId)))[0]!
            .parentTaskId,
        }
      },
      rows: () =>
        db
          .select()
          .from(taskRepos)
          .where(eq(taskRepos.taskId, taskId))
          .orderBy(taskRepos.repoIndex),
      task: async () => (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!,
      async close() {
        await execution!.shutdown()
        rmSync(appHome, { recursive: true, force: true })
      },
    }
  } catch (error) {
    await execution?.shutdown()
    rmSync(appHome, { recursive: true, force: true })
    throw error
  }
}

describeEachProvider('RFC-370 selected workspace profiles in real Task drives', (harness) => {
  test('legacy factories retain the complete common receiver, including default content factories', async () => {
    type Receiver = Parameters<typeof createTaskExecutionRuntimeParticipants>[0] &
      LegacyTaskRunComposition
    for (const replaceContents of [false, true]) {
      const receivers: Receiver[] = [],
        calls: string[] = []
      const contents = unusedTaskRunContents()
      const note = (receiver: Receiver, call: string) => {
        receivers.push(receiver)
        calls.push(call)
        expect(receiver.db).toBe(harness.db)
        expect(receiver.persistence).toBe(h.provider.persistence)
        expect(receiver.activity).toBe(h.provider.participants.activity)
        expect(receiver.lifecycle).toBeDefined()
        expect(receiver.stop).toBeDefined()
        expect(receiver.runtimeSessionLeases).toBeDefined()
        expect(receiver.memoryInjectionQueries).toBeDefined()
        expect(typeof receiver.runtimeRegistry.resolveRuntimeByName).toBe('function')
        expect(typeof receiver.nodeRunPromptsFor).toBe('function')
        expect(typeof receiver.portArtifactsFor).toBe('function')
        expect(receiver.taskAgentRunsFor).toBe(legacy.taskAgentRunsFor)
        expect(receiver.taskScriptRunsFor).toBe(legacy.taskScriptRunsFor)
      }
      const legacy = {
        ...(replaceContents
          ? {
              nodeRunPromptsFor(this: Receiver) {
                note(this, 'prompt')
                return contents.nodeRunPrompts
              },
              portArtifactsFor(this: Receiver) {
                note(this, 'archive')
                return contents.portArtifacts
              },
            }
          : {}),
        taskAgentRunsFor(
          this: Receiver,
          binding: Parameters<LegacyTaskRunComposition['taskAgentRunsFor']>[0],
        ) {
          note(this, 'agent')
          expect(binding.nodeRunRuntime).toBe(this.nodeRunRuntime)
          expect(binding.runtimeRegistry).toBe(this.runtimeRegistry)
          if (replaceContents) {
            expect(binding.nodeRunPrompts).toBe(contents.nodeRunPrompts)
            expect(binding.portArtifacts).toBe(contents.portArtifacts)
          }
          return unusedAgentFamily()
        },
        taskScriptRunsFor(this: Receiver) {
          note(this, 'script')
          return unusedScriptFamily()
        },
      }
      const h = await fixture(
        harness,
        {
          bind: () => ({
            ensure: async () => ({ version: 1, digest: 'legacy-receiver', directChildMounts: [] }),
          }),
        },
        undefined,
        legacy,
      )
      try {
        await h.drive()
        await h.driveSeededChild()
        expect(calls).toEqual(
          replaceContents
            ? ['prompt', 'archive', 'agent', 'script', 'prompt', 'archive', 'agent', 'script']
            : ['agent', 'script', 'agent', 'script'],
        )
        for (const receiver of receivers) expect(receiver).toBe(receivers[0])
        expect(receivers[0]!.taskRunBinding).toBeDefined()
        expect((await h.rows()).map((row) => row.workspaceProfileDigest)).toEqual([
          'legacy-receiver',
          'legacy-receiver',
          'legacy-receiver',
        ])
      } finally {
        await h.close()
      }
    }
  })

  test('root, persisted child and later drive bind their own families and configuration references', async () => {
    const h = await fixture(harness, {
      bind: () => ({
        ensure: async () => ({ version: 1, digest: 'chosen-profile', directChildMounts: [] }),
      }),
    })
    try {
      await h.drive()
      const child = await h.driveSeededChild()
      await h.drive()
      expect(child.parentTaskId).toBe(h.taskId)
      expect(h.chosen.agents.map((binding) => binding.taskId)).toEqual([
        h.taskId,
        child.childId,
        h.taskId,
      ])
      expect(h.chosen.scripts).toEqual(h.chosen.agents)
      expect(h.chosen.agents[1]!.executionContext).toBe(child.childContext)
      expect(new Set(h.chosen.agents.map((binding) => binding.configuration.reference)).size).toBe(
        3,
      )
      for (const binding of h.chosen.agents) {
        expect(binding.nodeRunPrompts).toBe(h.chosen.selection.runs.nodeRunPrompts)
        expect(binding.portArtifacts).toBe(h.chosen.selection.runs.portArtifacts)
        expect(binding.contentNamespace).toBe(h.chosen.selection.runs.contentNamespace)
        expect(binding).not.toHaveProperty('appHome')
      }
    } finally {
      await h.close()
    }
  })

  test('whole run binding and each profile ACK precede persistence and the next repository', async () => {
    const agentAck = held<ReturnType<typeof unusedAgentFamily>>()
    const entered = held<void>(),
      profileAck = held<WorkspaceExcludeProfileReceipt>()
    const events: string[] = [],
      mounts: string[][] = []
    const factory: WorkspaceExcludeProfileFactory = {
      bind({ workspaceRef }) {
        expect(this).toBe(factory)
        events.push('bind:' + workspaceRef)
        const participant = {
          async ensure(input?: { directChildMounts?: readonly string[] }) {
            expect(this).toBe(participant)
            mounts.push([...(input?.directChildMounts ?? [])])
            events.push('ensure:' + workspaceRef)
            if (workspaceRef.endsWith(':0')) {
              entered.resolve()
              return await profileAck.promise
            }
            return {
              version: 1 as const,
              digest: 'chosen:' + workspaceRef,
              directChildMounts: input?.directChildMounts ?? [],
            }
          },
        }
        return participant
      },
    }
    const h = await fixture(harness, factory, agentAck)
    let pending: Promise<void> | undefined
    try {
      pending = h.drive()
      await Promise.race([
        h.bindingEntered.promise,
        pending.then(() => {
          throw new Error('drive ended before run binding')
        }),
      ])
      expect(h.chosen.agents).toHaveLength(1)
      expect(h.chosen.scripts).toEqual([])
      expect(events).toEqual([])
      agentAck.resolve(unusedAgentFamily())
      await Promise.race([
        entered.promise,
        pending.then(() => {
          throw new Error('drive ended before chosen profile')
        }),
      ])
      expect(h.chosen.scripts).toHaveLength(1)
      expect(h.chosen.scripts[0]).toBe(h.chosen.agents[0])
      expect(h.chosen.agents[0]!.executionContext).toBe(h.executionContext)
      expect(events).toEqual(['bind:object:workspace:0', 'ensure:object:workspace:0'])
      expect((await h.rows()).map((row) => row.workspaceProfileDigest)).toEqual([null, null, null])
      profileAck.resolve({
        version: 1,
        digest: 'chosen:object:workspace:0',
        directChildMounts: ['nested'],
      })
      await pending
      expect(events).toEqual([
        'bind:object:workspace:0',
        'ensure:object:workspace:0',
        'bind:object:workspace:1',
        'ensure:object:workspace:1',
        'bind:object:workspace:2',
        'ensure:object:workspace:2',
      ])
      expect(mounts).toEqual([['nested'], ['deeper'], []])
      expect(
        (await h.rows()).map((row) => [row.workspaceProfileVersion, row.workspaceProfileDigest]),
      ).toEqual([
        [1, 'chosen:object:workspace:0'],
        [1, 'chosen:object:workspace:1'],
        [1, 'chosen:object:workspace:2'],
      ])
      expect((await h.task()).status).toBe('failed')
    } finally {
      agentAck.resolve(unusedAgentFamily())
      profileAck.resolve({ version: 1, digest: 'cleanup', directChildMounts: [] })
      await pending
      await h.close()
    }
  })

  test('profile rejection stops later repositories and leaves the existing failure fact', async () => {
    const reason = new Error('selected profile unavailable'),
      calls: string[] = []
    const h = await fixture(harness, {
      bind({ workspaceRef }) {
        calls.push(workspaceRef)
        return {
          async ensure() {
            throw reason
          },
        }
      },
    })
    try {
      await h.drive()
      expect(calls).toEqual(['object:workspace:0'])
      expect((await h.rows()).map((row) => row.workspaceProfileDigest)).toEqual([null, null, null])
      const task = await h.task()
      expect(task.status).toBe('failed')
      expect(task.errorSummary).toBe('workspace-exclude-profile-failed')
      expect(task.errorMessage).toContain(reason.message)
    } finally {
      await h.close()
    }
  })
})

describe('RFC-370 profile bootstrap choice', () => {
  test('explicit missing factory or participant fails without native completion', () => {
    expect(() =>
      selectWorkspaceExcludeProfileFactory({} as WorkspaceExcludeProfileFactory),
    ).toThrow(TypeError)
    expect(() =>
      bindWorkspaceExcludeProfile({ bind: () => ({}) } as WorkspaceExcludeProfileFactory, {
        workspaceRef: 'object:missing',
      }),
    ).toThrow(TypeError)
  })

  test('native legacy home is read at repository binding and selected references stay uninterpreted', () => {
    let reads = 0
    const request = {
      get appHome() {
        reads++
        return 'native:late-home'
      },
    }
    const factory = composeTaskWorkspaceExcludeProfilesFor()(request)
    expect(reads).toBe(0)
    bindWorkspaceExcludeProfile(factory, { workspaceRef: 'native:late-workspace' })
    expect(reads).toBe(1)
    bindWorkspaceExcludeProfile(factory, { workspaceRef: 'native:second-workspace' })
    expect(reads).toBe(2)
    const chosen: WorkspaceExcludeProfileFactory = {
      bind: () => ({
        ensure: async () => ({ version: 1, digest: 'chosen', directChildMounts: [] }),
      }),
    }
    const selected = composeTaskWorkspaceExcludeProfilesFor(chosen)
    expect(selected(request)).toBe(chosen)
    expect(reads).toBe(2)
  })
})
