// RFC-168 T2 — member card gallery, the detail page's MAIN zone. Cards render
// from the SERVER row (`group`) only — config edits stay pending in the panel
// draft, member changes commit immediately (RFC-164 invariant kept).
//
// Selection: the card title is the button (stretched hit-area via CSS ::after
// — design §5 rejected wrapping the whole Card in a <button>: h3/div/p inside
// a native button violates the content model and bloats the accessible name).
// All member ACTIONS live in the context panel; the card face carries only
// identity + capability summary (ports from the RFC-166 capabilityCardModel
// projection — the single structured projection, never a hand-rolled one).

import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { Agent, Workgroup } from '@agent-workflow/shared'
import { capabilityCardModel } from '@agent-workflow/shared'
import { Card } from '@/components/Card'
import { EmptyState } from '@/components/EmptyState'
import { StatusChip } from '@/components/StatusChip'
import { useAgentsList } from '@/hooks/useAgentsList'
import { useUserLookup } from '@/hooks/useUserLookup'
import { workgroupToMembersState } from '@/lib/workgroup-form'

export interface WorkgroupMemberGalleryProps {
  group: Workgroup
  /** Selected member row key (server member id) — highlights the card. */
  selectedKey: string | null
  /** Card activation; the page owns toggle semantics (same key ⇒ close). */
  onSelectCard: (key: string) => void
}

/** Port-name summary line: up to 3 names then `+n` (full list lives in the
 *  panel's capability card). Renders nothing when the agent declares none. */
function PortsRow({ label, names }: { label: string; names: string[] }) {
  if (names.length === 0) return null
  const shown = names.slice(0, 3)
  const more = names.length - shown.length
  return (
    <div className="workgroup-card__ports">
      <span className="workgroup-card__ports-label">{label}</span>
      {shown.map((n) => (
        <span key={n} className="capability-card__port">
          <span className="capability-card__port-name">{n}</span>
        </span>
      ))}
      {more > 0 && <span className="workgroup-card__ports-more">+{more}</span>}
    </div>
  )
}

function AgentCardSummary({
  agent,
  agentsLoaded,
}: {
  agent: Agent | undefined
  agentsLoaded: boolean
}) {
  const { t } = useTranslation()
  if (agent === undefined) {
    // Dangling references are save-legal (launch-time validation owns
    // existence) — warn only once the list actually loaded (F6: while the
    // agents query is loading/failed the summary degrades to nothing).
    return agentsLoaded ? (
      <StatusChip kind="warn" size="sm" data-testid="workgroup-card-agent-missing">
        {t('workgroups.agentMissing')}
      </StatusChip>
    ) : null
  }
  const model = capabilityCardModel(agent, { promptBudget: 0 })
  return (
    <>
      <PortsRow label={t('workgroups.portsIn')} names={model.inputs.map((p) => p.name)} />
      <PortsRow label={t('workgroups.portsOut')} names={model.outputs.map((p) => p.name)} />
    </>
  )
}

export function WorkgroupMemberGallery(props: WorkgroupMemberGalleryProps) {
  const { t } = useTranslation()
  const state = useMemo(() => workgroupToMembersState(props.group), [props.group])
  const showLeaderBadge = props.group.mode === 'leader_worker'
  const users = useUserLookup(
    state.members.map((m) => (m.memberType === 'human' ? m.userId : null)),
  )
  const agentsList = useAgentsList()
  const agentByName = useMemo(
    () => new Map(agentsList.agents.map((a) => [a.name, a])),
    [agentsList.agents],
  )

  return (
    <div className="workgroup-gallery">
      {state.members.length === 0 && (
        <EmptyState
          size="compact"
          title={t('workgroups.membersEmpty')}
          data-testid="workgroup-members-empty"
        />
      )}

      {state.members.length > 0 && (
        <ul className="workgroup-cards">
          {state.members.map((m) => {
            const isLeader = state.leaderKey === m.key
            const selected = props.selectedKey === m.key
            const reference =
              m.memberType === 'agent'
                ? m.agentName
                : (users.get(m.userId)?.displayName ?? m.userId)
            return (
              <li key={m.key} data-member-key={m.key}>
                <Card
                  className={`workgroup-card workgroup-card--${m.memberType}`}
                  interactive
                  highlighted={selected}
                  data-testid={`workgroup-card-${m.displayName}`}
                  header={
                    <div className="workgroup-card__head">
                      <h3 className="workgroup-card__title">
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
                    </div>
                  }
                >
                  <div className="workgroup-card__ref" title={reference}>
                    {reference}
                  </div>
                  {m.roleDesc !== '' && <p className="workgroup-card__role">{m.roleDesc}</p>}
                  {m.memberType === 'agent' && (
                    <AgentCardSummary
                      agent={agentByName.get(m.agentName)}
                      agentsLoaded={agentsList.loaded}
                    />
                  )}
                </Card>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
