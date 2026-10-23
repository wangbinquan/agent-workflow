import { and, asc, eq, inArray } from 'drizzle-orm'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { tablesOf } from '@/platform/persistence/sessionTables'
import type { NodeOutputQueries } from '../application/ports/nodeOutputQueries'

export function createNodeOutputQueries(db: PersistenceDb): NodeOutputQueries {
  const { nodeRunOutputs } = tablesOf(db)
  const content = {
    nodeRunId: nodeRunOutputs.nodeRunId,
    portName: nodeRunOutputs.portName,
    content: nodeRunOutputs.content,
    kind: nodeRunOutputs.kind,
    archiveJson: nodeRunOutputs.archiveJson,
  }
  return {
    async listProducedPorts(runIds) {
      if (runIds.length === 0) return []
      return db
        .select({ nodeRunId: nodeRunOutputs.nodeRunId, portName: nodeRunOutputs.portName })
        .from(nodeRunOutputs)
        .where(inArray(nodeRunOutputs.nodeRunId, [...runIds]))
    },
    async readPort(runId, portName, activeOnly = false) {
      return (
        (
          await db
            .select(content)
            .from(nodeRunOutputs)
            .where(
              and(
                eq(nodeRunOutputs.nodeRunId, runId),
                eq(nodeRunOutputs.portName, portName),
                activeOnly ? eq(nodeRunOutputs.active, true) : undefined,
              ),
            )
            .limit(1)
        )[0] ?? null
      )
    },
    async listPorts(runId) {
      return (
        await db
          .select({ portName: nodeRunOutputs.portName })
          .from(nodeRunOutputs)
          .where(eq(nodeRunOutputs.nodeRunId, runId))
      ).map((row) => row.portName)
    },
    async runsWithOutput(runIds) {
      if (runIds.length === 0) return new Set()
      return new Set(
        (
          await db
            .select({ nodeRunId: nodeRunOutputs.nodeRunId })
            .from(nodeRunOutputs)
            .where(inArray(nodeRunOutputs.nodeRunId, [...runIds]))
        ).map((row) => row.nodeRunId),
      )
    },
    async listActiveContents(runIds) {
      if (runIds.length === 0) return []
      return db
        .select(content)
        .from(nodeRunOutputs)
        .where(and(inArray(nodeRunOutputs.nodeRunId, [...runIds]), eq(nodeRunOutputs.active, true)))
        .orderBy(asc(nodeRunOutputs.nodeRunId), asc(nodeRunOutputs.portName))
    },
  }
}
