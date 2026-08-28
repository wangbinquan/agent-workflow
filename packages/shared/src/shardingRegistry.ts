// RFC-060 PR-A — shard-key extraction registry.
//
// When wrapper-fanout consumes a `list<T>` port as its shardSource, each
// item in the list becomes one shard. The shard's key (shardKey field in
// node_runs) is derived from the item by a per-`list<T>` `keyOf` function
// registered here.
//
// Default behavior (no registration): 0-based index ('0', '1', '2', …).
// Predictable but opaque — fine for `list<string>` where items have no
// canonical identity.
//
// Path-family registration: `list<path<*>>` family uses the path itself
// as the shardKey. This makes shard names match what users see in their
// worktree (e.g. shard `docs/intro.md` instead of shard `3`).
//
// The registry is **string-keyed by the stringified item kind** so list<T>
// values look up `T`'s keyOf via `stringifyKind(item)`. This means
// `list<path<md>>` and `list<path<markdown>>` will both consult the
// `path<md>` / `path<markdown>` registrations respectively; the
// catch-all `path<*>` registration is consulted as a fallback when a
// specific ext is not registered.
//
// 现状（RFC-317 T66 按源码订正）：**已接入 runtime**——
// `task-execution/engine/wrapper/fanoutStrategy.ts` 在 mint 分片前按 item
// 调用 `resolveKeyOf` 取 shardKey。原注释停在「PR-A scope … Not yet wired into scheduler (PR-D)」，
// 那是一份**施工期路线图**被留在了完工的代码里：读者据此会以为这个注册表还是
// 死的，从而在别处另起一套 shardKey 计算。分阶段注释的失效期就是它描述的那个
// PR 合并的那一刻——写的时候就该写成「PR-D 之后请删掉本段」。

import type { ParsedKind } from './kindParser'
import { stringifyKind } from './kindParser'

export type KeyOfFn = (item: string, idx: number, itemKind: ParsedKind) => string

const REGISTRY = new Map<string, KeyOfFn>()

/**
 * Register a `keyOf` function for an item kind. Item kinds register
 * **without** the wrapping `list<...>` — sharding registry indexes by the
 * inner kind only. Examples:
 *
 *   register(parseKind('path<*>'), (item) => item)
 *   register(parseKind('path<md>'), (item) => item)
 *
 * Idempotent: registering the same item kind twice overwrites the
 * previous value. Tests reset by calling `clearShardingRegistry()`.
 */
export function registerKeyOf(itemKind: ParsedKind, keyOf: KeyOfFn): void {
  REGISTRY.set(stringifyKind(itemKind), keyOf)
}

/**
 * Look up a KeyOfFn for the given item kind. If the exact item kind
 * isn't registered, falls back to:
 *   1. path<*> registration when itemKind.kind === 'path' with a more
 *      specific ext (so path<md> falls back to path<*> registration).
 *   2. 0-based index as the final default.
 */
export function resolveKeyOf(itemKind: ParsedKind): KeyOfFn {
  const exact = REGISTRY.get(stringifyKind(itemKind))
  if (exact !== undefined) return exact
  if (itemKind.kind === 'path' && itemKind.ext !== '*') {
    const wildcard = REGISTRY.get('path<*>')
    if (wildcard !== undefined) return wildcard
  }
  return defaultIndexKeyOf
}

/**
 * Reset the registry to its initial set. Tests use this to avoid cross-
 * test pollution; production code should never call it.
 */
export function clearShardingRegistry(): void {
  REGISTRY.clear()
  installDefaults()
}

const defaultIndexKeyOf: KeyOfFn = (_item, idx) => String(idx)

// -----------------------------------------------------------------------------
// Default registrations: path-family uses the path itself as shardKey.
// -----------------------------------------------------------------------------
function installDefaults(): void {
  // path<*> catches any extension; used as fallback for unregistered ext.
  REGISTRY.set('path<*>', (item) => item.trim())
  // path<md> / path<markdown>: same path-as-key behavior, but registered
  // explicitly so a future "extract slug" override could replace them
  // without touching the wildcard.
  REGISTRY.set('path<md>', (item) => item.trim())
  REGISTRY.set('path<markdown>', (item) => item.trim())
}

installDefaults()
