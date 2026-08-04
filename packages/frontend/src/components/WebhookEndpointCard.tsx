// RFC-257 T10 / UX closure — webhook ingress endpoints.
//
// Endpoints are the first business step in the webhook journey. The surface
// uses the shared Card / QueryState / Dialog / ConfirmDialog / NoticeBanner
// primitives, keeps one-time secrets visible only in the explicit reveal
// dialog, and requires a consequence-aware confirmation before rotation.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { WebhookEndpoint } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { Card } from '@/components/Card'
import { ConfirmButton } from '@/components/ConfirmButton'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { Dialog } from '@/components/Dialog'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { FeedbackStack } from '@/components/FeedbackStack'
import { Field, Switch, TextInput } from '@/components/Form'
import { NoticeBanner } from '@/components/NoticeBanner'
import { QueryState } from '@/components/QueryState'
import { RelativeTime } from '@/components/RelativeTime'
import { Segmented } from '@/components/Segmented'
import { StatusChip } from '@/components/StatusChip'
import { copyText } from '@/lib/clipboard'

type EndpointWire = WebhookEndpoint & { ingressUrl: string | null }
type EndpointWithSecret = EndpointWire & { secret: string }
type CopyState = 'idle' | 'ok' | 'failed'

const QUERY_KEY = ['webhook-endpoints']

export function WebhookEndpointCard(): React.ReactElement {
  const { t } = useTranslation()
  const client = useQueryClient()
  const [error, setError] = useState<unknown>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [name, setName] = useState('')
  const [protocol, setProtocol] = useState<'http' | 'ssh'>('http')
  const [rotateTarget, setRotateTarget] = useState<EndpointWire | null>(null)
  const [urlCopyState, setUrlCopyState] = useState<CopyState>('idle')
  const [secretCopyState, setSecretCopyState] = useState<CopyState>('idle')
  /** One-time secret reveal (the only frontend state allowed to hold plaintext). */
  const [minted, setMinted] = useState<EndpointWithSecret | null>(null)

  const query = useQuery({
    queryKey: QUERY_KEY,
    queryFn: ({ signal }) => api.get<EndpointWire[]>('/api/webhook-endpoints', undefined, signal),
  })
  const invalidate = () => void client.invalidateQueries({ queryKey: QUERY_KEY })

  const create = useMutation({
    mutationFn: () =>
      api.post<EndpointWithSecret>('/api/webhook-endpoints', {
        name,
        preferredCloneProtocol: protocol,
      }),
    onSuccess: (created) => {
      setError(null)
      setCreateOpen(false)
      setName('')
      setSecretCopyState('idle')
      setMinted(created)
      invalidate()
    },
    onError: setError,
  })
  const rotateSecret = useMutation({
    mutationFn: (id: string) =>
      api.post<EndpointWithSecret>(
        `/api/webhook-endpoints/${encodeURIComponent(id)}/rotate-secret`,
      ),
    onSuccess: (rotated) => {
      setError(null)
      setSecretCopyState('idle')
      setMinted(rotated)
      invalidate()
    },
  })
  const toggle = useMutation({
    mutationFn: (input: { id: string; enabled: boolean }) =>
      api.put<EndpointWire>(`/api/webhook-endpoints/${encodeURIComponent(input.id)}`, {
        enabled: input.enabled,
      }),
    onSuccess: () => {
      setError(null)
      invalidate()
    },
    onError: setError,
  })
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/api/webhook-endpoints/${encodeURIComponent(id)}`),
    onSuccess: () => {
      setError(null)
      invalidate()
    },
    onError: setError,
  })

  const openCreate = () => {
    setError(null)
    setCreateOpen(true)
  }
  const createAction = (
    <button
      type="button"
      className="btn btn--sm btn--primary"
      onClick={openCreate}
      data-testid="webhook-endpoint-add"
    >
      {t('settings.webhookEndpoints.add')}
    </button>
  )
  const copyUrl = async (value: string): Promise<void> => {
    setUrlCopyState((await copyText(value)) ? 'ok' : 'failed')
  }
  const copySecret = async (value: string): Promise<void> => {
    setSecretCopyState((await copyText(value)) ? 'ok' : 'failed')
  }

  return (
    <section className="webhook-panel" data-testid="webhook-endpoints">
      <div className="webhook-panel__intro">
        <div>
          <span className="webhook-panel__eyebrow">
            {t('settings.webhookEndpoints.eyebrow')}
          </span>
          <h2>{t('settings.webhookEndpoints.title')}</h2>
          <p>{t('settings.webhookEndpoints.hint')}</p>
        </div>
        {createAction}
      </div>

      <FeedbackStack variant="section">
        {error !== null && <ErrorBanner error={error} />}
        {urlCopyState === 'ok' && (
          <NoticeBanner
            tone="success"
            size="compact"
            dismiss={{
              label: t('common.close'),
              onDismiss: () => setUrlCopyState('idle'),
            }}
          >
            {t('settings.webhookEndpoints.urlCopied')}
          </NoticeBanner>
        )}
        {urlCopyState === 'failed' && (
          <NoticeBanner
            tone="error"
            size="compact"
            dismiss={{
              label: t('common.close'),
              onDismiss: () => setUrlCopyState('idle'),
            }}
          >
            {t('settings.webhookEndpoints.copyFailed')}
          </NoticeBanner>
        )}
      </FeedbackStack>

      <QueryState
        query={query}
        data={query.data ?? []}
        empty={
          <EmptyState
            title={t('settings.webhookEndpoints.empty')}
            description={t('settings.webhookEndpoints.emptyDescription')}
            action={createAction}
          />
        }
      >
        {(rows) => (
          <div className="webhook-card-grid" data-testid="webhook-endpoint-list">
            {rows.map((row) => (
              <Card
                key={row.id}
                className="webhook-endpoint-card"
                title={row.name}
                actions={
                  <StatusChip kind={row.enabled ? 'success' : 'neutral'} size="sm">
                    {t(
                      row.enabled
                        ? 'settings.webhookEndpoints.enabled'
                        : 'settings.webhookEndpoints.disabled',
                    )}
                  </StatusChip>
                }
                footer={
                  <div className="webhook-card__footer">
                    <Switch
                      checked={row.enabled}
                      onChange={(enabled) => toggle.mutate({ id: row.id, enabled })}
                      disabled={toggle.isPending}
                      label={t('settings.webhookEndpoints.enabledSwitch')}
                    />
                    <div className="page__actions">
                      <button
                        type="button"
                        className="btn btn--sm"
                        onClick={() => setRotateTarget(row)}
                        disabled={rotateSecret.isPending}
                        data-testid={`webhook-endpoint-rotate-${row.id}`}
                      >
                        {t('settings.webhookEndpoints.rotateSecret')}
                      </button>
                      <ConfirmButton
                        label={t('common.delete')}
                        confirmLabel={t('settings.webhookEndpoints.deleteConfirm')}
                        variant="danger"
                        size="sm"
                        confirmationKey={row.id}
                        onConfirm={() => remove.mutateAsync(row.id)}
                      />
                    </div>
                  </div>
                }
                data-testid={`webhook-endpoint-${row.id}`}
              >
                <dl className="webhook-facts">
                  <div>
                    <dt>{t('settings.webhookEndpoints.providerLabel')}</dt>
                    <dd>GitLab</dd>
                  </div>
                  <div>
                    <dt>{t('settings.webhookEndpoints.protocolLabel')}</dt>
                    <dd>{row.preferredCloneProtocol.toUpperCase()}</dd>
                  </div>
                  <div>
                    <dt>{t('settings.webhookEndpoints.secretLabel')}</dt>
                    <dd>
                      <code>•••• {row.secretHint ?? '????'}</code>
                    </dd>
                  </div>
                  <div>
                    <dt>{t('settings.webhookEndpoints.lastDeliveryLabel')}</dt>
                    <dd>
                      {row.lastDeliveryAt === null ? (
                        t('settings.webhookEndpoints.neverDelivered')
                      ) : (
                        <RelativeTime ts={row.lastDeliveryAt} />
                      )}
                    </dd>
                  </div>
                </dl>

                {row.ingressUrl !== null ? (
                  <div className="webhook-endpoint__url">
                    <div>
                      <span>{t('settings.webhookEndpoints.urlLabel')}</span>
                      <code data-testid={`webhook-endpoint-url-${row.id}`}>
                        {row.ingressUrl}
                      </code>
                    </div>
                    <button
                      type="button"
                      className="btn btn--sm"
                      onClick={() => void copyUrl(row.ingressUrl ?? '')}
                    >
                      {t('settings.webhookEndpoints.copyUrl')}
                    </button>
                  </div>
                ) : (
                  <NoticeBanner tone="warning" size="compact">
                    <strong>{t('settings.webhookEndpoints.noPublicBaseUrlTitle')}</strong>
                    <p>
                      {t('settings.webhookEndpoints.noPublicBaseUrl', {
                        path: `/webhooks/${row.provider}/${row.urlToken}`,
                      })}
                    </p>
                  </NoticeBanner>
                )}
              </Card>
            ))}
          </div>
        )}
      </QueryState>

      <Dialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title={t('settings.webhookEndpoints.addTitle')}
        size="md"
        dismissDisabled={create.isPending}
        data-testid="webhook-endpoint-create-dialog"
        footer={
          <>
            <button
              type="button"
              className="btn"
              disabled={create.isPending}
              onClick={() => setCreateOpen(false)}
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="btn btn--primary"
              disabled={name.trim() === '' || create.isPending}
              onClick={() => create.mutate()}
              data-testid="webhook-endpoint-create-submit"
            >
              {t('settings.webhookEndpoints.createSubmit')}
            </button>
          </>
        }
      >
        <div className="form-grid">
          <p className="muted">{t('settings.webhookEndpoints.createDescription')}</p>
          <Field label={t('settings.webhookEndpoints.nameLabel')} required>
            <TextInput
              value={name}
              onChange={setName}
              data-testid="webhook-endpoint-name"
              placeholder={t('settings.webhookEndpoints.namePlaceholder')}
            />
          </Field>
          <Field
            label={t('settings.webhookEndpoints.protocolLabel')}
            hint={t('settings.webhookEndpoints.protocolHint')}
            group
          >
            <Segmented<'http' | 'ssh'>
              value={protocol}
              onChange={setProtocol}
              ariaLabel={t('settings.webhookEndpoints.protocolLabel')}
              options={[
                { value: 'http', label: 'HTTP' },
                { value: 'ssh', label: 'SSH' },
              ]}
            />
          </Field>
        </div>
      </Dialog>

      <ConfirmDialog
        open={rotateTarget !== null}
        title={t('settings.webhookEndpoints.rotateConfirmTitle')}
        description={t('settings.webhookEndpoints.rotateConfirmDescription', {
          name: rotateTarget?.name ?? '',
        })}
        confirmLabel={t('settings.webhookEndpoints.rotateConfirmAction')}
        tone="danger"
        onClose={() => setRotateTarget(null)}
        onConfirm={async () => {
          if (rotateTarget === null) return
          await rotateSecret.mutateAsync(rotateTarget.id)
        }}
      />

      <Dialog
        open={minted !== null}
        onClose={() => {}}
        title={t('settings.webhookEndpoints.secretTitle')}
        size="md"
        dismissDisabled
        data-testid="webhook-endpoint-secret-dialog"
        footer={
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => setMinted(null)}
          >
            {t('settings.webhookEndpoints.secretDone')}
          </button>
        }
      >
        {minted !== null && (
          <div className="form-grid">
            <NoticeBanner tone="warning">
              <strong>{t('settings.webhookEndpoints.secretOnceTitle')}</strong>
              <p>{t('settings.webhookEndpoints.secretOnce')}</p>
            </NoticeBanner>
            <Field label={t('settings.webhookEndpoints.secretLabel')}>
              <code className="token-reveal" data-testid="webhook-endpoint-secret-value">
                {minted.secret}
              </code>
              <div className="token-reveal__actions">
                <button
                  type="button"
                  className="btn btn--sm"
                  onClick={() => void copySecret(minted.secret)}
                >
                  {t('settings.webhookEndpoints.copySecret')}
                </button>
                {secretCopyState === 'ok' && (
                  <span className="token-reveal__status" role="status">
                    {t('settings.webhookEndpoints.secretCopied')}
                  </span>
                )}
                {secretCopyState === 'failed' && (
                  <span
                    className="token-reveal__status token-reveal__status--error"
                    role="status"
                  >
                    {t('settings.webhookEndpoints.copyFailed')}
                  </span>
                )}
              </div>
            </Field>
            {minted.ingressUrl !== null && (
              <Field label={t('settings.webhookEndpoints.urlLabel')}>
                <code className="webhook-secret-dialog__url">{minted.ingressUrl}</code>
              </Field>
            )}
            <p className="muted">{t('settings.webhookEndpoints.secretPasteHint')}</p>
          </div>
        )}
      </Dialog>
    </section>
  )
}
