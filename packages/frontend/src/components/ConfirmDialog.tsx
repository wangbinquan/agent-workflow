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

export interface ConfirmDialogProps {
  open: boolean
  title: string
  description: ReactNode
  confirmLabel: string
  cancelLabel?: string
  tone?: 'default' | 'danger'
  onConfirm: () => void | Promise<void>
  onClose: () => void
  triggerRef?: RefObject<HTMLElement | null>
  restoreFocusFallbackRef?: RefObject<HTMLElement | null>
}

export function ConfirmDialog(props: ConfirmDialogProps): ReactElement {
  const { t } = useTranslation()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<unknown | null>(null)
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
  }, [props.open])

  const requestClose = (): void => {
    if (inFlightRef.current) return
    props.onClose()
  }

  const confirm = async (): Promise<void> => {
    if (!props.open || inFlightRef.current) return
    inFlightRef.current = true
    const operation = ++operationRef.current
    setError(null)
    setPending(true)

    try {
      await props.onConfirm()
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
            onClick={() => void confirm()}
            disabled={pending}
            aria-busy={pending || undefined}
          >
            {props.confirmLabel}
          </button>
        </>
      }
    >
      <div className="confirm-dialog__description">{props.description}</div>
      {error !== null && <ErrorBanner error={error} />}
    </Dialog>
  )
}
