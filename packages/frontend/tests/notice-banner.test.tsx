// RFC-198 — NoticeBanner tone, live-region and slot contract.

import { render, screen } from '@testing-library/react'
import { describe, expect, test } from 'vitest'
import { NoticeBanner, type NoticeBannerTone } from '../src/components/NoticeBanner'

describe('<NoticeBanner />', () => {
  test('info/success/warning are polite status updates with decorative SVG icons', () => {
    const tones: NoticeBannerTone[] = ['info', 'success', 'warning']

    for (const tone of tones) {
      const { container, unmount } = render(
        <NoticeBanner tone={tone}>Background operation finished.</NoticeBanner>,
      )
      const status = screen.getByRole('status')
      expect(status.classList.contains(`notice-banner--${tone}`)).toBe(true)
      expect(status.classList.contains('notice-banner--comfortable')).toBe(true)
      expect(status.getAttribute('aria-live')).toBe('polite')
      expect(status.textContent).toBe('Background operation finished.')
      expect(container.querySelector('.notice-banner__icon')?.getAttribute('aria-hidden')).toBe(
        'true',
      )
      expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true')
      unmount()
    }
  })

  test('error is an assertive alert and does not use a literal warning glyph', () => {
    const { container } = render(
      <NoticeBanner tone="error" title="Import failed">
        Check the archive and retry.
      </NoticeBanner>,
    )

    const alert = screen.getByRole('alert')
    expect(alert.className).toContain('notice-banner--error')
    expect(alert.getAttribute('aria-live')).toBeNull()
    expect(container.querySelector('.notice-banner__title')?.textContent).toBe('Import failed')
    expect(alert.textContent).toContain('Check the archive and retry.')
    expect(alert.textContent).not.toContain('⚠')
    expect(container.querySelector('svg')).not.toBeNull()
  })

  test('compact size and action render in explicit slots', () => {
    const { container } = render(
      <NoticeBanner tone="warning" size="compact" action={<button type="button">Retry</button>}>
        One source is unavailable.
      </NoticeBanner>,
    )

    expect(screen.getByRole('status').className).toContain('notice-banner--compact')
    expect(container.querySelector('.notice-banner__body')?.textContent).toBe(
      'One source is unavailable.',
    )
    expect(screen.getByRole('button', { name: 'Retry' }).parentElement?.className).toBe(
      'notice-banner__action',
    )
  })

  test('false action does not leave an empty action wrapper', () => {
    const { container } = render(
      <NoticeBanner tone="info" action={false}>
        Up to date.
      </NoticeBanner>,
    )
    expect(container.querySelector('.notice-banner__action')).toBeNull()
  })
})
