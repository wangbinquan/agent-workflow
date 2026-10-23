import { and, eq } from 'drizzle-orm'
import type { AgentReferenceWriteParticipant } from '../application/ports/agentReferenceWrite'
import type { PersistenceDb, PersistenceTx } from '@/platform/persistence/persistenceDb'
import { tablesOf } from '@/platform/persistence/sessionTables'
import {
  agentFromPersistenceRow,
  createAgentPersistenceValues,
  updateAgentPersistenceValues,
} from './agentPersistence'

/** II-b 在这里把四类引用换为关系写入；调用者仍持有原来的事务。 */
export function createAgentReferenceWriteParticipant(
  transaction: PersistenceDb | PersistenceTx,
): AgentReferenceWriteParticipant {
  const { agents } = tablesOf(transaction)
  return {
    async insert(input) {
      const rows = await transaction
        .insert(agents)
        .values({
          ...createAgentPersistenceValues(input),
          ...(input.visibility === undefined ? {} : { visibility: input.visibility }),
          ...(input.builtin === undefined ? {} : { builtin: input.builtin }),
        })
        .returning()
      return rows.map((row) => ({ ...agentFromPersistenceRow(row), aclRevision: row.aclRevision }))
    },
    async update(input) {
      return prepareAgentReferenceUpdate(input)(transaction)
    },
  }
}

/** Prepare before opening the repository transaction, preserving HEAD's validation order. */
export function prepareAgentReferenceUpdate(
  input: Parameters<AgentReferenceWriteParticipant['update']>[0],
) {
  const set = updateAgentPersistenceValues(input.current, input.patch, input.updatedAt)
  return async (transaction: PersistenceDb | PersistenceTx) => {
    const { agents } = tablesOf(transaction)
    const rows = await transaction
      .update(agents)
      .set(set)
      .where(
        and(
          eq(agents.id, input.current.id),
          eq(agents.updatedAt, input.expectedUpdatedAt),
          eq(agents.aclRevision, input.expectedAclRevision),
          input.ownerUserId === undefined ? undefined : eq(agents.ownerUserId, input.ownerUserId),
          input.builtin === undefined ? undefined : eq(agents.builtin, input.builtin),
        ),
      )
      .returning()
    return rows.map((row) => ({ ...agentFromPersistenceRow(row), aclRevision: row.aclRevision }))
  }
}
