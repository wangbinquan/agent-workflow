import { useRef, useState, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  CompleteObservationDimension,
  CompleteObservationDimensionTask,
  CompleteObservationTask,
  CompleteObservationTrend,
  CompleteObservationQuality,
  ObservationOverviewQuery,
} from '@agent-workflow/shared'
import {
  completeObservationReportContent,
  ObservationDimensionSelectionSchema,
} from '@agent-workflow/shared'
import { Card } from '@/components/Card'
import { ErrorBanner } from '@/components/ErrorBanner'
import { LoadingState } from '@/components/LoadingState'
import { NoticeBanner } from '@/components/NoticeBanner'
import { PageHeader } from '@/components/PageHeader'
import { TabBar, tabDomIds } from '@/components/TabBar'
import { useObservationReturn } from '@/hooks/useObservationReturn'
import { CompleteCost, CompleteMetrics, CompleteTokens } from './CompleteObservationMetrics'
import { CompleteObservationPage } from './CompleteObservationPager'
import { CompleteTaskRows, CompleteDimensionRows } from './CompleteObservationTables'
import { CompleteDimensionDetails } from './CompleteDimensionDetails'
import {
  CompleteObservationQuality as QualityCard,
  CompleteQualityDetails,
} from './CompleteObservationQuality'
import { observationGapLabel } from './observationGapLabel'
import { CompleteObservationTrend as Trend } from './CompleteObservationTrend'
import {
  CompleteObservationCalls,
  CompleteObservationTimeline,
  CompleteObservationTiming,
  CompleteObservationStatuses,
  CompleteObservationCaptures,
  CompleteObservationAllocations,
  CompleteObservationCapabilities,
} from './CompleteObservationDetails'
import {
  useCompleteObservationPage,
  useCompleteObservationReport,
  type ReadableObservationReport,
} from './completeReportClient'
import { ObservationFilters } from './ObservationFilters'
import type { ObservationSearch } from './RunObservability'
import './RunObservability.css'
import './ObservationAnalysis.css'
import './CompleteRunObservability.css'

function DimensionCard({
  report,
  section,
  title,
  onSelect,
  selectedKey,
  triggerRef,
}: {
  report: ReadableObservationReport
  section: 'agents' | 'runtimes' | 'models' | 'purposes' | 'sources'
  title: string
  onSelect: (value: CompleteObservationDimension, trigger: HTMLElement) => void
  selectedKey?: string
  triggerRef?: RefObject<HTMLElement | null>
}) {
  const query = useCompleteObservationPage<CompleteObservationDimension>(report, section)
  return (
    <Card title={title}>
      <CompleteObservationPage query={query}>
        {(rows) => (
          <CompleteDimensionRows
            rows={rows}
            onSelect={onSelect}
            selectedKey={selectedKey}
            triggerRef={triggerRef}
          />
        )}
      </CompleteObservationPage>
    </Card>
  )
}
function Summary({ report }: { report: ReadableObservationReport }) {
  const { t, i18n } = useTranslation(),
    value = report.summary.metrics,
    recorded = value.state === 'not-ready' ? report.summary.recordedUsage : undefined
  return (
    <div className="observation-summary observation-summary--complete">
      <Card title={t('runObservability.fullTasks')}>
        <strong className="observation-summary__value">
          {BigInt(report.summary.inventory.tasks).toLocaleString(i18n.language)}
        </strong>
        <p className="muted" title={t('runObservability.runtimeExecutionCountHint')}>
          {t('runObservability.calls')} ·{' '}
          {BigInt(report.summary.inventory.invocations).toLocaleString(i18n.language)}
        </p>
        {report.summary.usageCoverage && (
          <p className="muted">
            {t('runObservability.taskUsageCoverage', {
              ready: BigInt(report.summary.usageCoverage.readyTasks).toLocaleString(i18n.language),
              missing: BigInt(report.summary.usageCoverage.missingTasks).toLocaleString(
                i18n.language,
              ),
              notApplicable: BigInt(report.summary.usageCoverage.notApplicableTasks).toLocaleString(
                i18n.language,
              ),
            })}
          </p>
        )}
      </Card>
      <Card title={t('runObservability.' + (recorded ? 'recordedTokenUsage' : 'totalTokens'))}>
        <div className="observation-summary__value">
          <CompleteTokens value={value} recordedUsage={recorded} compact />
        </div>
      </Card>
      <Card
        title={t(
          'runObservability.' +
            (value.state !== 'not-applicable' && value.recordedCost ? 'recordedCost' : 'cost'),
        )}
      >
        <div className="observation-summary__value">
          <CompleteCost value={value} compact />
        </div>
      </Card>
    </div>
  )
}
export function CompleteRunObservability({
  search,
  onChange,
}: {
  search: ObservationSearch
  onChange: (value: ObservationSearch) => void
}) {
  const { t, i18n } = useTranslation(),
    pageRef = useRef<HTMLDivElement | null>(null)
  const [revision, setRevision] = useState(0)
  const [taskRevisions, setTaskRevisions] = useState<ReadonlyMap<string, number>>(() => new Map())
  const taskRevision = search.task ? (taskRevisions.get(search.task) ?? 0) : 0
  const [dimensions, setDimensions] = useState<
    ReadonlyMap<
      string,
      | (
          | {
              report: ReadableObservationReport
              row: CompleteObservationDimension
              kind: 'dimension'
            }
          | { report: ReadableObservationReport; row: CompleteObservationQuality; kind: 'quality' }
        )
      | null
    >
  >(() => new Map())
  const routeScope = search.task ?? ''
  const dimension = dimensions.get(routeScope) ?? null
  const setDimension = (value: typeof dimension) =>
    setDimensions((previous) => new Map(previous).set(routeScope, value))
  const dimensionTrigger = useRef<HTMLElement | null>(null)
  const [parents, setParents] = useState<readonly string[]>([])
  const tab = search.tab ?? 'tasks'
  const filters: ObservationOverviewQuery = {
    from: search.from,
    to: search.to,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    ...(search.q ? { q: search.q } : {}),
    ...(search.status ? { status: search.status } : {}),
    ...(search.repository ? { repository: search.repository } : {}),
    ...(search.workflow ? { workflow: search.workflow } : {}),
    ...(search.selection ? { selection: search.selection } : {}),
  }
  const whole = useCompleteObservationReport(filters, undefined, revision, !search.task)
  // A contribution opens the full Task tree; returning keeps the parent selection in the URL.
  const task = useCompleteObservationReport(
    { ...filters, selection: undefined },
    search.task,
    taskRevision,
    !!search.task,
  )
  const mainReport =
    whole.data && !whole.error && !whole.isFetching
      ? completeObservationReportContent(whole.data)
      : null
  const current = search.task ? task : whole,
    report =
      current.data && !current.error && !current.isFetching
        ? completeObservationReportContent(current.data)
        : null
  const dimensionVisible = !!report && dimension?.report.header.reportId === report.header.reportId
  const tasks = useCompleteObservationPage<CompleteObservationTask>(
    mainReport,
    'tasks',
    null,
    !search.task && (tab === 'tasks' || tab === 'overview'),
  )
  const contributions = useCompleteObservationPage<CompleteObservationDimensionTask>(
    dimension?.report ?? null,
    dimension?.kind === 'quality' ? 'quality-tasks' : 'dimension-tasks',
    dimension?.row.key ?? null,
    dimensionVisible,
    dimension?.kind === 'quality' ? dimension.row.taskCount : undefined,
  )
  const trends = useCompleteObservationPage<CompleteObservationTrend>(
    mainReport,
    'trends',
    null,
    !search.task && tab === 'overview',
  )
  const scope = JSON.stringify([
    filters,
    tab,
    revision,
    taskRevision,
    dimension?.report.header.reportId ?? null,
    dimension?.row.key ?? null,
    dimension?.kind ?? null,
  ])
  const sourceTask = dimension?.report.header.taskId === search.task ? undefined : search.task
  const saveReturn = useObservationReturn(
    scope,
    sourceTask,
    pageRef,
    !!report &&
      (dimension
        ? !!contributions.data && !contributions.isFetching && !contributions.error
        : !!tasks.data && !tasks.isFetching && !tasks.error),
    { retainNested: true, resetScope: JSON.stringify([filters, tab, revision]) },
  )
  const onTask = (id: string, trigger: HTMLElement) => {
    if (id === search.task) {
      setDimension(null)
      return
    }
    saveReturn(id, trigger)
    setParents((value) => (search.task ? [...value, search.task] : []))
    onChange({ ...search, task: id, attempt: undefined, span: undefined })
  }
  const selectDimension = (row: CompleteObservationDimension, trigger: HTMLElement) => {
    dimensionTrigger.current = trigger
    if (report) setDimension({ report, row, kind: 'dimension' })
  }
  const selectQuality = (row: CompleteObservationQuality, trigger: HTMLElement) => {
    dimensionTrigger.current = trigger
    if (report) setDimension({ report, row, kind: 'quality' })
  }
  const selectedDimensionKey = dimension?.kind === 'dimension' ? dimension.row.key : undefined
  const selectedQualityKey = dimension?.kind === 'quality' ? dimension.row.key : undefined
  const parent = search.task ? JSON.stringify(['task-tree', search.task]) : null
  return (
    <div className="page" ref={pageRef} data-complete-observation>
      <PageHeader
        title={
          search.task && report?.summary.rootTask
            ? report.summary.rootTask.task.name
            : t('runObservability.title')
        }
        back={
          search.task && (
            <button
              type="button"
              className="btn btn--sm btn--ghost page__heading-back"
              onClick={() => {
                const previous = parents.at(-1)
                setParents((value) => value.slice(0, -1))
                onChange({ ...search, task: previous, attempt: undefined, span: undefined })
              }}
            >
              ←{' '}
              {t(
                parents.length
                  ? 'runObservability.backParentTask'
                  : 'runObservability.backAnalysis',
              )}
            </button>
          )
        }
        actions={
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => {
              setDimension(null)
              if (search.task) {
                const id = search.task
                setTaskRevisions((value) => new Map(value).set(id, (value.get(id) ?? 0) + 1))
              } else setRevision((value) => value + 1)
            }}
          >
            {t('runObservability.refresh')}
          </button>
        }
      />
      {!search.task && (
        <>
          <ObservationFilters
            search={search}
            onChange={(value) => {
              setDimension(null)
              onChange(value)
            }}
          />
          <TabBar
            idPrefix="complete-run-observation"
            ariaLabel={t('runObservability.title')}
            active={tab}
            tabs={(['overview', 'tasks', 'agents', 'usage', 'performance'] as const).map((key) => ({
              key,
              label: t('runObservability.tab_' + key),
            }))}
            onSelect={(value) => {
              setDimension(null)
              onChange({ ...search, tab: value, after: undefined })
            }}
          />
        </>
      )}
      {current.error && (
        <ErrorBanner error={current.error} onRetry={() => void current.refetch()} />
      )}
      {!current.error &&
        (current.isPending || current.isFetching || current.data?.state === 'building') && (
          <>
            <LoadingState />
            <p className="muted">{t('runObservability.reportBuilding')}</p>
          </>
        )}
      {!current.error && current.data?.state === 'not-ready' && !current.data.facts && (
        <NoticeBanner tone="warning" title={t('runObservability.reportNotReady')}>
          <p>{t('runObservability.noIncompleteTotals')}</p>
          <ul>
            {current.data.gaps.map((gap) => (
              <li key={gap}>{observationGapLabel(gap, t)}</li>
            ))}
          </ul>
        </NoticeBanner>
      )}
      {!current.error && current.data?.state === 'failed' && (
        <NoticeBanner tone="warning" title={t('runObservability.reportFailed')}>
          {current.data.error}
        </NoticeBanner>
      )}
      {report && (
        <div
          className="stack--md"
          {...(!search.task
            ? {
                role: 'tabpanel',
                id: tabDomIds('complete-run-observation', tab).panelId,
                'aria-labelledby': tabDomIds('complete-run-observation', tab).tabId,
              }
            : {})}
        >
          <p className="muted">
            {t('runObservability.completeAsOf', {
              time: new Date(report.header.asOf).toLocaleString(i18n.language),
            })}
          </p>
          {!search.task && tab === 'overview' && <Summary report={report} />}
          {!search.task && tab === 'overview' && (
            <QualityCard
              report={report}
              onSelect={selectQuality}
              selectedKey={selectedQualityKey}
              triggerRef={dimensionTrigger}
            />
          )}
          {search.task ? (
            <>
              <Card title={t('runObservability.summary')}>
                <CompleteMetrics value={report.summary.metrics} />
                <CompleteObservationTiming report={report} />
              </Card>
              <Card title={t('runObservability.timeline')}>
                <CompleteObservationTimeline report={report} parent={parent} />
              </Card>
              <Card title={t('runObservability.calls')}>
                <CompleteObservationCalls report={report} parent={parent} />
              </Card>
              <div className="observation-columns">
                <DimensionCard
                  report={report}
                  section="agents"
                  title={t('runObservability.agents')}
                  onSelect={selectDimension}
                  selectedKey={selectedDimensionKey}
                  triggerRef={dimensionTrigger}
                />
                <DimensionCard
                  report={report}
                  section="runtimes"
                  title={t('runObservability.runtimes')}
                  onSelect={selectDimension}
                  selectedKey={selectedDimensionKey}
                  triggerRef={dimensionTrigger}
                />
              </div>
              <DimensionCard
                report={report}
                section="models"
                title={t('runObservability.actualModel')}
                onSelect={selectDimension}
                selectedKey={selectedDimensionKey}
                triggerRef={dimensionTrigger}
              />
              {report.summary.metrics.state !== 'not-ready' && (
                <CompleteObservationCaptures report={report} />
              )}
            </>
          ) : tab === 'tasks' ? (
            <Card title={t('runObservability.tasks')}>
              <CompleteObservationPage query={tasks}>
                {(rows) => <CompleteTaskRows rows={rows} onTask={onTask} />}
              </CompleteObservationPage>
            </Card>
          ) : tab === 'overview' ? (
            <>
              <Card title={t('runObservability.trend')}>
                <CompleteObservationPage query={trends}>
                  {(rows) => (
                    <Trend
                      rows={rows}
                      onRange={(from, to) => {
                        setDimension(null)
                        onChange({
                          ...search,
                          from,
                          to,
                          period: 'custom',
                          tab: 'tasks',
                          after: undefined,
                        })
                      }}
                    />
                  )}
                </CompleteObservationPage>
              </Card>
              <div className="observation-columns">
                <Card title={t('runObservability.states')}>
                  <CompleteObservationStatuses report={report} />
                </Card>
                <Card title={t('runObservability.performance')}>
                  <CompleteObservationTiming report={report} />
                </Card>
              </div>
              {report.summary.metrics.state !== 'not-ready' && (
                <CompleteObservationCaptures report={report} />
              )}
              <CompleteObservationCapabilities />
            </>
          ) : tab === 'agents' ? (
            <>
              <DimensionCard
                report={report}
                section="agents"
                title={t('runObservability.crossTaskAgents')}
                onSelect={selectDimension}
                selectedKey={selectedDimensionKey}
                triggerRef={dimensionTrigger}
              />
              <Card title={t('runObservability.timeline')}>
                <CompleteObservationTimeline report={report} />
              </Card>
              <Card title={t('runObservability.calls')}>
                <CompleteObservationCalls report={report} />
              </Card>
            </>
          ) : tab === 'usage' ? (
            <>
              <div className="observation-columns">
                <DimensionCard
                  report={report}
                  section="runtimes"
                  title={t('runObservability.runtimes')}
                  onSelect={selectDimension}
                  selectedKey={selectedDimensionKey}
                  triggerRef={dimensionTrigger}
                />
                <DimensionCard
                  report={report}
                  section="models"
                  title={t('runObservability.actualModel')}
                  onSelect={selectDimension}
                  selectedKey={selectedDimensionKey}
                  triggerRef={dimensionTrigger}
                />
              </div>
              <div className="observation-columns">
                <DimensionCard
                  report={report}
                  section="purposes"
                  title={t('runObservability.purposes')}
                  onSelect={selectDimension}
                  selectedKey={selectedDimensionKey}
                  triggerRef={dimensionTrigger}
                />
                <DimensionCard
                  report={report}
                  section="sources"
                  title={t('runObservability.sources')}
                  onSelect={selectDimension}
                  selectedKey={selectedDimensionKey}
                  triggerRef={dimensionTrigger}
                />
              </div>
              {report.summary.metrics.state !== 'not-ready' && (
                <Card title={t('runObservability.usageRecords')}>
                  <CompleteObservationAllocations report={report} />
                </Card>
              )}
            </>
          ) : (
            <>
              <Card title={t('runObservability.performance')}>
                <CompleteObservationTiming report={report} />
              </Card>
              <Card title={t('runObservability.timeline')}>
                <CompleteObservationTimeline report={report} />
              </Card>
              <CompleteObservationCapabilities />
            </>
          )}
        </div>
      )}
      {dimensionVisible &&
        dimension &&
        (dimension.kind === 'quality' ? (
          <CompleteQualityDetails
            row={dimension.row}
            onClose={() => setDimension(null)}
            triggerRef={dimensionTrigger}
            fallbackRef={pageRef}
          >
            <CompleteObservationPage query={contributions}>
              {(rows) => <CompleteTaskRows rows={rows} onTask={onTask} />}
            </CompleteObservationPage>
          </CompleteQualityDetails>
        ) : (
          <CompleteDimensionDetails
            row={dimension.row}
            onClose={() => setDimension(null)}
            onRelatedTasks={
              !search.task && dimension.row.selection.model
                ? () => {
                    const previous = search.selection
                      ? ObservationDimensionSelectionSchema.parse(JSON.parse(search.selection))
                      : {}
                    setDimension(null)
                    onChange({
                      ...search,
                      selection: JSON.stringify({ ...previous, ...dimension.row.selection }),
                      tab: 'tasks',
                      after: undefined,
                      agent: undefined,
                      quality: undefined,
                      runtime: undefined,
                      model: undefined,
                      attempt: undefined,
                      span: undefined,
                    })
                  }
                : undefined
            }
            triggerRef={dimensionTrigger}
            fallbackRef={pageRef}
          >
            <CompleteObservationPage query={contributions}>
              {(rows) => <CompleteTaskRows rows={rows} onTask={onTask} />}
            </CompleteObservationPage>
          </CompleteDimensionDetails>
        ))}
    </div>
  )
}
