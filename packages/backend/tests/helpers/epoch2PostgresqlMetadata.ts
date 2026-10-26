import type { SqlRows } from '@/platform/persistence/postgresqlRuntime'

/** Adapter-unit metadata only. SQL stays recorded by the caller; business rows stay in its queue. */
export function createEpoch2PostgresqlMetadata(options: { generationActive?: () => boolean } = {}) {
  let committed: number | null = null
  let pending: number | null = null
  let transaction = false
  const rows = (records: Record<string, unknown>[]): SqlRows =>
    Object.assign(Promise.resolve(Object.assign(records, { count: records.length })), {
      async values() {
        return records.map((record) => Object.values(record))
      },
    })
  return (statement: string, parameters: readonly unknown[] = []): SqlRows | undefined => {
    const sql = statement.trim()
    if (/^BEGIN$/i.test(sql)) {
      transaction = true
      pending = committed
    }
    if (/^COMMIT$/i.test(sql)) {
      committed = pending
      transaction = false
    }
    if (/^ROLLBACK$/i.test(sql)) {
      pending = committed
      transaction = false
    }
    if (/^SELECT generation_id FROM "agent_workflow_meta"\."generations"/i.test(sql))
      return rows(
        options.generationActive?.() === false
          ? []
          : [{ generation_id: parameters[0] ?? 'dbg_adapter_fixture' }],
      )
    if (/^SELECT first_live_write_at FROM "agent_workflow_meta"\."first_write"/i.test(sql))
      return rows([{ first_live_write_at: transaction ? pending : committed }])
    if (/^UPDATE "agent_workflow_meta"\."first_write"/i.test(sql)) {
      if (transaction) pending = 1
      else committed = 1
      return rows([{}])
    }
    return undefined
  }
}
