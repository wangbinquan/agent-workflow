import {
  withRepositorySnapshotPorts,
  withSourceControlTaskPorts,
} from './helpers/sourceControlTaskPorts'
import { readTaskFixtures } from './helpers/model'
import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { admitDaemonIdentity } from '@/modules/identity-access/composition/authentication'
import { createIdentityAccessRuntime } from '@/modules/identity-access/composition'
import { trustedContextMetadata } from '@/modules/identity-access/application/operationContext'
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
    const identityAccess = createIdentityAccessRuntime({ db: harness.db })
    const identity = await admitDaemonIdentity(identityAccess)
    if (identity === null) throw new Error('daemon identity missing')
    const { authority } = identity
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
    const { cachedRepos } = tablesOf(harness.db)
    await insertOne(harness.db, cachedRepos, repository)
    async function scope<T>(
      body: (
        owner: ReturnType<typeof createRepositoryLaunchSnapshotInTx>,
        tx: typeof harness.db,
      ) => Promise<T>,
    ) {
      return harness.session.transaction(async (transaction) => {
        let active = true
        const owner = createRepositoryLaunchSnapshotInTx(
          withRepositorySnapshotPorts({
            transaction,
            authority,
            now: 2,
            assertLive: () => {
              if (!active) throw new Error('snapshot-scope-ended')
            },
          }),
        )
        try {
          return await body(owner, transaction)
        } finally {
          owner.close()
          active = false
        }
      })
    }
    return { identity, identityAccess, root, repository, scope }
  }

  test('configuration revision excludes cache paths and fetch telemetry', async () => {
    const f = await fixture()
    const original = repositoryPreparationRevision(f.repository)
    const { cachedRepos } = tablesOf(harness.db)
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
    expect(await readTaskFixtures(harness.db)).toEqual([])
  })

  test('group snapshot freezes nested versions, repository configuration and empty directories', async () => {
    const f = await fixture()
    const root = ulid(),
      child = ulid(),
      empty = ulid()
    const { repoGroups, repoGroupNodes, cachedRepos } = tablesOf(harness.db)
    for (const [id, name] of [
      [root, 'root'],
      [child, 'child'],
      [empty, 'empty'],
    ] as const)
      await insertOne(harness.db, repoGroups, { id, name, version: 1, createdAt: 1, updatedAt: 1 })
    await harness.db.insert(repoGroupNodes).values([
      { groupId: root, path: '', attachmentKind: null },
      { groupId: empty, path: '', attachmentKind: null },
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

  test('RFC-602 currentGroup reads one row and launch freezes only its reachable graph as unrelated data grows', async () => {
    const f = await fixture()
    const { repoGroups, repoGroupNodes, cachedRepos } = tablesOf(harness.db)
    await harness.db.insert(repoGroups).values([
      { id: 'root', name: 'root', version: 1, createdAt: 1, updatedAt: 1 },
      { id: 'empty', name: 'empty', version: 1, createdAt: 1, updatedAt: 1 },
    ])
    await harness.db.insert(repoGroupNodes).values([
      { groupId: 'root', path: '', attachmentKind: 'repo', cachedRepoId: f.repository.id },
      { groupId: 'root', path: 'docs', attachmentKind: 'group', childGroupId: 'empty' },
      { groupId: 'empty', path: '', attachmentKind: null },
      { groupId: 'empty', path: 'notes', attachmentKind: null },
    ])
    const frozen = await f.scope((owner) =>
      owner.participant.resolveAuthorized(f.identity.authority, {
        kind: 'repository-group',
        group: { id: 'root', version: 1 },
      }),
    )
    const original = await readRepositoryPreparationFacts(harness.db, frozen)
    const noise = Array.from({ length: 100 }, (_, i) => `unrelated-${i}`)
    await harness.db
      .insert(repoGroups)
      .values(noise.map((id) => ({ id, name: id, version: 1, createdAt: 1, updatedAt: 1 })))
    await harness.db.insert(cachedRepos).values(
      noise.map((id) => ({
        id,
        urlHash: id,
        localPath: `/unused/${id}`,
        lastFetchedAt: 1,
        createdAt: 1,
      })),
    )
    await harness.db.insert(repoGroupNodes).values(
      noise.map((id) => ({
        groupId: id,
        path: '',
        attachmentKind: 'repo' as const,
        cachedRepoId: id,
      })),
    )

    await f.scope(async (owner) => {
      const recording = harness.recordStatements()
      try {
        expect(await owner.currentGroup('root')).toEqual({ id: 'root', version: 1 })
        const reads = recording.statements.filter(({ sql }) =>
          /^[\s(]*(?:select|with)\b/i.test(sql),
        )
        expect(reads).toHaveLength(1)
        expect(reads[0]?.rows).toBe(1)
        expect(reads[0]?.sql).not.toMatch(/repo_group_nodes|cached_repos|memories|scheduled_tasks/i)
      } finally {
        recording.stop()
      }
    })
    const next = await f.scope(async (owner) => {
      const recording = harness.recordStatements()
      try {
        const reference = await owner.participant.resolveAuthorized(f.identity.authority, {
          kind: 'repository-group',
          group: { id: 'root', version: 1 },
        })
        const reads = recording.statements.filter(({ sql }) =>
          /^[\s(]*(?:select|with)\b/i.test(sql),
        )
        const graph = reads.filter(({ sql }) => /^\s*with\b/i.test(sql))
        expect(graph).toHaveLength(3)
        expect(graph.map((read) => read.rows).sort((a, b) => a - b)).toEqual([1, 2, 4])
        expect(reads.some(({ sql }) => /memories|scheduled_tasks/i.test(sql))).toBe(false)
        // The extra point read captures immutable repository configuration, not other URLs.
        const configuration = reads.filter(
          ({ sql }) => /cached_repos/i.test(sql) && !/^\s*with\b/i.test(sql),
        )
        expect(configuration).toHaveLength(1)
        expect(configuration[0]?.rows).toBe(1)
        return reference
      } finally {
        recording.stop()
      }
    })
    expect(await readRepositoryPreparationFacts(harness.db, next)).toEqual(original)
    expect(original.groups.map((group) => group.id)).toEqual(['empty', 'root'])
    expect(original.layout.nodes.map((node) => node.path)).toContain('docs/notes')
    await expect(f.scope((owner) => owner.currentGroup('missing'))).rejects.toMatchObject({
      code: 'repo-group-not-found',
    })
    await expect(
      f.scope((owner) =>
        owner.participant.resolveAuthorized(f.identity.authority, {
          kind: 'repository-group',
          group: { id: 'root', version: 2 },
        }),
      ),
    ).rejects.toMatchObject({ code: 'repository-version-changed' })
  })

  test('new seal factory replays the same durable source without creating a mirror or Task', async () => {
    const f = await fixture()
    const input = { db: harness.db, appHome: join(f.root, 'home') }
    const launchId = ulid()
    const context = f.identityAccess.taskPreparationContext(f.identity.authority, launchId)
    const replayContext = f.identityAccess.taskPreparationContext(f.identity.authority, launchId)
    expect(context.authority).toBe(f.identity.authority)
    expect(replayContext.idempotencyKey).toBe(context.idempotencyKey)
    expect(replayContext.operationId).not.toBe(context.operationId)
    expect(context.correlationId).toBe(launchId)
    expect(trustedContextMetadata(context)).toEqual({
      source: 'task-execution',
      transport: 'delegated',
    })
    expect(
      f.identityAccess.taskPreparationContext(f.identity.authority, ulid()).idempotencyKey,
    ).not.toBe(context.idempotencyKey)
    const source = {
      kind: 'url' as const,
      url: 'https://example.test/sealed.git',
      requestedRef: 'release',
    }
    const reference = await createPublicRepositorySourceSeal(
      withSourceControlTaskPorts(input),
    ).seal(context, source)
    expect(
      await createPublicRepositorySourceSeal(withSourceControlTaskPorts(input)).seal(
        replayContext,
        source,
      ),
    ).toBe(reference)
    await expect(
      createPublicRepositorySourceSeal(withSourceControlTaskPorts(input)).seal(context, {
        ...source,
        requestedRef: 'changed',
      }),
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
    expect(await readTaskFixtures(harness.db)).toEqual([])
  })
})
