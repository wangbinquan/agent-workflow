import type { ProviderNeutralDatabase } from '@/db/query'
import type {
  DynamicWorkflowStateWriter,
  DynamicWorkflowWritePurposes,
} from '../application/ports/dynamicWorkflowPersistence'
import { runWithTaskExecutionContext } from '../application/taskExecutionContext'
import {
  prepareDynamicWorkflowStateWrite,
  writeDynamicWorkflowState,
} from './dynamicWorkflowStateWrite'
import {
  withTaskHostNewWork,
  withTaskHostIssuedAck,
  type TaskHostWriteBinding,
} from './hostExecutionWriteTransaction'
import { captureTaskHostExecutionWrite } from './taskHostExecutionWriteSelection'

/** Two Task-local writers over the same original SQL and Task host binding. */
export function createSelectedDynamicWorkflowWritePurposes(input: {
  readonly db: ProviderNeutralDatabase
  readonly hostWrites: TaskHostWriteBinding
}): DynamicWorkflowWritePurposes {
  const { db, hostWrites: binding } = input
  if (binding === undefined) throw new Error('task-host-write-selection-incomplete')

  function writer(
    write: typeof withTaskHostNewWork | typeof withTaskHostIssuedAck,
  ): DynamicWorkflowStateWriter {
    return Object.freeze({
      async saveState(taskId, state, now = Date.now()) {
        const prepared = prepareDynamicWorkflowStateWrite(taskId, state, now)
        const work = captureTaskHostExecutionWrite(binding, { taskId })
        await write({
          db,
          selection: work.selection,
          body: (tx) =>
            runWithTaskExecutionContext(work.context, async () => {
              await writeDynamicWorkflowState(tx, prepared)
            }),
        })
      },
    } satisfies DynamicWorkflowStateWriter)
  }

  return Object.freeze({
    preparation: writer(withTaskHostNewWork),
    issuedResults: writer(withTaskHostIssuedAck),
  })
}
