import type { QueryContext } from '@/modules/identity-access/public/participants'
import type { LocalSystemOperationContext } from './types'
import type {
  DatabaseMigrationListView,
  DatabaseMigrationOperationInput,
  DatabaseMigrationStatusView,
  DatabaseRuntimeOverview,
} from './databaseMigrationTypes'

export interface DatabaseMigrationQueries {
  readonly overview: {
    execute(context: QueryContext | LocalSystemOperationContext): Promise<DatabaseRuntimeOverview>
  }
  readonly get: {
    execute(
      context: QueryContext | LocalSystemOperationContext,
      input: DatabaseMigrationOperationInput,
    ): Promise<DatabaseMigrationStatusView>
  }
  readonly list: {
    execute(context: QueryContext | LocalSystemOperationContext): Promise<DatabaseMigrationListView>
  }
}
