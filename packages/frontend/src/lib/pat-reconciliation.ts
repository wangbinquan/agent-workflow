// RFC-250 T8-T10 — crash/reload receipt for non-idempotent PAT creation.
//
// The raw token must never enter browser storage.  This marker contains only
// the request fields that are already visible on the token inventory plus the
// ids visible before POST.  It cannot prove which token was created; it only
// narrows the inventory candidates and, most importantly, prevents a blind
// retry after a response was lost.

import {
  PatPurposeSchema,
  PermissionSchema,
  type PatPublic,
  type PatPurpose,
  type Permission,
} from '@agent-workflow/shared'

export const PAT_RECONCILIATION_STORAGE_KEY_PREFIX =
  'agent-workflow:pat-create-reconciliation:v1:' as const

const MARKER_SCHEMA_VERSION = 1 as const
const MAX_MARKER_BYTES = 64 * 1024

export interface PatReconciliationMarkerV1 {
  schemaVersion: typeof MARKER_SCHEMA_VERSION
  actorId: string
  startedAt: number
  name: string
  purpose: PatPurpose
  scopes: Permission[]
  expiresAt: number | null
  visiblePatIds: string[]
}

export type PatReconciliationMarkerRead =
  | { kind: 'none' }
  | { kind: 'valid'; marker: PatReconciliationMarkerV1 }
  | { kind: 'invalid' }
  | { kind: 'unavailable'; error: unknown }

export class PatReconciliationStorageError extends Error {
  constructor(
    readonly operation: 'read' | 'write' | 'clear',
    options?: { cause?: unknown },
  ) {
    super('PAT reconciliation storage is unavailable', options)
    this.name = 'PatReconciliationStorageError'
  }
}

function browserStorage(storage?: Storage): Storage {
  if (storage !== undefined) return storage
  try {
    return window.sessionStorage
  } catch (error) {
    throw new PatReconciliationStorageError('read', { cause: error })
  }
}

function sortedScopes(scopes: Iterable<Permission>): Permission[] {
  return [...new Set(scopes)].sort()
}

export function createPatReconciliationMarker(input: {
  actorId: string
  startedAt: number
  name: string
  purpose: PatPurpose
  scopes: Iterable<Permission>
  expiresAt: number | null
  visiblePats: readonly Pick<PatPublic, 'id'>[]
}): PatReconciliationMarkerV1 {
  return {
    schemaVersion: MARKER_SCHEMA_VERSION,
    actorId: input.actorId,
    startedAt: input.startedAt,
    name: input.name.trim(),
    purpose: input.purpose,
    scopes: sortedScopes(input.scopes),
    expiresAt: input.expiresAt,
    visiblePatIds: [...new Set(input.visiblePats.map((pat) => pat.id))].sort(),
  }
}

function parseMarker(raw: string): PatReconciliationMarkerV1 | null {
  if (new TextEncoder().encode(raw).length > MAX_MARKER_BYTES) return null
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  if (row.schemaVersion !== MARKER_SCHEMA_VERSION) return null
  if (typeof row.actorId !== 'string' || row.actorId === '') return null
  if (!Number.isFinite(row.startedAt) || (row.startedAt as number) < 0) return null
  if (typeof row.name !== 'string' || row.name.trim() === '' || row.name.length > 128) return null
  const purpose = PatPurposeSchema.safeParse(row.purpose)
  if (!purpose.success || !Array.isArray(row.scopes)) return null
  const scopes: Permission[] = []
  for (const candidate of row.scopes) {
    const parsed = PermissionSchema.safeParse(candidate)
    if (!parsed.success) return null
    scopes.push(parsed.data)
  }
  if (row.expiresAt !== null && (!Number.isFinite(row.expiresAt) || (row.expiresAt as number) < 0))
    return null
  if (!Array.isArray(row.visiblePatIds) || row.visiblePatIds.some((id) => typeof id !== 'string'))
    return null

  return {
    schemaVersion: MARKER_SCHEMA_VERSION,
    actorId: row.actorId,
    startedAt: row.startedAt as number,
    name: row.name.trim(),
    purpose: purpose.data,
    scopes: sortedScopes(scopes),
    expiresAt: row.expiresAt as number | null,
    visiblePatIds: [...new Set(row.visiblePatIds as string[])].sort(),
  }
}

export function patReconciliationStorageKey(actorId: string): string {
  return `${PAT_RECONCILIATION_STORAGE_KEY_PREFIX}${encodeURIComponent(actorId)}`
}

export function readPatReconciliationMarker(
  actorId: string,
  storage?: Storage,
): PatReconciliationMarkerRead {
  let target: Storage
  try {
    target = browserStorage(storage)
    const raw = target.getItem(patReconciliationStorageKey(actorId))
    if (raw === null) return { kind: 'none' }
    const marker = parseMarker(raw)
    return marker === null || marker.actorId !== actorId
      ? { kind: 'invalid' }
      : { kind: 'valid', marker }
  } catch (error) {
    return { kind: 'unavailable', error }
  }
}

export function writePatReconciliationMarker(
  marker: PatReconciliationMarkerV1,
  storage?: Storage,
): void {
  try {
    browserStorage(storage).setItem(
      patReconciliationStorageKey(marker.actorId),
      JSON.stringify(marker),
    )
  } catch (error) {
    throw new PatReconciliationStorageError('write', { cause: error })
  }
}

export function clearPatReconciliationMarker(actorId: string, storage?: Storage): boolean {
  try {
    browserStorage(storage).removeItem(patReconciliationStorageKey(actorId))
    return true
  } catch {
    return false
  }
}

/** Logout boundary: remove every actor-scoped non-secret PAT recovery receipt. */
export function clearAllPatReconciliationMarkers(storage?: Storage): boolean {
  try {
    const target = browserStorage(storage)
    const keys: string[] = []
    for (let index = 0; index < target.length; index += 1) {
      const key = target.key(index)
      if (key?.startsWith(PAT_RECONCILIATION_STORAGE_KEY_PREFIX) === true) keys.push(key)
    }
    for (const key of keys) target.removeItem(key)
    return true
  } catch {
    return false
  }
}

function sameScopes(left: readonly Permission[], right: readonly Permission[]): boolean {
  const a = sortedScopes(left)
  const b = sortedScopes(right)
  return a.length === b.length && a.every((scope, index) => scope === b[index])
}

export function findPatReconciliationCandidates(
  marker: PatReconciliationMarkerV1,
  inventory: readonly PatPublic[],
): PatPublic[] {
  const visible = new Set(marker.visiblePatIds)
  return inventory
    .filter(
      (pat) =>
        !visible.has(pat.id) &&
        pat.createdAt >= marker.startedAt &&
        pat.name === marker.name &&
        pat.purpose === marker.purpose &&
        pat.expiresAt === marker.expiresAt &&
        sameScopes(pat.scopes, marker.scopes),
    )
    .sort((a, b) => {
      const distance =
        Math.abs(a.createdAt - marker.startedAt) - Math.abs(b.createdAt - marker.startedAt)
      return distance === 0 ? a.id.localeCompare(b.id) : distance
    })
}
