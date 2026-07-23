import { useRef, useState, type ReactElement, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import type { AdminUserView, ResetPasswordBody } from '@agent-workflow/shared'
import { Dialog } from '@/components/Dialog'
import { ErrorBanner } from '@/components/ErrorBanner'
import { Field, Switch, TextInput } from '@/components/Form'
import { NoticeBanner } from '@/components/NoticeBanner'

export function ResetUserPasswordDialog(props: {
  user: AdminUserView
  triggerRef: RefObject<HTMLElement | null>
  restoreFocusFallbackRef?: RefObject<HTMLElement | null>
  passwordLoginEnabled: boolean | undefined
  busy: boolean
  error: unknown | null
  onClose: () => void
  onSubmit: (body: ResetPasswordBody) => void
}): ReactElement {
  const { t } = useTranslation()
  const passwordRef = useRef<HTMLInputElement>(null)
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [force, setForce] = useState(true)
  const [mismatch, setMismatch] = useState(false)

  return (
    <Dialog
      open
      title={
        props.user.status === 'invited'
          ? t('users.reset.activateTitle', { name: props.user.displayName })
          : t('users.reset.title', { name: props.user.displayName })
      }
      size="sm"
      onClose={props.onClose}
      initialFocusRef={passwordRef}
      triggerRef={props.triggerRef}
      restoreFocusFallbackRef={props.restoreFocusFallbackRef}
      dismissDisabled={props.busy}
      footer={
        <>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={props.onClose}
            disabled={props.busy}
          >
            {t('common.cancel')}
          </button>
          <button
            type="submit"
            form="users-reset-password-form"
            className="btn btn--primary"
            disabled={props.busy}
          >
            {props.busy ? t('users.saving') : t('users.reset.submit')}
          </button>
        </>
      }
    >
      <form
        id="users-reset-password-form"
        className="form-grid users-dialog-form"
        onSubmit={(event) => {
          event.preventDefault()
          if (newPassword !== confirmPassword) {
            setMismatch(true)
            return
          }
          setMismatch(false)
          props.onSubmit({ newPassword, force })
        }}
      >
        <NoticeBanner tone="warning" size="compact">
          {t('users.reset.sessionsWarning')}
        </NoticeBanner>
        {props.passwordLoginEnabled === false && (
          <NoticeBanner tone="info" size="compact">
            {t('users.passwordLoginDisabledNotice')}
          </NoticeBanner>
        )}
        <Field label={t('users.reset.newPassword')} required>
          <TextInput
            inputRef={passwordRef}
            type="password"
            value={newPassword}
            onChange={setNewPassword}
            minLength={8}
            maxLength={256}
            autoComplete="new-password"
            required
          />
        </Field>
        <Field label={t('users.reset.confirmPassword')} required>
          <TextInput
            type="password"
            value={confirmPassword}
            onChange={(value) => {
              setConfirmPassword(value)
              if (mismatch) setMismatch(false)
            }}
            minLength={8}
            maxLength={256}
            autoComplete="new-password"
            aria-invalid={mismatch || undefined}
            required
          />
        </Field>
        {mismatch && (
          <div className="users-dialog-form__error" role="alert">
            {t('users.reset.passwordMismatch')}
          </div>
        )}
        <Switch
          checked={force}
          onChange={setForce}
          label={t('users.reset.forceChange')}
          hint={t('users.reset.forceChangeHint')}
        />
        {props.error !== null && <ErrorBanner error={props.error} />}
      </form>
    </Dialog>
  )
}
