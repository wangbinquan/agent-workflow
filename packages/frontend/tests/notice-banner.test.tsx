// RFC-198 — NoticeBanner tone, live-region and slot contract.

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, test, vi } from 'vitest'
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

  test('dismiss renders a separately labelled close control without an empty action row', () => {
    const onDismiss = vi.fn()
    const { container } = render(
      <NoticeBanner tone="warning" dismiss={{ label: 'Close alert', onDismiss }}>
        One source is unavailable.
      </NoticeBanner>,
    )

    const close = screen.getByRole('button', { name: 'Close alert' })
    expect(close.parentElement).toBe(screen.getByRole('status'))
    expect(container.querySelector('.notice-banner__action')).toBeNull()
    fireEvent.click(close)
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  test('action and dismiss remain separate grid controls', () => {
    render(
      <NoticeBanner
        tone="warning"
        action={<button type="button">Retry</button>}
        dismiss={{ label: 'Close alert', onDismiss: vi.fn() }}
      >
        One source is unavailable.
      </NoticeBanner>,
    )

    expect(screen.getByRole('button', { name: 'Retry' }).parentElement?.className).toBe(
      'notice-banner__action',
    )
    expect(screen.getByRole('button', { name: 'Close alert' }).parentElement).toBe(
      screen.getByRole('status'),
    )
  })

  test('task banner dismissal moves focus to the next close control', async () => {
    function Stack() {
      const [showFirst, setShowFirst] = useState(true)
      return (
        <>
          <div className="task-detail__banner-stack">
            {showFirst && (
              <NoticeBanner
                tone="warning"
                dismiss={{ label: 'Close first alert', onDismiss: () => setShowFirst(false) }}
              >
                First alert
              </NoticeBanner>
            )}
            <NoticeBanner
              tone="error"
              dismiss={{ label: 'Close second alert', onDismiss: vi.fn() }}
            >
              Second alert
            </NoticeBanner>
          </div>
          <div className="task-detail__workspace">
            <nav className="page-section-nav" tabIndex={-1} />
          </div>
        </>
      )
    }

    render(<Stack />)
    const firstClose = screen.getByRole('button', { name: 'Close first alert' })
    firstClose.focus()
    fireEvent.click(firstClose)
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('button', { name: 'Close second alert' }),
      ),
    )
  })

  test('last task banner dismissal moves focus to the active section destination', async () => {
    function TaskPage() {
      const [visible, setVisible] = useState(true)
      return (
        <main className="page--task-detail">
          <div className="task-detail__banner-stack">
            {visible && (
              <NoticeBanner
                tone="warning"
                dismiss={{ label: 'Close final alert', onDismiss: () => setVisible(false) }}
              >
                Final alert
              </NoticeBanner>
            )}
          </div>
          <div className="task-detail__workspace">
            <nav className="page-section-nav" tabIndex={-1}>
              <div data-page-section-active-leaf="true">
                <a href="/tasks/t1?tab=details">Details</a>
              </div>
            </nav>
          </div>
        </main>
      )
    }

    render(<TaskPage />)
    const close = screen.getByRole('button', { name: 'Close final alert' })
    close.focus()
    fireEvent.click(close)
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('link', { name: 'Details' })),
    )
  })

  test('workspace banner dismissal outside the stack returns focus to compact navigation', async () => {
    function TaskPage() {
      const [visible, setVisible] = useState(true)
      return (
        <main className="page--task-detail">
          <div className="task-detail__workspace">
            <nav className="page-section-nav" tabIndex={-1}>
              <button type="button" role="combobox" aria-label="Details" aria-expanded="false">
                Details
              </button>
            </nav>
            {visible && (
              <NoticeBanner
                tone="error"
                dismiss={{ label: 'Close workspace alert', onDismiss: () => setVisible(false) }}
              >
                Node runs failed
              </NoticeBanner>
            )}
          </div>
        </main>
      )
    }

    render(<TaskPage />)
    const close = screen.getByRole('button', { name: 'Close workspace alert' })
    close.focus()
    fireEvent.click(close)
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('combobox', { name: 'Details' })),
    )
  })

  test('last task banner without section navigation returns focus to a header control', async () => {
    function TaskPage() {
      const [visible, setVisible] = useState(true)
      return (
        <main className="page--task-detail">
          <header className="page__header">
            <a href="/tasks">Back to tasks</a>
          </header>
          <div className="task-detail__banner-stack">
            {visible && (
              <NoticeBanner
                tone="error"
                dismiss={{ label: 'Close room alert', onDismiss: () => setVisible(false) }}
              >
                Room classification failed
              </NoticeBanner>
            )}
          </div>
          <div className="task-detail__workspace" />
        </main>
      )
    }

    render(<TaskPage />)
    const close = screen.getByRole('button', { name: 'Close room alert' })
    close.focus()
    fireEvent.click(close)
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('link', { name: 'Back to tasks' })),
    )
  })

  test('pending task banner without navigation or header controls returns focus to app content', async () => {
    function PendingTaskPage() {
      const [visible, setVisible] = useState(true)
      return (
        <main className="content" tabIndex={-1} data-testid="app-content">
          <section className="page--task-detail">
            <header className="page__header">
              <h1>Loading task</h1>
            </header>
            <div className="task-detail__banner-stack">
              {visible && (
                <NoticeBanner
                  tone="error"
                  dismiss={{ label: 'Close stale alert', onDismiss: () => setVisible(false) }}
                >
                  Cached task request failed
                </NoticeBanner>
              )}
            </div>
          </section>
        </main>
      )
    }

    render(<PendingTaskPage />)
    const close = screen.getByRole('button', { name: 'Close stale alert' })
    close.focus()
    fireEvent.click(close)
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('app-content')))
  })
})
