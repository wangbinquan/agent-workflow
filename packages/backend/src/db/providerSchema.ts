// RFC-349 — one logical schema surface backed by two concrete Drizzle table
// projections. Existing application code keeps the strongly typed SQLite
// declarations while the process-wide provider fence swaps the runtime table
// and column objects to a separately constructed pgTable projection.

import { is } from 'drizzle-orm'
import { PgColumn, type AnyPgTable } from 'drizzle-orm/pg-core'
import { SQLiteColumn } from 'drizzle-orm/sqlite-core'
import type { DatabaseProvider } from '@/platform/persistence/schemaContract'

let activeProvider: DatabaseProvider = 'sqlite'

interface TableProjection {
  readonly sqlite: object
  readonly postgresql: AnyPgTable
  /** 按属性名缓存的列 facade：同一列在两个 provider 下是同一个对象，身份稳定。 */
  readonly columns: Map<string, object>
}

const projectionByFacade = new WeakMap<object, TableProjection>()
const facadeByConcrete = new WeakMap<object, object>()
function projectionFor(value: object): TableProjection | undefined {
  const facade = projectionByFacade.has(value) ? value : facadeByConcrete.get(value)
  return facade === undefined ? undefined : projectionByFacade.get(facade)
}

export function concreteDatabaseTable<T extends object>(table: T, provider: DatabaseProvider): T {
  const projection = projectionFor(table)
  if (projection === undefined) return table
  return projection[provider] as T
}

/**
 * Set once during provider bootstrap. The returned disposer exists for isolated
 * unit tests; production treats a second, different selection as a fence error.
 */
export function selectDatabaseSchemaProvider(provider: DatabaseProvider): () => void {
  const previous = activeProvider
  activeProvider = provider
  return () => {
    activeProvider = previous
  }
}

export function currentDatabaseSchemaProvider(): DatabaseProvider {
  return activeProvider
}

/**
 * 列 facade。表 facade 只在**访问时**解析到当前 provider 的具体表，但业务模块常在模块加载期就把列对象捕获进
 * 常量（`const COLUMNS = { createdAt: table.createdAt }`）——那时进程还没选 provider（默认 sqlite），捕获到的是
 * SQLite 列；在 PostgreSQL 上用它解码就绕开了 pg 投影的 `bigint → number` 映射，游标 / 计数原样回成字符串
 * （RFC-359 W4-D10 在 mission 列表页游标上实撞）。列同样做成访问时解析的 facade 之后，无论何时捕获，drizzle
 * 取到的原型、`mapFromDriverValue` / `mapToDriverValue`、所属表都是当前 provider 的。
 */
function columnFacadeFor(projection: TableProjection, property: string): object {
  const cached = projection.columns.get(property)
  if (cached !== undefined) return cached
  const concrete = (): object =>
    (projection[activeProvider] as unknown as Record<string, object>)[property]!
  const facade: object = new Proxy((projection.sqlite as Record<string, object>)[property]!, {
    get: (_target, key) => Reflect.get(concrete(), key),
    set: (_target, key, value) => Reflect.set(concrete(), key, value),
    has: (_target, key) => Reflect.has(concrete(), key),
    getPrototypeOf: () => Reflect.getPrototypeOf(concrete()),
    ownKeys: () => Reflect.ownKeys(concrete()),
    getOwnPropertyDescriptor: (_target, key) => Reflect.getOwnPropertyDescriptor(concrete(), key),
  })
  projection.columns.set(property, facade)
  return facade
}

export function providerTableFacade<T extends object>(
  sqliteTable: T,
  postgresqlTable: AnyPgTable,
): T {
  const facade: object = new Proxy(sqliteTable, {
    get(_target, property, receiver) {
      const projection = projectionByFacade.get(facade)!
      const value: unknown = Reflect.get(projection[activeProvider], property, receiver)
      if (typeof property === 'string' && (is(value, SQLiteColumn) || is(value, PgColumn))) {
        return columnFacadeFor(projection, property)
      }
      return value
    },
    getPrototypeOf() {
      const projection = projectionByFacade.get(facade)!
      return Reflect.getPrototypeOf(projection[activeProvider])
    },
  })
  const projection: TableProjection = {
    sqlite: sqliteTable,
    postgresql: postgresqlTable,
    columns: new Map(),
  }
  projectionByFacade.set(facade, projection)
  facadeByConcrete.set(sqliteTable, facade)
  facadeByConcrete.set(postgresqlTable, facade)
  return facade as T
}
