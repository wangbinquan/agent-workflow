// RFC-395 II-pre：守卫改锁生产路径或删除后的精确存量，保留原扫描判据。
// RFC-349 回归防护 —— PostgreSQL 的聚合结果必须落成 JS number，不能是字符串。
//
// 为什么这条测试存在（2026-09-03，对着真 PostgreSQL 实测）：`count(*)` 在 PostgreSQL 里
// 是 **int8**，`sum(bigint)` 是 **numeric**；这两种类型超出 IEEE754 安全整数范围，驱动
// 按规范把它们原样交回**字符串**。实测同一条连接：
//
//   count(*)          → string "100000"
//   count(*)::int     → number 100000
//   numeric / int8    → string        int2 / int4 / float8 → number
//
// 普通列不受影响：整数列在 PostgreSQL 投影里是 bigint，但 Drizzle 的
// `bigint({ mode: 'number' })` 有 mapper，读回来就是 number（实测 tasks 整行全部正确）。
// **裸 `sql<number>\`count(*)\`` 没有 mapper**——TypeScript 说是 number，运行时是字符串。
// SQLite 那边一直是 number，于是同一段代码在两个 provider 上行为不同：`total + 1` 变成
// 字符串拼接、JSON 响应里 `total` 从 3000 变成 "3000"、分页/配额判断被静默改写。
//
// 修法是走 Drizzle 自带的 `count()`（`sql\`count(*)\`.mapWith(Number)`），或给自定义聚合
// 显式 `.mapWith(Number)`。判据：PostgreSQL 适配器里的聚合投影必须带 mapper，除非在
// `DECODED_BY_CALLER` 里写明由哪个解码函数负责。

import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { count } from 'drizzle-orm'
import ts from 'typescript'

import { postgresqlExecutionSurface } from './architecture/postgresqlSurface'

const srcRoot = resolve(import.meta.dir, '..', 'src')

/** `文件相对路径 -> 列名 -> 谁负责把驱动交回的字符串解码成 number`。 */
const DECODED_BY_CALLER: Record<string, Record<string, string>> = {
  'platform/persistence/capabilities.ts': {
    '?':
      'RFC-359 W4-D19c 的 `greatest` 能力：SQLite 分支渲染的是**两参数的标量** max(a, b)（SQLite 只有多参数' +
      '形态才是标量函数，单参数才是聚合），PG 分支渲染 greatest(a, b)。它用在 onConflictDoUpdate 的 set 子句里' +
      '让游标只前进不后退，根本不是投影列——没有值回到 JS 侧，也就没有可解码的东西。',
  },
  'modules/integration/infrastructure/webhookDeliveryQueries.ts': {
    '?':
      'listRepoPaths 的递归 CTE 里 min(repo_path) 是 text 列的字典序最小值，不是数值聚合——' +
      '产出的 p 就是 repo_path 字符串，两个 provider 同形，无需解码',
  },
  'modules/task-execution/infrastructure/taskNodeEventArchiveStore.ts': {
    value: '调用点用 numberValue() 解码；投影类型也刻意写成 sql<unknown> 提醒这一点',
    avg:
      'averageRecentPayloadBytes 的 AVG(LENGTH(payload))：行类型写成 `{ avg: unknown }`，' +
      '返回前走 numberValue(value) 解码，null 原样透传。与上面 value 同一形态。',
  },
  // RFC-359 W7：两份 provider 实现合一后按领域命名，仍按类型可达性落进 PG 语料。
  'modules/task-execution/infrastructure/taskResourceLimitFacts.ts': {
    total: 'decodeResourceLimitTokenTotal() 显式接受 string / bigint / number 三种形态',
  },
  'modules/task-execution/infrastructure/taskRepositoryUsage.ts': {
    cached_repo_id:
      'The first alias is text; countTaskReferences passes { count: int } to the read codec, ' +
      'then normalizes the aggregate with Number(row.count).',
  },
  // RFC-395 I-b: raw execution is now in the neutral provider surface; retain its existing decoders.
  'modules/intent/infrastructure/intentSqlPersistence.ts': {
    revision:
      'firstRow passes { revision: int } to rawFirst contract codecs before revision arithmetic.',
  },
  'modules/source-control/infrastructure/repositoryWorkspaceSqlStore.ts': {
    count:
      'executor.all passes { count: int } to rawRows; returned counts additionally pass Number().',
    scope_id:
      'The first alias is text; the memory count projection has { count: int } in executor.all.',
  },
  'modules/task-execution/infrastructure/taskListPage/query.ts': {
    NOT: 'fastFilteredRootQuery shares page.ts numericOrZero() and projection.ts numeric() decoders.',
    MATERIALIZED:
      'baseCtes is an SQL fragment; page/projection.ts normalizes open_alert_count with numeric().',
    facet_all: 'page.ts normalizes all four aggregate facet fields with numericOrZero().',
    workflow_name:
      'Fast page queries share page.ts and projection.ts numeric() / numericOrZero() decoders.',
  },
}

/**
 * 聚合函数名**大小写不敏感**（`iu`）。初版只有 `u`，于是 `sql<number | null>`MAX(…)`` 这类
 * 大写写法整类漏检——SQL 函数名本来就不区分大小写，判据区分就是一个纯粹的检测盲区。
 * RFC-359 W7 实测：`services/taskDelete.ts` 迁成中立事务、进入 PG 执行面之后，它的两处
 * `MAX(branch_started_at)` 正好落在这个盲区里（PostgreSQL 的 `max(bigint)` 回 **int8**，
 * 驱动交回字符串）。
 */
const AGGREGATE = /\b(?:count|sum|avg|max|min)\s*\(/iu

function hasNumberMapper(node: ts.TaggedTemplateExpression): boolean {
  const parent = node.parent
  return (
    ts.isPropertyAccessExpression(parent) &&
    parent.name.text === 'mapWith' &&
    ts.isCallExpression(parent.parent)
  )
}

/** A fragment has no independent driver result when every value use stays in
 * a mapped SQL projection or the native DELETE-candidate mechanism. Any escape,
 * shadowed binding or unmapped consumer keeps the original failure. */
function decodedFragment(node: ts.TaggedTemplateExpression, template: string): boolean {
  let owner: ts.Node = node
  while (!ts.isVariableDeclaration(owner)) {
    if (!owner.parent || ts.isBlock(owner) || ts.isFunctionLike(owner)) return false
    owner = owner.parent
  }
  const declaration = owner
  if (!ts.isIdentifier(declaration.name)) return false
  const name = declaration.name.text
  let scope: ts.Node = declaration
  while (scope.parent && !ts.isFunctionLike(scope) && !ts.isSourceFile(scope)) scope = scope.parent
  const references: ts.Identifier[] = []
  let ambiguous = false
  const visit = (current: ts.Node): void => {
    if (
      ts.isVariableDeclaration(current) &&
      current !== declaration &&
      ts.isIdentifier(current.name) &&
      current.name.text === name
    )
      ambiguous = true
    if (ts.isParameter(current) && ts.isIdentifier(current.name) && current.name.text === name)
      ambiguous = true
    if (ts.isIdentifier(current) && current.text === name && current !== declaration.name) {
      const parent = current.parent
      if (
        !(ts.isPropertyAccessExpression(parent) && parent.name === current) &&
        !(ts.isPropertyAssignment(parent) && parent.name === current)
      )
        references.push(current)
    }
    ts.forEachChild(current, visit)
  }
  visit(scope)
  if (ambiguous || !references.length) return false
  let consumed = false
  const safe = references.every((reference) => {
    const parent = reference.parent
    if (
      ts.isBinaryExpression(parent) &&
      [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(
        parent.operatorToken.kind,
      ) &&
      ((parent.left === reference &&
        ts.isIdentifier(parent.right) &&
        parent.right.text === 'undefined') ||
        (parent.right === reference &&
          ts.isIdentifier(parent.left) &&
          parent.left.text === 'undefined'))
    )
      return true
    if (
      ts.isTemplateSpan(parent) &&
      parent.expression === reference &&
      ts.isTemplateExpression(parent.parent) &&
      ts.isTaggedTemplateExpression(parent.parent.parent) &&
      hasNumberMapper(parent.parent.parent)
    ) {
      consumed = true
      return true
    }
    if (
      ts.isCallExpression(parent) &&
      parent.arguments[2] === reference &&
      ts.isPropertyAccessExpression(parent.expression) &&
      parent.expression.name.text === 'deleteByCandidates' &&
      ts.isCallExpression(parent.expression.expression) &&
      ts.isIdentifier(parent.expression.expression.expression) &&
      parent.expression.expression.expression.text === 'engineOf' &&
      /^\s*SELECT\b/iu.test(template) &&
      !AGGREGATE.test(template.split(/\bWHERE\b/iu)[0]!)
    ) {
      consumed = true
      return true
    }
    return false
  })
  return safe && consumed
}

function aggregateProjections(text: string) {
  const source = ts.createSourceFile('projection.ts', text, ts.ScriptTarget.Latest, true)
  const result: { line: number; key: string; mapped: boolean }[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isTaggedTemplateExpression(node)) {
      const tag = node.tag
      if (
        (ts.isIdentifier(tag) && tag.text === 'sql') ||
        (ts.isPropertyAccessExpression(tag) && tag.name.text === 'sql')
      ) {
        const template = ts.isNoSubstitutionTemplateLiteral(node.template)
          ? node.template.text
          : node.template.head.text +
            node.template.templateSpans.map((span) => ' ? ' + span.literal.text).join('')
        if (AGGREGATE.test(template)) {
          const start = tag.getStart(source)
          result.push({
            line: source.getLineAndCharacterOfPosition(start).line + 1,
            key:
              /([A-Za-z_][A-Za-z0-9_]*)\s*:\s*$/u.exec(text.slice(0, start))?.[1] ??
              /\bAS\s+"?([A-Za-z_][A-Za-z0-9_]*)/iu.exec(template)?.[1] ??
              '?',
            mapped: hasNumberMapper(node) || decodedFragment(node, template),
          })
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return result
}

/**
 * 语料是**类型可达**的 PG 执行面，不是文件名前缀。
 *
 * 初版按 `entry.startsWith('postgresql')` 取语料，于是双 provider 共用实现
 * （`taskIdleTimeoutPersistence.ts` 那种）与按领域命名却吃 PG 客户端的文件整体逃出
 * 判据——2026-09-04 实测漏掉 27 个文件。判据搬到 `architecture/postgresqlSurface.ts`
 * 单一实现，三条陷阱守卫共用。
 */

describe('RFC-349 PostgreSQL aggregates come back as numbers', () => {
  test('SQL examples in comments and strings are not executable projections', () => {
    const source = [
      '// The old projection was sql<number>`count(*)`.',
      '/* sql<number>`SUM(total)` is another unmapped example. */',
      'const example = "sql<number>`count(*)`"',
    ].join('\n')
    expect(aggregateProjections(source)).toEqual([])
  })

  test('executable aggregates still require a mapper or a caller decoder after examples', () => {
    const source = [
      '// The old projection was sql<number>`count(*)`.',
      'const columns = {',
      '  total: sql<number>`count(*)`,',
      '  latest: sql<number | null>`MAX(updated_at)`,',
      '  mapped: sql<number>`sum(tokens)`.mapWith(Number),',
      '}',
      'const raw = sql`select avg(total) AS average from rounds`',
      'const namespaced = drizzle.sql<number>`min(total) AS minimum`',
    ].join('\n')
    expect(aggregateProjections(source)).toEqual([
      { line: 3, key: 'total', mapped: false },
      { line: 4, key: 'latest', mapped: false },
      { line: 5, key: 'mapped', mapped: true },
      { line: 7, key: 'average', mapped: false },
      { line: 8, key: 'minimum', mapped: false },
    ])
  })

  test('JavaScript interpolation is not an SQL aggregate', () => {
    expect(aggregateProjections('const limit = sql`LIMIT ${Math.max(1, input.limit)}`')).toEqual([])
    expect(
      aggregateProjections('const count = sql`SELECT COUNT(*) AS "total" FROM t WHERE id = ${id}`'),
    ).toEqual([{ line: 1, key: 'total', mapped: false }])
  })

  test('SQL-only fragments inherit an actual outer mapper; an escaping copy still fails', () => {
    const mapped =
      'const history = absent ? undefined : sql`SELECT count(*) FROM archived`; const projection = history === undefined ? count() : sql`count(*) + ${history}`.mapWith(Number)'
    expect(aggregateProjections(mapped).map((entry) => entry.mapped)).toEqual([true, true])
    expect(
      aggregateProjections(mapped + '; db.execute(history)').map((entry) => entry.mapped),
    ).toEqual([false, true])
    expect(
      aggregateProjections(mapped.replace('.mapWith(Number)', '')).map((entry) => entry.mapped),
    ).toEqual([false, false])
  })

  test('native DELETE candidate predicates return no aggregate to JavaScript', () => {
    const candidate =
      'const candidates = sql`SELECT seq AS id FROM allocations WHERE seq < (SELECT MAX(seq) FROM allocations)`; engineOf(tx).deleteByCandidates(table, table.seq, candidates)'
    expect(aggregateProjections(candidate)).toMatchObject([{ key: 'id', mapped: true }])
    expect(aggregateProjections(candidate + '; db.execute(candidates)')).toMatchObject([
      { key: 'id', mapped: false },
    ])
    expect(
      aggregateProjections(candidate.replace('SELECT seq AS id', 'SELECT MAX(seq) AS id')),
    ).toMatchObject([{ key: 'id', mapped: false }])
    expect(aggregateProjections(candidate.replace('engineOf(tx)', 'unrelated'))).toMatchObject([
      { key: 'id', mapped: false },
    ])
  })

  test("drizzle's count() carries the Number mapper that a raw template lacks", () => {
    const decoder = (
      count() as unknown as { decoder: { mapFromDriverValue(value: unknown): unknown } }
    ).decoder
    expect(
      decoder.mapFromDriverValue('100000'),
      'count() 不再把驱动交回的字符串映射成 number ⇒ 本仓所有计数都会退回字符串',
    ).toBe(100000)
  })

  test('every aggregate projection in a PostgreSQL adapter has a mapper or a named decoder', () => {
    const unmapped: string[] = []
    const staleProofs = new Map<string, Set<string>>(
      Object.entries(DECODED_BY_CALLER).map(([file, proofs]) => [
        file,
        new Set(Object.keys(proofs)),
      ]),
    )

    for (const file of postgresqlExecutionSurface(srcRoot)) {
      const relative = file.path
      const text = file.text
      for (const { line, key, mapped } of aggregateProjections(text)) {
        if (mapped) continue
        const proof = DECODED_BY_CALLER[relative]?.[key]
        if (proof !== undefined) {
          staleProofs.get(relative)?.delete(key)
          continue
        }
        unmapped.push(`${relative}:${line} (${key})`)
      }
    }

    expect(
      unmapped,
      'PostgreSQL 适配器的聚合投影没有 mapper ⇒ count/sum 会以字符串返回，' +
        '算术变拼接、JSON 里数字变字符串。改用 drizzle 的 count()，或显式 .mapWith(Number)',
    ).toEqual([])

    const stale = [...staleProofs].flatMap(([file, keys]) =>
      [...keys].map((key) => `${file}#${key}`),
    )
    expect(stale, '这些解码说明已经没有对应的聚合投影了 ⇒ 删掉').toEqual([])
  })
})
