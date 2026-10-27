import { canonicalSchemaJson, digestSchemaContract } from '../../schema/canonical'
import { readPostgresqlMajor } from '../../schema/history/catalog'
import { postgresqlHistoryConnection } from '../../schema/history/connection'
import { loadFrozenEpoch1History } from '../epoch1/bundle'
import {
  compileEpoch1PostgresqlCatalog,
  loadSupportedSourceManifest,
  type Epoch1PostgresqlCatalog,
} from '../supportedSources'
import { openPostgresqlScratch } from './postgresqlDatabases'

interface ReferenceCatalogs {
  readonly version: 1
  readonly chainDigest: string
  readonly postgresqlMajor: number
  readonly catalogs: readonly (Epoch1PostgresqlCatalog & { readonly planDigest: string })[]
}

/** Compile before the operation fills its scratch. The operation's durable artifact
 * store keeps these reference catalogs available to later CLI invocations and Jobs. */
export async function loadOperationSourceManifest(
  input: Omit<Parameters<typeof openPostgresqlScratch>[0], 'requireEmpty'> & {
    readonly cache: {
      read(name: string): Promise<Uint8Array | null>
      writeOnce(name: string, bytes: Uint8Array): Promise<unknown>
    }
  },
) {
  const { runtime, cache } = input
  try {
    const history = await loadFrozenEpoch1History()
    const major = await readPostgresqlMajor(postgresqlHistoryConnection(runtime.providerPool()))
    const name = `source-catalogs/${history.chainDigest.replace('sha256:', '')}-pg${major}.json`
    const bytes = await cache.read(name)
    let payload: ReferenceCatalogs
    if (bytes) {
      const stored = JSON.parse(Buffer.from(bytes).toString('utf8')) as {
        payload: ReferenceCatalogs
        digest: string
      }
      payload = stored.payload
      if (
        stored.digest !== digestSchemaContract(payload) ||
        payload.version !== 1 ||
        payload.chainDigest !== history.chainDigest ||
        payload.postgresqlMajor !== major ||
        payload.catalogs.length !== history.postgresql.versions.length ||
        payload.catalogs.some(
          (entry, index) =>
            entry.postgresqlMajor !== major ||
            entry.planDigest !== history.postgresql.versions[index]!.plan.digest,
        )
      )
        throw new Error(
          'epoch-1 reference catalog cache differs from frozen history or server major',
        )
    } else {
      await openPostgresqlScratch({ ...input, requireEmpty: true })
      const connection = await runtime.providerPool().reserve()
      const catalogs: ReferenceCatalogs['catalogs'][number][] = []
      try {
        for (const version of history.postgresql.versions)
          catalogs.push({
            ...(await compileEpoch1PostgresqlCatalog(connection, version)),
            planDigest: version.plan.digest,
          })
      } finally {
        connection.release()
      }
      payload = { version: 1, chainDigest: history.chainDigest, postgresqlMajor: major, catalogs }
      await cache.writeOnce(
        name,
        Buffer.from(canonicalSchemaJson({ payload, digest: digestSchemaContract(payload) })),
      )
    }
    return await loadSupportedSourceManifest({
      async postgresqlCatalog(version) {
        const catalog = payload.catalogs.find((entry) => entry.planDigest === version.plan.digest)
        if (!catalog) throw new Error('epoch-1 reference catalog missing')
        return catalog
      },
    })
  } finally {
    await runtime.close()
  }
}
