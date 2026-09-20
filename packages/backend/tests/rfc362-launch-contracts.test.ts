import { composeRepositoryPreparation } from '@/modules/source-control/composition/repositoryPreparation'
import { afterEach, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { decodeRepositoryLaunchRef } from '@/modules/source-control/domain/repositoryLaunchRef'
import { cachedRepos, repoGroups } from '@/db/schema'
import { admitDaemonIdentity } from '@/auth/session'
import { createIdentityAccessRuntime } from '@/modules/identity-access/composition'
import type {
  IdempotentCommandContext,
  ValidatedIdempotencyKey,
} from '@/modules/identity-access/public/participants'
import type { RepositoryLaunchSnapshotInTx } from '@/modules/source-control/public/participants'
import type {
  FrozenRepositoryPreparationRef,
  RepositoryLaunchSource,
} from '@/modules/source-control/public/types'
import { createTaskWorkspaceMaterializer } from '@/modules/task-execution/composition/taskRouteLaunch'
import { describeEachProvider } from './helpers/eachProvider'
import { repositoryLaunchContracts, repositoryRevision } from './helpers/repositoryLaunchContracts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function directory() {
  const root = mkdtempSync(join(tmpdir(), 'rfc362-'))
  roots.push(root)
  return root
}
function git(repo: string, args: string[]) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()
}
function repository() {
  const root = directory()
  const repo = join(root, 'repo')
  mkdirSync(repo)
  git(repo, ['init', '-q', '-b', 'main'])
  writeFileSync(join(repo, 'a.txt'), 'abcdef')
  writeFileSync(join(repo, 'b.txt'), 'second')
  git(repo, ['add', 'a.txt', 'b.txt'])
  git(repo, [
    '-c',
    'user.name=RFC362',
    '-c',
    'user.email=rfc362@example.test',
    'commit',
    '-qm',
    'base',
  ])
  return { root, repo, base: git(repo, ['rev-parse', 'HEAD']) }
}

describeEachProvider('RFC-362 real source snapshot and existing Git mechanisms', (harness) => {
  async function fixture() {
    const runtime = createIdentityAccessRuntime({ db: harness.db })
    const identity = await admitDaemonIdentity(runtime)
    if (identity === null) throw new Error('missing daemon identity')
    const files = repository()
    const row = {
      id: ulid(),
      urlHash: ulid(),
      localPath: files.repo,
      urlRedacted: 'https://example.test/project.git',
      defaultBranch: 'main',
      lastFetchedAt: 1,
      createdAt: 1,
    }
    await harness.db.insert(cachedRepos).values(row)
    const stored = (
      await harness.db.select().from(cachedRepos).where(eq(cachedRepos.id, row.id))
    )[0]!
    const options = {
      db: harness.db,
      session: harness.session,
      appHome: join(files.root, 'home'),
      authority: identity.authority,
    }
    const contract = repositoryLaunchContracts(options)
    const source: RepositoryLaunchSource = {
      kind: 'repository',
      repository: { id: row.id, revision: repositoryRevision(stored) },
      base: files.base,
    }
    return { ...files, row: stored, source, identity, options, contract }
  }
  async function frozen(f: Awaited<ReturnType<typeof fixture>>) {
    return f.contract.withSnapshot((snapshot) =>
      snapshot.resolveAuthorized(f.identity.authority, f.source),
    )
  }
  test('same transaction sees an uncommitted source; rollback drops row and provisional ref', async () => {
    const f = await fixture()
    const id = ulid()
    let captured: FrozenRepositoryPreparationRef | undefined
    let escaped: RepositoryLaunchSnapshotInTx | undefined
    await expect(
      f.contract.withSnapshot(async (snapshot, tx) => {
        escaped = snapshot
        await tx.insert(cachedRepos).values({ ...f.row, id, urlHash: ulid() })
        const current = (await tx.select().from(cachedRepos).where(eq(cachedRepos.id, id)))[0]!
        captured = await snapshot.resolveAuthorized(f.identity.authority, {
          kind: 'repository',
          repository: { id, revision: repositoryRevision(current) },
          base: f.base,
        })
        expect(existsSync(f.options.appHome)).toBe(false)
        throw new Error('admission-rollback')
      }),
    ).rejects.toThrow('admission-rollback')
    expect(await harness.db.select().from(cachedRepos).where(eq(cachedRepos.id, id))).toEqual([])
    await expect(escaped!.resolveAuthorized(f.identity.authority, f.source)).rejects.toThrow(
      'snapshot-scope-ended',
    )
    const effect = f.contract.effect({ taskId: ulid() })
    expect(
      await f.contract.preparation.prepare(effect.capability, effect.operation, captured!),
    ).toMatchObject({ kind: 'failed', safeCode: 'replay-unavailable' })
    expect(existsSync(f.options.appHome)).toBe(false)
  })
  test('effects are outside the transaction; frozen source survives later DB change', async () => {
    const f = await fixture()
    const effect = f.contract.effect({ taskId: ulid() })
    const ref = await f.contract.withSnapshot(async (snapshot) => {
      const ref = await snapshot.resolveAuthorized(f.identity.authority, f.source)
      await expect(
        f.contract.preparation.prepare(effect.capability, effect.operation, ref),
      ).rejects.toThrow('repository-effect-inside-snapshot-transaction')
      return ref
    })
    await harness.db
      .update(cachedRepos)
      .set({ localPath: join(f.root, 'not-a-repository') })
      .where(eq(cachedRepos.id, f.row.id))
    const result = await f.contract.preparation.prepare(effect.capability, effect.operation, ref)
    expect(result.kind).toBe('prepared')
    if (result.kind !== 'prepared') throw new Error('missing receipt')
    const workspace = f.contract.workspace(result.receipt)
    expect(git(workspace.worktreePath, ['rev-parse', 'HEAD'])).toBe(f.base)
    const cleanup = await f.contract.rollback(result.receipt)
    expect(cleanup.failures).toEqual([])
    expect(existsSync(workspace.worktreePath)).toBe(false)
    expect(git(f.repo, ['worktree', 'list', '--porcelain'])).not.toContain(workspace.worktreePath)
  })
  test('duplicate same-operation preparation shares one real effect and receipt; restart cannot replay it', async () => {
    const f = await fixture()
    const ref = await frozen(f)
    let adds = 0
    const effect = f.contract.effect({
      taskId: ulid(),
      lifecycleHook: (event) => {
        if (event.stage === 'before-worktree-add') adds += 1
      },
    })
    const [one, two] = await Promise.all([
      f.contract.preparation.prepare(effect.capability, effect.operation, ref),
      f.contract.preparation.prepare(effect.capability, effect.operation, ref),
    ])
    expect(one).toEqual(two)
    expect(adds).toBe(1)
    expect(await f.contract.preparation.prepare(effect.capability, effect.operation, ref)).toEqual(
      one,
    )
    const restarted = repositoryLaunchContracts(f.options)
    const freshEffect = restarted.effect({ taskId: ulid() })
    expect(
      await restarted.preparation.prepare(freshEffect.capability, freshEffect.operation, ref),
    ).toMatchObject({ kind: 'failed', safeCode: 'replay-unavailable' })
    if (one.kind !== 'prepared') throw new Error('missing receipt')
    expect((await f.contract.rollback(one.receipt)).failures).toEqual([])
  })
  test.each(['before', 'during'] as const)(
    'cancel %s preparation retains the existing stopped outcome and cleans registration',
    async (phase) => {
      const f = await fixture()
      const ref = await frozen(f)
      const controller = new AbortController()
      const taskId = ulid()
      if (phase === 'before') controller.abort()
      const effect = f.contract.effect({
        taskId,
        signal: controller.signal,
        lifecycleHook: (event) => {
          if (phase === 'during' && event.stage === 'before-worktree-add') controller.abort()
        },
      })
      expect(
        await f.contract.preparation.prepare(effect.capability, effect.operation, ref),
      ).toMatchObject({ kind: 'stopped' })
      expect(git(f.repo, ['worktree', 'list', '--porcelain'])).not.toContain(taskId)
      expect(git(f.repo, ['branch', '--list', `agent-workflow/${taskId}`])).toBe('')
    },
  )
  test('Task reader delegates to the same bound SC workspace with page and byte bounds', async () => {
    const f = await fixture()
    const ref = await frozen(f)
    const effect = f.contract.effect({ taskId: ulid() })
    const result = await f.contract.preparation.prepare(effect.capability, effect.operation, ref)
    if (result.kind !== 'prepared') throw new Error('missing receipt')
    const binding = f.contract.bindRead(result.receipt)
    const page = await f.contract.taskWorkspace.list(binding.capability, {
      relativeDirectory: '',
      page: { offset: 0 },
      maxEntries: 1,
    })
    expect(page.entries.map((e) => e.name)).toEqual(['a.txt'])
    expect(page.nextOffset).toBe(1)
    expect(
      (
        await f.contract.taskWorkspace.list(binding.capability, {
          relativeDirectory: '',
          page: { offset: 1 },
          maxEntries: 1,
        })
      ).entries.map((e) => e.name),
    ).toEqual(['b.txt'])
    const read = await f.contract.taskWorkspace.read(binding.capability, {
      relativeFile: 'a.txt',
      offset: 2,
      maxBytes: 3,
    })
    expect(read).toEqual({
      encoding: 'base64',
      content: Buffer.from('cde').toString('base64'),
      size: 6,
      offset: 2,
      nextOffset: 5,
      oversized: false,
    })
    await expect(
      f.contract.taskWorkspace.read(binding.capability, {
        relativeFile: 'missing.txt',
        offset: 0,
        maxBytes: 1,
      }),
    ).rejects.toMatchObject({ code: 'worktree-file-not-found' })
    expect((await f.contract.rollback(result.receipt)).failures).toEqual([])
  })
  test('seal wraps real cached identity registration; durable replay and frozen groups remain explicit gaps', async () => {
    const f = await fixture()
    const context: IdempotentCommandContext = {
      authority: f.identity.authority,
      operationId: ulid(),
      correlationId: ulid(),
      now: 1,
      idempotencyKey: ulid() as ValidatedIdempotencyKey,
    }
    const source = {
      kind: 'url' as const,
      url: 'https://example.test/new-project.git',
      requestedRef: 'main',
    }
    const ref = await f.contract.seal.seal(context, source)
    expect(await f.contract.seal.seal(context, source)).toBe(ref)
    expect((await harness.db.select().from(cachedRepos)).length).toBe(2)
    expect(existsSync(f.options.appHome)).toBe(false)
    await f.contract.withSnapshot((snapshot) =>
      snapshot.resolveAuthorized(f.identity.authority, {
        kind: 'sealed-public-repository',
        source: ref,
      }),
    )
    const restarted = repositoryLaunchContracts(f.options)
    await expect(
      restarted.withSnapshot((snapshot) =>
        snapshot.resolveAuthorized(f.identity.authority, {
          kind: 'sealed-public-repository',
          source: ref,
        }),
      ),
    ).rejects.toThrow('seal-replay-unavailable')
    const groupId = ulid()
    await harness.db
      .insert(repoGroups)
      .values({ id: groupId, name: groupId, version: 2, createdAt: 1, updatedAt: 1 })
    await expect(
      f.contract.withSnapshot((snapshot) =>
        snapshot.resolveAuthorized(f.identity.authority, {
          kind: 'repository-group',
          group: { id: groupId, version: 1 },
        }),
      ),
    ).rejects.toThrow('repository-version-changed')
    await expect(
      f.contract.withSnapshot((snapshot) =>
        snapshot.resolveAuthorized(f.identity.authority, {
          kind: 'repository-group',
          group: { id: groupId, version: 2 },
        }),
      ),
    ).rejects.toThrow('group-frozen-preparation-unavailable')
  })
  test('current materializer keeps repository deferral distinct from pre-materialized scratch', async () => {
    const f = await fixture()
    const materializer = createTaskWorkspaceMaterializer({
      repositoryPreparation: composeRepositoryPreparation({
        db: harness.db,
        appHome: f.options.appHome,
      }),
      db: harness.db,
      appHome: f.options.appHome,
    })
    const deferred = await materializer.prepare({
      taskId: ulid(),
      task: { workflowId: 'oracle', name: 'deferred', inputs: {}, cachedRepoId: f.row.id },
      gitCommitIdentity: null,
      defer: true,
    })
    expect(deferred.worktreePath).toBe('')
    expect(deferred.cachedRepoId).toBe(f.row.id)
    expect(deferred.earlyError).toBeNull()
    expect(existsSync(f.options.appHome)).toBe(false)
    const scratch = await materializer.prepare({
      taskId: ulid(),
      task: { workflowId: 'oracle', name: 'scratch', inputs: {}, scratch: true },
      gitCommitIdentity: null,
      defer: true,
    })
    expect(existsSync(scratch.worktreePath)).toBe(true)
    expect(scratch.spaceKind).toBe('scratch')
    expect((await scratch.rollback()).complete).toBe(true)
    expect(existsSync(scratch.worktreePath)).toBe(false)
  })
})

test('RFC-362 reference codec preserves exact kind/version and rejects a different record kind', () => {
  const encoded = `sc:preparation:v1:${ulid()}`
  expect(String(decodeRepositoryLaunchRef('preparation', encoded))).toBe(encoded)
  expect(() => decodeRepositoryLaunchRef('source', encoded)).toThrow(
    'invalid-repository-launch-ref:source',
  )
  expect(() => decodeRepositoryLaunchRef('preparation', encoded.replace(':v1:', ':v2:'))).toThrow(
    'invalid-repository-launch-ref:preparation',
  )
})
