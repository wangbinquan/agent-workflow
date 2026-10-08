// RFC-370 W2-P: native Task projections and runtime preparation use their original work.
import { afterEach, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { ProviderNeutralDatabase } from '@/db/query'
import { nodeRunEvents, nodeRuns, taskExecutionOwners, taskRepos } from '@/db/schema'
import {
  createTaskExecutionContext,
  currentTaskExecutionContext,
  runWithTaskExecutionContext,
} from '@/modules/task-execution/application/taskExecutionContext'
import {
  taskHostWorkCapture,
  taskHostWorkForToken,
} from '@/modules/task-execution/application/taskHostAdmission'
import {
  createOwnershipToken,
  createWorkerIdentity,
} from '@/modules/task-execution/domain/ownership'
import type { TaskEngineApplicationPersistence } from '@/modules/task-execution/application/ports/taskEngineApplicationPersistence'
import type { WrapperRunPersistence } from '@/modules/task-execution/application/ports/wrapperRunPersistence'
import type { NodeRunRuntimeSelectionSession } from '@/modules/task-execution/application/ports/nodeRunRuntimePersistence'
import { DrizzleTaskEngineApplicationPersistence } from '@/modules/task-execution/infrastructure/taskEngineApplicationPersistence'
import { DrizzleWrapperRunPersistence } from '@/modules/task-execution/infrastructure/wrapperRunPersistence'
import { createRuntimeSessionCapturePersistence } from '@/modules/task-execution/infrastructure/runtimeSessionCapturePersistence'
import { DrizzleNodeRunRuntimePersistence } from '@/modules/task-execution/infrastructure/nodeRunRuntimePersistence'
import { createSelectedTaskExecutionProjectionPersistence } from '@/modules/task-execution/infrastructure/taskHostExecutionProjectionPersistence'
import { createSelectedTaskNodeRunRuntimePersistence } from '@/modules/task-execution/infrastructure/taskHostNodeRunRuntimePersistence'
import { createTaskExecutionPersistence } from '@/modules/task-execution/composition/taskExecutionPersistence'
import { composeNodeRunRuntimePersistence } from '@/modules/task-execution/composition/nodeRunRuntime'
import { composeRuntimeSelectionParticipantInTx } from '@/modules/runtime-management/composition/runtimeSelection'
import { resolveFrozenRuntimeWith } from '@/services/nodeRunMint'
import { describeEachProvider } from './helpers/eachProvider'
import {
  additionalTaskHostFixture,
  deferred,
  taskHostFixture,
  type TaskHostWorkFixture,
} from './helpers/taskHostExecution'
import type { StatementRecording } from './helpers/statementRecorder'

const modules: { resetForTesting(): void }[] = []
afterEach(() => {
  for (const module of modules) module.resetForTesting()
  modules.length = 0
})

async function projectionFixture(
  db: ProviderNeutralDatabase,
  tag: string,
  options: Parameters<typeof taskHostFixture>[2] = {},
  installation?: TaskHostWorkFixture,
) {
  const taskId = `projection-${tag}-${ulid()}`
  const h = installation
    ? await additionalTaskHostFixture(installation, taskId)
    : await taskHostFixture(db, taskId, options)
  modules.push(h.module)
  const claimed = await h.claim()
  h.module.claimGate.leave(claimed.permit)
  const work = taskHostWorkForToken(claimed.token)!
  const context = createTaskExecutionContext({
    intentId: h.intentId,
    token: claimed.token,
    persistence: h.persistence,
    legacyConnection: db,
    compatibility: { db },
    hostWriteCapture: taskHostWorkCapture(work),
  })
  const runId = `run-${h.taskId}`,
    wrapperId = `wrapper-${h.taskId}`,
    sessionId = `session-${h.taskId}`
  await db.insert(taskRepos).values({
    taskId: h.taskId,
    repoIndex: 0,
    repoPath: '/tmp/repo',
    worktreeDirName: 'repo',
    worktreePath: `/tmp/worktree/${h.taskId}/repo`,
    baseBranch: 'main',
    branch: `agent-workflow/${h.taskId}`,
  })
  await db.insert(nodeRuns).values([
    {
      id: runId,
      taskId: h.taskId,
      nodeId: 'worker',
      status: 'pending',
      opencodeSessionId: sessionId,
    },
    {
      id: wrapperId,
      taskId: h.taskId,
      nodeId: 'wrapper',
      status: 'interrupted',
      wrapperProgressJson: JSON.stringify({
        kind: 'fanout',
        reuseDisabled: true,
        phase: 'inner-running',
      }),
    },
  ])
  const native = {
    drive: new DrizzleTaskEngineApplicationPersistence(db),
    wrapperRuns: new DrizzleWrapperRunPersistence(db),
    runtimeSessionCapture: createRuntimeSessionCapturePersistence(db),
  }
  const selected = {
    drive: h.persistence.drive,
    wrapperRuns: h.persistence.wrapperRuns,
    runtimeSessionCapture: h.persistence.runtimeSessionCapture,
  }
  const runtime = composeNodeRunRuntimePersistence(db, composeRuntimeSelectionParticipantInTx, {
    hostWrites: h.binding,
  })
  const profile = (
    extra: Partial<Parameters<TaskEngineApplicationPersistence['updateWorkspaceProfile']>[0]> = {},
  ) => ({
    taskId: h.taskId,
    repoIndex: 0,
    version: 7,
    digest: 'received-profile',
    now: Date.now(),
    ...extra,
  })
  const transcript = () => ({
    taskId: h.taskId,
    nodeRunId: runId,
    events: [
      {
        ts: 1,
        kind: 'text' as const,
        payload: 'received transcript',
        sessionId,
        parentSessionId: null,
      },
    ],
  })
  const rows = async () => ({
    owners: await db
      .select()
      .from(taskExecutionOwners)
      .where(eq(taskExecutionOwners.taskId, h.taskId)),
    repositories: await db.select().from(taskRepos).where(eq(taskRepos.taskId, h.taskId)),
    runs: await db
      .select()
      .from(nodeRuns)
      .where(eq(nodeRuns.taskId, h.taskId))
      .orderBy(nodeRuns.id),
    events: await db
      .select()
      .from(nodeRunEvents)
      .where(eq(nodeRunEvents.nodeRunId, runId))
      .orderBy(nodeRunEvents.id),
  })
  return {
    h,
    context,
    work,
    runId,
    wrapperId,
    sessionId,
    native,
    selected,
    runtime,
    profile,
    transcript,
    rows,
  }
}

type Fixture = Awaited<ReturnType<typeof projectionFixture>>
type Projection = 'workspace' | 'wrapper' | 'transcript'
function receivedWrite(f: Fixture, kind: Projection) {
  if (kind === 'workspace') return f.selected.drive.updateWorkspaceProfile(f.profile())
  if (kind === 'wrapper')
    return f.selected.wrapperRuns.clearReuseDisabled({ nodeRunId: f.wrapperId })
  return f.selected.runtimeSessionCapture.appendEvents(f.transcript())
}
function expectOriginalWork(f: Fixture, expectedLeases = 1) {
  expect(f.h.completed).toBe(0)
  expect(f.h.leases).toHaveLength(expectedLeases)
  expect(taskHostWorkForToken(f.context.token)).toBe(f.work)
}
function expectTransaction(recording: StatementRecording, result: 'commit' | 'rollback') {
  expect(recording.statements.filter(({ sql }) => /^\s*begin\b/i.test(sql))).toHaveLength(1)
  expect(recording.statements.filter(({ sql }) => /^\s*commit\b/i.test(sql))).toHaveLength(
    result === 'commit' ? 1 : 0,
  )
  expect(recording.statements.filter(({ sql }) => /^\s*rollback\b/i.test(sql))).toHaveLength(
    result === 'rollback' ? 1 : 0,
  )
}

describeEachProvider('RFC-370 selected native Task execution projections', (harness) => {
  for (const kind of ['workspace', 'wrapper', 'transcript'] as const) {
    test(`${kind}: received result writes real rows and one owner revision while draining`, async () => {
      const f = await projectionFixture(harness.db, kind)
      const before = await f.rows()
      f.h.lose()
      const recording = harness.recordStatements()
      try {
        await runWithTaskExecutionContext(f.context, () => receivedWrite(f, kind))
        expectTransaction(recording, 'commit')
      } finally {
        recording.stop()
      }
      const after = await f.rows()
      expect(after.owners[0]?.revision).toBe(before.owners[0]!.revision + 1)
      if (kind === 'workspace') {
        expect(after.repositories[0]).toMatchObject({
          workspaceProfileVersion: 7,
          workspaceProfileDigest: 'received-profile',
        })
      } else if (kind === 'wrapper') {
        expect(
          JSON.parse(after.runs.find((row) => row.id === f.wrapperId)!.wrapperProgressJson!),
        ).toEqual({ kind: 'fanout', phase: 'inner-running' })
      } else {
        expect(after.events).toHaveLength(1)
        expect(after.events[0]).toMatchObject({
          payload: 'received transcript',
          sessionId: f.sessionId,
        })
      }
      expectOriginalWork(f)
    })
    test(`${kind}: a failed issued ACK rolls back original rows and the same work retries`, async () => {
      let fail = false
      const error = new Error(`received ${kind} ACK failed`)
      const f = await projectionFixture(harness.db, kind + '-rollback', {
        beforeIssuedAck: () => {
          if (fail) throw error
        },
      })
      const before = await f.rows()
      fail = true
      const recording = harness.recordStatements()
      try {
        await expect(
          runWithTaskExecutionContext(f.context, () => receivedWrite(f, kind)),
        ).rejects.toBe(error)
        expectTransaction(recording, 'rollback')
      } finally {
        recording.stop()
      }
      expect(await f.rows()).toEqual(before)
      fail = false
      f.h.lose()
      await runWithTaskExecutionContext(f.context, () => receivedWrite(f, kind))
      expect((await f.rows()).owners[0]?.revision).toBe(before.owners[0]!.revision + 1)
      expectOriginalWork(f)
    })
  }
  for (const kind of ['workspace', 'wrapper'] as const) {
    for (const ambient of ['absent', 'another-task'] as const) {
      test(`${kind}: the original explicit context wins with ${ambient} ambient`, async () => {
        const f = await projectionFixture(harness.db, kind + '-explicit')
        const other =
          ambient === 'another-task'
            ? await projectionFixture(harness.db, 'other', {}, f.h)
            : undefined
        if (other) {
          expect(other.h.module).toBe(f.h.module)
          expect(other.h.binding).toBe(f.h.binding)
          expect(other.context.token).not.toBe(f.context.token)
          expect(other.context.token.taskId).not.toBe(f.context.token.taskId)
          expect(other.work).not.toBe(f.work)
        }
        const before = await f.rows(),
          otherBefore = await other?.rows()
        let calls = 0
        const drive: TaskEngineApplicationPersistence = {
          load: f.native.drive.load.bind(f.native.drive),
          findStatus: f.native.drive.findStatus.bind(f.native.drive),
          async updateWorkspaceProfile(input) {
            expect(this).toBe(drive)
            expect(input.executionContext).toBe(f.context)
            expect(currentTaskExecutionContext()).toBe(f.context)
            expect(taskHostWorkForToken(currentTaskExecutionContext()!.token)).toBe(f.work)
            await Promise.resolve()
            expect(currentTaskExecutionContext()).toBe(f.context)
            calls++
            return f.native.drive.updateWorkspaceProfile(input)
          },
        }
        const wrappers: WrapperRunPersistence = {
          findResumable: f.native.wrapperRuns.findResumable.bind(f.native.wrapperRuns),
          resolveConsumed: f.native.wrapperRuns.resolveConsumed.bind(f.native.wrapperRuns),
          readStatus: f.native.wrapperRuns.readStatus.bind(f.native.wrapperRuns),
          async clearReuseDisabled(input) {
            expect(this).toBe(wrappers)
            expect(input.executionContext).toBe(f.context)
            expect(currentTaskExecutionContext()).toBe(f.context)
            expect(taskHostWorkForToken(currentTaskExecutionContext()!.token)).toBe(f.work)
            await Promise.resolve()
            expect(currentTaskExecutionContext()).toBe(f.context)
            calls++
            return f.native.wrapperRuns.clearReuseDisabled(input)
          },
        }
        const selected = createSelectedTaskExecutionProjectionPersistence({
          db: harness.db,
          hostWrites: f.h.binding,
          drive,
          wrapperRuns: wrappers,
          runtimeSessionCapture: f.native.runtimeSessionCapture,
        })
        const invoke = () =>
          kind === 'workspace'
            ? selected.drive.updateWorkspaceProfile(f.profile({ executionContext: f.context }))
            : selected.wrapperRuns.clearReuseDisabled({
                nodeRunId: f.wrapperId,
                executionContext: f.context,
              })
        f.h.lose()
        if (other) {
          if (otherBefore === undefined) throw new Error('missing-other-task-before-state')
          await runWithTaskExecutionContext(other.context, async () => {
            await invoke()
            expect(currentTaskExecutionContext()).toBe(other.context)
          })
          expect(await other.rows()).toEqual(otherBefore)
          expectOriginalWork(other, 2)
        } else await invoke()
        expect(currentTaskExecutionContext()).toBeUndefined()
        expect(calls).toBe(1)
        const after = await f.rows()
        expect(after.owners[0]?.revision).toBe(before.owners[0]!.revision + 1)
        if (kind === 'workspace')
          expect(after.repositories[0]?.workspaceProfileDigest).toBe('received-profile')
        else
          expect(
            JSON.parse(after.runs.find((r) => r.id === f.wrapperId)!.wrapperProgressJson!),
          ).toEqual({ kind: 'fanout', phase: 'inner-running' })
        expectOriginalWork(f, other ? 2 : 1)
      })
    }
  }
  test('empty transcript and independent reads require no Task admission or host consumption', async () => {
    let ack = 0
    const f = await projectionFixture(harness.db, 'reads', {
      beforeIssuedAck: () => {
        ack++
      },
    })
    f.h.lose()
    const before = await f.rows(),
      initialAck = ack
    const recording = harness.recordStatements()
    try {
      await f.selected.runtimeSessionCapture.appendEvents({ ...f.transcript(), events: [] })
      expect(recording.statements).toEqual([])
      expect((await f.selected.drive.load(f.h.taskId))?.task.id).toBe(f.h.taskId)
      expect(await f.selected.drive.findStatus(f.h.taskId)).toBe('running')
      expect(
        (
          await f.selected.wrapperRuns.findResumable({
            taskId: f.h.taskId,
            nodeId: 'wrapper',
            containerRunId: null,
            iteration: 0,
          })
        )?.id,
      ).toBe(f.wrapperId)
      expect(
        await f.selected.wrapperRuns.resolveConsumed({ taskId: f.h.taskId, sources: [] }),
      ).toEqual({})
      expect(await f.selected.wrapperRuns.readStatus(f.wrapperId)).toBe('interrupted')
      expect(await f.selected.runtimeSessionCapture.resolveTaskId(f.runId)).toBe(f.h.taskId)
      expect(
        await f.selected.runtimeSessionCapture.listSiblingCapturedSessionIds({
          taskId: f.h.taskId,
          nodeRunId: f.runId,
        }),
      ).toEqual(new Set())
      expect(await f.runtime.load(f.runId)).toEqual({
        runtime: null,
        runtimeBinary: null,
        runtimeParamsJson: null,
      })
      expect(await f.runtime.findBySessionId(f.sessionId)).toEqual({
        runtime: null,
        runtimeBinary: null,
        runtimeParamsJson: null,
      })
      expect(
        recording.statements.filter(({ sql }) =>
          /^\s*(begin|commit|rollback|update|insert)\b/i.test(sql),
        ),
      ).toEqual([])
    } finally {
      recording.stop()
    }
    expect(ack).toBe(initialAck)
    expect(await f.rows()).toEqual(before)
    expectOriginalWork(f)
  })
  test('native false and missing/no-op wrapper results remain unchanged', async () => {
    const f = await projectionFixture(harness.db, 'no-op')
    const before = await f.rows()
    f.h.lose()
    await runWithTaskExecutionContext(f.context, async () => {
      expect(await f.selected.drive.updateWorkspaceProfile(f.profile({ repoIndex: 9 }))).toBe(false)
      expect(
        await f.selected.wrapperRuns.clearReuseDisabled({ nodeRunId: 'missing' }),
      ).toBeUndefined()
      await f.selected.wrapperRuns.clearReuseDisabled({ nodeRunId: f.runId })
    })
    const after = await f.rows()
    expect(after.owners[0]?.revision).toBe(before.owners[0]!.revision + 2)
    expect(after.repositories).toEqual(before.repositories)
    expect(after.runs).toEqual(before.runs)
    expect(after.events).toEqual([])
    expectOriginalWork(f)
  })
  test('original business error precedes host consumption and rolls back both Tasks', async () => {
    let ack = 0
    const f = await projectionFixture(harness.db, 'original-error', {
      beforeIssuedAck: () => {
        ack++
        throw new Error('ACK must not replace original error')
      },
    })
    const other = await projectionFixture(harness.db, 'mismatch', {}, f.h)
    expect(other.h.module).toBe(f.h.module)
    expect(other.h.binding).toBe(f.h.binding)
    expect(other.context.token.taskId).not.toBe(f.context.token.taskId)
    const before = await f.rows(),
      otherBefore = await other.rows()
    f.h.lose()
    await expect(
      f.selected.drive.updateWorkspaceProfile(
        f.profile({ taskId: other.h.taskId, executionContext: f.context }),
      ),
    ).rejects.toThrow('task-execution-context-task-mismatch')
    expect(ack).toBe(0)
    expect(await f.rows()).toEqual(before)
    expect(await other.rows()).toEqual(otherBefore)
    expectOriginalWork(f, 2)
  })
  test('selected writes require original context/work and never fall back to native writes', async () => {
    const f = await projectionFixture(harness.db, 'missing-context')
    const before = await f.rows()
    await expect(f.selected.drive.updateWorkspaceProfile(f.profile())).rejects.toThrow(
      'task-host-execution-context-required',
    )
    await expect(
      f.selected.wrapperRuns.clearReuseDisabled({ nodeRunId: f.wrapperId }),
    ).rejects.toThrow('task-host-execution-context-required')
    await expect(f.selected.runtimeSessionCapture.appendEvents(f.transcript())).rejects.toThrow(
      'task-host-execution-context-required',
    )
    await expect(
      f.runtime.freeze({
        nodeRunId: f.runId,
        runtime: 'opencode',
        runtimeBinary: null,
        runtimeParamsJson: '{}',
      }),
    ).rejects.toThrow('task-host-execution-context-required')
    const unassociated = createTaskExecutionContext({
      intentId: f.h.intentId,
      token: createOwnershipToken({
        taskId: f.context.token.taskId,
        identity: createWorkerIdentity({
          ownerId: f.context.token.ownerId,
          daemonGeneration: f.context.token.daemonGeneration,
        }),
        epoch: f.context.token.epoch,
        leaseUntil: f.context.token.leaseUntil,
        ownerRevision: f.context.token.ownerRevision,
      }),
      persistence: f.h.persistence,
    })
    await expect(
      f.selected.drive.updateWorkspaceProfile(f.profile({ executionContext: unassociated })),
    ).rejects.toThrow('task-host-admitted-work-required')
    expect(await f.rows()).toEqual(before)
    expectOriginalWork(f)
  })
  test('saved method, receiver and complete original context survive an await and method replacement', async () => {
    const f = await projectionFixture(harness.db, 'method'),
      entered = deferred(),
      allow = deferred()
    const drive: TaskEngineApplicationPersistence = {
      load: f.native.drive.load.bind(f.native.drive),
      findStatus: f.native.drive.findStatus.bind(f.native.drive),
      async updateWorkspaceProfile(input) {
        expect(this).toBe(drive)
        expect(currentTaskExecutionContext()).toBe(f.context)
        entered.resolve()
        await allow.promise
        expect(currentTaskExecutionContext()).toBe(f.context)
        expect(currentTaskExecutionContext()?.persistence).toBe(f.h.persistence)
        expect(currentTaskExecutionContext()?.legacyConnection).toBe(harness.db)
        return f.native.drive.updateWorkspaceProfile(input)
      },
    }
    const selected = createSelectedTaskExecutionProjectionPersistence({
      db: harness.db,
      hostWrites: f.h.binding,
      ...f.native,
      drive,
    })
    const pending = runWithTaskExecutionContext(f.context, () =>
      selected.drive.updateWorkspaceProfile(f.profile()),
    )
    await entered.promise
    drive.updateWorkspaceProfile = async () => {
      throw new Error('replacement must not run')
    }
    f.h.lose()
    allow.resolve()
    expect(await pending).toBe(true)
    expect((await f.rows()).repositories[0]?.workspaceProfileDigest).toBe('received-profile')
    expectOriginalWork(f)
  })
  test('real runtime selection freezes once, inherited snapshots and frozen early returns remain preparation', async () => {
    const f = await projectionFixture(harness.db, 'selection')
    const before = await f.rows(),
      recording = harness.recordStatements()
    let frozen: Awaited<ReturnType<typeof resolveFrozenRuntimeWith>>
    try {
      frozen = await runWithTaskExecutionContext(f.context, () =>
        resolveFrozenRuntimeWith(f.runtime, f.runId, 'claude-code', 'opencode'),
      )
      expectTransaction(recording, 'commit')
    } finally {
      recording.stop()
    }
    expect(frozen!.protocol).toBe('claude-code')
    expect(await f.runtime.load(f.runId)).toMatchObject({
      runtime: 'claude-code',
      runtimeBinary: frozen!.binary,
    })
    expect((await f.rows()).owners[0]?.revision).toBe(before.owners[0]!.revision + 1)
    const inherited = await runWithTaskExecutionContext(f.context, () =>
      resolveFrozenRuntimeWith(f.runtime, f.wrapperId, 'opencode', null, frozen!),
    )
    expect(inherited).toEqual(frozen!)
    expect(await f.runtime.load(f.wrapperId)).toEqual(await f.runtime.load(f.runId))
    f.h.lose()
    const after = await f.rows()
    await expect(
      runWithTaskExecutionContext(f.context, () =>
        resolveFrozenRuntimeWith(f.runtime, f.runId, 'opencode', 'opencode'),
      ),
    ).rejects.toThrow('host-execution-write-context-unavailable')
    expect(await f.rows()).toEqual(after)
    expectOriginalWork(f)
  })
  test('authority loss after real runtime SQL rolls back frozen columns and owner revision', async () => {
    let revoke = () => {}
    const f = await projectionFixture(harness.db, 'selection-rollback', {
      beforeNewWork: () => revoke(),
    })
    const before = await f.rows()
    revoke = () => f.h.lose()
    const recording = harness.recordStatements()
    try {
      await expect(
        runWithTaskExecutionContext(f.context, () =>
          resolveFrozenRuntimeWith(f.runtime, f.runId, 'claude-code', null),
        ),
      ).rejects.toThrow('host-execution-write-context-unavailable')
      expect(recording.statements.some(({ sql }) => /update\s+.*node_runs/i.test(sql))).toBe(true)
      expectTransaction(recording, 'rollback')
    } finally {
      recording.stop()
    }
    expect(await f.rows()).toEqual(before)
    expectOriginalWork(f)
  })
  test('direct freeze is new preparation and host failure rolls back the original three-column SQL', async () => {
    let fail = false
    const error = new Error('original runtime receipt failed')
    const f = await projectionFixture(harness.db, 'freeze', {
      beforeNewWork: () => {
        if (fail) throw error
      },
    })
    const snapshot = {
      nodeRunId: f.runId,
      runtime: 'opencode' as const,
      runtimeBinary: '/runtime/frozen',
      runtimeParamsJson: '{"model":"frozen"}',
    }
    const before = await f.rows()
    fail = true
    await expect(
      runWithTaskExecutionContext(f.context, () => f.runtime.freeze(snapshot)),
    ).rejects.toBe(error)
    expect(await f.rows()).toEqual(before)
    fail = false
    await runWithTaskExecutionContext(f.context, () => f.runtime.freeze(snapshot))
    expect(await f.runtime.load(f.runId)).toEqual({
      runtime: snapshot.runtime,
      runtimeBinary: snapshot.runtimeBinary,
      runtimeParamsJson: snapshot.runtimeParamsJson,
    })
    expect((await f.rows()).owners[0]?.revision).toBe(before.owners[0]!.revision + 1)
    expectOriginalWork(f)
  })
  test('original callback error, node mismatch and finally-inactive session retain their behavior', async () => {
    const f = await projectionFixture(harness.db, 'callback')
    const before = await f.rows(),
      error = new Error('original selection body failed')
    let escaped: NodeRunRuntimeSelectionSession | undefined
    f.h.lose()
    await expect(
      runWithTaskExecutionContext(f.context, () =>
        f.runtime.withSelection(f.runId, async (session) => {
          escaped = session
          await session.freeze({
            nodeRunId: f.runId,
            runtime: 'opencode',
            runtimeBinary: null,
            runtimeParamsJson: '{}',
          })
          throw error
        }),
      ),
    ).rejects.toBe(error)
    expect(await f.rows()).toEqual(before)
    await expect(escaped!.load()).rejects.toThrow('node-run-runtime-selection-outside-transaction')
    await expect(escaped!.select('opencode', null)).rejects.toThrow(
      'node-run-runtime-selection-outside-transaction',
    )
    await expect(
      runWithTaskExecutionContext(f.context, () =>
        f.runtime.withSelection(f.runId, async (session) =>
          session.freeze({
            nodeRunId: f.wrapperId,
            runtime: 'opencode',
            runtimeBinary: null,
            runtimeParamsJson: '{}',
          }),
        ),
      ),
    ).rejects.toThrow('node-run-runtime-selection-node-mismatch')
    expect(await f.rows()).toEqual(before)
    expectOriginalWork(f)
  })
  test('runtime adapter retains the original generic method and session without rewrapping', async () => {
    const f = await projectionFixture(harness.db, 'runtime-method'),
      entered = deferred(),
      allow = deferred()
    const native = composeNodeRunRuntimePersistence(
      harness.db,
      composeRuntimeSelectionParticipantInTx,
    )
    const original = native.withSelection.bind(native)
    let originalSession: NodeRunRuntimeSelectionSession | undefined
    native.withSelection = async function <T>(
      nodeRunId: string,
      body: (session: NodeRunRuntimeSelectionSession) => Promise<T>,
    ): Promise<T> {
      expect(this).toBe(native)
      expect(currentTaskExecutionContext()).toBe(f.context)
      entered.resolve()
      await allow.promise
      expect(currentTaskExecutionContext()).toBe(f.context)
      return original(nodeRunId, async (session) => {
        originalSession = session
        return body(session)
      })
    }
    const selected = createSelectedTaskNodeRunRuntimePersistence({
      db: harness.db,
      hostWrites: f.h.binding,
      persistence: native,
    })
    const expected = Object.freeze({ selected: true })
    const pending = runWithTaskExecutionContext(f.context, () =>
      selected.withSelection(f.runId, async (session) => {
        if (originalSession === undefined) throw new Error('missing-original-selection-session')
        expect(session).toBe(originalSession)
        await session.freeze({
          nodeRunId: f.runId,
          runtime: 'opencode',
          runtimeBinary: null,
          runtimeParamsJson: '{}',
        })
        return expected
      }),
    )
    await entered.promise
    native.withSelection = async () => {
      throw new Error('replacement must not run')
    }
    allow.resolve()
    expect(await pending).toBe(expected)
    expectOriginalWork(f)
  })
  test('composition selects adapters explicitly and default factories retain native instances', async () => {
    const f = await projectionFixture(harness.db, 'default')
    const native = createTaskExecutionPersistence(harness.db)
    expect(native.drive).toBeInstanceOf(DrizzleTaskEngineApplicationPersistence)
    expect(native.wrapperRuns).toBeInstanceOf(DrizzleWrapperRunPersistence)
    expect(f.selected.drive).not.toBeInstanceOf(DrizzleTaskEngineApplicationPersistence)
    expect(f.selected.wrapperRuns).not.toBeInstanceOf(DrizzleWrapperRunPersistence)
    expect(
      composeNodeRunRuntimePersistence(harness.db, composeRuntimeSelectionParticipantInTx),
    ).toBeInstanceOf(DrizzleNodeRunRuntimePersistence)
    expect(f.runtime).not.toBeInstanceOf(DrizzleNodeRunRuntimePersistence)
    expect(await native.wrapperRuns.clearReuseDisabled({ nodeRunId: 'missing' })).toBeUndefined()
    expectOriginalWork(f)
  })
})
