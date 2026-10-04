// RFC-370 A4: actual Task diff and S1 repair must await the selected workspace readers.
import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { ProviderNeutralDatabase } from '@/db/query'
import {
  docVersions,
  lifecycleAlerts,
  lifecycleRepairAudit,
  nodeRunOutputs,
  nodeRuns,
  taskRepos,
  tasks,
  workflows,
} from '@/db/schema'
import { createCollaborationRuntimeMechanics } from '@/modules/collaboration/infrastructure/collaborationRuntimeMechanics'
import type { CollaborationRuntimeMechanics } from '@/modules/collaboration/public/participants'
import {
  selectRepositoryWorkspaceReadQueries,
  type RepositoryWorkspaceReadQueries,
} from '@/modules/source-control/public/queries'
import { taskDiffProjection } from '@/modules/task-execution/infrastructure/taskRouteOperations'
import { DomainError } from '@/util/errors'
import { runGit } from '@/util/git'
import { describeEachProvider } from './helpers/eachProvider'
import { held } from './helpers/portArtifactContent'
import { describeEachProviderHttpApplication } from './helpers/providerHttpApplicationScope'
import { createRepairEngine } from './helpers/repairEngine'

const TOKEN = 'w'.repeat(64)
const MAX_DIFF = 1_048_576
const roots: string[] = []
function temp(): string {
  const root = mkdtempSync(join(tmpdir(), 'aw-rfc370-workspace-read-'))
  roots.push(root)
  return root
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

type Method = keyof RepositoryWorkspaceReadQueries
type Call = { method: Method; reference: string; argument?: unknown }
class ReadStore {
  readonly paths = new Map<string, string>()
  readonly calls: Call[] = []
  isolationRef = 'cs-workspace:isolated'
  before?: (call: Call) => void | Promise<void>
}

/** Frozen prototype methods use private receivers and real native Git behind opaque refs. */
class MappedReads implements RepositoryWorkspaceReadQueries {
  #store: ReadStore
  #native = selectRepositoryWorkspaceReadQueries()
  constructor(store: ReadStore) {
    this.#store = store
  }
  async #call(method: Method, reference: string, argument?: unknown): Promise<void> {
    const call = { method, reference, argument }
    this.#store.calls.push(call)
    await this.#store.before?.(call)
  }
  #path(reference: string): string {
    const path = this.#store.paths.get(reference)
    if (path === undefined) throw new Error('Unmapped workspace ref: ' + reference)
    return path
  }
  async exists(reference: string): Promise<boolean> {
    await this.#call('exists', reference)
    return await this.#native.exists(this.#path(reference))
  }
  async isGitWorkTree(reference: string): Promise<boolean> {
    await this.#call('isGitWorkTree', reference)
    return await this.#native.isGitWorkTree(this.#path(reference))
  }
  async gitDiffSnapshot(reference: string, base: string): Promise<string> {
    await this.#call('gitDiffSnapshot', reference, base)
    return await this.#native.gitDiffSnapshot(this.#path(reference), base)
  }
  async worktreeDiff(
    reference: string,
    base: string,
  ): Promise<{ diff: string; truncated: boolean }> {
    await this.#call('worktreeDiff', reference, base)
    return await this.#native.worktreeDiff(this.#path(reference), base)
  }
  async isolationRoot(
    input: Parameters<RepositoryWorkspaceReadQueries['isolationRoot']>[0],
  ): Promise<string> {
    await this.#call('isolationRoot', input.storageRootRef, input)
    return this.#store.isolationRef
  }
}

async function repository() {
  const root = temp()
  await runGit(root, ['init', '-q', '-b', 'main'])
  await runGit(root, ['config', 'user.name', 'Workspace Read Test'])
  await runGit(root, ['config', 'user.email', 'read@example.test'])
  writeFileSync(join(root, 'tracked.txt'), 'base\n')
  await runGit(root, ['add', 'tracked.txt'])
  await runGit(root, ['commit', '-q', '-m', 'base'])
  const base = (await runGit(root, ['rev-parse', 'HEAD'])).stdout.trim()
  writeFileSync(join(root, 'tracked.txt'), 'tracked change\n')
  writeFileSync(join(root, '中文未跟踪.txt'), 'untracked change\n')
  return { root, base }
}

async function seedTask(
  db: ProviderNeutralDatabase,
  workspaceRef: string,
  baseCommit: string | null,
) {
  const id = ulid(),
    workflowId = ulid()
  const snapshot = JSON.stringify({ $schema_version: 4, inputs: [], nodes: [], edges: [] })
  await db.insert(workflows).values({ id: workflowId, name: workflowId, definition: snapshot })
  await db.insert(tasks).values({
    id,
    name: id,
    workflowId,
    workflowSnapshot: snapshot,
    repoPath: workspaceRef,
    worktreePath: workspaceRef,
    baseBranch: 'main',
    branch: 'task/' + id,
    baseCommit,
    status: 'done',
    inputs: '{}',
    startedAt: 1,
  })
  return id
}

function mapped(reference: string, path: string) {
  const store = new ReadStore()
  store.paths.set(reference, path)
  return { store, reads: Object.freeze(new MappedReads(store)) }
}

describeEachProviderHttpApplication(
  'RFC-370 selected workspace reads through actual HTTP roots',
  {
    token: TOKEN,
    opencodeVersion: null,
    dbVersion: 1,
    tempPrefix: 'aw-rfc370-read-http-',
  },
  (scope) => {
    test('single diff awaits Git probe and bounded diff ACK, preserving tracked/untracked content', async () => {
      const repo = await repository(),
        ref = 'cs-workspace:single'
      const f = mapped(ref, repo.root)
      const opened = await scope.open({ workspaceReads: f.reads })
      const id = await seedTask(scope.harness.db, ref, repo.base)
      const entered = held<void>(),
        release = held<void>()
      f.store.before = async (call) => {
        if (call.method === 'worktreeDiff') {
          entered.resolve()
          await release.promise
        }
      }
      let finished = false
      const request = Promise.resolve(
        opened.app.request('/api/tasks/' + id + '/diff', {
          headers: { Authorization: 'Bearer ' + TOKEN },
        }),
      ).then((value) => {
        finished = true
        return value
      })
      try {
        await entered.promise
        expect(finished).toBe(false)
        expect(f.store.calls.map((call) => [call.method, call.reference])).toEqual([
          ['isGitWorkTree', ref],
          ['worktreeDiff', ref],
        ])
        expect(f.store.calls[1]!.argument).toBe(repo.base)
      } finally {
        release.resolve()
      }
      const response = await request
      expect(response.status).toBe(200)
      const body = await response.json()
      const native = await selectRepositoryWorkspaceReadQueries().worktreeDiff(repo.root, repo.base)
      expect(body).toEqual({ ...native, baseCommit: repo.base })
      expect(body.diff).toContain('tracked change')
      expect(body.diff).toContain('中文未跟踪.txt')
      expect(body.diff).toContain('untracked change')
    }, 60_000)
  },
)

describeEachProvider('RFC-370 Task diff reader policies with real provider rows', (provider) => {
  test('409 base error precedes every physical reader; both invalid-worktree 410 messages remain distinct', async () => {
    const root = temp(),
      ref = 'cs-workspace:missing'
    const f = mapped(ref, join(root, 'absent'))
    const id = await seedTask(provider.db, ref, null)
    await expect(
      taskDiffProjection({ db: provider.db, workspaceReads: f.reads }, id),
    ).rejects.toMatchObject({ code: 'task-no-base-commit', status: 409 })
    expect(f.store.calls).toEqual([])
    await provider.db.update(tasks).set({ baseCommit: 'base' }).where(eq(tasks.id, id))
    const missing = await taskDiffProjection(
      { db: provider.db, workspaceReads: f.reads },
      id,
    ).catch((error: unknown) => error)
    expect(missing).toBeInstanceOf(DomainError)
    expect(missing).toMatchObject({
      code: 'task-worktree-missing',
      status: 410,
      message: `worktree '${ref}' does not exist; cannot compute diff`,
    })
    expect(f.store.calls.map((call) => call.method)).toEqual(['isGitWorkTree', 'exists'])
    f.store.calls.length = 0
    mkdirSync(f.store.paths.get(ref)!)
    const invalid = await taskDiffProjection(
      { db: provider.db, workspaceReads: f.reads },
      id,
    ).catch((error: unknown) => error)
    expect(invalid).toMatchObject({
      code: 'task-worktree-missing',
      status: 410,
      message: `worktree '${ref}' is no longer a valid git repository (its source repo was moved or deleted); cannot compute diff`,
    })
    expect(f.store.calls.map((call) => call.method)).toEqual(['isGitWorkTree', 'exists'])
  })

  test('held Git probe and presence ACKs cannot be replaced by a native missing-directory answer', async () => {
    for (const method of ['isGitWorkTree', 'exists'] as const) {
      const ref = 'cs-workspace:held-' + method,
        f = mapped(ref, join(temp(), 'absent'))
      const id = await seedTask(provider.db, ref, 'base')
      const entered = held<void>(),
        release = held<void>()
      f.store.before = async (call) => {
        if (call.method === method) {
          entered.resolve()
          await release.promise
        }
      }
      let finished = false
      const operation = taskDiffProjection({ db: provider.db, workspaceReads: f.reads }, id).then(
        (value) => {
          finished = true
          return value
        },
        (error: unknown) => {
          finished = true
          return error
        },
      )
      try {
        await entered.promise
        expect(finished).toBe(false)
      } finally {
        release.resolve()
      }
      expect(await operation).toMatchObject({ code: 'task-worktree-missing', status: 410 })
    }
  })

  test('multi-repo presence is sequential and short-circuits empty bases before parallel Git probes', async () => {
    const repoA = await repository(),
      repoB = await repository()
    const parent = 'cs-workspace:parent',
      a = 'cs-workspace:a',
      b = 'cs-workspace:b'
    const f = mapped(parent, temp())
    f.store.paths.set(a, repoA.root)
    f.store.paths.set(b, repoB.root)
    const id = await seedTask(provider.db, parent, null)
    await provider.db.update(tasks).set({ repoCount: 5 }).where(eq(tasks.id, id))
    await provider.db.insert(taskRepos).values([
      {
        taskId: id,
        repoIndex: 3,
        repoPath: a,
        worktreePath: a,
        branch: 'task',
        baseCommit: repoA.base,
        mountPath: 'nested/a',
      },
      {
        taskId: id,
        repoIndex: 0,
        repoPath: 'no-base',
        worktreePath: 'no-base',
        branch: 'task',
        baseCommit: null,
      },
      {
        taskId: id,
        repoIndex: 1,
        repoPath: 'empty-base',
        worktreePath: 'empty-base',
        branch: 'task',
        baseCommit: '',
      },
      {
        taskId: id,
        repoIndex: 2,
        repoPath: b,
        worktreePath: b,
        branch: 'task',
        baseCommit: repoB.base,
        mountPath: 'readonly',
        readonly: true,
      },
      {
        taskId: id,
        repoIndex: 4,
        repoPath: b,
        worktreePath: b,
        branch: 'task',
        baseCommit: repoB.base,
        mountPath: 'b',
      },
    ])
    const entered = held<void>(),
      release = held<void>()
    let heldFirst = false
    f.store.before = async (call) => {
      if (!heldFirst && call.method === 'exists' && call.reference === b) {
        heldFirst = true
        entered.resolve()
        await release.promise
      }
    }
    const operation = taskDiffProjection({ db: provider.db, workspaceReads: f.reads }, id)
    try {
      await entered.promise
      expect(f.store.calls.map((call) => [call.method, call.reference])).toEqual([
        ['exists', parent],
        ['exists', b],
      ])
    } finally {
      release.resolve()
    }
    const result = await operation
    expect(result.baseCommit).toBeNull()
    expect(result.truncated).toBe(false)
    expect(result.diff.indexOf('# === Repo: nested/a ===')).toBeLessThan(
      result.diff.indexOf('# === Repo: b ==='),
    )
    expect(result.diff).not.toContain('# === Repo: readonly ===')
    expect(f.store.calls.map((call) => [call.method, call.reference])).toEqual([
      ['exists', parent],
      ['exists', b],
      ['exists', a],
      ['exists', b],
      ['isGitWorkTree', b],
      ['isGitWorkTree', a],
      ['isGitWorkTree', b],
      ['gitDiffSnapshot', a],
      ['gitDiffSnapshot', b],
    ])
    expect(result.diff.endsWith('\n')).toBe(true)
  }, 60_000)

  test('multi-repo snapshot ACK, empty diff and original string-length truncation remain intact', async () => {
    const repo = await repository(),
      parent = 'cs-workspace:parent',
      ref = 'cs-workspace:large'
    const f = mapped(parent, temp())
    f.store.paths.set(ref, repo.root)
    const id = await seedTask(provider.db, parent, null)
    await provider.db.update(tasks).set({ repoCount: 2 }).where(eq(tasks.id, id))
    await provider.db.insert(taskRepos).values({
      taskId: id,
      repoIndex: 0,
      repoPath: ref,
      worktreePath: ref,
      branch: 'task',
      baseCommit: repo.base,
      mountPath: 'large',
    })
    writeFileSync(join(repo.root, 'tracked.txt'), '汉'.repeat(MAX_DIFF))
    const entered = held<void>(),
      release = held<void>()
    f.store.before = async (call) => {
      if (call.method === 'gitDiffSnapshot') {
        entered.resolve()
        await release.promise
      }
    }
    let finished = false
    const operation = taskDiffProjection({ db: provider.db, workspaceReads: f.reads }, id).then(
      (value) => {
        finished = true
        return value
      },
    )
    try {
      await entered.promise
      expect(finished).toBe(false)
    } finally {
      release.resolve()
    }
    const result = await operation
    expect(result.truncated).toBe(true)
    expect(result.diff.length).toBe(MAX_DIFF)
    expect(Buffer.byteLength(result.diff)).toBeGreaterThan(MAX_DIFF)
    expect(result.diff.startsWith('# === Repo: large ===\n')).toBe(true)
    f.store.before = undefined
    await runGit(repo.root, ['checkout', '--', 'tracked.txt'])
    rmSync(join(repo.root, '中文未跟踪.txt'))
    expect(await taskDiffProjection({ db: provider.db, workspaceReads: f.reads }, id)).toEqual({
      diff: '',
      baseCommit: null,
      truncated: false,
    })
  }, 60_000)

  test('selected errors retain identity and incomplete selections never run physical readers', async () => {
    const repo = await repository(),
      ref = 'cs-workspace:error',
      f = mapped(ref, repo.root)
    const id = await seedTask(provider.db, ref, repo.base)
    for (const method of ['isGitWorkTree', 'worktreeDiff'] as const) {
      const failure = new Error('selected ' + method + ' failure')
      f.store.before = (call) => {
        if (call.method === method) throw failure
      }
      await expect(
        taskDiffProjection({ db: provider.db, workspaceReads: f.reads }, id),
      ).rejects.toBe(failure)
    }
    f.store.calls.length = 0
    f.store.before = undefined
    for (const omitted of [
      'exists',
      'isGitWorkTree',
      'gitDiffSnapshot',
      'worktreeDiff',
      'isolationRoot',
    ] as const) {
      const incomplete = new Proxy(f.reads, {
        get(target, key, receiver) {
          return key === omitted ? undefined : Reflect.get(target, key, receiver)
        },
      })
      await expect(
        taskDiffProjection({ db: provider.db, workspaceReads: incomplete }, id),
      ).rejects.toThrow('Repository workspace reads require a complete query implementation')
    }
    await expect(
      taskDiffProjection(
        { db: provider.db, workspaceReads: null as unknown as RepositoryWorkspaceReadQueries },
        id,
      ),
    ).rejects.toThrow(TypeError)
    expect(f.store.calls).toEqual([])
    expect(
      await taskDiffProjection(
        { db: provider.db },
        await seedTask(provider.db, repo.root, repo.base),
      ),
    ).toEqual({
      ...(await selectRepositoryWorkspaceReadQueries().worktreeDiff(repo.root, repo.base)),
      baseCommit: repo.base,
    })
  }, 60_000)
})

describeEachProvider('RFC-370 S1 repair selected isolation reader handoff', (provider) => {
  async function scene() {
    const repo = await repository(),
      taskRef = 'cs-workspace:canonical'
    const f = mapped(taskRef, repo.root)
    f.store.paths.set(f.store.isolationRef, repo.root)
    const taskId = await seedTask(provider.db, taskRef, repo.base)
    const snapshot = {
      $schema_version: 4,
      inputs: [],
      nodes: [
        { id: 'src', kind: 'agent-single', agentName: 'doc' },
        { id: 'wrap', kind: 'wrapper-git', nodeIds: ['src', 'review'] },
        { id: 'review', kind: 'review', inputSource: { nodeId: 'src', portName: 'docpath' } },
      ],
      edges: [],
    }
    await provider.db
      .update(tasks)
      .set({ status: 'awaiting_review', workflowSnapshot: JSON.stringify(snapshot) })
      .where(eq(tasks.id, taskId))
    const oldWrapper = ulid(1),
      latestWrapper = ulid(2),
      source = ulid(),
      review = ulid(),
      alert = ulid()
    await provider.db.insert(nodeRuns).values([
      { id: oldWrapper, taskId, nodeId: 'wrap', status: 'done', isoWorktreePath: 'old:iso' },
      {
        id: latestWrapper,
        taskId,
        nodeId: 'wrap',
        status: 'running',
        isoWorktreePath: 'cs-workspace:persisted-generation',
      },
      { id: source, taskId, nodeId: 'src', status: 'done', finishedAt: 2 },
      { id: review, taskId, nodeId: 'review', status: 'awaiting_review' },
    ])
    await provider.db
      .insert(nodeRunOutputs)
      .values({ nodeRunId: source, portName: 'docpath', content: '# actual repaired document' })
    await provider.db.insert(lifecycleAlerts).values({
      id: alert,
      taskId,
      rule: 'S1',
      severity: 'error',
      detail: JSON.stringify({ rule: 'S1', repairHint: { kind: 'review', nodeRunId: review } }),
      detectedAt: 3,
    })
    const appHome = temp(),
      dispatched: string[] = []
    const native = createCollaborationRuntimeMechanics(provider.db)
    const collaborationRuntime: CollaborationRuntimeMechanics = {
      ...native,
      async dispatchReviewNode(input) {
        dispatched.push(input.scopeRoot)
        return await native.dispatchReviewNode({
          ...input,
          scopeRoot: f.store.paths.get(input.scopeRoot)!,
        })
      },
    }
    const engine = createRepairEngine(provider.db, {
      appHome,
      workspaceReads: f.reads,
      collaborationRuntime,
    })
    return { ...f, taskId, alert, review, appHome, latestWrapper, dispatched, engine }
  }

  test('held root/presence/probe ACKs use latest persisted wrapper ref and produce a real repaired document', async () => {
    for (const method of ['isolationRoot', 'exists', 'isGitWorkTree'] as const) {
      const f = await scene(),
        entered = held<void>(),
        release = held<void>()
      f.store.before = async (call) => {
        if (call.method === method) {
          entered.resolve()
          await release.promise
        }
      }
      let finished = false
      const operation = f.engine
        .applyRepairOption({
          taskId: f.taskId,
          alertId: f.alert,
          optionId: 'S1.recreate-doc-version',
        })
        .then((value) => {
          finished = true
          return value
        })
      try {
        await entered.promise
        expect(finished).toBe(false)
        expect(f.dispatched).toEqual([])
        expect(
          await provider.db
            .select()
            .from(lifecycleRepairAudit)
            .where(eq(lifecycleRepairAudit.taskId, f.taskId)),
        ).toEqual([])
      } finally {
        release.resolve()
      }
      expect((await operation).outcome).toBe('success')
      expect(f.dispatched).toEqual([f.store.isolationRef])
      expect(f.store.calls[0]).toEqual({
        method: 'isolationRoot',
        reference: f.appHome,
        argument: {
          storageRootRef: f.appHome,
          taskId: f.taskId,
          nodeRunId: f.latestWrapper,
          persistedWorkspaceRef: 'cs-workspace:persisted-generation',
        },
      })
      expect(f.store.calls.slice(0, 3).map((call) => call.method)).toEqual([
        'isolationRoot',
        'exists',
        'isGitWorkTree',
      ])
      const documents = await provider.db
        .select()
        .from(docVersions)
        .where(eq(docVersions.reviewNodeRunId, f.review))
      expect(documents.some((row) => row.decision === 'pending')).toBe(true)
      const audit = await provider.db
        .select()
        .from(lifecycleRepairAudit)
        .where(eq(lifecycleRepairAudit.taskId, f.taskId))
      expect(audit[0]!.optionId).toBe('S1.recreate-doc-version')
      expect(audit[0]!.outcome).toBe('success')
    }
  }, 60_000)

  test('missing and non-Git isolation use canonical ref in the original short-circuit order', async () => {
    for (const exists of [false, true]) {
      const f = await scene(),
        invalid = join(temp(), 'invalid')
      if (exists) mkdirSync(invalid)
      f.store.paths.set(f.store.isolationRef, invalid)
      expect(
        (
          await f.engine.applyRepairOption({
            taskId: f.taskId,
            alertId: f.alert,
            optionId: 'S1.recreate-doc-version',
          })
        ).outcome,
      ).toBe('success')
      expect(f.dispatched).toEqual(['cs-workspace:canonical'])
      expect(f.store.calls.map((call) => call.method)).toEqual(
        exists ? ['isolationRoot', 'exists', 'isGitWorkTree'] : ['isolationRoot', 'exists'],
      )
    }
  }, 60_000)

  test('selected root/presence/probe rejection preserves identity, without native fallback or repair writes', async () => {
    for (const method of ['isolationRoot', 'exists', 'isGitWorkTree'] as const) {
      const f = await scene(),
        failure = new Error('selected repair ' + method)
      f.store.before = (call) => {
        if (call.method === method) throw failure
      }
      await expect(
        f.engine.applyRepairOption({
          taskId: f.taskId,
          alertId: f.alert,
          optionId: 'S1.recreate-doc-version',
        }),
      ).rejects.toBe(failure)
      expect(f.dispatched).toEqual([])
      expect(
        await provider.db
          .select()
          .from(lifecycleRepairAudit)
          .where(eq(lifecycleRepairAudit.taskId, f.taskId)),
      ).toEqual([])
      expect(
        await provider.db.select().from(docVersions).where(eq(docVersions.taskId, f.taskId)),
      ).toEqual([])
    }
  }, 60_000)
})

test('native isolation derivation preserves persisted physical generation and legacy row fallback', async () => {
  const native = selectRepositoryWorkspaceReadQueries(),
    root = temp()
  const input = {
    storageRootRef: root,
    taskId: 'task',
    nodeRunId: 'legacy-row',
    persistedWorkspaceRef: join(root, 'previous', 'generation'),
  }
  expect(await native.isolationRoot(input)).toBe(join(root, 'iso', 'task', 'generation'))
  expect(await native.isolationRoot({ ...input, persistedWorkspaceRef: null })).toBe(
    join(root, 'iso', 'task', 'legacy-row'),
  )
  expect(await native.isolationRoot({ ...input, persistedWorkspaceRef: '' })).toBe(
    join(root, 'iso', 'task', 'legacy-row'),
  )
})
