// RFC-198 — secondary history surfaces keep the same table and async-state
// contract as top-level lists: semantic overflow, retryable initial failures,
// stale-row continuity and retryable auxiliary diff failures.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { SkillVersion } from '@agent-workflow/shared'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type * as ApiClientModule from '../src/api/client'

vi.mock('../src/api/client', async () => {
  const actual = await vi.importActual<typeof ApiClientModule>('../src/api/client')
  return {
    ...actual,
    api: {
      ...actual.api,
      get: vi.fn(),
      post: vi.fn(),
    },
  }
})

import { api } from '../src/api/client'
import { SkillVersionHistory } from '../src/components/skill/SkillVersionHistory'
import '../src/i18n'

const mockedGet = vi.mocked(api.get)

const VERSION: SkillVersion = {
  id: 'version-1',
  skillName: 'ux-skill',
  versionIndex: 1,
  source: 'editor',
  summary: 'Initial content',
  fusionId: null,
  restoredFromVersion: null,
  authorUserId: null,
  contentHash: 'hash-1',
  createdAt: 1,
}

function createClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  })
}

function renderHistory(client = createClient()) {
  const view = render(
    <QueryClientProvider client={client}>
      <SkillVersionHistory skillId="skill-ux" currentVersion={2} />
    </QueryClientProvider>,
  )
  return { client, ...view }
}

beforeEach(() => {
  mockedGet.mockReset()
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('<SkillVersionHistory /> RFC-198 UX contract', () => {
  test('initial failure is retryable and recovered rows use TableViewport', async () => {
    let rejectInitial: ((reason: Error) => void) | undefined
    mockedGet
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectInitial = reject
          }),
      )
      .mockResolvedValueOnce([VERSION])

    const { container } = renderHistory()
    expect(await screen.findByTestId('loading-state')).toBeTruthy()

    await act(async () => rejectInitial?.(new Error('versions unavailable')))
    const alert = await screen.findByRole('alert')
    fireEvent.click(within(alert).getByRole('button', { name: /Retry|重试/i }))

    await screen.findByText('Initial content')
    expect(
      container.querySelector('.table-viewport__scroller > table.data-table.data-table--compact'),
    ).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  test('background refetch failure keeps cached rows and exposes retry', async () => {
    mockedGet.mockResolvedValueOnce([VERSION]).mockRejectedValueOnce(new Error('refresh failed'))
    const { client, container } = renderHistory()
    await screen.findByText('Initial content')

    await act(async () => {
      await client.invalidateQueries({ queryKey: ['skills', 'skill-ux', 'versions'] })
    })

    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByText('Initial content')).toBeTruthy()
    expect(
      container.querySelector('.table-viewport__scroller > table.data-table.data-table--compact'),
    ).toBeTruthy()
  })

  test('diff failure stays in the dialog and can be retried', async () => {
    mockedGet
      .mockResolvedValueOnce([VERSION])
      .mockRejectedValueOnce(new Error('diff unavailable'))
      .mockResolvedValueOnce({ from: 1, to: 2, diff: '+recovered diff' })
    renderHistory()
    await screen.findByText('Initial content')

    fireEvent.click(screen.getByRole('button', { name: /Compare|对比/i }))
    const dialog = await screen.findByRole('dialog')
    const alert = await within(dialog).findByRole('alert')
    fireEvent.click(within(alert).getByRole('button', { name: /Retry|重试/i }))

    await waitFor(() => expect(within(dialog).queryByRole('alert')).toBeNull())
    expect(within(dialog).getByText(/recovered diff/)).toBeTruthy()
  })
})
