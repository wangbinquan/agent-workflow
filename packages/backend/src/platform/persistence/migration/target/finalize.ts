import { persistenceDialect } from '../../nativeDialect'
import type { SchemaRegistry } from '../../schema/registry'
import { quoteSchemaIdentifier as quote } from '../../schema/expressions'
import type { HistoryStatement } from '../../schema/history/types'
import type { HistoryConnection } from '../../schema/history/connection'
import type { ConstraintViolation, ConversionTargetConnection } from '../run/types'
import { canonicalValue, encodeMigrationKey } from '../conversion/migrationKey'
import type { TargetValue } from '../conversion/types'
import { targetTableName } from './loader'

export async function foreignKeyViolations(
  tx: HistoryConnection,
  registry: SchemaRegistry,
): Promise<readonly ConstraintViolation[]> {
  const violations: ConstraintViolation[] = []
  for (const table of registry.tables)
    for (const fk of table.foreignKeys) {
      const where = fk.columns.map((name) => `s.${quote(name)} IS NOT NULL`).join(' AND ')
      const matches = fk.columns
        .map((name, i) => `s.${quote(name)} = p.${quote(fk.foreignColumns[i]!)}`)
        .join(' AND ')
      const rows = await tx.execute(
        `SELECT ${table.primaryKey.map((name) => `s.${quote(name)}`).join(', ')} FROM ${targetTableName(tx.provider, table.id)} s WHERE ${where} AND NOT EXISTS (SELECT 1 FROM ${targetTableName(tx.provider, fk.foreignTable)} p WHERE ${matches})`,
      )
      for (const row of rows)
        violations.push({
          table: table.id,
          targetKey: encodeMigrationKey(
            table.id,
            table.primaryKey.map((name) => {
              const value = row[name]
              const column = Object.values(table.columns).find((column) => column.name === name)!
              return canonicalValue(
                ['identity', 'int', 'seq', 'bigint', 'epochMs', 'durationMs'].includes(column.codec)
                  ? BigInt(String(value))
                  : (value as TargetValue),
              )
            }),
          ),
          constraint: fk.name,
          message: 'target row has no referenced row',
          kind: 'foreign-key',
          referencedTable: fk.foreignTable,
        })
    }
  return violations
}
export async function enforceDeferredConstraints(
  target: ConversionTargetConnection,
  input: { registry: SchemaRegistry; deferred: readonly HistoryStatement[] },
): Promise<readonly ConstraintViolation[]> {
  const violations = await foreignKeyViolations(target, input.registry)
  if (!persistenceDialect(target.provider).deferredForeignKeys) {
    const native = await target.execute('PRAGMA foreign_key_check')
    if (native.length && !violations.length)
      return native.map((row) => ({
        table: String(row.table),
        targetKey: null,
        constraint: String(row.fkid),
        message: 'SQLite foreign_key_check failed',
        kind: 'foreign-key',
        referencedTable: String(row.parent),
      }))
    if (violations.length) return violations
    await target.execute('PRAGMA foreign_keys = ON')
    if (Number((await target.execute('PRAGMA foreign_keys'))[0]?.foreign_keys) !== 1)
      throw new Error('v3-foreign-keys-not-enabled')
  } else {
    if (violations.length) return violations
    await target.transaction(async (tx) => {
      for (const statement of input.deferred) {
        const marker = statement.logicalId.indexOf(':fk:')
        if (statement.kind !== 'constraint' || marker < 0)
          throw new Error('v3-invalid-deferred-constraint')
        const table = statement.logicalId.slice(0, marker)
        // The compiled head already carries PostgreSQL's bounded physical identifier.
        const physical = / ADD CONSTRAINT "((?:[^"]|"")+)" FOREIGN KEY /u.exec(statement.sql)
        if (!physical) throw new Error('v3-invalid-deferred-constraint')
        const name = physical[1]!.replaceAll('""', '"')
        const found = await tx.execute(
          "SELECT c.convalidated FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='agent_workflow' AND t.relname=$1 AND c.conname=$2",
          [table, name],
        )
        if (!found.length) await tx.execute(statement.sql)
        else if (!found[0]!.convalidated)
          await tx.execute(
            `ALTER TABLE ${targetTableName(tx.provider, table)} VALIDATE CONSTRAINT ${quote(name)}`,
          )
      }
    })
  }
  return []
}
export async function checkTargetIntegrity(target: HistoryConnection): Promise<readonly string[]> {
  const check = persistenceDialect(target.provider).integrityCheck
  if (!check) return []
  return (await target.execute(check.sql))
    .map((row) => String(row[check.result]))
    .filter((message) => message !== 'ok')
}
