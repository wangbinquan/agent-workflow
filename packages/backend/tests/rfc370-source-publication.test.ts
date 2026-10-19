import { expect, test } from 'bun:test'
import {
  chunkPublicationActions,
  createGitLabPublication,
  partialPublicationMessage,
  planSourcePublication,
  previousPublication,
  sourceFile,
  type PublicationAction,
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

// RFC-370 hosted acceptance (2026-10-19): the first publication to a new
// CrewStation project (its branch still holds the template it was created from)
// failed with `publication-target-source-provenance-missing` and no way forward.
const SOURCE = 'a'.repeat(40)
const template = new Map([
  ['Dockerfile', { id: file('FROM template').blob, mode: '100644' }],
  ['src/main.ts', { id: file('template app').blob, mode: '100644' }],
  ['run.sh', { id: file('#!/bin/sh').blob, mode: '100755' }],
])
const unread = () => {
  throw new Error('a published source commit is read, the adopted tree is not')
}

test('a branch agent-workflow published plans against the source commit its head names', () => {
  const committed = new Map([['a', original]])
  for (const adopt of [false, true]) {
    const baseline = previousPublication({
      headMessage: `agent-workflow ${SOURCE}\n`,
      adopt,
      committedFiles: (sha) => {
        expect(sha).toBe(SOURCE)
        return committed
      },
      remoteTree: template,
    })
    expect(baseline).toEqual({ sourceSha: SOURCE, files: committed })
  }
})

test('a branch agent-workflow never published is replaced only on request', () => {
  expect(() =>
    previousPublication({
      headMessage: 'chore: initialize from template',
      adopt: false,
      committedFiles: unread,
      remoteTree: template,
    }),
  ).toThrow('pass --adopt-existing')
  expect(() =>
    previousPublication({
      headMessage: 'chore: initialize from template',
      adopt: true,
      committedFiles: unread,
      remoteTree: new Map([['link', { id: file('x').blob, mode: '120000' }]]),
    }),
  ).toThrow('publication-unsupported-remote-entry: link')
})

test('adopting a template replaces its files, removes the rest and adds the snapshot', async () => {
  const baseline = previousPublication({
    headMessage: 'chore: initialize from template',
    adopt: true,
    committedFiles: unread,
    remoteTree: template,
  })
  expect(baseline.sourceSha).toBeNull()
  const next = new Map([
    ['Dockerfile', file('FROM agent-workflow')],
    ['run.sh', { ...file('#!/bin/sh'), mode: '100755' as const }],
    ['package.json', file('{}')],
  ])
  const actions = await planSourcePublication({
    previous: baseline.files,
    next,
    remoteFile: async (path) => {
      const entry = template.get(path)
      return entry === undefined
        ? null
        : {
            blob_id: entry.id,
            execute_filemode: entry.mode === '100755',
            last_commit_id: 'template',
          }
    },
  })
  expect(actions.map((action) => [action.action, action.file_path])).toEqual([
    ['update', 'Dockerfile'],
    ['delete', 'src/main.ts'],
    ['create', 'package.json'],
  ])
  expect(actions[0]).toMatchObject({
    last_commit_id: 'template',
    content: Buffer.from('FROM agent-workflow').toString('base64'),
  })
})

// The first publication is the whole snapshot (~9.5k files, ~200 MiB as
// base64), which GitLab refused as one commit request (`source-publication-http-400`).
const create = (path: string, bytes: number): PublicationAction => ({
  action: 'create',
  file_path: path,
  content: 'x'.repeat(bytes),
  encoding: 'base64',
})

test('a large publication is split into ordered chunks that keep each file whole', () => {
  const actions: PublicationAction[] = [
    create('a', 10),
    create('b', 10),
    { action: 'chmod', file_path: 'b', execute_filemode: true },
    create('c', 10),
    create('huge', 100),
    { action: 'delete', file_path: 'old', last_commit_id: 'x' },
  ]
  const chunks = chunkPublicationActions(actions, { actions: 3, bytes: 50 })
  expect(chunks.map((chunk) => chunk.map((a) => `${a.action}:${a.file_path}`))).toEqual([
    ['create:a', 'create:b', 'chmod:b'],
    ['create:c'],
    ['create:huge'],
    ['delete:old'],
  ])
  expect(chunks.flat()).toEqual(actions)
  expect(chunkPublicationActions([])).toEqual([])
})

test('a partial commit keeps the provenance a resumed publication plans against', () => {
  const head = 'b'.repeat(40)
  const resumed = partialPublicationMessage({ previousSha: SOURCE, head, part: 2, parts: 5 })
  expect(
    previousPublication({
      headMessage: resumed,
      adopt: false,
      committedFiles: (sha) => new Map([[sha, original]]),
      remoteTree: template,
    }).sourceSha,
  ).toBe(SOURCE)
  expect(resumed).toContain(`partial publication 2/5 of agent-workflow ${head}`)
  // A first publication has no source yet: an interrupted one is adopted again.
  const first = partialPublicationMessage({ previousSha: null, head, part: 1, parts: 5 })
  expect(() =>
    previousPublication({
      headMessage: first,
      adopt: false,
      committedFiles: unread,
      remoteTree: template,
    }),
  ).toThrow('pass --adopt-existing')
})

test('a resumed publication skips what an interrupted one already applied', async () => {
  const actions = await planSourcePublication({
    previous: new Map([
      ['gone', original],
      ['updated', original],
      ['pending', original],
    ]),
    next: new Map([
      ['updated', changed],
      ['pending', changed],
    ]),
    remoteFile: async (path) =>
      path === 'gone'
        ? null
        : {
            blob_id: path === 'updated' ? changed.blob : original.blob,
            execute_filemode: false,
            last_commit_id: 'partial',
          },
  })
  expect(actions.map((action) => [action.action, action.file_path])).toEqual([
    ['update', 'pending'],
  ])
})
