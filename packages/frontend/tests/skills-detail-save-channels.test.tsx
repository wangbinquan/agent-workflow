// RFC-201 T3.2 — Skill detail owns one composite Save All pipeline.  Metadata
// precedes stable path/op file steps, every receipt advances the OCC token, and
// partial/ambiguous outcomes preserve exact pending scopes.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ComponentType } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { setBaseUrl, setToken } from '../src/stores/auth'
import '../src/i18n'

const h = vi.hoisted(() => ({
  navigate: vi.fn(),
  params: {} as Record<string, string>,
}))
vi.mock('@tanstack/react-router', () => ({
  createRoute: (options: unknown) => ({
    ...(options as Record<string, unknown>),
    useParams: () => h.params,
  }),
  useNavigate: () => h.navigate,
}))
vi.mock('../src/routes/__root', () => ({ Route: {} }))

import { Route as SkillDetailRoute } from '../src/routes/skills.detail'
import { SplitDirtyContext } from '../src/components/split/splitDirty'

interface FetchCall {
  url: string
  method: string
  body?: string
}

type Failure = 'reject-422' | 'reject-409-foreign' | 'ambiguous-applied'

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function createServer(
  options: {
    description?: string
    metadataDescription?: string
    bodyMd?: string
    files?: Record<string, string>
    postFailures?: Failure[]
    fileFailures?: Record<string, Failure[]>
  } = {},
) {
  let description = options.description ?? 'orig desc'
  let bodyMd = options.bodyMd ?? 'orig body'
  let tokenVersion = 1
  let contentVersion = 1
  const files = new Map(Object.entries(options.files ?? {}))
  const postFailures = [...(options.postFailures ?? [])]
  const fileFailures = new Map(
    Object.entries(options.fileFailures ?? {}).map(([path, failures]) => [path, [...failures]]),
  )
  const calls: FetchCall[] = []
  let deferredContentRead:
    | {
        started: () => void
        release: Promise<void>
      }
    | undefined
  const token = () => `TOK${tokenVersion}`
  const advance = () => {
    tokenVersion += 1
    contentVersion += 1
  }
  const skillContent = () => ({
    name: 'sk1',
    description,
    bodyMd,
    frontmatterExtra: {},
    token: token(),
  })

  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      const method = (init?.method ?? 'GET').toUpperCase()
      const body = typeof init?.body === 'string' ? init.body : undefined
      calls.push({ url, method, body })

      if (method === 'GET' && url.endsWith('/api/skills/sk1')) {
        return json({
          id: 'sk1',
          name: 'sk1',
          description: options.metadataDescription ?? description,
          sourceKind: 'managed',
          managedPath: '/managed/sk1',
          schemaVersion: 1,
          contentVersion,
          createdAt: 0,
          updatedAt: 0,
        })
      }
      if (method === 'GET' && url.endsWith('/api/skills/sk1/content')) {
        const snapshot = skillContent()
        const deferred = deferredContentRead
        if (deferred !== undefined) {
          deferredContentRead = undefined
          deferred.started()
          await deferred.release
        }
        return json(snapshot)
      }
      if (method === 'GET' && url.endsWith('/api/skills/sk1/files')) {
        return json([...files.keys()].sort().map((path) => ({ path, type: 'file' })))
      }
      if (method === 'GET' && url.includes('/api/skills/sk1/file?')) {
        const path = new URL(url).searchParams.get('path') ?? ''
        const file = files.get(path)
        return file === undefined
          ? json({ code: 'skill-file-not-found', message: 'not found' }, 404)
          : json({ path, content: file })
      }
      if (method === 'GET' && url.endsWith('/api/skills/sk1/versions')) return json([])

      if (method === 'POST' && url.endsWith('/api/skills/sk1/save')) {
        const payload = JSON.parse(body ?? '{}') as {
          description: string
          bodyMd: string
          expectedToken: string
        }
        const failure = postFailures.shift()
        if (failure === 'reject-422') {
          return json({ code: 'skill-save-boom', message: 'save went boom' }, 422)
        }
        if (failure === 'reject-409-foreign') {
          description = 'foreign description'
          advance()
          return json({ code: 'skill-version-conflict', message: 'token stale' }, 409)
        }
        description = payload.description
        bodyMd = payload.bodyMd
        advance()
        if (failure === 'ambiguous-applied') throw new TypeError('connection lost')
        return json(skillContent())
      }

      if (method === 'PUT' && url.includes('/api/skills/sk1/file?')) {
        const path = new URL(url).searchParams.get('path') ?? ''
        const payload = JSON.parse(body ?? '{}') as { content: string; expectedToken: string }
        const failure = fileFailures.get(path)?.shift()
        if (failure === 'reject-422') {
          return json({ code: 'skill-file-invalid', message: `${path} rejected` }, 422)
        }
        if (failure === 'reject-409-foreign') {
          files.set(path, 'foreign')
          advance()
          return json({ code: 'skill-version-conflict', message: 'token stale' }, 409)
        }
        files.set(path, payload.content)
        advance()
        if (failure === 'ambiguous-applied') throw new TypeError('response lost')
        return json({ ok: true, path, token: token() })
      }

      if (method === 'DELETE' && url.includes('/api/skills/sk1/file?')) {
        const path = new URL(url).searchParams.get('path') ?? ''
        files.delete(path)
        advance()
        return json({ token: token() })
      }

      if (
        method === 'PUT' &&
        (url.endsWith('/api/skills/sk1') || url.endsWith('/api/skills/sk1/content'))
      ) {
        return json({ code: 'skill-endpoint-gone', message: 'retired' }, 410)
      }
      return new Response('not found', { status: 404 })
    },
  )

  return {
    calls,
    files,
    currentToken: token,
    setRemoteMetadata(nextDescription: string, nextBodyMd: string) {
      description = nextDescription
      bodyMd = nextBodyMd
      advance()
    },
    deferNextContentRead() {
      let markStarted!: () => void
      let release!: () => void
      const started = new Promise<void>((resolve) => {
        markStarted = resolve
      })
      const released = new Promise<void>((resolve) => {
        release = resolve
      })
      deferredContentRead = { started: markStarted, release: released }
      return { started, release }
    },
  }
}

function renderDetail(report = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const Component = (SkillDetailRoute as unknown as { component: ComponentType }).component
  const view = render(
    <QueryClientProvider client={client}>
      <SplitDirtyContext.Provider value={{ dirtyKey: null, report }}>
        <Component />
      </SplitDirtyContext.Provider>
    </QueryClientProvider>,
  )
  return { ...view, client, report }
}

async function editDescription(value: string) {
  const input = (await screen.findByTestId('skill-description-input')) as HTMLInputElement
  fireEvent.change(input, { target: { value } })
}

async function openFiles() {
  fireEvent.click(await screen.findByTestId('skill-tab-files'))
  return screen.getByTestId('skill-panel-files')
}

async function stageFile(path: string, fileContent: string) {
  const panel = await openFiles()
  fireEvent.change(within(panel).getByTestId('skill-new-path'), { target: { value: path } })
  fireEvent.click(within(panel).getByRole('button', { name: /add to changes/i }))
  await waitFor(() => {
    const editor = panel.querySelector<HTMLTextAreaElement>('.file-tree__editor textarea')
    expect(editor).not.toBeNull()
    fireEvent.change(editor!, { target: { value: fileContent } })
  })
}

async function clickSaveAll() {
  const button = (await screen.findByTestId('skill-save-button')) as HTMLButtonElement
  await waitFor(() => expect(button.disabled).toBe(false))
  fireEvent.click(button)
}

function bodies(calls: FetchCall[], method: string, includes: string) {
  return calls
    .filter((call) => call.method === method && call.url.includes(includes))
    .map((call) => JSON.parse(call.body ?? '{}') as Record<string, unknown>)
}

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
  h.navigate.mockReset()
  h.params = { name: 'sk1' }
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('skills.detail RFC-201 Save All', () => {
  test('metadata then file steps consume each preceding fresh token', async () => {
    const server = createServer()
    renderDetail()
    await editDescription('next desc')
    await stageFile('notes.md', 'hello')
    await clickSaveAll()

    await waitFor(() => expect(server.files.get('notes.md')).toBe('hello'))
    const writes = server.calls.filter(
      (call) => call.method === 'POST' || call.method === 'PUT' || call.method === 'DELETE',
    )
    expect(writes.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
      'POST /api/skills/sk1/save',
      'PUT /api/skills/sk1/file',
    ])
    expect(bodies(server.calls, 'POST', '/save')[0]).toMatchObject({
      description: 'next desc',
      bodyMd: 'orig body',
      expectedToken: 'TOK1',
    })
    expect(bodies(server.calls, 'PUT', '/file?')[0]).toMatchObject({
      content: 'hello',
      expectedToken: 'TOK2',
    })
    await waitFor(() =>
      expect((screen.getByTestId('skill-save-button') as HTMLButtonElement).disabled).toBe(true),
    )
    expect(h.navigate).not.toHaveBeenCalled()
  })

  test('partial failure keeps only failed/unexecuted scopes; retry never repeats successes', async () => {
    const server = createServer({ fileFailures: { 'b.md': ['reject-422'] } })
    renderDetail()
    await stageFile('b.md', 'B')
    await stageFile('a.md', 'A')
    await clickSaveAll()

    await screen.findByText(/1 saved · 1 not saved/i)
    expect(server.files.get('a.md')).toBe('A')
    expect(server.files.has('b.md')).toBe(false)
    expect(
      server.calls.filter((call) => call.method === 'PUT' && call.url.includes('a.md')),
    ).toHaveLength(1)
    expect(
      server.calls.filter((call) => call.method === 'PUT' && call.url.includes('b.md')),
    ).toHaveLength(1)

    await clickSaveAll()
    await waitFor(() => expect(server.files.get('b.md')).toBe('B'))
    expect(
      server.calls.filter((call) => call.method === 'PUT' && call.url.includes('a.md')),
    ).toHaveLength(1)
    expect(
      server.calls.filter((call) => call.method === 'PUT' && call.url.includes('b.md')),
    ).toHaveLength(2)
    expect(bodies(server.calls, 'PUT', 'b.md')[1]).toMatchObject({ expectedToken: 'TOK2' })
  })

  test('response loss stops the pipeline and stable reconciliation marks an applied intent clean', async () => {
    const server = createServer({ fileFailures: { 'a.md': ['ambiguous-applied'] } })
    renderDetail()
    await stageFile('a.md', 'A')
    const contentReadsBefore = server.calls.filter(
      (call) => call.method === 'GET' && call.url.endsWith('/content'),
    ).length
    await clickSaveAll()

    await screen.findByText(/1 change\(s\) saved/i)
    expect(server.files.get('a.md')).toBe('A')
    expect(server.calls.filter((call) => call.method === 'PUT')).toHaveLength(1)
    expect(
      server.calls.filter((call) => call.method === 'GET' && call.url.endsWith('/content')).length,
    ).toBeGreaterThanOrEqual(contentReadsBefore + 3)
    expect(screen.queryByText(/save result unknown/i)).toBeNull()
    expect((screen.getByTestId('skill-save-button') as HTMLButtonElement).disabled).toBe(true)
  })

  test('409 refreshes a stable foreign baseline/token and a new retry uses that fresh token', async () => {
    const server = createServer({ postFailures: ['reject-409-foreign'] })
    renderDetail()
    await editDescription('my draft')
    await clickSaveAll()
    await screen.findByText(/stable server state differs/i)
    expect(server.currentToken()).toBe('TOK2')

    await clickSaveAll()
    await waitFor(() =>
      expect(server.calls.filter((call) => call.method === 'POST')).toHaveLength(2),
    )
    expect(bodies(server.calls, 'POST', '/save')[1]).toMatchObject({ expectedToken: 'TOK2' })
  })

  test('typed newPath is guarded state but cannot be saved until Add or clear', async () => {
    createServer()
    const { report } = renderDetail()
    const panel = await openFiles()
    const save = screen.getByTestId('skill-save-button') as HTMLButtonElement
    fireEvent.change(within(panel).getByTestId('skill-new-path'), {
      target: { value: 'half-written.md' },
    })
    await waitFor(() => expect(save.disabled).toBe(true))
    expect(save.title).toMatch(/add the typed file path/i)
    await waitFor(() => expect(report).toHaveBeenLastCalledWith('sk1', true))
  })

  test('History is gated by the composite draft and Discard All restores a stable view', async () => {
    createServer()
    renderDetail()
    await editDescription('draft')
    fireEvent.click(screen.getByTestId('skill-tab-history'))
    expect(await screen.findByText(/version history needs a stable skill/i)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /discard all changes/i }))
    await waitFor(() =>
      expect((screen.getByTestId('skill-description-input') as HTMLInputElement).value).toBe(
        'orig desc',
      ),
    )
    expect(await screen.findByText(/no version history yet/i)).toBeTruthy()
  })

  test('fenced content, not stale metadata, seeds the submitted description', async () => {
    const server = createServer({
      description: 'CONTENT-FRESH',
      metadataDescription: 'STALE-META',
    })
    renderDetail()
    fireEvent.click(await screen.findByRole('tab', { name: /^Edit$/i }))
    const panel = screen.getByTestId('skill-panel-edit')
    const editor = panel.querySelector<HTMLTextAreaElement>('textarea')!
    fireEvent.change(editor, { target: { value: 'changed body' } })
    await clickSaveAll()
    await waitFor(() =>
      expect(server.calls.filter((call) => call.method === 'POST')).toHaveLength(1),
    )
    expect(bodies(server.calls, 'POST', '/save')[0]).toMatchObject({
      description: 'CONTENT-FRESH',
      bodyMd: 'changed body',
    })
  })

  test('a clean composite follows an authoritative background content refetch and its fresh token', async () => {
    const server = createServer()
    const { client } = renderDetail()
    const input = (await screen.findByTestId('skill-description-input')) as HTMLInputElement
    expect(input.value).toBe('orig desc')

    server.setRemoteMetadata('server desc', 'server body')
    await client.refetchQueries({ queryKey: ['skills', 'sk1', 'content'], exact: true })
    await waitFor(() => expect(input.value).toBe('server desc'))

    fireEvent.change(input, { target: { value: 'after refetch' } })
    await clickSaveAll()
    await waitFor(() =>
      expect(server.calls.filter((call) => call.method === 'POST')).toHaveLength(1),
    )
    expect(bodies(server.calls, 'POST', '/save')[0]).toMatchObject({
      description: 'after refetch',
      bodyMd: 'server body',
      expectedToken: 'TOK2',
    })
  })

  test('a dirty composite keeps its draft, shows stale, and saves against the refetched token', async () => {
    const server = createServer()
    const { client } = renderDetail()
    await editDescription('local draft')

    server.setRemoteMetadata('foreign desc', 'foreign body')
    await client.refetchQueries({ queryKey: ['skills', 'sk1', 'content'], exact: true })

    expect((screen.getByTestId('skill-description-input') as HTMLInputElement).value).toBe(
      'local draft',
    )
    expect(await screen.findByText(/server changed since this draft began/i)).toBeTruthy()

    await clickSaveAll()
    await waitFor(() =>
      expect(server.calls.filter((call) => call.method === 'POST')).toHaveLength(1),
    )
    expect(bodies(server.calls, 'POST', '/save')[0]).toMatchObject({
      description: 'local draft',
      bodyMd: 'orig body',
      expectedToken: 'TOK2',
    })
  })

  test('a content GET issued before save cannot roll back the clean receipt or canonical token', async () => {
    const server = createServer()
    const { client } = renderDetail()
    await editDescription('saved value')

    const deferred = server.deferNextContentRead()
    const oldRefetch = client.refetchQueries({
      queryKey: ['skills', 'sk1', 'content'],
      exact: true,
    })
    await deferred.started
    await clickSaveAll()
    await waitFor(() =>
      expect(server.calls.filter((call) => call.method === 'POST')).toHaveLength(1),
    )

    deferred.release()
    await oldRefetch
    await waitFor(() =>
      expect((screen.getByTestId('skill-description-input') as HTMLInputElement).value).toBe(
        'saved value',
      ),
    )

    await editDescription('saved again')
    await clickSaveAll()
    await waitFor(() =>
      expect(server.calls.filter((call) => call.method === 'POST')).toHaveLength(2),
    )
    expect(bodies(server.calls, 'POST', '/save')[1]).toMatchObject({
      description: 'saved again',
      expectedToken: 'TOK2',
    })
  })
})
