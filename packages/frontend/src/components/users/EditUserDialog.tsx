import { useMemo, useRef, useState, type ReactElement, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import type { AdminUserView, PatchUserBody, Role } from '@agent-workflow/shared'
import { ChoiceCards } from '@/components/ChoiceCards'
import { Dialog } from '@/components/Dialog'
import { ErrorBanner } from '@/components/ErrorBanner'
import { Field, TextInput } from '@/components/Form'
import { NoticeBanner } from '@/components/NoticeBanner'
import { StatusChip } from '@/components/StatusChip'
import { UserPermissionCatalog } from '@/components/users/UserPermissionCatalog'
import { ApiError } from '@/api/client'
import { USER_STATUS_PRESENTATION } from '@/lib/account-user-presentation'
import { diffUserPatch, editDraftForUser, type EditUserDraft } from '@/lib/user-directory'
import { rebaseUserAdditionalPermissions, summarizeAccessChange } from '@/lib/user-permissions'

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
  onReloadLatest: () => void
}): ReactElement {
  const { t } = useTranslation()
  const displayNameRef = useRef<HTMLInputElement>(null)
  const [draft, setDraft] = useState<EditUserDraft>(() => editDraftForUser(props.user))
  const patch = useMemo(() => diffUserPatch(props.user, draft), [draft, props.user])
  const accessSummary = useMemo(
    () =>
      summarizeAccessChange(
        {
          role: props.user.role,
          additionalPermissions: props.user.additionalPermissions,
        },
        draft,
      ),
    [draft, props.user.additionalPermissions, props.user.role],
  )
  const dirty = Object.keys(patch).length > 0
  const update = <K extends keyof EditUserDraft>(key: K, value: EditUserDraft[K]) =>
    setDraft((previous) => ({ ...previous, [key]: value }))
  const status = USER_STATUS_PRESENTATION[props.user.status]
  const stale = props.error instanceof ApiError && props.error.code === 'user-access-stale'

  return (
    <Dialog
      open
      title={t('users.edit.title', { name: props.user.displayName })}
      size="lg"
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
              disabled={props.busy}
            />
          </Field>
          <Field label={t('users.email')}>
            <TextInput
              type="email"
              value={draft.email}
              onChange={(value) => update('email', value)}
              maxLength={254}
              autoComplete="email"
              disabled={props.busy}
            />
          </Field>
        </div>

        <Field label={t('users.role')} hint={t('users.roleHint')} group>
          <ChoiceCards<Role>
            value={draft.role}
            onChange={(role) =>
              setDraft((previous) => ({
                ...previous,
                role,
                additionalPermissions: [
                  ...rebaseUserAdditionalPermissions({
                    previousRole: previous.role,
                    nextRole: role,
                    additionalPermissions: previous.additionalPermissions,
                  }),
                ],
              }))
            }
            ariaLabel={t('users.role')}
            testidPrefix="users-edit-role"
            disabled={props.isSelf || props.busy}
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

        <UserPermissionCatalog
          role={draft.role}
          additionalPermissions={draft.additionalPermissions}
          disabled={props.busy || props.isSelf}
          onChange={(additionalPermissions) =>
            update('additionalPermissions', [...additionalPermissions])
          }
        />

        {patch.access !== undefined && (
          <NoticeBanner
            tone={accessSummary.addedCritical.length > 0 ? 'warning' : 'info'}
            size="compact"
          >
            {t('permissions.changeSummary', {
              added: accessSummary.added.length,
              removed: accessSummary.removed.length,
            })}
            {accessSummary.addedCritical.length > 0 && <> {t('permissions.criticalWarning')}</>}
          </NoticeBanner>
        )}

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
              <button
                type="button"
                className="btn btn--ghost"
                onClick={props.onResetPassword}
                disabled={props.busy}
              >
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
              <button
                type="button"
                className="btn btn--ghost"
                onClick={props.onEnable}
                disabled={props.busy}
              >
                {t('users.enable')}
              </button>
            ) : (
              !props.isSelf && (
                <button
                  type="button"
                  className="btn btn--ghost btn--danger"
                  onClick={props.onDisable}
                  disabled={props.busy}
                >
                  {t('users.disable')}
                </button>
              )
            )}
          </div>
        </section>

        {stale ? (
          <NoticeBanner
            tone="warning"
            size="compact"
            title={t('permissions.staleTitle')}
            action={
              <button type="button" className="btn btn--sm" onClick={props.onReloadLatest}>
                {t('permissions.reloadLatest')}
              </button>
            }
          >
            {t('permissions.staleBody')}
          </NoticeBanner>
        ) : (
          props.error !== null && <ErrorBanner error={props.error} />
        )}
      </form>
    </Dialog>
  )
}
