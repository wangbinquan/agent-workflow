// RFC-304 §11.5 (T63) — publishing a department framework is a production
// deploy to every repository at once.
//
// 200 repositories share one `classify`/`arbitrate`. Break it and that day's
// ~150 executions are affected immediately. But the dangerous failure is NOT
// the script crashing:
//
//   a crash fails in a block, loudly, and somebody notices within the hour.
//   `exit 0` with a WRONG CLASSIFICATION emits no failure signal at all — the
//   rounds all "succeed", and the first evidence is a developer complaining a
//   working day later that the reviews have gone strange.
//
// The per-round snapshot does not help: it protects the round already running,
// not the next one. So a framework becomes an immutable revision with a release
// lifecycle, and the gates are placed where they can catch a silent-wrong
// change rather than only a loud one.

export const RELEASE_STATES = [
  /** Being edited. Only its author's pinned bindings can reach it. */
  'draft',
  /** Replayed against fixed samples and matched them. */
  'validated',
  /** Live on a small number of repositories, being watched. */
  'canary',
  /** The channel default. */
  'published',
  /** Superseded; still resolvable for anything pinned to it. */
  'retired',
] as const
export type ReleaseState = (typeof RELEASE_STATES)[number]

/**
 * Which transitions exist.
 *
 * `draft → published` is deliberately absent, and it is the whole point: the
 * validation replay and the canary are the only two things standing between an
 * `exit 0`-but-wrong script and every repository. A "publish now" shortcut
 * would be used exactly when someone is in a hurry, which is when they are most
 * likely to be shipping the silent kind of mistake.
 */
const TRANSITIONS: Readonly<Record<ReleaseState, readonly ReleaseState[]>> = {
  draft: ['validated'],
  // Back to draft is allowed: validation failing is ordinary, and the author
  // needs somewhere to go that is not "retired".
  validated: ['canary', 'draft'],
  canary: ['published', 'draft'],
  // Retiring is how a published revision steps aside for its successor.
  published: ['retired'],
  // Terminal. A retired revision is still RESOLVABLE — bindings pinned to it
  // keep working — but it never becomes current again; re-publishing means
  // cutting a new revision, so the history stays a straight line.
  retired: [],
}

export interface TransitionVerdict {
  allowed: boolean
  reason: string
}

export function judgeTransition(from: ReleaseState, to: ReleaseState): TransitionVerdict {
  if (TRANSITIONS[from].includes(to)) {
    return { allowed: true, reason: `${from} → ${to}` }
  }
  if (from === 'draft' && to === 'published') {
    return {
      allowed: false,
      reason:
        'a draft cannot be published directly — the sample replay and the canary are the only ' +
        'checks between a script that exits 0 with wrong output and every repository',
    }
  }
  return { allowed: false, reason: `${from} → ${to} is not a transition this lifecycle has` }
}

/** How a binding chooses which revision it runs. */
export type RevisionSelector =
  /** Exactly this revision, forever, whatever is published. */
  | { kind: 'pinned'; revision: number }
  /** Whatever is currently published on this channel. */
  | { kind: 'channel'; channel: 'stable' | 'canary' }

export interface ResolveInput {
  selector: RevisionSelector
  publishedRevision: number | null
  canaryRevision: number | null
  /** Revisions that still exist, including retired ones. */
  knownRevisions: readonly number[]
}

export type ResolvedRevision =
  | { ok: true; revision: number; source: 'pinned' | 'channel' }
  | { ok: false; reason: string }

/**
 * Which revision a binding runs right now.
 *
 * A pin to a RETIRED revision still resolves — that is what pinning is for, and
 * silently upgrading somebody who deliberately pinned would defeat the only
 * mechanism they have for staying put. A pin to a revision that never existed
 * (or was hard-deleted) fails loudly instead of falling back to published:
 * quietly running something other than what the binding names is how a team
 * ends up debugging a framework they are not using.
 */
export function resolveRevision(input: ResolveInput): ResolvedRevision {
  if (input.selector.kind === 'pinned') {
    const { revision } = input.selector
    if (!input.knownRevisions.includes(revision)) {
      return {
        ok: false,
        reason: `this binding pins revision ${String(revision)}, which no longer exists`,
      }
    }
    return { ok: true, revision, source: 'pinned' }
  }

  const wanted =
    input.selector.channel === 'canary' ? input.canaryRevision : input.publishedRevision
  if (wanted === null) {
    return {
      ok: false,
      reason: `no revision is published on the ${input.selector.channel} channel`,
    }
  }
  return { ok: true, revision: wanted, source: 'channel' }
}

export interface ReplaySample {
  name: string
  /** What the script is given. */
  input: unknown
  /** What a correct script returns for it. */
  expected: unknown
}

export interface ReplayResult {
  sample: string
  matched: boolean
  /** What it actually produced, when it differed. */
  actual?: unknown
}

export interface ValidationVerdict {
  passed: boolean
  /** Samples that did not match — the reason to refuse the promotion. */
  mismatches: readonly ReplayResult[]
  message: string
}

/**
 * Whether a revision may leave `draft`.
 *
 * Requires at least one sample, and that is not pedantry: an empty sample set
 * passes vacuously, which would turn the gate that exists to catch silent-wrong
 * scripts into a rubber stamp — and it would do so most often for a brand-new
 * framework, which is the least-tested kind.
 */
export function judgeValidation(results: readonly ReplayResult[]): ValidationVerdict {
  if (results.length === 0) {
    return {
      passed: false,
      mismatches: [],
      message:
        'no replay samples ran; an empty sample set passes vacuously and would make this gate a formality',
    }
  }
  const mismatches = results.filter((r) => !r.matched)
  if (mismatches.length === 0) {
    return {
      passed: true,
      mismatches: [],
      message: `all ${String(results.length)} samples matched`,
    }
  }
  return {
    passed: false,
    mismatches,
    message: `${String(mismatches.length)} of ${String(results.length)} samples did not match: ${mismatches
      .map((m) => m.sample)
      .join(', ')}`,
  }
}

/**
 * The canary failure rate above which promotion stops.
 *
 * Low, because the canary's job is to catch a change that is wrong rather than
 * broken, and "wrong" shows up as a modest excess of failures rather than a
 * cliff. A threshold set where a crash would trip it would sail straight past
 * the failure mode this whole lifecycle exists for.
 */
export const CANARY_FAILURE_THRESHOLD = 0.1

export interface CanaryVerdict {
  action: 'promote' | 'hold' | 'roll-back'
  message: string
}

/**
 * What to do with a canary that has run.
 *
 * `hold` rather than `promote` on a small sample: two rounds both passing says
 * almost nothing, and promoting on it converts the canary into a delay with no
 * information. The minimum is stated in the message so nobody reads a hold as a
 * failure.
 */
export function judgeCanary(input: {
  rounds: number
  failures: number
  minimumRounds?: number
}): CanaryVerdict {
  const minimum = input.minimumRounds ?? 10
  if (input.rounds < minimum) {
    return {
      action: 'hold',
      message: `only ${String(input.rounds)} of ${String(minimum)} canary rounds so far — not enough to conclude anything`,
    }
  }
  const rate = input.failures / input.rounds
  if (rate > CANARY_FAILURE_THRESHOLD) {
    return {
      action: 'roll-back',
      message: `${String(input.failures)} of ${String(input.rounds)} canary rounds failed (${(rate * 100).toFixed(0)}%), above the ${(CANARY_FAILURE_THRESHOLD * 100).toFixed(0)}% threshold`,
    }
  }
  return {
    action: 'promote',
    message: `${String(input.rounds)} canary rounds, ${String(input.failures)} failed — within threshold`,
  }
}

/**
 * The sentence shown before publishing: how many repositories this will change.
 *
 * The number is the point. "Publish?" invites yes; "publish to 187
 * repositories?" is a different question, and it is the one the author is
 * actually answering.
 */
export function describeBlastRadius(repoCount: number): string {
  if (repoCount === 0) return 'No repository follows this channel yet.'
  return repoCount === 1
    ? 'This takes effect on 1 repository immediately.'
    : `This takes effect on ${String(repoCount)} repositories immediately.`
}
