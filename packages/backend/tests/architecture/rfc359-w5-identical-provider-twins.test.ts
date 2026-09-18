// RFC-359 W5 —— **函数体逐字相同**的 provider 孪生：必须为零。
//
// # 这条守卫抓的是最廉价、也最容易再犯的一种重复
//
// 不是「两套实现慢慢漂」，而是「同一台机器抄了两遍名字」：
//
//     export function composeSqliteX(input: { db: DbClient; … }) { …body… }
//     export function composePostgresqlX(input: { db: PostgresqlDatabaseClient; … }) { …同一段 body… }
//
// 两个函数体**逐字节相同**，唯一的差别是形参上那个 `db` 的声明类型——而它们转交给的下游本来就
// 收 `ProviderNeutralDatabase`。这类东西通常是某次「先把名字占住、bootstrap 收敛后再删」留下的，
// 而那句注释一挂就是几个波次没人回来收。
//
// 2026-09-13 这条判据第一次跑时扫出 **14 对**（plan §5ds），全部在同一天还清：八对直接指向已有的
// 中立实现，六对的相同函数体是**内联**的，先提成一份中立实现再收。归零之后这条守卫留下来，
// 任何人再写出一对当场红。
//
// # 判据（纯语法，逐条可复跑）
//
//   · 函数名匹配 `(compose|create|make|build)(Sqlite|LegacySqlite|Postgresql)(Base)`；
//   · 同一个 `Base` 下，一侧 sqlite 一侧 postgresql；
//   · 两侧函数体 `replace(/\s+/g, ' ').trim()` 后**全等**。
//
// 它**挑不出**「函数体不同但语义相同」的那些——那类靠 `rfc359-w5-provider-pair-conformance`
// 的成对账本与各自的双引擎对拍。但它挑出来的每一条都是**无可争辩**的纯名字重复：
// 两段相同的源码，没有任何「机制差异」可以为它辩护。

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import ts from 'typescript'

const SRC = resolve(import.meta.dir, '..', '..', 'src')
const PROVIDER_FUNCTION = /^(compose|create|make|build)(LegacySqlite|Sqlite|Postgresql)(.+)$/

interface ProviderFunction {
  readonly file: string
  readonly name: string
  readonly base: string
  readonly side: 'sqlite' | 'postgresql'
  readonly body: string
}

function sourceFiles(): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(join(SRC, dir), { withFileTypes: true })) {
      const rel = dir === '' ? entry.name : `${dir}/${entry.name}`
      if (entry.isDirectory()) walk(rel)
      else if (entry.name.endsWith('.ts')) out.push(rel)
    }
  }
  walk('')
  return out
}

/** 判据本体：纯函数（输入是「路径 → 源码」），供真实树与内存 fixture 共用。 */
export function providerFunctions(
  files: readonly { readonly path: string; readonly text: string }[],
): ProviderFunction[] {
  const out: ProviderFunction[] = []
  for (const file of files) {
    const src = ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, true)
    for (const statement of src.statements) {
      if (!ts.isFunctionDeclaration(statement)) continue
      if (statement.name === undefined || statement.body === undefined) continue
      const matched = PROVIDER_FUNCTION.exec(statement.name.text)
      if (matched === null) continue
      out.push({
        file: file.path,
        name: statement.name.text,
        base: `${matched[1]!}:${matched[3]!}`,
        side: matched[2]!.toLowerCase().includes('postgresql') ? 'postgresql' : 'sqlite',
        body: statement.body.getText(src).replace(/\s+/g, ' ').trim(),
      })
    }
  }
  return out
}

/** `<base>: <sqlite 侧名字> == <postgresql 侧名字>`，按 base 字典序。 */
export function identicalTwins(functions: readonly ProviderFunction[]): string[] {
  const grouped = new Map<string, ProviderFunction[]>()
  for (const fn of functions) grouped.set(fn.base, [...(grouped.get(fn.base) ?? []), fn])
  const rows: string[] = []
  for (const [base, group] of grouped) {
    for (const left of group.filter((fn) => fn.side === 'sqlite')) {
      for (const right of group.filter((fn) => fn.side === 'postgresql')) {
        if (left.body !== right.body) continue
        rows.push(`${base}: ${left.name} == ${right.name}`)
      }
    }
  }
  return rows.sort()
}

const REAL_FILES = sourceFiles().map((rel) => ({
  path: rel,
  text: readFileSync(join(SRC, rel), 'utf8'),
}))
const REAL_FUNCTIONS = providerFunctions(REAL_FILES)

describe('RFC-359 W5 —— 函数体逐字相同的 provider 孪生必须为零', () => {
  test('语料非空：provider 命名的函数确实扫到了（扫成 0 = 判据失效，此刻「零孪生」毫无意义）', () => {
    expect(REAL_FILES.length, 'src 扫成空').toBeGreaterThanOrEqual(500)
    // RFC-359（2026-09-13）：162 → 135。十四对孪生退役，分母跟着小一截；这个数随合一持续下降，
    // 门槛只能往下调，并在这里记一次实测值。
    // RFC-359 AC-12（2026-09-14，plan §5ek）：135 → 116。intent apply 的五个文件随合一改名去掉
    // provider 前缀（`legacy*` 孪生早已随 §5ea 退役），于是它们的函数整批退出本判据的分母。
    // RFC-359 AC-10（2026-09-15）：116 → 115。删掉 `server.ts::composeSqliteProviderAppDeps`
    // ——全仓零引用的同义包装，是「伪装成 provider 对等」的死适配器最后一条。
    // RFC-359 AC-10（2026-09-15，同日第二笔）：115 → 111，一次退四个。
    // `create{Sqlite,Postgresql}RecoveryAdministration` 合成一份中立的
    // `createRecoveryAdministration`，退两个；剩下的
    // `create{Sqlite,Postgresql}TaskExecutionPersistence` 于是函数体逐字相同——正是本判据
    // 要挡的形状，改完第一版当场被它咬住。按它给的处方办：形参放宽到
    // `ProviderNeutralDatabase`、收成一份 `createTaskExecutionPersistence`，十四个调用点
    // 改名，两个带品牌的名字也退出分母。
    expect(
      REAL_FUNCTIONS.length,
      'provider 命名的函数一个都没扫到 ⇒ 命名匹配器塌了',
      // RFC-359 AC-1（2026-09-15，plan §5ft）：111 → 108。工具连接目录那一对合一，四个 provider 命名的函数（store 两个 + catalog 两个）退出分母。
      // RFC-359 AC-1（2026-09-15，plan §5fw）：108 → 107。`webhookRepositoryResolver` 的
      // 品牌名收干净（一份中立实现改叫中立名、别名删除），分母少一个。
      // RFC-359 AC-1（2026-09-15，plan §5fx）：107 → 106。`sqliteWebhookTriggerValidation.ts`
      // 整个删除（只原样转交、不碰数据库的间接层），它那两个 provider 命名的导出退出分母。
      // RFC-359 AC-1（2026-09-15，plan §5fy）：106 → 105。MR 终端控制那一对合一
      // （`taskTermination` 改由装配者提供），`composePostgresqlMrTerminalControl` 退出分母。
      // RFC-359 AC-1（2026-09-16，plan §5fz）：105 → 104。`composePostgresqlEventCenter` 退役
      // ——它与中立那份**函数体逐字节相同**，只差形参上一个更窄的标注。
      // RFC-359 AC-1（2026-09-16，plan §5ga）：104 → 102。又两对「中立名 + 品牌名、体逐字节相同」
      // 退役（`createPostgresqlCollaborationCommandContext` / `createPostgresqlEmployeeReactionRoundQueries`）。
      // RFC-359 AC-1（2026-09-16，plan §5gb）：102 → 99。webhookDispatch 的两对品牌入口合一
      // （触发器服务依赖 + dispatch 持久化），它们的 provider 命名导出退出分母。
      // RFC-359 AC-1（2026-09-16，plan §5gc）：99 → 97。两条 code-host webhook 装配合一
      // （中立那份原本把 `…WithPersistence` 的三行又抄了一遍，PG 那份走的才是那层）。
      // RFC-359 AC-1（2026-09-16，plan §5ge）：97 → 93。agent 启动资源那两层（infrastructure +
      // composition）各自合一，四个 provider 命名的导出退出分母。
      // RFC-359 AC-1（2026-09-16，plan §5gf）：93 → 91。两个**转交式函数别名**退役
      // （`createPostgresqlIdentityAccessRuntime` / `composePostgresqlDigitalEmployee`，
      // 体就是 `return 中立那份(input)`）。
      // RFC-359 AC-1（2026-09-16，plan §5gs）：91 → 90。`composeSqliteWebhookDispatchCore` 改名成中立的
      // `composeWebhookDispatchCore`——它**没有 PostgreSQL 孪生**，形参早就是 `ProviderNeutralDatabase`，
      // 前缀纯属历史（proposal.md AC-1 第三款的「命名债」）。**是改名不是删实现**，分母因此少一。
      // RFC-359 AC-1（2026-09-16，plan §5hi）：90 → 86。数字员工动作执行的三层同文件孪生合齐，
      // 退役四个 provider 命名的导出：`createPostgresqlActionExecutionEnvironment` /
      // `createSqliteActionExecutionEnvironment` / `composePostgresqlAgentActionExecution` /
      // `composePostgresqlScriptActionExecution`。**是合一不是删覆盖**，分母因此少四。
      // RFC-359 AC-1（2026-09-16，plan §5hl）：86 → 85。数字员工执行的两份 composer 合一，
      // 退役 `composePostgresqlDigitalEmployeeExecution`。**是合一不是删覆盖**，分母少一。
      // RFC-359 AC-1（2026-09-16，plan §5hm）：85 → 84。驱动生命周期端口两个引擎合成一份，
      // 退役 `createPostgresqlTaskDriverLifecyclePort`（连同整个 `postgresqlTaskDriverLifecycle.ts`）。
      // **是合一不是删覆盖**，分母少一。
      // RFC-359 AC-1（2026-09-17，plan §5hn 批次二 ①②）：84 → 83。触发器参与者两个引擎合成
      // 一份（`createTaskExecutionTriggerParticipant`），退役
      // `createSqliteTaskExecutionTriggerParticipant`。**是合一不是删覆盖**，分母少一。
      // RFC-359 AC-1（2026-09-17，plan §5hn 批次二 ⑤）：83 → 82。子任务启动两个引擎共用
      // `createChildExecutionLaunchOperations`，退役
      // `createSqliteChildExecutionLaunchOperations`（连同整个 87 行的转发壳文件）。
      // **是合一不是删覆盖**，分母少一。
      // RFC-359 AC-1（命名债收尾 §5hj）：82 → 74。四份 provider 中立的实现去掉 `postgresql`
      // 前缀（`childExecutionLaunchOperations` / `childTaskLifecycleParticipant` /
      // `taskRouteLaunchOperations` / `taskRouteWorkspaceParticipant`），它们导出的 8 个
      // `createPostgresql*` 工厂随之改名，于是离开「provider 命名的函数」这个分母。
      // **是改名不是删覆盖**：函数一个没少，只是不再自称属于某个 provider。
      // 同一波第二批：74 → 73，`taskRouteRepairOperations` 去前缀（同一条判据）。
    ).toBeGreaterThanOrEqual(73)
  })

  test('零孪生：没有任何一对 provider 函数的函数体逐字相同', () => {
    expect(
      identicalTwins(REAL_FUNCTIONS),
      '有一对 provider 命名的函数，函数体**逐字节相同**——那不是两台机器，是同一台机器抄了两遍名字。' +
        '把形参放宽到 `ProviderNeutralDatabase`、收成一份，两个装配根都装它。' +
        '（若函数体相同却确有机制差异，那说明差异根本没写在代码里，更该合。）',
    ).toEqual([])
  })

  test.each([
    // 同一个 base、两侧、函数体逐字相同 ⇒ 必须咬住
    [
      'function composeSqliteFoo(db: A) { return make(db) } function composePostgresqlFoo(db: B) { return make(db) }',
      1,
    ],
    // 空白差异不算差异
    [
      'function composeSqliteFoo(db: A) { return make(db) } function composePostgresqlFoo(db: B) {\n  return make(db)\n}',
      1,
    ],
    // 函数体真的不同 ⇒ 放行（那是「两套实现」，归成对账本管）
    [
      'function composeSqliteFoo(db: A) { return makeOne(db) } function composePostgresqlFoo(db: B) { return makeTwo(db) }',
      0,
    ],
    // 独苗（只有一侧）⇒ 放行
    ['function composeSqliteFoo(db: A) { return make(db) }', 0],
    // base 不同 ⇒ 放行
    [
      'function composeSqliteFoo(db: A) { return make(db) } function composePostgresqlBar(db: B) { return make(db) }',
      0,
    ],
    // 动词不同 ⇒ 不是同一个 base
    [
      'function composeSqliteFoo(db: A) { return make(db) } function createPostgresqlFoo(db: B) { return make(db) }',
      0,
    ],
  ])('自变异 fixture：%s ⇒ %i 对', (text, expected) => {
    expect(identicalTwins(providerFunctions([{ path: 'fixture.ts', text }])).length).toBe(expected)
  })
})
