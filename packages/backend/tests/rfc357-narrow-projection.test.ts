// RFC-357 —— 「这一页只为返回的一页付费」的形状守卫。
//
// 为什么这条测试存在：PostgreSQL 上任务列表慢，慢的不是数据库。目录源此前对三个源各发一次
// `listItems({ limit: 10_000 })`（条件字节相同、结果三选一），那条查询是裸
// `db.select().from(tasks)`——把 `workflow_snapshot`（整份工作流定义 JSON）等大列一起搬回来，
// 而列表项一个都不读；失败任务再逐行发一次 `SELECT … FROM node_runs`。RFC-311 audit L1-8
// 在 SQLite 侧修掉的正是同一个形状，注释里记着「每行上百 KB」。
//
// 这些都是**形状**缺陷：功能全对、测试全绿、只是慢，所以没有任何行为断言会红。守卫因此
// 直接钉形状——它挡的是「下一个人顺手把大列加回投影」或「再引入一次 N+1」。

import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

const SRC = resolve(import.meta.dir, '..', 'src')
const PAGE_DIR = resolve(SRC, 'modules', 'task-execution', 'infrastructure', 'taskListPage')

const read = (...parts: string[]): string => readFileSync(resolve(SRC, ...parts), 'utf8')

/**
 * 源码文本判据只看**代码**，散文一律剥掉。
 *
 * 这不是洁癖：本 RFC 里同一个坑踩了两次——「文件里不许出现 X」的否定断言被解释「X 曾经
 * 是个 bug」的注释自己命中。注释越把缺陷讲清楚，守卫越容易误报，这是个反向激励。
 */
function codeOf(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n')
}

/** 列表项真正消费的列。任何一列以外的东西进投影都要有理由。 */
const LIST_COLUMNS = [
  'id',
  'name',
  'workflowId',
  'repoPath',
  'repoUrl',
  'cachedRepoId',
  'status',
  'startedAt',
  'finishedAt',
  'errorSummary',
  'repoCount',
  'scheduledTaskId',
  'workgroupId',
  'workgroupConfigJson',
  'spaceKind',
  'parentTaskId',
  'invocationDepth',
  'sourceAgentName',
  'sourceAgentId',
  'codeRoundId',
  'failedNodeId',
  'ownerUserId',
] as const

/** 只在整行详情里才需要、绝不该出现在列表投影里的大列。 */
const HEAVY_COLUMNS = [
  'workflowSnapshot',
  'inputs',
  'errorMessage',
  'triggerContextJson',
  'refClosureJson',
] as const

describe('RFC-357 the task list never pays for rows or columns it does not return', () => {
  test('the catalog source has exactly one implementation, shared by both providers', () => {
    const shared = read(
      'modules',
      'task-execution',
      'infrastructure',
      'taskExecutionCatalogSources.ts',
    )
    // 适配本身（归一 item、拼 hierarchy、取 facets）只在这一个文件里。
    expect(shared).toContain('function normalizeItem(')
    expect(shared).toContain('createTaskExecutionCatalogSourceFactory')

    // RFC-359 W4-B1 批 2f：两个 provider 的装配薄壳合成一份 `taskCatalogSources.ts`，仍只许装配：
    // 不许自己归一、不许自己数 facets、不许自己分页。
    const entry = 'taskCatalogSources.ts'
    const source = codeOf(read('modules', 'task-execution', 'infrastructure', entry))
    expect(source).toContain('createTaskExecutionCatalogSourceFactory')
    for (const forbidden of ['normalizeItem', 'facets:', 'nextCursor', '.filter(', '.sort(']) {
      expect(source, `${entry} must not re-implement ${forbidden}`).not.toContain(forbidden)
    }
  })

  test('no provider path pulls an unbounded page into memory', () => {
    const dir = resolve(SRC, 'modules', 'task-execution', 'infrastructure')
    for (const entry of readdirSync(dir).filter((name) => name.endsWith('.ts'))) {
      const source = codeOf(readFileSync(resolve(dir, entry), 'utf8'))
      expect(source, `${entry} must not request a 10k page`).not.toContain('limit: 10_000')
      expect(source, `${entry} must not request a 10k page`).not.toContain('limit: 10000')
    }
  })

  test('the /api/tasks row projection lists its columns and carries none of the heavy ones', () => {
    const source = read(
      'modules',
      'task-execution',
      'infrastructure',
      'postgresqlTaskRouteOperations.ts',
    )
    const block = source.slice(
      source.indexOf('const TASK_LIST_COLUMNS = {'),
      source.indexOf('} as const', source.indexOf('const TASK_LIST_COLUMNS = {')),
    )
    expect(block.length).toBeGreaterThan(0)
    for (const column of LIST_COLUMNS) {
      expect(block, `TASK_LIST_COLUMNS is missing ${column}`).toContain(
        `${column}: tasks.${column}`,
      )
    }
    for (const heavy of HEAVY_COLUMNS) {
      expect(block, `TASK_LIST_COLUMNS must not carry ${heavy}`).not.toContain(`tasks.${heavy}`)
    }
    // 列清单存在还不够——`listRows` 必须真的用它，而不是留一份摆设再走 `select()`。
    const listRows = source.slice(source.indexOf('async function listRows('))
    expect(listRows.slice(0, 1600)).toContain('.select(TASK_LIST_COLUMNS)')
  })

  test('failure codes are loaded in one batch, not one query per failed row', () => {
    const source = codeOf(
      read('modules', 'task-execution', 'infrastructure', 'postgresqlTaskRouteOperations.ts'),
    )
    const listSummaries = source.slice(
      source.indexOf('async function listSummaries('),
      source.indexOf('async function listItems('),
    )
    expect(listSummaries).toContain('loadTaskFailureCodes(db, rows)')
    // 逐行 await 的形状是这个缺陷的签名，挡住它。
    expect(listSummaries).not.toMatch(/rows\.map\(async/u)
    expect(listSummaries).not.toContain('await failedCode(')
  })

  test('the shared query pages with a keyset boundary and a limit, never a full scan', () => {
    const query = readFileSync(resolve(PAGE_DIR, 'query.ts'), 'utf8')
    // 三条页查询都必须以 `LIMIT limit + 1` 收口。
    expect(query.match(/LIMIT \$\{(?:parsed\.)?limit \+ 1\}/gu)?.length).toBe(3)
    // 行值断点：展开成 OR 会让 SQLite 落 TEMP B-TREE（RFC-311 实测）。
    expect(query).toContain('(t.branch_started_at, t.id) < (')
  })
})
