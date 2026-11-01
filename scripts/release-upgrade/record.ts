#!/usr/bin/env bun
import { SQL } from 'bun'
import { Database } from 'bun:sqlite'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { gzipSync } from 'node:zlib'
import { parseArgs } from 'node:util'
import { format } from 'prettier'
import { canonical, FIXTURES, normalizeHome, readRegistry, sha256, walk, writeJson } from './lib/io'
import type { Json, Row } from './lib/model'

export interface DatasetColumn {
  name: string
  type: string
  nullable: boolean
  primaryKeyOrdinal: number
}
export interface RecordedTable {
  schema: string
  name: string
  columns: DatasetColumn[]
  file: string
  rowCount: number
  sha256: string
}
export interface RecordedContent {
  path: string
  file: string
  sha256: string
  sourceSha256: string
  normalization: 'home-path-utf8' | 'none'
}
export interface ReleaseDataset {
  formatVersion: 1
  tag: string
  provider: 'sqlite' | 'postgresql'
  homePlaceholder: '<AW_HOME>'
  valueEncoding: 'json-with-tagged-bigint-bytes-timestamp-v1'
  tables: RecordedTable[]
  content: RecordedContent[]
  projections: string | null
}
const identifier = (value: string) => `"${value.replaceAll('"', '""')}"`

export function logicalValue(value: unknown): Json {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : { $number: String(value) }
  if (typeof value === 'bigint') return { $bigint: String(value) }
  if (value instanceof Uint8Array) return { $bytes: Buffer.from(value).toString('base64') }
  if (value instanceof Date) return { $timestamp: value.toISOString() }
  if (Array.isArray(value)) return value.map(logicalValue)
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, logicalValue(item)]))
  throw new Error(`Unsupported database value: ${typeof value}`)
}

export function canonicalRows(values: readonly Record<string, unknown>[], home: string): string {
  const rows = values.map((row) => canonical(normalizeHome(logicalValue(row), home))).sort()
  return rows.length ? `${rows.join('\n')}\n` : ''
}

export function recordingSqlitePath(home: string): string {
  const pointer = join(home, 'database-generation.json')
  if (existsSync(pointer)) {
    const value = JSON.parse(readFileSync(pointer, 'utf8')) as {
      payload?: { provider?: string; database?: { kind?: string; relativePath?: string } }
    }
    if (value.payload?.provider === 'postgresql')
      throw new Error('Home points to PostgreSQL; pass --provider postgresql and --url-env')
    const location = value.payload?.database
    if (location?.kind === 'sqlite-file' && location.relativePath)
      return resolve(home, location.relativePath)
  }
  return join(home, 'db.sqlite')
}

/** Refuse a live home. The recorder never checkpoints or changes a source database. */
export function assertStoppedHome(home: string): void {
  const lock = join(home, '.daemon.lock')
  if (!existsSync(lock)) return
  const text = readFileSync(lock, 'utf8').trim()
  const pid = Number(text)
  if (!Number.isSafeInteger(pid) || pid <= 0)
    throw new Error('Unrecognized daemon lock; stop the old daemon before recording')
  try {
    process.kill(pid, 0)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return
    throw error
  }
  throw new Error(`Daemon ${pid} is still running; stop before recording`)
}

export async function recordDataset(options: {
  home: string
  output: string
  tag: string
  provider: 'sqlite' | 'postgresql'
  postgresqlUrl?: string
  contentRoots?: string[]
}): Promise<ReleaseDataset> {
  const home = resolve(options.home)
  const output = resolve(options.output)
  assertStoppedHome(home)
  if (output === home || output.startsWith(`${home}${sep}`))
    throw new Error('Dataset output must be outside the recording home')
  if (existsSync(output) && readdirSync(output).length)
    throw new Error(`Dataset output must be empty: ${output}`)
  mkdirSync(join(output, 'tables'), { recursive: true })
  const tables: RecordedTable[] = []
  const record = (
    schema: string,
    name: string,
    columns: DatasetColumn[],
    values: Record<string, unknown>[],
  ) => {
    const file = `tables/${encodeURIComponent(schema)}.${encodeURIComponent(name)}.jsonl`
    const bytes = canonicalRows(values, home)
    writeFileSync(join(output, file), bytes)
    tables.push({ schema, name, columns, file, rowCount: values.length, sha256: sha256(bytes) })
  }
  if (options.provider === 'sqlite') {
    // Read a byte copy. A readwrite connection may create sidecars only beside
    // that disposable copy; the recording home's bytes remain untouched.
    const path = recordingSqlitePath(home)
    if (existsSync(`${path}-wal`) && statSync(`${path}-wal`).size > 0)
      throw new Error(
        'Uncheckpointed WAL remains; use the old daemon to close cleanly before recording',
      )
    const scratch = mkdtempSync(join(tmpdir(), 'aw-release-record-'))
    const snapshot = join(scratch, 'db.sqlite')
    copyFileSync(path, snapshot)
    const db = new Database(snapshot, { readwrite: true, create: false, safeIntegers: true })
    try {
      for (const { name } of db
        .query(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all() as { name: string }[]) {
        const info = db.query(`PRAGMA table_info(${identifier(name)})`).all() as {
          name: string
          type: string
          notnull: number | bigint
          pk: number | bigint
        }[]
        record(
          'main',
          name,
          info.map((column) => ({
            name: column.name,
            type: column.type,
            nullable: !column.notnull,
            primaryKeyOrdinal: Number(column.pk),
          })),
          db.query(`SELECT * FROM ${identifier(name)}`).all() as Record<string, unknown>[],
        )
      }
    } finally {
      db.close()
      rmSync(scratch, { recursive: true, force: true })
    }
  } else {
    if (!options.postgresqlUrl) throw new Error('PostgreSQL URL is required')
    const connection = new SQL(options.postgresqlUrl, { max: 1, bigint: true })
    try {
      await connection.begin(async (tx) => {
        await tx.unsafe('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
        const list = await tx.unsafe(
          "SELECT schemaname, tablename FROM pg_tables WHERE schemaname IN ('agent_workflow', 'agent_workflow_meta', 'public') ORDER BY schemaname, tablename",
        )
        for (const table of list) {
          const schema = String(table.schemaname)
          const name = String(table.tablename)
          const columns = await tx.unsafe(
            `SELECT a.attname AS name, format_type(a.atttypid,a.atttypmod) AS type, NOT a.attnotnull AS nullable, COALESCE(array_position(i.indkey::smallint[],a.attnum)-array_lower(i.indkey::smallint[],1)+1,0) AS pk FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_index i ON i.indrelid=c.oid AND i.indisprimary WHERE n.nspname=$1 AND c.relname=$2 AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`,
            [schema, name],
          )
          record(
            schema,
            name,
            columns.map((column: Record<string, unknown>) => ({
              name: String(column.name),
              type: String(column.type),
              nullable: Boolean(column.nullable),
              primaryKeyOrdinal: Number(column.pk),
            })),
            (await tx.unsafe(`SELECT * FROM ${identifier(schema)}.${identifier(name)}`)) as Record<
              string,
              unknown
            >[],
          )
        }
      })
    } finally {
      await connection.close()
    }
  }
  const content: RecordedContent[] = []
  // Includes managed skills/version snapshots, content-store blobs, runtime
  // output material and business worktree files; excludes Git internals and logs.
  for (const root of options.contentRoots ?? [
    'skills',
    'content',
    'artifacts',
    'runs',
    'snapshots',
    'worktrees',
    'archive',
  ]) {
    const absolute = resolve(home, root)
    if (!absolute.startsWith(`${home}${sep}`)) throw new Error(`Content root escapes home: ${root}`)
    for (const path of walkContent(absolute)) {
      const source = readFileSync(path)
      const text = source.toString('utf8')
      const isText = !source.includes(0) && Buffer.from(text, 'utf8').equals(source)
      const normalized = isText ? Buffer.from(normalizeHome(text, home) as string) : source
      const hash = sha256(normalized)
      const file = `content/${hash}`
      mkdirSync(dirname(join(output, file)), { recursive: true })
      writeFileSync(join(output, file), normalized)
      content.push({
        path: relative(home, path).split(sep).join('/'),
        file,
        sha256: hash,
        sourceSha256: sha256(source),
        normalization: isText && !source.equals(normalized) ? 'home-path-utf8' : 'none',
      })
    }
  }
  const projection = join(home, 'release-upgrade-api-before.json')
  if (existsSync(projection))
    writeJson(
      join(output, 'api-projections.json'),
      normalizeHome(JSON.parse(readFileSync(projection, 'utf8')) as Json, home),
    )
  const dataset: ReleaseDataset = {
    formatVersion: 1,
    tag: options.tag,
    provider: options.provider,
    homePlaceholder: '<AW_HOME>',
    valueEncoding: 'json-with-tagged-bigint-bytes-timestamp-v1',
    tables,
    content,
    projections: existsSync(projection) ? 'api-projections.json' : null,
  }
  writeJson(join(output, 'dataset.json'), dataset)
  return dataset
}

function walkContent(root: string): string[] {
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .flatMap((entry) => {
      if (entry.name === '.git' || entry.name === 'node_modules') return []
      const path = join(root, entry.name)
      if (entry.isSymbolicLink())
        throw new Error(`Content symlink requires explicit materialization: ${path}`)
      return entry.isDirectory() ? walkContent(path) : [path]
    })
    .sort()
}

interface CaptureFile {
  path: string
  sha256: string
  bytes: number
}
export interface FinalizeFixtureManifest {
  formatVersion: 1
  tag: string
  /** Absent for the first-write capture. */
  state?: 'unwritten'
  binarySha256: string
  platform: 'macos-arm64'
  operationId: string
  states: Record<
    'before' | 'after',
    {
      files: CaptureFile[]
      omitted: CaptureFile[]
      postgres: {
        file: string
        sourceSha256: string
        compressedSha256: string
        sourceBytes: number
        compressedBytes: number
      }
    }
  >
}

/** Import, do not re-finalize: preserve envelope digests and original bytes. */
/**
 * `first-write`: the old binary's one-click migration plus its first live PostgreSQL write.
 * `unwritten`: the same migration with no live PostgreSQL write at all (design §4's state
 * "迁移后未首写"); imported next to the first-write capture as `<tag>-unwritten/`.
 */
export type FinalizeCaptureState = 'first-write' | 'unwritten'
export async function importFinalizeFixtures(
  sourceRoot: string,
  outputRoot = join(FIXTURES, 'rfc349-finalize'),
  captureState: FinalizeCaptureState = 'first-write',
): Promise<{ tag: string; bytes: number }[]> {
  const registry = readRegistry()
  const result: { tag: string; bytes: number }[] = []
  for (const tag of ['v0.19.2', 'v0.18.19']) {
    const release = registry.releases.find((entry) => entry.tag === tag)!
    const binary = release.binaries['macos-arm64']
    if (binary?.kind !== 'release-asset')
      throw new Error(`${tag}: official macOS binary provenance missing`)
    const destination = join(outputRoot, captureState === 'unwritten' ? `${tag}-unwritten` : tag)
    mkdirSync(destination, { recursive: true })
    const states = {} as FinalizeFixtureManifest['states']
    let operationId = ''
    let targetFingerprint = ''
    for (const state of ['before', 'after'] as const) {
      const source = join(sourceRoot, tag, state)
      const files: CaptureFile[] = []
      const omitted: CaptureFile[] = []
      const homeFiles = walk(join(source, 'home'))
      for (const path of homeFiles) {
        const name = relative(source, path).split(sep).join('/')
        const bytes = readFileSync(path)
        const info = { path: name, bytes: bytes.length, sha256: sha256(bytes) }
        if (name.includes('/chunks/') || name.includes('/source-backup/')) {
          omitted.push(info)
          continue
        }
        const target = join(destination, state, name)
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, bytes)
        files.push(info)
        if (/\/database-migrations\/dbm_[^/]+\/manifest\.json$/.test(name)) {
          const manifest = JSON.parse(bytes.toString()) as { payload: Row }
          const capturedOperation = String(manifest.payload.operationId)
          const capturedFingerprint = String((manifest.payload.target as Row).databaseFingerprint)
          if (operationId && capturedOperation !== operationId)
            throw new Error(`${tag}: before/after operation IDs differ`)
          if (targetFingerprint && capturedFingerprint !== targetFingerprint)
            throw new Error(`${tag}: before/after PostgreSQL target fingerprints differ`)
          operationId = capturedOperation
          targetFingerprint = capturedFingerprint
          const expected = state === 'before' ? 'accepting-writes' : 'finalized'
          if (manifest.payload.phase !== expected)
            throw new Error(`${tag}/${state}: phase must be ${expected}`)
          if (state === 'before' && manifest.payload.firstLiveWriteAt !== null)
            throw new Error(`${tag}: before manifest was already refreshed`)
          if (
            state === 'after' &&
            (captureState === 'unwritten'
              ? manifest.payload.firstLiveWriteAt !== null
              : typeof manifest.payload.firstLiveWriteAt !== 'number')
          )
            throw new Error(`${tag}: after firstLiveWriteAt does not match ${captureState}`)
        }
      }
      const dump = readFileSync(join(source, 'postgres.sql'))
      const compressed = gzipSync(dump, { level: 9 })
      const file = `${state}/postgres.sql.gz`
      writeFileSync(join(destination, file), compressed)
      states[state] = {
        files,
        omitted,
        postgres: {
          file,
          sourceSha256: sha256(dump),
          compressedSha256: sha256(compressed),
          sourceBytes: dump.length,
          compressedBytes: compressed.length,
        },
      }
    }
    if (!operationId) throw new Error(`${tag}: missing migration manifest`)
    const manifest: FinalizeFixtureManifest = {
      formatVersion: 1,
      tag,
      ...(captureState === 'unwritten' ? { state: 'unwritten' as const } : {}),
      binarySha256: binary.sha256,
      platform: 'macos-arm64',
      operationId,
      states,
    }
    writeJson(join(destination, 'capture.json'), manifest)
    const omittedRows = (['before', 'after'] as const).flatMap((state) =>
      states[state].omitted.map(
        (file) => `| ${state}/${file.path} | ${file.bytes} | ${file.sha256} |`,
      ),
    )
    const readme = [
      `# RFC-349 finalize equivalence capture: ${tag}`,
      '',
      `Captured on 2026-10-31 with the official GitHub Release macOS arm64 binary (SHA-256 \`${binary.sha256}\`). Imported by \`scripts/release-upgrade/record.ts import-finalize\`; no daemon or finalize command is run during import.`,
      '',
      `Original source: \`${resolve(sourceRoot, tag)}\`. Operation: \`${operationId}\`.`,
      '',
      captureState === 'unwritten'
        ? "`before/` is the old binary's one-click SQLite to PostgreSQL migration with no live PostgreSQL write at all: the manifest is `accepting-writes`, `firstLiveWriteAt` is null and the target has no first-write marker. `after/` is the same home and database after that binary's `db migration finalize`; `firstLiveWriteAt` stays null. The first-write capture of the same release is in the sibling directory without the `-unwritten` suffix."
        : "`before/` is the old binary's one-click SQLite to PostgreSQL migration, followed by its first live PostgreSQL write. The manifest is still `accepting-writes` and `firstLiveWriteAt` is null. `after/` is the same home and the same PostgreSQL database after that binary's `db migration finalize`. The pre-first-write state is captured separately in the `-unwritten` sibling directory.",
      '',
      "The PostgreSQL data difference is one `agent_workflow_meta.logical_copy_operations` row: `stage` changes from `activated` to `finalized`, with `updated_at`. The manifest advances to `finalized` and refreshes `firstLiveWriteAt`; `receipt.json` appears; the version-1 pointer's `manifestDigest` changes. PostgreSQL dump framing (including random restrict tokens) is not business data.",
      '',
      'Home files retain the raw captured bytes. `postgres.sql.gz` is deterministic gzip of the complete pg_dump of `agent_workflow` and `agent_workflow_meta`. `capture.json` records original and compressed digests. Do not pretty-print or path-replace these raw files: envelope digests and fingerprint bindings are evidence. The ordinary dataset recorder, in contrast, canonicalizes rows and replaces the recording home with `<AW_HOME>`.',
      '',
      'Environment-bound fields: absolute source-backup/chunk/content/worktree paths, runtime executable paths in config.json, PostgreSQL target fingerprint, SQLite source fingerprint, the `AW_PG_URL` connection binding, source/target generation IDs and operation ID. T4 must rebind a copy to its test environment and recompute dependent envelope digests, or compare normalized fields. Times (`firstLiveWriteAt`, checkpoints, metadata `updated_at`) and derived digests must be normalized by explicit equivalence rules, not ignored wholesale. Do not restore these fixtures directly into an unrelated production database.',
      '',
      'Omission decision: both current `packages/backend/src/modules/system-operations/application/databaseMigrationRunner.ts` (`status`, `finalize`, `refreshPointer`) and the v0.19.2 version (`status` 711-729, `finalize` 777-817, pointer refresh 341-375) read the manifest and live target metadata, write the final receipt, mark finalized, advance the manifest, and refresh the pointer. Neither finalize path reads `chunks/` or `source-backup/`. Their referenced digests remain in the retained manifests. Logical manifest, verification and legacy-archive manifest are retained. The omitted bytes are NOT a full migration/replay fixture.',
      '',
      '| Omitted original file | Bytes | SHA-256 |',
      '| --- | ---: | --- |',
      ...omittedRows,
      '',
    ].join('\n')
    writeFileSync(join(destination, 'README.md'), await format(readme, { parser: 'markdown' }))
    const bytes = walk(destination).reduce((total, path) => total + statSync(path).size, 0)
    if (bytes > 1_000_000) throw new Error(`${tag} fixture exceeds 1 MB: ${bytes}`)
    result.push({ tag, bytes })
  }
  return result
}

if (import.meta.main) {
  const [mode, ...args] = process.argv.slice(2)
  const { values } = parseArgs({
    args,
    options: {
      source: { type: 'string' },
      state: { type: 'string' },
      home: { type: 'string' },
      output: { type: 'string' },
      tag: { type: 'string' },
      provider: { type: 'string', default: 'sqlite' },
      'url-env': { type: 'string' },
    },
  })
  if (mode === 'import-finalize') {
    if (!values.source) throw new Error('import-finalize requires --source')
    if (values.state !== undefined && !['first-write', 'unwritten'].includes(values.state))
      throw new Error('--state must be first-write or unwritten')
    console.log(
      JSON.stringify(
        await importFinalizeFixtures(
          values.source,
          values.output,
          (values.state as FinalizeCaptureState | undefined) ?? 'first-write',
        ),
        null,
        2,
      ),
    )
  } else if (mode === 'dataset') {
    if (
      !values.home ||
      !values.output ||
      !values.tag ||
      !['sqlite', 'postgresql'].includes(values.provider!)
    )
      throw new Error(
        'dataset requires --home --output --tag [--provider sqlite|postgresql --url-env NAME]',
      )
    const dataset = await recordDataset({
      home: values.home,
      output: values.output,
      tag: values.tag,
      provider: values.provider as 'sqlite' | 'postgresql',
      postgresqlUrl: values['url-env'] ? process.env[values['url-env']] : undefined,
    })
    console.log(
      `${dataset.tag}: ${dataset.tables.length} tables and ${dataset.content.length} content files`,
    )
  } else throw new Error('Usage: record.ts dataset|import-finalize [options]')
}
