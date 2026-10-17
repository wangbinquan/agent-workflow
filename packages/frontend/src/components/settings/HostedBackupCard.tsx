import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { HostedBackupCatalogSchema, HostedBackupVerificationSchema } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { Dialog } from '@/components/Dialog'
import { ErrorBanner } from '@/components/ErrorBanner'
import { Field, TextArea } from '@/components/Form'
import { LoadingState } from '@/components/LoadingState'
import { NoticeBanner } from '@/components/NoticeBanner'
import { QueryState } from '@/components/QueryState'
import { StatusChip } from '@/components/StatusChip'
import { TableViewport } from '@/components/TableViewport'
import { hasPermissionAtRequest, useAuthSessionRevision, usePermission } from '@/hooks/useActor'
import { useExecutionAvailability } from '@/hooks/useExecutionAvailability'
import { copyText } from '@/lib/clipboard'
import { getAuthSessionRevision } from '@/stores/auth'
import { SettingsCard } from './SettingsCard'

const megabytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(2)} MB`

/** RFC-370 v3 V5: hosted backups are database archives; workspaces are not part of them. */
export function HostedBackupCard({ canRun }: { canRun: boolean }) {
  const revision = useAuthSessionRevision()
  const permitted = usePermission('backup:run')
  return canRun && permitted ? <HostedBackupContents key={revision} revision={revision} /> : null
}

function HostedBackupContents({ revision }: { revision: number }) {
  const { t, i18n } = useTranslation()
  const client = useQueryClient()
  const availability = useExecutionAvailability('maintenance')
  const [selected, setSelected] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState<string | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const queryKey = ['hosted-backups', revision]
  const assertCurrent = () => {
    if (revision !== getAuthSessionRevision() || !hasPermissionAtRequest(client, 'backup:run'))
      throw new Error(t('hostedBackup.changedPermission'))
  }
  const query = useQuery({
    queryKey,
    queryFn: async ({ signal }) => {
      assertCurrent()
      return HostedBackupCatalogSchema.parse(await api.get('/api/backup', undefined, signal))
    },
    // A backup builds in the background; follow it until it settles.
    refetchInterval: (current) =>
      current.state.data?.backups.some((row) => row.state === 'building') ? 3_000 : false,
  })
  const create = useMutation({
    mutationFn: async () => {
      assertCurrent()
      availability.assertAvailable()
      await api.post('/api/backup', { includeWorktrees: false })
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey })
    },
  })
  const verify = useMutation({
    mutationFn: async (backupId: string) => {
      assertCurrent()
      return HostedBackupVerificationSchema.parse(
        await api.post(`/api/backup/${encodeURIComponent(backupId)}/verify`, {}),
      )
    },
    onSuccess: () => {
      setCopied(false)
      setCopyError(null)
    },
  })
  const date = (time: number) => new Date(time).toLocaleString(i18n.language)
  const open = (id: string, trigger: HTMLButtonElement) => {
    triggerRef.current = trigger
    setSelected(id)
    verify.reset()
    verify.mutate(id)
  }
  return (
    <SettingsCard title={t('hostedBackup.title')} hint={t('hostedBackup.hint')}>
      <div className="form-grid">
        <NoticeBanner tone="info" size="compact">
          {t('hostedBackup.databaseOnly')}
        </NoticeBanner>
        <div className="page__actions">
          <button
            type="button"
            className="btn"
            disabled={
              !availability.available ||
              create.isPending ||
              query.data?.backups.some((row) => row.state === 'building')
            }
            onClick={() => create.mutate()}
          >
            {t(create.isPending ? 'hostedBackup.creating' : 'hostedBackup.create')}
          </button>
        </div>
        {availability.unavailableReason && (
          <NoticeBanner tone="warning">{availability.unavailableReason}</NoticeBanner>
        )}
        {create.error && <ErrorBanner error={create.error} />}
        <QueryState
          query={query}
          data={query.data?.backups ?? []}
          emptyText={t('hostedBackup.empty')}
        >
          {(backups) => (
            <TableViewport label={t('hostedBackup.title')}>
              <table className="table">
                <thead>
                  <tr>
                    {(['createdAt', 'kind', 'state', 'size', 'actions'] as const).map((key) => (
                      <th key={key}>{t(`hostedBackup.${key}`)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {backups.map((row) => (
                    <tr key={row.id}>
                      <td>{date(row.createdAt)}</td>
                      <td>{t(`hostedBackup.${row.kind}`)}</td>
                      <td>
                        <StatusChip
                          kind={
                            row.state === 'ready'
                              ? 'success'
                              : row.state === 'failed'
                                ? 'danger'
                                : 'neutral'
                          }
                        >
                          {t(`hostedBackup.states.${row.state}`)}
                        </StatusChip>
                        {row.protected && <p className="muted">{t('hostedBackup.protected')}</p>}
                      </td>
                      <td>{row.sizeBytes === null ? '—' : megabytes(row.sizeBytes)}</td>
                      <td>
                        <button
                          type="button"
                          className="btn btn--sm"
                          disabled={row.state !== 'ready' || verify.isPending}
                          onClick={(event) => open(row.id, event.currentTarget)}
                        >
                          {t('hostedBackup.verify')}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableViewport>
          )}
        </QueryState>
        {query.data?.hasMore && <p className="muted">{t('hostedBackup.recent')}</p>}
      </div>
      <Dialog
        open={selected !== null}
        title={t('hostedBackup.verify')}
        onClose={() => setSelected(null)}
        triggerRef={triggerRef}
        dismissDisabled={verify.isPending}
        size="lg"
        footer={
          <button
            type="button"
            className="btn"
            disabled={verify.isPending}
            onClick={() => setSelected(null)}
          >
            {t('hostedBackup.close')}
          </button>
        }
      >
        {verify.isPending && <LoadingState label={t('hostedBackup.verifying')} />}
        {verify.error && <ErrorBanner error={verify.error} />}
        {verify.data && verify.data.backupId === selected && (
          <div className="form-grid">
            <NoticeBanner tone="success" title={t('hostedBackup.verified')}>
              {t('hostedBackup.counts', {
                workflows: verify.data.workflows,
                skills: verify.data.skills,
                size: megabytes(verify.data.sizeBytes),
              })}
            </NoticeBanner>
            <p className="muted">
              {t('hostedBackup.verifiedAt', { time: date(verify.data.verifiedAt) })}
            </p>
            <Field label={t('hostedBackup.reference')} hint={t('hostedBackup.referenceHint')}>
              <TextArea
                aria-label={t('hostedBackup.reference')}
                value={verify.data.reference}
                onChange={() => undefined}
                readOnly
                monospace
                rows={3}
              />
            </Field>
            <button
              type="button"
              className="btn"
              onClick={async () => {
                try {
                  assertCurrent()
                  const ok = await copyText(verify.data!.reference)
                  setCopied(ok)
                  setCopyError(ok ? null : t('hostedBackup.copyFailed'))
                } catch {
                  setCopyError(t('hostedBackup.changedPermission'))
                }
              }}
            >
              {t(copied ? 'hostedBackup.copied' : 'hostedBackup.copy')}
            </button>
            {copyError && <ErrorBanner error={copyError} />}
            <div>
              <strong>{t('hostedBackup.restoreSteps')}</strong>
              <ol>
                {(['restoreStep1', 'restoreStep2', 'restoreStep3'] as const).map((key) => (
                  <li key={key}>{t(`hostedBackup.${key}`)}</li>
                ))}
              </ol>
            </div>
          </div>
        )}
      </Dialog>
    </SettingsCard>
  )
}
