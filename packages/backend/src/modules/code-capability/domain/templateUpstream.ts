// RFC-304 §11.6 (T64) — a copied template's relationship to what it came from.
//
// Copying is how teams start (T57), so within a quarter there are dozens of
// templates descended from a handful of originals. Then the original gets a fix
// — a classifier pattern that was wrong — and nobody downstream finds out.
//
// The failure is quiet in both directions:
//
//   without a link, an upstream fix never reaches the copies, and the same bug
//   is re-reported by five teams who each debug it separately;
//
//   with a link but no LOCAL-EDIT tracking, "update from upstream" silently
//   discards the local changes that were the entire reason for copying.
//
// So a copy records three things: where it came from, which upstream version it
// was taken from, and a digest of that version. Those three are exactly what is
// needed to tell the four states apart — and none of them can be reconstructed
// later, which is why they are written at copy time rather than derived.

export interface UpstreamLink {
  /** The template this was copied from. */
  upstreamId: string
  /** The upstream's `updatedAt` at the moment of copying. */
  upstreamVersion: number
  /** Digest of the upstream body as it was copied. */
  baseDigest: string
}

export type UpstreamState =
  /** Same as upstream, or upstream has not moved since. */
  | 'current'
  /** Upstream moved; this copy has no local edits, so it can fast-forward. */
  | 'update-available'
  /** Upstream moved AND this copy was edited. A merge decision is needed. */
  | 'conflicted'
  /** The upstream is gone. */
  | 'orphaned'

export interface UpstreamStatus {
  state: UpstreamState
  /** One line a reader can act on. */
  message: string
  /** Fields edited locally since the copy — empty unless edited. */
  localOverrides: readonly string[]
}

export interface UpstreamInput {
  link: UpstreamLink
  /** Null when the upstream row no longer exists. */
  upstreamVersionNow: number | null
  /** Digest of this copy's body right now. */
  localDigest: string
  /** Which fields differ from the copied base. */
  localOverrides: readonly string[]
}

/**
 * Which of the four states a copy is in.
 *
 * `orphaned` is checked FIRST and unconditionally: once the upstream is gone,
 * "is there an update" has no meaning, and reporting `current` for a template
 * whose origin was deleted would be the most misleading of the four — it says
 * "nothing to do" about a link that can never be followed again.
 */
export function judgeUpstream(input: UpstreamInput): UpstreamStatus {
  if (input.upstreamVersionNow === null) {
    return {
      state: 'orphaned',
      message: 'the template this was copied from no longer exists; this copy is now independent',
      localOverrides: input.localOverrides,
    }
  }

  const upstreamMoved = input.upstreamVersionNow > input.link.upstreamVersion
  const editedLocally = input.localOverrides.length > 0

  if (!upstreamMoved) {
    // Local edits without an upstream change are NOT a state of their own. The
    // copy is doing exactly what a copy is for, and flagging it would put a
    // permanent badge on every template anyone customised.
    return {
      state: 'current',
      message: editedLocally
        ? 'up to date with upstream; your local changes are intact'
        : 'up to date with upstream',
      localOverrides: input.localOverrides,
    }
  }

  if (!editedLocally) {
    return {
      state: 'update-available',
      message: 'upstream has changed and this copy has no local edits — it can be updated cleanly',
      localOverrides: [],
    }
  }

  return {
    state: 'conflicted',
    message: `upstream has changed and ${String(input.localOverrides.length)} field(s) were edited here — choose what to keep`,
    localOverrides: input.localOverrides,
  }
}

export interface ThreeWayField {
  field: string
  /** The value at copy time. */
  base: unknown
  /** The value upstream has now. */
  upstream: unknown
  /** The value here now. */
  local: unknown
}

export type FieldResolution =
  /** Nobody changed it. */
  | { field: string; action: 'unchanged' }
  /** Only upstream changed it — safe to take. */
  | { field: string; action: 'take-upstream'; value: unknown }
  /** Only this copy changed it — keep it. */
  | { field: string; action: 'keep-local'; value: unknown }
  /** Both changed it, differently. A person decides. */
  | { field: string; action: 'conflict'; upstream: unknown; local: unknown }

/**
 * The three-way diff, per field.
 *
 * The BASE is what makes this possible, and it is the reason `baseDigest` and
 * the copied values are recorded at copy time. Without a base, "upstream says A,
 * local says B" cannot distinguish "upstream changed it" from "local changed
 * it" — and a two-way merge has to guess, which means it is wrong half the time
 * on exactly the fields somebody cared enough to edit.
 */
export function resolveThreeWay(fields: readonly ThreeWayField[]): FieldResolution[] {
  return fields.map((f): FieldResolution => {
    const upstreamChanged = !deepEqual(f.base, f.upstream)
    const localChanged = !deepEqual(f.base, f.local)

    if (!upstreamChanged && !localChanged) return { field: f.field, action: 'unchanged' }
    if (upstreamChanged && !localChanged) {
      return { field: f.field, action: 'take-upstream', value: f.upstream }
    }
    if (!upstreamChanged && localChanged) {
      return { field: f.field, action: 'keep-local', value: f.local }
    }
    // Both moved. Converging to the same value is not a conflict — a team that
    // independently made the same fix should not be asked to adjudicate it.
    if (deepEqual(f.upstream, f.local)) return { field: f.field, action: 'unchanged' }
    return { field: f.field, action: 'conflict', upstream: f.upstream, local: f.local }
  })
}

/**
 * "Merge only the fields I have not overridden" — the safe default action.
 *
 * Takes every `take-upstream`, keeps every `keep-local`, and leaves genuine
 * conflicts untouched rather than picking a side. A merge that silently chose
 * upstream on a conflict would discard the local change that was the reason for
 * copying; choosing local would make "update from upstream" do nothing on
 * precisely the fields the fix was about.
 */
export function mergeUnoverridden(resolutions: readonly FieldResolution[]): {
  applied: readonly string[]
  keptLocal: readonly string[]
  stillConflicted: readonly string[]
} {
  return {
    applied: resolutions.filter((r) => r.action === 'take-upstream').map((r) => r.field),
    keptLocal: resolutions.filter((r) => r.action === 'keep-local').map((r) => r.field),
    stillConflicted: resolutions.filter((r) => r.action === 'conflict').map((r) => r.field),
  }
}

/**
 * What a config package carries about a copy's origin.
 *
 * `detached` is the honest answer on an instance that has never seen the
 * upstream: the package records where the template came from, and a different
 * instance cannot resolve that id. Reporting `current` there would claim a
 * relationship the destination cannot check.
 */
export function packagedUpstreamState(input: {
  link: UpstreamLink | null
  upstreamResolvableHere: boolean
}): 'detached' | 'linked' | 'none' {
  if (input.link === null) return 'none'
  return input.upstreamResolvableHere ? 'linked' : 'detached'
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (a === null || b === null) return false
  if (typeof a !== 'object') return false
  // Canonical JSON comparison: these are template fields — scripts, param
  // tables, slot maps — which are plain data. Key ORDER must not count as a
  // change, or a round trip through JSON would manufacture a conflict on a
  // field nobody touched.
  return canonical(a) === canonical(b)
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>).sort(([x], [y]) =>
    x < y ? -1 : x > y ? 1 : 0,
  )
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
}
