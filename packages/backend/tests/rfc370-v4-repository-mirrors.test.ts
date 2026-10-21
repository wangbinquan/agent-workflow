import { readDaemonGraphSource } from './helpers/daemonGraphSource'
// RFC-370 §10 V17 — registered repositories are read, registered and refreshed
// where their content lives.
//
// Why these tests exist: RFC-370 hosted sweep (2026-10-19). On a hosted
// deployment the launch pickers asked `/api/repos/refs|files?path=<mirror>` for
// a directory the service container never has (no git, no persistent disk), so
// they silently fell back to free text; batch import and repo-group URL mounts
// tried a local clone and failed; a refresh answered 409. These tests lock:
// - the task-image command reads branches, peeled tags, recent commits and the
//   HEAD tree from the remote itself (file:// stands in for the platform's
//   remote), reads an empty repository as empty, and leaves no scratch behind;
// - the command refuses a credential-bearing URL (credentials come from the
//   platform's Git Secrets) without echoing the credential;
// - the hosted mirrors read a registered repository's remote by id, register a
//   URL only after the remote answers (recording its HEAD branch and when it
//   was verified), refresh by verifying again, and offer no `?path=` reads
//   (the route refuses it with `repo-path-unsupported`);
// - batch import and repo-group URL mounts register through the hosted
//   registration instead of cloning, and the rows say so;
// - a hosted daemon registers no working mirror refresh job.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RepoRefsResponse } from '@agent-workflow/shared'
import { Hono, type Context } from 'hono'
import { buildActor } from '../src/auth/actor'
import { mountRepoRoutes } from '../src/routes/repos'
import { createSecretBoxFromKey } from '../src/auth/secretBox'
import {
  composeRepositoryMirrors,
  composeRepositoryWorkspaceStore,
  type RepositoryRemoteEffects,
} from '../src/modules/source-control/composition'
import { executeTaskImageRepositoryRemote } from '../src/modules/source-control/composition/taskImageRepositoryRemote'
import {
  readRemoteRepositoryFiles,
  readRemoteRepositoryRefs,
  verifyRemoteRepository,
} from '../src/modules/source-control/infrastructure/crewstation/repositoryRemoteVolume'
import {
  __resetBatchImportForTests,
  getBatchSnapshot,
  startBatchImport,
} from '../src/services/repoBatchImport'
import { createRepoGroup } from '../src/services/repoGroup'
import { DomainError, errorHandler } from '../src/util/errors'
import { runGit } from '../src/util/git'
import { describeEachProvider } from './helpers/eachProvider'

const IDENTITY = ['-c', 'user.email=v17@test', '-c', 'user.name=v17']

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await runGit(cwd, args)
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout
}

describe('RFC-370 V17 repository remote command', () => {
  let base: string
  let root: string
  let url: string
  let emptyUrl: string

  beforeAll(async () => {
    base = mkdtempSync(join(tmpdir(), 'aw-rfc370-v17-'))
    root = join(base, 'volume')
    mkdirSync(root)
    const work = join(base, 'work')
    mkdirSync(join(work, 'dir'), { recursive: true })
    await git(work, 'init', '-q', '-b', 'main')
    writeFileSync(join(work, 'a.txt'), 'a\n')
    await git(work, 'add', '-A')
    await git(work, ...IDENTITY, 'commit', '-q', '-m', 'first')
    writeFileSync(join(work, 'dir', 'b.txt'), 'b\n')
    await git(work, 'add', '-A')
    await git(work, ...IDENTITY, 'commit', '-q', '-m', 'second')
    await git(work, 'branch', 'feature')
    await git(work, ...IDENTITY, 'tag', '-a', 'v1', '-m', 'v1')
    await git(base, 'clone', '-q', '--bare', work, join(base, 'remote.git'))
    url = `file://${join(base, 'remote.git')}`
    await git(base, 'init', '-q', '--bare', '-b', 'main', join(base, 'empty.git'))
    emptyUrl = `file://${join(base, 'empty.git')}`
  })

  afterAll(() => rmSync(base, { recursive: true, force: true }))

  test('refs: branches, peeled tags, recent commits and the HEAD branch', async () => {
    const refs = await readRemoteRepositoryRefs(url, root)
    expect(refs.branches).toEqual(['feature', 'main'])
    expect(refs.tags).toEqual(['v1'])
    expect(refs.recentCommits.map((commit) => commit.subject)).toEqual(['second', 'first'])
    expect(refs.recentCommits[0]!.sha).toMatch(/^[0-9a-f]{40}$/)
    expect(refs).toMatchObject({ currentBranch: 'main', defaultBranch: 'main', hasCommits: true })
    expect(readdirSync(join(root, 'tmp'))).toEqual([])
  })

  test('files: the HEAD tree; verify: the HEAD branch', async () => {
    expect((await readRemoteRepositoryFiles(url, root)).files.sort()).toEqual([
      'a.txt',
      'dir/b.txt',
    ])
    expect(await verifyRemoteRepository(url, root)).toEqual({ defaultBranch: 'main' })
    expect(readdirSync(join(root, 'tmp'))).toEqual([])
  })

  test('an empty repository reads as empty instead of failing', async () => {
    const refs = await readRemoteRepositoryRefs(emptyUrl, root)
    expect(refs).toMatchObject({ branches: [], tags: [], recentCommits: [], hasCommits: false })
    expect(await readRemoteRepositoryFiles(emptyUrl, root)).toEqual({ files: [] })
  })

  test('an unreadable remote is a 502 with its code', async () => {
    const error = await readRemoteRepositoryRefs(`file://${join(base, 'absent.git')}`, root).catch(
      (caught: unknown) => caught,
    )
    expect(error).toBeInstanceOf(DomainError)
    expect(error).toMatchObject({ code: 'repo-remote-unreadable', status: 502 })
  })

  test('the command refuses a credential-bearing URL without echoing it', async () => {
    const error = await executeTaskImageRepositoryRemote(
      { method: 'refs', url: 'https://alice:s3cr3t-token@example.test/acme/app.git' },
      root,
    ).catch((caught: unknown) => caught)
    expect(error).toMatchObject({ code: 'repo-url-requires-platform-credentials', status: 400 })
    expect(
      JSON.stringify({ message: (error as Error).message, ...(error as object) }),
    ).not.toContain('s3cr3t-token')
    await expect(
      executeTaskImageRepositoryRemote(
        { method: 'clone', url: 'https://example.test/a.git' },
        root,
      ),
    ).rejects.toThrow('repository-remote-method-unknown')
  })
})

function fakeRemote(calls: string[][]): RepositoryRemoteEffects {
  const refs: RepoRefsResponse = {
    branches: ['trunk'],
    tags: [],
    recentCommits: [],
    currentBranch: 'trunk',
    defaultBranch: 'trunk',
    hasCommits: false,
  }
  return {
    refs: async (url) => {
      calls.push(['refs', url])
      return refs
    },
    files: async (url) => {
      calls.push(['files', url])
      return { files: ['README.md'] }
    },
    verify: async (url) => {
      calls.push(['verify', url])
      if (url.includes('unreachable'))
        throw new DomainError('repo-remote-unreadable', 'the remote could not be read', 502)
      return { defaultBranch: 'trunk' }
    },
  }
}

describeEachProvider('RFC-370 V17 hosted repository mirrors', (harness) => {
  const home = mkdtempSync(join(tmpdir(), 'aw-rfc370-v17-home-'))
  afterAll(() => rmSync(home, { recursive: true, force: true }))
  const hosted = (calls: string[][], now = () => 1_700_000_000_000) => {
    const store = composeRepositoryWorkspaceStore(harness.db)
    return {
      store,
      mirrors: composeRepositoryMirrors({
        store,
        secretBox: createSecretBoxFromKey(Buffer.alloc(32, 17)),
        appHome: home,
        now,
        remote: fakeRemote(calls),
      }),
    }
  }

  test('registers only after the remote answers, then reads it by id', async () => {
    const calls: string[][] = []
    const { store, mirrors } = hosted(calls)
    const url = 'https://example.test/acme/app.git'
    const first = await mirrors.remoteRegistration!.register(url)
    expect(first.created).toBe(true)
    expect(await store.findCachedRepoById(first.cachedRepoId)).toMatchObject({
      defaultBranch: 'trunk',
      lastFetchedAt: 1_700_000_000_000,
    })
    expect(await mirrors.remoteRegistration!.register(url)).toEqual({
      cachedRepoId: first.cachedRepoId,
      created: false,
    })
    expect(await mirrors.refs(first.cachedRepoId)).toMatchObject({ branches: ['trunk'] })
    expect(await mirrors.files(first.cachedRepoId)).toEqual({ files: ['README.md'] })
    expect(calls).toEqual([
      ['verify', url],
      ['verify', url],
      ['refs', url],
      ['files', url],
    ])
    // A hosted deployment keeps no mirror on its own disk.
    expect(mirrors.local).toBeUndefined()
  })

  test('a refresh verifies the remote again', async () => {
    const calls: string[][] = []
    let clock = 1_700_000_000_000
    const { mirrors } = hosted(calls, () => clock)
    const url = 'https://example.test/acme/refresh.git'
    const { cachedRepoId } = await mirrors.remoteRegistration!.register(url)
    clock += 60_000
    const refreshed = await mirrors.remoteRegistration!.refresh(cachedRepoId)
    expect(refreshed).toMatchObject({
      fetchOk: true,
      fetchError: null,
      item: { id: cachedRepoId, defaultBranch: 'trunk' },
    })
    expect(Date.parse(refreshed.item.lastFetchedAt)).toBe(clock)
    expect(calls.at(-1)).toEqual(['verify', url])
  })

  test('an unreachable remote is never registered; an unknown id is a 404', async () => {
    const { store, mirrors } = hosted([])
    await expect(
      mirrors.remoteRegistration!.register('https://example.test/acme/unreachable.git'),
    ).rejects.toMatchObject({ code: 'repo-remote-unreadable' })
    expect(await store.listCachedRepos()).toEqual([])
    await expect(mirrors.refs('nope')).rejects.toMatchObject({
      code: 'cached-repo-not-found',
      status: 404,
    })
  })

  test('a repo-group URL mount registers through the hosted registration', async () => {
    const calls: string[][] = []
    const { store, mirrors } = hosted(calls)
    const url = 'https://example.test/acme/grouped.git'
    const group = await createRepoGroup(
      {
        store,
        register: (value) => mirrors.remoteRegistration!.register(value),
      },
      {
        name: 'v17-group',
        description: '',
        nodes: [
          {
            path: '',
            attachment: { kind: 'repo', repoUrl: url, ref: '', subdir: '', readonly: false },
          },
        ],
      },
      null,
    )
    const attachment = group.nodes[0]!.attachment
    expect(attachment?.kind).toBe('repo')
    const registered = await store.listCachedRepos()
    expect(registered).toHaveLength(1)
    expect(attachment).toMatchObject({ cachedRepoId: registered[0]!.id })
    expect(calls).toEqual([['verify', url]])
  })
})

describe('RFC-370 V17 hosted picker route', () => {
  test('?path= is refused where the daemon keeps no mirror; cachedRepoId reads through', async () => {
    const app = new Hono()
    const actor = buildActor({
      user: {
        id: 'viewer',
        username: 'viewer',
        displayName: 'Viewer',
        role: 'admin',
        status: 'active',
      },
      source: 'session',
    })
    app.use('*', async (c: Context, next) => {
      c.set('actor', actor)
      await next()
    })
    app.onError(errorHandler)
    const calls: string[] = []
    const unused = async (): Promise<never> => {
      throw new Error('unexpected registration')
    }
    mountRepoRoutes(app, { listKnownRepositoryPaths: async () => ['/mirrors/x'] } as never, {
      refs: async (id) => {
        calls.push(`refs:${id}`)
        return {
          branches: ['main'],
          tags: [],
          recentCommits: [],
          currentBranch: 'main',
          defaultBranch: 'main',
          hasCommits: false,
        }
      },
      files: async (id) => {
        calls.push(`files:${id}`)
        return { files: ['README.md'] }
      },
      remoteRegistration: { register: unused, refresh: unused },
    })
    const refused = await app.request('/api/repos/refs?path=/mirrors/x')
    expect(refused.status).toBe(422)
    expect(await refused.json()).toMatchObject({ code: 'repo-path-unsupported' })
    const refs = await app.request('/api/repos/refs?cachedRepoId=cr-1')
    expect(refs.status).toBe(200)
    expect(await refs.json()).toMatchObject({ branches: ['main'] })
    const files = await app.request('/api/repos/files?cachedRepoId=cr-1')
    expect(await files.json()).toEqual({ files: ['README.md'] })
    expect(calls).toEqual(['refs:cr-1', 'files:cr-1'])
  })
})

describe('RFC-370 V17 hosted mirror refresh job', () => {
  test('a hosted daemon keeps the refresh handle registered but runs nothing', () => {
    // Source-level lock: both daemons freeze the same writers (RFC-349), so
    // the handle stays in the PostgreSQL session's list; with the hosted
    // remote selected its start() returns an inert handle.
    const start = readDaemonGraphSource()
    const factory = start.slice(start.indexOf("id: 'submodule-refresh'"))
    expect(factory.slice(0, 700)).toContain('if (input.repositoryRemote !== undefined)')
  })
})

describe('RFC-370 V17 hosted batch import', () => {
  test('rows register through the hosted registration and report verified-only', async () => {
    __resetBatchImportForTests()
    const registered: string[] = []
    const { batchId } = startBatchImport(
      {
        store: {} as never,
        register: async (url) => {
          registered.push(url)
          return { cachedRepoId: `cr:${url}`, created: url.endsWith('/new.git') }
        },
        resolveCachedRepo: async () => {
          throw new Error('a hosted batch import must not clone')
        },
        emit: () => undefined,
      },
      { urls: ['https://example.test/acme/new.git', 'https://example.test/acme/known.git'] },
      { userId: 'u-v17' },
    )
    for (let i = 0; i < 200 && getBatchSnapshot(batchId)?.state !== 'completed'; i += 1)
      await Bun.sleep(5)
    const rows = getBatchSnapshot(batchId)!.rows
    expect(
      rows.map((row) => [row.inputUrl, row.status, row.cold, row.verifiedOnly, row.cachedRepoId]),
    ).toEqual([
      [
        'https://example.test/acme/new.git',
        'done',
        true,
        true,
        'cr:https://example.test/acme/new.git',
      ],
      [
        'https://example.test/acme/known.git',
        'done',
        false,
        true,
        'cr:https://example.test/acme/known.git',
      ],
    ])
    expect(registered.sort()).toEqual([
      'https://example.test/acme/known.git',
      'https://example.test/acme/new.git',
    ])
    __resetBatchImportForTests()
  })
})
