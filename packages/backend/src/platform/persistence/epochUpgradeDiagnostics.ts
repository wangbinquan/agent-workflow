// RFC-398 design §1 / §6: native source/version and database-provisioning diagnostics.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseConfig } from '@agent-workflow/shared'
import { openSqliteForRead } from './sqlite/openForRead'
import { createPostgresqlDatabaseRuntime } from './postgresqlRuntime'
import { unhandledDatabaseProvider } from './databaseProviders'
import { autoUpgradeDatabaseName } from './migration/postgresqlProvisioningPolicy'

export async function epochSourceDiagnostics(input: {
  readonly appHome: string
  readonly database: DatabaseConfig
  readonly autoUpgradeRoot: string
  readonly session?: {
    readonly operationId: string
    readonly unfinished: boolean
    /** The journal's current run; a source change appends a newer target for the same session. */
    readonly currentRunId?: string | null
  }
}): Promise<string[]> {
  const lines: string[] = []
  switch (input.database.provider) {
    case 'sqlite': {
      const path = join(input.appHome, 'db.sqlite')
      if (existsSync(path)) {
        const db = openSqliteForRead(path)
        try {
          if (db.query("SELECT 1 FROM sqlite_schema WHERE name='__drizzle_migrations'").get()) {
            const receipt = db
              .query(
                'SELECT count(*) AS migrations, max(created_at) AS last FROM __drizzle_migrations',
              )
              .get()
            lines.push(`source version (frozen migration receipts): ${JSON.stringify(receipt)}`)
          }
        } finally {
          db.close()
        }
      }
      break
    }
    case 'postgresql': {
      const runtime = createPostgresqlDatabaseRuntime({
        config: input.database,
        generationId: 'dbg_epoch1_doctor',
      })
      try {
        const pool = runtime.providerPool('migration')
        const identity = (
          await pool.unsafe(
            'SELECT current_database() AS database, rolcreatedb OR rolsuper AS can_create FROM pg_roles WHERE rolname = current_user',
          )
        )[0]!
        const root = join(input.autoUpgradeRoot, 'allocations')
        const allocations = existsSync(root)
          ? readdirSync(root)
              .filter((name) => /^\d+\.json$/.test(name))
              .map(
                (name) =>
                  JSON.parse(readFileSync(join(root, name), 'utf8')) as {
                    n: number
                    kind: 'target' | 'scratch'
                    database: string
                    sessionOperationId: string
                    runId: string
                  },
              )
              .sort((a, b) => a.n - b.n)
          : []
        let n = Math.max(0, ...allocations.map((a) => a.n))
        const own = allocations.filter(
          (a) => a.sessionOperationId === input.session?.operationId && input.session.unfinished,
        )
        const currentRunId = input.session?.currentRunId ?? null
        const names = (['target', 'scratch'] as const).map(
          (kind) =>
            // Latest row wins (re-selection appends); a target must belong to the current run.
            own
              .filter(
                (a) =>
                  a.kind === kind &&
                  (kind === 'scratch' || currentRunId === null || a.runId === currentRunId),
              )
              .at(-1)?.database ??
            autoUpgradeDatabaseName(
              String(identity.database),
              kind,
              ++n,
              !allocations.some((a) => a.kind === kind),
            ),
        )
        const existing = await pool.unsafe(
          'SELECT datname FROM pg_database WHERE datname IN ($1,$2)',
          names,
        )
        lines.push(
          `actual database: ${identity.database}; target: ${names[0]}; scratch: ${names[1]} (retained for trace --replay)`,
        )
        lines.push(
          `CREATE DATABASE permission: ${identity.can_create ? 'available' : existing.length === 2 ? 'not required; both allocated databases exist' : 'unavailable; start / migrate will print executable DBA statements'}`,
        )
        const history = await pool.unsafe(
          'SELECT baseline_id, contract_digest FROM agent_workflow_meta.schema_migrations ORDER BY applied_at',
        )
        lines.push(`source version: ${JSON.stringify(history)}`)
        if (history.some((r) => /^(sha256:)?(05a9771c|3ee9be23)/.test(String(r.contract_digest))))
          lines.push(
            'v0.18.18 / v0.18.19 PostgreSQL source: upgrade uses the frozen SQLite@0223 bridge.',
          )
        for (const allocation of allocations) {
          const size = await pool.unsafe(
            'SELECT pg_database_size(oid) AS bytes FROM pg_database WHERE datname=$1',
            [allocation.database],
          )
          lines.push(
            `retained ${allocation.kind}: ${allocation.database}; bytes=${size[0]?.bytes ?? 'absent'}; ${allocation.kind === 'scratch' ? 'trace --replay' : 'migration generation'}`,
          )
        }
      } finally {
        await runtime.close()
      }
      break
    }
    default:
      return unhandledDatabaseProvider(input.database)
  }
  return lines
}
