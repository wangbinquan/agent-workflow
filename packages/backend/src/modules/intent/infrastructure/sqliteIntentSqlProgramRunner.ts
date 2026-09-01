import type { DbClient } from '@/db/client'
import { dbTxSync, type DbTxSync, type NotPromise } from '@/db/txSync'
import type { SQLWrapper } from 'drizzle-orm'
import type {
  IntentContextResourceIdentity,
  IntentContextResourceReference,
  ResourceRequestContext,
} from '@/modules/resource-catalog/public/participants'
import type { IntentContextResourceAuthorityPair } from '../application/ports/intentPersistence'

import {
  driveSyncProgram,
  type IntentSqlProgram,
  type IntentSqlProgramRunner,
  type IntentSqlStatement,
} from './intentSqlProgram'

type IntentSqlDatabaseStatement = Exclude<
  IntentSqlStatement,
  { readonly kind: 'authorize-resource' }
>

/** Structural provider-private dependency satisfied by the RC sync factory. */
export interface SqliteIntentContextResourceAuthorizationFactoryDependency {
  inTransaction(
    transaction: DbTxSync,
    pair: IntentContextResourceAuthorityPair,
  ): {
    loadVisibleSync(
      authority: ResourceRequestContext,
      reference: IntentContextResourceReference,
    ): IntentContextResourceIdentity | null
  }
}

function changes(result: unknown): number {
  return (result as { readonly changes?: number }).changes ?? 0
}

function executeSqlite(db: Pick<DbClient, 'all' | 'run'>, statement: IntentSqlDatabaseStatement) {
  if (statement.kind === 'all') return db.all(statement.query)
  // Drizzle's Bun SQLite raw `get(SQLWrapper)` path returns the positional
  // value tuple, while `all(SQLWrapper)` preserves the SQL aliases as object
  // keys. Intent programs consume named records on both providers, so obtain
  // the first mapped row from the provider's `all` path instead.
  if (statement.kind === 'get') return db.all(statement.query)[0]
  return changes(db.run(statement.query as SQLWrapper))
}

export class SqliteIntentSqlProgramRunner implements IntentSqlProgramRunner {
  constructor(private readonly db: DbClient) {}

  async read<T>(program: () => IntentSqlProgram<T>): Promise<T> {
    return driveSyncProgram(program(), (statement) => {
      if (statement.kind === 'authorize-resource') {
        throw new Error('intent-context-authorization-requires-transaction-composition')
      }
      return executeSqlite(this.db, statement)
    })
  }

  async transaction<T>(program: () => IntentSqlProgram<T>): Promise<T> {
    return dbTxSync(
      this.db,
      (tx) =>
        driveSyncProgram(program(), (statement) => {
          if (statement.kind === 'authorize-resource') {
            throw new Error('intent-context-authorization-not-composed')
          }
          return executeSqlite(tx, statement)
        }) as NotPromise<T>,
    )
  }
}

/**
 * SQLite context-mutation runner. The private synchronous RC capability is
 * minted inside dbTxSync and therefore cannot escape the transaction body.
 */
export class SqliteAuthorizedIntentSqlProgramRunner implements IntentSqlProgramRunner {
  constructor(
    private readonly db: DbClient,
    private readonly authorizationFactory: SqliteIntentContextResourceAuthorizationFactoryDependency,
  ) {}

  async read<T>(program: () => IntentSqlProgram<T>): Promise<T> {
    return driveSyncProgram(program(), (statement) => {
      if (statement.kind === 'authorize-resource') {
        throw new Error('intent-context-authorization-requires-transaction')
      }
      return executeSqlite(this.db, statement)
    })
  }

  async transaction<T>(program: () => IntentSqlProgram<T>): Promise<T> {
    return dbTxSync(this.db, (transaction) => {
      let currentAuthority: IntentContextResourceAuthorityPair | undefined
      let authorization:
        | ReturnType<SqliteIntentContextResourceAuthorizationFactoryDependency['inTransaction']>
        | undefined
      return driveSyncProgram(program(), (statement) => {
        if (statement.kind !== 'authorize-resource') {
          return executeSqlite(transaction, statement)
        }
        if (currentAuthority !== undefined && currentAuthority !== statement.currentAuthority) {
          throw new Error('mixed-intent-context-resource-authority')
        }
        currentAuthority = statement.currentAuthority
        authorization ??= this.authorizationFactory.inTransaction(
          transaction,
          statement.currentAuthority,
        )
        return authorization.loadVisibleSync(
          statement.currentAuthority.authority,
          statement.reference,
        )
      }) as NotPromise<T>
    })
  }
}
