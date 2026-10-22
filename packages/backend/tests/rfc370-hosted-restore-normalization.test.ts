// RFC-370 v3 V5 — owner restore normalization after a hosted database restore
// (standalone RFC-213 semantics). Locks: Task Execution suspends every live
// task, interrupts running runs/tasks through the lifecycle kernels and turns
// every unsettled hosted execution into a `restored` cancellation; System
// Operations freezes the restored execution authority, fails the snapshot's
// other building backups and re-adopts the restore source's archive pin. Every
// participant is idempotent because a resumed restore runs it again.
import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import {
  hostedDatabaseBackups,
  hostedExecutionBindings,
  hostedExecutionControl,
  hostedObjectPublications,
  hostedRecoveryRequests,
  nodeRuns,
  tasks,
} from '@/db/schema'
import { HOSTED_BACKUP_OWNER } from '@/modules/system-operations/infrastructure/crewstation/databaseBackupFormat'
import { createHostedSystemRestoreNormalization } from '@/modules/system-operations/infrastructure/crewstation/hostedRestoreNormalization'
import { hostedPublicationId } from '@/modules/system-operations/infrastructure/crewstation/objectPublications'
import { createHostedRestoreTaskNormalization } from '@/modules/task-execution/public/participants'
import { buildLogicalSchemaContract } from '@/bootstrap/persistenceSchema'
import { describeEachProvider } from './helpers/eachProvider'
import { seedRun, seedTask } from './helpers/questionDispatchFixture'

const binding = (executionId: string, taskId: string, state: 'running' | 'settled') => ({
  executionId,
  taskId,
  kind: 'agent' as const,
  businessTaskId: '01a13e6d-3e00-7000-9e3c-0000000000b0',
  requestKey: `request-${executionId}`,
  requestJson: '{}',
  state,
  epoch: 3,
  createdAt: 1,
  updatedAt: 1,
})

describeEachProvider('RFC-370 hosted restore normalization', (harness) => {
  const normalize = (participant: ReturnType<typeof createHostedRestoreTaskNormalization>) =>
    harness.session.transaction((tx) =>
      participant.normalize(tx, { restoreOperationId: 'restore-op', now: 5_000 }),
    )

  test('Task Execution suspends live tasks, interrupts running work and cancels unsettled executions', async () => {
    for (const id of ['t-running', 't-gate', 't-done']) await seedTask(harness.db, id)
    await harness.db.update(tasks).set({ status: 'running' }).where(eq(tasks.id, 't-running'))
    await harness.db.update(tasks).set({ status: 'done' }).where(eq(tasks.id, 't-done'))
    const running = await seedRun(harness.db, 't-running', 'n-running', { status: 'running' })
    const done = await seedRun(harness.db, 't-running', 'n-done', { status: 'done' })
    await harness.db.insert(hostedExecutionBindings).values([
      binding('agent:t-running:a', 't-running', 'running'),
      {
        ...binding('agent:t-running:b', 't-running', 'running'),
        cancelRequested: true,
        cancelReason: 'user',
      },
      binding('agent:t-done:c', 't-done', 'settled'),
    ])
    const recovery = (requestId: string, state: 'executing' | 'succeeded') => ({
      requestId,
      requestJson: '{}',
      businessTaskId: '01a13e6d-3e00-7000-9e3c-0000000000b0',
      taskId: 't-running',
      actorUserId: 'user',
      state,
      epoch: 3,
      createdAt: 1,
      updatedAt: 1,
    })
    await harness.db
      .insert(hostedRecoveryRequests)
      .values([recovery('r-active', 'executing'), recovery('r-done', 'succeeded')])
    const participant = createHostedRestoreTaskNormalization()
    expect(await normalize(participant)).toEqual({
      suspendedTasks: 2,
      interruptedTasks: 1,
      interruptedNodeRuns: 1,
      cancelledBindings: 2,
      failedRecoveryRequests: 1,
    })
    const taskRows = new Map(
      (await harness.db.select().from(tasks)).map((row) => [row.id, row] as const),
    )
    expect(taskRows.get('t-running')).toMatchObject({
      status: 'interrupted',
      autoRecoverySuspended: true,
      finishedAt: 5_000,
    })
    expect(taskRows.get('t-gate')).toMatchObject({
      status: 'awaiting_human',
      autoRecoverySuspended: true,
    })
    expect(taskRows.get('t-done')).toMatchObject({ status: 'done', autoRecoverySuspended: false })
    const runs = new Map(
      (await harness.db.select().from(nodeRuns)).map((row) => [row.id, row.status] as const),
    )
    expect(runs.get(running)).toBe('interrupted')
    expect(runs.get(done)).toBe('done')
    const bindings = new Map(
      (await harness.db.select().from(hostedExecutionBindings)).map(
        (row) => [row.executionId, row] as const,
      ),
    )
    expect(bindings.get('agent:t-running:a')).toMatchObject({
      cancelRequested: true,
      cancelReason: 'restored',
    })
    // No restored run adopts a backup-era execution: an earlier user cancel
    // becomes a restored one too, so boot recovery never resets its run.
    expect(bindings.get('agent:t-running:b')).toMatchObject({ cancelReason: 'restored' })
    // A backup-era platform recovery must not resume a task restore suspended.
    const recoveries = new Map(
      (await harness.db.select().from(hostedRecoveryRequests)).map(
        (row) => [row.requestId, row] as const,
      ),
    )
    expect(recoveries.get('r-active')).toMatchObject({
      state: 'failed',
      reason: 'database-restored',
    })
    expect(recoveries.get('r-done')).toMatchObject({ state: 'succeeded' })
    expect(bindings.get('agent:t-done:c')).toMatchObject({ cancelRequested: false })
    // A resumed restore runs the participant again without further changes.
    expect(await normalize(participant)).toEqual({
      suspendedTasks: 0,
      interruptedTasks: 0,
      interruptedNodeRuns: 0,
      cancelledBindings: 0,
      failedRecoveryRequests: 0,
    })
  })

  test('System Operations freezes authority, fails other building backups and adopts the source archive', async () => {
    const source = '01a13e6d-3e00-7000-9e3c-0000000000a1'
    const other = '01a13e6d-3e00-7000-9e3c-0000000000a2'
    const object = { id: '01a13e6d-3e00-7000-9e3c-0000000000f1', sha256: 'c'.repeat(64), size: 42 }
    await harness.db
      .insert(hostedExecutionControl)
      .values({
        id: 'global',
        epoch: 7,
        owner: 'old',
        phase: 'active',
        leaseId: 'lease',
        expiresAt: 9e12,
        updatedAt: 1,
      })
      .onConflictDoUpdate({
        target: hostedExecutionControl.id,
        set: {
          epoch: 7,
          owner: 'old',
          phase: 'active',
          leaseId: 'lease',
          expiresAt: 9e12,
          updatedAt: 1,
        },
      })
    await harness.db.insert(hostedDatabaseBackups).values([
      {
        id: source,
        epoch: 7,
        kind: 'scheduled',
        state: 'building',
        activeSlot: 'global',
        createdAt: 100,
        updatedAt: 100,
      },
      {
        id: other,
        epoch: 6,
        kind: 'manual',
        state: 'failed',
        activeSlot: null,
        createdAt: 50,
        updatedAt: 50,
      },
    ])
    const participant = createHostedSystemRestoreNormalization({
      object,
      sidecar: {
        format: 'aw-hosted-database-backup-v2',
        backupId: source,
        kind: 'scheduled',
        installation: 'project/service',
        objectSpaceId: '01a13e6d-3e00-7000-9e3c-00000000aaaa',
        keyFingerprint: 'f'.repeat(64),
        createdAt: 100,
        snapshotAt: 120,
        schemaDigest: buildLogicalSchemaContract().digest,
        sourceGenerationId: 'dbg_hosted_restore_test',
        contents: { workflows: 4, skills: 1 },
      },
    })
    const run = () =>
      harness.session.transaction((tx) =>
        participant.normalize(tx, { restoreOperationId: 'restore-op', now: 9_000 }),
      )
    expect(await run()).toEqual({ frozenControl: 1, failedBackups: 0, adoptedBackups: 1 })
    expect(
      (
        await harness.db
          .select()
          .from(hostedExecutionControl)
          .where(eq(hostedExecutionControl.id, 'global'))
      )[0],
    ).toMatchObject({ phase: 'frozen', expiresAt: 0 })
    const rows = new Map(
      (await harness.db.select().from(hostedDatabaseBackups)).map((row) => [row.id, row] as const),
    )
    expect(rows.get(source)).toMatchObject({
      state: 'ready',
      activeSlot: null,
      objectId: object.id,
      sha256: object.sha256,
      sizeBytes: 42,
      snapshotAt: 120,
    })
    expect(rows.get(other)).toMatchObject({ state: 'failed' })
    expect(
      (
        await harness.db
          .select()
          .from(hostedObjectPublications)
          .where(eq(hostedObjectPublications.id, hostedPublicationId(HOSTED_BACKUP_OWNER, source)))
      )[0],
    ).toMatchObject({ state: 'ready', attempt: source, objectId: object.id, createdAt: 120 })
    expect(await run()).toEqual({ frozenControl: 1, failedBackups: 0, adoptedBackups: 1 })
  })
})
