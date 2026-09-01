import { and, eq, gt } from 'drizzle-orm'

import { memories } from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'

type PostgresqlMemoryTransaction = Parameters<
  Parameters<PostgresqlDatabaseClient['transaction']>[0]
>[0]

export interface PostgresqlSkillMemoryFusionParticipantInTx {
  unfuseAboveVersion(input: {
    readonly skillId: string
    readonly aboveVersion: number
  }): Promise<readonly string[]>
}

export interface PostgresqlSkillMemoryFusionParticipantFactory {
  inTransaction(
    transaction: PostgresqlMemoryTransaction,
  ): PostgresqlSkillMemoryFusionParticipantInTx
}

/**
 * Memory-owned half of Skill restore. The caller supplies the already-reserved
 * PostgreSQL transaction so provenance clearing and the restored Skill version
 * become visible atomically.
 */
export function composePostgresqlSkillMemoryFusionParticipantFactory(): PostgresqlSkillMemoryFusionParticipantFactory {
  return Object.freeze({
    inTransaction(
      transaction: Parameters<PostgresqlSkillMemoryFusionParticipantFactory['inTransaction']>[0],
    ) {
      return Object.freeze({
        async unfuseAboveVersion(
          input: Parameters<PostgresqlSkillMemoryFusionParticipantInTx['unfuseAboveVersion']>[0],
        ) {
          const rows = await transaction
            .update(memories)
            .set({
              status: 'approved',
              fusedIntoSkillId: null,
              fusedIntoSkill: null,
              fusedIntoSkillVersion: null,
              fusedAt: null,
              fusedByUserId: null,
              fusedFusionId: null,
            })
            .where(
              and(
                eq(memories.status, 'fused'),
                eq(memories.fusedIntoSkillId, input.skillId),
                gt(memories.fusedIntoSkillVersion, input.aboveVersion),
              ),
            )
            .returning({ id: memories.id })
            .all()
          return Object.freeze(rows.map((row: { readonly id: string }) => row.id).sort())
        },
      })
    },
  })
}
