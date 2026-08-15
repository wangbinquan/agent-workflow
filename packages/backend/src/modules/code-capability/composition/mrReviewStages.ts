// RFC-304 §6.1 — `mr-review` as the stage engine runs it: one registered
// implementation per contract stage.
//
// ## Why this is per-stage rather than one function
//
// It would be less code to run the whole chain inside a single stage, and it
// would pass the same tests. It would also silently delete the hook mechanism:
// the engine fires `pre`/`post` at each stage BOUNDARY, so a sequence collapsed
// into one stage has exactly one boundary and a team's injection and blocking
// points quietly stop existing. Nothing would report that — the round would run
// green with hooks that never fire.
//
// So each stage here reads the artifacts the contract says it `requires` and
// returns the ones it `produces`. That contract is validated at author time
// (`checkBuiltinContracts`), which means a stage reaching for an artifact
// nothing upstream produces is caught before it becomes an empty value three
// stages later.
//
// ## What a stage may assume
//
// Only its declared `requires`. Reading an artifact the contract does not list
// works today and breaks the moment someone reorders the sequence — the failure
// then surfaces as a wrong review rather than as a missing input.

import { fetchDiff } from '@/modules/code-capability/application/fetchDiff'
import { prepareWorktree } from '@/modules/code-capability/application/prepareWorktree'
import {
  publishReview,
  type PlacedFinding,
  type PublishedFinding,
  type UnplacedFinding,
} from '@/modules/code-capability/application/publishReview'
import { runReviewStage } from '@/modules/code-capability/application/reviewStage'
import type {
  StageArtifacts,
  StageResult,
  StageRunContext,
} from '@/modules/code-capability/application/stageEngine'
import type {
  AiCaller,
  AttemptRecorder,
  RetryBudget,
} from '@/modules/code-capability/application/determinismGuard'
import { hunkDigestFor, resolveAnchoredLine } from '@/modules/code-capability/domain/anchorLine'
import type { DiffHunk } from '@/modules/code-capability/domain/anchorResolve'
import { applyGate, type GateConfig } from '@/modules/code-capability/domain/findingGate'
import {
  planSettleStale,
  reconcileFindings,
  type ReconcileAction,
} from '@/modules/code-capability/domain/findingReconcile'
import type { DiffOmission } from '@/modules/code-capability/domain/mrDiffNormalize'
import {
  apiProjectAddress,
  resolveTarget,
  type RoundTarget,
} from '@/modules/code-capability/domain/resolveTarget'
import {
  fingerprintFor,
  renderFindingComment,
  renderOverviewPrelude,
} from '@/modules/code-capability/domain/reviewComment'
import type { ReviewFinding } from '@/modules/code-capability/domain/reviewEnvelope'
import type { GitlabDiffRefs } from '@/modules/code-capability/domain/reviewPosition'
import type { LedgerAnchor } from '@/modules/code-capability/infrastructure/sqliteFindingLedger'
import type { CodeHostPort } from '@/modules/code-capability/ports/codeHostPort'
import type { FindingLedgerPort } from '@/modules/code-capability/ports/findingLedgerPort'
import type { GitPort } from '@/modules/code-capability/ports/gitPort'
import type { WebhookTriggerFields } from '@agent-workflow/shared'

/** Everything one round needs that is NOT produced by a stage. */
export interface MrReviewEnvironment {
  /**
   * Persists one row per AI call (`code_ai_attempts`).
   *
   * Optional so the stage maps stay constructible without a database in unit
   * tests, but production always supplies it: without it, a round that was
   * retried three times is indistinguishable from one that succeeded first try,
   * and "why did this cost four model calls" has no answer at all.
   */
  attemptRecorder?: AttemptRecorder
  codeHost: CodeHostPort
  /**
   * Cross-round findings history.
   *
   * Optional for the same reason `attemptRecorder` is — the stage maps stay
   * constructible without a database — but a round without it republishes its
   * whole review on every push, so production always supplies it.
   */
  ledger?: FindingLedgerPort
  git: GitPort
  webhook: WebhookTriggerFields
  codeHostEndpointId: string
  repoPath: string
  worktreePath: string
  /** Injected: this module must not reach the scheduler (AC-10 negative scan). */
  makeCaller: (prompt: string) => AiCaller
  protocolBlock: string
  nonce: string
  budget: RetryBudget
  gate: GateConfig
}

/**
 * What a settled thread is told, on hosts that cannot resolve it.
 *
 * Deliberately says the finding stopped appearing rather than that it was
 * fixed: the review cannot tell the difference between a fix, a rewrite that
 * moved the code, and a deleted file, and claiming credit for a fix that did
 * not happen is worse than saying nothing.
 */
const STALE_NOTE =
  'This finding no longer appears in the latest revision under review, so it is being closed out. If it is still relevant, reply here and it will be picked up again.'

const fail = (error: string): StageResult => ({ status: 'failed', error })
const done = (produced: StageArtifacts): StageResult => ({ status: 'done', produced })

/**
 * Read an artifact a stage declared in `requires`.
 *
 * Throws rather than returning undefined: the contract was validated at author
 * time, so a missing required artifact is an engine or registration bug, and
 * continuing with `undefined` would turn it into a wrong review instead of a
 * loud failure.
 */
function required<T>(artifacts: StageArtifacts, name: string): T {
  const value = artifacts[name]
  if (value === undefined) {
    throw new Error(`stage artifact '${name}' is missing though the contract requires it`)
  }
  return value as T
}

interface MrMeta {
  diffRefs?: GitlabDiffRefs
  title: string | null
}

interface DiffArtifact {
  unifiedDiff: string
  hunks: readonly DiffHunk[]
  omitted: ReadonlyArray<{ path: string; omission: DiffOmission }>
}

interface GatedArtifact {
  findings: readonly ReviewFinding[]
  truncated: number
  belowThreshold: number
  diffClipped: boolean
}

interface PlacementsArtifact {
  placed: PlacedFinding[]
  unplaced: UnplacedFinding[]
}

/**
 * What reconcile decided, split the way the later stages consume it.
 *
 * `actions` is kept alongside the split lists because `settle-stale` and
 * `ledger` need the reason for each decision (which generation, which thread),
 * not just the partition.
 */
interface ReconciledArtifact {
  actions: readonly ReconcileAction[]
  /** Only what should actually be posted this round. */
  toPublish: PlacementsArtifact
  /** Present again this round; the thread stays open and is not reposted. */
  keeps: ReadonlyArray<{ fingerprint: string; anchorLine: number | null }>
  /** Generation to record per fingerprint being published. */
  generations: Readonly<Record<string, number>>
}

interface SettledArtifact {
  resolved: number
  noted: number
  skipped: number
  /** Named so a round that could not settle is visible rather than silent. */
  failures: ReadonlyArray<{ fingerprint: string; message: string }>
}

/** The ledger anchor for this round — the MR, never the work item (§6). */
function anchorOf(target: RoundTarget, codeHostEndpointId: string): LedgerAnchor {
  return {
    codeHostEndpointId,
    stableProjectId: target.stableProjectId,
    anchorKind: target.anchorKind,
    anchorId: target.anchorId,
  }
}

/**
 * Read the MR body for the fields publishing needs.
 *
 * GitLab rejects an inline position without `diff_refs`, and the diff endpoint
 * does not return them — so this is a separate read, and its absence is named
 * HERE rather than left to fail once per comment later.
 */
async function readMr(
  codeHost: CodeHostPort,
  target: RoundTarget,
): Promise<{ ok: true; meta: MrMeta } | { ok: false; error: string }> {
  const project = apiProjectAddress(target)
  if (!project.ok) return { ok: false, error: project.message }

  const result = await codeHost.call({
    action: 'mr.get',
    params: { project: project.value, mr: target.anchorId },
  })
  if (!result.ok) return { ok: false, error: `${result.code}: ${result.message}` }

  let body: unknown
  try {
    body = JSON.parse(result.body)
  } catch {
    return { ok: false, error: 'the code host returned a merge request body that is not JSON' }
  }
  const record = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}
  const title = typeof record.title === 'string' ? record.title : target.meta.title

  if (target.provider !== 'gitlab') return { ok: true, meta: { title } }

  const refs =
    typeof record.diff_refs === 'object' && record.diff_refs !== null
      ? (record.diff_refs as Record<string, unknown>)
      : null
  const baseSha = typeof refs?.base_sha === 'string' ? refs.base_sha : ''
  const startSha = typeof refs?.start_sha === 'string' ? refs.start_sha : ''
  const headSha = typeof refs?.head_sha === 'string' ? refs.head_sha : ''
  if (baseSha === '' || startSha === '' || headSha === '') {
    return {
      ok: false,
      error: 'the merge request did not report diff_refs (base/start/head sha)',
    }
  }
  return { ok: true, meta: { diffRefs: { baseSha, startSha, headSha }, title } }
}

/**
 * The `program` stage implementations, keyed by contract stage name.
 *
 * Registered into `createCodeCapabilityRunner`'s `programStages`, which is what
 * makes the engine able to run them — an unregistered name fails loudly rather
 * than being skipped (the behaviour this RFC exists to guarantee).
 */
export function mrReviewProgramStages(
  env: MrReviewEnvironment,
): Readonly<Record<string, (ctx: StageRunContext) => Promise<StageResult>>> {
  return {
    'resolve-target': async () => {
      const resolved = resolveTarget(env.webhook, env.codeHostEndpointId)
      return resolved.ok ? done({ target: resolved.target }) : fail(resolved.message)
    },

    'prepare-worktree': async (ctx) => {
      const target = required<RoundTarget>(ctx.artifacts, 'target')
      const result = await prepareWorktree({
        git: env.git,
        repoPath: env.repoPath,
        worktreePath: env.worktreePath,
        target,
      })
      if (result.state === 'ready') return done({ worktree: env.worktreePath })
      if (result.state === 'stale') {
        // Not an ordinary failure: the round is superseded, and the caller
        // re-arms the work item at the newer sha rather than dropping it. The
        // sha travels in the message because that is what re-arming needs.
        return fail(
          `stale-head: the MR moved to ${result.fetchedSha} before this round could read it`,
        )
      }
      return fail(result.message)
    },

    'fetch-diff': async (ctx) => {
      const target = required<RoundTarget>(ctx.artifacts, 'target')
      const mr = await readMr(env.codeHost, target)
      if (!mr.ok) return fail(mr.error)

      const diff = await fetchDiff({ codeHost: env.codeHost, target })
      if (!diff.ok) return fail(diff.message)

      return done({
        diff: {
          unifiedDiff: diff.unifiedDiff,
          hunks: diff.hunks,
          omitted: diff.omitted,
        } satisfies DiffArtifact,
        mrMeta: mr.meta,
      })
    },

    gate: async (ctx) => {
      const findings = required<{ findings: readonly ReviewFinding[]; diffClipped: boolean }>(
        ctx.artifacts,
        'findings',
      )
      const result = applyGate<ReviewFinding>(findings.findings, env.gate)
      return done({
        gated: {
          findings: result.published,
          truncated: result.truncated,
          belowThreshold: result.belowThreshold,
          diffClipped: findings.diffClipped,
        } satisfies GatedArtifact,
      })
    },

    'resolve-positions': async (ctx) => {
      const gated = required<GatedArtifact>(ctx.artifacts, 'gated')
      const diff = required<DiffArtifact>(ctx.artifacts, 'diff')

      const placed: PlacedFinding[] = []
      const unplaced: UnplacedFinding[] = []
      for (const finding of gated.findings) {
        const location = { file: finding.file, line: finding.line, side: finding.side }
        const anchor = resolveAnchoredLine(location, diff.hunks)
        // The hunk's TEXT, so the identity survives a rebase that shifts line
        // numbers without touching the code.
        const fingerprint = fingerprintFor(finding, hunkDigestFor(location, diff.hunks))
        const body = renderFindingComment(finding, fingerprint)
        const label = `${finding.file}:${finding.line}`
        if (anchor === null) {
          // AC-3/AC-4: not a validation failure and not a retry — the remark may
          // be perfectly correct, it just cannot be attached.
          unplaced.push({
            body,
            label,
            reason: 'this line is not part of the diff under review',
            fingerprint,
          })
          continue
        }
        placed.push({ body, anchor, label, fingerprint })
      }
      return done({ placements: { placed, unplaced } satisfies PlacementsArtifact })
    },

    reconcile: async (ctx) => {
      const placements = required<PlacementsArtifact>(ctx.artifacts, 'placements')
      const target = required<RoundTarget>(ctx.artifacts, 'target')

      // Without a ledger there is no history to reconcile against, so every
      // finding is new. Stated rather than assumed: silently treating "no
      // ledger" as "nothing changed" would publish nothing at all.
      const ledger =
        env.ledger === undefined
          ? []
          : await env.ledger.read(anchorOf(target, env.codeHostEndpointId))

      // Both lists take part. A finding that could not be anchored still has an
      // identity, and leaving it out would make it "new" every single round —
      // the overview would repeat it forever.
      const all = [...placements.placed, ...placements.unplaced]
      const current = all.map((item) => ({
        fingerprint: item.fingerprint,
        // The NEW-side line, which is what a reader sees and what drift means.
        // A removed line has none, and null is the honest answer there rather
        // than falling back to the old-side number and reporting a line that
        // moved when nothing did.
        anchorLine: 'anchor' in item ? item.anchor.newLine : null,
      }))

      const { actions } = reconcileFindings(current, ledger)

      const publishable = new Map<string, number>()
      const keeps: Array<{ fingerprint: string; anchorLine: number | null }> = []
      for (const action of actions) {
        if (action.kind === 'publish' || action.kind === 'republish') {
          publishable.set(action.fingerprint, action.generation)
        } else if (action.kind === 'keep') {
          keeps.push({ fingerprint: action.fingerprint, anchorLine: action.anchorLine })
        }
      }

      return done({
        reconciled: {
          actions,
          toPublish: {
            placed: placements.placed.filter((p) => publishable.has(p.fingerprint)),
            unplaced: placements.unplaced.filter((u) => publishable.has(u.fingerprint)),
          },
          keeps,
          generations: Object.fromEntries(publishable),
        } satisfies ReconciledArtifact,
      })
    },

    publish: async (ctx) => {
      const reconciled = required<ReconciledArtifact>(ctx.artifacts, 'reconciled')
      const target = required<RoundTarget>(ctx.artifacts, 'target')
      const meta = required<MrMeta>(ctx.artifacts, 'mrMeta')
      const gated = required<GatedArtifact>(ctx.artifacts, 'gated')
      const diff = required<DiffArtifact>(ctx.artifacts, 'diff')

      const placed = reconciled.toPublish.placed
      const unplaced = reconciled.toPublish.unplaced

      // The overview posts even with nothing new. Silence would leave the author
      // unable to tell a clean round from a review that never ran — and the MR
      // is where this platform is supposed to speak (product boundary). What
      // keeps it honest rather than noisy is `stillOpen`: a round with no new
      // findings but three unresolved threads says so, instead of "no findings"
      // directly above three open ones.
      const prelude = renderOverviewPrelude({
        posted: placed.length,
        carried: unplaced.length,
        truncated: gated.truncated,
        belowThreshold: gated.belowThreshold,
        omitted: diff.omitted,
        diffClipped: gated.diffClipped,
        headSha: target.headSha,
        stillOpen: reconciled.keeps.length,
      })

      const result = await publishReview({
        codeHost: env.codeHost,
        target,
        placed,
        unplaced,
        ...(meta.diffRefs !== undefined ? { diffRefs: meta.diffRefs } : {}),
        overviewPrelude: prelude,
      })

      if (result.failure !== null) {
        return fail(`${result.failure.code}: ${result.failure.message}`)
      }
      return done({
        published: {
          posted: result.posted,
          carried: result.carriedInOverview.length,
          overviewPosted: result.overviewPosted,
          findings: result.publishedFindings,
        },
      })
    },

    'settle-stale': async (ctx) => {
      const reconciled = required<ReconciledArtifact>(ctx.artifacts, 'reconciled')
      const target = required<RoundTarget>(ctx.artifacts, 'target')

      const settled: SettledArtifact = { resolved: 0, noted: 0, skipped: 0, failures: [] }
      const failures: Array<{ fingerprint: string; message: string }> = []
      const project = apiProjectAddress(target)

      for (const action of reconciled.actions) {
        if (action.kind !== 'settle-stale') continue

        const step = planSettleStale(target.provider, action, STALE_NOTE)
        if (step.kind === 'skip' || !project.ok) {
          settled.skipped += 1
          continue
        }

        const base = { project: project.value, mr: target.anchorId, thread: step.externalId }
        const result = await env.codeHost.call(
          step.kind === 'resolve-thread'
            ? { action: 'thread.resolve', params: base }
            : { action: 'comment.reply-thread', params: { ...base, body: step.body } },
        )
        if (!result.ok) {
          // NOT a round failure. The finding is gone and the review is already
          // published; refusing the round here would re-run everything above to
          // fix a note on a thread nobody is waiting for. But it is recorded,
          // because a host that rejects every resolve should be visible.
          failures.push({
            fingerprint: action.fingerprint,
            message: `${result.code}: ${result.message}`,
          })
          continue
        }
        if (step.kind === 'resolve-thread') settled.resolved += 1
        else settled.noted += 1
      }

      return done({ settled: { ...settled, failures } satisfies SettledArtifact })
    },

    ledger: async (ctx) => {
      const reconciled = required<ReconciledArtifact>(ctx.artifacts, 'reconciled')
      const target = required<RoundTarget>(ctx.artifacts, 'target')
      const published = required<{
        posted: number
        carried: number
        overviewPosted: boolean
        findings: readonly PublishedFinding[]
      }>(ctx.artifacts, 'published')
      const settled = required<SettledArtifact>(ctx.artifacts, 'settled')

      if (env.ledger === undefined) {
        return {
          status: 'done',
          produced: { ledgerEntry: { recorded: 0, refreshed: 0, closed: 0 } },
          counts: { posted: published.posted, carried: published.carried },
        }
      }

      const anchor = anchorOf(target, env.codeHostEndpointId)
      const externalIds = new Map(published.findings.map((f) => [f.fingerprint, f.externalId]))

      // Only what actually landed. Recording a finding the host rejected would
      // suppress it next round — the ledger would claim it was said, and the
      // author would never see it.
      let recorded = 0
      for (const [fingerprint, generation] of Object.entries(reconciled.generations)) {
        if (!externalIds.has(fingerprint)) continue
        await env.ledger.recordPublished({
          anchor,
          fingerprint,
          generation,
          externalId: externalIds.get(fingerprint) ?? null,
        })
        recorded += 1
      }

      let refreshed = 0
      for (const keep of reconciled.keeps) {
        await env.ledger.refreshSeen(anchor, keep.fingerprint, keep.anchorLine)
        refreshed += 1
      }

      // Last, and only after the provider action above: a crash between the two
      // leaves the row `active`, so the next round retries the action. The
      // reverse order would mark it settled and drop the action forever.
      let closed = 0
      for (const action of reconciled.actions) {
        if (action.kind !== 'settle-stale') continue
        if (await env.ledger.markDisappeared(anchor, action.fingerprint)) closed += 1
      }

      return {
        status: 'done',
        produced: {
          ledgerEntry: { recorded, refreshed, closed, settleFailures: settled.failures.length },
        },
        counts: { posted: published.posted, carried: published.carried },
      }
    },
  }
}

/** The single `ai` stage. Separate map: the engine dispatches by stage kind. */
export function mrReviewAiStages(
  env: MrReviewEnvironment,
): Readonly<Record<string, (ctx: StageRunContext) => Promise<StageResult>>> {
  return {
    review: async (ctx) => {
      const diff = required<DiffArtifact>(ctx.artifacts, 'diff')
      const meta = required<MrMeta>(ctx.artifacts, 'mrMeta')

      const result = await runReviewStage({
        makeCaller: env.makeCaller,
        nonce: env.nonce,
        budget: env.budget,
        unifiedDiff: diff.unifiedDiff,
        hunks: diff.hunks,
        omitted: diff.omitted,
        mrTitle: meta.title,
        protocolBlock: env.protocolBlock,
        ...(env.attemptRecorder !== undefined ? { recorder: env.attemptRecorder } : {}),
        ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
      })

      if (result.outcome.status === 'canceled') return fail('the round was canceled')
      if (result.outcome.status === 'exhausted') {
        // Constitution R5: nothing unvalidated escapes, so there is no partial
        // value to hand downstream — the stage fails and the round publishes
        // nothing rather than a best-effort review.
        return fail(
          `the reviewer did not produce a valid result after ${result.outcome.totalCalls} attempts`,
        )
      }
      return done({
        findings: {
          findings: result.outcome.value.findings,
          diffClipped: result.diffClipped,
        },
      })
    },
  }
}
