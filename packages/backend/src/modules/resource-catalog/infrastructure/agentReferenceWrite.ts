import { and, eq } from 'drizzle-orm'
import type { AgentReferenceWriteParticipant } from '../application/ports/agentReferenceWrite'
import type { PersistenceDb, PersistenceTx } from '@/platform/persistence/persistenceDb'
import { tablesOf } from '@/platform/persistence/sessionTables'
import {
  agentFromPersistenceRow,
  createAgentPersistenceValues,
  updateAgentPersistenceValues,
} from './agentPersistence'

import type { AgentReferences } from '@agent-workflow/shared'
import { agentReferenceRows } from '../domain/agentReferenceKey'
import { queryWrite } from '@/platform/persistence/queryHelpers'
import { continueResourceCommit, forEachResourceCommit } from './resourceCommitSequence'

/** Parent writes and their ordered relations share the caller's transaction. */
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
      for (const row of rows) await replaceAgentReferences(transaction, row.id, input.agent)
      return rows.map((row) => ({
        ...agentFromPersistenceRow(row, input.agent),
        aclRevision: row.aclRevision,
      }))
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
    const references: AgentReferences = {
      skills: input.patch.skills ?? input.current.skills,
      dependsOn: input.patch.dependsOn ?? input.current.dependsOn,
      mcp: input.patch.mcp ?? input.current.mcp,
      plugins: input.patch.plugins ?? input.current.plugins,
    }
    for (const row of rows) await replaceAgentReferences(transaction, row.id, references)
    return rows.map((row) => ({
      ...agentFromPersistenceRow(row, references),
      aclRevision: row.aclRevision,
    }))
  }
}

/** The synchronous legacy participant uses the same ordered write program. */
export function replaceAgentReferences(
  transaction: PersistenceDb | PersistenceTx,
  agentId: string,
  references: AgentReferences,
): void | Promise<void> {
  const { agentSkillRefs, agentMcpRefs, agentPluginRefs, agentDependencies } = tablesOf(transaction)
  const rows = agentReferenceRows(agentId, references)
  return forEachResourceCommit(
    [
      () =>
        queryWrite(transaction.delete(agentSkillRefs).where(eq(agentSkillRefs.agentId, agentId))),
      () => queryWrite(transaction.delete(agentMcpRefs).where(eq(agentMcpRefs.agentId, agentId))),
      () =>
        queryWrite(transaction.delete(agentPluginRefs).where(eq(agentPluginRefs.agentId, agentId))),
      () =>
        queryWrite(
          transaction.delete(agentDependencies).where(eq(agentDependencies.agentId, agentId)),
        ),
      () =>
        rows.skills.length === 0
          ? undefined
          : queryWrite(transaction.insert(agentSkillRefs).values(rows.skills)),
      () =>
        rows.mcp.length === 0
          ? undefined
          : queryWrite(transaction.insert(agentMcpRefs).values(rows.mcp)),
      () =>
        rows.plugins.length === 0
          ? undefined
          : queryWrite(transaction.insert(agentPluginRefs).values(rows.plugins)),
      () =>
        rows.dependencies.length === 0
          ? undefined
          : queryWrite(transaction.insert(agentDependencies).values(rows.dependencies)),
    ],
    (write) => continueResourceCommit(write(), () => {}),
  )
}
