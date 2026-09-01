import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type { IntentContextResourceAuthorizationSession } from '@/modules/resource-catalog/public/participants'
import type { IntentContextResourceAuthorityPair } from '../application/ports/intentPersistence'

import {
  driveAsyncProgram,
  type IntentSqlProgram,
  type IntentSqlProgramRunner,
  type IntentSqlStatement,
} from './intentSqlProgram'

type PostgresqlIntentTransaction = Parameters<
  Parameters<PostgresqlDatabaseClient['transaction']>[0]
>[0]
type IntentSqlDatabaseStatement = Exclude<
  IntentSqlStatement,
  { readonly kind: 'authorize-resource' }
>

/** Structural dependency satisfied by the RC PostgreSQL transaction factory. */
export interface PostgresqlIntentContextResourceAuthorizationFactoryDependency {
  inTransaction(
    transaction: PostgresqlIntentTransaction,
    pair: IntentContextResourceAuthorityPair,
  ): IntentContextResourceAuthorizationSession
}

function changes(result: unknown): number {
  return (result as { readonly changes?: number }).changes ?? 0
}

async function executePostgresql(
  db: Pick<PostgresqlDatabaseClient, 'all' | 'get' | 'run'>,
  statement: IntentSqlDatabaseStatement,
): Promise<unknown> {
  if (statement.kind === 'all') return await db.all(statement.query)
  if (statement.kind === 'get') return await db.get(statement.query)
  return changes(await db.run(statement.query))
}

export class PostgresqlIntentSqlProgramRunner implements IntentSqlProgramRunner {
  constructor(private readonly db: PostgresqlDatabaseClient) {}

  async read<T>(program: () => IntentSqlProgram<T>): Promise<T> {
    return await driveAsyncProgram(program(), async (statement) => {
      if (statement.kind === 'authorize-resource') {
        throw new Error('intent-context-authorization-requires-transaction-composition')
      }
      return await executePostgresql(this.db, statement)
    })
  }

  async transaction<T>(program: () => IntentSqlProgram<T>): Promise<T> {
    return await this.db.transaction(
      async (tx) =>
        await driveAsyncProgram(program(), async (statement) => {
          if (statement.kind === 'authorize-resource') {
            throw new Error('intent-context-authorization-not-composed')
          }
          return await executePostgresql(tx, statement)
        }),
    )
  }
}

/** PostgreSQL runner that binds public RC authorization to its reserved tx. */
export class PostgresqlAuthorizedIntentSqlProgramRunner implements IntentSqlProgramRunner {
  constructor(
    private readonly db: PostgresqlDatabaseClient,
    private readonly authorizationFactory: PostgresqlIntentContextResourceAuthorizationFactoryDependency,
  ) {}

  async read<T>(program: () => IntentSqlProgram<T>): Promise<T> {
    return await driveAsyncProgram(program(), async (statement) => {
      if (statement.kind === 'authorize-resource') {
        throw new Error('intent-context-authorization-requires-transaction')
      }
      return await executePostgresql(this.db, statement)
    })
  }

  async transaction<T>(program: () => IntentSqlProgram<T>): Promise<T> {
    return await this.db.transaction(async (transaction) => {
      let currentAuthority: IntentContextResourceAuthorityPair | undefined
      let authorization: IntentContextResourceAuthorizationSession | undefined
      return await driveAsyncProgram(program(), async (statement) => {
        if (statement.kind !== 'authorize-resource') {
          return await executePostgresql(transaction, statement)
        }
        if (currentAuthority !== undefined && currentAuthority !== statement.currentAuthority) {
          throw new Error('mixed-intent-context-resource-authority')
        }
        currentAuthority = statement.currentAuthority
        authorization ??= this.authorizationFactory.inTransaction(
          transaction,
          statement.currentAuthority,
        )
        return await authorization.loadVisible(
          statement.currentAuthority.authority,
          statement.reference,
        )
      })
    })
  }
}
