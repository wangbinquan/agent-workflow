// RFC-275 operator guidance shared by start and manual migrate.
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DbSchemaDriftError, formatSchemaDifference } from '@/db/schemaAdmission'
import { readGenerationPointerV2 } from '@/platform/persistence/generationPointerV2'
import { SchemaHistoryError } from '@/platform/persistence/schema/history/types'
import { Paths } from '@/util/paths'

function databaseLocation(): string {
  if (!existsSync(Paths.databaseGenerationPointer)) return Paths.db
  const pointer = readGenerationPointerV2(Paths.databaseGenerationPointer).payload
  return pointer.database.kind === 'sqlite-file'
    ? resolve(Paths.root, pointer.database.relativePath)
    : `${pointer.database.profileRef} (generation: ${pointer.generationId})`
}

export function schemaDriftGuidance(error: unknown): string | null {
  if (
    !(error instanceof DbSchemaDriftError) &&
    !(
      error instanceof SchemaHistoryError &&
      ['receipt-mismatch', 'physical-drift'].includes(error.code)
    )
  )
    return null
  const legacy = error instanceof DbSchemaDriftError
  const stage = legacy
    ? error.stage
    : error.code === 'receipt-mismatch'
      ? 'schema-history-receipt-preflight'
      : 'schema-history-catalog-admission'
  const differences = legacy
    ? error.differences.map(formatSchemaDifference)
    : [
        error.code === 'receipt-mismatch'
          ? `aw_meta_schema_history receipt differs: ${error.message}`
          : error.message,
      ]
  return [
    '',
    '✖ agent-workflow: database schema drift detected — refusing to start.',
    `  db:    ${legacy ? error.dbPath : databaseLocation()}`,
    `  stage: ${stage}`,
    '  differences:',
    ...differences.slice(0, 10).map((difference) => `    - ${difference}`),
    ...(legacy && error.totalDifferences > 10
      ? [`    - … and ${error.totalDifferences - 10} more`]
      : []),
    '',
    '  Safe recovery options:',
    '    1. Restore a verified backup.',
    '    2. If this is a disposable development database, recreate it.',
    '    3. If the schema change is intentional, add a new forward migration.',
    '',
    legacy
      ? '  Do not edit __drizzle_migrations or rewrite an already-applied migration.'
      : '  Do not edit aw_meta_schema_history or rewrite an already-applied schema history version.',
    `  Backups: ${join(Paths.root, 'backups')}`,
    '',
  ].join('\n')
}
