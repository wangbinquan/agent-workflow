import { eq } from 'drizzle-orm'
import { DwStateSchema, type DwState } from '@agent-workflow/shared'
import type { ProviderNeutralDatabase } from '@/db/query'
import { workgroupTaskState } from '@/db/schema'

export interface PreparedDynamicWorkflowStateWrite {
  readonly taskId: string
  readonly dwStateJson: string
  readonly updatedAt: number
}

/** Preserve the native schema/JSON snapshot before any persistent wait. */
export function prepareDynamicWorkflowStateWrite(
  taskId: string,
  state: DwState,
  now: number,
): PreparedDynamicWorkflowStateWrite {
  return Object.freeze({
    taskId,
    dwStateJson: JSON.stringify(DwStateSchema.parse(state)),
    updatedAt: now,
  })
}

/** The original single UPDATE; the caller supplies its actual executor. */
export function writeDynamicWorkflowState(
  db: ProviderNeutralDatabase,
  prepared: PreparedDynamicWorkflowStateWrite,
) {
  return db
    .update(workgroupTaskState)
    .set({ dwStateJson: prepared.dwStateJson, updatedAt: prepared.updatedAt })
    .where(eq(workgroupTaskState.taskId, prepared.taskId))
    .run()
}
