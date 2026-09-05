// RFC-359 W4-D7a —— 数字员工临时输入上传与 OS 单写者 cutover 的 writer state / 排空投影：一份实现，两个 provider
// 共用，同一段断言在两个引擎上各跑一遍。末尾一条源码锁保证该族不再出现 provider 专属文件。

import { expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ulid } from 'ulid'

import { createEmployeeInputUploadPersistence } from '@/modules/digital-employee/infrastructure/inputUploadStore'
import { createDigitalEmployeeWriterCutoverPersistence } from '@/modules/digital-employee/infrastructure/writerCutoverPersistence'
import { describeEachProvider } from './helpers/eachProvider'

const NOW = 1_700_000_000_000

async function codeOf(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn()
  } catch (error) {
    return (error as { code?: string }).code
  }
  return undefined
}

describeEachProvider('RFC-359 W4-D7a —— 临时输入上传与 writer cutover', (harness) => {
  test('上传：幂等键命中返回既有行，按 id 解析校验归属 / 状态 / 过期，删除只认本人的 pending 行', async () => {
    const uploads = createEmployeeInputUploadPersistence(harness.db)
    const actor = `u_${ulid()}`
    const key = `idem-${ulid()}`
    const first = await uploads.create({
      actorUserId: actor,
      originalName: 'spec.md',
      bytes: 12,
      sha256: 'a'.repeat(64),
      blobRef: 'blob-1',
      idempotencyKey: key,
      now: NOW,
    })
    expect(first).toMatchObject({
      actorUserId: actor,
      state: 'pending',
      claimedByCaseId: null,
      expiresAt: NOW + 2 * 60 * 60 * 1_000,
    })
    const again = await uploads.create({
      actorUserId: actor,
      originalName: 'other.md',
      bytes: 1,
      sha256: 'b'.repeat(64),
      blobRef: 'blob-2',
      idempotencyKey: key,
      now: NOW + 1,
    })
    expect(again.id).toBe(first.id)
    // 幂等键按 actor 分区：另一个 actor 用同一个键得到自己的行。
    const other = await uploads.create({
      actorUserId: `u_${ulid()}`,
      originalName: 'x.md',
      bytes: 1,
      sha256: 'c'.repeat(64),
      blobRef: 'blob-3',
      idempotencyKey: key,
      now: NOW + 2,
    })
    expect(other.id).not.toBe(first.id)
    const anonymous = await uploads.create({
      actorUserId: null,
      originalName: 'anon.md',
      bytes: 1,
      sha256: 'd'.repeat(64),
      blobRef: 'blob-4',
      idempotencyKey: null,
      now: NOW,
    })

    expect(
      (
        await uploads.resolveForCase({
          ids: [first.id],
          actorUserId: actor,
          caseId: 'case-1',
          now: NOW,
        })
      ).map((row) => row.id),
    ).toEqual([first.id])
    expect(
      await codeOf(() =>
        uploads.resolveForCase({
          ids: [first.id, first.id],
          actorUserId: actor,
          caseId: 'case-1',
          now: NOW,
        }),
      ),
    ).toBe('employee-upload-duplicate')
    expect(
      await codeOf(() =>
        uploads.resolveForCase({
          ids: [first.id],
          actorUserId: 'someone-else',
          caseId: 'c',
          now: NOW,
        }),
      ),
    ).toBe('employee-upload-not-found')
    expect(
      await codeOf(() =>
        uploads.resolveForCase({
          ids: [first.id],
          actorUserId: actor,
          caseId: 'case-1',
          now: first.expiresAt,
        }),
      ),
    ).toBe('employee-upload-not-claimable')
    expect(
      (
        await uploads.resolveForCase({
          ids: [anonymous.id],
          actorUserId: null,
          caseId: 'c',
          now: NOW,
        })
      ).map((row) => row.id),
    ).toEqual([anonymous.id])

    expect(await codeOf(() => uploads.delete(first.id, 'someone-else'))).toBe(
      'employee-upload-not-found',
    )
    await uploads.delete(first.id, actor)
    expect(await codeOf(() => uploads.delete(first.id, actor))).toBe('employee-upload-not-found')
    await uploads.delete(anonymous.id, null)

    // 过期清扫：每片只删一个有界批次。
    for (let index = 0; index < 3; index += 1) {
      await uploads.create({
        actorUserId: null,
        originalName: `expired-${index}.md`,
        bytes: 1,
        sha256: `${index}`.padStart(64, 'e'),
        blobRef: `blob-expired-${index}`,
        idempotencyKey: null,
        now: 0,
      })
    }
    expect(await uploads.sweepExpired(NOW, 2)).toBe(2)
    expect(await uploads.sweepExpired(NOW, 2)).toBe(1)
    expect(await uploads.sweepExpired(NOW, 2)).toBe(0)
  })

  test('writer cutover：activate 把第 0 代升到第 1 代、refresh 重算模式、migrationSnapshot 给出有界排空投影', async () => {
    const writer = createDigitalEmployeeWriterCutoverPersistence(harness.db)
    const initial = await writer.read()
    expect(initial.activeGeneration).toBeGreaterThanOrEqual(0)
    const activated = await writer.activate({ now: NOW, legacyAdmissionsEnabled: false })
    expect(activated).toEqual({
      activeGeneration: Math.max(1, initial.activeGeneration),
      mode: 'os-active',
      legacyAdmissionsEnabled: false,
      legacyOpenMissionCount: 0,
      updatedAt: NOW,
    })
    expect(await writer.read()).toEqual(activated)
    const refreshed = await writer.refresh(NOW + 1)
    expect(refreshed).toEqual({ ...activated, updatedAt: NOW + 1 })
    const snapshot = await writer.migrationSnapshot(5)
    expect(snapshot.writer).toEqual(refreshed)
    expect(snapshot.drain).toEqual({ truncated: false, entries: [] })
    // 再次 activate 保持第 1 代（幂等）。
    expect(
      (await writer.activate({ now: NOW + 2, legacyAdmissionsEnabled: true })).activeGeneration,
    ).toBe(activated.activeGeneration)
  })
})

test('源码锁：临时上传与 writer cutover 不再有 provider 专属文件', () => {
  const infra = join(import.meta.dir, '..', 'src', 'modules', 'digital-employee', 'infrastructure')
  expect(existsSync(join(infra, 'postgresqlInputUploadStore.ts'))).toBe(false)
  for (const neutral of ['inputUploadStore.ts', 'writerCutoverPersistence.ts']) {
    const source = readFileSync(join(infra, neutral), 'utf8')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//'))
      .join('\n')
    expect(source).not.toMatch(/PostgresqlDatabaseClient|\bDbClient\b|dbTxSync|for update/i)
    expect(source).toContain('ProviderNeutralDatabase')
  }
})
