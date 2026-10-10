import type { ReadonlySqliteDatabase } from '@/platform/persistence/sqlite/readonlySqliteDatabase'

export interface OpencodePartRow {
  id: string
  session_id: string
  message_id: string
  time_created: number
  kind: string | null
  input: unknown
  output: unknown
  reasoning: unknown
  cache_read: unknown
  cache_write: unknown
  provider: unknown
  model: unknown
}
interface CachedMessagePartRow extends OpencodePartRow {
  cache_message?: string | null
}
interface PartWindow {
  session: string
  eligible: boolean
  ids: Array<{ id: unknown }>
  index: number
  rows?: CachedMessagePartRow[]
}
const identifier = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0

// Preserve the original field expressions/order and exclude text/tool bodies.
const projection = `SELECT p.id,p.session_id,p.message_id,p.time_created,
  json_extract(p.data,'$.type') AS kind,
  CASE WHEN json_type(p.data,'$.tokens.input') IN ('integer','real','text') THEN json_extract(p.data,'$.tokens.input') END AS input,
  CASE WHEN json_type(p.data,'$.tokens.output') IN ('integer','real','text') THEN json_extract(p.data,'$.tokens.output') END AS output,
  CASE WHEN json_type(p.data,'$.tokens.reasoning') IN ('integer','real','text') THEN json_extract(p.data,'$.tokens.reasoning') END AS reasoning,
  CASE WHEN json_type(p.data,'$.tokens.cache.read') IN ('integer','real','text') THEN json_extract(p.data,'$.tokens.cache.read') END AS cache_read,
  CASE WHEN json_type(p.data,'$.tokens.cache.write') IN ('integer','real','text') THEN json_extract(p.data,'$.tokens.cache.write') END AS cache_write,
  CASE WHEN c.message IS NOT NULL THEN c.provider ELSE CASE WHEN json_extract(m.data,'$.role')='assistant' THEN json_extract(m.data,'$.providerID') END END AS provider,
  CASE WHEN c.message IS NOT NULL THEN c.model ELSE CASE WHEN json_extract(m.data,'$.role')='assistant' THEN json_extract(m.data,'$.modelID') END END AS model,
  c.message AS cache_message`
const joins = `LEFT JOIN message m ON m.id=p.message_id AND m.session_id=p.session_id
  LEFT JOIN temp.native_pass_message_models c ON c.message=p.message_id AND c.session=p.session_id`
const fields = projection + ' FROM part p ' + joins

/** Only this original snapshot's current key window is prefetched, never its full population. */
export function createOpencodePartProjection(db: ReadonlySqliteDatabase) {
  let window: PartWindow | undefined
  return {
    read(session: string, after: string | null, remaining: number): CachedMessagePartRow | null {
      if (window?.session !== session) {
        let eligible = false
        try {
          // Unqualified JSON must retain the original range query's failure prefix.
          eligible =
            db
              .query<{ unavailable: number }, [string]>(
                `SELECT 1 AS unavailable FROM part p
                LEFT JOIN message m ON m.id=p.message_id AND m.session_id=p.session_id
                WHERE p.session_id=?1 AND (json_valid(p.data) IS NOT 1 OR
                  (m.id IS NOT NULL AND json_valid(m.data) IS NOT 1)) LIMIT 1`,
              )
              .get(session) === null
        } catch {
          // Uncertain qualification keeps the complete original range query.
        }
        window = { session, eligible, ids: [], index: 0 }
      }
      if (window.eligible && window.index === window.ids.length) {
        const size = Math.min(200, remaining)
        window.ids =
          after === null
            ? db
                .query<
                  { id: unknown },
                  [string, number]
                >('SELECT p.id FROM part p WHERE p.session_id=?1 ORDER BY p.id LIMIT ?2')
                .all(session, size)
            : db
                .query<
                  { id: unknown },
                  [string, string, number]
                >('SELECT p.id FROM part p WHERE p.session_id=?1 AND p.id>?2 ORDER BY p.id LIMIT ?3')
                .all(session, after, size)
        window.index = 0
        window.rows = undefined
        if (
          window.ids.length &&
          window.ids.every((key) => identifier(key.id)) &&
          new Set(window.ids.map((key) => key.id)).size === window.ids.length
        ) {
          try {
            const rows = db
              .query<
                CachedMessagePartRow,
                [string, string]
              >(projection + ' FROM json_each(?2) k CROSS JOIN part p ON p.id=k.value ' + joins + ' WHERE p.session_id=?1 ORDER BY CAST(k.key AS INTEGER)')
              .all(session, JSON.stringify(window.ids.map((key) => key.id)))
            if (
              rows.length === window.ids.length &&
              rows.every((row, index) => row.id === window!.ids[index]!.id)
            )
              window.rows = rows
          } catch {
            // Prefetch is optional: the original current-key query retains its errors/EOF.
          }
        }
      }
      const key = window.ids[window.index]
      let row: CachedMessagePartRow | null = null
      if (!window.eligible || (key && !identifier(key.id))) {
        row =
          after === null
            ? db
                .query<
                  CachedMessagePartRow,
                  [string]
                >(fields + ' WHERE p.session_id=?1 ORDER BY p.id LIMIT 1')
                .get(session)
            : db
                .query<
                  CachedMessagePartRow,
                  [string, string]
                >(fields + ' WHERE p.session_id=?1 AND p.id>?2 ORDER BY p.id LIMIT 1')
                .get(session, after)
      } else if (key) {
        row =
          window.rows?.[window.index] ??
          db
            .query<
              CachedMessagePartRow,
              [string, unknown]
            >(fields + ' WHERE p.session_id=?1 AND p.id=?2 ORDER BY p.id LIMIT 1')
            .get(session, key.id)
      }
      // The reader deletes its internal flag and may retry this row after a byte-budget break.
      return row ? { ...row } : null
    },
    advance() {
      if (window?.eligible) window.index++
    },
    reset() {
      window = undefined
    },
  }
}
