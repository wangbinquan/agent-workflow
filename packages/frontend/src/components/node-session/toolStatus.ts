// flag-audit W0 (§4.6) — single source of truth for session tool-call/message
// status → chip kind + label. Replaces two byte-identical `toneFor` copies plus
// two DRIFTED label fallbacks (ConversationFlow echoed the raw status,
// SubagentBlock silently mapped unknown → "pending") in ConversationFlow.tsx /
// SubagentBlock.tsx. Canonical fallback: neutral chip + raw status echo — an
// unknown upstream status should stay visible, not masquerade as pending.

import type { StatusChipKind } from '@/components/StatusChip'

const TOOL_STATUS_CHIP: Record<string, { kind: StatusChipKind; labelKey: string }> = {
  pending: { kind: 'neutral', labelKey: 'session.statusPending' },
  running: { kind: 'info', labelKey: 'session.statusRunning' },
  completed: { kind: 'success', labelKey: 'session.statusCompleted' },
  error: { kind: 'danger', labelKey: 'session.statusError' },
}

export function toolStatusKind(status: string): StatusChipKind {
  return TOOL_STATUS_CHIP[status]?.kind ?? 'neutral'
}

export function toolStatusLabel(status: string, t: (key: string) => string): string {
  const entry = TOOL_STATUS_CHIP[status]
  return entry !== undefined ? t(entry.labelKey) : status
}
