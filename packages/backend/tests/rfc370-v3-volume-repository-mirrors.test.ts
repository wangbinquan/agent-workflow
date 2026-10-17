// RFC-370 §9.2 V3 — hosted repository preparation reuses the standalone
// mirror primitive.
//
// Why these tests exist: the task image used to clone with its own logic
// (`git clone --no-checkout` straight into the final path, no submodules, a
// separate fetch/resolve), so hosted repositories silently lacked recursive
// submodules and a crashed clone left a half-written mirror at its final path.
// `resolve-repository` now runs the standalone `resolveCachedRepo` (temp dir +
// rename cold path, recursive submodules, fetch with prune, fast-forward of the
// requested branch) over a registry that is the volume's own `repos/`
// directory. These tests lock that behaviour, the frozen commit, and the
// structured refusals the control plane receives unchanged.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { executeWorkspaceTaskImageOperation } from '@/bootstrap/workspaceTaskImage'
import type { ResolvedRepoSource } from '@/modules/source-control/application/workspaceMaterialization'
import { createVolumeRepositoryMirrorStore } from '@/modules/source-control/infrastructure/crewstation/volumeRepositoryMirrors'
import { DomainError } from '@/util/errors'
import { runGit } from '@/util/git'
import { remoteUrlFor, startGitHttpRemote, stopGitHttpRemote } from './helpers/gitHttpRemote'

beforeAll(startGitHttpRemote)
afterAll(stopGitHttpRemote)

async function git(path: string, args: string[]): Promise<string> {
  const result = await runGit(path, args)
  if (result.exitCode !== 0) throw new Error(result.stderr)
  return result.stdout.trim()
}

async function init(path: string, file: string, content: string) {
  mkdirSync(path, { recursive: true })
  await git(path, ['init', '-b', 'main'])
  await git(path, ['config', 'user.name', 'Fixture'])
  await git(path, ['config', 'user.email', 'fixture@example.test'])
  writeFileSync(join(path, file), content)
  await git(path, ['add', '.'])
  await git(path, ['commit', '-m', 'initial'])
}

test('cold and warm resolution reuse the mirror primitive with recursive submodules', async () => {
  const fixtures = mkdtempSync(join(tmpdir(), 'aw-v3-mirror-remote-'))
  const root = mkdtempSync(join(tmpdir(), 'aw-v3-mirror-volume-'))
  try {
    const sub = join(fixtures, 'sub')
    const host = join(fixtures, 'host')
    await init(sub, 'a.txt', 'submodule\n')
    await init(host, 'README.md', 'host\n')
    await git(host, ['submodule', 'add', '-q', remoteUrlFor(sub), 'vendor'])
    await git(host, ['commit', '-m', 'add submodule'])
    const resolve = (input: Record<string, unknown>) =>
      executeWorkspaceTaskImageOperation(
        'resolve-repository',
        { id: 'cached-repo', url: remoteUrlFor(host), ...input },
        undefined,
        root,
      ) as Promise<ResolvedRepoSource>
    const cold = await resolve({ ref: 'main' })
    expect(cold.resolvedCommit).toBe(await git(host, ['rev-parse', 'HEAD']))
    expect(cold).toMatchObject({ cachedRepoId: 'cached-repo', baseBranch: 'main' })
    expect(cold.repoPath.startsWith(join(root, 'repos') + '/')).toBe(true)
    // The standalone cold path clones beside the target and renames it in.
    const mirrors = readdirSync(join(root, 'repos'))
    expect(mirrors).toHaveLength(1)
    expect(mirrors[0]).not.toContain('~')
    expect(existsSync(join(cold.repoPath, 'vendor', 'a.txt'))).toBe(true)
    // Warm: the same mirror is fetched and the requested branch fast-forwarded.
    writeFileSync(join(host, 'next.txt'), 'next\n')
    await git(host, ['add', 'next.txt'])
    await git(host, ['commit', '-m', 'advance'])
    const warm = await resolve({ ref: 'main' })
    expect(warm.repoPath).toBe(cold.repoPath)
    expect(warm.resolvedCommit).toBe(await git(host, ['rev-parse', 'HEAD']))
    expect(await git(warm.repoPath, ['rev-parse', 'refs/heads/main'])).toBe(warm.resolvedCommit!)
    // Without a ref, the mirror's default branch is used.
    const defaulted = await resolve({})
    expect(defaulted).toMatchObject({ baseBranch: 'main', resolvedCommit: warm.resolvedCommit })
    expect(readdirSync(join(root, 'repos'))).toHaveLength(1)
  } finally {
    rmSync(fixtures, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  }
}, 120_000)

test('refusals keep their structured code, status and details', async () => {
  const fixtures = mkdtempSync(join(tmpdir(), 'aw-v3-mirror-refusal-'))
  const root = mkdtempSync(join(tmpdir(), 'aw-v3-mirror-volume-'))
  try {
    const host = join(fixtures, 'host')
    await init(host, 'README.md', 'host\n')
    const missing = await executeWorkspaceTaskImageOperation(
      'resolve-repository',
      { id: 'cached-repo', url: remoteUrlFor(host), ref: 'no-such-branch' },
      undefined,
      root,
    ).then(
      () => null,
      (error: unknown) => error,
    )
    expect(missing).toBeInstanceOf(DomainError)
    expect(missing).toMatchObject({
      code: 'repo-ref-not-found',
      status: 400,
      details: { ref: 'no-such-branch' },
    })
    expect(
      (missing as DomainError & { details: { availableRefs: string[] } }).details.availableRefs,
    ).toContain('main')
    const unreachable = await executeWorkspaceTaskImageOperation(
      'resolve-repository',
      { id: 'cached-repo', url: `${remoteUrlFor(fixtures)}/absent.git` },
      undefined,
      root,
    ).then(
      () => null,
      (error: unknown) => error,
    )
    expect(unreachable).toMatchObject({ code: 'repo-clone-failed', status: 400 })
    // A failed cold clone leaves no half-written mirror behind.
    expect(readdirSync(join(root, 'repos')).filter((name) => name.includes('absent'))).toEqual([])
    await expect(
      executeWorkspaceTaskImageOperation(
        'resolve-repository',
        { id: 'cached-repo', url: 'https://user:secret@git.example.test/repo' },
        undefined,
        root,
      ),
    ).rejects.toThrow('platform-credentials')
  } finally {
    rmSync(fixtures, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  }
}, 60_000)

test('the volume registry is the repos directory and serves only the mirror primitive', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aw-v3-mirror-store-'))
  try {
    const store = createVolumeRepositoryMirrorStore(root)
    expect(await store.findCachedRepoByHash('abc')).toBeNull()
    mkdirSync(join(root, 'repos', 'abc-repo~partial~01J'), { recursive: true })
    expect(await store.findCachedRepoByHash('abc')).toBeNull()
    const mirror = join(root, 'repos', 'abc-repo')
    await init(mirror, 'README.md', 'mirror\n')
    expect(await store.findCachedRepoByHash('abc')).toMatchObject({
      id: 'abc',
      urlHash: 'abc',
      localPath: mirror,
      defaultBranch: 'main',
      urlEnc: null,
    })
    expect(await store.insertCachedRepo({} as never)).toBe(true)
    expect(await store.updateCachedRepo('abc', {})).toBe(true)
    expect(await store.cachedRepoReferenceCount('abc')).toBe(0)
    mkdirSync(join(root, 'repos', 'abc-other'))
    await expect(store.findCachedRepoByHash('abc')).rejects.toThrow('mirror-ambiguous')
    expect(() => store.findCachedRepoById('abc')).toThrow('volume-repository-store-unsupported')
    expect(() => store.listCachedRepos()).toThrow('volume-repository-store-unsupported')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
