// Two-click delete button. First click swaps to "Confirm" for 4 seconds;
// any other click outside resets. Keeps M1 dialog-free.

import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

interface ConfirmButtonProps {
  label: string
  confirmLabel?: string
  onConfirm: () => unknown | Promise<unknown>
  danger?: boolean
  disabled?: boolean
}

export function ConfirmButton({
  label,
  confirmLabel,
  onConfirm,
  danger,
  disabled,
}: ConfirmButtonProps) {
  const { t } = useTranslation()
  const resolvedConfirmLabel = confirmLabel ?? t('common.confirmPrompt')
  const [armed, setArmed] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (timer.current !== null) clearTimeout(timer.current)
    }
  }, [])

  function handle() {
    if (!armed) {
      setArmed(true)
      timer.current = setTimeout(() => setArmed(false), 4000)
      return
    }
    if (timer.current !== null) clearTimeout(timer.current)
    setArmed(false)
    const r = onConfirm()
    if (r instanceof Promise) void r
  }

  return (
    <button
      type="button"
      className={`btn ${danger === true ? 'btn--danger' : ''} ${armed ? 'btn--armed' : ''}`}
      disabled={disabled}
      onClick={handle}
    >
      {armed ? resolvedConfirmLabel : label}
    </button>
  )
}
