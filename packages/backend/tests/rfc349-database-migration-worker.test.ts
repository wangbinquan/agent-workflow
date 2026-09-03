// RFC-349 — architecture lock for the responsiveness boundary. A migration
// may take minutes, but no SQLite integrity/count/chunk query may execute on
// the request-serving daemon as an availability fallback.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const BACKEND = resolve(import.meta.dir, '..')
const ROOT = resolve(BACKEND, '..', '..')
const readBackend = (path: string): string => readFileSync(resolve(BACKEND, path), 'utf8')

describe('RFC-349 database migration Worker boundary', () => {
  test('production coordinator uses only the Worker-backed SQLite source', () => {
    const coordinator = readBackend(
      'src/modules/system-operations/infrastructure/databaseMigrationCoordinator.ts',
    )
    const worker = readBackend('src/platform/persistence/sqliteLogicalSourceWorker.ts')
    const supervisor = readBackend(
      'src/platform/persistence/sqliteLogicalSourceWorkerSupervisor.ts',
    )

    expect(coordinator).toContain('openSqliteLogicalSourceWorker')
    expect(coordinator).not.toContain('openSqliteLogicalSource({')
    expect(worker).toContain('openSqliteLogicalSource({')
    expect(worker).toContain('await requireSource().preflight()')
    expect(worker).toContain('await requireSource().readChunk(')
    expect(supervisor).toContain('new Worker(SQLITE_LOGICAL_SOURCE_WORKER_ENTRY)')
    expect(supervisor).not.toContain('openSqliteLogicalSource({')
    expect(supervisor).toContain('SQLite logical-source Worker request ${input.type} timed out')
  })

  test('compiled binaries carry the migration Worker as an explicit entry', () => {
    const build = readFileSync(resolve(ROOT, 'scripts/build-binary.ts'), 'utf8')
    expect(build).toContain(
      "join(backendSrc, 'platform', 'persistence', 'sqliteLogicalSourceWorker.ts')",
    )
    expect(build).toContain('entrypoints: [mainEntry, ...WORKER_ENTRIES]')
    expect(build).toContain("AW_COMPILED_BUILD: 'true'")
  })

  test('the RPC protocol caps every cross-thread row batch', () => {
    const protocol = readBackend('src/platform/persistence/sqliteLogicalSourceProtocol.ts')
    expect(protocol).toContain('limit: z.number().int().min(1).max(10_000)')
    // 2026-09-03：行不再在传输层逐值校验（那一遍与 `createLogicalTableChunk` 的完全重复，
    // `node_runs` 一块 14,750 个值、6.0ms，还整份复制出一个新对象图）。**本条守的是「条数
    // 上限」**，它原样保留；逐值校验挪到哪里、坏行仍然被拒，由
    // rfc349-worker-rows-single-validation.test.ts 钉住。
    expect(protocol).toContain('rows: z.array(z.custom<CanonicalLogicalRow>()).max(10_000)')
  })
})
