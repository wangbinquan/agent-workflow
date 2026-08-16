// RFC-304 §5.2 — the four script contracts the MR monitor runs, as schemas.
//
// The platform defines the SHAPE; the department layer supplies the scripts
// (§3.1 — the platform does not guess at another system's adaptation). All four
// are scripts with no AI anywhere in the chain (constitution R1, locked at the
// source level by the program-stage negative scan): collecting state, sorting
// failures, picking this round's work, and choosing an agent are all decisions a
// program can make, so a program makes them.
//
// ## `noop` is a first-class result, not an error
//
// Most wake-ups have nothing to do — a pipeline going green, an ordinary
// comment, an update with no outstanding items. At 50 active merge requests and
// three such events a day each, that is ~150 healthy wake-ups daily.
//
// The first draft's union had no `noop`, which left an arbitration script two
// options, both wrong: return an empty value (rejected by the schema → the
// round blocks → an alarm storm out of nothing), or disguise it as `mr-review`
// (150 tasks a day, and 150 "no new findings this round" comments on merge
// requests nobody touched). So `noop` is in the union, and it means: create NO
// round, say NOTHING on the merge request, and record one observation so the
// wake-up is still traceable.
//
// ## Why a work package is single-capability
//
// `Round.capability` and `StageContract.capability` are both single-valued. A
// mixed package (one comment fix + one CI fix) has no answer to "which sequence
// does this round run" and no definable push boundary. The discriminated union
// enforces sameness in the schema rather than in a caller's discipline; work of
// two kinds means two rounds.

import { z } from 'zod'

/** Where a collected comment sits, when it is anchored to code. */
export const MonitorAnchorSchema = z
  .object({
    path: z.string().min(1),
    line: z.number().int().positive().optional(),
  })
  .strict()

/**
 * `collect` — the full state of the merge request, as one read.
 *
 * One script rather than several because a monitor decision has to be made
 * against a single consistent snapshot: conflict, comments and gate read at
 * three different moments can describe a merge request that never existed.
 */
export const CollectResultSchema = z
  .object({
    conflict: z.boolean(),
    unresolvedComments: z.array(
      z
        .object({
          threadId: z.string().min(1),
          author: z.string(),
          body: z.string(),
          anchor: MonitorAnchorSchema.optional(),
        })
        .strict(),
    ),
    gate: z
      .object({
        // `unknown` is deliberately distinct from `fail`: a gate that could not
        // be read must not be arbitrated as a failing one, or an outage in the
        // pipeline system turns into a storm of CI-fix rounds.
        status: z.enum(['pass', 'fail', 'running', 'unknown']),
        runId: z.string().optional(),
        rawLogRef: z.string().optional(),
      })
      .strict(),
    /** The revision this snapshot describes; every later decision is about it. */
    headSha: z.string().min(1),
  })
  .strict()

export type CollectResult = z.infer<typeof CollectResultSchema>

/** `classify` — failure logs sorted into actionable items. */
export const ClassifiedIssueSchema = z
  .object({
    type: z.string().min(1),
    file: z.string().optional(),
    line: z.number().int().positive().optional(),
    message: z.string().min(1),
    raw: z.string().optional(),
  })
  .strict()

export const ClassifiedIssuesSchema = z.array(ClassifiedIssueSchema)
export type ClassifiedIssue = z.infer<typeof ClassifiedIssueSchema>

/**
 * `arbitrate` — what this round should do.
 *
 * The union is CLOSED, and each arm was let in when the sequence behind it
 * could actually run: declaring an arm the platform cannot execute would let an
 * arbitration script select work that dies at round start with "no such
 * sequence", which reads to a team as the platform being broken rather than as
 * a capability not yet shipped.
 *
 * The converse cost is just as real and is what a missing arm looks like: the
 * comment-fix sequence shipped complete while this union still refused its
 * name, so selecting it was reported as a malformed arbitration and the
 * capability was unreachable. Nothing was red — a missing arm is
 * indistinguishable from a well-formed refusal. `rfc304-monitor-loop.test.ts`
 * now asserts each shipped capability is selectable, one test per arm.
 */
export const WorkPackageSchema = z.discriminatedUnion('capability', [
  z
    .object({
      capability: z.literal('noop'),
      /** Why there was nothing to do — this is what the observation records. */
      reason: z.string().min(1),
      observedRevision: z.string().min(1),
    })
    .strict(),
  z
    .object({
      capability: z.literal('mr-review'),
      items: z.array(z.never()).max(0),
      note: z.string().optional(),
    })
    .strict(),
  z
    .object({
      capability: z.literal('mr-comment-fix'),
      /**
       * Which threads to answer. Non-empty on purpose: a comment-fix package
       * with no threads would open a round, prepare a worktree and dispatch an
       * agent with nothing to do — an expensive way to write `noop`.
       */
      items: z.array(z.object({ threadId: z.string().min(1) }).strict()).min(1),
      note: z.string().optional(),
    })
    .strict(),
  z
    .object({
      capability: z.literal('ci-fix'),
      /**
       * Which classified failures this round is for. A reference rather than
       * the issue itself: `classify` already produced the detail, and copying
       * it here would let the two disagree about what is being fixed.
       */
      items: z.array(z.object({ issueRef: z.string().min(1) }).strict()).min(1),
      note: z.string().optional(),
    })
    .strict(),
])

export type WorkPackage = z.infer<typeof WorkPackageSchema>

/** `arbitrate` may return several packages, but all of one capability. */
export const WorkPackagesSchema = z.array(WorkPackageSchema)

/** `select` — which agent runs each slot of the chosen sequence. */
export const AgentPlanSchema = z
  .object({
    bySlot: z.record(
      z.string(),
      z
        .object({
          agent: z.string().min(1),
          promptSuffix: z.string().optional(),
        })
        .strict(),
    ),
  })
  .strict()

export type AgentPlan = z.infer<typeof AgentPlanSchema>

/**
 * The default priority, used when a framework's arbitration does not decide.
 *
 * Conflict first because nothing else can land until it is resolved; comments
 * before CI because a human is waiting on the other end of a comment, while a
 * red pipeline is waiting on nobody. Within CI: compile before codecheck before
 * unit-test coverage — a compile failure makes the other two unmeasurable, so
 * fixing them first produces work that has to be redone.
 */
export const DEFAULT_MONITOR_PRIORITY = ['conflict', 'comment', 'ci'] as const
export type MonitorPriorityClass = (typeof DEFAULT_MONITOR_PRIORITY)[number]

export const DEFAULT_CI_PRIORITY = ['compile', 'codecheck', 'unit-test'] as const
export type CiPriorityClass = (typeof DEFAULT_CI_PRIORITY)[number]

/**
 * Rank an issue type against the default CI ordering.
 *
 * Unknown types sort LAST rather than first: a framework that classifies
 * something the platform has no opinion about should not thereby jump the queue
 * ahead of a compile break.
 */
export function ciPriorityRank(issueType: string): number {
  const index = (DEFAULT_CI_PRIORITY as readonly string[]).indexOf(issueType)
  return index === -1 ? DEFAULT_CI_PRIORITY.length : index
}

/**
 * The default arbitration, for a framework that supplies no `arbitrate`.
 *
 * Deliberately conservative: it only ever selects `mr-review` or `noop`,
 * because those are the two arms v1 can execute. A conflict or a failing gate
 * is reported as a `noop` with the reason naming what was seen — the platform
 * says "I noticed, and I have nothing that can act on it" rather than silently
 * doing nothing or pretending a review addresses a broken pipeline.
 */
export function defaultArbitrate(
  collected: CollectResult,
  issues: readonly ClassifiedIssue[],
): WorkPackage[] {
  if (collected.conflict) {
    return [
      {
        capability: 'noop',
        reason:
          'this merge request has a conflict; conflicts are reported, never fixed by the platform',
        observedRevision: collected.headSha,
      },
    ]
  }

  if (collected.unresolvedComments.length > 0) {
    // One package carrying every unresolved thread, so a round answers them
    // together and pushes once (T38). One package per thread would push once
    // per comment and rebuild the branch under the reviewer mid-read.
    return [
      {
        capability: 'mr-comment-fix',
        items: collected.unresolvedComments.map((c) => ({ threadId: c.threadId })),
        note: `${collected.unresolvedComments.length} unresolved comment(s)`,
      },
    ]
  }

  if (collected.gate.status === 'fail') {
    if (issues.length === 0) {
      // Red, and nothing said why. Dispatching an empty `ci-fix` would put an
      // agent in a worktree with no idea what to repair — worse than silence,
      // because it looks like the platform is working on it.
      return [
        {
          capability: 'noop',
          reason:
            'the gate is failing but nothing classified the failure, so there is no actionable item',
          observedRevision: collected.headSha,
        },
      ]
    }

    // Ordered by the same priority the design states: a compile break makes
    // codecheck and unit-test results unmeasurable, so repairing those first
    // produces work that has to be redone. The fix agent reads the list in
    // order, which is why the sort belongs here rather than in the prompt.
    const ordered = [...issues].sort((a, b) => ciPriorityRank(a.type) - ciPriorityRank(b.type))
    return [
      {
        capability: 'ci-fix',
        items: ordered.map((i) => ({ issueRef: issueRefOf(i) })),
        note: `the gate is failing (${ordered[0]!.type})`,
      },
    ]
  }

  // Nothing outstanding. NOT a review: an ordinary wake-up on a healthy merge
  // request is exactly the 150-a-day case `noop` exists for.
  return [
    {
      capability: 'noop',
      reason: 'nothing outstanding on this merge request',
      observedRevision: collected.headSha,
    },
  ]
}

/**
 * How a classified issue is named in a work package.
 *
 * A reference rather than the issue itself: `classify` already produced the
 * detail, and copying it into the package would let the two disagree about what
 * is being repaired. The file is included when there is one because two
 * `compile` failures in different files are two different problems, and a
 * package that called both `compile` would look like one.
 */
function issueRefOf(issue: ClassifiedIssue): string {
  return issue.file === undefined ? issue.type : `${issue.type}:${issue.file}`
}

/**
 * Whether every package in a batch names the same capability.
 *
 * Checked even though the union types each element, because `arbitrate` returns
 * a LIST: `[{noop}, {mr-review}]` type-checks perfectly and has no answer to
 * "which sequence does this round run".
 */
export function isSingleCapabilityBatch(packages: readonly WorkPackage[]): boolean {
  if (packages.length <= 1) return true
  const first = packages[0]!.capability
  return packages.every((p) => p.capability === first)
}
