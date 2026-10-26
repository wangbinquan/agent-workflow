import { postgresqlHistorySession } from '@/platform/persistence/postgresql/historySession'
import { createRestoreSuccessor } from './rfc395V3/successor'
// Build a real expand-only successor and its server-derived catalog for hosted admission tests.
import { SQL } from 'bun'
import { randomUUID } from 'node:crypto'
import { persistenceHead } from '@/bootstrap/persistenceHead'
import { EPOCH2_META_TABLES } from '@/modules/system-operations/infrastructure/persistence/migrationMetaTables'
import { compilePostgresqlHistoryCatalog } from '@/platform/persistence/schema/history/catalog'
import { applyHistoryVersion } from '@/platform/persistence/schema/history/apply'
import type {
  PostgresqlDatabaseRuntime,
  PostgresqlPool,
} from '@/platform/persistence/postgresqlRuntime'

export async function appendHostedSuccessor(runtime: PostgresqlDatabaseRuntime, url: string) {
  const version = createRestoreSuccessor(
    persistenceHead(),
    'rfc370_successor_probe',
    'hosted-successor',
  )
  const databaseName = `mc_catalog_${randomUUID().replaceAll('-', '')}`
  const admin = new SQL(url, { max: 1 })
  let reference: SQL | undefined
  try {
    await admin.unsafe(`CREATE DATABASE "${databaseName}"`)
    const referenceUrl = new URL(url)
    referenceUrl.pathname = `/${databaseName}`
    reference = new SQL(referenceUrl.toString(), { max: 1 })
    const connection = await (reference as unknown as PostgresqlPool).reserve()
    try {
      const complete = {
        ...version,
        postgresqlCatalog: await compilePostgresqlHistoryCatalog(
          connection,
          version.postgresql,
          EPOCH2_META_TABLES,
        ),
      }
      await applyHistoryVersion(postgresqlHistorySession(runtime.providerPool()), {
        version: complete,
        metaTables: EPOCH2_META_TABLES,
      })
      await runtime
        .providerPool()
        .unsafe(
          "UPDATE agent_workflow_meta.generations SET contract_digest=$1,plan_digest=$2 WHERE state='active'",
          [complete.contract.contract.digest, complete.postgresql.digest],
        )
      return complete
    } finally {
      connection.release()
    }
  } finally {
    await reference?.close()
    await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`)
    await admin.close()
  }
}
