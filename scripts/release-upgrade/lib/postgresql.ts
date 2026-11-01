import { SQL } from 'bun'
import { randomBytes } from 'node:crypto'

const quote = (identifier: string) => `"${identifier.replaceAll('"', '""')}"`
export interface PostgresqlFixture {
  url: string
  database: string
  role: string | null
  /** Explicit cleanup; never called on a failed migration automatically. */
  dispose(derivedDatabases?: string[]): Promise<void>
}

/** For later L2 orchestration. All names are new; no existing database is reused. */
export async function provisionPostgresqlFixture(
  adminUrl: string,
  restricted = false,
): Promise<PostgresqlFixture> {
  const suffix = randomBytes(8).toString('hex')
  const database = `aw_upgrade_${suffix}`
  const role = restricted ? `aw_upgrade_role_${suffix}` : null
  const password = randomBytes(24).toString('hex')
  const admin = new SQL(adminUrl, { max: 1 })
  try {
    if (role)
      await admin.unsafe(
        `CREATE ROLE ${quote(role)} LOGIN PASSWORD '${password}' NOCREATEDB NOSUPERUSER NOCREATEROLE`,
      )
    await admin.unsafe(
      `CREATE DATABASE ${quote(database)}${role ? ` OWNER ${quote(role)}` : ''} TEMPLATE template0 ENCODING 'UTF8'`,
    )
  } finally {
    await admin.close()
  }
  const location = new URL(adminUrl)
  location.pathname = `/${database}`
  if (role) {
    location.username = role
    location.password = password
  }
  return {
    url: location.toString(),
    database,
    role,
    async dispose(derivedDatabases = []) {
      const connection = new SQL(adminUrl, { max: 1 })
      try {
        for (const derived of new Set(derivedDatabases)) {
          if (!derived.startsWith(`${database}_epoch2`))
            throw new Error(`Unexpected fixture database: ${derived}`)
          await connection.unsafe(`DROP DATABASE IF EXISTS ${quote(derived)} WITH (FORCE)`)
        }
        await connection.unsafe(`DROP DATABASE ${quote(database)} WITH (FORCE)`)
        if (role) await connection.unsafe(`DROP ROLE ${quote(role)}`)
      } finally {
        await connection.close()
      }
    },
  }
}

/** Consume the candidate's printed SQL, not a separately reconstructed approximation. */
export function printedDatabaseStatements(output: string): string[] {
  const statements = new Set<string>()
  const seen = new Set<string>()
  const collect = (text: string, depth = 0) => {
    if (depth > 8 || seen.has(text)) return
    seen.add(text)
    for (const line of text.split('\n')) {
      const start = line.indexOf('CREATE DATABASE "')
      if (start >= 0 && line.trimEnd().endsWith(';')) statements.add(line.slice(start).trim())
    }
    // Plain start relays the child's JSON conclusion. Its guidance contains an
    // error message with another JSON object, so decode strings layer by layer.
    for (const match of text.matchAll(/"(?:\\.|[^"\\])*"/g)) {
      let decoded: string
      try {
        decoded = JSON.parse(match[0]) as string
      } catch {
        continue // Mixed human-readable log lines need not be JSON strings.
      }
      if (decoded.startsWith('CREATE DATABASE ') && decoded.endsWith(';')) statements.add(decoded)
      else if (decoded.includes('CREATE DATABASE ')) collect(decoded, depth + 1)
    }
  }
  collect(output)
  if (statements.size !== 2)
    throw new Error(`Expected both DBA CREATE DATABASE statements, found ${statements.size}`)
  return [...statements]
}

export async function executeDatabaseStatements(
  adminUrl: string,
  statements: string[],
  fixture: PostgresqlFixture,
): Promise<void> {
  const sql = new SQL(adminUrl, { max: 1 })
  try {
    for (const statement of statements) {
      if (
        !statement.startsWith(`CREATE DATABASE "${fixture.database}_epoch2`) ||
        !statement.includes(`OWNER ${quote(fixture.role!)}`)
      )
        throw new Error('DBA statement does not target this fixture and its restricted owner')
      await sql.unsafe(statement)
    }
  } finally {
    await sql.close()
  }
}

export async function inspectPostgresqlRole(
  url: string,
): Promise<{ database: string; user: string; canCreateDatabase: boolean }> {
  const sql = new SQL(url, { max: 1 })
  try {
    const [row] = await sql.unsafe(
      'SELECT current_database() AS database, current_user AS username, (rolcreatedb OR rolsuper) AS can_create FROM pg_roles WHERE rolname = current_user',
    )
    if (!row) throw new Error('PostgreSQL current role is missing')
    return {
      database: String(row.database),
      user: String(row.username),
      canCreateDatabase: Boolean(row.can_create),
    }
  } finally {
    await sql.close()
  }
}
