// RFC-298 — the task-detail jump back to the frozen webhook source object.
// Fallback selection and URL validation live in shared/backend; this component
// only maps the selected target kind to controlled, localized copy.

import type { WebhookTaskSourceLink } from '@agent-workflow/shared'
import { useTranslation } from 'react-i18next'

const SOURCE_LABEL_KEYS = {
  comment: 'tasks.webhookSource.comment',
  merge_request: 'tasks.webhookSource.mergeRequest',
  pipeline: 'tasks.webhookSource.pipeline',
  commit: 'tasks.webhookSource.commit',
  project: 'tasks.webhookSource.project',
} as const satisfies Record<WebhookTaskSourceLink['kind'], string>

export function TaskWebhookSourceLink({ source }: { source: WebhookTaskSourceLink }) {
  const { t } = useTranslation()
  return (
    <a
      className="data-table__link task-detail__source-link"
      data-testid="task-webhook-source-link"
      href={source.url}
      target="_blank"
      rel="noopener noreferrer"
    >
      {t(SOURCE_LABEL_KEYS[source.kind])} <span aria-hidden="true">↗</span>
    </a>
  )
}
