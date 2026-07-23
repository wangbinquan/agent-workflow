// RFC-168 T2 → RFC-171 — member card rail, the detail page's LEFT column.
// Cards render from the SERVER row (`group`) only — config edits stay pending
// in the panel draft, member changes commit immediately (RFC-164 invariant).
//
// RFC-171: the RFC-168 wide gallery became the narrow left rail of the `.split`
// skin (aligns with /agents). Cards adopt the `.split-card` look (+ the
// `.workgroup-mcard--{type}` accent) but KEEP the RFC-168 stretched hit-area:
// the title is a `.workgroup-card__open` button whose `::after` (absolute
// inset:0) covers the card — this needs a `position:relative` ancestor, now
// `.workgroup-mcard` (F10: never wrap the whole card in a native <button>).
// Per-port name chips (RFC-168, too wide for the narrow rail) collapse to an
// "N ports" count badge; the full port list lives in the panel's capability
// card. roleDesc, type, leader badge and the dangling-agent warning are kept.

import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { Agent, Workgroup } from '@agent-workflow/shared'
import { capabilityCardModel } from '@agent-workflow/shared'
import { EmptyState } from '@/components/EmptyState'
import { StatusChip } from '@/components/StatusChip'
import { useAgentsList } from '@/hooks/useAgentsList'
import { useUserLookup } from '@/hooks/useUserLookup'
import { resourceOptionLabel } from '@/lib/resource-option-label'
import { workgroupToMembersState, type WorkgroupMembersState } from '@/lib/workgroup-form'

export interface WorkgroupMemberGalleryProps {
  group: Workgroup
  /** Route-owned complete draft. Omitted callers retain the server-row view. */
  membersState?: WorkgroupMembersState
  /** Selected member row key (server member id) — highlights the card. */
  selectedKey: string | null
  /** Card activation; the page owns toggle semantics (same key ⇒ close). */
  onSelectCard: (key: string) => void
}

/** RFC-171 — declared-port COUNT badge (inputs + outputs). Renders nothing
 *  when the agent is unresolved or declares none; the full list is in the
 *  panel's capability card. Uses the single `capabilityCardModel` projection. */
function AgentPortsBadge({ agent }: { agent: Agent | undefined }) {
  const { t } = useTranslation()
  if (agent === undefined) return null
  const model = capabilityCardModel(agent, { promptBudget: 0 })
  const count = model.inputs.length + model.outputs.length
  if (count === 0) return null
  return (
    <span className="chip chip--tight" data-testid="workgroup-card-ports-count">
      {t('workgroups.portsCountBadge', { count })}
    </span>
  )
}

export function WorkgroupMemberGallery(props: WorkgroupMemberGalleryProps) {
  const { t } = useTranslation()
  const serverState = useMemo(() => workgroupToMembersState(props.group), [props.group])
  const state = props.membersState ?? serverState
  const showLeaderBadge = props.group.mode === 'leader_worker'
  const users = useUserLookup(
    state.members.map((m) => (m.memberType === 'human' ? m.userId : null)),
  )
  const agentsList = useAgentsList()
  const agentById = useMemo(
    () => new Map(agentsList.agents.map((a) => [a.id, a])),
    [agentsList.agents],
  )
  const owners = useUserLookup(agentsList.agents.map((agent) => agent.ownerUserId))

  if (state.members.length === 0) {
    return (
      <EmptyState
        size="compact"
        title={t('workgroups.membersEmpty')}
        data-testid="workgroup-members-empty"
      />
    )
  }

  return (
    <ul className="workgroup-mrail">
      {state.members.map((m) => {
        const isLeader = state.leaderKey === m.key
        const selected = props.selectedKey === m.key
        const agent = m.memberType === 'agent' ? agentById.get(m.agentId) : undefined
        const reference =
          m.memberType === 'agent'
            ? resourceOptionLabel(
                agent?.name ?? m.agentName,
                owners.get(agent?.ownerUserId)?.displayName ?? agent?.ownerUserId ?? undefined,
              )
            : (users.get(m.userId)?.displayName ?? m.userId)
        return (
          <li key={m.key} data-member-key={m.key}>
            <div
              className={
                `split-card workgroup-mcard workgroup-mcard--${m.memberType}` +
                (selected ? ' is-selected' : '')
              }
              data-testid={`workgroup-card-${m.displayName}`}
            >
              <div className="split-card__title">
                <h3 className="workgroup-mcard__title">
                  <button
                    type="button"
                    className="workgroup-card__open"
                    aria-expanded={selected}
                    aria-controls="workgroup-context-panel"
                    onClick={() => props.onSelectCard(m.key)}
                    data-testid={`workgroup-card-open-${m.displayName}`}
                  >
                    {m.displayName}
                  </button>
                </h3>
              </div>
              <div className="split-card__subtitle" title={reference}>
                {reference}
              </div>
              {m.roleDesc !== '' && <div className="workgroup-mcard__role">{m.roleDesc}</div>}
              <div className="split-card__badges chip-row">
                <span className="chip chip--tight">
                  {m.memberType === 'agent'
                    ? t('workgroups.memberTypeAgent')
                    : t('workgroups.memberTypeHuman')}
                </span>
                {showLeaderBadge && isLeader && (
                  <StatusChip kind="info" size="sm" data-testid="workgroup-leader-badge">
                    {t('workgroups.leaderBadge')}
                  </StatusChip>
                )}
                {m.memberType === 'agent' &&
                  (agent !== undefined ? (
                    <AgentPortsBadge agent={agent} />
                  ) : agentsList.loaded ? (
                    <StatusChip kind="warn" size="sm" data-testid="workgroup-card-agent-missing">
                      {t('workgroups.agentMissing')}
                    </StatusChip>
                  ) : null)}
              </div>
            </div>
          </li>
        )
      })}
    </ul>
  )
}
