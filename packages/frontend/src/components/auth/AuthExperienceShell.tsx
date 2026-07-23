import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

export function AuthExperienceShell({
  children,
  wide = false,
}: {
  children: ReactNode
  wide?: boolean
}) {
  const { t } = useTranslation()
  return (
    <main className="auth-experience">
      <section className="auth-experience__story" aria-label={t('nav.brand')}>
        <div className="auth-experience__brand">
          <BrandMark />
          <span>{t('nav.brand')}</span>
        </div>
        <div className="auth-experience__copy">
          <h2>{t('auth.brandTagline')}</h2>
          <p>{t('auth.brandDescription')}</p>
        </div>
        <WorkflowMotif />
        <div className="auth-experience__assurances">
          <span>
            <LockIcon />
            {t('auth.localControl')}
          </span>
          <span>
            <IdentityIcon />
            {t('auth.identityReady')}
          </span>
        </div>
      </section>
      <section className="auth-experience__entry">
        <div
          className={`auth-experience__card ${wide ? 'auth-experience__card--wide' : ''}`.trim()}
        >
          {children}
        </div>
        <p className="auth-experience__footer">
          <LockIcon />
          {t('auth.securityFooter')}
        </p>
      </section>
    </main>
  )
}

function BrandMark() {
  return (
    <svg
      className="auth-experience__brand-mark"
      viewBox="0 0 64 64"
      width="48"
      height="48"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="auth-stream-a" x1="0" y1="0" x2="64" y2="0">
          <stop offset="0" stopColor="#34d399" />
          <stop offset="1" stopColor="#22d3ee" />
        </linearGradient>
        <linearGradient id="auth-stream-b" x1="0" y1="0" x2="64" y2="0">
          <stop offset="0" stopColor="#60a5fa" />
          <stop offset="1" stopColor="#c084fc" />
        </linearGradient>
        <linearGradient id="auth-stream-c" x1="0" y1="0" x2="64" y2="0">
          <stop offset="0" stopColor="#f472b6" />
          <stop offset="1" stopColor="#fb923c" />
        </linearGradient>
      </defs>
      <path d="M6 22Q22 12 32 22T58 22" stroke="url(#auth-stream-a)" />
      <path d="M6 32Q22 22 32 32T58 32" stroke="url(#auth-stream-b)" />
      <path d="M6 42Q22 32 32 42T58 42" stroke="url(#auth-stream-c)" />
    </svg>
  )
}

function WorkflowMotif() {
  return (
    <svg
      className="auth-experience__motif"
      viewBox="0 0 520 260"
      role="img"
      aria-hidden="true"
      preserveAspectRatio="xMidYMid meet"
    >
      <defs>
        <linearGradient id="auth-flow-line" x1="36" y1="0" x2="484" y2="0">
          <stop offset="0" stopColor="#34d399" />
          <stop offset="0.52" stopColor="#60a5fa" />
          <stop offset="1" stopColor="#c084fc" />
        </linearGradient>
        <filter id="auth-node-shadow" x="-30%" y="-30%" width="160%" height="160%">
          <feDropShadow dx="0" dy="8" stdDeviation="10" floodOpacity="0.18" />
        </filter>
      </defs>
      <path className="auth-experience__motif-path" d="M62 132H184C214 132 214 76 246 76H310" />
      <path className="auth-experience__motif-path" d="M184 132C214 132 214 190 246 190H310" />
      <path className="auth-experience__motif-path" d="M390 76C430 76 430 132 458 132" />
      <path className="auth-experience__motif-path" d="M390 190C430 190 430 132 458 132" />
      <g className="auth-experience__motif-node" filter="url(#auth-node-shadow)">
        <rect x="24" y="102" width="76" height="60" rx="14" />
        <circle cx="62" cy="125" r="8" />
        <path d="M47 146h30" />
      </g>
      <g className="auth-experience__motif-node" filter="url(#auth-node-shadow)">
        <rect x="310" y="46" width="80" height="60" rx="14" />
        <circle cx="350" cy="69" r="8" />
        <path d="M335 90h30" />
      </g>
      <g className="auth-experience__motif-node" filter="url(#auth-node-shadow)">
        <rect x="310" y="160" width="80" height="60" rx="14" />
        <circle cx="350" cy="183" r="8" />
        <path d="M335 204h30" />
      </g>
      <g className="auth-experience__motif-node auth-experience__motif-node--result">
        <circle cx="474" cy="132" r="28" />
        <path d="m462 132 8 8 17-19" />
      </g>
    </svg>
  )
}

function LockIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <rect x="5" y="10" width="14" height="10" rx="3" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </svg>
  )
}

function IdentityIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <circle cx="12" cy="8" r="4" />
      <path d="M5 21a7 7 0 0 1 14 0" />
    </svg>
  )
}
