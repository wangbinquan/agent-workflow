import { and, eq } from 'drizzle-orm'
import type { ProviderNeutralDatabase } from '@/db/query'
import { tasks, nodeRuns, nodeRunOutputs } from '@/db/schema'
import { sha256Hex } from '@/util/hash'
import type { EmployeeExecutionArtifactQueries } from '../public/types'

export function createEmployeeExecutionArtifactQueries(
  db: ProviderNeutralDatabase,
): EmployeeExecutionArtifactQueries {
  return {
    async read(input) {
      const row = (
        await db
          .select({
            caseId: tasks.digitalEmployeeCaseId,
            roundRef: tasks.digitalEmployeeRoundId,
            status: tasks.status,
            workflowSnapshot: tasks.workflowSnapshot,
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
          content: nodeRunOutputs.content,
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
        artifacts: outputs.map((output) => ({
          nodeRunId: output.nodeRunId,
          portName: output.portName,
          content: output.content,
          digest: sha256Hex(output.content),
        })),
        reviewRunIds: runs.filter((run) => reviewNodes.has(run.nodeId)).map((run) => run.id),
      }
    },
  }
}
