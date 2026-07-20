import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, test } from 'vitest'
import {
  ManagedLiveRegionProvider,
  readableAnnouncementText,
} from '../src/components/ManagedLiveRegion'
import { NoticeBanner } from '../src/components/NoticeBanner'

describe('ManagedLiveRegionProvider', () => {
  test('delegates nested notice semantics to the one polite page announcement', async () => {
    const { container } = render(
      <ManagedLiveRegionProvider>
        <NoticeBanner tone="error" title="Validation failed">
          Fix the selected port.
        </NoticeBanner>
      </ManagedLiveRegionProvider>,
    )

    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getAllByRole('status')).toHaveLength(1)
    expect(container.querySelector('.notice-banner')?.getAttribute('role')).toBeNull()
    await waitFor(() =>
      expect(screen.getByTestId('managed-live-region').textContent).toBe(
        'Validation failed Fix the selected port.',
      ),
    )
  })

  test('extracts readable nested copy consistently', () => {
    expect(
      readableAnnouncementText(
        'Saved',
        <span>
          Draft <strong>version 3</strong>
        </span>,
        <button type="button">Retry</button>,
      ),
    ).toBe('Saved Draft version 3 Retry')
  })
})
