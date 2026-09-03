// RFC-349 回归防护 —— PostgreSQL 的 NULL 排序必须和 SQLite 一致。
//
// 为什么这条测试存在（2026-09-03 实测，同一组 (2, NULL, 1)）：两个 provider 的默认
// **正好相反**——
//
//            ORDER BY x ASC      ORDER BY x DESC
//   SQLite   NULL, 1, 2          2, 1, NULL      ← NULL 视作最小
//   Postgres 1, 2, NULL          NULL, 2, 1      ← NULL 视作最大
//
// 纯展示排序差一位不致命；**认领 / 扫描类查询**会因此改变「先挑谁」，而这类查询往往
// 故意把 NULL 也收进候选集（NULL = 还没被认领过 / 还没扫过）。切到 PostgreSQL 之后它们
// 从队首掉到队尾：只要 due 的存量填满 LIMIT，新来的**永远轮不到**——是饿死，不是排序
// 不好看。本仓实测命中两处：human gate 的 `claimExpiresAt` 认领扫描（WHERE 里显式
// `isNull(claimExpiresAt)`）与 event-center 的 `nextScanAt` observer 扫描（WHERE 里显式
// `isNull(nextScanAt)`，LIMIT 20）。
//
// 判据：PostgreSQL 适配器里对**可空列**的 ORDER BY，要么走
// `ascNullsFirst` / `descNullsLast`（显式复刻 SQLite 语义），要么在下面的
// `PROVABLY_NULL_FREE` 里带上「为什么这里不可能有 NULL」的证明。新写的一律先红。

import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { is } from 'drizzle-orm'
import { SQLiteTable } from 'drizzle-orm/sqlite-core'

import * as schema from '@/db/schema'
import { selectDatabaseSchemaProvider } from '@/db/providerSchema'

const srcRoot = resolve(import.meta.dir, '..', 'src')

/**
 * `文件相对路径 -> [列 -> 为什么这条 ORDER BY 看不到 NULL]`。
 * 每条都必须是能在同一个查询里读出来的判据，不是「一般不会为空」。
 */
const PROVABLY_NULL_FREE: Record<string, Record<string, string>> = {
  'modules/collaboration/infrastructure/postgresqlHumanGateOperationPersistence.ts': {
    resultGateRevision: '同一个 WHERE 里有 isNotNull(resultGateRevision)',
  },
  'modules/integration/infrastructure/postgresqlScheduledTaskPersistence.ts': {
    nextRunAt: '同一个 WHERE 里有 isNotNull(nextRunAt)',
  },
  'modules/development-automation/infrastructure/postgresqlMissionStore.ts': {
    resumeAt: 'WHERE 是 lte(resumeAt, now)；NULL 比不过任何比较，两个 provider 都被排除',
  },
  'modules/development-automation/infrastructure/postgresqlMissionReadModels.ts': {
    employeeId: '同一个 WHERE 里有 isNotNull(employeeId)',
  },
  'modules/resource-catalog/infrastructure/postgresqlMcpRuntimeTestPersistence.ts': {
    idleDeadlineAt:
      'DB CHECK mcp_runtime_test_sessions_status_shape 规定 status=active 且 ' +
      'inFlightTurnId IS NULL 时 idleDeadlineAt 必非空，而 WHERE 正好只收这两条',
  },
  'modules/task-execution/infrastructure/postgresqlTaskArchiveMaintenanceCommand.ts': {
    finishedAt: 'WHERE 是 lte(finishedAt, cutoff)；NULL 被比较排除',
  },
}

interface NullableColumn {
  readonly name: string
  readonly notNull: boolean
}

function nullableColumnsByTableExport(): Map<string, Record<string, NullableColumn>> {
  const tables = new Map<string, Record<string, NullableColumn>>()
  const restore = selectDatabaseSchemaProvider('sqlite')
  try {
    for (const [exportName, value] of Object.entries(schema)) {
      if (typeof value !== 'object' || value === null || !is(value, SQLiteTable)) continue
      const columns: Record<string, NullableColumn> = {}
      for (const [property, candidate] of Object.entries(value)) {
        const column = candidate as { name?: string; notNull?: boolean }
        if (typeof column?.name === 'string' && typeof column.notNull === 'boolean') {
          columns[property] = { name: column.name, notNull: column.notNull }
        }
      }
      tables.set(exportName, columns)
    }
  } finally {
    restore()
  }
  return tables
}

function postgresqlAdapterFiles(): string[] {
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry)
      if (statSync(path).isDirectory()) walk(path)
      else if (entry.startsWith('postgresql') && entry.endsWith('.ts')) files.push(path)
    }
  }
  walk(srcRoot)
  return files
}

describe('RFC-349 NULL ordering is the same on both providers', () => {
  test('the premise: SQLite sorts NULL first ascending and last descending', () => {
    const db = new Database(':memory:')
    db.run('create table t(a integer, id text)')
    db.run("insert into t values (2,'b'),(null,'n'),(1,'a')")
    const order = (direction: string): string =>
      db
        .query<{ id: string }, []>(`select id from t order by a ${direction}`)
        .all()
        .map((row) => row.id)
        .join(',')
    expect(order('asc'), 'SQLite 的 NULL 排序变了 ⇒ 本条防护的前提变了').toBe('n,a,b')
    expect(order('desc')).toBe('b,a,n')
    db.close()
  })

  test('the helpers spell out exactly that placement', () => {
    const source = readFileSync(
      join(srcRoot, 'platform/persistence/postgresqlNullOrdering.ts'),
      'utf8',
    )
    expect(source).toContain('asc nulls first')
    expect(source).toContain('desc nulls last')
  })

  test('every nullable ORDER BY in a PostgreSQL adapter is fixed or proven NULL-free', () => {
    const tables = nullableColumnsByTableExport()
    const unaccounted: string[] = []
    const staleProofs = new Map<string, Set<string>>(
      Object.entries(PROVABLY_NULL_FREE).map(([file, proofs]) => [
        file,
        new Set(Object.keys(proofs)),
      ]),
    )

    for (const file of postgresqlAdapterFiles()) {
      const relative = file.slice(srcRoot.length + 1)
      const text = readFileSync(file, 'utf8')
      for (const match of text.matchAll(
        /\b(asc|desc)\(([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\)/gu,
      )) {
        const [, , table, property] = match
        const column = tables.get(table!)?.[property!]
        if (column === undefined || column.notNull) continue
        const proof = PROVABLY_NULL_FREE[relative]?.[property!]
        if (proof !== undefined) {
          staleProofs.get(relative)?.delete(property!)
          continue
        }
        const line = text.slice(0, match.index).split('\n').length
        unaccounted.push(`${relative}:${line} ${match[1]}(${table}.${property})`)
      }
    }

    expect(
      unaccounted,
      'PostgreSQL 适配器对可空列做了裸 asc/desc ⇒ 与 SQLite 的 NULL 排序相反。' +
        '改用 ascNullsFirst / descNullsLast，或在 PROVABLY_NULL_FREE 里写清为什么这里没有 NULL',
    ).toEqual([])

    const stale = [...staleProofs].flatMap(([file, columns]) =>
      [...columns].map((column) => `${file}#${column}`),
    )
    expect(stale, '这些 NULL-free 证明已经没有对应的 ORDER BY 了 ⇒ 删掉，别留着当免死金牌').toEqual(
      [],
    )
  })

  test('the two claim sweeps that deliberately include NULLs use the SQLite placement', () => {
    const gate = readFileSync(
      join(
        srcRoot,
        'modules/collaboration/infrastructure/postgresqlHumanGateOperationPersistence.ts',
      ),
      'utf8',
    )
    const events = readFileSync(
      join(srcRoot, 'modules/event-center/infrastructure/postgresqlEventStore.ts'),
      'utf8',
    )
    expect(
      gate,
      'claimExpiresAt 回到裸 asc ⇒ 过期认领填满 LIMIT 后，没被认领过的操作再也轮不到',
    ).toContain('ascNullsFirst(collaborationGateOperations.claimExpiresAt)')
    expect(
      events,
      'nextScanAt 回到裸 asc ⇒ due 的存量填满 LIMIT 20 后，没扫过的 observer 再也轮不到',
    ).toContain('ascNullsFirst(observerActivations.nextScanAt)')
  })
})
