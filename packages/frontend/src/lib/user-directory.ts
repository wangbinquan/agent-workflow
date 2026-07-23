import type { AdminUserView, CreateUserBody, PatchUserBody, Role } from '@agent-workflow/shared'

export type UserStatusFilter = 'all' | 'active' | 'invited' | 'disabled'
export type UserRoleFilter = 'all' | Role

export interface UsersSearch extends Record<string, unknown> {
  q?: string
  status?: Exclude<UserStatusFilter, 'all'>
  role?: Exclude<UserRoleFilter, 'all'>
}

export interface UserDirectoryFilters {
  q: string
  status: UserStatusFilter
  role: UserRoleFilter
}

export interface UserDirectoryModel {
  humans: AdminUserView[]
  system: AdminUserView | null
  visible: AdminUserView[]
  counts: {
    total: number
    admin: number
    invited: number
    disabled: number
    byStatus: Record<'active' | 'invited' | 'disabled', number>
  }
  emptyKind: 'none' | 'initial' | 'filtered'
}

export type CreateUserMode = 'password' | 'sso'

export interface CreateUserDraft {
  username: string
  displayName: string
  email: string
  role: Role
  mode: CreateUserMode
  password: string
}

export interface EditUserDraft {
  displayName: string
  email: string
  role: Role
}

const STATUS_FILTERS = new Set<UserStatusFilter>(['all', 'active', 'invited', 'disabled'])
const ROLE_FILTERS = new Set<UserRoleFilter>(['all', 'admin', 'manager', 'user'])

function isStatusFilter(value: unknown): value is UserStatusFilter {
  return typeof value === 'string' && STATUS_FILTERS.has(value as UserStatusFilter)
}

function isRoleFilter(value: unknown): value is UserRoleFilter {
  return typeof value === 'string' && ROLE_FILTERS.has(value as UserRoleFilter)
}

/** Validate only /users-owned keys while preserving adjacent route state. */
export function validateUsersSearch(raw: Record<string, unknown>): UsersSearch {
  const { q: _q, status: _status, role: _role, ...adjacent } = raw
  const q = typeof raw.q === 'string' ? raw.q.trim() : ''
  return {
    ...adjacent,
    ...(q === '' ? {} : { q }),
    ...(isStatusFilter(raw.status) && raw.status !== 'all' ? { status: raw.status } : {}),
    ...(isRoleFilter(raw.role) && raw.role !== 'all' ? { role: raw.role } : {}),
  }
}

export function filtersFromUsersSearch(search: UsersSearch): UserDirectoryFilters {
  return {
    q: typeof search.q === 'string' ? search.q : '',
    status: isStatusFilter(search.status) ? search.status : 'all',
    role: isRoleFilter(search.role) ? search.role : 'all',
  }
}

/** Replace /users-owned keys without erasing unrelated search params. */
export function withUsersSearch<T extends Record<string, unknown>>(
  previous: T,
  next: UsersSearch,
): T & UsersSearch {
  const { q: _q, status: _status, role: _role, ...adjacent } = previous
  return { ...adjacent, ...validateUsersSearch(next) } as T & UsersSearch
}

export function searchFromUserFilters(filters: UserDirectoryFilters): UsersSearch {
  return validateUsersSearch({
    q: filters.q,
    status: filters.status,
    role: filters.role,
  })
}

function normalize(value: string, locale: string): string {
  return value.normalize('NFKC').toLocaleLowerCase(locale)
}

export function deriveUserDirectory(
  rows: readonly AdminUserView[],
  filters: UserDirectoryFilters,
  locale: string,
): UserDirectoryModel {
  const system = rows.find((row) => row.id === '__system__') ?? null
  const humans = rows.filter((row) => row.id !== '__system__')
  const byStatus = {
    active: humans.filter((row) => row.status === 'active').length,
    invited: humans.filter((row) => row.status === 'invited').length,
    disabled: humans.filter((row) => row.status === 'disabled').length,
  }
  const needle = normalize(filters.q.trim(), locale)
  const collator = new Intl.Collator(locale, { numeric: true, sensitivity: 'base' })
  const visible = humans
    .filter((row) => filters.status === 'all' || row.status === filters.status)
    .filter((row) => filters.role === 'all' || row.role === filters.role)
    .filter((row) => {
      if (needle === '') return true
      return normalize(`${row.displayName}\n${row.username}\n${row.email ?? ''}`, locale).includes(
        needle,
      )
    })
    .slice()
    .sort(
      (left, right) =>
        collator.compare(left.displayName, right.displayName) ||
        collator.compare(left.username, right.username) ||
        collator.compare(left.id, right.id),
    )

  return {
    humans,
    system,
    visible,
    counts: {
      total: humans.length,
      admin: humans.filter((row) => row.role === 'admin').length,
      invited: byStatus.invited,
      disabled: byStatus.disabled,
      byStatus,
    },
    emptyKind: humans.length === 0 ? 'initial' : visible.length === 0 ? 'filtered' : 'none',
  }
}

export function serializeCreateUser(draft: CreateUserDraft): CreateUserBody {
  const email = draft.email.trim().toLocaleLowerCase()
  const base: CreateUserBody = {
    username: draft.username.trim(),
    displayName: draft.displayName.trim(),
    role: draft.role,
    ...(email === '' ? {} : { email }),
  }
  if (draft.mode === 'password') return { ...base, password: draft.password }
  return base
}

export function editDraftForUser(user: AdminUserView): EditUserDraft {
  return {
    displayName: user.displayName,
    email: user.email ?? '',
    role: user.role,
  }
}

/** Return only dirty editable keys so a stale dialog cannot overwrite fields it never changed. */
export function diffUserPatch(original: AdminUserView, draft: EditUserDraft): PatchUserBody {
  const displayName = draft.displayName.trim()
  const email = draft.email.trim().toLocaleLowerCase() || null
  const patch: PatchUserBody = {}
  if (displayName !== original.displayName) patch.displayName = displayName
  if (email !== original.email) patch.email = email
  if (draft.role !== original.role) patch.role = draft.role
  return patch
}
