// RFC-370 §10 V17 — the remote reads of a registered repository, run as one
// task-image command in the release's system volume. The service container has
// no git, and a hosted deployment clones a repository only inside each task's
// own volume, so the launch pickers and the registration check read the remote
// itself with the deployment's Git credentials (bound to exact URLs).
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  redactGitUrl,
  type GitRef,
  type RepoFilesResponse,
  type RepoRefsResponse,
} from '@agent-workflow/shared'
import { DomainError } from '@/util/errors'
import { runGit } from '@/util/git'
import type { RepositoryRemoteFacts } from '../../application/ports/repositoryMirrors'
import { assertHostedRepositoryUrl } from './repositoryUrl'

/** The standalone refs view lists the same number of recent commits. */
const RECENT_COMMITS = 50
const GIT_TIMEOUT_MS = 120_000

interface Advertised {
  /** False for an empty repository (or an unborn HEAD): nothing to fetch. */
  readonly head: boolean
  readonly defaultBranch: string | null
  readonly branches: readonly string[]
  readonly tags: readonly string[]
}

function unreadable(url: string, stderr: string): DomainError {
  const reason = redactGitUrl(stderr.trim()).slice(0, 400) || 'git produced no output'
  return new DomainError(
    'repo-remote-unreadable',
    `the remote ${redactGitUrl(url)} could not be read: ${reason}`,
    502,
    { url: redactGitUrl(url) },
  )
}

const options = (signal?: AbortSignal) => ({
  timeoutMs: GIT_TIMEOUT_MS,
  ...(signal === undefined ? {} : { signal }),
})

/** Branches, tags and the HEAD branch as the remote advertises them. */
async function advertised(url: string, cwd: string, signal?: AbortSignal): Promise<Advertised> {
  const listed = await runGit(cwd, ['ls-remote', '--symref', url], options(signal))
  if (listed.exitCode !== 0) throw unreadable(url, listed.stderr)
  let head = false
  let defaultBranch: string | null = null
  const branches = new Set<string>()
  const tags = new Set<string>()
  for (const line of listed.stdout.split('\n')) {
    const tab = line.indexOf('\t')
    if (tab < 0) continue
    const value = line.slice(0, tab)
    const name = line.slice(tab + 1)
    if (value.startsWith('ref: ')) {
      const target = value.slice('ref: '.length)
      if (name === 'HEAD' && target.startsWith('refs/heads/'))
        defaultBranch = target.slice('refs/heads/'.length)
    } else if (name === 'HEAD') head = true
    else if (name.startsWith('refs/heads/')) branches.add(name.slice('refs/heads/'.length))
    else if (name.startsWith('refs/tags/'))
      tags.add(name.slice('refs/tags/'.length).replace(/\^\{\}$/, ''))
  }
  return { head, defaultBranch, branches: [...branches].sort(), tags: [...tags].sort() }
}

/** Reads the remote HEAD's recent history from a blob-less shallow fetch into
 * a scratch bare repository that is removed afterwards. */
async function withRemoteHead<T>(
  url: string,
  root: string,
  depth: number,
  read: (repository: string) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const scratch = join(root, 'tmp')
  mkdirSync(scratch, { recursive: true })
  const repository = mkdtempSync(join(scratch, 'repository-remote-'))
  try {
    const init = await runGit(repository, ['init', '--bare', '--quiet'])
    if (init.exitCode !== 0) throw new Error(`repository-remote-scratch-failed: ${init.stderr}`)
    const fetch = (filter: readonly string[]) =>
      runGit(
        repository,
        ['fetch', '--quiet', '--no-tags', `--depth=${depth}`, ...filter, url, 'HEAD'],
        options(signal),
      )
    let fetched = await fetch(['--filter=blob:none'])
    // A git that predates promisor URL remotes refuses `--filter` here; the
    // shallow fetch alone still answers.
    if (fetched.exitCode !== 0 && /partial ?clone|--filter/i.test(fetched.stderr))
      fetched = await fetch([])
    if (fetched.exitCode !== 0) throw unreadable(url, fetched.stderr)
    return await read(repository)
  } finally {
    rmSync(repository, { recursive: true, force: true })
  }
}

export async function verifyRemoteRepository(
  url: string,
  root: string,
  signal?: AbortSignal,
): Promise<RepositoryRemoteFacts> {
  return { defaultBranch: (await advertised(url, root, signal)).defaultBranch }
}

export async function readRemoteRepositoryRefs(
  url: string,
  root: string,
  signal?: AbortSignal,
): Promise<RepoRefsResponse> {
  const remote = await advertised(url, root, signal)
  const recentCommits = !remote.head
    ? []
    : await withRemoteHead(
        url,
        root,
        RECENT_COMMITS,
        async (repository) => {
          const log = await runGit(repository, [
            'log',
            `-${RECENT_COMMITS}`,
            '--format=%H%x09%s',
            'FETCH_HEAD',
          ])
          if (log.exitCode !== 0) throw unreadable(url, log.stderr)
          return log.stdout
            .split('\n')
            .filter((line) => line.length > 0)
            .map((line): GitRef => {
              const tab = line.indexOf('\t')
              return tab < 0
                ? { sha: line, subject: '' }
                : { sha: line.slice(0, tab), subject: line.slice(tab + 1) }
            })
        },
        signal,
      )
  return {
    branches: [...remote.branches],
    tags: [...remote.tags],
    recentCommits,
    // The branch a fresh clone checks out.
    currentBranch: remote.defaultBranch,
    defaultBranch: remote.defaultBranch,
    hasCommits: recentCommits.length > 0,
  }
}

export async function readRemoteRepositoryFiles(
  url: string,
  root: string,
  signal?: AbortSignal,
): Promise<RepoFilesResponse> {
  // An empty repository has no files (and no HEAD to fetch).
  if (!(await advertised(url, root, signal)).head) return { files: [] }
  return {
    files: await withRemoteHead(
      url,
      root,
      1,
      async (repository) => {
        const tree = await runGit(repository, ['ls-tree', '-r', '-z', '--name-only', 'FETCH_HEAD'])
        if (tree.exitCode !== 0) throw unreadable(url, tree.stderr)
        return tree.stdout.split('\0').filter((path) => path.length > 0)
      },
      signal,
    ),
  }
}

/** The command: the URL must be a credential-free remote (credentials come
 * from the platform's Secret bindings, never from the URL). */
export async function executeRepositoryRemoteVolumeOperation(
  value: unknown,
  root: string,
  signal?: AbortSignal,
): Promise<unknown> {
  const request = value as { readonly method?: unknown; readonly url?: unknown }
  if (typeof request.url !== 'string') throw new Error('repository-remote-url-required')
  try {
    assertHostedRepositoryUrl(request.url)
  } catch (error) {
    throw new DomainError(
      'repo-url-requires-platform-credentials',
      `${error instanceof Error ? error.message : String(error)}: a hosted deployment reads a repository from a credential-free remote URL, authenticated by the platform's Git credentials`,
      400,
      { url: redactGitUrl(request.url) },
    )
  }
  switch (request.method) {
    case 'verify':
      return verifyRemoteRepository(request.url, root, signal)
    case 'refs':
      return readRemoteRepositoryRefs(request.url, root, signal)
    case 'files':
      return readRemoteRepositoryFiles(request.url, root, signal)
    default:
      throw new Error('repository-remote-method-unknown')
  }
}
