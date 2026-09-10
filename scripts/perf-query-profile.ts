// RFC-359 AC11 diagnosis only. These requests run after both original HTTP
// reports and their comparison have been saved. They never supply P95 samples.
import type { Database } from 'bun:sqlite'
import { profile as sampleCpu } from 'bun:jsc'
import type {
  PostgresqlDatabaseRuntime,
  PostgresqlPool,
  SqlRows,
} from '../packages/backend/src/platform/persistence/postgresqlRuntime'
import { PERF_HTTP_SCENARIOS, type PerfHttpReport } from './perf-compare'

export interface ProfileStatement {
  readonly sql: string
  readonly parameters: readonly unknown[]
  readonly wallMs: number
  readonly cpuMicros: number
  readonly rows: number
  readonly error: string | null
}

export type ProfileExplainMode = 'analyze' | 'plan-only'

// The process-wide CPU clock cannot be reliably mapped to performance.now().
// Start and stop the sampler around the awaited request instead: EXPLAIN and
// the later corpus receipt then never enter this profile. These are diagnostic
// requests only; the original HTTP report supplies every performance sample.
export async function captureRequestCpu<T>(operation: () => Promise<T>) {
  let outcome: { value: T } | undefined
  const cpuProfile = await sampleCpu(async () => {
    outcome = { value: await operation() }
  }, 100)
  if (outcome === undefined) throw new Error('CPU profile did not finish its request')
  return { ...outcome, cpuProfile }
}

// Diagnostic classification only: a WITH may contain an UPDATE even when its
// final operation is SELECT. Keep those plans, but do not request ANALYZE.
// Quoted text and comments must not turn an ordinary read into an estimate.
function statementPlanMode(statement: string): ProfileExplainMode | null {
  let first: string | undefined
  let modifies = false
  let index = 0
  while (index < statement.length) {
    const char = statement[index]!
    const next = statement[index + 1]
    if (char === "'" || char === '"' || char === '`') {
      index += 1
      while (index < statement.length) {
        if (statement[index] === char) {
          if (statement[index + 1] === char) {
            index += 2
            continue
          }
          index += 1
          break
        }
        index += 1
      }
      continue
    }
    if (char === '-' && next === '-') {
      const end = statement.indexOf('\n', index + 2)
      index = end < 0 ? statement.length : end + 1
      continue
    }
    if (char === '/' && next === '*') {
      let depth = 1
      index += 2
      while (index < statement.length && depth > 0) {
        const pair = statement.slice(index, index + 2)
        if (pair === '/*') depth += 1
        if (pair === '*/') depth -= 1
        index += pair === '/*' || pair === '*/' ? 2 : 1
      }
      continue
    }
    if (char === '$') {
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(statement.slice(index))?.[0]
      if (tag !== undefined) {
        const end = statement.indexOf(tag, index + tag.length)
        index = end < 0 ? statement.length : end + tag.length
        continue
      }
    }
    const token = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(statement.slice(index))?.[0]
    if (token !== undefined) {
      const word = token.toUpperCase()
      first ??= word
      if (['INSERT', 'UPDATE', 'DELETE', 'MERGE'].includes(word)) modifies = true
      index += token.length
    } else index += 1
  }
  if (first !== 'SELECT' && first !== 'WITH') return null
  return modifies ? 'plan-only' : 'analyze'
}

function errorText(error: unknown): string {
  if (error instanceof AggregateError)
    return `${error.name}: ${error.message}; ${error.errors.map(errorText).join('; ')}`
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

export function createQueryCapture() {
  let active: ProfileStatement[] | null = null
  return {
    start(sql: string, parameters: readonly unknown[]) {
      const sink = active
      if (sink === null) return () => {}
      const wall = performance.now()
      const cpu = process.cpuUsage()
      return (rows: number, failure?: { readonly error: unknown }) => {
        const used = process.cpuUsage(cpu)
        sink.push({
          sql,
          parameters: [...parameters],
          wallMs: performance.now() - wall,
          cpuMicros: used.user + used.system,
          rows,
          error: failure === undefined ? null : errorText(failure.error),
        })
      }
    },
    async capture<T>(operation: () => Promise<T>) {
      if (active !== null) throw new Error('nested performance query capture')
      const statements: ProfileStatement[] = []
      active = statements
      const wall = performance.now()
      const cpu = process.cpuUsage()
      try {
        const value = await operation()
        const used = process.cpuUsage(cpu)
        const end = performance.now()
        return {
          value,
          wallMs: end - wall,
          cpuMicros: used.user + used.system,
          statements,
          // Diagnostic wall-clock interval only. It does not establish a
          // mapping to the CPU profiler's separate clock.
          timing: {
            timeOriginUnixMs: performance.timeOrigin,
            startTimeMs: wall,
            endTimeMs: end,
          },
        }
      } finally {
        active = null
      }
    },
  }
}

export function profileSqliteQueries(sqlite: Database) {
  const capture = createQueryCapture()
  const instrumented = Symbol('rfc359-query-profile')
  let attached = true
  const originals = { prepare: sqlite.prepare, query: sqlite.query }
  const wrap = (statement: object, sql: string) => {
    // Database.query may delegate to the wrapped prepare, including through
    // the production slow-statement Proxy. Count that native execution once.
    if (Reflect.get(statement, instrumented) === true) return statement
    return new Proxy(statement, {
      get(target, property) {
        if (property === instrumented) return true
        // Native SQLite getters require the native object, not the Proxy.
        const value: unknown = Reflect.get(target, property)
        if (typeof value !== 'function') return value
        const bound = value.bind(target) as (...parameters: unknown[]) => unknown
        if (!['all', 'get', 'run', 'values'].includes(String(property))) return bound
        return (...parameters: unknown[]) => {
          const finish = attached ? capture.start(sql, parameters) : () => {}
          try {
            const rows = bound(...parameters)
            finish(Array.isArray(rows) ? rows.length : rows === undefined || rows === null ? 0 : 1)
            return rows
          } catch (error) {
            finish(0, { error })
            throw error
          }
        }
      },
    })
  }
  for (const method of ['prepare', 'query'] as const) {
    const original = originals[method].bind(sqlite)
    // Preserve the driver's generic Statement signature at this native wrapper.
    sqlite[method] = ((...args: Parameters<typeof original>) =>
      wrap(Reflect.apply(original, sqlite, args) as object, args[0])) as typeof sqlite.prepare &
      typeof sqlite.query
  }
  return {
    capture,
    stop() {
      attached = false
      sqlite.prepare = originals.prepare
      sqlite.query = originals.query
    },
  }
}

export function profilePostgresqlQueries(runtime: PostgresqlDatabaseRuntime) {
  const capture = createQueryCapture()
  const wrap =
    (original: PostgresqlPool['unsafe']): PostgresqlPool['unsafe'] =>
    (sql, parameters) => {
      const pending = original(sql, parameters)
      const observe = async <T extends readonly unknown[]>(operation: () => PromiseLike<T>) => {
        const finish = capture.start(sql, parameters ?? [])
        try {
          const rows = await operation()
          finish(rows.length)
          return rows
        } catch (error) {
          finish(0, { error })
          throw error
        }
      }
      const rows: SqlRows = {
        then: (onValue, onError) => observe(() => pending).then(onValue, onError),
        values: () => observe(() => pending.values()),
      }
      return rows
    }
  const pool = runtime.providerPool()
  const tracedPool: PostgresqlPool = {
    unsafe: wrap(pool.unsafe.bind(pool)),
    reserve: async (options) => {
      const connection = await pool.reserve(options)
      return {
        unsafe: wrap(connection.unsafe.bind(connection)),
        release: () => connection.release(),
      }
    },
    close: (options) => pool.close(options),
  }
  return {
    capture,
    runtime: { ...runtime, providerPool: () => tracedPool } satisfies PostgresqlDatabaseRuntime,
  }
}

export async function profilePerformanceQueries(input: {
  readonly app: { request(path: string, init: RequestInit): Response | Promise<Response> }
  readonly token: string
  readonly report: Pick<
    PerfHttpReport,
    'complete' | 'scenarios' | 'sourceSha' | 'executionId' | 'provider' | 'tier'
  >
  readonly capture: ReturnType<typeof createQueryCapture>
  readonly sampleCpu?: boolean
  readonly explain: (statement: ProfileStatement, mode: ProfileExplainMode) => Promise<unknown>
}) {
  if (
    !input.report.complete ||
    input.report.scenarios.length !== PERF_HTTP_SCENARIOS.length ||
    input.report.scenarios.some((scenario, index) => scenario.id !== PERF_HTTP_SCENARIOS[index]?.id)
  )
    throw new Error('query profile requires a complete ordered HTTP report')
  const results = []
  for (const scenario of input.report.scenarios) {
    const observeRequest = () =>
      input.capture.capture(async () => {
        const response = await input.app.request(scenario.path, {
          headers: { Authorization: `Bearer ${input.token}` },
        })
        const bytes = await response.arrayBuffer()
        if (response.status !== 200)
          throw new Error(`profile ${scenario.path}: HTTP ${response.status}`)
        return { status: response.status, bytes: bytes.byteLength }
      })
    const { value: observed, cpuProfile } = input.sampleCpu
      ? await captureRequestCpu(observeRequest)
      : { value: await observeRequest(), cpuProfile: null }
    const plans = []
    const seen = new Set<string>()
    for (const statement of observed.statements) {
      const classifiedMode = statementPlanMode(statement.sql)
      if (classifiedMode === null) continue
      const mode = input.report.provider === 'sqlite' ? 'plan-only' : classifiedMode
      const key = JSON.stringify([statement.sql, statement.parameters], (_key, value: unknown) =>
        typeof value === 'bigint' ? { bigint: String(value) } : value,
      )
      if (seen.has(key)) continue
      seen.add(key)
      try {
        plans.push({
          sql: statement.sql,
          parameters: statement.parameters,
          mode,
          plan: await input.explain(statement, mode),
          error: null,
        })
      } catch (error) {
        plans.push({
          sql: statement.sql,
          parameters: statement.parameters,
          mode,
          plan: null,
          error: errorText(error),
        })
      }
    }
    results.push({ id: scenario.id, path: scenario.path, ...observed, cpuProfile, plans })
  }
  return {
    version: 1,
    phase: 'after-both-http-reports-and-comparison',
    sourceSha: input.report.sourceSha,
    executionId: input.report.executionId,
    provider: input.report.provider,
    tier: input.report.tier,
    results,
    complete:
      results.length === input.report.scenarios.length &&
      results.every((item) => item.plans.every((plan) => plan.error === null)),
  }
}
