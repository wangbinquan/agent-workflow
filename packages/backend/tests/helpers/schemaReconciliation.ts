// RFC-395 I-a: reuse t19g's SQL-only normalizer and physical protection collector verbatim.
import type { Database } from 'bun:sqlite'

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

/** Expand the actual three-event observer to SQLite's three named event triggers; reject other declarations. */
export function nativeTriggerProtections(statement: {
  sql: string
  logicalId: string
}): SchemaProtection[] {
  if (statement.logicalId.endsWith(':observation-change')) {
    const declared =
      /^CREATE TRIGGER "([^"]+)" AFTER INSERT OR UPDATE OR DELETE ON "agent_workflow"\."([^"]+)" FOR EACH ROW EXECUTE FUNCTION "agent_workflow"\."\1"\(\)$/.exec(
        statement.sql,
      )
    if (!declared || statement.logicalId !== declared[2] + ':observation-change')
      throw new Error(
        'RFC-359 T19g: unsupported native observation trigger declaration: ' + statement.sql,
      )
    return ['insert', 'update', 'delete'].map((event) => ({
      table: declared[2]!,
      name: declared[1]! + '_' + event,
      def: 'TRIGGER ' + declared[1]! + '_' + event,
    }))
  }
  const declared =
    /^CREATE TRIGGER "([^"]+)" AFTER (?:INSERT|UPDATE|DELETE) ON "agent_workflow"\."([^"]+)" REFERENCING /.exec(
      statement.sql,
    )
  if (!declared)
    throw new Error('RFC-359 T19g: unsupported native trigger declaration: ' + statement.sql)
  return [{ table: declared[2]!, name: declared[1]!, def: 'TRIGGER ' + declared[1]! }]
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
