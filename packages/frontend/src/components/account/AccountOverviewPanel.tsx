import type { MeResponse } from '@/hooks/useActor'
import { Card } from '@/components/Card'
import { RelativeTime } from '@/components/RelativeTime'
import { StatusChip } from '@/components/StatusChip'
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
