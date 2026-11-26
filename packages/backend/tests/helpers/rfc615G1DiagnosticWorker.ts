// Read-only, disposable connection. Parent SIGKILL bounds even driver-level stalls.
import { SQL } from 'bun'

interface Input {
  database: { urlEnv: string; databaseName?: string }
  budgetMs: number
  samplesMs: number[]
  statements: { sql: string; values: unknown[] }[]
}

const emit = (record: unknown): void => {
  console.log(JSON.stringify(record))
}
const failure = (error: unknown): string =>
  String(error)
    .replace(/postgres(?:ql)?:\/\/\S+/gi, '<database URL>')
    .slice(0, 2_000)

async function main(): Promise<void> {
  const input = JSON.parse(await Bun.stdin.text()) as Input
  const value = process.env[input.database.urlEnv]
  if (!value) throw new Error('Diagnostic database environment variable is missing')
  const url = new URL(value)
  const timeout = Math.max(1, Math.floor(input.budgetMs))
  url.searchParams.set(
    'options',
    [
      url.searchParams.get('options'),
      `-c statement_timeout=${timeout}`,
      `-c lock_timeout=${timeout}`,
      '-c default_transaction_read_only=on',
      '-c search_path=agent_workflow,public',
      '-c timezone=UTC',
    ]
      .filter(Boolean)
      .join(' '),
  )
  const connection = new SQL({
    url: url.toString(),
    ...(input.database.databaseName === undefined ? {} : { database: input.database.databaseName }),
    max: 1,
    connectionTimeout: Math.max(1, Math.min(2, Math.ceil(timeout / 1_000))),
    idleTimeout: 1,
  })
  try {
    emit({
      kind: 'samples',
      samplesMs: input.samplesMs,
      bunVersion: Bun.version,
      bunRevision: Bun.revision,
    })
    emit({
      kind: 'settings',
      rows: await connection.unsafe(`
      SELECT version() AS version, current_setting('plan_cache_mode') AS plan_cache_mode,
        current_setting('jit') AS jit, current_setting('jit_above_cost') AS jit_above_cost,
        current_setting('work_mem') AS work_mem, pg_jit_available() AS jit_available
    `),
    })
    emit({
      kind: 'statistics',
      rows: await connection.unsafe(`
      SELECT s.relname, c.reltuples, c.relpages, c.relallvisible,
        s.n_live_tup, s.n_dead_tup, s.last_analyze, s.last_autoanalyze,
        s.last_vacuum, s.last_autovacuum
      FROM pg_stat_user_tables s JOIN pg_class c ON c.oid = s.relid
      WHERE s.schemaname = 'agent_workflow'
        AND s.relname IN ('tasks', 'task_definitions', 'task_launch_contexts',
          'task_workspaces', 'task_repository_mounts', 'lifecycle_alerts')
      ORDER BY s.relname
    `),
    })
    for (const statement of input.statements) {
      if (!/^\s*(select|with)\b/i.test(statement.sql)) continue
      emit({ kind: 'statement', sql: statement.sql, values: statement.values })
      try {
        const plan = await connection.unsafe(
          `EXPLAIN (ANALYZE, BUFFERS, SETTINGS, FORMAT JSON) ${statement.sql}`,
          statement.values,
        )
        emit({ kind: 'plan', sql: statement.sql, values: statement.values, plan })
      } catch (error) {
        emit({ kind: 'plan-error', error: failure(error) })
        process.exitCode = 1
      }
    }
  } finally {
    await connection.close({ timeout: 0 })
  }
}

if (import.meta.main) {
  try {
    await main()
  } catch (error) {
    emit({ kind: 'error', error: failure(error) })
    process.exitCode = 1
  }
}
