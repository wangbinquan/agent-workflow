// RFC-398 §7.5: mutation-sensitive identification proofs on caller-owned copies.
import { Database } from 'bun:sqlite'
import {
  compileEpoch1PostgresqlCatalog,
  identifySource,
  loadSupportedSourceManifest,
} from '@/platform/persistence/migration/supportedSources'
import { collectSourceFingerprint } from '@/platform/persistence/migration/sourceCatalog'
import { postgresqlHistoryConnection } from '@/platform/persistence/schema/history/connection'
import { SourceBlockedError } from '@/platform/persistence/migration/sourceTypes'
import type { BuiltRelease } from './build'
import { invariant } from './data'

function rejected(action: () => unknown, label: string): void {
  let error: unknown
  try {
    action()
  } catch (failure) {
    error = failure
  }
  invariant(
    error instanceof SourceBlockedError,
    `${label}: expected source identification failure, got ${String(error)}`,
  )
}
export async function missingAliasProof(built: BuiltRelease): Promise<void> {
  if (
    built.provider !== 'sqlite' ||
    !built.release.releasedSql.some((r) => r.migration === '0111_rfc223_agent_refs_to_id')
  )
    return
  const manifest = await loadSupportedSourceManifest(),
    copy = structuredClone(manifest)
  const receipt = built.release.epoch1!.sqlite.find(
    (entry) => entry.tag === '0111_rfc223_agent_refs_to_id',
  )!
  // The compiled manifest indexes aliases by receipt timestamp, not SQL tag.
  const identity = String(receipt.created_at)
  invariant(copy.sqliteJournalAliases[identity]?.includes(receipt.hash), '0111 alias is present')
  delete (copy.sqliteJournalAliases as Record<string, readonly string[]>)[identity]
  const db = new Database(built.sourcePath)
  try {
    const fingerprint = collectSourceFingerprint(db)
    identifySource({ fingerprint, manifest })
    rejected(
      () => identifySource({ fingerprint, manifest: copy }),
      `${built.release.tag}: missing 0111 alias`,
    )
  } finally {
    db.close()
  }
}
export async function missingBridgeProof(built: BuiltRelease): Promise<void> {
  if (
    built.release.epoch1?.postgresqlSource !== 'released-baseline' ||
    built.provider !== 'postgresql'
  )
    return
  const pg = built.pg!,
    reference = await pg.create()
  // Both runtimes close before the upgrade starts: Bun.SQL fills each pool to poolMax on first
  // use, and two idle 16-connection pools pushed the v0.18.19 case past CI's default
  // max_connections=100 (53300 "too many clients", CI run 41287820486 shard 12).
  const referenceRuntime = pg.runtime(reference.database)
  const sourceRuntime = pg.runtime(built.database!.database)
  try {
    const compiler = await referenceRuntime.providerPool().reserve()
    try {
      const manifest = await loadSupportedSourceManifest({
        postgresqlCatalog: (version) => compileEpoch1PostgresqlCatalog(compiler, version),
      })
      const connection = await sourceRuntime.providerPool().reserve()
      try {
        const fingerprint = await collectSourceFingerprint(postgresqlHistoryConnection(connection))
        identifySource({ fingerprint, manifest })
        const copy = {
          ...manifest,
          sources: manifest.sources.filter((source) => source.readMode !== 'logical-bridge'),
        }
        rejected(
          () => identifySource({ fingerprint, manifest: copy }),
          `${built.release.tag}: missing released PG bridges`,
        )
      } finally {
        connection.release()
      }
    } finally {
      compiler.release()
    }
  } finally {
    await Promise.all([referenceRuntime.close(), sourceRuntime.close()])
  }
}
