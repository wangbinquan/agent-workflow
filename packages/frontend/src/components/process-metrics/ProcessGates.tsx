// RFC-616 §11 — where people come into the process: reviews, clarifying
// questions and mind maps of a workflow; messages, deliveries and confirmations
// of a workgroup; plan reviews, merge-request feedback, approvals and blocks of
// a digital employee. Per-person rows are shown only to viewers who may see them.
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  ProcessClarifySummary,
  ProcessDecisionGate,
  ProcessIdentity,
  ProcessMindmapSummary,
  ProcessPersonRow,
  ProcessReviewSummary,
  ProcessSubjectSummary,
} from '@agent-workflow/shared'
import { Card } from '@/components/Card'
import { ColumnChart } from '@/components/ColumnChart'
import { EmptyState } from '@/components/EmptyState'
import { MeterBar } from '@/components/MeterBar'
import { MetricGrid, MetricTile } from '@/components/MetricTile'
import { NoticeBanner } from '@/components/NoticeBanner'
import { OwnerLabel } from '@/components/OwnerLabel'
import { SegmentedBar, SegmentedBarLegend, type SegmentedBarPart } from '@/components/SegmentedBar'
import { TableViewport } from '@/components/TableViewport'
import { count, decimal, duration, durationSpread, percent, tokens } from './processFormat'
import { stageNamesOf } from './processNames'

function Note({ children }: { children: ReactNode }) {
  return <p className="muted process-metrics__note">{children}</p>
}

function SubTitle({ children }: { children: ReactNode }) {
  return <h4 className="process-metrics__subtitle">{children}</h4>
}

function PeopleTable(props: {
  people: readonly ProcessPersonRow[] | null
  identities: readonly ProcessIdentity[]
  /** Which activity columns this gate has. */
  columns: readonly ('decisions' | 'comments' | 'answers')[]
}) {
  const { t, i18n } = useTranslation()
  if (props.people === null)
    return <NoticeBanner tone="info">{t('processMetrics.people.hidden')}</NoticeBanner>
  if (props.people.length === 0) return null
  const byId = new Map(props.identities.map((identity) => [identity.id, identity]))
  const label = t('processMetrics.people.title')
  return (
    <>
      <SubTitle>{label}</SubTitle>
      <TableViewport label={label} minWidth="sm">
        <table className="data-table data-table--compact" aria-label={label}>
          <thead>
            <tr>
              <th scope="col">{t('processMetrics.people.col.person')}</th>
              {props.columns.map((column) => (
                <th key={column} scope="col" className="viz-num">
                  {t(`processMetrics.people.col.${column}`)}
                </th>
              ))}
              <th scope="col" className="viz-num">
                {t('processMetrics.people.col.response')}
              </th>
            </tr>
          </thead>
          <tbody>
            {props.people.map((person) => (
              <tr key={person.userId}>
                <th scope="row">
                  <OwnerLabel ownerUserId={person.userId} owner={byId.get(person.userId) ?? null} />
                </th>
                {props.columns.map((column) => (
                  <td key={column} className="viz-num">
                    {count(person[column], i18n.language)}
                  </td>
                ))}
                <td className="viz-num">{duration(person.responseP50, t)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableViewport>
    </>
  )
}

function ReviewCard(props: {
  review: ProcessReviewSummary
  summary: ProcessSubjectSummary
  title: string
  subtitle: string
}) {
  const { t, i18n } = useTranslation()
  const { review, summary } = props
  const names = stageNamesOf(summary, t, i18n.language)
  const decisions: SegmentedBarPart[] = (
    [
      ['approved', 'good'],
      ['iterated', 'warn'],
      ['rejected', 'crit'],
    ] as const
  ).map(([key, fill]) => ({
    key,
    label: t(`processMetrics.review.decision.${key}`),
    amount: review.decisions[key],
    valueText: t('processMetrics.review.times', { count: review.decisions[key] }),
    fill,
  }))
  const per = t(`processMetrics.per.${summary.kind}`)
  const byRound = review.commentsByRound.filter((entry) => entry.rounds > 0)
  // A digital employee's plan is reviewed at a work item, and the work item is what was
  // reviewed: its table has no "reviewed node" column and does not speak of nodes or tasks.
  const employee = summary.kind === 'digital-employee'
  const stageLabel = t(
    employee ? 'processMetrics.planReview.byStage' : 'processMetrics.review.byStage',
  )
  return (
    <Card title={props.title} header={<Note>{props.subtitle}</Note>}>
      <MetricGrid compact>
        <MetricTile
          label={t('processMetrics.review.duration')}
          value={duration(review.durationMs.p50, t)}
          detail={t('processMetrics.medianP90', { p90: duration(review.durationMs.p90, t) })}
        />
        <MetricTile
          label={t('processMetrics.review.firstPass')}
          value={percent(review.firstPassRate)}
          detail={t('processMetrics.review.firstPassHint')}
        />
        <MetricTile
          label={t('processMetrics.review.roundsPerUnit', { per })}
          value={decimal(review.roundsPerUnit)}
          detail={t('processMetrics.review.roundsHint', { count: review.rounds })}
        />
        <MetricTile
          label={t('processMetrics.review.commentsPerRound')}
          value={decimal(review.commentsPerRound)}
          detail={t('processMetrics.review.commentsHint', {
            perPerson: decimal(review.commentsPerCommenter),
            people: decimal(review.commentersPerRound),
          })}
        />
        <MetricTile
          label={t('processMetrics.review.rework')}
          value={duration(review.reworkMs.p50, t)}
          detail={t('processMetrics.review.reworkHint')}
        />
        <MetricTile
          label={t('processMetrics.response')}
          value={duration(review.responseMs.p50, t)}
          detail={t('processMetrics.responseHint')}
        />
        <MetricTile
          label={t('processMetrics.handling')}
          value={duration(review.handlingMs.p50, t)}
          detail={t('processMetrics.handlingHint')}
        />
      </MetricGrid>
      <div className="process-metrics__grid2">
        <div className="stack--sm">
          <SubTitle>{t('processMetrics.review.decisions')}</SubTitle>
          {review.rounds === 0 ? (
            <EmptyState size="compact" title={t('processMetrics.review.noDecisions')} />
          ) : (
            <>
              <SegmentedBar parts={decisions} label={t('processMetrics.review.decisions')} />
              <SegmentedBarLegend parts={decisions} />
            </>
          )}
        </div>
        <div className="stack--sm">
          <SubTitle>{t('processMetrics.review.convergence')}</SubTitle>
          {byRound.length === 0 ? (
            <EmptyState size="compact" title={t('processMetrics.review.noComments')} />
          ) : (
            <ColumnChart
              label={t('processMetrics.review.convergence')}
              items={byRound.map((entry) => ({
                key: String(entry.ordinal),
                label: t('processMetrics.rounds.round', { round: entry.ordinal }),
                value: entry.comments / entry.rounds,
                valueText: decimal(entry.comments / entry.rounds),
                note: t('processMetrics.review.roundsCount', { count: entry.rounds }),
              }))}
            />
          )}
        </div>
      </div>
      {review.voidRounds > 0 ? (
        <Note>{t('processMetrics.review.voidRounds', { count: review.voidRounds })}</Note>
      ) : null}
      {review.documentAcceptRate !== null ? (
        <Note>
          {t('processMetrics.review.documentAccept', { rate: percent(review.documentAcceptRate) })}
        </Note>
      ) : null}
      {review.byStage.length > 0 ? (
        <>
          <SubTitle>{stageLabel}</SubTitle>
          <TableViewport label={stageLabel} minWidth="md">
            <table className="data-table data-table--compact" aria-label={stageLabel}>
              <thead>
                <tr>
                  <th scope="col">
                    {t(
                      employee
                        ? 'processMetrics.planReview.stage'
                        : 'processMetrics.review.col.stage',
                    )}
                  </th>
                  {employee ? null : <th scope="col">{t('processMetrics.review.col.related')}</th>}
                  <th scope="col" className="viz-num">
                    {t('processMetrics.review.col.rounds', { per })}
                  </th>
                  <th scope="col" className="viz-num">
                    {t('processMetrics.review.col.duration')}
                  </th>
                  <th scope="col" className="viz-num">
                    {t('processMetrics.review.col.comments')}
                  </th>
                  <th scope="col" className="viz-num">
                    {t('processMetrics.review.col.firstPass')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {review.byStage.map((row) => (
                  <tr key={row.stageKey}>
                    <th scope="row">{names.get(row.stageKey) ?? row.stageKey}</th>
                    {employee ? null : (
                      <td>
                        {row.relatedStageKey === null || row.relatedStageKey === row.stageKey
                          ? '—'
                          : (names.get(row.relatedStageKey) ?? row.relatedStageKey)}
                      </td>
                    )}
                    <td className="viz-num">{decimal(row.roundsPerUnit)}</td>
                    <td className="viz-num">{durationSpread(row.durationMs, t)}</td>
                    <td className="viz-num">{decimal(row.commentsPerRound)}</td>
                    <td className="viz-num">{percent(row.firstPassRate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableViewport>
        </>
      ) : null}
      <PeopleTable
        people={review.people}
        identities={summary.identities}
        columns={['decisions', 'comments']}
      />
    </Card>
  )
}

function ClarifyCard(props: { clarify: ProcessClarifySummary; summary: ProcessSubjectSummary }) {
  const { t, i18n } = useTranslation()
  const { clarify, summary } = props
  const names = stageNamesOf(summary, t, i18n.language)
  const unit = t(`processMetrics.unit.${summary.kind}`)
  const answers: SegmentedBarPart[] = (
    [
      ['recommended', 'ord-1'],
      ['other', 'ord-2'],
      ['custom', 'ord-3'],
      ['skipped', 'other'],
    ] as const
  ).map(([key, fill]) => ({
    key,
    label: t(`processMetrics.clarify.answer.${key}`),
    amount: clarify.answers[key],
    valueText: t('processMetrics.clarify.questions', { count: clarify.answers[key] }),
    fill,
  }))
  const answered = answers.reduce((sum, part) => sum + part.amount, 0)
  const byAsker = summary.kind === 'workgroup' ? summary.clarifyByAsker : null
  const stageLabel = t('processMetrics.clarify.byStage')
  return (
    <Card
      title={t('processMetrics.clarify.title')}
      header={<Note>{t('processMetrics.clarify.subtitle')}</Note>}
    >
      <MetricGrid compact>
        <MetricTile
          label={t('processMetrics.clarify.triggerRate')}
          value={percent(clarify.triggerRate)}
          detail={t('processMetrics.clarify.triggerHint', { count: clarify.unitsAsking, unit })}
        />
        <MetricTile
          label={t('processMetrics.clarify.roundsPerUnit', {
            per: t(`processMetrics.per.${summary.kind}`),
          })}
          value={decimal(clarify.roundsPerUnit)}
          detail={
            byAsker === null
              ? t('processMetrics.clarify.roundsHint', { count: clarify.rounds })
              : t('processMetrics.clarify.byAsker', {
                  leader: decimal(byAsker.leader),
                  member: decimal(byAsker.member),
                })
          }
        />
        <MetricTile
          label={t('processMetrics.clarify.questionsPerRound')}
          value={decimal(clarify.questionsPerRound)}
          detail={t('processMetrics.clarify.questionsHint')}
        />
        <MetricTile
          label={t('processMetrics.clarify.answerTime')}
          value={duration(clarify.answerMs.p50, t)}
          detail={t('processMetrics.medianP90', { p90: duration(clarify.answerMs.p90, t) })}
        />
        <MetricTile
          label={t('processMetrics.clarify.stopRate')}
          value={percent(clarify.stopRate)}
          detail={t('processMetrics.clarify.stopHint')}
        />
        <MetricTile
          label={t('processMetrics.response')}
          value={duration(clarify.responseMs.p50, t)}
          detail={t('processMetrics.responseHint')}
        />
        <MetricTile
          label={t('processMetrics.handling')}
          value={duration(clarify.handlingMs.p50, t)}
          detail={t('processMetrics.handlingHint')}
        />
      </MetricGrid>
      <SubTitle>{t('processMetrics.clarify.answers')}</SubTitle>
      {answered === 0 ? (
        <EmptyState size="compact" title={t('processMetrics.clarify.noAnswers')} />
      ) : (
        <>
          <SegmentedBar parts={answers} label={t('processMetrics.clarify.answers')} />
          <SegmentedBarLegend parts={answers} />
          <Note>
            {t('processMetrics.clarify.recommendedRate', {
              rate: percent(clarify.recommendedRate),
            })}{' '}
            {t('processMetrics.clarify.answersHint')}
          </Note>
        </>
      )}
      {clarify.voidRounds > 0 ? (
        <Note>{t('processMetrics.clarify.voidRounds', { count: clarify.voidRounds })}</Note>
      ) : null}
      {clarify.byStage.length > 0 && summary.kind !== 'workgroup' ? (
        <>
          <SubTitle>{stageLabel}</SubTitle>
          <TableViewport label={stageLabel} minWidth="sm">
            <table className="data-table data-table--compact" aria-label={stageLabel}>
              <thead>
                <tr>
                  <th scope="col">{t('processMetrics.clarify.col.stage')}</th>
                  <th scope="col">{t('processMetrics.clarify.col.asking')}</th>
                  <th scope="col" className="viz-num">
                    {t('processMetrics.clarify.col.rounds')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {clarify.byStage.map((row) => (
                  <tr key={`${row.stageKey}\u0000${row.askingStageKey ?? ''}`}>
                    <th scope="row">{names.get(row.stageKey) ?? row.stageKey}</th>
                    <td>
                      {row.askingStageKey === null
                        ? '—'
                        : (names.get(row.askingStageKey) ?? row.askingStageKey)}
                    </td>
                    <td className="viz-num">{decimal(row.roundsPerUnit)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableViewport>
        </>
      ) : null}
      <PeopleTable people={clarify.people} identities={summary.identities} columns={['answers']} />
    </Card>
  )
}

function MindmapCard({ mindmap }: { mindmap: ProcessMindmapSummary }) {
  const { t } = useTranslation()
  const maturity: SegmentedBarPart[] = (
    [
      ['decided', 'ord-3'],
      ['provisional', 'ord-2'],
      ['unmarked', 'ord-1'],
      ['skipped', 'other'],
    ] as const
  ).map(([key, fill]) => ({
    key,
    label: t(`processMetrics.mindmap.maturity.${key}`),
    amount: mindmap.maturity[key],
    valueText: t('processMetrics.clarify.questions', { count: mindmap.maturity[key] }),
    fill,
  }))
  const marked = maturity.reduce((sum, part) => sum + part.amount, 0)
  return (
    <Card
      title={t('processMetrics.mindmap.title')}
      header={<Note>{t('processMetrics.mindmap.subtitle')}</Note>}
    >
      <MetricGrid compact>
        <MetricTile
          label={t('processMetrics.mindmap.depth')}
          value={
            mindmap.depthMean === null
              ? '—'
              : t('processMetrics.mindmap.levels', { value: decimal(mindmap.depthMean) })
          }
          detail={t('processMetrics.mindmap.depthHint', { max: decimal(mindmap.depthMax, 0) })}
        />
        <MetricTile
          label={t('processMetrics.mindmap.mapsPerNode')}
          value={decimal(mindmap.mapsPerNode)}
          detail={t('processMetrics.mindmap.mapsHint', { count: mindmap.maps })}
        />
        <MetricTile
          label={t('processMetrics.mindmap.followups')}
          value={decimal(mindmap.followupsPerMap)}
          detail={t('processMetrics.mindmap.followupsHint')}
        />
        <MetricTile
          label={t('processMetrics.mindmap.questions')}
          value={decimal(mindmap.questionsPerMap)}
          detail={t('processMetrics.mindmap.questionsHint', {
            initial: decimal(mindmap.initialQuestionsPerMap),
            followup: decimal(mindmap.followupQuestionsPerMap),
          })}
        />
        <MetricTile
          label={t('processMetrics.mindmap.duration')}
          value={duration(mindmap.durationMs.p50, t)}
          detail={t('processMetrics.mindmap.durationHint')}
        />
        <MetricTile
          label={t('processMetrics.mindmap.generation')}
          value={duration(mindmap.followupGenerationMs, t)}
          detail={t('processMetrics.mindmap.generationHint', {
            tokens: tokens(mindmap.followupGenerationTokens),
          })}
        />
      </MetricGrid>
      <SubTitle>{t('processMetrics.mindmap.maturityTitle')}</SubTitle>
      {marked === 0 ? (
        <EmptyState size="compact" title={t('processMetrics.clarify.noAnswers')} />
      ) : (
        <>
          <SegmentedBar parts={maturity} label={t('processMetrics.mindmap.maturityTitle')} />
          <SegmentedBarLegend parts={maturity} />
        </>
      )}
      {mindmap.categoryCoverage !== null ? (
        <Note>
          {t('processMetrics.mindmap.coverage', { rate: percent(mindmap.categoryCoverage) })}
        </Note>
      ) : null}
    </Card>
  )
}

function DecisionGateCard(props: { gate: ProcessDecisionGate; title: string; subtitle: string }) {
  const { t } = useTranslation()
  const { gate } = props
  return (
    <Card title={props.title} header={<Note>{props.subtitle}</Note>}>
      <MetricGrid compact>
        <MetricTile
          label={t('processMetrics.decisionGate.wait')}
          value={duration(gate.waitMs.p50, t)}
          detail={t('processMetrics.medianP90', { p90: duration(gate.waitMs.p90, t) })}
        />
        <MetricTile
          label={t('processMetrics.decisionGate.rejectRate')}
          value={percent(gate.rejectRate)}
          detail={t('processMetrics.decisionGate.rejectHint', {
            rejections: gate.rejections,
            rounds: gate.rounds,
          })}
        />
        <MetricTile
          label={t('processMetrics.decisionGate.extraRounds')}
          value={
            gate.extraRoundsAfterReject === null
              ? '—'
              : t('processMetrics.list.rounds', { value: decimal(gate.extraRoundsAfterReject) })
          }
          detail={t('processMetrics.decisionGate.extraHint')}
        />
      </MetricGrid>
    </Card>
  )
}

export function ProcessGates({ summary }: { summary: ProcessSubjectSummary }) {
  const { t, i18n } = useTranslation()
  const unit = t(`processMetrics.unit.${summary.kind}`)
  if (summary.kind === 'workflow') {
    if (summary.review === null && summary.clarify === null && summary.mindmap === null)
      return (
        <EmptyState
          title={t('processMetrics.gates.empty')}
          description={t('processMetrics.gates.emptyHint')}
        />
      )
    return (
      <>
        {summary.review === null ? null : (
          <ReviewCard
            review={summary.review}
            summary={summary}
            title={t('processMetrics.review.title')}
            subtitle={t('processMetrics.review.subtitle')}
          />
        )}
        {summary.clarify === null ? null : (
          <ClarifyCard clarify={summary.clarify} summary={summary} />
        )}
        {summary.mindmap === null ? null : <MindmapCard mindmap={summary.mindmap} />}
      </>
    )
  }
  if (summary.kind === 'workgroup') {
    const human = summary.human
    return (
      <>
        <Card
          title={t('processMetrics.human.title')}
          header={<Note>{t('processMetrics.human.subtitle', { unit })}</Note>}
        >
          <MetricGrid compact>
            <MetricTile
              label={t('processMetrics.human.messages')}
              value={decimal(human.messagesPerUnit)}
              detail={t('processMetrics.human.messagesHint')}
            />
            <MetricTile
              label={t('processMetrics.human.direct')}
              value={decimal(human.directAssignmentsPerUnit)}
              detail={t('processMetrics.human.directHint')}
            />
            <MetricTile
              label={t('processMetrics.human.delivery')}
              value={duration(human.deliveryMs.p50, t)}
              detail={t('processMetrics.human.deliveryHint')}
            />
            <MetricTile
              label={t('processMetrics.human.config')}
              value={decimal(human.configChangesPerUnit)}
              detail={t('processMetrics.human.configHint')}
            />
          </MetricGrid>
        </Card>
        {summary.completion === null ? null : (
          <DecisionGateCard
            gate={summary.completion}
            title={t('processMetrics.decisionGate.completion')}
            subtitle={t('processMetrics.decisionGate.completionHint')}
          />
        )}
        {summary.planConfirm === null ? null : (
          <DecisionGateCard
            gate={summary.planConfirm}
            title={t('processMetrics.decisionGate.planConfirm')}
            subtitle={t('processMetrics.decisionGate.planConfirmHint')}
          />
        )}
        {summary.clarify === null ? null : (
          <ClarifyCard clarify={summary.clarify} summary={summary} />
        )}
      </>
    )
  }
  const blocked = summary.blocked
  const blockedNow = blocked.current.reduce((sum, entry) => sum + entry.units, 0)
  const reasonLabel = t('processMetrics.blocked.current')
  return (
    <>
      {summary.review === null ? null : (
        <ReviewCard
          review={summary.review}
          summary={summary}
          title={t('processMetrics.planReview.title')}
          subtitle={t('processMetrics.planReview.subtitle')}
        />
      )}
      <Card
        title={t('processMetrics.mergeRequest.title')}
        header={<Note>{t('processMetrics.mergeRequest.subtitle')}</Note>}
      >
        <MetricGrid compact>
          <MetricTile
            label={t('processMetrics.mergeRequest.feedback')}
            value={
              summary.feedbackPerUnit === null
                ? t('processMetrics.notApplicable')
                : t('processMetrics.mergeRequest.feedbackValue', {
                    value: decimal(summary.feedbackPerUnit),
                    unit,
                  })
            }
            detail={t(
              summary.feedbackPerUnit === null
                ? 'processMetrics.mergeRequest.feedbackUndeclared'
                : 'processMetrics.mergeRequest.feedbackHint',
            )}
          />
          <MetricTile
            label={t('processMetrics.mergeRequest.approvals')}
            value={
              summary.approvals.perUnit === null
                ? '—'
                : t('processMetrics.mergeRequest.approvalsValue', {
                    value: decimal(summary.approvals.perUnit),
                    unit,
                  })
            }
            detail={t('processMetrics.mergeRequest.approvalsHint', {
              p50: duration(summary.approvals.waitMs.p50, t),
            })}
          />
        </MetricGrid>
      </Card>
      <Card
        title={t('processMetrics.blocked.title')}
        header={<Note>{t('processMetrics.blocked.subtitle')}</Note>}
      >
        <MetricGrid compact>
          <MetricTile
            label={t('processMetrics.blocked.perUnit')}
            value={
              blocked.perUnit === null
                ? '—'
                : t('processMetrics.mergeRequest.approvalsValue', {
                    value: decimal(blocked.perUnit),
                    unit,
                  })
            }
            detail={t('processMetrics.blocked.unitsHint', { count: blocked.units, unit })}
          />
          <MetricTile
            label={t('processMetrics.blocked.duration')}
            value={duration(blocked.durationMs.p50, t)}
            detail={t('processMetrics.blocked.durationHint')}
          />
          <MetricTile
            label={t('processMetrics.blocked.resumes')}
            value={count(blocked.resumes, i18n.language)}
            detail={t('processMetrics.blocked.resumesHint', { count: blocked.terminations })}
          />
        </MetricGrid>
        {blocked.current.length > 0 ? (
          <>
            <TableViewport label={reasonLabel} minWidth="sm">
              <table className="data-table data-table--compact" aria-label={reasonLabel}>
                <thead>
                  <tr>
                    <th scope="col">{reasonLabel}</th>
                    <th scope="col" className="viz-num">
                      {t('processMetrics.blocked.col.units')}
                    </th>
                    <th scope="col">{t('processMetrics.blocked.col.share')}</th>
                  </tr>
                </thead>
                <tbody>
                  {blocked.current.map((entry) => (
                    <tr key={entry.reason}>
                      <th scope="row">{entry.reason}</th>
                      <td className="viz-num">{count(entry.units, i18n.language)}</td>
                      <td>
                        <MeterBar share={blockedNow === 0 ? null : entry.units / blockedNow} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableViewport>
            <Note>{t('processMetrics.blocked.reasonHint')}</Note>
          </>
        ) : null}
      </Card>
    </>
  )
}
