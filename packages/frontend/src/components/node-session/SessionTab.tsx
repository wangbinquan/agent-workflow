// RFC-027: the new first tab inside NodeDetailDrawer. Replaces the
// PromptTab as the default view while keeping PromptTab around as a
// safety fallback (see RFC-027 plan T5). Reuses RFC-011's attempts
// switcher so retries / fan-out / clarify iteration history stays
// reachable from the Session view.

import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import type { NodeRun, SessionViewResponse } from '@agent-workflow/shared'
import { isAgentNodeKind } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { isFanoutParentRun, sortNodeRunsForPromptHistory } from '@/lib/node-prompt'
import { ConversationFlow } from './ConversationFlow'
import { InjectedMemoriesCard } from './InjectedMemoriesCard'
import { LoadingState } from '@/components/LoadingState'
import { RuntimeInventorySection } from '@/components/inventory/RuntimeInventorySection'
import { Select, type SelectOption } from '@/components/Select'
import { clarifyRoundForRun } from '@/lib/node-history'
import { nodeRunStatusToKind } from '@/lib/noderun-status'

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

  if (attempts.length === 0) {
    return <div className="muted">{t('nodeDrawer.sessionPending')}</div>
  }

  const picked = attempts.find((a) => a.id === pickedId) ?? attempts[attempts.length - 1]!
  const fanoutParent = isFanoutParentRun(picked, attempts)
  // RFC-060 PR-E: wrapper-fanout containers aren't prompt-capable themselves
  // (no opencode session of their own) but they ARE fan-out parents whose
  // inner shard rows carry the actual sessions — surface the shard picker.
  // Non-agent / non-fan-out kinds (input, output, review, clarify, plain
  // wrapper-git, wrapper-loop) still get "session not applicable".
  if (!isAgentNodeKind(workflowNodeKind) && !fanoutParent) {
    return <div className="muted">{t('nodeDrawer.sessionNotApplicable')}</div>
  }

  return (
    <div className="session-history">
      <AttemptPicker
        attempts={attempts}
        pickedId={picked.id}
        onPick={setPickedId}
        isFanoutParent={(a) => isFanoutParentRun(a, attempts)}
      />
      {fanoutParent ? (
        <div className="muted">{t('nodeDrawer.sessionFanoutParent')}</div>
      ) : (
        <>
          {/* RFC-046: post-budget-clip snapshot of memories injected at
              runner-inject time. Collapsed by default; only renders for
              agent-* kinds (helper returns null otherwise). */}
          <InjectedMemoriesCard
            run={picked}
            attempts={attempts}
            workflowNodeKind={workflowNodeKind}
          />
          {/* RFC-029: runtime inventory section sits between the attempts
              switcher and the conversation flow so users can confirm "what
              opencode actually loaded" before scanning the dialog. */}
          <RuntimeInventorySection
            taskId={taskId}
            nodeRunId={picked.id}
            workflowNodeKind={workflowNodeKind}
          />
          <SessionBody taskId={taskId} nodeRunId={picked.id} />
        </>
      )}
    </div>
  )
}

/**
 * Dropdown picker for node attempts. Replaces the earlier chip-row layout —
 * with many retries / fan-out shards / clarify rounds the chips wrapped or
 * scrolled awkwardly inside the node drawer. The Select component (RFC-036)
 * is the project's styled, portal-based combobox so it still avoids the
 * "丑 native <select>" complaint that the chip-row was created to fix.
 *
 * `renderOption` and `renderValue` preserve the exact row content (status
 * dot · iter label · shard · parent · timestamp) inside both the dropdown
 * list and the closed trigger.
 *
 * ARIA: combobox + listbox + option via the Select primitive.
 */
function AttemptPicker({
  attempts,
  pickedId,
  onPick,
  isFanoutParent,
}: {
  attempts: NodeRun[]
  pickedId: string
  onPick: (id: string) => void
  isFanoutParent: (a: NodeRun) => boolean
}) {
  const { t } = useTranslation()
  // After inline-session grouping, sort the groups themselves by each
  // group's earliest startedAt ascending so the dropdown is strictly
  // chronological. The default order out of groupAttemptsByInlineSession
  // inherits sortNodeRunsForPromptHistory's (iteration, retryIndex,
  // shardKey) ordering, which for fan-out shards is alphabetical by
  // shardKey rather than by time — surprising when a shard that started
  // later sits above one that started first. Groups whose attempts have
  // no startedAt (not yet running) sink to the bottom.
  const groups = useMemo(() => {
    const raw = groupAttemptsByInlineSession(attempts)
    return [...raw].sort((a, b) => groupStartTime(a) - groupStartTime(b))
  }, [attempts])

  // Each Select option's `value` is the LATEST run id in the group. Clicking
  // hands that id to the parent so the backend /session route can unify all
  // rounds of an inline-session group via opencodeSessionId.
  const options = useMemo<SelectOption<string>[]>(
    () =>
      groups.map((g) => {
        const latest = g.attempts[g.attempts.length - 1]!
        const inline = g.attempts.length > 1
        const label = inline
          ? t('nodeDrawer.inlineRoundsLabel', {
              n: g.attempts.length,
              defaultValue: 'inline · {{n}} rounds',
            })
          : iterLabel(latest, t, clarifyRoundForRun(latest, attempts))
        return { value: latest.id, label }
      }),
    [groups, attempts, t],
  )

  // Map the latest-id back to its group for renderOption / renderValue.
  const groupByValue = useMemo(() => {
    const m = new Map<string, AttemptGroup>()
    for (const g of groups) m.set(g.attempts[g.attempts.length - 1]!.id, g)
    return m
  }, [groups])

  // The Select's `value` must match an option (always the latest id in a
  // group). If the externally selected run id is one of the earlier
  // members of an inline group, translate it up to the group's latest.
  const pickedValue = useMemo(() => {
    for (const g of groups) {
      if (g.attempts.some((a) => a.id === pickedId)) {
        return g.attempts[g.attempts.length - 1]!.id
      }
    }
    return pickedId
  }, [groups, pickedId])

  function renderRow(opt: SelectOption<string>): React.ReactNode {
    const g = groupByValue.get(opt.value)
    if (!g) return opt.label
    const latest = g.attempts[g.attempts.length - 1]!
    const inline = g.attempts.length > 1
    return (
      <span className={`session-attempts__row ${inline ? 'is-inline' : ''}`}>
        <span
          className={`session-attempts__dot status-dot--${nodeRunStatusToKind(latest.status)}`}
        />
        <span className="session-attempts__iter">{opt.label}</span>
        {!inline && latest.shardKey !== null && latest.shardKey !== '' && (
          <span className="session-attempts__shard">{latest.shardKey}</span>
        )}
        {!inline && isFanoutParent(latest) && (
          <span className="session-attempts__parent">{t('nodeDrawer.sessionParentBadge')}</span>
        )}
        {latest.startedAt !== null && (
          <span className="session-attempts__time">
            {new Date(latest.startedAt).toLocaleTimeString()}
          </span>
        )}
      </span>
    )
  }

  return (
    <div className="session-attempts">
      <span className="session-attempts__label">{t('nodeDrawer.promptAttemptLabel')}</span>
      <Select<string>
        value={pickedValue}
        options={options}
        onChange={onPick}
        ariaLabel={t('nodeDrawer.promptAttemptLabel')}
        className="session-attempts__select"
        renderOption={renderRow}
        renderValue={renderRow}
      />
    </div>
  )
}

export interface AttemptGroup {
  /** opencode session id when grouped; for legacy/isolated attempts uses the run id as a unique placeholder. */
  sessionId: string
  attempts: NodeRun[]
}

/**
 * Walk attempts (already sorted by sortNodeRunsForPromptHistory) and
 * fuse consecutive entries that share a non-null opencodeSessionId
 * into one chip. Legacy attempts (opencodeSessionId === null) stay as
 * 1-attempt groups so the picker behaves like the pre-merge version
 * for non-inline workflows.
 *
 * Exported for direct unit testing.
 */
export function groupAttemptsByInlineSession(attempts: NodeRun[]): AttemptGroup[] {
  const out: AttemptGroup[] = []
  for (const a of attempts) {
    const sid = a.opencodeSessionId
    if (sid !== null && sid !== '') {
      const last = out[out.length - 1]
      if (last !== undefined && last.sessionId === sid) {
        last.attempts.push(a)
        continue
      }
      out.push({ sessionId: sid, attempts: [a] })
    } else {
      // Singleton — use the run id as the bucket key so duplicate
      // legacy attempts never collide.
      out.push({ sessionId: a.id, attempts: [a] })
    }
  }
  return out
}

/**
 * Earliest `startedAt` within a group, used purely for chronological
 * ordering of the AttemptPicker dropdown. Groups with no started run
 * (everything still pending) return `+Infinity` so they sink to the
 * bottom rather than getting "earlier than every real run" via NaN/0.
 * Exported for direct unit testing.
 */
export function groupStartTime(group: AttemptGroup): number {
  let min = Number.POSITIVE_INFINITY
  for (const a of group.attempts) {
    if (a.startedAt !== null && a.startedAt < min) min = a.startedAt
  }
  return min
}

function iterLabel(a: NodeRun, t: TFunction, clarifyRound = 0): string {
  // RFC-074 PR-C: the clarify round is derived from id-order (clarifyRoundForRun)
  // — the retired clarifyIteration counter is gone. The label covers both self-
  // and cross-clarify reruns.
  if (clarifyRound > 0) return t('nodeDrawer.iterClarify', { n: clarifyRound })
  if (a.reviewIteration > 0) return t('nodeDrawer.iterReview', { n: a.reviewIteration })
  if (a.iteration > 0) return t('nodeDrawer.iterLoop', { n: a.iteration })
  if (a.retryIndex > 0) return t('nodeDrawer.iterRetry', { n: a.retryIndex })
  return t('nodeDrawer.iterInitial')
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
  if (query.isLoading) return <LoadingState size="compact" />
  if (query.error !== null && query.error !== undefined) {
    return <div className="error-box">{t('session.loadError')}</div>
  }
  if (query.data === undefined) return null
  return <ConversationFlow tree={query.data.tree} />
}
