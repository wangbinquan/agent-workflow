import type { WorkgroupTaskRoomDriver } from '../application/workgroups/workgroupTaskRoom'
import { createWorkgroupTaskRoomApplication } from '../application/workgroups/workgroupTaskRoom'
import {
  createSqliteWorkgroupTaskRoomDriver,
  type SqliteWorkgroupTaskRoomDependencies,
} from '../infrastructure/sqliteWorkgroupTaskRoom'
import {
  createPostgresqlWorkgroupTaskRoomTransactionRunner,
  type PostgresqlWorkgroupTaskRoomDependencies,
} from '../infrastructure/postgresqlWorkgroupTaskRoom'
import { createPostgresqlWorkgroupTaskRoomCommands } from '../infrastructure/postgresqlWorkgroupTaskRoomCommands'
import { createPostgresqlWorkgroupTaskRoomQueries } from '../infrastructure/postgresqlWorkgroupTaskRoomQueries'
import type { WorkgroupTaskRoomModule } from '../public/operations'

function compose(driver: WorkgroupTaskRoomDriver): WorkgroupTaskRoomModule {
  return createWorkgroupTaskRoomApplication(driver)
}

export function composeSqliteWorkgroupTaskRoom(
  dependencies: SqliteWorkgroupTaskRoomDependencies,
): WorkgroupTaskRoomModule {
  return compose(createSqliteWorkgroupTaskRoomDriver(dependencies))
}

/** PostgreSQL composition binds RC and TaskExecution participants to one transaction. */
export function composePostgresqlWorkgroupTaskRoom(
  dependencies: PostgresqlWorkgroupTaskRoomDependencies,
): WorkgroupTaskRoomModule {
  const transaction = createPostgresqlWorkgroupTaskRoomTransactionRunner(dependencies)
  return compose({
    commands: createPostgresqlWorkgroupTaskRoomCommands(dependencies, transaction),
    queries: createPostgresqlWorkgroupTaskRoomQueries(transaction),
  })
}
