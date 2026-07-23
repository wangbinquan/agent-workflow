import { useRef, useState, type ReactElement, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import type { CreateUserBody, Role } from '@agent-workflow/shared'
import { ChoiceCards } from '@/components/ChoiceCards'
import { Dialog } from '@/components/Dialog'
import { ErrorBanner } from '@/components/ErrorBanner'
import { Field, TextInput } from '@/components/Form'
import { NoticeBanner } from '@/components/NoticeBanner'
import {
  serializeCreateUser,
  type CreateUserDraft,
  type CreateUserMode,
} from '@/lib/user-directory'

export function CreateUserDialog(props: {
  triggerRef?: RefObject<HTMLElement | null>
  restoreFocusFallbackRef?: RefObject<HTMLElement | null>
  passwordLoginEnabled: boolean | undefined
  busy: boolean
  error: unknown | null
  onClose: () => void
  onSubmit: (body: CreateUserBody, mode: CreateUserMode) => void
}): ReactElement {
  const { t } = useTranslation()
  const usernameRef = useRef<HTMLInputElement>(null)
  const [draft, setDraft] = useState<CreateUserDraft>({
    username: '',
    displayName: '',
    email: '',
    role: 'user',
    mode: 'password',
    password: '',
  })
  const update = <K extends keyof CreateUserDraft>(key: K, value: CreateUserDraft[K]) =>
    setDraft((previous) => ({ ...previous, [key]: value }))
  const setMode = (mode: CreateUserMode) => {
    setDraft((previous) => ({ ...previous, mode, ...(mode === 'sso' ? { password: '' } : {}) }))
  }

  return (
    <Dialog
      open
      title={t('users.create.title')}
      size="md"
      onClose={props.onClose}
      initialFocusRef={usernameRef}
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
            form="users-create-form"
            className="btn btn--primary"
            disabled={props.busy}
          >
            {props.busy ? t('users.saving') : t('users.create.submit')}
          </button>
        </>
      }
    >
      <form
        id="users-create-form"
        className="form-grid users-dialog-form"
        onSubmit={(event) => {
          event.preventDefault()
          props.onSubmit(serializeCreateUser(draft), draft.mode)
        }}
      >
        <Field label={t('users.create.accountType')} group>
          <ChoiceCards<CreateUserMode>
            value={draft.mode}
            onChange={setMode}
            ariaLabel={t('users.create.accountType')}
            testidPrefix="users-create-mode"
            options={[
              {
                value: 'password',
                label: t('users.create.passwordMode'),
                description: t('users.create.passwordModeDescription'),
              },
              {
                value: 'sso',
                label: t('users.create.ssoMode'),
                description: t('users.create.ssoModeDescription'),
              },
            ]}
          />
        </Field>

        {draft.mode === 'password' && props.passwordLoginEnabled === false && (
          <NoticeBanner tone="warning" size="compact">
            {t('users.passwordLoginDisabledNotice')}
          </NoticeBanner>
        )}

        <div className="form-grid form-grid--cols-2">
          <Field label={t('users.username')} required>
            <TextInput
              inputRef={usernameRef}
              value={draft.username}
              onChange={(value) => update('username', value)}
              pattern="[a-z0-9][a-z0-9_-]{0,63}"
              maxLength={64}
              autoComplete="off"
              required
            />
          </Field>
          <Field label={t('users.displayName')} required>
            <TextInput
              value={draft.displayName}
              onChange={(value) => update('displayName', value)}
              maxLength={128}
              required
            />
          </Field>
        </div>

        <Field
          label={t('users.email')}
          required={draft.mode === 'sso'}
          hint={
            draft.mode === 'sso' ? t('users.create.ssoEmailHint') : t('users.create.localEmailHint')
          }
        >
          <TextInput
            type="email"
            value={draft.email}
            onChange={(value) => update('email', value)}
            maxLength={254}
            autoComplete="email"
            required={draft.mode === 'sso'}
          />
        </Field>

        {draft.mode === 'password' && (
          <Field label={t('users.password')} required hint={t('users.create.passwordHint')}>
            <TextInput
              type="password"
              value={draft.password}
              onChange={(value) => update('password', value)}
              minLength={8}
              maxLength={256}
              autoComplete="new-password"
              required
            />
          </Field>
        )}

        <Field label={t('users.role')} group>
          <ChoiceCards<Role>
            value={draft.role}
            onChange={(role) => update('role', role)}
            ariaLabel={t('users.role')}
            testidPrefix="users-create-role"
            options={[
              {
                value: 'user',
                label: t('users.roleOption.user'),
                description: t('users.roleOption.userDesc'),
              },
              {
                value: 'manager',
                label: t('users.roleOption.manager'),
                description: t('users.roleOption.managerDesc'),
              },
              {
                value: 'admin',
                label: t('users.roleOption.admin'),
                description: t('users.roleOption.adminDesc'),
              },
            ]}
          />
        </Field>

        {draft.mode === 'sso' && (
          <NoticeBanner tone="info" size="compact">
            {t('users.create.ssoNoEmailNotice')}
          </NoticeBanner>
        )}
        {props.error !== null && <ErrorBanner error={props.error} />}
      </form>
    </Dialog>
  )
}
