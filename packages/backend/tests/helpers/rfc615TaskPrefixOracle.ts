import { TASK_DEFINITION_HOSTS } from '@agent-workflow/shared'
import { SQL, StringChunk } from 'drizzle-orm'

const DECLARATION = `  const columns = taskReadColumns(db)
  const prefixTasks = taskReadSql(db, 't', {
    id: columns.id,
    startedAt: columns.startedAt,
  })
`
const CURRENT_ROOT = `    root_prefix AS MATERIALIZED (
      -- tasks.id is unique and open_alerts is DISTINCT: each prefix row has
      -- at most one match. Fetch membership and root together, without two
      -- correlated expansions of the same NOT MATERIALIZED match query.
      -- CROSS JOIN keeps SQLite's bounded prefix outermost.
      SELECT p.id, m.rid, p.started_at
      FROM physical_prefix p CROSS JOIN matches m WHERE m.id = p.id
    ),
`
const PREVIOUS_ROOT = `    root_prefix_lookup AS MATERIALIZED (
      SELECT p.id, p.started_at,
        (SELECT m.id FROM matches m WHERE m.id = p.id) AS matched_id,
        (SELECT m.rid FROM matches m WHERE m.id = p.id) AS rid
      FROM physical_prefix p
    ),
    root_prefix AS MATERIALIZED (
      SELECT p.id, p.rid, p.started_at FROM root_prefix_lookup p
      WHERE p.matched_id IS NOT NULL
    ),
`
const CATALOG_CTE = '    non_view_matches AS NOT MATERIALIZED ('
const CATALOG_FROM = '      FROM '
const PREFIX_FROM = '      SELECT t.id, t.started_at FROM '
const HOSTS = [
  TASK_DEFINITION_HOSTS.agent.id,
  TASK_DEFINITION_HOSTS.workgroup.id,
  TASK_DEFINITION_HOSTS['digital-employee'].id,
  TASK_DEFINITION_HOSTS['code-round'].id,
] as const

function replaceOnce(text: string, current: string, previous: string): string {
  if (text.split(current).length !== 2) throw new Error('missing unique RFC-615 inverse site')
  return text.replace(current, previous)
}

// These are the actual emitter's comments, quoted tokens and two native bind
// forms. Count and renumber with the same lexer: a comment's apostrophe must
// not hide real binds, and a literal '$99' must never be rewritten as one.
const SQL_TOKENS = /--[^\r\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|\?|\$\d+/g

export function sqlParameterCount(text: string): number {
  return [...text.matchAll(SQL_TOKENS)].filter(([token]) => token === '?' || token.startsWith('$'))
    .length
}

export function renumberSqlParameters(text: string): string {
  let ordinal = 0
  return text.replace(SQL_TOKENS, (token) => (token.startsWith('$') ? `$${++ordinal}` : token))
}

export function restorePre615TaskPrefixSource(source: string): string {
  return replaceOnce(
    replaceOnce(
      replaceOnce(source, DECLARATION, ''),
      `${PREFIX_FROM}\${prefixTasks}`,
      `${PREFIX_FROM}\${taskCatalogReadSql(db, 't')}`,
    ),
    CURRENT_ROOT,
    PREVIOUS_ROOT,
  )
}

/** Restore the pre-RFC615 AST, retaining every unrelated bound object. The old
 * physical prefix used the same catalog projection/alias as non_view_matches;
 * reuse that actual SQL chunk, not a newly generated task-page query. */
export function restorePre615TaskPrefixQuery(query: SQL): SQL {
  let catalog: SQL | undefined
  let pending: 'catalog' | 'prefix' | undefined
  let projections = 0
  let joins = 0
  const chunks: SQL['queryChunks'] = []
  for (const chunk of query.queryChunks) {
    if (!(chunk instanceof StringChunk)) {
      if (pending !== undefined) {
        if (!(chunk instanceof SQL)) throw new Error('missing task projection SQL chunk')
        if (pending === 'catalog') catalog = chunk
        else {
          if (catalog === undefined) throw new Error('missing preceding catalog projection')
          chunks.push(catalog)
          projections++
          pending = undefined
          continue
        }
        pending = undefined
      }
      chunks.push(chunk)
      continue
    }
    chunks.push(
      new StringChunk(
        chunk.value.map((text) => {
          if (text.includes(CATALOG_CTE) && text.endsWith(CATALOG_FROM)) pending = 'catalog'
          if (text.endsWith(PREFIX_FROM)) pending = 'prefix'
          joins += text.split(CURRENT_ROOT).length - 1
          return text.replace(CURRENT_ROOT, PREVIOUS_ROOT)
        }),
      ),
    )
  }
  if (pending !== undefined || projections !== 1 || joins !== 1)
    throw new Error('missing unique RFC-615 projection or root join')
  return new SQL(chunks)
}

/** Find an entire parenthesized projection, allowing nested queries and quoted
 * parentheses. Both real compilers retain the explicit quoted alias. */
function projectionRange(text: string, marker: string, from = 0): [number, number] {
  const site = text.indexOf(marker, from)
  const start = site + marker.length
  if (site < 0 || text[start] !== '(') throw new Error('missing compiled task projection')
  let depth = 0
  let quote: string | undefined
  for (let index = start; index < text.length; index++) {
    const character = text[index]!
    if (quote !== undefined) {
      if (character === quote) {
        if (text[index + 1] === quote) index++
        else quote = undefined
      }
    } else if (character === "'" || character === '"') quote = character
    else if (character === '(') depth++
    else if (character === ')' && --depth === 0) {
      const alias = /^\s+"t"/.exec(text.slice(index + 1))
      if (alias === null) throw new Error('missing compiled task projection alias')
      return [start, index + 1 + alias[0].length]
    }
  }
  throw new Error('unterminated compiled task projection')
}

function projectionSites(text: string) {
  const catalogCte = text.indexOf(CATALOG_CTE)
  if (catalogCte < 0) throw new Error('missing catalog CTE')
  const catalog = projectionRange(text, CATALOG_FROM, catalogCte)
  const prefix = projectionRange(text, PREFIX_FROM)
  if (sqlParameterCount(text.slice(...catalog)) !== HOSTS.length)
    throw new Error('unexpected original catalog projection bindings')
  if (sqlParameterCount(text.slice(...prefix)) !== 0)
    throw new Error('unexpected narrow prefix projection bindings')
  return { catalog, prefix }
}

export function restorePre615TaskPrefixText(text: string): string {
  const { catalog, prefix } = projectionSites(text)
  const restored = replaceOnce(
    text.slice(0, prefix[0]) + text.slice(...catalog) + text.slice(prefix[1]),
    CURRENT_ROOT,
    PREVIOUS_ROOT,
  )
  return renumberSqlParameters(restored)
}

export function restorePre615TaskPrefixBindings(
  text: string,
  values: readonly unknown[],
): readonly unknown[] {
  const { catalog, prefix } = projectionSites(text)
  if (sqlParameterCount(text) !== values.length) throw new Error('incomplete real binding vector')
  const catalogOffset = sqlParameterCount(text.slice(0, catalog[0]))
  if (HOSTS.some((host, index) => values[catalogOffset + index] !== host))
    throw new Error('unexpected original catalog host bindings')
  const offset = sqlParameterCount(text.slice(0, prefix[0]))
  return [...values.slice(0, offset), ...HOSTS, ...values.slice(offset)]
}
