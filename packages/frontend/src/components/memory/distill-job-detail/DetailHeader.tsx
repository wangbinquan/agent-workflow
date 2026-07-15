// RFC-043 T5 — header row at the top of /memory/distill-jobs/$jobId.
// Shows status chip, source kind, attempts, created/started/finished
// timestamps, and a link back to /memory#distill-jobs.

import { Link } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import type { MemoryDistillJob } from '@agent-workflow/shared'
import { PageHeader } from '@/components/PageHeader'
import { StatusChip } from '@/components/StatusChip'

interface Props {
  job: MemoryDistillJob
}

const STATUS_KIND = {
  pending: 'info',
  running: 'info',
  done: 'success',
  failed: 'danger',
  canceled: 'neutral',
} as const

export function DetailHeader({ job }: Props) {
  const { t } = useTranslation()
  const kind = STATUS_KIND[job.status]
  return (
    <PageHeader
      className="distill-job-detail__header"
      back={
        <div className="distill-job-detail__crumbs">
          <Link to="/memory" search={{ tab: 'distill-jobs' }} className="link">
            {t('memory.title')}
          </Link>
          <span aria-hidden="true"> / </span>
          <span>{t('memory.tab.distillJobs')}</span>
        </div>
      }
      title={<code>{job.id}</code>}
      meta={
        <div className="distill-job-detail__meta">
          <StatusChip kind={kind} size="sm" withDot>
            {t(`memory.distillJobs.status.${job.status}`)}
          </StatusChip>
          <span className="distill-job-detail__meta-chip">
            {t(`memory.sourceKind.${job.sourceKind}`)}
          </span>
          <span className="distill-job-detail__meta-chip">
            {t('memory.distillJobDetail.attemptsCount', { n: job.attempts })}
          </span>
          <span
            className="distill-job-detail__meta-chip"
            data-testid="distill-job-detail-output-lang"
          >
            {t('memory.distillJobDetail.outputLangLabel')}:{' '}
            {job.outputLang === 'zh-CN' || job.outputLang === 'en-US'
              ? t(`memory.distillJobDetail.outputLang.${job.outputLang}`)
              : t('memory.distillJobDetail.outputLang.default')}
          </span>
          <span className="muted">
            {t('memory.distillJobs.colCreated')}: {new Date(job.createdAt).toLocaleString()}
          </span>
          {job.startedAt !== null && (
            <span className="muted">
              {t('common.startedAt', { defaultValue: 'Started' })}:{' '}
              {new Date(job.startedAt).toLocaleString()}
            </span>
          )}
          {job.finishedAt !== null && (
            <span className="muted">
              {t('common.finishedAt', { defaultValue: 'Finished' })}:{' '}
              {new Date(job.finishedAt).toLocaleString()}
            </span>
          )}
        </div>
      }
    />
  )
}
