// RFC-213 PR-1b — the Settings backup card has a "Restore from backup" upload
// that POSTs the file to /api/restore (multipart) and shows the staged result.
//
// MUTATION CHECK (manually verified): drop the apiPostMultipart('/api/restore')
// call in BackupCard → the staged message never appears → this reds.

import { afterEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'

const { apiPostMultipart } = vi.hoisted(() => ({ apiPostMultipart: vi.fn() }))
vi.mock('@/api/client', () => ({
  api: { post: vi.fn() },
  apiPostMultipart,
  ApiError: class ApiError extends Error {},
}))

import { BackupCard } from '../src/routes/settings'
import i18n from '../src/i18n'

afterEach(() => {
  cleanup()
  apiPostMultipart.mockReset()
})

function wrap(children: ReactNode): ReactNode {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

describe('Settings restore-from-backup', () => {
  test('uploading a backup POSTs multipart to /api/restore and shows staged', async () => {
    apiPostMultipart.mockResolvedValue({ status: 'staged' })
    render(wrap(<BackupCard />))

    const input = screen.getByTestId('restore-file-input') as HTMLInputElement
    const file = new File([new Uint8Array([1, 2, 3])], 'backup.tar.gz', {
      type: 'application/gzip',
    })
    fireEvent.change(input, { target: { files: [file] } })

    await waitFor(() => expect(apiPostMultipart).toHaveBeenCalledTimes(1))
    expect(apiPostMultipart.mock.calls[0]![0]).toBe('/api/restore')
    expect(apiPostMultipart.mock.calls[0]![1]).toBeInstanceOf(FormData)

    await screen.findByText(i18n.t('settings.restoreStaged'))
  })

  test('a failed upload surfaces an error, not a staged message', async () => {
    apiPostMultipart.mockRejectedValue(new Error('boom'))
    render(wrap(<BackupCard />))
    const input = screen.getByTestId('restore-file-input') as HTMLInputElement
    fireEvent.change(input, {
      target: { files: [new File([new Uint8Array([1])], 'b.tar.gz')] },
    })
    await waitFor(() => expect(apiPostMultipart).toHaveBeenCalled())
    expect(screen.queryByText(i18n.t('settings.restoreStaged'))).toBeNull()
  })
})
