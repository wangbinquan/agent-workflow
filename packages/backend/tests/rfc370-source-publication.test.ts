import { expect, test } from 'bun:test'
import {
  createGitLabPublication,
  planSourcePublication,
  sourceFile,
  type SourceFile,
} from '../../../scripts/lib/crewstation-source-publication'

const file = (text: string): SourceFile => sourceFile(Buffer.from(text))
const original = file('old'),
  changed = file('new'),
  foreign = file('keep')
test('publication changes only managed files, preserves unrelated remote content and modes', async () => {
  const previous = new Map([
    ['a', original],
    ['remove', original],
    ['same', original],
  ])
  const next = new Map([
    ['a', changed],
    ['same', original],
    ['script', { ...changed, mode: '100755' as const }],
  ])
  const remote = new Map([...previous, ['foreign', foreign]])
  const actions = await planSourcePublication({
    previous,
    next,
    remoteFile: async (path) => {
      const value = remote.get(path)
      return value === undefined
        ? null
        : { blob_id: value.blob, execute_filemode: false, last_commit_id: 'last-' + path }
    },
  })
  expect(actions.map((action) => [action.action, action.file_path])).toEqual([
    ['update', 'a'],
    ['delete', 'remove'],
    ['create', 'script'],
    ['chmod', 'script'],
  ])
  expect(actions[0]).toMatchObject({
    last_commit_id: 'last-a',
    content: Buffer.from('new').toString('base64'),
  })
  expect(actions.at(-1)).toMatchObject({ execute_filemode: true })
})

test('even an unchanged source file cannot conceal a remote managed edit', async () => {
  await expect(
    planSourcePublication({
      previous: new Map([['a', original]]),
      next: new Map([['a', original]]),
      remoteFile: async () => ({
        blob_id: foreign.blob,
        execute_filemode: false,
        last_commit_id: 'other',
      }),
    }),
  ).rejects.toThrow('publication-managed-file-changed: a')
})

test('repeating an accepted publication produces no actions', async () => {
  const actions = await planSourcePublication({
    previous: new Map([['a', original]]),
    next: new Map([['a', changed]]),
    remoteFile: async () => ({
      blob_id: changed.blob,
      execute_filemode: false,
      last_commit_id: 'accepted',
    }),
  })
  expect(actions).toEqual([])
})

test('an advanced target blocks the commit and credentials never enter errors', async () => {
  const calls: string[] = []
  const publisher = createGitLabPublication({
    apiUrl: 'https://gitlab.test',
    project: 'group/repo',
    token: 'secret',
    fetch: (async (url) => {
      calls.push(String(url))
      return Response.json({ id: 'newer', message: '', parent_ids: [] })
    }) as typeof fetch,
  })
  await expect(
    publisher.commit({
      branch: 'main',
      expectedHead: 'old',
      message: 'candidate',
      actions: [{ action: 'delete', file_path: 'a', last_commit_id: 'a' }],
      authorName: 'Fixture',
      authorEmail: 'fixture@example.test',
    }),
  ).rejects.toThrow('publication-target-advanced')
  expect(calls).toHaveLength(1)
  expect(calls[0]).not.toContain('secret')
})

// GitLab answers 400 "A branch called 'main' already exists" when a commit to
// an existing branch names `start_sha` (only valid for a new branch). The local
// RFC-370 deployment hit it; the request must target the branch itself.
test('a publication commits onto the existing branch without a new-branch start point', async () => {
  const bodies: unknown[] = []
  const publisher = createGitLabPublication({
    apiUrl: 'https://gitlab.test',
    project: 'group/repo',
    token: 'secret',
    fetch: (async (url, init) => {
      if (init?.method === 'POST') {
        bodies.push(JSON.parse(String(init.body)))
        return Response.json({ id: 'next', message: '', parent_ids: ['old'] })
      }
      return Response.json({
        id: bodies.length === 0 ? 'old' : 'next',
        message: '',
        parent_ids: [],
      })
    }) as typeof fetch,
  })
  expect(
    await publisher.commit({
      branch: 'main',
      expectedHead: 'old',
      message: 'candidate',
      actions: [{ action: 'delete', file_path: 'a', last_commit_id: 'a' }],
      authorName: 'Fixture',
      authorEmail: 'fixture@example.test',
    }),
  ).toBe('next')
  expect(bodies).toHaveLength(1)
  expect(bodies[0]).toMatchObject({ branch: 'main', commit_message: 'candidate' })
  expect(bodies[0]).not.toHaveProperty('start_sha')
})
