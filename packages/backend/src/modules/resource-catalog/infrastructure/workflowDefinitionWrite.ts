import { and, eq } from 'drizzle-orm'
import type { WorkflowDefinitionWriteParticipant } from '../application/ports/workflowDefinitionWrite'
import type { PersistenceDb, PersistenceTx } from '@/platform/persistence/persistenceDb'
import { tablesOf } from '@/platform/persistence/sessionTables'

/** RFC-395 II-a A5：唯一 definition 写点；不重编码、不改变调用者的 revision 或谓词。 */
export function createWorkflowDefinitionWriteParticipant(
  transaction: PersistenceDb | PersistenceTx,
): WorkflowDefinitionWriteParticipant {
  const { workflows } = tablesOf(transaction)
  return {
    async insert(record) {
      return transaction.insert(workflows).values(record).returning()
    },
    async update(input) {
      return transaction
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
    },
  }
}
