// RFC-046: collapsible "Injected memories (N)" card shown at the top of
// the SessionTab. Surfaces the post-budget-clip snapshot the runner
// persisted to node_runs.injected_memories_json so admins can confirm
// which approved memories the model actually saw in this attempt.

import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { InjectedMemorySnapshot, NodeRun } from '@agent-workflow/shared'
import { isAgentNodeKind } from '@agent-workflow/shared'
import {
  SCOPE_ORDER,
  decideStatus,
  findFirstAttemptSibling,
  groupByScope,
  isFollowupInherit,
  previewOf,
} from '@/lib/injected-memories-card'

interface Props {
  /** The active attempt being shown by SessionTab. */
  run: NodeRun
  /** All runs for the parent node, used to find the retry_index=0 sibling for the followup-inherit chip. */
  attempts: readonly NodeRun[]
  /** Workflow node kind (agent-single / agent-multi / wrapper / ...). */
  workflowNodeKind: string | null
}

export function InjectedMemoriesCard({ run, attempts, workflowNodeKind }: Props) {
  const { t } = useTranslation()

  // Hooks MUST run unconditionally per the rules-of-hooks lint; the
  // non-agent-kind early return below the hook block is the gate that
  // keeps the card from rendering on input/wrapper/review/clarify nodes.
  const list = run.injectedMemories ?? null
  const attempt0 = useMemo(() => findFirstAttemptSibling(run, attempts), [run, attempts])
  const groups = useMemo(() => groupByScope(list ?? []), [list])

  // Non-agent kinds (input / output / wrapper / review / clarify) never
  // call the runner inject path; rendering an empty card there would be
  // misleading. The component returns null so the SessionTab DOM stays
  // identical to pre-RFC-046 for those nodes.
  if (!isAgentNodeKind(workflowNodeKind)) return null

  const status = decideStatus(list)
  const followupInherit = isFollowupInherit(run, attempt0)
  const labelN = status === 'pre-rfc046' ? '—' : String(list?.length ?? 0)

  return (
    <details className="injected-memories-card">
      <summary className="injected-memories-card__summary">
        <span className="injected-memories-card__title">
          {t('nodeDrawer.injectedMemoriesTitle', { n: labelN })}
        </span>
        {followupInherit && (
          <span className="injected-memories-card__inherit" title={attempt0?.id ?? ''}>
            {t('nodeDrawer.injectedMemoriesInheritedFromAttempt0')}
          </span>
        )}
        {status === 'captured' && (
          <span className="injected-memories-card__chips">
            {SCOPE_ORDER.map((scope) => {
              const n = groups[scope].length
              if (n === 0) return null
              return (
                <span key={scope} className="injected-memories-card__chip">
                  {t(
                    `nodeDrawer.injectedMemoriesGroup_${scope}` as
                      | 'nodeDrawer.injectedMemoriesGroup_agent'
                      | 'nodeDrawer.injectedMemoriesGroup_workflow'
                      | 'nodeDrawer.injectedMemoriesGroup_repo'
                      | 'nodeDrawer.injectedMemoriesGroup_global',
                  )}
                  ·{n}
                </span>
              )
            })}
          </span>
        )}
      </summary>
      <div className="injected-memories-card__body">
        {status === 'pre-rfc046' && (
          <div className="inventory-section__missing">
            {t('nodeDrawer.injectedMemoriesNotCaptured')}
          </div>
        )}
        {status === 'empty' && (
          <div className="inventory-section__missing">{t('nodeDrawer.injectedMemoriesEmpty')}</div>
        )}
        {status === 'captured' && (
          <div className="injected-memories-card__groups">
            {SCOPE_ORDER.map((scope) => {
              const rows = groups[scope]
              if (rows.length === 0) return null
              return (
                <section
                  key={scope}
                  className={`injected-memories-card__group injected-memories-card__group--${scope}`}
                >
                  <h4 className="injected-memories-card__group-title">
                    {t(
                      `nodeDrawer.injectedMemoriesGroup_${scope}` as
                        | 'nodeDrawer.injectedMemoriesGroup_agent'
                        | 'nodeDrawer.injectedMemoriesGroup_workflow'
                        | 'nodeDrawer.injectedMemoriesGroup_repo'
                        | 'nodeDrawer.injectedMemoriesGroup_global',
                    )}
                    <span className="injected-memories-card__group-count">{rows.length}</span>
                  </h4>
                  <ul className="injected-memories-card__list">
                    {rows.map((m) => (
                      <MemoryEntry key={m.id} memory={m} />
                    ))}
                  </ul>
                </section>
              )
            })}
          </div>
        )}
      </div>
    </details>
  )
}

function MemoryEntry({ memory }: { memory: InjectedMemorySnapshot }) {
  const { t } = useTranslation()
  return (
    <li className="injected-memory-row">
      <details>
        <summary className="injected-memory-row__summary">
          <span
            className={`injected-memory-row__scope injected-memory-row__scope--${memory.scopeType}`}
          >
            {t(`memory.scope.${memory.scopeType}`, { defaultValue: memory.scopeType })}
            {memory.scopeId !== null && memory.scopeId !== '' && (
              <span className="injected-memory-row__scope-id">{memory.scopeId}</span>
            )}
          </span>
          <span className="injected-memory-row__title">{memory.title}</span>
          <span className="injected-memory-row__version">
            {t('nodeDrawer.injectedMemoriesVersionLabel', { n: memory.version })}
          </span>
          {memory.tags.length > 0 && (
            <span className="injected-memory-row__tags">
              {memory.tags.map((tag) => (
                <span key={tag} className="injected-memory-row__tag">
                  {tag}
                </span>
              ))}
            </span>
          )}
          <span className="injected-memory-row__preview muted">{previewOf(memory.bodyMd)}</span>
        </summary>
        <pre className="injected-memory-row__body">{memory.bodyMd}</pre>
      </details>
    </li>
  )
}
