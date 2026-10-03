/** RFC-371: connection-private derived rows, never a second usage authority. */
export interface ReportWorkingRow<T = unknown> {
  readonly key: string
  readonly document: T
}
export interface ReportWorkingPage<T = unknown> {
  readonly items: readonly ReportWorkingRow<T>[]
  readonly nextCursor: string | null
}
export interface ReportWorkspace {
  insert(namespace: string, rows: readonly ReportWorkingRow[]): Promise<void>
  upsert(namespace: string, rows: readonly ReportWorkingRow[]): Promise<void>
  put(namespace: string, row: ReportWorkingRow): Promise<void>
  get<T>(namespace: string, key: string): Promise<T | undefined>
  page<T>(namespace: string, after: string | null, size?: number): Promise<ReportWorkingPage<T>>
  clear(namespace: string): Promise<void>
}
export interface ReportWorkingStatements {
  all(
    statement: string,
    parameters: readonly unknown[],
  ): Promise<readonly Record<string, unknown>[]>
  run(statement: string, parameters: readonly unknown[]): Promise<void>
}
export const REPORT_WORKING_TABLE = 'aw_report_workspace'
export const CREATE_REPORT_WORKING_TABLE =
  'CREATE TEMP TABLE aw_report_workspace (namespace TEXT NOT NULL,key TEXT NOT NULL,document TEXT NOT NULL,PRIMARY KEY(namespace,key))'
/** Only this fixed TEMP relation is writable; original source reads use a separate read-only facade. */
export function privateReportWorkspace(
  statements: ReportWorkingStatements,
  active: () => boolean,
  signal?: AbortSignal,
): ReportWorkspace {
  const check = (namespace: string) => {
    if (!active()) throw new Error('Report snapshot already closed')
    if (!namespace) throw new Error('Report workspace namespace is empty')
    signal?.throwIfAborted()
  }
  const write = async (namespace: string, rows: readonly ReportWorkingRow[], replace: boolean) => {
    check(namespace)
    if (rows.length > 500) throw new Error('Report workspace batch is too large')
    if (!rows.length) return
    const parameters = rows.flatMap((row) => {
      const document = JSON.stringify(row.document)
      if (!row.key || document === undefined) throw new Error('Report workspace row invalid')
      return [namespace, row.key, document]
    })
    await statements.run(
      `INSERT INTO ${REPORT_WORKING_TABLE} (namespace,key,document) VALUES ${rows.map(() => '(?,?,?)').join(',')}${replace ? ' ON CONFLICT(namespace,key) DO UPDATE SET document=excluded.document' : ''}`,
      parameters,
    )
  }
  return {
    insert: (namespace, rows) => write(namespace, rows, false),
    upsert: (namespace, rows) => write(namespace, rows, true),
    put: (namespace, row) => write(namespace, [row], true),
    async get<T>(namespace: string, key: string) {
      check(namespace)
      const rows = await statements.all(
        `SELECT document FROM ${REPORT_WORKING_TABLE} WHERE namespace=? AND key=?`,
        [namespace, key],
      )
      return rows.length ? (JSON.parse(String(rows[0]!.document)) as T) : undefined
    },
    async page<T>(
      namespace: string,
      after: string | null,
      size = 100,
    ): Promise<ReportWorkingPage<T>> {
      check(namespace)
      if (!Number.isInteger(size) || size < 1 || size > 500)
        throw new Error('Report workspace page size invalid')
      const rows = await statements.all(
        `SELECT key,document FROM ${REPORT_WORKING_TABLE} WHERE namespace=?${after === null ? '' : ' AND key>?'} ORDER BY key LIMIT ?`,
        after === null ? [namespace, size + 1] : [namespace, after, size + 1],
      )
      const items = rows
        .slice(0, size)
        .map((row) => ({ key: String(row.key), document: JSON.parse(String(row.document)) as T }))
      return { items, nextCursor: rows.length > size ? items.at(-1)!.key : null }
    },
    async clear(namespace) {
      check(namespace)
      await statements.run(`DELETE FROM ${REPORT_WORKING_TABLE} WHERE namespace=?`, [namespace])
    },
  }
}
