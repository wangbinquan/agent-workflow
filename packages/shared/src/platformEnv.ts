// RFC-254 T2 (D12) — environment-variable name comparison, platform-aware.
//
// WHY THIS EXISTS
// ---------------
// Windows process environment blocks are CASE-INSENSITIVE: `Path`, `PATH` and
// `path` are one variable. Every allow-list, deny-list, reserved-key table and
// `delete env[k]` in this repo was written with exact string comparison, which
// on Windows is not merely "unportable" — it is a change of SECURITY meaning:
//
//   - an allow-list that only knows `PATH` silently DROPS the real `Path` the
//     OS handed us, so the child starts with no search path at all;
//   - a deny-list that only knows `NODE_OPTIONS` silently ADMITS
//     `Node_Options`, which loads arbitrary code before the first line of the
//     program it is supposed to be guarding.
//
// The direction of the failure differs per table, so there is no safe default
// other than folding the name once, in one place, and having every table go
// through it.
//
// The one prior art in this repo did it right: `shared/scriptNode.ts` compares
// reserved script env keys with `key.toUpperCase()`. This generalises that.

/**
 * Platform discriminator. Spelled locally rather than as `NodeJS.Platform`
 * because this package is shared with the browser bundle and must not pull in
 * Node's ambient types; `process.platform` assigns to it structurally.
 */
export type EnvPlatform = 'win32' | (string & {})

/**
 * The comparison key for an environment-variable name.
 *
 * Windows folds case; POSIX does not. Upper-casing (rather than lower) matches
 * the existing `scriptNode.ts` convention and the conventional spelling of
 * environment variables, so folded keys stay readable in diagnostics.
 */
export function canonicalEnvKey(key: string, platform: EnvPlatform): string {
  return platform === 'win32' ? key.toUpperCase() : key
}

/** Does `names` contain `key`, under this platform's comparison rule? */
export function envNameMatches(
  names: Iterable<string>,
  key: string,
  platform: EnvPlatform,
): boolean {
  const folded = canonicalEnvKey(key, platform)
  for (const name of names) {
    if (canonicalEnvKey(name, platform) === folded) return true
  }
  return false
}

/**
 * Remove every variable whose name matches one of `names`, and return a NEW
 * record.
 *
 * `delete env.FOO` is the idiom this replaces, and it is exactly the shape that
 * fails silently on Windows: the property key must match byte-for-byte, so a
 * variable the OS spelled `Foo` survives a deletion that was meant to remove
 * it. Returning a new object rather than mutating keeps the caller honest
 * about when the removal happened.
 */
export function envRecordDelete(
  env: Readonly<Record<string, string | undefined>>,
  names: Iterable<string>,
  platform: EnvPlatform,
): Record<string, string | undefined> {
  const drop = new Set<string>()
  for (const name of names) drop.add(canonicalEnvKey(name, platform))
  const out: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(env)) {
    if (drop.has(canonicalEnvKey(key, platform))) continue
    out[key] = value
  }
  return out
}

/**
 * Look a variable up under this platform's comparison rule, returning the
 * FIRST match in insertion order.
 *
 * Insertion order matters on Windows: a block that somehow carries both `Path`
 * and `PATH` is malformed, and picking deterministically (rather than by
 * whichever spelling the caller guessed) makes the behaviour reproducible.
 */
export function envRecordGet(
  env: Readonly<Record<string, string | undefined>>,
  key: string,
  platform: EnvPlatform,
): string | undefined {
  const folded = canonicalEnvKey(key, platform)
  for (const [name, value] of Object.entries(env)) {
    if (canonicalEnvKey(name, platform) === folded) return value
  }
  return undefined
}
