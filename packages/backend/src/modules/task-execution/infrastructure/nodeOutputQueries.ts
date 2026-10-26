import { databaseContentText } from '@/platform/content/infrastructure/contentStore'
import { and, asc, eq, inArray } from 'drizzle-orm'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { tablesOf } from '@/platform/persistence/sessionTables'
import type { NodeOutputQueries } from '../application/ports/nodeOutputQueries'

export function createNodeOutputQueries(db: PersistenceDb): NodeOutputQueries {
  const { nodeRunOutputs } = tablesOf(db)
  const content = {
    nodeRunId: nodeRunOutputs.nodeRunId,
    portName: nodeRunOutputs.portName,
    contentRefJson: nodeRunOutputs.contentRefJson,
    contentInlineBytes: nodeRunOutputs.contentInlineBytes,
    kind: nodeRunOutputs.kind,
    archiveJson: nodeRunOutputs.archiveJson,
  }
  const project = async (row: {
    nodeRunId: string
    portName: string
    contentRefJson: string
    contentInlineBytes: Uint8Array | null
    kind: string | null
    archiveJson: string | null
  }) => ({
    nodeRunId: row.nodeRunId,
    portName: row.portName,
    kind: row.kind,
    archiveJson: row.archiveJson,
    content: await databaseContentText(db, row),
  })
  return {
    async listProducedPorts(runIds) {
      if (runIds.length === 0) return []
      return db
        .select({ nodeRunId: nodeRunOutputs.nodeRunId, portName: nodeRunOutputs.portName })
        .from(nodeRunOutputs)
        .where(inArray(nodeRunOutputs.nodeRunId, [...runIds]))
    },
    async readPort(runId, portName, activeOnly = false) {
      const row =
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
      return row === null ? null : project(row)
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
      const rows = await db
        .select(content)
        .from(nodeRunOutputs)
        .where(and(inArray(nodeRunOutputs.nodeRunId, [...runIds]), eq(nodeRunOutputs.active, true)))
        .orderBy(asc(nodeRunOutputs.nodeRunId), asc(nodeRunOutputs.portName))
      return Promise.all(rows.map(project))
    },
  }
}
