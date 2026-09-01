// RFC-303 bootstrap-owned composition helpers. Integration receives only the
// participant and a mint closure, never task rows or driver internals.
import type { DbClient } from '@/db/client'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { createTaskSourceTerminationParticipant } from '@/modules/task-execution/infrastructure/sqliteSourceTerminationParticipant'
import { createPostgresqlTaskSourceTerminationParticipant } from '@/modules/task-execution/infrastructure/postgresqlSourceTerminationParticipant'
import { mintSourceTerminationEffectCapability } from '@/modules/task-execution/application/sourceTerminationCapability'
import type { InMemoryTaskRuntimeRegistry } from '../infrastructure/inMemoryTaskRuntimeRegistry'

export function composeTaskSourceTermination(db: DbClient) {
  return {
    participant: createTaskSourceTerminationParticipant(db),
    mintCapability: mintSourceTerminationEffectCapability,
  }
}

export function composePostgresqlTaskSourceTermination(
  db: PostgresqlDatabaseClient,
  runtimeRegistry?: InMemoryTaskRuntimeRegistry,
) {
  return {
    participant: createPostgresqlTaskSourceTerminationParticipant(db, runtimeRegistry),
    mintCapability: mintSourceTerminationEffectCapability,
  }
}
