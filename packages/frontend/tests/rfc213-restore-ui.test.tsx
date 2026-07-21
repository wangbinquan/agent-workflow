// RFC-213 impl-gate P1-5 — restore staging must be CONFIRMED, VISIBLE and
// CANCELABLE in the Settings backup card.
//
// Locks (review finding: picking a file used to upload+arm a whole-platform
// rollback with ZERO confirmation, and the armed state was invisible and
// could not be canceled):
//   1. Picking a file opens the shared ConfirmDialog and does NOT upload;
//      Cancel closes it with no request; only Confirm fires the POST.
//   2. A non-null GET /api/restore/pending renders a warning banner (staged
//      time + size + restart hint) with a two-click cancel that DELETEs
//      /api/restore/pending and refetches.
//   3. A failed-restore quarantine entry renders (time + error + dir path).
//
// MUTATION CHECK (manually verified while writing): reverting BackupCard's
// onRestoreFile to upload directly reds test 1 (POST fired before any dialog);
// dropping the pending banner JSX reds test 2; dropping the failed banner JSX
// reds test 3.

import { afterEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'

const { apiPostMultipart, apiGet, apiDelete } = vi.hoisted(() => ({
  apiPostMultipart: vi.fn(),
  apiGet: vi.fn(),
  apiDelete: vi.fn(),
}))
vi.mock('@/api/client', () => ({
  api: { post: vi.fn(), get: apiGet, delete: apiDelete },
  apiPostMultipart,
  ApiError: class ApiError extends Error {},
}))

import { BackupCard } from '../src/routes/settings'
import i18n from '../src/i18n'

afterEach(() => {
  cleanup()
  apiPostMultipart.mockReset()
  apiGet.mockReset()
  apiDelete.mockReset()
})

function wrap(children: ReactNode): ReactNode {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

function pickFile(name = 'backup.tar.gz'): void {
  const input = screen.getByTestId('restore-file-input') as HTMLInputElement
  const file = new File([new Uint8Array([1, 2, 3])], name, { type: 'application/gzip' })
  fireEvent.change(input, { target: { files: [file] } })
}

const EMPTY = { pending: null, failed: [] }

describe('RFC-213 P1-5 restore confirmation gate', () => {
  test('picking a file opens the confirm dialog without uploading; cancel sends nothing; confirm POSTs', async () => {
    apiGet.mockResolvedValue(EMPTY)
    apiPostMultipart.mockResolvedValue({ status: 'staged' })
    render(wrap(<BackupCard />))

    pickFile()
    const dialog = await screen.findByRole('dialog')
    // The destructive wording (whole-instance rollback) is the dialog body.
    expect(screen.getByText(i18n.t('settings.restoreConfirmTitle'))).toBeTruthy()
    // Nothing uploaded yet — the dialog gates the POST.
    expect(apiPostMultipart).not.toHaveBeenCalled()

    fireEvent.click(within(dialog).getByRole('button', { name: i18n.t('common.cancel') }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(apiPostMultipart).not.toHaveBeenCalled()

    // Re-pick and confirm — only now the multipart POST fires.
    pickFile()
    const dialog2 = await screen.findByRole('dialog')
    fireEvent.click(
      within(dialog2).getByRole('button', { name: i18n.t('settings.restoreConfirmAction') }),
    )
    await waitFor(() => expect(apiPostMultipart).toHaveBeenCalledTimes(1))
    expect(apiPostMultipart.mock.calls[0]![0]).toBe('/api/restore')
    expect(apiPostMultipart.mock.calls[0]![1]).toBeInstanceOf(FormData)
    await screen.findByText(i18n.t('settings.restoreStaged'))
  })
})

describe('RFC-213 P1-5 staged-restore visibility', () => {
  test('a pending restore renders the banner and the two-click cancel DELETEs it', async () => {
    apiGet.mockResolvedValueOnce({
      pending: {
        requestedAt: 1753142400000,
        stagedBytes: 5 * 1024 * 1024,
        noMigrate: false,
        skipIntegrityCheck: false,
      },
      failed: [],
    })
    apiGet.mockResolvedValue(EMPTY)
    apiDelete.mockResolvedValue({ cleared: true })
    render(wrap(<BackupCard />))

    const banner = await screen.findByTestId('restore-pending-banner')
    expect(banner.textContent).toContain(i18n.t('settings.restorePendingTitle'))
    expect(banner.textContent).toContain('5.00 MB')
    expect(banner.textContent).toContain(new Date(1753142400000).toLocaleString())

    // ConfirmButton: the first click only arms — no DELETE yet.
    const cancel = within(banner).getByRole('button', {
      name: i18n.t('settings.restorePendingCancel'),
    })
    fireEvent.click(cancel)
    expect(apiDelete).not.toHaveBeenCalled()

    fireEvent.click(within(banner).getByRole('button', { name: i18n.t('common.confirmPrompt') }))
    await waitFor(() => expect(apiDelete).toHaveBeenCalledTimes(1))
    expect(apiDelete.mock.calls[0]![0]).toBe('/api/restore/pending')

    // Invalidation refetches (now empty) and the banner disappears.
    await waitFor(() => expect(screen.queryByTestId('restore-pending-banner')).toBeNull())
  })

  test('a failed-restore quarantine entry renders time + error + dir', async () => {
    apiGet.mockResolvedValue({
      pending: null,
      failed: [
        {
          dir: '/home/u/.agent-workflow/.restore-pending.failed-1753000000000',
          failedAt: 1753000000000,
          error: 'integrity check failed: quick_check reported problems',
        },
      ],
    })
    render(wrap(<BackupCard />))

    const banner = await screen.findByTestId('restore-failed-banner')
    expect(banner.textContent).toContain(i18n.t('settings.restoreFailedTitle'))
    expect(banner.textContent).toContain('integrity check failed: quick_check reported problems')
    expect(banner.textContent).toContain(new Date(1753000000000).toLocaleString())
    expect(banner.textContent).toContain(
      '/home/u/.agent-workflow/.restore-pending.failed-1753000000000',
    )
  })
})
