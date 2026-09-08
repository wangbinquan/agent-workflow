// RFC-359 W17: boot-orphan's real composition keeps its historical clock and
// CAS/companion order while both transaction mechanisms share physical steps.
// These cases run against the original writers before the refactor. Existing
// companion-record fields are opaque data; no domain decisions are exercised.
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { canonicalJson } from '@agent-workflow/shared'
import { eq, sql } from 'drizzle-orm'

import { createInMemoryDb, type DbClient } from '@/db/client'
import type { ProviderNeutralDatabase } from '@/db/query'
import {
  committedEventFamilyCutovers,
  committedEvents,
  taskExecutionIntents,
  taskExecutionLineageOperationRecords,
  tasks,
  workflows,
} from '@/db/schema'
import { dbTxSync } from '@/db/txSync'
import { createTaskExecutionPersistence } from '@/modules/task-execution/composition/taskExecutionPersistence'
import { terminalizeTaskExecutionIntentsTx } from '@/modules/task-execution/infrastructure/sqliteTerminalizeExecutionIntent'
import { DrizzleTaskExecutionIntentTerminalPersistence } from '@/modules/task-execution/infrastructure/taskExecutionIntentTerminalPersistence'
import { registerAfterCommitEventPump } from '@/platform/events/committed/runtime'
import { describeEachProvider, type ProviderHarness } from './helpers/eachProvider'
import { MIGRATIONS } from './migration-freeze'

const ID = 'boot-orphan'
const INPUT_NOW = 1_700_000_000_200
const WALL_NOW = INPUT_NOW + 500
const FAILURE = 'boot-fixture-interrupted'

async function seed(db: ProviderNeutralDatabase, state: 'pending' | 'claimed' = 'pending') {
  await db
    .insert(workflows)
    .values({ id: 'workflow-boot', name: 'workflow-boot', definition: '{}' })
  await db.insert(tasks).values({
    id: ID,
    name: ID,
    workflowId: 'workflow-boot',
    workflowSnapshot: '{}',
    workflowVersion: 1,
    repoPath: '/repo',
    worktreePath: '',
    baseBranch: 'main',
    branch: `task/${ID}`,
    status: 'running',
    inputs: '{}',
    startedAt: INPUT_NOW - 1_000,
    runningSince: INPUT_NOW - 100,
    runningMs: 50,
    lifecycleEventRevision: 4,
    executionLineageId: ID,
    lineageSlotPathJson: canonicalJson([
      { stableNodeKey: 'task-root', frozenOccurrenceKey: ID, workflowRevision: 1 },
    ]),
  })
  await db.insert(taskExecutionIntents).values({
    id: 'intent-boot',
    taskId: ID,
    kind: 'recovery',
    state,
    source: 'boot',
    requestHash: 'original-request',
    payloadJson: '{"original":true}',
    executionLineageId: ID,
    continuationSlotKey: 'original-slot',
    slotPathJson: '[]',
    expectedTaskRevision: 4,
    claimedEpoch: state === 'claimed' ? 7 : null,
    claimedAt: state === 'claimed' ? INPUT_NOW - 20 : null,
    createdAt: INPUT_NOW - 100,
    updatedAt: INPUT_NOW - 100,
  })
  await db.insert(taskExecutionLineageOperationRecords).values({
    id: 'record-boot',
    recordKind: 'replay-decision',
    executionLineageId: ID,
    operationFamilyKey: 'original-family',
    operationGeneration: 2,
    requestHash: 'original-request',
    slotPathJson: '[]',
    slotPathDigest: 'original-digest',
    decisionState: 'actor-replay-authorized',
    replayAuthorizationId: 'opaque-original-ref',
    authorizationScopeJson: '{"original":true}',
    actorUserId: 'opaque-original-actor',
    authorizationSource: 'opaque-original-source',
    boundIntentId: 'intent-boot',
    recordRevision: 4,
    createdAt: INPUT_NOW - 100,
    updatedAt: INPUT_NOW - 100,
  })
  await db
    .update(committedEventFamilyCutovers)
    .set({ mode: 'dispatchable', epoch: 7, changedAt: INPUT_NOW, changeRef: 'boot-companion-test' })
    .where(eq(committedEventFamilyCutovers.family, 'task-lifecycle'))
}

async function snapshot(db: ProviderNeutralDatabase) {
  const task = await db.select().from(tasks).where(eq(tasks.id, ID)).get()
  const intent = await db
    .select()
    .from(taskExecutionIntents)
    .where(eq(taskExecutionIntents.id, 'intent-boot'))
    .get()
  const record = await db
    .select()
    .from(taskExecutionLineageOperationRecords)
    .where(eq(taskExecutionLineageOperationRecords.id, 'record-boot'))
    .get()
  if (task === undefined || intent === undefined || record === undefined) {
    throw new Error('boot companion fixture is incomplete')
  }
  return {
    task,
    intent,
    record,
    events: await db.select().from(committedEvents).orderBy(committedEvents.id),
  }
}

function terminalIntent(
  before: Awaited<ReturnType<typeof snapshot>>['intent'],
): Awaited<ReturnType<typeof snapshot>>['intent'] {
  return {
    ...before,
    state: 'failed',
    failureCode: FAILURE,
    completedAt: INPUT_NOW,
    updatedAt: INPUT_NOW,
  }
}

function terminalRecord(
  before: Awaited<ReturnType<typeof snapshot>>['record'],
): Awaited<ReturnType<typeof snapshot>>['record'] {
  return {
    ...before,
    decisionState: 'requires-actor',
    replayAuthorizationId: null,
    authorizationScopeJson: null,
    actorUserId: null,
    authorizationSource: null,
    boundIntentId: null,
    recordRevision: before.recordRevision + 1,
    updatedAt: INPUT_NOW,
  }
}

const bootInput = {
  taskId: ID,
  from: 'running',
  now: INPUT_NOW,
  failureCode: FAILURE,
  errorMessage: 'original boot interruption message',
} satisfies Parameters<
  ReturnType<
    typeof createTaskExecutionPersistence
  >['recoveryAdministration']['interruptBootOrphanTask']
>[0]

async function withWriteTrigger(
  harness: ProviderHarness,
  mode: 'observe-order' | 'skip-intent' | 'skip-record',
  run: () => Promise<void>,
) {
  const exclusive = harness.capabilities.isolation === 'exclusive'
  const table =
    mode === 'skip-record' ? 'task_execution_lineage_operation_records' : 'task_execution_intents'
  const trigger = 'rfc359_boot_companion_write'
  const observationTable = 'rfc359_boot_companion_observations'
  try {
    if (mode === 'observe-order') {
      await harness.executeFixtureDdl(
        `CREATE TABLE ${observationTable} (task_status text NOT NULL)`,
      )
    }
    const statement =
      mode === 'observe-order'
        ? `INSERT INTO ${observationTable} SELECT status FROM tasks WHERE id = NEW.task_id;`
        : ''
    if (exclusive) {
      await harness.executeFixtureDdl(`CREATE TRIGGER ${trigger}
        ${mode === 'observe-order' ? 'AFTER' : 'BEFORE'} UPDATE ON ${table}
        BEGIN ${mode === 'observe-order' ? statement : 'SELECT RAISE(IGNORE);'} END;`)
    } else {
      await harness.executeFixtureDdl(`CREATE FUNCTION ${trigger}() RETURNS trigger AS $$
        BEGIN ${statement} RETURN ${mode === 'observe-order' ? 'NEW' : 'NULL'}; END;
        $$ LANGUAGE plpgsql;`)
      await harness.executeFixtureDdl(`CREATE TRIGGER ${trigger}
        ${mode === 'observe-order' ? 'AFTER' : 'BEFORE'} UPDATE ON ${table}
        FOR EACH ROW EXECUTE FUNCTION ${trigger}();`)
    }
    await run()
  } finally {
    await harness.executeFixtureDdl(
      exclusive
        ? `DROP TRIGGER IF EXISTS ${trigger}`
        : `DROP TRIGGER IF EXISTS ${trigger} ON ${table}`,
    )
    if (!exclusive) await harness.executeFixtureDdl(`DROP FUNCTION IF EXISTS ${trigger}()`)
    if (mode === 'observe-order')
      await harness.executeFixtureDdl(`DROP TABLE IF EXISTS ${observationTable}`)
  }
}

describeEachProvider(
  'RFC-359 boot-orphan complete composition keeps mechanism contracts',
  (harness) => {
    beforeEach(async () => {
      await seed(harness.db)
    })
    afterEach(() => {
      registerAfterCommitEventPump(null)
    })

    test('keeps its own accounting clock, companion phase and post-commit publication', async () => {
      const before = await snapshot(harness.db)
      const publications: Awaited<ReturnType<typeof snapshot>>[] = []
      registerAfterCommitEventPump({
        async publishNow() {
          publications.push(await snapshot(harness.db))
        },
        nudge() {},
      })
      await withWriteTrigger(harness, 'observe-order', async () => {
        const clock = spyOn(Date, 'now').mockReturnValue(WALL_NOW)
        try {
          const won = await createTaskExecutionPersistence(
            harness.db,
          ).recoveryAdministration.interruptBootOrphanTask(bootInput)
          expect(won).toBe(true)
        } finally {
          clock.mockRestore()
        }
        const after = await snapshot(harness.db)
        const sampledAt = harness.capabilities.isolation === 'exclusive' ? WALL_NOW : INPUT_NOW
        expect(after.task).toEqual({
          ...before.task,
          status: 'interrupted',
          runningSince: null,
          runningMs: 50 + sampledAt - (INPUT_NOW - 100),
          finishedAt: INPUT_NOW,
          errorSummary: FAILURE,
          errorMessage: bootInput.errorMessage,
          lifecycleEventRevision: 5,
        })
        expect(after.intent).toEqual(terminalIntent(before.intent))
        expect(after.record).toEqual(terminalRecord(before.record))
        expect(after.events).toHaveLength(1)
        expect(JSON.parse(after.events[0]!.payloadJson)).toMatchObject({
          eventId: `task-lifecycle:${ID}:5`,
          occurredAt: new Date(sampledAt).toISOString(),
          payload: {
            taskId: ID,
            lifecycleRevision: 5,
            previousStatus: 'running',
            status: 'interrupted',
          },
        })
        expect(
          await harness.db.all(sql`SELECT task_status FROM rfc359_boot_companion_observations`),
        ).toEqual([
          {
            task_status: harness.capabilities.isolation === 'exclusive' ? 'interrupted' : 'running',
          },
        ])
        expect(publications).toEqual([after])
      })
    })

    test('a status-gate miss returns false without touching companion rows or publishing', async () => {
      const before = await snapshot(harness.db)
      let published = false
      registerAfterCommitEventPump({
        async publishNow() {
          published = true
        },
        nudge() {},
      })
      expect(
        await createTaskExecutionPersistence(
          harness.db,
        ).recoveryAdministration.interruptBootOrphanTask({ ...bootInput, from: 'pending' }),
      ).toBe(false)
      expect(await snapshot(harness.db)).toEqual(before)
      expect(published).toBe(false)
    })

    test.each(['skip-intent', 'skip-record'] as const)(
      '%s retains the existing returned-row branch',
      async (mode) => {
        const before = await snapshot(harness.db)
        await withWriteTrigger(harness, mode, async () => {
          const operation = () =>
            createTaskExecutionPersistence(
              harness.db,
            ).recoveryAdministration.interruptBootOrphanTask(bootInput)
          if (harness.capabilities.isolation === 'exclusive') {
            expect(await operation()).toBe(true)
            const after = await snapshot(harness.db)
            expect(after.task.status).toBe('interrupted')
            expect(after.intent).toEqual(
              mode === 'skip-intent' ? before.intent : terminalIntent(before.intent),
            )
            expect(after.record).toEqual(
              mode === 'skip-record' ? before.record : terminalRecord(before.record),
            )
            expect(after.events).toHaveLength(1)
          } else {
            await expect(operation()).rejects.toMatchObject({
              code: 'task-continuation-stale',
              message:
                mode === 'skip-intent'
                  ? `task '${ID}' active intents changed during terminalization`
                  : "replay decision 'record-boot' changed during intent terminalization",
            })
            expect(await snapshot(harness.db)).toEqual(before)
          }
        })
      },
    )

    test.each(['skip-intent', 'skip-record'] as const)(
      'the asynchronous companion retains its strict %s check on both engines',
      async (mode) => {
        const before = await snapshot(harness.db)
        await withWriteTrigger(harness, mode, async () => {
          const terminal = new DrizzleTaskExecutionIntentTerminalPersistence(harness.db)
          await expect(
            terminal.terminalize({
              taskId: ID,
              state: 'failed',
              failureCode: FAILURE,
              now: INPUT_NOW,
            }),
          ).rejects.toMatchObject({
            code: 'task-continuation-stale',
            message:
              mode === 'skip-intent'
                ? `task '${ID}' active intents changed during terminalization`
                : "replay decision 'record-boot' changed during intent terminalization",
          })
          expect(await snapshot(harness.db)).toEqual(before)
        })
      },
    )
  },
)

describe('RFC-359 native boot companion remains synchronous', () => {
  let db: DbClient
  beforeEach(async () => {
    db = createInMemoryDb(MIGRATIONS)
    await seed(db, 'claimed')
  })
  afterEach(() => {
    db.$client.close()
  })

  test('returns void after physical writes and preserves epoch selection and complete row projection', async () => {
    const before = await snapshot(db)
    const result = dbTxSync(db, (tx) =>
      terminalizeTaskExecutionIntentsTx({
        tx,
        taskId: ID,
        state: 'failed',
        failureCode: FAILURE,
        now: INPUT_NOW,
        claimedOwnerEpoch: 6,
      }),
    )
    expect(result).toBeUndefined()
    expect(await snapshot(db)).toEqual(before)
    const committed = dbTxSync(db, (tx) => {
      const value: void = terminalizeTaskExecutionIntentsTx({
        tx,
        taskId: ID,
        state: 'failed',
        failureCode: FAILURE,
        now: INPUT_NOW,
        claimedOwnerEpoch: 7,
      })
      expect(tx.select().from(taskExecutionIntents).get()).toEqual(terminalIntent(before.intent))
      expect(tx.select().from(taskExecutionLineageOperationRecords).get()).toEqual(
        terminalRecord(before.record),
      )
      return value
    })
    expect(committed).toBeUndefined()
    const after = await snapshot(db)
    expect(after.task).toEqual(before.task)
    expect(after.intent).toEqual(terminalIntent(before.intent))
    expect(after.record).toEqual(terminalRecord(before.record))
    expect(after.events).toEqual([])
  })

  test('an outer synchronous transaction rolls back all companion rows and retains its error', async () => {
    const before = await snapshot(db)
    const sentinel = new Error('outer boot recovery transaction failed')
    expect(() =>
      dbTxSync(db, (tx) => {
        terminalizeTaskExecutionIntentsTx({
          tx,
          taskId: ID,
          state: 'failed',
          failureCode: FAILURE,
          now: INPUT_NOW,
        })
        throw sentinel
      }),
    ).toThrow(sentinel)
    expect(await snapshot(db)).toEqual(before)
  })
})
