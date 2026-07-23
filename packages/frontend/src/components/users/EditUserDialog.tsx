import { useMemo, useRef, useState, type ReactElement, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import type { AdminUserView, PatchUserBody, Role } from '@agent-workflow/shared'
import { ChoiceCards } from '@/components/ChoiceCards'
import { Dialog } from '@/components/Dialog'
import { ErrorBanner } from '@/components/ErrorBanner'
import { Field, TextInput } from '@/components/Form'
import { NoticeBanner } from '@/components/NoticeBanner'
import { StatusChip } from '@/components/StatusChip'
import { USER_STATUS_PRESENTATION } from '@/lib/account-user-presentation'
import { diffUserPatch, editDraftForUser, type EditUserDraft } from '@/lib/user-directory'

export function EditUserDialog(props: {
  user: AdminUserView
  isSelf: boolean
  triggerRef: RefObject<HTMLElement | null>
  restoreFocusFallbackRef?: RefObject<HTMLElement | null>
  busy: boolean
  error: unknown | null
  onClose: () => void
  onSubmit: (patch: PatchUserBody) => void
  onResetPassword: () => void
  onDisable: () => void
  onEnable: () => void
}): ReactElement {
  const { t } = useTranslation()
  const displayNameRef = useRef<HTMLInputElement>(null)
  const [draft, setDraft] = useState<EditUserDraft>(() => editDraftForUser(props.user))
  const patch = useMemo(() => diffUserPatch(props.user, draft), [draft, props.user])
  const dirty = Object.keys(patch).length > 0
  const update = <K extends keyof EditUserDraft>(key: K, value: EditUserDraft[K]) =>
    setDraft((previous) => ({ ...previous, [key]: value }))
  const status = USER_STATUS_PRESENTATION[props.user.status]

  return (
    <Dialog
      open
      title={t('users.edit.title', { name: props.user.displayName })}
      size="md"
      onClose={props.onClose}
      initialFocusRef={displayNameRef}
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
            form="users-edit-form"
            className="btn btn--primary"
            disabled={!dirty || props.busy}
          >
            {props.busy ? t('users.saving') : t('common.save')}
          </button>
        </>
      }
    >
      <form
        id="users-edit-form"
        className="form-grid users-dialog-form"
        onSubmit={(event) => {
          event.preventDefault()
          if (dirty) props.onSubmit(patch)
        }}
      >
        <div className="users-edit-identity">
          <div>
            <strong>@{props.user.username}</strong>
            <span>{props.user.email ?? t('users.noEmail')}</span>
          </div>
          <StatusChip kind={status.kind} size="sm" withDot>
            {t(status.labelKey)}
          </StatusChip>
        </div>

        <div className="form-grid form-grid--cols-2">
          <Field label={t('users.displayName')} required>
            <TextInput
              inputRef={displayNameRef}
              value={draft.displayName}
              onChange={(value) => update('displayName', value)}
              maxLength={128}
              required
            />
          </Field>
          <Field label={t('users.email')}>
            <TextInput
              type="email"
              value={draft.email}
              onChange={(value) => update('email', value)}
              maxLength={254}
              autoComplete="email"
            />
          </Field>
        </div>

        <Field label={t('users.role')} group>
          <ChoiceCards<Role>
            value={draft.role}
            onChange={(role) => update('role', role)}
            ariaLabel={t('users.role')}
            testidPrefix="users-edit-role"
            disabled={props.isSelf}
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
        {props.isSelf && <p className="users-dialog-form__hint">{t('users.selfRoleLocked')}</p>}

        <section className="users-dialog-section" aria-labelledby="users-credentials-heading">
          <div className="users-dialog-section__header">
            <div>
              <h3 id="users-credentials-heading">{t('users.credentialsTitle')}</h3>
              <p>
                {props.user.hasOidcIdentity
                  ? t('users.credentialsOidcDescription')
                  : t('users.credentialsLocalDescription')}
              </p>
            </div>
            {!props.user.hasOidcIdentity && (
              <button type="button" className="btn btn--ghost" onClick={props.onResetPassword}>
                {props.user.status === 'invited'
                  ? t('users.setPasswordAndActivate')
                  : t('users.resetPassword')}
              </button>
            )}
          </div>
          {props.user.hasOidcIdentity && (
            <NoticeBanner tone="info" size="compact">
              {t('users.oidcResetUnavailable')}
            </NoticeBanner>
          )}
        </section>

        <section className="users-dialog-section" aria-labelledby="users-access-heading">
          <div className="users-dialog-section__header">
            <div>
              <h3 id="users-access-heading">{t('users.accessTitle')}</h3>
              <p>
                {props.user.status === 'disabled'
                  ? t('users.enableDescription')
                  : props.isSelf
                    ? t('users.selfDisableLocked')
                    : t('users.disableDescription')}
              </p>
            </div>
            {props.user.status === 'disabled' ? (
              <button type="button" className="btn btn--ghost" onClick={props.onEnable}>
                {t('users.enable')}
              </button>
            ) : (
              !props.isSelf && (
                <button
                  type="button"
                  className="btn btn--ghost btn--danger"
                  onClick={props.onDisable}
                >
                  {t('users.disable')}
                </button>
              )
            )}
          </div>
        </section>

        {props.error !== null && <ErrorBanner error={props.error} />}
      </form>
    </Dialog>
  )
}
