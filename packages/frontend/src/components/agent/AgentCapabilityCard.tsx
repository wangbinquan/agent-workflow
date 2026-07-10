// RFC-166 §4.2 — capability card preview (shared UI primitive). Renders the
// SAME structured projection (`capabilityCardModel`) the backend injects into a
// leader / orchestrator prompt, so the preview can never drift from what the
// model actually sees. Whitelisted fields only (name/description/role/inputs/
// outputs/prompt summary) — the CapabilitySource Pick<> excludes ownerUserId /
// visibility, so no ACL/audit field can leak into this card.
//
// Reuse points (design §4.2): agent detail self-preview, workgroup member
// selection, RFC-167 dynamic-workflow agent pool.

import { useTranslation } from 'react-i18next'
import {
  capabilityCardModel,
  type CapabilityInputPort,
  type CapabilityOutputPort,
  type CapabilitySource,
} from '@agent-workflow/shared'

interface AgentCapabilityCardProps {
  agent: CapabilitySource
  /** Prompt-summary budget; ignored when `compact`. Default 600 (shared). */
  promptBudget?: number
  /** Hide the prompt summary (roster / picker density). */
  compact?: boolean
}

function PortChip({ port }: { port: CapabilityInputPort | CapabilityOutputPort }) {
  const { t } = useTranslation()
  const required = 'required' in port && port.required
  return (
    <span className="capability-card__port">
      <span className="capability-card__port-name">{port.name}</span>
      <span className="capability-card__port-kind">{port.kind}</span>
      {required && (
        <span className="capability-card__port-req">{t('capabilityCard.required')}</span>
      )}
    </span>
  )
}

function PortRow({
  label,
  ports,
}: {
  label: string
  ports: Array<CapabilityInputPort | CapabilityOutputPort>
}) {
  const { t } = useTranslation()
  return (
    <div className="capability-card__ports">
      <span className="capability-card__ports-label">{label}</span>
      {ports.length > 0 ? (
        <span className="capability-card__ports-list">
          {ports.map((p) => (
            <PortChip key={p.name} port={p} />
          ))}
        </span>
      ) : (
        <span className="capability-card__ports-none">{t('capabilityCard.noneDeclared')}</span>
      )}
    </div>
  )
}

export function AgentCapabilityCard({ agent, promptBudget, compact }: AgentCapabilityCardProps) {
  const { t } = useTranslation()
  const model = capabilityCardModel(agent, { promptBudget: compact ? 0 : (promptBudget ?? 600) })
  return (
    <div className="capability-card" data-testid={`capability-card-${model.name}`}>
      <div className="capability-card__head">
        <span className="capability-card__name">{model.name}</span>
        <span className="capability-card__role" data-role={model.role}>
          {model.role}
        </span>
      </div>
      {model.description.length > 0 && <p className="capability-card__desc">{model.description}</p>}
      <PortRow label={t('capabilityCard.inputs')} ports={model.inputs} />
      <PortRow label={t('capabilityCard.outputs')} ports={model.outputs} />
      {model.promptSummary !== null && (
        <p className="capability-card__prompt">
          <span className="capability-card__prompt-label">{t('capabilityCard.prompt')}</span>{' '}
          {model.promptSummary}
        </p>
      )}
    </div>
  )
}
