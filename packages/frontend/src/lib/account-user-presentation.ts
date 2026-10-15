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
  guest: { kind: 'neutral', labelKey: 'users.roleOption.guest' },
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

/** Who manages how an account signs in, as the account and user pages state it. */
export type AccountCredentialManager = 'platform' | 'oidc' | 'local'

/**
 * RFC-370 M0: behind the CrewStation gateway every account signs in with its
 * platform identity — no local password or OIDC link applies — so the pages
 * say so instead of describing a local account.
 */
export function accountCredentialManager(input: {
  readonly gatewayIdentity: boolean
  readonly hasOidcIdentity: boolean
}): AccountCredentialManager {
  if (input.gatewayIdentity) return 'platform'
  return input.hasOidcIdentity ? 'oidc' : 'local'
}

export interface AccountMenuLabel {
  readonly label: string
  readonly secondary:
    | { readonly kind: 'daemon-access' }
    | { readonly kind: 'name'; readonly text: string }
    | null
}

/**
 * The account menu trigger. A real account shows the username it signs in
 * with and its display name below; a daemon actor shows its friendly name.
 * RFC-370 M0: behind the CrewStation gateway the username is synthesized from
 * the platform subject and never typed, so the platform's display name is the
 * label.
 */
export function accountMenuLabel(input: {
  readonly source: 'session' | 'pat' | 'daemon'
  readonly user: Pick<UserPublic, 'username' | 'displayName'>
  readonly gatewayIdentity: boolean
}): AccountMenuLabel {
  if (input.source === 'daemon') {
    return { label: input.user.displayName, secondary: { kind: 'daemon-access' } }
  }
  if (input.gatewayIdentity) return { label: input.user.displayName, secondary: null }
  return {
    label: input.user.username,
    secondary:
      input.user.displayName !== input.user.username
        ? { kind: 'name', text: input.user.displayName }
        : null,
  }
}
