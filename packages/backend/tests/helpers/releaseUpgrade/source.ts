// RFC-398 S1-S3: the reader proves the census; independent SQL/seed rows supply values.
import type { FrozenSourceHandle } from '@/platform/persistence/migration/run/types'
import type { CanonicalLogicalValue } from '@/platform/persistence/migration/legacy/logicalDatabaseArtifact'
import { loadFrozenEpoch1History } from '@/platform/persistence/migration/epoch1/bundle'
import { frozenEpoch1Contract } from '@/platform/persistence/migration/epoch1/contract'
import type {
  RawSourceRow,
  SourcePreflight,
  VersionedSourceReader,
} from '@/platform/persistence/migration/sourceTypes'
import type { BuiltRelease } from './build'
import type { OracleEntry } from './oracle'
import { readOracle } from './oracle'
import {
  encodedKey,
  equal,
  invariant,
  logicalKeys,
  sortedRows,
  type Row,
  type Snapshot,
} from './data'

export interface SourceTable {
  entry: OracleEntry
  /** Independent reconstruction for logical rows; raw phases are value-checked against it. */
  rows: Row[]
  keys: string[]
  raw: (RawSourceRow | null)[]
}
export interface SourceCensus {
  tables: SourceTable[]
  current: Snapshot
  identity: { sourceContractDigest: string; sourceGenerationId: string }
}
function decode(value: CanonicalLogicalValue): unknown {
  switch (value.type) {
    case 'null':
      return null
    case 'integer':
      return BigInt(value.value)
    case 'real':
      return Number(value.value)
    case 'bytes':
      return Buffer.from(value.value, 'base64')
    default:
      return value.value
  }
}

/** Reads only input ports. SQL reconstruction is the independent business-row oracle. */
export async function captureSource(
  source: FrozenSourceHandle,
  built: Pick<BuiltRelease, 'release' | 'provider' | 'before' | 'contract'>,
  expected: { rows: Snapshot },
): Promise<SourceCensus> {
  const oracle = readOracle(),
    tables: SourceTable[] = [],
    current: Snapshot = new Map()
  const history = await loadFrozenEpoch1History()
  const present = new Set(source.preflight.tables.map((t) => t.table))
  async function phase(
    reader: VersionedSourceReader,
    preflight: SourcePreflight,
    name: 'current' | 'pre-upgrade',
  ) {
    for (const table of preflight.tables) {
      const contract = frozenEpoch1Contract.tables.find((t) => t.id === table.table)
      if (name === 'pre-upgrade' && present.has(table.table) && contract) continue
      const candidates = oracle.filter((e) => e.table === table.table && e.sourcePhase === name)
      // A PG bridge reads SQLite rows although the installation identity remains PG.
      const entry =
        candidates.find(
          (e) =>
            !e.provider ||
            e.provider ===
              (table.physicalTable.startsWith('agent_workflow') ? 'postgresql' : 'sqlite'),
        ) ?? candidates[0]
      invariant(entry, `oracle omits ${name}/${table.table}`)
      const logical = name === 'current' && !!contract
      const rows: Row[] = [],
        keys: string[] = [],
        raw: (RawSourceRow | null)[] = []
      let cursor: readonly CanonicalLogicalValue[] | null = null
      for (;;) {
        if (logical) {
          const chunk = await reader.readChunk(table.table, cursor, 1000)
          if (!chunk.rows.length) break
          rows.push(...chunk.decodedRows)
          keys.push(...logicalKeys(contract!, chunk.decodedRows))
          raw.push(...chunk.rows.map(() => null))
          cursor = chunk.lastKey
        } else {
          const chunk = await reader.readRawChunk(table.table, cursor, 1000)
          if (!chunk.rows.length) break
          for (const row of chunk.rows) {
            rows.push(
              Object.fromEntries(
                Object.entries(row.cells).map(([column, cell]) => [column, decode(cell.value)]),
              ),
            )
            // Re-encode and hash input keys independently; do not import conversion
            // migrationKey/hash functions or consume trace/replayed dispositions.
            keys.push(encodedKey(table.table, row.key))
            raw.push(row)
          }
          cursor = chunk.lastKey
        }
      }
      equal(rows.length, table.rows, `S1 input census ${name}/${table.table}`)
      if (logical) {
        const wanted = expected.rows.get(table.table) ?? []
        // Keep the reader's ordering only. S3 values must come from the seed/SQL
        // reconstruction even when the reader and converter agree on corruption.
        equal(rows.length, wanted.length, `S1 independent SQL/seed census ${table.table}`)
        equal(
          [...keys].sort(),
          logicalKeys(contract!, wanted).sort(),
          `S1 independent SQL/seed keys ${table.table}`,
        )
        const independent = new Map(
          logicalKeys(contract!, wanted).map((key, i) => [key, wanted[i]!]),
        )
        rows.splice(0, rows.length, ...keys.map((key) => structuredClone(independent.get(key)!)))
        current.set(table.table, rows)
      } else if (name === 'pre-upgrade' && built.provider === 'sqlite') {
        equal(
          sortedRows(rows),
          sortedRows(built.before.get(table.table) ?? []),
          `S1 untouched pre-upgrade ${table.table}`,
        )
      } else if (name === 'pre-upgrade' && table.physicalTable.startsWith('agent_workflow')) {
        const before = built.before.get(table.table) ?? built.before.get(`aw_meta_${table.table}`)
        invariant(before, `S1 original PG table absent ${table.table}`)
        // The raw PG port reads column::text in deterministic catalog order.
        const textRows = before.map((row) =>
          Object.fromEntries(
            Object.entries(row).map(([key, value]) => [
              key,
              value === null
                ? null
                : value instanceof Uint8Array
                  ? `\\x${Buffer.from(value).toString('hex')}`
                  : String(value),
            ]),
          ),
        )
        equal(
          sortedRows(rows),
          sortedRows(textRows),
          `S1 untouched original PG metadata ${table.table}`,
        )
      }
      if (name === 'current' && !logical) {
        if (table.physicalTable.startsWith('agent_workflow')) {
          const tail = history.postgresql.versions.length - built.release.epoch1!.postgresql!.length
          const counts: Record<string, number> = {
            schema_contract: 1,
            schema_migrations: 1 + tail,
            logical_copy_operations: 1,
            database_generations: 0,
            logical_copy_chunks: built
              .contract!.tables.filter((t) => t.providerTables.postgresql)
              .reduce(
                (total, t) => total + Math.ceil((built.before.get(t.id)?.length ?? 0) / 1000),
                0,
              ),
          }
          invariant(table.table in counts, `S1 unknown scratch metadata ${table.table}`)
          equal(
            rows.length,
            counts[table.table],
            `S1 independently derived PG scratch metadata ${table.table}`,
          )
        } else {
          equal(
            sortedRows(rows),
            sortedRows(expected.rows.get(table.table) ?? []),
            `S1 independent SQLite metadata ${table.table}`,
          )
        }
      }
      if (!logical && table.physicalTable.startsWith('agent_workflow')) {
        equal(
          keys,
          rows.map((_, i) => encodedKey(table.table, [{ type: 'integer', value: String(i + 1) }])),
          `S2 independent ordinal raw PG keys ${table.table}`,
        )
      }
      tables.push({ entry, rows, keys, raw })
    }
  }
  await phase(source.reader, source.preflight, 'current')
  if (source.preUpgrade)
    await phase(source.preUpgrade.reader, source.preUpgrade.preflight, 'pre-upgrade')
  const sqliteCurrent =
    built.provider === 'sqlite' || built.release.epoch1!.postgresqlSource === 'released-baseline'
  const wantedCurrent = sqliteCurrent
    ? [...expected.rows.keys()]
    : [
        ...frozenEpoch1Contract.tables.filter((t) => t.providerTables.postgresql).map((t) => t.id),
        'schema_contract',
        'schema_migrations',
        'logical_copy_operations',
        'logical_copy_chunks',
        'database_generations',
      ]
  equal(
    tables
      .filter((t) => t.entry.sourcePhase === 'current')
      .map((t) => t.entry.table)
      .sort(),
    wantedCurrent.sort(),
    'S1 independent current table roster',
  )
  // Every original retired/metadata table needs its original phase, even when
  // the candidate source reader accidentally omits it from its own preflight.
  for (const table of built.before.keys()) {
    const name = built.provider === 'postgresql' ? table.replace(/^aw_meta_/, '') : table
    if (frozenEpoch1Contract.tables.some((t) => t.id === name) && wantedCurrent.includes(name))
      continue
    invariant(
      tables.some((t) => t.entry.sourcePhase === 'pre-upgrade' && t.entry.table === name),
      `S1 original source table omitted: pre-upgrade/${name}`,
    )
  }
  return {
    tables,
    current,
    identity: {
      sourceContractDigest: frozenEpoch1Contract.digest,
      sourceGenerationId: source.preflight.sourceGenerationId,
    },
  }
}
