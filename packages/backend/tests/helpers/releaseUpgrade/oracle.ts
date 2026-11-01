// RFC-398 §7.4 S1–S3: expectations come from source SQL and the authored mapping oracle.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { canonicalSchemaJson } from '@/platform/persistence/schema/canonical'
import { persistenceHead } from '@/bootstrap/persistenceHead'
import { decodeContentRefColumns } from '@/platform/content/contentRefCodec'
import { frozenEpoch1Contract } from '@/platform/persistence/migration/epoch1/contract'
import { FIXTURES, sha256 } from '../../../../../scripts/release-upgrade/lib/io'
import type { BuiltRelease } from './build'
import type { SourceCensus } from './source'
import {
  equal,
  invariant,
  encodedKey,
  keyCell,
  keyDigest,
  normalized,
  logicalValues,
  type Row,
  type Snapshot,
} from './data'
import { checkProjections, destinationRows, checkRunRestrictions } from './projections'
import {
  normalizeSqlLogicalValues,
  normalizeSqlRow,
  normalizeSqlValue,
  checkSqlGeneratedRelationships,
} from './sqlNormalization'
import type { CanonicalLogicalValue } from '@/platform/persistence/migration/legacy/logicalDatabaseArtifact'

export interface Destination {
  table: string
  key: Record<
    string,
    { sourceColumn?: string; literal?: unknown; context?: string; projection?: string }
  >
  preserveColumns: string[]
  targetKeyColumns: string[]
}
export interface OracleEntry {
  table: string
  provider?: 'sqlite' | 'postgresql'
  sourcePhase: 'current' | 'pre-upgrade'
  disposition: 'converted' | 'preserved' | 'archived' | 'metadata' | 'history-only'
  sourceKey: string[]
  destinations?: Destination[]
  projections?: {
    sourceColumns: string[]
    destinationTables: string[]
    rule: string
    codec?: string
  }[]
  conditionalDispositions?: unknown[]
}
export function readOracle(): OracleEntry[] {
  const oracle = JSON.parse(readFileSync(join(FIXTURES, 'mapping-oracle.json'), 'utf8')) as {
    authority: string
    entries: OracleEntry[]
  }
  equal(oracle.authority, 'independent-rfc395-specification', 'independent mapping authority')
  return oracle.entries
}
export function assertOracleCoverage(
  snapshot: Snapshot,
  provider: 'sqlite' | 'postgresql',
  entries = readOracle(),
): void {
  for (const table of snapshot.keys()) {
    const name = table.replace(/^aw_meta_/, '')
    invariant(
      entries.some(
        (e) => (e.table === table || e.table === name) && (!e.provider || e.provider === provider),
      ),
      `oracle omits ${provider}/${table}`,
    )
  }
}
function same(a: unknown, b: unknown): boolean {
  return canonicalSchemaJson(normalized(a)) === canonicalSchemaJson(normalized(b))
}
export function codecValue(table: string, column: string, value: unknown): unknown {
  const definition = persistenceHead().contract.contract.tables.find((t) => t.id === table)
  const codec =
    definition && Object.values(definition.columns).find((c) => c.name === column)?.codec
  return codec === 'bool' && value !== null ? Boolean(value) : value
}
function countClass(entry: OracleEntry): string {
  return entry.disposition === 'metadata' || entry.disposition === 'history-only'
    ? 'converted'
    : entry.disposition
}
function expectedRowClass(entry: OracleEntry, row: Row): string {
  if (
    entry.table === 'cached_repos' &&
    typeof row.url_enc === 'string' &&
    (row.url_enc.startsWith('aw-legacy-url-hex-v1:') || row.url_redacted === null)
  )
    return 'converted'
  if (
    entry.table === 'workflows' &&
    Number(row.builtin) === 1 &&
    [
      '00000000000000AGENTHOST00',
      '00000000000000WORKGROUP00',
      '00000000000000DIGEMPHOST0',
      '00000000000000CODEROUND00',
    ].includes(String(row.id))
  ) {
    const definition = JSON.parse(String(row.definition)) as { nodes: unknown[]; edges: unknown[] }
    // RFC-395 migration §4.1 item 6 / table-mapping.md:229: the placeholder is deleted and its
    // original row goes into the evidence package (mapping-oracle conditionalDispositions).
    if (!definition.nodes.length && !definition.edges.length) return DELETED_PLACEHOLDER
  }
  return countClass(entry)
}
const DELETED_PLACEHOLDER = 'deleted-placeholder'
function targetByKey(snapshot: Snapshot, table: string, key: string): Row {
  invariant(key.startsWith('mk1:'), 'invalid target key')
  const [keyTable, cells] = JSON.parse(key.slice(4)) as [
    string,
    { type: string; value?: unknown }[],
  ]
  equal(keyTable, table, 'target reference table')
  const definition = persistenceHead().contract.contract.tables.find((t) => t.id === table)
  invariant(definition, `unknown target ${table}`)
  const columns = definition.primaryKey
  const rows = (snapshot.get(table) ?? []).filter((row) =>
    columns.every((column, i) => same(keyCell(codecValue(table, column, row[column])), cells[i])),
  )
  invariant(rows.length === 1, `S2 target ${table}/${key} resolves ${rows.length} rows`)
  return rows[0]!
}

export async function checkEpoch1(
  built: BuiltRelease,
  census: SourceCensus,
  target: Snapshot,
): Promise<void> {
  assertOracleCoverage(built.before, built.provider)
  const expected = census.tables
  const current = { rows: census.current }
  const sources = target.get('aw_meta_migration_unit_sources') ?? []
  const tableReceipts = target.get('aw_meta_migration_table_receipts') ?? []
  const dispositions = target.get('aw_meta_migration_row_dispositions') ?? []
  equal(target.get('aw_meta_migration_blocks') ?? [], [], 'S1 blocked=0')
  equal(
    tableReceipts.map((r) => `${r.source_phase}/${r.source_table}`).sort(),
    expected.map(({ entry }) => `${entry.sourcePhase}/${entry.table}`).sort(),
    'S1 exact phase/table roster (unclassified=0)',
  )
  const failures: unknown[] = []
  for (const { entry, rows, keys, raw } of expected) {
    try {
      const label = `${entry.sourcePhase}/${entry.table}`
      const units = sources.filter(
        (s) => s.source_table === entry.table && s.source_phase === entry.sourcePhase,
      )
      equal(
        units.reduce((n, r) => n + Number(r.rows), 0),
        rows.length,
        `S1 ${label} row count`,
      )
      const receipt = tableReceipts.filter(
        (s) => s.source_table === entry.table && s.source_phase === entry.sourcePhase,
      )
      equal(receipt.length, 1, `S1 ${label} table receipt`)
      equal(Number(receipt[0]!.rows_read), rows.length, `S1 ${label} table count`)
      equal(receipt[0]!.key_digest, keyDigest(keys), `S2 ${label} independently hashed keys`)
      const assigned = new Set<string>()
      for (const unit of units) {
        const first = unit.first_key as string | null,
          last = unit.last_key as string | null
        let included = keys.filter(
          (key) =>
            (first === null || Buffer.compare(Buffer.from(key), Buffer.from(first)) >= 0) &&
            (last === null || Buffer.compare(Buffer.from(key), Buffer.from(last)) <= 0),
        )
        if (unit.unit_kind === 'group') {
          // Group membership comes from the source's declared parent identity,
          // never disposition rows (which record exceptions only).
          const groupColumn =
            (
              {
                node_runs: 'task_id',
                task_repos: 'task_id',
                task_space_nodes: 'task_id',
                workgroup_task_state: 'task_id',
                skill_versions: 'skill_id',
                code_mr_leases: 'lease_key',
                code_produced_mrs: 'mr_key',
                code_publish_intents: 'batch_id',
              } as Record<string, string>
            )[entry.table] ?? 'id'
          included = keys.filter((_, i) => {
            const group = String(rows[i]![groupColumn])
            return (
              (unit.first_group === null || group >= String(unit.first_group)) &&
              (unit.last_group === null || group <= String(unit.last_group))
            )
          })
        }
        equal(included.length, Number(unit.rows), `S2 ${label} unit ${String(unit.unit_id)} census`)
        equal(unit.key_digest, keyDigest(included), `S2 ${label} unit key digest`)
        equal(first, [...included].sort()[0] ?? null, `S2 ${label} first key`)
        equal(last, [...included].sort().at(-1) ?? null, `S2 ${label} last key`)
        for (const key of included) {
          invariant(!assigned.has(key), `S2 duplicate consumed key ${label}/${key}`)
          assigned.add(key)
        }
        const counts = JSON.parse(String(unit.counts_json)) as Record<string, number>
        equal(counts.blocked, 0, `S1 ${label} blocked`)
        equal(
          Object.values(counts).reduce((n, v) => n + v, 0),
          included.length,
          `S1 ${label} classified census`,
        )
      }
      equal([...assigned].sort(), [...keys].sort(), `S2 ${label} every source key consumed once`)
      const actual = dispositions.filter(
        (d) => d.source_table === entry.table && d.source_phase === entry.sourcePhase,
      )
      invariant(
        actual.every((d) => keys.includes(String(d.source_key))),
        `S2 unknown source disposition ${label}`,
      )
      const historyPackage = entry.destinations?.some((d) => d.table === 'code_history_archives')
        ? checkHistoryPackage(built, entry, rows, keys, census, target)
        : null
      for (const [index, row] of rows.entries()) {
        const key = keys[index]!
        const decisions = actual.filter((d) => d.source_key === key)
        const expectedClass = expectedRowClass(entry, row)
        const placeholder = expectedClass === DELETED_PLACEHOLDER
        if (placeholder)
          invariant(decisions.length > 0, `S2 ${label}/${key} missing deletion record`)
        for (const decision of decisions) {
          equal(
            decision.class,
            placeholder ? 'converted' : expectedClass,
            `S2 ${label}/${key} disposition`,
          )
          if (placeholder) {
            equal(decision.kind, DELETED_PLACEHOLDER, `S2 ${label}/${key} deletion kind`)
            equal(
              JSON.parse(String(decision.targets_json)),
              [],
              `S2 ${label}/${key} no catalog row`,
            )
          }
          for (const ref of JSON.parse(String(decision.targets_json)) as {
            table: string
            key: string
          }[])
            targetByKey(target, ref.table, ref.key)
        }
        if (expectedClass === 'archived' || placeholder) {
          invariant(decisions.length > 0, `S2 ${label}/${key} missing archive disposition`)
          for (const decision of decisions) {
            const archives = (target.get('aw_meta_migration_archives') ?? []).filter(
              (a) => a.archive_ref === decision.archive_ref,
            )
            equal(archives.length, 1, `S2 ${label} archive exists`)
            const bytes = archives[0]!.bytes as Uint8Array
            equal(
              `archive:sha256:${sha256(bytes)}`,
              decision.archive_ref,
              `S2 ${label} archive digest`,
            )
            equal(bytes.byteLength, Number(archives[0]!.byte_size), `S2 ${label} archive byte size`)
            const payload: unknown = JSON.parse(Buffer.from(bytes).toString('utf8'))
            if (historyPackage) {
              equal(
                bytes,
                historyPackage,
                `S2 ${label} receipt archive equals indexed history package`,
              )
            } else if (archives[0]!.format === 'raw-chunk@1') {
              const chunk = payload as { rows: { key: unknown[]; cells: unknown }[] }
              const archived = chunk.rows.find((r) => encodedKey(entry.table, r.key) === key)
              invariant(archived, `S2 ${label} source key absent from archive bytes`)
              equal(archived, raw[index], `S2 ${label} every archived raw value`)
            } else if (
              payload &&
              !Array.isArray(payload) &&
              typeof payload === 'object' &&
              'key' in payload
            ) {
              const contract = frozenEpoch1Contract.tables.find((t) => t.id === entry.table)!
              invariant(
                'values' in payload && Array.isArray(payload.values),
                `S2 ${label} canonical archive value tuple`,
              )
              equal(
                {
                  ...(payload as object),
                  values: normalizeSqlLogicalValues(
                    built,
                    contract,
                    row,
                    payload.values as CanonicalLogicalValue[],
                  ),
                },
                {
                  key: (JSON.parse(key.slice(4)) as [string, unknown[]])[1],
                  values: normalizeSqlLogicalValues(
                    built,
                    contract,
                    row,
                    logicalValues(contract, row),
                  ),
                },
                `S2 ${label} canonical archive values`,
              )
            } else {
              const archived = decodeArchive(payload) as { encodedKey: string; values: Row }
              equal(archived.encodedKey, key, `S2 ${label} archived logical key`)
              equal(
                normalizeSqlRow(built, entry.table, row, archived.values),
                normalizeSqlRow(built, entry.table, row, row),
                `S2 ${label} archived logical values`,
              )
            }
          }
          continue
        }
        if (entry.disposition === 'metadata') {
          const records = (target.get('aw_meta_migration_records') ?? []).map(
            (r) => JSON.parse(String(r.record_json)) as Row,
          )
          const evidence = records
            .flatMap((r) => [r.payload, r.entries, r.evidence])
            .filter((v) => v && typeof v === 'object') as Row[]
          const found = evidence.find(
            (r) => r.sourceKey === key && r.sourcePhase === entry.sourcePhase,
          )
          if (raw[index]) {
            invariant(found, `S2 ${label}/${key} migration record absent`)
            equal(JSON.parse(String(found.raw)), raw[index], `S2 ${label} raw metadata record`)
          } else {
            invariant(
              entry.table === 'employee_os_writer_state',
              `S2 undeclared logical metadata ${entry.table}`,
            )
            const writer = records.find(
              (r) => r.kind === 'writer-drain' && (r.payload as Row)?.sourceKey === key,
            )
            invariant(writer, 'S2 writer drain receipt absent')
            const payload = writer.payload as Row
            const contract = frozenEpoch1Contract.tables.find((table) => table.id === entry.table)!
            equal(
              normalizeSqlLogicalValues(
                built,
                contract,
                row,
                (payload.original as { values: CanonicalLogicalValue[] }).values,
              ),
              normalizeSqlLogicalValues(built, contract, row, logicalValues(contract, row)),
              'S2 writer drain original values',
            )
            equal(payload.confirmedOsActive, true, 'S2 writer drain activation')
          }
          continue
        }
        // Same-key rows intentionally have no exception record in RFC-395. Their
        // complete source receipt and independently selected destination prove mapping.
        for (const destination of entry.destinations ?? []) {
          const selected = destinationRows(entry, row, destination, current.rows, target)
          for (const found of selected) {
            for (const [column, spec] of Object.entries(destination.key))
              if (spec.context) {
                invariant(
                  spec.context in census.identity,
                  `S2 unknown oracle context ${spec.context}`,
                )
                equal(
                  found[column],
                  census.identity[spec.context as keyof typeof census.identity],
                  `S2 ${destination.table}.${column} context identity`,
                )
              }
            for (const column of destination.preserveColumns) {
              invariant(column in row, `S3 oracle source column missing: ${entry.table}.${column}`)
              equal(
                normalizeSqlValue(
                  built,
                  entry.table,
                  row,
                  column,
                  codecValue(destination.table, column, found[column]),
                ),
                normalizeSqlValue(
                  built,
                  entry.table,
                  row,
                  column,
                  codecValue(destination.table, column, row[column]),
                ),
                `S3 ${entry.table}->${destination.table}.${column}`,
              )
            }
          }
        }
        checkProjections(entry, row, current.rows, target, built, key)
      }
      const counts = JSON.parse(String(receipt[0]!.counts_json)) as Record<string, number>
      const expectedCounts = { converted: 0, preserved: 0, archived: 0, blocked: 0 }
      for (const row of rows)
        expectedCounts[expectedRowClass(entry, row) as keyof typeof expectedCounts]++
      equal(counts, expectedCounts, `S1 ${label} oracle dispositions`)
    } catch (error) {
      failures.push(error)
    }
  }
  try {
    checkRunRestrictions(current.rows, target, built)
    checkSqlGeneratedRelationships(current.rows, target)
  } catch (error) {
    failures.push(error)
  }
  if (failures.length) throw new AggregateError(failures, 'RFC-398 strict migration checks failed')
}

function checkHistoryPackage(
  built: BuiltRelease,
  entry: OracleEntry,
  rows: Row[],
  keys: string[],
  census: SourceCensus,
  target: Snapshot,
): Uint8Array {
  const archives = (target.get('code_history_archives') ?? []).filter(
    (r) =>
      r.source_table === entry.table &&
      r.source_contract === census.identity.sourceContractDigest &&
      r.source_generation === census.identity.sourceGenerationId,
  )
  equal(archives.length, 1, `S2 history package ${entry.table}`)
  const archive = archives[0]!
  const ref = decodeContentRefColumns(
    String(archive.content_ref_json),
    archive.content_inline_bytes as Uint8Array | null,
  )
  invariant(ref?.kind === 'inline', 'S2 history package must retain independently readable bytes')
  equal(archive.root_digest, `sha256:${sha256(ref.bytes)}`, 'S2 history package byte digest')
  equal(Number(archive.row_count), rows.length, 'S2 history package census')
  const payload = JSON.parse(Buffer.from(ref.bytes).toString('utf8')) as Row
  equal(
    [payload.format, payload.table, payload.sourceContract, payload.sourceGeneration],
    [
      'code-history@1',
      entry.table,
      census.identity.sourceContractDigest,
      census.identity.sourceGenerationId,
    ],
    'S2 history package identity',
  )
  const records = payload.records as {
    key: unknown[]
    canonical: { key: unknown[]; values: CanonicalLogicalValue[] }
  }[]
  equal(records.length, rows.length, 'S2 history package record count')
  const contract = frozenEpoch1Contract.tables.find((t) => t.id === entry.table)!
  const index = (target.get('code_history_id_index') ?? []).filter(
    (r) => r.archive_id === archive.id,
  )
  equal(index.length, rows.length, 'S2 history package complete index')
  for (const [i, row] of rows.entries()) {
    const cells = (
      JSON.parse(keys[i]!.slice(4)) as [string, { type: string; value?: unknown }[]]
    )[1]
    const originalId = cells.length === 1 && cells[0]!.type === 'text' ? cells[0]!.value : keys[i]
    const found = index.filter((r) => r.original_id === originalId)
    equal(found.length, 1, 'S2 every original history ID is indexed')
    const record = records[Number(found[0]!.record_ordinal)]
    invariant(record, 'S2 history index points outside package')
    equal(JSON.parse(String(found[0]!.original_key_json)), cells, 'S2 history index original key')
    equal(record.key, cells, 'S2 history archive original key')
    equal(
      {
        ...record.canonical,
        values: normalizeSqlLogicalValues(built, contract, row, record.canonical.values),
      },
      {
        key: cells,
        values: normalizeSqlLogicalValues(built, contract, row, logicalValues(contract, row)),
      },
      'S3 history package preserves every source value',
    )
  }
  return ref.bytes
}

/** Decode the documented logical-row archive envelope without conversion helpers. */
function decodeArchive(node: unknown): unknown {
  const [kind, data] = node as [string, unknown]
  if (kind === 'bigint') return BigInt(String(data))
  if (kind === 'array') return (data as unknown[]).map(decodeArchive)
  if (kind === 'object')
    return Object.fromEntries(
      (data as [string, unknown][]).map(([key, value]) => [key, decodeArchive(value)]),
    )
  invariant(kind === 'scalar', 'unknown logical archive encoding')
  const value = data as { type: string; value: unknown }
  if (value.type === 'null') return null
  if (value.type === 'integer') return BigInt(String(value.value))
  if (value.type === 'real') return Number(value.value)
  if (value.type === 'bytes') return Buffer.from(String(value.value), 'base64')
  return value.value
}
