// RFC-395 V1: committed epoch-1 bytes survive changes to runtime schema/export paths.
import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { materializeGoldenLogical } from './helpers/rfc395V1Golden'
import { describeV1Providers } from './helpers/rfc395V1Harness'
import expected from './fixtures/rfc395-v1/expected.json'
import { openEpoch1SqliteSource } from '@/platform/persistence/migration/sqliteSourceReader'
import { openEpoch1LogicalArtifactSource } from '@/platform/persistence/migration/artifactSourceReader'
import { SourceBlockedError } from '@/platform/persistence/migration/sourceTypes'

describeV1Providers('RFC-395 V1 golden epoch-1 fixtures', (h) => {
  test('golden original logical artifact matches fixed preflight and unaligned chunk digests', async () => {
    const reader = openEpoch1LogicalArtifactSource({
      artifactRoot: materializeGoldenLogical(h.operationRoot),
      envelopeFileDigest: expected.logical.envelopeFileDigest,
    })
    try {
      const preflight = await reader.preflight()
      expect(preflight.fingerprint.digest).toBe(expected.logical.fingerprintDigest)
      expect(preflight.watermark).toBe(expected.logical.watermark)
      expect(preflight.sourceVersion).toBe(expected.logical.sourceVersion)
      expect(preflight.identityEvidence).toBe('not-recorded-by-epoch1-artifact')
      const chunk = await reader.readChunk('maintenance_state', null, 3)
      expect(chunk.sourceDigest).toBe(expected.logical.chunkDigest)
      expect(chunk.decodedRows[0]?.updated_at).toBe(9007199254740993n)
      expect(chunk.decodedRows[0]?.value).toBe('{ "golden" : true }\n')
    } finally {
      await reader.close()
    }
  }, 240_000)
  if (h.provider === 'sqlite')
    test('golden SQLite file is upgrade-only with fixed physical preflight and raw chunk digests', async () => {
      const reader = openEpoch1SqliteSource({
        path: join(import.meta.dir, 'fixtures/rfc395-v1/prefix-0000.sqlite'),
        operationRoot: h.operationRoot,
        manifest: await h.manifest(),
      })
      try {
        const preflight = await reader.preflight()
        expect(preflight.fingerprint.digest).toBe(expected.sqlite.fingerprintDigest)
        expect(preflight.watermark).toBe(expected.sqlite.watermark)
        expect(preflight.sourceVersion).toBe(expected.sqlite.sourceVersion)
        expect(preflight.sourceGenerationId).toBe(expected.sqlite.sourceGenerationId)
        expect(preflight.contract).toBeNull()
        expect((await reader.readRawChunk('recent_repos', null, 1)).sourceDigest).toBe(
          expected.sqlite.rawChunkDigest,
        )
        await expect(reader.readChunk('agents', null, 1)).rejects.toBeInstanceOf(SourceBlockedError)
      } finally {
        await reader.close()
      }
    }, 240_000)
})
