import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { cachedRepos } from '@/db/schema'
import { createSecretBoxFromKey } from '@/auth/secretBox'
import { createHostedDevelopmentRepositoryPreparation } from '@/modules/source-control/infrastructure/crewstation/developmentRepository'
import { composeCrewStationDevelopmentWorkspaces } from '@/modules/development-automation/composition/crewstationWorkspace'
import {
  parseHostedWorkspaceReference,
  hostedWorkspaceReference,
} from '@/modules/source-control/infrastructure/crewstation/workspaceReference'
import { executeWorkspaceTaskImageOperation } from '@/bootstrap/workspaceTaskImage'
import type { WorkspaceHelper } from '@/platform/crewstation/workspaceProtocol'
import { runGit } from '@/util/git'
import { describeEachProvider } from './helpers/eachProvider'

describeEachProvider('RFC-370 canonical development repository volume', (harness) => {
  test('unknown refresh reuses the original command before publishing the prepared owner reference', async () => {
    const secretBox = createSecretBoxFromKey(Buffer.alloc(32, 13))
    const url = 'https://git.example.test/project.git'
    await harness.db.insert(cachedRepos).values({
      id: 'repo',
      urlHash: createHash('sha256').update(url).digest('hex'),
      urlEnc: secretBox.seal(url),
      urlRedacted: url,
      localPath: '/unused-control-plane-path',
      defaultBranch: 'main',
      lastFetchedAt: 0,
      createdAt: 0,
    })
    const calls: { taskId: string; value: unknown; operationId?: string }[] = []
    const helper: WorkspaceHelper = {
      async call<T>(
        taskId: string,
        operation: string,
        value: unknown,
        options?: Parameters<WorkspaceHelper['call']>[3],
      ): Promise<T> {
        expect(operation).toBe('prepare-development-repository')
        calls.push({ taskId, value, operationId: options?.operationId })
        if (calls.length === 1) throw new Error('platform result unknown')
        return { path: '/work/repos/repo', defaultBranch: 'main' } as T
      },
    }
    const owner = createHostedDevelopmentRepositoryPreparation({
      db: harness.db,
      secretBox,
      helper,
      taskId: 'development:shared',
    })
    await expect(owner.prepare({ repositoryId: 'repo' })).rejects.toThrow('result unknown')
    const prepared = await owner.prepare({ repositoryId: 'repo' })
    expect(calls[0]!.operationId).toBe(calls[1]!.operationId)
    expect(calls[0]!.value).toEqual(calls[1]!.value)
    expect(prepared).toEqual({
      id: 'repo',
      localPath: 'cs-workspace:development%3Ashared/repos/repo',
      defaultBranch: 'main',
    })
    expect(
      (await harness.db.select().from(cachedRepos).where(eq(cachedRepos.id, 'repo')))[0]!.localPath,
    ).toBe(prepared.localPath)
    const factory = composeCrewStationDevelopmentWorkspaces({
      helper,
      locate: parseHostedWorkspaceReference,
      reference: hostedWorkspaceReference,
      readFile: async () => new Uint8Array(),
      applicationRootReference: hostedWorkspaceReference('development:shared', '/work'),
    }).automationWorkspaceEffects
    expect(
      factory.resolve(
        factory.applicationRootReference!,
        'workspaces',
        'employee-cases',
        'case',
        'scene',
      ),
    ).toBe('cs-workspace:development%3Ashared/workspaces/employee-cases/case/scene')
  })
})

test('task-image baseline refresh fast-forwards its canonical branch and preserves a divergent cache', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aw-hosted-baseline-'))
  const oldConfig = process.env.GIT_CONFIG_GLOBAL
  const git = async (cwd: string, args: string[]) => {
    const result = await runGit(cwd, args)
    if (result.exitCode !== 0) throw new Error(result.stderr)
    return result.stdout.trim()
  }
  try {
    const remote = join(root, 'remote.git'),
      source = join(root, 'source'),
      volume = join(root, 'volume')
    for (const path of [remote, source, volume]) mkdirSync(path)
    const config = join(root, 'gitconfig')
    writeFileSync(
      config,
      `[user]\n name = Fixture\n email = fixture@example.test\n[protocol "file"]\n allow = always\n[url "${remote.replace(/\\/g, '/')}"]\n insteadOf = https://fixture.invalid/repo.git\n`,
    )
    process.env.GIT_CONFIG_GLOBAL = config
    await git(remote, ['init', '--bare', '--initial-branch=main'])
    await git(source, ['init', '-b', 'main'])
    await git(source, ['remote', 'add', 'origin', remote])
    writeFileSync(join(source, 'file.txt'), 'first\n')
    await git(source, ['add', '.'])
    await git(source, ['commit', '-m', 'first'])
    await git(source, ['push', 'origin', 'main'])
    const first = await git(source, ['rev-parse', 'HEAD'])
    const input = { id: 'repo', url: 'https://fixture.invalid/repo.git', ref: 'main' }
    const prepare = () =>
      executeWorkspaceTaskImageOperation(
        'prepare-development-repository',
        input,
        undefined,
        volume,
      ) as Promise<{ path: string; defaultBranch: string }>
    const initial = await prepare()
    expect(await git(initial.path, ['rev-parse', 'HEAD'])).toBe(first)
    writeFileSync(join(source, 'file.txt'), 'second\n')
    await git(source, ['commit', '-am', 'second'])
    await git(source, ['push', 'origin', 'main'])
    const second = await git(source, ['rev-parse', 'HEAD'])
    expect((await prepare()).defaultBranch).toBe('main')
    expect(await git(initial.path, ['rev-parse', 'HEAD'])).toBe(second)
    const tree = await git(initial.path, ['rev-parse', 'HEAD^{tree}'])
    const divergent = await git(initial.path, [
      'commit-tree',
      tree,
      '-p',
      first,
      '-m',
      'local branch diverged',
    ])
    await git(initial.path, ['update-ref', 'refs/heads/main', divergent, second])
    await expect(prepare()).rejects.toThrow('non-fast-forward')
    expect(await git(initial.path, ['rev-parse', 'HEAD'])).toBe(divergent)
  } finally {
    if (oldConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL
    else process.env.GIT_CONFIG_GLOBAL = oldConfig
    rmSync(root, { recursive: true, force: true })
  }
}, 30_000)
