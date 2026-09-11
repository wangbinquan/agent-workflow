// RFC-359 W6 —— `insert(nodeRuns)` 的每个站点都必须自带 lineage 两列。
//
// # 这条守卫替代的是一个刚被删掉的触发器
//
// 迁移 0210 给 `node_runs` 建过 `rfc328_node_runs_lineage_after_insert`：
// `WHEN continuation_slot_key IS NULL OR lineage_slot_path_json IS NULL` 时把两列补齐。
// 它**只存在于 SQLite**（PostgreSQL 的 DDL 从 `db/schema.ts` 投影，一行触发器都没有），
// 而且与 `tasks` 上那条同名触发器不同——**它在生产路径上是活的**：铸行工厂对
// `lineageSlotPathJson` 的默认值是 `overrides ?? inherited ?? null`，全 `src` 没有任何调用点
// 传 `overrides.lineageSlotPathJson`，所以任务的首个 node_run 一定命中 NULL 分支。
// 实测结果是 SQLite 补出「任务路径 + 本节点一帧」、PostgreSQL 留 null
// （`tests/rfc359-w6-node-run-lineage-parity.test.ts` 的头注释有那份实测输出）。
//
// 迁移 0224 删掉了它，推导搬进 `application/buildNodeRunMintRecord.ts` 的
// `nodeRunLineageColumns`（两个引擎共用一份）。这条守卫接替触发器的职责：
// **每个 `insert(nodeRuns)` 站点都要显式写这两列**。守卫对两个引擎同时生效，触发器不能。
//
// # 判据与 W7 的 `insert(tasks)` 守卫同形，但多做一步「解一层局部常量」
//
// `insert(tasks)` 的四个站点都直接写对象字面量，取顶层键即可。`insert(nodeRuns)` 的唯一站点
// 写的是 `.values(values)`，其中 `const values = { ...record, scopePath, lineageSlotPathJson }`。
// 所以这里在同一个源文件里解析一层 `const` 声明再取键——**只解一层**：解得更深就等于写一个
// 小型求值器，而那会让守卫自己变成需要被守卫的东西。解不开时按「零个键」记账，账本上会显示
// 成缺列而红，逼人把写法改回可判定的形状。

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

import ts from 'typescript'

import { portable } from './census'

const SRC = resolve(import.meta.dir, '..', '..', 'src')

/** 这两列缺一列，两个引擎就会对同一份代码给出不同结果。 */
const REQUIRED_COLUMNS = ['continuationSlotKey', 'lineageSlotPathJson'] as const

/**
 * 实测存量：一个共享站点（同步与异步入口共用），两列齐全。
 * **这份账本的正确状态是「每一行都两列齐全」**——出现 `-` 就是那条静默分叉，
 * 去把那一列补上，不要把 `-` 登记进来了事。
 *
 * 键是 `file:line`，与 W7 的账本同形（那条账本里也记着「行号会因上方编辑而漂」的摩擦）。
 */
const NODE_RUN_INSERT_SITES: readonly string[] = [
  'modules/task-execution/infrastructure/nodeRunMintParticipant.ts:126 continuationSlotKey+ lineageSlotPathJson+',
]

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sourceFiles(path))
    else if (entry.name.endsWith('.ts')) out.push(path)
  }
  return out
}

/** 对象字面量的顶层键；`...spread` 记成 `...<被展开的表达式文本>`，供下一步解引用。 */
function literalKeys(node: ts.ObjectLiteralExpression, source: ts.SourceFile): Set<string> {
  const keys = new Set<string>()
  for (const property of node.properties) {
    if (ts.isSpreadAssignment(property)) {
      keys.add(`...${property.expression.getText(source)}`)
      continue
    }
    if (property.name !== undefined && ts.isIdentifier(property.name)) keys.add(property.name.text)
  }
  return keys
}

/** 同文件里 `const <name> = <object literal>` 的顶层键；找不到就是空集。 */
function localConstKeys(name: string, source: ts.SourceFile): Set<string> {
  let found: Set<string> | undefined
  const visit = (node: ts.Node): void => {
    if (
      found === undefined &&
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer !== undefined &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      found = literalKeys(node.initializer, source)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found ?? new Set<string>()
}

/**
 * `x.insert(nodeRuns).values(<arg>)` 的站点账目。**纯函数**，扫描与自证共用。
 *
 * `<arg>` 是对象字面量就直接取键；是标识符就解一层同文件的 `const`。展开
 * （`...record`）不算「显式写了这一列」——铸行记录里那两列可以是 null，正是这条守卫要防的。
 */
export function nodeRunInsertSites(text: string, rel: string): string[] {
  if (!text.includes('insert(nodeRuns)')) return []
  const source = ts.createSourceFile('probe.ts', text, ts.ScriptTarget.Latest, true)
  const out: string[] = []
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'values'
    ) {
      const receiver = node.expression.expression
      if (
        ts.isCallExpression(receiver) &&
        ts.isPropertyAccessExpression(receiver.expression) &&
        receiver.expression.name.text === 'insert' &&
        receiver.arguments.length === 1 &&
        receiver.arguments[0]!.getText(source) === 'nodeRuns'
      ) {
        const argument = node.arguments[0]
        const keys =
          argument === undefined
            ? new Set<string>()
            : ts.isObjectLiteralExpression(argument)
              ? literalKeys(argument, source)
              : ts.isIdentifier(argument)
                ? localConstKeys(argument.text, source)
                : new Set<string>()
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
        const columns = REQUIRED_COLUMNS.map(
          (column) => `${column}${keys.has(column) ? '+' : '-'}`,
        ).join(' ')
        out.push(`${rel}:${line} ${columns}`)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return out
}

let cached: readonly string[] | undefined

function observedSites(): readonly string[] {
  if (cached !== undefined) return cached
  const rows: string[] = []
  for (const file of sourceFiles(SRC)) {
    rows.push(...nodeRunInsertSites(readFileSync(file, 'utf8'), portable(relative(SRC, file))))
  }
  cached = rows.sort()
  return cached
}

describe('RFC-359 W6 —— insert(nodeRuns) 的 lineage 两列完整性', () => {
  test('语料下限：确实扫到了 backend 源码树（扫成 0 时本守卫零预言力）', () => {
    expect(sourceFiles(SRC).length).toBeGreaterThanOrEqual(500)
  }, 20_000)

  test('逐站点与账本逐字相等', () => {
    expect(
      [...observedSites()],
      '`insert(nodeRuns)` 的站点或它们提供的列变了。\n' +
        '**少写一列**：迁移 0224 之前 SQLite 有触发器会悄悄补上、PostgreSQL 没有，于是同一任务的\n' +
        '不同节点在 PG 上回落到同一条任务级路径、effect 的 slot_path_digest 撞车——同一份代码\n' +
        '两个引擎给出不同结果且不报错。用 `nodeRunLineageColumns` 把那两列算出来写进去，\n' +
        '别把 `-` 登记进账本。\n' +
        '**新增站点**：显式加进账本；顺带注意 RFC-098 的 grep 守卫本来就只许两个铸行适配器直插。',
    ).toEqual([...NODE_RUN_INSERT_SITES])
  })

  test('账本自身：每一行都必须两列齐全（`-` 出现即为那条静默分叉）', () => {
    // 只看空格之后的列状态段——路径里本来就有连字符（`task-execution`）。
    for (const row of NODE_RUN_INSERT_SITES) {
      expect(row.slice(row.indexOf(' ')), row).not.toContain('-')
    }
  })

  test('判据自证：对象字面量 / 一层局部常量 / 只展开不写列，三种形状各判一次', () => {
    const direct = `x.insert(nodeRuns).values({ id, continuationSlotKey, lineageSlotPathJson }).run()`
    expect(nodeRunInsertSites(direct, 'p.ts')).toEqual([
      'p.ts:1 continuationSlotKey+ lineageSlotPathJson+',
    ])

    const viaConst = `const values = { ...record, scopePath, continuationSlotKey, lineageSlotPathJson }\nx.insert(nodeRuns).values(values).run()`
    expect(nodeRunInsertSites(viaConst, 'p.ts')).toEqual([
      'p.ts:2 continuationSlotKey+ lineageSlotPathJson+',
    ])

    // 反面 fixture：只展开铸行记录、不显式写列 —— 那正是触发器年代的写法，必须判成缺列。
    const spreadOnly = `const values = { ...record, scopePath }\nx.insert(nodeRuns).values(values).run()`
    expect(nodeRunInsertSites(spreadOnly, 'p.ts')).toEqual([
      'p.ts:2 continuationSlotKey- lineageSlotPathJson-',
    ])

    // 解不开的形状（函数返回值）同样记成缺列，而不是静默放行。
    const opaque = `x.insert(nodeRuns).values(makeValues()).run()`
    expect(nodeRunInsertSites(opaque, 'p.ts')).toEqual([
      'p.ts:1 continuationSlotKey- lineageSlotPathJson-',
    ])

    // 别的表不进这本账。
    expect(nodeRunInsertSites(`x.insert(tasks).values({ id }).run()`, 'p.ts')).toEqual([])
  })
})
