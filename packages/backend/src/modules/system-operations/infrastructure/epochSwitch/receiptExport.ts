import { link, mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { canonicalSchemaJson } from '@/platform/persistence/schema/canonical'
import { bytesDigest } from '@/platform/persistence/migration/conversion/digest'
import type {
  ConversionTargetConnection,
  MigrationReceiptBundle,
  ReceiptExport,
} from '@/platform/persistence/migration/run/types'
import { collectMigrationRows, type MigrationMetaStore } from './metaStore'
import { syncEpochDirectory } from './fileJournal'

export interface MigrationReceiptFiles {
  readonly format: 'migration-receipt-export@1'
  readonly files: Readonly<
    Record<'receipt.json' | 'dispositions.ndjson' | 'artifacts.ndjson' | 'units.ndjson', string>
  >
}
async function writeOnce(path: string, bytes: Uint8Array): Promise<void> {
  const temporary = `${path}.${crypto.randomUUID()}.tmp`
  const handle = await open(temporary, 'wx')
  try {
    try {
      await handle.writeFile(bytes)
      await handle.sync()
    } finally {
      await handle.close()
    }
    try {
      await link(temporary, path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const previous = await readFile(path)
      const expected = Buffer.from(bytes)
      if (!previous.equals(expected)) {
        // Recover only a torn prefix from the former direct-to-final writer.
        if (
          previous.length >= expected.length ||
          !previous.equals(expected.subarray(0, previous.length))
        )
          throw new Error(`v3-receipt-export-conflict: ${path}`)
        await rename(temporary, path)
      }
    }
    syncEpochDirectory(dirname(path))
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
    })
  }
}
export async function exportMigrationReceipts(input: {
  target: ConversionTargetConnection
  meta: MigrationMetaStore
  runId: string
  operationRoot: string | null
}): Promise<ReceiptExport> {
  const run = await input.meta.migrationRun(input.runId)
  if (!run?.validation?.passed || !['validated', 'activated', 'retired'].includes(run.state))
    throw new Error('v3-receipt-export-before-validation')
  const existing = await input.meta.receiptExport(input.runId)
  let bytes: Uint8Array
  let document: MigrationReceiptFiles
  if (existing?.bytes && run.state !== 'validated') {
    bytes = existing.bytes
    document = JSON.parse(Buffer.from(bytes).toString('utf8')) as MigrationReceiptFiles
  } else {
    const units = await collectMigrationRows(input.meta.units(input.runId))
    const bundle: MigrationReceiptBundle = {
      version: 1,
      run: { ...run, receiptExportDigest: null },
      tableReceipts: await input.meta.tableReceipts(input.runId),
      identityHighWater: await input.meta.identityHighWater(input.runId),
      records: await collectMigrationRows(input.meta.records(input.runId)),
      restrictions: await input.meta.restrictions({ runId: input.runId }),
      units,
    }
    const ndjson = (rows: readonly unknown[]) =>
      rows
        .map((row) => JSON.stringify(JSON.parse(canonicalSchemaJson(row)) as unknown))
        .join('\n') + (rows.length ? '\n' : '')
    document = {
      format: 'migration-receipt-export@1',
      files: {
        'receipt.json': canonicalSchemaJson(bundle),
        'dispositions.ndjson': ndjson(
          await collectMigrationRows(input.meta.dispositions({ runId: input.runId })),
        ),
        'artifacts.ndjson': ndjson(
          await collectMigrationRows(input.meta.artifacts({ runId: input.runId })),
        ),
        'units.ndjson': ndjson(units),
      },
    }
    bytes = Buffer.from(canonicalSchemaJson(document))
  }
  const digest = bytesDigest(bytes)
  if (
    existing &&
    (existing.digest !== digest ||
      !existing.bytes ||
      !Buffer.from(existing.bytes).equals(Buffer.from(bytes)))
  )
    throw new Error('v3-receipt-export-conflict')
  const path =
    input.operationRoot === null ? null : join(input.operationRoot, 'runs', input.runId, 'receipts')
  if (path) {
    for (const directory of [dirname(dirname(path)), dirname(path), path]) {
      await mkdir(directory, { recursive: true })
      syncEpochDirectory(dirname(directory))
    }
    for (const [name, text] of Object.entries(document.files))
      await writeOnce(join(path, name), Buffer.from(text))
    await writeOnce(join(path, 'receipt.digest'), Buffer.from(`${digest}\n`))
  }
  await input.target.transaction((tx) =>
    input.meta.withConnection(tx).saveExport(input.runId, { digest, path, bytes }),
  )
  return { digest, path }
}
