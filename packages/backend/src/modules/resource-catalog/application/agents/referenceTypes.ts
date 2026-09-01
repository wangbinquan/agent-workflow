import type { AclResourceType } from '@agent-workflow/shared'

/** One exact Resource Catalog reference group at an application boundary. */
export interface RefCheckGroup {
  readonly type: AclResourceType
  /** Canonical ids, or display names only when `domain` is explicitly `name`. */
  readonly names: readonly string[]
  /** The token domain is mandatory so callers cannot silently treat names as ids. */
  readonly domain: 'id' | 'name'
}

/** Closed result of resolving caller tokens to canonical Resource Catalog ids. */
export interface ResolvedRefsById {
  /** Resolved ids, deduped in first-seen order. */
  readonly ids: string[]
  /** Only input tokens that matched a persisted resource appear in this map. */
  readonly byToken: Map<string, string>
  /** Invisible references, echoing the caller's token rather than row metadata. */
  readonly missing: Array<{ readonly type: AclResourceType; readonly name: string }>
}
