// RFC-359 W5 —— 测试里**手搓的假 PostgreSQL 运行时**清单（高水位，只降不升）。
//
// 守的是什么
// ---------
// 「这个测试文件有没有自己造一个 PostgreSQL 池 / 连接 / 运行时，喂给被测代码。」
// 判据只有一种正形态：**一个对象字面量被直接安上 provider 运行时类型**
// （`const pool: PostgresqlPool = { … }`，或 `{ … } as PostgresqlDatabaseRuntime`）。
//
// 为什么要有这条守卫（隔壁那条守不到这里）
// -----------------------------------
// `rfc359-w5-provider-runtime-exercised` 守的是「provider 组合根有没有被测试**构造**过」，
// 它的账本已经清零。但「构造过」与「在真 PostgreSQL 上跑过」仍是两件事——
// 那条守卫自己的头注释就把这一点列为已查实的危害 ③：
// **构造了适配器、喂的却是假 pool，证明的是接线，不是 PostgreSQL 行为。**
// 那一层至今没有任何判据看着，本守卫补的就是它。
//
// 假池弱在哪，有一个决定性的实测例子（plan §5go）
// --------------------------------------------
// `rfc349-maintenance-disk-provider` 原来喂假池、断言「发出的 SQL 文本里出现过
// `pg_stat_user_tables`」。把生产查询改成 `pg_stat_user_tables_MUTANT`：
// **旧断言照过**（`toContain` 在 `..._MUTANT` 上为 true），改成真库后当场红在
// `PostgresError: relation … does not exist`。
// 假池不是「弱一点」——它对「表名写错」这类错误是**完全失明**的：
// `unsafe` 不管收到什么 SQL 都回罐头行，列名写错、schema 限定漏了、类型不对、真约束冲突，一律照过。
//
// **这个数字混着两类，降它之前必须先说清是哪一类**
// ---------------------------------------------
// 本守卫**刻意不做分类**，因为分类必须逐个读源码，而按语法形状聚类正是本 RFC 反复栽跟头的地方
// （plan §5gh → §5gi：「共用一个语法形状」不等于「共用一个根因」）。清单里确实混着两类：
//
//   · **正当的**：被测物就是驱动 / 编译器本身，真库反而看不到要验的东西。
//     实例：`rfc359-w22-postgresql-compile-reuse` 用假池当**编译探针**——把编译出来的 SQL
//     收下来、然后 `throw` 在驱动执行之前，验的是 `?` → `$1` 这套翻译；
//     `rfc349-resource-limit-provider` 数的是**连接 reserve 次数**与单行 INSERT 的围栏折叠形态，
//     真池给不出这个观测点。
//   · **该还的债**：被测物是业务行为，却拿罐头行代替数据库。plan §5gn 的 A 组就是这一类。
//
// 所以**想让某一行变小，只有两条路**：把它迁到真库（`describeEachProvider` / `harness.db` /
// `harness.applicationBinding` 在 PG 侧直接交出真的 `InstrumentedPostgresqlDatabaseRuntime`），
// 或者在提交说明里指名它属于上面「正当」那一类、为什么真库看不到要验的东西。
// **两个方向都红**：增了说明又有人手搓了一个假运行时；减了说明还债发生了，把账本一起改小，
// 让这次收敛留下一次有署名的提交记录。长期目标不是 0（正当的那一类会留下来），是**债那部分清零**。
//
// 迁移姿势见 plan §5gn / §5go，其中硬性要求一条：**每迁一个都要给出变异验证**
// ——迁移前那处变异只红一格、迁移后两格都红。否则只是把假池换成了真库，没换来覆盖。

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { describe, expect, test } from 'bun:test'
import ts from 'typescript'

const TESTS = resolve(import.meta.dir, '..')

/** 安在对象字面量上就意味着「这是我自己造的 provider 运行时」的三个类型。 */
const FAKE_RUNTIME_TYPES: ReadonlySet<string> = new Set([
  'PostgresqlPool',
  'PostgresqlReservedConnection',
  'PostgresqlDatabaseRuntime',
])

/**
 * `<相对 tests 的路径>: <个数>`，按路径字典序。只降不升。
 *
 * 落地时 69 个文件、183 处。
 */
export const FAKE_POSTGRESQL_RUNTIME_LITERALS: readonly string[] = [
  'rfc349-child-execution-launch-postgresql-adapter.test.ts: 3',
  'rfc349-code-attempts-postgresql-adapter.test.ts: 3',
  'rfc349-code-delivery-postgresql-adapter.test.ts: 3',
  'rfc349-code-demo-seed-provider.test.ts: 3',
  'rfc349-code-history-composition.test.ts: 3',
  'rfc349-code-legacy-facades-postgresql-adapter.test.ts: 3',
  'rfc349-code-matrix-postgresql-adapter.test.ts: 3',
  'rfc349-code-metrics-postgresql-adapter.test.ts: 3',
  'rfc349-code-readiness-postgresql-adapter.test.ts: 3',
  'rfc349-code-template-upstream-postgresql-adapter.test.ts: 3',
  'rfc349-code-work-items-postgresql-adapter.test.ts: 3',
  'rfc349-collaboration-runtime-mechanics.test.ts: 3',
  'rfc349-daemon-provider-core.test.ts: 3',
  'rfc349-database-migration-runner.test.ts: 1',
  'rfc349-database-operational-adapter.test.ts: 2',
  'rfc349-database-provider-runtime.test.ts: 2',
  'rfc349-development-admission-postgresql-adapter.test.ts: 3',
  'rfc349-development-integration-composition.test.ts: 3',
  'rfc349-digital-development-maintenance-postgresql.test.ts: 6',
  'rfc349-dual-provider-behavior-oracle.test.ts: 3',
  'rfc349-event-delivery-provider-adapters.test.ts: 3',
  'rfc349-integration-provider-adapters.test.ts: 3',
  'rfc349-intent-sql-persistence.test.ts: 3',
  'rfc349-memory-distill-postgresql-adapter.test.ts: 3',
  'rfc349-memory-injection-postgresql-adapter.test.ts: 3',
  'rfc349-migration-long-transaction-faults.test.ts: 5',
  'rfc349-oidc-provider-persistence.test.ts: 3',
  'rfc349-owner-identity-provider.test.ts: 3',
  'rfc349-port-artifact-provider.test.ts: 3',
  'rfc349-portable-database-restore.test.ts: 2',
  'rfc349-postgresql-admin-backup.test.ts: 2',
  'rfc349-postgresql-admin-restore.test.ts: 1',
  'rfc349-postgresql-database-client.test.ts: 3',
  'rfc349-postgresql-intent-maintenance.test.ts: 3',
  'rfc349-postgresql-logical-source.test.ts: 3',
  'rfc349-postgresql-logical-target-finalization.test.ts: 3',
  'rfc349-postgresql-logical-target-invariants.test.ts: 5',
  'rfc349-postgresql-migrator.test.ts: 3',
  'rfc349-postgresql-preflight.test.ts: 3',
  'rfc349-postgresql-provider-backup.test.ts: 3',
  'rfc349-postgresql-runtime.test.ts: 2',
  'rfc349-postgresql-system-operations-composition.test.ts: 2',
  'rfc349-provider-doctor.test.ts: 2',
  'rfc349-repository-preparation-postgresql-adapter.test.ts: 3',
  'rfc349-repository-workspace-provider.test.ts: 3',
  'rfc349-resource-limit-provider.test.ts: 3',
  'rfc349-runtime-registry-provider.test.ts: 3',
  'rfc349-runtime-session-lease-provider.test.ts: 3',
  'rfc349-source-control-provider-adapters.test.ts: 3',
  'rfc349-system-maintenance-provider.test.ts: 9',
  'rfc349-target-coverage-linear-grouping.test.ts: 2',
  'rfc349-task-execution-provider-adapters.test.ts: 3',
  'rfc349-task-route-launch-postgresql-adapter.test.ts: 3',
  'rfc349-task-transaction-participants.test.ts: 3',
  'rfc349-workspace-maintenance-provider.test.ts: 3',
  'rfc359-t19h-postgresql-upgrade.integration.test.ts: 2',
  'rfc359-t19h-postgresql-upgrade.test.ts: 2',
  'rfc359-w14-performance-query-profile.test.ts: 1',
  'rfc359-w19-production-overview-dispatch.test.ts: 1',
  'rfc359-w20-repository-search-conformance.test.ts: 1',
  'rfc359-w21-task-page-non-view-inline-conformance.test.ts: 1',
  'rfc359-w22-postgresql-compile-reuse.test.ts: 1',
  'rfc359-w23-task-page-root-metadata.test.ts: 1',
  'rfc359-w25-overview-template-conformance.test.ts: 1',
  'rfc359-w25-task-page-bounded-prefix.test.ts: 1',
  'rfc359-w26-workgroup-empty-scan.test.ts: 1',
  'rfc359-w27-task-prefix-lookup-conformance.test.ts: 1',
  'rfc359-w6-t26-postgresql-plan-audit.test.ts: 1',
  'rfc359-w8-system-operations-recovery-conformance.test.ts: 2',
]

function walk(root: string, dir: string, out: string[]): string[] {
  for (const entry of readdirSync(join(root, dir))) {
    const rel = dir === '' ? entry : `${dir}/${entry}`
    if (statSync(join(root, rel)).isDirectory()) walk(root, rel, out)
    else if (rel.endsWith('.ts')) out.push(rel)
  }
  return out
}

function typeNameOf(node: ts.TypeNode | undefined): string | undefined {
  if (node === undefined) return undefined
  if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) return node.typeName.text
  return undefined
}

/**
 * 剥掉中间的断言 / 括号，看底下是不是一个对象字面量。
 *
 * 为什么必须剥：`{ … } as unknown as PostgresqlPool` 是**同一件事**的另一种写法
 * （`as unknown` 那一跳是为了绕开类型检查），只认一层就会漏。
 * 写这条守卫时的负 fixture 第一版正是用这个写法探的——探针没红，才发现判据有这个盲点，
 * 而真语料里确实躺着一处（`rfc359-w6-t26-postgresql-plan-audit`）。
 * **一个探不出新增的高水位守卫等于没写**：它唯一的价值就是挡住新增。
 */
function underlyingObjectLiteral(node: ts.Expression): ts.ObjectLiteralExpression | undefined {
  let current: ts.Expression = node
  for (;;) {
    if (ts.isObjectLiteralExpression(current)) return current
    if (ts.isAsExpression(current) || ts.isSatisfiesExpression(current))
      current = current.expression
    else if (ts.isParenthesizedExpression(current)) current = current.expression
    else return undefined
  }
}

/**
 * 一个源文件里手搓的 provider 运行时个数。
 *
 * 纯函数（只吃 `SourceFile`，不碰文件系统），所以下面的负 fixture 喂的是与账本**同一份**判据
 * ——不是判据的一份拷贝。用 AST 而不是正则：注释与字符串字面量里出现同样的字不该算数，
 * 而剥注释的正则迟早会吃掉真代码（本仓既有教训）。
 */
export function fakeProviderRuntimeLiterals(source: ts.SourceFile): number {
  // 数**不同的对象字面量**，而不是数匹配到的节点：
  // `const p: PostgresqlPool = { … } as unknown as PostgresqlPool` 会同时命中
  // 「带类型注解的声明」与「外层断言」两条——那是同一个假池把类型写了两遍，不是两个假池。
  const literals = new Set<ts.ObjectLiteralExpression>()
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.initializer !== undefined) {
      const name = typeNameOf(node.type)
      const literal = underlyingObjectLiteral(node.initializer)
      if (name !== undefined && FAKE_RUNTIME_TYPES.has(name) && literal !== undefined)
        literals.add(literal)
    }
    if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
      const name = typeNameOf(node.type)
      const literal = underlyingObjectLiteral(node.expression)
      if (name !== undefined && FAKE_RUNTIME_TYPES.has(name) && literal !== undefined)
        literals.add(literal)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return literals.size
}

function measured(): string[] {
  const rows: string[] = []
  for (const rel of walk(TESTS, '', []).sort()) {
    const text = readFileSync(join(TESTS, rel), 'utf8')
    // 廉价预筛：三个类型名有一个出现在文本里才值得解析（省掉 1700 余次无谓的 AST 解析）。
    // 预筛不改判据——类型名不出现在文本里，就不可能有安着它的字面量。
    if (!/Postgresql(?:Pool|ReservedConnection|DatabaseRuntime)/.test(text)) continue
    const count = fakeProviderRuntimeLiterals(
      ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true),
    )
    if (count > 0) rows.push(`${rel}: ${count}`)
  }
  return rows
}

describe('RFC-359 W5 —— 手搓的假 PostgreSQL 运行时（高水位，只降不升）', () => {
  test('语料非空：测试树本身不能扫成空（扫成 0 时本文件零预言力）', () => {
    expect(walk(TESTS, '', []).length).toBeGreaterThanOrEqual(500)
    expect(FAKE_POSTGRESQL_RUNTIME_LITERALS.length).toBeGreaterThan(0)
  }, 30_000)

  test('逐文件个数与账本逐字相等（增了是又一个假运行时，减了是还债，都要改账本）', () => {
    expect(
      measured(),
      '手搓假 PostgreSQL 运行时的清单变了。**增**了说明又有人用罐头行代替数据库——' +
        '那种测试对「列名写错 / schema 限定漏了 / 类型不对 / 真约束冲突」一律失明' +
        '（plan §5go 有一个决定性实例：把表名改错，旧断言照过、真库当场红）。' +
        '改用真库：`describeEachProvider` 取 `harness.db`，要真 runtime 就取 ' +
        '`harness.applicationBinding`（PG 侧直接给 `InstrumentedPostgresqlDatabaseRuntime`）。' +
        '确有理由手搓（被测物就是驱动 / 编译器本身，真库看不到要验的东西），' +
        '把新增写进账本并在提交说明里指名是哪一类。' +
        '**减**了说明还债发生了——把账本一起改小，让这次收敛留下一次有署名的提交记录。',
    ).toEqual([...FAKE_POSTGRESQL_RUNTIME_LITERALS])
  }, 30_000)

  // 负 fixture：把**伪造**的源码喂给账本用的**同一个**判据，证明它还咬得动。
  // 不碰真实语料——真语料的形状会随还债而变，拿它当 fixture 等于让 fixture 随时失效。
  describe('判据自身仍在工作（负 fixture）', () => {
    const parse = (text: string): ts.SourceFile =>
      ts.createSourceFile('fixture.ts', text, ts.ScriptTarget.Latest, true)

    test('注解形态的手搓池被数到', () => {
      expect(
        fakeProviderRuntimeLiterals(parse('const pool: PostgresqlPool = { unsafe() {} }')),
      ).toBe(1)
    })

    test('断言形态（as / satisfies）的手搓运行时被数到', () => {
      expect(
        fakeProviderRuntimeLiterals(
          parse('const rt = { provider: "postgresql" } as PostgresqlDatabaseRuntime'),
        ),
      ).toBe(1)
      expect(
        fakeProviderRuntimeLiterals(
          parse('const c = { release() {} } satisfies PostgresqlReservedConnection'),
        ),
      ).toBe(1)
    })

    test('注释与字符串字面量里的同名不算数（这正是用 AST 而不是正则的原因）', () => {
      expect(
        fakeProviderRuntimeLiterals(
          parse('// const pool: PostgresqlPool = {}\nconst s = "const pool: PostgresqlPool = {}"'),
        ),
      ).toBe(0)
    })

    test('`as unknown as` 那种绕一跳的写法也要数到（判据第一版正是漏在这里）', () => {
      expect(
        fakeProviderRuntimeLiterals(
          parse('const pool: PostgresqlPool = { unsafe() {} } as unknown as PostgresqlPool'),
        ),
      ).toBe(1)
    })

    test('拿到的是真运行时（不是对象字面量）不算数', () => {
      expect(
        fakeProviderRuntimeLiterals(
          parse('const pool: PostgresqlPool = harness.applicationBinding.runtime.providerPool()'),
        ),
      ).toBe(0)
    })
  })
})
