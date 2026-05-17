// RFC-027: the new first tab inside NodeDetailDrawer. Replaces the
// PromptTab as the default view while keeping PromptTab around as a
// safety fallback (see RFC-027 plan T5). Reuses RFC-011's attempts
// switcher so retries / fan-out / clarify iteration history stays
// reachable from the Session view.

import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import type { NodeRun, SessionViewResponse } from '@agent-workflow/shared'
import { api } from '@/api/client'
import {
  formatAttemptLabel,
  isFanoutParentRun,
  isPromptCapableKind,
  sortNodeRunsForPromptHistory,
} from '@/lib/node-prompt'
import { ConversationFlow } from './ConversationFlow'

interface Props {
  taskId: string
  runs: NodeRun[]
  nodeId: string | null
  selectedRunId: string
  workflowNodeKind: string | null
}

export function SessionTab({ taskId, runs, nodeId, selectedRunId, workflowNodeKind }: Props) {
  const { t } = useTranslation()

  const attempts = useMemo(
    () =>
      nodeId === null ? [] : sortNodeRunsForPromptHistory(runs.filter((r) => r.nodeId === nodeId)),
    [runs, nodeId],
  )

  const [pickedId, setPickedId] = useState<string>(selectedRunId)
  useEffect(() => {
    setPickedId(selectedRunId)
  }, [selectedRunId])

  if (!isPromptCapableKind(workflowNodeKind)) {
    return <div className="muted">{t('nodeDrawer.sessionNotApplicable')}</div>
  }
  if (attempts.length === 0) {
    return <div className="muted">{t('nodeDrawer.sessionPending')}</div>
  }

  const picked = attempts.find((a) => a.id === pickedId) ?? attempts[attempts.length - 1]!
  const fanoutParent = isFanoutParentRun(picked, attempts)

  return (
    <div className="session-history">
      <label className="prompt-history__picker">
        <span className="muted">{t('nodeDrawer.promptAttemptLabel')}</span>
        <select
          value={picked.id}
          onChange={(e) => setPickedId(e.target.value)}
          className="prompt-history__select"
        >
          {attempts.map((a) => (
            <option key={a.id} value={a.id}>
              {formatAttemptLabel(a, { fanoutParent: isFanoutParentRun(a, attempts), t })}
            </option>
          ))}
        </select>
      </label>
      {fanoutParent ? (
        <div className="muted">{t('nodeDrawer.sessionFanoutParent')}</div>
      ) : (
        <SessionBody taskId={taskId} nodeRunId={picked.id} />
      )}
    </div>
  )
}

function SessionBody({ taskId, nodeRunId }: { taskId: string; nodeRunId: string }) {
  const { t } = useTranslation()
  const query = useQuery<SessionViewResponse>({
    queryKey: ['tasks', taskId, 'node-runs', nodeRunId, 'session'],
    queryFn: ({ signal }) =>
      api.get(
        `/api/tasks/${encodeURIComponent(taskId)}/node-runs/${encodeURIComponent(nodeRunId)}/session`,
        undefined,
        signal,
      ),
  })
  if (query.isLoading) return <div className="muted">{t('common.loading')}</div>
  if (query.error !== null && query.error !== undefined) {
    return <div className="error-box">{t('session.loadError')}</div>
  }
  if (query.data === undefined) return null
  return <ConversationFlow tree={query.data.tree} />
}
