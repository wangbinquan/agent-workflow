import type { ProviderNeutralDatabase } from '@/db/query'
import type { NodeRunRuntimePersistence } from '../application/ports/nodeRunRuntimePersistence'
import { runWithTaskExecutionContext } from '../application/taskExecutionContext'
import { withTaskHostNewWork, type TaskHostWriteBinding } from './hostExecutionWriteTransaction'
import { captureTaskHostExecutionWrite } from './taskHostExecutionWriteSelection'

/** Runtime selection and freezing prepare the next dispatch under the original Task work. */
export function createSelectedTaskNodeRunRuntimePersistence(input: {
  readonly db: ProviderNeutralDatabase
  readonly hostWrites: TaskHostWriteBinding
  readonly persistence: NodeRunRuntimePersistence
}): NodeRunRuntimePersistence {
  const { db, hostWrites: binding, persistence } = input
  if (binding === undefined) throw new Error('task-host-write-selection-incomplete')
  const withSelection = persistence.withSelection.bind(persistence)
  const load = persistence.load
  const findBySessionId = persistence.findBySessionId
  const freeze = persistence.freeze

  return Object.freeze({
    async withSelection(nodeRunId, body) {
      const work = captureTaskHostExecutionWrite(binding)
      return await withTaskHostNewWork({
        db,
        selection: work.selection,
        body: () => runWithTaskExecutionContext(work.context, () => withSelection(nodeRunId, body)),
      })
    },
    async load(nodeRunId) {
      return await load.call(persistence, nodeRunId)
    },
    async findBySessionId(sessionId) {
      return await findBySessionId.call(persistence, sessionId)
    },
    async freeze(snapshot) {
      const work = captureTaskHostExecutionWrite(binding)
      return await withTaskHostNewWork({
        db,
        selection: work.selection,
        body: () =>
          runWithTaskExecutionContext(work.context, () => freeze.call(persistence, snapshot)),
      })
    },
  } satisfies NodeRunRuntimePersistence)
}
