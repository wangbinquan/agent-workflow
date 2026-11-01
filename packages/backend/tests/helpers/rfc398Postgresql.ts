// RFC-398 multi-database tests use the same explicit provider selection and URL contract as eachProvider.
import { SQL } from 'bun'
import { describe } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { PostgresqlDatabaseConfigSchema } from '@agent-workflow/shared'
import { resolveTestProviders } from './eachProvider'
import { createPostgresqlDatabaseRuntime } from '@/platform/persistence/postgresqlRuntime'

export const describeRfc398Postgresql = resolveTestProviders(process.env).includes('postgresql')
  ? describe
  : describe.skip
export const pgQuote = (name: string) => `"${name.replaceAll('"', '""')}"`

const COPY_REPLAY_BATCH = 200
const COPY_HEADER = /^COPY (.+) FROM stdin;$/
export type PlainDumpChunk =
  | { kind: 'sql'; text: string }
  | { kind: 'copy'; target: string; rows: (string | null)[][] }

/** One field of PostgreSQL's COPY text format (pg_dump's plain-format data encoding). */
export function decodeCopyTextField(field: string): string | null {
  if (field === '\\N') return null
  let decoded = ''
  for (let index = 0; index < field.length; index += 1) {
    const char = field[index]!
    if (char !== '\\') {
      decoded += char
      continue
    }
    const next = field[++index]
    if (next === undefined) throw new Error(`dangling COPY escape in ${JSON.stringify(field)}`)
    const simple = { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' }[next]
    if (simple !== undefined) {
      decoded += simple
      continue
    }
    const numeric =
      next === 'x'
        ? /^[0-9A-Fa-f]{1,2}/.exec(field.slice(index + 1))
        : /^[0-7]{1,3}/.exec(field.slice(index))
    if (!numeric) {
      decoded += next
      continue
    }
    const code = Number.parseInt(numeric[0], next === 'x' ? 16 : 8)
    // pg_dump writes non-ASCII text as raw UTF-8; a byte escape >= 0x80 would be one byte of a
    // multi-byte sequence, which a JS string cannot carry, so refuse rather than corrupt it.
    if (code >= 0x80) throw new Error(`unsupported COPY byte escape in ${JSON.stringify(field)}`)
    decoded += String.fromCharCode(code)
    index += next === 'x' ? numeric[0].length : numeric[0].length - 1
  }
  return decoded
}

/**
 * Splits a plain-format dump into simple-query SQL chunks and COPY data blocks. psql
 * meta-commands (`\restrict` / `\unrestrict`) carry no data and are dropped.
 */
export function plainDumpChunks(dump: string): PlainDumpChunk[] {
  const chunks: PlainDumpChunk[] = []
  let sql: string[] = []
  let copy: Extract<PlainDumpChunk, { kind: 'copy' }> | null = null
  for (const line of dump.split('\n')) {
    if (copy) {
      if (line === '\\.') {
        chunks.push(copy)
        copy = null
      } else copy.rows.push(line.split('\t').map(decodeCopyTextField))
      continue
    }
    const header = COPY_HEADER.exec(line)
    if (header) {
      chunks.push({ kind: 'sql', text: sql.join('\n') })
      sql = []
      copy = { kind: 'copy', target: header[1]!, rows: [] }
    } else if (!/^\\(?:un)?restrict /.test(line)) sql.push(line)
  }
  if (copy) throw new Error(`unterminated COPY block for ${copy.target}`)
  chunks.push({ kind: 'sql', text: sql.join('\n') })
  return chunks
}
export async function rfc398Postgresql() {
  const url = process.env.AW_TEST_POSTGRESQL_URL ?? process.env.RFC357_DATABASE_URL
  if (!url)
    throw new Error(
      'RFC-398 requires AW_TEST_POSTGRESQL_URL; use AW_TEST_PROVIDERS=sqlite only for the explicit non-PG lane',
    )
  const admin = new SQL(url, { max: 2 })
  const root = mkdtempSync(join(tmpdir(), 'aw-rfc398-'))
  const databases = new Set<string>()
  const pools: SQL[] = []
  const runtimes: ReturnType<typeof createPostgresqlDatabaseRuntime>[] = []
  const databaseUrl = (database: string) => {
    const result = new URL(url)
    result.pathname = `/${encodeURIComponent(database)}`
    return result.toString()
  }
  const connect = (database: string) => {
    const sql = new SQL(databaseUrl(database), { max: 2 })
    pools.push(sql)
    return sql
  }
  return {
    admin,
    root,
    databases,
    url,
    databaseUrl,
    connect,
    async create(
      options = "TEMPLATE template0 ENCODING 'UTF8' LOCALE_PROVIDER libc LC_COLLATE 'C' LC_CTYPE 'C'",
    ) {
      const database = `aw_rfc398_${randomUUID().replaceAll('-', '')}`
      await admin.unsafe(`CREATE DATABASE ${pgQuote(database)} ${options}`)
      databases.add(database)
      return { database, url: databaseUrl(database), sql: connect(database) }
    },
    runtime(database: string) {
      const runtime = createPostgresqlDatabaseRuntime({
        config: PostgresqlDatabaseConfigSchema.parse({
          provider: 'postgresql',
          urlEnv: 'RFC398_URL',
        }),
        env: { RFC398_URL: databaseUrl(database) },
        generationId: 'dbg_rfc398_fixture',
      })
      runtimes.push(runtime)
      return runtime
    },
    /**
     * Restores a plain-format pg_dump fixture without a native psql (neither CI's application
     * lane nor developer machines are required to ship one): SQL chunks run through the simple
     * query protocol on one dedicated session, COPY blocks are replayed as INSERTs.
     */
    async restore(database: string, gzip: string) {
      const session = new SQL(databaseUrl(database), { max: 1 })
      try {
        for (const chunk of plainDumpChunks(gunzipSync(readFileSync(gzip)).toString())) {
          if (chunk.kind === 'sql') {
            if (chunk.text.trim()) await session.unsafe(chunk.text)
            continue
          }
          for (let start = 0; start < chunk.rows.length; start += COPY_REPLAY_BATCH) {
            const values = chunk.rows
              .slice(start, start + COPY_REPLAY_BATCH)
              .map(
                (row) =>
                  `(${row.map((value) => (value === null ? 'NULL' : `'${value.replaceAll("'", "''")}'`)).join(', ')})`,
              )
            await session.unsafe(
              `INSERT INTO ${chunk.target} OVERRIDING SYSTEM VALUE VALUES ${values.join(',\n')}`,
            )
          }
        }
      } finally {
        await session.close()
      }
    },
    async close() {
      for (const runtime of runtimes) await runtime.close()
      for (const pool of pools) await pool.close()
      for (const database of databases)
        await admin.unsafe(`DROP DATABASE IF EXISTS ${pgQuote(database)} WITH (FORCE)`)
      await admin.close()
      rmSync(root, { recursive: true, force: true })
    },
  }
}
