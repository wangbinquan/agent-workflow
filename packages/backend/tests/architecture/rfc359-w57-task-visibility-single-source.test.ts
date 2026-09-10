// RFC-359 W57 —— 任务可见性判据**全仓只许有一份**。
//
// # 这条守卫锁的是什么
//
// `owner = 我 OR id IN (我参与的任务)` 是**授权判据**：漂一处，用户要么看见不该看见的任务，
// 要么丢掉本该看见的。落这条守卫时它在仓里被逐字抄了**七份**：
//
//   1. `db/query.ts`（本次定为唯一一份）
//   2. `modules/task-execution/infrastructure/taskListPage/authorization.ts`（RFC-357）
//   3. `modules/collaboration/infrastructure/collaborationTaskAccess.ts`
//   4. `modules/collaboration/infrastructure/reviewTaskAccess.ts`（与 3 **逐字相同**）
//   5. `modules/task-execution/infrastructure/taskOverviewQuery.ts`（预编译占位符形态）
//   6. `modules/task-execution/infrastructure/postgresqlTaskRouteOperations.ts`
//      —— **provider 专属**的那一份，正是本 RFC 要消灭的形状
//   7. `modules/task-execution/infrastructure/taskAuthorization.ts`（已先行收敛）
//
// 七份里没有一份是「按引擎必须不同」——差异只有命名（`ref`/`viewer` vs `subject`）、
// 返回约定（`undefined` vs `1 = 1`）与绑定形态（字面量 vs `sql.placeholder`）。
// 这三件事现在都由唯一那份的参数承担。
//
// # 判据形状
//
// 判的是 **AST**，不是文本：文本匹配会把讲述历史的注释算成命中（本文件头就写满了这些名字，
// 而它自己必须不被自己判红）。两条互补的判据：
//
//   · **可见性析取式** —— `or(eq(<X>.ownerUserId, …), inArray(<Y>.id, …))`，无论 `<X>` 是
//     `tasks` 还是别名 `ref`；
//   · **协作者集合子查询** —— `.from(taskCollaborators).where(eq(taskCollaborators.userId, …))`，
//     即**只按 userId** 取一整集（点查成员身份的 `and(eq(taskId,…), eq(userId,…))` 是另一回事，
//     不在判据内）。
//
// 两条都必须**恰好命中一处**，且那一处必须是 `packages/backend/src/db/query.ts`。
import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'

import ts from 'typescript'

import { packageSrcUnits, sourceUnit, type SourceUnit } from './census'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..', '..')
const SINGLE_SOURCE = 'packages/backend/src/db/query.ts'
const UNITS = packageSrcUnits(REPO_ROOT, 'backend')

function calleeName(node: ts.CallExpression): string {
  const expression = node.expression
  if (ts.isIdentifier(expression)) return expression.text
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text
  return ''
}

/** `eq(<something>.ownerUserId, …)` / `inArray(<something>.id, …)` 这类首参属性名判定。 */
function firstArgumentProperty(node: ts.CallExpression): string {
  const first = node.arguments[0]
  if (first === undefined) return ''
  if (ts.isPropertyAccessExpression(first)) return first.name.text
  return ''
}

function hits(unit: SourceUnit, matches: (unit: SourceUnit, node: ts.Node) => boolean): number[] {
  const lines: number[] = []
  const visit = (node: ts.Node): void => {
    if (matches(unit, node)) {
      lines.push(unit.source.getLineAndCharacterOfPosition(node.getStart(unit.source)).line + 1)
    }
    ts.forEachChild(node, visit)
  }
  visit(unit.source)
  return lines
}

/**
 * `or(eq(x.ownerUserId, …), inArray(y.id, …))` —— 参数顺序不限。
 *
 * **必须再叠一层「这个文件谈的是任务协作者」**，否则判的就成了句式而不是概念：落守卫时它先
 * 命中了 `integration/infrastructure/scheduledTaskPersistence.ts` 的
 * `or(owner = 我, id IN (我被 grant 的定时任务))`——同一个形状，但那是
 * `scheduled_tasks` × `resource_grants`，与任务成员制毫无关系。
 *
 * 限定放在**文件级**而不是「`inArray` 的第二个实参子树里」：实测七份副本里有四份先把子查询
 * 绑到局部变量（`collaboratorIds` / `collaboratorTaskIds` / `memberIds`）再传进去，按子树判
 * 会**静默漏掉它们**（第一版就是这样，在收敛前的 HEAD 上只抓到 2/6——一条抓不全的守卫比没有
 * 更危险，因为它让人以为已经守住了）。
 */
function isVisibilityDisjunction(unit: SourceUnit, node: ts.Node): boolean {
  if (!ts.isCallExpression(node) || calleeName(node) !== 'or') return false
  if (!/\btaskCollaborator/.test(unit.text)) return false
  const calls = node.arguments.filter(ts.isCallExpression)
  const owner = calls.some(
    (call) => calleeName(call) === 'eq' && firstArgumentProperty(call) === 'ownerUserId',
  )
  const member = calls.some(
    (call) => calleeName(call) === 'inArray' && firstArgumentProperty(call) === 'id',
  )
  return owner && member
}

/** `.from(taskCollaborators).where(eq(taskCollaborators.userId, …))` —— 只按 userId 取整集。 */
function isCollaboratorSetSubquery(_unit: SourceUnit, node: ts.Node): boolean {
  if (!ts.isCallExpression(node) || calleeName(node) !== 'where') return false
  const chain = node.expression
  if (!ts.isPropertyAccessExpression(chain)) return false
  const from = chain.expression
  if (
    !ts.isCallExpression(from) ||
    calleeName(from) !== 'from' ||
    from.arguments[0] === undefined ||
    !ts.isIdentifier(from.arguments[0]) ||
    from.arguments[0].text !== 'taskCollaborators'
  ) {
    return false
  }
  const predicate = node.arguments[0]
  return (
    predicate !== undefined &&
    ts.isCallExpression(predicate) &&
    calleeName(predicate) === 'eq' &&
    firstArgumentProperty(predicate) === 'userId'
  )
}

function locate(
  units: readonly SourceUnit[],
  matches: (unit: SourceUnit, node: ts.Node) => boolean,
): string[] {
  return units.flatMap((unit) => hits(unit, matches).map((line) => `${unit.path}:${line}`))
}

describe('RFC-359 W57 —— 任务可见性判据只有一份', () => {
  test('语料下限：确实扫到了 backend 生产源码', () => {
    // 扫描根一旦失效（改目录、改 glob），下面两条会**永久静默地绿**——扫了 0 个文件，
    // 自然「恰好一处」也不成立、但也不会有任何东西提醒你。1500 是当前 1803 的保守下界。
    expect(UNITS.length).toBeGreaterThanOrEqual(1500)
  })

  test('可见性析取式 `or(owner = 我, id IN 我参与的)` 全仓恰好一处', () => {
    expect(
      locate(UNITS, isVisibilityDisjunction),
      '任务可见性是**授权判据**：抄第二份就等于给「用户看见不该看见的任务 / 丢掉本该看见的」' +
        `留一条无人看守的路。判据的唯一一份在 ${SINGLE_SOURCE}（taskVisibilityCondition），` +
        '它已经把命名、返回约定（undefined vs `1 = 1`）与绑定形态（字面量 vs sql.placeholder）' +
        '都做成了参数——需要哪种就传哪种，不要再写一份。',
    ).toEqual([expect.stringContaining(SINGLE_SOURCE)])
  })

  test('协作者集合子查询全仓恰好一处', () => {
    expect(
      locate(UNITS, isCollaboratorSetSubquery),
      '「我参与的任务 id」这一集的取法必须与可见性判据同源；各写各的，两条路迟早漂。' +
        `唯一一份是 ${SINGLE_SOURCE} 的 taskCollaboratorTaskIds。（按 taskId + userId 点查` +
        '成员身份是另一回事，不在本判据内。）',
    ).toEqual([expect.stringContaining(SINGLE_SOURCE)])
  })

  test('判据本身是 AST 判定：注释里写满这些名字也不算命中', () => {
    // 反向夹具——整段都是**文本**上的命中，AST 上一个都不是。
    const decoy = sourceUnit(
      'packages/backend/src/decoy.ts',
      [
        '// or(eq(tasks.ownerUserId, me), inArray(tasks.id, collaboratorTaskIds))',
        "const doc = 'or(eq(tasks.ownerUserId, x), inArray(tasks.id, y))'",
        '// .from(taskCollaborators).where(eq(taskCollaborators.userId, me))',
        'export const NOTE = doc',
      ].join('\n'),
    )
    expect(hits(decoy, isVisibilityDisjunction)).toEqual([])
    expect(hits(decoy, isCollaboratorSetSubquery)).toEqual([])
  })

  test('判据确实认得出真形状（正向夹具，避免守卫空转）', () => {
    const real = sourceUnit(
      'packages/backend/src/decoy2.ts',
      [
        'export function f(db: D, me: string) {',
        '  return or(',
        '    eq(tasks.ownerUserId, me),',
        '    inArray(',
        '      tasks.id,',
        '      db.select({ taskId: taskCollaborators.taskId }).from(taskCollaborators)',
        '        .where(eq(taskCollaborators.userId, me)),',
        '    ),',
        '  )',
        '}',
      ].join('\n'),
    )
    expect(hits(real, isVisibilityDisjunction)).toHaveLength(1)
    expect(hits(real, isCollaboratorSetSubquery)).toHaveLength(1)
  })
})
