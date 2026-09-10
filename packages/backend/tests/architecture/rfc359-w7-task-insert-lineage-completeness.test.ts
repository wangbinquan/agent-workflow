// RFC-359 W7 —— `insert(tasks)` 的每个站点都必须自带血缘与启动来源三列。
//
// # 这条守卫替代的是一个触发器
//
// SQLite 的迁移里有三个兜底触发器：`rfc328_tasks_lineage_after_insert`（`WHEN
// execution_lineage_id IS NULL OR lineage_slot_path_json IS NULL` 时从父任务补齐）与
// `trg_tasks_launch_origin_inherit_child`（子任务的 `launch_origin` 与父不一致时强制继承）。
// **PostgreSQL 侧一个触发器都没有**——2026-09-07 活库实测
// `select count(*) from pg_trigger … where nspname='agent_workflow' and not tgisinternal` 返回 **0**。
//
// 但这不是活着的功能缺口：AST 清点确认全仓四个 `insert(tasks)` 站点**全部**显式提供了这三列，
// 触发器的触发条件在任何生产路径上都不成立。也就是说，两个引擎当下行为一致，**靠的是写入方
// 自觉，不是数据库**。
//
// 于是残余风险很具体：**将来新增一条子任务插入路径而忘了写这三列**——SQLite 会被触发器悄悄
// 救回来，PostgreSQL 不会，子任务会拿到自己的 `execution_lineage_id` 而不是父的血缘，
// 启动来源也不再继承。两个引擎从此对同一份代码给出不同结果，而且**不报错**。
// 这正是 RFC-359 要消灭的形态。
//
// # 为什么是守卫，不是「给 PostgreSQL 补上触发器」
//
// 补触发器等于给同一条不变量做**第二份实现**（一份 SQLite 触发器、一份 PG 触发器），
// 与本 RFC 的方向相反——而且 DDL 触发器两个方言写法不同，第二份实现必然会漂。
// 让不变量留在**唯一**的地方（写入方），用守卫钉住「每个写入点都遵守」，才是一份实现两个数据库。
//
// # 判据
//
// 逐站点列出 `<路径>:<行号> <三列各自在/不在>`，与账本**逐字相等**：
//   · 新增一个 `insert(tasks)` 站点 ⇒ 红（必须显式登记，顺带被迫想清楚这三列填不填）；
//   · 某个站点少写一列 ⇒ 红；
//   · 站点消失 / 行号漂移 ⇒ 也红（账本跟着改，让每次变动留下署名）。
// 行号一起钉：`insert(tasks)` 是低频写入面，行号漂移本身就值得看一眼。

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

import ts from 'typescript'

import { portable } from './census'

const SRC = resolve(import.meta.dir, '..', '..', 'src')

/** 这三列缺一列，两个引擎就会对同一份代码给出不同结果。 */
const REQUIRED_COLUMNS = ['executionLineageId', 'lineageSlotPathJson', 'launchOrigin'] as const

/**
 * 实测存量：四个站点、三列齐全。**这份账本的正确状态是「每一行都三列齐全」**——
 * 出现 `-` 就是上面说的那条静默分叉，不要把它登记进来了事，去把那一列补上。
 */
/**
 * 已知的摩擦：本账本按 `file:line` 钉站点，于是**插入点上方的任何编辑**都会让它漂
 * （2026-09-07 一天内漂了两次：`services/task.ts` 3482→3509、PG 侧 585→579，
 * 两次三个血缘列都齐备，纯粹是行号动了）。
 *
 * 改进方向：把键从 `file:line` 换成 `file#外层函数名` —— 行号只是定位信息，
 * 真正要钉的是「哪个铸行点」。换掉之后同文件内的无关编辑不再制造 diff，
 * 而站点被**挪进另一个函数**这件事仍然会红（那正是该被看见的）。
 * 没在本波做是因为它要改 AST 遍历的键并重新做一次变异验证，而落盘时的改动面已经很大。
 */
const TASK_INSERT_SITES: readonly string[] = [
  // RFC-359 W11：行号从 579 挪到 580——同文件里祖先链的分支时间戳回填改调能力矩阵的
  // `greatest()`，多了一行 import。站点本身与它写的三列一格未动（同 §改进方向 说的那类无关 diff）。
  'modules/task-execution/infrastructure/postgresqlChildExecutionLaunchOperations.ts:547 executionLineageId+ lineageSlotPathJson+ launchOrigin+',
  'modules/task-execution/infrastructure/postgresqlFusionEngineTaskOperations.ts:110 executionLineageId+ lineageSlotPathJson+ launchOrigin+',
  'modules/task-execution/infrastructure/postgresqlTaskRouteLaunchOperations.ts:739 executionLineageId+ lineageSlotPathJson+ launchOrigin+',
  // RFC-359 W10：行号从 3509 挪到 3530——铸行事务从 `dbTxSync` 换成 `withTaskExecutionWrite`
  // 时在事务开头加了注释，站点本身与它写的三列一格未动（正是上面 §改进方向 说的那类无关 diff）。
  'services/task.ts:3532 executionLineageId+ lineageSlotPathJson+ launchOrigin+',
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

/**
 * `x.insert(tasks).values({ … })` 里那个对象字面量的顶层键名。
 *
 * 纯函数，扫描与自证共用。按 AST 取而不是正则匹配文本——`values({…})` 的键分布在几十行里，
 * 正则要么开窗口太小漏判（本判据初稿就是这么误判了两个站点「没写血缘」），要么跨站点串味。
 */
export function taskInsertSites(text: string, rel: string): string[] {
  if (!text.includes('insert(tasks)')) return []
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
        receiver.arguments[0]!.getText(source) === 'tasks'
      ) {
        const argument = node.arguments[0]
        const keys = new Set<string>()
        if (argument !== undefined && ts.isObjectLiteralExpression(argument)) {
          for (const property of argument.properties) {
            if (property.name !== undefined && ts.isIdentifier(property.name)) {
              keys.add(property.name.text)
            }
          }
        }
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
    rows.push(...taskInsertSites(readFileSync(file, 'utf8'), portable(relative(SRC, file))))
  }
  cached = rows.sort()
  return cached
}

describe('RFC-359 W7 —— insert(tasks) 的血缘 / 启动来源三列完整性', () => {
  test('语料下限：确实扫到了 backend 源码树（扫成 0 时本守卫零预言力）', () => {
    expect(sourceFiles(SRC).length).toBeGreaterThanOrEqual(500)
  })

  test('逐站点与账本逐字相等', () => {
    expect(
      [...observedSites()],
      '`insert(tasks)` 的站点或它们提供的列变了。' +
        '**少写一列**：SQLite 有兜底触发器会悄悄补上、PostgreSQL 没有任何触发器（活库实测 0 个），' +
        '于是子任务在 PG 上拿到自己的 execution_lineage_id 而不是父的血缘、launch_origin 也不再继承——' +
        '同一份代码两个引擎给出不同结果且不报错。把那一列补上，别把 `-` 登记进账本。' +
        '**新增站点**：显式加进账本，顺带确认这三列都写了。',
    ).toEqual([...TASK_INSERT_SITES])
  })

  test('账本自身：每一行都必须三列齐全（`-` 出现即为上面那条静默分叉）', () => {
    // 只看空格之后的列状态段——路径里本来就有连字符（`task-execution`），
    // 对整行 `includes('-')` 会把每一行都判成缺列。
    const incomplete = TASK_INSERT_SITES.filter((row) =>
      row.slice(row.indexOf(' ') + 1).includes('-'),
    )
    expect(incomplete, '账本里有站点缺列——那是待修的分叉，不是可以登记了事的存量').toEqual([])
  })

  test('matcher 自证：认出 insert(tasks) 并逐列判在不在；别的表放过', () => {
    const complete = [
      'async function f() {',
      '  await tx.insert(tasks).values({',
      "    id: 'x',",
      '    executionLineageId,',
      '    lineageSlotPathJson: JSON.stringify(lineage),',
      '    launchOrigin: parent.launchOrigin,',
      '  })',
      '}',
    ].join('\n')
    expect(taskInsertSites(complete, 'a.ts')).toEqual([
      'a.ts:2 executionLineageId+ lineageSlotPathJson+ launchOrigin+',
    ])

    const missing = [
      'async function f() {',
      '  await tx.insert(tasks).values({',
      "    id: 'x',",
      '    launchOrigin: parent.launchOrigin,',
      '  })',
      '}',
    ].join('\n')
    expect(
      taskInsertSites(missing, 'a.ts'),
      '漏列没被判出来——这条守卫的全部作用就是判这个',
    ).toEqual(['a.ts:2 executionLineageId- lineageSlotPathJson- launchOrigin+'])

    const otherTable = 'async function f() { await tx.insert(nodeRuns).values({ id: 1 }) }'
    expect(taskInsertSites(otherTable, 'a.ts'), '别的表不该被算进来').toEqual([])
  })
})
