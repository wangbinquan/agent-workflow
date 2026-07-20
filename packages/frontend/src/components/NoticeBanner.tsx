// RFC-198 — shared non-blocking feedback surface.
//
// Error notices are assertive alerts. Informational, success and warning
// notices are polite status updates so routine feedback does not interrupt a
// screen reader. Icons are decorative inline SVG; meaning always remains in
// text and is never conveyed by a glyph or colour alone.

import { useEffect, type MouseEvent, type ReactElement, type ReactNode } from 'react'
import { readableAnnouncementText, useManagedLiveRegion } from './ManagedLiveRegion'

export type NoticeBannerTone = 'info' | 'success' | 'warning' | 'error'
export type NoticeBannerSize = 'compact' | 'comfortable'

export interface NoticeBannerProps {
  tone: NoticeBannerTone
  title?: string
  children: ReactNode
  action?: ReactNode
  /** Explicit close control; the owner supplies both behavior and localized label. */
  dismiss?: {
    label: string
    onDismiss: () => void
  }
  size?: NoticeBannerSize
  /** Compatibility hook for callers migrating an established surface class. */
  className?: string
  /** Optional root data-testid — RFC-203 T5b: migrated error surfaces keep
   *  their established test anchors on the banner itself (no wrapper divs). */
  testid?: string
}

function NoticeIcon({ tone }: { tone: NoticeBannerTone }): ReactElement {
  if (tone === 'success') {
    return (
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" aria-hidden="true">
        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
        <path
          d="m8 12 2.5 2.5L16 9"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    )
  }

  if (tone === 'warning') {
    return (
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" aria-hidden="true">
        <path
          d="M12 3 2.8 20h18.4L12 3Z"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinejoin="round"
        />
        <path d="M12 9v5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        <circle cx="12" cy="17" r="1" fill="currentColor" />
      </svg>
    )
  }

  if (tone === 'error') {
    return (
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" aria-hidden="true">
        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
        <path d="M12 7v6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        <circle cx="12" cy="17" r="1" fill="currentColor" />
      </svg>
    )
  }

  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
      <path d="M12 11v6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <circle cx="12" cy="7" r="1" fill="currentColor" />
    </svg>
  )
}

function isPresent(node: ReactNode): boolean {
  return node !== undefined && node !== null && node !== false
}

export function NoticeBanner(props: NoticeBannerProps): ReactElement {
  const managedLiveRegion = useManagedLiveRegion()
  const size = props.size ?? 'comfortable'
  const isError = props.tone === 'error'
  const classes = ['notice-banner', `notice-banner--${props.tone}`, `notice-banner--${size}`]
  if (props.className !== undefined && props.className !== '') classes.push(props.className)
  const announcement = readableAnnouncementText(props.title, props.children)

  useEffect(() => {
    if (managedLiveRegion !== null && announcement !== '') {
      managedLiveRegion.announce(announcement)
    }
  }, [announcement, managedLiveRegion])

  return (
    <div
      className={classes.join(' ')}
      role={managedLiveRegion === null ? (isError ? 'alert' : 'status') : undefined}
      aria-live={managedLiveRegion === null && !isError ? 'polite' : undefined}
      data-testid={props.testid}
    >
      <span className="notice-banner__icon" aria-hidden="true">
        <NoticeIcon tone={props.tone} />
      </span>
      <div className="notice-banner__content">
        {props.title !== undefined && <div className="notice-banner__title">{props.title}</div>}
        <div className="notice-banner__body">{props.children}</div>
      </div>
      {isPresent(props.action) && <div className="notice-banner__action">{props.action}</div>}
      {props.dismiss !== undefined && (
        <BannerDismissButton label={props.dismiss.label} onDismiss={props.dismiss.onDismiss} />
      )}
    </div>
  )
}

export function BannerDismissButton({
  label,
  onDismiss,
  testId,
}: {
  label: string
  onDismiss: () => void
  testId?: string
}): ReactElement {
  const handleDismiss = (event: MouseEvent<HTMLButtonElement>) => {
    const current = event.currentTarget
    const taskPage = current.closest<HTMLElement>('.page--task-detail')
    const stack = current.closest<HTMLElement>('.task-detail__banner-stack')
    const wasFocused = document.activeElement === current
    const dismissButtons =
      stack === null
        ? []
        : Array.from(stack.querySelectorAll<HTMLButtonElement>('.banner-dismiss-button'))
    const currentIndex = dismissButtons.indexOf(current)
    const nextDismiss =
      currentIndex < 0
        ? undefined
        : (dismissButtons[currentIndex + 1] ?? dismissButtons[currentIndex - 1])
    const sectionNav = taskPage?.querySelector<HTMLElement>(
      '.task-detail__workspace > .page-section-nav',
    )
    const compactDestination = sectionNav?.querySelector<HTMLElement>('[role="combobox"]')
    const activeDestination = sectionNav
      ?.querySelector<HTMLElement>('[data-page-section-active-leaf="true"]')
      ?.querySelector<HTMLElement>(
        'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )
    const headerDestination = taskPage?.querySelector<HTMLElement>(
      '.page__header a[href], .page__header button:not([disabled]), .page__header [tabindex]:not([tabindex="-1"])',
    )
    const appContent = taskPage?.closest<HTMLElement>('.content[tabindex]')
    const fallbackFocus =
      compactDestination ?? activeDestination ?? headerDestination ?? sectionNav ?? appContent

    onDismiss()
    if (!wasFocused) return
    queueMicrotask(() => {
      if (nextDismiss?.isConnected === true) nextDismiss.focus()
      else if (fallbackFocus?.isConnected === true) fallbackFocus.focus()
    })
  }

  return (
    <button
      type="button"
      className="banner-dismiss-button"
      aria-label={label}
      title={label}
      onClick={handleDismiss}
      data-testid={testId}
    >
      <span aria-hidden="true">×</span>
    </button>
  )
}
