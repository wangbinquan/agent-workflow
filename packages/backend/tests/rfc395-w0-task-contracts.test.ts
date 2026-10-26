// RFC-395 II-b W0: T implements; N/all subordinate writers consume. Locks dormant contracts.
import { describe, expect, expectTypeOf, test } from 'bun:test'
import type { PersistenceTx } from '@/platform/persistence/persistenceDb'
import type { EngineCapabilities } from '@/platform/persistence/capabilities'
import {
  INITIAL_TASK_EXECUTION_GENERATION,
  TASK_EXECUTION_GENERATION_CAUSES,
  initialTaskExecutionGeneration,
  type OpenTaskExecutionGeneration,
  type TaskExecutionGenerationCause,
  type TaskExecutionGenerationsParticipantInTx,
} from '@/modules/task-execution/application/ports/taskExecutionGenerations'
import {
  TASK_AGGREGATE_LOCK_ORDER,
  type TaskAggregateLockCapabilities,
  type TaskAggregateWritePort,
} from '@/modules/task-execution/application/ports/taskAggregateWrite'
import type {
  TaskMountKey,
  TaskMountKeysReaderInTx,
} from '@/modules/task-execution/application/ports/taskMountKeys'

describe('RFC-395 W0 task contracts', () => {
  test('task creation has generation zero with no predecessor or operation identity', () => {
    expect(INITIAL_TASK_EXECUTION_GENERATION).toBe(0)
    expect(initialTaskExecutionGeneration('task-a', 0)).toEqual({
      taskId: 'task-a',
      generationSeq: 0,
      cause: 'task-created',
      previousGenerationSeq: null,
      operationRef: null,
      createdAt: 0,
    })
    const later = initialTaskExecutionGeneration('task-b', 1_729_001_234_567)
    expect(later.taskId).toBe('task-b')
    expect(later.createdAt).toBe(1_729_001_234_567)
    expect(later.generationSeq).toBe(0)
  })

  test('only explicit execution operations advance the logical generation axis', () => {
    expect(TASK_EXECUTION_GENERATION_CAUSES).toEqual([
      'retry',
      'resume',
      'workflow-sync',
      'review-rerun',
      'clarify-rerun',
      'repair',
      'dynamic-workflow-approval',
    ])
    expectTypeOf<
      string extends TaskExecutionGenerationCause ? true : false
    >().toEqualTypeOf<false>()
    expectTypeOf<OpenTaskExecutionGeneration['operationRef']>().toEqualTypeOf<string>()
    expectTypeOf<
      Parameters<TaskExecutionGenerationsParticipantInTx['openGeneration']>
    >().toEqualTypeOf<[PersistenceTx, OpenTaskExecutionGeneration]>()
  })

  test('aggregate acquisition keeps owner fence before task root, subordinate rows, runs and selections', () => {
    expect(TASK_AGGREGATE_LOCK_ORDER).toEqual([
      'task_execution_owners',
      'tasks',
      'task-subordinate-rows',
      'node_runs',
      'node_run_selections',
    ])
    expectTypeOf<Parameters<TaskAggregateWritePort['lockTaskAggregateRoot']>>().toEqualTypeOf<
      [PersistenceTx, string]
    >()
    expectTypeOf<TaskAggregateLockCapabilities['lockAggregateRoot']>().toEqualTypeOf<
      EngineCapabilities['lockAggregateRoot']
    >()
  })

  test('checkpoint keys are a transaction-scoped exact projection without repoIndex aliases', () => {
    expectTypeOf<keyof TaskMountKey>().toEqualTypeOf<'repoKey' | 'ordinal' | 'mountPath'>()
    expectTypeOf<Parameters<TaskMountKeysReaderInTx['list']>>().toEqualTypeOf<
      [PersistenceTx, string]
    >()
    expectTypeOf<Awaited<ReturnType<TaskMountKeysReaderInTx['list']>>>().toEqualTypeOf<
      readonly TaskMountKey[]
    >()
  })
})
