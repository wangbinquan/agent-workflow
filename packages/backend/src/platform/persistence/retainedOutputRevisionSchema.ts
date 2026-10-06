// RFC-371: a closed, derived-output projection. No usage or price values live here.
import type { PostgresqlSchemaStatement } from './postgresqlSchema'
import type { LogicalSchemaContract } from './schemaContract'

export const OBSERVATION_RETAINED_OUTPUT_REVISION = {
  kind: 'retained-output-revision',
  reportIdColumn: 'report_id',
  revisionColumn: 'revision',
  parent: {
    table: 'observation_reports',
    idColumn: 'id',
    stateColumn: 'state',
    building: 'building',
  },
  sources: [
    'observation_report_pages',
    'observation_report_rows',
    'observation_report_counts',
    'observation_report_receipts',
  ],
} as const
export type RetainedOutputRevisionContract = typeof OBSERVATION_RETAINED_OUTPUT_REVISION
const REVISION_TABLE = 'observation_report_retained_revisions'
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`
const events = ['insert', 'update', 'delete'] as const

export function retainedOutputRevisionSqliteStatements(): readonly string[] {
  const descriptor = OBSERVATION_RETAINED_OUTPUT_REVISION
  const mark = (reference: 'OLD' | 'NEW', extra = '') =>
    `INSERT INTO ${quote(REVISION_TABLE)} ("report_id", "revision") SELECT "id", lower(hex(randomblob(16))) FROM "observation_reports" WHERE "id" = ${reference}."report_id" AND "state" <> 'building'${extra} ON CONFLICT ("report_id") DO UPDATE SET "revision" = excluded."revision";`
  return descriptor.sources.flatMap((source) =>
    events.map((event) => {
      const body =
        event === 'update'
          ? `${mark('OLD')}\n${mark('NEW', ' AND NEW."report_id" <> OLD."report_id"')}`
          : mark(event === 'delete' ? 'OLD' : 'NEW')
      return `CREATE TRIGGER ${quote(`${source}_retained_${event}`)} AFTER ${event.toUpperCase()} ON ${quote(source)} BEGIN\n${body}\nEND`
    }),
  )
}

export function retainedOutputRevisionPostgresqlStatements(
  contract: LogicalSchemaContract,
): readonly PostgresqlSchemaStatement[] {
  const revisions = contract.tables.filter((table) => table.nativeProjection !== undefined)
  if (revisions.length === 0) return []
  if (
    revisions.length !== 1 ||
    revisions[0]!.id !== REVISION_TABLE ||
    JSON.stringify(revisions[0]!.nativeProjection) !==
      JSON.stringify(OBSERVATION_RETAINED_OUTPUT_REVISION)
  )
    throw new Error('Unsupported retained-output-revision schema projection')
  const physical = (id: string) => {
    const table = contract.tables.find((table) => table.id === id)
    if (!table || table.disposition !== 'KEEP' || !table.providerTables.postgresql)
      throw new Error('Retained output projection requires its complete KEEP relations: ' + id)
    return `"agent_workflow".${quote(table.providerTables.postgresql)}`
  }
  const target = physical(REVISION_TABLE),
    parent = physical('observation_reports')
  const functions: PostgresqlSchemaStatement[] = events.map((event) => {
    const affected =
      event === 'update'
        ? 'SELECT "report_id" FROM aw_old_rows UNION SELECT "report_id" FROM aw_new_rows'
        : `SELECT DISTINCT "report_id" FROM ${event === 'delete' ? 'aw_old_rows' : 'aw_new_rows'}`
    return {
      kind: 'function',
      logicalId: `${REVISION_TABLE}:${event}`,
      sql: `CREATE FUNCTION "agent_workflow".${quote(`observation_report_retained_${event}`)}() RETURNS trigger LANGUAGE plpgsql AS $aw_retained$\nDECLARE target_report RECORD;\nBEGIN\n  FOR target_report IN SELECT p."id", p."state" FROM ${parent} p JOIN (${affected}) affected ON affected."report_id" = p."id" ORDER BY p."id" FOR UPDATE OF p LOOP\n    IF target_report."state" <> 'building' THEN\n      INSERT INTO ${target} ("report_id", "revision") VALUES (target_report."id", gen_random_uuid()::text) ON CONFLICT ("report_id") DO UPDATE SET "revision" = EXCLUDED."revision";\n    END IF;\n  END LOOP;\n  RETURN NULL;\nEND;\n$aw_retained$`,
    }
  })
  const triggers: PostgresqlSchemaStatement[] =
    OBSERVATION_RETAINED_OUTPUT_REVISION.sources.flatMap((source) =>
      events.map((event) => ({
        kind: 'trigger' as const,
        logicalId: `${source}:retained:${event}`,
        sql: `CREATE TRIGGER ${quote(`${source}_retained_${event}`)} AFTER ${event.toUpperCase()} ON ${physical(source)} REFERENCING ${event === 'insert' ? 'NEW TABLE AS aw_new_rows' : event === 'delete' ? 'OLD TABLE AS aw_old_rows' : 'OLD TABLE AS aw_old_rows NEW TABLE AS aw_new_rows'} FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow".${quote(`observation_report_retained_${event}`)}()`,
      })),
    )
  return [...functions, ...triggers]
}
