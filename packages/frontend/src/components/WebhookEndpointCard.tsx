// RFC-257 T10 — 设置页「Webhook 端点」卡片（CustomProviderCard 同款骨架：
// page__section + page__header--row + QueryState + Dialog，零自有 chrome）。
// secret 语义（RFC-255 姿势）：创建/轮换响应携带一次性明文，当场展示要求
// 复制；之后所有读取面只有掩码 hint。ingressUrl 由后端用 publicBaseUrl 拼装
//（缺配置时展示相对路径提示，前端绝不用 window.origin 拼——audit-backlog:81）。
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { WebhookEndpoint } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { copyText } from '@/lib/clipboard'
import { ConfirmButton } from '@/components/ConfirmButton'
import { Dialog } from '@/components/Dialog'
import { ErrorBanner } from '@/components/ErrorBanner'
import { Field, Switch, TextInput } from '@/components/Form'
import { QueryState } from '@/components/QueryState'
import { Segmented } from '@/components/Segmented'
import { StatusChip } from '@/components/StatusChip'

type EndpointWire = WebhookEndpoint & { ingressUrl: string | null }
type EndpointWithSecret = EndpointWire & { secret: string }

const QUERY_KEY = ['webhook-endpoints']

export function WebhookEndpointCard(): React.ReactElement {
  const { t } = useTranslation()
  const client = useQueryClient()
  const [error, setError] = useState<unknown>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [name, setName] = useState('')
  const [protocol, setProtocol] = useState<'http' | 'ssh'>('http')
  /** 一次性 secret 展示（创建/轮换后唯一一次可见）。 */
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
      setMinted(rotated)
      invalidate()
    },
    onError: setError,
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

  return (
    <section className="page__section" data-testid="webhook-endpoints">
      <div className="page__header--row">
        <h3>{t('settings.webhookEndpoints.title')}</h3>
        <div className="page__actions">
          <Link to="/webhook-triggers" className="btn btn--sm">
            {t('settings.webhookEndpoints.triggersLink')}
          </Link>
          <Link to="/webhook-deliveries" className="btn btn--sm">
            {t('settings.webhookEndpoints.deliveriesLink')}
          </Link>
          <button
            type="button"
            className="btn btn--sm btn--primary"
            onClick={() => {
              setError(null)
              setCreateOpen(true)
            }}
            data-testid="webhook-endpoint-add"
          >
            {t('settings.webhookEndpoints.add')}
          </button>
        </div>
      </div>
      <p className="muted">{t('settings.webhookEndpoints.hint')}</p>
      {error !== null && <ErrorBanner error={error} />}
      <QueryState
        query={query}
        data={query.data ?? []}
        emptyText={t('settings.webhookEndpoints.empty')}
      >
        {(rows) => (
          <ul className="stack-top--md" data-testid="webhook-endpoint-list">
            {rows.map((row) => (
              <li key={row.id} className="page__section" data-testid={`webhook-endpoint-${row.id}`}>
                <div className="page__header--row">
                  <div>
                    <strong>{row.name}</strong>{' '}
                    <StatusChip kind={row.enabled ? 'success' : 'neutral'} size="sm">
                      {t(
                        row.enabled
                          ? 'settings.webhookEndpoints.enabled'
                          : 'settings.webhookEndpoints.disabled',
                      )}
                    </StatusChip>
                    <div className="muted">
                      {row.ingressUrl !== null ? (
                        <code data-testid={`webhook-endpoint-url-${row.id}`}>{row.ingressUrl}</code>
                      ) : (
                        t('settings.webhookEndpoints.noPublicBaseUrl', {
                          path: `/webhooks/${row.provider}/${row.urlToken}`,
                        })
                      )}
                    </div>
                    <div className="muted">
                      {t('settings.webhookEndpoints.secretHint', {
                        hint: row.secretHint ?? '????',
                      })}
                    </div>
                  </div>
                  <div className="page__actions">
                    <Switch
                      checked={row.enabled}
                      onChange={(enabled) => toggle.mutate({ id: row.id, enabled })}
                      label={t('settings.webhookEndpoints.enabledSwitch')}
                    />
                    {row.ingressUrl !== null && (
                      <button
                        type="button"
                        className="btn btn--sm"
                        onClick={() => void copyText(row.ingressUrl ?? '')}
                      >
                        {t('settings.webhookEndpoints.copyUrl')}
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn btn--sm"
                      onClick={() => rotateSecret.mutate(row.id)}
                      data-testid={`webhook-endpoint-rotate-${row.id}`}
                    >
                      {t('settings.webhookEndpoints.rotateSecret')}
                    </button>
                    <ConfirmButton
                      label={t('common.delete')}
                      confirmLabel={t('settings.webhookEndpoints.deleteConfirm')}
                      variant="danger"
                      size="sm"
                      onConfirm={() => remove.mutate(row.id)}
                    />
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </QueryState>

      <Dialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title={t('settings.webhookEndpoints.addTitle')}
        size="md"
        data-testid="webhook-endpoint-create-dialog"
        footer={
          <>
            <button type="button" className="btn" onClick={() => setCreateOpen(false)}>
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

      <Dialog
        open={minted !== null}
        onClose={() => setMinted(null)}
        title={t('settings.webhookEndpoints.secretTitle')}
        size="md"
        data-testid="webhook-endpoint-secret-dialog"
        footer={
          <button type="button" className="btn btn--primary" onClick={() => setMinted(null)}>
            {t('settings.webhookEndpoints.secretDone')}
          </button>
        }
      >
        {minted !== null && (
          <div className="form-grid">
            <p>{t('settings.webhookEndpoints.secretOnce')}</p>
            <Field label={t('settings.webhookEndpoints.secretLabel')}>
              <div className="page__header--row">
                <code data-testid="webhook-endpoint-secret-value">{minted.secret}</code>
                <button
                  type="button"
                  className="btn btn--sm"
                  onClick={() => void copyText(minted.secret)}
                >
                  {t('settings.webhookEndpoints.copySecret')}
                </button>
              </div>
            </Field>
            {minted.ingressUrl !== null && (
              <Field label={t('settings.webhookEndpoints.urlLabel')}>
                <code>{minted.ingressUrl}</code>
              </Field>
            )}
            <p className="muted">{t('settings.webhookEndpoints.secretPasteHint')}</p>
          </div>
        )}
      </Dialog>
    </section>
  )
}
