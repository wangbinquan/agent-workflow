import type { PostgresqlReservedConnection } from './postgresqlRuntime'
import { assertPostgresqlBusinessStatement, compilePostgresqlSql } from './postgresqlSql'
import type { OriginalReportReadChannel } from './reportSnapshotTypes'

/** The RPC host does not offer any original-table write operation. */
export function originalPostgresqlReportReadChannel(
  connection: PostgresqlReservedConnection,
  active: () => boolean,
  signal?: AbortSignal,
): OriginalReportReadChannel {
  function read(statement: string, parameters: readonly unknown[]) {
    if (!active()) throw new Error('Original report snapshot already closed')
    signal?.throwIfAborted()
    const compiled = compilePostgresqlSql(statement)
    if (assertPostgresqlBusinessStatement(compiled) !== 'read')
      throw new Error('Report input only supports original reads')
    return connection.unsafe(compiled, parameters)
  }
  return {
    objects: async (statement, parameters) => await read(statement, parameters),
    values: (statement, parameters) => read(statement, parameters).values(),
  }
}
