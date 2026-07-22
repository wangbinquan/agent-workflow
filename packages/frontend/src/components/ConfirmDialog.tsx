// RFC-198 — transactional confirmation built on the shared Dialog chrome.
//
// ConfirmDialog owns its pending/error state. Callers return their mutation
// promise from onConfirm; only a fulfilled operation closes the dialog. A
// synchronous ref closes the double-click window before React can render the
// disabled state.

import {
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from 'react'
import { useTranslation } from 'react-i18next'
import { Dialog } from './Dialog'
import { ErrorBanner } from './ErrorBanner'
import { Field, TextInput } from './Form'

export interface ConfirmDialogProps {
  open: boolean
  title: string
  description: ReactNode
  confirmLabel: string
  cancelLabel?: string
  tone?: 'default' | 'danger'
  /**
   * RFC-222 (D5) — type-to-confirm mode. When set, the dialog renders a name
   * input; the confirm button stays disabled until the trimmed input EXACTLY
   * equals `expected`. On confirm, the trimmed value is handed to onConfirm as
   * `{ typedConfirm }` — callers MUST send THAT (the user's actual keystrokes),
   * never the known `expected` constant, so the server-side check is real.
   */
  confirmInput?: { expected: string; label: string; placeholder?: string }
  onConfirm: (ctx?: { typedConfirm?: string }) => void | Promise<void>
  onClose: () => void
  triggerRef?: RefObject<HTMLElement | null>
  restoreFocusFallbackRef?: RefObject<HTMLElement | null>
}

export function ConfirmDialog(props: ConfirmDialogProps): ReactElement {
  const { t } = useTranslation()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<unknown | null>(null)
  // RFC-222 (D5) — type-to-confirm input value (empty when the mode is off).
  const [typed, setTyped] = useState('')
  const inFlightRef = useRef(false)
  const operationRef = useRef(0)
  const mountedRef = useRef(true)
  const openRef = useRef(props.open)
  openRef.current = props.open

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      operationRef.current += 1
      inFlightRef.current = false
    }
  }, [])

  // Every open session starts clean. Incrementing the operation token also
  // prevents a late promise from an externally closed session from closing a
  // newly opened confirmation or surfacing its stale error.
  useEffect(() => {
    operationRef.current += 1
    inFlightRef.current = false
    setPending(false)
    setError(null)
    setTyped('') // RFC-222 — every open session starts with an empty input.
  }, [props.open])

  const requestClose = (): void => {
    if (inFlightRef.current) return
    props.onClose()
  }

  const trimmedTyped = typed.trim()
  const confirmMatched =
    props.confirmInput === undefined || trimmedTyped === props.confirmInput.expected

  const runConfirmation = async (): Promise<void> => {
    if (!props.open || inFlightRef.current) return
    // Guard the type-to-confirm gate here too (not just the disabled button), so
    // a keyboard-submit can never bypass it.
    if (!confirmMatched) return
    inFlightRef.current = true
    const operation = ++operationRef.current
    setError(null)
    setPending(true)

    try {
      // Hand the caller the user's ACTUAL keystrokes — never props.expected.
      await props.onConfirm(
        props.confirmInput !== undefined ? { typedConfirm: trimmedTyped } : undefined,
      )
      if (!mountedRef.current || !openRef.current || operationRef.current !== operation) return
      props.onClose()
    } catch (nextError) {
      if (!mountedRef.current || !openRef.current || operationRef.current !== operation) return
      inFlightRef.current = false
      setPending(false)
      setError(nextError)
    }
  }

  const panelClassName = pending ? 'confirm-dialog confirm-dialog--pending' : 'confirm-dialog'

  return (
    <Dialog
      open={props.open}
      onClose={requestClose}
      title={props.title}
      size="sm"
      triggerRef={props.triggerRef}
      restoreFocusFallbackRef={props.restoreFocusFallbackRef}
      dismissDisabled={pending}
      panelClassName={panelClassName}
      footer={
        <>
          <button type="button" className="btn" onClick={requestClose} disabled={pending}>
            {props.cancelLabel ?? t('common.cancel')}
          </button>
          <button
            type="button"
            className={props.tone === 'danger' ? 'btn btn--danger' : 'btn btn--primary'}
            onClick={() => void runConfirmation()}
            disabled={pending || !confirmMatched}
            aria-busy={pending || undefined}
          >
            {props.confirmLabel}
          </button>
        </>
      }
    >
      <div className="confirm-dialog__description">{props.description}</div>
      {props.confirmInput !== undefined && (
        <Field label={props.confirmInput.label}>
          <TextInput
            value={typed}
            onChange={setTyped}
            placeholder={props.confirmInput.placeholder}
            disabled={pending}
            autoFocus
            data-testid="confirm-input"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && confirmMatched) void runConfirmation()
            }}
          />
        </Field>
      )}
      {error !== null && <ErrorBanner error={error} />}
    </Dialog>
  )
}
