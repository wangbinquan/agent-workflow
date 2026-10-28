// RFC-395 T19 (CrewStation RFC-044 T9 acceptance, 2026-10-28): the first hosted plan on CrewStation
// failed with "迁移回调请求超过 32 MiB". The epoch-1 PostgreSQL reference catalogs are about 37 MiB and
// were written as one by-name document, while CrewStation accepts at most 32 MiB of base64 JSON per
// callback. They now live in the chunked artifact port behind a small by-name pointer.
import { expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createHostedReferenceCache,
  createMetaEpochSwitchJournal,
  type HostedEpochArtifacts,
} from '@/modules/system-operations/infrastructure/epochSwitch/metaJournal'
import { bytesDigest } from '@/platform/persistence/migration/conversion/digest'
import type { ConversionTargetConnection } from '@/platform/persistence/migration/run/types'

const PLATFORM_REQUEST_LIMIT = 32 * 1024 * 1024
const CHUNK_BYTES = 4 * 1024 * 1024
const OPERATION = 'dbm_e2_reference_cache'
const NAME = `source-catalogs/${'a'.repeat(64)}-pg17.json`

/** The CrewStation artifact callback: write-once by name, one JSON request body of at most 32 MiB. */
function platformStore() {
  const stored = new Map<string, Buffer>()
  const store: HostedEpochArtifacts = {
    async writeOnce(operationId, name, bytes) {
      const digest = bytesDigest(bytes)
      const body = JSON.stringify({
        operationId,
        name,
        digest,
        bytes: Buffer.from(bytes).toString('base64'),
        requestKey: `${operationId}:${name}:${digest}`,
      })
      if (Buffer.byteLength(body) > PLATFORM_REQUEST_LIMIT)
        throw new Error('迁移回调请求超过 32 MiB')
      const previous = stored.get(name)
      if (previous && bytesDigest(previous) !== digest) throw new Error('write-once-conflict')
      stored.set(name, Buffer.from(bytes))
      return { path: name, digest }
    },
    async read(_operationId, name) {
      return stored.get(name) ?? null
    },
  }
  return { store, stored }
}

/**
 * One Job's view of the real hosted journal: its own scratch root over the shared platform store.
 * Documents and materialised artifacts share that root, so a name collision there is caught too.
 * Artifact reads and writes never touch the journal's database connection.
 */
function jobCache(store: HostedEpochArtifacts, scratchRoot: string) {
  const journal = createMetaEpochSwitchJournal({
    connection: { provider: 'postgresql' } as unknown as ConversionTargetConnection,
    artifacts: store,
    scratchRoot,
    acquireOperationLock: async () => ({ release() {} }),
  })
  return createHostedReferenceCache(journal, OPERATION)
}

test('reference data above one platform request is chunked behind a small pointer and survives a new Job', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'aw-rfc395-reference-cache-'))
  try {
    const { store, stored } = platformStore()
    const bytes = randomBytes(37 * 1024 * 1024)
    // The previous wiring wrote the whole document in one request.
    await expect(store.writeOnce(OPERATION, 'direct', bytes)).rejects.toThrow('32 MiB')

    const first = jobCache(store, join(scratch, 'job-one'))
    expect(await first.read(NAME)).toBeNull()
    await first.writeOnce(NAME, bytes)

    const pointer = stored.get(NAME)!
    expect(pointer.byteLength).toBeLessThan(256)
    expect(JSON.parse(pointer.toString('utf8'))).toEqual({ version: 1, digest: bytesDigest(bytes) })
    const chunks = [...stored.keys()].filter(
      (name) => name.startsWith(`.artifacts/${NAME}.content/`) && !name.endsWith('/manifest.json'),
    )
    expect(chunks.length).toBeGreaterThanOrEqual(Math.ceil(bytes.byteLength / CHUNK_BYTES))
    for (const value of stored.values()) expect(value.byteLength).toBeLessThanOrEqual(CHUNK_BYTES)

    const second = jobCache(store, join(scratch, 'job-two'))
    expect(Buffer.compare(Buffer.from((await second.read(NAME))!), bytes)).toBe(0)
    // Write-once: the same bytes again are a no-op, different bytes under the name are refused.
    await second.writeOnce(NAME, bytes)
    await expect(second.writeOnce(NAME, randomBytes(1024))).rejects.toThrow('write-once-conflict')
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('a damaged pointer is refused instead of being read as reference data', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'aw-rfc395-reference-cache-'))
  try {
    const { store, stored } = platformStore()
    stored.set(NAME, Buffer.from(JSON.stringify({ version: 1 })))
    await expect(jobCache(store, scratch).read(NAME)).rejects.toThrow('v3-artifact-digest-mismatch')
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})
