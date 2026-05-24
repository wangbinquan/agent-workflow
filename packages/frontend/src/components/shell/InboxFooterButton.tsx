// RFC-061 PR-C: inbox footer button keeps shell layout intact but no
// longer polls deleted /api/reviews + /api/clarify endpoints. Badge is
// hidden; click still opens the drawer (which renders the PR-C stub).

import { useTranslation } from 'react-i18next'

interface InboxFooterButtonProps {
  open: boolean
  onToggle: () => void
}

export function InboxFooterButton({ open, onToggle }: InboxFooterButtonProps) {
  const { t } = useTranslation()
  return (
    <button
      type="button"
      className={`inbox-footer-button${open ? ' inbox-footer-button--open' : ''}`}
      data-testid="inbox-footer-button"
      aria-label={t('nav.inbox.label')}
      aria-expanded={open}
      onClick={onToggle}
    >
      <InboxIcon />
      <span className="inbox-footer-button__label">{t('nav.inbox.label')}</span>
    </button>
  )
}

function InboxIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M22 12h-6l-2 3h-4l-2-3H2" />
      <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
    </svg>
  )
}
