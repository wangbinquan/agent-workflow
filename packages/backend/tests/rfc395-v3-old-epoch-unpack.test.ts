// RFC-395 V3-F: unpack retains portable assets and detects the actual epoch-1 envelope.
import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync, cpSync } from 'node:fs'
import { join } from 'node:path'
import { describeV1Providers } from './helpers/rfc395V1Harness'
import { tarGz } from '@/util/archive'
import {
  unpackOldEpochBackup,
  detectOldEpochBackup,
  materializeOldEpochBackup,
} from '@/platform/persistence/migration/freeze/oldEpochBackup'
import { createLocalEpochArtifacts as createLocalSourceArtifacts } from '@/modules/system-operations/infrastructure/epochSwitch/fileJournal'
import { atomicSourceFile } from '@/platform/persistence/migration/freeze/artifacts'
import type { EpochSwitchArtifactPort } from '@/platform/persistence/migration/run/types'
import { openFrozenSource } from '@/platform/persistence/migration/freeze/sourceAccess'

describeV1Providers('RFC-395 V3 old epoch unpack', (h) => {
  test('tar and directory have equal extracted digest, retain skills/config, and reopen as portable sources', async () => {
    const version = await h.install()
    await h.seed()
    const backup = await h.backup(version)
    try {
      rmSync(join(backup.root, 'hosted-backup.json'))
      mkdirSync(join(backup.root, 'skills/id/files'), { recursive: true })
      writeFileSync(join(backup.root, 'skills/id/files/SKILL.md'), 'preserved')
      writeFileSync(join(backup.root, 'config.json'), '{"kept":true}')
      const artifact = join(h.operationRoot, 'portable.tar.gz')
      await tarGz(backup.root, artifact)
      const destination = join(h.operationRoot, 'unpacked')
      const direct = await unpackOldEpochBackup({ artifact: backup.root, destination })
      const tar = await unpackOldEpochBackup({ artifact, destination })
      expect(tar.digest).toBe(direct.digest)
      expect(tar.sourceKind).toBe(h.provider === 'sqlite' ? 'sqlite-backup' : 'logical-backup')
      expect(existsSync(join(tar.root, 'skills/id/files/SKILL.md'))).toBe(true)
      expect(existsSync(join(tar.root, 'config.json'))).toBe(true)
      expect(existsSync(join(tar.root, 'runs'))).toBe(false)
      const source = await openFrozenSource({
        location: { kind: 'backup', ...tar, artifact },
        manifest: await h.manifest(),
        emptyTables: [],
        operationRoot: join(h.operationRoot, 'opened'),
      })
      try {
        expect(source.watermark).toBe(tar.digest)
      } finally {
        await source.close()
      }
      const logical = await unpackOldEpochBackup({ artifact: backup.artifactRoot, destination })
      expect(logical.sourceKind).toBe('logical-artifact')
    } finally {
      backup.close()
    }
  }, 300_000)
  test('single-wrapper directory compares the outer tree before selecting its inner backup root', async () => {
    const backup = await h.backup(await h.install())
    try {
      const wrapper = join(h.operationRoot, 'wrapper')
      mkdirSync(wrapper)
      cpSync(backup.root, join(wrapper, 'only'), { recursive: true })
      const direct = await unpackOldEpochBackup({
        artifact: backup.root,
        destination: join(h.operationRoot, 'unpacked'),
      })
      const wrapped = await unpackOldEpochBackup({
        artifact: wrapper,
        destination: join(h.operationRoot, 'unpacked'),
      })
      expect(wrapped.digest).toBe(direct.digest)
      expect(wrapped.sourceKind).toBe(direct.sourceKind)
    } finally {
      backup.close()
    }
  }, 300_000)
  test('unpacked backups outlive the original Job and incomplete extraction directories are reclaimed', async () => {
    const backup = await h.backup(await h.install())
    const durable = createLocalSourceArtifacts(join(h.operationRoot, 'durable'))
    const references = new Map<string, string>()
    const job1 = join(h.operationRoot, 'job1'),
      job2 = join(h.operationRoot, 'job2')
    const port = (root: string): EpochSwitchArtifactPort => ({
      async put(name, bytes) {
        const digest = await durable.put(name, bytes)
        references.set(name, digest)
        return digest
      },
      async get(name, digest) {
        const path = await durable.get(name, digest)
        const local = join(root, name)
        await atomicSourceFile(local, readFileSync(path))
        return local
      },
    })
    try {
      mkdirSync(join(job1, 'old-epoch-crashed'), { recursive: true })
      writeFileSync(join(job1, 'old-epoch-crashed.pending'), '')
      const original = await unpackOldEpochBackup({
        artifact: backup.root,
        destination: job1,
        artifacts: port(job1),
      })
      expect(existsSync(join(job1, 'old-epoch-crashed'))).toBe(false)
      rmSync(job1, { recursive: true, force: true })
      const fresh = port(job2)
      for (const [name, digest] of [...references]) await fresh.get(name, digest)
      const restored = await materializeOldEpochBackup({
        digest: original.digest,
        artifacts: fresh,
      })
      expect(restored.root.startsWith(job2)).toBe(true)
      expect(restored.sourceKind).toBe(original.sourceKind)
      expect(restored.digest).toBe(original.digest)
    } finally {
      backup.close()
    }
  }, 300_000)
  test('hosted archives are detected from their header; unsupported and incomplete formats are rejected', async () => {
    const backup = await h.backup(await h.install())
    try {
      const artifact = join(h.operationRoot, 'hosted.tar.gz')
      await tarGz(backup.root, artifact)
      const unpacked = await unpackOldEpochBackup({
        artifact,
        destination: join(h.operationRoot, 'hosted-unpacked'),
      })
      expect(unpacked.sourceKind).toBe('hosted-backup')
      writeFileSync(join(backup.root, 'hosted-backup.json'), '{"format":"unknown"}')
      expect(() => detectOldEpochBackup(backup.root)).toThrow('old-epoch-hosted-format-unsupported')
      const empty = join(h.operationRoot, 'empty-backup')
      mkdirSync(empty)
      expect(() => detectOldEpochBackup(empty)).toThrow('old-epoch-backup-unrecognized')
    } finally {
      backup.close()
    }
  }, 300_000)
})
