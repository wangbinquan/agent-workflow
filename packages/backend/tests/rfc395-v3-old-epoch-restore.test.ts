import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createEpochSwitchApplication } from '@/modules/system-operations/application/epochSwitch/application'
import { createEpochRestoreFiles } from '@/modules/system-operations/infrastructure/epochSwitch/restoreFiles'
import {
  writeGenerationPointerV2,
  parseGenerationPointerV2,
} from '@/platform/persistence/generationPointerV2'
import { makeSwitchFixture, fixtureDigest } from './helpers/rfc395V3SwitchFixture'

for (const sourceKind of ['sqlite-backup', 'logical-backup', 'hosted-backup'] as const)
  test(`${sourceKind} becomes a restored generation with the current v2 pointer as predecessor`, async () => {
    const f = makeSwitchFixture()
    try {
      const backup = join(f.root, 'fixture-backup')
      mkdirSync(join(backup, 'skills'), { recursive: true })
      writeFileSync(join(backup, 'skills/skill.md'), 'backup skill')
      writeFileSync(join(backup, 'config.json'), '{"backup":true}')
      mkdirSync(join(f.root, 'skills'), { recursive: true })
      writeFileSync(join(f.root, 'skills/skill.md'), 'installed skill')
      writeFileSync(join(f.root, 'config.json'), '{"installed":true}')
      writeGenerationPointerV2({
        pointerPath: f.pointerPath,
        payload: {
          version: 2,
          schemaEpoch: 2,
          generationId: 'dbg_previously_installed',
          provider: 'sqlite',
          role: 'installed',
          database: {
            kind: 'sqlite-file',
            relativePath: 'databases/dbg_previously_installed/db.sqlite',
          },
          contractDigest: fixtureDigest,
          planDigest: fixtureDigest,
          operationId: null,
          manifestDigest: null,
          activatedAt: 1,
          previous: null,
        },
      })
      const original = readFileSync(f.pointerPath)
      f.deps.unpackBackup = async () => ({ sourceKind, root: backup, digest: fixtureDigest })
      const backupPort = f.deps.backup
      f.deps.backup = {
        ...backupPort,
        async create(input) {
          return { ...(await backupPort.create(input)), kind: 'immutable-backup-source' }
        },
      }
      const app = createEpochSwitchApplication(f.deps)
      const plan = await app.restoreBackup({ artifact: 'backup-reference', restoreConfig: true })
      expect(plan.plan.payload.role).toBe('restored')
      expect(plan.plan.payload.content.runsSupplied).toBe(false)
      await app.run({ operationId: f.operationId, approve: plan.plan.approvalDigest })
      const pointer = parseGenerationPointerV2(readFileSync(f.pointerPath, 'utf8'))
      expect(pointer.payload.role).toBe('restored')
      expect(pointer.payload.previous!.generationId).toBe('dbg_previously_installed')
      const activation = JSON.parse(
        (await app.receipt({ operationId: f.operationId, kind: 'activation' })).json,
      )
      expect(activation.payload.previousPointer.generationId).toBe('dbg_previously_installed')
      expect(readFileSync(join(f.root, 'skills/skill.md'), 'utf8')).toBe('backup skill')
      expect(readFileSync(join(f.root, 'config.json'), 'utf8')).toBe('{"backup":true}')
      expect(readFileSync(join(backup, 'skills/skill.md'), 'utf8')).toBe('backup skill')
      await app.rollback({ operationId: f.operationId })
      expect(readFileSync(f.pointerPath)).toEqual(original)
      expect(readFileSync(join(f.root, 'skills/skill.md'), 'utf8')).toBe('installed skill')
      expect(readFileSync(join(f.root, 'config.json'), 'utf8')).toBe('{"installed":true}')
    } finally {
      f.close()
    }
  })

test('file replacement resumes every move and leaves config alone without --restore-config', async () => {
  const f = makeSwitchFixture()
  try {
    const backup = join(f.root, 'backup-files')
    mkdirSync(join(backup, 'skills'), { recursive: true })
    writeFileSync(join(backup, 'skills/new'), 'new')
    mkdirSync(join(f.root, 'skills'), { recursive: true })
    writeFileSync(join(f.root, 'skills/old'), 'old')
    writeFileSync(join(f.root, 'config.json'), 'current config')
    let fire = true
    const files = createEpochRestoreFiles({
      appHome: f.root,
      faults: () => {
        if (fire) {
          fire = false
          throw new Error('move-crash')
        }
      },
    })
    const changes = await files.plan({
      operationRoot: f.deps.journal.operationRoot(f.operationId),
      sourceRoot: backup,
      restoreConfig: false,
    })
    await expect(files.apply(changes)).rejects.toThrow('move-crash')
    await files.apply(changes)
    expect(existsSync(join(f.root, 'skills/new'))).toBe(true)
    expect(readFileSync(join(f.root, 'config.json'), 'utf8')).toBe('current config')
    fire = true
    await expect(files.rollback(changes)).rejects.toThrow('move-crash')
    await files.rollback(changes)
    expect(existsSync(join(f.root, 'skills/old'))).toBe(true)
    expect(existsSync(changes[0]!.sourcePath)).toBe(true)
  } finally {
    f.close()
  }
})

test('an originally absent backup skills directory replaces installed skills with an empty tree', async () => {
  const f = makeSwitchFixture()
  try {
    const backup = join(f.root, 'empty-backup-files')
    mkdirSync(backup)
    mkdirSync(join(f.root, 'skills'))
    writeFileSync(join(f.root, 'skills/installed'), 'original')
    const changes = await f.deps.restoreFiles!.plan({
      operationRoot: f.deps.journal.operationRoot(f.operationId),
      sourceRoot: backup,
      restoreConfig: false,
    })
    await f.deps.restoreFiles!.apply(changes)
    expect(existsSync(join(f.root, 'skills/installed'))).toBe(false)
    expect(existsSync(join(f.root, 'skills'))).toBe(true)
    await f.deps.restoreFiles!.rollback(changes)
    expect(readFileSync(join(f.root, 'skills/installed'), 'utf8')).toBe('original')
  } finally {
    f.close()
  }
})

test('restore retry reuses its operation and supplied run content never replaces backup skills', async () => {
  const f = makeSwitchFixture()
  try {
    const backup = join(f.root, 'backup-root')
    const content = join(f.root, 'run-root')
    mkdirSync(join(backup, 'skills'), { recursive: true })
    mkdirSync(join(content, 'skills'), { recursive: true })
    writeFileSync(join(backup, 'skills/proof'), 'backup')
    writeFileSync(join(content, 'skills/proof'), 'other')
    let unpacked = 0
    f.deps.unpackBackup = async () => {
      unpacked++
      return { sourceKind: 'sqlite-backup', root: backup, digest: fixtureDigest }
    }
    const request = { artifact: 'backup', contentRoot: content }
    const plan = await f.app.restoreBackup(request)
    expect(plan.plan.payload.content).toMatchObject({
      root: backup,
      runContentRoot: content,
      runsSupplied: true,
    })
    expect((await f.app.restoreBackup(request)).plan.digest).toBe(plan.plan.digest)
    expect(unpacked).toBe(1)
    const backupPort = f.deps.backup.create
    f.deps.backup.create = async (input) => ({
      ...(await backupPort(input)),
      kind: 'immutable-backup-source',
    })
    await f.app.run({ operationId: f.operationId, approve: plan.plan.approvalDigest })
    expect(readFileSync(join(f.root, 'skills/proof'), 'utf8')).toBe('backup')
    expect((await f.app.restoreBackup(request)).requiresApproval).toBe(false)
  } finally {
    f.close()
  }
})
