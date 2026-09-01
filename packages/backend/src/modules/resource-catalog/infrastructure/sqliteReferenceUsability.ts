// RFC-345 T9 — resource-catalog-owned reference usability adapter.
//
// The Workgroup aggregate used to reach back into the legacy
// services/resourceRefs implementation for three agent-id checks. Keep that
// compatibility service for the successor-owned callers, but let the bounded
// context compose its own SQLite adapter from its ACL repositories.

import type { AclResourceType } from '@agent-workflow/shared'
import type { DbClient } from '@/db/client'
import type { DbTxSync } from '@/db/txSync'
import { ValidationError } from '@/util/errors'
import {
  hasResourceAclBypass,
  isVisibleRow,
  type ResourceAclActorProjection,
} from '../domain/resourceAccess'
import {
  listAclResourceIdentityRowsByIds,
  listAclResourceIdentityRowsByIdsInTx,
} from './sqliteAclReadRepository'
import { listGrantedResourceIds, listGrantedResourceIdsInTx } from './sqliteResourceGrantRepository'

export interface ResolvedResourceIds {
  readonly ids: string[]
  readonly missing: Array<{ readonly type: AclResourceType; readonly name: string }>
}

export async function resolveResourceIdsUsableById(
  db: DbClient,
  actor: ResourceAclActorProjection | null,
  type: AclResourceType,
  tokens: readonly string[],
  options: { readonly grandfatheredIds?: ReadonlySet<string> } = {},
): Promise<ResolvedResourceIds> {
  if (tokens.length === 0) return { ids: [], missing: [] }
  const uniqueTokens = [...new Set(tokens)]
  const rows = await listAclResourceIdentityRowsByIds(db, type, uniqueTokens)
  const byId = new Map(rows.map((row) => [row.id, row]))
  const enforce = actor !== null && !hasResourceAclBypass(actor)
  const granted = enforce ? await listGrantedResourceIds(db, actor, type) : new Set<string>()
  const grandfathered = options.grandfatheredIds ?? new Set<string>()
  const missing: Array<{ readonly type: AclResourceType; readonly name: string }> = []
  const ids: string[] = []
  const seen = new Set<string>()
  for (const token of tokens) {
    const row = byId.get(token)
    const id = row?.id ?? token
    if (
      enforce &&
      row !== undefined &&
      !grandfathered.has(id) &&
      !isVisibleRow(actor, row, granted)
    ) {
      missing.push({ type, name: token })
    }
    if (!seen.has(id)) {
      seen.add(id)
      ids.push(id)
    }
  }
  return { ids, missing }
}

export function assertResourceIdsUsableInTx(
  tx: DbTxSync,
  actor: ResourceAclActorProjection | null,
  type: AclResourceType,
  ids: readonly string[],
): void {
  const refs = [...new Set(ids)].filter((id) => id.length > 0)
  if (refs.length === 0) return
  const rows = listAclResourceIdentityRowsByIdsInTx(tx, type, refs)
  const byId = new Map(rows.map((row) => [row.id, row]))
  const enforcingActor = actor !== null && !hasResourceAclBypass(actor) ? actor : null
  const granted =
    enforcingActor === null
      ? new Set<string>()
      : listGrantedResourceIdsInTx(tx, enforcingActor, type)
  const missing = refs.filter((id) => {
    const row = byId.get(id)
    return (
      row === undefined || (enforcingActor !== null && !isVisibleRow(enforcingActor, row, granted))
    )
  })
  assertNoMissingResourceRefs(missing.map((name) => ({ type, name })))
}

export function assertNoMissingResourceRefs(
  missing: ReadonlyArray<{ readonly type: AclResourceType; readonly name: string }>,
): void {
  if (missing.length === 0) return
  throw new ValidationError(
    'acl-missing-refs',
    `you do not have access to: ${missing.map((item) => `${item.type} '${item.name}'`).join(', ')}`,
    { missing: [...missing] },
  )
}
