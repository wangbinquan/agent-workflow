// RFC-395 U-5: runtime-only code-history@1 decoding, independent of the source reader.
import { z } from 'zod'
import { canonicalSchemaJson } from '@/platform/persistence/schema/canonical'
import { sha256Hex } from '@/util/hash'

export const CODE_HISTORY_TABLES = [
  'code_ai_attempts',
  'code_artifacts',
  'code_findings',
  'code_fix_attempts',
  'code_mr_leases',
  'code_produced_mrs',
  'code_publish_intents',
  'code_round_stages',
  'code_trigger_deliveries',
  'code_work_items',
  'code_work_observations',
  'code_work_rounds',
  'legacy_code_work_item_links',
] as const
export type CodeHistoryTable = (typeof CODE_HISTORY_TABLES)[number]

/** A supplies the admitted installation's frozen contract data, never a live table schema. */
export interface CodeHistorySource {
  readonly sourceGeneration: string
  readonly contract: {
    readonly digest: string
    readonly tables: readonly {
      readonly id: string
      readonly columns: readonly { readonly name: string }[]
      readonly migrationKey: readonly string[]
    }[]
  }
}
export interface CodeHistoryArchiveIdentity {
  readonly formatVersion: number
  readonly sourceGeneration: string
  readonly sourceContract: string
  readonly sourceTable: string
  readonly rowCount: number
  readonly rootDigest: string
}

export class CodeHistoryReadError extends Error {
  constructor(
    readonly code: string,
    detail: string,
  ) {
    super(`${code}: ${detail}`)
    this.name = 'CodeHistoryReadError'
  }
}

const cellSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('null') }),
  z.strictObject({ type: z.literal('boolean'), value: z.boolean() }),
  z.strictObject({ type: z.literal('integer'), value: z.string().regex(/^-?(?:0|[1-9][0-9]*)$/) }),
  z.strictObject({
    type: z.literal('real'),
    value: z.string().refine((v) => v.length > 0 && Number.isFinite(Number(v))),
  }),
  z.strictObject({ type: z.literal('text'), value: z.string() }),
  z.strictObject({
    type: z.literal('bytes'),
    value: z.string().regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  }),
])
const keySchema = z.array(cellSchema).min(1)
const packageSchema = z.strictObject({
  format: z.literal('code-history@1'),
  sourceGeneration: z.string(),
  sourceContract: z.string(),
  table: z.enum(CODE_HISTORY_TABLES),
  records: z.array(
    z.strictObject({
      key: keySchema,
      canonical: z.strictObject({ key: keySchema, values: z.array(cellSchema) }),
      raw: z.json(),
    }),
  ),
})
type Cell = z.infer<typeof cellSchema>
export type CodeHistoryValue = string | number | bigint | boolean | Uint8Array | null
export type CodeHistoryRow = Readonly<Record<string, CodeHistoryValue>>
export interface CodeHistoryRecord {
  readonly key: readonly Cell[]
  readonly row: CodeHistoryRow
  readonly raw: z.infer<ReturnType<typeof z.json>>
}

function decodeCell(cell: Cell): CodeHistoryValue {
  switch (cell.type) {
    case 'null':
      return null
    case 'text':
    case 'boolean':
      return cell.value
    case 'real':
      return Number(cell.value)
    case 'integer': {
      const value = BigInt(cell.value)
      return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
        ? Number(value)
        : value
    }
    case 'bytes':
      return Uint8Array.from(Buffer.from(cell.value, 'base64'))
  }
}

export function codeHistoryOriginalId(table: string, key: readonly Cell[]): string {
  return key.length === 1 && key[0]!.type === 'text'
    ? key[0]!.value
    : `mk1:${canonicalSchemaJson([table, key])}`
}

export function decodeCodeHistoryPackage(
  bytes: Uint8Array,
  archive: CodeHistoryArchiveIdentity,
  source: CodeHistorySource,
): readonly CodeHistoryRecord[] {
  const fail = (code: string): never => {
    throw new CodeHistoryReadError(code, archive.sourceTable)
  }
  if (archive.formatVersion !== 1) fail('code-history-format-unsupported')
  if (archive.rootDigest !== `sha256:${sha256Hex(bytes)}`) fail('code-history-digest-mismatch')
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    return fail('code-history-package-invalid')
  }
  if (
    typeof value === 'object' &&
    value !== null &&
    'format' in value &&
    value.format !== 'code-history@1'
  )
    fail('code-history-format-unsupported')
  const parsed = packageSchema.safeParse(value)
  if (!parsed.success) return fail('code-history-package-invalid')
  const pkg = parsed.data
  if (
    archive.sourceGeneration !== source.sourceGeneration ||
    archive.sourceContract !== source.contract.digest ||
    pkg.sourceGeneration !== archive.sourceGeneration ||
    pkg.sourceContract !== archive.sourceContract ||
    pkg.table !== archive.sourceTable
  )
    fail('code-history-source-mismatch')
  if (
    !Number.isSafeInteger(archive.rowCount) ||
    archive.rowCount < 0 ||
    pkg.records.length !== archive.rowCount
  )
    fail('code-history-row-count-mismatch')
  const definitions = source.contract.tables.filter((table) => table.id === pkg.table)
  // PostgreSQL's originally absent tables have an explicit zero-row artifact.
  if (definitions.length === 0 && pkg.records.length === 0) return []
  if (definitions.length !== 1) return fail('code-history-contract-unsupported')
  const definition = definitions[0]!
  const columns = definition.columns.map((column) => column.name)
  if (
    new Set(columns).size !== columns.length ||
    definition.migrationKey.length === 0 ||
    definition.migrationKey.some((column) => !columns.includes(column))
  )
    fail('code-history-contract-unsupported')
  const keys = new Set<string>()
  return pkg.records.map((record) => {
    const encodedKey = canonicalSchemaJson(record.key)
    if (
      record.canonical.values.length !== columns.length ||
      canonicalSchemaJson(record.canonical.key) !== encodedKey ||
      keys.has(encodedKey)
    )
      fail('code-history-record-invalid')
    const actualKey = definition.migrationKey.map(
      (name) => record.canonical.values[columns.indexOf(name)]!,
    )
    if (canonicalSchemaJson(actualKey) !== encodedKey) fail('code-history-key-mismatch')
    keys.add(encodedKey)
    return {
      key: record.key,
      row: Object.fromEntries(
        columns.map((name, index) => [name, decodeCell(record.canonical.values[index]!)]),
      ),
      raw: record.raw,
    }
  })
}

const text = z.string()
const integer = z.number().int()
/** Required fields stay required; absent optional values are never invented on read. */
export const codeHistoryRowSchemas = {
  code_work_items: z.object({
    id: text,
    code_host_endpoint_id: text,
    stable_project_id: text,
    capability: text,
    anchor_kind: text,
    anchor_id: text,
    status: text,
    epoch: integer,
    created_at: integer,
  }),
  code_work_rounds: z.object({
    id: text,
    work_item_id: text,
    round_seq: integer,
    outcome: text.nullable(),
    stage_contract_ver: integer,
    baseline_sha: text.nullable(),
    started_at: integer,
    ended_at: integer.nullable(),
  }),
  code_round_stages: z.object({
    id: text,
    round_id: text,
    stage_name: text,
    stage_seq: integer,
    stage_kind: text,
    status: text,
    error: text.nullable(),
    started_at: integer.nullable(),
    ended_at: integer.nullable(),
  }),
  code_ai_attempts: z.object({
    id: text,
    round_id: text,
    stage_name: text,
    shard_key: text,
    rerun_seq: integer,
    attempt_seq: integer,
    status: text,
    validation_outcome: text.nullable(),
    session_ref: text.nullable(),
    node_run_id: text.nullable(),
    started_at: integer,
    ended_at: integer.nullable(),
  }),
  code_findings: z.object({
    id: text,
    capability: text,
    external_id: text.nullable(),
    created_at: integer,
    resolved_at: integer.nullable(),
    code_changed_at: integer.nullable(),
  }),
  code_trigger_deliveries: z.object({
    id: text,
    correlation_id: text,
    stable_project_id: text.nullable(),
    capability: text.nullable(),
    step: text,
    outcome: text,
    reason: text.nullable(),
    queued_at: integer.nullable(),
    queue_position: integer.nullable(),
    waiting_on: text.nullable(),
    round_id: text.nullable(),
    is_probe: z.boolean(),
    created_at: integer,
    updated_at: integer,
  }),
} as const
export type CodeHistoryQueryTable = keyof typeof codeHistoryRowSchemas
export type CodeHistoryQueryRow<K extends CodeHistoryQueryTable> = z.infer<
  (typeof codeHistoryRowSchemas)[K]
>

export function projectCodeHistoryRow<K extends CodeHistoryQueryTable>(
  table: K,
  row: CodeHistoryRow,
): CodeHistoryQueryRow<K> {
  const result = codeHistoryRowSchemas[table].safeParse(row)
  if (!result.success)
    throw new CodeHistoryReadError('code-history-row-invalid', `${table}: ${result.error.message}`)
  return result.data as CodeHistoryQueryRow<K>
}
