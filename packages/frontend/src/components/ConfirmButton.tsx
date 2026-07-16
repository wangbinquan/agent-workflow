// Two-click delete button. First click swaps to "Confirm" for 4 seconds;
// any other click outside resets. Keeps M1 dialog-free.
//
// RFC-150 PR-1 (D4): the `danger` boolean became `variant?: 'danger' |
// 'default'` to line up with the `.btn--*` enum vocabulary. No
// primary/ghost variants until a callsite actually needs them (YAGNI).

import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

interface ConfirmButtonProps {
  label: string
  confirmLabel?: string
  /** Optional accessible name when the visible label is intentionally compact. */
  ariaLabel?: string
  /** Accessible name for the armed state; defaults to `confirmLabel`. */
  confirmAriaLabel?: string
  /**
   * Identity of the value being confirmed. If a live refetch replaces the
   * target between clicks, the new target must be armed again instead of
   * inheriting the previous target's confirmation.
   */
  confirmationKey?: string
  onConfirm: () => unknown | Promise<unknown>
  variant?: 'danger' | 'default'
  disabled?: boolean
  size?: 'sm'
}

export function ConfirmButton({
  label,
  confirmLabel,
  ariaLabel,
  confirmAriaLabel,
  confirmationKey,
  onConfirm,
  variant,
  disabled,
  size,
}: ConfirmButtonProps) {
  const { t } = useTranslation()
  const resolvedConfirmLabel = confirmLabel ?? t('common.confirmPrompt')
  const [armed, setArmed] = useState(false)
  const armedKey = useRef<string | undefined>(undefined)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  function clearTimer() {
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = null
  }

  useEffect(() => {
    // The visible row may be index-keyed while its server-backed identity
    // changes after a refetch. Never carry an armed delete across identities.
    setArmed(false)
    armedKey.current = undefined
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = null
  }, [confirmationKey])

  useEffect(() => {
    return () => {
      if (timer.current !== null) clearTimeout(timer.current)
    }
  }, [])

  function handle() {
    if (!armed || armedKey.current !== confirmationKey) {
      clearTimer()
      setArmed(true)
      armedKey.current = confirmationKey
      timer.current = setTimeout(() => setArmed(false), 4000)
      return
    }
    clearTimer()
    setArmed(false)
    armedKey.current = undefined
    const r = onConfirm()
    if (r instanceof Promise) {
      // Mutations surface their error through component state. Consume the
      // rejected promise here so a two-click action cannot also create an
      // unhandled rejection in the browser.
      void r.catch(() => {})
    }
  }

  return (
    <button
      type="button"
      className={`btn ${size === 'sm' ? 'btn--sm' : ''} ${variant === 'danger' ? 'btn--danger' : ''} ${armed ? 'btn--armed' : ''}`}
      disabled={disabled}
      onClick={handle}
      aria-label={armed ? (confirmAriaLabel ?? resolvedConfirmLabel) : (ariaLabel ?? label)}
    >
      {armed ? resolvedConfirmLabel : label}
    </button>
  )
}
