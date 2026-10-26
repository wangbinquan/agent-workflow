import { workflowDependencyIndexEntries } from '@agent-workflow/shared'
import { and, eq } from 'drizzle-orm'
import type { WorkflowDefinitionWriteParticipant } from '../application/ports/workflowDefinitionWrite'
import type { PersistenceDb, PersistenceTx } from '@/platform/persistence/persistenceDb'
import { tablesOf } from '@/platform/persistence/sessionTables'

/** Canonical bytes and their revision index commit in the same transaction. */
export function createWorkflowDefinitionWriteParticipant(
  transaction: PersistenceDb | PersistenceTx,
): WorkflowDefinitionWriteParticipant {
  const { workflows } = tablesOf(transaction)
  const { workflowDependencyIndex } = tablesOf(transaction)
  async function rebuild(
    workflowId: string,
    revision: number,
    entries: ReturnType<typeof workflowDependencyIndexEntries>,
  ) {
    await transaction
      .delete(workflowDependencyIndex)
      .where(eq(workflowDependencyIndex.workflowId, workflowId))
    if (entries.length > 0)
      await transaction
        .insert(workflowDependencyIndex)
        .values(entries.map((entry) => ({ workflowId, revision, ...entry })))
  }
  return {
    async insert(record) {
      const entries = workflowDependencyIndexEntries(record.definition)
      const rows = await transaction.insert(workflows).values(record).returning()
      for (const row of rows) await rebuild(row.id, row.version, entries)
      return rows
    },
    async update(input) {
      const entries = workflowDependencyIndexEntries(input.set.definition)
      const rows = await transaction
        .update(workflows)
        .set(input.set)
        .where(
          and(
            eq(workflows.id, input.id),
            input.expectedVersion === undefined
              ? undefined
              : eq(workflows.version, input.expectedVersion),
            input.expectedAclRevision === undefined
              ? undefined
              : eq(workflows.aclRevision, input.expectedAclRevision),
            input.ownerUserId === undefined
              ? undefined
              : eq(workflows.ownerUserId, input.ownerUserId),
            input.builtin === undefined ? undefined : eq(workflows.builtin, input.builtin),
          ),
        )
        .returning()
      for (const row of rows) await rebuild(row.id, row.version, entries)
      return rows
    },
  }
}
