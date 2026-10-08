import type { ProviderNeutralDatabase } from '@/db/query'
import type { NodeExecutionPersistence } from '../application/ports/nodeExecutionPersistence'
import type { NodeRunLifecyclePersistence } from '../application/ports/nodeRunLifecyclePersistence'
import type { TaskNodeWritePurposes } from '../application/ports/taskNodeWritePurposes'
import { runWithTaskExecutionContext } from '../application/taskExecutionContext'
import {
  withTaskHostNewWork,
  withTaskHostIssuedAck,
  type TaskHostWriteBinding,
} from './hostExecutionWriteTransaction'
import {
  captureTaskHostExecutionWrite,
  type TaskHostExecutionWriteSelection,
} from './taskHostExecutionWriteSelection'

type SelectedWrite = <T>(
  work: TaskHostExecutionWriteSelection,
  body: () => Promise<T>,
) => Promise<T>

/** Task-only purpose views over the same complete native Node instances. */
export function createSelectedTaskNodeWritePurposes(input: {
  readonly db: ProviderNeutralDatabase
  readonly hostWrites: TaskHostWriteBinding
  readonly nodeRuns: NodeRunLifecyclePersistence
  readonly nodeExecution: NodeExecutionPersistence
}): TaskNodeWritePurposes {
  const { db, hostWrites: binding, nodeRuns, nodeExecution } = input
  if (binding === undefined) throw new Error('task-host-write-selection-incomplete')
  const mint = nodeRuns.mint
  const transition = nodeRuns.transition
  const set = nodeRuns.set
  const loadEnvelopeNonce = nodeRuns.loadEnvelopeNonce
  const read = nodeExecution.read
  const list = nodeExecution.list
  const listOutputs = nodeExecution.listOutputs
  const countAgentTextEvents = nodeExecution.countAgentTextEvents
  const readStderr = nodeExecution.readStderr
  const patch = nodeExecution.patch
  const upsertOutputs = nodeExecution.upsertOutputs
  const replaceOutputs = nodeExecution.replaceOutputs
  const appendEvent = nodeExecution.appendEvent
  const appendEvents = nodeExecution.appendEvents
  const retagSessionEpochs = nodeExecution.retagSessionEpochs

  function preparation<T>(
    work: TaskHostExecutionWriteSelection,
    body: () => Promise<T>,
  ): Promise<T> {
    return withTaskHostNewWork({
      db,
      selection: work.selection,
      body: () => runWithTaskExecutionContext(work.context, body),
    })
  }

  function issuedResults<T>(
    work: TaskHostExecutionWriteSelection,
    body: () => Promise<T>,
  ): Promise<T> {
    return withTaskHostIssuedAck({
      db,
      selection: work.selection,
      body: () => runWithTaskExecutionContext(work.context, body),
    })
  }

  function execution(write: SelectedWrite): NodeExecutionPersistence {
    return Object.freeze({
      async read(nodeRunId) {
        return await read.call(nodeExecution, nodeRunId)
      },
      async list(query) {
        return await list.call(nodeExecution, query)
      },
      async listOutputs(nodeRunId) {
        return await listOutputs.call(nodeExecution, nodeRunId)
      },
      async countAgentTextEvents(nodeRunId, frameworkPrefix) {
        return await countAgentTextEvents.call(nodeExecution, nodeRunId, frameworkPrefix)
      },
      async readStderr(nodeRunId) {
        return await readStderr.call(nodeExecution, nodeRunId)
      },
      async patch(projection) {
        const work = captureTaskHostExecutionWrite(binding, projection)
        return await write(work, () => patch.call(nodeExecution, projection))
      },
      async upsertOutputs(outputs) {
        if (outputs.outputs.length === 0) return await upsertOutputs.call(nodeExecution, outputs)
        const work = captureTaskHostExecutionWrite(binding, outputs)
        return await write(work, () => upsertOutputs.call(nodeExecution, outputs))
      },
      async replaceOutputs(outputs) {
        const work = captureTaskHostExecutionWrite(binding, outputs)
        return await write(work, () => replaceOutputs.call(nodeExecution, outputs))
      },
      async appendEvent(event) {
        const work = captureTaskHostExecutionWrite(binding, event)
        return await write(work, () => appendEvent.call(nodeExecution, event))
      },
      async appendEvents(chunk) {
        if (chunk.events.length === 0 && !chunk.observations?.length)
          return await appendEvents.call(nodeExecution, chunk)
        const work = captureTaskHostExecutionWrite(binding, chunk)
        return await write(work, () => appendEvents.call(nodeExecution, chunk))
      },
      async retagSessionEpochs(epochs) {
        if (epochs.supersededSessionIds.length === 0)
          return await retagSessionEpochs.call(nodeExecution, epochs)
        const work = captureTaskHostExecutionWrite(binding, epochs)
        return await write(work, () => retagSessionEpochs.call(nodeExecution, epochs))
      },
    } satisfies NodeExecutionPersistence)
  }

  function lifecycle(write: SelectedWrite): Omit<NodeRunLifecyclePersistence, 'mint'> {
    return Object.freeze({
      async transition(change) {
        const work = captureTaskHostExecutionWrite(binding, change)
        return await write(work, () => transition.call(nodeRuns, change))
      },
      async set(change) {
        const work = captureTaskHostExecutionWrite(binding, change)
        return await write(work, () => set.call(nodeRuns, change))
      },
      async loadEnvelopeNonce(nodeRunId) {
        return await loadEnvelopeNonce.call(nodeRuns, nodeRunId)
      },
    } satisfies Omit<NodeRunLifecyclePersistence, 'mint'>)
  }

  return Object.freeze({
    preparation: Object.freeze({
      nodeRuns: Object.freeze({
        ...lifecycle(preparation),
        async mint(request) {
          const work = captureTaskHostExecutionWrite(binding, request)
          return await preparation(work, () => mint.call(nodeRuns, request))
        },
      } satisfies NodeRunLifecyclePersistence),
      nodeExecution: execution(preparation),
    }),
    issuedResults: Object.freeze({
      nodeRuns: lifecycle(issuedResults),
      nodeExecution: execution(issuedResults),
    }),
  })
}
