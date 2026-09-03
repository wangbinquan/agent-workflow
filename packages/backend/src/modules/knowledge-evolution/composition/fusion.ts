import type { DbClient } from '@/db/client'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { createPostgresqlFusionPersistence as createPostgresqlFusionPersistenceAdapter } from '../infrastructure/postgresqlFusionRepository'
import { createSqliteFusionPersistence as createSqliteFusionPersistenceAdapter } from '../infrastructure/sqliteFusionRepository'
import type { MemoryCatalogOperations } from '../../memory/public/catalog'
import type {
  FusionEngineTaskOperations,
  FusionOperations,
  FusionPersistence,
} from '../public/participants'

interface FusionCompositionDependencies {
  readonly appHome: string
  readonly memories: MemoryCatalogOperations
  readonly tasks: FusionEngineTaskOperations
}

export function composeSqliteFusionPersistence(input: {
  readonly db: DbClient
  readonly appHome: string
}): FusionPersistence {
  return createSqliteFusionPersistenceAdapter(input)
}

export function composePostgresqlFusionPersistence(input: {
  readonly db: PostgresqlDatabaseClient
  readonly appHome: string
}): FusionPersistence {
  return createPostgresqlFusionPersistenceAdapter(input)
}

export function composeSqliteFusionOperations(
  input: FusionCompositionDependencies & { readonly db: DbClient },
): FusionOperations {
  return Object.freeze({
    persistence: composeSqliteFusionPersistence({ db: input.db, appHome: input.appHome }),
    memories: input.memories,
    tasks: input.tasks,
  })
}

export function composePostgresqlFusionOperations(
  input: FusionCompositionDependencies & { readonly db: PostgresqlDatabaseClient },
): FusionOperations {
  return Object.freeze({
    persistence: composePostgresqlFusionPersistence({ db: input.db, appHome: input.appHome }),
    memories: input.memories,
    tasks: input.tasks,
  })
}
