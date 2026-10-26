// RFC-395: the live registry is the default; synthetic/frozen tooling can supply --registry.
import { readFileSync } from 'node:fs'
import { EPOCH2_META_TABLES } from '../packages/backend/src/modules/system-operations/composition/schema'
import { HISTORY_META_TABLES } from '../packages/backend/src/platform/persistence/schema/history/meta'
import { SQL } from 'bun'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { SchemaRegistry } from '../packages/backend/src/platform/persistence/schema/registry'
import type { SchemaEdge } from '../packages/backend/src/platform/persistence/schema/history/types'
import {
  runSchemaHistoryCommand,
  generatePostgresqlCatalogArtifacts,
} from '../packages/backend/src/platform/persistence/schema/history/artifacts'

import { compilePostgresqlHistoryCatalog } from '../packages/backend/src/platform/persistence/schema/history/catalog'
import type { PostgresqlPool } from '../packages/backend/src/platform/persistence/postgresqlRuntime'

export async function schemaHistoryMain(argv: readonly string[]): Promise<void> {
  const args = [...argv]
  const option = (name: string): string | undefined => {
    const index = args.indexOf(name)
    if (index < 0) return undefined
    const value = args[index + 1]
    if (!value) throw new Error(`missing ${name} value`)
    args.splice(index, 2)
    return value
  }
  const registryPath = option('--registry')
  const exportName = option('--export') ?? (registryPath ? 'schemaRegistry' : 'persistenceSchema')
  const directory =
    option('--directory') ??
    resolve(import.meta.dir, '../packages/backend/db/schema-history/epoch2')
  const edgePath = option('--edge')
  const postgresqlUrlEnv = option('--postgresql-url-env')
  const postgresqlUrl = postgresqlUrlEnv
    ? process.env[postgresqlUrlEnv]
    : (process.env.AW_TEST_POSTGRESQL_URL ?? process.env.RFC357_DATABASE_URL)
  if (postgresqlUrlEnv && !postgresqlUrl) throw new Error(`missing ${postgresqlUrlEnv}`)
  const liveRegistryPath = resolve(
    import.meta.dir,
    '../packages/backend/src/bootstrap/persistenceSchema.ts',
  )
  const resolvedRegistryPath = registryPath ? resolve(registryPath) : liveRegistryPath
  const module = (await import(pathToFileURL(resolvedRegistryPath).href)) as Record<string, unknown>
  const registry = module[exportName] as SchemaRegistry | undefined
  if (!registry) throw new Error(`registry export missing: ${exportName}`)
  const paths = [
    ...runSchemaHistoryCommand(args[0] === '--catalog' ? ['--check'] : args, {
      registry,
      directory,
      ...(edgePath
        ? { explicitEdge: JSON.parse(readFileSync(edgePath, 'utf8')) as SchemaEdge }
        : {}),
    }),
  ]
  if (args[0] === '--catalog' && (args.length !== 1 || !postgresqlUrl))
    throw new Error('--catalog requires a PostgreSQL URL (--postgresql-url-env <name>)')
  const metaTables =
    resolvedRegistryPath === liveRegistryPath ? EPOCH2_META_TABLES : HISTORY_META_TABLES
  if (postgresqlUrl) {
    const url = new URL(postgresqlUrl)
    const admin = new SQL(url.toString(), { max: 1 })
    const name = `schema_history_${crypto.randomUUID().replaceAll('-', '')}`
    let scratch: SQL | undefined
    let created = false
    try {
      await admin.unsafe(`CREATE DATABASE "${name}"`)
      created = true
      url.pathname = `/${name}`
      scratch = new SQL(url.toString(), { max: 1 })
      const reference = await (scratch as unknown as PostgresqlPool).reserve()
      try {
        paths.push(
          ...(await generatePostgresqlCatalogArtifacts({
            directory,
            check: args[0] === '--check',
            metaTables,
            compile: (plan) => compilePostgresqlHistoryCatalog(reference, plan, metaTables),
          })),
        )
      } finally {
        reference.release()
      }
    } finally {
      await scratch?.close()
      try {
        if (created) await admin.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`)
      } finally {
        await admin.close()
      }
    }
  }
  console.info(
    paths.length ? paths.join('\n') : 'schema-history: registry head and artifacts match',
  )
}
if (import.meta.main) await schemaHistoryMain(process.argv.slice(2))
