// RFC-198 — shared non-blocking feedback surface.
//
// Error notices are assertive alerts. Informational, success and warning
// notices are polite status updates so routine feedback does not interrupt a
// screen reader. Icons are decorative inline SVG; meaning always remains in
// text and is never conveyed by a glyph or colour alone.

import type { ReactElement, ReactNode } from 'react'

export type NoticeBannerTone = 'info' | 'success' | 'warning' | 'error'
export type NoticeBannerSize = 'compact' | 'comfortable'

export interface NoticeBannerProps {
  tone: NoticeBannerTone
  title?: string
  children: ReactNode
  action?: ReactNode
  size?: NoticeBannerSize
  /** Compatibility hook for callers migrating an established surface class. */
  className?: string
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
  const size = props.size ?? 'comfortable'
  const isError = props.tone === 'error'
  const classes = ['notice-banner', `notice-banner--${props.tone}`, `notice-banner--${size}`]
  if (props.className !== undefined && props.className !== '') classes.push(props.className)

  return (
    <div
      className={classes.join(' ')}
      role={isError ? 'alert' : 'status'}
      aria-live={isError ? undefined : 'polite'}
    >
      <span className="notice-banner__icon" aria-hidden="true">
        <NoticeIcon tone={props.tone} />
      </span>
      <div className="notice-banner__content">
        {props.title !== undefined && <div className="notice-banner__title">{props.title}</div>}
        <div className="notice-banner__body">{props.children}</div>
      </div>
      {isPresent(props.action) && <div className="notice-banner__action">{props.action}</div>}
    </div>
  )
}
