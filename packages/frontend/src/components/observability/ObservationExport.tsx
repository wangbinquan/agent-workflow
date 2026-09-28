import { useMutation } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import {
  ObservationSnapshotExportSchema,
  type ObservationSnapshotExportQuery,
} from '@agent-workflow/shared'
import { api } from '@/api/client'
import { ErrorBanner } from '@/components/ErrorBanner'
import { NoticeBanner } from '@/components/NoticeBanner'
import { saveBlobAs } from '@/lib/download'

export function ObservationExport({ query }: { query: ObservationSnapshotExportQuery }) {
  const { t, i18n } = useTranslation()
  const mutation = useMutation({
    mutationFn: async () => {
      const result = ObservationSnapshotExportSchema.parse(
        await api.post('/api/observability/exports/snapshot', query),
      )
      saveBlobAs(new Blob([result.content], { type: result.mediaType }), result.filename)
      return result
    },
  })
  return (
    <div className="stack--sm">
      <div className="page__actions">
        <button
          type="button"
          className="btn btn--sm"
          disabled={mutation.isPending}
          onClick={() => mutation.mutate()}
        >
          {t(`runObservability.${mutation.isPending ? 'exporting' : 'exportSnapshot'}`)}
        </button>
        <span className="muted">{t('runObservability.exportHint')}</span>
      </div>
      {mutation.error && <ErrorBanner error={mutation.error} onRetry={() => mutation.mutate()} />}
      {mutation.isSuccess && (
        <NoticeBanner tone={mutation.data.partial ? 'warning' : 'success'} size="compact">
          {t('runObservability.exportReady', {
            count: mutation.data.rows,
            time: new Date(mutation.data.asOf).toLocaleString(i18n.language),
          })}
          {mutation.data.partial && ` ${t('runObservability.exportPartial')}`}
        </NoticeBanner>
      )}
    </div>
  )
}
