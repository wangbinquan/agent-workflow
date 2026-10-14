// RFC-371 v2 §4 — one bounded, read-only aggregate over OpenCode's native store
// after an invocation drained. Only numeric step-finish fields and the assistant
// message's provider/model are read; no prompt, output or tool content.

import { isAbsolute, join } from 'node:path'
import {
  openReadonlySqliteDatabase,
  type ReadonlySqliteDatabase,
} from '@/platform/persistence/sqlite/readonlySqliteDatabase'
import type { RuntimeUsageModel } from '../usage'

/** Delegation depth below a root session that the summary follows. */
export const OPENCODE_TREE_MAX_DEPTH = 8
/** A tree larger than this is not summarized (the stream snapshot is kept). */
export const OPENCODE_TREE_MAX_SESSIONS = 500

/** Mirrors OpenCode's explicit DB path and standard data directory for this child environment. */
export function opencodeUsageDatabasePath(
  env: Readonly<Record<string, string | undefined>>,
): string | null {
  const explicit = env.OPENCODE_DB
  if (explicit === ':memory:') return null
  if (explicit && isAbsolute(explicit)) return explicit
  const data =
    env.XDG_DATA_HOME && isAbsolute(env.XDG_DATA_HOME)
      ? env.XDG_DATA_HOME
      : env.HOME && isAbsolute(env.HOME)
        ? join(env.HOME, '.local', 'share')
        : null
  return data ? join(data, 'opencode', explicit || 'opencode.db') : null
}

const count = (value: unknown): number => {
  const n = typeof value === 'string' ? Number(value) : value
  return typeof n === 'number' && Number.isSafeInteger(n) && n > 0 ? n : 0
}

export interface OpencodeTreeUsage {
  readonly models: RuntimeUsageModel[]
  /** step-finish parts of the root sessions themselves (the stream's own view). */
  readonly rootSteps: number
}

/**
 * Sum the step-finish tokens of `roots` and their descendants created at or
 * after `since`, per actual model. The time bound keeps steps an earlier
 * invocation of a resumed session already used out of this one. Returns null
 * when the store is unavailable or the tree exceeds its bound.
 */
export function readOpencodeTreeUsage(
  path: string,
  roots: readonly string[],
  since: number,
): OpencodeTreeUsage | null {
  if (roots.length === 0) return null
  let db: ReadonlySqliteDatabase | undefined
  try {
    db = openReadonlySqliteDatabase(path)
    db.query<unknown, []>('PRAGMA busy_timeout = 1000').get()
    const placeholders = roots.map(() => '?').join(',')
    const tree = `WITH RECURSIVE tree(id, depth) AS (
        SELECT id, 0 FROM session WHERE id IN (${placeholders})
        UNION
        SELECT s.id, t.depth + 1 FROM session s JOIN tree t ON s.parent_id = t.id
        WHERE t.depth < ${OPENCODE_TREE_MAX_DEPTH}
      )`
    const size = db
      .query<{ sessions: number }, string[]>(`${tree} SELECT count(*) AS sessions FROM tree`)
      .get(...roots)
    if (!size || size.sessions > OPENCODE_TREE_MAX_SESSIONS) return null
    const rows = db
      .query<
        {
          provider: unknown
          model: unknown
          input: unknown
          output: unknown
          reasoning: unknown
          cache_read: unknown
          cache_write: unknown
          root_steps: unknown
        },
        (string | number)[]
      >(
        `${tree}
        SELECT json_extract(m.data, '$.providerID') AS provider,
               json_extract(m.data, '$.modelID') AS model,
               sum(json_extract(p.data, '$.tokens.input')) AS input,
               sum(json_extract(p.data, '$.tokens.output')) AS output,
               sum(json_extract(p.data, '$.tokens.reasoning')) AS reasoning,
               sum(json_extract(p.data, '$.tokens.cache.read')) AS cache_read,
               sum(json_extract(p.data, '$.tokens.cache.write')) AS cache_write,
               sum(CASE WHEN p.session_id IN (${placeholders}) THEN 1 ELSE 0 END) AS root_steps
        FROM part p JOIN message m ON m.id = p.message_id
        WHERE p.session_id IN (SELECT id FROM tree)
          AND p.time_created >= ?
          AND json_extract(p.data, '$.type') = 'step-finish'
        GROUP BY provider, model`,
      )
      .all(...roots, ...roots, since)
    const models = rows.map((row) => {
      const provider = typeof row.provider === 'string' ? row.provider : ''
      const model = typeof row.model === 'string' ? row.model : ''
      const reasoning = count(row.reasoning)
      return {
        model: model ? (provider ? `${provider}/${model}` : model) : '',
        input: count(row.input),
        cacheRead: count(row.cache_read),
        cacheWrite: count(row.cache_write),
        output: count(row.output) + reasoning,
        reasoning,
      }
    })
    return {
      models: models.sort((a, b) => a.model.localeCompare(b.model)),
      rootSteps: rows.reduce((sum, row) => sum + count(row.root_steps), 0),
    }
  } catch {
    return null
  } finally {
    try {
      db?.close()
    } catch {
      /* No reader survives the call. */
    }
  }
}
