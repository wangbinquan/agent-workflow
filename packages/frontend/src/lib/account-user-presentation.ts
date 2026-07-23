import type { UserIdentity, UserPublic } from '@agent-workflow/shared'
import type { StatusChipKind } from '@/components/StatusChip'

export const USER_STATUS_PRESENTATION = {
  active: { kind: 'success', labelKey: 'users.statusOption.active' },
  invited: { kind: 'warn', labelKey: 'users.statusOption.invited' },
  disabled: { kind: 'danger', labelKey: 'users.statusOption.disabled' },
} as const satisfies Record<UserPublic['status'], { kind: StatusChipKind; labelKey: string }>

export const USER_ROLE_PRESENTATION = {
  admin: { kind: 'info', labelKey: 'users.roleOption.admin' },
  // RFC-222 — 资源管理员 (resource admin). Elevated role, shares admin's tone;
  // RFC-221 owns this presentation file and may differentiate later.
  manager: { kind: 'info', labelKey: 'users.roleOption.manager' },
  user: { kind: 'neutral', labelKey: 'users.roleOption.user' },
} as const satisfies Record<UserPublic['role'], { kind: StatusChipKind; labelKey: string }>

export function accountInitials(displayName: string, username: string): string {
  const source = displayName.trim() || username.trim()
  if (source === '') return '?'
  const words = source.split(/\s+/u).filter(Boolean)
  if (words.length > 1) {
    return `${Array.from(words[0]!)[0] ?? ''}${Array.from(words.at(-1)!)[0] ?? ''}`.toUpperCase()
  }
  return Array.from(source).slice(0, 2).join('').toUpperCase()
}

export function isOidcManaged(linkedIdentities: readonly UserIdentity[]): boolean {
  return linkedIdentities.length > 0
}
