import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import type { CreateRepoGroup, RepoGroupNodeInput } from '@agent-workflow/shared'
import { composeRepositoryGroups } from '@/modules/source-control/composition'
import { RepoGroupHasReferencesError } from '@/modules/source-control/application/repositoryGroups'
import { DrizzleRepositoryWorkspaceStore } from '@/modules/source-control/infrastructure/repositoryWorkspaceStore'
import type { RepositoryWorkspaceStore } from '@/modules/source-control/ports/repositoryWorkspaceStore'
import { composeSourceControlTaskPorts } from '@/modules/task-execution/composition'
import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { describeEachProvider } from './helpers/eachProvider'
import type { RecordedStatement } from './helpers/statementRecorder'

const repositoryNode = (path = '', cachedRepoId = 'repo'): RepoGroupNodeInput => ({
  path,
  attachment: { kind: 'repo', cachedRepoId, ref: 'main', subdir: '', readonly: false },
})
const childNode = (path: string, childGroupId: string, readonly = false): RepoGroupNodeInput => ({
  path,
  attachment: { kind: 'group', childGroupId, readonly },
})
const directory = (path = ''): RepoGroupNodeInput => ({ path, attachment: null })
const draft = (
  name: string,
  nodes: RepoGroupNodeInput[] = [repositoryNode()],
): CreateRepoGroup => ({
  name,
  description: `description of ${name}`,
  nodes,
})

describeEachProvider('RFC-602 bounded repository-group queries', (harness) => {
  function store() {
    return new DrizzleRepositoryWorkspaceStore(
      harness.db,
      composeSourceControlTaskPorts(harness.db),
    )
  }

  function operations(workspaceStore: RepositoryWorkspaceStore = store()) {
    return composeRepositoryGroups({
      store: workspaceStore,
      mirrors: {
        async refs() {
          throw new Error('unexpected Git refs read')
        },
        async files() {
          throw new Error('unexpected Git files read')
        },
        registration: {
          kind: 'remote',
          async register() {
            throw new Error('preview must not import URLs')
          },
          async refresh() {
            throw new Error('unexpected mirror refresh')
          },
        },
      },
      async cloneTimeoutMs() {
        throw new Error('unexpected clone configuration read')
      },
    })
  }

  async function seedRepository(id = 'repo') {
    const { cachedRepos } = tablesOf(harness.db)
    await insertOne(harness.db, cachedRepos, {
      id,
      urlHash: `hash-${id}`,
      urlRedacted: `https://example.test/${id}.git`,
      localPath: `/unused/${id}`,
      defaultBranch: 'main',
      lastFetchedAt: 1,
      createdAt: 1,
    })
  }

  async function seedGroup(id: string, nodes: RepoGroupNodeInput[], name = id) {
    const { repoGroups, repoGroupNodes } = tablesOf(harness.db)
    await insertOne(harness.db, repoGroups, {
      id,
      name,
      version: 1,
      createdAt: 1,
      updatedAt: 1,
      schemaVersion: 2,
    })
    if (nodes.length > 0)
      await harness.db.insert(repoGroupNodes).values(
        nodes.map(({ path, attachment }) => ({
          groupId: id,
          path,
          attachmentKind: attachment?.kind ?? null,
          cachedRepoId: attachment?.kind === 'repo' ? attachment.cachedRepoId : null,
          childGroupId: attachment?.kind === 'group' ? attachment.childGroupId : null,
          ref: attachment?.kind === 'repo' ? attachment.ref : '',
          subdir: attachment?.kind === 'repo' ? attachment.subdir : '',
          readonly: attachment?.readonly ?? false,
        })),
      )
  }

  async function seedMemory(
    id: string,
    groupId: string,
    status: 'approved' | 'candidate' | 'superseded' | 'rejected' | 'archived' = 'approved',
  ) {
    const { memories } = tablesOf(harness.db)
    await insertOne(harness.db, memories, {
      id,
      scopeType: 'repo_group',
      scopeId: groupId,
      title: id,
      bodyMd: 'body',
      tags: '[]',
      status,
      sourceKind: 'manual',
      createdAt: 1,
    })
  }

  async function seedSchedule(id: string, payload: string, enabled = true) {
    const { scheduledTasks } = tablesOf(harness.db)
    await insertOne(harness.db, scheduledTasks, {
      id,
      name: id,
      ownerUserId: 'u1',
      launchKind: 'workflow',
      launchPayload: payload,
      scheduleSpec: JSON.stringify({ kind: 'interval', everyMs: 60_000, tz: 'UTC' }),
      enabled,
      nextRunAt: enabled ? 60_001 : null,
      createdAt: 1,
      updatedAt: 1,
    })
  }

  // Unrelated graph, cached URLs, memories and schedules all grow together. Batch sizes stay
  // below either provider's bind limit; none of these fixtures participate in the requested graph.
  async function seedNoise(count = 120) {
    const { repoGroups, repoGroupNodes, cachedRepos, memories, scheduledTasks } = tablesOf(
      harness.db,
    )
    for (let start = 0; start < count; start += 40) {
      const ids = Array.from(
        { length: Math.min(40, count - start) },
        (_, n) => `noise-${start + n}`,
      )
      await harness.db.insert(cachedRepos).values(
        ids.map((id) => ({
          id,
          urlHash: `hash-${id}`,
          urlRedacted: `https://example.test/${id}.git`,
          localPath: `/unused/${id}`,
          lastFetchedAt: 1,
          createdAt: 1,
        })),
      )
      await harness.db.insert(repoGroups).values(
        ids.map((id) => ({
          id,
          name: id,
          version: 1,
          createdAt: 1,
          updatedAt: 1,
          schemaVersion: 2,
        })),
      )
      await harness.db.insert(repoGroupNodes).values(
        ids.flatMap((id) => [
          { groupId: id, path: '', attachmentKind: 'repo' as const, cachedRepoId: id },
          { groupId: id, path: 'empty', attachmentKind: null, cachedRepoId: null },
        ]),
      )
      await harness.db.insert(memories).values(
        ids.map((id) => ({
          id,
          scopeType: 'repo_group' as const,
          scopeId: id,
          title: id,
          bodyMd: 'body',
          tags: '[]',
          status: 'approved' as const,
          sourceKind: 'manual' as const,
          createdAt: 1,
        })),
      )
      await harness.db.insert(scheduledTasks).values(
        ids.map((id) => ({
          id,
          name: id,
          ownerUserId: 'u1',
          launchKind: 'workflow' as const,
          launchPayload: JSON.stringify({ repoGroupId: id }),
          scheduleSpec: JSON.stringify({ kind: 'interval', everyMs: 60_000, tz: 'UTC' }),
          enabled: true,
          createdAt: 1,
          updatedAt: 1,
        })),
      )
    }
  }

  async function measured<T>(run: () => Promise<T>) {
    const recording = harness.recordStatements()
    try {
      const value = await run()
      // The original recorder sees CTE statements; selects() only recognizes SELECT.
      const reads = recording.statements.filter(({ sql }) => /^[\s(]*(?:select|with)\b/i.test(sql))
      return { value, reads, rows: reads.reduce((sum, read) => sum + read.rows, 0) }
    } finally {
      recording.stop()
    }
  }

  function graphReads(reads: readonly RecordedStatement[]) {
    return reads.filter(({ sql }) => /^\s*with\b/i.test(sql))
  }

  async function nestedFixture() {
    await seedRepository()
    await seedGroup('leaf', [repositoryNode()])
    await seedGroup('empty', [directory(), directory('notes')])
    await seedGroup('root', [
      directory(),
      childNode('code', 'leaf', true),
      childNode('docs', 'empty'),
    ])
    await seedMemory('root-memory', 'root')
  }

  test('get, layout and preview keep their output and returned-row budgets as unrelated data grows', async () => {
    await nestedFixture()
    const groups = operations()
    const preview = () => groups.preview({ nodes: [directory(), childNode('nested', 'root')] })
    const before = [
      await measured(() => groups.get('root')),
      await measured(() => groups.layout('root')),
      await measured(preview),
    ]
    expect(before[0]!.value).toMatchObject({ id: 'root', flatRepoCount: 1, boundMemories: 1 })
    expect(before[1]!.value).toMatchObject({ totalRepos: 1, maxDepth: 1 })
    expect(before[1]!.value).toHaveProperty('repos.0.readonly', true)
    expect(before[1]!.value).toHaveProperty('repos.0.mountPath', 'code')
    await seedNoise()
    const after = [
      await measured(() => groups.get('root')),
      await measured(() => groups.layout('root')),
      await measured(preview),
    ]
    for (let i = 0; i < before.length; i += 1) {
      expect(after[i]!.value).toEqual(before[i]!.value)
      expect(after[i]!.rows).toBe(before[i]!.rows)
      expect(graphReads(after[i]!.reads)).toHaveLength(3)
      expect(
        graphReads(after[i]!.reads)
          .map((read) => read.rows)
          .sort((a, b) => a - b),
      ).toEqual([1, 3, 6])
      expect(after[i]!.reads.some(({ sql }) => /scheduled_tasks/i.test(sql))).toBe(false)
    }
    expect(after.map((result) => result.reads.length)).toEqual([4, 3, 3])
    expect(
      after.slice(1).every((result) => result.reads.every(({ sql }) => !/memories/i.test(sql))),
    ).toBe(true)
  })

  test('list preserves all groups and memory counts while loading only referenced repository URLs', async () => {
    await nestedFixture()
    await seedNoise(12)
    await seedRepository('unreferenced')
    for (const status of ['candidate', 'superseded', 'rejected', 'archived'] as const)
      await seedMemory(`root-${status}`, 'root', status)
    const result = await measured(() => operations().list())
    expect(result.value).toHaveLength(15)
    expect(result.value.find((group) => group.id === 'root')).toMatchObject({
      flatRepoCount: 1,
      boundMemories: 4,
    })
    expect(result.value.find((group) => group.id === 'empty')).toMatchObject({
      flatRepoCount: 0,
      boundMemories: 0,
    })
    expect(result.value.map((group) => group.name)).toEqual(
      [...result.value.map((group) => group.name)].sort(),
    )
    expect(result.reads).toHaveLength(4)
    expect(result.reads.some(({ sql }) => /scheduled_tasks/i.test(sql))).toBe(false)
    expect(
      graphReads(result.reads)
        .map((read) => read.rows)
        .sort((a, b) => a - b),
    ).toEqual([13, 15, 30])
    expect(result.reads.find(({ sql }) => /memories/i.test(sql))?.rows).toBe(13)
  })

  test('direct and pending previews need no stored graph, and missing references keep their errors', async () => {
    await seedRepository()
    await seedNoise(12)
    const groups = operations()
    const pending = await measured(() =>
      groups.preview({
        nodes: [
          {
            path: '',
            attachment: {
              kind: 'repo',
              repoUrl: 'https://example.test/pending.git',
              ref: '',
              subdir: '',
              readonly: false,
            },
          },
        ],
      }),
    )
    expect(pending.value).toMatchObject({
      totalRepos: 1,
      pendingImports: 1,
      pendingRepoPaths: [''],
      repos: [],
    })
    expect(pending.reads).toHaveLength(0)
    const direct = await measured(() => groups.preview({ nodes: [repositoryNode()] }))
    expect(direct.value).toMatchObject({ totalRepos: 1, pendingImports: 0 })
    expect(direct.reads).toHaveLength(1)
    expect(direct.rows).toBe(1)
    await expect(groups.preview({ nodes: [childNode('', 'missing')] })).rejects.toMatchObject({
      code: 'repo-group-not-found',
    })
    // Preview historically preserves an unresolved cached ID with an empty display URL;
    // only saving requires the repository to exist.
    expect(await groups.preview({ nodes: [repositoryNode('', 'missing')] })).toMatchObject({
      totalRepos: 1,
      repos: [{ cachedRepoId: 'missing', repoUrlRedacted: '' }],
    })
    await expect(groups.get('missing')).rejects.toMatchObject({ code: 'repo-group-not-found' })
    await expect(groups.layout('missing')).rejects.toMatchObject({ code: 'repo-group-not-found' })
  })

  test('an oversized draft is rejected before building a database parameter list', async () => {
    const recording = harness.recordStatements()
    try {
      await expect(
        operations().preview({
          nodes: [
            directory(),
            ...Array.from({ length: 33_000 }, (_, i) => childNode(`child-${i}`, `group-${i}`)),
          ],
        }),
      ).rejects.toMatchObject({ code: 'repo-group-node-limit' })
      expect(recording.statements).toHaveLength(0)
    } finally {
      recording.stop()
    }
  })

  test('create and replace retain duplicate-name, missing-member, empty-group and version behavior', async () => {
    await seedRepository()
    await seedNoise(12)
    const groups = operations()
    const created = await measured(() => groups.create(draft('created'), null))
    expect(created.value).toMatchObject({ name: 'created', version: 1, flatRepoCount: 1 })
    // The only whole-set reads are thin name/version indexes. No unrelated nodes or URLs cross the port.
    expect(graphReads(created.reads).reduce((sum, read) => sum + read.rows, 0)).toBe(4)
    expect(created.reads.some(({ sql }) => /scheduled_tasks/i.test(sql))).toBe(false)
    await expect(groups.create(draft('CREATED'), null)).rejects.toMatchObject({
      code: 'repo-group-name-conflict',
    })
    await expect(
      groups.create(draft('missing-child', [childNode('', 'missing')]), null),
    ).rejects.toMatchObject({ code: 'repo-group-member-not-found' })
    await expect(
      groups.create(draft('missing-repo', [repositoryNode('', 'missing')]), null),
    ).rejects.toMatchObject({ code: 'repo-group-member-not-found' })
    await expect(groups.create(draft('empty-write', [directory()]), null)).rejects.toMatchObject({
      code: 'repo-group-empty',
    })
    const replacement = await groups.update(created.value.id, draft('renamed'), 1)
    expect(replacement).toMatchObject({ name: 'renamed', version: 2 })
    await expect(groups.update(created.value.id, draft('stale'), 1)).rejects.toMatchObject({
      code: 'resource-operation-stale',
    })
    await expect(groups.update('missing', draft('missing'))).rejects.toMatchObject({
      code: 'repo-group-not-found',
    })
    expect(await groups.get(created.value.id)).toEqual(replacement)
  })

  test('replace loads all ancestors, sibling descendants and new draft children before validating conflicts', async () => {
    await seedRepository()
    await seedGroup('target', [repositoryNode()])
    await seedGroup('sibling-leaf', [repositoryNode()])
    await seedGroup('sibling', [childNode('', 'sibling-leaf')])
    await seedGroup('parent', [
      directory(),
      childNode('base', 'target'),
      childNode('base/dup', 'sibling'),
    ])
    await seedGroup('cousin', [repositoryNode()])
    await seedGroup('grandparent', [
      directory(),
      childNode('tree', 'parent'),
      childNode('other', 'cousin'),
    ])
    await seedGroup('new-child', [repositoryNode()])
    await seedNoise(12)
    const workspaceStore = store()
    const closure = await workspaceStore.readRepositoryGroupGraph({
      scope: { kind: 'reachable', rootIds: ['target', 'new-child'], ancestorsOf: 'target' },
    })
    expect(closure.groups.map((group) => group.id).sort()).toEqual([
      'cousin',
      'grandparent',
      'new-child',
      'parent',
      'sibling',
      'sibling-leaf',
      'target',
    ])
    expect(closure.repoUrls.size).toBe(1)
    const groups = operations(workspaceStore)
    const update = await measured(() =>
      groups.update(
        'target',
        draft('target', [repositoryNode(), childNode('extra', 'new-child')]),
        1,
      ),
    )
    const changed = update.value
    expect(
      graphReads(update.reads)
        .map((read) => read.rows)
        .sort((a, b) => a - b),
    ).toEqual([1, 1, 2, 3, 7, 11])
    expect(update.reads.some(({ sql }) => /scheduled_tasks/i.test(sql))).toBe(false)
    expect(changed.version).toBe(2)
    expect((await groups.layout('grandparent')).repos.map((repo) => repo.mountPath).sort()).toEqual(
      ['other', 'tree/base', 'tree/base/dup', 'tree/base/extra'],
    )
    await expect(
      groups.update('target', draft('target', [repositoryNode(), repositoryNode('dup')]), 2),
    ).rejects.toMatchObject({ code: 'repo-group-attachment-conflict' })
    expect(await groups.get('target')).toEqual(changed)
    await expect(
      groups.update('target', draft('target', [childNode('', 'target')]), 2),
    ).rejects.toMatchObject({ code: 'repo-group-cycle' })
  })

  test('recursive scope terminates cycles and the domain still rejects cycles, depth and expansion limits', async () => {
    await seedRepository()
    await seedGroup('cycle-a', [])
    await seedGroup('cycle-b', [childNode('', 'cycle-a')])
    const { repoGroupNodes } = tablesOf(harness.db)
    await insertOne(harness.db, repoGroupNodes, {
      groupId: 'cycle-a',
      path: '',
      attachmentKind: 'group',
      childGroupId: 'cycle-b',
    })
    const cycle = await measured(() =>
      store().readRepositoryGroupGraph({ scope: { kind: 'reachable', rootIds: ['cycle-a'] } }),
    )
    expect(cycle.value.groups.map((group) => group.id)).toEqual(['cycle-a', 'cycle-b'])
    expect(cycle.value.nodes).toHaveLength(2)
    const groups = operations()
    await expect(groups.layout('cycle-a')).rejects.toMatchObject({ code: 'repo-group-cycle' })
    expect(await groups.get('cycle-a')).toMatchObject({ flatRepoCount: 0 })
    for (let depth = 6; depth >= 0; depth -= 1)
      await seedGroup(
        `depth-${depth}`,
        depth === 6 ? [repositoryNode()] : [childNode('', `depth-${depth + 1}`)],
      )
    await expect(groups.layout('depth-0')).rejects.toMatchObject({
      code: 'repo-group-depth-exceeded',
    })
    await seedGroup('wide', [
      directory(),
      ...Array.from({ length: 33 }, (_, i) => repositoryNode(`repo-${i}`)),
    ])
    await expect(groups.layout('wide')).rejects.toMatchObject({ code: 'repo-group-too-many-repos' })
    await expect(
      groups.create(
        draft('too-many-nodes', [
          repositoryNode(),
          ...Array.from({ length: 128 }, (_, i) => directory(`dir-${i}`)),
        ]),
        null,
      ),
    ).rejects.toMatchObject({ code: 'repo-group-node-limit' })
  })

  test('a diamond loads each stored group once while preserving both mounted paths and directory-only descendants', async () => {
    await seedRepository()
    await seedGroup('shared', [repositoryNode(), directory('notes')])
    await seedGroup('left', [childNode('', 'shared', true)])
    await seedGroup('right', [childNode('', 'shared')])
    await seedGroup('diamond', [
      directory(),
      childNode('left', 'left'),
      childNode('right', 'right'),
    ])
    const result = await measured(() => operations().layout('diamond'))
    expect(result.value).toMatchObject({ totalRepos: 2, maxDepth: 2 })
    expect(result.value.repos.map((repo) => [repo.mountPath, repo.readonly])).toEqual([
      ['left', true],
      ['right', false],
    ])
    expect(result.value.nodes.map((node) => node.path)).toEqual([
      '',
      'left',
      'left/notes',
      'right',
      'right/notes',
    ])
    expect(
      graphReads(result.reads)
        .map((read) => read.rows)
        .sort((a, b) => a - b),
    ).toEqual([1, 4, 7])
  })

  test('exact depth, repository and flattened-directory limits remain inclusive', async () => {
    await seedRepository()
    const groups = operations()
    for (let depth = 5; depth >= 0; depth -= 1)
      await seedGroup(
        `depth-ok-${depth}`,
        depth === 5 ? [repositoryNode()] : [childNode('', `depth-ok-${depth + 1}`)],
      )
    expect(await groups.layout('depth-ok-0')).toMatchObject({ totalRepos: 1, maxDepth: 5 })
    await seedGroup('repos-ok', [
      directory(),
      ...Array.from({ length: 32 }, (_, i) => repositoryNode(`repo-${i}`)),
    ])
    expect(await groups.layout('repos-ok')).toMatchObject({ totalRepos: 32 })
    // Two groups with 128 definition nodes each overlap at the attached root; one
    // sibling directory raises the flattened node count from 255 to exactly 256.
    await seedGroup('dirs-child', [
      repositoryNode(),
      ...Array.from({ length: 127 }, (_, i) => directory(`leaf-${i}`)),
    ])
    await seedGroup('dirs-parent', [
      directory(),
      childNode('branch', 'dirs-child'),
      ...Array.from({ length: 126 }, (_, i) => directory(`parent-${i}`)),
    ])
    await seedGroup('dirs-root', [childNode('', 'dirs-parent'), directory('extra')])
    expect(await groups.layout('dirs-root')).toMatchObject({ totalRepos: 1, totalNodes: 256 })
    await seedGroup('dirs-over', [childNode('', 'dirs-root'), directory('overflow')])
    await expect(groups.layout('dirs-over')).rejects.toMatchObject({
      code: 'repo-group-node-limit',
    })
  })

  test('delete uses exact parent and enabled schedule candidates, preserving force side effects', async () => {
    await seedRepository()
    await seedGroup('target', [repositoryNode()])
    await seedGroup('parent', [directory(), childNode('one', 'target'), childNode('two', 'target')])
    await seedMemory('memory', 'target')
    await seedSchedule('direct', JSON.stringify({ repoGroupId: 'target' }))
    await seedSchedule('nested', JSON.stringify({ body: { repoGroupId: 'target' } }))
    await seedSchedule('disabled', JSON.stringify({ repoGroupId: 'target' }), false)
    await seedSchedule('false-positive', JSON.stringify({ other: { repoGroupId: 'target' } }))
    await seedSchedule('malformed', '{"repoGroupId":"target",')
    await seedNoise()
    const groups = operations()
    const rejection = await measured(async () => {
      try {
        await groups.remove('target', { force: false })
      } catch (error) {
        return error
      }
      throw new Error('expected referenced deletion to fail')
    })
    const error = rejection.value
    expect(error).toBeInstanceOf(RepoGroupHasReferencesError)
    if (!(error instanceof RepoGroupHasReferencesError))
      throw new Error('expected group references error')
    expect(error.code).toBe('repo-group-has-references')
    expect(error.referencingGroups).toEqual([{ id: 'parent', name: 'parent' }])
    // Compare ordinary values directly: Bun's Error/toMatchObject path can
    // replace a custom array property with the asymmetric matcher itself.
    expect([...error.referencingSchedules].sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: 'direct', name: 'direct' },
      { id: 'nested', name: 'nested' },
    ])
    expect(rejection.reads).toHaveLength(3)
    expect(rejection.reads.find(({ sql }) => /scheduled_tasks/i.test(sql))?.rows).toBe(4)
    expect(rejection.reads.find(({ sql }) => /repo_group_nodes/i.test(sql))?.rows).toBe(1)
    expect(rejection.reads.some(({ sql }) => /cached_repos|memories/i.test(sql))).toBe(false)
    expect(await groups.remove('target', { force: true })).toEqual({
      archivedMemories: 1,
      detachedReferences: 2,
      disabledSchedules: 2,
    })
    const { memories, scheduledTasks } = tablesOf(harness.db)
    expect(
      (await harness.db.select().from(memories).where(eq(memories.id, 'memory')))[0]?.status,
    ).toBe('archived')
    const schedules = await harness.db.select().from(scheduledTasks)
    for (const id of ['direct', 'nested'])
      expect(schedules.find((schedule) => schedule.id === id)).toMatchObject({
        enabled: false,
        nextRunAt: null,
      })
    for (const id of ['false-positive', 'malformed', 'noise-0'])
      expect(schedules.find((schedule) => schedule.id === id)?.enabled).toBe(true)
    expect((await groups.get('parent')).nodes.every((node) => node.attachment === null)).toBe(true)
    await expect(groups.remove('missing', { force: true })).rejects.toMatchObject({
      code: 'repo-group-not-found',
    })
  })

  test('schedule candidate filtering treats wildcard characters in an ID literally', async () => {
    await seedRepository()
    await seedGroup('target_%', [repositoryNode()])
    await seedSchedule('match', JSON.stringify({ repoGroupId: 'target_%' }))
    await seedSchedule('different', JSON.stringify({ repoGroupId: 'target-other' }))
    const references = await measured(() => store().readRepositoryGroupReferences('target_%'))
    expect(references.value.schedules.map((schedule) => schedule.id)).toEqual(['match'])
    expect(references.reads.find(({ sql }) => /scheduled_tasks/i.test(sql))?.rows).toBe(1)
    expect(await operations().remove('target_%', { force: true })).toMatchObject({
      disabledSchedules: 1,
    })
    const { scheduledTasks } = tablesOf(harness.db)
    expect(
      (await harness.db.select().from(scheduledTasks).where(eq(scheduledTasks.id, 'different')))[0]
        ?.enabled,
    ).toBe(true)
  })

  for (const operation of ['update', 'delete'] as const) {
    for (const concurrentChange of [
      'new-parent',
      'unrelated-version',
      'unrelated-removal',
    ] as const) {
      test(`${operation} retains whole-graph OCC for a concurrent ${concurrentChange}`, async () => {
        await seedRepository()
        await seedGroup('target', [repositoryNode()])
        await seedGroup('unrelated', [repositoryNode()])
        const { repoGroups } = tablesOf(harness.db)
        const mutate = async () => {
          if (concurrentChange === 'new-parent')
            await seedGroup('new-parent', [childNode('', 'target')])
          else if (concurrentChange === 'unrelated-version')
            await harness.db
              .update(repoGroups)
              .set({ version: 2 })
              .where(eq(repoGroups.id, 'unrelated'))
          else await harness.db.delete(repoGroups).where(eq(repoGroups.id, 'unrelated'))
        }
        class InterleavingStore extends DrizzleRepositoryWorkspaceStore {
          override async updateRepositoryGroup(
            input: Parameters<RepositoryWorkspaceStore['updateRepositoryGroup']>[0],
          ) {
            await mutate()
            return super.updateRepositoryGroup(input)
          }
          override async deleteRepositoryGroup(
            input: Parameters<RepositoryWorkspaceStore['deleteRepositoryGroup']>[0],
          ) {
            await mutate()
            return super.deleteRepositoryGroup(input)
          }
        }
        const groups = operations(
          new InterleavingStore(harness.db, composeSourceControlTaskPorts(harness.db)),
        )
        const before = await groups.get('target')
        const command =
          operation === 'update'
            ? groups.update('target', draft('changed'), 1)
            : groups.remove('target', { force: true })
        await expect(command).rejects.toMatchObject({ code: 'resource-operation-stale' })
        expect(await groups.get('target')).toEqual(before)
        if (concurrentChange === 'new-parent')
          expect(await operations().get('new-parent')).toMatchObject({ flatRepoCount: 1 })
      })
    }
  }
})
