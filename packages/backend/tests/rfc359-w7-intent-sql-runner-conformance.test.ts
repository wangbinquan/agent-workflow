// RFC-359 W7 —— Intent SQL 程序驱动器的双引擎对拍。
//
// 锁的是「合一」这件事本身：`sqliteIntentSqlProgramRunner.ts` / `postgresqlIntentSqlProgramRunner.ts`
// 合成了一份中立的 `intentSqlProgramRunner.ts`（SQLite 侧的 `dbTxSync` + `driveSyncProgram` +
// `NotPromise<T>` 强转换成中立事务原语 + `driveAsyncProgram`）。合之前两份实现的行为分叉为零，
// 合之后**必须仍然为零**——所以这里的每条断言都在两个引擎上各跑一遍（`describeEachProvider`）。
//
// 覆盖面（对应合并前逐字重复的那几段）：
//   · 四条错误串各自的触发条件（哪个 runner、read 还是 transaction、什么语句）；
//   · 授权会话的惰性 `??=`：一笔事务只铸一次会话，没有授权语句就一次都不铸；
//   · 一笔事务只服务一个 authority（`mixed-intent-context-resource-authority`）；
//   · `firstRow` 的空集语义：`get` 在两个引擎上都必须回具名字段的行 / 空集回 null
//     （SQLite 的原生 `db.get(SQLWrapper)` 回的是位置元组，所以中立实现取 `all(query)[0]`）;
//   · `mutation` 的受影响行数，以及事务体抛错时整笔回滚。

import { expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'

import { users } from '@/db/schema'
import type { DirectAuthenticatedAuthority } from '@/modules/identity-access/public/participants'
import type { IntentContextResourceAuthorityPair } from '@/modules/intent/application/ports/intentPersistence'
import {
  allRows,
  authorizeIntentContextResource,
  firstRow,
  mutation,
  type IntentSqlProgram,
} from '@/modules/intent/infrastructure/intentSqlProgram'
import {
  AuthorizedIntentSqlProgramRunner,
  PlainIntentSqlProgramRunner,
  type IntentContextResourceAuthorizationFactoryDependency,
} from '@/modules/intent/infrastructure/intentSqlProgramRunner'
import { intentContextResourceAuthorizationSessionBrand } from '@/modules/resource-catalog/domain/participantBrands'
import type {
  IntentContextResourceAuthorizationSession,
  IntentContextResourceIdentity,
  IntentContextResourceReference,
  ResourceRequestContext,
} from '@/modules/resource-catalog/public/participants'
import { describeEachProvider, type ProviderHarness } from './helpers/eachProvider'

const REFERENCE: IntentContextResourceReference = Object.freeze({
  resourceType: 'agent',
  resourceId: 'agent-visible',
})

function authorityPair(): IntentContextResourceAuthorityPair {
  return Object.freeze({
    authority: Object.freeze({}) as ResourceRequestContext,
    actor: Object.freeze({}) as DirectAuthenticatedAuthority,
  })
}

function authorization(currentAuthority: IntentContextResourceAuthorityPair) {
  return Object.freeze({
    currentAuthority,
    async visible() {
      return true
    },
  })
}

/** RC 会话的替身：只借它数调用次数 / 认 authority，本用例不测 RC 自己的判据。 */
function session(
  load: (
    authority: ResourceRequestContext,
    reference: IntentContextResourceReference,
  ) => IntentContextResourceIdentity | null,
): IntentContextResourceAuthorizationSession {
  const value: IntentContextResourceAuthorizationSession = {
    [intentContextResourceAuthorizationSessionBrand]:
      'intent-context-resource-authorization-session',
    async loadVisible(authority, reference) {
      return load(authority, reference)
    },
  }
  return Object.freeze(value)
}

interface RecordingFactory extends IntentContextResourceAuthorizationFactoryDependency {
  readonly calls: () => { readonly factory: number; readonly loads: number }
}

function recordingFactory(
  identity: IntentContextResourceIdentity | null = {
    resourceType: REFERENCE.resourceType,
    resourceId: REFERENCE.resourceId,
    name: 'Visible agent',
  },
): RecordingFactory {
  let mints = 0
  let loads = 0
  const value: RecordingFactory = {
    inTransaction(_transaction, pair) {
      mints += 1
      return session((authority) => {
        loads += 1
        expect(authority, '会话拿到的 authority 必须是铸它的那一个').toBe(pair.authority)
        return identity
      })
    },
    calls: () => ({ factory: mints, loads }),
  }
  return Object.freeze(value)
}

async function seedUser(harness: ProviderHarness, id: string): Promise<void> {
  await harness.db.insert(users).values({
    id,
    username: id,
    displayName: id,
    role: 'user',
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
  })
}

function* readUser(id: string): IntentSqlProgram<{ readonly displayName: string } | null> {
  return yield* firstRow<{ readonly displayName: string }>(sql`
    SELECT ${users.displayName} AS "displayName" FROM ${users}
    WHERE ${users.id} = ${id} LIMIT 1
  `)
}

function* renameUser(id: string, displayName: string): IntentSqlProgram<number> {
  return yield* mutation(sql`
    UPDATE ${users} SET ${sql.identifier(users.displayName.name)} = ${displayName}
    WHERE ${users.id} = ${id}
  `)
}

describeEachProvider('RFC-359 W7 Intent SQL runner', (harness) => {
  test('firstRow 命中回具名字段的行，空集回 null（两个引擎同义）', async () => {
    await seedUser(harness, 'runner-read-hit')
    const runner = new PlainIntentSqlProgramRunner(harness.db)

    await expect(runner.read(() => readUser('runner-read-hit'))).resolves.toEqual({
      displayName: 'runner-read-hit',
    })
    // SQLite 的原生 get(SQLWrapper) 会回 ["runner-read-hit"]；命中这一条就说明中立实现
    // 用错了取行方式，Intent 的每个具名字段都会变成 undefined。
    await expect(runner.read(() => readUser('runner-read-miss'))).resolves.toBeNull()
  })

  test('allRows 与 mutation：读到全部行、写回受影响行数', async () => {
    await seedUser(harness, 'runner-rows-a')
    await seedUser(harness, 'runner-rows-b')
    const runner = new PlainIntentSqlProgramRunner(harness.db)

    const ids = await runner.read(function* () {
      const rows = yield* allRows<{ readonly id: string }>(sql`
        SELECT ${users.id} AS "id" FROM ${users}
        WHERE ${users.id} LIKE ${'runner-rows-%'} ORDER BY ${users.id}
      `)
      return rows.map((row) => row.id)
    })
    expect(ids).toEqual(['runner-rows-a', 'runner-rows-b'])

    await expect(
      runner.transaction(function* () {
        return yield* renameUser('runner-rows-a', 'renamed')
      }),
    ).resolves.toBe(1)
    await expect(runner.read(() => readUser('runner-rows-a'))).resolves.toEqual({
      displayName: 'renamed',
    })
    await expect(
      runner.transaction(function* () {
        return yield* renameUser('runner-rows-missing', 'renamed')
      }),
    ).resolves.toBe(0)
  })

  test('事务体抛错 ⇒ 整笔回滚（合一后 SQLite 走显式 BEGIN IMMEDIATE，语义不能退化）', async () => {
    await seedUser(harness, 'runner-rollback')
    const runner = new PlainIntentSqlProgramRunner(harness.db)

    await expect(
      runner.transaction(function* () {
        yield* renameUser('runner-rollback', 'half-written')
        throw new Error('program failed after its write')
      }),
    ).rejects.toThrow('program failed after its write')

    await expect(runner.read(() => readUser('runner-rollback'))).resolves.toEqual({
      displayName: 'runner-rollback',
    })
  })

  test('plain runner 的 read 撞上授权语句 ⇒ requires-transaction-composition', async () => {
    const runner = new PlainIntentSqlProgramRunner(harness.db)
    await expect(
      runner.read(function* () {
        return yield* authorizeIntentContextResource(authorization(authorityPair()), REFERENCE)
      }),
    ).rejects.toThrow('intent-context-authorization-requires-transaction-composition')
  })

  test('plain runner 的 transaction 撞上授权语句 ⇒ not-composed（装配漏了 RC 绑定）', async () => {
    const runner = new PlainIntentSqlProgramRunner(harness.db)
    await expect(
      runner.transaction(function* () {
        return yield* authorizeIntentContextResource(authorization(authorityPair()), REFERENCE)
      }),
    ).rejects.toThrow('intent-context-authorization-not-composed')
  })

  test('authorized runner 的 read 撞上授权语句 ⇒ requires-transaction（会话只在事务里铸）', async () => {
    const factory = recordingFactory()
    const runner = new AuthorizedIntentSqlProgramRunner(harness.db, factory)
    await expect(
      runner.read(function* () {
        return yield* authorizeIntentContextResource(authorization(authorityPair()), REFERENCE)
      }),
    ).rejects.toThrow('intent-context-authorization-requires-transaction')
    expect(factory.calls().factory, '读路径不该铸出任何授权会话').toBe(0)
  })

  test('授权会话惰性铸出：一笔事务只铸一次，无授权语句时一次都不铸', async () => {
    await seedUser(harness, 'runner-lazy')
    const factory = recordingFactory()
    const runner = new AuthorizedIntentSqlProgramRunner(harness.db, factory)
    const current = authorization(authorityPair())

    await expect(
      runner.transaction(function* () {
        yield* authorizeIntentContextResource(current, REFERENCE)
        yield* authorizeIntentContextResource(current, {
          resourceType: 'skill',
          resourceId: 'skill-visible',
        })
        return yield* renameUser('runner-lazy', 'authorized')
      }),
    ).resolves.toBe(1)
    expect(factory.calls()).toEqual({ factory: 1, loads: 2 })

    await runner.transaction(function* () {
      return yield* readUser('runner-lazy')
    })
    expect(factory.calls(), '没有授权语句的事务不该铸会话').toEqual({ factory: 1, loads: 2 })
  })

  test('授权结果原样回给程序（可见回 identity，不可见回 null）', async () => {
    const visible = new AuthorizedIntentSqlProgramRunner(harness.db, recordingFactory())
    await expect(
      visible.transaction(function* () {
        return yield* authorizeIntentContextResource(authorization(authorityPair()), REFERENCE)
      }),
    ).resolves.toEqual({
      resourceType: REFERENCE.resourceType,
      resourceId: REFERENCE.resourceId,
      name: 'Visible agent',
    })

    const hidden = new AuthorizedIntentSqlProgramRunner(harness.db, recordingFactory(null))
    await expect(
      hidden.transaction(function* () {
        return yield* authorizeIntentContextResource(authorization(authorityPair()), REFERENCE)
      }),
    ).resolves.toBeNull()
  })

  test('一笔事务只服务一个 authority ⇒ mixed-intent-context-resource-authority，且整笔回滚', async () => {
    await seedUser(harness, 'runner-mixed')
    const factory = recordingFactory()
    const runner = new AuthorizedIntentSqlProgramRunner(harness.db, factory)

    await expect(
      runner.transaction(function* () {
        yield* authorizeIntentContextResource(authorization(authorityPair()), REFERENCE)
        yield* renameUser('runner-mixed', 'mixed')
        // 第二个 pair 是**另一个对象**：换 authority 就换了鉴权主体，同一笔事务不认。
        return yield* authorizeIntentContextResource(authorization(authorityPair()), REFERENCE)
      }),
    ).rejects.toThrow('mixed-intent-context-resource-authority')

    expect(factory.calls().factory, '第二个 authority 不该再铸一个会话').toBe(1)
    await expect(
      new PlainIntentSqlProgramRunner(harness.db).read(() => readUser('runner-mixed')),
    ).resolves.toEqual({ displayName: 'runner-mixed' })
  })
})
