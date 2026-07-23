import type { PatPublic } from '@agent-workflow/shared'
import { useQueryClient } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '@/api/client'
import { Card } from '@/components/Card'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { EmptyState } from '@/components/EmptyState'
import { NoticeBanner } from '@/components/NoticeBanner'
import { RelativeTime } from '@/components/RelativeTime'
import { StatusChip } from '@/components/StatusChip'
import { ACTOR_QUERY_KEY, type MeResponse } from '@/hooks/useActor'

export function AccountTokensPanel({ me }: { me: MeResponse }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const focusFallbackRef = useRef<HTMLHeadingElement>(null)
  const [revokeId, setRevokeId] = useState<string | null>(null)
  const triggerRef = useRef<HTMLElement | null>(null)
  const tokens = [...me.pats].sort((a, b) => {
    const activeDelta = Number(a.revokedAt !== null) - Number(b.revokedAt !== null)
    return activeDelta === 0 ? b.createdAt - a.createdAt : activeDelta
  })
  return (
    <section className="account-section-panel" aria-labelledby="account-section-title-tokens">
      <header className="account-section-panel__header">
        <h2 id="account-section-title-tokens" ref={focusFallbackRef} tabIndex={-1}>
          {t('account.sections.tokens')}
        </h2>
        <p>{t('account.sectionDescriptions.tokens')}</p>
      </header>
      <NoticeBanner tone="info">
        <strong>{t('account.tokensRetiredTitle')}</strong>
        <p>{t('account.tokensRetiredDescription')}</p>
      </NoticeBanner>
      <Card className="account-tokens-card">
        {tokens.length === 0 ? (
          <EmptyState
            title={t('account.noPats')}
            description={t('account.noPatsDescription')}
            size="compact"
          />
        ) : (
          <ul className="account-token-list" aria-label={t('account.pats')}>
            {tokens.map((token) => (
              <TokenItem
                key={token.id}
                token={token}
                onRevoke={(button) => {
                  triggerRef.current = button
                  setRevokeId(token.id)
                }}
              />
            ))}
          </ul>
        )}
      </Card>
      <ConfirmDialog
        open={revokeId !== null}
        title={t('account.revokePatTitle')}
        description={t('account.revokePatDescription')}
        confirmLabel={t('account.revoke')}
        tone="danger"
        triggerRef={triggerRef}
        restoreFocusFallbackRef={focusFallbackRef}
        onClose={() => setRevokeId(null)}
        onConfirm={async () => {
          if (revokeId === null) return
          await api.delete(`/api/auth/pats/${revokeId}`)
          await qc.invalidateQueries({ queryKey: ACTOR_QUERY_KEY })
        }}
      />
    </section>
  )
}

function TokenItem({
  token,
  onRevoke,
}: {
  token: PatPublic
  onRevoke: (button: HTMLButtonElement) => void
}) {
  const { t } = useTranslation()
  const active = token.revokedAt === null
  return (
    <li className="account-token-list__item">
      <div className="account-token-list__heading">
        <div>
          <strong>{token.name}</strong>
          <span className="account-token-list__created">
            {t('account.created')} <RelativeTime ts={token.createdAt} />
          </span>
        </div>
        <StatusChip kind={active ? 'success' : 'danger'} withDot>
          {active ? t('account.patStatusActive') : t('account.patStatusRevoked')}
        </StatusChip>
      </div>
      <dl className="account-token-list__meta">
        <div>
          <dt>{t('account.lastUsed')}</dt>
          <dd>
            {token.lastUsedAt === null ? (
              t('account.neverUsed')
            ) : (
              <RelativeTime ts={token.lastUsedAt} />
            )}
          </dd>
        </div>
        <div>
          <dt>{t('account.expires')}</dt>
          <dd>
            {token.expiresAt === null ? (
              t('account.noExpiry')
            ) : (
              <RelativeTime ts={token.expiresAt} />
            )}
          </dd>
        </div>
        <div>
          <dt>{t('account.patScopes')}</dt>
          <dd>{t('account.scopeCount', { count: token.scopes.length })}</dd>
        </div>
      </dl>
      <div className="account-token-list__footer">
        <details className="account-technical-details">
          <summary>{t('account.viewScopes')}</summary>
          <div className="account-scope-chips">
            {token.scopes.map((scope) => (
              <code key={scope}>{scope}</code>
            ))}
          </div>
        </details>
        {active && (
          <button
            type="button"
            className="btn btn--danger btn--sm"
            onClick={(event) => onRevoke(event.currentTarget)}
          >
            {t('account.revoke')}
          </button>
        )}
      </div>
    </li>
  )
}
