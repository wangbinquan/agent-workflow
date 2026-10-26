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
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { is } from 'drizzle-orm'
import { SQLiteTable } from 'drizzle-orm/sqlite-core'
import ts from 'typescript'

import { nativeQueryFixture } from './helpers/nativeQueryFixture'
import { postgresqlExecutionSurface } from './architecture/postgresqlSurface'

const srcRoot = resolve(import.meta.dir, '..', 'src')

/**
 * `文件相对路径 -> [列 -> 为什么这条 ORDER BY 看不到 NULL]`。
 * 每条都必须是能在同一个查询里读出来的判据，不是「一般不会为空」。
 */
const PROVABLY_NULL_FREE: Record<string, Record<string, string>> = {
  // RFC-395: publication scopes are enumerated only after this query excludes NULL.
  'platform/content/infrastructure/contentStore.ts': {
    scope: '同一个 WHERE 里有 isNotNull(contentPublications.scope)，随后按 scope 分页',
  },
  // RFC-370 v3 V6：中立托管对象发布日志的两处有序读取。
  'modules/system-operations/infrastructure/crewstation/objectPublications.ts': {
    scope: '同一个 WHERE 里有 `scope IS NOT NULL`（按 scope 分页的 owner 范围枚举）',
    releasedAt: '只读 state=releasing 的行；转为 releasing 的同一次更新写入 releasedAt',
  },
  // RFC-359 W4-B4a：中立文件纳入 PG 执行面后首次被扫到的四处「最新 gate revision」读法，形状相同。
  'modules/collaboration/infrastructure/humanGateOperationJournal.ts': {
    resultGateRevision: '同一个 WHERE 里有 isNotNull(resultGateRevision)',
  },
  'modules/collaboration/infrastructure/clarifyDecision.ts': {
    resultGateRevision: '同一个 WHERE 里有 isNotNull(resultGateRevision)',
  },
  'modules/collaboration/infrastructure/review.ts': {
    resultGateRevision: '同一个 WHERE 里有 isNotNull(resultGateRevision)',
  },
  'modules/collaboration/infrastructure/taskQuestionDispatch.ts': {
    resultGateRevision: '同一个 WHERE 里有 isNotNull(resultGateRevision)',
  },
  'modules/resource-catalog/infrastructure/mcpRuntimeTestPersistence.ts': {
    idleDeadlineAt:
      '同一个 WHERE 里有 isNotNull(idleDeadlineAt)：没有空闲截止的会话不是「最早截止」的候选',
  },
  'modules/integration/infrastructure/scheduledTaskPersistence.ts': {
    nextRunAt: '同一个 WHERE 里有 isNotNull(nextRunAt)',
  },
  'modules/development-automation/infrastructure/missionStore.ts': {
    resumeAt: 'WHERE 是 lte(resumeAt, now)；NULL 比不过任何比较，两个 provider 都被排除',
  },
  'modules/development-automation/infrastructure/missionReadModels.ts': {
    employeeId: '同一个 WHERE 里有 isNotNull(employeeId)',
  },
  // RFC-359 W8-A：归档维护命令合一，两侧的同一条「保留期到期的根任务」查询归到这一份实现。
  'modules/task-execution/infrastructure/taskArchiveContentCoordinator.ts': {
    finishedAt: 'WHERE 是 lte(finishedAt, cutoff)；NULL 被比较排除',
  },
}

interface NullableColumn {
  readonly name: string
  readonly notNull: boolean
}

function nullableColumnsByTableExport(): Map<string, Record<string, NullableColumn>> {
  const tables = new Map<string, Record<string, NullableColumn>>()
  {
    for (const [exportName, value] of Object.entries(nativeQueryFixture('sqlite').tables)) {
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
  }
  return tables
}

/** Epoch 2 can preserve a local table name while changing its registry key.
 * Bind each receiver to its own declaration, so sibling scopes may reuse an
 * alias without hiding nullable columns or borrowing another table's proof.
 */
function nullableOrders(text: string, tables: Map<string, Record<string, NullableColumn>>) {
  const file = '/nullable-order-source.ts'
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const options: ts.CompilerOptions = { noLib: true, noResolve: true }
  const host = ts.createCompilerHost(options)
  host.getSourceFile = (name) => (name === file ? source : undefined)
  const checker = ts.createProgram([file], options, host).getTypeChecker()
  const orders: Array<{ table: string; property: string; direction: string; index: number }> = []
  const isTablesCall = (node: ts.Node | undefined): node is ts.CallExpression =>
    node !== undefined &&
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'tablesOf'
  const tableName = (receiver: ts.Expression): string | undefined => {
    if (ts.isPropertyAccessExpression(receiver) && isTablesCall(receiver.expression))
      return receiver.name.text
    if (!ts.isIdentifier(receiver)) return undefined
    const declarations = checker.getSymbolAtLocation(receiver)?.declarations ?? []
    for (const declaration of declarations) {
      if (
        ts.isBindingElement(declaration) &&
        ts.isObjectBindingPattern(declaration.parent) &&
        ts.isVariableDeclaration(declaration.parent.parent) &&
        isTablesCall(declaration.parent.parent.initializer)
      ) {
        const key = declaration.propertyName ?? declaration.name
        if (ts.isIdentifier(key) || ts.isStringLiteral(key)) return key.text
      }
    }
    return receiver.text
  }
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      ['asc', 'desc'].includes(node.expression.text)
    ) {
      const column = node.arguments[0]
      if (column && ts.isPropertyAccessExpression(column)) {
        const table = tableName(column.expression)
        const property = column.name.text
        const definition = table === undefined ? undefined : tables.get(table)?.[property]
        if (definition && !definition.notNull)
          orders.push({
            table: table!,
            property,
            direction: node.expression.text,
            index: node.getStart(source),
          })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return orders
}

/**
 * 语料是**类型可达**的 PG 执行面，不是文件名前缀——按前缀取语料会漏掉双 provider 共用
 * 实现与按领域命名却吃 PG 客户端的文件（2026-09-04 实测 27 个）。判据单一实现见
 * `architecture/postgresqlSurface.ts`。
 */

describe('RFC-349 NULL ordering is the same on both providers', () => {
  test('nullable-order scanning resolves table aliases in their lexical scope', () => {
    const orders = nullableOrders(
      `function first(db) {
        const { nodeRuns: rows } = tablesOf(db)
        asc(rows.attemptIndex)
        desc(rows.seq)
      }
      function second(db) {
        const { tasks: rows } = tablesOf(db)
        desc(rows.finishedAt)
        descNullsLast(rows.finishedAt)
      }
      asc(tablesOf(db).nodeRuns.attemptIndex)`,
      nullableColumnsByTableExport(),
    )
    expect(
      orders.map(({ table, property, direction }) => ({ table, property, direction })),
    ).toEqual([
      { table: 'nodeRuns', property: 'attemptIndex', direction: 'asc' },
      { table: 'tasks', property: 'finishedAt', direction: 'desc' },
      { table: 'nodeRuns', property: 'attemptIndex', direction: 'asc' },
    ])
  })
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
    // RFC-359 W11：判据一字未变，只是锚点跟着实现走。这两个 helper 原本住在一份独立的
    // PG 专属模块里；最后一个调用方改指能力矩阵之后原件已删除，矩阵是唯一的渲染处。
    // 两侧各渲染一次，所以这里同时钉 PG 侧的显式落位与 SQLite 侧的「不加修饰即正确」。
    const source = readFileSync(join(srcRoot, 'platform/persistence/capabilities.ts'), 'utf8')
    expect(source).toContain('asc nulls first')
    expect(source).toContain('desc nulls last')
    expect(source, 'SQLite 侧显式写出 nulls 修饰会扰动它的索引排序计划').toContain(
      'ascNullsFirst: (column) => sql`${column} asc`',
    )
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

    for (const file of postgresqlExecutionSurface(srcRoot)) {
      const relative = file.path
      const text = file.text
      for (const { table, property, direction, index } of nullableOrders(text, tables)) {
        const proof = PROVABLY_NULL_FREE[relative]?.[property]
        if (proof !== undefined) {
          staleProofs.get(relative)?.delete(property)
          continue
        }
        const line = text.slice(0, index).split('\n').length
        unaccounted.push(`${relative}:${line} ${direction}(${table}.${property})`)
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
      join(srcRoot, 'modules/collaboration/infrastructure/humanGateOperationJournal.ts'),
      'utf8',
    )
    const events = readFileSync(
      join(srcRoot, 'modules/event-center/infrastructure/eventStore.ts'),
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
