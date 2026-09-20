// RFC-363 T2: durable preparation facts, atomic rollback and terminal ownership.
// These are real provider writes; recreating a repository must not lose its receipts.
import { expect, test } from 'bun:test'
import { ulid } from 'ulid'
import { tasks } from '@/db/schema'
import { createRepositoryPreparationJournal } from '@/modules/source-control/infrastructure/repositoryPreparationJournal'
import { createWorkspacePreparationJournal } from '@/modules/task-execution/infrastructure/workspacePreparationJournal'
import { describeEachProvider } from './helpers/eachProvider'

describeEachProvider('RFC-363 preparation journals', (harness) => {
  function source() {
    return {
      id: ulid(),
      requestKey: ulid(),
      requestDigest: 'request-1',
      kind: 'repository' as const,
      factsJson: '{"version":1,"repository":"repo-1"}',
      createdAt: 1,
    }
  }

  async function operation() {
    const journal = createRepositoryPreparationJournal(harness.db)
    const sealed = await journal.seal(source())
    const frozen = await journal.freeze({
      id: ulid(),
      sourceRef: sealed.id,
      revision: 'content-1',
      factsJson: '{"version":1,"base":"main"}',
      createdAt: 2,
    })
    const op = await journal.plan({ id: ulid(), snapshotRef: frozen.id, now: 3 })
    return { journal, sealed, frozen, op }
  }

  test('admission rollback removes source, snapshot, operation and task plan together', async () => {
    const sealed = source()
    const snapshotId = ulid(),
      operationId = ulid(),
      planId = ulid()
    await expect(
      harness.session.transaction(async (tx) => {
        const journal = createRepositoryPreparationJournal(tx)
        await journal.seal(sealed)
        await journal.freeze({
          id: snapshotId,
          sourceRef: sealed.id,
          revision: 'v1',
          factsJson: '{}',
          createdAt: 1,
        })
        await journal.plan({ id: operationId, snapshotRef: snapshotId, now: 1 })
        await createWorkspacePreparationJournal(tx).prepare({
          id: planId,
          admissionKey: 'request-1',
          requestDigest: 'digest-1',
          lane: 'repository-preparation',
          operationRef: operationId,
          ownerFence: 1,
          now: 1,
        })
        throw new Error('admission-rollback')
      }),
    ).rejects.toThrow('admission-rollback')
    const reopened = createRepositoryPreparationJournal(harness.db)
    expect(await reopened.source(sealed.id)).toBeNull()
    expect(await reopened.snapshot(snapshotId)).toBeNull()
    expect(await reopened.operation(operationId)).toBeNull()
    expect(await createWorkspacePreparationJournal(harness.db).read(planId)).toBeNull()
    expect(await harness.db.select().from(tasks)).toEqual([])
  })

  test('source request replay returns the durable identity and rejects changed input', async () => {
    const input = source()
    const journal = createRepositoryPreparationJournal(harness.db)
    await journal.seal(input)
    expect(
      await createRepositoryPreparationJournal(harness.db).seal({
        ...input,
        id: ulid(),
        createdAt: 9,
      }),
    ).toEqual(input)
    await expect(
      journal.seal({ ...input, id: ulid(), requestDigest: 'changed' }),
    ).rejects.toMatchObject({ code: 'repository-source-request-mismatch' })
  })

  test('only one contender advances an operation and the losing version cannot replace commits', async () => {
    const { journal, op } = await operation()
    const attempts = await Promise.all(
      [1, 2].map((now) =>
        journal.advance({ id: op.id, from: 'planned', to: 'resolving', expectedVersion: 0, now }),
      ),
    )
    expect(attempts.filter(Boolean)).toHaveLength(1)
    await journal.advance({
      id: op.id,
      from: 'resolving',
      to: 'materializing',
      expectedVersion: 1,
      resolvedJson: '{"commits":["abc"]}',
      now: 3,
    })
    expect(
      await journal.advance({
        id: op.id,
        from: 'resolving',
        to: 'materializing',
        expectedVersion: 1,
        resolvedJson: '{"commits":["other"]}',
        now: 4,
      }),
    ).toBeNull()
    expect(
      (await createRepositoryPreparationJournal(harness.db).operation(op.id))?.resolvedJson,
    ).toBe('{"commits":["abc"]}')
  })

  test('prepared receipt survives repository recreation and cleanup cannot rewrite its physical facts', async () => {
    const { journal, op } = await operation()
    await journal.advance({
      id: op.id,
      from: 'planned',
      to: 'resolving',
      expectedVersion: 0,
      now: 4,
    })
    await journal.advance({
      id: op.id,
      from: 'resolving',
      to: 'materializing',
      expectedVersion: 1,
      resolvedJson: '{"commits":["abc"]}',
      now: 5,
    })
    await journal.advance({
      id: op.id,
      from: 'materializing',
      to: 'prepared',
      expectedVersion: 2,
      receiptRef: 'receipt-1',
      receiptJson: '{"workspace":"w1"}',
      now: 6,
    })
    const reopened = createRepositoryPreparationJournal(harness.db)
    expect(await reopened.plan({ id: op.id, snapshotRef: op.snapshotRef, now: 7 })).toMatchObject({
      state: 'prepared',
      version: 3,
      receiptRef: 'receipt-1',
      receiptJson: '{"workspace":"w1"}',
    })
    await expect(
      reopened.advance({
        id: op.id,
        from: 'prepared',
        to: 'cleaned',
        expectedVersion: 3,
        receiptJson: '{}',
        now: 8,
      }),
    ).rejects.toMatchObject({ code: 'repository-preparation-facts-immutable' })
    expect(
      await reopened.advance({
        id: op.id,
        from: 'prepared',
        to: 'cleaned',
        expectedVersion: 3,
        now: 8,
      }),
    ).toMatchObject({ state: 'cleaned', receiptRef: 'receipt-1' })
    await expect(
      reopened.advance({ id: op.id, from: 'cleaned', to: 'resolving', expectedVersion: 4, now: 9 }),
    ).rejects.toMatchObject({ code: 'repository-preparation-transition-invalid' })
  })

  test('a successful operation cannot be rebound to a different snapshot', async () => {
    const { journal, op } = await operation()
    await expect(
      journal.plan({ id: op.id, snapshotRef: 'different-snapshot', now: 9 }),
    ).rejects.toMatchObject({ code: 'repository-preparation-source-mismatch' })
  })

  test('upload preparation creates no Task and only its current owner can bind the artifact', async () => {
    const journal = createWorkspacePreparationJournal(harness.db)
    const input = {
      id: ulid(),
      admissionKey: 'upload-request',
      requestDigest: 'upload-digest',
      lane: 'pre-materialized' as const,
      operationRef: null,
      ownerFence: 3,
      now: 1,
    }
    await journal.prepare(input)
    expect(await harness.db.select().from(tasks)).toEqual([])
    await journal.advance({
      id: input.id,
      from: 'preparing',
      to: 'prepared',
      ownerFence: 3,
      expectedVersion: 0,
      artifactJson: '{"uploads":["a.txt"]}',
      now: 2,
    })
    expect(
      await journal.advance({
        id: input.id,
        from: 'prepared',
        to: 'admitted',
        ownerFence: 2,
        expectedVersion: 1,
        admittedTaskId: 'task-1',
        now: 3,
      }),
    ).toBeNull()
    expect(
      await journal.advance({
        id: input.id,
        from: 'prepared',
        to: 'admitted',
        ownerFence: 3,
        expectedVersion: 1,
        admittedTaskId: 'task-1',
        now: 3,
      }),
    ).toMatchObject({ state: 'admitted', admittedTaskId: 'task-1' })
    await expect(
      journal.advance({
        id: input.id,
        from: 'admitted',
        to: 'compensating',
        ownerFence: 3,
        expectedVersion: 2,
        now: 4,
      }),
    ).rejects.toMatchObject({ code: 'workspace-preparation-transition-invalid' })
    expect(
      await createWorkspacePreparationJournal(harness.db).prepare({ ...input, id: ulid(), now: 5 }),
    ).toMatchObject({ id: input.id, state: 'admitted' })
  })
})
