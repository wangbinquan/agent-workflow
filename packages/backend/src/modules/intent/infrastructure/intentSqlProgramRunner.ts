// RFC-359 W7 —— Intent 的 SQL 程序驱动器：一份实现，两个 provider。
//
// # 合掉了什么
//
// 此前是 `sqliteIntentSqlProgramRunner.ts`（120 行）/ `postgresqlIntentSqlProgramRunner.ts`（105 行）
// 一对。两份的**行为分叉为零**：四条错误串逐字相同、`changes()` 逐字重复、授权会话的惰性 `??=`
// 与「一笔事务只服务一个 authority」的断言同构。它们分家的唯一技术成因就是事务——SQLite 侧走
// `dbTxSync`（bun:sqlite 的同步包装器，回调内不能 await，于是驱动器只能是 `driveSyncProgram`
// 并把返回值强转成 `NotPromise<T>`），PG 侧走驱动自带的 async 事务。
//
// 中立事务原语（`platform/persistence/databaseTransaction.ts`）在 SQLite 上改发显式
// `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK`，事务体因此可以 `await`，两侧语义相同。于是
// `driveAsyncProgram` 一个驱动器就够了，`NotPromise<T>` 的强转随之消失。
//
// rawRows / rawFirst 使用对象模式，按程序提供的 contract codec 还原 int8 与布尔值；
// 空集仍为 undefined，由 firstRow 收成 null。原生 drizzle 负责两侧 SQL 的编译。

import { rawRows, rawFirst, rawExec, affectedRows } from '@/platform/persistence/queryHelpers'
import type { PersistenceDb, PersistenceTx } from '@/platform/persistence/persistenceDb'
import type { IntentContextResourceAuthorizationSession } from '@/modules/resource-catalog/public/participants'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import type { IntentContextResourceAuthorityPair } from '../application/ports/intentPersistence'

import {
  driveAsyncProgram,
  type IntentSqlProgram,
  type IntentSqlProgramRunner,
  type IntentSqlStatement,
} from './intentSqlProgram'

type IntentSqlDatabaseStatement = Exclude<
  IntentSqlStatement,
  { readonly kind: 'authorize-resource' }
>

/** Structural dependency satisfied by the RC transaction-bound session factory. */
export interface IntentContextResourceAuthorizationFactoryDependency {
  inTransaction(
    transaction: PersistenceTx,
    pair: IntentContextResourceAuthorityPair,
  ): IntentContextResourceAuthorizationSession
}

async function execute(db: PersistenceDb, statement: IntentSqlDatabaseStatement): Promise<unknown> {
  if (statement.kind === 'all') return await rawRows(db, statement.query, statement.codecs)
  if (statement.kind === 'get') return await rawFirst(db, statement.query, statement.codecs)
  return affectedRows(await rawExec(db, statement.query))
}

/** Intent 程序驱动器。上下文授权指令在这里没有收件人，命中即是装配错误。 */
export class PlainIntentSqlProgramRunner implements IntentSqlProgramRunner {
  constructor(readonly db: PersistenceDb) {}

  async read<T>(program: () => IntentSqlProgram<T>): Promise<T> {
    return await driveAsyncProgram(program(), async (statement) => {
      if (statement.kind === 'authorize-resource') {
        throw new Error('intent-context-authorization-requires-transaction-composition')
      }
      return await execute(this.db, statement)
    })
  }

  async transaction<T>(program: () => IntentSqlProgram<T>): Promise<T> {
    return await databaseSessionFor(this.db).transaction(
      async (tx) =>
        await driveAsyncProgram(program(), async (statement) => {
          if (statement.kind === 'authorize-resource') {
            throw new Error('intent-context-authorization-not-composed')
          }
          return await execute(tx, statement)
        }),
    )
  }
}

/**
 * 上下文变更驱动器：把 RC 的授权会话绑在**驱动本程序的那一笔事务**上。会话在事务体内惰性铸出，
 * 因此拿不到它的人无从在事务外复用；一笔事务只服务一个 authority。
 */
export class AuthorizedIntentSqlProgramRunner implements IntentSqlProgramRunner {
  constructor(
    readonly db: PersistenceDb,
    private readonly authorizationFactory: IntentContextResourceAuthorizationFactoryDependency,
  ) {}

  async read<T>(program: () => IntentSqlProgram<T>): Promise<T> {
    return await driveAsyncProgram(program(), async (statement) => {
      if (statement.kind === 'authorize-resource') {
        throw new Error('intent-context-authorization-requires-transaction')
      }
      return await execute(this.db, statement)
    })
  }

  async transaction<T>(program: () => IntentSqlProgram<T>): Promise<T> {
    return await databaseSessionFor(this.db).transaction(async (transaction) => {
      let currentAuthority: IntentContextResourceAuthorityPair | undefined
      let authorization: IntentContextResourceAuthorizationSession | undefined
      return await driveAsyncProgram(program(), async (statement) => {
        if (statement.kind !== 'authorize-resource') {
          return await execute(transaction, statement)
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
