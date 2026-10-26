import { contentRefColumns, type ContentStore } from '@/platform/content/contentStore'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { sha256Hex } from '@/util/hash'
import { and, eq } from 'drizzle-orm'
import type { EmployeeExecutionArtifactQueries } from '../public/types'
import { taskReadColumns } from './taskRepositorySql'

export function createEmployeeExecutionArtifactQueries(
  db: PersistenceDb,
  contents: Pick<ContentStore, 'read'>,
): EmployeeExecutionArtifactQueries {
  return {
    async read(input) {
      const { nodeRuns } = tablesOf(db)
      const { nodeRunOutputs } = tablesOf(db)
      const { tasks } = tablesOf(db)
      const row = (
        await db
          .select({
            caseId: taskReadColumns(db).digitalEmployeeCaseId,
            roundRef: taskReadColumns(db).digitalEmployeeRoundId,
            status: tasks.status,
            workflowSnapshot: taskReadColumns(db).workflowSnapshot,
          })
          .from(tasks)
          .where(eq(tasks.id, input.executionRef))
          .limit(1)
      )[0]
      if (!row || row.caseId !== input.caseId || !row.roundRef) return null
      // Progress needs committed node outputs while the Task is still running or
      // awaiting a human; the terminal outcome read model intentionally omits them.
      const runs = await db
        .select({ id: nodeRuns.id, nodeId: nodeRuns.nodeId })
        .from(nodeRuns)
        .where(eq(nodeRuns.taskId, input.executionRef))
      const outputs = await db
        .select({
          nodeRunId: nodeRunOutputs.nodeRunId,
          portName: nodeRunOutputs.portName,
          contentRefJson: nodeRunOutputs.contentRefJson,
          contentInlineBytes: nodeRunOutputs.contentInlineBytes,
        })
        .from(nodeRunOutputs)
        .innerJoin(nodeRuns, eq(nodeRunOutputs.nodeRunId, nodeRuns.id))
        .where(
          and(
            eq(nodeRuns.taskId, input.executionRef),
            eq(nodeRuns.status, 'done'),
            eq(nodeRunOutputs.active, true),
          ),
        )
      const definition = JSON.parse(row.workflowSnapshot ?? '{}') as {
        nodes?: { id: string; kind: string }[]
      }
      const reviewNodes = new Set(
        definition.nodes?.filter((node) => node.kind === 'review').map((node) => node.id),
      )
      return {
        taskId: input.executionRef,
        roundRef: row.roundRef,
        status: row.status,
        artifacts: await Promise.all(
          outputs.map(async (output) => {
            const ref = contentRefColumns.decode(output.contentRefJson, output.contentInlineBytes)
            if (ref === null) throw new Error('node-output-content-missing')
            const content = new TextDecoder().decode(await contents.read(ref))
            return {
              nodeRunId: output.nodeRunId,
              portName: output.portName,
              content,
              digest: sha256Hex(content),
            }
          }),
        ),
        reviewRunIds: runs.filter((run) => reviewNodes.has(run.nodeId)).map((run) => run.id),
      }
    },
  }
}
