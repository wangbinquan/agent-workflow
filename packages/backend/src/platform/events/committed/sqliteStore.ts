// Native synchronous callers keep their existing DbTxSync boundary.
// Append SQL and decisions live in appendProgram; the native cutover CAS stays here.

import { and, eq } from 'drizzle-orm'

import { committedEventFamilyCutovers } from '@/db/schema'
import type { DbTxSync } from '@/db/txSync'
import {
  driveSyncProgram,
  executeTransactionStepSync,
} from '@/platform/persistence/transactionProgram'
import { appendCommittedEventProgram, readCommittedEventCutoverProgram } from './appendProgram'
import { assertPositiveInteger, assertProducerFamily } from './appendShared'
import type {
  AppendCommittedEventInput,
  AppendCommittedEventReceipt,
  CommittedEventCutover,
  CommittedEventFamily,
  CommittedEventProducer,
} from './types'

function changed(result: unknown): number {
  return (result as { changes?: number }).changes ?? 0
}

export function readCommittedEventCutoverTx(
  tx: DbTxSync,
  producer: CommittedEventProducer,
  family: CommittedEventFamily,
): CommittedEventCutover {
  return driveSyncProgram(
    readCommittedEventCutoverProgram(tx, producer, family),
    executeTransactionStepSync,
  )
}

export function changeCommittedEventCutoverTx(
  tx: DbTxSync,
  input: Readonly<{
    producer: CommittedEventProducer
    family: CommittedEventFamily
    expectedMode: CommittedEventCutover['mode']
    expectedEpoch: number
    mode: CommittedEventCutover['mode']
    changedAt: number
    changeRef: string
  }>,
): CommittedEventCutover {
  assertProducerFamily(input.producer, input.family)
  assertPositiveInteger(input.expectedEpoch, 'expectedEpoch')
  if (
    !Number.isSafeInteger(input.changedAt) ||
    input.changedAt < 0 ||
    input.changeRef.length === 0
  ) {
    throw new Error('committed event cutover change requires time and durable ref')
  }
  const result = tx
    .update(committedEventFamilyCutovers)
    .set({
      mode: input.mode,
      epoch: input.expectedEpoch + 1,
      changedAt: input.changedAt,
      changeRef: input.changeRef,
    })
    .where(
      and(
        eq(committedEventFamilyCutovers.producer, input.producer),
        eq(committedEventFamilyCutovers.family, input.family),
        eq(committedEventFamilyCutovers.mode, input.expectedMode),
        eq(committedEventFamilyCutovers.epoch, input.expectedEpoch),
      ),
    )
    .run()
  if (changed(result) !== 1) {
    throw new Error(
      `committed event cutover changed concurrently: ${input.producer}/${input.family}`,
    )
  }
  return readCommittedEventCutoverTx(tx, input.producer, input.family)
}

export function appendCommittedEventTx<TType extends string, TPayload>(
  tx: DbTxSync,
  input: AppendCommittedEventInput<TType, TPayload>,
): AppendCommittedEventReceipt {
  return driveSyncProgram(
    // The incoming native transaction already holds the SQLite writer.
    appendCommittedEventProgram(tx, input, () => {}),
    executeTransactionStepSync,
  )
}
