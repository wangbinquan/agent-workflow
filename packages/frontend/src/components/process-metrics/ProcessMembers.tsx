// RFC-616 §6.2 — a workgroup by member: every member against every metric,
// each column coloured on its own scale so the member that stands out in a
// column is visible at a glance. A person's delivery time is not on the same
// scale as an agent's execution time and is never coloured with it.
import { useTranslation } from 'react-i18next'
import type { ProcessWorkgroupMemberRow, ProcessWorkgroupSummary } from '@agent-workflow/shared'
import { Card } from '@/components/Card'
import { EmptyState } from '@/components/EmptyState'
import { HeatScale, heatClassName } from '@/components/HeatScale'
import { NoticeBanner } from '@/components/NoticeBanner'
import { TableViewport } from '@/components/TableViewport'
import { decimal, duration, percent, tokens, type Translate } from './processFormat'
import { heatColumn } from './processHeat'
import { memberName } from './processNames'

const COLUMNS = [
  'assignments',
  'duration',
  'tokens',
  'failure',
  'protocolRetry',
  'clarify',
] as const
type Column = (typeof COLUMNS)[number]

const isHuman = (member: ProcessWorkgroupMemberRow) => member.role === 'member-human'

/** The number a member's cell is ranked by; null where the metric does not apply. */
export function memberHeatValue(member: ProcessWorkgroupMemberRow, column: Column): number | null {
  switch (column) {
    case 'assignments':
      return member.assignmentsPerUnit
    case 'duration':
      return isHuman(member) ? null : member.durationMs.p50
    case 'tokens':
      return member.tokensPerUnit
    case 'failure':
      return member.failureRate
    case 'protocolRetry':
      return member.protocolRetryRate
    case 'clarify':
      return member.clarifyPerUnit
  }
}

function cellText(member: ProcessWorkgroupMemberRow, column: Column, t: Translate): string {
  switch (column) {
    case 'assignments':
      return decimal(member.assignmentsPerUnit)
    case 'duration':
      return isHuman(member)
        ? member.deliveryMs.p50 === null
          ? '—'
          : t('processMetrics.members.delivery', { value: duration(member.deliveryMs.p50, t) })
        : duration(member.durationMs.p50, t)
    case 'tokens':
      return tokens(member.tokensPerUnit)
    case 'failure':
      return percent(member.failureRate)
    case 'protocolRetry':
      return percent(member.protocolRetryRate)
    case 'clarify':
      return decimal(member.clarifyPerUnit)
  }
}

export function ProcessMembers({ summary }: { summary: ProcessWorkgroupSummary }) {
  const { t } = useTranslation()
  const members = summary.members
  if (members.length === 0) return <EmptyState title={t('processMetrics.members.empty')} />
  const heat = Object.fromEntries(
    COLUMNS.map((column) => [
      column,
      heatColumn(members.map((member) => memberHeatValue(member, column))),
    ]),
  ) as Record<Column, ReturnType<typeof heatColumn>>
  const label = t('processMetrics.members.title')
  return (
    <>
      <Card
        title={label}
        header={<p className="muted process-metrics__note">{t('processMetrics.members.hint')}</p>}
      >
        <HeatScale
          lowLabel={t('processMetrics.members.low')}
          highLabel={t('processMetrics.members.high')}
          note={t('processMetrics.members.note')}
        />
        <TableViewport label={label} minWidth="lg">
          <table className="data-table data-table--compact" aria-label={label}>
            <thead>
              <tr>
                <th scope="col">{t('processMetrics.members.col.member')}</th>
                <th scope="col">{t('processMetrics.members.col.role')}</th>
                {COLUMNS.map((column) => (
                  <th key={column} scope="col" className="viz-num">
                    {t(`processMetrics.members.col.${column}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {members.map((member, index) => (
                <tr key={member.key}>
                  <th scope="row">{memberName(member, t)}</th>
                  <td>
                    {t(`processMetrics.member.${member.role}`)}
                    {member.roleNote ? <span className="muted"> · {member.roleNote}</span> : null}
                  </td>
                  {COLUMNS.map((column) => (
                    <td
                      key={column}
                      className={`viz-num ${heatClassName(heat[column].levels[index])}`.trim()}
                    >
                      {cellText(member, column, t)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </TableViewport>
      </Card>
      {summary.scope === 'own' ? (
        <NoticeBanner tone="info">{t('processMetrics.people.hidden')}</NoticeBanner>
      ) : null}
    </>
  )
}
