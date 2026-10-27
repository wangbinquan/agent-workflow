// RFC-395 CIP-A: a pinned identity is constant work; distinct bindings still compare every field.
import { expect, test } from 'bun:test'
import { pinnedSnapshotReader } from '@/platform/persistence/migration/freeze/liveSnapshot'
import { makeSourceFingerprint } from '@/platform/persistence/migration/sourceCatalog'
import type {
  SourcePreflight,
  VersionedSourceReader,
} from '@/platform/persistence/migration/sourceTypes'

test('per-chunk checks avoid re-encoding the same pinned preflight and reject different binding bytes', async () => {
  let tableReads = 0
  const preflight: SourcePreflight = {
    version: 1,
    kind: 'postgresql-database',
    sourceVersion: 'fixture',
    contract: null,
    fingerprint: makeSourceFingerprint('postgresql', [], [], {}),
    sourceGenerationId: 'dbg_fixture',
    identityHighWater: [],
    identityEvidence: 'physical',
    watermark: 'unchanged',
    requiresOfflineUpgrade: false,
    get tables() {
      tableReads++
      return []
    },
    expectedAbsent: [],
    content: [],
  }
  let sourceChecks = 0
  let closes = 0
  const reader: VersionedSourceReader = {
    kind: preflight.kind,
    preflight: async () => preflight,
    assertUnchanged: async () => {
      sourceChecks++
    },
    readChunk: async () => {
      throw new Error('logical delegated')
    },
    readRawChunk: async () => {
      throw new Error('raw delegated')
    },
    close: async () => {
      closes++
    },
  }
  const pinned = pinnedSnapshotReader(reader, preflight)
  expect(await pinned.preflight()).toBe(preflight)
  for (let index = 0; index < 250; index++) await pinned.assertUnchanged(preflight)
  expect(tableReads).toBe(0)
  expect(sourceChecks).toBe(0)
  const copy = structuredClone(preflight)
  await pinned.assertUnchanged(copy)
  expect(tableReads).toBeGreaterThan(0)
  await expect(pinned.assertUnchanged({ ...copy, watermark: 'different' })).rejects.toThrow(
    'snapshot binding differs',
  )
  await expect(
    pinned.assertUnchanged({
      ...copy,
      fingerprint: { ...copy.fingerprint, tableRows: { altered: 1 } },
    }),
  ).rejects.toThrow('snapshot binding differs')
  await expect(pinned.readChunk('fixture', null, 1)).rejects.toThrow('logical delegated')
  await expect(pinned.readRawChunk('fixture', null, 1)).rejects.toThrow('raw delegated')
  await pinned.close()
  expect(closes).toBe(1)
})
