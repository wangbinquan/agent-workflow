// RFC-320 — account-owned Git commit identity. Kept as a separate card so
// RFC-321 can place commit authorship and push authentication in one section
// without coupling their backend contracts.

import type { UserPrivateProfile } from '@agent-workflow/shared'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '@/api/client'
import { ErrorBanner } from '@/components/ErrorBanner'
import { Field, TextInput } from '@/components/Form'
import { NoticeBanner } from '@/components/NoticeBanner'
import { SettingsCard } from '@/components/settings/SettingsCard'
import { meQueryOptions, type MeResponse, useAuthSessionRevision } from '@/hooks/useActor'
import { getAuthSessionRevision, getToken } from '@/stores/auth'

export function AccountGitIdentityCard({ me }: { me: MeResponse }) {
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
    <SettingsCard
      title={t('account.gitIdentityTitle')}
      hint={t('account.gitIdentityDescription')}
      data-testid="account-git-identity-card"
    >
      <form
        className="form-grid account-code-push-form"
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
        {saved && (
          <NoticeBanner tone="success" size="compact">
            {t('account.profileSaved')}
          </NoticeBanner>
        )}
        {me.linkedIdentities.length > 0 && (
          <NoticeBanner tone="info" size="compact">
            {t('account.oidcProfileRefreshHint')}
          </NoticeBanner>
        )}
        <div className="page__actions">
          <button
            type="submit"
            className="btn btn--sm btn--primary"
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
    </SettingsCard>
  )
}
