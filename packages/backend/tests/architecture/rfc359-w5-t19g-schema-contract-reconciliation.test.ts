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
// 计划点名的两条已知差异，实测确认并登记在册（都属 M1）：
//   - `repo_group_nodes` 的挂载形状 CHECK（`attachment_kind` 三分支 + 空挂载全零值）；
//   - `repository_transport_connections` 的摘要 CHECK
//     （`LENGTH(ENDPOINT_BINDING_DIGEST) = 64 AND … NOT GLOB '*[^0-9a-f]*'`）。
//     顺带更正一处口径：`token_hint` 的长度 CHECK 实际落在
//     `user_repository_transport_credentials`（`LENGTH(TOKEN_HINT) = 4`），
//     不在 `repository_transport_connections` 上——后者的 `global_token_hint` 没有 CHECK。
//
// 账本纪律
// --------
// **只降不升**：把某条差异补进 drizzle 声明（PG 随之投影）后，把对应条目一并删掉，让这次收敛
// 留下一次有署名的提交记录；新增一条而账本没改 ⇒ 红。要新增只能是一次有意识的决定，并在
// 分段注释里写清它为什么只能是 SQLite 专属。**本刀不改生产代码**：哪些该补进 drizzle 声明、
// 哪些该长期登记为 SQLite 专属，由 RFC-359 主线裁决。
//
// 这条守卫**不连 PostgreSQL**：契约侧读的是 drizzle 声明（PG DDL 的唯一来源），
// 所以它在纯 SQLite 环境下就能证明「PG 会缺哪些保护」。

import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'

import { migrateSqlite } from '@/db/sqliteMigrator'
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
  // drizzle 的 `getTableConfig().checks` 只看得见 TS 里 `check('name', sql…)` 的声明；迁移里的
  // 列级 `col text CHECK (…)` 与表级匿名 `CHECK (…)` 全部落不进契约。下面 125 条里只有
  // `auth_login_policy :: CHECK(ID = 'global')` 在迁移里是有名字的（`CONSTRAINT
  // auth_login_policy_global_only`），其余全是匿名的。内容以枚举取值（`IN (…)`）、非负 / 正数
  // 计数、`json_valid(…)`、状态机形状为主——每一条在 PostgreSQL 上都缺席。
  // 计划点名的两条已知差异也在这一段：`repo_group_nodes` 的挂载形状 CHECK（三分支 +
  // 空挂载全零值）、`repository_transport_connections` 的摘要 CHECK（64 位十六进制）。
  "auth_login_policy :: CHECK(ID = 'global')",
  "auth_login_policy :: CHECK(OIDC_DEFAULT_ROLE IN('guest','user'))",
  "capability_templates :: CHECK(VISIBILITY IN('public','private'))",
  "clarify_rounds :: CHECK((KIND = 'self' AND STATUS != 'abandoned')OR(KIND = 'cross' AND STATUS != 'canceled'))",
  "clarify_rounds :: CHECK(DIRECTIVE IS NULL OR DIRECTIVE IN('continue','stop'))",
  "clarify_rounds :: CHECK(KIND IN('self','cross'))",
  "clarify_rounds :: CHECK(STATUS IN('awaiting_human','answered','canceled','abandoned'))",
  'code_ai_attempts :: CHECK(ATTEMPT_SEQ >= 0)',
  'code_ai_attempts :: CHECK(RERUN_SEQ >= 0)',
  "code_ai_attempts :: CHECK(STATUS IN('claimed','running','validated','failed','interrupted'))",
  "code_findings :: CHECK(ANCHOR_KIND IN('mr','issue','pipeline','platform'))",
  "code_findings :: CHECK(LIFECYCLE IN('active','disappeared','reappeared'))",
  'code_host_connections :: CHECK(JSON_VALID(REPOSITORY_URL_PREFIXES_JSON))',
  'code_host_connections :: CHECK(JSON_VALID(TRANSPORT_MAPPINGS_JSON))',
  'code_host_connections :: CHECK(LENGTH(CONNECTION_GENERATION)BETWEEN 1 AND 128)',
  "code_host_connections :: CHECK(PROVIDER IN('gitlab','github'))",
  'code_host_connections :: CHECK(REJECT_UNAUTHORIZED IN(0,1))',
  'code_publish_intents :: CHECK(EPOCH >= 1)',
  "code_publish_intents :: CHECK(STATE IN('pending','settled','compensated','abandoned'))",
  "code_round_stages :: CHECK(STAGE_KIND IN('program','script','ai','invoke'))",
  'code_round_stages :: CHECK(STAGE_SEQ >= 0)',
  "code_round_stages :: CHECK(STATUS IN('pending','running','done','failed','skipped','inherited'))",
  "code_work_items :: CHECK(ANCHOR_KIND IN('mr','issue','pipeline','platform'))",
  'code_work_items :: CHECK(EPOCH >= 1)',
  'code_work_items :: CHECK(PUBLISHING_EPOCH IS NULL OR PUBLISHING_EPOCH >= 1)',
  "code_work_items :: CHECK(STATUS IN('idle','queued','running','awaiting','settled','failed','superseding','handed_off','closing','closed'))",
  'code_work_rounds :: CHECK(EPOCH >= 1)',
  "code_work_rounds :: CHECK(OUTCOME IS NULL OR OUTCOME IN('published','awaiting','failed','canceled','superseded'))",
  'code_work_rounds :: CHECK(ROUND_SEQ >= 1)',
  "collaboration_gate_artifacts :: CHECK(ARTIFACT_KIND = 'review-doc')",
  "collaboration_gate_artifacts :: CHECK(STATE IN('declared','staged','consumed','finalized','cleanup_pending'))",
  "collaboration_gate_operations :: CHECK(GATE_KIND IN('review','clarify','questions'))",
  "collaboration_gate_operations :: CHECK(OPERATION_KIND IN('open','decide','manual-question-open','legacy-seed'))",
  "collaboration_gate_operations :: CHECK(STATE IN('preparing','prepared','committed','cleanup_pending','completed','failed'))",
  "employee_case_members :: CHECK(ROLE IN('collaborator','observer'))",
  "fusions :: CHECK(STATUS IN('running','awaiting_approval','applying','done','rejected','canceled','failed'))",
  "intent_draft_resolutions :: CHECK(REASON IN('superseded','discarded'))",
  "intent_working_set_changes :: CHECK(MODE IN('after-current','interrupt'))",
  "intent_working_set_changes :: CHECK(STATE IN('queued','applying','applied','failed','canceled'))",
  "maintenance_runs :: CHECK((STATE = 'running' AND LEASE_TOKEN IS NOT NULL AND LEASE_EXPIRES_AT IS NOT NULL)OR(STATE <> 'running'))",
  'maintenance_runs :: CHECK(ATTEMPT >= 0)',
  'maintenance_runs :: CHECK(CURSOR_JSON IS NULL OR JSON_VALID(CURSOR_JSON))',
  'maintenance_runs :: CHECK(CURSOR_VERSION > 0)',
  "maintenance_runs :: CHECK(JOB_CLASS IN('cleanup','recovery','checkpoint'))",
  'maintenance_runs :: CHECK(JSON_VALID(COUNTERS_JSON))',
  'maintenance_runs :: CHECK(JSON_VALID(PAYLOAD_JSON))',
  'maintenance_runs :: CHECK(SLICE_NO >= 0)',
  "maintenance_runs :: CHECK(STATE IN('pending','running','deferred','succeeded','failed'))",
  "memories :: CHECK((SCOPE_TYPE = 'global' AND SCOPE_ID IS NULL)OR(SCOPE_TYPE != 'global' AND SCOPE_ID IS NOT NULL))",
  "memories :: CHECK((STATUS = 'fused')=(FUSED_INTO_SKILL IS NOT NULL))",
  "memories :: CHECK((STATUS = 'fused')=(FUSED_INTO_SKILL_ID IS NOT NULL))",
  "memories :: CHECK(DISTILL_ACTION IS NULL OR DISTILL_ACTION IN('new','update_of','duplicate_of','conflict_with'))",
  "memories :: CHECK(SCOPE_TYPE IN('agent','workflow','repo','repo_group','global'))",
  "memories :: CHECK(SOURCE_KIND IN('clarify','review','feedback','manual'))",
  "memories :: CHECK(STATUS IN('candidate','approved','archived','superseded','rejected','fused'))",
  "memory_distill_jobs :: CHECK(SOURCE_KIND IN('clarify','review','feedback'))",
  "memory_distill_jobs :: CHECK(STATUS IN('pending','running','done','failed','canceled'))",
  'repo_capability_config :: CHECK(ENABLED IN(0,1))',
  "repo_capability_config :: CHECK(READINESS IN('disabled','misconfigured','ready'))",
  "repo_group_nodes :: CHECK((ATTACHMENT_KIND IS NULL AND CACHED_REPO_ID IS NULL AND CHILD_GROUP_ID IS NULL AND REF = '' AND SUBDIR = '' AND READONLY = 0)OR(ATTACHMENT_KIND = 'repo' AND CACHED_REPO_ID IS NOT NULL AND CHILD_GROUP_ID IS NULL)OR(ATTACHMENT_KIND = 'group' AND CHILD_GROUP_ID IS NOT NULL AND CACHED_REPO_ID IS NULL AND REF = '' AND SUBDIR = ''))",
  "repo_group_nodes :: CHECK(ATTACHMENT_KIND IS NULL OR ATTACHMENT_KIND IN('repo','group'))",
  'repository_transport_connections :: CHECK(CREDENTIAL_REVISION > 0)',
  'repository_transport_connections :: CHECK(JSON_VALID(ALLOWED_HTTP_BASE_URLS_JSON))',
  'repository_transport_connections :: CHECK(JSON_VALID(TRANSPORT_MAPPINGS_JSON))',
  "repository_transport_connections :: CHECK(LENGTH(ENDPOINT_BINDING_DIGEST)= 64 AND ENDPOINT_BINDING_DIGEST NOT GLOB '*[^0-9a-f]*')",
  "repository_transport_connections :: CHECK(PROVIDER IN('gitlab','github'))",
  'repository_transport_connections :: CHECK(REJECT_UNAUTHORIZED IN(0,1))',
  "resource_grants :: CHECK(LEVEL IN('read','write'))",
  'skill_operations :: CHECK(ACTIVE IN(0,1))',
  "skill_operations :: CHECK(KIND IN('reserve','migrate','delete','version-write'))",
  "task_execution_effect_attempts :: CHECK(APPLICATION_EVIDENCE IS NULL OR APPLICATION_EVIDENCE IN('applied','definitely-not-applied','ambiguous'))",
  'task_execution_effect_attempts :: CHECK(RECEIPT_JSON IS NULL OR JSON_VALID(RECEIPT_JSON))',
  'task_execution_effect_attempts :: CHECK(RECOVERY_DESCRIPTOR_JSON IS NULL OR JSON_VALID(RECOVERY_DESCRIPTOR_JSON))',
  "task_execution_effect_attempts :: CHECK(RETRY_AUTHORITY IN('none','probe','convergent','transport-policy'))",
  "task_execution_effect_attempts :: CHECK(STATE IN('prepared','acting','succeeded','failed-not-applied','retry-authorized','recovery-required','outcome-unknown'))",
  'task_execution_effects :: CHECK(JSON_VALID(SLOT_PATH_JSON))',
  "task_execution_effects :: CHECK(KIND IN('workspace-prepare','workspace-rollback','isolation-create','isolation-merge','repository','process','workspace-cleanup','code-host-mutation','outbound-mutation'))",
  'task_execution_effects :: CHECK(LAST_ATTEMPT_NO >= 0)',
  'task_execution_effects :: CHECK(RECEIPT_JSON IS NULL OR JSON_VALID(RECEIPT_JSON))',
  "task_execution_effects :: CHECK(STATE IN('open','succeeded','failed','outcome-unknown'))",
  'task_execution_intents :: CHECK(AUTHORIZATION_SCOPE_JSON IS NULL OR JSON_VALID(AUTHORIZATION_SCOPE_JSON))',
  'task_execution_intents :: CHECK(CLAIMED_EPOCH IS NULL OR CLAIMED_EPOCH > 0)',
  'task_execution_intents :: CHECK(JSON_VALID(PAYLOAD_JSON))',
  'task_execution_intents :: CHECK(JSON_VALID(SLOT_PATH_JSON))',
  "task_execution_intents :: CHECK(KIND IN('launch','resume','retry-repository-preparation','retry-node','sync-workflow','gate-continuation','recovery'))",
  "task_execution_intents :: CHECK(SOURCE IN('rest','mcp','scheduler','auto','boot','internal'))",
  "task_execution_intents :: CHECK(STATE IN('pending','claimed','completed','canceled','failed'))",
  "task_execution_lineage_operation_records :: CHECK((RECORD_KIND = 'generation-watermark' AND HIGHEST_SETTLED_GENERATION IS NOT NULL AND HIGHEST_SETTLED_GENERATION >= 0 AND OPERATION_GENERATION IS NULL AND DECISION_STATE IS NULL)OR(RECORD_KIND = 'replay-decision' AND OPERATION_GENERATION IS NOT NULL AND OPERATION_GENERATION >= 0 AND HIGHEST_SETTLED_GENERATION IS NULL AND DECISION_STATE IS NOT NULL))",
  'task_execution_lineage_operation_records :: CHECK(AUTHORIZATION_SCOPE_JSON IS NULL OR JSON_VALID(AUTHORIZATION_SCOPE_JSON))',
  'task_execution_lineage_operation_records :: CHECK(COMPACTED IN(0,1))',
  "task_execution_lineage_operation_records :: CHECK(DECISION_STATE IS NULL OR DECISION_STATE IN('requires-actor','actor-replay-authorized','actor-replay-authorized-suspended','consumed'))",
  'task_execution_lineage_operation_records :: CHECK(JSON_VALID(SLOT_PATH_JSON))',
  'task_execution_lineage_operation_records :: CHECK(PROVIDER_COORDINATE_JSON IS NULL OR JSON_VALID(PROVIDER_COORDINATE_JSON))',
  "task_execution_lineage_operation_records :: CHECK(RECORD_KIND IN('generation-watermark','replay-decision'))",
  'task_execution_maintenance_claims :: CHECK(JSON_VALID(CLEANUP_PLAN_JSON))',
  "task_execution_maintenance_claims :: CHECK(OPERATION IN('archive','delete','retention','workspace-gc','repair-metadata'))",
  "task_execution_maintenance_claims :: CHECK(STATE IN('claimed','io-complete','db-finalized','cleanup-pending','completed','recovery-required'))",
  "task_execution_owners :: CHECK(STATE IN('claimed','revoked','released','recovery-required'))",
  "tasks :: CHECK(LAUNCH_ORIGIN IN('manual','scheduled','webhook','api','event'))",
  'tasks :: CHECK(SOURCE_TERMINATION_EFFECT_REV IS NULL OR SOURCE_TERMINATION_EFFECT_REV >= 1)',
  "tasks :: CHECK(SOURCE_TERMINATION_FENCE IS NULL OR SOURCE_TERMINATION_FENCE IN('closed','merged'))",
  'tasks :: CHECK(SOURCE_TERMINATION_LAUNCH_REV IS NULL OR SOURCE_TERMINATION_LAUNCH_REV >= 0)',
  "tasks :: CHECK(WORKSPACE_PRUNE_CAUSE IS NULL OR(WORKSPACE_PRUNE_CAUSE = 'webhook-terminal' AND WORKSPACE_PRUNING_AT IS NOT NULL))",
  'user_repository_transport_credentials :: CHECK(CREDENTIAL_REVISION > 0)',
  'user_repository_transport_credentials :: CHECK(LENGTH(CONNECTION_GENERATION)BETWEEN 1 AND 128)',
  "user_repository_transport_credentials :: CHECK(LENGTH(ENDPOINT_BINDING_DIGEST)= 64 AND ENDPOINT_BINDING_DIGEST NOT GLOB '*[^0-9a-f]*')",
  'user_repository_transport_credentials :: CHECK(LENGTH(TOKEN_HINT)= 4)',
  "user_repository_transport_credentials :: CHECK(PROVIDER IN('gitlab','github'))",
  "webhook_deliveries :: CHECK(MR_STATE_AFTER IS NULL OR MR_STATE_AFTER IN('open','closed','merged'))",
  'webhook_deliveries :: CHECK(MR_STREAM_REVISION IS NULL OR MR_STREAM_REVISION >= 1)',
  'webhook_mr_control_effects :: CHECK(ATTEMPT_COUNT >= 0)',
  "webhook_mr_control_effects :: CHECK(KIND IN('fence-closed','fence-merged','clear-closed'))",
  "webhook_mr_control_effects :: CHECK(OBSERVED_EVENT_TYPE IN('mr_opened','mr_closed','mr_merged'))",
  'webhook_mr_control_effects :: CHECK(REVISION >= 1)',
  "webhook_mr_control_effects :: CHECK(STATUS IN('pending','leased','waiting-launches','retryable','succeeded'))",
  "webhook_mr_control_targets :: CHECK(CANCEL_OUTCOME IN('canceled','already-terminal','not-applicable'))",
  "webhook_mr_control_targets :: CHECK(FENCE_OUTCOME IN('fenced-closed','fenced-merged','cleared-closed','unchanged'))",
  "webhook_mr_control_targets :: CHECK(RELEASE_OUTCOME IN('pending','no-active-owner','released','unreaped'))",
  'webhook_mr_launch_guards :: CHECK(LAUNCH_REVISION >= 0)',
  "webhook_mr_launch_guards :: CHECK(STATUS IN('reserved','launching','revoking-terminal','task-committed','launch-settled','aborted-terminal','failed'))",
  'webhook_mr_stream_states :: CHECK(LAST_TERMINAL_REVISION IS NULL OR LAST_TERMINAL_REVISION >= 1)',
  'webhook_mr_stream_states :: CHECK(REVISION >= 1)',
  "webhook_mr_stream_states :: CHECK(STATE IN('open','closed','merged'))",
  'webhook_triggers :: CHECK(CANCEL_ON_MR_TERMINAL IN(0,1))',
  "workgroups :: CHECK(OUTPUT_CONTRACT IN('files','discussion'))",
  // —— M2：迁移 SQL 里手写的索引（含部分索引谓词）而 drizzle 未声明 ——
  // 头两条同时是 NAME_COLLISION_DEFINITION_DRIFT 的 SQLite 侧（同名、定义不同）。
  // `tasks` 那五条是任务树 / 工作组查询的下推索引；`tasks :: INDEX(ID) WHERE ROOT_TASK_ID
  // IS NULL` 与 `webhook_deliveries` 那条是**部分索引**——PG 上这些查询没有索引可用。
  'clarify_rounds :: INDEX(TARGET_CONSUMER_NODE_ID,LOOP_ITER,ITERATION)',
  'code_work_observations :: INDEX(WORK_ITEM_ID,CREATED_AT DESC)',
  'event_type_catalog :: INDEX(CATALOG_VISIBILITY,EVENT_TYPE_ID,REVISION)',
  'tasks :: INDEX(ID) WHERE ROOT_TASK_ID IS NULL',
  'tasks :: INDEX(ROOT_TASK_ID,STARTED_AT)',
  'tasks :: INDEX(STATUS,PARENT_TASK_ID,FINISHED_AT)',
  'tasks :: INDEX(STATUS,WORKGROUP_ID)',
  'tasks :: INDEX(WORKGROUP_ID)',
  'webhook_deliveries :: INDEX(RECEIVED_AT) WHERE BODY_JSON IS NOT NULL',
  // —— M3：迁移 SQL 里的 UNIQUE 约束 / 唯一索引（含表达式、含部分）而 drizzle 未声明 ——
  // 三条 `LOWER(…)` 是大小写不敏感唯一性（仓库组名 / 组内路径 / 任务空间路径），PG 上完全没有
  // 对应保护；`workflows :: UNIQUE(NAME) WHERE BUILTIN = 1` 是内建工作流重名闸；
  // `webhook_mr_launch_guards :: UNIQUE(FIRE_ID)` 是迁移里的列级 `UNIQUE`。
  // 另两条（`code_work_observations` / `intent_turn_events`）是同名定义漂移的 SQLite 侧。
  'code_work_observations :: UNIQUE(EVENT_ID) WHERE EVENT_ID IS NOT NULL',
  'intent_turn_events :: UNIQUE(TURN_ID,SOURCE,EXTERNAL_EVENT_ID) WHERE EXTERNAL_EVENT_ID IS NOT NULL',
  'repo_group_nodes :: UNIQUE(GROUP_ID,LOWER(PATH))',
  'repo_groups :: UNIQUE(LOWER(NAME))',
  'task_space_nodes :: UNIQUE(TASK_ID,LOWER(NODE_PATH))',
  'webhook_mr_launch_guards :: UNIQUE(FIRE_ID)',
  'workflows :: UNIQUE(NAME) WHERE BUILTIN = 1',
  // —— M4：触发器——逻辑契约里**没有触发器这个概念**，`postgresqlSchema.ts` 也不产出触发器 ——
  // 所以这 8 个整类只在 SQLite 生效：审计表禁改禁删、承诺态不可变、血缘落表、子任务启动来源
  // 继承、运行时会话 `reset_pending` 形状（最后这条在 PG 侧由契约的两条 CHECK 承担，
  // 见 CONTRACT_ONLY_PROTECTIONS 的 N1）。整类补齐属于生产改动，由 RFC-359 主线裁决。
  'collaboration_gate_operations :: TRIGGER trg_collaboration_gate_operations_committed_immutable',
  'node_runs :: TRIGGER rfc328_node_runs_lineage_after_insert',
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
  // 迁移那份多了 `HIGHEST_SETTLED_GENERATION >= 0` 与 `OPERATION_GENERATION >= 0` 两个合取项，
  // 即 **SQLite 比 PG 更严**；drizzle 声明缺这两项，PG 上这两个字段可以写成负数。
  'runtime_session_leases :: CHECK(RESET_PENDING = 0 OR LEASE_NODE_RUN_ID IS NOT NULL)',
  'runtime_session_leases :: CHECK(RESET_PENDING IN(0,1))',
  "task_execution_lineage_operation_records :: CHECK((RECORD_KIND = 'generation-watermark' AND HIGHEST_SETTLED_GENERATION IS NOT NULL AND OPERATION_GENERATION IS NULL AND DECISION_STATE IS NULL)OR(RECORD_KIND = 'replay-decision' AND OPERATION_GENERATION IS NOT NULL AND HIGHEST_SETTLED_GENERATION IS NULL AND DECISION_STATE IS NOT NULL))",
  // —— N3：同名索引定义漂移的契约侧（与 NAME_COLLISION_DEFINITION_DRIFT 一一对应） ——
  'clarify_rounds :: INDEX(TARGET_CONSUMER_NODE_ID,STATUS)',
  'code_work_observations :: INDEX(WORK_ITEM_ID,CREATED_AT)',
  'code_work_observations :: UNIQUE(EVENT_ID)',
  'intent_turn_events :: UNIQUE(TURN_ID,SOURCE,EXTERNAL_EVENT_ID)',
]

/**
 * 两侧**同名**、定义不同。这一类最容易漏：名字对得上，列集 / 排序 / 部分索引谓词却不一样，
 * 于是两个引擎上「同一个索引」保护的根本不是同一件事。四条各自的形态：
 *   - `idx_clarify_rounds_target_consumer`：列集完全不同（迁移 `(target_consumer_node_id,
 *     loop_iter, iteration)` vs 声明 `(target_consumer_node_id, status)`）——同名不同物；
 *   - `idx_code_work_observations_item`：迁移带 `created_at DESC`，声明没有 `.desc()`；
 *   - `uniq_code_work_observations_event` / `uniq_intent_turn_events_external`：迁移是**部分**
 *     唯一索引（`WHERE … IS NOT NULL`），声明是全量唯一索引。
 * 三种都属于生产改动（改声明或改迁移），由 RFC-359 主线裁决；本守卫只负责把差异钉住。
 */
export const NAME_COLLISION_DEFINITION_DRIFT: readonly string[] = [
  'clarify_rounds.idx_clarify_rounds_target_consumer :: sqlite=INDEX(TARGET_CONSUMER_NODE_ID,LOOP_ITER,ITERATION) | contract=INDEX(TARGET_CONSUMER_NODE_ID,STATUS)',
  'code_work_observations.idx_code_work_observations_item :: sqlite=INDEX(WORK_ITEM_ID,CREATED_AT DESC) | contract=INDEX(WORK_ITEM_ID,CREATED_AT)',
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
    expect(MASTER.filter((row) => row.type === 'trigger').length).toBeGreaterThanOrEqual(8)
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
