// flag-audit W0 (§4.6 / §3-6) — single source of truth for ClarifyRoundStatus →
// chip kind + label key. Replaces two inline ternaries in routes/clarify.tsx
// whose self-row branch tested only `status !== 'awaiting_human'` and therefore
// rendered a CANCELED self round as a green "已回答" chip (the enum also carries
// 'canceled' for kind=self and 'abandoned' for kind=cross — see
// shared/schemas/clarify.ts ClarifyRoundStatusSchema).

import type { ClarifyRoundStatus } from '@agent-workflow/shared'
import type { StatusChipKind } from '@/components/StatusChip'

export const CLARIFY_ROUND_STATUS_CHIP: Record<
  ClarifyRoundStatus,
  { kind: StatusChipKind; labelKey: string }
> = {
  awaiting_human: { kind: 'warn', labelKey: 'clarify.list.statusAwaiting' },
  answered: { kind: 'success', labelKey: 'clarify.list.statusAnswered' },
  canceled: { kind: 'neutral', labelKey: 'clarify.list.statusCanceled' },
  abandoned: { kind: 'danger', labelKey: 'crossClarify.abandonedChip' },
}

export function clarifyRoundStatusChip(status: ClarifyRoundStatus): {
  kind: StatusChipKind
  labelKey: string
} {
  return CLARIFY_ROUND_STATUS_CHIP[status]
}
