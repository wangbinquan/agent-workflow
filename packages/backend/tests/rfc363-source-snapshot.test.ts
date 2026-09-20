import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { cachedRepos, repoGroups, repoGroupNodes, tasks } from '@/db/schema'
import { admitDaemonIdentity } from '@/auth/session'
import { createIdentityAccessRuntime } from '@/modules/identity-access/composition'
import type {
  IdempotentCommandContext,
  ValidatedIdempotencyKey,
} from '@/modules/identity-access/public/participants'
import { repositoryPreparationRevision } from '@/modules/source-control/domain/repositoryPreparationFacts'
import { createPublicRepositorySourceSeal } from '@/modules/source-control/infrastructure/publicRepositorySourceSeal'
import {
  createRepositoryLaunchSnapshotInTx,
  readRepositoryPreparationFacts,
} from '@/modules/source-control/infrastructure/repositoryLaunchSnapshot'
import type { FrozenRepositoryPreparationRef } from '@/modules/source-control/public/types'
import { describeEachProvider } from './helpers/eachProvider'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describeEachProvider('RFC-363 durable source facts', (harness) => {
  async function fixture() {
    const identity = await admitDaemonIdentity(createIdentityAccessRuntime({ db: harness.db }))
    if (identity === null) throw new Error('daemon identity missing')
    const root = mkdtempSync(join(tmpdir(), 'rfc363-source-'))
    roots.push(root)
    const repository = {
      id: ulid(),
      urlHash: ulid(),
      localPath: join(root, 'mirror'),
      urlRedacted: 'https://example.test/source.git',
      defaultBranch: 'main',
      lastFetchedAt: 1,
      createdAt: 1,
    }
    await harness.db.insert(cachedRepos).values(repository)
    async function scope<T>(
      body: (
        owner: ReturnType<typeof createRepositoryLaunchSnapshotInTx>,
        tx: typeof harness.db,
      ) => Promise<T>,
    ) {
      return harness.session.transaction(async (transaction) => {
        let active = true
        const owner = createRepositoryLaunchSnapshotInTx({
          transaction,
          authority: identity.authority,
          now: 2,
          assertLive: () => {
            if (!active) throw new Error('snapshot-scope-ended')
          },
        })
        try {
          return await body(owner, transaction)
        } finally {
          active = false
        }
      })
    }
    return { identity, root, repository, scope }
  }

  test('configuration revision excludes cache paths and fetch telemetry', async () => {
    const f = await fixture()
    const original = repositoryPreparationRevision(f.repository)
    await harness.db
      .update(cachedRepos)
      .set({
        localPath: join(f.root, 'new-cache'),
        lastFetchedAt: 900,
        lastAutoRefreshAt: 901,
        hasSubmodules: true,
      })
      .where(eq(cachedRepos.id, f.repository.id))
    expect((await f.scope((owner) => owner.currentRepository(f.repository.id))).revision).toBe(
      original,
    )
    await harness.db
      .update(cachedRepos)
      .set({ defaultBranch: 'release' })
      .where(eq(cachedRepos.id, f.repository.id))
    expect((await f.scope((owner) => owner.currentRepository(f.repository.id))).revision).not.toBe(
      original,
    )
    await expect(
      f.scope((owner) =>
        owner.participant.resolveAuthorized(f.identity.authority, {
          kind: 'repository',
          repository: { id: f.repository.id, revision: original },
          base: 'main',
        }),
      ),
    ).rejects.toMatchObject({ code: 'repository-version-changed' })
  })

  test('rollback drops the frozen ref, ends its factory and performs no filesystem preparation', async () => {
    const f = await fixture()
    let captured: FrozenRepositoryPreparationRef | undefined
    let escaped: ReturnType<typeof createRepositoryLaunchSnapshotInTx> | undefined
    await expect(
      f.scope(async (owner, tx) => {
        escaped = owner
        captured = await owner.participant.resolveAuthorized(f.identity.authority, {
          kind: 'repository',
          repository: await owner.currentRepository(f.repository.id),
          base: 'release',
        })
        expect((await readRepositoryPreparationFacts(tx, captured)).layout.repos[0]?.ref).toBe(
          'release',
        )
        throw new Error('rollback')
      }),
    ).rejects.toThrow('rollback')
    await expect(readRepositoryPreparationFacts(harness.db, captured!)).rejects.toMatchObject({
      code: 'repository-snapshot-unavailable',
    })
    await expect(escaped!.currentRepository(f.repository.id)).rejects.toThrow(
      'snapshot-scope-ended',
    )
    expect(existsSync(f.repository.localPath)).toBe(false)
    expect(await harness.db.select().from(tasks)).toEqual([])
  })

  test('group snapshot freezes nested versions, repository configuration and empty directories', async () => {
    const f = await fixture()
    const root = ulid(),
      child = ulid(),
      empty = ulid()
    for (const [id, name] of [
      [root, 'root'],
      [child, 'child'],
      [empty, 'empty'],
    ] as const)
      await harness.db
        .insert(repoGroups)
        .values({ id, name, version: 1, createdAt: 1, updatedAt: 1 })
    await harness.db.insert(repoGroupNodes).values([
      { groupId: root, path: 'code', attachmentKind: 'group', childGroupId: child },
      { groupId: root, path: 'docs', attachmentKind: 'group', childGroupId: empty },
      {
        groupId: child,
        path: '',
        attachmentKind: 'repo',
        cachedRepoId: f.repository.id,
        ref: 'release',
        subdir: 'src',
        readonly: true,
      },
      { groupId: empty, path: 'notes', attachmentKind: null },
    ])
    const reference = await f.scope((owner) =>
      owner.participant.resolveAuthorized(f.identity.authority, {
        kind: 'repository-group',
        group: { id: root, version: 1 },
      }),
    )
    const frozen = await readRepositoryPreparationFacts(harness.db, reference)
    expect(frozen.groups.map((group) => group.id).sort()).toEqual([root, child, empty].sort())
    expect(frozen.layout.repos[0]).toMatchObject({
      mountPath: 'code',
      ref: 'release',
      subdir: 'src',
      readonly: true,
    })
    expect(frozen.layout.nodes.map((node) => node.path)).toContain('docs/notes')
    await harness.db
      .update(repoGroups)
      .set({ version: 2, name: 'changed-child' })
      .where(eq(repoGroups.id, child))
    await harness.db
      .update(repoGroupNodes)
      .set({ ref: 'other' })
      .where(eq(repoGroupNodes.groupId, child))
    await harness.db
      .update(cachedRepos)
      .set({ defaultBranch: 'changed-default' })
      .where(eq(cachedRepos.id, f.repository.id))
    expect(await readRepositoryPreparationFacts(harness.db, reference)).toEqual(frozen)
    const next = await f.scope((owner) =>
      owner.participant.resolveAuthorized(f.identity.authority, {
        kind: 'repository-group',
        group: { id: root, version: 1 },
      }),
    )
    const current = await readRepositoryPreparationFacts(harness.db, next)
    expect(current.layout.repos[0]?.ref).toBe('other')
    expect(current.groups.find((group) => group.id === child)?.version).toBe(2)
  })

  test('new seal factory replays the same durable source without creating a mirror or Task', async () => {
    const f = await fixture()
    const input = { db: harness.db, appHome: join(f.root, 'home') }
    const context: IdempotentCommandContext = {
      authority: f.identity.authority,
      operationId: ulid(),
      correlationId: ulid(),
      now: 1,
      idempotencyKey: ulid() as ValidatedIdempotencyKey,
    }
    const source = {
      kind: 'url' as const,
      url: 'https://example.test/sealed.git',
      requestedRef: 'release',
    }
    const reference = await createPublicRepositorySourceSeal(input).seal(context, source)
    expect(
      await createPublicRepositorySourceSeal(input).seal(
        { ...context, operationId: ulid(), now: 2 },
        source,
      ),
    ).toBe(reference)
    await expect(
      createPublicRepositorySourceSeal(input).seal(context, { ...source, requestedRef: 'changed' }),
    ).rejects.toMatchObject({ code: 'repository-source-request-mismatch' })
    const frozen = await f.scope((owner) =>
      owner.participant.resolveAuthorized(f.identity.authority, {
        kind: 'sealed-public-repository',
        source: reference,
      }),
    )
    expect((await readRepositoryPreparationFacts(harness.db, frozen)).layout.repos[0]?.ref).toBe(
      'release',
    )
    expect(existsSync(input.appHome)).toBe(false)
    expect(await harness.db.select().from(tasks)).toEqual([])
  })
})
