import type { ReadOnlyProbe } from '@/platform/persistence/migration/run/types'
import { contentRefColumns } from '../contentStore'
import { sha256Hex } from '@/util/hash'

/** Target-only read probes; no source reader or daemon recovery is started. */
export const readOnlyProbes: readonly ReadOnlyProbe[] = [
  {
    id: 'platform/content:catalog-bytes-and-publications',
    async run(connection) {
      const issues: string[] = []
      const rows = await connection.query(`SELECT o.content_id, o.sha256, o.size, b.bytes
        FROM content_objects o LEFT JOIN content_bytes b ON b.content_id = o.content_id
        WHERE o.kind = 'database-bytes'`)
      for (const row of rows) {
        if (
          !(row.bytes instanceof Uint8Array) ||
          row.bytes.byteLength !== Number(row.size) ||
          sha256Hex(row.bytes) !== row.sha256
        )
          issues.push(`bytes:${String(row.content_id)}`)
      }
      const publications = await connection.query(`SELECT p.id FROM content_publications p
        LEFT JOIN content_objects o ON o.content_id = p.content_id
        WHERE p.state = 'ready' AND (o.content_id IS NULL OR p.sha256 <> o.sha256 OR p.size <> o.size)`)
      issues.push(...publications.map((row) => `publication:${String(row.id)}`))
      return {
        id: 'platform/content:catalog-bytes-and-publications',
        passed: issues.length === 0,
        detail: { issues },
      }
    },
  },
  {
    id: 'platform/content:skill-reference-columns',
    async run(connection) {
      const issues: string[] = []
      for (const table of ['skills', 'skill_versions', 'skill_content_entries']) {
        const rows = await connection.query(
          `SELECT content_ref_json, content_inline_bytes FROM ${table}`,
        )
        for (const [index, row] of rows.entries()) {
          try {
            const ref = contentRefColumns.decode(
              row.content_ref_json as string | null,
              row.content_inline_bytes as Uint8Array | null,
            )
            if (table !== 'skills' && ref === null) issues.push(`${table}:${index}:missing`)
          } catch (error) {
            issues.push(
              `${table}:${index}:${error instanceof Error ? error.message : String(error)}`,
            )
          }
        }
      }
      return {
        id: 'platform/content:skill-reference-columns',
        passed: issues.length === 0,
        detail: { issues },
      }
    },
  },
]
