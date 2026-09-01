import type { DbClient } from '@/db/client'
import { runWorkgroupEngine } from '@/services/workgroup/engine'
import type { WorkgroupTurnsOperations } from '../application/ports/workgroupTurnsOperations'

/** SQLite compatibility binding for the Resource Catalog turn ledger. */
export function createSqliteWorkgroupTurnsOperations(db: DbClient): WorkgroupTurnsOperations {
  return Object.freeze({
    async drive(input: Parameters<WorkgroupTurnsOperations['drive']>[0]) {
      return await runWorkgroupEngine({
        db,
        taskId: input.taskId,
        log: input.log,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        hooks: {
          runHostNode: async (request) => {
            const result = await input.host.runHost({
              ...request,
              ...(request.hostOutputPorts === undefined
                ? {}
                : { hostOutputPorts: [...request.hostOutputPorts] }),
            })
            return { ...result, outputs: { ...result.outputs } }
          },
          ...(input.host.broadcastNodeStatus === undefined
            ? {}
            : { broadcastNodeStatus: input.host.broadcastNodeStatus }),
          ...(input.host.getCanonicalFilesChanged === undefined
            ? {}
            : { getCanonicalFilesChanged: input.host.getCanonicalFilesChanged }),
        },
      })
    },
  })
}
