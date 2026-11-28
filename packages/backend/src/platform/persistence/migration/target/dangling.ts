// RFC-626: resolve references to rows that did not make it into the target, instead of
// failing the finalize. Generic: it knows the declared foreign keys and the keep policies it
// is given, no table or column of any module.
import type { SchemaRegistry } from '../../schema/registry'
import type { ColumnDefinition, TableDefinition } from '../../schema/contribution'
import { quoteSchemaIdentifier as quote } from '../../schema/expressions'
import { canonicalSchemaJson } from '../../schema/canonical'
import { parameters, type HistoryConnection } from '../../schema/history/connection'
import { decodeLogicalValue } from '../legacy/logicalDatabaseArtifact'
import { bytesDigest, valueDigest } from '../conversion/digest'
import { decodeMigrationKey } from '../conversion/migrationKey'
import type { ReferenceKeepPolicy } from '../conversion/rule'
import type { ArchiveRef, JsonValue, TargetValue } from '../conversion/types'
import type { ConversionTargetConnection, FinalizeDisposition } from '../run/types'
import { encodeTargetValue, targetTableName } from './loader'
import { foreignKeyViolations } from './finalize'

export const FINALIZE_REFERENCE_CODE = 'v3-finalize-reference'
/** Unit ids of finalize dispositions; one per target row and foreign key. */
export const FINALIZE_REFERENCE_UNIT = 'v3:finalize:reference:'
export interface DanglingJournal {
  recorded(tx: HistoryConnection, unitId: string): Promise<boolean>
  /** Runs in the transaction that changed the row. */
  record(
    tx: HistoryConnection,
    unitId: string,
    disposition: FinalizeDisposition,
    detail: JsonValue,
    archive: { readonly ref: ArchiveRef; readonly bytes: Uint8Array } | null,
  ): Promise<void>
}
/** A native value as text an archive can carry; never throws on what a database returned. */
function archivedValue(value: unknown): JsonValue {
  if (value === null || value === undefined) return null
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'bigint') return { integer: String(value) }
  if (typeof value === 'number')
    return Number.isFinite(value) && !Object.is(value, -0) ? value : { real: String(value) }
  if (value instanceof Uint8Array) return { bytes: Buffer.from(value).toString('base64') }
  return { text: String(value) }
}
export async function resolveDanglingReferences(
  target: ConversionTargetConnection,
  input: {
    readonly registry: SchemaRegistry
    readonly policies: readonly ReferenceKeepPolicy[]
    readonly journal: DanglingJournal
    /** Encoded keys of rows the target cannot do without. */
    readonly requiredSeedKeys: ReadonlySet<string>
  },
): Promise<void> {
  const tables = new Map<string, TableDefinition>(
    input.registry.tables.map((table) => [table.id, table]),
  )
  const column = (table: TableDefinition, name: string): ColumnDefinition =>
    Object.values(table.columns).find((entry) => entry.name === name)!
  for (;;) {
    const violations = [...(await foreignKeyViolations(target, input.registry))].sort((a, b) => {
      const left = canonicalSchemaJson([a.table, a.targetKey, a.constraint])
      const right = canonicalSchemaJson([b.table, b.targetKey, b.constraint])
      return left < right ? -1 : left > right ? 1 : 0
    })
    if (!violations.length) return
    let changed = 0
    await target.transaction(async (tx) => {
      for (const violation of violations) {
        const table = tables.get(violation.table ?? '')
        const foreignKey = table?.foreignKeys.find((entry) => entry.name === violation.constraint)
        if (!table || !foreignKey || violation.targetKey === null)
          throw new Error(
            `v3-finalize-reference-unknown: ${violation.table}/${violation.constraint}`,
          )
        const keyColumns = table.primaryKey.map((name) => column(table, name))
        const keyValues = decodeMigrationKey(violation.targetKey).key.map(
          (cell) => decodeLogicalValue(cell) as TargetValue,
        )
        const keyArgs = keyColumns.map((entry, index) =>
          encodeTargetValue(entry, keyValues[index]!, tx.provider),
        )
        const where = (offset: number): string => {
          const slots = parameters(tx, offset + keyArgs.length)
            .split(', ')
            .slice(offset)
          return keyColumns
            .map((entry, index) => `${quote(entry.name)} = ${slots[index]}`)
            .join(' AND ')
        }
        const name = targetTableName(tx.provider, table.id)
        const stored = (await tx.execute(`SELECT * FROM ${name} WHERE ${where(0)}`, keyArgs))[0]
        // An earlier reference of this round already moved the row away.
        if (!stored) continue
        const unitId = `${FINALIZE_REFERENCE_UNIT}${valueDigest([table.id, violation.targetKey, foreignKey.name]).slice(7)}`
        // A record commits with its change, so a recorded reference cannot dangle again.
        if (await input.journal.recorded(tx, unitId))
          throw new Error(`v3-finalize-reference-stuck: ${table.id}/${foreignKey.name}`)
        const declared = input.policies.find(
          (policy) => policy.table === table.id && policy.foreignKey === foreignKey.name,
        )
        const action =
          declared?.action ??
          (foreignKey.onDelete === 'set null' ? { kind: 'detach' as const } : null)
        const previous = Object.fromEntries(
          foreignKey.columns.map((entry) => [entry, archivedValue(stored[entry])]),
        )
        const base = {
          targetTable: table.id,
          targetKey: violation.targetKey,
          foreignKey: foreignKey.name,
          references: foreignKey.foreignTable,
        }
        if (action) {
          const values: Readonly<Record<string, TargetValue>> =
            action.kind === 'detach'
              ? Object.fromEntries(foreignKey.columns.map((entry) => [entry, null]))
              : action.values
          const names = Object.keys(values)
          if (!names.length || names.some((entry) => !foreignKey.columns.includes(entry)))
            throw new Error(`v3-finalize-reference-policy: ${table.id}/${foreignKey.name}`)
          const args = names.map((entry) =>
            encodeTargetValue(column(table, entry), values[entry]!, tx.provider),
          )
          const slots = parameters(tx, args.length + keyArgs.length).split(', ')
          await tx.execute(
            `UPDATE ${name} SET ${names.map((entry, index) => `${quote(entry)} = ${slots[index]}`).join(', ')} WHERE ${where(args.length)}`,
            [...args, ...keyArgs],
          )
          await input.journal.record(
            tx,
            unitId,
            {
              ...base,
              action: action.kind === 'detach' ? 'detached' : 'substituted',
              archive: null,
            },
            { previous },
            null,
          )
        } else {
          if (input.requiredSeedKeys.has(violation.targetKey))
            throw new Error(`v2-required-seed-set-aside: ${table.id}/${violation.targetKey}`)
          const bytes = new TextEncoder().encode(
            canonicalSchemaJson({
              table: table.id,
              key: violation.targetKey,
              values: Object.fromEntries(
                Object.keys(stored)
                  .sort()
                  .map((entry) => [entry, archivedValue(stored[entry])]),
              ),
            }),
          )
          const ref = `archive:${bytesDigest(bytes)}` as ArchiveRef
          await tx.execute(`DELETE FROM ${name} WHERE ${where(0)}`, keyArgs)
          await input.journal.record(
            tx,
            unitId,
            { ...base, action: 'set-aside', archive: ref },
            { previous },
            { ref, bytes },
          )
        }
        changed++
      }
    })
    // Every round clears a reference or removes a row; no change with violations left is a bug.
    if (!changed) throw new Error('v3-finalize-reference-no-progress')
  }
}
