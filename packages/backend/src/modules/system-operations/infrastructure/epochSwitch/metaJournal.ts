import { createReadStream } from 'node:fs'
import { bytesDigest } from '@/platform/persistence/migration/conversion/digest'
import { createLocalEpochArtifacts, writeEpochFile } from './fileJournal'
import { join } from 'node:path'
import type {
  ConversionTargetConnection,
  EpochSwitchArtifactPort,
  ReceiptExport,
} from '@/platform/persistence/migration/run/types'
import { metaTableName } from '@/platform/persistence/schema/history/meta'
import { parameters } from '@/platform/persistence/schema/history/connection'
import type { EpochSwitchJournalPort } from '../../application/ports/epochSwitch'
import {
  EpochSwitchError,
  parseEpochSwitchJournal,
  type EpochSwitchJournal,
} from '../../domain/epochSwitch/model'
import { assertJournalSuccessor } from '../../domain/epochSwitch/transitions'

/** Hosted artifacts outlive a Job's scratch directory; equal-byte/write-once semantics are required. */
export interface HostedEpochArtifacts {
  writeOnce(operationId: string, name: string, bytes: Uint8Array): Promise<ReceiptExport>
  read(operationId: string, name: string): Promise<Uint8Array | null>
}

export function createMetaEpochSwitchJournal(input: {
  connection: ConversionTargetConnection
  artifacts: HostedEpochArtifacts
  scratchRoot: string
  acquireOperationLock(operationId: string): Promise<{ release(): void | Promise<void> }>
}): EpochSwitchJournalPort {
  const c = input.connection
  const table = metaTableName(c.provider, 'migration_operations')
  const marks = (n: number) => parameters(c, n).split(', ')
  const read = async (op: string) => {
    const rows = await c.execute(
      `SELECT payload_json FROM ${table} WHERE operation_id = ${marks(1)[0]}`,
      [op],
    )
    return rows[0] ? parseEpochSwitchJournal(String(rows[0].payload_json)) : null
  }
  return {
    operationRoot: (op) => join(input.scratchRoot, op),
    read,
    async list() {
      const rows = await c.execute(
        `SELECT payload_json FROM ${table} ORDER BY updated_at, operation_id`,
      )
      return rows.map((row) => parseEpochSwitchJournal(String(row.payload_json)))
    },
    async create(journal) {
      const j = parseEpochSwitchJournal(JSON.stringify(journal))
      if (j.payload.revision !== 0 || j.payload.previousDigest !== null)
        throw new EpochSwitchError('v3-initial-journal-revision')
      const p = j.payload
      await c.execute(
        `INSERT INTO ${table} (operation_id, revision, phase, status, payload_json, digest, previous_digest, updated_at) VALUES (${parameters(c, 8)})`,
        [
          p.operationId,
          p.revision,
          p.phase,
          p.status,
          JSON.stringify(j),
          j.digest,
          p.previousDigest,
          p.updatedAt,
        ],
      )
      return j
    },
    async compareAndSwap(expected, next) {
      return c.transaction(async (tx) => {
        const m = marks(10)
        const rows = await tx.execute(
          `SELECT payload_json FROM ${table} WHERE operation_id = ${m[0]}`,
          [expected.operationId],
        )
        const current: EpochSwitchJournal | null = rows[0]
          ? parseEpochSwitchJournal(String(rows[0].payload_json))
          : null
        if (
          !current ||
          current.payload.revision !== expected.revision ||
          current.digest !== expected.digest
        )
          throw new EpochSwitchError('v3-journal-stale-revision-or-owner', {
            category: 'owner-conflict',
          })
        assertJournalSuccessor(current, next)
        const p = next.payload
        const result = await tx.execute(
          `UPDATE ${table} SET revision = ${m[0]}, phase = ${m[1]}, status = ${m[2]}, payload_json = ${m[3]}, digest = ${m[4]}, previous_digest = ${m[5]}, updated_at = ${m[6]} WHERE operation_id = ${m[7]} AND revision = ${m[8]} AND digest = ${m[9]} RETURNING operation_id`,
          [
            p.revision,
            p.phase,
            p.status,
            JSON.stringify(next),
            next.digest,
            p.previousDigest,
            p.updatedAt,
            expected.operationId,
            expected.revision,
            expected.digest,
          ],
        )
        if (result.length !== 1)
          throw new EpochSwitchError('v3-journal-stale-revision-or-owner', {
            category: 'owner-conflict',
          })
        return next
      })
    },
    artifacts: (op) =>
      createHostedEpochArtifactPort({
        store: input.artifacts,
        operationId: op,
        root: join(input.scratchRoot, op),
      }),
    async writeOnce(op, name, bytes) {
      const receipt = await input.artifacts.writeOnce(op, name, bytes)
      if (receipt.digest !== bytesDigest(bytes))
        throw new EpochSwitchError('v3-artifact-digest-mismatch')
      const path = join(input.scratchRoot, op, name)
      writeEpochFile(path, bytes, true)
      return { path, digest: receipt.digest }
    },
    async readArtifact(op, name) {
      const bytes = await input.artifacts.read(op, name)
      if (bytes) writeEpochFile(join(input.scratchRoot, op, name), bytes, true)
      return bytes
    },
    lockOperation: input.acquireOperationLock,
  }
}

/** Large evidence uses bounded chunks over the same durable platform store as documents. */
export function createHostedEpochArtifactPort(input: {
  store: HostedEpochArtifacts
  operationId: string
  root: string
}): EpochSwitchArtifactPort {
  const local = createLocalEpochArtifacts(input.root)
  const key = (name: string, digest: string) => `.artifacts/${name}/${digest.slice(7)}`
  return {
    async put(name, bytes) {
      const digest = await local.put(name, bytes)
      const path = await local.get(name, digest)
      const chunks: { name: string; digest: string }[] = []
      for await (const chunk of createReadStream(path, { highWaterMark: 4 * 1024 * 1024 })) {
        const bytes = Buffer.from(chunk)
        const chunkDigest = bytesDigest(bytes)
        const chunkName = `${key(name, digest)}/${chunks.length}`
        const receipt = await input.store.writeOnce(input.operationId, chunkName, bytes)
        if (receipt.digest !== chunkDigest)
          throw new EpochSwitchError('v3-artifact-digest-mismatch')
        chunks.push({ name: chunkName, digest: chunkDigest })
      }
      await input.store.writeOnce(
        input.operationId,
        `${key(name, digest)}/manifest.json`,
        Buffer.from(JSON.stringify({ name, digest, chunks })),
      )
      return digest
    },
    async get(name, digest) {
      const bytes = await input.store.read(input.operationId, `${key(name, digest)}/manifest.json`)
      if (!bytes)
        throw new EpochSwitchError('v3-artifact-missing', { category: 'receipt-conflict' })
      const manifest = JSON.parse(Buffer.from(bytes).toString('utf8')) as {
        name: string
        digest: string
        chunks: { name: string; digest: string }[]
      }
      if (manifest.name !== name || manifest.digest !== digest)
        throw new EpochSwitchError('v3-artifact-digest-mismatch')
      async function* stream() {
        for (const chunk of manifest.chunks) {
          const bytes = await input.store.read(input.operationId, chunk.name)
          if (!bytes || bytesDigest(bytes) !== chunk.digest)
            throw new EpochSwitchError('v3-artifact-digest-mismatch')
          yield bytes
        }
      }
      if ((await local.put(name, stream())) !== digest)
        throw new EpochSwitchError('v3-artifact-digest-mismatch')
      return local.get(name, digest)
    },
  }
}
