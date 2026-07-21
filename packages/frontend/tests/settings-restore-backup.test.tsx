// RFC-213 PR-1b — the Settings backup card has a "Restore from backup" upload
// that POSTs the file to /api/restore (multipart) and shows the staged result.
//
// Impl-gate P1-5 update: picking a file no longer uploads directly — a
// destructive-confirmation dialog gates the POST. These tests click through
// the confirm to keep the original upload lock; the dialog-gate semantics
// themselves are locked by rfc213-restore-ui.test.tsx.
//
// MUTATION CHECK (manually verified): drop the apiPostMultipart('/api/restore')
// call in BackupCard → the staged message never appears → this reds.

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

async function pickFileAndConfirm(file: File): Promise<void> {
  const input = screen.getByTestId('restore-file-input') as HTMLInputElement
  fireEvent.change(input, { target: { files: [file] } })
  const dialog = await screen.findByRole('dialog')
  fireEvent.click(
    within(dialog).getByRole('button', { name: i18n.t('settings.restoreConfirmAction') }),
  )
}

describe('Settings restore-from-backup', () => {
  test('uploading a backup POSTs multipart to /api/restore and shows staged', async () => {
    apiGet.mockResolvedValue({ pending: null, failed: [] })
    apiPostMultipart.mockResolvedValue({ status: 'staged' })
    render(wrap(<BackupCard />))

    const file = new File([new Uint8Array([1, 2, 3])], 'backup.tar.gz', {
      type: 'application/gzip',
    })
    await pickFileAndConfirm(file)

    await waitFor(() => expect(apiPostMultipart).toHaveBeenCalledTimes(1))
    expect(apiPostMultipart.mock.calls[0]![0]).toBe('/api/restore')
    expect(apiPostMultipart.mock.calls[0]![1]).toBeInstanceOf(FormData)

    await screen.findByText(i18n.t('settings.restoreStaged'))
  })

  test('a failed upload surfaces an error, not a staged message', async () => {
    apiGet.mockResolvedValue({ pending: null, failed: [] })
    apiPostMultipart.mockRejectedValue(new Error('boom'))
    render(wrap(<BackupCard />))

    await pickFileAndConfirm(new File([new Uint8Array([1])], 'b.tar.gz'))

    await waitFor(() => expect(apiPostMultipart).toHaveBeenCalled())
    expect(screen.queryByText(i18n.t('settings.restoreStaged'))).toBeNull()
    // The dialog stays open showing the failure (ConfirmDialog error surface).
    expect(screen.getByRole('dialog')).toBeTruthy()
  })
})
