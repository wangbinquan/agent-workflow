// RFC-196: ImportZipPanel integration locks the select → review → result
// state machine while preserving RFC-019/102 parse, decision, and ACL wire.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type * as TanStackRouter from '@tanstack/react-router'
import {
  SKILL_ZIP_LIMITS,
  type CommitSkillZipResponse,
  type ParseSkillZipResponse,
  type Skill,
} from '@agent-workflow/shared'
import { ImportZipPanel } from '../src/components/skills/ImportZipPanel'
import { setBaseUrl, setToken } from '../src/stores/auth'
import i18n from '../src/i18n'

const navigateSpy = vi.fn()
vi.mock('@tanstack/react-router', async () => {
  const actual = await vi.importActual<typeof TanStackRouter>('@tanstack/react-router')
  return {
    ...actual,
    useNavigate: () => navigateSpy,
    Link: ({
      children,
      to,
      params,
      'aria-label': ariaLabel,
    }: {
      children: React.ReactNode
      to: string
      params?: Record<string, string>
      'aria-label'?: string
    }) => (
      <a href={to.replace('$name', encodeURIComponent(params?.name ?? ''))} aria-label={ariaLabel}>
        {children}
      </a>
    ),
  }
})

const actionLabel = {
  import: () => i18n.t('skills.zipActionImport'),
  skip: () => i18n.t('skills.zipActionSkip'),
  overwrite: () => i18n.t('skills.zipActionOverwrite'),
  rename: () => i18n.t('skills.zipActionRename'),
}

function actionOptionLabels(testid: string): string[] {
  const trigger = screen.getByTestId(testid)
  fireEvent.click(trigger)
  const list = document.getElementById(trigger.getAttribute('aria-controls')!)!
  const labels = Array.from(list.querySelectorAll('[role="option"]')).map(
    (option) => option.querySelector('.select__option-label')?.textContent ?? '',
  )
  fireEvent.keyDown(list, { key: 'Escape' })
  return labels
}

function chooseAction(testid: string, label: string): void {
  const trigger = screen.getByTestId(testid)
  fireEvent.click(trigger)
  const list = document.getElementById(trigger.getAttribute('aria-controls')!)!
  fireEvent.mouseDown(within(list).getByText(label))
}

const realFetch = globalThis.fetch

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  })
}

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  }
}

function renderPanel() {
  const Wrapper = makeWrapper()
  return render(
    <Wrapper>
      <ImportZipPanel />
    </Wrapper>,
  )
}

function fakeZipFile(name = 'pack.zip'): File {
  return new File([new Uint8Array([0x50, 0x4b, 0x05, 0x06])], name, {
    type: 'application/zip',
  })
}

function makeSkill(name: string): Skill {
  return {
    id: `id-${name}`,
    name,
    description: `${name} description`,
    sourceKind: 'managed',
    schemaVersion: 1,
    contentVersion: 1,
    createdAt: 0,
    updatedAt: 0,
    managedPath: `skills/${name}/files`,
  }
}

interface EndpointSpec {
  body?: unknown
  status?: number
  reject?: unknown
}

type Endpoint = EndpointSpec | (() => Promise<Response>)

interface FetchRouter {
  list?: Endpoint
  parse?: Endpoint
  commit?: Endpoint
}

async function responseFor(endpoint: Endpoint | undefined, fallback: unknown): Promise<Response> {
  if (typeof endpoint === 'function') return endpoint()
  if (endpoint?.reject !== undefined) throw endpoint.reject
  return jsonResponse(endpoint?.body ?? fallback, { status: endpoint?.status ?? 200 })
}

function mockFetch(router: FetchRouter): ReturnType<typeof vi.fn> {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/api/skills') && (init?.method ?? 'GET') === 'GET') {
      return responseFor(router.list, [])
    }
    if (url.endsWith('/api/skills/import-zip/parse')) {
      return responseFor(router.parse, { skills: [], errors: [] })
    }
    if (url.endsWith('/api/skills/import-zip/commit')) {
      return responseFor(router.commit, { created: [], updated: [], skipped: [], failed: [] })
    }
    return new Response('not mocked: ' + url, { status: 404 })
  })
}

function installRouter(router: FetchRouter): ReturnType<typeof vi.fn> {
  const fetchMock = mockFetch(router)
  globalThis.fetch = fetchMock as unknown as typeof fetch
  return fetchMock
}

function chooseFile(file: File = fakeZipFile()): void {
  fireEvent.change(screen.getByTestId('zip-file-input'), { target: { files: [file] } })
}

async function parseSelectedFile(): Promise<void> {
  fireEvent.click(screen.getByTestId('zip-parse-button'))
  await waitFor(() => expect(screen.queryByTestId('zip-review-phase')).not.toBeNull())
}

function parseResponse(skills: ParseSkillZipResponse['skills']): ParseSkillZipResponse {
  return { skills, errors: [] }
}

function candidate(
  name: string,
  opts: Partial<ParseSkillZipResponse['skills'][number]> = {},
): ParseSkillZipResponse['skills'][number] {
  return {
    name,
    description: `${name} description`,
    fileCount: 2,
    totalBytes: 1536,
    warnings: [],
    ...opts,
  }
}

describe('ImportZipPanel (RFC-196)', () => {
  beforeEach(() => {
    window.localStorage.clear()
    setBaseUrl('http://daemon.test')
    setToken('tok')
    navigateSpy.mockReset()
  })

  afterEach(() => {
    globalThis.fetch = realFetch
  })

  test('select phase rejects wrong type and oversize before any parse request', async () => {
    const fetchMock = installRouter({})
    renderPanel()

    expect((screen.getByTestId('zip-parse-button') as HTMLButtonElement).disabled).toBe(true)
    chooseFile(new File(['x'], 'pack.tar.gz'))
    expect(screen.getByRole('alert').textContent).toContain('.zip')

    chooseFile({ name: 'huge.zip', size: SKILL_ZIP_LIMITS.totalBytes + 1 } as File)
    expect(screen.getByRole('alert').textContent).toContain('64 MiB')

    const parseCalls = fetchMock.mock.calls.filter((call) =>
      String(call[0]).endsWith('/api/skills/import-zip/parse'),
    )
    expect(parseCalls).toHaveLength(0)
  })

  test('parse network error preserves the file and can retry successfully', async () => {
    let attempts = 0
    const router: FetchRouter = {
      parse: async () => {
        attempts++
        if (attempts === 1) throw new Error('network offline')
        return jsonResponse(parseResponse([candidate('fresh')]))
      },
    }
    installRouter(router)
    renderPanel()
    chooseFile()
    fireEvent.click(screen.getByTestId('zip-parse-button'))

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('network offline'))
    expect(screen.getByText('pack.zip')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: i18n.t('skills.zipRetry') }))
    await waitFor(() => expect(screen.queryByTestId('zip-row-fresh')).not.toBeNull())
    expect(attempts).toBe(2)
  })

  test('review uses candidate cards and keeps archive errors beside valid rows', async () => {
    installRouter({
      parse: {
        body: {
          skills: [candidate('fresh', { warnings: ['name will be normalised'] })],
          errors: [{ path: 'bad', code: 'skill-md-missing', message: 'SKILL.md is missing' }],
        } satisfies ParseSkillZipResponse,
      },
    })
    renderPanel()
    chooseFile()
    await parseSelectedFile()

    expect(screen.getByTestId('zip-candidate-list')).toBeTruthy()
    expect(screen.getByTestId('zip-row-fresh').tagName).toBe('DIV')
    expect(screen.queryByTestId('zip-candidate-table')).toBeNull()
    expect(screen.getByText('skill-md-missing')).toBeTruthy()
    expect(screen.getByText('name will be normalised')).toBeTruthy()
  })

  test('zero valid candidates renders an actionable empty state', async () => {
    installRouter({
      parse: {
        body: {
          skills: [],
          errors: [{ path: '', code: 'no-skill-found', message: 'nothing found' }],
        } satisfies ParseSkillZipResponse,
      },
    })
    renderPanel()
    chooseFile()
    await parseSelectedFile()

    expect(screen.getByText(i18n.t('skills.zipNoCandidatesTitle'))).toBeTruthy()
    expect(screen.queryByTestId('zip-commit-button')).toBeNull()
    fireEvent.click(screen.getAllByRole('button', { name: i18n.t('skills.zipReplace') })[0]!)
    expect(screen.getByTestId('zip-select-phase')).toBeTruthy()
  })

  test('owner and non-owner conflicts preserve action matrix and unique accessible names', async () => {
    installRouter({
      parse: {
        body: parseResponse([
          candidate('fresh'),
          candidate('owner', { conflict: 'managed', canOverwrite: true }),
          candidate('locked', { conflict: 'managed', canOverwrite: false }),
        ]),
      },
    })
    renderPanel()
    chooseFile()
    await parseSelectedFile()

    expect(actionOptionLabels('zip-action-fresh').sort()).toEqual(
      [actionLabel.import(), actionLabel.skip()].sort(),
    )
    expect(actionOptionLabels('zip-action-owner').sort()).toEqual(
      [actionLabel.skip(), actionLabel.overwrite(), actionLabel.rename()].sort(),
    )
    expect(actionOptionLabels('zip-action-locked').sort()).toEqual(
      [actionLabel.skip(), actionLabel.rename()].sort(),
    )
    expect(screen.getByTestId('zip-action-owner').textContent).toContain(actionLabel.skip())
    expect(
      screen.getByRole('combobox', { name: i18n.t('skills.zipActionFor', { name: 'locked' }) }),
    ).toBeTruthy()
  })

  test('rename validation connects the named field error and disables import', async () => {
    installRouter({
      list: { body: [] },
      parse: {
        body: parseResponse([candidate('a', { conflict: 'managed' }), candidate('taken')]),
      },
    })
    renderPanel()
    chooseFile()
    await parseSelectedFile()
    chooseAction('zip-action-a', actionLabel.rename())

    const input = screen.getByRole('textbox', {
      name: i18n.t('skills.zipRenameFor', { name: 'a' }),
    }) as HTMLInputElement
    fireEvent.change(input, { target: { value: 'taken' } })
    const error = document.getElementById('zip-rename-error-a')!
    expect(input.getAttribute('aria-describedby')).toBe(error.id)
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect((screen.getByTestId('zip-commit-button') as HTMLButtonElement).disabled).toBe(true)
  })

  test('rename fails closed when existing names cannot be loaded and offers retry', async () => {
    let listAttempts = 0
    const router: FetchRouter = {
      list: async () => {
        listAttempts++
        if (listAttempts === 1) return jsonResponse({ message: 'unavailable' }, { status: 503 })
        return jsonResponse([])
      },
      parse: { body: parseResponse([candidate('a', { conflict: 'managed' })]) },
    }
    installRouter(router)
    renderPanel()
    chooseFile()
    await parseSelectedFile()
    chooseAction('zip-action-a', actionLabel.rename())
    fireEvent.change(screen.getByTestId('zip-rename-a'), { target: { value: 'a-new' } })

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain(i18n.t('skills.zipNamesUnavailable')),
    )
    expect((screen.getByTestId('zip-commit-button') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: i18n.t('skills.zipRetry') }))
    await waitFor(() =>
      expect((screen.getByTestId('zip-commit-button') as HTMLButtonElement).disabled).toBe(false),
    )
    expect(listAttempts).toBe(2)
  })

  test('commit posts exact FormData once, then full success stays on a focused result page', async () => {
    let resolveCommit!: (response: Response) => void
    const commitPromise = new Promise<Response>((resolve) => {
      resolveCommit = resolve
    })
    let commitCalls = 0
    const summary: CommitSkillZipResponse = {
      created: [makeSkill('fresh')],
      updated: [],
      skipped: [],
      failed: [],
    }
    const fetchMock = installRouter({
      parse: { body: parseResponse([candidate('fresh')]) },
      commit: async () => {
        commitCalls++
        return commitPromise
      },
    })
    renderPanel()
    chooseFile()
    await parseSelectedFile()

    const commitButton = screen.getByTestId('zip-commit-button') as HTMLButtonElement
    fireEvent.click(commitButton)
    fireEvent.click(commitButton)
    expect(commitCalls).toBe(1)
    expect(commitButton.disabled).toBe(true)
    resolveCommit(jsonResponse(summary))

    const result = await screen.findByTestId('zip-import-summary')
    expect(result.textContent).toContain(i18n.t('skills.zipResultSuccess'))
    expect(navigateSpy).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: /Import complete/ }))
    expect(screen.getByRole('link', { name: /fresh/ }).getAttribute('href')).toBe('/skills/fresh')

    const commitCall = fetchMock.mock.calls.find((call) =>
      String(call[0]).endsWith('/api/skills/import-zip/commit'),
    )
    const body = commitCall![1]!.body as FormData
    expect(body.get('decisions')).toBe(JSON.stringify({ fresh: { action: 'import' } }))
    expect(body.get('file')).toBeInstanceOf(File)
  })

  test('commit HTTP errors preserve review decisions and malformed bodies use the fallback', async () => {
    let attempts = 0
    const router: FetchRouter = {
      parse: { body: parseResponse([candidate('fresh')]) },
      commit: async () => {
        attempts++
        if (attempts === 1) return jsonResponse({ message: 'disk unavailable' }, { status: 503 })
        if (attempts === 2) return jsonResponse(null, { status: 503 })
        return jsonResponse({ created: [makeSkill('fresh')], updated: [], skipped: [], failed: [] })
      },
    }
    installRouter(router)
    renderPanel()
    chooseFile()
    await parseSelectedFile()
    fireEvent.click(screen.getByTestId('zip-commit-button'))

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('disk unavailable'))
    expect(screen.getByTestId('zip-row-fresh')).toBeTruthy()
    fireEvent.click(screen.getByTestId('zip-commit-button'))
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain(
        i18n.t('skills.zipCommitFailedFallback', { status: 503 }),
      ),
    )
    expect(screen.getByTestId('zip-row-fresh')).toBeTruthy()
    fireEvent.click(screen.getByTestId('zip-commit-button'))
    await screen.findByTestId('zip-import-summary')
    expect(attempts).toBe(3)
  })

  test('partial and no-write responses render stable grouped results', async () => {
    const router: FetchRouter = {
      parse: {
        body: parseResponse([candidate('a'), candidate('b', { conflict: 'managed' })]),
      },
      commit: {
        body: {
          created: [makeSkill('a')],
          updated: [],
          skipped: [{ name: 'b', reason: 'skipped by user' }],
          failed: [{ name: 'c', code: 'skill-write-failed', message: 'disk full' }],
        } satisfies CommitSkillZipResponse,
      },
    }
    installRouter(router)
    renderPanel()
    chooseFile()
    await parseSelectedFile()
    fireEvent.click(screen.getByTestId('zip-commit-button'))
    await screen.findByText(i18n.t('skills.zipResultPartial'))
    expect(screen.getByTestId('zip-import-summary').textContent).toContain('disk full')
    expect(screen.getByText('skipped by user')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: i18n.t('skills.zipContinue') }))
    await waitFor(() => expect(screen.getByTestId('zip-select-phase')).toBeTruthy())

    router.parse = { body: parseResponse([candidate('d')]) }
    router.commit = {
      body: {
        created: [],
        updated: [],
        skipped: [],
        failed: [{ name: 'd', code: 'skill-write-failed', message: 'still full' }],
      } satisfies CommitSkillZipResponse,
    }
    chooseFile(fakeZipFile('second.zip'))
    await parseSelectedFile()
    fireEvent.click(screen.getByTestId('zip-commit-button'))
    await screen.findByText(i18n.t('skills.zipResultNoWrite'))
  })

  test('continue resets to a fresh select phase and returns focus; list action navigates', async () => {
    installRouter({
      parse: { body: parseResponse([candidate('fresh')]) },
      commit: {
        body: { created: [makeSkill('fresh')], updated: [], skipped: [], failed: [] },
      },
    })
    renderPanel()
    chooseFile()
    await parseSelectedFile()
    fireEvent.click(screen.getByTestId('zip-commit-button'))
    await screen.findByTestId('zip-import-summary')

    fireEvent.click(screen.getByRole('button', { name: i18n.t('skills.zipContinue') }))
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByTestId('zip-file-input-button')),
    )
    expect(screen.queryByText('pack.zip')).toBeNull()

    chooseFile()
    await parseSelectedFile()
    fireEvent.click(screen.getByTestId('zip-commit-button'))
    await screen.findByTestId('zip-import-summary')
    fireEvent.click(screen.getByRole('button', { name: i18n.t('skills.zipReturnList') }))
    expect(navigateSpy).toHaveBeenCalledWith({ to: '/skills' })
  })

  test('replacing file A clears old rows before parsing file B', async () => {
    let parseCalls = 0
    installRouter({
      parse: async () => {
        parseCalls++
        return jsonResponse(
          parseCalls === 1
            ? parseResponse([candidate('from-a')])
            : parseResponse([candidate('from-b')]),
        )
      },
    })
    renderPanel()
    chooseFile(fakeZipFile('a.zip'))
    await parseSelectedFile()
    expect(screen.getByTestId('zip-row-from-a')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: i18n.t('skills.zipBack') }))
    expect(screen.queryByTestId('zip-row-from-a')).toBeNull()
    chooseFile(fakeZipFile('b.zip'))
    await parseSelectedFile()
    expect(screen.getByTestId('zip-row-from-b')).toBeTruthy()
    expect(screen.queryByTestId('zip-row-from-a')).toBeNull()
  })
})
