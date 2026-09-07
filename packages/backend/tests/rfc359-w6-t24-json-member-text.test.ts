// RFC-359 W6-T24 —— 能力矩阵的 JSON 取值算子 `jsonMemberText`：等价、闭合、且真的换掉了 shim。
//
// # 这个文件为什么存在
//
// 列表页此前用一段**同一份文本**在两个引擎上取工作组名：`json_valid` + `json_type` +
// `json_extract` 三层 CASE。SQLite 上这三个是内建 C 函数；PostgreSQL 上它们是
// `agent_workflow` schema 里的三个 **plpgsql shim，每个都带 EXCEPTION 块**——而带 EXCEPTION
// 的 plpgsql 块每次调用都要开一个子事务，这笔钱是**逐行**付的。
//
// W6-T24 把这段表达式收进能力矩阵，PostgreSQL 侧改渲染原生 `->` / `->>`。
// 真库实测（2026-09-07，PostgreSQL 17.11，`EXPLAIN (ANALYZE)` 取 4 次里最好的一次）：
//
//   | 语料 / 语句                                   | shim      | 原生算子  | 倍数  |
//   |----------------------------------------------|-----------|-----------|-------|
//   | 5 万行 `count(表达式)`（合成语料）            | 296.6ms   | 91.3ms    | 3.2×  |
//   | 5 万行 `WHERE lower(表达式) LIKE …`           | 299.2ms   | 96.0ms    | 3.1×  |
//   | **真实列表页**：`q` 搜索（过滤快路径）        | 160.7ms   | 78.0ms    | 2.06× |
//   | **真实列表页**：默认视图首页                  | 7.8ms     | 7.9ms     | 0.99× |
//
// 最后一行是本次改造的**判据边界**：默认视图只对返回的 21 行求值，本来就不热，量不出差别。
// 热的只有 `q` 搜索那一处（谓词逐行求值）。四处仍然一起改，理由不是数字而是结构——
// 它们是同一段表达式，此前分写四遍并靠一句注释「改一处必须改两处」维持一致。
//
// # 判据
//
//  ①【结果等价】19 格语料上，`jsonMemberText` 与**改造前那段 SQL 原文**逐格相等——两个引擎
//    各验一遍。这是「改造前后同一份语料上的查询结果逐字节相同」的直接见证。
//  ②【跨引擎闭合】同一 19 格在两个引擎上的答案表也逐格相等，**除了一格**：JSON 字符串里含
//    `\0` 时 SQLite 给值、PostgreSQL 给 NULL（PG 的 jsonb 拒绝这个码点）。这条差异
//    **改造前就存在**（老 shim 同样走 `value::jsonb`），①因此照样绿——它是既有差异，不是本刀
//    引入的，账在这里明写。
//  ③【非法 JSON 不抛】三种非法文档上只给 NULL。附一张实测的求值顺序矩阵，见那一条的注释。
//  ④【成员名闭集】越界的成员名在渲染 SQL 之前就抛。
//  ⑤【源码形状】列表页四处不再出现任何 JSON shim 调用，全部走同一个 `workgroupNameExpression`。
//
// # 语料**必须落在真表的列上**（这条测试自己踩过的坑）
//
// 最初这里把语料写成 `select <表达式> from (select ? as v) d`。那个形状在 PostgreSQL 上会
// **常量折叠**：整个表达式在计划期就被求值，于是非法 JSON 行上 `(v)::jsonb` 当场抛
// `invalid input syntax for type json`——**与 CASE / AND 无关，两种写法都抛**（下面 ③ 的
// 矩阵是实测）。而生产里这个表达式作用在 `tasks.workgroup_config_json` 这样的**表列**上，
// planner 不会预先求值，两种写法都安全。所以语料一律落进一张真表再查。

import { describe, expect, test } from 'bun:test'
import { sql, type SQL } from 'drizzle-orm'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

import { tasks, workflows } from '@/db/schema'
import { jsonMemberSqlLiterals } from '@/platform/persistence/capabilities'
import { describeEachProvider } from './helpers/eachProvider'

const PAGE_DIR = resolve(
  import.meta.dir,
  '..',
  'src',
  'modules',
  'task-execution',
  'infrastructure',
  'taskListPage',
)

function pageSource(): string {
  return readdirSync(PAGE_DIR)
    .filter((entry) => entry.endsWith('.ts'))
    .sort()
    .map((entry) => readFileSync(resolve(PAGE_DIR, entry), 'utf8'))
    .join('\n')
}

/**
 * 改造前的表达式原文，逐字保留（`filters.ts` / `query.ts` 四处当时都是这一段，别名换成
 * `d`）。它是①的 oracle：新旧两侧在同一行上求值，答案必须一格不差。
 * 注意 `IN ('text', 'string')` 的双拼法——那正是「一段文本喂两个引擎」的痕迹，
 * 也正是本刀要消灭的东西。
 */
const LEGACY_EXPRESSION = sql`CASE WHEN json_valid(d.workgroup_config_json) THEN
    CASE WHEN json_type(d.workgroup_config_json, '$.workgroupName') IN ('text', 'string')
      THEN NULLIF(json_extract(d.workgroup_config_json, '$.workgroupName'), '')
      ELSE NULL
    END
  ELSE NULL END`

/** 19 格语料：文档形状 × 成员形状，含三种非法文档与 SQL NULL。 */
const CORPUS: readonly (readonly [string, string | null])[] = [
  ['object/string', '{"workgroupName":"alpha"}'],
  ['object/string-empty', '{"workgroupName":""}'],
  ['object/string-unicode', '{"workgroupName":"组 é😀"}'],
  ['object/number', '{"workgroupName":42}'],
  ['object/bool', '{"workgroupName":true}'],
  ['object/json-null', '{"workgroupName":null}'],
  ['object/array', '{"workgroupName":["a"]}'],
  ['object/object', '{"workgroupName":{"a":1}}'],
  ['object/missing', '{"other":"x"}'],
  ['array-doc', '[1,2,3]'],
  ['scalar-string-doc', '"just a string"'],
  ['scalar-number-doc', '7'],
  ['literal-null-doc', 'null'],
  ['invalid', 'not json'],
  ['truncated', '{"workgroupName":"a'],
  ['empty-string-doc', ''],
  ['nul-escape', '{"workgroupName":"a\\u0000b"}'],
  ['huge-exponent', '{"workgroupName":"x","n":1e400}'],
  ['sql-null', null],
]

/**
 * 两个引擎**都**给出的答案（②的闭合表）。唯一的例外 `nul-escape` 不在这里，
 * 它按引擎分列在下面的 `NUL_ESCAPE_BY_ENGINE` 里。
 */
const SHARED_ANSWERS: Readonly<Record<string, string | null>> = {
  'object/string': 'alpha',
  // 空串由列表页外层的 `NULLIF(…, '')` 收成 NULL；矩阵本身照原样给回空串。
  'object/string-empty': null,
  'object/string-unicode': '组 é😀',
  'object/number': null,
  'object/bool': null,
  'object/json-null': null,
  'object/array': null,
  'object/object': null,
  'object/missing': null,
  'array-doc': null,
  'scalar-string-doc': null,
  'scalar-number-doc': null,
  'literal-null-doc': null,
  invalid: null,
  truncated: null,
  'empty-string-doc': null,
  'huge-exponent': 'x',
  'sql-null': null,
}

/**
 * 唯一的跨引擎分叉，**改造前就存在**：JSON 字符串里的 `\0`。
 * SQLite 的 `json_valid` 收，PostgreSQL 的 jsonb 不收（`unsupported Unicode escape sequence`），
 * 两个 provider 因此一个给值一个给 NULL。①的新旧对拍在两侧各自照旧成立，所以这条不是回归。
 */
const NUL_ESCAPE_BY_ENGINE = { sqlite: 'a\u0000b', postgresql: null } as const

describeEachProvider('RFC-359 W6-T24 —— jsonMemberText', (harness) => {
  /**
   * 语料落进**生产那张表的那一列**：`tasks.workgroup_config_json`。
   * 不另建临时表有两个原因：① PostgreSQL 的业务客户端按设计拒绝 DDL
   * （`postgresql-ddl-through-business-client`）；② 表列正是让 planner 不做常量折叠的形状，
   * 见头注释「语料必须落在真表的列上」。
   */
  const seed = async (): Promise<void> => {
    await harness.db.insert(workflows).values({ id: 'wf-t24', name: 'w6t24', definition: '{}' })
    await harness.db.insert(tasks).values(
      CORPUS.map(([label, document], index) => ({
        id: `w6t24-${String(index).padStart(2, '0')}`,
        name: label,
        workflowId: 'wf-t24',
        workflowSnapshot: '{}',
        repoPath: '/repo',
        repoUrl: 'git@example.com:acme/r.git',
        worktreePath: '/tmp/wt',
        baseBranch: 'main',
        branch: 'agent-workflow/w6t24',
        status: 'done' as const,
        inputs: '{}',
        startedAt: 1,
        runningMs: 0,
        ownerUserId: null,
        invocationDepth: 0,
        launchOrigin: 'manual' as const,
        branchStartedAt: 1,
        rootTaskId: `w6t24-${String(index).padStart(2, '0')}`,
        workgroupConfigJson: document,
      })),
    )
  }

  const evaluateAll = async (expression: SQL): Promise<Record<string, unknown>> => {
    const rows = await harness.db.all<{ label: string; r: unknown }>(
      sql`SELECT d.name AS label, ${expression} AS r FROM tasks d`,
    )
    return Object.fromEntries(rows.map((row) => [row.label, row.r ?? null]))
  }

  /** 列表页的调用形状：矩阵给成员值，外层 NULLIF 是产品判据。 */
  const pageShape = (): SQL =>
    sql`NULLIF(${harness.capabilities.jsonMemberText(sql.raw('d.workgroup_config_json'), 'workgroupName')}, '')`

  test('① 19 格语料上，新算子与改造前的 SQL 原文逐格相等（结果等价的直接见证）', async () => {
    await seed()
    const before = await evaluateAll(LEGACY_EXPRESSION)
    const after = await evaluateAll(pageShape())
    expect(Object.keys(before).length, '语料没有全部落库').toBe(CORPUS.length)
    expect(after, '改造前后在同一份语料上必须逐格相同').toEqual(before)
  })

  test('② 答案表闭合：18 格两个引擎一致，第 19 格（\\u0000）是改造前就有的既有差异', async () => {
    await seed()
    const seen = await evaluateAll(pageShape())
    const { 'nul-escape': nulEscape, ...shared } = seen
    expect(shared).toEqual(SHARED_ANSWERS)
    expect(nulEscape).toBe(NUL_ESCAPE_BY_ENGINE[harness.capabilities.provider])
    // 同一格上跑改造前的表达式：答案必须与改造后一致 ⇒ 这条差异不是本刀引入的。
    expect((await evaluateAll(LEGACY_EXPRESSION))['nul-escape']).toBe(
      NUL_ESCAPE_BY_ENGINE[harness.capabilities.provider],
    )
  })

  test('③ 非法 JSON 行上只给 NULL、不抛（三种非法文档）', async () => {
    // 求值顺序的实测矩阵（2026-09-07，PostgreSQL 17.11，语料 'not json'）——
    // 记在这里是因为它**推翻了本刀最初的判断**：
    //
    //   | 语料位置                          | 嵌套 CASE | `AND` 短路 |
    //   |-----------------------------------|-----------|-----------|
    //   | 真表的列（生产形状）              | 不抛      | 不抛      |
    //   | `(select ? as v) d` 的子查询      | **抛**    | **抛**    |
    //   | `(select 'not json'::text as v) d`| **抛**    | **抛**    |
    //
    // 也就是说：`AND` 会不会被 planner 重排，在**这一处**不是判据——真表列上两种写法都安全，
    // 而常量折叠得到的表达式两种写法都不安全（PostgreSQL 文档里 CASE 的保护本来就对
    // 「被折叠成常量的子表达式」不成立）。实现仍然写嵌套 CASE：那是 PostgreSQL 文档为
    // 「按条件控制求值」指定的构造，代价为零，不必赌 planner 的重排规则。
    await seed()
    const seen = await evaluateAll(
      harness.capabilities.jsonMemberText(sql.raw('d.workgroup_config_json'), 'workgroupName'),
    )
    expect({
      invalid: seen['invalid'],
      truncated: seen['truncated'],
      empty: seen['empty-string-doc'],
    }).toEqual({ invalid: null, truncated: null, empty: null })
  })

  test('④ 成员名是闭集：越界的名字在渲染 SQL 之前就抛，不会被拼进语句', () => {
    expect(jsonMemberSqlLiterals('workgroupName')).toEqual({
      path: "'$.workgroupName'",
      key: "'workgroupName'",
    })
    for (const bad of ["a'b", 'a.b', '1abc', '', 'a b', 'a-b', '$.a']) {
      expect(
        () => harness.capabilities.jsonMemberText(sql.raw('d.workgroup_config_json'), bad),
        JSON.stringify(bad),
      ).toThrow(/成员名必须匹配/)
    }
  })
})

describe('RFC-359 W6-T24 —— 列表页不再自己写 JSON shim', () => {
  test('⑤ 四处工作组名收敛成一个 workgroupNameExpression，页源码里不再出现 JSON shim 调用', () => {
    const source = pageSource()
    // 注释里仍然可以提这些名字（它们记着这段历史），所以只扫**调用**形态 `name(`。
    const called = [
      ...source.matchAll(/\b(json_valid|json_type|json_extract|instr|unixepoch|randomblob)\s*\(/gu),
    ].map((match) => match[1]!)
    expect(
      [...new Set(called)].sort(),
      'JSON 取值应当只经能力矩阵渲染；页源码里出现 shim 调用意味着又有人手写了一份',
    ).toEqual(['instr'])

    // 定义 1 处 + 调用 4 处。少一处就说明有人把某条路径漏在了旧形状上。
    expect((source.match(/workgroupNameExpression\(/gu) ?? []).length).toBe(5)
  })
})
