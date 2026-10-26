import type { PostgresqlReservedConnection } from '../postgresqlRuntime'

function dollarQuote(text: string): string {
  let delimiter = '$aw_reference$'
  while (text.includes(delimiter)) delimiter = delimiter.replace('$aw_', '$aw_next_')
  return `${delimiter}${text}${delimiter}`
}

/** Reference compilation already owns a rollback-only transaction. Preserve statement order
 * while avoiding one network round trip for every table, index and trigger of every version. */
export async function executePostgresqlReferenceStatements(
  connection: Pick<PostgresqlReservedConnection, 'unsafe'>,
  statements: readonly string[],
): Promise<void> {
  const batchSize = 128
  for (let offset = 0; offset < statements.length; offset += batchSize) {
    const body = statements
      .slice(offset, offset + batchSize)
      .map((statement) => `EXECUTE ${dollarQuote(statement)};`)
      .join('\n')
    await connection.unsafe(`DO ${dollarQuote(`BEGIN\n${body}\nEND`)}`)
  }
}
