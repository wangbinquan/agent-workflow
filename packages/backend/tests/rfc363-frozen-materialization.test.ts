// RFC-363: durable commits must control real Git effects after branch/group edits.
import { afterEach, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StartTaskSchema } from '@agent-workflow/shared'
import { ulid } from 'ulid'
import { composeRepositoryWorkspaceStore } from '@/modules/source-control/composition'
import {
  cleanupMaterializedSpace,
  materializeSpaceWithProvider,
  type ResolvedRepoSource,
} from '@/modules/source-control/infrastructure/workspaceMaterializer'
import { describeEachProvider } from './helpers/eachProvider'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function repository() {
  const root = mkdtempSync(join(tmpdir(), 'rfc363-frozen-'))
  roots.push(root)
  const repo = join(root, 'repo')
  mkdirSync(repo)
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()
  git('init', '-q', '-b', 'main')
  const commit = (text: string) => {
    writeFileSync(join(repo, 'a.txt'), text)
    git('add', 'a.txt')
    git('-c', 'user.name=RFC363', '-c', 'user.email=rfc363@example.test', 'commit', '-qm', text)
    return git('rev-parse', 'HEAD')
  }
  const base = commit('frozen')
  const source: ResolvedRepoSource = {
    repoPath: repo,
    baseBranch: 'main',
    resolvedCommit: base,
    repoUrl: 'https://example.test/repo.git',
    cachedRepoId: 'repo',
    pathFetchError: null,
    ffWarnings: [],
  }
  return { root, repo, base, commit, source, git }
}

describeEachProvider('RFC-363 frozen materialization', (harness) => {
  test('the frozen commit, not the moved branch, controls a single worktree and its occupancy check', async () => {
    const f = repository()
    f.commit('new head')
    // The current branch now has a reserved path, which must not poison the
    // already frozen old tree's admission/occupancy decision.
    mkdirSync(join(f.repo, '.agent-workflow'))
    writeFileSync(join(f.repo, '.agent-workflow', 'tracked'), 'new head only')
    f.git('add', '.agent-workflow')
    f.git(
      '-c',
      'user.name=RFC363',
      '-c',
      'user.email=rfc363@example.test',
      'commit',
      '-qm',
      'later',
    )
    const events: string[] = []
    const space = await materializeSpaceWithProvider(
      StartTaskSchema.parse({
        workflowId: 'workflow',
        name: 'frozen',
        cachedRepoId: 'repo',
        ref: 'main',
      }),
      {
        appHome: join(f.root, 'home'),
        repositoryWorkspace: composeRepositoryWorkspaceStore(harness.db),
        preResolvedSources: [f.source],
        frozenLayout: null,
        loadFrozenSpaceLayout: async () => {
          throw new Error('unexpected Task layout read')
        },
        worktreeLifecycleHook: async (event) => {
          events.push(event.stage)
        },
      },
      ulid(),
    )
    try {
      expect(space.earlyError).toBeNull()
      expect(space.baseCommit).toBe(f.base)
      expect(space.repos[0]?.baseBranch).toBe('main')
      expect(readFileSync(join(space.worktreePath, 'a.txt'), 'utf8')).toBe('frozen')
      expect(events).toContain('before-worktree-add')
      expect(events).toContain('post-add-before-submodules')
    } finally {
      await cleanupMaterializedSpace(space)
    }
  })

  test('a frozen group works after its live group is absent and preserves per-mount commits/directories', async () => {
    const f = repository()
    const second = f.commit('second mount')
    const planned = (mountPath: string) => ({
      cachedRepoId: 'repo',
      repoUrlRedacted: 'https://example.test/repo.git',
      ref: 'main',
      mountPath,
      subdir: '',
      readonly: false,
      viaGroups: [{ id: 'deleted-group', name: 'old name' }],
    })
    const input = StartTaskSchema.parse({
      workflowId: 'workflow',
      name: 'frozen group',
      repoGroupId: 'deleted-group',
    })
    const dependencies = {
      appHome: join(f.root, 'home'),
      repositoryWorkspace: composeRepositoryWorkspaceStore(harness.db),
      preResolvedSources: [f.source, { ...f.source, resolvedCommit: second }],
      frozenLayout: {
        repos: [planned('first'), planned('second')],
        nodes: [
          { path: '', origins: [] },
          { path: 'empty', origins: [] },
        ],
      },
      loadFrozenSpaceLayout: async () => {
        throw new Error('unexpected Task layout read')
      },
    }
    const space = await materializeSpaceWithProvider(input, dependencies, ulid())
    try {
      expect(space.repos.map((repo) => repo.baseCommit)).toEqual([f.base, second])
      expect(readFileSync(join(space.worktreePath, 'first', 'a.txt'), 'utf8')).toBe('frozen')
      expect(readFileSync(join(space.worktreePath, 'second', 'a.txt'), 'utf8')).toBe('second mount')
      expect(space.nodePaths).toContain('empty')
    } finally {
      await cleanupMaterializedSpace(space)
    }
    await expect(
      materializeSpaceWithProvider(
        input,
        { ...dependencies, preResolvedSources: [f.source] },
        ulid(),
      ),
    ).rejects.toThrow('repository-preparation-source-count-mismatch')
  })
})
