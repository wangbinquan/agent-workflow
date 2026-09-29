import { useTranslation } from 'react-i18next'
import type { ObservationOverview } from '@agent-workflow/shared'
import { Card } from '@/components/Card'
import { TableViewport } from '@/components/TableViewport'

export function ObservationCollection({
  data,
  onTask,
}: {
  data: ObservationOverview
  onTask: (id: string) => void
}) {
  const { t, i18n } = useTranslation()
  const date = (at: number | null) =>
    at === null
      ? t('runObservability.unknown')
      : new Date(at).toLocaleString(i18n.language, { timeZone: data.filtersEcho.timezone })
  const collection = data.collection
  return (
    <div className="stack--md">
      <Card title={t('runObservability.collectionTitle')}>
        <p className="muted">{t('runObservability.collectionHint')}</p>
        <dl className="detail-grid detail-grid--centered observation-metrics">
          <dt>{t('runObservability.sourceRetained')}</dt>
          <dd>{collection.retainedRecords}</dd>
          <dt>{t('runObservability.sourcePending')}</dt>
          <dd>{collection.pendingRecords}</dd>
          <dt>{t('runObservability.firstObserved')}</dt>
          <dd>{date(collection.firstObservedAt)}</dd>
          <dt>{t('runObservability.lastObserved')}</dt>
          <dd>{date(collection.lastObservedAt)}</dd>
        </dl>
        <TableViewport label={t('runObservability.collectionTitle')}>
          <table className="data-table data-table--compact">
            <thead>
              <tr>
                {['task', 'sourceRetained', 'sourcePending', 'lastObserved'].map((key) => (
                  <th scope="col" key={key}>
                    {t('runObservability.' + key)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {collection.tasks.map((row) => (
                <tr key={row.taskId}>
                  <th scope="row">
                    <button
                      className="link link--button data-table__link task-operations__name"
                      type="button"
                      onClick={() => onTask(row.taskId)}
                    >
                      {data.tasks.find((task) => task.task.id === row.taskId)?.task.name ??
                        row.taskId}
                    </button>
                  </th>
                  <td>{row.retainedRecords}</td>
                  <td>{row.pendingRecords}</td>
                  <td>{date(row.lastObservedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableViewport>
      </Card>
      {collection.platforms.length > 0 && (
        <Card title={t('runObservability.platformCollection')}>
          <TableViewport label={t('runObservability.platformCollection')}>
            <table className="data-table data-table--compact">
              <thead>
                <tr>
                  {['task', 'source', 'state', 'collectionAsOf', 'sourceGaps'].map((key) => (
                    <th scope="col" key={key}>
                      {t('runObservability.' + key)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {collection.platforms.map((row) => (
                  <tr
                    key={JSON.stringify([
                      row.taskId,
                      row.sourceId,
                      row.platformProjectId,
                      row.platformTaskId,
                    ])}
                  >
                    <th scope="row">
                      <button
                        className="link link--button data-table__link task-operations__name"
                        type="button"
                        onClick={() => onTask(row.taskId)}
                      >
                        {data.tasks.find((task) => task.task.id === row.taskId)?.task.name ??
                          row.taskId}
                      </button>
                    </th>
                    <td>
                      {row.sourceId || t('runObservability.unknown')}
                      {row.platformProjectId && (
                        <div>
                          {t('runObservability.platformProject', { id: row.platformProjectId })}
                        </div>
                      )}
                      {row.platformTaskId && (
                        <div>{t('runObservability.platformTask', { id: row.platformTaskId })}</div>
                      )}
                    </td>
                    <td>
                      {t('runObservability.collection_' + row.status)}
                      {row.error && <div className="muted">{row.error}</div>}
                    </td>
                    <td>{date(row.asOf === null ? null : Date.parse(row.asOf))}</td>
                    <td>
                      {t(
                        row.hasGaps
                          ? 'runObservability.gapsPresent'
                          : 'runObservability.gapsAbsent',
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableViewport>
        </Card>
      )}
      <Card title={t('runObservability.captureCapabilities')}>
        <p className="muted">{t('runObservability.captureCapabilitiesHint')}</p>
        <dl className="detail-grid detail-grid--centered observation-metrics">
          <dt>Claude Code</dt>
          <dd>{t('runObservability.claudeCapability')}</dd>
          <dt>OpenCode</dt>
          <dd>{t('runObservability.opencodeCapability')}</dd>
          <dt>CrewStation</dt>
          <dd>{t('runObservability.platformCapability')}</dd>
        </dl>
      </Card>
    </div>
  )
}
