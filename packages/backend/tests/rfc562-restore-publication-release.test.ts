// RFC-562 — 恢复归一时释放快照里遗留的托管对象发布：内容 owner 的闭合操作 `releaseHostedPublicationsInTx`。
//
// 为什么存在：System Operations 的恢复归一原先自己改 `content_publications`（把快照里仍在构建、因而永远完不成的备份的发布置为
// releasing），那是在内容 owner 的表上直接写。RFC-562 把这条 UPDATE 原样收进发布日志；而它此前没有任何用例走到——既有的恢复归一用例里
// 没有被放弃的备份（`failedBackups: 0`）。这里补上：
// ① 只有点名 owner、点名 key、状态为 pending / ready 的行开始释放，字段与原先那条 UPDATE 相同（封存的源随之清掉，否则过不了表上的形状约束）；
// ② 空的 key 列表什么都不改；
// ③ 经 System Operations 的恢复归一走到它：快照里仍在构建的另一个备份（不是恢复来源）被判失败，它的发布开始释放，恢复来源自己的发布照旧被
//    重新采纳。
import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'

import { logicalSchemaContract } from '@/bootstrap/persistenceSchema'
import { HOSTED_BACKUP_OWNER } from '@/modules/system-operations/infrastructure/crewstation/databaseBackupFormat'
import { createHostedSystemRestoreNormalization } from '@/modules/system-operations/infrastructure/crewstation/hostedRestoreNormalization'
import {
  adoptHostedPublicationInTx,
  hostedPublicationId,
  releaseHostedPublicationsInTx,
} from '@/platform/content/infrastructure/hostedObjectPublications'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { describeEachProvider } from './helpers/eachProvider'

const objectOf = (digit: number) => ({
  id: `01a13e6d-3e00-7000-9e3c-0000000000e${digit}`,
  sha256: String(digit).repeat(64),
  size: 10 + digit,
})

describeEachProvider('RFC-562 restore-time publication release', (harness) => {
  const adopt = (owner: string, key: string, digit: number) =>
    harness.session.transaction((tx) =>
      adoptHostedPublicationInTx(tx, {
        owner,
        key,
        attempt: key,
        object: objectOf(digit),
        createdAt: 100,
        now: 200,
      }),
    )
  const publications = async () => {
    const { contentPublications } = tablesOf(harness.db)
    return new Map(
      (await harness.db.select().from(contentPublications)).map(
        (row) => [`${row.owner}/${row.logicalKey}`, row] as const,
      ),
    )
  }

  test('only the named owner keys in pending or ready state start releasing', async () => {
    await adopt('owner-a', 'ready', 1)
    await adopt('owner-a', 'unnamed', 2)
    await adopt('owner-a', 'released', 3)
    await adopt('owner-b', 'ready', 4)
    const { contentPublications } = tablesOf(harness.db)
    await harness.db
      .update(contentPublications)
      .set({ state: 'released', releasedAt: 150 })
      .where(eq(contentPublications.id, hostedPublicationId('owner-a', 'released')))
    await harness.db.insert(contentPublications).values({
      id: hostedPublicationId('owner-a', 'pending'),
      owner: 'owner-a',
      logicalKey: 'pending',
      scope: null,
      attempt: 'attempt-1',
      state: 'pending',
      sha256: '5'.repeat(64),
      size: 5,
      contentId: null,
      epoch: 0,
      sourceSealed: 'sealed-source',
      attempts: 2,
      nextAttemptAt: 999,
      createdAt: 100,
      releasedAt: null,
      updatedAt: 100,
    })

    await harness.session.transaction((tx) =>
      releaseHostedPublicationsInTx(tx, {
        owner: 'owner-a',
        keys: ['ready', 'pending', 'released', 'missing'],
        now: 7_000,
      }),
    )

    const rows = await publications()
    const releasing = {
      state: 'releasing',
      releasedAt: 7_000,
      updatedAt: 7_000,
      nextAttemptAt: 0,
      sourceSealed: null,
    }
    expect(rows.get('owner-a/ready')).toMatchObject(releasing)
    expect(rows.get('owner-a/pending')).toMatchObject(releasing)
    expect(rows.get('owner-a/released')).toMatchObject({ state: 'released', releasedAt: 150 })
    expect(rows.get('owner-a/unnamed')).toMatchObject({ state: 'ready', releasedAt: null })
    expect(rows.get('owner-b/ready')).toMatchObject({ state: 'ready', releasedAt: null })
    expect(rows.has('owner-a/missing')).toBe(false)
  })

  test('an empty key list changes nothing', async () => {
    await adopt('owner-a', 'ready', 1)
    await harness.session.transaction((tx) =>
      releaseHostedPublicationsInTx(tx, { owner: 'owner-a', keys: [], now: 7_000 }),
    )
    expect((await publications()).get('owner-a/ready')).toMatchObject({
      state: 'ready',
      releasedAt: null,
      updatedAt: 200,
    })
  })

  test('System Operations releases the publication of a backup the snapshot left building', async () => {
    const source = '01a13e6d-3e00-7000-9e3c-0000000000b1'
    const abandoned = '01a13e6d-3e00-7000-9e3c-0000000000b2'
    const { hostedDatabaseBackups } = tablesOf(harness.db)
    // The table allows one building backup at a time (it holds the single active slot), so the snapshot's building row
    // is a backup other than the restore source; the source's own row is recorded by the normalization.
    await harness.db.insert(hostedDatabaseBackups).values({
      id: abandoned,
      epoch: 7,
      kind: 'manual',
      state: 'building',
      activeSlot: 'global',
      createdAt: 90,
      updatedAt: 90,
    })
    await adopt(HOSTED_BACKUP_OWNER, abandoned, 6)
    const sourceObject = objectOf(7)
    const participant = createHostedSystemRestoreNormalization({
      object: sourceObject,
      sidecar: {
        format: 'aw-hosted-database-backup-v2',
        backupId: source,
        kind: 'scheduled',
        installation: 'project/service',
        objectSpaceId: '01a13e6d-3e00-7000-9e3c-00000000aaaa',
        keyFingerprint: 'f'.repeat(64),
        createdAt: 100,
        snapshotAt: 120,
        schemaDigest: logicalSchemaContract.digest,
        sourceGenerationId: 'dbg_rfc562_restore_release',
        contents: { workflows: 1, skills: 0 },
      },
    })

    const result = await harness.session.transaction((tx) =>
      participant.normalize(tx, { restoreOperationId: 'restore-op', now: 9_000 }),
    )

    expect(result).toMatchObject({ failedBackups: 1, adoptedBackups: 1 })
    const backups = new Map(
      (await harness.db.select().from(hostedDatabaseBackups)).map((row) => [row.id, row] as const),
    )
    expect(backups.get(abandoned)).toMatchObject({ state: 'failed', activeSlot: null })
    expect(backups.get(source)).toMatchObject({ state: 'ready', objectId: sourceObject.id })
    const rows = await publications()
    expect(rows.get(`${HOSTED_BACKUP_OWNER}/${abandoned}`)).toMatchObject({
      state: 'releasing',
      releasedAt: 9_000,
      updatedAt: 9_000,
      nextAttemptAt: 0,
    })
    expect(rows.get(`${HOSTED_BACKUP_OWNER}/${source}`)).toMatchObject({
      state: 'ready',
      attempt: source,
      releasedAt: null,
    })
  })
})
