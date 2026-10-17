// RFC-370 M2: a hosted repository group uses the existing native materializer,
// including nested mounts, sparse members, explicit directories and cleanup.
import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PlannedRepo } from '@agent-workflow/shared'
import { executeWorkspaceTaskImageOperation } from '@/bootstrap/workspaceTaskImage'
import type {
  MaterializedSpace,
  ResolvedRepoSource,
  WorkspaceCleanupReport,
} from '@/modules/source-control/application/workspaceMaterialization'
import { runGit } from '@/util/git'
import { assertHostedRepositoryUrl } from '@/modules/source-control/infrastructure/crewstation/repositoryUrl'

test('hosted remote locations retain SSH account names without embedding credentials', () => {
  for (const url of [
    'ssh://git@example.test/repo.git',
    'git@example.test:repo.git',
    'https://example.test/repo.git',
    'git://example.test/repo.git',
  ])
    expect(() => assertHostedRepositoryUrl(url)).not.toThrow()
  for (const url of [
    'https://token@example.test/repo.git',
    'ssh://git:secret@example.test/repo.git',
    'file:///tmp/repo',
    '/tmp/repo',
    '../repo',
    'data:text/plain,repo',
    'https://example.test/repo\n.git',
  ])
    expect(() => assertHostedRepositoryUrl(url)).toThrow()
})

test('hosted nested/sparse group preserves source pairing, directory nodes and cleanup ownership', async () => {
  const volume = mkdtempSync(join(tmpdir(), 'aw-hosted-group-'))
  const git = async (cwd: string, args: string[]) => {
    const result = await runGit(cwd, args)
    if (result.exitCode !== 0) throw new Error(result.stderr)
    return result.stdout.trim()
  }
  const source = async (
    name: string,
    filename: string,
    content: string,
  ): Promise<ResolvedRepoSource> => {
    const repoPath = join(volume, 'repos', name)
    mkdirSync(join(repoPath, 'src'), { recursive: true })
    await git(repoPath, ['init', '-b', 'main'])
    await git(repoPath, ['config', 'user.name', 'Fixture'])
    await git(repoPath, ['config', 'user.email', 'fixture@example.test'])
    writeFileSync(join(repoPath, filename), content)
    await git(repoPath, ['add', '--', filename])
    await git(repoPath, ['commit', '-m', 'fixture'])
    return {
      repoPath,
      baseBranch: 'main',
      resolvedCommit: await git(repoPath, ['rev-parse', 'HEAD']),
      repoUrl: `https://example.invalid/${name}.git`,
      cachedRepoId: name,
      pathFetchError: null,
      ffWarnings: [],
    }
  }
  try {
    const child = await source('child', 'src/tool.txt', 'child\n')
    const parent = await source('parent', 'README.md', 'parent\n')
    const planned: PlannedRepo[] = [
      {
        cachedRepoId: 'child',
        repoUrlRedacted: child.repoUrl!,
        ref: 'main',
        subdir: 'src',
        mountPath: 'packages/tool',
        readonly: true,
        viaGroups: [],
      },
      {
        cachedRepoId: 'parent',
        repoUrlRedacted: parent.repoUrl!,
        ref: 'main',
        subdir: '',
        mountPath: '',
        readonly: false,
        viaGroups: [],
      },
    ]
    const input = {
      taskId: 'group-task',
      planned,
      nodePaths: ['artifacts/empty'],
      resolvedSources: [child, parent],
      gitUserName: 'Actor',
      gitUserEmail: 'actor@example.test',
    }
    const call = <T>(operation: string, value: unknown) =>
      executeWorkspaceTaskImageOperation(operation, value, undefined, volume) as Promise<T>
    const space = await call<MaterializedSpace>('materialize-group', input)
    expect(space.kind).toBe('group')
    expect(readFileSync(join(space.worktreePath, 'README.md'), 'utf8')).toBe('parent\n')
    expect(readFileSync(join(space.worktreePath, 'packages/tool/src/tool.txt'), 'utf8')).toBe(
      'child\n',
    )
    expect(existsSync(join(space.worktreePath, 'artifacts/empty'))).toBe(true)
    expect(space.repos.find((repo) => repo.mountPath === 'packages/tool')).toMatchObject({
      cachedRepoId: 'child',
      readonly: true,
      subdir: 'src',
    })
    const rootRepo = space.repos.find((repo) => repo.mountPath === '')!
    expect(
      await git(rootRepo.worktreePath, ['status', '--porcelain', '--untracked-files=all']),
    ).not.toContain('packages/tool')
    const cleanup = await call<WorkspaceCleanupReport>('cleanup-space', space)
    expect(cleanup.complete).toBe(true)
    expect(existsSync(space.worktreePath)).toBe(false)
    expect(readFileSync(join(parent.repoPath, 'README.md'), 'utf8')).toBe('parent\n')
    for (const bad of ['../outside', '/outside', 'bad\\path'])
      await expect(
        call('materialize-group', { ...input, taskId: 'invalid', nodePaths: [bad] }),
      ).rejects.toThrow()
  } finally {
    rmSync(volume, { recursive: true, force: true })
  }
})
