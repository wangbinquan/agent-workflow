import type { UserPrivateProfile } from '@agent-workflow/shared'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import type { MeResponse } from '@/hooks/useActor'
import { meQueryOptions, useAuthSessionRevision } from '@/hooks/useActor'
import { api } from '@/api/client'
import { Card } from '@/components/Card'
import { ErrorBanner } from '@/components/ErrorBanner'
import { Field, TextInput } from '@/components/Form'
import { NoticeBanner } from '@/components/NoticeBanner'
import { RelativeTime } from '@/components/RelativeTime'
import { StatusChip } from '@/components/StatusChip'
import { getAuthSessionRevision, getToken } from '@/stores/auth'
import {
  USER_ROLE_PRESENTATION,
  USER_STATUS_PRESENTATION,
  accountInitials,
  isOidcManaged,
} from '@/lib/account-user-presentation'
import { useTranslation } from 'react-i18next'

export function AccountOverviewPanel({ me }: { me: MeResponse }) {
  const { t } = useTranslation()
  const managed = isOidcManaged(me.linkedIdentities)
  const role = USER_ROLE_PRESENTATION[me.user.role]
  const status = USER_STATUS_PRESENTATION[me.user.status]
  return (
    <section className="account-section-panel" aria-labelledby="account-section-title-overview">
      <header className="account-section-panel__header">
        <h2 id="account-section-title-overview">{t('account.sections.overview')}</h2>
        <p>{t('account.sectionDescriptions.overview')}</p>
      </header>

      <Card className="account-profile-summary">
        <div className="account-profile-summary__avatar" aria-hidden="true">
          {accountInitials(me.user.displayName, me.user.username)}
        </div>
        <div className="account-profile-summary__identity">
          <strong>{me.user.displayName}</strong>
          <span>@{me.user.username}</span>
        </div>
        <div className="account-profile-summary__chips">
          <StatusChip kind={role.kind}>{t(role.labelKey)}</StatusChip>
          <StatusChip kind={status.kind} withDot>
            {t(status.labelKey)}
          </StatusChip>
          <span className="account-meta-chip">
            {managed ? t('account.oidcManaged') : t('account.localAccount')}
          </span>
        </div>
        <dl className="account-profile-summary__meta">
          <div>
            <dt>{t('account.source')}</dt>
            <dd>{t(`account.sources.${me.source}`)}</dd>
          </div>
          <div>
            <dt>{t('account.role')}</dt>
            <dd>{t(role.labelKey)}</dd>
          </div>
          <div>
            <dt>{t('account.status')}</dt>
            <dd>{t(status.labelKey)}</dd>
          </div>
        </dl>
      </Card>

      <GitIdentityCard me={me} />

      <Card as="section" title={t('account.linkedIdentities')} className="account-identities-card">
        {me.linkedIdentities.length === 0 ? (
          <div className="account-inline-empty">
            <strong>{t('account.localIdentityTitle')}</strong>
            <p>{t('account.localIdentityDescription')}</p>
          </div>
        ) : (
          <ul className="account-identity-list" aria-label={t('account.linkedIdentities')}>
            {me.linkedIdentities.map((identity) => (
              <li key={identity.id} className="account-identity-list__item">
                <div className="account-identity-list__icon" aria-hidden="true">
                  {accountInitials(
                    identity.providerDisplayName ?? identity.providerSlug ?? identity.providerId,
                    identity.providerId,
                  ).slice(0, 1)}
                </div>
                <div className="account-identity-list__body">
                  <div className="account-identity-list__title">
                    <strong>
                      {identity.providerDisplayName ?? identity.providerSlug ?? identity.providerId}
                    </strong>
                    <span className="account-meta-chip">{t('account.oidcManaged')}</span>
                  </div>
                  <div className="account-identity-list__meta">
                    <span>{identity.email ?? t('common.emDash')}</span>
                    <span aria-hidden="true">·</span>
                    <span>
                      {t('account.linkedAt')} <RelativeTime ts={identity.linkedAt} />
                    </span>
                  </div>
                  <details className="account-technical-details">
                    <summary>{t('account.technicalIdentity')}</summary>
                    <code>{identity.subject}</code>
                  </details>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </section>
  )
}

function GitIdentityCard({ me }: { me: MeResponse }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const authSessionRevision = useAuthSessionRevision()
  const [displayName, setDisplayName] = useState(me.profile.displayName)
  const [email, setEmail] = useState(me.profile.email ?? '')
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    setDisplayName(me.profile.displayName)
    setEmail(me.profile.email ?? '')
  }, [me.profile.displayName, me.profile.email])

  const normalizedName = displayName.trim()
  const normalizedEmail = email.trim().toLowerCase()
  const changed =
    normalizedName !== me.profile.displayName || normalizedEmail !== (me.profile.email ?? '')
  const updateProfile = useMutation({
    mutationFn: async () => {
      const response = await api.patch<{ profile: UserPrivateProfile }>('/api/auth/me/profile', {
        displayName: normalizedName,
        email: normalizedEmail,
      })
      return { response, authSessionRevision }
    },
    onSuccess: ({ response: { profile }, authSessionRevision: requestRevision }) => {
      // A sign-out/sign-in or credential rotation while this PATCH was in
      // flight must not write the old response into the new auth generation.
      if (requestRevision !== getAuthSessionRevision()) return
      queryClient.setQueryData<MeResponse | null>(meQueryOptions(getToken()).queryKey, (current) =>
        current?.user.id === me.user.id
          ? {
              ...current,
              user: { ...current.user, displayName: profile.displayName },
              profile,
            }
          : current,
      )
      setDisplayName(profile.displayName)
      setEmail(profile.email ?? '')
      setSaved(true)
    },
  })

  return (
    <Card
      as="section"
      title={t('account.gitIdentityTitle')}
      header={<p className="account-card-description">{t('account.gitIdentityDescription')}</p>}
      className="account-security-card"
    >
      <form
        className="form-grid account-password-form"
        onSubmit={(event) => {
          event.preventDefault()
          setSaved(false)
          updateProfile.mutate()
        }}
      >
        <Field label={t('account.displayName')} hint={t('account.gitIdentityNameHint')} required>
          <TextInput
            value={displayName}
            onChange={setDisplayName}
            maxLength={128}
            autoComplete="name"
            required
          />
        </Field>
        <Field label={t('account.email')} hint={t('account.gitIdentityEmailHint')} required>
          <TextInput
            type="email"
            value={email}
            onChange={setEmail}
            maxLength={254}
            autoComplete="email"
            required
          />
        </Field>
        {updateProfile.error !== null && <ErrorBanner error={updateProfile.error} />}
        {saved && <NoticeBanner tone="success">{t('account.profileSaved')}</NoticeBanner>}
        {me.linkedIdentities.length > 0 && (
          <NoticeBanner tone="info">{t('account.oidcProfileRefreshHint')}</NoticeBanner>
        )}
        <div className="account-form-actions">
          <button
            type="submit"
            className="btn btn--primary"
            disabled={
              updateProfile.isPending ||
              !changed ||
              normalizedName.length === 0 ||
              normalizedEmail.length === 0
            }
            aria-busy={updateProfile.isPending || undefined}
          >
            {updateProfile.isPending ? t('common.saving') : t('account.saveProfile')}
          </button>
        </div>
      </form>
    </Card>
  )
}
