// RFC-359 W5-T19g —— 「SQLite 迁移跑完后的实际 schema」与「逻辑契约」逐项对账。
//
// 机制：两个 provider 的保护面来源根本不同
// ----------------------------------------
//   - **SQLite** 的表 / 索引 / CHECK / 触发器来自 `db/migrations/*.sql`——一批手写迁移 DDL；
//   - **PostgreSQL** 的表 / 索引 / CHECK 来自 **drizzle 声明**（`db/schema.ts`），经
//     `buildLogicalSchemaContract()` 归一成 provider-中立契约，再由
//     `platform/persistence/postgresqlSchema.ts` 的 `tableStatements` / `indexStatements`
//     逐条生成 DDL。
// 于是有一条**默认成立的漏洞**：写在迁移 SQL 里、却没有同步进 drizzle 声明的那条约束，
// **PostgreSQL 上根本不存在**。而且它不声不响——两个引擎各自的测试都能全绿，差异要等到
// 生产上有脏数据穿过 PG 才现形。这正是 RFC-359 要消灭的形态：一个引擎有保护、另一个没有。
// 本守卫把这条漏洞变成**可清点、只降不升**的量。
//
// 对账口径：按「定义」比，不按「名字」比
// ----------------------------------------
// 同一条保护在两侧的 DDL 形态天然不同：SQLite 的 `col text UNIQUE` 是一条 UNIQUE 约束
// （sqlite_master 里只留一个匿名 autoindex），drizzle 那侧可能写成 `uniqueIndex()`，PG 又投影成
// `ALTER TABLE … ADD CONSTRAINT … UNIQUE`。按名字比会把这类**同一条保护**判成两条差异，
// 账本会被形态噪声灌满。所以两侧都归一成 `<表> :: <定义>`：
//   - 归一规则：去掉反引号 / 双引号、去掉 `表名.` 限定、字符串字面量以外一律大写、压缩空白、
//     剥掉整体多余的外层括号（`((A)OR(B))` ≡ `(A)OR(B)`）；
//   - **部分索引的谓词一并取到并参与比较**（`WHERE …`）。只比索引名会漏掉「两边同名、
//     一边有谓词一边没有」这一整类——本轮实测就抓到 2 条（见 NAME_COLLISION_DEFINITION_DRIFT）。
// 名字仍然保留，用来单独产出第三类差异：**同名但定义不同**。
//
// 三类差异与它们各自的成因
// ------------------------
// ① `SQLITE_ONLY_PROTECTIONS` —— SQLite 有、契约（⇒PG）没有。四种成因 M1–M4，见数组内分段注释。
// ② `CONTRACT_ONLY_PROTECTIONS` —— 契约（⇒PG）有、SQLite 没有。成因 N1–N3，见数组内分段注释。
// ③ `NAME_COLLISION_DEFINITION_DRIFT` —— 两边**同名**、定义不同；这类同时也会各自落进 ① ②。
//
// 收敛记录（RFC-359 W7）
// ----------------------
// 首轮清点：SQLite 专属 **149**（M1 125 CHECK + M2 9 索引 + M3 7 UNIQUE + M4 8 触发器）、
// 契约专属 7、同名漂移 4。W7 之后分别是 **10 / 4 / 2**：
//   - **M1 全清（125 → 0）**：迁移里的列级 / 表级匿名 CHECK 逐条补进 `db/schema.ts`。含计划点名的
//     两条——`repo_group_nodes` 的挂载形状 CHECK（`attachment_kind` 三分支 + 空挂载全零值）与
//     `repository_transport_connections` 的摘要 CHECK
//     （`LENGTH(ENDPOINT_BINDING_DIGEST) = 64 AND … NOT GLOB '*[^0-9a-f]*'`）。
//     口径更正保留：`token_hint` 的长度 CHECK 落在 `user_repository_transport_credentials`
//     （`LENGTH(TOKEN_HINT) = 4`），不在 `repository_transport_connections` 上。
//   - **M2 全清（9 → 0）**、**M3 收敛 5 条（7 → 2）**、**N2 收敛（PG 上两个代数字段能写负数）**、
//     **同名漂移收敛 2 条（4 → 2）**。
//   - SQLITE_ONLY 剩的 10 条 = M4 的 8 个触发器（逻辑契约里没有触发器这个概念，整类补齐属另一套
//     机制）+ 2 条已判定等价的部分唯一索引；CONTRACT_ONLY 剩的 4 条 = N1 的 2 条
//     （`runtime_session_leases.reset_pending`：SQLite 用触发器、PG 用 CHECK，两侧都有保护、
//     只是形态不同）+ 同两条唯一索引的契约侧；同名漂移剩的 2 条也是它们。
//
// **收敛过的每一条唯一性都另有行为验收**：`tests/rfc359-w7-schema-uniqueness-parity.test.ts`
// 用 `describeEachProvider` 往两个真引擎各塞一遍应当冲突的数据，两边都必须拒。对账证明差异
// 消失了，那条测试才证明保护真的生效了。
//
// 账本纪律
// --------
// **只降不升**：把某条差异补进 drizzle 声明（PG 随之投影）后，把对应条目一并删掉，让这次收敛
// 留下一次有署名的提交记录；新增一条而账本没改 ⇒ 红。要新增只能是一次有意识的决定，并在
// 分段注释里写清它为什么只能是 SQLite 专属。
//
// **改 `db/schema.ts` 必须同步重生成 PG 基线**：`bun run db:rfc349-postgresql-schema` 重写
// `db/postgresql-migrations/0000_rfc349_baseline.sql` 与 `meta/_journal.json`；漏了这一步，
// `verifyPostgresqlMigrationHistory` 会让**所有** `describeEachProvider` 的 PG 分支在
// `beforeAll` 就死在 `postgresql-migration-history-drift`。
//
// 这条守卫**不连 PostgreSQL**：契约侧读的是 drizzle 声明（PG DDL 的唯一来源），
// 所以它在纯 SQLite 环境下就能证明「PG 会缺哪些保护」。

import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'

import { migrateSqlite } from '@/platform/persistence/sqliteMigrator'
import { buildLogicalSchemaContract } from '@/platform/persistence/schemaContract'

const MIGRATIONS_FOLDER = resolve(import.meta.dir, '..', '..', 'db', 'migrations')

/** drizzle 的迁移收据表——它不属于业务 schema，逻辑契约里也没有它。 */
const MIGRATION_RECEIPT_TABLE = '__drizzle_migrations'

export interface SchemaProtection {
  readonly table: string
  /** DDL 里给出的名字；匿名 CHECK 与 SQLite 的 UNIQUE 约束没有名字，记 `''`。 */
  readonly name: string
  /** 归一后的定义：`CHECK(…)` / `INDEX(…)` / `UNIQUE(…)` / `TRIGGER <name>`。 */
  readonly def: string
}

export interface Reconciliation {
  readonly sqliteOnly: readonly string[]
  readonly contractOnly: readonly string[]
  readonly nameCollisionDrift: readonly string[]
}

/**
 * 把一段 SQL 归一到「两侧可比」的形态。字符串字面量里的大小写**原样保留**——
 * `'ready'` 与 `'Ready'` 是两个不同的取值，把它们折平会把真差异藏掉。
 */
export function normalizeSqlText(sql: string, table: string): string {
  let out = ''
  let inString = false
  for (const character of sql) {
    if (inString) {
      out += character
      if (character === "'") inString = false
      continue
    }
    if (character === "'") {
      inString = true
      out += character
      continue
    }
    if (character === '`' || character === '"') continue
    out += character.toUpperCase()
  }
  out = out
    .replaceAll(new RegExp(`\\b${table.toUpperCase()}\\.`, 'g'), '')
    .replaceAll(/\s+/g, ' ')
    .replaceAll(/\s*([(),])\s*/g, '$1')
    .trim()
  // `((A)OR(B))` 与 `(A)OR(B)` 是同一条判据——drizzle 声明里常多包一层括号，
  // 不剥掉的话每一条都会被判成「定义不同」。
  while (out.startsWith('(') && out.endsWith(')') && spansWholeExpression(out)) {
    out = out.slice(1, -1).trim()
  }
  return out
}

/** 首个 `(` 是否一直闭合到字符串末尾（是则外层括号是多余的）。 */
function spansWholeExpression(text: string): boolean {
  let depth = 0
  let inString = false
  for (let index = 0; index < text.length; index++) {
    const character = text[index]
    if (inString) {
      if (character === "'") inString = false
      continue
    }
    if (character === "'") inString = true
    else if (character === '(') depth++
    else if (character === ')') {
      depth--
      if (depth === 0) return index === text.length - 1
    }
  }
  return false
}

/** 从 `open` 处的 `(` 找到与之配对的 `)`（跳过字符串字面量里的括号）。 */
function balancedEnd(sql: string, open: number): number {
  let depth = 0
  let inString = false
  for (let index = open; index < sql.length; index++) {
    const character = sql[index]
    if (inString) {
      if (character === "'") inString = false
      continue
    }
    if (character === "'") inString = true
    else if (character === '(') depth++
    else if (character === ')') {
      depth--
      if (depth === 0) return index
    }
  }
  return sql.length
}

interface MasterRow {
  readonly type: string
  readonly name: string
  readonly tbl_name: string
  readonly sql: string | null
}

export function readSqliteMaster(db: Database): MasterRow[] {
  return db
    .query<MasterRow, []>('SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY name')
    .all()
}

/** 迁移跑完后**真实存在**的保护面：显式索引、CHECK（含匿名）、UNIQUE 约束、触发器。 */
export function migratedProtections(
  db: Database,
  master: readonly MasterRow[],
): SchemaProtection[] {
  const out: SchemaProtection[] = []
  for (const row of master) {
    if (row.sql === null) continue // autoindex：没有 DDL 文本，下面走 PRAGMA 取
    if (row.type === 'index') {
      const head =
        /^CREATE\s+(UNIQUE\s+)?INDEX\s+(?:`[^`]+`|"[^"]+"|\w+)\s+ON\s+(?:`[^`]+`|"[^"]+"|\w+)\s*(?=\()/is.exec(
          row.sql,
        )
      if (head === null) throw new Error(`RFC-359 T19g: 解析不了索引 DDL: ${row.sql}`)
      const open = row.sql.indexOf('(', head[0].length - 1)
      const close = balancedEnd(row.sql, open)
      const columns = normalizeSqlText(row.sql.slice(open + 1, close), row.tbl_name)
      const predicate = /^\s*WHERE\s+([\s\S]+)$/i.exec(row.sql.slice(close + 1))
      const where = predicate === null ? '' : normalizeSqlText(predicate[1] ?? '', row.tbl_name)
      out.push({
        table: row.tbl_name,
        name: row.name,
        def: `${head[1] === undefined ? 'INDEX' : 'UNIQUE'}(${columns})${where === '' ? '' : ` WHERE ${where}`}`,
      })
    } else if (row.type === 'table') {
      const pattern = /\bCHECK\s*\(/gi
      let match: RegExpExecArray | null
      while ((match = pattern.exec(row.sql)) !== null) {
        const open = match.index + match[0].length - 1
        const close = balancedEnd(row.sql, open)
        const named = /CONSTRAINT\s+(?:`([^`]+)`|"([^"]+)"|(\w+))\s*$/i.exec(
          row.sql.slice(0, match.index),
        )
        out.push({
          table: row.tbl_name,
          name: named === null ? '' : (named[1] ?? named[2] ?? named[3] ?? ''),
          def: `CHECK(${normalizeSqlText(row.sql.slice(open + 1, close), row.tbl_name)})`,
        })
        pattern.lastIndex = close
      }
    } else if (row.type === 'trigger') {
      out.push({ table: row.tbl_name, name: row.name, def: `TRIGGER ${row.name}` })
    }
  }
  // 表级 / 列级 `UNIQUE(…)` 在 sqlite_master 里只有一个无 DDL 文本的 autoindex，
  // 列名要靠 PRAGMA 取；不取的话「SQLite 有唯一性、契约没有」这一类会整类漏掉。
  for (const table of master
    .filter((row) => row.type === 'table' && !row.name.startsWith('sqlite_'))
    .map((row) => row.name)) {
    for (const index of db
      .query<{ name: string; origin: string }, []>(`PRAGMA index_list(\`${table}\`)`)
      .all()) {
      if (index.origin !== 'u') continue // 'pk' 是主键、'c' 是上面已取过的显式索引
      const columns = db
        .query<{ name: string | null }, []>(`PRAGMA index_info(\`${index.name}\`)`)
        .all()
        .map((column) => (column.name ?? '<expr>').toUpperCase())
        .join(',')
      out.push({ table, name: '', def: `UNIQUE(${columns})` })
    }
  }
  return out
}

/** 逻辑契约声明的保护面——也就是 PostgreSQL 侧**将会**生成的那些约束与索引。 */
export function contractProtections(): SchemaProtection[] {
  const out: SchemaProtection[] = []
  for (const table of buildLogicalSchemaContract().tables) {
    const indexNames = new Set(table.indexes.map((index) => index.name))
    for (const index of table.indexes) {
      const columns = normalizeSqlText(index.columns.join(','), table.id)
      const where = index.where === null ? '' : normalizeSqlText(index.where, table.id)
      out.push({
        table: table.id,
        name: index.name,
        def: `${index.unique ? 'UNIQUE' : 'INDEX'}(${columns})${where === '' ? '' : ` WHERE ${where}`}`,
      })
    }
    // `contract.unique` 里由唯一索引派生的条目已经在上面记过一遍，跳过避免重复计数。
    for (const unique of table.unique) {
      if (indexNames.has(unique.name)) continue
      out.push({
        table: table.id,
        name: unique.name,
        def: `UNIQUE(${unique.columns.map((column) => normalizeSqlText(column, table.id)).join(',')})`,
      })
    }
    for (const column of table.columns) {
      if (column.uniqueName === null) continue
      out.push({
        table: table.id,
        name: column.uniqueName,
        def: `UNIQUE(${column.name.toUpperCase()})`,
      })
    }
    for (const check of table.checks) {
      out.push({
        table: table.id,
        name: check.name,
        def: `CHECK(${normalizeSqlText(check.expression ?? '', table.id)})`,
      })
    }
  }
  return out
}

const KIND_ORDER = ['CHECK', 'INDEX', 'UNIQUE', 'TRIGGER']

function entryOf(protection: SchemaProtection): string {
  return `${protection.table} :: ${protection.def}`
}

function kindRank(entry: string): number {
  const def = entry.split(' :: ')[1] ?? ''
  return KIND_ORDER.findIndex((kind) => def.startsWith(kind))
}

/** 先按种类（CHECK → INDEX → UNIQUE → TRIGGER）再按字面量排；账本按同一顺序书写。 */
export function sortEntries(entries: readonly string[]): string[] {
  return [...entries].sort(
    (left, right) => kindRank(left) - kindRank(right) || left.localeCompare(right),
  )
}

export function reconcile(
  actual: readonly SchemaProtection[],
  expected: readonly SchemaProtection[],
): Reconciliation {
  const actualEntries = new Set(actual.map(entryOf))
  const expectedEntries = new Set(expected.map(entryOf))
  const byName = (protections: readonly SchemaProtection[]): Map<string, SchemaProtection> =>
    new Map(
      protections
        .filter((protection) => protection.name !== '')
        .map((protection) => [`${protection.table}.${protection.name}`, protection]),
    )
  const expectedByName = byName(expected)
  const drift: string[] = []
  for (const [key, protection] of byName(actual)) {
    const counterpart = expectedByName.get(key)
    if (counterpart !== undefined && counterpart.def !== protection.def) {
      drift.push(`${key} :: sqlite=${protection.def} | contract=${counterpart.def}`)
    }
  }
  return {
    sqliteOnly: sortEntries([...actualEntries].filter((entry) => !expectedEntries.has(entry))),
    contractOnly: sortEntries([...expectedEntries].filter((entry) => !actualEntries.has(entry))),
    nameCollisionDrift: drift.sort(),
  }
}

const migrated = new Database(':memory:')
// RFC-115：迁移期 FK 关闭（与 `openDb()` 同口径），否则 12-step rebuild 会级联删子行。
migrated.exec('PRAGMA foreign_keys = OFF;')
migrateSqlite(migrated, { migrationsFolder: MIGRATIONS_FOLDER })

const MASTER = readSqliteMaster(migrated)
const ACTUAL = migratedProtections(migrated, MASTER)
const EXPECTED = contractProtections()
const RECONCILED = reconcile(ACTUAL, EXPECTED)

/**
 * SQLite 有、逻辑契约（⇒PostgreSQL）没有的保护面。条目形如 `<表> :: <归一后的定义>`，
 * 先按种类（CHECK → INDEX → UNIQUE → TRIGGER）再按字面量排序。**只降不升。**
 */
export const SQLITE_ONLY_PROTECTIONS: readonly string[] = [
  // —— M1：迁移 SQL 里写了 CHECK，却没同步进 drizzle 声明，于是 PostgreSQL 上一条都没有 ——
  // **RFC-359 W7 已清空这一段**（原 125 条）。drizzle 的 `getTableConfig().checks` 只看得见 TS 里
  // `check('name', sql…)` 的声明；迁移里的列级 `col text CHECK (…)` 与表级匿名 `CHECK (…)` 全部
  // 落不进契约，于是枚举取值、非负 / 正数计数、`json_valid(…)`、状态机形状这一整类在 PostgreSQL
  // 上一条都不存在。125 条已按迁移 DDL 逐条补进 `db/schema.ts`（含计划点名的两条：
  // `repo_group_nodes` 的挂载形状三分支、`repository_transport_connections` 的 64 位十六进制摘要），
  // PG 基线随之投影。方言不通吃的三类由 `postgresqlSchema.ts` 既有的 `localExpression` 承担，
  // 无需新增翻译层：`NOT GLOB '*[^0-9a-f]*'` → `!~ '[^0-9a-f]'`、boolean 列的 `IN (0,1)` →
  // `IN (FALSE, TRUE)`、`json_valid(…)` 走 `agent_workflow` schema 里的同名 bootstrap 函数。
  // —— M2：迁移 SQL 里手写的索引（含部分索引谓词）而 drizzle 未声明 ——
  // **RFC-359 W7 已清空这一段**：9 条索引（`event_type_catalog` 的可见性索引、`tasks` 的
  // 五条任务树 / 工作组下推索引含一条部分索引、`webhook_deliveries` 的 body 保留期部分索引，
  // 外加 `clarify_rounds` / `code_work_observations` 两条同名漂移）全部补进了 `db/schema.ts`。
  // —— M3：迁移 SQL 里的 UNIQUE 约束 / 唯一索引（含表达式、含部分）而 drizzle 未声明 ——
  // **RFC-359 W7 收敛了 5 条**：三条 `LOWER(…)` 大小写不敏感唯一性（仓库组名 / 组内路径 /
  // 任务空间路径）走 `uniqueIndex().on(sql\`lower(…)\`)`（表达式唯一在 PG 上只能是索引，
  // `ALTER TABLE … ADD CONSTRAINT … UNIQUE` 那条路径只渲染列名）；
  // `workflows :: UNIQUE(NAME) WHERE BUILTIN = 1` 走部分唯一索引；
  // `webhook_mr_launch_guards :: UNIQUE(FIRE_ID)` 走列级 `.unique()`。
  //
  // 剩下这两条**已判定与契约侧等价，刻意不改声明**（同时是 NAME_COLLISION_DEFINITION_DRIFT
  // 的 SQLite 侧）：迁移写的是部分唯一索引 `WHERE <col> IS NOT NULL`，drizzle 写的是全量唯一
  // 索引。判据：两个引擎的唯一索引都把含 NULL 的行视作互不相同——SQLite 一贯如此，PostgreSQL
  // 是 `NULLS DISTINCT` 默认（`CREATE INDEX` 文档；只有显式 `NULLS NOT DISTINCT` 才改变）。
  // 于是谓词排除的正是那批**本来就不参与冲突判定**的行：两种写法强制同一条不变量，
  // 差别只在部分索引不为这些行留索引条目（体积），保护面对等。
  'code_work_observations :: UNIQUE(EVENT_ID) WHERE EVENT_ID IS NOT NULL',
  'intent_turn_events :: UNIQUE(TURN_ID,SOURCE,EXTERNAL_EVENT_ID) WHERE EXTERNAL_EVENT_ID IS NOT NULL',
  // —— M4：触发器——逻辑契约里**没有触发器这个概念**，`postgresqlSchema.ts` 也不产出触发器 ——
  // 所以这 7 个整类只在 SQLite 生效：审计表禁改禁删、承诺态不可变、任务血缘落表、子任务启动来源
  // 继承、运行时会话 `reset_pending` 形状（最后这条在 PG 侧由契约的两条 CHECK 承担，
  // 见 CONTRACT_ONLY_PROTECTIONS 的 N1）。
  //
  // **W6 勘误（2026-09-07 实测推翻下面 W7 裁决的一半）**：原来是 8 条，其中
  // `node_runs :: TRIGGER rfc328_node_runs_lineage_after_insert` 被判成「触发条件在任何生产路径上
  // 都不成立」。**那是错的**——`insert(tasks)` 四个站点确实都显式写了三列，但 `node_runs` 的铸行
  // 工厂对 `lineageSlotPathJson` 的默认值是 `overrides ?? inherited ?? null`，而全 `src` 没有任何
  // 调用点传 `overrides.lineageSlotPathJson`，于是任务的**首个** node_run 一定命中 NULL 分支：
  // SQLite 由触发器补出「任务路径 + 本节点一帧」、PostgreSQL 留 null，下游回落到任务级路径后
  // effect 的 `slot_path_digest` 在节点之间撞车。已按下面「残余风险」段给出的正解收口：
  // 推导搬进 `application/buildNodeRunMintRecord.ts` 的 `nodeRunLineageColumns`（两个引擎共用），
  // 两个铸行适配器显式写这两列，触发器随迁移 0224 退役，并立了守卫
  // `tests/architecture/rfc359-w6-node-run-insert-lineage-completeness.test.ts`。
  // 教训：「AST 清点说插入点都写了」只对**对象字面量**的插入点成立；`.values(变量)` 那种写法
  // 清点不出来，得去看构造那个变量的工厂。
  //
  // **W7 裁决（对剩下 7 条仍然成立）：不补，也不算活着的功能缺口。** 实测（2026-09-07，活库
  // `select … from pg_trigger … where nspname='agent_workflow'` 返回 **0**）确认 PG 侧一个触发器
  // 都没有；但逐条追写入路径后，它们要维持的不变量**应用层已经自己维持了**：
  //   · 血缘两列（`rfc328_*_lineage_after_insert`）与 `trg_tasks_launch_origin_inherit_child`
  //     都是 `WHEN … IS NULL` / `WHEN 父子不一致` 的**兜底填充**，而 AST 清点确认：全仓
  //     **四个** `insert(tasks)` 站点**全部**显式提供 `executionLineageId` /
  //     `lineageSlotPathJson` / `launchOrigin`（`postgresqlFusionEngineTaskOperations.ts:110`、
  //     `postgresqlChildExecutionLaunchOperations.ts:585`、
  //     `postgresqlTaskRouteLaunchOperations.ts:762`、`services/task.ts:3482`）。
  //     也就是说这三个触发器的触发条件在**任何**生产路径上都不成立——它们在 SQLite 上是纯冗余，
  //     PG 缺它们不改变任何行为。（消费侧另有确定性兜底，见
  //     `composition/nodeMechanics.ts:2418-2426`，那是第二道保险，本判断不依赖它。）
  //
  // **残余风险**（记在这里，别当成已消除）：PG 上没有任何兜底，所以将来**新增**一条子任务插入
  // 路径若忘了写血缘 / launchOrigin，SQLite 会被触发器救回来、PG 会静默写错（子任务拿到自己的
  // 血缘 id 而不是父的）。要收口的话，正解不是给 PG 补触发器（那是给同一条不变量做第二份实现，
  // 与本 RFC 的方向相反），而是**加一条守卫钉住「`insert(tasks)` 的每个站点都显式提供这三列」**。
  // 本刀不做。
  'collaboration_gate_operations :: TRIGGER trg_collaboration_gate_operations_committed_immutable',
  'runtime_session_leases :: TRIGGER runtime_session_leases_reset_pending_insert',
  'runtime_session_leases :: TRIGGER runtime_session_leases_reset_pending_update',
  'tasks :: TRIGGER rfc328_tasks_lineage_after_insert',
  'tasks :: TRIGGER trg_tasks_launch_origin_inherit_child',
  'user_access_audit :: TRIGGER user_access_audit_no_delete',
  'user_access_audit :: TRIGGER user_access_audit_no_update',
]

/**
 * 逻辑契约（⇒PostgreSQL）有、迁移后的 SQLite 没有的保护面——方向相反的同一种病。
 */
export const CONTRACT_ONLY_PROTECTIONS: readonly string[] = [
  // —— N1：`runtime_session_leases.reset_pending` 的取值与持有约束 ——
  // 该列是 `0153_runtime_session_reset_fence.sql` 用 `ALTER TABLE … ADD COLUMN` 后加的，
  // SQLite 的 ALTER 加不了 CHECK，于是迁移改用两个 BEFORE INSERT / UPDATE 触发器
  // `RAISE(ABORT, …)` 表达同一条不变量（见 SQLITE_ONLY_PROTECTIONS M4）。两侧都有保护，形态不同。
  // —— N2：`task_execution_lineage_operation_records` 的记录形状 CHECK ——
  // **RFC-359 W7 已收敛**：迁移那份多了 `HIGHEST_SETTLED_GENERATION >= 0` 与
  // `OPERATION_GENERATION >= 0` 两个合取项（SQLite 比 PG 更严，PG 上这两个代数字段能写负数），
  // 两项已补进 drizzle 声明，两侧同形。
  'runtime_session_leases :: CHECK(RESET_PENDING = 0 OR LEASE_NODE_RUN_ID IS NOT NULL)',
  'runtime_session_leases :: CHECK(RESET_PENDING IN(0,1))',
  // —— N3：同名唯一索引定义漂移的契约侧（与 NAME_COLLISION_DEFINITION_DRIFT 一一对应） ——
  // 两条索引漂移（`idx_clarify_rounds_target_consumer` 列集不同、
  // `idx_code_work_observations_item` 少 `DESC`）已由 W7 对齐到迁移；剩下这两条唯一索引
  // 是**已判定等价**的部分 vs 全量之差，判据见 SQLITE_ONLY_PROTECTIONS 的 M3 段。
  'code_work_observations :: UNIQUE(EVENT_ID)',
  'intent_turn_events :: UNIQUE(TURN_ID,SOURCE,EXTERNAL_EVENT_ID)',
]

/**
 * 两侧**同名**、定义不同。这一类最容易漏：名字对得上，列集 / 排序 / 部分索引谓词却不一样，
 * 于是两个引擎上「同一个索引」保护的根本不是同一件事。原有四条，RFC-359 W7 逐条判定后：
 *   - `idx_clarify_rounds_target_consumer`：**真差异，已修**。列集完全不同——迁移 0107
 *     （RFC-217 T17）重建 clarify_rounds 时把它换成了 `(target_consumer_node_id, loop_iter,
 *     iteration)`，drizzle 声明却停在 0031（RFC-058）的 `(target_consumer_node_id, status)`。
 *     PostgreSQL 投影出来的是那个**已被取代**的形状。声明已对齐到迁移（= 生产真值）。
 *   - `idx_code_work_observations_item`：**已对齐**。迁移带 `created_at DESC`，声明少了排序
 *     方向；drizzle 的 SQLite 索引列没有 `.desc()`，改用 `sql\`${…} DESC\`` 写出同一形状。
 *   - `uniq_code_work_observations_event` / `uniq_intent_turn_events_external`：**已判定等价，
 *     刻意保留**。迁移是部分唯一索引（`WHERE … IS NOT NULL`），声明是全量唯一索引；两个引擎
 *     的唯一索引都把含 NULL 的行视作互不相同（PostgreSQL 的 `NULLS DISTINCT` 默认），
 *     谓词排除的正是那批本来就不参与冲突判定的行。判据详见 SQLITE_ONLY_PROTECTIONS 的 M3 段。
 */
export const NAME_COLLISION_DEFINITION_DRIFT: readonly string[] = [
  'code_work_observations.uniq_code_work_observations_event :: sqlite=UNIQUE(EVENT_ID) WHERE EVENT_ID IS NOT NULL | contract=UNIQUE(EVENT_ID)',
  'intent_turn_events.uniq_intent_turn_events_external :: sqlite=UNIQUE(TURN_ID,SOURCE,EXTERNAL_EVENT_ID) WHERE EXTERNAL_EVENT_ID IS NOT NULL | contract=UNIQUE(TURN_ID,SOURCE,EXTERNAL_EVENT_ID)',
]

describe('RFC-359 W5-T19g —— 迁移后的实际 schema 与逻辑契约逐项对账', () => {
  test('语料下限：迁移确实跑完了，两侧都读到了成规模的对象（扫空 / 取空 = 假绿）', () => {
    // 这条守卫的绿有两种来源，断言层面同形：真的没有新差异，或者「库是空的 / 契约是空的」。
    // 下面四个下限专治后者——把迁移目录写错、把 sqlite_master 查询打错、契约构造失败，
    // 三种都会在这里当场转红，而不是让下面的逐字相等在空集上照绿。
    expect(MASTER.filter((row) => row.type === 'table').length).toBeGreaterThanOrEqual(180)
    expect(
      MASTER.filter((row) => row.type === 'index' && row.sql !== null).length,
    ).toBeGreaterThanOrEqual(340)
    expect(MASTER.filter((row) => row.type === 'trigger').length).toBeGreaterThanOrEqual(7)
    expect(ACTUAL.length).toBeGreaterThanOrEqual(500)
    expect(EXPECTED.length).toBeGreaterThanOrEqual(390)
    expect(
      ACTUAL.filter((protection) => protection.def.startsWith('CHECK(')).length,
    ).toBeGreaterThanOrEqual(170)
  })

  test('物理表集合与契约表集合一致（多出的表只允许是 drizzle 的迁移收据表）', () => {
    const physical = MASTER.filter(
      (row) => row.type === 'table' && !row.name.startsWith('sqlite_'),
    ).map((row) => row.name)
    const declared = new Set(buildLogicalSchemaContract().tables.map((table) => table.id))
    expect(
      physical.filter((name) => !declared.has(name)).sort(),
      '迁移建了一张逻辑契约不认识的表——它在 PostgreSQL 上不会被创建，也不会被迁移搬运',
    ).toEqual([MIGRATION_RECEIPT_TABLE])
    expect(
      [...declared].filter((name) => !physical.includes(name)).sort(),
      '契约声明了一张迁移没有建的表',
    ).toEqual([])
  })

  test('SQLite 专属保护面与账本逐字相等（增了 = 新开了一条 PG 没有的保护，减了 = 收敛）', () => {
    expect(
      RECONCILED.sqliteOnly,
      '迁移 SQL 里的索引 / CHECK / UNIQUE / 触发器与 drizzle 声明对不上。' +
        '**增**了说明有人只在迁移里加了保护——PostgreSQL 的 DDL 来自 drizzle 声明而不是迁移 SQL，' +
        '这条保护在 PG 上根本不存在。要么把它补进 `db/schema.ts`（PG 随之投影），' +
        '要么把它写进本账本并在分段注释里说明为什么只能是 SQLite 专属。' +
        '**减**了说明收敛发生了——把账本一起改小，让这次减少留下一次有署名的提交记录。',
    ).toEqual([...SQLITE_ONLY_PROTECTIONS])
  })

  test('契约专属保护面与账本逐字相等（PG 有、SQLite 没有的那一侧同样要盯）', () => {
    expect(
      RECONCILED.contractOnly,
      '契约（⇒PostgreSQL）声明了一条迁移后的 SQLite 没有的约束 / 索引。' +
        '同样是「一个引擎有保护、另一个没有」，只是方向相反：要么补一条迁移，' +
        '要么写进本账本并说明为什么两侧只能不对称。',
    ).toEqual([...CONTRACT_ONLY_PROTECTIONS])
  })

  test('同名但定义不同的对象与账本逐字相等（部分索引谓词差异专治此项）', () => {
    expect(
      RECONCILED.nameCollisionDrift,
      '两侧有同名对象但定义不同——这是最容易漏的一类：名字对得上，' +
        '列集 / 排序 / **部分索引谓词**却不一样，于是两个引擎上「同一个索引」保护的根本不是同一件事。',
    ).toEqual([...NAME_COLLISION_DEFINITION_DRIFT])
  })

  test('账本自身有序、无重复（清点稳定的前提）', () => {
    for (const [label, ledger] of [
      ['SQLITE_ONLY_PROTECTIONS', SQLITE_ONLY_PROTECTIONS],
      ['CONTRACT_ONLY_PROTECTIONS', CONTRACT_ONLY_PROTECTIONS],
    ] as const) {
      expect(new Set(ledger).size, `${label} 里有重复条目`).toBe(ledger.length)
      expect(sortEntries(ledger), `${label} 没有按 种类 → 字面量 排序`).toEqual([...ledger])
    }
    expect(new Set(NAME_COLLISION_DEFINITION_DRIFT).size).toBe(
      NAME_COLLISION_DEFINITION_DRIFT.length,
    )
    expect([...NAME_COLLISION_DEFINITION_DRIFT].sort()).toEqual([
      ...NAME_COLLISION_DEFINITION_DRIFT,
    ])
  })
})

// ---------------------------------------------------------------------------
// 判据自证：伪造的输入喂给**上面用的同一份判据**，确认它还咬得动
// ---------------------------------------------------------------------------
//
// 上面每条逐字相等都建立在 `normalizeSqlText` / `migratedProtections` / `reconcile` 之上。
// 这三者一旦悄悄失效（正则改窄、谓词没取到、比较键退化成只比名字），差异集合会安静地变空，
// 而「与账本相等」依然成立——账本本来就长这样。所以要有一组伪造输入证明它们还在工作。
describe('RFC-359 W5-T19g —— 对账判据自证', () => {
  test('归一：去引号 / 去表名限定 / 关键字大写 / 剥多余外层括号，但字符串字面量原样保留', () => {
    expect(normalizeSqlText('"t"."a" is not null', 't')).toBe('A IS NOT NULL')
    expect(normalizeSqlText("`state` in ( 'Ready' , 'busy' )", 't')).toBe(
      "STATE IN('Ready','busy')",
    )
    expect(normalizeSqlText('((`a` = 1) OR (`b` = 2))', 't')).toBe('(A = 1)OR(B = 2)')
    // 不是整体外层括号时不能剥——剥了会把 `(A)OR(B)` 变成 `A)OR(B`
    expect(normalizeSqlText('(`a` = 1) OR (`b` = 2)', 't')).toBe('(A = 1)OR(B = 2)')
  })

  test('部分索引谓词参与比较：只差一个 WHERE 也必须被判成差异', () => {
    const withPredicate: SchemaProtection = {
      table: 'fake_table',
      name: 'fake_idx',
      def: 'UNIQUE(FAKE_COL) WHERE FAKE_COL IS NOT NULL',
    }
    const withoutPredicate: SchemaProtection = {
      table: 'fake_table',
      name: 'fake_idx',
      def: 'UNIQUE(FAKE_COL)',
    }
    const result = reconcile([withPredicate], [withoutPredicate])
    expect(result.sqliteOnly).toEqual(['fake_table :: UNIQUE(FAKE_COL) WHERE FAKE_COL IS NOT NULL'])
    expect(result.contractOnly).toEqual(['fake_table :: UNIQUE(FAKE_COL)'])
    expect(result.nameCollisionDrift).toEqual([
      'fake_table.fake_idx :: sqlite=UNIQUE(FAKE_COL) WHERE FAKE_COL IS NOT NULL | contract=UNIQUE(FAKE_COL)',
    ])
  })

  test('两侧完全一致时三个桶都空（否则判据自己在制造假差异）', () => {
    const same: SchemaProtection[] = [
      { table: 'fake_table', name: '', def: 'CHECK(FAKE_COL > 0)' },
      { table: 'fake_table', name: 'fake_idx', def: 'INDEX(FAKE_COL)' },
    ]
    expect(reconcile(same, same)).toEqual({
      sqliteOnly: [],
      contractOnly: [],
      nameCollisionDrift: [],
    })
  })

  test('匿名 CHECK 与触发器都能从迁移后的 DDL 里读出来（漏掉任一类都会整类静默豁免）', () => {
    const fake = new Database(':memory:')
    fake.exec(
      "CREATE TABLE fake_rows (id text PRIMARY KEY, state text NOT NULL CHECK (state IN ('a','b')), tag text UNIQUE);",
    )
    fake.exec(
      "CREATE TRIGGER fake_rows_no_delete BEFORE DELETE ON fake_rows BEGIN SELECT RAISE(ABORT, 'nope'); END;",
    )
    fake.exec('CREATE UNIQUE INDEX fake_rows_live ON fake_rows (state) WHERE tag IS NOT NULL;')
    const found = migratedProtections(fake, readSqliteMaster(fake))
      .map((protection) => `${protection.table} :: ${protection.def}`)
      .sort()
    fake.close()
    expect(found).toEqual([
      "fake_rows :: CHECK(STATE IN('a','b'))",
      'fake_rows :: TRIGGER fake_rows_no_delete',
      'fake_rows :: UNIQUE(STATE) WHERE TAG IS NOT NULL',
      'fake_rows :: UNIQUE(TAG)',
    ])
  })
})
