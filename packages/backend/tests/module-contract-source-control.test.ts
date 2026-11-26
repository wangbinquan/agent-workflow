import { expect, test } from 'bun:test'
import type { CreateRepoGroup } from '@agent-workflow/shared'
import { composeRepositoryGroups } from '@/modules/source-control/composition'
import { DrizzleRepositoryWorkspaceStore } from '@/modules/source-control/infrastructure/repositoryWorkspaceStore'
import { composeSourceControlTaskPorts } from '@/modules/task-execution/composition'
import { describeEachProvider } from './helpers/eachProvider'

describeEachProvider('source-control composed repository group contract', (harness) => {
  async function setup() {
    const store = new DrizzleRepositoryWorkspaceStore(
      harness.db,
      composeSourceControlTaskPorts(harness.db),
    )
    await store.insertCachedRepo({
      id: 'contract-repository',
      urlHash: 'contract-hash',
      urlEnc: null,
      urlRedacted: 'https://example.test/team/repository.git',
      localPath: '/unused/contract-repository',
      defaultBranch: 'main',
      lastFetchedAt: 1,
      createdAt: 1,
      hasSubmodules: false,
      lastSubmoduleSyncOk: null,
      lastSubmoduleSyncError: null,
      lastAutoRefreshAt: null,
    })
    const groups = composeRepositoryGroups({
      store,
      mirrors: {
        async refs() {
          throw new Error('group layouts do not read Git refs')
        },
        async files() {
          throw new Error('group layouts do not enumerate files')
        },
        registration: {
          kind: 'remote',
          async register() {
            throw new Error('a draft must not import its pending repository')
          },
          async refresh() {
            throw new Error('group layouts do not refresh repositories')
          },
        },
      },
      async cloneTimeoutMs() {
        throw new Error('remote group operations do not read clone configuration')
      },
    })
    return { store, groups }
  }

  const draft = (name: string): CreateRepoGroup => ({
    name,
    description: 'contract group',
    nodes: [
      {
        path: '',
        attachment: {
          kind: 'repo',
          cachedRepoId: 'contract-repository',
          ref: 'main',
          subdir: '',
          readonly: false,
        },
      },
    ],
  })

  test('nested draft preview keeps URL imports pending and uses one fixed database snapshot', async () => {
    const { groups } = await setup()
    const child = await groups.create(draft('child'), null)
    const before = await groups.list()
    const recording = harness.recordStatements()
    try {
      const preview = await groups.preview({
        name: 'draft',
        nodes: [
          { path: '', attachment: null },
          {
            path: 'existing',
            attachment: { kind: 'group', childGroupId: child.id, readonly: false },
          },
          {
            path: 'pending',
            attachment: {
              kind: 'repo',
              repoUrl: 'https://example.test/team/pending.git',
              ref: '',
              subdir: '',
              readonly: false,
            },
          },
        ],
      })
      expect(preview).toMatchObject({
        totalRepos: 2,
        pendingImports: 1,
        pendingRepoPaths: ['pending'],
      })
      expect(preview.repos).toHaveLength(1)
      expect(preview.repos[0]).toMatchObject({
        mountPath: 'existing',
        cachedRepoId: 'contract-repository',
      })
      // One graph snapshot: groups, nodes, repositories, bound-memory counts and schedules.
      expect(recording.selects()).toHaveLength(5)
    } finally {
      recording.stop()
    }
    expect(await groups.list()).toEqual(before)
  })

  test('stale replacement leaves both the winning metadata and its flattened nodes intact', async () => {
    const { groups } = await setup()
    const created = await groups.create(draft('original'), null)
    const winner = await groups.update(created.id, draft('winner'), created.version)
    expect(winner.version).toBe(created.version + 1)
    const beforeLayout = await groups.layout(created.id)
    await expect(
      groups.update(
        created.id,
        {
          ...draft('loser'),
          nodes: [
            {
              path: '',
              attachment: {
                kind: 'repo',
                cachedRepoId: 'contract-repository',
                ref: 'loser-branch',
                subdir: '',
                readonly: true,
              },
            },
          ],
        },
        created.version,
      ),
    ).rejects.toMatchObject({ code: 'resource-operation-stale' })
    expect(await groups.get(created.id)).toEqual(winner)
    expect(await groups.layout(created.id)).toEqual(beforeLayout)
    await expect(groups.layout('missing-group')).rejects.toMatchObject({
      code: 'repo-group-not-found',
    })
  })
})
