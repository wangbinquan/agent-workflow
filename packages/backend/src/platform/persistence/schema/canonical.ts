import { sha256Hex } from '@/util/hash'

/**
 * Canonical fragments of objects that do not change while a cache is active, by the
 * indentation they were written at. Replaying the PostgreSQL history digests ~30
 * versions of a contract whose tables are shared by reference between versions;
 * reusing their fragments keeps the replay off the event loop (RFC-349 evidence
 * 38613687770) and the daemon boot short. Output is byte-identical to the plain
 * path (rfc349-canonical-fragment-cache).
 */
export interface CanonicalFragmentCache {
  readonly fragments: WeakMap<object, Map<string, string>>
  readonly keyOrders: Map<string, readonly string[]>
}

let activeFragments: CanonicalFragmentCache | null = null

export function createCanonicalFragmentCache(): CanonicalFragmentCache {
  return { fragments: new WeakMap(), keyOrders: new Map() }
}

/**
 * Runs `work` with the cache active. Only for synchronous work over values nobody
 * mutates until the cache is dropped; the previous cache is restored afterwards.
 */
export function withCanonicalFragmentCache<T>(cache: CanonicalFragmentCache, work: () => T): T {
  const previous = activeFragments
  activeFragments = cache
  try {
    return work()
  } finally {
    activeFragments = previous
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    )
  }
  return value
}

export function canonicalSchemaJson(value: unknown): string {
  if (activeFragments !== null) return `${cachedCanonicalJson(value, '', activeFragments)}\n`
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`
}

function canonicalKeyOrder(record: object, cache: CanonicalFragmentCache): readonly string[] {
  const keys = Object.keys(record)
  const signature = JSON.stringify(keys)
  let order = cache.keyOrders.get(signature)
  if (order === undefined) {
    // The order JSON.stringify sees on the object canonicalize rebuilds: sorted keys,
    // except that array-index keys ("2", "10") always enumerate first, ascending.
    const sorted = [...keys].sort((a, b) => a.localeCompare(b))
    order = Object.keys(Object.fromEntries(sorted.map((key) => [key, true])))
    cache.keyOrders.set(signature, order)
  }
  return order
}

/** `JSON.stringify(canonicalize(value), null, 2)` for a value written at `indent`. */
function cachedCanonicalJson(
  value: unknown,
  indent: string,
  cache: CanonicalFragmentCache,
): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  const known = cache.fragments.get(value)?.get(indent)
  if (known !== undefined) return known
  let text: string
  const inner = `${indent}  `
  if (Array.isArray(value)) {
    const items: string[] = []
    for (let index = 0; index < value.length; index += 1) {
      const item: unknown = value[index]
      items.push(
        item === undefined || typeof item === 'function' || typeof item === 'symbol'
          ? 'null'
          : cachedCanonicalJson(item, inner, cache),
      )
    }
    text = items.length === 0 ? '[]' : `[\n${inner}${items.join(`,\n${inner}`)}\n${indent}]`
  } else {
    const record = value as Record<string, unknown>
    if (typeof record['toJSON'] === 'function') {
      // JSON.stringify would call it; keep that exact behaviour on the plain path.
      text = JSON.stringify(canonicalize(value), null, 2).replaceAll('\n', `\n${indent}`)
    } else {
      const members: string[] = []
      for (const key of canonicalKeyOrder(record, cache)) {
        const entry = record[key]
        if (entry === undefined || typeof entry === 'function' || typeof entry === 'symbol') {
          continue
        }
        members.push(`${JSON.stringify(key)}: ${cachedCanonicalJson(entry, inner, cache)}`)
      }
      text = members.length === 0 ? '{}' : `{\n${inner}${members.join(`,\n${inner}`)}\n${indent}}`
    }
  }
  const byIndent = cache.fragments.get(value) ?? new Map<string, string>()
  byIndent.set(indent, text)
  cache.fragments.set(value, byIndent)
  return text
}

export function digestSchemaContract(value: unknown): string {
  return `sha256:${sha256Hex(canonicalSchemaJson(value))}`
}
