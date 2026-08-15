import {
  PERMISSION_CATALOG,
  PERMISSIONS,
  ROLE_PERMISSIONS,
  additionalPermissionsForRole,
  normalizeAdditionalPermissionsForWrite,
  resolveEffectiveAccountPermissions,
  type Permission,
  type PermissionCatalogEntry,
  type Role,
  type UserAccessPatch,
} from '@agent-workflow/shared'

export type PermissionRowSource = 'baseline' | 'additional' | 'available' | 'intrinsic'

export interface UserPermissionRow {
  readonly kind: 'permission'
  readonly permission: Permission
  readonly entry: PermissionCatalogEntry
  readonly label: string
  readonly description: string
  readonly source: PermissionRowSource
  readonly effective: boolean
  readonly mutable: boolean
}

export interface DerivePermissionRowsInput {
  readonly role: Role
  readonly additionalPermissions: ReadonlyArray<Permission>
  readonly search?: string
  readonly locale: string
  readonly translate: (key: string) => string
}

export interface DerivedPermissionRows {
  readonly permissions: ReadonlyArray<UserPermissionRow>
  readonly effectiveCount: number
  readonly additionalCount: number
}

function searchable(value: string, locale: string): string {
  return value.normalize('NFKC').toLocaleLowerCase(locale)
}

export function derivePermissionRows(input: DerivePermissionRowsInput): DerivedPermissionRows {
  const canonical = normalizeAdditionalPermissionsForWrite(input)
  const additional = new Set(canonical)
  const baseline = new Set(ROLE_PERMISSIONS[input.role])
  const effective = resolveEffectiveAccountPermissions({
    role: input.role,
    additionalPermissions: canonical,
  })
  const needle = searchable(input.search?.trim() ?? '', input.locale)
  const matches = (label: string, description: string, rawId: string): boolean =>
    needle === '' || searchable(`${label}\n${description}\n${rawId}`, input.locale).includes(needle)

  const permissions = PERMISSIONS.map((permission): UserPermissionRow => {
    const entry = PERMISSION_CATALOG[permission]
    const label = input.translate(entry.labelKey)
    const description = input.translate(entry.descriptionKey)
    let source: PermissionRowSource
    if (entry.delegation === 'intrinsic') source = 'intrinsic'
    else if (baseline.has(permission)) source = 'baseline'
    else if (additional.has(permission)) source = 'additional'
    else source = 'available'
    return {
      kind: 'permission',
      permission,
      entry,
      label,
      description,
      source,
      effective: effective.has(permission),
      mutable: source === 'additional' || source === 'available',
    }
  }).filter((row) => matches(row.label, row.description, row.permission))

  return {
    permissions,
    effectiveCount: effective.size,
    additionalCount: canonical.length,
  }
}

export function toggleAdditionalPermission(input: {
  readonly role: Role
  readonly additionalPermissions: ReadonlyArray<Permission>
  readonly permission: Permission
  readonly checked: boolean
}): ReadonlyArray<Permission> {
  const entry = PERMISSION_CATALOG[input.permission]
  if (
    entry.delegation !== 'account-additive' ||
    ROLE_PERMISSIONS[input.role].includes(input.permission)
  ) {
    return normalizeAdditionalPermissionsForWrite(input)
  }
  const selected = new Set(input.additionalPermissions)
  if (input.checked) selected.add(input.permission)
  else selected.delete(input.permission)
  return normalizeAdditionalPermissionsForWrite({
    role: input.role,
    additionalPermissions: [...selected],
  })
}

export function rebaseUserAdditionalPermissions(input: {
  readonly previousRole: Role
  readonly nextRole: Role
  readonly additionalPermissions: ReadonlyArray<Permission>
}): ReadonlyArray<Permission> {
  // Role switches may remove grants that became baseline-redundant, but must
  // never invent grants from the previous preset baseline. In particular,
  // manager → user starts with no manager capabilities selected.
  return additionalPermissionsForRole(input.nextRole, new Set(input.additionalPermissions))
}

export interface UserAccessSnapshot {
  readonly role: Role
  readonly additionalPermissions: ReadonlyArray<Permission>
  readonly accessRevision: number
}

export function diffUserAccess(
  original: UserAccessSnapshot,
  draft: Pick<UserAccessSnapshot, 'role' | 'additionalPermissions'>,
): UserAccessPatch | undefined {
  const canonical = normalizeAdditionalPermissionsForWrite({
    role: draft.role,
    additionalPermissions: draft.additionalPermissions,
  })
  const originalCanonical = normalizeAdditionalPermissionsForWrite({
    role: original.role,
    additionalPermissions: original.additionalPermissions,
  })
  if (
    draft.role === original.role &&
    canonical.length === originalCanonical.length &&
    canonical.every((permission, index) => permission === originalCanonical[index])
  ) {
    return undefined
  }
  return {
    role: draft.role,
    additionalPermissions: [...canonical],
    expectedRevision: original.accessRevision,
  }
}

export interface UserAccessChangeSummary {
  readonly added: ReadonlyArray<Permission>
  readonly removed: ReadonlyArray<Permission>
  readonly addedCritical: ReadonlyArray<Permission>
}

export function summarizeAccessChange(
  before: Pick<UserAccessSnapshot, 'role' | 'additionalPermissions'>,
  after: Pick<UserAccessSnapshot, 'role' | 'additionalPermissions'>,
): UserAccessChangeSummary {
  const beforeEffective = resolveEffectiveAccountPermissions(before)
  const afterEffective = resolveEffectiveAccountPermissions(after)
  const added = PERMISSIONS.filter(
    (permission) => afterEffective.has(permission) && !beforeEffective.has(permission),
  )
  const removed = PERMISSIONS.filter(
    (permission) => beforeEffective.has(permission) && !afterEffective.has(permission),
  )
  return {
    added,
    removed,
    addedCritical: added.filter((permission) => PERMISSION_CATALOG[permission].risk === 'critical'),
  }
}
