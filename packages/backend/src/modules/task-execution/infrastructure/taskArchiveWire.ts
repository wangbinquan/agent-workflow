import { z } from 'zod'
import {
  TASK_ARCHIVE_V3_TABLES,
  type TaskArchiveV2Table,
  type TaskArchiveV2Reader,
  type TaskArchiveSource,
  type TaskArchiveReadView,
  type TaskArchiveV2Manifest,
  type TaskArchiveV3Manifest,
  type TaskArchiveLegacyRow,
} from '@/platform/contracts/taskArchive'
import { createSha256DigestBuilder, sha256Hex } from '@/util/hash'

export function encodeTaskArchiveValue(value: unknown): unknown {
  if (value instanceof Uint8Array)
    return { codec: 'bytes@1', base64: Buffer.from(value).toString('base64') }
  if (typeof value === 'bigint') return { codec: 'bigint@1', decimal: String(value) }
  if (Array.isArray(value)) return value.map(encodeTaskArchiveValue)
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, encodeTaskArchiveValue(item)]),
    )
  return value
}
export function decodeTaskArchiveValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeTaskArchiveValue)
  if (value === null || typeof value !== 'object') return value
  const row = value as Record<string, unknown>
  if (row.codec === 'bytes@1') {
    const { base64 } = z
      .strictObject({ codec: z.literal('bytes@1'), base64: z.string() })
      .parse(row)
    const bytes = Buffer.from(base64, 'base64')
    if (bytes.toString('base64') !== base64) throw new Error('task-archive-bytes-invalid')
    return Uint8Array.from(bytes)
  }
  if (row.codec === 'bigint@1') {
    const { decimal } = z
      .strictObject({
        codec: z.literal('bigint@1'),
        decimal: z.string().regex(/^-?(0|[1-9][0-9]*)$/),
      })
      .parse(row)
    return BigInt(decimal)
  }
  return Object.fromEntries(
    Object.entries(row).map(([key, item]) => [key, decodeTaskArchiveValue(item)]),
  )
}
const manifestSchema = z.object({
  schemaVersion: z.union([z.literal(2), z.literal(3)]),
  rootTaskId: z.string(),
  taskIds: z.array(z.string()),
  exportedAt: z.string(),
  rows: z.record(z.string(), z.number().int().nonnegative()),
  terminalMaintenance: z.object({
    claim: z.record(z.string(), z.json()),
    members: z.array(z.record(z.string(), z.json())),
  }),
  digest: z.string(),
})
export function taskArchiveManifestDigest(
  manifest: Omit<TaskArchiveV2Manifest | TaskArchiveV3Manifest, 'digest'>,
): string {
  const common = {
    rootTaskId: manifest.rootTaskId,
    taskIds: manifest.taskIds,
    rows: manifest.rows,
    maintenanceClaimId: manifest.terminalMaintenance.claim.id,
    memberSetDigest: manifest.terminalMaintenance.claim.memberSetDigest,
  }
  return sha256Hex(
    JSON.stringify(
      manifest.schemaVersion === 2
        ? common
        : {
            schemaVersion: 3,
            ...common,
            exportedAt: manifest.exportedAt,
            sections: (manifest as TaskArchiveV3Manifest).sections,
            tableDigests: (manifest as TaskArchiveV3Manifest).tableDigests,
            terminalMaintenance: manifest.terminalMaintenance,
          },
    ),
  )
}
export const taskArchiveV3Sections = () => ({
  task: { owner: 'T' as const, tables: Object.keys(TASK_ARCHIVE_V3_TABLES.task) },
  nodeRuns: { owner: 'N' as const, tables: Object.keys(TASK_ARCHIVE_V3_TABLES.nodeRuns) },
  collaboration: {
    owner: 'C' as const,
    tables: [...Object.keys(TASK_ARCHIVE_V3_TABLES.collaboration), 'clarify_disposition_evidence'],
  },
})

/** Both versions are read-only history. Restoring v2 business rows uses the epoch converter. */
export async function readTaskArchive(source: TaskArchiveSource): Promise<TaskArchiveReadView> {
  const value: unknown = JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(await source.readManifest()),
  )
  const base = manifestSchema.parse(value)
  let manifest: TaskArchiveV2Manifest | TaskArchiveV3Manifest
  if (base.schemaVersion === 3) {
    const extension = z
      .object({
        sections: z.strictObject({
          task: z.object({ owner: z.literal('T'), tables: z.array(z.string()) }),
          nodeRuns: z.object({ owner: z.literal('N'), tables: z.array(z.string()) }),
          collaboration: z.object({ owner: z.literal('C'), tables: z.array(z.string()) }),
        }),
        tableDigests: z.record(z.string(), z.string()),
      })
      .parse(value)
    if (JSON.stringify(extension.sections) !== JSON.stringify(taskArchiveV3Sections()))
      throw new Error('task-archive-section-roster-mismatch')
    manifest = { ...base, ...extension, schemaVersion: 3 }
  } else {
    manifest = { ...base, schemaVersion: 2, rows: base.rows as TaskArchiveV2Manifest['rows'] }
  }
  if (taskArchiveManifestDigest(manifest) !== manifest.digest)
    throw new Error('task-archive-manifest-digest-mismatch')
  const tables =
    manifest.schemaVersion === 2
      ? Object.keys(manifest.rows).filter((name) => name !== 'runs_dirs' && name !== 'logs_dirs')
      : Object.values(manifest.sections).flatMap((section) => section.tables)
  for (const name of tables)
    if (!Object.hasOwn(manifest.rows, name)) throw new Error(`task-archive-table-missing:${name}`)
  async function* rows(table: string): AsyncIterable<Readonly<Record<string, unknown>>> {
    if (manifest.schemaVersion === 2 && !Object.hasOwn(manifest.rows, table)) return
    if (!tables.includes(table)) throw new Error(`task-archive-table-unknown:${table}`)
    const decoder = new TextDecoder('utf-8', { fatal: true })
    const hash = createSha256DigestBuilder()
    let pending = '',
      count = 0
    const row = (line: string) => {
      const parsed = z.record(z.string(), z.unknown()).parse(JSON.parse(line))
      count += 1
      return (manifest.schemaVersion === 3 ? decodeTaskArchiveValue(parsed) : parsed) as Readonly<
        Record<string, unknown>
      >
    }
    for await (const bytes of source.readTable(table)) {
      hash.update(bytes)
      pending += decoder.decode(bytes, { stream: true })
      let newline: number
      while ((newline = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, newline)
        pending = pending.slice(newline + 1)
        if (line.length) yield row(line)
      }
    }
    pending += decoder.decode()
    if (pending.length) yield row(pending)
    if (count !== base.rows[table]) throw new Error(`task-archive-row-count-mismatch:${table}`)
    if (manifest.schemaVersion === 3 && hash.digestHex() !== manifest.tableDigests[table])
      throw new Error(`task-archive-table-digest-mismatch:${table}`)
  }
  // Validate before exposing the archive; rows() also validates each later read.
  for (const table of tables) for await (const row of rows(table)) void row
  return { manifest, rows }
}
export function createTaskArchiveV2Reader(): TaskArchiveV2Reader {
  return {
    async read(source) {
      const view = await readTaskArchive({
        readManifest: () => source.readManifest(),
        readTable: (table) => source.readTable(table as TaskArchiveV2Table),
      })
      if (view.manifest.schemaVersion !== 2) throw new Error('task-archive-v2-required')
      return {
        manifest: view.manifest,
        rows: (table) => view.rows(table) as AsyncIterable<TaskArchiveLegacyRow>,
      }
    },
  }
}
