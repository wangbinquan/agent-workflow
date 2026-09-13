// 故障注入触发器的两引擎写法。
//
// 为什么这个助手存在：「某张表的插入必失败，验证整笔回滚」这类判据在本仓有十来处，
// 而两个引擎的 DDL 不同——SQLite 的触发器体直接 `RAISE(ABORT, …)`，PostgreSQL 必须先建一个
// plpgsql 触发器函数、再把触发器挂上去；`DROP` 的语法也不同（SQLite 的触发器名是库级的，
// PostgreSQL 的挂在表上、必须带 `ON <table>`）。抄第四遍时把它收成一份。
//
// **务必配 try/finally 用**：SQLite 每个用例拿的是一个全新的内存库，触发器随库消失；
// PostgreSQL 的库是整份测试共用的真库，用例之间只清表**不回滚 DDL**——留着的触发器会让
// 之后每一个写那张表的用例全红（rfc120-deferred-dispatch 上实撞过，CI shard 5/8 才暴露，
// 本地因用例顺序不同看不见）。

import type { ProviderDatabaseHarness } from './eachProvider'

export interface AbortTriggerSpec {
  /** 触发器名（PostgreSQL 侧同名的还有一个触发器函数）。 */
  readonly name: string
  /** 挂在哪张表上。 */
  readonly table: string
  /** 抛出的错误文案——两个引擎逐字相同，判据因此可以共用。 */
  readonly error: string
  /** BEFORE 哪个事件，默认 insert。 */
  readonly event?: 'insert' | 'update'
  /** 只对 `update` 有意义：只在这些列被写时触发（两个引擎都支持 `UPDATE OF <cols>`）。 */
  readonly columns?: readonly string[]
}

function beforeClause(spec: AbortTriggerSpec): string {
  if ((spec.event ?? 'insert') === 'insert') return 'BEFORE INSERT'
  const columns = spec.columns ?? []
  return columns.length === 0 ? 'BEFORE UPDATE' : `BEFORE UPDATE OF ${columns.join(', ')}`
}

export async function installAbortTrigger(
  harness: ProviderDatabaseHarness,
  spec: AbortTriggerSpec,
): Promise<void> {
  if (harness.capabilities.provider === 'sqlite') {
    await harness.executeFixtureDdl(
      `CREATE TRIGGER ${spec.name} ${beforeClause(spec)} ON ${spec.table} ` +
        `BEGIN SELECT RAISE(ABORT, '${spec.error}'); END`,
    )
    return
  }
  await harness.executeFixtureDdl(
    `CREATE OR REPLACE FUNCTION ${spec.name}() RETURNS trigger AS $$ ` +
      `BEGIN RAISE EXCEPTION '${spec.error}'; END; $$ LANGUAGE plpgsql`,
  )
  await harness.executeFixtureDdl(
    `CREATE TRIGGER ${spec.name} ${beforeClause(spec)} ON ${spec.table} ` +
      `FOR EACH ROW EXECUTE FUNCTION ${spec.name}()`,
  )
}

export async function dropAbortTrigger(
  harness: ProviderDatabaseHarness,
  spec: AbortTriggerSpec,
): Promise<void> {
  if (harness.capabilities.provider === 'sqlite') {
    await harness.executeFixtureDdl(`DROP TRIGGER IF EXISTS ${spec.name}`)
    return
  }
  await harness.executeFixtureDdl(`DROP TRIGGER IF EXISTS ${spec.name} ON ${spec.table}`)
  await harness.executeFixtureDdl(`DROP FUNCTION IF EXISTS ${spec.name}()`)
}
