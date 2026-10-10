import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  openReadonlySqliteDatabase,
  type ReadonlySqliteDatabase,
} from '../../src/platform/persistence/sqlite/readonlySqliteDatabase'
import type {
  HistoricalNativePassIdentity,
  HistoricalNativePassReader,
} from '../../src/modules/runtime-management/application/ports/historicalNativeUsage'

// Independent original scalar SQL: no optimized projection/helper is imported as an oracle.
export const originalFields = `SELECT p.id,p.session_id,p.message_id,p.time_created,
  json_extract(p.data,'$.type') AS kind,
  CASE WHEN json_type(p.data,'$.tokens.input') IN ('integer','real','text') THEN json_extract(p.data,'$.tokens.input') END AS input,
  CASE WHEN json_type(p.data,'$.tokens.output') IN ('integer','real','text') THEN json_extract(p.data,'$.tokens.output') END AS output,
  CASE WHEN json_type(p.data,'$.tokens.reasoning') IN ('integer','real','text') THEN json_extract(p.data,'$.tokens.reasoning') END AS reasoning,
  CASE WHEN json_type(p.data,'$.tokens.cache.read') IN ('integer','real','text') THEN json_extract(p.data,'$.tokens.cache.read') END AS cache_read,
  CASE WHEN json_type(p.data,'$.tokens.cache.write') IN ('integer','real','text') THEN json_extract(p.data,'$.tokens.cache.write') END AS cache_write,
  CASE WHEN json_extract(m.data,'$.role')='assistant' THEN json_extract(m.data,'$.providerID') END AS provider,
  CASE WHEN json_extract(m.data,'$.role')='assistant' THEN json_extract(m.data,'$.modelID') END AS model
  FROM part p LEFT JOIN message m ON m.id=p.message_id AND m.session_id=p.session_id`

export function projectionFixture(count = 603) {
  const folder = mkdtempSync(join(tmpdir(), 'aw-native-projections-')),
    path = join(folder, 'original.db'),
    db = new Database(path)
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE session(id TEXT PRIMARY KEY,parent_id TEXT,time_created INTEGER);
    CREATE INDEX session_parent ON session(parent_id);
    CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,data TEXT);
    CREATE TABLE part(id TEXT PRIMARY KEY,session_id TEXT,message_id TEXT,time_created INTEGER,data TEXT);
    CREATE INDEX part_session ON part(session_id);`)
  const id = (n: number) => 'part-' + String(n).padStart(4, '0')
  db.transaction(() => {
    db.query('INSERT INTO session VALUES (?,?,?)').run('root', null, 1000)
    for (let n = 0; n < 3; n++)
      db.query('INSERT INTO message VALUES (?,?,?)').run(
        'message-' + n,
        'root',
        JSON.stringify({
          role: n === 2 ? 'user' : 'assistant',
          providerID: 'original-provider',
          modelID: 'original-model-' + n,
        }),
      )
    for (let n = 0; n < count; n++)
      db.query('INSERT INTO part VALUES (?,?,?,?,?)').run(
        id(n),
        'root',
        'message-' + (Math.floor(n / 3) % 3),
        1234 + n,
        JSON.stringify({
          type: ['step-start', 'step-finish', 'tool'][n % 3],
          tokens: {
            input: n === 4 ? true : '9007199254740993123456',
            output: 3,
            reasoning: 2,
            cache: { read: '7', write: 13 },
          },
          text: 'original-body-not-transported'.repeat(30),
        }),
      )
  })()
  return {
    path,
    db,
    id,
    close() {
      db.close()
      rmSync(folder, { recursive: true, force: true })
    },
  }
}
export const projectionIdentity = (passId: string): HistoricalNativePassIdentity => ({
  kind: 'historical-observed',
  referenceId: 'original-reference',
  passId,
  nativeSource: 'original-file',
  sourceGeneration: 'original-generation',
  rootSessionId: 'root',
})
export function scalarRows(db: Database, session = 'root') {
  return db
    .query<
      Record<string, unknown>,
      [string]
    >(originalFields + ' WHERE p.session_id=? ORDER BY p.id')
    .all(session)
}
export function scalarRootEOF(db: Database) {
  const hash = createHash('sha256'),
    root = db.query('SELECT id,parent_id,time_created FROM session WHERE id=?').get('root')!,
    rows = scalarRows(db)
  hash.update(JSON.stringify(['root', root]))
  hash.update(JSON.stringify(['session', { id: 'root', parentSessionId: null }]))
  for (const row of rows) hash.update(JSON.stringify(['part', row]))
  return {
    fingerprint: hash.digest('hex'),
    counts: {
      sessions: '1',
      parts: String(rows.length),
      steps: String(rows.filter((row) => row.kind === 'step-finish').length),
    },
  }
}

export type BatchFault = 'throw' | 'missing' | 'duplicate' | 'reverse'
/** Every successful query runs against the real original SQLite; faults affect only the named call. */
export function instrumentProjectionDatabase(
  options: {
    batchFault?: BatchFault
    pointFailureId?: string
  } = {},
) {
  const counts = { batches: 0, points: 0, closes: 0 },
    projected: Record<string, unknown>[] = []
  const open = (path: string): ReadonlySqliteDatabase => {
    const db = openReadonlySqliteDatabase(path)
    let closed = false
    return {
      query<Row, Parameters extends readonly unknown[]>(sql: string) {
        const statement = db.query<Row, Parameters>(sql)
        return {
          get(...parameters: Parameters) {
            if (sql.includes('WHERE p.session_id=?1 AND p.id=?2 ORDER BY p.id LIMIT 1')) {
              counts.points++
              if (parameters[1] === options.pointFailureId)
                throw new Error('original-point-failure')
            }
            return statement.get(...parameters)
          },
          all(...parameters: Parameters) {
            if (!sql.includes('FROM json_each(?2)')) return statement.all(...parameters)
            counts.batches++
            if (options.batchFault === 'throw') throw new Error('original-batch-unavailable')
            const rows = statement.all(...parameters)
            projected.push(...(rows as unknown as Record<string, unknown>[]))
            if (options.batchFault === 'missing') return rows.slice(1)
            if (options.batchFault === 'duplicate')
              return rows.length > 1 ? [rows[0]!, ...rows.slice(0, -1)] : []
            if (options.batchFault === 'reverse') return rows.toReversed()
            return rows
          },
        }
      },
      close() {
        if (!closed) {
          closed = true
          db.close()
          counts.closes++
        }
      },
    }
  }
  return { open, counts, projected }
}

export function consumeProjection(reader: HistoricalNativePassReader) {
  let cursor: string | null = reader.initialCursor,
    last: ReturnType<HistoricalNativePassReader['next']> | undefined
  const pages: ReturnType<HistoricalNativePassReader['next']>[] = [],
    steps: Array<ReturnType<HistoricalNativePassReader['next']>['steps'][number]> = []
  while (cursor !== null) {
    const page: ReturnType<HistoricalNativePassReader['next']> = reader.next(cursor)
    pages.push(page)
    steps.push(...page.steps)
    reader.acknowledge(page.ordinal, page.payloadDigest)
    cursor = page.nextCursor
    last = page
  }
  return { pages, steps, eof: last!.eof, issues: last!.issues }
}
