// RFC-395 V1: failure contracts are typed and do not provision or read an unsupported source.
import { expect, test } from 'bun:test'
import { cpSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { materializeGoldenLogical } from './helpers/rfc395V1Golden'
import { describeV1Providers } from './helpers/rfc395V1Harness'
import {
  openEpoch1HostedBackupSource,
  openEpoch1LogicalArtifactSource,
} from '@/platform/persistence/migration/artifactSourceReader'
import { openEpoch1SqliteBackupSource } from '@/platform/persistence/migration/sqliteSourceReader'
import { upgradeEpoch1Copy } from '@/platform/persistence/migration/offlineSourceUpgrade'
import {
  SourceBlockedError,
  type VersionedSourceReader,
} from '@/platform/persistence/migration/sourceTypes'
import { canonicalSchemaJson, digestSchemaContract } from '@/platform/persistence/schema/canonical'
import { logicalArtifactFileDigest } from '@/platform/persistence/migration/legacy/logicalDatabaseArtifact'
import expected from './fixtures/rfc395-v1/expected.json'

describeV1Providers('RFC-395 V1 typed source rejections', (h) => {
  test('manifest-v2 and hosted sidecar mismatches reject before conversion', async () => {
    const version = await h.install()
    const backup = await h.backup(version)
    try {
      const manifestPath = join(backup.root, 'manifest.json')
      const original = readFileSync(manifestPath, 'utf8')
      const manifest = JSON.parse(original)
      manifest.database.provider = 'unsupported'
      writeFileSync(manifestPath, JSON.stringify(manifest))
      const reader =
        h.provider === 'sqlite'
          ? openEpoch1SqliteBackupSource({
              backupRoot: backup.root,
              manifest: await h.manifest(),
              operationRoot: h.operationRoot,
            })
          : openEpoch1HostedBackupSource({
              backupRoot: backup.root,
              supportedSources: await h.manifest(),
            })
      try {
        await expect(reader.preflight()).rejects.toBeInstanceOf(SourceBlockedError)
      } finally {
        await reader.close()
      }
      writeFileSync(manifestPath, original)
      const sidecar = join(backup.root, 'hosted-backup.json')
      const value = JSON.parse(readFileSync(sidecar, 'utf8'))
      value.sourceGenerationId = 'dbg_wrong_generation_fixture'
      writeFileSync(sidecar, JSON.stringify(value))
      const hosted = openEpoch1HostedBackupSource({
        backupRoot: backup.root,
        supportedSources: await h.manifest(),
      })
      try {
        await expect(hosted.preflight()).rejects.toBeInstanceOf(SourceBlockedError)
      } finally {
        await hosted.close()
      }
    } finally {
      backup.close()
    }
  }, 240_000)
  test('unsupported logical contract and missing original PostgreSQL version are typed failures', async () => {
    const artifactRoot = join(h.operationRoot, 'unsupported-contract')
    cpSync(materializeGoldenLogical(h.operationRoot), artifactRoot, { recursive: true })
    const path = join(artifactRoot, 'logical-backup.json')
    const envelope = JSON.parse(readFileSync(path, 'utf8'))
    envelope.payload.schemaDigest = `sha256:${'0'.repeat(64)}`
    envelope.digest = digestSchemaContract(envelope.payload)
    writeFileSync(path, canonicalSchemaJson(envelope))
    const unknown = openEpoch1LogicalArtifactSource({
      artifactRoot,
      envelopeFileDigest: logicalArtifactFileDigest(path),
    })
    try {
      await expect(unknown.preflight()).rejects.toBeInstanceOf(SourceBlockedError)
    } finally {
      await unknown.close()
    }
    const source = openEpoch1LogicalArtifactSource({
      artifactRoot: materializeGoldenLogical(h.operationRoot),
      envelopeFileDigest: expected.logical.envelopeFileDigest,
    })
    const preflight = await source.preflight()
    const unsupported: VersionedSourceReader = {
      ...source,
      async preflight() {
        return { ...preflight, contract: null }
      },
    }
    let provisioned = false
    try {
      await expect(
        upgradeEpoch1Copy({
          source: unsupported,
          manifest: await h.manifest(),
          operationRoot: h.operationRoot,
          async createEmptyDatabase() {
            provisioned = true
            throw new Error('must not provision')
          },
        }),
      ).rejects.toBeInstanceOf(SourceBlockedError)
      expect(provisioned).toBe(false)
    } finally {
      await source.close()
    }
  }, 240_000)
})
