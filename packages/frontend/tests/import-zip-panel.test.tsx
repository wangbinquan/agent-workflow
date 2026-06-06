// RFC-019: ImportZipPanel integration — mocks `fetch` for /api/skills (list),
// the parse endpoint, and the commit endpoint, then drives the full flow.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type * as TanStackRouter from '@tanstack/react-router'
import type { CommitSkillZipResponse, ParseSkillZipResponse, Skill } from '@agent-workflow/shared'
import { ImportZipPanel } from '../src/components/skills/ImportZipPanel'
import { setBaseUrl, setToken } from '../src/stores/auth'
import i18n from '../src/i18n'

// The per-row action dropdown is the shared <Select> (RFC-036): the trigger
// carries the data-testid; options live in a portaled listbox (resolved via
// aria-controls). Action option labels are the i18n strings, so we compare
// against i18n.t(...) rather than the raw DecisionAction values.
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
  return Array.from(list.querySelectorAll('[role="option"]')).map(
    (o) => o.querySelector('.select__option-label')?.textContent ?? '',
  )
}

const realFetch = globalThis.fetch

// TanStack Router emits warnings if real navigation runs; stub `useNavigate`
// at the module level so navigate() is a no-op spy we can assert against.
const navigateSpy = vi.fn()
vi.mock('@tanstack/react-router', async () => {
  const actual = await vi.importActual<typeof TanStackRouter>('@tanstack/react-router')
  return { ...actual, useNavigate: () => navigateSpy }
})

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

function fakeZipFile(): File {
  // Content doesn't matter — server response is mocked.
  return new File([new Uint8Array([0x50, 0x4b, 0x05, 0x06])], 'pack.zip', {
    type: 'application/zip',
  })
}

interface FetchRouter {
  list?: Skill[]
  parse?: ParseSkillZipResponse | { status: number; body: unknown }
  commit?: CommitSkillZipResponse | { status: number; body: unknown }
}

function mockFetch(router: FetchRouter): ReturnType<typeof vi.fn> {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/api/skills') && (init?.method ?? 'GET') === 'GET') {
      return jsonResponse(router.list ?? [])
    }
    if (url.endsWith('/api/skills/import-zip/parse')) {
      if (router.parse && 'status' in router.parse) {
        return jsonResponse(router.parse.body, { status: router.parse.status })
      }
      return jsonResponse(router.parse ?? { skills: [], errors: [] })
    }
    if (url.endsWith('/api/skills/import-zip/commit')) {
      if (router.commit && 'status' in router.commit) {
        return jsonResponse(router.commit.body, { status: router.commit.status })
      }
      return jsonResponse(router.commit ?? { created: [], updated: [], skipped: [], failed: [] })
    }
    return new Response('not mocked: ' + url, { status: 404 })
  })
}

describe('ImportZipPanel', () => {
  beforeEach(() => {
    window.localStorage.clear()
    setBaseUrl('http://daemon.test')
    setToken('tok')
    navigateSpy.mockReset()
  })
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  test('parse error path renders the code + message', async () => {
    const fetchMock = mockFetch({
      parse: { status: 422, body: { code: 'zip-traversal', message: 'bad path' } },
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const Wrapper = makeWrapper()
    render(
      <Wrapper>
        <ImportZipPanel />
      </Wrapper>,
    )

    const input = screen.getByTestId('zip-file-input') as HTMLInputElement
    fireEvent.change(input, { target: { files: [fakeZipFile()] } })
    fireEvent.click(screen.getByTestId('zip-parse-button'))

    await waitFor(() => {
      expect(screen.getByTestId('zip-parse-error')).toBeTruthy()
    })
    expect(screen.getByTestId('zip-parse-error').textContent).toContain('zip-traversal')
    expect(screen.getByTestId('zip-parse-error').textContent).toContain('bad path')
  })

  test('candidate table renders with conflict pills + per-row action selects', async () => {
    const fetchMock = mockFetch({
      list: [
        {
          id: 'x',
          name: 'existing-managed',
          description: '',
          sourceKind: 'managed',
          schemaVersion: 1,
          createdAt: 0,
          updatedAt: 0,
          managedPath: 'p',
        },
        {
          id: 'y',
          name: 'existing-external',
          description: '',
          sourceKind: 'external',
          schemaVersion: 1,
          createdAt: 0,
          updatedAt: 0,
          externalPath: '/x',
        },
      ],
      parse: {
        skills: [
          {
            name: 'fresh',
            description: 'a fresh skill',
            fileCount: 3,
            totalBytes: 100,
            warnings: [],
          },
          {
            name: 'existing-managed',
            description: 'collides managed',
            fileCount: 1,
            totalBytes: 50,
            warnings: [],
            conflict: 'managed',
          },
          {
            name: 'existing-external',
            description: 'collides external',
            fileCount: 1,
            totalBytes: 50,
            warnings: [],
            conflict: 'external',
          },
        ],
        errors: [],
      },
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const Wrapper = makeWrapper()
    render(
      <Wrapper>
        <ImportZipPanel />
      </Wrapper>,
    )

    const input = screen.getByTestId('zip-file-input') as HTMLInputElement
    fireEvent.change(input, { target: { files: [fakeZipFile()] } })
    fireEvent.click(screen.getByTestId('zip-parse-button'))

    await waitFor(() => {
      expect(screen.getByTestId('zip-candidate-table')).toBeTruthy()
    })

    // fresh row: no conflict, action select shows import + skip.
    expect((screen.getByTestId('zip-action-fresh') as HTMLButtonElement).disabled).toBe(false)
    expect(actionOptionLabels('zip-action-fresh').sort()).toEqual(
      [actionLabel.import(), actionLabel.skip()].sort(),
    )

    // managed row: skip, overwrite, rename — defaults to skip.
    expect(screen.getByTestId('zip-action-existing-managed').textContent).toContain(
      actionLabel.skip(),
    )
    expect(actionOptionLabels('zip-action-existing-managed').sort()).toEqual(
      [actionLabel.overwrite(), actionLabel.rename(), actionLabel.skip()].sort(),
    )

    // external row: only skip + disabled (a disabled trigger never opens).
    expect((screen.getByTestId('zip-action-existing-external') as HTMLButtonElement).disabled).toBe(
      true,
    )
    expect(screen.getByTestId('zip-action-existing-external').textContent).toContain(
      actionLabel.skip(),
    )
  })

  test('rename inline error appears when target name collides with another candidate', async () => {
    const fetchMock = mockFetch({
      parse: {
        skills: [
          {
            name: 'a',
            description: '',
            fileCount: 1,
            totalBytes: 1,
            warnings: [],
            conflict: 'managed',
          },
          { name: 'taken', description: '', fileCount: 1, totalBytes: 1, warnings: [] },
        ],
        errors: [],
      },
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const Wrapper = makeWrapper()
    render(
      <Wrapper>
        <ImportZipPanel />
      </Wrapper>,
    )
    fireEvent.change(screen.getByTestId('zip-file-input'), {
      target: { files: [fakeZipFile()] },
    })
    fireEvent.click(screen.getByTestId('zip-parse-button'))
    await waitFor(() => screen.getByTestId('zip-candidate-table'))

    // Switch a → rename, type 'taken' (which is candidate b's import name)
    const aTrigger = screen.getByTestId('zip-action-a')
    fireEvent.click(aTrigger)
    fireEvent.mouseDown(
      within(document.getElementById(aTrigger.getAttribute('aria-controls')!)!).getByText(
        actionLabel.rename(),
      ),
    )
    const renameInput = screen.getByTestId('zip-rename-a') as HTMLInputElement
    fireEvent.change(renameInput, { target: { value: 'taken' } })

    expect(screen.getByTestId('zip-rename-error-a')).toBeTruthy()
    expect((screen.getByTestId('zip-commit-button') as HTMLButtonElement).disabled).toBe(true)
  })

  test('commit happy path posts decisions + navigates back on zero failures', async () => {
    const fetchMock = mockFetch({
      parse: {
        skills: [{ name: 'a', description: 'aa', fileCount: 1, totalBytes: 1, warnings: [] }],
        errors: [],
      },
      commit: {
        created: [
          {
            id: 'id1',
            name: 'a',
            description: 'aa',
            sourceKind: 'managed',
            schemaVersion: 1,
            createdAt: 0,
            updatedAt: 0,
            managedPath: 'skills/a/files',
          },
        ],
        updated: [],
        skipped: [],
        failed: [],
      },
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const Wrapper = makeWrapper()
    render(
      <Wrapper>
        <ImportZipPanel />
      </Wrapper>,
    )
    fireEvent.change(screen.getByTestId('zip-file-input'), {
      target: { files: [fakeZipFile()] },
    })
    fireEvent.click(screen.getByTestId('zip-parse-button'))
    await waitFor(() => screen.getByTestId('zip-candidate-table'))

    fireEvent.click(screen.getByTestId('zip-commit-button'))

    await waitFor(() => expect(navigateSpy).toHaveBeenCalled())
    expect(navigateSpy.mock.calls[0]![0]).toEqual({ to: '/skills' })

    // Verify the commit call was made with decisions in its FormData.
    const commitCall = fetchMock.mock.calls.find((c) =>
      String(c[0]).endsWith('/api/skills/import-zip/commit'),
    )
    expect(commitCall).toBeDefined()
    const body = commitCall![1]!.body as FormData
    expect(body.get('decisions')).toBe(JSON.stringify({ a: { action: 'import' } }))
    expect(body.get('file')).toBeInstanceOf(File)
  })

  test('commit with failures stays on page and shows summary', async () => {
    const fetchMock = mockFetch({
      parse: {
        skills: [{ name: 'a', description: '', fileCount: 1, totalBytes: 1, warnings: [] }],
        errors: [],
      },
      commit: {
        created: [],
        updated: [],
        skipped: [],
        failed: [{ name: 'a', code: 'skill-write-failed', message: 'disk full' }],
      },
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const Wrapper = makeWrapper()
    render(
      <Wrapper>
        <ImportZipPanel />
      </Wrapper>,
    )
    fireEvent.change(screen.getByTestId('zip-file-input'), {
      target: { files: [fakeZipFile()] },
    })
    fireEvent.click(screen.getByTestId('zip-parse-button'))
    await waitFor(() => screen.getByTestId('zip-candidate-table'))
    fireEvent.click(screen.getByTestId('zip-commit-button'))

    await waitFor(() => screen.getByTestId('zip-import-summary'))
    expect(navigateSpy).not.toHaveBeenCalled()
    expect(screen.getByTestId('zip-import-summary').textContent).toContain('disk full')
  })

  test('errors banner lists per-row parse errors from the response', async () => {
    const fetchMock = mockFetch({
      parse: {
        skills: [{ name: 'good', description: '', fileCount: 1, totalBytes: 1, warnings: [] }],
        errors: [
          { path: 'bad', code: 'skill-md-missing', message: "skill 'bad' is missing SKILL.md" },
        ],
      },
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const Wrapper = makeWrapper()
    render(
      <Wrapper>
        <ImportZipPanel />
      </Wrapper>,
    )
    fireEvent.change(screen.getByTestId('zip-file-input'), {
      target: { files: [fakeZipFile()] },
    })
    fireEvent.click(screen.getByTestId('zip-parse-button'))
    await waitFor(() => screen.getByTestId('zip-candidate-table'))
    expect(screen.getByText(/skill-md-missing/)).toBeTruthy()
  })
})
