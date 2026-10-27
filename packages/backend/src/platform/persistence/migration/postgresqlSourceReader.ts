// RFC-395: physical PostgreSQL admission and row reads share one read-only snapshot.
import { createSha256DigestBuilder } from '@/util/hash'
import type { PostgresqlDatabaseRuntime, PostgresqlReservedConnection } from '../postgresqlRuntime'
import { canonicalSchemaJson, digestSchemaContract } from '../schema/canonical'
import { postgresqlHistoryConnection } from '../schema/history/connection'
import { readPostgresqlMajor } from '../schema/history/catalog'
import { collectSourceFingerprint, quoteSourceIdentifier as quote } from './sourceCatalog'
import { identifySource, type SupportedSourceManifest } from './supportedSources'
import type { EmptyTableDecision } from './sourceDispositions'
import { decodeLogicalValue, encodeLogicalRow } from './legacy/logicalDatabaseArtifact'
import { assertSourceChunkRequest, sourceChunk, sourceContentPresence } from './sourceReader'
import { rawSourceCell, rawSourceChunk } from './rawSourceReader'
import {
  SourceBlockedError,
  sourceFailure,
  type SourcePreflight,
  type SourceFingerprint,
  type SourceIdentityHighWater,
  type VersionedSourceReader,
} from './sourceTypes'

const qualified = (table: string) => table.split('.').map(quote).join('.')
async function identityHighWater(
  connection: PostgresqlReservedConnection,
  fingerprint: SourceFingerprint,
): Promise<readonly SourceIdentityHighWater[]> {
  const result: SourceIdentityHighWater[] = []
  for (const sequence of fingerprint.catalog.filter((row) => row.kind === 'sequence')) {
    const rows = await connection.unsafe(
      `SELECT last_value::text AS value, is_called FROM ${qualified(sequence.relation)}`,
    )
    const owner = fingerprint.catalog
      .find((row) => row.kind === 'sequence-owner' && row.relation === sequence.relation)
      ?.definition.split('.')
    result.push({
      name: sequence.relation,
      table: owner?.[1] ?? null,
      column: owner?.[2] ?? null,
      value: String(rows[0]!.value),
      isCalled: rows[0]!.is_called === true,
      increment: sequence.definition.split('|')[4]!,
    })
  }
  return result
}
/** The caller owns the source's repeatable-read, read-only transaction. */
export async function postgresqlSourceContentDigest(
  connection: Pick<PostgresqlReservedConnection, 'unsafe'>,
  fingerprint: SourceFingerprint,
  identities: readonly SourceIdentityHighWater[],
): Promise<string> {
  const hash = createSha256DigestBuilder()
  const frame = (value: unknown) => {
    const text = canonicalSchemaJson(value)
    hash.update(`${Buffer.byteLength(text)}:`)
    hash.update(text)
  }
  frame({ fingerprint, identities })
  for (const table of Object.keys(fingerprint.tableRows).sort()) {
    frame(table)
    // The fingerprint counts were read in this same repeatable-read transaction.
    // Empty tables still contribute their frame, but need no DECLARE/FETCH/CLOSE round trips.
    if (fingerprint.tableRows[table] === 0) continue
    // Keep the original text order/framing, with one scan in the caller's read-only transaction.
    await connection.unsafe(
      `DECLARE rfc395_source_digest NO SCROLL CURSOR FOR SELECT to_jsonb(t)::text AS value FROM ${qualified(table)} t ORDER BY to_jsonb(t)::text COLLATE "C", ctid`,
    )
    try {
      for (;;) {
        const rows = await connection.unsafe('FETCH FORWARD 1000 FROM rfc395_source_digest')
        for (const row of rows) frame(row.value)
        if (rows.length < 1000) break
      }
    } catch (error) {
      try {
        await connection.unsafe('CLOSE rfc395_source_digest')
      } catch {
        // A failed fetch may abort the transaction; its rollback also releases the cursor.
      }
      throw error
    }
    await connection.unsafe('CLOSE rfc395_source_digest')
  }
  return `sha256:${hash.digestHex()}`
}
export function openEpoch1PostgresqlSource(input: {
  readonly runtime: PostgresqlDatabaseRuntime
  readonly manifest: SupportedSourceManifest
  readonly sourceGenerationId?: string
  readonly contentRoot: string
  readonly emptyTables?: readonly EmptyTableDecision[]
}): VersionedSourceReader {
  let connection: PostgresqlReservedConnection | undefined
  let snapshot: SourcePreflight | undefined
  let pending: Promise<SourcePreflight> | undefined
  let refresh: Promise<void> | undefined
  let closed = false
  const assertOpen = () => {
    if (closed) throw new SourceBlockedError('Source reader is closed')
  }
  const measure = async (session: PostgresqlReservedConnection) => {
    const fingerprint = await collectSourceFingerprint(postgresqlHistoryConnection(session))
    const identities = await identityHighWater(session, fingerprint)
    const generations = Object.hasOwn(
      fingerprint.tableRows,
      'agent_workflow_meta.database_generations',
    )
      ? await session.unsafe(
          "SELECT generation_id FROM agent_workflow_meta.database_generations WHERE state='active' ORDER BY generation_id",
        )
      : []
    if (generations.length > 1)
      throw new SourceBlockedError('PostgreSQL source has multiple active generations')
    const content = await postgresqlSourceContentDigest(session, fingerprint, identities)
    const generation =
      generations[0]?.generation_id ??
      input.sourceGenerationId ??
      `dbg_epoch1_${content.slice(7, 31)}`
    if (input.sourceGenerationId && generation !== input.sourceGenerationId)
      throw new SourceBlockedError('PostgreSQL source generation differs from the plan')
    return {
      fingerprint,
      identities,
      generation: String(generation),
      watermark: digestSchemaContract({ content, generation }),
    }
  }
  const reader: VersionedSourceReader = {
    kind: 'postgresql-database',
    async preflight() {
      assertOpen()
      if (snapshot) {
        await reader.assertUnchanged(snapshot)
        return snapshot
      }
      if (pending) return pending
      pending = (async () => {
        connection = await input.runtime.providerPool().reserve()
        await connection.unsafe('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
        await connection.unsafe('SET LOCAL search_path TO agent_workflow, public')
        const fingerprint = await collectSourceFingerprint(postgresqlHistoryConnection(connection))
        const identified = identifySource({
          fingerprint,
          manifest: input.manifest,
          emptyTables: input.emptyTables,
          postgresqlMajor: await readPostgresqlMajor(postgresqlHistoryConnection(connection)),
        })
        const measured = await measure(connection)
        snapshot = {
          version: 1,
          kind: reader.kind,
          sourceVersion: identified.source.id,
          contract: identified.source.contract,
          fingerprint,
          sourceGenerationId: measured.generation,
          identityHighWater: measured.identities,
          identityEvidence: 'physical',
          watermark: measured.watermark,
          requiresOfflineUpgrade: identified.source.contract?.digest !== input.manifest.headDigest,
          tables: identified.tables,
          expectedAbsent: identified.source.expectedAbsent,
          content: sourceContentPresence({ root: input.contentRoot, kind: reader.kind }),
        }
        return snapshot
      })()
        .catch(async (error: unknown) => {
          if (connection) {
            try {
              await connection.unsafe('ROLLBACK')
            } finally {
              connection.release()
              connection = undefined
            }
          }
          throw sourceFailure(error)
        })
        .finally(() => {
          pending = undefined
        })
      return pending
    },
    async assertUnchanged(expected) {
      assertOpen()
      if (
        !snapshot ||
        expected.watermark !== snapshot.watermark ||
        expected.sourceGenerationId !== snapshot.sourceGenerationId ||
        expected.fingerprint.digest !== snapshot.fingerprint.digest
      )
        throw new SourceBlockedError('PostgreSQL source preflight differs from the plan')
      if (!connection) throw new SourceBlockedError('PostgreSQL source snapshot is unavailable')
      if (refresh) return refresh
      const probe = connection
      const watermark = snapshot.watermark
      refresh = (async () => {
        await probe.unsafe('ROLLBACK')
        await probe.unsafe('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
        await probe.unsafe('SET LOCAL search_path TO agent_workflow, public')
        if ((await measure(probe)).watermark !== watermark)
          throw new SourceBlockedError('PostgreSQL source changed after preflight; freeze again')
      })()
        .catch((error: unknown) => {
          throw sourceFailure(error)
        })
        .finally(() => {
          refresh = undefined
        })
      return refresh
    },
    async readChunk(tableId, afterKey, limit) {
      assertOpen()
      if (!snapshot || !connection)
        throw new SourceBlockedError('Call source preflight before readChunk')
      const table = snapshot.contract?.tables.find((table) => table.id === tableId)
      if (!table || !table.providerTables.postgresql)
        throw new SourceBlockedError(
          `No frozen row codec for ${tableId}; use readRawChunk for its disposition`,
        )
      assertSourceChunkRequest(table, afterKey, limit)
      // ORDER BY resolves bare names to output aliases: our lossless int8 text
      // projection must not turn numeric keys into locale-sorted strings.
      // Both pagination and ordering use the source column and the codec's
      // byte order for text, independently of the database's default locale.
      const order = table.migrationKey
        .map((name) => {
          const column = table.columns.find((column) => column.name === name)!
          const text = ['text', 'text-identity', 'json-text'].includes(column.logicalCodec)
          return `s.${quote(name)}${text ? ' COLLATE "C"' : ''}`
        })
        .join(', ')
      const where =
        afterKey === null
          ? ''
          : ` WHERE (${order}) > (${afterKey.map((_, i) => `$${i + 1}`).join(', ')})`
      // Cast int8/numeric to text before the driver; JSON text stays original text.
      const columns = table.columns
        .map(
          (column) =>
            `s.${quote(column.name)}${['integer', 'epoch-milliseconds'].includes(column.logicalCodec) ? '::text' : ''} AS ${quote(column.name)}`,
        )
        .join(', ')
      try {
        const rows = await connection.unsafe(
          `SELECT ${columns} FROM ${qualified(`agent_workflow.${table.providerTables.postgresql}`)} s${where} ORDER BY ${order} LIMIT ${limit}`,
          afterKey?.map(decodeLogicalValue) ?? [],
        )
        return sourceChunk({
          sourceVersion: snapshot.sourceVersion,
          table,
          afterKey,
          rows: rows.map((row) => encodeLogicalRow(table, row)),
        })
      } catch (error) {
        throw sourceFailure(error)
      }
    },
    async readRawChunk(tableId, afterKey, limit) {
      assertOpen()
      if (!snapshot || !connection)
        throw new SourceBlockedError('Call source preflight before readRawChunk')
      const table = snapshot.tables.find((table) => table.table === tableId)
      if (!table || table.disposition === 'blocked')
        throw new SourceBlockedError(`No admitted raw source table ${tableId}`)
      const migrationKey = ['$ordinal']
      assertSourceChunkRequest({ id: tableId, migrationKey }, afterKey, limit)
      const offset = afterKey ? Number(decodeLogicalValue(afterKey[0]!)) : 0
      if (!Number.isSafeInteger(offset) || offset < 0)
        throw new SourceBlockedError('Invalid raw PostgreSQL cursor')
      const fields = await connection.unsafe(
        'SELECT a.attname AS name, format_type(a.atttypid,a.atttypmod) AS type FROM pg_attribute a WHERE a.attrelid=$1::regclass AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum',
        [table.physicalTable],
      )
      const selections = fields
        .map((field, i) => `t.${quote(String(field.name))}::text AS ${quote(`v${i}`)}`)
        .join(', ')
      const rows = await connection.unsafe(
        `SELECT ${selections} FROM ${qualified(table.physicalTable)} t ORDER BY to_jsonb(t)::text COLLATE "C", ctid LIMIT ${limit} OFFSET ${offset}`,
      )
      return rawSourceChunk({
        sourceVersion: snapshot.sourceVersion,
        table: tableId,
        migrationKey,
        afterKey,
        rows: rows.map((row, i) => ({
          key: [{ type: 'integer', value: String(offset + i + 1) }],
          cells: Object.fromEntries(
            fields.map((field, j) => [
              String(field.name),
              rawSourceCell(String(field.type), row[`v${j}`]),
            ]),
          ),
        })),
      })
    },
    async close() {
      if (closed) return
      try {
        await pending
        await refresh
      } catch {
        /* preflight already released */
      }
      closed = true
      if (connection) {
        try {
          await connection.unsafe('ROLLBACK')
        } finally {
          connection.release()
          connection = undefined
        }
      }
    },
  }
  return reader
}
